import { Link } from 'react-router-dom';
import type { ProductListItem, StockStatus } from '../lib/api';
import { formatMoney, formatRelative, formatTimestamp } from '../lib/format';

// One tracked product as a full-width row (hairline-separated, not a card). Renders only real
// values; a product with no successful scrape shows a "no data yet" note rather than an empty chart
// implying a flat price. A row with failures gets a 2px left bar and names the real last error.
// Everything comes from the single GET /api/products payload — no per-row follow-up fetch.

const STOCK: Record<StockStatus, { label: string; className: string }> = {
  in_stock: { label: 'In stock', className: 'text-ok' },
  low_stock: { label: 'Low stock', className: 'text-retried' },
  out_of_stock: { label: 'Out of stock', className: 'text-muted' },
};

function deltaClass(pct: number): string {
  if (pct > 0) return 'text-failed';
  if (pct < 0) return 'text-ok';
  return 'text-muted';
}

/** Thin 24h price sparkline from real history points. Returns null under 2 points (no fake line). */
function Sparkline({ points, colorClass }: { points: number[]; colorClass: string }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1; // flat series → a centred line, still real
  const coords = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 22 - ((p - min) / span) * 20; // 2px padding top/bottom in a 24 tall box
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className={'h-6 w-28 overflow-visible ' + colorClass}
      viewBox="0 0 100 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <polyline points={coords} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ProductRow({ product, nextRun }: { product: ProductListItem; nextRun: Date | null }) {
  const failing = product.consecutive_failures > 0;
  const hasPrice = product.price != null && product.scraped_at != null;
  const currency = product.currency ?? 'INR';
  const path = product.url.replace(/^https?:\/\//, '');
  const pts = product.sparkline.map((s) => s.price).filter((n) => Number.isFinite(n));
  const trendClass = pts.length >= 2 ? deltaClass(pts[pts.length - 1]! - pts[0]!) : 'text-muted';

  return (
    <div
      className={
        'px-space-lg py-space-md transition-colors hover:bg-surface-hover ' +
        (failing ? 'border-l-2 border-failed' : '')
      }
    >
      <div className="grid grid-cols-1 items-center gap-space-sm md:grid-cols-12 md:gap-space-lg">
        {/* Name + store path (+ layout badge / failure detail) */}
        <div className="min-w-0 md:col-span-5">
          <div className="flex items-center gap-space-sm">
            <Link
              to={`/product/${product.id}`}
              className={
                'truncate text-body-md font-medium hover:underline ' +
                (failing ? 'text-failed' : 'text-ink')
              }
            >
              {product.name}
            </Link>
            {product.layout_alert && (
              <span className="shrink-0 rounded-sm border border-retried px-1.5 py-0.5 text-label-caps uppercase text-retried">
                store layout changed
              </span>
            )}
          </div>
          <div className="truncate font-mono text-mono-sm text-muted">{path}</div>
          {failing && (
            <div className="mt-1 font-mono text-mono-sm font-medium text-failed">
              {product.consecutive_failures} failed{' '}
              {product.consecutive_failures === 1 ? 'attempt' : 'attempts'}
              {product.last_error_code && ` · last error ${product.last_error_code}`}
            </div>
          )}
        </div>

        {hasPrice ? (
          <>
            <div className="text-left font-mono text-body-md font-medium tabular-nums text-ink md:col-span-2 md:text-right">
              {formatMoney(product.price!, currency)}
            </div>
            <div
              className={
                'text-left font-mono text-body-sm font-medium tabular-nums md:col-span-1 md:text-right ' +
                (product.change_24h_pct != null ? deltaClass(product.change_24h_pct) : 'text-muted')
              }
            >
              {product.change_24h_pct != null
                ? `${product.change_24h_pct > 0 ? '+' : ''}${product.change_24h_pct.toFixed(1)}%`
                : '—'}
            </div>
            <div className="flex items-center justify-start py-1 md:col-span-2 md:justify-center">
              <Sparkline points={pts} colorClass={trendClass} />
            </div>
            <div className="flex flex-col justify-center text-body-sm md:col-span-2 md:items-end">
              <span className={'font-medium ' + (product.stock ? STOCK[product.stock].className : 'text-muted')}>
                {product.stock ? STOCK[product.stock].label : 'Unknown'}
              </span>
              <span className="font-mono text-mono-sm tabular-nums text-muted">
                Scraped {formatRelative(product.scraped_at!)} · {product.history_count}{' '}
                {product.history_count === 1 ? 'record' : 'records'}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-body-sm text-muted md:col-span-5">
              {failing
                ? 'No successful scrape yet'
                : nextRun
                  ? `No data yet, first scrape at ${formatTimestamp(nextRun.toISOString())}`
                  : 'No data yet, awaiting first scheduled run'}
            </div>
            <div className="flex flex-col justify-center text-body-sm md:col-span-2 md:items-end">
              <span className="font-medium text-muted">
                {failing ? 'Failing' : 'Pending first scrape'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
