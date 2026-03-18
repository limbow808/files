import { useState, useEffect, useRef, useCallback } from 'react';
import Header from './components/Header';
import OverviewPage from './pages/OverviewPage';
import CalculatorPage from './pages/CalculatorPage';
import CharactersPage from './pages/CharactersPage';
import BpFinderPage from './pages/BpFinderPage';
import CraftLogPage from './pages/CraftLogPage';
import BootScreen from './components/BootScreen';
import { useApi } from './hooks/useApi';

export const API = '';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export default function App() {
  const [refreshKey,   setRefreshKey]   = useState(0);
  const [refreshing,   setRefreshing]   = useState(false);
  const [activeTab,    setActiveTab]    = useState('CREST');
  const [booted,       setBooted]       = useState(false);
  // Lazy mount: only mount a tab's page the first time the user visits it.
  // After mounting, the page stays in the DOM (display:none when inactive)
  // so data/state survive tab switches without re-fetching.
  const [mountedTabs, setMountedTabs] = useState(() => new Set(['CREST']));
  const timerRef = useRef(null);

  const { loading: scanLoading, error: scanError, refetch } =
    useApi(`${API}/api/scan`,           [refreshKey]);
  const { data: plexData, loading: plexLoading, error: plexError } =
    useApi(`${API}/api/plex`,           [refreshKey]);
  const { data: walletRaw } =
    useApi(`${API}/api/wallet/history`, [refreshKey]);
  // Lightweight ping — resolves as soon as Flask is up
  const { loading: pingLoading, error: pingError } =
    useApi(`${API}/api/ping`,           []);

  const walletHistory = Array.isArray(walletRaw) ? walletRaw : null;
  const online       = !scanError;
  const backendAlive = !pingError && !pingLoading;

  // Boot as soon as ping succeeds — don't wait for /api/ready.
  // Each component shows its own loading state until its data arrives.
  useEffect(() => {
    if (backendAlive && !booted) setBooted(true);
  }, [backendAlive, booted]);

  useEffect(() => {
    timerRef.current = setInterval(() => setRefreshKey(k => k + 1), AUTO_REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  // Mount the tab's page on first visit, keep it mounted forever after.
  const handleTabChange = useCallback((tab) => {
    setActiveTab(tab);
    setMountedTabs(prev => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);

  const handleBooted = useCallback(() => setBooted(true), []);

  async function handleRefresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  // Show boot screen only when backend is confirmed unreachable (not just slow to ping)
  const showBoot = !pingLoading && !!pingError && !booted;

  return (
    <>
      {showBoot && <BootScreen onBooted={handleBooted} />}
      <div className={`app-shell${booted ? ' hud-booted' : ' hud-booting'}`}>
        <Header
          key={booted ? 'live' : 'pre'}
          online={online}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          onRefresh={handleRefresh}
          refreshing={refreshing || scanLoading}
        />
        <div className="app-content">
          <div style={{ display: activeTab === 'CREST' ? 'contents' : 'none' }}>
            <OverviewPage
              plexData={plexData}
              walletHistory={walletHistory}
              plexLoading={plexLoading}
              plexError={plexError}
              refreshKey={refreshKey}
            />
          </div>
          {mountedTabs.has('CALCULATOR') && (
            <div style={{ display: activeTab === 'CALCULATOR' ? 'contents' : 'none' }}>
              <CalculatorPage refreshKey={refreshKey} />
            </div>
          )}
          {mountedTabs.has('CHARACTERS') && (
            <div style={{ display: activeTab === 'CHARACTERS' ? 'contents' : 'none' }}>
              <CharactersPage />
            </div>
          )}
          {mountedTabs.has('BP FINDER') && (
            <div style={{ display: activeTab === 'BP FINDER' ? 'contents' : 'none' }}>
              <BpFinderPage refreshKey={refreshKey} />
            </div>
          )}
          {mountedTabs.has('CRAFT LOG') && (
            <div style={{ display: activeTab === 'CRAFT LOG' ? 'contents' : 'none' }}>
              <CraftLogPage />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
