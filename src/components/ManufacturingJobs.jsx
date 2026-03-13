import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';

const ACTIVITY_COLORS = {
  'Manufacturing': 'var(--accent)',
  'Reaction':      '#4da6ff',
  'TE Research':   '#aa88ff',
  'ME Research':   '#aa88ff',
  'Copying':       '#ffcc44',
  'Invention':     '#44ffaa',
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

function ProgressBar({ secs, totalSecs }) {
  const pct = totalSecs > 0 ? Math.max(0, Math.min(100, (1 - secs / totalSecs) * 100)) : 100;
  const color = secs <= 0 ? '#00cc66' : secs < 3600 ? 'var(--accent)' : '#4da6ff';
  return (
    <div style={{ height: 3, background: '#111', width: '100%', marginTop: 3 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 1s linear' }} />
    </div>
  );
}

export default function ManufacturingJobs() {
  const { data, loading, error } = useApi('/api/industry/jobs');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Live countdown tick
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const jobs = data?.jobs || [];

  // Calculate total duration per job for progress bar (end_ts - start implied from data)
  // We only have end_ts, so derive total from end_ts - "start" approximation via runs
  // Store end_ts from API — compare to now for countdown

  const activeJobs   = jobs.filter(j => j.seconds_remaining > 0);
  const completeJobs = jobs.filter(j => j.seconds_remaining <= 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="panel-hdr">
        <span className="panel-title">⚙ Manufacturing Jobs</span>
        <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          {loading ? 'LOADING…' : `${activeJobs.length} ACTIVE · ${completeJobs.length} READY`}
        </span>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && !data ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--dim)', fontSize: 11, letterSpacing: 2 }}>
            LOADING…
          </div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 2, textAlign: 'center' }}>
            NO ACTIVE JOBS
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left',  padding: '6px 12px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>ITEM</th>
                <th style={{ textAlign: 'center',padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>RUNS</th>
                <th style={{ textAlign: 'center',padding: '6px 10px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>TYPE</th>
                <th style={{ textAlign: 'right', padding: '6px 12px', fontSize: 10, color: 'var(--dim)', letterSpacing: 2, borderBottom: '1px solid var(--border)' }}>REMAINING</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => {
                const secsLeft = Math.max(0, j.end_ts - now);
                const isReady  = secsLeft <= 0;
                // Approximate total duration — end_ts stored in data, assume starts = end_ts - secsLeft (use a big placeholder)
                // We'll just pulse bar to 100% when done
                const urgent   = secsLeft > 0 && secsLeft < 3600;
                const aColor   = ACTIVITY_COLORS[j.activity] || 'var(--text)';
                return (
                  <tr key={j.job_id} style={{ borderBottom: '1px solid #0d0d0d' }}>
                    <td style={{ padding: '8px 12px', textAlign: 'left' }}>
                      <div style={{ fontFamily: 'var(--head)', fontSize: 13, letterSpacing: 1, color: isReady ? '#00cc66' : 'var(--text)' }}>
                        {j.product_name}
                      </div>
                      <ProgressBar secs={secsLeft} totalSecs={3600 * 24} />
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'center', fontSize: 11, color: 'var(--dim)' }}>×{j.runs}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <span style={{ fontSize: 10, color: aColor, letterSpacing: 1, border: `1px solid ${aColor}`, padding: '1px 5px', opacity: 0.8 }}>
                        {j.activity.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12,
                                 color: isReady ? '#00cc66' : urgent ? 'var(--accent)' : 'var(--text)' }}>
                      {fmtCountdown(secsLeft)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
