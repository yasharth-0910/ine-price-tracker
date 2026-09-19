// Fault-injection harness for the scrape core (Phase 4, written before Phase 3).
//
// It stands up the fake store, points a real Playwright BrowserFetcher at it, and drives the scrape
// core through every failure mode. Assertions are on ACTUAL DATABASE ROWS — counts and contents of
// price_history and scrape_logs, plus the returned final status — not on return values alone.
//
// The scrape core does not exist yet. This file imports it by a runtime specifier so it compiles;
// the import fails at runtime with a clear message until Phase 3 lands `src/scrape/core.ts` and
// `src/scrape/fetchers/browser.ts`. That failure is expected.
//
// Contract this harness pins down for Phase 3 (the point of writing it first):
//   scrapeProduct(product, runId, fetcher): Promise<{ status, attempts }>
//     - reads/updates products by product.id; writes one scrape_logs row per attempt; writes a
//       price_history row ONLY on a validated success.
//     - per-attempt scrape_logs.status: 'success' (this attempt got a valid price), 'retried' (this
//       attempt failed and another followed), 'failed' (terminal failure), 'skipped_recent'.
//     - returned status: 'success' (1 attempt), 'retried' (>1 attempt, last succeeded), 'failed'
//       (all failed), 'skipped_recent' (idempotency skip within the window; one log row, no history).
//     - error_code vocabulary: http_5xx | http_404 | timeout | parse_empty | parse_invalid (+network,
//       http_429 in prod). scrape_logs.http_status carries the numeric price-request status.
//   new BrowserFetcher(context): a Fetcher whose get() drives the reveal (mouse gate, click, waits
//     for price-success), re-clicks on a dropped click, and reports the price request's HTTP status.
//   Timing is read from env so the harness can compress it (prod defaults are ARCHITECTURE's 3x/10s):
//     SCRAPE_ATTEMPTS, SCRAPE_ATTEMPT_TIMEOUT_MS, SCRAPE_BACKOFF_MS, SCRAPE_JITTER_MS,
//     SCRAPE_BUDGET_MS, SCRAPE_IDEMPOTENCY_MINS.

import { chromium, type BrowserContext, type Route } from 'playwright';
import { startFakeStore } from './fake-store.js';
import { browserLaunchOptions } from '../src/lib/browser.js';

// --- Compress core timing and point the store client at the fake store, BEFORE importing anything
//     that reads these at module load. dotenv (via env.ts) does not override already-set vars. ---
const store = await startFakeStore();
process.env.STORE_BASE_URL = store.url;
process.env.SCRAPE_ATTEMPTS = '3';
process.env.SCRAPE_ATTEMPT_TIMEOUT_MS = '3000';
process.env.SCRAPE_BACKOFF_MS = '50,50,50';
process.env.SCRAPE_JITTER_MS = '0';
process.env.SCRAPE_BUDGET_MS = '60000';
process.env.SCRAPE_IDEMPOTENCY_MINS ??= '90';

const ATTEMPT_TIMEOUT = Number(process.env.SCRAPE_ATTEMPT_TIMEOUT_MS);
const DELAY_OK = 800; // < attempt timeout: a slow response that still lands
const DELAY_TIMEOUT = ATTEMPT_TIMEOUT + 300; // > attempt timeout: forces a timeout on that attempt

const PRICE = 23823;
const Br = (e: number) => { const t = 0.6 + (e % 37) / 37 * 0.7; return Math.max(1, Math.round(e * t)); };
const DECOY_1 = Br(PRICE);
const DECOY_2 = Br(PRICE + 7);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Interface this harness commits Phase 3 to (imported at runtime, typed here). ---
interface ProductInput { id: string; source_product_id: string; url: string; }
type ScrapeStatus = 'success' | 'retried' | 'failed' | 'skipped_recent';
interface ScrapeOutcome { status: ScrapeStatus; attempts: number }
type ScrapeProductFn = (p: ProductInput, runId: string, fetcher: unknown) => Promise<ScrapeOutcome>;

// Runtime specifiers (variables) so tsc doesn't resolve the not-yet-written modules statically.
const CORE_SPEC = '../src/scrape/core.js';
const FETCHER_SPEC = '../src/scrape/fetchers/browser.js';

let scrapeProduct: ScrapeProductFn;
let BrowserFetcher: new (ctx: BrowserContext) => { dispose?: () => Promise<void> };
let sql: import('postgres').Sql;
try {
  ({ sql } = await import('../src/db/client.js'));
  ({ scrapeProduct } = (await import(CORE_SPEC)) as { scrapeProduct: ScrapeProductFn });
  ({ BrowserFetcher } = (await import(FETCHER_SPEC)) as { BrowserFetcher: typeof BrowserFetcher });
} catch (err) {
  console.error('\n  Scrape core not implemented yet (Phase 3). The harness is ready and will run',
    '\n  once src/scrape/core.ts and src/scrape/fetchers/browser.ts exist.\n');
  console.error('  import error:', err instanceof Error ? err.message : err, '\n');
  await store.close();
  process.exit(1);
}

// --- Browser + one shared context (matches ARCHITECTURE: single context for the whole run). The
//     price request is faulted at the context level — the equivalent of page.route() that survives
//     the fresh page each retry creates. `currentFault` is swapped per case. ---
const browser = await chromium.launch(browserLaunchOptions);
const context = await browser.newContext();
let reqNo = 0;
let currentFault: ((route: Route, n: number) => Promise<unknown>) | null = null;
await context.route('**/api/products/*/price', async (route) => {
  reqNo++;
  if (currentFault) {
    try { await currentFault(route, reqNo); } catch { /* page may have torn down after a timeout */ }
    return;
  }
  return route.continue();
});
const fetcher = new BrowserFetcher(context);

const fulfill503 = (r: Route) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
const fulfill404 = (r: Route) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });

// --- DB helpers. Test rows are namespaced `verify:*` and torn down at the end. ---
const rand = () => Math.random().toString(36).slice(2, 8);
const [runRow] = await sql<{ id: string }[]>`insert into scrape_runs (trigger) values ('manual') returning id`;
const runId = runRow!.id;

async function makeProduct(slug: string, query = ''): Promise<ProductInput> {
  const src = `verify:${slug}:${rand()}`;
  const url = `${store.url}/product/1?price=${PRICE}${query}`;
  const [row] = await sql<ProductInput[]>`
    insert into products (source_product_id, name, url)
    values (${src}, ${src}, ${url})
    returning id, source_product_id, url`;
  return row!;
}

async function rowsFor(productId: string) {
  const history = await sql<{ price: string; raw_price: string; stock: string; anomalous: boolean }[]>`
    select price, raw_price, stock, anomalous from price_history where product_id = ${productId} order by scraped_at`;
  const logs = await sql<{ attempt_no: number; status: string; http_status: number | null; error_code: string | null; fetcher: string; run_id: string | null }[]>`
    select attempt_no, status, http_status, error_code, fetcher, run_id
    from scrape_logs where product_id = ${productId} order by attempt_no, created_at`;
  return { history, logs };
}

// --- Tiny case runner. ---
type Check = (ok: boolean, msg: string) => void;
const results: { name: string; fails: string[] }[] = [];

async function runCase(name: string, body: (check: Check) => Promise<void>) {
  const fails: string[] = [];
  const check: Check = (ok, msg) => { if (!ok) fails.push(msg); };
  reqNo = 0;
  currentFault = null;
  try {
    await body(check);
  } catch (e) {
    fails.push('threw: ' + (e instanceof Error ? e.message : String(e)));
  }
  results.push({ name, fails });
  const tag = fails.length === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name}`);
  for (const f of fails) console.log(`          - ${f}`);
}

const statuses = (logs: { status: string }[]) => logs.map((l) => l.status);
const httpStatuses = (logs: { http_status: number | null }[]) => logs.map((l) => l.http_status);

// --- The eleven cases plus the decoy assertion. ---
async function main() {
  console.log(`\nverify:scrape — fake store at ${store.url}, run ${runId}\n`);

  await runCase('happy path: 1 attempt, 1 history, 1 log, status success', async (check) => {
    const p = await makeProduct('happy');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'success', `outcome status ${out.status} != success`);
    check(history.length === 1, `history rows ${history.length} != 1`);
    check(Number(history[0]?.price) === PRICE, `stored price ${history[0]?.price} != ${PRICE}`);
    check(history[0]?.stock === 'in_stock', `stock ${history[0]?.stock} != in_stock`);
    check(logs.length === 1, `log rows ${logs.length} != 1`);
    check(logs[0]?.status === 'success', `log status ${logs[0]?.status} != success`);
    check(logs[0]?.http_status === 200, `log http_status ${logs[0]?.http_status} != 200`);
    check(logs[0]?.fetcher === 'browser', `fetcher ${logs[0]?.fetcher} != browser`);
  });

  await runCase('decoy trap: stored price is classes.priceValue, not the hidden decoys', async (check) => {
    const p = await makeProduct('decoy');
    await scrapeProduct(p, runId, fetcher);
    const { history } = await rowsFor(p.id);
    const stored = Number(history[0]?.price);
    check(history.length === 1, `history rows ${history.length} != 1`);
    check(stored === PRICE, `stored ${stored} != real ${PRICE}`);
    check(stored !== DECOY_1, `stored ${stored} matched .price-value decoy ${DECOY_1}`);
    check(stored !== DECOY_2, `stored ${stored} matched [data-price] decoy ${DECOY_2}`);
  });

  await runCase('500, 500, 200: 1 history, 3 logs, status retried', async (check) => {
    currentFault = async (r, n) => (n <= 2 ? fulfill503(r) : r.continue());
    const p = await makeProduct('retry500');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'retried', `outcome status ${out.status} != retried`);
    check(history.length === 1, `history rows ${history.length} != 1`);
    check(Number(history[0]?.price) === PRICE, `stored price ${history[0]?.price} != ${PRICE}`);
    check(logs.length === 3, `log rows ${logs.length} != 3`);
    check(JSON.stringify(statuses(logs)) === JSON.stringify(['retried', 'retried', 'success']),
      `log statuses ${JSON.stringify(statuses(logs))}`);
    check(JSON.stringify(httpStatuses(logs)) === JSON.stringify([503, 503, 200]),
      `log http_status ${JSON.stringify(httpStatuses(logs))}`);
    check(logs.slice(0, 2).every((l) => l.error_code === 'http_5xx'), `error_code not http_5xx on failed attempts`);
  });

  await runCase('500 x3: 0 history, 3 logs, status failed', async (check) => {
    currentFault = async (r) => fulfill503(r);
    const p = await makeProduct('fail500');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'failed', `outcome status ${out.status} != failed`);
    check(history.length === 0, `history rows ${history.length} != 0`);
    check(logs.length === 3, `log rows ${logs.length} != 3`);
    check(JSON.stringify(statuses(logs)) === JSON.stringify(['retried', 'retried', 'failed']),
      `log statuses ${JSON.stringify(statuses(logs))}`);
    check(logs.every((l) => l.error_code === 'http_5xx'), `error_code not all http_5xx`);
    check(logs.every((l) => l.http_status === 503), `http_status not all 503`);
  });

  await runCase('slow past the timeout: timeout error code, retried, then succeeds', async (check) => {
    currentFault = async (r, n) => { if (n === 1) { await sleep(DELAY_TIMEOUT); return r.abort('timedout'); } return r.continue(); };
    const p = await makeProduct('timeout');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'retried', `outcome status ${out.status} != retried`);
    check(history.length === 1, `history rows ${history.length} != 1`);
    check(logs.length === 2, `log rows ${logs.length} != 2`);
    check(logs[0]?.error_code === 'timeout', `first error_code ${logs[0]?.error_code} != timeout`);
    check(logs[0]?.status === 'retried', `first log status ${logs[0]?.status} != retried`);
    check(logs[1]?.status === 'success', `second log status ${logs[1]?.status} != success`);
  });

  await runCase('price node missing: parse_empty, retried, not stored', async (check) => {
    const p = await makeProduct('missing', '&missing=1');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'failed', `outcome status ${out.status} != failed`);
    check(history.length === 0, `history rows ${history.length} != 0 (must not store a 200-with-no-price)`);
    check(logs.length === 3, `log rows ${logs.length} != 3 (parse failure must be retried)`);
    check(logs.every((l) => l.error_code === 'parse_empty'), `error_code not all parse_empty`);
    check(logs.every((l) => l.http_status === 200), `http_status not all 200 (page returned 200)`);
  });

  await runCase('price "N/A": parse_invalid, not stored', async (check) => {
    const p = await makeProduct('na', '&na=1');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'failed', `outcome status ${out.status} != failed`);
    check(history.length === 0, `history rows ${history.length} != 0`);
    check(logs.length === 3, `log rows ${logs.length} != 3`);
    check(logs.every((l) => l.error_code === 'parse_invalid'), `error_code not all parse_invalid`);
  });

  await runCase('price request delayed but within timeout: succeeds on the browser fetcher', async (check) => {
    currentFault = async (r, n) => { if (n === 1) await sleep(DELAY_OK); return r.continue(); };
    const p = await makeProduct('slowok');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'success', `outcome status ${out.status} != success`);
    check(history.length === 1, `history rows ${history.length} != 1`);
    check(logs.length === 1, `log rows ${logs.length} != 1 (a slow-but-ok response must not retry)`);
    check(logs[0]?.status === 'success', `log status ${logs[0]?.status} != success`);
  });

  await runCase('404: one attempt only, no retry', async (check) => {
    currentFault = async (r) => fulfill404(r);
    const p = await makeProduct('gone');
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'failed', `outcome status ${out.status} != failed`);
    check(history.length === 0, `history rows ${history.length} != 0`);
    check(logs.length === 1, `log rows ${logs.length} != 1 (404 must not retry)`);
    check(logs[0]?.error_code === 'http_404', `error_code ${logs[0]?.error_code} != http_404`);
    check(logs[0]?.http_status === 404, `http_status ${logs[0]?.http_status} != 404`);
  });

  await runCase('two runs in the same window: second logs skipped_recent, no duplicate row', async (check) => {
    const p = await makeProduct('idem');
    const first = await scrapeProduct(p, runId, fetcher);
    const second = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(first.status === 'success', `first status ${first.status} != success`);
    check(second.status === 'skipped_recent', `second status ${second.status} != skipped_recent`);
    check(history.length === 1, `history rows ${history.length} != 1 (no duplicate)`);
    check(logs.filter((l) => l.status === 'skipped_recent').length === 1, `skipped_recent log rows != 1`);
    check(logs.filter((l) => l.status === 'success').length === 1, `success log rows != 1`);
  });

  await runCase('product B succeeds while product A fails in the same run', async (check) => {
    const a = await makeProduct('isoA');
    currentFault = async (r) => fulfill503(r);
    const outA = await scrapeProduct(a, runId, fetcher);

    reqNo = 0;
    currentFault = null;
    const b = await makeProduct('isoB');
    const outB = await scrapeProduct(b, runId, fetcher);

    const ra = await rowsFor(a.id);
    const rb = await rowsFor(b.id);
    check(outA.status === 'failed', `A status ${outA.status} != failed`);
    check(ra.history.length === 0, `A history ${ra.history.length} != 0`);
    check(ra.logs.length === 3, `A log rows ${ra.logs.length} != 3`);
    check(outB.status === 'success', `B status ${outB.status} != success`);
    check(rb.history.length === 1, `B history ${rb.history.length} != 1`);
    check(rb.logs.length === 1, `B log rows ${rb.logs.length} != 1`);
    check([...ra.logs, ...rb.logs].every((l) => l.run_id === runId), `logs not all under the same run_id`);
  });

  await runCase('silently dropped click: block stays price-idle, scraper re-clicks (not re-requests)', async (check) => {
    const p = await makeProduct('drop', '&drop=1'); // no network fault; the first click is swallowed in-page
    const out = await scrapeProduct(p, runId, fetcher);
    const { history, logs } = await rowsFor(p.id);
    check(out.status === 'success', `outcome status ${out.status} != success`);
    check(history.length === 1, `history rows ${history.length} != 1`);
    check(Number(history[0]?.price) === PRICE, `stored price ${history[0]?.price} != ${PRICE}`);
    // Exactly one log row is the DB-observable proof: a re-request would have burned a retry (>=2 rows).
    check(logs.length === 1, `log rows ${logs.length} != 1 (a re-click must not create a new attempt/re-request)`);
    check(logs[0]?.status === 'success', `log status ${logs[0]?.status} != success`);
  });
}

async function teardown() {
  try { await context.close(); await browser.close(); } catch { /* ignore */ }
  try { await (fetcher as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* ignore */ }
  await store.close();
  try {
    await sql`delete from products where source_product_id like 'verify:%'`; // cascades history + logs
    await sql`delete from scrape_runs where id = ${runId}`;
  } finally {
    await sql.end();
  }
}

try {
  await main();
} finally {
  await teardown();
}

const failed = results.filter((r) => r.fails.length > 0);
console.log(`\n${results.length - failed.length}/${results.length} cases passed.\n`);
process.exit(failed.length > 0 ? 1 : 0);
