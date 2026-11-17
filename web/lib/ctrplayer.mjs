// The 3DS player (player3ds.html): the game runs in souldew's native host (server/lib/ctr.mjs, native/ctr-host) and
// arrives here as a stream of pictures, sound and memory; input, speed, save states and cheats go back. It offers the Play
// view the same window.__emu as player.html (EmulatorJS) – save states, speed, screenshots, the partner's mini view
// and the live reader work the same way. 3DS saves aren't one battery file: they live in the host's save folder of the
// game / run slot (server side), so getSave() has nothing to hand over.
import * as controls from '/lib/controls.mjs';
import { setLang, guessLang, t } from '/lib/i18n.mjs';
import { serverErrorText } from '/lib/errors.mjs';
import { findEntry, regionsFor } from '/shared/live/parse.mjs';
import { cheatRegions } from '/shared/live/cheats.mjs';
import { CTR_LAYOUTS, ctrLayout, ctrTouchAt } from '/shared/ctrlayout.mjs';
import { mountPad, isTouchScreen } from '/lib/ctrpad.mjs';

const q = new URLSearchParams(location.search);
const MSG = { VIDEO: 2, AUDIO: 3, MEM: 4, STATE: 5, LOG: 6, EVENT: 7, FFSOUND: 8 };
const CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, WATCH: 5, QUIT: 6, RESET: 7, FRAMESKIP: 8, WRITE: 9 };
const post = (m) => window.parent?.postMessage(m, location.origin);

const st = {
  id: null, ready: false, paused: false, speed: 1, volume: 1, frames: 0, fps: 0, title: null, width: 400, height: 480,
  mem: [], watching: '', liveMemory: false, error: null, log: [], renderer: null, turboAudio: 'music',
  hostFrame: 0, hostFrames: false, hostSpeed: 0, // the host's count of emulated frames and its real speed (stats event)
};
const waiters = { state: [], loaded: [], written: new Map() }; // written: write id → resolve

// ---- commands -----------------------------------------------------------------------------------------------------
// One request at a time, and what comes meanwhile goes along with the next one (the server takes several framed
// commands in one body, in order): the host sees input in the order it happened, and a burst of input (dragging on
// the touch screen) is a few requests, not thousands – one request per command piled up native memory in the renderer
// until Chromium ended the page (found with the fast player, lib/nativeplayer.mjs). Resolves false when the server
// refused it (it never reached the host – nothing will answer), else true.
const MAX_BATCH = 8 * 1024 * 1024; // (a save state goes alone)
const queue = []; // { bytes, done }
let inFlight = false;
function sendQueued() {
  if (inFlight || !queue.length) return;
  if (!st.id) return queue.splice(0).forEach((c) => c.done(false));
  const batch = [];
  let size = 0;
  while (queue.length && (!batch.length || size + queue[0].bytes.length <= MAX_BATCH)) {
    const c = queue.shift();
    batch.push(c);
    size += c.bytes.length;
  }
  const body = new Uint8Array(size);
  let o = 0;
  for (const c of batch) {
    body.set(c.bytes, o);
    o += c.bytes.length;
  }
  inFlight = true;
  fetch(`/api/ctr/cmd?id=${st.id}`, { method: 'POST', headers: { 'x-soullink': '1' }, body })
    .then(async (r) => {
      await r.arrayBuffer().catch(() => null); // (read it: an unread response holds on to its resources)
      return r.ok;
    })
    .catch(() => true) // (no answer at all: the server is gone – the stream's end answers what waits)
    .then((ok) => {
      inFlight = false;
      for (const c of batch) c.done(ok);
      sendQueued();
    });
}
function cmd(type, payload = new Uint8Array(0)) {
  const b = new Uint8Array(8 + payload.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  v.setUint32(4, payload.length, true);
  b.set(payload, 8);
  return new Promise((done) => {
    queue.push({ bytes: b, done });
    sendQueued();
  });
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

// ---- picture (WebGL: the host sends BGRA or RGBA rows, top row first) -------------------------------------------
// The core always renders its default layout (top screen above the bottom one, 400×480 at 1×). The page arranges the
// two screens itself (shared/ctrlayout.mjs: side by side, large top + small bottom, top only, swapped) – switchable while
// playing, with no restart of the core, and the touch screen maps back through the same rectangles.
const canvas = document.getElementById('screen');
const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
let tex = null;
let swizzleLoc = null;
let quadBuf = null;
let layoutId = CTR_LAYOUTS.includes(q.get('layout')) ? q.get('layout') : 'tb';
// "Smooth picture" (the play view's screen layout menu): the screens scaled with linear filtering instead of crisp
// pixels – both where the page draws a screen smaller or larger (the layouts) and where the frame scales the canvas
let smooth = q.get('smooth') === '1';
function applyFilter() {
  canvas.style.imageRendering = smooth ? 'auto' : 'pixelated';
  if (!gl || !tex) return;
  const f = smooth ? gl.LINEAR : gl.NEAREST;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
}
function initGl() {
  const vs = '#version 300 es\nin vec2 p;in vec2 t;out vec2 uv;void main(){uv=t;gl_Position=vec4(p,0.,1.);}';
  const fs = '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D s;uniform bool bgra;out vec4 o;void main(){vec4 c=texture(s,uv);o=vec4(bgra?c.bgr:c.rgb,1.);}';
  const sh = (type, src) => {
    const x = gl.createShader(type);
    gl.shaderSource(x, src);
    gl.compileShader(x);
    return x;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const ploc = gl.getAttribLocation(prog, 'p');
  const tloc = gl.getAttribLocation(prog, 't');
  gl.enableVertexAttribArray(ploc);
  gl.vertexAttribPointer(ploc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(tloc);
  gl.vertexAttribPointer(tloc, 2, gl.FLOAT, false, 16, 8);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  applyFilter();
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  swizzleLoc = gl.getUniformLocation(prog, 'bgra');
  gl.clearColor(0, 0, 0, 1);
}
if (gl) initGl();

/** The screens of the current layout for a picture of w×h: { width, height, quads: [{ src, dst }] } in pixels. */
const arrangement = (w, h) => ctrLayout(layoutId, w, h);

let pendingFrame = null;
let lastFrame = null;
function drawFrame() {
  const f = pendingFrame || lastFrame;
  pendingFrame = null;
  if (!f || !gl) return;
  lastFrame = f;
  const lay = arrangement(f.w, f.h);
  if (canvas.width !== lay.width || canvas.height !== lay.height) {
    canvas.width = lay.width;
    canvas.height = lay.height;
    gl.viewport(0, 0, lay.width, lay.height);
    layout();
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, f.w, f.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.px);
  gl.uniform1i(swizzleLoc, f.bgra ? 1 : 0);
  // two quads (x, y in clip space, u, v in the picture): a triangle strip each
  const v = new Float32Array(lay.quads.length * 16);
  lay.quads.forEach(({ src, dst }, i) => {
    const x0 = (dst.x / lay.width) * 2 - 1;
    const x1 = ((dst.x + dst.w) / lay.width) * 2 - 1;
    const y0 = 1 - (dst.y / lay.height) * 2;
    const y1 = 1 - ((dst.y + dst.h) / lay.height) * 2;
    const u0 = src.x / f.w;
    const u1 = (src.x + src.w) / f.w;
    const v0 = src.y / f.h;
    const v1 = (src.y + src.h) / f.h;
    v.set([x0, y1, u0, v1, x1, y1, u1, v1, x0, y0, u0, v0, x1, y0, u1, v0], i * 16);
  });
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
  gl.clear(gl.COLOR_BUFFER_BIT);
  for (let i = 0; i < lay.quads.length; i++) gl.drawArrays(gl.TRIANGLE_STRIP, i * 4, 4);
}
function onVideo(p) {
  const v = new DataView(p.buffer, p.byteOffset, 8);
  const w = v.getUint16(0, true);
  const h = v.getUint16(2, true);
  const bgra = v.getUint32(4, true) === 0;
  if (!w || !h || p.length < 8 + w * h * 4) return;
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

// ---- sound: the host's samples through souldew's turbo mixer (lib/native-audio-worklet.mjs, as the fast player) -----
// While fast-forwarding the host sends the sound sped up by the real speed, resampled to real time (ctrhost.c
// ff_frame), and says by how much ("ffrate", right before that sound – the worklet hands the ratio to the mixer when the
// sound plays); the mixer then plays what Settings › "Turbo audio" asks for: the music recorded at 1× going on
// ("music"), silence ("mute"), the sped-up original ("original"), or the host's sound with no mixer at all ("plain").
// For "music" the host also sends the core's own sound while it fast-forwards (message 8: the game's pace, its normal
// pitch, full bandwidth): the mixer records that instead of slowing the sped-up sound back down, which kept only a k-th
// of the bandwidth (the sped-up sound is low-passed before it is sped up) – at 4× muffled music.
// The worklet keeps more in hand than for the fast player: the sound comes between pictures of up to 7 MB.
const MAX_SOUND_RATIO = 16; // the host speeds its fast-forward sound up at most this much
const audio = { ctx: null, node: null, gain: null, key: null, events: [], subs: new Set(), probes: [], taps: [], rate: 0, exact: false, win: null, last: null };
/**
 * The worklet's buffer (frames, lib/jitterring.mjs): start / restart once 60 ms are there – more after each gap, up to
 * 240 ms, for a PC whose sound arrives late now and then –, read a little faster above 200 ms (the late sound queued
 * behind a gap; ctrhost paces 1× by the core's sound, so nothing else piles up), skip ahead above 450 ms.
 */
const ringFor = (rate) => ({ prime: Math.round(rate * 0.06), primeMax: Math.round(rate * 0.24), trim: Math.round(rate * 0.2), maxLag: Math.round(rate * 0.45) });
/**
 * Diagnostics (perf().last, logged by the play view every 10 s): what the sound buffer went through over the last 10 s
 * of sound – gaps, how long it was silent for them, how much it skipped, how long it read faster or slower, its fill.
 */
function ringWindow(r) {
  const rate = audio.ctx?.sampleRate || 32728;
  const w = audio.win;
  if (!w || r.underruns < w.underruns) audio.win = { ...r, at: performance.now() };
  else if (performance.now() - w.at >= 10000) {
    audio.last = {
      soundGaps: r.underruns - w.underruns,
      soundSilentMs: Math.round(((r.silent - w.silent) / rate) * 1000),
      soundSkippedMs: Math.round(((r.dropped - w.dropped) / rate) * 1000),
      soundResampledPct: Math.round(((r.resampled - w.resampled) * 128 * 100) / (((performance.now() - w.at) / 1000) * rate)),
      soundMs: Math.round((r.lag / rate) * 1000),
      soundPrimeMs: Math.round((r.prime / rate) * 1000),
    };
    audio.win = { ...r, at: performance.now() };
  }
}
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
  if (audio.ctx || !rate || q.get('audio') === '0') return; // (?audio=0: no sound at all – diagnostics)
  try {
    audio.rate = rate;
    audio.ctx = new AudioContext({ sampleRate: Math.round(rate), latencyHint: 'interactive' });
    await audio.ctx.audioWorklet.addModule('/lib/native-audio-worklet.mjs');
    audio.node = new AudioWorkletNode(audio.ctx, 'native-audio', { outputChannelCount: [2], processorOptions: { init: audioInit(), ...ringFor(audio.ctx.sampleRate) } });
    audio.node.port.onmessage = (e) => {
      if (e.data?.type === 'tap') return audio.taps.splice(0).forEach((f) => f(e.data));
      if (e.data?.type === 'ring') return ringWindow(e.data.ring);
      const ev = e.data?.e;
      if (!ev) return;
      if (ev.type === 'error') st.log.push(`turbo audio: ${ev.message}`);
      if (ev.type === 'probe') audio.probes.splice(0).forEach((f) => f(ev));
      if (ev.type === 'state' || ev.type === 'error') {
        audio.events.push({ t: Math.round(performance.now()), ...ev });
        if (audio.events.length > 40) audio.events.shift();
      }
      // every mixer decision (loops found, switches, song keys) to the page's music log for "Save diagnostics" – as player.html;
      // without it a native player's diagnostics showed only the speed steps (a Windows player's Pokémon Y report, 2.7.4)
      if (ev.type !== 'probe') {
        for (const f of audio.subs) {
          try {
            f({ t: Math.round(performance.now()), ...ev });
          } catch {
            // the page's problem
          }
        }
      }
    };
    audio.gain = audio.ctx.createGain();
    audio.gain.gain.value = st.volume;
    audio.node.connect(audio.gain).connect(audio.ctx.destination);
    audio.ctx.resume().catch(() => {});
    for (const m of audioInit()) tellAudio(m); // (the state may have changed while the module loaded)
  } catch (e) {
    st.log.push(`audio: ${e.message}`);
  }
}
// browsers keep sound asleep until the first click / key in the frame
const wake = () => audio.ctx?.state === 'suspended' && audio.ctx.resume().catch(() => {});
addEventListener('pointerdown', wake);
addEventListener('keydown', wake);
/** The host's s16 stereo samples as floats (interleaved). */
function floats(p) {
  const s = new Int16Array(p.buffer.slice(p.byteOffset, p.byteOffset + (p.length & ~1)));
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  return f;
}
function onAudio(p) {
  if (!audio.node || st.paused) return;
  const f = floats(p);
  audio.node.port.postMessage(f, [f.buffer]);
}
/** Fast-forward: the core's own sound (message 8) – only "Music continues" records it, the other modes never use it. */
function onFfSound(p) {
  if (!audio.node || st.paused || st.turboAudio !== 'music') return;
  const f = floats(p);
  audio.node.port.postMessage({ type: 'ffsound', f }, [f.buffer]);
}

// ---- memory (the regions the live reader needs – and the bag for the cheats – ten times a second) ---------------------
let addresses = null;
let extraRegions = []; // __emu.watch(): more regions on top of the game's (diagnostics, research)
async function watchFor(titleId) {
  try {
    addresses ||= await fetch('/shared/data/addresses.json').then((r) => r.json());
    const entry = titleId ? findEntry(addresses, { platform: '3ds', titleId }) : null;
    const regions = [...(entry ? [...regionsFor(entry), ...cheatRegions(entry)] : []), ...extraRegions].slice(0, 16);
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

// A cheat: a few bytes inside the memory souldew watches (never anywhere else), written by the host between two frames
// – and only while the game still holds what souldew read there (the host compares). Resolves true once written (the
// copy here has it too); { ok: false, why } when the host refused (its reason: ctrhost.c mem_write); false when it
// never reached the host or no answer came.
let writeId = 0;
function write(addr, bytes) {
  const len = bytes?.length || 0;
  if (!st.liveMemory || st.ended || !st.id || !len || len > 256 || (addr & 0xfff) + len > 0x1000) return Promise.resolve(false);
  const old = read(addr, len);
  if (!old) return Promise.resolve(false);
  const id = ++writeId;
  const p = new Uint8Array(12 + 2 * len);
  const v = new DataView(p.buffer);
  v.setUint32(0, id, true);
  v.setUint32(4, addr >>> 0, true);
  v.setUint32(8, len, true);
  p.set(old, 12);
  p.set(bytes, 12 + len);
  const val = Uint8Array.from(bytes);
  return new Promise((res) => {
    const done = (ok, why) => {
      if (!waiters.written.delete(id)) return;
      clearTimeout(timer);
      if (ok) read(addr, len)?.set(val); // (the next memory message brings the same)
      res(ok ? true : why ? { ok: false, why: String(why) } : false);
    };
    const timer = setTimeout(() => done(false), 5000);
    waiters.written.set(id, done);
    cmd(CMD.WRITE, p).then((sent) => sent || done(false));
  });
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
    // a second "loaded" with another renderer: the server started the host again with a safer one (renderer "auto",
    // server/lib/ctrrenderer.mjs) – the play view says so
    if (e.renderer && st.renderer && e.renderer !== st.renderer) post({ type: 'emu-renderer', from: st.renderer, to: e.renderer });
    if (e.renderer) st.renderer = e.renderer;
  } else if (e.event === 'title') {
    st.title = e.titleId;
    if (!/^0+$/.test(e.titleId)) watchFor(e.titleId);
  } else if (e.event === 'stats') {
    st.fps = e.fps;
    if (Number.isFinite(e.speed)) st.hostSpeed = e.speed;
    if (Number.isFinite(e.frame)) {
      st.hostFrame = e.frame;
      st.hostFrames = true;
    }
    // the sped-up sound's real speed, for the mixer to slow it down again (as the fast player) – unless the host says
    // its exact ratio itself (ffrate)
    if (!audio.exact && st.speed > 1 && !st.paused && e.speed > 0.5) tellAudio({ type: 'rate', ratio: Math.round(Math.min(e.speed, MAX_SOUND_RATIO) * 100) / 100 });
  } else if (e.event === 'ffrate') {
    if (!(e.k >= 1)) return;
    audio.exact = true;
    tellAudio({ type: 'rate', ratio: e.k, exact: true, inband: true });
  }
  else if (e.event === 'stateLoaded') waiters.loaded.splice(0).forEach((f) => f(!!e.ok));
  else if (e.event === 'written') {
    if (!e.ok) st.log.push(`write ${Number(e.addr || 0).toString(16)}: ${e.why}`);
    waiters.written.get(e.id)?.(!!e.ok, e.why);
  }
  else if (e.event === 'error') {
    st.error = e.message;
    showError(t('ctr.failed', 'The 3DS game can’t run: {why}', { why: e.message }));
  }
}
function showError(text, code = null) {
  const w = document.getElementById('wait');
  if (w) w.textContent = text;
  // (detail: the host's last log lines – the graphics card, the driver – for "Save diagnostics")
  post({ type: 'emu-error', message: text, code, detail: st.log.slice(-12).join('\n') });
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
      else if (type === MSG.FFSOUND) onFfSound(p);
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
  [...waiters.written.values()].forEach((f) => f(false));
  if (st.error) return;
  // how the host ended (a crash in the graphics driver shows only as an exit code): asked before the page closes it
  let why = '';
  try {
    const s = await fetch('/api/ctr/status').then((r) => r.json());
    if (s?.session?.id === st.id) why = s.session.exitText || '';
  } catch {
    // the server is gone too
  }
  showError(why ? t('ctr.stoppedWhy', 'The 3DS game stopped ({why}).', { why }) : t('ctr.stopped', 'The 3DS game stopped. Close the game and start it again.'));
}

// ---- input ------------------------------------------------------------------------------------------------------------
// libretro joypad bits (the same numbers EmulatorJS uses, lib/controls.mjs BUTTONS.ejs) – plus ZL 12, ZR 13
const BIT = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, zl: 12, zr: 13 };
const inp = { keys: 0, pad: 0, screenPad: 0, padX: 0, padY: 0, lx: 0, ly: 0, rx: 0, ry: 0, px: 0, py: 0, touch: false, stickX: 0, stickY: 0 };
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
  const buttons = inp.keys | inp.pad | inp.screenPad;
  const [kx, ky] = stickFromKeys();
  const lx = inp.lx || inp.stickX || inp.padX || kx;
  const ly = inp.ly || inp.stickY || inp.padY || ky;
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
let hotkeys = controls.resolveHotkeys(null); // the fast-forward keys (Tab, Shift+Tab) – handled by the play view
function forwardKey(e, down) {
  post({ type: 'emu-key', key: e.key, code: e.code, keyCode: e.keyCode, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, down, repeat: e.repeat, blur: e.blur || undefined });
}
addEventListener('keydown', (e) => {
  forwardKey(e, true);
  if (controls.isHotkeyKey(e, hotkeys)) e.preventDefault(); // Tab fast-forwards here, it doesn't move the focus
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
// phones and tablets: the on-screen pad (lib/ctrpad.mjs)
const screenPad = isTouchScreen()
  ? mountPad(document.body, ({ bits, lx, ly }) => {
    inp.screenPad = bits;
    inp.padX = lx;
    inp.padY = ly;
    sendInput();
  })
  : null;
addEventListener('blur', () => {
  forwardKey({ key: 'Tab', code: 'Tab', blur: true }, false); // ends a held fast-forward
  screenPad?.reset();
  inp.keys = 0;
  inp.pad = 0;
  inp.touch = false;
  sendInput();
});

// touch: the mouse on the bottom screen, wherever the layout puts it – the core takes a pointer over its own picture
// (-0x7fff…0x7fff, the screens on top of each other); a click on the top screen isn't a touch, and a drag that leaves
// the bottom screen stays on its edge
function pointer(e, start) {
  const r = canvas.getBoundingClientRect();
  const at = ctrTouchAt(arrangement(st.width, st.height), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, { clamp: !start });
  if (!at) return false;
  inp.px = Math.round(at.x * 0xfffe - 0x7fff);
  inp.py = Math.round(at.y * 0xfffe - 0x7fff);
  return true;
}
canvas.addEventListener('pointerdown', (e) => {
  if (!pointer(e, true)) return;
  canvas.setPointerCapture(e.pointerId);
  inp.touch = true;
  sendInput();
});
canvas.addEventListener('pointermove', (e) => {
  if (!inp.touch) return;
  pointer(e, false);
  sendInput();
});
const lift = () => {
  if (!inp.touch) return;
  inp.touch = false;
  sendInput();
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);

// Settings › Controls and › Controller (config.controls, config.pads): read when the page starts, and again whenever
// they change while the game runs (__emu.setControls from the play view, as lib/nativeplayer.mjs)
let padCfg = null; // config.pads
let padButtons = controls.padMap(null); // game button → controller button label
const padRec = controls.padRecorder(); // (diagnostics: __emu.padInfo)
let padActions = controls.padActions(null); // controller hotkeys: standard button index → action
let controlsSig = '';
function applyControls(config) {
  const sig = JSON.stringify([config?.controls || null, config?.pads || null]);
  if (sig === controlsSig) return; // (the play view hands them over once the game runs – mostly what was read at start)
  controlsSig = sig;
  keyMap = controls.keyButtons(config?.controls);
  hotkeys = controls.resolveHotkeys(config?.controls);
  padCfg = config?.pads || null;
  padButtons = controls.padMap(padCfg);
  padActions = controls.padActions(padCfg);
  post({ type: 'emu-pad', action: 'ffHold', down: false }); // (a fast-forward button held under the old buttons)
  // what was held under the old buttons is let go (the next poll presses what is still down)
  inp.keys = 0;
  inp.pad = 0;
  if (st.id) sendInput();
}

// controllers: the chosen device (lib/controls.mjs pickPad) – buttons by Settings › Controller, the left stick is the
// Circle Pad, the right one the C-Stick; ZR/RT/R2 toggles turbo, ZL/LT/L2 and Home pause (as in player.html)
function startPads() {
  const IDX = Object.fromEntries(controls.PAD_LABELS.map((l, i) => [l, i]));
  const held = {};
  const axis = (x) => (Math.abs(x) < 0.12 ? 0 : Math.round(Math.max(-1, Math.min(1, x)) * 0x7fff));
  setInterval(() => {
    if (!st.ready || document.visibilityState === 'hidden') return;
    const pad = controls.pickPad(navigator.getGamepads?.() || [], padCfg?.device || null);
    padRec.see(pad, padButtons, controls.appHasPad());
    if (!pad) {
      if (inp.pad || inp.lx || inp.ly || inp.rx || inp.ry) Object.assign(inp, { pad: 0, lx: 0, ly: 0, rx: 0, ry: 0 }), sendInput();
      return;
    }
    let bits = 0;
    for (const [btn, label] of Object.entries(padButtons)) {
      const i = IDX[label];
      if (i !== undefined && pad.buttons[i]?.pressed) bits |= 1 << BIT[btn];
    }
    // the app's menus have the controller (lib/padnav.mjs): no buttons, sticks centred
    const [lx = 0, ly = 0, rx = 0, ry = 0] = controls.appHasPad() ? [] : pad.axes;
    inp.pad = controls.appHasPad() ? 0 : bits;
    inp.lx = axis(lx);
    inp.ly = axis(ly);
    inp.rx = axis(rx);
    inp.ry = axis(ry);
    for (const m of controls.padHotkeyPresses(pad, padActions, held, controls.appHasPad())) post(m);
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
  /** Diagnostics: the controller settings this page plays with, the device it picked and the last presses. */
  padInfo: () => padRec.info(padCfg, padButtons),
  system: () => '3ds',
  locateRam() {},
  ramInfo: () => ({ base: st.liveMemory && st.mem.length ? 0 : -1, tried: 0 }),
  read,
  /** A cheat (shared/live/cheats.mjs): a Promise – the host writes between two frames. */
  write,
  paused: () => st.paused,
  pause() {
    st.paused = true;
    cmd(CMD.SPEED, f32(0));
    tellAudio({ type: 'paused', paused: true });
  },
  resume() {
    st.paused = false;
    cmd(CMD.SPEED, f32(st.speed === Infinity ? 1000 : st.speed));
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
  /** 1–4, or Infinity: as fast as this computer can. (In fast-forward the host sends about 60 pictures a second.) */
  setSpeed(ratio) {
    st.speed = ratio === Infinity ? Infinity : Math.max(1, Number(ratio) || 1);
    if (!st.paused) cmd(CMD.SPEED, f32(st.speed === Infinity ? 1000 : st.speed));
    tellAudio({ type: 'speed', ratio: Math.min(st.speed, MAX_SOUND_RATIO) });
  },
  speed: () => st.speed,
  setFullTurbo() {}, // the native host always runs fast-forward at full power
  /** Settings › Controls / Controller changed while the game runs: { controls, pads } as in config. */
  setControls(config) {
    applyControls(config);
  },
  /**
   * Emulated frames so far – the host's count (four times a second), not the pictures that arrived: in fast-forward
   * the host sends only about 60 pictures a second, and counting those made every step look like 1× to the play view
   * (lib/reach.mjs then offered only 1× and 4×).
   */
  frames: () => (st.hostFrames ? st.hostFrame : st.frames),
  fastForward: () => st.speed > 1,
  ffRatio: () => (st.speed > 1 ? st.speed : 3),
  /** A save state (the host serializes between two frames). */
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
  /** What plays while fast-forwarding: 'music' | 'mute' | 'original' | 'plain' (as the fast player). */
  setTurboAudio(mode) {
    st.turboAudio = mode;
    tellAudio({ type: 'mode', mode });
  },
  /** The music the game plays now (location.mjs musicKey), when the live reader knows it: the turbo mixer follows it. */
  songKey(key) {
    if (!key || key === audio.key) return;
    audio.key = key;
    tellAudio({ type: 'song', key });
  },
  /** The mixer's last state changes (diagnostics). */
  /** Every mixer event from now on (the page keeps them for "Save diagnostics"); returns the unsubscribe. */
  onAudio(f) {
    audio.subs.add(f);
    return () => audio.subs.delete(f);
  },
  turboAudio: () => ({ mode: st.turboAudio, key: audio.key, events: audio.events.slice(-10) }),
  /** Tests: what the mixer plays right now ({ playing, turbo, key, … }), or null without sound. */
  audioProbe() {
    if (!audio.node) return Promise.resolve(null);
    return new Promise((res) => {
      audio.probes.push(res);
      tellAudio({ type: 'probe' });
      setTimeout(() => res(null), 2000);
    });
  },
  /**
   * Tests, diagnostics: a recording of what the sound worklet plays over the next `seconds` (before the volume) –
   * { sampleRate, l, r, ring } (ring: the buffer's numbers, lib/jitterring.mjs) – or null without sound.
   */
  audioTap(seconds = 10) {
    if (!audio.node) return Promise.resolve(null);
    return new Promise((res) => {
      audio.taps.push(res);
      tellAudio({ type: 'tap', frames: Math.round(audio.ctx.sampleRate * seconds) });
      setTimeout(() => res(null), seconds * 1000 + 5000);
    });
  },
  perf: () => ({
    fps: st.fps, speed: st.hostSpeed, frames: st.hostFrame, shown: st.frames, title: st.title, liveMemory: st.liveMemory, error: st.error, renderer: st.renderer, log: st.log.slice(-20),
    sound: audio.ctx ? { contextRate: audio.ctx.sampleRate, state: audio.ctx.state, baseLatencyMs: +(audio.ctx.baseLatency * 1000).toFixed(1), outputLatencyMs: +((audio.ctx.outputLatency || 0) * 1000).toFixed(1) } : null,
    last: audio.last,
  }),
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
  /** The screen layout (shared/ctrlayout.mjs CTR_LAYOUTS) or the smooth filter: applied right away, no restart. */
  setOption(k, v) {
    if (k === 'ctr_layout' && CTR_LAYOUTS.includes(v)) {
      layoutId = v;
      if (inp.touch) lift();
      drawFrame();
    } else if (k === 'ctr_smooth') {
      smooth = !!v;
      applyFilter();
      drawFrame();
    }
  },
  layout: () => layoutId,
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
    applyControls(status?.config);
    startPads();
  } catch (e) {
    st.log.push(`controls: ${e.message}`);
  }
  const res = await fetch('/api/ctr/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
    // (no ?scale=: the server takes Settings › Emulators › "3DS resolution")
    body: JSON.stringify({ rom: q.get('rom'), key: q.get('key'), ...(q.get('scale') ? { scale: Number(q.get('scale')) } : {}) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return showError(serverErrorText(j, res.status), j.code || null);
  st.id = j.id;
  st.liveMemory = !!j.liveMemory;
  st.renderer = j.renderer || null;
  const stop = () => fetch('/api/ctr/stop', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: st.id }) }).catch(() => {});
  addEventListener('pagehide', stop);
  pump().catch((e) => {
    st.ended = true;
    waiters.state.splice(0).forEach((f) => f(null));
    waiters.loaded.splice(0).forEach((f) => f(false));
    [...waiters.written.values()].forEach((f) => f(false));
    showError(t('ctr.failed', 'The 3DS game can’t run: {why}', { why: e.message }));
  });
}
start();
