// Typed fetch wrapper over the backend (VITE_API_URL). Types mirror the route handlers in
// backend/src/routes/*. Note: the postgres client serialises numeric/decimal columns as STRINGS
// (price, stock_qty stays a number), and all timestamps arrive as UTC ISO strings — format them
// with lib/format, never parse-and-store a shifted time.

// VITE_API_URL is the only env var the frontend reads. The localhost fallback is guarded by
// import.meta.env.DEV so Vite dead-code-eliminates it from the production bundle — a prod build with
// no VITE_API_URL yields BASE='' (same-origin, obvious 404s) rather than a shipped localhost URL.
const BASE = (
  import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '')
).replace(/\/$/, '');

// ---- shared vocabulary (mirrors the DB enums / SPEC) ----
export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';
export type ScrapeStatus = 'success' | 'retried' | 'failed';
export type RunTrigger = 'cron' | 'manual' | 'headed';
export type AlertKind = 'price_drop' | 'back_in_stock' | 'layout_change';
export type ScrapeErrorCode =
  | 'timeout' | 'http_5xx' | 'http_429' | 'http_404' | 'network'
  | 'parse_empty' | 'parse_invalid' | 'validation_failed';

// ---- response shapes ----
export interface Health {
  ok: boolean;
  version: string;
  uptime: number;
  db_latency_ms: number | null;
}

export interface StoreSearchItem {
  id: number;
  slug: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  sku: string | null;
}

/** Full products row (POST track, GET /api/products/:id). */
export interface Product {
  id: string;
  source_product_id: string;
  name: string;
  url: string;
  image_url: string | null;
  category: string | null;
  tracking_enabled: boolean;
  scrape_interval_mins: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_layout_revision: number | null;
  layout_alert: boolean;
  created_at: string;
}

/** One 24h price point for the row sparkline (price is a JSON number, not a decimal string). */
export interface SparkPoint {
  t: string;
  price: number;
}

/** Row of GET /api/products — product + latest snapshot + 24h delta (F4, dashboard cards).
 *  Self-contained: currency, record count, last error, and the 24h series all arrive here so the
 *  dashboard needs one request (no per-row follow-ups). */
export interface ProductListItem {
  id: string;
  source_product_id: string;
  name: string;
  url: string;
  category: string | null;
  consecutive_failures: number;
  layout_alert: boolean;
  last_attempt_at: string | null;
  last_success_at: string | null;
  price: string | null;
  currency: string | null;
  stock: StockStatus | null;
  stock_qty: number | null;
  scraped_at: string | null;
  anomalous: boolean | null;
  price_24h_ago: string | null;
  change_24h: number | null;
  change_24h_pct: number | null;
  history_count: number;
  last_error_code: ScrapeErrorCode | null;
  last_error_at: string | null;
  sparkline: SparkPoint[];
}

/** A price_history row (latest snapshot and history points). */
export interface PriceSnapshot {
  price: string;
  currency: string;
  stock: StockStatus;
  stock_qty: number | null;
  raw_price: string;
  anomalous: boolean;
  layout_revision: number | null;
  layout_variant: number | null;
  extraction_source: string | null;
  scraped_at: string;
}

/** A scrape_logs row (F5, per-attempt). skipped_recent is filtered out server-side. */
export interface ScrapeLog {
  attempt_no: number;
  status: ScrapeStatus;
  http_status: number | null;
  error_code: ScrapeErrorCode | null;
  error_message: string | null;
  fetcher: string;
  duration_ms: number;
  layout_revision: number | null;
  layout_variant: number | null;
  created_at: string;
  run_id: string | null;
}

export interface Run {
  id: string;
  trigger: RunTrigger;
  started_at: string;
  finished_at: string | null;
  products_total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  notes: string | null;
  slowest_attempt_ms: number | null;
}

/** An in-app alert (price drop / back in stock / layout change). old/new are stringly-typed. */
export interface Alert {
  id: string;
  product_id: string;
  product_name: string;
  kind: AlertKind;
  old_value: string | null;
  new_value: string | null;
  seen: boolean;
  created_at: string;
}

/** One product's terminal outcome within a run (GET /api/runs/:id). */
export interface RunProduct {
  product_id: string;
  name: string;
  source_product_id: string;
  status: ScrapeStatus;
  error_code: ScrapeErrorCode | null;
  http_status: number | null;
  attempts: number;
  duration_ms: number;
}

/** Result of a manual/single scrape run. */
export interface ScrapeResult {
  run_id: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  slowestAttemptMs: number;
}

export type HistoryRange = '24h' | '7d' | 'all';

/** Thrown on any non-2xx; carries the HTTP status and the server's error text if present. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...init?.headers },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, (body && body.error) || res.statusText);
  }
  return body as T;
}

export const api = {
  health: () => request<Health>('/health'),

  search: (q: string) =>
    request<{ query: string; count: number; items: StoreSearchItem[] }>(
      `/api/store/search?q=${encodeURIComponent(q)}`,
    ),

  listProducts: () => request<{ count: number; items: ProductListItem[] }>('/api/products'),

  trackProduct: (sourceProductId: number) =>
    request<{ product: Product }>('/api/products', {
      method: 'POST',
      body: JSON.stringify({ source_product_id: sourceProductId }),
    }),

  untrackProduct: (id: string) =>
    request<void>(`/api/products/${id}`, { method: 'DELETE' }),

  setInterval: (id: string, minutes: number) =>
    request<{ product: Product }>(`/api/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ scrape_interval_mins: minutes }),
    }),

  getProduct: (id: string) =>
    request<{ product: Product; latest: PriceSnapshot | null }>(`/api/products/${id}`),

  getHistory: (id: string, range: HistoryRange = 'all') =>
    request<{ range: string; count: number; history: PriceSnapshot[] }>(
      `/api/products/${id}/history?range=${range}`,
    ),

  getLogs: (id: string, limit = 50) =>
    request<{ count: number; logs: ScrapeLog[] }>(`/api/products/${id}/logs?limit=${limit}`),

  scrapeProduct: (id: string, force = false) =>
    request<ScrapeResult>(`/api/products/${id}/scrape${force ? '?force=1' : ''}`, {
      method: 'POST',
    }),

  listRuns: () => request<{ count: number; runs: Run[] }>('/api/runs'),

  getRun: (id: string) => request<{ run: Run; products: RunProduct[] }>(`/api/runs/${id}`),

  listAlerts: (unseenOnly = false) =>
    request<{ count: number; unseen_count: number; alerts: Alert[] }>(
      `/api/alerts${unseenOnly ? '?unseen=1' : ''}`,
    ),

  markAlertSeen: (id: string) => request<void>(`/api/alerts/${id}/seen`, { method: 'POST' }),
};
