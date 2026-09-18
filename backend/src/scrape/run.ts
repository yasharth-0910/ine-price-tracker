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

export interface RunResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
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
  const products = productIds?.length
    ? await sql<ProductInput[]>`
        select id, source_product_id, url from products where id = any(${productIds})`
    : await sql<ProductInput[]>`
        select id, source_product_id, url from products where tracking_enabled = true order by created_at`;

  await sql`update scrape_runs set products_total = ${products.length} where id = ${runId}`;

  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const stopPing = startSelfPing();
  const browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext();
  const fetcher = new BrowserFetcher(context);

  try {
    for (const product of products) {
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
    stopPing();
    // INV-8: the run is finalised even if every product failed.
    await sql`update scrape_runs set finished_at = now(),
      succeeded = ${counts.succeeded}, failed = ${counts.failed}, skipped = ${counts.skipped}
      where id = ${runId}`;
  }

  logger.info({ runId, total: products.length, ...counts }, 'scrape run finished');
  return { total: products.length, ...counts };
}
