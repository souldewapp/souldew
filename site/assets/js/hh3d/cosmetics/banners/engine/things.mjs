// Foliage, props and buildings. Everything sits on a surface (ctx.surf[id]) or a fixed row, in design-frame x.
import { H, PAD, T, layer, put, get, rect, hline, vline, line, disc, ellipse, od, h1, h2, noise1 } from './core.mjs';
import { SPRITES } from './sprites.mjs';

const strSeed = s => { let h = 7; for (const ch of String(s || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

/** scatter positions in design x, stable across widths: one candidate per cell of `spacing` px */
export function scatter(ctx, p, salt) {
  if (p.at) return p.at.map(a => (Array.isArray(a) ? { x: a[0], h: a[1], k: typeof a[2] === 'string' ? a[2] : undefined, r: typeof a[2] === 'number' ? a[2] : undefined } : a));
  const sp = p.spacing || 10, s = (ctx.seed * 13 + strSeed(salt)) >>> 0, out = [];
  const a = Math.floor((ctx.wx(0) - 20) / sp), b = Math.ceil((ctx.wx(ctx.Wb) + 20) / sp);
  const [x0, x1] = p.range || [-1e9, 1e9];
  for (let i = a; i <= b; i++) {
    if (h1(i, s) > (p.chance ?? 1)) continue;
    const x = Math.round(i * sp + h1(i, s + 1) * sp * (p.jitter ?? 0.8));
    if (p.cluster && noise1(x * p.cluster[0], s + 9) < p.cluster[1]) continue;
    if (x < x0 || x > x1) continue;
    const [ha, hb] = p.h || [8, 14]; out.push({ x, h: Math.round(ha + Math.pow(h1(i, s + 2), p.hpow ?? 1) * (hb - ha)), r: h1(i, s + 3) });
  }
  return out;
}
const baseY = (ctx, p, x) => (p.on ? ctx.surf[p.on](x) + (p.sink ?? 1) : p.y);

// ------------------------------------------------------------------ trees
function pine(bm, x, b, h, c, cl, r) {
  vline(bm, x, b - 1, b, c);
  const tiers = Math.max(2, Math.round(h / 5)); const top = b - h;
  for (let y = top; y < b - 1; y++) {
    const u = (y - top) / (h - 1); const tier = Math.floor(u * tiers); const tu = u * tiers - tier;
    const half = Math.round((0.6 + tier * 0.9 + tu * 1.9) * (h / 14) * 1.15);
    hline(bm, x - half, x + half, y, c);
    if (cl != null && half > 0 && tu > 0.4) put(bm, x + half, y, cl);
  }
  put(bm, x, top - 1, c);
}
function round(bm, x, b, h, c, cl, r, wide = 1) {
  vline(bm, x, b - Math.ceil(h * 0.35), b, c);
  const rad = h * 0.38 * wide, cy = b - h + rad;
  const blobs = [[0, 0, 1], [-rad * 0.55, rad * 0.25, 0.75], [rad * 0.55, rad * 0.2, 0.78], [rad * 0.1, -rad * 0.35, 0.7]];
  for (const [dx, dy, k] of blobs) disc(bm, x + dx, cy + dy, rad * k, c);
  if (cl != null) for (const [dx, dy, k] of blobs) disc(bm, x + dx, cy + dy, rad * k, cl, (px, py, ddx, ddy) => get(bm, px, py) === c && (ddx * 0.6 + ddy) / (rad * k) < -0.45 && od(px, py, 0.7));
}
function cypress(bm, x, b, h, c, cl) { ellipse(bm, x, b - h / 2, Math.max(1.5, h / 7), h / 2, c); if (cl != null) ellipse(bm, x, b - h / 2, Math.max(1.5, h / 7), h / 2, cl, (px, py, dx) => dx > 0.45 && od(px, py, 0.6)); }
function palm(bm, x, b, h, c, cl, r) {
  const lean = (r - 0.5) * 2; let tx = x, ty = b - h;
  for (let i = 0; i <= h; i++) { const u = i / h; const xx = Math.round(x + lean * u * u * h * 0.35); put(bm, xx, b - i, c); if (u < 0.45) put(bm, xx + 1, b - i, c); if (i === h) { tx = xx; ty = b - i; } }
  for (const [a, lk] of [[-2.9, 1], [-2.4, 0.85], [-1.85, 0.7], [-1.25, 0.75], [-0.75, 0.9], [-0.25, 1]]) {
    const L = (h * 0.45 + 3) * lk;
    for (let s = 0; s <= L; s += 0.5) { const px = tx + Math.cos(a) * s, py = ty + Math.sin(a) * s * 0.7 + (s * s) / (L * 1.5); put(bm, Math.round(px), Math.round(py), c); if (s > L * 0.2 && s < L * 0.75 && h1(Math.round(s * 2), Math.round(a * 10)) < 0.7) put(bm, Math.round(px), Math.round(py) + 1, c); }
  }
  disc(bm, tx, ty + 1, 1.2, c);
  put(bm, tx, ty, c); put(bm, tx + 1, ty, c);
}
function bare(bm, x, b, h, c, cl, r) {
  const rec = (x0, y0, a, len, d) => { const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len; line(bm, x0, y0, x1, y1, c); if (d > 0) { const k = h1(Math.round(x0 * 7 + y0), d); rec(x1, y1, a - 0.45 - k * 0.3, len * 0.68, d - 1); rec(x1, y1, a + 0.4 + k * 0.3, len * 0.66, d - 1); } };
  vline(bm, x, b - Math.round(h * 0.35), b, c); rec(x, b - h * 0.35, -Math.PI / 2 + (r - 0.5) * 0.3, h * 0.32, 3);
}
function birch(bm, x, b, h, c, cl, r) { vline(bm, x, b - h, b, cl ?? c); for (let y = b - h; y <= b; y += 3 + Math.round(r * 2)) put(bm, x, y, c); }
function bush(bm, x, b, h, c, cl) { ellipse(bm, x, b - h / 2, h * 0.9, h / 2, c, (px, py) => py <= b); if (cl != null) ellipse(bm, x, b - h / 2, h * 0.9, h / 2, cl, (px, py, dx, dy) => dy < -0.45 && od(px, py, 0.5)); }
function bamboo(bm, x, b, h, c, cl, r) { // a stalk with node rings and a few leaf strokes; cl = node colour
  const w = r > 0.6 ? 2 : 1; for (let y = b - h; y <= b; y++) for (let i = 0; i < w; i++) put(bm, x + i, y, c);
  const step = 6 + Math.round(r * 4); for (let y = b - 2; y > b - h; y -= step) { if (cl != null) for (let i = -1; i < w + 1; i++) put(bm, x + i, y, cl); if (h1(y, x) < 0.5) { const d = h1(y, x + 1) < 0.5 ? -1 : 1; line(bm, x + (d > 0 ? w : -1), y - 1, x + d * 5, y - 3, c); line(bm, x + (d > 0 ? w : -1), y - 1, x + d * 4, y + 1, c); } }
}
function snowpine(bm, x, b, h, c, cl, r) { pine(bm, x, b, h, c, null, r); if (cl == null) return; const top = b - h - 1; for (let y = top; y < b - 2; y++) for (let xx = x - h; xx <= x + h; xx++) if (get(bm, xx, y) === c && get(bm, xx, y - 1) !== c && get(bm, xx, y + 1) === c && (y === top || Math.abs(xx - x) > 0) && h1(xx * 3 + y, 9) < 0.55) put(bm, xx, y, cl); }
const TREES = { pine, bamboo, snowpine, round, cypress, palm, bare, birch, bush, wide: (bm, x, b, h, c, cl, r) => round(bm, x, b, h, c, cl, r, 1.35) };

// {kind, on|y, at|spacing/chance/h, c, light?, trunk?}
layer('trees', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), cl = p.light != null ? ctx.c(p.light) : null;
  for (const t of scatter(ctx, p, (p.id || 'trees') + p.kind)) {
    const kind = t.k || p.kind; const fn = TREES[kind]; if (!fn) throw new Error('tree kind ' + kind);
    fn(bm, ctx.bx(t.x), baseY(ctx, p, t.x), t.h, c, cl, t.r ?? 0.5);
    if (p.shadow != null) { const sh = ctx.c(p.shadow), bx = ctx.bx(t.x), b = baseY(ctx, p, t.x); for (let y = b - t.h; y <= b; y++) for (let x = bx - t.h; x <= bx + t.h; x++) { if (get(bm, x, y) !== c) continue; const below = get(bm, x, y + 1); if ((y > b - t.h * 0.45 && od(x, y, 0.75)) || below === T) put(bm, x, y, sh); } }
  }
  return { bm, depth: p.depth };
});

// cattails / reeds / grass tufts along a row or surface. {y|on, spacing, h, c, heads, leaves}
layer('reeds', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c);
  for (const t of scatter(ctx, p, p.id || 'reeds')) {
    const x = ctx.bx(t.x), b = baseY(ctx, p, t.x), lean = t.r < 0.25 ? -1 : t.r > 0.75 ? 1 : 0;
    for (let i = 0; i < t.h; i++) put(bm, x + (i > t.h * 0.6 ? lean : 0), b - i, c);
    if (p.heads !== false && t.r > 0.2) { const hx = x + lean; for (let y = b - t.h + 1; y < b - t.h + 5; y++) { put(bm, hx, y, c); put(bm, hx + 1, y, c); } }
    if (p.leaves !== false && t.r > 0.5) for (let i = 0; i < 5; i++) put(bm, x - 1 - (i >> 1), b - 3 - i, c);
  }
  return { bm, depth: p.depth };
});
layer('grass', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), cl = p.light != null ? ctx.c(p.light) : null;
  for (const t of scatter(ctx, p, p.id || 'grass')) {
    const x = ctx.bx(t.x), b = baseY(ctx, p, t.x);
    for (let k = -2; k <= 2; k++) { const hh = Math.max(1, Math.round(t.h * (1 - Math.abs(k) * 0.3))); line(bm, x + k, b, x + k * 1.6, b - hh, Math.abs(k) === 1 && cl != null ? cl : c); }
  }
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ sprites (hand-drawn ASCII, sprites.mjs)
// {art: name, at:[[x, y?]…] or x/y, on, map:{char: colour}, flip, lights: {blink fraction}}
layer('sprite', (ctx, p) => {
  const bm = ctx.full();
  const list = p.at ? p.at : [[p.x, p.y, p.flip]];
  for (const [x, y0, flip = p.flip] of list) {
    const art = SPRITES[p.art] || p.art; const rows = Array.isArray(art) ? art : art.split('\n');
    const w = Math.max(...rows.map(r => r.length)), h = rows.length;
    const b = y0 ?? baseY(ctx, p, x); const left = ctx.bx(x) - (w >> 1);
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) {
      const ch = row[flip ? row.length - 1 - i : i]; if (ch === '.' || ch === ' ') continue;
      const col = p.map[ch]; if (col == null) continue; const bx = left + i + (flip ? w - row.length : 0), y = b - h + 1 + j;
      put(bm, bx, y, ctx.c(col));
      if (p.lights && ch === (p.lightChar || 'w')) ctx.lights.push({ bx, y, on: ctx.c(col), off: ctx.c(p.lights.off ?? p.map.a), blink: p.lights.blink ?? 0.3, eye: p.lights.eye, ph: x * 0.013 });
    } });
  }
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ city skyline
/* {base, h:[min,max], w:[min,max], gap, c, edge?, win:{c, off, d, every:[dx,dy]}, roofs, focus:{x, w, boost}, blink} */
layer('city', (ctx, p) => {
  const bm = ctx.full(); const s = (ctx.seed * 17 + strSeed(p.id || 'city')) >>> 0; const c = ctx.c(p.c), ce = p.edge != null ? ctx.c(p.edge) : null;
  const wc = p.win && ctx.c(p.win.c), wo = p.win && p.win.off != null ? ctx.c(p.win.off) : null;
  const [wa, wb] = p.w || [6, 14], [ha, hb] = p.h || [8, 22];
  let x = Math.min(-900, ctx.wx(0) - 40), i = 0; const end = Math.max(1300, ctx.wx(ctx.Wb) + 40);
  const [r0, r1] = p.range || [-1e9, 1e9]; const explicit = p.at ? p.at.slice() : null; if (explicit) x = explicit[0][0];
  while (explicit ? i < explicit.length : x < end) {
    if (explicit) x = explicit[i][0];
    const w = explicit ? explicit[i][1] : Math.round(wa + h1(i, s) * (wb - wa));
    let hh = explicit ? explicit[i][2] : ha + Math.pow(h1(i, s + 1), 1.3) * (hb - ha);
    if (p.focus) hh += p.focus.boost * Math.max(0, 1 - Math.abs(x + w / 2 - p.focus.x) / p.focus.w);
    hh = Math.round(hh);
    if (x + w >= r0 && x <= r1) {
      const left = ctx.bx(x), top = p.base - hh;
      rect(bm, left, top, w, hh + 1, c);
      if (ce != null) for (let y = top; y <= p.base; y++) put(bm, left + w - 1, y, ce);
      const roof = h1(i, s + 3);
      if (p.roofs !== false) {
        if (roof < 0.16) { rect(bm, left + 1, top - 1, w - 2, 1, c); rect(bm, left + 2, top - 2, w - 4, 1, c); }               // stepped crown
        else if (roof < 0.3 && w > 6) { const tx = left + 1 + Math.floor(h1(i, s + 4) * (w - 5)); rect(bm, tx, top - 4, 3, 3, c); put(bm, tx, top - 1, c); put(bm, tx + 2, top - 1, c); } // water tank
        else if (roof < 0.42) { const ax = left + Math.floor(w / 2); vline(bm, ax, top - 2 - Math.floor(h1(i, s + 5) * 6), top, c); if (p.mast) ctx.lights.push({ bx: ax, y: top - 2 - Math.floor(h1(i, s + 5) * 6) - 1, on: ctx.c(p.mast), off: c, blink: 1, mast: true }); } // antenna
        else if (roof < 0.5) { for (let k = 0; k < Math.min(4, w >> 1); k++) hline(bm, left + k, left + w - 1 - k, top - 1 - k, c); } // gable
      }
      if (wc != null) {
        const [ex, ey] = p.win.every || [2, 3];
        for (let y = top + 2; y < p.base - 1; y += ey) for (let xx = left + 1; xx < left + w - 1; xx += ex) {
          const lit = h2(xx + ctx.x0, y, s) < (p.win.d ?? 0.35);
          if (lit) { put(bm, xx, y, wc); if (p.blink !== false) ctx.lights.push({ bx: xx, y, on: wc, off: wo ?? c, blink: p.win.blink ?? 0.25 }); }
          else if (wo != null) put(bm, xx, y, wo);
        }
      }
    }
    x += w + (p.gap ? Math.round(h1(i, s + 6) * p.gap) : 0); i++;
  }
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ ruins: columns, broken arches, rubble
layer('ruins', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c), cl = p.light != null ? ctx.c(p.light) : null;
  for (const [x, h, broken = 0] of p.columns || []) {
    const bx = ctx.bx(x), b = p.y; const w = p.w ?? 3;
    rect(bm, bx - 1, b - 1, w + 2, 2, c); rect(bm, bx, b - h, w, h, c);
    if (cl != null) vline(bm, bx, b - h, b - 2, cl);
    if (!broken) rect(bm, bx - 1, b - h - 2, w + 2, 2, c); else { put(bm, bx + w - 1, b - h - 1, c); put(bm, bx + 1, b - h - 1, c); }
  }
  for (const [x, w, top] of p.arches || []) { // a lintel or arch spanning between columns
    const bx = ctx.bx(x); for (let i = 0; i <= w; i++) { const u = i / w; const y = Math.round(top + (1 - Math.sin(u * Math.PI)) * (p.archRise ?? 0)); rect(bm, bx + i, y, 1, 3, c); }
  }
  for (const [x, w] of p.rubble || []) { const bx = ctx.bx(x); for (let i = 0; i < w; i++) put(bm, bx + i, p.y - (h1(i, x) > 0.6 ? 1 : 0), c); }
  return { bm, depth: p.depth };
});

// ------------------------------------------------------------------ lighthouse (+ animated beam)
/* {x, base, h, c:{body, stripe, dark, lamp, cap}, beam:{to:colour, amt, len, period, spread}} */
layer('lighthouse', (ctx, p) => {
  const bm = ctx.full(); const C = Object.fromEntries(Object.entries(p.c).map(([k, v]) => [k, ctx.c(v)]));
  const cx = ctx.bx(p.x), b = p.base, h = p.h;
  for (let y = b - h; y <= b; y++) {
    const u = (y - (b - h)) / h; const half = Math.round(1.5 + u * (p.taper ?? 2.2));
    const band = Math.floor((b - y) / (p.band ?? 4)) % 2 === 1;
    hline(bm, cx - half, cx + half, y, band && C.stripe != null ? C.stripe : C.body);
    if (C.dark != null) put(bm, cx + half, y, C.dark);
  }
  const lt = b - h - 1; hline(bm, cx - 3, cx + 3, lt, C.dark ?? C.body);       // gallery
  rect(bm, cx - 1, lt - 3, 3, 3, C.lamp); put(bm, cx - 2, lt - 3, C.dark ?? C.body); put(bm, cx + 2, lt - 3, C.dark ?? C.body);
  hline(bm, cx - 2, cx + 2, lt - 4, C.cap ?? C.dark ?? C.body); put(bm, cx, lt - 5, C.cap ?? C.dark ?? C.body);
  const out = [{ bm, depth: p.depth }];
  if (p.beam) {
    const lx = p.x, ly = lt - 2; const B = p.beam; const lut = ctx.lut(B.to, B.amt ?? 0.45); const lut2 = ctx.lut(B.to, (B.amt ?? 0.45) * 0.5);
    const flash = ctx.c(B.flash ?? p.c.lamp); const cyc = ctx.cyc(B.period || 8);
    out.push({ depth: p.depth, draw(fb, t, off, sc) {
      const th = 2 * Math.PI * ((t / ctx.L) * cyc); const cx2 = ctx.bx(lx) - PAD + off; const reach = Math.cos(th) * (B.len ?? 120); const toward = Math.sin(th);
      if (Math.abs(reach) > 4) {
        const dir = Math.sign(reach), n = Math.abs(reach), spread = B.spread ?? 0.09;
        for (let i = 3; i < n; i++) { const x = cx2 + dir * i; if (x < 0 || x >= sc.W) continue; const hw = 1 + i * spread; const f = 1 - i / n;
          for (let y = Math.round(ly - hw); y <= Math.round(ly + hw * 0.6); y++) { if (y < 0 || y >= H) continue; const k = y * sc.W + x; const e = 1 - Math.abs(y - ly) / (hw + 1);
            if (od(x, y, f * e * 1.6)) fb[k] = (f > 0.5 && e > 0.5 ? lut : lut2)[fb[k]]; } }
      }
      if (toward > 0.92) { for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-2, 0], [2, 0]]) { const x = cx2 + dx, y = ly + dy; if (x >= 0 && x < sc.W && y >= 0 && y < H) fb[y * sc.W + x] = dx === 0 && dy === 0 ? flash : lut[fb[y * sc.W + x]]; } }
    } });
  }
  return out;
});

// ------------------------------------------------------------------ pier, bridge, crane, masts
layer('pier', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c);
  const a = ctx.bx(p.x0), b = ctx.bx(p.x1); hline(bm, a, b, p.y, c); if (p.rail) { hline(bm, a, b, p.y - 3, c); for (let x = a; x <= b; x += 4) vline(bm, x, p.y - 3, p.y, c); }
  for (let x = a + 1; x <= b; x += p.every ?? 6) vline(bm, x, p.y, p.y + (p.legs ?? 4), c);
  if (p.lamps) for (const lx of p.lamps) { vline(bm, ctx.bx(lx), p.y - 7, p.y, c); put(bm, ctx.bx(lx), p.y - 8, ctx.c(p.lampC)); ctx.lights.push({ bx: ctx.bx(lx), y: p.y - 8, on: ctx.c(p.lampC), off: c, blink: 0 }); }
  return { bm, depth: p.depth };
});
layer('bridge', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c); const a = ctx.bx(p.x0), b = ctx.bx(p.x1); const n = p.arches || 4; const span = (b - a) / n;
  rect(bm, a, p.y, b - a + 1, p.deck ?? 2, c); if (p.rail) for (let x = a; x <= b; x += 2) put(bm, x, p.y - 1, c);
  for (let i = 0; i < n; i++) { const x0 = a + i * span; for (let x = Math.round(x0); x <= Math.round(x0 + span); x++) { const u = (x - x0) / span; const yy = p.y + 2 + Math.round(Math.sin(u * Math.PI) * 0 + (1 - Math.sin(u * Math.PI)) * (p.rise ?? 6)); vline(bm, x, p.y, Math.min(yy, p.foot ?? H), c); } vline(bm, Math.round(x0), p.y, p.foot ?? H, c); vline(bm, Math.round(x0) + 1, p.y, p.foot ?? H, c); }
  if (p.lamps) for (let x = a + 3; x < b; x += p.lamps) { put(bm, x, p.y - 2, c); put(bm, x, p.y - 3, ctx.c(p.lampC)); ctx.lights.push({ bx: x, y: p.y - 3, on: ctx.c(p.lampC), off: c, blink: 0.1 }); }
  return { bm, depth: p.depth };
});
layer('crane', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c);
  for (const [x, b, h, jib, dir = 1] of p.at) { const bx = ctx.bx(x);
    for (let y = b - h; y <= b; y++) { put(bm, bx, y, c); put(bm, bx + 2, y, c); if ((b - y) % 3 === 0) put(bm, bx + 1, y, c); }
    const jy = b - h; hline(bm, bx - (dir < 0 ? jib : 4), bx + (dir > 0 ? jib : 4), jy, c); hline(bm, bx - (dir < 0 ? jib - 2 : 3), bx + (dir > 0 ? jib - 2 : 3), jy + 1, c);
    line(bm, bx + 1, jy - 3, bx + dir * jib, jy, c); put(bm, bx + 1, jy - 4, c);
    const hx = bx + dir * Math.round(jib * 0.7); vline(bm, hx, jy + 1, jy + 6, c); put(bm, hx - 1, jy + 6, c); put(bm, hx + 1, jy + 6, c);
    if (p.light) ctx.lights.push({ bx: bx + 1, y: jy - 5, on: ctx.c(p.light), off: T, blink: 1, mast: true });
  }
  return { bm, depth: p.depth };
});
layer('mast', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c);
  for (const [x, b, h] of p.at) { const bx = ctx.bx(x);
    for (let y = b - h; y <= b; y++) { const u = (y - (b - h)) / h; const half = Math.round(u * (p.spread ?? 2.5)); put(bm, bx - half, y, c); put(bm, bx + half, y, c); if ((b - y) % 3 === 0) hline(bm, bx - half, bx + half, y, c); }
    if (p.light) for (const k of [0, 0.45]) ctx.lights.push({ bx, y: Math.round(b - h - 1 + k * h), on: ctx.c(p.light), off: k ? c : T, blink: 1, mast: true, ph: k });
  }
  return { bm, depth: p.depth };
});

// a branch reaching into the frame {pts:[[x,y]…], w: start thickness, c, twigs, leaves:{c, d}}
layer('branch', (ctx, p) => {
  const bm = ctx.full(); const c = ctx.c(p.c); const R = ctx.rand(strSeed(p.id || 'branch')); const pts = p.pts; const n = pts.length;
  for (let i = 0; i + 1 < n; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const w0 = (p.w ?? 3) * (1 - i / n), w1 = (p.w ?? 3) * (1 - (i + 1) / n); const steps = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let k = 0; k <= steps; k++) { const u = k / steps; const x = ax + (bx - ax) * u, y = ay + (by - ay) * u, w = Math.max(1, w0 + (w1 - w0) * u); for (let j = 0; j < w; j++) put(bm, ctx.bx(Math.round(x)), Math.round(y + j - w / 2), c); }
    for (let k = 0; k < (p.twigs ?? 2); k++) { const u = R(); const x = ax + (bx - ax) * u, y = ay + (by - ay) * u; const dir = R() < 0.5 ? -1 : 1; const len = 3 + R() * 6; line(bm, ctx.bx(x), y, ctx.bx(x - len * 0.7), y + dir * len * 0.6, c); }
  }
  return { bm, depth: p.depth };
});
