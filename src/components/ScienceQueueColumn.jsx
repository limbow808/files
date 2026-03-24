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

function SectionHeader({ label, count, accentColor }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', background: 'var(--bg)', flexShrink: 0,
      borderBottom: '1px solid #0d0d0d',
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 3, color: accentColor, fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#000', background: accentColor, padding: '1px 5px', borderRadius: 2 }}>{count}</span>
      <div style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${accentColor}66, transparent)` }} />
    </div>
  );
}

const ScienceQueueRow = memo(function ScienceQueueRow({ item, hasSciSlot, cycleConfig, isOpen, onToggle, isInvention }) {
  const profitPerCycle = item.profit_per_cycle || item.net_profit || 0;
  const runsPerCycle = item.runs_per_cycle || 1;
  const cycleWindowFit = item.cycle_window_fit || 'fits';
  const successChance = item.invention_success_chance || 1.0;
  const hasBPC = item.has_t1_bpc || false;
  const riskFlag = isInvention && successChance < (cycleConfig?.success_warn_threshold || 0.34);
  const exceeds = cycleWindowFit === 'exceeds';
  const belowThreshold = !item.passes_profit_filter;
  const profitM = (profitPerCycle / 1_000_000).toFixed(1);

  return (
    <div style={{ borderBottom: '1px solid #0d0d0d' }}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', padding: '6px 10px',
          cursor: 'pointer', background: belowThreshold ? 'var(--bg)' : 'var(--table-row-bg)',
          opacity: belowThreshold ? 0.6 : 1,
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
            {!hasSciSlot && <Flag label="NO SLOT" bg="var(--accent)" />}
            {riskFlag && <Flag label={`${Math.round(successChance * 100)}% SUCCESS`} bg="#ff9d3d" />}
            {exceeds && <Flag label="⚠ EXCEEDS CYCLE" bg="rgba(255,71,0,0.3)" color="var(--accent)" />}
            {isInvention && hasBPC && <Flag label="✓ T1 BPC" bg="rgba(76,255,145,0.2)" color="#4cff91" />}
            {isInvention && !hasBPC && <Flag label="NEED T1 BPC" bg="rgba(255,71,0,0.2)" color="var(--accent)" />}
            {belowThreshold && <Flag label="BELOW THRESHOLD" bg="rgba(255,255,255,0.07)" color="var(--dim)" />}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 24, marginTop: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>{runsPerCycle}× runs/cycle</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: profitPerCycle >= 0 ? '#4cff91' : 'var(--accent)' }}>{profitM}M ISK/cycle</span>
        </div>
      </div>

      {isOpen && (
        <div style={{ background: 'var(--bg)', borderLeft: '3px solid #4da6ff', padding: '8px 12px', borderBottom: '1px solid #0d0d0d' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <DetailRow label="Duration" value={formatSeconds(item.duration_secs || item.duration_seconds || 0)} />
              {isInvention && <DetailRow label="Success chance" value={`${Math.round(successChance * 100)}%`} />}
              {isInvention && item.inv_output_runs_per_bpc && <DetailRow label="Runs/T2 BPC" value={item.inv_output_runs_per_bpc} />}
              <DetailRow label="Net profit/run" value={`${((item.net_profit || 0) / 1_000_000).toFixed(1)}M`} />
            </div>
            <div>
              <DetailRow label="Market vol/day" value={(item.avg_daily_volume || 0).toFixed(1)} />
              <DetailRow label="Saturation" value={`${(item.market_saturation_pct || 0).toFixed(1)}%`} />
              <DetailRow label="Days to sell" value={`${(item.days_to_sell || 0).toFixed(1)}d`} />
            </div>
          </div>
          {isInvention && item.datacore_costs && Object.keys(item.datacore_costs).length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #0d0d0d' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1.5, color: 'var(--dim)', marginBottom: 4 }}>DATACORES</div>
              {Object.entries(item.datacore_costs).map(([dc, cost]) => (
                <DetailRow key={dc} label={dc} value={`${(cost / 1_000_000).toFixed(1)}M`} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default memo(function ScienceQueueColumn({ items, cycleConfig, maxScience, freeScience, onItemExpand, expandedId }) {
  const copyItems = items.filter(i => i.action_type === 'copy_first');
  const inventItems = items.filter(i => i.action_type === 'invent_first');

  if (copyItems.length === 0 && inventItems.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 10, letterSpacing: 1.5, textAlign: 'center' }}>
        NO SCIENCE JOBS RECOMMENDED
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {copyItems.length > 0 && (
        <>
          <SectionHeader label="COPY FIRST" count={copyItems.length} accentColor="#4da6ff" />
          {copyItems.map((item, idx) => (
            <ScienceQueueRow
              key={item.output_id}
              item={item}
              hasSciSlot={idx < freeScience}
              cycleConfig={cycleConfig}
              isOpen={expandedId === item.output_id}
              onToggle={() => onItemExpand(expandedId === item.output_id ? null : item.output_id)}
            />
          ))}
        </>
      )}
      {inventItems.length > 0 && (
        <>
          <SectionHeader label="INVENT FIRST" count={inventItems.length} accentColor="#ff9d3d" />
          {inventItems.map((item, idx) => (
            <ScienceQueueRow
              key={item.output_id}
              item={item}
              hasSciSlot={copyItems.length + idx < freeScience}
              cycleConfig={cycleConfig}
              isOpen={expandedId === item.output_id}
              onToggle={() => onItemExpand(expandedId === item.output_id ? null : item.output_id)}
              isInvention
            />
          ))}
        </>
      )}
    </div>
  );
});
