# Straton

Open-source, self-hosted data platform: Rust engine (`crates/`) and Tauri + React desktop app
(`apps/desktop`). Security is a first-class requirement; see SECURITY.md.

## Checks before saying work is done

- Rust: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`.
- Desktop (`apps/desktop`): `npx tsc -b`, `npx prettier --check "src/**/*.{ts,tsx,css}"`,
  `npm test`, `npm run build`.
- New API routes go in the auth contract table (`crates/straton-engine/src/api_contract_tests.rs`);
  new client methods must be classified in `apps/desktop/src/lib/queryApi.ts`.

## Design rules

- Read DESIGN.md before any UI work. Never change its fonts, colours, radii or spacing without
  asking the maintainers.
- App screens are built from the existing primitives and page anatomy in DESIGN.md
  (`components/ui`, `components/workbench`). Use Hallmark only for product or business pages
  outside the app (website, docs, launch pages); MotionSites is not used in this project.
- Before you say a page is done, run `/impeccable critique` on it and fix the top 3 issues, then
  `/impeccable polish`. If Impeccable is not installed, use the `design:design-critique` and
  `design:accessibility-review` skills instead.
- Every animation follows `review-animations`. Things that enter the screen use ease-out
  (`--ease-out-quart`); respect `prefers-reduced-motion`; animate only opacity and transform.
- Look at UI changes, don't just compile them: run the browser preview
  (`apps/desktop/dev/README.md`) and check light, dark and a 600px-wide window.
- Diagrams of hero components for docs or pitches use dimensional-drawing.
