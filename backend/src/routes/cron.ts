// The externally-triggered scrape endpoint and the run list.
//
// POST /api/cron/scrape authenticates a shared secret in constant time, inserts the run row,
// answers 202 with the run_id immediately, then does the work after the response has gone out —
// because a free-tier cron client won't wait for a multi-minute scrape. It is safe to call twice:
// the per-product 90-minute idempotency skip (in the core) means a duplicate fire writes no
// duplicate history, only skipped_recent log rows.
import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from '../db/client.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { asyncHandler } from '../lib/http.js';
import { executeRun } from '../scrape/run.js';

export const cron = Router();

// Constant-time secret check. SHA-256 both sides first so lengths are always equal and no timing
// (including length) leaks. Fails closed when CRON_SECRET is unset or no header is provided.
function validSecret(provided: string | undefined): boolean {
  if (!env.CRON_SECRET || !provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(env.CRON_SECRET).digest();
  return timingSafeEqual(a, b);
}

cron.post(
  '/api/cron/scrape',
  asyncHandler(async (req, res) => {
    if (!validSecret(req.header('x-cron-secret'))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const force = req.query.force === '1';
    const [run] = await sql<{ id: string }[]>`insert into scrape_runs (trigger) values ('cron') returning id`;
    const runId = run!.id;

    // Answer the cron client immediately, then scrape after the response returns.
    res.status(202).json({ run_id: runId });

    executeRun(runId, { force }).catch((err) => logger.error({ err, runId }, 'cron run failed'));
  }),
);

// GET /api/runs — recent runs with their counts and the run's slowest attempt (the headroom gauge).
// slowest_attempt_ms isn't stored on scrape_runs; it's the max attempt duration across the run's logs.
cron.get(
  '/api/runs',
  asyncHandler(async (_req, res) => {
    const runs = await sql`
      select r.id, r.trigger, r.started_at, r.finished_at, r.products_total, r.succeeded, r.failed, r.skipped, r.notes,
             slow.max as slowest_attempt_ms
      from scrape_runs r
      left join lateral (select max(duration_ms) as max from scrape_logs where run_id = r.id) slow on true
      order by r.started_at desc limit 20`;
    res.json({ count: runs.length, runs });
  }),
);

// GET /api/runs/:id — a run plus its per-product outcome (the terminal attempt per product).
cron.get(
  '/api/runs/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const [run] = await sql`
      select r.id, r.trigger, r.started_at, r.finished_at, r.products_total, r.succeeded, r.failed, r.skipped, r.notes,
             slow.max as slowest_attempt_ms
      from scrape_runs r
      left join lateral (select max(duration_ms) as max from scrape_logs where run_id = r.id) slow on true
      where r.id = ${id}`;
    if (!run) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const products = await sql`
      select p.id as product_id, p.name, p.source_product_id,
             last.status, last.error_code, last.http_status, last.attempt_no as attempts, last.duration_ms
      from products p
      join lateral (
        select status, error_code, http_status, attempt_no, duration_ms
        from scrape_logs where run_id = ${id} and product_id = p.id
        order by attempt_no desc, created_at desc limit 1
      ) last on true
      order by p.name`;
    res.json({ run, products });
  }),
);
