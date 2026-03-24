import { memo } from 'react';
import { fmtISK } from '../utils/fmt';

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
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.5,
      padding: '2px 6px', borderRadius: 2, background: bg, color: '#000', fontWeight: 700, flexShrink: 0,
    }}>{label}</span>
  );
}

function DetailRow({ label, value, valueColor = 'var(--text)' }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 11, borderBottom: '1px solid #0d0d0d' }}>
      <span style={{ color: 'var(--dim)', letterSpacing: 0.3 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', color: valueColor }}>{value}</span>
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

function StepBlock({ title, accentColor, rows, footnote }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(255,255,255,0.03)', border: '1px solid #0d0d0d', borderRadius: 2 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: accentColor, letterSpacing: 0.8, marginBottom: 6 }}>
        {title}
      </div>
      {rows.map(([label, value]) => (
        <DetailRow key={label} label={label} value={value} />
      ))}
      {footnote && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--dim)', lineHeight: 1.5 }}>
          {footnote}
        </div>
      )}
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
      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, color: accentColor, fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#000', background: accentColor, padding: '2px 6px', borderRadius: 2 }}>{count}</span>
      <div style={{ flex: 1, height: 1, background: `linear-gradient(to right, ${accentColor}66, transparent)` }} />
    </div>
  );
}

const ScienceQueueRow = memo(function ScienceQueueRow({ item, hasSciSlot, cycleConfig, isOpen, onToggle, isInvention }) {
  const profitPerCycle = item.profit_per_cycle || item.net_profit || 0;
  const runsPerCycle = item.runs_per_cycle || 1;
  const cycleWindowFit = item.cycle_window_fit || 'fits';
  const successChance = item.invention_success_chance || 1.0;
  const batchRuns = Math.max(1, Number(item.rec_runs || item.runs_per_cycle || 1));
  const hasBPC = item.has_t1_bpc || false;
  const riskFlag = isInvention && Boolean(item?.cycle_flags?.success_risky);
  const exceeds = cycleWindowFit === 'exceeds';
  const belowThreshold = !item.passes_profit_filter;
  const profitM = (profitPerCycle / 1_000_000).toFixed(1);
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
  const datacoreCostPerRun = Number(inventionDetail?.cost_per_run || 0);
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
  const datacoreBatchCost = datacoreCostPerRun * batchRuns;
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
      copyStepRows.push(['Target invention jobs', Math.max(1, Math.ceil(batchRuns / Math.max(1, Number(item.inv_output_runs_per_bpc || 1)))).toString()]);
    } else {
      copyStepRows.push(['Target manufacturing runs', batchRuns.toString()]);
    }
  }
  const inventionStepRows = [];
  if (isInvention && (inventionDuration > 0 || inventionTotalBatchCost > 0)) {
    inventionStepRows.push(['Duration', formatSeconds(inventionDuration)]);
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
          <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.name}</span>
          <div style={{ display: 'flex', gap: 3, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {!hasSciSlot && <Flag label="NO SLOT" bg="#ff4700" />}
            {riskFlag && <Flag label={`${Math.round(successChance * 100)}% SUCCESS`} bg="#ffd24d" />}
            {exceeds && <Flag label="EXCEEDS CYCLE" bg="#ff4700" />}
            {isInvention && hasBPC && <Flag label="T1 BPC" bg="#4cff91" />}
            {isInvention && !hasBPC && <Flag label="NEED T1 BPC" bg="#ff4700" />}
            {belowThreshold && <Flag label="BELOW THRESHOLD" bg="#b0b0b0" />}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 24, marginTop: 3 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>{runsPerCycle}× runs/cycle</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: profitPerCycle >= 0 ? '#4cff91' : 'var(--accent)' }}>{profitM}M ISK/cycle</span>
        </div>
      </div>

      {isOpen && (
        <div style={{ background: 'var(--bg)', borderLeft: '3px solid #4da6ff', padding: '8px 12px', borderBottom: '1px solid #0d0d0d' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <DetailRow label="Duration" value={formatSeconds(item.science_total_secs || item.duration_secs || item.duration_seconds || 0)} />
              {item.structure_job_time_bonus_pct > 0 && <DetailRow label="Structure time bonus" value={`−${Number(item.structure_job_time_bonus_pct).toFixed(1)}%`} />}
              {isInvention && <DetailRow label="Success chance" value={`${Math.round(successChance * 100)}%`} valueColor={successChanceColor} />}
              {isInvention && optimalChanceWarning && (
                <div style={{ marginTop: 4, fontSize: 11, color: '#ff9d3d', lineHeight: 1.5 }}>
                  {optimalChanceWarning}
                </div>
              )}
              {isInvention && item.inv_output_runs_per_bpc && <DetailRow label="Runs/T2 BPC" value={item.inv_output_runs_per_bpc} />}
              <DetailRow label="Expected batch profit" value={fmtISK(expectedProfit)} valueColor={expectedProfit >= 0 ? '#4cff91' : 'var(--accent)'} />
              <DetailRow label="Profit margin" value={`${expectedMarginPct.toFixed(1)}%`} valueColor={expectedMarginPct >= 0 ? '#4cff91' : 'var(--accent)'} />
            </div>
            <div>
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
            </div>
          </div>
          {(copyStepRows.length > 0 || inventionStepRows.length > 0 || manufacturingStepRows.length > 0) && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #0d0d0d' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.8, color: 'var(--dim)', marginBottom: 4 }}>TIMELINE</div>
              <StepBlock
                title={isInvention ? 'STEP 1 · COPYING' : 'STEP 1 · COPYING'}
                accentColor="#4da6ff"
                rows={copyStepRows}
                footnote={item.action_type === 'copy_first' ? 'This stage only prepares the BPC; manufacturing revenue and profit below reflect the downstream batch once the copy is ready.' : null}
              />
              {isInvention && (
                <StepBlock
                  title={`STEP ${copyStepRows.length > 0 ? '2' : '1'} · INVENTION`}
                  accentColor="#ff9d3d"
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
          {isInvention && Object.keys(datacoreCosts).length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #0d0d0d' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.8, color: 'var(--dim)', marginBottom: 4 }}>DATACORES</div>
              {Object.entries(datacoreCosts).map(([dc, cost]) => (
                <DetailRow key={dc} label={dc} value={`${(cost / 1_000_000).toFixed(1)}M`} />
              ))}
            </div>
          )}
          {Array.isArray(item.timeline_steps) && item.timeline_steps.length > 0 && (
            <DetailBlock label="TIMELINE" value={item.timeline_steps.join(' → ')} color="#4da6ff" />
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

export default memo(function ScienceQueueColumn({ items, cycleConfig, maxScience, freeScience, onItemExpand, expandedId }) {
  const copyItems = items.filter(i => i.action_type === 'copy_first');
  const copyThenInventItems = items.filter(i => i.action_type === 'copy_then_invent');
  const inventItems = items.filter(i => i.action_type === 'invent_first');

  if (copyItems.length === 0 && copyThenInventItems.length === 0 && inventItems.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 0.8, textAlign: 'center' }}>
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
              key={item.rec_id || `${item.output_id}-${idx}`}
              item={item}
              hasSciSlot={idx < freeScience}
              cycleConfig={cycleConfig}
              isOpen={expandedId === (item.rec_id || String(item.output_id))}
              onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
            />
          ))}
        </>
      )}
      {copyThenInventItems.length > 0 && (
        <>
          <SectionHeader label="COPY → INVENT" count={copyThenInventItems.length} accentColor="#ffd24d" />
          {copyThenInventItems.map((item, idx) => (
            <ScienceQueueRow
              key={item.rec_id || `${item.output_id}-${idx}`}
              item={item}
              hasSciSlot={copyItems.length + idx < freeScience}
              cycleConfig={cycleConfig}
              isOpen={expandedId === (item.rec_id || String(item.output_id))}
              onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
              isInvention
            />
          ))}
        </>
      )}
      {inventItems.length > 0 && (
        <>
          <SectionHeader label="INVENT FIRST" count={inventItems.length} accentColor="#ff9d3d" />
          {inventItems.map((item, idx) => (
            <ScienceQueueRow
              key={item.rec_id || `${item.output_id}-${idx}`}
              item={item}
              hasSciSlot={copyItems.length + copyThenInventItems.length + idx < freeScience}
              cycleConfig={cycleConfig}
              isOpen={expandedId === (item.rec_id || String(item.output_id))}
              onToggle={() => onItemExpand(expandedId === (item.rec_id || String(item.output_id)) ? null : (item.rec_id || String(item.output_id)))}
              isInvention
            />
          ))}
        </>
      )}
    </div>
  );
});
