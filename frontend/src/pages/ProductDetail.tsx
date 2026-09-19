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
import { PriceChart, type ChartPoint } from '../components/PriceChart';
import { formatDuration, formatMoney, formatTimestamp } from '../lib/format';

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

  const { product, latest, hist7d, logs, nextRun } = state.data;
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
  }));
  const domain = rangeDomain(range, chartPoints);
  const failures = logs
    .filter((l) => l.status === 'failed')
    .map((l) => new Date(l.created_at).getTime());

  return (
    <div className="flex flex-col">
      {/* Back link */}
      <div className="border-b border-rule bg-surface px-space-lg py-space-sm">
        <Link to="/" className="inline-flex items-center gap-1.5 font-mono text-mono-sm text-ink hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      {/* Header: name, price, stock, currency + actions (interval, untrack) */}
      <div className="border-b border-rule bg-surface px-space-lg py-space-lg">
        <div className="flex flex-col justify-between gap-space-md lg:flex-row lg:items-start">
          <div className="min-w-0">
            <a
              href={product.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-mono-sm text-muted hover:underline"
            >
              {product.url.replace(/^https?:\/\//, '')}
            </a>
            <h1 className="mt-1 text-headline-lg font-semibold tracking-tight text-ink">{product.name}</h1>
            <div className="mt-2 flex flex-wrap items-baseline gap-space-md">
              <span className="font-mono text-[30px] font-medium tabular-nums text-ink">
                {latest ? formatMoney(latest.price, currency) : '—.—'}
              </span>
              <StockPill stock={latest?.stock ?? null} />
              <span className="font-mono text-mono-sm text-muted">Currency: {currency}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-space-md">
            <IntervalSelect product={product} onSaved={applyInterval} />
            <button
              type="button"
              onClick={() => void untrack()}
              className="rounded border border-rule bg-bg px-space-md py-1 font-mono text-mono-sm text-ink transition-colors hover:border-failed hover:text-failed"
            >
              Untrack
            </button>
          </div>
        </div>
      </div>

      {/* Four stat blocks split by vertical hairlines */}
      <div className="grid grid-cols-1 border-b border-rule bg-surface sm:grid-cols-2 lg:grid-cols-4">
        <StatBlock
          label="24h change"
          value={stats?.changePct != null ? `${stats.changePct > 0 ? '+' : ''}${stats.changePct.toFixed(1)}%` : '—'}
          valueClass={
            stats?.change == null ? 'text-ink' : stats.change > 0 ? 'text-failed' : stats.change < 0 ? 'text-ok' : 'text-ink'
          }
          sub={
            stats?.priorPrice != null ? `Prior reading ${formatMoney(String(stats.priorPrice), currency)}` : 'No 24h reading'
          }
        />
        <StatBlock
          label="7 day low"
          value={stats ? formatMoney(stats.low.price, currency) : '—'}
          sub={stats ? formatTimestamp(stats.low.scraped_at) : 'Awaiting first tick'}
        />
        <StatBlock
          label="7 day high"
          value={stats ? formatMoney(stats.high.price, currency) : '—'}
          sub={stats ? formatTimestamp(stats.high.scraped_at) : 'Awaiting first tick'}
        />
        <StatBlock
          label="Scrape success rate"
          value={success.rate != null ? `${success.rate.toFixed(1)}%` : '—'}
          sub={
            success.total
              ? `${success.ok} of ${success.total} runs ok · ${success.retriedOk} retried, ${success.failed} failed`
              : 'No attempts recorded'
          }
          last
        />
      </div>

      {/* Chart */}
      <div className="flex flex-col gap-space-md border-b border-rule bg-surface p-space-lg">
        <div className="flex flex-col gap-space-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-space-md">
            <span className="text-headline-sm font-semibold text-ink">Recorded price curve</span>
            <div className="flex flex-wrap items-center gap-space-md border-l border-rule pl-space-md font-mono text-mono-sm text-muted">
              <Legend swatch={<span className="h-[1.5px] w-3 bg-ink" />} label="Observed price" />
              <Legend swatch={<span className="h-2 w-2.5 bg-rule" />} label="Out of stock" />
              <Legend swatch={<span className="h-1.5 w-1.5 bg-failed" />} label="Failed scrape (gap)" />
            </div>
          </div>
          <div className="inline-flex self-start rounded border border-rule p-0.5 font-mono text-mono-sm sm:self-auto">
            {(['24h', '7d', 'all'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => void changeRange(r)}
                className={
                  'rounded-sm px-2.5 py-0.5 transition-colors ' +
                  (range === r ? 'bg-surface-hover font-medium text-ink' : 'text-muted hover:text-ink')
                }
              >
                {r === 'all' ? 'All' : r}
              </button>
            ))}
          </div>
        </div>
        <div className={chartLoading ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
          <PriceChart points={chartPoints} failures={failures} domain={domain} currency={currency} />
        </div>
      </div>

      {/* Two tables */}
      <div className="grid grid-cols-1 border-b border-rule bg-surface xl:grid-cols-2">
        <div className="flex flex-col border-b border-rule xl:border-b-0 xl:border-r">
          <TableHeader title="Price extraction history" note={`${chartHistory.length} in range`} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-mono-sm">
              <thead>
                <tr className="h-8 border-b border-rule bg-bg text-muted">
                  <Th>Time</Th>
                  <Th right>Price</Th>
                  <Th>Stock</Th>
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {chartHistory.length === 0 ? (
                  <EmptyRow colSpan={4} text="No price points in this range" />
                ) : (
                  [...chartHistory].reverse().map((h, i) => (
                    <tr key={i} className="h-8 hover:bg-surface-hover">
                      <Td className="tabular-nums text-ink">{formatTimestamp(h.scraped_at)}</Td>
                      <Td right className={h.stock === 'out_of_stock' ? 'tabular-nums text-muted' : 'tabular-nums text-ink'}>
                        {formatMoney(h.price, h.currency)}
                      </Td>
                      <Td>
                        <span className={STOCK[h.stock].className}>{STOCK[h.stock].label}</span>
                      </Td>
                      <Td className="text-muted">
                        {h.extraction_source ?? '—'}
                        {h.layout_revision != null && ` · rev ${h.layout_revision}`}
                      </Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-col">
          <TableHeader title="Execution & scrape log" note={`${logs.length} attempts`} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left font-mono text-mono-sm">
              <thead>
                <tr className="h-8 border-b border-rule bg-bg text-muted">
                  <Th>Time</Th>
                  <Th>Attempt</Th>
                  <Th>Outcome</Th>
                  <Th right>Duration</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {logs.length === 0 ? (
                  <EmptyRow colSpan={5} text="No scrape attempts recorded yet" />
                ) : (
                  logs.map((l, i) => (
                    <tr key={i} className="h-8 hover:bg-surface-hover">
                      <Td className="tabular-nums text-ink">{formatTimestamp(l.created_at)}</Td>
                      <Td className="tabular-nums text-muted">
                        {l.attempt_no}
                        {l.run_id && attemptTotals.get(l.run_id) ? ` of ${attemptTotals.get(l.run_id)}` : ''}
                      </Td>
                      <Td>
                        <span className={'inline-flex items-center gap-1.5 font-medium ' + OUTCOME[l.status].text}>
                          <span className={'inline-block h-2 w-2 rounded-sm ' + OUTCOME[l.status].block} />
                          {l.status}
                        </span>
                      </Td>
                      <Td right className="tabular-nums text-ink">
                        {formatDuration(l.duration_ms)}
                      </Td>
                      <Td className={'max-w-[240px] truncate ' + (l.status === 'failed' ? 'text-failed' : 'text-muted')}>
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

      {latest == null && (
        <div className="px-space-lg py-space-md font-mono text-mono-sm text-muted">
          {nextRun ? `No successful scrape yet — first data expected around ${formatTimestamp(nextRun.toISOString())}.` : 'No successful scrape yet — awaiting the first scheduled run.'}
        </div>
      )}
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
