import { useState } from 'react';
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
  const [activeTab, setActiveTab] = useState(0);

  const group = GROUPS[activeTab];
  const rows = group.ores
    .map(name => ({ name, ...(ores[name] || {}) }))
    .sort((a, b) => (b.isk_per_m3 || 0) - (a.isk_per_m3 || 0));
  const best = rows[0];
  const TREND_LABEL = { up: '▲ rising', down: '▼ falling', flat: '— stable' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="panel-hdr" style={{ padding: '3px 14px' }}>
        <span className="panel-title">◈ BASE ORES</span>
        {error && !data && (
          <span style={{ fontSize: 10, color: '#ff4444', letterSpacing: 1 }}>⚠ ESI UNAVAILABLE</span>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {GROUPS.map((g, i) => (
          <button key={g.label} onClick={() => setActiveTab(i)} style={{
            flex: 1,
            padding: '3px 0',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === i ? `2px solid ${g.color}` : '2px solid transparent',
            color: activeTab === i ? g.color : 'var(--dim)',
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: 1,
            cursor: 'pointer',
            textTransform: 'capitalize',
          }}>
            {g.label.charAt(0) + g.label.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <LoadingState label="FETCHING PRICES" sub="ESI · MARKET" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Best /M3 spotlight — top bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '6px 12px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(0,204,102,0.04)',
            flexShrink: 0,
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: 1.5, color: 'var(--dim)', whiteSpace: 'nowrap' }}>BEST /M3</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: '#00cc66', lineHeight: 1 }}>
              {best?.name || '—'}
            </span>
            <div style={{ display: 'flex', gap: 16, marginLeft: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
                Sell <span style={{ color: '#00cc66', fontWeight: 700 }}>{best?.sell ? fmtISK(best.sell) : '—'}</span>
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
                ISK/m³ <span style={{ color: '#00cc66', fontWeight: 700 }}>{best?.isk_per_m3 ? fmtISK(best.isk_per_m3) : '—'}</span>
              </span>
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: TREND_COLOR[best?.trend || 'flat'], marginLeft: 'auto' }}>
              {TREND_LABEL[best?.trend || 'flat']}
            </span>
          </div>

          {/* Ore table */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 64px 64px 16px',
              padding: '2px 10px',
              borderBottom: '1px solid var(--border)',
              background: '#050505',
              flexShrink: 0,
            }}>
              {['ORE','SELL','ISK/M³',''].map((h, i) => (
                <span key={i} style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)',
                  letterSpacing: 1, textAlign: i === 0 ? 'left' : 'right',
                }}>{h}</span>
              ))}
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              {rows.map((ore, idx) => {
                const isBest = idx === 0;
                const trend = ore.trend || 'flat';
                return (
                  <div key={ore.name} style={{
                    flex: 1,
                    display: 'grid', gridTemplateColumns: '1fr 64px 64px 16px',
                    padding: '0 10px',
                    borderBottom: '1px solid #0d0d0d',
                    background: isBest ? 'rgba(0,204,102,0.04)' : 'transparent',
                    alignItems: 'center',
                  }}>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.3,
                      color: isBest ? '#00cc66' : 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{ore.name}</span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right',
                      color: isBest ? '#00cc66' : 'var(--dim)',
                    }}>{ore.sell ? fmtISK(ore.sell) : '—'}</span>
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right',
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
          </div>
        </div>
      )}
    </div>
  );
}

