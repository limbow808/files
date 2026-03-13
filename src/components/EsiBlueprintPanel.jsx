import { useApi } from '../hooks/useApi';
import { API } from '../App';

export default function EsiBlueprintPanel() {
  const { data, loading, error } = useApi(`${API}/api/blueprints/esi`, []);
  const bps = data?.blueprints || [];

  if (error && !data) {
    return (
      <div className="esi-bp-panel">
        <div className="panel-hdr">
          <span className="panel-title">◈ ESI Blueprint Library</span>
        </div>
        <div style={{ padding: '16px 20px', fontSize: 11, color: 'var(--dim)', letterSpacing: 1 }}>
          ESI token required — run <code style={{ color: 'var(--text)' }}>python main.py</code> to authenticate
        </div>
      </div>
    );
  }

  return (
    <div className="esi-bp-panel">
      <div className="panel-hdr">
        <span className="panel-title">◈ ESI Blueprint Library</span>
        <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
          {loading ? 'LOADING...' : `${bps.length} BLUEPRINTS`}
        </span>
      </div>
      {loading ? (
        <div style={{ padding: '12px 20px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, animation: 'pulse 1.5s infinite' }}>
          FETCHING FROM ESI...
        </div>
      ) : (
        <div className="esi-bp-list">
          {bps.map((bp, i) => (
            <div key={i} className="esi-bp-card">
              <div className="esi-bp-name">{bp.name}</div>
              <div className="esi-bp-meta">
                <span className={`esi-bp-type-${bp.bp_type.toLowerCase()}`}>{bp.bp_type}</span>
                {' · '}ME {bp.me_level}{' · '}TE {bp.te_level}
                {bp.runs !== -1 && <span style={{ color: 'var(--dim)' }}> · {bp.runs} runs</span>}
              </div>
            </div>
          ))}
          {bps.length === 0 && (
            <div style={{ padding: '16px 20px', fontSize: 11, color: 'var(--dim)', letterSpacing: 1 }}>
              No blueprints found in character assets
            </div>
          )}
        </div>
      )}
    </div>
  );
}
