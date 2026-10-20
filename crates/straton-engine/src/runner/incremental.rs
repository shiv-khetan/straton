use super::{Events, cancelled, checkpoint, lineage, publish_snapshot};
use crate::{catalog, keys, sql, store};
use anyhow::{Result, ensure};
use datafusion::{
    arrow::{
        datatypes::{DataType, Field, Schema},
        record_batch::RecordBatch,
    },
    datasource::listing::{ListingOptions, ListingTable, ListingTableConfig},
    prelude::SessionContext,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use straton_core::{Column, IncrementalRead, IncrementalStyle, OP_COLUMN, ReadOptions, SEQ_COLUMN};

#[derive(Serialize, Deserialize)]
pub(crate) struct Plan {
    source: String,
    dataset: String,
    columns: Vec<Column>,
    keys: Vec<String>,
    watermark_column: String,
    previous_watermark: Option<Value>,
    base: Option<String>,
    mode: String,
    fallback_reason: Option<String>,
    key_diff: bool,
    /// Events-style source: delta carries `_straton_op`/`_straton_seq` and its own watermark.
    #[serde(default)]
    events: bool,
}
#[derive(Serialize, Deserialize)]
struct Stats {
    mode_used: String,
    rows_read: i64,
    rows_inserted: i64,
    rows_updated: i64,
    rows_deleted: i64,
    watermark: Option<Value>,
    fallback_reason: Option<String>,
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn durable_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension("partial");
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(temp, path)?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
fn schema(columns: &[Column]) -> Result<Arc<Schema>> {
    Ok(Arc::new(Schema::new(
        columns
            .iter()
            .map(|c| Ok(Field::new(&c.name, c.data_type.parse()?, c.nullable)))
            .collect::<Result<Vec<_>>>()?,
    )))
}
/// Staged delta schema: events sources append the reserved op/seq columns.
fn delta_schema(plan: &Plan) -> Result<Arc<Schema>> {
    let base = schema(&plan.columns)?;
    if !plan.events {
        return Ok(base);
    }
    let mut fields: Vec<Field> = base.fields().iter().map(|f| f.as_ref().clone()).collect();
    fields.push(Field::new(OP_COLUMN, DataType::Utf8, false));
    fields.push(Field::new(SEQ_COLUMN, DataType::Int64, false));
    Ok(Arc::new(Schema::new(fields)))
}
fn parts(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        if e.file_type()?.is_file() && e.path().extension().is_some_and(|s| s == "parquet") {
            files.push(e.path());
        }
    }
    files.sort();
    Ok(files)
}
async fn snapshot_schema(
    pool: &SqlitePool,
    dir: &Path,
    fallback: &Arc<Schema>,
) -> Result<Arc<Schema>> {
    let key = keys::snapshot(pool, dir).await?;
    if let Some(file) = parts(dir)?.first() {
        Ok(keys::reader(file, key.as_ref())?.schema().clone())
    } else {
        Ok(fallback.clone())
    }
}
async fn register(
    pool: &SqlitePool,
    ctx: &SessionContext,
    name: &str,
    dir: &Path,
    schema: Arc<Schema>,
) -> Result<()> {
    let urls = parts(dir)?
        .iter()
        .map(|p| sql::listing_url(&p.canonicalize()?))
        .collect::<Result<Vec<_>, _>>()?;
    let key = keys::snapshot(pool, dir).await?;
    let opts = ListingOptions::new(Arc::new(keys::format(pool, ctx, key.as_ref())))
        .with_file_extension(".parquet");
    let mut config = ListingTableConfig::new_with_multi_paths(urls);
    // DataFusion requires assigning options directly when an empty delta has no paths.
    config.options = Some(opts);
    let table = ListingTable::try_new(config.with_schema(schema))?;
    ctx.register_table(name, Arc::new(table))?;
    Ok(())
}
async fn count(ctx: &SessionContext, query: &str) -> Result<i64> {
    let batches = ctx.sql(query).await?.collect().await?;
    let array = batches[0]
        .column(0)
        .as_any()
        .downcast_ref::<datafusion::arrow::array::Int64Array>()
        .unwrap();
    Ok(array.value(0))
}
fn join(keys: &[String], left: &str, right: &str) -> String {
    keys.iter()
        .map(|k| format!("{left}.{} = {right}.{}", quote(k), quote(k)))
        .collect::<Vec<_>>()
        .join(" AND ")
}
async fn validate_keys(ctx: &SessionContext, table: &str, keys: &[String]) -> Result<()> {
    let names = keys.iter().map(|k| quote(k)).collect::<Vec<_>>().join(",");
    let nulls = keys
        .iter()
        .map(|k| format!("{} IS NULL", quote(k)))
        .collect::<Vec<_>>()
        .join(" OR ");
    ensure!(
        count(ctx, &format!("SELECT COUNT(*) FROM {table} WHERE {nulls}")).await? == 0,
        "merge keys must be non-null"
    );
    ensure!(count(ctx,&format!("SELECT COUNT(*) FROM (SELECT {names} FROM {table} GROUP BY {names} HAVING COUNT(*)>1) duplicates")).await?==0,"merge keys must be unique");
    Ok(())
}

// The durable plan freezes the base snapshot and settings across crash recovery.
pub(crate) async fn prepare(
    pool: &SqlitePool,
    output: &Path,
    id: &str,
    enabled: bool,
) -> Result<Plan> {
    let staging = output.join(format!(".staging-{id}"));
    std::fs::create_dir_all(staging.join("delta"))?;
    let plan_path = staging.join("sync-plan.json");
    let plan_existed = plan_path.exists();
    let saved: Option<String> =
        sqlx::query_scalar("SELECT cursor FROM run_checkpoints WHERE run_id=?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    ensure!(
        saved.is_none() || plan_existed,
        "checkpoint sync plan is missing"
    );

    let plan: Plan = if plan_existed {
        serde_json::from_slice(&std::fs::read(plan_path)?)?
    } else {
        let row=sqlx::query("SELECT j.*,s.watermark,s.snapshot_run_id FROM jobs j JOIN runs r ON r.job_id=j.id LEFT JOIN job_state s ON s.job_id=j.id WHERE r.id=?").bind(id).fetch_one(pool).await?;
        let source: String = row.get("source_id");
        let dataset: String = row.get("dataset");
        let connector = catalog::connector(pool, &source).await?;
        let ds = connector
            .discover()
            .await?
            .into_iter()
            .find(|d| d.dataset.name == dataset)
            .ok_or_else(|| anyhow::anyhow!("dataset not found"))?;
        let keys: Vec<String> = row
            .get::<Option<String>, _>("key_columns")
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_else(|| {
                ds.columns
                    .iter()
                    .filter(|c| c.primary_key)
                    .map(|c| c.name.clone())
                    .collect()
            });
        ensure!(!keys.is_empty(), "incremental sync requires a merge key");
        let kind: String = sqlx::query_scalar("SELECT kind FROM sources WHERE id=?")
            .bind(&source)
            .fetch_one(pool)
            .await?;
        let style = straton_connectors::incremental_style(&kind);
        let events = matches!(style, IncrementalStyle::Events { .. });
        let watermark_column = if events {
            String::new()
        } else {
            let column: String = row
                .get::<Option<String>, _>("watermark_column")
                .ok_or_else(|| anyhow::anyhow!("watermark column is required"))?;
            ensure!(
                ds.columns
                    .iter()
                    .any(|c| c.name == column && straton_core::eligible_watermark(&c.data_type)),
                "watermark column is missing or no longer has an eligible type"
            );
            column
        };
        ensure!(
            keys.iter().all(|k| ds.columns.iter().any(|c| &c.name == k)),
            "merge key column is missing"
        );
        let snapshot_guard = sql::SNAPSHOTS.read().await;
        let base = match std::fs::read_to_string(output.join("_current")) {
            Ok(s) => {
                ensure!(uuid::Uuid::try_parse(&s).is_ok(), "invalid snapshot id");
                Some(s)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let previous_watermark: Option<Value> = row
            .get::<Option<String>, _>("watermark")
            .map(|s| serde_json::from_str(&s))
            .transpose()?;
        let mut fallback_reason = None;
        if let Some(base) = &base {
            let expected = schema(&ds.columns)?;
            let old = snapshot_schema(pool, &output.join(base), &expected).await?;
            if old
                .fields()
                .iter()
                .map(|f| (f.name(), f.data_type()))
                .ne(expected.fields().iter().map(|f| (f.name(), f.data_type())))
            {
                fallback_reason = Some(
                    "source column names or types differ from the current snapshot".to_owned(),
                );
            } else if row
                .get::<Option<String>, _>("snapshot_run_id")
                .as_ref()
                .is_some_and(|run| run != base)
            {
                fallback_reason = Some("current snapshot was replaced by another job".to_owned());
            }
        }
        drop(snapshot_guard);
        if let (
            IncrementalStyle::Events {
                horizon_secs: Some(h),
            },
            Some(w),
            None,
        ) = (style, previous_watermark.as_ref(), &fallback_reason)
            && w.as_i64()
                .is_none_or(|w| w < chrono::Utc::now().timestamp() - h)
        {
            fallback_reason =
                Some("last sync is older than the source's change-event retention".to_owned());
        }
        let mode = if base.is_some() && previous_watermark.is_some() && fallback_reason.is_none() {
            "incremental"
        } else {
            "full"
        }
        .to_owned();
        let successful: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM runs WHERE job_id=? AND state='succeeded'")
                .bind(row.get::<&str, _>("id"))
                .fetch_one(pool)
                .await?;
        let every: i64 = row.get("key_diff_every_runs");
        let key_diff = mode == "incremental"
            && !events
            && row.get::<&str, _>("delete_detection") == "key_diff"
            && every > 0
            && (successful + 1) % every == 0;
        let mut tx = pool.begin().await?;
        catalog::upsert(&mut tx, &source, &ds).await?;
        tx.commit().await?;
        let plan = Plan {
            source,
            dataset,
            columns: ds.columns,
            keys,
            watermark_column,
            previous_watermark,
            base,
            mode,
            fallback_reason,
            key_diff,
            events,
        };
        durable_json(&plan_path, &plan)?;
        plan
    };
    let key = super::write_key(pool, &staging, id, enabled).await?;
    let encryption = keys::encryption(key.as_ref())?;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE runs SET mode_used=?,fallback_reason=? WHERE id=?")
        .bind(&plan.mode)
        .bind(&plan.fallback_reason)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let Some(reason) = &plan.fallback_reason {
        let recorded: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM audit_log WHERE action='sync.fallback' AND entity_id=?)",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if !recorded {
            store::audit(&mut tx, "sync.fallback", id, reason).await?;
        }
    }
    tx.commit().await?;
    let saved: Value = saved
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(json!({}));
    let mut number: i64 = sqlx::query_scalar("SELECT committed_batches FROM runs WHERE id=?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let delta = staging.join("delta");
    for n in 0..number {
        ensure!(
            delta.join(format!("part-{n:06}.parquet")).is_file(),
            "checkpoint delta part is missing"
        );
    }
    if saved["delta_complete"] == true {
        return Ok(plan);
    }
    // Parts without a checkpoint are uncommitted, including a final file left by a crash.
    for file in parts(&delta)? {
        if file
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("part-"))
            .and_then(|s| s.parse::<i64>().ok())
            .is_some_and(|n| n >= number)
        {
            std::fs::remove_file(file)?;
        }
    }
    let connector = catalog::connector(pool, &plan.source).await?;
    let options = ReadOptions {
        cursor: saved.get("source_cursor").filter(|c| !c.is_null()).cloned(),
        incremental: Some(IncrementalRead {
            watermark_column: plan.watermark_column.clone(),
            lower_bound: if plan.mode == "incremental" {
                plan.previous_watermark.clone()
            } else {
                None
            },
            key_columns: plan.keys.clone(),
        }),
        keys_only: None,
    };
    let dataset = plan.dataset.clone();
    let mut batches = connector.read(&dataset, options).await?;
    let mut last = saved.get("source_cursor").cloned().unwrap_or(Value::Null);
    while let Some(batch) = batches.next().await {
        if cancelled(pool, id).await? {
            return Ok(plan);
        }
        let (batch, cursor) = batch?;
        ensure!(
            batch
                .schema()
                .fields()
                .iter()
                .map(|f| (f.name(), f.data_type()))
                .eq(delta_schema(&plan)?
                    .fields()
                    .iter()
                    .map(|f| (f.name(), f.data_type()))),
            "source schema changed while staging; retry as a new run"
        );
        straton_connectors::write_parquet(
            &delta.join(format!("part-{number:06}.parquet")),
            &batch,
            encryption.clone(),
        )?;
        checkpoint(
            pool,
            id,
            &json!({"source_cursor":cursor,"delta_complete":false}),
        )
        .await?;
        last = cursor;
        number += 1;
    }
    keys::finish(&delta, key.as_ref())?;
    sqlx::query("INSERT INTO run_checkpoints(run_id,cursor,batch_number,updated_at) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at")
        .bind(id).bind(json!({"source_cursor":last,"delta_complete":true}).to_string()).bind(number).bind(store::now()).execute(pool).await?;
    Ok(plan)
}

pub(super) async fn execute(
    pool: &SqlitePool,
    events: &Events,
    output: &Path,
    id: &str,
    enabled: bool,
) -> Result<()> {
    if output.join(id).is_dir() {
        return publish_snapshot(pool, events, output, id).await;
    }
    let plan = prepare(pool, output, id, enabled).await?;
    // Same-target runs are serialized; take the global reader lock only for merging.
    let snapshot_guard = sql::SNAPSHOTS.read().await;
    if cancelled(pool, id).await? {
        return Ok(());
    }
    let staging = output.join(format!(".staging-{id}"));
    let key = super::write_key(pool, &staging, id, enabled).await?;
    let encryption = keys::encryption(key.as_ref())?;
    let expected = schema(&plan.columns)?;
    let ctx = SessionContext::new();
    register(
        pool,
        &ctx,
        "delta",
        &staging.join("delta"),
        delta_schema(&plan)?,
    )
    .await?;
    let rows_read = count(&ctx, "SELECT COUNT(*) FROM delta").await?;
    // `keyed`: one row per key (anti-joined against the snapshot); `upserts`: rows to add.
    let (keyed, upserts) = if plan.events {
        let cols = plan
            .columns
            .iter()
            .map(|c| quote(&c.name))
            .collect::<Vec<_>>()
            .join(",");
        let keys = plan
            .keys
            .iter()
            .map(|k| quote(k))
            .collect::<Vec<_>>()
            .join(",");
        // The newest event per key wins; a delete hides older upserts of the same key.
        let latest = format!(
            "SELECT {cols},{op} FROM (SELECT *,row_number() OVER (PARTITION BY {keys} ORDER BY {seq} DESC) AS _straton_rn FROM delta) WHERE _straton_rn=1",
            op = quote(OP_COLUMN),
            seq = quote(SEQ_COLUMN)
        );
        ctx.register_table("latest", ctx.sql(&latest).await?.into_view())?;
        let upserts = format!(
            "SELECT {cols} FROM latest WHERE {}='upsert'",
            quote(OP_COLUMN)
        );
        ctx.register_table("upserts", ctx.sql(&upserts).await?.into_view())?;
        ("latest", "upserts")
    } else {
        ("delta", "delta")
    };
    validate_keys(&ctx, keyed, &plan.keys).await?;
    let mut updated = 0;
    let mut deleted = 0;
    let merge = if plan.mode == "incremental" {
        let base = plan.base.as_ref().unwrap();
        let current = std::fs::read_to_string(output.join("_current"))?;
        ensure!(
            &current == base,
            "base snapshot changed before merge; start a new run"
        );
        register(
            pool,
            &ctx,
            "current_snapshot",
            &output.join(base),
            expected.clone(),
        )
        .await?;
        let on = join(&plan.keys, "c", "d");
        updated = count(
            &ctx,
            &format!("SELECT COUNT(*) FROM {upserts} d LEFT SEMI JOIN current_snapshot c ON {on}"),
        )
        .await?;
        if plan.events {
            deleted = count(&ctx, &format!("SELECT COUNT(*) FROM latest d LEFT SEMI JOIN current_snapshot c ON {on} WHERE d.{}='delete'", quote(OP_COLUMN))).await?;
        }
        format!(
            "SELECT c.* FROM current_snapshot c LEFT ANTI JOIN {keyed} d ON {on} UNION ALL SELECT * FROM {upserts}"
        )
    } else {
        format!("SELECT * FROM {upserts}")
    };
    let merged = ctx.sql(&merge).await?;
    ctx.register_table("merged", merged.into_view())?;
    let mut rows_read = rows_read;
    let query = if plan.key_diff {
        let keys_dir = staging.join("keys");
        std::fs::create_dir_all(&keys_dir)?;
        if !keys_dir.join("complete.json").exists() {
            for file in parts(&keys_dir)? {
                std::fs::remove_file(file)?;
            }
            let connector = catalog::connector(pool, &plan.source).await?;
            let mut keys = connector
                .read(
                    &plan.dataset,
                    ReadOptions {
                        keys_only: Some(plan.keys.clone()),
                        ..Default::default()
                    },
                )
                .await?;
            let mut n = 0;
            while let Some(batch) = keys.next().await {
                if cancelled(pool, id).await? {
                    return Ok(());
                }
                let (batch, _) = batch?;
                straton_connectors::write_parquet(
                    &keys_dir.join(format!("part-{n:06}.parquet")),
                    &batch,
                    encryption.clone(),
                )?;
                n += 1;
            }
            keys::finish(&keys_dir, key.as_ref())?;
            durable_json(&keys_dir.join("complete.json"), &n)?;
        }
        let key_parts: i64 =
            serde_json::from_slice(&std::fs::read(keys_dir.join("complete.json"))?)?;
        for n in 0..key_parts {
            ensure!(
                keys_dir.join(format!("part-{n:06}.parquet")).is_file(),
                "completed key-scan part is missing"
            );
        }
        let keys_columns = plan
            .keys
            .iter()
            .map(|k| plan.columns.iter().find(|c| &c.name == k).unwrap().clone())
            .collect::<Vec<_>>();
        register(pool, &ctx, "source_keys", &keys_dir, schema(&keys_columns)?).await?;
        validate_keys(&ctx, "source_keys", &plan.keys).await?;
        rows_read += count(&ctx, "SELECT COUNT(*) FROM source_keys").await?;
        let on = join(&plan.keys, "m", "k");
        deleted = count(
            &ctx,
            &format!("SELECT COUNT(*) FROM merged m LEFT ANTI JOIN source_keys k ON {on}"),
        )
        .await?;
        format!("SELECT m.* FROM merged m LEFT SEMI JOIN source_keys k ON {on}")
    } else {
        "SELECT * FROM merged".to_owned()
    };
    // Keyset order puts the source-native maximum first in the final cursor; retain
    // its original temporal encoding so SQLite's inclusive bound round-trips exactly.
    let saved: String = sqlx::query_scalar("SELECT cursor FROM run_checkpoints WHERE run_id=?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let saved: Value = serde_json::from_str(&saved)?;
    let watermark = if plan.events {
        // Events sources report their own watermark (newest change seen, or a full load's start).
        Some(saved["source_cursor"]["watermark"].clone())
            .filter(|w| !w.is_null())
            .or(plan.previous_watermark.clone())
    } else if count(&ctx, "SELECT COUNT(*) FROM delta").await? == 0 {
        if plan.mode == "incremental" {
            plan.previous_watermark.clone()
        } else {
            None
        }
    } else {
        Some(saved["source_cursor"][0].clone())
    };
    // Merge output is disposable: a recovered run always recomputes it from durable delta parts.
    for file in parts(&staging)? {
        std::fs::remove_file(file)?;
    }
    let mut stream = ctx.sql(&query).await?.execute_stream().await?;
    let mut n = 0;
    while let Some(batch) = stream.next().await {
        if cancelled(pool, id).await? {
            return Ok(());
        }
        straton_connectors::write_parquet(
            &staging.join(format!("part-{n:06}.parquet")),
            &batch?,
            encryption.clone(),
        )?;
        n += 1;
    }
    if n == 0 {
        straton_connectors::write_parquet(
            &staging.join("part-000000.parquet"),
            &RecordBatch::new_empty(expected),
            encryption.clone(),
        )?;
    }
    let stats = Stats {
        mode_used: plan.mode,
        rows_read,
        rows_inserted: count(&ctx, &format!("SELECT COUNT(*) FROM {upserts}")).await? - updated,
        rows_updated: updated,
        rows_deleted: deleted,
        watermark,
        fallback_reason: plan.fallback_reason,
    };
    durable_json(&staging.join("sync-result.json"), &stats)?;
    keys::finish(&staging, key.as_ref())?;
    lineage(pool, &plan.source, &plan.dataset).await?;
    drop(snapshot_guard);
    publish_snapshot(pool, events, output, id).await
}

pub(super) async fn publish_state(
    tx: &mut Transaction<'_, Sqlite>,
    snapshot: &Path,
    id: &str,
    row_count: i64,
) -> Result<()> {
    let result = snapshot.join("sync-result.json");
    if result.exists() {
        let stats: Stats = serde_json::from_slice(&std::fs::read(result)?)?;
        sqlx::query("INSERT INTO job_state(job_id,watermark,snapshot_run_id,updated_at) SELECT job_id,?,?,? FROM runs WHERE id=? ON CONFLICT(job_id) DO UPDATE SET watermark=excluded.watermark,snapshot_run_id=excluded.snapshot_run_id,updated_at=excluded.updated_at")
            .bind(stats.watermark.map(|v|v.to_string())).bind(id).bind(store::now()).bind(id).execute(&mut **tx).await?;
        sqlx::query("UPDATE runs SET mode_used=?,rows_read=?,rows_inserted=?,rows_updated=?,rows_deleted=?,fallback_reason=? WHERE id=?")
            .bind(stats.mode_used).bind(stats.rows_read).bind(stats.rows_inserted).bind(stats.rows_updated).bind(stats.rows_deleted).bind(&stats.fallback_reason).bind(id).execute(&mut **tx).await?;
    } else {
        sqlx::query("UPDATE runs SET mode_used='full',rows_read=?,rows_inserted=? WHERE id=?")
            .bind(row_count)
            .bind(row_count)
            .bind(id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}
