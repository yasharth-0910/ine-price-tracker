import type { Run } from '../lib/api';
import { formatDuration, formatTimestamp } from '../lib/format';

// One block per 2-hour scrape window over the past three days (36 windows), coloured by the run
// that landed in it. Windows with no run are hollow outlines. Everything here is derived from real
// GET /api/runs data — no invented cadence, PIDs, or db stats.

const WINDOW_MS = 2 * 60 * 60 * 1000;
const WINDOW_COUNT = 36; // 72h / 2h

type Outcome = 'ok' | 'partial' | 'failed';

// A run scrapes many products; collapse its per-product counts into one window colour.
function runOutcome(r: Run): Outcome {
  if (r.failed > 0 && r.succeeded === 0) return 'failed';
  if (r.failed > 0) return 'partial';
  return 'ok';
}

// Full literal classes so Tailwind's content scan keeps them.
const FILL: Record<Outcome, string> = {
  ok: 'bg-ok',
  partial: 'bg-retried',
  failed: 'bg-failed',
};

// 2h windows aligned to even UTC hours (floor against the epoch), matching the cron cadence.
function windowStartOf(ms: number): number {
  return Math.floor(ms / WINDOW_MS) * WINDOW_MS;
}

export function RunStrip({
  runs,
  productCount,
  nextRun,
  lastRunMs,
}: {
  runs: Run[];
  productCount: number;
  nextRun: Date | null;
  lastRunMs: number | null;
}) {
  const byWindow = new Map<number, Run>();
  for (const r of runs) {
    const w = windowStartOf(new Date(r.started_at).getTime());
    const existing = byWindow.get(w);
    // Keep the latest run if two fell in the same window.
    if (!existing || new Date(r.started_at) > new Date(existing.started_at)) byWindow.set(w, r);
  }

  const current = windowStartOf(Date.now());
  const windows = Array.from({ length: WINDOW_COUNT }, (_, i) => {
    const start = current - (WINDOW_COUNT - 1 - i) * WINDOW_MS;
    return { start, run: byWindow.get(start) };
  });

  return (
    <section className="border-b border-rule bg-surface px-space-lg py-space-md">
      <div className="mb-space-sm flex items-center justify-between">
        <span className="text-body-md font-medium text-ink">Scrape execution history</span>
        <span className="font-mono text-body-sm tabular-nums text-muted">
          Past 72 hours (2h windows)
        </span>
      </div>

      <div className="grid grid-cols-12 gap-[3px] py-1 sm:grid-cols-18 md:grid-cols-36">
        {windows.map(({ start, run }) => {
          const title = run
            ? `${formatTimestamp(run.started_at)} — ${run.succeeded} ok, ${run.failed} failed`
            : `${formatTimestamp(new Date(start).toISOString())} — no run recorded`;
          return (
            <div
              key={start}
              title={title}
              className={
                'h-5 rounded-sm ' +
                (run ? FILL[runOutcome(run)] : 'border border-rule bg-transparent')
              }
            />
          );
        })}
      </div>

      <div className="mt-space-sm flex flex-col gap-space-xs pt-1 font-mono text-mono-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <span className="tabular-nums">
          {nextRun ? `Next run ${formatTimestamp(nextRun.toISOString())}` : 'Next run pending'}
          {' · '}
          {productCount} {productCount === 1 ? 'product' : 'products'}
          {lastRunMs != null && ` · last run ${formatDuration(lastRunMs)}`}
        </span>
        <div className="flex flex-wrap items-center gap-space-md">
          <Legend className="bg-ok" label="Completed" />
          <Legend className="bg-retried" label="Partial" />
          <Legend className="bg-failed" label="Failed" />
          <Legend className="border border-rule" label="No run" />
        </div>
      </div>
    </section>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={'h-2 w-2 rounded-sm ' + className} />
      {label}
    </span>
  );
}
