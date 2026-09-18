# Claude Code prompts

## The loop

Every phase runs the same four steps. Do not skip step 1, it is the entire point.

```
1. CHECK    write the thing that proves the phase works, before the phase works
2. BUILD    let Claude Code write code until the check passes
3. VERIFY   run the check yourself in your own terminal, not by asking if it passed
4. CLOSE    tick docs/PLAN.md, append to NOTES.md, commit, /clear
```

Rules that make the loop actually work:

- One phase per context window. Long sessions drift and start rewriting things that already
  worked. `/clear` between phases is not optional.
- The check is code, not a description. `npm run verify:scrape` exits 0 or it doesn't.
- If Claude Code changes the check to make it pass, that is the failure mode this whole setup
  exists to prevent. `CLAUDE.md` forbids it. Watch for it anyway in the diff.
- Never accept "it should work now". Run it.
- Commit at every green check. You want a bisectable history if Saturday goes sideways.

## Session opener (use every session)

```
Read CLAUDE.md and docs/PLAN.md. Tell me the current phase and its exit criteria in two lines,
then wait. Do not write code yet.
```

## Phase 0, recon writeup

Do the browsing yourself, then:

```
Here is what I found on the mock store. [paste the curl output, the XHR requests, the response
shapes, timings, any errors]

Write docs/STORE.md documenting exactly this: how search works, how a product page is fetched,
where price and stock live in the response, how late content arrives, and what failure modes I
observed. Record only what is in my paste. Mark anything you are inferring as an assumption to
be confirmed, in a separate section.
```

## Phase 1, skeleton

```
Phase 1. Set up the repo: backend/ (Node 20, Express, TypeScript, tsx for dev) and frontend/
(Vite, React, TS, Tailwind). Backend gets a postgres client using DATABASE_URL, env validation on
boot that exits with a clear message if a var is missing, a pino logger, and GET /health that
pings the DB and returns { ok, version, uptime, db_latency_ms }.

Also write .env.example for both, and a render.yaml. No business logic yet.
```

Then deploy to Render before moving on. Get the free-tier friction out of the way while the code
is trivial, not at 11pm on Saturday.

## Phase 2, store client

```
Phase 2. Read docs/STORE.md. Implement backend/src/scrape/store-client.ts with searchProducts(q)
and fetchProductPage(sourceId), using undici with a 10s timeout. Wire GET /api/store/search.

Constraints: no hardcoded product data, handle an empty query and a zero-result query distinctly,
and surface a store timeout as a 504 with a useful message rather than a 500.
```

## Phase 3+4, harness first, then the core

Run 4 before 3. Two prompts, two sessions.

```
Phase 4 first. Write scripts/chaos-server.ts: a local Express server that serves fake store
product pages and can be told to misbehave per route. Modes: ok, http500, http429, http404,
slow(ms), missing_price, price_na, late_render(ms).

Then scripts/verify-scrape.ts: points the scrape core at the chaos server and asserts every case
listed under Phase 4 in docs/PLAN.md. Each case asserts on the actual database rows, not on
return values: count of price_history rows, count and contents of scrape_logs rows, final status.
Print a pass/fail line per case and exit non-zero on any failure.

The scrape core does not exist yet. Write the harness against the interface in
docs/ARCHITECTURE.md and let it fail to import. That is expected.
```

New session:

```
Phase 3. Read docs/ARCHITECTURE.md and scripts/verify-scrape.ts. Implement the scrape core so
every case in the harness passes: the Fetcher interface, HttpFetcher, the four-rung extraction
ladder, parsePrice and parseStock, the retry loop with jittered backoff and per-attempt timeout,
the validation gate, and persistence.

Invariants from CLAUDE.md apply. In particular: a 200 that yields no parseable price is a failed
attempt and gets retried, and nothing is written to price_history unless validation passed.

Run npm run verify:scrape and iterate until it is green. Do not modify verify-scrape.ts. If you
believe a case in the harness is wrong, stop and tell me why instead of changing it.
```

When it goes green, immediately:

```
Now run npm run scrape:once against the live store with one real product. Show me the rows it
wrote to both tables. If the ladder fell through to a lower rung than expected, say so.
```

## Phase 5, API and cron

```
Phase 5. Implement the routes in docs/SPEC.md. Then POST /api/cron/scrape: validate x-cron-secret
in constant time, insert the scrape_runs row, respond 202 with run_id, and do the work after the
response returns. Concurrency 3. Skip any product scraped in the last 90 minutes and log
skipped_recent. While a run is active, self-ping SELF_URL/health every 4 minutes so Render does
not sleep mid-run. The run must record finished_at even if every product fails.

Add npm run cron:local that calls the endpoint against localhost so I can test it without cron.
```

## Phase 6, frontend

```
Phase 6. Read frontend/design/dashboard.html, which is a Stitch mockup. Build src/pages/Dashboard
as React + Tailwind matching its layout and colour choices, wired to the real API. Extract the
product card into its own component and pull the palette into tailwind.config.js.

Every async view needs three states. An error state must look like an error. A product with zero
successful scrapes shows "no data yet", never an empty chart that implies a flat price.
```

Then product detail, then the add-product modal, one session each.

## Phase 7, headed run

```
Phase 7. Write scripts/headed.ts: runs the same scrape core with BrowserFetcher (Playwright,
headless:false, slowMo so it is watchable) against the live store.

With --chaos, use page.route to make attempt 1 return a 500 and attempt 2 hang for 6 seconds past
the timeout, letting attempt 3 through clean. Log each attempt to the console with attempt number,
fetcher, elapsed ms, error code, backoff delay before the next try, and the final outcome with the
winning rung.
```

## Phase 8, docs

```
Phase 8. Fill in the TODOs in README.md from the real deployment. Then write
docs/DESIGN-NOTE.md, under 700 words: how the scraping was made reliable, the trade-offs from
docs/ARCHITECTURE.md with the reasoning, and the AI mistakes from NOTES.md with what actually
caught each one.

Plain direct prose, first person, no marketing tone, no em dashes, no bullet-point padding. It
should read like an engineer explaining a decision to another engineer, not like a report.
```

## Prompts worth running between phases

```
Read the diff since the last commit and tell me what an interviewer could ask me to change live
that I would struggle to explain. Be specific about lines.
```

```
Find every place where a failure could end up written to price_history. Trace the call paths,
do not just grep.
```

```
What in this codebase is more complicated than it needs to be for a two-day assignment?
```
