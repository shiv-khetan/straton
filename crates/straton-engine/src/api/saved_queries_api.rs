use super::*;

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/saved-queries", get(list).post(create))
        .route(
            "/v1/saved-queries/{id}",
            get(one).put(update).delete(remove),
        )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    name: String,
    sql: String,
    #[serde(default)]
    shared: bool,
}
fn value(r: sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"owner_id":r.get::<String,_>("owner_id"),"name":r.get::<String,_>("name"),"sql":r.get::<String,_>("sql"),"shared":r.get::<bool,_>("shared"),"created_at":r.get::<i64,_>("created_at"),"updated_at":r.get::<i64,_>("updated_at")})
}
async fn list(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(sqlx::query("SELECT * FROM saved_queries WHERE owner_id=? OR shared=1 OR ? ORDER BY updated_at DESC,id")
        .bind(&p.user.id).bind(p.admin()).fetch_all(&a.pool).await?.into_iter().map(value).collect::<Vec<_>>())))
}
async fn one(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row =
        sqlx::query("SELECT * FROM saved_queries WHERE id=? AND (owner_id=? OR shared=1 OR ?)")
            .bind(id)
            .bind(&p.user.id)
            .bind(p.admin())
            .fetch_optional(&a.pool)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    Ok(Json(value(row)))
}
fn validate(q: &Input) -> ApiResult<()> {
    if q.name.trim().is_empty()
        || q.name.len() > 200
        || q.sql.trim().is_empty()
        || q.sql.len() > 1_000_000
    {
        return Err(bad(
            "name (1–200 bytes) and SQL (1–1000000 bytes) are required",
        ));
    }
    Ok(())
}
async fn create(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Input>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    validate(&q)?;
    let id = store::id();
    let now = store::now();
    let mut tx = a.pool.begin().await?;
    sqlx::query("INSERT INTO saved_queries(id,owner_id,name,sql,shared,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(&p.user.id).bind(q.name.trim()).bind(q.sql).bind(q.shared).bind(now).bind(now).execute(&mut *tx).await?;
    store::audit(&mut tx, "saved_query.created", &id, "").await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        one(State(a), Extension(p), Path(id)).await?,
    ))
}
async fn writable(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    p: &Principal,
    id: &str,
) -> ApiResult<()> {
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM saved_queries WHERE id=?")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    if owner != p.user.id && !p.admin() {
        return Err(forbidden());
    }
    Ok(())
}
async fn update(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Input>,
) -> ApiResult<Json<Value>> {
    validate(&q)?;
    let mut tx = a.pool.begin().await?;
    writable(&mut tx, &p, &id).await?;
    sqlx::query("UPDATE saved_queries SET name=?,sql=?,shared=?,updated_at=? WHERE id=?")
        .bind(q.name.trim())
        .bind(q.sql)
        .bind(q.shared)
        .bind(store::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "saved_query.updated", &id, "").await?;
    tx.commit().await?;
    one(State(a), Extension(p), Path(id)).await
}
async fn remove(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    writable(&mut tx, &p, &id).await?;
    sqlx::query("DELETE FROM saved_queries WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "saved_query.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
