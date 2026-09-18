// The one interface the retry/extract/validate/persist code sits on top of. It does not know
// whether it got HTTP or a browser — see ARCHITECTURE. For the price path `status` is the HTTP
// status of the underlying /api/products/{id}/price call, not the top-level page load.
export interface FetchResult {
  status: number;
  body: string;
  elapsedMs: number;
  finalUrl: string;
}

export interface Fetcher {
  name: 'http' | 'browser';
  get(url: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<FetchResult>;
  dispose(): Promise<void>;
}
