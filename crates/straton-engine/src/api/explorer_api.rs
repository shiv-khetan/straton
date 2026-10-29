use super::*;
use datafusion::{
    arrow::{csv::WriterBuilder, datatypes::DataType},
    common::{Column, ScalarValue, TableReference},
    dataframe::DataFrame,
    functions_aggregate::expr_fn::count,
    logical_expr::{Expr, expr::Like},
    parquet::arrow::ArrowWriter,
    prelude::{col, lit},
};
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::time::Duration;

pub(super) fn routes() -> Router<App> {
    Router::new()
        .route("/v1/explorer/tree", get(tree))
        .route("/v1/explorer/rows", post(rows))
        .route("/v1/explorer/export", post(export))
}
#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Sort {
    column: String,
    dir: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Filter {
    column: String,
    op: String,
    #[serde(default)]
    value: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    schema: String,
    table: String,
    columns: Option<Vec<String>>,
    #[serde(default)]
    sort: Vec<Sort>,
    #[serde(default)]
    filters: Vec<Filter>,
    search: Option<String>,
    limit: Option<usize>,
    #[serde(default)]
    offset: usize,
    format: Option<String>,
    max_rows: Option<usize>,
}
fn df(e: datafusion::error::DataFusionError) -> ApiError {
    crate::sql::Error::from(e).into()
}
fn field(frame: &DataFrame, name: &str) -> ApiResult<Expr> {
    if !frame.schema().fields().iter().any(|f| f.name() == name) {
        return Err(bad("unknown column"));
    }
    // An unqualified Column preserves dots and quotes inside a literal column name.
    Ok(col(Column::from_name(name)))
}
fn typed(value: &Value, ty: &DataType) -> ApiResult<Expr> {
    if value.is_null() {
        return Ok(lit(ScalarValue::try_from(ty).map_err(df)?));
    }
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Bool(_) | Value::Number(_) => value.to_string(),
        _ => return Err(bad("expected a scalar filter value")),
    };
    Ok(lit(ScalarValue::try_from_string(text, ty).map_err(
        |_| bad("filter value does not match column type"),
    )?))
}
fn is_text(ty: &DataType) -> bool {
    matches!(
        ty,
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View
    )
}
fn pattern(expr: Expr, text: &str, prefix: bool, insensitive: bool) -> Expr {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Expr::Like(Like::new(
        false,
        Box::new(expr),
        Box::new(lit(if prefix {
            format!("{escaped}%")
        } else {
            format!("%{escaped}%")
        })),
        Some('\\'),
        insensitive,
    ))
}
async fn frame(a: &App, p: &Principal, q: &Input) -> ApiResult<DataFrame> {
    if !a.sql.config.enabled {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "SQL endpoint is disabled".into(),
        ));
    }
    let (ctx, tables) = a.sql.for_principal(p.clone()).context().await?;
    if !tables
        .iter()
        .any(|t| t.schema == q.schema && t.name == q.table)
    {
        return Err(bad("unknown or unreadable table; sync the dataset first"));
    }
    let mut frame = ctx
        .table(TableReference::partial(q.schema.clone(), q.table.clone()))
        .await
        .map_err(df)?;
    for f in &q.filters {
        let c = field(&frame, &f.column)?;
        let ty = frame
            .schema()
            .field_with_unqualified_name(&f.column)
            .map_err(df)?
            .data_type();
        let expr = match f.op.as_str() {
            "is_null" => c.is_null(),
            "not_null" => c.is_not_null(),
            "in" => c.in_list(
                f.value
                    .as_array()
                    .ok_or_else(|| bad("in requires an array"))?
                    .iter()
                    .map(|v| typed(v, ty))
                    .collect::<ApiResult<Vec<_>>>()?,
                false,
            ),
            "contains" | "starts_with" => {
                if !is_text(ty) {
                    return Err(bad("text operator requires a text column"));
                }
                pattern(
                    c,
                    f.value
                        .as_str()
                        .ok_or_else(|| bad("expected text filter value"))?,
                    f.op == "starts_with",
                    false,
                )
            }
            "eq" => c.eq(typed(&f.value, ty)?),
            "ne" => c.not_eq(typed(&f.value, ty)?),
            "lt" => c.lt(typed(&f.value, ty)?),
            "lte" => c.lt_eq(typed(&f.value, ty)?),
            "gt" => c.gt(typed(&f.value, ty)?),
            "gte" => c.gt_eq(typed(&f.value, ty)?),
            _ => return Err(bad("unknown filter operator")),
        };
        frame = frame.filter(expr).map_err(df)?;
    }
    if let Some(search) = q.search.as_ref().filter(|s| !s.is_empty()) {
        let expr = frame
            .schema()
            .fields()
            .iter()
            .filter(|f| is_text(f.data_type()))
            .map(|f| pattern(col(Column::from_name(f.name())), search, false, true))
            .reduce(Expr::or)
            .unwrap_or_else(|| lit(false));
        frame = frame.filter(expr).map_err(df)?;
    }
    for sort in &q.sort {
        field(&frame, &sort.column)?;
        if !["asc", "desc"].contains(&sort.dir.as_str()) {
            return Err(bad("unknown sort direction"));
        }
    }
    if let Some(columns) = &q.columns {
        for column in columns {
            field(&frame, column)?;
        }
        if columns.is_empty() {
            return Err(bad("select at least one column"));
        }
    }
    Ok(frame)
}
fn project(mut frame: DataFrame, q: &Input, limit: usize) -> ApiResult<DataFrame> {
    if !q.sort.is_empty() {
        let sorts = q
            .sort
            .iter()
            .map(|s| Ok(field(&frame, &s.column)?.sort(s.dir == "asc", false)))
            .collect::<ApiResult<Vec<_>>>()?;
        frame = frame.sort(sorts).map_err(df)?;
    }
    frame = frame.limit(q.offset, Some(limit)).map_err(df)?;
    if let Some(columns) = &q.columns {
        let exprs = columns
            .iter()
            .map(|c| field(&frame, c))
            .collect::<ApiResult<Vec<_>>>()?;
        frame = frame.select(exprs).map_err(df)?;
    }
    Ok(frame)
}
async fn audit(a: &App, q: &Input, action: &str) -> ApiResult<()> {
    let shape = json!({"schema":q.schema,"table":q.table,"columns":q.columns,"sort":q.sort,
        "filters":q.filters.iter().map(|f|json!({"column":f.column,"op":f.op})).collect::<Vec<_>>(),
        "search":q.search.as_ref().is_some_and(|s|!s.is_empty()),"format":q.format});
    let hash = format!("{:x}", Sha256::digest(shape.to_string().as_bytes()));
    let mut tx = a.pool.begin().await?;
    store::audit(
        &mut tx,
        action,
        &q.table,
        &json!({"query_shape_hash":hash}).to_string(),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
async fn tree(State(a): State<App>, Extension(p): Extension<Principal>) -> ApiResult<Json<Value>> {
    let map = filtered_map(&a.pool, &p, false).await?;
    let nodes = map["nodes"].as_array().unwrap();
    let sources=nodes.iter().filter(|n|n["type"]=="source").map(|source|{
        let tables:Vec<_>=nodes.iter().filter(|n|n["type"]=="dataset" && n["source_id"]==source["id"]).cloned().collect();
        let schema=tables.first().map(|t|t["sql_schema"].clone()).unwrap_or(Value::Null);
        json!({"source_id":source["id"],"name":source["name"],"kind":source["kind"],"schemas":if tables.is_empty(){vec![]}else{vec![json!({"name":schema,"tables":tables})]}})
    }).collect::<Vec<_>>();
    Ok(Json(json!({"sources":sources})))
}
async fn rows(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Input>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(100).min(500);
    if limit == 0 {
        return Err(bad("limit must be positive"));
    }
    tokio::time::timeout(Duration::from_secs_f64(a.sql.config.query_timeout_secs), async {
        let _pin=crate::sql::SNAPSHOTS.read().await;
        let frame=frame(&a,&p,&q).await?;
        let map=filtered_map(&a.pool,&p,false).await?;
        let metadata=map["nodes"].as_array().unwrap().iter().find(|n| n["type"]=="dataset" && n["sql_schema"]==q.schema && n["sql_table"]==q.table);
        let catalog_total=metadata.filter(|m|m["row_filtered"]!=true).and_then(|m|m["row_count"].as_u64());
        let total=if q.filters.is_empty() && q.search.as_ref().is_none_or(|s|s.is_empty()) && catalog_total.is_some() {
            catalog_total
        } else {
            tokio::time::timeout(Duration::from_millis(250),frame.clone().aggregate(vec![],vec![count(lit(1))]).map_err(df)?.collect()).await
                .ok().transpose().map_err(df)?.and_then(|b|b.first().and_then(|b|crate::sql::cell(b.column(0).as_ref(),0).ok()).and_then(|v|v.as_u64()))
        };
        let frame=project(frame,&q,limit)?;
        let columns=crate::sql::columns(frame.schema().as_arrow());
        let batches=crate::query_stats::collect(&a.sql,frame).await?;
        let mut rows=Vec::new();
        for batch in batches { for r in 0..batch.num_rows() {
            rows.push(batch.columns().iter().map(|a|crate::sql::cell(a.as_ref(),r)).collect::<Result<Vec<_>,_>>()?);
        }}
        let estimate=q.offset+rows.len()+usize::from(rows.len()==limit);
        audit(&a,&q,"explorer.read").await?;
        Ok(Json(json!({"columns":columns,"rows":rows,"offset":q.offset,"limit":limit,"total":total.unwrap_or(estimate as u64),"total_exact":total.is_some()})))
    }).await.map_err(|_|ApiError(StatusCode::REQUEST_TIMEOUT,"explorer query timed out".into()))?
}
async fn export(
    State(a): State<App>,
    Extension(p): Extension<Principal>,
    Json(q): Json<Input>,
) -> ApiResult<Response> {
    let format = q
        .format
        .as_deref()
        .ok_or_else(|| bad("format must be csv or parquet"))?;
    if !["csv", "parquet"].contains(&format) {
        return Err(bad("format must be csv or parquet"));
    }
    let max = q.max_rows.unwrap_or(1_000_000);
    if max == 0 {
        return Err(bad("max_rows must be positive"));
    }
    tokio::time::timeout(
        Duration::from_secs_f64(a.sql.config.query_timeout_secs),
        async {
            let _pin = crate::sql::SNAPSHOTS.read().await;
            let frame = project(frame(&a, &p, &q).await?, &q, max)?;
            let schema = std::sync::Arc::new(frame.schema().as_arrow().clone());
            let mut stream = a.sql.stream(frame).await?;
            let mut bytes = Vec::new();
            if format == "csv" {
                let mut writer = WriterBuilder::new().with_header(true).build(&mut bytes);
                let mut wrote = false;
                while let Some(batch) = stream.next().await {
                    writer
                        .write(&batch.map_err(df)?)
                        .map_err(anyhow::Error::from)?;
                    wrote = true;
                }
                if !wrote {
                    writer
                        .write(&datafusion::arrow::record_batch::RecordBatch::new_empty(
                            schema,
                        ))
                        .map_err(anyhow::Error::from)?;
                }
            } else {
                let mut writer =
                    ArrowWriter::try_new(&mut bytes, schema, None).map_err(anyhow::Error::from)?;
                while let Some(batch) = stream.next().await {
                    writer
                        .write(&batch.map_err(df)?)
                        .map_err(anyhow::Error::from)?;
                }
                writer.close().map_err(anyhow::Error::from)?;
            }
            audit(&a, &q, "explorer.export").await?;
            Ok((
                [
                    (
                        axum::http::header::CONTENT_TYPE,
                        if format == "csv" {
                            "text/csv; charset=utf-8"
                        } else {
                            "application/vnd.apache.parquet"
                        },
                    ),
                    (
                        axum::http::header::CONTENT_DISPOSITION,
                        if format == "csv" {
                            "attachment; filename=export.csv"
                        } else {
                            "attachment; filename=export.parquet"
                        },
                    ),
                ],
                bytes,
            )
                .into_response())
        },
    )
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::REQUEST_TIMEOUT,
            "explorer export timed out".into(),
        )
    })?
}
