import PlexSection from '../components/PlexSection';
import MineralsSection from '../components/MineralsSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';

const D = 1; // divider thickness px

// ── Main page ──────────────────────────────────────────────────────────────────
// Top row:    ManufacturingJobs (full width)
// Bottom row: PlexSection (flex 2) | MineralsSection (fixed 240px) | OrdersSection (flex 3)
export default function OverviewPage({ plexData, walletHistory, plexLoading, plexError }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Row 1 — Manufacturing Jobs, full width */}
      <div style={{ flex: '0 0 52%', minHeight: 0, overflow: 'hidden' }}>
        <ManufacturingJobs />
      </div>

      {/* Row divider */}
      <div style={{ height: D, flexShrink: 0, background: 'var(--border)' }} />

      {/* Row 2 — PLEX Tracker | Minerals | Orders */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* PLEX Tracker — wider so the graph has horizontal room */}
        <div style={{ flex: '0 0 320px', minWidth: 0, overflow: 'hidden' }}>
          <PlexSection plexData={plexData} walletHistory={walletHistory} loading={plexLoading} error={plexError} />
        </div>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Minerals / Base Ores */}
        <div style={{ flex: '0 0 240px', minWidth: 0, overflow: 'hidden' }}>
          <MineralsSection />
        </div>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Sell / Buy Orders — fills the rest */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <OrdersSection />
        </div>

      </div>

    </div>
  );
}
