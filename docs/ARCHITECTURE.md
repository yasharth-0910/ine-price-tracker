# ARCHITECTURE

Read CLAUDE.md, docs/PLAN.md and docs/STORE.md. STORE.md (the recon) supersedes this file where
they conflict; this document has been reconciled to it.

## Shape

```
cron-job.org  --POST /api/cron/scrape-->  Render (Express)  <-->  Supabase
                                                |
                                                +--> demo.inelabteamdev.com

Vercel (React)  --REST-->  Render
```

## The one idea worth explaining

There is a single scrape core. HTTP fetches the catalogue and metadata (`/api/catalog`,
`/api/product/{id}`, `/api/layout`); the price reveal is a browser path in every run, because the
price sits behind a per-request WASM proof-of-work and a signed short-lived token (see STORE.md).
So `BrowserFetcher` is the primary fetcher for the price, scheduled and demo alike. The only thing
that varies between the scheduled run and the headed demo is whether that browser runs headless.

```ts
interface Fetcher {
  name: 'http' | 'browser';
  get(url: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<FetchResult>;
  dispose(): Promise<void>;
}

type FetchResult = { status: number; body: string; elapsedMs: number; finalUrl: string };
```

`HttpFetcher` is undici with a timeout and a real user agent, used for the JSON endpoints only.
`BrowserFetcher` is Playwright: it loads `/product/{id}`, drives the interaction gate, clicks
Reveal, lets the page solve its own challenge, waits for `price-success`, then hands back
`page.content()`. Retry, extraction, validation and persistence sit above both and do not know
which one they got.

This matters for the recording. The headed run shows the same retry ladder the cron uses, not a
separate script written to look good on camera.

## Price extraction

No rung ladder. The price is read from one place: the element carrying `classes.priceValue`.

- Selectors come from `/api/layout`, cached until its `validUntil`, never hardcoded. Class names
  rotate per window, so the map is fetched at scrape time and reused until it expires.
- The price is the text of the element with class `layout.classes.priceValue`, normalised (see the
  parser in STORE.md) and validated.
- `.price-value` and `[data-price]` are an explicit deny list. They are `display:none` decoys
  holding a copy of the real price scaled by 0.6 to 1.3 — plausible and wrong. Never read them.

Structure-change detection: store `revision` and `variant` from `/api/layout` on every scrape row.
A change in either is a structure change; set `layout_alert = true` and surface it on the dashboard.

## Retry policy

- 3 attempts per product per run.
- Backoff 1s, 3s, 9s, each with up to 400ms of jitter so parallel products don't sync up.
- Per-attempt timeout 10s via `AbortController`. Total per-product budget 45s, hard stop.
- Retry on: `timeout`, `network`, `http_5xx`, `http_429`, `parse_empty`, `parse_invalid`.
- Do not retry on: `http_404`. Log it, mark the product, move on.
- Concurrency 1: one product at a time, sharing a single browser context for the whole run.
  Chromium will not fit in 512MB at concurrency 3, and the store is not ours to hammer.

## Validation gate

Runs after extraction, before any write. Reject and treat as a failed attempt if:

- price does not parse to a finite number, or is <= 0, or >= 1,000,000
- price string contained a currency symbol or thousands separator that was silently dropped
  (parse deliberately, don't `parseFloat` a raw string)
- stock text does not map to the three known states
- price and stock came from different rungs

Anomaly, not rejection: if the price moved more than 60% from the last known value, still store it
but set `anomalous = true`. The store changes prices frequently by design, so refusing outliers
would throw away real data. Flagging is honest, dropping is not.

## What the scrape log records

Each attempt writes one `scrape_logs` row. Beyond the pass/fail outcome and error code, the row
carries the HTTP status of the underlying `/api/products/{id}/price` call, captured from
Playwright's `response` event on the page, not inferred from the top-level page load. That call is
where the injected failures live — an observed reveal returned 503 then succeeded on retry — so a
200 page hosting a 503 price request must read as the failure it is.

## Scheduling on a sleeping free tier

Render free spins down after 15 minutes idle and a cold start takes about 50 seconds, which is
longer than a cron client will wait. So:

1. A warm-up cron hits `GET /health` 5 minutes before each scrape window.
2. The scrape cron hits `POST /api/cron/scrape` with `x-cron-secret`. The handler validates the
   secret, inserts the `scrape_runs` row, responds `202 { run_id }` immediately, and does the work
   after the response.
3. While a run is active, a self-ping every 4 minutes to `/health` keeps the instance from
   spinning down mid-run.
4. Idempotency: the handler skips any product scraped within the last 90 minutes unless `?force=1`.
   A duplicate cron fire logs `skipped_recent` rather than writing a second history row.

## Module layout

```
backend/src/
  index.ts
  routes/           products.ts  store.ts  cron.ts  health.ts
  scrape/
    core.ts         orchestrate: attempt loop, backoff, persist
    fetchers/       http.ts  browser.ts
    extract/        layout.ts  parsePrice.ts  parseStock.ts
    validate.ts
    store-client.ts search + product url building
  db/               client.ts  queries.ts
  lib/              logger.ts  backoff.ts  concurrency.ts  env.ts
backend/scripts/
  headed.ts         Playwright, headed, with route interception for the demo
  verify-scrape.ts  fault-injection harness
  chaos-server.ts   local server that lies to you on purpose
```

## Trade-offs to write up in the design note

- Playwright for the price in every run, HTTP for the catalogue and metadata. The price is behind
  a per-request WASM proof-of-work and a signed token, so a browser is the reliable path; the
  catalogue is plain JSON and needs no browser. Concurrency 1 with a shared context keeps a single
  Chromium inside the 512MB free instance.
- Retrying a parse failure treats a 200 with missing content as an error. Costs a few extra
  requests, prevents the entire class of silently-empty history rows.
- Flagging anomalies instead of rejecting them. Losing a real 70% price drop would be worse than
  storing one with a flag on it.

