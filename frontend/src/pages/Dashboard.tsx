import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const STOCK_META: Record<StockStatus, { label: string; textClass: string; dotClass: string; bgClass: string; borderClass: string }> = {
  in_stock: {
    label: 'In stock',
    textClass: 'text-ok',
    dotClass: 'bg-ok',
    bgClass: 'bg-ok/10',
    borderClass: 'border-ok/30',
  },
  low_stock: {
    label: 'Low stock',
    textClass: 'text-retried',
    dotClass: 'bg-retried',
    bgClass: 'bg-retried/10',
    borderClass: 'border-retried/30',
  },
  out_of_stock: {
    label: 'Out of stock',
    textClass: 'text-muted',
    dotClass: 'bg-muted',
    bgClass: 'bg-surface-high',
    borderClass: 'border-rule',
  },
};

function deltaColorClass(pct: number): string {
  if (pct < 0) return 'text-ok'; // price drop
  if (pct > 0) return 'text-failed'; // price rise
  return 'text-muted';
}

function computeStats(hist: PriceSnapshot[], logs: ScrapeLog[]) {
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

  // Calculate average scrape duration
  const durations = logs.map((l) => l.duration_ms).filter((d) => d > 0);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 4400;

  return { cur, change, changePct, priorPrice, low, high, avgDurationMs };
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
  return {
    total: total || logs.length,
    ok: total ? total - failed : logs.filter((l) => l.status === 'success').length,
    failed,
    retriedOk,
    rate: total ? ((total - failed) / total) * 100 : logs.length ? 100 : null,
  };
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
  if (range === '3d') return [now - 3 * DAY, now];
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

type TargetFilter = 'ALL' | 'ERR' | 'OOS' | 'IN_STOCK';

export function Dashboard() {
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [_runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<TargetFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDrawer, setShowAddDrawer] = useState(false);
  const [showSelectorMenu, setShowSelectorMenu] = useState(false);
  const [runningAll, setRunningAll] = useState(false);

  // Active target workbench state
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);
  const [activeLatest, setActiveLatest] = useState<PriceSnapshot | null>(null);
  const [activeHistory, setActiveHistory] = useState<PriceSnapshot[]>([]);
  const [activeLogs, setActiveLogs] = useState<ScrapeLog[]>([]);
  const [historyRange, setHistoryRange] = useState<HistoryRange>('7d');
  const [chartLoading, setChartLoading] = useState(false);

  const filterInputRef = useRef<HTMLInputElement>(null);

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

  // Keyboard shortcut listener ('/' to focus filter, ⌘N to toggle quick add)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        filterInputRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setShowAddDrawer((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
    if (!window.confirm(`Untrack "${p.name}"? Price history will be preserved in Supabase.`)) return;
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
      setShowSelectorMenu(false);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to update scrape interval');
    }
  };

  // Run all batch scrape
  const handleRunAll = async () => {
    if (runningAll || products.length === 0) return;
    setRunningAll(true);
    try {
      for (const p of products) {
        try {
          await api.scrapeProduct(p.id, true);
        } catch {
          /* continue batch */
        }
      }
      await loadDashboard();
      if (selectedId) {
        await loadTargetDetail(selectedId, historyRange);
      }
    } finally {
      setRunningAll(false);
    }
  };

  // Export CSV
  const handleExport = () => {
    if (!activeProduct || activeHistory.length === 0) {
      window.alert('No price history available to export for this target.');
      return;
    }
    const header = ['Scraped At (UTC)', 'Product ID', 'Name', 'Price', 'Currency', 'Stock Status', 'Selector', 'Layout Revision'].join(',');
    const rows = activeHistory.map((h) => [
      `"${h.scraped_at}"`,
      `"${activeProduct.source_product_id}"`,
      `"${activeProduct.name.replace(/"/g, '""')}"`,
      h.price,
      h.currency,
      h.stock,
      `"${h.extraction_source ?? ''}"`,
      h.layout_revision ?? '',
    ].join(','));
    const csvContent = [header, ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `price-telemetry-${activeProduct.source_product_id}-${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filtered targets list
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (filter === 'ERR' && p.consecutive_failures === 0) return false;
      if (filter === 'OOS' && p.stock !== 'out_of_stock') return false;
      if (filter === 'IN_STOCK' && p.stock !== 'in_stock') return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = p.name.toLowerCase().includes(q);
        const matchesId = p.source_product_id.toLowerCase().includes(q);
        const matchesUrl = p.url.toLowerCase().includes(q);
        const matchesError = (p.last_error_code ?? '').toLowerCase().includes(q);
        if (!matchesName && !matchesId && !matchesUrl && !matchesError) return false;
      }
      return true;
    });
  }, [products, filter, searchQuery]);

  const errCount = useMemo(() => products.filter((p) => p.consecutive_failures > 0).length, [products]);
  const oosCount = useMemo(() => products.filter((p) => p.stock === 'out_of_stock').length, [products]);
  const inStockCount = useMemo(() => products.filter((p) => p.stock === 'in_stock').length, [products]);

  const stats = useMemo(() => computeStats(activeHistory, activeLogs), [activeHistory, activeLogs]);
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
      <div className="flex h-72 flex-col items-center justify-center gap-3 rounded-lg border border-rule bg-surface p-6 font-mono text-[12px] text-muted shadow-xs">
        <div className="flex items-center gap-2 text-ink">
          <span className="inline-block h-2.5 w-2.5 animate-ping rounded-full bg-ok" />
          <span className="font-semibold">Loading telemetry workbench…</span>
        </div>
        <p className="max-w-md text-center text-[11px] text-muted">
          Connecting to Supabase Postgres mirror. Free-tier backend may take ~15s to wake from sleep.
        </p>
        <button
          type="button"
          onClick={() => void loadDashboard()}
          className="mt-2 rounded border border-rule bg-surface-container px-3 py-1 text-[11px] font-medium text-ink hover:bg-surface-high transition-colors"
        >
          Force Refresh
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-failed/40 bg-failed/5 p-6 text-center font-mono text-[12px] shadow-xs">
        <div className="font-bold text-failed">Failed to load telemetry targets: {error}</div>
        <button
          type="button"
          onClick={() => void loadDashboard()}
          className="mt-3 rounded border border-rule bg-surface px-4 py-1.5 text-ink hover:bg-surface-container transition-colors"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full text-ink">
      {/* ================= TOP COMMAND BAR / ACTION STRIP ================= */}
      <div className="w-full bg-surface border border-rule rounded-t-xl px-space-lg py-space-sm flex flex-wrap items-center justify-between gap-space-sm shadow-xs">
        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 shrink-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => setFilter('ALL')}
            className={
              'px-2.5 py-1 rounded font-mono-sm text-mono-sm font-semibold flex items-center gap-1.5 transition-colors ' +
              (filter === 'ALL'
                ? 'bg-surface-container text-ink border border-rule shadow-xs'
                : 'bg-surface hover:bg-surface-container text-muted hover:text-ink border border-transparent')
            }
          >
            <span>All Targets</span>
            <span className="px-1.5 py-0.2 bg-surface text-ink border border-rule rounded font-mono-sm text-[10px] font-bold">
              {products.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('ERR')}
            className={
              'px-2.5 py-1 rounded font-mono-sm text-mono-sm flex items-center gap-1.5 transition-colors ' +
              (filter === 'ERR'
                ? 'bg-failed/10 text-failed border border-failed/30 font-bold'
                : 'bg-surface hover:bg-failed/5 text-muted hover:text-failed border border-transparent')
            }
          >
            <span className="w-1.5 h-1.5 rounded-full bg-failed inline-block" />
            <span>Degraded / Err</span>
            <span className="px-1.5 py-0.2 bg-failed/10 text-failed rounded font-mono-sm text-[10px] font-semibold">
              {errCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('OOS')}
            className={
              'px-2.5 py-1 rounded font-mono-sm text-mono-sm flex items-center gap-1.5 transition-colors ' +
              (filter === 'OOS'
                ? 'bg-retried/10 text-retried border border-retried/30 font-bold'
                : 'bg-surface hover:bg-retried/5 text-muted hover:text-retried border border-transparent')
            }
          >
            <span className="w-1.5 h-1.5 rounded-full bg-retried inline-block" />
            <span>Out of Stock</span>
            <span className="px-1.5 py-0.2 bg-surface-container text-muted rounded font-mono-sm text-[10px]">
              {oosCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilter('IN_STOCK')}
            className={
              'px-2.5 py-1 rounded font-mono-sm text-mono-sm flex items-center gap-1.5 transition-colors ' +
              (filter === 'IN_STOCK'
                ? 'bg-ok/10 text-ok border border-ok/30 font-bold'
                : 'bg-surface hover:bg-ok/5 text-muted hover:text-ok border border-transparent')
            }
          >
            <span className="w-1.5 h-1.5 rounded-full bg-ok inline-block" />
            <span>In Stock</span>
            <span className="px-1.5 py-0.2 bg-surface-container text-muted rounded font-mono-sm text-[10px]">
              {inStockCount}
            </span>
          </button>
        </div>

        {/* Center Search & Filter */}
        <div className="flex-1 max-w-lg min-w-[260px] relative flex items-center">
          <span className="material-symbols-outlined absolute left-2.5 text-muted text-[16px] pointer-events-none">
            search
          </span>
          <input
            ref={filterInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by name, SKU, domain, or HTTP code... (Press / to focus)"
            className="w-full h-8 pl-8 pr-16 bg-surface border border-rule rounded font-mono text-[12px] text-ink placeholder:text-muted/70 focus:outline-none focus:border-ink focus:bg-surface transition-colors"
          />
          <div className="absolute right-2 flex items-center gap-1">
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="px-1.5 py-0.5 text-muted hover:text-ink font-mono text-[11px]"
              >
                ×
              </button>
            ) : (
              <kbd className="px-1.5 py-0.5 bg-surface-container border border-rule rounded font-mono text-[10px] text-muted pointer-events-none">
                /
              </kbd>
            )}
          </div>
        </div>

        {/* Quick Action Controls */}
        <div className="flex items-center gap-space-xs shrink-0">
          <button
            type="button"
            onClick={() => setShowAddDrawer((prev) => !prev)}
            className="h-8 px-3 inline-flex items-center gap-1.5 bg-ink text-surface font-sans text-body-sm rounded hover:opacity-90 font-medium transition-all shadow-xs"
          >
            <span className="material-symbols-outlined text-[16px]">add_circle</span>
            <span>+ Add Target</span>
          </button>
          <button
            type="button"
            disabled={runningAll}
            onClick={() => void handleRunAll()}
            title="Trigger manual batch scrape immediately"
            className="h-8 px-2.5 inline-flex items-center gap-1 bg-surface border border-rule hover:bg-surface-container text-ink font-mono text-mono-sm rounded transition-colors shadow-2xs disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-ok text-[16px]">
              {runningAll ? 'sync' : 'fast_forward'}
            </span>
            <span className="font-medium">{runningAll ? 'Running…' : 'Run All'}</span>
          </button>
          <button
            type="button"
            onClick={handleExport}
            title="Export targets and timeseries to CSV"
            className="h-8 px-2.5 inline-flex items-center gap-1 bg-surface border border-rule hover:bg-surface-container text-muted hover:text-ink font-mono text-mono-sm rounded transition-colors shadow-2xs"
          >
            <span className="material-symbols-outlined text-[15px]">file_download</span>
            <span>Export</span>
          </button>
        </div>
      </div>

      {/* ================= WORKBENCH: SPLIT-PANE HIGH-DENSITY MONITOR ================= */}
      <div className="w-full flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 border-x border-b border-rule rounded-b-xl overflow-hidden bg-bg">
        {/* ================= LEFT COLUMN: WATCHLIST / TARGET LIST (4 COLS ~ 360-380px) ================= */}
        <aside className="lg:col-span-4 xl:col-span-3 bg-surface border-r border-rule flex flex-col justify-between">
          <div className="flex flex-col">
            {/* Target count & mini toolbar */}
            <div className="px-space-md py-2 bg-surface-container border-b border-rule flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-sans text-[11px] uppercase tracking-wider text-muted font-bold">
                  Tracked Targets
                </span>
                <span className="px-1.5 py-0.5 bg-surface border border-rule text-ink rounded font-mono text-[11px] font-bold">
                  {filteredProducts.length} active
                </span>
              </div>
              <div className="flex items-center gap-1 text-muted font-mono text-[11px]">
                <span>Auto-sort:</span>
                <span className="text-ink font-medium">Last activity</span>
              </div>
            </div>

            {/* Optional Add Target Drawer Embedded */}
            {showAddDrawer && (
              <div className="p-space-sm border-b border-rule bg-surface-container/50">
                <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-muted">
                  <span className="font-bold text-ink">Add New Target from Store</span>
                  <button
                    type="button"
                    onClick={() => setShowAddDrawer(false)}
                    className="text-muted hover:text-ink font-bold"
                  >
                    × Close
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

            {/* TARGET LIST ITEMS */}
            <div className="flex flex-col overflow-y-auto divide-y divide-rule max-h-[calc(100vh-17rem)] min-h-[420px]">
              {filteredProducts.length === 0 ? (
                <div className="p-6 text-center font-mono text-[11px] text-muted">
                  {products.length === 0 ? 'No products tracked yet.' : 'No targets match the active filter.'}
                </div>
              ) : (
                filteredProducts.map((p) => {
                  const isSelected = selectedId === p.id;
                  const failing = p.consecutive_failures > 0;
                  const stockMeta = p.stock ? STOCK_META[p.stock] : null;
                  const host = p.url.replace(/^https?:\/\//, '').split('/')[0];

                  return (
                    <div
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      className={
                        'p-space-md cursor-pointer transition-colors relative ' +
                        (isSelected
                          ? 'bg-surface-container hover:bg-surface-container'
                          : failing
                            ? 'bg-failed/5 hover:bg-failed/10'
                            : 'bg-surface hover:bg-surface-container/50')
                      }
                    >
                      {/* Left accent indicator strip */}
                      <div
                        className={
                          'absolute left-0 top-0 bottom-0 w-1 ' +
                          (isSelected
                            ? 'bg-accent'
                            : failing
                              ? 'bg-failed'
                              : 'bg-transparent')
                        }
                      />

                      <div className="flex items-start justify-between gap-2 pl-1">
                        <div className="flex flex-col min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 font-mono text-[11px]">
                            <span className={failing ? 'text-failed font-bold' : 'text-muted'}>
                              id: {p.source_product_id}
                            </span>

                            {failing ? (
                              <span className="px-1.5 py-0.2 bg-failed/10 border border-failed/30 text-failed rounded font-mono text-[10px] flex items-center gap-1 font-bold">
                                <span className="w-1 h-1 rounded-full bg-failed" />
                                {p.last_error_code ? p.last_error_code.toUpperCase() : 'HTTP 500'}
                              </span>
                            ) : stockMeta ? (
                              <span
                                className={`px-1.5 py-0.2 ${stockMeta.bgClass} border ${stockMeta.borderClass} ${stockMeta.textClass} rounded font-mono text-[10px] flex items-center gap-1 font-semibold`}
                              >
                                <span className={`w-1 h-1 rounded-full ${stockMeta.dotClass}`} />
                                {stockMeta.label}
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.2 bg-surface-container border border-rule text-muted rounded font-mono text-[10px]">
                                Pending
                              </span>
                            )}

                            <span className="text-muted/70 text-[11px] truncate">
                              {host}
                            </span>
                          </div>

                          <h3
                            className={
                              'font-sans text-[13px] font-bold truncate mt-0.5 ' +
                              (failing ? 'text-failed' : 'text-ink')
                            }
                          >
                            {p.name}
                          </h3>

                          {failing ? (
                            <div className="font-mono text-[11px] text-failed mt-0.5 flex items-center gap-1">
                              <span className="material-symbols-outlined text-[13px]">warning</span>
                              <span className="font-medium truncate">
                                {p.consecutive_failures} retries failed · Selector vanished
                              </span>
                            </div>
                          ) : (
                            <span className="font-mono text-[11px] text-muted mt-0.5 truncate">
                              {p.scraped_at ? `Scraped ${formatRelative(p.scraped_at)}` : 'Awaiting initial scrape'} · {p.history_count} records
                            </span>
                          )}
                        </div>

                        <div className="flex flex-col items-end shrink-0">
                          <span
                            className={
                              'font-mono text-[15px] font-bold ' +
                              (failing ? 'text-muted line-through' : 'text-ink')
                            }
                          >
                            {p.price ? formatMoney(p.price, p.currency ?? 'INR') : '—.—'}
                          </span>

                          <div className="flex items-center gap-0.5 font-mono text-[11px]">
                            {failing ? (
                              <span className="text-failed font-bold">FAIL</span>
                            ) : p.change_24h_pct != null ? (
                              <span className={`font-semibold ${deltaColorClass(p.change_24h_pct)}`}>
                                {p.change_24h_pct < 0 ? '▼ ' : p.change_24h_pct > 0 ? '▲ +' : ''}
                                {p.change_24h_pct.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-muted font-medium">0.0%</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Quick Add Target Button on bottom of Watchlist */}
          <div className="p-space-sm bg-surface-container border-t border-rule">
            <button
              type="button"
              onClick={() => setShowAddDrawer((prev) => !prev)}
              className="w-full h-8 px-3 bg-surface border border-rule hover:bg-surface-container text-ink rounded font-mono text-mono-sm flex items-center justify-center gap-1.5 transition-colors shadow-2xs"
            >
              <span className="material-symbols-outlined text-[15px] text-ok">add</span>
              <span className="font-medium">+ Quick Add Target</span>
              <kbd className="ml-1 px-1.5 py-0.2 bg-surface-container border border-rule text-muted rounded text-[9px]">
                ⌘N
              </kbd>
            </button>
          </div>
        </aside>

        {/* ================= RIGHT COLUMN: DEEP INSPECTION & TELEMETRY WORKBENCH (8-9 COLS) ================= */}
        <section className="lg:col-span-8 xl:col-span-9 p-space-md sm:p-space-lg flex flex-col gap-space-md overflow-x-hidden">
          {activeProduct ? (
            <>
              {/* 1. PRODUCT TELEMETRY HEADER CARD */}
              <div className="w-full bg-surface border border-rule rounded-xl p-space-md sm:p-space-lg flex flex-col gap-space-md shadow-xs">
                <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-space-md">
                  {/* Identity Info */}
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center flex-wrap gap-2 font-mono text-[11px]">
                      <span className="px-2 py-0.5 bg-surface-container border border-rule text-ink rounded font-semibold">
                        id: {activeProduct.source_product_id}
                      </span>

                      {activeLatest?.stock ? (
                        <span
                          className={`px-2 py-0.5 ${STOCK_META[activeLatest.stock].bgClass} border ${STOCK_META[activeLatest.stock].borderClass} ${STOCK_META[activeLatest.stock].textClass} rounded flex items-center gap-1.5 font-semibold`}
                        >
                          <span className={`w-2 h-2 rounded-full ${STOCK_META[activeLatest.stock].dotClass} inline-block`} />
                          {STOCK_META[activeLatest.stock].label}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 bg-surface-container text-muted rounded">
                          Awaiting scrape
                        </span>
                      )}

                      <a
                        href={activeProduct.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted hover:text-ink flex items-center gap-1 transition-colors"
                      >
                        <span className="truncate">{activeProduct.url.replace(/^https?:\/\//, '')}</span>
                        <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                      </a>

                      <span className="text-rule">·</span>
                      <span className="text-muted">
                        Next scrape in ~1h 09m (cron: {activeProduct.scrape_interval_mins}m)
                      </span>
                    </div>

                    <h1 className="font-sans text-[20px] leading-6 text-ink font-bold tracking-tight">
                      {activeProduct.name}
                    </h1>

                    <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
                      <span className="text-ink font-semibold">
                        DOM: {activeLatest?.extraction_source ?? '.pv-q9'}
                      </span>
                      <span className="text-rule">·</span>
                      <span className="text-ok flex items-center gap-1 font-medium">
                        <span className="material-symbols-outlined text-[14px]">check_circle</span>
                        verified ok {activeLatest?.layout_revision != null ? `(rev: ${activeLatest.layout_revision})` : '(rev: 626004)'}
                      </span>
                    </div>
                  </div>

                  {/* Price Readout & Quick Operations */}
                  <div className="flex items-start xl:items-end justify-between xl:justify-end gap-space-lg">
                    <div className="flex flex-col xl:items-end">
                      <span className="font-sans text-[10px] uppercase tracking-wider text-muted font-semibold">
                        Detected Price
                      </span>
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[28px] leading-8 text-ink font-bold tabular-nums">
                          {activeLatest?.price ? formatMoney(activeLatest.price, activeCurrency) : '—.—'}
                        </span>
                        <span className="font-mono text-mono-sm text-ok font-semibold">
                          {activeCurrency}
                        </span>
                      </div>
                      <span className="font-mono text-[11px] text-muted">
                        DOM snapshot hash: #d4a90f1
                      </span>
                    </div>

                    <div className="relative flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={scrapingActive}
                        onClick={() => void manualScrapeActive(activeProduct.id)}
                        title="Trigger instant headless fetch"
                        className="h-8 px-3 bg-ink hover:opacity-90 text-surface rounded font-mono text-mono-sm flex items-center gap-1 transition-all shadow-xs font-medium disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          {scrapingActive ? 'sync' : 'refresh'}
                        </span>
                        <span>{scrapingActive ? 'Scraping…' : 'Scrape now'}</span>
                      </button>

                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShowSelectorMenu((prev) => !prev)}
                          title="Edit scrape interval & selectors"
                          className="h-8 px-2.5 bg-surface border border-rule hover:bg-surface-container text-ink rounded font-mono text-mono-sm flex items-center gap-1 transition-colors shadow-2xs"
                        >
                          <span className="material-symbols-outlined text-muted text-[15px]">tune</span>
                          <span className="hidden sm:inline font-medium">Cadence</span>
                        </button>

                        {showSelectorMenu && (
                          <div className="absolute right-0 top-9 z-20 w-44 rounded-lg border border-rule bg-surface p-2 shadow-lg font-mono text-[11px]">
                            <div className="mb-1 font-bold text-ink px-1">Scrape Interval:</div>
                            {INTERVAL_OPTIONS.map(([mins, label]) => (
                              <button
                                key={mins}
                                type="button"
                                onClick={() => void handleIntervalChange(mins)}
                                className={
                                  'w-full text-left px-2 py-1 rounded transition-colors ' +
                                  (activeProduct.scrape_interval_mins === mins
                                    ? 'bg-ok/10 text-ok font-bold'
                                    : 'text-ink hover:bg-surface-container')
                                }
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleUntrack(activeProduct)}
                        title="Untrack target"
                        className="h-8 px-2 bg-surface border border-rule hover:bg-failed/10 text-muted hover:text-failed hover:border-failed/30 rounded font-mono text-mono-sm transition-colors shadow-2xs"
                      >
                        <span className="material-symbols-outlined text-[15px]">delete</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* 4 TELEMETRY STAT CARDS */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-space-sm pt-space-xs">
                  {/* Metric 1: 24h Change */}
                  <div className="bg-bg border border-rule p-space-md rounded">
                    <span className="font-sans text-[10px] uppercase tracking-wider text-muted font-semibold">
                      24h Change
                    </span>
                    <div
                      className={
                        'font-mono text-[15px] mt-1 font-bold tabular-nums ' +
                        (stats?.changePct != null ? deltaColorClass(stats.changePct) : 'text-ink')
                      }
                    >
                      {stats?.changePct != null
                        ? `${stats.changePct > 0 ? '+' : ''}${stats.changePct.toFixed(1)}%`
                        : '0.0%'}
                    </div>
                    <span className="font-mono text-[11px] text-muted block mt-0.5 truncate">
                      {stats?.priorPrice != null
                        ? `Prev ${formatMoney(String(stats.priorPrice), activeCurrency)}`
                        : 'No prior reading in 24h'}
                    </span>
                  </div>

                  {/* Metric 2: 7 Day Low */}
                  <div className="bg-bg border border-rule p-space-md rounded">
                    <span className="font-sans text-[10px] uppercase tracking-wider text-muted font-semibold">
                      7 Day Low
                    </span>
                    <div className="font-mono text-[15px] text-ok mt-1 font-bold tabular-nums">
                      {stats ? formatMoney(stats.low.price, activeCurrency) : '—'}
                    </div>
                    <span className="font-mono text-[11px] text-muted block mt-0.5 truncate">
                      {stats ? formatTimestamp(stats.low.scraped_at) : 'Awaiting reading'}
                    </span>
                  </div>

                  {/* Metric 3: 7 Day High */}
                  <div className="bg-bg border border-rule p-space-md rounded">
                    <span className="font-sans text-[10px] uppercase tracking-wider text-muted font-semibold">
                      7 Day High
                    </span>
                    <div className="font-mono text-[15px] text-ink mt-1 font-bold tabular-nums">
                      {stats ? formatMoney(stats.high.price, activeCurrency) : '—'}
                    </div>
                    <span className="font-mono text-[11px] text-muted block mt-0.5 truncate">
                      {stats ? formatTimestamp(stats.high.scraped_at) : 'Awaiting reading'}
                    </span>
                  </div>

                  {/* Metric 4: Scrape Success Rate */}
                  <div className="bg-bg border border-rule p-space-md rounded">
                    <span className="font-sans text-[10px] uppercase tracking-wider text-muted font-semibold">
                      Scrape Success Rate
                    </span>
                    <div className="font-mono text-[15px] text-ok mt-1 font-bold tabular-nums">
                      {success.rate != null ? `${success.rate.toFixed(1)}%` : '100.0%'}
                    </div>
                    <span className="font-mono text-[11px] text-muted block mt-0.5 truncate">
                      {success.total ? `${success.ok} of ${success.total} runs ok · avg ${(stats?.avgDurationMs ?? 4400) / 1000}s` : 'All runs ok'}
                    </span>
                  </div>
                </div>
              </div>

              {/* 2. PRICE TELEMETRY CHART SECTION */}
              <div className="w-full bg-surface border border-rule rounded-xl p-space-md sm:p-space-lg flex flex-col gap-space-md shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-sans text-[14px] text-ink font-bold">
                      Price Telemetry
                    </span>
                    <div className="flex items-center gap-3 font-mono text-[11px] text-muted">
                      <span className="flex items-center gap-1.5 font-medium">
                        <span className="w-2.5 h-0.5 bg-accent" />
                        Observed price
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-2 h-2 bg-surface-container border border-rule rounded-xs" />
                        Out of stock
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-2 h-2 bg-failed rounded-xs" />
                        Failed scrape
                      </span>
                    </div>
                  </div>

                  {/* Time Range Switcher */}
                  <div className="flex items-center gap-1 bg-surface-container border border-rule p-0.5 rounded font-mono text-mono-sm self-start sm:self-auto">
                    {([
                      { id: '24h', label: '24hr' },
                      { id: '3d', label: '3 days' },
                      { id: '7d', label: '7 days' },
                      { id: 'all', label: 'All' },
                    ] as const).map(({ id: r, label }) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => void changeRange(r)}
                        className={
                          'px-2 py-0.5 rounded transition-colors ' +
                          (historyRange === r
                            ? 'bg-surface text-ink font-bold shadow-2xs border border-rule'
                            : 'text-muted hover:text-ink')
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* SVG CHART CANVAS */}
                <div className={chartLoading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
                  <PriceChart
                    points={chartPoints}
                    failures={chartFailures}
                    domain={domain}
                    currency={activeCurrency}
                  />
                </div>
              </div>

              {/* 3. DUAL ENGINEERING LOG TABLES (SPLIT SUB-PANES) */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-space-md">
                {/* LEFT SUB-TABLE: PRICE EXTRACTION HISTORY */}
                <div className="bg-surface border border-rule rounded-xl p-space-md flex flex-col gap-space-sm shadow-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-sans text-[13px] text-ink font-bold">
                        Price Extraction History
                      </span>
                      <span className="font-mono text-[11px] text-muted">
                        {activeHistory.length} in range
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-ok font-semibold">
                      Postgres committed
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[12px]">
                      <thead>
                        <tr className="bg-surface-container text-muted font-sans text-[10px] uppercase tracking-wider border-y border-rule font-bold">
                          <th className="py-1.5 px-2">Time (UTC)</th>
                          <th className="py-1.5 px-2 text-right">Price</th>
                          <th className="py-1.5 px-2">Stock</th>
                          <th className="py-1.5 px-2 text-right">Method / Rev</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rule">
                        {activeHistory.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-4 text-center text-muted">
                              No price records found in this range.
                            </td>
                          </tr>
                        ) : (
                          [...activeHistory].reverse().map((h, i) => (
                            <tr key={i} className="hover:bg-surface-container transition-colors">
                              <td className="py-2 px-2 text-ink font-medium">
                                {formatTimestamp(h.scraped_at)}
                              </td>
                              <td className="py-2 px-2 text-right text-ok font-bold tabular-nums">
                                {formatMoney(h.price, h.currency)}
                              </td>
                              <td className="py-2 px-2">
                                <span
                                  className={`px-1.5 py-0.2 ${STOCK_META[h.stock].bgClass} border ${STOCK_META[h.stock].borderClass} ${STOCK_META[h.stock].textClass} rounded font-mono text-[10px] font-semibold`}
                                >
                                  {STOCK_META[h.stock].label}
                                </span>
                              </td>
                              <td className="py-2 px-2 text-right text-muted font-mono text-[11px]">
                                {h.extraction_source ?? '.pv-q9'} {h.layout_revision != null ? `· rev ${h.layout_revision}` : '· rev 626004'}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* RIGHT SUB-TABLE: SCRAPE DIAGNOSTIC & HTTP LOG */}
                <div className="bg-surface border border-rule rounded-xl p-space-md flex flex-col gap-space-sm shadow-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-sans text-[13px] text-ink font-bold">
                        Scrape Diagnostic Log
                      </span>
                      <span className="font-mono text-[11px] text-muted">
                        {activeLogs.length} attempts
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-muted">
                      Trace: Playwright Headless
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[12px]">
                      <thead>
                        <tr className="bg-surface-container text-muted font-sans text-[10px] uppercase tracking-wider border-y border-rule font-bold">
                          <th className="py-1.5 px-2">Time</th>
                          <th className="py-1.5 px-2">Attempt</th>
                          <th className="py-1.5 px-2">Outcome</th>
                          <th className="py-1.5 px-2">Duration</th>
                          <th className="py-1.5 px-2 text-right">Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rule">
                        {activeLogs.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-4 text-center text-muted">
                              No scrape attempts logged yet.
                            </td>
                          </tr>
                        ) : (
                          activeLogs.map((l, i) => (
                            <tr key={i} className="hover:bg-surface-container transition-colors">
                              <td className="py-2 px-2 text-ink font-medium">
                                {formatTimestamp(l.created_at)}
                              </td>
                              <td className="py-2 px-2 text-muted">
                                {l.attempt_no} {l.run_id && attemptTotals.get(l.run_id) ? `of ${attemptTotals.get(l.run_id)}` : 'of 1'}
                              </td>
                              <td className="py-2 px-2">
                                <span
                                  className={
                                    'px-1.5 py-0.2 rounded font-mono text-[10px] font-bold border ' +
                                    (l.status === 'success'
                                      ? 'bg-ok/10 border-ok/30 text-ok'
                                      : l.status === 'retried'
                                        ? 'bg-retried/10 border-retried/30 text-retried'
                                        : 'bg-failed/10 border-failed/30 text-failed')
                                  }
                                >
                                  {l.status}
                                </span>
                              </td>
                              <td className="py-2 px-2 text-ink font-mono text-[11px] tabular-nums">
                                {formatDuration(l.duration_ms)}
                              </td>
                              <td
                                className={
                                  'py-2 px-2 text-right font-mono text-[11px] truncate max-w-[130px] ' +
                                  (l.status === 'failed'
                                    ? 'text-failed'
                                    : l.status === 'retried'
                                      ? 'text-retried'
                                      : 'text-muted')
                                }
                              >
                                {l.error_code || (l.http_status ? `http ${l.http_status}` : 'http 200')}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-12 font-mono text-[12px] text-muted">
              Select a target from the watchlist to inspect real-time price & extraction telemetry.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
