// Read the raw price and stock text out of the rendered HTML using the layout's rotating classes.
// The price is ONLY the element carrying classes.priceValue. `.price-value` and `[data-price]` are
// display:none decoys holding a scaled copy of the real price — an explicit deny list, never read.
// Hidden descendants are stripped defensively so a decoy nested inside the carrier can't leak in.
import { load } from 'cheerio';
import { ScrapeError } from '../errors.js';
import type { Layout } from '../store-client.js';

const DENY = new Set(['price-value', 'amount']); // class names we must never read the price from

export interface RawExtract {
  rawPrice: string;
  stockText: string;
  source: string; // where the price came from, for the audit trail
}

export function readPriceAndStock(html: string, layout: Layout): RawExtract {
  const priceClass = layout.classes.priceValue;
  if (!priceClass || DENY.has(priceClass)) {
    throw new ScrapeError('parse_invalid', `refusing deny-listed price class "${priceClass}"`);
  }
  const $ = load(html);

  const el = $(`[class~="${priceClass}"]`).first();
  if (el.length === 0) throw new ScrapeError('parse_empty', `no element with class ${priceClass}`);

  // Drop hidden decoy fragments before reading the text.
  el.find('[aria-hidden="true"], [style*="display:none"], [style*="display: none"]').remove();
  const rawPrice = layout.priceCarrier === 'split' ? el.text().replace(/\s+/g, '') : el.text();
  if (!rawPrice.trim()) throw new ScrapeError('parse_empty', `empty ${priceClass} element`);

  const stockClass = layout.classes.stock;
  const stockText = stockClass ? $(`[class~="${stockClass}"]`).first().text() : '';

  return { rawPrice, stockText, source: `.${priceClass}` };
}
