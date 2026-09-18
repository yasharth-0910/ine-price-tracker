// HTTP client for the store's plain-JSON endpoints (catalogue + metadata + layout).
// No Playwright here: the price path is a browser path and lives elsewhere. See STORE.md.
import { request } from 'undici';
import { env } from '../lib/env.js';

const TIMEOUT_MS = 10_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; ine-price-tracker/1.0; +https://github.com/)';

export interface StoreProduct {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
  specs?: unknown;
  reviews?: unknown;
}

export interface CatalogPage {
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  items: Omit<StoreProduct, 'specs' | 'reviews'>[];
}

export interface Layout {
  revision: number;
  variant: number;
  validUntil: number;
  classes: Record<string, string>;
  order: string[];
  priceTag: string;
  priceCarrier: 'text' | 'split';
}

export interface StoreResponse<T> {
  status: number;
  body: T | null;
}

async function getJson<T>(path: string): Promise<StoreResponse<T>> {
  const res = await request(env.STORE_BASE_URL + path, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  });
  let body: T | null = null;
  try {
    body = (await res.body.json()) as T;
  } catch {
    await res.body.dump(); // non-JSON: drain so the socket can be reused
  }
  return { status: res.statusCode, body };
}

// Metadata for one product. 404 => { status: 404, body: { error: 'not_found' } }. Do not retry.
export const fetchProduct = (id: number) => getJson<StoreProduct>(`/api/product/${id}`);

// One catalogue page. Order is randomised and pageSize caps at 60 server-side (see STORE.md).
export const fetchCatalogPage = (page: number, pageSize: number) =>
  getJson<CatalogPage>(`/api/catalog?page=${page}&pageSize=${pageSize}`);

// The rotating selector map. Cache until body.validUntil in the price path.
export const fetchLayout = () => getJson<Layout>('/api/layout');
