//! Salesforce tests against a fake org on loopback (OAuth, describe, Bulk API 2.0).
use crate::build;
use arrow::array::{Array, AsArray};
use axum::{
    Form, Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use futures::TryStreamExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use straton_core::{IncrementalRead, OP_COLUMN, ReadOptions};

#[derive(Clone, Default)]
struct Org {
    /// (operation, soql) of the last bulk job.
    job: Arc<Mutex<Option<(String, String)>>>,
    polls: Arc<Mutex<u32>>,
}

async fn token(Form(f): Form<HashMap<String, String>>) -> impl IntoResponse {
    assert_eq!(f["grant_type"], "refresh_token");
    assert_eq!(f["client_id"], "client-1");
    if f["refresh_token"] == "good-refresh" {
        (
            StatusCode::OK,
            Json(json!({"access_token": "tok", "instance_url": "ignored"})),
        )
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_grant", "error_description": "expired good-refresh"})),
        )
    }
}
fn authed(h: &HeaderMap) -> bool {
    h.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer tok")
}
async fn describe(h: HeaderMap, Path(object): Path<String>) -> impl IntoResponse {
    if !authed(&h) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!([{"errorCode": "INVALID_SESSION_ID"}])),
        )
            .into_response();
    }
    let common = [
        json!({"name": "Id", "type": "id"}),
        json!({"name": "IsDeleted", "type": "boolean"}),
        json!({"name": "SystemModstamp", "type": "datetime"}),
    ];
    let mut fields: Vec<Value> = common.to_vec();
    if object == "Account" {
        fields.push(json!({"name": "Name", "type": "string"}));
        fields.push(json!({"name": "BillingAddress", "type": "address"}));
    } else {
        fields.push(json!({"name": "LastName", "type": "string"}));
        fields.push(json!({"name": "AccountId", "type": "reference", "referenceTo": ["Account"]}));
    }
    Json(json!({"fields": fields})).into_response()
}
async fn create_job(
    State(org): State<Org>,
    h: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    assert!(authed(&h));
    *org.job.lock().unwrap() = Some((
        body["operation"].as_str().unwrap().into(),
        body["query"].as_str().unwrap().into(),
    ));
    Json(json!({"id": "750A", "state": "UploadComplete"}))
}
async fn job_state(State(org): State<Org>) -> impl IntoResponse {
    let mut polls = org.polls.lock().unwrap();
    *polls += 1;
    Json(json!({"state": if *polls == 1 { "InProgress" } else { "JobComplete" }}))
}
async fn results(
    State(org): State<Org>,
    Query(q): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let (operation, _) = org.job.lock().unwrap().clone().unwrap();
    let header = "Id,IsDeleted,SystemModstamp,Name\n";
    let (body, locator) = if operation == "queryAll" {
        (
            format!(
                "{header}001A,false,2023-11-15T10:00:00.000Z,Acme Renamed\n001B,true,2023-11-16T09:30:00.000Z,Beta\n"
            ),
            "null",
        )
    } else if q.contains_key("locator") {
        (
            format!("{header}001C,false,2023-11-01T00:00:00.000Z,Gamma\n"),
            "null",
        )
    } else {
        (
            format!(
                "{header}001A,false,2023-11-01T00:00:00.000Z,Acme\n001B,false,2023-11-01T00:00:00.000Z,Beta\n"
            ),
            "L2",
        )
    };
    ([("Sforce-Locator", locator)], body)
}

async fn serve(org: Org) -> String {
    let app = Router::new()
        .route("/services/oauth2/token", post(token))
        .route(
            "/services/data/v61.0/sobjects/{object}/describe",
            get(describe),
        )
        .route("/services/data/v61.0/jobs/query", post(create_job))
        .route("/services/data/v61.0/jobs/query/750A", get(job_state))
        .route("/services/data/v61.0/jobs/query/750A/results", get(results))
        .with_state(org);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/")
}
fn org(base: &str, refresh: &str, objects: &[&str]) -> Box<dyn straton_core::Connector> {
    build(
        "salesforce",
        &json!({"instance_url": base, "login_url": base, "client_id": "client-1", "objects": objects, "poll_ms": 1, "rate_limit_rps": 1000}),
        Some(refresh),
    )
    .unwrap()
}

#[tokio::test]
async fn salesforce_rejects_revoked_refresh_token_without_leaking_it() {
    let base = serve(Org::default()).await;
    let err = org(&base, "bad-refresh", &["Account"])
        .discover()
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("re-authenticate"), "{err}");
    assert!(!err.contains("bad-refresh"), "{err}");
    assert!(
        build(
            "salesforce",
            &json!({"instance_url": base, "client_id": "c", "objects": ["Account; DROP"]}),
            None
        )
        .is_err()
    );
}

#[tokio::test]
async fn salesforce_discovers_fields_and_references() {
    let base = serve(Org::default()).await;
    let all = org(&base, "good-refresh", &["Account", "Contact"])
        .discover()
        .await
        .unwrap();
    let account = &all[0];
    assert!(
        account
            .columns
            .iter()
            .any(|c| c.name == "Id" && c.primary_key && !c.nullable)
    );
    assert!(
        !account.columns.iter().any(|c| c.name == "BillingAddress"),
        "compound fields skipped"
    );
    let contact = &all[1];
    assert_eq!(contact.relationships.len(), 1);
    assert_eq!(
        (
            contact.relationships[0].from_cols.clone(),
            contact.relationships[0].to_dataset.as_str()
        ),
        (vec!["AccountId".to_owned()], "Account")
    );
}

#[tokio::test]
async fn salesforce_bulk_full_and_queryall_incremental() {
    let o = Org::default();
    let base = serve(o.clone()).await;
    let sf = org(&base, "good-refresh", &["Account"]);
    let pages: Vec<_> = sf
        .read("Account", ReadOptions::default())
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(pages.len(), 2, "follows Sforce-Locator");
    assert_eq!(pages.iter().map(|(b, _)| b.num_rows()).sum::<usize>(), 3);
    assert!(pages[0].0.column_by_name(OP_COLUMN).is_none());
    let (operation, soql) = o.job.lock().unwrap().clone().unwrap();
    assert_eq!(
        (operation.as_str(), soql.as_str()),
        (
            "query",
            "SELECT Id,IsDeleted,SystemModstamp,Name FROM Account"
        )
    );

    let opts = ReadOptions {
        incremental: Some(IncrementalRead {
            watermark_column: String::new(),
            lower_bound: Some(json!(1_700_000_000)),
            key_columns: vec!["Id".into()],
        }),
        ..Default::default()
    };
    let pages: Vec<_> = sf
        .read("Account", opts)
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    let (operation, soql) = o.job.lock().unwrap().clone().unwrap();
    assert_eq!(operation, "queryAll");
    assert!(
        soql.ends_with("WHERE SystemModstamp >= 2023-11-14T22:13:20Z"),
        "{soql}"
    );
    let (b, cursor) = &pages[0];
    let ops = b.column_by_name(OP_COLUMN).unwrap().as_string::<i32>();
    assert_eq!((ops.value(0), ops.value(1)), ("upsert", "delete"));
    assert_eq!(
        b.column_by_name("Name")
            .unwrap()
            .as_string::<i32>()
            .value(0),
        "Acme Renamed"
    );
    // Newest SystemModstamp (2023-11-16T09:30:00Z) in epoch seconds.
    assert_eq!(cursor["watermark"], 1_700_127_000);
    assert!(b.column_by_name("IsDeleted").unwrap().is_valid(1));
}
