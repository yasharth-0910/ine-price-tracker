// In-app alerts: price drops, back-in-stock, and layout changes recorded by the scrape core.
import { Router } from 'express';
import { sql } from '../db/client.js';
import { asyncHandler } from '../lib/http.js';

export const alerts = Router();

// GET /api/alerts?unseen=1 — recent alerts (newest first) + the current unseen count for the header.
alerts.get(
  '/api/alerts',
  asyncHandler(async (req, res) => {
    const unseenOnly = req.query.unseen === '1' || req.query.unseen === 'true';
    const rows = await sql`
      select a.id, a.product_id, p.name as product_name, a.kind, a.old_value, a.new_value, a.seen, a.created_at
      from alerts a join products p on p.id = a.product_id
      ${unseenOnly ? sql`where a.seen = false` : sql``}
      order by a.created_at desc limit 50`;
    const [seenRow] = await sql<{ count: number }[]>`select count(*)::int as count from alerts where seen = false`;
    res.json({ count: rows.length, unseen_count: seenRow?.count ?? 0, alerts: rows });
  }),
);

// POST /api/alerts/:id/seen — mark one alert seen.
alerts.post(
  '/api/alerts/:id/seen',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const [updated] = await sql`update alerts set seen = true where id = ${id} returning id`;
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

// POST /api/alerts/seen-all — mark all alerts seen.
alerts.post(
  '/api/alerts/seen-all',
  asyncHandler(async (_req, res) => {
    await sql`update alerts set seen = true where seen = false`;
    res.status(204).end();
  }),
);
