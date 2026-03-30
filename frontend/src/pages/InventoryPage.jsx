import { useEffect, useMemo, useState, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { LoadingState } from '../components/ui';
import { API } from '../App';
import { ContextCard, DetailStat, PageHeader, SummaryCard, TwoPaneLayout } from '../components/shared/PagePrimitives';

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

export default memo(function InventoryPage() {
  const { data, loading, error, stale, refetch } = useApi(`${API}/api/assets`);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('qty');
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState(null);

  const bpcTypeIds = data?.bpc_type_ids || [];
  const bpcTypeSet = useMemo(() => new Set(bpcTypeIds.map((typeId) => Number(typeId))), [bpcTypeIds]);

  const rows = useMemo(() => {
    const assets = data?.assets || {};
    const names = data?.names || {};
    return Object.entries(assets).map(([typeId, qty]) => ({
      type_id: Number(typeId),
      name: names[typeId] || `Type ${typeId}`,
      qty: Number(qty || 0),
      is_bpc: bpcTypeSet.has(Number(typeId)),
    }));
  }, [bpcTypeSet, data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => !q || row.name.toLowerCase().includes(q));
  }, [rows, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'qty') cmp = a.qty - b.qty;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      return sortAsc ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortAsc]);

  useEffect(() => {
    if (!sorted.length) {
      setSelectedTypeId(null);
      return;
    }
    if (!sorted.some((row) => row.type_id === selectedTypeId)) {
      setSelectedTypeId(sorted[0].type_id);
    }
  }, [selectedTypeId, sorted]);

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc((ascending) => !ascending);
    else { setSortKey(key); setSortAsc(key === 'name'); }
  };

  const sortIndicator = (key) => sortKey === key ? (sortAsc ? ' \u25B2' : ' \u25BC') : '';
  const selectedRow = sorted.find((row) => row.type_id === selectedTypeId) || null;
  const totalQuantity = rows.reduce((sum, row) => sum + row.qty, 0);
  const visibleQuantity = sorted.reduce((sum, row) => sum + row.qty, 0);
  const blueprintTypes = rows.filter((row) => row.is_bpc).length;
  const blueprintQuantity = rows.reduce((sum, row) => sum + (row.is_bpc ? row.qty : 0), 0);

  const cachedAt = data?.cached_at
    ? new Date(data.cached_at * 1000).toLocaleString()
    : null;

  const selectedRank = selectedRow ? sorted.findIndex((row) => row.type_id === selectedRow.type_id) + 1 : null;

  return (
    <div className="calc-page">
      <div className="panel app-page-shell">
        <PageHeader
          title="Inventory"
          subtitle="Aggregated ESI assets with a scan-first list on the left and per-item inspection on the right."
        >
          <span>{stale ? 'Refreshing cached inventory…' : 'ESI asset aggregation'}</span>
          <button type="button" className="header-scan-btn" onClick={refetch} disabled={loading && !data}>Refresh</button>
        </PageHeader>

        <div className="app-summary-grid">
          <SummaryCard label="Visible Types" value={sorted.length.toLocaleString()} tone="neutral" />
          <SummaryCard label="Visible Quantity" value={NUMBER_FORMATTER.format(visibleQuantity)} tone="good" />
          <SummaryCard label="Blueprint Types" value={blueprintTypes.toLocaleString()} tone="accent" />
          <SummaryCard label="Total Quantity" value={NUMBER_FORMATTER.format(totalQuantity)} tone="neutral" />
        </div>

        <div className="app-context-grid">
          <ContextCard
            label="Cache State"
            value={cachedAt ? `CACHED ${cachedAt}` : 'Awaiting sync'}
            meta={loading ? 'Pulling the latest inventory snapshot from ESI.' : stale ? 'Revalidating inventory while the cached snapshot remains visible.' : `${rows.length} unique asset types indexed`}
          />
          <ContextCard
            label="Search Window"
            value={search.trim() || 'All items'}
            meta={`${sorted.length} of ${rows.length} types visible after filtering`}
          />
          <ContextCard
            label="Blueprint Copy Coverage"
            value={`${blueprintTypes.toLocaleString()} TYPES`}
            meta={`${NUMBER_FORMATTER.format(blueprintQuantity)} total blueprint copy units detected`}
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
                placeholder="Filter by item name"
                style={{ width: 240 }}
              />
            </div>

            <div className="filter-group">
              <span className="filter-label">Sort</span>
              <div className="filter-options">
                <button className={`chip${sortKey === 'qty' ? ' active' : ''}`} onClick={() => { setSortKey('qty'); if (sortKey !== 'qty') setSortAsc(false); }}>
                  Quantity
                </button>
                <button className={`chip${sortKey === 'name' ? ' active' : ''}`} onClick={() => { setSortKey('name'); if (sortKey !== 'name') setSortAsc(true); }}>
                  Name
                </button>
              </div>
            </div>

            <div className="filter-group">
              <span className="filter-label">Direction</span>
              <div className="filter-options">
                <button className={`chip${sortAsc ? ' active' : ''}`} onClick={() => setSortAsc(true)}>
                  Asc
                </button>
                <button className={`chip${!sortAsc ? ' active' : ''}`} onClick={() => setSortAsc(false)}>
                  Desc
                </button>
              </div>
            </div>
          </div>
        </div>

        {loading && !data ? (
          <LoadingState label="FETCHING INVENTORY" sub="ESI · ASSETS" />
        ) : error && !data ? (
          <div className="error-banner">
            <span>Inventory feed unavailable.</span> Check that the backend is running and ESI asset aggregation can be refreshed.
          </div>
        ) : !sorted.length ? (
          <div className="loading-state">
            <div className="loading-label">{rows.length === 0 ? 'No assets returned' : 'No matching inventory rows'}</div>
            <div className="loading-sub">{rows.length === 0 ? 'The current ESI inventory snapshot is empty.' : 'Adjust the search term or refresh the snapshot.'}</div>
          </div>
        ) : (
          <TwoPaneLayout
            className="inventory-layout"
            mainClassName="calc-body"
            detailClassName="inventory-detail"
            main={(
              <table className="calc-table inventory-table">
                <thead>
                  <tr>
                    <th
                      onClick={() => handleSort('name')}
                      style={{ textAlign: 'left', cursor: 'pointer', userSelect: 'none', width: '70%' }}
                    >
                      ITEM{sortIndicator('name')}
                    </th>
                    <th
                      onClick={() => handleSort('qty')}
                      style={{ textAlign: 'right', cursor: 'pointer', userSelect: 'none', width: '30%' }}
                    >
                      QUANTITY{sortIndicator('qty')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row, index) => (
                    <tr
                      key={row.type_id}
                      className={`eve-row-reveal${row.type_id === selectedTypeId ? ' inventory-table__row--active' : ''}`}
                      onClick={() => setSelectedTypeId(row.type_id)}
                      style={{ animationDelay: `${index * 10}ms`, cursor: 'pointer' }}
                    >
                      <td>
                        <div className="bp-investment-item">
                          <img
                            className="bp-investment-item__icon"
                            src={`https://images.evetech.net/types/${row.type_id}/icon?size=32`}
                            alt=""
                            onError={(event) => { event.target.style.display = 'none'; }}
                          />
                          <div>
                            <div className="bp-investment-item__name">{row.name}</div>
                            <div className="bp-investment-item__meta">
                              <span>Type {row.type_id}</span>
                              {row.is_bpc && <span className="bp-investment-badge bp-investment-badge--corp">BPC</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>{NUMBER_FORMATTER.format(row.qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            detail={selectedRow ? (
              <>
                <div className="inventory-detail__head">
                  <img
                    className="inventory-detail__icon"
                    src={`https://images.evetech.net/types/${selectedRow.type_id}/icon?size=64`}
                    alt=""
                    onError={(event) => { event.target.style.display = 'none'; }}
                  />
                  <div>
                    <div className="app-detail-title">{selectedRow.name}</div>
                    <div className="app-detail-subtitle">{selectedRow.is_bpc ? 'Blueprint copy inventory entry' : 'Aggregated asset inventory entry'}</div>
                  </div>
                </div>

                <div className="app-detail-copy">
                  Inventory is aggregated by type in the current snapshot, so quantities reflect stacked totals rather than per-location line items.
                </div>

                <div className="app-detail-grid">
                  <DetailStat label="Quantity" value={NUMBER_FORMATTER.format(selectedRow.qty)} tone="var(--green)" />
                  <DetailStat label="Type ID" value={selectedRow.type_id.toLocaleString()} />
                  <DetailStat label="Class" value={selectedRow.is_bpc ? 'BPC' : 'Asset'} tone={selectedRow.is_bpc ? 'var(--accent)' : undefined} />
                  <DetailStat label="Visible Rank" value={selectedRank ? `#${selectedRank}` : '—'} />
                </div>

                <div className="bp-investment-links" style={{ marginTop: 10 }}>
                  <a href={`https://market.fuzzwork.co.uk/type/${selectedRow.type_id}/`} target="_blank" rel="noreferrer">MARKET</a>
                </div>
              </>
            ) : (
              <div className="app-detail-empty">Select an inventory row to inspect the aggregated quantity and asset classification.</div>
            )}
          />
        )}
      </div>
    </div>
  );
});
