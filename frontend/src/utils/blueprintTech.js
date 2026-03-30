const TECH_ALIASES = {
  '1': 'T1',
  '2': 'T2',
  '3': 'T3',
  I: 'T1',
  II: 'T2',
  III: 'T3',
  T1: 'T1',
  T2: 'T2',
  T3: 'T3',
};

export function normalizeBlueprintTech(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  return TECH_ALIASES[raw] || '';
}