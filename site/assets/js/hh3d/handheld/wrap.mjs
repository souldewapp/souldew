// Device skins ("wraps") for "Your handheld": printed vinyl whose art IS a banner, run by the app's public banner engine.
// A wrap is a banner recipe plus a few lines of composition: the banner's 56 rows become the landscape along the bottom of
// every panel, and the sky above is continued by the same engine (a second, sky-only recipe from the banner's own
// palette: its stars twinkle, its aurora waves, its clouds drift). One art pixel is PX mm on every device.
//
// The free wrap (Plain Dusk, from the free banner) ships here; the six souldew+ compositions come with the souldew+ pack
// (handheld/wraps.json), next to the banner recipes they need. The catalog (names, tiers) is shared/handheld.mjs.
//
//   const art = wrapArt(comp, recipe, panels) → { px (Uint32Array RGBA), w, h, rects, update(seconds) → changed?, animated }
// panels: [{ key, w, h (art px), cx (banner column at the panel's centre), base (panel row of the banner's last row),
//            word: [x, y] (panel px) | null }]
import { compile, H as BH } from '../cosmetics/banners/engine/index.mjs';
import { WORD_S } from '../cosmetics/banners/engine/brand.mjs';
import { content } from '../cosmetics/state.mjs';

export const PX = 0.6; // mm per art pixel: the wraps and the stickers, on every device

/** the free wrap's composition (made from the free "Plain Dusk" banner: a sky that just deepens, a quiet print) */
export const FREE_WRAPS = [
  { id: 'plain-dusk', banner: 'plain-dusk', t0: 0, cx: 192, zen: '#121019', plastic: '#1c1a26', keys: '#2a2638', dark: '#100e16', border: '#0c0b11', pulse: '#d6c4e0',
    ext: [['sky', { stops: ['zen', 's0'], at: [10, 54] }]], far: [['sky', { stops: ['zen', 'zen'], at: [0, 55] }]] },
];

const okComp = (c) => c && typeof c.id === 'string' && typeof c.banner === 'string' && Array.isArray(c.ext) && Array.isArray(c.far) && /^#[0-9a-f]{6}$/i.test(c.zen);

/** a wrap's composition (shared/handheld.mjs WRAPS has its name, tier and finish), or null when its data isn't here
 * (a souldew+ wrap without the pack) */
export function wrapComp(id) {
  const c = FREE_WRAPS.find((x) => x.id === id) || (content.handheld?.wraps || []).find((x) => x.id === id);
  return okComp(c) ? c : null;
}
/** the banner recipe a wrap is printed from (free set or the verified pack); null while it isn't in memory */
export const recipeOf = (comp) => (comp ? content.banners.get(comp.banner) || null : null);
/** can this wrap be drawn right now? */
export const wrapReady = (id) => !!recipeOf(wrapComp(id));

function frames(recipe, layers, seed) {
  const sc = compile({ ...recipe, layers, seed, intro: false, calm: [0, 0, 0, 0], pan: false }, { width: 384 });
  sc.noIntro = true;
  return { sc, out: new Uint32Array(sc.W * BH) };
}

/** the art for one wrap and a list of panels: one atlas (panels stacked in a column with a 2-px gutter) */
export function wrapArt(comp, recipe, panels, { reduced = false } = {}) {
  if (!comp || !recipe) return null;
  const pal = { ...recipe.pal, zen: comp.zen };
  const base = { ...recipe, pal };
  const banner = frames(base, recipe.layers, recipe.seed);
  const near = frames(base, comp.ext, (recipe.seed || 1) + 101);
  const far = frames(base, comp.far, (recipe.seed || 1) + 202);
  const far2 = frames(base, comp.far, (recipe.seed || 1) + 303);
  let y = 0;
  const W = Math.max(...panels.map((p) => p.w)) + 4;
  const rects = {};
  for (const p of panels) { rects[p.key] = { x: 2, y: y + 2, w: p.w, h: p.h, p }; y += p.h + 4; }
  const H = y;
  const px = new Uint32Array(W * H);
  // the wordmark's ink: the palette colour that sits best on the sky (a quiet print, not a logo stamp)
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const zen = hex(comp.zen);
  const cands = Object.values(pal).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map(hex).filter((c) => Math.abs(lum(c) - lum(zen)) > 28 && Math.abs(lum(c) - lum(zen)) < 90);
  const aim = lum(zen) < 128 ? 50 : -40;
  cands.sort((a, b) => Math.abs(lum(a) - lum(zen) - aim) - Math.abs(lum(b) - lum(zen) - aim));
  const ink = cands[0] || (lum(zen) < 128 ? [200, 200, 210] : [40, 40, 50]);
  const ink32 = ((255 << 24) | (ink[2] << 16) | (ink[1] << 8) | ink[0]) >>> 0;
  let lastT = -1;
  const t0 = comp.t0 || 0;
  const still = recipe.still ?? t0;
  const fps = recipe.fps || 10;

  function update(sec) {
    const t = reduced ? still : t0 + sec;
    const tq = Math.floor(t * fps) / fps; // the banner's own frame rate: whole frames
    if (tq === lastT) return false;
    lastT = tq;
    for (const f of [banner, near, far, far2]) f.sc.frame(tq, f.out);
    for (const p of panels) {
      const r = rects[p.key];
      const x0 = Math.round(p.cx - p.w / 2);
      for (let j = 0; j < p.h; j++) {
        const row = j - (p.base - BH); // row inside the banner (0..55); < 0 = sky above, ≥ 56 = ground below
        let src, sy;
        if (row >= 0 && row < BH) { src = banner; sy = row; } else if (row >= BH) { src = banner; sy = BH - 4 + ((row - BH) % 4); } // the ground: its bottom 4 rows repeat (keeps the dither)
        else {
          const k = Math.floor(-row / BH); // 0 = the block just above the banner, then further up
          src = k === 0 ? near : k % 2 ? far : far2;
          sy = BH - 1 - ((-row - 1) % BH);
        }
        const so = sy * 384, d = (r.y + j) * W + r.x;
        for (let i = 0; i < p.w; i++) px[d + i] = src.out[so + ((((x0 + i) % 384) + 384) % 384)];
      }
      if (p.word) {
        const [wx, wy] = p.word;
        WORD_S.forEach((rw, j) => [...rw].forEach((ch, i) => { if (ch === 'a') px[(r.y + wy + j) * W + r.x + wx + i] = ink32; }));
      }
    }
    return true;
  }
  update(0);
  return { px, w: W, h: H, rects, update, animated: !reduced && (banner.sc.animated || near.sc.animated) };
}

/** the art as a canvas (the page's half: a texture, a card) – `art.update()` then `paint()` again */
export function wrapCanvas(art) {
  const c = document.createElement('canvas');
  c.width = art.w;
  c.height = art.h;
  const g = c.getContext('2d');
  const img = g.createImageData(art.w, art.h);
  const paint = () => {
    new Uint32Array(img.data.buffer).set(art.px);
    g.putImageData(img, 0, 0);
  };
  paint();
  return { canvas: c, paint };
}

const thumbs = new Map();
/** a skin card's picture: the art at its own pixels (a window onto the wrap), as a data: URL; null without its data */
export function wrapThumb(id) {
  const comp = wrapComp(id);
  const recipe = recipeOf(comp);
  if (!recipe) return null;
  const key = `${id}@${content.banners.get(comp.banner) === recipe ? 1 : 0}`;
  if (thumbs.has(key)) return thumbs.get(key);
  const art = wrapArt(comp, recipe, [{ key: 't', w: 112, h: 74, cx: comp.cx + 20, base: 72, word: null }], { reduced: true });
  const url = wrapCanvas(art).canvas.toDataURL();
  thumbs.set(key, url);
  return url;
}
