import { useState, useMemo, memo, Fragment } from 'react';
import { useApi } from '../hooks/useApi';
import { API } from '../App';
import EveText from '../components/EveText';

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtRuns(runs) {
  return runs === -1 ? '∞' : String(runs);
}

function meColor(me) {
  if (me >= 10) return '#4cff91';
  if (me >= 5)  return '#ccaa00';
  return 'var(--dim)';
}

function teColor(te) {
  if (te >= 20) return '#4cff91';
  if (te >= 10) return '#ccaa00';
  return 'var(--dim)';
}

// ── KPI Bar ────────────────────────────────────────────────────────────────

function BpLibKPIBar({ bps, statsData }) {
  const totalInGame = statsData?.total_bpos_in_game ?? 0;
  const ownedBpos   = bps.filter(b => b.bp_type === 'BPO').length;
  const ownedBpcs   = bps.filter(b => b.bp_type === 'BPC').length;
  const pct         = totalInGame > 0 ? ((ownedBpos / totalInGame) * 100).toFixed(2) : '0.00';

  const stats = [
    {
      label: 'BPOs OWNED',
      value: totalInGame > 0 ? `${ownedBpos.toLocaleString()} / ${totalInGame.toLocaleString()}` : ownedBpos.toLocaleString(),
      color: 'var(--text)',
    },
    {
      label: '% COLLECTED',
      value: `${pct}%`,
      color: parseFloat(pct) >= 50 ? '#4cff91' : parseFloat(pct) >= 20 ? '#ccaa00' : 'var(--text)',
    },
    {
      label: 'BPCs OWNED',
      value: ownedBpcs.toLocaleString(),
      color: 'var(--text)',
    },
    {
      label: 'TOTAL BPs',
      value: bps.length.toLocaleString(),
      color: 'var(--accent)',
    },
  ];

  return (
    <div className="bpl-kpi-bar">
      {stats.map((s, i) => (
        <Fragment key={s.label}>
          <div className="bpl-kpi-stat">
            <span className="bpl-kpi-value" style={{ color: s.color }}>{s.value}</span>
            <span className="bpl-kpi-label">{s.label}</span>
          </div>
          {i < stats.length - 1 && (
            <div style={{ width: 5, height: 5, background: 'var(--border)', flexShrink: 0, alignSelf: 'center' }} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

function BpCard({ bp, expanded, onToggle }) {
  return (
    <div
      className={`bpl-card${expanded ? ' bpl-card--open' : ''}`}
      onClick={onToggle}
      title={bp.name}
    >
      <div className="bpl-card-top">
        <img
          className="bpl-card-icon"
          src={`https://images.evetech.net/types/${bp.type_id}/icon?size=32`}
          alt=""
          onError={e => { e.target.style.display = 'none'; }}
        />
        <div className="bpl-card-info">
          <div className="bpl-card-name">
            {bp.name.replace(/ Blueprint$/, '')}
          </div>
          <div className="bpl-card-chips">
            <span className={`bpl-chip bpl-chip--${bp.bp_type.toLowerCase()}`}>{bp.bp_type}</span>
            <span className="bpl-chip" style={{ color: meColor(bp.me_level) }}>ME{bp.me_level}</span>
            <span className="bpl-chip" style={{ color: teColor(bp.te_level) }}>TE{bp.te_level}</span>
            <span className="bpl-chip" style={{ color: 'var(--dim)' }}>{fmtRuns(bp.runs)}</span>
          </div>
        </div>
      </div>
      <div className="bpl-card-footer">
        <span className="bpl-card-owner">{bp.character_name}</span>
        <span className="bpl-card-tag">{bp.owner === 'corp' ? 'CORP' : 'PERSONAL'}</span>
      </div>
      {expanded && (
        <div className="bpl-card-detail">
          <div className="bpl-detail-row">
            <span>Quantity</span><span>{bp.quantity}</span>
          </div>
          {bp.runs !== -1 && (
            <div className="bpl-detail-row">
              <span>Runs left</span><span>{bp.runs}</span>
            </div>
          )}
          <div className="bpl-detail-row">
            <span>Location ID</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>
              {bp.location_id ?? '—'}
            </span>
          </div>
          <div className="bpl-detail-row">
            <span>Type ID</span><span>{bp.type_id}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── List row ───────────────────────────────────────────────────────────────

function BpListRow({ bp }) {
  return (
    <tr className="row-profitable">
      <td style={{ paddingLeft: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <img
            src={`https://images.evetech.net/types/${bp.type_id}/icon?size=32`}
            alt=""
            style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.85 }}
            onError={e => { e.target.style.display = 'none'; }}
          />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
            {bp.name.replace(/ Blueprint$/, '')}
          </span>
        </div>
      </td>
      <td>
        <span className={`bpl-chip bpl-chip--${bp.bp_type.toLowerCase()}`}>{bp.bp_type}</span>
      </td>
      <td style={{ color: meColor(bp.me_level) }}>{bp.me_level}</td>
      <td style={{ color: teColor(bp.te_level) }}>{bp.te_level}</td>
      <td style={{ color: 'var(--dim)' }}>{fmtRuns(bp.runs)}</td>
      <td>{bp.quantity}</td>
      <td style={{ color: 'var(--dim)', fontSize: 10 }}>{bp.character_name}</td>
      <td style={{ color: 'var(--dim)', fontSize: 10 }}>{bp.owner === 'corp' ? 'CORP' : 'PERS'}</td>
    </tr>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

const SORT_OPTIONS = [
  { value: 'name',     label: 'Name'     },
  { value: 'me_level', label: 'ME'       },
  { value: 'te_level', label: 'TE'       },
  { value: 'bp_type',  label: 'Type'     },
  { value: 'runs',     label: 'Runs'     },
  { value: 'owner',    label: 'Owner'    },
];

function BpLibraryPage({ refreshKey = 0 }) {
  const { data: esiBpData, loading } = useApi(`${API}/api/blueprints/esi`, [refreshKey]);
  const { data: statsData }          = useApi(`${API}/api/blueprints/stats`, [refreshKey]);

  const [view,       setView]       = useState('card');   // 'card' | 'list'
  const [search,     setSearch]     = useState('');
  const [showBPO,    setShowBPO]    = useState(true);
  const [showBPC,    setShowBPC]    = useState(true);
  const [showCorp,   setShowCorp]   = useState(true);
  const [showPersonal, setShowPersonal] = useState(true);
  const [sortKey,    setSortKey]    = useState('name');
  const [sortDir,    setSortDir]    = useState(1);        // 1=asc, -1=desc
  const [expandedId, setExpandedId] = useState(null);    // type_id+owner+char combo

  const bps = esiBpData?.blueprints || [];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return bps.filter(bp => {
      if (q && !bp.name.toLowerCase().includes(q)) return false;
      if (!showBPO && bp.bp_type === 'BPO') return false;
      if (!showBPC && bp.bp_type === 'BPC') return false;
      if (!showCorp && bp.owner === 'corp') return false;
      if (!showPersonal && bp.owner === 'personal') return false;
      return true;
    });
  }, [bps, search, showBPO, showBPC, showCorp, showPersonal]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av = a[sortKey] ?? '';
      let bv = b[sortKey] ?? '';
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * (av - bv);
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d * -1);
    else { setSortKey(key); setSortDir(1); }
  }

  function cardKey(bp) {
    return `${bp.type_id}_${bp.owner}_${bp.character_id}`;
  }

  return (
    <div className="calc-page">
      {/* KPI bar */}
      <BpLibKPIBar bps={bps} statsData={statsData} />

      {/* Toolbar */}
      <div className="bpl-toolbar">
        <div className="bpl-toolbar-left">
          <div className="filter-group" style={{ borderRight: 'none' }}>
            <span className="filter-label">SEARCH</span>
            <input
              className="calc-input"
              placeholder="Filter blueprints…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 220 }}
            />
          </div>

          <div className="filter-group">
            <span className="filter-label">TYPE</span>
            <div className="filter-options">
              <button className={`chip${showBPO ? ' active' : ''}`} onClick={() => setShowBPO(v => !v)}>BPO</button>
              <button className={`chip${showBPC ? ' active' : ''}`} onClick={() => setShowBPC(v => !v)}>BPC</button>
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-label">OWNER</span>
            <div className="filter-options">
              <button className={`chip${showPersonal ? ' active' : ''}`} onClick={() => setShowPersonal(v => !v)}>Personal</button>
              <button className={`chip${showCorp ? ' active' : ''}`} onClick={() => setShowCorp(v => !v)}>Corp</button>
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-label">SORT</span>
            <select
              className="calc-input"
              value={sortKey}
              onChange={e => setSortKey(e.target.value)}
              style={{ marginRight: 4 }}
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button
              className="btn"
              onClick={() => setSortDir(d => d * -1)}
              style={{ padding: '3px 10px', fontSize: 11 }}
              title={sortDir === 1 ? 'Ascending' : 'Descending'}
            >{sortDir === 1 ? '↑' : '↓'}</button>
          </div>
        </div>

        <div className="bpl-toolbar-right">
          <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginRight: 8 }}>
            {loading
              ? <EveText text="LOADING…" scramble wave speed={40} steps={6} />
              : `${sorted.length} / ${bps.length}`}
          </span>
          <div style={{ display: 'flex', border: '1px solid var(--border)' }}>
            <button
              className={`btn${view === 'card' ? ' btn-primary' : ''}`}
              onClick={() => setView('card')}
              style={{ padding: '3px 12px', fontSize: 11, borderRight: '1px solid var(--border)' }}
              title="Card view"
            >⊞</button>
            <button
              className={`btn${view === 'list' ? ' btn-primary' : ''}`}
              onClick={() => setView('list')}
              style={{ padding: '3px 12px', fontSize: 11 }}
              title="List view"
            >≡</button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="calc-body">
        {loading && bps.length === 0 ? (
          <div style={{ padding: '32px 20px', color: 'var(--dim)', fontSize: 11, letterSpacing: 2, textAlign: 'center' }}>
            <EveText text="FETCHING BLUEPRINTS FROM ESI…" scramble wave speed={35} steps={12} />
          </div>
        ) : sorted.length === 0 ? (
          <div style={{ padding: '32px 20px', color: 'var(--dim)', fontSize: 11, letterSpacing: 2, textAlign: 'center' }}>
            NO BLUEPRINTS MATCH FILTERS
          </div>
        ) : view === 'card' ? (
          <div className="bpl-card-grid">
            {sorted.map(bp => (
              <BpCard
                key={cardKey(bp)}
                bp={bp}
                expanded={expandedId === cardKey(bp)}
                onToggle={() => setExpandedId(id => id === cardKey(bp) ? null : cardKey(bp))}
              />
            ))}
          </div>
        ) : (
          <table className="calc-table">
            <thead>
              <tr>
                {[
                  ['name',     'BLUEPRINT'],
                  ['bp_type',  'TYPE'],
                  ['me_level', 'ME'],
                  ['te_level', 'TE'],
                  ['runs',     'RUNS'],
                  [null,       'QTY'],
                  [null,       'CHARACTER'],
                  [null,       'OWNER'],
                ].map(([key, label]) => (
                  <th
                    key={label}
                    onClick={key ? () => toggleSort(key) : undefined}
                    style={{
                      cursor: key ? 'pointer' : 'default',
                      color: sortKey === key ? 'var(--text)' : undefined,
                      textAlign: label === 'BLUEPRINT' ? 'left' : 'right',
                    }}
                  >
                    {label}{key && sortKey === key ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(bp => <BpListRow key={cardKey(bp)} bp={bp} />)}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default memo(BpLibraryPage);
