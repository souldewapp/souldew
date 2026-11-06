import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurboMixer } from '../web/lib/turboaudio.mjs';
import { MixerChains } from '../web/lib/turbochain.mjs';

// A stand-in for the Web Audio graph of player.html: gains, the mixer node, contexts that run until they are closed.
// Each block, every running context pulls its destination; a closed context makes no sound and runs no mixer.
const SR = 16000;
const B = 128;

class Node {
  constructor(ctx, kind, extra = {}) {
    Object.assign(this, { ctx, kind, outs: new Set(), ins: new Set(), at: -1, buf: new Float32Array(B) }, extra);
  }
  connect(d) {
    this.outs.add(d);
    d.ins.add(this);
    return d;
  }
  disconnect() {
    for (const d of this.outs) d.ins.delete(this);
    this.outs.clear();
  }
}
class Ctx {
  constructor() {
    this.state = 'running';
    this.destination = new Node(this, 'dest');
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}
let block = 0;
/** The node's output for the current block. */
function pull(n) {
  if (n.at === block) return n.buf;
  n.at = block;
  const sum = new Float32Array(B);
  for (const i of n.ins) {
    const o = pull(i);
    for (let k = 0; k < B; k++) sum[k] += o[k];
  }
  if (n.kind === 'source') n.buf.set(n.sound);
  else if (n.kind === 'mixer') {
    const r = new Float32Array(B);
    n.mixer.process(sum, sum, n.buf, r, B);
  } else n.buf = sum.map((x) => x * (n.gain ?? 1));
  return n.buf;
}
/** One block: the core's sound per OpenAL context (or silence), what all running contexts play together. */
function render(sounds) {
  block++;
  for (const [al, f] of sounds) for (let k = 0; k < B; k++) al.gain.sound[k] = f ? f(al.t++) : 0;
  const out = new Float32Array(B);
  for (const ctx of new Set([...sounds.keys()].map((al) => al.audioCtx))) {
    if (ctx.state !== 'running') continue;
    const o = pull(ctx.destination);
    for (let k = 0; k < B; k++) out[k] += o[k];
  }
  return out;
}
function play(sounds, seconds) {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i += B) out.set(render(sounds).subarray(0, Math.min(B, out.length - i)), i);
  return out;
}
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / (a.length || 1));

/** Emscripten's alcCreateContext: a new AudioContext whose gain feeds the speakers. */
function newAl() {
  const ctx = new Ctx();
  const gain = new Node(ctx, 'source', { sound: new Float32Array(B) });
  gain.connect(ctx.destination);
  return { audioCtx: ctx, gain, t: 0 };
}
/** player.html's attachAudio + routeAudio for one OpenAL context. */
function attach(chains, al, inUse) {
  const id = chains.nextId();
  const ctx = al.audioCtx;
  const mixer = new TurboMixer(SR, { seconds: 30 });
  const node = new Node(ctx, 'mixer', { mixer, port: { onmessage: () => {} } });
  const vol = new Node(ctx, 'gain', { gain: 1 });
  vol.connect(ctx.destination);
  const post = (m) => mixer.command(m);
  chains.adopt({ id, al, node, vol, post }, inUse);
  al.gain.disconnect();
  al.gain.connect(node);
  node.connect(vol);
  return { post, mixer, node };
}
// a little tune that repeats every 3.2 s (a loop for the mixer to find)
const tune = (t) => 0.3 * Math.sin((2 * Math.PI * 220 * 2 ** (Math.floor(t / (0.2 * SR)) % 7 / 12) * t) / SR);

test('the core rebuilds its audio during fast-forward: the old mixer is taken down, mute and 1× reach the one that plays', () => {
  const chains = new MixerChains();
  const A = newAl();
  const a = attach(chains, A, () => false);
  play(new Map([[A, tune]]), 12);
  a.post({ type: 'speed', ratio: 3 });
  const ff = play(new Map([[A, (t) => tune(3 * t)]]), 0.5);
  assert.ok(rms(ff.subarray(SR * 0.2)) > 0.05, 'the loop plays');
  // a lost WebGL context: OpenAL makes a new AudioContext and drops the old one without closing it
  const Bal = newAl();
  const b = attach(chains, Bal, (al) => al === Bal);
  assert.equal(A.audioCtx.state, 'closed', 'the context the core left behind is closed');
  assert.equal(A.gain.outs.size, 0, 'nothing of the old chain is wired up any more');
  assert.equal(a.node.port.onmessage, null, 'the old mixer has nothing more to say');
  assert.deepEqual(chains.counts(), { live: 1, made: 2, closedContexts: 1 });
  const sounds = new Map([[A, null], [Bal, (t) => tune(3 * t)]]);
  b.post({ type: 'speed', ratio: 3 });
  play(sounds, 1);
  // back to 1×: only the game's own sound, from the new context
  b.post({ type: 'speed', ratio: 1 });
  sounds.set(Bal, tune);
  const back = play(sounds, 1);
  const from = Bal.t - back.length;
  let err = 0;
  for (let i = Math.round(0.3 * SR); i < back.length; i++) err = Math.max(err, Math.abs(back[i] - tune(from + i)));
  assert.ok(err < 1e-6, `the game's sound and nothing else (off by ${err})`);
  // "Mute": fast-forward is silent – everywhere
  b.post({ type: 'mode', mode: 'mute' });
  b.post({ type: 'speed', ratio: 3 });
  sounds.set(Bal, (t) => tune(3 * t));
  const muted = play(sounds, 1);
  assert.equal(rms(muted.subarray(Math.round(0.15 * SR))), 0, 'silent');
});

test('a chain whose context the core still uses hands its sound back to the speakers instead of cutting it off', () => {
  const chains = new MixerChains();
  const A = newAl();
  attach(chains, A, () => false);
  const Bal = newAl();
  attach(chains, Bal, () => true); // (both contexts still alive)
  assert.equal(A.audioCtx.state, 'running');
  assert.ok(A.gain.outs.has(A.audioCtx.destination), 'straight to the speakers (player.html gates that connection)');
  assert.deepEqual(chains.counts(), { live: 1, made: 2, closedContexts: 0 });
});
