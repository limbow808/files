import { memo, useEffect, useMemo, useState } from 'react';
import SystemInput from './SystemInput';
import {
  DEFAULT_APP_SETTINGS,
  FACILITY_OPTIONS,
  MARKET_HUBS,
  RIG_OPTIONS,
  facilityToPlannerStructureType,
  facilityToRigProfile,
  getFacilityLabel,
  getHubLabel,
  getRigBonus,
} from '../utils/appSettings';

const inputStyle = {
  width: '100%', background: 'var(--bg)', border: '1px solid var(--border)',
  color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, padding: '5px 8px',
  borderRadius: 2, boxSizing: 'border-box', outline: 'none',
};

function SettingRow({ label, hint, unit, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, color: 'var(--text)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>{unit}</span>
      </div>
      {hint && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginBottom: 5 }}>{hint}</div>}
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ marginBottom: 10, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 2, color: 'var(--dim)', borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      {children}
    </div>
  );
}

export default memo(function AppSettingsPanel({ settings, onSave }) {
  const [local, setLocal] = useState(settings || DEFAULT_APP_SETTINGS);
  const [sysSci, setSysSci] = useState(null);

  useEffect(() => {
    setLocal(settings || DEFAULT_APP_SETTINGS);
  }, [settings]);

  const setField = (field, value) => setLocal(prev => ({ ...prev, [field]: value }));

  const plannerStructureType = facilityToPlannerStructureType(local.facility);
  const rigProfile = facilityToRigProfile(local.facility);
  const bonusPreview = useMemo(() => {
    const first = getRigBonus(rigProfile, local.rig_1);
    const second = getRigBonus(rigProfile, local.rig_2);
    return { me: first.me + second.me, te: first.te + second.te };
  }, [local.rig_1, local.rig_2, rigProfile]);

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4, width: '100%', maxWidth: 980, overflow: 'hidden', padding: '20px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)' }}>
          APP SETTINGS
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div>
          <SectionTitle>INDUSTRY DEFAULTS</SectionTitle>

            <SettingRow label="MANUFACTURING SYSTEM" hint="Used for calculator SCI lookup and shopping list context.">
              <SystemInput value={local.system} onChange={(value) => setField('system', value)} onSciChange={setSysSci} />
              {sysSci?.sci != null && !sysSci?.notFound && (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 4 }}>
                  SCI {(sysSci.sci * 100).toFixed(2)}%
                </div>
              )}
            </SettingRow>

            <SettingRow label="STRUCTURE" hint="Shared manufacturing facility used by the calculator and planner.">
              <select value={local.facility} onChange={event => setField('facility', event.target.value)} style={inputStyle}>
                {FACILITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </SettingRow>

            <SettingRow label="FACILITY TAX" unit="%" hint="Owner-set install tax used by the manufacturing calculator.">
              <input type="number" min="0.01" max="100" step="0.01" value={local.facilityTaxRate} onChange={event => setField('facilityTaxRate', event.target.value)} style={inputStyle} />
            </SettingRow>

            <SettingRow label="INSTALL COST RIG BONUS" unit="decimal" hint="Calculator override on the gross SCI install component, for example -0.02 for a 2% reduction.">
              <input type="number" step="0.001" value={local.rigBonusMfg} onChange={event => setField('rigBonusMfg', event.target.value)} style={inputStyle} />
            </SettingRow>

            <SettingRow label="BUY HUB" hint="Market hub used to price input materials.">
              <select value={local.buyLoc} onChange={event => setField('buyLoc', event.target.value)} style={inputStyle}>
                {MARKET_HUBS.map(hub => <option key={hub} value={hub}>{getHubLabel(hub)}</option>)}
              </select>
            </SettingRow>

            <SettingRow label="SELL HUB" hint="Market hub used to price manufactured outputs.">
              <select value={local.sellLoc} onChange={event => setField('sellLoc', event.target.value)} style={inputStyle}>
                {MARKET_HUBS.map(hub => <option key={hub} value={hub}>{getHubLabel(hub)}</option>)}
              </select>
            </SettingRow>
        </div>

        <div>
          <SectionTitle>JOB PLANNER DEFAULTS</SectionTitle>

            <SettingRow label="CYCLE DURATION" unit="hours" hint="Typical login cadence for cycle planning.">
              <input type="number" min={1} max={24} step={0.5} value={local.cycle_duration_hours} onChange={event => setField('cycle_duration_hours', parseFloat(event.target.value) || 12)} style={inputStyle} />
            </SettingRow>

            <SettingRow label="STRUCTURE JOB TIME BONUS" unit="%" hint="Shared time reduction from your structure for manufacturing and science jobs. Example: Azbel role bonus = 20.">
              <input type="number" min={0} max={95} step={0.5} value={local.structureJobTimeBonusPct ?? 0} onChange={event => setField('structureJobTimeBonusPct', parseFloat(event.target.value) || 0)} style={inputStyle} />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 3 }}>
                Applied to manufacturing, copying, and invention timing estimates in the planner.
              </div>
            </SettingRow>

            <SettingRow label="HAULING CAPACITY" unit="m3" hint="Cargo hold capacity of the ship you use for planner refills and pickups.">
              <input type="number" min={1} step={1000} value={local.haul_capacity_m3} onChange={event => setField('haul_capacity_m3', parseFloat(event.target.value) || 0)} style={inputStyle} />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 3 }}>
                Cargo bars scale against this value.
              </div>
            </SettingRow>

            <SettingRow label="TARGET ISK / M3" unit="ISK" hint="Soft planner preference for compact, high-value hauling. Set 0 to disable.">
              <input type="number" min={0} step={1000} value={local.target_isk_per_m3} onChange={event => setField('target_isk_per_m3', parseFloat(event.target.value) || 0)} style={inputStyle} />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 3 }}>
                Low-density items are downweighted, not hard-blocked.
              </div>
            </SettingRow>

            <SettingRow label="MIN PROFIT / CYCLE" unit="ISK" hint="Planner filter threshold for manufacturing opportunities.">
              <input type="number" min={0} step={10_000_000} value={local.min_profit_per_cycle} onChange={event => setField('min_profit_per_cycle', parseFloat(event.target.value) || 0)} style={inputStyle} />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 3 }}>
                = {(local.min_profit_per_cycle / 1_000_000).toFixed(0)}M ISK
              </div>
            </SettingRow>

            <div style={{ marginBottom: 20, marginTop: -6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={Boolean(local.include_below_threshold_items)} onChange={event => setField('include_below_threshold_items', event.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#4cff91' }} />
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, color: 'var(--text)' }}>INCLUDE BELOW THRESHOLD ITEMS</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 2 }}>When enabled, low-profit items can still backfill empty slots. When disabled, anything below the threshold leaves the slot idle.</div>
                </div>
              </label>
            </div>

            <SettingRow label="MAX DAYS TO SELL" unit="days" hint="Planner saturation cap.">
              <input type="number" min={1} max={30} step={1} value={local.max_sell_days_tolerance} onChange={event => setField('max_sell_days_tolerance', parseFloat(event.target.value) || 7)} style={inputStyle} />
            </SettingRow>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={Boolean(local.count_corp_original_blueprints_as_own)} onChange={event => setField('count_corp_original_blueprints_as_own', event.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#4cff91' }} />
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, color: 'var(--text)' }}>COUNT CORP ORIGINAL BLUEPRINTS AS OWN</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 2 }}>Use corp BPOs directly in the manufacturing queue instead of treating them as copy-only access.</div>
                </div>
              </label>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={local.weight_by_velocity} onChange={event => setField('weight_by_velocity', event.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#4cff91' }} />
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, color: 'var(--text)' }}>WEIGHT BY SELL VELOCITY</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 2 }}>Boost items you personally move faster</div>
                </div>
              </label>
            </div>

            <SettingRow label="PLANNER RIG SLOT 1" hint="Shared planner rig profile derived from the selected structure.">
              <select value={local.rig_1} onChange={event => setField('rig_1', event.target.value)} style={inputStyle}>
                {RIG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </SettingRow>

            <SettingRow label="PLANNER RIG SLOT 2" hint="Second planner rig slot.">
              <select value={local.rig_2} onChange={event => setField('rig_2', event.target.value)} style={inputStyle}>
                {RIG_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </SettingRow>

            {(bonusPreview.me > 0 || bonusPreview.te > 0) && (
              <div style={{ marginBottom: 16, padding: '6px 10px', background: 'rgba(76,255,145,0.05)', border: '1px solid rgba(76,255,145,0.2)', borderRadius: 2 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#4cff91', letterSpacing: 1 }}>
                  {bonusPreview.me > 0 && <span>−{bonusPreview.me}% MATERIAL COST{bonusPreview.te > 0 ? '  ' : ''}</span>}
                  {bonusPreview.te > 0 && <span>−{bonusPreview.te}% BUILD TIME</span>}
                </div>
              </div>
            )}
            {(local.structureJobTimeBonusPct ?? 0) > 0 && (
              <div style={{ marginBottom: 16, padding: '6px 10px', background: 'rgba(77,166,255,0.06)', border: '1px solid rgba(77,166,255,0.22)', borderRadius: 2 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#7ec8ff', letterSpacing: 1 }}>
                  −{Number(local.structureJobTimeBonusPct || 0).toFixed(1)}% STRUCTURE JOB TIME
                </div>
              </div>
            )}
        </div>
      </div>

      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 2, padding: '10px 12px', marginTop: 18, marginBottom: 16, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', lineHeight: 1.8 }}>
        <div style={{ color: 'var(--text)', marginBottom: 4, letterSpacing: 1 }}>SUMMARY</div>
        {local.system} · {getFacilityLabel(local.facility)} · {local.facilityTaxRate}% facility tax · {getHubLabel(local.buyLoc)} buy / {getHubLabel(local.sellLoc)} sell
        <br />
        Planner: {local.cycle_duration_hours}h cycle · −{Number(local.structureJobTimeBonusPct || 0).toFixed(1)}% structure time · {Math.round(local.haul_capacity_m3 || 0).toLocaleString('en-US')} m3 haul cap · {Math.round(local.target_isk_per_m3 || 0).toLocaleString('en-US')} ISK/m3 target · {(local.min_profit_per_cycle / 1_000_000).toFixed(0)}M min/cycle · {local.max_sell_days_tolerance}d sell cap · corp originals {local.count_corp_original_blueprints_as_own ? 'count as own' : 'copy-only'}
        <br />
        Below-threshold items: {local.include_below_threshold_items ? 'included as filler' : 'left idle'}
        Derived planner structure: {plannerStructureType}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          onClick={() => setLocal({ ...DEFAULT_APP_SETTINGS })}
          style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, padding: '5px 12px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--dim)', borderRadius: 2, cursor: 'pointer' }}
        >RESET</button>
        <button
          onClick={() => { onSave?.(local); }}
          style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, padding: '5px 12px', border: 'none', background: '#4cff91', color: '#000', borderRadius: 2, cursor: 'pointer', fontWeight: 700 }}
        >SAVE SETTINGS</button>
      </div>
    </div>
  );
});