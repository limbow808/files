import { useMemo } from 'react';

function fmtShortWindow(seconds) {
  if (seconds == null || seconds <= 0) return 'NOW';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds < 14400 ? 1 : 0)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function fmtM3(m3) {
  if (m3 == null) return '—';
  if (m3 >= 1_000_000) return `${(m3 / 1_000_000).toFixed(1)}M m3`;
  if (m3 >= 1_000) return `${(m3 / 1_000).toFixed(1)}K m3`;
  return `${Math.round(m3).toLocaleString('en-US')} m3`;
}

function fmtTripLoad(totalM3, capacityM3) {
  if (!capacityM3 || capacityM3 <= 0) return 'set haul cap';
  const trips = totalM3 / capacityM3;
  if (trips <= 0) return '0 trips';
  if (trips < 1) return `${Math.round(trips * 100)}% load`;
  return `${trips.toFixed(trips >= 10 ? 0 : 1)} trips`;
}

function CargoProgressSquares({ filledSquares, totalSquares, color }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${totalSquares}, minmax(0, 1fr))`, gap: 2 }}>
      {Array.from({ length: totalSquares }, (_, index) => (
        <div
          key={`${color}:${index}`}
          style={{
            height: 10,
            borderRadius: 2,
            background: index < filledSquares ? color : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        />
      ))}
    </div>
  );
}

function CargoTimelineRow({ label, color, totalM3, nextTs, nextLabel, capacityM3 }) {
  const totalSquares = 24;
  const loadRatio = capacityM3 > 0 ? totalM3 / capacityM3 : 0;
  const filledSquares = totalM3 > 0 && capacityM3 > 0
    ? Math.max(1, Math.round(Math.min(loadRatio, 1) * totalSquares))
    : 0;
  const loadTextColor = loadRatio > 1 ? 'var(--accent)' : 'var(--dim)';

  return (
    <div className="planner-cargo-row">
      <div className="planner-cargo-row__meta">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.8, color }}>{label}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>{fmtM3(totalM3)} total</span>
        </div>
        <div className="planner-cargo-row__stats" style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: 0.5, color: 'var(--dim)' }}>
            {nextLabel}: {nextTs ? fmtShortWindow(nextTs - Math.floor(Date.now() / 1000)) : '—'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: 0.5, color: loadTextColor, marginTop: 2 }}>
            {fmtTripLoad(totalM3, capacityM3)} @ {fmtM3(capacityM3)}
          </div>
        </div>
      </div>
      <CargoProgressSquares filledSquares={filledSquares} totalSquares={totalSquares} color={color} />
    </div>
  );
}

export default function CargoTimelinePanel({ cycleHours, mfgItems, sciItems, haulCapacityM3 }) {
  const panelData = useMemo(() => {
    const nowTs = Math.floor(Date.now() / 1000);
    const horizonHours = Math.max(12, Math.min(24, cycleHours || 12));
    const horizonSecs = horizonHours * 3600;
    const capacityM3 = Math.max(0, Number(haulCapacityM3 || 0));

    const inboundEvents = [];
    const outboundEvents = [];

    mfgItems.forEach(item => {
      const startAt = Math.max(nowTs, Number(item.start_at || nowTs));
      const endAt = startAt + Math.max(0, Number(item.duration_secs || 0));
      const inboundM3 = Number(item.inbound_missing_m3 || 0);
      const outboundM3 = Number(item.outbound_volume_m3 || 0);

      if (inboundM3 > 0) {
        inboundEvents.push({ ts: startAt, volume: inboundM3, name: item.name });
      }
      if (outboundM3 > 0) {
        outboundEvents.push({ ts: endAt, volume: outboundM3, name: item.name });
      }
    });

    sciItems.forEach(item => {
      if (item.is_idle || item.action_type === 'idle_science') return;
      const startAt = Math.max(nowTs, Number(item.start_at || nowTs));
      const manufactureAt = Math.max(startAt, Number(item.manufacture_at || startAt));
      const endAt = manufactureAt + Math.max(0, Number(item.duration_secs || 0));
      const inboundM3 = Number(item.inbound_missing_m3 || 0);
      const outboundM3 = Number(item.outbound_volume_m3 || 0);

      if (inboundM3 > 0) {
        inboundEvents.push({ ts: startAt, volume: inboundM3, name: item.name });
      }
      if (outboundM3 > 0) {
        outboundEvents.push({ ts: endAt, volume: outboundM3, name: item.name });
      }
    });

    const scopedInbound = inboundEvents.filter(event => event.ts >= nowTs && event.ts <= nowTs + horizonSecs);
    const scopedOutbound = outboundEvents.filter(event => event.ts >= nowTs && event.ts <= nowTs + horizonSecs);

    const inboundTotalM3 = scopedInbound.reduce((sum, event) => sum + event.volume, 0);
    const outboundTotalM3 = scopedOutbound.reduce((sum, event) => sum + event.volume, 0);
    const nextInboundTs = scopedInbound.length > 0 ? Math.min(...scopedInbound.map(event => event.ts)) : null;
    const nextOutboundTs = scopedOutbound.length > 0 ? Math.min(...scopedOutbound.map(event => event.ts)) : null;

    return {
      horizonHours,
      capacityM3,
      inboundTotalM3,
      outboundTotalM3,
      nextInboundTs,
      nextOutboundTs,
    };
  }, [cycleHours, haulCapacityM3, mfgItems, sciItems]);

  return (
    <div className="planner-cargo">
      <div className="planner-cargo-head">
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 1.1, color: 'var(--text)' }}>CARGO FLOW</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--dim)' }}>M3 TO FEED SCIENCE, REFILL MANUFACTURING, AND PICK UP FINISHED GOODS OVER {panelData.horizonHours}H · {fmtM3(panelData.capacityM3)} SHIP CAP</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <CargoTimelineRow
          label="INBOUND MATS"
          color="#4cff91"
          totalM3={panelData.inboundTotalM3}
          nextTs={panelData.nextInboundTs}
          nextLabel="next refill"
          capacityM3={panelData.capacityM3}
        />
        <CargoTimelineRow
          label="OUTBOUND GOODS"
          color="#ff6b2c"
          totalM3={panelData.outboundTotalM3}
          nextTs={panelData.nextOutboundTs}
          nextLabel="next pickup"
          capacityM3={panelData.capacityM3}
        />
      </div>
    </div>
  );
}