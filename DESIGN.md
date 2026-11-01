# Straton design system

Straton is a dense, precise data workbench (desktop, Tauri + React) for data and ML
engineers, not a marketing site. **Source of truth for values:**
`apps/desktop/src/styles/tailwind.css` (tokens) and `apps/desktop/src/app/styles.css` (shell).
Change fonts, colours, radii or spacing only with the maintainer's approval.

## Direction (UI UX Pro Max, reviewed)

Generated with UI UX Pro Max (`--design-system`, dials **variance 3/10 · motion 2/10 ·
density 8/10**) and its product, UX, chart, colour and typography databases, then checked
against what a data workbench needs.

| Area | UI UX Pro Max said | Straton decision |
| --- | --- | --- |
| Style | **Minimalism & Swiss Style**: functional, grid-based, high contrast, sans-serif; best for enterprise apps, dashboards, professional tools | **Adopted.** This is Straton's style. |
| Product type | Developer Tool / IDE: dashboard style "Real-Time Monitor + Terminal", blue focus colour, dark mode first-class | **Adopted:** live run state, console drawer, one blue-violet focus colour, light and dark as equals (default follows the OS). |
| Density | 8/10: dense dashboard; 2/4/8/12/16/24/32px spacing | **Adopted** (Straton's scale below already matches). |
| Motion | 2/10 subtle; 150–300ms state transitions; GSAP scroll reveals | State transitions **adopted**. Scroll reveals **rejected**: tables and charts must be readable immediately and GSAP is an extra dependency. |
| Palette | Navy + amber (generic) or slate + run-green (developer tool) | **Not adopted.** Indigo identity kept by decision. Its rules (blue focus, one accent, AA contrast) are met. |
| Fonts | Fira Sans + Fira Code ("Dashboard Data": mono for data, sans for labels) | **Not adopted.** Geist + JetBrains Mono kept by decision; the mono-for-data / sans-for-labels rule is adopted. Google Fonts URLs would also break the CSP (`font-src 'self'`); fonts are bundled. |
| Page pattern | "Enterprise Gateway" (hero video, logos, Contact Sales) | **Rejected:** a marketing landing pattern. App pages use the page anatomy below. |
| Component specs | 12px×24px buttons, 8–16px radii, cards with shadow, hover lift and `cursor: pointer`, `transition: all`, 16px inputs, blurred modal backdrop | **Rejected:** generic landing-page defaults. They cost density and add motion to data. Straton keeps crisp radii, flat bordered trays and transitions on specific properties. |

## Principles

1. **Data first.** Tables, code and numbers are the content; chrome stays quiet.
2. **One accent.** Indigo (`--primary`) marks the current location, primary actions and focus.
   Status colours mean status only. Chart series never use status colours.
3. **Same anatomy on every page.** The frame never moves when users navigate.
4. **Light and dark are equals.** Every token is a `light-dark()` pair; never hard-code a hex.
   The theme follows the OS by default and can be set in Settings.
5. **Accessible by default.** WCAG 2.1 AA (text 4.5:1, UI 3:1; enforced by
   `apps/desktop/tests/view.test.mjs`), complete keyboard use with visible focus in visual
   order, `prefers-reduced-motion` respected, never colour alone.

## Typography

| Role | Font | Size |
| --- | --- | --- |
| UI text | Geist Variable (`--font-ui`) | `text-body` 14px |
| Small text, captions | Geist | `text-caption` 13px |
| Section headline | Geist 600 | 15px (`--headline-sm`), 18px (`--headline-md`) |
| Page title | Geist 600, -0.01em | `text-page` 20px |
| Data: SQL, identifiers, types, cron, hashes, IDs | JetBrains Mono Variable (`--font-code`) | 13px (`--code-sm`) |

Mono for data, sans for labels. Headings and prose are never monospace. Numbers in tables,
KPIs and timers use `tabular-nums`. Inputs use 14px (desktop app; the 16px mobile-zoom rule
does not apply).

## Colour (semantic tokens only)

| Purpose | Tokens |
| --- | --- |
| Backgrounds | `--bg` (page), `--surface` (chrome, trays), `--surface-2/3`, `--panel`, `--panel-2` |
| Lines | `--line` (dividers), `--control-border` (inputs, 3:1 against surfaces) |
| Text | `--ink`, `--ink-2` (secondary), `--ink-3` (tertiary) |
| Accent and focus | `--primary` indigo `#4f46e5` / `#818cf8`, `--primary-hover`, `--primary-tint`, `--on-primary` |
| Status | `--success`, `--warning`, `--danger`, `--running` with `*-tint` fills and `*-ink` text |
| Charts | `--chart-1..5` (indigo-led categorical, distinct from status) |

Header, tab bar and sidebar share `--surface`; content sits on `--bg` (white in light,
`#0b0d12` in dark).

## Shape, space, depth

- Radii: chips 2px, controls 4px, trays and cards 6px, drawers 8px. No pills.
- Spacing (density 8/10): 4, 6, 8, 12, 16, 24px (`--space-*`), plus 2px hairline gaps and 32px
  only for empty states. Page padding 24px (12px below 640px). Content starts 20px below the
  top bar.
- Trays and cards are flat with a 1px `--line` border. Elevation (`--depth-raised`) only for
  floating layers: menus, popovers, toasts, sheets. Modal scrim `--scrim`, no blur.
- Z-index tokens: canvas overlay 10, sticky 20, drawer 30, dropdown 35, backdrop 40, sheet 50,
  toast 60, tooltip 70.

## Page anatomy (enforced by `tests/layout-consistency.test.mjs`, `tests/ui-shell.test.mjs`)

1. **Title bar** (48px): logo, search (Ctrl K), live status, notifications, console, account.
2. **Sidebar**: grouped sections (Overview, Data, Engineering, Intelligence, Admin).
3. **Page header** (`app/PageHeader.tsx`): meta row (breadcrumb, or engine telemetry on
   Overview) always present, then the title; primary action, favourite and Refresh at the end.
4. **Tab bar** (`PageTabs` / `CombinedPage`): flush under the header on the same surface,
   16px between tabs, 38px tall, one rule below, sticky. Sticky bars never cover content
   (sections use `scroll-mt`).
5. **Content**: titled groups use `SectionHeader`; framed content uses `Tray`; filters use
   `PageToolbar`; one-line explanations use `PageIntro`. Layout classes are defined once, in
   shared styles.

## Components

- Built on shadcn/ui + Radix (`components/ui`) and workbench primitives
  (`components/workbench/primitives.tsx`): `Tray`, `Table`, `StatePill`, `KpiTile`,
  `Sparkline`, `SegmentedControl`, `RowMenu`, `Inspector`, `EmptyState`.
- Buttons: `default` (one primary action per view), `outline` (row actions), `ghost` (toolbar
  and icon buttons, always with `aria-label`), `destructive` (confirmed in a dialog).
- Every clickable element shows the pointer cursor; disabled controls show `not-allowed`.
- Icons: Lucide only, one stroke weight, never emoji.
- Status is a `StatePill` (dot plus word), never colour alone.
- Tables: sticky header, horizontal scroll inside the table on narrow windows (never the
  page), right-aligned row actions with the overflow menu (⋯) last. Repeated work on many
  rows should offer selection plus bulk actions rather than only per-row buttons.
- Empty states say what is missing and offer the next action once (no duplicate CTAs).
- Loading uses skeletons shaped like the content; errors say what happened and how to retry.
- Merge classes with `cn()` (`lib/utils.ts`); theme font-size tokens are registered there.

## Charts (from the UI UX Pro Max chart database)

- Trends over time: line or area; fewer than 4 points becomes a stat or words, not a chart.
- More than one series: distinct colours **and** line styles (solid, dashed, dotted) with
  direct labels; never hue alone.
- Anomalies and failures: a distinct marker shape plus a text annotation, listed in a table.
- Every chart has a keyboard path (focus reveals values) and a table or summary fallback.
- Up to ~1,000 points render as SVG; beyond that, aggregate into time buckets (as Overview does).

## Motion (dial 2/10)

- 150ms (`--duration-fast`) for hover and small state changes, 180ms (`--duration-shell`) for
  panels and drawers, 120ms for tooltips. Transition named properties, never `all`.
- Things entering the screen use ease-out (`--ease-out-quart`). Nothing bounces. No hover
  lift or scale that shifts layout.
- Animate only `opacity` and `transform`. Honour `prefers-reduced-motion` (`MotionConfig
  reducedMotion="user"`). Motion explains a change of state or place, never decorates data.

## Pre-delivery checklist

- [ ] Uses tokens and primitives from this file; no new hex values, radii or fonts.
- [ ] Light and dark checked; text 4.5:1, controls and focus rings 3:1.
- [ ] Keyboard: every action reachable in visual order, focus visible, no traps.
- [ ] Pointer cursor on everything clickable; hover transitions 150–300ms.
- [ ] Windows at 800px (minimum), 1024px and 1440px wide; nothing hidden under sticky bars.
- [ ] Loading, empty and error states designed, not defaulted.
- [ ] `prefers-reduced-motion` respected; no animation on data appearing.
- [ ] Verified in the browser preview (`apps/desktop/dev/README.md`), then `npm test`,
      `npx tsc -b`, `npx prettier --check "src/**/*.{ts,tsx,css}"`, `npm run build`.
