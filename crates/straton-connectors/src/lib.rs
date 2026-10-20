use arrow::{
    array::{ArrayRef, Int64Array, StringArray},
    compute::{CastOptions, cast_with_options},
    datatypes::{DataType, Field, Schema, TimeUnit},
    record_batch::RecordBatch,
};
use futures::{StreamExt, future::BoxFuture, stream};
use serde_json::{Value, json};
use sqlx::{
    Row,
    postgres::{PgConnectOptions, PgPoolOptions},
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};
use straton_core::{
    Column, Connector, Dataset, DatasetSchema, Error, ReadOptions, Relationship, RelationshipKind,
    Result,
};
fn error(_: impl std::fmt::Display) -> Error {
    Error::Connector("connector operation failed".into())
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn bound_text(value: &Value) -> Result<String> {
    match value {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(invalid("invalid watermark or key value")),
    }
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn table(s: &str) -> String {
    s.split('.').map(quote).collect::<Vec<_>>().join(".")
}
fn column(name: String, dt: DataType, nullable: bool, pk: bool) -> Column {
    Column {
        id: String::new(),
        dataset_id: String::new(),
        name,
        data_type: dt.to_string(),
        nullable,
        primary_key: pk,
    }
}
fn schema(name: String, columns: Vec<Column>, relationships: Vec<Relationship>) -> DatasetSchema {
    DatasetSchema {
        dataset: Dataset {
            id: String::new(),
            source_id: String::new(),
            name,
        },
        columns,
        relationships,
    }
}
fn relationship(from: &str, cols: Vec<String>, to: &str, targets: Vec<String>) -> Relationship {
    Relationship {
        id: String::new(),
        from_dataset: from.into(),
        from_cols: cols,
        to_dataset: to.into(),
        to_cols: targets,
        kind: RelationshipKind::DeclaredFk,
        confidence: None,
    }
}
fn batch(columns: &[Column], values: Vec<Vec<Option<String>>>) -> Result<RecordBatch> {
    let fields: Vec<Field> = columns
        .iter()
        .map(|c| {
            Ok(Field::new(
                &c.name,
                c.data_type.parse::<DataType>().map_err(error)?,
                c.nullable,
            ))
        })
        .collect::<Result<_>>()?;
    let arrays: Result<Vec<ArrayRef>> = fields
        .iter()
        .zip(values)
        .map(|(f, v)| {
            cast_with_options(
                &StringArray::from(v),
                f.data_type(),
                &CastOptions {
                    safe: false,
                    ..Default::default()
                },
            )
            .map_err(error)
        })
        .collect();
    RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays?).map_err(error)
}
pub struct Noop;
impl Connector for Noop {
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn discover(&self) -> BoxFuture<'_, Result<Vec<DatasetSchema>>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn read<'a>(
        &'a self,
        _: &'a str,
        options: ReadOptions,
    ) -> BoxFuture<'a, Result<straton_core::Batches<'a>>> {
        Box::pin(async move {
            let start = options.cursor.and_then(|c| c.as_u64()).unwrap_or(0);
            Ok(stream::iter((start..3).map(|n| {
                let b = RecordBatch::try_new(
                    Arc::new(Schema::new(vec![Field::new(
                        "offset",
                        DataType::Int64,
                        false,
                    )])),
                    vec![Arc::new(Int64Array::from(vec![n as i64]))],
                )
                .map_err(error)?;
                Ok((b, json!(n + 1)))
            }))
            .boxed())
        })
    }
}
enum Backend {
    Sqlite(sqlx::SqlitePool),
    Postgres(sqlx::PgPool),
    Csv(PathBuf),
}
struct Connected {
    backend: Backend,
    batch_size: usize,
    sample_size: usize,
}
pub fn build(kind: &str, config: &Value, secret: Option<&str>) -> Result<Box<dyn Connector>> {
    let batch_size = config
        .get("batch_size")
        .and_then(Value::as_u64)
        .unwrap_or(10_000) as usize;
    let sample_size = config
        .get("sample_size")
        .and_then(Value::as_u64)
        .unwrap_or(1000) as usize;
    if batch_size == 0 || sample_size == 0 {
        return Err(invalid("batch_size and sample_size must be positive"));
    }
    let path = || {
        config
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("path is required"))
    };
    let backend = match kind {
        "noop" => return Ok(Box::new(Noop)),
        "sqlite" => Backend::Sqlite(
            SqlitePoolOptions::new()
                .max_connections(1)
                .connect_lazy_with(
                    SqliteConnectOptions::new()
                        .filename(path()?)
                        .read_only(true),
                ),
        ),
        "csv" => Backend::Csv(PathBuf::from(path()?)),
        "postgres" => {
            let mut opts = PgConnectOptions::new()
                .host(
                    config
                        .get("host")
                        .and_then(Value::as_str)
                        .unwrap_or("localhost"),
                )
                .port(
                    config
                        .get("port")
                        .and_then(Value::as_u64)
                        .unwrap_or(5432)
                        .try_into()
                        .map_err(error)?,
                )
                .database(
                    config
                        .get("database")
                        .and_then(Value::as_str)
                        .ok_or_else(|| invalid("database is required"))?,
                )
                .username(
                    config
                        .get("username")
                        .and_then(Value::as_str)
                        .unwrap_or("postgres"),
                );
            if let Some(password) = secret {
                opts = opts.password(password);
            }
            Backend::Postgres(
                PgPoolOptions::new()
                    .max_connections(2)
                    .connect_lazy_with(opts),
            )
        }
        _ => return Err(invalid("source has no connector")),
    };
    Ok(Box::new(Connected {
        backend,
        batch_size,
        sample_size,
    }))
}
impl Connected {
    async fn read_keyset<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> Result<straton_core::Batches<'a>> {
        if options.incremental.is_some() && options.keys_only.is_some() {
            return Err(invalid(
                "incremental and key-only read options are mutually exclusive",
            ));
        }
        let ds = self
            .discover_all()
            .await?
            .into_iter()
            .find(|d| d.dataset.name == dataset)
            .ok_or_else(|| invalid("dataset not found"))?;
        let mut order = options
            .incremental
            .as_ref()
            .map(|i| vec![i.watermark_column.clone()])
            .unwrap_or_default();
        let keys = options
            .incremental
            .as_ref()
            .map(|i| &i.key_columns)
            .or(options.keys_only.as_ref())
            .filter(|k| !k.is_empty())
            .ok_or_else(|| invalid("a nonempty merge key is required"))?;
        for key in keys {
            if !order.contains(key) {
                order.push(key.clone());
            }
        }
        for name in &order {
            if !ds.columns.iter().any(|c| &c.name == name) {
                return Err(invalid("watermark or key column does not exist"));
            }
        }
        let columns: Vec<_> = if let Some(keys) = &options.keys_only {
            keys.iter()
                .map(|k| {
                    ds.columns
                        .iter()
                        .find(|c| &c.name == k)
                        .cloned()
                        .ok_or_else(|| invalid("key column does not exist"))
                })
                .collect::<Result<_>>()?
        } else {
            ds.columns
        };
        let postgres = matches!(self.backend, Backend::Postgres(_));
        let pg_types = if let Backend::Postgres(pool) = &self.backend {
            sqlx::query("SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS typ FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped")
                .bind(table(dataset)).fetch_all(pool).await.map_err(error)?
        } else {
            vec![]
        };
        let types: Vec<String> = order
            .iter()
            .map(|name| {
                if postgres {
                    pg_types
                        .iter()
                        .find(|r| r.get::<&str, _>("attname") == name)
                        .map(|r| r.get("typ"))
                        .ok_or_else(|| invalid("missing key type"))
                } else {
                    let c = columns
                        .iter()
                        .find(|c| &c.name == name)
                        .ok_or_else(|| invalid("missing key type"))?;
                    Ok(
                        if c.data_type.starts_with("Int") || c.data_type.starts_with("UInt") {
                            "INTEGER"
                        } else if c.data_type.starts_with("Float") {
                            "REAL"
                        } else {
                            "TEXT"
                        }
                        .to_owned(),
                    )
                }
            })
            .collect::<Result<_>>()?;
        let lower = options.incremental.and_then(|i| i.lower_bound);
        Ok(stream::try_unfold(options.cursor, move |cursor| {
            let columns = columns.clone();
            let order = order.clone();
            let types = types.clone();
            let lower = lower.clone();
            async move {
                let mut values = Vec::new();
                let mut predicates = Vec::new();
                let parameter = |n: usize, typ: &str| {
                    if postgres {
                        format!("CAST(CAST(${n} AS TEXT) AS {typ})")
                    } else {
                        format!("CAST(${n} AS {typ})")
                    }
                };
                if let Some(lower) = lower {
                    values.push(bound_text(&lower)?);
                    predicates.push(format!(
                        "{} >= {}",
                        quote(&order[0]),
                        parameter(values.len(), &types[0])
                    ));
                }
                let ordered = order.iter().map(|k| quote(k)).collect::<Vec<_>>().join(",");
                // Detect invalid null keys/watermarks before a keyset cursor can skip them.
                let sorting = order
                    .iter()
                    .map(|k| format!("{} NULLS FIRST", quote(k)))
                    .collect::<Vec<_>>()
                    .join(",");
                if let Some(cursor) = cursor {
                    let cursor = cursor
                        .as_array()
                        .filter(|v| v.len() == order.len())
                        .ok_or_else(|| invalid("invalid keyset cursor"))?;
                    let mut params = Vec::new();
                    for (value, typ) in cursor.iter().zip(&types) {
                        values.push(bound_text(value)?);
                        params.push(parameter(values.len(), typ));
                    }
                    // A one-column key is a scalar comparison, not a row constructor.
                    predicates.push(format!("({ordered}) > ({})", params.join(",")));
                }
                let wh = if predicates.is_empty() {
                    String::new()
                } else {
                    format!("WHERE {}", predicates.join(" AND "))
                };
                let select = columns
                    .iter()
                    .map(|c| format!("CAST({} AS TEXT)", quote(&c.name)))
                    .collect::<Vec<_>>()
                    .join(",");
                let relation = if postgres {
                    table(dataset)
                } else {
                    quote(dataset)
                };
                let limit = values.len() + 1;
                let sql = format!(
                    "SELECT {select} FROM {relation} {wh} ORDER BY {sorting} LIMIT ${limit}"
                );
                let rows: Vec<Vec<Option<String>>> = match &self.backend {
                    Backend::Sqlite(pool) => {
                        let mut q = sqlx::query(&sql);
                        for v in values {
                            q = q.bind(v);
                        }
                        q.bind(self.batch_size as i64)
                            .fetch_all(pool)
                            .await
                            .map_err(error)?
                            .iter()
                            .map(|r| {
                                (0..columns.len())
                                    .map(|i| r.try_get(i).map_err(error))
                                    .collect()
                            })
                            .collect::<Result<_>>()?
                    }
                    Backend::Postgres(pool) => {
                        let mut q = sqlx::query(&sql);
                        for v in values {
                            q = q.bind(v);
                        }
                        q.bind(self.batch_size as i64)
                            .fetch_all(pool)
                            .await
                            .map_err(error)?
                            .iter()
                            .map(|r| {
                                (0..columns.len())
                                    .map(|i| r.try_get(i).map_err(error))
                                    .collect()
                            })
                            .collect::<Result<_>>()?
                    }
                    Backend::Csv(_) => return Err(invalid("CSV keyset reads are unsupported")),
                };
                if rows.is_empty() {
                    return Ok(None);
                }
                let positions: Vec<_> = order
                    .iter()
                    .map(|k| columns.iter().position(|c| &c.name == k).unwrap())
                    .collect();
                if rows
                    .iter()
                    .any(|r| positions.iter().any(|i| r[*i].is_none()))
                {
                    return Err(invalid("watermark and merge keys must be non-null"));
                }
                let next = Value::Array(
                    positions
                        .iter()
                        .map(|i| json!(rows.last().unwrap()[*i]))
                        .collect(),
                );
                let values = (0..columns.len())
                    .map(|i| rows.iter().map(|r| r[i].clone()).collect())
                    .collect();
                Ok(Some(((batch(&columns, values)?, next.clone()), Some(next))))
            }
        })
        .boxed())
    }

    fn csv_schema(&self, path: &Path) -> Result<Arc<Schema>> {
        let mut file = File::open(path).map_err(error)?;
        let (schema, _) = arrow::csv::reader::Format::default()
            .with_header(true)
            .infer_schema(&mut file, Some(self.sample_size))
            .map_err(error)?;
        Ok(Arc::new(schema))
    }
    async fn discover_all(&self) -> Result<Vec<DatasetSchema>> {
        match &self.backend {
            Backend::Csv(dir) => {
                let mut paths = std::fs::read_dir(dir)
                    .map_err(error)?
                    .map(|e| e.map(|e| e.path()))
                    .collect::<std::io::Result<Vec<_>>>()
                    .map_err(error)?;
                paths.sort();
                let mut out = Vec::new();
                for path in paths {
                    if path.extension().and_then(|s| s.to_str()) != Some("csv") || !path.is_file() {
                        continue;
                    }
                    let name = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .ok_or_else(|| invalid("invalid CSV name"))?
                        .to_string();
                    let columns = self
                        .csv_schema(&path)?
                        .fields()
                        .iter()
                        .map(|f| {
                            column(
                                f.name().clone(),
                                f.data_type().clone(),
                                f.is_nullable(),
                                false,
                            )
                        })
                        .collect();
                    out.push(schema(name, columns, vec![]));
                }
                Ok(out)
            }
            Backend::Sqlite(pool) => {
                let names: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(pool).await.map_err(error)?;
                let mut out = Vec::new();
                for name in names {
                    let rows = sqlx::query(&format!("PRAGMA table_info({})", quote(&name)))
                        .fetch_all(pool)
                        .await
                        .map_err(error)?;
                    let columns = rows
                        .iter()
                        .map(|r| {
                            let t: String = r.get("type");
                            let t = t.to_uppercase();
                            let dt = if t.contains("INT") {
                                DataType::Int64
                            } else if t == "DATE" {
                                DataType::Date32
                            } else if t.contains("TIMESTAMP") || t == "DATETIME" {
                                DataType::Timestamp(TimeUnit::Microsecond, None)
                            } else if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB")
                            {
                                DataType::Float64
                            } else {
                                DataType::Utf8
                            };
                            let pk = r.get::<i64, _>("pk") > 0;
                            let required = r.get::<bool, _>("notnull")
                                || (pk
                                    && t == "INTEGER"
                                    && rows.iter().filter(|r| r.get::<i64, _>("pk") > 0).count()
                                        == 1);
                            column(r.get("name"), dt, !required, pk)
                        })
                        .collect();
                    let rows = sqlx::query(&format!("PRAGMA foreign_key_list({})", quote(&name)))
                        .fetch_all(pool)
                        .await
                        .map_err(error)?;
                    let mut groups = std::collections::BTreeMap::<i64, Vec<_>>::new();
                    for row in rows {
                        groups.entry(row.get("id")).or_default().push(row);
                    }
                    let mut rels = Vec::new();
                    for mut rows in groups.into_values() {
                        rows.sort_by_key(|r| r.get::<i64, _>("seq"));
                        let target: String = rows[0].get("table");
                        let pkrows = sqlx::query(&format!("PRAGMA table_info({})", quote(&target)))
                            .fetch_all(pool)
                            .await
                            .map_err(error)?;
                        let mut pks: Vec<_> = pkrows
                            .iter()
                            .filter(|r| r.get::<i64, _>("pk") > 0)
                            .collect();
                        pks.sort_by_key(|r| r.get::<i64, _>("pk"));
                        let targets = rows
                            .iter()
                            .enumerate()
                            .map(|(i, r)| {
                                r.get::<Option<String>, _>("to").unwrap_or_else(|| {
                                    pks.get(i).map(|r| r.get("name")).unwrap_or_default()
                                })
                            })
                            .collect();
                        rels.push(relationship(
                            &name,
                            rows.iter().map(|r| r.get("from")).collect(),
                            &target,
                            targets,
                        ));
                    }
                    out.push(schema(name, columns, rels));
                }
                Ok(out)
            }
            Backend::Postgres(pool) => {
                let tables = sqlx::query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name").fetch_all(pool).await.map_err(error)?;
                let mut out = Vec::new();
                for t in tables {
                    let ns: String = t.get("table_schema");
                    let name: String = t.get("table_name");
                    let full = format!("{ns}.{name}");
                    let rows=sqlx::query("SELECT c.column_name,c.udt_name,c.is_nullable,c.numeric_precision,c.numeric_scale,EXISTS(SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k USING(constraint_catalog,constraint_schema,constraint_name) WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND k.table_schema=tc.table_schema AND k.table_name=tc.table_name AND k.column_name=c.column_name) AS pk FROM information_schema.columns c WHERE c.table_schema=$1 AND c.table_name=$2 ORDER BY c.ordinal_position").bind(&ns).bind(&name).fetch_all(pool).await.map_err(error)?;
                    let columns = rows
                        .iter()
                        .map(|r| {
                            let typ: String = r.get("udt_name");
                            let dt = match typ.as_str() {
                                "int2" => DataType::Int16,
                                "int4" => DataType::Int32,
                                "int8" => DataType::Int64,
                                "float4" => DataType::Float32,
                                "float8" => DataType::Float64,
                                "bool" => DataType::Boolean,
                                "date" => DataType::Date32,
                                "timestamp" => DataType::Timestamp(TimeUnit::Microsecond, None),
                                "timestamptz" => DataType::Timestamp(
                                    TimeUnit::Microsecond,
                                    Some("+00:00".into()),
                                ),
                                "numeric" => {
                                    let p: Option<i32> = r.get("numeric_precision");
                                    let s: Option<i32> = r.get("numeric_scale");
                                    match (p, s) {
                                        (Some(p), Some(s))
                                            if (1..=38).contains(&p) && (-38..=38).contains(&s) =>
                                        {
                                            DataType::Decimal128(p.max(s) as u8, s as i8)
                                        }
                                        _ => DataType::Utf8,
                                    }
                                }
                                _ => DataType::Utf8,
                            };
                            column(
                                r.get("column_name"),
                                dt,
                                r.get::<String, _>("is_nullable") == "YES",
                                r.get("pk"),
                            )
                        })
                        .collect();
                    let rows=sqlx::query("SELECT con.oid::bigint AS oid, a.attname AS from_col, tn.nspname || '.' || tt.relname AS target, ta.attname AS to_col FROM pg_constraint con JOIN pg_class st ON st.oid=con.conrelid JOIN pg_namespace sn ON sn.oid=st.relnamespace JOIN pg_class tt ON tt.oid=con.confrelid JOIN pg_namespace tn ON tn.oid=tt.relnamespace CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(src,dst,ord) JOIN pg_attribute a ON a.attrelid=st.oid AND a.attnum=k.src JOIN pg_attribute ta ON ta.attrelid=tt.oid AND ta.attnum=k.dst WHERE con.contype='f' AND sn.nspname=$1 AND st.relname=$2 ORDER BY con.oid,k.ord").bind(&ns).bind(&name).fetch_all(pool).await.map_err(error)?;
                    let mut groups = std::collections::BTreeMap::<i64, Vec<_>>::new();
                    for r in rows {
                        groups.entry(r.get("oid")).or_default().push(r);
                    }
                    let rels = groups
                        .into_values()
                        .map(|rows| {
                            relationship(
                                &full,
                                rows.iter().map(|r| r.get("from_col")).collect(),
                                rows[0].get::<&str, _>("target"),
                                rows.iter().map(|r| r.get("to_col")).collect(),
                            )
                        })
                        .collect();
                    out.push(schema(full, columns, rels));
                }
                Ok(out)
            }
        }
    }
}
impl Connector for Connected {
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            match &self.backend {
                Backend::Sqlite(p) => {
                    sqlx::query("SELECT 1").execute(p).await.map_err(error)?;
                }
                Backend::Postgres(p) => {
                    sqlx::query("SELECT 1").execute(p).await.map_err(error)?;
                }
                Backend::Csv(p) => {
                    std::fs::read_dir(p).map_err(error)?;
                }
            }
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
    ) -> BoxFuture<'a, Result<straton_core::Batches<'a>>> {
        Box::pin(async move {
            if matches!(self.backend, Backend::Csv(_))
                && (options.incremental.is_some() || options.keys_only.is_some())
            {
                return Err(invalid(
                    "CSV supports full reads only; incremental and key-only reads are unsupported",
                ));
            }
            if options.incremental.is_some() || options.keys_only.is_some() {
                return self.read_keyset(dataset, options).await;
            }
            let cursor = options.cursor;
            let ds = self
                .discover_all()
                .await?
                .into_iter()
                .find(|d| d.dataset.name == dataset)
                .ok_or_else(|| invalid("dataset not found"))?;
            if let Backend::Csv(dir) = &self.backend {
                let path = dir.join(format!("{dataset}.csv"));
                let schema = self.csv_schema(&path)?;
                let file = File::open(path).map_err(error)?;
                let mut offset = cursor.as_ref().and_then(Value::as_u64).unwrap_or(0) as usize;
                let reader = arrow::csv::ReaderBuilder::new(schema)
                    .with_header(true)
                    .with_batch_size(self.batch_size)
                    .with_bounds(offset, usize::MAX - 1)
                    .build(file)
                    .map_err(error)?;
                return Ok(stream::iter(reader.map(move |b| {
                    let b = b.map_err(error)?;
                    offset += b.num_rows();
                    Ok((b, json!(offset)))
                }))
                .boxed());
            }
            let columns = ds.columns;
            let pk: Vec<_> = columns
                .iter()
                .filter(|c| c.primary_key)
                .map(|c| c.name.clone())
                .collect();
            if matches!(self.backend, Backend::Postgres(_)) && pk.is_empty() {
                return Err(invalid("Postgres reads require a primary key"));
            }
            Ok(stream::try_unfold(cursor, move |cursor| {
                let columns = columns.clone();
                let pk = pk.clone();
                async move {
                    let (values, next, count) = match &self.backend {
                        Backend::Sqlite(pool) => {
                            let rowid = ["rowid", "_rowid_", "oid"].into_iter()
                                .find(|n| !columns.iter().any(|c| c.name.eq_ignore_ascii_case(n)))
                                .ok_or_else(|| invalid("rowid aliases shadowed"))?;
                            let select = columns.iter().map(|c| format!("CAST({} AS TEXT)", quote(&c.name)))
                                .collect::<Vec<_>>().join(",");
                            let wh = if cursor.is_some() { format!("WHERE {rowid} > ?") } else { String::new() };
                            let sql = format!("SELECT {rowid}, {select} FROM {} {wh} ORDER BY {rowid} LIMIT ?", quote(dataset));
                            let mut query = sqlx::query(&sql);
                            if let Some(c) = cursor {
                                query = query.bind(c.as_i64().ok_or_else(|| invalid("invalid rowid cursor"))?);
                            }
                            let rows = query.bind(self.batch_size as i64).fetch_all(pool).await.map_err(error)?;
                            let next = rows.last().map(|r| json!(r.get::<i64, _>(0))).unwrap_or(Value::Null);
                            let values = (0..columns.len()).map(|i| rows.iter()
                                .map(|r| r.try_get::<Option<String>, _>(i + 1).map_err(error))
                                .collect::<Result<Vec<_>>>()).collect::<Result<Vec<_>>>()?;
                            (values, next, rows.len())
                        }
                        Backend::Postgres(pool) => {
                            let types = sqlx::query("SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS typ FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped")
                                .bind(table(dataset)).fetch_all(pool).await.map_err(error)?;
                            let keys = pk.iter().map(|s| quote(s)).collect::<Vec<_>>().join(",");
                            let mut params = Vec::new();
                            if cursor.is_some() {
                                for (i, key) in pk.iter().enumerate() {
                                    let typ = types.iter().find(|r| r.get::<&str, _>("attname") == key)
                                        .ok_or_else(|| invalid("missing key type"))?.get::<String, _>("typ");
                                    params.push(format!("({}{}::text)::{typ}", "$", i + 1));
                                }
                            }
                            let wh = if cursor.is_some() { format!("WHERE ({keys}) > ({})", params.join(",")) } else { String::new() };
                            let select = columns.iter().map(|c| format!("{}::text", quote(&c.name))).collect::<Vec<_>>().join(",");
                            let sql = format!("SELECT {select} FROM {} {wh} ORDER BY {keys} LIMIT {}", table(dataset), self.batch_size);
                            let mut query = sqlx::query(&sql);
                            if let Some(c) = cursor {
                                let a = c.as_array().filter(|a| a.len() == pk.len()).ok_or_else(|| invalid("invalid key cursor"))?;
                                for value in a {
                                    query = query.bind(value.as_str().ok_or_else(|| invalid("invalid key value"))?.to_string());
                                }
                            }
                            let rows = query.fetch_all(pool).await.map_err(error)?;
                            let values = (0..columns.len()).map(|i| rows.iter()
                                .map(|r| r.try_get::<Option<String>, _>(i).map_err(error))
                                .collect::<Result<Vec<_>>>()).collect::<Result<Vec<_>>>()?;
                            let next = if rows.is_empty() { Value::Null } else {
                                Value::Array(pk.iter().map(|key| {
                                    let i = columns.iter().position(|c| &c.name == key).unwrap();
                                    json!(values[i][rows.len() - 1])
                                }).collect())
                            };
                            (values, next, rows.len())
                        }
                        Backend::Csv(_) => unreachable!(),
                    };
                    if count == 0 { return Ok(None); }
                    Ok(Some(((batch(&columns, values)?, next.clone()), Some(next))))
                }
            }).boxed())
        })
    }
}
pub fn write_parquet(path: &Path, batch: &RecordBatch) -> Result<()> {
    std::fs::create_dir_all(path.parent().ok_or_else(|| invalid("missing parent"))?)
        .map_err(error)?;
    let temp = path.with_extension("partial");
    let mut w = parquet::arrow::ArrowWriter::try_new(
        File::create(&temp).map_err(error)?,
        batch.schema(),
        None,
    )
    .map_err(error)?;
    w.write(batch).map_err(error)?;
    let file = w.into_inner().map_err(error)?;
    file.sync_all().map_err(error)?;
    drop(file);
    std::fs::rename(temp, path).map_err(error)?;
    #[cfg(unix)]
    File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(error)?;
    Ok(())
}

pub use parquet;
#[cfg(test)]
mod tests;
