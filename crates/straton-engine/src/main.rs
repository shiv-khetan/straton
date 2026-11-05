mod access;
mod advisor;
mod api;
#[cfg(test)]
mod api_contract_tests;
mod auth_failures;
mod backup;
mod catalog;
mod column_lineage;
mod config;
mod credentials;
mod egress;
mod hash_lookup;
mod keys;
mod lake_layout;
mod models;
mod notify;
mod openlineage;
mod optimizer;
mod pipeline;
mod policies;
mod profile;
mod quality;
mod query_stats;
mod runner;
mod scheduler;
mod security;
mod sql;
mod store;
#[cfg(test)]
mod tests;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tracing_subscriber::{EnvFilter, prelude::*};

#[derive(Parser)]
#[command(version, about = "Straton engine core")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    Run,
    Restore { file: PathBuf },
    Token,
    VerifyAudit,
}

fn main() -> Result<()> {
    // Owner-only by default for everything the engine creates: state.db and its WAL, logs,
    // snapshots, key sidecars and backups. Set before the runtime starts any thread.
    #[cfg(unix)]
    // SAFETY: umask only replaces the process file-mode mask and cannot fail.
    unsafe {
        libc::umask(0o077);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(engine())
}
async fn engine() -> Result<()> {
    let cli = Cli::parse();
    let config = config::Config::load()?;
    egress::set_allow_private(config.network.allow_private);
    match cli.command.unwrap_or(Command::Run) {
        Command::Token => {
            println!(
                "{}",
                std::path::absolute(config.data_dir.join("token"))?.display()
            );
            Ok(())
        }
        Command::Restore { file } => {
            backup::restore(&config, &file).await?;
            println!("restored {}", file.display());
            Ok(())
        }
        Command::VerifyAudit => {
            let _lock = security::lock(&config.data_dir)?;
            let pool = store::open(&config.data_dir).await?;
            let (events, _) = tokio::sync::broadcast::channel(256);
            let result = notify::verify_audit(&pool, &events).await?;
            println!("{}", serde_json::to_string(&result)?);
            pool.close().await;
            anyhow::ensure!(result.ok, "audit chain verification failed");
            Ok(())
        }
        Command::Run => run(config).await,
    }
}
async fn run(config: config::Config) -> Result<()> {
    let _lock = security::lock(&config.data_dir)?;
    let token = Arc::new(security::token(&config.data_dir)?);
    let (file, _guard) = tracing_appender::non_blocking(tracing_appender::rolling::daily(
        config.data_dir.join("logs"),
        "engine.log",
    ));
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file),
        )
        .init();
    for dir in [&config.data_dir, &config.backup.dir] {
        if let Some(mode) = security::shared_mode(dir) {
            tracing::warn!(dir=%dir.display(), mode=format!("{mode:o}"), "engine directory is readable by other users; run chmod 700 on it");
        }
    }
    let pool = store::open(&config.data_dir).await?;
    store::set_setting(&pool, "snapshot_keep", &config.snapshots.keep.to_string()).await?;
    lake_layout::recover_all(&config.data_dir)?;
    if let Some(dir) = &config.secrets.dir {
        credentials::use_directory(dir)?;
    }
    if credentials::store_kind() == "kernel-keyring" {
        tracing::warn!(
            "secrets and the KEK are in the Linux kernel keyring, which is lost on reboot; set [secrets] dir (STRATON_SECRETS_DIR) to keep them"
        );
    }
    keys::startup(&pool, config.encryption.enabled).await?;
    access::bootstrap(&pool, secrecy::ExposeSecret::expose_secret(token.as_ref())).await?;
    let (events, _) = tokio::sync::broadcast::channel(256);
    auth_failures::init(events.clone());
    let _lineage = openlineage::spawn(pool.clone(), &events, &config.lineage)?;
    notify::verify_audit(&pool, &events).await?;
    let backups = backup::Backups::new(config.clone());
    scheduler::seed_backup(&pool, &config.backup.cron).await?;
    advisor::recover(&pool).await?;
    pipeline::recover(&pool, &events).await?;
    runner::recover(&pool, &events, config.max_attempts).await?;
    let mut runner = runner::Runner::new(
        pool.clone(),
        events.clone(),
        backups.clone(),
        config.max_concurrent_runs,
    );
    let sql = sql::Sql::new(pool.clone(), &config)?;
    let mut sql_server = sql::wire::Server::start(sql.clone(), token.clone(), &config).await?;
    let router = api::router(api::App {
        pool: pool.clone(),
        sql: sql.clone(),
        events: events.clone(),
        backups,
        started: Instant::now(),
    });
    let handle = axum_server::Handle::new();
    let server_handle = handle.clone();
    let address = config.bind;
    let tls = match (config.tls_cert, config.tls_key) {
        (Some(cert), Some(key)) => {
            Some(axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?)
        }
        _ => None,
    };
    let mut server = tokio::spawn(async move {
        if let Some(tls) = tls {
            axum_server::bind_rustls(address, tls)
                .handle(server_handle)
                .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>())
                .await
        } else {
            axum_server::bind(address)
                .handle(server_handle)
                .serve(router.into_make_service_with_connect_info::<std::net::SocketAddr>())
                .await
        }
    });
    tracing::info!(%address,"engine started");
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let signal = shutdown();
    tokio::pin!(signal);
    let result = loop {
        tokio::select! {
            signal = &mut signal => { break signal; },
            result = &mut sql_server.task => { break match result { Ok(result) => result, Err(e) => Err(e.into()) }; },
            result = &mut server => { break match result { Ok(Ok(())) => Ok(()), Ok(Err(e)) => Err(e.into()), Err(e) => Err(e.into()) }; },
            _ = tick.tick() => {
                match scheduler::tick(&pool, &sql, &events).await {
                    Ok(ids) => for id in ids { runner::event(&events,&id,"queued"); },
                    Err(e) => tracing::error!(error=%e,"scheduler tick failed"),
                }
                if let Err(e)=runner.dispatch().await { tracing::error!(error=%e,"runner dispatch failed"); }
            }
        }
    };
    tracing::info!("stopping scheduling; draining runs");
    handle.graceful_shutdown(Some(Duration::from_secs(30)));
    tokio::join!(sql_server.shutdown(), runner.drain());
    if !server.is_finished() {
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut server).await;
    }
    result
}
async fn shutdown() -> Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate())?;
        tokio::select! { result=tokio::signal::ctrl_c()=>result?, _=term.recv()=>{} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
