use anyhow::Result;
use chrono::Utc;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{path::Path, str::FromStr};
use uuid::Uuid;

pub async fn open(dir: &Path) -> Result<SqlitePool> {
    tokio::fs::create_dir_all(dir).await?;
    let options = SqliteConnectOptions::from_str("sqlite:")?
        .filename(dir.join("state.db"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}
pub fn now() -> i64 {
    Utc::now().timestamp()
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    action: &str,
    entity: &str,
    detail: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO audit_log(timestamp,action,entity_id,detail) VALUES(?,?,?,?)")
        .bind(now())
        .bind(action)
        .bind(entity)
        .bind(detail)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
pub async fn enqueue(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    job: &str,
    at: i64,
) -> Result<String> {
    let id = id();
    sqlx::query("INSERT INTO runs(id,job_id,state,available_at,created_at,updated_at) VALUES(?,?,'queued',?,?,?)")
        .bind(&id).bind(job).bind(at).bind(now()).bind(now()).execute(&mut **tx).await?;
    audit(tx, "run.queued", &id, "").await?;
    Ok(id)
}
