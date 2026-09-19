# INE Price Tracker

A price and stock tracker for INE's mock storefront at https://demo.inelabteamdev.com. You search
the store, pick a product, and the app scrapes its price and stock every 2 hours and shows the
history plus an honest log of every scrape attempt. The store is deliberately hard to scrape, so
most of the work is in the scraper staying correct across many unattended runs, not the interface.

| | |
|---|---|
| Live site | https://ine-assignment.yasharth.xyz |
| API | https://ine-price-tracker.onrender.com |
| Repository | https://github.com/yasharth-0910/ine-price-tracker |
| Headed run recording | TODO: add link |

## How the store works and what it forced

The catalogue and product metadata are plain JSON at `/api/catalog`, `/api/product/{id}`, and
`/api/layout`. The price is not. It sits behind a per-request WebAssembly proof-of-work at
`/api/challenge`, a session exchange, and a signed short-lived bearer token, and the page only
reveals it after some simulated mouse movement. So the price path runs in a real browser (Playwright)
and lets the page solve its own challenge, while the catalogue and metadata use plain HTTP.

Three specifics shaped the code:

The store has no search endpoint, so search runs against a local mirror of the catalogue. The
`store_catalog` table is filled by walking `/api/product/{id}` for ids 1 to 1000, and search is an
`ILIKE` over that mirror.

The `price-success` block contains several price-shaped nodes, and two of them are `display:none`
decoys holding the real price scaled by a factor of 0.6 to 1.3, which makes them plausible and wrong.
The scraper reads only the element carrying the class named in `/api/layout` and treats `.price-value`
and `[data-price]` as a deny list. The layout class names rotate per window, so the selector map is
fetched at scrape time and cached until its `validUntil`, never hardcoded.

The price renders in one of six format variants (comma grouping replaced by spaces, by periods with
`,00` appended, a trailing tax string, fullwidth Unicode digits, non-breaking and zero-width spaces,
and Indian lakh grouping). The parser normalises the string before parsing rather than calling
`parseFloat` on it, and validates the result.

## Architecture

There is one scrape core. It does not know whether it was handed an HTTP fetcher or a browser
fetcher; retry, extraction, validation, and persistence sit above both. The catalogue and metadata
use the HTTP fetcher, and the price reveal uses the browser fetcher in every run. The only difference
between a scheduled run and a demo run is whether that browser is headless.

```
GitHub Actions (every 2h)  --Playwright-->  demo.inelabteamdev.com
        |                                          
        +--writes-->  Supabase Postgres  <--reads--  Render (Express API)  <--REST--  Vercel (React)
```

| Piece | Technology | Host |
|---|---|---|
| Frontend | React, Vite, TypeScript, Tailwind | Vercel |
| API | Node 20, Express, TypeScript | Render (free) |
| Database | Supabase Postgres | Supabase |
| Scheduled scrape | Playwright, the same run engine the API uses | GitHub Actions |
| Catalogue and metadata | undici and cheerio | Render, and the Actions runner |

The scheduled scrape writes directly to Supabase. Render hosts the read API that the dashboard uses
and the manual scrape endpoint, and is not on the scheduled write path.

## Scraping schedule

The schedule is every 2 hours. It runs as a GitHub Actions workflow (`.github/workflows/scrape.yml`,
cron `0 */2 * * *`, with manual dispatch) that runs the same run engine and writes validated results
to Supabase. A `concurrency` group prevents two runs from overlapping.

The obvious approach, cron-job.org hitting a Render endpoint, was built first and failed in
production. Render's free instance spins down after 15 minutes of inactivity and cold starts in about
2.5 minutes (measured from the logs: a fire arrived at 05:31 and a fresh instance only finished
booting at 05:33:57), which is longer than cron-job.org's 30 second request cap, so the trigger
connection is cut before the instance is awake and the request never reaches the app. A warm-up ping
a few minutes earlier does not help because it dies in the same cold-start gap. GitHub Actions has a
real scheduler, no spin-down, and enough memory for Chromium, so the scheduled run lives there.

A product scraped within 0.75 of its configured interval, which is 90 minutes at the 2 hour default,
is skipped and logged as `skipped_recent`. A duplicate or overlapping trigger therefore never writes
a second history row.

## Reliability

Each product gets 3 attempts per run, with 1s, 3s, and 9s of backoff between them plus up to 400ms of
jitter, and a 45s per-attempt timeout enforced with an `AbortController`. Retries fire on `timeout`,
`network`, `http_5xx`, `http_429`, and on a 200 response whose price could not be parsed
(`parse_empty`, `parse_invalid`) or failed validation. A 404 is terminal and is not retried.
Concurrency is one product at a time through a shared browser context, and the browser is recycled
every 2 products so Chromium stays under the 512 MB free-instance ceiling.

Validation runs before any write. A reading is rejected, and the attempt is recorded as failed, if
the price does not parse to a finite number, is not greater than 0 and less than 1,000,000, or if the
stock text does not map to `in_stock`, `low_stock`, or `out_of_stock`. A move of more than 60% from
the previous price is stored but flagged `anomalous` rather than dropped, because the store changes
prices frequently by design and discarding a real large move would lose real data.

The history is written honestly. `price_history` receives a row only on a validated success. A failed
or empty scrape writes a `scrape_logs` row and nothing else, so there are no null, zero, or
placeholder prices. Every attempt writes exactly one `scrape_logs` row, so a product that succeeded on
the third attempt reads differently from one that succeeded on the first. Each log row records the
HTTP status of the underlying price request, captured from the browser's response event rather than
inferred from the page load, so a 200 page that served a 503 for the price reads as the failure it is.

## Running locally

You need Node 20, a local Postgres, and Playwright's Chromium.

```
git clone https://github.com/yasharth-0910/ine-price-tracker && cd ine-price-tracker

# database
createdb ine_local
psql ine_local -f db/schema.sql

# backend
cd backend
npm install
npx playwright install chromium
cp .env.example .env          # set DATABASE_URL=postgres://localhost/ine_local, CRON_SECRET, CORS_ORIGINS
npm run dev                   # http://localhost:4000

# frontend
cd ../frontend
npm install
cp .env.example .env.local    # VITE_API_URL=http://localhost:4000
npm run dev                   # http://localhost:5173
```

Search reads the local catalogue mirror, which is empty on a fresh database, so run `npm run crawl`
in `backend` to fill `store_catalog` before search returns results. Run `npm run scrape:once` to
record a real price for a product.

## Environment variables

Backend:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Postgres connection string. The client sets `prepare: false` because the deployment uses Supabase's transaction pooler on port 6543, which does not keep prepared statements. |
| `CRON_SECRET` | yes | Shared secret required in the `x-cron-secret` header on `POST /api/cron/scrape`. |
| `CORS_ORIGINS` | yes in production | Comma-separated browser origins allowed to call the API, no trailing slash. |
| `STORE_BASE_URL` | no | Mock store base URL. Defaults to https://demo.inelabteamdev.com. |
| `SELF_URL` | no | Public Render URL, pinged every 4 minutes during a run so a long run does not spin the instance down. |
| `PORT` | no | HTTP port. Defaults to 4000. |
| `LOG_LEVEL` | no | pino log level. Defaults to `info`. |

Scrape and alert behaviour is tunable through `SCRAPE_ATTEMPTS`, `SCRAPE_ATTEMPT_TIMEOUT_MS`,
`SCRAPE_BACKOFF_MS`, `SCRAPE_JITTER_MS`, `SCRAPE_BUDGET_MS`, `SCRAPE_BROWSER_RECYCLE_EVERY`,
`SCRAPE_IDEMPOTENCY_MINS`, and `ALERT_PRICE_DROP_PCT`. The defaults match the numbers in the
Reliability section.

Frontend:

| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | yes | Backend base URL. Vite bakes it into the bundle at build time, so changing it requires a redeploy. |

The GitHub Actions scheduled scrape needs `DATABASE_URL` as a repository secret.

## Scripts

Backend:

| Command | What it does |
|---|---|
| `npm run dev` | API with reload on port 4000 |
| `npm run crawl` | Fill `store_catalog` by walking `/api/product/{id}` for ids 1 to 1000 |
| `npm run scrape:once` | One real run against the live store for the given ids, writing to `DATABASE_URL` |
| `npm run scrape:cron` | A full run over all tracked products, which is what GitHub Actions runs |
| `npm run cron:local` | Call the local cron endpoint the way an external trigger would |
| `npm run verify:scrape` | Fault-injection harness, 12 cases against a local fake store |
| `npm run typecheck` | `tsc --noEmit` |

Frontend:

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | `tsc -b && vite build` |
| `npm run typecheck` | `tsc --noEmit` |

## Database schema

| Table | Purpose |
|---|---|
| `products` | Tracked products. `source_product_id` is the bare store id, `scrape_interval_mins` defaults to 120, and the row carries `last_success_at`, `consecutive_failures`, and `layout_alert`. |
| `store_catalog` | Local mirror of the store catalogue for ids 1 to 1000, queried by search. |
| `scrape_runs` | One row per run: trigger, start and finish times, and the succeeded, failed, and skipped counts. |
| `price_history` | One row per validated success: price, currency, stock, `stock_qty`, `layout_revision`, `layout_variant`, `extraction_source`, `raw_price`, and `anomalous`. |
| `scrape_logs` | One row per attempt: `attempt_no`, status (`success`, `retried`, `failed`, `skipped_recent`), `http_status`, `duration_ms`, `error_code`, and `error_message`. |
| `alerts` | `price_drop`, `back_in_stock`, and `layout_change` events, each with old and new values and a `seen` flag. |

The full schema is in `db/schema.sql`. Incremental changes are in `db/migrations`, and the migrations
are idempotent so applying them on top of a fresh `schema.sql` is a no-op.

## What is implemented

| Requirement | Status | Where |
|---|---|---|
| Search the store by partial or full name | Done | `SearchTrack`, `GET /api/store/search` over `store_catalog` |
| Track a product and persist it | Done | `POST /api/products` |
| Scrape each tracked product every 2 hours | Done | `.github/workflows/scrape.yml` |
| Price and stock history as chart and table | Done | Product detail page |
| Per-product scrape log with every attempt | Done | Product detail page, `GET /api/products/:id/logs` |
| Observable headed run and recording | Pending | See Known limitations |

Bonuses:

| Bonus | Status |
|---|---|
| Price-drop and back-in-stock alerts (in-app) | Done |
| Change detection when the page structure changes | Done, via `layout_alert` from `/api/layout` revision changes |
| Configurable scrape frequency per product | Done, via `PATCH /api/products/:id` |
| CI with GitHub Actions | Done, `.github/workflows/ci.yml` |
| Dashboard across multiple products with extra product info | Done |

## Known limitations

The headed run and its screen recording are not built yet. The scheduled and manual scrapes run
headless through the same core, and `npm run scrape:once` prints a per-attempt trace, but a dedicated
headed script for the recording is the remaining core deliverable.

Price-drop alerts compare each reading against the immediately previous one, so a slow drift, for
example 4% per scrape, does not trip the 5% threshold even when the total fall is large.

The GitHub Actions workflow holds `DATABASE_URL` as a repository secret, which is broader access than
a Supabase role scoped to the four scrape tables would grant. A scoped role is the intended follow-up.

GitHub Actions cron is best effort and can be delayed by several minutes under load. For a 2 hour
cadence this is acceptable.

GitHub scheduled workflows auto-disable after 60 days without a commit to the default branch, so the
schedule stops if the repository sits idle that long.
