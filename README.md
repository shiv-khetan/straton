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

Restore validates the SQLite snapshot and replaces state; it restores users and token hashes in state.db, but does not restore the bootstrap token file, configuration or logs. See [systemd unit](deploy/straton-engine.service) and [Windows service notes](deploy/windows-service.md).

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

## SQL endpoint

The read-only Postgres endpoint listens on `127.0.0.1:5433` by default. Log in with your user name and that user’s token as the password. The bootstrap user is `admin`, with the token from `data/token`. The database name is a client compatibility value.

```powershell
psql "host=127.0.0.1 port=5433 user=admin dbname=straton sslmode=disable"
# At the password prompt, paste the engine token.
```

In DBeaver, create a PostgreSQL connection with host `127.0.0.1`, port `5433`, database `straton`, user `admin` (or your assigned user name), and the token as password. JDBC prepared statements and both text and binary result formats are supported. Use schema-qualified names in the SQL editor. PostgreSQL-specific `pg_catalog` introspection is limited; the desktop table browser and `GET /v1/sql/tables` list only your visible tables with post-mask types. `information_schema` is disabled.

Source names become lowercase schemas, replacing non-ASCII-alphanumeric characters with `_` and prefixing digit-leading names with `_`. Collisions receive `_2`, `_3`, etc., in source-ID order; `public`, `information_schema`, and `pg_catalog` are reserved. Dataset names remain literal: query a Postgres dataset as `"app_database"."public.users"`. Local lake aliases use normalized source and dataset labels, for example `"local_lake"."app_database_users"`; consult the Data Map or `/v1/sql/tables` for exact names. Only datasets with a published `_current` snapshot appear. Each query resolves that pointer once and reads only its immediate Parquet files. Publication waits for active queries before replacing and deleting a snapshot.

```sql
SELECT * FROM "app_database"."users" LIMIT 20;
```

Configure `[sql]` in `straton.toml`: `enabled = true`, `bind = "127.0.0.1:5433"`, `query_timeout_secs = 60`, `max_rows = 100_000`, `memory_limit_mb = 1024`. Matching overrides are `STRATON_SQL_ENABLED`, `STRATON_SQL_BIND`, `STRATON_SQL_QUERY_TIMEOUT_SECS`, `STRATON_SQL_MAX_ROWS`, and `STRATON_SQL_MEMORY_LIMIT_MB`. Timeouts may be fractional seconds. A non-loopback SQL bind requires the existing `tls_cert` and `tls_key` PEM settings and refuses plaintext connections; configure the client to require and verify TLS. Disabling SQL disables the wire listener and SQL REST routes.

Each query uses an isolated DataFusion session and the shared, bounded DataFusion memory pool. Retained Arrow results are charged to that pool too; it does not cap total process RSS. Exceeding the row or memory limit returns an error, never a silently shortened result. The timeout covers catalog resolution, planning, and execution; dropping the execution stream cancels its work. Ctrl-C stops accepting connections and allows up to 30 seconds for SQL connections to drain.

DDL, DML, COPY (including COPY TO), session changes, multi-statement requests, and EXPLAIN ANALYZE are rejected. The wire endpoint has only these client compatibility exceptions: exact `SELECT version()` / `SELECT pg_catalog.version()`, `SELECT current_schema()` / `SELECT current_schema`, `SELECT current_database()`; SHOW for `server_version`, `server_version_num`, `transaction_read_only`, `default_transaction_read_only`, `standard_conforming_strings`, `client_encoding`, `TimeZone`, `DateStyle`, and `search_path`. Harmless SET acknowledgements cover `extra_float_digits` 2/3, UTF8 `client_encoding`, UTC timezone, ISO DateStyle, and `application_name`. These acknowledgements do not change session state. REST accepts only read-only queries and EXPLAIN.

The desktop **SQL** tab supports Ctrl/Cmd+Enter, Run, Explain, table insertion, and a scrollable results grid. Its REST API uses the normal bearer token:

- `POST /v1/sql` with `{"query":"SELECT 1","limit":1000}` returns `columns`, `rows`, total `row_count`, `truncated_preview`, and `elapsed_ms`. The optional preview limit is 0–1000, separate from the engine's hard row limit; the full query must pass all limits even for a small preview. Decimal, temporal, binary, and other non-JSON scalar types are returned as strings.
- `POST /v1/sql/explain` with `{"query":"SELECT 1"}` returns `logical` and `physical` plan strings without executing the query.
- `GET /v1/sql/tables` returns `{"tables":[{"schema":"app_database","name":"users","columns":[{"name":"id","type":"Int64"}]}]}`.

Successful and failed queries append `sql.query` audit records; forbidden statements append `sql.rejected`. Details contain the real user ID as principal, the SHA-256 hex digest of the original SQL text, datasets scanned, and row count or error class. Raw SQL and bound parameter values are never stored in the audit log. Extended-protocol parse failures are audited; successful preparation is audited when executed. Authorization and policies are re-evaluated for every REST request and pgwire statement.

## Access control

On startup the engine imports the existing `data/token` as the bootstrap token of user `admin`. It keeps the file with user-only permissions and stores only the token’s SHA-256 hash in SQLite. The built-in `admin` role has `is_admin=1`: this explicitly models global administration without adding a global grant target. Ordinary grants target a source or dataset; source grants include all datasets in that source, and target `admin` implies `read` and `sync_admin`. Source configuration and dataset policies accept matching target admin grants. Creating sources and global account, role, grant and backup administration require the built-in admin role. User deletion disables the account to retain audit history. The built-in user and role are protected from renaming, disabling, deletion and role reassignment; their tokens can be issued and revoked normally. Restarting does not reactivate a revoked bootstrap token. Issue a replacement admin token before revoking it.

The desktop sidebar shows the signed-in user. Administrators manage users, tokens, role grants, row filters and column masks under **System → Access**. Tokens are displayed once in a Sheet and are never saved to localStorage. The Data Map shows row-filter locks and masked-column badges; administrators can preview a role using **View as role**. This preview changes the map only; SQL continues to use the signed-in user’s permissions.

Use the bootstrap authorization header from the engine instructions above. For example, create a read role and user, grant a dataset, then issue a token:

```powershell
$base = "http://127.0.0.1:8787"
$headers = @{ Authorization = "Bearer $(Get-Content data/token -Raw)" }
function AccessApi($path, $body, $method = "Post") {
  Invoke-RestMethod "$base/v1/$path" -Method $method -Headers $headers -ContentType application/json -Body ($body | ConvertTo-Json -Depth 8)
}
$role = AccessApi "roles" @{ name="analyst" }
$user = AccessApi "users" @{ name="alice" }
AccessApi "users/$($user.id)/roles" @{ role_ids=@($role.id) } "Put"
$map = Invoke-RestMethod "$base/v1/datamap" -Headers $headers
$dataset = $map.nodes | Where-Object { $_.type -eq "dataset" -and $_.name -eq "users" } | Select-Object -First 1
AccessApi "grants" @{ role_id=$role.id; target_kind="dataset"; target_id=$dataset.id; privilege="read" }
$issued = AccessApi "users/$($user.id)/tokens" @{ name="BI client"; expires_at=$null }
# Copy $issued.token securely now. GET token lists never return the secret or its hash.
```

New tokens have `stn_` followed by 32 random bytes encoded as hex. Supply an optional Unix-second `expires_at`. List token metadata with `GET /v1/users/<user>/tokens`; revoke with `DELETE /v1/users/<user>/tokens/<token-id>`. Disabled users, expired tokens and revoked tokens cannot authenticate, including on the next statement of an existing SQL connection. `last_used_at` writes are throttled to once per minute. `GET /v1/me` returns the user, roles, and privilege summary. Read users cannot manage sources or jobs; `sync_admin` is required for jobs and runs on the granted source or dataset.

Policies attach to a dataset and role. Validate before saving; example predicate and mask:

```powershell
AccessApi "policies/validate" @{ dataset_id=$dataset.id; predicate="id >= 100 AND name IS NOT NULL" }
AccessApi "datasets/$($dataset.id)/row-filters/$($role.id)" @{ predicate="id >= 100 AND name IS NOT NULL" } "Put"
AccessApi "datasets/$($dataset.id)/masks/$($role.id)/name" @{ kind="redact" } "Put"
Invoke-RestMethod "$base/v1/datasets/$($dataset.id)/policies" -Headers $headers
# DELETE the same policy URL to remove a filter or mask.
```

Predicates allow only local columns, literals, comparisons, boolean and arithmetic operators, IN lists, LIKE, IS NULL, BETWEEN, CAST, and deterministic scalar functions. Subqueries, aggregates, window functions, volatile or time-dependent functions, variables, and other-table references are refused. Original predicate text is stored and revalidated against the query’s snapshot schema. An invalid stored predicate denies that role access to the dataset and records `policy.invalid`; it never grants unfiltered access.

Only read-granting roles participate in policies. Their row filters combine with **OR**; a read-granting role without a filter allows all rows. A column is masked only when **every** read-granting role masks it. If all mask it, the strictest kind wins: **null > redact > hash > last4**. `null` preserves the column type; `redact` produces `***`; `hash` produces SHA-256 hex of the value cast to UTF-8; `last4` prefixes its last four characters with `****`. Non-null masks produce UTF-8 columns. The built-in admin role grants global read access and initially has no filters or masks, so it is unrestricted by default. Policies attached to that role follow the same combination rules, including fail-closed validation. Local lake aliases require their own applicable grants; granting a source table does not expose a second raw alias.

Each SQL session registers only authorized views: current Parquet scan → row filter → mask projection. Raw tables are never registered. REST SQL previews, table listings and pgwire use the same enforcement. Datamap nodes and edges touching unreadable datasets are hidden; empty sources are hidden for non-administrators, and filtered datasets do not expose raw row counts. Non-admin event streams send refresh notifications without global run details. Administrative mutations and manual run requests record the real user ID in `audit_log.principal_id`; SQL audit details also identify that user. Tokens and token hashes never appear in audit details.

```powershell
psql "host=127.0.0.1 port=5433 dbname=straton user=alice sslmode=disable"
# At the password prompt, paste Alice’s token. The username and token owner must match.
```

## Incremental sync

Postgres and SQLite jobs can merge changes by watermark and key. Discover the dataset first, then POST this body to `/v1/jobs` (or use the desktop job sheet):

```json
{
  "name": "Incremental users",
  "source_id": "<source-id>",
  "dataset": "users",
  "cron": "0 */5 * * * *",
  "enabled": true,
  "mode": "incremental",
  "watermark_column": "updated_at",
  "key_columns": ["id"],
  "delete_detection": "key_diff",
  "key_diff_every_runs": 10
}
```

The watermark must be an integer, date or timestamp column in the catalog. Omit `key_columns` to use the catalog primary key, or supply an existing, unique, non-null key (including composite keys). Watermarks must be non-null and advance when rows change. SQLite DATE and TIMESTAMP/DATETIME columns should use consistent ISO date/time text. CSV supports full refresh only. Jobs default to `mode: "full"`.

The first incremental run performs a full load and seeds the maximum watermark. Later reads use the **inclusive** condition `watermark >= last`, paginated by (watermark, key...). Rows tied at the boundary are read again, including rows that arrived late with exactly that watermark. A key merge replaces previous versions with delta rows and writes a new snapshot, so re-reading a boundary does not duplicate rows. Changes with a watermark below the saved boundary are not detected.

Delta Parquet parts are staged under `.staging-<run>/delta/`, flushed and renamed before checkpointing. Recovery continues an unfinished read, or reruns the merge from the completed staged delta. At publication, one database transaction records the watermark, snapshot run ID, run statistics, dataset row count and last-sync time. Failed or cancelled runs do not advance the watermark; an empty delta keeps the previous value. SQL continues reading the merged `_current` snapshot through the same row filters and column masks, including Local lake aliases.

Deletes remain in the snapshot by default (`delete_detection: "none"`). With `key_diff`, every Nth successful run scans only all source keys and removes snapshot rows whose keys are absent. The initial full run counts toward this interval; failed/cancelled runs do not. `key_diff_every_runs: 0` disables the scan. `rows_read` includes rows in this key scan. Sources should remain stable during a run for a consistent result.

Changed source column names or types trigger a full refresh for that run, re-seed the watermark, record `fallback_reason` and emit `sync.fallback` in the audit log. Runs expose `mode_used`, `rows_read`, `rows_inserted`, `rows_updated` and `rows_deleted`. Updates count delta keys already in the previous snapshot, including unchanged boundary rows. GET jobs exposes the read-only `watermark`. Jobs/runs require `sync_admin` on their target. Changing sync settings resets job state and requires all active runs to finish; enabling/disabling a job preserves it. Runs for the same target are serialized.

## Stripe

Create a Stripe source with `kind="stripe"` and a **restricted key** (`rk_…`) that has read-only access to the objects you sync and to Events. The key is sent as the write-only `secret` and kept in the engine's OS keychain.

```json
{ "name": "Payments", "kind": "stripe",
  "config": { "account_label": "acme-live", "objects": ["customers", "charges", "invoices"], "rate_limit_rps": 25 },
  "secret": "rk_live_..." }
```

- **Objects:** customers, charges, payment_intents, invoices, subscriptions, products, prices, refunds, balance_transactions (all nine by default). Each has fixed columns: `id` as the primary key, `created` as a UTC timestamp, amounts as integers in minor units, nested objects as JSON text, and references such as `customer` as ID strings. Declared relationships link them on the Data Map.
- **Full refresh:** reads every page of each list endpoint.
- **Incremental** (`mode="incremental"`, with no `watermark_column` and `delete_detection="none"`):
  - Reads `/v1/events` since the last watermark. Updates are merged by `id`, `*.deleted` events remove rows, and the newest event per object wins.
  - `balance_transactions` are append-only, so they're read by `created`.
  - The first run is a full load. If the last sync is more than 29 days old (Stripe keeps events for 30), the run falls back to a full refresh and records the reason.
- **Requests:** at most `rate_limit_rps` per source (25 by default). HTTP 429 and 5xx responses are retried with backoff, honouring `Retry-After`, up to 5 attempts. API keys appear only in the `Authorization` header, never in errors or logs.

## Salesforce

`kind="salesforce"` reads standard and custom objects through the REST describe API and **Bulk API 2.0**.

```json
{ "name": "CRM", "kind": "salesforce",
  "config": { "instance_url": "https://acme.my.salesforce.com", "login_url": "https://login.salesforce.com",
              "client_id": "<connected app consumer key>", "objects": ["Account", "Contact", "Opportunity"] },
  "secret": "<refresh token>" }
```

- **Auth:** OAuth 2.0 refresh token from your own connected app. Use a PKCE public client; no consumer secret is needed. The refresh token lives in the engine keychain, and access tokens are refreshed automatically. A revoked or expired grant fails with "re-authenticate this source". In the desktop app, choose **Sign in with Salesforce**: it runs the PKCE flow in your browser with the callback `http://localhost:1717/OauthRedirect`, which you add to the connected app, and stores the grant on save.
- **Discovery:** one dataset per configured object. Address, location and base64 fields are skipped, because Bulk queries can't return them. A single-target reference field becomes a declared relationship to `Id`.
- **Full refresh:** a Bulk `query` job, paged through `Sforce-Locator`.
- **Incremental** (`mode="incremental"`, with no `watermark_column`):
  - A Bulk `queryAll` job filtered on `SystemModstamp >= <watermark>`. Rows with `IsDeleted = true` are removed from the snapshot.
  - The watermark is the newest `SystemModstamp` seen.
  - If the last sync is older than 14 days, the run falls back to a full refresh, because deleted records leave the recycle bin after 15.
- **Requests:** `rate_limit_rps` defaults to 10 per source.

## SQL models

Create and edit models in **Data → Models**, or through the API. Names are lowercase SQL identifiers. Sync input datasets first, then create a model (replace URL, token and input table):

```powershell
$headers = @{ Authorization = "Bearer <user-token>" }
$body = @{
  name = "customers"; sql = "SELECT id, name FROM app_db.users"
  materialization = "table"; trigger = "manual"; cron = $null; optimize = $true
} | ConvertTo-Json
$model = Invoke-RestMethod http://127.0.0.1:8787/v1/models -Method Post -Headers $headers -ContentType application/json -Body $body
Invoke-RestMethod "http://127.0.0.1:8787/v1/models/$($model.id)/run" -Method Post -Headers $headers
```

Query the published result with `SELECT * FROM models.customers` through SQL or pgwire. A `table` model streams into staging Parquet parts and atomically publishes under `data/straton-models/<name>/`. Row counts, last-sync times, and input lineage appear under the built-in **Models** source in the Data Map. Recovery re-executes an unfinished query; a durable renamed snapshot resumes publication.

A `view` model is an ephemeral logical plan, evaluated when queried, with no snapshot or run. Views use a manual trigger. Table triggers are `manual`, `cron` (UTC, seconds first, e.g. `0 */5 * * * *`), or `upstream`. An input publish queues an upstream model once while it already has a queued run. Publications propagate through view inputs. Downstream runs wait while upstream models are queued or running.

Every save validates a single read-only SELECT as the **model owner**, using only their readable, filtered and masked tables. Dependencies come from logical-plan scans. Unknown tables and cycles are rejected; downstream definitions are revalidated after edits and expose `status: "broken"` and `error` when invalid. Owners and administrators may edit, run and explain models. Active runs must finish before editing. Deleting a model with dependents is refused; historical runs are retained.

Table runs execute as the owner, so their row filters and masks constrain the output. Reading that output separately requires a grant on the Models source or dataset, and its own output policies apply. **Views are planned with the querying user's input views, never the owner's session**, so granting a view cannot widen input access. Views also require a Models grant.

The `cancel_compensating_arithmetic` logical **OptimizerRule** runs after DataFusion's standard rules simplify views. It can combine deterministic view projection chains when a cancellation fires. It preserves semantics after type coercion, so an AnalyzerRule is not appropriate. A view `SELECT id + 1 AS y FROM app_db.users` followed by `SELECT y - 1 FROM models.v` can collapse to `id`. DataFusion 55.2 Int64 add/sub wraps modulo 2^64 (including MAX + 1 and MIN - 1); cancellation and constant-chain folding use the same wrapping semantics. Casts preserve result type and nullability. Floats and volatile expressions are excluded. Decimal128 arithmetic uses checked operations: cancelling a chain can remove an overflow error, so decimals are conservatively skipped (a regression test covers this). Other integer widths remain unchanged pending separate proofs.

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/v1/models/$($model.id)/explain" -Headers $headers | ConvertTo-Json -Depth 8
```

Explain returns `logical_before`, `logical_after`, `physical`, and `rules_fired` entries with `rule`, `before` and `after`. Set `optimize: false` to use only DataFusion's standard optimizer for that model's run or Explain plan. The desktop shows before/after diff rows and expandable plans. `POST /v1/models/validate` validates an unsaved editor definition without mutation.

## Encryption at rest

New Parquet snapshots and staging parts are encrypted by default with Parquet modular AES-GCM encryption, including every column and the footer. Each dataset/model output has a 256-bit data key, stored AES-256-GCM wrapped in state.db. The wrapping KEK resides only in the OS keychain (service straton, account kek). Local lake aliases share their physical snapshot's encryption. Each snapshot's durable _key sidecar selects its key; retain it with the parts.

Configure [encryption] enabled = false in straton.toml or STRATON_ENCRYPTION_ENABLED=false to make new runs plaintext. Encrypted snapshots remain readable with the KEK; legacy plaintext snapshots remain readable without a sidecar. Resumed staging retains its original encryption choice. Missing keys and failed unwraps deny encrypted reads.

Administrators manage keys in **System → Backups → Security** or with GET /v1/admin/keys, POST /v1/admin/keys/rotate-kek, and POST /v1/admin/keys/rotate/<dataset-id>. KEK rotation re-wraps existing keys without rewriting data, using a pending keychain entry for crash recovery. Dataset rotation requires its active runs to finish, retires its key, and uses a new key on the next run. Cleanup deletes retired keys only after their snapshots/checkpoints are gone. Key metadata APIs never return key material.

**state.db and database backups deliberately stay plaintext**: they contain metadata, model definitions, token hashes, wrapped keys, and audit rows. Secrets live in the keychain. Protect metadata/backups with OS permissions; SQLCipher and mTLS are deferred. Database backups exclude Parquet and keychain secrets. An old backup may require its old KEK version after rotation; plan protected keychain recovery alongside database recovery. See [SECURITY.md](SECURITY.md) for the exact boundary.

## Audit log integrity

Audit rows form a SHA-256 chain over the previous hex hash and canonical JSON of the row's id, timestamp (at), action, entity_id, principal_id, and detail. Existing rows are backfilled once at migration. The head lookup and insertion share the caller's SQLite write transaction. Append-only triggers remain enforced.

Administrators can use **Verify audit chain**, GET /v1/audit/verify, or run **straton-engine verify-audit** while the engine is stopped. Verification returns {ok, rows, first_bad_id}; CLI failure produces a nonzero exit. /v1/status includes audit_head for external anchoring. Store heads in an independently trusted system: someone who can rewrite the entire database can also recompute the chain or truncate a valid suffix.

## Supply chain

CI runs Rust fmt/clippy/tests, cargo-deny, desktop formatting/build/tests, and npm audit --audit-level=high. deny.toml uses the binding license allowlist, crates.io-only sources, and duplicate-version warnings. Its only additional license permission is scoped to tiny-keccak 2.0.2 (CC0-1.0), found by inspecting all 487 locked registry manifests offline.

Tagged releases build through cargo-auditable and attach per-crate CycloneDX SBOMs, SHA-256 checksums, and keyless cosign signature bundles. Verify the expected repository, tag, and CI workflow identity before trusting checksums or SBOMs; commands and reporting instructions are in [SECURITY.md](SECURITY.md).
