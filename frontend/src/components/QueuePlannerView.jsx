import { Fragment, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useGlobalTick } from '../hooks/useGlobalTick';
import { useApi } from '../hooks/useApi';
import { fmtISK, fmtDuration, roiColor } from '../utils/fmt';
import { LoadingState } from './ui';
import CargoTimelinePanel from './CargoTimelinePanel';
import ScienceQueueColumn from './ScienceQueueColumn';
import ManufacturingQueueColumn from './ManufacturingQueueColumn';
import { API } from '../App';
import { DEFAULT_APP_SETTINGS, facilityToPlannerStructureType } from '../utils/appSettings';

const PLANNER_GROUP_MODE_KEY = 'crest_job_planner_group_mode';
const PLANNER_SHOW_IDLE_KEY = 'crest_job_planner_show_idle';
const PLANNER_SHOW_FUTURE_KEY = 'crest_job_planner_show_future';

function readPlannerGroupMode() {
  if (typeof window === 'undefined') return 'character';
  try {
    const stored = window.localStorage.getItem(PLANNER_GROUP_MODE_KEY);
    return stored === 'time' ? 'time' : 'character';
  } catch {
    return 'character';
  }
}

function readPlannerShowIdle() {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(PLANNER_SHOW_IDLE_KEY);
    return stored !== 'false';
  } catch {
    return true;
  }
}

function readPlannerShowFuture() {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(PLANNER_SHOW_FUTURE_KEY);
    return stored !== 'false';
  } catch {
    return true;
  }
}

const OWN_COLORS = {
  personal_bpo: { fill: '#4cff91', label: 'PERS BPO' },
  personal_bpc: { fill: '#4cff91', label: 'PERS BPC' },
  corp_bpo:     { fill: '#B0B0B0', label: 'CORP BPO' },
  corp_bpc:     { fill: '#B0B0B0', label: 'CORP BPC' },
  // legacy fallbacks
  personal:     { fill: '#4cff91', label: 'PERS' },
  corp:         { fill: '#B0B0B0', label: 'CORP' },
};

function OwnBadge({ kind }) {
  const c = OWN_COLORS[kind];
  if (!c) return null;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', fontSize: 9, letterSpacing: 0.5,
      background: c.fill, color: '#000',
      borderRadius: 0, fontWeight: 700, flexShrink: 0, minWidth: 44, textAlign: 'center',
    }}>{c.label}</span>
  );
}

// Slot squares that wrap — fully flexible for any slot count
function SlotDots({ total, occupied, activeColor }) {
  const SZ = 6;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, maxWidth: 140 }}>
      {Array.from({ length: Math.max(total, 1) }).map((_, i) => (
        <div key={i} style={{
          width: SZ, height: SZ, borderRadius: 0,
          background: i < occupied ? activeColor : '#4cff91',
          border: '0px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }} title={i < occupied ? 'In use' : 'Free'} />
      ))}
    </div>
  );
}

function QueuePaneHeader({ label, total, occupied, activeColor, summary, tone = 'science' }) {
  const free = Math.max(0, total - occupied);
  const freeColor = free > 0 ? '#4cff91' : 'var(--accent)';
  return (
    <div className={`planner-pane-header planner-pane-header--${tone}`}>
      <div className="planner-pane-header__top">
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1.2, color: 'var(--text)', whiteSpace: 'nowrap' }}>{label}</span>
        <SlotDots total={total} occupied={occupied} activeColor={activeColor} />
        <div className="planner-pane-header__meta">
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: freeColor, whiteSpace: 'nowrap' }}>
            {free > 0 ? `${free} FREE` : 'FULL'}
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
            {occupied}/{total} USED
          </span>
        </div>
        <span className="planner-pane-header__summary">{summary}</span>
      </div>
    </div>
  );
}

function QueueColumnHeaders() {
  const cell = (label, align = 'left', width) => (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.8, color: 'var(--dim)',
      textAlign: align, flexShrink: 0, ...(width ? { width } : { flex: 1, minWidth: 0 }),
    }}>{label}</div>
  );
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', background: 'var(--bg2)', borderBottom: '1px solid #0d0d0d',
      flexShrink: 0,
    }}>
      {cell('#',          'center', 26)}
      {cell('',           'center', 16)}   {/* activity squares */}
      {cell('',           'left',   20)}   {/* icon */}
      {cell('ITEM',       'left')}
      {cell('QTY',        'right',  38)}
      {cell('COPY READY', 'right',  86)}
      {cell('ISK/H',      'right',  96)}
      <div style={{ width: 10 }} />         {/* expand toggle */}
    </div>
  );
}

function SectionHeader({ label, count, rightLabel, accentColor }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', background: 'var(--bg2)',
      borderTop: '1px solid #0d0d0d', borderBottom: '1px solid #0d0d0d',
      flexShrink: 0,
    }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1.2,
        color: accentColor, fontWeight: 700,
      }}>{label}</span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: '#000',
        background: accentColor, padding: '2px 6px', borderRadius: 2,
      }}>{count} ITEMS</span>
      <div style={{
        flex: 1, height: 1, marginLeft: 4, marginRight: 4,
        background: accentColor, opacity: 0.35,
      }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.5, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
        {rightLabel}
      </span>
    </div>
  );
}

function ActivitySquares({ isCopy, hasSciSlot }) {
  const SZ = 8;
  if (isCopy) {
    const c = hasSciSlot ? '#4da6ff' : 'rgba(255,255,255,0.15)';
    const o = hasSciSlot ? '#ff4700' : 'rgba(255,255,255,0.12)';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0, width: SZ }}>
        <div style={{ width: SZ, height: SZ, borderRadius: 1, background: c }} title="Science slot" />
        <div style={{ width: SZ, height: SZ, borderRadius: 1, background: o }} title="MFG slot (after copy)" />
      </div>
    );
  }
  return (
    <div style={{ width: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
      <div style={{ width: SZ, height: SZ, borderRadius: 1, background: '#ff4700' }} title="MFG slot" />
    </div>
  );
}

function IskHrBar({ value, maxValue }) {
  const pct = maxValue > 0 ? Math.min(100, (value / maxValue) * 100) : 0;
  const color = value > maxValue * 0.66 ? '#4cff91' : value > maxValue * 0.33 ? 'var(--accent)' : 'var(--dim)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0, width: 90 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color, whiteSpace: 'nowrap' }}>
        {fmtISK(value)}
      </span>
      <div style={{ width: '100%', height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

const BADGE = {
  startCopy:  { label: 'START COPY',          bg: '#b0b0b0', color: '#000' },
  waitSci:    { label: 'WAITING FOR SCI SLOT', bg: '#b0b0b0', color: '#000' },
  ready:      { label: 'READY TO QUEUE',       bg: '#4cff91', color: '#000' },
  buyMats:    { label: 'BUY MATS',             bg: '#ff4700', color: '#000' },
  slotWait:   { label: 'SLOT OPENING',         bg: '#b0b0b0', color: '#000' },
};

function StatusBadge({ b }) {
  return (
    <span style={{
      display: 'inline-block', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.5,
      padding: '3px 7px', borderRadius: 2, background: b.bg, color: '#000',
      fontWeight: 700, flexShrink: 0,
    }}>{b.label}</span>
  );
}

// Exact live countdown using useGlobalTick + ref — no approximation tilde
function LiveCountdown({ targetTs, readyText = 'NOW', style = {} }) {
  const ref = useRef(null);
  useGlobalTick(() => {
    if (!ref.current) return;
    const secs = Math.max(0, targetTs - Math.floor(Date.now() / 1000));
    if (secs <= 0) {
      ref.current.textContent = readyText;
      ref.current.style.color = '#4cff91';
      return;
    }
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    ref.current.textContent = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
    ref.current.style.color = secs < 3600 ? 'var(--accent)' : 'var(--dim)';
  });
  return <span ref={ref} style={{ fontFamily: 'var(--mono)', fontSize: 11, ...style }} />;
}

function QueueRow({ item, globalIdx, queueType, hasSciSlot, runningScience, isOpen, onToggle, calcItem, maxIskHr }) {
  const now       = Math.floor(Date.now() / 1000);
  const isCopy    = queueType === 'sci';
  const iskHr     = item.adj_isk_per_hour ?? item.isk_per_hour ?? 0;
  const startSecs = Math.max(0, (item.start_at || now) - now);

  // Sub-line badge + text
  let badge, subText;
  if (isCopy) {
    if (hasSciSlot) {
      badge   = BADGE.startCopy;
      subText = null; // LiveCountdown used instead
    } else {
      badge   = BADGE.waitSci;
      subText = `${runningScience} slots occupied`;
    }
  } else {
    if (startSecs > 30) {
      badge   = BADGE.slotWait;
      subText = null; // LiveCountdown used instead
    } else if (!item.mats_ready && item.missing_mats_est_cost > 0) {
      badge   = BADGE.buyMats;
      subText = `~${fmtISK(item.missing_mats_est_cost)} needed`;
    } else if (item.producing_qty > 0) {
      badge   = null;
      subText = `▶ Already manufacturing (${item.producing_qty} units in flight)`;
    } else {
      badge   = BADGE.ready;
      subText = null;
    }
  }

  // COPY READY column value
  const copyReadyTs = isCopy ? item.manufacture_at : (startSecs > 30 ? item.start_at : null);

  return (
    <>
      <div
        className="eve-row-reveal"
        style={{
          display: 'flex', flexDirection: 'column',
          padding: '6px 10px', borderBottom: '1px solid #0d0d0d',
          cursor: 'pointer', background: 'var(--table-row-bg)',
          animationDelay: `${globalIdx * 20}ms`,
        }}
        onClick={onToggle}
      >
        {/* Main row — matches column headers */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>

          {/* # */}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)',
            fontWeight: 700, width: 26, textAlign: 'center', flexShrink: 0,
          }}>#{globalIdx + 1}</span>

          {/* Activity squares */}
          <ActivitySquares isCopy={isCopy} hasSciSlot={hasSciSlot} />

          {/* Icon */}
          <div style={{ width: 20, flexShrink: 0 }}>
            {item.output_id && (
              <img
                src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`}
                alt=""
                style={{ width: 20, height: 20, opacity: 0.85, display: 'block' }}
                onError={e => { e.target.style.display = 'none'; }}
              />
            )}
          </div>

          {/* Name + ownership */}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 300, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
          }}>{item.name}</span>

          {/* QTY */}
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', width: 38, textAlign: 'right', flexShrink: 0 }}>
            {(item.rec_runs || 0) > 1 ? `×${item.rec_runs}` : ''}
          </span>

          {/* COPY READY — live countdown */}
          <div style={{ width: 86, textAlign: 'right', flexShrink: 0 }}>
            {copyReadyTs
              ? <LiveCountdown targetTs={copyReadyTs} readyText="NOW" />
              : <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>—</span>
            }
          </div>

          {/* ISK/H bar */}
          <IskHrBar value={iskHr} maxValue={maxIskHr} />

          {/* Expand toggle */}
          <span style={{ fontSize: 9, color: 'var(--dim)', width: 10, textAlign: 'right', flexShrink: 0, userSelect: 'none' }}>
            {isOpen ? '▲' : '▼'}
          </span>
        </div>

        {/* Ownership badges — sub-row left-aligned under name */}
        {(item.ownership || []).length > 0 && (
          <div style={{ display: 'flex', gap: 3, paddingLeft: 62, marginTop: 2 }}>
            {(item.ownership || []).map(o => <OwnBadge key={o} kind={o} />)}
          </div>
        )}

        {/* Status sub-line */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 62, marginTop: 3 }}>
          {badge && <StatusBadge b={badge} />}
          {/* Text or live countdown after badge */}
          {isCopy && hasSciSlot && copyReadyTs && (
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 0.3 }}>
              copy ready in <LiveCountdown targetTs={copyReadyTs} readyText="NOW" style={{ color: 'var(--text)' }} /> · then MFG
            </span>
          )}
          {!isCopy && startSecs > 30 && item.start_at && (
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 0.3 }}>
              slot opens in <LiveCountdown targetTs={item.start_at} readyText="NOW" style={{ color: 'var(--accent)' }} />
            </span>
          )}
          {subText && (
            <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 0.3 }}>{subText}</span>
          )}
        </div>
      </div>

      {isOpen && <QueueDetailExpanded item={item} calcItem={calcItem} />}
    </>
  );
}

function GraduatedStrip({ names }) {
  if (!names.length) return null;
  return (
    <div style={{
      padding: '4px 10px', borderBottom: '1px solid #0d0d0d',
      background: 'var(--bg2)', fontSize: 10,
      color: 'rgba(77,166,255,0.65)', fontFamily: 'var(--mono)', letterSpacing: 0.5,
      fontStyle: 'italic',
    }}>
      ↓ GRADUATED TO MFG QUEUE AFTER LAST REFRESH — {names.join(', ')}
    </div>
  );
}

// ── Queue Detail Expanded ─────────────────────────────────────────────────────

function QueueDetailExpanded({ item, calcItem }) {
  const runs = Math.max(1, Number(item?.rec_runs || 1));
  const materials = useMemo(() => {
    const source = item?.material_breakdown?.length ? item.material_breakdown : (calcItem?.material_breakdown || []);
    return source.map(material => {
      const perRunQty = Number(material.quantity || 0);
      const haveQty = material.have_qty != null ? Number(material.have_qty || 0) : null;
      const neededQtyTotal = material.needed_qty_total != null ? Number(material.needed_qty_total || 0) : perRunQty * runs;
      const totalLineCost = material.total_line_cost != null ? Number(material.total_line_cost || 0) : Number(material.line_cost || 0) * runs;
      return {
        ...material,
        have_qty: haveQty,
        needed_qty_total: neededQtyTotal,
        total_line_cost: totalLineCost,
      };
    });
  }, [calcItem?.material_breakdown, item?.material_breakdown, runs]);
  const totalMaterialsCost = useMemo(
    () => materials.reduce((sum, material) => sum + Number(material.total_line_cost || 0), 0),
    [materials]
  );
  const tierClr   = roiColor(item.roi);
  const netProfitShown = item?.adj_net_profit ?? item?.net_profit;
  const iskHrShown = item?.adj_isk_per_hour ?? item?.isk_per_hour;
  const revenueShown = item?.gross_revenue ?? calcItem?.gross_revenue;
  const jc = calcItem?.job_cost_breakdown;
  const [mfgOpen,  setMfgOpen]  = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);

  return (
    <div style={{
      background: 'var(--table-row-bg)', borderLeft: `3px solid ${tierClr}`,
      padding: '10px 14px', borderBottom: '1px solid #0d0d0d',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>

        {/* Materials */}
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 6 }}>
            ◈ MATERIALS ({materials.length})
          </div>
          {materials.length > 0 ? materials.map((m, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr auto',
              gap: 8, padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d',
            }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.name || `Type ${m.type_id}`}
              </span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)', textAlign: 'right', minWidth: 88 }}>
                {m.have_qty != null
                  ? `${new Intl.NumberFormat('en-US').format(m.have_qty)}/${new Intl.NumberFormat('en-US').format(m.needed_qty_total)}`
                  : `${new Intl.NumberFormat('en-US').format(m.needed_qty_total)}`}
              </span>
            </div>
          )) : (
            <div style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 1 }}>
              {calcItem ? 'NO MATERIAL DATA' : 'RUN CALCULATOR FOR MATERIAL DATA'}
            </div>
          )}
          {materials.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)' }}>TOTAL</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                {fmtISK(totalMaterialsCost)}
              </span>
            </div>
          )}
        </div>

        {/* Cost breakdown */}
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 6 }}>◈ COST BREAKDOWN</div>

          {/* Material Cost */}
          {calcItem?.material_cost != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d' }}>
              <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>Material Cost</span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{fmtISK(calcItem.material_cost)}</span>
            </div>
          )}

          {/* MFG Job — clickable header */}
          {calcItem?.job_cost != null && (
            <>
              <div
                onClick={() => setMfgOpen(o => !o)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d', cursor: 'pointer', userSelect: 'none' }}
              >
                <span style={{ color: 'var(--dim)', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 8, color: 'var(--dim)', transition: 'transform 0.15s', display: 'inline-block', transform: mfgOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                  MFG Job
                </span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)' }}>{fmtISK(calcItem.job_cost)}</span>
              </div>
              {mfgOpen && jc && (
                <>
                  {[
                    ['Estimated Item Value', jc.eiv,               '#555'],
                    ['Sys Cost Index',       jc.gross,             'var(--dim)'],
                    ['Role Bonus',           jc.gross_bonus_amount, (jc.gross_bonus_amount ?? 0) < 0 ? '#4cff91' : 'var(--accent)'],
                    ['Gross Cost',          jc.gross_after_bonus, 'var(--text)'],
                    ['Facility Tax',        jc.facility_tax,      'var(--dim)'],
                    ['SCC 4%',              jc.scc_surcharge,     'var(--dim)'],
                  ].map(([label, val, color]) => val != null && (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', paddingLeft: 14, fontSize: 9, borderBottom: '1px solid #0d0d0d', opacity: 0.85 }}>
                      <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>{label}</span>
                      <span style={{ fontFamily: 'var(--mono)', color }}>{fmtISK(val)}</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {/* Copy Job — clickable header */}
          {item?.needs_copy && item?.copy_job_cost != null && (
            <>
              <div
                onClick={() => setCopyOpen(o => !o)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d', cursor: 'pointer', userSelect: 'none' }}
              >
                <span style={{ color: 'var(--dim)', letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 8, color: 'var(--dim)', transition: 'transform 0.15s', display: 'inline-block', transform: copyOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                  Copy Job (Total)
                </span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)' }}>{fmtISK(item.copy_job_cost)}</span>
              </div>
              {copyOpen && (
                <>
                  <div style={{ padding: '3px 0 3px 14px', fontSize: 9, color: 'var(--dim)', letterSpacing: 0.5, borderBottom: '1px solid #0d0d0d', opacity: 0.85 }}>
                    Full install fee (matches in-game job window)
                  </div>
                  {item?.copy_job_cost_per_run != null && (item?.rec_runs || 1) > 1 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', paddingLeft: 14, fontSize: 9, borderBottom: '1px solid #0d0d0d', opacity: 0.85 }}>
                      <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>
                        Amortized / run (for ranking)
                      </span>
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)' }}>{fmtISK(item.copy_job_cost_per_run)}</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Sales Tax & Broker Fee */}
          {[
            ['Sales Tax',  calcItem?.sales_tax,  'var(--dim)'],
            ['Broker Fee', calcItem?.broker_fee, 'var(--dim)'],
          ].map(([label, val, color]) => val != null && (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d' }}>
              <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>{label}</span>
              <span style={{ fontFamily: 'var(--mono)', color }}>{fmtISK(val)}</span>
            </div>
          ))}
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)' }}>NET PROFIT</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: tierClr }}>
              {fmtISK(netProfitShown)} ISK
            </span>
          </div>
          {item.is_bpo_only && item.copy_job_cost > 0 && (
            <div style={{ marginTop: 6, padding: '4px 6px', border: '1px solid rgba(255,204,68,0.3)', background: 'rgba(255,204,68,0.06)', borderRadius: 2 }}>
              <span style={{ fontSize: 9, letterSpacing: 1, color: 'rgba(255,204,68,0.8)' }}>
                BPO path: copy install and copy-time overhead are included in the adjusted ranking values.
              </span>
            </div>
          )}
        </div>

        {/* Performance */}
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 6 }}>◈ PERFORMANCE</div>
          {[
            ['ROI',       item.roi != null ? `${item.roi.toFixed(1)}%` : '—',                    roiColor(item.roi)],
            ['ISK/HR',    fmtISK(iskHrShown),                                                    'var(--accent)'],
            ['REVENUE',   revenueShown != null ? fmtISK(revenueShown) : '—',                     'var(--text)'],
            ['VOL/DAY',   item.avg_daily_volume != null ? `${Math.round(item.avg_daily_volume)}/d` : '—', 'var(--text)'],
            ['SUPPLY',    item.supply_days != null ? `${item.supply_days.toFixed(1)}d (${(item.supply_qty ?? 0).toLocaleString()} units)` : '—',
                          item.supply_days < 1 ? '#ff3b3b' : item.supply_days < 3 ? 'var(--accent)' : '#4cff91'],
            ['DURATION',  calcItem ? fmtDuration(calcItem.duration) : '—',                       'var(--text)'],
          ].map(([label, val, color]) => (
            <div key={label} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d',
            }}>
              <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>{label}</span>
              <span style={{ fontFamily: 'var(--mono)', color }}>{val}</span>
            </div>
          ))}
          {calcItem?.recommended_runs && (() => {
            const rec = calcItem.recommended_runs;
            return (
              <div style={{ marginTop: 8, padding: '5px 0px', background: 'var(--bg2)', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, marginBottom: 3 }}>REC. RUNS</div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700, color: tierClr }}>{rec.runs}</span>
                <span style={{ fontSize: 9, color: 'var(--dim)', marginLeft: 6 }}>RUNS/BATCH · {rec.days_to_sell}d TO SELL</span>
              </div>
            );
          })()}
        </div>

      </div>
    </div>
  );
}

function PlannerKPIBar({ stats }) {
  return (
    <div className="planner-kpi-bar">
      {stats.map((stat, index) => (
        <Fragment key={stat.label}>
          <div className="planner-kpi-stat">
            <span className="planner-kpi-value" style={{ color: stat.color }}>{stat.value}</span>
            <span className="planner-kpi-label">{stat.label}</span>
          </div>
          {index < stats.length - 1 && <div className="planner-kpi-separator" />}
        </Fragment>
      ))}
    </div>
  );
}

function BlockedRecommendationsPanel({ blockedItems }) {
  const [isOpen, setIsOpen] = useState(false);
  if (!blockedItems?.length) return null;
  return (
    <div style={{
      borderTop: '1px solid rgba(255,157,61,0.14)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      background: 'rgba(255,157,61,0.05)',
    }}>
      <button
        onClick={() => setIsOpen(open => !open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
          textAlign: 'left', color: 'inherit',
        }}
      >
        <span style={{ fontSize: 10, color: 'var(--dim)', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s', display: 'inline-block' }}>▼</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1.2, color: '#ff9d3d' }}>UNLOCKABLE OPPORTUNITIES</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#000', background: '#ff9d3d', padding: '2px 6px', borderRadius: 2 }}>{blockedItems.length}</span>
        <div style={{ flex: 1, height: 1, background: 'rgba(255,157,61,0.45)' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>LOCKED UPSIDE</span>
      </button>
      <div style={{ display: isOpen ? 'flex' : 'none', flexDirection: 'column', gap: 6, padding: '0 12px 12px' }}>
        {blockedItems.map((item, index) => {
          const isSkillBlock = item.block_kind === 'skills' || String(item.reason || '').toLowerCase().includes('missing skill');
          const actionLabel = String(item.action_type || '').replace('_', ' ').toUpperCase();
          const unlockPath = item.unlock_path || item.reason || 'Missing requirements';
          const estimatedProfit = Number(item.estimated_profit || 0);
          return (
            <div key={item.reason_key || `${item.output_id || item.name}-${index}`} style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto',
              gap: 10,
              alignItems: 'center',
              padding: '7px 10px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 2,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                {item.output_id ? (
                  <img
                    src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`}
                    alt=""
                    style={{ width: 18, height: 18, opacity: 0.9, flexShrink: 0 }}
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                ) : <div style={{ width: 18, height: 18, flexShrink: 0 }} />}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.7, color: 'var(--text)' }}>{item.name}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.5, color: '#ff9d3d' }}>{actionLabel}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.5, color: '#000', background: isSkillBlock ? '#ffd24d' : '#b0b0b0', padding: '2px 5px', borderRadius: 2 }}>
                      {isSkillBlock ? 'SKILL' : 'ACCESS'}
                    </span>
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {unlockPath}
                  </div>
                </div>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: estimatedProfit >= 0 ? '#4cff91' : 'var(--accent)', whiteSpace: 'nowrap' }}>
                {fmtISK(estimatedProfit)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Wallet bar ───────────────────────────────────────────────────────────────
function WalletBar({ walletTotal, lockedIsk, cycleConfig, lastRefresh }) {
  const pct   = walletTotal > 0 ? Math.min(100, (lockedIsk / walletTotal) * 100) : 0;
  const color = pct > 80 ? 'var(--accent)' : pct > 50 ? '#ff9d3d' : '#4cff91';
  const nowSec = Math.floor(Date.now() / 1000);
  const minsAgo = lastRefresh != null ? Math.floor((nowSec - lastRefresh) / 60) : null;
  return (
    <div className="planner-wallet">
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.8, color: 'var(--dim)', flexShrink: 0 }}>WALLET</span>
      <div style={{ flex: 1, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.4s' }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color, flexShrink: 0 }}>
        {fmtISK(lockedIsk)} locked
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>
        / {fmtISK(walletTotal)} avail
      </span>
      <div className="planner-wallet__meta">
        {cycleConfig && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: 0.6, flexShrink: 0 }}>
            {cycleConfig.cycle_duration_hours}h CYCLE
          </span>
        )}
        {minsAgo != null && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>
            {minsAgo === 0 ? 'JUST NOW' : `${minsAgo}m AGO`}
          </span>
        )}
      </div>
    </div>
  );
}

function PlannerGroupToggle({ value, onChange }) {
  return (
    <div className="planner-view-toggle">
      <button
        type="button"
        className={`planner-view-toggle__button${value === 'character' ? ' active' : ''}`}
        onClick={() => onChange('character')}
      >
        By Character
      </button>
      <button
        type="button"
        className={`planner-view-toggle__button${value === 'time' ? ' active' : ''}`}
        onClick={() => onChange('time')}
      >
        By Time
      </button>
    </div>
  );
}

// Small control bar above the board. Keep board-level controls grouped here.
function PlannerFilterBar({
  onBlueprintRefresh,
  blueprintRefreshLoading,
  groupMode,
  onGroupModeChange,
  showIdle,
  onShowIdleChange,
  showFuture,
  onShowFutureChange,
}) {
  return (
    <div className="planner-filterbar">
      <div className="planner-filterbar__actions">
        <PlannerGroupToggle value={groupMode} onChange={onGroupModeChange} />
        <button
          type="button"
          className={`chip${showIdle ? ' active' : ''}`}
          onClick={() => onShowIdleChange(!showIdle)}
          title={showIdle ? 'Hide idle jobs from both queue columns' : 'Show idle jobs in both queue columns'}
        >
          IDLE
        </button>
        <button
          type="button"
          className={`chip${showFuture ? ' active' : ''}`}
          onClick={() => onShowFutureChange(!showFuture)}
          title={showFuture ? 'Hide queued future-start jobs from both queue columns' : 'Show queued future-start jobs in both queue columns'}
        >
          FUTURE
        </button>
        <button
          type="button"
          onClick={onBlueprintRefresh}
          disabled={blueprintRefreshLoading}
          className="planner-refresh-button"
          style={blueprintRefreshLoading ? { background: 'rgba(77, 166, 255, 0.14)', color: '#4da6ff' } : undefined}
          title="Force-refresh personal and corp blueprints from ESI, then rebuild planner recommendations"
        >
          {blueprintRefreshLoading ? 'REFRESHING BPS...' : 'REFRESH ESI BLUEPRINTS'}
        </button>
      </div>
    </div>
  );
}

// ── Multibuy sticky bar ───────────────────────────────────────────────────────
function MultibuyBar({ checkedCount, totalIsk, mats, onCopy, onClear }) {
  return (
    <div className="planner-multibuy-bar">
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#4cff91', fontWeight: 700 }}>
        {checkedCount} JOB{checkedCount !== 1 ? 'S' : ''} SELECTED
      </span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
        {mats.length} materials · {fmtISK(totalIsk)}
      </span>
      <div style={{ flex: 1 }} />
      <button
        onClick={onCopy}
        style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.6, padding: '6px 12px', border: 'none', background: '#4cff91', color: '#000', borderRadius: 2, cursor: 'pointer', fontWeight: 700 }}
      >⎘ COPY MULTIBUY</button>
      <button
        onClick={onClear}
        style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.6, padding: '6px 10px', border: '1px solid var(--border)', background: '#b0b0b0', color: '#000', borderRadius: 2, cursor: 'pointer' }}
      >CLEAR</button>
    </div>
  );
}

// ── Queue Planner View — 2-column layout ─────────────────────────────────────

export default function QueuePlannerView({ appSettings = DEFAULT_APP_SETTINGS, refreshNonce = 0 }) {
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [plannerRefreshNonce, setPlannerRefreshNonce] = useState(0);
  const [groupMode, setGroupMode] = useState(() => readPlannerGroupMode());
  const [showIdle, setShowIdle] = useState(() => readPlannerShowIdle());
  const [showFuture, setShowFuture] = useState(() => readPlannerShowFuture());
  const [plannerNow, setPlannerNow] = useState(() => Math.floor(Date.now() / 1000));
  const [blueprintRefreshLoading, setBlueprintRefreshLoading] = useState(false);
  const jobsSignalRef = useRef(null);
  const jobsPollBusyRef = useRef(false);
  const cycleConfig = appSettings;
  const plannerStructureType = facilityToPlannerStructureType(appSettings?.facility);
  const calcQueryParams = useMemo(() => {
    const params = new URLSearchParams({
      system: cycleConfig.system || 'Korsiki',
      facility: cycleConfig.facility || 'large',
    });
    if (cycleConfig.facilityTaxRate !== '') params.set('facility_tax_rate', String(parseFloat(cycleConfig.facilityTaxRate) / 100));
    if (cycleConfig.rigBonusMfg !== '') params.set('rig_bonus_mfg', String(cycleConfig.rigBonusMfg));
    return params.toString();
  }, [cycleConfig]);

  // Build query params — includes structure + rig bonuses sent to backend scoring
  const queryParams = useMemo(() => {
    const params = new URLSearchParams({
      cycle_duration_hours:    cycleConfig.cycle_duration_hours,
      structure_job_time_bonus_pct: cycleConfig.structureJobTimeBonusPct ?? 0,
      min_profit_per_cycle:    cycleConfig.min_profit_per_cycle,
      include_below_threshold_items: cycleConfig.include_below_threshold_items ? 'true' : 'false',
      max_sell_days_tolerance: cycleConfig.max_sell_days_tolerance,
      target_isk_per_m3:       cycleConfig.target_isk_per_m3 ?? 0,
      weight_by_velocity:      cycleConfig.weight_by_velocity ? 'true' : 'false',
      count_corp_original_blueprints_as_own: cycleConfig.count_corp_original_blueprints_as_own ? 'true' : 'false',
      system:                  cycleConfig.system || 'Korsiki',
      facility:                cycleConfig.facility || 'large',
      structure_type:          plannerStructureType || 'engineering_complex',
      rig_1:                   cycleConfig.rig_1 || 'none',
      rig_2:                   cycleConfig.rig_2 || 'none',
    });
    if (cycleConfig.facilityTaxRate !== '') params.set('facility_tax_rate', String(parseFloat(cycleConfig.facilityTaxRate) / 100));
    if (cycleConfig.rigBonusMfg !== '') params.set('rig_bonus_mfg', String(cycleConfig.rigBonusMfg));
    return params.toString();
  }, [cycleConfig, plannerStructureType]);

  const effectiveRefreshNonce = useMemo(
    () => `${refreshNonce}:${plannerRefreshNonce}`,
    [refreshNonce, plannerRefreshNonce]
  );

  const plannerUrl = useMemo(
    () => `${API}/api/job-planner?${queryParams}&refresh_nonce=${encodeURIComponent(effectiveRefreshNonce)}`,
    [effectiveRefreshNonce, queryParams]
  );

  const { data: tpData, loading: tpLoading, error: tpError, refetch } =
    useApi(plannerUrl, [plannerUrl]);
  const { data: calcData } = useApi(`${API}/api/calculator?${calcQueryParams}`, [calcQueryParams]);

  const [expandedId, setExpandedId] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [graduated, setGraduated] = useState([]);
  const prevSciIds = useRef(new Set());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PLANNER_GROUP_MODE_KEY, groupMode);
    } catch {}
  }, [groupMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PLANNER_SHOW_IDLE_KEY, String(showIdle));
    } catch {}
  }, [showIdle]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PLANNER_SHOW_FUTURE_KEY, String(showFuture));
    } catch {}
  }, [showFuture]);

  useGlobalTick(() => {
    setPlannerNow(Math.floor(Date.now() / 1000));
  });

  useEffect(() => {
    setCheckedIds(new Set());
    setExpandedId(null);
  }, [plannerStructureType, cycleConfig.cycle_duration_hours, cycleConfig.structureJobTimeBonusPct, cycleConfig.haul_capacity_m3, cycleConfig.target_isk_per_m3, cycleConfig.min_profit_per_cycle, cycleConfig.include_below_threshold_items, cycleConfig.max_sell_days_tolerance, cycleConfig.count_corp_original_blueprints_as_own, cycleConfig.weight_by_velocity, cycleConfig.rig_1, cycleConfig.rig_2]);

  const items        = tpData?.items || [];
  const maxJobs      = tpData?.max_jobs ?? 1;
  const runningJobs  = tpData?.running_jobs ?? 0;
  const freeSlots    = tpData?.free_slots ?? 0;
  const maxScience   = tpData?.max_science ?? 0;
  const runningScience = tpData?.running_science ?? 0;
  const freeScience  = tpData?.free_science ?? 0;
  const walletTotal  = tpData?.wallet_total_isk ?? 0;
  const blockedItems = tpData?.blocked_items || [];
  const characterSlots = tpData?.character_slots || { science: {}, manufacturing: {} };

  // These lists are the actual payloads rendered by the two planner columns.
  const sciItems = useMemo(() =>
    items.filter(i => i.action_type === 'copy_first' || i.action_type === 'invent_first' || i.action_type === 'copy_then_invent' || i.action_type === 'idle_science'),
    [items]);
  const mfgItems = useMemo(() => items.filter(i => i.action_type === 'manufacture' || i.action_type === 'idle_manufacture'), [items]);
  const includePlannerItem = useCallback((item, idleActionType) => {
    if (!showIdle && (item.is_idle || item.action_type === idleActionType)) return false;
    if (!showFuture && !item.is_idle && Number(item.start_at || 0) > plannerNow + 30) return false;
    return true;
  }, [plannerNow, showFuture, showIdle]);
  const visibleSciItems = useMemo(
    () => sciItems.filter(i => includePlannerItem(i, 'idle_science')),
    [includePlannerItem, sciItems]
  );
  const visibleMfgItems = useMemo(
    () => mfgItems.filter(i => includePlannerItem(i, 'idle_manufacture')),
    [includePlannerItem, mfgItems]
  );
  const realSciItems = useMemo(() => sciItems.filter(i => !i.is_idle), [sciItems]);
  const realMfgItems = useMemo(() => mfgItems.filter(i => !i.is_idle), [mfgItems]);
  const startNowMfgCount = useMemo(() => {
    return realMfgItems.filter(i => !i.start_at || i.start_at <= plannerNow + 30).length;
  }, [plannerNow, realMfgItems]);
  const queuedMfgCount = Math.max(0, realMfgItems.length - startNowMfgCount);

  useEffect(() => {
    if (!tpData) return;
    setLastRefresh(Math.floor(Date.now() / 1000));
    const newSciIds  = new Set(realSciItems.map(i => i.output_id));
    const mfgNameMap = new Map(realMfgItems.map(i => [i.output_id, i.name]));
    const grad = [];
    prevSciIds.current.forEach(id => {
      if (!newSciIds.has(id) && mfgNameMap.has(id)) grad.push(mfgNameMap.get(id));
    });
    setGraduated(grad.length ? grad : []);
    prevSciIds.current = newSciIds;
  }, [tpData, realSciItems, realMfgItems]);

  useEffect(() => {
    let cancelled = false;

    async function pollJobsSignal() {
      if (cancelled || document.visibilityState !== 'visible' || jobsPollBusyRef.current) return;
      jobsPollBusyRef.current = true;
      try {
        const res = await fetch(`${API}/api/industry/jobs/signal`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return;
        const signal = await res.json();
        const nextSignature = String(signal?.signature || 'empty');
        const prevSignature = jobsSignalRef.current;
        jobsSignalRef.current = nextSignature;

        if (prevSignature && prevSignature !== nextSignature) {
          refetch();
        }
      } catch {
        // Silent failure: keep existing planner data and retry on next interval.
      } finally {
        jobsPollBusyRef.current = false;
      }
    }

    pollJobsSignal();
    const id = setInterval(pollJobsSignal, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refetch]);

  useEffect(() => {
    if (tpData?.status !== 'esi_loading') return undefined;

    const retryId = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        refetch();
      }
    }, 5000);

    return () => clearTimeout(retryId);
  }, [tpData?.status, refetch]);

  const handleBlueprintRefresh = useCallback(async () => {
    if (blueprintRefreshLoading) return;

    setBlueprintRefreshLoading(true);

    try {
      const res = await fetch(`${API}/api/blueprints/esi?force=1`, {
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      setPlannerRefreshNonce(value => value + 1);
    } catch {
      // Leave the current planner data intact and allow manual retry.
    } finally {
      setBlueprintRefreshLoading(false);
    }
  }, [blueprintRefreshLoading]);

  const calcMap = useMemo(() => {
    const m = {};
    (calcData?.results || []).forEach(r => { m[r.output_id] = r; });
    return m;
  }, [calcData]);

  const handleCheck = useCallback((recId, val) => {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (val) next.add(recId); else next.delete(recId);
      return next;
    });
  }, []);

  // Aggregate materials from checked jobs for multibuy
  const { checkedMats, checkedCost } = useMemo(() => {
    const matMap = {};
    let cost = 0;
    for (const item of mfgItems.filter(i => checkedIds.has(i.rec_id || String(i.output_id)))) {
      const runs = item.rec_runs || 1;
      for (const m of (item.material_breakdown || [])) {
        if (!matMap[m.type_id]) matMap[m.type_id] = { name: m.name || `Type ${m.type_id}`, qty: 0 };
        matMap[m.type_id].qty += (m.quantity || 0) * runs;
      }
      cost += (item.material_cost || 0);
    }
    return { checkedMats: Object.values(matMap), checkedCost: cost };
  }, [checkedIds, mfgItems]);

  const copyMultibuy = useCallback(() => {
    const text = checkedMats.map(m => `${m.name} ${m.qty}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }, [checkedMats]);

  // Locked ISK = material cost of all "start now" manufacturing items
  const lockedIsk = useMemo(() => {
    const nowTs = Math.floor(Date.now() / 1000);
    return mfgItems
      .filter(i => !i.start_at || i.start_at <= nowTs + 30)
      .reduce((sum, i) => sum + (i.material_cost || 0), 0);
  }, [mfgItems]);

  // Top KPI cards. If you want to reorder, rename, or recolor the headline numbers, do it here.
  const plannerStats = useMemo(() => {
    const nowTs = Math.floor(Date.now() / 1000);
    const startNowItems = mfgItems.filter(i => !i.start_at || i.start_at <= nowTs + 30);
    const totalCycleIsk = mfgItems.reduce((sum, item) => sum + (item.profit_per_cycle || 0), 0);
    const readyNowIsk = startNowItems.reduce((sum, item) => sum + (item.profit_per_cycle || 0), 0);
    const sciencePipelineIsk = sciItems.reduce((sum, item) => sum + (item.profit_per_cycle || 0), 0);
    const avgRoi = mfgItems.length
      ? mfgItems.reduce((sum, item) => sum + (item.roi || 0), 0) / mfgItems.length
      : 0;
    const avgSellDays = mfgItems.length
      ? mfgItems.reduce((sum, item) => sum + (item.days_to_sell || 0), 0) / mfgItems.length
      : 0;
    const walletShare = walletTotal > 0 ? (lockedIsk / walletTotal) * 100 : 0;

    return [
      {
        label: 'TOTAL CYCLE',
        value: fmtISK(totalCycleIsk),
        color: totalCycleIsk > 0 ? '#4cff91' : 'var(--text)',
      },
      {
        label: 'READY NOW',
        value: fmtISK(readyNowIsk),
        color: readyNowIsk > 0 ? '#4cff91' : 'var(--text)',
      },
      {
        label: 'SCI PIPELINE',
        value: fmtISK(sciencePipelineIsk),
        color: sciencePipelineIsk > 0 ? 'var(--planner-invention)' : 'var(--text)',
      },
      {
        label: 'AVG ROI',
        value: mfgItems.length ? `${avgRoi.toFixed(1)}%` : '—',
        color: avgRoi >= 15 ? '#4cff91' : avgRoi >= 5 ? '#ff9d3d' : 'var(--accent)',
      },
      {
        label: 'AVG SELL',
        value: mfgItems.length ? `${avgSellDays.toFixed(1)}d` : '—',
        color: avgSellDays > 0 && avgSellDays <= 3 ? '#4cff91' : avgSellDays > 7 ? 'var(--accent)' : 'var(--text)',
      },
      {
        label: 'CAP LOCK',
        value: walletTotal > 0 ? `${walletShare.toFixed(0)}%` : '—',
        color: walletShare >= 80 ? 'var(--accent)' : walletShare >= 50 ? '#ff9d3d' : 'var(--text)',
      },
    ];
  }, [mfgItems, sciItems, lockedIsk, walletTotal]);

  const handleRefresh = useCallback(() => {
    setPlannerRefreshNonce(value => value + 1);
  }, []);

  if (tpLoading && !tpData) return <LoadingState label="LOADING QUEUE" sub="JOB PLANNER" />;
  if (tpError) return (
    <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>⚠ ESI ERROR</div>
  );
  if (tpData?.status === 'esi_loading') return (
    <LoadingState label="LOADING BLUEPRINTS" sub="WAITING FOR ESI DATA" />
  );
  if (!items.length) return (
    <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 10, letterSpacing: 1.5, textAlign: 'center' }}>
      NO DATA — RUN THE MANUFACTURING CALCULATOR FIRST
    </div>
  );

  return (
    <div className="planner-shell">
      {/* Top KPI strip */}
      <PlannerKPIBar stats={plannerStats} />

      {/* Wallet and cycle metadata strip */}
      {walletTotal > 0 && <WalletBar walletTotal={walletTotal} lockedIsk={lockedIsk} cycleConfig={cycleConfig} lastRefresh={lastRefresh} />}

      {/* Board controls: grouping mode and blueprint refresh */}
      <PlannerFilterBar
        onBlueprintRefresh={handleBlueprintRefresh}
        blueprintRefreshLoading={blueprintRefreshLoading}
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        showIdle={showIdle}
        onShowIdleChange={setShowIdle}
        showFuture={showFuture}
        onShowFutureChange={setShowFuture}
      />

      {/* Main planner board. CSS decides when this becomes stacked on narrower screens. */}
      <div className="planner-board">
        {/* Left column: copy and invention recommendations */}
        <div className="planner-board__column planner-board__column--science">
          <QueuePaneHeader
            label="SCIENCE QUEUE"
            total={maxScience}
            occupied={runningScience}
            activeColor="var(--planner-copy)"
            summary={`${cycleConfig.cycle_duration_hours}h / ${cycleConfig.min_profit_per_cycle / 1_000_000 | 0}M ISK/cycle`}
            tone="science"
          />
          <ScienceQueueColumn
            items={visibleSciItems}
            cycleConfig={cycleConfig}
            maxScience={maxScience}
            freeScience={freeScience}
            characterSlots={characterSlots.science || {}}
            onItemExpand={setExpandedId}
            expandedId={expandedId}
            groupMode={groupMode}
          />
        </div>

        {/* Right column: manufacturing recommendations */}
        <div className="planner-board__column">
          <QueuePaneHeader
            label="MANUFACTURING QUEUE"
            total={maxJobs}
            occupied={runningJobs}
            activeColor="var(--planner-mfg)"
            summary={checkedIds.size > 0 ? `${checkedIds.size} SELECTED` : `${mfgItems.length} PLANNED · ${startNowMfgCount} NOW · ${queuedMfgCount} LATER`}
            tone="manufacturing"
          />
          <ManufacturingQueueColumn
            items={visibleMfgItems}
            cycleConfig={cycleConfig}
            maxJobs={maxJobs}
            freeSlots={freeSlots}
            characterSlots={characterSlots.manufacturing || {}}
            onItemExpand={setExpandedId}
            expandedId={expandedId}
            checkedIds={checkedIds}
            onCheck={handleCheck}
            groupMode={groupMode}
          />
        </div>
      </div>

      {/* Bottom accordion for profitable jobs blocked by missing access/skills. */}
      <BlockedRecommendationsPanel blockedItems={blockedItems} />

      {/* Sticky multibuy bar when items are checked */}
      {checkedIds.size > 0 && (
        <MultibuyBar
          checkedCount={checkedIds.size}
          totalIsk={checkedCost}
          mats={checkedMats}
          onCopy={copyMultibuy}
          onClear={() => setCheckedIds(new Set())}
        />
      )}
    </div>
  );
}
