import { useState } from 'react';
import type { StockStatus } from '../lib/api';
import { formatMoney, formatTimestamp } from '../lib/format';

// Hand-rolled SVG so the exact behaviour the spec asks for is under our control: a thin line with
// no gradient, a grey band behind out-of-stock stretches, a hard break + red x-axis tick wherever a
// scheduled scrape failed, and NO interpolation across missing data. Colours are CSS var() tokens
// (never hex), so the chart tracks the theme.
//
// Interaction: the crosshair follows the cursor; the tooltip/dot only appear when the cursor is
// actually near a marker (within SNAP_PX), so hovering empty space doesn't jump to a far point.
// Click a point to anchor it, then hover another point to read the change between them (absolute,
// percent, and time span), coloured green for a drop and red for a rise. Click the anchor again, or
// click empty space, to clear it. Keyboard nav is skipped; the price-history table carries the same
// data accessibly.

export interface ChartPoint {
  t: number; // epoch ms
  price: number;
  stock: StockStatus;
  source: string | null;
}

export interface ChartFailure {
  t: number;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
}

const W = 960;
const H = 280;
const PAD = { left: 56, right: 16, top: 16, bottom: 30 };
const PLOT = { x0: PAD.left, x1: W - PAD.right, y0: PAD.top, y1: H - PAD.bottom };
const GAP_MS = 3 * 60 * 60 * 1000; // >1.5× the 2h cadence ⇒ a missing window, don't bridge it
const SNAP_PX = 16; // viewBox units, horizontal distance only: select a marker when the cursor is over it

const STOCK_LABEL: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
};
const STOCK_CLASS: Record<StockStatus, string> = {
  in_stock: 'text-ok',
  low_stock: 'text-retried',
  out_of_stock: 'text-muted',
};

function niceMoney(currency: string) {
  const f = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 });
  return (n: number) => f.format(n);
}
const axisTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });

// Coarse span for the compare readout (minutes / hours / days).
function span(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

type Hover = { kind: 'point'; p: ChartPoint } | { kind: 'fail'; f: ChartFailure };

export function PriceChart({
  points,
  failures,
  domain,
  currency,
}: {
  points: ChartPoint[];
  failures: ChartFailure[];
  domain: [number, number];
  currency: string;
}) {
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [anchor, setAnchor] = useState<ChartPoint | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded border border-rule bg-surface">
        <span className="font-mono text-mono-sm text-muted">No price data in this range</span>
      </div>
    );
  }

  const [xmin, xmax] = domain;
  const prices = points.map((p) => p.price);
  let pmin = Math.min(...prices);
  let pmax = Math.max(...prices);
  if (pmin === pmax) {
    pmin -= 1;
    pmax += 1;
  }
  const padY = (pmax - pmin) * 0.08;
  pmin -= padY;
  pmax += padY;

  const xspan = xmax - xmin || 1;
  const sx = (t: number) => PLOT.x0 + ((t - xmin) / xspan) * (PLOT.x1 - PLOT.x0);
  const sy = (p: number) => PLOT.y1 - ((p - pmin) / (pmax - pmin)) * (PLOT.y1 - PLOT.y0);

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const fails = failures.filter((f) => f.t >= xmin && f.t <= xmax).sort((a, b) => a.t - b.t);

  const segments: ChartPoint[][] = [];
  let seg: ChartPoint[] = [];
  for (const p of sorted) {
    const prev = seg[seg.length - 1];
    if (prev && (fails.some((f) => f.t > prev.t && f.t < p.t) || p.t - prev.t > GAP_MS)) {
      segments.push(seg);
      seg = [];
    }
    seg.push(p);
  }
  if (seg.length) segments.push(seg);

  const bands: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; ) {
    if (sorted[i]!.stock === 'out_of_stock') {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1]!.stock === 'out_of_stock') j++;
      bands.push([sorted[i]!.t, sorted[j]!.t]);
      i = j + 1;
    } else i++;
  }

  const money = niceMoney(currency);
  const yTicks = 4;
  const gridY = Array.from({ length: yTicks + 1 }, (_, i) => pmin + ((pmax - pmin) * i) / yTicks);
  const xTicks = 5;
  const gridX = Array.from({ length: xTicks }, (_, i) => xmin + (xspan * i) / (xTicks - 1));

  // Nearest marker (point or failure) to a viewBox x, within SNAP_PX. Null when the cursor is in
  // empty space, so we don't jump the readout to a distant point.
  function nearest(vbX: number): Hover | null {
    let best: Hover | null = null;
    let bestDx = SNAP_PX;
    for (const p of sorted) {
      const dx = Math.abs(sx(p.t) - vbX);
      if (dx < bestDx) {
        bestDx = dx;
        best = { kind: 'point', p };
      }
    }
    for (const f of fails) {
      const dx = Math.abs(sx(f.t) - vbX);
      if (dx < bestDx) {
        bestDx = dx;
        best = { kind: 'fail', f };
      }
    }
    return best;
  }

  function toVbX(e: React.MouseEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const vbX = toVbX(e);
    setCursorX(vbX);
    setHover(nearest(vbX));
  }

  function onClick(e: React.MouseEvent<SVGSVGElement>) {
    const hit = nearest(toVbX(e));
    if (!hit || hit.kind !== 'point') {
      setAnchor(null); // click empty space (or a failure tick) clears the comparison
      return;
    }
    setAnchor((cur) => (cur && cur.t === hit.p.t ? null : hit.p)); // toggle / move
  }

  const delta =
    hover?.kind === 'point' && anchor && anchor.t !== hover.p.t
      ? {
          abs: hover.p.price - anchor.price,
          pct: anchor.price ? ((hover.p.price - anchor.price) / anchor.price) * 100 : 0,
          spanMs: Math.abs(hover.p.t - anchor.t),
        }
      : null;
  const deltaClass = delta ? (delta.abs < 0 ? 'text-ok' : delta.abs > 0 ? 'text-failed' : 'text-muted') : '';

  const tipT = hover ? (hover.kind === 'point' ? hover.p.t : hover.f.t) : null;
  const leftPct = tipT != null ? (sx(tipT) / W) * 100 : 0;

  return (
    <div className="overflow-x-auto rounded border border-rule bg-surface p-space-sm">
      <div className="relative min-w-[720px]">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-72 w-full cursor-crosshair select-none font-mono"
          style={{ shapeRendering: 'geometricPrecision' }}
          onMouseMove={onMove}
          onMouseLeave={() => {
            setCursorX(null);
            setHover(null);
          }}
          onClick={onClick}
        >
          {bands.map(([a, b], i) => (
            <rect
              key={`band-${i}`}
              x={sx(a)}
              y={PLOT.y0}
              width={Math.max(sx(b) - sx(a), 4)}
              height={PLOT.y1 - PLOT.y0}
              fill="var(--rule)"
              fillOpacity={0.55}
            />
          ))}

          {gridY.map((v, i) => (
            <g key={`gy-${i}`}>
              <line x1={PLOT.x0} x2={PLOT.x1} y1={sy(v)} y2={sy(v)} stroke="var(--rule)" strokeDasharray="2 3" />
              <text x={PLOT.x0 - 8} y={sy(v) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
                {money(v)}
              </text>
            </g>
          ))}

          {fails.map((f, i) => (
            <g key={`fail-${i}`}>
              <line x1={sx(f.t)} x2={sx(f.t)} y1={PLOT.y0} y2={PLOT.y1} stroke="var(--status-failed)" strokeOpacity={0.3} strokeDasharray="2 2" />
              <line x1={sx(f.t)} x2={sx(f.t)} y1={PLOT.y1 - 2} y2={PLOT.y1 + 8} stroke="var(--status-failed)" strokeWidth={2} />
            </g>
          ))}

          {segments.map((s, i) =>
            s.length >= 2 ? (
              <polyline
                key={`seg-${i}`}
                fill="none"
                stroke="var(--ink)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                points={s.map((p) => `${sx(p.t)},${sy(p.price)}`).join(' ')}
              />
            ) : null,
          )}
          {sorted.map((p, i) => (
            <circle key={`pt-${i}`} cx={sx(p.t)} cy={sy(p.price)} r={2} fill="var(--ink)" />
          ))}

          {/* Anchor marker: solid guide + ringed dot */}
          {anchor && (
            <g>
              <line x1={sx(anchor.t)} x2={sx(anchor.t)} y1={PLOT.y0} y2={PLOT.y1} stroke="var(--muted)" strokeOpacity={0.6} />
              <circle cx={sx(anchor.t)} cy={sy(anchor.price)} r={4} fill="var(--ink)" stroke="var(--surface)" strokeWidth={1.5} />
            </g>
          )}

          {/* Hover crosshair follows the cursor; dot only when snapped to a point */}
          {cursorX != null && cursorX >= PLOT.x0 && cursorX <= PLOT.x1 && (
            <line x1={cursorX} x2={cursorX} y1={PLOT.y0} y2={PLOT.y1} stroke="var(--muted)" strokeDasharray="2 2" />
          )}
          {hover?.kind === 'point' && (
            <circle cx={sx(hover.p.t)} cy={sy(hover.p.price)} r={3.5} fill="var(--surface)" stroke="var(--ink)" strokeWidth={1.5} />
          )}

          <line x1={PLOT.x0} x2={PLOT.x1} y1={PLOT.y1} y2={PLOT.y1} stroke="var(--rule)" />
          {gridX.map((t, i) => (
            <text
              key={`gx-${i}`}
              x={sx(t)}
              y={PLOT.y1 + 20}
              textAnchor={i === 0 ? 'start' : i === xTicks - 1 ? 'end' : 'middle'}
              fontSize="10"
              fill="var(--muted)"
            >
              {axisTime.format(new Date(t))}
            </text>
          ))}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="pointer-events-none absolute top-2 z-10 whitespace-nowrap rounded border border-rule bg-surface px-space-sm py-1 font-mono text-mono-sm"
            style={{ left: `${leftPct}%`, transform: leftPct > 60 ? 'translateX(-100%)' : 'none' }}
          >
            {hover.kind === 'point' ? (
              <>
                <div className="text-muted">{formatTimestamp(new Date(hover.p.t).toISOString())}</div>
                <div className="font-medium text-ink">{formatMoney(String(hover.p.price), currency)}</div>
                <div className={STOCK_CLASS[hover.p.stock]}>{STOCK_LABEL[hover.p.stock]}</div>
                <div className="text-muted">{hover.p.source ?? '—'}</div>
                {delta && (
                  <div className={'mt-1 border-t border-rule pt-1 ' + deltaClass}>
                    {delta.abs > 0 ? '+' : ''}
                    {formatMoney(String(delta.abs.toFixed(2)), currency)} ({delta.pct > 0 ? '+' : ''}
                    {delta.pct.toFixed(1)}%) over {span(delta.spanMs)}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="font-medium text-failed">Failed scrape</div>
                <div className="text-muted">{formatTimestamp(new Date(hover.f.t).toISOString())}</div>
                <div className="text-failed">
                  {[hover.f.error_code, hover.f.http_status != null ? `http ${hover.f.http_status}` : null, hover.f.error_message]
                    .filter(Boolean)
                    .join(' · ') || 'failed'}
                </div>
              </>
            )}
          </div>
        )}

        {/* Compare hint / anchor state */}
        <div className="pointer-events-none absolute bottom-1 left-2 font-mono text-mono-sm text-muted">
          {anchor
            ? `Anchor ${money(anchor.price)} · hover another point to compare · click it again to clear`
            : 'Click a point to compare'}
        </div>
      </div>
    </div>
  );
}
