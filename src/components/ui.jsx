export function ErrorBanner() {
  return (
    <div className="error-banner">
      <span>CREST OFFLINE</span> — Start server with:{' '}
      <code style={{ color: 'var(--text)', opacity: 0.7 }}>python server.py</code>
    </div>
  );
}

export function SkeletonRows({ cols = 9, count = 5 }) {
  return Array.from({ length: count }).map((_, i) => (
    <tr key={i} className="skeleton-row">
      {Array.from({ length: cols }).map((_, j) => <td key={j}>&nbsp;</td>)}
    </tr>
  ));
}

export function HangarBadge({ can_build, max_runs }) {
  if (can_build === null || can_build === undefined)
    return <span className="badge-na">—</span>;
  if (can_build)
    return <span className="badge-ok">✓ {max_runs}x</span>;
  return <span className="badge-fail">✗ {max_runs}x</span>;
}
