use anyhow::Result;
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{
    Row, SqlitePool,
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
    backfill_audit(&pool).await?;
    Ok(pool)
}
pub fn now() -> i64 {
    Utc::now().timestamp()
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
tokio::task_local! { pub static ACTOR: String; }
pub async fn audit(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    action: &str,
    entity: &str,
    detail: &str,
) -> Result<()> {
    let mut actor = ACTOR.try_with(Clone::clone).ok();
    // Worker and recovery tasks retain the initiator recorded by the original enqueue.
    if actor.is_none()
        && (action.starts_with("run.")
            || action.starts_with("pipeline.")
            || action.starts_with("pipeline_node."))
    {
        let queued = if action.starts_with("run.") {
            "run.queued"
        } else {
            "pipeline.queued"
        };
        actor = sqlx::query_scalar::<_, Option<String>>(
            "SELECT principal_id FROM audit_log WHERE action=? AND entity_id=? ORDER BY id LIMIT 1",
        )
        .bind(queued)
        .bind(entity)
        .fetch_optional(&mut **tx)
        .await?
        .flatten();
    }
    audit_as(tx, action, entity, detail, actor.as_deref()).await
}
pub async fn audit_as(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    action: &str,
    entity: &str,
    detail: &str,
    actor: Option<&str>,
) -> Result<()> {
    // Reserve SQLite's writer before reading the head or allocating the next audit id.
    sqlx::query("UPDATE security_state SET audit_backfilled=audit_backfilled WHERE id=1")
        .execute(&mut **tx)
        .await?;
    let previous: Option<String> =
        sqlx::query_scalar("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_optional(&mut **tx)
            .await?;
    let previous = previous.unwrap_or_else(|| GENESIS.into());
    let id: i64 = sqlx::query_scalar("SELECT MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_log'),0),COALESCE((SELECT MAX(id) FROM audit_log),0))+1")
        .fetch_one(&mut **tx).await?;
    let at = now();
    let hash = audit_hash(&previous, id, at, action, entity, actor, detail)?;
    sqlx::query("INSERT INTO audit_log(id,timestamp,action,entity_id,detail,principal_id,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)")
        .bind(id).bind(at).bind(action).bind(entity).bind(detail).bind(actor).bind(previous).bind(hash)
        .execute(&mut **tx).await?;
    Ok(())
}

pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
fn audit_hash(
    previous: &str,
    id: i64,
    at: i64,
    action: &str,
    entity: &str,
    principal: Option<&str>,
    detail: &str,
) -> Result<String> {
    // Explicit ordering is independent of serde_json's unified preserve_order feature.
    let canonical = std::collections::BTreeMap::from([
        ("id", serde_json::json!(id)),
        ("at", serde_json::json!(at)),
        ("action", serde_json::json!(action)),
        ("entity_id", serde_json::json!(entity)),
        ("principal_id", serde_json::json!(principal)),
        ("detail", serde_json::json!(detail)),
    ]);
    let mut hash = Sha256::new();
    hash.update(previous.as_bytes());
    hash.update(serde_json::to_vec(&canonical)?);
    Ok(format!("{:x}", hash.finalize()))
}
pub(crate) async fn backfill_audit(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let needed: bool = sqlx::query_scalar("UPDATE security_state SET audit_backfilled=audit_backfilled WHERE id=1 RETURNING audit_backfilled=0")
        .fetch_one(&mut *tx).await?;
    if !needed {
        return Ok(());
    }
    // DDL is transactional too: a crash restores the append-only trigger and retries the backfill.
    sqlx::query("DROP TRIGGER audit_log_no_update")
        .execute(&mut *tx)
        .await?;
    let mut previous = GENESIS.to_owned();
    for row in sqlx::query("SELECT * FROM audit_log ORDER BY id")
        .fetch_all(&mut *tx)
        .await?
    {
        let id: i64 = row.get("id");
        let hash = audit_hash(
            &previous,
            id,
            row.get("timestamp"),
            row.get("action"),
            row.get("entity_id"),
            row.get("principal_id"),
            row.get("detail"),
        )?;
        sqlx::query("UPDATE audit_log SET prev_hash=?,hash=? WHERE id=?")
            .bind(&previous)
            .bind(&hash)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        previous = hash;
    }
    sqlx::query("CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END")
        .execute(&mut *tx).await?;
    sqlx::query("UPDATE security_state SET audit_backfilled=1 WHERE id=1")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
#[derive(Serialize)]
pub struct AuditVerification {
    pub ok: bool,
    pub rows: usize,
    pub first_bad_id: Option<i64>,
}
pub async fn verify_audit(pool: &SqlitePool) -> Result<AuditVerification> {
    // One read transaction pins a consistent chain while writers append new rows.
    let mut tx = pool.begin().await?;
    let rows = sqlx::query("SELECT * FROM audit_log ORDER BY id")
        .fetch_all(&mut *tx)
        .await?;
    let mut result = AuditVerification {
        ok: true,
        rows: rows.len(),
        first_bad_id: None,
    };
    let mut previous = GENESIS.to_owned();
    for row in rows {
        let id: i64 = row.get("id");
        let expected = audit_hash(
            &previous,
            id,
            row.get("timestamp"),
            row.get("action"),
            row.get("entity_id"),
            row.get("principal_id"),
            row.get("detail"),
        )?;
        if row.get::<Option<&str>, _>("prev_hash") != Some(previous.as_str())
            || row.get::<Option<&str>, _>("hash") != Some(expected.as_str())
        {
            result.ok = false;
            result.first_bad_id = Some(id);
            break;
        }
        previous = expected;
    }
    Ok(result)
}
pub async fn audit_head(pool: &SqlitePool) -> Result<String> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
            .fetch_optional(pool)
            .await?
            .unwrap_or_else(|| GENESIS.into()),
    )
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
