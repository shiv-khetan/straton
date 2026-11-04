use crate::{api, backup, config::Config, runner, scheduler, security, store};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::json;
use sqlx::{Row, SqlitePool};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
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
#[tokio::test]
async fn scheduler_due_and_misfire_run_once() {
    assert!(!scheduler::due("0 * * * * *", 60, 119).unwrap());
    assert!(scheduler::due("0 * * * * *", 60, 120).unwrap());
    assert!(scheduler::due("0 * * * * *", 60, 86400).unwrap());
    assert!(scheduler::due("bad", 0, 10).is_err());
    let f = Fixture::new().await;
    // A past, one-time schedule makes the duplicate check independent of wall-clock seconds.
    sqlx::query("UPDATE jobs SET cron='0 0 0 1 1 * 2000',last_scheduled=?")
        .bind(0_i64)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO jobs(id,name,source_id,dataset,cron,enabled,last_scheduled) VALUES('bad-job','Bad','source','test','invalid cron',1,0)")
        .execute(&f.pool).await.unwrap();
    assert_eq!(
        scheduler::tick(
            &f.pool,
            &crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
            &f.events
        )
        .await
        .unwrap()
        .len(),
        1
    );
    assert!(
        scheduler::tick(
            &f.pool,
            &crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
            &f.events
        )
        .await
        .unwrap()
        .is_empty()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM runs")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM runs WHERE job_id='bad-job'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    f.close().await;
}
#[tokio::test]
async fn panic_is_failed_and_next_run_succeeds() {
    let f = Fixture::new().await;
    let id = f.enqueue().await;
    runner::state(&f.pool, &f.events, &id, "running", None)
        .await
        .unwrap();
    runner::supervise(f.pool.clone(), f.events.clone(), id.clone(), async {
        panic!("test worker panic")
    })
    .await
    .unwrap();
    assert_eq!(f.state(&id).await, "failed");
    let next = f.enqueue().await;
    let mut runner = runner::Runner::new(
        f.pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        1,
    );
    runner.dispatch().await.unwrap();
    runner.drain().await;
    assert_eq!(f.state(&next).await, "succeeded");
    let marker: i64 = sqlx::query_scalar("SELECT committed_batches FROM runs WHERE id=?")
        .bind(next)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(marker, 3);
    let error_run = f.enqueue().await;
    runner::state(&f.pool, &f.events, &error_run, "running", None)
        .await
        .unwrap();
    runner::supervise(f.pool.clone(), f.events.clone(), error_run.clone(), async {
        Err(anyhow::anyhow!("é".repeat(501)))
    })
    .await
    .unwrap();
    let error: String = sqlx::query_scalar("SELECT error FROM runs WHERE id=?")
        .bind(&error_run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(error, "é".repeat(500));
    assert_eq!(f.state(&error_run).await, "failed");
    drop(runner);
    f.close().await;
}
#[tokio::test]
async fn recovery_requeues_from_checkpoint_and_limits_attempts() {
    let f = Fixture::new().await;
    let id = f.enqueue().await;
    runner::state(&f.pool, &f.events, &id, "running", None)
        .await
        .unwrap();
    runner::checkpoint(&f.pool, &id, &json!(2)).await.unwrap();
    // Simulate a process closing with a persisted running row.
    f.pool.close().await;
    let pool = store::open(&f.dir).await.unwrap();
    runner::recover(&pool, &f.events, 3).await.unwrap();
    let row =
        sqlx::query("SELECT state,attempt,available_at,committed_batches FROM runs WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.get::<String, _>("state"), "queued");
    assert_eq!(row.get::<i64, _>("attempt"), 2);
    assert!(row.get::<i64, _>("available_at") >= store::now());
    let cursor: String = sqlx::query_scalar("SELECT cursor FROM run_checkpoints WHERE run_id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cursor, "2");
    sqlx::query("UPDATE runs SET available_at=0 WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let mut runner = runner::Runner::new(
        pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        1,
    );
    runner.dispatch().await.unwrap();
    runner.drain().await;
    let row = sqlx::query("SELECT state,committed_batches FROM runs WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("state"), "succeeded");
    assert_eq!(row.get::<i64, _>("committed_batches"), 2); // one before crash, one after cursor 2
    sqlx::query("UPDATE runs SET state='running',attempt=3 WHERE id=?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    runner::recover(&pool, &f.events, 3).await.unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM runs WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "failed");
    drop(runner);
    pool.close().await;
    drop(pool);
    f.close().await;
}
#[tokio::test]
async fn backup_retention_lock_and_restore_round_trip() {
    let f = Fixture::new().await;
    let backups = backup::Backups::new(f.config.clone());
    let first = backups.create(&f.pool).await.unwrap();
    let _ = backups.create(&f.pool).await.unwrap();
    let newest = backups.create(&f.pool).await.unwrap();
    assert!(!first.exists());
    assert_eq!(backups.list().await.unwrap().len(), 2);
    let lock = security::lock(&f.dir).unwrap();
    assert!(security::lock(&f.dir).is_err());
    assert!(backup::restore(&f.config, &newest).await.is_err());
    drop(lock);
    sqlx::query("UPDATE sources SET name='Changed'")
        .execute(&f.pool)
        .await
        .unwrap();
    f.pool.close().await;
    backup::restore(&f.config, &newest).await.unwrap();
    let pool = store::open(&f.dir).await.unwrap();
    let name: String = sqlx::query_scalar("SELECT name FROM sources WHERE id='source'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Noop");
    pool.close().await;
    f.close().await;
}
#[tokio::test]
async fn auth_and_crud_and_cancellation() {
    let f = Fixture::new().await;
    let app = api::router(api::App {
        pool: f.pool.clone(),
        sql: crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
        events: f.events.clone(),
        backups: backup::Backups::new(f.config.clone()),
        started: Instant::now(),
    });
    for (token, status) in [
        (None, StatusCode::UNAUTHORIZED),
        (Some("bad-token"), StatusCode::UNAUTHORIZED),
        (Some("good-token"), StatusCode::OK),
    ] {
        let mut request = Request::builder().uri("/v1/status");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        assert_eq!(
            app.clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            status
        );
    }
    assert_eq!(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/sources")
                .method("POST")
                .header("authorization", "Bearer good-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"name":"External","kind":"external","credential_id":null}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let id = f.enqueue().await;
    let mut rx = f.events.subscribe();
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/v1/runs/{id}/cancel"))
                .method("POST")
                .header("authorization", "Bearer good-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(f.state(&id).await, "cancelled");
    let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["state"], "cancelled");
    drop(app);
    f.close().await;
}
#[tokio::test]
async fn audit_is_append_only_and_token_is_persistent() {
    let f = Fixture::new().await;
    f.enqueue().await;
    assert!(
        sqlx::query("UPDATE audit_log SET detail='changed'")
            .execute(&f.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM audit_log")
            .execute(&f.pool)
            .await
            .is_err()
    );
    use secrecy::ExposeSecret;
    let token = security::token(&f.dir).unwrap();
    assert_eq!(token.expose_secret().len(), 64);
    assert_eq!(
        token.expose_secret(),
        security::token(&f.dir).unwrap().expose_secret()
    );
    f.close().await;
}
#[test]
fn config_rejects_insecure_bind_and_zero_limits() {
    let example: Config = toml::from_str(include_str!("../../../straton.example.toml")).unwrap();
    example.validate().unwrap();
    let mut c = Config {
        bind: "0.0.0.0:8787".parse().unwrap(),
        ..Default::default()
    };
    assert!(c.validate().is_err());
    c.tls_cert = Some("cert.pem".into());
    c.tls_key = Some("key.pem".into());
    assert!(c.validate().is_ok());
    c.max_concurrent_runs = 0;
    assert!(c.validate().is_err());
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
#[tokio::test]
async fn catalog_api_secrets_manual_rules() {
    let f = Fixture::new().await;
    let app = app(&f);
    let secret = "never-return-this-password";
    let (status, s) = request(
        &app,
        "POST",
        "/v1/sources",
        json!({"name":"Placeholder","kind":"external","secret":secret}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = s["id"].as_str().unwrap();
    assert!(!s.to_string().contains(secret));
    let (_, sources) = request(&app, "GET", "/v1/sources", json!(null)).await;
    assert!(!sources.to_string().contains(secret));
    assert!(!sources.to_string().contains("\"secret\""));
    use secrecy::ExposeSecret;
    assert_eq!(
        crate::credentials::get(id)
            .unwrap()
            .unwrap()
            .expose_secret(),
        secret
    );
    let (status, _) = request(
        &app,
        "POST",
        "/v1/sources",
        json!({"name":"Bad","kind":"postgres","config":{"password":secret}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, updated) = request(
        &app,
        "PUT",
        &format!("/v1/sources/{id}"),
        json!({"name":"Renamed","kind":"external"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["credential_id"], id);
    assert_eq!(
        crate::credentials::get(id)
            .unwrap()
            .unwrap()
            .expose_secret(),
        secret
    );
    assert!(
        !sqlx::query_scalar::<_, String>("SELECT config FROM sources WHERE id=?")
            .bind(id)
            .fetch_one(&f.pool)
            .await
            .unwrap()
            .contains(secret)
    );
    let mut ids = Vec::new();
    for name in ["users", "orders"] {
        let(status,d)=request(&app,"POST",&format!("/v1/sources/{id}/datasets"),json!({"name":name,"columns":[{"name":"id","type":"Int64","nullable":false,"pk":true}]})).await;
        assert_eq!(status, StatusCode::CREATED);
        ids.push(d["id"].as_str().unwrap().to_string());
    }
    let (status, map) = request(&app, "GET", "/v1/datamap", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(map["edges"].is_array());
    assert!(
        map["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["type"] == "source" && n["id"] == id && n["connected"] == false)
    );
    let dataset = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["type"] == "dataset")
        .unwrap();
    assert_eq!(
        dataset["columns"][0],
        json!({"name":"id","type":"Int64","nullable":false,"pk":true,"masked":false,"mask_kind":null})
    );
    let(status,r)=request(&app,"POST","/v1/relationships",json!({"kind":"manual","from_dataset":ids[0],"from_cols":["id"],"to_dataset":ids[1],"to_cols":["id"],"confidence":null})).await;
    assert_eq!(status, StatusCode::CREATED);
    let rid = r["id"].as_str().unwrap();
    sqlx::query("UPDATE relationships SET kind='declared_fk' WHERE id=?")
        .bind(rid)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/v1/relationships/{rid}"),
            json!(null)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE relationships SET kind='manual' WHERE id=?")
        .bind(rid)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "DELETE",
            &format!("/v1/relationships/{rid}"),
            json!(null)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let (status, s2) = request(
        &app,
        "POST",
        "/v1/sources",
        json!({"name":"Temporary","kind":"external","secret":secret}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id2 = s2["id"].as_str().unwrap();
    assert_eq!(
        request(&app, "DELETE", &format!("/v1/sources/{id2}"), json!(null))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert!(crate::credentials::get(id2).unwrap().is_none());
    drop(app);
    f.close().await;
}
#[tokio::test]
async fn inference_positive_negative_and_declared() {
    let f = Fixture::new().await;
    let mut tx = f.pool.begin().await.unwrap();
    for (id, source, name, cols) in [
        ("u", "source", "users", vec![("id", "Int64", true)]),
        (
            "o",
            "source",
            "orders",
            vec![
                ("id", "Int64", true),
                ("user_id", "Int64", false),
                ("userid", "Utf8", false),
                ("missing_id", "Int64", false),
            ],
        ),
        ("c", "other", "users", vec![("id", "Int32", true)]),
        (
            "bad",
            "source",
            "user",
            vec![("id", "Int64", true), ("other", "Int64", true)],
        ),
    ] {
        if source == "other" {
            sqlx::query("INSERT INTO sources(id,name,kind) VALUES('other','Other','external')")
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO datasets(id,source_id,name) VALUES(?,?,?)")
            .bind(id)
            .bind(source)
            .bind(name)
            .execute(&mut *tx)
            .await
            .unwrap();
        for (name, typ, pk) in cols {
            sqlx::query("INSERT INTO columns(id,dataset_id,name,data_type,nullable,primary_key) VALUES(?,?,?,?,0,?)").bind(store::id()).bind(id).bind(name).bind(typ).bind(pk).execute(&mut *tx).await.unwrap();
        }
    }
    crate::catalog::infer(&mut tx).await.unwrap();
    let rows = sqlx::query("SELECT * FROM relationships")
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|r| r.get::<f64, _>("confidence") == 0.9));
    assert!(rows.iter().any(|r| r.get::<f64, _>("confidence") == 0.6));
    sqlx::query("INSERT INTO relationships(id,from_dataset,from_cols,to_dataset,to_cols,kind) VALUES('declared','o','[\"user_id\"]','u','[\"id\"]','declared_fk')").execute(&mut *tx).await.unwrap();
    crate::catalog::infer(&mut tx).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE kind='inferred'")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        1
    );
    crate::catalog::infer(&mut tx).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        2
    );
    tx.commit().await.unwrap();
    f.close().await;
}
#[tokio::test]
async fn sqlite_sync_and_crash_resume() {
    let mut f = Fixture::new().await;
    // Pre-upgrade checkpoint fixture: explicitly exercise the legacy plaintext path.
    f.config.encryption.enabled = false;
    let path = f.dir.join("input.db");
    let input = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO users VALUES(1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e');").execute(&input).await.unwrap();
    input.close().await;
    sqlx::query("UPDATE sources SET name='App DB',kind='sqlite',config=? WHERE id='source'")
        .bind(json!({"path":path,"batch_size":2}).to_string())
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET dataset='users'")
        .execute(&f.pool)
        .await
        .unwrap();
    let mut rx = f.events.subscribe();
    let app = app(&f);
    assert_eq!(
        request(&app, "POST", "/v1/sources/source/discover", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(rx.recv().await.unwrap()["type"], "catalog.changed");
    let id = f.enqueue().await;
    runner::state(&f.pool, &f.events, &id, "running", None)
        .await
        .unwrap();
    let backups = backup::Backups::new(f.config.clone());
    // Commit the first batch; leave the second file durable but uncheckpointed, as after a crash.
    let c = crate::catalog::connector(&f.pool, "source").await.unwrap();
    let mut stream = c.read("users", Default::default()).await.unwrap();
    use futures::StreamExt;
    let (batch, cursor) = stream.next().await.unwrap().unwrap();
    let output = f.dir.join("data/source/users");
    let staging = output.join(format!(".staging-{id}"));
    straton_connectors::write_parquet(&staging.join("part-000000.parquet"), &batch, None).unwrap();
    runner::checkpoint(&f.pool, &id, &cursor).await.unwrap();
    let (batch, _) = stream.next().await.unwrap().unwrap();
    straton_connectors::write_parquet(&staging.join("part-000001.parquet"), &batch, None).unwrap();
    drop(stream);
    drop(c);
    assert!(!output.join("_current").exists());
    runner::recover(&f.pool, &f.events, 3).await.unwrap();
    sqlx::query("UPDATE runs SET state='running' WHERE id=?")
        .bind(&id)
        .execute(&f.pool)
        .await
        .unwrap();
    runner::execute(&f.pool, &backups, &id, &f.events)
        .await
        .unwrap();
    let mut rows = 0;
    let mut ids = Vec::new();
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        id
    );
    assert!(!staging.exists());
    for file in std::fs::read_dir(output.join(&id)).unwrap() {
        let path = file.unwrap().path();
        assert_eq!(path.extension().unwrap(), "parquet");
        use straton_connectors::parquet::{file::reader::FileReader, record::RowAccessor};
        let file = straton_connectors::parquet::file::reader::SerializedFileReader::new(
            std::fs::File::open(&path).unwrap(),
        )
        .unwrap();
        ids.extend(
            file.get_row_iter(None)
                .unwrap()
                .map(|row| row.unwrap().get_long(0).unwrap()),
        );
        let reader=straton_connectors::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(path).unwrap()).unwrap().build().unwrap();
        for b in reader {
            let b = b.unwrap();
            rows += b.num_rows();
        }
    }
    assert_eq!(rows, 5);
    ids.sort();
    assert_eq!(ids, vec![1, 2, 3, 4, 5]);
    assert_eq!(std::fs::read_dir(output.join(&id)).unwrap().count(), 3);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT committed_batches FROM runs WHERE id=?")
            .bind(&id)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE kind='lineage'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    let map = crate::catalog::datamap(&f.pool).await.unwrap();
    let lake = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["source_id"] == "straton-local-lake")
        .unwrap();
    assert_eq!(lake["name"], "source/users");
    assert_eq!(lake["display_name"], "App DB.users");
    assert_eq!(lake["row_count"], 5);
    let synced_at = lake["last_synced_at"].as_str().unwrap();
    chrono::DateTime::parse_from_rfc3339(synced_at).unwrap();
    let source = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["source_id"] == "source" && n["name"] == "users")
        .unwrap();
    assert_eq!(source["row_count"], 5);
    assert_eq!(source["last_synced_at"], synced_at);
    assert_eq!(lake["sql_schema"], "local_lake");
    assert_eq!(lake["sql_table"], "app_db_users");
    let lake_id = lake["id"].clone();
    sqlx::query("UPDATE sources SET name='Renamed App DB' WHERE id='source'")
        .execute(&f.pool)
        .await
        .unwrap();
    // A full refresh replaces the prior snapshot and cleans abandoned work only.
    let queued = f.enqueue().await;
    let running = f.enqueue().await;
    runner::state(&f.pool, &f.events, &running, "running", None)
        .await
        .unwrap();
    let failed = f.enqueue().await;
    runner::state(&f.pool, &f.events, &failed, "failed", None)
        .await
        .unwrap();
    let cancelled = f.enqueue().await;
    runner::state(&f.pool, &f.events, &cancelled, "cancelled", None)
        .await
        .unwrap();
    for run in [&queued, &running, &failed, &cancelled] {
        std::fs::create_dir_all(output.join(format!(".staging-{run}"))).unwrap();
    }
    let second = f.enqueue().await;
    runner::state(&f.pool, &f.events, &second, "running", None)
        .await
        .unwrap();
    runner::execute(&f.pool, &backups, &second, &f.events)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        second
    );
    assert!(!output.join(&id).exists());
    assert!(!output.join(format!(".staging-{second}")).exists());
    for run in [&failed, &cancelled] {
        assert!(!output.join(format!(".staging-{run}")).exists());
    }
    for run in [&queued, &running] {
        assert!(output.join(format!(".staging-{run}")).is_dir());
    }
    let snapshots: Vec<_> = std::fs::read_dir(&output)
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| {
            e.file_type().unwrap().is_dir()
                && !e.file_name().to_string_lossy().starts_with(".staging-")
        })
        .collect();
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].file_name().to_str().unwrap(), second);
    let count = std::fs::read_dir(output.join(&second)).unwrap().map(|p|
        straton_connectors::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(p.unwrap().path()).unwrap()).unwrap().metadata().file_metadata().num_rows()
    ).sum::<i64>();
    assert_eq!(count, 5);
    let map = crate::catalog::datamap(&f.pool).await.unwrap();
    let lake = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["id"] == lake_id)
        .unwrap();
    assert_eq!(lake["name"], "source/users");
    assert_eq!(lake["display_name"], "Renamed App DB.users");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE kind='lineage'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    drop(app);
    f.close().await;
}

#[tokio::test]
async fn discovery_reconciles_catalog_and_preserves_manual_edges() {
    let f = Fixture::new().await;
    let path = f.dir.join("drift.db");
    let input = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE users(id INTEGER PRIMARY KEY,old TEXT); CREATE TABLE orders(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id)); CREATE TABLE obsolete(id INTEGER PRIMARY KEY);").execute(&input).await.unwrap();
    sqlx::query("UPDATE sources SET kind='sqlite',config=? WHERE id='source'")
        .bind(json!({"path":path}).to_string())
        .execute(&f.pool)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    let users: String = sqlx::query_scalar("SELECT id FROM datasets WHERE name='users'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let orders: String = sqlx::query_scalar("SELECT id FROM datasets WHERE name='orders'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let obsolete: String = sqlx::query_scalar("SELECT id FROM datasets WHERE name='obsolete'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    crate::catalog::edge(
        &mut tx,
        &straton_core::Relationship {
            id: "manual-keep".into(),
            from_dataset: orders.clone(),
            from_cols: vec!["user_id".into()],
            to_dataset: users.clone(),
            to_cols: vec!["id".into()],
            kind: straton_core::RelationshipKind::Manual,
            confidence: None,
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    sqlx::raw_sql("ALTER TABLE users DROP COLUMN old; DROP TABLE obsolete;")
        .execute(&input)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT id FROM datasets WHERE name='users'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        users
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM columns WHERE name='old'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM datasets WHERE id=?")
            .bind(obsolete)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE kind='declared_fk'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE kind='inferred'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE id='manual-keep'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("DROP TABLE orders")
        .execute(&input)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    let app = app(&f);
    let (status, map) = request(&app, "GET", "/v1/datamap", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    let stale = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == orders)
        .unwrap();
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["columns"].as_array().unwrap().len(), 2);
    assert!(
        map["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["kind"] == "manual")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='dataset.stale' AND entity_id=?"
        )
        .bind(&orders)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        1
    );
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='dataset.stale' AND entity_id=?"
        )
        .bind(&orders)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        1
    );
    sqlx::query("CREATE TABLE orders(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id))")
        .execute(&input)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    let (_, map) = request(&app, "GET", "/v1/datamap", json!(null)).await;
    let restored = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == orders)
        .unwrap();
    assert_eq!(restored["stale"], false);
    assert!(
        map["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "declared_fk")
    );
    drop(app);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM datasets WHERE id=?")
            .bind(orders)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM relationships WHERE id='manual-keep'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    input.close().await;
    f.close().await;
}

#[tokio::test]
async fn snapshot_publication_failure_cancellation_and_recovery() {
    let f = Fixture::new().await;
    // Completed snapshot directories must be publishable without rereading the source.
    sqlx::query("UPDATE sources SET kind='sqlite' WHERE id='source'")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sources(id,name,kind) VALUES('straton-local-lake','Local lake','parquet')",
    )
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO datasets(id,source_id,name) VALUES('origin','source','test'),('lake','straton-local-lake','source/test')").execute(&f.pool).await.unwrap();
    let output = f.dir.join("data/source/test");
    let previous = f.enqueue().await;
    runner::state(&f.pool, &f.events, &previous, "succeeded", None)
        .await
        .unwrap();
    std::fs::create_dir_all(output.join(&previous)).unwrap();
    std::fs::write(output.join("_current"), &previous).unwrap();

    let failed = f.enqueue().await;
    runner::state(&f.pool, &f.events, &failed, "running", None)
        .await
        .unwrap();
    std::fs::create_dir(output.join(&failed)).unwrap();
    // Force failure before the pointer rename; the previous snapshot must remain current.
    std::fs::create_dir(output.join("_current.partial")).unwrap();
    let pool = f.pool.clone();
    let events = f.events.clone();
    let run = failed.clone();
    let backups = backup::Backups::new(f.config.clone());
    runner::supervise(
        f.pool.clone(),
        f.events.clone(),
        failed.clone(),
        async move { runner::execute(&pool, &backups, &run, &events).await },
    )
    .await
    .unwrap();
    assert_eq!(f.state(&failed).await, "failed");
    let count: Option<i64> = sqlx::query_scalar("SELECT row_count FROM datasets WHERE id='origin'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, None);
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        previous
    );
    assert!(output.join(&previous).is_dir());
    std::fs::remove_dir(output.join("_current.partial")).unwrap();

    let cancelled = f.enqueue().await;
    runner::state(&f.pool, &f.events, &cancelled, "running", None)
        .await
        .unwrap();
    std::fs::create_dir(output.join(format!(".staging-{cancelled}"))).unwrap();
    sqlx::query("UPDATE runs SET cancel_requested=1 WHERE id=?")
        .bind(&cancelled)
        .execute(&f.pool)
        .await
        .unwrap();
    let pool = f.pool.clone();
    let events = f.events.clone();
    let run = cancelled.clone();
    let backups = backup::Backups::new(f.config.clone());
    runner::supervise(
        f.pool.clone(),
        f.events.clone(),
        cancelled.clone(),
        async move { runner::execute(&pool, &backups, &run, &events).await },
    )
    .await
    .unwrap();
    assert_eq!(f.state(&cancelled).await, "cancelled");
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        previous
    );
    assert!(output.join(format!(".staging-{cancelled}")).is_dir());

    let resumed = f.enqueue().await;
    runner::state(&f.pool, &f.events, &resumed, "running", None)
        .await
        .unwrap();
    let staging = output.join(format!(".staging-{resumed}"));
    std::fs::create_dir(&staging).unwrap();
    // Simulate a crash between the directory rename and the _current update (empty snapshot).
    std::fs::rename(&staging, output.join(&resumed)).unwrap();
    runner::recover(&f.pool, &f.events, 3).await.unwrap();
    sqlx::query("UPDATE runs SET state='running' WHERE id=?")
        .bind(&resumed)
        .execute(&f.pool)
        .await
        .unwrap();
    let pool = f.pool.clone();
    let events = f.events.clone();
    let run = resumed.clone();
    let backups = backup::Backups::new(f.config.clone());
    runner::supervise(
        f.pool.clone(),
        f.events.clone(),
        resumed.clone(),
        async move { runner::execute(&pool, &backups, &run, &events).await },
    )
    .await
    .unwrap();
    assert_eq!(f.state(&resumed).await, "succeeded");
    for dataset in ["origin", "lake"] {
        let row = sqlx::query("SELECT row_count,last_synced_at FROM datasets WHERE id=?")
            .bind(dataset)
            .fetch_one(&f.pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("row_count"), 0);
        chrono::DateTime::parse_from_rfc3339(row.get::<&str, _>("last_synced_at")).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        resumed
    );
    assert_eq!(
        std::fs::read_dir(&output)
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_type().unwrap().is_dir())
            .count(),
        1
    );
    assert!(!output.join(&previous).exists());
    assert!(!output.join(&failed).exists());
    assert!(!output.join(format!(".staging-{cancelled}")).exists());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE entity_id=? AND action='run.succeeded'"
        )
        .bind(&resumed)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        1
    );
    f.close().await;
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
#[tokio::test]
async fn sql_rest_current_snapshot_preview_explain_and_audit() {
    use sha2::{Digest, Sha256};
    let f = sql_fixture().await;
    let a = app(&f);
    let (_, tables) = request(&a, "GET", "/v1/sql/tables", json!(null)).await;
    assert_eq!(tables["tables"], json!([]));
    let first = sql_sync(&f).await;
    let query = "SELECT id,name FROM app_db.users ORDER BY id";
    let (status, result) = request(&a, "POST", "/v1/sql", json!({"query":query})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["rows"], json!([[1, "Alice"], [2, "Bob"]]));
    assert_eq!(
        result["columns"],
        json!([{"name":"id","type":"Int64"},{"name":"name","type":"Utf8"}])
    );
    assert_eq!(result["row_count"], 2);
    assert_eq!(result["truncated_preview"], false);
    let (_, preview) = request(&a, "POST", "/v1/sql", json!({"query":query,"limit":1})).await;
    assert_eq!(preview["rows"], json!([[1, "Alice"]]));
    assert_eq!(preview["row_count"], 2);
    assert_eq!(preview["truncated_preview"], true);
    assert_eq!(
        request(&a, "POST", "/v1/sql", json!({"query":query,"limit":1001}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (_, tables) = request(&a, "GET", "/v1/sql/tables", json!(null)).await;
    let tables = tables["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 2);
    assert!(
        tables
            .iter()
            .any(|t| t["schema"] == "app_db" && t["name"] == "users")
    );
    assert!(
        tables
            .iter()
            .any(|t| t["schema"] == "local_lake" && t["name"] == "app_db_users")
    );
    let (status, lake) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name FROM local_lake.\"app_db_users\" ORDER BY id"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{lake}");
    assert_eq!(lake["rows"], result["rows"]);
    let (status, plans) = request(&a, "POST", "/v1/sql/explain", json!({"query":query})).await;
    assert_eq!(status, StatusCode::OK, "{plans}");
    assert!(plans["logical"].as_str().unwrap().contains("TableScan"));
    assert!(!plans["physical"].as_str().unwrap().is_empty());

    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action='sql.query' ORDER BY id LIMIT 1",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!detail.contains(query));
    assert!(!detail.contains("SELECT"));
    let detail: serde_json::Value = serde_json::from_str(&detail).unwrap();
    assert_eq!(detail["query_hash"], format!("{:x}", Sha256::digest(query)));
    assert_eq!(detail["principal"], "admin");
    assert_eq!(detail["row_count"], 2);
    assert!(
        detail["datasets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d.as_str().unwrap().contains("app_db.users"))
    );

    // Stray older and staging snapshots must never become query inputs.
    let output = f.dir.join("data/source/users");
    let ignored = output.join(format!(".staging-{}", store::id()));
    std::fs::create_dir_all(&ignored).unwrap();
    std::fs::copy(
        output.join(&first).join("part-000000.parquet"),
        ignored.join("extra.parquet"),
    )
    .unwrap();
    let old = output.join(store::id());
    std::fs::create_dir_all(&old).unwrap();
    std::fs::copy(
        output.join(&first).join("part-000001.parquet"),
        old.join("old.parquet"),
    )
    .unwrap();
    let (_, unchanged) = request(&a, "POST", "/v1/sql", json!({"query":query})).await;
    assert_eq!(unchanged["rows"], result["rows"]);
    let input =
        sqlx::SqlitePool::connect(&format!("sqlite:{}", f.dir.join("sql-input.db").display()))
            .await
            .unwrap();
    sqlx::raw_sql("DELETE FROM users; INSERT INTO users VALUES(3,'Cara');")
        .execute(&input)
        .await
        .unwrap();
    input.close().await;
    let second = sql_sync(&f).await;
    assert_ne!(first, second);
    let (status, updated) = request(&a, "POST", "/v1/sql", json!({"query":query})).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["rows"], json!([[3, "Cara"]]));
    assert_eq!(updated["row_count"], 1);
    let input =
        sqlx::SqlitePool::connect(&format!("sqlite:{}", f.dir.join("sql-input.db").display()))
            .await
            .unwrap();
    sqlx::query("DELETE FROM users")
        .execute(&input)
        .await
        .unwrap();
    input.close().await;
    sql_sync(&f).await;
    let (status, empty) = request(&a, "POST", "/v1/sql", json!({"query":query})).await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(empty["rows"], json!([]));
    assert_eq!(empty["columns"], result["columns"]);
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn sql_rejects_writes_and_enforces_limits_auth_and_timeout() {
    use sha2::{Digest, Sha256};
    let mut f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let queries = [
        "CREATE TABLE secret (x INT)",
        "INSERT INTO app_db.users VALUES(3,'forbidden')",
        "DELETE FROM app_db.users",
        "COPY (SELECT * FROM app_db.users) TO 'forbidden.parquet'",
        "SET datafusion.execution.batch_size = 1",
        "SELECT 1; CREATE TABLE x (id INT)",
        "EXPLAIN CREATE TABLE x (id INT)",
        "SELECT 1 INTO secret",
        "EXPLAIN ANALYZE SELECT * FROM app_db.users",
    ];
    for query in queries {
        let (status, error) = request(&a, "POST", "/v1/sql", json!({"query":query})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {error}");
        let detail: String = sqlx::query_scalar(
            "SELECT detail FROM audit_log WHERE action='sql.rejected' ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(&f.pool)
        .await
        .unwrap();
        assert!(!detail.contains(query));
        let detail: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(detail["query_hash"], format!("{:x}", Sha256::digest(query)));
        assert_eq!(detail["error_class"], "rejected");
    }
    let response = a
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/sql")
                .header("authorization", "Bearer bad-token")
                .header("content-type", "application/json")
                .body(Body::from(json!({"query":"SELECT 1"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    drop(a);
    f.config.sql.max_rows = 1;
    let a = app(&f);
    let (status, error) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM app_db.users","limit":1}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert!(error["error"].as_str().unwrap().contains("max_rows"));
    drop(a);
    f.config.sql.max_rows = 100_000;
    f.config.sql.query_timeout_secs = 0.001;
    let a = app(&f);
    let guard = crate::sql::SNAPSHOTS.write().await;
    let (status, error) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM app_db.users"}),
    )
    .await;
    assert_eq!(status, StatusCode::REQUEST_TIMEOUT, "{error}");
    drop(guard);
    let (running_status, running_error) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT sum(value) FROM generate_series(1, 1000000000000)"}),
    )
    .await;
    assert_eq!(
        running_status,
        StatusCode::REQUEST_TIMEOUT,
        "{running_error}"
    );
    let released = tokio::time::timeout(Duration::from_secs(5), crate::sql::SNAPSHOTS.write())
        .await
        .unwrap();
    drop(released);
    assert!(error["error"].as_str().unwrap().contains("timed out"));
    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action='sql.query' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&detail).unwrap()["error_class"],
        "timeout"
    );
    drop(a);
    f.config.sql.enabled = false;
    assert_eq!(
        request(&app(&f), "POST", "/v1/sql", json!({"query":"SELECT 1"}))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    f.close().await;
}
#[tokio::test]
async fn sql_memory_limit_and_schema_collisions() {
    let mut f = sql_fixture().await;
    sql_sync(&f).await;
    sqlx::query("INSERT INTO sources(id,name,kind) VALUES('aaa','App-DB','external'),('aab','app_db_2','external'),('aac','123','external')")
        .execute(&f.pool).await.unwrap();
    let a = app(&f);
    let (_, tables) = request(&a, "GET", "/v1/sql/tables", json!(null)).await;
    assert!(
        tables["tables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["schema"] == "app_db_3")
    );
    drop(a);
    f.config.sql.memory_limit_mb = 1;
    f.config.sql.max_rows = 1_000_000;
    let a = app(&f);
    let (status, error) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM generate_series(1, 1000000)"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action='sql.query' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&detail).unwrap()["error_class"],
        "memory_limit",
        "{error}"
    );
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn sql_pgwire_simple_extended_auth_and_refresh() {
    use sqlx::{
        Connection, Executor, PgConnection,
        postgres::{PgConnectOptions, PgSslMode},
    };
    let mut f = sql_fixture().await;
    sql_sync(&f).await;
    f.config.sql.bind = "127.0.0.1:0".parse().unwrap();
    let service = crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap();
    let mut server = crate::sql::wire::Server::start(
        service,
        Arc::new("good-token".to_owned().into()),
        &f.config,
    )
    .await
    .unwrap();
    let options = PgConnectOptions::new()
        .host("127.0.0.1")
        .port(server.address.unwrap().port())
        .username("admin")
        .database("straton")
        .password("good-token")
        .ssl_mode(PgSslMode::Disable);
    let mut conn = PgConnection::connect_with(&options).await.unwrap();
    let rows = conn
        .fetch_all("SELECT id,name FROM app_db.users ORDER BY id")
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<i64, _>(0), 1);
    assert_eq!(rows[1].get::<String, _>(1), "Bob");
    let prepared = conn
        .prepare("SELECT name FROM app_db.users WHERE id=$1")
        .await
        .unwrap();
    drop(prepared);
    let row = sqlx::query("SELECT name FROM app_db.users WHERE id=$1")
        .bind(2_i64)
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>(0), "Bob");
    let row = sqlx::query("SELECT $1 AS n, $2 AS s, $3 AS b, $4 AS f")
        .bind(7_i32)
        .bind("O'Reilly; DROP TABLE x")
        .bind(true)
        .bind(1.25_f64)
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(row.get::<i32, _>(0), 7);
    assert_eq!(row.get::<String, _>(1), "O'Reilly; DROP TABLE x");
    assert!(row.get::<bool, _>(2));
    assert_eq!(row.get::<f64, _>(3), 1.25);
    let row=sqlx::query("SELECT CAST(1 AS SMALLINT) AS a, CAST(2 AS REAL) AS b, DATE '2026-10-20' AS d, TIMESTAMP '2026-10-20 12:34:56' AS t")
        .fetch_one(&mut conn).await.unwrap();
    assert_eq!(row.get::<i16, _>(0), 1);
    assert_eq!(row.get::<f32, _>(1), 2.0);
    assert_eq!(
        row.get::<chrono::NaiveDate, _>(2),
        chrono::NaiveDate::from_ymd_opt(2026, 10, 20).unwrap()
    );
    assert_eq!(
        row.get::<chrono::NaiveDateTime, _>(3).to_string(),
        "2026-10-20 12:34:56"
    );
    assert_eq!(
        conn.fetch_one("SHOW transaction_read_only")
            .await
            .unwrap()
            .get::<String, _>(0),
        "on"
    );
    assert_eq!(
        conn.fetch_one("SELECT current_schema()")
            .await
            .unwrap()
            .get::<String, _>(0),
        "public"
    );
    assert!(
        conn.fetch_one("SELECT version()")
            .await
            .unwrap()
            .get::<String, _>(0)
            .contains("Straton")
    );
    conn.execute("SET extra_float_digits = 3").await.unwrap();
    assert!(
        sqlx::query("COPY (SELECT 1) TO 'no.parquet'")
            .execute(&mut conn)
            .await
            .is_err()
    );
    assert!(conn.execute("CREATE TABLE no (id INT)").await.is_err());
    assert_eq!(
        conn.fetch_one("SELECT 1").await.unwrap().get::<i64, _>(0),
        1
    );
    let bad = PgConnection::connect_with(&options.clone().password("wrong-token")).await;
    assert!(bad.is_err());
    conn.close().await.unwrap();
    server.shutdown().await;
    f.close().await;
}
#[test]
fn sql_config_defaults_and_remote_tls_rule() {
    let mut c = Config::default();
    assert!(c.sql.enabled);
    assert_eq!(c.sql.max_rows, 100_000);
    assert_eq!(c.sql.query_timeout_secs, 60.0);
    assert_eq!(c.sql.memory_limit_mb, 1024);
    assert!(c.validate().is_ok());
    c.sql.bind = "0.0.0.0:5433".parse().unwrap();
    assert!(c.validate().is_err());
    c.tls_cert = Some("cert.pem".into());
    c.tls_key = Some("key.pem".into());
    assert!(c.validate().is_ok());
    c.sql.query_timeout_secs = f64::NAN;
    assert!(c.validate().is_err());
}

#[tokio::test]
async fn dataset_metrics_start_null_and_sql_aliases_are_deduplicated() {
    let f = Fixture::new().await;
    sqlx::query("INSERT INTO sources(id,name,kind) VALUES('other','App DB','sqlite'),('straton-local-lake','Local lake','parquet')").execute(&f.pool).await.unwrap();
    sqlx::query("UPDATE sources SET name='App DB' WHERE id='source'")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO datasets(id,source_id,name) VALUES('a','straton-local-lake','other/users'),('b','straton-local-lake','source/users'),('c','source','123 table')").execute(&f.pool).await.unwrap();
    let map = crate::catalog::datamap(&f.pool).await.unwrap();
    let nodes = map["nodes"].as_array().unwrap();
    for id in ["a", "b", "c"] {
        let node = nodes.iter().find(|n| n["id"] == id).unwrap();
        assert!(node["row_count"].is_null());
        assert!(node["last_synced_at"].is_null());
    }
    let a = nodes.iter().find(|n| n["id"] == "a").unwrap();
    let b = nodes.iter().find(|n| n["id"] == "b").unwrap();
    assert_eq!(a["sql_table"], "app_db_users");
    assert_eq!(b["sql_table"], "app_db_users_2");
    assert_eq!(
        nodes.iter().find(|n| n["id"] == "c").unwrap()["sql_table"],
        "123 table"
    );
    f.close().await;
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
/// Expected `hash` mask output: HMAC-SHA256 under this state.db's mask key.
async fn masked_hash(pool: &SqlitePool, value: &str) -> String {
    let key = crate::store::mask_key(pool).await.unwrap();
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &key);
    ring::hmac::sign(&key, value.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
async fn dataset_id(f: &Fixture, name: &str) -> String {
    sqlx::query_scalar("SELECT id FROM datasets WHERE source_id='source' AND name=?")
        .bind(name)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
#[tokio::test]
async fn access_tokens_hash_once_revoke_expire_disable_and_throttle() {
    let f = Fixture::new().await;
    let a = app(&f);
    let role = access_role(&a, "reader").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (id, token) = access_user(&a, "alice", &[&role]).await;
    assert!(token.starts_with("stn_"));
    assert_eq!(token.len(), 68);
    let stored: String = sqlx::query_scalar("SELECT token_hash FROM api_tokens WHERE user_id=?")
        .bind(&id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(stored, crate::access::hash(&token));
    assert_ne!(stored, token);
    let (_, list) = request(&a, "GET", &format!("/v1/users/{id}/tokens"), json!(null)).await;
    assert!(!list.to_string().contains(&token));
    assert!(!list.to_string().contains(&stored));
    let tid = list[0]["id"].as_str().unwrap();
    let (s, me) = request_as(&a, &token, "GET", "/v1/me", json!(null)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me["user"]["id"], id);
    assert_eq!(me["privileges"]["read"], true);
    sqlx::query("UPDATE api_tokens SET last_used_at=? WHERE id=?")
        .bind(store::now() - 30)
        .bind(tid)
        .execute(&f.pool)
        .await
        .unwrap();
    let previous: i64 = sqlx::query_scalar("SELECT last_used_at FROM api_tokens WHERE id=?")
        .bind(tid)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    request_as(&a, &token, "GET", "/v1/me", json!(null)).await;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT last_used_at FROM api_tokens WHERE id=?")
            .bind(tid)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        previous
    );
    sqlx::query("UPDATE api_tokens SET last_used_at=? WHERE id=?")
        .bind(store::now() - 61)
        .bind(tid)
        .execute(&f.pool)
        .await
        .unwrap();
    request_as(&a, &token, "GET", "/v1/me", json!(null)).await;
    assert!(
        sqlx::query_scalar::<_, i64>("SELECT last_used_at FROM api_tokens WHERE id=?")
            .bind(tid)
            .fetch_one(&f.pool)
            .await
            .unwrap()
            >= store::now() - 1
    );
    assert_eq!(
        request(
            &a,
            "DELETE",
            &format!("/v1/users/{id}/tokens/{tid}"),
            json!(null)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request_as(&a, &token, "GET", "/v1/me", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (_, fresh) = request(
        &a,
        "POST",
        &format!("/v1/users/{id}/tokens"),
        json!({"name":"expiring","expires_at":store::now()+3600}),
    )
    .await;
    let token = fresh["token"].as_str().unwrap();
    sqlx::query("UPDATE api_tokens SET expires_at=? WHERE id=?")
        .bind(store::now())
        .bind(fresh["id"].as_str().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request_as(&a, token, "GET", "/v1/me", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (_, fresh) = request(
        &a,
        "POST",
        &format!("/v1/users/{id}/tokens"),
        json!({"name":"disabled"}),
    )
    .await;
    let token = fresh["token"].as_str().unwrap();
    request(
        &a,
        "PUT",
        &format!("/v1/users/{id}"),
        json!({"name":"alice","disabled":true}),
    )
    .await;
    assert_eq!(
        request_as(&a, token, "GET", "/v1/me", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let audits: Vec<String> = sqlx::query_scalar("SELECT detail FROM audit_log")
        .fetch_all(&f.pool)
        .await
        .unwrap();
    assert!(
        audits
            .iter()
            .all(|d| !d.contains(token) && !d.contains(&stored))
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action IN ('user.created','token.created','token.revoked','user.updated','user.roles_updated') AND principal_id='admin'").fetch_one(&f.pool).await.unwrap();
    assert!(count >= 7);
    sqlx::query("UPDATE api_tokens SET revoked_at=? WHERE id='bootstrap'")
        .bind(store::now())
        .execute(&f.pool)
        .await
        .unwrap();
    crate::access::bootstrap(&f.pool, "good-token")
        .await
        .unwrap();
    assert!(
        crate::access::authenticate(&f.pool, "good-token")
            .await
            .is_err()
    );
    f.close().await;
}
#[tokio::test]
async fn access_privileges_scope_jobs_map_and_role_preview() {
    let f = sql_fixture().await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    sqlx::query("INSERT INTO sources(id,name,kind) VALUES('other','Other','external')")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO jobs(id,name,source_id,dataset,enabled,last_scheduled) VALUES('other-job','Other','other','secret',1,0)").execute(&f.pool).await.unwrap();
    sqlx::query(r#"INSERT INTO relationships(id,from_dataset,from_cols,to_dataset,to_cols,kind) SELECT 'hidden-edge',?,'["id"]',id,'["id"]','manual' FROM datasets WHERE name='unpublished'"#).bind(&did).execute(&f.pool).await.unwrap();
    let read = access_role(&a, "read").await;
    access_grant(&a, &read, "dataset", &did, "read").await;
    let (_, reader) = access_user(&a, "reader", &[&read]).await;
    for path in ["/v1/sources", "/v1/jobs"] {
        assert_eq!(
            request_as(&a, &reader, "POST", path, json!({})).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let (s, map) = request_as(&a, &reader, "GET", "/v1/datamap", json!(null)).await;
    assert_eq!(s, StatusCode::OK, "{map}");
    assert_eq!(map["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(map["edges"], json!([]));
    assert!(
        map["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["id"] != "other")
    );
    assert_eq!(
        request_as(
            &a,
            &reader,
            "GET",
            &format!("/v1/datamap?as_role={read}"),
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, preview) = request(
        &a,
        "GET",
        &format!("/v1/datamap?as_role={read}"),
        json!(null),
    )
    .await;
    assert_eq!(preview, map);
    let sync = access_role(&a, "sync").await;
    access_grant(&a, &sync, "source", "source", "sync_admin").await;
    let (uid, token) = access_user(&a, "operator", &[&sync]).await;
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/jobs/job/run", json!(null))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/jobs/other-job/run", json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request_as(
            &a,
            &token,
            "PUT",
            "/v1/jobs/job",
            json!({"name":"Moved","source_id":"other","dataset":"secret","enabled":true})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, jobs) = request_as(&a, &token, "GET", "/v1/jobs", json!(null)).await;
    assert_eq!(jobs.as_array().unwrap().len(), 1);
    let principal: String = sqlx::query_scalar(
        "SELECT principal_id FROM audit_log WHERE action='run.queued' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(principal, uid);
    let ds_sync = access_role(&a, "dataset sync").await;
    access_grant(&a, &ds_sync, "dataset", &did, "sync_admin").await;
    let (_, token) = access_user(&a, "dataset operator", &[&ds_sync]).await;
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/jobs/job/run", json!(null))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    let (_, jobs) = request_as(&a, &token, "GET", "/v1/jobs", json!(null)).await;
    assert_eq!(jobs.as_array().unwrap().len(), 1);
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/sources",
            json!({"name":"New","kind":"external"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    f.close().await;
}
#[tokio::test]
async fn access_sql_filters_masks_and_fail_closed() {
    use sha2::{Digest, Sha256};
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    let r1 = access_role(&a, "one").await;
    let r2 = access_role(&a, "two").await;
    let irrelevant = access_role(&a, "no read").await;
    for role in [&r1, &r2] {
        access_grant(&a, role, "dataset", &did, "read").await;
    }
    let (uid, token) = access_user(&a, "analyst", &[&r1, &irrelevant]).await;
    let query = json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"});
    for (role, predicate) in [(&r1, "id=1"), (&r2, "id=2"), (&irrelevant, "false")] {
        let (s, e) = request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/row-filters/{role}"),
            json!({"predicate":predicate}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{e}");
    }
    let (s, v) = request_as(&a, &token, "POST", "/v1/sql", query.clone()).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[1, "Alice"]]));
    for query in [
        "SELECT * FROM app_db.unpublished",
        "SELECT * FROM local_lake.app_db_users",
        "SELECT * FROM information_schema.tables",
    ] {
        assert_eq!(
            request_as(&a, &token, "POST", "/v1/sql", json!({"query":query}))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (_, tables) = request_as(&a, &token, "GET", "/v1/sql/tables", json!(null)).await;
    assert_eq!(tables["tables"].as_array().unwrap().len(), 1);
    request(
        &a,
        "PUT",
        &format!("/v1/users/{uid}/roles"),
        json!({"role_ids":[r1,r2,irrelevant]}),
    )
    .await;
    let (_, v) = request_as(&a, &token, "POST", "/v1/sql", query.clone()).await;
    assert_eq!(v["rows"], json!([[1, "Alice"], [2, "Bob"]]));
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/row-filters/{r2}"),
        json!({"predicate":"false"}),
    )
    .await;
    request(
        &a,
        "DELETE",
        &format!("/v1/datasets/{did}/row-filters/{r1}"),
        json!(null),
    )
    .await;
    let (_, v) = request_as(&a, &token, "POST", "/v1/sql", query.clone()).await;
    assert_eq!(v["rows"], json!([[1, "Alice"], [2, "Bob"]]));
    request(
        &a,
        "PUT",
        &format!("/v1/users/{uid}/roles"),
        json!({"role_ids":[r1]}),
    )
    .await;
    for (kind, expected) in [
        ("null", json!(null)),
        ("redact", json!("***")),
        ("hash", json!(masked_hash(&f.pool, "Alice").await)),
        ("last4", json!("****lice")),
    ] {
        let (s, e) = request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/masks/{r1}/name"),
            json!({"kind":kind}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{e}");
        let (s, v) = request_as(&a, &token, "POST", "/v1/sql", query.clone()).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["rows"][0][1], expected, "{kind}");
        if kind == "hash" {
            // Keyed: a reader cannot reverse it by hashing guesses with plain SHA-256...
            assert_ne!(expected, json!(format!("{:x}", Sha256::digest("Alice"))));
            // ...nor by calling the mask function, which is never registered in a session.
            let (s, e) = request_as(
                &a,
                &token,
                "POST",
                "/v1/sql",
                json!({"query":"SELECT straton_mask_hash('Alice')"}),
            )
            .await;
            assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
        }
    }
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/masks/{r1}/id"),
        json!({"kind":"null"}),
    )
    .await;
    let (_, v) = request_as(
        &a,
        &token,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id FROM app_db.users"}),
    )
    .await;
    assert_eq!(v["rows"], json!([[null], [null]]));
    assert_eq!(v["columns"][0]["type"], "Int64");
    request(
        &a,
        "DELETE",
        &format!("/v1/datasets/{did}/masks/{r1}/id"),
        json!(null),
    )
    .await;
    request(
        &a,
        "PUT",
        &format!("/v1/users/{uid}/roles"),
        json!({"role_ids":[r1,r2]}),
    )
    .await;
    let (_, v) = request_as(&a, &token, "POST", "/v1/sql", query.clone()).await;
    assert_eq!(v["rows"][0][1], "Alice");
    for (r, kind) in [(&r1, "redact"), (&r2, "hash")] {
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/masks/{r}/name"),
            json!({"kind":kind}),
        )
        .await;
    }
    let (_, v) = request_as(&a, &token, "POST", "/v1/sql", query.clone()).await;
    assert_eq!(v["rows"][0][1], "***");
    request(
        &a,
        "PUT",
        &format!("/v1/users/{uid}/roles"),
        json!({"role_ids":[r1]}),
    )
    .await;
    sqlx::query(
        "INSERT INTO row_filters(id,dataset_id,role_id,predicate) VALUES(?,?,?,'missing_column=1')",
    )
    .bind(store::id())
    .bind(&did)
    .bind(&r1)
    .execute(&f.pool)
    .await
    .unwrap();
    let (s, e) = request_as(&a, &token, "POST", "/v1/sql", query).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    let (_, m) = request_as(&a, &token, "GET", "/v1/datamap", json!(null)).await;
    assert_eq!(m["nodes"], json!([]));
    assert!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='policy.invalid' AND principal_id=?"
        )
        .bind(&uid)
        .fetch_one(&f.pool)
        .await
        .unwrap()
            >= 1
    );
    assert!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='sql.query' AND principal_id=?"
        )
        .bind(&uid)
        .fetch_one(&f.pool)
        .await
        .unwrap()
            > 0
    );
    f.close().await;
}
#[tokio::test]
async fn access_validation_is_deterministic_local_scalar_only() {
    let f = sql_fixture().await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    for predicate in [
        "id > 0 AND name IS NOT NULL",
        "id IN (1,2)",
        "id BETWEEN 1 AND 2",
        "lower(name) LIKE 'a%'",
        "CAST(id AS VARCHAR) = '1'",
        "(id+2)*3>=0",
    ] {
        let (_, v) = request(
            &a,
            "POST",
            "/v1/policies/validate",
            json!({"dataset_id":did,"predicate":predicate}),
        )
        .await;
        assert_eq!(v["ok"], true, "{predicate}: {v}");
    }
    for predicate in [
        "id IN (SELECT 1)",
        "EXISTS (SELECT 1)",
        "id=(SELECT 1)",
        "sum(id)>0",
        "row_number() OVER ()>0",
        "random()>0",
        "now() IS NOT NULL",
        "other.id=1",
        "id=1; SELECT 2",
        "id",
    ] {
        let (_, v) = request(
            &a,
            "POST",
            "/v1/policies/validate",
            json!({"dataset_id":did,"predicate":predicate}),
        )
        .await;
        assert_eq!(v["ok"], false, "{predicate}: {v}");
        assert_eq!(
            request(
                &a,
                "PUT",
                &format!("/v1/datasets/{did}/row-filters/admin"),
                json!({"predicate":predicate})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    f.close().await;
}

#[tokio::test]
async fn access_pgwire_identity_and_policies_match_rest_and_revoke_live_sessions() {
    use sqlx::{
        Connection, Executor, PgConnection,
        postgres::{PgConnectOptions, PgSslMode},
    };
    let mut f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    let role = access_role(&a, "wire reader").await;
    access_grant(&a, &role, "dataset", &did, "read").await;
    let (uid, token) = access_user(&a, "wire-user", &[&role]).await;
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/row-filters/{role}"),
            json!({"predicate":"id=2"})
        )
        .await
        .0,
        StatusCode::OK
    );
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/masks/{role}/name"),
        json!({"kind":"redact"}),
    )
    .await;
    f.config.sql.bind = "127.0.0.1:0".parse().unwrap();
    let mut server = crate::sql::wire::Server::start(
        crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
        Arc::new("good-token".to_owned().into()),
        &f.config,
    )
    .await
    .unwrap();
    let options = PgConnectOptions::new()
        .host("127.0.0.1")
        .port(server.address.unwrap().port())
        .username("wire-user")
        .database("straton")
        .password(&token)
        .ssl_mode(PgSslMode::Disable);
    assert!(
        PgConnection::connect_with(&options.clone().username("admin"))
            .await
            .is_err()
    );
    assert!(
        PgConnection::connect_with(&options.clone().password("good-token"))
            .await
            .is_err()
    );
    let mut conn = PgConnection::connect_with(&options).await.unwrap();
    let rows = conn
        .fetch_all("SELECT id,name FROM app_db.users ORDER BY id")
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<i64, _>(0), 2);
    assert_eq!(rows[0].get::<String, _>(1), "***");
    let row = sqlx::query("SELECT name FROM app_db.users WHERE id=$1")
        .bind(2_i64)
        .fetch_one(&mut conn)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>(0), "***");
    assert!(
        conn.fetch_all("SELECT * FROM local_lake.app_db_users")
            .await
            .is_err()
    );
    assert!(
        conn.fetch_all("SELECT * FROM information_schema.tables")
            .await
            .is_err()
    );
    let (_, rest) = request_as(
        &a,
        &token,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"}),
    )
    .await;
    assert_eq!(rest["rows"], json!([[2, "***"]]));
    let (_, tokens) = request(&a, "GET", &format!("/v1/users/{uid}/tokens"), json!(null)).await;
    let tid = tokens[0]["id"].as_str().unwrap();
    request(
        &a,
        "DELETE",
        &format!("/v1/users/{uid}/tokens/{tid}"),
        json!(null),
    )
    .await;
    assert!(conn.fetch_one("SELECT id FROM app_db.users").await.is_err());
    assert!(PgConnection::connect_with(&options).await.is_err());
    conn.close().await.unwrap();
    server.shutdown().await;
    f.close().await;
}

#[tokio::test]
async fn access_target_admin_and_policy_cascades() {
    let f = sql_fixture().await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    sqlx::query("INSERT INTO sources(id,name,kind) VALUES('private','Private','external')")
        .execute(&f.pool)
        .await
        .unwrap();
    let r = access_role(&a, "source admin").await;
    access_grant(&a, &r, "source", "source", "admin").await;
    let (_, token) = access_user(&a, "source owner", &[&r]).await;
    assert_eq!(
        request_as(&a, &token, "GET", "/v1/sources/source", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request_as(&a, &token, "GET", "/v1/sources/private", json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request_as(
            &a,
            &token,
            "POST",
            "/v1/sources",
            json!({"name":"Denied","kind":"external"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/roles", json!({"name":"Denied"}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/jobs/job/run", json!(null))
            .await
            .0,
        StatusCode::ACCEPTED
    );
    let (s, v) = request_as(
        &a,
        &token,
        "PUT",
        &format!("/v1/datasets/{did}/row-filters/{r}"),
        json!({"predicate":"id=1"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        request_as(
            &a,
            &token,
            "PUT",
            &format!("/v1/datasets/{did}/masks/{r}/name"),
            json!({"kind":"hash"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (s, map) = request_as(&a, &token, "GET", "/v1/datamap", json!(null)).await;
    assert_eq!(s, StatusCode::OK, "{map}");
    let d = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == did)
        .unwrap();
    assert_eq!(d["row_filtered"], true);
    assert!(d["row_count"].is_null());
    assert!(
        d["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "name" && c["masked"] == true)
    );
    let (_, preview) = request(&a, "GET", "/v1/datamap?as_role=admin", json!(null)).await;
    let d = preview["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == did)
        .unwrap();
    assert_eq!(d["row_filtered"], false);
    assert!(
        d["columns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["masked"] == false)
    );
    let id = "temporary-dataset";
    sqlx::query("INSERT INTO datasets(id,source_id,name) VALUES(?,'source','temporary')")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO columns(id,dataset_id,name,data_type,nullable) VALUES(?,?,'value','Int64',1)",
    )
    .bind(store::id())
    .bind(id)
    .execute(&f.pool)
    .await
    .unwrap();
    access_grant(&a, &r, "dataset", id, "read").await;
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{id}/row-filters/{r}"),
        json!({"predicate":"value>0"}),
    )
    .await;
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{id}/masks/{r}/value"),
        json!({"kind":"null"}),
    )
    .await;
    sqlx::query("DELETE FROM columns WHERE dataset_id=?")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM datasets WHERE id=?")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    for query in [
        "SELECT count(*) FROM row_filters WHERE dataset_id=?",
        "SELECT count(*) FROM column_masks WHERE dataset_id=?",
        "SELECT count(*) FROM grants WHERE target_kind='dataset' AND target_id=?",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(query)
                .bind(id)
                .fetch_one(&f.pool)
                .await
                .unwrap(),
            0
        );
    }
    f.close().await;
}

#[tokio::test]
async fn access_mask_type_changes_and_schema_drift_revalidation() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    let r1 = access_role(&a, "mask one").await;
    let r2 = access_role(&a, "mask two").await;
    for r in [&r1, &r2] {
        access_grant(&a, r, "dataset", &did, "read").await;
    }
    let (uid, token) = access_user(&a, "masked", &[&r1, &r2]).await;
    for (first, second, expected) in [
        ("null", "redact", json!(null)),
        ("redact", "hash", json!("***")),
        ("hash", "last4", json!(masked_hash(&f.pool, "1").await)),
    ] {
        for (r, kind) in [(&r1, first), (&r2, second)] {
            request(
                &a,
                "PUT",
                &format!("/v1/datasets/{did}/masks/{r}/id"),
                json!({"kind":kind}),
            )
            .await;
        }
        let (s, v) = request_as(
            &a,
            &token,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT id FROM app_db.users ORDER BY name"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["rows"][0][0], expected);
        assert_eq!(
            v["columns"][0]["type"],
            if first == "null" { "Int64" } else { "Utf8" }
        );
        let (_, tables) = request_as(&a, &token, "GET", "/v1/sql/tables", json!(null)).await;
        let column = &tables["tables"][0]["columns"][0];
        assert_eq!(column["type"], v["columns"][0]["type"]);
    }
    request(
        &a,
        "PUT",
        &format!("/v1/users/{uid}/roles"),
        json!({"role_ids":[r1]}),
    )
    .await;
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/row-filters/{r1}"),
            json!({"predicate":"name='Alice'"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let input =
        sqlx::SqlitePool::connect(&format!("sqlite:{}", f.dir.join("sql-input.db").display()))
            .await
            .unwrap();
    sqlx::query("ALTER TABLE users DROP COLUMN name")
        .execute(&input)
        .await
        .unwrap();
    input.close().await;
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    sql_sync(&f).await;
    let (s, _) = request_as(
        &a,
        &token,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM app_db.users"}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='policy.invalid' AND principal_id=?"
        )
        .bind(&uid)
        .fetch_one(&f.pool)
        .await
        .unwrap()
            > 0
    );
    f.close().await;
}

#[tokio::test]
async fn access_manual_run_audit_keeps_user_through_worker() {
    let f = Fixture::new().await;
    let a = app(&f);
    let (s, r) = request(&a, "POST", "/v1/jobs/job/run", json!(null)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let id = r["id"].as_str().unwrap();
    let mut runner = runner::Runner::new(
        f.pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        1,
    );
    runner.dispatch().await.unwrap();
    runner.drain().await;
    assert_eq!(f.state(id).await, "succeeded");
    let actors: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT principal_id FROM audit_log WHERE entity_id=? AND action LIKE 'run.%'",
    )
    .bind(id)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    assert!(actors.len() >= 3);
    assert!(actors.iter().all(|p| p.as_deref() == Some("admin")));
    drop(runner);
    f.close().await;
}

#[tokio::test]
async fn access_admin_role_policies_are_enforced_and_fail_closed() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/row-filters/admin"),
            json!({"predicate":"id=1"})
        )
        .await
        .0,
        StatusCode::OK
    );
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/masks/admin/name"),
        json!({"kind":"redact"}),
    )
    .await;
    let (s, v) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[1, "***"]]));
    sqlx::query("UPDATE row_filters SET predicate='missing_column=1' WHERE dataset_id=? AND role_id='admin'").bind(&did).execute(&f.pool).await.unwrap();
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT * FROM app_db.users"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, map) = request(&a, "GET", "/v1/datamap", json!(null)).await;
    assert!(
        !map["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == did)
    );
    assert!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='policy.invalid' AND principal_id='admin'"
        )
        .fetch_one(&f.pool)
        .await
        .unwrap()
            > 0
    );
    assert_eq!(
        request(
            &a,
            "DELETE",
            &format!("/v1/datasets/{did}/row-filters/admin"),
            json!(null)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT * FROM app_db.users"})
        )
        .await
        .0,
        StatusCode::OK
    );
    f.close().await;
}

async fn incremental_fixture() -> (Fixture, SqlitePool) {
    let f = sql_fixture().await;
    let input = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(f.dir.join("sql-input.db")),
        )
        .await
        .unwrap();
    sqlx::raw_sql("ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0; UPDATE users SET updated_at=id;").execute(&input).await.unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    sqlx::query("UPDATE jobs SET mode='incremental',watermark_column='updated_at'")
        .execute(&f.pool)
        .await
        .unwrap();
    (f, input)
}
async fn job_watermark(f: &Fixture) -> serde_json::Value {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT watermark FROM job_state WHERE job_id='job'")
            .fetch_one(&f.pool)
            .await
            .unwrap();
    raw.map(|s| serde_json::from_str(&s).unwrap())
        .unwrap_or(json!(null))
}
async fn synced_rows(f: &Fixture) -> serde_json::Value {
    let (status, v) = request(
        &app(f),
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name,updated_at FROM app_db.users ORDER BY id"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    v["rows"].clone()
}
#[tokio::test]
async fn incremental_seed_merge_boundary_resume_and_failed_publish() {
    let (mut f, input) = incremental_fixture().await;
    let first = sql_sync(&f).await;
    assert_eq!(job_watermark(&f).await, json!("2"));
    let row = sqlx::query("SELECT * FROM runs WHERE id=?")
        .bind(&first)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("mode_used"), "full");
    assert_eq!(row.get::<i64, _>("rows_read"), 2);
    sqlx::raw_sql("UPDATE users SET name='Bobby',updated_at=4 WHERE id=2; INSERT INTO users VALUES(3,'Carol',3),(4,'Dora',5);").execute(&input).await.unwrap();
    let second = sql_sync(&f).await;
    let row = sqlx::query("SELECT * FROM runs WHERE id=?")
        .bind(&second)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("mode_used"), "incremental");
    assert_eq!(
        (
            row.get::<i64, _>("rows_inserted"),
            row.get::<i64, _>("rows_updated"),
            row.get::<i64, _>("rows_read")
        ),
        (2, 1, 3)
    );
    let expected = json!([
        [1, "Alice", 1],
        [2, "Bobby", 4],
        [3, "Carol", 3],
        [4, "Dora", 5]
    ]);
    assert_eq!(synced_rows(&f).await, expected);
    assert_eq!(job_watermark(&f).await, json!("5"));
    sqlx::query("INSERT INTO users VALUES(5,'Eve',5)")
        .execute(&input)
        .await
        .unwrap();
    sql_sync(&f).await;
    let tied = synced_rows(&f).await;
    assert_eq!(tied.as_array().unwrap().len(), 5);
    sql_sync(&f).await;
    assert_eq!(synced_rows(&f).await, tied);
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    let role = access_role(&a, "incremental reader").await;
    access_grant(&a, &role, "dataset", &did, "read").await;
    let (_, token) = access_user(&a, "incremental analyst", &[&role]).await;
    let (status, v) = request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/row-filters/{role}"),
        json!({"predicate":"id >= 3"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let (status, v) = request_as(
        &a,
        &token,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[3, "Carol"], [4, "Dora"], [5, "Eve"]]));
    drop(a);
    sqlx::query("INSERT INTO users VALUES(6,'Frank',6)")
        .execute(&input)
        .await
        .unwrap();
    let resumed = f.enqueue().await;
    runner::state(&f.pool, &f.events, &resumed, "running", None)
        .await
        .unwrap();
    let output = f.dir.join("data/source/users");
    runner::incremental::prepare(&f.pool, &output, &resumed, f.config.encryption.enabled)
        .await
        .unwrap();
    assert!(
        output
            .join(format!(".staging-{resumed}/delta/part-000000.parquet"))
            .is_file()
    );
    assert_eq!(job_watermark(&f).await, json!("5"));
    // Arrives after delta completion: recovery must use staged rows, not reread the source.
    sqlx::query("INSERT INTO users VALUES(7,'Grace',7)")
        .execute(&input)
        .await
        .unwrap();
    f.pool.close().await;
    f.pool = store::open(&f.dir).await.unwrap();
    runner::recover(&f.pool, &f.events, 3).await.unwrap();
    runner::state(&f.pool, &f.events, &resumed, "running", None)
        .await
        .unwrap();
    let backups = backup::Backups::new(f.config.clone());
    runner::execute(&f.pool, &backups, &resumed, &f.events)
        .await
        .unwrap();
    assert_eq!(job_watermark(&f).await, json!("6"));
    assert_eq!(synced_rows(&f).await.as_array().unwrap().len(), 6);
    runner::execute(&f.pool, &backups, &resumed, &f.events)
        .await
        .unwrap();
    assert_eq!(job_watermark(&f).await, json!("6"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM audit_log WHERE action='run.succeeded' AND entity_id=?"
        )
        .bind(&resumed)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        1
    );
    sql_sync(&f).await;
    assert_eq!(job_watermark(&f).await, json!("7"));
    let (_, job) = request(&app(&f), "GET", "/v1/jobs/job", json!(null)).await;
    assert_eq!(job["watermark"], json!("7"));
    sqlx::query("INSERT INTO users VALUES(8,'Hank',8)")
        .execute(&input)
        .await
        .unwrap();
    let failed = f.enqueue().await;
    runner::state(&f.pool, &f.events, &failed, "running", None)
        .await
        .unwrap();
    let before = std::fs::read_to_string(output.join("_current")).unwrap();
    std::fs::create_dir(output.join("_current.partial")).unwrap();
    assert!(
        runner::execute(&f.pool, &backups, &failed, &f.events)
            .await
            .is_err()
    );
    runner::state(
        &f.pool,
        &f.events,
        &failed,
        "failed",
        Some("publish blocked"),
    )
    .await
    .unwrap();
    assert_eq!(job_watermark(&f).await, json!("7"));
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        before
    );
    assert_eq!(synced_rows(&f).await.as_array().unwrap().len(), 7);
    input.close().await;
    f.close().await;
}
#[tokio::test]
async fn incremental_key_diff_empty_delta_and_drift_fallback() {
    let (f, input) = incremental_fixture().await;
    sqlx::query("UPDATE jobs SET delete_detection='key_diff',key_diff_every_runs=2")
        .execute(&f.pool)
        .await
        .unwrap();
    sql_sync(&f).await;
    sqlx::query("DELETE FROM users WHERE id=1")
        .execute(&input)
        .await
        .unwrap();
    let run = sql_sync(&f).await;
    assert_eq!(synced_rows(&f).await, json!([[2, "Bob", 2]]));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT rows_deleted FROM runs WHERE id=?")
            .bind(run)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("DELETE FROM users")
        .execute(&input)
        .await
        .unwrap();
    sql_sync(&f).await;
    assert_eq!(synced_rows(&f).await, json!([[2, "Bob", 2]])); // third run: no key diff
    let empty = sql_sync(&f).await;
    assert_eq!(synced_rows(&f).await, json!([]));
    assert_eq!(job_watermark(&f).await, json!("2"));
    let row = sqlx::query("SELECT rows_deleted,rows_read FROM runs WHERE id=?")
        .bind(empty)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        (
            row.get::<i64, _>("rows_deleted"),
            row.get::<i64, _>("rows_read")
        ),
        (1, 0)
    );
    sqlx::raw_sql("ALTER TABLE users ADD COLUMN extra TEXT; INSERT INTO users VALUES(1,'New Alice',1,'new schema');").execute(&input).await.unwrap();
    let drift = sql_sync(&f).await;
    assert_eq!(job_watermark(&f).await, json!("1")); // full fallback re-seeds even to a lower value
    let row = sqlx::query("SELECT mode_used,fallback_reason FROM runs WHERE id=?")
        .bind(&drift)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("mode_used"), "full");
    assert!(
        row.get::<String, _>("fallback_reason")
            .contains("column names or types")
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM audit_log WHERE action='sync.fallback' AND entity_id=?"
        )
        .bind(&drift)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        1
    );
    let (s, v) = request(
        &app(&f),
        "POST",
        "/v1/sql",
        json!({"query":"SELECT extra FROM app_db.users"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([["new schema"]]));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM columns c JOIN datasets d ON d.id=c.dataset_id WHERE d.source_id='straton-local-lake' AND c.name='extra'").fetch_one(&f.pool).await.unwrap(),1);
    input.close().await;
    f.close().await;
}
#[tokio::test]
async fn incremental_api_validation_and_target_privileges() {
    let (f, input) = incremental_fixture().await;
    let a = app(&f);
    let valid = json!({"name":"Incremental","source_id":"source","dataset":"users","cron":null,"enabled":true,"mode":"incremental","watermark_column":"updated_at"});
    for (field, value, message) in [
        ("watermark_column", json!(null), "required"),
        ("watermark_column", json!("missing"), "exist"),
        (
            "watermark_column",
            json!("name"),
            "integer, date, timestamp or rowversion",
        ),
        ("key_columns", json!([]), "requires"),
        ("key_columns", json!(["missing"]), "exist"),
        ("key_columns", json!(["id", "id"]), "duplicates"),
        ("mode", json!("other"), "mode"),
        ("delete_detection", json!("other"), "delete_detection"),
    ] {
        let mut body = valid.clone();
        body[field] = value;
        let (s, v) = request(&a, "POST", "/v1/jobs", body).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
        assert!(v["error"].as_str().unwrap().contains(message), "{v}");
    }
    let (s, v) = request(&a, "POST", "/v1/jobs", valid.clone()).await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    assert_eq!(v["watermark"], json!(null));
    let (_, map) = request(&a, "GET", "/v1/datamap", json!(null)).await;
    let did = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["type"] == "dataset" && d["name"] == "users")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    sqlx::query("UPDATE columns SET primary_key=0 WHERE dataset_id=?")
        .bind(did)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request(&a, "POST", "/v1/jobs", valid.clone()).await.0,
        StatusCode::BAD_REQUEST
    );
    let mut override_key = valid.clone();
    override_key["key_columns"] = json!(["id"]);
    assert_eq!(
        request(&a, "POST", "/v1/jobs", override_key.clone())
            .await
            .0,
        StatusCode::CREATED
    );
    let role = access_role(&a, "sync limited").await;
    access_grant(&a, &role, "dataset", did, "sync_admin").await;
    let (_, token) = access_user(&a, "sync operator", &[&role]).await;
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/jobs", override_key.clone())
            .await
            .0,
        StatusCode::CREATED
    );
    let mut other = override_key.clone();
    other["dataset"] = json!("unpublished");
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/jobs", other).await.0,
        StatusCode::FORBIDDEN
    );
    let mut readonly = override_key;
    readonly["watermark"] = json!(100);
    assert!(
        request(&a, "POST", "/v1/jobs", readonly)
            .await
            .0
            .is_client_error()
    );
    sqlx::query("UPDATE sources SET kind='csv' WHERE id='source'")
        .execute(&f.pool)
        .await
        .unwrap();
    let (s, v) = request(&a, "POST", "/v1/jobs", valid).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    assert!(v["error"].as_str().unwrap().contains("CSV"));
    input.close().await;
    f.close().await;
}

#[tokio::test]
async fn incremental_timestamp_round_trip_and_partial_delta_resume() {
    let (f, input) = incremental_fixture().await;
    sqlx::raw_sql("ALTER TABLE users ADD COLUMN changed_at TIMESTAMP; UPDATE users SET changed_at='2026-10-20 12:00:00.123456';").execute(&input).await.unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    sqlx::query("UPDATE jobs SET watermark_column='changed_at'")
        .execute(&f.pool)
        .await
        .unwrap();
    sql_sync(&f).await;
    assert_eq!(job_watermark(&f).await, json!("2026-10-20 12:00:00.123456"));
    sqlx::query("INSERT INTO users VALUES(3,'Carol',3,'2026-10-20 12:00:00.123456')")
        .execute(&input)
        .await
        .unwrap();
    let run = f.enqueue().await;
    runner::state(&f.pool, &f.events, &run, "running", None)
        .await
        .unwrap();
    let output = f.dir.join("data/source/users");
    runner::incremental::prepare(&f.pool, &output, &run, f.config.encryption.enabled)
        .await
        .unwrap();
    let staging = output.join(format!(".staging-{run}"));
    // Model a crash after only the first delta part's checkpoint; later parts are orphans.
    let raw: String = sqlx::query_scalar("SELECT cursor FROM run_checkpoints WHERE run_id=?")
        .bind(&run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let _: serde_json::Value = serde_json::from_str(&raw).unwrap();
    sqlx::query("UPDATE runs SET committed_batches=1 WHERE id=?")
        .bind(&run)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE run_checkpoints SET batch_number=1,cursor=? WHERE run_id=?")
        .bind(
            json!({"source_cursor":["2026-10-20 12:00:00.123456","1"],"delta_complete":false})
                .to_string(),
        )
        .bind(&run)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(staging.join("delta/part-000002.parquet").exists());
    runner::execute(
        &f.pool,
        &backup::Backups::new(f.config.clone()),
        &run,
        &f.events,
    )
    .await
    .unwrap();
    assert_eq!(synced_rows(&f).await.as_array().unwrap().len(), 3);
    assert_eq!(job_watermark(&f).await, json!("2026-10-20 12:00:00.123456"));
    let row = sqlx::query("SELECT rows_inserted,rows_updated,rows_read FROM runs WHERE id=?")
        .bind(&run)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        (
            row.get::<i64, _>("rows_inserted"),
            row.get::<i64, _>("rows_updated"),
            row.get::<i64, _>("rows_read")
        ),
        (1, 2, 3)
    );
    input.close().await;
    f.close().await;
}
#[tokio::test]
async fn incremental_settings_reset_state_and_serialize_same_target() {
    let (f, input) = incremental_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let body = json!({"name":"Test","source_id":"source","dataset":"users","cron":null,"enabled":false,"mode":"incremental","watermark_column":"updated_at","key_columns":null,"delete_detection":"none","key_diff_every_runs":0});
    assert_eq!(
        request(&a, "PUT", "/v1/jobs/job", body.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(job_watermark(&f).await, json!("2"));
    let active = f.enqueue().await;
    runner::state(&f.pool, &f.events, &active, "running", None)
        .await
        .unwrap();
    let mut changed = body.clone();
    changed["key_columns"] = json!(["id"]);
    assert_eq!(
        request(&a, "PUT", "/v1/jobs/job", changed.clone()).await.0,
        StatusCode::CONFLICT
    );
    let (s, other) = request(&a, "POST", "/v1/jobs", body).await;
    assert_eq!(s, StatusCode::CREATED, "{other}");
    let mut tx = f.pool.begin().await.unwrap();
    let queued = store::enqueue(&mut tx, other["id"].as_str().unwrap(), store::now())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut worker = runner::Runner::new(
        f.pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        2,
    );
    worker.dispatch().await.unwrap();
    worker.drain().await;
    assert_eq!(f.state(&queued).await, "queued"); // another job on the same target cannot merge concurrently
    runner::state(&f.pool, &f.events, &active, "cancelled", None)
        .await
        .unwrap();
    runner::state(&f.pool, &f.events, &queued, "cancelled", None)
        .await
        .unwrap();
    assert_eq!(
        request(&a, "PUT", "/v1/jobs/job", changed).await.0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM job_state WHERE job_id='job'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    input.close().await;
    f.close().await;
}

/// Fake Stripe API: one page of customers plus a mutable event log.
#[derive(Clone, Default)]
struct FakeStripe {
    customers: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    events: std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
}
async fn fake_stripe(state: FakeStripe) -> String {
    use axum::{Json, extract::Query, routing::get};
    use std::collections::HashMap;
    let customers = state.customers.clone();
    let events = state.events.clone();
    let app = axum::Router::new()
        .route(
            "/v1/customers",
            get(move || {
                let c = customers.lock().unwrap().clone();
                async move { Json(json!({"data": c, "has_more": false})) }
            }),
        )
        .route(
            "/v1/events",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let gte: i64 = q["created[gte]"].parse().unwrap();
                let mut e: Vec<_> = events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e["created"].as_i64().unwrap() >= gte)
                    .cloned()
                    .collect();
                e.reverse(); // newest first, as Stripe returns them
                async move { Json(json!({"data": e, "has_more": false})) }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}/")
}
fn stripe_customer(id: &str, email: &str) -> serde_json::Value {
    json!({"id": id, "object": "customer", "created": 1_700_000_000, "email": email, "livemode": false})
}
fn stripe_event(n: i64, kind: &str, object: serde_json::Value) -> serde_json::Value {
    json!({"id": format!("evt_{n}"), "type": kind, "created": chrono::Utc::now().timestamp() + n, "data": {"object": object}})
}
#[tokio::test]
async fn stripe_events_merge_deletes_fallback_and_validation() {
    let fake = FakeStripe::default();
    *fake.customers.lock().unwrap() = vec![
        stripe_customer("cus_1", "a@x.io"),
        stripe_customer("cus_2", "b@x.io"),
    ];
    let base = fake_stripe(fake.clone()).await;
    let f = Fixture::new().await;
    crate::credentials::set("source", &"rk_test".to_owned().into()).unwrap();
    sqlx::query("UPDATE sources SET name='Pay',kind='stripe',credential_id='source',config=? WHERE id='source'")
        .bind(json!({"api_base": base, "objects": ["customers"], "rate_limit_rps": 1000}).to_string())
        .execute(&f.pool)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    let a = app(&f);
    let job = |extra: serde_json::Value| {
        let mut j = json!({"id":"job","name":"Stripe customers","source_id":"source","dataset":"customers","cron":null,"enabled":true,"mode":"incremental","watermark_column":null,"key_columns":null,"delete_detection":"none","key_diff_every_runs":0});
        j.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        j
    };
    let (s, v) = request(
        &a,
        "PUT",
        "/v1/jobs/job",
        job(json!({"watermark_column":"created"})),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, v) = request(
        &a,
        "PUT",
        "/v1/jobs/job",
        job(json!({"delete_detection":"key_diff","key_diff_every_runs":2})),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, v) = request(&a, "PUT", "/v1/jobs/job", job(json!({}))).await;
    assert_eq!(s, StatusCode::OK, "{v}");

    // Run 1: full load seeds a start-time watermark.
    let first = sql_sync(&f).await;
    let seeded = job_watermark(&f).await.as_i64().unwrap();
    assert!(seeded > chrono::Utc::now().timestamp() - 300);
    let rows = |a: axum::Router| async move {
        let (s, v) = request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT * FROM pay.customers ORDER BY id"}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    };
    let v = rows(a.clone()).await;
    assert_eq!(v["row_count"], 2);
    assert!(
        v["columns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| !c["name"].as_str().unwrap().starts_with("_straton_"))
    );
    let mode: String = sqlx::query_scalar("SELECT mode_used FROM runs WHERE id=?")
        .bind(&first)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(mode, "full");

    // Run 2: update cus_1, delete cus_2, create then update cus_3 (newest event wins).
    *fake.events.lock().unwrap() = vec![
        stripe_event(1, "customer.updated", stripe_customer("cus_1", "a2@x.io")),
        stripe_event(
            2,
            "customer.deleted",
            json!({"id":"cus_2","object":"customer","deleted":true}),
        ),
        stripe_event(3, "customer.created", stripe_customer("cus_3", "c@x.io")),
        stripe_event(4, "customer.updated", stripe_customer("cus_3", "c2@x.io")),
    ];
    let second = sql_sync(&f).await;
    let r = sqlx::query(
        "SELECT mode_used,rows_inserted,rows_updated,rows_deleted FROM runs WHERE id=?",
    )
    .bind(&second)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            r.get::<String, _>("mode_used"),
            r.get::<i64, _>("rows_inserted"),
            r.get::<i64, _>("rows_updated"),
            r.get::<i64, _>("rows_deleted")
        ),
        ("incremental".into(), 1, 1, 1)
    );
    let (s, v) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,email FROM pay.customers ORDER BY id"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        v["rows"],
        json!([["cus_1", "a2@x.io"], ["cus_3", "c2@x.io"]])
    );
    let advanced = job_watermark(&f).await.as_i64().unwrap();
    assert!(advanced > seeded, "watermark moves to the newest event");

    // Run 3: a watermark past Stripe's 30-day event retention forces a full refresh.
    sqlx::query("UPDATE job_state SET watermark=?")
        .bind((chrono::Utc::now().timestamp() - 40 * 86_400).to_string())
        .execute(&f.pool)
        .await
        .unwrap();
    let third = sql_sync(&f).await;
    let r = sqlx::query("SELECT mode_used,fallback_reason FROM runs WHERE id=?")
        .bind(&third)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(r.get::<String, _>("mode_used"), "full");
    assert!(r.get::<String, _>("fallback_reason").contains("retention"));
    f.close().await;
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
async fn execute_model(f: &Fixture, a: &axum::Router, model: &str) -> String {
    let (s, r) = request(a, "POST", &format!("/v1/models/{model}/run"), json!(null)).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{r}");
    let id = r["id"].as_str().unwrap();
    runner::state(&f.pool, &f.events, id, "running", None)
        .await
        .unwrap();
    runner::execute(
        &f.pool,
        &backup::Backups::new(f.config.clone()),
        id,
        &f.events,
    )
    .await
    .unwrap();
    assert_eq!(f.state(id).await, "succeeded");
    id.into()
}
#[tokio::test]
async fn models_materialize_validate_lineage_and_recover() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    for query in [
        "SELECT * FROM missing",
        "CREATE TABLE x(id INT)",
        "SELECT 1; SELECT 2",
        "SELECT 1 INTO forbidden",
    ] {
        let (s, e) = request(
            &a,
            "POST",
            "/v1/models",
            model_input("bad", query, "table", "manual"),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{query}: {e}");
    }
    let id = create_model(
        &a,
        "m",
        "SELECT id,name FROM app_db.users",
        "table",
        "manual",
    )
    .await;
    let run = execute_model(&f, &a, &id).await;
    let (s, out) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM models.m ORDER BY id"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{out}");
    assert_eq!(out["rows"], json!([[1, "Alice"], [2, "Bob"]]));
    let (_, m) = request(&a, "GET", &format!("/v1/models/{id}"), json!(null)).await;
    assert_eq!(m["row_count"], 2);
    assert_eq!(m["last_run_status"], "succeeded");
    let (_, l) = request(&a, "GET", &format!("/v1/models/{id}/lineage"), json!(null)).await;
    assert_eq!(l["upstream"].as_array().unwrap().len(), 1);
    let (_, map) = request(&a, "GET", "/v1/datamap", json!(null)).await;
    assert!(
        map["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["type"] == "dataset"
                && n["source_id"] == "straton-models"
                && n["sql_schema"] == "models")
    );
    assert!(map["edges"].as_array().unwrap().iter().any(|e| {
        e["kind"] == "lineage"
            && e["to_dataset"]
                == map["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|n| n["type"] == "dataset" && n["name"] == "m")
                    .unwrap()["id"]
    }));
    // Re-execute disposable staging after a crash; preserve a completed publication too.
    sqlx::query("UPDATE runs SET state='running' WHERE id=?")
        .bind(&run)
        .execute(&f.pool)
        .await
        .unwrap();
    runner::recover(&f.pool, &f.events, 3).await.unwrap();
    assert_eq!(f.state(&run).await, "queued");
    sqlx::query("UPDATE runs SET available_at=0 WHERE id=?")
        .bind(&run)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut worker = runner::Runner::new(
        f.pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        1,
    );
    worker.dispatch().await.unwrap();
    worker.drain().await;
    assert_eq!(f.state(&run).await, "succeeded");
    let (s, r) = request(&a, "POST", &format!("/v1/models/{id}/run"), json!(null)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let fresh = r["id"].as_str().unwrap();
    let staging = f
        .dir
        .join("data/straton-models/m")
        .join(format!(".staging-{fresh}"));
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(staging.join("part-999999.parquet"), b"interrupted garbage").unwrap();
    runner::state(&f.pool, &f.events, fresh, "running", None)
        .await
        .unwrap();
    runner::recover(&f.pool, &f.events, 3).await.unwrap();
    sqlx::query("UPDATE runs SET available_at=0 WHERE id=?")
        .bind(fresh)
        .execute(&f.pool)
        .await
        .unwrap();
    worker.dispatch().await.unwrap();
    worker.drain().await;
    assert_eq!(f.state(fresh).await, "succeeded");
    let (_, out) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM models.m"}),
    )
    .await;
    assert_eq!(out["row_count"], 2);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_log WHERE action='model.created' AND principal_id='admin'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);
    drop(worker);
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn models_cycles_downstream_and_inlined_optimizer() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let v = create_model(
        &a,
        "v",
        "SELECT id + 1 AS y FROM app_db.users",
        "view",
        "manual",
    )
    .await;
    let m = create_model(
        &a,
        "m",
        "SELECT y - 1 AS x FROM models.v",
        "table",
        "manual",
    )
    .await;
    let (s, plans) = request(&a, "GET", &format!("/v1/models/{m}/explain"), json!(null)).await;
    assert_eq!(s, StatusCode::OK, "{plans}");
    assert!(
        !plans["rules_fired"].as_array().unwrap().is_empty(),
        "{plans}"
    );
    assert!(
        plans["rules_fired"][0]["after"]
            .as_str()
            .unwrap()
            .ends_with(".id"),
        "{plans}"
    );
    assert!(
        !plans["logical_after"].as_str().unwrap().contains(" + "),
        "{plans}"
    );
    let (s, query_plan) = request(
        &a,
        "POST",
        "/v1/sql/explain",
        json!({"query":"SELECT y - 1 AS x FROM models.v"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{query_plan}");
    assert!(
        !query_plan["logical"].as_str().unwrap().contains(" + "),
        "{query_plan}"
    );
    execute_model(&f, &a, &m).await;
    let (_, out) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT x FROM models.m ORDER BY x"}),
    )
    .await;
    assert_eq!(out["rows"], json!([[1], [2]]));
    assert_eq!(out["columns"][0]["type"], "Int64");
    let (s, e) = request(
        &a,
        "PUT",
        &format!("/v1/models/{v}"),
        model_input("v", "SELECT x AS y FROM models.m", "view", "manual"),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    assert!(e["error"].as_str().unwrap().contains("v → m → v"), "{e}");
    let mut disabled = model_input("m", "SELECT y - 1 AS x FROM models.v", "table", "manual");
    disabled["optimize"] = json!(false);
    assert_eq!(
        request(&a, "PUT", &format!("/v1/models/{m}"), disabled)
            .await
            .0,
        StatusCode::OK
    );
    let (_, plans) = request(&a, "GET", &format!("/v1/models/{m}/explain"), json!(null)).await;
    assert_eq!(plans["rules_fired"], json!([]));
    let (s, e) = request(
        &a,
        "PUT",
        &format!("/v1/models/{v}"),
        model_input(
            "v",
            "SELECT name AS renamed FROM app_db.users",
            "view",
            "manual",
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{e}");
    let (_, broken) = request(&a, "GET", &format!("/v1/models/{m}"), json!(null)).await;
    assert_eq!(broken["status"], "broken");
    assert!(broken["error"].as_str().is_some());
    request(
        &a,
        "PUT",
        &format!("/v1/models/{v}"),
        model_input(
            "v",
            "SELECT id + 1 AS y FROM app_db.users",
            "view",
            "manual",
        ),
    )
    .await;
    let (_, fixed) = request(&a, "GET", &format!("/v1/models/{m}"), json!(null)).await;
    assert_eq!(fixed["status"], "ready");
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn models_owner_policies_and_querying_view_policies() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let role = access_role(&a, "owner").await;
    access_grant(&a, &role, "source", "source", "read").await;
    access_grant(&a, &role, "source", "straton-models", "read").await;
    let (_, token) = access_user(&a, "owner", &[&role]).await;
    let dataset = dataset_id(&f, "users").await;
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{dataset}/row-filters/{role}"),
            json!({"predicate":"id = 1"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{dataset}/masks/{role}/name"),
            json!({"kind":"redact"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (s, m) = request_as(
        &a,
        &token,
        "POST",
        "/v1/models",
        model_input(
            "owned",
            "SELECT id,name FROM app_db.users",
            "table",
            "manual",
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{m}");
    execute_model(&f, &a, m["id"].as_str().unwrap()).await;
    let (_, out) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM models.owned"}),
    )
    .await;
    assert_eq!(out["rows"], json!([[1, "***"]]));
    let reader = access_role(&a, "reader").await;
    access_grant(&a, &reader, "source", "source", "read").await;
    let (_, reader_token) = access_user(&a, "reader", &[&reader]).await;
    assert_ne!(
        request_as(
            &a,
            &reader_token,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT * FROM models.owned"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, unprivileged) = access_user(&a, "no_access", &[]).await;
    assert_ne!(
        request_as(
            &a,
            &unprivileged,
            "POST",
            "/v1/models",
            model_input("denied", "SELECT * FROM app_db.users", "table", "manual")
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let view = create_model(
        &a,
        "v_all",
        "SELECT id,name FROM app_db.users",
        "view",
        "manual",
    )
    .await;
    let (_, out) = request_as(
        &a,
        &token,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM models.v_all"}),
    )
    .await;
    assert_eq!(out["rows"], json!([[1, "***"]]));
    assert_eq!(
        request_as(
            &a,
            &token,
            "PUT",
            &format!("/v1/models/{view}"),
            model_input("v_all", "SELECT 1", "view", "manual")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    access_grant(&a, &reader, "source", "straton-models", "read").await;
    // A Models grant cannot widen a view reader's input access.
    let models_only = access_role(&a, "models_only").await;
    access_grant(&a, &models_only, "source", "straton-models", "read").await;
    let (_, only) = access_user(&a, "models_only", &[&models_only]).await;
    assert_ne!(
        request_as(
            &a,
            &only,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT * FROM models.v_all"})
        )
        .await
        .0,
        StatusCode::OK
    );
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn models_upstream_dedup_and_dag_wait() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let upstream = create_model(
        &a,
        "first",
        "SELECT * FROM app_db.users",
        "table",
        "upstream",
    )
    .await;
    let downstream = create_model(
        &a,
        "second",
        "SELECT * FROM models.first",
        "table",
        "upstream",
    )
    .await;
    sql_sync(&f).await;
    sql_sync(&f).await;
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.model_id=? AND r.state='queued'").bind(&upstream).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 1);
    // Queue the downstream first in time, then hold the upstream until explicitly released.
    let (_, r) = request(
        &a,
        "POST",
        &format!("/v1/models/{downstream}/run"),
        json!(null),
    )
    .await;
    let down = r["id"].as_str().unwrap();
    sqlx::query(
        "UPDATE runs SET available_at=? WHERE job_id IN(SELECT id FROM jobs WHERE model_id=?)",
    )
    .bind(store::now() + 3600)
    .bind(&upstream)
    .execute(&f.pool)
    .await
    .unwrap();
    let mut worker = runner::Runner::new(
        f.pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        2,
    );
    worker.dispatch().await.unwrap();
    assert_eq!(f.state(down).await, "queued");
    sqlx::query(
        "UPDATE runs SET available_at=0 WHERE job_id IN(SELECT id FROM jobs WHERE model_id=?)",
    )
    .bind(&upstream)
    .execute(&f.pool)
    .await
    .unwrap();
    worker.dispatch().await.unwrap();
    worker.drain().await;
    assert_eq!(f.state(down).await, "queued");
    worker.dispatch().await.unwrap();
    worker.drain().await;
    assert_eq!(f.state(down).await, "succeeded");
    drop(worker);
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn models_delete_recreate_never_reuses_old_output_and_cron_schedules() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let old = create_model(
        &a,
        "reused",
        "SELECT * FROM app_db.users",
        "table",
        "manual",
    )
    .await;
    execute_model(&f, &a, &old).await;
    assert_eq!(
        request(&a, "DELETE", &format!("/v1/models/{old}"), json!(null))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let new = create_model(
        &a,
        "reused",
        "SELECT id FROM app_db.users WHERE id=2",
        "table",
        "manual",
    )
    .await;
    let (s, _) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM models.reused"}),
    )
    .await;
    assert_ne!(
        s,
        StatusCode::OK,
        "a recreated model must not expose its predecessor's files"
    );
    execute_model(&f, &a, &new).await;
    let (_, out) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT * FROM models.reused"}),
    )
    .await;
    assert_eq!(out["rows"], json!([[2]]));
    let mut cron = model_input(
        "reused",
        "SELECT id FROM app_db.users WHERE id=2",
        "table",
        "cron",
    );
    cron["cron"] = json!("0 0 0 1 1 * 2000");
    assert_eq!(
        request(&a, "PUT", &format!("/v1/models/{new}"), cron)
            .await
            .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE jobs SET last_scheduled=0 WHERE model_id=?")
        .bind(&new)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        scheduler::tick(
            &f.pool,
            &crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
            &f.events
        )
        .await
        .unwrap()
        .len(),
        1
    );
    assert!(
        scheduler::tick(
            &f.pool,
            &crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap(),
            &f.events
        )
        .await
        .unwrap()
        .is_empty()
    );
    let view = create_model(&a, "no_run", "SELECT * FROM app_db.users", "view", "manual").await;
    assert_eq!(
        request(&a, "POST", &format!("/v1/models/{view}/run"), json!(null))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn encrypted_snapshot_rotation_legacy_and_missing_kek() {
    use crate::keys;
    use straton_connectors::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    let mut f = sql_fixture().await;
    let output = f.dir.join("data/source/users");
    f.config.encryption.enabled = false;
    let legacy = sql_sync(&f).await;
    assert!(!output.join(&legacy).join("_key").exists());
    assert!(
        ParquetRecordBatchReaderBuilder::try_new(
            std::fs::File::open(output.join(&legacy).join("part-000000.parquet")).unwrap()
        )
        .is_ok()
    );
    let query = json!({"query":"SELECT id,name FROM app_db.users ORDER BY id"});
    assert_eq!(
        request(&app(&f), "POST", "/v1/sql", query.clone()).await.1["rows"],
        json!([[1, "Alice"], [2, "Bob"]])
    );
    f.config.encryption.enabled = true;
    let first = sql_sync(&f).await;
    let snapshot = output.join(&first);
    let key_id = std::fs::read_to_string(snapshot.join("_key")).unwrap();
    for entry in std::fs::read_dir(&snapshot).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "parquet") {
            assert!(
                ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(path).unwrap())
                    .is_err()
            );
        }
    }
    let a = app(&f);
    assert_eq!(
        request(&a, "POST", "/v1/sql", query.clone()).await.1["rows"],
        json!([[1, "Alice"], [2, "Bob"]])
    );
    let (_, before) = request(&a, "GET", "/v1/admin/keys", json!(null)).await;
    assert!(!before.to_string().contains("wrapped_key"));
    let version = before[0]["kek_version"].as_i64().unwrap();
    let (status, rotated) = request(&a, "POST", "/v1/admin/keys/rotate-kek", json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{rotated}");
    assert_eq!(rotated["kek_version"], version + 1);
    assert_eq!(
        request(&a, "POST", "/v1/sql", query.clone()).await.1["rows"],
        json!([[1, "Alice"], [2, "Bob"]])
    );
    let (_, after) = request(&a, "GET", "/v1/admin/keys", json!(null)).await;
    assert_eq!(after[0]["id"], key_id);
    assert_eq!(after[0]["kek_version"], version + 1);
    let target = dataset_id(&f, "users").await;
    let (status, value) = request(
        &a,
        "POST",
        &format!("/v1/admin/keys/rotate/{target}"),
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    let retired: Option<i64> = sqlx::query_scalar("SELECT retired_at FROM dataset_keys WHERE id=?")
        .bind(&key_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(retired.is_some());
    keys::cleanup(&f.pool, &f.dir.join("data")).await.unwrap();
    assert_eq!(
        request(&a, "POST", "/v1/sql", query.clone()).await.1["rows"],
        json!([[1, "Alice"], [2, "Bob"]])
    );
    let next = sql_sync(&f).await;
    let next_key = std::fs::read_to_string(output.join(next).join("_key")).unwrap();
    assert_ne!(key_id, next_key);
    let old: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM dataset_keys WHERE id=?)")
        .bind(key_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(!old);
    // Disabling new encryption never disables decryption of an existing snapshot.
    f.config.encryption.enabled = false;
    let a = app(&f);
    assert_eq!(
        request(&a, "POST", "/v1/sql", query.clone()).await.0,
        StatusCode::OK
    );
    crate::credentials::delete(&keys::account(&f.pool, false)).unwrap();
    let (status, value) = request(&a, "POST", "/v1/sql", query).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(value["error"].as_str().unwrap().contains("KEK"), "{value}");
    assert!(keys::initialize(&f.pool).await.is_err());
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn encrypted_incremental_key_diff_and_model_inputs() {
    use straton_connectors::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    let (f, input) = incremental_fixture().await;
    let seed = sql_sync(&f).await;
    assert!(
        f.dir
            .join("data/source/users")
            .join(&seed)
            .join("_key")
            .is_file()
    );
    sqlx::query("UPDATE jobs SET delete_detection='key_diff',key_diff_every_runs=1")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::raw_sql("DELETE FROM users WHERE id=1; UPDATE users SET name='Bobby',updated_at=3 WHERE id=2; INSERT INTO users VALUES(3,'Cara',4);").execute(&input).await.unwrap();
    let run = f.enqueue().await;
    runner::state(&f.pool, &f.events, &run, "running", None)
        .await
        .unwrap();
    let output = f.dir.join("data/source/users");
    runner::incremental::prepare(&f.pool, &output, &run, true)
        .await
        .unwrap();
    let delta = output.join(format!(".staging-{run}/delta/part-000000.parquet"));
    assert!(ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(delta).unwrap()).is_err());
    runner::execute(
        &f.pool,
        &backup::Backups::new(f.config.clone()),
        &run,
        &f.events,
    )
    .await
    .unwrap();
    assert_eq!(
        synced_rows(&f).await,
        json!([[2, "Bobby", 3], [3, "Cara", 4]])
    );
    for subdir in ["", "delta", "keys"] {
        let dir = output.join(&run).join(subdir);
        assert!(dir.join("_key").is_file());
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "parquet") {
                assert!(
                    ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(path).unwrap())
                        .is_err()
                );
            }
        }
    }
    let a = app(&f);
    let model = create_model(
        &a,
        "secured",
        "SELECT id,name FROM app_db.users",
        "table",
        "manual",
    )
    .await;
    let model_run = execute_model(&f, &a, &model).await;
    let dir = f.dir.join("data/straton-models/secured").join(model_run);
    assert!(dir.join("_key").is_file());
    assert!(
        ParquetRecordBatchReaderBuilder::try_new(
            std::fs::File::open(dir.join("part-000000.parquet")).unwrap()
        )
        .is_err()
    );
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT id,name FROM models.secured ORDER BY id"})
        )
        .await
        .1["rows"],
        json!([[2, "Bobby"], [3, "Cara"]])
    );
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT count(*) FROM local_lake.app_db_users"})
        )
        .await
        .1["rows"],
        json!([[2]])
    );
    assert_eq!(
        request(&a, "POST", "/v1/admin/keys/rotate-kek", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/sql",
            json!({"query":"SELECT count(*) FROM models.secured"})
        )
        .await
        .1["rows"],
        json!([[2]])
    );
    drop(a);
    input.close().await;
    f.close().await;
}

#[tokio::test]
async fn audit_chain_backfill_verification_tampering_and_status() {
    let dir = std::env::temp_dir().join(format!("straton-audit-test-{}", store::id()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(dir.join("state.db"))
                .create_if_missing(true),
        )
        .await
        .unwrap();
    let mut old = sqlx::migrate!();
    old.migrations = std::borrow::Cow::Owned(
        old.migrations
            .iter()
            .filter(|m| m.version < 8)
            .cloned()
            .collect(),
    );
    old.run(&pool).await.unwrap();
    sqlx::query("INSERT INTO audit_log(timestamp,action,entity_id,detail) VALUES(1,'old.event','dataset','legacy'),(2,'old.event','dataset','second')").execute(&pool).await.unwrap();
    pool.close().await;
    let pool = store::open(&dir).await.unwrap();
    assert!(store::verify_audit(&pool).await.unwrap().ok);
    assert_eq!(store::verify_audit(&pool).await.unwrap().rows, 2);
    let head = store::audit_head(&pool).await.unwrap();
    store::backfill_audit(&pool).await.unwrap();
    assert_eq!(store::audit_head(&pool).await.unwrap(), head);
    crate::access::bootstrap(&pool, "audit-token")
        .await
        .unwrap();
    let config = Config {
        data_dir: dir.clone(),
        ..Default::default()
    };
    let (events, _) = tokio::sync::broadcast::channel(8);
    let a = api::router(api::App {
        pool: pool.clone(),
        sql: crate::sql::Sql::new(pool.clone(), &config).unwrap(),
        events,
        backups: backup::Backups::new(config),
        started: Instant::now(),
    });
    let (status, value) =
        request_as(&a, "audit-token", "GET", "/v1/audit/verify", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["ok"], true);
    let (_, status) = request_as(&a, "audit-token", "GET", "/v1/status", json!(null)).await;
    assert_eq!(
        status["audit_head"],
        store::audit_head(&pool).await.unwrap()
    );
    assert_eq!(status["audit_head"].as_str().unwrap().len(), 64);
    // Bypass the normal append-only guard to model an attacker with database write access.
    sqlx::query("DROP TRIGGER audit_log_no_update")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE audit_log SET detail='tampered' WHERE id=2")
        .execute(&pool)
        .await
        .unwrap();
    store::backfill_audit(&pool).await.unwrap();
    let bad = store::verify_audit(&pool).await.unwrap();
    assert!(!bad.ok);
    assert_eq!(bad.first_bad_id, Some(2));
    let (_, value) = request_as(&a, "audit-token", "GET", "/v1/audit/verify", json!(null)).await;
    assert_eq!(value["first_bad_id"], 2);
    drop(a);
    pool.close().await;
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn security_endpoints_require_global_admin_and_rotation_waits_for_runs() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let target = dataset_id(&f, "users").await;
    let role = access_role(&a, "security reader").await;
    access_grant(&a, &role, "dataset", &target, "read").await;
    let (_, token) = access_user(&a, "security analyst", &[&role]).await;
    for (method, path) in [
        ("GET", "/v1/admin/keys".to_owned()),
        ("POST", "/v1/admin/keys/rotate-kek".to_owned()),
        ("POST", format!("/v1/admin/keys/rotate/{target}")),
        ("GET", "/v1/audit/verify".to_owned()),
    ] {
        assert_eq!(
            request_as(&a, &token, method, &path, json!(null)).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let pending = f.enqueue().await;
    let (status, value) = request(
        &a,
        "POST",
        &format!("/v1/admin/keys/rotate/{target}"),
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    runner::state(&f.pool, &f.events, &pending, "cancelled", None)
        .await
        .unwrap();
    let (status, value) = request(
        &a,
        "POST",
        &format!("/v1/admin/keys/rotate/{target}"),
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(store::verify_audit(&f.pool).await.unwrap().ok);
    drop(a);
    f.close().await;
}

fn explorer_body() -> serde_json::Value {
    json!({"schema":"app_db","table":"users","sort":[{"column":"id","dir":"asc"}],"filters":[],"limit":100,"offset":0})
}
async fn export_bytes(a: &axum::Router, token: &str, body: serde_json::Value) -> Vec<u8> {
    let response = a
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/explorer/export")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}
#[tokio::test]
async fn phase2_explorer_typed_reads_paging_search_and_injection() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let mut q = explorer_body();
    q["sort"][0]["dir"] = json!("desc");
    q["limit"] = json!(1);
    let (s, v) = request(&a, "POST", "/v1/explorer/rows", q.clone()).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[2, "Bob"]]));
    assert_eq!(v["total"], 2);
    assert_eq!(v["total_exact"], true);
    q["offset"] = json!(1);
    assert_eq!(
        request(&a, "POST", "/v1/explorer/rows", q).await.1["rows"],
        json!([[1, "Alice"]])
    );
    for (filters, expected) in [
        (
            json!([{"column":"id","op":"gt","value":"1"}]),
            json!([[2, "Bob"]]),
        ),
        (
            json!([{"column":"id","op":"in","value":[1]}]),
            json!([[1, "Alice"]]),
        ),
        (
            json!([{"column":"name","op":"starts_with","value":"Al"}]),
            json!([[1, "Alice"]]),
        ),
        (
            json!([{"column":"name","op":"contains","value":"%"}]),
            json!([]),
        ),
        (
            json!([{"column":"name","op":"eq","value":"' OR 1=1; DROP TABLE users; --"}]),
            json!([]),
        ),
    ] {
        let mut q = explorer_body();
        q["filters"] = filters;
        let (s, v) = request(&a, "POST", "/v1/explorer/rows", q).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["rows"], expected);
        assert_eq!(v["total"], expected.as_array().unwrap().len());
    }
    let mut q = explorer_body();
    q["search"] = json!("ALi");
    q["columns"] = json!(["name"]);
    assert_eq!(
        request(&a, "POST", "/v1/explorer/rows", q).await.1["rows"],
        json!([["Alice"]])
    );
    for patch in [
        json!({"columns":["missing"]}),
        json!({"sort":[{"column":"missing","dir":"asc"}]}),
        json!({"filters":[{"column":"missing","op":"eq","value":"1"}]}),
        json!({"filters":[{"column":"id","op":"drop","value":1}]}),
        json!({"filters":[{"column":"id","op":"eq","value":"1 OR 1=1"}]}),
        json!({"table":"users; DROP TABLE users"}),
    ] {
        let mut q = explorer_body();
        q.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert_eq!(
            request(&a, "POST", "/v1/explorer/rows", q).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let mut q = explorer_body();
    q["limit"] = json!(999);
    assert_eq!(
        request(&a, "POST", "/v1/explorer/rows", q).await.1["limit"],
        500
    );
    let details: Vec<String> =
        sqlx::query_scalar("SELECT detail FROM audit_log WHERE action='explorer.read'")
            .fetch_all(&f.pool)
            .await
            .unwrap();
    for detail in details {
        assert!(!detail.contains("Alice"));
        assert!(!detail.contains("DROP"));
        let d: serde_json::Value = serde_json::from_str(&detail).unwrap();
        assert_eq!(d["query_shape_hash"].as_str().unwrap().len(), 64);
    }
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn phase2_explorer_policies_exports_storage_and_encryption() {
    use datafusion::{
        arrow::csv::ReaderBuilder, parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder,
    };
    let mut f = sql_fixture().await;
    f.config.encryption.enabled = true;
    let snapshot = sql_sync(&f).await;
    assert!(
        f.dir
            .join("data/source/users")
            .join(&snapshot)
            .join("_key")
            .is_file()
    );
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    let role = access_role(&a, "explorer-reader").await;
    access_grant(&a, &role, "dataset", &did, "read").await;
    let (_, token) = access_user(&a, "explorer", &[&role]).await;
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/row-filters/{role}"),
        json!({"predicate":"id=1"}),
    )
    .await;
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/masks/{role}/name"),
        json!({"kind":"redact"}),
    )
    .await;
    let (s, v) = request_as(&a, &token, "POST", "/v1/explorer/rows", explorer_body()).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[1, "***"]]));
    assert_eq!(v["total"], 1);
    let (_, tree) = request_as(&a, &token, "GET", "/v1/explorer/tree", json!(null)).await;
    assert_eq!(tree["sources"].as_array().unwrap().len(), 1);
    assert_eq!(
        tree["sources"][0]["schemas"][0]["tables"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        tree["sources"][0]["schemas"][0]["tables"][0]["row_filtered"],
        true
    );
    let mut q = explorer_body();
    q["search"] = json!("Alice");
    assert_eq!(
        request_as(&a, &token, "POST", "/v1/explorer/rows", q)
            .await
            .1["rows"],
        json!([])
    );
    for format in ["csv", "parquet"] {
        let mut q = explorer_body();
        q["format"] = json!(format);
        q["max_rows"] = json!(1);
        let bytes = export_bytes(&a, &token, q.clone()).await;
        if format == "csv" {
            let schema = std::sync::Arc::new(datafusion::arrow::datatypes::Schema::new(vec![
                datafusion::arrow::datatypes::Field::new(
                    "id",
                    datafusion::arrow::datatypes::DataType::Int64,
                    false,
                ),
                datafusion::arrow::datatypes::Field::new(
                    "name",
                    datafusion::arrow::datatypes::DataType::Utf8,
                    true,
                ),
            ]));
            let batch = ReaderBuilder::new(schema)
                .with_header(true)
                .build(std::io::Cursor::new(bytes))
                .unwrap()
                .next()
                .unwrap()
                .unwrap();
            assert_eq!(batch.num_rows(), 1);
            assert_eq!(
                crate::sql::cell(batch.column(1).as_ref(), 0).unwrap(),
                json!("***")
            );
        } else {
            let file = f.dir.join("export.parquet");
            std::fs::write(&file, bytes).unwrap();
            let mut reader =
                ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(file).unwrap())
                    .unwrap()
                    .build()
                    .unwrap();
            let batch = reader.next().unwrap().unwrap();
            assert_eq!(batch.num_rows(), 1);
            assert_eq!(
                crate::sql::cell(batch.column(1).as_ref(), 0).unwrap(),
                json!("***")
            );
            assert!(reader.next().is_none());
        }
        let bytes = export_bytes(&a, "good-token", q).await;
        if format == "csv" {
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.contains("Alice"));
            assert!(!text.contains("Bob"));
        }
    }
    let (_, storage) = request_as(&a, &token, "GET", "/v1/storage", json!(null)).await;
    assert_eq!(storage["sources"].as_array().unwrap().len(), 1);
    assert_eq!(storage["sources"][0]["datasets"][0]["dataset_id"], did);
    let physical: u64 = std::fs::read_dir(f.dir.join("data/source/users").join(&snapshot))
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();
    assert_eq!(storage["lake_bytes"], physical);
    assert_eq!(storage["sources"][0]["bytes"], physical);
    assert_eq!(
        storage["total_bytes"].as_u64().unwrap(),
        storage["lake_bytes"].as_u64().unwrap()
            + storage["models_bytes"].as_u64().unwrap()
            + storage["state_db_bytes"].as_u64().unwrap()
            + storage["backups_bytes"].as_u64().unwrap()
    );
    let old = f.dir.join("data/source/users").join(store::id());
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("old.parquet"), [0; 100]).unwrap();
    assert_eq!(
        request(&a, "GET", "/v1/storage", json!(null)).await.1["lake_bytes"],
        physical
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action='explorer.export'"
        )
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        4
    );
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn phase2_saved_queries_visibility_and_mutation_matrix() {
    let f = Fixture::new().await;
    let a = app(&f);
    let role = access_role(&a, "query-readers").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (_, alice) = access_user(&a, "alice", &[&role]).await;
    let (_, bob) = access_user(&a, "bob", &[&role]).await;
    let (_, no_read) = access_user(&a, "no-read", &[]).await;
    let mut ids = Vec::new();
    for (token, name, shared) in [
        (alice.as_str(), "private-a", false),
        (alice.as_str(), "shared-a", true),
        (bob.as_str(), "private-b", false),
        ("good-token", "admin-private", false),
    ] {
        let (s, v) = request_as(
            &a,
            token,
            "POST",
            "/v1/saved-queries",
            json!({"name":name,"sql":"SELECT 1","shared":shared}),
        )
        .await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        ids.push(v["id"].as_str().unwrap().to_owned());
    }
    for (token, count) in [(alice.as_str(), 2), (bob.as_str(), 2), ("good-token", 4)] {
        let (s, v) = request_as(&a, token, "GET", "/v1/saved-queries", json!(null)).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(v.as_array().unwrap().len(), count);
    }
    assert_eq!(
        request_as(&a, &no_read, "GET", "/v1/saved-queries", json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for (i, id) in ids.iter().enumerate() {
        let path = format!("/v1/saved-queries/{id}");
        let get = request_as(&a, &bob, "GET", &path, json!(null)).await.0;
        assert_eq!(
            get,
            if i == 1 || i == 2 {
                StatusCode::OK
            } else {
                StatusCode::NOT_FOUND
            }
        );
        if i != 2 {
            for method in ["PUT", "DELETE"] {
                assert_eq!(
                    request_as(
                        &a,
                        &bob,
                        method,
                        &path,
                        json!({"name":"stolen","sql":"SELECT 2","shared":false})
                    )
                    .await
                    .0,
                    StatusCode::FORBIDDEN
                );
            }
        }
    }
    let path = format!("/v1/saved-queries/{}", ids[0]);
    assert_eq!(
        request_as(
            &a,
            &alice,
            "PUT",
            &path,
            json!({"name":"renamed","sql":"SELECT 2","shared":true})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&a, "DELETE", &path, json!(null)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&a, "GET", &path, json!(null)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_log WHERE action LIKE 'saved_query.%'"
        )
        .fetch_one(&f.pool)
        .await
        .unwrap(),
        6
    );
    drop(a);
    f.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn phase2_cancel_owner_admin_and_registry_cleanup() {
    let f = Fixture::new().await;
    let sql = crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap();
    let a = api::router(api::App {
        pool: f.pool.clone(),
        sql: sql.clone(),
        events: f.events.clone(),
        backups: backup::Backups::new(f.config.clone()),
        started: Instant::now(),
    });
    let role = access_role(&a, "cancellers").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (_, owner) = access_user(&a, "owner", &[&role]).await;
    let (_, other) = access_user(&a, "other", &[&role]).await;
    for canceller in [&owner, "good-token"] {
        let id = uuid::Uuid::new_v4();
        let router = a.clone();
        let token = owner.clone();
        let query = tokio::spawn(async move {
            request_as(&router,&token,"POST","/v1/sql",json!({"query_id":id.to_string(),"query":"SELECT sum(value) FROM generate_series(1, 1000000000000)"})).await
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if sql.running.lock().unwrap().contains_key(&id) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let path = format!("/v1/sql/cancel/{id}");
        assert_eq!(
            request_as(&a, &other, "POST", &path, json!(null)).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request_as(&a, canceller, "POST", &path, json!(null))
                .await
                .0,
            StatusCode::NO_CONTENT
        );
        let (s, v) = tokio::time::timeout(Duration::from_secs(5), query)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(s, StatusCode::CONFLICT, "{v}");
        assert_eq!(v, json!({"error":"cancelled"}));
        assert!(sql.running.lock().unwrap().is_empty());
        assert_eq!(
            request_as(&a, &owner, "POST", &path, json!(null)).await.0,
            StatusCode::NOT_FOUND
        );
    }
    let id = store::id();
    assert_eq!(
        request_as(
            &a,
            &owner,
            "POST",
            "/v1/sql",
            json!({"query_id":id,"query":"SELECT 1"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(sql.running.lock().unwrap().is_empty());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_log WHERE action='sql.cancel'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        2
    );
    drop(a);
    drop(sql);
    f.close().await;
}

#[tokio::test]
async fn phase2_explorer_count_budget_and_empty_exports() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    create_model(
        &a,
        "large_view",
        "SELECT value FROM generate_series(1, 1000000000000) WHERE value % 2 = 0",
        "view",
        "manual",
    )
    .await;
    let (s, v) = request(
        &a,
        "POST",
        "/v1/explorer/rows",
        json!({"schema":"models","table":"large_view","limit":1}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([[2]]));
    assert_eq!(v["total_exact"], false);
    for format in ["csv", "parquet"] {
        let mut q = explorer_body();
        q["filters"] = json!([{"column":"id","op":"lt","value":0}]);
        q["format"] = json!(format);
        let bytes = export_bytes(&a, "good-token", q).await;
        if format == "csv" {
            assert_eq!(String::from_utf8(bytes).unwrap().trim(), "id,name");
        } else {
            let path = f.dir.join("empty.parquet");
            std::fs::write(&path, bytes).unwrap();
            let builder =
                datafusion::parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(
                    std::fs::File::open(path).unwrap(),
                )
                .unwrap();
            assert_eq!(builder.schema().fields().len(), 2);
            assert_eq!(builder.metadata().file_metadata().num_rows(), 0);
        }
    }
    let guard = tokio::time::timeout(Duration::from_secs(2), crate::sql::SNAPSHOTS.write())
        .await
        .unwrap();
    drop(guard);
    drop(a);
    f.close().await;
}

fn quality_input(
    name: &str,
    kind: &str,
    dataset: &str,
    column: Option<&str>,
    config: serde_json::Value,
) -> serde_json::Value {
    json!({"name":name,"kind":kind,"dataset_id":dataset,"column_name":column,"config":config,"severity":"error","enabled":true})
}
async fn create_check(a: &axum::Router, q: serde_json::Value) -> String {
    let (s, v) = request(a, "POST", "/v1/quality/checks", q).await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    v["id"].as_str().unwrap().into()
}
#[tokio::test]
async fn phase3_quality_all_kinds_scores_and_validation() {
    let f = sql_fixture().await;
    let input = sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(f.dir.join("sql-input.db")),
        )
        .await
        .unwrap();
    sqlx::query("INSERT INTO users VALUES(3,NULL),(4,'Alice')")
        .execute(&input)
        .await
        .unwrap();
    input.close().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    for (kind, column, pass, fail) in [
        ("not_null", Some("name"), json!({}), json!({})),
        ("unique", Some("name"), json!({}), json!({})),
        (
            "range",
            Some("id"),
            json!({"min":1,"max":4}),
            json!({"min":1,"max":1}),
        ),
        (
            "freshness",
            None,
            json!({"max_age_seconds":3600}),
            json!({"max_age_seconds":1}),
        ),
        (
            "row_count",
            None,
            json!({"min":4,"max":4}),
            json!({"min":5}),
        ),
        (
            "custom_sql",
            None,
            json!({"sql":"SELECT * FROM app_db.users WHERE id<0"}),
            json!({"sql":"SELECT * FROM app_db.users WHERE id=1"}),
        ),
    ] {
        for (config, expected) in [(pass, "passed"), (fail, "failed")] {
            let col = if expected == "passed" && ["not_null", "unique"].contains(&kind) {
                Some("id")
            } else {
                column
            };
            let id = create_check(
                &a,
                quality_input(&format!("{kind}-{expected}"), kind, &did, col, config),
            )
            .await;
            if kind == "freshness" && expected == "failed" {
                sqlx::query("UPDATE datasets SET last_synced_at='2000-01-01T00:00:00Z' WHERE id=?")
                    .bind(&did)
                    .execute(&f.pool)
                    .await
                    .unwrap();
            }
            let (s, v) = request(
                &a,
                "POST",
                &format!("/v1/quality/checks/{id}/run"),
                json!(null),
            )
            .await;
            assert_eq!(s, StatusCode::OK, "{kind}: {v}");
            assert_eq!(v["status"], expected, "{kind}: {v}");
            if kind == "not_null" && expected == "failed" {
                assert_eq!(v["failing_rows"], 1);
            }
            if kind == "unique" && expected == "failed" {
                assert_eq!(v["failing_rows"], 2);
            }
            assert!(!v.to_string().contains("Alice"));
            let (_, history) = request(
                &a,
                "GET",
                &format!("/v1/quality/checks/{id}/runs?limit=1"),
                json!(null),
            )
            .await;
            assert_eq!(history.as_array().unwrap().len(), 1);
        }
    }
    let (_, v) = request(&a, "GET", "/v1/quality/summary", json!(null)).await;
    assert_eq!(v["score"], 50.0);
    assert_eq!(v["counts"], json!({"passed":6,"failed":6,"error":0}));
    assert_eq!(v["datasets"][0]["score"], 50.0);
    assert_eq!(v["daily"].as_array().unwrap().len(), 30);
    assert_eq!(
        request(&a, "GET", "/v1/quality/runs?limit=3", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        3
    );
    for q in [
        quality_input("bad", "range", &did, Some("id"), json!({"min":5,"max":2})),
        quality_input("bad", "not_null", &did, Some("missing"), json!({})),
        quality_input(
            "bad",
            "custom_sql",
            &did,
            None,
            json!({"sql":"DELETE FROM app_db.users"}),
        ),
        quality_input(
            "bad",
            "custom_sql",
            &did,
            None,
            json!({"sql":"SELECT 1; SELECT 2"}),
        ),
    ] {
        assert_eq!(
            request(&a, "POST", "/v1/quality/checks", q).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let id = create_check(
        &a,
        quality_input("error", "not_null", &did, Some("id"), json!({})),
    )
    .await;
    sqlx::query("UPDATE quality_checks SET column_name='missing' WHERE id=?")
        .bind(&id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &a,
            "POST",
            &format!("/v1/quality/checks/{id}/run"),
            json!(null)
        )
        .await
        .1["status"],
        "error"
    );
    drop(a);
    f.close().await;
}
fn pipeline_input(model: &str, check: &str) -> serde_json::Value {
    json!({"name":"Flow","nodes":[{"node_id":"sync","kind":"sync","ref_id":"job"},{"node_id":"model","kind":"transform","ref_id":model},{"node_id":"check","kind":"validate","ref_id":check},{"node_id":"later","kind":"transform","ref_id":model}],"edges":[{"from_node":"sync","to_node":"model"},{"from_node":"model","to_node":"check"},{"from_node":"check","to_node":"later"}]})
}
async fn pipeline_done(
    f: &Fixture,
    a: &axum::Router,
    id: &str,
    dispatch: bool,
) -> serde_json::Value {
    let mut runner = runner::Runner::new(
        f.pool.clone(),
        f.events.clone(),
        backup::Backups::new(f.config.clone()),
        4,
    );
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if dispatch {
                runner.dispatch().await.unwrap();
            }
            let (s, v) = request(a, "GET", &format!("/v1/pipeline-runs/{id}"), json!(null)).await;
            assert_eq!(s, StatusCode::OK, "{v}");
            if ["succeeded", "failed", "cancelled", "interrupted"]
                .iter()
                .any(|s| v["state"] == *s)
            {
                if v["state"] == "succeeded" || v["state"] == "failed" {
                    let notified: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM notifications WHERE entity_id=?)",
                    )
                    .bind(id)
                    .fetch_one(&f.pool)
                    .await
                    .unwrap();
                    if !notified {
                        tokio::task::yield_now().await;
                        continue;
                    }
                }
                break v;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("pipeline completed");
    runner.drain().await;
    result
}
#[tokio::test]
async fn phase3_pipeline_validation_execute_skip_warning_cancel_and_recovery() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let model = create_model(
        &a,
        "flow_model",
        "SELECT * FROM app_db.users",
        "table",
        "manual",
    )
    .await;
    let check=create_check(&a,json!({"name":"Built rows","model_id":model,"kind":"row_count","config":{"min":2,"max":2},"severity":"error"})).await;
    let q = pipeline_input(&model, &check);
    let mut invalid = q.clone();
    invalid["edges"]
        .as_array_mut()
        .unwrap()
        .push(json!({"from_node":"later","to_node":"sync"}));
    assert_eq!(
        request(&a, "POST", "/v1/pipelines/validate", invalid.clone())
            .await
            .1["valid"],
        false
    );
    let (s, v) = request(&a, "POST", "/v1/pipelines", invalid).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(v["valid"], false);
    for variation in ["ref", "duplicate", "self", "edge", "missing_edge"] {
        let mut invalid = q.clone();
        match variation {
            "ref" => invalid["nodes"][0]["ref_id"] = json!("missing"),
            "duplicate" => invalid["nodes"][1]["node_id"] = json!("sync"),
            "self" => invalid["edges"][0]["to_node"] = json!("sync"),
            "edge" => {
                let e = invalid["edges"][0].clone();
                invalid["edges"].as_array_mut().unwrap().push(e);
            }
            _ => invalid["edges"][0]["to_node"] = json!("missing"),
        };
        assert_eq!(
            request(&a, "POST", "/v1/pipelines/validate", invalid)
                .await
                .1["valid"],
            false,
            "{variation}"
        );
    }
    let (s, v) = request(&a, "POST", "/v1/pipelines", q.clone()).await;
    assert_eq!(s, StatusCode::CREATED, "{v}");
    let id = v["id"].as_str().unwrap();
    let (s, r) = request(&a, "POST", &format!("/v1/pipelines/{id}/run"), json!(null)).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{r}");
    let run = r["id"].as_str().unwrap();
    assert_eq!(
        request(&a, "POST", &format!("/v1/pipelines/{id}/run"), json!(null))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&a, "PUT", &format!("/v1/pipelines/{id}"), q.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    let done = pipeline_done(&f, &a, run, true).await;
    assert_eq!(done["state"], "succeeded", "{done}");
    assert!(
        done["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["state"] == "succeeded")
    );
    sqlx::query("UPDATE quality_checks SET config=? WHERE id=?")
        .bind(json!({"min":3}).to_string())
        .bind(&check)
        .execute(&f.pool)
        .await
        .unwrap();
    let (_, r) = request(&a, "POST", &format!("/v1/pipelines/{id}/run"), json!(null)).await;
    let done = pipeline_done(&f, &a, r["id"].as_str().unwrap(), true).await;
    assert_eq!(done["state"], "failed", "{done}");
    assert_eq!(
        done["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["node_id"] == "later")
            .unwrap()["state"],
        "skipped"
    );
    sqlx::query("UPDATE quality_checks SET severity='warn' WHERE id=?")
        .bind(&check)
        .execute(&f.pool)
        .await
        .unwrap();
    let (_, r) = request(&a, "POST", &format!("/v1/pipelines/{id}/run"), json!(null)).await;
    assert_eq!(
        pipeline_done(&f, &a, r["id"].as_str().unwrap(), true).await["state"],
        "succeeded"
    );
    let (_, r) = request(&a, "POST", &format!("/v1/pipelines/{id}/run"), json!(null)).await;
    let run = r["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(3),async{loop{let child:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pipeline_run_nodes WHERE run_id=? AND child_run_id IS NOT NULL)").bind(run).fetch_one(&f.pool).await.unwrap();if child{break}tokio::time::sleep(Duration::from_millis(10)).await;}}).await.unwrap();
    assert_eq!(
        request(
            &a,
            "POST",
            &format!("/v1/pipeline-runs/{run}/cancel"),
            json!(null)
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let done = pipeline_done(&f, &a, run, false).await;
    assert_eq!(done["state"], "cancelled");
    assert!(
        done["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["state"] == "cancelled")
    );
    let cancelled:bool=sqlx::query_scalar("SELECT cancel_requested FROM runs WHERE id=(SELECT child_run_id FROM pipeline_run_nodes WHERE run_id=? AND child_run_id IS NOT NULL LIMIT 1)").bind(run).fetch_one(&f.pool).await.unwrap();
    assert!(cancelled);
    for state in ["queued", "running"] {
        let mut tx = f.pool.begin().await.unwrap();
        let run = crate::pipeline::enqueue(&mut tx, id, "manual")
            .await
            .unwrap();
        tx.commit().await.unwrap();
        sqlx::query("UPDATE pipeline_runs SET state=? WHERE id=?")
            .bind(state)
            .bind(&run)
            .execute(&f.pool)
            .await
            .unwrap();
        crate::pipeline::recover(&f.pool, &f.events).await.unwrap();
        let done = pipeline_done(&f, &a, &run, false).await;
        assert_eq!(done["state"], "interrupted");
        assert!(
            done["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|n| n["state"] == "cancelled")
        );
    }
    assert_eq!(
        request(
            &a,
            "GET",
            &format!("/v1/pipelines/{id}/runs?limit=2"),
            json!(null)
        )
        .await
        .1
        .as_array()
        .unwrap()
        .len(),
        2
    );
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn phase3_analytics_access_ranges_drill_visibility_and_lineage() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;
    let role = access_role(&a, "chart-reader").await;
    access_grant(&a, &role, "dataset", &did, "read").await;
    let (_, token) = access_user(&a, "chart-user", &[&role]).await;
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/row-filters/{role}"),
            json!({"predicate":"id=1"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &a,
            "PUT",
            &format!("/v1/datasets/{did}/masks/{role}/name"),
            json!({"kind":"redact"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (s, owned_check) = request_as(
        &a,
        &token,
        "POST",
        "/v1/quality/checks",
        quality_input(
            "Owner-scoped counts",
            "row_count",
            &did,
            None,
            json!({"min":1,"max":1}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{owned_check}");
    let (s, v) = request_as(
        &a,
        &token,
        "POST",
        &format!(
            "/v1/quality/checks/{}/run",
            owned_check["id"].as_str().unwrap()
        ),
        json!(null),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["status"], "passed");
    // Row filter id=1 applies: the owner's check must not count hidden rows.
    assert_eq!(v["observed"], 1.0);
    let query = "SELECT id,name,CAST('2026-10-22T00:00:00' AS TIMESTAMP) AS at FROM app_db.users ORDER BY id";
    let body = json!({"name":"Users","sql":query,"kind":"table","config":{"x":"id","y":["id"],"time_column":"at"},"shared":true});
    let (s, chart) = request(&a, "POST", "/v1/charts", body.clone()).await;
    assert_eq!(s, StatusCode::CREATED, "{chart}");
    let id = chart["id"].as_str().unwrap();
    let path = format!("/v1/charts/{id}/data");
    let (s, v) = request_as(&a, &token, "POST", &path, json!({})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"].as_array().unwrap().len(), 1);
    assert_eq!(v["rows"][0][1], "***");
    let (_, v) = request_as(
        &a,
        &token,
        "POST",
        &path,
        json!({"from":"2027-01-01T00:00:00","to":"2027-02-01T00:00:00"}),
    )
    .await;
    assert_eq!(v["rows"], json!([]));
    let(s,v)=request_as(&a,&token,"POST","/v1/charts/preview",json!({"sql":query,"config":body["config"],"from":"2026-10-21T00:00:00","to":"2026-10-23T00:00:00"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"][0][1], "***");
    let (_, v) = request_as(
        &a,
        &token,
        "POST",
        &format!("/v1/charts/{id}/drill"),
        json!({"x_value":2}),
    )
    .await;
    assert_eq!(v["rows"], json!([]));
    let (s, v) = request_as(
        &a,
        &token,
        "POST",
        &format!("/v1/charts/{id}/drill"),
        json!({"x_value":1}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"][0][1], "***");
    assert_eq!(
        request_as(&a, &token, "PUT", &format!("/v1/charts/{id}"), body.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let(s,grouped)=request(&a,"POST","/v1/charts",json!({"name":"Grouped","sql":"SELECT name AS person,count(*) AS n FROM app_db.users GROUP BY name","kind":"bar","config":{"x":"person","y":["n"]},"shared":true})).await;
    assert_eq!(s, StatusCode::CREATED, "{grouped}");
    let (s, v) = request_as(
        &a,
        &token,
        "POST",
        &format!("/v1/charts/{}/drill", grouped["id"].as_str().unwrap()),
        json!({"x_value":"***"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(
        v["columns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "id")
    );
    assert_eq!(v["rows"][0][1], "***");
    let mut private = body.clone();
    private["name"] = json!("Private");
    private["shared"] = json!(false);
    let (_, private) = request(&a, "POST", "/v1/charts", private).await;
    let private_id = private["id"].as_str().unwrap();
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            &format!("/v1/charts/{private_id}"),
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let(s,dashboard)=request(&a,"POST","/v1/dashboards",json!({"name":"Dashboard","shared":true,"layout":[{"chart_id":id,"x":0,"y":0,"w":6,"h":3},{"chart_id":private_id,"x":6,"y":0,"w":6,"h":3}]})).await;
    assert_eq!(s, StatusCode::CREATED, "{dashboard}");
    let dashboard_id = dashboard["id"].as_str().unwrap();
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            &format!("/v1/dashboards/{dashboard_id}"),
            json!(null)
        )
        .await
        .1["layout"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        request_as(
            &a,
            &token,
            "DELETE",
            &format!("/v1/dashboards/{dashboard_id}"),
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, private_dash) = request(
        &a,
        "POST",
        "/v1/dashboards",
        json!({"name":"Private","layout":[],"shared":false}),
    )
    .await;
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            &format!("/v1/dashboards/{}", private_dash["id"].as_str().unwrap()),
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request_as(&a, &token, "GET", "/v1/charts", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        request(&a, "GET", "/v1/charts", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let model = create_model(
        &a,
        "impact_model",
        "SELECT * FROM app_db.users",
        "table",
        "manual",
    )
    .await;
    let check=create_check(&a,json!({"name":"Impact check","model_id":model,"kind":"row_count","config":{"min":1},"severity":"error"})).await;
    let (s, pipeline) = request(&a, "POST", "/v1/pipelines", pipeline_input(&model, &check)).await;
    assert_eq!(s, StatusCode::CREATED, "{pipeline}");
    let (s, impact) = request(
        &a,
        "GET",
        &format!("/v1/lineage/impact?node=dataset:{did}&direction=downstream"),
        json!(null),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{impact}");
    for kind in ["models", "pipelines", "checks", "charts", "dashboards"] {
        assert!(
            impact["summary"][kind].as_u64().unwrap() > 0,
            "{kind}: {impact}"
        );
    }
    let (_, limited) = request(
        &a,
        "GET",
        &format!("/v1/lineage/impact?node=dataset:{did}&depth=0"),
        json!(null),
    )
    .await;
    assert_eq!(limited["nodes"].as_array().unwrap().len(), 1);
    let (_, impact) = request_as(
        &a,
        &token,
        "GET",
        &format!("/v1/lineage/impact?node=dataset:{did}&direction=both"),
        json!(null),
    )
    .await;
    assert!(
        !impact["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == format!("chart:{private_id}"))
    );
    assert_eq!(impact["summary"]["pipelines"], 0);
    let (_, up) = request(
        &a,
        "GET",
        &format!("/v1/lineage/impact?node=model:{model}&direction=upstream"),
        json!(null),
    )
    .await;
    assert!(
        up["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == format!("dataset:{did}"))
    );
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn phase3_activity_paging_notifications_per_user_and_failures() {
    let mut f = Fixture::new().await;
    let a = app(&f);
    let role = access_role(&a, "activity-reader").await;
    access_grant(&a, &role, "source", "source", "read").await;
    let (user, token) = access_user(&a, "activity-user", &[&role]).await;
    let (_, admin_token) = access_user(&a, "second-admin", &["admin"]).await;
    for name in ["First", "Second", "Third"] {
        assert_eq!(
            request_as(
                &a,
                &token,
                "POST",
                "/v1/saved-queries",
                json!({"name":name,"sql":"SELECT 'private value'"})
            )
            .await
            .0,
            StatusCode::CREATED
        );
    }
    let (_, rows) = request_as(
        &a,
        &token,
        "GET",
        "/v1/activity?limit=2&action_prefix=saved_query",
        json!(null),
    )
    .await;
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r["actor_id"] == user));
    assert!(!json!(rows).to_string().contains("private value"));
    let before = rows[1]["id"].as_i64().unwrap();
    let (_, page) = request_as(
        &a,
        &token,
        "GET",
        &format!("/v1/activity?limit=2&before_id={before}&action_prefix=saved_query"),
        json!(null),
    )
    .await;
    assert_eq!(page.as_array().unwrap().len(), 1);
    assert!(page[0]["id"].as_i64().unwrap() < before);
    assert!(
        request(&a, "GET", "/v1/activity?limit=200", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .len()
            > 3
    );
    assert_eq!(
        request_as(&a, &token, "GET", "/v1/activity?actor=admin", json!(null))
            .await
            .1,
        json!([])
    );
    let mut rx = f.events.subscribe();
    crate::notify::emit(
        &f.pool,
        &f.events,
        crate::notify::Notice {
            severity: "info",
            kind: "test",
            title: "For user",
            entity_kind: "test",
            entity_id: "entity",
            user_id: Some(&user),
        },
    )
    .await
    .unwrap();
    assert_eq!(rx.recv().await.unwrap()["type"], "notification");
    let id = f.enqueue().await;
    runner::state(
        &f.pool,
        &f.events,
        &id,
        "failed",
        Some("private failure value"),
    )
    .await
    .unwrap();
    let (_, rows) = request(&a, "GET", "/v1/notifications", json!(null)).await;
    let admin_id = rows[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["kind"], "run.failed");
    // The title names the failed job; the error detail stays out of notifications.
    assert_eq!(rows[0]["title"], "Test failed");
    assert!(!rows.to_string().contains("private failure"));
    assert_eq!(
        request(
            &a,
            "POST",
            "/v1/notifications/read",
            json!({"ids":[admin_id]})
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&a, "GET", "/v1/notifications/unread-count", json!(null))
            .await
            .1["count"],
        0
    );
    assert_eq!(
        request_as(
            &a,
            &admin_token,
            "GET",
            "/v1/notifications/unread-count",
            json!(null)
        )
        .await
        .1["count"],
        1
    );
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            "/v1/notifications?unread=true",
            json!(null)
        )
        .await
        .1
        .as_array()
        .unwrap()
        .len(),
        1
    );
    request_as(
        &a,
        &token,
        "POST",
        "/v1/notifications/read",
        json!({"ids":[admin_id]}),
    )
    .await;
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            "/v1/notifications/unread-count",
            json!(null)
        )
        .await
        .1["count"],
        1
    );
    request_as(
        &a,
        &token,
        "POST",
        "/v1/notifications/read",
        json!({"all":true}),
    )
    .await;
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            "/v1/notifications?unread=true",
            json!(null)
        )
        .await
        .1,
        json!([])
    );
    assert_eq!(
        request_as(&a, &token, "GET", "/v1/notifications", json!(null))
            .await
            .1[0]["read"],
        true
    );
    drop(a);
    f.config.backup.dir = f.dir.join("blocked-backup");
    std::fs::write(&f.config.backup.dir, b"file").unwrap();
    let a = app(&f);
    assert_eq!(
        request(&a, "POST", "/v1/backups", json!(null)).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(
        request(&a, "GET", "/v1/notifications", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "backup.failed" && n["title"] == "Backup failed")
    );
    // A failed backup is one notification, not a generic run failure plus a backup failure.
    assert!(
        !request(&a, "GET", "/v1/notifications", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "run.failed" && n["title"] == "Backup failed")
    );
    sqlx::query("DROP TRIGGER audit_log_no_update")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE audit_log SET detail='tampered' WHERE id=1")
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        request(&a, "GET", "/v1/audit/verify", json!(null)).await.1["ok"],
        false
    );
    assert!(
        request(&a, "GET", "/v1/notifications", json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "audit.failed")
    );
    drop(a);
    f.close().await;
}
#[tokio::test]
async fn phase3_scheduler_pipelines_checks_and_notification_retention() {
    let f = Fixture::new().await;
    let a = app(&f);
    let(s,p)=request(&a,"POST","/v1/pipelines",json!({"name":"Scheduled","cron":"0 0 0 1 1 * 2000","nodes":[{"node_id":"sync","kind":"sync","ref_id":"job"}]})).await;
    assert_eq!(s, StatusCode::CREATED, "{p}");
    let check=create_check(&a,json!({"name":"Scheduled","kind":"custom_sql","config":{"sql":"SELECT 1 WHERE false"},"severity":"error","cron":"0 0 0 1 1 * 2000"})).await;
    sqlx::query("UPDATE pipelines SET last_scheduled=0")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE quality_checks SET last_scheduled=0")
        .execute(&f.pool)
        .await
        .unwrap();
    crate::notify::emit(
        &f.pool,
        &f.events,
        crate::notify::Notice {
            severity: "info",
            kind: "old",
            title: "Old",
            entity_kind: "test",
            entity_id: "",
            user_id: None,
        },
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO notification_reads SELECT id,'admin' FROM notifications")
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE notifications SET created_at=?")
        .bind(store::now() - 91 * 86400)
        .execute(&f.pool)
        .await
        .unwrap();
    let sql = crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap();
    scheduler::tick(&f.pool, &sql, &f.events).await.unwrap();
    scheduler::tick(&f.pool, &sql, &f.events).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM pipeline_runs")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if sqlx::query_scalar::<_, i64>("SELECT count(*) FROM quality_runs WHERE check_id=?")
                .bind(&check)
                .fetch_one(&f.pool)
                .await
                .unwrap()
                == 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notifications WHERE kind='old'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM notification_reads")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        0
    );
    let run: String = sqlx::query_scalar("SELECT id FROM pipeline_runs")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    crate::pipeline::cancel(&f.pool, &f.events, &run)
        .await
        .unwrap();
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn sqlserver_api_credentials_validation_and_metadata() {
    use secrecy::ExposeSecret;
    let f = Fixture::new().await;
    let app = app(&f);
    let secret = "sqlserver-password-never-in-config";
    let config = json!({"host":"localhost","database":"scratch","auth":"sql","username":"reader","encrypt":true,"trust_server_certificate":false});
    let (status, source) = request(
        &app,
        "POST",
        "/v1/sources",
        json!({"name":"SQL Server", "kind":"sqlserver", "config":config, "secret":secret}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{source}");
    let id = source["id"].as_str().unwrap();
    assert_eq!(source["kind"], "sqlserver");
    assert!(!source.to_string().contains(secret));
    assert_eq!(
        crate::credentials::get(id)
            .unwrap()
            .unwrap()
            .expose_secret(),
        secret
    );
    let (status, _) = request(
        &app,
        "PUT",
        &format!("/v1/sources/{id}"),
        json!({"name":"Renamed SQL Server", "kind":"sqlserver", "config":config}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        crate::credentials::get(id)
            .unwrap()
            .unwrap()
            .expose_secret(),
        secret
    );
    for (key, value) in [
        ("password", json!(secret)),
        ("auth", json!("invalid")),
        ("port", json!(65536)),
        ("encrypt", json!("true")),
        ("trust_server_certificate", json!("false")),
        ("batch_size", json!(0)),
    ] {
        let mut invalid = config.clone();
        invalid[key] = value;
        let (status, response) = request(
            &app,
            "POST",
            "/v1/sources",
            json!({"name":"Bad", "kind":"sqlserver", "config":invalid, "secret":secret}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!response.to_string().contains(secret));
    }
    let (status, _) = request(
        &app,
        "POST",
        "/v1/sources",
        json!({"name":"Missing password", "kind":"sqlserver", "config":config}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let ds = straton_core::DatasetSchema {
        dataset: straton_core::Dataset {
            id: String::new(),
            source_id: id.into(),
            name: "sales.revenue".into(),
        },
        columns: vec![straton_core::Column {
            id: String::new(),
            dataset_id: String::new(),
            name: "version".into(),
            data_type: "FixedSizeBinary(8)".into(),
            nullable: false,
            primary_key: true,
        }],
        relationships: vec![],
        metadata: straton_core::DatasetMetadata {
            is_view: true,
            definition: Some("SELECT version FROM sales.orders".into()),
            approximate_rows: Some(42),
            indexes: vec![straton_core::DatasetIndex {
                name: "uq_version".into(),
                columns: vec!["version".into()],
                unique: true,
                clustered: false,
                kind: "NONCLUSTERED".into(),
                unique_constraint: true,
            }],
            ..Default::default()
        },
    };
    let mut tx = f.pool.begin().await.unwrap();
    let did = crate::catalog::upsert(&mut tx, id, &ds).await.unwrap();
    crate::catalog::upsert(&mut tx, id, &ds).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM dataset_indexes WHERE dataset_id=?")
            .bind(&did)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        1
    );
    let (_, map) = request(&app, "GET", "/v1/datamap", json!(null)).await;
    let view = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == did)
        .unwrap();
    assert_eq!(view["dataset_type"], "view");
    assert_eq!(view["approximate_row_count"], 42);
    assert_eq!(view["definition"], "SELECT version FROM sales.orders");
    let (_, tree) = request(&app, "GET", "/v1/explorer/tree", json!(null)).await;
    assert!(tree.to_string().contains("\"dataset_type\":\"view\""));
    let (status, response) = request(&app, "POST", "/v1/jobs", json!({"name":"Rowversion sync", "source_id":id, "dataset":"sales.revenue", "enabled":true, "mode":"incremental", "watermark_column":"version"})).await;
    assert_eq!(status, StatusCode::CREATED, "{response}");
    let audit = sqlx::query_scalar::<_, String>("SELECT detail FROM audit_log")
        .fetch_all(&f.pool)
        .await
        .unwrap();
    assert!(audit.iter().all(|s| !s.contains(secret)));
    #[cfg(windows)]
    {
        let (status, response) = request(&app, "PUT", &format!("/v1/sources/{id}"), json!({"name":"Integrated", "kind":"sqlserver", "config":{"host":"localhost","database":"scratch","auth":"windows"}})).await;
        assert_eq!(status, StatusCode::OK);
        assert!(response["credential_id"].is_null());
        assert!(crate::credentials::get(id).unwrap().is_none());
    }
    f.close().await;
}

#[tokio::test]
async fn sqlserver_live_full_sync_and_resume() {
    use futures::StreamExt;
    let Ok(target) = std::env::var("STRATON_TEST_SQLSERVER") else {
        return;
    };
    let (server, path) = target
        .split_once('/')
        .expect("host:port/database?auth=windows");
    let (database, query) = path.split_once('?').unwrap_or((path, ""));
    assert_eq!(
        database, "straton_scratch",
        "live tests are limited to the scratch database"
    );
    let (host, port) = server
        .rsplit_once(':')
        .map(|(h, p)| (h, p.parse::<u16>().unwrap()))
        .unwrap_or((server, 1433));
    let mut config =
        json!({"host":host,"port":port,"database":database,"auth":"windows","batch_size":2});
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap();
        match key {
            "auth" | "instance" | "username" => config[key] = json!(value),
            "encrypt" | "trust_server_certificate" => {
                config[key] = json!(value.parse::<bool>().unwrap())
            }
            _ => panic!("unsupported SQL Server test option"),
        }
    }
    let mut f = Fixture::new().await;
    // Local test snapshots are plaintext so their row counts can be verified without the OS keychain.
    f.config.encryption.enabled = false;
    if let Ok(secret) = std::env::var("STRATON_TEST_SQLSERVER_PASSWORD") {
        crate::credentials::set("source", &secret.into()).unwrap();
        sqlx::query("UPDATE sources SET credential_id='source' WHERE id='source'")
            .execute(&f.pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "UPDATE sources SET name='Scratch SQL Server',kind='sqlserver',config=? WHERE id='source'",
    )
    .bind(config.to_string())
    .execute(&f.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE jobs SET dataset='sales.orders' WHERE id='job'")
        .execute(&f.pool)
        .await
        .unwrap();
    let app = app(&f);
    assert_eq!(
        request(&app, "POST", "/v1/sources/source/check", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "POST", "/v1/sources/source/discover", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM relationships WHERE kind='lineage'")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    crate::catalog::discover(&f.pool, "source").await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM relationships WHERE kind='lineage'")
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        before
    );
    for name in [
        "sales.customers",
        "sales.products",
        "sales.orders",
        "sales.order_items",
        "sales.v_customer_revenue",
    ] {
        assert!(
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM datasets WHERE source_id='source' AND name=?)"
            )
            .bind(name)
            .fetch_one(&f.pool)
            .await
            .unwrap()
        );
    }
    let connector = crate::catalog::connector(&f.pool, "source").await.unwrap();
    let mut stream = connector
        .read("sales.orders", Default::default())
        .await
        .unwrap();
    let (first, cursor) = stream
        .next()
        .await
        .expect("scratch orders must contain rows")
        .unwrap();
    let mut expected = first.num_rows() as i64;
    while let Some(batch) = stream.next().await {
        expected += batch.unwrap().0.num_rows() as i64;
    }
    drop(stream);
    let id = f.enqueue().await;
    runner::state(&f.pool, &f.events, &id, "running", None)
        .await
        .unwrap();
    let output = f.dir.join("data/source/sales.orders");
    let staging = output.join(format!(".staging-{id}"));
    straton_connectors::write_parquet(&staging.join("part-000000.parquet"), &first, None).unwrap();
    runner::checkpoint(&f.pool, &id, &cursor).await.unwrap();
    runner::execute(
        &f.pool,
        &backup::Backups::new(f.config.clone()),
        &id,
        &f.events,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(output.join("_current")).unwrap(),
        id
    );
    let rows: i64 = sqlx::query_scalar(
        "SELECT row_count FROM datasets WHERE source_id='source' AND name='sales.orders'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(rows, expected);
    assert!(rows > 0);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM runs WHERE id=?")
            .bind(&id)
            .fetch_one(&f.pool)
            .await
            .unwrap(),
        "succeeded"
    );
    // All SQL Server operations above are SELECTs; only the local fixture and lake are written.
    drop(connector);
    f.close().await;
}

#[tokio::test]
async fn column_lineage_chains_access_masks_and_incomplete() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let source = dataset_id(&f, "users").await;
    let first = create_model(
        &a,
        "column_first",
        "SELECT id AS user_id,name FROM app_db.users WHERE id > 0",
        "view",
        "manual",
    )
    .await;
    let second = create_model(
        &a,
        "column_second",
        "SELECT user_id + 1 AS result FROM models.column_first",
        "view",
        "manual",
    )
    .await;
    let target: String = sqlx::query_scalar(
        "SELECT id FROM datasets WHERE source_id='straton-models' AND name='column_second'",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let (status, chart) = request(&a,"POST","/v1/charts",json!({"name":"Column usages","sql":"SELECT id,count(*) AS n FROM app_db.users WHERE id > 0 GROUP BY id","kind":"bar","config":{"x":"id","y":["n"]},"shared":true})).await;
    assert_eq!(status, StatusCode::CREATED, "{chart}");
    let (status, check) = request(
        &a,
        "POST",
        "/v1/quality/checks",
        quality_input("Column check", "not_null", &source, Some("id"), json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{check}");
    let endpoint = format!("/v1/lineage/columns?dataset={target}&column=result&direction=upstream");
    let (status, graph) = request(&a, "GET", &endpoint, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{graph}");
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 3, "{graph}");
    assert_eq!(graph["edges"].as_array().unwrap().len(), 2, "{graph}");
    assert_eq!(graph["incomplete"], false, "{graph}");
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "rename" && e["via"]["model_id"] == first)
    );
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "transform" && e["via"]["model_id"] == second)
    );
    assert!(
        graph["usage"]
            .as_array()
            .unwrap()
            .iter()
            .any(|u| u["role"] == "filter")
    );
    for kind in ["model", "chart", "check"] {
        assert!(
            graph["usage"]
                .as_array()
                .unwrap()
                .iter()
                .any(|u| u["in"]["kind"] == kind),
            "{kind}: {graph}"
        );
    }
    let (_, downstream) = request(
        &a,
        "GET",
        &format!("/v1/lineage/columns?dataset={source}&column=id&direction=downstream"),
        json!(null),
    )
    .await;
    assert_eq!(
        downstream["nodes"].as_array().unwrap().len(),
        3,
        "{downstream}"
    );
    let (_, zero) = request(&a, "GET", &format!("{endpoint}&depth=0"), json!(null)).await;
    assert_eq!(zero["nodes"].as_array().unwrap().len(), 1);
    let role = access_role(&a, "column reader").await;
    access_grant(&a, &role, "source", "straton-models", "read").await;
    let (_, token) = access_user(&a, "column reader", &[&role]).await;
    let (_, hidden) = request_as(&a, &token, "GET", &endpoint, json!(null)).await;
    assert!(
        hidden["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["dataset_id"] != source),
        "{hidden}"
    );
    assert_eq!(
        request_as(
            &a,
            &token,
            "GET",
            &format!("/v1/lineage/columns?dataset={source}&column=id"),
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    access_grant(&a, &role, "dataset", &source, "read").await;
    request(
        &a,
        "PUT",
        &format!("/v1/datasets/{source}/masks/{role}/id"),
        json!({"kind":"null"}),
    )
    .await;
    let (_, masked) = request_as(&a, &token, "GET", &endpoint, json!(null)).await;
    assert_eq!(masked["nodes"].as_array().unwrap().len(), 3, "{masked}");
    assert!(
        masked["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["expression"].is_null()),
        "{masked}"
    );
    let (_, admin) = request(&a, "GET", &endpoint, json!(null)).await;
    assert!(
        admin["edges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["expression"].is_string())
    );
    sqlx::query("UPDATE datasets SET lineage_incomplete=1 WHERE id=?")
        .bind(&target)
        .execute(&f.pool)
        .await
        .unwrap();
    let (_, incomplete) = request(&a, "GET", &endpoint, json!(null)).await;
    assert_eq!(incomplete["incomplete"], true);
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn column_lineage_view_discovery_persists_failure_without_guessing() {
    let f = Fixture::new().await;
    let mut table = straton_core::DatasetSchema {
        dataset: straton_core::Dataset {
            id: String::new(),
            source_id: "source".into(),
            name: "dbo.orders".into(),
        },
        columns: vec![straton_core::Column {
            id: String::new(),
            dataset_id: String::new(),
            name: "amount".into(),
            data_type: "Int64".into(),
            nullable: false,
            primary_key: false,
        }],
        relationships: vec![],
        metadata: Default::default(),
    };
    let mut view = table.clone();
    view.dataset.name = "dbo.totals".into();
    view.columns[0].name = "total".into();
    view.metadata.is_view = true;
    view.metadata.definition =
        Some("CREATE VIEW dbo.totals ([total]) AS SELECT amount FROM dbo.orders".into());
    let mut tx = f.pool.begin().await.unwrap();
    let mut ids = std::collections::BTreeMap::new();
    for schema in [&table, &view] {
        ids.insert(
            schema.dataset.name.clone(),
            crate::catalog::upsert(&mut tx, "source", schema)
                .await
                .unwrap(),
        );
    }
    let schemas = vec![table.clone(), view.clone()];
    crate::column_lineage::discover_views(&mut tx, &schemas, &ids)
        .await
        .unwrap();
    let rows = sqlx::query("SELECT * FROM column_lineage WHERE target_dataset_id=?")
        .bind(&ids["dbo.totals"])
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<&str, _>("target_column"), "total");
    assert_eq!(rows[0].get::<&str, _>("kind"), "rename");
    assert_eq!(rows[0].get::<&str, _>("view_dataset_id"), ids["dbo.totals"]);
    table.metadata.definition = None;
    view.metadata.definition = Some("CREATE VIEW dbo.totals AS SELECT mystery FROM missing".into());
    crate::column_lineage::discover_views(&mut tx, &[table, view], &ids)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM column_lineage WHERE target_dataset_id=?"
        )
        .bind(&ids["dbo.totals"])
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        0
    );
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT lineage_incomplete FROM datasets WHERE id=?")
            .bind(&ids["dbo.totals"])
            .fetch_one(&mut *tx)
            .await
            .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM relationships WHERE kind='lineage' AND to_dataset=?"
        )
        .bind(&ids["dbo.totals"])
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        1
    );
    tx.commit().await.unwrap();
    f.close().await;
}

#[path = "optimizer_tests.rs"]
mod optimizer_tests;

#[tokio::test]
async fn mysql_view_fallback_and_mongo_sample_metadata() {
    use straton_core::{
        Column, Dataset, DatasetMetadata, DatasetSchema, Relationship, RelationshipKind,
    };
    let f = Fixture::new().await;
    let make = |name: &str, definition: Option<&str>| DatasetSchema {
        dataset: Dataset {
            id: String::new(),
            source_id: "source".into(),
            name: name.into(),
        },
        columns: vec![Column {
            id: String::new(),
            dataset_id: String::new(),
            name: "id".into(),
            data_type: "Int64".into(),
            nullable: false,
            primary_key: true,
        }],
        relationships: vec![],
        metadata: DatasetMetadata {
            is_view: definition.is_some(),
            definition: definition.map(str::to_owned),
            dialect: Some("mysql".into()),
            ..Default::default()
        },
    };
    let schemas = vec![
        make("db.orders", None),
        make(
            "db.direct",
            Some("CREATE VIEW db.direct AS SELECT id FROM db.orders"),
        ),
        make(
            "db.complex",
            Some(
                "CREATE VIEW db.complex AS SELECT unsupported_source_function(id) AS id FROM db.orders",
            ),
        ),
    ];
    let mut tx = f.pool.begin().await.unwrap();
    let mut ids = std::collections::BTreeMap::new();
    for ds in &schemas {
        ids.insert(
            ds.dataset.name.clone(),
            crate::catalog::upsert(&mut tx, "source", ds).await.unwrap(),
        );
    }
    crate::column_lineage::discover_views(&mut tx, &schemas, &ids)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT lineage_incomplete FROM datasets WHERE id=?")
            .bind(&ids["db.direct"])
            .fetch_one(&f.pool)
            .await
            .unwrap()
    );
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT lineage_incomplete FROM datasets WHERE id=?")
            .bind(&ids["db.complex"])
            .fetch_one(&f.pool)
            .await
            .unwrap()
    );
    assert!(sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM relationships WHERE from_dataset=? AND to_dataset=? AND kind='lineage')").bind(&ids["db.orders"]).bind(&ids["db.complex"]).fetch_one(&f.pool).await.unwrap());
    sqlx::query("UPDATE sources SET kind='mongodb' WHERE id='source'")
        .execute(&f.pool)
        .await
        .unwrap();
    let mut ds = make("users", None);
    ds.metadata.dialect = Some("mongodb".into());
    ds.metadata.sampled_documents = Some(2);
    ds.metadata.field_coverage.insert("id".into(), 1);
    let mut tx = f.pool.begin().await.unwrap();
    let users = crate::catalog::upsert(&mut tx, "source", &ds)
        .await
        .unwrap();
    crate::catalog::edge(
        &mut tx,
        &Relationship {
            id: String::new(),
            from_dataset: users.clone(),
            from_cols: vec!["id".into()],
            to_dataset: ids["db.orders"].clone(),
            to_cols: vec!["id".into()],
            kind: RelationshipKind::Inferred,
            confidence: Some(0.45),
        },
    )
    .await
    .unwrap();
    crate::catalog::infer(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    let map = crate::catalog::datamap(&f.pool).await.unwrap();
    let node = map["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == users)
        .unwrap();
    assert_eq!(node["sampled_documents"], 2);
    assert_eq!(node["field_coverage"]["id"], 1);
    assert!(
        map["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["from_dataset"] == users && e["confidence"] == 0.45)
    );
    f.close().await;
}

#[path = "column_view_tests.rs"]
mod column_view_tests;

#[tokio::test]
async fn scoped_source_admins_cannot_repoint_sources_and_engine_files_are_off_limits() {
    let f = Fixture::new().await;
    let a = app(&f);
    let outside = std::env::temp_dir().join(format!("straton-outside-{}.db", store::id()));
    let state_db = f.dir.join("state.db");
    // Even a global admin cannot point a file source at the engine's own state.
    for path in [
        state_db.to_string_lossy().into_owned(),
        f.dir.join("backups/x.db").to_string_lossy().into_owned(),
        f.dir.join("sub/../state.db").to_string_lossy().into_owned(),
    ] {
        let (s, r) = request(
            &a,
            "POST",
            "/v1/sources",
            json!({"name":"Engine","kind":"sqlite","config":{"path":path}}),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{path}: {r}");
    }
    let (s, src) = request(
        &a,
        "POST",
        "/v1/sources",
        json!({"name":"App","kind":"sqlite","config":{"path":outside.to_string_lossy()}}),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "{src}");
    let id = src["id"].as_str().unwrap().to_owned();
    let role = access_role(&a, "owner").await;
    access_grant(&a, &role, "source", &id, "admin").await;
    let (_, token) = access_user(&a, "owner", &[&role]).await;
    let path = format!("/v1/sources/{id}");
    // Repointing the connection (or changing its kind) needs a global admin.
    for body in [
        json!({"name":"App","kind":"sqlite","config":{"path":"/tmp/elsewhere.db"}}),
        json!({"name":"App","kind":"csv","config":{"path":outside.to_string_lossy()}}),
    ] {
        let (s, r) = request_as(&a, &token, "PUT", &path, body).await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{r}");
    }
    // Renaming and tuning stay available to the scoped owner.
    let (s, r) = request_as(
        &a,
        &token,
        "PUT",
        &path,
        json!({"name":"Renamed","kind":"sqlite","config":{"path":outside.to_string_lossy(),"batch_size":500}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["name"], "Renamed");
    // A global admin can still repoint it.
    let (s, r) = request(
        &a,
        "PUT",
        &path,
        json!({"name":"Renamed","kind":"sqlite","config":{"path":"/tmp/elsewhere.db"}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    f.close().await;
}

#[tokio::test]
async fn explorer_profile_summarises_columns_and_export_is_capped() {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let body = json!({"schema":"app_db","table":"users"});
    let (s, v) = request(&a, "POST", "/v1/explorer/profile", body.clone()).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], 2);
    let id = v["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "id")
        .unwrap();
    assert_eq!(id["nulls"], 0);
    assert_eq!(id["non_null"], 2);
    assert_eq!(id["approx_distinct"], 2);
    assert_eq!(id["min"], 1);
    assert_eq!(id["max"], 2);
    let name = v["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "name")
        .unwrap();
    assert_eq!(name["min"], "Alice");
    assert_eq!(name["max"], "Bob");
    // Filters narrow the profile exactly like /rows.
    let (s, v) = request(
        &a,
        "POST",
        "/v1/explorer/profile",
        json!({"schema":"app_db","table":"users","columns":["id"],"filters":[{"column":"id","op":"gt","value":"1"}]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], 1);
    assert_eq!(v["columns"].as_array().unwrap().len(), 1);
    for patch in [
        json!({"limit":10}),
        json!({"sort":[{"column":"id","dir":"asc"}]}),
        json!({"table":"missing"}),
        json!({"columns":["missing"]}),
    ] {
        let mut q = body.clone();
        q.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let (s, v) = request(&a, "POST", "/v1/explorer/profile", q).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{patch}: {v}");
    }
    let mut q = explorer_body();
    q["format"] = json!("csv");
    q["max_rows"] = json!(1_000_001);
    assert_eq!(
        request(&a, "POST", "/v1/explorer/export", q).await.0,
        StatusCode::BAD_REQUEST
    );
    let audited: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE action='explorer.profile'")
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(audited, 2);
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn responses_carry_security_headers_including_errors() {
    let f = Fixture::new().await;
    let a = app(&f);
    for (uri, token) in [
        ("/health", None),
        ("/v1/status", Some("good-token")),
        ("/v1/status", Some("bad")),
    ] {
        let mut req = Request::builder().uri(uri);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let res = a
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let h = res.headers();
        assert_eq!(h["cache-control"], "no-store", "{uri}");
        assert_eq!(h["x-content-type-options"], "nosniff");
        assert_eq!(h["x-frame-options"], "DENY");
        assert_eq!(h["referrer-policy"], "no-referrer");
        assert!(h.contains_key("content-security-policy"));
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn admin_settings_report_effective_config_without_secret_paths() {
    let mut f = Fixture::new().await;
    f.config.tls_cert = Some("/secret/cert.pem".into());
    f.config.tls_key = Some("/secret/key.pem".into());
    f.config.network.allow_private = false;
    let a = app(&f);
    let (s, v) = request(&a, "GET", "/v1/admin/settings", json!(null)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["tls"], true);
    assert_eq!(v["network"]["allow_private"], false);
    assert_eq!(v["sql"]["max_rows"], f.config.sql.max_rows);
    assert_eq!(v["backup"]["keep"], 2);
    let text = v.to_string();
    for secret in ["/secret/", "cert.pem", "key.pem", "token", "good-token"] {
        assert!(!text.contains(secret), "settings leak {secret}: {text}");
    }
    drop(a);
    f.close().await;
}

#[tokio::test]
async fn startup_without_encryption_never_needs_the_keychain() {
    let f = Fixture::new().await;
    let kek = crate::keys::account(&f.pool, false);
    // Encryption off on a fresh engine: no KEK is created, nothing is recorded.
    crate::keys::startup(&f.pool, false).await.unwrap();
    assert!(crate::credentials::get(&kek).unwrap().is_none());
    let version: i64 = sqlx::query_scalar("SELECT kek_version FROM security_state WHERE id=1")
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(version, 0);
    // Data was encrypted earlier and the KEK is now gone (e.g. a reboot cleared the Linux
    // kernel keyring): the engine still starts; only encrypted reads are denied.
    crate::keys::startup(&f.pool, true).await.unwrap();
    crate::credentials::delete(&kek).unwrap();
    crate::keys::startup(&f.pool, false).await.unwrap();
    assert!(crate::keys::startup(&f.pool, true).await.is_err());
    f.close().await;
}

#[tokio::test]
async fn review_custom_sql_validation_runs_as_caller_chart_sql_is_audited_and_last4_hides_short_values()
 {
    let f = sql_fixture().await;
    sql_sync(&f).await;
    let a = app(&f);
    let did = dataset_id(&f, "users").await;

    // A user without any grant probes an unreadable table through quality-check validation.
    // Planning as an admin used to answer "No field named nope. Valid fields are ...".
    let nobody = access_role(&a, "nobody").await;
    let (_, nobody_token) = access_user(&a, "nobody", &[&nobody]).await;
    let probe = |sql: &str| json!({"name":"Probe","kind":"custom_sql","config":{"sql":sql},"severity":"warn"});
    let (s, v) = request_as(
        &a,
        &nobody_token,
        "POST",
        "/v1/quality/checks",
        probe("SELECT nope FROM app_db.users"),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let message = v["error"].as_str().unwrap();
    assert!(!message.contains("Valid fields"), "{message}");
    assert!(!message.contains("users.name"), "{message}");
    let (_, missing) = request_as(
        &a,
        &nobody_token,
        "POST",
        "/v1/quality/checks",
        probe("SELECT nope FROM app_db.no_such_table"),
    )
    .await;
    // An unreadable table and a missing one are indistinguishable.
    assert_eq!(
        message.replace("users", "no_such_table"),
        missing["error"].as_str().unwrap()
    );

    // Chart SQL is audited like the SQL endpoint: one row per query, hash only.
    let reader = access_role(&a, "reader").await;
    access_grant(&a, &reader, "dataset", &did, "read").await;
    let (uid, token) = access_user(&a, "reader", &[&reader]).await;
    let query = "SELECT id, name FROM app_db.users ORDER BY id";
    let (s, v) = request_as(
        &a,
        &token,
        "POST",
        "/v1/charts/preview",
        json!({"sql":query,"config":{"x":"id","y":["id"]}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM audit_log WHERE action='sql.query' AND principal_id=? ORDER BY id DESC LIMIT 1",
    )
    .bind(&uid)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(!detail.contains("SELECT"), "{detail}");
    let detail: serde_json::Value = serde_json::from_str(&detail).unwrap();
    assert_eq!(detail["via"], "chart");
    assert_eq!(detail["row_count"], 2);
    assert!(
        detail["datasets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d.as_str().unwrap().contains("users"))
    );
    let (s, _) = request_as(
        &a,
        &token,
        "POST",
        "/v1/charts/preview",
        json!({"sql":"DELETE FROM app_db.users","config":{"x":"id","y":["id"]}}),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let rejected: serde_json::Value = serde_json::from_str(
        &sqlx::query_scalar::<_, String>(
            "SELECT detail FROM audit_log WHERE action='sql.rejected' AND principal_id=? ORDER BY id DESC LIMIT 1",
        )
        .bind(&uid)
        .fetch_one(&f.pool)
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(rejected["via"], "chart");

    // last4 must not reveal a value of four characters or fewer in full.
    let (s, e) = request(
        &a,
        "PUT",
        &format!("/v1/datasets/{did}/masks/{reader}/name"),
        json!({"kind":"last4"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{e}");
    let (s, v) = request_as(
        &a,
        &token,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT name FROM app_db.users ORDER BY id"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["rows"], json!([["****lice"], ["****"]]));
    f.close().await;
}

#[tokio::test]
async fn review_pgwire_drops_clients_that_do_not_authenticate_in_time() {
    use sqlx::{
        Connection, Executor, PgConnection,
        postgres::{PgConnectOptions, PgSslMode},
    };
    use tokio::io::AsyncReadExt;
    let mut f = sql_fixture().await;
    sql_sync(&f).await;
    f.config.sql.bind = "127.0.0.1:0".parse().unwrap();
    let service = crate::sql::Sql::new(f.pool.clone(), &f.config).unwrap();
    let mut server = crate::sql::wire::Server::start(
        service,
        Arc::new("good-token".to_owned().into()),
        &f.config,
    )
    .await
    .unwrap();
    let port = server.address.unwrap().port();
    // An idle socket that never sends a startup message is closed after the deadline.
    let mut idle = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    let started = Instant::now();
    let mut buf = [0u8; 16];
    let read = tokio::time::timeout(Duration::from_secs(10), idle.read(&mut buf))
        .await
        .expect("idle client was not dropped");
    assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    assert!(started.elapsed() >= Duration::from_millis(1500));
    // An authenticated session outlives the deadline.
    let options = PgConnectOptions::new()
        .host("127.0.0.1")
        .port(port)
        .username("admin")
        .database("straton")
        .password("good-token")
        .ssl_mode(PgSslMode::Disable);
    let mut conn = PgConnection::connect_with(&options).await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let rows = conn.fetch_all("SELECT id FROM app_db.users").await.unwrap();
    assert_eq!(rows.len(), 2);
    conn.close().await.unwrap();
    server.shutdown().await;
    f.close().await;
}

#[tokio::test]
async fn review_repeated_failed_credentials_are_counted_audited_and_alerted_once() {
    let f = Fixture::new().await;
    let a = app(&f);
    let peer: std::net::SocketAddr = "198.51.100.23:40000".parse().unwrap();
    let attempt = |token: &str| {
        let mut req = Request::builder()
            .method("GET")
            .uri("/v1/me")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        req.extensions_mut()
            .insert(axum::extract::ConnectInfo(peer));
        a.clone().oneshot(req)
    };
    for _ in 0..crate::auth_failures::THRESHOLD + 3 {
        assert_eq!(
            attempt("stn_not_a_token").await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
    // Failures never lock the address out: a valid token from it still works.
    assert_eq!(
        attempt("good-token").await.unwrap().status(),
        StatusCode::OK
    );
    let alerts: Vec<String> =
        sqlx::query_scalar("SELECT detail FROM audit_log WHERE action='auth.failures'")
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(alerts.len(), 1, "one alert per address per window");
    let alert: serde_json::Value = serde_json::from_str(&alerts[0]).unwrap();
    assert_eq!(alert["address"], "198.51.100.23");
    assert_eq!(alert["surface"], "http");
    assert!(!alerts[0].contains("stn_not_a_token"));
    let notices: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notifications WHERE kind='auth.failures' AND user_id IS NULL",
    )
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(notices, 1);
    let (s, v) = request(&a, "GET", "/v1/admin/auth-failures", json!(null)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["addresses"][0]["address"], "198.51.100.23");
    assert_eq!(
        v["addresses"][0]["failures"],
        crate::auth_failures::THRESHOLD + 3
    );
    // Non-admins cannot see who is failing to sign in.
    let reader = access_role(&a, "reader").await;
    let (_, token) = access_user(&a, "reader", &[&reader]).await;
    let (s, _) = request_as(&a, &token, "GET", "/v1/admin/auth-failures", json!(null)).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    f.close().await;
}
