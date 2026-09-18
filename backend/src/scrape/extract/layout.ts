// The rotating selector map from /api/layout, cached until its own validUntil. Class names rotate
// per window, so we never hardcode them — we fetch at scrape time and reuse until they expire.
import { fetchLayout, type Layout } from '../store-client.js';
import { ScrapeError } from '../errors.js';

let cached: Layout | null = null;

export async function getLayout(): Promise<Layout> {
  if (cached && cached.validUntil > Date.now()) return cached;
  const { status, body } = await fetchLayout();
  if (status !== 200 || !body?.classes?.priceValue) {
    throw new ScrapeError('network', `layout fetch failed (status ${status})`);
  }
  cached = body;
  return body;
}

// For tests / long-running processes that want a fresh map.
export function clearLayoutCache(): void {
  cached = null;
}
