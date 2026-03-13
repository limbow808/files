import { useState, useEffect, useCallback } from 'react';

/**
 * Minimal fetch hook.
 *
 * @param {string} url   - The endpoint to fetch.
 * @param {Array}  deps  - Re-fetch triggers. Pass `[refreshKey]` to re-fetch when
 *                         refreshKey changes. A new array literal is created each render
 *                         but useEffect compares element values shallowly, so this only
 *                         fires when an element actually changes — not on every render.
 */
export function useApi(url, deps = []) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => { fetchData(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, loading, error, refetch: fetchData };
}
