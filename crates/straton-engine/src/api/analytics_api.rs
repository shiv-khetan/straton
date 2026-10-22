use super::*;
use crate::{models, quality};
use datafusion::{
    common::tree_node::{Transformed, TreeNode},
    dataframe::DataFrame,
    logical_expr::{Expr, LogicalPlan},
};
use std::time::Duration;

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/charts", get(charts).post(create_chart))
        .route("/v1/charts/preview", post(preview))
        .route(
            "/v1/charts/{id}",
            get(chart).put(update_chart).delete(remove_chart),
        )
        .route("/v1/charts/{id}/data", post(data))
        .route("/v1/charts/{id}/drill", post(drill))
        .route("/v1/dashboards", get(dashboards).post(create_dashboard))
        .route(
            "/v1/dashboards/{id}",
            get(dashboard)
                .put(update_dashboard)
                .delete(remove_dashboard),
        )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Chart {
    name: String,
    sql: String,
    kind: String,
    config: Value,
    #[serde(default)]
    shared: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Dashboard {
    name: String,
    #[serde(default)]
    description: String,
    layout: Vec<Tile>,
    #[serde(default)]
    shared: bool,
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Tile {
    chart_id: String,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Range {
    from: Option<Value>,
    to: Option<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    sql: String,
    config: Value,
    from: Option<Value>,
    to: Option<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Drill {
    x_value: Value,
    from: Option<Value>,
    to: Option<Value>,
}
fn name(n: &str) -> ApiResult<()> {
    if n.trim().is_empty() || n.len() > 200 {
        Err(bad("name is required (up to 200 bytes)"))
    } else {
        Ok(())
    }
}
fn chart_value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"owner_id":r.get::<String,_>("owner_id"),"name":r.get::<String,_>("name"),"sql":r.get::<String,_>("sql"),"kind":r.get::<String,_>("kind"),"config":serde_json::from_str::<Value>(r.get("config")).unwrap_or(json!({})),"shared":r.get::<bool,_>("shared"),"created_at":r.get::<i64,_>("created_at"),"updated_at":r.get::<i64,_>("updated_at")})
}
fn dashboard_value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"owner_id":r.get::<String,_>("owner_id"),"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"layout":serde_json::from_str::<Value>(r.get("layout")).unwrap_or(json!([])),"shared":r.get::<bool,_>("shared"),"created_at":r.get::<i64,_>("created_at"),"updated_at":r.get::<i64,_>("updated_at")})
}
fn writable(p: &Principal, r: &sqlx::sqlite::SqliteRow) -> ApiResult<()> {
    if p.admin() || r.get::<&str, _>("owner_id") == p.user.id {
        Ok(())
    } else {
        Err(forbidden())
    }
}
async fn chart_row(a: &App, p: &Principal, id: &str) -> ApiResult<sqlx::sqlite::SqliteRow> {
    sqlx::query("SELECT * FROM charts WHERE id=? AND (owner_id=? OR shared=1 OR ?)")
        .bind(id)
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))
}
async fn dashboard_row(a: &App, p: &Principal, id: &str) -> ApiResult<sqlx::sqlite::SqliteRow> {
    sqlx::query("SELECT * FROM dashboards WHERE id=? AND (owner_id=? OR shared=1 OR ?)")
        .bind(id)
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_optional(&a.pool)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "not found".into()))
}
async fn charts(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    Ok(Json(json!(
        sqlx::query(
            "SELECT * FROM charts WHERE owner_id=? OR shared=1 OR ? ORDER BY updated_at DESC,id"
        )
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_all(&a.pool)
        .await?
        .iter()
        .map(chart_value)
        .collect::<Vec<_>>()
    )))
}
async fn chart(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(chart_value(&chart_row(&a, &p, &id).await?)))
}
fn config(frame: &DataFrame, c: &Value) -> ApiResult<()> {
    if !c.is_object() {
        return Err(bad("config must be an object"));
    }
    for k in ["x", "series", "time_column"] {
        if let Some(v) = c.get(k) {
            quality::field(
                frame,
                v.as_str()
                    .ok_or_else(|| bad("column mapping must be a string"))?,
            )
            .map_err(|e| bad(&e.to_string()))?;
        }
    }
    if let Some(y) = c.get("y") {
        for v in y.as_array().ok_or_else(|| bad("y must be an array"))? {
            quality::field(
                frame,
                v.as_str()
                    .ok_or_else(|| bad("column mapping must be a string"))?,
            )
            .map_err(|e| bad(&e.to_string()))?;
        }
    }
    Ok(())
}
async fn save_chart(
    a: App,
    p: Principal,
    id: String,
    q: Chart,
    update: bool,
) -> ApiResult<Json<Value>> {
    name(&q.name)?;
    if !["line", "bar", "area", "stat", "table"].contains(&q.kind.as_str()) {
        return Err(bad("unknown chart kind"));
    }
    let owner = if update {
        let r = chart_row(&a, &p, &id).await?;
        writable(&p, &r)?;
        r.get::<String, _>("owner_id")
    } else {
        p.user.id.clone()
    };
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    let (frame, deps) = models::plan(&a.sql.for_principal(p.clone()), &q.sql)
        .await
        .map_err(|e| bad(&e.to_string()))?;
    config(&frame, &q.config)?;
    let mut tx = a.pool.begin().await?;
    if update {
        sqlx::query(
            "UPDATE charts SET name=?,sql=?,kind=?,config=?,shared=?,updated_at=? WHERE id=?",
        )
        .bind(q.name.trim())
        .bind(&q.sql)
        .bind(q.kind)
        .bind(q.config.to_string())
        .bind(q.shared)
        .bind(store::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("INSERT INTO charts(id,owner_id,name,sql,kind,config,shared,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(&id).bind(owner).bind(q.name.trim()).bind(&q.sql).bind(q.kind).bind(q.config.to_string()).bind(q.shared).bind(store::now()).bind(store::now()).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM chart_deps WHERE chart_id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for d in deps.datasets {
        sqlx::query("INSERT INTO chart_deps(chart_id,dataset_id) VALUES(?,?)")
            .bind(&id)
            .bind(d)
            .execute(&mut *tx)
            .await?;
    }
    for m in deps.models {
        sqlx::query("INSERT INTO chart_deps(chart_id,model_id) VALUES(?,?)")
            .bind(&id)
            .bind(m)
            .execute(&mut *tx)
            .await?;
    }
    store::audit(
        &mut tx,
        if update {
            "chart.updated"
        } else {
            "chart.created"
        },
        &id,
        "",
    )
    .await?;
    tx.commit().await?;
    chart(State(a), Extension(p), Path(id)).await
}
async fn create_chart(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Chart>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        save_chart(a, p, store::id(), q, false).await?,
    ))
}
async fn update_chart(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Chart>,
) -> ApiResult<Json<Value>> {
    save_chart(a, p, id, q, true).await
}
async fn remove_chart(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    writable(&p, &chart_row(&a, &p, &id).await?)?;
    let mut tx = a.pool.begin().await?;
    sqlx::query("DELETE FROM charts WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "chart.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn dashboards(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Value>> {
    Ok(Json(json!(
        sqlx::query(
            "SELECT * FROM dashboards WHERE owner_id=? OR shared=1 OR ? ORDER BY updated_at DESC,id"
        )
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_all(&a.pool)
        .await?
        .iter()
        .map(dashboard_value)
        .collect::<Vec<_>>()
    )))
}
async fn dashboard(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut v = dashboard_value(&dashboard_row(&a, &p, &id).await?);
    let mut visible = vec![];
    for tile in v["layout"].as_array().unwrap() {
        let id = tile["chart_id"].as_str().unwrap_or("");
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM charts WHERE id=? AND (owner_id=? OR shared=1 OR ?))",
        )
        .bind(id)
        .bind(&p.user.id)
        .bind(p.admin())
        .fetch_one(&a.pool)
        .await?;
        if exists {
            visible.push(tile.clone());
        }
    }
    v["layout"] = json!(visible);
    Ok(Json(v))
}
async fn save_dashboard(
    a: App,
    p: Principal,
    id: String,
    q: Dashboard,
    update: bool,
) -> ApiResult<Json<Value>> {
    name(&q.name)?;
    if update {
        writable(&p, &dashboard_row(&a, &p, &id).await?)?;
    }
    let mut seen = std::collections::BTreeSet::new();
    for tile in &q.layout {
        if tile.w == 0 || tile.h == 0 || !seen.insert(&tile.chart_id) {
            return Err(bad("layout sizes must be positive and charts unique"));
        }
        chart_row(&a, &p, &tile.chart_id).await?;
    }
    let mut tx = a.pool.begin().await?;
    if update {
        sqlx::query(
            "UPDATE dashboards SET name=?,description=?,layout=?,shared=?,updated_at=? WHERE id=?",
        )
        .bind(q.name.trim())
        .bind(q.description)
        .bind(json!(q.layout).to_string())
        .bind(q.shared)
        .bind(store::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("INSERT INTO dashboards(id,owner_id,name,description,layout,shared,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(&id).bind(&p.user.id).bind(q.name.trim()).bind(q.description).bind(json!(q.layout).to_string()).bind(q.shared).bind(store::now()).bind(store::now()).execute(&mut *tx).await?;
    }
    store::audit(
        &mut tx,
        if update {
            "dashboard.updated"
        } else {
            "dashboard.created"
        },
        &id,
        "",
    )
    .await?;
    tx.commit().await?;
    dashboard(State(a), Extension(p), Path(id)).await
}
async fn create_dashboard(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Dashboard>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        save_dashboard(a, p, store::id(), q, false).await?,
    ))
}
async fn update_dashboard(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Dashboard>,
) -> ApiResult<Json<Value>> {
    save_dashboard(a, p, id, q, true).await
}
async fn remove_dashboard(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    writable(&p, &dashboard_row(&a, &p, &id).await?)?;
    let mut tx = a.pool.begin().await?;
    sqlx::query("DELETE FROM dashboards WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    store::audit(&mut tx, "dashboard.deleted", &id, "").await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
fn underlying(frame: DataFrame, names: &[&str]) -> ApiResult<(DataFrame, Vec<Expr>)> {
    let mut expressions = names
        .iter()
        .map(|n| quality::field(&frame, n).map_err(|e| bad(&e.to_string())))
        .collect::<ApiResult<Vec<_>>>()?;
    let original = frame.clone();
    let (state, mut plan) = frame.into_parts();
    loop {
        match plan {
            LogicalPlan::Projection(p) => {
                for expr in &mut expressions {
                    *expr = expr
                        .clone()
                        .transform_up(|e| {
                            if let Expr::Column(c) = &e
                                && let Ok(i) = p.schema.index_of_column(c)
                            {
                                let e = match p.expr[i].clone() {
                                    Expr::Alias(a) => *a.expr,
                                    e => e,
                                };
                                return Ok(Transformed::yes(e));
                            }
                            Ok(Transformed::no(e))
                        })
                        .map_err(crate::sql::Error::from)?
                        .data;
                }
                plan = (*p.input).clone();
            }
            LogicalPlan::SubqueryAlias(p) => {
                for expr in &mut expressions {
                    *expr = expr
                        .clone()
                        .transform_up(|e| {
                            if let Expr::Column(mut c) = e {
                                c.relation = None;
                                Ok(Transformed::yes(Expr::Column(c)))
                            } else {
                                Ok(Transformed::no(e))
                            }
                        })
                        .map_err(crate::sql::Error::from)?
                        .data;
                }
                plan = (*p.input).clone();
            }
            LogicalPlan::Sort(p) => plan = (*p.input).clone(),
            LogicalPlan::Limit(p) => plan = (*p.input).clone(),
            LogicalPlan::Filter(p) => plan = (*p.input).clone(),
            LogicalPlan::Aggregate(p) => {
                for expr in &mut expressions {
                    *expr = expr
                        .clone()
                        .transform_up(|e| {
                            if let Expr::Column(c) = &e
                                && let Ok(i) = p.schema.index_of_column(c)
                            {
                                return p
                                    .group_expr
                                    .get(i)
                                    .cloned()
                                    .map(Transformed::yes)
                                    .ok_or_else(|| {
                                        datafusion::error::DataFusionError::Plan(
                                            "drill mapping must be a group column".into(),
                                        )
                                    });
                            }
                            Ok(Transformed::no(e))
                        })
                        .map_err(crate::sql::Error::from)?
                        .data;
                }
                return Ok((DataFrame::new(state, (*p.input).clone()), expressions));
            }
            _ => {
                return Ok((
                    original.clone(),
                    names
                        .iter()
                        .map(|n| quality::field(&original, n).map_err(|e| bad(&e.to_string())))
                        .collect::<ApiResult<Vec<_>>>()?,
                ));
            }
        }
    }
}
async fn query(
    a: &App,
    p: &Principal,
    text: &str,
    c: &Value,
    range: Range,
    x: Option<&Value>,
) -> ApiResult<Json<Value>> {
    if !a.sql.config.enabled {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "SQL endpoint is disabled".into(),
        ));
    }
    tokio::time::timeout(
        Duration::from_secs_f64(a.sql.config.query_timeout_secs),
        async {
            let _snapshot = crate::sql::SNAPSHOTS.read().await;
            models::select(text).map_err(|e| bad(&e.to_string()))?;
            let sql = a.sql.for_principal(p.clone());
            let (ctx, _) = sql.context().await?;
            let mut frame = sql.plan(&ctx, text, &[]).await?;
            config(&frame, c)?;
            let original = frame.clone();
            let mut drill_columns = vec![];
            let has_range = range.from.is_some() || range.to.is_some();
            if x.is_some() {
                drill_columns.push(
                    c["x"]
                        .as_str()
                        .ok_or_else(|| bad("x mapping is required for drill"))?,
                );
                if has_range {
                    drill_columns.push(
                        c["time_column"]
                            .as_str()
                            .ok_or_else(|| bad("time_column is required for a time range"))?,
                    );
                }
            }
            let expressions = if x.is_some() {
                let (source, expressions) = underlying(frame, &drill_columns)?;
                frame = source;
                expressions
            } else {
                vec![]
            };
            if has_range {
                let name = c["time_column"]
                    .as_str()
                    .ok_or_else(|| bad("time_column is required for a time range"))?;
                let col = if x.is_some() {
                    expressions[1].clone()
                } else {
                    quality::field(&frame, name).map_err(|e| bad(&e.to_string()))?
                };
                for (value, lower) in [(&range.from, true), (&range.to, false)] {
                    if let Some(v) = value {
                        let value =
                            quality::typed(&original, name, v).map_err(|e| bad(&e.to_string()))?;
                        frame = frame
                            .filter(if lower {
                                col.clone().gt_eq(value)
                            } else {
                                col.clone().lt_eq(value)
                            })
                            .map_err(crate::sql::Error::from)?;
                    }
                }
            }
            if let Some(x) = x {
                let col = expressions[0].clone();
                let predicate = if x.is_null() {
                    col.is_null()
                } else {
                    col.eq(quality::typed(&original, drill_columns[0], x)
                        .map_err(|e| bad(&e.to_string()))?)
                };
                frame = frame.filter(predicate).map_err(crate::sql::Error::from)?;
            }
            let frame = frame
                .limit(0, Some(if x.is_some() { 500 } else { 5000 }))
                .map_err(crate::sql::Error::from)?;
            let columns = crate::sql::columns(frame.schema().as_arrow());
            let mut rows = vec![];
            for b in frame.collect().await.map_err(crate::sql::Error::from)? {
                for i in 0..b.num_rows() {
                    rows.push(
                        b.columns()
                            .iter()
                            .map(|c| crate::sql::cell(c.as_ref(), i))
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                }
            }
            Ok(Json(json!({"columns":columns,"rows":rows})))
        },
    )
    .await
    .map_err(|_| ApiError(StatusCode::REQUEST_TIMEOUT, "chart query timed out".into()))?
}
async fn data(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Range>,
) -> ApiResult<Json<Value>> {
    let r = chart_row(&a, &p, &id).await?;
    query(
        &a,
        &p,
        r.get("sql"),
        &serde_json::from_str::<Value>(r.get("config")).map_err(anyhow::Error::from)?,
        q,
        None,
    )
    .await
}
async fn preview(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Preview>,
) -> ApiResult<Json<Value>> {
    query(
        &a,
        &p,
        &q.sql,
        &q.config,
        Range {
            from: q.from,
            to: q.to,
        },
        None,
    )
    .await
}
async fn drill(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(q): Json<Drill>,
) -> ApiResult<Json<Value>> {
    let r = chart_row(&a, &p, &id).await?;
    query(
        &a,
        &p,
        r.get("sql"),
        &serde_json::from_str::<Value>(r.get("config")).map_err(anyhow::Error::from)?,
        Range {
            from: q.from,
            to: q.to,
        },
        Some(&q.x_value),
    )
    .await
}
