import { useState, useMemo } from 'react';
import { useApi } from '../hooks/useApi';
import { fmtISK } from '../utils/fmt';

function fmtM3(m3) {
  if (m3 == null) return '—';
  if (m3 >= 1_000_000) return `${(m3 / 1_000_000).toFixed(1)}M m³`;
  if (m3 >= 1_000)     return `${(m3 / 1_000).toFixed(1)}K m³`;
  return `${Math.round(m3).toLocaleString('en-US')} m³`;
}

function fmtQty(n) {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
}

// ── Queue Materials Modal ────────────────────────────────────────────────────
function QueueMatModal({ items, onClose }) {
  const { data: assetsData } = useApi('/api/assets');
  const warehouse = assetsData?.assets || {};
  const hasWarehouse = Object.keys(warehouse).length > 0;

  const [selected, setSelected] = useState(() => new Set(items.map(i => i.output_id)));
  const [copyMode, setCopyMode] = useState('delta');
  const [copied,   setCopied]   = useState(false);

  const allChecked = selected.size === items.length;

  function toggleAll(e) {
    setSelected(e.target.checked ? new Set(items.map(i => i.output_id)) : new Set());
  }
  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const matRows = useMemo(() => {
    const map = {};
    for (const item of items) {
      if (!selected.has(item.output_id)) continue;
      const runs = item.rec_runs || 1;
      for (const m of (item.material_breakdown || [])) {
        const key = String(m.type_id);
        if (!map[key]) {
          map[key] = { type_id: m.type_id, name: m.name, required: 0, unit_price: m.unit_price || 0 };
        }
        map[key].required += (m.quantity || 0) * runs;
      }
    }
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, selected]);

  function getHave(tid) {
    return warehouse[String(tid)] || 0;
  }

  function buildCopyText() {
    return matRows
      .map(m => {
        const qty = copyMode === 'delta'
          ? Math.max(0, m.required - getHave(m.type_id))
          : m.required;
        return qty > 0 ? `${m.name} ${Math.round(qty)}` : null;
      })
      .filter(Boolean)
      .join('\n');
  }

  function handleCopy() {
    const text = buildCopyText();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const MONO = { fontFamily: 'var(--mono)' };
  const DIM  = { color: 'var(--dim)' };

  return (
    <div
      className="sb-overlay"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="sb-modal" style={{ width: 'min(940px, 96vw)', maxHeight: '82vh' }}>

        {/* Header */}
        <div className="sb-header">
          <span className="sb-title">◈ QUEUE MATERIALS</span>
          <button className="sb-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

          {/* Left: item checklist */}
          <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid #1a1a1a', overflowY: 'auto', padding: '4px 0' }}>
            <div style={{ padding: '4px 10px 6px', fontSize: 9, letterSpacing: 2, ...DIM, ...MONO }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                SELECT ALL
              </label>
            </div>
            {items.map(item => (
              <label
                key={item.output_id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '3px 10px', cursor: 'pointer',
                  background: selected.has(item.output_id) ? 'rgba(255,255,255,0.04)' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.output_id)}
                  onChange={() => toggle(item.output_id)}
                />
                <span style={{
                  ...MONO, fontSize: 11,
                  color: selected.has(item.output_id) ? 'var(--text)' : 'var(--dim)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }} title={item.name}>
                  {item.name}
                </span>
                {item.rec_runs > 1 && (
                  <span style={{ ...MONO, fontSize: 9, color: 'var(--dim)', flexShrink: 0 }}>
                    ×{item.rec_runs}
                  </span>
                )}
              </label>
            ))}
          </div>

          {/* Right: aggregated materials */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px' }}>
            {matRows.length === 0 ? (
              <div style={{ ...DIM, ...MONO, fontSize: 11, padding: 20, textAlign: 'center', letterSpacing: 1 }}>
                SELECT ITEMS ON THE LEFT
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ fontSize: 9, letterSpacing: 1.5, ...DIM, ...MONO }}>
                    <th style={{ textAlign: 'left',  padding: '3px 0',  fontWeight: 'normal' }}>MATERIAL</th>
                    <th style={{ textAlign: 'right', padding: '3px 8px', fontWeight: 'normal' }}>REQUIRED</th>
                    {hasWarehouse && <th style={{ textAlign: 'right', padding: '3px 8px', fontWeight: 'normal' }}>HAVE</th>}
                    {hasWarehouse && <th style={{ textAlign: 'right', padding: '3px 8px', fontWeight: 'normal' }}>DELTA</th>}
                    <th style={{ textAlign: 'right', padding: '3px 0',  fontWeight: 'normal' }}>VALUE</th>
                  </tr>
                </thead>
                <tbody>
                  {matRows.map(m => {
                    const have  = getHave(m.type_id);
                    const delta = Math.max(0, m.required - have);
                    return (
                      <tr key={m.type_id} style={{ borderBottom: '1px solid #0d0d0d' }}>
                        <td style={{ ...MONO, padding: '2px 0',   color: 'var(--text)' }}>{m.name}</td>
                        <td style={{ ...MONO, padding: '2px 8px', color: 'var(--dim)', textAlign: 'right' }}>
                          {fmtQty(m.required)}
                        </td>
                        {hasWarehouse && (
                          <td style={{ ...MONO, padding: '2px 8px', textAlign: 'right', color: have > 0 ? '#4cff91' : 'var(--dim)' }}>
                            {fmtQty(have)}
                          </td>
                        )}
                        {hasWarehouse && (
                          <td style={{ ...MONO, padding: '2px 8px', textAlign: 'right', color: delta > 0 ? 'var(--accent)' : '#4cff91' }}>
                            {delta > 0 ? fmtQty(delta) : '✓ stocked'}
                          </td>
                        )}
                        <td style={{ ...MONO, padding: '2px 0', color: 'var(--dim)', textAlign: 'right' }}>
                          {m.unit_price > 0 ? fmtISK(m.required * m.unit_price) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Bottom bar */}
        <div style={{
          flexShrink: 0, padding: '7px 14px',
          borderTop: '1px solid #1a1a1a', background: 'var(--subheader-bg)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 9, letterSpacing: 1.5, ...DIM, ...MONO }}>COPY MODE</span>
          {['required', 'delta'].map(mode => (
            <button
              key={mode}
              className={`btn${copyMode === mode ? ' btn-primary' : ''}`}
              style={{ fontSize: 10, padding: '2px 10px' }}
              onClick={() => setCopyMode(mode)}
            >
              {mode === 'required' ? 'REQUIRED QTY' : 'DELTA QTY'}
            </button>
          ))}
          <button
            className="btn btn-primary"
            style={{ fontSize: 10, padding: '2px 14px', marginLeft: 8 }}
            onClick={handleCopy}
            disabled={matRows.length === 0}
          >
            {copied ? '✓ COPIED' : '⎘ COPY FOR MULTI-BUY'}
          </button>
          <span style={{ ...MONO, ...DIM, fontSize: 9, marginLeft: 'auto', letterSpacing: 0.5 }}>
            Paste into EVE → Market → Multi-Buy
          </span>
        </div>

      </div>
    </div>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────
export default function OverviewFooter() {
  const { data } = useApi('/api/queue-summary');
  const [showModal, setShowModal] = useState(false);

  const running    = data?.running_jobs   ?? '—';
  const maxJobs    = data?.max_jobs       ?? '—';
  const queue      = data?.queue_count    ?? '—';
  const shopping   = data?.needs_shopping ?? '—';
  const cost       = data ? fmtISK(data.total_cost_isk) : '—';
  const revenue    = data ? fmtISK(data.total_revenue_isk) : '—';
  const haul       = data ? fmtM3(data.haul_m3) : '—';
  const queueItems = data?.queue_items || [];

  const sep = (
    <span style={{ padding: '0 14px', color: '#666', fontSize: 13, lineHeight: 1 }}>·</span>
  );

  const Stat = ({ label, value, valueColor, onClick }) => (
    <span
      style={{ display: 'flex', alignItems: 'baseline', gap: 5, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick}
      title={onClick ? 'Click to view material breakdown' : undefined}
    >
      <span style={{ fontSize: 9, letterSpacing: 1.5, color: '#B0B0B0', fontFamily: 'var(--mono)' }}>
        {label}
      </span>
      <span style={{
        fontSize: 11, fontFamily: 'var(--mono)', color: valueColor || '#E0E0E0', letterSpacing: 0.5,
        ...(onClick ? { textDecoration: 'underline dotted', textUnderlineOffset: 3 } : {}),
      }}>
        {value}
      </span>
    </span>
  );

  return (
    <>
      <div style={{
        height: 24,
        flexShrink: 0,
        background: 'var(--footer-bg)',
        borderTop: '1px solid #555',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 14,
        paddingRight: 14,
        overflow: 'hidden',
        gap: 0,
      }}>
        <Stat label="ACTIVE JOBS" value={data ? `${running} / ${maxJobs}` : '—'} />
        {sep}
        <Stat label="QUEUE READY" value={queue} />
        {sep}
        <Stat label="NEEDS SHOPPING" value={shopping} />
        {sep}
        <Stat
          label="TOTAL COST"
          value={cost}
          valueColor="#ff6622"
          onClick={queueItems.length > 0 ? () => setShowModal(true) : undefined}
        />
        {sep}
        <Stat label="REVENUE" value={revenue} valueColor="#4cff91" />
        {sep}
        <Stat label="HAUL" value={haul} />
      </div>

      {showModal && queueItems.length > 0 && (
        <QueueMatModal items={queueItems} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
