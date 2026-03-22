import { useState, useEffect, useRef, useMemo } from 'react';
import { useGlobalTick } from '../hooks/useGlobalTick';
import { useApi } from '../hooks/useApi';
import { fmtISK, fmtDuration, roiColor } from '../utils/fmt';
import { LoadingState } from './ui';
import { API } from '../App';

const OWN_COLORS = {
  personal: { fill: '#4cff91', label: 'PERS' },
  corp:     { fill: '#B0B0B0', label: 'CORP' },
};

function OwnBadge({ kind }) {
  const c = OWN_COLORS[kind];
  if (!c) return null;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', fontSize: 8, letterSpacing: 1,
      background: c.fill, color: '#000',
      borderRadius: 2, fontWeight: 700, flexShrink: 0, minWidth: 44, textAlign: 'center',
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
          width: SZ, height: SZ, borderRadius: 1,
          background: i < occupied ? activeColor : '#4cff91',
          border: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }} title={i < occupied ? 'In use' : 'Free'} />
      ))}
    </div>
  );
}

function SlotHeaderBar({ maxJobs, runningJobs, freeSlots, maxScience, runningScience, freeScience, lastRefresh, loading, refetch }) {
  const nowSec  = Math.floor(Date.now() / 1000);
  const minsAgo = lastRefresh != null ? Math.floor((nowSec - lastRefresh) / 60) : null;
  const mfgFreeColor = freeSlots   > 0 ? '#4cff91' : 'var(--accent)';
  const sciFreeColor = freeScience > 0 ? '#4cff91' : 'var(--accent)';

  return (
    <div style={{
      padding: '5px 10px', borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
      display: 'flex', alignItems: 'flex-start', gap: 18, flexWrap: 'wrap', flexShrink: 0,
    }}>
      {/* SCI SLOTS */}
      {maxScience > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', paddingTop: 1, whiteSpace: 'nowrap' }}>SCI SLOTS</span>
          <SlotDots total={maxScience} occupied={runningScience} activeColor="#4da6ff" />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: sciFreeColor, whiteSpace: 'nowrap', paddingTop: 0 }}>
            {freeScience > 0 ? `${freeScience} FREE` : 'FULL'}
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
            · {runningScience}/{maxScience}
          </span>
        </div>
      )}

      {/* MFG SLOTS */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', paddingTop: 1, whiteSpace: 'nowrap' }}>MFG SLOTS</span>
        <SlotDots total={maxJobs} occupied={runningJobs} activeColor="#ff4700" />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: mfgFreeColor, whiteSpace: 'nowrap' }}>
          {freeSlots > 0 ? `${freeSlots} FREE` : 'FULL'}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          · {runningJobs}/{maxJobs}
        </span>
      </div>

      {/* Timestamp + refresh — pushed right */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {minsAgo != null && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>
            {minsAgo === 0 ? 'JUST NOW' : `${minsAgo}m AGO`}
          </span>
        )}
        <button
          onClick={refetch}
          disabled={loading}
          style={{
            background: 'none', border: 'none',
            color: 'var(--dim)', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
            padding: 0, cursor: loading ? 'default' : 'pointer',
          }}
        >{loading ? '⟳ ...' : '⟳ REFRESH'}</button>
      </div>
    </div>
  );
}

function QueueColumnHeaders() {
  const cell = (label, align = 'left', width) => (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)',
      textAlign: align, flexShrink: 0, ...(width ? { width } : { flex: 1, minWidth: 0 }),
    }}>{label}</div>
  );
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', background: 'var(--bg)', borderBottom: '1px solid #0d0d0d',
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
      padding: '5px 10px', background: 'var(--bg)',
      borderTop: '1px solid #0d0d0d', borderBottom: '1px solid #0d0d0d',
      flexShrink: 0,
    }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 3,
        color: accentColor, fontWeight: 700,
      }}>{label}</span>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9, color: '#000',
        background: accentColor, padding: '1px 5px', borderRadius: 2,
      }}>{count} ITEMS</span>
      {/* gradient bar */}
      <div style={{
        flex: 1, height: 1, marginLeft: 4, marginRight: 4,
        background: `linear-gradient(to right, ${accentColor}66, transparent)`,
      }} />
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1.5, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
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
  startCopy:  { label: 'START COPY',          bg: '#4da6ff', color: '#000' },
  waitSci:    { label: 'WAITING FOR SCI SLOT', bg: 'rgba(255,255,255,0.07)', color: 'var(--dim)' },
  ready:      { label: 'READY TO QUEUE',       bg: '#4cff91', color: '#000' },
  buyMats:    { label: 'BUY MATS',             bg: '#ff4700', color: '#000' },
  slotWait:   { label: 'SLOT OPENING',         bg: 'rgba(255,255,255,0.07)', color: 'var(--dim)' },
};

function StatusBadge({ b }) {
  return (
    <span style={{
      display: 'inline-block', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
      padding: '2px 5px', borderRadius: 2, background: b.bg, color: b.color,
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
  return <span ref={ref} style={{ fontFamily: 'var(--mono)', fontSize: 10, ...style }} />;
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
      background: 'var(--bg)', fontSize: 10,
      color: 'rgba(77,166,255,0.65)', fontFamily: 'var(--mono)', letterSpacing: 0.5,
      fontStyle: 'italic',
    }}>
      ↓ GRADUATED TO MFG QUEUE AFTER LAST REFRESH — {names.join(', ')}
    </div>
  );
}

// ── Queue Detail Expanded ─────────────────────────────────────────────────────

function QueueDetailExpanded({ item, calcItem }) {
  const materials = calcItem?.material_breakdown || [];
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
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 6 }}>◈ REQUIRED MATERIALS</div>
          {materials.length > 0 ? materials.map((m, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto',
              gap: 8, padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d',
            }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.name || `Type ${m.type_id}`}
              </span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)', textAlign: 'right' }}>
                {new Intl.NumberFormat('en-US').format(m.quantity)}
              </span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--dim)', textAlign: 'right', minWidth: 52 }}>
                {fmtISK(m.line_cost)}
              </span>
            </div>
          )) : (
            <div style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: 1 }}>
              {calcItem ? 'NO MATERIAL DATA' : 'RUN CALCULATOR FOR MATERIAL DATA'}
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

// ── Queue Planner View (extracted from ManufacturingJobs) ─────────────────────

export default function QueuePlannerView() {
  const { data: tpData, loading: tpLoading, error: tpError, refetch } =
    useApi(`${API}/api/top-performers`, []);
  const { data: calcData } = useApi(`${API}/api/calculator?system=Korsiki&facility=large`, []);
  const [expandedId,  setExpandedId]  = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [graduated,   setGraduated]  = useState([]);
  const prevSciIds = useRef(new Set());

  const items          = tpData?.items         || [];
  const maxJobs        = tpData?.max_jobs       ?? 1;
  const runningJobs    = tpData?.running_jobs   ?? 0;
  const freeSlots      = tpData?.free_slots     ?? 0;
  const maxScience     = tpData?.max_science    ?? 0;
  const runningScience = tpData?.running_science ?? 0;
  const freeScience    = tpData?.free_science   ?? 0;

  const sciItems = useMemo(() => items.filter(i => i.action_type === 'copy_first'), [items]);
  const mfgItems = useMemo(() => items.filter(i => i.action_type === 'manufacture'), [items]);
  const maxIskHr = useMemo(
    () => Math.max(1, ...items.map(i => i.adj_isk_per_hour ?? i.isk_per_hour ?? 0)),
    [items],
  );

  useEffect(() => {
    if (!tpData) return;
    setLastRefresh(Math.floor(Date.now() / 1000));

    // Detect items that graduated from SCI → MFG since last refresh
    const newSciIds  = new Set(sciItems.map(i => i.output_id));
    const mfgNameMap = new Map(mfgItems.map(i => [i.output_id, i.name]));
    const grad = [];
    prevSciIds.current.forEach(id => {
      if (!newSciIds.has(id) && mfgNameMap.has(id)) grad.push(mfgNameMap.get(id));
    });
    if (grad.length) setGraduated(grad);
    else setGraduated([]);
    prevSciIds.current = newSciIds;
  }, [tpData]);

  const calcMap = useMemo(() => {
    const m = {};
    (calcData?.results || []).forEach(r => { m[r.output_id] = r; });
    return m;
  }, [calcData]);

  if (tpLoading && !tpData) return <LoadingState label="LOADING QUEUE" sub="TOP PERFORMERS" />;
  if (tpError) return (
    <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>⚠ ESI ERROR</div>
  );
  if (!items.length) return (
    <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 10, letterSpacing: 1.5, textAlign: 'center' }}>
      NO DATA — RUN THE MANUFACTURING CALCULATOR FIRST
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

      <SlotHeaderBar
        maxJobs={maxJobs} runningJobs={runningJobs} freeSlots={freeSlots}
        maxScience={maxScience} runningScience={runningScience} freeScience={freeScience}
        lastRefresh={lastRefresh} loading={tpLoading} refetch={refetch}
      />

      <QueueColumnHeaders />

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

        {/* SCI QUEUE section */}
        {sciItems.length > 0 && (
          <>
            <SectionHeader
              label="SCI QUEUE" count={sciItems.length}
              rightLabel="COPY FIRST — NEEDS SCIENCE SLOT"
              accentColor="#4da6ff"
            />
            {sciItems.map((item, i) => (
              <QueueRow
                key={item.output_id}
                item={item}
                globalIdx={items.indexOf(item)}
                queueType="sci"
                hasSciSlot={i < freeScience}
                runningScience={runningScience}
                isOpen={expandedId === item.output_id}
                onToggle={() => setExpandedId(expandedId === item.output_id ? null : item.output_id)}
                calcItem={calcMap[item.output_id] ?? item}
                maxIskHr={maxIskHr}
              />
            ))}
          </>
        )}

        {/* Graduated strip — appears after refresh when copy items moved to MFG */}
        <GraduatedStrip names={graduated} />

        {/* MFG QUEUE section */}
        {mfgItems.length > 0 && (
          <>
            <SectionHeader
              label="MFG QUEUE" count={mfgItems.length}
              rightLabel="READY TO INSTALL"
              accentColor="#ff4700"
            />
            {mfgItems.map(item => (
              <QueueRow
                key={item.output_id}
                item={item}
                globalIdx={items.indexOf(item)}
                queueType="mfg"
                hasSciSlot={false}
                runningScience={runningScience}
                isOpen={expandedId === item.output_id}
                onToggle={() => setExpandedId(expandedId === item.output_id ? null : item.output_id)}
                calcItem={calcMap[item.output_id] ?? item}
                maxIskHr={maxIskHr}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
