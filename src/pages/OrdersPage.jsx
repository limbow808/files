import { useState, useMemo, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import CharTag from '../components/CharTag';
import { charColor } from '../utils/charColors';
import { LoadingState } from '../components/ui';
import { API } from '../App';

function FullOrderTable({ orders, isBuy, multiChar, sellHistByTypeId, scanMap }) {
  if (!orders.length) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
        NO {isBuy ? 'BUY' : 'SELL'} ORDERS
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <thead>
        <tr style={{ background: 'var(--table-row-bg)' }}>
          <th style={{ textAlign: 'left',  padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '30%' }}>ITEM</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '12%' }}>PRICE</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '14%' }}>QTY</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '13%' }}>REVENUE</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '11%', title: 'Manufacturing ROI from last calculator run' }}>MFG ROI</th>
          {!isBuy && <th style={{ textAlign: 'right', padding: '4px 12px 4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '10%' }}>POS</th>}
          {isBuy  && <th style={{ textAlign: 'right', padding: '4px 12px 4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '10%' }}>ESCROW</th>}
        </tr>
      </thead>
      <tbody>
        {orders.map((o, idx) => {
          const filled    = ((o.volume_total - o.volume_remain) / o.volume_total * 100).toFixed(0);
          const revenue   = o.price * o.volume_remain;
          const fillColor = filled >= 75 ? '#00cc66' : filled >= 25 ? 'var(--text)' : 'var(--dim)';
          const cColor    = o.character_id ? charColor(o.character_id) : 'var(--dim)';
          const hist      = !isBuy && sellHistByTypeId ? sellHistByTypeId[o.type_id] : null;
          const avgDays   = hist?.avg_days_to_sell ?? null;
          const scanItem  = scanMap?.[o.type_id];
          const roi       = scanItem?.roi ?? null;
          const roiColor  = roi == null ? 'var(--dim)' : roi >= 15 ? '#4cff91' : roi >= 5 ? 'var(--accent)' : '#ff6644';

          return (
            <tr key={o.order_id} className="eve-row-reveal" style={{ position: 'relative', borderBottom: '1px solid #0d0d0d', background: 'var(--table-row-bg)', animationDelay: `${idx * 25}ms` }}>
              <td style={{ padding: '4px 6px', textAlign: 'left' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.type_name}>{o.type_name}</div>
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--bg)', pointerEvents: 'none', zIndex: 0 }}>
                  <div style={{ height: '100%', width: `${filled}%`, background: isBuy ? '#4da6ff' : 'var(--accent)' }} />
                </div>
                {!isBuy && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                    {avgDays != null && (
                      <span style={{ fontSize: 9, color: avgDays <= 3 ? '#4cff91' : avgDays >= 14 ? '#ff6644' : 'var(--dim)', letterSpacing: 0.5 }}
                        title={`Avg sell time: ${avgDays.toFixed(1)} days`}>
                        {avgDays.toFixed(1)}d
                      </span>
                    )}
                    {o.competitor_count > 0 && (
                      <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 0.5 }}>{o.competitor_count} listed</span>
                    )}
                  </div>
                )}
                {multiChar && o.character_name && (
                  <div style={{ marginTop: 3 }}>
                    <CharTag name={o.character_name} color={cColor} />
                  </div>
                )}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>
                {fmtISK(o.price)}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontSize: 11, color: fillColor }}>
                {new Intl.NumberFormat('en-US').format(o.volume_remain)}
                <span style={{ color: 'var(--dim)', fontSize: 10 }}> / {new Intl.NumberFormat('en-US').format(o.volume_total)}</span>
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: isBuy ? '#4da6ff' : 'var(--accent)' }}>
                {fmtISK(revenue)}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: roiColor }}>
                {roi != null ? `${roi.toFixed(1)}%` : '\u2014'}
              </td>
              {!isBuy && (() => {
                const pos = o.market_position;
                const trend = o.market_position_trend;
                const color = pos === 0   ? '#4cff91'
                            : pos === null ? 'var(--dim)'
                            : pos <= 3    ? '#ffcc00'
                            : '#ff6644';
                const label = pos === null ? '\u2014' : pos === 0 ? '#1' : `+${pos}`;
                const trendGlyph = trend === 'increasing' ? '\u25B2' : trend === 'decreasing' ? '\u25BC' : '';
                const trendColor = trend === 'decreasing' ? '#4cff91' : trend === 'increasing' ? '#ff6644' : 'var(--dim)';
                return (
                  <td style={{ padding: '4px 12px 4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color, whiteSpace: 'nowrap' }}>
                    {label}
                    {trendGlyph && <span style={{ marginLeft: 4, color: trendColor, fontSize: 10 }}>{trendGlyph}</span>}
                  </td>
                );
              })()}
              {isBuy && (
                <td style={{ padding: '4px 12px 4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
                  {fmtISK(o.escrow)}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default memo(function OrdersSection() {
  const { data, loading, error } = useApi(`${API}/api/orders`);
  const { data: sellHistData }   = useApi(`${API}/api/sell_history`);
  const { data: scanData }       = useApi(`${API}/api/scan`);
  const [tab, setTab] = useState('sell');

  const sell = data?.sell || [];
  const buy  = data?.buy  || [];

  const sellHistByTypeId = {};
  for (const stat of Object.values(sellHistData?.by_item || {})) {
    if (stat.type_id != null) sellHistByTypeId[stat.type_id] = stat;
  }

  // Build type_id → scan result lookup for MFG ROI column
  const scanMap = useMemo(() => {
    const m = {};
    (scanData?.results || []).forEach(r => { if (r.output_id) m[r.output_id] = r; });
    return m;
  }, [scanData]);

  const allOrders  = [...sell, ...buy];
  const uniqueChars = new Set(allOrders.map(o => o.character_id).filter(Boolean));
  const multiChar  = uniqueChars.size > 1;

  const sellTotal  = sell.reduce((s, o) => s + o.price * o.volume_remain, 0);
  const buyEscrow  = buy.reduce((s, o) => s + (o.escrow || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div className="panel-hdr" style={{ gap: 0, padding: 0, paddingRight: 10, height: 34, minHeight: 34, flexShrink: 0, overflow: 'hidden', borderBottom: 'none' }}>
        <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
          {['sell', 'buy'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tab-btn${tab === t ? ' active' : ''}`}
              style={{ fontSize: 12, letterSpacing: 1, padding: '0 14px', height: '100%', whiteSpace: 'nowrap' }}
            >
              {t === 'sell' ? `Sell (${sell.length})` : `Buy (${buy.length})`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: 1, whiteSpace: 'nowrap', paddingRight: 4, alignSelf: 'center' }}>
          {tab === 'sell'
            ? `TOTAL ${fmtISK(sellTotal)} ISK`
            : `ESCROW ${fmtISK(buyEscrow)} ISK`}
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>
          {'\u26A0'} ESI UNAVAILABLE
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <LoadingState label="FETCHING ORDERS" sub="ESI \u00B7 MARKET" />
        ) : (
          <FullOrderTable
            orders={tab === 'sell' ? sell : buy}
            isBuy={tab === 'buy'}
            multiChar={multiChar}
            sellHistByTypeId={sellHistByTypeId}
            scanMap={scanMap}
          />
        )}
      </div>
    </div>
  );
});
