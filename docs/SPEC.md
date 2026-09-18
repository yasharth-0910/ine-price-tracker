# SPEC

Requirements as checkable statements. Each one is either true of the running system or it isn't.

## Functional

- **F1** A user can search the mock store by partial or full product name and see matching products.
- **F2** A user can track a product. Tracked products persist in Supabase across restarts.
- **F3** Every tracked product is scraped on a fixed 2 hour schedule, triggered externally.
- **F4** A user can see price and stock history for a tracked product as a chart and a table.
- **F5** A user can see a per-product scrape log with a timestamp and outcome for every attempt.
- **F6** The scraper can be run in headed mode against the real store from the command line.
- **F7** A user can untrack a product. History is kept, scraping stops.

## Invariants (the graded part)

- **INV-1** No row in `price_history` was written by a scrape that did not pass validation.
- **INV-2** Every scrape attempt has exactly one row in `scrape_logs`.
- **INV-3** `price` is always a finite number greater than 0 and less than 1,000,000.
- **INV-4** `stock_status` is always one of `in_stock`, `low_stock`, `out_of_stock`.
- **INV-5** A failed run never advances `products.last_success_at`.
- **INV-6** Calling the cron endpoint twice inside the same window does not produce duplicate
  history rows for a product. Second call is a no-op with a logged reason.
- **INV-7** One product failing does not prevent the others in the run from being scraped.
- **INV-8** A run finishes and records `finished_at` even if every product in it fails.

## Scrape outcomes

| status | meaning |
|---|---|
| `success` | first attempt worked, validated, history row written |
| `retried` | an earlier attempt failed, a later one succeeded, history row written |
| `failed` | all attempts exhausted, no history row |

Error codes on a failed attempt: `timeout`, `http_5xx`, `http_429`, `http_404`, `network`,
`parse_empty`, `parse_invalid`, `validation_failed`.

## API

```
GET    /health                        -> { ok, version, uptime }
GET    /api/store/search?q=           -> live search against the mock store
GET    /api/products                  -> tracked products + latest price + 24h delta
POST   /api/products                  -> { source_product_id } track it
DELETE /api/products/:id              -> untrack
GET    /api/products/:id              -> product + latest snapshot + health
GET    /api/products/:id/history      -> ?range=24h|7d|all
GET    /api/products/:id/logs         -> ?limit=50, newest first
POST   /api/products/:id/scrape       -> manual single scrape, for the demo
POST   /api/cron/scrape               -> header x-cron-secret, returns 202 + run_id
GET    /api/runs                      -> recent runs with counts
```

## Screens

1. **Dashboard** Tracked product cards: name, current price, 24h change, stock pill, last scraped,
   a small sparkline, and a warning badge if `consecutive_failures > 2`. Search bar opens the
   add-product flow. Header shows last run time and its success/fail counts.
2. **Product detail** Price line chart over time, stock shown as a band or colour under the line,
   a history table, and the scrape log table with coloured status pills. Attempt count visible.
3. **Add product** Search the store live, results list, track button on each row.

## Out of scope

Auth, multi-user, pagination beyond a sane limit, mobile-first polish, tests beyond the
fault-injection harness.
