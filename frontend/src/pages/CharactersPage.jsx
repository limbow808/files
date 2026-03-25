import { useState, useEffect, useRef } from 'react';
import { API } from '../App';
import { fmtISK } from '../utils/fmt';
import { charColor, seedCharColors } from '../utils/charColors';
import EveText from '../components/EveText';
import { LoadingState } from '../components/ui';

function PortraitPlaceholder({ name }) {
  const initials = name ? name.slice(0, 2).toUpperCase() : '??';
  return (
    <div style={{
      width: 64, height: 64, background: 'var(--bg)',
      border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--mono)', fontSize: 18, letterSpacing: 2, color: 'var(--dim)',
      flexShrink: 0,
    }}>{initials}</div>
  );
}

const CORP_BP_ACCESS_META = {
  auto: {
    label: 'AUTO',
    hint: 'Use live ESI access when available.',
    accent: 'var(--dim)',
    bg: 'rgba(148,163,184,0.08)',
    symbol: '·',
  },
  allow: {
    label: 'ALLOW',
    hint: 'Whitelist this character for org blueprints.',
    accent: '#7bd389',
    bg: 'rgba(123,211,137,0.12)',
    symbol: '✓',
  },
  block: {
    label: 'BLOCK',
    hint: 'Blacklist this character from org blueprints.',
    accent: 'var(--accent)',
    bg: 'rgba(255,71,0,0.12)',
    symbol: '✕',
  },
};

function CorpBpAccessControl({ value = 'auto', saving = false, onChange }) {
  const current = CORP_BP_ACCESS_META[value] || CORP_BP_ACCESS_META.auto;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 196 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 2 }}>ORG BPS</span>
        <span style={{ color: current.accent, fontSize: 10, letterSpacing: 2 }}>{current.symbol} {current.label}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {Object.entries(CORP_BP_ACCESS_META).map(([mode, meta]) => {
          const active = mode === value;
          return (
            <button
              key={mode}
              className="btn"
              title={meta.hint}
              disabled={saving}
              onClick={() => onChange(mode)}
              style={{
                flex: 1,
                padding: '4px 8px',
                fontSize: 10,
                letterSpacing: 1.5,
                borderColor: active ? meta.accent : 'var(--border)',
                color: active ? meta.accent : 'var(--dim)',
                background: active ? meta.bg : 'transparent',
                opacity: saving && !active ? 0.55 : 1,
              }}
            >
              {meta.symbol} {meta.label}
            </button>
          );
        })}
      </div>
      <div style={{ color: 'var(--dim)', fontSize: 10, lineHeight: 1.35 }}>
        {saving ? 'Saving org BP access…' : current.hint}
      </div>
    </div>
  );
}

function CharacterCard({ char, charStats, onRemove, onCorpBpAccessChange, corpBpAccessSaving, color, index = 0 }) {
  const [confirming, setConfirming] = useState(false);
  const [imgError,   setImgError]   = useState(false);

  return (
    <div
      className="eve-row-reveal eve-corners"
      style={{
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        background: 'var(--subheader-bg)',
        display: 'flex', alignItems: 'stretch', transition: 'border-color 0.15s',
        animationDelay: `${index * 80}ms`,
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = color}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.borderLeftColor = color; }}
    >
      {/* Portrait */}
      <div style={{ flexShrink: 0, borderRight: '1px solid var(--border)' }}>
        {imgError ? (
          <PortraitPlaceholder name={char.character_name} />
        ) : (
          <img
            src={char.portrait_url} alt={char.character_name}
            width={64} height={64}
            style={{ display: 'block', objectFit: 'cover' }}
            onError={() => setImgError(true)}
          />
        )}
      </div>

      {/* Info */}
      <div style={{ flex: 1, padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 14, letterSpacing: 2, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
          {char.character_name}
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <div>
            <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 2 }}>WALLET </span>
            <span style={{ color: charStats?.wallet != null ? 'var(--text)' : 'var(--dim)', fontSize: 11 }}>
              {charStats == null ? '…' : charStats.wallet != null ? fmtISK(charStats.wallet) : '—'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 2 }}>JOBS </span>
            <span style={{ color: charStats?.active_jobs != null ? 'var(--text)' : 'var(--dim)', fontSize: 11 }}>
              {charStats == null ? '…' : charStats.active_jobs != null ? charStats.active_jobs : '—'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 2 }}>ID </span>
            <span style={{ color: 'var(--dim)', fontSize: 10 }}>{char.character_id}</span>
          </div>
        </div>
        </div>
        <CorpBpAccessControl
          value={char.corp_bp_access || 'auto'}
          saving={corpBpAccessSaving}
          onChange={(mode) => onCorpBpAccessChange(char.character_id, mode)}
        />
      </div>

      {/* Remove */}
      <div style={{ borderLeft: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 12px' }}>
        {confirming ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>REMOVE?</span>
            <button className="btn" style={{ fontSize: 10, padding: '3px 10px', borderColor: 'var(--accent)', color: 'var(--accent)' }}
              onClick={() => onRemove(char.character_id)}>YES</button>
            <button className="btn" style={{ fontSize: 10, padding: '3px 10px' }}
              onClick={() => setConfirming(false)}>NO</button>
          </div>
        ) : (
          <button className="btn" style={{ fontSize: 10, padding: '3px 10px', letterSpacing: 2 }}
            onClick={() => setConfirming(true)}>REMOVE</button>
        )}
      </div>
    </div>
  );
}

export default function CharactersPage() {
  const [characters, setCharacters] = useState([]);
  const [stats,      setStats]      = useState({});  // charId → { wallet, active_jobs }
  const [corpBpAccessSaving, setCorpBpAccessSaving] = useState({});
  const [loading,    setLoading]    = useState(true);
  const [adding,     setAdding]     = useState(false);
  const [addStatus,  setAddStatus]  = useState(null); // null | 'waiting' | 'done' | 'error'
  const [addMsg,     setAddMsg]     = useState('');
  const pollRef     = useRef(null);
  const resolvedRef = useRef(false);

  async function fetchStats(charId) {
    try {
      const r = await fetch(`${API}/api/characters/${charId}/stats`);
      const d = await r.json();
      setStats(prev => ({ ...prev, [charId]: d }));
    } catch { /* silent */ }
  }

  async function fetchCharacters() {
    try {
      const r = await fetch(`${API}/api/characters`);
      const d = await r.json();
      const chars = d.characters || [];
      // Seed color assignments in stable arrival order
      seedCharColors(chars);
      setCharacters(chars);
      // Fire off per-character stats fetches in parallel (non-blocking)
      chars.forEach(c => fetchStats(c.character_id));
    } catch {
      setCharacters([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchCharacters(); }, []);

  async function handleAdd() {
    setAdding(true);
    setAddStatus('waiting');
    setAddMsg('Opening EVE SSO in your browser…');
    resolvedRef.current = false;
    try {
      const r = await fetch(`${API}/api/characters/add`, { method: 'POST' });
      const { state, error } = await r.json();
      if (error) { setAddStatus('error'); setAddMsg(error); setAdding(false); return; }
      setAddMsg('Waiting for EVE SSO login…');
      pollRef.current = setInterval(async () => {
        try {
          const pr = await fetch(`${API}/api/characters/poll/${state}`);
          const pd = await pr.json();
          if (resolvedRef.current) return; // stale response — already handled
          if (pd.status === 'done') {
            resolvedRef.current = true;
            clearInterval(pollRef.current);
            setAddStatus('done');
            setAddMsg(`${pd.character.character_name} added successfully`);
            setAdding(false);
            fetchCharacters();
            setTimeout(() => { setAddStatus(null); setAddMsg(''); }, 3000);
          } else if (pd.status === 'error') {
            resolvedRef.current = true;
            clearInterval(pollRef.current);
            setAddStatus('error');
            setAddMsg(pd.message || 'OAuth error');
            setAdding(false);
          }
        } catch { /* keep polling */ }
      }, 1000);
    } catch (e) {
      setAddStatus('error'); setAddMsg(String(e)); setAdding(false);
    }
  }

  async function handleRemove(charId) {
    await fetch(`${API}/api/characters/${charId}`, { method: 'DELETE' });
    setCharacters(prev => prev.filter(c => c.character_id !== charId));
    setStats(prev => { const next = { ...prev }; delete next[charId]; return next; });
  }

  async function handleCorpBpAccessChange(charId, mode) {
    const previous = characters.find(c => c.character_id === charId)?.corp_bp_access || 'auto';
    if (previous === mode) return;
    setCorpBpAccessSaving(prev => ({ ...prev, [charId]: true }));
    setCharacters(prev => prev.map(char => (
      char.character_id === charId ? { ...char, corp_bp_access: mode } : char
    )));
    try {
      const r = await fetch(`${API}/api/characters/${charId}/corp-bp-access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      const updated = d.character || {};
      setCharacters(prev => prev.map(char => (
        char.character_id === charId ? { ...char, corp_bp_access: updated.corp_bp_access || mode } : char
      )));
    } catch {
      setCharacters(prev => prev.map(char => (
        char.character_id === charId ? { ...char, corp_bp_access: previous } : char
      )));
    } finally {
      setCorpBpAccessSaving(prev => ({ ...prev, [charId]: false }));
    }
  }

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const totalWallet = characters.reduce((s, c) => s + (stats[c.character_id]?.wallet || 0), 0);
  const totalJobs   = characters.reduce((s, c) => s + (stats[c.character_id]?.active_jobs || 0), 0);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', height: '100%', overflowY: 'auto' }}>
    <div style={{ padding: '20px 24px', width: '100%', maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 18, letterSpacing: 4, color: 'var(--text)' }}>
            <EveText text="CHARACTERS" scramble={true} steps={10} speed={35} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2, marginTop: 2 }}>
            {characters.length} CHARACTER{characters.length !== 1 ? 'S' : ''} CONNECTED
          </div>
        </div>
        <button className="btn btn-primary" style={{ padding: '5px 18px', fontSize: 11, letterSpacing: 2 }}
          onClick={handleAdd} disabled={adding}>
          {adding ? 'ADDING…' : '+ ADD CHARACTER'}
        </button>
      </div>

      {/* Status message */}
      {addStatus && (
        <div style={{
          padding: '10px 14px',
          border: `1px solid ${addStatus === 'error' ? 'var(--accent)' : addStatus === 'done' ? '#555' : 'var(--border)'}`,
          background: 'var(--bg)', fontSize: 11, letterSpacing: 1,
          color: addStatus === 'error' ? 'var(--accent)' : addStatus === 'done' ? 'var(--text)' : 'var(--dim)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          {addStatus === 'waiting' && <span style={{ animation: 'pulse 1.2s ease-in-out infinite', fontSize: 14 }}>◌</span>}
          {addStatus === 'done'    && <span style={{ color: 'var(--text)' }}>✓</span>}
          {addStatus === 'error'   && <span>✗</span>}
          {addMsg}
        </div>
      )}

      {/* Summary bar — only shown when multiple characters */}
      {characters.length > 1 && (
        <div style={{ display: 'flex', border: '1px solid var(--border)', background: 'var(--subheader-bg)' }}>
          {[
            ['COMBINED WALLET', fmtISK(totalWallet)],
            ['ACTIVE JOBS',     totalJobs],
            ['CHARACTERS',      characters.length],
          ].map(([label, val], i) => (
            <div key={label} style={{
              flex: 1, padding: '10px 16px',
              borderRight: i < 2 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2 }}>{label}</div>
              <div style={{ fontSize: 14, fontFamily: 'var(--mono)', color: 'var(--text)', marginTop: 4, letterSpacing: 1 }}>
                {val}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Character list */}
      {loading ? (
        <LoadingState label="LOADING CHARACTERS" sub="ESI · AUTH" />
      ) : characters.length === 0 ? (
        <div style={{
          border: '1px dashed var(--border)', padding: '40px 20px',
          textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2,
        }}>
          NO CHARACTERS CONNECTED
          <div style={{ fontSize: 10, marginTop: 6 }}>
            Click + ADD CHARACTER to authenticate with EVE SSO
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {characters.map((char, idx) => (
            <CharacterCard
              key={char.character_id}
              char={char}
              charStats={stats[char.character_id] ?? null}
              onRemove={handleRemove}
              onCorpBpAccessChange={handleCorpBpAccessChange}
              corpBpAccessSaving={Boolean(corpBpAccessSaving[char.character_id])}
              color={charColor(char.character_id)}
              index={idx}
            />
          ))}
        </div>
      )}
    </div>
    </div>
  );
}
