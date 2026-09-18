// Map the store's stock phrasings to the three known states and pull out the quantity when present.
// A quantity of 0 is out_of_stock regardless of wording. Throws when the text matches nothing known,
// which the validation gate treats as a failed attempt rather than guessing.
import { fileURLToPath } from 'node:url';
import { ScrapeError } from '../errors.js';

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export function parseStock(input: string | null | undefined): { status: StockStatus; qty: number | null } {
  const text = (input ?? '').normalize('NFKC');
  const lower = text.toLowerCase();
  const m = lower.match(/-?\d[\d,]*/);
  const qty = m ? Number(m[0].replace(/,/g, '')) : null;

  if (/out of stock|sold out|unavailable|not available|no longer available/.test(lower)) return { status: 'out_of_stock', qty: 0 };
  if (qty === 0) return { status: 'out_of_stock', qty: 0 };
  if (/low stock|only \d|few left|hurry|limited stock|selling fast/.test(lower)) return { status: 'low_stock', qty };
  if (/in stock|available|\d+\s*(?:left|units?|pcs?|pieces?)/.test(lower)) return { status: 'in_stock', qty };
  if (qty !== null && qty > 0) return { status: 'in_stock', qty };
  throw new ScrapeError('validation_failed', `unrecognised stock "${input}"`);
}

// --- self-check: the five phrasings. ---
function demo(): void {
  const eq = (raw: string, status: StockStatus, qty: number | null) => {
    const got = parseStock(raw);
    if (got.status !== status || got.qty !== qty) {
      throw new Error(`parseStock(${JSON.stringify(raw)}) = ${JSON.stringify(got)}, want ${status}/${qty}`);
    }
  };
  eq('In stock · 7 left', 'in_stock', 7);
  eq('Only 2 left in stock', 'low_stock', 2);
  eq('Out of stock', 'out_of_stock', 0);
  eq('In stock', 'in_stock', null);
  eq('0 in stock', 'out_of_stock', 0); // 0 means out_of_stock
  eq('3 units available', 'in_stock', 3);
  console.log('parseStock: all phrasings OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) demo();
