# PLAN

The loop state. Claude Code reads this at the start of every session and updates it at the end.
Work one phase at a time. A phase is done when its exit check passes, not when the code looks right.

Current phase: **5 code done** (routes + cron verified locally against ine_local + the live store).
Remaining for the Phase 5 exit: deploy to Render + wire cron-job.org (the two live-infra boxes).
Open from earlier: Render deploy (Phase 1). `db/migrations/002_*.sql` applied to Supabase in Phase 3.
Flagged: `.env.example` had a real Supabase connection string — placeholdered; rotate that credential
if it was ever committed.

---

## Phase 0 — Recon (manual, 30 min, do this yourself)

- [ ] `curl -s https://demo.inelabteamdev.com/ > /tmp/store.html` and read it
- [ ] DevTools, Network, XHR filter, reload. Record every request the page makes
- [ ] Find the search behaviour: query param, POST body, or client-side filter over a full list
- [ ] Find one product detail page and its price/stock markup or payload
- [ ] Time it: how late does content arrive, how often does a request fail, what status do you get
- [ ] Paste the findings into `docs/STORE.md`

**Exit:** `docs/STORE.md` exists and contains real response shapes, not guesses.
Nothing else starts until this is written.

## Phase 1 — Skeleton and database

- [x] Repo, two workspaces (`backend`, `frontend`), TypeScript, `.env.example` (eslint skipped for now)
- [ ] Supabase project, run `db/schema.sql` (manual — needs a real `DATABASE_URL`)
- [x] `db/client.ts` connects, `GET /health` returns ok with a live DB ping (ping is real: 503 when DB is unreachable, verified)
- [ ] Deploy backend to Render now, before there is anything worth deploying (`render.yaml` ready)

**Exit:** the Render URL returns `{ ok: true }` and the DB ping is real.
Skeleton + real ping done and verified locally. Remaining before this exit passes: provision
Supabase, run `db/schema.sql`, set `DATABASE_URL`, and deploy via `render.yaml`.

## Phase 2 — Store client and catalogue mirror

- [x] `catalog-crawl.ts`: walk `/api/product/{id}` for ids 1..1000 and upsert into `store_catalog`.
      Concurrency 5, retries transient 5xx, resumable (skips mirrored ids). Reached 1000/0 errors.
- [x] `store-client.ts`: `fetchProduct` / `fetchCatalogPage` / `fetchLayout` over undici, 10s
      timeout, no Playwright. (Search lives in the route, not this file.)
- [x] `GET /api/store/search?q=` runs `ILIKE` against the cached catalogue, limit 20
- [x] Handles empty query (echoes `query:""`), zero-result query (distinguishable), and slow store

**Exit:** `curl "$API/api/store/search?q=copperpot"` returns 20 real products, and `store_catalog`
holds 1000 distinct rows. Verified live.

Note: the store rate-limits under load (503s), so the crawl took a few resumable passes to reach
1000; a single fresh run won't get everything in one go. This is expected — re-run `npm run crawl`
until `errors=0`.

## Phase 3 — Scrape core

- [x] `Fetcher` interface, `HttpFetcher` (undici), `BrowserFetcher` (Playwright, drives the reveal)
- [x] Single-source extraction: read `classes.priceValue`, deny-list `.price-value` / `[data-price]`;
      layout cached until `validUntil`; `layout_revision` / `layout_variant` / `extraction_source` recorded
- [x] `parsePrice` handles the six variants: fullwidth digits, U+200B, U+00A0, spaced/euro
      separators, trailing tax text, lakh grouping/words, split carrier (self-check in the module)
- [x] `parseStock` maps the five phrasings; 0 => out_of_stock (self-check in the module)
- [x] Retry loop with jittered backoff, per-attempt timeout (AbortController), per-product budget
- [x] Validation gate before any write; anomaly (>60% move) flagged not rejected
- [x] Persistence: history row on success only, log row on every attempt, with the price request's http_status
- [x] `npm run scrape:once` against the live store — 1/647 succeed, 1001 fails fast as `http_404`
      (BrowserFetcher reconciled to the real DOM: `.price-block`, "Reveal price" button, mouse sweep,
      not-found detection). Runs against a local DB per the live-DB rule.

**Exit:** `npm run verify:scrape` passes all cases in Phase 4's harness. Write the harness first.
**Done:** 12/12 green, stable across repeated runs. Only `scrape:once` against the live store is
left — it can't be exercised here (real WASM PoW + live DB), so it rides along to a real run.

## Phase 4 — Fault-injection harness (write this before Phase 3 code)

Written (`backend/scripts/`), pending Phase 3 for green. `fake-store.ts` (the file PLAN earlier
called `chaos-server.ts`) serves a local fake `/product/{id}` page plus its `/api/layout`,
`/api/challenge`, `/api/session` and `/api/products/{id}/price` responses. It no longer
misbehaves on demand: the price path is a browser path now, so `verify-scrape.ts`
drives the `BrowserFetcher` against the fake page and injects every network-level fault with
Playwright route interception on the `/api/products/{id}/price` request (context-level, so it
survives the fresh page each retry creates); page-behaviour faults (dropped click, missing node,
N/A, late render) ride on query params on the product URL. The fake page's gate, decoy trap and
dropped-click/re-click were verified against a real Chromium; the eleven assertions run red only
because `src/scrape/core.ts` + `fetchers/browser.ts` do not exist yet. The harness fixes the
Phase 3 contract: `scrapeProduct(product, runId, fetcher)`, the per-attempt log statuses, the
error-code vocabulary, and the env-overridable timing knobs (see the header of `verify-scrape.ts`).

Cases (faults injected via `page.route()` on the price request unless noted):

- [x] happy path, one attempt, one history row, one log row, status `success`
- [x] 500 then 500 then 200 -> one history row, three log rows, status `retried`
- [x] 500 x3 -> zero history rows, three log rows, status `failed`
- [x] slow response past the timeout -> `timeout` error code, retried
- [x] price node missing (element under `classes.priceValue` absent) -> `parse_empty`, retried, not stored
- [x] price `"N/A"` under `classes.priceValue` -> `parse_invalid`, not stored
- [x] price request delayed 3s (via `page.route()`) -> succeeds on the browser fetcher
- [x] 404 -> one attempt only, no retry
- [x] two runs in the same window -> second logs `skipped_recent`, no duplicate row
- [x] product B succeeds while product A fails in the same run
- [x] a click is silently dropped (injected in the fake page's Reveal handler, mimicking `Xn`):
      the price block stays `price-idle`, no price request fires, and the scraper re-clicks
      rather than re-requests

**Exit:** `npm run verify:scrape` prints all green and exits 0.

## Phase 5 — API and cron

- [x] Product CRUD routes (`POST`/`DELETE`/`GET /api/products`, `GET /api/products/:id`)
- [x] History and logs routes with range filtering (`?range=24h|7d|all`); logs exclude `skipped_recent`
- [x] `POST /api/cron/scrape`: constant-time `x-cron-secret` (SHA-256 + timingSafeEqual, fails closed),
      202 + run_id, work after the response, concurrency 1 / shared context, 90-min idempotency skip
      logged as `skipped_recent`, 4-min self-ping of `SELF_URL/health`, `finished_at` always recorded
- [x] Manual single scrape (`POST /api/products/:id/scrape?force=1`), `GET /api/runs`, `npm run cron:local`
- [ ] Deploy, set env vars on Render (`CRON_SECRET`, `SELF_URL`, `DATABASE_URL`, `STORE_BASE_URL`)
- [ ] cron-job.org: warm-up job and scrape job, both configured

**Exit:** two consecutive real cron runs land in Supabase, verified by querying the tables.
Verified locally against `ine_local` + the live store: track -> manual/cron run -> real `price_history`
and `scrape_logs` rows, idempotent second call skips. The live-Supabase run is yours (live-DB rule).
**Do not start Phase 6 until this is live.** History only accumulates in real time.

## Phase 6 — Frontend

- [ ] Vite + React + Tailwind, API client, env for the backend URL
- [ ] Dashboard from the Stitch reference
- [ ] Product detail: Recharts line chart, history table, log table with status pills
- [ ] Add-product search flow
- [ ] Loading, empty and error states. An error must look like an error, not an empty chart
- [ ] Deploy to Vercel, set CORS on the backend

**Exit:** the Vercel URL shows real history from the overnight runs.

## Phase 7 — Headed run and recording

- [ ] `scripts/headed.ts` using `BrowserFetcher`, same core
- [ ] `--chaos` flag uses Playwright route interception: attempt 1 gets a 500, attempt 2 gets a 6s
      delay, attempt 3 passes through
- [ ] Console output shows attempt number, backoff, error code, final outcome
- [ ] Record 2 to 4 minutes: a clean run, then the chaos run, then the log row it produced in the UI

**Exit:** the recording shows a retry actually happening and the honest log entry that resulted.

## Phase 8 — Docs and submit

- [ ] README: setup, env vars, schedule, deploy steps, architecture summary
- [ ] README must also state (a) why the price path uses a browser while the catalogue path does
      not — the price sits behind a WASM proof-of-work at `/api/challenge`, the catalogue is plain
      JSON; and (b) that product search runs against a locally cached mirror of the store's own
      catalogue, because the store exposes no search endpoint
- [ ] Design note from `NOTES.md`: reliability decisions, trade-offs, AI mistakes and fixes
- [ ] Bonus if time is left, in this order: price-drop alerts, per-product interval, GitHub Actions CI
- [ ] Repo public, live links checked from a logged-out browser
- [ ] Email with the exact subject line from the assignment, resume attached

**Exit:** sent, with the links opened in a private window first to confirm they work.
