import { useState, useEffect, useRef, useCallback } from 'react';
import Header from './components/Header';
import OverviewPage from './pages/OverviewPage';
import CalculatorPage from './pages/CalculatorPage';
import CharactersPage from './pages/CharactersPage';
import CraftLogPage from './pages/CraftLogPage';
import MessagesPage from './pages/MessagesPage';
import QueuePlannerPage from './pages/QueuePlannerPage';
import TopPerformersPage from './pages/TopPerformersPage';
import ContractScannerPage from './pages/ContractScannerPage';
import BlueprintsPage from './pages/BlueprintsPage';
import OrdersPage from './pages/OrdersPage';
import InventoryPage from './pages/InventoryPage';
import ResearchPage from './pages/ResearchPage';
import InventionPage from './pages/InventionPage';
import MineralPricesPage from './pages/MineralPricesPage';
import HaulPlannerPage from './pages/HaulPlannerPage';
import BootScreen from './components/BootScreen';
import { useApi } from './hooks/useApi';

export const API = '';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export default function App() {
  const [refreshKey,   setRefreshKey]   = useState(0);
  const [refreshing,   setRefreshing]   = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [activeTab,    setActiveTab]    = useState('OVERVIEW');
  const [booted,       setBooted]       = useState(false);
  // Lazy mount: only mount a tab's page the first time the user visits it.
  // After mounting, the page stays in the DOM (display:none when inactive)
  // so data/state survive tab switches without re-fetching.
  const [mountedTabs, setMountedTabs] = useState(() => new Set(['OVERVIEW']));
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
    timerRef.current = setInterval(() => {
      setRefreshKey(k => k + 1);
      setLastRefreshAt(Date.now());
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    if (!scanLoading && !scanError) {
      setLastRefreshAt(prev => prev ?? Date.now());
    }
  }, [scanLoading, scanError]);

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
    setLastRefreshAt(Date.now());
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
          lastRefreshAt={lastRefreshAt}
        />
        <div className="app-content">
          <div style={{ display: activeTab === 'OVERVIEW' ? 'contents' : 'none' }}>
            <OverviewPage
              plexData={plexData}
              walletHistory={walletHistory}
              plexLoading={plexLoading}
              plexError={plexError}
              refreshKey={refreshKey}
            />
          </div>
          {mountedTabs.has('MANUFACTURING') && (
            <div style={{ display: activeTab === 'MANUFACTURING' ? 'contents' : 'none' }}>
              <CalculatorPage refreshKey={refreshKey} />
            </div>
          )}
          {mountedTabs.has('QUEUE_PLANNER') && (
            <div style={{ display: activeTab === 'QUEUE_PLANNER' ? 'contents' : 'none' }}>
              <QueuePlannerPage />
            </div>
          )}
          {mountedTabs.has('TOP_PERFORMERS') && (
            <div style={{ display: activeTab === 'TOP_PERFORMERS' ? 'contents' : 'none' }}>
              <TopPerformersPage />
            </div>
          )}
          {mountedTabs.has('RESEARCH') && (
            <div style={{ display: activeTab === 'RESEARCH' ? 'contents' : 'none' }}>
              <ResearchPage />
            </div>
          )}
          {mountedTabs.has('INVENTION') && (
            <div style={{ display: activeTab === 'INVENTION' ? 'contents' : 'none' }}>
              <InventionPage />
            </div>
          )}
          {mountedTabs.has('BLUEPRINTS') && (
            <div style={{ display: activeTab === 'BLUEPRINTS' ? 'contents' : 'none' }}>
              <BlueprintsPage refreshKey={refreshKey} />
            </div>
          )}
          {mountedTabs.has('CONTRACT_SCANNER') && (
            <div style={{ display: activeTab === 'CONTRACT_SCANNER' ? 'contents' : 'none' }}>
              <ContractScannerPage refreshKey={refreshKey} />
            </div>
          )}
          {mountedTabs.has('REVENUE') && (
            <div style={{ display: activeTab === 'REVENUE' ? 'contents' : 'none' }}>
              <CraftLogPage />
            </div>
          )}
          {mountedTabs.has('ORDERS') && (
            <div style={{ display: activeTab === 'ORDERS' ? 'contents' : 'none' }}>
              <OrdersPage />
            </div>
          )}
          {mountedTabs.has('MINERAL_PRICES') && (
            <div style={{ display: activeTab === 'MINERAL_PRICES' ? 'contents' : 'none' }}>
              <MineralPricesPage />
            </div>
          )}
          {mountedTabs.has('HAUL_PLANNER') && (
            <div style={{ display: activeTab === 'HAUL_PLANNER' ? 'contents' : 'none' }}>
              <HaulPlannerPage />
            </div>
          )}
          {mountedTabs.has('INVENTORY') && (
            <div style={{ display: activeTab === 'INVENTORY' ? 'contents' : 'none' }}>
              <InventoryPage />
            </div>
          )}
          {mountedTabs.has('CHARACTERS') && (
            <div style={{ display: activeTab === 'CHARACTERS' ? 'contents' : 'none' }}>
              <CharactersPage />
            </div>
          )}
          {mountedTabs.has('MESSAGES') && (
            <div style={{ display: activeTab === 'MESSAGES' ? 'contents' : 'none' }}>
              <MessagesPage />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
