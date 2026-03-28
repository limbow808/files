import { memo, useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { API } from '../App';
import { fmtDuration, fmtISK, fmtVol } from '../utils/fmt';

const SORT_DEFAULT = { key: 'payback_days', dir: 'asc' };

const COLUMNS = [
  { key: 'name', label: 'ITEM', align: 'left' },
  { key: 'price', label: 'BPO PRICE' },
  { key: 'expected_daily_profit', label: 'DAILY PROFIT' },
  { key: 'payback_days', label: 'PAYBACK' },
  { key: 'avg_daily_volume', label: 'DEMAND' },
  { key: 'market_spread_pct', label: 'SPREAD' },
  { key: 'value_gap_pct', label: 'VALUE GAP' },
  { key: 'tech', label: 'TECH' },
];

function SummaryCard({ label, value, tone = 'neutral' }) {
  return (
    <div className={`bp-investment-summary bp-investment-summary--${tone}`}>
      <div className="bp-investment-summary__value">{value}</div>
      <div className="bp-investment-summary__label">{label}</div>
    </div>
  );
}

function fmtPct(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function fmtDays(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value >= 365) return `${(value / 365).toFixed(1)}y`;
  if (value >= 30) return `${(value / 30).toFixed(1)}mo`;
  if (value >= 1) return `${value.toFixed(1)}d`;
  return `${(value * 24).toFixed(1)}h`;
}

function compareValues(left, right, dir) {
  const leftMissing = left == null || left === '';
  const rightMissing = right == null || right === '';
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (typeof left === 'string' || typeof right === 'string') {
    return dir === 'asc'
      ? String(left).localeCompare(String(right))
      : String(right).localeCompare(String(left));
  }
  return dir === 'asc' ? left - right : right - left;
}

function MarketSparkline({ series }) {
  if (!Array.isArray(series) || series.length < 2) {
    return <div className="market-sparkline market-sparkline--empty">COLLECTING HISTORY…</div>;
  }
  const values = series.map((point) => Number(point.average || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * 100;
    const y = 100 - (((value - min) / range) * 100);
    return `${x},${y}`;
  }).join(' ');
  const area = `0,100 ${points} 100,100`;
  return (
    <div className="market-sparkline">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="marketSparkFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,71,0,0.28)" />
            <stop offset="100%" stopColor="rgba(255,71,0,0.03)" />
          </linearGradient>
        </defs>
        <polyline className="market-sparkline__grid" points="0,75 100,75" />
        <polyline className="market-sparkline__grid" points="0,50 100,50" />
        <polyline className="market-sparkline__grid" points="0,25 100,25" />
        <polygon className="market-sparkline__area" points={area} />
        <polyline className="market-sparkline__line" points={points} />
      </svg>
    </div>
  );
}

function PrognosisBadge({ label, tone = 'neutral' }) {
  return <div className={`prognosis-badge prognosis-badge--${tone}`}>{label}</div>;
}

function describeHistory(summary) {
  if (!summary || (summary.sample_days || 0) < 14) {
    return {
      label: 'Thin History',
      tone: 'neutral',
      description: 'The app is still building enough local market history to score this horizon confidently.',
    };
  }
  const change = Number(summary.change_pct || 0);
  const volatility = Number(summary.volatility_pct || 0);
  if (change >= 18 && volatility >= 20) {
    return { label: 'Overheated', tone: 'warn', description: 'Recent appreciation is strong, but the move is unstable and vulnerable to reversal.' };
  }
  if (change <= -12 && volatility >= 12) {
    return { label: 'Weakening', tone: 'bad', description: 'The trend is sliding and volatility suggests the market is still searching for a floor.' };
  }
  if (change <= -8 && volatility <= 12) {
    return { label: 'Undervalued', tone: 'good', description: 'Pricing has softened without panic-style volatility, which can improve long-horizon entry quality.' };
  }
  if (Math.abs(change) <= 8 && volatility <= 12) {
    return { label: 'Stable', tone: 'good', description: 'The trend is controlled and the market is moving with relatively low volatility over this horizon.' };
  }
  return { label: 'Mixed', tone: 'neutral', description: 'Trend and volatility are pulling in different directions, so the entry case needs more scrutiny.' };
}

function valueGapPct(row) {
  const reference = Number(row.average_price || row.adjusted_price || 0);
  const price = Number(row.price || 0);
  if (reference <= 0 || price <= 0) return null;
  return ((price - reference) / reference) * 100.0;
}

function DetailStat({ label, value, tone }) {
  return (
    <div className="tools-detail-stat">
      <div className="tools-detail-stat__label">{label}</div>
      <div className="tools-detail-stat__value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

function HistoryCard({ title, summary, current, loading, error, stale, series }) {
  const outlook = describeHistory(summary);
  return (
    <div className="market-history-card">
      <div className="market-history-card__head">
        <div>
          <div className="market-history-card__title">{title}</div>
          <div className="market-history-card__sub">{loading ? 'Loading history…' : stale ? 'Refreshing history…' : error ? 'History unavailable' : `${summary?.sample_days || 0} daily points cached`}</div>
        </div>
        <PrognosisBadge label={outlook.label} tone={outlook.tone} />
      </div>
      <MarketSparkline series={series} />
      <div className="market-history-summary">
        <DetailStat label="Current Ask" value={fmtISK(current?.sell)} />
        <DetailStat label="Trend" value={fmtPct(summary?.change_pct)} tone={Number(summary?.change_pct || 0) >= 0 ? 'var(--green)' : 'var(--accent)'} />
        <DetailStat label="Volatility" value={fmtPct(summary?.volatility_pct)} />
        <DetailStat label="Avg Volume" value={fmtVol(summary?.avg_volume)} />
      </div>
      <div className="tools-source-card__warning">{outlook.description}</div>
    </div>
  );
}

export default memo(function MarketPrognosisPage({ refreshKey = 0 }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(SORT_DEFAULT);
  const [affordableOnly, setAffordableOnly] = useState(true);
  const [hideOwned, setHideOwned] = useState(true);
  const [techFilter, setTechFilter] = useState('ALL');
  const [historyDays, setHistoryDays] = useState(90);
  const [selectedBlueprintId, setSelectedBlueprintId] = useState(null);

  const { data, loading, error, stale, refetch } = useApi(`${API}/api/bpo_market_scan`, [refreshKey]);
  const rows = data?.results || [];

  const filteredRows = useMemo(() => {
    let next = rows.map((row) => ({ ...row, value_gap_pct: valueGapPct(row) }));
    if (search) {
      const query = search.toLowerCase();
      next = next.filter((row) => {
        const name = row.name || '';
        const group = row.item_group || '';
        const category = row.category || '';
        return name.toLowerCase().includes(query)
          || group.toLowerCase().includes(query)
          || category.toLowerCase().includes(query);
      });
    }
    if (affordableOnly) next = next.filter((row) => row.affordable !== false);
    if (hideOwned) next = next.filter((row) => !row.already_owned);
    if (techFilter !== 'ALL') next = next.filter((row) => String(row.tech || '').toUpperCase() === techFilter);
    return [...next].sort((left, right) => {
      const value = compareValues(left[sort.key], right[sort.key], sort.dir);
      if (value !== 0) return value;
      return compareValues(left.payback_days, right.payback_days, 'asc');
    });
  }, [affordableOnly, hideOwned, rows, search, sort, techFilter]);

  useEffect(() => {
    if (!filteredRows.length) {
      setSelectedBlueprintId(null);
      return;
    }
    if (!filteredRows.some((row) => row.blueprint_id === selectedBlueprintId)) {
      setSelectedBlueprintId(filteredRows[0].blueprint_id);
    }
  }, [filteredRows, selectedBlueprintId]);

  const selectedRow = filteredRows.find((row) => row.blueprint_id === selectedBlueprintId) || null;
  const outputHistoryUrl = selectedRow ? `${API}/api/tools/market-history?type_id=${selectedRow.output_id}&days=${historyDays}` : null;
  const bpoHistoryUrl = selectedRow ? `${API}/api/tools/market-history?type_id=${selectedRow.blueprint_id}&days=${historyDays}` : null;
  const { data: outputHistory, loading: outputLoading, error: outputError, stale: outputStale } = useApi(outputHistoryUrl, [outputHistoryUrl]);
  const { data: bpoHistory, loading: bpoLoading, error: bpoError, stale: bpoStale } = useApi(bpoHistoryUrl, [bpoHistoryUrl]);

  const bestPayback = filteredRows.find((row) => row.payback_days != null) || null;
  const topDailyProfit = filteredRows.reduce((best, row) => {
    if (!best) return row;
    return (row.expected_daily_profit || 0) > (best.expected_daily_profit || 0) ? row : best;
  }, null);
  const highestDemand = filteredRows.reduce((best, row) => {
    if (!best) return row;
    return (row.avg_daily_volume || 0) > (best.avg_daily_volume || 0) ? row : best;
  }, null);

  function toggleSort(key) {
    setSort((current) => {
      if (current.key === key) {
        return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
      }
      return { key, dir: key === 'payback_days' ? 'asc' : 'desc' };
    });
  }

  return (
    <div className="calc-page">
      <div className="panel tools-shell">
        <div className="panel-hdr bp-investment-header">
          <div>
            <div className="panel-title">Market Prognosis</div>
            <div className="bp-investment-subtitle">
              Exact current BPO pricing, output liquidity, and cached market history for evaluating blueprint entries as long-term investments.
            </div>
          </div>
          <div className="tools-header-meta">
            <span>{stale ? 'Refreshing live market view…' : 'Jita market + cached history'}</span>
            <button type="button" className="header-scan-btn" onClick={refetch}>Refresh</button>
          </div>
        </div>

        <div className="bp-investment-summary-grid">
          <SummaryCard label="Visible Opportunities" value={filteredRows.length.toLocaleString()} tone="neutral" />
          <SummaryCard label="Fastest Payback" value={bestPayback ? `${bestPayback.name} · ${fmtDays(bestPayback.payback_days)}` : '—'} tone="good" />
          <SummaryCard label="Highest Daily Profit" value={topDailyProfit ? `${topDailyProfit.name} · ${fmtISK(topDailyProfit.expected_daily_profit)}` : '—'} tone="accent" />
          <SummaryCard label="Deepest Demand" value={highestDemand ? `${highestDemand.name} · ${fmtVol(highestDemand.avg_daily_volume)}` : '—'} tone="neutral" />
        </div>

        <div className="calc-filters">
          <div className="calc-filters-inputs bp-investment-filters">
            <div className="filter-group" style={{ borderRight: 'none' }}>
              <span className="filter-label">Search</span>
              <input
                className="calc-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Item, group, or category"
                style={{ width: 240 }}
              />
            </div>

            <div className="filter-group">
              <span className="filter-label">Horizon</span>
              <div className="filter-options">
                {[30, 90, 180].map((days) => (
                  <button key={days} className={`chip${historyDays === days ? ' active' : ''}`} onClick={() => setHistoryDays(days)}>
                    {days}d
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Tech</span>
              <div className="filter-options">
                {['ALL', '1', '2'].map((option) => (
                  <button key={option} className={`chip${techFilter === option ? ' active' : ''}`} onClick={() => setTechFilter(option)}>
                    {option === 'ALL' ? 'All' : `T${option}`}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Filters</span>
              <div className="filter-options">
                <button className={`chip${affordableOnly ? ' active' : ''}`} onClick={() => setAffordableOnly((value) => !value)}>
                  Affordable
                </button>
                <button className={`chip${hideOwned ? ' active' : ''}`} onClick={() => setHideOwned((value) => !value)}>
                  Hide Owned
                </button>
              </div>
            </div>
          </div>
        </div>

        {loading && !rows.length && (
          <div className="loading-state">
            <div className="loading-label">Loading market prognosis</div>
            <div className="loading-sub">Pricing blueprint originals against current profitability and cached history.</div>
          </div>
        )}

        {error && !rows.length && (
          <div className="error-banner">
            <span>Market prognosis feed unavailable.</span> Check that the backend is running and market data can be calculated.
          </div>
        )}

        {!loading && !error && !filteredRows.length && (
          <div className="loading-state">
            <div className="loading-label">No prognosis candidates</div>
            <div className="loading-sub">Try clearing filters or refresh market data.</div>
          </div>
        )}

        {!!filteredRows.length && (
          <div className="market-prognosis-layout">
            <div className="calc-body bp-investment-table-wrap">
              <table className="calc-table bp-investment-table market-prognosis-table">
                <thead>
                  <tr>
                    {COLUMNS.map((column) => {
                      const active = sort.key === column.key;
                      const label = active ? `${column.label} ${sort.dir === 'asc' ? '▲' : '▼'}` : column.label;
                      return (
                        <th
                          key={column.key}
                          onClick={() => toggleSort(column.key)}
                          className={column.align === 'left' ? 'bp-investment-table__left' : ''}
                          style={{ cursor: 'pointer' }}
                        >
                          {label}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr
                      key={row.blueprint_id}
                      className={`row-profitable${row.blueprint_id === selectedBlueprintId ? ' market-prognosis-row--active' : ''}`}
                      onClick={() => setSelectedBlueprintId(row.blueprint_id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="bp-investment-table__left">
                        <div className="bp-investment-item">
                          <img
                            className="bp-investment-item__icon"
                            src={`https://images.evetech.net/types/${row.output_id}/icon?size=32`}
                            alt=""
                            onError={(event) => { event.target.style.display = 'none'; }}
                          />
                          <div>
                            <div className="bp-investment-item__name">{row.name}</div>
                            <div className="bp-investment-item__meta">
                              <span>{row.item_group || 'Blueprint'}</span>
                              {row.personal_owned && <span className="bp-investment-badge bp-investment-badge--owned">OWNED</span>}
                              {row.corp_owned && <span className="bp-investment-badge bp-investment-badge--corp">CORP</span>}
                              {row.affordable && <span className="bp-investment-badge bp-investment-badge--affordable">READY</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{fmtISK(row.price)}</td>
                      <td>{fmtISK(row.expected_daily_profit)}</td>
                      <td>{fmtDays(row.payback_days)}</td>
                      <td>{fmtVol(row.avg_daily_volume)}</td>
                      <td>{fmtPct(row.market_spread_pct)}</td>
                      <td>{fmtPct(row.value_gap_pct)}</td>
                      <td>{row.tech ? `T${row.tech}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <aside className="tools-detail-panel market-prognosis-detail">
              {selectedRow ? (
                <>
                  <div className="tools-detail-head">
                    <div>
                      <div className="tools-detail-title">{selectedRow.name}</div>
                      <div className="tools-detail-subtitle">{selectedRow.item_group || selectedRow.category || 'Blueprint'} · T{selectedRow.tech || '—'}</div>
                    </div>
                    <PrognosisBadge label={describeHistory(outputHistory?.summary).label} tone={describeHistory(outputHistory?.summary).tone} />
                  </div>

                  <div className="tools-detail-copy">
                    Blueprint entry is priced against current Jita data, while the detail lane shows cached history for both the finished item and the blueprint original itself over the selected horizon.
                  </div>

                  <div className="tools-detail-grid">
                    <DetailStat label="BPO Ask" value={fmtISK(selectedRow.market_price)} />
                    <DetailStat label="BPO Bid" value={fmtISK(selectedRow.market_buy_price)} />
                    <DetailStat label="Spread" value={fmtPct(selectedRow.market_spread_pct)} />
                    <DetailStat label="Value Gap" value={fmtPct(selectedRow.value_gap_pct)} tone={Number(selectedRow.value_gap_pct || 0) <= 0 ? 'var(--green)' : 'var(--accent)'} />
                    <DetailStat label="Daily Profit" value={fmtISK(selectedRow.expected_daily_profit)} tone="var(--green)" />
                    <DetailStat label="Payback" value={fmtDays(selectedRow.payback_days)} />
                    <DetailStat label="Demand" value={fmtVol(selectedRow.avg_daily_volume)} />
                    <DetailStat label="Job Time" value={fmtDuration(selectedRow.duration)} />
                  </div>

                  <HistoryCard
                    title="Output Market"
                    summary={outputHistory?.summary}
                    current={outputHistory?.current}
                    loading={outputLoading}
                    error={outputError}
                    stale={outputStale}
                    series={outputHistory?.series}
                  />

                  <HistoryCard
                    title="BPO Market"
                    summary={bpoHistory?.summary}
                    current={bpoHistory?.current}
                    loading={bpoLoading}
                    error={bpoError}
                    stale={bpoStale}
                    series={bpoHistory?.series}
                  />

                  <div className="bp-investment-links" style={{ marginTop: 10 }}>
                    <a href={`https://www.eveworkbench.com/market/sell/${selectedRow.blueprint_id}`} target="_blank" rel="noreferrer">BPO</a>
                    <a href={`https://market.fuzzwork.co.uk/type/${selectedRow.output_id}/`} target="_blank" rel="noreferrer">ITEM</a>
                  </div>
                </>
              ) : (
                <div className="tools-detail-empty">Select a blueprint to inspect its exact market state and cached history.</div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
});