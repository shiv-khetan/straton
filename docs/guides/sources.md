# Sources and catalog

Connect a source, discover its catalog and sync datasets into the local lake.

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
