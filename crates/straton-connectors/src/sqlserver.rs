use super::{batch, bound_text, column, error, invalid, relationship, schema};
use arrow::{
    array::{ArrayRef, BinaryBuilder, FixedSizeBinaryBuilder},
    datatypes::{DataType, TimeUnit},
    record_batch::RecordBatch,
};
use futures::{StreamExt, future::BoxFuture, stream};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use straton_core::{
    Batches, Column, Connector, DatasetIndex, DatasetSchema, ReadOptions, RelationshipKind, Result,
    SqlserverAuth, SqlserverConfig,
};
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Query, Row};
use tokio::net::{TcpStream, UdpSocket};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

mod advisor;

type Connection = Client<Compat<TcpStream>>;

struct Sqlserver {
    config: SqlserverConfig,
    login: Config,
    has_password: bool,
    advisor_may_write: bool,
}

pub(super) fn build(config: &Value, secret: Option<&str>) -> Result<Box<dyn Connector>> {
    // Never forward serde's errors: they can contain rejected config values.
    let advisor_may_write = config["advisor_may_write"] == true;
    let mut connection_config = config.clone();
    connection_config
        .as_object_mut()
        .map(|o| o.remove("advisor_may_write"));
    let config: SqlserverConfig = serde_json::from_value(connection_config)
        .map_err(|_| invalid("invalid SQL Server configuration; credentials belong in secret"))?;
    config.validate()?;
    let mut login = Config::new();
    login.host(&config.host);
    login.port(config.port);
    login.database(&config.database);
    login.application_name("Straton");
    login.readonly(true);
    login.encryption(if config.encrypt {
        EncryptionLevel::Required
    } else {
        EncryptionLevel::Off
    });
    if config.trust_server_certificate {
        login.trust_cert();
    }
    match config.auth {
        SqlserverAuth::Sql => login.authentication(AuthMethod::sql_server(
            config.username.as_deref().unwrap_or_default(),
            secret.unwrap_or_default(),
        )),
        SqlserverAuth::Windows => {
            #[cfg(windows)]
            login.authentication(AuthMethod::Integrated);
            #[cfg(not(windows))]
            return Err(invalid(
                "Windows integrated authentication requires Windows",
            ));
        }
    }
    Ok(Box::new(Sqlserver {
        config,
        login,
        has_password: secret.is_some_and(|s| !s.is_empty()),
        advisor_may_write,
    }))
}

fn ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn arrow_type(typ: &str, precision: u8, scale: u8) -> DataType {
    match typ {
        "tinyint" => DataType::UInt8,
        "smallint" => DataType::Int16,
        "int" => DataType::Int32,
        "bigint" => DataType::Int64,
        "bit" => DataType::Boolean,
        "decimal" | "numeric" => DataType::Decimal128(precision, scale as i8),
        "money" => DataType::Decimal128(19, 4),
        "smallmoney" => DataType::Decimal128(10, 4),
        "real" => DataType::Float32,
        "float" => DataType::Float64,
        "date" => DataType::Date32,
        "datetime" | "smalldatetime" => DataType::Timestamp(TimeUnit::Microsecond, None),
        "datetime2" | "datetimeoffset" => DataType::Timestamp(
            if scale > 6 {
                TimeUnit::Nanosecond
            } else {
                TimeUnit::Microsecond
            },
            (typ == "datetimeoffset").then(|| "+00:00".into()),
        ),
        "time" => DataType::Time64(TimeUnit::Nanosecond),
        "binary" | "varbinary" | "image" => DataType::Binary,
        "timestamp" | "rowversion" => DataType::FixedSizeBinary(8),
        // Includes strings, XML and uniqueidentifier, plus user-defined/unknown types.
        _ => DataType::Utf8,
    }
}

#[derive(Clone)]
struct NativeColumn {
    column: Column,
    typ: String,
    precision: u8,
    scale: u8,
    max_length: i16,
}
impl NativeColumn {
    fn binary(&self) -> bool {
        matches!(
            self.typ.as_str(),
            "binary" | "varbinary" | "image" | "timestamp" | "rowversion"
        )
    }
    fn select(&self) -> String {
        let name = ident(&self.column.name);
        if self.binary() {
            format!("CONVERT(varchar(max), {name}, 2)")
        } else {
            let style = match self.typ.as_str() {
                "datetimeoffset" => 127,
                "date" | "datetime" | "datetime2" | "smalldatetime" | "time" => 126,
                "float" | "real" => 3,
                "money" | "smallmoney" => 2,
                _ => 0,
            };
            format!("CONVERT(nvarchar(max), {name}, {style})")
        }
    }
    fn parameter(&self, n: usize) -> Result<String> {
        if self.binary() {
            return Ok(format!("CONVERT(varbinary(max), @P{n}, 2)"));
        }
        // Only server base types from this allowlist can enter generated SQL.
        let typ = match self.typ.as_str() {
            "decimal" | "numeric" => format!("decimal({},{})", self.precision, self.scale),
            "varchar" | "char" => format!("varchar({})", self.length(false)),
            "nvarchar" | "nchar" => format!("nvarchar({})", self.length(true)),
            "tinyint" | "smallint" | "int" | "bigint" | "bit" | "money" | "smallmoney" | "real"
            | "float" | "date" | "datetime" | "datetime2" | "smalldatetime" | "datetimeoffset"
            | "time" | "uniqueidentifier" => self.typ.clone(),
            _ => return Err(invalid("SQL Server key/watermark type is not orderable")),
        };
        Ok(format!("CONVERT({typ}, @P{n}, 126)"))
    }
    fn watermark_fence(&self) -> Option<String> {
        matches!(self.typ.as_str(), "timestamp" | "rowversion").then(|| {
            format!(
                "{} < CONVERT(varbinary(max), @P1, 2)",
                ident(&self.column.name)
            )
        })
    }
    fn length(&self, unicode: bool) -> String {
        if self.max_length < 0 {
            "max".into()
        } else {
            (self.max_length / if unicode { 2 } else { 1 }).to_string()
        }
    }
}
fn text(row: &Row, name: &str) -> Result<String> {
    row.try_get::<&str, _>(name)
        .map_err(error)?
        .map(str::to_owned)
        .ok_or_else(|| invalid("missing SQL Server catalog value"))
}
fn number(row: &Row, name: &str) -> Result<i32> {
    row.try_get::<i32, _>(name)
        .map_err(error)?
        .ok_or_else(|| invalid("missing SQL Server catalog value"))
}
fn flag(row: &Row, name: &str) -> Result<bool> {
    row.try_get::<bool, _>(name)
        .map_err(error)?
        .ok_or_else(|| invalid("missing SQL Server catalog value"))
}

impl Sqlserver {
    async fn connect(&self) -> Result<Connection> {
        self.connect_mode(false).await
    }
    async fn connect_mode(&self, write: bool) -> Result<Connection> {
        if self.config.auth == SqlserverAuth::Sql && !self.has_password {
            return Err(invalid("SQL Server password is missing from the keychain"));
        }
        let connect = async {
            let port = if let Some(instance) = &self.config.instance {
                self.instance_port(instance).await?
            } else {
                self.config.port
            };
            let tcp = TcpStream::connect((self.config.host.as_str(), port))
                .await
                .map_err(error)?;
            tcp.set_nodelay(true).map_err(error)?;
            let mut login = self.login.clone();
            login.readonly(!write);
            login.port(port);
            if let Some(instance) = &self.config.instance {
                login.instance_name(instance);
            }
            Client::connect(login, tcp.compat_write())
                .await
                .map_err(error)
        };
        tokio::time::timeout(Duration::from_secs(20), connect)
            .await
            .map_err(error)?
    }
    async fn instance_port(&self, instance: &str) -> Result<u16> {
        let addr = tokio::net::lookup_host((self.config.host.as_str(), 1434))
            .await
            .map_err(error)?
            .next()
            .ok_or_else(|| invalid("SQL Server host not found"))?;
        let socket = UdpSocket::bind(if addr.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        })
        .await
        .map_err(error)?;
        socket.connect(addr).await.map_err(error)?;
        let mut request = vec![4];
        request.extend_from_slice(instance.as_bytes());
        request.push(0);
        socket.send(&request).await.map_err(error)?;
        let mut response = [0; 4096];
        let len = tokio::time::timeout(Duration::from_secs(3), socket.recv(&mut response))
            .await
            .map_err(error)?
            .map_err(error)?;
        browser_port(&response[..len])
    }
    async fn columns(client: &mut Connection, object: i32) -> Result<Vec<NativeColumn>> {
        let rows = client.query(
            "SELECT c.name, t.name AS typ, CAST(c.precision AS int) AS prec, CAST(c.scale AS int) AS scale, CAST(c.max_length AS int) AS max_length, c.is_nullable, CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.object_id=c.object_id AND i.is_primary_key=1 AND ic.column_id=c.column_id) THEN 1 ELSE 0 END AS bit) AS pk FROM sys.columns c JOIN sys.types t ON t.system_type_id=c.system_type_id AND t.user_type_id=t.system_type_id WHERE c.object_id=@P1 ORDER BY c.column_id",
            &[&object],
        ).await.map_err(error)?.into_first_result().await.map_err(error)?;
        rows.iter()
            .map(|r| {
                let typ = text(r, "typ")?;
                let precision = number(r, "prec")? as u8;
                let scale = number(r, "scale")? as u8;
                Ok(NativeColumn {
                    column: column(
                        text(r, "name")?,
                        arrow_type(&typ, precision, scale),
                        flag(r, "is_nullable")?,
                        flag(r, "pk")?,
                    ),
                    typ,
                    precision,
                    scale,
                    max_length: number(r, "max_length")? as i16,
                })
            })
            .collect()
    }
    async fn discover_all(&self) -> Result<Vec<DatasetSchema>> {
        let mut client = self.connect().await?;
        let objects = client.simple_query(
            "SELECT o.object_id, s.name AS schema_name, o.name, o.type, m.definition, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id=o.object_id AND p.index_id IN (0,1)) AS approx_rows FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY s.name,o.name"
        ).await.map_err(error)?.into_first_result().await.map_err(error)?;
        let mut datasets = BTreeMap::new();
        for row in objects {
            let object = number(&row, "object_id")?;
            let name = format!("{}.{}", text(&row, "schema_name")?, text(&row, "name")?);
            let columns = Self::columns(&mut client, object).await?;
            let mut ds = schema(
                name,
                columns.into_iter().map(|c| c.column).collect(),
                vec![],
            );
            ds.metadata.is_view = text(&row, "type")?.trim() == "V";
            ds.metadata.definition = row
                .try_get::<&str, _>("definition")
                .map_err(error)?
                .map(str::to_owned);
            ds.metadata.approximate_rows = row.try_get::<i64, _>("approx_rows").map_err(error)?;
            datasets.insert(object, ds);
        }
        let indexes = client.simple_query(
            "SELECT i.object_id, i.index_id, i.name, i.is_unique, i.is_unique_constraint, CAST(CASE WHEN i.type IN (1,5) THEN 1 ELSE 0 END AS bit) AS is_clustered, i.type_desc AS kind, c.name AS column_name FROM sys.indexes i LEFT JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND (ic.key_ordinal>0 OR i.type IN (5,6)) LEFT JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE i.index_id>0 AND i.is_hypothetical=0 ORDER BY i.object_id,i.index_id,ic.key_ordinal,ic.index_column_id"
        ).await.map_err(error)?.into_first_result().await.map_err(error)?;
        let mut groups = BTreeMap::<(i32, i32), DatasetIndex>::new();
        for row in indexes {
            let key = (number(&row, "object_id")?, number(&row, "index_id")?);
            let index = groups.entry(key).or_insert(DatasetIndex {
                name: text(&row, "name")?,
                columns: vec![],
                unique: flag(&row, "is_unique")?,
                clustered: flag(&row, "is_clustered")?,
                kind: text(&row, "kind")?,
                unique_constraint: flag(&row, "is_unique_constraint")?,
            });
            if let Some(name) = row.try_get::<&str, _>("column_name").map_err(error)? {
                index.columns.push(name.into());
            }
        }
        for ((object, _), index) in groups {
            if let Some(ds) = datasets.get_mut(&object) {
                ds.metadata.indexes.push(index);
            }
        }
        let fks = client.simple_query(
            "SELECT f.constraint_object_id, f.parent_object_id, f.referenced_object_id, pc.name AS parent_column, rc.name AS referenced_column FROM sys.foreign_key_columns f JOIN sys.columns pc ON pc.object_id=f.parent_object_id AND pc.column_id=f.parent_column_id JOIN sys.columns rc ON rc.object_id=f.referenced_object_id AND rc.column_id=f.referenced_column_id ORDER BY f.constraint_object_id,f.constraint_column_id"
        ).await.map_err(error)?.into_first_result().await.map_err(error)?;
        let mut groups = BTreeMap::<i32, Vec<Row>>::new();
        for row in fks {
            groups
                .entry(number(&row, "constraint_object_id")?)
                .or_default()
                .push(row);
        }
        for rows in groups.into_values() {
            let from = number(&rows[0], "parent_object_id")?;
            let to = number(&rows[0], "referenced_object_id")?;
            if let (Some(source), Some(target)) = (datasets.get(&from), datasets.get(&to)) {
                let rel = relationship(
                    &source.dataset.name,
                    rows.iter()
                        .map(|r| text(r, "parent_column"))
                        .collect::<Result<_>>()?,
                    &target.dataset.name,
                    rows.iter()
                        .map(|r| text(r, "referenced_column"))
                        .collect::<Result<_>>()?,
                );
                datasets.get_mut(&from).unwrap().relationships.push(rel);
            }
        }
        let deps = client.simple_query(
            "SELECT DISTINCT d.referencing_id, d.referenced_id FROM sys.sql_expression_dependencies d JOIN sys.views v ON v.object_id=d.referencing_id WHERE d.referenced_id IS NOT NULL AND d.referenced_database_name IS NULL AND d.referenced_server_name IS NULL"
        ).await.map_err(error)?.into_first_result().await.map_err(error)?;
        for row in deps {
            let view = number(&row, "referencing_id")?;
            let base = number(&row, "referenced_id")?;
            if let (Some(source), Some(target)) = (datasets.get(&base), datasets.get(&view)) {
                let mut rel =
                    relationship(&source.dataset.name, vec![], &target.dataset.name, vec![]);
                rel.kind = RelationshipKind::Lineage;
                datasets.get_mut(&view).unwrap().relationships.push(rel);
            }
        }
        Ok(datasets.into_values().collect())
    }
}
fn browser_port(response: &[u8]) -> Result<u16> {
    if response.len() < 3
        || response[0] != 5
        || usize::from(u16::from_le_bytes([response[1], response[2]])) != response.len() - 3
    {
        return Err(invalid("invalid SQL Browser response"));
    }
    let text = std::str::from_utf8(&response[3..]).map_err(error)?;
    let parts = text.split(';').collect::<Vec<_>>();
    parts
        .windows(2)
        .find(|p| p[0] == "tcp")
        .and_then(|p| p[1].parse::<u16>().ok())
        .filter(|p| *p > 0)
        .ok_or_else(|| invalid("SQL Browser did not return a TCP port"))
}

fn keyset(order: &[NativeColumn], cursor: &[Value], values: &mut Vec<String>) -> Result<String> {
    if order.len() != cursor.len() || order.is_empty() {
        return Err(invalid("invalid SQL Server keyset cursor"));
    }
    let params = order
        .iter()
        .zip(cursor)
        .map(|(c, v)| {
            values.push(bound_text(v)?);
            c.parameter(values.len())
        })
        .collect::<Result<Vec<_>>>()?;
    // SQL Server has no tuple comparison. Expand (a,b) > (x,y) lexicographically.
    let terms = (0..order.len())
        .map(|i| {
            let mut parts = (0..i)
                .map(|j| format!("{} = {}", ident(&order[j].column.name), params[j]))
                .collect::<Vec<_>>();
            parts.push(format!("{} > {}", ident(&order[i].column.name), params[i]));
            format!("({})", parts.join(" AND "))
        })
        .collect::<Vec<_>>();
    Ok(format!("({})", terms.join(" OR ")))
}
fn decode_hex(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return Err(invalid("invalid SQL Server binary value"));
    }
    s.as_bytes()
        .chunks_exact(2)
        .map(|p| {
            let h = (p[0] as char)
                .to_digit(16)
                .ok_or_else(|| invalid("invalid binary digit"))?;
            let l = (p[1] as char)
                .to_digit(16)
                .ok_or_else(|| invalid("invalid binary digit"))?;
            Ok((h * 16 + l) as u8)
        })
        .collect()
}
fn arrow_batch(columns: &[NativeColumn], values: Vec<Vec<Option<String>>>) -> Result<RecordBatch> {
    // Reuse the connector's strict Arrow casts, decoding binary separately from hex text.
    let text_columns = columns
        .iter()
        .map(|c| {
            let mut col = c.column.clone();
            if c.binary() {
                col.data_type = DataType::Utf8.to_string();
            }
            col
        })
        .collect::<Vec<_>>();
    let converted = batch(&text_columns, values.clone())?;
    let mut arrays: Vec<ArrayRef> = converted.columns().to_vec();
    for (i, c) in columns.iter().enumerate() {
        if !c.binary() {
            continue;
        }
        let decoded = values[i]
            .iter()
            .map(|v| v.as_deref().map(decode_hex).transpose())
            .collect::<Result<Vec<_>>>()?;
        arrays[i] = if c.column.data_type == DataType::FixedSizeBinary(8).to_string() {
            let mut b = FixedSizeBinaryBuilder::new(8);
            for v in decoded {
                if let Some(v) = v {
                    b.append_value(v).map_err(error)?;
                } else {
                    b.append_null();
                }
            }
            Arc::new(b.finish())
        } else {
            let mut b = BinaryBuilder::new();
            for v in decoded {
                b.append_option(v);
            }
            Arc::new(b.finish())
        };
    }
    let fields = columns
        .iter()
        .map(|c| {
            Ok(arrow::datatypes::Field::new(
                &c.column.name,
                c.column.data_type.parse::<DataType>().map_err(error)?,
                c.column.nullable,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    RecordBatch::try_new(Arc::new(arrow::datatypes::Schema::new(fields)), arrays).map_err(error)
}

impl Connector for Sqlserver {
    fn advisor_metadata(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(30), advisor::metadata(self))
                .await
                .map_err(error)?
        })
    }
    fn advisor_execute<'a>(&'a self, ddl: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(60), advisor::execute(self, ddl))
                .await
                .map_err(error)?
        })
    }
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.connect()
                .await?
                .simple_query("SELECT 1")
                .await
                .map_err(error)?
                .into_results()
                .await
                .map_err(error)?;
            Ok(())
        })
    }
    fn discover(&self) -> BoxFuture<'_, Result<Vec<DatasetSchema>>> {
        Box::pin(self.discover_all())
    }
    fn read<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> BoxFuture<'a, Result<Batches<'a>>> {
        Box::pin(async move {
            if options.incremental.is_some() && options.keys_only.is_some() {
                return Err(invalid(
                    "incremental and key-only reads are mutually exclusive",
                ));
            }
            if options.cursor.as_ref().is_some_and(Value::is_null) {
                return Ok(stream::empty().boxed());
            }
            let mut client = self.connect().await?;
            // Resolve identifiers through the catalog, never by splitting an untrusted SQL name.
            let objects = client.simple_query("SELECT o.object_id,s.name AS schema_name,o.name FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0")
                .await.map_err(error)?.into_first_result().await.map_err(error)?;
            let mut resolved = None;
            for row in objects {
                let ns = text(&row, "schema_name")?;
                let name = text(&row, "name")?;
                if format!("{ns}.{name}") == dataset {
                    if resolved.is_some() {
                        return Err(invalid("ambiguous SQL Server dataset name"));
                    }
                    resolved = Some((
                        number(&row, "object_id")?,
                        format!("{}.{}", ident(&ns), ident(&name)),
                    ));
                }
            }
            let (object, relation) =
                resolved.ok_or_else(|| invalid("SQL Server dataset not found"))?;
            let native = Self::columns(&mut client, object).await?;
            let find = |name: &String| {
                native
                    .iter()
                    .find(|c| &c.column.name == name)
                    .cloned()
                    .ok_or_else(|| invalid("SQL Server key/watermark column not found"))
            };
            let mut order = vec![];
            if let Some(inc) = &options.incremental {
                order.push(find(&inc.watermark_column)?);
            }
            let keys = options
                .incremental
                .as_ref()
                .map(|i| i.key_columns.clone())
                .or(options.keys_only.clone())
                .unwrap_or_else(|| {
                    native
                        .iter()
                        .filter(|c| c.column.primary_key)
                        .map(|c| c.column.name.clone())
                        .collect()
                });
            if (options.incremental.is_some() || options.keys_only.is_some()) && keys.is_empty() {
                return Err(invalid(
                    "SQL Server incremental reads require a nonempty key",
                ));
            }
            for key in &keys {
                let c = find(key)?;
                if !order.iter().any(|o| o.column.name == *key) {
                    order.push(c);
                }
            }
            for c in &order {
                c.parameter(1)?;
            }
            let columns = if let Some(keys) = &options.keys_only {
                keys.iter().map(find).collect::<Result<Vec<_>>>()?
            } else {
                native
            };
            let watermark_fence = options
                .incremental
                .as_ref()
                .and_then(|_| order.first().and_then(NativeColumn::watermark_fence));
            // Capture one upper fence for the entire scan, including all of its pages.
            let upper_bound = if watermark_fence.is_some() {
                let row = client
                    .simple_query(
                        "SELECT CONVERT(varchar(16), MIN_ACTIVE_ROWVERSION(), 2) AS fence",
                    )
                    .await
                    .map_err(error)?
                    .into_row()
                    .await
                    .map_err(error)?
                    .ok_or_else(|| invalid("SQL Server rowversion fence is missing"))?;
                Some(text(&row, "fence")?)
            } else {
                None
            };
            let lower = options.incremental.and_then(|i| i.lower_bound);
            let size = self.config.batch_size;
            Ok(stream::try_unfold((client, options.cursor, false), move |(mut client, cursor, done)| {
                let columns = columns.clone(); let order = order.clone();
                let relation = relation.clone(); let lower = lower.clone();
                let watermark_fence = watermark_fence.clone();
                let upper_bound = upper_bound.clone();
                async move {
                    if done { return Ok(None); }
                    let mut values = upper_bound.into_iter().collect::<Vec<_>>();
                    // Do not advance past rowversions belonging to transactions that can still commit.
                    let mut predicates = watermark_fence.into_iter().collect::<Vec<_>>();
                    if let Some(lower) = lower {
                        values.push(bound_text(&lower)?);
                        predicates.push(format!("{} >= {}", ident(&order[0].column.name), order[0].parameter(values.len())?));
                    }
                    let offset = if order.is_empty() {
                        match &cursor { Some(c) => c.as_u64().filter(|n| *n <= i64::MAX as u64).ok_or_else(|| invalid("invalid SQL Server offset cursor"))?, None => 0 }
                    } else {
                        if let Some(cursor) = &cursor {
                            predicates.push(keyset(&order, cursor.as_array().ok_or_else(|| invalid("invalid SQL Server keyset cursor"))?, &mut values)?);
                        }
                        0
                    };
                    let select = columns.iter().map(NativeColumn::select).collect::<Vec<_>>().join(",");
                    let sorting = if order.is_empty() { "(SELECT NULL)".into() } else { order.iter().map(|c| ident(&c.column.name)).collect::<Vec<_>>().join(",") };
                    let wh = if predicates.is_empty() { String::new() } else { format!("WHERE {}", predicates.join(" AND ")) };
                    let sql = if order.is_empty() {
                        // shortcut: heaps/views without keys resume by offset; use a declared key for changing sources.
                        format!("SELECT {select} FROM {relation} {wh} ORDER BY {sorting} OFFSET {offset} ROWS FETCH NEXT {size} ROWS ONLY")
                    } else {
                        format!("SELECT TOP ({size}) {select} FROM {relation} {wh} ORDER BY {sorting}")
                    };
                    let mut query = Query::new(sql);
                    for value in values { query.bind(value); }
                    let rows = query.query(&mut client).await.map_err(error)?.into_first_result().await.map_err(error)?;
                    if rows.is_empty() {
                        if cursor.is_some() { return Ok(None); }
                        let empty = arrow_batch(&columns, vec![vec![]; columns.len()])?;
                        return Ok(Some(((empty, Value::Null), (client, None, true))));
                    }
                    let values = (0..columns.len()).map(|i| rows.iter().map(|r| r.try_get::<&str, _>(i).map(|v| v.map(str::to_owned)).map_err(error)).collect::<Result<Vec<_>>>()).collect::<Result<Vec<_>>>()?;
                    let next = if order.is_empty() { json!(offset.checked_add(rows.len() as u64).ok_or_else(|| invalid("SQL Server offset overflow"))?) } else {
                        Value::Array(order.iter().map(|key| {
                            let pos = columns.iter().position(|c| c.column.name == key.column.name).ok_or_else(|| invalid("missing projected key"))?;
                            // Reject null sorting values before checkpointing any rows.
                            if values[pos].iter().any(Option::is_none) { return Err(invalid("SQL Server key/watermark contains nulls")); }
                            Ok(json!(values[pos].last().unwrap()))
                        }).collect::<Result<Vec<_>>>()?)
                    };
                    let batch = arrow_batch(&columns, values)?;
                    Ok(Some(((batch, next.clone()), (client, Some(next), false))))
                }
            }).boxed())
        })
    }
}

#[cfg(test)]
mod tests;
