import { memo } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK, fmtVol, roiColor } from '../utils/fmt';
import { API } from '../App';

// Ownership badge colours
const OWN_COLORS = {
  personal: { fill: '#ff4700', label: 'PERS' },
  corp:     { fill: '#44bb55', label: 'CORP' },
};

function OwnBadge({ kind }) {
  const c = OWN_COLORS[kind];
  if (!c) return null;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', fontSize: 8, letterSpacing: 1,
      background: c.fill, color: '#000',
      borderRadius: 2, fontWeight: 700, flexShrink: 0,
    }}>{c.label}</span>
  );
}

function TechBadge({ tech }) {
  const color = tech === 'II' ? '#4da6ff' : tech === 'III' ? '#aa55ff' : 'var(--dim)';
  return (
    <span style={{ color, fontSize: 9, letterSpacing: 1 }}>T{tech === 'I' ? '1' : tech === 'II' ? '2' : '3'}</span>
  );
}

const COL_W = { rank: 24, name: 0, roi: 56, profit: 78 };

function HeaderRow() {
  const th = (label, align = 'right', extra = {}) => (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1.5,
      color: 'var(--dim)', textTransform: 'uppercase', textAlign: align, ...extra,
    }}>{label}</span>
  );
  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '4px 10px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--table-shell-bg)',
      flexShrink: 0,
      gap: 0,
    }}>
      <span style={{ width: COL_W.rank, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{th('#  ITEM', 'left')}</span>
      <span style={{ width: COL_W.roi,    flexShrink: 0, textAlign: 'right' }}>{th('ROI')}</span>
      <span style={{ width: COL_W.profit, flexShrink: 0, textAlign: 'right' }}>{th('PROFIT/RUN')}</span>
    </div>
  );
}

function ItemRow({ item, rank }) {
  const roiClr  = roiColor(item.roi);
  const profClr = item.net_profit >= 0 ? '#4cff91' : '#ff3b3b';

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '3px 10px',
      borderBottom: '1px solid rgba(51,51,51,0.4)',
      gap: 0,
      minHeight: 22,
    }}>
      {/* Rank */}
      <span style={{
        width: COL_W.rank, flexShrink: 0,
        fontFamily: 'var(--mono)', fontSize: 9,
        color: rank <= 3 ? 'var(--accent)' : 'var(--dim)',
        letterSpacing: 1,
      }}>{rank}</span>

      {/* Name + ownership badges */}
      <span style={{
        flex: 1, minWidth: 0,
        display: 'flex', alignItems: 'center', gap: 4,
        overflow: 'hidden',
        paddingRight: 6,
      }} title={item.name}>
        {item.output_id && (
          <img
            src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`}
            alt=""
            style={{ width: 18, height: 18, flexShrink: 0, opacity: 0.85 }}
            onError={e => { e.target.style.display = 'none'; }}
          />
        )}
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{item.name}</span>
        {(item.ownership || []).map(o => <OwnBadge key={o} kind={o} />)}
      </span>

      {/* ROI */}
      <span style={{
        width: COL_W.roi, flexShrink: 0, textAlign: 'right',
        fontFamily: 'var(--mono)', fontSize: 11, color: roiClr,
      }}>{item.roi != null ? `${item.roi.toFixed(1)}%` : '—'}</span>

      {/* Profit/run */}
      <span style={{
        width: COL_W.profit, flexShrink: 0, textAlign: 'right',
        fontFamily: 'var(--mono)', fontSize: 11, color: profClr,
      }}>{fmtISK(item.net_profit)}</span>
    </div>
  );
}

export default memo(function TopPerformersPanel({ refreshKey = 0 }) {
  const { data, loading, error } = useApi(`${API}/api/top-performers`, [refreshKey]);

  const items = data?.items || [];
  const totalOwned = data?.total_owned ?? null;
  const hasData = items.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Panel header */}
      <div className="panel-hdr">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 3,
            color: 'var(--accent)', textTransform: 'uppercase',
          }}>▲ TOP PERFORMERS</span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
            color: 'var(--dim)',
          }}>OWNED BPs · HIGH ROI · FAST SELLERS</span>
        </div>
        {totalOwned != null && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
            color: 'var(--dim)',
          }}>{totalOwned} OWNED ITEMS PROFITABLE</span>
        )}
      </div>

      {/* State: loading */}
      {loading && !hasData && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1.5, color: 'var(--dim)',
        }}>LOADING…</div>
      )}

      {/* State: no calc data yet */}
      {!loading && data?.status === 'no_data' && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)',
          textAlign: 'center', padding: '0 20px',
        }}>NO CALCULATOR DATA — OPEN THE CALCULATOR TAB TO GENERATE A SCAN</div>
      )}

      {/* State: no BPs */}
      {!loading && data?.status === 'no_blueprints' && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.5, color: 'var(--dim)',
        }}>NO OWNED BLUEPRINTS DETECTED</div>
      )}

      {/* State: error */}
      {error && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.5, color: '#cc2200',
        }}>ESI ERROR — {error}</div>
      )}

      {/* Data table */}
      {hasData && (
        <>
          <HeaderRow />
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {items.map((item, i) => (
              <ItemRow key={item.output_id} item={item} rank={i + 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
});
