import { useState, useEffect, useRef, memo } from 'react';

/* ── Scramble character set — EVE / Matrix style ─────────────────── */
const GLYPHS = '░▒▓█╔╗╚╝─│┌┐└┘◈◆◇▪▫●○◊0123456789ABCDEF';

/**
 * EveText — text that "decrypts" from random glyphs to the final string,
 * then optionally continues as a wave-glow loop.
 *
 * Props:
 *   text      — final display string
 *   scramble  — enable scramble-reveal on mount/change (default true)
 *   wave      — enable looping wave-glow after reveal  (default false)
 *   speed     — ms per scramble step (default 35)
 *   steps     — number of scramble iterations (default 12)
 *   className — extra classes
 *   style     — extra styles
 *   as        — wrapper element (default 'span')
 */
function EveText({
  text = '',
  scramble = true,
  wave = false,
  speed = 35,
  steps = 12,
  className = '',
  style = {},
  as: Tag = 'span',
}) {
  const nodeRef  = useRef(null);
  // liveTxt mirrors what the DOM shows during scramble — keeps React's
  // virtual DOM in sync so if a re-render is forced it won't flash blank.
  const liveTxt  = useRef(scramble ? '' : text);
  const [waveReady, setWaveReady] = useState(!scramble);

  useEffect(() => {
    if (!scramble) {
      liveTxt.current = text;
      if (nodeRef.current) nodeRef.current.textContent = text;
      setWaveReady(true);
      return;
    }

    setWaveReady(false);
    liveTxt.current = '';
    let step = 0;
    const len = text.length;
    let timer = null;

    // Chained setTimeout — never piles up under heavy JS load the way
    // setInterval does. Each tick runs, then schedules the next.
    const tick = () => {
      step++;
      const out = text.split('').map((ch, i) => {
        if (i < (step / steps) * len) return ch;
        if (ch === ' ') return ' ';
        return GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }).join('');

      // Direct DOM write — zero React re-renders during scramble.
      // liveTxt.current stays in sync so a forced re-render shows the
      // same content React would compute, avoiding any visual flash.
      liveTxt.current = out;
      if (nodeRef.current) nodeRef.current.textContent = out;

      if (step >= steps) {
        liveTxt.current = text;
        if (nodeRef.current) nodeRef.current.textContent = text;
        setWaveReady(true); // single state update — triggers wave/final render
      } else {
        timer = setTimeout(tick, speed);
      }
    };

    timer = setTimeout(tick, speed);
    return () => { if (timer) clearTimeout(timer); };
  }, [text, scramble, speed, steps]);

  // Wave mode: render per-character spans with staggered animation
  if (waveReady && wave) {
    return (
      <Tag className={`eve-scramble ${className}`} style={style}>
        {text.split('').map((ch, i) => (
          <span
            key={i}
            className="eve-wave-char"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        ))}
      </Tag>
    );
  }

  // Revealed, no wave — plain React render
  if (waveReady) {
    return (
      <Tag className={`eve-scramble ${className}`} style={style}>
        {text || '\u00A0'}
      </Tag>
    );
  }

  // Scrambling phase: DOM managed directly via nodeRef.
  // liveTxt.current is rendered as children so any React-forced re-render
  // writes back the same text that the tick already set — no flickering.
  return (
    <Tag ref={nodeRef} className={`eve-scramble ${className}`} style={style}>
      {liveTxt.current || '\u00A0'}
    </Tag>
  );
}

export default memo(EveText);
