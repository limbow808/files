import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { fmtISK, fmtVol } from '../utils/fmt';
import { API } from '../App';

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v != null ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const REGION_OPTIONS = [
  { id: 10000002, name: 'The Forge (Jita)'  },
  { id: 10000043, name: 'Domain (Amarr)'    },
  { id: 10000032, name: 'Sinq Laison (Dodixie)' },
  { id: 10000042, name: 'Metropolis (Rens)' },
  { id: 10000030, name: 'Heimatar (Hek)'    },
];

// Columns sortable in the scan results table
// asc: true = sort ascending when active (e.g. breakeven: fewer runs = better)
const SCAN_COLS = [
  { key: 'name',            label: 'ITEM',          asc: false, sortable: false },
  { key: 'bp_type',         label: 'TYPE',          asc: false, sortable: false },
  { key: 'me',              label: 'ME',            asc: false, sortable: true  },
  { key: 'te',              label: 'TE',            asc: false, sortable: true  },
  { key: 'price',           label: 'BP PRICE',      asc: false, sortable: true  },
  { key: 'runs',            label: 'RUNS',          asc: false, sortable: true  },
  { key: 'adj_net_profit',  label: 'PROFIT/RUN',    asc: false, sortable: true, title: 'Per-run profit after amortising blueprint acquisition cost' },
  { key: 'adj_roi',         label: 'ROI',           asc: false, sortable: true, title: 'ROI after amortising blueprint acquisition cost'            },
  { key: 'isk_per_hour',    label: 'ISK/HR',        asc: false, sortable: true  },
  { key: 'total_adj_profit',label: 'TOTAL',         asc: false, sortable: true, title: 'Total adjusted profit across all available runs (BPCs only)' },
  { key: 'breakeven_runs',  label: 'BREAKEVEN',     asc: true,  sortable: true, title: 'Runs needed to recoup BP price from raw manufacturing profit' },
  { key: 'links',           label: 'LINKS',         asc: false, sortable: false },
];

// Columns sortable in the list (unowned items) table
const LIST_COLS = [
  { key: 'name',          label: 'ITEM',    asc: false, sortable: false },
  { key: 'category',      label: 'CAT',     asc: false, sortable: true  },
  { key: 'tech',          label: 'TECH',    asc: false, sortable: true  },
  { key: 'avg_daily_volume', label: 'DEMAND', asc: false, sortable: true },
  { key: 'material_cost', label: 'COST',    asc: false, sortable: true  },
  { key: 'gross_revenue', label: 'REVENUE', asc: false, sortable: true  },
  { key: 'net_profit',    label: 'PROFIT',  asc: false, sortable: true  },
  { key: 'roi',           label: 'ROI',     asc: false, sortable: true  },
  { key: 'isk_per_hour',  label: 'ISK/HR',  asc: false, sortable: true  },
  { key: 'actions',       label: 'ACTIONS', asc: false, sortable: false },
];

/**
 * BpFinderPanel
 * Shows profitable items that have no personal or corp blueprint,
 * with quick links to search contracts in-browser or trigger the in-game market window.
 *
 * Props:
 *   calcResults  - array from /api/calculator (already loaded by parent)
 *   esiBpMap     - { lowercaseName: {hasBPO, hasBPC} } from parent
 */
export default function BpFinderPanel({ calcResults = [], esiBpMap = {} }) {
  const [listSortKey,  setListSortKey]  = useState(() => lsGet('bpf_listSort', 'net_profit'));
  const [scanSortKey,  setScanSortKey]  = useState(() => lsGet('bpf_scanSort', 'adj_net_profit'));
  const [region,       setRegion]       = useState(10000002);
  const [copiedId,     setCopiedId]     = useState(null);
  const [search,       setSearch]       = useState('');

  // Persist sort keys
  useEffect(() => lsSet('bpf_listSort', listSortKey), [listSortKey]);
  useEffect(() => lsSet('bpf_scanSort', scanSortKey), [scanSortKey]);

  // ── Market scan state ─────────────────────────────────────────────────────
  const [scanState,   setScanState]   = useState('idle');
  const [scanResults, setScanResults] = useState(() => lsGet('bpf_scanResults', null));
  const [scanError,   setScanError]   = useState('');
  const [scanView,    setScanView]    = useState(() => lsGet('bpf_scanResults', null) != null);
  const [scanProgress, setScanProgress] = useState(null);
  const [showBpo,   setShowBpo]   = useState(true);
  const [showBpc,   setShowBpc]   = useState(true);
  const [showOwned, setShowOwned] = useState(true);

  const esRef = useRef(null);

  // Filter to unowned items: no personal ESI BP
  const unownedItems = useMemo(() => {
    let list = calcResults.filter(r => {
      const bpEntry = esiBpMap[r.name?.toLowerCase()] ?? null;
      return !bpEntry;  // no personal ESI BP at all
    });

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => r.name.toLowerCase().includes(q));
    }

    list = [...list].sort((a, b) => (b[listSortKey] || 0) - (a[listSortKey] || 0));
    return list;
  }, [calcResults, esiBpMap, search, listSortKey]);

  function copyName(name, id) {
    navigator.clipboard.writeText(name).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  function contractsUrl(blueprintId) {
    // Eve Workbench market sell page for the blueprint type
    return `https://www.eveworkbench.com/market/sell/${blueprintId}`;
  }

  function fuzzworkUrl(outputId) {
    // Fuzzwork for the OUTPUT (crafted product) — shows actual market listings
    return `https://market.fuzzwork.co.uk/type/${outputId}/`;
  }

  const runScan = useCallback(() => {
    // Close any previous EventSource
    if (esRef.current) { esRef.current.close(); esRef.current = null; }

    setScanState('scanning');
    setScanError('');
    setScanResults(null);
    setScanView(true);
    setScanProgress({ phase: 'init', msg: 'Connecting…', pct: 0, contracts: 0, totalPages: 0, page: 0 });

    const params = new URLSearchParams({ region_id: region, max_pages: 20 });
    const es = new EventSource(`${API}/api/bpo_market_scan_stream?${params}`);
    esRef.current = es;

    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'status') {
        setScanProgress(p => ({ ...p, msg: msg.msg }));

      } else if (msg.type === 'contracts') {
        const pct = Math.round((msg.page / Math.max(msg.total_pages, 1)) * 50);
        setScanProgress({ phase: 'contracts', msg: null, page: msg.page,
                          totalPages: msg.total_pages, contracts: msg.contracts, pct });

      } else if (msg.type === 'scanning') {
        const pct = 50 + Math.round((msg.done / Math.max(msg.total, 1)) * 50);
        setScanProgress({ phase: 'scanning', msg: null, done: msg.done,
                          total: msg.total, matched: msg.matched, pct });

      } else if (msg.type === 'done') {
        lsSet('bpf_scanResults', msg);
        setScanResults(msg);
        setScanState('done');
        setScanProgress(null);
        es.close(); esRef.current = null;

      } else if (msg.type === 'error') {
        setScanError(msg.msg);
        setScanState('error');
        setScanProgress(null);
        es.close(); esRef.current = null;
      }
    };

    es.onerror = () => {
      if (esRef.current === es) {
        setScanError('Connection to server lost during scan.');
        setScanState('error');
        setScanProgress(null);
        es.close(); esRef.current = null;
      }
    };
  }, [region]);

  const notReady = calcResults.length === 0;

  const filteredScanResults = useMemo(() => {
    if (!scanResults) return [];
    // Keep items where raw manufacturing ROI ≥ 1% (filters truly hopeless items)
    // but still show infeasible BPCs so the user can see why they don't work
    let list = scanResults.results.filter(r => (r.roi || 0) >= 1);
    if (!showBpo)   list = list.filter(r =>  r.is_bpc);
    if (!showBpc)   list = list.filter(r => !r.is_bpc);
    if (!showOwned) list = list.filter(r => !r.already_owned);
    const col = SCAN_COLS.find(c => c.key === scanSortKey);
    const ascending = col?.asc ?? false;
    if (scanSortKey === 'breakeven_runs') {
      list = [...list].sort((a, b) => {
        const av = a.breakeven_runs ?? Infinity;
        const bv = b.breakeven_runs ?? Infinity;
        return av - bv;
      });
    } else {
      list = [...list].sort((a, b) =>
        ascending
          ? (a[scanSortKey] ?? 0) - (b[scanSortKey] ?? 0)
          : (b[scanSortKey] ?? 0) - (a[scanSortKey] ?? 0)
      );
    }
    return list;
  }, [scanResults, showBpo, showBpc, showOwned, scanSortKey]);

  return (
    <div className="bp-finder-panel">
      {/* Header */}
      <div className="bp-finder-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <span className="bp-finder-title">BP FINDER</span>
            <span className="bp-finder-sub" style={{ marginLeft: 12 }}>
              Profitable items with no owned blueprint
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Toggle list / scan results */}
            {scanResults && (
              <button
                className={`chip${scanView ? '' : ' active'}`}
                onClick={() => setScanView(false)}
                style={{ fontSize: 10 }}
              >LIST</button>
            )}
            {scanResults && (
              <button
                className={`chip${scanView ? ' active' : ''}`}
                onClick={() => setScanView(true)}
                style={{ fontSize: 10 }}
              >SCAN RESULTS ({scanResults.matched})</button>
            )}
            {/* Scan button */}
            <button
              className="chip"
              onClick={runScan}
              disabled={scanState === 'scanning' || notReady}
              title={notReady ? 'Load Calculator data first' : `Scan ESI contracts in ${REGION_OPTIONS.find(r => r.id === region)?.name}`}
              style={{
                background: scanState === 'scanning' ? 'rgba(255,71,0,0.15)' : undefined,
                borderColor: scanState === 'scanning' ? 'var(--accent)' : undefined,
                color:       scanState === 'scanning' ? 'var(--accent)' : undefined,
              }}
            >
              {scanState === 'scanning' ? 'SCANNING…' : 'SCAN CONTRACTS'}
            </button>
          </div>
        </div>

        <div className="bp-finder-controls">
          {/* BP Type + Owned filters */}
          <div className="filter-group">
            <span className="filter-label">SHOW</span>
            <div className="filter-options">
              <button
                className={`chip${showBpo ? ' active' : ''}`}
                onClick={() => { if (showBpc) setShowBpo(v => !v); }}
                title={showBpo ? 'Hide BPOs' : 'Show BPOs'}
              >BPO</button>
              <button
                className={`chip${showBpc ? ' active' : ''}`}
                onClick={() => { if (showBpo) setShowBpc(v => !v); }}
                title={showBpc ? 'Hide BPCs' : 'Show BPCs'}
              >BPC</button>
              <button
                className={`chip${showOwned ? ' active' : ''}`}
                onClick={() => setShowOwned(v => !v)}
                title={showOwned ? 'Hide already-owned BPs from results' : 'Show already-owned BPs in results'}
              >OWNED</button>
            </div>
          </div>

          {/* Region */}
          <div className="filter-group">
            <span className="filter-label">REGION</span>
            <select
              className="calc-input"
              value={region}
              onChange={e => setRegion(Number(e.target.value))}
              style={{ width: 175 }}
            >
              {REGION_OPTIONS.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          {/* Search */}
          <div className="filter-group" style={{ borderRight: 'none', flex: 1 }}>
            <span className="filter-label">SEARCH</span>
            <input
              className="calc-search-input"
              placeholder="Filter items…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ maxWidth: 220 }}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      {/* ── SCAN RESULTS panel ─────────────────────────────────────────────── */}
      <div className="bp-finder-body">
        {/* Live scan progress */}
        {scanView && scanState === 'scanning' && scanProgress && (
          <div className="scan-progress-panel">
            <div className="scan-progress-header">
              {scanProgress.phase === 'init' || scanProgress.phase == null ? (
                <span className="scan-progress-label scan-label-shimmer">{scanProgress.msg || 'CONNECTING…'}</span>
              ) : scanProgress.phase === 'contracts' ? (
                <>
                  <span className="scan-progress-label">FETCHING CONTRACTS</span>
                  <span className="scan-progress-stat">
                    PAGE <strong>{scanProgress.page}</strong> / {scanProgress.totalPages}
                    &nbsp;·&nbsp;
                    <strong>{(scanProgress.contracts || 0).toLocaleString()}</strong> contracts
                  </span>
                </>
              ) : (
                <>
                  <span className="scan-progress-label">SCANNING BLUEPRINTS</span>
                  <span className="scan-progress-stat">
                    <strong>{(scanProgress.done || 0).toLocaleString()}</strong> / {(scanProgress.total || 0).toLocaleString()} candidates
                    &nbsp;·&nbsp;
                    <strong style={{ color: '#4cff91' }}>{scanProgress.matched || 0}</strong> matches
                  </span>
                </>
              )}
            </div>
            <div className="scan-progress-track">
              <div
                className="scan-progress-bar"
                style={{ width: `${scanProgress.pct || 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Scan error */}
        {scanView && scanState === 'error' && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--accent)', fontSize: 11, letterSpacing: 2 }}>
            ERROR: {scanError}
          </div>
        )}

        {/* Scan results table */}
        {scanView && scanState === 'done' && scanResults && (
          <>
            {filteredScanResults.length === 0 ? (
              <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
                {scanResults.results.length === 0
                  ? `NO BLUEPRINT CONTRACTS FOUND — tried ${scanResults.contracts_checked?.toLocaleString()} contracts across ${scanResults.pages_scanned} pages`
                  : `NO ${bpTypeFilter.toUpperCase()} CONTRACTS IN RESULTS — try ALL or a different filter`
                }
              </div>
            ) : (
              <table className="bp-finder-table">
                <thead>
                  <tr>
                    {SCAN_COLS.map(col => {
                      const active = scanSortKey === col.key;
                      const arrow  = active ? (col.asc ? ' ▲' : ' ▼') : '';
                      return (
                        <th
                          key={col.key}
                          style={{
                            textAlign: col.key === 'name' ? 'left' : undefined,
                            cursor: col.sortable ? 'pointer' : undefined,
                            color: active ? 'var(--text)'
                                 : ['adj_net_profit','adj_roi','isk_per_hour','total_adj_profit'].includes(col.key) ? '#4cff91'
                                 : col.key === 'price' ? 'var(--accent)'
                                 : undefined,
                            userSelect: 'none',
                            whiteSpace: 'nowrap',
                          }}
                          onClick={col.sortable ? () => setScanSortKey(col.key) : undefined}
                          title={col.title}
                        >
                          {col.label}{arrow}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filteredScanResults.map(r => {
                    const infeasible = r.is_bpc && !r.can_breakeven;
                    const adjProfit  = r.adj_net_profit ?? r.net_profit;
                    const adjRoi     = r.adj_roi     ?? r.roi;
                    return (
                    <tr
                      key={`${r.contract_id}-${r.blueprint_id}`}
                      className="bp-finder-row"
                      style={infeasible ? { background: 'rgba(255,50,50,0.07)' } : undefined}
                    >
                      <td style={{ textAlign: 'left' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <img
                            src={`https://images.evetech.net/types/${r.output_id}/icon?size=32`}
                            alt=""
                            style={{ width: 20, height: 20, flexShrink: 0 }}
                            onError={e => { e.target.style.display = 'none'; }}
                          />
                          <span
                            className="bp-finder-name"
                            title="Click to copy blueprint name"
                            onClick={() => copyName(r.name + (r.is_bpc ? ' Blueprint Copy' : ' Blueprint'), r.output_id)}
                          >
                            {r.name}
                            {copiedId === r.output_id && <span className="copy-flash"> COPIED</span>}
                          </span>
                          {r.already_owned && (
                            <span style={{ fontSize: 9, color: '#4cff91', letterSpacing: 1, marginLeft: 4, opacity: 0.7 }}>OWNED</span>
                          )}
                          {infeasible && (
                            <span style={{ fontSize: 9, color: '#ff4444', letterSpacing: 1, marginLeft: 4, fontWeight: 700 }} title="Cannot recover blueprint cost within available runs">NO PROFIT</span>
                          )}
                        </div>
                      </td>
                      {/* TYPE */}
                      <td>
                        <span style={{
                          fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: '1px 5px',
                          borderRadius: 3,
                          background: r.is_bpc ? 'rgba(255,200,0,0.15)' : 'rgba(76,255,145,0.12)',
                          color:      r.is_bpc ? '#ffcc00'              : '#4cff91',
                          border:     r.is_bpc ? '1px solid #ffcc0060'  : '1px solid #4cff9160',
                        }}>
                          {r.is_bpc ? 'BPC' : 'BPO'}
                        </span>
                      </td>
                      {/* ME */}
                      <td style={{ color: r.me >= 10 ? '#4cff91' : 'var(--text)' }}>
                        {r.me}
                      </td>
                      {/* TE */}
                      <td style={{ color: r.te >= 20 ? '#4cff91' : 'var(--text)' }}>
                        {r.te}
                      </td>
                      {/* BP PRICE */}
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>
                        {fmtISK(r.price)}
                      </td>
                      {/* RUNS */}
                      <td style={{
                        color: r.is_bpc && !r.bpc_feasible ? '#ff4444'
                             : r.is_bpc                    ? 'var(--text)'
                             : '#4cff91',
                        fontWeight: r.is_bpc ? 600 : undefined,
                      }}
                        title={r.is_bpc
                          ? `${r.runs} runs remaining — need ${r.breakeven_runs ?? '?'} to break even`
                          : 'Unlimited runs (BPO)'}
                      >
                        {r.runs === -1 ? '∞' : (r.runs ?? '—').toLocaleString?.() ?? r.runs}
                      </td>
                      {/* PROFIT/RUN (adjusted) */}
                      <td style={{
                        color: adjProfit > 0 ? '#4cff91' : '#ff4444',
                        fontWeight: 600,
                      }}
                        title={r.is_bpc
                          ? `${fmtISK(r.net_profit)} raw − ${fmtISK(r.price / r.runs)} per-run BP cost = ${fmtISK(adjProfit)} adj`
                          : 'BPO: profit unchanged (acquisition is capital)'}
                      >
                        {fmtISK(adjProfit)}
                      </td>
                      {/* ROI (adjusted) */}
                      <td style={{ color: adjRoi > 0 ? '#4cff91' : '#ff4444', fontWeight: 600 }}>
                        {adjRoi != null ? `${adjRoi.toFixed(1)}%` : '—'}
                      </td>
                      {/* ISK/HR */}
                      <td>{r.isk_per_hour ? fmtISK(r.isk_per_hour) : '—'}</td>
                      {/* TOTAL (lifetime adj profit for BPCs) */}
                      <td style={{
                        color: r.is_bpc
                          ? (r.total_adj_profit > 0 ? '#4cff91' : '#ff4444')
                          : '#4cff91',
                        fontWeight: 600,
                      }}
                        title={r.is_bpc
                          ? `Total adj profit across all ${r.runs} runs`
                          : 'BPO: unlimited runs'}
                      >
                        {r.is_bpc
                          ? fmtISK(r.total_adj_profit)
                          : '∞'}
                      </td>
                      {/* BREAKEVEN (raw runs needed) */}
                      <td style={{
                        color: r.breakeven_runs == null                        ? 'var(--dim)'
                             : r.is_bpc && r.breakeven_runs > (r.runs ?? 0)   ? '#ff4444'
                             : r.breakeven_runs <= 10                          ? '#4cff91'
                             : r.breakeven_runs <= 50                         ? 'var(--text)'
                             : '#ffcc00',
                        fontWeight: r.breakeven_runs != null ? 600 : undefined,
                      }}
                        title={r.breakeven_runs
                          ? r.is_bpc && r.breakeven_runs > (r.runs ?? 0)
                            ? `INFEASIBLE: needs ${r.breakeven_runs} runs but only ${r.runs} available`
                            : `${r.breakeven_runs} runs to recoup BP cost`
                          : 'N/A'}
                      >
                        {r.breakeven_runs != null
                          ? r.is_bpc && r.breakeven_runs > (r.runs ?? 0)
                            ? `>${r.runs}`
                            : `${r.breakeven_runs.toLocaleString()}`
                          : '—'}
                      </td>
                      {/* LINKS */}
                      <td>
                        <div className="bp-finder-actions">
                          <button
                            className="bp-action-btn"
                            title={`Copy "${r.name} Blueprint" to clipboard`}
                            onClick={() => copyName(r.name + ' Blueprint', r.output_id)}
                          >{copiedId === r.output_id ? 'OK' : 'COPY'}</button>
                          <a
                            className="bp-action-btn bp-action-link"
                            href={`https://www.eveworkbench.com/market/sell/${r.blueprint_id}`}
                            target="_blank" rel="noopener noreferrer"
                            title="View blueprint on Eve Workbench market"
                          >EWB</a>
                          <a
                            className="bp-action-btn bp-action-link"
                            href={fuzzworkUrl(r.output_id)}
                            target="_blank" rel="noopener noreferrer"
                            title="View manufactured item on Fuzzwork"
                          >FW</a>
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        {/* ── Normal list (shown when not in scan view) ───────────────────── */}
        {!scanView && notReady && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
            WAITING FOR MARKET DATA — prices load automatically on the Calculator tab
          </div>
        )}
        {!scanView && !notReady && unownedItems.length === 0 && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
            NO ITEMS — all profitable items already have blueprints
          </div>
        )}
        {!scanView && !notReady && unownedItems.length > 0 && (
          <table className="bp-finder-table">
            <thead>
              <tr>
                {LIST_COLS.map(col => {
                  const active = listSortKey === col.key;
                  const arrow  = active ? ' ▼' : '';
                  return (
                    <th
                      key={col.key}
                      style={{
                        textAlign: col.key === 'name' ? 'left' : undefined,
                        cursor: col.sortable ? 'pointer' : undefined,
                        color: active ? 'var(--text)'
                             : ['net_profit','roi','isk_per_hour'].includes(col.key) ? '#4cff91'
                             : undefined,
                        userSelect: 'none',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={col.sortable ? () => setListSortKey(col.key) : undefined}
                    >
                      {col.label}{arrow}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {unownedItems.map(r => (
                <tr key={r.output_id} className="bp-finder-row">
                  <td style={{ textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <img
                        src={`https://images.evetech.net/types/${r.output_id}/icon?size=32`}
                        alt=""
                        style={{ width: 20, height: 20, flexShrink: 0 }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                      <span
                        className="bp-finder-name"
                        title="Click to copy blueprint name"
                        onClick={() => copyName(r.name + ' Blueprint', r.output_id)}
                      >
                        {r.name}
                        {copiedId === r.output_id && <span className="copy-flash"> COPIED</span>}
                      </span>
                    </div>
                  </td>
                  <td style={{ color: 'var(--dim)', fontSize: 10 }}>{r.category || '—'}</td>
                  <td style={{ color: 'var(--dim)' }}>{r.tech || '—'}</td>
                  <td style={{ color: 'var(--dim)' }}>{fmtVol(r.avg_daily_volume)}</td>
                  <td style={{ color: 'var(--dim)' }}>{fmtISK(r.material_cost)}</td>
                  <td>{fmtISK(r.gross_revenue)}</td>
                  <td className="profit-val">{fmtISK(r.net_profit)}</td>
                  <td className="profit-val">{(r.roi || 0).toFixed(1)}%</td>
                  <td>{r.isk_per_hour ? fmtISK(r.isk_per_hour) : '—'}</td>
                  <td>
                    <div className="bp-finder-actions">
                      <button
                        className="bp-action-btn"
                        title={`Copy "${r.name} Blueprint" to clipboard`}
                        onClick={() => copyName(r.name + ' Blueprint', r.output_id)}
                      >{copiedId === r.output_id ? 'COPIED' : 'COPY'}</button>
                      <a
                        className="bp-action-btn bp-action-link"
                        href={contractsUrl(r.blueprint_id, r.name)}
                        target="_blank" rel="noopener noreferrer"
                        title="View blueprint on Eve Workbench market"
                      >EWB</a>
                      <a
                        className="bp-action-btn bp-action-link"
                        href={fuzzworkUrl(r.output_id)}
                        target="_blank" rel="noopener noreferrer"
                        title="View manufactured item on Fuzzwork"
                      >FW</a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="bp-finder-footer">
        {scanView && scanState === 'done' && scanResults ? (
          <>
            {(() => {
              const bpos = scanResults.results.filter(r => !r.is_bpc).length;
              const bpcs = scanResults.results.filter(r => r.is_bpc).length;
              return (
                <>
                  {bpos > 0 && <span style={{ color: '#4cff91' }}>{bpos} BPO{bpos !== 1 ? 'S' : ''}</span>}
                  {bpos > 0 && bpcs > 0 && <span style={{ color: 'var(--dim)', margin: '0 4px' }}>·</span>}
                  {bpcs > 0 && <span style={{ color: '#ffcc00' }}>{bpcs} BPC{bpcs !== 1 ? 'S' : ''}</span>}
                  {' '}FOUND
                </>
              );
            })()}
            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
              · {scanResults.contracts_checked?.toLocaleString()} contracts checked across {scanResults.pages_scanned} pages
            </span>
            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
              · BPO <span style={{ color: '#4cff91' }}>green</span> · BPC <span style={{ color: '#ffcc00' }}>yellow</span> · ME/TE max highlighted green (10/20)
            </span>
          </>
        ) : !scanView && !notReady && unownedItems.length > 0 ? (
          <>
            {unownedItems.length} ITEM{unownedItems.length !== 1 ? 'S' : ''} WITHOUT BLUEPRINT
            <span style={{ marginLeft: 12, color: 'var(--dim)' }}>
              click COPY to copy name · EWB for Eve Workbench market · FW for Fuzzwork · SCAN CONTRACTS for live contracts
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
