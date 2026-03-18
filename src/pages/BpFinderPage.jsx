import { useApi } from '../hooks/useApi';
import BpFinderPanel from '../components/BpFinderPanel';
import { useState, useMemo, memo } from 'react';
import { API } from '../App';

function BpFinderPage({ refreshKey = 0 }) {
  const [listEnabled, setListEnabled] = useState(false);
  const calcUrl = listEnabled ? `${API}/api/calculator` : null;
  const { data: calcData, loading: calcLoading } = useApi(calcUrl, [refreshKey, listEnabled]);
  const { data: esiBpData } = useApi(`${API}/api/blueprints/esi`, []);

  const esiBpMap = useMemo(() => {
    const map = {};
    for (const bp of (esiBpData?.blueprints || [])) {
      const key = bp.name.toLowerCase().replace(/\s+blueprint$/, '');
      if (!map[key]) map[key] = { hasBPO: false, hasBPC: false };
      if (bp.bp_type === 'BPO') map[key].hasBPO = true;
      else                       map[key].hasBPC = true;
    }
    return map;
  }, [esiBpData]);

  return (
    <div className="calc-page">
      <BpFinderPanel
        calcResults={calcData?.results || []}
        esiBpMap={esiBpMap}
        listEnabled={listEnabled}
        listLoading={calcLoading}
        onLoadList={() => setListEnabled(true)}
      />
    </div>
  );
}

export default memo(BpFinderPage);
