import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import { LoadingState } from './ui';

const MINERAL_ORDER = ['Tritanium','Pyerite','Mexallon','Isogen','Nocxium','Zydrine','Megacyte','Morphite'];
const ORE_ORDER     = ['Veldspar','Scordite','Pyroxeres','Kernite','Omber','Jaspet',
                       'Hemorphite','Hedbergite','Gneiss','Dark Ochre','Bistot','Crokite',
                       'Spodumain','Arkonor','Mercoxit'];

const TREND_ICON  = { up: '▲', down: '▼', flat: '→' };
const TREND_COLOR = { up: '#00cc66', down: '#cc3333', flat: '#444' };

const ORE_COLS = [
  { key: 'name',       label: 'ORE',    align: 'left'  },
  { key: 'sell',       label: 'SELL',   align: 'right' },
  { key: 'isk_per_m3', label: 'ISK/M³', align: 'right' },
  { key: 'buy_per_m3', label: 'BUY/M³', align: 'right' },
];

export default function MineralsSection() {
  const { data, loading, error } = useApi('/api/minerals');
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState(1);   // 1 = asc, -1 = desc

  const minerals = data?.minerals || {};
  const ores     = data?.ores     || {};

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => -d);
    else { setSortCol(col); setSortDir(1); }
  }

  const sortedOres = ORE_ORDER
    .map(name => ({ name, ...ores[name] }))
    .sort((a, b) => {
      const av = sortCol === 'name' ? a.name : (a[sortCol] || 0);
      const bv = sortCol === 'name' ? b.name : (b[sortCol] || 0);
      return typeof av === 'string'
        ? av.localeCompare(bv) * sortDir
        : (av - bv) * sortDir;
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Single header */}
      <div className="panel-hdr">
        <span className="panel-title">◈ MINERALS &amp; ORES</span>
        {error && !data && (
          <span style={{ fontSize: 10, color: '#ff4444', letterSpacing: 1 }}>⚠ ESI UNAVAILABLE</span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <LoadingState label="FETCHING PRICES" sub="ESI · MARKET" />
        ) : (
          <>
            {/* ── Minerals ── */}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1,
                               borderBottom: '1px solid var(--border)', fontWeight: 400, position: 'sticky', top: 0, background: '#000', zIndex: 1 }}>MINERAL</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1,
                               borderBottom: '1px solid var(--border)', fontWeight: 400, position: 'sticky', top: 0, background: '#000', zIndex: 1 }}>SELL</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1,
                               borderBottom: '1px solid var(--border)', fontWeight: 400, position: 'sticky', top: 0, background: '#000', zIndex: 1 }}>BUY</th>
                </tr>
              </thead>
              <tbody>
                {MINERAL_ORDER.map((name, i) => {
                  const m = minerals[name];
                  return (
                    <tr key={name} className="eve-row-reveal" style={{
                      borderBottom: '1px solid #0d0d0d',
                      background: i % 2 === 0 ? '#030303' : '#050505',
                      animationDelay: `${i * 30}ms`,
                    }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.5, textAlign: 'left' }}>{name}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right' }}>{m ? fmtISK(m.sell) : '—'}</td>
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>{m ? fmtISK(m.buy) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* ── Base Ores divider ── */}
            <div style={{
              padding: '4px 8px', fontSize: 9, letterSpacing: 1, color: 'var(--dim)',
              borderBottom: '1px solid var(--border)', borderTop: '1px solid var(--border)',
              background: '#030303', position: 'sticky', top: 0, zIndex: 2,
            }}>BASE ORES</div>

            {/* ── Ores table ── */}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {ORE_COLS.map(({ key, label, align }) => {
                    const active = sortCol === key;
                    return (
                      <th
                        key={key}
                        onClick={() => handleSort(key)}
                        style={{
                          padding: '4px 8px', fontSize: 9, letterSpacing: 1,
                          borderBottom: '1px solid var(--border)',
                          textAlign: align,
                          position: 'sticky', top: 21, background: '#000', zIndex: 1,
                          cursor: 'pointer', userSelect: 'none',
                          color: active ? 'var(--text)' : 'var(--dim)',
                          fontWeight: 400,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {label}{active ? <span style={{ marginLeft: 3 }}>{sortDir === 1 ? '▲' : '▼'}</span> : <span style={{ marginLeft: 3, opacity: 0.25 }}>▲</span>}
                      </th>
                    );
                  })}
                  <th style={{
                    padding: '4px 6px', fontSize: 9, letterSpacing: 1, color: 'var(--dim)',
                    borderBottom: '1px solid var(--border)', textAlign: 'center', fontWeight: 400,
                    position: 'sticky', top: 21, background: '#000', zIndex: 1,
                  }}>TREND</th>
                </tr>
              </thead>
              <tbody>
                {sortedOres.map((o, i) => {
                  const trend = o.trend || 'flat';
                  return (
                    <tr key={o.name} style={{
                      borderBottom: '1px solid #0d0d0d',
                      background: i % 2 === 0 ? '#030303' : '#050505',
                    }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.5, textAlign: 'left' }}>{o.name}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10 }}>{o.sell != null ? fmtISK(o.sell) : '—'}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)' }}>{o.isk_per_m3 != null ? fmtISK(o.isk_per_m3) : '—'}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>{o.buy_per_m3 != null ? fmtISK(o.buy_per_m3) : '—'}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 10, color: TREND_COLOR[trend] }}
                          title={o.trend_pct != null ? `${o.trend_pct > 0 ? '+' : ''}${o.trend_pct}%` : ''}>
                        {TREND_ICON[trend]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
