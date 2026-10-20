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
    sqlx::query("UPDATE jobs SET cron='* * * * * *',last_scheduled=?")
        .bind(store::now() - 86400)
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
