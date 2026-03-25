import { useEffect, useRef, useMemo } from 'react';
import { useGlobalTick } from '../hooks/useGlobalTick';
import { useApi } from '../hooks/useApi';
import CharTag from './CharTag';
import { charColor, seedCharColors } from '../utils/charColors';
import { LoadingState } from './ui';

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
      <td style={{ padding: '10px', textAlign: 'left', maxWidth: 0, width: '99%', background: 'var(--table-row-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          {(j.product_type_id || j.blueprint_type_id) && (
            <img
              src={`https://images.evetech.net/types/${j.product_type_id || j.blueprint_type_id}/icon?size=32`}
              alt=""
              style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.85 }}
              onError={e => { e.target.style.display = 'none'; }}
            />
          )}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, overflow: 'hidden', flex: 1, minWidth: 0, maxWidth: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, overflow: 'hidden', minWidth: 0, flex: '0 1 auto' }}>
              <span ref={nameRef} style={{
                fontFamily: 'var(--mono)', fontSize: 14, letterSpacing: 0.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
              }}>{j.product_name}</span>
              {j.runs > 1 && (
                <span style={{ fontSize: 11, color: 'var(--dim)', flexShrink: 0 }}>{'\u00D7'}{j.runs}</span>
              )}
            </div>
            {multiChar && j.character_name && (
              <CharTag name={j.character_name} color={cColor} bordered={false} style={{ flexShrink: 0 }} />
            )}
          </div>
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--bg)', pointerEvents: 'none', zIndex: 0 }}>
          <div ref={progressRef} style={{ height: '100%', transition: 'width 1s linear' }} />
        </div>
      </td>
      <td style={{ padding: '5px 6px', textAlign: 'left', whiteSpace: 'nowrap', background: 'var(--table-row-bg)' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0,
          color: '#000', background: aColor,
          padding: '2px 6px', borderRadius: 2, fontWeight: 500,
          display: 'inline-block', minWidth: 44, textAlign: 'center',
        }}>{shortAct}</span>
      </td>
      <td ref={countdownRef} style={{
        padding: '5px 10px 5px 6px', textAlign: 'right',
        fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap', background: 'var(--table-row-bg)',
      }} />
    </tr>
  );
}

const TH = ({ children, align = 'right' }) => (
  <th style={{
    textAlign: align, padding: '8px', fontSize: 11, color: 'var(--dim)',
    letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300,
    whiteSpace: 'nowrap', background: 'var(--table-row-bg)',
  }}>{children}</th>
);

function ActiveJobsView({ data, loading, error }) {
  const jobs = useMemo(() => {
    const raw = data?.jobs || [];
    const now = Math.floor(Date.now() / 1000);
    return [...raw].sort((a, b) => {
      const aL = Math.max(0, a.end_ts - now);
      const bL = Math.max(0, b.end_ts - now);
      return aL - bL;
    });
  }, [data]);

  const uniqueChars = new Set(jobs.map(j => j.character_id).filter(Boolean));
  const multiChar   = uniqueChars.size > 1;

  if (loading && !data) return <LoadingState label="FETCHING JOBS" sub="ESI \u00B7 INDUSTRY" />;
  if (error) return (
    <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>
      {'\u26A0'} ESI UNAVAILABLE
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

export default function ManufacturingJobs({ refreshKey = 0 }) {
  const { data, loading, error } = useApi('/api/industry/jobs');

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

  const now           = Math.floor(Date.now() / 1000);
  const activeCount   = jobs.filter(j => (j.end_ts - now) > 0).length;
  const completeCount = jobs.filter(j => (j.end_ts - now) <= 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="panel-hdr" style={{ background: 'var(--bg2)', paddingLeft: 14, paddingRight: 14, borderBottom: 'none', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)' }}>ACTIVE JOBS</span>
        <span style={{ fontSize: 11, color: 'var(--dim)', letterSpacing: 1 }}>
          {loading ? '' : `${activeCount} ACTIVE \u00B7 ${completeCount} READY`}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <ActiveJobsView data={data} loading={loading} error={error} />
      </div>
    </div>
  );
}