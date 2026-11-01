# Contributing to Straton

Thanks for helping. Straton is a security-sensitive project, so changes are small, tested
and reviewed. Please read this page before opening a pull request.

## Ground rules

- Be kind and constructive; the [Code of Conduct](https://github.com/shiv-khetan/straton/blob/main/CODE_OF_CONDUCT.md) applies everywhere.
- **Security issues are never reported in public issues.** Use the private process in
  [SECURITY.md](https://github.com/shiv-khetan/straton/blob/main/SECURITY.md).
- Open an issue before large changes (new connectors, storage format, API shape) so we can
  agree on the design first.
- Never commit secrets, real customer data, production hostnames or personal information,
  including in tests and screenshots. Use `example.com`, `x.io` or loopback addresses.

## Repository layout

| Path | What lives there |
| --- | --- |
| `crates/straton-engine` | Engine binary: REST API, scheduler, sync runner, SQL (DataFusion), pgwire, audit |
| `crates/straton-connectors` | Source connectors (Postgres, MySQL, SQL Server, MongoDB, SQLite, CSV, Stripe, Salesforce) |
| `crates/straton-core` | Shared types |
| `apps/desktop` | Tauri 2 + React 19 + TypeScript desktop client (`src-tauri` is a separate Cargo workspace) |
| `docs` | Documentation site (MkDocs Material), published to GitHub Pages |
| `deploy` | Service definitions |

## Development setup

```bash
# Engine
cp straton.example.toml straton.toml
STRATON_ENCRYPTION_ENABLED=false cargo run -p straton-engine -- run

# Desktop app (separate terminal)
cd apps/desktop
npm ci
npm run tauri dev
```

To work on the UI without building Tauri, use the browser preview described in
`apps/desktop/dev/README.md`.

To preview the documentation site:

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r docs/requirements.txt
mkdocs serve
```

## Checks (CI runs the same)

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check advisories licenses bans sources

cd apps/desktop
npx tsc -b
npx prettier --check "src/**/*.{ts,tsx,css}"
npm test
npm run build
```

## Rules the tests enforce

- **New API routes** are added to the auth contract table in
  `crates/straton-engine/src/api_contract_tests.rs`. Every `/v1` route must reject missing and
  invalid tokens before parsing input. The [API reference](https://shiv-khetan.github.io/straton/reference/api/)
  is generated from that table.
- **New desktop client methods** are classified (read, transient or mutation) in
  `apps/desktop/src/lib/queryApi.ts`.
- **UI work** follows [DESIGN.md](https://github.com/shiv-khetan/straton/blob/main/DESIGN.md): existing tokens and primitives only, light and
  dark, keyboard access, `prefers-reduced-motion`, and animations on opacity and transform only.
- Request bodies use `deny_unknown_fields`; secrets are write-only and never logged.

## Pull requests

1. Fork, create a branch from `main`, keep the change focused.
2. Add or update tests and docs in the same pull request.
3. Write commit messages in the imperative ("Add MySQL TLS options").
4. Fill in the pull request template, including how you tested.
5. A maintainer reviews; CI must be green before merge.

By contributing you agree that your contribution is licensed under the [MIT License](https://github.com/shiv-khetan/straton/blob/main/LICENSE).
