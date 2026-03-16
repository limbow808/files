import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';

function fmtM3(m3) {
  if (m3 == null) return '—';
  if (m3 >= 1_000_000) return `${(m3 / 1_000_000).toFixed(1)}M m³`;
  if (m3 >= 1_000)     return `${(m3 / 1_000).toFixed(1)}K m³`;
  return `${Math.round(m3).toLocaleString('en-US')} m³`;
}

export default function OverviewFooter() {
  const { data } = useApi('/api/queue-summary');

  const running  = data?.running_jobs   ?? '—';
  const maxJobs  = data?.max_jobs       ?? '—';
  const queue    = data?.queue_count    ?? '—';
  const shopping = data?.needs_shopping ?? '—';
  const cost     = data ? fmtISK(data.total_cost_isk) : '—';
  const haul     = data ? fmtM3(data.haul_m3) : '—';

  const sep = (
    <span style={{ padding: '0 14px', color: '#1e1e1e', fontSize: 13, lineHeight: 1 }}>·</span>
  );

  const Stat = ({ label, value, valueColor }) => (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 9, letterSpacing: 1.5, color: '#393930', fontFamily: 'var(--mono)' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: valueColor || 'var(--text)', letterSpacing: 0.5 }}>
        {value}
      </span>
    </span>
  );

  return (
    <div style={{
      height: 24,
      flexShrink: 0,
      background: '#040404',
      borderTop: '1px solid #111',
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 14,
      paddingRight: 14,
      overflow: 'hidden',
      gap: 0,
    }}>
      <Stat label="ACTIVE JOBS" value={data ? `${running} / ${maxJobs}` : '—'} />
      {sep}
      <Stat label="QUEUE READY" value={queue} />
      {sep}
      <Stat label="NEEDS SHOPPING" value={shopping} />
      {sep}
      <Stat label="TOTAL COST" value={cost} valueColor="var(--accent)" />
      {sep}
      <Stat label="HAUL" value={haul} />
    </div>
  );
}
