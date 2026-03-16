import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import { LoadingState } from './ui';

const MINERAL_ORDER = ['Tritanium','Pyerite','Mexallon','Isogen','Nocxium','Zydrine','Megacyte','Morphite'];

const TREND_ICON  = { up: '▲', down: '▼', flat: '→' };
const TREND_COLOR = { up: '#00cc66', down: '#cc3333', flat: '#444' };

export default function MineralsSection() {
  const { data, loading, error } = useApi('/api/minerals');

  const minerals = data?.minerals || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div className="panel-hdr">
        <span className="panel-title">◈ MINERALS</span>
        {error && !data && (
          <span style={{ fontSize: 10, color: '#ff4444', letterSpacing: 1 }}>⚠ ESI UNAVAILABLE</span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 6px' }}>
        {loading && !data ? (
          <LoadingState label="FETCHING PRICES" sub="ESI · MARKET" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)' }}>
            {MINERAL_ORDER.map(name => {
              const m = minerals[name];
              const trend = m?.trend || null;
              return (
                <div key={name} style={{
                  background: '#030303', padding: '7px 10px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', letterSpacing: 0.5 }}>{name}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>
                      {m ? fmtISK(m.sell) : '—'}
                    </div>
                  </div>
                  {trend && (
                    <span style={{ fontSize: 11, color: TREND_COLOR[trend], flexShrink: 0, marginLeft: 6 }}>
                      {TREND_ICON[trend]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
