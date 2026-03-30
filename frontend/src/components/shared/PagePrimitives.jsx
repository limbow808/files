export function PageHeader({ title, subtitle, children, className = '', metaClassName = '' }) {
  return (
    <div className={`panel-hdr app-page-header${className ? ` ${className}` : ''}`}>
      <div>
        <div className="panel-title">{title}</div>
        {subtitle ? <div className="app-page-subtitle">{subtitle}</div> : null}
      </div>
      {children ? <div className={`app-page-meta${metaClassName ? ` ${metaClassName}` : ''}`}>{children}</div> : null}
    </div>
  );
}

export function SummaryCard({ label, value, tone = 'neutral', className = '' }) {
  return (
    <div className={`app-summary-card app-summary-card--${tone}${className ? ` ${className}` : ''}`}>
      <div className="app-summary-card__value">{value}</div>
      <div className="app-summary-card__label">{label}</div>
    </div>
  );
}

export function ContextCard({ label, value, meta, children, className = '' }) {
  return (
    <div className={`app-context-card${className ? ` ${className}` : ''}`}>
      <div className="app-context-card__label">{label}</div>
      <div className="app-context-card__value">{value}</div>
      {meta || children ? <div className="app-context-card__meta">{meta || children}</div> : null}
    </div>
  );
}

export function DetailStat({ label, value, tone, className = '' }) {
  return (
    <div className={`app-detail-stat${className ? ` ${className}` : ''}`}>
      <div className="app-detail-stat__label">{label}</div>
      <div className="app-detail-stat__value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

export function TwoPaneLayout({ main, detail, className = '', mainClassName = '', detailClassName = '' }) {
  return (
    <div className={`app-two-pane${className ? ` ${className}` : ''}`}>
      <div className={`app-two-pane__main${mainClassName ? ` ${mainClassName}` : ''}`}>
        {main}
      </div>
      <aside className={`app-two-pane__detail${detailClassName ? ` ${detailClassName}` : ''}`}>
        {detail}
      </aside>
    </div>
  );
}