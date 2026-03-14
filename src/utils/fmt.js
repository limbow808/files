export function fmtISK(v) {
  if (v == null) return '—';
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function fmtVol(v) {
  if (!v) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(v));
}

export function fmtTS(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toUTCString().replace(' GMT', '') + ' UTC';
}

export function fmtDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export function toggleSet(set, val) {
  const next = new Set(set);
  next.has(val) ? next.delete(val) : next.add(val);
  return next;
}

export function roiTier(roi) {
  if (roi >= 35) return 'tier-elite';
  if (roi >= 20) return 'tier-great';
  if (roi >= 12) return 'tier-good';
  if (roi >= 5)  return 'tier-ok';
  if (roi >= 0)  return 'tier-poor';
  return 'tier-bad';
}

export function roiColor(roi) {
  if (roi >= 35) return '#aa55ff';
  if (roi >= 20) return '#3399cc';
  if (roi >= 12) return '#44bb55';
  if (roi >= 5)  return '#ccaa00';
  if (roi >= 0)  return '#cc5500';
  return '#cc2200';
}
