use crate::{backup::Backups, store};
use anyhow::{Result, ensure};
use futures::StreamExt;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::{future::Future, sync::Arc, time::Duration};
use straton_core::Connector;
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
async fn execute(pool: &SqlitePool, backups: &Backups, id: &str) -> Result<()> {
    if cancelled(pool, id).await? {
        return Ok(());
    }
    let row = sqlx::query("SELECT j.builtin,j.dataset,s.kind FROM runs r JOIN jobs j ON j.id=r.job_id LEFT JOIN sources s ON s.id=j.source_id WHERE r.id=?")
        .bind(id).fetch_one(pool).await?;
    if row.get::<bool, _>("builtin") {
        backups.create(pool).await?;
    } else {
        ensure!(
            row.get::<Option<String>, _>("kind").as_deref() == Some("noop"),
            "connector is not available in Phase 1"
        );
        let cursor: Option<String> =
            sqlx::query_scalar("SELECT cursor FROM run_checkpoints WHERE run_id=?")
                .bind(id)
                .fetch_optional(pool)
                .await?;
        let cursor = cursor.map(|s| serde_json::from_str(&s)).transpose()?;
        let connector = straton_connectors::Noop;
        let mut batches = connector.read(row.get("dataset"), cursor).await?;
        while let Some(batch) = batches.next().await {
            if cancelled(pool, id).await? {
                break;
            }
            let (_batch, cursor) = batch?;
            // Phase 1 commits a batch marker; Parquet output belongs to Phase 2.
            checkpoint(pool, id, &cursor).await?;
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
                if let Err(e) = supervise(pool, events, id, async move {
                    execute(&worker_pool, &backups, &worker_id).await
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
