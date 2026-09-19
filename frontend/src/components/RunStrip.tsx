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
    if (!existing || new Date(r.started_at) > new Date(existing.started_at)) byWindow.set(w, r);
  }

  const current = windowStartOf(Date.now());
  const windows = Array.from({ length: WINDOW_COUNT }, (_, i) => {
    const start = current - (WINDOW_COUNT - 1 - i) * WINDOW_MS;
    return { start, run: byWindow.get(start) };
  });

  const nextRunLabel = nextRun
    ? `Next run ${formatTimestamp(nextRun.toISOString())}`
    : 'Next run pending';

  return (
    <div className="w-full shrink-0 select-none border-b border-rule bg-surface px-3 py-1.5 font-mono text-[11px]">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 truncate text-muted">
          <span className="font-medium text-ink">System run strip</span>
          <span className="text-rule">·</span>
          <span className="truncate">
            72h horizon (36 windows × 2h) · {nextRunLabel} · {productCount} {productCount === 1 ? 'product' : 'products'}
          </span>
        </div>

        {/* 36 Run Strip Ticks Matrix + Legend */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex items-center gap-0.5">
            {windows.map(({ start, run }) => {
              const title = run
                ? `${formatTimestamp(run.started_at)} — ${run.succeeded} ok, ${run.failed} failed`
                : `${formatTimestamp(new Date(start).toISOString())} — pending window`;
              return (
                <span
                  key={start}
                  title={title}
                  className={
                    'h-3.5 w-1.5 rounded-[1px] transition-opacity hover:opacity-75 ' +
                    (run ? FILL[runOutcome(run)] : 'border border-rule bg-bg')
                  }
                />
              );
            })}
          </div>

          <div className="hidden items-center gap-2 border-l border-rule pl-2 text-[10px] text-muted xl:flex">
            <span className="flex items-center gap-1">
              <span className="h-2 w-1.5 rounded-sm bg-ok" /> ok
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-1.5 rounded-sm bg-retried" /> retry
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-1.5 rounded-sm bg-failed" /> fail
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-1.5 rounded-sm border border-rule bg-bg" /> queue
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
