import { useState, useMemo, memo } from 'react';
import { useApi } from '../hooks/useApi';
import { LoadingState } from '../components/ui';
import { API } from '../App';

export default memo(function InventoryPage() {
  const { data, loading, error, refetch } = useApi(`${API}/api/assets`);
  const [search,  setSearch]  = useState('');
  const [sortKey, setSortKey] = useState('qty');
  const [sortAsc, setSortAsc] = useState(false);

  const rows = useMemo(() => {
    const assets = data?.assets || {};
    const names  = data?.names  || {};
    return Object.entries(assets).map(([typeId, qty]) => ({
      type_id: Number(typeId),
      name:    names[typeId] || `Type ${typeId}`,
      qty,
    }));
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => !q || r.name.toLowerCase().includes(q));
  }, [rows, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'qty')  cmp = a.qty  - b.qty;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      return sortAsc ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortAsc]);

  const handleSort = (key) => {
    if (sortKey === key) setSortAsc(a => !a);
    else { setSortKey(key); setSortAsc(key === 'name'); }
  };

  const sortIndicator = (key) => sortKey === key ? (sortAsc ? ' \u25B2' : ' \u25BC') : '';

  const cachedAt = data?.cached_at
    ? new Date(data.cached_at * 1000).toLocaleTimeString()
    : null;

  return (
    <div className="calc-page">
      {/* Toolbar */}
      <div className="panel-hdr" style={{ padding: '6px 14px', flexShrink: 0, gap: 12 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          INVENTORY
        </span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="filter by name..."
          style={{
            flex: 1, maxWidth: 320,
            background: 'var(--bg)', border: '1px solid var(--border)',
            color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11,
            padding: '3px 8px', letterSpacing: 0.5, outline: 'none',
          }}
        />
        <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          {filtered.length} ITEMS{cachedAt ? ` \u00B7 CACHED ${cachedAt}` : ''}
        </span>
        <button
          onClick={refetch}
          disabled={loading}
          style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--dim)', fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, padding: '2px 8px', cursor: loading ? 'default' : 'pointer' }}
        >{loading ? '\u27F3 ...' : '\u27F3 REFRESH'}</button>
      </div>

      {/* Table */}
      <div className="calc-body">
        {loading && !data ? (
          <LoadingState label="FETCHING INVENTORY" sub="ESI \u00B7 ASSETS" />
        ) : error ? (
          <div style={{ padding: '12px 16px', color: '#ff4444', fontSize: 11, letterSpacing: 1 }}>
            {'\u26A0'} ESI UNAVAILABLE
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'var(--table-row-bg)' }}>
                <th
                  onClick={() => handleSort('name')}
                  style={{ textAlign: 'left', padding: '6px 10px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, cursor: 'pointer', userSelect: 'none', width: '70%' }}
                >
                  ITEM{sortIndicator('name')}
                </th>
                <th
                  onClick={() => handleSort('qty')}
                  style={{ textAlign: 'right', padding: '6px 14px 6px 6px', fontSize: 9, color: 'var(--dim)', letterSpacing: 1, borderBottom: '1px solid #0d0d0d', fontWeight: 300, cursor: 'pointer', userSelect: 'none', width: '30%' }}
                >
                  QUANTITY{sortIndicator('qty')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={2} style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, letterSpacing: 1 }}>
                    {rows.length === 0 ? 'NO ASSETS' : 'NO MATCHING ITEMS'}
                  </td>
                </tr>
              ) : sorted.map((r, idx) => (
                <tr key={r.type_id} className="eve-row-reveal" style={{ background: 'var(--table-row-bg)', borderBottom: '1px solid #0d0d0d', animationDelay: `${idx * 10}ms` }}>
                  <td style={{ padding: '6px 10px', textAlign: 'left' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <img
                        src={`https://images.evetech.net/types/${r.type_id}/icon?size=32`}
                        alt=""
                        style={{ width: 20, height: 20, flexShrink: 0, opacity: 0.8 }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 0.5 }}>{r.name}</span>
                    </div>
                  </td>
                  <td style={{ padding: '6px 14px 6px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {new Intl.NumberFormat('en-US').format(r.qty)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});
