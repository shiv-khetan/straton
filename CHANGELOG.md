# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may break interfaces).

## [Unreleased]

### Added
- Desktop: a Failed sign-ins tray under Security & Backups; a Steps list (run order, with
  dependencies), fit-to-selection and an overview map for larger graphs in the pipeline
  editor; Copy details on SQL errors.
- Time travel: `[snapshots] keep` keeps earlier snapshots per dataset; read them with
  `schema."table@<time or run id>"` in SQL, pgwire and charts, or the Snapshot picker in
  Explorer (`snapshot` in Explorer requests, `GET /v1/explorer/snapshots`). Current access
  rules apply to history.
- Profile histograms: Explorer's column profile draws a twelve-bin histogram for numeric
  columns (`histogram` in `POST /v1/explorer/profile`).
- `drift` quality checks: profile a table on each run and fail when its row count, null
  shares or distinct counts move past thresholds, or columns appear or disappear.
- Model expectations (DLT-style): `warn`, `drop` and `fail` rules on table models, checked
  while the model materializes, with per-run results in the API and the model sheet.
- Tag-based masking: tag columns (`pii`, `finance.salary`) and set one mask per role per tag,
  applied to every tagged column in every dataset; column masks still win. API under
  `/v1/datasets/{id}/columns/{column}/tags/{tag}`, `/v1/tags` and `/v1/tag-masks`; managed in
  Team & Permissions → Policies.
- OpenLineage export (`[lineage] openlineage_url`): `START`, `COMPLETE`, `FAIL` and `ABORT`
  events for syncs and model runs, with input and output datasets and schema facets.
- Documentation site (MkDocs Material) published to GitHub Pages, with an API reference
  generated from the engine's route contract test.
- Open-source project files: license, contributing guide, code of conduct, issue and pull
  request templates, Dependabot, CodeQL, desktop release builds.
- Column profiling (`POST /v1/explorer/profile`) and the Settings page.
- File-backed secret store (`STRATON_SECRETS_DIR`) so Linux keeps keys across reboots.
- Connector egress policy (`[network] allow_private`); metadata and link-local addresses are
  always refused.
- Bulk job actions, schedule field with presets and live feedback, readable SQL errors.

### Security
- Quality-check results (observed values, failing rows, drift details) are computed with the
  owner's access; readers whose row filter hides rows now see pass/fail only.
- Quality-check SQL is validated as the caller: planner errors could list the columns of
  tables the caller cannot read.
- Chart previews, chart data and drill-downs write the same `sql.query` audit row as the SQL
  endpoint (`"via":"chart"`); they previously ran user SQL unaudited.
- `hash` column masks use HMAC-SHA256 under an engine-held key instead of plain SHA-256, so
  masked phone numbers or IDs cannot be reversed by hashing guesses. Masked values change
  once; joins between masked columns still match. `last4` hides values of four characters
  or fewer entirely.
- The engine creates its files owner-only (umask 077) and warns when its data or backup
  directory is readable by other users.
- Failed sign-ins are counted per address: an `auth.failures` audit row and an admin
  notification at 20 failures in ten minutes, and `GET /v1/admin/auth-failures`.
- pgwire clients must authenticate within 10 seconds.
- SaaS connectors never follow HTTP redirects, which bypassed the egress policy; the policy
  also checks IPv4 addresses inside NAT64, 6to4 and IPv4-compatible IPv6 forms.
- zstd 0.13.4 / zstd-safe 7.4.0 fix RUSTSEC-2026-0391, -0398 and -0403 (the advisory ignore
  list is empty again); Windows-only NTLM keeps `rand 0.7` out of Linux and macOS builds.
- GitHub Actions are pinned to commit SHAs, checkouts no longer persist the token, and
  release tooling versions are pinned. The systemd unit gains a full sandbox (exposure 8.7
  to 3.2 by `systemd-analyze security`).
- The desktop app validates the shape of identity, status, SQL and Explorer responses, accepts
  `http://[::1]` engines, and drops an unused npm dependency.
- Scoped source administrators can no longer repoint a source's location or credentials.
- Source paths inside the engine's data or backup directories are refused.
- Security headers on every API response; pgwire connection cap; export row cap; hardened
  desktop OAuth callback; connector errors no longer echo driver text.

## [0.1.0]

- Initial engine, connectors, SQL endpoint, access control, encryption at rest, audit chain
  and desktop app.
