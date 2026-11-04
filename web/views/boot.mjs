import { html, useEffect, useState } from '/vendor/htm-preact.mjs';
import { play, preload } from '../lib/sound.mjs';

/** Power-on sequence: the wordmark scrolls down an LCD while the boot sound swells, then the rings light up. */
export function BootScreen({ onDone, sound = true }) {
  const [phase, setPhase] = useState('play');
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (sound) preload('boot');
    // The animation follows the sound (styles.css "boot"): it starts with it, the wordmark lands on its peak, the
    // rings' glow fades with its tail (2 s), then about a second of standing still before the fade-out.
    const chime = setTimeout(() => play('boot', sound), 50);
    const out = setTimeout(() => setPhase('out'), reduced ? 900 : 3000);
    const done = setTimeout(onDone, reduced ? 1300 : 3450);
    const skip = (e) => {
      if (e.type === 'keydown' && e.metaKey) return;
      clearTimeout(chime);
      clearTimeout(out);
      clearTimeout(done);
      onDone();
    };
    addEventListener('keydown', skip);
    return () => {
      clearTimeout(chime);
      clearTimeout(out);
      clearTimeout(done);
      removeEventListener('keydown', skip);
    };
  }, []);
  return html`<div class=${`boot ${phase === 'out' ? 'run out' : 'run'}`} onClick=${onDone} role="presentation">
    <div class="boot-screen">
      <div class="boot-logo">
        <span class="word">souldew</span>
        <!-- the app icon's two rings: player 1 blue, player 2 pink, glowing on the LCD -->
        <svg class="boot-rings" viewBox="0 0 32 16" shape-rendering="crispEdges" aria-hidden="true">
          <path fill="#8cb0ff" d="M4 2h6v2H4zM2 4h2v8H2zM10 4h2v2h-2zM10 10h2v2h-2zM4 12h6v2H4z" />
          <path fill="#ff8fdc" d="M22 2h6v2h-6zM28 4h2v8h-2zM20 4h2v2h-2zM20 10h2v2h-2zM22 12h6v2h-6z" />
          <path fill="#f2ffdc" d="M12 6h8v4h-8z" />
        </svg>
      </div>
    </div>
  </div>`;
}
