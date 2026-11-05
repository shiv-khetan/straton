# Straton

**An open-source, self-hosted data platform written in Rust.** Connect sources, sync them into
an encrypted Parquet lake, transform them with SQL, and query everything over the Postgres
wire protocol, with users, roles, row filters and column masks enforced inside the engine.

[![CI](https://github.com/shiv-khetan/straton/actions/workflows/ci.yml/badge.svg)](https://github.com/shiv-khetan/straton/actions/workflows/ci.yml)
[![Docs](https://github.com/shiv-khetan/straton/actions/workflows/docs.yml/badge.svg)](https://shiv-khetan.github.io/straton/)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**[Documentation](https://shiv-khetan.github.io/straton/)** ·
[Getting started](https://shiv-khetan.github.io/straton/getting-started/) ·
[API reference](https://shiv-khetan.github.io/straton/reference/api/) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> **Status:** pre-1.0. Interfaces may change between minor releases.

## Features

- **Sync** from Postgres, MySQL, SQL Server, MongoDB, SQLite, CSV, Stripe and Salesforce:
  full or incremental (watermark + key merge), resumable from the last committed checkpoint.
- **Transform** with SQL models (tables or views) on a schedule or when inputs change, with
  expectations that warn, drop rows or fail a run before it publishes, and an optimizer that
  removes provably redundant arithmetic.
- **Query** through a read-only Postgres endpoint (psql, DBeaver, BI tools) or the REST API,
  bounded by row, memory and time limits, including earlier snapshots
  (`app_db."orders@2026-11-04T09:00:00Z"`).
- **Govern** with a default-deny API, per-source and per-dataset grants, row filters, column and
  tag-based masks applied inside the SQL engine, a hash-chained audit log, and OpenLineage
  events for Marquez, DataHub or Unity Catalog.
- **Protect** data with Parquet modular encryption (AES-GCM, per-dataset keys, KEK rotation),
  secrets in the OS keychain or a private file store, and signed releases with SBOMs.
- **Understand** your data in the desktop app: column-level lineage, impact analysis, quality
  and drift checks, profiling with histograms, pipelines and run history.

## Quick start

```bash
git clone https://github.com/shiv-khetan/straton.git
cd straton
cp straton.example.toml straton.toml
cargo run --release -p straton-engine -- run
```

The engine listens on `http://127.0.0.1:8787` and writes an admin token to `data/token`.
Then connect the desktop app (`cd apps/desktop && npm ci && npm run tauri dev`) or query with
`psql "host=127.0.0.1 port=5433 user=admin dbname=straton sslmode=disable"`.

On Linux, set `STRATON_SECRETS_DIR` so encryption keys survive a reboot. See the
[getting started guide](https://shiv-khetan.github.io/straton/getting-started/) for details.

## Repository layout

| Path | Contents |
| --- | --- |
| `crates/straton-engine` | Engine: REST API, scheduler, sync, SQL (DataFusion), pgwire, audit |
| `crates/straton-connectors` | Source connectors |
| `crates/straton-core` | Shared types |
| `apps/desktop` | Tauri 2 + React desktop client |
| `docs` | Documentation site (GitHub Pages) |
| `deploy` | systemd unit and Windows service notes |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE) © The Straton contributors
