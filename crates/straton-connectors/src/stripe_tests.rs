//! Stripe + HTTP layer tests against a fake Stripe API on loopback.
use crate::{build, http};
use arrow::array::{Array, AsArray};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
};
use futures::TryStreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use straton_core::{IncrementalRead, OP_COLUMN, ReadOptions};

#[derive(Clone, Default)]
struct Fake {
    hits: Arc<AtomicUsize>,
    throttle_first: usize,
}

fn customer(n: u32) -> Value {
    json!({"id": format!("cus_{n:03}"), "object": "customer", "created": 1_700_000_000 + n, "email": format!("c{n}@x.io"),
           "balance": n, "delinquent": false, "livemode": false, "address": {"city": "Pune"}, "metadata": {}})
}

async fn customers(
    State(f): State<Fake>,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let n = f.hits.fetch_add(1, Ordering::SeqCst);
    if n < f.throttle_first {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [("retry-after", "0")],
            Json(json!({})),
        )
            .into_response();
    }
    if h.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer rk_test_secret") {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": {"message": "Invalid API Key provided: rk_test_secret"}})),
        )
            .into_response();
    }
    // 250 customers, newest first, 100 per page.
    let all: Vec<Value> = (0..250).rev().map(customer).collect();
    let start = q
        .get("starting_after")
        .map(|id| all.iter().position(|c| c["id"] == id.as_str()).unwrap() + 1)
        .unwrap_or(0);
    let page: Vec<Value> = all.iter().skip(start).take(100).cloned().collect();
    Json(json!({"data": page, "has_more": start + 100 < all.len()})).into_response()
}

async fn events(Query(q): Query<HashMap<String, String>>) -> impl IntoResponse {
    assert_eq!(q.get("type").map(String::as_str), Some("customer.*"));
    assert_eq!(
        q.get("created[gte]").map(String::as_str),
        Some("1700000100")
    );
    let mut updated = customer(5);
    updated["email"] = json!("changed@x.io");
    let mut deleted = customer(7);
    deleted["deleted"] = json!(true);
    // Newest first. The subscription event shares the customer.* family and must be ignored.
    Json(json!({"has_more": false, "data": [
        {"id": "evt_3", "type": "customer.deleted", "created": 1_700_000_300, "data": {"object": deleted}},
        {"id": "evt_2", "type": "customer.subscription.created", "created": 1_700_000_250, "data": {"object": {"id": "sub_1", "object": "subscription"}}},
        {"id": "evt_1", "type": "customer.updated", "created": 1_700_000_200, "data": {"object": updated}},
    ]}))
}

async fn serve(f: Fake) -> String {
    let app = Router::new()
        .route("/v1/customers", get(customers))
        .route("/v1/balance", get(customers))
        .route("/v1/events", get(events))
        .with_state(f);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/")
}

fn stripe(base: &str, key: &str) -> Box<dyn straton_core::Connector> {
    build(
        "stripe",
        &json!({"api_base": base, "objects": ["customers"], "rate_limit_rps": 1000}),
        Some(key),
    )
    .unwrap()
}

#[tokio::test]
async fn http_retries_429_then_gives_up_and_hides_secrets() {
    let f = Fake {
        throttle_first: 2,
        ..Default::default()
    };
    let base = serve(f.clone()).await;
    let mut h = http::Http::new(
        http::base_url(&base).unwrap(),
        "Bearer rk_test_secret".into(),
        1000.0,
    )
    .unwrap();
    h.backoff = Duration::from_millis(1);
    h.get("v1/customers", &[]).await.unwrap();
    assert_eq!(f.hits.load(Ordering::SeqCst), 3, "two 429s then success");

    let f = Fake {
        throttle_first: 99,
        ..Default::default()
    };
    let base = serve(f.clone()).await;
    let mut h = http::Http::new(http::base_url(&base).unwrap(), "Bearer x".into(), 1000.0).unwrap();
    h.backoff = Duration::from_millis(1);
    assert!(h.get("v1/customers", &[]).await.is_err());
    assert_eq!(f.hits.load(Ordering::SeqCst), 5, "max five attempts");

    let base = serve(Fake::default()).await;
    let err = stripe(&base, "rk_wrong_key")
        .check()
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("401") && !err.contains("rk_"), "{err}");
    assert!(http::base_url("http://api.example.com/").is_err());
    assert!(http::base_url("https://api.example.com/").is_ok());
}

#[tokio::test]
async fn stripe_discovers_curated_schemas_with_relationships() {
    let all = build("stripe", &json!({}), None)
        .unwrap()
        .discover()
        .await
        .unwrap();
    assert_eq!(all.len(), 9);
    let charges = all.iter().find(|d| d.dataset.name == "charges").unwrap();
    assert!(
        charges
            .columns
            .iter()
            .any(|c| c.name == "id" && c.primary_key && !c.nullable)
    );
    assert!(
        charges
            .relationships
            .iter()
            .any(|r| r.from_cols == ["customer"] && r.to_dataset == "customers")
    );
    // Relationships to objects that weren't selected are dropped.
    let one = build("stripe", &json!({"objects": ["charges"]}), None)
        .unwrap()
        .discover()
        .await
        .unwrap();
    assert!(one[0].relationships.is_empty());
    assert!(build("stripe", &json!({"objects": ["nope"]}), None).is_err());
}

#[tokio::test]
async fn stripe_full_read_paginates_and_maps_json() {
    let base = serve(Fake::default()).await;
    let s = stripe(&base, "rk_test_secret");
    let pages: Vec<_> = s
        .read("customers", ReadOptions::default())
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(pages.len(), 3);
    let rows: usize = pages.iter().map(|(b, _)| b.num_rows()).sum();
    assert_eq!(rows, 250);
    let (first, cursor) = &pages[0];
    assert_eq!(
        first
            .column_by_name("id")
            .unwrap()
            .as_string::<i32>()
            .value(0),
        "cus_249"
    );
    assert_eq!(
        first
            .column_by_name("address")
            .unwrap()
            .as_string::<i32>()
            .value(0),
        r#"{"city":"Pune"}"#
    );
    assert!(
        first.column_by_name(OP_COLUMN).is_none(),
        "plain full reads carry no merge columns"
    );
    assert!(
        first.column_by_name("name").unwrap().is_null(0),
        "missing field → null"
    );
    assert!(
        cursor["watermark"].as_i64().unwrap() > 1_700_000_000,
        "full load seeds a start-time watermark"
    );
    assert_eq!(pages[2].1["done"], true);
    // Resuming from a saved cursor continues where it stopped.
    let rest: Vec<_> = s
        .read(
            "customers",
            ReadOptions {
                cursor: Some(pages[0].1.clone()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(rest.iter().map(|(b, _)| b.num_rows()).sum::<usize>(), 150);
}

#[tokio::test]
async fn stripe_events_emit_upserts_and_deletes() {
    let base = serve(Fake::default()).await;
    let s = stripe(&base, "rk_test_secret");
    let opts = ReadOptions {
        incremental: Some(IncrementalRead {
            watermark_column: String::new(),
            lower_bound: Some(json!(1_700_000_100)),
            key_columns: vec!["id".into()],
        }),
        ..Default::default()
    };
    let pages: Vec<_> = s
        .read("customers", opts)
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let (b, cursor) = &pages[0];
    assert_eq!(b.num_rows(), 2, "subscription event filtered out");
    let ids = b.column_by_name("id").unwrap().as_string::<i32>();
    let ops = b.column_by_name(OP_COLUMN).unwrap().as_string::<i32>();
    assert_eq!((ids.value(0), ops.value(0)), ("cus_007", "delete"));
    assert_eq!((ids.value(1), ops.value(1)), ("cus_005", "upsert"));
    assert_eq!(
        b.column_by_name("email")
            .unwrap()
            .as_string::<i32>()
            .value(1),
        "changed@x.io"
    );
    assert_eq!(cursor["watermark"], 1_700_000_300, "newest event created");
    assert!(
        s.read(
            "customers",
            ReadOptions {
                keys_only: Some(vec!["id".into()]),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
}
