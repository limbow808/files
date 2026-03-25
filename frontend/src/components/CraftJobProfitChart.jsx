import { useRef, useEffect, useState } from 'react';
import { fmtISK } from '../utils/fmt';

const VB_W  = 600;
const VB_H  = 260;
const PAD_L = 62;
const PAD_B = 30;
const PAD_T = 14;
const PAD_R = 12;
const CW = VB_W - PAD_L - PAD_R;
const CH = VB_H - PAD_T - PAD_B;

export default function CraftJobProfitChart({ weeks }) {
  const containerRef = useRef(null);
  const [size, setSize]         = useState({ w: 0, h: 0 });
  const [hoverIdx, setHoverIdx] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const measure = () => {
      const { offsetWidth: w, offsetHeight: h } = containerRef.current;
      if (w > 0 && h > 0) setSize({ w, h });
    };
    const obs = new ResizeObserver(measure);
    obs.observe(containerRef.current);
    measure();
    return () => obs.disconnect();
  }, []);

  if (!weeks || weeks.length < 2) {
    return (
      <div ref={containerRef} style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--dim)', fontSize: 10, letterSpacing: 2,
        background: 'var(--bg)', border: '1px solid var(--border)',
      }}>
        COLLECTING DATA…
      </div>
    );
  }

  const profits = weeks.map(w => w.est_profit  || 0);
  const costs   = weeks.map(w => w.total_cost  || 0);

  // Y scale covers both profit (can be negative) and costs
  const maxVal = Math.max(...costs, ...profits.map(Math.abs), 1);
  const minVal = Math.min(0, ...profits);
  const range  = (maxVal - minVal) || 1;

  const toY    = val => PAD_T + CH - ((val - minVal) / range) * CH;
  const zeroY  = toY(0);

  const n     = weeks.length;
  const bandW = CW / n;
  const barW  = Math.max(4, bandW * 0.58);

  // Y ticks: 5 evenly spaced
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map(f => minVal + f * range);

  return (
    <div ref={containerRef} style={{
      width: '100%', height: '100%',
      border: '1px solid var(--border)',
      background: 'var(--table-shell-bg)',
      lineHeight: 0,
    }}>
      {size.w > 0 && (
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          width={size.w} height={size.h}
          preserveAspectRatio="none"
          style={{ display: 'block' }}
        >
          {/* Y grid + labels */}
          {yTicks.map((val, i) => {
            const y = toY(val);
            return (
              <g key={i}>
                <line x1={PAD_L} y1={y} x2={VB_W - PAD_R} y2={y}
                  stroke="#151515" strokeWidth={0.8} />
                <text x={PAD_L - 5} y={y + 4}
                  textAnchor="end" fontSize="15" fontFamily="monospace" fill="#2e2e2e">
                  {fmtISK(val)}
                </text>
              </g>
            );
          })}

          {/* Zero line */}
          <line x1={PAD_L} y1={zeroY} x2={VB_W - PAD_R} y2={zeroY}
            stroke="#2a2a2a" strokeWidth={1.4} />

          {/* Cost bars (dim yellow, context reference) */}
          {weeks.map((w, i) => {
            const cx   = PAD_L + i * bandW + bandW / 2;
            const cost = w.total_cost || 0;
            const top  = toY(cost);
            const h    = Math.max(1, zeroY - top);
            return (
              <rect key={`c${i}`}
                x={cx - barW / 2} y={top} width={barW} height={h}
                fill="rgba(255,204,68,0.14)"
              />
            );
          })}

          {/* Profit bars */}
          {weeks.map((w, i) => {
            const cx   = PAD_L + i * bandW + bandW / 2;
            const prof = w.est_profit || 0;
            const top  = toY(Math.max(0, prof));
            const bot  = toY(Math.min(0, prof));
            const h    = Math.max(2, bot - top);
            const fill = hoverIdx === i
              ? (prof >= 0 ? 'rgba(0,220,110,0.95)' : 'rgba(220,60,60,0.95)')
              : (prof >= 0 ? 'rgba(0,204,102,0.75)' : 'rgba(204,51,51,0.75)');
            return (
              <rect key={`p${i}`}
                x={cx - barW / 2 + 1} y={top} width={barW - 2} height={h}
                fill={fill}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{ cursor: 'default' }}
              />
            );
          })}

          {/* Hover tooltip */}
          {hoverIdx != null && (() => {
            const w    = weeks[hoverIdx];
            const prof = w.est_profit || 0;
            const cx   = PAD_L + hoverIdx * bandW + bandW / 2;
            const lines = [
              w.week_label || '—',
              `Profit  ${fmtISK(prof)}`,
              `Cost    ${fmtISK(w.total_cost || 0)}`,
              `Revenue ${fmtISK(w.est_revenue || 0)}`,
              `Jobs    ${w.job_count || 0}`,
            ];
            const tw = 162;
            const th = lines.length * 17 + 10;
            // pin tooltip so it doesn't go off the right edge
            const tx = cx + 10 + tw > VB_W - PAD_R ? cx - tw - 10 : cx + 10;
            const ty = PAD_T + 6;
            return (
              <g>
                <rect x={tx - 4} y={ty - 14} width={tw + 8} height={th}
                  fill="#080808" stroke="#2a2a2a" strokeWidth={0.8} rx={2} />
                {lines.map((line, li) => (
                  <text key={li} x={tx} y={ty + li * 17}
                    fontSize="13" fontFamily="monospace"
                    fill={li === 1 ? (prof >= 0 ? '#00cc66' : '#cc3333') : '#888'}>
                    {line}
                  </text>
                ))}
              </g>
            );
          })()}

          {/* X axis labels */}
          {weeks.map((w, i) => {
            if (n > 13 && i % 2 !== 0) return null;
            const cx = PAD_L + i * bandW + bandW / 2;
            // week_label is "2026-W12" — show last 3 chars "W12"
            const lbl = (w.week_label || '').slice(-3);
            return (
              <text key={`xl${i}`} x={cx} y={VB_H - 8}
                textAnchor="middle" fontSize="13" fontFamily="monospace" fill="#2e2e2e">
                {lbl}
              </text>
            );
          })}
        </svg>
      )}
    </div>
  );
}
