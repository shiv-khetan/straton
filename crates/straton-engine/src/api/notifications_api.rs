use super::*;

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/notifications", get(list))
        .route("/v1/notifications/read", post(read))
        .route("/v1/notifications/unread-count", get(count))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct List {
    unread: Option<bool>,
    limit: Option<i64>,
}
async fn list(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Query(q): Query<List>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT n.*,EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=?1) AS read FROM notifications n WHERE (n.user_id=?1 OR (n.user_id IS NULL AND ?2)) AND (NOT ?3 OR NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=?1)) ORDER BY n.created_at DESC,n.rowid DESC LIMIT ?4")
        .bind(&p.user.id).bind(p.admin()).bind(q.unread.unwrap_or(false)).bind(q.limit.unwrap_or(50).clamp(1,200)).fetch_all(&a.pool).await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"created_at":r.get::<i64,_>("created_at"),"severity":r.get::<String,_>("severity"),"kind":r.get::<String,_>("kind"),"title":r.get::<String,_>("title"),"body":r.get::<String,_>("body"),"entity_kind":r.get::<String,_>("entity_kind"),"entity_id":r.get::<String,_>("entity_id"),"read":r.get::<bool,_>("read")})).collect::<Vec<_>>())))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    ids: Option<Vec<String>>,
    all: Option<bool>,
}
async fn read(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Read>,
) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    sqlx::query("INSERT OR IGNORE INTO notification_reads(notification_id,user_id) SELECT id,?1 FROM notifications WHERE (user_id=?1 OR (user_id IS NULL AND ?2)) AND (?3 OR id IN (SELECT value FROM json_each(?4)))")
        .bind(&p.user.id).bind(p.admin()).bind(q.all.unwrap_or(false)).bind(json!(q.ids.unwrap_or_default()).to_string()).execute(&mut *tx).await?;
    store::audit(&mut tx, "notification.read", &p.user.id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn count(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM notifications n WHERE (user_id=?1 OR (user_id IS NULL AND ?2)) AND NOT EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id=n.id AND r.user_id=?1)")
        .bind(&p.user.id).bind(p.admin()).fetch_one(&a.pool).await?;
    Ok(Json(json!({"count":count})))
}
