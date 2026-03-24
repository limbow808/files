import { useState } from 'react';
import { fmtISK, fmtVol } from '../utils/fmt';
import { API } from '../App';

const HUB_ORDER = ['Jita', 'Amarr', 'Dodixie', 'Rens', 'Hek'];

function JumpsBadge({ jumps }) {
  if (jumps == null) return <span className="sb-jumps sb-jumps-unk">?j</span>;
  if (jumps === 0)   return <span className="sb-jumps sb-jumps-zero">here</span>;
  const cls = jumps <= 3 ? 'sb-jumps-close' : jumps <= 8 ? 'sb-jumps-mid' : 'sb-jumps-far';
  return <span className={`sb-jumps ${cls}`}>{jumps}j</span>;
}

function HubTag({ hub, jumps, best }) {
  const cls = best ? 'sb-hub sb-hub-best' : 'sb-hub';
  return (
    <span className={cls}>
      {hub} <JumpsBadge jumps={jumps} />
    </span>
  );
}

export default function SmartBuyPanel({ items, playerSystem, onClose }) {
  const [loading,  setLoading]  = useState(false);
  const [result,   setResult]   = useState(null);
  const [error,    setError]    = useState(null);
  const [expanded, setExpanded] = useState(null); // type_id of expanded row

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch(`${API}/api/shopping/optimal_sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, player_system: playerSystem || '' }),
      });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const summary    = result?.summary;
  const perMat     = result?.per_material || [];
  const hubJumps   = result?.hub_jumps || {};

  const hasSavings = summary && summary.total_savings > 100;

  return (
    <div className="sb-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sb-modal">

        {/* ── Header ── */}
        <div className="sb-header">
          <div className="sb-title">
            <span style={{ color: 'var(--accent)', marginRight: 8 }}>◈</span>
            SMART BUY ANALYSIS
            {playerSystem && (
              <span style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 12, letterSpacing: 1 }}>
                FROM {playerSystem.toUpperCase()}
              </span>
            )}
          </div>
          <button className="sb-close" onClick={onClose}>✕</button>
        </div>

        {/* ── Not yet run ── */}
        {!result && !loading && !error && (
          <div className="sb-idle">
            <p style={{ color: 'var(--dim)', fontSize: 11, letterSpacing: 1, marginBottom: 16, textAlign: 'center' }}>
              Analyses all major trade hubs to find the cheapest place to buy each material,
              factoring in your current location ({playerSystem || 'unknown system'}) and hauling volume.
            </p>
            <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 28px' }} onClick={runAnalysis}>
              ◈ RUN ANALYSIS
            </button>
          </div>
        )}

        {/* ── Loading ── */}
        {loading && (
          <div className="sb-idle">
            <div className="sb-spinner" />
            <div style={{ color: 'var(--dim)', fontSize: 11, letterSpacing: 2, marginTop: 16 }}>
              QUERYING MARKET HUBS…
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {error && !loading && (
          <div className="sb-idle">
            <div style={{ color: 'var(--accent)', fontSize: 11, marginBottom: 16 }}>{error}</div>
            <button className="btn" onClick={runAnalysis} style={{ fontSize: 11 }}>⟳ RETRY</button>
          </div>
        )}

        {/* ── Results ── */}
        {result && !loading && (
          <>
            {/* Summary KPI bar */}
            <div className="sb-kpi-bar">
              <div className="sb-kpi">
                <div className="sb-kpi-label">OPTIMAL COST</div>
                <div className="sb-kpi-val" style={{ color: '#00cc66' }}>
                  {fmtISK(summary.total_optimal_cost)} ISK
                </div>
              </div>
              <div className="sb-kpi">
                <div className="sb-kpi-label">JITA ONLY COST</div>
                <div className="sb-kpi-val" style={{ color: 'var(--dim)' }}>
                  {fmtISK(summary.total_jita_cost)} ISK
                </div>
              </div>
              {hasSavings && (
                <div className="sb-kpi">
                  <div className="sb-kpi-label">SAVINGS</div>
                  <div className="sb-kpi-val" style={{ color: 'var(--accent)' }}>
                    {fmtISK(summary.total_savings)} ISK
                  </div>
                </div>
              )}
              <div className="sb-kpi">
                <div className="sb-kpi-label">HAUL FROM JITA</div>
                <div className="sb-kpi-val">{summary.total_haul_m3.toLocaleString()} m³</div>
              </div>
              <div className="sb-kpi">
                <div className="sb-kpi-label">LOCAL TRIPS</div>
                <div className="sb-kpi-val">{summary.local_trips.length}</div>
              </div>
              <button
                className="btn"
                style={{ marginLeft: 'auto', fontSize: 10, padding: '3px 12px', alignSelf: 'center' }}
                onClick={runAnalysis}
              >⟳ REFRESH</button>
            </div>

            {/* Hub jump distance row */}
            <div className="sb-hub-row">
              <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, marginRight: 10 }}>HUBS</span>
              {HUB_ORDER.map(hub => (
                <span key={hub} className="sb-hub-pill">
                  {hub}
                  {hubJumps[hub] != null
                    ? <span className="sb-hub-j"> {hubJumps[hub] === 0 ? '(here)' : `${hubJumps[hub]}j`}</span>
                    : <span className="sb-hub-j"> —</span>
                  }
                </span>
              ))}
            </div>

            {/* Local trips summary */}
            {summary.local_trips.length > 0 && (
              <div className="sb-trips">
                <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, marginRight: 10 }}>TRIPS</span>
                {summary.local_trips.map(t => (
                  <span key={t.hub} className="sb-trip-pill">
                    <span style={{ color: 'var(--accent)' }}>{t.hub}</span>
                    {t.jumps != null && <span style={{ color: 'var(--dim)' }}> {t.jumps}j</span>}
                    <span style={{ color: 'var(--dim)' }}> · {t.items} mat{t.items !== 1 ? 's' : ''}</span>
                    <span style={{ color: 'var(--text)' }}> · {fmtISK(t.cost)}</span>
                  </span>
                ))}
              </div>
            )}

            {/* Hangar / no-stock callouts */}
            {(summary.materials_in_hangar.length > 0 || summary.materials_no_stock.length > 0) && (
              <div className="sb-callouts">
                {summary.materials_in_hangar.length > 0 && (
                  <div className="sb-callout sb-callout-green">
                    <span style={{ fontSize: 9, letterSpacing: 2, color: '#00cc66' }}>✓ IN HANGAR </span>
                    {summary.materials_in_hangar.join(' · ')}
                  </div>
                )}
                {summary.materials_no_stock.length > 0 && (
                  <div className="sb-callout sb-callout-warn">
                    <span style={{ fontSize: 9, letterSpacing: 2, color: 'var(--accent)' }}>⚠ NO STOCK </span>
                    {summary.materials_no_stock.join(' · ')}
                  </div>
                )}
              </div>
            )}

            {/* Per-material table */}
            <div className="sb-table-wrap">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>MATERIAL</th>
                    <th>QTY</th>
                    <th>VOLUME</th>
                    <th>BEST HUB</th>
                    {HUB_ORDER.map(h => (
                      <th key={h} style={{ color: 'var(--dim)' }}>{h.toUpperCase()}</th>
                    ))}
                    <th>HANGAR</th>
                    <th>OPTIMAL COST</th>
                    <th>JITA COST</th>
                  </tr>
                </thead>
                <tbody>
                  {perMat.map(m => {
                    const isExpanded = expanded === m.type_id;
                    const sourceMap  = Object.fromEntries(m.sources.map(s => [s.hub, s]));
                    return (
                      <tr
                        key={m.type_id}
                        className={`sb-row${m.in_hangar ? ' sb-row-hangar' : ''}${isExpanded ? ' sb-row-expanded' : ''}`}
                        onClick={() => setExpanded(p => p === m.type_id ? null : m.type_id)}
                      >
                        <td className="sb-mat-name">
                          <img
                            className="sb-icon"
                            src={`https://images.evetech.net/types/${m.type_id}/icon?size=32`}
                            alt=""
                            onError={e => { e.target.style.display = 'none'; }}
                          />
                          {m.in_hangar && <span style={{ color: '#00cc66', marginRight: 4 }}>✓</span>}
                          {m.name}
                        </td>
                        <td style={{ color: 'var(--dim)' }}>{fmtVol(m.quantity)}</td>
                        <td style={{ color: 'var(--dim)', fontSize: 10 }}>
                          {m.volume_m3 > 0 ? `${m.volume_m3.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³` : '—'}
                        </td>
                        <td>
                          {m.best_hub
                            ? <HubTag hub={m.best_hub} jumps={hubJumps[m.best_hub]} best />
                            : <span style={{ color: 'var(--dim)' }}>—</span>
                          }
                        </td>
                        {HUB_ORDER.map(h => {
                          const src = sourceMap[h];
                          const isBest = m.best_hub === h;
                          return (
                            <td key={h} style={{
                              color: !src?.has_stock ? '#333'
                                   : isBest        ? '#00cc66'
                                   : 'var(--dim)',
                              fontSize: 11,
                            }}>
                              {src?.has_stock ? fmtISK(src.price) : '—'}
                            </td>
                          );
                        })}
                        <td style={{ color: m.in_hangar ? '#00cc66' : m.hangar_qty > 0 ? '#ccaa00' : 'var(--dim)', fontSize: 11 }}>
                          {m.hangar_qty > 0 ? fmtVol(m.hangar_qty) : '—'}
                        </td>
                        <td style={{ color: m.in_hangar ? '#555' : m.best_hub ? '#00cc66' : 'var(--accent)', fontWeight: 600 }}>
                          {m.in_hangar ? '✓ Stocked' : m.best_total_cost ? fmtISK(m.best_total_cost) : '—'}
                        </td>
                        <td style={{ color: 'var(--dim)' }}>
                          {m.in_hangar ? '—' : m.jita_total_cost ? fmtISK(m.jita_total_cost) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="sb-footer">
              <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 1 }}>
                Prices: Jita from local cache · other hubs via ESI live · jumps via ESI route
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
