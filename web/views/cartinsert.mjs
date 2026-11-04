// Starting or continuing a game: the module slides into the console's slot and clicks in – the game boots
// underneath meanwhile (kept invisible until this is over, play.mjs), so it costs no time. A click or key skips
// it; Settings › "Play animations" turns it off.
import { html, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Cart, coverOf } from './library.mjs';
import { play, preload } from '../lib/sound.mjs';

const LENGTH = 1500; // ms – matches the keyframes in styles.css (.cart-insert)
const HOME_AT = 900; // the module is pushed home at 60 % of ci-drop
const CLICK_LEAD = 68; // the click in cart-insert.wav comes this long after its start

/** The picture on the module: the player's own cover first, then the catalog's (a hack: its base game). */
export function insertCover(library, target, manifest) {
  if (target.runId) return coverOf(library, { gameId: target.gameId || manifest?.game?.id, hackId: manifest?.game?.hackId || manifest?.patch?.hackId });
  const rom = library?.roms?.find((r) => r.id === target.params?.rom);
  const hackId = target.params?.patch ? library?.patches?.find((p) => p.id === target.params.patch)?.hackId : null;
  return coverOf(library, { gameId: target.gameId, hackId, rom });
}

/** sound: the app's sounds setting (the click is an app sound – the game's volume doesn't turn it down) */
export function CartInsert({ target, color, sound = true, onDone }) {
  const { library, manifest } = useApp();
  const done = useRef(onDone);
  done.current = onDone;
  const clicked = useRef(false);
  const skipRef = useRef(null);
  useEffect(() => {
    preload('cartInsert');
    const click = () => {
      if (clicked.current) return;
      clicked.current = true;
      play('cartInsert', sound);
    };
    const timer = setTimeout(click, HOME_AT - CLICK_LEAD);
    const end = setTimeout(() => done.current?.(), LENGTH);
    // skipped: the module is home right now – it still clicks
    const skip = () => {
      click();
      done.current?.();
    };
    skipRef.current = skip;
    addEventListener('keydown', skip, { once: true });
    return () => {
      clearTimeout(timer);
      clearTimeout(end);
      removeEventListener('keydown', skip);
    };
  }, []);
  const kind = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds' }[target.system] || 'gb';
  return html`<div class=${`cart-insert ci-${kind}`} onClick=${() => skipRef.current?.()} aria-hidden="true">
    <div class="ci-stage">
      <div class="ci-cart"><${Cart} big title=${target.label} cover=${insertCover(library, target, manifest)} color=${color} system=${target.system} /></div>
      <div class="ci-console">
        <div class="ci-slot"></div>
        <div class="ci-face"><span class="ci-led"></span><span class="ci-power">POWER</span></div>
      </div>
    </div>
  </div>`;
}
