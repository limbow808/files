import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { useGlobalTick } from '../hooks/useGlobalTick';
import { useApi } from '../hooks/useApi';
import CharTag from './CharTag';
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
    <tr className="eve-row-reveal" style={{ animationDelay: `${idx * 30}ms` }}>
      <td style={{ padding: '5px 6px 5px 10px', textAlign: 'left', maxWidth: 0, width: '99%' }}>
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
            fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>{j.product_name}</span>
          {j.runs > 1 && (
            <span style={{ fontSize: 10, color: 'var(--dim)', flexShrink: 0 }}>×{j.runs}</span>
          )}
          </div>
        </div>
        <div style={{ height: 2, background: '#111', width: '100%', marginTop: 3 }}>
          <div ref={progressRef} style={{ height: '100%', transition: 'width 1s linear' }} />
        </div>
      </td>
      {/* TYPE badge */}
      <td style={{ padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
          color: '#000', background: aColor,
          padding: '2px 6px', borderRadius: 2, fontWeight: 700,
          display: 'inline-block', minWidth: 44, textAlign: 'center',
        }}>{shortAct}</span>
      </td>
      {multiChar && (
        <td style={{ padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
          <CharTag name={j.character_name} color={cColor} />
        </td>
      )}
      <td ref={countdownRef} style={{
        padding: '5px 10px 5px 6px', textAlign: 'right',
        fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap',
      }} />
    </tr>
  );
}

const TH = ({ children, align = 'right' }) => (
  <th style={{
    textAlign: align, padding: '5px 6px', fontSize: 9, color: 'var(--dim)',
    letterSpacing: 1, borderBottom: '1px solid var(--border)', fontWeight: 400,
    whiteSpace: 'nowrap',
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
          <TH>TYPE</TH>
          {multiChar && <TH>CHAR</TH>}
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

function QueuePlannerView({ refreshKey }) {
  const { data: tpData,   loading: tpLoading,   error: tpError }   = useApi(`${API}/api/top-performers`, [refreshKey]);
  const { data: calcData }                                           = useApi(`${API}/api/calculator`, []);
  const [expandedId, setExpandedId] = useState(null);

  const items   = tpData?.items || [];
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

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
      <thead>
        <tr>
          <TH align="left">ITEM</TH>
          <TH>SUPPLY</TH>
          <TH>ROI</TH>
          <TH>PROFIT/RUN</TH>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => {
          const isOpen   = expandedId === item.output_id;
          const calcItem = calcMap[item.output_id] || null;
          const roiClr   = roiColor(item.roi);
          const profClr  = item.net_profit >= 0 ? '#4cff91' : '#ff3b3b';
          const supplyDays = item.supply_days ?? 0;
          return (
            <Fragment key={item.output_id}>
              <tr
                className="eve-row-reveal"
                style={{ animationDelay: `${i * 25}ms`, cursor: 'pointer', background: isOpen ? '#0a0a08' : 'transparent' }}
                onClick={() => setExpandedId(isOpen ? null : item.output_id)}
              >
                <td style={{ padding: '5px 10px', textAlign: 'left', maxWidth: 0, width: '99%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
                    {item.output_id && (
                      <img
                        src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`}
                        alt=""
                        style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.85 }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                    )}
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{item.name}</span>
                    {(item.ownership || []).map(o => <OwnBadge key={o} kind={o} />)}
                    {item.is_bpo_only && (
                      <span style={{
                        display: 'inline-block', padding: '1px 4px', fontSize: 8, letterSpacing: 1,
                        border: '1px solid rgba(255,204,68,0.5)', background: 'rgba(255,204,68,0.1)',
                        color: 'rgba(255,204,68,0.8)', borderRadius: 2, lineHeight: 1.6, flexShrink: 0,
                      }}>BPO</span>
                    )}
                    {item.producing_qty > 0 && (
                      <span style={{
                        display: 'inline-block', padding: '1px 4px', fontSize: 8, letterSpacing: 1,
                        border: '1px solid rgba(77,166,255,0.5)', background: 'rgba(77,166,255,0.1)',
                        color: 'rgba(77,166,255,0.8)', borderRadius: 2, lineHeight: 1.6, flexShrink: 0,
                      }}>IN PROD</span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: isOpen ? 'var(--accent)' : 'var(--dim)', flexShrink: 0 }}>
                      {isOpen ? '▲' : '▼'}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <SupplyBar supplyDays={supplyDays} urgency={item.urgency} />
                </td>
                <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: roiClr, whiteSpace: 'nowrap' }}>
                  {item.roi != null ? `${item.roi.toFixed(1)}%` : '—'}
                </td>
                <td style={{ padding: '5px 10px 5px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: profClr, whiteSpace: 'nowrap' }}>
                  {fmtISK(item.net_profit)}
                </td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={4} style={{ padding: 0 }}>
                    <QueueDetailExpanded item={item} calcItem={calcItem} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
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
      <div className="panel-hdr" style={{ gap: 0, padding: 0, paddingRight: 14 }}>
        <div style={{ display: 'flex' }}>
          {[
            { key: 'jobs',  label: '◈ Active Jobs'    },
            { key: 'queue', label: '◈ Queue Planner'  },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setView(key)} className={`tab-btn${view === key ? ' active' : ''}`}>
              {label}
            </button>
          ))}
        </div>
        {view === 'jobs' && (
          <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
            {loading ? '' : `${activeCount} ACTIVE · ${completeCount} READY`}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {view === 'jobs'
          ? <ActiveJobsView data={data} loading={loading} error={error} />
          : <QueuePlannerView refreshKey={refreshKey} />
        }
      </div>
    </div>
  );
}

