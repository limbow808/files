import { useState, useCallback, useRef } from 'react';
import EveText from './EveText';
import Loader from './shared/Loader';

/*
 * BootScreen — full-black HUD initialization overlay.
 *
 * Phase 0 – idle: accent button, corner brackets on hover
 * Phase 2 – calls /__start to launch backend, polls /api/ping until ready,
 *            then fades out and calls onBooted()
 */

export default function BootScreen({ onBooted }) {
  const [phase, setPhase] = useState(0);
  const [status, setStatus] = useState('> INITIALIZE');
  const pollingRef = useRef(false);

  const handleInit = useCallback(async () => {
    if (phase !== 0) return;
    setPhase(2);
    setStatus('> INITIALIZING');

    // Tell Vite dev server to spawn python server.py
    try { await fetch('/__start'); } catch (_) {}

    // Poll /api/ping until Flask is up
    pollingRef.current = true;
    const poll = async () => {
      if (!pollingRef.current) return;
      try {
        const res = await fetch('/api/ping', { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          // Flask is alive — now wait for the prewarm cache to be ready
          setStatus('> WARMING UP');
          const pollReady = async () => {
            if (!pollingRef.current) return;
            try {
              const rr = await fetch('/api/ready', { signal: AbortSignal.timeout(2000) });
              if (rr.ok) {
                const rd = await rr.json();
                if (rd.ready) {
                  pollingRef.current = false;
                  setTimeout(() => onBooted(), 400);
                  return;
                }
              }
            } catch (_) {}
            setTimeout(pollReady, 1500);
          };
          setTimeout(pollReady, 600);
          return;
        }
      } catch (_) {}
      setTimeout(poll, 600);
    };
    setTimeout(poll, 800); // first attempt after 800ms (startup time)
  }, [phase, onBooted]);

  return (
    <div className={`boot-overlay phase-${phase}`}>
      {/* Center button */}
      <div className="boot-center">
        <button
          className={`boot-btn ${phase > 0 ? 'boot-btn-fired' : ''}`}
          onClick={handleInit}
          disabled={phase > 0}
        >
          <span className="boot-btn-label">
            <EveText
              text={status}
              scramble={phase > 0}
              wave={phase > 0}
              speed={25}
              steps={8}
            />
          </span>
        </button>

        {/* Loader shown while initializing */}
        {phase > 0 && (
          <div style={{ marginTop: 32, display: 'flex', justifyContent: 'center' }}>
            <Loader size="lg" label="INITIALIZING SYSTEMS" />
          </div>
        )}

        {/* Corner brackets — only visible on hover */}
        <span className="boot-corner boot-corner-tl" />
        <span className="boot-corner boot-corner-tr" />
        <span className="boot-corner boot-corner-bl" />
        <span className="boot-corner boot-corner-br" />
      </div>
    </div>
  );
}
