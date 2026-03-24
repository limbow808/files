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
  { key: 'source',          label: 'SOURCE',        asc: false, sortable: false },
  { key: 'me',              label: 'ME',            asc: false, sortable: true  },
  { key: 'te',              label: 'TE',            asc: false, sortable: true  },
  { key: 'price',           label: 'ACQ PRICE',     asc: false, sortable: true  },
  { key: 'adj_net_profit',  label: 'PROFIT/RUN',    asc: false, sortable: true, title: 'Raw manufacturing profit per run from the calculator.' },
  { key: 'adj_roi',         label: 'ROI',           asc: false, sortable: true, title: 'Manufacturing ROI for the finished item.' },
  { key: 'isk_per_hour',    label: 'ISK/HR',        asc: false, sortable: true  },
  { key: 'expected_daily_profit', label: 'DAILY',   asc: false, sortable: true, title: 'Estimated daily profit limited by build throughput and market demand.' },
  { key: 'payback_days',    label: 'PAYBACK',       asc: true,  sortable: true, title: 'Estimated days to recover the blueprint purchase price.' },
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
export default function BpFinderPanel({ calcResults = [], esiBpMap = {}, listEnabled = false, listLoading = false, onLoadList = null, initialScanView = null, panelTitle = 'BP FINDER', panelSubtitle = 'Blueprint originals ranked by acquisition payoff' }) {
  const [listSortKey,  setListSortKey]  = useState(() => lsGet('bpf_listSort', 'net_profit'));
  const [scanSortKey,  setScanSortKey]  = useState(() => lsGet('bpf_scanSort', 'adj_net_profit'));
  const [region,       setRegion]       = useState(10000002);
  const [copiedId,     setCopiedId]     = useState(null);
  const [search,       setSearch]       = useState('');

  // Persist sort keys
  useEffect(() => lsSet('bpf_listSort', listSortKey), [listSortKey]);
  useEffect(() => lsSet('bpf_scanSort', scanSortKey), [scanSortKey]);

  // ── Market scan state ─────────────────────────────────────────────────────
  const _restoredResults = lsGet('bpf_scanResults', null);
  const [scanState,   setScanState]   = useState(_restoredResults != null ? 'done' : 'idle');
  const [scanResults, setScanResults] = useState(_restoredResults);
  const [scanError,   setScanError]   = useState('');
  const [scanView,    setScanView]    = useState(initialScanView ?? (_restoredResults != null));
  const [scanProgress, setScanProgress] = useState(null);
  const [showMarket, setShowMarket] = useState(true);
  const [showContracts, setShowContracts] = useState(true);
  const [showAffordable, setShowAffordable] = useState(true);
  const [showPersonalOwned, setShowPersonalOwned] = useState(false);
  const [showCorpOwned, setShowCorpOwned] = useState(false);

  // ── Contract cache warming status ─────────────────────────────────────────
  const [cacheStats, setCacheStats] = useState(null);
  const [cacheRate, setCacheRate] = useState(0);   // contracts/sec
  const [cacheEta, setCacheEta] = useState(null);  // seconds remaining
  const prevReadyRef = useRef(false);
  const prevFetchedRef = useRef(null);
  const prevPollTsRef = useRef(null);
  const lastAutoScanRef = useRef(0);       // epoch ms of last auto-rescan
  const silentBusyRef = useRef(false);     // guard against overlapping silent fetches

  // Silent background refresh — merges new contracts into existing table
  // without blanking the UI or showing scanning progress.
  async function silentRefresh() {
    if (silentBusyRef.current) return;
    silentBusyRef.current = true;
    try {
      const params = new URLSearchParams({ region_id: region, max_pages: 20 });
      const r = await fetch(`${API}/api/bpo_market_scan?${params}`);
      if (!r.ok) return;
      const data = await r.json();
      if (!data.results || data.not_ready) return;

      setScanResults(prev => {
        if (!prev) {
          lsSet('bpf_scanResults', data);
          return data;
        }
        const existingById = new Map(
          prev.results.map(r => [r.blueprint_id, r])
        );
        for (const row of data.results) {
          existingById.set(row.blueprint_id, row);
        }
        const merged = { ...data, results: [...existingById.values()] };
        lsSet('bpf_scanResults', merged);
        return merged;
      });
    } catch { /* silent — don't disturb user */ }
    finally { silentBusyRef.current = false; }
  }

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch(`${API}/api/contracts/status`);
        if (!r.ok || cancelled) return;
        const s = await r.json();
        if (cancelled) return;
        setCacheStats(s);

        // Compute rate + ETA from successive polls
        const now = Date.now();
        if (prevFetchedRef.current != null && prevPollTsRef.current != null) {
          const dt = (now - prevPollTsRef.current) / 1000;
          const dn = s.items_fetched - prevFetchedRef.current;
          if (dt > 0 && dn > 0) {
            const rate = dn / dt;
            setCacheRate(rate);
            if (s.items_pending > 0) {
              setCacheEta(Math.round(s.items_pending / rate));
            } else {
              setCacheEta(0);
            }
          }
          // No-progress interval: keep previous rate/ETA visible
        }
        prevFetchedRef.current = s.items_fetched;
        prevPollTsRef.current = now;

        // Auto-rescan once cache transitions from warming → ready
        // Strict === false so effect re-runs (scanState change) don't retrigger
        if (prevReadyRef.current === false && s.ready) {
          if (scanState === 'done' && scanView) {
            runScan();
            lastAutoScanRef.current = now;
          }
        }

        // Progressive silent refresh every 30s while cache is still warming
        if (!s.ready && scanState === 'done' && scanView
            && s.items_fetched > 0 && now - lastAutoScanRef.current > 30_000) {
          silentRefresh();
          lastAutoScanRef.current = now;
        }

        prevReadyRef.current = s.ready;
      } catch {}
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanState, scanView]);
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
    setScanState('scanning');
    setScanError('');
    setScanView(true);
    setScanProgress({ phase: 'scan', msg: 'Refreshing acquisition feed…', pct: 100 });

    const params = new URLSearchParams({ region_id: region });
    fetch(`${API}/api/bpo_market_scan?${params}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || data?.error) {
          throw new Error(data?.error || 'Failed to load acquisition feed.');
        }
        if (data?.not_ready) {
          throw new Error(data?.message || 'Calculator data is not ready yet.');
        }
        lsSet('bpf_scanResults', data);
        setScanResults(data);
        setScanState('done');
        setScanProgress(null);
      })
      .catch((error) => {
        setScanError(error?.message || 'Failed to load acquisition feed.');
        setScanState('error');
        setScanProgress(null);
      });
  }, [region]);

  const notReady = !listEnabled;
  const walletTotal = scanResults?.wallet_total_isk ?? scanResults?.results?.[0]?.wallet_total_isk ?? 0;

  const filteredScanResults = useMemo(() => {
    if (!scanResults) return [];
    let list = [...scanResults.results];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => (r.name || '').toLowerCase().includes(q));
    }
    if (!showMarket) list = list.filter(r => !r.market_available);
    if (!showContracts) list = list.filter(r => !r.contract_available);
    if (showAffordable && walletTotal > 0) list = list.filter(r => r.affordable !== false && (r.price || 0) <= walletTotal);
    if (!showPersonalOwned) list = list.filter(r => !r.personal_owned);
    if (!showCorpOwned) list = list.filter(r => !r.corp_owned);
    const col = SCAN_COLS.find(c => c.key === scanSortKey);
    const ascending = col?.asc ?? false;
    if (scanSortKey === 'payback_days') {
      list = [...list].sort((a, b) => {
        const av = a.payback_days ?? Infinity;
        const bv = b.payback_days ?? Infinity;
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
  }, [scanResults, search, showMarket, showContracts, showAffordable, showPersonalOwned, showCorpOwned, scanSortKey]);

  const affordableCount = useMemo(
    () => (scanResults?.results || []).filter(r => walletTotal > 0 && (r.price || 0) <= walletTotal).length,
    [scanResults, walletTotal]
  );

  return (
    <div className="bp-finder-panel">



      {/* Header */}
      <div className="bp-finder-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <span className="bp-finder-title">{panelTitle}</span>
            <span className="bp-finder-sub" style={{ marginLeft: 12 }}>
              {panelSubtitle}
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
              >ACQUISITIONS ({scanResults.matched})</button>
            )}
            {/* Load list button */}
            {!listEnabled && (
              <button
                className="chip active"
                onClick={onLoadList}
                title="Load profitable items without an owned blueprint"
              >
                LOAD LIST
              </button>
            )}
            <button
              className="chip"
              onClick={runScan}
              disabled={scanState === 'scanning'}
              title={`Refresh acquisition recommendations for ${REGION_OPTIONS.find(r => r.id === region)?.name}`}
              style={{
                background: scanState === 'scanning' ? 'rgba(255,71,0,0.15)' : undefined,
                borderColor: scanState === 'scanning' ? 'var(--accent)' : undefined,
                color:       scanState === 'scanning' ? 'var(--accent)' : undefined,
              }}
            >
              {scanState === 'scanning' ? 'REFRESHING…' : 'REFRESH FEED'}
            </button>
          </div>
        </div>

        <div className="bp-finder-controls">
          {/* BP Type + Owned filters */}
          <div className="filter-group">
            <span className="filter-label">SHOW</span>
            <div className="filter-options">
              <button
                className={`chip${showMarket ? ' active' : ''}`}
                onClick={() => { if (showContracts) setShowMarket(v => !v); }}
                title={showMarket ? 'Hide market-backed opportunities' : 'Show market-backed opportunities'}
              >MARKET</button>
              <button
                className={`chip${showContracts ? ' active' : ''}`}
                onClick={() => { if (showMarket) setShowContracts(v => !v); }}
                title={showContracts ? 'Hide contract-backed opportunities' : 'Show contract-backed opportunities'}
              >CONTRACT</button>
              <button
                className={`chip${showAffordable ? ' active' : ''}`}
                onClick={() => setShowAffordable(v => !v)}
                title={walletTotal > 0
                  ? (showAffordable ? 'Show results regardless of current wallet balance' : 'Only show results you can currently afford')
                  : 'Wallet balance unavailable'}
                disabled={walletTotal <= 0}
              >AFFORD</button>
              <button
                className={`chip${showPersonalOwned ? ' active' : ''}`}
                onClick={() => setShowPersonalOwned(v => !v)}
                title={showPersonalOwned ? 'Hide blueprints already owned by your characters' : 'Include blueprints already owned by your characters'}
              >PERS</button>
              <button
                className={`chip${showCorpOwned ? ' active' : ''}`}
                onClick={() => setShowCorpOwned(v => !v)}
                title={showCorpOwned ? 'Hide blueprints already owned by the corporation' : 'Include blueprints already owned by the corporation'}
              >CORP</button>
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

        {/* Contract cache warming banner */}
          {cacheStats && (
            <div className={`cache-status-fold ${(!cacheStats.ready && cacheStats.outstanding > 0) ? 'open' : 'closed'}`}>
              <div style={{
                padding: '6px 16px',
                borderBottom: '1px solid rgba(255,153,0,0.2)',
                background: 'rgba(255,153,0,0.06)',
                display: 'flex', alignItems: 'center', gap: 10,
                fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.3,
              }}>
                <span className="scan-label-shimmer" style={{ color: '#ff9900', flexShrink: 0 }}>
                  {cacheStats.warming_up ? '⟳ CACHE WARMING UP' : '⟳ INDEXING CONTRACTS'}
                </span>
                <div style={{ flex: 1, height: 3, background: 'var(--border)', position: 'relative', borderRadius: 2, overflow: 'hidden' }}>
                  {cacheStats.outstanding > 0 && (
                    <div className="eve-bar-glow" style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2,
                      width: `${Math.round((cacheStats.items_fetched / cacheStats.outstanding) * 100)}%`,
                      background: '#ff9900', transition: 'width 1s',
                    }} />
                  )}
                </div>
                <span style={{ color: 'var(--dim)', flexShrink: 0 }}>
                  {cacheStats.items_fetched.toLocaleString()} / {cacheStats.outstanding.toLocaleString()}
                </span>
                {cacheRate > 0 && (
                  <span style={{ color: '#ff9900', flexShrink: 0, fontWeight: 600 }}>
                    ~{Math.round(cacheRate)}/s
                  </span>
                )}
                {cacheRate === 0 && !cacheStats.warming_up && cacheStats.items_pending > 0 && (
                  <span className="scan-label-shimmer" style={{ color: 'var(--dim)', flexShrink: 0 }}>
                    waiting…
                  </span>
                )}
                {cacheEta != null && cacheEta > 0 && (
                  <span style={{ color: 'var(--dim)', flexShrink: 0 }}>
                    ETA ~{cacheEta < 60 ? `${cacheEta}s` : `${Math.ceil(cacheEta / 60)}m`}
                  </span>
                )}
              </div>
            </div>
          )}

        {/* Feed refresh progress */}
        {scanView && scanState === 'scanning' && scanProgress && (
          <div className="scan-progress-panel">
            <div className="scan-progress-header">
              {scanProgress.phase === 'init' || scanProgress.phase == null || scanProgress.phase === 'scan' ? (
                <span className="scan-progress-label scan-label-shimmer">{scanProgress.msg || 'CONNECTING…'}</span>
              ) : (
                <>
                  <span className="scan-progress-label">REFRESHING ACQUISITIONS</span>
                  <span className="scan-progress-stat">
                    ranking market and contract opportunities
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
                  ? (scanResults.message || 'NO BPO ACQUISITION OPPORTUNITIES FOUND')
                  : 'NO OPPORTUNITIES MATCH THE ACTIVE FILTERS'
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
                      key={r.blueprint_id}
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
                          {r.personal_owned && (
                            <span style={{ fontSize: 9, color: '#4cff91', letterSpacing: 1, marginLeft: 4, opacity: 0.8 }}>PERS</span>
                          )}
                          {r.corp_owned && (
                            <span style={{ fontSize: 9, color: '#ffcc66', letterSpacing: 1, marginLeft: 4, opacity: 0.8 }}>CORP</span>
                          )}
                          {showAffordable && walletTotal > 0 && !r.affordable && (
                            <span style={{ fontSize: 9, color: '#ff4444', letterSpacing: 1, marginLeft: 4, fontWeight: 700 }}>OVER WALLET</span>
                          )}
                          {infeasible && (
                            <span style={{ fontSize: 9, color: '#ff4444', letterSpacing: 1, marginLeft: 4, fontWeight: 700 }} title="Cannot recover blueprint cost within available runs">NO PROFIT</span>
                          )}
                        </div>
                      </td>
                      {/* SOURCE */}
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: '1px 5px',
                            borderRadius: 3,
                            background: r.source === 'market' ? 'rgba(76,255,145,0.12)' : 'rgba(255,153,0,0.16)',
                            color: r.source === 'market' ? '#4cff91' : '#ff9900',
                            border: r.source === 'market' ? '1px solid #4cff9160' : '1px solid #ff990060',
                          }}>
                            {r.source === 'market' ? 'MARKET' : 'CONTRACT'}
                          </span>
                          {r.market_available && r.contract_available && (
                            <span style={{ fontSize: 8, color: 'var(--dim)', letterSpacing: 1 }}>BOTH</span>
                          )}
                          {r.contract_available && r.listing_count > 1 && (
                            <span style={{ fontSize: 8, color: 'var(--dim)' }}>{r.listing_count}x</span>
                          )}
                        </div>
                      </td>
                      {/* ME */}
                      <td style={{ color: r.me >= 10 ? '#4cff91' : 'var(--text)' }}>
                        {r.me}
                      </td>
                      {/* TE */}
                      <td style={{ color: r.te >= 20 ? '#4cff91' : 'var(--text)' }}>
                        {r.te}
                      </td>
                      {/* ACQ PRICE */}
                      <td style={{ color: 'var(--accent)', fontWeight: 600 }}>
                        <div>{fmtISK(r.price)}</div>
                        {r.market_available && r.contract_available && (
                          <div style={{ fontSize: 8, color: 'var(--dim)', marginTop: 2 }}>
                            MKT {fmtISK(r.market_price)} · CTR {fmtISK(r.contract_price)}
                          </div>
                        )}
                      </td>
                      {/* PROFIT/RUN */}
                      <td style={{
                        color: adjProfit > 0 ? '#4cff91' : '#ff4444',
                        fontWeight: 600,
                      }}
                        title="Raw manufacturing profit per run from the current calculator context."
                      >
                        {fmtISK(adjProfit)}
                      </td>
                      {/* ROI */}
                      <td style={{ color: adjRoi > 0 ? '#4cff91' : '#ff4444', fontWeight: 600 }}>
                        {adjRoi != null ? `${adjRoi.toFixed(1)}%` : '—'}
                      </td>
                      {/* ISK/HR */}
                      <td>{r.isk_per_hour ? fmtISK(r.isk_per_hour) : '—'}</td>
                      {/* DAILY */}
                      <td style={{
                        color: (r.expected_daily_profit || 0) > 0 ? '#4cff91' : '#ff4444',
                        fontWeight: 600,
                      }}
                        title={`${r.expected_runs_per_day ?? 0} estimated runs/day at demand/build cap`}
                      >
                        {fmtISK(r.expected_daily_profit || 0)}
                      </td>
                      {/* PAYBACK */}
                      <td style={{
                        color: r.payback_days == null                         ? 'var(--dim)'
                             : r.payback_days <= 7                            ? '#4cff91'
                             : r.payback_days <= 30                           ? 'var(--text)'
                             : '#ffcc00',
                        fontWeight: r.payback_days != null ? 600 : undefined,
                      }}
                        title={r.payback_days != null ? `${r.payback_days} estimated days to recover blueprint cost` : 'N/A'}
                      >
                        {r.payback_days != null ? `${r.payback_days.toFixed(1)}d` : '—'}
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
        {!scanView && !listEnabled && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
            {listLoading
              ? 'LOADING CALCULATOR DATA…'
              : <>
                  LIST NOT LOADED
                  <br />
                  <button
                    className="btn"
                    onClick={onLoadList}
                    style={{ marginTop: 14, fontSize: 11 }}
                  >
                    LOAD LIST
                  </button>
                </>
            }
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
              const market = scanResults.results.filter(r => r.market_available).length;
              const contract = scanResults.results.filter(r => r.contract_available).length;
              const pers = scanResults.results.filter(r => r.personal_owned).length;
              const corp = scanResults.results.filter(r => r.corp_owned).length;
              return (
                <>
                  {filteredScanResults.length} / {scanResults.matched} BPO OPPORTUNIT{scanResults.matched !== 1 ? 'IES' : 'Y'}
                  <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
                    · {market} market-backed · {contract} contract-backed
                    {walletTotal > 0 ? ` · ${affordableCount} affordable` : ''}
                    · {pers} personal-owned · {corp} corp-owned
                  </span>
                </>
              );
            })()}
            <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
              · {scanResults.contracts_checked?.toLocaleString()} contracts checked
              {scanResults.pages_scanned > 0 ? ` across ${scanResults.pages_scanned} pages` : ' (local cache)'}
            </span>
            {walletTotal > 0 && (
              <span style={{ color: 'var(--dim)', marginLeft: 8 }}>
                · wallet {fmtISK(walletTotal)}
              </span>
            )}
          </>
        ) : !scanView && !notReady && unownedItems.length > 0 ? (
          <>
            {unownedItems.length} ITEM{unownedItems.length !== 1 ? 'S' : ''} WITHOUT BLUEPRINT
            <span style={{ marginLeft: 12, color: 'var(--dim)' }}>
              click COPY to copy name · EWB for blueprint market · FW for manufactured item market · REFRESH FEED for ranked BPO acquisitions
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
