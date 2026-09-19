import { useCallback, useEffect, useState } from 'react';
import { api, type ProductListItem, type Run } from '../lib/api';
import { formatDuration } from '../lib/format';
import { ProductRow } from '../components/ProductRow';
import { RunStrip } from '../components/RunStrip';
import { SearchTrack } from '../components/SearchTrack';

const INTERVAL_MS = 120 * 60 * 1000; // 2h schedule

// Next run = the last real run's start rolled forward by the interval until it's in the future.
// Derived from actual runs, not an assumed wall-clock cadence.
function computeNextRun(runs: Run[]): Date | null {
  if (runs.length === 0) return null;
  let t = new Date(runs[0]!.started_at).getTime() + INTERVAL_MS;
  while (t <= Date.now()) t += INTERVAL_MS;
  return new Date(t);
}

function lastRunDurationMs(runs: Run[]): number | null {
  const done = runs.find((r) => r.finished_at);
  return done ? new Date(done.finished_at!).getTime() - new Date(done.started_at).getTime() : null;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; products: ProductListItem[]; runs: Run[] };

export function Dashboard() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      // One request each — every field the rows need already rides on GET /api/products.
      const [p, r] = await Promise.all([api.listProducts(), api.listRuns()]);
      setState({ status: 'ready', products: p.items, runs: r.runs });
    } catch (e) {
      setState({ status: 'error', message: e instanceof Error ? e.message : 'Request failed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') return <LoadingState />;
  if (state.status === 'error') return <ErrorState message={state.message} onRetry={() => void load()} />;

  const nextRun = computeNextRun(state.runs);
  const trackedStoreIds = new Set(state.products.map((p) => p.source_product_id));
  const lastMs = lastRunDurationMs(state.runs);

  async function untrack(p: ProductListItem) {
    if (!window.confirm(`Untrack "${p.name}"? Scraping stops, but its price history is kept.`)) return;
    try {
      await api.untrackProduct(p.id);
      void load();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not untrack this product');
    }
  }

  return (
    <>
      {/* Top Telemetry & Control Bar */}
      <div className="flex flex-col justify-between gap-3 rounded border border-rule bg-surface p-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-3 font-mono text-[13px] text-ink sm:gap-4">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-ok" />
            <span>Single cron process active</span>
          </div>
          <div className="h-3 w-px bg-rule" />
          <div className="text-muted">Interval: 2h</div>
          {lastMs != null && (
            <>
              <div className="h-3 w-px bg-rule" />
              <div className="text-muted">Last duration: {formatDuration(lastMs)}</div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="h-7 rounded border border-rule bg-surface px-3 font-sans text-[13px] font-medium text-ink transition-colors hover:border-muted hover:bg-surface-hover"
          >
            Refresh data
          </button>
        </div>
      </div>

      {/* 1. Run Strip */}
      <RunStrip
        runs={state.runs}
        productCount={state.products.length}
        nextRun={nextRun}
        lastRunMs={lastMs}
      />

      {/* 2. Search & Track Input Form */}
      <SearchTrack trackedStoreIds={trackedStoreIds} onTracked={() => void load()} />

      {/* 3. List of Tracked Products */}
      <div className="overflow-hidden rounded border border-rule bg-surface">
        {state.products.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className="hidden grid-cols-12 gap-4 border-b border-rule bg-bg px-4 py-2 font-sans text-[11px] font-medium text-muted lg:grid">
              <div className="col-span-4">Product target &amp; url</div>
              <div className="col-span-2 text-right">Detected price</div>
              <div className="col-span-1 text-right">24h change</div>
              <div className="col-span-2 text-center">Trend (24h)</div>
              <div className="col-span-1 text-center">Availability</div>
              <div className="col-span-2 text-right">Telemetry log</div>
            </div>
            <div className="divide-y divide-rule">
              {state.products.map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  nextRun={nextRun}
                  onUntrack={untrack}
                  onRefresh={() => load()}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* 4. Diagnostic Status Bar */}
      <div className="flex flex-col items-start justify-between gap-2 rounded border border-rule bg-surface p-3 font-mono text-[11px] text-muted sm:flex-row sm:items-center">
        <div>TrackScrape cron monitor · Single scheduler active (2h cadence)</div>
        <div className="flex items-center gap-4">
          <span>{state.products.length} {state.products.length === 1 ? 'target' : 'targets'} tracked</span>
          <span className="text-ok">Telemetry syncd</span>
        </div>
      </div>
    </>
  );
}

function LoadingState() {
  return (
    <div className="rounded border border-rule bg-surface px-space-lg py-space-xl">
      <div className="animate-pulse font-mono text-mono-sm text-muted">Loading dashboard…</div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded border border-failed bg-surface px-space-lg py-space-md">
      <div className="text-body-md font-medium text-failed">Couldn’t load the dashboard</div>
      <div className="mt-1 font-mono text-mono-sm text-muted">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-space-md rounded border border-rule bg-bg px-space-md py-space-xs text-body-sm text-ink transition-colors hover:bg-surface-hover"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-space-lg py-space-xl text-center">
      <div className="text-body-md text-ink">No products tracked yet</div>
      <div className="mt-1 font-mono text-mono-sm text-muted">
        Search above to track a product and start collecting price history.
      </div>
    </div>
  );
}
