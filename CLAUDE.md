# CLAUDE.md

Read this before doing anything. Then read `docs/PLAN.md` to find the current phase.

## What this is

A price tracker for INE's mock storefront at https://demo.inelabteamdev.com/. A user searches the
store, picks a product, and the app scrapes its price and stock every 2 hours and shows the history.

The product price sits behind a WASM proof-of-work at /api/challenge and a signed short-lived
bearer token, so the price path runs in a browser and the catalogue path does not. docs/STORE.md is
the authority on how the store behaves and supersedes older docs where they conflict.

This is a hiring assignment. It is graded almost entirely on **scraper reliability**, not on UI.
Deadline: 2026-09-20, 23:59 IST. Submission goes out Sunday morning, so treat Saturday night as done.

## Stack (fixed by the assignment, do not substitute)

| Layer | Choice | Host |
|---|---|---|
| Frontend | React + Vite + TypeScript + Tailwind | Vercel |
| Backend | Node 20 + Express + TypeScript | Render (free) |
| DB | Supabase Postgres | Supabase |
| Scrape (scheduled) | Playwright | runs on Render |
| Catalogue + metadata | undici + cheerio (/api/catalog, /api/product/{id}, /api/layout only) | runs on Render |
| Scrape (headed demo) | Playwright | local only |
| Cron | cron-job.org hitting an HTTP endpoint | external |

No ORM. Use the `postgres` client or `@supabase/supabase-js` and plain SQL. No Next.js.

## Hard invariants

These are the grading criteria restated as rules. Never break one to make a phase pass.

1. `price_history` receives a row only when a scrape fully succeeded and passed validation.
   A failed scrape writes to `scrape_logs` and nothing else. No nulls, no zeroes, no placeholders.
2. Every attempt is logged, including the ones that were retried away. A product that succeeded
   on attempt 3 must look different in the log from one that succeeded on attempt 1.
3. A 200 response that yields no parseable price is a failure, not a success. Retry it.
4. No mock or seeded product data anywhere. Everything comes from the live store.
5. No secrets in the repo. Everything through env vars, documented in the README.
6. The cron endpoint is authenticated with a shared secret header and is safe to call twice.

## Working rules

- One phase per session. Finish it, run its verify command, then stop. The user makes every
  commit — never run `git commit` or `git push`, in any session.
- Never apply a migration or run any write (DDL or DML) against the live Supabase database. Write
  the migration file under `db/migrations/` and tell the user to run it. Local databases are fine
  for writes and for running `verify:scrape` / `scrape:once`.
- Before writing code for a phase, restate its exit criteria from `docs/PLAN.md` in one line.
- After each phase, tick the boxes in `docs/PLAN.md` and add anything you got wrong to `NOTES.md`.
- When you are unsure how the store behaves, go look at the real response. Do not guess a selector.
- If a verify script fails, fix the code, not the verify script. If the check itself is wrong,
  say so out loud and explain why before changing it.
- Prefer boring code. This gets read by an interviewer who may ask you to modify it live.

## NOTES.md

The submission includes a design note that has to say what the AI tools got wrong on the first
attempt. Log those honestly in `NOTES.md` as they happen, with the wrong version and the fix.
Do not write the entry as if you caught it yourself if the tests caught it.

## Commands

```
npm run dev            # backend on :4000
npm run verify:scrape  # fault-injection harness, must pass before any commit to scrape/
npm run scrape:once    # one real run against the live store
npm run scrape:headed  # Playwright, headed, for the screen recording
```
