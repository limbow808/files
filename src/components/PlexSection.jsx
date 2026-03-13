import { fmtISK } from '../utils/fmt';
import WalletSparkline from './WalletSparkline';

export default function PlexSection({ plexData, walletHistory, loading, error }) {
  const balance   = plexData?.current_balance  ?? 0;
  const target    = plexData?.monthly_target   ?? 0;
  const daysLeft  = plexData?.days_remaining   ?? 0;
  const plexPrice = plexData?.plex_price       ?? 0;
  const plexCount = plexData?.plex_count       ?? null;
  const plexValue = plexData?.plex_value       ?? 0;
  const showPlex  = plexCount !== null && plexCount > 0;
  const needed    = Math.max(0, target - balance);
  const perDay    = daysLeft > 0 ? needed / daysLeft : 0;
  const pct       = target > 0 ? Math.min(100, balance / target * 100) : 0;
  const projOk    = pct >= 100;
  const month     = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  const stats = [
    ['ISK / DAY',   fmtISK(perDay)    + ' ISK'],
    ['PLEX PRICE',  fmtISK(plexPrice) + ' ISK'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '12px 14px', overflowY: 'hidden' }}>

      {/* Header row: title left, days remaining right */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10, flexShrink: 0 }}>
        <span className="panel-title">◈ PLEX TRACKER — {month}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: 1 }}>
          {daysLeft} DAYS LEFT
        </span>
      </div>

      {/* ESI error banner */}
      {error && !plexData && (
        <div style={{ padding: '8px 0 4px', fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      {/* Wallet balance */}
      <div style={{ marginBottom: 10, flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 3 }}>WALLET</div>
        <div style={{ fontFamily: 'var(--head)', fontSize: 26, fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }}>
          {loading && !plexData ? '—' : `${fmtISK(balance)} ISK`}
        </div>
      </div>

      {/* Sparkline — fills all remaining vertical space */}
      <div style={{ flex: 1, minHeight: 0, marginBottom: 10 }}>
        <WalletSparkline history={walletHistory ?? []} target={target} />
      </div>

      {/* Progress bar */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginBottom: 4 }}>
          <span>0</span>
          <span style={{ color: projOk ? '#00cc66' : 'var(--text)' }}>{pct.toFixed(1)}% OF TARGET</span>
          <span>{fmtISK(target)} ISK</span>
        </div>
        <div style={{ height: 6, background: '#0a0a0a', border: '1px solid var(--border)', marginBottom: 5 }}>
          <div style={{ height: '100%', width: `${pct}%`, background: projOk ? '#00cc66' : 'var(--accent)', transition: 'width 0.8s ease' }} />
        </div>
        <div style={{ fontSize: 10, color: projOk ? '#00cc66' : 'var(--accent)', letterSpacing: 1, marginBottom: 10, textAlign: 'right' }}>
          {projOk ? 'TARGET ACHIEVED ✓' : `SHORT BY ${fmtISK(needed)} ISK`}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)', flexShrink: 0 }}>
        {stats.map(([label, val]) => (
          <div key={label} style={{ background: '#050505', padding: '8px 10px' }}>
            <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 12, color: 'var(--text)' }}>{loading && !plexData ? '—' : val}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

