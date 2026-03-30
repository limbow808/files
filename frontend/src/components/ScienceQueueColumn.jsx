import { memo } from 'react';
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
      padding: '2px 6px', borderRadius: 2, background: bg, color: '#000', fontWeight: 700, flexShrink: 0,
    }}>{label}</span>
  );
}

const ACCESS_FLAG_META = {
  personal_bpo: { label: 'PERS BPO', bg: '#4da6ff' },
  personal_bpc: { label: 'PERS BPC', bg: '#66ccff' },
  corp_bpo: { label: 'CORP BPO', bg: '#9098a1' },
  corp_bpc: { label: 'CORP BPC', bg: '#c6a07a' },
  future_personal_bpc: { label: 'FUTURE BPC', bg: '#ffd24d' },
};

function getEffectiveAccessFlag(item) {
  const accessKind = item.assignment_access_kind;
  if (accessKind && ACCESS_FLAG_META[accessKind]) return ACCESS_FLAG_META[accessKind];
  const fallbackKind = (item.ownership || []).find((kind) => ACCESS_FLAG_META[kind]);
  return fallbackKind ? ACCESS_FLAG_META[fallbackKind] : null;
}

function DetailRow({ label, value, valueColor = 'var(--text)' }) {
  return (
    <div className="planner-detail-row">
      <span className="planner-detail-row__label">{label}</span>
      <span className="planner-detail-row__value" style={{ color: valueColor }}>{value}</span>
    </div>
  );
}

function DetailBlock({ label, value, color = 'var(--dim)', className = '' }) {
  if (!value) return null;
  return (
    <div
      className={`planner-detail-card planner-detail-card--note ${className}`.trim()}
      style={{ '--planner-detail-accent': color }}
    >
      <div className="planner-detail-card__title">{label}</div>
      <div className="planner-detail-note">{value}</div>
    </div>
  );
}

function DetailSection({ title, color = 'var(--dim)', children, className = '' }) {
  return (
    <div
      className={`planner-detail-card ${className}`.trim()}
      style={{ '--planner-detail-accent': color }}
    >
      <div className="planner-detail-card__title">{title}</div>
      <div className="planner-detail-card__content">{children}</div>
    </div>
  );
}

function StepBlock({ title, accentColor, rows, footnote, className = '' }) {
  if (!rows.length) return null;
  return (
    <div
      className={`planner-detail-card planner-detail-card--step ${className}`.trim()}
      style={{ '--planner-detail-accent': accentColor }}
    >
      <div className="planner-detail-card__title">{title}</div>
      <div className="planner-detail-card__content">
        {rows.map(([label, value]) => (
          <DetailRow key={label} label={label} value={value} />
        ))}
        {footnote && (
          <div className="planner-detail-footnote">
            {footnote}
          </div>
        )}
      </div>
    </div>
  );
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

function SlotGroupHeader({ startAt, slotFreedBy, accentColor = 'var(--planner-copy)', hideNowHeader = false }) {
  const isNow = !startAt || startAt <= Math.floor(Date.now() / 1000) + 30;
  if (isNow) {
    if (hideNowHeader) return null;
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
      padding: '5px 10px', background: 'var(--bg2)', borderTop: '1px solid #0d0d0d', borderBottom: '1px solid #0d0d0d',
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, color: accentColor, fontWeight: 700 }}>{hhmm}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: accentColor, letterSpacing: 0.4, opacity: 0.8 }}>
        {slotFreedBy ? `slot freed after: ${slotFreedBy}` : 'slot available'}
      </span>
      <div style={{ flex: 1, height: 1, background: accentColor, opacity: 0.35 }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{countdown}</span>
    </div>
  );
}

// Lane header used when the planner is grouped by character instead of start time.
function CharacterLaneHeader({ character, activeCount, idleCount, slotUsage }) {
  const name = character?.character_name || 'UNASSIGNED';
  const color = character?.character_id ? charColor(character.character_id) : 'var(--planner-idle)';
  const running = Math.max(0, Number(slotUsage?.running || 0));
  const total = Math.max(0, Number(slotUsage?.total || 0));
  return (
    <div className="planner-character-lane__header">
      <span className="planner-character-dot" style={{ background: color }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', letterSpacing: 0.8 }}>{name}</span>
      {total > 0 && <span className="planner-character-lane__meta">{running}/{total} slots</span>}
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

function getSciencePrimaryCharacter(item) {
  return item.copy_character || item.assigned_character || (item.characters || [])[0] || item.invent_character || null;
}

// Break the science list into per-character lanes so copy/invention sections can render under each pilot.
function buildScienceCharacterGroups(items) {
  const groups = [];
  const index = new Map();

  for (const item of items) {
    const character = getSciencePrimaryCharacter(item);
    const key = getCharacterKey(character);
    if (!index.has(key)) {
      const group = {
        key,
        character,
        copyItems: [],
        copyThenInventItems: [],
        inventItems: [],
        idleItems: [],
      };
      index.set(key, group);
      groups.push(group);
    }
    const group = index.get(key);
    if (item.is_idle || item.action_type === 'idle_science') {
      group.idleItems.push(item);
    } else if (item.action_type === 'copy_first') {
      group.copyItems.push(item);
    } else if (item.action_type === 'copy_then_invent') {
      group.copyThenInventItems.push(item);
    } else if (item.action_type === 'invent_first') {
      group.inventItems.push(item);
    }
  }

  return groups;
}

function buildScienceGroups(items) {
  const nowTs = Math.floor(Date.now() / 1000);
  const groups = [];
  let currentGroup = null;
  for (const item of items) {
    const isNow = !item.start_at || item.start_at <= nowTs + 30;
    const groupKey = isNow ? 'now' : item.start_at;
    if (!currentGroup || currentGroup.key !== groupKey) {
      currentGroup = {
        key: groupKey,
        startAt: isNow ? null : item.start_at,
        slotFreedBy: item.slot_freed_by || null,
        items: [],
      };
      groups.push(currentGroup);
    }
    currentGroup.items.push(item);
  }
  return groups;
}

function IdleQueueRow({ item }) {
  const assignedCharacter = item.assigned_character || (item.characters || [])[0] || null;
  return (
    <div style={{ borderBottom: '1px solid #0d0d0d' }}>
      <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 10px', background: 'rgba(255,255,255,0.025)', opacity: 0.9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
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
        <div className="planner-idle-reason" style={{ paddingLeft: 16 }}>
          {item.idle_reason || item.why || 'No eligible science job remains for this character.'}
        </div>
      </div>
    </div>
  );
}

// Main science recommendation row. Header badges and the expandable detail drawer live here.
const ScienceQueueRow = memo(function ScienceQueueRow({ item, hasSciSlot, cycleConfig, isOpen, onToggle, isInvention }) {
  const profitPerCycle = item.profit_per_cycle || item.net_profit || 0;
  const scienceCycleRuns = Math.max(1, Number(item.science_cycle_runs || item.runs_per_cycle || 1));
  const scienceCycleLabel = item.science_cycle_label || 'runs';
  const cycleWindowFit = item.cycle_window_fit || 'fits';
  const successChance = item.invention_success_chance || 1.0;
  const batchRuns = Math.max(1, Number(item.expected_runs_covered || item.rec_runs || 1));
  const hasBPC = item.has_t1_bpc || false;
  const riskFlag = isInvention && Boolean(item?.cycle_flags?.success_risky);
  const exceeds = cycleWindowFit === 'exceeds';
  const belowThreshold = !item.passes_profit_filter;
  const hasPrerequisites = item.has_prerequisites === true;
  const profitM = (profitPerCycle / 1_000_000).toFixed(1);
  const expectedSuccessfulBpcs = Number(item.expected_successful_bpcs || 0);
  const timeUntilManufactured = Number(item.time_until_manufactured_secs || 0);
  const inventionDetail = item.invention_detail || null;
  const skillFormula = inventionDetail?.skill_formula || null;
  const optimalChanceGaps = skillFormula ? [
    {
      name: skillFormula.science_skill_1_name,
      level: Number(skillFormula.science_skill_1_level ?? 0),
    },
    {
      name: skillFormula.science_skill_2_name,
      level: Number(skillFormula.science_skill_2_level ?? 0),
    },
    {
      name: skillFormula.encryption_skill_name,
      level: Number(skillFormula.encryption_skill_level ?? 0),
    },
  ].filter((skill) => skill.name && skill.level < 5) : [];
  const missingSkills = optimalChanceGaps.filter((skill) => skill.level <= 0);
  const underleveledSkills = optimalChanceGaps.filter((skill) => skill.level > 0);
  const optimalChanceWarning = [
    missingSkills.length > 0
      ? `Missing Skills: ${missingSkills.map((skill) => `${skill.name} 0/5`).join(' · ')}`
      : null,
    underleveledSkills.length > 0
      ? `Train Higher: ${underleveledSkills.map((skill) => `${skill.name} ${skill.level}/5`).join(' · ')}`
      : null,
  ].filter(Boolean).join('  |  ') || null;
  const successChanceColor = !isInvention || !skillFormula
    ? 'var(--text)'
    : optimalChanceGaps.length === 0
      ? '#4cff91'
      : missingSkills.length > 0
        ? '#ff5f5f'
        : underleveledSkills.some((skill) => skill.level <= 3)
          ? 'var(--accent)'
          : '#ffd24d';
  const datacoreCosts = inventionDetail?.datacore_costs || {};
  const inventionJobCostPerRun = Number(inventionDetail?.job_cost_per_run || 0);
  const inventionTotalCostPerRun = Number(inventionDetail?.total_cost_per_run || item.invention_cost_per_run || 0);
  const copyCostTotal = Number(item.copy_job_cost || 0);
  const copyDuration = Number(item.estimated_copy_secs || item.copy_time_secs || 0);
  const inventionDuration = Number(item.estimated_invent_secs || 0);
  const scienceDuration = Number(item.science_total_secs || 0);
  const manufacturingDuration = Number(item.duration_secs || item.duration || 0);
  const manufacturingMaterialCost = Number(item.material_cost || 0);
  const manufacturingJobCost = Number(item.job_cost || 0);
  const manufacturingSalesTax = Number(item.sales_tax || 0);
  const manufacturingBrokerFee = Number(item.broker_fee || 0);
  const manufacturingTotalCost = manufacturingMaterialCost + manufacturingJobCost + manufacturingSalesTax + manufacturingBrokerFee;
  const datacoreMaterials = (item.material_breakdown || []).filter((material) => material.group === 'datacore');
  const datacoreBatchCost = datacoreMaterials.reduce((sum, material) => sum + Number(material.total_line_cost || 0), 0);
  const missingDatacoreCost = datacoreMaterials.reduce((sum, material) => sum + Number(material.missing_line_cost || 0), 0);
  const inventionJobBatchCost = inventionJobCostPerRun * batchRuns;
  const inventionTotalBatchCost = inventionTotalCostPerRun * batchRuns;
  const sciencePrepCostTotal = copyCostTotal + inventionTotalBatchCost;
  const expectedRevenue = Number(item.gross_revenue || 0);
  const expectedProfit = Number(item.profit_per_cycle || item.net_profit || 0);
  const expectedMarginPct = expectedRevenue > 0 ? (expectedProfit / expectedRevenue) * 100 : 0;
  const downstreamProfit = expectedRevenue - manufacturingTotalCost;
  const expectedSuccessfulBpcCost = Number(inventionDetail?.cost_per_bpc || 0)
    + Number(inventionDetail?.job_cost_per_successful_bpc || 0);
  const copyStepRows = [];
  if (copyDuration > 0 || copyCostTotal > 0) {
    copyStepRows.push(['Install cost', fmtISK(copyCostTotal)]);
    copyStepRows.push(['Duration', formatSeconds(copyDuration)]);
    if (item.action_type === 'copy_then_invent') {
      copyStepRows.push(['Target invention attempts', scienceCycleRuns.toString()]);
    } else {
      copyStepRows.push(['Target manufacturing runs', batchRuns.toString()]);
    }
  }
  const inventionStepRows = [];
  if (isInvention && (inventionDuration > 0 || inventionTotalBatchCost > 0)) {
    inventionStepRows.push(['Duration', formatSeconds(inventionDuration)]);
    inventionStepRows.push(['Attempts this cycle', scienceCycleRuns.toString()]);
    inventionStepRows.push(['Expected successful BPCs', expectedSuccessfulBpcs > 0 ? expectedSuccessfulBpcs.toFixed(2) : '—']);
    inventionStepRows.push(['Expected runs covered', batchRuns.toString()]);
    if (skillFormula) {
      inventionStepRows.push(['Base chance', `${Math.round(Number(inventionDetail?.base_success_chance || 0) * 100)}%`]);
      inventionStepRows.push([
        'Science skills',
        `${skillFormula.science_skill_1_name || '—'} ${skillFormula.science_skill_1_level ?? 0} + ${skillFormula.science_skill_2_name || '—'} ${skillFormula.science_skill_2_level ?? 0}`,
      ]);
      inventionStepRows.push([
        'Encryption skill',
        `${skillFormula.encryption_skill_name || '—'} ${skillFormula.encryption_skill_level ?? 0}`,
      ]);
    }
    inventionStepRows.push(['Expected datacore spend', fmtISK(datacoreBatchCost)]);
    if (missingDatacoreCost > 0) {
      inventionStepRows.push(['Missing datacores', fmtISK(missingDatacoreCost)]);
    }
    inventionStepRows.push(['Expected install cost', fmtISK(inventionJobBatchCost)]);
    inventionStepRows.push(['Expected invention total', fmtISK(inventionTotalBatchCost)]);
    inventionStepRows.push(['Expected yield', `${Math.round(successChance * 100)}% · ${item.inv_output_runs_per_bpc || 0} runs/BPC`]);
    if (expectedSuccessfulBpcCost > 0) {
      inventionStepRows.push(['Cost / successful BPC', fmtISK(expectedSuccessfulBpcCost)]);
    }
  }
  const manufacturingStepRows = [];
  if (manufacturingDuration > 0 || manufacturingTotalCost > 0 || expectedRevenue > 0) {
    manufacturingStepRows.push(['Duration', formatSeconds(manufacturingDuration)]);
    manufacturingStepRows.push(['Material cost', fmtISK(manufacturingMaterialCost)]);
    manufacturingStepRows.push(['Install cost', fmtISK(manufacturingJobCost)]);
    manufacturingStepRows.push(['Market fees', fmtISK(manufacturingSalesTax + manufacturingBrokerFee)]);
    manufacturingStepRows.push(['Batch revenue', fmtISK(expectedRevenue)]);
    manufacturingStepRows.push(['Downstream profit', fmtISK(downstreamProfit)]);
    manufacturingStepRows.push(['Net after science', fmtISK(expectedProfit)]);
    manufacturingStepRows.push(['Profit margin', `${expectedMarginPct.toFixed(1)}%`]);
  }
  const manufacturingStepNumber = copyStepRows.length > 0
    ? (isInvention ? 3 : 2)
    : (isInvention ? 2 : 1);
  const copyCharacter = item.copy_character || null;
  const inventCharacter = item.invent_character || null;
  const showSplitAssignments = Boolean(
    item.action_type === 'copy_then_invent'
    && copyCharacter
    && inventCharacter
    && copyCharacter.character_id !== inventCharacter.character_id
  );
  const accessFlag = getEffectiveAccessFlag(item);

  return (
    <div style={{ borderBottom: '1px solid #0d0d0d' }}>
      <div
        style={{
          display: 'flex', flexDirection: 'column', padding: '6px 10px',
          cursor: 'pointer', background: 'var(--table-row-bg)',
          opacity: belowThreshold ? 0.6 : 1,
        }}
        onClick={onToggle}
        onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(1.15)'; }}
        onMouseLeave={e => { e.currentTarget.style.filter = ''; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: 'var(--dim)', flexShrink: 0, userSelect: 'none', display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
          {item.output_id && (
            <img src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`} alt=""
              style={{ width: 18, height: 18, opacity: 0.85, flexShrink: 0 }}
              onError={e => { e.target.style.display = 'none'; }} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0 }}>{item.name}</span>
            {accessFlag && <Flag label={accessFlag.label} bg={accessFlag.bg} />}
            {showSplitAssignments ? (
              <>
                <Flag label="COPY" bg="var(--planner-copy)" />
                <CharTag name={copyCharacter.character_name} color={charColor(copyCharacter.character_id)} bordered={false} style={{ fontSize: 10 }} />
                <Flag label="INVENT" bg="var(--planner-invention)" />
                <CharTag name={inventCharacter.character_name} color={charColor(inventCharacter.character_id)} bordered={false} style={{ fontSize: 10 }} />
              </>
            ) : (
              (item.characters || []).map(c => (
                <CharTag key={c.character_id} name={c.character_name} color={charColor(c.character_id)} bordered={false} style={{ fontSize: 10 }} />
              ))
            )}
          </div>
          <div className="planner-row-flags">
            {!hasSciSlot && <Flag label="NO SLOT" bg="#ff4700" />}
            {hasPrerequisites && <Flag label="CHAIN" bg="#ffd24d" />}
            {riskFlag && <Flag label={`${Math.round(successChance * 100)}% SUCCESS`} bg="#ffd24d" />}
            {exceeds && <Flag label="EXCEEDS CYCLE" bg="#ff4700" />}
            {isInvention && hasBPC && <Flag label="T1 BPC" bg="#4cff91" />}
            {isInvention && !hasBPC && <Flag label="NEED T1 BPC" bg="#ff4700" />}
            {belowThreshold && <Flag label="BELOW THRESHOLD" bg="#b0b0b0" />}
          </div>
        </div>
        <div className="planner-row-subline planner-row-subline--science">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>{scienceCycleRuns}× {scienceCycleLabel}/cycle</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>to mfg {formatSeconds(timeUntilManufactured)}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: profitPerCycle >= 0 ? '#4cff91' : 'var(--accent)' }}>{profitM}M ISK/cycle</span>
        </div>
      </div>

      {isOpen && (
        <div className={`planner-detail-shell ${isInvention ? 'planner-detail-shell--invention' : 'planner-detail-shell--copy'}`}>
          <div className="planner-detail-grid planner-detail-grid--summary">
            <DetailSection
              title="SCIENCE OVERVIEW"
              color={isInvention ? 'var(--planner-invention)' : 'var(--planner-copy)'}
              className="planner-detail-card--summary"
            >
              <DetailRow label="Duration" value={formatSeconds(item.science_total_secs || item.duration_secs || item.duration_seconds || 0)} />
              <DetailRow label="Time until manufactured" value={formatSeconds(timeUntilManufactured)} />
              {item.structure_job_time_bonus_pct > 0 && <DetailRow label="Structure time bonus" value={`−${Number(item.structure_job_time_bonus_pct).toFixed(1)}%`} />}
              {isInvention && <DetailRow label="Success chance" value={`${Math.round(successChance * 100)}%`} valueColor={successChanceColor} />}
              {isInvention && optimalChanceWarning && (
                <div className="planner-detail-warning">
                  {optimalChanceWarning}
                </div>
              )}
              {isInvention && item.inv_output_runs_per_bpc && <DetailRow label="Runs/T2 BPC" value={item.inv_output_runs_per_bpc} />}
              {isInvention && <DetailRow label="Expected successful BPCs" value={expectedSuccessfulBpcs > 0 ? expectedSuccessfulBpcs.toFixed(2) : '—'} />}
              {isInvention && <DetailRow label="Expected runs covered" value={batchRuns} />}
              {hasPrerequisites && <DetailRow label="Prereq time" value={formatSeconds(item.prerequisite_duration_secs || 0)} />}
              {hasPrerequisites && <DetailRow label="Self-craft savings" value={fmtISK(item.prerequisite_buy_cost_avoided || 0)} />}
              <DetailRow label="Expected batch profit" value={fmtISK(expectedProfit)} valueColor={expectedProfit >= 0 ? '#4cff91' : 'var(--accent)'} />
              <DetailRow label="Profit margin" value={`${expectedMarginPct.toFixed(1)}%`} valueColor={expectedMarginPct >= 0 ? '#4cff91' : 'var(--accent)'} />
            </DetailSection>
            <DetailSection title="MARKET + CAPACITY" color="#4da6ff" className="planner-detail-card--summary">
              <DetailRow label="Market vol/day" value={(item.avg_daily_volume || 0).toFixed(1)} />
              <DetailRow label="Saturation" value={`${(item.market_saturation_pct || 0).toFixed(1)}%`} />
              <DetailRow label="Days to sell" value={`${(item.days_to_sell || 0).toFixed(1)}d`} />
              <DetailRow label="Haul volume" value={`${Number(item.haul_volume_m3 || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} m3`} />
              <DetailRow label="Haul ISK / m3" value={item.haul_isk_per_m3 ? fmtISK(item.haul_isk_per_m3) : '—'} />
              <DetailRow label="Blueprint cap" value={`${item.max_parallel || 0} parallel`} />
              {(item.source_bpc_count != null || item.source_bpo_count != null) && (
                <>
                  <DetailRow label="Source BPOs" value={`${item.source_bpo_count || 0}`} />
                  <DetailRow label="Source BPCs" value={`${item.source_bpc_usable_parallel || 0}/${item.source_bpc_count || 0}`} />
                  <DetailRow label="Source BPC runs" value={`${item.source_bpc_total_runs || 0}`} />
                </>
              )}
              {hasPrerequisites && <DetailRow label="Chain duration" value={formatSeconds(item.chain_total_duration_secs || item.time_until_manufactured_secs || 0)} />}
            </DetailSection>
          </div>

          {(copyStepRows.length > 0 || inventionStepRows.length > 0 || manufacturingStepRows.length > 0) && (
            <div className="planner-detail-card-grid planner-detail-card-grid--timeline">
              <StepBlock
                title="STEP 1 · COPYING"
                accentColor="var(--planner-copy)"
                rows={copyStepRows}
                footnote={item.action_type === 'copy_first' ? 'This stage only prepares the BPC; manufacturing revenue and profit below reflect the downstream batch once the copy is ready.' : null}
              />
              {isInvention && (
                <StepBlock
                  title={`STEP ${copyStepRows.length > 0 ? '2' : '1'} · INVENTION`}
                  accentColor="var(--planner-invention)"
                  rows={inventionStepRows}
                  footnote={
                    skillFormula
                      ? `Chance formula: base × (1 + (${skillFormula.science_skill_1_level ?? 0} + ${skillFormula.science_skill_2_level ?? 0}) / 30 + ${skillFormula.encryption_skill_level ?? 0} / 40) × ${Number(skillFormula.decryptor_multiplier || 1).toFixed(2)}. Colors: green = 5/5/5, yellow = one or more skills at 4, orange = one or more skills at 1-3, red = required skill missing.`
                      : (hasBPC ? 'A T1 BPC is already available, so this path skips the copy-prep cost.' : 'Expected costs already include success-chance weighting.')
                  }
                />
              )}
              <StepBlock
                title={`STEP ${manufacturingStepNumber} · MANUFACTURING`}
                accentColor="#4cff91"
                rows={manufacturingStepRows}
                footnote={isInvention ? 'Net after science and profit margin include the expected copy and invention costs, so missing invention skills reduce the final margin.' : 'This stage reflects the downstream batch economics once the copy prep is complete.'}
              />
              <StepBlock
                title="PIPELINE TOTALS"
                accentColor="#4cff91"
                rows={[
                  ['Total science cost', fmtISK(isInvention ? sciencePrepCostTotal : copyCostTotal)],
                  ['Total science time', formatSeconds(scienceDuration || copyDuration)],
                  ['Expected margin', `${expectedMarginPct.toFixed(1)}%`],
                  ['Expected batch revenue', fmtISK(expectedRevenue)],
                  ['Expected batch profit', fmtISK(expectedProfit)],
                ]}
                footnote="Revenue and profit are for the downstream manufacturing batch after science prep completes."
              />
            </div>
          )}

          <div className="planner-detail-card-grid">
            {isInvention && Object.keys(datacoreCosts).length > 0 && (
              <DetailSection title="DATACORES" color="var(--planner-invention)" className="planner-detail-card--dense">
                {datacoreMaterials.length > 0 ? datacoreMaterials.map((material) => (
                  <DetailRow
                    key={material.type_id}
                    label={material.name || `Type ${material.type_id}`}
                    value={`${Number(material.have_qty || 0).toLocaleString()} / ${Number(material.needed_qty_total || 0).toLocaleString()} · ${fmtISK(material.total_line_cost || 0)}`}
                    valueColor={Number(material.have_qty || 0) < Number(material.needed_qty_total || 0) ? '#ff9d3d' : '#4cff91'}
                  />
                )) : Object.entries(datacoreCosts).map(([dc, cost]) => (
                  <DetailRow key={dc} label={dc} value={`${(cost / 1_000_000).toFixed(1)}M`} />
                ))}
              </DetailSection>
            )}
            {hasPrerequisites && Array.isArray(item.prerequisite_jobs) && item.prerequisite_jobs.length > 0 && (
              <DetailSection title={`PREREQUISITES (${item.prerequisite_jobs.length})`} color="#ffd24d" className="planner-detail-card--dense">
                <div className="planner-detail-stack">
                  {item.prerequisite_jobs.map((job) => (
                    <DetailBlock
                      key={`${job.output_id}-${job.run_count}-${job.depth || 0}`}
                      label={job.name}
                      value={`${job.run_count || 0} runs · ${formatSeconds(job.total_duration_secs || job.duration_secs || 0)} · ${fmtISK(job.resolved_total_cost || 0)}`}
                      color="#ffd24d"
                      className="planner-detail-card--subnote"
                    />
                  ))}
                </div>
              </DetailSection>
            )}
            {Array.isArray(item.timeline_steps) && item.timeline_steps.length > 0 && (
              <DetailBlock label="TIMELINE" value={item.timeline_steps.join(' → ')} color="var(--planner-copy)" />
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
        </div>
      )}
    </div>
  );
});

// Science column supports both views:
// - character: lane per pilot
// - time: section bands first, idle rows pinned at the bottom
export default memo(function ScienceQueueColumn({ items, cycleConfig, maxScience, freeScience, characterSlots = {}, onItemExpand, expandedId, groupMode = 'character' }) {
  const idleItems = items.filter(i => i.is_idle);
  const copyItems = items.filter(i => i.action_type === 'copy_first');
  const copyThenInventItems = items.filter(i => i.action_type === 'copy_then_invent');
  const inventItems = items.filter(i => i.action_type === 'invent_first');
  const characterGroups = buildScienceCharacterGroups(items);
  const copyGroups = buildScienceGroups(copyItems);
  const copyThenInventGroups = buildScienceGroups(copyThenInventItems);
  const inventGroups = buildScienceGroups(inventItems);
  const availableScienceIds = new Set(
    [...copyItems, ...copyThenInventItems, ...inventItems]
      .filter((item) => !item.start_at || item.start_at <= Math.floor(Date.now() / 1000) + 30)
      .slice(0, Math.max(0, Number(freeScience || 0)))
      .map((item) => item.rec_id || String(item.output_id))
  );

  const renderScienceSection = (label, sectionItems, accentColor, keyPrefix, isInvention = false) => {
    if (!sectionItems.length) return null;
    const groups = buildScienceGroups(sectionItems);
    return (
      <>
        {/* This header band is the main color accent for each science section. */}
        <SectionHeader label={label} count={sectionItems.length} accentColor={accentColor} />
        {groups.map((group) => (
          <div key={`${keyPrefix}-${group.key}`}>
            <SlotGroupHeader startAt={group.startAt} slotFreedBy={group.slotFreedBy} accentColor={accentColor} hideNowHeader />
            {group.items.map((item, idx) => (
              <ScienceQueueRow
                key={item.rec_id || `${item.output_id}-${idx}`}
                item={item}
                hasSciSlot={availableScienceIds.has(item.rec_id || String(item.output_id))}
                cycleConfig={cycleConfig}
                isOpen={expandedId === (item.rec_id || String(item.output_id))}
                onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
                isInvention={isInvention}
              />
            ))}
          </div>
        ))}
      </>
    );
  };

  if (idleItems.length === 0 && copyItems.length === 0 && copyThenInventItems.length === 0 && inventItems.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 0.8, textAlign: 'center' }}>
        NO SCIENCE JOBS RECOMMENDED
      </div>
    );
  }

  if (groupMode === 'character') {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {characterGroups.map((group) => {
          const activeCount = group.copyItems.length + group.copyThenInventItems.length + group.inventItems.length;
          const charId = String(group.character?.character_id || '');
          return (
            <div key={group.key} className="planner-character-lane">
              {/* Per-character heading row */}
              <CharacterLaneHeader character={group.character} activeCount={activeCount} idleCount={group.idleItems.length} slotUsage={characterSlots[charId]} />
              {renderScienceSection('COPY FIRST', group.copyItems, 'var(--planner-copy)', `${group.key}-copy`, false)}
              {renderScienceSection('COPY → INVENT', group.copyThenInventItems, 'var(--planner-invention)', `${group.key}-copy-invent`, true)}
              {renderScienceSection('INVENT FIRST', group.inventItems, 'var(--planner-invention)', `${group.key}-invent`, true)}
              {group.idleItems.length > 0 && (
                <>
                  <SectionHeader label="IDLE" count={group.idleItems.length} accentColor="var(--planner-idle)" />
                  {group.idleItems.map((item, idx) => (
                    <IdleQueueRow key={item.rec_id || `${group.key}-idle-science-${idx}`} item={item} />
                  ))}
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {copyItems.length > 0 && (
        <>
          <SectionHeader label="COPY FIRST" count={copyItems.length} accentColor="var(--planner-copy)" />
          {copyGroups.map((group) => (
            <div key={`copy-${group.key}`}>
              <SlotGroupHeader startAt={group.startAt} slotFreedBy={group.slotFreedBy} accentColor="var(--planner-copy)" hideNowHeader />
              {group.items.map((item, idx) => (
                <ScienceQueueRow
                  key={item.rec_id || `${item.output_id}-${idx}`}
                  item={item}
                  hasSciSlot={availableScienceIds.has(item.rec_id || String(item.output_id))}
                  cycleConfig={cycleConfig}
                  isOpen={expandedId === (item.rec_id || String(item.output_id))}
                  onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
                />
              ))}
            </div>
          ))}
        </>
      )}
      {copyThenInventItems.length > 0 && (
        <>
          <SectionHeader label="COPY → INVENT" count={copyThenInventItems.length} accentColor="var(--planner-invention)" />
          {copyThenInventGroups.map((group) => (
            <div key={`copy-then-invent-${group.key}`}>
              <SlotGroupHeader startAt={group.startAt} slotFreedBy={group.slotFreedBy} accentColor="var(--planner-invention)" hideNowHeader />
              {group.items.map((item, idx) => (
                <ScienceQueueRow
                  key={item.rec_id || `${item.output_id}-${idx}`}
                  item={item}
                  hasSciSlot={availableScienceIds.has(item.rec_id || String(item.output_id))}
                  cycleConfig={cycleConfig}
                  isOpen={expandedId === (item.rec_id || String(item.output_id))}
                  onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
                  isInvention
                />
              ))}
            </div>
          ))}
        </>
      )}
      {inventItems.length > 0 && (
        <>
          <SectionHeader label="INVENT FIRST" count={inventItems.length} accentColor="var(--planner-invention)" />
          {inventGroups.map((group) => (
            <div key={`invent-${group.key}`}>
              <SlotGroupHeader startAt={group.startAt} slotFreedBy={group.slotFreedBy} accentColor="var(--planner-invention)" hideNowHeader />
              {group.items.map((item, idx) => (
                <ScienceQueueRow
                  key={item.rec_id || `${item.output_id}-${idx}`}
                  item={item}
                  hasSciSlot={availableScienceIds.has(item.rec_id || String(item.output_id))}
                  cycleConfig={cycleConfig}
                  isOpen={expandedId === (item.rec_id || String(item.output_id))}
                  onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
                  isInvention
                />
              ))}
            </div>
          ))}
        </>
      )}
      {idleItems.length > 0 && (
        <>
          <SectionHeader label="IDLE" count={idleItems.length} accentColor="var(--planner-idle)" />
          {idleItems.map((item, idx) => (
            <IdleQueueRow key={item.rec_id || `idle-science-${idx}`} item={item} />
          ))}
        </>
      )}
    </div>
  );
});
