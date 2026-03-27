import { memo, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import CargoTimelinePanel from '../components/CargoTimelinePanel';
import { LoadingState } from '../components/ui';
import { fmtISK } from '../utils/fmt';
import { API } from '../App';
import { DEFAULT_APP_SETTINGS, facilityToPlannerStructureType } from '../utils/appSettings';

export default memo(function HaulPlannerPage({ appSettings = DEFAULT_APP_SETTINGS }) {
  const [goal, setGoal] = useState('balanced');
  const [hub, setHub] = useState('Jita');
  const [minValue, setMinValue] = useState('1000000');
  const plannerStructureType = facilityToPlannerStructureType(appSettings?.facility);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      goal,
      hub,
      limit: '30',
      min_total_value: minValue || '0',
    });
    return `${API}/api/haul/sell-recommendations?${params.toString()}`;
  }, [goal, hub, minValue]);

  const plannerQuery = useMemo(() => {
    const params = new URLSearchParams({
      cycle_duration_hours: appSettings?.cycle_duration_hours,
      structure_job_time_bonus_pct: appSettings?.structureJobTimeBonusPct ?? 0,
      min_profit_per_cycle: appSettings?.min_profit_per_cycle,
      include_below_threshold_items: appSettings?.include_below_threshold_items ? 'true' : 'false',
      max_sell_days_tolerance: appSettings?.max_sell_days_tolerance,
      target_isk_per_m3: appSettings?.target_isk_per_m3 ?? 0,
      weight_by_velocity: appSettings?.weight_by_velocity ? 'true' : 'false',
      count_corp_original_blueprints_as_own: appSettings?.count_corp_original_blueprints_as_own ? 'true' : 'false',
      system: appSettings?.system || 'Korsiki',
      facility: appSettings?.facility || 'large',
      structure_type: plannerStructureType || 'engineering_complex',
      rig_1: appSettings?.rig_1 || 'none',
      rig_2: appSettings?.rig_2 || 'none',
    });
    if (appSettings?.facilityTaxRate !== '') params.set('facility_tax_rate', String(parseFloat(appSettings.facilityTaxRate) / 100));
    if (appSettings?.rigBonusMfg !== '') params.set('rig_bonus_mfg', String(appSettings.rigBonusMfg));
    return `${API}/api/job-planner?${params.toString()}`;
  }, [appSettings, plannerStructureType]);

  const { data, loading, error, stale, refetch } = useApi(query, [query]);
  const { data: plannerData } = useApi(plannerQuery, [plannerQuery]);

  const items = data?.items || [];
  const summary = data?.summary || {};
  const hubs = data?.hubs || ['Jita', 'Amarr', 'Dodixie', 'Rens', 'Hek'];
  const plannerItems = plannerData?.items || [];
  const plannerSciItems = plannerItems.filter(item => ['copy_first', 'copy_then_invent', 'invent_first'].includes(item.action_type));
  const plannerMfgItems = plannerItems.filter(item => item.action_type === 'manufacture');

  return (
    <div className="calc-page" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-hdr" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          SMART SELL LISTINGS
        </span>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          GOAL
          <select
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            style={controlStyle}
          >
            <option value="fast">FAST</option>
            <option value="balanced">BALANCED</option>
            <option value="max">MAX ISK</option>
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          SELL HUB
          <select
            value={hub}
            onChange={(e) => setHub(e.target.value)}
            style={controlStyle}
          >
            {hubs.map((option) => (
              <option key={option} value={option}>{option.toUpperCase()}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          MIN VALUE
          <input
            type="number"
            min="0"
            step="100000"
            value={minValue}
            onChange={(e) => setMinValue(e.target.value)}
            style={{ ...controlStyle, width: 110 }}
          />
        </label>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: stale ? 'var(--accent)' : 'var(--dim)', letterSpacing: 1 }}>
            {stale ? 'REFRESHING' : `${summary.item_count || 0} ITEMS`}
          </span>
          <button
            onClick={refetch}
            disabled={loading}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: 1,
              padding: '3px 10px',
              cursor: loading ? 'default' : 'pointer',
            }}
          >
            {loading ? 'REFRESHING' : 'REFRESH'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, rgba(255,71,0,0.08), rgba(255,71,0,0))' }}>
        <MetricCard label="TARGET GROSS" value={fmtISK(summary.total_recommended_value)} tone="var(--accent)" />
        <MetricCard label="NET AFTER FEES" value={fmtISK(summary.total_net_after_fees)} tone="var(--green)" />
        <MetricCard label="ITEMS WITH BETTER HUB" value={`${summary.items_with_better_hub || 0}`} tone="var(--blue)" />
        <MetricCard label="UNITS" value={new Intl.NumberFormat('en-US').format(summary.total_units || 0)} tone="var(--text)" />
      </div>

      <CargoTimelinePanel
        cycleHours={appSettings?.cycle_duration_hours}
        mfgItems={plannerMfgItems}
        sciItems={plannerSciItems}
        haulCapacityM3={appSettings?.haul_capacity_m3}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {loading && !data ? (
          <LoadingState label="ANALYZING SELL OPTIONS" sub="ASSETS · ORDERS · HUBS" />
        ) : error ? (
          <div style={{ padding: '24px 16px', color: 'var(--error)', fontSize: 11, letterSpacing: 1 }}>
            SELL RECOMMENDATIONS UNAVAILABLE
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
            NO SELL CANDIDATES MATCH THE CURRENT FILTERS
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'var(--table-row-bg)' }}>
                <th style={{ width: '30%', textAlign: 'left' }}>ITEM</th>
                <th style={{ width: '8%' }}>QTY</th>
                <th style={{ width: '12%' }}>LIST</th>
                <th style={{ width: '12%' }}>NET</th>
                <th style={{ width: '10%' }}>ETA</th>
                <th style={{ width: '14%' }}>MARKET</th>
                <th style={{ width: '14%', paddingRight: 14 }}>BETTER ELSEWHERE</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const betterHub = item.better_hub;
                const bestTone = betterHub ? 'var(--blue)' : 'var(--dim)';
                const etaColor = item.estimated_days_to_sell == null
                  ? 'var(--dim)'
                  : item.estimated_days_to_sell <= 2
                    ? 'var(--green)'
                    : item.estimated_days_to_sell >= 10
                      ? 'var(--accent)'
                      : 'var(--text)';

                return (
                  <tr key={item.type_id} className="eve-row-reveal" style={{ animationDelay: `${idx * 18}ms` }}>
                    <td style={{ padding: '8px 10px', textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <img
                          src={`https://images.evetech.net/types/${item.type_id}/icon?size=32`}
                          alt=""
                          style={{ width: 22, height: 22, flexShrink: 0, opacity: 0.85 }}
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, letterSpacing: 0.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.name}>
                            {item.name}
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 3, fontSize: 9, color: 'var(--dim)', letterSpacing: 0.5, flexWrap: 'wrap' }}>
                            <span>{item.selected_hub.toUpperCase()}</span>
                            <span>{item.goal.toUpperCase()}</span>
                            {item.existing_listed_qty > 0 && <span>{item.existing_listed_qty} ALREADY LISTED</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{new Intl.NumberFormat('en-US').format(item.quantity)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>
                      <div>{fmtISK(item.recommended_price)}</div>
                      <div style={{ fontSize: 9, color: 'var(--dim)', marginTop: 2 }}>
                        floor {fmtISK(item.price_floor)}
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>
                      <div>{fmtISK(item.total_net_after_fees)}</div>
                      <div style={{ fontSize: 9, color: 'var(--dim)', marginTop: 2 }}>
                        {fmtISK(item.net_after_fees_per_unit)}/unit
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: etaColor }}>
                      {item.estimated_days_to_sell != null ? `${item.estimated_days_to_sell.toFixed(1)}d` : '—'}
                    </td>
                    <td style={{ fontSize: 10, lineHeight: 1.4 }}>
                      <div style={{ color: 'var(--text)' }}>
                        best {fmtISK(item.selected_hub_best_sell)}
                      </div>
                      <div style={{ color: 'var(--dim)' }}>
                        {item.selected_hub_order_count || 0} listings · vol {item.daily_volume != null ? fmtISK(item.daily_volume).replace(/\.0$/, '') : '—'}/day
                      </div>
                    </td>
                    <td style={{ paddingRight: 14, fontSize: 10, lineHeight: 1.4, color: bestTone }}>
                      {betterHub ? (
                        <>
                          <div>{betterHub.hub.toUpperCase()} {fmtISK(betterHub.best_sell)}</div>
                          <div style={{ color: 'var(--dim)' }}>+{fmtISK(betterHub.delta_total)} total</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--dim)' }}>CURRENT HUB IS FINE</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});

function MetricCard({ label, value, tone }) {
  return (
    <div style={{ border: '1px solid var(--border)', background: 'rgba(18,18,18,0.95)', padding: '10px 12px' }}>
      <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--dim)', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 18, letterSpacing: 0.5, color: tone }}>{value || '—'}</div>
    </div>
  );
}

const controlStyle = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: 1,
  padding: '3px 8px',
  outline: 'none',
};
