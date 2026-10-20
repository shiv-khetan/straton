use crate::{catalog, config, store};
use anyhow::{Result, ensure};
use datafusion::{
    arrow::{
        array::*,
        datatypes::{DataType, Field, Schema, SchemaRef},
        record_batch::RecordBatch,
        util::display::array_value_to_string,
    },
    catalog::{MemorySchemaProvider, SchemaProvider},
    common::{ScalarValue, tree_node::TreeNodeRecursion},
    dataframe::DataFrame,
    datasource::{
        file_format::parquet::ParquetFormat,
        listing::{ListingOptions, ListingTable, ListingTableConfig, ListingTableUrl},
    },
    execution::{
        context::SQLOptions,
        memory_pool::{GreedyMemoryPool, MemoryConsumer, MemoryReservation},
        runtime_env::{RuntimeEnv, RuntimeEnvBuilder},
    },
    logical_expr::{LogicalPlan, Statement as PlanStatement},
    physical_plan::displayable,
    prelude::{SessionConfig, SessionContext},
    sql::{
        parser::{DFParser, Statement},
        sqlparser::ast::Statement as AstStatement,
    },
};
use futures::StreamExt;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

pub mod wire;

// Readers pin the resolved snapshot until execution ends; publication must not delete it.
pub static SNAPSHOTS: RwLock<()> = RwLock::const_new(());

#[derive(Clone)]
pub struct Sql {
    pub(crate) pool: SqlitePool,
    principal: Option<crate::access::Principal>,
    data_dir: PathBuf,
    pub config: config::Sql,
    runtime: Arc<RuntimeEnv>,
}
#[derive(Debug)]
pub struct Error {
    pub class: &'static str,
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}
impl Error {
    fn new(class: &'static str, message: impl Into<String>) -> Self {
        Self {
            class,
            message: message.into(),
        }
    }
}
impl From<datafusion::error::DataFusionError> for Error {
    fn from(e: datafusion::error::DataFusionError) -> Self {
        let class = if matches!(
            e.find_root(),
            datafusion::error::DataFusionError::ResourcesExhausted(_)
        ) {
            "memory_limit"
        } else {
            "query"
        };
        Self::new(class, e.to_string())
    }
}
impl From<anyhow::Error> for Error {
    fn from(_: anyhow::Error) -> Self {
        Self::new("internal", "SQL catalog operation failed")
    }
}
#[derive(Serialize)]
pub struct Column {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
}
#[derive(Serialize)]
pub struct Table {
    schema: String,
    name: String,
    columns: Vec<Column>,
}
pub struct Output {
    pub schema: SchemaRef,
    pub parameter_types: Vec<DataType>,
    pub batches: Vec<RecordBatch>,
    pub row_count: usize,
    pub elapsed_ms: u128,
    pub logical: String,
    pub physical: String,
    _reservation: MemoryReservation,
}
#[derive(Clone, Copy)]
enum Mode {
    Query,
    Explain,
    Describe,
}

pub fn statement(query: &str) -> std::result::Result<Statement, Error> {
    let mut statements = DFParser::parse_sql(query)
        .map_err(|_| Error::new("rejected", "Expected one read-only SQL query"))?;
    if statements.len() != 1 {
        return Err(Error::new(
            "rejected",
            "Exactly one read-only SQL query is required",
        ));
    }
    Ok(statements.pop_front().unwrap())
}
fn read_only(stmt: &Statement) -> bool {
    match stmt {
        Statement::Statement(s) => matches!(s.as_ref(), AstStatement::Query(_)),
        Statement::Explain(s) => !s.options.analyze && read_only(&s.statement),
        _ => false,
    }
}
fn options() -> SQLOptions {
    SQLOptions::new()
        .with_allow_ddl(false)
        .with_allow_dml(false)
        .with_allow_statements(false)
}
fn schema_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() || out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

fn unique_name(base: String, used: &mut BTreeSet<String>) -> String {
    let mut name = base.clone();
    let mut suffix = 2;
    while !used.insert(name.clone()) {
        name = format!("{base}_{suffix}");
        suffix += 1;
    }
    name
}
// Both the map and SQL catalog use the same aliases, including collision suffixes.
pub fn catalog_names(
    sources: &[sqlx::sqlite::SqliteRow],
    datasets: &[sqlx::sqlite::SqliteRow],
) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let mut used = BTreeSet::from([
        "public".to_owned(),
        "information_schema".to_owned(),
        "pg_catalog".to_owned(),
    ]);
    let schemas = sources
        .iter()
        .map(|s| {
            (
                s.get::<String, _>("id"),
                unique_name(schema_name(s.get("name")), &mut used),
            )
        })
        .collect();
    let mut ordered: Vec<_> = datasets.iter().collect();
    ordered.sort_by_key(|d| (d.get::<String, _>("source_id"), d.get::<String, _>("name")));
    let mut used_tables = BTreeMap::<String, BTreeSet<String>>::new();
    let tables = ordered
        .into_iter()
        .map(|d| {
            let source: &str = d.get("source_id");
            let name: &str = d.get("name");
            let alias = if source == "straton-local-lake" {
                let display = name
                    .split_once('/')
                    .and_then(|(id, table)| {
                        sources
                            .iter()
                            .find(|s| s.get::<&str, _>("id") == id)
                            .map(|s| format!("{}.{table}", s.get::<&str, _>("name")))
                    })
                    .unwrap_or_else(|| name.to_owned());
                unique_name(
                    schema_name(&display),
                    used_tables.entry(source.to_owned()).or_default(),
                )
            } else {
                name.to_owned()
            };
            (d.get::<String, _>("id"), alias)
        })
        .collect();
    (schemas, tables)
}

fn columns(schema: &Schema) -> Vec<Column> {
    schema
        .fields()
        .iter()
        .map(|f| Column {
            name: f.name().clone(),
            data_type: match f.data_type() {
                DataType::Utf8View => "Utf8".to_owned(),
                DataType::BinaryView => "Binary".to_owned(),
                other => other.to_string(),
            },
        })
        .collect()
}
impl Sql {
    pub fn new(pool: SqlitePool, config: &config::Config) -> Result<Self> {
        let bytes = config
            .sql
            .memory_limit_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| anyhow::anyhow!("sql.memory_limit_mb is too large"))?;
        let runtime = RuntimeEnvBuilder::new()
            .with_memory_pool(Arc::new(GreedyMemoryPool::new(bytes)))
            .build_arc()?;
        Ok(Self {
            pool,
            principal: None,
            data_dir: config.data_dir.clone(),
            config: config.sql.clone(),
            runtime,
        })
    }
    pub fn for_principal(&self, p: crate::access::Principal) -> Self {
        let mut sql = self.clone();
        sql.principal = Some(p);
        sql
    }
    async fn context(&self) -> Result<(SessionContext, Vec<Table>)> {
        let ctx = SessionContext::new_with_config_rt(
            SessionConfig::new().with_information_schema(false),
            self.runtime.clone(),
        );
        let principal = self
            .principal
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("SQL principal required"))?;
        crate::policies::hash_udf(&ctx);
        let sources = sqlx::query("SELECT id,name FROM sources ORDER BY id")
            .fetch_all(&self.pool)
            .await?;
        let datasets =
            sqlx::query("SELECT id,source_id,name FROM datasets ORDER BY source_id,name")
                .fetch_all(&self.pool)
                .await?;
        let (schema_names, table_names) = catalog_names(&sources, &datasets);
        let mut schemas = BTreeMap::new();
        for source in sources {
            let name = schema_names[source.get::<&str, _>("id")].clone();
            let provider = Arc::new(MemorySchemaProvider::new());
            ctx.catalog("datafusion")
                .unwrap()
                .register_schema(&name, provider.clone())?;
            schemas.insert(source.get::<String, _>("id"), (name, provider));
        }
        let mut tables = Vec::new();
        // Resolve each physical dataset only once, including its Local lake alias.
        let mut snapshots = BTreeMap::new();
        let datasets: Vec<_> = datasets
            .into_iter()
            .filter(|d| {
                principal.admin()
                    || !principal
                        .read_roles(d.get("source_id"), d.get("id"))
                        .is_empty()
            })
            .collect();
        for d in &datasets {
            let source: &str = d.get("source_id");
            let name: &str = d.get("name");
            let (storage_source, storage_dataset) = if source == "straton-local-lake" {
                name.split_once('/')
                    .ok_or_else(|| anyhow::anyhow!("invalid lake dataset"))?
            } else {
                (source, name)
            };
            catalog::path_component(storage_source)?;
            catalog::path_component(storage_dataset)?;
            let key = (storage_source.to_owned(), storage_dataset.to_owned());
            if let std::collections::btree_map::Entry::Vacant(entry) = snapshots.entry(key) {
                let dir = self
                    .data_dir
                    .join("data")
                    .join(storage_source)
                    .join(storage_dataset);
                let snapshot = match tokio::fs::read_to_string(dir.join("_current")).await {
                    Ok(run) => {
                        ensure!(
                            uuid::Uuid::try_parse(&run).is_ok(),
                            "invalid current snapshot"
                        );
                        let path = dir.join(&run).canonicalize()?;
                        ensure!(
                            path.parent() == Some(dir.canonicalize()?.as_path()),
                            "snapshot escapes dataset"
                        );
                        Some(path)
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(e.into()),
                };
                entry.insert(snapshot);
            }
        }
        for d in datasets {
            let source: &str = d.get("source_id");
            let name: &str = d.get("name");
            let (s, t) = if source == "straton-local-lake" {
                name.split_once('/').unwrap()
            } else {
                (source, name)
            };
            let Some(path) = &snapshots[&(s.to_owned(), t.to_owned())] else {
                continue;
            };
            let mut urls = Vec::new();
            for file in std::fs::read_dir(path)? {
                let file = file?;
                if file.file_type()?.is_file()
                    && file.path().extension().is_some_and(|e| e == "parquet")
                {
                    let file = file.path().canonicalize()?;
                    ensure!(
                        file.parent() == Some(path.as_path()),
                        "Parquet file escapes snapshot"
                    );
                    urls.push(listing_url(&file)?);
                }
            }
            let opts = ListingOptions::new(Arc::new(ParquetFormat::default()))
                .with_file_extension(".parquet");
            let cfg = if urls.is_empty() {
                let rows = sqlx::query(
                    "SELECT name,data_type,nullable FROM columns WHERE dataset_id=? ORDER BY rowid",
                )
                .bind(d.get::<&str, _>("id"))
                .fetch_all(&self.pool)
                .await?;
                let fields: Result<Vec<_>> = rows
                    .into_iter()
                    .map(|r| {
                        Ok(Field::new(
                            r.get::<String, _>("name"),
                            r.get::<&str, _>("data_type").parse::<DataType>()?,
                            r.get::<bool, _>("nullable"),
                        ))
                    })
                    .collect();
                // An empty snapshot has no file URLs, so nested files cannot be scanned.
                let mut cfg = ListingTableConfig::new_with_multi_paths(vec![]);
                cfg.options = Some(opts);
                cfg.with_schema(Arc::new(Schema::new(fields?)))
            } else {
                ListingTableConfig::new_with_multi_paths(urls)
                    .with_listing_options(opts)
                    .infer_schema(&ctx.state())
                    .await?
            };
            let table = ListingTable::try_new(cfg)?;
            let (schema, provider) = &schemas[source];
            let alias = &table_names[d.get::<&str, _>("id")];
            let frame = ctx.read_table(Arc::new(table))?;
            let Some(policy) =
                crate::policies::effective(&self.pool, principal, source, d.get("id"), &frame)
                    .await?
            else {
                continue;
            };
            let view = crate::policies::project(frame, policy)?.into_view();
            tables.push(Table {
                schema: schema.clone(),
                name: alias.clone(),
                columns: columns(&view.schema()),
            });
            provider.register_table(alias.clone(), view)?;
        }
        Ok((ctx, tables))
    }
    pub async fn tables(&self) -> std::result::Result<Vec<Table>, Error> {
        if !self.config.enabled {
            return Err(Error::new("disabled", "SQL endpoint is disabled"));
        }
        tokio::time::timeout(
            Duration::from_secs_f64(self.config.query_timeout_secs),
            async {
                let _snapshot = SNAPSHOTS.read().await;
                Ok(self.context().await?.1)
            },
        )
        .await
        .map_err(|_| Error::new("timeout", "SQL query timed out"))?
    }
    async fn plan(
        &self,
        ctx: &SessionContext,
        query: &str,
        types: &[String],
    ) -> std::result::Result<DataFrame, Error> {
        if !read_only(&statement(query)?) {
            return Err(Error::new(
                "rejected",
                "Read-only SQL: DDL, DML, COPY and session statements are disabled",
            ));
        }
        if types.is_empty() {
            let plan = ctx.state().create_logical_plan(query).await?;
            options()
                .verify_plan(&plan)
                .map_err(|_| Error::new("rejected", "Read-only SQL required"))?;
            Ok(DataFrame::new(ctx.state(), plan))
        } else {
            // PREPARE supplies parameter types to planning only; no session statement executes.
            let sql = format!(
                "PREPARE straton_parameters ({}) AS {query}",
                types.join(",")
            );
            let plan = ctx.state().create_logical_plan(&sql).await?;
            let LogicalPlan::Statement(PlanStatement::Prepare(p)) = plan else {
                return Err(Error::new("internal", "Expected parameter plan"));
            };
            options()
                .verify_plan(&p.input)
                .map_err(|_| Error::new("rejected", "Read-only SQL required"))?;
            Ok(DataFrame::new(ctx.state(), p.input.as_ref().clone()))
        }
    }
    async fn work(
        &self,
        query: &str,
        params: Vec<ScalarValue>,
        types: &[String],
        mode: Mode,
        touched: &mut BTreeSet<String>,
    ) -> std::result::Result<Output, Error> {
        if !self.config.enabled {
            return Err(Error::new("disabled", "SQL endpoint is disabled"));
        }
        let _snapshot = SNAPSHOTS.read().await;
        let (ctx, _) = self.context().await?;
        let mut frame = self.plan(&ctx, query, types).await?;
        frame.logical_plan().apply_with_subqueries(|p| {
            match p {
                LogicalPlan::SubqueryAlias(alias) => {
                    touched.insert(alias.alias.to_string());
                }
                LogicalPlan::TableScan(scan) if scan.table_name.to_string() != "?table?" => {
                    touched.insert(scan.table_name.to_string());
                }
                _ => {}
            }
            Ok(TreeNodeRecursion::Continue)
        })?;
        if !params.is_empty() {
            frame = frame.with_param_values(params)?;
        }
        let schema = Arc::new(frame.schema().as_arrow().clone());
        let parameter_map = frame.logical_plan().get_parameter_types()?;
        let count = parameter_map.len();
        if (1..=count).any(|i| !parameter_map.contains_key(&format!("${i}"))) {
            return Err(Error::new(
                "parameters",
                "SQL parameters must be contiguous from $1",
            ));
        }
        let parameter_types = (1..=count)
            .map(|i| {
                parameter_map
                    .get(&format!("${i}"))
                    .and_then(Clone::clone)
                    .unwrap_or(DataType::Utf8)
            })
            .collect();
        let mut out = Output {
            schema,
            parameter_types,
            batches: vec![],
            row_count: 0,
            elapsed_ms: 0,
            logical: String::new(),
            physical: String::new(),
            _reservation: MemoryConsumer::new("SQL results").register(&self.runtime.memory_pool),
        };
        match mode {
            Mode::Describe => {}
            Mode::Explain => {
                out.logical = frame.logical_plan().display_indent().to_string();
                out.physical = displayable(frame.create_physical_plan().await?.as_ref())
                    .indent(true)
                    .to_string();
            }
            Mode::Query => {
                let mut stream = frame.execute_stream().await?;
                while let Some(batch) = stream.next().await {
                    let batch = batch?;
                    out.row_count += batch.num_rows();
                    if out.row_count > self.config.max_rows {
                        return Err(Error::new("max_rows", "SQL result exceeds sql.max_rows"));
                    }
                    out._reservation.try_grow(batch.get_array_memory_size())?;
                    out.batches.push(batch);
                }
            }
        }
        Ok(out)
    }
    async fn audited(
        &self,
        original: &str,
        query: &str,
        params: Vec<ScalarValue>,
        types: &[String],
        mode: Mode,
    ) -> std::result::Result<Output, Error> {
        let start = Instant::now();
        let mut touched = BTreeSet::new();
        let result = tokio::time::timeout(
            Duration::from_secs_f64(self.config.query_timeout_secs),
            self.work(query, params, types, mode, &mut touched),
        )
        .await
        .unwrap_or_else(|_| Err(Error::new("timeout", "SQL query timed out")));
        if !matches!(mode, Mode::Describe) || result.is_err() {
            self.audit(
                original,
                &touched,
                result.as_ref().map(|o| o.row_count).map_err(|e| e.class),
            )
            .await?;
        }
        result.map(|mut out| {
            out.elapsed_ms = start.elapsed().as_millis();
            out
        })
    }
    pub(crate) async fn audit(
        &self,
        query: &str,
        touched: &BTreeSet<String>,
        result: std::result::Result<usize, &str>,
    ) -> std::result::Result<(), Error> {
        let hash = format!("{:x}", Sha256::digest(query.as_bytes()));
        let detail = json!({"principal":self.principal.as_ref().map(|p| &p.user.id),"query_hash":hash,"datasets":touched,"row_count":result.as_ref().ok(),"error_class":result.err()});
        let action = if detail["error_class"] == "rejected" {
            "sql.rejected"
        } else {
            "sql.query"
        };
        let mut tx = self.pool.begin().await.map_err(anyhow::Error::from)?;
        store::audit_as(
            &mut tx,
            action,
            self.principal.as_ref().map_or("", |p| p.user.id.as_str()),
            &detail.to_string(),
            self.principal.as_ref().map(|p| p.user.id.as_str()),
        )
        .await?;
        tx.commit().await.map_err(anyhow::Error::from)?;
        Ok(())
    }
    pub async fn query(&self, query: &str) -> std::result::Result<Output, Error> {
        self.audited(query, query, vec![], &[], Mode::Query).await
    }
    pub async fn explain(&self, query: &str) -> std::result::Result<Output, Error> {
        self.audited(query, query, vec![], &[], Mode::Explain).await
    }
}
pub fn preview(out: &Output, limit: usize) -> std::result::Result<Value, Error> {
    let mut rows = Vec::new();
    for batch in &out.batches {
        for row in 0..batch.num_rows() {
            if rows.len() == limit {
                break;
            }
            rows.push(
                batch
                    .columns()
                    .iter()
                    .map(|a| cell(a.as_ref(), row))
                    .collect::<std::result::Result<Vec<_>, _>>()?,
            );
        }
        if rows.len() == limit {
            break;
        }
    }
    Ok(
        json!({"columns":columns(&out.schema),"rows":rows,"row_count":out.row_count,"truncated_preview":out.row_count>limit,"elapsed_ms":out.elapsed_ms}),
    )
}
fn cell(array: &dyn Array, row: usize) -> std::result::Result<Value, Error> {
    if array.is_null(row) {
        return Ok(Value::Null);
    }
    let value = ScalarValue::try_from_array(array, row)?;
    Ok(match value {
        ScalarValue::Boolean(v) => json!(v),
        ScalarValue::Int8(v) => json!(v),
        ScalarValue::Int16(v) => json!(v),
        ScalarValue::Int32(v) => json!(v),
        ScalarValue::Int64(v) => json!(v),
        ScalarValue::UInt8(v) => json!(v),
        ScalarValue::UInt16(v) => json!(v),
        ScalarValue::UInt32(v) => json!(v),
        ScalarValue::UInt64(v) => json!(v),
        ScalarValue::Float32(v) => json!(v),
        ScalarValue::Float64(v) => json!(v),
        _ => json!(
            array_value_to_string(array, row)
                .map_err(|_| Error::new("encoding", "Cannot format SQL result"))?
        ),
    })
}

pub(crate) fn listing_url(path: &std::path::Path) -> datafusion::error::Result<ListingTableUrl> {
    use std::fmt::Write;
    let path = path.to_string_lossy();
    // Canonical Windows paths have a verbatim prefix whose '?' looks like a glob.
    #[cfg(windows)]
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    }
    .replace('\\', "/");
    // A literal file URI also protects dataset names containing '[', '%' or '#'.
    let mut encoded = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"/:-._~".contains(&b) {
            encoded.push(char::from(b));
        } else {
            let _ = write!(encoded, "%{b:02X}");
        }
    }
    let prefix = if encoded.starts_with("//") {
        "file:"
    } else if encoded.starts_with('/') {
        "file://"
    } else {
        "file:///"
    };
    ListingTableUrl::parse(format!("{prefix}{encoded}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn sql_listing_urls_are_literal() {
        let path = std::env::temp_dir()
            .join("source [2]%#")
            .join("part-000000.parquet");
        let url = super::listing_url(&path).unwrap();
        assert!(url.get_glob().is_none());
        assert_eq!(url.get_url().to_file_path().unwrap(), path);
    }
}

#[cfg(test)]
mod naming_tests {
    use super::*;
    #[test]
    fn identifiers_and_numeric_suffixes() {
        assert_eq!(schema_name("App DB.customers"), "app_db_customers");
        assert_eq!(schema_name("123"), "_123");
        assert_eq!(schema_name(""), "_");
        assert_eq!(schema_name("a-\"b"), "a__b");
        let mut used = BTreeSet::from(["x".to_owned(), "x_2".to_owned()]);
        assert_eq!(unique_name("x".to_owned(), &mut used), "x_3");
    }
}
