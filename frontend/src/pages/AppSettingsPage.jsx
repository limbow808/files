import { memo, useEffect, useMemo, useRef } from 'react';
import { ContextCard, PageHeader, SummaryCard } from '../components/shared/PagePrimitives';
import CharactersPage from './CharactersPage';
import MessagesPage from './MessagesPage';
import AppSettingsPanel from '../components/AppSettingsModal';
import { getFacilityLabel, getHubLabel } from '../utils/appSettings';

const SECTION_IDS = {
  CHARACTERS: 'settings-characters',
  APP_SETTINGS: 'settings-app-settings',
  MESSAGES: 'settings-messages',
};

function AppSettingsSection({ appSettings, onSaveSettings, sectionId }) {
  const settings = appSettings || {};
  const facilityLabel = getFacilityLabel(settings.facility || 'large');
  const buyHubLabel = getHubLabel(settings.buyLoc || 'jita');
  const sellHubLabel = getHubLabel(settings.sellLoc || 'jita');

  return (
    <section id={sectionId} className="settings-stack-section">
      <div className="panel app-page-shell settings-page-shell">
        <PageHeader
          title="App Settings"
          subtitle="Shared industry defaults and planner behavior controls that feed the calculator, queue planner, haul planner, and related tools."
        >
          <span>Local app configuration</span>
          <span>Saved to browser storage</span>
        </PageHeader>

        <div className="app-summary-grid">
          <SummaryCard label="Manufacturing System" value={settings.system || '—'} tone="neutral" />
          <SummaryCard label="Structure" value={facilityLabel} tone="accent" />
          <SummaryCard label="Market Route" value={`${buyHubLabel} → ${sellHubLabel}`} tone="good" />
          <SummaryCard label="Planner Cycle" value={`${Number(settings.cycle_duration_hours || 0).toFixed(1)}h`} tone="neutral" />
        </div>

        <div className="app-context-grid">
          <ContextCard
            label="Industry Defaults"
            value={`${settings.system || '—'} · ${facilityLabel}`}
            meta={`${settings.facilityTaxRate || '0'}% facility tax · ${buyHubLabel} buy · ${sellHubLabel} sell`}
          />
          <ContextCard
            label="Planner Bias"
            value={`${Math.round(settings.target_isk_per_m3 || 0).toLocaleString('en-US')} ISK/m3`}
            meta={`${Math.round(settings.haul_capacity_m3 || 0).toLocaleString('en-US')} m3 haul cap · ${(Number(settings.min_profit_per_cycle || 0) / 1_000_000).toFixed(0)}M min / cycle · ${settings.max_sell_days_tolerance || 0}d sell cap`}
          />
          <ContextCard
            label="Corp Blueprint Handling"
            value={settings.count_corp_original_blueprints_as_own ? 'Count as own' : 'Copy-only access'}
            meta={settings.include_below_threshold_items ? 'Below-threshold items may backfill idle slots.' : 'Below-threshold items leave slots idle.'}
          />
        </div>

        <div className="settings-page-body">
          <AppSettingsPanel settings={appSettings} onSave={onSaveSettings} />
        </div>
      </div>
    </section>
  );
}

export default memo(function AppSettingsPage({ appSettings, onSaveSettings, activeSection = 'APP_SETTINGS', navigationRequestKey = 0 }) {
  const scrollRef = useRef(null);
  const sectionLabel = useMemo(() => {
    if (activeSection === 'CHARACTERS') return 'Characters';
    if (activeSection === 'MESSAGES') return 'Messages';
    return 'App Settings';
  }, [activeSection]);

  useEffect(() => {
    const container = scrollRef.current;
    const targetId = SECTION_IDS[activeSection] || SECTION_IDS.APP_SETTINGS;
    if (!container || !targetId) return undefined;

    const target = container.querySelector(`#${targetId}`);
    if (!target) return undefined;

    const frame = window.requestAnimationFrame(() => {
      const top = Math.max(0, target.offsetTop - 14);
      container.scrollTo({ top, behavior: 'smooth' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, navigationRequestKey]);

  return (
    <div className="calc-page">
      <div className="panel app-page-shell settings-unified-shell">
        <PageHeader
          title="Settings"
          subtitle="Characters, app defaults, and messaging automation now live on one scrollable surface."
        >
          <span>{sectionLabel}</span>
          <span>Dropdown jumps to section</span>
        </PageHeader>

        <div className="app-context-grid">
          <ContextCard
            label="Section Order"
            value="CHARACTERS → APP SETTINGS → MESSAGES"
            meta="The Settings dropdown entries keep their own targets, but they now scroll within one page instead of switching to separate screens."
          />
          <ContextCard
            label="Current Target"
            value={sectionLabel.toUpperCase()}
            meta="Selecting a Settings dropdown item scrolls this page to the matching section."
          />
          <ContextCard
            label="Persistence"
            value="Single mounted surface"
            meta="Character auth state, unsaved settings edits, and message status remain visible while you move between sections."
          />
        </div>

        <div ref={scrollRef} className="settings-scroll-surface">
          <CharactersPage embedded sectionId={SECTION_IDS.CHARACTERS} />
          <AppSettingsSection appSettings={appSettings} onSaveSettings={onSaveSettings} sectionId={SECTION_IDS.APP_SETTINGS} />
          <MessagesPage embedded sectionId={SECTION_IDS.MESSAGES} />
        </div>
      </div>
    </div>
  );
});