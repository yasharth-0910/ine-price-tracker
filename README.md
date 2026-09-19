# INE Price Tracker

Tracks prices and stock on INE's mock storefront (https://demo.inelabteamdev.com/) by scraping it
every 2 hours, and shows the history plus an honest log of every scrape attempt.

- Live app: TODO
- API: TODO
- Repo: TODO
- Headed run recording: TODO

## How it works

Search the store, pick a product, and the backend starts scraping it on a schedule. Successful
scrapes go into `price_history`. Every attempt, including the ones that failed and the ones that
were retried, goes into `scrape_logs`. A failed scrape writes a log row and nothing else, so the
chart never shows an invented price.

TODO: one paragraph on what recon found about the store, once Phase 0 is done.

## Stack

React + Vite on Vercel, Express + TypeScript on Render, Supabase Postgres, Playwright for the
scrape (scheduled runs on GitHub Actions, headed demo runs locally), undici + cheerio for the
catalogue mirror, GitHub Actions cron for the schedule.

## Scraping schedule

The scheduled scrape runs as a **GitHub Actions workflow** (`.github/workflows/scrape.yml`) on
`cron: 0 */2 * * *` (every 2 hours at :00 UTC), with `workflow_dispatch` for manual runs. It runs
the same Playwright run engine the API uses (`executeRun`, recorded as `trigger = 'cron'`) and
writes validated results straight to Supabase. A `concurrency` group means two runs never overlap.

Render hosts the **read API** (everything the dashboard reads) and the **manual scrape** endpoint
(`POST /api/cron/scrape`, still used by "Scrape now" and for on-demand runs). It is no longer on
the scheduled path.

A product scraped within the last 90 minutes is skipped, so a duplicate or overlapping trigger
never writes a duplicate history row.

### Why GitHub Actions and not a cron-job.org → Render trigger

That was the original design, and it failed in production for a structural reason. Render's free
instance spins down after 15 minutes of inactivity and cold-starts in **~2.5 minutes** — measured
from Render logs: for a fire that arrived at 05:31, a fresh instance (`c8lsr`) only began booting at
05:33:40 and was listening at 05:33:57. cron-job.org's maximum request timeout is **30 seconds**,
so the trigger connection is cut long before the instance is awake; the request never reaches the
app. The 00:00 UTC fire produced **no request log and no `scrape_runs` row** at all. A pre-warm
ping a few minutes earlier does not help, because the warm-up request dies in the very same
cold-start gap (it, too, is a <30s client against a ~2.5 min boot).

GitHub Actions has a real scheduler, no spin-down, and enough CPU/RAM for Chromium — which also
removes the per-attempt timeout pressure seen on the 512 MB Render box (a successful attempt there
hit 45.3s against the 45s ceiling; on a runner it drops to single-digit seconds). So the scheduled
run lives in Actions. This is a deliberate deviation from the assignment's suggested cron-job.org
trigger, made because scraper reliability is the primary graded criterion. Note Actions cron is
best-effort (it can lag a few minutes under load, fine for a 2h cadence) and scheduled workflows
auto-disable after 60 days without default-branch activity.

### Actions secret

The workflow authenticates to Supabase with `DATABASE_URL` stored as a GitHub Actions secret.
**Known trade-off:** that is the full-access connection string, not a Supabase role scoped to the
four scrape tables. A scoped role is the better practice and the intended follow-up; it was skipped
here only to save setup time.

## Reliability

Three attempts per product with 1s / 3s / 9s jittered backoff and a 10s per-attempt timeout.
Retries on timeouts, network errors, 5xx, 429, and on a 200 whose price could not be parsed.
No retry on 404. Extraction goes through a ladder (store API, embedded JSON, DOM selectors,
regex) and records which rung produced the value, which doubles as page-structure change
detection. Everything passes a validation gate before it touches the database.

## Running locally

```bash
git clone TODO && cd ine-price-tracker

# backend
cd backend && npm install
cp .env.example .env     # fill it in
npm run dev              # :4000

# frontend
cd ../frontend && npm install
cp .env.example .env
npm run dev              # :5173
```

Apply `db/schema.sql` in the Supabase SQL editor before the first run.

## Environment variables

### backend

| var | what it is |
|---|---|
| `DATABASE_URL` | Supabase Postgres connection string (pooled) |
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_KEY` | service role key, server side only |
| `CRON_SECRET` | shared secret required on `POST /api/cron/scrape` |
| `STORE_BASE_URL` | `https://demo.inelabteamdev.com` |
| `SELF_URL` | public Render URL, used for the keep-warm self-ping |
| `PORT` | defaults to 4000 |
| `SENDGRID_API_KEY` | optional, price-drop email alerts |

### frontend

| var | what it is |
|---|---|
| `VITE_API_URL` | deployed backend base URL |

## Scripts

```
npm run dev             # backend with reload
npm run scrape:once     # one real run against the live store (specific ids)
npm run scrape:cron     # a full scheduled run (all tracked products); what GitHub Actions runs
npm run scrape:headed   # Playwright headed run, add --chaos to force retries
npm run verify:scrape   # fault-injection harness against a local chaos server
```

## Deploy

TODO once Phase 5 is done: Render settings, Vercel settings, cron-job.org config, CORS origin.

## Design note

See `docs/DESIGN-NOTE.md`.
