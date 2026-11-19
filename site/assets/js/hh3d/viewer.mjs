// "Your handheld" on the website: the app's own 3D scene (handheld/scene.mjs, three.js r180 – copied from web/lib/
// handheld and web/vendor/three, GPL-3.0 like the app) posed still and turned by the visitor. Only free content: the
// "Your colours" shell, the free Plain Dusk skin and the free stickers (web/assets/handheld). Nothing from the souldew+
// pack is ever loaded here. Loaded on demand by site30.js; renders only when something changed.
import * as S from './handheld/scene.mjs';
import { layoutKey } from './handheld/layouts.mjs';
import { placeLayout } from './handheld/geometry.mjs';
import { decodeLayout, stackAtlases } from './handheld/atlas.mjs';
import { wrapComp, recipeOf } from './handheld/wrap.mjs';

const VIEWS = {
  gba: { lid: 0, tilt: 6, yaw: 18, dist: 430, target: [0, 8, 11] },
  nds: { lid: 150, tilt: 44, yaw: -12, dist: 470, target: [0, 20, -26] },
};
const STICKERS = {
  gba: [
    { id: 'star', finish: 'vinyl', region: 'body:top', U: [-64, -30], rot: 0.2, scale: 1.2 },
    { id: 'dew', finish: 'vinyl', region: 'body:top', U: [-54, -21], rot: 0.1, scale: 1 },
    { id: 'heart', finish: 'vinyl', region: 'body:top', U: [54, 27], rot: -0.2, scale: 1.05 },
    { id: 'gg', finish: 'vinyl', region: 'body:top', U: [-62, 25], rot: -0.12, scale: 0.95 },
    { id: 'one-hp', finish: 'vinyl', region: 'body:top', U: [58, -27], rot: 0.14, scale: 0.9 },
    { id: 'cloud', finish: 'vinyl', region: 'body:top', U: [-30, 31], rot: 0.06, scale: 0.8 },
  ],
  nds: [
    { id: 'heart', finish: 'vinyl', region: 'lid:top', U: [-18, 21], rot: -0.1, scale: 1.2 },
    { id: 'moon', finish: 'vinyl', region: 'lid:top', U: [52, -18], rot: 0.22, scale: 1 },
    { id: 'star', finish: 'vinyl', region: 'lid:top', U: [-52, -22], rot: 0.2, scale: 1.2 },
    { id: 'gg', finish: 'vinyl', region: 'lid:top', U: [40, 20], rot: -0.12, scale: 0.9 },
    { id: 'sparkle', finish: 'vinyl', region: 'deck:top', U: [-50, 17], rot: 0.2, scale: 0.9 },
    { id: 'rip', finish: 'vinyl', region: 'deck:top', U: [52, 16], rot: -0.1, scale: 0.8 },
  ],
};

async function decodePng(url) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, c.width, c.height).data;
}
async function loadAtlas(base) {
  const layout = await (await fetch(`${base}stickers.json`)).json();
  const L = decodeLayout(layout);
  const [rgba, cut] = await Promise.all([decodePng(`${base}stickers.png`), decodePng(`${base}stickers-cut.png`)]);
  const sdf = new Uint8ClampedArray(cut.length / 4);
  for (let i = 0; i < sdf.length; i++) sdf[i] = cut[i * 4];
  return stackAtlases([{ ...L, rgba: new Uint8ClampedArray(rgba), sw: L.w * L.sdfS, sh: L.h * L.sdfS, sdf }, null]);
}

/**
 * mount(host, { atlasBase, sys, skin: 'colours' | 'plain-dusk', shell, stickers: bool, reduced, label }) → controller
 * { set(patch), dispose() }. The scene draws into a canvas made inside `host` (a new one per rebuild – a canvas keeps its
 * WebGL context). Drag (pointer) or the arrow keys turn the device; with motion allowed it sways slowly when untouched.
 */
export async function mount(host, opts) {
  const atlas = await loadAtlas(opts.atlasBase);
  let o = { sys: 'gba', skin: 'colours', shell: '#5b6b8c', stickers: true, ...opts };
  let sc = null, orbit = { yaw: 0, tilt: 0 }, sway = 0, raf = 0, dirty = true, visible = true, alive = true, building = null;
  let canvas = null;
  const size = () => {
    const r = host.getBoundingClientRect();
    return { w: Math.max(200, Math.round(r.width)), h: Math.max(150, Math.round(r.height)) };
  };
  const build = async () => {
    const { w, h } = size();
    const prev = sc;
    const comp = o.skin === 'plain-dusk' ? wrapComp('plain-dusk') : null;
    const recipe = comp ? recipeOf(comp) : null;
    const fold = o.sys === 'nds';
    const cv = document.createElement('canvas');
    cv.className = 'hh3d-canvas';
    const next = await S.createScene(cv, {
      sys: o.sys, lk: layoutKey(o.sys, 'tb', 'tb'), w, h, final: { x: w * 0.3, y: h * 0.2, w: w * 0.4, h: h * 0.6 }, dark: true,
      look: 'theme', looks: null, shell: o.shell, clearTint: '#a9d8f2', cartColor: '#3c3b44', cover: null, title: '',
      pulse: '#fff4e0', glow: '#dfe8ff', picture: 'placeholder', keep: false, atlas, fov: 26,
      plan: () => {
        const V = VIEWS[o.sys];
        return { lid: V.lid, cart: fold ? 999 : 0, power: [-2000, -2000], led: 1, shadow: 1, clean: 0, canvasO: 1, glassOff: 0.35,
          cam: { tilt: V.tilt + orbit.tilt, yaw: V.yaw + orbit.yaw + sway, dist: V.dist * (w < 560 ? 0.92 : 0.8), target: V.target } };
      },
      hh: { skin: comp ? { ...comp, finish: 'satin' } : null, recipe, reduced: !!o.reduced },
    });
    next.setStickers(o.stickers ? placeLayout(STICKERS[o.sys], next.regions(), atlas.rects) : []);
    next.render(1000);
    const old = canvas;
    host.append(cv);
    canvas = cv;
    prev?.dispose();
    old?.remove();
    sc = next;
    dirty = true;
  };
  const rebuild = () => { building = (building || Promise.resolve()).then(() => (alive ? build() : null)); return building; };
  await rebuild();

  // drag to turn
  let drag = null;
  host.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: orbit.yaw, tilt: orbit.tilt }; host.setPointerCapture(e.pointerId); host.classList.add('grabbing'); });
  host.addEventListener('pointermove', (e) => {
    if (!drag) return;
    orbit.yaw = drag.yaw + (e.clientX - drag.x) * 0.45;
    orbit.tilt = Math.max(-24, Math.min(30, drag.tilt + (e.clientY - drag.y) * 0.25));
    dirty = true;
  });
  const end = () => { drag = null; host.classList.remove('grabbing'); };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -12, ArrowRight: 12 }[e.key];
    if (d) { e.preventDefault(); orbit.yaw += d; dirty = true; }
  });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(host);
  let lastW = 0;
  new ResizeObserver(() => { const { w, h } = size(); if (sc && Math.abs(w - lastW) > 2) { lastW = w; sc.resize(w, h); dirty = true; } }).observe(host);

  const t0 = performance.now();
  const loop = (t) => {
    raf = requestAnimationFrame(loop);
    if (!visible || !sc) return;
    if (!o.reduced && !drag) {
      sway = Math.sin((t - t0) / 2600) * 9;
      dirty = true;
    }
    if (dirty) { sc.render(1000); dirty = false; }
  };
  raf = requestAnimationFrame(loop);

  return {
    async set(patch) {
      const needs = ['sys', 'skin', 'shell', 'stickers'].some((k) => k in patch && patch[k] !== o[k]);
      o = { ...o, ...patch };
      if ('sys' in patch) orbit = { yaw: 0, tilt: 0 };
      if (needs) await rebuild();
    },
    dispose() { alive = false; cancelAnimationFrame(raf); sc?.dispose(); canvas?.remove(); },
  };
}
