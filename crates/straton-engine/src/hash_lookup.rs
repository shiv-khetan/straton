//! Optional, generation-bound row-group hints. The normal Parquet predicate remains authoritative.
use crate::{keys, lake_layout::Layout, store};
use anyhow::{Result, ensure};
use datafusion::{
    arrow::datatypes::{DataType, SchemaRef},
    catalog::{Session, TableProvider},
    common::{
        ScalarValue,
        tree_node::{Transformed, TreeNode},
    },
    datasource::{
        listing::ListingTable,
        physical_plan::{FileGroup, FileScanConfig, parquet::ParquetAccessPlan},
        source::DataSourceExec,
    },
    logical_expr::{Expr, Operator, TableProviderFilterPushDown, TableType},
    physical_plan::ExecutionPlan,
};
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

const FILE: &str = "_hash_lookup.bin";
const VERSION: u32 = 1;
const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Status {
    pub enabled: bool,
    pub key_column: Option<String>,
    pub generation: Option<String>,
    pub size_bytes: u64,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            enabled: false,
            key_column: None,
            generation: None,
            size_bytes: 0,
            reason: "Requires 100 equality observations on one dominant key with less than 1% output, then a publish or relayout.".into(),
            checksum: None,
        }
    }
}
// Aggregate evidence only: >=100 equality filters, >=80% of equality traffic on
// one column, >=10,000 decoded rows and <1% returned. Never build during reads.
pub async fn choose(pool: &SqlitePool, ids: &[String]) -> Result<Option<String>> {
    let rows = sqlx::query("SELECT column,SUM(count) AS n,SUM(rows_scanned) AS scanned,SUM(rows_returned) AS returned FROM query_stats WHERE dataset_id IN (SELECT value FROM json_each(?)) AND role='filter' AND op='equality' GROUP BY column ORDER BY n DESC,column")
        .bind(serde_json::to_string(ids)?).fetch_all(pool).await?;
    let total: i64 = rows.iter().map(|r| r.get::<i64, _>("n")).sum();
    Ok(rows
        .first()
        .filter(|r| {
            let n: i64 = r.get("n");
            let scanned: i64 = r.get("scanned");
            let returned: i64 = r.get("returned");
            n >= 100
                && n as f64 >= total as f64 * 0.8
                && scanned >= 10_000
                && returned >= 0
                && (returned as f64) < scanned as f64 * 0.01
        })
        .map(|r| r.get("column")))
}
#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Binding {
    name: String,
    bytes: u64,
    footer: String,
    groups: usize,
}
#[derive(Serialize, Deserialize)]
struct Index {
    version: u32,
    snapshot: String,
    generation: String,
    schema: String,
    key_id: Option<String>,
    column: String,
    hash_key: [u8; 32],
    files: Vec<Binding>,
    // A hash can occur in many row groups and files; never store row offsets.
    entries: BTreeMap<String, Vec<(usize, usize)>>,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn snapshot(path: &Path) -> Result<String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow::anyhow!("snapshot name missing"))?;
    Ok(name.strip_prefix(".staging-").unwrap_or(name).into())
}
fn context(snapshot: &str, generation: &str) -> String {
    format!("straton/hash-lookup/v1/{snapshot}/{generation}")
}
fn supported(data_type: &DataType) -> bool {
    matches!(
        data_type,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Utf8
            | DataType::LargeUtf8
            | DataType::Utf8View
    )
}
fn hash(key: &[u8; 32], value: &ScalarValue) -> Option<String> {
    if value.is_null() || !supported(&value.data_type()) {
        return None;
    }
    let value = match value {
        ScalarValue::Utf8(Some(s))
        | ScalarValue::LargeUtf8(Some(s))
        | ScalarValue::Utf8View(Some(s)) => s.clone(),
        _ => value.to_string(),
    };
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), value.as_bytes());
    Some(tag.as_ref().iter().map(|b| format!("{b:02x}")).collect())
}
fn parquet_files(path: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|e| e == "parquet") {
            ensure!(
                entry.file_type()?.is_file() && !entry.file_type()?.is_symlink(),
                "invalid lookup file"
            );
            files.push(entry.path());
        }
    }
    files.sort();
    Ok(files)
}
fn binding(path: &Path, groups: usize) -> Result<Binding> {
    let mut file = File::open(path)?;
    let bytes = file.metadata()?.len();
    ensure!(bytes >= 8, "invalid Parquet length");
    file.seek(SeekFrom::End(-8))?;
    let mut trailer = [0; 8];
    file.read_exact(&mut trailer)?;
    let length = u32::from_le_bytes(trailer[..4].try_into()?) as u64 + 8;
    ensure!(
        length <= bytes && length <= 16 * 1024 * 1024,
        "unsupported Parquet footer"
    );
    file.seek(SeekFrom::End(-(length as i64)))?;
    let mut footer = vec![0; length as usize];
    file.read_exact(&mut footer)?;
    Ok(Binding {
        name: path.file_name().unwrap().to_string_lossy().into(),
        bytes,
        footer: digest(&footer),
        groups,
    })
}
pub fn build(
    path: &Path,
    target: &Path,
    key: Option<&keys::DataKey>,
    column: &str,
) -> Result<Status> {
    let generation = store::id();
    let mut index = Index {
        version: VERSION,
        snapshot: snapshot(path)?,
        generation: generation.clone(),
        schema: String::new(),
        key_id: key.map(|k| k.id.clone()),
        column: column.into(),
        hash_key: [0; 32],
        files: vec![],
        entries: BTreeMap::new(),
    };
    SystemRandom::new()
        .fill(&mut index.hash_key)
        .map_err(|_| anyhow::anyhow!("lookup random key unavailable"))?;
    let mut positions = 0;
    for file in parquet_files(target)? {
        let reader = keys::reader(&file, key)?;
        let schema = reader.schema();
        let column_index = schema.index_of(column)?;
        ensure!(
            supported(schema.field(column_index).data_type()),
            "unsupported lookup key type"
        );
        let fingerprint = digest(format!("{schema:?}").as_bytes());
        if index.schema.is_empty() {
            index.schema = fingerprint.clone();
        }
        ensure!(
            index.schema == fingerprint,
            "lookup requires identical file schemas"
        );
        let groups = reader.metadata().num_row_groups();
        let file_id = index.files.len();
        index.files.push(binding(&file, groups)?);
        for group in 0..groups {
            let reader = keys::reader(&file, key)?;
            let mask = straton_connectors::parquet::arrow::ProjectionMask::roots(
                reader.parquet_schema(),
                [column_index],
            );
            let reader = reader
                .with_row_groups(vec![group])
                .with_projection(mask)
                .build()?;
            for batch in reader {
                let batch = batch?;
                for row in 0..batch.num_rows() {
                    if let Some(hash) = hash(
                        &index.hash_key,
                        &ScalarValue::try_from_array(batch.column(0), row)?,
                    ) {
                        let groups = index.entries.entry(hash).or_default();
                        if groups.last() != Some(&(file_id, group)) {
                            groups.push((file_id, group));
                            positions += 1;
                        }
                    }
                    // Bound construction memory as well as the persisted representation.
                    ensure!(
                        index.entries.len() <= 32_768 && positions <= 262_144,
                        "lookup exceeds construction budget"
                    );
                }
            }
        }
    }
    let groups: usize = index.files.iter().map(|f| f.groups).sum();
    // Measured storage/pruning benefit: <=20% of Parquet bytes and <=25% of
    // groups per distinct hash on average. Small or scattered keys stay scans.
    ensure!(
        groups >= 4 && !index.entries.is_empty() && positions * 4 <= groups * index.entries.len(),
        "lookup would not reduce enough row groups"
    );
    let body = serde_json::to_vec(&index)?;
    let body = if let Some(key) = key {
        key.seal_lookup(&context(&index.snapshot, &generation), &body)?
    } else {
        body
    };
    let parquet_bytes: u64 = index.files.iter().map(|f| f.bytes).sum();
    ensure!(
        body.len() <= MAX_BYTES && body.len() as u64 <= parquet_bytes / 5,
        "lookup storage cost exceeds 20% of Parquet bytes"
    );
    let mut file = File::create(target.join(FILE))?;
    file.write_all(&body)?;
    file.sync_all()?;
    Ok(Status { enabled: true, key_column: Some(column.into()), generation: Some(generation), size_bytes: body.len() as u64,
        reason: "Sustained selective equality traffic; measured size <=20% of Parquet and average candidates <=25% of row groups.".into(), checksum: Some(digest(&body)) })
}
fn load(path: &Path, key: Option<&keys::DataKey>, status: &Status) -> Result<Index> {
    ensure!(
        status.enabled && status.size_bytes <= MAX_BYTES as u64,
        "lookup disabled or oversized"
    );
    let file = File::open(path.join(FILE))?;
    ensure!(
        file.metadata()?.len() == status.size_bytes,
        "lookup size mismatch"
    );
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        status.checksum.as_deref() == Some(digest(&bytes).as_str()),
        "lookup checksum mismatch"
    );
    let generation = status
        .generation
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("lookup generation missing"))?;
    let snapshot = snapshot(path)?;
    let bytes = if let Some(key) = key {
        key.open_lookup(&context(&snapshot, generation), &bytes)?
    } else {
        bytes
    };
    let index: Index = serde_json::from_slice(&bytes)?;
    ensure!(
        index.version == VERSION
            && index.snapshot == snapshot
            && index.generation == generation
            && index.key_id.as_deref() == key.map(|k| k.id.as_str())
            && Some(&index.column) == status.key_column.as_ref(),
        "stale or unsupported lookup"
    );
    let files = parquet_files(path)?;
    ensure!(files.len() == index.files.len(), "lookup file set changed");
    for (file, expected) in files.iter().zip(&index.files) {
        let reader = keys::reader(file, key)?;
        ensure!(
            digest(format!("{:?}", reader.schema()).as_bytes()) == index.schema
                && binding(file, reader.metadata().num_row_groups())? == *expected,
            "lookup file generation changed"
        );
    }
    ensure!(
        index.entries.values().all(|groups| groups
            .iter()
            .all(|(f, g)| index.files.get(*f).is_some_and(|file| *g < file.groups))),
        "invalid lookup row group"
    );
    Ok(index)
}
fn warn_once(path: &Path) {
    static WARNED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    if let Ok(mut warned) = WARNED.get_or_init(Mutex::default).lock() {
        // Bound log bookkeeping even when snapshot retention runs for years.
        if warned.len() >= 1024 {
            warned.clear();
        }
        if warned.insert(path.to_owned()) {
            tracing::warn!("hash lookup unavailable or stale; using the normal Parquet scan");
        }
    }
}
pub async fn status(pool: &SqlitePool, path: &Path) -> Status {
    let mut status = match std::fs::read(path.join("_layout.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Layout>(&b).ok())
    {
        Some(layout) => layout.hash_index,
        None => return Status::default(),
    };
    if status.enabled {
        let valid = match keys::snapshot(pool, path).await {
            Ok(key) => load(path, key.as_ref(), &status).is_ok(),
            Err(_) => false,
        };
        if !valid {
            warn_once(path);
            status.enabled = false;
            status.reason = "Sidecar missing, corrupt or stale; queries use the normal Parquet scan. Relayout to rebuild.".into();
        }
    }
    status
}
#[derive(Debug)]
pub struct LookupTable {
    table: ListingTable,
    path: PathBuf,
    pool: SqlitePool,
}
impl LookupTable {
    pub fn new(table: ListingTable, path: PathBuf, pool: SqlitePool) -> Self {
        Self { table, path, pool }
    }
    async fn index(&self) -> Result<Option<Index>> {
        let layout: Layout = match std::fs::read(self.path.join("_layout.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if !layout.hash_index.enabled {
            return Ok(None);
        }
        let key = keys::snapshot(&self.pool, &self.path).await?;
        Ok(Some(load(&self.path, key.as_ref(), &layout.hash_index)?))
    }
}
fn equality<'a>(expr: &'a Expr, column: &str) -> Option<&'a ScalarValue> {
    if let Expr::BinaryExpr(b) = expr {
        if b.op == Operator::And {
            return equality(&b.left, column).or_else(|| equality(&b.right, column));
        }
        if b.op == Operator::Eq {
            for (left, right) in [(&b.left, &b.right), (&b.right, &b.left)] {
                if let (Expr::Column(c), Expr::Literal(value, _)) = (left.as_ref(), right.as_ref())
                    && c.name == column
                {
                    return Some(value);
                }
            }
        }
    }
    None
}
#[async_trait::async_trait]
impl TableProvider for LookupTable {
    fn schema(&self) -> SchemaRef {
        self.table.schema()
    }
    fn table_type(&self) -> TableType {
        self.table.table_type()
    }
    fn supports_filters_pushdown(
        &self,
        filters: &[&Expr],
    ) -> datafusion::common::Result<Vec<TableProviderFilterPushDown>> {
        // Inexact deliberately retains DataFusion's row-by-row predicate, including
        // for hash collisions, limits, projections and unsupported SQL semantics.
        Ok(vec![TableProviderFilterPushDown::Inexact; filters.len()])
    }
    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> datafusion::common::Result<Arc<dyn ExecutionPlan>> {
        let plan = self.table.scan(state, projection, filters, limit).await?;
        let index = match self.index().await {
            Ok(Some(index)) => index,
            Ok(None) => return Ok(plan),
            Err(_) => {
                warn_once(&self.path);
                return Ok(plan);
            }
        };
        let Some(value) = filters.iter().find_map(|e| equality(e, &index.column)) else {
            return Ok(plan);
        };
        let schema = self.schema();
        let Ok(field) = schema.field_with_name(&index.column) else {
            return Ok(plan);
        };
        // Never approximate a cast, collation, float, null or cross-type comparison.
        let same_type = value.data_type() == *field.data_type()
            || (matches!(
                value,
                ScalarValue::Utf8(_) | ScalarValue::Utf8View(_) | ScalarValue::LargeUtf8(_)
            ) && matches!(
                field.data_type(),
                DataType::Utf8 | DataType::Utf8View | DataType::LargeUtf8
            ));
        let Some(hash) = same_type.then(|| hash(&index.hash_key, value)).flatten() else {
            return Ok(plan);
        };
        let candidates = index.entries.get(&hash).cloned().unwrap_or_default();
        let result = plan.clone().transform_up(|node| {
            let Some(scan) = node.downcast_ref::<DataSourceExec>() else {
                return Ok(Transformed::no(node));
            };
            let Some(config) = scan.data_source().downcast_ref::<FileScanConfig>() else {
                return Ok(Transformed::no(node));
            };
            let mut config = config.clone();
            let mut groups = Vec::new();
            for group in &config.file_groups {
                let mut files = Vec::new();
                for file in group.iter() {
                    let name = file.object_meta.location.filename().unwrap_or_default();
                    let Some((id, binding)) =
                        index.files.iter().enumerate().find(|(_, f)| f.name == name)
                    else {
                        return datafusion::common::exec_err!("lookup file not in generation");
                    };
                    let mut access = ParquetAccessPlan::new_none(binding.groups);
                    for (_, group) in candidates.iter().filter(|(f, _)| *f == id) {
                        access.scan(*group);
                    }
                    let mut file = file.clone();
                    file.extensions.insert(access);
                    files.push(file);
                }
                groups.push(FileGroup::new(files));
            }
            config.file_groups = groups;
            Ok(Transformed::yes(
                DataSourceExec::from_data_source(config) as Arc<dyn ExecutionPlan>
            ))
        });
        match result {
            Ok(result) => Ok(result.data),
            Err(_) => {
                warn_once(&self.path);
                Ok(plan)
            }
        }
    }
}
