import { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import OverviewPage from './pages/OverviewPage';
import CalculatorPage from './pages/CalculatorPage';
import { useApi } from './hooks/useApi';

export const API = '';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab]   = useState('CREST');
  const timerRef = useRef(null);

  const { data: scanData,     loading: scanLoading, error: scanError, refetch } =
    useApi(`${API}/api/scan`,           [refreshKey]);
  const { data: plexData,     loading: plexLoading } =
    useApi(`${API}/api/plex`,           [refreshKey]);
  const { data: walletRaw } =
    useApi(`${API}/api/wallet/history`, [refreshKey]);

  const walletHistory = Array.isArray(walletRaw) ? walletRaw : null;
  const online = !scanError;

  useEffect(() => {
    timerRef.current = setInterval(() => setRefreshKey(k => k + 1), AUTO_REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  return (
    <div className="app-shell">
      <Header online={online} activeTab={activeTab} onTabChange={setActiveTab} onRefresh={handleRefresh} refreshing={refreshing || scanLoading} />
      <div className="app-content">
        {activeTab === 'CREST' && (
          <OverviewPage
            plexData={plexData}
            walletHistory={walletHistory}
            plexLoading={plexLoading}
          />
        )}
        {activeTab === 'CALCULATOR' && <CalculatorPage refreshKey={refreshKey} />}
      </div>
    </div>
  );
}
