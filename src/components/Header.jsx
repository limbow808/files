import { useClock } from '../hooks/useClock';

export default function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  return (
    <div id="crest-header">
      {/* Nav tabs — left, stretch full height */}
      <div className="nav-bar">
        {['OVERVIEW', 'CALCULATOR'].map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => onTabChange(tab)}
          >{tab}</button>
        ))}
      </div>
      {/* Logo — absolutely centered */}
      <div className="logo-text header-logo-center">CREST</div>
      {/* Right controls: SCAN → ONLINE → clock */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button
          className="btn btn-primary"
          onClick={onRefresh}
          disabled={refreshing}
          style={{ padding: '0 14px', fontSize: 10, letterSpacing: 2, alignSelf: 'stretch', border: 'none', borderLeft: '1px solid var(--border)' }}
        >
          {refreshing ? 'SCANNING…' : 'SCAN'}
        </button>
        <div style={{ fontSize: 10, letterSpacing: 1 }}>
          <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} />
          {online ? 'ONLINE' : 'OFFLINE'}
        </div>
        <div className="clock-text" style={{ color: 'var(--text)' }}>{clock}</div>
      </div>
    </div>
  );
}
