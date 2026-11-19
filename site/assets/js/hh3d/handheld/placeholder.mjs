// A neutral stand-in for the game picture (gallery, DS / 3DS renders): our own pixel scene on the game's native grid
// – a field with a path, a pond, trees and a house on the first screen, a touch-menu panel on the second. No game
// content, so it can be committed and shown anywhere. (The play-view renders of the GBA layout use a real captured
// frame from .cache/ instead when it is there; it is never committed.)
import { LAYOUTS } from './layouts.mjs';

/** a stable hash of a grid cell → 0…1 (the grass's speckle) */
function h1(i, s = 0) {
  let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((s | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 15; h = Math.imul(h, 0x165667b1); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const h2 = (x, y, s = 0) => h1(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663), s);

const C = {
  grass: '#6fae6a', grass2: '#62a05f', grassD: '#548c53', path: '#d9c690', pathE: '#b8a472', pond: '#4f8fb5', pondE: '#3a6d90', pondL: '#a3cde0',
  leaf: '#3f7a4a', leafD: '#2c5a37', leafL: '#5f9a5a', trunk: '#6b4a32', roof: '#b5584a', roofD: '#8a4137', roofL: '#cf7a62', wall: '#e8dec6', wallD: '#c9bc9c',
  door: '#5a4636', win: '#8fb8d0', fence: '#cdb88c', fenceD: '#9e8a62', flower: '#e7d26a', flower2: '#e48f86',
  m0: '#1f2531', m1: '#2a3140', m2: '#313a4b', b0: '#3c4a63', b1: '#52627f', b2: '#222a37', ic: '#c9d3e0', icD: '#8f9bb0', acc: '#d9b26a',
};

function field(ctx, s) {
  const { x: X, y: Y, w, h } = s;
  const P = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(X + x, Y + y, 1, 1); };
  const R = (x, y, ww, hh, c) => { ctx.fillStyle = c; ctx.fillRect(X + Math.round(x), Y + Math.round(y), Math.round(ww), Math.round(hh)); };
  R(0, 0, w, h, C.grass);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const n = h2(x >> 1, y >> 1, 7); if (n < 0.16) P(x, y, C.grass2); else if (n > 0.985) P(x, y, C.grassD); }
  // path: a bent road from the bottom to the house
  const px0 = Math.round(w * 0.46), pw = 22;
  R(px0, Math.round(h * 0.52), pw, h, C.path);
  R(Math.round(w * 0.12), Math.round(h * 0.52), px0 - Math.round(w * 0.12) + pw, 18, C.path);
  for (let x = Math.round(w * 0.12); x < px0 + pw; x++) { P(x, Math.round(h * 0.52) - 1, C.pathE); P(x, Math.round(h * 0.52) + 18, x > px0 && x < px0 + pw ? C.path : C.pathE); }
  for (let y = Math.round(h * 0.52) + 18; y < h; y++) { P(px0 - 1, y, C.pathE); P(px0 + pw, y, C.pathE); }
  // pond
  const cx = w * 0.78, cy = h * 0.72, rx = w * 0.13, ry = h * 0.13;
  for (let y = -ry - 1; y <= ry + 1; y++) for (let x = -rx - 1; x <= rx + 1; x++) {
    const d = (x / rx) ** 2 + (y / ry) ** 2; const xx = Math.round(cx + x), yy = Math.round(cy + y);
    if (d <= 0.82) P(xx, yy, C.pond); else if (d <= 1) P(xx, yy, C.pondE);
  }
  for (let i = 0; i < 3; i++) R(cx - rx * 0.5 + i * 7, cy - ry * 0.3 + i * 4, 5, 1, C.pondL);
  // house
  const hx = Math.round(w * 0.36), hy = Math.round(h * 0.14), hw = 52, hh = 30;
  R(hx, hy + 16, hw, hh, C.wall); R(hx, hy + 16 + hh - 3, hw, 3, C.wallD);
  // the roof: narrow at the ridge, widest at the eaves (website copy – the app's rows ran the other way round)
  for (let j = 0; j < 18; j++) { const k = 17 - j; R(hx - 4 + k * 0.9, hy + j, hw + 8 - k * 1.8, 1, j < 2 ? C.roofL : j === 17 ? C.roofD : j % 4 === 3 ? C.roofD : C.roof); }
  R(hx + 22, hy + 30, 9, 16, C.door); R(hx + 6, hy + 24, 10, 8, C.win); R(hx + 36, hy + 24, 10, 8, C.win);
  R(hx + 6, hy + 28, 10, 1, C.wallD); R(hx + 36, hy + 28, 10, 1, C.wallD);
  // fence along the left of the path
  for (let x = 6; x < Math.round(w * 0.3); x += 6) { R(x, Math.round(h * 0.4), 2, 8, C.fence); R(x, Math.round(h * 0.4) + 7, 2, 1, C.fenceD); }
  R(6, Math.round(h * 0.4) + 2, Math.round(w * 0.3) - 6, 1, C.fence);
  // trees
  const tree = (tx, ty) => {
    R(tx + 6, ty + 13, 4, 6, C.trunk);
    for (let y = 0; y < 15; y++) for (let x = 0; x < 16; x++) {
      const d = ((x - 7.5) / 8) ** 2 + ((y - 7) / 7.5) ** 2; if (d > 1) continue;
      P(tx + x, ty + y, d > 0.7 && (y > 8 || x > 11) ? C.leafD : (x + y < 10 && d < 0.5 ? C.leafL : C.leaf));
    }
  };
  const trees = [[0.02, 0.04], [0.1, 0.18], [0.84, 0.06], [0.92, 0.22], [0.04, 0.72], [0.2, 0.8], [0.62, 0.4]];
  for (const [a, b] of trees) tree(Math.round(a * w), Math.round(b * h));
  // flowers
  for (let i = 0; i < 26; i++) { const x = Math.round(h2(i, 1, 3) * w), y = Math.round(h * 0.45 + h2(i, 2, 3) * h * 0.5); if (Math.abs(x - px0 - 10) < 16) continue; P(x, y, i % 3 ? C.flower : C.flower2); }
}

function menu(ctx, s) {
  const { x: X, y: Y, w, h } = s;
  const R = (x, y, ww, hh, c) => { ctx.fillStyle = c; ctx.fillRect(X + Math.round(x), Y + Math.round(y), Math.round(ww), Math.round(hh)); };
  R(0, 0, w, h, C.m1);
  for (let y = 0; y < h; y += 8) R(0, y, w, 1, C.m2);
  R(0, 0, w, 14, C.m0); R(6, 5, 24, 4, C.icD); R(w - 30, 5, 24, 4, C.acc);
  const cols = 2, rows = 3, gx = 10, gy = 22, bw = (w - gx * 3) / cols, bh = (h - gy - 10 * rows - 6) / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = gx + c * (bw + gx), y = gy + r * (bh + 10);
    R(x, y + 2, bw, bh, C.b2); R(x, y, bw, bh, C.b0); R(x + 2, y, bw - 4, 1, C.b1); R(x, y + 2, 1, bh - 4, C.b1);
    const ix = x + 12, iy = y + bh / 2 - 6, k = (r * cols + c) % 4;
    if (k === 0) for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) { if ((i - 5.5) ** 2 + (j - 5.5) ** 2 < 34) R(ix + i, iy + j, 1, 1, C.ic); }
    if (k === 1) { R(ix, iy, 12, 12, C.ic); R(ix + 3, iy + 3, 6, 6, C.b0); }
    if (k === 2) for (let j = 0; j < 12; j++) R(ix + 6 - j / 2, iy + j, j + 1, 1, C.ic);
    if (k === 3) { R(ix, iy + 1, 12, 2, C.ic); R(ix, iy + 5, 12, 2, C.ic); R(ix, iy + 9, 8, 2, C.ic); }
    R(ix + 20, iy + 2, bw * 0.35, 3, C.icD); R(ix + 20, iy + 8, bw * 0.22, 3, C.b1);
  }
}

/** a canvas of the layout's native size with the placeholder game on every screen */
export function placeholderCanvas(layout, doc = document) {
  const L = LAYOUTS[layout] || LAYOUTS.gba;
  const cv = doc.createElement('canvas'); cv.width = L.W; cv.height = L.H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, L.W, L.H);
  L.screens.forEach((s, i) => (i === 0 ? field : menu)(ctx, s));
  return cv;
}
