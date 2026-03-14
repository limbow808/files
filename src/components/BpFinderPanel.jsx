import { useState, useMemo } from 'react';
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
  const [openingId,  setOpeningId]  = useState(null);
  const [openResult, setOpenResult] = useState({});  // type_id → 'ok' | 'err'
  const [search,     setSearch]     = useState('');
  const [limit,      setLimit]      = useState(50);

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
    if (blueprintId) {
      return `https://www.eveworkbench.com/contracts?type_id=${blueprintId}&region_id=${region}`;
    }
    return `https://www.eveworkbench.com/contracts?search=${encodeURIComponent(name + ' Blueprint')}&region_id=${region}`;
  }

  async function openInGame(blueprintId, outputId) {
    const typeId = blueprintId || outputId;
    if (!typeId) return;
    setOpeningId(typeId);
    try {
      const res = await fetch(`${API}/api/ui/open_ingame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type_id: typeId, window: 'market' }),
      });
      const json = await res.json();
      setOpenResult(prev => ({ ...prev, [typeId]: json.ok ? 'ok' : 'err' }));
      setTimeout(() => setOpenResult(prev => { const n = { ...prev }; delete n[typeId]; return n; }), 3000);
    } catch {
      setOpenResult(prev => ({ ...prev, [typeId]: 'err' }));
    } finally {
      setOpeningId(null);
    }
  }

  const notReady = calcResults.length === 0;

  return (
    <div className="bp-finder-panel">
      {/* Header */}
      <div className="bp-finder-header">
        <span className="bp-finder-title">◈ BP FINDER</span>
        <span className="bp-finder-sub">Profitable items with no owned blueprint — find them on contracts</span>

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

          {/* Region for links */}
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
      <div className="bp-finder-body">
        {notReady && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
            WAITING FOR MARKET DATA — prices load automatically on the Calculator tab
          </div>
        )}
        {!notReady && unownedItems.length === 0 && (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
            NO ITEMS — all profitable items already have blueprints
          </div>
        )}
        {!notReady && unownedItems.length > 0 && (
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
              {unownedItems.map(r => {
                const typeId = r.blueprint_id || r.output_id;
                const isOpening = openingId === typeId;
                const openStatus = openResult[typeId];

                return (
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
                          {copiedId === r.output_id && (
                            <span className="copy-flash"> ✓</span>
                          )}
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
                        {/* Copy blueprint name */}
                        <button
                          className="bp-action-btn"
                          title={`Copy "${r.name} Blueprint" to clipboard`}
                          onClick={() => copyName(r.name + ' Blueprint', r.output_id)}
                        >
                          {copiedId === r.output_id ? '✓' : '📋'}
                        </button>

                        {/* Open contracts in browser (Eve Workbench) */}
                        <a
                          className="bp-action-btn bp-action-link"
                          href={contractsUrl(r.blueprint_id, r.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Search contracts on Eve Workbench"
                        >
                          🔍
                        </a>

                        {/* Open market window in EVE client via ESI */}
                        <button
                          className={`bp-action-btn${openStatus === 'ok' ? ' bp-action-ok' : openStatus === 'err' ? ' bp-action-err' : ''}`}
                          title="Open market details in EVE client (requires EVE to be running)"
                          onClick={() => openInGame(r.blueprint_id, r.output_id)}
                          disabled={isOpening}
                        >
                          {isOpening ? '…' : openStatus === 'ok' ? '✓' : openStatus === 'err' ? '✗' : '▶'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer count */}
      {!notReady && unownedItems.length > 0 && (
        <div className="bp-finder-footer">
          {unownedItems.length} ITEM{unownedItems.length !== 1 ? 'S' : ''} WITHOUT BLUEPRINT
          <span style={{ marginLeft: 12, color: 'var(--dim)' }}>
            click 📋 to copy name · 🔍 to search contracts on Eve Workbench · ▶ to open in EVE
          </span>
        </div>
      )}
    </div>
  );
}
