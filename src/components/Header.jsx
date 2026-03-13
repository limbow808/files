import { useClock } from '../hooks/useClock';

export default function Header({ online, activeTab, onTabChange }) {
  const clock = useClock();
  return (
    <div>
      <div id="crest-header">
        <div>
          <div className="logo-text">CREST</div>
          <div className="logo-sub">CAPSULEER RESOURCE &amp; ECONOMIC STRATEGY TOOL</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div className="clock-text" style={{ color: 'var(--text)' }}>{clock}</div>
          <div style={{ fontSize: 11, letterSpacing: 1 }}>
            <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} />
            {online ? 'ONLINE' : 'OFFLINE'}
          </div>
        </div>
      </div>
      <div className="nav-bar">
        {['OVERVIEW', 'CALCULATOR'].map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => onTabChange(tab)}
          >{tab}</button>
        ))}
      </div>
    </div>
  );
}
