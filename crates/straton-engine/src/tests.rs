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
    assert_eq!(scheduler::tick(&f.pool).await.unwrap().len(), 1);
    assert!(scheduler::tick(&f.pool).await.unwrap().is_empty());
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
        token: Arc::new("good-token".to_string().into()),
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
        token: Arc::new("good-token".to_string().into()),
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
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer good-token")
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
        json!({"name":"id","type":"Int64","nullable":false,"pk":true})
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
    let f = Fixture::new().await;
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
    let mut stream = c.read("users", None).await.unwrap();
    use futures::StreamExt;
    let (batch, cursor) = stream.next().await.unwrap().unwrap();
    let output = f.dir.join("data/source/users");
    let staging = output.join(format!(".staging-{id}"));
    straton_connectors::write_parquet(&staging.join("part-000000.parquet"), &batch).unwrap();
    runner::checkpoint(&f.pool, &id, &cursor).await.unwrap();
    let (batch, _) = stream.next().await.unwrap().unwrap();
    straton_connectors::write_parquet(&staging.join("part-000001.parquet"), &batch).unwrap();
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
            .any(|t| t["schema"] == "local_lake" && t["name"] == "source/users")
    );
    let (status, lake) = request(
        &a,
        "POST",
        "/v1/sql",
        json!({"query":"SELECT id,name FROM local_lake.\"source/users\" ORDER BY id"}),
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
    assert_eq!(detail["principal"], "engine-token");
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
        .username("any-user")
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
