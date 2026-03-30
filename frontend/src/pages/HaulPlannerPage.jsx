import { memo, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import CargoTimelinePanel from '../components/CargoTimelinePanel';
import { LoadingState } from '../components/ui';
import { fmtISK, fmtVol } from '../utils/fmt';
import { API } from '../App';
import { DEFAULT_APP_SETTINGS, facilityToPlannerStructureType } from '../utils/appSettings';

function formatCubicMeters(value) {
  if (!value || Number(value) <= 0) return '0 m3';
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Number(value))} m3`;
}

function buildCopyMultibuyText(rows, mode) {
  return rows
    .map((row) => {
      const quantity = Math.max(0, Math.ceil(Number(mode === 'delta' ? row.delta_qty : row.required_qty) || 0));
      if (!quantity) return null;
      return `${row.name} ${quantity}`;
    })
    .filter(Boolean)
    .join('\n');
}

export default memo(function HaulPlannerPage({ appSettings = DEFAULT_APP_SETTINGS, onSaveSettings }) {
  const [copiedMode, setCopiedMode] = useState('');
  const plannerStructureType = facilityToPlannerStructureType(appSettings?.facility);
  const operationsCorpId = String(appSettings?.operations_corp_id || '');
  const corpInputDivision = String(appSettings?.corp_input_division || '');
  const corpOutputDivision = String(appSettings?.corp_output_division || '');

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
    if (operationsCorpId) params.set('operations_corp_id', operationsCorpId);
    if (corpInputDivision) params.set('corp_input_division', corpInputDivision);
    if (corpOutputDivision) params.set('corp_output_division', corpOutputDivision);
    return `${API}/api/job-planner?${params.toString()}`;
  }, [appSettings, corpInputDivision, corpOutputDivision, operationsCorpId, plannerStructureType]);

  const { data: plannerData, loading, error, stale, refetch } = useApi(plannerQuery, [plannerQuery]);
  const {
    data: corpContext,
    loading: corpContextLoading,
    stale: corpContextStale,
    refetch: refetchCorpContext,
  } = useApi(`${API}/api/corp-context`, []);

  const plannerItems = plannerData?.items || [];
  const inboundRows = plannerData?.inbound_requirements?.rows || [];
  const inboundSummary = plannerData?.inbound_requirements?.summary || {};
  const plannerSciItems = plannerItems.filter(item => ['copy_first', 'copy_then_invent', 'invent_first'].includes(item.action_type));
  const plannerMfgItems = plannerItems.filter(item => item.action_type === 'manufacture');
  const plannerInventorySource = plannerData?.inventory_source || null;
  const plannerWalletSource = plannerData?.wallet_source || null;
  const corporations = corpContext?.corporations || [];
  const selectedCorp = corporations.find(corp => String(corp.corporation_id) === operationsCorpId) || null;
  const divisionOptions = selectedCorp?.available_divisions || [];
  const corpWarnings = corpContext?.warnings || [];
  const selectedOutputDivision = divisionOptions.find((division) => String(division.flag) === corpOutputDivision) || null;
  const plannerSourceCorpName = String(selectedCorp?.corporation_name || plannerInventorySource?.corporation_name || 'UNKNOWN CORP').toUpperCase();
  const plannerSourceDivision = String(
    plannerInventorySource?.division_label
    || plannerInventorySource?.division_flag
    || (corpInputDivision ? `Input ${corpInputDivision}` : 'Select Input Hangar'),
  ).toUpperCase();
  const outputSourceDivision = String(
    selectedOutputDivision?.label
    || selectedOutputDivision?.flag
    || (corpOutputDivision ? `Output ${corpOutputDivision}` : 'Select Output Hangar'),
  ).toUpperCase();
  const deltaRows = useMemo(
    () => inboundRows.filter((row) => Number(row.delta_qty || 0) > 0),
    [inboundRows],
  );
  const allRows = useMemo(
    () => inboundRows.filter((row) => Number(row.required_qty || 0) > 0),
    [inboundRows],
  );

  function updateSettings(patch) {
    onSaveSettings?.({ ...appSettings, ...patch });
  }

  async function handleCopy(mode) {
    const relevantRows = mode === 'delta' ? deltaRows : allRows;
    const text = buildCopyMultibuyText(relevantRows, mode);
    if (!text || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMode(mode);
      window.setTimeout(() => setCopiedMode(''), 1800);
    } catch {
      // Ignore clipboard failures; the page remains usable without OS clipboard access.
    }
  }

  return (
    <div className="calc-page" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="panel-hdr" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
          INBOUND HAUL REQUIREMENTS
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: stale ? 'var(--accent)' : 'var(--dim)', letterSpacing: 1 }}>
            {stale ? 'REFRESHING' : `${inboundSummary.row_count || 0} MATERIALS · ${inboundSummary.consumer_count || 0} JOBS`}
          </span>
          <button
            onClick={() => handleCopy('delta')}
            disabled={!deltaRows.length}
            style={{
              background: deltaRows.length ? '#4cff91' : 'rgba(255,255,255,0.08)',
              border: '1px solid var(--border)',
              color: deltaRows.length ? '#000' : 'var(--dim)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: 1,
              padding: '3px 10px',
              cursor: deltaRows.length ? 'pointer' : 'default',
              fontWeight: 700,
            }}
            title="Copy only what is still missing from the planner input hangar"
          >
            {copiedMode === 'delta' ? 'COPIED DELTA' : 'COPY DELTA'}
          </button>
          <button
            onClick={() => handleCopy('all')}
            disabled={!allRows.length}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: allRows.length ? 'var(--text)' : 'var(--dim)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: 1,
              padding: '3px 10px',
              cursor: allRows.length ? 'pointer' : 'default',
            }}
            title="Copy the full planner requirement list regardless of current stock"
          >
            {copiedMode === 'all' ? 'COPIED ALL' : 'COPY ALL'}
          </button>
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          OPERATIONS CORP
          <select
            value={operationsCorpId}
            onChange={(event) => updateSettings({
              operations_corp_id: event.target.value,
              corp_input_division: '',
              corp_output_division: '',
            })}
            style={controlStyle}
          >
            <option value="">PERSONAL / LEGACY ASSETS</option>
            {corporations.map((corp) => (
              <option key={corp.corporation_id} value={corp.corporation_id}>
                {`${String(corp.corporation_name || '').toUpperCase()}${corp.operations_ready ? '' : ' · NO CORP ASSET ACCESS'}`}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          INPUT HANGAR
          <select
            value={corpInputDivision}
            disabled={!operationsCorpId}
            onChange={(event) => updateSettings({ corp_input_division: event.target.value })}
            style={controlStyle}
          >
            <option value="">{operationsCorpId ? 'SELECT INPUT HANGAR' : 'SELECT OPERATIONS CORP FIRST'}</option>
            {divisionOptions.map((division) => (
              <option key={division.flag} value={division.flag}>
                {`${String(division.label || division.flag).toUpperCase()} · ${division.item_count || 0} ITEMS`}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          OUTPUT HANGAR
          <select
            value={corpOutputDivision}
            disabled={!operationsCorpId}
            onChange={(event) => updateSettings({ corp_output_division: event.target.value })}
            style={controlStyle}
          >
            <option value="">{operationsCorpId ? 'SELECT OUTPUT HANGAR' : 'SELECT OPERATIONS CORP FIRST'}</option>
            {divisionOptions.map((division) => (
              <option key={division.flag} value={division.flag}>
                {`${String(division.label || division.flag).toUpperCase()} · ${division.item_count || 0} ITEMS`}
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, justifyContent: 'flex-end' }}>
          <button
            onClick={refetchCorpContext}
            style={{ ...controlStyle, cursor: 'pointer', textAlign: 'center' }}
          >
            {corpContextLoading || corpContextStale ? 'REFRESHING CORP ACCESS' : 'REFRESH CORP ACCESS'}
          </button>
        </div>
      </div>

      <div style={{ padding: '8px 14px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(255,157,61,0.05)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
          {operationsCorpId
            ? `INBOUND TARGET · ${plannerSourceCorpName} · ${plannerSourceDivision}`
            : 'INBOUND TARGET · PERSONAL / LEGACY ASSET MODE'}
        </div>
        {operationsCorpId && (
          <div style={{ fontSize: 10, letterSpacing: 1, color: 'var(--dim)' }}>
            {`OUTPUT INVENTORY · ${outputSourceDivision}`}
          </div>
        )}
        {plannerInventorySource?.warning && (
          <div style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: 0.4 }}>
            INPUT HANGAR WARNING: {plannerInventorySource.warning}
          </div>
        )}
        {plannerWalletSource?.warning && (
          <div style={{ fontSize: 10, color: 'var(--accent)', letterSpacing: 0.4 }}>
            WALLET WARNING: {plannerWalletSource.warning}
          </div>
        )}
        {corpWarnings.map((warning) => (
          <div key={warning} style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 0.4 }}>
            {warning}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'linear-gradient(180deg, rgba(255,71,0,0.08), rgba(255,71,0,0))' }}>
        <MetricCard label="PLANNED JOBS" value={`${inboundSummary.consumer_count || 0}`} tone="var(--text)" />
        <MetricCard label="TOTAL REQUIRED" value={fmtISK(inboundSummary.total_required_cost)} tone="var(--accent)" />
        <MetricCard label="TO BUY" value={fmtISK(inboundSummary.total_delta_cost)} tone="var(--green)" />
        <MetricCard label="TO HAUL" value={formatCubicMeters(inboundSummary.total_delta_m3)} tone="#4da6ff" />
        <MetricCard label="STOCKED LINES" value={`${inboundSummary.stocked_count || 0}/${inboundSummary.row_count || 0}`} tone="var(--text)" />
      </div>

      <CargoTimelinePanel
        cycleHours={appSettings?.cycle_duration_hours}
        mfgItems={plannerMfgItems}
        sciItems={plannerSciItems}
        haulCapacityM3={appSettings?.haul_capacity_m3}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {loading && !plannerData ? (
          <LoadingState label="BUILDING INBOUND HAUL LIST" sub="PLANNER JOBS · INPUT HANGAR · INVENTION" />
        ) : error ? (
          <div style={{ padding: '24px 16px', color: 'var(--error)', fontSize: 11, letterSpacing: 1 }}>
            INBOUND REQUIREMENTS UNAVAILABLE
          </div>
        ) : inboundRows.length === 0 ? (
          <div style={{ padding: '24px 16px', color: 'var(--dim)', fontSize: 11, letterSpacing: 1, textAlign: 'center' }}>
            NO INBOUND MATERIALS ARE REQUIRED FOR THE CURRENT JOB PLANNER QUEUE
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'var(--table-row-bg)' }}>
                <th style={{ width: '31%', textAlign: 'left' }}>MATERIAL</th>
                <th style={{ width: '11%' }}>TYPE</th>
                <th style={{ width: '9%' }}>REQUIRED</th>
                <th style={{ width: '10%' }}>INPUT</th>
                <th style={{ width: '9%' }}>DELTA</th>
                <th style={{ width: '10%' }}>DELTA M3</th>
                <th style={{ width: '10%' }}>ALL MATS</th>
                <th style={{ width: '10%', paddingRight: 14 }}>DELTA COST</th>
              </tr>
            </thead>
            <tbody>
              {inboundRows.map((item, idx) => {
                const stocked = Boolean(item.stocked);
                const deltaQty = Number(item.delta_qty || 0);
                const deltaTone = stocked ? '#4cff91' : 'var(--accent)';
                const typeLabel = (item.groups || []).join(' · ') || 'MATERIAL';
                const consumerLabel = `${item.consumer_count || 0} job${Number(item.consumer_count || 0) === 1 ? '' : 's'}`;

                return (
                  <tr key={item.type_id} className="eve-row-reveal" style={{ animationDelay: `${idx * 18}ms` }}>
                    <td style={{ padding: '8px 10px', textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} title={(item.consumer_names || []).join(' · ')}>
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
                            <span>{consumerLabel.toUpperCase()}</span>
                            <span>{fmtISK(item.unit_price || 0)}/UNIT</span>
                            {stocked && <span style={{ color: '#4cff91' }}>STOCKED</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: typeLabel.includes('DATACORE') ? '#4da6ff' : 'var(--text)' }}>
                      {typeLabel}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{fmtVol(item.required_qty)}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: Number(item.available_qty || 0) > 0 ? '#4cff91' : 'var(--dim)' }}>
                      {fmtVol(item.available_qty)}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: deltaTone }}>
                      {stocked ? 'STOCKED' : fmtVol(item.delta_qty)}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: deltaQty > 0 ? '#4da6ff' : 'var(--dim)' }}>
                      {deltaQty > 0 ? formatCubicMeters(item.delta_volume_m3) : '—'}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)' }}>
                      {fmtISK(item.total_required_cost)}
                    </td>
                    <td style={{ paddingRight: 14, fontFamily: 'var(--mono)', fontSize: 11, color: deltaTone }}>
                      {deltaQty > 0 ? fmtISK(item.delta_cost) : '—'}
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
