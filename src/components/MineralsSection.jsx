import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK, fmtTS } from '../utils/fmt';

const MINERAL_ORDER = ['Tritanium','Pyerite','Mexallon','Isogen','Nocxium','Zydrine','Megacyte','Morphite'];
const ORE_ORDER     = ['Veldspar','Scordite','Pyroxeres','Kernite','Omber','Jaspet',
                       'Hemorphite','Hedbergite','Gneiss','Dark Ochre','Bistot','Crokite',
                       'Spodumain','Arkonor','Mercoxit'];

export default function MineralsSection() {
  const { data, loading } = useApi('/api/minerals');
  const [tab, setTab] = useState('minerals');

  const minerals  = data?.minerals || {};
  const ores      = data?.ores     || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Tab header */}
      <div className="panel-hdr" style={{ gap: 0, padding: 0 }}>
        {['minerals','ores'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '9px 18px',
              fontSize: 11,
              fontFamily: 'var(--head)',
              letterSpacing: 2,
              background: 'none',
              border: 'none',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--text)' : 'var(--dim)',
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >
            {t === 'minerals' ? '◈ Minerals' : '◈ Base Ores'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '12px 14px' }}>
        {tab === 'minerals' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)' }}>
            {MINERAL_ORDER.map(name => {
              const m = minerals[name];
              return (
                <div key={name} style={{ background: '#050505', padding: '10px 12px' }}>
                  <div style={{ fontFamily: 'var(--head)', fontSize: 12, fontWeight: 600, letterSpacing: 2, color: 'var(--text)', marginBottom: 3 }}>
                    {name.toUpperCase()}
                  </div>
                  {loading && !data ? (
                    <div style={{ background: '#111', height: 16, width: 80, animation: 'pulse 1.5s infinite' }} />
                  ) : (
                    <>
                      <div style={{ fontSize: 13, color: 'var(--text)' }}>{m ? fmtISK(m.sell) : '—'}</div>
                      <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 1, letterSpacing: 1 }}>BUY {m ? fmtISK(m.buy) : '—'}</div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left',  padding: '5px 8px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>ORE</th>
                <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>SELL / UNIT</th>
                <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>ISK / M³</th>
                <th style={{ textAlign: 'right', padding: '5px 8px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>BUY / M³</th>
              </tr>
            </thead>
            <tbody>
              {ORE_ORDER.map(name => {
                const o = ores[name];
                return (
                  <tr key={name} style={{ borderBottom: '1px solid #0d0d0d' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--head)', fontSize: 12, letterSpacing: 1, textAlign: 'left' }}>
                      {name.toUpperCase()}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>
                      {loading && !data ? '—' : (o ? fmtISK(o.sell) : '—')}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>
                      {loading && !data ? '—' : (o ? fmtISK(o.isk_per_m3) : '—')}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
                      {loading && !data ? '—' : (o ? fmtISK(o.buy_per_m3) : '—')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

