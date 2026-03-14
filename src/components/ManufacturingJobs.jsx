import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import CharTag from './CharTag';
import { charColor, seedCharColors } from '../utils/charColors';
import { fmtISK } from '../utils/fmt';

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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 80 }}>
      <span style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2 }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color, letterSpacing: 1 }}>{value}</span>
    </div>
  );

  return (
    <div style={{
      display: 'flex', justifyContent: 'space-around', alignItems: 'center',
      padding: '7px 12px',
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

function JobTable({ jobs, now, multiChar, showRuns, showSell }) {
  if (jobs.length === 0) {
    return (
      <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 2, textAlign: 'center' }}>
        NO ACTIVE JOBS
      </div>
    );
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left',  padding: '6px 12px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>ITEM</th>
          {showRuns && (
            <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>RUNS</th>
          )}
          {showSell && (
            <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>EST. SELL</th>
          )}
          {showSell && (
            <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>PROFIT</th>
          )}
          <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>TYPE</th>
          {multiChar && (
            <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>CHAR</th>
          )}
          <th style={{ textAlign: 'right', padding: '6px 12px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>REMAINING</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map(j => {
          const secsLeft = Math.max(0, j.end_ts - now);
          const isReady  = secsLeft <= 0;
          const urgent   = secsLeft > 0 && secsLeft < 3600;
          const aColor   = ACTIVITY_COLORS[j.activity] || 'var(--text)';
          const cColor   = j.character_id ? charColor(j.character_id) : 'var(--dim)';
          const pColor   = profitColor(j.profit);
          return (
            <tr key={j.job_id} style={{ borderBottom: '1px solid #0d0d0d' }}>
              <td style={{ padding: '8px 12px', textAlign: 'left' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 1, color: isReady ? '#00cc66' : 'var(--text)' }}>
                  {j.product_name}
                </div>
                <ProgressBar secs={secsLeft} totalSecs={j.total_secs || 86400} />
              </td>
              {showRuns && (
                <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: 'var(--dim)' }}>×{j.runs}</td>
              )}
              {showSell && (
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11,
                             color: j.sell_total != null ? 'var(--accent)' : 'var(--dim)' }}>
                  {j.sell_total != null ? fmtISK(j.sell_total) : '—'}
                </td>
              )}
              {showSell && (
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'var(--mono)' }}>
                  {j.profit != null ? (
                    <>
                      <div style={{ fontSize: 11, color: pColor }}>{fmtISK(j.profit)}</div>
                      <div style={{ fontSize: 9, color: pColor, opacity: 0.65, marginTop: 1 }}>
                        {j.margin_pct != null ? `${j.margin_pct.toFixed(1)}%` : ''}
                      </div>
                    </>
                  ) : (
                    <span style={{ color: PROFIT_NONE }}>—</span>
                  )}
                </td>
              )}
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                <span style={{ fontSize: 10, color: aColor, letterSpacing: 1, border: `1px solid ${aColor}`, padding: '1px 5px', opacity: 0.8 }}>
                  {j.activity.toUpperCase()}
                </span>
              </td>
              {multiChar && (
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                  <CharTag name={j.character_name} color={cColor} />
                </td>
              )}
              <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12,
                           color: isReady ? '#00cc66' : urgent ? 'var(--accent)' : 'var(--text)' }}>
                {fmtCountdown(secsLeft)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function ManufacturingJobs() {
  const { data, loading, error } = useApi('/api/industry/jobs');
  const [now, setNow]       = useState(() => Math.floor(Date.now() / 1000));
  // Selected chip filters — default to Manufacturing + Reaction
  const [activeFilters, setActiveFilters] = useState(new Set(['Manufacturing', 'Reaction']));

  // Live countdown tick
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

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

  const activeCount   = visibleJobs.filter(j => (j.end_ts - now) > 0).length;
  const completeCount = visibleJobs.filter(j => (j.end_ts - now) <= 0).length;

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
        <div style={{ padding: '12px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <div className="loading-state">
            <span className="loading-label">FETCHING JOBS</span>
            <span className="loading-sub">ESI · INDUSTRY</span>
          </div>
        ) : (
          <JobTable
            jobs={visibleJobs}
            now={now}
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
