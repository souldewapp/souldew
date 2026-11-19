// Animated layers. Each returns { draw(fb, t, off, scene), bake?(accum) }. draw() must be a pure function of t and
// periodic in the loop (ctx.cyc() rounds every rate to whole cycles), so the app can run it forever without a seam.
import { H, PAD, T, layer, bitmap, put, line, blit, od, h1, h2, noise1 } from './core.mjs';
import { SPRITES } from './sprites.mjs';

const TAU = Math.PI * 2;
const strSeed = s => { let h = 7; for (const ch of String(s || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fset = (fb, W, x, y, c) => { x |= 0; y |= 0; if (x >= 0 && x < W && y >= 0 && y < H) fb[y * W + x] = c; };
const fgetc = (fb, W, x, y) => (x >= 0 && x < W && y >= 0 && y < H ? fb[(y | 0) * W + (x | 0)] : -1);
const sxOf = (ctx, wx, off) => ctx.bx(wx) - PAD + off;   // design x → screen x
const mod = (a, n) => ((a % n) + n) % n;

// ------------------------------------------------------------------ stars (+ twinkle)
// {density: stars per 1000 px, y:[y0,y1], c:[dim, mid, bright], twinkle: fraction, cross: count of 4-point stars, avoid:[x0,x1]}
layer('stars', (ctx, p) => {
  const [y0, y1] = p.y || [0, 30]; const cs = p.c.map(c => ctx.c(c)); const s = ctx.seed + strSeed(p.id || 'stars');
  const stars = []; const dens = (p.density ?? 6) / 1000;
  for (let y = y0; y < y1; y++) for (let bx = 0; bx < ctx.Wb; bx++) {
    const wx = ctx.wx(bx); const r = h2(wx, y, s); let fall = p.fall ? 1 - (y - y0) / (y1 - y0) * p.fall : 1;
    if (p.band) { const b = p.band; const dd = ((wx - b.x) * Math.sin(b.angle) - (y - b.y) * Math.cos(b.angle)) / b.w; fall *= 1 + (b.mul ?? 4) * Math.exp(-dd * dd) * (0.5 + noise1(wx * 0.08, s + 8)); }
    if (r < dens * fall) { const q = h2(wx, y, s + 1); stars.push({ wx, y, lv: q < 0.12 ? 2 : q < 0.45 ? 1 : 0, tw: h2(wx, y, s + 2) < (p.twinkle ?? 0.3), cy: ctx.cyc([2, 3, 4, 6, 8][Math.floor(h2(wx, y, s + 3) * 5)]), ph: h2(wx, y, s + 4) }); }
  }
  // the brightest few become 4-point stars
  const crosses = stars.filter(st => st.lv === 2).sort((a, b) => h2(a.wx, a.y, s + 5) - h2(b.wx, b.y, s + 5)).slice(0, p.cross ?? 0);
  for (const c of crosses) c.cross = true;
  const level = (st, t) => { if (!st.tw) return st.lv; const v = Math.sin(TAU * ((t / ctx.L) * st.cy + st.ph)); return v > 0.7 ? Math.min(2, st.lv + 1) : v < -0.55 ? st.lv - 1 : st.lv; };
  const plot = (put1, st, t) => {
    const lv = level(st, t); if (lv < 0) return; put1(st.wx, st.y, cs[Math.min(lv, cs.length - 1)]);
    if (st.cross && lv >= 2) { const arm = cs[Math.max(0, cs.length - 2)]; put1(st.wx - 1, st.y, arm); put1(st.wx + 1, st.y, arm); put1(st.wx, st.y - 1, arm); put1(st.wx, st.y + 1, arm); }
  };
  return {
    depth: p.depth ?? 0,
    bake(acc) { for (const st of stars) plot((x, y, c) => put(acc, ctx.bx(x), y, c), st, 0); },
    draw(fb, t, off, sc) { for (const st of stars) plot((x, y, c) => fset(fb, sc.W, sxOf(ctx, x, off), y, c), st, t); },
  };
});

// ------------------------------------------------------------------ shooting stars / meteors
// {n per loop, x:[a,b] design range, y:[a,b], len, angle, dur, c:[head, tail, end]}
layer('shooting', (ctx, p) => {
  const R = ctx.rand(strSeed(p.id || 'shoot')); const cs = p.c.map(c => ctx.c(c)); const n = p.n ?? 1; const [xa, xb] = p.x || [120, 360], [ya, yb] = p.y || [3, 18];
  const ev = []; for (let i = 0; i < n; i++) ev.push({ t0: ctx.L * (i + 0.15 + R() * 0.7) / n, x: xa + R() * (xb - xa), y: ya + R() * (yb - ya), a: (p.angle ?? 2.75) + (R() - 0.5) * (p.spreadA ?? 0.25), len: (p.len ?? 9) * (0.7 + R() * 0.6), d: (p.dur ?? 0.7) * (0.8 + R() * 0.4), sp: p.speed ?? 70 });
  return { depth: 0, draw(fb, t, off, sc) {
    const tt = mod(t, ctx.L);
    for (const e of ev) { const u = (tt - e.t0) / e.d; if (u < 0 || u > 1) continue;
      const dx = Math.cos(e.a), dy = Math.sin(e.a); const hx = e.x + dx * e.sp * e.d * u, hy = e.y + dy * e.sp * e.d * u;
      const tail = e.len * Math.min(1, u * 4) * (1 - u * 0.6);
      for (let j = Math.ceil(tail); j >= 0; j--) { const x = Math.round(hx - dx * j), y = Math.round(hy - dy * j); const f = j / Math.max(1, tail);
        const sx = sxOf(ctx, x, off); if (ctx.inCalm(sx, y)) continue;
        if (f > 0.66 && !od(x, y, 1.2 - f)) continue; fset(fb, sc.W, sx, y, f < 0.15 ? cs[0] : f < 0.6 ? cs[1] : cs[2]); }
    }
  } };
});

// ------------------------------------------------------------------ particles: rain, snow, petals, leaves, fireflies, embers, lanterns, bubbles, sparkle, dust
function particles(kind, defaults) {
  layer(kind, (ctx, p0) => {
    const p = { ...defaults, ...p0 }; const cs = p.c.map(c => ctx.c(c)); const R = ctx.rand(strSeed((p.id || '') + kind));
    const [y0, y1] = p.y || [0, H]; const m = 8; const Dx = ctx.W + m * 2, Dy = (y1 - y0) + m * 2;
    const [xa, xb] = p.x ? [sxOf(ctx, p.x[0], 0), sxOf(ctx, p.x[1], 0)] : [-m, ctx.W + m];
    const n = Math.round(p.n ?? (p.density ?? 1) * (xb - xa) * (y1 - y0) / 1000);
    const [vx0, vy0] = p.speed || [0, 0];
    const parts = [];
    for (let i = 0; i < n; i++) {
      const tier = R() < (p.near ?? 0.25) ? 1 : 0; const k = tier ? 1.6 : 1;
      const cyx = vx0 ? Math.max(1, Math.round(Math.abs(vx0 * k) * ctx.L / Dx)) * Math.sign(vx0) : 0;
      const cyy = vy0 ? Math.max(1, Math.round(Math.abs(vy0 * k) * ctx.L / Dy)) * Math.sign(vy0) : 0;
      parts.push({ u: xa + R() * (xb - xa), v: R() * Dy, cyx, cyy, tier, ph: R(), ph2: R(), cy: ctx.cyc([2, 3, 4, 6][Math.floor(R() * 4)]), col: Math.floor(R() * cs.length), sw: ctx.cyc(p.swayPeriod ?? 4) });
    }
    const box = p.x ? [xa, xb] : null;
    return { depth: p.depth ?? 0.5, draw(fb, t, off, sc) {
      const W = sc.W, f = t / ctx.L;
      for (const q of parts) {
        let x, y;
        if (p.fixed) { x = q.u + off; y = y0 + (q.v % (y1 - y0)); }
        else {
          x = q.cyx ? mod(q.u + q.cyx * f * Dx - (box ? box[0] : -m), box ? box[1] - box[0] : Dx) + (box ? box[0] : -m) : q.u;
          y = q.cyy ? y0 - m + mod(q.v + q.cyy * f * Dy, Dy) : y0 + q.v % (y1 - y0);
          x += off * (q.tier ? 1.5 : 1);
        }
        if (p.sway) x += Math.sin(TAU * (f * q.sw + q.ph)) * p.sway * (q.tier ? 1.4 : 1);
        if (p.wander) { x += Math.sin(TAU * (f * ctx.cyc(p.wanderPeriod ?? 12) + q.ph)) * p.wander; y += Math.sin(TAU * (f * ctx.cyc((p.wanderPeriod ?? 12) * 0.75) + q.ph2)) * p.wander * 0.45; }
        x = Math.round(x); y = Math.round(y);
        if (p.attention && ctx.inCalm(x, y)) continue;
        draw1(kind, fb, W, x, y, q, cs, f, p, ctx);
      }
    } };
  });
}
function draw1(kind, fb, W, x, y, q, cs, f, p, ctx) {
  const on = (cy, ph, th) => Math.sin(TAU * (f * cy + ph)) > th;
  switch (kind) {
    case 'rain': { const len = q.tier ? (p.len ?? 3) + 1 : (p.len ?? 3); const sl = p.slant ?? 0.35;
      for (let j = 0; j < len; j++) fset(fb, W, Math.round(x - j * sl), y - j, j === 0 && q.tier ? cs[0] : cs[Math.min(cs.length - 1, 1)]); break; }
    case 'snow': fset(fb, W, x, y, q.tier ? cs[0] : cs[Math.min(1, cs.length - 1)]); if (q.tier && p.big && on(q.cy, q.ph, 0.2)) fset(fb, W, x + 1, y, cs[Math.min(1, cs.length - 1)]); break;
    case 'petals': case 'leaves': { const fr = Math.floor((f * q.cy * 6 + q.ph * 3)) % 3; const c = kind === 'leaves' ? cs[q.col] : cs[q.tier ? 0 : Math.min(1, cs.length - 1)];
      fset(fb, W, x, y, c); if (fr === 0) fset(fb, W, x + 1, y, c); else if (fr === 1) fset(fb, W, x + 1, y + 1, c); else if (q.tier) fset(fb, W, x, y + 1, c); break; }
    case 'fireflies': { const v = Math.sin(TAU * (f * q.cy + q.ph)); if (v < 0.1) break;
      if (v > 0.8) { const halo = cs[cs.length - 1]; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) fset(fb, W, x + dx, y + dy, halo); }
      fset(fb, W, x, y, v > 0.45 ? cs[0] : cs[Math.min(1, cs.length - 1)]); break; }
    case 'embers': { const u = 1 - (y - (p.y?.[0] ?? 0)) / Math.max(1, (p.y?.[1] ?? H) - (p.y?.[0] ?? 0)); if (!on(q.cy * 3, q.ph, -0.6)) break; fset(fb, W, x, y, cs[clamp(Math.floor(u * cs.length), 0, cs.length - 1)]); break; }
    case 'lanterns': { const c0 = cs[0], c1 = cs[Math.min(1, cs.length - 1)]; const fl = on(q.cy * 2, q.ph, -0.8);
      if (q.tier) { fset(fb, W, x, y, fl ? c0 : c1); fset(fb, W, x + 1, y, c0); fset(fb, W, x, y + 1, c1); fset(fb, W, x + 1, y + 1, c1); } else fset(fb, W, x, y, fl ? c0 : c1); break; }
    case 'bubbles': if (q.tier) { const c = cs[0]; fset(fb, W, x, y - 1, c); fset(fb, W, x - 1, y, c); fset(fb, W, x + 1, y, c); fset(fb, W, x, y + 1, cs[Math.min(1, cs.length - 1)]); } else fset(fb, W, x, y, cs[Math.min(1, cs.length - 1)]); break;
    case 'sparkle': { const v = Math.sin(TAU * (f * q.cy + q.ph)); if (v < 0.86) break; fset(fb, W, x, y, cs[0]);
      if (v > 0.95) { const a = cs[Math.min(1, cs.length - 1)]; fset(fb, W, x - 1, y, a); fset(fb, W, x + 1, y, a); fset(fb, W, x, y - 1, a); fset(fb, W, x, y + 1, a); } break; }
    case 'dust': if (on(q.cy, q.ph, -0.2)) fset(fb, W, x, y, cs[q.tier ? 0 : Math.min(1, cs.length - 1)]); break;
  }
}
particles('rain', { speed: [-14, 70], density: 3, near: 0.3 });
particles('snow', { speed: [-2, 7], density: 2.5, sway: 1.5, near: 0.3 });
particles('petals', { speed: [-8, 6], density: 0.5, sway: 2.5, near: 0.3 });
particles('leaves', { speed: [-9, 7], density: 0.4, sway: 3, near: 0.3 });
particles('fireflies', { speed: [0, 0], density: 0.8, wander: 3, attention: true, depth: 0.6 });
particles('embers', { speed: [2, -9], density: 0.8, sway: 1, attention: true });
particles('lanterns', { speed: [1, -3], density: 0.3, sway: 1, attention: true, near: 0.35 });
particles('bubbles', { speed: [0, -6], density: 0.5, sway: 1.2, near: 0.2 });
particles('sparkle', { speed: [0, 0], density: 0.6, attention: true, fixed: true, depth: 0 });
particles('dust', { speed: [0, 0], density: 0.6, wander: 4, wanderPeriod: 16 });

// ------------------------------------------------------------------ aurora: curtains that ripple
// {y:[top, edge], c:[dim, mid, bright], amp, x:[a,b] (design range, soft ends), speed (cycles/loop)}
layer('aurora', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const [top, edge] = p.y; const A = p.amp ?? 4; const k = p.speed ?? 1; const s = ctx.seed + 31;
  const [xa, xb] = p.x || [-1e9, 1e9]; const only = p.only ? new Set(p.only.map(c => ctx.c(c))) : null;
  const drawA = (buf, Wout, t, x2wx) => {
    const f = t / ctx.L; const sway = Math.sin(TAU * f * k), sway2 = Math.cos(TAU * f * k);
    for (let x = 0; x < Wout; x++) {
      const wx = x2wx(x); const endFade = Math.min(1, (wx - xa) / 50, (xb - wx) / 50); if (endFade <= 0) continue;
      const e = edge + A * Math.sin(wx * 0.017 + TAU * f * k + 1.3) + A * 0.45 * Math.sin(wx * 0.043 - TAU * f * k * 2) + A * 0.3 * Math.sin(wx * 0.09 + sway2 * 1.5);
      const ray = noise1(wx * 0.32 + sway * 2.2, s) * 0.7 + noise1(wx * 0.11 - sway2 * 1.4, s + 5) * 0.3;
      const env = endFade * (0.55 + 0.45 * noise1(wx * 0.012 + sway * 0.4, s + 9));
      const I = env * (0.25 + 0.75 * ray * ray);
      const len = (e - top) * (0.35 + 0.65 * ray);
      for (let y = Math.max(0, Math.floor(e - len)); y <= Math.min(H - 1, Math.round(e)); y++) {
        const v = I * ((y - (e - len)) / len) + (y === Math.round(e) ? 0.15 * env : 0); const i = y * Wout + x; if (only && !only.has(buf[i])) continue;
        if (v > 0.6 && od(wx, y, (v - 0.6) * 5)) buf[i] = cs[2]; else if (v > 0.3 && od(wx, y, (v - 0.3) * 4)) buf[i] = cs[1]; else if (v > 0.08 && od(wx, y, (v - 0.08) * 3.5)) buf[i] = cs[0];
      }
    }
  };
  return { depth: p.depth ?? 0.02, bake(acc) { drawA(acc.d, ctx.Wb, 0, x => ctx.wx(x)); }, draw(fb, t, off, sc) { drawA(fb, sc.W, t, x => ctx.wx(x + PAD - off)); } };
});

// ------------------------------------------------------------------ light remaps that move: rays, gust, lightning, pulse, heat
// god rays / light shafts {x, angle, n, spacing, w, len, y0, to, amt, period, only}
layer('rays', (ctx, p) => {
  const lut = ctx.lut(p.to, p.amt ?? 0.3); const cyc = ctx.cyc(p.period ?? 12); const ang = p.angle ?? 0.35; const s = ctx.seed + 9;
  const only = p.only ? new Set(p.only.map(c => ctx.c(c))) : null;
  const y0 = p.y0 ?? 0, len = p.len ?? H, n = p.n ?? 4, sp = p.spacing ?? 22, tn = Math.tan(ang);
  // static part precomputed once: which pixels belong to which shaft, and how strongly (sparse list, bitmap space)
  const px = [], ray = [], dens = [];
  for (let y = y0; y < Math.min(H, y0 + len); y++) for (let bx = 0; bx < ctx.Wb; bx++) {
    const wx = ctx.wx(bx); const u = (wx - p.x) - (y - y0) * tn; const idx = Math.floor(u / sp); if (idx < 0 || idx >= n) continue;
    const w = (p.w ?? 6) * (0.6 + h1(idx, s) * 0.8); const d = Math.abs(mod(u, sp) - sp / 2) / (w / 2); if (d > 1) continue;
    px.push(y * ctx.Wb + bx); ray.push(idx); dens.push((1 - d) * (1 - (y - y0) / len) * (p.strength ?? 1));
  }
  const breathe = new Float32Array(n);
  const apply = (buf, Wout, t, off, bitmapSpace) => {
    const f = t / ctx.L; for (let i = 0; i < n; i++) breathe[i] = 0.65 + 0.35 * Math.sin(TAU * (f * cyc + h1(i, s + 1)));
    for (let k = 0; k < px.length; k++) {
      const y = (px[k] / ctx.Wb) | 0, bx = px[k] - y * ctx.Wb; const x = bitmapSpace ? bx : bx - PAD + off; if (x < 0 || x >= Wout) continue;
      const i = y * Wout + x; if (only && !only.has(buf[i])) continue;
      if (od(bx + ctx.x0, y, dens[k] * breathe[ray[k]])) buf[i] = lut[buf[i]];
    }
  };
  return { depth: p.depth ?? 0, bake(acc) { apply(acc.d, ctx.Wb, ctx.recipe.still ?? 0, 0, true); }, draw(fb, t, off, sc) { apply(fb, sc.W, t, off, false); } };
});
// wind over a field: a soft lighter band travelling across {y:[a,b], only:[colours], to, amt, w, period}
layer('gust', (ctx, p) => {
  const lut = ctx.lut(p.to, p.amt ?? 0.3, p.allow); const only = new Set(p.only.map(c => ctx.c(c))); const [y0, y1] = p.y; const cyc = ctx.cyc(p.period ?? 8);
  return { depth: p.depth ?? 0.5, draw(fb, t, off, sc) {
    const D = sc.W + 160; const cx = mod((t / ctx.L) * cyc * D, D) - 80; const w = p.w ?? 40;
    for (let y = y0; y < y1; y++) { const sk = (y - y0) * (p.skew ?? 1.5); for (let x = Math.max(0, Math.floor(cx - w + sk)); x < Math.min(sc.W, cx + w + sk); x++) {
      const d = Math.abs(x - cx - sk) / w; const i = y * sc.W + x; if (!only.has(fb[i])) continue;
      if (od(x + ctx.x0, y, (1 - d) * (1 - d) * (p.strength ?? 0.8))) fb[i] = lut[fb[i]]; } }
  } };
});
// lightning: one distant strike per loop {x, y:[top, bottom], c, flash:{to, amt, only:[…]}, at: fraction of loop}
layer('lightning', (ctx, p) => {
  const c = ctx.c(p.c); const R = ctx.rand(strSeed(p.id || 'bolt')); const pts = []; let x = p.x, y = p.y[0];
  while (y < p.y[1]) { pts.push([x, y]); y += 1 + Math.floor(R() * 3); x += Math.round((R() - 0.5) * 4); }
  const fork = pts.slice(Math.floor(pts.length * 0.4)).map(([fx, fy], i) => [fx + Math.round(i * 0.9), fy + Math.round(i * 0.4)]).slice(0, 6);
  const lut = p.flash && ctx.lut(p.flash.to, p.flash.amt ?? 0.3); const only = p.flash?.only ? new Set(p.flash.only.map(q => ctx.c(q))) : null;
  const at = (p.at ?? 0.6) * ctx.L;
  return { depth: p.depth ?? 0.05, draw(fb, t, off, sc) {
    const dt = mod(t, ctx.L) - at; if (dt < 0 || dt > 0.42) return; const phase = dt < 0.09 ? 2 : dt < 0.2 ? 0 : dt < 0.3 ? 1 : 0; if (!phase) return;
    if (lut && phase === 2) for (let i = 0; i < fb.length; i++) if (!only || only.has(fb[i])) fb[i] = lut[fb[i]];
    const draw = list => { for (let i = 0; i + 1 < list.length; i++) { const [ax, ay] = list[i], [bx, by] = list[i + 1]; const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay)); for (let k = 0; k <= steps; k++) fset(fb, sc.W, sxOf(ctx, Math.round(ax + (bx - ax) * k / steps), off), Math.round(ay + (by - ay) * k / steps), c); } };
    draw(pts); if (phase === 2) draw(fork);
  } };
});
// breathing glow {x, y, r, to, amt, period, ry, only}
layer('pulse', (ctx, p) => {
  const lut = ctx.lut(p.to, p.amt ?? 0.35); const cyc = ctx.cyc(p.period ?? 6); const only = p.only ? new Set(p.only.map(c => ctx.c(c))) : null; const ry = p.ry ?? 1;
  const list = p.at || [[p.x, p.y, p.r]];
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) {
    list.forEach(([x0, y0, r0], n) => { const r = r0 * (0.8 + 0.2 * Math.sin(TAU * ((t / ctx.L) * cyc + n * 0.37))); const cx = sxOf(ctx, x0, off);
      for (let y = Math.max(0, Math.floor(y0 - r * ry)); y <= Math.min(H - 1, y0 + r * ry); y++) for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(sc.W - 1, cx + r); x++) {
        const d = Math.hypot(x - cx, (y - y0) / ry) / r; if (d >= 1) continue; const i = y * sc.W + x; if (only && !only.has(fb[i])) continue; if (od(x + ctx.x0, y, Math.pow(1 - d, 1.3))) fb[i] = lut[fb[i]]; } });
  } };
});
// heat shimmer: rows near the horizon slide by a pixel {y:[a,b], amp, period}
layer('heat', (ctx, p) => {
  const [y0, y1] = p.y; const cyc = ctx.cyc(p.period ?? 3); const row = new Uint8Array(4096);
  return { depth: 0, draw(fb, t, off, sc) { const W = sc.W; for (let y = y0; y < y1; y++) { const dx = Math.round((p.amp ?? 1) * Math.sin(y * 2.3 + TAU * (t / ctx.L) * cyc)); if (!dx) continue; row.set(fb.subarray(y * W, y * W + W)); for (let x = 0; x < W; x++) fb[y * W + x] = row[clamp(x - dx, 0, W - 1)]; } } };
});

// ------------------------------------------------------------------ lights: windows that go on and off, mast beacons
// place after the layers that registered lights. {rate: fraction of windows that change during a loop}
layer('windows', (ctx, p) => {
  const lights = ctx.lights.splice(0); const s = ctx.seed + 55; const rate = p.rate ?? 0.25; ctx.litList = (ctx.litList || []).concat(lights);
  lights.forEach((l, i) => { l.change = !l.mast && h1(i, s) < rate * (l.blink > 0 ? 1 : 0); l.t0 = h1(i, s + 1) * ctx.L; l.dur = ctx.L * (0.2 + h1(i, s + 2) * 0.5); l.cy = ctx.cyc(p.mastPeriod ?? 2); });
  return { depth: p.depth ?? 0, bake(acc) { for (const l of lights) if (l.mast) put(acc, l.bx, l.y, l.on); }, draw(fb, t, off, sc) {
    const tt = mod(t, ctx.L);
    for (const l of lights) {
      const sx = l.bx - PAD + off;
      if (l.mast) { const on = mod((t / ctx.L) * l.cy + (l.ph || 0), 1) < 0.3; if (on) fset(fb, sc.W, sx, l.y, l.on); else if (l.off !== T) fset(fb, sc.W, sx, l.y, l.off); continue; }
      if (l.eye) { const sh = mod(t + l.ph * 7, 6); fset(fb, sc.W, sx, l.y, sh < 0.18 || (sh > 0.4 && sh < 0.55) ? l.off : l.on); continue; }
      if (!l.change) continue; const inWin = mod(tt - l.t0, ctx.L) < l.dur; fset(fb, sc.W, sx, l.y, inWin ? l.off : l.on);
    }
  } };
});

// ------------------------------------------------------------------ creatures and vehicles that pass once per loop
// birds {n, y, dir, c, at: fraction, dur, spread}
layer('birds', (ctx, p) => {
  const c = ctx.c(p.c); const R = ctx.rand(strSeed(p.id || 'birds')); const n = p.n ?? 4; const dir = p.dir ?? 1;
  const flock = []; for (let i = 0; i < n; i++) flock.push({ dx: -i * (5 + R() * 4) * dir, dy: (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (1.5 + R()), ph: R(), big: R() < 0.3 });
  const at = (p.at ?? 0.3) * ctx.L, dur = p.dur ?? 16;
  return { depth: p.depth ?? 0.3, draw(fb, t, off, sc) {
    const dt = mod(t - at, ctx.L); if (dt > dur) return; const u = dt / dur; const D = sc.W + 80;
    const hx = dir > 0 ? -40 + u * D : sc.W + 40 - u * D;
    for (const b of flock) { const x = Math.round(hx + b.dx), y = Math.round(p.y + b.dy + Math.sin(TAU * (u * 3 + b.ph)) * 0.8); if (ctx.inCalm(x, y)) continue;
      const up = Math.sin(TAU * (dt * 2.2 + b.ph)) > 0;
      fset(fb, sc.W, x, y, c);
      if (up) { fset(fb, sc.W, x - 1, y - 1, c); fset(fb, sc.W, x + 1, y - 1, c); if (b.big) { fset(fb, sc.W, x - 2, y - 1, c); fset(fb, sc.W, x + 2, y - 1, c); } }
      else { fset(fb, sc.W, x - 1, y, c); fset(fb, sc.W, x + 1, y, c); if (b.big) { fset(fb, sc.W, x - 2, y + 1, c); fset(fb, sc.W, x + 2, y + 1, c); } }
    }
  } };
});
// satellite: one steady pixel crossing slowly {y:[from,to], c, at, dur}
layer('satellite', (ctx, p) => {
  const c = ctx.c(p.c); const at = (p.at ?? 0.1) * ctx.L, dur = p.dur ?? ctx.L * 0.6;
  return { depth: 0, draw(fb, t, off, sc) { const dt = mod(t - at, ctx.L); if (dt > dur) return; const u = dt / dur; const x = Math.round(sc.W * (0.15 + u * 0.85)), y = Math.round(p.y[0] + (p.y[1] - p.y[0]) * u); if (fgetc(fb, sc.W, x, y) === ctx.c(p.sky ?? p.c) || !p.sky) fset(fb, sc.W, x, y, c); } };
});
// train: lit carriages along a track {y (roof row), c, win, cars, dir, at, dur}
layer('train', (ctx, p) => {
  const c = ctx.c(p.c), w = ctx.c(p.win); const cars = p.cars ?? 5; const at = (p.at ?? 0.2) * ctx.L, dur = p.dur ?? 9; const dir = p.dir ?? 1; const len = cars * 15;
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) {
    const dt = mod(t - at, ctx.L); if (dt > dur) return; const u = dt / dur; const D = sc.W + len + 20;
    const x0 = Math.round(dir > 0 ? -len - 10 + u * D : sc.W + 10 - u * D) + off;
    for (let k = 0; k < cars; k++) { const cx = x0 + k * 15; for (let i = 0; i < 14; i++) for (let j = 0; j < 4; j++) { let col = c; if (j === 1 && i % 3 === 1 && i > 0 && i < 13) col = w; if (k === (dir > 0 ? cars - 1 : 0) && i > 10 && j < 1) continue; fset(fb, sc.W, cx + i, p.y + j, col); } }
  } };
});
// whale: a tail lifts out of the water once per loop {x, y (waterline), c, foam, at}
layer('whale', (ctx, p) => {
  const c = ctx.c(p.c), fo = ctx.c(p.foam); const at = (p.at ?? 0.5) * ctx.L; const dur = p.dur ?? 5;
  const TAIL = [['aa...........aa', 'aaa.........aaa', '.aaaa.....aaaa.', '..aaaaa.aaaaa..', '....aaaaaaa....', '......aaa......', '......aaa......', '......aaa......', '.......a.......'], ['aaa.........aaa', '.aaaaa...aaaaa.', '...aaaaaaaaa...', '.....aaaaa.....', '......aaa......'], ['.aa.......aa.', '..aaaaaaaaa..', '.....aaa.....']];
  return { depth: p.depth ?? 0.3, draw(fb, t, off, sc) {
    const dt = mod(t - at, ctx.L); if (dt > dur) return; const u = dt / dur; const rise = Math.sin(u * Math.PI); const fr = rise > 0.75 ? 0 : rise > 0.4 ? 1 : 2;
    const art = TAIL[fr]; const h = art.length; const sx = sxOf(ctx, p.x, off) - (art[0].length >> 1); const top = p.y - Math.round(rise * 8) - h + 3 + (fr ? 3 : 0);
    art.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === 'a' && top + j < p.y) fset(fb, sc.W, sx + i, top + j, c); });
    const spl = u > 0.55 ? (u - 0.55) / 0.45 : 0; if (spl > 0) for (let i = -6; i <= 14; i++) if (h1(i, Math.floor(dt * 6)) < 0.5 * (1 - spl)) fset(fb, sc.W, sx + i, p.y - (h1(i, 3) < 0.3 ? 1 : 0), fo);
    for (let i = -2; i <= 10; i++) if (h1(i, Math.floor(dt * 4) + 9) < 0.6 * rise) fset(fb, sc.W, sx + i, p.y, fo);
  } };
});
// fish school / jellyfish {n, y, c, dir, at, dur}
layer('fish', (ctx, p) => {
  const c = ctx.c(p.c); const R = ctx.rand(strSeed(p.id || 'fish')); const n = p.n ?? 7; const dir = p.dir ?? 1; const at = (p.at ?? 0.1) * ctx.L, dur = p.dur ?? 14;
  const sch = []; for (let i = 0; i < n; i++) sch.push({ dx: (R() - 0.5) * 22, dy: (R() - 0.5) * 7, ph: R() });
  return { depth: p.depth ?? 0.3, draw(fb, t, off, sc) { const dt = mod(t - at, ctx.L); if (dt > dur) return; const u = dt / dur; const D = sc.W + 60; const hx = dir > 0 ? -30 + u * D : sc.W + 30 - u * D;
    for (const f of sch) { const x = Math.round(hx + f.dx), y = Math.round(p.y + f.dy + Math.sin(TAU * (u * 4 + f.ph)) * 0.7); fset(fb, sc.W, x, y, c); fset(fb, sc.W, x - dir, y, c); if (Math.sin(TAU * (dt * 3 + f.ph)) > 0) fset(fb, sc.W, x - 2 * dir, y - 1, c); else fset(fb, sc.W, x - 2 * dir, y + 1, c); } } };
});
layer('jelly', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const list = p.at; const cyc = ctx.cyc(p.period ?? 6);
  return { depth: p.depth ?? 0.4, draw(fb, t, off, sc) {
    list.forEach(([x0, y0, r = 2], n) => { const ph = (t / ctx.L) * cyc + n * 0.29; const bob = Math.round(Math.sin(TAU * ph) * 2 - (mod(ph, 1) < 0.5 ? 0 : 0)); const wide = Math.sin(TAU * ph * 2) > 0; const x = sxOf(ctx, x0, off), y = y0 + bob;
      for (let i = -r - (wide ? 1 : 0); i <= r + (wide ? 1 : 0); i++) fset(fb, sc.W, x + i, y, cs[0]); for (let i = -r + 1; i <= r - 1; i++) fset(fb, sc.W, x + i, y - 1, cs[0]); fset(fb, sc.W, x, y - 1, cs[1]);
      for (let k = -r; k <= r; k += 2) for (let j = 1; j <= 3 + (k === 0 ? 1 : 0); j++) if ((j + (wide ? 1 : 0)) % 3 !== 0) fset(fb, sc.W, x + k + (j % 2 && wide ? 1 : 0), y + j, cs[Math.min(2, cs.length - 1)]); });
  } };
});

// ------------------------------------------------------------------ rotating things: windmill blades, turbines, ferris wheel
// {at:[[x, y, r, kind:'mill'|'turbine']], c, period}
layer('blades', (ctx, p) => {
  const c = ctx.c(p.c); const cyc = ctx.cyc(p.period ?? 12);
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) {
    p.at.forEach(([x0, y0, r, kind = 'mill', foot], n) => { const th = TAU * ((t / ctx.L) * cyc * (kind === 'turbine' ? 1 : 0.5) + n * 0.21); const cx = sxOf(ctx, x0, off); const k = kind === 'turbine' ? 3 : 4;
      if (foot) for (let y = y0 + 1; y <= foot; y++) fset(fb, sc.W, cx, y, c);
      for (let b = 0; b < k; b++) { const a = th + b * TAU / k; const ex = cx + Math.cos(a) * r, ey = y0 + Math.sin(a) * r;
        const steps = Math.ceil(r); for (let s = 0; s <= steps; s++) { const u = s / steps; const x = Math.round(cx + (ex - cx) * u), y = Math.round(y0 + (ey - y0) * u); fset(fb, sc.W, x, y, c);
          if (kind === 'mill' && u > 0.3) { const nx = Math.round(-Math.sin(a) * 1.4), ny = Math.round(Math.cos(a) * 1.4); if (s % 2 === 0) fset(fb, sc.W, x + nx, y + ny, c); } } }
      fset(fb, sc.W, cx, y0, c); });
  } };
});
// {x, y, r, c, light:[c1, c2], legs: c, period, spokes}
layer('ferris', (ctx, p) => {
  const c = ctx.c(p.c), l1 = ctx.c(p.light[0]), l2 = ctx.c(p.light[1] ?? p.light[0]); const n = p.spokes ?? 12; const cyc = ctx.cyc(p.period ?? 24);
  const bm = ctx.full(); const cx = ctx.bx(p.x);
  line(bm, cx, p.y, cx - p.r * 0.55, p.base, c); line(bm, cx, p.y, cx + p.r * 0.55, p.base, c); line(bm, cx - 1, p.y, cx - 1 - p.r * 0.55, p.base, c); line(bm, cx + 1, p.y, cx + 1 + p.r * 0.55, p.base, c);
  for (let a = 0; a < 360; a += 1) { put(bm, Math.round(cx + Math.cos(a / 57.3) * p.r), Math.round(p.y + Math.sin(a / 57.3) * p.r), c); }
  return [{ bm, depth: p.depth }, { depth: p.depth, draw(fb, t, off, sc) {
    const th = TAU * (t / ctx.L) * cyc / (p.slow ?? 1); const x0 = cx - PAD + off;
    for (let i = 0; i < n; i++) { const a = th + i * TAU / n; const ex = x0 + Math.cos(a) * p.r, ey = p.y + Math.sin(a) * p.r;
      for (let s = 2; s < p.r; s += 2) fset(fb, sc.W, Math.round(x0 + Math.cos(a) * s), Math.round(p.y + Math.sin(a) * s), c);
      const gx = Math.round(ex), gy = Math.round(ey) + 1; const col = (i % 3 === 0) ? l2 : l1; fset(fb, sc.W, gx, gy, col); fset(fb, sc.W, gx + 1, gy, col); fset(fb, sc.W, gx, gy + 1, c); fset(fb, sc.W, gx + 1, gy + 1, c); }
  } }];
});

// ------------------------------------------------------------------ water edges: shore foam, rain ripples
// {y, amp, c:[foam, foam2], period, x:[a,b]}
layer('waves', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const cyc = ctx.cyc(p.period ?? 6); const s = ctx.seed + 3; const [xa, xb] = p.x || [-1e9, 1e9];
  const surf = p.on ? ctx.surf[p.on] : null;
  return { depth: p.depth ?? 0.6, draw(fb, t, off, sc) { const f = t / ctx.L;
    for (let x = 0; x < sc.W; x++) { const wx = ctx.wx(x + PAD - off); if (wx < xa || wx > xb) continue; const base = surf ? surf(wx) : p.y;
      const reach = (0.5 + 0.5 * Math.sin(TAU * f * cyc + wx * (p.k ?? 0.035))); const y = Math.round(base - reach * (p.amp ?? 2));
      if (h2(wx, Math.floor(f * cyc * 4), s) < (p.density ?? 0.75) * (0.5 + noise1(wx * 0.05 - f * cyc * 2, s))) fset(fb, sc.W, x, y, cs[0]);
      if (cs[1] != null && h2(wx, Math.floor(f * cyc * 4) + 7, s) < 0.35) fset(fb, sc.W, x, y + 1 + (p.amp ? 1 : 0), cs[1]); }
  } };
});
// {y:[a,b], n per loop, c:[ring, faint], dur}
layer('ripples', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const R = ctx.rand(strSeed(p.id || 'rip')); const n = p.n ?? 40; const dur = p.dur ?? 1.2;
  const ev = []; for (let i = 0; i < n; i++) ev.push({ t0: R() * ctx.L, x: R(), y: p.y[0] + Math.floor(Math.pow(R(), 0.8) * (p.y[1] - p.y[0])) });
  return { depth: p.depth ?? 0.4, draw(fb, t, off, sc) { const tt = mod(t, ctx.L);
    for (const e of ev) { const a = mod(tt - e.t0, ctx.L) / dur; if (a > 1) continue; const x = Math.round(e.x * sc.W); if (ctx.inCalm(x, e.y)) continue;
      const near = (e.y - p.y[0]) / Math.max(1, p.y[1] - p.y[0]); const rx = Math.round(a * (2 + near * 4)); const c = a < 0.5 ? cs[0] : cs[1];
      if (rx === 0) { fset(fb, sc.W, x, e.y, c); continue; }
      fset(fb, sc.W, x - rx, e.y, c); fset(fb, sc.W, x + rx, e.y, c); if (rx > 1) { fset(fb, sc.W, x - rx + 1, e.y - 1, c); fset(fb, sc.W, x + rx - 1, e.y - 1, c); for (let i = -rx + 2; i <= rx - 2; i++) if (near > 0.5 || i % 2) fset(fb, sc.W, x + i, e.y - 1 - (rx > 3 ? 0 : 0), c); }
    }
  } };
});

// ------------------------------------------------------------------ fire, steam, lava
// steam/smoke puffs {at:[[x, y]], c:[young, mid, old], h, period, puffs, drift}
layer('steam', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const k = p.puffs ?? 4; const cyc = ctx.cyc(p.period ?? 5);
  return { depth: p.depth ?? 0.3, draw(fb, t, off, sc) {
    p.at.forEach(([x0, y0], n) => { const cx = sxOf(ctx, x0, off);
      for (let i = 0; i < k; i++) { const a = mod((t / ctx.L) * cyc + i / k + n * 0.13, 1); const y = y0 - a * (p.h ?? 16); const x = cx + Math.sin(a * 4 + n + i) * 1.5 + a * (p.drift ?? 3); const r = 0.6 + a * (p.grow ?? 3);
        const c = cs[Math.min(cs.length - 1, Math.floor(a * cs.length))];
        for (let yy = Math.floor(y - r); yy <= y + r; yy++) for (let xx = Math.floor(x - r); xx <= x + r; xx++) { const d = Math.hypot(xx - x, yy - y) / r; if (d <= 1 && od(xx + ctx.x0, yy, (1 - a) * (1.15 - d * 0.6))) fset(fb, sc.W, xx, yy, c); } }
    });
  } };
});
// campfire {x, y, c:[core, mid, outer]}
layer('fire', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c));
  return { depth: p.depth ?? 0.5, draw(fb, t, off, sc) { const fr = Math.floor(t * 8); const cx = sxOf(ctx, p.x, off), y = p.y; const sz = p.size ?? 1;
    for (let i = -2 * sz; i <= 2 * sz; i++) { const hgt = Math.max(0, Math.round((3 * sz - Math.abs(i)) * (0.6 + h1(i + 9, fr) * 0.7))); for (let j = 0; j < hgt; j++) { const u = j / Math.max(1, hgt); fset(fb, sc.W, cx + i, y - j, u < 0.35 && Math.abs(i) < sz + 1 ? cs[0] : u < 0.7 ? cs[1] : cs[2]); } }
    if (h1(fr, 5) < 0.5) fset(fb, sc.W, cx + Math.round((h1(fr, 6) - 0.5) * 4), y - 4 * sz - 1, cs[2]);
  } };
});
// lava: channels whose colours cycle downhill {flows:[[x, y, len]], c:[hot, warm, dark…], period}
layer('lava', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const R = ctx.rand(strSeed(p.id || 'lava')); const cells = []; const cyc = ctx.cyc(p.period ?? 3);
  for (const [x0, y0, len, w = 1] of p.flows) { let x = x0; for (let y = y0; y < Math.min(H, y0 + len); y++) { for (let k = 0; k < w + (R() < 0.3 ? 1 : 0); k++) cells.push([x + k, y, y - y0]); if (R() < 0.45) x += R() < 0.5 ? -1 : 1; } }
  return { depth: p.depth ?? 0, draw(fb, t, off, sc) { const f = (t / ctx.L) * cyc; for (const [x, y, d] of cells) { const i = Math.floor(mod(d * 0.34 - f * 2 + h2(x, y, 3) * 0.6, cs.length)); fset(fb, sc.W, sxOf(ctx, x, off), y, cs[i]); } } };
});

// ------------------------------------------------------------------ moving props: kelp, bamboo, boats, balloons
// kelp/seaweed/bamboo leaves {at|spacing, y, h, c:[c1, c2], amp, period, kind:'kelp'|'bamboo'}
layer('kelp', (ctx, p) => {
  const cs = p.c.map(c => ctx.c(c)); const cyc = ctx.cyc(p.period ?? 6); const R = ctx.rand(strSeed(p.id || 'kelp'));
  const list = (p.at || []).map(([x, h]) => ({ x, h, ph: R() }));
  return { depth: p.depth ?? 0.5, draw(fb, t, off, sc) { const f = t / ctx.L;
    for (const k of list) { const bx = sxOf(ctx, k.x, off); let px = bx;
      for (let j = 0; j < k.h; j++) { const u = j / k.h; const x = Math.round(bx + (p.amp ?? 2) * Math.pow(u, 1.5) * Math.sin(TAU * (f * cyc + k.ph) - u * 2)); const y = p.y - j;
        const wide = (p.w ?? (p.kind === 'bamboo' ? 2 : 1)); for (let i = 0; i < wide; i++) fset(fb, sc.W, x + i, y, cs[0]); if (Math.abs(x - px) > 1) fset(fb, sc.W, (x + px) >> 1, y, cs[0]); px = x;
        if (p.kind === 'bamboo') { if (j % 7 === 3) { fset(fb, sc.W, x - 1, y, cs[1]); fset(fb, sc.W, x + wide, y, cs[1]); } if (j % 9 === 5 && j > 6) { const d = (j >> 3) % 2 ? 1 : -1; for (let q = 1; q <= 4; q++) fset(fb, sc.W, x + (d > 0 ? wide - 1 + q : -q), y - (q >> 1), cs[1]); } }
        else if (j % 3 === 1 && j > 1) { const d = (j / 3 | 0) % 2 ? 1 : -1; const bl = 2 + ((j * 7 + k.x) % 2); for (let q = 1; q <= bl; q++) fset(fb, sc.W, x + (d > 0 ? wide - 1 + q : -q), y + (q > 1 ? 1 : 0), cs[1] ?? cs[0]); } }
    }
  } };
});
// sprites that bob on water or float in the air {list:[{art, x, y, map, flip}], amp, period, sway}
layer('bob', (ctx, p) => {
  const cyc = ctx.cyc(p.period ?? 4);
  const list = p.list.map((s, n) => { const art = SPRITES[s.art] || s.art; const rows = Array.isArray(art) ? art : art.split('\n'); const w = Math.max(...rows.map(r => r.length)), h = rows.length; const bm = bitmap(w, h, T);
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const ch = row[s.flip ? row.length - 1 - i : i]; if (s.map[ch] != null) bm.d[j * w + i] = ctx.c(s.map[ch]); } }); return { ...s, bm, n }; });
  const at = (s, t) => { const ph = TAU * ((t / ctx.L) * cyc + s.n * 0.37); return [Math.round(Math.sin(ph * 0.5) * (p.sway ?? 0)), Math.round(Math.sin(ph) * (p.amp ?? 0.6))]; };
  return { depth: p.depth ?? 0.3,
    bake(acc) { for (const s of list) blit(acc, s.bm, ctx.bx(s.x) - (s.bm.w >> 1), s.y - s.bm.h + 1); },
    draw(fb, t, off, sc) { for (const s of list) { const [dx, dy] = at(s, t); const x0 = sxOf(ctx, s.x, off) - (s.bm.w >> 1) + dx, y0 = s.y - s.bm.h + 1 + dy; for (let j = 0; j < s.bm.h; j++) for (let i = 0; i < s.bm.w; i++) { const v = s.bm.d[j * s.bm.w + i]; if (v !== T && (s.clip == null || y0 + j <= s.clip)) fset(fb, sc.W, x0 + i, y0 + j, v); } } } };
});
// hot-air balloons {at:[[x, y, r]], c:[light, mid, dark], basket, period}
layer('balloons', (ctx, p) => {
  const [cl, cm, cd] = p.c.map(c => ctx.c(c)); const bk = ctx.c(p.basket); const cyc = ctx.cyc(p.period ?? 12);
  const list = p.at.map(([x, y, r, alt]) => { const w = r * 2 + 1, h = Math.round(r * 2.6) + 4; const bm = bitmap(w, h, T); const cols = alt ? [ctx.c(alt[0]), ctx.c(alt[1]), ctx.c(alt[2])] : [cl, cm, cd];
    for (let j = 0; j < h - 4; j++) for (let i = 0; i < w; i++) { const dx = (i - r) / r, dy = (j - r) / r; const inside = dy < 0 ? dx * dx + dy * dy <= 1.05 : Math.abs(dx) <= (1 - dy / 1.6) * 1.02 && dy < 1.6; if (!inside) continue; const stripe = Math.floor((dx + 1) * 2.5) % 2; let c = stripe ? cols[1] : cols[0]; if (dx > 0.45) c = cols[2]; else if (dx < -0.5 && stripe) c = cols[0]; bm.d[j * w + i] = c; }
    for (let i = r - 1; i <= r + 1; i++) { bm.d[(h - 2) * w + i] = bk; bm.d[(h - 1) * w + i] = bk; } bm.d[(h - 3) * w + r - 1] = bk; bm.d[(h - 3) * w + r + 1] = bk;
    return { x, y, bm, ph: h1(x, 3) }; });
  return { depth: p.depth ?? 0.15, bake(acc) { for (const b of list) blit(acc, b.bm, ctx.bx(b.x) - (b.bm.w >> 1), b.y); }, draw(fb, t, off, sc) {
    for (const b of list) { const ph = TAU * ((t / ctx.L) * cyc + b.ph); const dy = Math.round(Math.sin(ph) * 1.5), dx = Math.round(Math.sin(ph * 0.5) * 2); const x0 = sxOf(ctx, b.x, off) - (b.bm.w >> 1) + dx, y0 = b.y + dy;
      for (let j = 0; j < b.bm.h; j++) for (let i = 0; i < b.bm.w; i++) { const v = b.bm.d[j * b.bm.w + i]; if (v !== T) fset(fb, sc.W, x0 + i, y0 + j, v); } }
  } };
});

// intro only: the town switches its lights on, one window after another {from: 0..1, to: 0..1 of the intro}
layer('lightson', (ctx, p) => {
  const lights = (ctx.litList || []).filter(l => !l.mast); const s = ctx.seed + 71;
  return { depth: 0, draw(fb, t, off, sc) { const u = t / ctx.L; const a = p.from ?? 0.1, b = p.to ?? 0.85;
    lights.forEach((l, i) => { if (u < a + h1(i, s) * (b - a)) fset(fb, sc.W, l.bx - PAD + off, l.y, l.off); }); } };
});
// the free LCD grid (the app's own screen as a texture) {c:[bg, line, glow]}
layer('grid', (ctx, p) => {
  const bm = ctx.full(); const [bg, ln, gl] = p.c.map(c => ctx.c(c));
  for (let y = 0; y < H; y++) for (let bx = 0; bx < ctx.Wb; bx++) { const wx = ctx.wx(bx); let c = bg; if (((wx % 4) + 4) % 4 === 0 || y % 4 === 0) c = ln; else if (od(wx, y, (1 - y / H) * 0.4)) c = gl; bm.d[y * ctx.Wb + bx] = c; }
  return { bm, depth: 0 };
});
