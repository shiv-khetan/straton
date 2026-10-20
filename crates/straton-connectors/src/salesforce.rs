//! Salesforce connector: OAuth refresh-token auth, describe-based discovery,
//! Bulk API 2.0 reads, and events-style incremental via `queryAll` on `SystemModstamp`.
use super::{column, error, invalid, relationship, schema};
use crate::http::{Http, base_url};
use arrow::{
    array::{
        Array, ArrayRef, BooleanArray, Int64Builder, StringBuilder, TimestampMillisecondArray,
    },
    datatypes::{DataType, Field, Schema, TimeUnit},
    record_batch::RecordBatch,
};
use futures::{StreamExt, future::BoxFuture, stream};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use straton_core::{
    Batches, Column, Connector, DatasetSchema, OP_COLUMN, ReadOptions, Result, SEQ_COLUMN,
};
use tokio::sync::Mutex;

/// Deleted records leave the recycle bin after 15 days; keep a day of margin.
pub const DELETE_HORIZON_SECS: i64 = 14 * 86_400;
const WATERMARK: &str = "SystemModstamp";

pub(crate) struct Salesforce {
    api: Http,
    login: Http,
    client_id: String,
    refresh_token: Option<String>,
    objects: Vec<String>,
    version: String,
    batch_size: usize,
    poll: Duration,
    /// When the current access token was obtained.
    authorized: Mutex<Option<Instant>>,
}

pub(crate) fn build(config: &Value, secret: Option<&str>) -> Result<Box<dyn Connector>> {
    let text = |k: &str| config.get(k).and_then(Value::as_str);
    let instance =
        base_url(text("instance_url").ok_or_else(|| invalid("instance_url is required"))?)?;
    let login = base_url(text("login_url").unwrap_or("https://login.salesforce.com/"))?;
    let rps = config
        .get("rate_limit_rps")
        .and_then(Value::as_f64)
        .unwrap_or(10.0);
    let objects: Vec<String> = config
        .get("objects")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("objects is required"))?
        .iter()
        .map(|o| {
            o.as_str()
                .filter(|s| {
                    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                })
                .map(str::to_owned)
                .ok_or_else(|| invalid("object names must be API names"))
        })
        .collect::<Result<_>>()?;
    let version = text("api_version").unwrap_or("v61.0").to_owned();
    if !version.starts_with('v') || version[1..].parse::<f32>().is_err() {
        return Err(invalid("api_version must look like v61.0"));
    }
    Ok(Box::new(Salesforce {
        api: Http::new(instance, String::new(), rps)?,
        login: Http::new(login, String::new(), rps)?,
        client_id: text("client_id")
            .ok_or_else(|| invalid("client_id is required"))?
            .to_owned(),
        refresh_token: secret.filter(|s| !s.is_empty()).map(str::to_owned),
        objects,
        version,
        batch_size: config
            .get("batch_size")
            .and_then(Value::as_u64)
            .unwrap_or(10_000) as usize,
        poll: Duration::from_millis(
            config
                .get("poll_ms")
                .and_then(Value::as_u64)
                .unwrap_or(2_000),
        ),
        authorized: Mutex::new(None),
    }))
}

/// Describe field type → Arrow type; `None` for compound/binary fields Bulk queries can't return.
fn data_type(sf: &str) -> Option<DataType> {
    Some(match sf {
        "address" | "location" | "base64" => return None,
        "boolean" => DataType::Boolean,
        "int" => DataType::Int64,
        "double" | "currency" | "percent" => DataType::Float64,
        "date" => DataType::Date32,
        // Offset form: the CSV reader parses it without the chrono-tz feature.
        "datetime" => DataType::Timestamp(TimeUnit::Millisecond, Some("+00:00".into())),
        _ => DataType::Utf8,
    })
}

impl Salesforce {
    /// Exchange the refresh token for an access token, again after 30 minutes.
    async fn authorize(&self) -> Result<()> {
        let mut at = self.authorized.lock().await;
        if at.is_some_and(|t| t.elapsed() < Duration::from_secs(1800)) {
            return Ok(());
        }
        let refresh = self
            .refresh_token
            .as_deref()
            .ok_or_else(|| invalid("Salesforce is not authorized; sign in from the desktop app"))?;
        let body = self
            .login
            .token(
                "services/oauth2/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", &self.client_id),
                    ("refresh_token", refresh),
                ],
            )
            .await
            .map_err(|code| {
                straton_core::Error::Connector(if code == "invalid_grant" {
                    "Salesforce authorization expired or was revoked; re-authenticate this source"
                        .into()
                } else {
                    format!("Salesforce token refresh failed ({code})")
                })
            })?;
        let token = body["access_token"]
            .as_str()
            .ok_or_else(|| invalid("Salesforce token response had no access_token"))?;
        self.api.set_auth(format!("Bearer {token}")).await;
        *at = Some(Instant::now());
        Ok(())
    }

    fn path(&self, rest: &str) -> String {
        format!("services/data/{}/{rest}", self.version)
    }

    async fn describe(&self, object: &str) -> Result<(Vec<Column>, Vec<(String, String)>)> {
        let d = self
            .api
            .get(&self.path(&format!("sobjects/{object}/describe")), &[])
            .await?;
        let mut columns = Vec::new();
        let mut references = Vec::new();
        for f in d["fields"]
            .as_array()
            .ok_or_else(|| invalid("unexpected describe response"))?
        {
            let (Some(name), Some(kind)) = (f["name"].as_str(), f["type"].as_str()) else {
                continue;
            };
            let Some(dt) = data_type(kind) else { continue };
            // Every non-key column is nullable so delete rows can carry only the key.
            columns.push(column(name.into(), dt, name != "Id", name == "Id"));
            if let Some([target]) = f["referenceTo"].as_array().map(Vec::as_slice)
                && let Some(target) = target.as_str()
            {
                references.push((name.to_owned(), target.to_owned()));
            }
        }
        if !columns.iter().any(|c| c.name == "Id") {
            return Err(invalid("object has no Id field"));
        }
        Ok((columns, references))
    }

    /// Run (or resume) one Bulk API 2.0 query job and page through its CSV results.
    async fn create_job(&self, operation: &str, soql: &str) -> Result<String> {
        let job = self
            .api
            .post(
                &self.path("jobs/query"),
                &json!({"operation": operation, "query": soql}),
            )
            .await?;
        job["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| invalid("Bulk API returned no job id"))
    }

    async fn wait(&self, job: &str) -> Result<()> {
        loop {
            self.authorize().await?;
            let state = self
                .api
                .get(&self.path(&format!("jobs/query/{job}")), &[])
                .await?;
            match state["state"].as_str() {
                Some("JobComplete") => return Ok(()),
                Some("Failed" | "Aborted") => {
                    return Err(straton_core::Error::Connector(
                        "Salesforce bulk query failed".into(),
                    ));
                }
                _ => tokio::time::sleep(self.poll).await,
            }
        }
    }
}

/// CSV page → batch in the dataset schema; incremental reads add op/seq derived from `IsDeleted`.
fn to_batch(
    columns: &[Column],
    csv: &str,
    seq_start: Option<i64>,
) -> Result<(RecordBatch, Option<i64>)> {
    let fields: Vec<Field> = columns
        .iter()
        .map(|c| Field::new(&c.name, c.data_type.parse().unwrap(), c.nullable))
        .collect();
    let schema = Arc::new(Schema::new(fields));
    let mut batches = Vec::new();
    for b in arrow::csv::ReaderBuilder::new(schema.clone())
        .with_header(true)
        .build(std::io::Cursor::new(csv))
        .map_err(csv_error)?
    {
        batches.push(b.map_err(csv_error)?);
    }
    let batch = arrow::compute::concat_batches(&schema, &batches).map_err(error)?;
    let newest = batch
        .column_by_name(WATERMARK)
        .and_then(|c| c.as_any().downcast_ref::<TimestampMillisecondArray>())
        .and_then(arrow::compute::max)
        .map(|ms| ms / 1000);
    let Some(seq_start) = seq_start else {
        return Ok((batch, newest));
    };
    let deleted = batch
        .column_by_name("IsDeleted")
        .and_then(|c| c.as_any().downcast_ref::<BooleanArray>().cloned());
    let mut op = StringBuilder::new();
    let mut seq = Int64Builder::new();
    for i in 0..batch.num_rows() {
        let gone = deleted
            .as_ref()
            .is_some_and(|d| d.is_valid(i) && d.value(i));
        op.append_value(if gone { "delete" } else { "upsert" });
        seq.append_value(seq_start + i as i64);
    }
    let mut fields: Vec<Field> = schema.fields().iter().map(|f| f.as_ref().clone()).collect();
    fields.push(Field::new(OP_COLUMN, DataType::Utf8, false));
    fields.push(Field::new(SEQ_COLUMN, DataType::Int64, false));
    let mut arrays: Vec<ArrayRef> = batch.columns().to_vec();
    arrays.push(Arc::new(op.finish()));
    arrays.push(Arc::new(seq.finish()));
    Ok((
        RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays).map_err(error)?,
        newest,
    ))
}

impl Connector for Salesforce {
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.authorize().await?;
            self.api.get(&self.path("limits"), &[]).await.map(|_| ())
        })
    }

    fn discover(&self) -> BoxFuture<'_, Result<Vec<DatasetSchema>>> {
        Box::pin(async move {
            self.authorize().await?;
            let mut out = Vec::new();
            for object in &self.objects {
                let (columns, references) = self.describe(object).await?;
                let rels = references
                    .iter()
                    .filter(|(_, target)| self.objects.contains(target))
                    .map(|(field, target)| {
                        relationship(object, vec![field.clone()], target, vec!["Id".into()])
                    })
                    .collect();
                out.push(schema(object.clone(), columns, rels));
            }
            Ok(out)
        })
    }

    fn read<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> BoxFuture<'a, Result<Batches<'a>>> {
        Box::pin(async move {
            if !self.objects.iter().any(|o| o == dataset) {
                return Err(invalid("dataset not found"));
            }
            if options.keys_only.is_some() {
                return Err(invalid(
                    "Salesforce delivers deletes through queryAll; key-diff is not supported",
                ));
            }
            self.authorize().await?;
            let (columns, _) = self.describe(dataset).await?;
            let lower = options
                .incremental
                .as_ref()
                .and_then(|i| i.lower_bound.as_ref())
                .map(|v| {
                    v.as_i64()
                        .ok_or_else(|| invalid("invalid Salesforce watermark"))
                })
                .transpose()?;
            let with_ops = options.incremental.is_some();
            if with_ops && !columns.iter().any(|c| c.name == WATERMARK) {
                return Err(invalid("object has no SystemModstamp; use full refresh"));
            }
            let cursor = match options.cursor {
                Some(c) => c,
                None => {
                    let names = columns
                        .iter()
                        .map(|c| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join(",");
                    // Object names were validated as API names; the bound is a formatted integer.
                    let (operation, soql) = match lower {
                        Some(w) => {
                            let since = chrono::DateTime::from_timestamp(w, 0)
                                .ok_or_else(|| invalid("invalid Salesforce watermark"))?
                                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                            (
                                "queryAll",
                                format!(
                                    "SELECT {names} FROM {dataset} WHERE {WATERMARK} >= {since}"
                                ),
                            )
                        }
                        None => ("query", format!("SELECT {names} FROM {dataset}")),
                    };
                    json!({
                        "job": self.create_job(operation, &soql).await?,
                        "locator": null,
                        // A full load records its start time so the next run overlaps it.
                        "watermark": lower.unwrap_or(chrono::Utc::now().timestamp() - 60),
                        "seq": 0,
                        "done": false,
                    })
                }
            };
            let job = cursor["job"]
                .as_str()
                .ok_or_else(|| invalid("invalid cursor"))?
                .to_owned();
            self.wait(&job).await?;
            let columns = Arc::new(columns);
            Ok(stream::try_unfold(cursor, move |cursor| {
                let columns = columns.clone();
                let job = job.clone();
                async move {
                    if cursor["done"] == true {
                        return Ok(None);
                    }
                    self.authorize().await?;
                    let mut query = vec![("maxRecords".to_owned(), self.batch_size.to_string())];
                    if let Some(l) = cursor["locator"].as_str() {
                        query.push(("locator".into(), l.into()));
                    }
                    let (headers, csv) = self
                        .api
                        .get_text(&self.path(&format!("jobs/query/{job}/results")), &query)
                        .await?;
                    let locator = headers
                        .get("Sforce-Locator")
                        .and_then(|v| v.to_str().ok())
                        .filter(|l| *l != "null" && !l.is_empty())
                        .map(str::to_owned);
                    let seq = cursor["seq"].as_i64().unwrap_or(0);
                    let (batch, newest) = to_batch(&columns, &csv, with_ops.then_some(seq))?;
                    let mut watermark = cursor["watermark"].as_i64().unwrap_or(0);
                    if lower.is_some() {
                        watermark = watermark.max(newest.unwrap_or(watermark));
                    }
                    let next = json!({
                        "job": job,
                        "locator": locator,
                        "watermark": watermark,
                        "seq": seq + batch.num_rows() as i64,
                        "done": locator.is_none(),
                    });
                    Ok(Some(((batch, next.clone()), next)))
                }
            })
            .boxed())
        })
    }
}

/// Bulk results are data, not credentials, so the parse error is safe to surface.
fn csv_error(e: arrow::error::ArrowError) -> straton_core::Error {
    straton_core::Error::Connector(format!("could not parse Salesforce bulk results: {e}"))
}
