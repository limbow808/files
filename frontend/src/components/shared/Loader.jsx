/**
 * Loader — two display modes:
 *   bar     — indeterminate sweep bar, EVE scan style (for long fetches)
 *   shimmer — shimmer text effect (for short loads)
 *
 * Props:
 *   size    — 'xs' | 'sm' | 'md' | 'lg'  (default 'md')
 *   label   — optional string
 *   variant — 'bar' | 'shimmer'  (default: 'bar' for lg, 'shimmer' otherwise)
 */

const BAR_WIDTHS = { xs: 120, sm: 160, md: 220, lg: 300 };
const BAR_LABEL  = { xs: 8,   sm: 9,   md: 10,  lg: 11  };
const SHIMMER_FS = { xs: 8,   sm: 9,   md: 10,  lg: 12  };

export default function Loader({ size = 'md', label, variant }) {
  const isBar = variant === 'bar' || (variant === undefined && size === 'lg');

  if (isBar) {
    const w = BAR_WIDTHS[size] ?? BAR_WIDTHS.md;
    const fs = BAR_LABEL[size] ?? BAR_LABEL.md;
    return (
      <div className={`crest-bar-loader crest-bar-loader--${size}`} style={{ width: w }}>
        {label && (
          <div className="crest-bar-loader__header">
            <span className="crest-bar-loader__label" style={{ fontSize: fs }}>{label}</span>
            <span className="crest-bar-loader__cursor">_</span>
          </div>
        )}
        <div className="crest-bar-loader__track">
          <div className="crest-bar-loader__sweep" />
        </div>
      </div>
    );
  }

  const fs = SHIMMER_FS[size] ?? SHIMMER_FS.md;
  return (
    <span className={`crest-shimmer-loader crest-shimmer-loader--${size}`} style={{ fontSize: fs }}>
      <span className="crest-shimmer-loader__text">{label || 'LOADING'}...</span>
    </span>
  );
}
