// One real run against the live store, through the exact same core the cron will use. Point it at a
// LOCAL database (DATABASE_URL) — this writes rows. Usage:
//   DATABASE_URL=postgres://localhost/ine_local npm run scrape:once -- 1 647 1001
// Ids default to 1 647 1001. Product rows are created from live /api/product/{id} metadata (name
// from the store, not invented); a 404 id still gets a row so the 404 path can be exercised.
import { chromium } from 'playwright';
import { sql } from '../src/db/client.js';
import { env } from '../src/lib/env.js';
import { browserLaunchOptions } from '../src/lib/browser.js';
import { BrowserFetcher } from '../src/scrape/fetchers/browser.js';
import { scrapeProduct, type ProductInput } from '../src/scrape/core.js';
import { fetchProduct } from '../src/scrape/store-client.js';

const argIds = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
const IDS = argIds.length ? argIds : [1, 647, 1001];

async function ensureProduct(id: number): Promise<{ product: ProductInput; metaStatus: number }> {
  const url = `${env.STORE_BASE_URL}/product/${id}`;
  const meta = await fetchProduct(id); // live metadata; 404 for a non-existent id
  const name = meta.status === 200 && meta.body?.name ? meta.body.name : `product-${id}`;
  const [product] = await sql<ProductInput[]>`
    insert into products (source_product_id, name, url)
    values (${String(id)}, ${name}, ${url})
    on conflict (source_product_id) do update set name = excluded.name, url = excluded.url
    returning id, source_product_id, url`;
  return { product: product!, metaStatus: meta.status };
}

async function rowsFor(productId: string) {
  const history = await sql`
    select price, currency, stock, stock_qty, layout_revision, layout_variant, extraction_source, raw_price, anomalous, scraped_at
    from price_history where product_id = ${productId} order by scraped_at`;
  const logs = await sql`
    select attempt_no, status, http_status, error_code, error_message, layout_revision, layout_variant, duration_ms
    from scrape_logs where product_id = ${productId} order by attempt_no, created_at`;
  return { history, logs };
}

async function main() {
  console.log(`\nscrape:once — store ${env.STORE_BASE_URL}, ids [${IDS.join(', ')}]\n`);
  const [run] = await sql<{ id: string }[]>`insert into scrape_runs (trigger, products_total) values ('manual', ${IDS.length}) returning id`;
  const runId = run!.id;

  const browser = await chromium.launch(browserLaunchOptions);
  const context = await browser.newContext();
  const fetcher = new BrowserFetcher(context);

  const counts = { succeeded: 0, failed: 0, skipped: 0 };
  const report: string[] = [];

  try {
    for (const id of IDS) {
      const { product, metaStatus } = await ensureProduct(id);
      const t0 = Date.now();
      const out = await scrapeProduct(product, runId, fetcher);
      const wallMs = Date.now() - t0;
      const { history, logs } = await rowsFor(product.id);

      if (out.status === 'success' || out.status === 'retried') counts.succeeded++;
      else if (out.status === 'skipped_recent') counts.skipped++;
      else counts.failed++;

      const h = history[0] as Record<string, unknown> | undefined;
      const priceCalls = logs.map((l: Record<string, unknown>) => l.http_status ?? '—').join(' -> ');
      report.push(
        `product ${id} (${product.source_product_id}, meta ${metaStatus})\n` +
          `  attempts:        ${out.attempts}\n` +
          `  final status:    ${out.status}\n` +
          `  price:           ${h ? `${h.price} ${h.currency} (raw ${JSON.stringify(h.raw_price)})` : '— (no history row)'}\n` +
          `  stock:           ${h ? `${h.stock}${h.stock_qty != null ? ` (qty ${h.stock_qty})` : ''}` : '—'}\n` +
          `  layout rev/var:  ${logs.length ? `${(logs[0] as Record<string, unknown>).layout_revision}/${(logs[0] as Record<string, unknown>).layout_variant}` : '—'}\n` +
          `  price-call http: ${priceCalls}\n` +
          `  duration:        ${wallMs} ms (per-attempt: ${logs.map((l: Record<string, unknown>) => `${l.duration_ms}ms`).join(', ')})`,
      );
    }
  } finally {
    await context.close();
    await browser.close();
    await fetcher.dispose();
  }

  await sql`update scrape_runs set finished_at = now(), succeeded = ${counts.succeeded}, failed = ${counts.failed}, skipped = ${counts.skipped} where id = ${runId}`;

  console.log('================ PER-PRODUCT ================\n');
  console.log(report.join('\n\n'));
  console.log(`\nrun ${runId}: succeeded=${counts.succeeded} failed=${counts.failed} skipped=${counts.skipped}\n`);

  // Read back what landed.
  console.log('================ price_history ================');
  console.table(
    (await sql`
      select p.source_product_id as product, h.price, h.stock, h.stock_qty, h.layout_revision as rev, h.layout_variant as var, h.extraction_source as src, h.anomalous
      from price_history h join products p on p.id = h.product_id
      where h.run_id = ${runId} order by p.source_product_id`).map((r) => ({ ...r })),
  );
  console.log('================ scrape_logs ================');
  console.table(
    (await sql`
      select p.source_product_id as product, l.attempt_no as n, l.status, l.http_status as http, l.error_code, l.duration_ms as ms
      from scrape_logs l join products p on p.id = l.product_id
      where l.run_id = ${runId} order by p.source_product_id, l.attempt_no, l.created_at`).map((r) => ({ ...r })),
  );

  await sql.end();
}

main().catch(async (err) => {
  console.error('scrape:once failed:', err);
  await sql.end().catch(() => {});
  process.exit(1);
});
