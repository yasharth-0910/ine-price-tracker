// Product tracking + read APIs. Tracking is by the store's own product id; everything the store
// knows (name, category) is fetched live, nothing is invented. Untracking keeps the history (F7).
import { Router } from 'express';
import { sql } from '../db/client.js';
import { env } from '../lib/env.js';
import { asyncHandler } from '../lib/http.js';
import { fetchProduct } from '../scrape/store-client.js';
import { executeRun } from '../scrape/run.js';

export const products = Router();

// POST /api/products { source_product_id } — track a store product by its numeric store id.
products.post(
  '/api/products',
  asyncHandler(async (req, res) => {
    const storeId = Number((req.body as { source_product_id?: unknown })?.source_product_id);
    if (!Number.isInteger(storeId) || storeId < 1) {
      res.status(400).json({ error: 'source_product_id must be a positive integer store id' });
      return;
    }
    const meta = await fetchProduct(storeId);
    if (meta.status === 404) {
      res.status(404).json({ error: `store product ${storeId} not found` });
      return;
    }
    if (meta.status !== 200 || !meta.body?.name) {
      res.status(502).json({ error: 'store metadata unavailable, try again' });
      return;
    }
    const [product] = await sql`
      insert into products (source_product_id, name, url, category)
      values (${String(storeId)}, ${meta.body.name}, ${`${env.STORE_BASE_URL}/product/${storeId}`}, ${meta.body.category ?? null})
      on conflict (source_product_id) do update set
        tracking_enabled = true, name = excluded.name, url = excluded.url, category = excluded.category
      returning *`;
    res.status(201).json({ product });
  }),
);

// DELETE /api/products/:id — untrack. Scraping stops, history is kept (F7).
products.delete(
  '/api/products/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const [updated] = await sql`
      update products set tracking_enabled = false where id = ${id} returning id`;
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

// PATCH /api/products/:id { scrape_interval_mins } — change how often the product is scraped.
// The scrape core reads this value for its per-product idempotency window.
products.patch(
  '/api/products/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const mins = Number((req.body as { scrape_interval_mins?: unknown })?.scrape_interval_mins);
    const ALLOWED = [30, 60, 120, 240, 360, 720, 1440];
    if (!ALLOWED.includes(mins)) {
      res.status(400).json({ error: `scrape_interval_mins must be one of ${ALLOWED.join(', ')}` });
      return;
    }
    const [product] = await sql`update products set scrape_interval_mins = ${mins} where id = ${id} returning *`;
    if (!product) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ product });
  }),
);

// GET /api/products — tracked products with their latest snapshot and 24h change.
products.get(
  '/api/products',
  asyncHandler(async (_req, res) => {
    const rows = await sql<
      {
        id: string; source_product_id: string; name: string; url: string; category: string | null;
        consecutive_failures: number; layout_alert: boolean; last_attempt_at: Date | null; last_success_at: Date | null;
        price: string | null; currency: string | null; stock: string | null; stock_qty: number | null;
        scraped_at: Date | null; anomalous: boolean | null; price_24h_ago: string | null;
        history_count: number; last_error_code: string | null; last_error_at: Date | null;
        sparkline: { t: string; price: number }[];
      }[]
    >`
      select
        p.id, p.source_product_id, p.name, p.url, p.category,
        p.consecutive_failures, p.layout_alert, p.last_attempt_at, p.last_success_at,
        latest.price, latest.currency, latest.stock, latest.stock_qty, latest.scraped_at, latest.anomalous,
        prev.price as price_24h_ago,
        hist.count as history_count,
        err.error_code as last_error_code, err.created_at as last_error_at,
        coalesce(spark.points, '[]'::json) as sparkline
      from products p
      left join lateral (
        select price, currency, stock, stock_qty, scraped_at, anomalous from price_history
        where product_id = p.id order by scraped_at desc limit 1
      ) latest on true
      left join lateral (
        select price from price_history
        where product_id = p.id and scraped_at <= now() - interval '24 hours'
        order by scraped_at desc limit 1
      ) prev on true
      left join lateral (
        select count(*)::int as count from price_history where product_id = p.id
      ) hist on true
      -- Last real error, only surfaced while the product is actively failing.
      left join lateral (
        select error_code, created_at from scrape_logs
        where product_id = p.id and error_code is not null and p.consecutive_failures > 0
        order by created_at desc limit 1
      ) err on true
      -- Last 24h of price points for the row sparkline (oldest first), no N+1 from the client.
      left join lateral (
        select json_agg(json_build_object('t', scraped_at, 'price', price) order by scraped_at) as points
        from price_history
        where product_id = p.id and scraped_at >= now() - interval '24 hours'
      ) spark on true
      where p.tracking_enabled = true
      order by p.created_at desc`;

    const items = rows.map((r) => {
      const now = r.price != null ? Number(r.price) : null;
      const then = r.price_24h_ago != null ? Number(r.price_24h_ago) : null;
      const change24h = now != null && then != null ? Number((now - then).toFixed(2)) : null;
      const changePct = change24h != null && then ? Number(((change24h / then) * 100).toFixed(2)) : null;
      return { ...r, change_24h: change24h, change_24h_pct: changePct };
    });
    res.json({ count: items.length, items });
  }),
);

// GET /api/products/:id — the product plus its latest snapshot and health signals.
products.get(
  '/api/products/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const [product] = await sql`select * from products where id = ${id}`;
    if (!product) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const [latest] = await sql`
      select price, currency, stock, stock_qty, raw_price, anomalous, scraped_at, layout_revision, layout_variant, extraction_source
      from price_history where product_id = ${product.id} order by scraped_at desc limit 1`;
    res.json({ product, latest: latest ?? null });
  }),
);

// GET /api/products/:id/history?range=24h|7d|all — oldest first, for charting.
products.get(
  '/api/products/:id/history',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const range = String(req.query.range ?? 'all');
    const since =
      range === '24h' ? sql`and scraped_at >= now() - interval '24 hours'`
      : range === '3d' ? sql`and scraped_at >= now() - interval '3 days'`
      : range === '7d' ? sql`and scraped_at >= now() - interval '7 days'`
      : sql``;
    const history = await sql`
      select price, currency, stock, stock_qty, raw_price, anomalous, layout_revision, layout_variant, extraction_source, scraped_at
      from price_history where product_id = ${id} ${since} order by scraped_at asc`;
    res.json({ range, count: history.length, history });
  }),
);

// GET /api/products/:id/logs?limit=50 — newest first. skipped_recent is not a scrape attempt, so it
// is excluded here (INV: the log shows attempts only).
products.get(
  '/api/products/:id/logs',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const logs = await sql`
      select attempt_no, status, http_status, error_code, error_message, fetcher, duration_ms,
             layout_revision, layout_variant, created_at, run_id
      from scrape_logs
      where product_id = ${id} and status <> 'skipped_recent'
      order by created_at desc limit ${limit}`;
    res.json({ count: logs.length, logs });
  }),
);

// POST /api/products/:id/scrape — manual single scrape, for the demo. ?force=1 bypasses idempotency.
products.post(
  '/api/products/:id/scrape',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const [product] = await sql<{ id: string }[]>`select id from products where id = ${id}`;
    if (!product) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const [run] = await sql<{ id: string }[]>`insert into scrape_runs (trigger) values ('manual') returning id`;
    const result = await executeRun(run!.id, { productIds: [product.id], force: req.query.force === '1' });
    res.json({ run_id: run!.id, ...result });
  }),
);
