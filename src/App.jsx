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
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab]   = useState('CREST');
  const [booted, setBooted]         = useState(false);
  const [bootAnim, setBootAnim]     = useState(''); // '' | 'booting' | 'booted'
  const timerRef = useRef(null);

  const { loading: scanLoading, error: scanError, refetch } =
    useApi(`${API}/api/scan`,           [refreshKey]);
  const { data: plexData, loading: plexLoading, error: plexError } =
    useApi(`${API}/api/plex`,           [refreshKey]);
  const { data: walletRaw } =
    useApi(`${API}/api/wallet/history`, [refreshKey]);
  // Lightweight ping — resolves as soon as Flask is up, independent of slow scan
  const { loading: pingLoading, error: pingError } =
    useApi(`${API}/api/ping`,           []);

  const walletHistory = Array.isArray(walletRaw) ? walletRaw : null;
  const online = !scanError;
  const backendAlive = !pingError;

  // Once Flask is alive, poll /api/ready until the prewarm cache is populated,
  // then auto-boot.  This ensures tables never load into a cold-cache state.
  useEffect(() => {
    if (!backendAlive || pingLoading || booted) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${API}/api/ready`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const data = await res.json();
          if (data.ready) {
            if (!cancelled) { setBooted(true); setBootAnim('booted'); }
            return;
          }
        }
      } catch (_) {}
      setTimeout(poll, 1500);
    };
    poll();
    return () => { cancelled = true; };
  }, [backendAlive, pingLoading, booted]);

  useEffect(() => {
    timerRef.current = setInterval(() => setRefreshKey(k => k + 1), AUTO_REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const handleBooted = useCallback(() => {
    setBooted(true);
    setBootAnim('booted');
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }

  // Show boot screen only when backend is confirmed unreachable (ping failed)
  const showBoot = !booted && !backendAlive && !pingLoading;

  return (
    <>
      {showBoot && <BootScreen onBooted={handleBooted} />}
      <div className={`app-shell ${!booted ? 'hud-booting' : ''} ${bootAnim === 'booted' ? 'hud-booted' : ''}`}>
        <Header key={booted ? 'booted' : 'pre'} online={online} activeTab={activeTab} onTabChange={setActiveTab} onRefresh={handleRefresh} refreshing={refreshing || scanLoading} />
        <div className="app-content" key={booted ? 'content-booted' : 'content-pre'}>
          {/* All pages stay mounted so their data/state survives tab switches.
              Inactive pages are hidden with display:none — zero re-fetches. */}
          <div style={{ display: activeTab === 'CREST' ? 'contents' : 'none' }}>
            <OverviewPage
              plexData={plexData}
              walletHistory={walletHistory}
              plexLoading={plexLoading}
              plexError={plexError}
              refreshKey={refreshKey}
            />
          </div>
          <div style={{ display: activeTab === 'CALCULATOR' ? 'contents' : 'none' }}>
            <CalculatorPage refreshKey={refreshKey} />
          </div>
          <div style={{ display: activeTab === 'CHARACTERS' ? 'contents' : 'none' }}>
            <CharactersPage />
          </div>
          <div style={{ display: activeTab === 'BP FINDER' ? 'contents' : 'none' }}>
            <BpFinderPage refreshKey={refreshKey} />
          </div>
          <div style={{ display: activeTab === 'CRAFT LOG' ? 'contents' : 'none' }}>
            <CraftLogPage />
          </div>
        </div>
      </div>
    </>
  );
}
