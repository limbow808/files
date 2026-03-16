import { memo } from 'react';
import { useClock } from '../hooks/useClock';
import EveText from './EveText';

export default memo(function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  return (
    <div id="crest-header">
      {/* Nav tabs — left, stretch full height */}
      <div className="nav-bar">
        {['CREST', 'CALCULATOR', 'BP FINDER', 'CRAFT LOG', 'CHARACTERS'].map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => onTabChange(tab)}
          >
            <EveText text={tab} scramble={false} wave={false} />
          </button>
        ))}
      </div>
      {/* Right controls: ONLINE → clock → SCAN */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingRight: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 10, letterSpacing: 1, color: online ? undefined : '#ff4444' }}>
            <span className={`dot ${online ? 'dot-green' : 'dot-red'} eve-dot-pulse`} />
            <EveText text={online ? 'ONLINE' : 'OFFLINE'} scramble={true} steps={8} speed={40} />
          </div>
          <div className="clock-text" style={{ color: 'var(--text)' }}>
            <EveText text={clock} scramble={false} wave={false} />
          </div>
        </div>
        <button
          className={`header-scan-btn${refreshing ? ' header-scan-btn--active' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          title="Re-fetch Jita market prices and recalculate all blueprint profits"
        >
          <span className="scan-labels">
            <span className={`scan-label-main${refreshing ? ' scan-label-shimmer' : ''}`}>REFRESH MARKET</span>
            <span className="scan-label-sub">
              {refreshing ? 'FETCHING JITA PRICES…' : 'JITA · ALL BPS'}
            </span>
          </span>
        </button>
      </div>
      {/* Accent line that builds from center on load */}
      <div className="eve-header-line" />
    </div>
  );
});
