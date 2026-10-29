use super::{batch, bound_text, column, error, invalid, relationship, schema};
use arrow::{
    array::{ArrayRef, BinaryBuilder, DurationMicrosecondArray},
    datatypes::{DataType, TimeUnit},
    record_batch::RecordBatch,
};
use futures::{StreamExt, future::BoxFuture, stream};
use mysql_async::{
    Conn, OptsBuilder, Params, Row, SslOpts, Value as MysqlValue, prelude::Queryable,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use straton_core::{Batches, Column, Connector, DatasetIndex, DatasetSchema, ReadOptions, Result};

mod advisor;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    host: String,
    #[serde(default = "port")]
    port: u16,
    database: String,
    username: String,
    ssl_mode: Option<String>,
    #[serde(default = "batch_size")]
    batch_size: usize,
    #[serde(default)]
    advisor_may_write: bool,
}
fn port() -> u16 {
    3306
}
fn batch_size() -> usize {
    10_000
}
struct Mysql {
    config: Config,
    login: OptsBuilder,
    has_password: bool,
}
pub(super) fn build(value: &Value, secret: Option<&str>) -> Result<Box<dyn Connector>> {
    let config: Config = serde_json::from_value(value.clone())
        .map_err(|_| invalid("invalid MySQL configuration; credentials belong in secret"))?;
    if !super::postgres_tls::host_valid(&config.host)
        || config.database.trim().is_empty()
        || config.username.trim().is_empty()
        || config.port == 0
        || config.batch_size == 0
        || config.batch_size > i32::MAX as usize
    {
        return Err(invalid("invalid MySQL configuration"));
    }
    let mode = config
        .ssl_mode
        .as_deref()
        .unwrap_or(if super::postgres_tls::local(&config.host) {
            "preferred"
        } else {
            "required"
        });
    let ssl = match mode {
        "disabled" => None,
        "preferred" | "required" => Some(
            SslOpts::default()
                .with_danger_skip_domain_validation(true)
                .with_danger_accept_invalid_certs(true),
        ),
        "verify_identity" => Some(SslOpts::default()),
        _ => return Err(invalid("invalid MySQL SSL mode")),
    };
    let login = OptsBuilder::default()
        .ip_or_hostname(&config.host)
        .tcp_port(config.port)
        .db_name(Some(&config.database))
        .user(Some(&config.username))
        .pass(secret)
        .prefer_socket(false)
        .ssl_opts(ssl);
    Ok(Box::new(Mysql {
        config,
        login,
        has_password: secret.is_some_and(|s| !s.is_empty()),
    }))
}
fn ident(name: &str) -> String {
    format!("\x60{}\x60", name.replace('\x60', "\x60\x60"))
}
fn object(name: &str) -> Result<String> {
    let (db, table) = name
        .split_once('.')
        .ok_or_else(|| invalid("qualified MySQL dataset required"))?;
    Ok(format!("{}.{}", ident(db), ident(table)))
}
fn arrow_type(typ: &str, unsigned: bool, precision: u8, scale: u8) -> DataType {
    match (typ, unsigned) {
        ("tinyint", false) => DataType::Int8,
        ("tinyint", true) => DataType::UInt8,
        ("smallint", false) => DataType::Int16,
        ("smallint", true) => DataType::UInt16,
        ("mediumint" | "int" | "integer", false) => DataType::Int32,
        ("mediumint" | "int" | "integer", true) => DataType::UInt32,
        ("bigint", false) => DataType::Int64,
        ("bigint", true) | ("bit", _) => DataType::UInt64,
        ("decimal" | "numeric", _) if precision <= 38 => {
            DataType::Decimal128(precision.max(1), scale as i8)
        }
        ("decimal" | "numeric", _) => DataType::Decimal256(precision, scale as i8),
        ("float", _) => DataType::Float32,
        ("double" | "real", _) => DataType::Float64,
        ("date", _) => DataType::Date32,
        ("datetime" | "timestamp", _) => DataType::Timestamp(TimeUnit::Microsecond, None),
        // MySQL TIME includes negative durations and values beyond 24 hours.
        ("time", _) => DataType::Duration(TimeUnit::Microsecond),
        ("year", _) => DataType::UInt16,
        ("binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob", _) => {
            DataType::Binary
        }
        _ => DataType::Utf8,
    }
}
#[derive(Clone)]
struct NativeColumn {
    column: Column,
    typ: String,
    unsigned: bool,
    precision: u8,
    scale: u8,
}
impl NativeColumn {
    fn select(&self) -> String {
        let name = ident(&self.column.name);
        if self.column.data_type == "Binary" {
            format!("HEX({name})")
        } else if self.typ == "bit" {
            format!("CAST(CAST({name} AS UNSIGNED) AS CHAR)")
        } else if self.typ == "time" {
            format!("CAST(TIME_TO_SEC({name}) * 1000000 AS CHAR)")
        } else {
            format!("CAST({name} AS CHAR)")
        }
    }
    fn parameter(&self) -> Result<String> {
        Ok(match self.typ.as_str() {
            "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "bit"
            | "year" => format!(
                "CAST(? AS {})",
                if self.unsigned || self.typ == "bit" || self.typ == "year" {
                    "UNSIGNED"
                } else {
                    "SIGNED"
                }
            ),
            "decimal" | "numeric" => {
                format!("CAST(? AS DECIMAL({},{}))", self.precision, self.scale)
            }
            "datetime" | "timestamp" => "CAST(? AS DATETIME(6))".into(),
            "date" => "CAST(? AS DATE)".into(),
            "binary" | "varbinary" => "UNHEX(?)".into(),
            "char" | "varchar" | "enum" | "set" => "?".into(),
            _ => return Err(invalid("MySQL key/watermark type is not orderable")),
        })
    }
}
fn get<T: mysql_async::prelude::FromValue>(row: &Row, name: &str) -> Result<T> {
    row.get_opt(name)
        .ok_or_else(|| invalid("missing MySQL catalog value"))?
        .map_err(error)
}
impl Mysql {
    async fn connect(&self) -> Result<Conn> {
        if !self.has_password {
            return Err(invalid("MySQL password is missing from the keychain"));
        }
        let work = async {
            let mut conn = match Conn::new(self.login.clone()).await {
                Ok(c) => c,
                Err(mysql_async::Error::Driver(
                    mysql_async::DriverError::NoClientSslFlagFromServer,
                )) if self.config.ssl_mode.as_deref().unwrap_or(
                    if super::postgres_tls::local(&self.config.host) {
                        "preferred"
                    } else {
                        "required"
                    },
                ) == "preferred" =>
                {
                    Conn::new(self.login.clone().ssl_opts(None))
                        .await
                        .map_err(error)?
                }
                Err(e) => return Err(error(e)),
            };
            conn.query_drop("SET time_zone = '+00:00'")
                .await
                .map_err(error)?;
            Ok(conn)
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(error)?
    }
    async fn columns(&self, conn: &mut Conn, name: &str) -> Result<Vec<NativeColumn>> {
        let rows: Vec<Row> = conn.exec("SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, NUMERIC_PRECISION, NUMERIC_SCALE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", (&self.config.database, name)).await.map_err(error)?;
        rows.iter()
            .map(|r| {
                let typ: String = get(r, "DATA_TYPE")?;
                let unsigned = get::<String>(r, "COLUMN_TYPE")?.contains("unsigned");
                let precision = get::<Option<u64>>(r, "NUMERIC_PRECISION")?.unwrap_or(0) as u8;
                let scale = get::<Option<u64>>(r, "NUMERIC_SCALE")?.unwrap_or(0) as u8;
                Ok(NativeColumn {
                    column: column(
                        get(r, "COLUMN_NAME")?,
                        arrow_type(&typ, unsigned, precision, scale),
                        get::<String>(r, "IS_NULLABLE")? == "YES",
                        get::<String>(r, "COLUMN_KEY")? == "PRI",
                    ),
                    typ,
                    unsigned,
                    precision,
                    scale,
                })
            })
            .collect()
    }
    async fn discover_all(&self) -> Result<Vec<DatasetSchema>> {
        let mut conn = self.connect().await?;
        let rows: Vec<Row> = conn.exec("SELECT t.TABLE_NAME,t.TABLE_TYPE,t.TABLE_ROWS,v.VIEW_DEFINITION FROM information_schema.TABLES t LEFT JOIN information_schema.VIEWS v ON v.TABLE_SCHEMA=t.TABLE_SCHEMA AND v.TABLE_NAME=t.TABLE_NAME WHERE t.TABLE_SCHEMA=? ORDER BY t.TABLE_NAME", (&self.config.database,)).await.map_err(error)?;
        let mut datasets = BTreeMap::new();
        for r in rows {
            let name: String = get(&r, "TABLE_NAME")?;
            let full = format!("{}.{name}", self.config.database);
            let mut ds = schema(
                full.clone(),
                self.columns(&mut conn, &name)
                    .await?
                    .into_iter()
                    .map(|c| c.column)
                    .collect(),
                vec![],
            );
            ds.metadata.is_view = get::<String>(&r, "TABLE_TYPE")? == "VIEW";
            ds.metadata.dialect = Some("mysql".into());
            ds.metadata.definition = get::<Option<String>>(&r, "VIEW_DEFINITION")?
                .map(|sql| format!("CREATE VIEW {} AS {sql}", object(&full).unwrap()));
            ds.metadata.approximate_rows =
                get::<Option<u64>>(&r, "TABLE_ROWS")?.and_then(|n| i64::try_from(n).ok());
            datasets.insert(name, ds);
        }
        let rows: Vec<Row> = conn.exec("SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,INDEX_TYPE,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX", (&self.config.database,)).await.map_err(error)?;
        let mut indexes = BTreeMap::<(String, String), DatasetIndex>::new();
        for r in rows {
            let name: String = get(&r, "INDEX_NAME")?;
            let index = indexes
                .entry((get(&r, "TABLE_NAME")?, name.clone()))
                .or_insert(DatasetIndex {
                    name,
                    columns: vec![],
                    unique: get::<u64>(&r, "NON_UNIQUE")? == 0,
                    clustered: get::<String>(&r, "INDEX_NAME")? == "PRIMARY",
                    kind: get(&r, "INDEX_TYPE")?,
                    unique_constraint: get::<u64>(&r, "NON_UNIQUE")? == 0,
                });
            if let Some(c) = get::<Option<String>>(&r, "COLUMN_NAME")? {
                index.columns.push(c);
            }
            if get::<Option<u64>>(&r, "SUB_PART")?.is_some() {
                index.kind = "PREFIX".into();
            }
        }
        for ((table, _), index) in indexes {
            if let Some(ds) = datasets.get_mut(&table) {
                ds.metadata.indexes.push(index);
            }
        }
        let rows: Vec<Row> = conn.exec("SELECT TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION", (&self.config.database,)).await.map_err(error)?;
        let mut fks = BTreeMap::<(String, String), Vec<Row>>::new();
        for r in rows {
            fks.entry((get(&r, "TABLE_NAME")?, get(&r, "CONSTRAINT_NAME")?))
                .or_default()
                .push(r);
        }
        for ((table, _), rows) in fks {
            if get::<String>(&rows[0], "REFERENCED_TABLE_SCHEMA")? != self.config.database {
                continue;
            }
            let target = format!(
                "{}.{}",
                self.config.database,
                get::<String>(&rows[0], "REFERENCED_TABLE_NAME")?
            );
            if let Some(ds) = datasets.get_mut(&table) {
                ds.relationships.push(relationship(
                    &ds.dataset.name,
                    rows.iter()
                        .map(|r| get(r, "COLUMN_NAME"))
                        .collect::<Result<_>>()?,
                    &target,
                    rows.iter()
                        .map(|r| get(r, "REFERENCED_COLUMN_NAME"))
                        .collect::<Result<_>>()?,
                ));
            }
        }
        // VIEW_TABLE_USAGE is unavailable on some MariaDB releases; the engine also parses definitions.
        if let Ok(rows) = conn.exec::<Row, _, _>("SELECT VIEW_NAME,TABLE_NAME FROM information_schema.VIEW_TABLE_USAGE WHERE VIEW_SCHEMA=? AND TABLE_SCHEMA=?", (&self.config.database, &self.config.database)).await {
            for r in rows {
                let view: String = get(&r, "VIEW_NAME")?;
                let base = format!("{}.{}", self.config.database, get::<String>(&r, "TABLE_NAME")?);
                if let Some(ds) = datasets.get_mut(&view) { let mut rel = relationship(&base, vec![], &ds.dataset.name, vec![]); rel.kind = straton_core::RelationshipKind::Lineage; ds.relationships.push(rel); }
            }
        }
        Ok(datasets.into_values().collect())
    }
}
fn make_batch(columns: &[NativeColumn], values: Vec<Vec<Option<String>>>) -> Result<RecordBatch> {
    let plain: Vec<_> = columns.iter().map(|c| c.column.clone()).collect();
    let mut arrays = Vec::<ArrayRef>::new();
    for (c, values) in columns.iter().zip(values) {
        if c.column.data_type == "Binary" {
            let mut b = BinaryBuilder::new();
            for v in values {
                if let Some(v) = v {
                    if v.len() % 2 != 0 || !v.is_ascii() {
                        return Err(invalid("invalid binary value"));
                    }
                    let bytes = (0..v.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&v[i..i + 2], 16).map_err(error))
                        .collect::<Result<Vec<_>>>()?;
                    b.append_value(bytes);
                } else {
                    b.append_null();
                }
            }
            arrays.push(Arc::new(b.finish()));
        } else if c.typ == "time" {
            let v = values
                .into_iter()
                .map(|v| {
                    v.map(|v| v.parse::<f64>().map(|v| v as i64).map_err(error))
                        .transpose()
                })
                .collect::<Result<Vec<_>>>()?;
            arrays.push(Arc::new(DurationMicrosecondArray::from(v)));
        } else {
            arrays.push(
                batch(std::slice::from_ref(&c.column), vec![values])?
                    .column(0)
                    .clone(),
            );
        }
    }
    let fields = plain
        .iter()
        .map(|c| {
            Ok(arrow::datatypes::Field::new(
                &c.name,
                c.data_type.parse::<DataType>().map_err(error)?,
                c.nullable,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    RecordBatch::try_new(Arc::new(arrow::datatypes::Schema::new(fields)), arrays).map_err(error)
}
fn page_query(
    relation: &str,
    columns: &[NativeColumn],
    ordering: &[NativeColumn],
    lower: Option<&Value>,
    cursor: Option<&Value>,
    limit: usize,
) -> Result<(String, Vec<MysqlValue>)> {
    let mut params = Vec::<MysqlValue>::new();
    let mut predicates = vec![];
    if let Some(lower) = lower {
        params.push(bound_text(lower)?.into());
        predicates.push(format!(
            "{} >= {}",
            ident(&ordering[0].column.name),
            ordering[0].parameter()?
        ));
    }
    let ordered = ordering
        .iter()
        .map(|c| ident(&c.column.name))
        .collect::<Vec<_>>()
        .join(",");
    if let Some(cursor) = cursor {
        let values = cursor
            .as_array()
            .filter(|a| a.len() == ordering.len())
            .ok_or_else(|| invalid("invalid MySQL cursor"))?;
        let mut cast = vec![];
        for (v, c) in values.iter().zip(ordering) {
            params.push(bound_text(v)?.into());
            cast.push(c.parameter()?);
        }
        predicates.push(format!("({ordered}) > ({})", cast.join(",")));
    }
    let wh = if predicates.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", predicates.join(" AND "))
    };
    let select = columns
        .iter()
        .map(NativeColumn::select)
        .collect::<Vec<_>>()
        .join(",");
    Ok((
        format!("SELECT {select} FROM {relation} {wh} ORDER BY {ordered} LIMIT {limit}"),
        params,
    ))
}
impl Connector for Mysql {
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.connect()
                .await?
                .query_drop("SELECT 1")
                .await
                .map_err(error)
        })
    }
    fn discover(&self) -> BoxFuture<'_, Result<Vec<DatasetSchema>>> {
        Box::pin(self.discover_all())
    }
    fn advisor_metadata(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(advisor::metadata(self))
    }
    fn advisor_execute<'a>(&'a self, ddl: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(advisor::execute(self, ddl))
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
            let (db, name) = dataset
                .split_once('.')
                .ok_or_else(|| invalid("qualified MySQL dataset required"))?;
            if db != self.config.database {
                return Err(invalid("dataset is outside configured database"));
            }
            let mut conn = self.connect().await?;
            let all = self.columns(&mut conn, name).await?;
            let keys: Vec<String> = conn.exec("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", (&self.config.database, name)).await.map_err(error)?;
            if keys.is_empty() {
                return Err(invalid("MySQL reads require a primary key"));
            }
            if options.incremental.as_ref().is_some_and(|i| {
                i.key_columns.len() != keys.len() || !keys.iter().all(|k| i.key_columns.contains(k))
            }) || options
                .keys_only
                .as_ref()
                .is_some_and(|k| k.len() != keys.len() || !keys.iter().all(|name| k.contains(name)))
            {
                return Err(invalid("MySQL merge keys must match the primary key"));
            }
            let mut order = options
                .incremental
                .as_ref()
                .map(|i| vec![i.watermark_column.clone()])
                .unwrap_or_default();
            for key in &keys {
                if !order.contains(key) {
                    order.push(key.clone());
                }
            }
            let ordering = order
                .iter()
                .map(|n| {
                    all.iter()
                        .find(|c| &c.column.name == n)
                        .cloned()
                        .ok_or_else(|| invalid("key or watermark column missing"))
                })
                .collect::<Result<Vec<_>>>()?;
            if options.incremental.is_some()
                && !(ordering[0].column.data_type.starts_with("Int")
                    || ordering[0].column.data_type.starts_with("UInt")
                    || ordering[0].column.data_type.starts_with("Timestamp("))
            {
                return Err(invalid("MySQL watermark must be a timestamp or integer"));
            }
            let columns: Vec<_> = if options.keys_only.is_some() {
                ordering.clone()
            } else {
                all
            };
            let lower = options.incremental.and_then(|i| i.lower_bound);
            let relation = object(dataset)?;
            Ok(
                stream::try_unfold((conn, options.cursor), move |(mut conn, cursor)| {
                    let columns = columns.clone();
                    let ordering = ordering.clone();
                    let lower = lower.clone();
                    let relation = relation.clone();
                    async move {
                        let (sql, params) = page_query(
                            &relation,
                            &columns,
                            &ordering,
                            lower.as_ref(),
                            cursor.as_ref(),
                            self.config.batch_size,
                        )?;
                        let rows: Vec<Row> = conn
                            .exec(sql, Params::Positional(params))
                            .await
                            .map_err(error)?;
                        if rows.is_empty() {
                            return Ok(None);
                        }
                        let values = (0..columns.len())
                            .map(|i| {
                                rows.iter()
                                    .map(|r| {
                                        r.get_opt::<Option<String>, _>(i)
                                            .ok_or_else(|| invalid("missing MySQL value"))?
                                            .map_err(error)
                                    })
                                    .collect::<Result<Vec<_>>>()
                            })
                            .collect::<Result<Vec<_>>>()?;
                        let positions = ordering
                            .iter()
                            .map(|c| {
                                columns
                                    .iter()
                                    .position(|p| p.column.name == c.column.name)
                                    .unwrap()
                            })
                            .collect::<Vec<_>>();
                        if values
                            .iter()
                            .enumerate()
                            .any(|(i, vs)| positions.contains(&i) && vs.iter().any(Option::is_none))
                        {
                            return Err(invalid("watermarks and keys must be non-null"));
                        }
                        let next = json!(
                            positions
                                .iter()
                                .map(|i| values[*i].last().unwrap().clone().unwrap())
                                .collect::<Vec<_>>()
                        );
                        Ok(Some((
                            (make_batch(&columns, values)?, next.clone()),
                            (conn, Some(next)),
                        )))
                    }
                })
                .boxed(),
            )
        })
    }
}
#[cfg(test)]
mod tests;
