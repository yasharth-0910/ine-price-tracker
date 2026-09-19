import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Alert } from '../lib/api';
import { formatMoney, formatRelative } from '../lib/format';

// Header indicator + panel for in-app alerts. Plain: a button with an unseen count, a dropdown list,
// and a per-alert "Mark seen". No toasts, no animation. Polls every 60s so the count stays honest
// after a scheduled scrape without the user reloading.

const STOCK_LABEL: Record<string, string> = {
  in_stock: 'in stock',
  low_stock: 'low stock',
  out_of_stock: 'out of stock',
};

const money = (v: string | null) => (v ? formatMoney(v, 'INR') : '—');

function describe(a: Alert): { label: string; labelClass: string; from: string; to: string } {
  switch (a.kind) {
    case 'price_drop':
      return { label: 'Price dropped', labelClass: 'text-ok', from: money(a.old_value), to: money(a.new_value) };
    case 'back_in_stock':
      return {
        label: 'Back in stock',
        labelClass: 'text-ok',
        from: STOCK_LABEL[a.old_value ?? ''] ?? a.old_value ?? '—',
        to: STOCK_LABEL[a.new_value ?? ''] ?? a.new_value ?? '—',
      };
    case 'layout_change':
      return { label: 'Store layout changed', labelClass: 'text-retried', from: `rev ${a.old_value ?? '—'}`, to: `rev ${a.new_value ?? '—'}` };
  }
}

export function AlertsBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listAlerts();
      setAlerts(r.alerts);
      setUnseen(r.unseen_count);
    } catch {
      /* keep prior state on a transient failure */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function markSeen(id: string) {
    try {
      await api.markAlertSeen(id);
      setAlerts((a) => a.map((x) => (x.id === id ? { ...x, seen: true } : x)));
      setUnseen((c) => Math.max(0, c - 1));
    } catch {
      /* leave it unseen if the request failed */
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
        className="rounded border border-rule bg-bg px-space-md py-1 font-mono text-mono-sm text-ink transition-colors hover:bg-surface-hover"
      >
        Alerts
        {unseen > 0 && (
          <span className="ml-1.5 rounded-sm border border-failed px-1.5 font-medium text-failed">{unseen}</span>
        )}
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <button
            type="button"
            aria-label="Close alerts"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute right-0 z-20 mt-2 max-h-96 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded border border-rule bg-surface">
            <div className="border-b border-rule px-space-md py-space-sm font-mono text-mono-sm text-muted">
              {unseen} unseen · {alerts.length} recent
            </div>
            {alerts.length === 0 ? (
              <div className="px-space-md py-space-md font-mono text-mono-sm text-muted">No alerts yet.</div>
            ) : (
              alerts.map((a) => {
                const d = describe(a);
                return (
                  <div
                    key={a.id}
                    className={'border-b border-rule px-space-md py-space-sm last:border-b-0 ' + (a.seen ? 'opacity-60' : '')}
                  >
                    <div className="flex items-start justify-between gap-space-sm">
                      <div className="min-w-0">
                        <Link
                          to={`/product/${a.product_id}`}
                          onClick={() => setOpen(false)}
                          className="block truncate text-body-sm font-medium text-ink hover:underline"
                        >
                          {a.product_name}
                        </Link>
                        <div className="font-mono text-mono-sm">
                          <span className={d.labelClass}>{d.label}</span>
                          <span className="text-muted">
                            : {d.from} → {d.to}
                          </span>
                        </div>
                        <div className="font-mono text-mono-sm text-muted">{formatRelative(a.created_at)}</div>
                      </div>
                      {!a.seen && (
                        <button
                          type="button"
                          onClick={() => void markSeen(a.id)}
                          className="shrink-0 font-mono text-mono-sm text-muted transition-colors hover:text-ink"
                        >
                          Mark seen
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
