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

const TIER_NAMES  = ['tier-bad', 'tier-poor', 'tier-ok', 'tier-good', 'tier-great', 'tier-elite'];
const TIER_COLORS = ['#cc2200',  '#cc5500',   '#ccaa00', '#44bb55',   '#3399cc',    '#aa55ff'];

// Static fallbacks (fixed thresholds)
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

/**
 * Build a dynamic ROI scale from the actual dataset.
 * Divides the observed ROI range into 6 equal bands (percentile-like)
 * so the colour spectrum always spreads across the full data range.
 *
 * Returns { tier(roi) → string, color(roi) → hex, cuts → number[] }
 */
export function makeRoiScale(roiValues) {
  const vals = roiValues.filter(v => v != null && isFinite(v));
  if (vals.length < 2) {
    return { tier: roiTier, color: roiColor, cuts: null };
  }

  // Use percentile breakpoints so the scale spreads across real data
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  // 5 cut-points at the 0th, 17th, 33rd, 50th, 67th, 83rd, 100th percentiles
  // → 6 bands
  const pct = [0, 1/6, 2/6, 3/6, 4/6, 5/6];
  const cuts = pct.map(p => {
    const idx = Math.floor(p * (n - 1));
    return sorted[idx];
  });

  function tier(roi) {
    // Find the highest band whose cut-point is ≤ roi
    let band = 0;
    for (let i = 1; i < cuts.length; i++) {
      if (roi >= cuts[i]) band = i;
    }
    return TIER_NAMES[band];
  }

  function color(roi) {
    let band = 0;
    for (let i = 1; i < cuts.length; i++) {
      if (roi >= cuts[i]) band = i;
    }
    return TIER_COLORS[band];
  }

  return { tier, color, cuts };
}
