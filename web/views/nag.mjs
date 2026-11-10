// A parody of the old shareware "please buy a license" window – deliberately in an old-Windows look on every platform.
// souldew is free: the window says thanks, jokes a bit and offers the coffee link. Esc, the × , the backdrop and both
// footer buttons close it; Settings › About switches it off. When it shows up: lib/nag.mjs.
import { html, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { openExternal } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { t } from '../lib/i18n.mjs';

/** Pixel art as SVG rects: `rows` of characters, `.` = empty. */
function Pixels({ rows, colors, scale = 2, className }) {
  const rects = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== '.' && colors[c]) rects.push(html`<rect x=${x} y=${y} width="1" height="1" fill=${colors[c]} />`);
  }));
  return html`<svg class=${className} width=${rows[0].length * scale} height=${rows.length * scale} viewBox=${`0 0 ${rows[0].length} ${rows.length}`}
    shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

// One ball (12×12): K outline, T top colour, H shine/marks, W bottom, S bottom shade.
const BALL = [
  '....KKKK....',
  '..KKTTTTKK..',
  '.KTTTTTTHTK.',
  '.KTHTTTTTTK.',
  'KTTTTKKTTTTK',
  'KKKKKWWKKKKK',
  'KWWWKWWKWWWK',
  'KWWWWKKWWWWK',
  '.KWWWWWWWWK.',
  '.KWWWWWWWSK.',
  '..KKWWWWKK..',
  '....KKKK....',
];

/**
 * souldew's own parody icon: three Poké Balls (Poké, Great, Ultra) in a wobbly stack, strapped together with a
 * leather belt and a brass buckle. Built once as a character grid.
 */
function buildIcon() {
  const W = 22;
  const H = 36;
  const g = Array.from({ length: H }, () => Array(W).fill('.'));
  const balls = [[5, 1, 'u'], [3, 12, 'g'], [6, 23, 'p']]; // x, y, kind – top to bottom, each a little off
  for (const [bx, by, kind] of balls) {
    BALL.forEach((row, y) => [...row].forEach((c, x) => {
      if (c === '.') return;
      g[by + y][bx + x] = c === 'T' || c === 'H' ? `${c}${kind}` : c;
    }));
  }
  // the belt: a thin leather strap down the whole stack …
  for (let y = 0; y < H; y++) {
    if (g[y].every((c) => c === '.')) continue;
    g[y][10] = 'b';
    g[y][11] = 'B';
  }
  // … a brass buckle on the middle ball, and the strap's loose end sticking out of it
  for (let y = 16; y <= 20; y++) for (let x = 8; x <= 13; x++) if (y === 16 || y === 20 || x === 8 || x === 13) g[y][x] = 'Y';
  for (const [x, y] of [[14, 18], [15, 18], [16, 18], [17, 19], [14, 19], [15, 19], [16, 19]]) g[y][x] = y === 18 ? 'B' : 'b';
  // grid → rows of single characters for <Pixels> (two-letter cells map to one-letter colour keys)
  const key = { Tp: 'r', Hp: 'h', Tg: 'n', Hg: 'm', Tu: 'k', Hu: 'j' };
  return g.map((row) => row.map((c) => key[c] || c).join(''));
}
const ICON = buildIcon();
const ICON_COLORS = {
  K: '#17151c', W: '#f4f1ea', S: '#c9c3b8',
  r: '#e0453b', h: '#ffb0a5', // Poké Ball
  n: '#3471d6', m: '#e0453b', // Great Ball (red marks)
  k: '#2c2b33', j: '#f2c94c', // Ultra Ball (yellow marks)
  b: '#4e2d12', B: '#8a5426', Y: '#e8c547', y: '#7a5a12', // belt and buckle
};
const SMALL_BALL_COLORS = { K: '#17151c', T: '#e0453b', H: '#ffb0a5', W: '#f4f1ea', S: '#c9c3b8' };
const CHECK = ['.......G', '......GG', 'G....GG.', 'GG..GG..', '.GGGG...', '..GG....'];
const CROSS = ['XX....XX', '.XX..XX.', '..XXXX..', '...XX...', '..XXXX..', '.XX..XX.', 'XX....XX'];

/** The window. `launches`: how often souldew was opened (for the joke). */
export function LicenseNag({ open, launches = 5, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    return undefined;
  }, [open]);
  useEffect(() => () => ref.current?.open && ref.current.close(), []);
  if (!open) return null;
  const close = () => onClose?.();
  const buy = () => {
    openExternal(LINKS.coffee);
    close();
  };
  const checks = [
    t('nag.c1', 'Unlimited Pokémon deaths'),
    t('nag.c2', 'Ready for your 47th Nuzlocke attempt'),
    t('nag.c3', 'Blame your partner, AES-256 encrypted'),
    t('nag.c4', 'Free updates for life (yours or your team’s, whichever ends first)'),
  ];
  return html`<dialog class="nag" ref=${ref} aria-labelledby="nag-title" aria-describedby="nag-free"
    onCancel=${(e) => { e.preventDefault(); close(); }} onClick=${(e) => e.target === e.currentTarget && close()}>
    <div class="nag-win">
      <div class="nag-titlebar">
        <${Pixels} rows=${BALL} colors=${SMALL_BALL_COLORS} scale=${1.25} className="nag-titleicon" />
        <span class="nag-titletext">${t('nag.titlebar', 'Please purchase souldew license (just kidding)')}</span>
        <button type="button" class="nag-x" onClick=${close} aria-label=${t('common.close', 'Close')} title=${t('common.close', 'Close')}>
          <${Pixels} rows=${CROSS} colors=${{ X: '#000' }} scale=${1} /></button>
      </div>
      <div class="nag-body">
        <div class="nag-icon"><${Pixels} rows=${ICON} colors=${ICON_COLORS} scale=${3} /></div>
        <div class="nag-main">
          <h2 class="nag-h" id="nag-title">${t('nag.thanks', 'Thank you for using souldew!')}</h2>
          <p class="nag-free" id="nag-free"><b>${t('nag.free', 'souldew IS a free software.')}</b> <i>${t('nag.seriously', '(Seriously.)')}</i></p>
          <p class="nag-trial">${t('nag.trial', 'You’ve opened souldew {n} time. Your free trial ends: never. Nothing gets locked – this window is the entire business model.|You’ve opened souldew {n} times. Your free trial ends: never. Nothing gets locked – this window is the entire business model.', { n: launches, count: launches })}</p>
          <ul class="nag-list">${checks.map((c) => html`<li><${Pixels} rows=${CHECK} colors=${{ G: '#1d9a2c' }} scale=${2} className="nag-check" /><span>${c}</span></li>`)}</ul>
          <div class="nag-price"><s class="nag-was">${t('nag.was', '$34.22')}</s>
            <span class="nag-pay">${t('nag.pay', 'You pay:')} <b>${t('nag.payWhat', 'whatever a coffee costs')}</b></span></div>
          <button type="button" class="nag-buy" onClick=${buy}>${t('rail.coffee', 'Buy me a coffee')}</button>
          <p class="nag-offer">${t('nag.offer', 'Act now, this is a one time offer!')}<sup>*</sup></p>
        </div>
      </div>
      <div class="nag-foot">
        <span class="nag-fine">${t('nag.fine', '* It isn’t. It’ll be back – like your rival.')}</span>
        <button type="button" class="nag-btn" onClick=${close}>${t('nag.remind', 'Remind me after my next wipe')}</button>
        <button type="button" class="nag-btn" onClick=${close} autofocus>${t('common.close', 'Close')}</button>
      </div>
    </div>
  </dialog>`;
}
