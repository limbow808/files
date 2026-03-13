import { useState, useRef } from 'react';
import { API } from '../App';

export default function SystemInput({ value, onChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);

  function handleChange(v) {
    onChange(v);
    clearTimeout(timerRef.current);
    if (v.length < 2) { setSuggestions([]); setOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const r    = await fetch(`${API}/api/systems/search?q=${encodeURIComponent(v)}`);
        const data = await r.json();
        setSuggestions(Array.isArray(data) ? data : []);
        setOpen(true);
      } catch { setSuggestions([]); }
    }, 300);
  }

  function pick(item) {
    onChange(item.name);
    setSuggestions([]);
    setOpen(false);
  }

  return (
    <div className="autocomplete-wrap">
      <input
        className="calc-input"
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder="Korsiki"
      />
      {open && suggestions.length > 0 && (
        <div className="autocomplete-dropdown">
          {suggestions.map(s => (
            <div key={s.id} className="autocomplete-item" onMouseDown={() => pick(s)}>
              <span>{s.name}</span>
              <span className="sys-sci">
                {s.sci != null ? `SCI ${(s.sci * 100).toFixed(2)}%` : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
