// One scrape run: pick the tracked products (or a specific set), scrape them one at a time through a
// single shared browser context, and finalise the scrape_runs row. Used by the cron endpoint (fire
// and forget after a 202) and by the manual single-product endpoint (awaited).
//
// Invariants it upholds: concurrency 1 with a shared context (a single Chromium fits 512MB);
// INV-7 one product failing never stops the others; INV-8 the run always records finished_at.
import { chromium } from 'playwright';
import { sql } from '../db/client.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { browserLaunchOptions } from '../lib/browser.js';
import { BrowserFetcher } from './fetchers/browser.js';
import { scrapeProduct, type ProductInput } from './core.js';

const SELF_PING_MS = 4 * 60 * 1000; // keep Render awake mid-run

// Scrape this many products per browser before recycling it. Chromium's per-page memory (JS
// bundles, the WASM PoW, DOM) accumulates across pages in one process; on Render's 512 MB instance
// a single shared browser OOM-crashes after ~3-4 products ("Target closed") and fails the rest of
// the run. Recycling caps peak RAM and, if a browser dies mid-batch, only that batch is lost.
// Tunable per host: the free box wants ~2; a GitHub Actions runner (7 GB) can set it much higher.
const BROWSER_RECYCLE_EVERY = Number(process.env.SCRAPE_BROWSER_RECYCLE_EVERY) || 2;

export interface RunResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  slowestAttemptMs: number;
}

// Ping our own /health every 4 minutes so a long run doesn't let the free instance spin down.
// No-op when SELF_URL is unset (local dev).
function startSelfPing(): () => void {
  if (!env.SELF_URL) return () => {};
  const url = env.SELF_URL.replace(/\/$/, '') + '/health';
  const timer = setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }, SELF_PING_MS);
  return () => clearInterval(timer);
}

export async function executeRun(
  runId: string,
  { productIds, force = false }: { productIds?: string[]; force?: boolean } = {},
): Promise<RunResult> {
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const stopPing = startSelfPing();
  let products: ProductInput[] = [];

  try {
    products = productIds?.length
      ? await sql<ProductInput[]>`
          select id, source_product_id, url from products where id in ${sql(productIds)}`
      : await sql<ProductInput[]>`
          select id, source_product_id, url from products where tracking_enabled = true order by created_at`;

    await sql`update scrape_runs set products_total = ${products.length} where id = ${runId}`;

    // One fresh browser per batch of BROWSER_RECYCLE_EVERY products, closed before the next batch,
    // so peak RAM stays well under Render's 512 MB ceiling and a crashed browser costs one batch,
    // not the whole run. Concurrency is still 1 (one product at a time within a batch).
    for (let i = 0; i < products.length; i += BROWSER_RECYCLE_EVERY) {
      const batch = products.slice(i, i + BROWSER_RECYCLE_EVERY);
      const browser = await chromium.launch(browserLaunchOptions);
      const context = await browser.newContext();
      const fetcher = new BrowserFetcher(context);
      try {
        for (const product of batch) {
          try {
            const out = await scrapeProduct(product, runId, fetcher, { force });
            if (out.status === 'success' || out.status === 'retried') counts.succeeded++;
            else if (out.status === 'skipped_recent') counts.skipped++;
            else counts.failed++;
          } catch (err) {
            // scrapeProduct handles its own failures; this only fires on something truly unexpected.
            // Never let one product take down the rest of the run (INV-7).
            counts.failed++;
            logger.error({ err, productId: product.id }, 'product scrape threw');
          }
        }
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        await fetcher.dispose().catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err, runId }, 'executeRun unhandled error');
    throw err;
  } finally {
    stopPing();
    // INV-8: the run is finalised even if every product failed.
    await sql`update scrape_runs set finished_at = now(),
      succeeded = ${counts.succeeded}, failed = ${counts.failed}, skipped = ${counts.skipped}
      where id = ${runId}`.catch(() => {});
  }

  // Slowest single attempt in the run. Over many unattended runs this is the number that says
  // whether the per-attempt timeout budget still has headroom (a value near the timeout = trouble).
  const [slowest] = await sql<{ max: number | null }[]>`
    select max(duration_ms) as max from scrape_logs where run_id = ${runId}`;
  const slowestAttemptMs = slowest?.max ?? 0;

  logger.info(
    { runId, total: products.length, ...counts, slowest_attempt_ms: slowestAttemptMs },
    'scrape run finished',
  );
  return { total: products.length, ...counts, slowestAttemptMs };
}
