import EveText from './EveText';

export function ErrorBanner() {
  return (
    <div className="error-banner eve-corners eve-panel-in" style={{ position: 'relative' }}>
      <div className="eve-corners-inner" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      <span><EveText text="CREST OFFLINE" scramble={true} steps={10} speed={40} /></span> — Start server with:{' '}
      <code style={{ color: 'var(--text)', opacity: 0.7 }}>python server.py</code>
    </div>
  );
}

export function LoadingState({ label = 'LOADING', sub = '' }) {
  return (
    <div className="loading-state">
      <EveText text={label} scramble={true} wave={true} speed={30} steps={8} style={{ fontSize: 10, letterSpacing: 3 }} />
      {sub && <EveText text={sub} scramble={true} wave={true} speed={40} steps={12} style={{ fontSize: 9, letterSpacing: 2, color: 'var(--dim)', opacity: 0.55 }} />}
    </div>
  );
}

export function SkeletonRows({ cols = 9, count = 5 }) {
  return Array.from({ length: count }).map((_, i) => (
    <tr key={i} className="skeleton-row eve-row-reveal" style={{ animationDelay: `${i * 60}ms` }}>
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
