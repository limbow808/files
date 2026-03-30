import { useState, useMemo, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { ContextCard, PageHeader, SummaryCard } from '../components/shared/PagePrimitives';
import { fmtISK } from '../utils/fmt';
import Loader from '../components/shared/Loader';
import CraftJobProfitChart from '../components/CraftJobProfitChart';

const API = '';

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
  const activeViewLabel = tab === 'stats' ? 'By Item' : tab === 'log' ? 'Job Log' : 'Trends';
  const activeRowCount = tab === 'stats' ? sortedItems.length : tab === 'log' ? log.length : weeks.length;
  const syncStatus = syncing ? 'SYNCING ESI' : (syncMsg || 'READY');
  const loadingStatus = statsLoading || logLoading || (tab === 'trends' && timelineLoading)
    ? 'Refreshing revenue datasets…'
    : 'Craft history, job log, and trend rollups are current.';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="calc-page">
      <div className="panel app-page-shell revenue-shell">
        <PageHeader
          title="Revenue"
          subtitle="Completed-job economics, realized sales, and rolling craft performance across item, log, and trend views."
        >
          <span>{loadingStatus}</span>
          <span>{syncStatus}</span>
        </PageHeader>

        <div className="app-summary-grid">
          <SummaryCard label="Realized Profit" value={totals.realized_profit != null ? fmtISK(totals.realized_profit) : '—'} tone="good" className="revenue-summary-card" />
          <SummaryCard label="Total Cost" value={totals.total_cost != null ? fmtISK(totals.total_cost) : '—'} tone="neutral" className="revenue-summary-card" />
          <SummaryCard label="Avg Margin" value={avgMarginPct != null ? `${avgMarginPct.toFixed(1)}%` : '—'} tone="accent" className="revenue-summary-card" />
          <SummaryCard label="ISK / Day" value={iskPerDay != null ? fmtISK(iskPerDay) : '—'} tone="good" className="revenue-summary-card" />
          <SummaryCard label="Sell Rate" value={sellRatePct != null ? `${sellRatePct.toFixed(1)}%` : '—'} tone="neutral" className="revenue-summary-card" />
          <SummaryCard label="Market Estimate" value={totals.est_profit != null ? fmtISK(totals.est_profit) : '—'} tone="neutral" className="revenue-summary-card" />
        </div>

        <div className="app-context-grid">
          <ContextCard
            label="Horizon"
            value={`${days} DAY WINDOW`}
            meta={`${totals.job_count ?? 0} jobs · ${(totals.total_runs ?? 0).toLocaleString()} runs tracked in the selected period`}
          />
          <ContextCard
            label="Active View"
            value={`${activeViewLabel.toUpperCase()} · ${activeRowCount.toLocaleString()} rows`}
            meta={tab === 'trends' ? 'Weekly rollups pair the profit chart with cost, revenue, and cumulative-profit history.' : tab === 'log' ? 'The job log shows imported completed runs with material cost, estimated profit, and completion date.' : 'The by-item view aggregates realized and estimated performance by manufactured output.'}
          />
          <ContextCard
            label="Sync Status"
            value={syncStatus}
            meta="Sync ESI imports completed industry jobs, then refreshes the item and log datasets used by this page."
          />
        </div>

        <div className="calc-filters">
          <div className="calc-filters-inputs bp-investment-filters">
            <div className="filter-group" style={{ borderRight: 'none' }}>
              <span className="filter-label">Horizon</span>
              <div className="filter-options">
                {[30, 60, 90].map((value) => (
                  <button key={value} className={`chip${days === value ? ' active' : ''}`} onClick={() => setDays(value)}>
                    {value}D
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">View</span>
              <div className="filter-options">
                {[['stats', 'By Item'], ['log', 'Job Log'], ['trends', 'Trends']].map(([key, label]) => (
                  <button key={key} className={`chip${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Sync</span>
              <div className="filter-options">
                <button className="chip" onClick={handleSync} disabled={syncing}>
                  {syncing ? 'Syncing…' : 'Sync ESI'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="revenue-content">

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
    </div>
  );
}

export default memo(CraftLogPage);
