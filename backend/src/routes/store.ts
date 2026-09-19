import { Router } from 'express';
import { sql } from '../db/client.js';

export const store = Router();

// Search the locally-mirrored catalogue (the store has no search endpoint).
// Empty q and a zero-result q are distinguishable: an empty q always echoes query:"".
store.get('/api/store/search', async (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  if (!q) {
    res.json({ query: '', count: 0, items: [] });
    return;
  }
  const isNum = /^\d+$/.test(q);
  const items = isNum
    ? await sql`
        select id, slug, name, brand, category, sku
        from store_catalog
        where missing = false and (id = ${Number(q)} or name ilike ${'%' + q + '%'})
        order by (id = ${Number(q)}) desc, name
        limit 20
      `
    : await sql`
        select id, slug, name, brand, category, sku
        from store_catalog
        where missing = false and (
          name ilike ${'%' + q + '%'} or 
          brand ilike ${'%' + q + '%'} or 
          category ilike ${'%' + q + '%'} or 
          sku ilike ${'%' + q + '%'}
        )
        order by name
        limit 20
      `;
  res.json({ query: q, count: items.length, items });
});
