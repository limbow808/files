import { useState, useMemo, useCallback } from 'react';
import { fmtISK, fmtVol } from '../utils/fmt';
import { API } from '../App';

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
  { key: 'name',           label: 'ITEM',           asc: false, sortable: false },
  { key: 'bp_type',        label: 'TYPE',           asc: false, sortable: false },
  { key: 'me',             label: 'ME',             asc: false, sortable: true  },
  { key: 'te',             label: 'TE',             asc: false, sortable: true  },
  { key: 'price',          label: 'CONTRACT PRICE', asc: false, sortable: true  },
  { key: 'material_cost',  label: 'MAT COST',       asc: false, sortable: true  },
  { key: 'gross_revenue',  label: 'REVENUE',        asc: false, sortable: true  },
  { key: 'net_profit',     label: 'PROFIT/RUN',     asc: false, sortable: true  },
  { key: 'roi',            label: 'ROI',            asc: false, sortable: true  },
  { key: 'isk_per_hour',   label: 'ISK/HR',         asc: false, sortable: true  },
  { key: 'breakeven_runs', label: 'BREAKEVEN',      asc: true,  sortable: true  },
  { key: 'links',          label: 'LINKS',          asc: false, sortable: false },
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
  const [listSortKey,  setListSortKey]  = useState('net_profit');
  const [scanSortKey,  setScanSortKey]  = useState('net_profit');
  const [region,       setRegion]       = useState(10000002);
  const [copiedId,     setCopiedId]     = useState(null);
  const [search,       setSearch]       = useState('');
  const [limit,        setLimit]        = useState(50);

  // ── Market scan state ─────────────────────────────────────────────────────
  const [scanState,   setScanState]   = useState('idle');
  const [scanResults, setScanResults] = useState(null);
  const [scanError,   setScanError]   = useState('');
  const [scanView,    setScanView]    = useState(false);
  const [showBpo, setShowBpo] = useState(true);
  const [showBpc, setShowBpc] = useState(true);
  const [maxPages, setMaxPages] = useState(20);

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
    return list.slice(0, limit);
  }, [calcResults, esiBpMap, search, listSortKey, limit]);

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

  const runScan = useCallback(async () => {
    setScanState('scanning');
    setScanError('');
    setScanResults(null);
    setScanView(true);
    try {
      const params = new URLSearchParams({ region_id: region, max_pages: maxPages });
      const resp = await fetch(`${API}/api/bpo_market_scan?${params}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      if (data.not_ready) throw new Error(data.message || 'Calculator data not loaded yet.');
      setScanResults(data);
      setScanState('done');
    } catch (err) {
      setScanError(err.message);
      setScanState('error');
    }
  }, [region]);

  const notReady = calcResults.length === 0;

  const filteredScanResults = useMemo(() => {
    if (!scanResults) return [];
    let list = scanResults.results
      .filter(r => (r.roi || 0) >= 1)   // hide useless <1% ROI results
      .map(r => ({
        ...r,
        breakeven_runs: (r.net_profit > 0 && r.price > 0)
          ? Math.ceil(r.price / r.net_profit)
          : null,
      }));
    if (!showBpo) list = list.filter(r =>  r.is_bpc);
    if (!showBpc) list = list.filter(r => !r.is_bpc);
    const col = SCAN_COLS.find(c => c.key === scanSortKey);
    const ascending = col?.asc ?? false;
    if (scanSortKey === 'breakeven_runs') {
      list = [...list].sort((a, b) => {
        if (a.breakeven_runs === null && b.breakeven_runs === null) return 0;
        if (a.breakeven_runs === null) return 1;
        if (b.breakeven_runs === null) return -1;
        return a.breakeven_runs - b.breakeven_runs;
      });
    } else {
      list = [...list].sort((a, b) =>
        ascending
          ? (a[scanSortKey] || 0) - (b[scanSortKey] || 0)
          : (b[scanSortKey] || 0) - (a[scanSortKey] || 0)
      );
    }
    return list;
  }, [scanResults, showBpo, showBpc, scanSortKey]);

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
          {/* BP Type filter — only relevant when scan view is active */}
          {scanView && scanResults && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2 }}>SHOW</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11,
                              color: showBpo ? '#4cff91' : 'var(--dim)' }}>
                <input type="checkbox" checked={showBpo} onChange={e => {
                  // prevent both being unchecked
                  if (!e.target.checked && !showBpc) return;
                  setShowBpo(e.target.checked);
                }} style={{ accentColor: '#4cff91' }} />
                BPO
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11,
                              color: showBpc ? '#ffcc00' : 'var(--dim)' }}>
                <input type="checkbox" checked={showBpc} onChange={e => {
                  // prevent both being unchecked
                  if (!e.target.checked && !showBpo) return;
                  setShowBpc(e.target.checked);
                }} style={{ accentColor: '#ffcc00' }} />
                BPC
              </label>
            </div>
          )}

          {/* Region for scan + links */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2 }}>REGION</span>
            <select
              className="calc-input"
              value={region}
              onChange={e => setRegion(Number(e.target.value))}
              style={{ width: 180 }}
            >
              {REGION_OPTIONS.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          {/* Pages to scan */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2 }}>PAGES</span>
            {[5, 10, 20].map(n => (
              <button
                key={n}
                className={`chip${maxPages === n ? ' active' : ''}`}
                onClick={() => setMaxPages(n)}
                title={`Scan ${n * 1000} contracts`}
              >{n}</button>
            ))}
          </div>

          {/* Limit */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2 }}>TOP</span>
            {[25, 50, 100].map(n => (
              <button
                key={n}
                className={`chip${limit === n ? ' active' : ''}`}
                onClick={() => setLimit(n)}
              >{n}</button>
            ))}
          </div>

          {/* Search */}
          <input
            className="calc-search-input"
            placeholder="Filter items…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: 180 }}
          />
        </div>
      </div>

      {/* Table */}
      {/* ── SCAN RESULTS panel ─────────────────────────────────────────────── */}
      <div className="bp-finder-body">
        {/* Scanning spinner */}
        {scanView && scanState === 'scanning' && (
          <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--accent)', fontSize: 11, letterSpacing: 2 }}>
            SCANNING ESI PUBLIC CONTRACTS… this may take 15–30 seconds
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
                                 : ['net_profit','roi','isk_per_hour','breakeven_runs'].includes(col.key) ? '#4cff91'
                                 : col.key === 'price' ? 'var(--accent)'
                                 : undefined,
                            userSelect: 'none',
                            whiteSpace: 'nowrap',
                          }}
                          onClick={col.sortable ? () => setScanSortKey(col.key) : undefined}
                          title={col.key === 'breakeven_runs' ? 'Runs needed to recoup BP contract price' : undefined}
                        >
                          {col.label}{arrow}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filteredScanResults.map(r => (
                    <tr key={`${r.contract_id}-${r.blueprint_id}`} className="bp-finder-row">
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
                        </div>
                      </td>
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
                      <td style={{ color: r.me >= 10 ? '#4cff91' : 'var(--text)' }}>
                        {r.me}
                      </td>
                      <td style={{ color: r.te >= 20 ? '#4cff91' : 'var(--text)' }}>
                        {r.te}
                      </td>
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>
                        {fmtISK(r.price)}
                      </td>
                      <td style={{ color: 'var(--dim)' }}>{fmtISK(r.material_cost)}</td>
                      <td>{fmtISK(r.gross_revenue)}</td>
                      <td className="profit-val">{fmtISK(r.net_profit)}</td>
                      <td className="profit-val">{(r.roi || 0).toFixed(1)}%</td>
                      <td>{r.isk_per_hour ? fmtISK(r.isk_per_hour) : '—'}</td>
                      <td style={{
                        color: r.breakeven_runs === null ? 'var(--dim)'
                             : r.breakeven_runs <= 10   ? '#4cff91'
                             : r.breakeven_runs <= 50   ? 'var(--text)'
                             : '#ffcc00',
                        fontWeight: r.breakeven_runs !== null ? 600 : undefined,
                      }}
                        title={r.breakeven_runs ? `${r.breakeven_runs} runs to recoup BP cost` : 'N/A'}
                      >
                        {r.breakeven_runs !== null ? `${r.breakeven_runs.toLocaleString()} runs` : '—'}
                      </td>
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
                  ))}
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
