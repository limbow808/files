import { memo, useState } from 'react';

const DEFAULT_CYCLE_CONFIG = {
  cycle_duration_hours: 12,
  min_profit_per_cycle: 100_000_000,
  max_sell_days_tolerance: 7,
  success_warn_threshold: 0.34,
  weight_by_velocity: true,
};

export function loadCycleConfig() {
  try {
    const stored = localStorage.getItem('defaultCycleConfig');
    if (stored) return { ...DEFAULT_CYCLE_CONFIG, ...JSON.parse(stored) };
  } catch (e) {}
  return { ...DEFAULT_CYCLE_CONFIG };
}

export function saveCycleConfig(config) {
  try {
    localStorage.setItem('defaultCycleConfig', JSON.stringify(config));
  } catch (e) {}
}

export { DEFAULT_CYCLE_CONFIG };

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
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginBottom: 5 }}>{hint}</div>
      {children}
    </div>
  );
}

export default memo(function QueuePlannerSettings({ onConfigChange, isOpen, onClose, currentCycleConfig }) {
  const [local, setLocal] = useState(currentCycleConfig || loadCycleConfig());

  if (!isOpen) return null;

  const set = (field, val) => setLocal(prev => ({ ...prev, [field]: val }));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
        width: 440, maxWidth: '90vw', padding: '20px 24px',
      }}>
        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)' }}>
            ⚙ QUEUE PLANNER SETTINGS
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
        </div>

        <SettingRow label="CYCLE DURATION" unit="hours" hint="How long is your typical login window? 12h = 2× daily, 6h = 4× daily.">
          <input type="number" min={1} max={24} step={0.5}
            value={local.cycle_duration_hours}
            onChange={e => set('cycle_duration_hours', parseFloat(e.target.value) || 12)}
            style={inputStyle}
          />
        </SettingRow>

        <SettingRow label="MIN PROFIT / CYCLE" unit="ISK" hint="Filter out items earning less than this per cycle.">
          <input type="number" min={0} step={10_000_000}
            value={local.min_profit_per_cycle}
            onChange={e => set('min_profit_per_cycle', parseFloat(e.target.value) || 0)}
            style={inputStyle}
          />
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 3 }}>
            = {(local.min_profit_per_cycle / 1_000_000).toFixed(0)}M ISK
          </div>
        </SettingRow>

        <SettingRow label="MAX DAYS TO SELL" unit="days" hint="Exclude items that would take longer than this to sell at current volumes.">
          <input type="number" min={1} max={30} step={1}
            value={local.max_sell_days_tolerance}
            onChange={e => set('max_sell_days_tolerance', parseFloat(e.target.value) || 7)}
            style={inputStyle}
          />
        </SettingRow>

        <SettingRow label="SUCCESS WARN THRESHOLD" unit="%" hint="Flag invention items with success chance at or below this value.">
          <input type="number" min={5} max={100} step={5}
            value={Math.round(local.success_warn_threshold * 100)}
            onChange={e => set('success_warn_threshold', (parseFloat(e.target.value) || 34) / 100)}
            style={inputStyle}
          />
        </SettingRow>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input type="checkbox"
              checked={local.weight_by_velocity}
              onChange={e => set('weight_by_velocity', e.target.checked)}
              style={{ width: 14, height: 14, cursor: 'pointer', accentColor: '#4cff91' }}
            />
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1, color: 'var(--text)' }}>WEIGHT BY SELL VELOCITY</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', marginTop: 2 }}>Boost items you personally sell faster</div>
            </div>
          </label>
        </div>

        {/* Summary */}
        <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 2, padding: '8px 10px', marginBottom: 16, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)', lineHeight: 1.8 }}>
          <div style={{ color: 'var(--text)', marginBottom: 4, letterSpacing: 1 }}>PREVIEW</div>
          {local.cycle_duration_hours}h cycle · {(local.min_profit_per_cycle / 1_000_000).toFixed(0)}M min/cycle · {local.max_sell_days_tolerance}d sell cap · {Math.round(local.success_warn_threshold * 100)}% success warn
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => setLocal({ ...DEFAULT_CYCLE_CONFIG })}
            style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, padding: '5px 12px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--dim)', borderRadius: 2, cursor: 'pointer' }}
          >RESET</button>
          <button
            onClick={() => { saveCycleConfig(local); onConfigChange?.(local); onClose?.(); }}
            style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, padding: '5px 12px', border: 'none', background: '#4cff91', color: '#000', borderRadius: 2, cursor: 'pointer', fontWeight: 700 }}
          >APPLY</button>
        </div>
      </div>
    </div>
  );
});
