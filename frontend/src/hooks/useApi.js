import { useState, useEffect, useCallback, useRef } from 'react';

// Module-level inflight dedup — if two components request the same URL
// simultaneously, only one network request is made and both get the result.
const _inflight = new Map();

/**
 * Fetch hook with stale-while-revalidate and inflight deduplication.
 *
 * - While a refetch is in progress, the previous data remains visible (`stale=true`)
 *   so the UI never flashes back to a loading spinner on refresh.
 * - Concurrent callers for the same URL share a single in-flight promise.
 *
 * @param {string|null} url   - The endpoint to fetch. Pass null to disable.
 * @param {Array}       deps  - Re-fetch triggers (shallow-compared like useEffect deps).
 */
export function useApi(url, deps = []) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(!!url);
  const [error,   setError]   = useState(false);
  const [stale,   setStale]   = useState(false); // true while refreshing with existing data
  const hasDataRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!url) { setData(null); setLoading(false); setStale(false); return; }

    // If we already have data, revalidate silently rather than replacing with a spinner.
    if (hasDataRef.current) {
      setStale(true);
    } else {
      setLoading(true);
    }
    setError(false);

    try {
      // Deduplicate: reuse any in-flight request for the same URL.
      let promise = _inflight.get(url);
      if (!promise) {
        promise = fetch(url, { signal: AbortSignal.timeout(120000) })
          .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .finally(() => _inflight.delete(url));
        _inflight.set(url, promise);
      }
      const result = await promise;
      hasDataRef.current = true;
      setData(result);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setStale(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => { fetchData(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, stale, refetch: fetchData };
}
