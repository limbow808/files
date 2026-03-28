export const FACILITY_OPTIONS = [
  { value: 'station', label: 'NPC Station' },
  { value: 'medium', label: 'Medium Eng. Complex' },
  { value: 'large', label: 'Large Eng. Complex' },
  { value: 'xl', label: 'XL Eng. Complex' },
  { value: 'raitaru', label: 'Raitaru' },
  { value: 'azbel', label: 'Azbel' },
  { value: 'sotiyo', label: 'Sotiyo' },
];

export const MARKET_HUBS = ['jita', 'amarr', 'dodixie', 'rens', 'hek'];

export const RIG_OPTIONS = [
  { value: 'none', label: '— None —' },
  { value: 'me_t1', label: 'ME Rig T1' },
  { value: 'me_t2', label: 'ME Rig T2' },
  { value: 'te_t1', label: 'TE Rig T1' },
  { value: 'te_t2', label: 'TE Rig T2' },
];

export const DEFAULT_APP_SETTINGS = {
  system: 'Korsiki',
  facility: 'large',
  facilityTaxRate: '0.10',
  rigBonusMfg: '0',
  structureJobTimeBonusPct: 0,
  buyLoc: 'jita',
  sellLoc: 'jita',
  cycle_duration_hours: 12,
  haul_capacity_m3: 50000,
  target_isk_per_m3: 0,
  count_corp_original_blueprints_as_own: false,
  min_profit_per_cycle: 100_000_000,
  include_below_threshold_items: true,
  max_sell_days_tolerance: 7,
  weight_by_velocity: true,
  rig_1: 'none',
  rig_2: 'none',
  operations_corp_id: '',
  corp_input_division: '',
  corp_output_division: '',
};

const STORAGE_KEY = 'crest_app_settings';

const RIG_BONUSES = {
  engineering_complex: { me_t1: 1, me_t2: 2, te_t1: 2, te_t2: 4 },
  azbel: { me_t1: 1.5, me_t2: 3, te_t1: 3, te_t2: 6 },
  sotiyo: { me_t1: 2, me_t2: 4, te_t1: 4, te_t2: 8 },
  npc_station: {},
};

function plannerStructureToFacility(structureType) {
  switch (structureType) {
    case 'npc_station':
      return 'station';
    case 'azbel':
      return 'azbel';
    case 'sotiyo':
      return 'sotiyo';
    case 'engineering_complex':
      return 'large';
    default:
      return DEFAULT_APP_SETTINGS.facility;
  }
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function facilityToPlannerStructureType(facility) {
  switch (facility) {
    case 'station':
      return 'npc_station';
    case 'azbel':
      return 'azbel';
    case 'sotiyo':
      return 'sotiyo';
    case 'medium':
    case 'large':
    case 'xl':
    case 'raitaru':
    default:
      return 'engineering_complex';
  }
}

export function facilityToRigProfile(facility) {
  return facilityToPlannerStructureType(facility);
}

export function getRigBonus(structureProfile, rig) {
  if (!rig || rig === 'none') return { me: 0, te: 0 };
  const bonuses = RIG_BONUSES[structureProfile] || {};
  const value = Number(bonuses[rig] || 0);
  return rig.startsWith('me') ? { me: value, te: 0 } : { me: 0, te: value };
}

export function loadAppSettings() {
  const stored = readJson(STORAGE_KEY);
  const legacyCycle = readJson('defaultCycleConfig');
  const legacySystem = typeof localStorage !== 'undefined' ? localStorage.getItem('crest_active_system') : null;

  const migrated = {
    ...(legacyCycle || {}),
    ...(legacySystem ? { system: legacySystem } : {}),
  };

  if (!stored && legacyCycle?.structure_type) {
    migrated.facility = plannerStructureToFacility(legacyCycle.structure_type);
  }

  const merged = {
    ...DEFAULT_APP_SETTINGS,
    ...migrated,
    ...(stored || {}),
  };

  delete merged.success_warn_threshold;
  return merged;
}

export function saveAppSettings(settings) {
  try {
    const sanitized = { ...settings };
    delete sanitized.success_warn_threshold;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  } catch {}
}

export function getFacilityLabel(facility) {
  return FACILITY_OPTIONS.find(option => option.value === facility)?.label || facility;
}

export function getHubLabel(hub) {
  if (!hub) return '—';
  return hub.charAt(0).toUpperCase() + hub.slice(1);
}