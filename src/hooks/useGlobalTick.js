import { useEffect, useRef } from 'react';

/**
 * useGlobalTick — calls `callback` once per second using a single shared
 * setInterval for ALL mounted users, instead of one interval per component.
 *
 * Usage:
 *   useGlobalTick(() => { ... update DOM via refs ... });
 */

let _timer = null;
const _listeners = new Set();

function _ensureStarted() {
  if (!_timer) {
    _timer = setInterval(() => _listeners.forEach(fn => fn()), 1000);
  }
}

function _maybeStop() {
  if (_timer && _listeners.size === 0) {
    clearInterval(_timer);
    _timer = null;
  }
}

export function useGlobalTick(callback) {
  // Keep a ref so the closure always calls the latest version of callback
  // without needing to re-register the listener on every render.
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const fn = () => cbRef.current();
    _listeners.add(fn);
    _ensureStarted();
    fn(); // run immediately on mount
    return () => {
      _listeners.delete(fn);
      _maybeStop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
