// The fast player (playernative.html) for the DS, GBA and Game Boy: the game runs in souldew's native host
// (server/lib/native.mjs, native/retro-host – melonDS DS with its JIT, mGBA, Gambatte) and arrives here as a stream of
// pictures, sound, memory and battery saves; input, speed, save states and cheats go back. It offers the Play view the
// same window.__emu as player.html (EmulatorJS) – the live reader, cheats, save states, the battery save, speed,
// screenshots and the partner's mini view work the same way. The game's RAM is mirrored here (what changed, ten times a
// second, between two frames), so the live reader reads it synchronously like the browser emulator's memory.
import * as controls from '/lib/controls.mjs';
import { setLang, guessLang, t } from '/lib/i18n.mjs';
import { serverErrorText } from '/lib/errors.mjs';

const q = new URLSearchParams(location.search);
const SYSTEM = q.get('system') || 'nds';
const MSG = { VIDEO: 2, AUDIO: 3, STATE: 5, LOG: 6, EVENT: 7, RAM: 8, SRAM: 9 };
const CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, QUIT: 6, RESET: 7, WRITE: 9, FLUSH: 10, SRAM: 11, RESYNC: 12, STEP: 13 };
const post = (m) => window.parent?.postMessage(m, location.origin);

const st = {
  id: null, core: null, ready: false, paused: false, speed: 1, volume: 1, frames: 0, hostFrame: 0, fps: 0, hostSpeed: 0,
  ram: [], ramReady: false, sram: null, bootSave: 'pending', error: null, log: [], ended: false, lr: /left/i.test(q.get('layout') || ''),
  info: null, turboAudio: 'music',
};
const waiters = { state: [], loaded: [], stepped: [] };

// ---- commands -----------------------------------------------------------------------------------------------------
let chain = Promise.resolve();
function cmd(type, payload = new Uint8Array(0)) {
  const b = new Uint8Array(8 + payload.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  v.setUint32(4, payload.length, true);
  b.set(payload, 8);
  // one after another: the host must see input in the order it happened. Resolves false when the server refused it.
  const sent = chain.then(() => (st.id ? fetch(`/api/native/cmd?id=${st.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: b }).then((r) => r.ok) : false))
    .catch(() => true); // (no answer at all: the server is gone – the stream's end answers what waits)
  chain = sent;
  return sent;
}
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

// ---- picture (WebGL) – the DS's two screens on top of each other as the core draws them, or side by side ----------
const canvas = document.getElementById('screen');
const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
let uni = null;
let tex = null;
function initGl() {
  const vs = '#version 300 es\nin vec2 p;out vec2 uv;void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}';
  // lr: the left half shows the top screen (the picture's upper half), the right half the bottom screen
  const fs = '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D t;uniform bool bgra;uniform bool lr;out vec4 o;'
    + 'void main(){vec2 c=uv;if(lr){c=uv.x<.5?vec2(uv.x*2.,uv.y*.5):vec2((uv.x-.5)*2.,.5+uv.y*.5);}vec4 x=texture(t,c);o=vec4(bgra?x.bgr:x.rgb,1.);}';
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
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  uni = { bgra: gl.getUniformLocation(prog, 'bgra'), lr: gl.getUniformLocation(prog, 'lr') };
}
if (gl) initGl();

const sideBySide = () => SYSTEM === 'nds' && st.lr;
let pendingFrame = null;
let lastFrame = null;
function drawFrame() {
  const f = pendingFrame || lastFrame;
  pendingFrame = null;
  if (!f || !gl) return;
  lastFrame = f;
  const lr = sideBySide();
  const cw = lr ? f.w * 2 : f.w;
  const ch = lr ? f.h / 2 : f.h;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    gl.viewport(0, 0, cw, ch);
    layout();
  }
  if (f.fmt === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, f.w, f.h, 0, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, new Uint16Array(f.px.buffer, f.px.byteOffset, f.w * f.h));
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.px);
  gl.uniform1i(uni.bgra, f.fmt === 0 ? 1 : 0);
  gl.uniform1i(uni.lr, lr ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function onVideo(p) {
  const v = new DataView(p.buffer, p.byteOffset, 8);
  const w = v.getUint16(0, true);
  const h = v.getUint16(2, true);
  const fmt = v.getUint32(4, true);
  const bpp = fmt === 0 ? 4 : 2;
  if (!w || !h || p.length < 8 + w * h * bpp) return;
  if (!pendingFrame) requestAnimationFrame(drawFrame);
  pendingFrame = { w, h, fmt, px: p.subarray(8, 8 + w * h * bpp) };
  st.frames++;
  if (!st.ready) {
    st.ready = true;
    window.__emu.ready = true;
    document.getElementById('wait')?.remove();
    layout();
    post({ type: 'emu-started', core: st.core, system: SYSTEM });
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

// ---- sound: the host's samples through souldew's turbo mixer (lib/native-audio-worklet.mjs) ------------------------
// While fast-forwarding the host sends the sound sped up by the real speed (as RetroArch does for player.html); the
// mixer keeps the music going at normal speed (Settings › sound while fast-forwarding), for DS games synthesized from the
// ROM's own sound archive (lib/sdat-worker.mjs), as in player.html.
const MAX_SOUND_RATIO = 16; // the host speeds its fast-forward sound up at most this much
const audio = { ctx: null, node: null, gain: null, key: null, events: [], probes: [] };
function tellAudio(m) {
  audio.node?.port.postMessage(m);
}
const audioInit = () => [
  { type: 'mode', mode: st.turboAudio },
  { type: 'paused', paused: st.paused },
  ...(audio.key ? [{ type: 'song', key: audio.key }] : []),
  { type: 'speed', ratio: Math.min(st.speed, MAX_SOUND_RATIO) },
];
async function startAudio(rate) {
  if (audio.ctx || !rate) return;
  try {
    audio.ctx = new AudioContext({ sampleRate: Math.round(rate), latencyHint: 'interactive' });
    await audio.ctx.audioWorklet.addModule('/lib/native-audio-worklet.mjs');
    audio.node = new AudioWorkletNode(audio.ctx, 'native-audio', { outputChannelCount: [2], processorOptions: { init: audioInit() } });
    audio.node.port.onmessage = (e) => {
      const ev = e.data?.e;
      if (!ev) return;
      if (ev.type === 'error') st.log.push(`turbo audio: ${ev.message}`);
      if (ev.type === 'probe') audio.probes.splice(0).forEach((f) => f(ev));
      if (ev.type === 'state' || ev.type === 'error') {
        audio.events.push({ t: Math.round(performance.now()), ...ev });
        if (audio.events.length > 40) audio.events.shift();
      }
    };
    audio.gain = audio.ctx.createGain();
    audio.gain.gain.value = st.volume;
    audio.node.connect(audio.gain).connect(audio.ctx.destination);
    audio.ctx.resume().catch(() => {});
    for (const m of audioInit()) tellAudio(m); // (the state may have changed while the module loaded)
    startSdat();
  } catch (e) {
    st.log.push(`audio: ${e.message}`);
  }
}
// DS games: the ROM's sound archive, read in a worker – the mixer synthesizes the song the game plays
const sdat = { worker: null, ready: false };
const sdatSong = (key) => {
  const id = /^m(\d+)$/.exec(key || '')?.[1];
  if (sdat.ready && id) sdat.worker.postMessage({ type: 'pack', key, id: Number(id) });
};
function startSdat() {
  if (SYSTEM !== 'nds' || sdat.worker || typeof Worker !== 'function' || !q.get('rom')) return;
  try {
    // a blob worker inherits the page's cross-origin isolation (a script of its own would need the headers itself)
    const src = `import ${JSON.stringify(new URL('/lib/sdat-worker.mjs', location.href).href)};`;
    sdat.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  } catch (e) {
    st.log.push(`sdat: ${e.message}`);
    return;
  }
  sdat.worker.onerror = () => st.log.push('sdat: worker failed');
  sdat.worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'ready') {
      sdat.ready = true;
      tellAudio({ type: 'sdat-ready' });
      sdatSong(audio.key);
    } else if (m.type === 'none') st.log.push(`sdat: ${m.why}`);
    else if (m.type === 'pack' && m.pack) tellAudio({ type: 'sdat', key: m.key, pack: m.pack });
  };
  sdat.worker.postMessage({ type: 'rom', url: new URL(q.get('rom'), location.href).href });
}
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

// ---- memory: a mirror of the game's RAM regions --------------------------------------------------------------------
function onRam(p) {
  const v = new DataView(p.buffer, p.byteOffset, p.length);
  const n = v.getUint32(0, true);
  let o = 4;
  for (let i = 0; i < n && o + 8 <= p.length; i++) {
    const addr = v.getUint32(o, true);
    const len = v.getUint32(o + 4, true);
    o += 8;
    if (o + len > p.length) break;
    const r = st.ram.find((x) => addr >= x.addr && addr + len <= x.addr + x.b.length);
    if (r) r.b.set(p.subarray(o, o + len), addr - r.addr);
    o += len;
  }
  if (!st.ramReady && st.ram.length) st.ramReady = true;
}
const region = (addr, len) => st.ram.find((r) => addr >= r.addr && addr + len <= r.addr + r.b.length);
/** `len` bytes at a console bus address (a copy), or null outside the game's RAM. */
function read(addr, len) {
  if (!st.ramReady || !(len > 0)) return null;
  const r = region(addr, len);
  return r ? r.b.slice(addr - r.addr, addr - r.addr + len) : null;
}
/** A cheat: bytes at a bus address – between two frames in the host, and right away in the mirror. */
function write(addr, bytes) {
  if (!st.ramReady || !ArrayBuffer.isView(bytes) || !bytes.length || bytes.length > 65536) return false;
  const r = region(addr, bytes.length);
  if (!r) return false;
  const b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  r.b.set(b, addr - r.addr);
  const pl = new Uint8Array(4 + b.length);
  new DataView(pl.buffer).setUint32(0, addr >>> 0, true);
  pl.set(b, 4);
  cmd(CMD.WRITE, pl);
  return true;
}

// ---- events -------------------------------------------------------------------------------------------------------
function onEvent(p) {
  let e;
  try {
    e = JSON.parse(new TextDecoder().decode(p));
  } catch {
    return;
  }
  if (e.event === 'loaded') {
    st.info = e;
    // a mirror for every region the core has (all of it arrives with the first RAM message)
    st.ram = (e.ram || []).filter((r) => r.ok && r.len > 0 && r.len <= 16 * 1024 * 1024).map((r) => ({ addr: r.addr >>> 0, b: new Uint8Array(r.len) }));
    startAudio(e.sampleRate);
  } else if (e.event === 'stats') {
    st.fps = e.fps;
    st.hostSpeed = e.speed;
    if (st.speed > 1 && !st.paused && e.speed > 0.5) tellAudio({ type: 'rate', ratio: Math.round(Math.min(e.speed, MAX_SOUND_RATIO) * 100) / 100 });
    if (Number.isFinite(e.frame)) st.hostFrame = e.frame;
  } else if (e.event === 'stepped') {
    if (Number.isFinite(e.frame)) st.hostFrame = e.frame;
    waiters.stepped.splice(0).forEach((f) => f(e.frame));
  } else if (e.event === 'stateLoaded') waiters.loaded.splice(0).forEach((f) => f(!!e.ok));
  else if (e.event === 'error') {
    st.error = e.message;
    fail(t('native.failed', 'The game can’t run in the fast player: {why}', { why: e.message }));
  }
}
function onSram(p) {
  st.sram = p.slice();
  // as EmulatorJS' saveSaveFiles: the play view takes getSave() to disk now
  post({ type: 'emu-saved' });
}
function showError(text) {
  const w = document.getElementById('wait');
  if (w) w.textContent = text;
  post({ type: 'emu-error', message: text });
}
/** Before the game ever showed a picture the play view switches to the browser emulator; later it's an error. */
function fail(text) {
  if (!st.ready) post({ type: 'emu-native-failed', message: text });
  showError(text);
}

// ---- the stream from the host ------------------------------------------------------------------------------------
async function pump() {
  const res = await fetch(`/api/native/stream?id=${st.id}`);
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  cmd(CMD.RESYNC); // the whole RAM, whatever was sent before this page listened
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
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
      else if (type === MSG.RAM) onRam(p);
      else if (type === MSG.SRAM) onSram(p);
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
  ended();
  if (!st.error) fail(t('native.stopped', 'The game stopped. Close it and start it again.'));
}
function ended() {
  st.ended = true;
  waiters.state.splice(0).forEach((f) => f(null));
  waiters.loaded.splice(0).forEach((f) => f(false));
  waiters.stepped.splice(0).forEach((f) => f(null));
}

// ---- input ------------------------------------------------------------------------------------------------------------
// libretro joypad bits (the same numbers EmulatorJS uses, lib/controls.mjs BUTTONS.ejs)
const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };
const inp = { keys: 0, pad: 0, test: 0, px: 0, py: 0, touch: false };
let sentInput = '';
function sendInput() {
  const buttons = inp.keys | inp.pad | inp.test;
  const sig = [buttons, inp.px, inp.py, inp.touch].join();
  if (sig === sentInput) return;
  sentInput = sig;
  const b = new Uint8Array(17);
  const v = new DataView(b.buffer);
  v.setUint32(0, buttons >>> 0, true);
  v.setInt16(12, inp.px, true);
  v.setInt16(14, inp.py, true);
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

// touch (DS): the mouse on the bottom screen – the core takes a pointer over its whole picture (-0x7fff…0x7fff), the
// two screens on top of each other; side by side the click is mapped back onto that picture
function toPicture(x, y) {
  if (!sideBySide()) return [x, y];
  return x < 0.5 ? [x * 2, y * 0.5] : [(x - 0.5) * 2, 0.5 + y * 0.5];
}
function pointer(e) {
  const r = canvas.getBoundingClientRect();
  const [x, y] = toPicture(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  inp.px = Math.round(x * 0xfffe - 0x7fff);
  inp.py = Math.round(y * 0xfffe - 0x7fff);
}
if (SYSTEM === 'nds') {
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
}

// controllers: the chosen device (lib/controls.mjs pickPad) – buttons by Settings › Controller, the left stick moves
// like the D-pad; RT/R2 toggles turbo, LT/L2 and Home pause (as in player.html)
function startPads(pads) {
  const pm = controls.padMap(pads);
  const IDX = Object.fromEntries(controls.PAD_LABELS.map((l, i) => [l, i]));
  const HOT = { 7: 'turbo', 6: 'pause', 16: 'pause' };
  const held = {};
  setInterval(() => {
    if (!st.ready || document.visibilityState === 'hidden') return;
    const pad = controls.pickPad(navigator.getGamepads?.() || [], pads?.device || null);
    if (!pad) {
      if (inp.pad) {
        inp.pad = 0;
        sendInput();
      }
      return;
    }
    let bits = 0;
    for (const [btn, label] of Object.entries(pm)) {
      const i = IDX[label];
      if (i !== undefined && pad.buttons[i]?.pressed && btn in BIT) bits |= 1 << BIT[btn];
    }
    const [lx = 0, ly = 0] = pad.axes;
    if (lx < -0.5) bits |= 1 << BIT.left;
    if (lx > 0.5) bits |= 1 << BIT.right;
    if (ly < -0.5) bits |= 1 << BIT.up;
    if (ly > 0.5) bits |= 1 << BIT.down;
    inp.pad = bits;
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
  drawFrame(); // (the last picture again: the canvas may be cleared after a resize)
  const k = Math.min(1, maxW / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k);
  c.height = Math.round(canvas.height * k);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, type, quality));
}
const speedValue = () => (st.speed === Infinity ? 1000 : st.speed);
const blankSave = (b) => !b || !b.length || b.every((x) => x === 0xff) || b.every((x) => x === 0);

window.__emu = {
  ready: false,
  native: true,
  system: () => SYSTEM,
  locateRam() {
    return st.ramReady ? { base: 0, size: st.ram.reduce((n, r) => n + r.b.length, 0) } : null;
  },
  ramInfo: () => ({ base: st.ramReady ? 0 : -1, size: st.ram.reduce((n, r) => n + r.b.length, 0), tried: 0, system: SYSTEM }),
  read,
  write,
  paused: () => st.paused,
  pause() {
    st.paused = true;
    cmd(CMD.SPEED, f32(0));
    tellAudio({ type: 'paused', paused: true });
  },
  resume() {
    st.paused = false;
    cmd(CMD.SPEED, f32(speedValue()));
    tellAudio({ type: 'paused', paused: false });
  },
  togglePause() {
    if (st.paused) this.resume();
    else this.pause();
  },
  restart: () => {
    tellAudio('clear');
    tellAudio({ type: 'cut' });
    return cmd(CMD.RESET);
  },
  /** 1–4, or Infinity: as fast as this computer can. */
  setSpeed(ratio) {
    st.speed = ratio === Infinity ? Infinity : Math.max(1, Number(ratio) || 1);
    if (!st.paused) cmd(CMD.SPEED, f32(speedValue()));
    tellAudio({ type: 'speed', ratio: Math.min(st.speed, MAX_SOUND_RATIO) });
  },
  speed: () => st.speed,
  setFullTurbo() {}, // the native host always runs fast-forward at full power – it doesn't hold the page back
  /** Emulated frames so far (the host's count, four times a second) – the page measures the real speed with it. */
  frames: () => st.hostFrame,
  fastForward: () => st.speed > 1,
  ffRatio: () => (st.speed > 1 ? st.speed : 3),
  getState() {
    if (st.ended) return Promise.resolve(null);
    return ask(waiters.state, CMD.SAVE, undefined, null, (b) => (b && b.length ? b : null));
  },
  loadState(u8) {
    if (st.ended) return Promise.resolve(false);
    tellAudio('clear');
    tellAudio({ type: 'cut' });
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
  /** The battery save as the game last wrote it (a copy), or null before it ever saved. */
  getSave: () => (st.sram ? st.sram.slice() : null),
  /** How the app's save reached the core at boot: 'loaded' | 'none' | 'failed' | 'pending'. */
  bootSave: () => st.bootSave,
  /** A battery save given after the start: into the core, then the game starts over with it. */
  loadSave(bytes) {
    if (!ArrayBuffer.isView(bytes) || !bytes.length) return;
    const b = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
    st.sram = b;
    st.bootSave = 'loaded';
    tellAudio('clear');
    tellAudio({ type: 'cut' });
    cmd(CMD.SRAM, b);
  },
  setVolume(v) {
    st.volume = v;
    if (audio.gain) audio.gain.gain.value = v;
  },
  muted: () => st.volume === 0,
  /** What plays while fast-forwarding: 'music' | 'mute' | 'original' | 'plain' (as player.html). */
  setTurboAudio(mode) {
    st.turboAudio = mode;
    tellAudio({ type: 'mode', mode });
  },
  /** The music the game plays now (location.mjs musicKey): the turbo mixer follows it. */
  songKey(key) {
    if (!key || key === audio.key) return;
    audio.key = key;
    tellAudio({ type: 'song', key });
    sdatSong(key);
  },
  /** The mixer's last state changes (diagnostics). */
  turboAudio: () => ({ mode: st.turboAudio, key: audio.key, sdat: sdat.ready, events: audio.events.slice(-10) }),
  /** Tests: what the mixer plays right now ({ playing, turbo, key, … }), or null without sound. */
  audioProbe() {
    if (!audio.node) return Promise.resolve(null);
    return new Promise((res) => {
      audio.probes.push(res);
      tellAudio({ type: 'probe' });
      setTimeout(() => res(null), 2000);
    });
  },
  perf: () => ({ fps: st.fps, speed: st.hostSpeed, frames: st.hostFrame, shown: st.frames, core: st.core, info: st.info, error: st.error, log: st.log.slice(-20), pacing: { core: st.core, native: true } }),
  setOption(k, v) {
    if (/screens?_layout$/.test(k)) {
      st.lr = /left/i.test(v);
      drawFrame();
    }
  },
  fullscreen: () => document.documentElement.requestFullscreen?.(),
  /** Tests / diagnostics: hold buttons by name (["a"], ["up", "b"] …) – what a controller would do. */
  hold(names = []) {
    inp.test = names.reduce((m, n) => (String(n).toLowerCase() in BIT ? m | (1 << BIT[String(n).toLowerCase()]) : m), 0);
    sendInput();
  },
  /** Tests: the stylus at (x, y) over the whole picture (0…1, the two screens on top of each other). */
  touch(x, y, down = true) {
    inp.px = Math.round(x * 0xfffe - 0x7fff);
    inp.py = Math.round(y * 0xfffe - 0x7fff);
    inp.touch = down;
    sendInput();
  },
  /** Tests: run exactly `n` frames, then stay paused – resolves with the frame number once they ran. */
  step(n) {
    if (st.ended) return Promise.resolve(null);
    st.paused = true;
    return ask(waiters.stepped, CMD.STEP, u32(Math.max(1, Math.min(100000, n | 0))), null);
  },
  /** The input as sent last (tests: the next step() runs with it). */
  flush: () => chain,
};

// ---- start ----------------------------------------------------------------------------------------------------------
async function bootSaveBytes() {
  const url = q.get('save');
  if (!url) return { state: 'none', bytes: null };
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { state: 'none', bytes: null };
      if (r.ok) {
        const b = new Uint8Array(await r.arrayBuffer());
        return b.length && !blankSave(b) ? { state: 'loaded', bytes: b } : { state: 'none', bytes: null };
      }
    } catch {
      // try again
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  return { state: 'failed', bytes: null }; // the play view reads it again and hands it over with loadSave()
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function start() {
  const [status, save] = await Promise.all([fetch('/api/status').then((r) => r.json()).catch(() => null), bootSaveBytes()]);
  await setLang(status?.config?.lang || guessLang()).catch(() => {});
  try {
    await controls.detectLayout(status?.config?.lang);
    const m = controls.resolve(status?.config?.controls);
    keyMap = Object.fromEntries(Object.entries(m).filter(([, v]) => v).map(([b, v]) => [v.keyCode, b]));
    startPads(status?.config?.pads || null);
  } catch (e) {
    st.log.push(`controls: ${e.message}`);
  }
  const res = await fetch('/api/native/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
    body: JSON.stringify({ rom: q.get('rom'), key: q.get('key'), system: SYSTEM, save: save.bytes ? b64(save.bytes) : null }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return fail(serverErrorText(j, res.status));
  st.id = j.id;
  st.core = j.core;
  st.sram = save.bytes;
  st.bootSave = save.state;
  const stop = () => fetch('/api/native/stop', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: st.id }) }).catch(() => {});
  addEventListener('pagehide', stop);
  pump().catch((e) => {
    ended();
    fail(t('native.failed', 'The game can’t run in the fast player: {why}', { why: e.message }));
  });
}
start();
