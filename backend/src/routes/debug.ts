// TEMPORARY: smoke-tests that Chromium launches with our 512MB args on the deploy target.
// Remove in Phase 8 before submission.
import { Router } from 'express';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../lib/browser.js';
import { logger } from '../lib/logger.js';

export const debug = Router();

debug.get('/debug/browser', async (_req, res) => {
  const start = performance.now();
  let browser;
  try {
    browser = await chromium.launch(browserLaunchOptions);
    const page = await browser.newPage();
    await page.goto('about:blank');
    // string form: runs in browser context, so `navigator` isn't checked against the Node lib
    const userAgent = (await page.evaluate('navigator.userAgent')) as string;
    await browser.close();
    res.json({ ok: true, userAgent, launch_ms: Math.round(performance.now() - start) });
  } catch (err) {
    await browser?.close().catch(() => {});
    logger.error({ err }, 'debug browser launch failed');
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
