import { useMemo, useState, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { API } from '../App';
import { fmtDuration, fmtISK, fmtVol } from '../utils/fmt';

const SORT_DEFAULT = { key: 'payback_days', dir: 'asc' };

const COLUMNS = [
  { key: 'name', label: 'ITEM', align: 'left' },
  { key: 'category', label: 'CAT' },
  { key: 'tech', label: 'TECH' },
  { key: 'price', label: 'BPO PRICE' },
  { key: 'adj_net_profit', label: 'PROFIT/RUN' },
  { key: 'roi', label: 'ROI' },
  { key: 'isk_per_hour', label: 'ISK/HR' },
  { key: 'expected_daily_profit', label: 'DAILY PROFIT' },
  { key: 'payback_days', label: 'PAYBACK' },
  { key: 'breakeven_runs', label: 'B/E RUNS' },
  { key: 'avg_daily_volume', label: 'DEMAND' },
  { key: 'duration', label: 'JOB TIME' },
];

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

function SummaryCard({ label, value, tone = 'neutral' }) {
  return (
    <div className={`bp-investment-summary bp-investment-summary--${tone}`}>
      <div className="bp-investment-summary__value">{value}</div>
      <div className="bp-investment-summary__label">{label}</div>
    </div>
  );
}

function BlueprintsPage({ refreshKey = 0 }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(SORT_DEFAULT);
  const [affordableOnly, setAffordableOnly] = useState(true);
  const [hideOwned, setHideOwned] = useState(true);
  const [techFilter, setTechFilter] = useState('ALL');

  const { data, loading, error, stale } = useApi(`${API}/api/bpo_market_scan`, [refreshKey]);

  const rows = data?.results || [];
  const filteredRows = useMemo(() => {
    let next = rows;
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

    if (affordableOnly) {
      next = next.filter((row) => row.affordable !== false);
    }

    if (hideOwned) {
      next = next.filter((row) => !row.already_owned);
    }

    if (techFilter !== 'ALL') {
      next = next.filter((row) => String(row.tech || '').toUpperCase() === techFilter);
    }

    return [...next].sort((left, right) => {
      const value = compareValues(left[sort.key], right[sort.key], sort.dir);
      if (value !== 0) return value;
      return compareValues(left.payback_days, right.payback_days, 'asc');
    });
  }, [affordableOnly, hideOwned, rows, search, sort, techFilter]);

  const bestPayback = filteredRows.find((row) => row.payback_days != null) || null;
  const topDailyProfit = filteredRows.reduce((best, row) => {
    if (!best) return row;
    return (row.expected_daily_profit || 0) > (best.expected_daily_profit || 0) ? row : best;
  }, null);
  const affordableCount = filteredRows.filter((row) => row.affordable).length;

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
      <div className="panel bp-investment-shell">
        <div className="panel-hdr bp-investment-header">
          <div>
            <div className="panel-title">Blueprints</div>
            <div className="bp-investment-subtitle">
              Market-priced blueprint originals ranked by manufacturing payoff, invention-aware profitability, and liquidity.
            </div>
          </div>
          <div className="bp-investment-header__meta">
            <span>{stale ? 'Refreshing market data…' : 'Jita market feed'}</span>
            <span>{rows.length ? `${rows.length} priced BPOs` : 'No BPOs loaded yet'}</span>
          </div>
        </div>

        <div className="bp-investment-summary-grid">
          <SummaryCard label="Visible Opportunities" value={filteredRows.length.toLocaleString()} tone="neutral" />
          <SummaryCard label="Affordable Now" value={affordableCount.toLocaleString()} tone="good" />
          <SummaryCard
            label="Fastest Payback"
            value={bestPayback ? `${bestPayback.name} · ${fmtDays(bestPayback.payback_days)}` : '—'}
            tone="good"
          />
          <SummaryCard
            label="Highest Daily Profit"
            value={topDailyProfit ? `${topDailyProfit.name} · ${fmtISK(topDailyProfit.expected_daily_profit)}` : '—'}
            tone="accent"
          />
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
              <span className="filter-label">Tech</span>
              <div className="filter-options">
                {['ALL', '1', '2'].map((option) => (
                  <button
                    key={option}
                    className={`chip${techFilter === option ? ' active' : ''}`}
                    onClick={() => setTechFilter(option)}
                  >
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
            <div className="loading-label">Loading blueprint investments</div>
            <div className="loading-sub">Pricing BPOs against current calculator output</div>
          </div>
        )}

        {error && !rows.length && (
          <div className="error-banner">
            <span>Blueprint feed unavailable.</span> Check that the backend is running and market data can be calculated.
          </div>
        )}

        {!loading && !error && !filteredRows.length && (
          <div className="loading-state">
            <div className="loading-label">No blueprint opportunities</div>
            <div className="loading-sub">Try clearing filters or refresh market data.</div>
          </div>
        )}

        {!!filteredRows.length && (
          <div className="calc-body bp-investment-table-wrap">
            <table className="calc-table bp-investment-table">
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
                  <th>LINKS</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.blueprint_id} className="row-profitable">
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
                    <td>{row.category || '—'}</td>
                    <td>{row.tech ? `T${row.tech}` : '—'}</td>
                    <td>{fmtISK(row.price)}</td>
                    <td style={{ color: row.adj_net_profit > 0 ? 'var(--green)' : 'var(--text)' }}>{fmtISK(row.adj_net_profit)}</td>
                    <td>{fmtPct(row.roi)}</td>
                    <td>{fmtISK(row.isk_per_hour)}</td>
                    <td>{fmtISK(row.expected_daily_profit)}</td>
                    <td>{fmtDays(row.payback_days)}</td>
                    <td>{row.breakeven_runs != null ? row.breakeven_runs.toLocaleString() : '—'}</td>
                    <td>{fmtVol(row.avg_daily_volume)}</td>
                    <td>{fmtDuration(row.duration)}</td>
                    <td>
                      <div className="bp-investment-links">
                        <a href={`https://www.eveworkbench.com/market/sell/${row.blueprint_id}`} target="_blank" rel="noreferrer">BPO</a>
                        <a href={`https://market.fuzzwork.co.uk/type/${row.output_id}/`} target="_blank" rel="noreferrer">ITEM</a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(BlueprintsPage);
