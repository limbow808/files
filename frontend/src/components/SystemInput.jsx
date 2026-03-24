import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { API } from '../App';

const STORAGE_KEY = 'crest_active_system';

function sciColor(sci) {
  if (sci == null) return 'var(--dim)';
  if (sci < 0.03)  return '#4caf72';   // green — low
  if (sci < 0.07)  return '#e8943a';   // orange — medium
  return '#e05252';                     // red — high
}

function sciLabel(sci) {
  if (sci == null) return null;
  const pct = (sci * 100).toFixed(3) + '%';
  if (sci < 0.03)  return `LOW · ${pct}`;
  if (sci < 0.07)  return `MED · ${pct}`;
  return `HIGH · ${pct}`;
}

export default function SystemInput({ value, onChange, onSciChange }) {
  const [inputVal,     setInputVal]     = useState(value || localStorage.getItem(STORAGE_KEY) || 'Korsiki');
  const [sciInfo,      setSciInfo]      = useState(null);   // { cost_index } | null
  const [notFound,     setNotFound]     = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [suggestions,  setSuggestions]  = useState([]);
  const [dropOpen,     setDropOpen]     = useState(false);
  const [searchHits,   setSearchHits]   = useState([]);
  const [searchOpen,   setSearchOpen]   = useState(false);

  const debounceRef  = useRef(null);
  const wrapRef      = useRef(null);
  const rowRef       = useRef(null);
  const leaveTimer   = useRef(null);
  const [dropRect,   setDropRect]   = useState(null);

  // Restore persisted system on mount + do initial SCI lookup
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial = saved || inputVal;
    if (saved && saved !== value) {
      onChange(saved);
      setInputVal(saved);
    }
    // Fetch SCI for the initial system
    lookupSci(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch suggestions list once on mount
  useEffect(() => {
    fetch(`${API}/api/sci/suggestions`)
      .then(r => r.json())
      .then(d => Array.isArray(d) ? setSuggestions(d) : null)
      .catch(() => {});
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    function handleClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setDropOpen(false);
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function closeAll() {
    setDropOpen(false);
    setSearchOpen(false);
  }

  // Schedule close — cancelled if cursor re-enters wrap or portal
  function scheduleClose() {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(closeAll, 120);
  }
  function cancelClose() {
    clearTimeout(leaveTimer.current);
  }

  const lookupSci = useCallback((name) => {
    if (!name || name.length < 2) {
      setSciInfo(null); setNotFound(false);
      onSciChange?.({ sci: null, notFound: false, loading: false });
      return;
    }
    setLoading(true);
    setNotFound(false);
    setSciInfo(null);
    onSciChange?.({ sci: null, notFound: false, loading: true });
    fetch(`${API}/api/sci?system_name=${encodeURIComponent(name)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        setSciInfo(d);
        setNotFound(false);
        onChange(name);
        localStorage.setItem(STORAGE_KEY, name);
        onSciChange?.({ sci: d.cost_index, notFound: false, loading: false });
      })
      .catch(status => {
        setSciInfo(null);
        setNotFound(status === 404);
        onSciChange?.({ sci: null, notFound: status === 404, loading: false });
      })
      .finally(() => setLoading(false));
  }, [onChange, onSciChange]);

  // Debounced lookup on keystroke
  function openDrop() {
    if (rowRef.current) setDropRect(rowRef.current.getBoundingClientRect());
    setDropOpen(true);
    setSearchOpen(false);
  }

  function handleInput(v) {
    setInputVal(v);
    setSearchOpen(v.length >= 2);
    setDropOpen(false);

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Run autocomplete search
      if (v.length >= 2) {
        fetch(`${API}/api/systems/search?q=${encodeURIComponent(v)}`)
          .then(r => r.json())
          .then(d => { setSearchHits(Array.isArray(d) ? d : []); setSearchOpen(true); })
          .catch(() => setSearchHits([]));
      } else {
        setSearchHits([]);
        setSearchOpen(false);
      }
      // Also fetch SCI for exact match
      lookupSci(v);
    }, 400);
  }

  function pickSystem(name) {
    setInputVal(name);
    setDropOpen(false);
    setSearchOpen(false);
    setSearchHits([]);
    clearTimeout(debounceRef.current);
    lookupSci(name);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { setDropOpen(false); setSearchOpen(false); }
    if (e.key === 'Enter')  { clearTimeout(debounceRef.current); lookupSci(inputVal); setSearchOpen(false); }
  }

  const activeSci = sciInfo?.cost_index ?? null;
  const showDrop   = dropOpen && suggestions.length > 0;
  const showSearch = searchOpen && searchHits.length > 0 && !dropOpen;

  return (
    <div className="sys-input-wrap" ref={wrapRef} onMouseLeave={scheduleClose} onMouseEnter={cancelClose}>
      <div className="sys-input-row" ref={rowRef}>
        <input
          className={`calc-input sys-input${loading ? ' sys-loading' : ''}`}
          type="text"
          value={inputVal}
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { openDrop(); }}
          onKeyDown={handleKeyDown}
          placeholder="Korsiki"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="sys-chevron"
          onMouseDown={e => { e.preventDefault(); dropOpen ? setDropOpen(false) : openDrop(); }}
          tabIndex={-1}
          title="Show recommended systems"
          style={{ transform: `translateY(-50%) rotate(${dropOpen || showSearch ? '0deg' : '-90deg'})`, transition: 'transform 0.15s' }}
        >▾</button>
      </div>

      {/* Suggestions dropdown (▾ button or empty focus) */}
      {showDrop && dropRect && createPortal(
        <div className="sys-dropdown" onMouseEnter={cancelClose} onMouseLeave={scheduleClose} style={{ position: 'fixed', top: dropRect.bottom + 2, left: dropRect.left, minWidth: dropRect.width, zIndex: 9999 }}>
          {suggestions.map(s => (
            <div
              key={s.system_id}
              className={`sys-drop-row${s.name === value ? ' sys-drop-active' : ''}`}
              onMouseDown={() => pickSystem(s.name)}
            >
              {s.name === value && <span className="sys-dot" />}
              {s.name !== value && <span className="sys-dot-placeholder" />}
              <span className="sys-drop-name">{s.name}</span>
              <span className="sys-drop-region">{s.region}</span>
              <span className="sys-drop-sci" style={{ color: sciColor(s.cost_index) }}>
                {s.cost_index != null ? sciLabel(s.cost_index) : '—'}
              </span>
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* Search autocomplete dropdown */}
      {showSearch && dropRect && createPortal(
        <div className="sys-dropdown" onMouseEnter={cancelClose} onMouseLeave={scheduleClose} style={{ position: 'fixed', top: dropRect.bottom + 2, left: dropRect.left, minWidth: dropRect.width, zIndex: 9999 }}>
          {searchHits.map(s => (
            <div
              key={s.id}
              className={`sys-drop-row${s.name === value ? ' sys-drop-active' : ''}`}
              onMouseDown={() => pickSystem(s.name)}
            >
              {s.name === value && <span className="sys-dot" />}
              {s.name !== value && <span className="sys-dot-placeholder" />}
              <span className="sys-drop-name">{s.name}</span>
              <span className="sys-drop-region" />
              <span className="sys-drop-sci" style={{ color: sciColor(s.sci) }}>
                {s.sci != null ? sciLabel(s.sci) : '—'}
              </span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

