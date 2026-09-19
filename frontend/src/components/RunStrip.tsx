import type { Run } from '../lib/api';
import { formatTimestamp } from '../lib/format';

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
  lastRunMs: _lastRunMs,
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

  let okCount = 0;
  let partialCount = 0;
  let failedCount = 0;
  let emptyCount = 0;

  for (const { run } of windows) {
    if (!run) {
      emptyCount++;
    } else {
      const outcome = runOutcome(run);
      if (outcome === 'ok') okCount++;
      else if (outcome === 'partial') partialCount++;
      else if (outcome === 'failed') failedCount++;
    }
  }

  const nextRunLabel = nextRun
    ? `Next run ${formatTimestamp(nextRun.toISOString())}`
    : 'Next run pending';

  return (
    <section className="flex flex-col space-y-2.5 rounded border border-rule bg-surface p-3">
      <div className="flex items-center justify-between text-[13px]">
        <span className="font-medium text-ink">Scrape history (last 72 hours)</span>
        <span className="font-mono text-muted">2-hour execution windows</span>
      </div>

      <div className="grid w-full grid-cols-12 gap-1 pt-1 sm:grid-cols-18 md:grid-cols-36">
        {windows.map(({ start, run }) => {
          const title = run
            ? `${formatTimestamp(run.started_at)} — ${run.succeeded} ok, ${run.failed} failed`
            : `${formatTimestamp(new Date(start).toISOString())} — pending / no run`;
          return (
            <div
              key={start}
              title={title}
              className={
                'h-6 rounded-[2px] transition-opacity hover:opacity-80 ' +
                (run ? FILL[runOutcome(run)] : 'border border-rule bg-transparent')
              }
            />
          );
        })}
      </div>

      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-mono text-[13px] tabular-nums text-muted">
          {nextRunLabel}, {productCount} {productCount === 1 ? 'product' : 'products'}
        </span>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[1px] bg-ok" />
            <span>{okCount} successful</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[1px] bg-retried" />
            <span>{partialCount} retried</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[1px] bg-failed" />
            <span>{failedCount} error</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[1px] border border-rule" />
            <span>{emptyCount} queued</span>
          </div>
        </div>
      </div>
    </section>
  );
}
