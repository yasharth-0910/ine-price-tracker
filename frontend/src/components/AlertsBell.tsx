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

  async function markAllSeen() {
    try {
      await api.markAllAlertsSeen();
      setAlerts((a) => a.map((x) => ({ ...x, seen: true })));
      setUnseen(0);
    } catch {
      /* ignore failed batch */
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
        className="flex h-7 items-center gap-1.5 rounded border border-rule bg-surface px-2 font-mono text-[11px] text-ink transition-colors hover:bg-surface-hover"
      >
        <span className="text-retried">🔔</span>
        <span>Alerts</span>
        {unseen > 0 && (
          <span className="rounded bg-retried/20 px-1 text-[10px] font-bold text-retried">{unseen}</span>
        )}
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <button
            type="button"
            aria-label="Close alerts"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute right-0 z-50 mt-1 max-h-96 w-84 max-w-[calc(100vw-2rem)] overflow-y-auto rounded border border-rule bg-surface shadow-xl">
            <div className="flex items-center justify-between border-b border-rule px-3 py-2 font-mono text-[11px]">
              <span className="text-muted">
                {unseen} unseen · {alerts.length} recent
              </span>
              {unseen > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllSeen()}
                  className="font-mono text-[11px] text-ok transition-colors hover:underline"
                >
                  Mark all as read
                </button>
              )}
            </div>
            {alerts.length === 0 ? (
              <div className="px-3 py-4 text-center font-mono text-[11px] text-muted">No alerts recorded yet.</div>
            ) : (
              alerts.map((a) => {
                const d = describe(a);
                return (
                  <div
                    key={a.id}
                    className={'border-b border-rule px-3 py-2 last:border-b-0 ' + (a.seen ? 'opacity-60' : 'bg-bg/40')}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/product/${a.product_id}`}
                          onClick={() => setOpen(false)}
                          className="block truncate font-sans text-[12px] font-medium text-ink hover:underline"
                        >
                          {a.product_name}
                        </Link>
                        <div className="font-mono text-[11px]">
                          <span className={d.labelClass}>{d.label}</span>
                          <span className="text-muted">
                            : {d.from} → {d.to}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-muted">{formatRelative(a.created_at)}</div>
                      </div>
                      {!a.seen && (
                        <button
                          type="button"
                          onClick={() => void markSeen(a.id)}
                          className="shrink-0 font-mono text-[10px] text-muted transition-colors hover:text-ink"
                        >
                          Mark read
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
