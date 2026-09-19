import type { NextFunction, Request, Response } from 'express';
import { env } from './env.js';
import { logger } from './logger.js';

// Strict allowlist CORS. A browser cross-origin call must present an Origin listed in CORS_ORIGINS
// or it is rejected with a logged 403 — loud, so a misconfigured deploy is obvious, not silent.
// Requests with no Origin header (server-to-server: cron-job.org, Render health checks, curl) pass
// through untouched: CORS is a browser policy, not an auth layer, and the cron route has its own
// shared secret.
const allowed = new Set(env.CORS_ORIGINS);

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  if (!origin) {
    next();
    return;
  }

  if (!allowed.has(origin)) {
    logger.warn(
      { origin, method: req.method, path: req.path, allowed: [...allowed] },
      'CORS: rejected origin not in CORS_ORIGINS',
    );
    res.status(403).json({ error: 'origin not allowed' });
    return;
  }

  res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Max-Age', '86400');

  // Preflight for an allowed origin: answer here, no need to reach a route.
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
