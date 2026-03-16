import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import Loader from '../components/shared/Loader';

const API = '';

function KpiCard({ label, value, sub, color = 'var(--text)' }) {
  return (
    <div style={{
      flex: 1, minWidth: 0,
      padding: '10px 14px',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 3,
    }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: 1.5, color: 'var(--dim)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color, lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>{sub}</span>}
    </div>
  );
}

export default function CraftLogPage() {
  const [days, setDays] = useState(90);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [tab, setTab] = useState('stats'); // 'stats' | 'log'

  const { data: statsData, loading: statsLoading, refetch: refetchStats } =
    useApi(`${API}/api/craft-stats?days=${days}`, [days]);
  const { data: logData, loading: logLoading, refetch: refetchLog } =
    useApi(`${API}/api/craft-log?days=${days}`, [days]);

  const stats  = statsData || {};
  const totals = stats.totals || {};
  const items  = stats.items  || [];
  const log    = logData?.log || [];

  async function handleSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await fetch(`${API}/api/craft-log?force=1`);
      const d = await r.json();
      setSyncMsg(`Synced ${d.count ?? 0} jobs from ESI`);
      refetchStats();
      refetchLog();
    } catch {
      setSyncMsg('Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const profitColor = (v) => v == null ? 'var(--dim)' : v >= 0 ? '#00cc66' : '#cc3333';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '6px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--accent)' }}>◈ CRAFT LOG</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {[30, 60, 90].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '2px 8px', background: days === d ? 'var(--accent)' : 'transparent',
              border: `1px solid ${days === d ? 'var(--accent)' : 'var(--border)'}`,
              color: days === d ? '#000' : 'var(--dim)',
              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, cursor: 'pointer', borderRadius: 2,
            }}>{d}D</button>
          ))}
        </div>
        <button onClick={handleSync} disabled={syncing} style={{
          padding: '2px 10px',
          background: 'transparent',
          border: '1px solid var(--border)',
          color: syncing ? 'var(--dim)' : 'var(--text)',
          fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
          cursor: syncing ? 'default' : 'pointer', borderRadius: 2,
        }}>
          {syncing ? 'SYNCING...' : 'SYNC ESI'}
        </button>
        {syncMsg && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#00cc66' }}>{syncMsg}</span>}
      </div>

      {/* KPI row */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <KpiCard
          label="REALIZED PROFIT"
          value={totals.realized_profit != null ? fmtISK(totals.realized_profit) : '—'}
          color={profitColor(totals.realized_profit)}
          sub="from actual sales"
        />
        <KpiCard
          label="TOTAL COST"
          value={totals.total_cost != null ? fmtISK(totals.total_cost) : '—'}
          color="#ffcc44"
          sub={`last ${days} days`}
        />
        <KpiCard
          label="REALIZED REVENUE"
          value={totals.realized_revenue != null ? fmtISK(totals.realized_revenue) : '—'}
          color="#4da6ff"
          sub="confirmed sales"
        />
        <KpiCard
          label="MARKET EST PROFIT"
          value={totals.est_profit != null ? fmtISK(totals.est_profit) : '—'}
          color="var(--dim)"
          sub="if all sell at market"
        />
        <KpiCard
          label="TOTAL RUNS"
          value={totals.total_runs != null ? totals.total_runs.toLocaleString() : '—'}
          sub={`${totals.job_count ?? 0} jobs`}
        />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {[['stats', 'BY ITEM'], ['log', 'JOB LOG']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '4px 16px',
            background: 'transparent', border: 'none',
            borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
            color: tab === key ? 'var(--accent)' : 'var(--dim)',
            fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
            cursor: 'pointer',
          }}>{label}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>

        {/* ── BY ITEM ── */}
        {tab === 'stats' && (
          <>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 60px 80px 90px 90px 90px 60px',
              padding: '3px 16px',
              borderBottom: '1px solid var(--border)',
              background: '#050505',
              position: 'sticky', top: 0, zIndex: 2,
            }}>
              {['ITEM', 'RUNS', 'COST', 'REALIZED', 'EST PROFIT', 'MKTPROFIT', 'JOBS'].map((h, i) => (
                <span key={i} style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)',
                  letterSpacing: 1, textAlign: i === 0 ? 'left' : 'right',
                }}>{h}</span>
              ))}
            </div>

            {statsLoading && !statsData && (
              <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
                <Loader size="md" label="FETCHING STATS" />
              </div>
            )}

            {items.length === 0 && !statsLoading && (
              <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', textAlign: 'center' }}>
                No data — click SYNC ESI to import your completed jobs.
              </div>
            )}

            {items.map((item, idx) => (
              <div key={item.product_type_id ?? idx} style={{
                display: 'grid',
                gridTemplateColumns: '1fr 60px 80px 90px 90px 90px 60px',
                padding: '4px 16px',
                borderBottom: '1px solid #0d0d0d',
                alignItems: 'center',
                background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {item.product_type_id && (
                    <img
                      src={`https://images.evetech.net/types/${item.product_type_id}/icon?size=32`}
                      width={16} height={16}
                      style={{ flexShrink: 0, imageRendering: 'crisp-edges' }}
                      onError={e => { e.target.style.display = 'none'; }}
                    />
                  )}
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10,
                    color: 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{item.product_name}</span>
                </div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                  {(item.total_runs ?? 0).toLocaleString()}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: '#ffcc44' }}>
                  {item.total_cost != null ? fmtISK(item.total_cost) : '—'}
                </span>
                {/* Realized profit — from actual sales */}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', fontWeight: 700, color: profitColor(item.realized_profit) }}>
                  {item.realized_profit != null ? fmtISK(item.realized_profit) : <span style={{ color: 'var(--dim)', fontWeight: 400 }}>unsold</span>}
                </span>
                {/* Est profit — market price × runs − cost */}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                  {item.est_profit != null ? fmtISK(item.est_profit) : '—'}
                </span>
                {/* Est margin */}
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: profitColor(item.avg_margin) }}>
                  {item.avg_margin != null ? `${item.avg_margin.toFixed(1)}%` : '—'}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                  {item.job_count ?? 0}
                </span>
              </div>
            ))}
          </>
        )}

        {/* ── JOB LOG ── */}
        {tab === 'log' && (
          <>
            {/* Table header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 80px 60px 80px 80px 64px 90px',
              padding: '3px 16px',
              borderBottom: '1px solid var(--border)',
              background: '#050505',
              position: 'sticky', top: 0, zIndex: 2,
            }}>
              {['ITEM', 'CHARACTER', 'RUNS', 'COST', 'PROFIT', 'MARGIN', 'DATE'].map((h, i) => (
                <span key={i} style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)',
                  letterSpacing: 1, textAlign: i === 0 ? 'left' : 'right',
                }}>{h}</span>
              ))}
            </div>

            {logLoading && !logData && (
              <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
                <Loader size="md" label="FETCHING LOG" />
              </div>
            )}

            {log.length === 0 && !logLoading && (
              <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', textAlign: 'center' }}>
                No jobs yet — click SYNC ESI.
              </div>
            )}

            {log.map((job, idx) => {
              const date = job.completed_at ? job.completed_at.slice(0, 10) : '—';
              return (
                <div key={job.job_id ?? idx} style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 80px 60px 80px 80px 64px 90px',
                  padding: '3px 16px',
                  borderBottom: '1px solid #0d0d0d',
                  alignItems: 'center',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {job.product_type_id && (
                      <img
                        src={`https://images.evetech.net/types/${job.product_type_id}/icon?size=32`}
                        width={14} height={14}
                        style={{ flexShrink: 0, imageRendering: 'crisp-edges' }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                    )}
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10,
                      color: 'var(--text)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{job.product_name}</span>
                  </div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, textAlign: 'right', color: 'var(--dim)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.char_name ?? '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                    {job.runs ?? '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: '#ffcc44' }}>
                    {job.material_cost != null ? fmtISK(job.material_cost) : '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', fontWeight: 600, color: profitColor(job.est_profit) }}>
                    {job.est_profit != null ? fmtISK(job.est_profit) : '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: profitColor(job.margin_pct) }}>
                    {job.margin_pct != null ? `${job.margin_pct.toFixed(1)}%` : '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, textAlign: 'right', color: 'var(--dim)' }}>
                    {date}
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
