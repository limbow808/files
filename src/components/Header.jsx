import { memo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useClock } from '../hooks/useClock';
import EveText from './EveText';

const DROPDOWN_OPEN_WIDTH = 180;

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

function NavTabContent({ text }) {
  return (
    <span className="nav-tab__content">
      <span className="nav-tab__indicator" aria-hidden="true" />
      <span className="nav-tab__label">
        <EveText text={text} scramble={false} wave={false} />
      </span>
    </span>
  );
}

function NavDropdown({ group, activeTab, onTabChange, openGroup, closingGroup, onEnter, onLeave }) {
  const items    = DROPDOWNS[group];
  const isActive = TAB_GROUP[activeTab] === group;
  const isOpen   = openGroup === group;
  const isClosing = closingGroup === group;
  const sizerRef = useRef(null);
  const [closedWidth, setClosedWidth] = useState(null);
  const targetWidth = isOpen || isClosing ? DROPDOWN_OPEN_WIDTH : closedWidth;

  useLayoutEffect(() => {
    if (!sizerRef.current) {
      return;
    }

    setClosedWidth(Math.ceil(sizerRef.current.getBoundingClientRect().width));
  }, [group]);

  return (
    <div
      className={`nav-dropdown${isOpen ? ' nav-dropdown--open' : ''}${isClosing ? ' nav-dropdown--closing' : ''}`}
      style={targetWidth ? { width: targetWidth } : undefined}
      onMouseEnter={() => onEnter(group)}
      onMouseLeave={onLeave}
    >
      <button
        ref={sizerRef}
        className="nav-tab nav-dropdown-sizer"
        style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0 }}
        tabIndex={-1}
        aria-hidden="true"
      >
        <NavTabContent text={group} />
      </button>
      <button
        className={`nav-tab nav-tab--dropdown${isActive ? ' active' : ''}`}
        style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0, width: '100%' }}
        onClick={() => onTabChange(items[0].id)}
      >
        <NavTabContent text={group} />
      </button>
      <div className="nav-dropdown-menu">
        {items.map(({ id, label }) => (
          <button
            key={id}
            className={`nav-dropdown-item${activeTab === id ? ' active' : ''}`}
            onClick={() => { onTabChange(id); onLeave(); }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default memo(function Header({ online, activeTab, onTabChange, onRefresh, refreshing }) {
  const clock = useClock();
  const [openGroup, setOpenGroup]     = useState(null);
  const [closingGroup, setClosingGroup] = useState(null);
  const closeTimer = useRef(null);

  const handleEnter = (group) => {
    clearTimeout(closeTimer.current);
    setClosingGroup(null);
    setOpenGroup(group);
  };
  const handleLeave = () => {
    const wasOpen = openGroup;
    setOpenGroup(null);           // immediately triggers CSS close transition on menu
    setClosingGroup(wasOpen);     // keeps min-width wide during animation
    closeTimer.current = setTimeout(() => setClosingGroup(null), 50);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <div id="crest-header" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gridTemplateRows: 'auto 1px', alignItems: 'stretch' }}>

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
          <NavTabContent text="OVERVIEW" />
        </button>

        {/* Dropdown menus */}
        {['INDUSTRY', 'MARKET', 'LOGISTICS', 'SETTINGS'].map(group => (
          <NavDropdown
            key={group}
            group={group}
            activeTab={activeTab}
            onTabChange={onTabChange}
            openGroup={openGroup}
            closingGroup={closingGroup}
            onEnter={handleEnter}
            onLeave={handleLeave}
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

      {/* Accent line — explicit 2nd grid row, spans all columns */}
      <div className="eve-header-line" style={{ gridColumn: '1 / -1', gridRow: 2 }} />
    </div>
  );
});
