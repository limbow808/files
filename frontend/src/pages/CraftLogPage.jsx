import { useState, useMemo, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import Loader from '../components/shared/Loader';
import CraftJobProfitChart from '../components/CraftJobProfitChart';

const API = '';

// ── Small helpers ─────────────────────────────────────────────────────────────

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

const profitColor  = v => v == null ? 'var(--dim)' : v >= 0 ? '#00cc66' : '#cc3333';
const sellRateColor = rate => {
  if (rate == null) return 'var(--dim)';
  if (rate >= 0.8)  return '#00cc66';
  if (rate >= 0.5)  return '#ffcc44';
  return '#cc3333';
};

// BY ITEM column definitions — used for both header and row rendering
const ITEM_COLS = [
  { key: 'product_name',    label: 'ITEM',          align: 'left',  w: '2fr'  },
  { key: 'total_runs',      label: 'RUNS',          align: 'right', w: '52px' },
  { key: 'total_material_cost', label: 'MAT COST',  align: 'right', w: '82px' },
  { key: 'total_overhead',  label: 'OVERHEAD',      align: 'right', w: '82px' },
  { key: 'realized_profit', label: 'REALIZED',      align: 'right', w: '82px' },
  { key: 'est_profit',      label: 'EST PROFIT',    align: 'right', w: '82px' },
  { key: 'avg_margin',      label: 'MARGIN',        align: 'right', w: '62px' },
  { key: 'sell_rate',       label: 'SELL RATE',     align: 'right', w: '68px' },
  { key: 'avg_sell_days',   label: 'AVG SELL',      align: 'right', w: '64px' },
  { key: 'job_count',       label: 'JOBS',          align: 'right', w: '44px' },
];
const ITEM_GRID = ITEM_COLS.map(c => c.w).join(' ');

// ── Page component ────────────────────────────────────────────────────────────

function CraftLogPage() {
  const [days,    setDays]    = useState(90);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [tab,     setTab]     = useState('stats');   // 'stats' | 'log' | 'trends'
  const [sortCol, setSortCol] = useState('est_profit');
  const [sortDir, setSortDir] = useState('desc');

  const { data: statsData,    loading: statsLoading,    refetch: refetchStats } =
    useApi(`${API}/api/craft-stats?days=${days}`, [days]);
  const { data: logData,      loading: logLoading,      refetch: refetchLog } =
    useApi(`${API}/api/craft-log?days=${days}`, [days]);
  const { data: timelineData, loading: timelineLoading } =
    useApi(tab === 'trends' ? `${API}/api/craft-timeline?days=${days}` : null, [days, tab]);

  const stats   = statsData  || {};
  const totals  = stats.totals || {};
  const items   = stats.items  || [];
  const log     = logData?.log || [];
  const weeks   = timelineData?.weeks || [];

  // Sorted BY ITEM rows
  const sortedItems = useMemo(() => {
    if (!items.length) return items;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const av = a[sortCol] ?? (sortDir === 'asc' ?  Infinity : -Infinity);
      const bv = b[sortCol] ?? (sortDir === 'asc' ?  Infinity : -Infinity);
      if (typeof av === 'string') return dir * String(av).localeCompare(String(bv));
      return dir * (Number(av) - Number(bv));
    });
  }, [items, sortCol, sortDir]);

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await fetch(`${API}/api/craft-log?force=1`);
      const d = await r.json();
      setSyncMsg(`Synced ${d.count ?? 0} jobs`);
      refetchStats();
      refetchLog();
    } catch {
      setSyncMsg('Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  // ── Derived KPI values ─────────────────────────────────────────────────────
  const avgMarginPct = totals.est_revenue > 0
    ? (totals.est_profit / totals.est_revenue * 100)
    : null;
  const iskPerDay = totals.realized_profit != null && days > 0
    ? totals.realized_profit / days
    : null;
  const sellRatePct = totals.est_revenue > 0 && totals.realized_revenue != null
    ? (totals.realized_revenue / totals.est_revenue * 100)
    : null;
  const sellRateKpiColor = sellRatePct == null ? 'var(--dim)'
    : sellRatePct >= 80 ? '#00cc66'
    : sellRatePct >= 50 ? '#ffcc44'
    : '#cc3333';

  // ── Render ─────────────────────────────────────────────────────────────────
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
          padding: '2px 10px', background: 'transparent',
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
          sub="mat + inv/copy overhead"
        />
        <KpiCard
          label="AVG MARGIN"
          value={avgMarginPct != null ? `${avgMarginPct.toFixed(1)}%` : '—'}
          color={profitColor(avgMarginPct)}
          sub="est profit ÷ revenue"
        />
        <KpiCard
          label="ISK / DAY"
          value={iskPerDay != null ? fmtISK(iskPerDay) : '—'}
          color={profitColor(iskPerDay)}
          sub={`over ${days} days`}
        />
        <KpiCard
          label="SELL RATE"
          value={sellRatePct != null ? `${sellRatePct.toFixed(1)}%` : '—'}
          color={sellRateKpiColor}
          sub="realized ÷ est revenue"
        />
        <KpiCard
          label="MKT EST"
          value={totals.est_profit != null ? fmtISK(totals.est_profit) : '—'}
          color="var(--dim)"
          sub={`${totals.job_count ?? 0} jobs · ${(totals.total_runs ?? 0).toLocaleString()} runs`}
        />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {[['stats', 'BY ITEM'], ['log', 'JOB LOG'], ['trends', 'TRENDS']].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            padding: '4px 16px', background: 'transparent', border: 'none',
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
            {/* Sticky header */}
            <div style={{
              display: 'grid', gridTemplateColumns: ITEM_GRID,
              padding: '3px 16px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg)',
              position: 'sticky', top: 0, zIndex: 2,
            }}>
              {ITEM_COLS.map(col => (
                <span key={col.key}
                  onClick={() => toggleSort(col.key)}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1,
                    textAlign: col.align,
                    color: sortCol === col.key ? 'var(--accent)' : 'var(--dim)',
                    cursor: 'pointer', userSelect: 'none',
                  }}
                >
                  {col.label}{sortCol === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </span>
              ))}
            </div>

            {statsLoading && !statsData && (
              <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
                <Loader size="md" variant="bar" label="FETCHING STATS" />
              </div>
            )}
            {sortedItems.length === 0 && !statsLoading && (
              <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', textAlign: 'center' }}>
                No data — click SYNC ESI to import your completed jobs.
              </div>
            )}

            {sortedItems.map((item, idx) => {
              const sr   = item.sell_rate;
              const srColor = sellRateColor(sr);
              const hasOverhead = item.total_overhead != null && item.total_overhead > 0;
              return (
                <div key={item.product_type_id ?? idx} style={{
                  display: 'grid', gridTemplateColumns: ITEM_GRID,
                  padding: '4px 16px',
                  borderBottom: '1px solid #0d0d0d',
                  alignItems: 'center',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                }}>
                  {/* ITEM */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {item.product_type_id && (
                      <img
                        src={`https://images.evetech.net/types/${item.product_type_id}/icon?size=32`}
                        width={16} height={16}
                        style={{ flexShrink: 0, imageRendering: 'crisp-edges' }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                    )}
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.product_name}
                    </span>
                    {hasOverhead && (
                      <span title="T2: includes invention + copy overhead" style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--accent)', opacity: 0.6, flexShrink: 0 }}>T2</span>
                    )}
                  </div>
                  {/* RUNS */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                    {(item.total_runs ?? 0).toLocaleString()}
                  </span>
                  {/* MAT COST */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: '#ffcc44' }}>
                    {item.total_material_cost != null ? fmtISK(item.total_material_cost) : '—'}
                  </span>
                  {/* OVERHEAD */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: hasOverhead ? '#cc6633' : 'var(--dim)' }}>
                    {hasOverhead ? fmtISK(item.total_overhead) : '—'}
                  </span>
                  {/* REALIZED */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', fontWeight: 700, color: profitColor(item.realized_profit) }}>
                    {item.realized_profit != null ? fmtISK(item.realized_profit) : <span style={{ color: 'var(--dim)', fontWeight: 400 }}>unsold</span>}
                  </span>
                  {/* EST PROFIT */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: profitColor(item.est_profit) }}>
                    {item.est_profit != null ? fmtISK(item.est_profit) : '—'}
                  </span>
                  {/* MARGIN */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: profitColor(item.avg_margin) }}>
                    {item.avg_margin != null ? `${item.avg_margin.toFixed(1)}%` : '—'}
                  </span>
                  {/* SELL RATE */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: srColor }}>
                    {sr != null ? `${(sr * 100).toFixed(0)}%` : '—'}
                  </span>
                  {/* AVG SELL */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                    {item.avg_sell_days != null ? `${item.avg_sell_days.toFixed(1)}d` : '—'}
                  </span>
                  {/* JOBS */}
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                    {item.job_count ?? 0}
                  </span>
                </div>
              );
            })}
          </>
        )}

        {/* ── JOB LOG ── */}
        {tab === 'log' && (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2fr 80px 55px 82px 82px 64px 90px',
              padding: '3px 16px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg)',
              position: 'sticky', top: 0, zIndex: 2,
            }}>
              {['ITEM', 'CHARACTER', 'RUNS', 'MAT COST', 'PROFIT', 'MARGIN', 'DATE'].map((h, i) => (
                <span key={i} style={{
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)',
                  letterSpacing: 1, textAlign: i === 0 ? 'left' : 'right',
                }}>{h}</span>
              ))}
            </div>

            {logLoading && !logData && (
              <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
                <Loader size="md" variant="bar" label="FETCHING LOG" />
              </div>
            )}
            {log.length === 0 && !logLoading && (
              <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', textAlign: 'center' }}>
                No jobs yet — click SYNC ESI.
              </div>
            )}

            {log.map((job, idx) => {
              const date = job.completed_at ? job.completed_at.slice(0, 10) : '—';
              const hasOverhead = job.overhead_cost != null && job.overhead_cost > 0;
              return (
                <div key={job.job_id ?? idx} style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 80px 55px 82px 82px 64px 90px',
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
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.product_name}
                    </span>
                    {hasOverhead && (
                      <span title={`T2 overhead: ${fmtISK(job.overhead_cost)}`} style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--accent)', opacity: 0.6, flexShrink: 0 }}>T2</span>
                    )}
                  </div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, textAlign: 'right', color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {job.char_name ?? '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                    {job.runs ?? '—'}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: '#ffcc44' }}>
                    {job.material_cost != null ? fmtISK(job.material_cost) : '—'}
                    {hasOverhead && (
                      <span style={{ color: '#cc6633', marginLeft: 3 }}>+{fmtISK(job.overhead_cost)}</span>
                    )}
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

        {/* ── TRENDS ── */}
        {tab === 'trends' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

            {/* Chart */}
            <div style={{ height: 220, padding: '12px 16px 0', flexShrink: 0 }}>
              {timelineLoading && !timelineData ? (
                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Loader size="md" variant="bar" label="LOADING TRENDS" />
                </div>
              ) : (
                <CraftJobProfitChart weeks={weeks} />
              )}
            </div>

            {/* Legend */}
            <div style={{
              display: 'flex', gap: 18, padding: '6px 16px 4px',
              flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 10, height: 10, background: 'rgba(0,204,102,0.75)' }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--dim)', letterSpacing: 1 }}>EST PROFIT</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 10, height: 10, background: 'rgba(255,204,68,0.25)' }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--dim)', letterSpacing: 1 }}>TOTAL COST (context)</span>
              </div>
            </div>

            {/* Weekly summary table */}
            {weeks.length > 0 && (
              <>
                <div style={{
                  display: 'grid', gridTemplateColumns: '90px 1fr 1fr 1fr 1fr 50px',
                  padding: '3px 16px',
                  borderTop: '1px solid var(--border)',
                  borderBottom: '1px solid var(--border)',
                  background: 'var(--bg)',
                  position: 'sticky', top: 0, zIndex: 2,
                  marginTop: 6,
                }}>
                  {['WEEK', 'COST', 'REVENUE', 'EST PROFIT', 'CUMULATIVE', 'JOBS'].map((h, i) => (
                    <span key={i} style={{
                      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)',
                      letterSpacing: 1, textAlign: i === 0 ? 'left' : 'right',
                    }}>{h}</span>
                  ))}
                </div>
                {[...weeks].reverse().map((w, idx) => (
                  <div key={w.week_label ?? idx} style={{
                    display: 'grid', gridTemplateColumns: '90px 1fr 1fr 1fr 1fr 50px',
                    padding: '3px 16px',
                    borderBottom: '1px solid #0d0d0d',
                    alignItems: 'center',
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                  }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>
                      {w.week_label || '—'}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: '#ffcc44' }}>
                      {fmtISK(w.total_cost || 0)}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: '#4da6ff' }}>
                      {fmtISK(w.est_revenue || 0)}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', fontWeight: 600, color: profitColor(w.est_profit) }}>
                      {fmtISK(w.est_profit || 0)}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: profitColor(w.cumulative_profit) }}>
                      {fmtISK(w.cumulative_profit || 0)}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', color: 'var(--dim)' }}>
                      {w.job_count ?? 0}
                    </span>
                  </div>
                ))}
              </>
            )}

            {!timelineLoading && weeks.length === 0 && (
              <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)', textAlign: 'center' }}>
                No data — click SYNC ESI to import your completed jobs.
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

export default memo(CraftLogPage);
