import { useCallback, useState } from 'react';
import { api } from '../lib/api';

// Runs POST /api/products/:id/scrape with force=1 (a manual scrape bypasses the idempotency skip).
// The route awaits the entire scrape, so on Render this call can take 15-45s when the instance is
// cold — the caller shows `pending` for the whole time. On failure we surface the real error_code
// from the attempt log rather than a bare "failed".
export function useManualScrape(onSuccess: () => void | Promise<void>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrape = useCallback(
    async (id: string) => {
      setPending(true);
      setError(null);
      try {
        const res = await api.scrapeProduct(id, true);
        if (res.succeeded > 0) {
          await onSuccess();
        } else {
          let code = 'failed';
          try {
            const { logs } = await api.getLogs(id, 1);
            if (logs[0]?.error_code) code = logs[0].error_code;
          } catch {
            /* keep the generic label if the log read fails */
          }
          setError(code);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'scrape request failed');
      } finally {
        setPending(false);
      }
    },
    [onSuccess],
  );

  return { pending, error, scrape };
}
