//! OpenLineage run events (<https://openlineage.io>) for syncs and model runs.
//!
//! With `[lineage] openlineage_url` set, every sync and model run sends `START` when it
//! starts and `COMPLETE`, `FAIL` or `ABORT` when it ends, with its input and output
//! datasets and their schemas, so Marquez, DataHub, OpenMetadata or Unity Catalog can show
//! Straton in the organisation-wide lineage graph. Backups are not reported.
//!
//! Emission never slows or fails a run: events are built from the catalog after the run
//! changes state and handed to a bounded queue; a full queue or an unreachable collector
//! drops events with a warning. The endpoint passes the connector egress policy on every
//! send, redirects are refused, and an API key comes only from `STRATON_OPENLINEAGE_API_KEY`.
//! Model events include the model's SQL (`sql` job facet).
use crate::{config, egress, runner::Events, sql};
use anyhow::{Context, Result, bail};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::{collections::BTreeMap, time::Duration};
use tokio::{sync::mpsc, task::JoinHandle};

const PRODUCER: &str = env!("CARGO_PKG_REPOSITORY");
const RUN_EVENT: &str = "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent";
const QUEUE: usize = 1024;

/// The collector URL, if it is acceptable: HTTPS, or plain HTTP to a loopback address.
pub fn endpoint(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw).context("invalid URL")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        bail!("use https, or http on a loopback address");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("put credentials in STRATON_OPENLINEAGE_API_KEY, not the URL");
    }
    Ok(url)
}

/// Start emitting, if configured. Returns the background tasks' handles.
pub fn spawn(
    pool: SqlitePool,
    events: &Events,
    config: &config::Lineage,
) -> Result<Option<(JoinHandle<()>, JoinHandle<()>)>> {
    let Some(raw) = &config.openlineage_url else {
        return Ok(None);
    };
    let url = endpoint(raw)?;
    let key = std::env::var("STRATON_OPENLINEAGE_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .map(SecretString::from);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .https_only(url.scheme() == "https")
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let (queue, mut pending) = mpsc::channel::<Value>(QUEUE);
    let mut rx = events.subscribe();
    let namespace = config.namespace.clone();
    let builder = tokio::spawn(async move {
        loop {
            let event = match rx.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "OpenLineage fell behind; run events dropped");
                    continue;
                }
                Err(_) => break,
            };
            if event["type"] != "run.state" {
                continue;
            }
            let (Some(id), Some(state)) = (event["id"].as_str(), event["state"].as_str()) else {
                continue;
            };
            match run_event(&pool, id, state, &namespace).await {
                Ok(Some(body)) => {
                    if queue.try_send(body).is_err() {
                        tracing::warn!("OpenLineage queue full; run event dropped");
                    }
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(%error, run = id, "OpenLineage event not built"),
            }
        }
    });
    let sender = tokio::spawn(async move {
        while let Some(body) = pending.recv().await {
            if let Err(error) = send(&client, &url, key.as_ref(), &body).await {
                tracing::warn!(%error, "OpenLineage event not delivered");
            }
        }
    });
    tracing::info!(endpoint = %raw, "OpenLineage emission enabled");
    Ok(Some((builder, sender)))
}

async fn send(
    client: &reqwest::Client,
    url: &reqwest::Url,
    key: Option<&SecretString>,
    body: &Value,
) -> Result<()> {
    egress::check(&json!({ "api_base": url.as_str() })).await?;
    let mut delay = Duration::from_millis(500);
    for attempt in 1..=3 {
        let mut request = client.post(url.clone()).json(body);
        if let Some(key) = key {
            request = request.bearer_auth(key.expose_secret());
        }
        match request.send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) if !r.status().is_server_error() && r.status().as_u16() != 429 => {
                bail!("collector answered HTTP {}", r.status().as_u16())
            }
            Ok(r) if attempt == 3 => bail!("collector answered HTTP {}", r.status().as_u16()),
            Err(e) if attempt == 3 => bail!("collector unreachable: {}", e.without_url()),
            _ => {
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
        }
    }
    Ok(())
}

fn facet(schema: &str) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("_producer".into(), json!(PRODUCER));
    m.insert(
        "_schemaURL".into(),
        json!(format!("https://openlineage.io/spec/facets/{schema}")),
    );
    m
}
fn with(mut base: serde_json::Map<String, Value>, fields: Value) -> Value {
    if let Value::Object(fields) = fields {
        base.extend(fields);
    }
    Value::Object(base)
}

async fn schema_facet(pool: &SqlitePool, dataset: &str) -> Result<Value> {
    let fields: Vec<Value> =
        sqlx::query("SELECT name,data_type FROM columns WHERE dataset_id=? ORDER BY rowid")
            .bind(dataset)
            .fetch_all(pool)
            .await?
            .iter()
            .map(
                |c| json!({"name":c.get::<String,_>("name"),"type":c.get::<String,_>("data_type")}),
            )
            .collect();
    Ok(with(
        facet("1-2-0/SchemaDatasetFacet.json#/$defs/SchemaDatasetFacet"),
        json!({ "fields": fields }),
    ))
}

/// Where a source dataset lives, following the OpenLineage dataset naming conventions.
fn external(kind: &str, config: &Value, dataset: &str, source: &str) -> (String, String) {
    let host = config["host"].as_str().unwrap_or("localhost");
    let with_port = |default: u64| format!("{host}:{}", config["port"].as_u64().unwrap_or(default));
    let qualified = |name: &str| match config["database"].as_str() {
        Some(db) if !db.is_empty() => format!("{db}.{name}"),
        _ => name.to_owned(),
    };
    match kind {
        "postgres" => (
            format!("postgres://{}", with_port(5432)),
            qualified(dataset),
        ),
        "mysql" => (format!("mysql://{}", with_port(3306)), qualified(dataset)),
        "sqlserver" => (
            format!("sqlserver://{}", with_port(1433)),
            qualified(dataset),
        ),
        "mongodb" => (
            format!("mongodb://{}", with_port(27017)),
            qualified(dataset),
        ),
        "sqlite" => (
            "file".into(),
            format!("{}/{dataset}", config["path"].as_str().unwrap_or("")),
        ),
        "csv" => (
            "file".into(),
            config["path"].as_str().unwrap_or(dataset).to_owned(),
        ),
        "stripe" => (
            format!(
                "stripe://{}",
                config["account_label"].as_str().unwrap_or("stripe")
            ),
            dataset.to_owned(),
        ),
        "salesforce" => {
            let instance = config["instance_url"]
                .as_str()
                .and_then(|u| reqwest::Url::parse(u).ok())
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_else(|| "salesforce".into());
            (format!("salesforce://{instance}"), dataset.to_owned())
        }
        _ => (format!("straton-source://{source}"), dataset.to_owned()),
    }
}

/// The OpenLineage event for one run state change, or `None` when it is not reported.
pub(crate) async fn run_event(
    pool: &SqlitePool,
    run: &str,
    state: &str,
    namespace: &str,
) -> Result<Option<Value>> {
    let event_type = match state {
        "running" => "START",
        "succeeded" => "COMPLETE",
        "failed" => "FAIL",
        "cancelled" => "ABORT",
        _ => return Ok(None),
    };
    let Some(r) = sqlx::query("SELECT r.error,j.name AS job_name,j.source_id,j.dataset,j.model_id,j.builtin,s.kind,s.config FROM runs r JOIN jobs j ON j.id=r.job_id LEFT JOIN sources s ON s.id=j.source_id WHERE r.id=?")
        .bind(run)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    if r.get::<bool, _>("builtin") {
        return Ok(None);
    }
    let sources = sqlx::query("SELECT id,name FROM sources ORDER BY id")
        .fetch_all(pool)
        .await?;
    let datasets = sqlx::query("SELECT id,source_id,name FROM datasets ORDER BY source_id,name")
        .fetch_all(pool)
        .await?;
    let (schemas, tables) = sql::catalog_names(&sources, &datasets);
    let lake_name = |id: &str| -> Option<String> {
        let d = datasets.iter().find(|d| d.get::<&str, _>("id") == id)?;
        Some(format!(
            "{}.{}",
            schemas.get(d.get::<&str, _>("source_id"))?,
            tables.get(id)?
        ))
    };
    let dataset_id = |source: &str, name: &str| {
        datasets
            .iter()
            .find(|d| d.get::<&str, _>("source_id") == source && d.get::<&str, _>("name") == name)
            .map(|d| d.get::<String, _>("id"))
    };
    let source: Option<String> = r.get("source_id");
    let source = source.unwrap_or_default();
    let dataset: String = r.get("dataset");
    let mut inputs = vec![];
    let mut job_facets = serde_json::Map::new();
    let (job, kind, output) = if let Some(model) = r.get::<Option<String>, _>("model_id") {
        let m = sqlx::query("SELECT name,sql FROM models WHERE id=?")
            .bind(&model)
            .fetch_one(pool)
            .await?;
        job_facets.insert(
            "sql".into(),
            with(
                facet("1-1-0/SQLJobFacet.json#/$defs/SQLJobFacet"),
                json!({"query": m.get::<String,_>("sql"), "dialect": "datafusion"}),
            ),
        );
        for dep in sqlx::query("SELECT d.dataset_id,m.name AS upstream FROM model_deps d LEFT JOIN models m ON m.id=d.upstream_model_id WHERE d.model_id=? ORDER BY d.rowid")
            .bind(&model)
            .fetch_all(pool)
            .await?
        {
            let id = match dep.get::<Option<String>, _>("dataset_id") {
                Some(id) => Some(id),
                None => dataset_id(crate::models::SOURCE, dep.get::<Option<&str>, _>("upstream").unwrap_or_default()),
            };
            if let Some(id) = id
                && let Some(name) = lake_name(&id)
            {
                inputs.push(json!({"namespace":namespace,"name":name,"facets":{"schema":schema_facet(pool,&id).await?}}));
            }
        }
        let name: String = m.get("name");
        (
            format!("model.{name}"),
            "MODEL",
            dataset_id(crate::models::SOURCE, &name),
        )
    } else {
        let output = dataset_id(&source, &dataset);
        let config: Value = r
            .get::<Option<String>, _>("config")
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or(json!({}));
        let (ns, name) = external(
            r.get::<Option<&str>, _>("kind").unwrap_or_default(),
            &config,
            &dataset,
            &source,
        );
        let mut input = json!({"namespace":ns,"name":name});
        if let Some(id) = &output {
            input["facets"] = json!({"schema": schema_facet(pool, id).await?});
        }
        inputs.push(input);
        let job = output
            .as_deref()
            .and_then(lake_name)
            .unwrap_or_else(|| format!("{source}.{dataset}"));
        (format!("sync.{job}"), "SYNC", output)
    };
    job_facets.insert(
        "jobType".into(),
        with(
            facet("2-0-4/JobTypeJobFacet.json#/$defs/JobTypeJobFacet"),
            json!({"processingType":"BATCH","integration":"STRATON","jobType":kind}),
        ),
    );
    job_facets.insert(
        "documentation".into(),
        with(
            facet("1-1-0/DocumentationJobFacet.json#/$defs/DocumentationJobFacet"),
            json!({"description": r.get::<String,_>("job_name")}),
        ),
    );
    let mut outputs = vec![];
    if let Some(id) = output
        && let Some(name) = lake_name(&id)
    {
        outputs.push(json!({"namespace":namespace,"name":name,"facets":{"schema":schema_facet(pool,&id).await?}}));
    }
    let mut run_facets = BTreeMap::new();
    if event_type == "FAIL"
        && let Some(error) = r.get::<Option<String>, _>("error")
    {
        let message: String = error.chars().take(2000).collect();
        run_facets.insert(
            "errorMessage",
            with(
                facet("1-0-1/ErrorMessageRunFacet.json#/$defs/ErrorMessageRunFacet"),
                json!({"message": message, "programmingLanguage": "Rust"}),
            ),
        );
    }
    Ok(Some(json!({
        "eventType": event_type,
        "eventTime": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "producer": PRODUCER,
        "schemaURL": RUN_EVENT,
        "run": {"runId": run, "facets": run_facets},
        "job": {"namespace": namespace, "name": job, "facets": job_facets},
        "inputs": inputs,
        "outputs": outputs,
    })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn endpoint_requires_https_or_loopback_and_no_userinfo() {
        for ok in [
            "https://marquez.example/api/v1/lineage",
            "http://127.0.0.1:5000/api/v1/lineage",
            "http://localhost:5000/api/v1/lineage",
            "http://[::1]:5000/api/v1/lineage",
        ] {
            assert!(super::endpoint(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://marquez.example/api/v1/lineage",
            "https://user:pass@marquez.example/api/v1/lineage",
            "ftp://marquez.example",
            "not a url",
        ] {
            assert!(super::endpoint(bad).is_err(), "{bad}");
        }
    }
}
