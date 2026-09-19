import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type HistoryRange,
  type PriceSnapshot,
  type Product,
  type Run,
  type ScrapeLog,
  type ScrapeStatus,
  type StockStatus,
} from '../lib/api';
import { PriceChart, type ChartPoint, type ChartFailure } from '../components/PriceChart';
import { formatDuration, formatMoney, formatTimestamp } from '../lib/format';
import { useManualScrape } from '../hooks/useManualScrape';

const INTERVAL_MS = 120 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const STOCK: Record<StockStatus, { label: string; className: string; block: string }> = {
  in_stock: { label: 'In stock', className: 'text-ok', block: 'bg-ok' },
  low_stock: { label: 'Low stock', className: 'text-retried', block: 'bg-retried' },
  out_of_stock: { label: 'Out of stock', className: 'text-muted', block: 'bg-muted' },
};
const OUTCOME: Record<ScrapeStatus, { block: string; text: string }> = {
  success: { block: 'bg-ok', text: 'text-ok' },
  retried: { block: 'bg-retried', text: 'text-retried' },
  failed: { block: 'bg-failed', text: 'text-failed' },
  skipped_recent: { block: 'bg-muted', text: 'text-muted' },
};

function computeNextRun(runs: Run[]): Date | null {
  if (runs.length === 0) return null;
  let t = new Date(runs[0]!.started_at).getTime() + INTERVAL_MS;
  while (t <= Date.now()) t += INTERVAL_MS;
  return new Date(t);
}

// 7d low/high + 24h change, all from the 7d history (oldest first).
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

// Success rate over runs (grouped from per-attempt logs). A run is failed if it has a terminal
// 'failed' row; otherwise ok, and "retried" if it took more than one attempt to get there.
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

function logDetail(l: ScrapeLog): string {
  const parts: string[] = [];
  if (l.error_code) parts.push(l.error_code);
  if (l.http_status != null) parts.push(`http ${l.http_status}`);
  if (l.error_message) parts.push(l.error_message);
  return parts.length ? parts.join(', ') : `status ${l.http_status ?? '—'}`;
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

interface Ready {
  product: Product;
  latest: PriceSnapshot | null;
  hist7d: PriceSnapshot[];
  logs: ScrapeLog[];
  nextRun: Date | null;
}
type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: Ready };

export function ProductDetail() {
  const { id = '' } = useParams();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [range, setRange] = useState<HistoryRange>('7d');
  const [chartHistory, setChartHistory] = useState<PriceSnapshot[]>([]);
  const [chartLoading, setChartLoading] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [detail, hist, logs, runs] = await Promise.all([
        api.getProduct(id),
        api.getHistory(id, '7d'),
        api.getLogs(id, 200),
        api.listRuns(),
      ]);
      setState({
        status: 'ready',
        data: {
          product: detail.product,
          latest: detail.latest,
          hist7d: hist.history,
          logs: logs.logs,
          nextRun: computeNextRun(runs.runs),
        },
      });
      setRange('7d');
      setChartHistory(hist.history);
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Request failed' });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const navigate = useNavigate();
  const { pending: scraping, error: scrapeError, scrape } = useManualScrape(load);

  const changeRange = async (r: HistoryRange) => {
    if (state.status !== 'ready') return;
    setRange(r);
    if (r === '7d') {
      setChartHistory(state.data.hist7d);
      return;
    }
    setChartLoading(true);
    try {
      setChartHistory((await api.getHistory(id, r)).history);
    } finally {
      setChartLoading(false);
    }
  };

  if (state.status === 'loading') return <Centered>Loading product…</Centered>;
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={() => void load()} />;

  const { product, latest, hist7d, logs } = state.data;
  const stats = computeStats(hist7d);
  const success = computeSuccess(logs);
  const attemptTotals = runAttemptTotals(logs);
  const currency = latest?.currency ?? 'INR';
  const ready = state.data;

  async function untrack() {
    if (!window.confirm(`Untrack "${product.name}"? Scraping stops, but its price history is kept.`)) return;
    try {
      await api.untrackProduct(id);
      navigate('/');
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not untrack this product');
    }
  }

  // Reflect a saved interval locally without a full refetch.
  const applyInterval = (mins: number) =>
    setState({ status: 'ready', data: { ...ready, product: { ...product, scrape_interval_mins: mins } } });

  const chartPoints: ChartPoint[] = chartHistory.map((h) => ({
    t: new Date(h.scraped_at).getTime(),
    price: Number(h.price),
    stock: h.stock,
    source: h.extraction_source,
  }));
  const domain = rangeDomain(range, chartPoints);
  const failures: ChartFailure[] = logs
    .filter((l) => l.status === 'failed')
    .map((l) => ({
      t: new Date(l.created_at).getTime(),
      error_code: l.error_code,
      error_message: l.error_message,
      http_status: l.http_status,
    }));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {/* Header Panel */}
      <div className="flex flex-col justify-between gap-4 rounded border border-rule bg-surface p-4">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 font-mono text-[12px] text-muted transition-colors hover:text-ink"
          >
            ← Back to dashboard
          </Link>
          <div className="font-mono text-[11px] text-muted">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-ok mr-1.5" />
            Target: {product.source_product_id} · {product.last_success_at ? `Last success ${formatTimestamp(product.last_success_at)}` : 'No successful scrape yet'}
          </div>
        </div>

        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-headline-lg font-semibold tracking-tight text-ink">{product.name}</h1>
              <span className="rounded border border-rule bg-bg px-1.5 py-0.5 font-mono text-[11px] text-muted">
                id: {product.source_product_id}
              </span>
            </div>
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate font-mono text-[12px] text-muted transition-colors hover:text-ink hover:underline"
            >
              {product.url.replace(/^https?:\/\//, '')}
            </a>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-[32px] font-medium tabular-nums text-ink">
                {latest ? formatMoney(latest.price, currency) : '—.—'}
              </span>
              <StockPill stock={latest?.stock ?? null} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <IntervalSelect product={product} onSaved={applyInterval} />
              <button
                type="button"
                disabled={scraping}
                onClick={() => void scrape(id)}
                className="h-8 rounded border border-rule bg-surface px-3 font-sans text-[12px] font-medium text-ink transition-colors hover:border-muted hover:bg-surface-hover disabled:opacity-60"
              >
                {scraping ? 'Scraping…' : 'Scrape now'}
              </button>
              <button
                type="button"
                onClick={() => void untrack()}
                className="h-8 rounded border border-rule bg-surface px-3 font-sans text-[12px] font-medium text-ink transition-colors hover:border-failed hover:text-failed"
              >
                Untrack
              </button>
            </div>
          </div>
        </div>

        {scrapeError && (
          <div className="rounded border border-failed px-3 py-1.5 font-mono text-[11px] text-failed">
            Scrape error: {scrapeError}
          </div>
        )}
      </div>

      {/* Four Stat Blocks Panel */}
      <div className="grid grid-cols-1 divide-y divide-rule rounded border border-rule bg-surface sm:grid-cols-2 sm:divide-y-0 sm:divide-x lg:grid-cols-4">
        <StatBlock
          label="24h change"
          value={stats?.changePct != null ? `${stats.changePct > 0 ? '+' : ''}${stats.changePct.toFixed(1)}%` : '—'}
          valueClass={
            stats?.change == null ? 'text-ink' : stats.change < 0 ? 'text-ok' : stats.change > 0 ? 'text-failed' : 'text-ink'
          }
          sub={
            stats?.priorPrice != null ? `Prev reading ${formatMoney(String(stats.priorPrice), currency)}` : 'No prior reading in 24h'
          }
        />
        <StatBlock
          label="7 day low"
          value={stats ? formatMoney(stats.low.price, currency) : '—'}
          sub={stats ? formatTimestamp(stats.low.scraped_at) : 'Awaiting first reading'}
        />
        <StatBlock
          label="7 day high"
          value={stats ? formatMoney(stats.high.price, currency) : '—'}
          sub={stats ? formatTimestamp(stats.high.scraped_at) : 'Awaiting first reading'}
        />
        <StatBlock
          label="Scrape success rate"
          value={success.rate != null ? `${success.rate.toFixed(1)}%` : '—'}
          sub={
            success.total
              ? `${success.ok} of ${success.total} runs ok · ${success.retriedOk} retried, ${success.failed} failed`
              : 'No attempts recorded'
          }
        />
      </div>

      {/* Chart Panel */}
      <div className="flex flex-col gap-3 rounded border border-rule bg-surface p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-sans text-[13px] font-medium text-ink">Price telemetry timeline</span>
            <div className="flex flex-wrap items-center gap-3 border-l border-rule pl-3 font-mono text-[11px] text-muted">
              <Legend swatch={<span className="h-0.5 w-3 bg-ink" />} label="Observed price" />
              <Legend swatch={<span className="h-2 w-2.5 bg-rule" />} label="Out of stock" />
              <Legend swatch={<span className="h-1.5 w-1.5 rounded-full bg-failed" />} label="Failed scrape" />
            </div>
          </div>
          <div className="inline-flex self-start rounded border border-rule p-0.5 font-mono text-[11px] sm:self-auto">
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
                  'rounded-sm px-2.5 py-0.5 transition-colors ' +
                  (range === r ? 'bg-surface-hover font-medium text-ink' : 'text-muted hover:text-ink')
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className={chartLoading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
          <PriceChart points={chartPoints} failures={failures} domain={domain} currency={currency} />
        </div>
      </div>

      {/* Two Side-by-Side Tables */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Left Table: Price History */}
        <div className="flex flex-col overflow-hidden rounded border border-rule bg-surface">
          <TableHeader title="Price extraction history" note={`${chartHistory.length} in range`} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-[11px]">
              <thead>
                <tr className="h-7 border-b border-rule bg-bg text-muted">
                  <Th>TIME (UTC)</Th>
                  <Th right>PRICE</Th>
                  <Th>STOCK</Th>
                  <Th>METHOD</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {chartHistory.length === 0 ? (
                  <EmptyRow colSpan={4} text="No price points in this range" />
                ) : (
                  [...chartHistory].reverse().map((h, i) => (
                    <tr key={i} className="h-7.5 transition-colors hover:bg-surface-hover">
                      <Td className="tabular-nums text-ink">{formatTimestamp(h.scraped_at)}</Td>
                      <Td right className={h.stock === 'out_of_stock' ? 'tabular-nums text-muted' : 'tabular-nums font-medium text-ink'}>
                        {formatMoney(h.price, h.currency)}
                      </Td>
                      <Td>
                        <span className={STOCK[h.stock].className}>{STOCK[h.stock].label}</span>
                      </Td>
                      <Td className="text-muted">
                        {h.extraction_source ?? 'DOM parse'}
                        {h.layout_revision != null && ` · rev ${h.layout_revision}`}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Table: Scrape Diagnostic Log */}
        <div className="flex flex-col overflow-hidden rounded border border-rule bg-surface">
          <TableHeader title="Scrape diagnostic log" note={`${logs.length} attempts`} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-[11px]">
              <thead>
                <tr className="h-7 border-b border-rule bg-bg text-muted">
                  <Th>TIME</Th>
                  <Th>ATTEMPT</Th>
                  <Th>OUTCOME</Th>
                  <Th right>DURATION</Th>
                  <Th>DETAIL</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {logs.length === 0 ? (
                  <EmptyRow colSpan={5} text="No scrape attempts recorded yet" />
                ) : (
                  logs.map((l, i) => (
                    <tr key={i} className="h-7.5 transition-colors hover:bg-surface-hover">
                      <Td className="tabular-nums text-ink">{formatTimestamp(l.created_at)}</Td>
                      <Td className="tabular-nums text-muted">
                        {l.attempt_no}
                        {l.run_id && attemptTotals.get(l.run_id) ? ` of ${attemptTotals.get(l.run_id)}` : ''}
                      </Td>
                      <Td>
                        <span className={'inline-flex items-center gap-1.5 font-medium ' + OUTCOME[l.status].text}>
                          <span className={'inline-block h-2 w-2 rounded-[1px] ' + OUTCOME[l.status].block} />
                          {l.status}
                        </span>
                      </Td>
                      <Td right className="tabular-nums text-ink">
                        {formatDuration(l.duration_ms)}
                      </Td>
                      <Td className={'max-w-[200px] truncate ' + (l.status === 'failed' ? 'text-failed' : 'text-muted')}>
                        {logDetail(l)}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const INTERVAL_OPTIONS: Array<[number, string]> = [
  [30, '30 min'],
  [60, '1 hour'],
  [120, '2 hours'], // assignment default
  [240, '4 hours'],
  [360, '6 hours'],
  [720, '12 hours'],
  [1440, '24 hours'],
];

function IntervalSelect({ product, onSaved }: { product: Product; onSaved: (mins: number) => void }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-space-sm font-mono text-mono-sm text-muted">
      Scrape every
      <select
        value={product.scrape_interval_mins}
        disabled={saving}
        onChange={async (e) => {
          const mins = Number(e.target.value);
          setSaving(true);
          setErr(null);
          try {
            const { product: updated } = await api.setInterval(product.id, mins);
            onSaved(updated.scrape_interval_mins);
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : 'Save failed');
          } finally {
            setSaving(false);
          }
        }}
        className="rounded border border-rule bg-bg px-2 py-1 text-ink focus:border-ink focus:outline-none disabled:opacity-50"
      >
        {INTERVAL_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {err && <span className="text-failed">{err}</span>}
    </label>
  );
}

function StockPill({ stock }: { stock: StockStatus | null }) {
  const s = stock ? STOCK[stock] : { label: 'Pending initial run', className: 'text-muted', block: 'bg-muted' };
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-rule px-2 py-0.5">
      <span className={'inline-block h-2 w-2 rounded-sm ' + s.block} />
      <span className={'font-mono text-mono-sm font-medium ' + s.className}>{s.label}</span>
    </span>
  );
}

function StatBlock({
  label,
  value,
  sub,
  valueClass = 'text-ink',
  last = false,
}: {
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
  last?: boolean;
}) {
  return (
    <div
      className={
        'flex flex-col gap-1 p-space-lg border-b border-rule sm:border-b-0 sm:border-r ' +
        (last ? 'sm:border-r-0' : '')
      }
    >
      <div className="font-mono text-mono-sm text-muted">{label}</div>
      <div className={'mt-1 font-mono text-[20px] font-medium tabular-nums ' + valueClass}>{value}</div>
      <div className="mt-0.5 font-mono text-mono-sm text-muted">{sub}</div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  );
}

function TableHeader({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex items-center gap-space-sm border-b border-rule p-space-md">
      <span className="text-headline-sm font-semibold text-ink">{title}</span>
      <span className="font-mono text-mono-sm text-muted">({note})</span>
    </div>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={'px-space-md font-medium ' + (right ? 'text-right' : '')}>{children}</th>;
}

function Td({ children, right, className = '' }: { children: ReactNode; right?: boolean; className?: string }) {
  return <td className={'px-space-md ' + (right ? 'text-right ' : '') + className}>{children}</td>;
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-space-md py-space-lg text-center text-muted">
        {text}
      </td>
    </tr>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="px-space-lg py-space-xl">
      <div className="animate-pulse font-mono text-mono-sm text-muted">{children}</div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="m-space-lg rounded border border-failed bg-surface px-space-lg py-space-md">
      <div className="text-body-md font-medium text-failed">Couldn’t load this product</div>
      <div className="mt-1 font-mono text-mono-sm text-muted">{message}</div>
      <div className="mt-space-md flex gap-space-sm">
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-rule bg-bg px-space-md py-space-xs text-body-sm text-ink transition-colors hover:bg-surface-hover"
        >
          Retry
        </button>
        <Link
          to="/"
          className="rounded border border-rule bg-bg px-space-md py-space-xs text-body-sm text-ink transition-colors hover:bg-surface-hover"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
