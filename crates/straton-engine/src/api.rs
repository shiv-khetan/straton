use crate::{
    backup::Backups,
    runner::{self, Events},
    store,
};
use crate::{catalog, credentials};
use axum::{
    Json, Router,
    extract::{Path, Query, State, WebSocketUpgrade},
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::{sync::Arc, time::Instant};
use straton_core::{Job, SourceKind};
use subtle::ConstantTimeEq;

#[derive(Clone)]
pub struct App {
    pub pool: SqlitePool,
    pub token: Arc<SecretString>,
    pub events: Events,
    pub backups: Backups,
    pub started: Instant,
}
pub fn router(app: App) -> Router {
    Router::new()
        .route("/v1/status", get(status))
        .route("/v1/sources", get(sources).post(create_source))
        .route(
            "/v1/sources/{id}",
            get(source).put(update_source).delete(delete_source),
        )
        .route("/v1/sources/{id}/check", post(check_source))
        .route("/v1/sources/{id}/discover", post(discover_source))
        .route("/v1/sources/{id}/datasets", post(manual_dataset))
        .route("/v1/datamap", get(datamap))
        .route("/v1/relationships", post(manual_relationship))
        .route(
            "/v1/relationships/{id}",
            axum::routing::delete(delete_relationship),
        )
        .route("/v1/jobs", get(jobs).post(create_job))
        .route("/v1/jobs/{id}", get(job).put(update_job).delete(delete_job))
        .route("/v1/jobs/{id}/run", post(run_job))
        .route("/v1/runs", get(runs))
        .route("/v1/runs/{id}/cancel", post(cancel))
        .route("/v1/backups", get(backups).post(backup))
        .route("/v1/events", get(events))
        .route_layer(middleware::from_fn_with_state(app.clone(), auth))
        .route("/health", get(|| async { Json(json!({"ok":true})) }))
        .with_state(app)
}
async fn auth(State(app): State<App>, req: Request<axum::body::Body>, next: Next) -> Response {
    let supplied = req
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    if bool::from(
        supplied
            .as_bytes()
            .ct_eq(app.token.expose_secret().as_bytes()),
    ) {
        next.run(req).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"invalid bearer token"})),
        )
            .into_response()
    }
}
struct ApiError(StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error=%e, "API operation failed");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "operation failed".into())
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(ref db) = e
            && (db.is_unique_violation() || db.is_foreign_key_violation())
        {
            return Self(
                StatusCode::CONFLICT,
                "record is referenced or already exists".into(),
            );
        }
        anyhow::Error::from(e).into()
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}
fn found(n: u64) -> ApiResult<()> {
    if n == 0 {
        Err(ApiError(StatusCode::NOT_FOUND, "not found".into()))
    } else {
        Ok(())
    }
}
async fn status(State(a): State<App>) -> ApiResult<Json<Value>> {
    let depth: i64 = sqlx::query_scalar("SELECT count(*) FROM runs WHERE state='queued'")
        .fetch_one(&a.pool)
        .await?;
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"uptime_seconds":a.started.elapsed().as_secs(),"queue_depth":depth,"last_backup":a.backups.list().await?.first()}),
    ))
}
fn source_json(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),"kind":row.get::<String,_>("kind"),"credential_id":row.get::<Option<String>,_>("credential_id"),"config":serde_json::from_str::<Value>(row.get("config")).unwrap_or(json!({}))})
}
async fn sources(State(a): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Array(
        sqlx::query("SELECT * FROM sources ORDER BY id")
            .fetch_all(&a.pool)
            .await?
            .into_iter()
            .map(source_json)
            .collect(),
    )))
}
async fn source(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = sqlx::query("SELECT * FROM sources WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?;
    Ok(Json(source_json(row.ok_or_else(|| {
        ApiError(StatusCode::NOT_FOUND, "not found".into())
    })?)))
}
async fn save_source(a: App, mut s: SourceInput, update: bool) -> ApiResult<Json<Value>> {
    if s.name.trim().is_empty() {
        return Err(bad("name is required"));
    }
    if s.id.is_empty() {
        s.id = store::id();
    }
    let kind = match s.kind {
        SourceKind::Postgres => "postgres",
        SourceKind::Sqlite => "sqlite",
        SourceKind::Csv => "csv",
        SourceKind::External => "external",
        SourceKind::Noop => "noop",
        SourceKind::Parquet => return Err(bad("parquet sources are managed by sync")),
    };
    if s.id == "straton-local-lake" {
        return Err(bad("local lake source id is reserved"));
    }
    if s.credential_id.as_deref().is_some_and(|id| id != s.id) {
        return Err(bad("credential_id must equal source id"));
    }
    validate_config(kind, &s.config)?;
    catalog::path_component(&s.id).map_err(|_| bad("invalid source id"))?;
    let mut tx = a.pool.begin().await?;
    let query = if update {
        "UPDATE sources SET name=?2,kind=?3,credential_id=COALESCE(?4,credential_id),config=?5 WHERE id=?1"
    } else {
        "INSERT INTO sources(id,name,kind,credential_id,config) VALUES(?1,?2,?3,?4,?5)"
    };
    found(
        sqlx::query(query)
            .bind(&s.id)
            .bind(&s.name)
            .bind(kind)
            .bind(
                s.secret
                    .as_ref()
                    .map(|_| s.id.as_str())
                    .or(s.credential_id.as_deref()),
            )
            .bind(s.config.to_string())
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(
        &mut tx,
        if update {
            "source.updated"
        } else {
            "source.created"
        },
        &s.id,
        "",
    )
    .await?;
    if let Some(secret) = s.secret.take() {
        credentials::set(&s.id, &secret)?;
    }
    tx.commit().await?;
    source(State(a), Path(s.id)).await
}
async fn create_source(
    State(a): State<App>,
    Json(s): Json<SourceInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((StatusCode::CREATED, save_source(a, s, false).await?))
}
async fn update_source(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(mut s): Json<SourceInput>,
) -> ApiResult<Json<Value>> {
    s.id = id;
    save_source(a, s, true).await
}
async fn delete_source(State(a): State<App>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("DELETE FROM sources WHERE id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "source.deleted", &id, "").await?;
    credentials::delete(&id)?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
fn job_json(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),"source_id":row.get::<Option<String>,_>("source_id"),"dataset":row.get::<String,_>("dataset"),"cron":row.get::<Option<String>,_>("cron"),"enabled":row.get::<bool,_>("enabled"),"builtin":row.get::<bool,_>("builtin")})
}
async fn jobs(State(a): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Array(
        sqlx::query("SELECT * FROM jobs ORDER BY id")
            .fetch_all(&a.pool)
            .await?
            .into_iter()
            .map(job_json)
            .collect(),
    )))
}
async fn job(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = sqlx::query("SELECT * FROM jobs WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?;
    Ok(Json(job_json(row.ok_or_else(|| {
        ApiError(StatusCode::NOT_FOUND, "not found".into())
    })?)))
}
async fn save_job(a: App, mut j: Job, update: bool) -> ApiResult<Json<Value>> {
    if j.name.trim().is_empty() || j.dataset.trim().is_empty() {
        return Err(bad("name and dataset are required"));
    }
    if let Some(ref cron) = j.cron {
        cron.parse::<cron::Schedule>()
            .map_err(|_| bad("invalid cron expression (use seconds field)"))?;
    }
    if j.id.is_empty() {
        j.id = store::id();
    }
    if j.id == "builtin-backup" {
        return Err(bad("configure the built-in backup through backup.cron"));
    }
    let mut tx = a.pool.begin().await?;
    let query = if update {
        "UPDATE jobs SET name=?2,source_id=?3,dataset=?4,cron=?5,enabled=?6,last_scheduled=CASE WHEN cron IS NOT ?5 THEN ?7 ELSE last_scheduled END WHERE id=?1 AND builtin=0"
    } else {
        "INSERT INTO jobs(id,name,source_id,dataset,cron,enabled,last_scheduled) VALUES(?1,?2,?3,?4,?5,?6,?7)"
    };
    found(
        sqlx::query(query)
            .bind(&j.id)
            .bind(&j.name)
            .bind(&j.source_id)
            .bind(&j.dataset)
            .bind(&j.cron)
            .bind(j.enabled)
            .bind(store::now())
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(
        &mut tx,
        if update { "job.updated" } else { "job.created" },
        &j.id,
        "",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!(j)))
}
async fn create_job(
    State(a): State<App>,
    Json(j): Json<Job>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((StatusCode::CREATED, save_job(a, j, false).await?))
}
async fn update_job(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(mut j): Json<Job>,
) -> ApiResult<Json<Value>> {
    j.id = id;
    save_job(a, j, true).await
}
async fn delete_job(State(a): State<App>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    found(
        sqlx::query("DELETE FROM jobs WHERE id=? AND builtin=0")
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected(),
    )?;
    store::audit(&mut tx, "job.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn run_job(
    State(a): State<App>,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let mut tx = a.pool.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?)")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if !exists {
        return Err(ApiError(StatusCode::NOT_FOUND, "not found".into()));
    }
    let run = store::enqueue(&mut tx, &id, store::now()).await?;
    tx.commit().await?;
    runner::event(&a.events, &run, "queued");
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id":run,"state":"queued"})),
    ))
}
#[derive(Deserialize)]
struct RunQuery {
    job: Option<String>,
    state: Option<String>,
}
async fn runs(State(a): State<App>, Query(q): Query<RunQuery>) -> ApiResult<Json<Value>> {
    if let Some(ref state) = q.state {
        serde_json::from_value::<straton_core::RunState>(json!(state))
            .map_err(|_| bad("invalid run state"))?;
    }
    let rows=sqlx::query("SELECT * FROM runs WHERE (?1 IS NULL OR job_id=?1) AND (?2 IS NULL OR state=?2) ORDER BY created_at DESC,id")
        .bind(q.job).bind(q.state).fetch_all(&a.pool).await?;
    Ok(Json(json!(rows.into_iter().map(|r| json!({"id":r.get::<String,_>("id"),"job_id":r.get::<String,_>("job_id"),"state":r.get::<String,_>("state"),"attempt":r.get::<i64,_>("attempt"),"available_at":r.get::<i64,_>("available_at"),"error":r.get::<Option<String>,_>("error"),"committed_batches":r.get::<i64,_>("committed_batches")})).collect::<Vec<_>>())))
}
async fn cancel(State(a): State<App>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    let next: Option<String>=sqlx::query_scalar("UPDATE runs SET cancel_requested=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated_at=? WHERE id=? AND state IN ('queued','running') RETURNING state")
        .bind(store::now()).bind(&id).fetch_optional(&mut *tx).await?;
    let next = next.ok_or_else(|| {
        ApiError(
            StatusCode::CONFLICT,
            "run is missing or already finished".into(),
        )
    })?;
    store::audit(&mut tx, "run.cancel_requested", &id, "").await?;
    if next == "cancelled" {
        store::audit(&mut tx, "run.cancelled", &id, "").await?;
    }
    tx.commit().await?;
    if next == "cancelled" {
        runner::event(&a.events, &id, &next);
    }
    Ok(StatusCode::ACCEPTED)
}
async fn backups(State(a): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(a.backups.list().await?)))
}
async fn backup(State(a): State<App>) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        Json(json!({"file":a.backups.create(&a.pool).await?})),
    ))
}
async fn events(State(a): State<App>, ws: WebSocketUpgrade) -> Response {
    let mut rx = a.events.subscribe();
    ws.on_upgrade(move |mut socket| async move {
        loop {
            tokio::select! {
                event=rx.recv() => match event {
                    Ok(value) => if socket.send(axum::extract::ws::Message::Text(value.to_string().into())).await.is_err() { break; },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if socket.send(axum::extract::ws::Message::Text(json!({"type":"resync_required"}).to_string().into())).await.is_err() { break; }
                    },
                    Err(_) => break,
                },
                message=socket.recv() => match message {
                    None | Some(Err(_)) | Some(Ok(axum::extract::ws::Message::Close(_))) => break,
                    _ => {},
                }
            }
        }
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceInput {
    #[serde(default)]
    id: String,
    name: String,
    kind: SourceKind,
    #[serde(default)]
    credential_id: Option<String>,
    #[serde(default = "empty_config")]
    config: Value,
    #[serde(default, deserialize_with = "read_secret")]
    secret: Option<SecretString>,
}
fn empty_config() -> Value {
    json!({})
}
fn read_secret<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<SecretString>, D::Error> {
    Ok(Option::<String>::deserialize(d)?.map(Into::into))
}
fn validate_config(kind: &str, config: &Value) -> ApiResult<()> {
    let obj = config
        .as_object()
        .ok_or_else(|| bad("config must be an object"))?;
    let allowed: &[&str] = match kind {
        "postgres" => &["host", "port", "database", "username", "batch_size"],
        "sqlite" => &["path", "batch_size"],
        "csv" => &["path", "batch_size", "sample_size"],
        _ => &[],
    };
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(bad(
            "unsupported config field; supply credentials only in secret",
        ));
    }
    for (k, v) in obj {
        if ["port", "batch_size", "sample_size"].contains(&k.as_str()) {
            if v.as_u64().is_none_or(|v| v == 0 || v > i32::MAX as u64) {
                return Err(bad("invalid numeric config field"));
            }
        } else if !v.is_string() {
            return Err(bad("config field must be a string"));
        }
    }
    if kind != "external" {
        straton_connectors::build(kind, config, None)
            .map_err(|_| bad("invalid connector configuration"))?;
    }
    Ok(())
}
fn changed(a: &App) {
    let _ = a.events.send(json!({"type":"catalog.changed"}));
}
async fn check_source(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    catalog::connector(&a.pool, &id)
        .await?
        .check()
        .await
        .map_err(anyhow::Error::from)?;
    Ok(Json(json!({"ok":true})))
}
async fn discover_source(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    catalog::discover(&a.pool, &id).await?;
    changed(&a);
    Ok(Json(json!({"ok":true})))
}
async fn datamap(State(a): State<App>) -> ApiResult<Json<Value>> {
    Ok(Json(catalog::datamap(&a.pool).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManualDataset {
    name: String,
    columns: Vec<ManualColumn>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManualColumn {
    name: String,
    #[serde(rename = "type", alias = "data_type")]
    data_type: String,
    nullable: bool,
    #[serde(default, alias = "primary_key")]
    pk: bool,
}
async fn manual_dataset(
    State(a): State<App>,
    Path(id): Path<String>,
    Json(d): Json<ManualDataset>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if d.name.trim().is_empty() || d.columns.is_empty() {
        return Err(bad("name and columns required"));
    }
    let mut names = std::collections::HashSet::new();
    for c in &d.columns {
        if c.name.trim().is_empty() || c.data_type.trim().is_empty() || !names.insert(&c.name) {
            return Err(bad("invalid or duplicate column"));
        }
    }
    let mut tx = a.pool.begin().await?;
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM sources WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    if kind.as_deref() != Some("external") {
        return Err(bad("manual datasets require an external source"));
    }
    let did = store::id();
    sqlx::query("INSERT INTO datasets(id,source_id,name) VALUES(?,?,?)")
        .bind(&did)
        .bind(&id)
        .bind(&d.name)
        .execute(&mut *tx)
        .await?;
    for c in d.columns {
        sqlx::query("INSERT INTO columns(id,dataset_id,name,data_type,nullable,primary_key) VALUES(?,?,?,?,?,?)").bind(store::id()).bind(&did).bind(c.name).bind(c.data_type).bind(c.nullable).bind(c.pk).execute(&mut *tx).await?;
    }
    store::audit(&mut tx, "dataset.created", &did, "").await?;
    tx.commit().await?;
    changed(&a);
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":did,"source_id":id,"name":d.name})),
    ))
}
async fn manual_relationship(
    State(a): State<App>,
    Json(mut r): Json<straton_core::Relationship>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if !matches!(r.kind, straton_core::RelationshipKind::Manual) {
        return Err(bad("only manual relationships can be created"));
    }
    if r.from_cols.is_empty() || r.from_cols.len() != r.to_cols.len() {
        return Err(bad("matching nonempty column lists required"));
    }
    r.id = store::id();
    r.confidence = None;
    let mut tx = a.pool.begin().await?;
    for (id, cols) in [(&r.from_dataset, &r.from_cols), (&r.to_dataset, &r.to_cols)] {
        let mut names = std::collections::HashSet::new();
        for col in cols {
            if !names.insert(col) {
                return Err(bad("duplicate column"));
            }
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM columns WHERE dataset_id=? AND name=?)",
            )
            .bind(id)
            .bind(col)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(bad("unknown dataset column"));
            }
        }
    }
    catalog::edge(&mut tx, &r).await?;
    store::audit(&mut tx, "relationship.created", &r.id, "").await?;
    tx.commit().await?;
    changed(&a);
    Ok((StatusCode::CREATED, Json(json!(r))))
}
async fn delete_relationship(
    State(a): State<App>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let mut tx = a.pool.begin().await?;
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM relationships WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    match kind.as_deref() {
        None => return Err(ApiError(StatusCode::NOT_FOUND, "not found".into())),
        Some("manual") => {}
        _ => {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "only manual relationships can be deleted".into(),
            ));
        }
    }
    sqlx::query("DELETE FROM relationships WHERE id=? AND kind='manual'")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "relationship.deleted", &id, "").await?;
    tx.commit().await?;
    changed(&a);
    Ok(StatusCode::NO_CONTENT)
}
