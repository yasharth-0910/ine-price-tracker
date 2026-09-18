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

// GET /api/runs — recent runs with their counts.
cron.get(
  '/api/runs',
  asyncHandler(async (_req, res) => {
    const runs = await sql`
      select id, trigger, started_at, finished_at, products_total, succeeded, failed, skipped, notes
      from scrape_runs order by started_at desc limit 20`;
    res.json({ count: runs.length, runs });
  }),
);
