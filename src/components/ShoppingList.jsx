import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK, fmtVol } from '../utils/fmt';
import { API } from '../App';
import SmartBuyPanel from './SmartBuyPanel';

export default function ShoppingList({ checkedItems, overrides, playerSystem }) {
  const [collapsed,      setCollapsed]      = useState(false);
  const [copyMode,       setCopyMode]       = useState('delta');
  const [copied,         setCopied]         = useState(false);
  const [showSmartBuy,   setShowSmartBuy]   = useState(false);

  const { data: assetsData } = useApi(`${API}/api/assets`, []);
  const warehouse  = assetsData?.assets || {};
  const assetNames = assetsData?.names  || {};

  const { data: esiBpData } = useApi(`${API}/api/blueprints/esi`, []);
  const esiBpIds = new Set((esiBpData?.blueprints || []).map(b => b.type_id));

  // Aggregate materials across all checked items
  const matMap = {};
  for (const item of checkedItems) {
    const runs = overrides[item.output_id]?.runs ?? 1;
    const mats = item.material_breakdown || [];
    for (const m of mats) {
      const tid = String(m.type_id);
      if (!matMap[tid]) {
        matMap[tid] = {
          type_id:    m.type_id,
          name:       m.name || assetNames[tid] || `Type ${m.type_id}`,
          required:   0,
          unit_price: m.unit_price || 0,
          volume_m3:  m.volume_m3 || 0,
        };
      }
      matMap[tid].required += (m.quantity || 0) * runs;
    }

    // Blueprint check
    const hasBp  = esiBpIds.has(item.output_id);
    if (!hasBp && esiBpData) {
      const bpKey = `bp_${item.output_id}`;
      if (!matMap[bpKey]) {
        matMap[bpKey] = {
          type_id:      null,
          name:         `${item.name} Blueprint`,
          required:     runs,
          unit_price:   0,
          is_blueprint: true,
          missing_bp:   true,
        };
      } else {
        matMap[bpKey].required += runs;
      }
    }
  }

  const matRows = Object.values(matMap).sort((a, b) => {
    if (a.missing_bp && !b.missing_bp) return -1;
    if (!a.missing_bp && b.missing_bp)  return  1;
    return a.name.localeCompare(b.name);
  });

  function getWarehouse(tid) {
    if (!tid) return 0;
    return warehouse[String(tid)] || warehouse[tid] || 0;
  }

  function buildCopyText(mode) {
    return matRows
      .filter(m => !m.missing_bp)
      .map(m => {
        const have  = getWarehouse(m.type_id);
        const delta = Math.max(0, m.required - have);
        const qty   = mode === 'delta' ? delta : m.required;
        if (qty <= 0) return null;
        return `${m.name} ${qty}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  function handleCopy() {
    const text = buildCopyText(copyMode);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const totalRequired = matRows
    .filter(m => !m.missing_bp)
    .reduce((s, m) => s + m.required * m.unit_price, 0);
  const totalDeltaCost = matRows
    .filter(m => !m.missing_bp)
    .reduce((s, m) => s + Math.max(0, m.required - getWarehouse(m.type_id)) * m.unit_price, 0);
  const totalRequiredM3 = matRows
    .filter(m => !m.missing_bp)
    .reduce((s, m) => s + (m.volume_m3 || 0) * m.required, 0);
  const totalDeltaM3 = matRows
    .filter(m => !m.missing_bp)
    .reduce((s, m) => s + (m.volume_m3 || 0) * Math.max(0, m.required - getWarehouse(m.type_id)), 0);
  const hasWarehouse = Object.keys(warehouse).length > 0;

  return (
    <div className={`calc-bottom${collapsed ? ' calc-bottom-collapsed' : ''}`}>

      {/* Header / toggle */}
      <div className="shopping-hdr" onClick={() => setCollapsed(v => !v)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 3, color: 'var(--text)' }}>
            ◈ SHOPPING LIST
          </span>
          {checkedItems.length > 0 ? (
            <span style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: 1 }}>
              {checkedItems.length} ITEM{checkedItems.length !== 1 ? 'S' : ''} CHECKED
            </span>
          ) : (
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
              CHECK ROWS ABOVE TO BUILD A SHOPPING LIST
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {!collapsed && checkedItems.length > 0 && (
            <>
              <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
                TOTAL REQUIRED:{' '}
                <span style={{ color: 'var(--text)' }}>{fmtISK(totalRequired)} ISK</span>
              </span>
              {totalRequiredM3 > 0 && (
                <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
                  TOTAL M³:{' '}
                  <span style={{ color: 'var(--text)' }}>{totalRequiredM3.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³</span>
                </span>
              )}
              {hasWarehouse && (
                <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
                  STILL TO BUY:{' '}
                  <span style={{ color: 'var(--accent)' }}>{fmtISK(totalDeltaCost)} ISK</span>
                </span>
              )}
              {hasWarehouse && totalDeltaM3 > 0 && (
                <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
                  TO HAUL:{' '}
                  <span style={{ color: 'var(--accent)' }}>{totalDeltaM3.toLocaleString(undefined, { maximumFractionDigits: 1 })} m³</span>
                </span>
              )}
            </>
          )}
          <span style={{ fontSize: 11, color: 'var(--dim)' }}>{collapsed ? '▼' : '▲'}</span>
        </div>
      </div>

      {!collapsed && checkedItems.length > 0 && (
        <>
          <div className="shopping-body">
            {/* Left: checked items */}
            <div className="shopping-items">
              <div style={{ padding: '4px 12px 2px', fontSize: 9, color: 'var(--dim)', letterSpacing: 2, textTransform: 'uppercase' }}>
                Queued Items
              </div>
              {checkedItems.map(item => {
                const runs = overrides[item.output_id]?.runs ?? 1;
                return (
                  <div key={item.output_id} className="shopping-item-row">
                    <span className="shopping-item-name">{item.name}</span>
                    <span className="shopping-item-runs">×{runs}</span>
                  </div>
                );
              })}
            </div>

            {/* Right: aggregated materials */}
            <div className="shopping-mats">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>MATERIAL</th>
                    <th>REQUIRED QTY</th>
                    <th>TOTAL M³</th>
                    <th>UNIT PRICE</th>
                    <th>VALUE</th>
                    <th>WAREHOUSE</th>
                    <th>DELTA QTY</th>
                    <th>DELTA COST</th>
                  </tr>
                </thead>
                <tbody>
                  {matRows.map((m, i) => {
                    const have      = getWarehouse(m.type_id);
                    const delta     = Math.max(0, m.required - have);
                    const deltaCost = delta * m.unit_price;
                    const value     = m.required * m.unit_price;
                    const isMissing = delta > 0;
                    return (
                      <tr key={i} style={{ opacity: m.missing_bp ? 0.7 : 1 }}>
                        <td style={{
                          textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 1,
                          color: m.missing_bp ? 'var(--accent)' : 'var(--text)',
                        }}>
                          {m.missing_bp && <span style={{ marginRight: 6, color: 'var(--accent)' }}>⚠</span>}
                          {m.name}
                        </td>
                        <td>{fmtVol(m.required)}</td>
                        <td style={{ color: 'var(--dim)' }}>
                          {m.volume_m3 > 0
                            ? (m.volume_m3 * m.required).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' m³'
                            : '—'}
                        </td>
                        <td style={{ color: 'var(--dim)' }}>{m.unit_price > 0 ? fmtISK(m.unit_price) : '—'}</td>
                        <td>{value > 0 ? fmtISK(value) : '—'}</td>
                        <td style={{ color: have > 0 ? '#00cc66' : 'var(--dim)' }}>
                          {hasWarehouse ? fmtVol(have) : '—'}
                        </td>
                        <td style={{ color: isMissing ? 'var(--accent)' : '#00cc66' }}>
                          {hasWarehouse ? (delta > 0 ? fmtVol(delta) : '✓ Stocked') : fmtVol(m.required)}
                        </td>
                        <td style={{ color: isMissing ? 'var(--accent)' : 'var(--dim)' }}>
                          {hasWarehouse ? (deltaCost > 0 ? fmtISK(deltaCost) : '—') : fmtISK(value)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Copy bar */}
          <div className="shopping-copy-bar">
            <span className="copy-label">COPY MODE</span>
            <button
              className={`btn${copyMode === 'required' ? ' btn-primary' : ''}`}
              style={{ fontSize: 10, padding: '2px 10px' }}
              onClick={() => setCopyMode('required')}
            >REQUIRED QTY</button>
            <button
              className={`btn${copyMode === 'delta' ? ' btn-primary' : ''}`}
              style={{ fontSize: 10, padding: '2px 10px' }}
              onClick={() => setCopyMode('delta')}
            >DELTA QTY</button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 10, padding: '2px 14px', marginLeft: 8 }}
              onClick={handleCopy}
            >
              {copied ? '✓ COPIED' : '⎘ COPY FOR MULTI-BUY'}
            </button>
            <button
              className="btn btn-smart-buy"
              style={{ fontSize: 10, padding: '2px 14px', marginLeft: 4 }}
              onClick={() => setShowSmartBuy(true)}
              title="Find the cheapest market hub for each material, accounting for jumps and haul volume"
            >
              ◈ SMART BUY
            </button>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginLeft: 'auto' }}>
              Paste into EVE Online → Market → Multi-Buy
            </span>
          </div>

          {showSmartBuy && (
            <SmartBuyPanel
              items={matRows
                .filter(m => !m.missing_bp)
                .map(m => ({
                  type_id:  m.type_id,
                  name:     m.name,
                  quantity: Math.max(0, m.required - getWarehouse(m.type_id)),
                }))
                .filter(m => m.quantity > 0)
              }
              playerSystem={playerSystem || ''}
              onClose={() => setShowSmartBuy(false)}
            />
          )}
        </>
      )}

      {!collapsed && checkedItems.length === 0 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
          CHECK ITEMS IN THE TABLE ABOVE TO BUILD A SHOPPING LIST
        </div>
      )}
    </div>
  );
}
