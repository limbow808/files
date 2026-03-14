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

const SORT_OPTS = [
  { key: 'net_profit',   label: 'PROFIT'  },
  { key: 'roi',          label: 'ROI'     },
  { key: 'isk_per_hour', label: 'ISK/HR'  },
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
  const [sortKey,    setSortKey]    = useState('net_profit');
  const [region,     setRegion]     = useState(10000002);
  const [copiedId,   setCopiedId]   = useState(null);
  const [search,     setSearch]     = useState('');
  const [limit,      setLimit]      = useState(50);

  // ── Market scan state ─────────────────────────────────────────────────────
  const [scanState,   setScanState]   = useState('idle'); // idle | scanning | done | error
  const [scanResults, setScanResults] = useState(null);   // null or { results, matched, pages_scanned, contracts_checked }
  const [scanError,   setScanError]   = useState('');
  const [scanView,    setScanView]    = useState(false);  // show scan results panel instead of main list

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

    list = [...list].sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
    return list.slice(0, limit);
  }, [calcResults, esiBpMap, search, sortKey, limit]);

  function copyName(name, id) {
    navigator.clipboard.writeText(name).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }

  function contractsUrl(blueprintId, name) {
    // Eve Workbench market sell page — works with type_id
    return `https://www.eveworkbench.com/market/sell/${blueprintId}`;
  }

  function fuzzworkUrl(outputId) {
    return `https://market.fuzzwork.co.uk/type/${outputId}/`;
  }

  const runScan = useCallback(async () => {
    setScanState('scanning');
    setScanError('');
    setScanResults(null);
    setScanView(true);
    try {
      const params = new URLSearchParams({ region_id: region, max_pages: 5 });
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

  return (
    <div className="bp-finder-panel">
      {/* Header */}
      <div className="bp-finder-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <span className="bp-finder-title">◈ BP FINDER</span>
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
              >📋 LIST</button>
            )}
            {scanResults && (
              <button
                className={`chip${scanView ? ' active' : ''}`}
                onClick={() => setScanView(true)}
                style={{ fontSize: 10 }}
              >⚡ SCAN RESULTS ({scanResults.matched})</button>
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
              {scanState === 'scanning' ? '⏳ SCANNING…' : '⚡ SCAN MARKET'}
            </button>
          </div>
        </div>

        <div className="bp-finder-controls">
          {/* Sort */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 2 }}>SORT</span>
            {SORT_OPTS.map(o => (
              <button
                key={o.key}
                className={`chip${sortKey === o.key ? ' active' : ''}`}
                onClick={() => setSortKey(o.key)}
              >{o.label}</button>
            ))}
          </div>

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
            ⏳ SCANNING ESI PUBLIC CONTRACTS… this may take 15–30 seconds
          </div>
        )}

        {/* Scan error */}
        {scanView && scanState === 'error' && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--accent)', fontSize: 11, letterSpacing: 2 }}>
            ⚠ {scanError}
          </div>
        )}

        {/* Scan results table */}
        {scanView && scanState === 'done' && scanResults && (
          <>
            {scanResults.results.length === 0 ? (
              <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
                NO BPO CONTRACTS FOUND — tried {scanResults.contracts_checked?.toLocaleString()} contracts across {scanResults.pages_scanned} pages
              </div>
            ) : (
              <table className="bp-finder-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>ITEM</th>
                    <th>ME</th>
                    <th>TE</th>
                    <th style={{ color: 'var(--accent)' }}>BPO PRICE</th>
                    <th>MAT COST</th>
                    <th>REVENUE</th>
                    <th style={{ color: '#4cff91' }}>PROFIT/RUN</th>
                    <th style={{ color: '#4cff91' }}>ROI</th>
                    <th style={{ color: '#4cff91' }}>ISK/HR</th>
                    <th style={{ textAlign: 'center' }}>LINKS</th>
                  </tr>
                </thead>
                <tbody>
                  {scanResults.results.map(r => (
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
                            onClick={() => copyName(r.name + ' Blueprint', r.output_id)}
                          >
                            {r.name}
                            {copiedId === r.output_id && <span className="copy-flash"> ✓</span>}
                          </span>
                          {r.already_owned && (
                            <span style={{ fontSize: 9, color: '#4cff91', letterSpacing: 1, marginLeft: 4, opacity: 0.7 }}>✓OWN</span>
                          )}
                        </div>
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
                      <td>
                        <div className="bp-finder-actions">
                          <button
                            className="bp-action-btn"
                            title={`Copy "${r.name} Blueprint" to clipboard`}
                            onClick={() => copyName(r.name + ' Blueprint', r.output_id)}
                          >{copiedId === r.output_id ? '✓' : '📋'}</button>
                          <a
                            className="bp-action-btn bp-action-link"
                            href={contractsUrl(r.blueprint_id, r.name)}
                            target="_blank" rel="noopener noreferrer"
                            title="View blueprint on Eve Workbench market"
                          >🔍</a>
                          <a
                            className="bp-action-btn bp-action-link"
                            href={fuzzworkUrl(r.output_id)}
                            target="_blank" rel="noopener noreferrer"
                            title="View manufactured item on Fuzzwork"
                          >📈</a>
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
                <th style={{ textAlign: 'left' }}>ITEM</th>
                <th>CAT</th>
                <th>TECH</th>
                <th>DEMAND</th>
                <th>COST</th>
                <th>REVENUE</th>
                <th style={{ color: '#4cff91' }}>PROFIT</th>
                <th style={{ color: '#4cff91' }}>ROI</th>
                <th style={{ color: '#4cff91' }}>ISK/HR</th>
                <th style={{ textAlign: 'center' }}>ACTIONS</th>
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
                        {copiedId === r.output_id && <span className="copy-flash"> ✓</span>}
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
                      >{copiedId === r.output_id ? '✓' : '📋'}</button>
                      <a
                        className="bp-action-btn bp-action-link"
                        href={contractsUrl(r.blueprint_id, r.name)}
                        target="_blank" rel="noopener noreferrer"
                        title="View blueprint on Eve Workbench market"
                      >🔍</a>
                      <a
                        className="bp-action-btn bp-action-link"
                        href={fuzzworkUrl(r.output_id)}
                        target="_blank" rel="noopener noreferrer"
                        title="View manufactured item on Fuzzwork"
                      >📈</a>
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
            {scanResults.matched} BPO{scanResults.matched !== 1 ? 'S' : ''} FOUND
            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
              · {scanResults.contracts_checked?.toLocaleString()} contracts checked across {scanResults.pages_scanned} pages
            </span>
            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
              · ME/TE highlighted green at max (10/20)
            </span>
          </>
        ) : !scanView && !notReady && unownedItems.length > 0 ? (
          <>
            {unownedItems.length} ITEM{unownedItems.length !== 1 ? 'S' : ''} WITHOUT BLUEPRINT
            <span style={{ marginLeft: 12, color: 'var(--dim)' }}>
              click 📋 to copy name · 🔍 Eve Workbench market · 📈 Fuzzwork · ⚡ to scan live contracts
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
