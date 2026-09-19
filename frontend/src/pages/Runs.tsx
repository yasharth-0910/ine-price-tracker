import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Run, type RunProduct, type ScrapeStatus } from '../lib/api';
import { formatDuration, formatTimestamp } from '../lib/format';

// Where a reviewer confirms the scraper keeps working across many unattended runs. Each row shows
// when it ran, how long it took, its trigger, the ok/failed/skipped split, and the slowest attempt
// (the timeout-headroom gauge). Expanding a row shows the per-product outcome for that run.

const OUTCOME: Record<ScrapeStatus, { block: string; text: string }> = {
  success: { block: 'bg-ok', text: 'text-ok' },
  retried: { block: 'bg-retried', text: 'text-retried' },
  failed: { block: 'bg-failed', text: 'text-failed' },
};

function durationOf(run: Run): string {
  if (!run.finished_at) return 'running…';
  return formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime());
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; runs: Run[] };

export function Runs() {
  const [state, setState] = useState<State>({ status: 'loading' });

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

  if (state.status === 'loading')
    return (
      <div className="px-space-lg py-space-xl">
        <div className="animate-pulse font-mono text-mono-sm text-muted">Loading runs…</div>
      </div>
    );

  if (state.status === 'error')
    return (
      <div className="m-space-lg rounded border border-failed bg-surface px-space-lg py-space-md">
        <div className="text-body-md font-medium text-failed">Couldn’t load runs</div>
        <div className="mt-1 font-mono text-mono-sm text-muted">{state.message}</div>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-space-md rounded border border-rule bg-bg px-space-md py-space-xs text-body-sm text-ink transition-colors hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    );

  if (state.runs.length === 0)
    return (
      <div className="px-space-lg py-space-xl text-center">
        <div className="text-body-md text-ink">No runs recorded yet</div>
        <div className="mt-1 font-mono text-mono-sm text-muted">
          Scheduled runs appear here once the scraper has fired.
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded border border-rule bg-surface">
        <div className="flex items-center justify-between border-b border-rule bg-bg px-4 py-2.5 font-sans text-[13px]">
          <span className="font-medium text-ink">Recent scrape runs</span>
          <span className="font-mono text-[11px] text-muted">{state.runs.length} most recent</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left font-mono text-[11px]">
            <thead>
              <tr className="h-7 border-b border-rule bg-bg text-muted">
                <th className="px-3 font-medium">STARTED</th>
                <th className="px-3 text-right font-medium">DURATION</th>
                <th className="px-3 font-medium">TRIGGER</th>
                <th className="px-3 text-right font-medium">OK</th>
                <th className="px-3 text-right font-medium">FAILED</th>
                <th className="px-3 text-right font-medium">SKIPPED</th>
                <th className="px-3 text-right font-medium">SLOWEST ATTEMPT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {state.runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RunProduct[] | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && detail === null) {
      try {
        setDetail((await api.getRun(run.id)).products);
      } catch (e) {
        setDetailErr(e instanceof Error ? e.message : 'Could not load run detail');
      }
    }
  }

  return (
    <>
      <tr className="h-9 cursor-pointer hover:bg-surface-hover" onClick={() => void toggle()}>
        <td className="px-space-md tabular-nums text-ink">
          <span className="mr-1.5 inline-block text-muted">{open ? '▾' : '▸'}</span>
          {formatTimestamp(run.started_at)}
        </td>
        <td className="px-space-md text-right tabular-nums text-ink">{durationOf(run)}</td>
        <td className="px-space-md text-muted">{run.trigger}</td>
        <td className="px-space-md text-right tabular-nums text-ok">{run.succeeded}</td>
        <td className={'px-space-md text-right tabular-nums ' + (run.failed > 0 ? 'text-failed' : 'text-muted')}>
          {run.failed}
        </td>
        <td className="px-space-md text-right tabular-nums text-muted">{run.skipped}</td>
        <td className="px-space-md text-right tabular-nums text-ink">
          {run.slowest_attempt_ms != null ? formatDuration(run.slowest_attempt_ms) : '—'}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="bg-bg px-space-lg py-space-md">
            {detailErr ? (
              <span className="text-failed">{detailErr}</span>
            ) : detail === null ? (
              <span className="animate-pulse text-muted">Loading products…</span>
            ) : detail.length === 0 ? (
              <span className="text-muted">No product attempts recorded in this run.</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.map((p) => (
                  <li key={p.product_id} className="flex flex-wrap items-center gap-space-md">
                    <span className={'inline-flex w-24 shrink-0 items-center gap-1.5 font-medium ' + OUTCOME[p.status].text}>
                      <span className={'inline-block h-2 w-2 rounded-sm ' + OUTCOME[p.status].block} />
                      {p.status}
                    </span>
                    <Link to={`/product/${p.product_id}`} className="text-ink hover:underline">
                      {p.name}
                    </Link>
                    <span className="text-muted">
                      attempt {p.attempts} · {formatDuration(p.duration_ms)}
                      {p.error_code && ` · ${p.error_code}`}
                      {p.http_status != null && ` · http ${p.http_status}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
