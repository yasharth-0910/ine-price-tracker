# ARCHITECTURE

## Shape

```
cron-job.org  --POST /api/cron/scrape-->  Render (Express)  <-->  Supabase
                                                |
                                                +--> demo.inelabteamdev.com

Vercel (React)  --REST-->  Render
```

## The one idea worth explaining

There is a single scrape core. The only thing that varies between the scheduled run and the headed
demo is which fetcher gets injected.

```ts
interface Fetcher {
  name: 'http' | 'browser';
  get(url: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<FetchResult>;
  dispose(): Promise<void>;
}

type FetchResult = { status: number; body: string; elapsedMs: number; finalUrl: string };
```

`HttpFetcher` is undici with a timeout and a real user agent. `BrowserFetcher` is Playwright,
waits for the price node to appear, then hands back `page.content()`. Retry, extraction,
validation and persistence sit above both and do not know which one they got.

This matters for the recording. The headed run shows the same retry ladder the cron uses, not a
separate script written to look good on camera.

## Extraction ladder

Rungs are tried in order. First one that produces a valid price wins. The rung that won is stored
on both the history row and the log row.

| rung | strategy | notes |
|---|---|---|
| 1 | `json_api` | direct call to the store's data endpoint if one exists |
| 2 | `embedded_json` | JSON inside a `<script>` tag in the HTML |
| 3 | `dom` | cheerio selectors against the rendered markup |
| 4 | `regex` | currency pattern over the text content, last resort |

Structure-change detection falls out of this for free. Store the winning rung per product. If a
product that has been succeeding on rung 1 starts succeeding on rung 3, or starts failing rung 1
entirely, set `layout_alert = true` and surface it on the dashboard.

## Retry policy

- 3 attempts per product per run.
- Backoff 1s, 3s, 9s, each with up to 400ms of jitter so parallel products don't sync up.
- Per-attempt timeout 10s via `AbortController`. Total per-product budget 45s, hard stop.
- Retry on: `timeout`, `network`, `http_5xx`, `http_429`, `parse_empty`, `parse_invalid`.
- Do not retry on: `http_404`. Log it, mark the product, move on.
- Concurrency limit 3 products at a time. Render free has 512MB and the store is not ours to hammer.

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
    extract/        ladder.ts  rungs.ts  parsePrice.ts  parseStock.ts
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

- HTTP + cheerio for the schedule, Playwright only for the demo. A browser per product every 2
  hours would not survive a 512MB free instance, and it isn't needed if the data is reachable.
- Retrying a parse failure treats a 200 with missing content as an error. Costs a few extra
  requests, prevents the entire class of silently-empty history rows.
- Flagging anomalies instead of rejecting them. Losing a real 70% price drop would be worse than
  storing one with a flag on it.
