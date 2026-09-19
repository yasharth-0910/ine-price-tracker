import { Router } from 'express';
import { performance } from 'node:perf_hooks';
import { sql } from '../db/client.js';
import { logger } from '../lib/logger.js';
import pkg from '../../package.json' with { type: 'json' };

export const health = Router();

health.get('/health', async (_req, res) => {
  const start = performance.now();
  let ok = false;
  let db_latency_ms: number | null = null;
  try {
    // 3-second timeout so health check never hangs if connection is cold
    await Promise.race([
      sql`select 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('db ping timeout')), 3000)),
    ]);
    ok = true;
    db_latency_ms = Math.round(performance.now() - start);
  } catch (err) {
    logger.error({ err }, 'health db ping failed');
  }
  res.status(ok ? 200 : 503).json({
    ok,
    version: pkg.version,
    uptime: Math.round(process.uptime()),
    db_latency_ms,
  });
});
