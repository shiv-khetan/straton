use super::*;
use crate::pipeline::{self, Input};

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/pipelines", get(list).post(create))
        .route("/v1/pipelines/validate", post(validate))
        .route("/v1/pipelines/{id}", get(one).put(update).delete(remove))
        .route("/v1/pipelines/{id}/run", post(run))
        .route("/v1/pipelines/{id}/runs", get(history))
        .route("/v1/pipeline-runs/{id}", get(run_detail))
        .route("/v1/pipeline-runs/{id}/cancel", post(cancel))
}
async fn row(a: &App, p: &Principal, id: &str) -> ApiResult<sqlx::sqlite::SqliteRow> {
    let r = sqlx::query("SELECT * FROM pipelines WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    if !p.admin() && r.get::<&str, _>("owner_id") != p.user.id {
        return Err(forbidden());
    }
    Ok(r)
}
fn value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"cron":r.get::<Option<String>,_>("cron"),"enabled":r.get::<bool,_>("enabled"),"owner_id":r.get::<String,_>("owner_id"),"last_scheduled":r.get::<i64,_>("last_scheduled"),"created_at":r.get::<i64,_>("created_at"),"updated_at":r.get::<i64,_>("updated_at")})
}
async fn list(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(
        sqlx::query("SELECT * FROM pipelines WHERE owner_id=? OR ? ORDER BY name,id")
            .bind(&p.user.id)
            .bind(p.admin())
            .fetch_all(&a.pool)
            .await?
            .iter()
            .map(value)
            .collect::<Vec<_>>()
    )))
}
async fn one(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut v = value(&row(&a, &p, &id).await?);
    let q = pipeline::graph(&a.pool, &id).await?;
    v["nodes"] = json!(q.nodes);
    v["edges"] = json!(q.edges);
    Ok(Json(v))
}
async fn validate(State(a): State<App>, Json(q): Json<Input>) -> ApiResult<Json<Value>> {
    Ok(Json(pipeline::validate(&a.pool, &q).await?))
}
async fn save(a: App, p: Principal, id: String, q: Input, update: bool) -> ApiResult<Response> {
    let _save = pipeline::SAVES.lock().await;
    if update {
        row(&a, &p, &id).await?;
    }
    let validation = pipeline::validate(&a.pool, &q).await?;
    if validation["valid"] != true {
        return Ok((StatusCode::UNPROCESSABLE_ENTITY, Json(validation)).into_response());
    }
    for n in &q.nodes {
        if !pipeline::allowed(&a.pool, &p, n).await? {
            return Err(forbidden());
        }
    }
    let mut tx = a.pool.begin().await?;
    if update {
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pipeline_runs WHERE pipeline_id=? AND state IN ('queued','running'))").bind(&id).fetch_one(&mut *tx).await?;
        if active {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "wait for active pipeline runs before editing".into(),
            ));
        }
        sqlx::query("UPDATE pipelines SET name=?,description=?,last_scheduled=CASE WHEN cron IS NOT ? THEN ? ELSE last_scheduled END,cron=?,enabled=?,updated_at=? WHERE id=?").bind(q.name.trim()).bind(&q.description).bind(&q.cron).bind(store::now()).bind(&q.cron).bind(q.enabled).bind(store::now()).bind(&id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM pipeline_nodes WHERE pipeline_id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("INSERT INTO pipelines(id,name,description,cron,enabled,owner_id,last_scheduled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(&id).bind(q.name.trim()).bind(q.description).bind(q.cron).bind(q.enabled).bind(&p.user.id).bind(store::now()).bind(store::now()).bind(store::now()).execute(&mut *tx).await?;
    }
    for n in q.nodes {
        sqlx::query("INSERT INTO pipeline_nodes(pipeline_id,node_id,kind,ref_id,label,x,y) VALUES(?,?,?,?,?,?,?)").bind(&id).bind(n.node_id).bind(n.kind).bind(n.ref_id).bind(n.label).bind(n.x).bind(n.y).execute(&mut *tx).await?;
    }
    for e in q.edges {
        sqlx::query("INSERT INTO pipeline_edges(pipeline_id,from_node,to_node) VALUES(?,?,?)")
            .bind(&id)
            .bind(e.from_node)
            .bind(e.to_node)
            .execute(&mut *tx)
            .await?;
    }
    store::audit(
        &mut tx,
        if update {
            "pipeline.updated"
        } else {
            "pipeline.created"
        },
        &id,
        "",
    )
    .await?;
    tx.commit().await?;
    Ok((
        if update {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        one(State(a), Extension(p), Path(id)).await?,
    )
        .into_response())
}
async fn create(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Input>,
) -> ApiResult<Response> {
    save(a, p, store::id(), q, false).await
}
async fn update(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Input>,
) -> ApiResult<Response> {
    save(a, p, id, q, true).await
}
async fn remove(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let _save = pipeline::SAVES.lock().await;
    row(&a, &p, &id).await?;
    let mut tx = a.pool.begin().await?;
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pipeline_runs WHERE pipeline_id=? AND state IN ('queued','running'))").bind(&id).fetch_one(&mut *tx).await?;
    if active {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "pipeline has an active run".into(),
        ));
    }
    sqlx::query("DELETE FROM pipelines WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "pipeline.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn run(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let _save = pipeline::SAVES.lock().await;
    row(&a, &p, &id).await?;
    let q = pipeline::graph(&a.pool, &id).await?;
    let validation = pipeline::validate(&a.pool, &q).await?;
    if validation["valid"] != true {
        return Err(bad("pipeline references are no longer valid"));
    }
    for n in &q.nodes {
        if !pipeline::allowed(&a.pool, &p, n).await? {
            return Err(forbidden());
        }
    }
    let mut tx = a.pool.begin().await?;
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pipeline_runs WHERE pipeline_id=? AND state IN ('queued','running'))").bind(&id).fetch_one(&mut *tx).await?;
    if active {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "pipeline already has an active run".into(),
        ));
    }
    let run = pipeline::enqueue(&mut tx, &id, "manual").await?;
    tx.commit().await?;
    pipeline::start(a.sql, a.events, run.clone());
    Ok((StatusCode::ACCEPTED, Json(json!({"id":run}))))
}
fn run_value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"pipeline_id":r.get::<String,_>("pipeline_id"),"state":r.get::<String,_>("state"),"trigger":r.get::<String,_>("trigger"),"started_at":r.get::<Option<i64>,_>("started_at"),"finished_at":r.get::<Option<i64>,_>("finished_at"),"error":r.get::<Option<String>,_>("error")})
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Limit {
    limit: Option<i64>,
}
async fn history(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Query(q): Query<Limit>,
) -> ApiResult<Json<Value>> {
    row(&a, &p, &id).await?;
    Ok(Json(json!(
        sqlx::query("SELECT * FROM pipeline_runs WHERE pipeline_id=? ORDER BY rowid DESC LIMIT ?")
            .bind(id)
            .bind(q.limit.unwrap_or(50).clamp(1, 200))
            .fetch_all(&a.pool)
            .await?
            .iter()
            .map(run_value)
            .collect::<Vec<_>>()
    )))
}
async fn run_row(a: &App, p: &Principal, id: &str) -> ApiResult<sqlx::sqlite::SqliteRow> {
    let r = sqlx::query("SELECT * FROM pipeline_runs WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    row(a, p, r.get("pipeline_id")).await?;
    Ok(r)
}
async fn run_detail(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut v = run_value(&run_row(&a, &p, &id).await?);
    v["nodes"]=json!(sqlx::query("SELECT * FROM pipeline_run_nodes WHERE run_id=? ORDER BY node_id").bind(id).fetch_all(&a.pool).await?.iter().map(|r|json!({"node_id":r.get::<String,_>("node_id"),"state":r.get::<String,_>("state"),"child_run_id":r.get::<Option<String>,_>("child_run_id"),"started_at":r.get::<Option<i64>,_>("started_at"),"finished_at":r.get::<Option<i64>,_>("finished_at"),"error":r.get::<Option<String>,_>("error")})).collect::<Vec<_>>());
    Ok(Json(v))
}
async fn cancel(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    run_row(&a, &p, &id).await?;
    if !pipeline::cancel(&a.pool, &a.events, &id).await? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "pipeline run is already terminal".into(),
        ));
    }
    Ok(StatusCode::ACCEPTED)
}
