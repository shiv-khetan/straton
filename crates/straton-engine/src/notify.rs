use crate::{runner::Events, store};
use anyhow::Result;
use serde_json::json;
use sqlx::SqlitePool;

pub struct Notice<'a> {
    pub severity: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub entity_kind: &'a str,
    pub entity_id: &'a str,
    pub user_id: Option<&'a str>,
}
pub async fn emit(pool: &SqlitePool, events: &Events, n: Notice<'_>) -> Result<()> {
    let id = store::id();
    let at = store::now();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO notifications(id,created_at,severity,kind,title,body,entity_kind,entity_id,user_id) VALUES(?,?,?,?,?,'',?,?,?)")
        .bind(&id).bind(at).bind(n.severity).bind(n.kind).bind(n.title).bind(n.entity_kind).bind(n.entity_id).bind(n.user_id).execute(&mut *tx).await?;
    store::audit(&mut tx, "notification.created", &id, n.kind).await?;
    tx.commit().await?;
    let _ = events.send(json!({"type":"notification","id":id,"created_at":at,"severity":n.severity,"kind":n.kind,"title":n.title,"body":"","entity_kind":n.entity_kind,"entity_id":n.entity_id,"user_id":n.user_id}));
    Ok(())
}

pub async fn verify_audit(pool: &SqlitePool, events: &Events) -> Result<store::AuditVerification> {
    let result = store::verify_audit(pool).await?;
    if !result.ok {
        emit(
            pool,
            events,
            Notice {
                severity: "error",
                kind: "audit.failed",
                title: "Audit chain verification failed",
                entity_kind: "audit",
                entity_id: "",
                user_id: None,
            },
        )
        .await?;
    }
    Ok(result)
}
