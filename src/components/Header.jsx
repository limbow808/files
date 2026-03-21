import { memo } from 'react';
import { useClock } from '../hooks/useClock';
import EveText from './EveText';

const SETTINGS_TABS = ['CHARACTERS', 'MESSAGES'];

export default memo(function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  const settingsActive = SETTINGS_TABS.includes(activeTab);
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
        {['OVERVIEW', 'CALCULATOR', 'BP FINDER', 'REVENUE'].map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => onTabChange(tab)}
            style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0 }}
          >
            <EveText text={tab} scramble={false} wave={false} />
          </button>
        ))}
        {/* SETTINGS dropdown */}
        <div className="settings-nav">
          <button
            className={`nav-tab${settingsActive ? ' active' : ''}`}
            style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0 }}
          >
            <EveText text="SETTINGS" scramble={false} wave={false} />
          </button>
          <div className="settings-dropdown">
            {SETTINGS_TABS.map(tab => (
              <button
                key={tab}
                className={`settings-item${activeTab === tab ? ' active' : ''}`}
                onClick={() => onTabChange(tab)}
              >
                <EveText text={tab} scramble={false} wave={false} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right: status dot + REFRESH MARKET */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 14, gap: 2 }}>
        <span className={`dot ${online ? 'dot-green' : 'dot-red'} eve-dot-pulse`} />
        <button
          className={`header-scan-btn${refreshing ? ' header-scan-btn--active' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          style={{ padding: '0 10px' , letterSpacing: 0, fontSize: 11, fontWeight: 300}}
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
