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

The engine supports Postgres, SQLite and CSV discovery and Parquet sync. The noop connector remains available for tests; the desktop UI is available below.

```powershell
Copy-Item straton.example.toml straton.toml
cargo run --offline -p straton-engine -- run
# Equivalent default command:
cargo run --offline -p straton-engine
cargo run --offline -p straton-engine -- token
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
cargo run --offline -p straton-engine -- restore data/backups/<snapshot.db>
```

Restore validates the SQLite snapshot and replaces state; it does not restore tokens, configuration or logs. See [systemd unit](deploy/straton-engine.service) and [Windows service notes](deploy/windows-service.md).

Verification: `cargo fmt --all -- --check`, `cargo clippy --offline --workspace --all-targets -- -D warnings`, `cargo test --offline --workspace`.

## Phase 2: connectors and catalog

Create a SQLite source, discover its catalog, then create and run a sync job:

```powershell
$base = "http://127.0.0.1:8787"
$body = @{ name="App database"; kind="sqlite"; config=@{ path="C:/data/app.db"; batch_size=10000 } } | ConvertTo-Json
$s = Invoke-RestMethod "$base/v1/sources" -Method Post -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod "$base/v1/sources/$($s.id)/check" -Method Post -Headers $headers
Invoke-RestMethod "$base/v1/sources/$($s.id)/discover" -Method Post -Headers $headers
$body = @{ name="Sync users"; source_id=$s.id; dataset="users"; cron=$null; enabled=$true } | ConvertTo-Json
$j = Invoke-RestMethod "$base/v1/jobs" -Method Post -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod "$base/v1/jobs/$($j.id)/run" -Method Post -Headers $headers
Invoke-RestMethod "$base/v1/datamap" -Headers $headers
```

For CSV use `kind="csv"` and `config={"path":"C:/data/csv","sample_size":1000,"batch_size":10000}`. Each `*.csv` file is a dataset named after its file stem. CSV files must have headers. For Postgres use `kind="postgres"`, `config={"host":"localhost","port":5432,"database":"app","username":"reader","batch_size":10000}`, and a top-level `secret` field containing the password. Dataset names are schema-qualified, e.g. `public.users`. Postgres sync requires a primary key, including composite keys; SQLite sync uses rowid (WITHOUT ROWID tables are discoverable but cannot be synced). Reads resume from the last committed cursor; a source must remain stable during a sync for a consistent snapshot.

Secrets are write-only on POST/PUT and stored in the OS keychain (service `straton`, account = source ID). Omit `secret` on updates to keep the current secret. Deleting an unreferenced source removes its secret. Config accepts only connector-specific connection fields and batch/sample sizes; URLs and embedded passwords are not accepted. GET responses include config and credential references, never secrets. Tests use an in-memory credential map.

Sync writes `<data_dir>/data/<source_id>/<dataset>/.staging-<run_id>/part-<batch:06>.parquet`. Each batch is flushed, fsynced and atomically renamed before its checkpoint commits. Recovery continues in the same staging directory and replaces any uncheckpointed part. A completed full-refresh snapshot is renamed to `<run_id>/`, then `_current` is atomically replaced with that run ID. Readers resolve `_current` and read only that snapshot. Failed or cancelled runs leave `_current` unchanged. Each successful publish removes older snapshots and abandoned staging directories, preserving work owned by queued/running runs. The auto-created `parquet` source “Local lake” receives destination datasets and lineage edges. Paths use literal dataset names; names invalid as Windows path components are rejected for sync.

Discovery updates datasets, columns and declared foreign keys in one transaction and recomputes inferred relationships across all sources. The WebSocket emits `catalog.changed`. Manual relationships survive discovery. A disappeared dataset referenced by a manual edge keeps its columns and is marked `stale: true` in the data map; its non-manual edges are removed. Discovery audit-logs this transition, and a reappearing dataset keeps its ID and clears stale. Unreferenced disappeared datasets are deleted.

Use `kind="external"` for disconnected placeholders. Add datasets with `POST /v1/sources/<id>/datasets` and body `{"name":"users","columns":[{"name":"id","type":"Int64","nullable":false,"pk":true}]}`. Create manual edges via `POST /v1/relationships` with `{"kind":"manual","from_dataset":"<id>","from_cols":["user_id"],"to_dataset":"<id>","to_cols":["id"],"confidence":null}`. Only manual edges can be deleted via `DELETE /v1/relationships/<id>`; other kinds return 409.

The optional Postgres integration test runs only when `STRATON_TEST_PG` contains a JSON connector configuration, with an optional `secret` field. It needs a reachable database and permission to create/drop a temporary test schema; the default offline suite skips it. No test accesses the real keychain.

## Desktop app

The Tauri 2 desktop client lives in `apps/desktop`; its Rust shell is an independent Cargo workspace. Dependencies must already be installed for offline development.

```powershell
cd apps/desktop
npm run tauri dev
```

Start the engine first. In Connect, enter `http://127.0.0.1:8787` (or a remote HTTPS engine URL) and paste the token from the engine’s `data/token`. Test and save stores the connection in the OS keychain under service `straton-desktop`. Forget connection removes that entry. Tokens are never placed in localStorage. Connector passwords are write-only and stored by the engine.

Discover sources to populate the Data Map. Drag between column handles to create manual relationships; select a manual edge and press Delete, or use Delete manual edge. Filters, dataset search, MiniMap, and Re-layout help navigate the catalog. Positions are saved locally per engine URL. Jobs use UTC cron with seconds first; blank schedules are manual. Run state activity updates over one reconnecting authenticated WebSocket. The current engine does not expose log streaming or historical log retrieval. Lineage edges are dataset-level in the API (empty column lists) and attach to table headers; column relationships attach to their named columns.

```powershell
npm run build
npm test
cd src-tauri
cargo clippy --offline --all-targets -- -D warnings
cargo build --offline
```
