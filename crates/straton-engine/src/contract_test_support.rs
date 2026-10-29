use crate::{api, backup, config::Config, runner, store};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::json;
use sqlx::SqlitePool;
use std::{path::PathBuf, time::Instant};
use tower::ServiceExt;

struct Fixture {
    dir: PathBuf,
    pool: SqlitePool,
    config: Config,
    events: runner::Events,
}
impl Fixture {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("straton-test-{}", store::id()));
        let config = Config {
            data_dir: dir.clone(),
            backup: crate::config::Backup {
                dir: dir.join("backups"),
                keep: 2,
                ..Default::default()
            },
            ..Default::default()
        };
        let pool = store::open(&dir).await.unwrap();
        crate::access::bootstrap(&pool, "good-token").await.unwrap();
        let (events, _) = tokio::sync::broadcast::channel(32);
        sqlx::query("INSERT INTO sources(id,name,kind) VALUES('source','Noop','noop')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO jobs(id,name,source_id,dataset,enabled,last_scheduled) VALUES('job','Test','source','test',1,?)").bind(store::now()).execute(&pool).await.unwrap();
        Self {
            dir,
            pool,
            config,
            events,
        }
    }
    async fn enqueue(&self) -> String {
        let mut tx = self.pool.begin().await.unwrap();
        let id = store::enqueue(&mut tx, "job", store::now()).await.unwrap();
        tx.commit().await.unwrap();
        id
    }
    #[allow(dead_code)] // kept for recovery suites that read run state
    async fn state(&self, id: &str) -> String {
        sqlx::query_scalar("SELECT state FROM runs WHERE id=?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    async fn close(self) {
        self.pool.close().await;
        let dir = self.dir.clone();
        drop(self);
        // Windows can retain transient sharing locks after every owned handle is closed.
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
fn app(f: &Fixture) -> axum::Router {
    api::router(api::App {
        pool: f.pool.clone(),
        sql: crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
        events: f.events.clone(),
        backups: backup::Backups::new(f.config.clone()),
        started: Instant::now(),
    })
}
async fn request(
    app: &axum::Router,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    request_as(app, "good-token", method, path, body).await
}
async fn request_as(
    app: &axum::Router,
    token: &str,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}
async fn access_role(a: &axum::Router, name: &str) -> String {
    let (s, r) = request(a, "POST", "/v1/roles", json!({"name":name})).await;
    assert_eq!(s, StatusCode::CREATED, "{r}");
    r["id"].as_str().unwrap().into()
}
async fn access_user(a: &axum::Router, name: &str, roles: &[&str]) -> (String, String) {
    let (s, u) = request(a, "POST", "/v1/users", json!({"name":name})).await;
    assert_eq!(s, StatusCode::CREATED, "{u}");
    let id = u["id"].as_str().unwrap();
    assert_eq!(
        request(
            a,
            "PUT",
            &format!("/v1/users/{id}/roles"),
            json!({"role_ids":roles})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (s, t) = request(
        a,
        "POST",
        &format!("/v1/users/{id}/tokens"),
        json!({"name":"Test client"}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{t}");
    (id.into(), t["token"].as_str().unwrap().into())
}
async fn access_grant(a: &axum::Router, role: &str, kind: &str, target: &str, privilege: &str) {
    let (s, r) = request(
        a,
        "POST",
        "/v1/grants",
        json!({"role_id":role,"target_kind":kind,"target_id":target,"privilege":privilege}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{r}");
}
async fn dataset_id(f: &Fixture, name: &str) -> String {
    sqlx::query_scalar("SELECT id FROM datasets WHERE source_id='source' AND name=?")
        .bind(name)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
async fn sql_fixture() -> Fixture {
    let f = Fixture::new().await;
    let path = f.dir.join("sql-input.db");
    let input = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'Alice'),(2,'Bob'); CREATE TABLE unpublished(id INTEGER);")
        .execute(&input).await.unwrap();
    input.close().await;
    sqlx::query("UPDATE sources SET name='App DB',kind='sqlite',config=? WHERE id='source'")
        .bind(json!({"path":path,"batch_size":1}).to_string())
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET dataset='users'")
        .execute(&f.pool)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    f
}
async fn sql_sync(f: &Fixture) -> String {
    let id = f.enqueue().await;
    runner::state(&f.pool, &f.events, &id, "running", None)
        .await
        .unwrap();
    runner::execute(
        &f.pool,
        &backup::Backups::new(f.config.clone()),
        &id,
        &f.events,
    )
    .await
    .unwrap();
    id
}
fn model_input(name: &str, query: &str, materialization: &str, trigger: &str) -> serde_json::Value {
    json!({"name":name,"sql":query,"materialization":materialization,"trigger":trigger,"cron":null,"optimize":true})
}
async fn create_model(
    a: &axum::Router,
    name: &str,
    query: &str,
    materialization: &str,
    trigger: &str,
) -> String {
    let (s, m) = request(
        a,
        "POST",
        "/v1/models",
        model_input(name, query, materialization, trigger),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{m}");
    m["id"].as_str().unwrap().into()
}
