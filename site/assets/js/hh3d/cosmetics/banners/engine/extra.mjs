// Round-2 layers: abstract fields (gradients, heatmaps, plasma, contours), paper and ink, circuit traces, segment
// readouts, LED bars, the souldew wordmark and rings, CRT scanlines, LCD grids, the SoulLink thread, passing
// sprites, tall grass, electric arcs, an arena, plain rects. Same rules as everything else: palette indices only,
// ordered dither only, every motion periodic in the loop.
import { H, PAD, T, layer, put, od, h1, h2, noise1, fbm2 } from './core.mjs';
import { SPRITES } from './sprites.mjs';
import { WORD_S, WORD_L, RINGS_L, RINGS_S } from './brand.mjs';

const TAU = Math.PI * 2;
const mod = (a, n) => ((a % n) + n) % n;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const strSeed = s => { let h = 7; for (const ch of String(s || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const fset = (fb, W, x, y, c) => { x |= 0; y |= 0; if (x >= 0 && x < W && y >= 0 && y < H) fb[y * W + x] = c; };
const sxOf = (ctx, wx, off) => ctx.bx(wx) - PAD + off;

// ------------------------------------------------------------------ abstract fields
/* {kind:'plasma'|'noise'|'heat'|'bands'|'rings', ramp:[c…], scale, pw, cycle (ramp cycles per loop), drift (px/s),
    mirror (ping-pong the ramp), span (how many ramp lengths the field covers), contour:{c, every, w}, y:[y0,y1],
    blobs (heat), k:[…] (plasma wave counts), centre:[x,y] (rings)} */
layer('field2d', (ctx, p) => {
  const ramp = p.ramp.map(c => ctx.c(c)); const n = ramp.length; const s = (ctx.seed * 7 + strSeed(p.id || p.kind)) >>> 0;
  const Pw = p.pw ?? 512; const [y0, y1] = p.y || [0, H]; const rows = y1 - y0; const sc = p.scale ?? 0.03;
  const F = new Float32Array(rows * Pw);
  const k = p.k || [3, 5, 2];
  const blobs = []; if (p.kind === 'heat') { const R = ctx.rand(s); for (let i = 0; i < (p.blobs ?? 9); i++) blobs.push([R() * Pw, y0 + R() * rows, 18 + R() * 40, 0.5 + R() * 0.7]); }
  const val = (u, y) => {
    let v;
    if (p.kind === 'plasma') v = 0.5 + 0.22 * Math.sin(TAU * u / Pw * k[0] + y * 0.13) + 0.18 * Math.sin(TAU * u / Pw * k[1] - y * 0.21 + 1.7 * Math.sin(TAU * u / Pw * k[2])) + 0.1 * Math.sin(y * 0.37 + TAU * u / Pw * 7);
    else if (p.kind === 'noise') v = fbm2(u * sc, y * sc * (p.aspect ?? 1.6), s, p.oct ?? 4, Pw * sc);
    else if (p.kind === 'heat') { v = 0; for (const [bx, by, r, w] of blobs) for (const o of [-Pw, 0, Pw]) { const d = ((u - bx - o) ** 2 + ((y - by) * 2.2) ** 2) / (r * r); v += w * Math.exp(-d); } v = 1 - Math.exp(-v * 1.3); v += (fbm2(u * 0.08, y * 0.12, s, 2, Pw * 0.08) - 0.5) * 0.12; }
    else if (p.kind === 'bands') v = (y - y0) / rows + (p.wave ?? 0.08) * Math.sin(TAU * u / Pw * (k[0]) + y * 0.05) + (p.wave ?? 0.08) * 0.5 * Math.sin(TAU * u / Pw * k[1]);
    else if (p.kind === 'rings') { const [cx, cy] = p.centre || [Pw / 2, H / 2]; v = Math.hypot(u - cx, (y - cy) * 1.8) / (p.ring ?? 60) + (fbm2(u * 0.05, y * 0.08, s, 2, Pw * 0.05) - 0.5) * 0.25; }
    return v;
  };
  // sample every second column and interpolate (half the compile time; fields are smooth anyway)
  for (let y = y0; y < y1; y++) { const ro = (y - y0) * Pw; for (let u = 0; u < Pw; u += 2) F[ro + u] = val(u, y); for (let u = 1; u < Pw; u += 2) F[ro + u] = (F[ro + u - 1] + F[ro + (u + 1) % Pw]) / 2; }
  const span = p.span ?? 1, mirror = !!p.mirror, cyc = p.cycle ?? 0;
  const dcyc = p.drift ? Math.max(1, Math.round(Math.abs(p.drift) * ctx.L * (p.mul || 4) / Pw)) * Math.sign(p.drift) : 0;
  const ct = p.contour && { c: ctx.c(p.contour.c), every: p.contour.every ?? 6, w: p.contour.w ?? 0.08 };
  // fixed point: one ramp pass = M steps; per cell the position on the ramp, per step the (lo, hi, fraction) – so a
  // frame costs an add, a mask and a compare per pixel, whatever the field kind
  const M = 1024, POS = new Int32Array(rows * Pw), CT = ct ? new Uint8Array(rows * Pw) : null;
  for (let i = 0; i < POS.length; i++) { POS[i] = Math.floor(F[i] * span * M); if (CT && mod(F[i] * ct.every, 1) < ct.w) CT[i] = 1; }
  const LO = new Uint8Array(M), HI = new Uint8Array(M), FR = new Float32Array(M);
  for (let q = 0; q < M; q++) { const x = q / M; let r;
    if (mirror) { const L2 = 2 * (n - 1); r = x * L2; if (r > n - 1) r = L2 - r; const i = Math.min(n - 2, Math.floor(r)); LO[q] = ramp[i]; HI[q] = ramp[i + 1]; FR[q] = r - i; }
    else { r = x * n; const i = Math.floor(r) % n; LO[q] = ramp[i]; HI[q] = ramp[(i + 1) % n]; FR[q] = r - Math.floor(r); } }
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(b => (b + 0.5) / 16);
  const paint = (buf, Wout, t, x2wx) => {
    const P = cyc ? Math.floor((t / ctx.L) * cyc * M) : 0; const sh = dcyc ? Math.floor((t / (ctx.L * (p.mul || 4))) * dcyc * Pw) : 0;
    const wx0 = x2wx(0);
    for (let y = y0; y < y1; y++) { const ro = (y - y0) * Pw, bo = (y & 3) << 2; let u = mod(wx0 - sh, Pw); const o = y * Wout;
      for (let x = 0; x < Wout; x++) { const k2 = ro + u; const q = (((POS[k2] + P) % M) + M) % M;
        buf[o + x] = CT && CT[k2] ? ct.c : (FR[q] > BAY[bo | ((wx0 + x) & 3)] ? HI[q] : LO[q]); if (++u === Pw) u = 0; } }
  };
  if (!cyc && !dcyc) { const bm = ctx.full(); for (let y = 0; y < H; y++) if (y < y0 || y >= y1) bm.d.fill(T, y * ctx.Wb, (y + 1) * ctx.Wb); paint(bm.d, ctx.Wb, 0, x => ctx.wx(x)); return { bm, depth: p.depth ?? 0 }; }
  return { depth: p.depth ?? 0, bake(acc) { paint(acc.d, ctx.Wb, 0, x => ctx.wx(x)); }, draw(fb, t, off, sc2) { paint(fb, sc2.W, t, x => ctx.wx(x + PAD - off)); } };
});

// ------------------------------------------------------------------ paper: dot grid / ruled lines / fibres
// {c, grain:[c, d], dots:{c, every}, rules:{c, every, from}, margin:{c, x}, tape:[[x, y, w, h, c]]}
layer('paper', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c); const s = ctx.seed + 5;
  for (let y = 0; y < H; y++) for (let bx = 0; bx < ctx.Wb; bx++) {
    const wx = ctx.wx(bx); let v = c;
    if (p.grain && h2(wx, y, s) < p.grain[1]) v = ctx.c(p.grain[0]);
    if (p.rules && y >= (p.rules.from ?? 0) && (y - (p.rules.from ?? 0)) % p.rules.every === 0) v = ctx.c(p.rules.c);
    if (p.dots && mod(wx, p.dots.every) === 0 && y % p.dots.every === (p.dots.oy ?? 2)) v = ctx.c(p.dots.c);
    if (p.margin && wx === p.margin.x) v = ctx.c(p.margin.c);
    bm.d[y * ctx.Wb + bx] = v;
  }
  for (const [x, y, w, h, tc] of p.tape || []) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (od(x + i, y + j, 0.75) || j === 0 || j === h - 1) put(bm, ctx.bx(x + i + (j * (p.tapeSlant ?? 0) | 0)), y + j, ctx.c(tc));
  return { bm, depth: 0 };
});

// ------------------------------------------------------------------ rects (bezels, screens, labels) {list:[[x, y, w, h, c, round]]}
layer('rects', (ctx, p) => {
  const bm = ctx.full();
  for (const [x, y, w, h, c, r = 0] of p.list) { const ci = ctx.c(c); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const cx = Math.min(i, w - 1 - i), cy = Math.min(j, h - 1 - j); if (r && cx + cy < r) continue; put(bm, ctx.bx(x + i), y + j, ci); } }
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ circuit traces with current flowing along them
// {n, y:[a,b], x:[a,b], c: trace, pad, pulse:[head, tail], speed (px/s), pulses (per trace)}
layer('traces', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), pad = ctx.c(p.pad ?? p.c); const R = ctx.rand(strSeed(p.id || 'tr'));
  const [ya, yb] = p.y || [4, 52]; const [xa, xb] = p.x || [ctx.wx(0) - 20, ctx.wx(ctx.Wb) + 20];
  const paths = [];
  for (let i = 0; i < (p.n ?? 14); i++) {
    let x = Math.round(xa + R() * (xb - xa)), y = Math.round(ya + R() * (yb - ya)); const pts = [[x, y]]; const dir = R() < 0.5 ? 1 : -1;
    const segs = 3 + Math.floor(R() * 4);
    for (let k = 0; k < segs; k++) {
      const run = 6 + Math.floor(R() * 34); for (let j = 0; j < run; j++) { x += dir; pts.push([x, y]); }
      const jog = (R() < 0.5 ? -1 : 1) * (2 + Math.floor(R() * 7)); const sy = Math.sign(jog);
      for (let j = 0; j < Math.abs(jog); j++) { x += dir; y = clamp(y + sy, ya, yb); pts.push([x, y]); }   // 45° jog, the PCB way
    }
    paths.push(pts);
    for (const [px, py] of pts) put(bm, ctx.bx(px), py, c);
    for (const [px, py] of [pts[0], pts[pts.length - 1]]) { for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) put(bm, ctx.bx(px + dx), py + dy, pad); }
  }
  if (!p.pulse) return { bm, depth: p.depth };
  const [hc, tc] = p.pulse.map(q => ctx.c(q)); const sp = p.speed ?? 18;
  const pulses = paths.map((pts, i) => { const len = pts.length; const cyc = Math.max(1, Math.round(sp * ctx.L / len)); return { pts, cyc, ph: h1(i, 77), k: p.pulses ?? 1 }; });
  return [{ bm, depth: p.depth }, { depth: p.depth, draw(fb, t, off, sc) {
    for (const q of pulses) for (let k = 0; k < q.k; k++) { const pos = Math.floor(mod((t / ctx.L) * q.cyc + q.ph + k / q.k, 1) * q.pts.length);
      for (let j = 0; j < (p.tail ?? 4); j++) { const pt = q.pts[pos - j]; if (!pt) break; fset(fb, sc.W, sxOf(ctx, pt[0], off), pt[1], j === 0 ? hc : tc); } }
  } }];
});

// ------------------------------------------------------------------ 7-segment readout {x, y, digits:'88:88', mode:'clock'|'count'|'static', c:[on, off], scale}
const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
layer('segments', (ctx, p) => {
  const on = ctx.c(p.c[0]), offc = ctx.c(p.c[1]); const s = p.scale ?? 1; const w = 4 * s, hh = 4 * s; // segment lengths
  const glyph = (put1, x, y, ch) => {
    if (ch === ':') { put1(x + 1, y + hh - 1, on); put1(x + 1, y + hh + 2, on); return 3; }
    const bits = SEG[+ch] ?? 0;
    const segs = [[0, [x + 1, y, w, 1]], [1, [x + w + 1, y + 1, 1, hh]], [2, [x + w + 1, y + hh + 2, 1, hh]], [3, [x + 1, y + 2 * hh + 2, w, 1]], [4, [x, y + hh + 2, 1, hh]], [5, [x, y + 1, 1, hh]], [6, [x + 1, y + hh + 1, w, 1]]];
    for (const [b, [sx, sy, sw, sh]] of segs) { const col = bits & (1 << b) ? on : offc; for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) put1(sx + i, sy + j, col); }
    return w + 4;
  };
  const text = t => { if (p.mode === 'clock') { const v = Math.floor(mod(t + (p.start ?? 0), ctx.L)); return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; } if (p.mode === 'count') return String(Math.floor(mod(t * (p.rate ?? 1) + (p.start ?? 0), 10 ** p.digits))).padStart(p.digits, '0'); return p.text; };
  const drawAt = (put1, t) => { let x = p.x; for (const ch of text(t)) x += glyph(put1, x, p.y, ch); };
  if (p.mode === 'static') { const bm = ctx.full(); drawAt((x, y, c) => put(bm, ctx.bx(x), y, c), 0); return { bm, depth: p.depth }; }
  return { depth: p.depth ?? 0, bake(acc) { drawAt((x, y, c) => put(acc, ctx.bx(x), y, c), 0); }, draw(fb, t, off, sc) { drawAt((x, y, c) => fset(fb, sc.W, sxOf(ctx, x, off), y, c), t); } };
});

// ------------------------------------------------------------------ LED bar meter {x, y, n, w, h, gap, c:[low, mid, high, off], period}
layer('ledbar', (ctx, p) => {
  const [lo, mi, hi, of] = p.c.map(c => ctx.c(c)); const n = p.n ?? 12, w = p.w ?? 3, hgt = p.h ?? 2, gap = p.gap ?? 1; const cyc = ctx.cyc(p.period ?? 3); const s = ctx.seed + 3;
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) {
    const f = (t / ctx.L) * cyc; const lvl = Math.round(n * (0.35 + 0.3 * Math.sin(TAU * f) + 0.25 * Math.sin(TAU * f * 3.0 + 1) * noise1(f * 4, s)));
    for (let i = 0; i < n; i++) { const c = i >= lvl ? of : i > n * 0.8 ? hi : i > n * 0.55 ? mi : lo; const x0 = sxOf(ctx, p.x + i * (w + gap), off); for (let j = 0; j < hgt; j++) for (let k = 0; k < w; k++) fset(fb, sc.W, x0 + k, p.y + j, c); }
  } };
});

// ------------------------------------------------------------------ the souldew wordmark and ring mark
// wordmark {size:'L'|'S', x (centre), y (top), c, shadow, scroll: true (drops in during the intro, 16 steps), cursor:{c, period}}
layer('wordmark', (ctx, p) => {
  const art = p.size === 'S' ? WORD_S : WORD_L; const w = art[0].length, h = art.length; const c = ctx.c(p.c), sh = p.shadow != null ? ctx.c(p.shadow) : null; const d = p.size === 'S' ? 1 : 2;
  const x0 = p.x - (w >> 1);
  const plot = (put1, dy) => {
    if (sh != null) art.forEach((r, j) => { for (let i = 0; i < w; i++) if (r[i] === 'a') put1(x0 + i + d, p.y + j + d + dy, sh); });
    art.forEach((r, j) => { for (let i = 0; i < w; i++) if (r[i] === 'a') put1(x0 + i, p.y + j + dy, c); });
  };
  if (p.marquee) { const cyc = ctx.cyc(p.marquee); return { depth: p.depth ?? 0, draw(fb, t, off, sc) { const D = sc.W + w + 24; const sx = Math.round(sc.W + 12 - mod((t / ctx.L) * cyc, 1) * D);
    art.forEach((r, j) => { for (let i = 0; i < w; i++) if (r[i] === 'a') { if (sh != null) fset(fb, sc.W, sx + i + d, p.y + j + d, sh); } }); art.forEach((r, j) => { for (let i = 0; i < w; i++) if (r[i] === 'a') fset(fb, sc.W, sx + i, p.y + j, c); }); } }; }
  if (!p.scroll && !p.cursor) { const bm = ctx.full(); plot((x, y, col) => put(bm, ctx.bx(x), y, col), 0); return { bm, depth: p.depth }; }
  const cur = p.cursor && { c: ctx.c(p.cursor.c), cyc: ctx.cyc(p.cursor.period ?? 1) };
  return { depth: p.depth ?? 0, bake(acc) { plot((x, y, col) => put(acc, ctx.bx(x), y, col), 0); }, draw(fb, t, off, sc) {
    const dur = p.scrollDur ?? 1.2; let dy = 0;
    if (p.scroll && !sc.noIntro && t < dur) dy = -Math.round((p.y + h + 2) * (1 - Math.floor((t / dur) * 16) / 16));   // 16 hard steps, like the app's own boot
    plot((x, y, col) => fset(fb, sc.W, sxOf(ctx, x, off), y, col), dy);
    if (cur && mod((t / ctx.L) * cur.cyc, 1) < 0.5) for (let i = 0; i < (p.cursor.w ?? 6); i++) { fset(fb, sc.W, sxOf(ctx, x0 + w + 3 + i, off), p.y + h - 1, cur.c); fset(fb, sc.W, sxOf(ctx, x0 + w + 3 + i, off), p.y + h - 2, cur.c); }
  } };
});
// rings {size:'L'|'S', x (centre), y (top), c:[blue, pink, bar], appear: seconds into the intro (hidden before)}
layer('rings', (ctx, p) => {
  const art = p.size === 'S' ? RINGS_S : RINGS_L; const w = art[0].length; const map = { b: ctx.c(p.c[0]), p: ctx.c(p.c[1]), w: ctx.c(p.c[2]) }; const x0 = p.x - (w >> 1);
  const plot = put1 => art.forEach((r, j) => { for (let i = 0; i < w; i++) if (map[r[i]] != null) put1(x0 + i, p.y + j, map[r[i]]); });
  if (p.appear == null) { const bm = ctx.full(); plot((x, y, c) => put(bm, ctx.bx(x), y, c)); return { bm, depth: p.depth }; }
  return { depth: p.depth ?? 0, bake(acc) { plot((x, y, c) => put(acc, ctx.bx(x), y, c)); }, draw(fb, t, off, sc) {
    if (!sc.noIntro && t < p.appear) { if (t > p.appear - 0.3 && Math.floor(t * 10) % 2) plot((x, y) => fset(fb, sc.W, sxOf(ctx, x, off), y, map.w)); return; }
    plot((x, y, c) => fset(fb, sc.W, sxOf(ctx, x, off), y, c)); } };
});

// ------------------------------------------------------------------ screen overlays: CRT scanlines (with a slow rolling band), LCD dot grid
layer('scanlines', (ctx, p) => {
  const dark = ctx.lut(p.to ?? '#000000', p.amt ?? 0.35); const lite = ctx.lut(p.roll?.to ?? '#ffffff', p.roll?.amt ?? 0.15); const cyc = p.roll ? ctx.cyc(p.roll.period ?? 8) : 0; const [y0, y1] = p.y || [0, H];
  return { depth: 0, draw(fb, t, off, sc) {
    const band = cyc ? Math.floor(mod((t / ctx.L) * cyc, 1) * (y1 - y0 + 16)) + y0 - 8 : -99;
    for (let y = y0; y < y1; y++) { const d = Math.abs(y - band); for (let x = 0; x < sc.W; x++) { const i = y * sc.W + x; if (y % 2 === 1) fb[i] = dark[fb[i]]; else if (d < 4 && od(x, y, 1 - d / 4)) fb[i] = lite[fb[i]]; } }
  } };
});
layer('lcdgrid', (ctx, p) => {
  const lut = ctx.lut(p.to, p.amt ?? 0.25); const every = p.every ?? 3; const [y0, y1] = p.y || [0, H]; const [xa, xb] = p.x || [-1e9, 1e9];
  const only = new Uint8Array(256); if (p.only) for (const c of p.only) only[ctx.c(c)] = 1; else only.fill(1);
  let idx = null, forW = -1;   // the grid never pans (depth 0): its pixel list is computed once per width
  return { depth: 0, draw(fb, t, off, sc) {
    if (forW !== sc.W) { const list = []; for (let y = y0; y < y1; y++) for (let x = 0; x < sc.W; x++) { const wx = ctx.wx(x + PAD); if (wx < xa || wx > xb) continue; if (mod(wx, every) !== 0 && y % every !== 0) continue; list.push(y * sc.W + x); } idx = Int32Array.from(list); forW = sc.W; }
    for (let k = 0; k < idx.length; k++) { const i = idx[k], v = fb[i]; if (only[v]) fb[i] = lut[v]; }
  } };
});

// ------------------------------------------------------------------ SoulLink thread: two lights joined by a sagging thread, pulses meet in the middle
// {a:[x,y], b:[x,y], sag, c: thread, orbs:[[core, glow], [core, glow]], r, period, dots: spacing}
layer('thread', (ctx, p) => {
  const tc = ctx.c(p.c); const oa = p.orbs[0].map(c => ctx.c(c)), ob = p.orbs[1].map(c => ctx.c(c)); const r = p.r ?? 3; const cyc = ctx.cyc(p.period ?? 4);
  const [ax, ay] = p.a, [bx, by] = p.b; const n = Math.ceil(Math.abs(bx - ax)); const pts = [];
  for (let i = 0; i <= n; i++) { const u = i / n; pts.push([ax + (bx - ax) * u, ay + (by - ay) * u + (p.sag ?? 6) * 4 * u * (1 - u)]); }
  const orb = (fb, W, cx, cy, [core, glow], grow, off) => { const x = sxOf(ctx, cx, off); for (let y = -r - 3; y <= r + 3; y++) for (let xx = -r - 3; xx <= r + 3; xx++) { const d = Math.hypot(xx, y); if (d <= r + grow - 0.2) fset(fb, W, x + xx, cy + y, core); else if (d <= r + 2 + grow && od(x + xx, cy + y, 0.55 - (d - r) * 0.12)) fset(fb, W, x + xx, cy + y, glow); } };
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) {
    const f = mod((t / ctx.L) * cyc, 1); const pulse = Math.sin(TAU * f) > 0.6 ? 1 : 0;
    pts.forEach(([x, y], i) => { if (i % (p.dots ?? 2) === 0) fset(fb, sc.W, sxOf(ctx, Math.round(x), off), Math.round(y), tc); });
    const k = Math.floor(f * (n / 2));
    for (let j = 0; j < 3; j++) { const qa = pts[clamp(k - j, 0, n)], qb = pts[clamp(n - k + j, 0, n)]; fset(fb, sc.W, sxOf(ctx, Math.round(qa[0]), off), Math.round(qa[1]), j ? oa[1] : oa[0]); fset(fb, sc.W, sxOf(ctx, Math.round(qb[0]), off), Math.round(qb[1]), j ? ob[1] : ob[0]); }
    orb(fb, sc.W, ax, ay, oa, pulse, off); orb(fb, sc.W, bx, by, ob, pulse, off);
  } };
});

// ------------------------------------------------------------------ a sprite that passes once per loop (cyclist, cart, kite…) {frames:[art…], map, y, at, dur, dir, fps}
layer('pass', (ctx, p) => {
  const frames = p.frames.map(a => (SPRITES[a] || a)); const map = Object.fromEntries(Object.entries(p.map).map(([k, v]) => [k, ctx.c(v)])); const at = (p.at ?? 0.3) * ctx.L, dur = p.dur ?? 10, dir = p.dir ?? 1;
  return { depth: p.depth ?? 0.4, draw(fb, t, off, sc) {
    const dt = mod(t - at, ctx.L); if (dt > dur) return; const art = frames[Math.floor(dt * (p.fps ?? 6)) % frames.length]; const w = art[0].length, h = art.length; const D = sc.W + w * 2;
    const x0 = Math.round(dir > 0 ? -w + (dt / dur) * D : sc.W - (dt / dur) * D) + off;
    art.forEach((r, j) => { for (let i = 0; i < r.length; i++) { const ch = r[dir > 0 ? i : r.length - 1 - i]; if (map[ch] != null) fset(fb, sc.W, x0 + i, p.y - h + 1 + j, map[ch]); } });
  } };
});

// ------------------------------------------------------------------ tall grass that sways in travelling waves {y (root row), on, h:[a,b], density, c:[dark, mid, tip], amp, period, k}
layer('tallgrass', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const cyc = ctx.cyc(p.period ?? 6); const blades = [];
  for (let wx = ctx.wx(0) - 4; wx < ctx.wx(ctx.Wb) + 4; wx++) { if (h2(wx, 3, ctx.seed) > (p.density ?? 0.7)) continue; const [ha, hb] = p.h || [6, 14]; const base = p.on ? ctx.surf[p.on](wx) + 1 : p.y; blades.push({ wx, base, h: Math.round(ha + h2(wx, 5, ctx.seed) * (hb - ha)), c: h2(wx, 7, ctx.seed) < 0.5 ? 0 : 1 }); }
  return { depth: p.depth ?? 0.7, bake(acc) { for (const b of blades) for (let j = 0; j < b.h; j++) put(acc, ctx.bx(b.wx), b.base - j, j > b.h - 3 ? cs[2] : cs[b.c]); }, draw(fb, t, off, sc) {
    const f = (t / ctx.L) * cyc;
    for (const b of blades) { const sx = sxOf(ctx, b.wx, off); const lean = (p.amp ?? 2.2) * (0.6 + 0.4 * Math.sin(TAU * f - b.wx * (p.k ?? 0.045))) * Math.sin(TAU * f * 0.5 - b.wx * (p.k ?? 0.045) * 0.5 + 1);
      for (let j = 0; j < b.h; j++) { const u = j / b.h; fset(fb, sc.W, sx + Math.round(lean * u * u), b.base - j, j > b.h - 3 ? cs[2] : cs[b.c]); } }
  } };
});

// ------------------------------------------------------------------ electric arcs that crackle in bursts {pairs:[[x1,y1,x2,y2]…], c:[core, glow], period}
layer('arcs', (ctx, p) => {
  const [core, glow] = p.c.map(c => ctx.c(c)); const cyc = ctx.cyc(p.period ?? 3);
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) {
    const f = mod((t / ctx.L) * cyc, 1); if (f > (p.duty ?? 0.35)) return; const step = Math.floor(t * 12);
    p.pairs.forEach(([x1, y1, x2, y2], n) => { const x = x1, y = y1; const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)); let px = x, py = y;
      for (let i = 1; i <= steps; i++) { const u = i / steps; const nx = Math.round(x1 + (x2 - x1) * u + (h2(i, step + n * 31, 5) - 0.5) * 5 * Math.sin(u * Math.PI)), ny = Math.round(y1 + (y2 - y1) * u + (h2(i, step + n * 17, 9) - 0.5) * 5 * Math.sin(u * Math.PI));
        const steps2 = Math.max(Math.abs(nx - px), Math.abs(ny - py), 1); for (let k = 0; k <= steps2; k++) { const qx = Math.round(px + (nx - px) * k / steps2), qy = Math.round(py + (ny - py) * k / steps2); fset(fb, sc.W, sxOf(ctx, qx, off), qy, core); if (od(qx, qy, 0.5)) fset(fb, sc.W, sxOf(ctx, qx, off), qy - 1, glow); } px = nx; py = ny; } });
  } };
});

// ------------------------------------------------------------------ a stone arena of no particular design {x, base, w, h, c:[wall, shade, light, dark], tiers, flags:[c…]}
layer('arena', (ctx, p) => {
  const bm = ctx.full(); const [cw, cs, cl, cd] = p.c.map(c => ctx.c(c)); const cx = ctx.bx(p.x), hw = p.w / 2;
  for (let x = Math.floor(cx - hw); x <= cx + hw; x++) { const u = (x - cx) / hw; const top = Math.round(p.base - p.h * (0.78 + 0.22 * Math.sqrt(Math.max(0, 1 - u * u))));
    for (let y = top; y <= p.base; y++) { let c = u < -0.55 ? cl : u > 0.45 ? cs : cw; if (y === top) c = cl; bm.d[y * ctx.Wb + x] = c; } }
  const tiers = p.tiers ?? 2; const th = Math.floor(p.h * 0.7 / tiers);
  for (let k = 0; k < tiers; k++) { const yb = p.base - 1 - k * th; for (let x = Math.ceil(cx - hw + 3); x < cx + hw - 3; x += 5) { const u = (x - cx) / hw; if (Math.abs(u) > 0.92) continue; for (let y = yb - th + 3; y <= yb; y++) for (let i = 0; i < 3; i++) if (!(y === yb - th + 3 && i !== 1)) put(bm, x + i, y, cd); }
    for (let x = Math.ceil(cx - hw); x <= cx + hw; x++) put(bm, x, yb - th + 1, cs); }
  (p.flags || []).forEach((fc, i, a) => { const x = Math.round(cx - hw * 0.8 + (i * hw * 1.6) / Math.max(1, a.length - 1)); const u = (x - cx) / hw; const top = Math.round(p.base - p.h * (0.78 + 0.22 * Math.sqrt(Math.max(0, 1 - u * u)))); for (let y = top - 6; y < top; y++) put(bm, x, y, cd); for (let j = 0; j < 2; j++) for (let q = 1; q <= 3; q++) put(bm, x + q, top - 6 + j, ctx.c(fc)); });
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ a winding path / route {pts:[[x, y, halfWidth]…] top→bottom, c, edge, tex:[c, d]}
layer('path', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), e = p.edge != null ? ctx.c(p.edge) : null, s = ctx.seed + 11;
  for (let k = 0; k + 1 < p.pts.length; k++) { const [ax, ay, aw] = p.pts[k], [bx, by, bw] = p.pts[k + 1];
    for (let y = Math.round(ay); y <= Math.round(by); y++) { const u = (y - ay) / Math.max(1, by - ay); const cx = ax + (bx - ax) * u, w = aw + (bw - aw) * u;
      for (let x = Math.round(cx - w); x <= Math.round(cx + w); x++) { let v = (e != null && (x === Math.round(cx - w) || x === Math.round(cx + w))) ? e : c; if (p.tex && h2(x, y, s) < p.tex[1]) v = ctx.c(p.tex[0]); put(bm, ctx.bx(x), y, v); } } }
  return { bm, depth: p.depth };
});
