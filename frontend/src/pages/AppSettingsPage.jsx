import { memo } from 'react';
import EvePanel from '../components/EvePanel';
import AppSettingsPanel from '../components/AppSettingsModal';

export default memo(function AppSettingsPage({ appSettings, onSaveSettings }) {
  return (
    <div className="calc-page">
      <EvePanel scan={true} corners={false} style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: '100%', padding: '18px 18px 28px', boxSizing: 'border-box', display: 'flex', justifyContent: 'center' }}>
          <AppSettingsPanel settings={appSettings} onSave={onSaveSettings} />
        </div>
      </EvePanel>
    </div>
  );
});