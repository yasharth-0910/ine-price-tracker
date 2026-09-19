import { useEffect, useState } from 'react';
import { api, type StoreSearchItem } from '../lib/api';

// Search the store to track a product. Results come from OUR local mirror of the store's catalogue
// (store_catalog), because the store exposes no search endpoint — see the api.search call below.
//
// `trackedStoreIds` holds the source_product_ids already tracked, so a matched product that's already
// tracked shows a disabled "Tracking" instead of a Track button. `onTracked` reloads the dashboard.

type State =
  | { status: 'idle' } // empty query — show nothing, never the full 1000
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; items: StoreSearchItem[] };

export function SearchTrack({
  trackedStoreIds,
  onTracked,
}: {
  trackedStoreIds: Set<string>;
  onTracked: () => void;
}) {
  const [input, setInput] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [trackError, setTrackError] = useState<string | null>(null);

  useEffect(() => {
    const q = input.trim();
    if (!q) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    // Debounce: only query 300ms after the last keystroke.
    const t = setTimeout(async () => {
      try {
        // The store has no search API; this hits our cached catalogue mirror. Deliberate — see STORE.md.
        const res = await api.search(q);
        setState({ status: 'done', items: res.items });
      } catch (e) {
        setState({ status: 'error', message: e instanceof Error ? e.message : 'Search failed' });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  async function track(item: StoreSearchItem) {
    setPendingId(item.id);
    setTrackError(null);
    try {
      await api.trackProduct(item.id);
      onTracked();
    } catch (e) {
      setTrackError(e instanceof Error ? e.message : 'Could not track this product');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="border-b border-rule bg-surface px-space-lg py-space-md">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Search the store to track a product"
        aria-label="Search the store to track a product"
        className="h-8 w-full rounded border border-rule bg-bg px-3 font-sans text-body-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none"
      />

      {trackError && <div className="mt-space-sm font-mono text-mono-sm text-failed">{trackError}</div>}

      {state.status === 'loading' && (
        <div className="mt-space-sm animate-pulse font-mono text-mono-sm text-muted">Searching…</div>
      )}
      {state.status === 'error' && (
        <div className="mt-space-sm rounded border border-failed px-space-md py-space-sm font-mono text-mono-sm text-failed">
          Search failed — {state.message}
        </div>
      )}
      {state.status === 'done' && state.items.length === 0 && (
        <div className="mt-space-sm font-mono text-mono-sm text-muted">
          No products matched. Try a shorter query.
        </div>
      )}
      {state.status === 'done' && state.items.length > 0 && (
        <ul className="mt-space-sm divide-y divide-rule rounded border border-rule">
          {state.items.map((item) => {
            // source_product_id is normalised to the bare store id (migration 003), so a direct match.
            const tracked = trackedStoreIds.has(String(item.id));
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-space-md px-space-md py-space-sm"
              >
                <div className="min-w-0">
                  <div className="truncate text-body-sm font-medium text-ink">{item.name}</div>
                  <div className="truncate font-mono text-mono-sm text-muted">
                    {[item.brand, item.category, item.sku && `SKU ${item.sku}`].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={tracked || pendingId === item.id}
                  onClick={() => void track(item)}
                  className={
                    'shrink-0 rounded border px-2.5 py-1 font-sans text-body-sm transition-colors ' +
                    (tracked
                      ? 'cursor-default border-rule text-muted'
                      : 'border-rule text-ink hover:bg-surface-hover')
                  }
                >
                  {tracked ? 'Tracking' : pendingId === item.id ? 'Tracking…' : 'Track'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
