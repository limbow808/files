import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import { LoadingState } from './ui';

const GROUPS = [
  {
    label: 'HIGHSEC',
    color: '#4da6ff',
    ores: ['Veldspar','Scordite','Pyroxeres','Kernite','Omber','Jaspet'],
  },
  {
    label: 'LOWSEC',
    color: '#ffcc44',
    ores: ['Hemorphite','Hedbergite','Gneiss','Dark Ochre'],
  },
  {
    label: 'NULLSEC',
    color: '#ff4444',
    ores: ['Bistot','Crokite','Spodumain','Arkonor','Mercoxit'],
  },
];

const TREND_ICON  = { up: '▲', down: '▼', flat: '-' };
const TREND_COLOR = { up: '#00cc66', down: '#cc3333', flat: '#333' };

export default function OresSection() {
  const { data, loading, error } = useApi('/api/minerals');
  const ores = data?.ores || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="panel-hdr" style={{ padding: '5px 14px' }}>
        <span className="panel-title">◈ BASE ORES</span>
        {error && !data && (
          <span style={{ fontSize: 10, color: '#ff4444', letterSpacing: 1 }}>⚠ ESI UNAVAILABLE</span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <LoadingState label="FETCHING PRICES" sub="ESI · MARKET" />
        ) : (
          <>
            {/* Single column header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 64px 64px 16px',
              padding: '2px 8px',
              borderBottom: '1px solid var(--border)',
              background: '#050505',
              position: 'sticky', top: 0, zIndex: 3,
            }}>
              {['ORE','SELL','ISK/M³',''].map((h, i) => (
                <span key={i} style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)',
                  letterSpacing: 1, textAlign: i === 0 ? 'left' : 'right',
                }}>{h}</span>
              ))}
            </div>

            {GROUPS.map(group => {
              const rows = group.ores.map(name => ({ name, ...(ores[name] || {}) }));
              const bestIskM3 = Math.max(...rows.map(r => r.isk_per_m3 || 0));

              return (
                <div key={group.label}>
                  {/* Group header */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '2px 8px',
                    background: '#080808',
                    borderTop: '1px solid var(--border)',
                    borderBottom: '1px solid #111',
                    position: 'sticky', top: 20, zIndex: 2,
                  }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: group.color, flexShrink: 0 }} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: 2, color: group.color }}>{group.label}</span>
                  </div>

                  {/* Rows */}
                  {rows.map(ore => {
                    const isBest = bestIskM3 > 0 && ore.isk_per_m3 === bestIskM3;
                    const trend  = ore.trend || 'flat';
                    return (
                      <div key={ore.name} style={{
                        display: 'grid', gridTemplateColumns: '1fr 64px 64px 16px',
                        padding: '3px 8px',
                        borderBottom: '1px solid #0d0d0d',
                        background: isBest ? 'rgba(0,204,102,0.04)' : 'transparent',
                        alignItems: 'center',
                      }}>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.3,
                          color: isBest ? '#00cc66' : 'var(--text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{ore.name}</span>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right',
                          color: isBest ? '#00cc66' : 'var(--dim)',
                        }}>{ore.sell ? fmtISK(ore.sell) : '—'}</span>
                        <span style={{
                          fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right',
                          color: isBest ? '#00cc66' : 'var(--text)',
                          fontWeight: isBest ? 700 : 400,
                        }}>{ore.isk_per_m3 ? fmtISK(ore.isk_per_m3) : '—'}</span>
                        <span style={{
                          textAlign: 'right', fontSize: 9,
                          color: TREND_COLOR[trend],
                        }}>{TREND_ICON[trend]}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

