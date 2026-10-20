# Straton

**Status:** v1 in progress

## Vision

An open-source, self-hosted, Rust-based data platform for data and ML engineers: fast, secure, and simpler to operate. It would cover the core data-platform capabilities associated with Databricks while remaining configurable rather than including a built-in natural-language assistant.

## Capabilities

- Connect, sync, and transform data across SaaS, CRM, ERP, and developer tools: Salesforce, SAP, Stripe/payment platforms, ServiceNow, Jira, Confluence, Cornerstone, and more.
- SQL endpoint/server for remote clients; RBAC for multiple users.
- An access-control and metadata layer—working name: **Access Control Manager**—similar in purpose to a catalog, but independently designed.
- Data engineering and ML-engineering workloads.
- Federated computation: plan work close to data sources where appropriate, minimizing data movement.
- Optimize user-defined logic across a pipeline. Example: detect compensating transformations such as `+1` before a sync and `-1` at the destination, then eliminate unnecessary work while preserving semantics.

## Security baseline

- Secure-by-default configuration; explicit trust boundaries for users, connectors, and workloads.
- Encryption in transit (TLS; mutual TLS for service-to-service paths where appropriate) and encryption at rest with managed keys/key rotation.
- Strong identity integration, least-privilege RBAC, scoped connector credentials, and no secrets in logs or configuration files.
- Immutable audit logs for access, policy changes, queries, and data movement.
- Tenant/workload isolation, query limits, safe handling of untrusted expressions, and tested backup/restore procedures.
- Signed releases, dependency/SBOM scanning, timely patching, threat modeling, and security testing guided by [OWASP Top 10](https://owasp.org/projects/top-ten) and [OWASP ASVS](https://owasp.org/projects/asvs).

## Scope decision

Do **not** attempt full Databricks parity in v1. Start with one sharp wedge: self-hosted connector sync plus optimized transformations and policy-aware SQL access. Expand only after that workflow is reliable.

## Open questions

- Which connector and workload are the first target?
- What execution/storage architecture best serves the first use case?
- Which optimizations are provably safe, explainable, and reversible?
- Which enterprise security/compliance requirements matter first?

## Running the engine

Phase 1 provides the engine core and a deterministic noop connector. Real connectors, catalog discovery, Parquet sync and the desktop UI belong to later phases.

```powershell
Copy-Item straton.example.toml straton.toml
cargo run -p straton-engine -- run
# Equivalent default command:
cargo run -p straton-engine
cargo run -p straton-engine -- token
```

Default address: `http://127.0.0.1:8787`. `GET /health` is public. Every `/v1` route, including WebSocket upgrades, requires `Authorization: Bearer <token>`. The engine creates `data/token` on first start with user-only permissions; the `token` command prints its absolute path, never the secret. Keep the token private. `state.db`, the lock and daily rolling logs live in the data directory. Stdout also receives logs; `RUST_LOG` controls filtering.

```powershell
$token = Get-Content data/token -Raw
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod http://127.0.0.1:8787/v1/status -Headers $headers
$source = @{ name="Example"; kind="noop"; credential_id=$null } | ConvertTo-Json
$s = Invoke-RestMethod http://127.0.0.1:8787/v1/sources -Method Post -Headers $headers -ContentType application/json -Body $source
$job = @{ name="Example"; source_id=$s.id; dataset="example"; cron=$null; enabled=$true } | ConvertTo-Json
$j = Invoke-RestMethod http://127.0.0.1:8787/v1/jobs -Method Post -Headers $headers -ContentType application/json -Body $job
Invoke-RestMethod "http://127.0.0.1:8787/v1/jobs/$($j.id)/run" -Method Post -Headers $headers
Invoke-RestMethod http://127.0.0.1:8787/v1/runs -Headers $headers
```

Source/job collections accept POST and GET; individual IDs accept GET, PUT and DELETE. IDs may be omitted on creation. PUT uses the path ID. Sources contain only a credential reference, never connection secrets. Referenced sources/jobs cannot be deleted (409); run history is retained. The built-in backup job is configured through TOML. `GET /v1/runs?job=<id>&state=failed` filters history; `POST /v1/runs/<id>/cancel` requests cancellation at a batch boundary. `GET /v1/events` streams run states; reconnecting or receiving `resync_required` means clients should refresh run history.

Settings override TOML via `STRATON_DATA_DIR`, `STRATON_BIND`, `STRATON_MAX_CONCURRENT_RUNS`, `STRATON_MAX_ATTEMPTS`, `STRATON_TLS_CERT`, `STRATON_TLS_KEY`, `STRATON_BACKUP_CRON`, `STRATON_BACKUP_DIR`, and `STRATON_BACKUP_KEEP`. Paths are relative to the process working directory; set the backup directory explicitly if changing the data directory. Unknown settings and invalid cron expressions fail startup. Cron uses UTC and a seconds field, e.g. `0 */5 * * * *`. Missed schedules produce one catch-up run per job. A newly created job starts scheduling from its creation time. Manual jobs have `cron = null` in JSON. Crash recovery retains checkpoints, retries up to three attempts by default, and waits 1, 2, 4, … seconds (capped at 1024 seconds). Failures and panics are recorded as failed; crash interruptions alone are retried.

Non-loopback binding requires both TLS PEM certificate/key settings. A lock prevents concurrent engines and restore while running. Ctrl-C (or SIGTERM on Unix) stops scheduling and drains workers for up to 30 seconds.

Backups run daily at 02:00 UTC by default, retaining the newest seven snapshots. `POST /v1/backups` creates a snapshot now; `GET /v1/backups` lists them newest first. Stop the engine, then restore using the same working directory/configuration:

```powershell
cargo run -p straton-engine -- restore data/backups/<snapshot.db>
```

Restore validates the SQLite snapshot and replaces state; it does not restore tokens, configuration or logs. See [systemd unit](deploy/straton-engine.service) and [Windows service notes](deploy/windows-service.md).

Verification: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
