// The sticker atlas: every sticker's pixel art with its 1-px ink outline (RGBA, art pixels) and its die-cut border as a
// distance field (one byte per texel, SDF_S texels per art pixel), on one shelf-packed layout. Pure data, no DOM.
//
// It is built ONCE, offline, never at run time (≈ 100 ms and 2 MB that way): scripts/build-handheld-atlas.mjs writes the
// app's own (free + earned stickers) into web/assets/handheld/, scripts/plus-dev-pack.mjs the souldew+ one into the pack.
// The page (web/lib/handheld/stickers.mjs) decodes the two PNGs and stacks the atlases it has into one texture.
//
// A sticker design: { id, outline: '#rrggbb', art: { w, h, rows: ['..ab..', …], map: { a: '#rrggbb', … } } }.

export const BORDER = 1.7; // the white die-cut border, in art pixels (≈ 1 mm)
export const PAD = 4; // room round the art for the border (art px)
export const SDF_S = 4; // distance-field texels per art pixel (the design sketch used 8 – the same look at launch size)
export const SDF_RANGE = 4; // ± art px encoded in the 8-bit field
export const ATLAS_W = 192;

/** the art with its ink outline added (1 px, 8-neighbourhood) → { W, H, rgba } */
export function withOutline(s) {
  const { w, h, rows, map } = s.art;
  const W = w + 2, H = h + 2;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] && rows[y][x] !== '.' && map[rows[y][x]];
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const ol = hex(s.outline);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let c = null;
    if (on(x - 1, y - 1)) c = hex(map[rows[y - 1][x - 1]]);
    else {
      let n = false;
      for (let dy = -1; dy <= 1 && !n; dy++) for (let dx = -1; dx <= 1; dx++) if (on(x - 1 + dx, y - 1 + dy)) { n = true; break; }
      if (n) c = ol;
    }
    if (c) { rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255; }
  }
  return { W, H, rgba };
}

/** 1-D squared distance transform (Felzenszwalb) in place */
function edt1(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e20;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
/** distance (texels) from every texel to the nearest set texel */
function edt(mask, W, H) {
  const INF = 1e20, g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = mask[i] ? 0 : INF;
  const n = Math.max(W, H), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) f[y] = g[y * W + x]; edt1(f, H, d, v, z); for (let y = 0; y < H; y++) g[y * W + x] = d[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) f[x] = g[y * W + x]; edt1(f, W, d, v, z); for (let x = 0; x < W; x++) g[y * W + x] = Math.sqrt(d[x]); }
  return g;
}

/**
 * Builds the atlas for a list of designs → { w, h, rgba, sw, sh, sdf, range, rects }. rects[id] = { x, y, w, h (art px,
 * incl. padding), pts (the die-cut outline, art px from the sticker's centre), mask (w × h, 1 = inside the die-cut at
 * each art pixel's centre), area (art px²) } – what placement checks against buttons, screens and edges.
 */
export function buildAtlas(designs, { width = ATLAS_W } = {}) {
  const items = designs.map((s) => ({ s, ...withOutline(s) }));
  let x = 0, y = 0, row = 0;
  for (const it of [...items].sort((a, b) => b.H - a.H || a.s.id.localeCompare(b.s.id))) { // shelf packing, tallest first
    const w = it.W + PAD * 2, h = it.H + PAD * 2;
    if (w > width) throw new Error(`sticker ${it.s.id} is wider than the atlas`);
    if (x + w > width) { x = 0; y += row; row = 0; }
    it.rect = { x, y, w, h };
    x += w; row = Math.max(row, h);
  }
  const AW = width, AH = y + row;
  const rgba = new Uint8ClampedArray(AW * AH * 4);
  const SW = AW * SDF_S, SH = AH * SDF_S;
  const sdf = new Uint8ClampedArray(SW * SH).fill(255);
  const rects = {};
  for (const it of items) {
    const { x: rx, y: ry, w, h } = it.rect;
    for (let j = 0; j < it.H; j++) for (let i = 0; i < it.W; i++) {
      const s = (j * it.W + i) * 4, d = ((ry + PAD + j) * AW + rx + PAD + i) * 4;
      for (let k = 0; k < 4; k++) rgba[d + k] = it.rgba[s + k];
    }
    const mw = w * SDF_S, mh = h * SDF_S;
    const mask = new Uint8Array(mw * mh);
    for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
      const ax = Math.floor(i / SDF_S) - PAD, ay = Math.floor(j / SDF_S) - PAD;
      if (ax >= 0 && ay >= 0 && ax < it.W && ay < it.H && it.rgba[(ay * it.W + ax) * 4 + 3]) mask[j * mw + i] = 1;
    }
    const dist = edt(mask, mw, mh);
    const inside = new Uint8Array(w * h);
    for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
      const dd = dist[j * mw + i] / SDF_S - BORDER; // art px; ≤ 0 inside the die-cut
      sdf[(ry * SDF_S + j) * SW + rx * SDF_S + i] = Math.round(Math.max(0, Math.min(1, 0.5 + dd / (2 * SDF_RANGE))) * 255);
      if (dd <= 0 && i % SDF_S === SDF_S >> 1 && j % SDF_S === SDF_S >> 1) inside[Math.floor(j / SDF_S) * w + Math.floor(i / SDF_S)] = 1;
    }
    rects[it.s.id] = { ...it.rect, ...outlineOf(inside, w, h) };
  }
  return { w: AW, h: AH, rgba, sw: SW, sh: SH, sdf, range: SDF_RANGE, sdfS: SDF_S, rects };
}

/** the die-cut's outline points (art px from the centre) and area, from its inside mask */
function outlineOf(mask, w, h) {
  const pts = [];
  let area = 0;
  const at = (i, j) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!mask[j * w + i]) continue;
    area++;
    if (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1)) pts.push([i + 0.5 - w / 2, j + 0.5 - h / 2]);
  }
  return { mask, pts, area };
}

// ---- the layout file (stickers.json) ---------------------------------------------------------------------------------
// The masks go as base64 bit strings; the outline points are recomputed from them when the file is read (smaller file).

const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x4000) s += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function encodeLayout(atlas) {
  const rects = {};
  for (const [id, r] of Object.entries(atlas.rects)) {
    const bits = new Uint8Array(Math.ceil(r.w * r.h / 8));
    for (let i = 0; i < r.w * r.h; i++) if (r.mask[i]) bits[i >> 3] |= 1 << (i & 7);
    rects[id] = { x: r.x, y: r.y, w: r.w, h: r.h, mask: b64(bits) };
  }
  return { format: 1, w: atlas.w, h: atlas.h, sdfS: atlas.sdfS, range: atlas.range, rects };
}

/** stickers.json → { w, h, sdfS, range, rects } with masks, outlines and areas (no pixels) */
export function decodeLayout(json) {
  if (!json || json.format !== 1 || !json.rects) throw new Error('not a sticker layout');
  const rects = {};
  for (const [id, r] of Object.entries(json.rects)) {
    const bits = unb64(r.mask);
    const mask = new Uint8Array(r.w * r.h);
    for (let i = 0; i < r.w * r.h; i++) mask[i] = (bits[i >> 3] >> (i & 7)) & 1;
    rects[id] = { x: r.x, y: r.y, w: r.w, h: r.h, ...outlineOf(mask, r.w, r.h) };
  }
  return { w: json.w, h: json.h, sdfS: json.sdfS, range: json.range, rects };
}

/**
 * Stacks atlases (the app's and the pack's) into one: the same width, one below the other; rects move down with theirs.
 * parts: [{ w, h, rgba, sdf, rects, sdfS, range }]
 */
export function stackAtlases(parts) {
  const list = parts.filter(Boolean);
  if (!list.length) return null;
  const W = Math.max(...list.map((p) => p.w));
  const S = list[0].sdfS;
  if (list.some((p) => p.sdfS !== S || p.range !== list[0].range)) throw new Error('atlases of different kinds');
  const H = list.reduce((n, p) => n + p.h, 0);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const sdf = new Uint8ClampedArray(W * S * H * S).fill(255);
  const rects = {};
  let y0 = 0;
  for (const p of list) {
    for (let y = 0; y < p.h; y++) rgba.set(p.rgba.subarray(y * p.w * 4, (y + 1) * p.w * 4), ((y0 + y) * W) * 4);
    for (let y = 0; y < p.h * S; y++) sdf.set(p.sdf.subarray(y * p.w * S, (y + 1) * p.w * S), ((y0 * S + y) * W * S));
    for (const [id, r] of Object.entries(p.rects)) rects[id] = { ...r, y: r.y + y0 };
    y0 += p.h;
  }
  return { w: W, h: H, rgba, sw: W * S, sh: H * S, sdf, range: list[0].range, sdfS: S, rects };
}

/** is a point (art px from the sticker's centre) inside its die-cut? */
export function insideCut(rect, lx, ly) {
  const i = Math.floor(lx + rect.w / 2), j = Math.floor(ly + rect.h / 2);
  return i >= 0 && j >= 0 && i < rect.w && j < rect.h && rect.mask[j * rect.w + i] === 1;
}

/**
 * One sticker as a picture, `k` pixels per art pixel: its art on the white die-cut border (soft edge), transparent round
 * it → { w, h, rgba }. The sticker sheet's tiles, and the public preview pictures of the souldew+ ones.
 */
export function stickerPicture(atlas, id, k = 6) {
  const r = atlas.rects[id];
  if (!r) return null;
  const S = atlas.sdfS, W = r.w * k, H = r.h * k;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ax = r.x + Math.floor(x / k), ay = r.y + Math.floor(y / k);
    const sx = Math.floor((r.x + (x + 0.5) / k) * S), sy = Math.floor((r.y + (y + 0.5) / k) * S);
    const sd = (atlas.sdf[sy * atlas.sw + sx] / 255 - 0.5) * 2 * atlas.range;
    const i = (ay * atlas.w + ax) * 4, o = (y * W + x) * 4;
    if (atlas.rgba[i + 3]) { out[o] = atlas.rgba[i]; out[o + 1] = atlas.rgba[i + 1]; out[o + 2] = atlas.rgba[i + 2]; out[o + 3] = 255; } else if (sd <= 0) { out[o] = 244; out[o + 1] = 242; out[o + 2] = 236; out[o + 3] = Math.round(255 * Math.min(1, -sd * k * 0.6 + 0.5)); }
  }
  return { w: W, h: H, rgba: out };
}
