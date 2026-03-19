import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { useGlobalTick } from '../hooks/useGlobalTick';
import { useApi } from '../hooks/useApi';
import CharTag from './CharTag';
import TopPerformersPanel from './TopPerformersPanel';
import { charColor, seedCharColors } from '../utils/charColors';
import { fmtISK, fmtDuration, roiColor } from '../utils/fmt';
import { LoadingState } from './ui';
import { API } from '../App';

const ACTIVITY_COLORS = {
  'Manufacturing': '#ff4700',
  'Reaction':      '#4da6ff',
  'TE Research':   '#4da6ff',
  'ME Research':   '#4da6ff',
  'Copying':       '#4da6ff',
  'Invention':     '#4da6ff',
};

const ACTIVITY_SHORT = {
  'Manufacturing': 'MFG',
  'Reaction':      'RXN',
  'Reactions':     'RXN',
  'TE Research':   'T.E.',
  'ME Research':   'M.E.',
  'Copying':       'COPY',
  'Invention':     'INV',
};

const OWN_COLORS = {
  personal: { fill: '#ff4700', label: 'PERS' },
  corp:     { fill: '#44bb55', label: 'CORP' },
};

function fmtCountdown(secs) {
  if (secs <= 0) return 'COMPLETE';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600)  / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ── Active Jobs ───────────────────────────────────────────────────────────────

function JobRow({ j, idx, multiChar }) {
  const countdownRef = useRef(null);
  const progressRef  = useRef(null);
  const nameRef      = useRef(null);

  useGlobalTick(() => {
    const secsLeft = Math.max(0, j.end_ts - Math.floor(Date.now() / 1000));
    if (countdownRef.current) {
      countdownRef.current.textContent = fmtCountdown(secsLeft);
      countdownRef.current.style.color =
        secsLeft <= 0 ? '#00cc66' : secsLeft < 3600 ? 'var(--accent)' : 'var(--text)';
    }
    if (progressRef.current) {
      const totalSecs = j.total_secs || 86400;
      const pct = totalSecs > 0 ? Math.max(0, Math.min(100, (1 - secsLeft / totalSecs) * 100)) : 100;
      progressRef.current.style.width = `${pct}%`;
      progressRef.current.style.background = secsLeft <= 0 ? '#00cc66' : secsLeft < 3600 ? 'var(--accent)' : '#4da6ff';
    }
    if (nameRef.current) {
      nameRef.current.style.color = secsLeft <= 0 ? '#00cc66' : 'var(--text)';
    }
  });

  const aColor   = ACTIVITY_COLORS[j.activity] || 'var(--text)';
  const cColor   = j.character_id ? charColor(j.character_id) : 'var(--dim)';
  const shortAct = ACTIVITY_SHORT[j.activity] || j.activity.slice(0, 4).toUpperCase();

  return (
    <tr className="eve-row-reveal" style={{ position: 'relative', animationDelay: `${idx * 30}ms` }}>
      <td style={{ padding: '10px', textAlign: 'left', maxWidth: 0, width: '99%', background: 'var(--bg2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          {(j.product_type_id || j.blueprint_type_id) && (
            <img
              src={`https://images.evetech.net/types/${j.product_type_id || j.blueprint_type_id}/icon?size=32`}
              alt=""
              style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.85 }}
              onError={e => { e.target.style.display = 'none'; }}
            />
          )}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, overflow: 'hidden', flex: 1, minWidth: 0 }}>
          <span ref={nameRef} style={{
            fontFamily: 'var(--mono)', fontSize: 14, letterSpacing: 0.5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>{j.product_name}</span>
          {j.runs > 1 && (
            <span style={{ fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>×{j.runs}</span>
          )}
          </div>
        </div>
        {/* Full-row progress bar — absolutely positioned, uses <tr> as containing block */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: '#0d0d0d', pointerEvents: 'none', zIndex: 0 }}>
          <div ref={progressRef} style={{ height: '100%', transition: 'width 1s linear' }} />
        </div>
      </td>
      {/* TYPE badge */}
      <td style={{ padding: '5px 6px', textAlign: 'left', whiteSpace: 'nowrap', background: 'var(--bg2)' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0,
          color: '#000', background: aColor,
          padding: '2px 6px', borderRadius: 2, fontWeight: 500,
          display: 'inline-block', minWidth: 44, textAlign: 'center',
        }}>{shortAct}</span>
      </td>
      {multiChar && (
        <td style={{ padding: '5px 6px', textAlign: 'left', whiteSpace: 'nowrap', fontSize: 11, background: 'var(--bg2)' }}>
          <CharTag name={j.character_name} color={cColor} />
        </td>
      )}
      <td ref={countdownRef} style={{
        padding: '5px 10px 5px 6px', textAlign: 'right',
        fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap', background: 'var(--bg2)',
      }} />
    </tr>
  );
}

const TH = ({ children, align = 'right' }) => (
  <th style={{
    textAlign: align, padding: '8px', fontSize: 11, color: 'var(--dim)',
    letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 300,
    whiteSpace: 'nowrap', background: 'var(--bg2)',
  }}>{children}</th>
);

function ActiveJobsView({ data, loading, error }) {
  const jobs = useMemo(() => {
    const raw = data?.jobs || [];
    const now = Math.floor(Date.now() / 1000);
    return [...raw].sort((a, b) => {
      const aL = Math.max(0, a.end_ts - now);
      const bL = Math.max(0, b.end_ts - now);
      return aL - bL; // soonest / complete first
    });
  }, [data]);

  const uniqueChars = new Set(jobs.map(j => j.character_id).filter(Boolean));
  const multiChar   = uniqueChars.size > 1;

  if (loading && !data) return <LoadingState label="FETCHING JOBS" sub="ESI · INDUSTRY" />;
  if (error) return (
    <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>
      ⚠ ESI UNAVAILABLE
    </div>
  );
  if (!jobs.length) return (
    <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
      NO ACTIVE JOBS
    </div>
  );

  return (
    <table className="jobs-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
      <thead>
        <tr>
          <TH align="left">ITEM</TH>
          <TH align="left">TYPE</TH>
          {multiChar && <TH align="left">CHAR</TH>}
          <TH>REMAINING</TH>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j, idx) => (
          <JobRow key={j.job_id} j={j} idx={idx} multiChar={multiChar} />
        ))}
      </tbody>
    </table>
  );
}

// ── Queue Planner ─────────────────────────────────────────────────────────────

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

function QueueDetailExpanded({ item, calcItem }) {
  const materials = calcItem?.material_breakdown || [];
  const tierClr   = roiColor(item.roi);

  return (
    <div style={{
      background: '#030303', borderLeft: `3px solid ${tierClr}`,
      padding: '10px 14px', borderBottom: '1px solid var(--border)',
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
          {[
            ['Material Cost', calcItem?.material_cost, 'var(--text)'],
            ['Job Install',   calcItem?.job_cost,      'var(--dim)'],
            ['Sales Tax',     calcItem?.sales_tax,     'var(--dim)'],
            ['Broker Fee',    calcItem?.broker_fee,    'var(--dim)'],
          ].map(([label, val, color]) => val != null && (
            <div key={label} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '2px 0', fontSize: 10, borderBottom: '1px solid #0d0d0d',
            }}>
              <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>{label}</span>
              <span style={{ fontFamily: 'var(--mono)', color }}>{fmtISK(val)}</span>
            </div>
          ))}
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)' }}>NET PROFIT</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: tierClr }}>
              {fmtISK(item.net_profit)} ISK
            </span>
          </div>
          {item.is_bpo_only && (
            <div style={{ marginTop: 6, padding: '4px 6px', border: '1px solid rgba(255,204,68,0.3)', background: 'rgba(255,204,68,0.06)', borderRadius: 2 }}>
              <span style={{ fontSize: 9, letterSpacing: 1, color: 'rgba(255,204,68,0.8)' }}>
                ⚠ BPO — copy job required before manufacturing. Copy costs not included above.
              </span>
            </div>
          )}
        </div>

        {/* Performance */}
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 6 }}>◈ PERFORMANCE</div>
          {[
            ['ROI',       item.roi != null ? `${item.roi.toFixed(1)}%` : '—',                    roiColor(item.roi)],
            ['ISK/HR',    fmtISK(item.isk_per_hour),                                             'var(--accent)'],
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
              <div style={{ marginTop: 8, padding: '5px 8px', border: '1px solid var(--border)', background: '#050505' }}>
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

function SupplyBar({ supplyDays, urgency }) {
  // Visual bar: green=stocked, orange=running low, red=empty
  const pct = Math.min(100, (supplyDays / 7) * 100);
  const barClr = supplyDays < 1 ? '#ff3b3b' : supplyDays < 3 ? 'var(--accent)' : '#4cff91';
  const label  = supplyDays < 0.1 ? 'EMPTY'
               : supplyDays < 1   ? `${supplyDays.toFixed(1)}d`
               : `${supplyDays.toFixed(1)}d`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <div style={{ width: 32, height: 4, background: '#111', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: barClr, borderRadius: 2, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: barClr, minWidth: 28 }}>{label}</span>
    </div>
  );
}

function fmtAbsTime(ts) {
  const now = Math.floor(Date.now() / 1000);
  const secs = (ts || 0) - now;
  if (secs <= 30) return 'NOW';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `~${d}d ${h}h`;
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}

const ACTION_LABELS = {
  manufacture: { label: 'MFG',      bg: '#ff4700' },
  copy_first:  { label: 'COPY→MFG', bg: '#ffcc44' },
};

function PrereqLine({ item }) {
  const now = Math.floor(Date.now() / 1000);

  if (item.action_type === 'copy_first') {
    return (
      <span style={{ fontSize: 9, color: 'rgba(255,204,68,0.85)', letterSpacing: 0.5 }}>
        → Start copy now · mfg ready {fmtAbsTime(item.manufacture_at)}
      </span>
    );
  }

  const secsAway = (item.start_at || now) - now;
  if (secsAway > 30) {
    return (
      <span style={{ fontSize: 9, color: 'rgba(255,71,0,0.8)', letterSpacing: 0.5 }}>
        → Slot opens {fmtAbsTime(item.start_at)}
      </span>
    );
  }

  if (!item.mats_ready && item.missing_mats_est_cost > 0) {
    return (
      <span style={{ fontSize: 9, color: '#ffcc44', letterSpacing: 0.5 }}>
        ⚠ BUY MATS · ~{fmtISK(item.missing_mats_est_cost)} needed
      </span>
    );
  }

  if (item.producing_qty > 0) {
    return (
      <span style={{ fontSize: 9, color: 'rgba(77,166,255,0.8)', letterSpacing: 0.5 }}>
        ▶ Already manufacturing ({item.producing_qty} units in flight)
      </span>
    );
  }

  return (
    <span style={{ fontSize: 9, color: '#4cff91', letterSpacing: 0.5 }}>
      ✓ Ready to queue
    </span>
  );
}

function QueueActionRow({ item, idx, isOpen, onToggle, calcItem }) {
  const now       = Math.floor(Date.now() / 1000);
  const secsAway  = Math.max(0, (item.start_at || now) - now);
  const isNow     = item.action_type === 'copy_first' || secsAway <= 30;
  const actInfo   = ACTION_LABELS[item.action_type] || ACTION_LABELS.manufacture;
  const timeCtx   = isNow ? 'NOW' : fmtAbsTime(item.start_at);
  const timeColor = isNow ? '#4cff91' : secsAway < 7200 ? 'var(--accent)' : 'var(--dim)';
  const supplyDays = item.supply_days ?? 0;

  return (
    <>
      <div
        className="eve-row-reveal"
        style={{
          display: 'flex', flexDirection: 'column',
          padding: '7px 10px', borderBottom: '1px solid var(--border)',
          cursor: 'pointer', background: isOpen ? '#0a0a08' : 'transparent',
          animationDelay: `${idx * 25}ms`,
        }}
        onClick={onToggle}
      >
        {/* Main row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>

          {/* Priority # + time context */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 34, flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--dim)', fontWeight: 700, lineHeight: 1.1 }}>
              #{idx + 1}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: timeColor, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>
              {timeCtx}
            </span>
          </div>

          {/* Action badge */}
          <span style={{
            display: 'inline-block', fontFamily: 'var(--mono)', fontSize: 8, fontWeight: 700,
            letterSpacing: 1, padding: '2px 5px', borderRadius: 2, flexShrink: 0,
            background: actInfo.bg, color: '#000',
          }}>{actInfo.label}</span>

          {/* Item icon */}
          {item.output_id && (
            <img
              src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`}
              alt=""
              style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.85 }}
              onError={e => { e.target.style.display = 'none'; }}
            />
          )}

          {/* Name */}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
          }}>{item.name}</span>

          {/* Runs badge */}
          {(item.rec_runs || 0) > 1 && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', flexShrink: 0 }}>
              ×{item.rec_runs}
            </span>
          )}

          {/* Ownership badges */}
          <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
            {(item.ownership || []).map(o => <OwnBadge key={o} kind={o} />)}
          </div>

          {/* ISK/hr */}
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)',
            flexShrink: 0, minWidth: 58, textAlign: 'right',
          }}>{fmtISK(item.isk_per_hour)}/hr</span>

          {/* Supply bar */}
          <SupplyBar supplyDays={supplyDays} urgency={item.urgency} />

          {/* Chevron */}
          <span style={{ fontSize: 9, color: isOpen ? 'var(--accent)' : 'var(--dim)', flexShrink: 0 }}>
            {isOpen ? '▲' : '▼'}
          </span>
        </div>

        {/* Prereq sub-line */}
        <div style={{ paddingLeft: 40, marginTop: 3 }}>
          <PrereqLine item={item} />
        </div>
      </div>

      {isOpen && <QueueDetailExpanded item={item} calcItem={calcItem} />}
    </>
  );
}

function DoThisNextView() {
  const { data: tpData, loading: tpLoading, error: tpError, refetch } =
    useApi(`${API}/api/top-performers`, []);
  const { data: calcData } = useApi(`${API}/api/calculator?system=Korsiki&facility=large`, []);
  const [expandedId,  setExpandedId]  = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const items       = tpData?.items       || [];
  const maxJobs     = tpData?.max_jobs    ?? 1;
  const runningJobs = tpData?.running_jobs ?? 0;
  const freeSlots   = tpData?.free_slots   ?? 0;

  useEffect(() => {
    if (tpData) setLastRefresh(Math.floor(Date.now() / 1000));
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
      NO DATA — RUN THE CALCULATOR TAB FIRST
    </div>
  );

  const slotBarColor = freeSlots > 0 ? '#4cff91' : 'var(--accent)';
  const nowSec = Math.floor(Date.now() / 1000);
  const minsAgo = lastRefresh != null ? Math.floor((nowSec - lastRefresh) / 60) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

      {/* Slot status + refresh header */}
      <div style={{
        padding: '5px 10px', borderBottom: '1px solid var(--border)', background: '#050505',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)' }}>SLOTS</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {Array.from({ length: Math.max(maxJobs, 1) }).map((_, i) => (
            <div key={i} style={{
              width: 10, height: 10, borderRadius: 2,
              background: i < runningJobs ? '#ff4700' : '#4cff91',
              border: '1px solid rgba(255,255,255,0.08)',
            }} title={i < runningJobs ? 'In use' : 'Free'} />
          ))}
        </div>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: slotBarColor }}>
          {freeSlots > 0 ? `${freeSlots} FREE` : 'ALL SLOTS IN USE'}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>
          {runningJobs}/{maxJobs}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {minsAgo != null && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>
              {minsAgo === 0 ? 'just now' : `${minsAgo}m ago`}
            </span>
          )}
          <button
            onClick={refetch}
            disabled={tpLoading}
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              color: tpLoading ? 'var(--dim)' : 'var(--text)',
              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
              padding: '3px 8px', cursor: tpLoading ? 'default' : 'pointer', borderRadius: 2,
            }}
          >{tpLoading ? '⟳ ...' : '⟳ REFRESH'}</button>
        </div>
      </div>

      {/* Priority action list */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {items.map((item, idx) => (
          <QueueActionRow
            key={item.output_id}
            item={item}
            idx={idx}
            isOpen={expandedId === item.output_id}
            onToggle={() => setExpandedId(expandedId === item.output_id ? null : item.output_id)}
            calcItem={calcMap[item.output_id] || null}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function ManufacturingJobs({ refreshKey = 0 }) {
  const { data, loading, error } = useApi('/api/industry/jobs');
  const [view, setView] = useState('jobs');

  const jobs = data?.jobs || [];

  useEffect(() => {
    const unique = [];
    const seen = new Set();
    jobs.forEach(j => {
      if (j.character_id && !seen.has(j.character_id)) {
        seen.add(j.character_id);
        unique.push({ character_id: j.character_id });
      }
    });
    if (unique.length) seedCharColors(unique);
  }, [jobs]);

  const now          = Math.floor(Date.now() / 1000);
  const activeCount  = jobs.filter(j => (j.end_ts - now) > 0).length;
  const completeCount = jobs.filter(j => (j.end_ts - now) <= 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header: two tab buttons */}
      <div className="panel-hdr" style={{ gap: 0, background: 'var(--bg2)', padding: 0, paddingRight: 14, borderBottom: 'none', fontWeight: 500, alignItems: 'stretch' }}>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          {[
            { key: 'jobs',  label: 'Active Jobs'    },
            { key: 'queue', label: 'Queue Planner'  },
            { key: 'top',   label: 'Top Performers' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setView(key)} className={`tab-btn${view === key ? ' active' : ''}`}>
              {label}
            </button>
          ))}
        </div>
        {view === 'jobs' && (
          <span style={{ fontSize: 14, color: 'var(--dim)', letterSpacing: 1, alignSelf: 'center' }}>
            {loading ? '' : `${activeCount} ACTIVE · ${completeCount} READY`}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {view === 'top'
          ? <TopPerformersPanel />
          : view === 'jobs'
            ? <ActiveJobsView data={data} loading={loading} error={error} />
            : <DoThisNextView />
        }
      </div>
    </div>
  );
}

