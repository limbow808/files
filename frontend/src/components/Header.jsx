import { memo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useClock } from '../hooks/useClock';
import EveText from './EveText';
import logoSrc from '../../images/logo/logo.png';

const DROPDOWN_OPEN_WIDTH = 180;

// Maps each tab ID to its top-level nav group
const TAB_GROUP = {
  QUEUE_PLANNER:     'INDUSTRY',
  MANUFACTURING:     'INDUSTRY',
  RESEARCH:          'INDUSTRY',
  INVENTION:         'INDUSTRY',
  BLUEPRINTS:        'INDUSTRY',
  REVENUE:           'MARKET',
  ORDERS:            'MARKET',
  MINERAL_PRICES:    'MARKET',
  HAUL_PLANNER:      'LOGISTICS',
  INVENTORY:         'LOGISTICS',
  APP_SETTINGS:      'SETTINGS',
  CHARACTERS:        'SETTINGS',
  MESSAGES:          'SETTINGS',
};

const DROPDOWNS = {
  INDUSTRY: [
    {
      title: 'Planning',
      items: [
        { id: 'QUEUE_PLANNER',  label: 'Job Planner'  },
      ],
    },
    {
      title: 'Calculators',
      items: [
        { id: 'MANUFACTURING', label: 'Manufacturing' },
        { id: 'RESEARCH',      label: 'Research'      },
        { id: 'INVENTION',     label: 'Invention'     },
      ],
    },
    {
      title: 'Blueprints',
      items: [
        { id: 'BLUEPRINTS', label: 'Blueprints' },
      ],
    },
  ],
  MARKET: [
    {
      title: 'Performance',
      items: [
        { id: 'REVENUE', label: 'Revenue' },
        { id: 'ORDERS',  label: 'Orders'  },
      ],
    },
    {
      title: 'Inputs',
      items: [
        { id: 'MINERAL_PRICES', label: 'Mineral Prices' },
      ],
    },
  ],
  LOGISTICS: [
    {
      title: 'Routing',
      items: [
        { id: 'HAUL_PLANNER', label: 'Haul Planner' },
      ],
    },
    {
      title: 'Storage',
      items: [
        { id: 'INVENTORY', label: 'Inventory' },
      ],
    },
  ],
  SETTINGS: [
    {
      title: 'Configuration',
      items: [
        { id: 'APP_SETTINGS', label: 'App Settings' },
      ],
    },
    {
      title: 'Profiles',
      items: [
        { id: 'CHARACTERS', label: 'Characters' },
      ],
    },
    {
      title: 'Messages',
      items: [
        { id: 'MESSAGES', label: 'Messages' },
      ],
    },
  ],
};

function NavTabContent({ text, indicatorKey }) {
  return (
    <span className="nav-tab__content">
      <span key={indicatorKey} className="nav-tab__indicator" aria-hidden="true" />
      <span className="nav-tab__label">
        <EveText text={text} scramble={false} wave={false} />
      </span>
    </span>
  );
}

function NavDropdown({ group, activeTab, onTabChange, openGroup, closingGroup, onEnter, onLeave }) {
  const sections = DROPDOWNS[group];
  const firstItemId = sections[0]?.items?.[0]?.id;
  const isActive = TAB_GROUP[activeTab] === group;
  const isOpen   = openGroup === group;
  const isClosing = closingGroup === group;
  const activeItemLabel = sections
    .flatMap(section => section.items)
    .find(item => item.id === activeTab)?.label;
  const buttonText = activeItemLabel ?? group;
  const sizerRef = useRef(null);
  const [closedWidth, setClosedWidth] = useState(null);
  const openWidth = Math.max(DROPDOWN_OPEN_WIDTH, closedWidth ?? 0);
  const targetWidth = isOpen || isClosing ? openWidth : closedWidth;

  useLayoutEffect(() => {
    if (!sizerRef.current) {
      return;
    }

    setClosedWidth(Math.ceil(sizerRef.current.getBoundingClientRect().width));
  }, [buttonText]);

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
        <NavTabContent text={buttonText} />
      </button>
      <button
        className={`nav-tab nav-tab--dropdown${isActive ? ' active' : ''}`}
        style={{ fontSize: 16, fontWeight: 400, letterSpacing: 0, width: '100%' }}
        onClick={() => firstItemId && onTabChange(firstItemId)}
      >
        <NavTabContent text={buttonText} indicatorKey={buttonText} />
      </button>
      <div className="nav-dropdown-menu">
        {sections.map(({ title, items }) => (
          <div className="nav-dropdown-section" key={title}>
            <div className="nav-dropdown-section-head">
              <span className="nav-dropdown-section-title">{title}</span>
              <span className="nav-dropdown-section-divider" aria-hidden="true" />
            </div>
            {items.map(({ id, label }) => (
              <button
                key={id}
                className={`nav-dropdown-item${activeTab === id ? ' active' : ''}`}
                onClick={() => onTabChange(id)}
              >
                {label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(function Header({ online, activeTab, onTabChange, onRefresh, refreshing, lastRefreshAt }) {
  const clock = useClock();
  const [now, setNow] = useState(Date.now());
  const [openGroup, setOpenGroup]     = useState(null);
  const [closingGroup, setClosingGroup] = useState(null);
  const closeTimer = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const minutesAgo = lastRefreshAt ? Math.max(0, Math.floor((now - lastRefreshAt) / 60000)) : null;

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
    <div id="crest-header">

      {/* Logo row */}
      <div className="header-logo-row">
        <button
          className={`header-logo-btn${activeTab === 'OVERVIEW' ? ' active' : ''}`}
          onClick={() => onTabChange('OVERVIEW')}
          title="Overview"
        >
          <img src={logoSrc} alt="CREST" className="header-logo-img" />
        </button>
      </div>

      {/* Nav / subheader row */}
      <div className="header-nav-row">

        {/* Left: status dot + refresh */}
        <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 14, gap: 8 }}>
          <span className={`dot ${online ? 'dot-green' : 'dot-red'} eve-dot-pulse`} />
          <button
            className={`header-scan-btn${refreshing ? ' header-scan-btn--active' : ''}`}
            onClick={onRefresh}
            disabled={refreshing}
            style={{ padding: '0 10px', letterSpacing: 0, fontSize: 11, fontWeight: 300 }}
            title="Re-fetch Jita market prices and recalculate all blueprint profits"
          >
            <span className={`scan-label-main${refreshing ? ' scan-label-shimmer' : ''}`}>
              {refreshing ? 'FETCHING…' : 'REFRESH MARKET'}
            </span>
          </button>
          {minutesAgo !== null && (
            <span className="header-refresh-age">{minutesAgo} min ago</span>
          )}
        </div>

        {/* Center: Nav */}
        <div className="nav-bar">
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

        {/* Right: EVE clock */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', paddingRight: 14, gap: 10 }}>
          <div className="clock-text" style={{ color: 'var(--text2)', fontSize: 11, letterSpacing: 1.5, fontWeight: 300 }}>
            <EveText text={clock} scramble={false} wave={false} />
          </div>
        </div>

        {/* Accent line — 2nd grid row, spans all columns */}
        <div className="eve-header-line" style={{ gridColumn: '1 / -1', gridRow: 2 }} />
      </div>
    </div>
  );
});
