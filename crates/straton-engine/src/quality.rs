use crate::{
    access::Principal,
    models,
    notify::{self, Notice},
    runner::Events,
    sql::Sql,
    store,
};
use anyhow::{Result, ensure};
use datafusion::{
    common::{Column, ScalarValue, TableReference},
    dataframe::DataFrame,
    functions_aggregate::expr_fn::{count, sum},
    logical_expr::Expr,
    prelude::{col, lit},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::time::Duration;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub dataset_id: Option<String>,
    pub model_id: Option<String>,
    pub kind: String,
    pub column_name: Option<String>,
    pub config: Value,
    pub severity: String,
    pub cron: Option<String>,
    #[serde(default = "enabled")]
    pub enabled: bool,
}
fn enabled() -> bool {
    true
}
pub async fn dataset(
    pool: &SqlitePool,
    dataset: Option<&str>,
    model: Option<&str>,
) -> Result<Option<String>> {
    if let Some(id) = model {
        Ok(sqlx::query_scalar("SELECT d.id FROM models m JOIN datasets d ON d.name=m.name AND d.source_id='straton-models' WHERE m.id=?").bind(id).fetch_optional(pool).await?)
    } else if let Some(id) = dataset {
        Ok(sqlx::query_scalar("SELECT id FROM datasets WHERE id=?")
            .bind(id)
            .fetch_optional(pool)
            .await?)
    } else {
        Ok(None)
    }
}
pub async fn readable(
    pool: &SqlitePool,
    p: &Principal,
    dataset_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<bool> {
    if p.admin() {
        return Ok(true);
    }
    let Some(id) = dataset(pool, dataset_id, model_id).await? else {
        return Ok(false);
    };
    let source: String = sqlx::query_scalar("SELECT source_id FROM datasets WHERE id=?")
        .bind(&id)
        .fetch_one(pool)
        .await?;
    Ok(!p.read_roles(&source, &id).is_empty())
}
pub fn field(frame: &DataFrame, name: &str) -> Result<Expr> {
    ensure!(
        frame.schema().fields().iter().any(|f| f.name() == name),
        "unknown column"
    );
    Ok(col(Column::from_name(name)))
}
pub fn typed(frame: &DataFrame, name: &str, value: &Value) -> Result<Expr> {
    field(frame, name)?;
    ensure!(
        value.is_string() || value.is_number() || value.is_boolean(),
        "expected a scalar value"
    );
    let ty = frame
        .schema()
        .field_with_unqualified_name(name)?
        .data_type();
    Ok(lit(ScalarValue::try_from_string(
        value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string()),
        ty,
    )?))
}
pub async fn validate(sql: &Sql, caller: &Principal, q: &Input) -> Result<()> {
    ensure!(
        !q.name.trim().is_empty() && q.name.len() <= 200,
        "name is required (up to 200 bytes)"
    );
    ensure!(
        [
            "not_null",
            "unique",
            "range",
            "freshness",
            "row_count",
            "custom_sql",
            "drift"
        ]
        .contains(&q.kind.as_str()),
        "unknown check kind"
    );
    ensure!(
        ["warn", "error"].contains(&q.severity.as_str()),
        "severity must be error or warn"
    );
    ensure!(q.config.is_object(), "config must be an object");
    ensure!(
        q.dataset_id.is_none() || q.model_id.is_none(),
        "choose one dataset or model"
    );
    if let Some(c) = &q.cron {
        c.parse::<cron::Schedule>()?;
    }
    let id = dataset(&sql.pool, q.dataset_id.as_deref(), q.model_id.as_deref()).await?;
    if q.dataset_id.is_some() || q.model_id.is_some() {
        ensure!(id.is_some(), "unknown dataset or model")
    }
    if q.kind == "custom_sql" {
        let text = q.config["sql"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("SQL is required"))?;
        models::plan(&sql.for_principal(caller.clone()), text).await?;
        return Ok(());
    }
    let id = id.ok_or_else(|| anyhow::anyhow!("dataset or model is required"))?;
    let frame = crate::policies::schema_frame(&sql.pool, &id).await?;
    if ["not_null", "unique", "range"].contains(&q.kind.as_str()) {
        let name = q
            .column_name
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("column is required"))?;
        field(&frame, name)?;
        if q.kind == "range" {
            for k in ["min", "max"] {
                if let Some(v) = q.config.get(k) {
                    typed(&frame, name, v)?;
                }
            }
        }
    }
    if ["range", "row_count"].contains(&q.kind.as_str()) {
        ensure!(
            q.config.get("min").is_some() || q.config.get("max").is_some(),
            "min or max is required"
        );
        if q.kind == "row_count" {
            for k in ["min", "max"] {
                if let Some(v) = q.config.get(k) {
                    ensure!(
                        v.as_u64().is_some(),
                        "row count bounds must be nonnegative integers"
                    )
                }
            }
        }
        if let (Some(min), Some(max)) = (q.config["min"].as_f64(), q.config["max"].as_f64()) {
            ensure!(min <= max, "min must not exceed max")
        }
    }
    if q.kind == "drift" {
        let mut any = false;
        for (key, limit) in [
            ("max_row_change", 100.0),
            ("max_null_increase", 1.0),
            ("max_distinct_change", 100.0),
        ] {
            if let Some(v) = q.config.get(key) {
                ensure!(
                    v.as_f64().is_some_and(|v| v > 0.0 && v <= limit),
                    "{key} must be a fraction above 0 (at most {limit})"
                );
                any = true;
            }
        }
        ensure!(
            any,
            "set max_row_change, max_null_increase or max_distinct_change"
        );
    }
    if q.kind == "freshness" {
        ensure!(
            q.config["max_age_seconds"]
                .as_f64()
                .is_some_and(|v| v >= 0.0),
            "max_age_seconds must be nonnegative"
        )
    }
    Ok(())
}
async fn target(sql: &Sql, owner: &Principal, id: &str) -> Result<DataFrame> {
    let sources = sqlx::query("SELECT id,name FROM sources ORDER BY id")
        .fetch_all(&sql.pool)
        .await?;
    let datasets = sqlx::query("SELECT id,source_id,name FROM datasets ORDER BY source_id,name")
        .fetch_all(&sql.pool)
        .await?;
    let d = datasets
        .iter()
        .find(|r| r.get::<&str, _>("id") == id)
        .ok_or_else(|| anyhow::anyhow!("unknown dataset"))?;
    let (schemas, tables) = crate::sql::catalog_names(&sources, &datasets);
    let (ctx, _) = sql.for_principal(owner.clone()).context().await?;
    Ok(ctx
        .table(TableReference::partial(
            schemas[d.get::<&str, _>("source_id")].clone(),
            tables[id].clone(),
        ))
        .await?)
}
async fn number(sql: &Sql, frame: DataFrame) -> Result<i64> {
    let batches = crate::query_stats::collect(sql, frame).await?;
    Ok(batches
        .first()
        .filter(|b| b.num_rows() > 0)
        .map(|b| crate::sql::cell(b.column(0).as_ref(), 0))
        .transpose()?
        .and_then(|v| v.as_i64())
        .unwrap_or(0))
}
async fn rows(sql: &Sql, frame: DataFrame) -> Result<i64> {
    number(sql, frame.aggregate(vec![], vec![count(lit(1))])?).await
}
/// One evaluation: pass/fail, the observed value, failing rows, and an optional message.
type Outcome = (bool, Option<f64>, Option<i64>, Option<String>);
// Checks evaluate as their owner, so counts never reveal rows or columns the owner's policies hide.
async fn evaluate(sql: &Sql, owner: &Principal, check: &str, q: &Input) -> Result<Outcome> {
    if q.kind == "drift" {
        let _snapshot = crate::sql::SNAPSHOTS.read().await;
        let id = dataset(&sql.pool, q.dataset_id.as_deref(), q.model_id.as_deref())
            .await?
            .ok_or_else(|| anyhow::anyhow!("unknown target"))?;
        return drift(sql, owner, check, &id, &q.config).await;
    }
    let (passed, observed, failing) = evaluate_counts(sql, owner, q).await?;
    Ok((passed, observed, failing, None))
}
async fn evaluate_counts(
    sql: &Sql,
    owner: &Principal,
    q: &Input,
) -> Result<(bool, Option<f64>, Option<i64>)> {
    let _snapshot = crate::sql::SNAPSHOTS.read().await;
    if q.kind == "custom_sql" {
        let text = q.config["sql"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("SQL is required"))?;
        models::select(text)?;
        let sql = sql.for_principal(owner.clone());
        let (ctx, _) = sql.context().await?;
        let n = rows(
            &sql,
            sql.plan(&ctx, text, &[]).await?.limit(0, Some(10_000))?,
        )
        .await?;
        return Ok((n == 0, Some(n as f64), Some(n)));
    }
    let id = dataset(&sql.pool, q.dataset_id.as_deref(), q.model_id.as_deref())
        .await?
        .ok_or_else(|| anyhow::anyhow!("unknown target"))?;
    if q.kind == "freshness" {
        let last: Option<String> =
            sqlx::query_scalar("SELECT last_synced_at FROM datasets WHERE id=?")
                .bind(&id)
                .fetch_one(&sql.pool)
                .await?;
        let age = last
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map(|at| (store::now() - at.timestamp()).max(0) as f64);
        return Ok((
            age.is_some_and(|v| v <= q.config["max_age_seconds"].as_f64().unwrap_or(0.0)),
            age,
            None,
        ));
    }
    let frame = target(sql, owner, &id).await?;
    let n = match q.kind.as_str() {
        "row_count" => {
            let n = rows(sql, frame).await?;
            let pass = q.config["min"].as_u64().is_none_or(|v| n as u64 >= v)
                && q.config["max"].as_u64().is_none_or(|v| n as u64 <= v);
            return Ok((pass, Some(n as f64), None));
        }
        "not_null" => {
            let c = field(&frame, q.column_name.as_deref().unwrap_or(""))?;
            rows(sql, frame.filter(c.is_null())?).await?
        }
        "unique" => {
            let c = field(&frame, q.column_name.as_deref().unwrap_or(""))?;
            let groups = frame.aggregate(
                vec![c.alias("__quality_value")],
                vec![count(lit(1)).alias("__quality_count")],
            )?;
            number(
                sql,
                groups
                    .filter(col("__quality_count").gt(lit(1_i64)))?
                    .aggregate(vec![], vec![sum(col("__quality_count"))])?,
            )
            .await?
        }
        "range" => {
            let name = q.column_name.as_deref().unwrap_or("");
            let c = field(&frame, name)?;
            let mut predicate = lit(false);
            if let Some(v) = q.config.get("min") {
                predicate = predicate.or(c.clone().lt(typed(&frame, name, v)?))
            }
            if let Some(v) = q.config.get("max") {
                predicate = predicate.or(c.gt(typed(&frame, name, v)?))
            }
            rows(sql, frame.filter(predicate)?).await?
        }
        _ => anyhow::bail!("unknown check kind"),
    };
    Ok((n == 0, Some(n as f64), Some(n)))
}
/// Profile the target as the owner, store it, and compare it with this check's previous
/// profile. The first run records a baseline and passes.
async fn drift(
    sql: &Sql,
    owner: &Principal,
    check: &str,
    dataset: &str,
    config: &Value,
) -> Result<Outcome> {
    let frame = target(sql, owner, dataset).await?;
    let fields: Vec<_> = frame
        .schema()
        .fields()
        .iter()
        .take(crate::profile::MAX_COLUMNS)
        .map(|f| (f.name().clone(), f.data_type().clone()))
        .collect();
    let (rows, columns) = crate::profile::profile(frame, &fields, false).await?;
    let current = json!({
        "rows": rows,
        "columns": columns.iter().map(|c| json!({"name": c["name"], "null_ratio": c["null_ratio"], "approx_distinct": c["approx_distinct"]})).collect::<Vec<_>>(),
    });
    let previous: Option<String> = sqlx::query_scalar(
        "SELECT profile FROM quality_profiles WHERE check_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .bind(check)
    .fetch_optional(&sql.pool)
    .await?;
    let mut tx = sql.pool.begin().await?;
    sqlx::query("INSERT INTO quality_profiles(check_id,created_at,profile) VALUES(?,?,?)")
        .bind(check)
        .bind(store::now())
        .bind(current.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM quality_profiles WHERE check_id=?1 AND rowid NOT IN (SELECT rowid FROM quality_profiles WHERE check_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 30)")
        .bind(check)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let Some(previous) = previous.and_then(|p| serde_json::from_str::<Value>(&p).ok()) else {
        return Ok((
            true,
            Some(0.0),
            None,
            Some("Baseline profile recorded".into()),
        ));
    };
    let findings = compare_profiles(&previous, &current, config);
    let message = if findings.is_empty() {
        "No drift since the last run".to_owned()
    } else {
        let mut text = findings
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("; ");
        if findings.len() > 5 {
            text.push_str(&format!("; {} more", findings.len() - 5));
        }
        text
    };
    Ok((
        findings.is_empty(),
        Some(findings.len() as f64),
        None,
        Some(message),
    ))
}
/// Human-readable drift findings between two stored profiles under `config`'s thresholds:
/// relative row-count change, absolute null-ratio increase, relative distinct-count change,
/// and added or removed columns.
pub fn compare_profiles(previous: &Value, current: &Value, config: &Value) -> Vec<String> {
    let pct = |v: f64| format!("{:.0}%", v * 100.0);
    let mut out = vec![];
    let (before, after) = (
        previous["rows"].as_f64().unwrap_or(0.0),
        current["rows"].as_f64().unwrap_or(0.0),
    );
    if let Some(limit) = config["max_row_change"].as_f64() {
        let change = if before == 0.0 {
            if after == 0.0 { 0.0 } else { f64::INFINITY }
        } else {
            (after - before).abs() / before
        };
        if change > limit {
            out.push(format!("rows {before} → {after}"));
        }
    }
    let columns =
        |p: &Value| -> Vec<Value> { p["columns"].as_array().cloned().unwrap_or_default() };
    let (old, new) = (columns(previous), columns(current));
    for c in &new {
        let name = c["name"].as_str().unwrap_or_default();
        let Some(o) = old.iter().find(|o| o["name"] == c["name"]) else {
            out.push(format!("column {name} added"));
            continue;
        };
        if let (Some(limit), Some(a), Some(b)) = (
            config["max_null_increase"].as_f64(),
            o["null_ratio"].as_f64(),
            c["null_ratio"].as_f64(),
        ) && b - a > limit
        {
            out.push(format!("{name} nulls {} → {}", pct(a), pct(b)));
        }
        if let (Some(limit), Some(a), Some(b)) = (
            config["max_distinct_change"].as_f64(),
            o["approx_distinct"].as_f64(),
            c["approx_distinct"].as_f64(),
        ) && a > 0.0
            && (b - a).abs() / a > limit
        {
            out.push(format!("{name} distinct {a} → {b}"));
        }
    }
    for o in &old {
        if !new.iter().any(|c| c["name"] == o["name"]) {
            out.push(format!(
                "column {} removed",
                o["name"].as_str().unwrap_or_default()
            ));
        }
    }
    out
}
pub fn value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"dataset_id":r.get::<Option<String>,_>("dataset_id"),"model_id":r.get::<Option<String>,_>("model_id"),"kind":r.get::<String,_>("kind"),"column_name":r.get::<Option<String>,_>("column_name"),"config":serde_json::from_str::<Value>(r.get("config")).unwrap_or(json!({})),"severity":r.get::<String,_>("severity"),"cron":r.get::<Option<String>,_>("cron"),"enabled":r.get::<bool,_>("enabled"),"last_scheduled":r.get::<i64,_>("last_scheduled"),"owner_id":r.get::<String,_>("owner_id"),"created_at":r.get::<i64,_>("created_at"),"updated_at":r.get::<i64,_>("updated_at")})
}
pub fn run_value(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.get::<String,_>("id"),"check_id":r.get::<String,_>("check_id"),"status":r.get::<String,_>("status"),"observed":r.get::<Option<f64>,_>("observed"),"failing_rows":r.get::<Option<i64>,_>("failing_rows"),"message":r.get::<String,_>("message"),"pipeline_run_id":r.get::<Option<String>,_>("pipeline_run_id"),"started_at":r.get::<i64,_>("started_at"),"finished_at":r.get::<i64,_>("finished_at")})
}
pub async fn run(sql: &Sql, events: &Events, check: &str, pipeline: Option<&str>) -> Result<Value> {
    let r = sqlx::query("SELECT * FROM quality_checks WHERE id=?")
        .bind(check)
        .fetch_one(&sql.pool)
        .await?;
    let q: Input = serde_json::from_value({
        let mut v = value(&r);
        for k in [
            "id",
            "owner_id",
            "last_scheduled",
            "created_at",
            "updated_at",
        ] {
            v.as_object_mut().unwrap().remove(k);
        }
        v
    })?;
    let started = store::now();
    let owner = crate::access::principal(&sql.pool, r.get("owner_id")).await;
    let result = match &owner {
        Ok(owner) => {
            tokio::time::timeout(
                Duration::from_secs_f64(sql.config.query_timeout_secs),
                evaluate(sql, owner, check, &q),
            )
            .await
        }
        Err(_) => Ok(Err(anyhow::anyhow!("check owner is disabled or missing"))),
    };
    let (status, observed, failing, message) = match result {
        Ok(Ok((passed, observed, failing, message))) => (
            if passed { "passed" } else { "failed" },
            observed,
            failing,
            message.unwrap_or_else(|| {
                if passed {
                    "Check passed".into()
                } else {
                    "Check failed".into()
                }
            }),
        ),
        _ => (
            "error",
            None,
            None,
            "Check could not be evaluated".to_owned(),
        ),
    };
    let id = store::id();
    let mut tx = sql.pool.begin().await?;
    sqlx::query("INSERT INTO quality_runs(id,check_id,status,observed,failing_rows,message,pipeline_run_id,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(check).bind(status).bind(observed).bind(failing).bind(message).bind(pipeline).bind(started).bind(store::now()).execute(&mut *tx).await?;
    store::audit(&mut tx, "quality.run", check, status).await?;
    tx.commit().await?;
    if status != "passed" {
        let title = format!(
            "{} {}",
            r.get::<String, _>("name"),
            if status == "failed" {
                "failed"
            } else {
                "could not run"
            }
        );
        notify::emit(
            &sql.pool,
            events,
            Notice {
                severity: if q.severity == "warn" {
                    "warn"
                } else {
                    "error"
                },
                kind: "quality.failed",
                title: &title,
                entity_kind: "check",
                entity_id: check,
                user_id: Some(r.get("owner_id")),
            },
        )
        .await?;
    }
    let r = sqlx::query("SELECT * FROM quality_runs WHERE id=?")
        .bind(id)
        .fetch_one(&sql.pool)
        .await?;
    Ok(run_value(&r))
}
