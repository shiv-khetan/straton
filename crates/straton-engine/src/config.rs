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
        self.backup
            .cron
            .parse::<cron::Schedule>()
            .context("backup.cron")?;
        Ok(())
    }
}
