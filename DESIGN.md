# Straton design system

Straton is a dense, precise data workbench (desktop, Tauri + React), not a marketing site.
The look is a calm "console": crisp corners, quiet surfaces, one indigo accent, data first.
This file documents the system as implemented. **Source of truth for values:**
`apps/desktop/src/styles/tailwind.css` (tokens) and `apps/desktop/src/app/styles.css` (shell).
Change fonts, colours, radii or spacing only with the maintainer's approval.

## Principles

1. **Data first.** Tables, code and numbers are the content; chrome stays quiet.
2. **One accent.** Indigo (`--primary`) marks the current location, primary actions and focus.
   Status colours mean status only, never decoration. Chart series never use status colours.
3. **Same anatomy on every page.** Users should never see the frame move when they navigate.
4. **Light and dark are equals.** Every token is a `light-dark()` pair; never hard-code a hex.
5. **Accessible by default.** WCAG 2.1 AA contrast (enforced by `apps/desktop/tests/view.test.mjs`),
   full keyboard use, visible focus, `prefers-reduced-motion` respected.

## Typography

| Role | Font | Size token |
| --- | --- | --- |
| UI text | Geist Variable (`--font-ui`) | `text-body` 14px |
| Small / captions | Geist | `text-caption` 13px |
| Section headline | Geist, 600 | `--headline-sm` 15px, `--headline-md` 18px |
| Page title | Geist, 600, -0.01em | `text-page` 20px |
| Code, identifiers, SQL, counts in tables | JetBrains Mono Variable (`--font-code`) | `--code-sm` 13px |

Monospace means code: SQL names, column names, types, cron, hashes, IDs. Headings and prose
are never monospace. Numbers in tables and KPIs use `tabular-nums`.

## Colour (semantic tokens only)

| Purpose | Tokens |
| --- | --- |
| Backgrounds | `--bg` (page), `--surface` (chrome, cards), `--surface-2/3`, `--panel`, `--panel-2` |
| Lines | `--line` (dividers), `--control-border` (inputs, 3:1 against surfaces) |
| Text | `--ink` (primary), `--ink-2` (secondary), `--ink-3` (tertiary) |
| Accent | `--primary`, `--primary-hover`, `--primary-tint`, `--on-primary` |
| Status | `--success`, `--warning`, `--danger`, `--running` with `*-tint` backgrounds and `*-ink` text |
| Charts | `--chart-1..5` (indigo-led categorical) |

Light: white surfaces on white page, grey lines. Dark: `#111318` chrome over a `#0b0d12` page.
Header, tab bar and sidebar share `--surface`; page content sits on `--bg`.

## Shape, space, depth

- Radii: chips 2px, controls 4px, cards/trays 6px, drawers 8px. No pills, no large rounding.
- Spacing scale: 4, 6, 8, 12, 16, 24px (`--space-*`). Page padding 24px; 12px under 640px.
- Elevation (`--depth-raised`) only for floating layers: menus, popovers, toasts, sheets.
  Cards and trays are flat with a 1px `--line` border.
- Z-index tokens: canvas overlay 10, sticky 20, drawer 30, dropdown 35, backdrop 40,
  sheet 50, toast 60, tooltip 70.

## Page anatomy (enforced by `tests/layout-consistency.test.mjs`, `tests/ui-shell.test.mjs`)

1. **Title bar** (48px): logo, search (Ctrl K), live status, notifications, console, account.
2. **Sidebar**: grouped sections (Overview, Data, Engineering, Intelligence, Admin).
3. **Page header** (`app/PageHeader.tsx`): a meta row (breadcrumb, or engine telemetry on
   Overview) always present, then the page title; primary action, favourite and Refresh at the
   end. Title and actions sit at the same position on every page.
4. **Tab bar** (`PageTabs` or `CombinedPage`): directly under the header on the same surface,
   no seam, 16px between tabs, 38px tall, one rule below the pair, sticky while scrolling.
5. **Content**: starts 20px below the top bar. Titled groups use `SectionHeader`; framed content
   uses `Tray`; filters use `PageToolbar`; one-line explanations use `PageIntro`.

Layout classes (`.page-tabs`, `.section-header`, `.page-intro`, `.toolbar`) are defined once in
shared styles, never per feature.

## Components

- Built on shadcn/ui + Radix (`components/ui`) and workbench primitives
  (`components/workbench/primitives.tsx`): `Tray`, `Table`, `StatePill`, `KpiTile`,
  `Sparkline`, `SegmentedControl`, `RowMenu`, `Inspector`, `EmptyState`.
- Buttons: `default` (one primary action per view), `outline` (row actions), `ghost` (toolbar
  and icon buttons, always with `aria-label`), `destructive` (confirmed with a dialog).
- Row actions are right-aligned; the overflow menu (⋯) is always last.
- Status is a `StatePill` (dot plus word), never colour alone.
- Empty states say what is missing and offer the next action once (no duplicate CTAs).
- Use `cn()` from `lib/utils.ts` to merge classes; theme font-size tokens are registered there.

## Motion

- Durations: 150ms (`--duration-fast`) for hover and small state changes, 180ms
  (`--duration-shell`) for panels and drawers, 120ms for tooltips.
- Easing: elements entering the screen use ease-out (`--ease-out-quart`). Nothing bounces.
- Animate only `opacity` and `transform`. Honour `prefers-reduced-motion` (the app's
  `MotionConfig reducedMotion="user"` does this for motion components).
- Motion explains a change of state or place; it is never decoration in a data view.

## Verifying UI work

- Run the UI against a local engine in a browser: see `apps/desktop/dev/README.md`
  (`npm run preview:browser`), and check both themes and a narrow (600px) window.
- `npm test`, `npx tsc -b`, `npx prettier --check "src/**/*.{ts,tsx,css}"`, `npm run build`.
