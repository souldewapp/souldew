// The 3DS player (player3ds.html): the game runs in souldew's native host (server/lib/ctr.mjs, native/ctr-host) and
// arrives here as a stream of pictures, sound and memory; input, speed and save states go back. It offers the Play
// view the same window.__emu as player.html (EmulatorJS) – save states, speed, screenshots, the partner's mini view
// and the live reader work the same way. 3DS saves aren't one battery file: they live in the host's save folder of the
// game / run slot (server side), so getSave() has nothing to hand over.
import * as controls from '/lib/controls.mjs';
import { setLang, guessLang, t } from '/lib/i18n.mjs';
import { serverErrorText } from '/lib/errors.mjs';
import { findEntry, regionsFor } from '/shared/live/parse.mjs';

const q = new URLSearchParams(location.search);
const MSG = { VIDEO: 2, AUDIO: 3, MEM: 4, STATE: 5, LOG: 6, EVENT: 7 };
const CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, WATCH: 5, QUIT: 6, RESET: 7, FRAMESKIP: 8 };
const post = (m) => window.parent?.postMessage(m, location.origin);

const st = {
  id: null, ready: false, paused: false, speed: 1, volume: 1, frames: 0, fps: 0, title: null, width: 400, height: 480,
  mem: [], watching: '', liveMemory: false, error: null, log: [],
};
const waiters = { state: [], loaded: [] };

// ---- commands -----------------------------------------------------------------------------------------------------
let chain = Promise.resolve();
function cmd(type, payload = new Uint8Array(0)) {
  const b = new Uint8Array(8 + payload.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  v.setUint32(4, payload.length, true);
  b.set(payload, 8);
  // one after another: the host must see input in the order it happened. Resolves false when the server refused it
  // (it never reached the host – nothing will answer), else true.
  const sent = chain.then(() => (st.id ? fetch(`/api/ctr/cmd?id=${st.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: b }).then((r) => r.ok) : false))
    .catch(() => true); // (no answer at all: the server is gone – the stream's end answers what waits)
  chain = sent;
  return sent;
}
/** Wait for the host's answer to a command; `fallback` when the command never reached it. */
function ask(list, type, payload, fallback, map = (x) => x) {
  return new Promise((res) => {
    const w = (x) => res(map(x));
    list.push(w);
    cmd(type, payload).then((ok) => {
      if (ok) return;
      const i = list.indexOf(w);
      if (i >= 0) list.splice(i, 1);
      res(fallback);
    });
  });
}
const f32 = (x) => new Uint8Array(new Float32Array([x]).buffer);
const u32 = (x) => new Uint8Array(new Uint32Array([x]).buffer);

// ---- picture (WebGL: the host sends BGRA or RGBA rows, top row first) -------------------------------------------
const canvas = document.getElementById('screen');
const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
let tex = null;
let swizzleLoc = null;
function initGl() {
  const vs = '#version 300 es\nin vec2 p;out vec2 uv;void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}';
  const fs = '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D t;uniform bool bgra;out vec4 o;void main(){vec4 c=texture(t,uv);o=vec4(bgra?c.bgr:c.rgb,1.);}';
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  swizzleLoc = gl.getUniformLocation(prog, 'bgra');
}
if (gl) initGl();

let pendingFrame = null;
function drawFrame() {
  const f = pendingFrame;
  pendingFrame = null;
  if (!f || !gl) return;
  if (canvas.width !== f.w || canvas.height !== f.h) {
    canvas.width = f.w;
    canvas.height = f.h;
    gl.viewport(0, 0, f.w, f.h);
    layout();
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.px);
  gl.uniform1i(swizzleLoc, f.bgra ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function onVideo(p) {
  const v = new DataView(p.buffer, p.byteOffset, 8);
  const w = v.getUint16(0, true);
  const h = v.getUint16(2, true);
  const bgra = v.getUint32(4, true) === 0;
  if (!pendingFrame) requestAnimationFrame(drawFrame);
  pendingFrame = { w, h, bgra, px: p.subarray(8, 8 + w * h * 4) };
  st.frames++;
  st.width = w;
  st.height = h;
  if (!st.ready) {
    st.ready = true;
    window.__emu.ready = true;
    document.getElementById('wait')?.remove();
    layout();
    post({ type: 'emu-started', core: 'azahar', system: '3ds' });
  }
}

// keep the picture's proportions in the frame (the page decides the frame's size)
function layout() {
  const box = document.body.getBoundingClientRect();
  const k = Math.min(box.width / canvas.width, box.height / canvas.height) || 1;
  canvas.style.width = `${Math.floor(canvas.width * k)}px`;
  canvas.style.height = `${Math.floor(canvas.height * k)}px`;
}
addEventListener('resize', layout);
new ResizeObserver(layout).observe(document.body);
layout();

// ---- sound ----------------------------------------------------------------------------------------------------------
const audio = { ctx: null, node: null, gain: null, rate: 0, started: false };
async function startAudio(rate) {
  if (audio.ctx || !rate) return;
  try {
    audio.rate = rate;
    audio.ctx = new AudioContext({ sampleRate: Math.round(rate), latencyHint: 'interactive' });
    await audio.ctx.audioWorklet.addModule('/lib/ctr-audio-worklet.mjs');
    audio.node = new AudioWorkletNode(audio.ctx, 'ctr-sink', { outputChannelCount: [2] });
    audio.gain = audio.ctx.createGain();
    audio.gain.gain.value = st.volume;
    audio.node.connect(audio.gain).connect(audio.ctx.destination);
    audio.ctx.resume().catch(() => {});
  } catch (e) {
    st.log.push(`audio: ${e.message}`);
  }
}
// browsers keep sound asleep until the first click / key in the frame
const wake = () => audio.ctx?.state === 'suspended' && audio.ctx.resume().catch(() => {});
addEventListener('pointerdown', wake);
addEventListener('keydown', wake);
function onAudio(p) {
  if (!audio.node || st.paused) return;
  const s = new Int16Array(p.buffer.slice(p.byteOffset, p.byteOffset + (p.length & ~1)));
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  audio.node.port.postMessage(f, [f.buffer]);
}

// ---- memory (the regions the live reader needs, ten times a second) -------------------------------------------------
let addresses = null;
let extraRegions = []; // __emu.watch(): more regions on top of the game's (diagnostics, research)
async function watchFor(titleId) {
  try {
    addresses ||= await fetch('/shared/data/addresses.json').then((r) => r.json());
    const entry = titleId ? findEntry(addresses, { platform: '3ds', titleId }) : null;
    const regions = [...(entry ? regionsFor(entry) : []), ...extraRegions].slice(0, 16);
    const sig = regions.map((r) => `${r.addr}:${r.len}`).join();
    if (sig === st.watching) return;
    st.watching = sig;
    const b = new Uint8Array(4 + regions.length * 8);
    const v = new DataView(b.buffer);
    v.setUint32(0, regions.length, true);
    regions.forEach((r, i) => {
      v.setUint32(4 + i * 8, r.addr, true);
      v.setUint32(8 + i * 8, r.len, true);
    });
    cmd(CMD.WATCH, b);
  } catch (e) {
    st.log.push(`watch: ${e.message}`);
  }
}
function onMem(p) {
  const v = new DataView(p.buffer, p.byteOffset, p.length);
  const n = v.getUint32(0, true);
  const out = [];
  let o = 4;
  for (let i = 0; i < n && o + 8 <= p.length; i++) {
    const addr = v.getUint32(o, true);
    const len = v.getUint32(o + 4, true);
    o += 8;
    if (len) out.push({ addr, b: p.slice(o, o + len) });
    o += len;
  }
  st.mem = out;
}
function read(addr, len) {
  for (const { addr: a, b } of st.mem) if (addr >= a && addr + len <= a + b.length) return b.subarray(addr - a, addr - a + len);
  return null;
}

// ---- events ---------------------------------------------------------------------------------------------------------
function onEvent(p) {
  let e;
  try {
    e = JSON.parse(new TextDecoder().decode(p));
  } catch {
    return;
  }
  if (e.event === 'loaded') {
    st.liveMemory = !!e.memory;
    startAudio(e.sampleRate);
  } else if (e.event === 'title') {
    st.title = e.titleId;
    if (!/^0+$/.test(e.titleId)) watchFor(e.titleId);
  } else if (e.event === 'stats') st.fps = e.fps;
  else if (e.event === 'stateLoaded') waiters.loaded.splice(0).forEach((f) => f(!!e.ok));
  else if (e.event === 'error') {
    st.error = e.message;
    showError(t('ctr.failed', 'The 3DS game can’t run: {why}', { why: e.message }));
  }
}
function showError(text) {
  const w = document.getElementById('wait');
  if (w) w.textContent = text;
  post({ type: 'emu-error', message: text });
}

// ---- the stream from the host ------------------------------------------------------------------------------------
async function pump() {
  const res = await fetch(`/api/ctr/stream?id=${st.id}`);
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  // the chunks of a message that isn't complete yet: joined once it is (a picture is 768 KB – up to 7 MB at 3× – in
  // many chunks; copying everything so far on each chunk cost more than the picture itself)
  let parts = [];
  let partsLen = 0;
  let need = 8;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    partsLen += value.length;
    if (buf.length + partsLen < need) continue;
    const next = new Uint8Array(buf.length + partsLen);
    next.set(buf);
    let at = buf.length;
    for (const c of parts) {
      next.set(c, at);
      at += c.length;
    }
    buf = next;
    parts = [];
    partsLen = 0;
    let o = 0;
    while (buf.length - o >= 8) {
      const v = new DataView(buf.buffer, buf.byteOffset + o, 8);
      const type = v.getUint32(0, true);
      const len = v.getUint32(4, true);
      if (buf.length - o - 8 < len) break;
      const p = buf.subarray(o + 8, o + 8 + len);
      if (type === MSG.VIDEO) onVideo(p.slice());
      else if (type === MSG.AUDIO) onAudio(p);
      else if (type === MSG.MEM) onMem(p);
      else if (type === MSG.EVENT) onEvent(p);
      else if (type === MSG.STATE) waiters.state.shift()?.(p.slice());
      else if (type === MSG.LOG) {
        st.log.push(new TextDecoder().decode(p));
        if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
      }
      o += 8 + len;
    }
    buf = buf.subarray(o);
    need = buf.length >= 8 ? 8 + new DataView(buf.buffer, buf.byteOffset, 8).getUint32(4, true) : 8;
  }
  // the host is gone: nothing answers what's still waiting (a quick save / load would hang the play view)
  st.ended = true;
  waiters.state.splice(0).forEach((f) => f(null));
  waiters.loaded.splice(0).forEach((f) => f(false));
  if (!st.error) showError(t('ctr.stopped', 'The 3DS game stopped. Close the game and start it again.'));
}

// ---- input ------------------------------------------------------------------------------------------------------------
// libretro joypad bits (the same numbers EmulatorJS uses, lib/controls.mjs BUTTONS.ejs) – plus ZL 12, ZR 13
const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, zl: 12, zr: 13 };
const inp = { keys: 0, pad: 0, lx: 0, ly: 0, rx: 0, ry: 0, px: 0, py: 0, touch: false, stickX: 0, stickY: 0 };
let sentInput = '';
// Sun/Moon walk with the Circle Pad only (the D-pad scrolls menus): the direction keys move it too – full tilt –
// unless a controller's stick does
function stickFromKeys() {
  const k = inp.keys;
  const x = (k & (1 << BIT.right) ? 1 : 0) - (k & (1 << BIT.left) ? 1 : 0);
  const y = (k & (1 << BIT.down) ? 1 : 0) - (k & (1 << BIT.up) ? 1 : 0);
  return [x * 0x7fff, y * 0x7fff];
}
function sendInput() {
  const buttons = inp.keys | inp.pad;
  const [kx, ky] = stickFromKeys();
  const lx = inp.lx || inp.stickX || kx;
  const ly = inp.ly || inp.stickY || ky;
  const sig = [buttons, lx, ly, inp.rx, inp.ry, inp.px, inp.py, inp.touch].join();
  if (sig === sentInput) return;
  sentInput = sig;
  const b = new Uint8Array(17);
  const v = new DataView(b.buffer);
  v.setUint32(0, buttons >>> 0, true);
  [lx, ly, inp.rx, inp.ry, inp.px, inp.py].forEach((x, i) => v.setInt16(4 + i * 2, x, true));
  b[16] = inp.touch ? 1 : 0;
  cmd(CMD.INPUT, b);
}

let keyMap = {}; // keyCode → button
function forwardKey(e, down) {
  post({ type: 'emu-key', key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, down, repeat: e.repeat });
}
addEventListener('keydown', (e) => {
  forwardKey(e, true);
  const b = keyMap[e.keyCode];
  if (b === undefined) return;
  e.preventDefault();
  inp.keys |= 1 << BIT[b];
  sendInput();
});
addEventListener('keyup', (e) => {
  forwardKey(e, false);
  const b = keyMap[e.keyCode];
  if (b === undefined) return;
  inp.keys &= ~(1 << BIT[b]);
  sendInput();
});
addEventListener('blur', () => {
  forwardKey({ key: 'Tab', code: 'Tab' }, false);
  inp.keys = 0;
  inp.pad = 0;
  inp.touch = false;
  sendInput();
});

// touch: the mouse on the bottom screen (the core takes a pointer over the whole picture, -0x7fff…0x7fff)
function pointer(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  inp.px = Math.round(x * 0xfffe - 0x7fff);
  inp.py = Math.round(y * 0xfffe - 0x7fff);
}
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointer(e);
  inp.touch = true;
  sendInput();
});
canvas.addEventListener('pointermove', (e) => {
  if (!inp.touch) return;
  pointer(e);
  sendInput();
});
const lift = () => {
  if (!inp.touch) return;
  inp.touch = false;
  sendInput();
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);

// controllers: the chosen device (lib/controls.mjs pickPad) – buttons by Settings › Controller, the left stick is the
// Circle Pad, the right one the C-Stick; ZR/RT/R2 toggles turbo, ZL/LT/L2 and Home pause (as in player.html)
function startPads(pads) {
  const pm = controls.padMap(pads);
  const IDX = Object.fromEntries(controls.PAD_LABELS.map((l, i) => [l, i]));
  const HOT = { 7: 'turbo', 6: 'pause', 16: 'pause' };
  const held = {};
  const axis = (x) => (Math.abs(x) < 0.12 ? 0 : Math.round(Math.max(-1, Math.min(1, x)) * 0x7fff));
  setInterval(() => {
    if (!st.ready || document.visibilityState === 'hidden') return;
    const pad = controls.pickPad(navigator.getGamepads?.() || [], pads?.device || null);
    if (!pad) {
      if (inp.pad || inp.lx || inp.ly || inp.rx || inp.ry) Object.assign(inp, { pad: 0, lx: 0, ly: 0, rx: 0, ry: 0 }), sendInput();
      return;
    }
    let bits = 0;
    for (const [btn, label] of Object.entries(pm)) {
      const i = IDX[label];
      if (i !== undefined && pad.buttons[i]?.pressed) bits |= 1 << BIT[btn];
    }
    inp.pad = bits;
    const [lx = 0, ly = 0, rx = 0, ry = 0] = pad.axes;
    inp.lx = axis(lx);
    inp.ly = axis(ly);
    inp.rx = axis(rx);
    inp.ry = axis(ry);
    for (const [i, action] of Object.entries(HOT)) {
      const on = !!pad.buttons[i]?.pressed;
      if (on && !held[i]) post({ type: 'emu-pad', action });
      held[i] = on;
    }
    sendInput();
  }, 16);
}

// ---- window.__emu: what the Play view uses (see player.html) ----------------------------------------------------------
async function snapshot({ maxW = 192, type = 'image/jpeg', quality = 0.5 } = {}) {
  if (!st.ready) return null;
  const k = Math.min(1, maxW / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k);
  c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, type, quality));
}

window.__emu = {
  ready: false,
  system: () => '3ds',
  locateRam() {},
  ramInfo: () => ({ base: st.liveMemory && st.mem.length ? 0 : -1, tried: 0 }),
  read,
  write: null, // no cheats for 3DS games
  paused: () => st.paused,
  pause() {
    st.paused = true;
    cmd(CMD.SPEED, f32(0));
  },
  resume() {
    st.paused = false;
    cmd(CMD.SPEED, f32(st.speed === Infinity ? 1000 : st.speed));
  },
  togglePause() {
    if (st.paused) this.resume();
    else this.pause();
  },
  restart: () => cmd(CMD.RESET),
  /** 1–4, or Infinity: as fast as this computer can. */
  setSpeed(ratio) {
    st.speed = ratio === Infinity ? Infinity : Math.max(1, Number(ratio) || 1);
    if (!st.paused) cmd(CMD.SPEED, f32(st.speed === Infinity ? 1000 : st.speed));
    // fast-forward: every 2nd–4th picture is enough to see where you are (the host skips the others)
    cmd(CMD.FRAMESKIP, u32(st.speed > 1 ? Math.min(4, Math.ceil(st.speed)) : 1));
    if (st.speed > 1) audio.node?.port.postMessage('clear');
  },
  speed: () => st.speed,
  setFullTurbo() {},
  frames: () => st.frames,
  fastForward: () => st.speed > 1,
  ffRatio: () => (st.speed > 1 ? st.speed : 3),
  /** A save state (the host serializes between two frames). */
  getState() {
    if (st.ended) return Promise.resolve(null);
    return ask(waiters.state, CMD.SAVE, undefined, null, (b) => (b && b.length ? b : null));
  },
  loadState(u8) {
    if (st.ended) return Promise.resolve(false);
    audio.node?.port.postMessage('clear');
    return ask(waiters.loaded, CMD.LOAD, u8 instanceof Uint8Array ? u8 : new Uint8Array(u8), false);
  },
  async screenshot() {
    const b = await snapshot({ maxW: 4096, type: 'image/png' });
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  },
  canvas: () => (st.ready ? canvas : null),
  captureStream(fps = 15) {
    try {
      return st.ready && canvas.captureStream ? canvas.captureStream(fps) : null;
    } catch {
      return null;
    }
  },
  snapshot,
  // 3DS saves are files in the host's save folder (one per game / run slot) – nothing to hand over or take
  getSave: () => null,
  /** A fingerprint of the game's own saves (changes when the game saves), or null before the first. */
  async saveStamp() {
    if (!st.id) return null;
    try {
      return (await fetch(`/api/ctr/savestamp?id=${st.id}`).then((r) => r.json())).stamp || null;
    } catch {
      return undefined; // couldn't ask – unknown, not "no save"
    }
  },
  bootSave: () => 'loaded',
  loadSave() {},
  setVolume(v) {
    st.volume = v;
    if (audio.gain) audio.gain.gain.value = v;
  },
  muted: () => st.volume === 0,
  setTurboAudio() {},
  perf: () => ({ fps: st.fps, frames: st.frames, title: st.title, liveMemory: st.liveMemory, error: st.error, log: st.log.slice(-20) }),
  /** Tests / diagnostics: hold buttons by name (["a"], ["up", "b"] …) – what a controller would do. */
  hold(names = []) {
    inp.keys = names.reduce((m, n) => (n in BIT ? m | (1 << BIT[n]) : m), 0);
    sendInput();
  },
  /** Tests / diagnostics: the Circle Pad, -1…1 per axis (down / right positive). */
  stick(x = 0, y = 0) {
    inp.stickX = Math.round(Math.max(-1, Math.min(1, x)) * 0x7fff);
    inp.stickY = Math.round(Math.max(-1, Math.min(1, y)) * 0x7fff);
    sendInput();
  },
  touch(x, y, down = true) {
    inp.px = Math.round(x * 0xfffe - 0x7fff);
    inp.py = Math.round(y * 0xfffe - 0x7fff);
    inp.touch = down;
    sendInput();
  },
  title: () => st.title,
  /** More memory to read (at most 16 regions of 64 KB together with the game's own) – diagnostics and research. */
  watch(regions = []) {
    extraRegions = regions.filter((r) => Number.isInteger(r.addr) && Number.isInteger(r.len) && r.len > 0 && r.len <= 65536);
    st.watching = '';
    return watchFor(st.title && !/^0+$/.test(st.title) ? st.title : null);
  },
};

// ---- start ----------------------------------------------------------------------------------------------------------
async function start() {
  const [status] = await Promise.all([fetch('/api/status').then((r) => r.json()).catch(() => null)]);
  await setLang(status?.config?.lang || guessLang()).catch(() => {});
  try {
    await controls.detectLayout(status?.config?.lang);
    const m = controls.resolve(status?.config?.controls);
    keyMap = Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([b, v]) => [v.keyCode, b]));
    startPads(status?.config?.pads || null);
  } catch (e) {
    st.log.push(`controls: ${e.message}`);
  }
  const res = await fetch('/api/ctr/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
    body: JSON.stringify({ rom: q.get('rom'), key: q.get('key'), scale: Number(q.get('scale')) || 1 }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return showError(serverErrorText(j, res.status));
  st.id = j.id;
  st.liveMemory = !!j.liveMemory;
  const stop = () => fetch('/api/ctr/stop', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: st.id }) }).catch(() => {});
  addEventListener('pagehide', stop);
  pump().catch((e) => {
    st.ended = true;
    waiters.state.splice(0).forEach((f) => f(null));
    waiters.loaded.splice(0).forEach((f) => f(false));
    showError(t('ctr.failed', 'The 3DS game can’t run: {why}', { why: e.message }));
  });
}
start();
