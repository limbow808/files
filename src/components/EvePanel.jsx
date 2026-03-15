import { useState, useEffect, useRef, memo } from 'react';

/**
 * EvePanel — wrapper with EVE-style corner brackets + optional scan-line on mount.
 *
 * Props:
 *   scan       — show scan-line sweep on mount (default true)
 *   corners    — show corner bracket accents   (default true)
 *   glow       — glow on hover                 (default false)
 *   className  — extra classes
 *   style      — extra styles
 *   children
 */
function EvePanel({
  scan = true,
  corners = true,
  glow = false,
  className = '',
  style = {},
  children,
}) {
  const [showScan, setShowScan] = useState(scan);
  const ref = useRef(null);

  // Remove scan line after animation completes
  useEffect(() => {
    if (!scan) return;
    const t = setTimeout(() => setShowScan(false), 1700);
    return () => clearTimeout(t);
  }, [scan]);

  const cls = [
    'eve-panel-in',
    corners ? 'eve-corners' : '',
    glow ? 'eve-glow' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div ref={ref} className={cls} style={{ position: 'relative', ...style }}>
      {corners && <div className="eve-corners-inner" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />}
      {showScan && <div className="eve-scanline" />}
      {children}
    </div>
  );
}

export default memo(EvePanel);
