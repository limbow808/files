import { useEffect, useMemo, useState, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import CharTag from '../components/CharTag';
import { ContextCard, DetailStat, PageHeader, SummaryCard, TwoPaneLayout } from '../components/shared/PagePrimitives';
import { charColor } from '../utils/charColors';
import { LoadingState } from '../components/ui';
import { API } from '../App';

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

function useOrdersRefreshUrl(baseUrl) {
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const refresh = () => setRefreshTick((tick) => tick + 1);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const handleFocus = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, 30000);

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}force=1&tick=${refreshTick}`;
}

function orderFillPct(order) {
  const total = Number(order?.volume_total || 0);
  const remaining = Number(order?.volume_remain || 0);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
}

function orderBookValue(order, isBuy) {
  if (!order) return 0;
  if (isBuy) return Number(order.escrow || 0);
  return Number(order.price || 0) * Number(order.volume_remain || 0);
}

function orderPositionLabel(order) {
  const position = order?.market_position;
  if (position == null) return 'Position untracked';
  if (position === 1) return 'Top of book';
  return `Position ${position}`;
}

function formatSellDays(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const days = Number(value);
  if (days < 1) return `${(days * 24).toFixed(days < 0.5 ? 1 : 0)}h`;
  return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
}

function formatTrackedHours(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const hours = Number(value);
  if (hours < 24) return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
  return `${(hours / 24).toFixed(hours >= 240 ? 0 : 1)}d`;
}

function orderAdviceBadge(advice) {
  if (!advice) return null;
  if (advice.warning_level === 'critical') {
    return { tone: 'critical', label: 'MARGIN RISK' };
  }
  if (advice.warning_level === 'warning') {
    return { tone: 'warning', label: advice.action === 'relist' ? 'RELIST' : 'CHECK' };
  }
  return null;
}

function orderAdviceTone(advice) {
  if (!advice) return null;
  if (advice.warning_level === 'critical') return '#ff6644';
  if (advice.warning_level === 'warning') return '#ffb347';
  if (advice.summary === 'Slow seller') return 'var(--dim)';
  return 'var(--green)';
}

function FullOrderTable({ orders, tab, multiChar, sellHistByTypeId, scanMap, selectedOrderId, onSelect }) {
  const isBuy = tab === 'buy';

  if (!orders.length) {
    return (
      <div className="loading-state">
        <div className="loading-label">No {isBuy ? 'buy' : 'sell'} orders</div>
        <div className="loading-sub">The current book has no visible rows in this lane.</div>
      </div>
    );
  }

  return (
    <table className="calc-table orders-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <thead>
        <tr style={{ background: 'var(--table-row-bg)' }}>
          <th style={{ textAlign: 'left',  padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '30%' }}>ITEM</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '12%' }}>PRICE</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '14%' }}>QTY</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '13%' }}>REVENUE</th>
          <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '11%', title: 'Manufacturing ROI from last calculator run' }}>MFG ROI</th>
          {!isBuy && <th style={{ textAlign: 'right', padding: '4px 12px 4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '10%' }}>POS</th>}
          {isBuy  && <th style={{ textAlign: 'right', padding: '4px 12px 4px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, width: '10%' }}>ESCROW</th>}
        </tr>
      </thead>
      <tbody>
        {orders.map((o, idx) => {
          const filledPct = orderFillPct(o);
          const filledLabel = `${filledPct.toFixed(0)}%`;
          const bookValue = orderBookValue(o, isBuy);
          const fillColor = filledPct >= 75 ? '#00cc66' : filledPct >= 25 ? 'var(--text)' : 'var(--dim)';
          const cColor    = o.character_id ? charColor(o.character_id) : 'var(--dim)';
          const hist      = !isBuy && sellHistByTypeId ? sellHistByTypeId[o.type_id] : null;
          const avgDays   = hist?.avg_days_to_sell ?? null;
          const scanItem  = scanMap?.[o.type_id];
          const roi       = scanItem?.roi ?? null;
          const roiColor  = roi == null ? 'var(--dim)' : roi >= 15 ? '#4cff91' : roi >= 5 ? 'var(--accent)' : '#ff6644';
          const advice    = !isBuy ? o.order_advice : null;
          const adviceBadge = orderAdviceBadge(advice);

          return (
            <tr
              key={o.order_id}
              className={`eve-row-reveal${o.order_id === selectedOrderId ? ' orders-table__row--active' : ''}`}
              onClick={() => onSelect(o.order_id)}
              style={{ position: 'relative', borderBottom: '1px solid #0d0d0d', background: 'var(--table-row-bg)', animationDelay: `${idx * 25}ms`, cursor: 'pointer' }}
            >
              <td style={{ padding: '4px 6px', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, maxWidth: '100%', minWidth: 0 }}>
                  <img
                    className="bp-investment-item__icon"
                    src={`https://images.evetech.net/types/${o.type_id}/icon?size=32`}
                    alt=""
                    onError={(event) => { event.target.style.display = 'none'; }}
                  />
                  <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={o.type_name}>{o.type_name}</div>
                    <div className="bp-investment-item__meta">
                      <span>{filledLabel} filled</span>
                      {!isBuy && adviceBadge && (
                        <span className={`orders-advice-pill orders-advice-pill--${adviceBadge.tone}`}>
                          ! {adviceBadge.label}
                        </span>
                      )}
                      {!isBuy && advice?.summary === 'Slow seller' && (
                        <span className="orders-advice-note">Slow seller · hold</span>
                      )}
                      {!isBuy && advice?.estimated_days_relisted != null && (
                        <span style={{ color: orderAdviceTone(advice) || 'var(--dim)' }}>
                          ETA {formatSellDays(advice.estimated_days_relisted)}
                        </span>
                      )}
                      {!isBuy && avgDays != null && (
                        <span style={{ color: avgDays <= 3 ? '#4cff91' : avgDays >= 14 ? '#ff6644' : 'var(--dim)' }}>
                          {avgDays.toFixed(1)}d sell
                        </span>
                      )}
                      {!isBuy && o.competitor_count > 0 && (
                        <span>{o.competitor_count} listed{o.market_hub ? ` in ${o.market_hub}` : ''}</span>
                      )}
                    </div>
                  </div>
                  {multiChar && o.character_name && (
                    <CharTag name={o.character_name} color={cColor} bordered={false} style={{ flexShrink: 0, marginTop: 1 }} />
                  )}
                </div>
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: 'var(--bg)', pointerEvents: 'none', zIndex: 0 }}>
                  <div style={{ height: '100%', width: `${filledPct}%`, background: isBuy ? '#4da6ff' : 'var(--accent)' }} />
                </div>
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11 }}>
                {fmtISK(o.price)}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontSize: 11, color: fillColor }}>
                {NUMBER_FORMATTER.format(o.volume_remain)}
                <span style={{ color: 'var(--dim)', fontSize: 10 }}> / {NUMBER_FORMATTER.format(o.volume_total)}</span>
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: isBuy ? '#4da6ff' : 'var(--accent)' }}>
                {fmtISK(bookValue)}
              </td>
              <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: roiColor }}>
                {roi != null ? `${roi.toFixed(1)}%` : '\u2014'}
              </td>
              {!isBuy && (() => {
                const pos = o.market_position;
                const trend = o.market_position_trend;
                const color = pos === 1   ? '#4cff91'
                            : pos === null ? 'var(--dim)'
                            : pos <= 3    ? '#ffcc00'
                            : '#ff6644';
                const label = pos === null ? '\u2014' : String(pos);
                const trendGlyph = trend === 'up' ? '\u25B2' : trend === 'down' ? '\u25BC' : '';
                const trendColor = trend === 'up' ? '#4cff91' : trend === 'down' ? '#ff6644' : 'var(--dim)';
                return (
                  <td style={{ padding: '4px 12px 4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color, whiteSpace: 'nowrap' }}>
                    {trendGlyph && <span style={{ marginRight: 4, color: trendColor, fontSize: 10 }}>{trendGlyph}</span>}
                    {label}
                  </td>
                );
              })()}
              {isBuy && (
                <td style={{ padding: '4px 12px 4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)' }}>
                  {fmtISK(o.escrow)}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default memo(function OrdersPage() {
  const [manualRefreshKey, setManualRefreshKey] = useState(0);
  const ordersUrl = useOrdersRefreshUrl(`${API}/api/orders?manual=${manualRefreshKey}`);
  const { data, loading, error, stale } = useApi(ordersUrl);
  const { data: sellHistData, loading: sellHistLoading } = useApi(`${API}/api/sell_history`);
  const { data: scanData, loading: scanLoading } = useApi(`${API}/api/scan`);
  const [tab, setTab] = useState('sell');
  const [selectedOrderId, setSelectedOrderId] = useState(null);

  const sell = data?.sell || [];
  const buy  = data?.buy  || [];
  const visibleOrders = tab === 'sell' ? sell : buy;

  const sellHistByTypeId = useMemo(() => {
    const lookup = {};
    for (const stat of Object.values(sellHistData?.by_item || {})) {
      if (stat.type_id != null) lookup[stat.type_id] = stat;
    }
    return lookup;
  }, [sellHistData]);

  const scanMap = useMemo(() => {
    const lookup = {};
    (scanData?.results || []).forEach((row) => {
      if (row.output_id != null) lookup[row.output_id] = row;
    });
    return lookup;
  }, [scanData]);

  useEffect(() => {
    if (!visibleOrders.length) {
      setSelectedOrderId(null);
      return;
    }
    if (!visibleOrders.some((order) => order.order_id === selectedOrderId)) {
      setSelectedOrderId(visibleOrders[0].order_id);
    }
  }, [selectedOrderId, visibleOrders]);

  const allOrders = useMemo(() => [...sell, ...buy], [buy, sell]);
  const uniqueCharacterCount = useMemo(
    () => new Set(allOrders.map((order) => order.character_id).filter(Boolean)).size,
    [allOrders],
  );
  const multiChar = uniqueCharacterCount > 1;

  const sellTotal = useMemo(
    () => sell.reduce((sum, order) => sum + (Number(order.price || 0) * Number(order.volume_remain || 0)), 0),
    [sell],
  );
  const buyEscrow = useMemo(
    () => buy.reduce((sum, order) => sum + Number(order.escrow || 0), 0),
    [buy],
  );

  const trackedHubCount = useMemo(
    () => new Set(allOrders.map((order) => order.market_hub).filter(Boolean)).size,
    [allOrders],
  );
  const scanCoverage = useMemo(
    () => visibleOrders.reduce((count, order) => count + (scanMap[order.type_id] ? 1 : 0), 0),
    [scanMap, visibleOrders],
  );
  const positionedSellOrders = useMemo(
    () => sell.reduce((count, order) => count + (order.market_position == null ? 0 : 1), 0),
    [sell],
  );
  const relistSuggestedCount = useMemo(
    () => sell.reduce((count, order) => count + (order.order_advice?.action === 'relist' ? 1 : 0), 0),
    [sell],
  );
  const marginRiskCount = useMemo(
    () => sell.reduce((count, order) => count + (order.order_advice?.warning_level === 'critical' ? 1 : 0), 0),
    [sell],
  );
  const stagnantCount = useMemo(
    () => sell.reduce((count, order) => count + (order.order_advice?.stagnant_24h ? 1 : 0), 0),
    [sell],
  );
  const slowSellerCount = useMemo(
    () => sell.reduce((count, order) => count + (order.order_advice?.summary === 'Slow seller' ? 1 : 0), 0),
    [sell],
  );

  const selectedOrder = visibleOrders.find((order) => order.order_id === selectedOrderId) || null;
  const selectedIsBuy = tab === 'buy';
  const selectedFillPct = selectedOrder ? orderFillPct(selectedOrder) : 0;
  const selectedValue = orderBookValue(selectedOrder, selectedIsBuy);
  const selectedHistory = !selectedIsBuy && selectedOrder ? sellHistByTypeId[selectedOrder.type_id] : null;
  const selectedScan = selectedOrder ? scanMap[selectedOrder.type_id] : null;
  const selectedAdvice = !selectedIsBuy ? selectedOrder?.order_advice : null;
  const selectedCharColor = selectedOrder?.character_id ? charColor(selectedOrder.character_id) : 'var(--dim)';
  const liveStatus = error && data
    ? 'Last refresh failed, showing cached orders'
    : stale
      ? 'Refreshing open orders…'
      : '30s market polling + focus refresh';

  const historyEntryCount = Object.keys(sellHistByTypeId).length;

  return (
    <div className="calc-page">
      <div className="panel app-page-shell">
        <PageHeader
          title="Orders"
          subtitle="Live sell and buy books with market-position overlays, sell-history annotations, and calculator ROI carried into a dedicated operations surface."
        >
          <span>{liveStatus}</span>
          <button
            type="button"
            className="header-scan-btn"
            onClick={() => setManualRefreshKey((value) => value + 1)}
            disabled={loading && !data}
          >
            Refresh
          </button>
        </PageHeader>

        <div className="app-summary-grid">
          <SummaryCard label="Sell Orders" value={data ? sell.length.toLocaleString() : '—'} tone="accent" />
          <SummaryCard label="Buy Orders" value={data ? buy.length.toLocaleString() : '—'} tone="neutral" />
          <SummaryCard label="Sell Exposure" value={data ? fmtISK(sellTotal) : '—'} tone="accent" />
          <SummaryCard label="Buy Escrow" value={data ? fmtISK(buyEscrow) : '—'} tone="neutral" />
        </div>

        <div className="app-context-grid">
          <ContextCard
            label="Active View"
            value={data ? `${tab.toUpperCase()} · ${visibleOrders.length.toLocaleString()} rows` : 'Awaiting snapshot'}
            meta={data ? `${uniqueCharacterCount || 0} tracked characters across the current order set` : 'Pulling the current order book from ESI.'}
          />
          <ContextCard
            label="Market Overlay"
            value={scanData ? `${scanCoverage}/${visibleOrders.length || 0} ROI tagged` : 'Loading ROI overlay'}
            meta={sellHistLoading ? 'Loading sell-history annotations…' : `${historyEntryCount.toLocaleString()} history entries cached${tab === 'sell' ? ` · ${positionedSellOrders}/${sell.length} sell orders ranked` : ''}`}
          />
          <ContextCard
            label="Hub Coverage"
            value={data ? `${trackedHubCount.toLocaleString()} hubs` : 'Awaiting snapshot'}
            meta={tab === 'sell' ? 'Sell orders surface live position and competitor counts when hub telemetry is available.' : 'Buy orders keep the same live refresh cadence while tracking escrow exposure.'}
          />
          <ContextCard
            label="Order Advisory"
            value={data ? `${relistSuggestedCount} relist · ${marginRiskCount} risk` : 'Awaiting advisory'}
            meta={data ? `${stagnantCount} sell orders tracked with no fill for 24h · ${slowSellerCount} slow movers currently marked no-change` : 'Loading live stagnation and margin-risk warnings.'}
          />
        </div>

        <div className="calc-filters">
          <div className="calc-filters-inputs bp-investment-filters">
            <div className="filter-group" style={{ borderRight: 'none' }}>
              <span className="filter-label">Order Book</span>
              <div className="filter-options">
                <button className={`chip${tab === 'sell' ? ' active' : ''}`} onClick={() => setTab('sell')}>
                  Sell ({sell.length})
                </button>
                <button className={`chip${tab === 'buy' ? ' active' : ''}`} onClick={() => setTab('buy')}>
                  Buy ({buy.length})
                </button>
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Current Total</span>
              <div className="filter-options">
                <span className="orders-filter-metric">
                  {tab === 'sell' ? `Exposure ${fmtISK(sellTotal)}` : `Escrow ${fmtISK(buyEscrow)}`}
                </span>
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Characters</span>
              <div className="filter-options">
                <span className="orders-filter-metric">
                  {data ? `${uniqueCharacterCount || 0} tracked` : 'Loading…'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {loading && !data ? (
          <LoadingState label="FETCHING ORDERS" sub="ESI · MARKET" />
        ) : (
          <>
            {error && !data && (
              <div className="error-banner">
                <span>Orders feed unavailable.</span> Check that the backend is running and ESI market orders can be fetched.
              </div>
            )}

            {!error && (
              <TwoPaneLayout
                main={(
                  <div className="calc-body orders-table-wrap">
                    <FullOrderTable
                      orders={visibleOrders}
                      tab={tab}
                      multiChar={multiChar}
                      sellHistByTypeId={sellHistByTypeId}
                      scanMap={scanMap}
                      selectedOrderId={selectedOrderId}
                      onSelect={setSelectedOrderId}
                    />
                  </div>
                )}
                detailClassName="orders-detail"
                detail={selectedOrder ? (
                  <>
                    <div className="app-detail-head orders-detail__head">
                      <img
                        className="orders-detail__icon"
                        src={`https://images.evetech.net/types/${selectedOrder.type_id}/icon?size=64`}
                        alt=""
                        onError={(event) => { event.target.style.display = 'none'; }}
                      />
                      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                        <div className="app-detail-title">{selectedOrder.type_name}</div>
                        <div className="app-detail-subtitle">
                          {selectedIsBuy ? 'Buy order' : 'Sell order'}{selectedOrder.market_hub ? ` · ${selectedOrder.market_hub}` : ''}
                        </div>
                        {selectedOrder.character_name && (
                          <div style={{ marginTop: 10 }}>
                            <CharTag name={selectedOrder.character_name} color={selectedCharColor} bordered={false} />
                          </div>
                        )}
                      </div>
                      <div className="prognosis-badge">{selectedIsBuy ? 'Buy' : 'Sell'}</div>
                    </div>

                    <div className="app-detail-copy">
                      {selectedIsBuy
                        ? `Open buy order for ${NUMBER_FORMATTER.format(selectedOrder.volume_remain)} of ${NUMBER_FORMATTER.format(selectedOrder.volume_total)} units at ${fmtISK(selectedOrder.price)} each, with escrow and fill progress refreshed from the live order feed.`
                        : `Open sell order for ${NUMBER_FORMATTER.format(selectedOrder.volume_remain)} of ${NUMBER_FORMATTER.format(selectedOrder.volume_total)} units at ${fmtISK(selectedOrder.price)} each, with market position, stagnation tracking, and relist guidance carried in from the live order advisory.`}
                    </div>

                    {!selectedIsBuy && selectedAdvice && (
                      <div className={`orders-advice-callout orders-advice-callout--${selectedAdvice.warning_level === 'critical' ? 'critical' : selectedAdvice.warning_level === 'warning' ? 'warning' : 'neutral'}`}>
                        <div className="orders-advice-callout__title">
                          {selectedAdvice.summary}
                          {selectedAdvice.action === 'relist' ? ` · relist around ${fmtISK(selectedAdvice.recommended_price)}` : ''}
                        </div>
                        <div className="orders-advice-callout__body">{selectedAdvice.reason}</div>
                      </div>
                    )}

                    <div className="app-detail-grid">
                      <DetailStat label="Remaining" value={`${NUMBER_FORMATTER.format(selectedOrder.volume_remain)} / ${NUMBER_FORMATTER.format(selectedOrder.volume_total)}`} />
                      <DetailStat label="Filled" value={`${selectedFillPct.toFixed(0)}%`} tone={selectedFillPct >= 75 ? 'var(--green)' : selectedFillPct >= 25 ? 'var(--text)' : 'var(--dim)'} />
                      <DetailStat label="Price" value={fmtISK(selectedOrder.price)} />
                      <DetailStat label={selectedIsBuy ? 'Escrow' : 'Exposure'} value={fmtISK(selectedValue)} tone={selectedIsBuy ? 'var(--blue)' : 'var(--accent)'} />
                      <DetailStat label="MFG ROI" value={selectedScan?.roi != null ? `${selectedScan.roi.toFixed(1)}%` : '—'} tone={selectedScan?.roi == null ? undefined : selectedScan.roi >= 15 ? 'var(--green)' : selectedScan.roi >= 5 ? 'var(--accent)' : '#ff6644'} />
                      <DetailStat label="Hub" value={selectedOrder.market_hub || '—'} />
                      {!selectedIsBuy && <DetailStat label="Suggested" value={selectedAdvice ? fmtISK(selectedAdvice.recommended_price) : '—'} tone={selectedAdvice?.action === 'relist' ? 'var(--accent)' : undefined} />}
                      {!selectedIsBuy && <DetailStat label="ETA" value={selectedAdvice ? formatSellDays(selectedAdvice.estimated_days_relisted ?? selectedAdvice.estimated_days_current) : '—'} tone={orderAdviceTone(selectedAdvice)} />}
                      {!selectedIsBuy && <DetailStat label="No Fill Track" value={selectedAdvice ? formatTrackedHours(selectedAdvice.tracked_no_fill_hours) : '—'} tone={selectedAdvice?.stagnant_24h ? '#ffb347' : undefined} />}
                      {!selectedIsBuy && <DetailStat label="Relist B/E" value={selectedAdvice?.profit_proxy?.relist_break_even_price != null ? fmtISK(selectedAdvice.profit_proxy.relist_break_even_price) : '—'} tone={selectedAdvice?.warning_level === 'critical' ? '#ff6644' : undefined} />}
                    </div>

                    <div style={{ marginTop: 14 }}>
                      <ContextCard
                        label={selectedIsBuy ? 'Buy Book State' : 'Sell Book State'}
                        value={selectedIsBuy ? `${fmtISK(selectedOrder.escrow)} committed` : orderPositionLabel(selectedOrder)}
                        meta={selectedIsBuy
                          ? `${selectedFillPct.toFixed(0)}% of the original volume has already been filled.`
                          : `${selectedOrder.competitor_count || 0} competing listings${selectedOrder.market_hub ? ` in ${selectedOrder.market_hub}` : ''}${selectedHistory?.avg_days_to_sell != null ? ` · ${selectedHistory.avg_days_to_sell.toFixed(1)}d average sell time.` : '.'}${selectedAdvice?.action === 'relist' ? ` Relist target ${fmtISK(selectedAdvice.recommended_price)}.` : selectedAdvice?.summary === 'Slow seller' ? ' Slow seller; no relist needed right now.' : ''}`}
                      />
                    </div>

                    {!selectedIsBuy && selectedAdvice?.profit_proxy?.break_even_price != null && (
                      <div style={{ marginTop: 10 }}>
                        <ContextCard
                          label="Margin Proxy"
                          value={`${fmtISK(selectedAdvice.profit_proxy.break_even_price)} break-even`}
                          meta={selectedAdvice.warning_level === 'critical'
                            ? `Relisting safely would need about ${fmtISK(selectedAdvice.profit_proxy.relist_break_even_price)} based on the current manufacturing cost proxy.`
                            : `The advisory uses the cached manufacturing break-even proxy to avoid suggesting relists that would cut below fees.`}
                        />
                      </div>
                    )}

                    <div className="bp-investment-links" style={{ marginTop: 10 }}>
                      <a href={`https://market.fuzzwork.co.uk/type/${selectedOrder.type_id}/`} target="_blank" rel="noreferrer">MARKET</a>
                    </div>
                  </>
                ) : (
                  <div className="app-detail-empty">Select an order to inspect its live book state and execution context.</div>
                )}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
});
