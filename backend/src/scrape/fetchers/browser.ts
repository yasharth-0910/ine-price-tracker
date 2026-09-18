// Playwright fetcher for the price path. Drives the store's real reveal:
//   goto -> dismiss cookies -> satisfy the interaction gate (>=8 throttled mouse moves + >=600ms
//   dwell across the price block) -> trusted click on Reveal -> wait for price-success/price-error.
// If the block is still price-idle a beat after the click (a silently dropped click, the store's
// `Xn`), it re-clicks rather than re-requesting. `status` is the HTTP status of the underlying
// /api/products/{id}/price call, captured from the page's `response` event.
import type { BrowserContext, Page } from 'playwright';
import type { Fetcher, FetchResult } from './types.js';
import { ScrapeError } from '../errors.js';

const PRICE_REQ = /\/api\/products\/[^/]+\/price$/;
const PRICE_BLOCK = '.price-block'; // the store renders no ids; the block carries this class in every phase

// A product page resolves one of two ways: the price block renders, or the store reports the
// product missing (no price block, no reveal, no price request — e.g. /product/1001). This predicate
// (evaluated in the page) resolves as soon as either is true.
const BLOCK_OR_NOT_FOUND =
  `!!document.querySelector('.price-block') || /couldn.t load this product|product 404|not found/i.test(document.body?.innerText || '')`;

// Interaction-gate tuning. Store gate is minMoves 8 / minDwell 600ms (Ar in the bundle); we clear
// both with margin. The moves must be to DISTINCT points — page.mouse.move emits no event when the
// coordinate is unchanged, so a repeated point contributes nothing toward minMoves.
const GATE_MOVES = 10;
const MOVE_SPACING_MS = 70; // > 40ms throttle, and 10 * 70 = 700ms > 600ms dwell (kept lean for the budget)
const RECLICK_AFTER_MS = 700; // still price-idle this long after a click => dropped click, re-click
const COOKIE_SELECTORS = ['#accept-cookies', 'button:has-text("Accept")', 'button:has-text("Got it")'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BrowserFetcher implements Fetcher {
  readonly name = 'browser' as const;
  constructor(private readonly context: BrowserContext) {}

  private revealButton(page: Page) {
    return page.getByRole('button', { name: /reveal price/i });
  }

  async get(url: string, { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal }): Promise<FetchResult> {
    const start = Date.now();
    const page = await this.context.newPage();
    let priceStatus: number | null = null;
    page.on('response', (res) => {
      try {
        if (PRICE_REQ.test(new URL(res.url()).pathname)) priceStatus = res.status();
      } catch {
        /* non-URL response, ignore */
      }
    });

    // Reject the moment the per-attempt deadline fires, so a hung reveal reads as a timeout.
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(new ScrapeError('timeout', 'aborted before start'));
      signal.addEventListener('abort', () => reject(new ScrapeError('timeout', 'attempt timed out')), { once: true });
    });

    try {
      const reveal = this.reveal(page, url, timeoutMs);
      reveal.catch(() => {}); // if `aborted` wins the race, swallow the late reveal rejection
      const outcome = await Promise.race([reveal, aborted]);
      const body = await page.content();
      // A gone product never issues a price request, so report the 404 the store gave the product
      // page itself. The core sees http_404 -> terminal, one attempt, no retry.
      const status = outcome === 'not_found' ? 404 : (priceStatus ?? 0);
      return { status, body, elapsedMs: Date.now() - start, finalUrl: page.url() };
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async reveal(page: Page, url: string, timeoutMs: number): Promise<'ok' | 'not_found'> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await this.dismissCookies(page);
    // Race the price block against the not-found signal. Timeout is generous so the abort in get()
    // stays the timeout authority; a genuinely gone product resolves this in well under a second.
    await page.waitForFunction(BLOCK_OR_NOT_FOUND, undefined, { timeout: timeoutMs + 5000 });
    if ((await page.locator(PRICE_BLOCK).count()) === 0) return 'not_found';
    await this.driveGate(page, timeoutMs);
    await this.revealButton(page).click({ timeout: timeoutMs }); // click() auto-waits for the gate to enable it
    await this.reclickIfIdle(page);
    // Terminal state. Give the browser room past the per-attempt deadline: the abort race in get()
    // is what actually enforces the timeout, so this only fires when the store genuinely settles.
    await page.waitForSelector('.price-success, .price-error', { state: 'attached', timeout: timeoutMs + 5000 });
    return 'ok';
  }

  private async dismissCookies(page: Page): Promise<void> {
    for (const sel of COOKIE_SELECTORS) {
      const loc = page.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        await loc.click({ timeout: 500 }).catch(() => {});
        return;
      }
    }
  }

  // Sweep the cursor across the price block in distinct steps: >=8 real moves past the 40ms throttle,
  // dwelling >=600ms. Enters from just outside so mouseenter fires, then walks left-to-right with
  // `steps` so intermediate mousemoves fire even where consecutive points are close.
  private async driveGate(page: Page, _timeoutMs: number): Promise<void> {
    const box = await page.locator(PRICE_BLOCK).boundingBox();
    if (!box) throw new ScrapeError('parse_empty', 'price block not found');
    const inset = Math.min(8, box.width * 0.1);
    const x0 = box.x + inset;
    const span = Math.max(1, box.width - 2 * inset);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x - 5, y); // cross the boundary so mouseenter fires (sets hoverAt)
    for (let i = 0; i < GATE_MOVES; i++) {
      const x = x0 + (span * i) / (GATE_MOVES - 1);
      await page.mouse.move(x, y + (i % 2), { steps: 2 }); // steps => real intermediate mousemoves
      await sleep(MOVE_SPACING_MS);
    }
    // The Reveal button enables on the store's next re-render tick; click()'s actionability wait
    // (in reveal()) handles that, so there's nothing to wait on here.
  }

  // A registered click leaves price-idle synchronously (the store sets price-loading before it
  // fetches). If we're still idle after a beat, the click was swallowed — click again. This stays
  // inside one get(), so a dropped click costs a re-click, never a new attempt / price request.
  private async reclickIfIdle(page: Page): Promise<void> {
    // String predicate: evaluated in the page, so tsc doesn't need DOM globals in the backend lib.
    const leftIdle = () =>
      page
        .waitForFunction(`!document.querySelector('.price-block')?.classList.contains('price-idle')`, undefined, {
          timeout: RECLICK_AFTER_MS,
        })
        .then(() => true)
        .catch(() => false);
    if (await leftIdle()) return;
    await this.revealButton(page).click({ timeout: RECLICK_AFTER_MS });
  }

  async dispose(): Promise<void> {
    /* the context is owned by the caller (shared for the whole run); nothing to close here. */
  }
}
