# PLAN

The loop state. Claude Code reads this at the start of every session and updates it at the end.
Work one phase at a time. A phase is done when its exit check passes, not when the code looks right.

Current phase: **1** (skeleton built; Supabase + Render provisioning still open)

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

- [ ] `catalog-crawl.ts`: walk `/api/product/{id}` for ids 1..1000 and upsert each into a
      `store_catalog` table. `/api/catalog` returns randomised order and caps `pageSize` at 60,
      so paging cannot guarantee coverage; crawl by id instead.
- [ ] `store-client.ts`: search by partial name against `store_catalog` with `ILIKE`, build a
      product URL, fetch one product
- [ ] `GET /api/store/search?q=` runs against the cached catalogue (the store has no search endpoint)
- [ ] Handles an empty query, a query with no matches, and the store being slow

**Exit:** `curl "$API/api/store/search?q=a"` returns real products, and `store_catalog` holds
1000 distinct rows.

## Phase 3 — Scrape core

- [ ] `Fetcher` interface, `HttpFetcher`
- [ ] Extraction ladder with all four rungs, winning rung recorded
- [ ] `parsePrice` handles currency symbols, thousands separators, decimals, whitespace
- [ ] Retry loop with jittered backoff, per-attempt timeout, per-product budget
- [ ] Validation gate
- [ ] Persistence: history row on success only, log row on every attempt
- [ ] `npm run scrape:once` against the live store

**Exit:** `npm run verify:scrape` passes all cases in Phase 4's harness. Write the harness first.

## Phase 4 — Fault-injection harness (write this before Phase 3 code)

`scripts/chaos-server.ts` serves a local fake `/product/{id}` page plus its `/api/layout`,
`/api/challenge`, `/api/session` and `/api/products/{id}/price` responses. It no longer
misbehaves on demand: the price path is a browser path now, so `scripts/verify-scrape.ts`
drives the `BrowserFetcher` against the fake page and injects every fault with Playwright's
`page.route()` on the `/api/products/{id}/price` request, not with a plain HTTP chaos server.

Cases (faults injected via `page.route()` on the price request unless noted):

- [ ] happy path, one attempt, one history row, one log row, status `success`
- [ ] 500 then 500 then 200 -> one history row, three log rows, status `retried`
- [ ] 500 x3 -> zero history rows, three log rows, status `failed`
- [ ] slow response past the timeout -> `timeout` error code, retried
- [ ] price node missing (element under `classes.priceValue` absent) -> `parse_empty`, retried, not stored
- [ ] price `"N/A"` under `classes.priceValue` -> `parse_invalid`, not stored
- [ ] price request delayed 3s (via `page.route()`) -> succeeds on the browser fetcher
- [ ] 404 -> one attempt only, no retry
- [ ] two runs in the same window -> second logs `skipped_recent`, no duplicate row
- [ ] product B succeeds while product A fails in the same run
- [ ] a click is silently dropped (injected in the fake page's Reveal handler, mimicking `Xn`):
      the price block stays `price-idle`, no price request fires, and the scraper re-clicks
      rather than re-requests

**Exit:** `npm run verify:scrape` prints all green and exits 0.

## Phase 5 — API and cron

- [ ] Product CRUD routes
- [ ] History and logs routes with range filtering
- [ ] `POST /api/cron/scrape` with secret, 202 + run_id, background processing, self-ping
- [ ] Deploy, set env vars on Render
- [ ] cron-job.org: warm-up job and scrape job, both configured

**Exit:** two consecutive real cron runs land in Supabase, verified by querying the tables.
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
