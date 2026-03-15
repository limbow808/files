import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import CharTag from './CharTag';
import { charColor } from '../utils/charColors';
import { LoadingState } from './ui';

function OrderTable({ orders, isBuy, multiChar }) {
  if (!orders.length) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
        NO {isBuy ? 'BUY' : 'SELL'} ORDERS
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left',  padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400 }}>ITEM</th>
          <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400 }}>PRICE</th>
          <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400 }}>QTY</th>
          <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400 }}>TOTAL</th>
          {isBuy && <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400 }}>ESCROW</th>}
        </tr>
      </thead>
      <tbody>
        {orders.map((o, idx) => {
          const filled  = ((o.volume_total - o.volume_remain) / o.volume_total * 100).toFixed(0);
          const total   = o.price * o.volume_remain;
          const fillColor = filled >= 75 ? '#00cc66' : filled >= 25 ? 'var(--text)' : 'var(--dim)';
          const cColor  = o.character_id ? charColor(o.character_id) : 'var(--dim)';
          return (
            <tr key={o.order_id} className="eve-row-reveal" style={{ borderBottom: '1px solid #0d0d0d', animationDelay: `${idx * 25}ms` }}>
              <td style={{ padding: '5px 8px', textAlign: 'left' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5 }}>{o.type_name}</div>
                <div style={{ height: 2, background: '#111', marginTop: 2, width: 60 }}>
                  <div style={{ height: '100%', width: `${filled}%`, background: isBuy ? '#4da6ff' : 'var(--accent)' }} />
                </div>
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
  const [tab, setTab] = useState('sell');

  const sell = data?.sell || [];
  const buy  = data?.buy  || [];

  // Detect multi-character
  const allOrders = [...sell, ...buy];
  const uniqueChars = new Set(allOrders.map(o => o.character_id).filter(Boolean));
  const multiChar = uniqueChars.size > 1;

  const sellTotal = sell.reduce((s, o) => s + o.price * o.volume_remain, 0);
  const buyEscrow = buy.reduce((s,  o) => s + (o.escrow || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div className="panel-hdr" style={{ gap: 0, padding: 0, paddingRight: 14 }}>
        <div style={{ display: 'flex' }}>
          {['sell', 'buy'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tab-btn${tab === t ? ' active' : ''}`}
            >
              {t === 'sell' ? `◈ Sell Orders (${sell.length})` : `◈ Buy Orders (${buy.length})`}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          {tab === 'sell'
            ? `TOTAL VALUE  ${fmtISK(sellTotal)} ISK`
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
          <OrderTable orders={tab === 'sell' ? sell : buy} isBuy={tab === 'buy'} multiChar={multiChar} />
        )}
      </div>
    </div>
  );
}
