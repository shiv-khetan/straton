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
    Noop,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: SourceKind,
    pub credential_id: Option<String>,
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

/// Connector errors must never embed credentials.
#[allow(async_fn_in_trait)]
pub trait Connector: Send + Sync {
    async fn check(&self) -> Result<()>;
    async fn discover(&self) -> Result<Vec<DatasetSchema>>;
    async fn read(
        &self,
        dataset: &str,
        cursor: Option<Cursor>,
    ) -> Result<BoxStream<'_, Result<(RecordBatch, Cursor)>>>;
}
