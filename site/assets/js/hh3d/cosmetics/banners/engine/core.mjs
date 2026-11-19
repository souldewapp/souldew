// souldew+ banner engine – core. Dependency-free ES module, runs in the browser (runtime.mjs) and in Node (tools/).
//
// A banner is a RECIPE (plain data: palette + ordered layers). compile(recipe, {width}) turns it into an indexed
// pixel scene at native resolution (H = 56 rows, width = whatever the box needs at an integer scale) and returns
// frame(t, out32): a pure function of time. Every animated part is periodic, so the scene never "resets".
//
// Pixel rules enforced here: one palette per banner (≤ 16 colours), every pixel is a palette index, no blending –
// soft transitions only through the 4×4 ordered (Bayer) matrix or palette remaps that pick an existing colour.

export const H = 56;            // native rows (the profile strip: 160 css px ≈ 56 px × 3 at 1×, × 6 at 2×)
export const DW = 384;          // design frame width; scenes extend procedurally to the left and right of it
export const PAD = 8;           // extra columns on both sides so layers can pan without running out
export const T = 255;           // transparent index inside layer bitmaps
export const MAX_COLOURS = 16;

// ------------------------------------------------------------------ random, hashing, noise (all deterministic)
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function h1(i, s = 0) {
  let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((s | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 15; h = Math.imul(h, 0x165667b1); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export const h2 = (x, y, s = 0) => h1(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663), s);
const mod = (a, n) => ((a % n) + n) % n;
const smooth = f => f * f * (3 - 2 * f);
export function noise1(x, s = 0, period = 0) {
  const i = Math.floor(x), f = x - i;
  const a = h1(period ? mod(i, period) : i, s), b = h1(period ? mod(i + 1, period) : i + 1, s);
  return a + (b - a) * smooth(f);
}
export function fbm1(x, s = 0, oct = 4) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += a * noise1(x * f, s + o * 101); n += a; a *= 0.5; f *= 2.07; }
  return v / n;
}
export function noise2(x, y, s = 0, px = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
  const X = i => (px ? mod(i, px) : i);
  const a = h2(X(ix), iy, s), b = h2(X(ix + 1), iy, s), c = h2(X(ix), iy + 1, s), d = h2(X(ix + 1), iy + 1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm2(x, y, s = 0, oct = 4, px = 0) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += a * noise2(x * f, y * f, s + o * 101, px ? px * f : 0); n += a; a *= 0.5; f *= 2; }
  return v / n;
}

// ------------------------------------------------------------------ ordered dither
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** true where a fill of strength f (0..1) sets this pixel – the only "blend" the engine knows */
export const od = (x, y, f) => f * 16 > BAYER[((y & 3) << 2) | (x & 3)] + 0.5;

// ------------------------------------------------------------------ colour
export function hex(c) { c = c.replace('#', ''); return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]; }
export const mixRGB = (a, b, t) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
export function dist(a, b) { const r = (a[0] + b[0]) / 2, dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]; return (2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db; }
export const luma = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

// ------------------------------------------------------------------ bitmaps (indexed, T = transparent)
export function bitmap(w, h, fill = T) { const d = new Uint8Array(w * h); if (fill !== 0) d.fill(fill); return { w, h, d }; }
export function put(bm, x, y, c) { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < bm.w && y < bm.h) bm.d[y * bm.w + x] = c; }
export function get(bm, x, y) { x |= 0; y |= 0; return x >= 0 && y >= 0 && x < bm.w && y < bm.h ? bm.d[y * bm.w + x] : T; }
export function rect(bm, x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(bm, x + i, y + j, c); }
export function hline(bm, x0, x1, y, c) { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) put(bm, x, y, c); }
export function vline(bm, x, y0, y1, c) { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) put(bm, x, y, c); }
export function line(bm, x0, y0, x1, y1, c) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) { put(bm, x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
}
export function disc(bm, cx, cy, r, c, test) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r * r + r * 0.6 && (!test || test(x, y, dx, dy))) put(bm, x, y, c);
  }
}
export function ellipse(bm, cx, cy, rx, ry, c, test) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry; if (dx * dx + dy * dy <= 1.02 && (!test || test(x, y, dx, dy))) put(bm, x, y, c);
  }
}
/** scanline polygon fill (even-odd); pts = [[x,y],…] */
export function poly(bm, pts, c) {
  let y0 = Infinity, y1 = -Infinity; for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const xs = []; const yc = y + 0.5;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) put(bm, x, y, c);
  }
}
/** draw bitmap src into dst at x,y (transparent skipped); flip mirrors horizontally; map remaps indices */
export function blit(dst, src, x, y, flip = false, map = null) {
  for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) {
    let v = src.d[j * src.w + (flip ? src.w - 1 - i : i)]; if (v === T) continue; if (map) v = map[v]; put(dst, x + i, y + j, v);
  }
}

// ------------------------------------------------------------------ the layer registry
export const LAYERS = Object.create(null);
export function layer(name, fn) { LAYERS[name] = fn; }

// ------------------------------------------------------------------ compile
/**
 * recipe = { id, name, seed, pal: {name: '#rrggbb', …}, layers: [[type, params], …],
 *            loop?: seconds (default 24), fps?: (default 12), pan?: {amp, period}, still?: t for the static frame,
 *            calm?: [x, y, w, h] screen-space rectangle effects keep out of (default: the avatar corner) }
 * opts   = { width: native columns (default DW) }
 */
export function compile(recipe, opts = {}) {
  const W = Math.max(16, opts.width | 0 || DW);
  const Wb = W + PAD * 2;
  const x0 = Math.round((DW - W) / 2) - PAD;   // design-frame x of bitmap column 0
  const names = Object.keys(recipe.pal);
  if (names.length > MAX_COLOURS) throw new Error(`${recipe.id}: ${names.length} colours (max ${MAX_COLOURS})`);
  const rgb = names.map(n => hex(recipe.pal[n]));
  const pal = Object.fromEntries(names.map((n, i) => [n, i]));
  const L = recipe.loop || 24;
  const ctx = {
    recipe, W, Wb, H, x0, L, rgb, pal, names,
    seed: recipe.seed ?? 1,
    surf: Object.create(null),            // id → (wx) => top y   (ridges register, trees/sprites sit on them)
    lights: [],                           // windows etc. for blink effects
    accum: bitmap(Wb, H, T),              // flattened static scene so far (water reflects it)
    calm: recipe.calm || [0, 26, 64, 30], // screen-space: where the avatar sits
    c(n) { if (typeof n === 'number') return n; if (!(n in pal)) throw new Error(`${recipe.id}: unknown colour "${n}"`); return pal[n]; },
    wx(bx) { return bx + x0; },           // bitmap column → design x
    bx(wx) { return wx - x0; },           // design x → bitmap column
    full() { return bitmap(Wb, H, T); },
    inCalm(sx, y) { const [cx, cy, cw, ch] = this.calm; return sx >= cx && sx < cx + cw && y >= cy && y < cy + ch; },
    nearest(target, allow) { let best = 0, bd = Infinity; for (let i = 0; i < rgb.length; i++) { if (allow && !allow.includes(i)) continue; const d = dist(target, rgb[i]); if (d < bd) { bd = d; best = i; } } return best; },
    /** palette remap: every colour pulled toward `to` by amt, snapped to the nearest existing colour */
    lut(to, amt, allow) { const t = typeof to === 'string' && to[0] !== '#' ? rgb[this.c(to)] : (Array.isArray(to) ? to : hex(to)); const m = new Uint8Array(256); for (let i = 0; i < 256; i++) m[i] = i; for (let i = 0; i < rgb.length; i++) m[i] = this.nearest(mixRGB(rgb[i], t, amt), allow && allow.map(a => this.c(a))); return m; },
    rand(salt = 0) { return rng((this.seed * 7919 + salt * 104729) >>> 0); },
    // periodic helpers: every animation is a whole number of cycles per loop, so frame(t) === frame(t + L·k)
    cyc(per) { return Math.max(1, Math.round(this.L / per)); },          // cycles per loop for a wanted period
    phase(t, cycles) { return ((t / this.L) * cycles) % 1; },
  };

  const items = [];
  for (const [type, p0] of recipe.layers) {
    const fn = LAYERS[type]; if (!fn) throw new Error(`${recipe.id}: unknown layer "${type}"`);
    const p = p0 || {};
    const res = fn(ctx, p);
    if (!res) continue;
    for (const it of Array.isArray(res) ? res : [res]) {
      it.depth = it.depth ?? p.depth ?? 0;
      it.type = type;
      items.push(it);
      if (it.bm) blit(ctx.accum, it.bm, 0, 0);
      else if (it.bake) it.bake(ctx.accum);
    }
  }

  // intro: one-time layers that play when the profile opens (their own clock: ctx.L = intro length), then the idle loop
  const intro = recipe.intro === false ? null : { dur: 2.2, reveal: 'fall', fade: 1.1, layers: [], ...(recipe.intro || {}) };
  const introItems = [];
  if (intro) {
    const ictx = Object.create(ctx); ictx.L = intro.dur; ictx.lights = [];
    for (const [type, p0] of intro.layers) { const res = LAYERS[type](ictx, p0 || {}); for (const it of [].concat(res || [])) { it.depth = it.depth ?? p0?.depth ?? 0; if (it.draw) introItems.push(it); } }
  }
  const bg = hex(recipe.plateBg || '#1b1a1f');
  const dark1 = ctx.lut(bg, 0.5), dark2 = ctx.lut(bg, 0.9);

  // flatten runs of static bitmaps that share a depth – most banners end up as 3–6 blits per frame
  const flat = [];
  for (const it of items) {
    const prev = flat[flat.length - 1];
    if (it.bm && prev && prev.bm && prev.depth === it.depth) { const m = bitmap(Wb, H, T); blit(m, prev.bm, 0, 0); blit(m, it.bm, 0, 0); flat[flat.length - 1] = { bm: m, depth: it.depth, type: prev.type + '+' + it.type }; }
    else flat.push(it);
  }

  const pan = recipe.pan === false ? null : { amp: 2, period: L, ...(recipe.pan || {}) };
  const animated = flat.some(it => it.draw) || (pan && pan.amp > 0 && new Set(flat.map(i => i.depth)).size > 1);
  const fb = new Uint8Array(W * H);
  const pal32 = new Uint32Array(256);
  rgb.forEach((c, i) => { pal32[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]; });
  pal32[254] = (255 << 24) | (bg[2] << 16) | (bg[1] << 8) | bg[0];   // the UI row colour – only nameplates use it

  function offset(depth, t) { return pan && depth ? Math.round(pan.amp * depth * Math.sin((2 * Math.PI * t) / pan.period)) : 0; }
  // segments: runs of static bitmaps between animated layers, composited once per pan-offset combination
  const segs = [];
  for (const it of flat) { const last = segs[segs.length - 1]; if (it.bm) { if (last && last.members) last.members.push(it); else segs.push({ members: [it], key: '', buf: new Uint8Array(W * H), opaque: false }); } else segs.push(it); }
  const scene = { W, Wb, H, x0, ctx, items: flat, segs, fb, rgb, pal32, loop: L, fps: recipe.fps || 10, animated, still: recipe.still ?? 0, intro };

  /** render time t (seconds) into the indexed frame buffer `fb` (W×H) */
  scene.index = function (t) {
    fb.fill(0);
    let first = true;
    for (const it of segs) {
      if (it.members) {
        const offs = it.members.map(m => offset(m.depth, t)); const key = offs.join(',');
        if (key !== it.key) { // rebuild this segment's composite (happens only when the slow pan moves a layer by a pixel)
          const buf = it.buf; buf.fill(T); it.key = key;
          it.members.forEach((m, n) => { const src = m.bm.d, sx0 = PAD - offs[n]; for (let y = 0; y < H; y++) { const so = y * Wb + sx0, fo = y * W; for (let x = 0; x < W; x++) { const v = src[so + x]; if (v !== T) buf[fo + x] = v; } } });
          it.opaque = buf.indexOf(T) < 0;
        }
        if (first && it.opaque) fb.set(it.buf); else { const buf = it.buf; for (let i = 0; i < buf.length; i++) { const v = buf[i]; if (v !== T) fb[i] = v; } }
      } else if (it.draw) it.draw(fb, t, offset(it.depth, t), scene);
      first = false;
    }
    if (intro && t >= 0 && t < intro.dur && !scene.noIntro) {
      for (const it of introItems) it.draw(fb, t, offset(it.depth, t), scene);
      if (t < intro.fade) { // pixel dissolve out of the page colour: whole pixels only, ordered, never a blend
        const u = t / intro.fade;
        for (let y = 0; y < H; y++) { const bias = intro.reveal === 'rise' ? (1 - y / H) : intro.reveal === 'fall' ? y / H : 0.5; const v = u * 1.6 - bias * 0.6;
          for (let x = 0; x < W; x++) { const i = y * W + x; if (od(x + x0, y, v)) continue; fb[i] = od(x + x0, y, v * 2 + 0.25) ? dark1[fb[i]] : dark2[fb[i]]; } }
      }
    }
    return fb;
  };
  /** nameplate: a window into the same live scene, faded toward the row colour on the text side.
      opts = {w, h, x: design x that sits at `at` of the width, y: top row, at: 0..1, fade: fraction of width} */
  scene.plate = function (t, out32, o) {
    scene.index(t); let changed = false;
    const sx0 = Math.round(o.x - x0 - PAD - o.w * (o.at ?? 0.72)); const sy0 = o.y;
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
      const sx = Math.min(W - 1, Math.max(0, sx0 + x)), sy = Math.min(H - 1, Math.max(0, sy0 + y)); let v = fb[sy * W + sx];
      // text side: the row's own colour (254), then a short two-step ordered-dither edge into the art
      const edge = o.w * (o.fade ?? 0.45), band = o.band ?? 16; const f = (edge + band - x) / band;
      if (f >= 1) v = 254; else if (f > 0) { if (od(x, y, f)) v = 254; else if (od(x, y, Math.min(1, f * 2))) v = dark1[v]; }
      const c = pal32[v]; const i = y * o.w + x; if (out32[i] !== c) { out32[i] = c; changed = true; }
    }
    return changed;
  };
  /** render into a Uint32Array (RGBA little-endian, W×H); returns true if any pixel changed */
  scene.frame = function (t, out32) {
    scene.index(t);
    let changed = false;
    for (let i = 0; i < fb.length; i++) { const v = pal32[fb[i]]; if (out32[i] !== v) { out32[i] = v; changed = true; } }
    return changed;
  };
  return scene;
}

// ------------------------------------------------------------------ frame-buffer helpers for effects
/** set a screen pixel in an fb (W×H) */
export function fput(fb, W, x, y, c) { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < W && y < H) fb[y * W + x] = c; }
export function fget(fb, W, x, y) { x |= 0; y |= 0; return x >= 0 && y >= 0 && x < W && y < H ? fb[y * W + x] : 0; }
