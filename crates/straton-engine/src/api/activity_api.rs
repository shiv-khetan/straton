use super::*;

pub(super) fn routes() -> Router<App> {
    Router::new().route("/v1/activity", get(list))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    before_id: Option<i64>,
    limit: Option<i64>,
    action_prefix: Option<String>,
    actor: Option<String>,
    entity: Option<String>,
}
async fn list(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Query(q): Query<Input>,
) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT l.*,u.name AS actor_name FROM audit_log l LEFT JOIN users u ON u.id=l.principal_id WHERE (?1 OR principal_id=?2) AND (?3 IS NULL OR l.id<?3) AND (?4 IS NULL OR substr(action,1,length(?4))=?4) AND (?5 IS NULL OR principal_id=?5) AND (?6 IS NULL OR entity_id=?6) ORDER BY l.id DESC LIMIT ?7")
        .bind(p.admin()).bind(&p.user.id).bind(q.before_id).bind(q.action_prefix).bind(q.actor).bind(q.entity).bind(q.limit.unwrap_or(50).clamp(1,200)).fetch_all(&a.pool).await?;
    Ok(Json(json!(rows.iter().map(|r|{
        let action:String=r.get("action");
        // Action names are engine constants; detail may contain SQL, errors or sensitive values.
        let mut summary=action.replace(['.','_']," ");
        if action=="quality.run" && ["passed","failed","error"].contains(&r.get::<&str,_>("detail")){summary.push_str(": ");summary.push_str(r.get("detail"));}
        json!({"id":r.get::<i64,_>("id"),"at":r.get::<i64,_>("timestamp"),"action":action,"entity_id":r.get::<String,_>("entity_id"),"actor_id":r.get::<Option<String>,_>("principal_id"),"actor_name":r.get::<Option<String>,_>("actor_name"),"summary":summary})
    }).collect::<Vec<_>>())))
}
