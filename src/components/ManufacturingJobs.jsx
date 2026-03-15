import { useState, useEffect, useRef, useCallback } from 'react';
import { useApi } from '../hooks/useApi';
import CharTag from './CharTag';
import { charColor, seedCharColors } from '../utils/charColors';
import { fmtISK } from '../utils/fmt';
import { LoadingState } from './ui';

const ACTIVITY_COLORS = {
  'Manufacturing': 'var(--accent)',
  'Reaction':      '#4da6ff',
  'TE Research':   '#aa88ff',
  'ME Research':   '#aa88ff',
  'Copying':       '#ffcc44',
  'Invention':     '#44ffaa',
};

// Display chips: 'Research' groups ME Research + TE Research into one button
const CHIP_LABELS = ['Manufacturing', 'Reaction', 'Reactions', 'Research', 'Copying', 'Invention'];

// Map chip label → actual activity names in ESI data
const CHIP_TO_ACTIVITIES = {
  'Manufacturing': ['Manufacturing'],
  'Reaction':      ['Reaction'],
  'Reactions':     ['Reactions'],
  'Research':      ['ME Research', 'TE Research'],
  'Copying':       ['Copying'],
  'Invention':     ['Invention'],
};

// Which activities count as "manufacturing" for showRuns/showSell
const MFG_ACTIVITIES      = new Set(['Manufacturing', 'Reaction']);
const RESEARCH_ACTIVITIES = new Set(['TE Research', 'ME Research', 'Copying', 'Invention']);

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

function ProgressBar({ secs, totalSecs }) {
  const pct = totalSecs > 0 ? Math.max(0, Math.min(100, (1 - secs / totalSecs) * 100)) : 100;
  const color = secs <= 0 ? '#00cc66' : secs < 3600 ? 'var(--accent)' : '#4da6ff';
  return (
    <div style={{ height: 3, background: '#111', width: '100%', marginTop: 3 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 1s linear' }} />
    </div>
  );
}

const PROFIT_POS  = '#4cff91';
const PROFIT_NEG  = '#ff3b3b';
const PROFIT_NONE = '#4a4a40';

function profitColor(profit) {
  if (profit == null) return PROFIT_NONE;
  return profit >= 0 ? PROFIT_POS : PROFIT_NEG;
}

function SummaryBar({ jobs }) {
  const jobCount   = jobs.length;
  const totalRuns  = jobs.reduce((s, j) => s + (j.runs || 0), 0);
  const revenue    = jobs.reduce((s, j) => s + (j.sell_total  ?? 0), 0);
  const profitSum  = jobs.every(j => j.profit != null)
    ? jobs.reduce((s, j) => s + (j.profit ?? 0), 0)
    : null;
  const jobsWithMargin = jobs.filter(j => j.margin_pct != null);
  const avgMargin  = jobsWithMargin.length
    ? jobsWithMargin.reduce((s, j) => s + j.margin_pct, 0) / jobsWithMargin.length
    : null;

  const stat = (label, value, color = 'var(--text)') => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color, letterSpacing: 1, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 8, color: 'var(--dim)', letterSpacing: 1.5, lineHeight: 1 }}>{label}</span>
    </div>
  );

  return (
    <div style={{
      display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 20,
      height: 26.5,
      padding: '0 14px',
      borderTop: '1px solid var(--border)',
      background: '#0c0c0a',
      flexShrink: 0,
    }}>
      {stat('JOBS',        jobCount)}
      {stat('TOTAL RUNS',  totalRuns)}
      {stat('EST. REVENUE', revenue  > 0 ? fmtISK(revenue)  : '—', 'var(--accent)')}
      {stat('EST. PROFIT',  profitSum != null ? fmtISK(profitSum) : '—', profitColor(profitSum))}
      {stat('AVG MARGIN',   avgMargin != null ? `${avgMargin.toFixed(1)}%` : '—', profitColor(avgMargin))}
    </div>
  );
}

// Abbreviated activity labels so the badge stays narrow
const ACTIVITY_SHORT = {
  'Manufacturing': 'MFG',
  'Reaction':      'RXN',
  'Reactions':     'RXN',
  'TE Research':   'T.E.',
  'ME Research':   'M.E.',
  'Copying':       'COPY',
  'Invention':     'INV',
};

function JobRow({ j, idx, multiChar, showRuns, showSell }) {
  const countdownRef = useRef(null);
  const progressRef  = useRef(null);
  const nameRef      = useRef(null);

  // Direct DOM updates for countdown — no React re-renders
  useEffect(() => {
    const tick = () => {
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
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [j.end_ts, j.total_secs]);

  const aColor = ACTIVITY_COLORS[j.activity] || 'var(--text)';
  const cColor = j.character_id ? charColor(j.character_id) : 'var(--dim)';
  const pColor = profitColor(j.profit);
  const shortAct = ACTIVITY_SHORT[j.activity] || j.activity.slice(0, 4).toUpperCase();

  return (
    <tr key={j.job_id} className="eve-row-reveal" style={{ animationDelay: `${idx * 30}ms` }}>
      {/* Name + optional ×runs suffix + progress bar */}
      <td style={{ padding: '5px 6px 5px 10px', textAlign: 'left', maxWidth: 0, width: '99%' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, overflow: 'hidden' }}>
          <span ref={nameRef} style={{
            fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          }}>{j.product_name}</span>
          {showRuns && j.runs > 1 && (
            <span style={{ fontSize: 10, color: 'var(--dim)', flexShrink: 0 }}>×{j.runs}</span>
          )}
        </div>
        <div style={{ height: 2, background: '#111', width: '100%', marginTop: 3 }}>
          <div ref={progressRef} style={{ height: '100%', transition: 'width 1s linear' }} />
        </div>
      </td>
      {/* Char — only when multi-char */}
      {multiChar && (
        <td style={{ padding: '5px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
          <CharTag name={j.character_name} color={cColor} />
        </td>
      )}
      {/* Profit (with margin %) — mfg only */}
      {showSell && (
        <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>
          {j.profit != null ? (
            <>
              <div style={{ fontSize: 11, color: pColor }}>{fmtISK(j.profit)}</div>
              {j.margin_pct != null && (
                <div style={{ fontSize: 9, color: pColor, opacity: 0.65, marginTop: 1 }}>
                  {j.margin_pct.toFixed(1)}%
                </div>
              )}
            </>
          ) : (
            <span style={{ color: PROFIT_NONE }}>—</span>
          )}
        </td>
      )}
      {/* Countdown */}
      <td ref={countdownRef} style={{ padding: '5px 10px 5px 6px', textAlign: 'right',
                                      fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'nowrap' }} />
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

function JobTable({ jobs, multiChar, showRuns, showSell }) {
  if (jobs.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
        NO ACTIVE JOBS
      </div>
    );
  }
  return (
    <table className="jobs-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
      <thead>
        <tr>
          <TH align="left">ITEM</TH>
          {multiChar && <TH>CHAR</TH>}
          {showSell  && <TH>PROFIT</TH>}
          <TH>REMAINING</TH>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j, idx) => (
          <JobRow key={j.job_id} j={j} idx={idx} multiChar={multiChar} showRuns={showRuns} showSell={showSell} />
        ))}
      </tbody>
    </table>
  );
}

export default function ManufacturingJobs() {
  const { data, loading, error } = useApi('/api/industry/jobs');
  // Selected chip filters — default to Manufacturing + Reaction
  const [activeFilters, setActiveFilters] = useState(new Set(['Manufacturing', 'Reaction']));

  const jobs = data?.jobs || [];

  // Seed character colors in arrival order so they're consistent
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

  // Count per chip (Research = ME + TE combined)
  const countByChip = {};
  CHIP_LABELS.forEach(chip => { countByChip[chip] = 0; });
  jobs.forEach(j => {
    for (const [chip, acts] of Object.entries(CHIP_TO_ACTIVITIES)) {
      if (acts.includes(j.activity)) { countByChip[chip]++; break; }
    }
  });

  function toggleFilter(chip) {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(chip)) {
        if (next.size === 1) return prev; // keep at least one
        next.delete(chip);
      } else {
        next.add(chip);
      }
      return next;
    });
  }

  // Expand active chip labels → actual activity names for filtering
  const activeActivityNames = new Set(
    [...activeFilters].flatMap(chip => CHIP_TO_ACTIVITIES[chip] || [chip])
  );
  const visibleJobs = jobs.filter(j => activeActivityNames.has(j.activity));

  // showRuns/showSell only when all visible jobs are MFG activities
  const allMfg = visibleJobs.every(j => MFG_ACTIVITIES.has(j.activity));

  // Detect multi-character for visible set
  const uniqueChars = new Set(visibleJobs.map(j => j.character_id).filter(Boolean));
  const multiChar   = uniqueChars.size > 1;

  const _now = Math.floor(Date.now() / 1000);
  const activeCount   = visibleJobs.filter(j => (j.end_ts - _now) > 0).length;
  const completeCount = visibleJobs.filter(j => (j.end_ts - _now) <= 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header: activity filter chips on the left, status counter on the right */}
      <div className="panel-hdr">
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {CHIP_LABELS.map(chip => {
            const isActive = activeFilters.has(chip);
            const count = countByChip[chip] || 0;
            return (
              <button
                key={chip}
                onClick={() => toggleFilter(chip)}
                className={`chip${isActive ? ' active' : ''}`}
                title={`${chip} (${count})`}
              >
                {chip.toUpperCase()}{count > 0 ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          {loading ? '' : `${activeCount} ACTIVE · ${completeCount} READY`}
        </span>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <LoadingState label="FETCHING JOBS" sub="ESI · INDUSTRY" />
        ) : (
          <JobTable
            jobs={visibleJobs}
            multiChar={multiChar}
            showRuns={allMfg}
            showSell={allMfg}
          />
        )}
      </div>

      {allMfg && !loading && visibleJobs.length > 0 && (
        <SummaryBar jobs={visibleJobs} />
      )}
    </div>
  );
}
