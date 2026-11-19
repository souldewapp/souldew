// "Your handheld" in 3D – the launch animation's scene (design rounds 4–6, vendored three.js r180, web/vendor/three, loaded
// only for the launch animation and the editor). One transparent canvas over the play view's screen area: our own
// souldew handhelds (no Nintendo shapes, no logos – "souldew" on the shell), a real camera (dolly, crane, orbit, handheld
// drift that settles), physical light (an environment, a key light with soft shadows, the screens' own light on the
// plastic), a cartridge with weight, the wrap and the stickers on the shell (surface.mjs). Everything is a pure function
// of time: render(ms) draws that moment, so a skip just renders the last frame.
//
//   DS / 3DS  "Unfold"  – the closed clamshell lies on the table, seen from low. The magnet lets go, the lid swings up
//                         with weight (overshoot, the base rocks), the card drops into the lid's top edge and latches (the
//                         lid gives), a pulse of light runs through the shell from the slot, both screens power on, the
//                         camera cranes over the top while the hinge lays flat, and the two screens glide into the play
//                         view's screens – in its layout (stacked, side by side, large, top only).
//   GBA / GB  "Turn"    – the handheld rises from lying back, seen from behind; the cartridge drops into the back slot
//                         and latches (a pulse runs through the shell), the camera orbits round to the front while the
//                         screen powers on and pushes into the screen.
//
// The last frame is the play view's own screen rectangle, pixel for pixel (finalCamera): the real game is under it.
import * as THREE from '../vendor/three.module.min.js';
import { RoomEnvironment } from '../vendor/RoomEnvironment.js';
import { placeholderCanvas } from './placeholder.mjs';
import { LAYOUTS } from './layouts.mjs';
import { withSurface, NSTK } from './surface.mjs';
import { DEVICES, PX, partsOf, surfacesOf, unfold } from './geometry.mjs';
import { wrapArt } from './wrap.mjs';
import { effectiveLook, effectiveCart, finishIndex } from './looks.mjs';

export { DEVICES };

const D2R = Math.PI / 180;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => clamp01((t - a) / (b - a));

/** cubic-bezier(x1, y1, x2, y2) as a function of x ∈ [0, 1] */
function bez(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (u) => ((ax * u + bx) * u + cx) * u;
  const Y = (u) => ((ay * u + by) * u + cy) * u;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 8; i++) {
      const dx = X(u) - x;
      const d = (3 * ax * u + 2 * bx) * u + cx;
      if (Math.abs(dx) < 1e-5 || !d) break;
      u -= dx / d;
    }
    return Y(Math.max(0, Math.min(1, u)));
  };
}
const SWING = bez(0.42, 0, 0.3, 1);
export const EASE = {
  io: bez(0.65, 0, 0.35, 1), // in-out, for camera moves
  out: bez(0.2, 0.7, 0.3, 1),
  out2: bez(0.15, 0.85, 0.3, 1),
  in: bez(0.55, 0, 0.95, 0.5), // gravity
  push: bez(0.62, 0, 0.24, 1), // weighty start, long soft landing
  soft: bez(0.4, 0, 0.2, 1),
  lin: (x) => x,
};
/** piecewise track: [[ms, value, ease-of-the-segment-starting-here], …] */
function track(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0, e] = keys[i];
    const [t1, v1] = keys[i + 1];
    if (t < t1) return lerp(v0, v1, (EASE[e] || EASE.lin)((t - t0) / (t1 - t0)));
  }
  return keys[keys.length - 1][1];
}
/** unit step response of a damped spring (0 → 1), τ in ms */
function spring(tau, f, z) {
  if (tau <= 0) return 0;
  const s = tau / 1000;
  const w = 2 * Math.PI * f;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * s) * (Math.cos(wd * s) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * s));
}
/** a knock: a damped sine starting at 0, first swing towards +1 */
function knock(tau, f, z) {
  if (tau <= 0) return 0;
  const s = tau / 1000;
  const w = 2 * Math.PI * f;
  return Math.exp(-z * w * s) * Math.sin(w * Math.sqrt(1 - z * z) * s);
}
/** smooth noise for the handheld drift (sum of incommensurate sines) */
const drift = (t, s) => Math.sin(t * 0.0021 + s) * 0.6 + Math.sin(t * 0.0047 + s * 2.3) * 0.3 + Math.sin(t * 0.0113 + s * 5.1) * 0.1;

// ---------------------------------------------------------------------------------------------------------------------
// The handhelds (millimetres). Every device is built lying face up (+Y), its top edge towards −Z; GBA / GB then stand.



let ARC = false; // design/launch5: true circular corners (the wrap's unfold assumes them; round 4 used quadratic ones)
function roundedRect(w, h, r, rBR = r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  if (ARC) {
    s.moveTo(x + r, y);
    s.lineTo(x + w - rBR, y);
    s.absarc(x + w - rBR, y + rBR, rBR, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r);
    s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h);
    s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r);
    s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    return s;
  }
  // counter-clockwise; rBR = the bottom-right corner (shape space: +x, −y)
  s.moveTo(x + r, y);
  s.lineTo(x + w - rBR, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rBR);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
/** a moulded slab: plan w × d (x × z), height h (y ∈ [0, h]), rounded plan corners, soft bevelled edges */
function slabGeo(w, d, h, r, bevel, rBR) {
  const b = Math.min(bevel, h / 2 - 0.3);
  const g = new THREE.ExtrudeGeometry(roundedRect(w - 2 * b, d - 2 * b, Math.max(1, r - b), Math.max(1, (rBR ?? r) - b)), {
    depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 8, curveSegments: 36,
  });
  g.rotateX(-Math.PI / 2); // shape y → −z (so the shape's bottom-right corner lands at +x, +z), extrusion → +y
  g.translate(0, b, 0);
  g.computeVertexNormals();
  return g;
}
function plane(w, h, upAxis) { // a plane in the XZ plane facing +y (upAxis 'up') or −y ('down'); its texture top is −z
  const g = new THREE.PlaneGeometry(w, h);
  // 'up': faces +y, texture top towards −z · 'down': faces −y, texture top towards +z (neither is mirrored)
  if (upAxis === 'down') g.rotateX(Math.PI / 2); else g.rotateX(-Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// Textures drawn on a canvas (our own drawings only)

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
/** the wordmark, white on transparent (used as an alpha map: printed / debossed on the shell) */
function wordTex(text, px = 120) {
  return canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = '#fff';
    g.font = `600 ${px}px "Inter", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.letterSpacing = '6px';
    g.fillText(text, w / 2, h / 2 + 6);
  }, false);
}
/**
 * the board under a clear shell, drawn from the souldew+ pack's recipe (handheld/looks.json › clear.board, checked by
 * looks.mjs): copper traces fanning out, chips, a coin cell, the connector. Returns [map, traceMask].
 */
function boardTex(w, h, B) {
  const rnd = (i) => { const x = Math.sin(i * 127.1 + B.seed * 311.7) * 43758.5453; return x - Math.floor(x); };
  const S = B.scale; // px per mm
  const T = B.traces;
  const at = ([f, mm], size) => f * size + mm; // [fraction of the board, mm]
  const draw = (mask) => (g) => {
    g.fillStyle = mask ? '#000' : B.bg;
    g.fillRect(0, 0, w * S, h * S);
    g.lineCap = 'round';
    g.strokeStyle = mask ? '#fff' : T.color;
    g.lineWidth = mask ? T.maskWidth : T.width;
    for (let i = 0; i < T.n; i++) { // Manhattan traces fanning out from the centre
      const x0 = w * S / 2 + (rnd(i) - 0.5) * T.spread, y0 = h * S * T.y0;
      const x1 = (T.x[0] + rnd(i + 40) * T.x[1]) * w * S, y1 = (T.y[0] + rnd(i + 80) * T.y[1]) * h * S;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0, (y0 + y1) / 2); g.lineTo(x1, (y0 + y1) / 2); g.lineTo(x1, y1); g.stroke();
      if (!mask) { g.fillStyle = T.pad; g.beginPath(); g.arc(x1, y1, T.padR, 0, 7); g.fill(); }
    }
    if (mask) return;
    const C = B.chip;
    for (const c of B.chips) {
      const x = at(c.x, w), y = at(c.y, h);
      g.fillStyle = C.pins;
      for (let k = 0; k < c.w / 2.2; k++) { g.fillRect((x + 1 + k * 2.2) * S, (y - 1) * S, 1.1 * S, c.h * S + 2 * S); }
      g.fillStyle = C.body; g.fillRect(x * S, y * S, c.w * S, c.h * S);
      g.fillStyle = C.top; g.fillRect(x * S + 3, y * S + 3, c.w * S - 6, 3);
      if (c.label) { g.fillStyle = C.label; g.font = `600 ${2.6 * S}px Arial`; g.textAlign = 'center'; g.fillText(c.label, (x + c.w / 2) * S, (y + c.h / 2 + 1) * S); }
    }
    const K = B.coin;
    g.fillStyle = K.ring; g.beginPath(); g.arc(w * K.x * S, h * K.y * S, K.r * S, 0, 7); g.fill();
    g.fillStyle = K.face; g.beginPath(); g.arc(w * K.x * S, h * K.y * S, K.r2 * S, 0, 7); g.fill();
    const N = B.connector;
    g.fillStyle = N.color; g.fillRect(w * 0.5 * S - (N.w / 2) * S, N.y * S, N.w * S, N.h * S); // the cartridge connector
  };
  return [canvasTex(w * S, h * S, draw(false)), canvasTex(w * S, h * S, draw(true), false)];
}
/** the cartridge's label: the library's cover inside a printed frame (or the title when there is none) */
function labelTex(img, title, aspect, color) {
  const W = 512, H = Math.round(512 / aspect);
  return canvasTex(W, H, (g) => {
    g.fillStyle = '#f1efe9'; g.fillRect(0, 0, W, H);
    if (img) {
      const ia = img.width / img.height;
      let dw = W - 24, dh = dw / ia;
      if (dh > H - 24) { dh = H - 24; dw = dh * ia; }
      g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      g.fillStyle = color; g.fillRect(12, 12, W - 24, H - 24);
      g.fillStyle = '#fff'; g.font = '600 46px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(title, W / 2, H / 2);
    }
  });
}
/** the holo label's foil (a thickness map for iridescence), from the pack's recipe: a sum of waves */
function foilTex(F) {
  return canvasTex(F.size, F.size, (g, w, h) => {
    const im = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = F.base;
        for (const t of F.terms) v += t.a * Math.sin(t.kx * x + t.ky * y + Math.sin(y * t.wy) * t.wa);
        const i = (y * w + x) * 4;
        im.data[i] = im.data[i + 1] = im.data[i + 2] = Math.round(Math.max(0, Math.min(1, v)) * 255);
        im.data[i + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, false);
}
/** moulded plastic: a fine, even grain as a normal map */
let GRAIN = null;
function grainTex() {
  if (GRAIN) return GRAIN;
  const N = 256;
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = Math.random();
  for (let k = 0; k < 2; k++) { // soften once or twice
    const c = h.slice();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) h[y * N + x] = (c[y * N + x] * 4 + c[y * N + (x + 1) % N] + c[y * N + (x + N - 1) % N] + c[((y + 1) % N) * N + x] + c[((y + N - 1) % N) * N + x]) / 8;
  }
  GRAIN = canvasTex(N, N, (g) => {
    const im = g.createImageData(N, N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N];
        const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
        const i = (y * N + x) * 4;
        im.data[i] = 128 + dx * 255; im.data[i + 1] = 128 + dy * 255; im.data[i + 2] = 255; im.data[i + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
  }, false);
  GRAIN.wrapS = GRAIN.wrapT = THREE.RepeatWrapping;
  GRAIN.repeat.set(0.035, 0.035); // the geometry's UVs are in mm: one tile ≈ 28 mm
  return GRAIN;
}
/** a soft round shadow / glow */
function blobTex() {
  return canvasTex(256, 256, (g) => {
    const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.45, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  }, false);
}

// ---------------------------------------------------------------------------------------------------------------------
// The LCD: off glass → backlight flicker → lit black → boot glow → the first frame drawn in row by row behind a scan
// line through the pixel grid → the clean picture (exactly the play view's, so the hand-over is invisible)

const SCREEN_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SCREEN_FS = `
uniform sampler2D map; uniform vec4 uRect; uniform vec2 uRes;
uniform float uBack, uGlow, uDraw, uWash, uGrid, uBloom, uClean;
uniform vec3 uOff, uLb, uPanel, uScan;
varying vec2 vUv;
void main() {
  vec2 uv = uRect.xy + vUv * uRect.zw;
  vec3 img = texture2D(map, uv).rgb;
  float row = 1.0 - vUv.y;
  float drawn = step(row, uDraw);
  float sd = (row - uDraw) * 70.0;
  float scan = exp(-sd * sd) * step(0.001, uDraw) * step(uDraw, 1.0);
  float trail = smoothstep(uDraw - 0.16, uDraw, row) * step(row, uDraw) * step(0.001, uDraw) * step(uDraw, 1.0);
  vec3 c = mix(uPanel, mix(img, uPanel, uWash), drawn);
  c += uScan * (scan * 0.9 + trail * 0.18);
  vec2 g = fract(vUv * uRes);
  float cell = smoothstep(0.0, 0.2, g.x) * smoothstep(1.0, 0.8, g.x) * smoothstep(0.0, 0.2, g.y) * smoothstep(1.0, 0.8, g.y);
  c *= mix(1.0, 0.7 + 0.3 * cell, uGrid);
  float vig = 1.0 - 0.35 * length((vUv - vec2(0.5, 0.56)) * vec2(1.0, 1.25));
  vec3 lb = uLb * vig;
  vec3 lit = mix(lb, c, uGlow);
  vec3 off = uOff * (0.8 + 0.4 * vig);
  vec3 col = mix(off, lit, uBack);
  col += vec3(1.0) * uBloom * pow(clamp(1.0 - length((vUv - 0.5) * vec2(1.0, 1.3)) * 1.25, 0.0, 1.0), 1.6);
  col = mix(col, img, uClean);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function screenMat(tex, rect, res, sys, warm) { // warm: the Rare start's screen palette (souldew+ pack) or null
  const pal = warm || (sys === 'gb' ? ['#3c4535', '#5f6b4c', '#c2cc9c', '#e9f0cf'] : sys === 'gbc' ? ['#2e312a', '#4f5446', '#ced1be', '#f3f4ea'] : ['#07090b', '#1a2229', '#e9eeec', '#ffffff']);
  const col = (h) => new THREE.Color(h);
  return new THREE.ShaderMaterial({
    vertexShader: SCREEN_VS, fragmentShader: SCREEN_FS, toneMapped: false, transparent: true,
    uniforms: {
      map: { value: tex }, uRect: { value: new THREE.Vector4(...rect) }, uRes: { value: new THREE.Vector2(...res) },
      uBack: { value: 0 }, uGlow: { value: 0 }, uDraw: { value: 0 }, uWash: { value: 1 }, uGrid: { value: 0 }, uBloom: { value: 0 }, uClean: { value: 0 },
      uOff: { value: col(pal[0]) }, uLb: { value: col(pal[1]) }, uPanel: { value: col(pal[2]) }, uScan: { value: col(pal[3]) },
    },
  });
}
/** the power-on of one screen; b = the backlight's moment (ms) */
function screenState(t, b) {
  const u = {};
  u.uBack = track(t, [[0, 0], [b, 0], [b + 12, 0.3], [b + 28, 0.85], [b + 48, 0.4], [b + 70, 1]]);
  u.uBloom = track(t, [[0, 0], [b + 40, 0, 'out'], [b + 130, 0.75, 'soft'], [b + 360, 0]]);
  u.uGlow = track(t, [[0, 0], [b + 80, 0, 'soft'], [b + 170, 1]]);
  u.uDraw = track(t, [[0, 0], [b + 190, 0, 'soft'], [b + 430, 1.2]]);
  u.uWash = track(t, [[0, 1], [b + 190, 0.62, 'out'], [b + 720, 0]]);
  u.uGrid = track(t, [[0, 0], [b + 60, 0, 'out'], [b + 110, 0.55], [b + 300, 0.5, 'soft'], [b + 900, 0]]);
  u.light = Math.max(u.uBack * 0.25, u.uGlow * (0.55 + 0.45 * (1 - u.uDraw / 1.2) * 0.6)) + u.uBloom;
  return u;
}

// ---------------------------------------------------------------------------------------------------------------------
// The light pulse through the shell: an expanding shell of light from the slot (injected into the shell materials)

function withPulse(mat, P) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, P);
    sh.vertexShader = `varying vec3 vWP;\n${sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;')}`;
    sh.fragmentShader = `uniform float uPR, uPW, uPA, uGA, uGR; uniform vec3 uPC, uPO, uGC, uGO; varying vec3 vWP;\n${sh.fragmentShader.replace('#include <opaque_fragment>',
      `float pd = distance(vWP, uPO);
  float b1 = (pd - uPR) / uPW, b2 = (pd - uPR * 0.62) / (uPW * 1.6);
  float band = exp(-b1 * b1) + 0.35 * exp(-b2 * b2);
  outgoingLight += uPC * uPA * band;
  // the screens' light on the plastic round them (diffuse only: no hot spot on the glass)
  float gd = distance(vWP, uGO) / uGR;
  outgoingLight += uGC * uGA * diffuseColor.rgb * exp(-gd * gd);
  #include <opaque_fragment>`)}`;
  };
  mat.customProgramCacheKey = () => 'pulse';
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------

const EMPTY_ATLAS = { w: 1, h: 1, rgba: new Uint8Array(4), sw: 1, sh: 1, sdf: new Uint8Array([255]), range: 4, rects: {} };

/**
 * The scene. o = { sys, lk (LAYOUTS key), w, h (canvas css px), final ({ x, y, w, h }: the play view's screen rectangle in
 * the canvas), dark, look ('theme' | 'clear' | 'gold'), shell (#rrggbb), clearTint, cartLook ('gold' | 'holo'), cartColor,
 * looks (the souldew+ pack's looks, looks.mjs cleanLooks – without them a souldew+ look draws "Your colours"),
 * cover (url), title, pulse, glow, warm (Rare start), plan (t → state), picture ('placeholder' | a live canvas | null),
 * keep (preserveDrawingBuffer, for a still), atlas (web/lib/handheld/stickers.mjs), hh: { skin (wrap composition +
 * finish) | null, recipe, reduced, stickers } }.
 */
export async function createScene(canvas, o) {
  ARC = !!o.hh;
  const dev = DEVICES[o.sys];
  const fold = dev.kind === 'fold';
  const G = partsOf(o.sys);
  // the set-up gives the main thread back between its steps (o.yieldTo: the launch hands it to the game's player page,
  // which loads in the same thread – the game's start must never wait for the device)
  const pause = async (what) => { o.mark?.(what); if (o.yieldTo) await o.yieldTo(); }; // where the parts sit (geometry.mjs – the faces cut round the same numbers)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: !!o.keep });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setSize(o.w, o.h, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  await pause('renderer');
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environmentIntensity = 0.45;

  const cam = new THREE.PerspectiveCamera(o.fov || 28, o.w / o.h, 40, 3000);

  await pause('environment');
  // ---- materials ----
  const P = { uPR: { value: 0 }, uPW: { value: 9 }, uPA: { value: 0 }, uPC: { value: new THREE.Color(o.pulse || '#fff4e0') }, uPO: { value: new THREE.Vector3() },
    uGA: { value: 0 }, uGR: { value: 60 }, uGC: { value: new THREE.Color(o.glow || '#dfe8ff') }, uGO: { value: new THREE.Vector3() } };
  const shellColor = new THREE.Color(o.shell);
  // theme | clear | gold – a souldew+ shell, cartridge, finish or Rare start only with its data from the verified pack
  const LK = o.looks || null;
  const look = effectiveLook(o.look, LK);
  const cartLook = effectiveCart(o.cartLook, LK);
  const warm = o.warm && LK?.rare ? LK.rare.screen : null;
  const NOT_MATERIAL = ['tone', 'whiten', 'shade', 'opacity', 'color', 'emissive']; // looks.mjs's own words, colours below
  const physical = (m, extra = {}) => { // a material from the pack's checked values (looks.mjs)
    const rest = Object.fromEntries(Object.entries(m).filter(([k]) => !NOT_MATERIAL.includes(k)));
    return new THREE.MeshPhysicalMaterial({ ...rest, ...(m.color ? { color: new THREE.Color(m.color) } : {}), ...(m.emissive ? { emissive: new THREE.Color(m.emissive) } : {}), ...extra });
  };
  const fadeMats = [];
  const fadeable = (m) => { m.transparent = true; m.userData.o = m.opacity; if (m.depthWrite === false) m.userData.dw = false; fadeMats.push(m); return m; };
  const mkShell = (tone = 0, colour = shellColor) => {
    let m;
    if (look === 'gold') {
      const G = LK.gold.shell;
      m = physical(G, { color: new THREE.Color(G.color).offsetHSL(0, 0, tone * (G.tone || 0)) });
    } else if (look === 'clear') {
      const C = LK.clear.shell;
      const tint = new THREE.Color(o.clearTint);
      m = physical(C, { color: tint.clone().lerp(new THREE.Color('#ffffff'), C.whiten || 0), attenuationColor: tint });
    } else m = new THREE.MeshPhysicalMaterial({ color: colour.clone().offsetHSL(0, 0, tone * 0.05), metalness: 0, roughness: 0.46, normalMap: grainTex(), normalScale: new THREE.Vector2(0.07, 0.07), clearcoat: 0.55, clearcoatRoughness: 0.32, sheen: 0.25, sheenRoughness: 0.6, sheenColor: colour.clone().lerp(new THREE.Color('#fff'), 0.5) });
    return fadeable(withPulse(m, P));
  };
  const shellM = mkShell(0);
  const shellM2 = mkShell(-1); // a second, darker plastic (base, hinge)
  const gold = look === 'gold' ? LK.gold : null;
  const darkM = fadeable(withPulse(gold ? physical({ roughness: 0.55, clearcoat: 0.3, ...gold.dark })
    : new THREE.MeshPhysicalMaterial({ color: shellColor.clone().multiplyScalar(0.32), roughness: 0.55, clearcoat: 0.3 }), P));
  const keyM = fadeable(withPulse(gold ? physical({ roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.2, ...gold.keys })
    : new THREE.MeshPhysicalMaterial({ color: shellColor.clone().lerp(new THREE.Color('#1b1b20'), 0.62), roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.2, metalness: 0 }), P));
  const glassM = fadeable(new THREE.MeshPhysicalMaterial({ color: '#060708', roughness: 0.22, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.1, envMapIntensity: 0.6 }));
  const slotM = fadeable(new THREE.MeshStandardMaterial({ color: '#050506', roughness: 0.9 }));
  const clearWord = look === 'clear' ? LK.clear.word : null;
  const wordM = fadeable(new THREE.MeshPhysicalMaterial({ color: gold ? new THREE.Color(gold.word.color) : shellColor.clone().multiplyScalar(clearWord?.shade ?? 0.55), roughness: 0.22, clearcoat: 1, alphaMap: wordTex('souldew'), transparent: true, depthWrite: false, opacity: clearWord?.opacity ?? 0.9 }));
  const ledM = fadeable(new THREE.MeshBasicMaterial({ color: new THREE.Color(dev.led).multiplyScalar(0.12), toneMapped: false }));
  const glareM = new THREE.MeshBasicMaterial({ color: dev.led, map: blobTex(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, toneMapped: false });
  const backM = new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0, depthWrite: false, depthTest: false, toneMapped: false });

  // ---- the screen picture, split into the device's screens: the running game's own canvas (live, when the player draws
  // it so it can be read – the fast and the 3DS player), the neutral placeholder scene (the editor, a preview) or a dark
  // panel (the screens power on, the game appears under the hand-over)
  const lk = o.lk;
  const L = LAYOUTS[lk];
  // o.picture: 'placeholder', a canvas, or a function that finds the game's canvas once its page is there (asked again
  // every few frames until it answers – the player page loads while the animation already runs)
  let live = o.picture && o.picture !== 'placeholder' && typeof o.picture !== 'function' ? o.picture : null;
  const findLive = typeof o.picture === 'function' ? o.picture : null;
  let picSrc = live;
  if (!picSrc) {
    picSrc = o.picture === 'placeholder' ? placeholderCanvas(lk) : Object.assign(document.createElement('canvas'), { width: L.W, height: L.H });
    if (o.picture !== 'placeholder') { const g = picSrc.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, L.W, L.H); }
  }
  const liveTex = (c) => {
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.magFilter = THREE.NearestFilter;
    tx.minFilter = THREE.LinearFilter;
    tx.generateMipmaps = false;
    tx.userData.w = c.width;
    tx.userData.h = c.height;
    return tx;
  };
  let ptex = live ? liveTex(live) : new THREE.CanvasTexture(picSrc);
  if (!live) {
    ptex.colorSpace = THREE.SRGBColorSpace;
    ptex.magFilter = THREE.NearestFilter;
    ptex.minFilter = THREE.LinearMipmapLinearFilter;
    ptex.generateMipmaps = true;
  }
  const scrMats = L.screens.map((r) => screenMat(ptex, [r.x / L.W, 1 - (r.y + r.h) / L.H, r.w / L.W, r.h / L.H], [r.w, r.h], o.sys, warm));
  if (fold && scrMats.length < 2) scrMats.push(screenMat(ptex, [0, 0, 0.0001, 0.0001], [1, 1], o.sys, warm)); // a screen the layout hides

  await pause('materials');
  // ---- build ----
  const world = new THREE.Group();
  scene.add(world);
  const root = new THREE.Group(); // the device's placement in the world
  world.add(root);
  const body = new THREE.Group(); // rocks / rises / knocks
  root.add(body);
  const mesh = (g, m, parent, shadow = true) => { const x = new THREE.Mesh(g, m); x.castShadow = shadow; x.receiveShadow = shadow; parent.add(x); return x; };
  const parts = {};
  let screenMeshes = [];
  let cartHome; // the cart's parent group (moves along its insertion axis)
  let slotLocal; // the slot's mouth in the cart parent's frame
  let lidPivot = null;
  let screenFrame; // { center, normal, up } in body coordinates at the final pose, and gap closing per screen

  if (fold) {
    const { W, D, hb, hl, r } = dev;
    const ax = { y: hb, z: -D / 2 - 2 }; // the hinge axis
    // base
    const base = new THREE.Group();
    body.add(base);
    parts.baseSlab = mesh(slabGeo(W, D, hb, r, 2.6), shellM2, base);
    // the inner face of the base: a soft recessed deck, the bottom screen in a black bezel, a pad, two buttons, two pills
    const [bw, bh] = dev.bot;
    const deck = mesh(slabGeo(W - 7, D - 7, 0.6, r - 3, 0.25), shellM, base);
    deck.position.y = hb - 0.35;
    parts.deck = deck;
    const bez1 = mesh(slabGeo(bw + 7, bh + 7, 0.8, 3.5, 0.3), glassM, base, false);
    bez1.position.set(0, hb - 0.5, 1.5);
    const sb = mesh(plane(bw, bh, 'up'), scrMats[1], base, false);
    sb.position.set(0, hb + 0.32, 1.5);
    const padR = 8.2;
    const pad = mesh(new THREE.CylinderGeometry(padR, padR + 0.4, 1.8, 48), keyM, base);
    pad.position.set(-(bw / 2 + (W / 2 - bw / 2) / 2) - 1, hb + 0.9, -1);
    const dish = mesh(new THREE.CylinderGeometry(padR * 0.55, padR * 0.55, 0.3, 40), darkM, base, false);
    dish.position.set(pad.position.x, hb + 1.85, pad.position.z);
    const bx = bw / 2 + (W / 2 - bw / 2) / 2 + 1;
    for (const [dx, dz] of [[-4.2, 3.8], [4.2, -3.8]]) {
      const btn = mesh(new THREE.CylinderGeometry(3.6, 3.8, 2.2, 36), keyM, base);
      btn.position.set(bx + dx, hb + 1.1, -1 + dz);
    }
    for (const dx of [-5, 5]) {
      const pill = mesh(new THREE.CapsuleGeometry(1.1, 4.5, 4, 12), darkM, base);
      pill.rotation.z = Math.PI / 2;
      pill.position.set(bx + dx * 0.9, hb + 0.4, D / 2 - 11);
    }
    const led = mesh(new THREE.SphereGeometry(1.15, 16, 12), ledM, base, false);
    led.position.set(-W / 2 + 13, hb + 0.2, D / 2 - 8.5);
    const glare = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 6.5), glareM);
    glare.userData.nopick = true;
    glare.rotation.x = -Math.PI / 2;
    glare.position.set(led.position.x, hb + 1.4, led.position.z);
    base.add(glare);
    parts.led = led;
    // the hinge barrel
    const barrel = mesh(new THREE.CylinderGeometry(4.6, 4.6, W - 30, 40), darkM, base);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(0, ax.y, ax.z + 0.6);
    for (const sx of [-1, 1]) {
      const cap = mesh(new THREE.CylinderGeometry(4.75, 4.75, 1.2, 40), keyM, base);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(sx * (W - 30) / 2, ax.y, ax.z + 0.6);
    }
    // lid
    lidPivot = new THREE.Group();
    lidPivot.position.set(0, ax.y, ax.z);
    base.add(lidPivot);
    const lid = new THREE.Group();
    lidPivot.add(lid);
    const off = 2.4; // the lid starts just past the axis
    lid.position.z = off + D / 2;
    parts.lidSlab = mesh(slabGeo(W, D, hl, r, 2.4), shellM, lid); // centred on the lid group: z ∈ [−D/2 (hinge), D/2 (top edge)]
    // inner face (−y): one black glass panel with the top screen
    const [tw, th] = dev.top;
    const panel = mesh(new THREE.ShapeGeometry(roundedRect(W - 10, D - 9, r - 4), 12), glassM, lid, false);
    panel.rotation.x = Math.PI / 2; // faces −y, shape y → +z
    panel.position.set(0, -0.08, 0);
    const st = mesh(plane(tw, th, 'down'), scrMats[0], lid, false);
    st.position.set(0, -0.32, 2);
    // speaker: two rows of dots either side of the screen
    const dotG = new THREE.CircleGeometry(0.42, 10);
    dotG.rotateX(Math.PI / 2);
    for (const sx of [-1, 1]) { // a neat 3 × 5 grid either side
      for (let k = 0; k < 15; k++) {
        const d = new THREE.Mesh(dotG, slotM);
        d.position.set(sx * (tw / 2 + (W - 10 - tw) / 4) + ((k % 3) - 1) * 2.6, -0.12, 2 - 7 + Math.floor(k / 3) * 2.6 + 1.6);
        lid.add(d);
      }
    }
    // outer face (+y): the wordmark, debossed and glossy
    const wm = mesh(plane(46, 11.5, 'up'), wordM, lid, false);
    wm.position.set(0, hl + 0.04, 6);
    parts.wm = wm;
    // the slot in the lid's top edge (+z when open)
    const [cw, cl, ct, out] = dev.card;
    const slot = mesh(new THREE.BoxGeometry(cw + 2.4, ct + 1.2, 3), slotM, lid, false);
    slot.position.set(0, hl / 2, D / 2 - 1.75);
    const lipM = keyM;
    const lip = mesh(new THREE.BoxGeometry(cw + 6, 1, 1.4), lipM, lid, false);
    lip.position.set(0, hl / 2 + ct / 2 + 1.1, D / 2 - 0.4);
    // the card (label towards the screen side) travels along +z
    cartHome = new THREE.Group();
    lid.add(cartHome);
    cartHome.position.set(0, hl / 2, D / 2 + out - cl / 2);
    slotLocal = new THREE.Vector3(0, hl / 2, D / 2);
    parts.lid = lid;
    parts.base = base;
    parts.lidGeo = { off, D, ax };
    if (o.hh) { // where the wrap goes and what it leaves bare (geometry.mjs: each face in its mesh's unfolded mm)
      for (const [fx, fz] of G.feet) { // rubber feet under the base: real ones, so the wrap has to go round them
        const ft = mesh(new THREE.CylinderGeometry(2.6, 2.8, 0.7, 28), darkM, base, false);
        ft.position.set(fx, -0.3, fz);
      }
      const F = surfacesOf(o.sys);
      parts.hh = { lid: { mesh: parts.lidSlab, ...F.lid }, deck: { mesh: deck, ...F.deck }, base: { mesh: parts.baseSlab, ...F.base } };
    }
    screenMeshes = [st, sb];
    // final pose (lid at 180°): both screens face +y. The two screens glide into the play view's layout (stacked, side by
    // side, large, top only – LAYOUTS[lk], one layout unit = k mm) round the middle of where they lie open.
    const zTop = ax.z - (off + D / 2 + 2); // the lid screen's centre (st.position.z = 2 in lid space, mirrored)
    const zBot = 1.5;
    const cz = (zTop + zBot) / 2;
    const k = tw / L.screens[0].w;
    const fy = hb + 0.32;
    const finals = [0, 1].map((i) => {
      const r = L.screens[i];
      if (!r) return null; // (3DS "top screen only": the bottom one goes)
      const scale = i === 1 ? (r.w * k) / bw : 1;
      return { pos: new THREE.Vector3(k * (r.x + r.w / 2 - L.W / 2), fy, cz + k * (r.y + r.h / 2 - L.H / 2)), scale };
    });
    screenFrame = { center: new THREE.Vector3(0, fy, cz), normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), size: [L.W * k, L.H * k], finals,
      home: [st.position.clone(), sb.position.clone()] };
    parts.zTop = zTop;
  } else {
    const { W, D, h, r, rBR } = dev;
    const [sw, sh] = dev.scr;
    parts.body = mesh(slabGeo(W, D, h, r, 4.2, rBR), shellM, body);
    // a parting line: the front half a hair lighter than the back
    const seam = mesh(slabGeo(W + 0.25, D + 0.25, 0.5, r, 0.2, rBR), darkM, body, false);
    seam.position.y = h * 0.45;
    // front face (+y): the glass lens with the screen, a pad, two buttons, two pills, the LED
    const lens = mesh(slabGeo(sw + 14, sh + 14, 0.9, 5, 0.35), glassM, body, false);
    lens.position.set(0, h - 0.2, dev.scrZ);
    const sc = mesh(plane(sw, sh, 'up'), scrMats[0], body, false);
    sc.position.set(0, h + 0.72, dev.scrZ);
    const portrait = D > W;
    const padPos = portrait ? [-W / 2 + 22, D / 2 - 44] : [-W / 2 + 21, 4];
    const pad = mesh(new THREE.CylinderGeometry(10, 10.4, 2, 48), keyM, body);
    pad.position.set(padPos[0], h + 0.8, padPos[1]);
    const dish = mesh(new THREE.CylinderGeometry(5.6, 5.6, 0.3, 40), darkM, body, false);
    dish.position.set(padPos[0], h + 1.85, padPos[1]);
    const bp = portrait ? [W / 2 - 22, D / 2 - 47] : [W / 2 - 21, 2];
    for (const [dx, dz] of [[-5, 4], [5, -4]]) {
      const btn = mesh(new THREE.CylinderGeometry(4.6, 4.8, 2.4, 36), keyM, body);
      btn.position.set(bp[0] + dx, h + 1.1, bp[1] + dz);
    }
    for (const dx of [-7, 7]) {
      const pill = mesh(new THREE.CapsuleGeometry(1.3, 6, 4, 12), darkM, body);
      pill.rotation.z = Math.PI / 2;
      pill.rotation.y = portrait ? -0.45 : 0;
      pill.position.set((portrait ? 0 : 0) + dx, h + 0.5, portrait ? D / 2 - 22 : D / 2 - 12);
    }
    const led = mesh(new THREE.SphereGeometry(1.3, 16, 12), ledM, body, false);
    led.position.set(-sw / 2 - 5, h + 0.1, dev.scrZ - sh / 2 + 3);
    if (portrait) led.position.set(-sw / 2 - 4.5, h + 0.1, dev.scrZ - 6);
    const glare = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), glareM);
    glare.userData.nopick = true;
    glare.rotation.x = -Math.PI / 2;
    glare.position.set(led.position.x, h + 1.5, led.position.z);
    body.add(glare);
    parts.led = led;
    // back face (−y): the wordmark and a battery cover
    const wm = mesh(plane(portrait ? 40 : 48, portrait ? 10 : 12, 'down'), wordM, body, false);
    wm.position.set(0, -0.05, portrait ? -18 : -8);
    wm.rotation.y = Math.PI; // reads upright from behind when standing
    parts.wm = wm;
    const cover = mesh(slabGeo(portrait ? 58 : 70, portrait ? 52 : 30, 0.6, 5, 0.25), darkM, body, false);
    cover.position.set(0, -0.35, portrait ? 34 : 22);
    parts.cover = cover;
    // the slot in the top edge (−z), towards the back
    const [cw, cl, ct, inn] = dev.cart;
    const slot = mesh(new THREE.BoxGeometry(cw + 2.6, ct + 1.4, 4), slotM, body, false);
    slot.position.set(0, dev.slotY, -D / 2 + 1.75);
    // the cart travels along +z (down, standing); label towards the back (−y)
    cartHome = new THREE.Group();
    body.add(cartHome);
    cartHome.position.set(0, dev.slotY, -D / 2 - cl * (1 - inn) + cl / 2);
    slotLocal = new THREE.Vector3(0, dev.slotY, -D / 2);
    screenMeshes = [sc];
    if (o.hh) { // where the wrap goes and what it leaves bare
      // the speaker: real holes, so the wrap needs a hole for each (GBA: a round grille; GB: six slots)
      for (const [x, z] of G.holes) {
        const g = portrait ? new THREE.CapsuleGeometry(0.75, 6.5, 4, 10) : new THREE.CylinderGeometry(0.8, 0.8, 0.5, 18);
        const hm = mesh(g, slotM, body, false);
        if (portrait) { hm.rotation.set(0, 1.12, Math.PI / 2); hm.scale.set(0.3, 1, 1); } // a slot lying along (cos −1.12, sin −1.12)
        hm.position.set(x, portrait ? h - 0.1 : h - 0.23, z);
      }
      const F = surfacesOf(o.sys);
      parts.hh = { body: { mesh: parts.body, ...F.body }, cover: { mesh: cover, ...F.cover } };
    }
    screenFrame = { center: new THREE.Vector3(0, h + 0.72, dev.scrZ), normal: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), size: [sw, sh], gap: 0, close: [] };
  }

  // the clear shell shows the board inside (its recipe comes with the souldew+ pack)
  if (look === 'clear') {
    const B = LK.clear.board;
    const [map, mask] = boardTex(fold ? dev.W - 14 : dev.W - 16, fold ? dev.D - 14 : dev.D - 16, B);
    const bm = withPulse(physical(B.material, { map, emissive: new THREE.Color(o.pulse || B.material.emissive || '#ffffff'), emissiveMap: mask, emissiveIntensity: 0 }), P);
    parts.boardM = bm; // opaque (the transmission pass only sees opaque things); hidden as the shell fades
    parts.inner = [];
    const bg = new THREE.BoxGeometry(fold ? dev.W - 14 : dev.W - 16, 1.4, fold ? dev.D - 14 : dev.D - 16);
    const edgeM = new THREE.MeshStandardMaterial({ color: B.edge, roughness: 0.6 });
    const board = new THREE.Mesh(bg, [edgeM, edgeM, bm, bm, edgeM, edgeM]);
    board.position.y = fold ? dev.hb * 0.45 : dev.h * 0.42;
    (fold ? parts.base : body).add(board);
    parts.inner.push(board);
    if (fold) { // and a thinner one in the lid
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(dev.W - 18, 1, dev.D - 16), [edgeM, edgeM, bm, bm, edgeM, edgeM]);
      b2.position.set(0, dev.hl * 0.62, 0);
      parts.lid.add(b2);
      parts.inner.push(b2);
    }
  }

  await pause('build');
  // ---- design/launch5: the wrap (a skin, on moulded plastic only) and the stickers (on any shell) ----
  const HH = { surf: {}, art: null, tex: [], shared: null, skin: null, stickers: [], ghost: null };
  if (o.hh && parts.hh) {
    const skin = look === 'theme' ? o.hh.skin || null : null;
    HH.skin = skin;
    const panels = [];
    for (const [k, R] of Object.entries(parts.hh)) {
      for (const face of ['top', 'bottom']) {
        const g = R[face];
        if (!g || g.of) continue;
        const S = R.slab;
        const pw = Math.ceil((S.w + 2 * g.L) / PX) + 2, ph = Math.ceil((S.d + 2 * g.L) / PX) + 2;
        const base = g.base === 'face' ? Math.round(ph / 2 + S.d / 2 / PX) : Math.round(ph / 2 + (S.d / 2 - S.b) / PX);
        const cx = Math.max(pw / 2, Math.min(384 - pw / 2, (skin?.cx || 200) + g.cxo));
        const word = g.word ? [Math.round(pw / 2 - (S.w / 2 - S.b - Math.min(22, S.r * 0.75)) / PX), Math.round(ph / 2 - (S.d / 2 - S.b - 7) / PX)] : null;
        panels.push({ key: `${k}:${face}`, w: pw, h: ph, cx, base, word });
      }
    }
    const art = skin ? wrapArt(skin, o.hh.recipe, panels, { reduced: !!o.hh.reduced }) : null;
    HH.art = art;
    const tex = (t) => { t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; HH.tex.push(t); return t; };
    const artTex = art ? tex(Object.assign(new THREE.DataTexture(new Uint8Array(art.px.buffer), art.w, art.h, THREE.RGBAFormat), { colorSpace: THREE.SRGBColorSpace }))
      : tex(new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1));
    HH.artTex = artTex;
    const A = o.atlas || EMPTY_ATLAS;
    const stkTex = tex(Object.assign(new THREE.DataTexture(A.rgba, A.w, A.h, THREE.RGBAFormat), { colorSpace: THREE.SRGBColorSpace }));
    const sdfTex = tex(new THREE.DataTexture(A.sdf, A.sw, A.sh, THREE.RedFormat, THREE.UnsignedByteType));
    HH.shared = {
      uArt: { value: artTex }, uArtSz: { value: new THREE.Vector2(art?.w || 1, art?.h || 1) }, uPx: { value: PX }, uWrap: { value: art ? 1 : 0 },
      uFin: { value: skin?.finish === 'gloss' ? new THREE.Vector4(0.16, 1, 0.04, 0) : new THREE.Vector4(0.46, 0.22, 0.36, 0) },
      uBorderC: { value: new THREE.Color(skin?.border || '#000000') }, uKeyV: { value: new THREE.Vector3(0, 1, 0) },
      uStkArt: { value: stkTex }, uStkSdf: { value: sdfTex }, uStkSz: { value: new THREE.Vector2(A.w, A.h) }, uStkRange: { value: A.range },
    };
    if (skin) { // the moulded parts the wrap leaves bare take the art's own colours; the debossed wordmark is under the vinyl
      keyM.color.set(skin.keys);
      darkM.color.set(skin.dark);
      if (parts.wm) parts.wm.visible = false;
    }
    for (const [k, R] of Object.entries(parts.hh)) {
      const regionOf = (face) => {
        const g = R[face];
        if (!g) return null;
        const src = g.of ? `${g.of}:${face}` : `${k}:${face}`;
        const rc = art?.rects[src];
        const [sx, sy] = g.view;
        const cx = rc ? rc.x + rc.w / 2 : 0, cy = rc ? rc.y + rc.h / 2 : 0;
        return { ...g, art: [sx, sy, cx, cy + (g.of ? (sy * (R.z || 0)) / PX : 0)] };
      };
      const spec = { slab: R.slab, top: regionOf('top'), bottom: regionOf('bottom') };
      const tone = k === 'base' ? -1 : 0;
      let m;
      if (k === 'cover' && !skin) m = fadeable(withPulse(new THREE.MeshPhysicalMaterial({ color: darkM.color.clone(), roughness: 0.55, clearcoat: 0.3 }), P));
      else m = mkShell(tone, skin ? new THREE.Color(skin.plastic) : shellColor);
      withSurface(THREE, m, spec, HH.shared, LK?.finishes || null);
      R.mesh.material = m;
      HH.surf[k] = { mesh: R.mesh, slab: R.slab, spec, U: m.userData.hh.U };
    }
  }
  /** stickers: [{ id, finish: vinyl|holo|glitter, region: 'lid:top', U: [x, y] (mm), rot (rad), scale }]; ghost = one more,
      drawn see-through (ok) or red (refused); sel = the index of the selected one */
  function setStickers(list = [], ghost = null, sel = -1) {
    HH.stickers = list;
    HH.ghost = ghost;
    if (!HH.shared) return;
    const A = o.atlas || EMPTY_ATLAS;
    const all = [...list.map((x, i) => ({ ...x, state: i === sel ? 3 : 0 })), ...(ghost ? [{ ...ghost, state: ghost.ok ? 1 : 2 }] : [])];
    for (const [k, S] of Object.entries(HH.surf)) {
      let n = 0;
      for (const st of all) {
        const [sk, face] = st.region.split(':');
        if (sk !== k || n >= NSTK) continue;
        const rc = A.rects[st.id];
        if (!rc) continue;
        S.U.uStk.value[n].set(st.U[0], st.U[1], Math.cos(st.rot || 0), Math.sin(st.rot || 0));
        S.U.uStkR.value[n].set(rc.x, rc.y, rc.w, rc.h);
        S.U.uStkF.value[n].set(face === 'top' ? 0 : 1, finishIndex(st.finish, LK), PX * (st.scale || 1), st.state);
        n++;
      }
      S.U.uNStk.value = n;
    }
  }
  setStickers(o.hh?.stickers || []);

  await pause('wrap');
  // ---- the cartridge ----
  const cartDims = fold ? dev.card : dev.cart;
  const [cw, cl, ct] = cartDims;
  const cartM = (look === 'clear' ? (m) => m : fadeable)(withPulse(cartLook === 'gold'
    ? physical(LK.gold.cart)
    : new THREE.MeshPhysicalMaterial({ color: new THREE.Color(o.cartColor || '#4a4954'), roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.3 }), P));
  const cart = new THREE.Group(); // the moving cart (rotates about its insertion end)
  cartHome.add(cart);
  const cartBody = mesh(slabGeo(cw, cl, ct, fold ? 2.4 : 3.2, 0.9), cartM, cart);
  cartBody.castShadow = false; // (its shadow on the far table reads as a smudge in the air)
  cartBody.position.y = -ct / 2;
  // grip ridges at the outer end
  for (let k = 0; k < (fold ? 0 : 5); k++) {
    const rg = mesh(new THREE.BoxGeometry(cw - 16, 0.5, 0.9), cartM, cart, false);
    rg.position.set(0, -ct / 2 - 0.15, -cl / 2 + 3 + k * 1.8);
  }
  // the label: towards the screen side for the card (−y in lid space = towards the camera), the back for the cart (−y)
  const labelW = cw - (fold ? 5 : 9), labelH = fold ? cl - 9 : cl * 0.62;
  const FOIL = { uFoil: { value: 0 }, uFoilA: { value: 0 } };
  const labelM = cartLook === 'holo'
    ? physical(LK.holo.label, { iridescenceThicknessMap: foilTex(LK.holo.foil) })
    : new THREE.MeshPhysicalMaterial({ roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  if (cartLook === 'holo') {
    labelM.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, FOIL);
      sh.fragmentShader = `uniform float uFoil, uFoilA;\n${sh.fragmentShader.replace('#include <opaque_fragment>', `
  #ifdef USE_MAP
  vec2 fu = vMapUv;
  #else
  vec2 fu = vec2(0.0);
  #endif
${LK.holo.glsl}
  #include <opaque_fragment>`)}`;
    };
    labelM.customProgramCacheKey = () => `foil:${LK.holo.glsl.length}:${LK.holo.glsl.slice(0, 40)}`;
  }
  if (look !== 'clear') fadeable(labelM);
  const label = mesh(plane(labelW, labelH, 'down'), labelM, cart, false);
  label.position.set(0, -ct / 2 - 0.06, fold ? 2.2 : cl * 0.08);
  if (!fold) label.rotation.y = Math.PI; // upright from behind when standing
  // the cart's label art: the cover, loaded once
  const cover = await new Promise((res) => {
    if (!o.cover) return res(null);
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = o.cover;
  });
  labelM.map = labelTex(cover, o.title || '', labelW / labelH, o.cartColor || '#4a4954');
  labelM.map.anisotropy = 8;
  labelM.needsUpdate = true;

  // ---- the device in the world ----
  const standing = !fold;
  if (standing) root.rotation.x = Math.PI / 2; // face → +z (front), top edge → +y
  root.updateMatrixWorld(true);

  // floor: a shadow catcher and a contact shadow (both fade with the shell)
  const floorY = standing ? -dev.D / 2 - 9 : 0;
  // the table only shows the device's own shadow, fading out round it (a studio floor, no far smudges)
  const floorM = new THREE.ShadowMaterial({ color: 0x000000, opacity: o.dark ? 0.42 : 0.2, transparent: true, depthWrite: false });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(fold ? 330 : 330, fold ? 330 : 330), floorM);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, floorY - 0.02, fold ? -25 : 6);
  floor.receiveShadow = true;
  world.add(floor);
  const blobM = new THREE.MeshBasicMaterial({ color: '#000', alphaMap: blobTex(), transparent: true, opacity: o.dark ? 0.5 : 0.28, depthWrite: false });
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blobM);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = floorY + 0.05;
  blob.scale.set(fold ? dev.W * 1.15 : dev.W * 1.0, fold ? dev.D * 1.2 : dev.h * 2.6, 1);
  world.add(blob);

  // lights: a soft key from the upper left front, a rim from behind, the screens' own light
  const key = new THREE.DirectionalLight(0xffffff, 2.7);
  key.position.set(-120, 420, 170);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -320, right: 320, top: 320, bottom: -320, near: 50, far: 1400 });
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.4;
  key.shadow.radius = 14;
  key.shadow.blurSamples = 20;
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  scene.add(key.target);
  const rim = new THREE.DirectionalLight(new THREE.Color('#ffffff').lerp(shellColor, 0.15), 1.3);
  rim.position.set(220, 180, -320);
  scene.add(rim);
  const back = new THREE.DirectionalLight(0xffffff, standing ? 0.9 : 0.2); // lights the back face while the camera is behind
  back.position.set(-120, 160, -260);
  scene.add(back);
  const scrLight = new THREE.PointLight(new THREE.Color(o.glow || '#dfe9ff'), 0, 320, 1.6);
  scene.add(scrLight);
  const latchLight = new THREE.PointLight(new THREE.Color(o.pulse || '#fff4e0'), 0, 200, 1.8);
  scene.add(latchLight);

  // a black backing behind the final screen rectangle (what the play view shows around a narrower bottom screen)
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backM);
  backing.rotation.x = -Math.PI / 2;
  body.add(backing);
  backing.renderOrder = 2;
  for (const s of screenMeshes) s.renderOrder = 3;

  // ---- the plan: everything as a function of t ----
  const plan = o.plan;
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const finalQ = new THREE.Quaternion();
  const worldOf = (obj, v) => obj.localToWorld(v.clone());

  /** the final camera: looking straight at the play view's screen rectangle, which maps exactly onto o.final */
  function finalCamera() {
    // in the device's resting pose (how it ends), not the pose of whatever moment asked first
    const bp = body.position.clone(), br = body.rotation.clone();
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);
    try {
      return finalCameraAtRest();
    } finally {
      body.position.copy(bp);
      body.rotation.copy(br);
      root.updateMatrixWorld(true);
    }
  }
  function finalCameraAtRest() {
    root.updateMatrixWorld(true);
    const m = new THREE.Matrix3().setFromMatrix4(body.matrixWorld);
    const C = worldOf(body, screenFrame.center);
    const N = screenFrame.normal.clone().applyMatrix3(m).normalize();
    const U = screenFrame.up.clone().applyMatrix3(m).normalize();
    const R = new THREE.Vector3().crossVectors(U, N).normalize();
    const [, hw] = screenFrame.size; // world height of the final picture
    const f = o.final; // px in the canvas
    const tanH = Math.tan((cam.fov * D2R) / 2);
    const d = (hw / 2 / tanH) * (o.h / f.h);
    const mmPerPx = hw / f.h;
    const dx = (f.x + f.w / 2 - o.w / 2) * mmPerPx;
    const dy = (f.y + f.h / 2 - o.h / 2) * mmPerPx;
    const T = C.clone().addScaledVector(R, -dx).addScaledVector(U, dy);
    const basis = new THREE.Matrix4().makeBasis(R, U, N);
    finalQ.setFromRotationMatrix(basis);
    return { C, N, U, R, d, T };
  }

  let FC = null;
  function apply(t) {
    const s = plan(t);
    // device
    body.position.set(0, s.bodyY || 0, s.bodyZ || 0);
    body.rotation.set(s.bodyPitch || 0, 0, s.bodyRoll || 0);
    if (fold) {
      lidPivot.rotation.x = -s.lid * D2R;
      parts.base.rotation.x = 0;
    }
    // the cart: s.cart = distance out of its home along the insertion axis (mm), s.cartTilt / s.cartTwist (deg)
    cart.position.set(0, 0, (fold ? 1 : -1) * (s.cart || 0));
    cart.rotation.set((s.cartTilt || 0) * D2R, (s.cartYaw || 0) * D2R, (s.cartTwist || 0) * D2R);
    FOIL.uFoil.value = (s.cart || 0) * 0.012 + (s.cartTilt || 0) * 0.03 + t * 0.00025;
    FOIL.uFoilA.value = 1;
    cart.visible = s.cart < 400 && !(look === 'clear' && (s.fade || 0) > 0.35);
    for (const x of parts.inner || []) x.visible = (s.fade || 0) < 0.35;
    // the two screens glide into the play view's layout at the end (over the black backing)
    if (screenFrame.finals) {
      const k = s.close || 0;
      body.updateMatrixWorld(true);
      screenMeshes.forEach((m, i) => {
        const f = screenFrame.finals[i];
        m.position.copy(screenFrame.home[i]);
        m.scale.setScalar(1);
        if (!f) { m.visible = k < 0.5; return; }
        m.visible = true;
        if (k <= 0) return;
        m.parent.updateMatrixWorld(true);
        const from = m.parent.localToWorld(screenFrame.home[i].clone());
        const to = body.localToWorld(f.pos.clone());
        m.position.copy(m.parent.worldToLocal(from.lerp(to, k)));
        m.scale.setScalar(lerp(1, f.scale, k));
      });
    }
    // materials: the shell fades at the very end; the pulse; the screens; the LED
    for (const m of fadeMats) {
      m.opacity = m.userData.o * (1 - (s.fade || 0));
      m.depthWrite = m.userData.dw ?? ((s.fade || 0) < 0.5); // a faded shell must not hide the screens gliding over it
    }
    for (const m of scrMats) m.depthTest = !((s.close || 0) > 0.001 || (s.fade || 0) > 0.5);
    floorM.opacity = (o.dark ? 0.42 : 0.2) * (1 - (s.fade || 0)) * (s.shadow ?? 1);
    blobM.opacity = (o.dark ? 0.5 : 0.28) * (1 - (s.fade || 0)) * (s.shadow ?? 1);
    backM.opacity = s.backing || 0;
    P.uPR.value = s.pulseR || 0;
    P.uPA.value = s.pulseA || 0;
    P.uPW.value = s.pulseW || 9;
    if (parts.boardM) parts.boardM.emissiveIntensity = s.board || 0;
    let light = 0;
    scrMats.forEach((m, i) => {
      const u = screenState(t, s.power[i] ?? s.power[0]);
      for (const k of ['uBack', 'uGlow', 'uDraw', 'uWash', 'uGrid', 'uBloom']) m.uniforms[k].value = u[k];
      m.uniforms.uClean.value = s.clean || 0;
      light = Math.max(light, u.light);
    });
    ledM.color.set(dev.led).multiplyScalar(0.12 + 0.95 * (s.led || 0));
    glareM.opacity = 0.55 * (s.led || 0) * (1 - (s.fade || 0)) * (1 - 0.85 * (s.glassOff || 0));
    // glass reflections fade as the camera pushes in (the play view has no glass)
    glassM.envMapIntensity = 0.6 * (1 - (s.glassOff || 0));
    glassM.clearcoat = 0.35 * (1 - (s.glassOff || 0));
    // the screen's own light on the plastic and the room
    root.updateMatrixWorld(true);
    const sc = worldOf(screenMeshes[0], new THREE.Vector3(0, 0, 0));
    const n = new THREE.Vector3(0, fold ? -1 : 1, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(screenMeshes[0].matrixWorld)).normalize();
    scrLight.position.copy(sc).addScaledVector(n, 140);
    scrLight.intensity = 0; // (the screens' light is the shader term below: no hot spot on the glass)
    P.uGO.value.copy(fold ? worldOf(parts.base, new THREE.Vector3(0, dev.hb, -dev.D / 2)) : sc);
    P.uGR.value = fold ? 70 : 62;
    P.uGA.value = light * 0.75 * (1 - (s.fade || 0)) * (1 - 0.7 * (s.glassOff || 0));
    P.uPO.value.copy(worldOf(cartHome.parent, slotLocal));
    latchLight.position.copy(P.uPO.value).add(new THREE.Vector3(0, 12, 14));
    latchLight.intensity = (s.flash || 0) * 700;
    scene.environmentIntensity = 0.62 * (1 - 0.6 * (s.fade || 0));
    // camera
    if (!FC) FC = finalCamera();
    const c = s.cam;
    // orientation relative to the final one: q = finalQ · A(yaw, tilt) (fold: orbit about the table's normal)
    const q = finalQ.clone();
    if (fold) q.multiply(tmpQ.setFromEuler(new THREE.Euler(c.tilt * D2R, 0, c.yaw * D2R, 'ZXY')));
    else q.multiply(tmpQ.setFromEuler(new THREE.Euler(-c.tilt * D2R, c.yaw * D2R, 0, 'YXZ')));
    q.multiply(tmpQ.setFromEuler(new THREE.Euler((c.dp || 0) * D2R, (c.dy || 0) * D2R, (c.roll || 0) * D2R, 'XYZ')));
    const target = c.target === 'final' ? FC.T.clone() : (c.target.isVector3 ? c.target.clone() : new THREE.Vector3(...c.target));
    if (c.toFinal) target.lerp(FC.T, c.toFinal);
    const dist = c.dist === 'final' ? FC.d : lerp(c.dist, FC.d, c.distK || 0);
    cam.quaternion.copy(q);
    cam.position.copy(target).add(tmpV.set(0, 0, 1).applyQuaternion(q).multiplyScalar(dist));
    cam.updateMatrixWorld(true);
    key.target.position.copy(target);
    if (HH.shared) HH.shared.uKeyV.value.copy(key.position).sub(key.target.position).normalize().transformDirection(cam.matrixWorldInverse);
    return s;
  }

  let renders = 0;
  function render(t) {
    const s = apply(t);
    if (HH.art?.animated && HH.art.update(t / 1000)) HH.artTex.needsUpdate = true; // the wrap's own life (10 fps)
    if (!live && findLive && (renders++ % 6 === 0)) { // the game's page is there now: its own picture from here on
      const c = findLive();
      if (c) {
        live = c;
        const old = ptex;
        ptex = liveTex(c);
        for (const m of scrMats) m.uniforms.map.value = ptex;
        old.dispose();
      }
    }
    if (live && live.width) {
      if (live.width !== ptex.userData.w || live.height !== ptex.userData.h) { // the player resized its canvas: new storage
        const old = ptex;
        ptex = liveTex(live);
        for (const m of scrMats) m.uniforms.map.value = ptex;
        old.dispose();
      }
      ptex.needsUpdate = true; // the game's own picture, as it is now
    }
    renderer.render(scene, cam);
    canvas.style.opacity = String(s.canvasO ?? 1);
    return s;
  }

  /** where a point (in the slot / screen frames) is on the canvas at time t – for the DOM light layers */
  function project(t, what) {
    apply(t);
    const p = what === 'slot' ? P.uPO.value.clone() : worldOf(screenMeshes[what === 'screen2' ? 1 : 0] || screenMeshes[0], new THREE.Vector3());
    p.project(cam);
    return [((p.x + 1) / 2) * o.w, ((1 - p.y) / 2) * o.h];
  }
  /** where the device's screens are on the canvas at time t: { x, y, w, h } round all of them (the match-cut's check) */
  function screensAt(t) {
    apply(t);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const m of screenMeshes) {
      if (!m.visible) continue;
      m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      for (const cx of [bb.min.x, bb.max.x]) for (const cz of [bb.min.z, bb.max.z]) {
        const p = m.localToWorld(new THREE.Vector3(cx, 0, cz)).project(cam);
        const X = ((p.x + 1) / 2) * o.w, Y = ((1 - p.y) / 2) * o.h;
        x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** the device's size on the canvas at time t (px per mm at the screen) */
  function scaleAt(t) {
    apply(t);
    const a = worldOf(screenMeshes[0], new THREE.Vector3(-10, 0, 0)).project(cam);
    const b = worldOf(screenMeshes[0], new THREE.Vector3(10, 0, 0)).project(cam);
    return (Math.hypot((b.x - a.x) * o.w, (b.y - a.y) * o.h) / 2) / 20;
  }

  /** points on the shell's edges and the cart's corners (canvas px at time t) where glints sit */
  function anchors(t) {
    apply(t);
    const pts = [];
    const add = (obj, x, y, z) => { const p = obj.localToWorld(new THREE.Vector3(x, y, z)).project(cam); pts.push([((p.x + 1) / 2) * o.w, ((1 - p.y) / 2) * o.h]); };
    add(cart, cw / 2 - 1, 0, (fold ? 1 : -1) * (cl / 2 - 1));
    if (fold) {
      const { W, D, hl, hb } = dev;
      add(parts.lid, -W / 2 + 3, hl, D / 2 - 2); add(parts.lid, W / 2 - 3, hl / 2, D / 2 - 6); add(parts.lid, -W / 2, hl / 2, -D / 4);
      add(parts.base, W / 2 - 2, hb, D / 2 - 4); add(parts.base, -W / 2 + 6, hb, D / 2); add(parts.base, W / 2, hb / 2, -D / 4);
    } else {
      const { W, D, h } = dev;
      add(body, -W / 2 + 10, h, -D / 2 + 4); add(body, W / 2 - 6, h / 2, -D / 2 + 10); add(body, W / 2, 0, D / 4);
      add(body, -W / 2 + 4, 0, D / 2 - 12); add(body, 0, 0, D / 2); add(body, -W / 2, h / 2, 0);
    }
    return pts;
  }

  // every program now, not on the frame a part first shows (the cartridge drops in later: compiling it then is a hitch)
  {
    await pause('world');
    const hidden = [];
    scene.traverse((x) => { if (!x.visible) { hidden.push(x); x.visible = true; } });
    // in parallel where the driver can (KHR_parallel_shader_compile): the main thread stays free meanwhile
    if (o.yieldTo && renderer.compileAsync) await renderer.compileAsync(scene, cam);
    else renderer.compile(scene, cam);
    for (const x of hidden) x.visible = false;
    o.mark?.('compiled');
  }
  // the backing's size and place (final rectangle, in body coordinates)
  {
    const [w, h] = screenFrame.size;
    backing.scale.set(w, h, 1);
    backing.position.copy(screenFrame.center).addScaledVector(screenFrame.normal, -0.05);
    if (fold) { backing.position.y = dev.hb + 0.5; }
  }
  // ---- design/launch5: picking on the shell (the profile editor's sticker placement) ----
  const ray = new THREE.Raycaster();
  /** canvas px → { key: 'lid:top', surf, face, U, beyond } on a wrappable face, { blocked } on anything else, or null */
  function pick(x, y) {
    root.updateMatrixWorld(true);
    ray.setFromCamera(new THREE.Vector2((x / o.w) * 2 - 1, -(y / o.h) * 2 + 1), cam);
    const cands = [];
    root.traverseVisible((m) => { if (m.isMesh && !m.userData.nopick && m !== backing) cands.push(m); });
    const hit = ray.intersectObjects(cands, false)[0];
    if (!hit) return null;
    const ent = Object.entries(HH.surf).find(([, S]) => S.mesh === hit.object);
    if (!ent) return { blocked: true };
    const [k, S] = ent;
    const lp = hit.object.worldToLocal(hit.point.clone());
    const u = unfold(S.slab, [lp.x, lp.y, lp.z]);
    if (!S.spec[u.face]) return { blocked: true };
    return { key: `${k}:${u.face}`, surf: k, face: u.face, U: u.U, beyond: u.beyond };
  }
  /** a point in a region's unfolded mm → canvas px (on the flat face; past the edge it is clamped to it) */
  function uToScreen(key, U) {
    const [k, face] = key.split(':');
    const S = HH.surf[k];
    if (!S) return null;
    root.updateMatrixWorld(true);
    const hx = S.slab.w / 2 - S.slab.b, hz = S.slab.d / 2 - S.slab.b;
    const p = new THREE.Vector3(Math.max(-hx, Math.min(hx, U[0])), face === 'top' ? S.slab.h : 0, Math.max(-hz, Math.min(hz, U[1])));
    const w = S.mesh.localToWorld(p).project(cam);
    return [((w.x + 1) / 2) * o.w, ((1 - w.y) / 2) * o.h, w.z];
  }
  const regions = () => Object.fromEntries(Object.entries(HH.surf).flatMap(([k, S]) => ['top', 'bottom'].filter((f) => S.spec[f]).map((f) => [`${k}:${f}`, { slab: S.slab, region: S.spec[f] }])));

  return {
    render, project, scaleAt, anchors, screensAt, renderer, debug: { scene, cart, parts, key, HH, cam, apply },
    pick, uToScreen, regions, setStickers, hh: HH,
    resize(w, h) { o.w = w; o.h = h; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); FC = null; }, // (the editor's stage)
    /** the play view's screen rectangle moved (its layout settled while the animation ran): the match-cut follows it */
    setFinal(f) { o.final = f; FC = null; },
    dispose() { // free the GPU at once (a launch must leave nothing behind: no context, no textures, no programs)
      scene.traverse((x) => {
        x.geometry?.dispose?.();
        for (const m of [x.material].flat().filter(Boolean)) {
          for (const k of ['map', 'alphaMap', 'normalMap', 'emissiveMap', 'iridescenceThicknessMap']) if (m[k] && m[k] !== GRAIN) m[k].dispose();
          m.dispose();
        }
      });
      for (const t of HH.tex) t.dispose();
      scene.environment?.dispose();
      pmrem.dispose();
      ptex.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The choreographies. Each returns { T, L (latch), power: [ms per screen], plan(t) → state }.

/**
 * design/launch6: how long the device is on stage. Round 4/5 ran 2.1 s (full) and 1.15 s (Quick); round 6 gives the
 * dressed device more time without slowing a beat: `pre` ms more before the first beat (the closed DS / the GBA's back,
 * where the stickers are), `mid` ms of a slow orbit once the screens are on, before the dive. The open/insert beats keep
 * their pace. pace=r5 (old) | mid (≈ 2.5 s) | r6 (≈ 2.9 s, the proposal).
 */
export const PACES = {
  r5: { fold: { pre: 0, mid: 0 }, turn: { pre: 0, mid: 0 }, quick: 0 },
  mid: { fold: { pre: 120, mid: 250 }, turn: { pre: 100, mid: 280 }, quick: 130 },
  r6: { fold: { pre: 260, mid: 490 }, turn: { pre: 220, mid: 530 }, quick: 250 },
};

/** DS / 3DS – full: unfold, card, pulse, power on, crane over the top while the hinge lays flat, into the screens */
export function foldPlan(quick, dev, pace = PACES.r5) {
  const OPEN = 152; // the natural opening angle (deg)
  const pre = quick ? 0 : pace.fold.pre, mid = quick ? pace.quick : pace.fold.mid;
  const L = quick ? 250 : 900 + pre; // the latch
  const b0 = quick ? 300 : L + 70; // the top screen's backlight; the bottom one 80 ms later
  const R0 = quick ? 420 : 1180 + pre; // the rise and orbit end (round 5's push started here)
  const P0 = R0 + mid; // the push starts
  const P1 = P0 + (quick ? 600 : 810); // the camera arrives
  const T = P1 + (quick ? 130 : 170);
  const H0 = P1 - 30; // hand-over to the play view
  const lidAt0 = (t) => {
    if (quick) return OPEN;
    if (t < 190) return 0;
    const pop = 5 * EASE.out(seg(t, 190, 235)) - 1.6 * EASE.soft(seg(t, 235, 260));
    if (t < 260) return pop;
    // a weighted swing: it gathers speed, carries past the detent (+9°), falls back and settles (damped)
    if (t < 640) return lerp(3.4, OPEN + 9, SWING(seg(t, 260, 640)));
    const tau = (t - 640) / 1000;
    return OPEN + 9 * Math.exp(-7.5 * tau) * Math.cos(2 * Math.PI * 2.6 * tau);
  };
  const lidAt = (t) => lidAt0(t - pre); // the lid's beats come `pre` later; the camera is already moving
  // the hold: once the rise has settled, a slow arc round the open device (it carries on into the push)
  const hold = (t) => (mid ? EASE.io(seg(t, quick ? 0 : R0 - 120, P0 + 160)) : 0);
  return {
    T, L, power: [b0, b0 + 80], H0,
    plan(t) {
      let lid = lidAt(t);
      lid += 2.6 * knock(t - L, 7, 0.32); // the card's knock pushes the lid back
      lid += (180 - OPEN) * EASE.io(seg(t, P0 + 80, P1 - 60)); // lays flat while the camera cranes over
      // the device's reaction to the lid's swing (front lifts a hair when the lid's momentum stops)
      const acc = quick ? 0 : (lidAt(t + 16) - 2 * lidAt(t) + lidAt(t - 16)) / (16 * 16);
      const bodyPitch = -Math.max(-0.012, Math.min(0.02, -acc * 0.9)) * 0.5;
      // the card: out along the lid's axis → falls → slides home → latches (overshoot 0.7 mm) → settles
      const cart = quick
        ? track(t, [[0, 70, 'in'], [180, 16, 'lin'], [L - 8, -0.7, 'out'], [L + 60, 0]])
        : track(t, [[0, 400], [650 + pre, 400], [651 + pre, 96, 'in'], [830 + pre, 20, 'lin'], [L - 8, -0.7, 'out'], [L + 70, 0]]);
      const cartTilt = quick ? track(t, [[0, -10, 'out'], [180, 0]]) : track(t, [[650 + pre, -12, 'out'], [830 + pre, 0]]);
      const cartTwist = quick ? track(t, [[0, 5, 'out'], [180, 0]]) : track(t, [[650 + pre, 6, 'out'], [830 + pre, 0]]);
      // the camera: low on the table → rises and orbits as the lid opens → (the hold: a slow arc) → cranes over the top
      const k1 = quick ? 1 : EASE.out(seg(t, 0, R0));
      const kh = hold(t);
      const kp = EASE.push(seg(t, P0, P1));
      const tilt = quick ? lerp(58 - 5 * kh, 0, kp) : lerp(lerp(77, 57, k1) - 7 * kh, 0, kp);
      const yaw = quick ? lerp(-15 + 7 * kh, 0, kp) : lerp(lerp(-30, -15, k1) + 12 * kh, 0, kp);
      const dist0 = quick ? 370 - 8 * kh : lerp(400, 365, k1) - 12 * kh;
      const amp = (quick ? 0.35 : 1) * (1 - seg(t, 0, P1 - 200)) * (1 - kp);
      const lidOpen = quick ? 1 : clamp01((lidAt(t) - 3) / (OPEN - 3));
      const tgt = [0, lerp(9, 26, lidOpen), lerp(0, -32, lidOpen)];
      const kn = knock(t - L, 9, 0.4);
      return {
        lid, bodyPitch, bodyY: -0.8 * kn,
        cart, cartTilt, cartTwist,
        cam: { tilt, yaw, dist: dist0, distK: kp, target: tgt, toFinal: kp, dp: drift(t, 1) * 0.5 * amp + kn * 0.25, dy: drift(t, 7) * 0.5 * amp, roll: drift(t, 3) * 0.35 * amp },
        power: [b0, b0 + 80],
        pulseR: seg(t, L, L + 520) * 260, pulseA: (1 - seg(t, L + 120, L + 560)) * (t >= L ? 3.4 : 0) * EASE.out(seg(t, L, L + 40)), pulseW: 4.5,
        board: track(t, [[0, 0], [L, 0, 'out'], [L + 140, 2.2, 'soft'], [L + 700, 0.35], [P1 - 100, 0.35, 'lin'], [P1, 0]]),
        flash: track(t, [[0, 0], [L, 0, 'out'], [L + 30, 1, 'soft'], [L + 320, 0]]),
        led: track(t, [[0, 0], [L + 20, 0], [L + 32, 0.7], [L + 60, 0.2], [L + 95, 1], [L + 140, 0.75, 'out'], [L + 220, 1]]),
        close: EASE.io(seg(t, P1 - 250, P1 - 70)),
        backing: EASE.io(seg(t, P1 - 200, P1 - 70)),
        fade: EASE.soft(seg(t, P1 - 250, P1 - 60)),
        glassOff: EASE.io(seg(t, P0 + 40, P0 + 520)),
        clean: EASE.io(seg(t, P1 - 200, P1 - 20)),
        shadow: 1,
        canvasO: EASE.out(seg(t, 0, quick ? 90 : 160)),
      };
    },
  };
}

/** GBA / GB – full: rises seen from behind, the cart drops into the back slot, orbits round to the front, into the screen */
export function turnPlan(quick, dev, pace = PACES.r5) {
  const pre = quick ? 0 : pace.turn.pre, mid = quick ? pace.quick : pace.turn.mid;
  const L = quick ? 250 : 650 + pre;
  const b0 = quick ? 320 : 980 + pre;
  const P0 = (quick ? 380 : 1250 + pre) + mid;
  const P1 = P0 + (quick ? 640 : 710);
  const T = P1 + (quick ? 130 : 140);
  const X = quick ? 0 : pre; // the cart's beats come `pre` later: a longer look at the dressed back first
  return {
    T, L, power: [b0], H0: P1 - 30,
    plan(t) {
      // the rise: lying back 34°, 14 mm low → upright with a spring
      const rise = quick ? 1 : spring(t - 40, 1.7, 0.62);
      const kn = knock(t - L, 9, 0.38);
      const bodyPitch = (1 - rise) * (-34 * D2R); // standing frame: rotation about x tips the top backwards
      const bodyZ = (1 - rise) * 14; // (in device space +z = down when standing)
      const [, cl] = dev.cart;
      const out = cl * (1 - dev.cart[3]);
      const cart = quick
        ? track(t, [[0, out + 60, 'in'], [L - 50, out, 'lin'], [L - 8, -0.8, 'out'], [L + 60, 0]])
        : track(t, [[0, 400], [380 + X, 400], [381 + X, out + 95, 'in'], [L - 60, out, 'lin'], [L - 8, -0.9, 'out'], [L + 70, 0]]);
      const cartTilt = quick ? track(t, [[0, 8, 'out'], [L - 50, 0]]) : track(t, [[380 + X, 9, 'out'], [L - 60, 0]]);
      const cartTwist = quick ? track(t, [[0, -4, 'out'], [L - 50, 0]]) : track(t, [[380 + X, -5, 'out'], [L - 60, 0]]);
      // the camera: behind, low → orbits round to the front (slow start, the latch, then a long sweep) → pushes in.
      // Round 6: the sweep is longer (slower past the side, longer on the dressed front); Quick drifts while it waits.
      const qh = mid ? EASE.io(seg(t, 0, P0)) : 0;
      const yaw = quick ? lerp(30 + 9 * (1 - qh), 0, EASE.push(seg(t, P0 - 120, P1 - 120))) : track(t, [[0, 156, 'out'], [L, 138, 'io'], [P1 - 120, 0]]);
      const tilt = quick ? lerp(14 + 3 * (1 - qh), 0, EASE.push(seg(t, P0, P1))) : track(t, [[0, 22, 'out'], [L, 16, 'io'], [P1 - 80, 0]]);
      const kp = EASE.push(seg(t, P0, P1));
      const amp = (quick ? 0.35 : 1) * (1 - kp);
      return {
        bodyPitch, bodyZ: bodyZ + 0.9 * kn, lid: 0,
        cart, cartTilt, cartTwist,
        cam: { tilt, yaw, dist: quick ? 370 : 395, distK: kp, target: [0, quick ? 6 : 10, 11], toFinal: kp, dp: drift(t, 2) * 0.5 * amp + kn * 0.3, dy: drift(t, 5) * 0.45 * amp, roll: drift(t, 9) * 0.3 * amp },
        power: [b0],
        pulseR: seg(t, L, L + 480) * 230, pulseA: (1 - seg(t, L + 110, L + 520)) * (t >= L ? 1.6 : 0) * EASE.out(seg(t, L, L + 40)), pulseW: 4.5,
        board: track(t, [[0, 0], [L, 0, 'out'], [L + 140, 2.2, 'soft'], [L + 700, 0.35], [P1 - 100, 0.35, 'lin'], [P1, 0]]),
        flash: track(t, [[0, 0], [L, 0, 'out'], [L + 30, 1, 'soft'], [L + 320, 0]]),
        led: track(t, [[0, 0], [L + 20, 0], [L + 32, 0.7], [L + 60, 0.2], [L + 95, 1], [L + 140, 0.75, 'out'], [L + 220, 1]]),
        fade: EASE.soft(seg(t, P1 - 250, P1 - 60)),
        backing: 0,
        glassOff: EASE.io(seg(t, P0 + 60, P0 + 560)),
        clean: EASE.io(seg(t, P1 - 200, P1 - 20)),
        shadow: 1,
        canvasO: EASE.out(seg(t, 0, quick ? 90 : 160)),
      };
    },
  };
}

/** reduced motion: one still – the device open, the cart home, the screens on – that cross-fades into the game */
export function stillPlan(dev, fold) {
  return {
    T: 800, L: -1000, power: [-2000, -2000], H0: 450,
    plan() {
      return fold
        ? { lid: 152, cart: 0, cam: { tilt: 50, yaw: -12, dist: 410, target: [0, 26, -32] }, power: [-2000, -2000], led: 1, shadow: 1, clean: 1 }
        : { lid: 0, cart: 0, cam: { tilt: 10, yaw: 22, dist: 400, target: [0, 6, 11] }, power: [-2000], led: 1, shadow: 1, clean: 1 };
    },
  };
}
