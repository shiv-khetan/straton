use super::*;
use axum::routing::{delete, put};
pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/users", get(users).post(create_user))
        .route(
            "/v1/users/{id}",
            get(user).put(update_user).delete(disable_user),
        )
        .route("/v1/users/{id}/roles", put(assign_roles))
        .route("/v1/users/{id}/tokens", get(tokens).post(issue_token))
        .route("/v1/users/{id}/tokens/{token}", delete(revoke_token))
        .route("/v1/roles", get(roles).post(create_role))
        .route(
            "/v1/roles/{id}",
            get(role).put(update_role).delete(delete_role),
        )
        .route("/v1/grants", get(grants).post(create_grant))
        .route(
            "/v1/grants/{id}",
            get(grant).put(update_grant).delete(delete_grant),
        )
        .route("/v1/datasets/{id}/policies", get(policies))
        .route(
            "/v1/datasets/{id}/row-filters/{role}",
            put(filter).delete(delete_filter),
        )
        .route(
            "/v1/datasets/{id}/masks/{role}/{column}",
            put(mask).delete(delete_mask),
        )
        .route("/v1/policies/validate", post(validate))
}
fn user_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"disabled":r.get::<bool,_>("disabled"),"created_at":r.get::<i64,_>("created_at")})
}
fn role_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"is_admin":r.get::<bool,_>("is_admin")})
}
fn grant_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"role_id":r.get::<String,_>("role_id"),"target_kind":r.get::<String,_>("target_kind"),"target_id":r.get::<String,_>("target_id"),"privilege":r.get::<String,_>("privilege")})
}
async fn users(State(a): State<App>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT * FROM users ORDER BY name")
        .fetch_all(&a.pool)
        .await?;
    let mut out = Vec::new();
    for r in rows {
        let mut u = user_json(&r);
        let roles: Vec<String> =
            sqlx::query_scalar("SELECT role_id FROM user_roles WHERE user_id=? ORDER BY role_id")
                .bind(r.get::<&str, _>("id"))
                .fetch_all(&a.pool)
                .await?;
        u["role_ids"] = json!(roles);
        out.push(u);
    }
    Ok(Json(json!(out)))
}
async fn user(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("SELECT * FROM users WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    Ok(Json(user_json(&r)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UserInput {
    name: String,
    #[serde(default)]
    disabled: bool,
}
fn name(s: &str) -> ApiResult<()> {
    if s.trim().is_empty() || s.len() > 200 || s.chars().any(char::is_control) {
        Err(bad("invalid name"))
    } else {
        Ok(())
    }
}
async fn create_user(
    State(a): State<App>,
    Json(u): Json<UserInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    name(&u.name)?;
    let id = store::id();
    let mut tx = a.pool.begin().await?;
    sqlx::query("INSERT INTO users(id,name,disabled,created_at) VALUES(?,?,?,?)")
        .bind(&id)
        .bind(u.name)
        .bind(u.disabled)
        .bind(store::now())
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "user.created", &id, "").await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, user(State(a), Path(id)).await?))
}
async fn update_user(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(u): Json<UserInput>,
) -> ApiResult<Json<Value>> {
    name(&u.name)?;
    if id == "admin" {
        return Err(bad("bootstrap admin cannot be renamed or disabled"));
    }
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("UPDATE users SET name=?,disabled=? WHERE id=?")
            .bind(u.name)
            .bind(u.disabled)
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "user.updated", &id, "").await?;
    tx.commit().await?;
    user(State(a), Path(id)).await
}
async fn disable_user(State(a): State<App>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if id == "admin" {
        return Err(bad("bootstrap admin cannot be disabled"));
    }
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("UPDATE users SET disabled=1 WHERE id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "user.disabled", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleAssignment {
    role_ids: Vec<String>,
}
async fn assign_roles(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(input): Json<RoleAssignment>,
) -> ApiResult<StatusCode> {
    if id == "admin" {
        return Err(bad("bootstrap admin roles are fixed"));
    }
    let mut tx = a.pool.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=?)")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        return Err(bad("unknown user"));
    }
    sqlx::query("DELETE FROM user_roles WHERE user_id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for role in input.role_ids {
        sqlx::query("INSERT OR IGNORE INTO user_roles(user_id,role_id) VALUES(?,?)")
            .bind(&id)
            .bind(role)
            .execute(&mut *tx)
            .await?;
    }
    store::audit(&mut tx, "user.roles_updated", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenInput {
    name: String,
    expires_at: Option<i64>,
}
async fn issue_token(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(input): Json<TokenInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    name(&input.name)?;
    if input.expires_at.is_some_and(|t| t <= store::now()) {
        return Err(bad("expiry must be in the future"));
    }
    let mut tx = a.pool.begin().await?;
    let enabled: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0)")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    if !enabled {
        return Err(bad("unknown or disabled user"));
    }
    let token = crate::access::new_token();
    let tid = store::id();
    sqlx::query("INSERT INTO api_tokens(id,user_id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)").bind(&tid).bind(&id).bind(input.name).bind(crate::access::hash(&token)).bind(store::now()).bind(input.expires_at).execute(&mut *tx).await?;
    store::audit(
        &mut tx,
        "token.created",
        &tid,
        &json!({"user_id":id}).to_string(),
    )
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({"id":tid,"token":token}))))
}
async fn tokens(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT id,name,created_at,last_used_at,expires_at,revoked_at FROM api_tokens WHERE user_id=? ORDER BY created_at,id").bind(id).fetch_all(&a.pool).await?;
    Ok(Json(json!(rows.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"created_at":r.get::<i64,_>("created_at"),"last_used_at":r.get::<Option<i64>,_>("last_used_at"),"expires_at":r.get::<Option<i64>,_>("expires_at"),"revoked_at":r.get::<Option<i64>,_>("revoked_at")})).collect::<Vec<_>>())))
}
async fn revoke_token(
    State(a): State<App>,
    Path((id, token)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query(
            "UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?",
        )
        .bind(store::now())
        .bind(&token)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected(),
    )?;
    store::audit(&mut tx, "token.revoked", &token, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NameInput {
    name: String,
}
async fn roles(State(a): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(
        sqlx::query("SELECT * FROM roles ORDER BY name")
            .fetch_all(&a.pool)
            .await?
            .iter()
            .map(role_json)
            .collect::<Vec<_>>()
    )))
}
async fn role(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("SELECT * FROM roles WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    Ok(Json(role_json(&r)))
}
async fn create_role(
    State(a): State<App>,
    Json(input): Json<NameInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    name(&input.name)?;
    let id = store::id();
    let mut tx = a.pool.begin().await?;
    sqlx::query("INSERT INTO roles(id,name) VALUES(?,?)")
        .bind(&id)
        .bind(input.name)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "role.created", &id, "").await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, role(State(a), Path(id)).await?))
}
async fn update_role(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(input): Json<NameInput>,
) -> ApiResult<Json<Value>> {
    name(&input.name)?;
    if id == "admin" {
        return Err(bad("bootstrap admin role is fixed"));
    }
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("UPDATE roles SET name=? WHERE id=?")
            .bind(input.name)
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "role.updated", &id, "").await?;
    tx.commit().await?;
    role(State(a), Path(id)).await
}
async fn delete_role(State(a): State<App>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if id == "admin" {
        return Err(bad("bootstrap admin role is fixed"));
    }
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("DELETE FROM roles WHERE id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "role.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantInput {
    role_id: String,
    target_kind: String,
    target_id: String,
    privilege: String,
}
async fn grants(State(a): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(
        sqlx::query("SELECT * FROM grants ORDER BY id")
            .fetch_all(&a.pool)
            .await?
            .iter()
            .map(grant_json)
            .collect::<Vec<_>>()
    )))
}
async fn grant(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let r = sqlx::query("SELECT * FROM grants WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    Ok(Json(grant_json(&r)))
}
async fn save_grant(a: App, id: String, input: GrantInput, update: bool) -> ApiResult<Json<Value>> {
    if !["source", "dataset"].contains(&input.target_kind.as_str())
        || !["read", "sync_admin", "admin"].contains(&input.privilege.as_str())
    {
        return Err(bad("invalid grant"));
    }
    let mut tx = a.pool.begin().await?;
    let target = if input.target_kind == "source" {
        "SELECT EXISTS(SELECT 1 FROM sources WHERE id=?)"
    } else {
        "SELECT EXISTS(SELECT 1 FROM datasets WHERE id=?)"
    };
    if !sqlx::query_scalar::<_, bool>(target)
        .bind(&input.target_id)
        .fetch_one(&mut *tx)
        .await?
    {
        return Err(bad("unknown target"));
    }
    let q = if update {
        "UPDATE grants SET role_id=?2,target_kind=?3,target_id=?4,privilege=?5 WHERE id=?1"
    } else {
        "INSERT INTO grants(id,role_id,target_kind,target_id,privilege) VALUES(?1,?2,?3,?4,?5)"
    };
    found(
        sqlx::query(q)
            .bind(&id)
            .bind(input.role_id)
            .bind(input.target_kind)
            .bind(input.target_id)
            .bind(input.privilege)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(
        &mut tx,
        if update {
            "grant.updated"
        } else {
            "grant.created"
        },
        &id,
        "",
    )
    .await?;
    tx.commit().await?;
    grant(State(a), Path(id)).await
}
async fn create_grant(
    State(a): State<App>,
    Json(input): Json<GrantInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        save_grant(a, store::id(), input, false).await?,
    ))
}
async fn update_grant(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(input): Json<GrantInput>,
) -> ApiResult<Json<Value>> {
    save_grant(a, id, input, true).await
}
async fn delete_grant(State(a): State<App>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("DELETE FROM grants WHERE id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "grant.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn policies(
    State(a): State<App>,
    Extension(actor): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_dataset_admin(&a.pool, &actor, &id).await?;
    let filters = sqlx::query(
        "SELECT role_id,predicate FROM row_filters WHERE dataset_id=? ORDER BY role_id",
    )
    .bind(&id)
    .fetch_all(&a.pool)
    .await?;
    let masks=sqlx::query("SELECT role_id,\"column\",kind FROM column_masks WHERE dataset_id=? ORDER BY role_id,\"column\"").bind(id).fetch_all(&a.pool).await?;
    Ok(Json(
        json!({"row_filters":filters.iter().map(|r|json!({"role_id":r.get::<String,_>("role_id"),"predicate":r.get::<String,_>("predicate")})).collect::<Vec<_>>(),"masks":masks.iter().map(|r|json!({"role_id":r.get::<String,_>("role_id"),"column":r.get::<String,_>("column"),"kind":r.get::<String,_>("kind")})).collect::<Vec<_>>()}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PredicateInput {
    predicate: String,
}
async fn filter(
    State(a): State<App>,
    Extension(actor): Extension<Principal>,
    Path((id, role)): Path<(String, String)>,
    Json(input): Json<PredicateInput>,
) -> ApiResult<Json<Value>> {
    require_dataset_admin(&a.pool, &actor, &id).await?;
    let frame = crate::policies::schema_frame(&a.pool, &id)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    crate::policies::validate(&frame, &input.predicate)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    let mut tx = a.pool.begin().await?;
    sqlx::query("INSERT INTO row_filters(id,dataset_id,role_id,predicate) VALUES(?,?,?,?) ON CONFLICT(dataset_id,role_id) DO UPDATE SET predicate=excluded.predicate").bind(store::id()).bind(&id).bind(&role).bind(input.predicate).execute(&mut *tx).await?;
    store::audit(
        &mut tx,
        "policy.row_filter_updated",
        &id,
        &json!({"role_id":role}).to_string(),
    )
    .await?;
    tx.commit().await?;
    changed(&a);
    Ok(Json(json!({"ok":true})))
}
async fn delete_filter(
    State(a): State<App>,
    Extension(actor): Extension<Principal>,
    Path((id, role)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    require_dataset_admin(&a.pool, &actor, &id).await?;
    let mut tx = a.pool.begin().await?;
    sqlx::query("DELETE FROM row_filters WHERE dataset_id=? AND role_id=?")
        .bind(&id)
        .bind(&role)
        .execute(&mut *tx)
        .await?;
    store::audit(
        &mut tx,
        "policy.row_filter_deleted",
        &id,
        &json!({"role_id":role}).to_string(),
    )
    .await?;
    tx.commit().await?;
    changed(&a);
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MaskInput {
    kind: String,
}
async fn mask(
    State(a): State<App>,
    Extension(actor): Extension<Principal>,
    Path((id, role, column)): Path<(String, String, String)>,
    Json(input): Json<MaskInput>,
) -> ApiResult<Json<Value>> {
    require_dataset_admin(&a.pool, &actor, &id).await?;
    if !["null", "redact", "hash", "last4"].contains(&input.kind.as_str()) {
        return Err(bad("invalid mask kind"));
    }
    let mut tx = a.pool.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM columns WHERE dataset_id=? AND name=?)")
            .bind(&id)
            .bind(&column)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(bad("unknown column"));
    }
    sqlx::query("INSERT INTO column_masks(id,dataset_id,role_id,\"column\",kind) VALUES(?,?,?,?,?) ON CONFLICT(dataset_id,\"column\",role_id) DO UPDATE SET kind=excluded.kind").bind(store::id()).bind(&id).bind(&role).bind(&column).bind(input.kind).execute(&mut *tx).await?;
    store::audit(
        &mut tx,
        "policy.mask_updated",
        &id,
        &json!({"role_id":role,"column":column}).to_string(),
    )
    .await?;
    tx.commit().await?;
    changed(&a);
    Ok(Json(json!({"ok":true})))
}
async fn delete_mask(
    State(a): State<App>,
    Extension(actor): Extension<Principal>,
    Path((id, role, column)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    require_dataset_admin(&a.pool, &actor, &id).await?;
    let mut tx = a.pool.begin().await?;
    sqlx::query("DELETE FROM column_masks WHERE dataset_id=? AND role_id=? AND \"column\"=?")
        .bind(&id)
        .bind(&role)
        .bind(&column)
        .execute(&mut *tx)
        .await?;
    store::audit(
        &mut tx,
        "policy.mask_deleted",
        &id,
        &json!({"role_id":role,"column":column}).to_string(),
    )
    .await?;
    tx.commit().await?;
    changed(&a);
    Ok(StatusCode::NO_CONTENT)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationInput {
    dataset_id: String,
    predicate: String,
}
async fn validate(
    State(a): State<App>,
    Extension(actor): Extension<Principal>,
    Json(input): Json<ValidationInput>,
) -> ApiResult<Json<Value>> {
    require_dataset_admin(&a.pool, &actor, &input.dataset_id).await?;
    let result = async {
        let frame = crate::policies::schema_frame(&a.pool, &input.dataset_id).await?;
        crate::policies::validate(&frame, &input.predicate).await?;
        anyhow::Ok(())
    }
    .await;
    Ok(Json(match result {
        Ok(()) => json!({"ok":true}),
        Err(e) => json!({"ok":false,"error":e.to_string()}),
    }))
}
