import { Fragment } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';

export default function KPIBar({ plexData, walletHistory }) {
  const { data: jobsData }      = useApi('/api/industry/jobs');
  const { data: sellHistData }  = useApi('/api/sell_history');
  const { data: fillRateData }  = useApi('/api/sell_history/fill_rate');
  const { data: inventoryData } = useApi('/api/unrealized_value');
  const { data: bpUtilData }    = useApi('/api/bp_utilization');

  const jobs    = jobsData?.jobs || [];
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
  const profitSum  = mfgJobs.every(j => j.profit != null)
    ? mfgJobs.reduce((s, j) => s + (j.profit ?? 0), 0) : null;
  const withMargin = mfgJobs.filter(j => j.margin_pct != null);
  const avgMargin  = withMargin.length
    ? withMargin.reduce((s, j) => s + j.margin_pct, 0) / withMargin.length : null;

  // Sell history metrics
  const avgSellDays = sellHistData?.overall?.avg_days_to_sell ?? null;
  const fillRate    = fillRateData?.rate_pct ?? null;
  const inventory   = inventoryData?.total_isk ?? null;
  const bpUtil      = bpUtilData?.rate_pct ?? null;

  const stats = [
    { label: 'ISK / DAY',    value: fmtISK(iskPerDay),                                      color: 'var(--text)' },
    { label: 'WALLET Δ 24H', value: walletChange != null ? fmtISK(walletChange) : '—',      color: walletChange > 0 ? '#4cff91' : walletChange < 0 ? '#ff3b3b' : 'var(--text)' },
    { label: 'EST. PROFIT',  value: profitSum != null ? fmtISK(profitSum) : '—',             color: profitSum > 0 ? '#4cff91' : profitSum < 0 ? '#ff3b3b' : 'var(--text)' },
    { label: 'AVG MARGIN',   value: avgMargin != null ? `${avgMargin.toFixed(1)}%` : '—',    color: avgMargin > 0 ? '#4cff91' : avgMargin < 0 ? '#ff3b3b' : 'var(--text)' },
    { label: 'AVG SELL',     value: avgSellDays != null ? `${avgSellDays.toFixed(1)}d` : '—', color: avgSellDays != null && avgSellDays <= 3 ? '#4cff91' : avgSellDays != null && avgSellDays >= 14 ? '#ff6644' : 'var(--text)' },
    { label: 'FILL RATE',    value: fillRate != null ? `${fillRate.toFixed(1)}%` : '—',      color: fillRate != null && fillRate >= 80 ? '#4cff91' : fillRate != null && fillRate < 50 ? '#ff6644' : 'var(--text)' },
    { label: 'INVENTORY',    value: inventory != null ? fmtISK(inventory) : '—',             color: 'var(--accent)' },
    { label: 'BP UTIL',      value: bpUtil != null ? `${bpUtil.toFixed(0)}%` : '—',          color: bpUtil != null && bpUtil >= 70 ? '#4cff91' : bpUtil != null && bpUtil < 30 ? '#ff6644' : 'var(--text)' },
  ];

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      height: 80, flexShrink: 0,
      borderBottom: '2px solid var(--border)',
      background: 'var(--bg2)',
    }}>
      {stats.map((s, i) => (
        <Fragment key={s.label}>
          <div style={{
            flex: 1,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
            height: '100%',
          }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 400, color: s.color, letterSpacing: 0, lineHeight: 1 }}>{s.value}</span>
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 0, marginTop: 4, lineHeight: 1 }}>{s.label}</span>
          </div>
          {i < stats.length - 1 && (
            <div style={{ width: 5, height: 5, background: 'var(--border)', flexShrink: 0, alignSelf: 'center' }} />
          )}
        </Fragment>
      ))}
    </div>
  );
}
