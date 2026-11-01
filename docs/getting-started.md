# Getting started

This guide runs the engine from source, issues your first query and connects the desktop app.

## Requirements

- [Rust](https://rustup.rs) (stable) for the engine.
- [Node.js](https://nodejs.org) 24 and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
  for your OS, only if you build the desktop app.
- Optional: `psql` or DBeaver to use the SQL endpoint.

## 1. Run the engine

=== "Linux / macOS"

    ```bash
    git clone https://github.com/shiv-khetan/straton.git
    cd straton
    cp straton.example.toml straton.toml
    # Linux: keep secrets across reboots (see Security)
    export STRATON_SECRETS_DIR="$PWD/data/secrets"
    cargo run --release -p straton-engine -- run
    ```

=== "Windows (PowerShell)"

    ```powershell
    git clone https://github.com/shiv-khetan/straton.git
    cd straton
    Copy-Item straton.example.toml straton.toml
    cargo run --release -p straton-engine -- run
    ```

The engine listens on `http://127.0.0.1:8787` (REST) and `127.0.0.1:5433` (SQL). On first
start it writes an admin token to `data/token`, readable only by your user.

!!! note "No OS keychain (containers, CI)"
    Encryption at rest needs a key store. Set `STRATON_SECRETS_DIR` to a private directory,
    or start with `STRATON_ENCRYPTION_ENABLED=false` for throwaway environments.

## 2. Make your first request

=== "Linux / macOS"

    ```bash
    TOKEN=$(cat data/token)
    curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/v1/status
    ```

=== "Windows (PowerShell)"

    ```powershell
    $headers = @{ Authorization = "Bearer $(Get-Content data/token -Raw)" }
    Invoke-RestMethod http://127.0.0.1:8787/v1/status -Headers $headers
    ```

## 3. Connect the desktop app

```bash
cd apps/desktop
npm ci
npm run tauri dev
```

Enter `http://127.0.0.1:8787` and paste the token from `data/token`. The app stores it in
your OS keychain. Then open **Connections → New source**, run **Check** and **Discover**, and
create a job under **Orchestration**.

## 4. Query with SQL

```bash
psql "host=127.0.0.1 port=5433 user=admin dbname=straton sslmode=disable"
# Password: the engine token
```

```sql
SELECT * FROM "app_database"."users" LIMIT 20;
```

## Reference: engine commands and REST walkthrough

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

Settings override TOML via `STRATON_DATA_DIR`, `STRATON_BIND`, `STRATON_MAX_CONCURRENT_RUNS`, `STRATON_MAX_ATTEMPTS`, `STRATON_TLS_CERT`, `STRATON_TLS_KEY`, `STRATON_BACKUP_CRON`, `STRATON_BACKUP_DIR`, `STRATON_BACKUP_KEEP`, `STRATON_NETWORK_ALLOW_PRIVATE` and `STRATON_SECRETS_DIR`. **On Linux, set `STRATON_SECRETS_DIR` (or `[secrets] dir`)**: the default kernel keyring is lost on reboot, taking the KEK and connector secrets with it (see SECURITY.md). Paths are relative to the process working directory; set the backup directory explicitly if changing the data directory. Unknown settings and invalid cron expressions fail startup. Cron uses UTC and a seconds field, e.g. `0 */5 * * * *`. Missed schedules produce one catch-up run per job. A newly created job starts scheduling from its creation time. Manual jobs have `cron = null` in JSON. Crash recovery retains checkpoints, retries up to three attempts by default, and waits 1, 2, 4, … seconds (capped at 1024 seconds). Failures and panics are recorded as failed; crash interruptions alone are retried.

Non-loopback binding requires both TLS PEM certificate/key settings. A lock prevents concurrent engines and restore while running. Ctrl-C (or SIGTERM on Unix) stops scheduling and drains workers for up to 30 seconds.

Backups run daily at 02:00 UTC by default, retaining the newest seven snapshots. `POST /v1/backups` creates a snapshot now; `GET /v1/backups` lists them newest first. Stop the engine, then restore using the same working directory/configuration:

```powershell
cargo run --offline -p straton-engine -- restore data/backups/<snapshot.db>
```

Restore validates the SQLite snapshot and replaces state; it restores users and token hashes in state.db, but does not restore the bootstrap token file, configuration or logs. See [Deployment](operations/deployment.md).

Verification: `cargo fmt --all -- --check`, `cargo clippy --offline --workspace --all-targets -- -D warnings`, `cargo test --offline --workspace`.