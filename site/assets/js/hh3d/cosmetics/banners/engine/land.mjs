// Sky, celestial bodies, clouds, landforms, water, fog, fields – the backdrop layers.
import { H, PAD, T, layer, bitmap, put, get, disc, poly, line, blit, od, h1, h2, noise1, noise2, fbm1, fbm2, rng } from './core.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mod4 = (a, n) => ((a % n) + n) % n;
const y0Ok = y => y >= 0 && y < H;
const strSeed = s => { let h = 7; for (const ch of String(s || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

// ------------------------------------------------------------------ sky
// smooth: {stops:[c…], at?:[row…]}  – Bayer across each interval (the original banners' look)
// bands:  {bands:[[c, untilRow]…], seam: rows}  – flat bands with short dithered seams (crisper, more "pixel")
layer('sky', (ctx, p) => {
  const bm = ctx.full();
  if (p.bands) {
    const b = p.bands.map(([c, y]) => [ctx.c(c), y]); const seam = p.seam ?? 4;
    for (let y = 0; y < H; y++) {
      let i = b.findIndex(([, until]) => y < until); if (i < 0) i = b.length - 1;
      let c0 = b[i][0], c1 = c0, f = 0;
      if (i + 1 < b.length && y >= b[i][1] - seam / 2) { c1 = b[i + 1][0]; f = (y - (b[i][1] - seam / 2) + 0.5) / seam; }
      else if (i > 0 && y < b[i - 1][1] + seam / 2) { c1 = c0; c0 = b[i - 1][0]; f = (y - (b[i - 1][1] - seam / 2) + 0.5) / seam; }
      for (let x = 0; x < ctx.Wb; x++) bm.d[y * ctx.Wb + x] = od(ctx.wx(x), y, f) ? c1 : c0;
    }
    return { bm, depth: p.depth };
  }
  const st = p.stops.map(c => ctx.c(c)); const n = st.length - 1;
  const at = p.at || st.map((_, i) => (p.y0 ?? 0) + ((p.y1 ?? H - 1) - (p.y0 ?? 0)) * i / n);
  for (let y = 0; y < H; y++) {
    let i = 0; while (i < n - 1 && y >= at[i + 1]) i++;
    const f = clamp((y - at[i]) / (at[i + 1] - at[i]), 0, 1);
    for (let x = 0; x < ctx.Wb; x++) bm.d[y * ctx.Wb + x] = od(ctx.wx(x), y, f) ? st[i + 1] : st[i];
  }
  return { bm, depth: p.depth };
});

// radial dithered glow (sun halo, lamp, crystal light). rings: [[c, r, strength]…] outermost first
layer('glow', (ctx, p) => {
  const bm = ctx.full(); const ry = p.ry ?? 1; const pw = p.pow ?? 1.4;
  const only = p.only ? p.only.map(c => ctx.c(c)) : null;
  for (const [c, r, s = 1] of p.rings) {
    const ci = ctx.c(c);
    for (let y = Math.floor(p.y - r * ry); y <= p.y + r * ry; y++) for (let wx = Math.floor(p.x - r); wx <= p.x + r; wx++) {
      const bx = ctx.bx(wx); if (y < 0 || y >= H || bx < 0 || bx >= ctx.Wb) continue;
      const d = Math.hypot(wx - p.x, (y - p.y) / ry) / r; if (d >= 1) continue;
      if (only && !only.includes(ctx.accum.d[y * ctx.Wb + bx])) continue;
      if (od(wx, y, Math.pow(1 - d, pw) * s)) bm.d[y * ctx.Wb + bx] = ci;
    }
  }
  return { bm, depth: p.depth };
});

// sun: flat disc; c2 dithers into the lower part; cuts = rows (relative to centre) left open; clip = horizon row
layer('sun', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), c2 = p.c2 ? ctx.c(p.c2) : c;
  const cuts = new Set(p.cuts || []);
  disc(bm, ctx.bx(p.x), p.y, p.r, c, (x, y, dx, dy) => !cuts.has(Math.round(dy)) && (p.clip == null || y < p.clip));
  if (p.c2) for (let y = 0; y < H; y++) for (let x = 0; x < ctx.Wb; x++) {
    if (bm.d[y * ctx.Wb + x] !== c) continue; const f = (y - p.y) / p.r; if (od(ctx.wx(x), y, (f - 0.05) * 1.6)) bm.d[y * ctx.Wb + x] = c2;
  }
  return { bm, depth: p.depth ?? 0.05 };
});

// moon: phase 'full' | 'gibbous' | 'half' | 'crescent'; dir 1 = lit on the right
layer('moon', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), sh = p.shade ? ctx.c(p.shade) : null;
  const cx = ctx.bx(p.x), cy = p.y, r = p.r, dir = p.dir ?? 1;
  const cut = { full: null, gibbous: 1.25, half: 1.0, crescent: 0.55 }[p.phase || 'full'];
  disc(bm, cx, cy, r, c, (x, y) => {
    if (cut == null) return true;
    const ox = cx - dir * r * cut, oy = cy - r * 0.18; return (x - ox) ** 2 + (y - oy) ** 2 > (r * 1.02) ** 2;
  });
  if (sh) { // maria: soft clusters, only on the lit disc
    const R = rng(strSeed(p.x + ':' + p.y) + 3);
    for (let i = 0; i < (p.craters ?? Math.round(r * 0.9)); i++) {
      const a = R() * Math.PI * 2, d = R() * r * 0.62, x = Math.round(cx + Math.cos(a) * d), y = Math.round(cy + Math.sin(a) * d);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]].slice(0, 1 + Math.floor(R() * 4))) if (get(bm, x + dx, y + dy) === c) put(bm, x + dx, y + dy, sh);
    }
  }
  return { bm, depth: p.depth ?? 0.05 };
});

// ------------------------------------------------------------------ clouds
function cumulus(w, h, R, cols, light = -1, tower = false) {
  const bm = bitmap(w, h, T); const [cl, cm, cs] = cols;
  const puffs = []; const rmax = (h - 1) / 1.75;
  if (tower) { // stacked puffs: wide base, narrowing up – a towering cumulus
    const r = Math.min(rmax, h * 0.2, w * 0.16); const rows = Math.max(2, Math.ceil((h - r) / (r * 1.15)));
    for (let j = 0; j < rows; j++) { const span = w * (0.82 - j * 0.5 / rows), n = Math.max(1, Math.round(span / (r * 1.1))); const cy = h - 1 - r * 0.8 - j * (h - r * 1.8) / Math.max(1, rows - 1);
      for (let i = 0; i < n; i++) puffs.push([w / 2 - span / 2 + (i + 0.5) * span / n + (R() - 0.5) * 2, cy + (R() - 0.5) * 2, r * (0.8 + R() * 0.35) * (1 - j * 0.12)]); }
  } else {
    const k = Math.max(2, Math.round(w / (h * 0.55)));
    for (let i = 0; i < k; i++) {
      const u = (i + 0.5) / k; const env = Math.sin(Math.PI * (0.1 + u * 0.8));
      const r = Math.max(1.5, Math.min(rmax, h * 0.62) * (0.5 + 0.5 * env) * (0.85 + R() * 0.25));
      const px = Math.min(w - 1 - r, Math.max(r, u * w + (R() - 0.5) * 3)); puffs.push([px, h - 1 - r * 0.8, r]);
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let best = null, bd = 9;
    for (const [px, py, r] of puffs) { const d = Math.hypot(x - px, y - py) / r; if (d < bd) { bd = d; best = [px, py, r]; } }
    const pa = puffs[0], pz = puffs[puffs.length - 1];
    const slab = !tower && y >= h - 1 - pa[2] * 0.7 && x >= Math.min(pa[0], pz[0]) && x <= Math.max(pa[0], pz[0]);
    if (!best || (bd > 1 && !slab)) continue;
    const ny = (y - best[1]) / best[2], nx = (x - best[0]) / best[2];
    const v = -ny * 0.9 + light * -nx * 0.35;
    let c = v > 0.38 ? cl : v > 0.3 ? (od(x, y, 0.5) ? cl : cm) : v > -0.22 ? cm : v > -0.3 ? (od(x, y, 0.5) ? cm : cs) : cs;
    if (y >= h - 1) c = cs;
    bm.d[y * w + x] = c;
  }
  return bm;
}
function stratus(w, h, R, cols, litBottom) {
  const bm = bitmap(w, h, T); const [cl, cm, cs] = cols; const s = R() * 1000;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x / (w - 1)) * 2 - 1; const half = (h / 2) * Math.sqrt(Math.max(0, 1 - u * u)) * (0.75 + noise1(x * 0.15, s) * 0.5);
    const cy = (h - 1) / 2 + (noise1(x * 0.05, s + 9) - 0.5) * h * 0.4;
    if (Math.abs(y - cy) > half) continue;
    let c = cm;
    if (litBottom) { if (y >= cy + half - 1) c = cl; else if (y <= cy - half + 1 && cs !== cm) c = cs; }
    else { if (y <= cy - half + 1) c = cl; else if (y >= cy + half - 1) c = cs; }
    bm.d[y * w + x] = c;
  }
  return bm;
}
// {style:'cumulus'|'strata', at:[[x,y,w,h]…] or spacing/chance/y/w/h ranges, c:[light, mid, shadow], drift: px/s}
layer('clouds', (ctx, p) => {
  const cols = p.c.map(c => ctx.c(c)); const R = ctx.rand(strSeed(p.id || 'clouds'));
  const make = (w, h) => p.style === 'strata' ? stratus(w, h, R, cols, p.litBottom) : cumulus(w, h, R, cols, p.light ?? -1, p.style === 'tower');
  const list = [];
  if (p.at) for (const [x, y, w, h] of p.at) list.push({ x, y, bm: make(w, h) });
  else {
    const sp = p.spacing || 80, [wa, wb] = p.w || [24, 48], [ha, hb] = p.h || [6, 11], [ya, yb] = p.y || [4, 20];
    const a = Math.floor((ctx.wx(0) - wb) / sp), b = Math.ceil((ctx.wx(ctx.Wb) + wb) / sp);
    const s = strSeed(p.id || 'c') + ctx.seed;
    const [ra, rb] = p.range || [-1e9, 1e9];
    for (let i = a; i <= b; i++) {
      if (h1(i, s) > (p.chance ?? 0.8) || i * sp < ra || i * sp > rb) continue;
      const w = Math.round(wa + h1(i, s + 1) * (wb - wa)), hh = Math.round(ha + h1(i, s + 2) * (hb - ha));
      list.push({ x: Math.round(i * sp + h1(i, s + 3) * sp * 0.6), y: Math.round(ya + h1(i, s + 4) * (yb - ya)), bm: make(w, hh) });
    }
  }
  if (!p.drift) { const bm = ctx.full(); for (const c of list) blit(bm, c.bm, ctx.bx(c.x) - (c.bm.w >> 1), c.y - c.bm.h + 1); return { bm, depth: p.depth ?? 0.1 }; }
  // drifting: screen-space conveyor, period = loop × mul (the app never resets, so a long period costs nothing)
  const maxw = Math.max(...list.map(c => c.bm.w)) + 2; const D = ctx.W + maxw * 2;
  const mul = p.mul || 16; const cycles = Math.max(1, Math.round(Math.abs(p.drift) * ctx.L * mul / D)) * Math.sign(p.drift);
  return {
    depth: p.depth ?? 0.1,
    bake(acc) { for (const c of list) blit(acc, c.bm, ctx.bx(c.x) - (c.bm.w >> 1), c.y - c.bm.h + 1); },
    draw(fb, t, off, sc) {
      const shift = ((t / (ctx.L * mul)) * cycles * D) % D;
      for (const c of list) {
        const sx0 = ctx.bx(c.x) - PAD - (c.bm.w >> 1);
        const sx = Math.floor(((sx0 + shift + maxw) % D + D) % D) - maxw + off; const y0 = c.y - c.bm.h + 1;
        for (let j = 0; j < c.bm.h; j++) { const y = y0 + j; if (y < 0 || y >= H) continue; for (let i = 0; i < c.bm.w; i++) { const v = c.bm.d[j * c.bm.w + i]; const x = sx + i; if (v !== T && x >= 0 && x < sc.W) fb[y * sc.W + x] = v; } }
      }
    },
  };
});

// ------------------------------------------------------------------ landforms
function ridgeFn(p, s) {
  const st = p.style || 'sine', base = p.base, amp = p.amp ?? 6, f = p.freq ?? 0.03, rough = p.rough ?? 1;
  const ph = [0, 1, 2, 3].map(i => h1(i, s) * 6.283);
  let fn;
  if (st === 'sine') fn = x => base - amp * (0.55 * Math.sin(x * f + ph[0]) + 0.25 * Math.sin(x * f * 2.3 + ph[1]) * rough + 0.12 * Math.sin(x * f * 5.1 + ph[2]) * rough + 0.08 * Math.sin(x * f * 11 + ph[3]) * rough);
  else if (st === 'peaks') fn = x => { let v = 0, a = 1, fr = 1, n = 0; for (let o = 0; o < 4; o++) { const q = 1 - Math.abs(2 * noise1(x * f * fr, s + o * 31) - 1); v += a * q * q; n += a; a *= 0.45 * rough; fr *= 2.1; } return base - amp * (v / n * 2 - 0.6); };
  else if (st === 'hills') fn = x => base - amp * (fbm1(x * f, s, 3) - 0.5) * 2.6;
  else if (st === 'flat') fn = x => base - amp * (fbm1(x * f, s, 2) - 0.5);
  else if (st === 'dunes') fn = x => { const u = x * f + fbm1(x * f * 0.5, s, 2) * 1.2; const fr = u - Math.floor(u); const prof = fr < 0.72 ? Math.sin(fr / 0.72 * Math.PI / 2) : Math.cos((fr - 0.72) / 0.28 * Math.PI / 2); return base - amp * prof * (0.55 + 0.45 * noise1(Math.floor(u), s + 5)); };
  else if (st === 'mesa') fn = x => { const v = fbm1(x * f, s, 3); const lv = p.levels || [0.42, 0.56]; let q = 0; for (const l of lv) if (v > l) q++; return base - amp * (q / lv.length) - (noise1(x * 0.5, s + 3) - 0.5) * (p.erode ?? 1.2); };
  else if (st === 'alps') { // crisp triangular peaks, jagged by noise – the classic pixel mountain
    const sp = p.spacing || 46; const k = p.slope ?? 0.55;
    fn = x => { let v = -1e9; const i0 = Math.floor(x / sp); for (let i = i0 - 3; i <= i0 + 3; i++) { const cx = i * sp + h1(i, s) * sp * 0.8, hh = amp * (0.45 + 0.55 * h1(i, s + 1)); v = Math.max(v, hh - Math.abs(x - cx) * k * (0.8 + 0.4 * h1(i, s + 2))); } return base - v + (fbm1(x * 0.2, s + 4, 3) - 0.5) * 2.2 * rough; };
  }
  else if (st === 'spikes') { // stalactites / spires / spiky treelines; dir -1 = hanging from the top
    const sp = p.spacing || 7; fn = x => { let v = 0; const i0 = Math.floor(x / sp); for (let i = i0 - 2; i <= i0 + 2; i++) { const cx = i * sp + h1(i, s) * sp, len = amp * (0.25 + 0.75 * Math.pow(h1(i, s + 1), p.lenPow ?? 1)), w = sp * (p.wide ?? 0.6) * (0.5 + h1(i, s + 2) * 0.7); const d = Math.abs(x - cx) / w; if (d < 1) v = Math.max(v, len * Math.pow(1 - d, p.sharp ?? 1)); } return base - (p.dir ?? 1) * (v + (noise1(x * 0.3, s + 7) - 0.5) * rough); };
  }
  else if (st === 'points') { const pts = p.points; fn = x => { let i = 0; while (i < pts.length - 2 && x > pts[i + 1][0]) i++; const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const t = clamp((x - ax) / (bx - ax), 0, 1); return ay + (by - ay) * (p.ease ? (1 - Math.cos(t * Math.PI)) / 2 : t) + (p.jitter ? (fbm1(x * 0.15, s, 3) - 0.5) * p.jitter * 2 : 0); }; }
  if (p.bumps) { const inner = fn; fn = x => { let y = inner(x); for (const b of p.bumps) { const d = Math.abs(x - b.x) / b.w; if (d >= 1) continue; const k = b.shape === 'round' ? Math.sqrt(1 - d * d) : b.shape === 'spire' ? Math.pow(1 - d, 2.2) : b.shape === 'mesa' ? (d < 0.7 ? 1 : (1 - d) / 0.3) : (1 - d); y = Math.min(y, (b.y ?? p.base) - b.h * k + (b.shape === 'cone' && b.crater && d < 0.08 ? 1 : 0)); } return y; }; }
  return fn;
}
export { ridgeFn };

/* {id, style, base, amp, freq, rough, c, edge:[c, band], mist:{c, y, band}, rim:{c, side:-1|1|0, w}, shade:{c, side, depth},
    snow:{c, line, depth}, strata:{c, every, wob}, tex:{c, d}, from:'top', bumps:[…], points:[…]} */
layer('ridge', (ctx, p) => {
  const bm = ctx.full(); const s = (ctx.seed * 31 + strSeed(p.id || JSON.stringify(p).slice(0, 40))) >>> 0;
  const fn = ridgeFn(p, s); const Wb = ctx.Wb; const c = p.c != null ? ctx.c(p.c) : null;
  const top = new Float32Array(Wb + 6); for (let i = 0; i < Wb + 6; i++) top[i] = fn(ctx.wx(i - 3));
  const T0 = i => top[clamp(i + 3, 0, Wb + 5)];
  const ec = p.edge && ctx.c(p.edge[0]), mc = p.mist && ctx.c(p.mist.c), rc = p.rim && ctx.c(p.rim.c), sc = p.shade && ctx.c(p.shade.c),
    nc = p.snow && ctx.c(p.snow.c), stc = p.strata && ctx.c(p.strata.c), tc = p.tex && ctx.c(p.tex.c);
  const fromTop = p.from === 'top';
  if (p.ink) { // pen drawing: outline only, diagonal hatching on the shadow side (Fieldbook sketches)
    const ic = ctx.c(p.ink.c ?? p.c), hc = p.ink.hatch != null ? ctx.c(p.ink.hatch) : null, every = p.ink.every ?? 3, dep = p.ink.depth ?? 6;
    for (let bx = 0; bx < Wb; bx++) { const wx = ctx.wx(bx), t0 = Math.round(T0(bx)), tp = Math.round(T0(bx - 1)); for (let y = Math.min(t0, tp); y <= Math.max(t0, tp); y++) put(bm, bx, y, ic); if (y0Ok(t0)) put(bm, bx, t0, ic);
      const slope = T0(bx + 2) - T0(bx - 2); const shadow = (p.ink.side ?? 1) > 0 ? slope < -0.3 : slope > 0.3;
      if (hc != null) for (let k = 2; k < dep + (shadow ? 6 : 0); k++) { const y = t0 + k; if (y >= H) break; if (mod4(wx - y, every) === 0 && (shadow || k < dep * 0.6) && od(wx, y, 1 - k / (dep + 6))) put(bm, bx, y, hc); } }
    if (p.id) ctx.surf[p.id] = wx => Math.round(fn(wx));
    return { bm, depth: p.depth };
  }
  for (let bx = 0; bx < Wb; bx++) {
    const wx = ctx.wx(bx), t0 = Math.round(T0(bx)); if (p.range && (wx < p.range[0] || wx > p.range[1])) continue;
    const slope = T0(bx + 2) - T0(bx - 2); // >0: the ground falls to the right (faces right)
    const y0 = fromTop ? 0 : clamp(t0, 0, H), y1 = fromTop ? clamp(t0, 0, H) : H;
    for (let y = y0; y < y1; y++) {
      const k = fromTop ? t0 - 1 - y : y - t0; let col = c;
      if (sc) { const side = p.shade.side ?? 1; const sl = p.shade.slant ?? 0; const bs = bx + Math.round(k * sl * -side); const slope2 = sl ? T0(bs + 3) - T0(bs - 3) : slope; const away = side > 0 ? slope2 < -0.35 : slope2 > 0.35; const dep = p.shade.depth ?? 99; if (away && (k < dep - 2 || (k < dep && od(wx, y, (dep - k) / 3)))) col = sc; }
      if (stc) { const ev = p.strata.every || 3; const wob = Math.round((noise1(wx * 0.06, s + 11) - 0.5) * (p.strata.wob ?? 2)); if ((y + wob) % ev === 0) col = stc; }
      if (tc && h2(wx, y, s) < p.tex.d) col = tc;
      if (nc) { const ln = p.snow.line + (noise1(wx * 0.2, s + 13) - 0.5) * 4; const dep = p.snow.depth ?? 4; if (y < ln && k < dep + 1 && (k < dep - 1 || od(wx, y, 0.5))) col = nc; }
      if (rc) { const side = p.rim.side ?? 0; const lit = side === 0 || (side > 0 ? slope > 0.2 : slope < -0.2); if (lit && k < (p.rim.w ?? 1)) col = rc; }
      if (ec && k < p.edge[1] && od(wx, y, 1 - k / p.edge[1] - 0.25)) col = ec;
      if (mc && y >= p.mist.y && od(wx, y, Math.min(1, (y - p.mist.y + 1) / (p.mist.band || 4)))) col = mc;
      bm.d[y * Wb + bx] = col;
    }
  }
  if (p.id) ctx.surf[p.id] = wx => Math.round(fn(wx));
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ water: mirrored scene, broken into strokes, shimmering
/* {y: horizon, c:{base, deep, line?, glint?}, reflect: 0..1, squash, breakup, shimmer: px, glints: per 1000 px,
    path:{x, w, c:[core, edge]}, bands:[[c, rowsFromHorizon]…]} */
layer('water', (ctx, p) => {
  const hz = p.y, rows = H - hz, Wb = ctx.Wb; const s = ctx.seed + 404;
  const cb = ctx.c(p.c.base), cd = ctx.c(p.c.deep ?? p.c.base), cl = p.c.line != null ? ctx.c(p.c.line) : null, cg = p.c.glint != null ? ctx.c(p.c.glint) : null;
  const snap = ctx.accum.d.slice(0);
  const lut = ctx.lut(p.c.tint ?? p.c.base, 1 - (p.reflect ?? 0.5), p.allow);
  // base colour per pixel: horizon line, base, dithering into deep toward the viewer
  const base = new Uint8Array(rows * Wb), keep = new Uint8Array(rows * Wb);
  for (let k = 0; k < rows; k++) for (let bx = 0; bx < Wb; bx++) {
    const wx = ctx.wx(bx), y = hz + k; let c = od(wx, y, Math.pow(k / rows, p.deepPow ?? 1.3) * 1.1) ? cd : cb;
    if (p.bands) { let acc = 0; for (const [bc, n] of p.bands) { if (k < acc + n) { c = ctx.c(bc); break; } acc += n; } }
    if (k === 0 && cl != null) c = cl;
    base[k * Wb + bx] = c;
    const kp = (p.keep ?? 0.9) - (k / rows) * (p.breakup ?? 0.5);
    keep[k * Wb + bx] = noise2(wx * (0.09 + k * 0.012), k * 0.8, s) < kp ? 1 : 0;
  }
  const amp = p.shimmer ?? 1, sq = p.squash ?? 1;
  const cyc = ctx.cyc(p.shimmerPeriod || 4);
  const R = ctx.rand(77);
  const glints = []; const ng = Math.round((p.glints ?? 0) * Wb * rows / 1000);
  if (cg != null) for (let i = 0; i < ng; i++) glints.push({ bx: Math.floor(R() * Wb), k: 1 + Math.floor(Math.pow(R(), 1.6) * (rows - 1)), len: 1 + Math.floor(R() * 3), cy: ctx.cyc([2, 3, 4, 6][Math.floor(R() * 4)]), ph: R() });
  const path = p.path && { ...p.path, c: p.path.c.map(c => ctx.c(c)) };
  const static_ = amp === 0 && !glints.length && !path;
  const drawInto = (fb, Wout, t, off, xs0, live) => {
    for (let k = 0; k < rows; k++) {
      const y = hz + k; const sy = clamp(hz - 1 - Math.floor(k * sq), 0, H - 1);
      const dx = amp ? Math.round(amp * (0.35 + k / rows) * Math.sin(k * 1.9 + 2 * Math.PI * ((t / ctx.L) * cyc))) : 0;
      for (let sx = 0; sx < Wout; sx++) {
        const bx = sx + xs0 - off; if (bx < 0 || bx >= Wb) continue;
        let v = base[k * Wb + bx];
        if (keep[k * Wb + bx] && (k > 0 || cl == null)) { const r = live ? fb[sy * Wout + clamp(sx + dx, 0, Wout - 1)] : snap[sy * Wb + clamp(bx + dx, 0, Wb - 1)]; if (r !== T) v = lut[r]; }
        fb[y * Wout + sx] = v;
      }
    }
    if (path) { // glitter path: short horizontal dashes that re-scatter a few times a second
      const pc = path.cyc || ctx.cyc(4); const step = Math.floor((t / ctx.L) * pc * 3);
      for (let k = 1; k < rows; k++) {
        if (h2(k, step, s) < (path.gap ?? 0.3)) continue;
        const hw = Math.max(1, path.w * (0.5 + (k / rows) * (path.widen ?? 1)));
        const cx = ctx.bx(path.x) - xs0 + off; const nd = hw > 3 ? 2 : 1;
        for (let d = 0; d < nd; d++) { const r1 = h2(k * 7 + d, step + 3, s), r2 = h2(k * 7 + d, step + 5, s); const c0 = Math.round(cx + (r1 - 0.5) * hw * 1.6); const len = 1 + Math.floor(r2 * hw * 0.9);
          for (let x = c0 - (len >> 1); x <= c0 + (len >> 1); x++) if (x >= 0 && x < Wout) fb[(hz + k) * Wout + x] = Math.abs(x - cx) < hw * 0.45 ? path.c[0] : path.c[1]; }
      }
    }
    for (const g of glints) {
      if (Math.sin(2 * Math.PI * ((t / ctx.L) * g.cy + g.ph)) < 0.82) continue;
      const sx = g.bx - xs0 + off; for (let i = 0; i < g.len; i++) if (sx + i >= 0 && sx + i < Wout) fb[(hz + g.k) * Wout + sx + i] = cg;
    }
  };
  if (static_) { const bm = ctx.full(); for (let y = 0; y < hz; y++) bm.d.fill(T, y * Wb, (y + 1) * Wb); drawInto(bm.d, Wb, 0, 0, 0); return { bm, depth: p.depth }; }
  return {
    depth: p.depth,
    bake(acc) { const tmp = new Uint8Array(Wb * H).fill(T); drawInto(tmp, Wb, 0, 0, 0); for (let i = hz * Wb; i < tmp.length; i++) if (tmp[i] !== T) acc.d[i] = tmp[i]; },
    draw(fb, t, off, sc) { drawInto(fb, sc.W, t, off, PAD, p.live !== false); },
  };
});

// ------------------------------------------------------------------ fog: a drifting band that pulls colours toward the fog tone
// {y, h, c, amt:[light, dense], drift: px/s, scale, density}
layer('fog', (ctx, p) => {
  const l1 = ctx.lut(p.c, p.amt?.[0] ?? 0.35), l2 = ctx.lut(p.c, p.amt?.[1] ?? 0.7);
  const Pw = 256; const s = ctx.seed + strSeed(p.id || 'fog'); const sc = p.scale ?? 0.05;
  const y0 = Math.max(0, Math.floor(p.y - p.h)), y1 = Math.min(H, Math.ceil(p.y + p.h));
  const dens = new Float32Array((y1 - y0) * Pw);
  for (let y = y0; y < y1; y++) for (let u = 0; u < Pw; u++) {
    const prof = 1 - Math.abs(y - p.y) / p.h; dens[(y - y0) * Pw + u] = Math.max(0, prof) * (0.35 + fbm2(u * sc, y * sc * 2.2, s, 3, Pw * sc) * (p.density ?? 1.1));
  }
  const cycles = p.drift ? Math.max(1, Math.round(Math.abs(p.drift) * ctx.L * (p.mul || 4) / Pw)) * Math.sign(p.drift) : 0;
  const apply = (buf, Wout, t, xoff) => {
    const sh = cycles ? Math.floor((t / (ctx.L * (p.mul || 4))) * cycles * Pw) : 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < Wout; x++) {
      const wx = ctx.wx(x + xoff); const d = dens[(y - y0) * Pw + (((wx - sh) % Pw) + Pw) % Pw];
      const i = y * Wout + x; const v = buf[i]; if (v === T) continue;
      if (d > 0.62 && od(wx, y, (d - 0.62) * 4)) buf[i] = l2[v]; else if (od(wx, y, Math.min(1, d * 1.25 - 0.2))) buf[i] = l1[v];
    }
  };
  if (!p.drift) return { depth: p.depth, bake(acc) { apply(acc.d, ctx.Wb, 0, 0); }, draw(fb, t, off, sc2) { apply(fb, sc2.W, 0, PAD - off); } };
  return { depth: p.depth, bake(acc) { apply(acc.d, ctx.Wb, 0, 0); }, draw(fb, t, off, sc2) { apply(fb, sc2.W, t, PAD - off); } };
});

// ------------------------------------------------------------------ fields: wheat, meadow, snow, sand – a textured ground plane
// {y, c:[far, mid, near], tex:[c, density], heads: c (ragged stalk tips on the top edge), flowers:[[c, d]…], rows}
layer('field', (ctx, p) => {
  const bm = ctx.full(); const s = ctx.seed + strSeed(p.id || 'field'); const cs = p.c.map(c => ctx.c(c));
  const top = wx => Math.round(p.y + (fbm1(wx * (p.freq ?? 0.02), s, 3) - 0.5) * (p.amp ?? 3));
  for (let bx = 0; bx < ctx.Wb; bx++) {
    const wx = ctx.wx(bx), t0 = top(wx);
    if (p.heads != null && h2(wx, 1, s) < 0.55) put(bm, bx, t0 - 1, ctx.c(p.heads));
    for (let y = Math.max(0, t0); y < H; y++) {
      const f = (y - t0) / Math.max(1, H - t0); const ci = f * (cs.length - 1); const i = Math.min(cs.length - 2, Math.floor(ci));
      let c = od(wx, y, ci - i) ? cs[i + 1] : cs[i];
      if (p.rows) { const r = p.rows; const u = (wx - r.vx) / (y - (p.y - (r.vy ?? 14))); if (Math.floor(u * (r.k ?? 3)) % 2 === 0 && h2(wx, y, s + 4) < (r.d ?? 0.85)) c = ctx.c(r.c); }
      if (p.tex) { const [tc, d] = p.tex; const lane = Math.floor(wx / (1 + Math.floor(f * 3))); if (h2(lane, Math.floor((y + (wx & 1)) / 2), s) < d * (0.4 + f)) c = ctx.c(tc); }
      if (p.flowers) for (const [fc, d] of p.flowers) if (h2(wx, y, s + 9) < d * (0.3 + f)) c = ctx.c(fc);
      bm.d[y * ctx.Wb + bx] = c;
    }
  }
  if (p.id) ctx.surf[p.id] = top;
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ space: nebula, milky way, planet, comet, rainbow
// {c:[c1,c2,c3…] faint→bright, scale, y0, y1, band:{x, y, angle, w}, density, only:[sky colours]}
layer('nebula', (ctx, p) => {
  const bm = ctx.full(); const s = ctx.seed + strSeed(p.id || 'neb'); const cs = p.c.map(c => ctx.c(c)); const sc = p.scale ?? 0.04;
  const only = p.only ? p.only.map(c => ctx.c(c)) : null;
  const b = p.band; const ca = b ? Math.cos(b.angle) : 0, sa = b ? Math.sin(b.angle) : 0;
  for (let y = p.y0 ?? 0; y < (p.y1 ?? H); y++) for (let bx = 0; bx < ctx.Wb; bx++) {
    const wx = ctx.wx(bx); if (only && !only.includes(ctx.accum.d[y * ctx.Wb + bx])) continue;
    let d = fbm2(wx * sc, y * sc * 1.6, s, 4);
    if (b) { const dd = ((wx - b.x) * sa - (y - b.y) * ca) / b.w; d *= Math.exp(-dd * dd) * 1.6; }
    d = d * (p.density ?? 1) - (p.cut ?? 0.42);
    for (let i = cs.length - 1; i >= 0; i--) { const th = i * (p.step ?? 0.09); if (d > th) { if (od(wx, y, Math.min(1, (d - th) / (p.step ?? 0.09) * 1.3))) bm.d[y * ctx.Wb + bx] = cs[i]; else if (i > 0) bm.d[y * ctx.Wb + bx] = cs[i - 1]; break; } }
  }
  return { bm, depth: p.depth ?? 0.02 };
});

// {x, y, r, c:[light, mid, dark], light:[lx, ly], bands:{c, every}, ring:{c, c2, rx, ry, w}}
layer('planet', (ctx, p) => {
  const bm = ctx.full(); const [cl, cm, cd] = p.c.map(c => ctx.c(c)); const [lx, ly] = p.light || [-0.7, -0.5]; const cx = ctx.bx(p.x);
  const ring = p.ring && { ...p.ring, c: ctx.c(p.ring.c), c2: ctx.c(p.ring.c2 || p.ring.c) };
  const drawRing = front => { if (!ring) return; for (let a = 0; a < 720; a++) { const th = a / 720 * Math.PI * 2; const isFront = Math.sin(th) > 0; if (isFront !== front) continue; for (let w = 0; w < (ring.w || 2); w++) { const x = Math.round(cx + Math.cos(th) * (ring.rx - w)), y = Math.round(p.y + Math.sin(th) * (ring.ry - w * ring.ry / ring.rx)); put(bm, x, y, w === 0 ? ring.c : ring.c2); } } };
  drawRing(false);
  disc(bm, cx, p.y, p.r, cm, (x, y, dx, dy) => {
    const n = (dx * lx + dy * ly) / p.r; let c = n > 0.35 ? cl : n > 0.15 ? (od(x, y, (n - 0.15) / 0.2) ? cl : cm) : n > -0.3 ? cm : n > -0.5 ? (od(x, y, (n + 0.5) / 0.2) ? cm : cd) : cd;
    if (p.bands && Math.round(dy + noise1(dx * 0.3, 5) * 1.2) % p.bands.every === 0 && c !== cd) c = ctx.c(p.bands.c);
    put(bm, x, y, c); return false;
  });
  drawRing(true);
  return { bm, depth: p.depth ?? 0.04 };
});

layer('comet', (ctx, p) => {
  const bm = ctx.full(); const [ch, c1, c2] = p.c.map(c => ctx.c(c)); const ang = p.angle ?? 2.7; const ux = Math.cos(ang), uy = Math.sin(ang);
  for (let i = p.len; i > 0; i--) { const f = 1 - i / p.len; const w = 0.5 + (i / p.len) * (p.spread ?? 3);
    for (let j = -Math.ceil(w); j <= Math.ceil(w); j++) { const x = Math.round(p.x + ux * i - uy * j), y = Math.round(p.y + uy * i + ux * j); if (Math.abs(j) > w) continue; const wx = x;
      if (od(wx, y, f * 0.9 - Math.abs(j) / w * 0.3)) put(bm, ctx.bx(x), y, f > 0.6 ? c1 : c2); } }
  put(bm, ctx.bx(p.x), p.y, ch); put(bm, ctx.bx(p.x) + 1, p.y, ch); put(bm, ctx.bx(p.x), p.y + 1, c1);
  return { bm, depth: p.depth ?? 0.03 };
});

// muted rainbow: dithered arcs, strength < 1 keeps it translucent
layer('rainbow', (ctx, p) => {
  const bm = ctx.full(); const cs = p.c.map(c => ctx.c(c)); const w = p.w ?? 2;
  for (let y = 0; y < (p.clip ?? H); y++) for (let bx = 0; bx < ctx.Wb; bx++) {
    const wx = ctx.wx(bx); const d = Math.hypot(wx - p.x, (y - p.y) * (p.squash ?? 1)); const i = Math.floor((p.r - d) / w);
    if (i < 0 || i >= cs.length) continue; const fade = p.fade ? clamp(1 - Math.abs(wx - p.x) / p.fade, 0, 1) : 1;
    if (od(wx, y, (p.strength ?? 0.5) * fade)) bm.d[y * ctx.Wb + bx] = cs[i];
  }
  return { bm, depth: p.depth ?? 0.05 };
});

// crystals: clusters of faceted shards. at:[[x, base, size, lean?]…], c:[light, mid, dark]
layer('crystals', (ctx, p) => {
  const bm = ctx.full(); const [cl, cm, cd] = p.c.map(c => ctx.c(c)); const R = ctx.rand(strSeed(p.id || 'cr'));
  for (const [x, base, size, lean = 0] of p.at) {
    const n = 2 + Math.floor(size / 5);
    const shards = [];
    for (let i = 0; i < n; i++) shards.push({ a: lean + (R() - 0.5) * 1.1 * (i ? 1 : 0.3), l: size * (i ? 0.45 + R() * 0.45 : 1), dx: (R() - 0.5) * size * 0.5 });
    shards.sort((a, b) => a.l - b.l);
    for (const sh of shards.reverse()) {
      const bx0 = ctx.bx(x) + sh.dx, ax = Math.sin(sh.a), ay = -Math.cos(sh.a), nx = -ay, ny = ax, w = Math.max(1.5, sh.l / 4.2);
      const P = (u, v) => [bx0 + ax * u + nx * v, base + ay * u + ny * v];
      const pts = [P(0, -w), P(0, w), P(sh.l * 0.72, w), P(sh.l, 0), P(sh.l * 0.72, -w)];
      poly(bm, pts, cm);
      poly(bm, [P(0, 0), P(0, w), P(sh.l * 0.72, w), P(sh.l, 0)], cd);
      line(bm, ...P(0.5, -w + 0.5), ...P(sh.l * 0.72, -w + 0.5), cl); line(bm, ...P(sh.l * 0.72, -w + 0.5), ...P(sh.l - 0.5, 0), cl);
    }
  }
  return { bm, depth: p.depth };
});
