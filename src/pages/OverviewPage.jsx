import { memo } from 'react';
import KPIBar from '../components/KPIBar';
import PlexSection from '../components/PlexSection';
import MineralsSection from '../components/MineralsSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';
import TopPerformersPanel from '../components/TopPerformersPanel';
import EvePanel from '../components/EvePanel';

const D = 1; // divider thickness px

// ── Layout ─────────────────────────────────────────────────────────────────────
// KPI bar
// Main: ManufacturingJobs (flex) | PLEX + TopPerformers (340px)
// Bottom: Orders (flex 1) | Minerals (flex 1)
export default memo(function OverviewPage({ plexData, walletHistory, plexLoading, plexError, refreshKey = 0 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* KPI Bar */}
      <KPIBar plexData={plexData} walletHistory={walletHistory} />

      {/* Main area — two columns */}
      <div style={{ flex: 3, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* Left — Manufacturing Jobs */}
        <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ManufacturingJobs />
        </EvePanel>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Right — PLEX tracker stacked above Top Performers */}
        <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <EvePanel scan={true} corners={false} style={{ flexShrink: 0, overflow: 'hidden' }}>
            <PlexSection plexData={plexData} walletHistory={walletHistory} loading={plexLoading} error={plexError} />
          </EvePanel>

          <div style={{ height: D, flexShrink: 0, background: 'var(--border)' }} />

          <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <TopPerformersPanel refreshKey={refreshKey} />
          </EvePanel>
        </div>
      </div>

      {/* Bottom divider */}
      <div style={{ height: D, flexShrink: 0, background: 'var(--border)' }} />

      {/* Bottom row — two equal columns */}
      <div style={{ flex: 2, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <OrdersSection />
        </EvePanel>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <MineralsSection />
        </EvePanel>
      </div>

    </div>
  );
});
