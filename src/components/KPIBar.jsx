import { fmtISK } from '../utils/fmt';

export default function KPIBar({ plexData, loading, onRefresh, refreshing }) {
  const balance = plexData?.current_balance ?? 0;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 20px',
      borderBottom: '1px solid var(--border)',
      background: '#030303',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)' }}>WALLET</span>
        <span style={{ fontFamily: 'var(--head)', fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
          {loading && !plexData ? '—' : fmtISK(balance) + ' ISK'}
        </span>
      </div>
      <button
        className="btn btn-primary"
        onClick={onRefresh}
        disabled={refreshing}
        style={{ padding: '5px 16px', fontSize: 11, letterSpacing: 2 }}
      >
        {refreshing ? '⟳ SCANNING…' : '⟳ SCAN'}
      </button>
    </div>
  );
}

