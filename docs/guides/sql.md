# SQL endpoint

Query synced data over the Postgres wire protocol or the REST API, with every policy applied.

The read-only Postgres endpoint listens on `127.0.0.1:5433` by default. Log in with your user name and that user’s token as the password. The bootstrap user is `admin`, with the token from `data/token`. The database name is a client compatibility value.

```powershell
psql "host=127.0.0.1 port=5433 user=admin dbname=straton sslmode=disable"
# At the password prompt, paste the engine token.
```

In DBeaver, create a PostgreSQL connection with host `127.0.0.1`, port `5433`, database `straton`, user `admin` (or your assigned user name), and the token as password. JDBC prepared statements and both text and binary result formats are supported. Use schema-qualified names in the SQL editor. PostgreSQL-specific `pg_catalog` introspection is limited; the desktop table browser and `GET /v1/sql/tables` list only your visible tables with post-mask types. `information_schema` is disabled.

Source names become lowercase schemas, replacing non-ASCII-alphanumeric characters with `_` and prefixing digit-leading names with `_`. Collisions receive `_2`, `_3`, etc., in source-ID order; `public`, `information_schema`, and `pg_catalog` are reserved. Dataset names remain literal: query a Postgres dataset as `"app_database"."public.users"`. Local lake aliases use normalized source and dataset labels, for example `"local_lake"."app_database_users"`; consult the Lineage map or `/v1/sql/tables` for exact names. Only datasets with a published `_current` snapshot appear. Each query resolves that pointer once and reads only its immediate Parquet files. Publication waits for active queries before replacing and deleting a snapshot.

```sql
SELECT * FROM "app_database"."users" LIMIT 20;
```

Configure `[sql]` in `straton.toml`: `enabled = true`, `bind = "127.0.0.1:5433"`, `query_timeout_secs = 60`, `max_rows = 100_000`, `memory_limit_mb = 1024`. Matching overrides are `STRATON_SQL_ENABLED`, `STRATON_SQL_BIND`, `STRATON_SQL_QUERY_TIMEOUT_SECS`, `STRATON_SQL_MAX_ROWS`, and `STRATON_SQL_MEMORY_LIMIT_MB`. Timeouts may be fractional seconds. A non-loopback SQL bind requires the existing `tls_cert` and `tls_key` PEM settings and refuses plaintext connections; configure the client to require and verify TLS. Disabling SQL disables the wire listener and SQL REST routes.

Each query uses an isolated DataFusion session and the shared, bounded DataFusion memory pool. Retained Arrow results are charged to that pool too; it does not cap total process RSS. Exceeding the row or memory limit returns an error, never a silently shortened result. The timeout covers catalog resolution, planning, and execution; dropping the execution stream cancels its work. Ctrl-C stops accepting connections and allows up to 30 seconds for SQL connections to drain.

DDL, DML, COPY (including COPY TO), session changes, multi-statement requests, and EXPLAIN ANALYZE are rejected. The wire endpoint has only these client compatibility exceptions: exact `SELECT version()` / `SELECT pg_catalog.version()`, `SELECT current_schema()` / `SELECT current_schema`, `SELECT current_database()`; SHOW for `server_version`, `server_version_num`, `transaction_read_only`, `default_transaction_read_only`, `standard_conforming_strings`, `client_encoding`, `TimeZone`, `DateStyle`, and `search_path`. Harmless SET acknowledgements cover `extra_float_digits` 2/3, UTF8 `client_encoding`, UTC timezone, ISO DateStyle, and `application_name`. These acknowledgements do not change session state. REST accepts only read-only queries and EXPLAIN.

The desktop **SQL Workspace** supports Ctrl/Cmd+Enter, Run, Explain, table insertion, and a scrollable results grid. Its REST API uses the normal bearer token:

- `POST /v1/sql` with `{"query":"SELECT 1","limit":1000}` returns `columns`, `rows`, total `row_count`, `truncated_preview`, and `elapsed_ms`. The optional preview limit is 0–1000, separate from the engine's hard row limit; the full query must pass all limits even for a small preview. Decimal, temporal, binary, and other non-JSON scalar types are returned as strings.
- `POST /v1/sql/explain` with `{"query":"SELECT 1"}` returns `logical` and `physical` plan strings without executing the query.
- `GET /v1/sql/tables` returns `{"tables":[{"schema":"app_database","name":"users","columns":[{"name":"id","type":"Int64"}]}]}`.

Successful and failed queries append `sql.query` audit records; forbidden statements append `sql.rejected`. Details contain the real user ID as principal, the SHA-256 hex digest of the original SQL text, datasets scanned, and row count or error class. Raw SQL and bound parameter values are never stored in the audit log. Extended-protocol parse failures are audited; successful preparation is audited when executed. Authorization and policies are re-evaluated for every REST request and pgwire statement.

## Time travel

Set `[snapshots] keep` (default 1) to keep earlier published snapshots of every dataset, then
read one by adding `@` and a time or a snapshot (run) id to the table name, in quotes:

```sql
-- The latest snapshot published at or before a moment (RFC 3339):
SELECT count(*) FROM app_db."orders@2026-11-04T09:00:00Z";
-- A specific snapshot, by the run that published it:
SELECT * FROM app_db."orders@9dd291c0-54fa-43b7-96f4-a09aff50d924";
-- Rows added since that snapshot:
SELECT n.* FROM app_db.orders n
LEFT JOIN app_db."orders@2026-11-04T09:00:00Z" o ON o.id = n.id
WHERE o.id IS NULL;
```

Time travel works in the SQL endpoint, pgwire, charts and Explorer, where a **Snapshot** picker
lists the kept snapshots and **Open in SQL** names the chosen one. `GET
/v1/explorer/snapshots?schema=…&table=…` lists them, newest first. Every read applies the
**current** grants, row filters and masks, so revoking access also covers history. Models and
quality checks always read current data. When a sync publishes, only the newest `keep`
snapshots of that dataset stay on disk; asking for an older one says how many are kept.
