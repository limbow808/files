import { memo } from 'react';

function formatSeconds(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function Flag({ label, bg, color = '#000' }) {
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: 0.5,
      padding: '1px 4px', borderRadius: 2, background: bg, color, fontWeight: 700, flexShrink: 0,
    }}>{label}</span>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 9, borderBottom: '1px solid #0d0d0d' }}>
      <span style={{ color: 'var(--dim)', letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

const ManufacturingQueueRow = memo(function ManufacturingQueueRow({ item, hasMfgSlot, cycleConfig, isOpen, onToggle }) {
  const profitPerCycle = item.profit_per_cycle || item.net_profit || 0;
  const runsPerCycle = item.runs_per_cycle || 1;
  const cycleWindowFit = item.cycle_window_fit || 'fits';
  const saturationPct = item.market_saturation_pct || 0;
  const daysToSell = item.days_to_sell || 0;
  const exceeds = cycleWindowFit === 'exceeds';
  const belowThreshold = !item.passes_profit_filter;
  const saturated = !item.passes_saturation_filter;
  const matReady = item.mats_ready !== false;
  const profitM = (profitPerCycle / 1_000_000).toFixed(1);

  return (
    <div style={{ borderBottom: '1px solid #0d0d0d' }}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', padding: '6px 10px',
          cursor: 'pointer', background: belowThreshold ? 'var(--bg)' : 'var(--table-row-bg)',
          opacity: belowThreshold || saturated ? 0.6 : 1,
        }}
        onClick={onToggle}
        onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.15)'; }}
        onMouseLeave={e => { e.currentTarget.style.filter = ''; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 8, color: 'var(--dim)', flexShrink: 0, userSelect: 'none', display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
          {item.output_id && (
            <img src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`} alt=""
              style={{ width: 18, height: 18, opacity: 0.85, flexShrink: 0 }}
              onError={e => { e.target.style.display = 'none'; }} />
          )}
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.name}</span>
          <div style={{ display: 'flex', gap: 3, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {!hasMfgSlot && <Flag label="NO SLOT" bg="var(--accent)" />}
            {exceeds && <Flag label="⚠ EXCEEDS CYCLE" bg="rgba(255,71,0,0.3)" color="var(--accent)" />}
            {saturated && <Flag label={`SATURATED ${saturationPct.toFixed(0)}%`} bg="rgba(255,157,61,0.3)" color="#ff9d3d" />}
            {!matReady && <Flag label="MISSING MATS" bg="rgba(255,71,0,0.2)" color="var(--accent)" />}
            {belowThreshold && <Flag label="BELOW THRESHOLD" bg="rgba(255,255,255,0.07)" color="var(--dim)" />}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 24, marginTop: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>{runsPerCycle}× runs/cycle</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: profitPerCycle >= 0 ? '#4cff91' : 'var(--accent)' }}>{profitM}M ISK/cycle</span>
        </div>
      </div>

      {isOpen && (
        <div style={{ background: 'var(--bg)', borderLeft: '3px solid #ff4700', padding: '8px 12px', borderBottom: '1px solid #0d0d0d' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <DetailRow label="Duration" value={formatSeconds(item.duration_secs || item.duration_seconds || 0)} />
              <DetailRow label="Net profit/run" value={`${((item.net_profit || 0) / 1_000_000).toFixed(1)}M`} />
            </div>
            <div>
              <DetailRow label="Market vol/day" value={(item.avg_daily_volume || 0).toFixed(1)} />
              <DetailRow label="Saturation" value={`${saturationPct.toFixed(1)}%`} />
              <DetailRow label="Days to sell" value={`${daysToSell.toFixed(1)}d`} />
            </div>
          </div>
          {item.material_breakdown?.length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #0d0d0d' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1.5, color: 'var(--dim)', marginBottom: 4 }}>
                MATERIALS ({item.material_breakdown.length})
              </div>
              {item.material_breakdown.slice(0, 5).map((m) => (
                <DetailRow key={m.type_id} label={m.name || `Type ${m.type_id}`} value={`${((m.line_cost || 0) / 1_000_000).toFixed(1)}M`} />
              ))}
              {item.material_breakdown.length > 5 && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>+{item.material_breakdown.length - 5} more</span>
              )}
            </div>
          )}
          {item.missing_mats_est_cost > 0 && (
            <div style={{ marginTop: 8, padding: '5px 8px', background: 'rgba(255,71,0,0.1)', border: '1px solid rgba(255,71,0,0.3)', borderRadius: 2 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--accent)', letterSpacing: 0.5 }}>
                MISSING MATS: ~{((item.missing_mats_est_cost) / 1_000_000).toFixed(1)}M ISK
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default memo(function ManufacturingQueueColumn({ items, cycleConfig, maxJobs, freeSlots, onItemExpand, expandedId }) {
  const mfgItems = items?.filter(i => i.action_type === 'manufacture') || [];

  if (mfgItems.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 10, letterSpacing: 1.5, textAlign: 'center' }}>
        NO MANUFACTURING JOBS RECOMMENDED
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {mfgItems.map((item, idx) => (
        <ManufacturingQueueRow
          key={item.output_id}
          item={item}
          hasMfgSlot={idx < freeSlots}
          cycleConfig={cycleConfig}
          isOpen={expandedId === item.output_id}
          onToggle={() => onItemExpand(expandedId === item.output_id ? null : item.output_id)}
        />
      ))}
    </div>
  );
});
