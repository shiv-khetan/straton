use super::*;

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/admin/keys", get(keys))
        .route("/v1/admin/keys/rotate-kek", post(rotate_kek))
        .route("/v1/admin/keys/rotate/{target}", post(rotate_dataset))
        .route("/v1/audit/verify", get(verify))
}
fn admin(p: &Principal) -> ApiResult<()> {
    if p.admin() { Ok(()) } else { Err(forbidden()) }
}
async fn keys(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    admin(&p)?;
    Ok(Json(json!(crate::keys::list(&a.pool).await?)))
}
async fn rotate_kek(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    admin(&p)?;
    crate::keys::initialize(&a.pool).await?;
    let version = crate::keys::rotate_kek(&a.pool).await?;
    Ok(Json(json!({"kek_version":version})))
}
async fn rotate_dataset(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(target): Path<String>,
) -> ApiResult<Json<Value>> {
    admin(&p)?;
    let physical: Option<String> = sqlx::query_scalar("SELECT CASE WHEN source_id='straton-local-lake' THEN (SELECT original.id FROM datasets original WHERE original.source_id=substr(alias.name,1,instr(alias.name,'/')-1) AND original.name=substr(alias.name,instr(alias.name,'/')+1)) ELSE id END FROM datasets alias WHERE id=?")
        .bind(&target).fetch_optional(&a.pool).await?.flatten();
    let target =
        physical.ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "dataset not found".into()))?;
    crate::keys::retire(&a.pool, &target).await.map_err(|e| {
        if e.to_string().contains("active runs") {
            ApiError(StatusCode::CONFLICT, e.to_string())
        } else {
            e.into()
        }
    })?;
    Ok(Json(json!({"ok":true})))
}
async fn verify(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    admin(&p)?;
    Ok(Json(json!(
        crate::notify::verify_audit(&a.pool, &a.events).await?
    )))
}
