// Walk /api/product/{id} for ids 1..1000 and upsert into store_catalog.
// Concurrency 5. A 404 marks the row missing rather than failing the run.
// Idempotent (upsert), so it is resumable and safe to run twice.
// The store rate-limits under load (503s), so a fresh full crawl won't land all 1000 in one pass.
// Re-run until the summary shows errors=0; each pass skips already-mirrored ids and only chases gaps.
//   npm run crawl
import { sql } from '../src/db/client.js';
import { fetchProduct, type StoreProduct } from '../src/scrape/store-client.js';
import { logger } from '../src/lib/logger.js';

const FIRST_ID = 1;
const LAST_ID = 1000;
const CONCURRENCY = 5;
const MAX_ATTEMPTS = 6; // transient 5xx/429/network get retried with backoff

const counts = { found: 0, missing: 0, errors: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function upsertFound(p: StoreProduct) {
  await sql`
    insert into store_catalog (id, slug, name, brand, category, sku, description, last_seen_at, missing)
    values (${p.id}, ${p.slug}, ${p.name}, ${p.brand ?? null}, ${p.category ?? null},
            ${p.sku ?? null}, ${p.description ?? null}, now(), false)
    on conflict (id) do update set
      slug = excluded.slug, name = excluded.name, brand = excluded.brand,
      category = excluded.category, sku = excluded.sku, description = excluded.description,
      last_seen_at = now(), missing = false
  `;
}

async function crawlId(id: number) {
  let lastNote = 'unknown';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { status, body } = await fetchProduct(id);
      if (status === 200 && body && typeof body.name === 'string') {
        await upsertFound({ ...body, id }); // trust the requested id over the payload
        counts.found++;
        return;
      }
      if (status === 404) {
        // Mark a previously-seen product as gone. Never-seen 404s have no name to insert, so skip.
        await sql`update store_catalog set missing = true, last_seen_at = now() where id = ${id}`;
        counts.missing++;
        return;
      }
      // 5xx / 429 (the store rate-limits under load): transient, retry.
      lastNote = `http_${status}`;
    } catch (err) {
      lastNote = err instanceof Error ? err.message : String(err); // timeout / network
    }
    if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt + Math.floor(Math.random() * 400));
  }
  counts.errors++;
  logger.warn({ id, lastNote }, 'catalog id failed after retries');
}

async function worker(ids: number[]) {
  for (const id of ids) await crawlId(id);
}

async function main() {
  const started = Date.now();
  const all = Array.from({ length: LAST_ID - FIRST_ID + 1 }, (_, i) => FIRST_ID + i);

  // Resume: skip ids already mirrored. Re-runs only chase the gaps, which also eases the
  // store's rate limiting because each pass sends far fewer requests.
  const present = new Set(
    (await sql<{ id: number }[]>`select id from store_catalog where missing = false`).map((r) => r.id),
  );
  const todo = all.filter((id) => !present.has(id));

  // Round-robin the outstanding ids across workers so all lanes stay busy.
  const lanes: number[][] = Array.from({ length: CONCURRENCY }, () => []);
  todo.forEach((id, i) => lanes[i % CONCURRENCY]!.push(id));
  await Promise.all(lanes.map(worker));

  const rows = await sql<{ total: number }[]>`
    select count(*)::int as total from store_catalog where missing = false
  `;
  const total = rows[0]?.total ?? 0;
  const durationMs = Date.now() - started;
  logger.info(
    { found: total, new: counts.found, skipped: present.size, missing: counts.missing,
      errors: counts.errors, duration_s: Math.round(durationMs / 1000) },
    'catalog crawl complete',
  );
  console.log(
    `\ncrawl summary: found=${total} (new=${counts.found}, already had=${present.size}) ` +
      `missing=${counts.missing} errors=${counts.errors} duration=${(durationMs / 1000).toFixed(1)}s`,
  );
  await sql.end();
}

main().catch((err) => {
  logger.error({ err }, 'crawl failed');
  process.exit(1);
});
