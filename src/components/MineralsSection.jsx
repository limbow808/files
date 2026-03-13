import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';

const MINERAL_ORDER = ['Tritanium','Pyerite','Mexallon','Isogen','Nocxium','Zydrine','Megacyte','Morphite'];
const ORE_ORDER     = ['Veldspar','Scordite','Pyroxeres','Kernite','Omber','Jaspet',
                       'Hemorphite','Hedbergite','Gneiss','Dark Ochre','Bistot','Crokite',
                       'Spodumain','Arkonor','Mercoxit'];

export default function MineralsSection() {
  const { data, loading } = useApi('/api/minerals');
  const [tab, setTab] = useState('minerals');
  const minerals = data?.minerals || {};
  const ores     = data?.ores     || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Tab strip — both buttons flush left, side by side */}
      <div className="panel-hdr" style={{ padding: 0, flexShrink: 0 }}>
        {['minerals','ores'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`tab-btn${tab === t ? ' active' : ''}`}>
            {t === 'minerals' ? '◈ Minerals' : '◈ Base Ores'}
          </button>
        ))}
      </div>

      {tab === 'minerals' ? (
        /* Fill entire remaining height with an 8-cell grid (4×2), rows auto-stretch */
        <div style={{
          flex: 1, minHeight: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gridTemplateRows: 'repeat(2, 1fr)',
          gap: 1,
          background: 'var(--border)',
          padding: 1,
        }}>
          {MINERAL_ORDER.map(name => {
            const m = minerals[name];
            return (
              <div key={name} style={{
                background: '#050505',
                display: 'flex', flexDirection: 'column', justifyContent: 'center',
                padding: '0 12px',
              }}>
                <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 3 }}>
                  {name.toUpperCase()}
                </div>
                {loading && !data
                  ? <div style={{ background: '#111', height: 14, width: 60, animation: 'pulse 1.5s infinite' }} />
                  : <>
                      <div style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--mono)' }}>{m ? fmtISK(m.sell) : '—'}</div>
                      <div style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginTop: 2 }}>▼ {m ? fmtISK(m.buy) : '—'}</div>
                    </>
                }
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['ORE','SELL','ISK/M³','BUY/M³'].map(h => (
                  <th key={h} style={{ padding: '5px 8px', fontSize: 9, color: 'var(--dim)', letterSpacing: 2,
                    borderBottom: '1px solid var(--border)', textAlign: h === 'ORE' ? 'left' : 'right',
                    position: 'sticky', top: 0, background: '#000', zIndex: 1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ORE_ORDER.map(name => {
                const o = ores[name];
                return (
                  <tr key={name} style={{ borderBottom: '1px solid #0d0d0d' }}>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--head)', fontSize: 11, letterSpacing: 1 }}>{name}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10 }}>
                      {loading && !data ? '—' : (o ? fmtISK(o.sell) : '—')}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--accent)' }}>
                      {loading && !data ? '—' : (o ? fmtISK(o.isk_per_m3) : '—')}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>
                      {loading && !data ? '—' : (o ? fmtISK(o.buy_per_m3) : '—')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
