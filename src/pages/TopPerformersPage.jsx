import { memo } from 'react';
import TopPerformersPanel from '../components/TopPerformersPanel';
import EvePanel from '../components/EvePanel';

export default memo(function TopPerformersPage() {
  return (
    <div className="calc-page">
      <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <TopPerformersPanel />
      </EvePanel>
    </div>
  );
});
