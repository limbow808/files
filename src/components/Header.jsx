import { memo } from 'react';
import { useClock } from '../hooks/useClock';
import EveText from './EveText';

export default memo(function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  return (
    <div id="crest-header" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'stretch' }}>

      {/* Left: EVE clock only */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 14 }}>
        <div className="clock-text" style={{ color: 'var(--text2)', fontSize: 11, letterSpacing: 1.5, fontWeight: 300 }}>
        <EveText text={clock} scramble={false} wave={false} />
        </div>
      </div>

      {/* Center: Nav tabs */}
      <div className="nav-bar">
        {['OVERVIEW', 'CALCULATOR', 'BP FINDER', 'REVENUE', 'CHARACTERS'].map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => onTabChange(tab)}
          >
            <EveText text={tab} scramble={false} wave={false} />
          </button>
        ))}
      </div>

      {/* Right: status dot + REFRESH MARKET */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 16, gap: 10 }}>
        <span className={`dot ${online ? 'dot-green' : 'dot-red'} eve-dot-pulse`} />
        <button
          className={`header-scan-btn${refreshing ? ' header-scan-btn--active' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          style={{ padding: '0 10px' }}
          title="Re-fetch Jita market prices and recalculate all blueprint profits"
        >
          <span className={`scan-label-main${refreshing ? ' scan-label-shimmer' : ''}`}>
            {refreshing ? 'FETCHING…' : 'REFRESH MARKET'}
          </span>
        </button>
      </div>

      {/* Accent line that builds from center on load */}
      <div className="eve-header-line" style={{ gridColumn: '1 / -1' }} />
    </div>
  );
});
