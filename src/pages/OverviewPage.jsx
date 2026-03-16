import { memo } from 'react';
import KPIBar from '../components/KPIBar';
import PlexSection from '../components/PlexSection';
import MineralsSection from '../components/MineralsSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';
import TopPerformersPanel from '../components/TopPerformersPanel';
import EvePanel from '../components/EvePanel';
import OverviewFooter from '../components/OverviewFooter';

const D = 1; // divider thickness px

// ── Layout ─────────────────────────────────────────────────────────────────────
// KPI bar
// Body: Left col (flex 1): MFG Jobs (top) | Orders + Minerals (bottom)
//       Right col (340px): PLEX (top) | TopPerformers (fills to bottom)
export default memo(function OverviewPage({ plexData, walletHistory, plexLoading, plexError, refreshKey = 0 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* KPI Bar */}
      <KPIBar plexData={plexData} walletHistory={walletHistory} />

      {/* Body — two columns */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* Left column — MFG Jobs on top, Orders + Minerals below */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          <EvePanel scan={true} corners={false} style={{ flex: 3, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ManufacturingJobs />
          </EvePanel>

          <div style={{ height: D, flexShrink: 0, background: 'var(--border)' }} />

          {/* Bottom-left — Orders and Minerals side by side */}
          {/* Orders gets calc(50% + 170.5px) so the divider lands at the true page center */}
          <div style={{ flex: 2, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
            <EvePanel scan={true} corners={false} style={{ flex: '0 0 calc(50% + 170.5px)', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <OrdersSection />
            </EvePanel>

            <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

            <EvePanel scan={true} corners={false} style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <MineralsSection />
            </EvePanel>
          </div>
        </div>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Right column — full height: PLEX on top, TopPerformers fills the rest */}
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

      {/* Footer strip */}
      <OverviewFooter />

    </div>
  );
});
