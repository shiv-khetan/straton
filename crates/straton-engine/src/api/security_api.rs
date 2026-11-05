use super::*;

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/admin/keys", get(keys))
        .route("/v1/admin/keys/rotate-kek", post(rotate_kek))
        .route("/v1/admin/keys/rotate/{target}", post(rotate_dataset))
        .route("/v1/audit/verify", get(verify))
        .route("/v1/admin/settings", get(settings))
        .route("/v1/admin/auth-failures", get(auth_failures))
}
/// Addresses that presented rejected credentials in the last ten minutes. Admin only.
async fn auth_failures(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    admin(&p)?;
    Ok(Json(json!({
        "window_secs": crate::auth_failures::WINDOW.as_secs(),
        "threshold": crate::auth_failures::THRESHOLD,
        "addresses": a.sql.auth_failures.snapshot(),
    })))
}
/// Effective engine configuration for the Settings page. Admin only. Never includes secrets,
/// the token file, or TLS certificate/key paths: only whether TLS is configured.
async fn settings(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    admin(&p)?;
    let c = a.backups.config();
    Ok(Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "bind": c.bind.to_string(),
        "tls": c.tls_cert.is_some() && c.tls_key.is_some(),
        "data_dir": c.data_dir.display().to_string(),
        "max_concurrent_runs": c.max_concurrent_runs,
        "max_attempts": c.max_attempts,
        "backup": {"cron": c.backup.cron, "dir": c.backup.dir.display().to_string(), "keep": c.backup.keep},
        "sql": {
            "enabled": c.sql.enabled,
            "bind": c.sql.bind.to_string(),
            "query_timeout_secs": c.sql.query_timeout_secs,
            "max_rows": c.sql.max_rows,
            "memory_limit_mb": c.sql.memory_limit_mb,
        },
        "encryption": {"enabled": c.encryption.enabled},
        "network": {"allow_private": c.network.allow_private},
        "snapshots": {"keep": c.snapshots.keep},
        "secret_store": crate::credentials::store_kind(),
    })))
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
