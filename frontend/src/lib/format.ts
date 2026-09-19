// All API timestamps arrive as UTC ISO strings. We only ever FORMAT them for display in the
// browser's local zone — never convert or store a shifted time. Intl.DateTimeFormat with no
// `timeZone` option uses the runtime's local zone, which is exactly what we want.

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

/** "19 Sep 2026, 14:32" in the viewer's local zone. */
export function formatTimestamp(utcIso: string): string {
  return dateTime.format(new Date(utcIso));
}

/** "14:32:07" in the viewer's local zone — for dense log/table rows. */
export function formatTime(utcIso: string): string {
  return timeOnly.format(new Date(utcIso));
}

/** Short local zone label, e.g. "GMT+5:30" or "PST", for a header caption next to times. */
export function localZoneLabel(): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
    new Date(),
  );
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/** Compact "just now" / "12 min ago" / "2h ago" / "3d ago", for dense telemetry lines. */
export function formatRelative(utcIso: string): string {
  const s = Math.round((Date.now() - new Date(utcIso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Human duration: "412ms" / "1.2s" / "2m 3s". Used for run duration (finished - started). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Currency figure in the viewer's locale, e.g. "₹1,599.00". `price` is the API's decimal string. */
export function formatMoney(price: string, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(price));
}

// self-check (node only): `npx tsx src/lib/format.ts`. Typed inline + optional-chained so this
// block is inert and type-safe in the browser bundle (globalThis.process is undefined there).
const proc = (globalThis as { process?: { argv?: string[] } }).process;
if (proc?.argv?.[1]?.endsWith('format.ts')) {
  const iso = '2026-09-19T09:00:00.000Z';
  console.assert(formatTimestamp(iso).length > 0, 'formatTimestamp empty');
  console.assert(formatTime(iso).length > 0, 'formatTime empty');
  console.assert(localZoneLabel().length > 0, 'zone label empty');
  console.assert(formatRelative(new Date(Date.now() - 3 * 60000).toISOString()) === '3 min ago', 'rel min');
  console.assert(formatRelative(new Date(Date.now() - 5000).toISOString()) === 'just now', 'rel now');
  console.assert(formatDuration(412) === '412ms', 'dur ms');
  console.assert(formatDuration(1500) === '1.5s', 'dur s');
  console.assert(formatMoney('1599.00', 'INR').includes('1,599'), 'money grouping');
  console.log('format.ts ok:', formatTimestamp(iso), '|', formatRelative(iso), '|', formatMoney('198.00', 'INR'));
}
