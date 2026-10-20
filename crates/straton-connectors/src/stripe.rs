//! Stripe connector: curated object schemas, list pagination, events-based incremental.
use super::{column, error, invalid, relationship, schema};
use crate::http::{Http, base_url};
use arrow::{
    array::{ArrayRef, BooleanBuilder, Int64Builder, StringBuilder, TimestampSecondBuilder},
    datatypes::{DataType, Field, Schema, TimeUnit},
    record_batch::RecordBatch,
};
use futures::{StreamExt, future::BoxFuture, stream};
use serde_json::{Value, json};
use std::sync::Arc;
use straton_core::{
    Batches, Column, Connector, DatasetSchema, OP_COLUMN, ReadOptions, Result, SEQ_COLUMN,
};

/// Stripe keeps events for 30 days; leave a day of margin.
pub const EVENT_HORIZON_SECS: i64 = 29 * 86_400;

#[derive(Clone, Copy)]
enum K {
    Str,
    Int,
    Bool,
    Ts,
    /// Nested object, stored as JSON text.
    Json,
    /// Expandable reference, stored as the referenced id.
    Ref,
}
struct Obj {
    name: &'static str,
    path: &'static str,
    /// Value of the API's `object` field, used to filter event payloads.
    object: &'static str,
    /// Event family queried with a wildcard; `None` means append-only (`created[gte]` on the list).
    events: Option<&'static str>,
    cols: &'static [(&'static str, K)],
}
use K::*;
const OBJECTS: &[Obj] = &[
    Obj {
        name: "customers",
        path: "v1/customers",
        object: "customer",
        events: Some("customer.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("email", Str),
            ("name", Str),
            ("description", Str),
            ("currency", Str),
            ("balance", Int),
            ("delinquent", Bool),
            ("livemode", Bool),
            ("address", Json),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "products",
        path: "v1/products",
        object: "product",
        events: Some("product.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("updated", Ts),
            ("name", Str),
            ("description", Str),
            ("active", Bool),
            ("livemode", Bool),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "prices",
        path: "v1/prices",
        object: "price",
        events: Some("price.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("product", Ref),
            ("active", Bool),
            ("currency", Str),
            ("unit_amount", Int),
            ("type", Str),
            ("recurring", Json),
            ("livemode", Bool),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "charges",
        path: "v1/charges",
        object: "charge",
        events: Some("charge.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("amount", Int),
            ("amount_refunded", Int),
            ("currency", Str),
            ("status", Str),
            ("paid", Bool),
            ("refunded", Bool),
            ("customer", Ref),
            ("payment_intent", Ref),
            ("description", Str),
            ("livemode", Bool),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "payment_intents",
        path: "v1/payment_intents",
        object: "payment_intent",
        events: Some("payment_intent.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("amount", Int),
            ("amount_received", Int),
            ("currency", Str),
            ("status", Str),
            ("customer", Ref),
            ("description", Str),
            ("livemode", Bool),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "invoices",
        path: "v1/invoices",
        object: "invoice",
        events: Some("invoice.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("customer", Ref),
            ("subscription", Ref),
            ("status", Str),
            ("currency", Str),
            ("amount_due", Int),
            ("amount_paid", Int),
            ("total", Int),
            ("livemode", Bool),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "subscriptions",
        path: "v1/subscriptions",
        object: "subscription",
        events: Some("customer.subscription.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("customer", Ref),
            ("status", Str),
            ("current_period_start", Ts),
            ("current_period_end", Ts),
            ("cancel_at_period_end", Bool),
            ("items", Json),
            ("livemode", Bool),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "refunds",
        path: "v1/refunds",
        object: "refund",
        events: Some("refund.*"),
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("amount", Int),
            ("currency", Str),
            ("status", Str),
            ("reason", Str),
            ("charge", Ref),
            ("payment_intent", Ref),
            ("metadata", Json),
        ],
    },
    Obj {
        name: "balance_transactions",
        path: "v1/balance_transactions",
        object: "balance_transaction",
        events: None,
        cols: &[
            ("id", Str),
            ("created", Ts),
            ("available_on", Ts),
            ("amount", Int),
            ("fee", Int),
            ("net", Int),
            ("currency", Str),
            ("type", Str),
            ("status", Str),
            ("reporting_category", Str),
            ("source", Ref),
        ],
    },
];
/// (dataset, column, referenced dataset) — every target's key is `id`.
const RELATIONSHIPS: &[(&str, &str, &str)] = &[
    ("prices", "product", "products"),
    ("charges", "customer", "customers"),
    ("charges", "payment_intent", "payment_intents"),
    ("payment_intents", "customer", "customers"),
    ("invoices", "customer", "customers"),
    ("invoices", "subscription", "subscriptions"),
    ("subscriptions", "customer", "customers"),
    ("refunds", "charge", "charges"),
    ("refunds", "payment_intent", "payment_intents"),
];

fn data_type(k: K) -> DataType {
    match k {
        Str | Json | Ref => DataType::Utf8,
        Int => DataType::Int64,
        Bool => DataType::Boolean,
        Ts => DataType::Timestamp(TimeUnit::Second, Some("UTC".into())),
    }
}
fn columns(o: &Obj) -> Vec<Column> {
    o.cols
        .iter()
        .map(|&(n, k)| column(n.into(), data_type(k), n != "id", n == "id"))
        .collect()
}

pub(crate) struct Stripe {
    http: Http,
    objects: Vec<&'static Obj>,
    has_key: bool,
}

pub(crate) fn build(config: &Value, secret: Option<&str>) -> Result<Box<dyn Connector>> {
    let base = base_url(
        config
            .get("api_base")
            .and_then(Value::as_str)
            .unwrap_or("https://api.stripe.com/"),
    )?;
    let rps = config
        .get("rate_limit_rps")
        .and_then(Value::as_f64)
        .unwrap_or(25.0);
    let objects = match config.get("objects") {
        None => OBJECTS.iter().collect(),
        Some(Value::Array(names)) => names
            .iter()
            .map(|n| {
                OBJECTS
                    .iter()
                    .find(|o| Some(o.name) == n.as_str())
                    .ok_or_else(|| invalid("unknown Stripe object"))
            })
            .collect::<Result<Vec<_>>>()?,
        Some(_) => return Err(invalid("objects must be a list")),
    };
    let http = Http::new(base, format!("Bearer {}", secret.unwrap_or_default()), rps)?;
    Ok(Box::new(Stripe {
        http,
        objects,
        has_key: secret.is_some_and(|s| !s.is_empty()),
    }))
}

/// One page of rows → a batch with the curated columns, plus `_straton_op`/`_straton_seq`
/// when `seq_start` is given (incremental reads).
fn to_batch(o: &Obj, rows: &[(Value, bool)], seq_start: Option<i64>) -> Result<RecordBatch> {
    let mut fields: Vec<Field> = columns(o)
        .iter()
        .map(|c| Field::new(&c.name, c.data_type.parse().unwrap(), c.nullable))
        .collect();
    let mut arrays: Vec<ArrayRef> = o
        .cols
        .iter()
        .map(|&(name, k)| -> ArrayRef {
            let values = rows.iter().map(|(r, _)| &r[name]);
            match k {
                Str | Ref | Json => {
                    let mut b = StringBuilder::new();
                    for v in values {
                        b.append_option(match (k, v) {
                            (_, Value::Null) => None,
                            (Ref, Value::Object(m)) => {
                                m.get("id").and_then(Value::as_str).map(str::to_owned)
                            }
                            (Json, v) => Some(v.to_string()),
                            (_, Value::String(s)) => Some(s.clone()),
                            (_, v) => Some(v.to_string()),
                        });
                    }
                    Arc::new(b.finish())
                }
                Int => {
                    let mut b = Int64Builder::new();
                    values.for_each(|v| b.append_option(v.as_i64()));
                    Arc::new(b.finish())
                }
                Bool => {
                    let mut b = BooleanBuilder::new();
                    values.for_each(|v| b.append_option(v.as_bool()));
                    Arc::new(b.finish())
                }
                Ts => {
                    let mut b = TimestampSecondBuilder::new().with_timezone("UTC");
                    values.for_each(|v| b.append_option(v.as_i64()));
                    Arc::new(b.finish())
                }
            }
        })
        .collect();
    if let Some(seq_start) = seq_start {
        let mut op = StringBuilder::new();
        let mut seq = Int64Builder::new();
        for (i, (_, deleted)) in rows.iter().enumerate() {
            op.append_value(if *deleted { "delete" } else { "upsert" });
            // Pages run newest-first, so later rows are older: a larger seq means newer.
            seq.append_value(seq_start - i as i64);
        }
        fields.push(Field::new(OP_COLUMN, DataType::Utf8, false));
        fields.push(Field::new(SEQ_COLUMN, DataType::Int64, false));
        arrays.push(Arc::new(op.finish()));
        arrays.push(Arc::new(seq.finish()));
    }
    RecordBatch::try_new(Arc::new(Schema::new(fields)), arrays).map_err(error)
}

impl Stripe {
    fn object(&self, dataset: &str) -> Result<&'static Obj> {
        self.objects
            .iter()
            .copied()
            .find(|o| o.name == dataset)
            .ok_or_else(|| invalid("dataset not found"))
    }

    /// Fetch one page. Returns (rows with deleted flag, last id for pagination, has_more, newest created seen).
    async fn page(
        &self,
        o: &Obj,
        events: bool,
        starting_after: Option<&str>,
        lower: Option<i64>,
    ) -> Result<(Vec<(Value, bool)>, Option<String>, bool, Option<i64>)> {
        let mut query = vec![("limit".to_owned(), "100".to_owned())];
        if let Some(id) = starting_after {
            query.push(("starting_after".into(), id.into()));
        }
        if let Some(lower) = lower {
            query.push(("created[gte]".into(), lower.to_string()));
        }
        let path = if events {
            query.push(("type".into(), o.events.unwrap().into()));
            "v1/events"
        } else {
            o.path
        };
        let body = self.http.get(path, &query).await?;
        let data = body["data"]
            .as_array()
            .ok_or_else(|| invalid("unexpected Stripe response"))?;
        let last = data
            .last()
            .and_then(|v| v["id"].as_str())
            .map(str::to_owned);
        let newest = data.iter().filter_map(|v| v["created"].as_i64()).max();
        let rows = data
            .iter()
            .filter_map(|v| {
                if !events {
                    return Some((v.clone(), false));
                }
                let obj = &v["data"]["object"];
                // Wildcard families overlap (customer.* includes subscriptions), so filter by object type.
                (obj["object"] == o.object).then(|| {
                    let deleted = v["type"].as_str().is_some_and(|t| t.ends_with(".deleted"));
                    (obj.clone(), deleted)
                })
            })
            .collect();
        Ok((
            rows,
            last,
            body["has_more"].as_bool().unwrap_or(false),
            newest,
        ))
    }
}

impl Connector for Stripe {
    fn check(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if !self.has_key {
                return Err(invalid("a Stripe API key is required"));
            }
            self.http.get("v1/balance", &[]).await.map(|_| ())
        })
    }

    fn discover(&self) -> BoxFuture<'_, Result<Vec<DatasetSchema>>> {
        Box::pin(async move {
            Ok(self
                .objects
                .iter()
                .map(|o| {
                    let rels = RELATIONSHIPS
                        .iter()
                        .filter(|(from, _, to)| {
                            *from == o.name && self.objects.iter().any(|x| x.name == *to)
                        })
                        .map(|(from, col, to)| {
                            relationship(from, vec![(*col).into()], to, vec!["id".into()])
                        })
                        .collect();
                    schema(o.name.into(), columns(o), rels)
                })
                .collect())
        })
    }

    fn read<'a>(
        &'a self,
        dataset: &'a str,
        options: ReadOptions,
    ) -> BoxFuture<'a, Result<Batches<'a>>> {
        Box::pin(async move {
            let o = self.object(dataset)?;
            if options.keys_only.is_some() {
                return Err(invalid(
                    "Stripe delivers deletes through events; key-diff is not supported",
                ));
            }
            let lower = options
                .incremental
                .as_ref()
                .and_then(|i| i.lower_bound.as_ref())
                .map(|v| {
                    v.as_i64()
                        .ok_or_else(|| invalid("invalid Stripe watermark"))
                })
                .transpose()?;
            // Cursor: where to resume, the watermark to store at publish, and the next seq.
            let cursor = options.cursor.unwrap_or_else(|| {
                json!({
                    "starting_after": null,
                    // A full load records its start time so the next run's events overlap it.
                    "watermark": lower.unwrap_or(chrono::Utc::now().timestamp() - 60),
                    "seq": 0,
                    "done": false,
                })
            });
            let events = lower.is_some() && o.events.is_some();
            // Only the incremental merge understands `_straton_op`; plain full syncs get clean rows.
            let with_ops = options.incremental.is_some();
            Ok(stream::try_unfold(cursor, move |cursor| async move {
                if cursor["done"] == true {
                    return Ok(None);
                }
                // `lower` filters events, or the list itself for append-only objects.
                let (rows, last, more, newest) = self
                    .page(o, events, cursor["starting_after"].as_str(), lower)
                    .await?;
                let seq = cursor["seq"].as_i64().unwrap_or(0);
                let mut watermark = cursor["watermark"].as_i64().unwrap_or(0);
                if lower.is_some() {
                    // Incremental: advance to the newest change seen (events or append-only rows).
                    watermark = watermark.max(newest.unwrap_or(watermark));
                }
                let next = json!({
                    "starting_after": last,
                    "watermark": watermark,
                    "seq": seq - rows.len() as i64,
                    "done": !more || last.is_none(),
                });
                Ok(Some((
                    (to_batch(o, &rows, with_ops.then_some(seq))?, next.clone()),
                    next,
                )))
            })
            .boxed())
        })
    }
}
