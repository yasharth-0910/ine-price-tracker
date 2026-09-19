// Headed demonstration script for the video recording deliverable.
// Runs the exact same scrape core and BrowserFetcher as the cron, with a visible browser window.
//
// Usage:
//   npm run scrape:headed              # Clean run on products [1, 647, 1001]
//   npm run scrape:headed -- --chaos   # Chaos run: forces attempt 1 (500) -> attempt 2 (slow 6s) -> attempt 3 (pass)
//   npm run scrape:headed -- 1 647     # Specific product IDs
//
// Writes real rows to DATABASE_URL (point to local database: postgres://localhost/ine_local).

import { chromium } from 'playwright';
import { sql } from '../src/db/client.js';
import { env } from '../src/lib/env.js';
import { browserLaunchOptions } from '../src/lib/browser.js';
import { BrowserFetcher } from '../src/scrape/fetchers/browser.js';
import { scrapeProduct, type ProductInput } from '../src/scrape/core.js';
import { fetchProduct } from '../src/scrape/store-client.js';

const isChaos = process.argv.includes('--chaos');
const argIds = process.argv
  .slice(2)
  .filter((a) => a !== '--chaos')
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

const IDS = argIds.length ? argIds : [1, 647, 1001];

async function ensureProduct(id: number): Promise<{ product: ProductInput; name: string; metaStatus: number }> {
  const url = `${env.STORE_BASE_URL}/product/${id}`;
  const meta = await fetchProduct(id);
  const name = meta.status === 200 && meta.body?.name ? meta.body.name : `product-${id}`;
  const [product] = await sql<ProductInput[]>`
    insert into products (source_product_id, name, url)
    values (${String(id)}, ${name}, ${url})
    on conflict (source_product_id) do update set name = excluded.name, url = excluded.url
    returning id, source_product_id, url`;
  return { product: product!, name, metaStatus: meta.status };
}

async function rowsFor(productId: string) {
  const history = await sql`
    select price, currency, stock, stock_qty, layout_revision, layout_variant, extraction_source, raw_price, anomalous, scraped_at
    from price_history where product_id = ${productId} order by scraped_at desc limit 5`;
  const logs = await sql`
    select attempt_no, status, http_status, error_code, error_message, layout_revision, layout_variant, duration_ms, created_at
    from scrape_logs where product_id = ${productId} order by attempt_no, created_at`;
  return { history, logs };
}

async function main() {
  console.log('='.repeat(70));
  console.log(`TrackScrape Headed Runner ${isChaos ? '⚠️ [CHAOS MODE ENGAGED]' : '✅ [CLEAN RUN]'}`);
  console.log(`Store: ${env.STORE_BASE_URL}`);
  console.log(`Target IDs: [${IDS.join(', ')}]`);
  if (isChaos) {
    console.log('Chaos Ladder: Attempt 1 -> HTTP 500, Attempt 2 -> 6s delay, Attempt 3 -> Pass');
  }
  console.log('='.repeat(70) + '\n');

  const [run] = await sql<{ id: string }[]>`
    insert into scrape_runs (trigger, products_total)
    values ('headed', ${IDS.length})
    returning id`;
  const runId = run!.id;

  // Headed browser launch with smooth human-speed interaction for video capture
  const launchOptions = {
    ...browserLaunchOptions,
    headless: false,
    slowMo: 60, // Human-perceptible interaction speed
  };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  let priceCallCount = 0;

  if (isChaos) {
    await context.route(/\/api\/products\/[^/]+\/price/, async (route) => {
      priceCallCount++;
      const reqUrl = route.request().url();
      const productSlug = reqUrl.split('/').slice(-2, -1)[0];

      if (priceCallCount === 1) {
        console.log(`\n  ⚡ [CHAOS HOOK 1/3] Intercepted price request for ${productSlug}`);
        console.log('     -> Injecting synthetic HTTP 500 Internal Server Error');
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Chaos injection: simulated upstream server crash' }),
        });
      } else if (priceCallCount === 2) {
        console.log(`\n  ⚡ [CHAOS HOOK 2/3] Intercepted price request for ${productSlug}`);
        console.log('     -> Injecting 6,000ms upstream network latency delay');
        await new Promise((r) => setTimeout(r, 6000));
        await route.continue();
      } else {
        console.log(`\n  ⚡ [CHAOS HOOK 3/3] Intercepted price request for ${productSlug}`);
        console.log('     -> Allowing live request to pass cleanly (200 OK)');
        await route.continue();
      }
    });
  }

  const fetcher = new BrowserFetcher(context);
  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const report: string[] = [];

  try {
    for (const id of IDS) {
      console.log(`\n▶ Scraping Product ${id}...`);
      const { product, name, metaStatus } = await ensureProduct(id);
      const t0 = Date.now();
      
      // Force = true so idempotency skip does not bypass headed demonstration
      const out = await scrapeProduct(product, runId, fetcher, { force: true });
      const wallMs = Date.now() - t0;
      const { history, logs } = await rowsFor(product.id);

      if (out.status === 'success' || out.status === 'retried') counts.succeeded++;
      else if (out.status === 'skipped_recent') counts.skipped++;
      else counts.failed++;

      const latestHist = history[0] as Record<string, unknown> | undefined;

      report.push(
        `Product ${id} (${name}, meta: ${metaStatus})\n` +
        `  • Status:        ${out.status.toUpperCase()} (${out.attempts} ${out.attempts === 1 ? 'attempt' : 'attempts'})\n` +
        `  • Price:         ${latestHist ? `${latestHist.price} ${latestHist.currency} [${latestHist.stock}]` : 'None (failed)'}\n` +
        `  • Wall time:     ${wallMs}ms\n` +
        `  • Attempt trace: ${logs.map((l: Record<string, unknown>) => `Attempt ${l.attempt_no}: ${l.status} (${l.duration_ms}ms, http ${l.http_status ?? '—'}${l.error_code ? `, err: ${l.error_code}` : ''})`).join('\n                   ')}`
      );
    }
  } finally {
    await context.close();
    await browser.close();
    await fetcher.dispose();
  }

  await sql`
    update scrape_runs
    set finished_at = now(),
        succeeded = ${counts.succeeded},
        failed = ${counts.failed},
        skipped = ${counts.skipped}
    where id = ${runId}`;

  console.log('\n' + '='.repeat(70));
  console.log('SCRAPE EXECUTION SUMMARY');
  console.log('='.repeat(70));
  console.log(report.join('\n\n'));
  console.log(`\nRun ID: ${runId}`);
  console.log(`Totals: ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.skipped} skipped\n`);

  console.log('='.repeat(70));
  console.log('SCRAPE LOGS STORED IN DATABASE (ine_local)');
  console.log('='.repeat(70));
  console.table(
    (await sql`
      select p.source_product_id as prod, l.attempt_no as att, l.status, l.http_status as http, l.error_code as err, l.duration_ms as ms
      from scrape_logs l
      join products p on p.id = l.product_id
      where l.run_id = ${runId}
      order by p.source_product_id, l.attempt_no`).map((r) => ({ ...r }))
  );

  await sql.end();
}

main().catch(async (err) => {
  console.error('\n❌ Headed run failed:', err);
  await sql.end().catch(() => {});
  process.exit(1);
});
