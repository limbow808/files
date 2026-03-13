import { useClock } from '../hooks/useClock';

export default function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  return (
    <div id="crest-header">
      {/* Nav tabs — left, stretch full height */}
      <div className="nav-bar">
        {['CREST', 'CALCULATOR', 'CHARACTERS'].map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => onTabChange(tab)}
          >{tab}</button>
        ))}
      </div>
      {/* Right controls: ONLINE → clock → SCAN */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 1 }}>
          <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} />
          {online ? 'ONLINE' : 'OFFLINE'}
        </div>
        <div className="clock-text" style={{ color: 'var(--text)' }}>{clock}</div>
        <button
          className="btn btn-primary"
          onClick={onRefresh}
          disabled={refreshing}
          title="Re-fetch Jita market prices and refresh all panels"
          style={{ padding: '0 18px', fontSize: 10, letterSpacing: 2, alignSelf: 'stretch', border: 'none', borderLeft: '1px solid var(--border)' }}
        >
          {refreshing ? '⟳ SCANNING…' : '⟳ SCAN'}
        </button>
      </div>
    </div>
  );
}
