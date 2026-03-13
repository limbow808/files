import { useRef, useCallback, useEffect, useState } from 'react';
import PlexSection from '../components/PlexSection';
import MineralsSection from '../components/MineralsSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';

// ── Shared-split two-panel column (left + drag handle + right) ────────────────
// colSplit / onColDrag are passed in so both rows share the same split value.
function SplitRow({ colSplit, onColDrag, children }) {
  const containerRef = useRef(null);
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
      const clamped = Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width));
      onColDrag(clamped);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [onColDrag]);

  const [left, right] = children;
  return (
    <div ref={containerRef} style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0 }}>
      <div style={{ flex: `0 0 ${colSplit * 100}%`, minWidth: 0, overflow: 'hidden' }}>
        {left}
      </div>
      <div
        onMouseDown={onMouseDown}
        title="Drag to resize columns"
        style={{
          width: 1, flexShrink: 0, cursor: 'col-resize',
          background: 'var(--border)',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,71,0,0.6)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function OverviewPage({ plexData, walletHistory, plexLoading }) {
  // Shared horizontal column split (both rows move together)
  const [colSplit, setColSplit] = useState(() => {
    try { return parseFloat(localStorage.getItem('ov-col-split') || '0.60'); }
    catch { return 0.60; }
  });
  const handleColDrag = useCallback(v => {
    setColSplit(v);
    try { localStorage.setItem('ov-col-split', v); } catch {}
  }, []);

  // Vertical row split (top row height %)
  const pageRef = useRef(null);
  const rowDragging = useRef(false);
  const [rowSplit, setRowSplit] = useState(() => {
    try { return parseFloat(localStorage.getItem('ov-row-split') || '0.55'); }
    catch { return 0.55; }
  });

  const onRowMouseDown = useCallback(e => {
    e.preventDefault();
    rowDragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = e => {
      if (!rowDragging.current || !pageRef.current) return;
      const rect = pageRef.current.getBoundingClientRect();
      const clamped = Math.max(0.2, Math.min(0.8, (e.clientY - rect.top) / rect.height));
      setRowSplit(clamped);
    };
    const onUp = () => {
      if (!rowDragging.current) return;
      rowDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRowSplit(prev => { try { localStorage.setItem('ov-row-split', prev); } catch {} return prev; });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  return (
    <div ref={pageRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Row 1: Manufacturing Jobs (left) + PLEX Tracker (right) */}
      <div style={{ flex: `0 0 ${rowSplit * 100}%`, minHeight: 0, overflow: 'hidden' }}>
        <SplitRow colSplit={colSplit} onColDrag={handleColDrag}>
          <ManufacturingJobs />
          <PlexSection plexData={plexData} walletHistory={walletHistory} loading={plexLoading} />
        </SplitRow>
      </div>

      {/* Horizontal drag handle between rows */}
      <div
        onMouseDown={onRowMouseDown}
        title="Drag to resize rows"
        style={{
          height: 1, flexShrink: 0, cursor: 'row-resize',
          background: 'var(--border)',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,71,0,0.6)'}
        onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
      />

      {/* Row 2: Orders (left) + Minerals/Ores (right) */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <SplitRow colSplit={colSplit} onColDrag={handleColDrag}>
          <OrdersSection />
          <MineralsSection />
        </SplitRow>
      </div>

    </div>
  );
}
