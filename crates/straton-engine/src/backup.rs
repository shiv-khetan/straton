use crate::{config::Config, security, store};
use anyhow::{Result, ensure};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Backups {
    config: Config,
    gate: Arc<Mutex<()>>,
}
impl Backups {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            gate: Arc::new(Mutex::new(())),
        }
    }
    pub fn data_dir(&self) -> &Path {
        &self.config.data_dir
    }
    pub async fn list(&self) -> Result<Vec<PathBuf>> {
        let dir = &self.config.backup.dir;
        tokio::fs::create_dir_all(dir).await?;
        let mut entries = tokio::fs::read_dir(dir).await?;
        let mut paths = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("straton-")
                && name.ends_with(".db")
                && entry.file_type().await?.is_file()
            {
                paths.push(entry.path());
            }
        }
        paths.sort();
        paths.reverse();
        Ok(paths)
    }
    pub async fn create(&self, pool: &sqlx::SqlitePool) -> Result<PathBuf> {
        let _guard = self.gate.lock().await;
        tokio::fs::create_dir_all(&self.config.backup.dir).await?;
        let path = self.config.backup.dir.join(format!(
            "straton-{}-{}.db",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%fZ"),
            store::id()
        ));
        let staging = path.with_extension("partial");
        if let Err(e) = sqlx::query("VACUUM INTO ?")
            .bind(staging.to_string_lossy().as_ref())
            .execute(pool)
            .await
        {
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(e.into());
        }
        tokio::fs::rename(&staging, &path).await?;
        for old in self.list().await?.into_iter().skip(self.config.backup.keep) {
            tokio::fs::remove_file(old).await?;
        }
        let mut tx = pool.begin().await?;
        store::audit(&mut tx, "backup.created", &path.to_string_lossy(), "").await?;
        tx.commit().await?;
        Ok(path)
    }
}
pub async fn restore(config: &Config, file: &Path) -> Result<()> {
    let _lock = security::lock(&config.data_dir)?;
    let target = config.data_dir.join("state.db");
    ensure!(
        tokio::fs::canonicalize(file).await?
            != tokio::fs::canonicalize(&target)
                .await
                .unwrap_or(target.clone()),
        "cannot restore database onto itself"
    );
    let staging = config.data_dir.join(format!("restore-{}.db", store::id()));
    tokio::fs::copy(file, &staging).await?;
    let result = async {
        let mut snapshot = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&staging).read_only(true)).await?;
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut snapshot).await?;
        ensure!(integrity == "ok", "snapshot integrity check failed");
        let tables: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('sources','datasets','columns','relationships','jobs','runs','run_checkpoints','audit_log')").fetch_one(&mut snapshot).await?;
        ensure!(tables == 8, "not a Straton snapshot");
        snapshot.close().await?;
        // Checkpoint and close the old DB before replacing it: no stale WAL can replay.
        if target.exists() {
            let mut old = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&target)).await?;
            sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut old).await?;
            old.close().await?;
        }
        tokio::fs::rename(&staging, &target).await?;
        Ok::<_, anyhow::Error>(())
    }.await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(staging).await;
    }
    result
}
