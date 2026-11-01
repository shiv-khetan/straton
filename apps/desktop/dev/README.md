# Browser preview (development only)

Runs the desktop UI in a normal browser against a local engine, for visual review,
screenshots and Playwright checks without building Tauri. `vite.preview.config.ts`
swaps the Tauri APIs (`@tauri-apps/*`) for the small shims in `browser-shims/` and
proxies `/v1` to the engine. Nothing here is part of `npm run build`.

```bash
# 1. Start an engine (encryption off when no OS keychain is available, e.g. CI/containers)
STRATON_ENCRYPTION_ENABLED=false cargo run -p straton-engine -- run
# 2. Start the preview with that engine's token
STRATON_DEV_TOKEN=$(cat data/token) npm run preview:browser
# 3. Open http://127.0.0.1:1421/
```

Limits: browsers cannot set an `Authorization` header on WebSockets, so the live event
stream is a no-op (use Refresh); Save dialogs return no path, so exports are skipped.
The token is inlined into the dev bundle only; the server listens on 127.0.0.1.
