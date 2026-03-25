import { memo } from 'react';
import KPIBar from '../components/KPIBar';
import PlexSection from '../components/PlexSection';
import ManufacturingJobs from '../components/ManufacturingJobs';
import OrdersSection from '../components/OrdersSection';
import EvePanel from '../components/EvePanel';
import OverviewFooter from '../components/OverviewFooter';

const D = 1; // divider thickness px

// ── Layout ─────────────────────────────────────────────────────────────────────
// KPI bar
// Body: Left col (flex 1): MFG Jobs full height
//       Right col (340px): PLEX (top) | Orders (fills rest)
export default memo(function OverviewPage({ plexData, walletHistory, plexLoading, plexError, refreshKey = 0 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* KPI Bar */}
      <KPIBar plexData={plexData} walletHistory={walletHistory} />

      {/* Body — two columns */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* Left column — MFG Jobs full height */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ManufacturingJobs refreshKey={refreshKey} />
          </EvePanel>
        </div>

        <div style={{ width: D, flexShrink: 0, background: 'var(--border)' }} />

        {/* Right column — full height: PLEX on top, Orders fills the rest */}
        <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <EvePanel scan={true} corners={false} style={{ flexShrink: 0, overflow: 'hidden' }}>
            <PlexSection plexData={plexData} walletHistory={walletHistory} loading={plexLoading} error={plexError} />
          </EvePanel>

          <div style={{ height: D, flexShrink: 0, background: 'var(--border)' }} />

          <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <OrdersSection />
          </EvePanel>
        </div>
      </div>

      {/* Footer strip */}
      <OverviewFooter />

    </div>
  );
});
