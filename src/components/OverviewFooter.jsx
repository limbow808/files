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
    <span style={{ padding: '0 14px', color: '#666', fontSize: 13, lineHeight: 1 }}>·</span>
  );

  const Stat = ({ label, value, valueColor }) => (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ fontSize: 9, letterSpacing: 1.5, color: '#B0B0B0', fontFamily: 'var(--mono)' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: valueColor || '#E0E0E0', letterSpacing: 0.5 }}>
        {value}
      </span>
    </span>
  );

  return (
    <div style={{
      height: 24,
      flexShrink: 0,
      background: 'var(--footer-bg)',
      borderTop: '1px solid #555',
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
      <Stat label="TOTAL COST" value={cost} valueColor="#ff6622" />
      {sep}
      <Stat label="HAUL" value={haul} />
    </div>
  );
}
