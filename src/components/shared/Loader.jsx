/**
 * Loader — reusable CREST loading indicator.
 *
 * A floating + cross made of four arms (no center element), with a
 * sonar-ping ring and a snap-rotation animation.
 *
 * Props:
 *   size   — 'sm' | 'md' | 'lg'  (default 'md')
 *   label  — optional string displayed below (uppercase, blinking cursor)
 */

const SIZES = {
  xs: { total: 14,  armW: 1.5, armL: 4,  gap: 2,  ring: 6,  labelSize: 9  },
  sm: { total: 24,  armW: 2,  armL: 6,  gap: 3,  ring: 10, labelSize: 9  },
  md: { total: 64,  armW: 2,  armL: 16, gap: 7,  ring: 26, labelSize: 11 },
  lg: { total: 100, armW: 2,  armL: 26, gap: 11, ring: 40, labelSize: 11 },
};

export default function Loader({ size = 'md', label, paused = false }) {
  const s = SIZES[size] || SIZES.md;
  const half = s.total / 2;

  // Each arm: thin rect offset from center by `gap`, length `armL`
  // Arms point up/down/left/right; the whole group rotates
  const armStyle = (rotate) => ({
    position: 'absolute',
    left:  '50%',
    top:   '50%',
    width:  s.armW,
    height: s.armL,
    background: '#FF4700',
    transform: `translate(-50%, -50%) rotate(${rotate}deg) translateY(-${s.gap + s.armL / 2}px)`,
    borderRadius: 1,
  });

  return (
    <span className={`crest-loader crest-loader--${size}`} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: size === 'sm' || size === 'xs' ? 0 : 10 }}>
      {/* Cross + ring wrapper */}
      <span
        className="crest-loader__cross"
        style={{
          position: 'relative',
          display: 'inline-block',
          width:  s.total,
          height: s.total,
          flexShrink: 0,
        }}
      >
        {/* Sonar ring — hidden when paused */}
        {!paused && (
          <span
            className="crest-loader__ring"
            style={{
              position: 'absolute',
              left: '50%',
              top:  '50%',
              width:  s.ring,
              height: s.ring,
              borderRadius: '50%',
              border: '1px solid rgba(255,71,0,0.4)',
              transform: 'translate(-50%, -50%)',
            }}
          />
        )}

        {/* Four arms — wrapped so only the group rotates */}
        <span
          className="crest-loader__arms"
          style={{ position: 'absolute', inset: 0, animationPlayState: paused ? 'paused' : 'running' }}
        >
          <span style={armStyle(0)}   />  {/* up    */}
          <span style={armStyle(90)}  />  {/* right */}
          <span style={armStyle(180)} />  {/* down  */}
          <span style={armStyle(270)} />  {/* left  */}
        </span>
      </span>

      {/* Optional label */}
      {label && (
        <span className="crest-loader__label" style={{ fontSize: s.labelSize }}>
          {label}<span className="crest-loader__cursor">_</span>
        </span>
      )}
    </span>
  );
}
