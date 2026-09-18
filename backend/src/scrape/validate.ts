// The gate every scrape passes before anything is written. A rejection here is a failed attempt,
// not a stored row — that is invariant INV-1/INV-3/INV-4. Anomalies (a >60% move) are flagged, not
// rejected: the store changes prices by design, so dropping an outlier would throw away real data.
import { ScrapeError } from './errors.js';
import type { StockStatus } from './extract/parseStock.js';

const ANOMALY_RATIO = 0.6;

export function validate(price: number, stock: StockStatus): void {
  if (!Number.isFinite(price) || price <= 0 || price >= 1_000_000) {
    throw new ScrapeError('validation_failed', `price out of range: ${price}`);
  }
  if (!['in_stock', 'low_stock', 'out_of_stock'].includes(stock)) {
    throw new ScrapeError('validation_failed', `unknown stock status: ${stock}`);
  }
}

// True when the new price is more than 60% away from the last known one. Stored, but flagged.
export function isAnomalous(previous: number | null, next: number): boolean {
  if (previous == null || previous <= 0) return false;
  return Math.abs(next - previous) / previous > ANOMALY_RATIO;
}
