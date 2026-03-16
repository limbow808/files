import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { fmtISK } from '../utils/fmt';
import EveText from './EveText';

// ── PLEX Chart (canvas 2D) ────────────────────────────────────────────────────
function PlexChart({ walletHistory, balance, target }) {
  const canvasRef    = useRef(null);
  const containerRef = useRef(null);
  const hoverRef     = useRef(null);          // mutable hover for RAF
  const [hover, setHover]  = useState(null);  // triggers DOM tooltip
  const [dims, setDims]    = useState({ w: 0, h: 0 });

  const now         = new Date();
  const year        = now.getFullYear();
  const month       = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const currentDay  = now.getDate();
  const mStartTs    = Date.UTC(year, month, 1) / 1000;

  const hist = walletHistory || [];

  const startBal = useMemo(() => {
    const before = hist.filter(p => p.ts < mStartTs);
    return before.length > 0 ? before[before.length - 1].balance : (hist.length > 0 ? hist[0].balance : balance);
  }, [hist, mStartTs, balance]);

  const dailyData = useMemo(() => {
    const result = [];
    let last = startBal;
    for (let d = 1; d <= currentDay; d++) {
      const ds = mStartTs + (d - 1) * 86400;
      const de = mStartTs + d * 86400;
      const pts = hist.filter(p => p.ts >= ds && p.ts < de);
      const endBal = pts.length > 0 ? pts[pts.length - 1].balance : last;
      result.push({ day: d, balance: endBal, delta: endBal - last });
      last = endBal;
    }
    return result;
  }, [hist, startBal, currentDay, mStartTs]);

  const currentBal = dailyData.length > 0 ? dailyData[dailyData.length - 1].balance : balance;
  const yMax       = Math.max(currentBal * 1.3, 1000);
  const maxDelta   = Math.max(...dailyData.map(d => Math.abs(d.delta)), 1);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const { width: w, height: h } = entries[0].contentRect;
      if (w > 0 && h > 0) setDims({ w, h });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Chart drawing — requestAnimationFrame with pulse ring
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dims.w === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width  = dims.w * dpr;
    canvas.height = dims.h * dpr;

    let raf;
    let phase = 0;

    function draw() {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const w = dims.w, h = dims.h;
      const padL = 44, padR = 8, padT = 8, padB = 18;
      const cw = w - padL - padR;
      const ch = h - padT - padB;

      const toX = day => padL + ((day - 0.5) / daysInMonth) * cw;
      const toY = val => padT + ch - (Math.max(0, val) / yMax) * ch;
      const barW = Math.max(1, (cw / daysInMonth) * 0.6);

      ctx.clearRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 0.5;
      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const y = toY((yMax / yTicks) * i);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      }

      // Y axis labels
      ctx.font = '9px "Share Tech Mono", monospace';
      ctx.fillStyle = '#555544';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= yTicks; i++) {
        const val = (yMax / yTicks) * i;
        ctx.fillText(fmtISK(val), padL - 4, toY(val));
      }

      // X axis day numbers
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const step = daysInMonth > 20 ? 5 : 2;
      for (let d = 1; d <= daysInMonth; d++) {
        if (d !== 1 && d % step !== 0) continue;
        ctx.fillText(`${d}`, toX(d), h - padB + 4);
      }

      // Daily bars
      const hDay = hoverRef.current?.day;
      dailyData.forEach(dd => {
        const barH = (Math.abs(dd.delta) / maxDelta) * ch * 0.45;
        if (barH < 0.5) return;
        const x = toX(dd.day);
        ctx.fillStyle = hDay === dd.day ? 'rgba(255,71,0,0.5)' : 'rgba(255,71,0,0.15)';
        ctx.fillRect(x - barW / 2, padT + ch - barH, barW, barH);
      });

      // Cumulative line (wallet balance)
      if (dailyData.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = '#FF4700';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        dailyData.forEach((dd, i) => {
          const x = toX(dd.day), y = toY(dd.balance);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      // Projection line
      if (dailyData.length >= 2) {
        const last = dailyData[dailyData.length - 1];
        const cum  = last.balance - startBal;
        const rate = cum / last.day;
        const proj = last.balance + rate * (daysInMonth - last.day);
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,71,0,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.moveTo(toX(last.day), toY(last.balance));
        ctx.lineTo(toX(daysInMonth), toY(proj));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Current position dot + pulse ring
      if (dailyData.length > 0) {
        const last = dailyData[dailyData.length - 1];
        const cx = toX(last.day), cy = toY(last.balance);

        // Pulse ring via requestAnimationFrame
        const p = (phase % 120) / 120; // 0→1 over ~2s at 60fps
        const ringR = 3 + p * 12;
        const ringA = 0.3 * (1 - p);
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,71,0,${ringA})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Solid dot
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#FF4700';
        ctx.fill();

        // Value label
        ctx.font = '9px "Share Tech Mono", monospace';
        ctx.fillStyle = '#FF4700';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmtISK(last.balance), cx + 8, cy);
      }

      // Target label (top-right)
      ctx.font = '9px "Share Tech Mono", monospace';
      ctx.fillStyle = 'rgba(255,71,0,0.4)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`▲ TARGET ${fmtISK(target)}`, w - padR, padT + 2);

      phase++;
      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dims, dailyData, yMax, maxDelta, daysInMonth, startBal, target, currentBal]);

  // Mouse interaction
  const handleMouseMove = useCallback(e => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const padL = 44, padR = 8;
    const cw = rect.width - padL - padR;
    const relX = mx - padL;
    if (relX < 0 || relX > cw) { hoverRef.current = null; setHover(null); return; }
    const day = Math.max(1, Math.min(currentDay, Math.round((relX / cw) * daysInMonth + 0.5)));
    const dd = dailyData.find(d => d.day === day);
    if (dd) {
      const info = { day: dd.day, x: mx, y: e.clientY - rect.top, delta: dd.delta, balance: dd.balance };
      hoverRef.current = info;
      setHover(info);
    } else {
      hoverRef.current = null;
      setHover(null);
    }
  }, [dailyData, daysInMonth, currentDay]);

  const handleMouseLeave = useCallback(() => { hoverRef.current = null; setHover(null); }, []);

  if (!hist.length) {
    return (
      <div ref={containerRef} style={{
        width: '100%', height: 160, display: 'flex', alignItems: 'center',
        color: '#555544', fontSize: 10, letterSpacing: 2, background: '#050505', border: '1px solid #111', paddingLeft: 12,
      }}>COLLECTING DATA…</div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: 160, position: 'relative', background: '#030303', border: '1px solid #111' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {hover && (
        <div style={{
          position: 'absolute',
          left: Math.min(hover.x + 8, dims.w - 140),
          top: Math.max(0, hover.y - 56),
          background: '#0a0a0a',
          border: '1px solid var(--accent)',
          padding: '5px 9px',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: 0.5,
          color: 'var(--text)',
          pointerEvents: 'none',
          zIndex: 10,
          whiteSpace: 'nowrap',
        }}>
          <div style={{ color: 'var(--accent)', marginBottom: 2 }}>DAY {hover.day}</div>
          <div>EARNED: {fmtISK(hover.delta)}</div>
          <div>TOTAL: {fmtISK(hover.balance)}</div>
        </div>
      )}
    </div>
  );
}

// ── Main PLEX Section ──────────────────────────────────────────────────────────
export default function PlexSection({ plexData, walletHistory, loading, error }) {
  const balance   = plexData?.current_balance  ?? 0;
  const target    = plexData?.monthly_target   ?? 0;
  const daysLeft  = plexData?.days_remaining   ?? 0;
  const plexPrice = plexData?.plex_price       ?? 0;
  const needed    = Math.max(0, target - balance);
  const perDay    = daysLeft > 0 ? needed / daysLeft : 0;
  const pct       = target > 0 ? Math.min(100, balance / target * 100) : 0;
  const projOk    = pct >= 100;
  const month     = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }).toUpperCase();

  const stats = [
    ['ISK / DAY',   fmtISK(perDay)    + ' ISK'],
    ['PLEX PRICE',  fmtISK(plexPrice) + ' ISK'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '10px 14px' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8, flexShrink: 0 }}>
        <span className="panel-title">◈ PLEX TRACKER — {month}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: 1 }}>
          {daysLeft} DAYS LEFT
        </span>
      </div>

      {/* ESI error */}
      {error && !plexData && (
        <div style={{ padding: '8px 0 4px', fontSize: 10, color: '#ff4444', letterSpacing: 1 }}>
          ⚠ ESI UNAVAILABLE
        </div>
      )}

      {/* Wallet balance */}
      <div style={{ marginBottom: 8, flexShrink: 0 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 3 }}>WALLET</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }}>
          {loading && !plexData ? '—' : <EveText text={`${fmtISK(balance)} ISK`} scramble={true} steps={14} speed={30} />}
        </div>
      </div>

      {/* Canvas chart */}
      <div style={{ marginBottom: 8, flexShrink: 0 }}>
        <PlexChart walletHistory={walletHistory} balance={balance} target={target} />
      </div>

      {/* Progress bar */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--dim)', letterSpacing: 1, marginBottom: 4 }}>
          <span>0</span>
          <span style={{ color: projOk ? '#00cc66' : 'var(--text)' }}>{pct.toFixed(1)}% OF TARGET</span>
          <span>{fmtISK(target)} ISK</span>
        </div>
        <div style={{ height: 6, background: '#0a0a0a', border: '1px solid var(--border)', marginBottom: 5 }}>
          <div className="eve-bar-glow" style={{ height: '100%', width: `${pct}%`, background: projOk ? '#00cc66' : 'var(--accent)', transition: 'width 0.8s ease' }} />
        </div>
        <div style={{ fontSize: 10, color: projOk ? '#00cc66' : 'var(--accent)', letterSpacing: 1, marginBottom: 8, textAlign: 'right' }}>
          {projOk ? 'TARGET ACHIEVED ✓' : `SHORT BY ${fmtISK(needed)} ISK`}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border)', flexShrink: 0 }}>
        {stats.map(([label, val]) => (
          <div key={label} style={{ background: '#050505', padding: '8px 10px' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 2, color: 'var(--dim)', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 12, color: 'var(--text)' }}>{loading && !plexData ? '—' : val}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

