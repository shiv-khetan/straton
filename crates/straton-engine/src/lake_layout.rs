//! Layouts are advisory until a snapshot is published or an admin requests relayout.
use crate::{keys, store};
use anyhow::{Result, ensure};
use datafusion::{
    arrow::{array::Array, record_batch::RecordBatch, util::display::array_value_to_string},
    common::Column,
    datasource::listing::{ListingOptions, ListingTable, ListingTableConfig},
    execution::{
        disk_manager::{DiskManagerBuilder, DiskManagerMode},
        memory_pool::GreedyMemoryPool,
        runtime_env::RuntimeEnvBuilder,
    },
    logical_expr::Expr,
    prelude::{SessionConfig, SessionContext},
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};
use straton_connectors::parquet::{
    arrow::ArrowWriter,
    file::properties::{EnabledStatistics, WriterProperties},
    schema::types::ColumnPath,
};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Layout {
    pub sort_column: Option<String>,
    pub bloom_columns: Vec<String>,
    pub row_group_size: usize,
    pub reason: String,
}
pub fn choose(counts: &[(String, String, String, i64)]) -> Layout {
    let mut scores = BTreeMap::<String, i64>::new();
    for (c, role, op, n) in counts {
        if (role == "filter" && ["equality", "range"].contains(&op.as_str())) || role == "join_key"
        {
            *scores.entry(c.clone()).or_default() += n;
        }
    }
    let total: i64 = scores.values().sum();
    let best = scores
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)));
    let sort_column = best
        .filter(|(_, n)| *n >= 5 && *n as f64 >= total as f64 * 0.6)
        .map(|(c, _)| c);
    let reason=sort_column.as_ref().map(|c|format!("{c} accounts for at least 60% of equality, range and join usage (at least 5 observations)."))
 .unwrap_or_else(||"No dominant key yet; page statistics and 65,536-row groups support pruning.".into());
    Layout {
        sort_column,
        bloom_columns: vec![],
        row_group_size: 65_536,
        reason,
    }
}
pub async fn decision(pool: &SqlitePool, ids: &[String]) -> Result<(Layout, Vec<String>)> {
    let rows=sqlx::query("SELECT column,role,op,SUM(count) AS n FROM query_stats WHERE dataset_id IN (SELECT value FROM json_each(?)) GROUP BY column,role,op")
 .bind(serde_json::to_string(ids)?).fetch_all(pool).await?;
    let counts: Vec<_> = rows
        .iter()
        .map(|r| (r.get("column"), r.get("role"), r.get("op"), r.get("n")))
        .collect();
    let layout = choose(&counts);
    let bloom = counts
        .iter()
        .filter(|(_, role, op, n)| {
            *n >= 5 && (role == "join_key" || (role == "filter" && op == "equality"))
        })
        .map(|(column, _, _, _)| column.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok((layout, bloom))
}
fn backup(path: &Path) -> Result<PathBuf> {
    Ok(path.with_file_name(format!(
        ".layout-backup-{}",
        path.file_name()
            .ok_or_else(|| anyhow::anyhow!("snapshot name missing"))?
            .to_string_lossy()
    )))
}
// A crash between the two directory renames restores the complete old generation.
pub fn recover(path: &Path) -> Result<()> {
    let saved = backup(path)?;
    if saved.is_dir() && !path.exists() {
        std::fs::rename(&saved, path)?;
    }
    Ok(())
}
pub fn recover_all(data_dir: &Path) -> Result<()> {
    let root = data_dir.join("data");
    if !root.is_dir() {
        return Ok(());
    }
    for source in std::fs::read_dir(root)? {
        let source = source?;
        if !source.file_type()?.is_dir() {
            continue;
        }
        for dataset in std::fs::read_dir(source.path())? {
            let dataset = dataset?;
            if !dataset.file_type()?.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(dataset.path())? {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if let Some(original) = name.strip_prefix(".layout-backup-")
                    && uuid::Uuid::parse_str(original.strip_prefix(".staging-").unwrap_or(original))
                        .is_ok()
                {
                    recover(&dataset.path().join(original))?;
                }
            }
        }
    }
    Ok(())
}
fn remove_child(path: &Path) -> Result<()> {
    if path.exists() {
        let resolved = path.canonicalize()?;
        ensure!(
            resolved.parent() == Some(path.parent().unwrap().canonicalize()?.as_path()),
            "layout directory escapes snapshot parent"
        );
        std::fs::remove_dir_all(resolved)?;
    }
    Ok(())
}
fn copy_metadata(from: &Path, to: &Path) -> Result<()> {
    copy_directory(from, to, true)
}
fn copy_directory(from: &Path, to: &Path, root: bool) -> Result<()> {
    for e in std::fs::read_dir(from)? {
        let e = e?;
        ensure!(!e.file_type()?.is_symlink(), "snapshot contains a symlink");
        let dst = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            std::fs::create_dir_all(&dst)?;
            copy_directory(&e.path(), &dst, false)?;
        } else if !root
            || (e.path().extension().is_none_or(|e| e != "parquet")
                && e.file_name() != "_layout.json")
        {
            std::fs::copy(e.path(), dst)?;
        }
    }
    Ok(())
}
fn high_cardinality(batch: &RecordBatch, column: &str) -> bool {
    let Ok(i) = batch.schema().index_of(column) else {
        return false;
    };
    let a = batch.column(i);
    if a.data_type().is_nested()
        || matches!(
            a.data_type(),
            datafusion::arrow::datatypes::DataType::Boolean
        )
    {
        return false;
    }
    let n = a.len().min(8192);
    let mut unique = HashSet::new();
    let mut valid = 0;
    for i in 0..n {
        if !a.is_null(i) {
            valid += 1;
            if let Ok(v) = array_value_to_string(a.as_ref(), i) {
                unique.insert(v);
            }
        }
    }
    unique.len() >= 128 && unique.len() * 10 >= valid
}
pub async fn rewrite(
    pool: &SqlitePool,
    path: &Path,
    key: Option<&keys::DataKey>,
    mut layout: Layout,
    bloom: &[String],
) -> Result<Layout> {
    recover(path)?;
    let saved = backup(path)?;
    remove_child(&saved)?;
    let temporary = path.with_file_name(format!(
        ".layout-new-{}",
        path.file_name().unwrap().to_string_lossy()
    ));
    remove_child(&temporary)?;
    std::fs::create_dir(&temporary)?;
    let work = async {
        copy_metadata(path, &temporary)?;
        let mut runtime = RuntimeEnvBuilder::new();
        if key.is_some() {
            runtime = runtime.with_disk_manager_builder(
                DiskManagerBuilder::default().with_mode(DiskManagerMode::Disabled),
            );
        }
        let runtime = runtime
            .with_memory_pool(Arc::new(GreedyMemoryPool::new(256 * 1024 * 1024)))
            .build_arc()?;
        let ctx = SessionContext::new_with_config_rt(
            SessionConfig::new().with_target_partitions(1),
            runtime,
        );
        let entries = std::fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        let urls = entries
            .into_iter()
            .filter(|e| e.path().extension().is_some_and(|e| e == "parquet"))
            // listing_url needs an absolute path; the data directory may be configured relative.
            .map(|e| {
                let path = std::fs::canonicalize(e.path())
                    .map_err(|e| datafusion::error::DataFusionError::External(Box::new(e)))?;
                crate::sql::listing_url(&path)
            })
            .collect::<datafusion::common::Result<Vec<_>>>()?;
        if !urls.is_empty() {
            let config = ListingTableConfig::new_with_multi_paths(urls)
                .with_listing_options(
                    ListingOptions::new(Arc::new(keys::format(pool, &ctx, key)))
                        .with_file_extension(".parquet"),
                )
                .infer_schema(&ctx.state())
                .await?;
            let mut frame = ctx.read_table(Arc::new(ListingTable::try_new(config)?))?;
            let schema = Arc::new(frame.schema().as_arrow().clone());
            if layout
                .sort_column
                .as_ref()
                .is_some_and(|c| schema.index_of(c).is_err())
            {
                layout.sort_column = None;
                layout.reason = "Dominant key no longer exists; using page statistics.".into();
            }
            // Sample before sorting so clustering does not bias cardinality downwards.
            let candidates: Vec<_> = bloom
                .iter()
                .filter(|c| schema.index_of(c).is_ok())
                .collect();
            if !candidates.is_empty() {
                let expressions = candidates
                    .iter()
                    .map(|c| Expr::Column(Column::from_name(*c)))
                    .collect::<Vec<_>>();
                let sample = frame
                    .clone()
                    .select(expressions)?
                    .limit(0, Some(8192))?
                    .collect()
                    .await?;
                if let Some(first) = sample.first() {
                    let sample =
                        datafusion::arrow::compute::concat_batches(&first.schema(), &sample)?;
                    for c in candidates {
                        if high_cardinality(&sample, c) {
                            layout.bloom_columns.push(c.clone());
                        }
                    }
                }
            }
            if let Some(c) = &layout.sort_column {
                frame = frame.sort(vec![Expr::Column(Column::from_name(c)).sort(true, true)])?;
            }
            let mut properties = WriterProperties::builder()
                .set_max_row_group_row_count(Some(layout.row_group_size))
                .set_statistics_enabled(EnabledStatistics::Page);
            for c in &layout.bloom_columns {
                properties = properties
                    .set_column_bloom_filter_enabled(ColumnPath::from(c.as_str()), true)
                    .set_column_bloom_filter_fpp(ColumnPath::from(c.as_str()), 0.01);
            }
            if let Some(encryption) = keys::encryption(key)? {
                properties = properties.with_file_encryption_properties(encryption);
            }
            let mut writer = ArrowWriter::try_new(
                File::create(temporary.join("part-000000.parquet"))?,
                schema,
                Some(properties.build()),
            )?;
            let mut stream = frame.execute_stream().await?;
            while let Some(batch) = stream.next().await {
                writer.write(&batch?)?;
            }
            let file = writer.into_inner()?;
            file.sync_all()?;
        }
        let manifest = File::create(temporary.join("_layout.json"))?;
        serde_json::to_writer(&manifest, &layout)?;
        manifest.sync_all()?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(e) = work {
        remove_child(&temporary)?;
        return Err(e);
    }
    std::fs::rename(path, &saved)?;
    if let Err(e) = std::fs::rename(&temporary, path) {
        std::fs::rename(&saved, path)?;
        remove_child(&temporary)?;
        return Err(e.into());
    }
    #[cfg(unix)]
    File::open(path.parent().unwrap())?.sync_all()?;
    if remove_child(&saved).is_err() {
        tracing::warn!("old lake layout cleanup deferred");
    }
    // Recovery retains the old generation until the complete new generation is in place.
    Ok(layout)
}
pub async fn persist(
    tx: &mut Transaction<'_, Sqlite>,
    ids: &[String],
    layout: &Layout,
) -> Result<()> {
    for id in ids {
        sqlx::query("INSERT INTO dataset_layout(dataset_id,sort_column,bloom_columns,row_group_size,reason,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET sort_column=excluded.sort_column,bloom_columns=excluded.bloom_columns,row_group_size=excluded.row_group_size,reason=excluded.reason,updated_at=excluded.updated_at")
 .bind(id).bind(&layout.sort_column).bind(serde_json::to_string(&layout.bloom_columns)?).bind(layout.row_group_size as i64).bind(&layout.reason).bind(store::now()).execute(&mut **tx).await?;
    }
    Ok(())
}
pub async fn publish(
    pool: &SqlitePool,
    path: &Path,
    key: Option<&keys::DataKey>,
    run: &str,
) -> Result<Layout> {
    let ids:Vec<String>=sqlx::query_scalar("SELECT d.id FROM datasets d JOIN jobs j ON (d.source_id=j.source_id AND d.name=j.dataset) OR (d.source_id='straton-local-lake' AND d.name=j.source_id || '/' || j.dataset) JOIN runs r ON r.job_id=j.id WHERE r.id=?").bind(run).fetch_all(pool).await?;
    let (layout, bloom) = decision(pool, &ids).await?;
    if layout.sort_column.is_none() {
        return Ok(layout);
    }
    rewrite(pool, path, key, layout, &bloom).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn layout_needs_enough_dominant_observations() {
        let counts = vec![
            ("id".into(), "join_key".into(), "equality".into(), 5),
            ("date".into(), "filter".into(), "range".into(), 2),
        ];
        assert_eq!(choose(&counts).sort_column.as_deref(), Some("id"));
        assert!(choose(&counts[..0]).sort_column.is_none());
        let tied = vec![
            ("a".into(), "filter".into(), "equality".into(), 5),
            ("b".into(), "filter".into(), "range".into(), 5),
        ];
        assert!(choose(&tied).sort_column.is_none());
    }
}
