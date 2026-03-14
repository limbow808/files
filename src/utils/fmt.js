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
  // Only consider non-negative ROIs for the scale — negatives are always tier-bad
  const vals = roiValues.filter(v => v != null && isFinite(v) && v >= 0);
  if (vals.length < 2) {
    return { tier: roiTier, color: roiColor, cuts: null };
  }

  // Scale always starts at 0 and spreads across the positive range.
  // Divide [0 … max] into 5 equal bands (tier-poor through tier-elite);
  // anything below 0 is hard-clamped to tier-bad.
  const max = Math.max(...vals);
  if (max === 0) {
    return { tier: roiTier, color: roiColor, cuts: null };
  }

  // 5 cut-points above 0 → 5 positive bands + the implicit <0 bad band
  // cuts[0] = 0  (tier-poor starts here)
  // cuts[1..4] divide (0, max] into 5 equal slices
  const cuts = [0, max/5, (2*max)/5, (3*max)/5, (4*max)/5];

  function band(roi) {
    if (roi < 0) return 0;           // tier-bad
    let b = 1;                       // at least tier-poor (roi >= 0)
    for (let i = 1; i < cuts.length; i++) {
      if (roi >= cuts[i]) b = i + 1;
    }
    return b;
  }

  function tier(roi) {
    return TIER_NAMES[band(roi)];
  }

  function color(roi) {
    return TIER_COLORS[band(roi)];
  }

  return { tier, color, cuts };
}
