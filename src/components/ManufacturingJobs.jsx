import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import CharTag from './CharTag';
import { charColor, seedCharColors } from '../utils/charColors';

const ACTIVITY_COLORS = {
  'Manufacturing': 'var(--accent)',
  'Reaction':      '#4da6ff',
  'TE Research':   '#aa88ff',
  'ME Research':   '#aa88ff',
  'Copying':       '#ffcc44',
  'Invention':     '#44ffaa',
};

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

function JobTable({ jobs, now, multiChar, showRuns }) {
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
          return (
            <tr key={j.job_id} style={{ borderBottom: '1px solid #0d0d0d' }}>
              <td style={{ padding: '8px 12px', textAlign: 'left' }}>
                <div style={{ fontFamily: 'var(--head)', fontSize: 13, letterSpacing: 1, color: isReady ? '#00cc66' : 'var(--text)' }}>
                  {j.product_name}
                </div>
                <ProgressBar secs={secsLeft} totalSecs={j.total_secs || 86400} />
              </td>
              {showRuns && (
                <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: 'var(--dim)' }}>×{j.runs}</td>
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
  const [now, setNow]   = useState(() => Math.floor(Date.now() / 1000));
  const [tab, setTab]   = useState('MFG');   // 'MFG' | 'RESEARCH'

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

  const mfgJobs      = jobs.filter(j => MFG_ACTIVITIES.has(j.activity));
  const researchJobs = jobs.filter(j => RESEARCH_ACTIVITIES.has(j.activity));
  const visibleJobs  = tab === 'MFG' ? mfgJobs : researchJobs;

  // Detect multi-character for visible set
  const uniqueChars = new Set(visibleJobs.map(j => j.character_id).filter(Boolean));
  const multiChar   = uniqueChars.size > 1;

  const activeCount   = visibleJobs.filter(j => (j.end_ts - now) > 0).length;
  const completeCount = visibleJobs.filter(j => (j.end_ts - now) <= 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header: tab-btn switcher (same style as Minerals/Orders) + status right */}
      <div className="panel-hdr" style={{ gap: 0, padding: 0, paddingRight: 16 }}>
        <div style={{ display: 'flex' }}>
          {[['MFG', `⚙ MFG (${mfgJobs.length})`], ['RESEARCH', `🔬 RESEARCH (${researchJobs.length})`]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`tab-btn${tab === key ? ' active' : ''}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          {loading ? 'LOADING…' : `${activeCount} ACTIVE · ${completeCount} READY`}
        </span>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="skeleton-row">
                  {[1,2,3,4].map(j => <td key={j}>&nbsp;</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <JobTable
            jobs={visibleJobs}
            now={now}
            multiChar={multiChar}
            showRuns={tab === 'MFG'}
          />
        )}
      </div>
    </div>
  );
}
