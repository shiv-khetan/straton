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
    ) || data_type.starts_with("Timestamp(")
}

pub type Batches<'a> = BoxStream<'a, Result<(RecordBatch, Cursor)>>;

/// Connector errors must never embed credentials.
pub trait Connector: Send + Sync {
    fn check(&self) -> futures::future::BoxFuture<'_, Result<()>>;
    fn discover(&self) -> futures::future::BoxFuture<'_, Result<Vec<DatasetSchema>>>;
    fn read<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> futures::future::BoxFuture<'a, Result<Batches<'a>>>;
}
