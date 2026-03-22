import { memo } from 'react';
import QueuePlannerView from '../components/QueuePlannerView';
import EvePanel from '../components/EvePanel';

export default memo(function QueuePlannerPage() {
  return (
    <div className="calc-page">
      <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <QueuePlannerView />
      </EvePanel>
    </div>
  );
});
