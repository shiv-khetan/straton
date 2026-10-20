use super::*;
use crate::models::{self, Input};

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/models", get(list).post(create))
        .route("/v1/models/validate", post(validate))
        .route("/v1/models/{id}", get(one).put(update).delete(delete))
        .route("/v1/models/{id}/run", post(run))
        .route("/v1/models/{id}/explain", get(explain))
        .route("/v1/models/{id}/lineage", get(lineage))
}
fn json_model(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"sql":r.get::<String,_>("sql"),"materialization":r.get::<String,_>("materialization"),"trigger":r.get::<String,_>("trigger"),"cron":r.get::<Option<String>,_>("cron"),"owner_id":r.get::<String,_>("owner_id"),"optimize":r.get::<bool,_>("optimize"),"created_at":r.get::<i64,_>("created_at"),"updated_at":r.get::<i64,_>("updated_at"),"status":r.get::<String,_>("status"),"error":r.get::<Option<String>,_>("error"),"last_run":r.get::<Option<i64>,_>("last_run"),"last_run_status":r.get::<Option<String>,_>("last_run_status"),"row_count":r.get::<Option<i64>,_>("row_count")})
}
async fn protected_json(a: &App, p: &Principal, r: &sqlx::sqlite::SqliteRow) -> ApiResult<Value> {
    let mut value = json_model(r);
    let frame = crate::policies::schema_frame(&a.pool, r.get("dataset_id")).await?;
    let policy =
        crate::policies::effective(&a.pool, p, models::SOURCE, r.get("dataset_id"), &frame).await?;
    if policy.is_none_or(|policy| policy.filtered) {
        value["row_count"] = Value::Null;
    }
    Ok(value)
}
const SELECT: &str = "SELECT m.*, d.id AS dataset_id,d.row_count,(SELECT r.updated_at FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.model_id=m.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS last_run,(SELECT r.state FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.model_id=m.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1) AS last_run_status FROM models m JOIN datasets d ON d.source_id='straton-models' AND d.name=m.name";
fn editable(p: &Principal, r: &sqlx::sqlite::SqliteRow) -> bool {
    p.admin() || p.user.id == r.get::<&str, _>("owner_id")
}
fn visible(p: &Principal, r: &sqlx::sqlite::SqliteRow) -> bool {
    editable(p, r) || !p.read_roles(models::SOURCE, r.get("dataset_id")).is_empty()
}
async fn row(a: &App, id: &str) -> ApiResult<sqlx::sqlite::SqliteRow> {
    sqlx::query(&format!("{SELECT} WHERE m.id=?"))
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))
}
async fn list(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!("{SELECT} ORDER BY m.name"))
        .fetch_all(&a.pool)
        .await?;
    let mut out = vec![];
    for r in rows.iter().filter(|r| visible(&p, r)) {
        out.push(protected_json(&a, &p, r).await?);
    }
    Ok(Json(json!(out)))
}

async fn one(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let r = row(&a, &id).await?;
    if !visible(&p, &r) {
        return Err(forbidden());
    }
    Ok(Json(protected_json(&a, &p, &r).await?))
}
async fn save(a: App, p: Principal, id: String, m: Input, update: bool) -> ApiResult<Json<Value>> {
    let _save = models::SAVES.lock().await;
    models::validate_input(&m).map_err(|e| bad(&e.to_string()))?;
    let owner = if update {
        let r = row(&a, &id).await?;
        if !editable(&p, &r) {
            return Err(forbidden());
        }
        // Changing definitions while queued/running would change the meaning of an existing run.
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.model_id=? AND r.state IN ('queued','running','interrupted'))").bind(&id).fetch_one(&a.pool).await?;
        if active {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "wait for active model runs before editing".into(),
            ));
        }
        r.get::<String, _>("owner_id")
    } else {
        p.user.id.clone()
    };
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    let owner = crate::access::principal(&a.pool, &owner).await?;
    let (frame, deps) = models::plan(&a.sql.for_principal(owner.clone()), &m.sql)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    models::check_cycle(&a.pool, &id, &m.name, &deps)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    // Planning runs as the owner; creation additionally requires the actor to read every input.
    if !update && !p.admin() {
        for d in &deps.datasets {
            let source: String = sqlx::query_scalar("SELECT source_id FROM datasets WHERE id=?")
                .bind(d)
                .fetch_one(&a.pool)
                .await?;
            if p.read_roles(&source, d).is_empty() {
                return Err(forbidden());
            }
        }
    }
    let mut tx = a.pool.begin().await?;
    if update {
        let old: String = sqlx::query_scalar("SELECT name FROM models WHERE id=?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
        sqlx::query("UPDATE datasets SET name=?,row_count=CASE WHEN name!=? THEN NULL ELSE row_count END,last_synced_at=CASE WHEN name!=? THEN NULL ELSE last_synced_at END WHERE source_id='straton-models' AND name=?").bind(&m.name).bind(&m.name).bind(&m.name).bind(old).execute(&mut *tx).await?;
        sqlx::query("UPDATE models SET name=?,sql=?,materialization=?,trigger=?,cron=?,optimize=?,updated_at=?,status='ready',error=NULL WHERE id=?").bind(&m.name).bind(&m.sql).bind(&m.materialization).bind(&m.trigger).bind(&m.cron).bind(m.optimize).bind(store::now()).bind(&id).execute(&mut *tx).await?;
    } else {
        sqlx::query("INSERT INTO models(id,name,sql,materialization,trigger,cron,owner_id,optimize,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(&id).bind(&m.name).bind(&m.sql).bind(&m.materialization).bind(&m.trigger).bind(&m.cron).bind(&owner.user.id).bind(m.optimize).bind(store::now()).bind(store::now()).execute(&mut *tx).await?;
    }
    models::catalog_model(&mut tx, &id, &m.name, frame.schema().as_arrow(), &deps).await?;
    sqlx::query("INSERT INTO jobs(id,name,source_id,dataset,cron,enabled,last_scheduled,model_id) VALUES(?,?,'straton-models',?,?,?,?,?) ON CONFLICT(model_id) WHERE model_id IS NOT NULL DO UPDATE SET name=excluded.name,dataset=excluded.dataset,cron=excluded.cron,enabled=excluded.enabled,last_scheduled=CASE WHEN jobs.cron IS NOT excluded.cron THEN excluded.last_scheduled ELSE jobs.last_scheduled END")
        .bind(store::id()).bind(&m.name).bind(&m.name).bind(if m.trigger=="cron"{m.cron.as_deref()}else{None}).bind(m.materialization=="table").bind(store::now()).bind(&id).execute(&mut *tx).await?;
    store::audit(
        &mut tx,
        if update {
            "model.updated"
        } else {
            "model.created"
        },
        &id,
        "",
    )
    .await?;
    tx.commit().await?;
    models::revalidate(&a.sql, &id).await?;
    let _ = a.events.send(json!({"type":"catalog.changed"}));
    one(State(a), Extension(p), Path(id)).await
}
async fn create(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(m): Json<Input>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        save(a, p, store::id(), m, false).await?,
    ))
}
async fn update(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(m): Json<Input>,
) -> ApiResult<Json<Value>> {
    save(a, p, id, m, true).await
}
async fn validate(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(m): Json<Input>,
) -> ApiResult<Json<Value>> {
    models::validate_input(&m).map_err(|e| bad(&e.to_string()))?;
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    let (frame, _) = models::plan(&a.sql.for_principal(p), &m.sql)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    Ok(Json(
        json!({"valid":true,"columns":crate::sql::columns(frame.schema().as_arrow())}),
    ))
}
async fn delete(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let _save = models::SAVES.lock().await;
    let r = row(&a, &id).await?;
    if !editable(&p, &r) {
        return Err(forbidden());
    }
    let referenced:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM model_deps WHERE upstream_model_id=?) OR EXISTS(SELECT 1 FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.model_id=? AND r.state IN ('queued','running','interrupted'))").bind(&id).bind(&id).fetch_one(&a.pool).await?;
    if referenced {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "model has dependents or active runs".into(),
        ));
    }
    let mut tx = a.pool.begin().await?;
    // Preserve historical runs by detaching their job from the deleted model.
    sqlx::query("UPDATE jobs SET model_id=NULL,enabled=0,cron=NULL WHERE model_id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM relationships WHERE from_dataset=?1 OR to_dataset=?1")
        .bind(r.get::<&str, _>("dataset_id"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM models WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM columns WHERE dataset_id=?")
        .bind(r.get::<&str, _>("dataset_id"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM datasets WHERE id=?")
        .bind(r.get::<&str, _>("dataset_id"))
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "model.deleted", &id, "").await?;
    tx.commit().await?;
    let _ = a.events.send(json!({"type":"catalog.changed"}));
    Ok(StatusCode::NO_CONTENT)
}
async fn run(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let _save = models::SAVES.lock().await;
    let r = row(&a, &id).await?;
    if !editable(&p, &r) {
        return Err(forbidden());
    }
    if r.get::<&str, _>("materialization") == "view" {
        return Err(bad("view models are evaluated on query and cannot run"));
    }
    if r.get::<&str, _>("status") == "broken" {
        return Err(bad("model is broken; edit and validate it before running"));
    }
    let job: String = sqlx::query_scalar("SELECT id FROM jobs WHERE model_id=?")
        .bind(&id)
        .fetch_one(&a.pool)
        .await?;
    let mut tx = a.pool.begin().await?;
    let run = store::enqueue(&mut tx, &job, store::now()).await?;
    store::audit(&mut tx, "model.run", &id, &run).await?;
    tx.commit().await?;
    runner::event(&a.events, &run, "queued");
    Ok((StatusCode::ACCEPTED, Json(json!({"id":run}))))
}
async fn explain(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let r = row(&a, &id).await?;
    if !editable(&p, &r) {
        return Err(forbidden());
    }
    let owner = crate::access::principal(&a.pool, r.get("owner_id")).await?;
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    let sql = a.sql.for_principal(owner);
    let (ctx, _) = sql.context().await.map_err(|e| bad(&e.to_string()))?;
    let frame = sql
        .plan(&ctx, r.get("sql"), &[])
        .await
        .map_err(|e| bad(&e.to_string()))?;
    let out = crate::optimizer::explain(frame, r.get("optimize"))
        .await
        .map_err(|e| bad(&e.to_string()))?;
    Ok(Json(out))
}
async fn lineage(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let r = row(&a, &id).await?;
    if !visible(&p, &r) {
        return Err(forbidden());
    }
    let map = catalog::datamap(&a.pool).await?;
    let dataset = r.get::<&str, _>("dataset_id");
    let mut upstream = vec![];
    let mut downstream = vec![];
    for e in map["edges"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "lineage")
    {
        for (end, list) in [
            ("from_dataset", &mut upstream),
            ("to_dataset", &mut downstream),
        ] {
            let opposite = if end == "from_dataset" {
                "to_dataset"
            } else {
                "from_dataset"
            };
            if e[opposite] == dataset
                && let Some(n) = map["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|n| n["id"] == e[end])
                && (p.admin()
                    || !p
                        .read_roles(n["source_id"].as_str().unwrap(), n["id"].as_str().unwrap())
                        .is_empty())
            {
                list.push(json!({"id":n["id"],"name":n["name"],"sql_schema":n["sql_schema"],"sql_table":n["sql_table"],"source_id":n["source_id"]}));
            }
        }
    }
    Ok(Json(json!({"upstream":upstream,"downstream":downstream})))
}
