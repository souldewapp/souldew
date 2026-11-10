// "Buy me a coffee" – every few minutes a short Pokémon moment on the button (views/../lib/coffeefx.mjs decides when
// and which): real pixel sprites, 3–4 s, no sound, then the button is quiet again. Never during play.
import { html, useState, useEffect, useRef, useCallback } from '/vendor/htm-preact.mjs';
import { COFFEE_VARIANTS, nextDelay, pickVariant, variantSprite, fxBlocked } from '../lib/coffeefx.mjs';

const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * The timer. `isBusy()` is asked when a moment is due (a game running, fullscreen, boot, onboarding): then that one is
 * skipped and the next is planned. Returns `{ fx, clicked }` – fx = { id, at, mon } while one plays, `clicked()`
 * stops them for this session (the button did its job).
 * For trying the variants: `dispatchEvent(new CustomEvent('souldew:coffee-fx', { detail: 'peek' }))`.
 */
export function useCoffeeFx(isBusy) {
  const [fx, setFx] = useState(null);
  const st = useRef({ shown: 0, clicked: false, last: null });
  const busy = useRef(isBusy);
  busy.current = isBusy;

  const play = useCallback((id) => {
    const v = COFFEE_VARIANTS[id];
    if (!v) return;
    st.current.last = id;
    st.current.shown += 1;
    const start = (mon) => {
      const at = Date.now();
      setFx({ id, at, mon });
      setTimeout(() => setFx((cur) => (cur?.at === at ? null : cur)), v.ms + 100);
    };
    // the sprite is cached by the app after its first use; offline and never seen, the Poké Ball plays without it
    const img = new Image();
    img.onload = () => start(variantSprite(id));
    img.onerror = () => (id === 'ball' ? start(null) : setFx(null));
    img.src = variantSprite(id);
  }, []);

  useEffect(() => {
    let timer = 0;
    const plan = () => {
      timer = setTimeout(() => {
        const why = fxBlocked({
          busy: !!busy.current?.(), hidden: document.hidden, reducedMotion: reducedMotion(),
          dialogOpen: !!document.querySelector('dialog[open]'), clicked: st.current.clicked, shown: st.current.shown,
        });
        if (!why) play(pickVariant(st.current.last));
        if (why !== 'clicked' && why !== 'enough' && why !== 'reducedMotion') plan();
      }, nextDelay());
    };
    plan();
    const onTry = (e) => !reducedMotion() && play(COFFEE_VARIANTS[e.detail] ? e.detail : pickVariant(st.current.last));
    addEventListener('souldew:coffee-fx', onTry);
    return () => {
      clearTimeout(timer);
      removeEventListener('souldew:coffee-fx', onTry);
    };
  }, []);

  const clicked = useCallback(() => {
    st.current.clicked = true;
    setFx(null);
  }, []);
  return { fx, clicked };
}

/** Pixel art drawn as SVG rects – `rows` of characters, `.` = empty, others looked up in `colors`. */
function Pixels({ rows, colors, scale = 2, className }) {
  const rects = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== '.') rects.push(html`<rect x=${x} y=${y} width="1" height="1" fill=${colors[c]} />`);
  }));
  return html`<svg class=${className} width=${rows[0].length * scale} height=${rows.length * scale} viewBox=${`0 0 ${rows[0].length} ${rows.length}`}
    shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

const BALL = [
  '....KKKK....',
  '..KKRRRRKK..',
  '.KRRRRRRHRK.',
  '.KRRRRRRRRK.',
  'KRRRRKKRRRRK',
  'KKKKKWWKKKKK',
  'KWWWKWWKWWWK',
  'KWWWWKKWWWWK',
  '.KWWWWWWWWK.',
  '.KWWWWWWWSK.',
  '..KKWWWWKK..',
  '....KKKK....',
];
const BALL_COLORS = { K: '#1b1920', R: '#e4483e', H: '#ffb3a8', W: '#f3efe6', S: '#c9c3b8' };
const NOTE = ['...KK.', '...KKK', '...K.K', '...K..', '.KKK..', 'KKKK..', 'KKKK..', '.KK...'];
const ZED = ['ZZZZZ', '...Z.', '..Z..', '.Z...', 'ZZZZZ'];
const SPARK = ['..Y.', '.YY.', 'YYYY', '.YY.', '..Y.'];
// where the sparks fly to (px from the cup): Pikachu's cheeks, the Poké Ball's pop
const PEEK_SPARKS = [[-40, -26], [38, -30], [-46, 4], [44, 2]];
const POP_SPARKS = [[-24, -26], [22, -30], [0, -40], [-32, -6], [30, -8]];

/** One moment over the cup. Sits inside the coffee link; never takes clicks, hidden from screen readers. */
export function CoffeeFx({ fx }) {
  if (!fx) return null;
  const mon = fx.mon && html`<img class="cfx-sprite" src=${fx.mon} width="64" height="64" alt="" draggable="false" />`;
  return html`<span class=${`cfx cfx-${fx.id}`} key=${fx.at} aria-hidden="true">
    ${fx.id === 'peek' && html`<span class="cfx-mon">${mon}</span>
      ${PEEK_SPARKS.map(([dx, dy], i) => html`<span class="cfx-spark" style=${`--i:${i};--dx:${dx}px;--dy:${dy}px`}><${Pixels} rows=${SPARK} colors=${{ Y: '#ffe14a' }} /></span>`)}`}
    ${fx.id === 'nap' && html`<span class="cfx-mon">${mon}</span>${[0, 1, 2].map((i) => html`<span class="cfx-z" style=${`--i:${i}`}><${Pixels} rows=${ZED} colors=${{ Z: '#d4e0ff' }} /></span>`)}`}
    ${fx.id === 'ball' && html`<span class="cfx-pokeball"><${Pixels} rows=${BALL} colors=${BALL_COLORS} /></span><span class="cfx-flash"></span>
      ${mon && html`<span class="cfx-mon">${mon}</span>`}
      ${POP_SPARKS.map(([dx, dy], i) => html`<span class="cfx-spark" style=${`--i:${i};--dx:${dx}px;--dy:${dy}px`}><${Pixels} rows=${SPARK} colors=${{ Y: '#fff6c4' }} /></span>`)}`}
    ${fx.id === 'hop' && html`<span class="cfx-walk"><span class="cfx-mon">${mon}</span></span>
      ${[0, 1, 2].map((i) => html`<span class="cfx-note" style=${`--i:${i};--nx:${i * 48 - 6}px`}><${Pixels} rows=${NOTE} colors=${{ K: i === 1 ? '#9dc3ff' : '#ff9de6' }} /></span>`)}`}
  </span>`;
}
