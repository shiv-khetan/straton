use super::*;
use crate::quality::{self, Input};

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/quality/checks", get(list).post(create))
        .route(
            "/v1/quality/checks/{id}",
            get(one).put(update).delete(remove),
        )
        .route("/v1/quality/checks/{id}/run", post(run))
        .route("/v1/quality/checks/{id}/runs", get(history))
        .route("/v1/quality/runs", get(recent))
        .route("/v1/quality/summary", get(summary))
}
async fn visible(a: &App, p: &Principal, r: &sqlx::sqlite::SqliteRow) -> ApiResult<bool> {
    Ok(p.admin()
        || (r.get::<Option<&str>, _>("dataset_id").is_none()
            && r.get::<Option<&str>, _>("model_id").is_none()
            && r.get::<&str, _>("owner_id") == p.user.id)
        || quality::readable(&a.pool, p, r.get("dataset_id"), r.get("model_id")).await?)
}
async fn row(a: &App, p: &Principal, id: &str, write: bool) -> ApiResult<sqlx::sqlite::SqliteRow> {
    let r = sqlx::query("SELECT * FROM quality_checks WHERE id=?")
        .bind(id)
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))?;
    if !visible(a, p, &r).await?
        || (write && !p.admin() && r.get::<&str, _>("owner_id") != p.user.id)
    {
        return Err(forbidden());
    }
    Ok(r)
}
async fn list(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    let rows = sqlx::query("SELECT * FROM quality_checks ORDER BY name,id")
        .fetch_all(&a.pool)
        .await?;
    let mut out = vec![];
    for r in rows {
        if visible(&a, &p, &r).await? {
            out.push(quality::value(&r));
        }
    }
    Ok(Json(json!(out)))
}
async fn one(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(quality::value(&row(&a, &p, &id, false).await?)))
}
async fn save(a: App, p: Principal, id: String, q: Input, update: bool) -> ApiResult<Json<Value>> {
    if update {
        row(&a, &p, &id, true).await?;
    }
    if !p.admin()
        && (q.dataset_id.is_some() || q.model_id.is_some())
        && !quality::readable(&a.pool, &p, q.dataset_id.as_deref(), q.model_id.as_deref()).await?
    {
        return Err(forbidden());
    }
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    quality::validate(&a.sql, &q)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    if q.kind == "custom_sql" {
        crate::models::plan(
            &a.sql.for_principal(p.clone()),
            q.config["sql"].as_str().unwrap(),
        )
        .await
        .map_err(|e| bad(&e.to_string()))?;
    }
    let mut tx = a.pool.begin().await?;
    let query = if update {
        "UPDATE quality_checks SET name=?2,dataset_id=?3,model_id=?4,kind=?5,column_name=?6,config=?7,severity=?8,cron=?9,enabled=?10,last_scheduled=CASE WHEN cron IS NOT ?9 THEN ?12 ELSE last_scheduled END,updated_at=?12 WHERE id=?1"
    } else {
        "INSERT INTO quality_checks(id,name,dataset_id,model_id,kind,column_name,config,severity,cron,enabled,owner_id,created_at,updated_at,last_scheduled) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?12)"
    };
    sqlx::query(query)
        .bind(&id)
        .bind(q.name.trim())
        .bind(q.dataset_id)
        .bind(q.model_id)
        .bind(q.kind)
        .bind(q.column_name)
        .bind(q.config.to_string())
        .bind(q.severity)
        .bind(q.cron)
        .bind(q.enabled)
        .bind(&p.user.id)
        .bind(store::now())
        .execute(&mut *tx)
        .await?;
    store::audit(
        &mut tx,
        if update {
            "quality.updated"
        } else {
            "quality.created"
        },
        &id,
        "",
    )
    .await?;
    tx.commit().await?;
    one(State(a), Extension(p), Path(id)).await
}
async fn create(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Input>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        save(a, p, store::id(), q, false).await?,
    ))
}
async fn update(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Input>,
) -> ApiResult<Json<Value>> {
    save(a, p, id, q, true).await
}
async fn remove(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    row(&a, &p, &id, true).await?;
    let mut tx = a.pool.begin().await?;
    sqlx::query("DELETE FROM quality_checks WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "quality.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn run(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    row(&a, &p, &id, true).await?;
    Ok(Json(quality::run(&a.sql, &a.events, &id, None).await?))
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
    row(&a, &p, &id, false).await?;
    Ok(Json(json!(sqlx::query("SELECT * FROM quality_runs WHERE check_id=? ORDER BY started_at DESC,rowid DESC LIMIT ?").bind(id).bind(q.limit.unwrap_or(50).clamp(1,200)).fetch_all(&a.pool).await?.iter().map(quality::run_value).collect::<Vec<_>>())))
}
async fn recent(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Query(q): Query<Limit>,
) -> ApiResult<Json<Value>> {
    let checks = sqlx::query("SELECT * FROM quality_checks")
        .fetch_all(&a.pool)
        .await?;
    let mut ids = vec![];
    for r in checks {
        if visible(&a, &p, &r).await? {
            ids.push(r.get::<String, _>("id"));
        }
    }
    Ok(Json(json!(sqlx::query("SELECT * FROM quality_runs WHERE check_id IN(SELECT value FROM json_each(?)) ORDER BY started_at DESC,rowid DESC LIMIT ?").bind(json!(ids).to_string()).bind(q.limit.unwrap_or(50).clamp(1,200)).fetch_all(&a.pool).await?.iter().map(quality::run_value).collect::<Vec<_>>())))
}
async fn summary(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    let checks = sqlx::query("SELECT * FROM quality_checks")
        .fetch_all(&a.pool)
        .await?;
    let mut ids = vec![];
    let mut datasets = std::collections::BTreeMap::<String, (i64, i64)>::new();
    let (mut passed, mut failed, mut error) = (0_i64, 0_i64, 0_i64);
    for r in checks {
        if !visible(&a, &p, &r).await? {
            continue;
        }
        let id: String = r.get("id");
        ids.push(id.clone());
        let status:Option<String>=sqlx::query_scalar("SELECT status FROM quality_runs WHERE check_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1").bind(&id).fetch_optional(&a.pool).await?;
        if let Some(status) = status {
            match status.as_str() {
                "passed" => passed += 1,
                "failed" => failed += 1,
                _ => error += 1,
            };
            if let Some(d) =
                quality::dataset(&a.pool, r.get("dataset_id"), r.get("model_id")).await?
            {
                let entry = datasets.entry(d).or_default();
                entry.0 += i64::from(status == "passed");
                entry.1 += 1;
            }
        }
    }
    let score = |pass: i64, total: i64| {
        if total == 0 {
            0.0
        } else {
            100.0 * pass as f64 / total as f64
        }
    };
    let start = (store::now() / 86400 - 29) * 86400;
    let daily=sqlx::query("SELECT (started_at/86400)*86400 AS day,count(*) AS total,sum(status='passed') AS passed FROM quality_runs WHERE started_at>=? AND check_id IN(SELECT value FROM json_each(?)) GROUP BY day").bind(start).bind(json!(ids).to_string()).fetch_all(&a.pool).await?;
    let daily: Vec<_> = (0..30)
        .map(|n| {
            let day = start + n * 86400;
            let r = daily.iter().find(|r| r.get::<i64, _>("day") == day);
            let total = r.map(|r| r.get::<i64, _>("total")).unwrap_or(0);
            let pass = r.map(|r| r.get::<i64, _>("passed")).unwrap_or(0);
            json!({"day":day,"passed":pass,"total":total,"score":score(pass,total)})
        })
        .collect();
    Ok(Json(
        json!({"score":score(passed,passed+failed+error),"counts":{"passed":passed,"failed":failed,"error":error},"datasets":datasets.into_iter().map(|(id,(pass,total))|json!({"dataset_id":id,"score":score(pass,total),"passed":pass,"total":total})).collect::<Vec<_>>(),"daily":daily}),
    ))
}
