import { useState, useRef, Fragment, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { useCalcProgress } from '../hooks/useCalcProgress';
import { fmtISK, fmtVol, fmtDuration, toggleSet, roiTier } from '../utils/fmt';
import SystemInput from '../components/SystemInput';
import EsiBlueprintPanel from '../components/EsiBlueprintPanel';
import CalcDetailPanel from '../components/CalcDetailPanel';
import ShoppingList from '../components/ShoppingList';
import { API } from '../App';

const BP_FILTERS   = ['Personal', 'Corporate', 'Not Owned', 'BPOs', 'BPCs'];
const TYPE_FILTERS = ['Ships', 'Modules', 'Charges', 'Drones', 'Rigs', 'Structures', 'Booster', 'Implants', 'Components', 'Other'];
const TECH_FILTERS = ['I', 'II', 'III'];
const SIZE_FILTERS = ['S', 'M', 'L', 'XL', 'U'];

const FACILITY_OPTIONS = [
  { value: 'station', label: 'NPC Station' },
  { value: 'medium',  label: 'Medium Eng. Complex' },
  { value: 'large',   label: 'Large Eng. Complex' },
  { value: 'xl',      label: 'XL Eng. Complex' },
  { value: 'raitaru', label: 'Raitaru' },
  { value: 'azbel',   label: 'Azbel' },
  { value: 'sotiyo',  label: 'Sotiyo' },
];

const MARKET_HUBS = ['jita', 'amarr', 'dodixie', 'rens', 'hek'];

const CALC_COLS = [
  { key: 'name',             label: 'ITEM',     get: r => r.name,                                    align: 'left'  },
  { key: 'tech',             label: 'TECH',     get: r => r.tech || '',                              align: 'right' },
  { key: 'category',         label: 'CAT',      get: r => r.category || '',                          align: 'right' },
  { key: 'me_level',         label: 'ME',       get: r => r.me_level ?? 0,                           align: 'right' },
  { key: 'te_level',         label: 'TE',       get: r => r.te_level ?? 0,                           align: 'right' },
  { key: 'duration',         label: 'DURATION', get: r => r.duration || 0,                           align: 'right' },
  { key: 'avg_daily_volume', label: 'DEMAND',   get: r => r.avg_daily_volume || 0,                   align: 'right' },
  { key: 'qty',              label: 'QTY',      get: r => r.output_qty || 1,                         align: 'right', noSort: true },
  { key: 'runs',             label: 'RUNS',     get: r => 1,                                         align: 'right', noSort: true },
  { key: 'cost',             label: 'COST',     get: r => (r.material_cost || 0) + (r.job_cost || 0), align: 'right' },
  { key: 'gross_revenue',    label: 'REVENUE',  get: r => r.gross_revenue || 0,                      align: 'right' },
  { key: 'tax',              label: 'TAX',      get: r => (r.sales_tax || 0) + (r.broker_fee || 0),  align: 'right' },
  { key: 'net_profit',       label: 'PROFIT',   get: r => r.net_profit || 0,                         align: 'right' },
  { key: 'roi',              label: 'ROI',      get: r => r.roi || 0,                                align: 'right' },
  { key: 'isk_per_hour',     label: 'ISK/HR',   get: r => r.isk_per_hour || 0,                       align: 'right' },
  { key: 'isk_per_m3',       label: 'ISK/M³',   get: r => r.isk_per_m3 || 0,                         align: 'right' },
];

export default function CalculatorPage({ refreshKey = 0 }) {
  const [bpFilters,   setBpFilters]   = useState(new Set(BP_FILTERS));
  const [typeFilters, setTypeFilters] = useState(new Set(TYPE_FILTERS));
  const [techFilters, setTechFilters] = useState(new Set(TECH_FILTERS));
  const [sizeFilters, setSizeFilters] = useState(new Set(SIZE_FILTERS));

  const [system,    setSystem]    = useState('Korsiki');
  const [facility,  setFacility]  = useState('large');
  const [buyLoc,    setBuyLoc]    = useState('jita');
  const [sellLoc,   setSellLoc]   = useState('jita');
  const [minVolume, setMinVolume] = useState('');
  const [search,    setSearch]    = useState('');

  const [sortKey, setSortKey] = useState('net_profit');
  const [sortDir, setSortDir] = useState(-1);

  const [overrides,    setOverrides]    = useState({});
  const [selectedIdx,  setSelectedIdx]  = useState(null);
  const [showEsiBps,   setShowEsiBps]   = useState(false);
  const [checkedIds,   setCheckedIds]   = useState(new Set());
  const [retryKey,     setRetryKey]     = useState(0);

  function toggleCheck(id, e) {
    e.stopPropagation();
    setCheckedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function buildUrl() {
    const params = new URLSearchParams({ system, facility, sell_loc: sellLoc, buy_loc: buyLoc });
    return `${API}/api/calculator?${params}`;
  }

  const { data: calcData, loading, error } = useApi(buildUrl(), [refreshKey, retryKey]);
  const progress = useCalcProgress(system, facility, loading && !calcData);
  const { data: skillsData } = useApi(`${API}/api/skills`, []);
  const { data: esiBpData  } = useApi(`${API}/api/blueprints/esi`, []);
  const charSkills = skillsData?.skills || null;

  // Build ESI BP lookup: normalised lowercase product name → { hasBPO, hasBPC }
  // ESI names include " Blueprint" suffix — strip it to match calculator product names
  const esiBpMap = useMemo(() => {
    const map = {};
    for (const bp of (esiBpData?.blueprints || [])) {
      const key = bp.name.toLowerCase().replace(/\s+blueprint$/, '');
      if (!map[key]) map[key] = { hasBPO: false, hasBPC: false };
      if (bp.bp_type === 'BPO') map[key].hasBPO = true;
      else                       map[key].hasBPC = true;
    }
    return map;
  }, [esiBpData]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d * -1);
    else { setSortKey(key); setSortDir(-1); }
  }

  const baseResults = (calcData?.results || []).filter(r => {
    if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (!techFilters.has(r.tech     || 'I'))     return false;
    if (!sizeFilters.has(r.size     || 'U'))     return false;
    if (!typeFilters.has(r.category || 'Other')) return false;

    // BP ownership filter — classify each result against the ESI BP map
    const bpEntry  = esiBpMap[r.name?.toLowerCase()] ?? null;
    const isOwned  = !!bpEntry;
    const hasBPO   = bpEntry?.hasBPO ?? false;
    const hasBPC   = bpEntry?.hasBPC ?? false;

    // If ALL bp chips are active → show everything (no filtering)
    const allBpOn = BP_FILTERS.every(f => bpFilters.has(f));
    if (!allBpOn) {
      let passes = false;
      if (bpFilters.has('Personal')  && isOwned)              passes = true;
      if (bpFilters.has('Not Owned') && !isOwned)             passes = true;
      if (bpFilters.has('BPOs')      && hasBPO)               passes = true;
      if (bpFilters.has('BPCs')      && hasBPC)               passes = true;
      // Corporate: no data yet → treat as pass-through when selected
      if (bpFilters.has('Corporate'))                          passes = true;
      if (!passes) return false;
    }

    if (minVolume) {
      const mv = parseFloat(minVolume);
      if (!isNaN(mv) && (r.avg_daily_volume || 0) < mv) return false;
    }
    return true;
  });

  const col     = CALC_COLS.find(c => c.key === sortKey);
  const results = [...baseResults].sort((a, b) => {
    const av = col ? col.get(a) : 0;
    const bv = col ? col.get(b) : 0;
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * ((av || 0) - (bv || 0));
  });

  const checkedItems = results.filter(r => checkedIds.has(r.output_id));

  function getOverride(id, field, fallback) {
    return overrides[id]?.[field] ?? fallback;
  }
  function setOverride(id, field, val) {
    setOverrides(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: val } }));
  }
  // Raw string stored while typing; resolved to int ≥ 1 on blur
  function getOverrideRaw(id, field, def) {
    const v = overrides[id]?.[field];
    return v !== undefined ? v : def;
  }
  function commitOverride(id, field, def) {
    const raw = overrides[id]?.[field];
    const n   = parseInt(raw, 10);
    if (isNaN(n) || n < 1) setOverride(id, field, def);
  }

  const sciInfo = calcData?.sci != null
    ? `SCI ${(calcData.sci * 100).toFixed(2)}% · ${calcData?.facility?.label || ''}`
    : null;

  return (
    <div className="calc-page">

      {/* Fixed top: filters + search */}
      <div className="calc-top">
        <div className="calc-filters">
          {/* Row 1: inputs */}
          <div className="calc-filters-inputs">
            <div className="filter-group">
              <span className="filter-label">SYS</span>
              <SystemInput value={system} onChange={setSystem} />
            </div>
            <div className="filter-group">
              <span className="filter-label">FAC</span>
              <select className="calc-input" value={facility} onChange={e => setFacility(e.target.value)} style={{ width: 160 }}>
                {FACILITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <span className="filter-label">BUY</span>
              <select className="calc-input" value={buyLoc} onChange={e => setBuyLoc(e.target.value)}>
                {MARKET_HUBS.map(h => <option key={h} value={h}>{h.charAt(0).toUpperCase() + h.slice(1)}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <span className="filter-label">SELL</span>
              <select className="calc-input" value={sellLoc} onChange={e => setSellLoc(e.target.value)}>
                {MARKET_HUBS.map(h => <option key={h} value={h}>{h.charAt(0).toUpperCase() + h.slice(1)}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <span className="filter-label">VOL</span>
              <input className="calc-input" type="number" value={minVolume}
                onChange={e => setMinVolume(e.target.value)} placeholder="0" style={{ width: 80 }} />
            </div>
            <div className="filter-group" style={{ justifyContent: 'flex-end', borderRight: 'none' }}>
              <span className="filter-label" style={{ visibility: 'hidden' }}>–</span>
              <button
                className={`btn${showEsiBps ? ' btn-primary' : ''}`}
                onClick={() => setShowEsiBps(v => !v)}
                style={{ padding: '3px 14px', fontSize: 11 }}
              >ESI BPs</button>
            </div>
          </div>

          {/* Row 2: chip filters */}
          <div className="calc-filters-chips">
            {[
              ['BPs',  BP_FILTERS,   bpFilters,   setBpFilters],
              ['Type', TYPE_FILTERS, typeFilters, setTypeFilters],
              ['Tech', TECH_FILTERS, techFilters, setTechFilters],
              ['Size', SIZE_FILTERS, sizeFilters, setSizeFilters],
            ].map(([label, opts, active, setActive]) => {
              const allOn = opts.every(f => active.has(f));
              return (
                <div key={label} className="filter-group">
                  <span
                    className={`filter-label${allOn ? ' all-active' : ''}`}
                    onClick={() => setActive(allOn ? new Set() : new Set(opts))}
                    title={allOn ? `Deselect all ${label}` : `Select all ${label}`}
                  >{label}</span>
                  <div className="filter-options">
                    {opts.map(f => (
                      <button
                        key={f}
                        className={`chip${active.has(f) ? ' active' : ''}`}
                        onClick={() => setActive(s => toggleSet(s, f))}
                      >{f}</button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {showEsiBps && <EsiBlueprintPanel />}

        <div className="calc-search-bar">
          <span style={{ color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>SEARCH</span>
          <input
            className="calc-search-input"
            placeholder="Search items..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 1 }}>
            {results.length} ITEM{results.length !== 1 ? 'S' : ''}
          </span>
          {sciInfo && (
            <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 1, marginLeft: 'auto' }}>{sciInfo}</span>
          )}
          {charSkills && (
            <span style={{ color: '#00cc66', fontSize: 10, letterSpacing: 1 }}>● SKILLS LOADED</span>
          )}
        </div>
      </div>

      {/* Scrollable item table */}
      <div className="calc-body">
        <table className="calc-table">
          <thead>
            <tr>
              <th className="check-cell" title="Add to Shopping List">✓</th>
              {CALC_COLS.map(c => (
                <th
                  key={c.key}
                  style={{ textAlign: c.align, cursor: c.noSort ? 'default' : 'pointer', userSelect: 'none' }}
                  onClick={() => !c.noSort && handleSort(c.key)}
                >
                  {c.label}
                  {!c.noSort && sortKey === c.key && (
                    <span className="sort-arrow">{sortDir === -1 ? '▼' : '▲'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? null : (
              results.map((r, i) => {
                const isSel    = selectedIdx === i;
                const isChk    = checkedIds.has(r.output_id);
                const qty      = Math.max(1, parseInt(getOverrideRaw(r.output_id, 'qty',  r.output_qty), 10) || 1);
                const runs     = Math.max(1, parseInt(getOverrideRaw(r.output_id, 'runs', 1),             10) || 1);
                const totalTax = (r.sales_tax || 0) + (r.broker_fee || 0);
                const roi      = r.roi || 0;
                const tier     = roiTier(roi);

                return (
                  <Fragment key={r.output_id ?? i}>
                    <tr
                      className={`${tier} row-profitable${isSel ? ' row-selected' : ''}`}
                      onClick={() => setSelectedIdx(p => p === i ? null : i)}
                    >
                      <td className="check-cell" onClick={e => toggleCheck(r.output_id, e)}>
                        <input
                          className="row-check"
                          type="checkbox"
                          checked={isChk}
                          onChange={() => {}}
                          onClick={e => toggleCheck(r.output_id, e)}
                        />
                      </td>
                      <td style={{ fontFamily: 'var(--head)', fontSize: 13, letterSpacing: 1, textAlign: 'left' }}>{r.name}</td>
                      <td style={{ color: 'var(--dim)' }}>{r.tech || '—'}</td>
                      <td style={{ color: 'var(--dim)', fontSize: 10 }}>{r.category || '—'}</td>
                      <td>{r.me_level ?? '—'}</td>
                      <td>{r.te_level ?? '—'}</td>
                      <td style={{ color: 'var(--dim)' }}>{fmtDuration(r.duration)}</td>
                      <td style={{ color: 'var(--dim)' }}>{fmtVol(r.avg_daily_volume)}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <input className="inline-num" type="number" min="1"
                          value={getOverrideRaw(r.output_id, 'qty', r.output_qty)}
                          onChange={e => setOverride(r.output_id, 'qty', e.target.value)}
                          onBlur={() => commitOverride(r.output_id, 'qty', r.output_qty)} />
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <input className="inline-num" type="number" min="1"
                          value={getOverrideRaw(r.output_id, 'runs', 1)}
                          onChange={e => setOverride(r.output_id, 'runs', e.target.value)}
                          onBlur={() => commitOverride(r.output_id, 'runs', 1)} />
                      </td>
                      <td style={{ color: 'var(--dim)' }}>{fmtISK((r.material_cost + r.job_cost) * runs)}</td>
                      <td>{fmtISK(r.gross_revenue * runs)}</td>
                      <td style={{ color: 'var(--dim)' }}>{fmtISK(totalTax * runs)}</td>
                      <td className="profit-val">{fmtISK(r.net_profit * runs)}</td>
                      <td className="profit-val">{roi.toFixed(1)}%</td>
                      <td>{fmtISK(r.isk_per_hour)}</td>
                      <td>{r.isk_per_m3 ? fmtISK(r.isk_per_m3) : '—'}</td>
                    </tr>
                    {isSel && <CalcDetailPanel item={r} charSkills={charSkills} />}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>

        {!loading && error && (
          <div style={{ padding: '32px 20px', color: 'var(--accent)', textAlign: 'center', letterSpacing: 2, fontSize: 11 }}>
            COULD NOT REACH SERVER — Is <code style={{ color: 'var(--text)' }}>python server.py</code> running?
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setRetryKey(k => k + 1)} style={{ fontSize: 11 }}>⟳ RETRY</button>
            </div>
          </div>
        )}
        {!loading && !error && results.length === 0 && calcData && (
          <div style={{ padding: '32px 20px', color: 'var(--dim)', textAlign: 'center', letterSpacing: 2, fontSize: 11 }}>
            NO ITEMS MATCH CURRENT FILTERS
          </div>
        )}
        {loading && !calcData && (
          <div style={{ padding: '40px 20px', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: 2 }}>
            {progress && progress.stage === 'prices' ? (
              <div style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>
                FETCHING MARKET DATA…
              </div>
            ) : progress && progress.stage === 'calc' ? (
              <div>
                <div style={{ color: 'var(--text)', marginBottom: 8, fontSize: 12, letterSpacing: 1 }}>
                  {progress.msg}
                </div>
                <div style={{ color: 'var(--dim)', fontSize: 10 }}>
                  {progress.done} / {progress.total}
                </div>
                <div style={{ marginTop: 10, width: 240, margin: '10px auto 0', height: 2, background: '#1a1a1a', position: 'relative' }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${Math.round((progress.done / progress.total) * 100)}%`,
                    background: 'var(--accent)', transition: 'width 0.3s'
                  }} />
                </div>
              </div>
            ) : (
              <div style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>
                LOADING…
              </div>
            )}
          </div>
        )}
      </div>

      <ShoppingList checkedItems={checkedItems} overrides={overrides} />
    </div>
  );
}
