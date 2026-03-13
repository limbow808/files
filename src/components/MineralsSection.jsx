import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';

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
  const [tab, setTab]         = useState('minerals');
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
      {/* Tab strip — both buttons equal width, filling the header */}
      <div className="panel-hdr" style={{ padding: 0, flexShrink: 0 }}>
        {['minerals','ores'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`tab-btn${tab === t ? ' active' : ''}`}
            style={{ flex: 1 }}
          >
            {t === 'minerals' ? '◈ Minerals' : '◈ Base Ores'}
          </button>
        ))}
      </div>

      {/* ESI error banner */}
      {error && !data && (
        <div style={{ padding: '12px 16px', fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      {tab === 'minerals' ? (
        /* Compact two-column list: name on left, sell price right, buy dim below */
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {(loading && !data ? MINERAL_ORDER : MINERAL_ORDER).map((name, i) => {
            const m = data ? minerals[name] : null;
            return (
              <div key={name} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '5px 12px',
                borderBottom: '1px solid #0d0d0d',
                background: i % 2 === 0 ? '#030303' : '#050505',
              }}>
                <span style={{ fontFamily: 'var(--head)', fontSize: 11, letterSpacing: 1, color: 'var(--text)' }}>
                  {name}
                </span>
                <div style={{ textAlign: 'right' }}>
                  {loading && !data ? (
                    <>
                      <div><span className="skeleton-line" style={{ width: 52 }} /></div>
                      <div style={{ marginTop: 3 }}><span className="skeleton-line" style={{ width: 38 }} /></div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)' }}>
                        {m ? fmtISK(m.sell) : '—'}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>
                        ▼ {m ? fmtISK(m.buy) : '—'}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
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
                        padding: '5px 8px', fontSize: 9, letterSpacing: 2,
                        borderBottom: '1px solid var(--border)',
                        textAlign: align,
                        position: 'sticky', top: 0, background: '#000', zIndex: 1,
                        cursor: 'pointer', userSelect: 'none',
                        color: active ? 'var(--text)' : 'var(--dim)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {label}
                      {active
                        ? <span style={{ marginLeft: 4 }}>{sortDir === 1 ? '▲' : '▼'}</span>
                        : <span style={{ marginLeft: 4, opacity: 0.3 }}>▲</span>
                      }
                    </th>
                  );
                })}
                {/* Trend column header */}
                <th style={{
                  padding: '5px 6px', fontSize: 9, letterSpacing: 2, color: 'var(--dim)',
                  borderBottom: '1px solid var(--border)', textAlign: 'center',
                  position: 'sticky', top: 0, background: '#000', zIndex: 1,
                }}>TREND</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data
                ? ORE_ORDER.map((name, i) => (
                    <tr key={name} className="skeleton-row" style={{ background: i % 2 === 0 ? '#030303' : '#050505' }}>
                      {[1,2,3,4,5].map(j => <td key={j}>&nbsp;</td>)}
                    </tr>
                  ))
                : sortedOres.map((o, i) => {
                  const trend = o.trend || 'flat';
                  return (
                    <tr key={o.name} style={{
                      borderBottom: '1px solid #0d0d0d',
                      background: i % 2 === 0 ? '#030303' : '#050505',
                    }}>
                      <td style={{ padding: '4px 8px', fontFamily: 'var(--head)', fontSize: 11, letterSpacing: 1 }}>
                        {o.name}
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10 }}>
                        {o.sell != null ? fmtISK(o.sell) : '—'}
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)' }}>
                        {o.isk_per_m3 != null ? fmtISK(o.isk_per_m3) : '—'}
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>
                        {o.buy_per_m3 != null ? fmtISK(o.buy_per_m3) : '—'}
                      </td>
                      <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 11, color: TREND_COLOR[trend] }}
                          title={o.trend_pct != null ? `${o.trend_pct > 0 ? '+' : ''}${o.trend_pct}%` : ''}>
                        {TREND_ICON[trend]}
                      </td>
                    </tr>
                  );
                })
              }
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
