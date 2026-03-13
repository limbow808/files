export default function WalletSparkline({ history, target }) {
  if (!history || history.length < 2) {
    return (
      <div style={{
        height: 68, display: 'flex', alignItems: 'center',
        color: 'var(--dim)', fontSize: 10, letterSpacing: 2,
        background: '#050505', border: '1px solid #111',
        paddingLeft: 12, marginBottom: 14,
      }}>
        WALLET SPARKLINE — COLLECTING DATA (UPDATES EVERY 5 MIN)
      </div>
    );
  }

  const W = 400, H = 68;
  const now    = Date.now() / 1000;
  const d      = new Date();
  const mStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),     1) / 1000;
  const mEnd   = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
  const span   = mEnd - mStart || 1;
  const tgt    = target || 1;

  const toX = ts  => Math.max(0, Math.min(W, ((ts - mStart) / span) * W));
  const toY = val => Math.max(2, H - 2 - (Math.min(Math.max(val, 0), tgt) / tgt) * (H - 4));

  const nowX       = toX(now);
  const paceAtNow  = ((now - mStart) / span) * tgt;
  const pts        = history
    .filter(p => p.ts >= mStart)
    .map(p => `${toX(p.ts).toFixed(1)},${toY(p.balance).toFixed(1)}`);
  const last       = history[history.length - 1];
  const lx         = toX(last.ts);
  const ly         = toY(last.balance);
  const fillPts    = pts.length > 0
    ? `0,${H} ${pts.join(' ')} ${lx.toFixed(1)},${H}`
    : null;

  return (
    <div style={{ marginBottom: 14, border: '1px solid #111', background: '#030303' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 68, display: 'block' }}
        preserveAspectRatio="none"
      >
        <line x1="0" y1="2" x2={W} y2="2" stroke="#1e1e1e" strokeWidth="1" />
        <line
          x1="0" y1={H} x2={nowX} y2={toY(paceAtNow)}
          stroke="#2a2a2a" strokeWidth="1.5" strokeDasharray="4,3"
        />
        {fillPts && <polygon points={fillPts} fill="rgba(255,71,0,0.07)" />}
        {pts.length > 1 && (
          <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        )}
        <circle cx={lx} cy={ly} r="3" fill="var(--accent)" />
      </svg>
    </div>
  );
}
