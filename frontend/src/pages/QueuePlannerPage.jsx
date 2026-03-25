import { memo } from 'react';
import QueuePlannerView from '../components/QueuePlannerView';
import EvePanel from '../components/EvePanel';

export default memo(function QueuePlannerPage({ appSettings, refreshNonce }) {
  return (
    <div className="calc-page">
      <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <QueuePlannerView appSettings={appSettings} refreshNonce={refreshNonce} />
      </EvePanel>
    </div>
  );
});
