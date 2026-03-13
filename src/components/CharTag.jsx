/**
 * CharTag.jsx — character attribution label (colored dot + name).
 * Usage: <CharTag name="Varggg" color="#4da6ff" />
 */

export default function CharTag({ name, color, style = {} }) {
  if (!name) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontFamily: 'var(--mono)',
      fontSize: 11,
      padding: '2px 8px',
      border: '1px solid var(--border)',
      background: 'transparent',
      color: 'var(--dim)',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      ...style,
    }}>
      <span className="circle" style={{
        width: 6, height: 6,
        background: color,
        flexShrink: 0,
        display: 'inline-block',
      }} />
      {name}
    </span>
  );
}

