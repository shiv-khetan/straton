# Configuration

The engine reads `straton.toml` from its working directory. Every setting has an environment
override (`STRATON_*`), which wins over the file. Unknown settings and invalid cron expressions
stop startup, so typos never fall back silently.

## Example file

```toml
--8<-- "straton.example.toml"
```

## Environment overrides

| Variable | Setting |
| --- | --- |
| `STRATON_DATA_DIR` | `data_dir` |
| `STRATON_BIND` | `bind` (non-loopback requires TLS) |
| `STRATON_TLS_CERT`, `STRATON_TLS_KEY` | `tls_cert`, `tls_key` (PEM) |
| `STRATON_MAX_CONCURRENT_RUNS` | `max_concurrent_runs` |
| `STRATON_MAX_ATTEMPTS` | `max_attempts` |
| `STRATON_BACKUP_CRON`, `STRATON_BACKUP_DIR`, `STRATON_BACKUP_KEEP` | `[backup]` |
| `STRATON_SQL_ENABLED`, `STRATON_SQL_BIND`, `STRATON_SQL_QUERY_TIMEOUT_SECS`, `STRATON_SQL_MAX_ROWS`, `STRATON_SQL_MEMORY_LIMIT_MB` | `[sql]` |
| `STRATON_ENCRYPTION_ENABLED` | `[encryption] enabled` |
| `STRATON_NETWORK_ALLOW_PRIVATE` | `[network] allow_private` |
| `STRATON_SECRETS_DIR` | `[secrets] dir` |
| `STRATON_LINEAGE_OPENLINEAGE_URL`, `STRATON_LINEAGE_NAMESPACE` | `[lineage]` (see [OpenLineage](openlineage.md)) |
| `STRATON_SNAPSHOTS_KEEP` | `[snapshots] keep` (snapshots kept per dataset for time travel) |
| `STRATON_OPENLINEAGE_API_KEY` | Bearer key for the OpenLineage collector; environment only, never in the file |
| `RUST_LOG` | Log filter (for example `info,straton_engine=debug`) |

## Schedules

Cron expressions have a **seconds** field first and run in **UTC**, for example
`0 */5 * * * *` (every five minutes). The desktop app accepts the common 5-field form and
converts it. Missed schedules produce one catch-up run per job; a new job starts scheduling
from its creation time.

## Runs and recovery

Crash recovery keeps checkpoints, retries up to `max_attempts` (3 by default) and waits 1, 2,
4, … seconds between attempts, capped at 1024 seconds. Failures and panics are recorded as
failed; only crash interruptions are retried. Ctrl-C (or SIGTERM) stops scheduling and drains
workers for up to 30 seconds.
