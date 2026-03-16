import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';

export default function KPIBar({ plexData, walletHistory }) {
  const { data: jobsData } = useApi('/api/industry/jobs');

  const jobs = jobsData?.jobs || [];
  const mfgJobs = jobs.filter(j => j.activity === 'Manufacturing' || j.activity === 'Reaction');

  // ISK / Day
  const balance  = plexData?.current_balance ?? 0;
  const target   = plexData?.monthly_target  ?? 0;
  const daysLeft = plexData?.days_remaining  ?? 0;
  const needed   = Math.max(0, target - balance);
  const iskPerDay = daysLeft > 0 ? needed / daysLeft : 0;

  // Wallet Change (24h)
  const now  = Date.now() / 1000;
  const hist = walletHistory || [];
  const currentBal   = hist.length > 0 ? hist[hist.length - 1].balance : balance;
  const dayAgoEntry  = [...hist].reverse().find(p => p.ts <= now - 86400);
  const walletChange = dayAgoEntry ? currentBal - dayAgoEntry.balance : null;

  // Jobs stats
  const _now         = Math.floor(Date.now() / 1000);
  const activeJobs   = jobs.filter(j => (j.end_ts - _now) > 0).length;
  const revenue      = mfgJobs.reduce((s, j) => s + (j.sell_total ?? 0), 0);
  const profitSum    = mfgJobs.every(j => j.profit != null)
    ? mfgJobs.reduce((s, j) => s + (j.profit ?? 0), 0) : null;
  const withMargin   = mfgJobs.filter(j => j.margin_pct != null);
  const avgMargin    = withMargin.length
    ? withMargin.reduce((s, j) => s + j.margin_pct, 0) / withMargin.length : null;

  const stats = [
    { label: 'ISK / DAY',      value: fmtISK(iskPerDay),                                      color: 'var(--text)' },
    { label: 'WALLET Δ 24H',   value: walletChange != null ? fmtISK(walletChange) : '—',      color: walletChange > 0 ? '#4cff91' : walletChange < 0 ? '#ff3b3b' : 'var(--text)' },
    { label: 'EST. PROFIT',    value: profitSum != null ? fmtISK(profitSum) : '—',             color: profitSum > 0 ? '#4cff91' : profitSum < 0 ? '#ff3b3b' : 'var(--text)' },
    { label: 'EST. REVENUE',   value: revenue > 0 ? fmtISK(revenue) : '—',                    color: 'var(--accent)' },
    { label: 'AVG MARGIN',     value: avgMargin != null ? `${avgMargin.toFixed(1)}%` : '—',    color: avgMargin > 0 ? '#4cff91' : avgMargin < 0 ? '#ff3b3b' : 'var(--text)' },
    { label: 'ACTIVE JOBS',    value: `${activeJobs}`,                                         color: 'var(--text)' },
  ];

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      height: 38, flexShrink: 0,
      borderBottom: '1px solid var(--border)',
      background: '#0a0a08',
    }}>
      {stats.map((s, i) => (
        <div key={s.label} style={{
          flex: 1,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '0 8px',
          borderRight: i < stats.length - 1 ? '1px solid var(--border)' : 'none',
          height: '100%',
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: s.color, letterSpacing: 0.5, lineHeight: 1 }}>{s.value}</span>
          <span style={{ fontSize: 8, color: 'var(--dim)', letterSpacing: 1.5, marginTop: 3, lineHeight: 1 }}>{s.label}</span>
        </div>
      ))}
    </div>
  );
}
