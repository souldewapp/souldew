// "Your handheld" in plain numbers (no three.js, no DOM): the souldew handhelds' dimensions, where their buttons, screens,
// LED, speaker holes, slot and feet sit, and – for every face a wrap or a sticker can go on – how far it reaches over the
// edge and what it must leave bare. The 3D scene (scene.mjs) builds its meshes from the same numbers, the editor places
// stickers with them, and test/handheld.test.mjs checks the placement rules without a page.
//
// Coordinates are millimetres. Every device is built lying face up (+y); its top edge is towards −z. A face is
// UNFOLDED: a point on a moulded slab (rounded plan, soft bevelled edges) maps to where it would be if the vinyl lying on
// it were peeled off flat – the flat face maps to itself, over the bevel and down the side wall it moves outwards by
// the distance travelled along the surface. Stickers and wraps live in that flat space ("U", mm from the face's centre).
// Our own shapes only – soft pebbles, a barrel hinge, a round pad – no Nintendo shapes or marks.

export const PX = 0.6; // mm per art pixel (wraps and stickers)
export const GAP = 0.7; // mm a sticker keeps from every cut-out

export const DEVICES = {
  nds: { kind: 'fold', W: 134, D: 74, hb: 11.5, hl: 8.6, r: 11, top: [62, 46.5], bot: [62, 46.5], led: 0x63e39a, card: [35, 33, 3.8, 7] },
  '3ds': { kind: 'fold', W: 140, D: 78, hb: 12, hl: 8.8, r: 12, top: [72, 43.2], bot: [57.6, 43.2], led: 0x6ab2ff, card: [35, 33, 3.8, 7] },
  gba: { kind: 'slab', W: 146, D: 84, h: 22, r: 30, scr: [66, 44], scrZ: -7, led: 0x63e39a, cart: [60, 38, 7.4, 0.45], slotY: 6.4 },
  gb: { kind: 'slab', W: 90, D: 148, h: 25, r: 10, rBR: 30, scr: [48, 43.2], scrZ: -31, led: 0xff5a48, cart: [57, 64, 8, 0.44], slotY: 7.2 },
};
DEVICES.gbc = { ...DEVICES.gb, r: 9, rBR: 24 };

export const slabB = (h, bevel) => Math.max(0, Math.min(bevel, h / 2 - 0.3));

/**
 * Where the parts sit (the scene builds its meshes here, the faces cut round them). Fold devices: in the base's frame
 * (deck, pad, buttons, pills, LED, feet) and the lid's frame; slab devices: in the body's frame.
 */
export function partsOf(sys) {
  const dev = DEVICES[sys];
  if (!dev) return null;
  if (dev.kind === 'fold') {
    const { W, D, hb, r } = dev;
    const [bw] = dev.bot;
    const padR = 8.2;
    const bx = bw / 2 + (W / 2 - bw / 2) / 2 + 1;
    return {
      ax: { y: hb, z: -D / 2 - 2 }, off: 2.4, padR,
      pad: [-(bw / 2 + (W / 2 - bw / 2) / 2) - 1, -1],
      buttons: [[-4.2, 3.8], [4.2, -3.8]].map(([dx, dz]) => [bx + dx, -1 + dz]), btnR: 3.8,
      pills: [-5, 5].map((dx) => [bx + dx * 0.9, D / 2 - 11]),
      led: [-W / 2 + 13, D / 2 - 8.5],
      feet: [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => [sx * (W / 2 - 15), sz * (D / 2 - 13)]),
      deckInset: 7, deckR: r - 3, botZ: 1.5, topZ: 2,
    };
  }
  const { W, D, h } = dev;
  const [sw, sh] = dev.scr;
  const portrait = D > W;
  const spk = portrait ? [W / 2 - 17, D / 2 - 15] : [W / 2 - 24, D / 2 - 14];
  const holes = portrait
    ? [0, 1, 2, 3, 4, 5].map((k) => [spk[0] - 7.5 + k * 3, spk[1] + 4 - k * 1.3])
    : [[0, 0], ...[0, 1, 2, 3, 4, 5].map((k) => [Math.cos((k * Math.PI) / 3) * 3.2, Math.sin((k * Math.PI) / 3) * 3.2])].map(([x, z]) => [spk[0] + x, spk[1] + z]);
  const bp = portrait ? [W / 2 - 22, D / 2 - 47] : [W / 2 - 21, 2];
  return {
    portrait,
    pad: portrait ? [-W / 2 + 22, D / 2 - 44] : [-W / 2 + 21, 4],
    buttons: [[-5, 4], [5, -4]].map(([dx, dz]) => [bp[0] + dx, bp[1] + dz]),
    pills: [-7, 7].map((dx) => [dx, portrait ? D / 2 - 22 : D / 2 - 12]),
    led: portrait ? [-sw / 2 - 4.5, dev.scrZ - 6] : [-sw / 2 - 5, dev.scrZ - sh / 2 + 3],
    holes,
    cover: { w: portrait ? 58 : 70, d: portrait ? 52 : 30, z: portrait ? 34 : 22 },
    seamY: h * 0.45,
  };
}

// ---- the unfold ----------------------------------------------------------------------------------------------------

function sdRB(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r, qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const radAt = (slab, x, z) => (x > 0 && z > 0 ? slab.rBR ?? slab.r : slab.r);
export function planSd(slab, x, z) { return sdRB(x, z, slab.w / 2 - slab.b, slab.d / 2 - slab.b, Math.max(1, radAt(slab, x, z) - slab.b)); }
function planGrad(slab, x, z) {
  const r = Math.max(1, radAt(slab, x, z) - slab.b);
  const qx = Math.abs(x) - (slab.w / 2 - slab.b) + r, qz = Math.abs(z) - (slab.d / 2 - slab.b) + r;
  let gx, gz;
  if (qx > 0 && qz > 0) { const l = Math.hypot(qx, qz); gx = qx / l; gz = qz / l; } else if (qx > qz) { gx = 1; gz = 0; } else { gx = 0; gz = 1; }
  return [gx * (x >= 0 ? 1 : -1), gz * (z >= 0 ? 1 : -1)];
}
/** a point on the slab's surface (its local mm) → { face: 'top' | 'bottom', U: [x, y], beyond } */
export function unfold(slab, [x, y, z]) {
  const { h, b } = slab;
  const top = y >= h / 2;
  const yy = top ? y : h - y;
  const s = planSd(slab, x, z), sp = Math.max(s, 0);
  const beyond = yy >= h - 0.02 ? s : yy >= h - b ? b * Math.atan2(sp, Math.max(yy - (h - b), 0)) : b * Math.PI / 2 + (h - b - yy);
  const [gx, gz] = planGrad(slab, x, z);
  const k = Math.max(beyond, 0) - sp;
  return { face: top ? 'top' : 'bottom', U: [x + gx * k, z + gz * k], beyond };
}
/** the unfolded position of a point on a side wall at height y (local), at plan position (x, z) on the outline */
export function unfoldWall(slab, x, y, z) {
  const { h, b } = slab;
  const yy = y >= h / 2 ? y : h - y;
  const [gx, gz] = planGrad(slab, x, z);
  const inset = yy >= h - b ? b - Math.sqrt(Math.max(0, b * b - (yy - (h - b)) ** 2)) : 0;
  return unfold(slab, [x - gx * inset, y, z - gz * inset]);
}
/** signed distance to a cut-out { c: [x, y], he: [hx, hy], r, a } (≤ 0 inside) */
export function cutSd(c, u, v) {
  const dx = u - c.c[0], dy = v - c.c[1];
  const ca = Math.cos(c.a || 0), sa = Math.sin(c.a || 0);
  return sdRB(ca * dx + sa * dy, -sa * dx + ca * dy, c.he[0], c.he[1], c.r || 0);
}

// ---- the faces ------------------------------------------------------------------------------------------------------

const box = (x, y, hx, hy, rr = 0, a = 0) => ({ c: [x, y], he: [hx, hy], r: rr, a });
const ring = (x, y, rr) => box(x, y, rr, rr, rr);

/**
 * Every wrappable surface of a device: { <part>: { slab, top?: region, bottom?: region, z?, of? } }.
 * slab = { w, d, h, b, r, rBR } of that part's mesh. region = { L (mm the wrap reaches past the flat face), Ls (stickers),
 * border (a printed keyline), view ([sx, sy]: how the face reads – a back face is seen mirrored), cxo (where in the
 * banner the panel sits), base ('edge' | 'face' | 'mid': where the banner's landscape lies), word (the printed
 * wordmark), cuts: [cut] (what it leaves bare, in the face's unfolded mm), of (another part's art: the battery cover
 * carries on the body's print) }.
 */
export function surfacesOf(sys) {
  const dev = DEVICES[sys];
  const P = partsOf(sys);
  if (!dev) return null;
  if (dev.kind === 'fold') {
    const { W, D, hb, hl, r } = dev;
    const [bw, bh] = dev.bot;
    const [cw, , ct] = dev.card;
    const lidS = { w: W, d: D, h: hl, b: slabB(hl, 2.4), r, rBR: r };
    const deckS = { w: W - 7, d: D - 7, h: 0.6, b: slabB(0.6, 0.25), r: r - 3, rBR: r - 3 };
    const baseS = { w: W, d: D, h: hb, b: slabB(hb, 2.6), r, rBR: r };
    const hinge = (S, g = 1.0) => box(0, -(S.d / 2 - S.b) - g - 60, S.w, 60);
    const slotTop = unfoldWall(lidS, 0, Math.min(hl - 0.01, hl / 2 + ct / 2 + 1.6 + 0.7), D / 2).U[1];
    const slotBot = unfoldWall(lidS, 0, Math.max(0.01, hl / 2 - (ct + 1.2) / 2 - 0.7), D / 2).U[1];
    return {
      lid: { slab: lidS,
        top: { L: lidS.b * Math.PI / 2 + 2.4, Ls: lidS.b * Math.PI / 2 + 1.4, border: 1, view: [1, 1], cxo: 0, base: 'edge', word: true,
          cuts: [hinge(lidS), box(0, slotTop + 40, (cw + 6) / 2 + 0.7, 40, 0.8)] },
        bottom: { L: lidS.b * Math.PI / 2 + 1.4, Ls: lidS.b * Math.PI / 2 + 0.6, border: 1, view: [1, -1], cxo: 34, base: 'edge',
          cuts: [box(0, 0, (W - 10) / 2 + 0.7, (D - 9) / 2 + 0.7, r - 4 + 0.7), hinge(lidS, 0.6), box(0, slotBot + 40, (cw + 2.4) / 2 + 0.9, 40, 0.8)] } },
      deck: { slab: deckS,
        top: { L: 0.35, Ls: 0, border: 0, view: [1, 1], cxo: -26, base: 'face',
          cuts: [box(0, P.botZ, (bw + 7) / 2 + 0.7, (bh + 7) / 2 + 0.7, 4.2), ring(P.pad[0], P.pad[1], P.padR + 0.4 + 0.8),
            ...P.buttons.map(([x, z]) => ring(x, z, P.btnR + 0.7)),
            ...P.pills.map(([x, z]) => box(x, z, 2.25 + 1.1 + 0.6, 1.1 + 0.6, 1.7)), ring(P.led[0], P.led[1], 1.15 + 0.9)] } },
      base: { slab: baseS,
        bottom: { L: baseS.b * Math.PI / 2 + 3.0, Ls: baseS.b * Math.PI / 2 + 1.8, border: 1, view: [1, -1], cxo: 70, base: 'edge',
          cuts: P.feet.map(([fx, fz]) => ring(fx, fz, 2.8 + 0.6)) } },
    };
  }
  const { W, D, h, r, rBR } = dev;
  const [sw, sh] = dev.scr;
  const S = { w: W, d: D, h, b: slabB(h, 4.2), r, rBR: rBR ?? r };
  const coverS = { w: P.cover.w, d: P.cover.d, h: 0.6, b: slabB(0.6, 0.25), r: 5, rBR: 5 };
  const frontReach = S.b * Math.PI / 2 + (h - S.b - (h * 0.45 + 2.2)); // down the side to 2 mm above the parting line
  const backReach = S.b * Math.PI / 2 + (h * 0.45 - 2.2 - S.b);
  const slotEdge = unfoldWall(S, 0, Math.max(0.01, dev.slotY - (dev.cart[2] + 1.4) / 2 - 0.7), -D / 2).U[1];
  const [cw2] = dev.cart;
  return {
    body: { slab: S,
      top: { L: frontReach, Ls: S.b * Math.PI / 2 + 3, border: 1, view: [1, 1], cxo: 0, base: P.portrait ? 'mid' : 'edge',
        cuts: [box(0, dev.scrZ, (sw + 14) / 2 + 0.7, (sh + 14) / 2 + 0.7, 5.7), ring(P.pad[0], P.pad[1], 10.4 + 0.8),
          ...P.buttons.map(([x, z]) => ring(x, z, 4.8 + 0.7)),
          ...P.pills.map(([x, z]) => box(x, z, 3 + 1.3 + 0.6, 1.3 + 0.6, 1.9, P.portrait ? 0.45 : 0)),
          ring(P.led[0], P.led[1], 1.3 + 0.9),
          ...P.holes.map(([x, z]) => (P.portrait ? box(x, z, 3.25 + 0.75 + 0.4, 0.75 + 0.4, 1.15, -1.12) : ring(x, z, 0.8 + 0.45)))] },
      bottom: { L: backReach, Ls: S.b * Math.PI / 2 + 1.5, border: 1, view: [-1, 1], cxo: 64, base: 'edge', word: true,
        cuts: [box(0, P.cover.z, coverS.w / 2 + 0.55, coverS.d / 2 + 0.55, 5.55), box(0, slotEdge - 40, (cw2 + 2.6) / 2 + 0.9, 40, 0.8)] } },
    cover: { slab: coverS, z: P.cover.z,
      bottom: { L: 0.3, Ls: 0, border: 0, view: [-1, 1], cxo: 64, base: 'edge', of: 'body', cuts: [] } },
  };
}

/** { 'lid:top': { slab, region }, … } – every face a sticker can go on */
export function regionsOf(sys) {
  const out = {};
  for (const [k, s] of Object.entries(surfacesOf(sys) || {})) for (const f of ['top', 'bottom']) if (s[f]) out[`${k}:${f}`] = { slab: s.slab, region: s[f] };
  return out;
}

// ---- placing a sticker ------------------------------------------------------------------------------------------------
// rect = the sticker's atlas rect (web/lib/handheld/atlas.mjs: die-cut outline `pts` + `mask`, art px); mmpp = mm per
// art pixel (PX × its size).

/**
 * Would a sticker fit here? It must stay on its face (past the edge only as far as `Ls`) and keep `gap` mm from every
 * cut-out; a cut-out it would swallow whole (a speaker hole under a big sticker) counts as covered.
 * Returns the smallest clearance (mm; ≥ gap = fits).
 */
export function stickerClearance(slab, region, rect, U, rot, mmpp, gap = GAP) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const [fx, fy] = region.view || [1, 1];
  let worst = Infinity;
  for (const ct of region.cuts) {
    const dx = (ct.c[0] - U[0]) * fx, dy = (ct.c[1] - U[1]) * fy;
    const lx = (c * dx + s * dy) / mmpp, ly = (-s * dx + c * dy) / mmpp;
    if (Math.abs(lx) < rect.w / 2 && Math.abs(ly) < rect.h / 2) {
      const i = Math.floor(lx + rect.w / 2), j = Math.floor(ly + rect.h / 2);
      if (rect.mask[j * rect.w + i]) return -5;
    }
  }
  for (const [px, py] of rect.pts) {
    const lx = px * mmpp, ly = py * mmpp;
    const u = U[0] + fx * (c * lx - s * ly), v = U[1] + fy * (s * lx + c * ly);
    worst = Math.min(worst, region.Ls - planSd(slab, u, v) + gap);
    for (const ct of region.cuts) worst = Math.min(worst, cutSd(ct, u, v));
    if (worst < -2) return worst;
  }
  return worst;
}
export const fits = (slab, region, rect, U, rot, mmpp, gap = GAP) => stickerClearance(slab, region, rect, U, rot, mmpp, gap) >= gap;

/** the nearest place (a spiral search, ≤ maxR mm) where the sticker fits; null when there is none – refused */
export function snapSticker(slab, region, rect, U, rot, mmpp, gap = GAP, maxR = 14) {
  if (fits(slab, region, rect, U, rot, mmpp, gap)) return U;
  const step = Math.max(0.6, Math.min(1.2, Math.sqrt(rect.area) * mmpp / 20)); // big stickers: a coarser search
  for (let r = step; r <= maxR; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    let best = null, bd = -Infinity;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const P = [U[0] + Math.cos(a) * r, U[1] + Math.sin(a) * r];
      const d = stickerClearance(slab, region, rect, P, rot, mmpp, gap);
      if (d >= gap && d > bd) { bd = d; best = P; }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Dragging: from a place that fits (`from`) towards the hand (`to`). Free → there. Blocked → as far as it goes, then the
 * rest of the move slides along the obstacle (its tangent), so the sticker glides round a button instead of jumping.
 * → { U, slid } (U = from when it can't move at all).
 */
export function slideSticker(slab, region, rect, from, to, rot, mmpp, gap = GAP) {
  const ok = (P) => fits(slab, region, rect, P, rot, mmpp, gap);
  if (ok(to)) return { U: to, slid: false };
  const along = (A, B) => {
    let lo = 0, hi = 1;
    for (let k = 0; k < 9; k++) { const m = (lo + hi) / 2; if (ok([A[0] + (B[0] - A[0]) * m, A[1] + (B[1] - A[1]) * m])) lo = m; else hi = m; }
    return [A[0] + (B[0] - A[0]) * lo, A[1] + (B[1] - A[1]) * lo];
  };
  const P = along(from, to);
  const rx = to[0] - P[0], ry = to[1] - P[1];
  const e = 0.25, f = (x, y) => stickerClearance(slab, region, rect, [x, y], rot, mmpp, gap);
  let nx = f(P[0] + e, P[1]) - f(P[0] - e, P[1]), ny = f(P[0], P[1] + e) - f(P[0], P[1] - e);
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-6) return { U: P, slid: true };
  nx /= nl; ny /= nl;
  const into = rx * nx + ry * ny;
  if (into >= 0) return { U: P, slid: true };
  const tx = rx - into * nx, ty = ry - into * ny; // what is left of the move, along the obstacle
  const P2 = ok([P[0] + nx * 0.05, P[1] + ny * 0.05]) ? [P[0] + nx * 0.05, P[1] + ny * 0.05] : P;
  return { U: along(P2, [P2[0] + tx, P2[1] + ty]), slid: true };
}

/** a turn that lands within ±3° of a quarter turn snaps to it – only there */
export function snapTurn(rot) {
  const q = Math.PI / 2;
  const n = Math.round(rot / q);
  return Math.abs(rot - n * q) <= (3 * Math.PI) / 180 ? n * q : rot;
}

/** the first free spot on a face, nearest its middle (Enter on the sheet, the keyboard path) */
export function firstFree(R, rect, rot, mmpp) {
  const hx = R.slab.w / 2, hz = R.slab.d / 2;
  const cand = [];
  for (let x = -hx; x <= hx; x += 3) for (let y = -hz; y <= hz; y += 3) cand.push([x, y]);
  cand.sort((a, b) => Math.hypot(a[0] * 0.8, a[1]) - Math.hypot(b[0] * 0.8, b[1]));
  for (const P of cand) if (fits(R.slab, R.region, rect, P, rot, mmpp)) return P;
  return null;
}

/**
 * A stored layout made valid for this device: every sticker snapped clear of its face's cut-outs (it moves to the
 * nearest free spot), dropped when there is no room or its art isn't here; at most `max`.
 */
export function placeLayout(list, regions, rects, max = 8) {
  const out = [];
  for (const st of list || []) {
    if (out.length >= max) break;
    const R = regions[st.region];
    const rect = rects[st.id];
    if (!R || !rect) continue;
    const U = snapSticker(R.slab, R.region, rect, st.U, st.rot || 0, PX * (st.scale || 1));
    if (U) out.push({ ...st, U });
  }
  return out;
}
