/**
 * CharTag.jsx — character attribution label (colored dot + name).
 * Usage: <CharTag name="Varggg" color="#4da6ff" />
 */

export default function CharTag({ name, color, bordered = true, style = {} }) {
  if (!name) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontFamily: 'var(--mono)',
      fontSize: 11,
      padding: bordered ? '2px 8px' : 0,
      border: bordered ? '1px solid var(--border)' : 'none',
      background: 'transparent',
      color: 'var(--dim)',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      ...style,
    }}>
      <span style={{
        width: 6, height: 6,
        background: color,
        flexShrink: 0,
        display: 'inline-block',
      }} />
      {name}
    </span>
  );
}

