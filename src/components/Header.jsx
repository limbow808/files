import { memo, useState, useRef, useCallback } from 'react';
import { useClock } from '../hooks/useClock';
import EveText from './EveText';

// Maps each tab ID to its top-level nav group
const TAB_GROUP = {
  OVERVIEW:          'OVERVIEW',
  QUEUE_PLANNER:     'INDUSTRY',
  TOP_PERFORMERS:    'INDUSTRY',
  MANUFACTURING:     'INDUSTRY',
  RESEARCH:          'INDUSTRY',
  INVENTION:         'INDUSTRY',
  BLUEPRINTS:        'INDUSTRY',
  CONTRACT_SCANNER:  'INDUSTRY',
  REVENUE:           'MARKET',
  ORDERS:            'MARKET',
  MINERAL_PRICES:    'MARKET',
  HAUL_PLANNER:      'LOGISTICS',
  INVENTORY:         'LOGISTICS',
  CHARACTERS:        'SETTINGS',
  MESSAGES:          'SETTINGS',
};

const DROPDOWNS = {
  INDUSTRY: [
    { id: 'QUEUE_PLANNER',    label: 'Queue Planner'    },
    { id: 'TOP_PERFORMERS',   label: 'Top Performers'   },
    { id: 'MANUFACTURING',    label: 'Manufacturing'    },
    { id: 'RESEARCH',         label: 'Research'         },
    { id: 'INVENTION',        label: 'Invention'        },
    { id: 'BLUEPRINTS',       label: 'Blueprints'       },
    { id: 'CONTRACT_SCANNER', label: 'Contract Scanner' },
  ],
  MARKET: [
    { id: 'REVENUE',        label: 'Revenue'        },
    { id: 'ORDERS',         label: 'Orders'         },
    { id: 'MINERAL_PRICES', label: 'Mineral Prices' },
  ],
  LOGISTICS: [
    { id: 'HAUL_PLANNER', label: 'Haul Planner' },
    { id: 'INVENTORY',    label: 'Inventory'    },
  ],
  SETTINGS: [
    { id: 'CHARACTERS', label: 'Characters' },
    { id: 'MESSAGES',   label: 'Messages'   },
  ],
};

function NavDropdown({ group, activeTab, onTabChange }) {
  const items       = DROPDOWNS[group];
  const isActive    = TAB_GROUP[activeTab] === group;
  const closeTimer  = useRef(null);
  const [open, setOpen] = useState(false);

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }, []);

  return (
    <div
      className="nav-dropdown"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        className={`nav-tab${isActive ? ' active' : ''}`}
        style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0 }}
        onClick={() => setOpen(o => !o)}
      >
        <EveText text={group} scramble={false} wave={false} />
        <span style={{ marginLeft: 5, fontSize: 8, opacity: 0.6, verticalAlign: 'middle' }}>{'\u25BC'}</span>
      </button>
      {open && (
        <div className="nav-dropdown-menu">
          {items.map(({ id, label }) => (
            <button
              key={id}
              className={`nav-dropdown-item${activeTab === id ? ' active' : ''}`}
              onClick={() => { onTabChange(id); setOpen(false); }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  return (
    <div id="crest-header" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'stretch' }}>

      {/* Left: EVE clock */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 14 }}>
        <div className="clock-text" style={{ color: 'var(--text2)', fontSize: 11, letterSpacing: 1.5, fontWeight: 300 }}>
          <EveText text={clock} scramble={false} wave={false} />
        </div>
      </div>

      {/* Center: Nav */}
      <div className="nav-bar">
        {/* Overview — direct link */}
        <button
          className={`nav-tab${activeTab === 'OVERVIEW' ? ' active' : ''}`}
          onClick={() => onTabChange('OVERVIEW')}
          style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0 }}
        >
          <EveText text="OVERVIEW" scramble={false} wave={false} />
        </button>

        {/* Dropdown menus */}
        {['INDUSTRY', 'MARKET', 'LOGISTICS', 'SETTINGS'].map(group => (
          <NavDropdown
            key={group}
            group={group}
            activeTab={activeTab}
            onTabChange={onTabChange}
          />
        ))}
      </div>

      {/* Right: status dot + refresh */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 14, gap: 2 }}>
        <span className={`dot ${online ? 'dot-green' : 'dot-red'} eve-dot-pulse`} />
        <button
          className={`header-scan-btn${refreshing ? ' header-scan-btn--active' : ''}`}
          onClick={onRefresh}
          disabled={refreshing}
          style={{ padding: '0 10px', letterSpacing: 0, fontSize: 11, fontWeight: 300 }}
          title="Re-fetch Jita market prices and recalculate all blueprint profits"
        >
          <span className={`scan-label-main${refreshing ? ' scan-label-shimmer' : ''}`}>
            {refreshing ? 'FETCHING\u2026' : 'REFRESH MARKET'}
          </span>
        </button>
      </div>

      {/* Accent line */}
      <div className="eve-header-line" style={{ gridColumn: '1 / -1' }} />
    </div>
  );
});
