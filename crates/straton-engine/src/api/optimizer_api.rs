use super::*;
use crate::{advisor, lake_layout};
pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/optimizer/datasets/{id}", get(dataset))
        .route("/v1/optimizer/datasets/{id}/relayout", post(relayout))
        .route("/v1/advisor", get(recommendations))
        .route("/v1/advisor/refresh", post(refresh))
        .route("/v1/advisor/{id}/apply", post(apply))
        .route("/v1/advisor/{id}/rollback", post(rollback))
        .route("/v1/advisor/{id}/dismiss", post(dismiss))
}
async fn dataset(State(a): State<App>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let d =
        sqlx::query("SELECT id,source_id,name,row_count,last_synced_at FROM datasets WHERE id=?")
            .bind(&id)
            .fetch_optional(&a.pool)
            .await?
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "dataset not found".into()))?;
    let source: &str = d.get("source_id");
    let name: &str = d.get("name");
    let (source, name) = if source == "straton-local-lake" {
        name.split_once('/')
            .ok_or_else(|| bad("invalid lake dataset"))?
    } else {
        (source, name)
    };
    let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM datasets WHERE (source_id=?1 AND name=?2) OR (source_id='straton-local-lake' AND name=?1 || '/' || ?2)").bind(source).bind(name).fetch_all(&a.pool).await?;
    let stats=sqlx::query("SELECT column,role,op,SUM(count) AS count,SUM(rows_scanned) AS rows_scanned,SUM(rows_returned) AS rows_returned,SUM(elapsed_ms) AS elapsed_ms,MAX(last_seen) AS last_seen FROM query_stats WHERE dataset_id IN (SELECT value FROM json_each(?)) GROUP BY column,role,op ORDER BY count DESC,column,role,op").bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?).fetch_all(&a.pool).await?.into_iter().map(|r|json!({"column":r.get::<String,_>("column"),"role":r.get::<String,_>("role"),"op":r.get::<String,_>("op"),"count":r.get::<i64,_>("count"),"rows_scanned":r.get::<i64,_>("rows_scanned"),"rows_returned":r.get::<i64,_>("rows_returned"),"elapsed_ms":r.get::<i64,_>("elapsed_ms"),"last_seen":r.get::<i64,_>("last_seen")})).collect::<Vec<_>>();
    let layout=sqlx::query("SELECT * FROM dataset_layout WHERE dataset_id=?").bind(&id).fetch_optional(&a.pool).await?.map(|r|json!({"sort_column":r.get::<Option<String>,_>("sort_column"),"bloom_columns":serde_json::from_str::<Value>(r.get("bloom_columns")).unwrap_or(json!([])),"row_group_size":r.get::<i64,_>("row_group_size"),"reason":r.get::<String,_>("reason"),"updated_at":r.get::<i64,_>("updated_at")}));
    let (next, _) = lake_layout::decision(&a.pool, &ids).await?;
    let _pin = crate::sql::SNAPSHOTS.read().await;
    let dir = a.sql.data_dir.join("data").join(source).join(name);
    let hash_index = match tokio::fs::read_to_string(dir.join("_current")).await {
        Ok(current) if uuid::Uuid::parse_str(&current).is_ok() => {
            crate::hash_lookup::status(&a.pool, &dir.join(current)).await
        }
        _ => crate::hash_lookup::Status::default(),
    };
    Ok(Json(
        json!({"dataset_id":id,"source_id":d.get::<String,_>("source_id"),"name":d.get::<String,_>("name"),"stats":stats,"layout":layout,"next_layout":next,"hash_index":hash_index,"metrics_note":"Scan counters are decoded scan output plus pushed-down rejected rows, after row-group/page pruning. Returned rows and elapsed time describe the whole query; per-column counters overlap. Bounded telemetry may drop samples under backpressure."}),
    ))
}
async fn relayout(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !p.admin() {
        return Err(forbidden());
    }
    let actor = p.user.id;
    let result=tokio::spawn(async move{store::ACTOR.scope(actor.clone(),async move{
  let _pin=crate::sql::SNAPSHOTS.write().await;
  let d=sqlx::query("SELECT source_id,name FROM datasets WHERE id=?").bind(&id).fetch_one(&a.pool).await?;
  let s:String=d.get("source_id");let t:String=d.get("name");
  let(s,t)=if s=="straton-local-lake"{let(s,t)=t.split_once('/').ok_or_else(||anyhow::anyhow!("invalid lake dataset"))?;(s.to_owned(),t.to_owned())}else{(s,t)};
  catalog::path_component(&s)?;catalog::path_component(&t)?;
  let dir=a.sql.data_dir.join("data").join(&s).join(&t);
  let current=tokio::fs::read_to_string(dir.join("_current")).await?;
  anyhow::ensure!(uuid::Uuid::parse_str(&current).is_ok(),"invalid snapshot");let path=dir.join(current);lake_layout::recover(&path)?;
  anyhow::ensure!(path.canonicalize()?.parent()==Some(dir.canonicalize()?.as_path()),"snapshot escapes dataset");
  let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM datasets WHERE (source_id=?1 AND name=?2) OR (source_id='straton-local-lake' AND name=?1 || '/' || ?2)").bind(&s).bind(&t).fetch_all(&a.pool).await?;
  let key=crate::keys::snapshot(&a.pool,&path).await?;let(layout,bloom)=lake_layout::decision(&a.pool,&ids).await?;
  let mut tx=a.pool.begin().await?;store::audit(&mut tx,"optimizer.relayout.started",&id,"").await?;tx.commit().await?;
  let result=lake_layout::rewrite(&a.pool,&path,key.as_ref(),layout,&bloom).await;
  if let Err(error)=&result{tracing::warn!(dataset_id=%id,%error,"lake relayout failed; previous snapshot retained");}
  let mut tx=a.pool.begin().await?;
  if let Ok(layout)=&result{lake_layout::persist(&mut tx,&ids,layout).await?;}
  store::audit(&mut tx,"optimizer.relayout",&id,if result.is_ok(){"succeeded"}else{"failed; previous snapshot retained"}).await?;tx.commit().await?;
  let layout=result?;changed(&a);Ok::<_,anyhow::Error>(json!({"ok":true,"layout":layout}))
 }).await}).await.map_err(|_|bad("relayout task stopped; inspect the current layout before retrying"))?;
    result.map(Json).map_err(|_| {
        ApiError(
            StatusCode::CONFLICT,
            "Relayout could not finish. Inspect the dataset snapshot and retry.".into(),
        )
    })
}
#[derive(Deserialize)]
struct SourceQuery {
    source: Option<String>,
}
async fn recommendations(
    State(a): State<App>,
    Query(q): Query<SourceQuery>,
) -> ApiResult<Json<Value>> {
    let rows=sqlx::query("SELECT * FROM advisor_recommendations WHERE (?1 IS NULL OR source_id=?1) ORDER BY estimated_benefit DESC,created_at,id").bind(&q.source).fetch_all(&a.pool).await?;
    let sources=sqlx::query("SELECT id,name,kind,config FROM sources WHERE kind IN ('sqlserver','postgres','mysql','mongodb') ORDER BY name").fetch_all(&a.pool).await?.into_iter().map(|r|{let c:Value=serde_json::from_str(r.get("config")).unwrap_or(Value::Null);json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"kind":r.get::<String,_>("kind"),"advisor_may_write":c["advisor_may_write"]==true,"connection_target":format!("{}:{}/{}",c["host"].as_str().unwrap_or("localhost"),c["port"].as_u64().unwrap_or(if r.get::<&str,_>("kind")=="sqlserver"{1433}else{5432}),c["database"].as_str().unwrap_or(""))})}).collect::<Vec<_>>();
    Ok(Json(
        json!({"recommendations":rows.iter().map(advisor::value).collect::<Vec<_>>(),"sources":sources}),
    ))
}
async fn refresh(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Query(q): Query<SourceQuery>,
) -> ApiResult<Json<Value>> {
    if !p.admin() {
        return Err(forbidden());
    }
    let source = q.source.ok_or_else(|| bad("source is required"))?;
    let supported: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sources WHERE id=? AND kind IN ('sqlserver','postgres','mysql','mongodb'))",
    )
    .bind(&source)
    .fetch_one(&a.pool)
    .await?;
    if !supported {
        return Err(bad(
            "select a Postgres, MySQL, SQL Server or MongoDB source",
        ));
    }
    let result = advisor::refresh(&a.pool, &source).await?;
    changed(&a);
    Ok(Json(result))
}
async fn mutate(
    a: App,
    p: Principal,
    id: String,
    rollback: bool,
    approval: Value,
) -> ApiResult<Json<Value>> {
    if !p.admin() {
        return Err(forbidden());
    }
    let r=sqlx::query("SELECT r.*,s.config FROM advisor_recommendations r JOIN sources s ON s.id=r.source_id WHERE r.id=?").bind(&id).fetch_optional(&a.pool).await?.ok_or_else(||ApiError(StatusCode::NOT_FOUND,"recommendation not found".into()))?;
    let config: Value = serde_json::from_str(r.get("config")).map_err(anyhow::Error::from)?;
    if config["advisor_may_write"] != true {
        let mut tx = a.pool.begin().await?;
        store::audit(
            &mut tx,
            "advisor.refused",
            &id,
            "advisor_may_write is disabled",
        )
        .await?;
        tx.commit().await?;
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Advisor writes are disabled. An admin must enable advisor may write in Connections."
                .into(),
        ));
    }
    if approval["approval_token"].as_str() != Some(r.get::<&str, _>("source_config")) {
        return Err(ApiError(StatusCode::CONFLICT,"Source configuration changed or approval is missing. Refresh and review the exact target again.".into()));
    }
    if !rollback && !r.get::<bool, _>("applicable") {
        return Err(bad("advice-only recommendation cannot be applied"));
    }
    let pool = a.pool.clone();
    let actor = p.user.id;
    let result = tokio::spawn(async move { advisor::execute(&pool, &id, &actor, rollback).await })
        .await
        .map_err(|_| bad("advisor task stopped; inspect the source before retrying"))?;
    let value=result.map_err(|_|ApiError(StatusCode::CONFLICT,"Recommendation changed or is not eligible. Refresh and review its status and source configuration.".into()))?;
    changed(&a);
    if value["ok"] != true {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            value["error"]
                .as_str()
                .unwrap_or("Source operation failed")
                .into(),
        ));
    }
    Ok(Json(value))
}
async fn apply(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(approval): Json<Value>,
) -> ApiResult<Json<Value>> {
    mutate(a, p, id, false, approval).await
}
async fn rollback(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(approval): Json<Value>,
) -> ApiResult<Json<Value>> {
    mutate(a, p, id, true, approval).await
}
async fn dismiss(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !p.admin() {
        return Err(forbidden());
    }
    let mut tx = a.pool.begin().await?;
    let changed_rows=sqlx::query("UPDATE advisor_recommendations SET status='dismissed',updated_at=? WHERE id=? AND status='open'").bind(store::now()).bind(&id).execute(&mut *tx).await?.rows_affected();
    if changed_rows == 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Only open recommendations can be dismissed.".into(),
        ));
    }
    store::audit(&mut tx, "advisor.dismiss", &id, "").await?;
    tx.commit().await?;
    changed(&a);
    Ok(Json(json!({"ok":true})))
}
