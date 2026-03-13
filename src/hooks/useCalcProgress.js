import { useState, useEffect, useRef } from 'react';
import { API } from '../App';

/**
 * Subscribes to the SSE progress stream for /api/calculator.
 * Returns { stage, msg, done, total } updated in real time.
 * Automatically closes when stage === 'done' or when deps change.
 */
export function useCalcProgress(system, facility, enabled) {
  const [progress, setProgress] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      setProgress(null);
      return;
    }

    // Close any existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const params = new URLSearchParams({ system, facility });
    const url = `${API}/api/calculator/progress?${params}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setProgress(data);
        if (data.stage === 'done') {
          es.close();
          esRef.current = null;
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [system, facility, enabled]);

  return progress;
}
