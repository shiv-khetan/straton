# Desktop app

The Tauri desktop client connects to any engine you can reach.

The Tauri 2 desktop client lives in `apps/desktop`; its Rust shell is an independent Cargo workspace. Dependencies must already be installed for offline development.

```powershell
cd apps/desktop
npm run tauri dev
```

Start the engine first. In Connect, enter `http://127.0.0.1:8787` (or a remote HTTPS engine URL) and paste the token from the engine’s `data/token`. Test and save stores the connection in the OS keychain under service `straton-desktop`. Forget connection removes that entry. Tokens are never placed in localStorage. Connector passwords are write-only and stored by the engine.

Discover sources to populate the **Lineage** map. Drag between column handles to create manual relationships; select a manual edge and press Delete, or use Delete manual edge. Filters, dataset search, MiniMap, and Re-layout help navigate the catalog. Positions are saved locally per engine URL. Jobs use UTC cron with seconds first; blank schedules are manual. Run state activity updates over one reconnecting authenticated WebSocket. The current engine does not expose log streaming or historical log retrieval. Lineage edges are dataset-level in the API (empty column lists) and attach to table headers; column relationships attach to their named columns.

```powershell
npm run build
npm test
cd src-tauri
cargo clippy --offline --all-targets -- -D warnings
cargo build --offline
```

## Pages

| Section | Pages |
| --- | --- |
| Overview | Overview (health, attention items, recent activity), Library (favourites and recent items) |
| Data | Connections (sources, health, check and discover), Explorer (browse, filter, profile and export datasets), SQL Workspace |
| Engineering | Orchestration (jobs and pipelines, bulk actions, run history), Transformations (SQL models), Optimizer |
| Intelligence | Analytics (charts and dashboards), Data Quality (checks), Lineage (column-level map and impact analysis) |
| Admin | Team & Permissions, Security & Backups (keys, audit verification, backups), Settings |

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (<kbd>Cmd</kbd>+<kbd>K</kbd> on macOS) to search pages, datasets and
commands. The theme follows the OS and can be changed in Settings.
