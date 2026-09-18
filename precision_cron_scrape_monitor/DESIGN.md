---
name: Precision Cron & Scrape Monitor
colors:
  surface: '#0f1417'
  surface-dim: '#0f1417'
  surface-bright: '#353a3d'
  surface-container-lowest: '#0a0f12'
  surface-container-low: '#171c1f'
  surface-container: '#1b2023'
  surface-container-high: '#262b2e'
  surface-container-highest: '#303539'
  on-surface: '#dfe3e7'
  on-surface-variant: '#bec9c0'
  inverse-surface: '#dfe3e7'
  inverse-on-surface: '#2c3134'
  outline: '#89938b'
  outline-variant: '#3f4943'
  surface-tint: '#88d7ae'
  primary: '#88d7ae'
  on-primary: '#003824'
  primary-container: '#529f7a'
  on-primary-container: '#00311e'
  inverse-primary: '#176b4a'
  secondary: '#f7bc68'
  on-secondary: '#452b00'
  secondary-container: '#7b5100'
  on-secondary-container: '#ffc779'
  tertiary: '#ffb4a8'
  on-tertiary: '#621009'
  tertiary-container: '#e16f5e'
  on-tertiary-container: '#580904'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#a4f3c9'
  primary-fixed-dim: '#88d7ae'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005235'
  secondary-fixed: '#ffddb2'
  secondary-fixed-dim: '#f7bc68'
  on-secondary-fixed: '#291800'
  on-secondary-fixed-variant: '#624000'
  tertiary-fixed: '#ffdad4'
  tertiary-fixed-dim: '#ffb4a8'
  on-tertiary-fixed: '#410000'
  on-tertiary-fixed-variant: '#81281d'
  background: '#0f1417'
  on-background: '#dfe3e7'
  surface-variant: '#303539'
typography:
  headline-lg:
    fontFamily: IBM Plex Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 24px
  headline-sm:
    fontFamily: IBM Plex Sans
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
  body-md:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  body-sm:
    fontFamily: IBM Plex Sans
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  mono-metric:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.02em
  mono-body:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 14px
  label-caps:
    fontFamily: IBM Plex Sans
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.06em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 0.75rem
  margin: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

This design system is built for single-instance, high-precision cron scrapers and price monitoring utilities. It takes inspiration from laboratory instruments, bench multimeters, and classic UNIX terminal diagnostic tools. There is zero decorative abstraction: no artificial cloud clusters, no speculative queue depth graphs, and no marketing fluff. The system treats price extractions as physical readings taken on fixed intervals.

The tone is direct, deliberate, and calm. Operators require rapid state assessment: whether a job fired, how long it took, what HTTP status or parser error surfaced, how many price targets changed, and precisely when the next tick occurs. Visual priority is governed entirely by information density, mechanical tabular alignment, and strict status semantics.

## Colors

The system uses a calibrated dual-mode palette with stark separation between informational chrome and mechanical telemetry. Dark mode is the primary operational state.

### Dark Mode (Primary)
- **Base Canvas:** `#0E1113` — Recessed background for shell, gutters, and page backing.
- **Surface:** `#161B1E` — Card modules, tabular rows, inspector panes, and control bars.
- **Ink (Foreground):** `#E7EAE8` — High-contrast primary readings, prices, and field values.
- **Muted:** `#8A9495` — Structural schema keys, metadata labels, units (`ms`, `s`), and inactive states.
- **Rule:** `#252C30` — 1px hairlines framing all panels, cells, and divider tracks.
- **Status (OK):** `#4E9B76` — Successful scrape run, unmodified price, valid payload.
- **Status (Retried):** `#C79242` — Rate limit warning (429), backoff engaged, transient DOM miss.
- **Status (Failed):** `#C4594A` — Selector mismatch, schema invalidation, zero records extracted, connection drop.

### Light Mode
- **Base Canvas:** `#F6F7F5`
- **Surface:** `#FFFFFF`
- **Ink (Foreground):** `#15181B`
- **Muted:** `#5E6A6B`
- **Rule:** `#DDE1DE`
- **Status (OK):** `#2F6B4F`
- **Status (Retried):** `#9C6B1F`
- **Status (Failed):** `#9E3A2E`

Status colors must never be applied to large solid fills. Use them strictly for status indicators, numeric state counters, inline tag text, and 1px status border accents.

## Typography

The typography is optimized for scannable data inspection. The base size is anchored strictly at 13px.

- **IBM Plex Sans** is used exclusively for structural framing: section titles, table column headers, form inputs, metadata keys, and contextual guidance.
- **JetBrains Mono** (or IBM Plex Mono) is used strictly for technical payloads: monetary figures, ISO 8601 timestamps, durations (`412ms`), cron schedules (`*/15 * * * *`), CSS/XPath selectors, HTTP status codes, and execution hashes.

### Rules:
- All monospaced figures must be configured with tabular lining digits (`font-variant-numeric: tabular-nums`).
- Metric blocks display numbers in `mono-metric` with the measurement unit directly appended in `mono-sm` using the muted color token (e.g., `482` in ink, `ms` in muted).
- Section labels must use `label-caps` in all uppercase to clearly distinguish metadata fields from dynamic data values.

## Layout & Spacing

The layout uses a tight, dense grid structure optimized for high-density horizontal screen real estate.

### Shell & Grid
- **Desktop (>=1200px):** Single-window dashboard layout. Static top telemetry rail (single-instance process stats), a 3/4 primary tabular execution log, and a 1/4 inspector sidebar showing run details (DOM snapshot diff, selector debug output, request trace).
- **Tablet (768px - 1199px):** Top rail collapses into a 2x2 grid. The run detail sidebar shifts underneath the log table into an accordion or tabbed view.
- **Mobile (<768px):** Linear stack. Tables switch to horizontally scrollable raw matrices with fixed first-column identifiers.

### Alignment Principles
- Element vertical rhythm is based on a rigid 4px unit increment.
- Content margins use strict 1px rules as borders rather than airy whitespace. Elements touch border-to-border in compound cards (split panes) without interstitial margin buffers.

## Elevation & Depth

This system avoids drop shadows, blurred ambient lighting, and simulated physical heights. The UI remains entirely flat.

Depth is expressed through a two-surface system framed with 1px hairlines:
- **Base Canvas (`#0E1113` / `#F6F7F5`):** The ground layer for the tool frame.
- **Panel Surface (`#161B1E` / `#FFFFFF`):** Every card, table head, row group, and modal sits on this single surface tier.
- **Hairline Framing:** Separation between planes and columns relies entirely on 1px solid `rule` boundaries (`#252C30` in dark, `#DDE1DE` in light).

When interactive states occur (hovering a run record, focusing an input):
- Background subtly shifts by 3-5% lightness (`#1B2226` in dark mode).
- Outline rules remain 1px, shifting from `rule` to `muted` or the corresponding state color (`ok`, `retried`, `failed`).

## Shapes

The design system uses a strict 4px radius (`roundedness: 1`).

- Panels, tables, modal overlays, code containers, and inputs maintain a uniform `border-radius: 4px`.
- Status pills, inline tags, and buttons maintain `border-radius: 2px` to 4px. No circular pills (`border-radius: 9999px`) are permitted; all tags are geometric rectangles.
- Tabular data rows inside bordered tables have square corners (`0px`), keeping the outer perimeter at `4px`.

## Components

### Buttons & Trigger Controls
- **Style:** Compact height (28px). 1px solid border using `rule`. Background matches `surface`.
- **States:** Hover shifts background to Canvas Base; Active darkens slightly.
- **Manual Trigger Button:** "Run Once" / "Force Scrape": Ink text on `surface` with an accent dot indicator. When running, the label switches immediately to "Running (pid: 24192)" with a non-animated monospaced millisecond counter.

### Status Indicators & Badges
- No pill shapes. Badges are squared tags (padding: `2px 6px`, font: `mono-sm`, border: 1px solid).
- **OK:** Text `#4E9B76`, border `rgba(78, 155, 118, 0.3)`, background `transparent`.
- **Retried:** Text `#C79242`, border `rgba(199, 146, 66, 0.3)`, background `transparent`. Displays attempt number inline: `RETRY (2/3)`.
- **Failed:** Text `#C4594A`, border `rgba(196, 89, 74, 0.3)`, background `transparent`. Displays exit code or HTTP code inline: `ERR (403)`.

### Run Log Table
- **Header:** Uppercase `label-caps` in `muted` foreground. 28px height, bottom bordered with 1px `rule`.
- **Rows:** 32px height, single-line text, full tabular alignment. Right-aligned for duration, record count, and parsed price. Left-aligned for job ID, timestamp, and selector path.
- **Hover:** Complete row highlights with a subtle surface wash (`#1B2226`).

### Input Fields (Selectors, Schedulers)
- Monospaced inputs for cron intervals (`cron-expr`) and selectors (CSS/XPath).
- Inset padding: `6px 8px`. 1px border with `rule`. On focus, border transitions directly to `ink` without ambient glow rings.

### Price & Extraction Record Cards
- Displays target product price deltas.
- Layout: Top header showing target URL and extraction selector (`div.price > span.current`). Main metric shows current detected price, inline subtext indicates delta relative to previous tick (`-0.04 USD`), followed by run execution time (`142ms`).