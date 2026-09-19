import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type HistoryRange,
  type PriceSnapshot,
  type Product,
  type ProductListItem,
  type Run,
  type ScrapeLog,
  type StockStatus,
} from '../lib/api';
import { PriceChart, type ChartPoint, type ChartFailure } from '../components/PriceChart';
import { formatDuration, formatMoney, formatRelative, formatTimestamp } from '../lib/format';
import { useManualScrape } from '../hooks/useManualScrape';
import { SearchTrack } from '../components/SearchTrack';

const DAY = 24 * 60 * 60 * 1000;

const STOCK_META: Record<StockStatus, { label: string; textClass: string; dotClass: string }> = {
  in_stock: { label: 'In stock', textClass: 'text-ok', dotClass: 'bg-ok' },
  low_stock: { label: 'Low stock', textClass: 'text-retried', dotClass: 'bg-retried' },
  out_of_stock: { label: 'Out of stock', textClass: 'text-muted', dotClass: 'bg-muted' },
};

function deltaColorClass(pct: number): string {
  if (pct < 0) return 'text-ok'; // price drop
  if (pct > 0) return 'text-failed'; // price rise
  return 'text-muted';
}

function computeStats(hist: PriceSnapshot[]) {
  if (hist.length === 0) return null;
  const last = hist[hist.length - 1]!;
  const cur = Number(last.price);
  const cutoff = new Date(last.scraped_at).getTime() - DAY;
  let prev: PriceSnapshot | undefined;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (new Date(hist[i]!.scraped_at).getTime() <= cutoff) {
      prev = hist[i];
      break;
    }
  }
  const priorPrice = prev ? Number(prev.price) : null;
  const change = priorPrice != null ? cur - priorPrice : null;
  const changePct = priorPrice ? (change! / priorPrice) * 100 : null;
  let low = hist[0]!;
  let high = hist[0]!;
  for (const h of hist) {
    if (Number(h.price) < Number(low.price)) low = h;
    if (Number(h.price) > Number(high.price)) high = h;
  }
  return { cur, change, changePct, priorPrice, low, high };
}

function computeSuccess(logs: ScrapeLog[]) {
  const runs = new Map<string, { hasFailed: boolean; attempts: number }>();
  for (const l of logs) {
    if (!l.run_id) continue;
    const c = runs.get(l.run_id) ?? { hasFailed: false, attempts: 0 };
    c.attempts = Math.max(c.attempts, l.attempt_no);
    if (l.status === 'failed') c.hasFailed = true;
    runs.set(l.run_id, c);
  }
  let failed = 0;
  let retriedOk = 0;
  for (const r of runs.values()) {
    if (r.hasFailed) failed++;
    else if (r.attempts > 1) retriedOk++;
  }
  const total = runs.size;
  return { total, ok: total - failed, failed, retriedOk, rate: total ? ((total - failed) / total) * 100 : null };
}

function runAttemptTotals(logs: ScrapeLog[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of logs) {
    if (!l.run_id) continue;
    m.set(l.run_id, Math.max(m.get(l.run_id) ?? 0, l.attempt_no));
  }
  return m;
}

function rangeDomain(range: HistoryRange, points: ChartPoint[]): [number, number] {
  const now = Date.now();
  if (range === '24h') return [now - DAY, now];
  if (range === '7d') return [now - 7 * DAY, now];
  if (points.length === 0) return [now - 7 * DAY, now];
  const ts = points.map((p) => p.t);
  return [Math.min(...ts), Math.max(Math.max(...ts), now)];
}

const INTERVAL_OPTIONS: Array<[number, string]> = [
  [30, '30 mins'],
  [60, '1 hour'],
  [120, '2 hours'],
  [240, '4 hours'],
  [360, '6 hours'],
  [720, '12 hours'],
  [1440, '24 hours'],
];

export function Dashboard() {
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [_runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'ERR' | 'OOS'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDrawer, setShowAddDrawer] = useState(false);

  // Active target workbench state
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);
  const [activeLatest, setActiveLatest] = useState<PriceSnapshot | null>(null);
  const [activeHistory, setActiveHistory] = useState<PriceSnapshot[]>([]);
  const [activeLogs, setActiveLogs] = useState<ScrapeLog[]>([]);
  const [historyRange, setHistoryRange] = useState<HistoryRange>('7d');
  const [chartLoading, setChartLoading] = useState(false);

  const loadDashboard = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([api.listProducts(), api.listRuns()]);
      setProducts(p.items);
      setRuns(r.runs);
      if (!selectedId && p.items.length > 0) {
        setSelectedId(p.items[0]!.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load targets');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  // Load active target details whenever selectedId or historyRange changes
  const loadTargetDetail = useCallback(async (id: string, range: HistoryRange) => {
    try {
      const [detail, hist, logs] = await Promise.all([
        api.getProduct(id),
        api.getHistory(id, range),
        api.getLogs(id, 100),
      ]);
      setActiveProduct(detail.product);
      setActiveLatest(detail.latest);
      setActiveHistory(hist.history);
      setActiveLogs(logs.logs);
    } catch {
      /* keep prior telemetry */
    } finally {
      setChartLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) {
      void loadTargetDetail(selectedId, historyRange);
    }
  }, [selectedId, historyRange, loadTargetDetail]);

  const { pending: scrapingActive, scrape: manualScrapeActive } = useManualScrape(async () => {
    if (selectedId) {
      await Promise.all([loadDashboard(), loadTargetDetail(selectedId, historyRange)]);
    }
  });

  const changeRange = async (r: HistoryRange) => {
    if (!selectedId) return;
    setHistoryRange(r);
    setChartLoading(true);
    await loadTargetDetail(selectedId, r);
  };

  const handleUntrack = async (p: ProductListItem | Product) => {
    if (!window.confirm(`Untrack "${p.name}"? Price history will be preserved.`)) return;
    try {
      await api.untrackProduct(p.id);
      const remaining = products.filter((x) => x.id !== p.id);
      setProducts(remaining);
      if (selectedId === p.id) {
        setSelectedId(remaining.length > 0 ? remaining[0]!.id : null);
      }
      void loadDashboard();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not untrack product');
    }
  };

  const handleIntervalChange = async (mins: number) => {
    if (!activeProduct) return;
    try {
      const { product: updated } = await api.setInterval(activeProduct.id, mins);
      setActiveProduct(updated);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to update scrape interval');
    }
  };

  // Filtered targets list
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (filter === 'ERR' && p.consecutive_failures === 0) return false;
      if (filter === 'OOS' && p.stock !== 'out_of_stock') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = p.name.toLowerCase().includes(q);
        const matchesId = p.source_product_id.toLowerCase().includes(q);
        const matchesUrl = p.url.toLowerCase().includes(q);
        if (!matchesName && !matchesId && !matchesUrl) return false;
      }
      return true;
    });
  }, [products, filter, searchQuery]);

  const errCount = useMemo(() => products.filter((p) => p.consecutive_failures > 0).length, [products]);
  const oosCount = useMemo(() => products.filter((p) => p.stock === 'out_of_stock').length, [products]);

  const stats = useMemo(() => computeStats(activeHistory), [activeHistory]);
  const success = useMemo(() => computeSuccess(activeLogs), [activeLogs]);
  const attemptTotals = useMemo(() => runAttemptTotals(activeLogs), [activeLogs]);

  const chartPoints: ChartPoint[] = useMemo(
    () =>
      activeHistory.map((h) => ({
        t: new Date(h.scraped_at).getTime(),
        price: Number(h.price),
        stock: h.stock,
        source: h.extraction_source,
      })),
    [activeHistory],
  );

  const chartFailures: ChartFailure[] = useMemo(
    () =>
      activeLogs
        .filter((l) => l.status === 'failed')
        .map((l) => ({
          t: new Date(l.created_at).getTime(),
          error_code: l.error_code,
          error_message: l.error_message,
          http_status: l.http_status,
        })),
    [activeLogs],
  );

  const domain = useMemo(() => rangeDomain(historyRange, chartPoints), [historyRange, chartPoints]);
  const activeCurrency = activeLatest?.currency ?? 'INR';
  const trackedStoreIds = useMemo(() => new Set(products.map((p) => p.source_product_id)), [products]);

  if (loading) {
    return (
      <div className="flex h-72 flex-col items-center justify-center gap-3 rounded border border-rule bg-surface p-6 font-mono text-[12px] text-muted">
        <div className="flex items-center gap-2 text-ink">
          <span className="inline-block h-2 w-2 animate-ping rounded-full bg-ok" />
          <span>Loading telemetry workbench…</span>
        </div>
        <p className="max-w-md text-center text-[11px] text-muted">
          If the backend was idle, Render is waking up from free-tier sleep (~30s).
        </p>
        <button
          type="button"
          onClick={() => void loadDashboard()}
          className="mt-2 rounded border border-rule bg-bg px-3 py-1 text-[11px] text-ink hover:bg-surface-hover"
        >
          Force Refresh
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-failed bg-surface p-4 text-center font-mono text-[12px]">
        <div className="text-failed">Failed to load telemetry targets: {error}</div>
        <button
          type="button"
          onClick={() => void loadDashboard()}
          className="mt-2 rounded border border-rule bg-bg px-3 py-1 text-ink hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded border border-rule lg:flex-row min-h-[calc(100vh-8.5rem)]">
      {/* ================= LEFT PANE: TARGETS WATCHLIST (38%) ================= */}
      <aside className="flex w-full shrink-0 flex-col overflow-hidden border-b border-rule bg-surface lg:w-[38%] lg:border-b-0 lg:border-r">
        {/* Subheader & Filter Tabs */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rule bg-bg p-2.5">
          <div className="flex items-center gap-1.5 font-mono text-[11px]">
            <span className="font-sans text-[12px] font-medium text-ink">Tracked Targets</span>
            <span className="rounded border border-rule bg-surface px-1.5 py-0.2 text-[10px] text-muted">
              {products.length} total
            </span>
          </div>
          <div className="flex items-center gap-1 font-mono text-[10px]">
            <button
              type="button"
              onClick={() => setFilter('ALL')}
              className={
                'rounded px-2 py-0.5 font-medium transition-colors ' +
                (filter === 'ALL'
                  ? 'border border-rule bg-surface text-ink'
                  : 'text-muted hover:bg-surface-hover hover:text-ink')
              }
            >
              ALL ({products.length})
            </button>
            <button
              type="button"
              onClick={() => setFilter('ERR')}
              className={
                'rounded px-2 py-0.5 font-medium transition-colors ' +
                (filter === 'ERR'
                  ? 'border border-failed/40 bg-failed/10 text-failed'
                  : 'text-muted hover:bg-surface-hover hover:text-failed')
              }
            >
              ERR ({errCount})
            </button>
            <button
              type="button"
              onClick={() => setFilter('OOS')}
              className={
                'rounded px-2 py-0.5 font-medium transition-colors ' +
                (filter === 'OOS'
                  ? 'border border-rule bg-surface text-ink'
                  : 'text-muted hover:bg-surface-hover hover:text-ink')
              }
            >
              OOS ({oosCount})
            </button>
          </div>
        </div>

        {/* Quick Filter Box */}
        <div className="border-b border-rule bg-surface px-2.5 py-2">
          <div className="relative flex items-center">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter targets or SKUs…"
              aria-label="Filter targets"
              className="h-7 w-full rounded border border-rule bg-bg px-2 font-mono text-[11px] text-ink placeholder:text-muted focus:border-muted focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 font-mono text-[10px] text-muted hover:text-ink"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Add Target Drawer / Search Module */}
        {showAddDrawer && (
          <div className="border-b border-rule bg-bg p-2.5">
            <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-muted">
              <span className="font-medium text-ink">Add New Target from Store</span>
              <button
                type="button"
                onClick={() => setShowAddDrawer(false)}
                className="text-muted hover:text-ink"
              >
                Close ×
              </button>
            </div>
            <SearchTrack
              trackedStoreIds={trackedStoreIds}
              onTracked={() => {
                setShowAddDrawer(false);
                void loadDashboard();
              }}
            />
          </div>
        )}

        {/* Dense Target Items List */}
        <div className="flex-1 divide-y divide-rule overflow-y-auto bg-surface">
          {filteredProducts.length === 0 ? (
            <div className="p-4 text-center font-mono text-[11px] text-muted">
              {products.length === 0 ? 'No products tracked yet.' : 'No targets match the active filter.'}
            </div>
          ) : (
            filteredProducts.map((p) => {
              const isSelected = selectedId === p.id;
              const failing = p.consecutive_failures > 0;
              const stockInfo = p.stock ? STOCK_META[p.stock] : null;
              const host = p.url.replace(/^https?:\/\//, '').split('/')[0];

              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={
                    'relative cursor-pointer p-2.5 transition-colors ' +
                    (isSelected
                      ? 'border-l-[3px] border-l-ok bg-surface-hover'
                      : failing
                        ? 'border-l-[3px] border-l-failed bg-surface hover:bg-surface-hover'
                        : 'border-l-[3px] border-l-transparent bg-surface hover:bg-surface-hover')
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                        <span className="rounded border border-rule bg-bg px-1 py-0.2 text-muted">
                          id: {p.source_product_id}
                        </span>
                        {failing ? (
                          <span className="flex items-center gap-0.5 font-semibold text-failed">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-failed" />
                            FAILED ({p.last_error_code ?? 'err'})
                          </span>
                        ) : stockInfo ? (
                          <span className={'flex items-center gap-0.5 ' + stockInfo.textClass}>
                            <span className={'h-1 w-1 rounded-full ' + stockInfo.dotClass} />
                            {stockInfo.label}
                          </span>
                        ) : (
                          <span className="text-muted">Pending</span>
                        )}
                        <span className="text-rule">·</span>
                        <span className="truncate text-muted">{host}</span>
                      </div>
                      <div className={'truncate font-sans text-[13px] font-medium leading-snug ' + (failing ? 'text-failed' : 'text-ink')}>
                        {p.name}
                      </div>
                      <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted">
                        <span>{p.scraped_at ? `Scraped ${formatRelative(p.scraped_at)}` : 'Awaiting scrape'}</span>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <div className="font-mono text-[14px] font-medium tabular-nums text-ink">
                        {p.price ? formatMoney(p.price, p.currency ?? 'INR') : '—.—'}
                      </div>
                      <div
                        className={
                          'flex items-center justify-end gap-0.5 font-mono text-[11px] tabular-nums ' +
                          (p.change_24h_pct != null ? deltaColorClass(p.change_24h_pct) : 'text-muted')
                        }
                      >
                        {p.change_24h_pct != null && (
                          <span>{p.change_24h_pct < 0 ? '▼' : p.change_24h_pct > 0 ? '▲' : ''}</span>
                        )}
                        <span>
                          {p.change_24h_pct != null
                            ? `${p.change_24h_pct > 0 ? '+' : ''}${p.change_24h_pct.toFixed(1)}%`
                            : '0.0%'}
                        </span>
                      </div>
                      <span className="font-mono text-[10px] text-muted">{p.history_count} records</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Watchlist Bottom Action Bar */}
        <div className="flex shrink-0 items-center justify-between border-t border-rule bg-bg p-2 font-mono text-[11px] text-muted">
          <span>Auto-sort: Last activity</span>
          <button
            type="button"
            onClick={() => setShowAddDrawer((prev) => !prev)}
            className="flex items-center gap-1 text-ink hover:underline"
          >
            + Add Target
          </button>
        </div>
      </aside>

      {/* ================= RIGHT PANE: ACTIVE TARGET TELEMETRY WORKBENCH (62%) ================= */}
      <main className="flex flex-1 flex-col overflow-y-auto bg-bg">
        {activeProduct ? (
          <div className="flex flex-col gap-3 p-4">
            {/* 1. Header & Controls Context Bar */}
            <div className="flex flex-col gap-3 rounded border border-rule bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-muted">Scrape every:</span>
                  <select
                    value={activeProduct.scrape_interval_mins}
                    onChange={(e) => void handleIntervalChange(Number(e.target.value))}
                    className="rounded border border-rule bg-bg px-2 py-0.5 font-mono text-[11px] text-ink focus:outline-none"
                  >
                    {INTERVAL_OPTIONS.map(([val, lbl]) => (
                      <option key={val} value={val}>
                        {lbl}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <button
                    type="button"
                    disabled={scrapingActive}
                    onClick={() => void manualScrapeActive(activeProduct.id)}
                    className="flex items-center gap-1 rounded border border-rule bg-surface px-2.5 py-1 font-sans text-[11px] font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    <span>{scrapingActive ? 'Scraping…' : 'Scrape now'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleUntrack(activeProduct)}
                    className="flex items-center gap-1 rounded border border-rule bg-surface px-2.5 py-1 font-sans text-[11px] font-medium text-muted transition-colors hover:border-failed hover:text-failed"
                  >
                    <span>Untrack</span>
                  </button>
                </div>
              </div>

              {/* Title & Big Price Cluster */}
              <div className="flex flex-wrap items-baseline justify-between gap-3 pt-1">
                <div>
                  <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                    <span className="rounded border border-rule bg-bg px-1.5 py-0.2 font-medium text-ink">
                      id: {activeProduct.source_product_id}
                    </span>
                    {activeLatest?.stock && (
                      <span className={'flex items-center gap-1 rounded border px-1.5 py-0.2 text-[10px] ' + STOCK_META[activeLatest.stock].textClass}>
                        <span className={'h-1.5 w-1.5 rounded-full ' + STOCK_META[activeLatest.stock].dotClass} />
                        {STOCK_META[activeLatest.stock].label}
                      </span>
                    )}
                    <a
                      href={activeProduct.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-muted hover:text-ink hover:underline"
                    >
                      {activeProduct.url.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                  <h1 className="font-sans text-[20px] font-semibold tracking-tight text-ink">
                    {activeProduct.name}
                  </h1>
                </div>

                <div className="shrink-0 text-right">
                  <div className="font-mono text-[26px] font-semibold tabular-nums tracking-tight text-ink">
                    {activeLatest?.price ? formatMoney(activeLatest.price, activeCurrency) : '—.—'}
                  </div>
                  <div className="flex items-center justify-end gap-1 font-mono text-[11px] text-muted">
                    <span>DOM: <code className="font-mono text-ink">{activeLatest?.extraction_source ?? '.price-block'}</code></span>
                    <span>·</span>
                    <span className="text-ok">verified ok</span>
                  </div>
                </div>
              </div>

              {/* 4 Stat Blocks Grid */}
              <div className="grid grid-cols-2 gap-2 border-t border-rule pt-2 sm:grid-cols-4">
                <div className="flex flex-col rounded border border-rule bg-bg p-2.5">
                  <span className="font-sans text-[10px] uppercase tracking-wider text-muted">24h change</span>
                  <div
                    className={
                      'mt-0.5 font-mono text-[13px] font-semibold tabular-nums ' +
                      (stats?.changePct != null ? deltaColorClass(stats.changePct) : 'text-ink')
                    }
                  >
                    {stats?.changePct != null
                      ? `${stats.changePct > 0 ? '+' : ''}${stats.changePct.toFixed(1)}%`
                      : '—'}
                  </div>
                  <span className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {stats?.priorPrice != null
                      ? `Prev ${formatMoney(String(stats.priorPrice), activeCurrency)}`
                      : 'No prior reading in 24h'}
                  </span>
                </div>

                <div className="flex flex-col rounded border border-rule bg-bg p-2.5">
                  <span className="font-sans text-[10px] uppercase tracking-wider text-muted">7 day low</span>
                  <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-ok">
                    {stats ? formatMoney(stats.low.price, activeCurrency) : '—'}
                  </div>
                  <span className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {stats ? formatTimestamp(stats.low.scraped_at) : 'Awaiting reading'}
                  </span>
                </div>

                <div className="flex flex-col rounded border border-rule bg-bg p-2.5">
                  <span className="font-sans text-[10px] uppercase tracking-wider text-muted">7 day high</span>
                  <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-ink">
                    {stats ? formatMoney(stats.high.price, activeCurrency) : '—'}
                  </div>
                  <span className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {stats ? formatTimestamp(stats.high.scraped_at) : 'Awaiting reading'}
                  </span>
                </div>

                <div className="flex flex-col rounded border border-rule bg-bg p-2.5">
                  <span className="font-sans text-[10px] uppercase tracking-wider text-muted">Scrape success rate</span>
                  <div className="mt-0.5 font-mono text-[13px] font-semibold tabular-nums text-ok">
                    {success.rate != null ? `${success.rate.toFixed(1)}%` : '—'}
                  </div>
                  <span className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {success.total ? `${success.ok} of ${success.total} runs ok` : 'No attempts'}
                  </span>
                </div>
              </div>
            </div>

            {/* 2. Price Telemetry Timeline Chart Panel */}
            <div className="flex flex-col gap-2.5 rounded border border-rule bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3 font-mono text-[11px]">
                  <span className="font-sans text-[13px] font-medium text-ink">Price telemetry</span>
                  <div className="flex items-center gap-3 text-[10px] text-muted">
                    <span className="flex items-center gap-1">
                      <span className="h-0.5 w-3 bg-ok" /> Observed price
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-sm bg-rule" /> Out of stock
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-failed" /> Failed scrape
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1 font-mono text-[10px]">
                  {(['24h', '7d', 'all'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => void changeRange(r)}
                      className={
                        'rounded px-2 py-0.5 transition-colors ' +
                        (historyRange === r
                          ? 'border border-rule bg-bg font-semibold text-ink'
                          : 'text-muted hover:bg-bg hover:text-ink')
                      }
                    >
                      {r === 'all' ? 'All' : r}
                    </button>
                  ))}
                </div>
              </div>

              <div className={chartLoading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
                <PriceChart
                  points={chartPoints}
                  failures={chartFailures}
                  domain={domain}
                  currency={activeCurrency}
                />
              </div>
            </div>

            {/* 3. Lower Side-by-Side Tables */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {/* Extraction History Table */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="font-sans text-[12px] font-medium text-ink">Price extraction history</span>
                  <span className="text-muted">{activeHistory.length} in range</span>
                </div>
                <div className="flex-1 overflow-hidden rounded border border-rule bg-surface">
                  <table className="w-full border-collapse text-left font-mono text-[11px]">
                    <thead>
                      <tr className="h-7 border-b border-rule bg-bg text-muted">
                        <th className="px-2.5 font-medium">Time (UTC)</th>
                        <th className="px-2.5 text-right font-medium">Price</th>
                        <th className="px-2.5 text-center font-medium">Stock</th>
                        <th className="px-2.5 font-medium">Method</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {activeHistory.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-4 text-center text-muted">
                            No price points recorded in this range.
                          </td>
                        </tr>
                      ) : (
                        [...activeHistory].reverse().map((h, i) => (
                          <tr key={i} className="h-7.5 transition-colors hover:bg-surface-hover">
                            <td className="px-2.5 tabular-nums text-ink">{formatTimestamp(h.scraped_at)}</td>
                            <td
                              className={
                                'px-2.5 text-right font-medium tabular-nums ' +
                                (h.stock === 'out_of_stock' ? 'text-muted' : 'text-ok')
                              }
                            >
                              {formatMoney(h.price, h.currency)}
                            </td>
                            <td className="px-2.5 text-center">
                              <span className={'rounded px-1 py-0.2 text-[10px] ' + STOCK_META[h.stock].textClass}>
                                {STOCK_META[h.stock].label}
                              </span>
                            </td>
                            <td className="max-w-[120px] truncate px-2.5 text-muted">
                              <code>{h.extraction_source ?? '.price-block'}</code>
                              {h.layout_revision != null && ` · rev ${h.layout_revision}`}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Scrape Diagnostic Log Table */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="font-sans text-[12px] font-medium text-ink">Scrape diagnostic log</span>
                  <span className="text-muted">{activeLogs.length} attempts</span>
                </div>
                <div className="flex-1 overflow-hidden rounded border border-rule bg-surface">
                  <table className="w-full border-collapse text-left font-mono text-[11px]">
                    <thead>
                      <tr className="h-7 border-b border-rule bg-bg text-muted">
                        <th className="px-2.5 font-medium">Time</th>
                        <th className="px-2.5 text-center font-medium">Attempt</th>
                        <th className="px-2.5 font-medium">Outcome</th>
                        <th className="px-2.5 text-right font-medium">Duration</th>
                        <th className="px-2.5 font-medium">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-rule">
                      {activeLogs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-4 text-center text-muted">
                            No scrape attempts recorded yet.
                          </td>
                        </tr>
                      ) : (
                        activeLogs.map((l, i) => (
                          <tr key={i} className="h-7.5 transition-colors hover:bg-surface-hover">
                            <td className="px-2.5 tabular-nums text-ink">{formatTimestamp(l.created_at)}</td>
                            <td className="px-2.5 text-center text-muted">
                              {l.attempt_no}
                              {l.run_id && attemptTotals.get(l.run_id) ? ` of ${attemptTotals.get(l.run_id)}` : ''}
                            </td>
                            <td className="px-2.5">
                              <span
                                className={
                                  'rounded border px-1.5 py-0.2 text-[10px] ' +
                                  (l.status === 'success'
                                    ? 'border-ok/30 bg-ok/10 text-ok'
                                    : l.status === 'retried'
                                      ? 'border-retried/30 bg-retried/10 text-retried'
                                      : 'border-failed/30 bg-failed/10 text-failed')
                                }
                              >
                                {l.status}
                              </span>
                            </td>
                            <td className="px-2.5 text-right tabular-nums text-muted">
                              {formatDuration(l.duration_ms)}
                            </td>
                            <td
                              className={
                                'max-w-[130px] truncate px-2.5 ' +
                                (l.status === 'failed' ? 'text-failed' : 'text-muted')
                              }
                            >
                              {[l.error_code, l.http_status ? `http ${l.http_status}` : null, l.error_message]
                                .filter(Boolean)
                                .join(', ') || `status ${l.http_status ?? '—'}`}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 font-mono text-[12px] text-muted">
            Select a target from the watchlist to view live telemetry.
          </div>
        )}
      </main>
    </div>
  );
}
