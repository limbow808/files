import { memo, useCallback } from 'react';
import { fmtISK } from '../utils/fmt';
import CharTag from './CharTag';
import { charColor } from '../utils/charColors';

function formatSeconds(seconds) {
  if (!seconds) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function formatCountdown(targetTs) {
  const secs = Math.max(0, targetTs - Math.floor(Date.now() / 1000));
  if (secs <= 0) return 'NOW';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function Flag({ label, bg, color = '#000' }) {
  return (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.5,
      padding: '2px 6px', borderRadius: 2, background: bg, color, fontWeight: 700, flexShrink: 0,
    }}>{label}</span>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, borderBottom: '1px solid #0d0d0d' }}>
      <span style={{ color: 'var(--dim)', letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

function DetailBlock({ label, value, color = 'var(--dim)' }) {
  if (!value) return null;
  return (
    <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(255,255,255,0.03)', border: '1px solid #0d0d0d', borderRadius: 2 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color, letterSpacing: 0.8, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5 }}>{value}</div>
    </div>
  );
}

function DetailSection({ title, color = 'var(--dim)', children }) {
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #0d0d0d' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.8, color, marginBottom: 4 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function fmtPct(value, digits = 2) {
  const num = Number(value || 0);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(digits)}%`;
}

function SlotGroupHeader({ startAt, slotFreedBy }) {
  const isNow = !startAt || startAt <= Math.floor(Date.now() / 1000) + 30;
  if (isNow) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px', background: 'var(--bg2)', borderBottom: '1px solid #0d0d0d',
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, color: '#4cff91', fontWeight: 700 }}>START NOW</span>
        <div style={{ flex: 1, height: 1, background: '#4cff91', opacity: 0.35 }} />
      </div>
    );
  }
  const date = new Date(startAt * 1000);
  const hhmm = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const countdown = formatCountdown(startAt);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', background: 'var(--bg)', borderTop: '1px solid #0d0d0d', borderBottom: '1px solid #0d0d0d',
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, color: '#ff9d3d', fontWeight: 700 }}>{hhmm}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'rgba(255,157,61,0.8)', letterSpacing: 0.4 }}>
        {slotFreedBy ? `slot freed after: ${slotFreedBy}` : 'slot available'}
      </span>
      <div style={{ flex: 1, height: 1, background: '#ff9d3d', opacity: 0.35 }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{countdown}</span>
    </div>
  );
}

// Lane header used when the planner is grouped by character instead of start time.
function CharacterLaneHeader({ character, activeCount, idleCount }) {
  const name = character?.character_name || 'UNASSIGNED';
  const color = character?.character_id ? charColor(character.character_id) : 'var(--planner-idle)';
  return (
    <div className="planner-character-lane__header">
      <span className="planner-character-dot" style={{ background: color }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', letterSpacing: 0.8 }}>{name}</span>
      <div style={{ flex: 1 }} />
      <span className="planner-character-lane__meta">{activeCount} active</span>
      {idleCount > 0 && <span className="planner-character-lane__meta">{idleCount} idle</span>}
    </div>
  );
}

function getCharacterKey(character) {
  if (character?.character_id != null) return `char-${character.character_id}`;
  if (character?.character_name) return `name-${character.character_name}`;
  return 'unassigned';
}

function getManufacturingPrimaryCharacter(item) {
  return item.assigned_character || (item.characters || [])[0] || null;
}

// Break the manufacturing list into per-character lanes so active and idle jobs stay together.
function buildManufacturingCharacterGroups(items) {
  const groups = [];
  const index = new Map();

  for (const item of items) {
    const character = getManufacturingPrimaryCharacter(item);
    const key = getCharacterKey(character);
    if (!index.has(key)) {
      const group = { key, character, activeItems: [], idleItems: [] };
      index.set(key, group);
      groups.push(group);
    }
    const group = index.get(key);
    if (item.is_idle || item.action_type === 'idle_manufacture') {
      group.idleItems.push(item);
    } else {
      group.activeItems.push(item);
    }
  }

  return groups;
}

function SectionHeader({ label, count, accentColor }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', background: 'var(--bg2)', flexShrink: 0,
      borderBottom: '1px solid #0d0d0d',
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, color: accentColor, fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#000', background: accentColor, padding: '2px 6px', borderRadius: 2 }}>{count}</span>
      <div style={{ flex: 1, height: 1, background: accentColor, opacity: 0.35 }} />
    </div>
  );
}

function IdleQueueRow({ item }) {
  const assignedCharacter = item.assigned_character || (item.characters || [])[0] || null;
  return (
    <div style={{ borderBottom: '1px solid #0d0d0d' }}>
      <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 10px', background: 'rgba(255,255,255,0.025)', opacity: 0.9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <div style={{ width: 12, flexShrink: 0 }} />
          <span style={{ width: 10, flexShrink: 0 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--dim)', letterSpacing: 0.8 }}>IDLE</span>
            <Flag label="NO JOB" bg="#6c737d" color="#000" />
            {assignedCharacter && (
              <CharTag
                name={assignedCharacter.character_name}
                color={charColor(assignedCharacter.character_id)}
                bordered={false}
                style={{ fontSize: 10 }}
              />
            )}
          </div>
        </div>
        <div className="planner-idle-reason" style={{ paddingLeft: 28 }}>
          {item.idle_reason || item.why || 'No eligible manufacturing job remains for this character.'}
        </div>
      </div>
    </div>
  );
}

// Main manufacturing recommendation row. Checkbox, badges, and the expandable detail drawer live here.
const ManufacturingQueueRow = memo(function ManufacturingQueueRow({ item, hasMfgSlot, cycleConfig, isOpen, onToggle, checked, onCheck }) {
  const profitPerCycle = item.profit_per_cycle || item.net_profit || 0;
  const runsPerCycle = item.runs_per_cycle || 1;
  const cycleWindowFit = item.cycle_window_fit || 'fits';
  const saturationPct = item.market_saturation_pct || 0;
  const daysToSell = item.days_to_sell || 0;
  const exceeds = cycleWindowFit === 'exceeds';
  const belowThreshold = !item.passes_profit_filter;
  const saturated = !item.passes_saturation_filter;
  const matReady = item.mats_ready !== false;
  const capitalWarn = item.capital_warning === true;
  const profitM = (profitPerCycle / 1_000_000).toFixed(1);
  const missingMatCost = Number(item.missing_mats_est_cost || 0);
  const batchRuns = Math.max(1, Number(item.rec_runs || item.runs_per_cycle || 1));
  const materials = (item.material_breakdown || []).map((material) => {
    const perRunQty = Number(material.quantity || 0);
    const neededQtyTotal = material.needed_qty_total != null
      ? Number(material.needed_qty_total || 0)
      : perRunQty * batchRuns;
    const totalLineCost = material.total_line_cost != null
      ? Number(material.total_line_cost || 0)
      : Number(material.line_cost || 0) * batchRuns;
    return {
      ...material,
      have_qty: material.have_qty != null ? Number(material.have_qty || 0) : null,
      needed_qty_total: neededQtyTotal,
      total_line_cost: totalLineCost,
    };
  });
  const totalMaterialsCost = materials.reduce((sum, material) => sum + Number(material.total_line_cost || 0), 0);
  const jobCost = Number(item.job_cost || 0);
  const jc = item.job_cost_breakdown;
  const scaleCost = (value) => fmtISK(Number(value || 0));

  const handleCheck = useCallback((e) => {
    e.stopPropagation();
    onCheck?.(!checked);
  }, [checked, onCheck]);

  return (
    <div style={{ borderBottom: '1px solid #0d0d0d' }}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', padding: '6px 10px',
          cursor: 'pointer', background: 'var(--table-row-bg)',
          opacity: belowThreshold || saturated ? 0.6 : 1,
        }}
        onClick={onToggle}
        onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.15)'; }}
        onMouseLeave={e => { e.currentTarget.style.filter = ''; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {/* Checkbox */}
          <div onClick={handleCheck} style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={!!checked}
              onChange={() => {}}
              style={{ width: 12, height: 12, cursor: 'pointer', accentColor: '#4cff91', flexShrink: 0 }}
            />
          </div>
          <span style={{ fontSize: 10, color: 'var(--dim)', flexShrink: 0, userSelect: 'none', display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
          {item.output_id && (
            <img src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`} alt=""
              style={{ width: 18, height: 18, opacity: 0.85, flexShrink: 0 }}
              onError={e => { e.target.style.display = 'none'; }} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0 }}>{item.name}</span>
            {(item.ownership || []).includes('personal_bpo') && <Flag label="PERS BPO" bg="#4da6ff" />}
            {(item.ownership || []).includes('personal_bpc') && <Flag label="PERS BPC" bg="#66ccff" />}
            {(item.ownership || []).includes('corp_bpo') && <Flag label="CORP BPO" bg="#9098a1" />}
            {(item.characters || []).map(c => (
              <CharTag key={c.character_id} name={c.character_name} color={charColor(c.character_id)} bordered={false} style={{ fontSize: 10 }} />
            ))}
          </div>
          <div className="planner-row-flags">
            {!hasMfgSlot && <Flag label="NO SLOT" bg="#ff4700" />}
            {item.is_fallback && <Flag label="FILLER" bg="#b0b0b0" />}
            {capitalWarn && <Flag label="CAPITAL" bg="#ffd24d" />}
            {exceeds && <Flag label="EXCEEDS CYCLE" bg="#ff4700" />}
            {saturated && <Flag label={`SATURATED ${saturationPct.toFixed(0)}%`} bg="#ffd24d" />}
            {belowThreshold && <Flag label="BELOW THRESHOLD" bg="#b0b0b0" />}
          </div>
        </div>
        <div className="planner-row-subline planner-row-subline--mfg">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>{runsPerCycle}× runs/cycle</span>
            {!matReady && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ff9d3d', letterSpacing: 0.6, flexShrink: 0 }}>
                MATS
              </span>
            )}
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: profitPerCycle >= 0 ? '#4cff91' : 'var(--accent)' }}>{profitM}M ISK/cycle</span>
        </div>
      </div>

      {isOpen && (
        <div style={{ background: 'var(--bg2)', borderLeft: '3px solid var(--planner-mfg)', padding: '8px 12px', borderBottom: '1px solid #0d0d0d' }}>
          <div className="planner-detail-grid">
            <div>
              <DetailRow label="Duration" value={formatSeconds(item.duration_secs || item.duration_seconds || 0)} />
              <DetailRow label="Net profit/run" value={`${((item.net_profit || 0) / 1_000_000).toFixed(1)}M`} />
              <DetailRow label="Material cost" value={fmtISK(item.material_cost || 0)} />
              <DetailRow label="Total job cost" value={jobCost > 0 ? fmtISK(jobCost) : '—'} />
              {item.skill_time_bonus_pct > 0 && <DetailRow label="Skill time bonus" value={`−${item.skill_time_bonus_pct.toFixed(1)}%`} />}
              {item.structure_job_time_bonus_pct > 0 && <DetailRow label="Structure time bonus" value={`−${Number(item.structure_job_time_bonus_pct).toFixed(1)}%`} />}
              {item.me_bonus_pct > 0 && <DetailRow label="ME rig bonus" value={`−${item.me_bonus_pct}% mats`} />}
              {item.te_bonus_pct > 0 && <DetailRow label="TE rig bonus" value={`−${item.te_bonus_pct}% time`} />}
              {item.capital_share_pct > 0 && <DetailRow label="Capital lock" value={`${item.capital_share_pct.toFixed(1)}% of wallet`} />}
            </div>
            <div>
              <DetailRow label="Market vol/day" value={(item.avg_daily_volume || 0).toFixed(1)} />
              <DetailRow label="Saturation" value={`${saturationPct.toFixed(1)}%`} />
              <DetailRow label="Days to sell" value={`${daysToSell.toFixed(1)}d`} />
              <DetailRow label="Haul volume" value={`${Number(item.haul_volume_m3 || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} m3`} />
              <DetailRow label="Haul ISK / m3" value={item.haul_isk_per_m3 ? fmtISK(item.haul_isk_per_m3) : '—'} />
              <DetailRow label="Blueprint cap" value={`${item.direct_parallel_cap || 0} parallel`} />
              <DetailRow label="Usable BPCs" value={`${item.direct_bpc_usable_parallel || 0}/${item.direct_bpc_count || 0}`} />
              <DetailRow label="BPC runs available" value={`${item.direct_bpc_total_runs || 0}`} />
            </div>
          </div>
          {jc && (
            <DetailSection title="JOB COST" color="#7ec8ff">
              <DetailRow label="Estimated item value (EIV)" value={scaleCost(jc.eiv)} />
              <DetailRow label="System cost index" value={`${((Number(jc.sci || 0)) * 100).toFixed(2)}% EIV`} />
              <DetailRow label="Job gross cost" value={scaleCost(jc.gross)} />
              {(jc.gross_bonus_amount ?? 0) !== 0 && (
                <>
                  <DetailRow label="Structure role bonus" value={`${((Number(jc.role_bonus || 0)) * 100).toFixed(1)}%`} />
                  {Number(jc.rig_bonus || 0) !== 0 && <DetailRow label="Rig bonus" value={`${((Number(jc.rig_bonus || 0)) * 100).toFixed(1)}%`} />}
                  <DetailRow label="Bonuses" value={scaleCost(jc.gross_bonus_amount)} />
                </>
              )}
              <DetailRow label="Total job gross cost" value={scaleCost(jc.gross_after_bonus)} />
              <DetailRow label="Facility tax" value={`${((Number(jc.facility_tax_rate || 0)) * 100).toFixed(2)}% EIV · ${scaleCost(jc.facility_tax)}`} />
              <DetailRow label="SCC surcharge" value={`${((Number(jc.scc_surcharge_rate || 0)) * 100).toFixed(2)}% EIV · ${scaleCost(jc.scc_surcharge)}`} />
              <DetailRow label="Total taxes" value={scaleCost(jc.taxes_total ?? ((jc.facility_tax || 0) + (jc.scc_surcharge || 0)))} />
              <DetailRow label="Total job cost" value={scaleCost(jc.total_job_cost || item.job_cost || 0)} />
            </DetailSection>
          )}
          {materials.length > 0 && (
            <DetailSection title={`MATERIALS (${materials.length})`}>
              {materials.map((material) => (
                <DetailRow
                  key={material.type_id}
                  label={material.name || `Type ${material.type_id}`}
                  value={material.have_qty != null && Number(material.have_qty) < Number(material.needed_qty_total || 0)
                    ? `${Number(material.have_qty).toLocaleString('en-US')}/${Number(material.needed_qty_total || 0).toLocaleString('en-US')}`
                    : `${Number(material.needed_qty_total || 0).toLocaleString('en-US')}`}
                  valueColor={material.have_qty != null && Number(material.have_qty) < Number(material.needed_qty_total || 0)
                    ? '#ff5f5f'
                    : '#4cff91'}
                />
              ))}
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)' }}>TOTAL</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                  {fmtISK(totalMaterialsCost)}
                </span>
              </div>
            </DetailSection>
          )}
          <DetailBlock label="WHY THIS WON" value={item.why} color="#4cff91" />
          {item.runner_up_name && (
            <DetailBlock
              label="RUNNER-UP"
              value={`${item.runner_up_name} · ${((item.runner_up_profit_per_cycle || 0) / 1_000_000).toFixed(1)}M/cycle`}
              color="#ff9d3d"
            />
          )}
        </div>
      )}
    </div>
  );
});

// Manufacturing column supports both views:
// - character: lane per pilot
// - time: slot timing groups first, idle rows at the bottom
export default memo(function ManufacturingQueueColumn({ items, cycleConfig, maxJobs, freeSlots, onItemExpand, expandedId, checkedIds, onCheck, groupMode = 'character' }) {
  const idleItems = items?.filter(i => i.is_idle) || [];
  const mfgItems = items?.filter(i => i.action_type === 'manufacture') || [];
  const characterGroups = buildManufacturingCharacterGroups(items || []);
  const nowTs = Math.floor(Date.now() / 1000);
  const availableManufacturingIds = new Set(
    mfgItems
      .filter((item) => !item.start_at || item.start_at <= nowTs + 30)
      .slice(0, Math.max(0, Number(freeSlots || 0)))
      .map((item) => item.rec_id || String(item.output_id))
  );

  if (idleItems.length === 0 && mfgItems.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 0.8, textAlign: 'center' }}>
        NO MANUFACTURING JOBS RECOMMENDED
      </div>
    );
  }

  // Time-grouped mode clusters rows by when a manufacturing slot becomes available.
  const groups = [];
  let currentGroup = null;
  for (const item of mfgItems) {
    const isNow = !item.start_at || item.start_at <= nowTs + 30;
    const groupKey = isNow ? 'now' : item.start_at;
    if (!currentGroup || currentGroup.key !== groupKey) {
      currentGroup = { key: groupKey, startAt: isNow ? null : item.start_at, slotFreedBy: item.slot_freed_by || null, items: [] };
      groups.push(currentGroup);
    }
    currentGroup.items.push(item);
  }

  const renderActiveGroups = (groupItems, keyPrefix) => {
    const sectionGroups = [];
    let currentSectionGroup = null;
    for (const item of groupItems) {
      const isNow = !item.start_at || item.start_at <= nowTs + 30;
      const groupKey = isNow ? 'now' : item.start_at;
      if (!currentSectionGroup || currentSectionGroup.key !== groupKey) {
        currentSectionGroup = { key: groupKey, startAt: isNow ? null : item.start_at, slotFreedBy: item.slot_freed_by || null, items: [] };
        sectionGroups.push(currentSectionGroup);
      }
      currentSectionGroup.items.push(item);
    }

    return sectionGroups.map((group, gi) => (
      <div key={`${keyPrefix}-${group.key}`}>
        <SlotGroupHeader startAt={group.startAt} slotFreedBy={group.slotFreedBy} />
        {group.items.map((item, idx) => (
          <ManufacturingQueueRow
            key={item.rec_id || `${item.output_id}-${idx}`}
            item={item}
            hasMfgSlot={availableManufacturingIds.has(item.rec_id || String(item.output_id))}
            cycleConfig={cycleConfig}
            isOpen={expandedId === (item.rec_id || String(item.output_id))}
            onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
            checked={checkedIds?.has(item.rec_id || String(item.output_id))}
            onCheck={(val) => onCheck?.(item.rec_id || String(item.output_id), val)}
          />
        ))}
      </div>
    ));
  };

  if (groupMode === 'character') {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {characterGroups.map((group) => (
          <div key={group.key} className="planner-character-lane">
            {/* Per-character heading row */}
            <CharacterLaneHeader character={group.character} activeCount={group.activeItems.length} idleCount={group.idleItems.length} />
            {renderActiveGroups(group.activeItems, `${group.key}-mfg`)}
            {group.idleItems.length > 0 && (
              <>
                <SectionHeader label="IDLE" count={group.idleItems.length} accentColor="var(--planner-idle)" />
                {group.idleItems.map((item, idx) => (
                  <IdleQueueRow key={item.rec_id || `${group.key}-idle-manufacture-${idx}`} item={item} />
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {groups.map((group, gi) => (
        <div key={group.key}>
          <SlotGroupHeader startAt={group.startAt} slotFreedBy={group.slotFreedBy} />
          {group.items.map((item, idx) => (
            <ManufacturingQueueRow
              key={item.rec_id || `${item.output_id}-${idx}`}
              item={item}
              hasMfgSlot={gi === 0 && idx < freeSlots}
              cycleConfig={cycleConfig}
              isOpen={expandedId === (item.rec_id || String(item.output_id))}
              onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
              checked={checkedIds?.has(item.rec_id || String(item.output_id))}
              onCheck={(val) => onCheck?.(item.rec_id || String(item.output_id), val)}
            />
          ))}
        </div>
      ))}
      {idleItems.length > 0 && (
        <div>
          <SectionHeader label="IDLE" count={idleItems.length} accentColor="var(--planner-idle)" />
          {idleItems.map((item, idx) => (
            <IdleQueueRow key={item.rec_id || `idle-manufacture-${idx}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});
