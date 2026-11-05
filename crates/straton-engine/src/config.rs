use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub data_dir: PathBuf,
    pub bind: SocketAddr,
    pub max_concurrent_runs: usize,
    pub max_attempts: u32,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    pub backup: Backup,
    pub sql: Sql,
    pub encryption: Encryption,
    pub network: Network,
    pub secrets: Secrets,
    pub lineage: Lineage,
    pub snapshots: Snapshots,
}
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Backup {
    pub cron: String,
    pub dir: PathBuf,
    pub keep: usize,
}
impl Default for Backup {
    fn default() -> Self {
        Self {
            cron: "0 0 2 * * *".into(),
            dir: "data/backups".into(),
            keep: 7,
        }
    }
}
impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: "data".into(),
            bind: "127.0.0.1:8787".parse().unwrap(),
            max_concurrent_runs: 4,
            max_attempts: 3,
            tls_cert: None,
            tls_key: None,
            backup: Backup::default(),
            sql: Sql::default(),
            encryption: Encryption::default(),
            network: Network::default(),
            secrets: Secrets::default(),
            lineage: Lineage::default(),
            snapshots: Snapshots::default(),
        }
    }
}
impl Config {
    pub fn load() -> Result<Self> {
        let mut c: Self = match std::fs::read_to_string("straton.toml") {
            Ok(s) => toml::from_str(&s).context("straton.toml")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(e.into()),
        };
        for (key, value) in std::env::vars().filter(|(k, _)| k.starts_with("STRATON_")) {
            match key.as_str() {
                "STRATON_DATA_DIR" => c.data_dir = value.into(),
                "STRATON_BIND" => c.bind = value.parse().context("STRATON_BIND")?,
                "STRATON_MAX_CONCURRENT_RUNS" => c.max_concurrent_runs = value.parse()?,
                "STRATON_MAX_ATTEMPTS" => c.max_attempts = value.parse()?,
                "STRATON_TLS_CERT" => c.tls_cert = Some(value.into()),
                "STRATON_TLS_KEY" => c.tls_key = Some(value.into()),
                "STRATON_BACKUP_CRON" => c.backup.cron = value,
                "STRATON_BACKUP_DIR" => c.backup.dir = value.into(),
                "STRATON_BACKUP_KEEP" => c.backup.keep = value.parse()?,
                "STRATON_ENCRYPTION_ENABLED" => c.encryption.enabled = value.parse()?,
                "STRATON_NETWORK_ALLOW_PRIVATE" => c.network.allow_private = value.parse()?,
                "STRATON_SECRETS_DIR" => c.secrets.dir = Some(value.into()),
                "STRATON_SQL_ENABLED" => c.sql.enabled = value.parse()?,
                "STRATON_SQL_BIND" => c.sql.bind = value.parse()?,
                "STRATON_SQL_QUERY_TIMEOUT_SECS" => c.sql.query_timeout_secs = value.parse()?,
                "STRATON_SQL_MAX_ROWS" => c.sql.max_rows = value.parse()?,
                "STRATON_SQL_MEMORY_LIMIT_MB" => c.sql.memory_limit_mb = value.parse()?,
                "STRATON_LINEAGE_OPENLINEAGE_URL" => {
                    c.lineage.openlineage_url = Some(value).filter(|v| !v.is_empty())
                }
                "STRATON_LINEAGE_NAMESPACE" => c.lineage.namespace = value,
                "STRATON_SNAPSHOTS_KEEP" => c.snapshots.keep = value.parse()?,
                // Read by openlineage.rs at startup; a secret never lives in Config.
                "STRATON_OPENLINEAGE_API_KEY" => {}
                _ => anyhow::bail!("unknown environment setting {key}"),
            }
        }
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.max_concurrent_runs > 0,
            "max_concurrent_runs must be positive"
        );
        ensure!(self.max_attempts > 0, "max_attempts must be positive");
        ensure!(self.backup.keep > 0, "backup.keep must be positive");
        ensure!(
            self.tls_cert.is_some() == self.tls_key.is_some(),
            "TLS needs both cert and key"
        );
        ensure!(
            self.bind.ip().is_loopback() || self.tls_cert.is_some(),
            "non-loopback bind requires TLS"
        );
        ensure!(
            !self.sql.enabled || self.sql.bind.ip().is_loopback() || self.tls_cert.is_some(),
            "non-loopback SQL bind requires TLS"
        );
        ensure!(
            self.sql.query_timeout_secs > 0.0
                && std::time::Duration::try_from_secs_f64(self.sql.query_timeout_secs).is_ok(),
            "sql.query_timeout_secs must be positive and fit in a duration"
        );
        ensure!(self.sql.max_rows > 0, "sql.max_rows must be positive");
        ensure!(
            self.sql.memory_limit_mb > 0
                && self.sql.memory_limit_mb.checked_mul(1024 * 1024).is_some(),
            "sql.memory_limit_mb must be positive and fit in memory size"
        );
        self.backup
            .cron
            .parse::<cron::Schedule>()
            .context("backup.cron")?;
        if let Some(url) = &self.lineage.openlineage_url {
            crate::openlineage::endpoint(url).context("lineage.openlineage_url")?;
        }
        ensure!(
            !self.lineage.namespace.trim().is_empty() && self.lineage.namespace.len() <= 200,
            "lineage.namespace must be 1 to 200 characters"
        );
        ensure!(
            (1..=1000).contains(&self.snapshots.keep),
            "snapshots.keep must be between 1 and 1000"
        );
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sql {
    pub enabled: bool,
    pub bind: SocketAddr,
    pub query_timeout_secs: f64,
    pub max_rows: usize,
    pub memory_limit_mb: usize,
}
impl Default for Sql {
    fn default() -> Self {
        Self {
            enabled: true,
            bind: "127.0.0.1:5433".parse().unwrap(),
            query_timeout_secs: 60.0,
            max_rows: 100_000,
            memory_limit_mb: 1024,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Encryption {
    pub enabled: bool,
}
impl Default for Encryption {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// Outbound connector policy; see `egress.rs`.
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Network {
    /// Allow connectors to reach loopback and private ranges. Link-local and
    /// cloud-metadata addresses are always refused.
    pub allow_private: bool,
}
impl Default for Network {
    fn default() -> Self {
        Self {
            allow_private: true,
        }
    }
}

/// Where connector secrets and the KEK live; see `credentials.rs`.
#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Secrets {
    /// Owner-only secret files in this directory instead of the OS keychain. Required for a
    /// Linux engine that must survive a reboot: the kernel keyring is in-memory only.
    pub dir: Option<std::path::PathBuf>,
}

/// OpenLineage emission; see `openlineage.rs`. Off unless `openlineage_url` is set.
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Lineage {
    /// HTTP endpoint that accepts OpenLineage run events, e.g. Marquez's
    /// `http://marquez:5000/api/v1/lineage`. HTTPS, or HTTP to a loopback address.
    pub openlineage_url: Option<String>,
    /// Namespace for Straton's jobs and lake tables.
    pub namespace: String,
}
impl Default for Lineage {
    fn default() -> Self {
        Self {
            openlineage_url: None,
            namespace: "straton".into(),
        }
    }
}

/// Published snapshots kept per dataset; older ones stay readable for time travel
/// (`schema."table@<time>"` in SQL, the snapshot picker in Explorer).
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Snapshots {
    /// 1 keeps only the current snapshot.
    pub keep: usize,
}
impl Default for Snapshots {
    fn default() -> Self {
        Self { keep: 1 }
    }
}
