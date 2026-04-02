import { memo, useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { LoadingState } from '../components/ui';
import { API } from '../App';
import { ContextCard, DetailStat, PageHeader, SummaryCard, TwoPaneLayout } from '../components/shared/PagePrimitives';
import { MARKET_HUBS, getHubLabel } from '../utils/appSettings';
import { fmtISK } from '../utils/fmt';

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');
const GOAL_OPTIONS = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'max', label: 'Max' },
];
const LIMIT_OPTIONS = [20, 40, 60, 100];

function coercePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function formatSellDays(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const days = Number(value);
  if (days < 1) return `${(days * 24).toFixed(days < 0.5 ? 1 : 0)}h`;
  return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
}

function formatReadySourceValue(source) {
  if (!source) return 'Awaiting source';
  if (source.mode === 'corp') {
    const corpName = String(source.corporation_name || 'Corp').toUpperCase();
    const division = String(source.division_label || source.division_flag || 'UNSCOPED').toUpperCase();
    return `${corpName} · ${division}`;
  }
  if (source.mode === 'personal') return 'PERSONAL ASSETS';
  if (source.mode === 'none') return 'NOT CONFIGURED';
  return String(source.mode || 'unknown').toUpperCase();
}

function formatReadySourceMeta(source, pipelineSummary) {
  if (!source) return 'Awaiting outbound stock source.';
  if (source.warning) return source.warning;
  const deliveredUnits = Number(pipelineSummary?.delivered_asset_units || 0);
  if (source.mode === 'corp') {
    const typeCount = Number(source.type_count || 0);
    const stackUnits = Number(source.stack_units || 0);
    return `${NUMBER_FORMATTER.format(typeCount)} indexed types · ${NUMBER_FORMATTER.format(stackUnits)} stack units in the configured output hangar · ${NUMBER_FORMATTER.format(deliveredUnits)} ready units currently backed by delivered jobs`;
  }
  if (source.mode === 'personal') {
    return 'Using the personal ESI asset snapshot as the delivered-stock side of the manufacturing pipeline.';
  }
  return 'No delivered-stock source is currently available.';
}

function formatPipelineValue(summary) {
  if (!summary) return 'AWAITING JOBS';
  return `${NUMBER_FORMATTER.format(summary.ready_type_count || 0)} READY · ${NUMBER_FORMATTER.format(summary.in_progress_type_count || 0)} RUNNING`;
}

function formatPipelineMeta(summary) {
  if (!summary) return 'Completed manufacturing jobs stay here until they are listed in Orders.';
  const readyUnits = Number(summary.ready_units || 0);
  const inProgressUnits = Number(summary.in_progress_units || 0);
  const lookbackDays = Number(summary.lookback_days || 0);
  return `${NUMBER_FORMATTER.format(readyUnits)} ready units in the sell queue · ${NUMBER_FORMATTER.format(inProgressUnits)} more units still building · delivered jobs tracked over the last ${NUMBER_FORMATTER.format(lookbackDays)} days.`;
}

function formatCompletionEta(ts) {
  const numeric = Number(ts);
  if (!Number.isFinite(numeric) || numeric <= 0) return '—';
  const seconds = numeric - (Date.now() / 1000);
  if (seconds <= 0) return 'Ready now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 21600 ? 1 : 0)}h`;
  return `${(seconds / 86400).toFixed(seconds < 259200 ? 1 : 0)}d`;
}

function buildPipelineCallout(item) {
  const parts = [];
  if (Number(item?.delivered_asset_quantity || 0) > 0) {
    parts.push(`${NUMBER_FORMATTER.format(item.delivered_asset_quantity)} in output stock`);
  }
  if (Number(item?.ready_job_quantity || 0) > 0) {
    parts.push(`${NUMBER_FORMATTER.format(item.ready_job_quantity)} from finished jobs awaiting delivery`);
  }
  if (Number(item?.active_job_quantity || 0) > 0) {
    const eta = formatCompletionEta(item?.next_completion_ts);
    parts.push(`${NUMBER_FORMATTER.format(item.active_job_quantity)} still building${eta !== '—' ? ` · next ${eta.toLowerCase()}` : ''}`);
  }
  if (!parts.length) return 'This row is backed by manufactured output, not generic hangar inventory.';
  return `Manufacturing handoff: ${parts.join(' · ')}.`;
}

function hubComparisonLabel(item) {
  if (!item?.better_hub) return 'Selected hub remains the best visible venue.';
  return `${item.better_hub.hub} yields ${fmtISK(item.better_hub.delta_total)} more after fees at the current quantity.`;
}

function sortRows(rows, sortKey, sortAsc) {
  const sortedRows = [...rows].sort((left, right) => {
    let cmp = 0;
    if (sortKey === 'name') cmp = left.name.localeCompare(right.name);
    if (sortKey === 'net') cmp = Number(left.total_net_after_fees || 0) - Number(right.total_net_after_fees || 0);
    if (sortKey === 'relist') cmp = Number(left.total_net_after_one_relist || 0) - Number(right.total_net_after_one_relist || 0);
    if (sortKey === 'days') {
      const leftDays = left.estimated_days_to_sell == null ? Number.POSITIVE_INFINITY : Number(left.estimated_days_to_sell);
      const rightDays = right.estimated_days_to_sell == null ? Number.POSITIVE_INFINITY : Number(right.estimated_days_to_sell);
      cmp = leftDays - rightDays;
    }
    return sortAsc ? cmp : -cmp;
  });
  return sortedRows;
}

export default memo(function OutboundPricingPage({ appSettings }) {
  const [goal, setGoal] = useState('balanced');
  const [selectedHub, setSelectedHub] = useState(appSettings?.sellLoc || 'jita');
  const [search, setSearch] = useState('');
  const [minTotalValueInput, setMinTotalValueInput] = useState('1000000');
  const [limit, setLimit] = useState(40);
  const [sortKey, setSortKey] = useState('relist');
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState(null);

  useEffect(() => {
    if (appSettings?.sellLoc) setSelectedHub(appSettings.sellLoc);
  }, [appSettings?.sellLoc]);

  const minTotalValue = useMemo(() => coercePositiveNumber(minTotalValueInput, 1000000), [minTotalValueInput]);
  const hubLabel = getHubLabel(selectedHub);
  const url = useMemo(() => {
    const params = new URLSearchParams({
      goal,
      hub: hubLabel,
      limit: String(limit),
      min_total_value: String(minTotalValue),
    });

    if (appSettings?.operations_corp_id) params.set('operations_corp_id', String(appSettings.operations_corp_id));
    if (appSettings?.corp_output_division) params.set('corp_output_division', String(appSettings.corp_output_division));
    return `${API}/api/haul/sell-recommendations?${params.toString()}`;
  }, [appSettings?.corp_output_division, appSettings?.operations_corp_id, goal, hubLabel, limit, minTotalValue]);

  const { data, loading, error, stale, refetch } = useApi(url);

  const rows = data?.items || [];
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => !query || row.name.toLowerCase().includes(query));
  }, [rows, search]);
  const sortedRows = useMemo(() => sortRows(filteredRows, sortKey, sortAsc), [filteredRows, sortAsc, sortKey]);

  useEffect(() => {
    if (!sortedRows.length) {
      setSelectedTypeId(null);
      return;
    }
    if (!sortedRows.some((row) => row.type_id === selectedTypeId)) {
      setSelectedTypeId(sortedRows[0].type_id);
    }
  }, [selectedTypeId, sortedRows]);

  const selectedRow = sortedRows.find((row) => row.type_id === selectedTypeId) || null;
  const summary = data?.summary || {};
  const inventorySource = data?.inventory_source || null;
  const pipelineSummary = data?.pipeline_summary || null;
  const feeModel = data?.fee_model || null;
  const selectedRank = selectedRow ? sortedRows.findIndex((row) => row.type_id === selectedRow.type_id) + 1 : null;

  const liveStatus = error && data
    ? 'Last refresh failed, showing cached outbound queue.'
    : stale
      ? 'Refreshing manufacturing pipeline and hub pricing...'
      : 'Completed manufactured jobs stay here until they become live sell orders.';

  const handleSortKey = (nextKey) => {
    if (sortKey === nextKey) {
      setSortAsc((value) => !value);
      return;
    }
    setSortKey(nextKey);
    setSortAsc(nextKey === 'name' || nextKey === 'days');
  };

  return (
    <div className="calc-page">
      <div className="panel app-page-shell">
        <PageHeader
          title="Outbound Queue"
          subtitle="Manufactured output only. Completed jobs stay here until listed, and then hand off to Orders."
        >
          <span>{liveStatus}</span>
          <button type="button" className="header-scan-btn" onClick={refetch} disabled={loading && !data}>Refresh</button>
        </PageHeader>

        <div className="app-summary-grid">
          <SummaryCard label="Ready Types" value={NUMBER_FORMATTER.format(sortedRows.length)} tone="neutral" />
          <SummaryCard label="Ready Units" value={NUMBER_FORMATTER.format(summary.total_units || 0)} tone="neutral" />
          <SummaryCard label="Gross List Value" value={fmtISK(summary.total_recommended_value)} tone="accent" />
          <SummaryCard label="Net After Fees" value={fmtISK(summary.total_net_after_fees)} tone="good" />
        </div>

        <div className="app-context-grid">
          <ContextCard
            label="Pipeline"
            value={formatPipelineValue(pipelineSummary)}
            meta={formatPipelineMeta(pipelineSummary)}
          />
          <ContextCard
            label="Ready Source"
            value={formatReadySourceValue(inventorySource)}
            meta={formatReadySourceMeta(inventorySource, pipelineSummary)}
          />
          <ContextCard
            label="Market Lens"
            value={`${String(hubLabel).toUpperCase()} · ${String(goal).toUpperCase()}`}
            meta={`${NUMBER_FORMATTER.format(summary.pipeline_candidates_considered || 0)} ready pipeline candidates priced across ${NUMBER_FORMATTER.format((data?.hubs || []).length)} hubs`}
          />
          <ContextCard
            label="Fee Model"
            value={feeModel ? `${(Number(feeModel.broker_fee_rate || 0) * 100).toFixed(2)}% broker · ${(Number(feeModel.sales_tax_rate || 0) * 100).toFixed(2)}% tax` : 'Awaiting market fee model'}
            meta="Selected net subtracts listing fees once. The relist view subtracts the broker fee a second time to reflect one price modification or relist."
          />
        </div>

        {inventorySource?.warning ? (
          <div className="error-banner">
            <span>Ready source warning.</span> {inventorySource.warning}
          </div>
        ) : null}

        <div className="calc-filters">
          <div className="calc-filters-inputs bp-investment-filters outbound-pricing-filters">
            <div className="filter-group" style={{ borderRight: 'none' }}>
              <span className="filter-label">Search</span>
              <input
                className="calc-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter manufactured output"
                style={{ width: 240 }}
              />
            </div>

            <div className="filter-group">
              <span className="filter-label">Goal</span>
              <div className="filter-options">
                {GOAL_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`chip${goal === option.value ? ' active' : ''}`}
                    onClick={() => setGoal(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Primary Hub</span>
              <select className="calc-input" value={selectedHub} onChange={(event) => setSelectedHub(event.target.value)}>
                {MARKET_HUBS.map((hub) => (
                  <option key={hub} value={hub}>{getHubLabel(hub)}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <span className="filter-label">Min Total Value</span>
              <input
                className="calc-input"
                value={minTotalValueInput}
                onChange={(event) => setMinTotalValueInput(event.target.value)}
                inputMode="numeric"
                style={{ width: 140 }}
              />
            </div>

            <div className="filter-group">
              <span className="filter-label">Rows</span>
              <select className="calc-input" value={limit} onChange={(event) => setLimit(Number(event.target.value) || 40)}>
                {LIMIT_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <span className="filter-label">Sort</span>
              <div className="filter-options">
                <button type="button" className={`chip${sortKey === 'relist' ? ' active' : ''}`} onClick={() => handleSortKey('relist')}>Relist Net</button>
                <button type="button" className={`chip${sortKey === 'net' ? ' active' : ''}`} onClick={() => handleSortKey('net')}>Net</button>
                <button type="button" className={`chip${sortKey === 'days' ? ' active' : ''}`} onClick={() => handleSortKey('days')}>Days</button>
                <button type="button" className={`chip${sortKey === 'name' ? ' active' : ''}`} onClick={() => handleSortKey('name')}>Name</button>
              </div>
            </div>
          </div>
        </div>

        {loading && !data ? (
          <LoadingState label="SCANNING OUTBOUND QUEUE" sub="MANUFACTURING · MARKET" />
        ) : error && !data ? (
          <div className="error-banner">
            <span>Outbound queue is unavailable.</span> Check that the backend is running and the trade hub feeds can be fetched.
          </div>
        ) : !sortedRows.length ? (
          <div className="loading-state">
            <div className="loading-label">No manufactured output is ready to list</div>
            <div className="loading-sub">Completed jobs appear here until they are listed in Orders. Adjust the value floor or refresh the manufacturing sources.</div>
          </div>
        ) : (
          <TwoPaneLayout
            className="outbound-pricing-layout"
            mainClassName="calc-body"
            detailClassName="outbound-pricing-detail"
            main={(
              <table className="calc-table outbound-pricing-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', width: '38%' }}>ITEM</th>
                    <th style={{ textAlign: 'left', width: '12%' }}>HUB</th>
                    <th style={{ textAlign: 'right', width: '12%' }}>REC PRICE</th>
                    <th style={{ textAlign: 'right', width: '10%' }}>READY</th>
                    <th style={{ textAlign: 'right', width: '12%' }}>NET</th>
                    <th style={{ textAlign: 'left', width: '10%' }}>BEST ALT</th>
                    <th style={{ textAlign: 'right', width: '6%' }}>DAYS</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row, index) => (
                    <tr
                      key={row.type_id}
                      className={`eve-row-reveal${row.type_id === selectedTypeId ? ' outbound-pricing-table__row--active' : ''}`}
                      onClick={() => setSelectedTypeId(row.type_id)}
                      style={{ animationDelay: `${index * 12}ms`, cursor: 'pointer' }}
                    >
                      <td>
                        <div className="outbound-pricing-item">
                          <img
                            className="outbound-pricing-item__icon"
                            src={`https://images.evetech.net/types/${row.type_id}/icon?size=32`}
                            alt=""
                            onError={(event) => { event.target.style.display = 'none'; }}
                          />
                          <div style={{ minWidth: 0 }}>
                            <div className="outbound-pricing-item__name" title={row.name}>{row.name}</div>
                            <div className="outbound-pricing-item__meta">
                              <span className={`outbound-pipeline-badge outbound-pipeline-badge--${row.pipeline_state || 'unlisted-stock'}`}>
                                {row.pipeline_state_label || 'READY'}
                              </span>
                              {row.delivered_asset_quantity > 0 ? <span>Stock {NUMBER_FORMATTER.format(row.delivered_asset_quantity)}</span> : null}
                              {row.ready_job_quantity > 0 ? <span>Finished {NUMBER_FORMATTER.format(row.ready_job_quantity)}</span> : null}
                              {row.active_job_quantity > 0 ? <span>Building {NUMBER_FORMATTER.format(row.active_job_quantity)}</span> : null}
                              <span>Floor {fmtISK(row.price_floor)}</span>
                              <span>Top sell {fmtISK(row.selected_hub_best_sell)}</span>
                              {row.relist_guard_triggered ? <span>Relist guard active</span> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="outbound-pricing-table__hub">{String(row.selected_hub || '—').toUpperCase()}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtISK(row.recommended_price)}</td>
                      <td style={{ textAlign: 'right' }}>{NUMBER_FORMATTER.format(row.quantity)}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--green)' }}>{fmtISK(row.total_net_after_fees)}</td>
                      <td>
                        {row.better_hub ? (
                          <div className="outbound-pricing-alt-hub">
                            <div>{row.better_hub.hub.toUpperCase()}</div>
                            <div>{fmtISK(row.better_hub.delta_total)}</div>
                          </div>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{formatSellDays(row.estimated_days_to_sell)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            detail={selectedRow ? (
              <>
                <div className="outbound-pricing-detail__head">
                  <img
                    className="outbound-pricing-detail__icon"
                    src={`https://images.evetech.net/types/${selectedRow.type_id}/icon?size=64`}
                    alt=""
                    onError={(event) => { event.target.style.display = 'none'; }}
                  />
                  <div>
                    <div className="app-detail-title">{selectedRow.name}</div>
                    <div className="app-detail-subtitle">
                      {selectedRow.pipeline_state_label || 'READY'} · {NUMBER_FORMATTER.format(selectedRow.quantity)} units ready to list · rank #{selectedRank || 1} in the current outbound window
                    </div>
                  </div>
                </div>

                <div className="app-detail-copy">
                  {selectedRow.ready_job_quantity > 0
                    ? 'Finished jobs are pulled into this queue as soon as they complete so they can be priced before they become live sell orders.'
                    : 'This row is limited to manufactured stock still waiting to be listed, rather than every item sitting in the hangar.'}
                </div>

                <div className="app-detail-grid">
                  <DetailStat label="Recommended" value={fmtISK(selectedRow.recommended_price)} tone="var(--accent)" />
                  <DetailStat label="Net / Unit" value={fmtISK(selectedRow.net_after_fees_per_unit)} tone="var(--green)" />
                  <DetailStat label="Sell Time" value={formatSellDays(selectedRow.estimated_days_to_sell)} />
                  <DetailStat label="Ready Units" value={NUMBER_FORMATTER.format(selectedRow.quantity || 0)} />
                  <DetailStat label="Output Stock" value={NUMBER_FORMATTER.format(selectedRow.delivered_asset_quantity || 0)} />
                  <DetailStat label="Ready From Jobs" value={NUMBER_FORMATTER.format(selectedRow.ready_job_quantity || 0)} />
                  <DetailStat label="In Production" value={NUMBER_FORMATTER.format(selectedRow.active_job_quantity || 0)} />
                  <DetailStat label="Existing Listed Qty" value={NUMBER_FORMATTER.format(selectedRow.existing_listed_qty || 0)} />
                </div>

                <div className="outbound-pricing-callout">
                  {buildPipelineCallout(selectedRow)}
                </div>

                <div className={`outbound-pricing-callout${selectedRow.better_hub ? ' outbound-pricing-callout--warning' : ''}`}>
                  {hubComparisonLabel(selectedRow)}
                </div>

                <div className="outbound-pricing-callout">
                  Fees on the selected hub: {fmtISK(selectedRow.broker_fee_per_unit)} broker + {fmtISK(selectedRow.sales_tax_per_unit)} sales tax per unit now, plus {fmtISK(selectedRow.relist_broker_fee_per_unit)} more broker fee per unit if the order is modified once.
                </div>

                <div className="outbound-pricing-hubs">
                  <div className="outbound-pricing-hubs__title">Hub Comparison</div>
                  {(selectedRow.hub_recommendations || []).map((hubRecommendation) => (
                    <div
                      key={hubRecommendation.hub}
                      className={`outbound-pricing-hub-card${hubRecommendation.hub === selectedRow.selected_hub ? ' outbound-pricing-hub-card--selected' : ''}`}
                    >
                      <div className="outbound-pricing-hub-card__head">
                        <div>
                          <div className="outbound-pricing-hub-card__title">{String(hubRecommendation.hub).toUpperCase()}</div>
                          <div className="outbound-pricing-hub-card__subtitle">
                            {hubRecommendation.relist_guard_triggered ? 'Relist guard tightened this recommendation' : 'Standard hub recommendation'}
                          </div>
                        </div>
                        {hubRecommendation.hub === selectedRow.selected_hub ? (
                          <span className="outbound-pricing-hub-card__badge">SELECTED</span>
                        ) : null}
                      </div>

                      <div className="outbound-pricing-hub-card__grid">
                        <div>
                          <div className="outbound-pricing-hub-card__label">Recommended</div>
                          <div className="outbound-pricing-hub-card__value">{fmtISK(hubRecommendation.recommended_price)}</div>
                        </div>
                        <div>
                          <div className="outbound-pricing-hub-card__label">Best Sell</div>
                          <div className="outbound-pricing-hub-card__value">{fmtISK(hubRecommendation.best_sell)}</div>
                        </div>
                        <div>
                          <div className="outbound-pricing-hub-card__label">Net After Fees</div>
                          <div className="outbound-pricing-hub-card__value">{fmtISK(hubRecommendation.total_net_after_fees)}</div>
                        </div>
                        <div>
                          <div className="outbound-pricing-hub-card__label">Net After 1 Relist</div>
                          <div className="outbound-pricing-hub-card__value">{fmtISK(hubRecommendation.total_net_after_one_relist)}</div>
                        </div>
                        <div>
                          <div className="outbound-pricing-hub-card__label">Visible Orders</div>
                          <div className="outbound-pricing-hub-card__value">{NUMBER_FORMATTER.format(hubRecommendation.order_count || 0)}</div>
                        </div>
                        <div>
                          <div className="outbound-pricing-hub-card__label">Estimated Days</div>
                          <div className="outbound-pricing-hub-card__value">{formatSellDays(hubRecommendation.estimated_days_to_sell)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bp-investment-links" style={{ marginTop: 10 }}>
                  <a href={`https://market.fuzzwork.co.uk/type/${selectedRow.type_id}/`} target="_blank" rel="noreferrer">MARKET</a>
                </div>
              </>
            ) : (
              <div className="app-detail-empty">Select a manufactured output to inspect its handoff state, hub comparison, and fee drag.</div>
            )}
          />
        )}
      </div>
    </div>
  );
});