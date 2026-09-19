import type { StockStatus } from '../lib/api';

// Hand-rolled SVG so the exact behaviour the spec asks for is under our control: a thin line with
// no gradient, a grey band behind out-of-stock stretches, a hard break + red x-axis tick wherever a
// scheduled scrape failed, and NO interpolation across missing data. Colours are CSS var() tokens
// (never hex), so the chart tracks the theme. (PLAN named Recharts; its ReferenceLine spans full
// height and can't do the small axis tick or the un-interpolated gaps without heavy custom layers.)

export interface ChartPoint {
  t: number; // epoch ms
  price: number;
  stock: StockStatus;
}

const W = 960;
const H = 280;
const PAD = { left: 56, right: 16, top: 16, bottom: 30 };
const PLOT = {
  x0: PAD.left,
  x1: W - PAD.right,
  y0: PAD.top,
  y1: H - PAD.bottom,
};
const GAP_MS = 3 * 60 * 60 * 1000; // >1.5× the 2h cadence ⇒ a missing window, don't bridge it

function niceMoney(currency: string) {
  const f = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 });
  return (n: number) => f.format(n);
}
const axisTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });

export function PriceChart({
  points,
  failures,
  domain,
  currency,
}: {
  points: ChartPoint[];
  failures: number[]; // epoch ms of failed scheduled scrapes
  domain: [number, number];
  currency: string;
}) {
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
  const fails = failures.filter((f) => f >= xmin && f <= xmax).sort((a, b) => a - b);

  // Split into continuous segments — break on a failed scrape between two points, or a gap larger
  // than one expected window. A single-point segment renders only as a dot.
  const segments: ChartPoint[][] = [];
  let seg: ChartPoint[] = [];
  for (const p of sorted) {
    const prev = seg[seg.length - 1];
    if (prev && (fails.some((f) => f > prev.t && f < p.t) || p.t - prev.t > GAP_MS)) {
      segments.push(seg);
      seg = [];
    }
    seg.push(p);
  }
  if (seg.length) segments.push(seg);

  // Contiguous out-of-stock runs → grey bands behind the line.
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

  return (
    <div className="overflow-x-auto rounded border border-rule bg-surface p-space-sm">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-72 w-full min-w-[720px] select-none font-mono"
        style={{ shapeRendering: 'geometricPrecision' }}
      >
        {/* Out-of-stock bands (behind everything) */}
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

        {/* Y grid + labels */}
        {gridY.map((v, i) => (
          <g key={`gy-${i}`}>
            <line
              x1={PLOT.x0}
              x2={PLOT.x1}
              y1={sy(v)}
              y2={sy(v)}
              stroke="var(--rule)"
              strokeDasharray="2 3"
            />
            <text x={PLOT.x0 - 8} y={sy(v) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
              {money(v)}
            </text>
          </g>
        ))}

        {/* Failed-scrape markers: faint dashed guide + a small solid tick on the x-axis */}
        {fails.map((f, i) => (
          <g key={`fail-${i}`}>
            <line
              x1={sx(f)}
              x2={sx(f)}
              y1={PLOT.y0}
              y2={PLOT.y1}
              stroke="var(--status-failed)"
              strokeOpacity={0.3}
              strokeDasharray="2 2"
            />
            <line
              x1={sx(f)}
              x2={sx(f)}
              y1={PLOT.y1 - 2}
              y2={PLOT.y1 + 8}
              stroke="var(--status-failed)"
              strokeWidth={2}
            />
          </g>
        ))}

        {/* Price line — one polyline per continuous segment, never bridging a gap */}
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

        {/* X baseline + time labels */}
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
    </div>
  );
}
