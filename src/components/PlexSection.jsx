import { fmtISK } from '../utils/fmt';
import WalletSparkline from './WalletSparkline';

export default function PlexSection({ plexData, walletHistory, loading }) {
  const balance   = plexData?.current_balance  ?? 0;
  const target    = plexData?.monthly_target   ?? 0;
  const daysLeft  = plexData?.days_remaining   ?? 0;
  const plexPrice = plexData?.plex_price       ?? 0;
  const accounts  = plexData?.accounts         ?? 0;
  const ppa       = plexData?.plex_per_account ?? 0;
  const needed    = Math.max(0, target - balance);
  const pct       = target > 0 ? Math.min(100, balance / target * 100) : 0;
  const perDay    = daysLeft > 0 ? needed / daysLeft : 0;
  const projOk    = pct >= 100;
  const month     = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  const stats = [
    ['MONTHLY TARGET',  fmtISK(target)    + ' ISK'],
    ['STILL NEEDED',    fmtISK(needed)    + ' ISK'],
    ['ISK / DAY',       fmtISK(perDay)    + ' ISK'],
    ['DAYS REMAINING',  String(daysLeft)],
    ['PLEX PRICE',      fmtISK(plexPrice) + ' ISK'],
    ['ACCOUNTS',        `${accounts} × ${ppa} PLEX`],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 18, overflowY: 'auto' }}>
      <div className="panel-title" style={{ marginBottom: 16 }}>◈ PLEX TRACKER — {month}</div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 4 }}>
          WALLET BALANCE
        </div>
        <div style={{ fontFamily: 'var(--head)', fontSize: 34, fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }}>
          {loading && !plexData ? '—' : `${fmtISK(balance)} ISK`}
        </div>
      </div>

      <WalletSparkline history={walletHistory ?? []} target={target} />

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginBottom: 5 }}>
        <span>0</span>
        <span style={{ color: projOk ? '#00cc66' : 'var(--text)' }}>{pct.toFixed(1)}% OF TARGET</span>
        <span>{fmtISK(target)} ISK</span>
      </div>
      <div style={{ height: 8, background: '#0a0a0a', border: '1px solid var(--border)', marginBottom: 6 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: projOk ? '#00cc66' : 'var(--accent)', transition: 'width 0.8s ease' }} />
      </div>
      <div style={{ fontSize: 11, color: projOk ? '#00cc66' : 'var(--accent)', letterSpacing: 1, marginBottom: 16, textAlign: 'right' }}>
        {projOk ? 'TARGET ACHIEVED ✓' : `SHORT BY ${fmtISK(needed)} ISK AT CURRENT PACE`}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)' }}>
        {stats.map(([label, val]) => (
          <div key={label} style={{ background: '#050505', padding: '10px 12px' }}>
            <div style={{ fontFamily: 'var(--head)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>{loading && !plexData ? '—' : val}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
