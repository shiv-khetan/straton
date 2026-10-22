use crate::store;
use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};

// An old watermark produces exactly one run, regardless of how many ticks were missed.
pub fn due(expression: &str, watermark: i64, now: i64) -> Result<bool> {
    let schedule: cron::Schedule = expression.parse()?;
    let after = DateTime::<Utc>::from_timestamp(watermark, 0)
        .ok_or_else(|| anyhow::anyhow!("invalid scheduler watermark"))?;
    Ok(schedule
        .after(&after)
        .next()
        .is_some_and(|next| next.timestamp() <= now))
}
pub async fn tick(
    pool: &SqlitePool,
    sql: &crate::sql::Sql,
    events: &crate::runner::Events,
) -> Result<Vec<String>> {
    let _save = crate::pipeline::SAVES.lock().await;
    let now = store::now();
    let mut tx = pool.begin().await?;
    let jobs =
        sqlx::query("SELECT id,cron,last_scheduled FROM jobs WHERE enabled=1 AND cron IS NOT NULL AND (model_id IS NULL OR EXISTS(SELECT 1 FROM models m WHERE m.id=jobs.model_id AND m.status='ready'))")
            .fetch_all(&mut *tx)
            .await?;
    let mut queued = Vec::new();
    for job in jobs {
        let id: String = job.get("id");
        let due = match due(job.get("cron"), job.get("last_scheduled"), now) {
            Ok(due) => due,
            Err(error) => {
                tracing::warn!(job_id=%id, %error, "skipping invalid job schedule");
                continue;
            }
        };
        if due {
            queued.push(store::enqueue(&mut tx, &id, now).await?);
            sqlx::query("UPDATE jobs SET last_scheduled=? WHERE id=?")
                .bind(now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }
    let mut pipelines = vec![];
    for r in sqlx::query(
        "SELECT id,cron,last_scheduled FROM pipelines WHERE enabled=1 AND cron IS NOT NULL",
    )
    .fetch_all(&mut *tx)
    .await?
    {
        if due(r.get("cron"), r.get("last_scheduled"), now).unwrap_or(false) {
            let id: &str = r.get("id");
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pipeline_runs WHERE pipeline_id=? AND state IN ('queued','running'))").bind(id).fetch_one(&mut *tx).await?;
            if !active {
                pipelines.push(crate::pipeline::enqueue(&mut tx, id, "cron").await?);
            }
            sqlx::query("UPDATE pipelines SET last_scheduled=? WHERE id=?")
                .bind(now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            store::audit(&mut tx, "pipeline.scheduled", id, "").await?;
        }
    }
    let mut checks = vec![];
    for r in sqlx::query(
        "SELECT id,cron,last_scheduled FROM quality_checks WHERE enabled=1 AND cron IS NOT NULL",
    )
    .fetch_all(&mut *tx)
    .await?
    {
        if due(r.get("cron"), r.get("last_scheduled"), now).unwrap_or(false) {
            let id: String = r.get("id");
            sqlx::query("UPDATE quality_checks SET last_scheduled=? WHERE id=?")
                .bind(now)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            store::audit(&mut tx, "quality.scheduled", &id, "").await?;
            checks.push(id);
        }
    }
    let removed = sqlx::query("DELETE FROM notifications WHERE created_at<?")
        .bind(now - 90 * 86400)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed > 0 {
        store::audit(&mut tx, "notification.pruned", "", &removed.to_string()).await?;
    }
    tx.commit().await?;
    for id in pipelines {
        crate::pipeline::start(sql.clone(), events.clone(), id);
    }
    for id in checks {
        let (sql, events) = (sql.clone(), events.clone());
        tokio::spawn(async move {
            if let Err(e) = crate::quality::run(&sql, &events, &id, None).await {
                tracing::error!(error=%e,"scheduled quality check failed");
            }
        });
    }
    Ok(queued)
}
pub async fn seed_backup(pool: &SqlitePool, cron: &str) -> Result<()> {
    sqlx::query("INSERT INTO jobs(id,name,dataset,cron,enabled,last_scheduled,builtin) VALUES('builtin-backup','Backup','',?,1,?,1) ON CONFLICT(id) DO UPDATE SET cron=excluded.cron")
        .bind(cron).bind(store::now()).execute(pool).await?;
    Ok(())
}
