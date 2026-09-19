import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Run, type RunProduct } from '../lib/api';
import { formatDuration, formatTimestamp } from '../lib/format';
import { useManualScrape } from '../hooks/useManualScrape';

// Telemetry outcome styling tokens
const STATUS_BADGE: Record<string, { bg: string; border: string; text: string }> = {
  success: { bg: 'bg-ok/10', border: 'border-ok/40', text: 'text-ok' },
  retried: { bg: 'bg-retried/10', border: 'border-retried/40', text: 'text-retried' },
  failed: { bg: 'bg-failed/10', border: 'border-failed/40', text: 'text-failed' },
  skipped_recent: { bg: 'bg-muted/10', border: 'border-muted/30', text: 'text-muted' },
  timed_out: { bg: 'bg-failed/10', border: 'border-failed/40', text: 'text-failed' },
  errored: { bg: 'bg-failed/10', border: 'border-failed/40', text: 'text-failed' },
};

function getStatusBadge(status: string) {
  return STATUS_BADGE[status] ?? { bg: 'bg-muted/10', border: 'border-muted/30', text: 'text-muted' };
}

function durationOf(run: Run): string {
  if (!run.finished_at) return 'running…';
  return formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime());
}

type FilterTab = 'all' | 'failed' | 'retried' | 'cron' | 'manual';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: Run[] };

export function Runs() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [filterTab, setFilterTab] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [openRunIds, setOpenRunIds] = useState<Set<string>>(new Set());
  const [detailsMap, setDetailsMap] = useState<Map<string, RunProduct[]>>(new Map());
  const [activeJsonTrace, setActiveJsonTrace] = useState<{ run: Run; products?: RunProduct[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const { runs } = await api.listRuns();
      setState({ status: 'ready', runs });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Request failed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runs = state.status === 'ready' ? state.runs : [];

  // Filter calculations
  const stats = useMemo(() => {
    let failed = 0;
    let cron = 0;
    let manual = 0;
    for (const r of runs) {
      if (r.failed > 0) failed++;
      if (r.trigger === 'cron') cron++;
      if (r.trigger === 'manual') manual++;
    }
    return { total: runs.length, failed, cron, manual };
  }, [runs]);

  const filteredRuns = useMemo(() => {
    return runs.filter((r) => {
      // Tab filter
      if (filterTab === 'failed' && r.failed === 0) return false;
      if (filterTab === 'cron' && r.trigger !== 'cron') return false;
      if (filterTab === 'manual' && r.trigger !== 'manual') return false;

      // Query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesRun =
          r.id.toLowerCase().includes(q) ||
          r.trigger.toLowerCase().includes(q) ||
          formatTimestamp(r.started_at).toLowerCase().includes(q);

        const details = detailsMap.get(r.id);
        const matchesChild = details?.some(
          (d) =>
            d.name.toLowerCase().includes(q) ||
            d.product_id.toLowerCase().includes(q) ||
            d.status.toLowerCase().includes(q) ||
            (d.error_code && d.error_code.toLowerCase().includes(q)),
        );

        if (!matchesRun && !matchesChild) return false;
      }
      return true;
    });
  }, [runs, filterTab, searchQuery, detailsMap]);

  // Expand / Collapse all
  const toggleAll = async (expand: boolean) => {
    if (!expand) {
      setOpenRunIds(new Set());
      return;
    }
    const allIds = new Set(runs.map((r) => r.id));
    setOpenRunIds(allIds);

    // Fetch missing details
    const missing = runs.filter((r) => !detailsMap.has(r.id));
    if (missing.length > 0) {
      const results = await Promise.allSettled(missing.map((r) => api.getRun(r.id)));
      setDetailsMap((prev) => {
        const next = new Map(prev);
        results.forEach((res, i) => {
          if (res.status === 'fulfilled') {
            next.set(missing[i]!.id, res.value.products);
          }
        });
        return next;
      });
    }
  };

  // CSV Export
  const exportCsv = () => {
    if (runs.length === 0) return;
    const headers = ['Run ID', 'Started At (UTC)', 'Finished At (UTC)', 'Duration', 'Trigger', 'Succeeded', 'Failed', 'Skipped', 'Slowest Attempt (ms)'];
    const rows = runs.map((r) => [
      r.id,
      r.started_at,
      r.finished_at ?? '',
      durationOf(r),
      r.trigger,
      r.succeeded,
      r.failed,
      r.skipped,
      r.slowest_attempt_ms ?? '',
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `trackscrape_runs_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleRun = async (runId: string) => {
    const next = new Set(openRunIds);
    if (next.has(runId)) {
      next.delete(runId);
    } else {
      next.add(runId);
      if (!detailsMap.has(runId)) {
        try {
          const detail = await api.getRun(runId);
          setDetailsMap((prev) => new Map(prev).set(runId, detail.products));
        } catch {
          // ignore
        }
      }
    }
    setOpenRunIds(next);
  };

  const copyJson = (data: unknown) => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (state.status === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex items-center gap-2 font-mono text-mono-sm text-muted">
          <span className="inline-block h-2 w-2 animate-ping rounded-full bg-ok" />
          <span>Polling scrape telemetry logs…</span>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-4xl rounded border border-failed bg-surface p-6">
        <div className="font-medium text-failed">Failed to load scrape logs</div>
        <div className="mt-1 font-mono text-mono-sm text-muted">{state.message}</div>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-4 rounded border border-rule bg-bg px-3 py-1.5 font-sans text-[12px] text-ink transition-colors hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 font-sans text-ink">
      {/* 1. Diagnostics, Filter & Action Toolbar */}
      <div className="flex flex-col justify-between gap-3 rounded border border-rule bg-surface p-2.5 md:flex-row md:items-center">
        {/* Filter Tabs with Micro Badges */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-[12px]">
          <button
            onClick={() => setFilterTab('all')}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors ${
              filterTab === 'all'
                ? 'border border-rule bg-bg font-medium text-ok'
                : 'text-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <span>All runs</span>
            <span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[10px] text-muted">
              {stats.total}
            </span>
          </button>
          <button
            onClick={() => setFilterTab('failed')}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors ${
              filterTab === 'failed'
                ? 'border border-failed/50 bg-failed/10 font-semibold text-failed'
                : 'text-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <span>Failed</span>
            <span
              className={`rounded px-1.5 py-0.2 font-mono text-[10px] ${
                stats.failed > 0 ? 'bg-failed text-bg font-bold' : 'bg-surface text-muted'
              }`}
            >
              {stats.failed}
            </span>
          </button>
          <button
            onClick={() => setFilterTab('cron')}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors ${
              filterTab === 'cron'
                ? 'border border-rule bg-bg font-medium text-ok'
                : 'text-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <span>Cron only</span>
            <span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[10px] text-muted">
              {stats.cron}
            </span>
          </button>
          <button
            onClick={() => setFilterTab('manual')}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors ${
              filterTab === 'manual'
                ? 'border border-rule bg-bg font-medium text-ok'
                : 'text-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <span>Manual / Headed</span>
            <span className="rounded bg-surface px-1.5 py-0.2 font-mono text-[10px] text-muted">
              {stats.manual}
            </span>
          </button>
        </div>

        {/* Right Controls: Filter Input + Batch Controls + CSV */}
        <div className="flex items-center gap-2">
          {/* Search Input */}
          <div className="relative flex items-center">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by product, ID, or error…"
              className="h-7 w-56 rounded border border-rule bg-bg px-2.5 font-mono text-[11px] text-ink placeholder:text-muted focus:border-ok focus:outline-none sm:w-64"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 font-mono text-[10px] text-muted hover:text-ink"
              >
                ✕
              </button>
            )}
          </div>

          <div className="h-4 w-px bg-rule" />

          {/* Action Buttons */}
          <button
            onClick={() => void toggleAll(true)}
            className="flex h-7 items-center gap-1 rounded border border-rule bg-surface px-2 text-[11px] font-medium text-ink transition-colors hover:bg-surface-hover"
            title="Expand all run rows"
          >
            <span>Expand all</span>
          </button>
          <button
            onClick={() => void toggleAll(false)}
            className="flex h-7 items-center gap-1 rounded border border-rule bg-surface px-2 text-[11px] font-medium text-ink transition-colors hover:bg-surface-hover"
            title="Collapse all run rows"
          >
            <span>Collapse</span>
          </button>
          <button
            onClick={exportCsv}
            className="flex h-7 items-center gap-1.5 rounded border border-rule bg-surface px-2.5 text-[11px] font-medium text-ink transition-colors hover:bg-surface-hover"
            title="Export CSV of runs"
          >
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* 2. Primary Telemetry Run Log Tree Table */}
      <div className="overflow-hidden rounded border border-rule bg-surface">
        <div className="overflow-x-auto">
          <div className="min-w-[960px] w-full">
            {/* Table Header */}
            <div className="grid grid-cols-12 border-b border-rule bg-bg px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted select-none">
              <div className="col-span-3 flex items-center gap-2">
                <span>STARTED (UTC)</span>
              </div>
              <div className="col-span-1 text-right">
                <span>DURATION</span>
              </div>
              <div className="col-span-2 pl-4">
                <span>TRIGGER</span>
              </div>
              <div className="col-span-1 text-right">
                <span>OK</span>
              </div>
              <div className="col-span-1 text-right">
                <span>FAILED</span>
              </div>
              <div className="col-span-1 text-right">
                <span>SKIPPED</span>
              </div>
              <div className="col-span-2 text-right pr-2">
                <span>SLOWEST ATTEMPT</span>
              </div>
              <div className="col-span-1 text-right">
                <span>ACTIONS</span>
              </div>
            </div>

            {/* Table Body */}
            {filteredRuns.length === 0 ? (
              <div className="p-8 text-center font-mono text-[12px] text-muted">
                No runs matching current filters.
              </div>
            ) : (
              <div className="divide-y divide-rule">
                {filteredRuns.map((run, idx) => {
                  const isOpen = openRunIds.has(run.id);
                  const details = detailsMap.get(run.id);
                  const isFailed = run.failed > 0;
                  const isLatest = idx === 0;

                  return (
                    <div key={run.id} className="flex flex-col">
                      {/* Parent Run Row */}
                      <div
                        onClick={() => void toggleRun(run.id)}
                        className={`grid grid-cols-12 items-center px-4 py-2.5 font-mono text-[11px] cursor-pointer transition-colors ${
                          isFailed
                            ? 'border-l-[3px] border-l-failed bg-failed/5 hover:bg-failed/10'
                            : 'border-l-[3px] border-l-transparent hover:bg-surface-hover'
                        }`}
                      >
                        {/* Started */}
                        <div className="col-span-3 flex items-center gap-2 min-w-0">
                          <span
                            className={`transform text-muted transition-transform inline-block ${
                              isOpen ? 'rotate-90' : ''
                            }`}
                          >
                            ▸
                          </span>
                          <span className="font-medium text-ink tabular-nums">
                            {formatTimestamp(run.started_at)}
                          </span>
                          {isLatest && (
                            <span className="rounded border border-ok/40 bg-ok/10 px-1 py-0.2 text-[9px] uppercase font-semibold text-ok">
                              LATEST
                            </span>
                          )}
                          {isFailed && (
                            <span className="rounded border border-failed/40 bg-failed/10 px-1 py-0.2 text-[9px] uppercase font-semibold text-failed">
                              {run.failed} ERR
                            </span>
                          )}
                        </div>

                        {/* Duration */}
                        <div className="col-span-1 text-right text-muted tabular-nums">
                          {durationOf(run)}
                        </div>

                        {/* Trigger */}
                        <div className="col-span-2 pl-4 flex items-center gap-1.5">
                          <span className="rounded border border-rule bg-bg px-1.5 py-0.5 text-[10px] text-ink">
                            {run.trigger === 'cron' ? 'cron 2h' : run.trigger}
                          </span>
                          <span className="text-[10px] text-muted truncate">
                            #{run.id.slice(0, 8)}
                          </span>
                        </div>

                        {/* OK */}
                        <div className="col-span-1 text-right font-medium text-ok tabular-nums">
                          {run.succeeded}
                        </div>

                        {/* Failed */}
                        <div
                          className={`col-span-1 text-right tabular-nums ${
                            isFailed ? 'font-bold text-failed' : 'text-muted'
                          }`}
                        >
                          {run.failed}
                        </div>

                        {/* Skipped */}
                        <div className="col-span-1 text-right text-muted tabular-nums">
                          {run.skipped}
                        </div>

                        {/* Slowest Attempt */}
                        <div className="col-span-2 text-right pr-2 text-ink tabular-nums truncate">
                          {run.slowest_attempt_ms != null
                            ? formatDuration(run.slowest_attempt_ms)
                            : '—'}
                        </div>

                        {/* Actions */}
                        <div
                          className="col-span-1 text-right flex items-center justify-end gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveJsonTrace({ run, products: details })}
                            className="rounded border border-rule bg-surface p-1 text-muted transition-colors hover:bg-surface-hover hover:text-ink"
                            title="View Raw JSON Trace"
                          >
                            <span className="font-mono text-[10px]">{'{ }'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Expandable Child Grid */}
                      {isOpen && (
                        <div className="border-t border-rule bg-bg/80 px-4 py-2.5 font-mono text-[11px]">
                          <div className="mb-2 flex items-center justify-between border-b border-rule pb-1 text-[10px] text-muted">
                            <div className="flex items-center gap-2">
                              <span className="uppercase tracking-wider font-semibold text-ink">
                                Target Execution Tree:
                              </span>
                              <span>
                                {details ? `${details.length} targets evaluated` : 'Loading trace…'}
                              </span>
                            </div>
                            <span className="text-muted">Run ID: {run.id}</span>
                          </div>

                          {!details ? (
                            <div className="py-2 text-muted animate-pulse">Loading products…</div>
                          ) : details.length === 0 ? (
                            <div className="py-2 text-muted">No product attempts recorded in this run.</div>
                          ) : (
                            <div className="flex flex-col divide-y divide-rule/60">
                              {details.map((p) => {
                                const badge = getStatusBadge(p.status);
                                return (
                                  <ChildProductRow key={p.product_id} p={p} badge={badge} onScraped={load} />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Raw JSON Trace Modal */}
      {activeJsonTrace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded border border-rule bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-rule bg-bg px-4 py-2.5 font-sans">
              <span className="font-medium text-[13px] text-ink">
                Scrape Run Diagnostic Trace — #{activeJsonTrace.run.id.slice(0, 8)}
              </span>
              <button
                onClick={() => setActiveJsonTrace(null)}
                className="font-mono text-[14px] text-muted hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-bg font-mono text-[11px] text-ink">
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(activeJsonTrace, null, 2)}
              </pre>
            </div>
            <div className="flex items-center justify-between border-t border-rule bg-surface px-4 py-2.5">
              <span className="font-mono text-[11px] text-muted">
                {activeJsonTrace.products?.length ?? 0} per-target execution logs
              </span>
              <button
                onClick={() => copyJson(activeJsonTrace)}
                className="rounded border border-rule bg-bg px-3 py-1 font-mono text-[11px] text-ink transition-colors hover:bg-surface-hover"
              >
                {copied ? 'Copied ✓' : 'Copy JSON'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChildProductRow({
  p,
  badge,
  onScraped,
}: {
  p: RunProduct;
  badge: { bg: string; border: string; text: string };
  onScraped: () => void;
}) {
  const { pending: scraping, scrape } = useManualScrape(onScraped);

  return (
    <div className="grid grid-cols-12 items-center py-2 text-[11px]">
      {/* Status */}
      <div className="col-span-2 flex items-center gap-1.5">
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase ${badge.bg} ${badge.border} ${badge.text}`}
        >
          {p.status}
        </span>
      </div>

      {/* Target Product */}
      <div className="col-span-4 flex items-center gap-2 min-w-0 pr-2">
        <Link
          to={`/product/${p.product_id}`}
          className="truncate font-medium text-ink hover:underline hover:text-ok"
        >
          {p.name}
        </Link>
        <span className="shrink-0 rounded border border-rule bg-bg px-1 py-0.2 text-[9px] text-muted">
          id: {p.product_id}
        </span>
      </div>

      {/* Attempt & Duration */}
      <div className="col-span-2 text-muted tabular-nums">
        attempt {p.attempts} · {formatDuration(p.duration_ms)}
      </div>

      {/* Trace detail */}
      <div className="col-span-3 text-muted truncate">
        {p.status === 'success' ? (
          <span className="text-ok">http 200 · verified price</span>
        ) : p.status === 'skipped_recent' ? (
          <span className="text-muted">bypassed · cooldown active</span>
        ) : (
          <span className="text-failed">
            {[p.error_code, p.http_status ? `http ${p.http_status}` : null].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {/* Action */}
      <div className="col-span-1 text-right flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={scraping}
          onClick={() => void scrape(p.product_id)}
          className="rounded border border-rule bg-surface px-2 py-0.5 text-[10px] text-ink transition-colors hover:border-ok hover:text-ok disabled:opacity-50"
        >
          {scraping ? '…' : 'Scrape'}
        </button>
      </div>
    </div>
  );
}
