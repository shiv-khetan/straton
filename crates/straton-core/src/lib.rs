use arrow::record_batch::RecordBatch;
use chrono::{DateTime, Utc};
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("connector: {0}")]
    Connector(String),
    #[error("invalid input: {0}")]
    Invalid(String),
}
pub type Result<T> = std::result::Result<T, Error>;
pub type Cursor = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Postgres,
    #[serde(rename = "sqlserver")]
    Sqlserver,
    Sqlite,
    Csv,
    External,
    Parquet,
    Noop,
    Stripe,
    Salesforce,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub credential_id: Option<String>,
    #[serde(default)]
    pub config: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dataset {
    #[serde(default)]
    pub id: String,
    pub source_id: String,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    #[serde(default)]
    pub id: String,
    pub dataset_id: String,
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationshipKind {
    DeclaredFk,
    Inferred,
    Manual,
    Lineage,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Relationship {
    #[serde(default)]
    pub id: String,
    pub from_dataset: String,
    pub from_cols: Vec<String>,
    pub to_dataset: String,
    pub to_cols: Vec<String>,
    pub kind: RelationshipKind,
    pub confidence: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetSchema {
    pub dataset: Dataset,
    pub columns: Vec<Column>,
    pub relationships: Vec<Relationship>,
    #[serde(default)]
    pub metadata: DatasetMetadata,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DatasetMetadata {
    #[serde(default)]
    pub is_view: bool,
    pub definition: Option<String>,
    pub approximate_rows: Option<i64>,
    #[serde(default)]
    pub indexes: Vec<DatasetIndex>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub clustered: bool,
    pub kind: String,
    pub unique_constraint: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlserverConfig {
    pub host: String,
    #[serde(default = "sqlserver_port")]
    pub port: u16,
    pub instance: Option<String>,
    pub database: String,
    pub auth: SqlserverAuth,
    pub username: Option<String>,
    #[serde(default = "enabled")]
    pub encrypt: bool,
    #[serde(default)]
    pub trust_server_certificate: bool,
    #[serde(default = "sqlserver_batch_size")]
    pub batch_size: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SqlserverAuth {
    Windows,
    Sql,
}
fn sqlserver_port() -> u16 {
    1433
}
fn sqlserver_batch_size() -> usize {
    10_000
}
fn enabled() -> bool {
    true
}
impl SqlserverConfig {
    pub fn validate(&self) -> Result<()> {
        if self.host.trim().is_empty()
            || self.database.trim().is_empty()
            || self.port == 0
            || self.batch_size == 0
            || self.batch_size > i32::MAX as usize
            || self.instance.as_ref().is_some_and(|s| s.trim().is_empty())
        {
            return Err(Error::Invalid("invalid SQL Server configuration".into()));
        }
        if self.auth == SqlserverAuth::Sql
            && self.username.as_ref().is_none_or(|s| s.trim().is_empty())
        {
            return Err(Error::Invalid(
                "SQL authentication requires username".into(),
            ));
        }
        if self.auth == SqlserverAuth::Windows && self.username.is_some() {
            return Err(Error::Invalid(
                "Windows authentication uses the engine account".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Job {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub source_id: String,
    pub dataset: String,
    pub cron: Option<String>,
    pub enabled: bool,
    #[serde(default = "full_mode")]
    pub mode: String,
    pub watermark_column: Option<String>,
    pub key_columns: Option<Vec<String>>,
    #[serde(default = "no_deletes")]
    pub delete_detection: String,
    #[serde(default)]
    pub key_diff_every_runs: u32,
}
fn full_mode() -> String {
    "full".into()
}
fn no_deletes() -> String {
    "none".into()
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Interrupted,
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    #[serde(default)]
    pub id: String,
    pub job_id: String,
    pub state: RunState,
    pub attempt: u32,
    pub available_at: DateTime<Utc>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    pub cursor: Option<Cursor>,
    pub incremental: Option<IncrementalRead>,
    /// Project only these keys, for a full-source delete check.
    pub keys_only: Option<Vec<String>>,
}
/// How a connector finds changes between runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncrementalStyle {
    /// Delta = rows whose watermark column is >= the last watermark.
    Column,
    /// The connector reports its own watermark and emits upserts and deletes.
    /// A watermark older than `horizon_secs` forces a full refresh.
    Events {
        horizon_secs: Option<i64>,
    },
    None,
}
/// Reserved delta columns for `Events` connectors; never stored in snapshots.
pub const OP_COLUMN: &str = "_straton_op";
pub const SEQ_COLUMN: &str = "_straton_seq";

#[derive(Debug, Clone)]
pub struct IncrementalRead {
    /// Ignored by `Events` connectors.
    pub watermark_column: String,
    pub lower_bound: Option<serde_json::Value>,
    pub key_columns: Vec<String>,
}
pub fn eligible_watermark(data_type: &str) -> bool {
    matches!(
        data_type,
        "Int8"
            | "Int16"
            | "Int32"
            | "Int64"
            | "UInt8"
            | "UInt16"
            | "UInt32"
            | "UInt64"
            | "Date32"
            | "Date64"
            | "FixedSizeBinary(8)"
    ) || data_type.starts_with("Timestamp(")
}

pub type Batches<'a> = BoxStream<'a, Result<(RecordBatch, Cursor)>>;

/// Connector errors must never embed credentials.
pub trait Connector: Send + Sync {
    /// Read-only advisor metadata; excludes sampled values and query text.
    fn advisor_metadata(&self) -> futures::future::BoxFuture<'_, Result<serde_json::Value>> {
        Box::pin(async { Err(Error::Invalid("source advisor is not supported".into())) })
    }
    /// Only the audited approval endpoint may call this method.
    fn advisor_execute<'a>(&'a self, _ddl: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(async { Err(Error::Invalid("advisor writes are disabled".into())) })
    }
    fn check(&self) -> futures::future::BoxFuture<'_, Result<()>>;
    fn discover(&self) -> futures::future::BoxFuture<'_, Result<Vec<DatasetSchema>>>;
    fn read<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> futures::future::BoxFuture<'a, Result<Batches<'a>>>;
}
