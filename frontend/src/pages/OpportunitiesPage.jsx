import { memo, useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { API } from '../App';
import { DEFAULT_APP_SETTINGS, facilityToPlannerStructureType } from '../utils/appSettings';
import { fmtDuration, fmtISK, fmtVol } from '../utils/fmt';

const SCIENCE_ACTIONS = new Set(['copy_first', 'copy_then_invent', 'invent_first']);

function SummaryCard({ label, value, tone = 'neutral' }) {
  return (
    <div className={`bp-investment-summary bp-investment-summary--${tone}`}>
      <div className="bp-investment-summary__value">{value}</div>
      <div className="bp-investment-summary__label">{label}</div>
    </div>
  );
}

function buildOpportunityId(item) {
  return item.rec_id || item.reason_key || `${item.output_id || item.name}-${item.action_type || item.block_kind || 'opportunity'}`;
}

function buildPlannerQuery(appSettings, plannerStructureType) {
  const params = new URLSearchParams({
    structure_type: plannerStructureType,
    cycle_duration_hours: String(appSettings?.cycle_duration_hours ?? DEFAULT_APP_SETTINGS.cycle_duration_hours),
    haul_capacity_m3: String(appSettings?.haul_capacity_m3 ?? DEFAULT_APP_SETTINGS.haul_capacity_m3),
    target_isk_per_m3: String(appSettings?.target_isk_per_m3 ?? DEFAULT_APP_SETTINGS.target_isk_per_m3),
    min_profit_per_cycle: String(appSettings?.min_profit_per_cycle ?? DEFAULT_APP_SETTINGS.min_profit_per_cycle),
    include_below_threshold_items: appSettings?.include_below_threshold_items ? 'true' : 'false',
    max_sell_days_tolerance: String(appSettings?.max_sell_days_tolerance ?? DEFAULT_APP_SETTINGS.max_sell_days_tolerance),
    count_corp_original_blueprints_as_own: appSettings?.count_corp_original_blueprints_as_own ? 'true' : 'false',
    weight_by_velocity: appSettings?.weight_by_velocity === false ? 'false' : 'true',
    system: String(appSettings?.system || DEFAULT_APP_SETTINGS.system),
    facility: String(appSettings?.facility || DEFAULT_APP_SETTINGS.facility),
  });
  if (appSettings?.facilityTaxRate !== '') params.set('facility_tax_rate', String(parseFloat(appSettings.facilityTaxRate) / 100));
  if (appSettings?.rigBonusMfg !== '') params.set('rig_bonus_mfg', String(appSettings.rigBonusMfg));
  if (appSettings?.operations_corp_id) params.set('operations_corp_id', String(appSettings.operations_corp_id));
  if (appSettings?.corp_input_division) params.set('corp_input_division', String(appSettings.corp_input_division));
  if (appSettings?.corp_output_division) params.set('corp_output_division', String(appSettings.corp_output_division));
  return params.toString();
}

function actionLabel(item) {
  return String(item.action_type || item.block_kind || 'opportunity').replaceAll('_', ' ').toUpperCase();
}

function opportunityValue(item, blocked = false) {
  return blocked ? Number(item.estimated_profit || 0) : Number(item.profit_per_cycle || 0);
}

function DetailStat({ label, value, tone }) {
  return (
    <div className="tools-detail-stat">
      <div className="tools-detail-stat__label">{label}</div>
      <div className="tools-detail-stat__value" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

function SourceCard({ label, source }) {
  if (!source) return null;
  const sourceValue = source.mode === 'corp'
    ? `${source.corporation_name || 'Corp'}${source.division_flag ? ` · ${source.division_flag}` : ''}`
    : 'Personal / Legacy';
  return (
    <div className="tools-source-card">
      <div className="tools-source-card__label">{label}</div>
      <div className="tools-source-card__value">{sourceValue}</div>
      {source.warning && <div className="tools-source-card__warning">{source.warning}</div>}
    </div>
  );
}

function OpportunityCard({ item, blocked = false, tone = 'neutral', active = false, onSelect }) {
  const value = opportunityValue(item, blocked);
  return (
    <button
      type="button"
      className={`opportunity-card opportunity-card--${tone}${active ? ' opportunity-card--active' : ''}`}
      onClick={() => onSelect(buildOpportunityId(item))}
    >
      <div className="opportunity-card__head">
        <div className="opportunity-card__title-wrap">
          {item.output_id ? (
            <img
              className="opportunity-card__icon"
              src={`https://images.evetech.net/types/${item.output_id}/icon?size=32`}
              alt=""
              onError={(event) => { event.target.style.display = 'none'; }}
            />
          ) : null}
          <div>
            <div className="opportunity-card__title">{item.name}</div>
            <div className="opportunity-card__meta">{actionLabel(item)}{blocked && item.block_kind ? ` · ${String(item.block_kind).toUpperCase()}` : ''}</div>
          </div>
        </div>
        <div className="opportunity-card__value" style={{ color: value >= 0 ? 'var(--green)' : 'var(--accent)' }}>
          {fmtISK(value)}
        </div>
      </div>
      <div className="opportunity-card__body">{item.unlock_path || item.why || item.reason || 'No rationale provided.'}</div>
      <div className="opportunity-card__foot">
        {!blocked && <span>{fmtVol(item.avg_daily_volume)} / day</span>}
        {!blocked && <span>{typeof item.days_to_sell === 'number' ? `${item.days_to_sell.toFixed(1)}d to sell` : '—'}</span>}
        {blocked && <span>{item.reason || 'Missing requirement'}</span>}
      </div>
    </button>
  );
}

export default memo(function OpportunitiesPage({ appSettings = DEFAULT_APP_SETTINGS }) {
  const plannerStructureType = facilityToPlannerStructureType(appSettings?.facility);
  const query = useMemo(
    () => `${API}/api/tools/opportunities?${buildPlannerQuery(appSettings, plannerStructureType)}`,
    [appSettings, plannerStructureType],
  );
  const { data, loading, error, stale, refetch } = useApi(query, [query]);
  const [selectedId, setSelectedId] = useState(null);

  const availableItems = useMemo(
    () => (data?.items || []).filter((item) => !item.is_idle),
    [data?.items],
  );
  const blockedItems = data?.blocked_items || [];
  const availableManufacturing = useMemo(
    () => availableItems.filter((item) => item.action_type === 'manufacture'),
    [availableItems],
  );
  const availableScience = useMemo(
    () => availableItems.filter((item) => SCIENCE_ACTIONS.has(item.action_type)),
    [availableItems],
  );
  const blockedSkills = useMemo(
    () => blockedItems.filter((item) => item.block_kind === 'skills'),
    [blockedItems],
  );
  const blockedAccess = useMemo(
    () => blockedItems.filter((item) => item.block_kind !== 'skills'),
    [blockedItems],
  );

  const groups = useMemo(() => [
    { key: 'ready-mfg', title: 'Ready Now · Manufacturing', tone: 'good', blocked: false, items: availableManufacturing },
    { key: 'ready-sci', title: 'Ready Now · Science', tone: 'accent', blocked: false, items: availableScience },
    { key: 'blocked-skill', title: 'Locked · Skills', tone: 'warn', blocked: true, items: blockedSkills },
    { key: 'blocked-access', title: 'Locked · Access & Logistics', tone: 'neutral', blocked: true, items: blockedAccess },
  ].filter((group) => group.items.length), [availableManufacturing, availableScience, blockedSkills, blockedAccess]);

  const flattened = useMemo(
    () => groups.flatMap((group) => group.items.map((item) => ({ ...item, __group: group.key, __blocked: group.blocked, __tone: group.tone }))),
    [groups],
  );

  useEffect(() => {
    if (!flattened.length) {
      setSelectedId(null);
      return;
    }
    if (!flattened.some((item) => buildOpportunityId(item) === selectedId)) {
      setSelectedId(buildOpportunityId(flattened[0]));
    }
  }, [flattened, selectedId]);

  const selected = flattened.find((item) => buildOpportunityId(item) === selectedId) || null;
  const lockedUpside = blockedItems.reduce((sum, item) => sum + Number(item.estimated_profit || 0), 0);

  return (
    <div className="calc-page">
      <div className="panel tools-shell">
        <div className="panel-hdr bp-investment-header">
          <div>
            <div className="panel-title">Opportunities</div>
            <div className="bp-investment-subtitle">
              Immediate queue candidates and blocked upside pulled out of the planner into a dedicated tools surface.
            </div>
          </div>
          <div className="tools-header-meta">
            <span>{stale ? 'Refreshing planner intelligence…' : 'Planner intelligence feed'}</span>
            <button type="button" className="header-scan-btn" onClick={refetch}>Refresh</button>
          </div>
        </div>

        <div className="bp-investment-summary-grid">
          <SummaryCard label="Ready Now" value={availableItems.length.toLocaleString()} tone="good" />
          <SummaryCard label="Locked Upside" value={fmtISK(lockedUpside)} tone="accent" />
          <SummaryCard label="Manufacturing Queue" value={availableManufacturing.length.toLocaleString()} tone="neutral" />
          <SummaryCard label="Science Queue" value={availableScience.length.toLocaleString()} tone="neutral" />
        </div>

        <div className="tools-source-grid">
          <SourceCard label="Inventory Source" source={data?.inventory_source} />
          <SourceCard label="Wallet Source" source={data?.wallet_source} />
          <div className="tools-source-card">
            <div className="tools-source-card__label">Planner Context</div>
            <div className="tools-source-card__value">
              {`${String(data?.structure_name || 'Structure').toUpperCase()} · ${data?.cycle_config?.cycle_duration_hours || appSettings?.cycle_duration_hours || DEFAULT_APP_SETTINGS.cycle_duration_hours}H CYCLE`}
            </div>
            <div className="tools-source-card__warning">
              {loading ? 'Loading recommendations…' : error ? 'Planner feed unavailable.' : `${blockedItems.length} blocked opportunities · ${availableItems.length} actionable items`}
            </div>
          </div>
        </div>

        {loading && !data && (
          <div className="loading-state">
            <div className="loading-label">Loading opportunities</div>
            <div className="loading-sub">Pulling the current planner recommendation set into Tools.</div>
          </div>
        )}

        {error && !data && (
          <div className="error-banner">
            <span>Tools opportunities feed unavailable.</span> Check that the backend is running and planner data can be calculated.
          </div>
        )}

        {!loading && !error && !flattened.length && (
          <div className="loading-state">
            <div className="loading-label">No opportunities surfaced</div>
            <div className="loading-sub">The planner did not return ready or blocked candidates for the current settings.</div>
          </div>
        )}

        {!!flattened.length && (
          <div className="opportunities-layout">
            <div className="opportunities-groups">
              {groups.map((group) => (
                <section key={group.key} className="opportunity-group">
                  <div className="opportunity-group__head">
                    <span>{group.title}</span>
                    <span>{group.items.length}</span>
                  </div>
                  <div className="opportunity-group__list">
                    {group.items.map((item) => (
                      <OpportunityCard
                        key={buildOpportunityId(item)}
                        item={item}
                        blocked={group.blocked}
                        tone={group.tone}
                        active={buildOpportunityId(item) === selectedId}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <aside className="tools-detail-panel">
              {selected ? (
                <>
                  <div className="tools-detail-head">
                    <div>
                      <div className="tools-detail-title">{selected.name}</div>
                      <div className="tools-detail-subtitle">{actionLabel(selected)}{selected.__blocked ? ' · blocked upside' : ' · immediately actionable'}</div>
                    </div>
                    <div className={`prognosis-badge prognosis-badge--${selected.__tone}`}>
                      {selected.__blocked ? 'Locked' : 'Ready'}
                    </div>
                  </div>

                  <div className="tools-detail-copy">
                    {selected.unlock_path || selected.why || selected.reason || 'No additional explanation is available for this opportunity.'}
                  </div>

                  <div className="tools-detail-grid">
                    <DetailStat label={selected.__blocked ? 'Estimated Upside' : 'Profit / Cycle'} value={fmtISK(opportunityValue(selected, selected.__blocked))} tone={opportunityValue(selected, selected.__blocked) >= 0 ? 'var(--green)' : 'var(--accent)'} />
                    <DetailStat label="Demand" value={selected.__blocked ? '—' : fmtVol(selected.avg_daily_volume)} />
                    <DetailStat label="Sell Through" value={typeof selected.days_to_sell === 'number' ? `${selected.days_to_sell.toFixed(1)}d` : '—'} />
                    <DetailStat label="Duration" value={fmtDuration(selected.duration)} />
                    <DetailStat label="Assigned" value={selected.assigned_character?.character_name || 'Unassigned'} />
                    <DetailStat label="Capital Share" value={typeof selected.capital_share_pct === 'number' ? `${selected.capital_share_pct.toFixed(1)}%` : '—'} tone={selected.capital_warning ? 'var(--accent)' : undefined} />
                  </div>

                  <div className="tools-source-card" style={{ marginTop: 14 }}>
                    <div className="tools-source-card__label">Queue rationale</div>
                    <div className="tools-source-card__value">{selected.why || selected.reason || 'Planner rationale unavailable.'}</div>
                    {Array.isArray(selected.characters) && selected.characters.length > 0 && (
                      <div className="tools-source-card__warning">
                        Candidate characters: {selected.characters.map((character) => character.character_name).join(', ')}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="tools-detail-empty">Select an opportunity to inspect its queue rationale and economics.</div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
});