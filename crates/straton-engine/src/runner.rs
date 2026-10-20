use crate::{backup::Backups, store};
use anyhow::{Result, ensure};
use futures::StreamExt;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::{future::Future, io::Write, path::Path, sync::Arc, time::Duration};

use tokio::{
    sync::{Semaphore, broadcast},
    task::JoinSet,
};

pub type Events = broadcast::Sender<Value>;
pub fn event(events: &Events, id: &str, state: &str) {
    let _ = events.send(json!({"type":"run.state", "id":id, "state":state}));
}
pub async fn state(
    pool: &SqlitePool,
    events: &Events,
    id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let actual: String = sqlx::query_scalar("UPDATE runs SET state=CASE WHEN ?1='succeeded' AND cancel_requested=1 THEN 'cancelled' ELSE ?1 END,error=?2,updated_at=?3 WHERE id=?4 RETURNING state")
        .bind(state)
        .bind(error)
        .bind(store::now())
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    store::audit(&mut tx, &format!("run.{actual}"), id, error.unwrap_or("")).await?;
    tx.commit().await?;
    event(events, id, &actual);
    Ok(())
}
pub async fn recover(pool: &SqlitePool, events: &Events, max_attempts: u32) -> Result<()> {
    let orphans =
        sqlx::query("SELECT id,attempt FROM runs WHERE state IN ('running','interrupted')")
            .fetch_all(pool)
            .await?;
    for row in orphans {
        let id: String = row.get("id");
        let attempt: u32 = row.get("attempt");
        state(
            pool,
            events,
            &id,
            "interrupted",
            Some("engine stopped during run"),
        )
        .await?;
        let cancelled: bool = sqlx::query_scalar("SELECT cancel_requested FROM runs WHERE id=?")
            .bind(&id)
            .fetch_one(pool)
            .await?;
        if cancelled {
            state(pool, events, &id, "cancelled", None).await?;
        } else if attempt < max_attempts {
            let mut tx = pool.begin().await?;
            sqlx::query("UPDATE runs SET state='queued',attempt=attempt+1,available_at=?,updated_at=? WHERE id=?")
                .bind(store::now() + backoff(attempt)).bind(store::now()).bind(&id).execute(&mut *tx).await?;
            store::audit(
                &mut tx,
                "run.queued",
                &id,
                "crash recovery; checkpoint retained",
            )
            .await?;
            tx.commit().await?;
            event(events, &id, "queued");
        } else {
            state(
                pool,
                events,
                &id,
                "failed",
                Some("crash recovery attempts exhausted"),
            )
            .await?;
        }
    }
    Ok(())
}
fn backoff(attempt: u32) -> i64 {
    2_i64.pow(attempt.saturating_sub(1).min(10))
}

pub async fn checkpoint(pool: &SqlitePool, id: &str, cursor: &Value) -> Result<()> {
    let mut tx = pool.begin().await?;
    let updated = sqlx::query("UPDATE runs SET committed_batches=committed_batches+1,updated_at=? WHERE id=? AND state='running'")
        .bind(store::now()).bind(id).execute(&mut *tx).await?.rows_affected();
    ensure!(updated == 1, "checkpoint requires a running run");
    sqlx::query("INSERT INTO run_checkpoints(run_id,cursor,batch_number,updated_at) SELECT id,?,committed_batches,? FROM runs WHERE id=? ON CONFLICT(run_id) DO UPDATE SET cursor=excluded.cursor,batch_number=excluded.batch_number,updated_at=excluded.updated_at")
        .bind(cursor.to_string()).bind(store::now()).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn cancelled(pool: &SqlitePool, id: &str) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT cancel_requested FROM runs WHERE id=?")
            .bind(id)
            .fetch_one(pool)
            .await?,
    )
}
pub(crate) async fn execute(
    pool: &SqlitePool,
    backups: &Backups,
    id: &str,
    events: &Events,
) -> Result<()> {
    if cancelled(pool, id).await? {
        return Ok(());
    }
    let row = sqlx::query("SELECT j.builtin,j.dataset,j.source_id,s.kind FROM runs r JOIN jobs j ON j.id=r.job_id LEFT JOIN sources s ON s.id=j.source_id WHERE r.id=?")
        .bind(id).fetch_one(pool).await?;
    if row.get::<bool, _>("builtin") {
        backups.create(pool).await?;
    } else {
        let source: String = row.get("source_id");
        let dataset: String = row.get("dataset");
        let noop = row.get::<Option<String>, _>("kind").as_deref() == Some("noop");
        crate::catalog::path_component(&source)?;
        crate::catalog::path_component(&dataset)?;
        crate::catalog::path_component(id)?;
        let output = backups.data_dir().join("data").join(&source).join(&dataset);
        let staging = output.join(format!(".staging-{id}"));
        // A crash after the directory rename must resume publication, not reread checkpointed data.
        if !noop && output.join(id).is_dir() {
            publish_snapshot(pool, events, &output, id).await?;
            return Ok(());
        }
        let connector = crate::catalog::connector(pool, &source).await?;
        if !noop {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM datasets WHERE source_id=? AND name=?)",
            )
            .bind(&source)
            .bind(&dataset)
            .fetch_one(pool)
            .await?;
            if !exists {
                crate::catalog::discover(pool, &source).await?;
                let _ = events.send(json!({"type":"catalog.changed"}));
            }
        }
        let checkpoint_row =
            sqlx::query("SELECT cursor,batch_number FROM run_checkpoints WHERE run_id=?")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        let cursor = checkpoint_row
            .as_ref()
            .map(|r| serde_json::from_str::<Value>(r.get("cursor")))
            .transpose()?;
        let mut number = checkpoint_row
            .as_ref()
            .map(|r| r.get::<i64, _>("batch_number"))
            .unwrap_or(0);
        if !noop {
            ensure!(
                number == 0 || staging.is_dir(),
                "checkpoint staging directory is missing"
            );
            std::fs::create_dir_all(&staging)?;
        }
        let mut batches = connector.read(&dataset, cursor).await?;
        let mut linked = false;
        while let Some(batch) = batches.next().await {
            if cancelled(pool, id).await? {
                break;
            }
            let (batch, cursor) = batch?;
            if !noop {
                let path = staging.join(format!("part-{number:06}.parquet"));
                straton_connectors::write_parquet(&path, &batch)?;
                if !linked {
                    lineage(pool, &source, &dataset).await?;
                    linked = true;
                    let _ = events.send(json!({"type":"catalog.changed"}));
                }
            }
            checkpoint(pool, id, &cursor).await?;
            number += 1;
        }
        if !noop && !cancelled(pool, id).await? {
            if !linked {
                lineage(pool, &source, &dataset).await?;
                let _ = events.send(json!({"type":"catalog.changed"}));
            }
            publish_snapshot(pool, events, &output, id).await?;
        }
    }
    Ok(())
}
// The supervisor retains the run ID even when the worker unwinds.
pub async fn supervise<F>(pool: SqlitePool, events: Events, id: String, work: F) -> Result<()>
where
    F: Future<Output = Result<()>> + Send + 'static,
{
    let mut worker = JoinSet::new();
    worker.spawn(work);
    let result = worker.join_next().await.expect("one worker was spawned");
    if matches!(&result, Ok(Ok(()))) {
        let published: bool = sqlx::query_scalar("SELECT state='succeeded' FROM runs WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await?;
        if published {
            return Ok(());
        }
    }
    let (next, error) = match result {
        Err(e) if e.is_panic() => ("failed", Some("worker panicked".to_string())),
        Err(_) => ("interrupted", Some("worker aborted".to_string())),
        Ok(Err(e)) => {
            tracing::error!(run_id=%id, error=%e, "run failed");
            ("failed", Some(e.to_string().chars().take(500).collect()))
        }
        Ok(Ok(())) => (
            if cancelled(&pool, &id).await? {
                "cancelled"
            } else {
                "succeeded"
            },
            None,
        ),
    };
    state(&pool, &events, &id, next, error.as_deref()).await
}
pub struct Runner {
    pool: SqlitePool,
    events: Events,
    backups: Backups,
    permits: Arc<Semaphore>,
    tasks: JoinSet<()>,
}
impl Runner {
    pub fn new(pool: SqlitePool, events: Events, backups: Backups, concurrency: usize) -> Self {
        Self {
            pool,
            events,
            backups,
            permits: Arc::new(Semaphore::new(concurrency)),
            tasks: JoinSet::new(),
        }
    }
    pub async fn dispatch(&mut self) -> Result<()> {
        while let Some(result) = self.tasks.try_join_next() {
            if let Err(e) = result {
                tracing::error!(error=%e, "run supervisor failed");
            }
        }
        loop {
            let Ok(permit) = self.permits.clone().try_acquire_owned() else {
                break;
            };
            let mut tx = self.pool.begin().await?;
            let id: Option<String> = sqlx::query_scalar("UPDATE runs SET state='running',updated_at=? WHERE id=(SELECT id FROM runs WHERE state='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1) RETURNING id")
                .bind(store::now()).bind(store::now()).fetch_optional(&mut *tx).await?;
            let Some(id) = id else {
                break;
            };
            store::audit(&mut tx, "run.running", &id, "").await?;
            tx.commit().await?;
            event(&self.events, &id, "running");
            let pool = self.pool.clone();
            let events = self.events.clone();
            let backups = self.backups.clone();
            self.tasks.spawn(async move {
                let _permit = permit;
                let worker_pool = pool.clone();
                let worker_id = id.clone();
                let worker_events = events.clone();
                if let Err(e) = supervise(pool, events, id, async move {
                    execute(&worker_pool, &backups, &worker_id, &worker_events).await
                })
                .await
                {
                    tracing::error!(error=%e, "cannot record run result");
                }
            });
        }
        Ok(())
    }
    pub async fn drain(&mut self) {
        if tokio::time::timeout(Duration::from_secs(30), async {
            while self.tasks.join_next().await.is_some() {}
        })
        .await
        .is_err()
        {
            // Worker tasks exit with the runtime; running rows recover on next startup.
            tracing::warn!("30s drain expired; remaining runs will recover on restart");
        }
    }
}

async fn lineage(pool: &SqlitePool, source: &str, dataset: &str) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO sources(id,name,kind) VALUES('straton-local-lake','Local lake','parquet') ON CONFLICT(id) DO NOTHING").execute(&mut *tx).await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM sources WHERE id='straton-local-lake'")
        .fetch_one(&mut *tx)
        .await?;
    ensure!(kind == "parquet", "local lake source id is reserved");
    let from: String = sqlx::query_scalar("SELECT id FROM datasets WHERE source_id=? AND name=?")
        .bind(source)
        .bind(dataset)
        .fetch_one(&mut *tx)
        .await?;
    let to:String=sqlx::query_scalar("INSERT INTO datasets(id,source_id,name) VALUES(?,'straton-local-lake',?) ON CONFLICT(source_id,name) DO UPDATE SET name=excluded.name RETURNING id").bind(store::id()).bind(format!("{source}/{dataset}")).fetch_one(&mut *tx).await?;
    let cols = sqlx::query("SELECT * FROM columns WHERE dataset_id=?")
        .bind(&from)
        .fetch_all(&mut *tx)
        .await?;
    for c in cols {
        sqlx::query("INSERT INTO columns(id,dataset_id,name,data_type,nullable,primary_key) VALUES(?,?,?,?,?,?) ON CONFLICT(dataset_id,name) DO UPDATE SET data_type=excluded.data_type,nullable=excluded.nullable,primary_key=excluded.primary_key").bind(store::id()).bind(&to).bind(c.get::<String,_>("name")).bind(c.get::<String,_>("data_type")).bind(c.get::<bool,_>("nullable")).bind(c.get::<bool,_>("primary_key")).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM columns WHERE dataset_id=? AND name NOT IN(SELECT name FROM columns WHERE dataset_id=?)").bind(&to).bind(&from).execute(&mut *tx).await?;
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM relationships WHERE from_dataset=? AND to_dataset=? AND kind='lineage')").bind(&from).bind(&to).fetch_one(&mut *tx).await?;
    if !exists {
        crate::catalog::edge(
            &mut tx,
            &straton_core::Relationship {
                id: String::new(),
                from_dataset: from,
                from_cols: vec![],
                to_dataset: to,
                to_cols: vec![],
                kind: straton_core::RelationshipKind::Lineage,
                confidence: None,
            },
        )
        .await?;
        store::audit(&mut tx, "lineage.created", source, "").await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn publish_snapshot(
    pool: &SqlitePool,
    events: &Events,
    output: &Path,
    id: &str,
) -> Result<()> {
    let _snapshot = crate::sql::SNAPSHOTS.write().await;
    let mut tx = pool.begin().await?;
    // Serialize publishers and cancellation: once _current changes this run is successful.
    let updated = sqlx::query("UPDATE runs SET state='succeeded',updated_at=? WHERE id=? AND state='running' AND cancel_requested=0")
        .bind(store::now()).bind(id).execute(&mut *tx).await?.rows_affected();
    if updated == 0 {
        return Ok(());
    }
    store::audit(&mut tx, "run.succeeded", id, "snapshot published").await?;
    let active: Vec<String> =
        sqlx::query_scalar("SELECT id FROM runs WHERE state IN ('queued','running')")
            .fetch_all(&mut *tx)
            .await?;
    let snapshot = output.join(id);
    if !snapshot.is_dir() {
        std::fs::rename(output.join(format!(".staging-{id}")), &snapshot)?;
    }
    // Read durable part metadata so resumed publications include checkpointed batches.
    let mut row_count = 0_i64;
    for entry in std::fs::read_dir(&snapshot)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry.path().extension().is_some_and(|ext| ext == "parquet")
        {
            let reader = straton_connectors::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(entry.path())?)?;
            row_count = row_count
                .checked_add(reader.metadata().file_metadata().num_rows())
                .ok_or_else(|| anyhow::anyhow!("snapshot row count overflow"))?;
        }
    }
    sqlx::query("UPDATE datasets SET row_count=?1,last_synced_at=?2 WHERE (source_id,name) IN (SELECT j.source_id,j.dataset FROM jobs j JOIN runs r ON r.job_id=j.id WHERE r.id=?3) OR (source_id='straton-local-lake' AND name IN (SELECT j.source_id || '/' || j.dataset FROM jobs j JOIN runs r ON r.job_id=j.id WHERE r.id=?3))")
        .bind(row_count).bind(chrono::Utc::now().to_rfc3339()).bind(id)
        .execute(&mut *tx).await?;
    let temporary = output.join("_current.partial");
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(id.as_bytes())?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    std::fs::File::open(output)?.sync_all()?;
    std::fs::rename(temporary, output.join("_current"))?;
    // Make the pointer durable before removing the snapshot it replaced.
    #[cfg(unix)]
    let durable = match std::fs::File::open(output).and_then(|f| f.sync_all()) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(%error, "snapshot directory flush failed; cleanup deferred");
            false
        }
    };
    #[cfg(not(unix))]
    let durable = true;
    // Publication is complete; garbage collection must not turn it into a failed run.
    if durable && let Err(error) = clean_snapshots(output, id, &active) {
        tracing::warn!(%error, "snapshot cleanup deferred");
    }
    tx.commit().await?;
    event(events, id, "succeeded");
    let _ = events.send(json!({"type":"catalog.changed"}));
    Ok(())
}
fn clean_snapshots(output: &Path, current: &str, active: &[String]) -> Result<()> {
    let output = output.canonicalize()?;
    for entry in std::fs::read_dir(&output)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let run = if let Some(run) = name.strip_prefix(".staging-") {
            run
        } else {
            if uuid::Uuid::try_parse(&name).is_err() {
                continue;
            }
            &name
        };
        if name == current || active.iter().any(|id| id == run) {
            continue;
        }
        let path = entry.path().canonicalize()?;
        ensure!(
            path.parent() == Some(output.as_path()),
            "snapshot path escapes dataset directory"
        );
        std::fs::remove_dir_all(path)?;
    }
    Ok(())
}
