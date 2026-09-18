// One error type carrying the scrape error-code vocabulary. Thrown by the extract/validate
// steps; the core reads `.code` to label the scrape_logs row and decide whether to retry.
// Codes: timeout | network | http_5xx | http_429 | http_404 | parse_empty | parse_invalid
//        | validation_failed
export class ScrapeError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ScrapeError';
  }
}

export function errorCodeOf(e: unknown, fallback = 'network'): { code: string; message: string } {
  if (e instanceof ScrapeError) return { code: e.code, message: e.message };
  const message = e instanceof Error ? e.message : String(e);
  return { code: fallback, message };
}
