import { memo } from 'react';
import PlexSection from '../components/PlexSection';
import MineralsSection from '../components/MineralsSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';
import TopPerformersPanel from '../components/TopPerformersPanel';
import EvePanel from '../components/EvePanel';

const D = 1; // divider thickness px

// ── Main page ──────────────────────────────────────────────────────────────────
// Row 1: ManufacturingJobs (flex 1) | TopPerformers (flex 1), ~52% height
// Row 2: PlexSection | MineralsSection | OrdersSection (remaining)
export default memo(function OverviewPage({ plexData, walletHistory, plexLoading, plexError, refreshKey = 0 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Row 1 — Manufacturing Jobs (left) | Top Performers (right) */}
      <div style={{ flex: '0 0 52%', minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ManufacturingJobs />
        </EvePanel>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <TopPerformersPanel refreshKey={refreshKey} />
        </EvePanel>
      </div>

      {/* Row divider */}
      <div style={{ height: D, flexShrink: 0, background: 'var(--border)' }} />

      {/* Row 3 — PLEX Tracker | Minerals | Orders */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* PLEX Tracker — wider so the graph has horizontal room */}
        <EvePanel scan={true} corners={false} style={{ flex: '0 0 320px', minWidth: 0, overflow: 'hidden' }}>
          <PlexSection plexData={plexData} walletHistory={walletHistory} loading={plexLoading} error={plexError} />
        </EvePanel>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Minerals / Base Ores — merged, wider */}
        <EvePanel scan={true} corners={false} style={{ flex: '0 0 320px', minWidth: 0, overflow: 'hidden' }}>
          <MineralsSection />
        </EvePanel>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Sell / Buy Orders — fills the rest */}
        <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <OrdersSection />
        </EvePanel>

      </div>

    </div>
  );
});
