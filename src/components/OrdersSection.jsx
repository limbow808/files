import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import CharTag from './CharTag';
import { charColor } from '../utils/charColors';
import { LoadingState } from './ui';

function OrderTable({ orders, isBuy, multiChar, sellHistByTypeId }) {
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
        <tr>
          <th style={{ textAlign: 'left',  padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400, width: '42%' }}>ITEM</th>
          <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400, width: '18%' }}>PRICE</th>
          <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400, width: '20%' }}>QTY</th>
          <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400, width: '13%' }}>ISK</th>
          {!isBuy && <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400, width: '7%' }}>POS</th>}
          {isBuy && <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400, width: '7%' }}>ESCROW</th>}
        </tr>
      </thead>
      <tbody>
        {orders.map((o, idx) => {
          const filled  = ((o.volume_total - o.volume_remain) / o.volume_total * 100).toFixed(0);
          const total   = o.price * o.volume_remain;
          const fillColor = filled >= 75 ? '#00cc66' : filled >= 25 ? 'var(--text)' : 'var(--dim)';
          const cColor  = o.character_id ? charColor(o.character_id) : 'var(--dim)';
          const hist    = !isBuy && sellHistByTypeId ? sellHistByTypeId[o.type_id] : null;
          const avgDays = hist?.avg_days_to_sell ?? null;
          return (
            <tr key={o.order_id} className="eve-row-reveal" style={{ borderBottom: '1px solid #0d0d0d', animationDelay: `${idx * 25}ms` }}>
              <td style={{ padding: '5px 8px', textAlign: 'left' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.type_name}>{o.type_name}</div>
                <div style={{ height: 2, background: '#111', marginTop: 2, width: 60 }}>
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
                      <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 0.5 }}
                        title={`${o.competitor_count} total sell listings in Jita`}>
                        {o.competitor_count} listed
                      </span>
                    )}
                  </div>
                )}
                {multiChar && o.character_name && (
                  <div style={{ marginTop: 3 }}>
                    <CharTag name={o.character_name} color={cColor} />
                  </div>
                )}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>
                {fmtISK(o.price)}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 11, color: fillColor }}>
                {new Intl.NumberFormat('en-US').format(o.volume_remain)}
                <span style={{ color: 'var(--dim)', fontSize: 10 }}> / {new Intl.NumberFormat('en-US').format(o.volume_total)}</span>
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: isBuy ? '#4da6ff' : 'var(--accent)' }}>
                {fmtISK(total)}
              </td>
              {!isBuy && (() => {
                const pos = o.market_position;
                const color = pos === 0   ? '#4cff91'
                            : pos === null ? 'var(--dim)'
                            : pos <= 3    ? '#ffcc00'
                            : '#ff6644';
                const label = pos === null ? '—'
                            : pos === 0   ? '#1'
                            : `+${pos}`;
                return (
                  <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color }}
                    title={pos === 0 ? 'Lowest price — top of book' : pos === null ? 'No market data' : `${pos} cheaper listing${pos === 1 ? '' : 's'} ahead`}>
                    {label}
                  </td>
                );
              })()}
              {isBuy && (
                <td style={{ padding: '5px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
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

export default function OrdersSection() {
  const { data, loading, error } = useApi('/api/orders');
  const { data: sellHistData }   = useApi('/api/sell_history');
  const [tab, setTab] = useState('sell');

  const sell = data?.sell || [];
  const buy  = data?.buy  || [];

  // Build type_id → sell-history lookup for row annotations
  const sellHistByTypeId = {};
  for (const stat of Object.values(sellHistData?.by_item || {})) {
    if (stat.type_id != null) sellHistByTypeId[stat.type_id] = stat;
  }

  // Detect multi-character
  const allOrders = [...sell, ...buy];
  const uniqueChars = new Set(allOrders.map(o => o.character_id).filter(Boolean));
  const multiChar = uniqueChars.size > 1;

  const sellTotal = sell.reduce((s, o) => s + o.price * o.volume_remain, 0);
  const buyEscrow = buy.reduce((s,  o) => s + (o.escrow || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header — 26 px tall */}
      <div className="panel-hdr" style={{ gap: 0, padding: 0, paddingRight: 10, height: 26, minHeight: 26, flexShrink: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>
          {['sell', 'buy'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tab-btn${tab === t ? ' active' : ''}`}
              style={{ fontSize: 9, letterSpacing: 1, padding: '0 10px', height: '100%', whiteSpace: 'nowrap' }}
            >
              {t === 'sell' ? `Sell (${sell.length})` : `Buy (${buy.length})`}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {tab === 'sell'
            ? `>TOTAL ${fmtISK(sellTotal)} ISK` 
            : `ESCROW  ${fmtISK(buyEscrow)} ISK`}
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <LoadingState label="FETCHING ORDERS" sub="ESI · MARKET" />
        ) : (
          <OrderTable
            orders={tab === 'sell' ? sell : buy}
            isBuy={tab === 'buy'}
            multiChar={multiChar}
            sellHistByTypeId={sellHistByTypeId}
          />
        )}
      </div>
    </div>
  );
}
