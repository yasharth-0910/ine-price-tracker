// The scrape core: attempt loop -> classify -> extract -> validate -> persist. It does not know or
// care whether it was handed an HTTP or a browser fetcher. Contract (pinned by verify-scrape.ts):
//   - one scrape_logs row per attempt (success | retried | failed | skipped_recent)
//   - a price_history row ONLY on a validated success
//   - returned status: success (1 attempt), retried (>1, last won), failed, skipped_recent
import { sql } from '../db/client.js';
import { getLayout } from './extract/layout.js';
import { readPriceAndStock } from './extract/readPrice.js';
import { parsePrice } from './extract/parsePrice.js';
import { parseStock, type StockStatus } from './extract/parseStock.js';
import { validate, isAnomalous } from './validate.js';
import { ScrapeError, errorCodeOf } from './errors.js';
import type { Fetcher, FetchResult } from './fetchers/types.js';
import type { Layout } from './store-client.js';

export interface ProductInput {
  id: string;
  source_product_id: string;
  url: string;
}

export type ScrapeStatus = 'success' | 'retried' | 'failed' | 'skipped_recent';
export interface ScrapeOutcome {
  status: ScrapeStatus;
  attempts: number;
}

// Codes worth another attempt. A 404 is terminal; a validation failure is retried in case the page
// was mid-render, but a stable bad page still ends as failed after the budget.
const RETRYABLE = new Set(['timeout', 'network', 'http_5xx', 'http_429', 'parse_empty', 'parse_invalid', 'validation_failed']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config() {
  return {
    attempts: Number(process.env.SCRAPE_ATTEMPTS) || 3,
    attemptTimeoutMs: Number(process.env.SCRAPE_ATTEMPT_TIMEOUT_MS) || 10_000,
    backoff: (process.env.SCRAPE_BACKOFF_MS || '1000,3000,9000').split(',').map(Number),
    jitterMs: Number(process.env.SCRAPE_JITTER_MS ?? 400),
    budgetMs: Number(process.env.SCRAPE_BUDGET_MS) || 45_000,
  };
}

interface Extracted {
  price: number;
  raw: string;
  stock: StockStatus;
  stockQty: number | null;
  source: string;
}

export async function scrapeProduct(
  product: ProductInput,
  runId: string,
  fetcher: Fetcher,
  opts: { force?: boolean } = {},
): Promise<ScrapeOutcome> {
  const cfg = config();
  const fetcherName = fetcher.name ?? 'browser';

  // Idempotency: a product scraped successfully inside the window is skipped, logged, not re-fetched.
  // The window is PER-PRODUCT — 75% of its scrape_interval_mins — so a slightly-early scheduled fire
  // still runs, while a rapid double-trigger inside the window is skipped (INV-6). SCRAPE_IDEMPOTENCY_MINS
  // overrides it (used by the fault harness). `force` (a manual/forced trigger) bypasses the skip.
  const [row] = await sql<
    { last_success_at: Date | null; last_layout_revision: number | null; scrape_interval_mins: number }[]
  >`select last_success_at, last_layout_revision, scrape_interval_mins from products where id = ${product.id}`;
  const lastSuccess = row?.last_success_at ? new Date(row.last_success_at).getTime() : 0;
  const windowMins = Number(process.env.SCRAPE_IDEMPOTENCY_MINS) || Math.round((row?.scrape_interval_mins ?? 120) * 0.75);
  if (!opts.force && lastSuccess && Date.now() - lastSuccess < windowMins * 60_000) {
    await sql`insert into scrape_logs (product_id, run_id, attempt_no, status, fetcher, duration_ms, error_code)
              values (${product.id}, ${runId}, 1, 'skipped_recent', ${fetcherName}, 0, 'skipped_recent')`;
    return { status: 'skipped_recent', attempts: 0 };
  }

  const layout = await getLayout();
  const deadline = Date.now() + cfg.budgetMs;

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.attemptTimeoutMs);

    let httpStatus: number | null = null;
    let extracted: Extracted | null = null;
    let failure: { code: string; message: string } | null = null;

    try {
      const result = await fetcher.get(product.url, { timeoutMs: cfg.attemptTimeoutMs, signal: controller.signal });
      httpStatus = result.status;
      const httpErr = classifyHttp(result.status);
      failure = httpErr ?? null;
      if (!httpErr) extracted = extract(result, layout);
    } catch (e) {
      failure = controller.signal.aborted ? { code: 'timeout', message: 'attempt timed out' } : errorCodeOf(e, 'network');
    } finally {
      clearTimeout(timer);
    }

    const duration = Date.now() - started;

    if (extracted) {
      await persistSuccess(product, runId, layout, fetcherName, attempt, httpStatus, duration, extracted);
      return { status: attempt === 1 ? 'success' : 'retried', attempts: attempt };
    }

    const code = failure!.code;
    const backoffMs = cfg.backoff[attempt - 1] ?? cfg.backoff[cfg.backoff.length - 1] ?? 0;
    const willRetry = RETRYABLE.has(code) && attempt < cfg.attempts && deadline - Date.now() > backoffMs;

    await persistFailure(product, runId, layout, fetcherName, attempt, willRetry ? 'retried' : 'failed', httpStatus, duration, failure!);

    if (!willRetry) {
      await bumpFailure(product.id);
      return { status: 'failed', attempts: attempt };
    }
    await sleep(backoffMs + Math.floor(Math.random() * (cfg.jitterMs + 1)));
  }

  await bumpFailure(product.id);
  return { status: 'failed', attempts: cfg.attempts };
}

// --- classification & extraction ---

function classifyHttp(status: number): { code: string; message: string } | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404) return { code: 'http_404', message: 'not found' };
  if (status === 429) return { code: 'http_429', message: 'rate limited' };
  if (status >= 500) return { code: 'http_5xx', message: `server error ${status}` };
  return { code: 'http_5xx', message: `unexpected status ${status}` }; // other non-2xx: retry then fail
}

function extract(result: FetchResult, layout: Layout): Extracted {
  const { rawPrice, stockText, source } = readPriceAndStock(result.body, layout); // throws parse_empty
  const price = parsePrice(rawPrice); // throws parse_invalid
  const { status: stock, qty } = parseStock(stockText);
  validate(price, stock); // throws validation_failed
  return { price, raw: rawPrice.trim(), stock, stockQty: qty, source };
}

// --- persistence ---

async function persistSuccess(
  product: ProductInput, runId: string, layout: Layout, fetcher: string,
  attempt: number, httpStatus: number | null, duration: number, ext: Extracted,
): Promise<void> {
  const [prev] = await sql<{ price: string }[]>`
    select price from price_history where product_id = ${product.id} order by scraped_at desc limit 1`;
  const anomalous = isAnomalous(prev ? Number(prev.price) : null, ext.price);

  await sql.begin(async (tx) => {
    await tx`insert into price_history
      (product_id, run_id, price, currency, stock, stock_qty, layout_revision, layout_variant, extraction_source, raw_price, anomalous)
      values (${product.id}, ${runId}, ${ext.price}, 'INR', ${ext.stock}, ${ext.stockQty},
              ${layout.revision}, ${layout.variant}, ${ext.source}, ${ext.raw}, ${anomalous})`;
    await tx`insert into scrape_logs
      (product_id, run_id, attempt_no, status, fetcher, layout_revision, layout_variant, extraction_source, http_status, duration_ms, error_code)
      values (${product.id}, ${runId}, ${attempt}, 'success', ${fetcher},
              ${layout.revision}, ${layout.variant}, ${ext.source}, ${httpStatus}, ${duration}, null)`;
    await tx`update products set
      last_attempt_at = now(), last_success_at = now(), consecutive_failures = 0,
      layout_alert = layout_alert or (last_layout_revision is not null and last_layout_revision <> ${layout.revision}),
      last_layout_revision = ${layout.revision}
      where id = ${product.id}`;
  });
}

async function persistFailure(
  product: ProductInput, runId: string, layout: Layout, fetcher: string, attempt: number,
  status: 'retried' | 'failed', httpStatus: number | null, duration: number,
  failure: { code: string; message: string },
): Promise<void> {
  await sql`insert into scrape_logs
    (product_id, run_id, attempt_no, status, fetcher, layout_revision, layout_variant, extraction_source, http_status, duration_ms, error_code, error_message)
    values (${product.id}, ${runId}, ${attempt}, ${status}, ${fetcher},
            ${layout.revision}, ${layout.variant}, ${`.${layout.classes.priceValue}`}, ${httpStatus}, ${duration}, ${failure.code}, ${failure.message})`;
}

async function bumpFailure(productId: string): Promise<void> {
  await sql`update products set last_attempt_at = now(), consecutive_failures = consecutive_failures + 1 where id = ${productId}`;
}

export { ScrapeError };
