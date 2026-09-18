// undici fetcher. The scheduled price path uses the browser (the price is behind a WASM PoW),
// so this is here for completeness / any plain-HTML source and to satisfy the Fetcher contract.
import { request } from 'undici';
import type { Fetcher, FetchResult } from './types.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; ine-price-tracker/1.0; +https://github.com/)';

export class HttpFetcher implements Fetcher {
  readonly name = 'http' as const;

  async get(url: string, { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal }): Promise<FetchResult> {
    const start = Date.now();
    const res = await request(url, {
      method: 'GET',
      signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      headers: { 'user-agent': USER_AGENT },
    });
    const body = await res.body.text();
    return { status: res.statusCode, body, elapsedMs: Date.now() - start, finalUrl: url };
  }

  async dispose(): Promise<void> {
    /* undici's global agent is process-wide; nothing to tear down here. */
  }
}
