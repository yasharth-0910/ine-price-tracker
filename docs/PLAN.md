# PLAN

The loop state. Claude Code reads this at the start of every session and updates it at the end.
Work one phase at a time. A phase is done when its exit check passes, not when the code looks right.

Current phase: **0**

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

- [ ] Repo, two workspaces (`backend`, `frontend`), TypeScript, eslint, `.env.example`
- [ ] Supabase project, run `db/schema.sql`
- [ ] `db/client.ts` connects, `GET /health` returns ok with a live DB ping
- [ ] Deploy backend to Render now, before there is anything worth deploying

**Exit:** the Render URL returns `{ ok: true }` and the DB ping is real.

## Phase 2 — Store client

- [ ] `store-client.ts`: search by partial name, build a product URL, fetch one product
- [ ] `GET /api/store/search?q=` works against the live store
- [ ] Handles an empty query, a query with no matches, and the store being slow

**Exit:** `curl "$API/api/store/search?q=a"` returns real products from the live store.

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

`scripts/chaos-server.ts` serves fake store pages and misbehaves on demand.
`scripts/verify-scrape.ts` points the core at it and asserts the invariants.

Cases:

- [ ] happy path, one attempt, one history row, one log row, status `success`
- [ ] 500 then 500 then 200 -> one history row, three log rows, status `retried`
- [ ] 500 x3 -> zero history rows, three log rows, status `failed`
- [ ] slow response past the timeout -> `timeout` error code, retried
- [ ] 200 with the price node missing -> `parse_empty`, retried, not stored
- [ ] 200 with price `"N/A"` -> `parse_invalid`, not stored
- [ ] price appears only after a 3s delay -> succeeds on the browser fetcher
- [ ] 404 -> one attempt only, no retry
- [ ] two runs in the same window -> second logs `skipped_recent`, no duplicate row
- [ ] product B succeeds while product A fails in the same run

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
- [ ] Design note from `NOTES.md`: reliability decisions, trade-offs, AI mistakes and fixes
- [ ] Bonus if time is left, in this order: price-drop alerts, per-product interval, GitHub Actions CI
- [ ] Repo public, live links checked from a logged-out browser
- [ ] Email with the exact subject line from the assignment, resume attached

**Exit:** sent, with the links opened in a private window first to confirm they work.
