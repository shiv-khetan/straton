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
pub async fn tick(pool: &SqlitePool) -> Result<Vec<String>> {
    let now = store::now();
    let mut tx = pool.begin().await?;
    let jobs =
        sqlx::query("SELECT id,cron,last_scheduled FROM jobs WHERE enabled=1 AND cron IS NOT NULL")
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
    tx.commit().await?;
    Ok(queued)
}
pub async fn seed_backup(pool: &SqlitePool, cron: &str) -> Result<()> {
    sqlx::query("INSERT INTO jobs(id,name,dataset,cron,enabled,last_scheduled,builtin) VALUES('builtin-backup','Backup','',?,1,?,1) ON CONFLICT(id) DO UPDATE SET cron=excluded.cron")
        .bind(cron).bind(store::now()).execute(pool).await?;
    Ok(())
}
