import { useCallback, useEffect, useState } from 'react';
import { api, type ProductListItem, type Run } from '../lib/api';
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
      <RunStrip
        runs={state.runs}
        productCount={state.products.length}
        nextRun={nextRun}
        lastRunMs={lastRunDurationMs(state.runs)}
      />
      <SearchTrack trackedStoreIds={trackedStoreIds} onTracked={() => void load()} />
      {state.products.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="hidden border-b border-rule bg-bg px-space-lg py-2 text-label-caps uppercase text-muted md:grid md:grid-cols-12 md:gap-space-lg">
            <div className="md:col-span-5">Product &amp; URL</div>
            <div className="md:col-span-2 md:text-right">Price</div>
            <div className="md:col-span-1 md:text-right">24h delta</div>
            <div className="md:col-span-2 md:text-center">24h history</div>
            <div className="md:col-span-2 md:text-right">Status</div>
          </div>
          <div className="divide-y divide-rule bg-surface">
            {state.products.map((p) => (
              <ProductRow key={p.id} product={p} nextRun={nextRun} onUntrack={untrack} onRefresh={() => load()} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function LoadingState() {
  return (
    <div className="px-space-lg py-space-xl">
      <div className="animate-pulse font-mono text-mono-sm text-muted">Loading dashboard…</div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="m-space-lg rounded border border-failed bg-surface px-space-lg py-space-md">
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
        Track a product to start collecting price history.
      </div>
    </div>
  );
}
