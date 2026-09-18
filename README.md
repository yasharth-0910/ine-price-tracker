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

React + Vite on Vercel, Express + TypeScript on Render, Supabase Postgres, undici + cheerio for
the scheduled scrape, Playwright for the headed demo, cron-job.org for the trigger.

## Scraping schedule

Every 2 hours, at :00. A second cron hits `/health` 5 minutes earlier to wake the Render instance,
which sleeps after 15 minutes of inactivity. The scrape endpoint responds 202 immediately and
processes in the background so the cron client does not time out.

| job | schedule | target |
|---|---|---|
| warm-up | `55 1,3,5,7,9,11,13,15,17,19,21,23 * * *` | `GET /health` |
| scrape | `0 */2 * * *` | `POST /api/cron/scrape` with `x-cron-secret` |

A product scraped within the last 90 minutes is skipped, so a duplicate trigger cannot write a
duplicate history row.

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
npm run scrape:once     # one real run against the live store
npm run scrape:headed   # Playwright headed run, add --chaos to force retries
npm run verify:scrape   # fault-injection harness against a local chaos server
```

## Deploy

TODO once Phase 5 is done: Render settings, Vercel settings, cron-job.org config, CORS origin.

## Design note

See `docs/DESIGN-NOTE.md`.
