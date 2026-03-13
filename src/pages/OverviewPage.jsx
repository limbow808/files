import { useState, useRef, useCallback, useEffect, Fragment } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';
import { ErrorBanner, SkeletonRows, HangarBadge } from '../components/ui';
import DetailPanel from '../components/DetailPanel';
import KPIBar from '../components/KPIBar';
import PlexSection from '../components/PlexSection';
import MineralsSection from '../components/MineralsSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';

// ── Resizable panel wrapper ────────────────────────────────────────────────────
// Allows horizontal drag-resize on the right edge between two panels.
function ResizableGrid({ children, defaultSplit = 0.55, storageKey }) {
  const containerRef = useRef(null);
  const [split, setSplit] = useState(() => {
    try { return parseFloat(localStorage.getItem(storageKey) || defaultSplit); }
    catch { return defaultSplit; }
  });
  const dragging = useRef(false);

  const onMouseDown = useCallback(e => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = e => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const raw  = (e.clientX - rect.left) / rect.width;
      const clamped = Math.max(0.2, Math.min(0.8, raw));
      setSplit(clamped);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSplit(prev => {
        try { localStorage.setItem(storageKey, prev); } catch {}
        return prev;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [storageKey]);

  const [left, right] = children;
  return (
    <div ref={containerRef} style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0 }}>
      <div style={{ flex: `0 0 ${split * 100}%`, minWidth: 0, overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
        {left}
      </div>
      {/* drag handle */}
      <div
        onMouseDown={onMouseDown}
        style={{ width: 6, flexShrink: 0, cursor: 'col-resize', background: 'transparent', position: 'relative', zIndex: 10 }}
        title="Drag to resize"
      />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}

// ── Opportunities (owned BPs only, max 5) ─────────────────────────────────────
function OpportunitiesSection({ scanData, loading, error }) {
  const { data: bpData, loading: bpLoading } = useApi('/api/blueprints/esi');
  const [selectedIdx, setSelectedIdx] = useState(null);

  const ownedBpIds = new Set((bpData?.blueprints || []).map(b => {
    // Blueprint type_ids are the BP type, not the product; ESI returns type_id of the BP item.
    // We match on name substring as a fallback — but the scan results have output_id (the product).
    // The BP panel has type_id = bp type, which differs from output_id.
    // Best approach: match by name. Build a set of owned product names.
    return b.name?.replace(' Blueprint', '').toLowerCase();
  }));

  const allResults = scanData?.results || [];
  // Filter to owned BPs only, then take top 5
  const results = allResults
    .filter(r => ownedBpIds.has(r.name?.toLowerCase()))
    .slice(0, 5);

  const maxMargin = Math.max(...results.map(r => r.margin_pct || 0), 1);
  const isLoading = loading || bpLoading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="panel-hdr">
        <span className="panel-title">◈ Top Opportunities — Owned BPs</span>
        <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          {scanData?.scanned_at
            ? `SCAN  ${new Date(scanData.scanned_at * 1000).toUTCString().replace(' GMT','').split(' ').slice(1,5).join(' ')} UTC`
            : ''}
        </span>
      </div>
      {error && <ErrorBanner />}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>ITEM</th>
              <th>REVENUE</th>
              <th>MAT COST</th>
              <th>NET PROFIT</th>
              <th style={{ width: 100 }}>MARGIN</th>
              <th>HANGAR</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && !scanData ? (
              <SkeletonRows cols={7} count={5} />
            ) : results.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: '24px 16px', color: 'var(--dim)', textAlign: 'center', letterSpacing: 2, fontSize: 11 }}>
                {bpLoading ? 'LOADING BP LIBRARY…' : 'NO OWNED BPS MATCH SCAN — RUN ⟳ SCAN'}
              </td></tr>
            ) : (
              results.map((r, i) => {
                const isSel       = selectedIdx === i;
                const profitColor = r.net_profit >= 0 ? 'var(--text)' : 'var(--accent)';
                const barW        = Math.min(100, ((r.margin_pct || 0) / maxMargin) * 100);
                return (
                  <Fragment key={r.output_id ?? i}>
                    <tr
                      className={`${r.is_profitable ? 'row-profitable' : 'row-unprofitable'}${isSel ? ' row-selected' : ''}`}
                      onClick={() => setSelectedIdx(p => p === i ? null : i)}
                    >
                      <td style={{ color: 'var(--dim)', fontSize: 11 }}>#{i + 1}</td>
                      <td style={{ fontFamily: 'var(--head)', fontSize: 14, letterSpacing: 1 }}>{r.name}</td>
                      <td>{fmtISK(r.gross_revenue)}</td>
                      <td style={{ color: 'var(--dim)' }}>{fmtISK(r.material_cost)}</td>
                      <td style={{ color: profitColor }}>{fmtISK(r.net_profit)}</td>
                      <td className="margin-cell">
                        <div className="margin-bar" style={{ width: `${barW}%` }} />
                        <span className="margin-val">{r.margin_pct?.toFixed(1)}%</span>
                      </td>
                      <td><HangarBadge can_build={r.can_build} max_runs={r.max_runs} /></td>
                    </tr>
                    {isSel && <DetailPanel item={r} />}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function OverviewPage({ scanData, plexData, walletHistory, scanLoading, plexLoading, scanError, onRefresh, refreshing }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Wallet + Scan strip */}
      <KPIBar plexData={plexData} loading={plexLoading} onRefresh={onRefresh} refreshing={refreshing || scanLoading} />

      {/* Main content — three horizontal rows */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>

        {/* Row 1: Opportunities (left) + PLEX Tracker (right) */}
        <div style={{ flex: '0 0 38%', minHeight: 0, borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
          <ResizableGrid defaultSplit={0.62} storageKey="ov-row1-split">
            <OpportunitiesSection scanData={scanData} loading={scanLoading} error={scanError} />
            <PlexSection plexData={plexData} walletHistory={walletHistory} loading={plexLoading} />
          </ResizableGrid>
        </div>

        {/* Row 2: Manufacturing Jobs (left) + Minerals/Ores (right) */}
        <div style={{ flex: '0 0 30%', minHeight: 0, borderBottom: '1px solid var(--border)', overflow: 'hidden' }}>
          <ResizableGrid defaultSplit={0.58} storageKey="ov-row2-split">
            <ManufacturingJobs />
            <MineralsSection />
          </ResizableGrid>
        </div>

        {/* Row 3: Orders (full width) */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <OrdersSection />
        </div>

      </div>
    </div>
  );
}

