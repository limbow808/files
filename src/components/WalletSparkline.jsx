import { useRef, useEffect, useState } from 'react';
import { fmtISK } from '../utils/fmt';

// All geometry is in viewBox space; SVG is stretched to fill container exactly
const VB_W = 600;
const VB_H = 300;
const PAD_L = 52;
const PAD_B = 28;
const PAD_T = 10;
const PAD_R = 10;
const CW = VB_W - PAD_L - PAD_R;
const CH = VB_H - PAD_T - PAD_B;

export default function WalletSparkline({ history, target }) {
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

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

  const now    = Date.now() / 1000;
  const d      = new Date();
  const mStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),     1) / 1000;
  const mEnd   = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  const daysInMonth = Math.round((mEnd - mStart) / 86400);
  const span   = mEnd - mStart || 1;
  const tgt    = target || 1;

  const toX = ts  => PAD_L + Math.max(0, Math.min(CW, ((ts - mStart) / span) * CW));
  const toY = val => PAD_T + CH - Math.max(0, Math.min(CH, (val / tgt) * CH));

  const nowX      = toX(now);
  const paceAtNow = ((now - mStart) / span) * tgt;
  const pts = (history || [])
    .filter(p => p.ts >= mStart)
    .map(p => ({ x: toX(p.ts), y: toY(p.balance) }));

  const last    = pts.length > 0 ? pts[pts.length - 1] : null;
  const fillPts = pts.length > 1
    ? `${PAD_L},${PAD_T + CH} ${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} ${last.x.toFixed(1)},${PAD_T + CH}`
    : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
  const xTicks = [];
  for (let day = 5; day < daysInMonth; day += 5) {
    const ts = mStart + day * 86400;
    if (ts < mEnd) xTicks.push({ day, x: toX(ts) });
  }

  if (!history || history.length < 2) {
    return (
      <div ref={containerRef} style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center',
        color: 'var(--dim)', fontSize: 10, letterSpacing: 2,
        background: '#050505', border: '1px solid #111',
        paddingLeft: 12,
      }}>
        COLLECTING DATA…
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', border: '1px solid #111', background: '#030303', lineHeight: 0 }}>
      {size.w > 0 && (
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          width={size.w}
          height={size.h}
          preserveAspectRatio="none"
          style={{ display: 'block' }}
        >
          {/* Y grid + labels */}
          {yTicks.map(frac => {
            const y        = toY(frac * tgt);
            const isTarget = frac === 1.0;
            return (
              <g key={frac}>
                <line
                  x1={PAD_L} y1={y} x2={VB_W - PAD_R} y2={y}
                  stroke={isTarget ? '#252525' : '#151515'}
                  strokeWidth={isTarget ? 1.2 : 0.8}
                  strokeDasharray={isTarget ? '5,4' : undefined}
                />
                <text
                  x={PAD_L - 6} y={y + 4}
                  textAnchor="end" fontSize="18" fontFamily="monospace"
                  fill={isTarget ? '#444' : '#252525'}
                >{frac === 0 ? '0' : fmtISK(frac * tgt)}</text>
              </g>
            );
          })}

          {/* X day ticks + labels */}
          {xTicks.map(({ day, x }) => (
            <g key={day}>
              <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + CH} stroke="#111" strokeWidth="0.8" />
              <text
                x={x} y={VB_H - 6}
                textAnchor="middle" fontSize="18" fontFamily="monospace"
                fill="#252525"
              >{day}</text>
            </g>
          ))}

          {/* Pace reference line */}
          <line
            x1={PAD_L} y1={PAD_T + CH}
            x2={nowX}  y2={toY(paceAtNow)}
            stroke="#252525" strokeWidth="2" strokeDasharray="8,6"
          />

          {/* Area under line */}
          {fillPts && <polygon points={fillPts} fill="rgba(255,71,0,0.07)" />}

          {/* Balance line */}
          {pts.length > 1 && (
            <polyline
              points={pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round"
            />
          )}

          {/* Latest dot */}
          {last && (
            <>
              <circle cx={last.x} cy={last.y} r="7" fill="#030303" stroke="var(--accent)" strokeWidth="3" />
              <circle cx={last.x} cy={last.y} r="3.5" fill="var(--accent)" />
            </>
          )}

          {/* Now vertical line */}
          <line x1={nowX} y1={PAD_T} x2={nowX} y2={PAD_T + CH} stroke="#1e1e1e" strokeWidth="1.5" />
        </svg>
      )}
    </div>
  );
}
