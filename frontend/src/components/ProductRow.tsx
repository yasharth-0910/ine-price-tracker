import { Link } from 'react-router-dom';
import type { ProductListItem, StockStatus } from '../lib/api';
import { formatMoney, formatRelative, formatTimestamp } from '../lib/format';
import { useManualScrape } from '../hooks/useManualScrape';

// One tracked product as a full-width row (hairline-separated, not a card). Renders only real
// values; a product with no successful scrape shows a "no data yet" note rather than an empty chart
// implying a flat price. A row with failures gets a 2px left bar and names the real last error.
// Everything comes from the single GET /api/products payload — no per-row follow-up fetch.

const STOCK: Record<StockStatus, { label: string; className: string }> = {
  in_stock: { label: 'In stock', className: 'text-ok' },
  low_stock: { label: 'Low stock', className: 'text-retried' },
  out_of_stock: { label: 'Out of stock', className: 'text-muted' },
};

function deltaColorClass(pct: number): string {
  if (pct < 0) return 'text-ok'; // Price drop is good in retail tracking
  if (pct > 0) return 'text-failed'; // Price rise
  return 'text-muted';
}

/** Thin 24h price sparkline from real history points. */
function Sparkline({
  points,
  colorClass,
  failing,
}: {
  points: number[];
  colorClass: string;
  failing: boolean;
}) {
  if (points.length < 2) {
    if (failing) {
      return (
        <svg className="h-6 w-28 overflow-visible" viewBox="0 0 112 24" fill="none">
          <line x1="2" y1="12" x2="60" y2="12" stroke="var(--muted)" strokeWidth="1.5" />
          <line x1="60" y1="12" x2="85" y2="12" stroke="var(--status-failed)" strokeWidth="1.5" strokeDasharray="2 3" />
          <circle cx="100" cy="12" r="2.5" fill="var(--status-failed)" />
        </svg>
      );
    }
    return (
      <svg className="h-6 w-28 overflow-visible" viewBox="0 0 112 24" fill="none">
        <line x1="2" y1="12" x2="110" y2="12" stroke="var(--muted)" strokeWidth="1.5" strokeOpacity="0.4" />
      </svg>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const coords = points
    .map((p, i) => {
      const x = 2 + (i / (points.length - 1)) * 108;
      const y = 20 - ((p - min) / span) * 16;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      className={'h-6 w-28 overflow-visible ' + colorClass}
      viewBox="0 0 112 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <polyline points={coords} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ProductRow({
  product,
  nextRun,
  onUntrack,
  onRefresh,
}: {
  product: ProductListItem;
  nextRun: Date | null;
  onUntrack: (p: ProductListItem) => void;
  onRefresh: () => void | Promise<void>;
}) {
  const { pending, error: scrapeError, scrape } = useManualScrape(onRefresh);
  const failing = product.consecutive_failures > 0;
  const hasPrice = product.price != null && product.scraped_at != null;
  const currency = product.currency ?? 'INR';
  const path = product.url.replace(/^https?:\/\//, '');
  const pts = product.sparkline.map((s) => s.price).filter((n) => Number.isFinite(n));

  // Determine trend color
  let trendColor = 'text-muted';
  if (product.change_24h_pct != null && product.change_24h_pct !== 0) {
    trendColor = deltaColorClass(product.change_24h_pct);
  } else if (pts.length >= 2) {
    const diff = pts[pts.length - 1]! - pts[0]!;
    trendColor = diff !== 0 ? deltaColorClass(diff) : 'text-muted';
  }

  return (
    <div
      className={
        'group p-3 transition-colors hover:bg-surface-hover sm:px-4 sm:py-2.5 ' +
        (failing ? 'border-l-[3px] border-l-failed bg-surface' : '')
      }
    >
      <div className="grid grid-cols-1 items-center gap-2 lg:grid-cols-12 lg:gap-4">
        {/* Col 1: Product name & url */}
        <div className="flex min-w-0 flex-col lg:col-span-4">
          <div className="flex items-center gap-2">
            <Link
              to={`/product/${product.id}`}
              className={
                'truncate font-sans text-[13px] font-medium transition-colors hover:underline ' +
                (failing ? 'text-failed' : 'text-ink')
              }
            >
              {product.name}
            </Link>
            {product.layout_alert && (
              <span className="shrink-0 rounded-sm border border-retried px-1.5 py-0.5 font-sans text-[10px] uppercase text-retried">
                layout change
              </span>
            )}
          </div>
          <span className="truncate font-mono text-[11px] text-muted">{path}</span>
          {failing && (
            <span className="mt-0.5 truncate font-mono text-[11px] text-failed">
              {product.consecutive_failures} failed {product.consecutive_failures === 1 ? 'attempt' : 'attempts'}
              {product.last_error_code && `, last error ${product.last_error_code}`}
            </span>
          )}
        </div>

        {hasPrice ? (
          <>
            {/* Col 2: Detected price */}
            <div className="flex items-center justify-between lg:col-span-2 lg:justify-end">
              <span className="font-sans text-[11px] text-muted lg:hidden">Price:</span>
              <span className="font-mono text-[13px] font-medium tabular-nums text-ink">
                {formatMoney(product.price!, currency)}
              </span>
            </div>

            {/* Col 3: 24h change */}
            <div className="flex items-center justify-between lg:col-span-1 lg:justify-end">
              <span className="font-sans text-[11px] text-muted lg:hidden">24h change:</span>
              <span
                className={
                  'font-mono text-[13px] tabular-nums ' +
                  (product.change_24h_pct != null ? deltaColorClass(product.change_24h_pct) : 'text-muted')
                }
              >
                {product.change_24h_pct != null
                  ? `${product.change_24h_pct > 0 ? '+' : ''}${product.change_24h_pct.toFixed(1)}%`
                  : '0.0%'}
              </span>
            </div>

            {/* Col 4: Sparkline */}
            <div className="flex items-center justify-center py-0.5 lg:col-span-2">
              <Sparkline points={pts} colorClass={trendColor} failing={failing} />
            </div>

            {/* Col 5: Availability */}
            <div className="flex items-center justify-between lg:col-span-1 lg:justify-center">
              <span className="font-sans text-[11px] text-muted lg:hidden">Status:</span>
              <span
                className={
                  'font-sans text-[13px] ' +
                  (failing ? 'text-failed' : product.stock ? STOCK[product.stock].className : 'text-muted')
                }
              >
                {failing ? 'Error' : product.stock ? STOCK[product.stock].label : 'Unknown'}
              </span>
            </div>

            {/* Col 6: Telemetry log + Actions */}
            <div className="flex items-center justify-between gap-1 font-mono text-[11px] lg:col-span-2 lg:justify-end">
              <div className="flex items-center gap-1 text-muted">
                <span className={failing ? 'text-failed' : ''}>
                  {failing ? 'Failed ' : 'Scraped '}
                  {formatRelative(product.scraped_at!)}
                </span>
                <span className="hidden text-rule lg:inline">/</span>
                <span>{product.history_count} records</span>
              </div>
              <div className="flex items-center gap-2 pl-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void scrape(product.id)}
                  title="Scrape now"
                  className="font-mono text-[11px] text-muted transition-colors hover:text-ink disabled:opacity-50"
                >
                  {pending ? '…' : 'Scrape'}
                </button>
                <button
                  type="button"
                  onClick={() => onUntrack(product)}
                  title="Untrack product"
                  className="font-mono text-[11px] text-muted transition-colors hover:text-failed"
                >
                  ×
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-start lg:col-span-5">
              <span className="font-mono text-[12px] text-muted">
                {failing
                  ? 'No data yet, multiple attempts failed'
                  : nextRun
                    ? `No data yet, first scrape at ${formatTimestamp(nextRun.toISOString())}`
                    : 'Pending initial scrape'}
              </span>
            </div>
            <div className="flex items-center justify-between lg:col-span-1 lg:justify-center">
              <span className="font-sans text-[11px] text-muted lg:hidden">Status:</span>
              <span className={'font-sans text-[13px] ' + (failing ? 'text-failed' : 'text-muted')}>
                {failing ? 'Error' : 'Pending'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-1 font-mono text-[11px] text-muted lg:col-span-2 lg:justify-end">
              <span>{nextRun ? `Scheduled ${formatRelative(nextRun.toISOString())}` : 'Scheduled'}</span>
              <span className="hidden text-rule lg:inline">/</span>
              <span>0 records</span>
              <div className="flex items-center gap-2 pl-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void scrape(product.id)}
                  className="font-mono text-[11px] text-muted transition-colors hover:text-ink disabled:opacity-50"
                >
                  {pending ? '…' : 'Scrape'}
                </button>
                <button
                  type="button"
                  onClick={() => onUntrack(product)}
                  className="font-mono text-[11px] text-muted transition-colors hover:text-failed"
                >
                  ×
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {scrapeError && (
        <div className="mt-1 font-mono text-[11px] text-failed">Scrape error: {scrapeError}</div>
      )}
    </div>
  );
}
