import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioRing, TurboMixer, coarseLag, refineLag, runAll } from '../web/lib/turboaudio.mjs';

const SR = 16000;
const BLOCK = 128;

// A little tune: sine notes with soft attack/decay on a 0.2 s grid, the whole pattern repeating exactly
// every `period` seconds – like a town theme. `seed` picks the notes.
function tune({ period = 6.4, seed = 1, gain = 0.3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const step = Math.round(0.2 * SR);
  const steps = Math.round((period * SR) / step);
  const notes = Array.from({ length: steps }, () => 220 * 2 ** (Math.floor(rnd() * 15) / 12));
  const loud = Array.from({ length: steps }, () => 0.4 + rnd() * 0.6);
  const P = steps * step;
  return (t) => {
    const p = ((t % P) + P) % P;
    const k = Math.floor(p / step);
    const x = (p - k * step) / SR;
    const env = Math.min(1, x / 0.005) * Math.exp(-x * 6);
    return gain * loud[k] * env * Math.sin(2 * Math.PI * notes[k] * x);
  };
}

/** Feeds `seconds` of input (fn(t) per absolute sample t, or null for no input) and returns the output. */
function feed(mixer, fn, from, seconds) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const l = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  for (let i = 0; i < n; i += BLOCK) {
    if (fn) for (let j = 0; j < BLOCK; j++) l[j] = fn(from + i + j);
    mixer.process(fn ? l : null, null, oL, oR, BLOCK);
    out.set(oL.subarray(0, Math.min(BLOCK, n - i)), i);
  }
  return out;
}

/** The sped-up sound RetroArch plays at `ratio` (audio_fastforward_speedup) for the music f. */
const sped = (f, ratio, from = 0) => (i) => f(from + ratio * i);
// sound during fast-forward that is no music the tests care about, but no silence either
const junk = (i) => 0.3 * Math.sin(i * 0.37) * Math.sin(i * 0.011);
/** Correlation of out[a..b) with f(t0 + i). */
function corr(out, f, t0, a, b) {
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = a; i < b; i++) {
    const y = f(t0 + i);
    xy += out[i] * y;
    xx += out[i] * out[i];
    yy += y * y;
  }
  return xy / Math.sqrt(xx * yy || 1);
}
/** Best correlation of out[a..b) with f, allowing the output to lag by up to `shift` samples. */
const lagCorr = (out, f, a, b, shift = 2048) => {
  let best = -1;
  for (let d = 0; d <= shift; d++) best = Math.max(best, corr(out, f, -d, a, b));
  return best;
};
/** Best correlation of out[a..b) with f, the output running up to `ahead` samples ahead of f(i). */
const shiftCorr = (out, f, a, b, ahead) => {
  let best = -1;
  for (let d = 0; d <= ahead; d++) best = Math.max(best, corr(out, f, d, a, b));
  return best;
};
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const maxJump = (a) => {
  let m = 0;
  for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
};

test('AudioRing keeps the newest samples and wraps around', () => {
  const ring = new AudioRing(10);
  ring.push(Float32Array.from([1, 2, 3, 4, 5, 6, 7]));
  ring.push(Float32Array.from([8, 9, 10, 11, 12, 13, 14]), Float32Array.from([8, 9, 10, 11, 12, 13, 14]).map((x) => -x));
  assert.equal(ring.written, 14);
  assert.equal(ring.oldest, 4);
  assert.ok(ring.has(4, 14));
  assert.ok(!ring.has(3, 14));
  assert.ok(!ring.has(5, 15));
  assert.deepEqual([...ring.mono(4, 3)], [5, 6, 7]); // left = right in the first push
  assert.deepEqual([...ring.mono(10, 4)], [0, 0, 0, 0]); // left = −right in the second
  ring.push(new Float32Array(25).map((_, i) => i));
  assert.equal(ring.written, 39);
  assert.deepEqual([...ring.mono(29, 10)], [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
});

test('coarseLag finds the period of a repeating envelope and prefers the longest match', () => {
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pattern = Array.from({ length: 37 }, () => rnd() * 3);
  const n = 300;
  const fe = Float32Array.from({ length: n }, (_, i) => pattern[i % 37] + rnd() * 0.05);
  const fd = Float32Array.from({ length: n }, (_, i) => pattern[(i + 5) % 37] * 0.5);
  const res = runAll(coarseLag([fe, fd], n, { minLag: 20, win: 40 }));
  assert.ok(res.score > 0.95, `score ${res.score}`);
  assert.equal(res.lag % 37, 0);
  assert.equal(res.lag, 37 * Math.floor((n - 40) / 37)); // the longest multiple that fits
});

test('coarseLag gives up on a flat envelope', () => {
  const flat = new Float32Array(200).fill(-2);
  assert.equal(runAll(coarseLag([flat, flat], 200, { minLag: 20, win: 40 })), null);
});

test('refineLag aligns a coarse guess to the sample', () => {
  const f = tune({ period: 3.2 });
  const ring = new AudioRing(SR * 20);
  const block = new Float32Array(SR * 12);
  for (let i = 0; i < block.length; i++) block[i] = f(i);
  ring.push(block);
  const P = 3.2 * SR;
  const res = runAll(refineLag(ring, ring.written, P - 300));
  assert.equal(res.lag, P);
  assert.ok(res.corr > 0.99);
});

test('music mode: fast-forward continues the recorded tune seamlessly, then hands back to the game', () => {
  const f = tune({ period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 30 });
  let t = 0;
  const pre = feed(m, f, t, 16);
  t += pre.length;
  assert.ok(m.found, 'a loop was found while playing at 1×');
  assert.equal(m.found.lag % (6.4 * SR), 0, `lag ${m.found.lag}`);
  m.command({ type: 'speed', ratio: 3 });
  // the game's own sound is now the same tune, sped up (RetroArch's audio_fastforward_speedup)
  const during = feed(m, sped(f, 3, t), 0, 8);
  // after the 80 ms crossfade the output is exactly how the tune goes on
  const from = Math.round(0.1 * SR);
  let err = 0;
  for (let i = from; i < during.length; i++) err = Math.max(err, Math.abs(during[i] - f(t + i)));
  assert.ok(err < 1e-3, `max deviation ${err}`);
  assert.ok(maxJump(during) < 0.2, 'no click at the switch');
  assert.ok(m.carry && !m.carry.stream, 'still the recorded loop – the same song was recognised');
  t += during.length;
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, f, t, 1);
  // hold (0.15 s) + crossfade (0.08 s), then the game's sound again
  const live = Math.round(0.25 * SR);
  for (let i = live; i < back.length; i++) assert.ok(Math.abs(back[i] - f(t + i)) < 1e-6);
  assert.ok(maxJump(back) < 0.2, 'no click when switching back');
  assert.equal(m.voice, null);
});

test('mute mode silences fast-forward and fades back in', () => {
  const f = tune();
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'mode', mode: 'mute' });
  feed(m, f, 0, 10);
  m.command({ type: 'speed', ratio: 2 });
  const during = feed(m, f, 0, 2);
  assert.ok(rms(during.subarray(Math.round(0.1 * SR))) === 0);
  assert.ok(maxJump(during) < 0.2);
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, f, 0, 1);
  assert.ok(rms(back.subarray(0, Math.round(0.14 * SR))) === 0, 'stays quiet while sped-up sound drains');
  assert.ok(rms(back.subarray(Math.round(0.3 * SR))) > 0.05);
});

test('original mode passes the sped-up sound through', () => {
  const f = tune();
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'mode', mode: 'original' });
  feed(m, f, 0, 8);
  m.command({ type: 'speed', ratio: 4 });
  const during = feed(m, f, 1000, 1);
  for (let i = 0; i < during.length; i++) assert.ok(Math.abs(during[i] - f(1000 + i)) < 1e-6);
});

test('too little recorded (fresh start) → fast-forward plays the game’s music slowed back to normal speed', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 3);
  m.command({ type: 'speed', ratio: 3 });
  const f = tune({ seed: 9 });
  const during = feed(m, sped(f, 3), 0, 2);
  // the first 0.25 s after the switch are left out (still at the old speed), so the song is a little ahead
  assert.ok(shiftCorr(during, f, Math.round(0.5 * SR), SR, Math.round(0.6 * SR)) > 0.95, 'normal pitch and tempo');
});

test('a long silence (area change) drops the old music', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  let t = 0;
  t += feed(m, tune({ seed: 1 }), t, 14).length;
  t += feed(m, () => 0, t, 1).length;
  feed(m, tune({ seed: 5 }), t, 3);
  m.command({ type: 'speed', ratio: 3 });
  const f = tune({ seed: 9 });
  const during = feed(m, sped(f, 3), 0, 2);
  assert.ok(shiftCorr(during, f, Math.round(0.5 * SR), SR, Math.round(0.6 * SR)) > 0.95, 'the new music, not the old loop');
});

test('the music changes during fast-forward → the old loop stops, the new song plays and becomes the loop', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const B = tune({ seed: 7, period: 4 });
  const m = new TurboMixer(SR, { seconds: 60 });
  let t = 0;
  t += feed(m, A, t, 16).length;
  m.command({ type: 'speed', ratio: 3 });
  // still song A (sped up): the loop goes on exactly as A does
  const a = feed(m, sped(A, 3, t), 0, 2);
  assert.ok(corr(a, A, t, Math.round(0.2 * SR), a.length) > 0.99);
  const tB = t + a.length; // where A would be now
  // a door: 0.5 s of silence in the sped-up sound (1.5 s in the game), then song B
  const quiet = feed(m, () => 0, 0, 0.5);
  assert.ok(rms(quiet.subarray(quiet.length - Math.round(0.05 * SR))) < 1e-3, 'old loop faded out');
  const b = feed(m, sped(B, 3), 0, 6);
  // (it starts a few hundred samples late: song B is noticed once its first analysis frame is complete)
  assert.ok(lagCorr(b, B, Math.round(0.2 * SR), Math.round(1.2 * SR)) > 0.95, 'song B at normal speed right away');
  assert.ok(Math.abs(corr(b, A, tB, Math.round(0.2 * SR), Math.round(2 * SR))) < 0.3, 'not song A any more');
  assert.ok(m.carry && !m.carry.stream, 'B got its own loop');
  assert.ok(Math.abs(m.carry.lag - 4 * SR) < 0.01 * SR, `loop ${m.carry.lag / SR} s`);
  assert.ok(maxJump(b) < 0.2, 'no clicks');
});

test('short 1× stretches between fast-forwards reuse the previous loop', () => {
  const f = tune({ period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, f, 0, 16);
  m.command({ type: 'speed', ratio: 3 });
  feed(m, junk, 0, 2);
  m.command({ type: 'speed', ratio: 1 });
  feed(m, f, 50000, 2); // only 2 s at 1× – not enough for a loop of its own
  m.command({ type: 'speed', ratio: 3 });
  const during = feed(m, junk, 0, 2);
  assert.ok(rms(during.subarray(Math.round(0.1 * SR))) > 0.03);
});

test('pausing during fast-forward fades the loop out, resuming fades it back in', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 16);
  m.command({ type: 'speed', ratio: 3 });
  feed(m, junk, 0, 0.5);
  m.command({ type: 'paused', paused: true });
  const paused = feed(m, null, 0, 1);
  assert.equal(rms(paused.subarray(Math.round(0.1 * SR))), 0);
  assert.ok(maxJump(paused) < 0.2);
  m.command({ type: 'paused', paused: false });
  const resumed = feed(m, junk, 0, 1);
  assert.ok(rms(resumed.subarray(Math.round(0.1 * SR))) > 0.03);
});

test('no sound from the core at all – nothing breaks', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const out = feed(m, null, 0, 6);
  assert.equal(rms(out), 0);
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(rms(feed(m, null, 0, 1)), 0);
  m.command({ type: 'speed', ratio: 1 });
  assert.equal(rms(feed(m, null, 0, 1)), 0);
});

test('switching the mode during fast-forward takes effect right away, without clicks', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'mode', mode: 'mute' });
  feed(m, tune(), 0, 16);
  m.command({ type: 'speed', ratio: 2 });
  assert.equal(rms(feed(m, junk, 0, 0.5).subarray(Math.round(0.1 * SR))), 0);
  m.command({ type: 'mode', mode: 'music' });
  const music = feed(m, junk, 0, 1);
  assert.ok(rms(music.subarray(Math.round(0.1 * SR))) > 0.03);
  assert.ok(maxJump(music) < 0.2);
  m.command({ type: 'mode', mode: 'original' });
  const orig = feed(m, (i) => 0.1 * Math.sin(i * 0.05), 0, 0.5);
  for (let i = Math.round(0.1 * SR); i < orig.length; i++) assert.ok(Math.abs(orig[i] - 0.1 * Math.sin(i * 0.05)) < 1e-6);
});

test('a loaded state forgets the recording', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  feed(m, tune(), 0, 16);
  m.command({ type: 'cut' });
  feed(m, tune({ seed: 4 }), 0, 2);
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(rms(feed(m, null, 0, 1).subarray(Math.round(0.1 * SR))), 0);
});

test('a song without a loop during a long fast-forward jumps ahead instead of running out of the ring', () => {
  const m = new TurboMixer(SR, { seconds: 10 });
  m.command({ type: 'speed', ratio: 4 });
  const sweep = tune({ period: 120, seed: 3 }); // no repeat within the ring
  let jumps = 0;
  m.onEvent = (e) => e.type === 'stream' && e.jump && jumps++;
  const out = feed(m, sped(sweep, 4), 0, 8); // 32 s of game time through a 10 s ring
  assert.ok(jumps >= 1, 'jumped ahead');
  assert.ok(rms(out.subarray(out.length - SR)) > 0.05, 'still playing at the end');
  assert.ok(maxJump(out) < 0.2, 'no clicks');
});

// ---- speed changes as the real emulator delivers them --------------------------------------------------------
// Measured in the app (Silver, Gambatte, 48 kHz, recorded at the worklet's input): OpenAL still plays ~60 ms of
// sound made at the old speed after a switch; changing the step while fast-forwarding (2× → 3×) switches
// fast-forward off for ~70 ms (player.html's re-toggle), so that stretch is 1× sound; and after fast-forward
// switches on, OpenAL runs dry for a few hundred ms – holes of 0.5–12 ms of digital silence in sound that
// otherwise goes on without a jump (the samples come late, not lost).

/**
 * The emulator's sound for a speed schedule: `music(c)` at content position c, which advances by the speed the
 * emulator ran at `lat` samples earlier; holes after every switch into fast-forward. Returns fn(i) for feed().
 */
function emulator(music, schedule, { lat = Math.round(0.06 * SR), dip = Math.round(0.07 * SR), holes = true } = {}) {
  // speed per real sample, from [[atSample, ratio], …]
  const speedAt = [];
  const hole = new Set();
  let prev = 1;
  for (const [at, ratio] of schedule) {
    speedAt.push([at, prev > 1 && ratio > 1 && ratio !== prev ? 1 : ratio]);
    if (prev > 1 && ratio > 1 && ratio !== prev) speedAt.push([at + dip, ratio]);
    if (ratio > 1 && holes) {
      // a burst of holes 60–360 ms after the switch (where the measurement had them)
      let s = (at * 7 + 3) % 1000;
      for (let t = at + lat; t < at + lat + Math.round(0.3 * SR); ) {
        s = (s * 1103 + 13) % 10007;
        const len = 8 + (s % 190);
        for (let k = 0; k < len; k++) hole.add(t + k);
        t += len + 200 + (s % 900);
      }
    }
    prev = ratio;
  }
  let c = 0;
  let last = -1;
  let k = 0;
  const speed = (t) => {
    while (k + 1 < speedAt.length && speedAt[k + 1][0] <= t) k++;
    return t < speedAt[0][0] ? 1 : speedAt[k][1];
  };
  return (i) => {
    if (i <= last) throw new Error('emulator() is sequential');
    for (let t = last + 1; t <= i; t++) if (!hole.has(t)) c += speed(t - lat);
    last = i;
    return hole.has(i) ? 0 : music(c);
  };
}

/** Feeds `fn` from absolute sample `from` (one call per sample, in order), commands at their sample positions. */
function play(m, fn, from, seconds, commands = [], onBlock = null) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const l = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK);
  const oR = new Float32Array(BLOCK);
  let ci = 0;
  for (let i = 0; i < n; i += BLOCK) {
    while (ci < commands.length && commands[ci][0] <= from + i) m.command({ type: 'speed', ratio: commands[ci++][1] });
    for (let j = 0; j < BLOCK; j++) l[j] = fn(from + i + j);
    onBlock?.(i);
    m.process(l, null, oL, oR, BLOCK);
    out.set(oL.subarray(0, Math.min(BLOCK, n - i)), i);
  }
  return out;
}

const F0 = 440;
const sine = (c) => 0.3 * Math.sin((2 * Math.PI * F0 * c) / SR);
/**
 * THD+N of a 440 Hz sine per 20 ms window, in dB: the share of the window that is not the tone (best-fit
 * amplitude and phase). Windows that are (nearly) silent are skipped – fades are not distortion.
 */
function thdWindows(out, a, b) {
  const W = Math.round(0.02 * SR);
  const res = [];
  for (let s = a; s + W <= b; s += W) {
    let ss = 0;
    let cc = 0;
    let sc = 0;
    let ys = 0;
    let yc = 0;
    let yy = 0;
    for (let i = s; i < s + W; i++) {
      const w = (2 * Math.PI * F0 * i) / SR;
      const si = Math.sin(w);
      const co = Math.cos(w);
      ss += si * si;
      cc += co * co;
      sc += si * co;
      ys += out[i] * si;
      yc += out[i] * co;
      yy += out[i] * out[i];
    }
    const det = ss * cc - sc * sc;
    const p = (ys * cc - yc * sc) / det;
    const q = (yc * ss - ys * sc) / det;
    const fit = p * ys + q * yc; // energy of the best-fit tone
    if (yy / W < 0.01 ** 2) continue;
    res.push({ at: s / SR, db: 10 * Math.log10(Math.max(1e-12, yy - fit) / yy) });
  }
  return res;
}
/** Longest run of exact zeros in out[a..b). */
function zeroRun(out, a, b) {
  let m = 0;
  let c = 0;
  for (let i = a; i < b; i++) {
    c = out[i] === 0 ? c + 1 : 0;
    m = Math.max(m, c);
  }
  return m;
}
const worst = (w) => w.reduce((m, x) => (x.db > m.db ? x : m), { db: -Infinity });
const bad = (w, db = -30) => w.filter((x) => x.db > db);
// the steepest a 0.3 sine at 440 Hz gets from one sample to the next – a click is a jump well beyond it
const SLOPE = 0.3 * 2 * Math.PI * (F0 / SR);

test('speed changes without a loop: the slowed-down music has no holes, no wrong-pitch stretches, no clicks', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const S = (s) => Math.round(s * SR);
  const sched = [[S(2), 2], [S(5), 3], [S(8), 4], [S(11), 1]];
  const emu = emulator(sine, sched);
  play(m, emu, 0, 2); // 2 s at 1×: too short for a loop of its own
  let found = Infinity;
  let t = 0;
  m.onEvent = (e) => (e.type === 'found' || e.jump) && (found = Math.min(found, t));
  const out = play(m, emu, S(2), 9, sched.slice(0, 3), (i) => (t = i));
  // from the moment the slowed-down music plays until a loop is found in it or it jumps ahead (both fade out and in)
  const end = Math.min(out.length, found);
  assert.ok(end > S(8), 'the stream played through both step changes');
  const w = thdWindows(out, S(0.6), end);
  const holes = zeroRun(out, S(0.6), end);
  assert.ok(holes < 8, `holes of ${holes} samples of silence in the music`);
  // each step change skips a little of the song: a 5 ms crossfade, on a pure tone one or two windows with a dip
  assert.ok(bad(w).length <= 4 && worst(w).db < -10, `${bad(w).length} distorted windows, worst ${worst(w).db.toFixed(1)} dB at ${worst(w).at.toFixed(2)} s`);
  assert.ok(maxJump(out) < SLOPE * 1.6, `click: jump ${maxJump(out).toFixed(3)}`);
});

test('the start of fast-forward without a loop: holes in the sped-up sound are not played as silence', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const S = (s) => Math.round(s * SR);
  const sched = [[S(3), 3]];
  const emu = emulator(sine, sched);
  play(m, emu, 0, 3);
  const out = play(m, emu, S(3), 3, sched);
  const w = thdWindows(out, S(0.6), out.length);
  assert.ok(zeroRun(out, S(0.6), out.length) < 8, `hole of ${zeroRun(out, S(0.6), out.length)} samples`);
  assert.ok(bad(w).length === 0, `${bad(w).length} distorted windows, worst ${worst(w).db.toFixed(1)} dB at ${worst(w).at.toFixed(2)} s`);
  assert.ok(maxJump(out) < SLOPE * 1.6, `click: jump ${maxJump(out).toFixed(3)}`);
});

test('rapid toggling 1×/4×/2×/1×/3× stays click-free and bounded', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const S = (s) => Math.round(s * SR);
  const sched = [[S(2), 4], [S(2.3), 1], [S(2.6), 2], [S(2.9), 1], [S(3.2), 3], [S(3.5), 4], [S(3.8), 1], [S(4.1), 2]];
  const emu = emulator(sine, sched);
  play(m, emu, 0, 2);
  const out = play(m, emu, S(2), 4, sched);
  let peak = 0;
  for (const x of out) {
    assert.ok(Number.isFinite(x));
    peak = Math.max(peak, Math.abs(x));
  }
  assert.ok(peak <= 0.3 * 1.05, `peak ${peak}`);
  assert.ok(maxJump(out) < SLOPE * 1.6, `click: jump ${maxJump(out).toFixed(3)}`);
});

test('a speed change while the loop plays keeps the loop (the re-toggle hiccup is no song change)', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 60 });
  const S = (s) => Math.round(s * SR);
  const sched = [[S(16), 2], [S(17), 3], [S(18), 4], [S(19), 2]];
  const emu = emulator(A, sched, { holes: true });
  let changed = 0;
  m.onEvent = (e) => e.changed && changed++;
  play(m, emu, 0, 16);
  assert.ok(m.found);
  const out = play(m, emu, S(16), 4, sched);
  assert.equal(changed, 0, 'no song change detected');
  assert.ok(m.carry && !m.carry.stream, 'still the loop');
  assert.ok(corr(out, A, S(16), S(0.2), out.length) > 0.99, 'the loop goes on exactly as the tune does');
});

// DeSmuME (HeartGold, measured in the app, threaded or not, any audio_latency): the sped-up sound comes in pieces
// of ~280 samples with holes between them (40–47 % of the time, ~75 per second), and the pieces don't join up.
/** The emulator's sped-up sound as DeSmuME delivers it: `music` at `ratio`, chopped, with sound lost at every hole. */
function choppy(music, ratio, from = 0) {
  const piece = Math.round((280 / 48000) * SR);
  const hole = Math.round((230 / 48000) * SR);
  return (i) => {
    const k = i % (piece + hole);
    return k < piece ? music(from + ratio * i) : 0;
  };
}

test('DS: chopped sped-up sound is not slowed down into buzz – without a loop it stays quiet', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  play(m, sine, 0, 2);
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, choppy(sine, 3, 2 * SR), 0, 3);
  assert.ok(rms(out.subarray(SR)) < 1e-3, `rms ${rms(out.subarray(SR))}`);
  assert.ok(maxJump(out.subarray(Math.round(0.1 * SR))) < SLOPE * 1.6, 'no click once the game’s own (chopped) sound is faded out');
  // back at 1× the game's own sound plays; the next fast-forward knows the sound is choppy right away
  m.command({ type: 'speed', ratio: 1 });
  feed(m, sine, 0, 1);
  m.command({ type: 'speed', ratio: 2 });
  const again = feed(m, choppy(sine, 2), 0, 1.5);
  assert.ok(rms(again.subarray(Math.round(0.3 * SR))) < 1e-3, 'no buzz at the start of the next fast-forward');
});

test('DS: the loop recorded at 1× keeps playing through chopped sped-up sound, no song change', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 30 });
  let changed = 0;
  m.onEvent = (e) => e.changed && changed++;
  const t = feed(m, A, 0, 16).length;
  assert.ok(m.found);
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, choppy(A, 3, t), 0, 4);
  assert.equal(changed, 0);
  assert.ok(corr(out, A, t, Math.round(0.2 * SR), out.length) > 0.99, 'the loop goes on as the tune does');
});

/** Longest run of near-silence (|x| < 1e-4) in out[a..b), in seconds. */
function longestQuiet(out, a, b) {
  let m = 0;
  let c = 0;
  for (let i = a; i < b; i++) {
    c = Math.abs(out[i]) < 1e-4 ? c + 1 : 0;
    m = Math.max(m, c);
  }
  return m / SR;
}

test('DS without a loop: a music bed from the 1× recording keeps the music going, also through a song change, hands back', () => {
  const A = tune({ seed: 5, period: 120 }); // no repeat within the recording: no loop, only a bed
  const m = new TurboMixer(SR, { seconds: 60 });
  const ev = [];
  m.onEvent = (e) => ev.push(e);
  let t = feed(m, A, 0, 25).length;
  assert.ok(!m.found && m.bed, 'a bed, no loop');
  assert.ok(m.bed.lag >= 12 * SR && m.bed.xfade === 2 * SR, `bed ${m.bed.lag / SR} s, crossfade ${m.bed.xfade / SR} s`);
  // first fast-forward: the sound turns out to be choppy within half a second, then the bed plays
  m.command({ type: 'speed', ratio: 3 });
  const first = feed(m, choppy(A, 3, t), 0, 20);
  assert.ok(ev.some((e) => e.type === 'turbo' && e.bed), 'the bed took over');
  assert.ok(longestQuiet(first, Math.round(0.8 * SR), first.length) < 0.05, `quiet for ${longestQuiet(first, Math.round(0.8 * SR), first.length)} s`);
  assert.ok(maxJump(first.subarray(Math.round(0.1 * SR))) < 0.2, 'no clicks, also across the bed’s jumps');
  let peak = 0;
  for (const x of first) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak < 0.45, `peak ${peak}`);
  m.command({ type: 'speed', ratio: 1 });
  t += feed(m, A, t, 3).length;
  // the next fast-forward knows the sound is choppy: the bed starts right away and plays the music as recorded
  m.command({ type: 'speed', ratio: 2 });
  const pos0 = m.carry?.pos;
  assert.ok(m.carry?.bed, 'bed chosen at the switch');
  const second = feed(m, choppy(A, 2, t), 0, 1);
  // what the bed should play from there: the recording, blended into the stretch one jump back near its end
  const { start, end, lag, xfade } = m.carry;
  const bedAt = (i) => {
    let p = pos0 + i;
    while (p >= end) p -= lag;
    const into = p - (end - xfade);
    if (into < 0 || p < start) return A(p);
    const k = (into / xfade) * Math.PI * 0.5;
    return A(p) * Math.cos(k) + A(p - lag) * Math.sin(k);
  };
  assert.ok(corr(second, bedAt, 0, Math.round(0.1 * SR), second.length) > 0.99, 'the 1× music at its own pitch');
  // a door: the sped-up sound goes quiet, then another song (still choppy) – it can't be heard in that sound, so
  // the bed goes on rather than silence
  feed(m, () => 0, 0, 0.5);
  const after = feed(m, choppy(tune({ seed: 8 }), 2), 0, 2);
  assert.ok(ev.some((e) => e.changed && e.kept), 'song change noticed in the choppy sound');
  assert.ok(longestQuiet(after, 0, after.length) < 0.05, 'the music goes on');
  m.command({ type: 'speed', ratio: 1 });
  const back = feed(m, A, 0, 1);
  for (let i = Math.round(0.25 * SR); i < back.length; i++) assert.ok(Math.abs(back[i] - A(i)) < 1e-6);
});

// DeSmuME runs without audio_fastforward_speedup (player.html): its fast-forward sound is the song at normal pitch in
// pieces, skipping ahead (measured with HeartGold: pieces match the 1× music at normal pitch, NCC median 0.70).
/** That sound: `music` at normal pitch in pieces of `piece` samples, jumping ahead so the song runs `ratio`× fast. */
function skipping(music, ratio, from = 0, piece = Math.round(0.02 * SR)) {
  return (i) => {
    const k = Math.floor(i / piece);
    return music(from + k * piece * ratio + (i - k * piece));
  };
}
const quietWin = (out, a, b, W = Math.round(0.05 * SR)) => {
  // the longest stretch in which every 50 ms window is (nearly) silent
  let m = 0;
  for (let s = a; s + W <= b; s += W) if (rms(out.subarray(s, s + W)) < 1e-3) m++;
  return m;
};

test('DS without speed-up sound, straight into fast-forward with nothing recorded: music mode plays the skipping sound like original – never silence', () => {
  const f = tune({ seed: 5, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  feed(m, f, 0, 1); // barely any 1× sound: nothing to make a bed of
  m.command({ type: 'speed', ratio: 4 });
  const src = skipping(f, 2.7, SR); // the machine only reaches 2.7×
  const raw = Float32Array.from({ length: 4 * SR }, (_, i) => src(i));
  // the skipping sound, its jumps smoothed (1 ms late: the de-click delay) – in "music" as in "original"
  for (const [mode, from] of [['music', 0], ['original', 2 * SR]]) {
    m.command({ type: 'mode', mode });
    const out = feed(m, (i) => src(from + i), 0, 2);
    assert.equal(quietWin(out, 0, out.length), 0, `${mode}: never silent`);
    assert.ok(corr(out, (i) => src(from + i), -m.dc.D, Math.round(0.1 * SR), out.length) > 0.9, `${mode}: the game’s own sound, not stretched`);
    assert.ok(maxJump(out.subarray(Math.round(0.1 * SR))) < maxJump(raw) * 0.25, `${mode}: jumps ${maxJump(out).toFixed(3)} vs ${maxJump(raw).toFixed(3)}`);
  }
});

test('DS: fast-forward right after the start plays the skipping sound, the next one the bed recorded at 1× in between', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  let t = feed(m, A, 0, 2).length; // 2 s: too little for a bed
  m.command({ type: 'speed', ratio: 3 });
  const first = feed(m, skipping(A, 3, t), 0, 3);
  assert.equal(m.carry, null);
  assert.ok(longestQuiet(first, 0, first.length) < 0.05, `quiet for ${longestQuiet(first, 0, first.length)} s`);
  m.command({ type: 'speed', ratio: 1 });
  t += 9 * SR;
  t += feed(m, A, t, 9).length; // enough 1× music for a bed that is more than a stutter (≥ 3.5 s)
  assert.ok(m.bed, 'a bed from 9 s of music');
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.bed, 'the bed plays now');
  const out = feed(m, skipping(A, 3, t), 0, 3);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  assert.ok(m.live.t === 0, 'the skipping sound is faded out under the bed');
});

test('DS: a song change at 1× and straight back into fast-forward – the most recent song’s bed plays', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  let t = feed(m, A, 0, 9).length; // 9 s: enough for a bed that plays (≥ 3.5 s of it)
  assert.ok(m.bed, 'a bed from 9 s of music');
  t += feed(m, () => 0, t, 1).length; // a door
  t += feed(m, tune({ seed: 8, period: 120 }), t, 1).length; // the next area's song, only 1 s of it
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.bed, 'the previous song’s bed');
  const out = feed(m, skipping(A, 3, t), 0, 3);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  assert.ok(maxJump(out.subarray(Math.round(0.1 * SR))) < 0.2, 'no clicks');
});

test('DS without speed-up sound: the bed plays from the first fast-forward and goes on through a song change', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  const t = feed(m, A, 0, 25).length;
  m.command({ type: 'speed', ratio: 3 });
  assert.ok(m.carry?.bed, 'bed chosen at the switch');
  const out = feed(m, skipping(A, 3, t), 0, 3);
  assert.ok(longestQuiet(out, 0, out.length) < 0.05, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  assert.ok(m.voice?.bed && m.live.v === 0, 'only the bed is heard');
  // a door (≥0.25 s quiet in the fast-forward sound), then the next area's song: it can't be heard in the skipping
  // sound, so the bed goes on – never the skipping sound, never silence
  let changed = 0;
  m.onEvent = (e) => e.changed && e.kept && changed++;
  const B = tune({ seed: 8, period: 120 });
  const door = feed(m, () => 0, 0, 0.4);
  const next = feed(m, skipping(B, 3), 0, 2);
  assert.equal(changed, 1, 'the song change was noticed');
  assert.ok(m.voice?.bed && m.live.v === 0, 'still the bed, not the game’s sound');
  assert.ok(longestQuiet(door, 0, door.length) < 0.05 && longestQuiet(next, 0, next.length) < 0.05, 'never silent');
  assert.ok(maxJump(door) < 0.2 && maxJump(next) < 0.2);
});

test('slower than requested (4× asked, 2.7× reached): the measured speed sets the slow-down, so the pitch stays right', () => {
  const f = tune({ seed: 9 });
  const run = (rate) => {
    const m = new TurboMixer(SR, { seconds: 30 });
    feed(m, tune(), 0, 3);
    m.command({ type: 'speed', ratio: 4 });
    if (rate) m.command({ type: 'rate', ratio: rate });
    const during = feed(m, sped(f, 2.7), 0, 2);
    return shiftCorr(during, f, Math.round(0.6 * SR), Math.round(1.1 * SR), Math.round(0.8 * SR));
  };
  assert.ok(run(0) < 0.5, 'slowed down by the requested 4× the song is out of tune');
  assert.ok(run(2.7) > 0.95, 'by the measured 2.7×: normal pitch and tempo');
});

test('DS: a short new stretch of the same song does not replace the loop found before (fast-forward splits songs)', () => {
  const A = tune({ seed: 1, period: 6.4 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  let t = feed(m, A, 0, 16).length;
  const loop = m.found;
  assert.ok(loop && !loop.bed);
  m.command({ type: 'speed', ratio: 3 });
  feed(m, skipping(A, 3, t), 0, 2);
  m.command({ type: 'speed', ratio: 1 });
  t += feed(m, A, t, 5).length; // 5 s at 1×: a (poor) bed of this stretch only
  m.command({ type: 'speed', ratio: 4 });
  assert.equal(m.carry, loop, 'the good loop of the same song');
  // after a real song change, the newer recording counts
  m.command({ type: 'speed', ratio: 1 });
  t += feed(m, () => 0, t, 1).length;
  t += feed(m, tune({ seed: 8, period: 120 }), t, 9).length;
  m.command({ type: 'speed', ratio: 3 });
  // (the old song's loop plays until the search in the new song's 9 s is done, then its bed takes over)
  const out = feed(m, skipping(A, 3, t), 0, 1.5);
  assert.ok(m.carry && m.carry !== loop && m.carry.song === m.song, 'the new song’s own bed');
  assert.ok(longestQuiet(out, 0, out.length) < 0.2 && maxJump(out.subarray(Math.round(0.1 * SR))) < 0.2);
});

// --- the game says which song plays (song key from RAM) ----------------------------------------------------------

/** The tune's note per 25 ms frame (tune() picks from 15 semitones above 220 Hz): Goertzel power, the loudest wins. */
const NOTES = Array.from({ length: 15 }, (_, k) => 220 * 2 ** (k / 12));
function notes(get, n0, frames, F = Math.round(0.025 * SR)) {
  const seq = new Int8Array(frames);
  for (let j = 0; j < frames; j++) {
    let best = -1;
    let bp = 1e-6;
    for (let k = 0; k < NOTES.length; k++) {
      const c = 2 * Math.cos((2 * Math.PI * NOTES[k]) / SR);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < F; i++) {
        const s0 = get(n0 + j * F + i) + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const pw = s1 * s1 + s2 * s2 - c * s1 * s2;
      if (pw > bp) [bp, best] = [pw, k];
    }
    seq[j] = best;
  }
  return seq;
}
/** Per song: the share of out[a..b)'s note frames that follow that song's melody (best alignment over one 6.4 s period). */
const whichSong = (out, a, b, songs) => {
  const F = Math.round(0.025 * SR);
  const n = Math.floor((b - a) / F);
  const heard = notes((i) => out[i] || 0, a, n, F);
  return songs.map((f) => {
    const period = Math.round((6.4 * SR) / F);
    const ref = notes(f, 0, period + n, F);
    let best = 0;
    for (let o = 0; o < period; o++) {
      let hit = 0;
      for (let j = 0; j < n; j++) if (heard[j] >= 0 && heard[j] === ref[o + j]) hit++;
      best = Math.max(best, hit / n);
    }
    return best;
  });
};

test('song key, DeSmuME: a route change during fast-forward plays the new route’s loop from the library, an unheard one the game’s own sound', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  const C = tune({ seed: 7 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  let t = feed(m, A, 0, 14).length;
  assert.ok(m.lib.has('mA'), 'route A’s loop kept');
  m.command({ type: 'song', key: 'mB' }); // walked onto route B at 1×
  feed(m, B, 0, 14);
  assert.ok(m.lib.has('mB'));
  t = 14 * SR;
  m.command({ type: 'speed', ratio: 3 });
  let out = feed(m, skipping(B, 3, t), 0, 2);
  let [a, b] = whichSong(out, Math.round(0.3 * SR), out.length, [A, B]);
  assert.ok(b > 0.8 && a < 0.4, `route B plays (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  // back onto route A while fast-forwarding: A's music, not B's
  m.command({ type: 'song', key: 'mA' });
  out = feed(m, skipping(A, 3, 0), 0, 2);
  [a, b] = whichSong(out, Math.round(0.4 * SR), out.length, [A, B]);
  assert.ok(a > 0.8 && b < 0.4, `route A plays (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  assert.ok(longestQuiet(out, 0, out.length) < 0.25, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  // a route never played at 1×: its music is in the game's skipping sound – that plays, not A's or B's loop
  m.command({ type: 'song', key: 'mC' });
  const src = skipping(C, 3, 0);
  out = feed(m, src, 0, 2);
  assert.ok(corr(out, src, -m.dc.D, Math.round(0.4 * SR), out.length) > 0.9, 'the game’s own sound');
  assert.ok(longestQuiet(out, 0, out.length) < 0.25, `quiet for ${longestQuiet(out, 0, out.length)} s`);
  // the next fast-forward on route C after 1× there: C's own loop
  m.command({ type: 'speed', ratio: 1 });
  feed(m, C, 0, 14);
  assert.ok(m.lib.has('mC'));
  m.command({ type: 'speed', ratio: 3 });
  out = feed(m, skipping(C, 3, 14 * SR), 0, 2);
  const [, , c] = whichSong(out, Math.round(0.3 * SR), out.length, [A, B, C]);
  assert.ok(c > 0.8, `route C’s loop (${c.toFixed(2)})`);
});

test('song key, DeSmuME: fast-forward on a route not yet recorded plays its own sound, not the previous route’s bed', () => {
  const A = tune({ seed: 3, period: 120 });
  const B = tune({ seed: 8, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 10);
  assert.ok(m.lib.get('mA')?.bed, 'route A’s bed kept');
  m.command({ type: 'song', key: 'mB' });
  feed(m, B, 0, 1); // only 1 s on route B
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(m.carry, null, 'not route A’s bed');
  const src = skipping(B, 3, SR);
  const out = feed(m, src, 0, 2);
  assert.ok(corr(out, src, -m.dc.D, Math.round(0.1 * SR), out.length) > 0.9, 'route B’s own (skipping) sound');
  assert.ok(longestQuiet(out, 0, out.length) < 0.05);
});

test('song key, Gambatte: a route change during fast-forward switches to the stored loop, an unheard route streams', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  const C = tune({ seed: 7 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 14);
  m.command({ type: 'song', key: 'mB' });
  feed(m, B, 0, 14);
  assert.ok(m.lib.has('mA') && m.lib.has('mB'));
  m.command({ type: 'speed', ratio: 3 });
  feed(m, sped(B, 3, 14 * SR), 0, 1);
  m.command({ type: 'song', key: 'mA' });
  let out = feed(m, sped(A, 3, 0), 0, 2);
  const [a, b] = whichSong(out, Math.round(0.4 * SR), out.length, [A, B]);
  assert.ok(a > 0.8 && b < 0.4, `route A’s loop (A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
  // unheard route: its sped-up sound slowed back down
  m.command({ type: 'song', key: 'mC' });
  assert.equal(m.carry, null);
  out = feed(m, sped(C, 3, 0), 0, 2);
  const [, , c] = whichSong(out, Math.round(0.8 * SR), out.length, [A, B, C]);
  assert.ok(c > 0.8, `route C streamed (${c.toFixed(2)})`);
});

test('song library: bounded, least recently heard dropped, a loop is not replaced by a bed', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  m.k.libTotal = 15 * SR; // room for two 6.4 s loops
  for (const [k, seed] of [['m1', 1], ['m2', 2], ['m3', 3]]) {
    m.command({ type: 'song', key: k });
    feed(m, tune({ seed }), 0, 14);
  }
  assert.deepEqual([...m.lib.keys()], ['m2', 'm3']);
  let total = 0;
  for (const e of m.lib.values()) total += e.end;
  assert.ok(total <= m.k.libTotal);
  const loop = m.lib.get('m3');
  assert.equal(loop.bed, false);
  m.keep({ key: 'm3', bed: true, start: m.ring.written - 5 * SR, end: m.ring.written, lag: 5 * SR, xfade: SR, curve: 'power', score: 0.5, fine: 0.5 });
  assert.equal(m.lib.get('m3'), loop);
});

/** Which of `songs` a library entry holds (whichSong over its whole recording). */
const libSong = (e, songs) => whichSong(Float32Array.from(e.l, (v) => v / 32767), 0, e.end, songs);

test('song key: the first key (start, title screen) does not adopt what played before it', () => {
  const title = tune({ seed: 11 });
  const A = tune({ seed: 1 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'skip', on: true });
  feed(m, title, 0, 12); // the title screen: no key yet (RAM not found), a bed/loop of it is found
  assert.equal(m.lib.size, 0, 'nothing is kept without a key');
  m.command({ type: 'song', key: 'mA' }); // the game continues on route A
  feed(m, A, 0, 2);
  assert.ok(!m.lib.has('mA'), 'the title music is not filed as route A');
  m.command({ type: 'speed', ratio: 3 });
  const src = skipping(A, 3, 2 * SR);
  const out = feed(m, src, 0, 2);
  assert.ok(corr(out, src, -m.dc.D, Math.round(0.3 * SR), out.length) > 0.9, 'route A’s own sound, not the title music');
  m.command({ type: 'speed', ratio: 1 });
  feed(m, A, 0, 12);
  const [t, a] = libSong(m.lib.get('mA'), [title, A]);
  assert.ok(a > 0.8 && t < 0.4, `route A’s own loop (title ${t.toFixed(2)}, A ${a.toFixed(2)})`);
});

test('song key arriving late: a search reaching into the new song is dropped, the old song’s entry stays clean', () => {
  const A = tune({ seed: 1 });
  const B = tune({ seed: 2 });
  for (const phase of [0, 0.5, 1, 1.5, 2, 2.5]) {
    const m = new TurboMixer(SR, { seconds: 30 });
    m.command({ type: 'skip', on: true });
    m.command({ type: 'song', key: 'mA' });
    feed(m, A, 0, 9 + phase);
    // battle music starts at once; the key comes 0.3 s later (polled RAM)
    feed(m, B, 0, 0.3);
    m.command({ type: 'song', key: 'mB' });
    assert.ok(!m.job || m.job.end <= m.ring.written - m.k.keyLag, `no search over the change (phase ${phase})`);
    feed(m, B, 0.3 * SR, 12);
    const [a, b] = libSong(m.lib.get('mA'), [A, B]);
    assert.ok(a > 0.8 && b < 0.3, `route A’s entry holds A only (phase ${phase}: A ${a.toFixed(2)}, B ${b.toFixed(2)})`);
    const [a2, b2] = libSong(m.lib.get('mB'), [A, B]);
    assert.ok(b2 > 0.8 && a2 < 0.3, `B’s entry holds B only (phase ${phase}: A ${a2.toFixed(2)}, B ${b2.toFixed(2)})`);
  }
});

test('a loaded state forgets the song key: the same key again starts a new stretch and fast-forward plays its loop', () => {
  const A = tune({ seed: 1 });
  const m = new TurboMixer(SR, { seconds: 30 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 12);
  assert.ok(m.lib.has('mA'));
  m.command({ type: 'cut' });
  assert.equal(m.key, null, 'unknown until the page reads it again');
  const song = m.song;
  m.command({ type: 'song', key: 'mA' });
  assert.ok(m.song > song && !m.open, 'a new stretch');
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, skipping(A, 3, 0), 0, 2);
  const [a] = whichSong(out, Math.round(0.3 * SR), out.length, [A]);
  assert.ok(a > 0.8, `route A’s loop (${a.toFixed(2)})`);
});

test('song library: a short visit later does not replace a song’s long bed with a stutter', () => {
  const A = tune({ seed: 3, period: 120 });
  const B = tune({ seed: 8, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  feed(m, A, 0, 30); // a long stay: a long bed
  const long = m.lib.get('mA');
  assert.ok(long && long.lag > 10 * SR, `a long bed (${(long?.lag / SR).toFixed(1)} s)`);
  m.command({ type: 'song', key: 'mB' });
  feed(m, B, 0, 10);
  m.command({ type: 'song', key: 'mA' }); // back for 6 s: only a short bed can be found in that
  feed(m, A, 40 * SR, 6);
  assert.equal(m.lib.get('mA').lag, long.lag, 'the long bed stays');
  m.command({ type: 'speed', ratio: 3 });
  const out = feed(m, skipping(A, 3, 46 * SR), 0, 3);
  assert.ok(m.voice?.lag >= 10 * SR, 'the long bed plays, not a few seconds of it');
  assert.ok(longestQuiet(out, 0, out.length) < 0.1);
});

test('DS: a bed of only a few seconds is a stutter – the game’s own sound plays instead', () => {
  const A = tune({ seed: 3, period: 120 });
  const m = new TurboMixer(SR, { seconds: 60 });
  m.command({ type: 'skip', on: true });
  m.command({ type: 'song', key: 'mA' });
  let found = 0;
  m.onEvent = (e) => e.type === 'bed' && found++;
  feed(m, A, 0, 6); // 6 s at 1×: the beds found in it are ~2.5 s long
  assert.ok(found > 0 && m.bed.lag < m.k.minPlay, `only a short bed (${found}, ${(m.bed?.lag / SR).toFixed(1)} s)`);
  assert.ok(!m.lib.has('mA'), 'not kept for the song');
  m.command({ type: 'speed', ratio: 3 });
  assert.equal(m.carry, null);
  const src = skipping(A, 3, 5 * SR);
  const out = feed(m, src, 0, 2);
  assert.ok(corr(out, src, -m.dc.D, Math.round(0.2 * SR), out.length) > 0.9, 'the game’s own sound');
});

// ---- the frame pacer (2.2): a GBA game at the sound card's own rate --------------------------------------------------
// Measured in the app (synthetic GBA tune in mGBA, 48 kHz, pacer at 75 Hz): the sped-up sound is sped up (median pitch
// 450 → 1275 Hz at 4×), OpenAL runs dry ~8 times a second for ~6 ms (late, not lost), and the low half waves of the Game
// Boy square waves are runs of exact zeros (0.5–1.9 ms). The page clamps "Max" to 16 and reports the speed reached.

/** A PSG-like tune at `rate`: square waves whose low half is exact zero, a new note every 0.2 s, repeating every 6.4 s. */
function squareTune(rate, { seed = 1, period = 6.4 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const step = Math.round(0.2 * rate);
  const steps = Math.round((period * rate) / step);
  const notes = Array.from({ length: steps }, () => 220 * 2 ** (Math.floor(rnd() * 15) / 12));
  const P = steps * step;
  return (c) => {
    const p = ((c % P) + P) % P;
    const k = Math.floor(p / step);
    const x = (p - k * step) / rate;
    return (x * notes[k]) % 1 < 0.5 ? 0.3 * Math.exp(-x * 4) : 0;
  };
}

/** The emulator under the pacer at `rate`: drives a mixer as player.html does; run() returns what it played. */
function pacedGame(rate, music) {
  const m = new TurboMixer(rate, { seconds: 60 });
  const ev = [];
  m.onEvent = (e) => ev.push(e);
  const B = 128;
  const l = new Float32Array(B);
  const oL = new Float32Array(B);
  const oR = new Float32Array(B);
  const hole = { every: Math.round(rate / 8), len: Math.round(0.006 * rate) };
  const g = { m, ev, c: 0, i: 0, step: 1, real: 1, music };
  g.speed = (ratio, reached = Math.min(ratio, 16)) => {
    g.step = ratio;
    g.real = ratio > 1 ? reached : 1;
    m.command({ type: 'speed', ratio: Math.min(ratio, 16) }); // (player.html: "Max" is Infinity, the mixer gets 16)
    if (ratio > 1 && reached < Math.min(ratio, 16)) m.command({ type: 'rate', ratio: reached });
  };
  /** `sec` seconds of play (input false: the core gives no sound at all); returns { out, srcs }. */
  g.run = (sec, { input = true } = {}) => {
    const n = Math.round(sec * rate);
    const out = new Float32Array(n);
    const srcs = [];
    for (let k = 0; k < n; k += B) {
      for (let j = 0; j < B; j++, g.i++) {
        if (g.step > 1 && g.i % hole.every < hole.len) l[j] = 0; // OpenAL ran dry: the sound comes later
        else {
          l[j] = g.music(g.c);
          g.c += g.real;
        }
      }
      m.process(input ? l : null, null, oL, oR, B);
      out.set(oL.subarray(0, Math.min(B, n - k)), k);
      srcs.push(m.playing().src);
    }
    return { out, srcs };
  };
  return g;
}
/** Longest stretch of out[a..b) whose 20 ms windows are all near silence, in seconds. */
function quietest(out, rate, a, b = out.length) {
  const W = Math.round(0.02 * rate);
  let run = 0;
  let worst = 0;
  for (let s = a; s + W <= b; s += W) {
    let e = 0;
    for (let i = s; i < s + W; i++) e += out[i] * out[i];
    run = Math.sqrt(e / W) < 1e-3 ? run + W : 0;
    worst = Math.max(worst, run);
  }
  return worst / rate;
}

for (const rate of [44100, 48000]) {
  for (const [label, step, reached] of [['2×', 2, 2], ['4×', 4, 4], ['Max', Infinity, 7.3]]) {
    test(`pacer, ${rate} Hz, ${label}: 1× → fast-forward → 1× → fast-forward plays the loop both times, the game’s sound in between`, () => {
      const A = squareTune(rate);
      const g = pacedGame(rate, A);
      g.run(10);
      assert.ok(g.m.found, 'a loop was found at 1×');
      for (const round of [1, 2]) {
        const c0 = g.c;
        g.speed(step, reached);
        const ff = g.run(5);
        assert.ok(ff.srcs.slice(-Math.round((4.8 * rate) / 128)).every((s) => s === 'loop'), `round ${round}: the loop plays (${[...new Set(ff.srcs)]})`);
        assert.ok(quietest(ff.out, rate, Math.round(0.1 * rate)) < 0.1, `round ${round}: no silence`);
        if (round === 1) assert.ok(corr(ff.out, A, c0, Math.round(0.2 * rate), ff.out.length) > 0.99, 'the tune goes on exactly');
        g.speed(1);
        const back = g.run(5);
        assert.ok(back.srcs.slice(Math.round((0.3 * rate) / 128)).every((s) => s === 'game'), `round ${round}: the game’s sound again`);
      }
      assert.deepEqual(g.ev.filter((e) => e.changed || e.type === 'chop'), [], 'no song change, never "choppy"');
      assert.equal(g.m.chop.level, 0);
    });
  }

  test(`pacer, ${rate} Hz: a new song after a fast-forward streams in the next one (square waves and OpenAL’s holes are not "choppy")`, () => {
    const g = pacedGame(rate, squareTune(rate));
    g.run(10);
    g.speed(2);
    g.run(5);
    g.speed(1);
    g.run(1);
    // a state is loaded: another place, another song (square waves over a sampled instrument), too little of it for a loop
    g.m.command({ type: 'cut' });
    const sq = squareTune(rate, { seed: 9 });
    g.music = (c) => sq(c) + 0.05 * Math.sin((2 * Math.PI * 330 * c) / rate);
    g.run(2);
    g.speed(2);
    const ff = g.run(3);
    assert.equal(g.m.chop.level, 0, 'not judged choppy');
    assert.ok(g.m.carry?.stream, `the new song streams (${g.m.carry ? 'something else' : 'nothing'})`);
    assert.ok(quietest(ff.out, rate, Math.round(0.6 * rate)) < 0.15, 'music, not silence');
  });
}

test('pacer: step changes 2× → 3× → 4× → Max, pause and resume while the loop plays – it plays on, no song change', () => {
  const rate = 48000;
  const g = pacedGame(rate, squareTune(rate));
  g.run(10);
  g.speed(2);
  g.run(1);
  for (const s of [3, 4, Infinity]) {
    g.speed(s, s === Infinity ? 9 : s);
    const o = g.run(1);
    assert.ok(o.srcs.slice(-100).every((x) => x === 'loop'), `${s}×: the loop`);
  }
  g.m.command({ type: 'paused', paused: true });
  const p = g.run(1, { input: false });
  assert.equal(rms(p.out.subarray(Math.round(0.1 * rate))), 0, 'quiet while paused');
  g.m.command({ type: 'paused', paused: false });
  const r = g.run(2);
  assert.ok(quietest(r.out, rate, Math.round(0.1 * rate)) < 0.1, 'back after the pause');
  assert.ok(r.srcs.slice(-100).every((x) => x === 'loop'));
  assert.deepEqual(g.ev.filter((e) => e.changed), []);
});

test('a mixer whose sound stops right after the switch to fast-forward goes quiet instead of looping forever', () => {
  // (the core rebuilt its audio: this mixer's context gets nothing any more – player.html retires it now, but on its
  // own it must not keep playing either)
  const rate = 48000;
  const g = pacedGame(rate, squareTune(rate));
  g.run(10);
  g.speed(4);
  g.run(0.1);
  const after = g.run(3, { input: false });
  assert.equal(rms(after.out.subarray(Math.round(2 * rate))), 0, 'quiet within two seconds');
});

test('every speed, mode, pause and cut command leaves a state for diagnostics', () => {
  const m = new TurboMixer(SR, { seconds: 30 });
  const ev = [];
  m.onEvent = (e) => e.type === 'state' && ev.push(e);
  feed(m, tune(), 0, 16);
  m.command({ type: 'speed', ratio: 3 });
  m.command({ type: 'mode', mode: 'mute' });
  m.command({ type: 'paused', paused: true });
  m.command({ type: 'cut' });
  m.command({ type: 'song', key: 'm1' }); // (not a control command: no state)
  assert.deepEqual(ev.map((e) => [e.cmd, e.arg]), [['speed', 3], ['mode', 'mute'], ['paused', true], ['cut', null]]);
  assert.equal(ev[0].turbo, true);
  assert.equal(ev[0].carry, 'loop');
  assert.ok(ev[0].seg > 15, `seconds recorded: ${ev[0].seg}`);
  assert.equal(ev[3].sr, SR);
});

// ---- 2.2.0-beta.3: every core without the sound speed-up, the mixer at up to 96 kHz --------------------------------
// Paced from the display, RetroArch's sped-up sound came out chopped (48 kHz) or at a pitch jumping between 1× and ~8×
// (96 kHz); slowed down it sounded fast (a player with a 96 kHz sound card, GBA). Now every core plays the classic
// fast-forward sound – the song at normal pitch, skipping ahead – and the mixer runs in its skip mode. player.html runs
// the sound at ≤ 48 kHz (lib/pacer.mjs soundRate), but if the browser refuses, the mixer gets the card's 96 kHz.

/** A little tune at `rate`, as tune() (sine notes, a new one every 0.2 s, repeating every `period` s). */
function tuneAt(rate, { period = 6.4, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const step = Math.round(0.2 * rate);
  const steps = Math.round((period * rate) / step);
  const notes = Array.from({ length: steps }, () => 220 * 2 ** (Math.floor(rnd() * 15) / 12));
  const loud = Array.from({ length: steps }, () => 0.4 + rnd() * 0.6);
  const P = steps * step;
  return (t) => {
    const p = ((t % P) + P) % P;
    const k = Math.floor(p / step);
    const x = (p - k * step) / rate;
    return 0.3 * loud[k] * Math.min(1, x / 0.005) * Math.exp(-x * 6) * Math.sin(2 * Math.PI * notes[k] * x);
  };
}
/** Feeds fn(i) for `seconds` at `rate` in 128-sample blocks; returns the output and what played per block. */
function feedAt(m, rate, fn, seconds) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const srcs = [];
  const l = new Float32Array(128);
  const oL = new Float32Array(128);
  const oR = new Float32Array(128);
  for (let i = 0; i < n; i += 128) {
    for (let j = 0; j < 128; j++) l[j] = fn(i + j);
    m.process(l, null, oL, oR, 128);
    out.set(oL.subarray(0, Math.min(128, n - i)), i);
    srcs.push(m.playing().src);
  }
  return { out, srcs };
}
/** The classic fast-forward sound at `rate`: 20 ms pieces of the song at normal pitch, `ratio`× as far apart. */
const skippingAt = (rate, music, ratio, from = 0) => {
  const piece = Math.round(0.02 * rate);
  return (i) => {
    const k = Math.floor(i / piece);
    return music(from + k * piece * ratio + (i - k * piece));
  };
};

for (const rate of [48000, 96000]) {
  test(`skip mode at ${rate / 1000} kHz (GBA, song keys): the loop plays in every fast-forward, a new scene's song plays at normal pitch, never slowed down`, () => {
    const A = tuneAt(rate, { seed: 1 });
    const C = tuneAt(rate, { seed: 7 });
    const m = new TurboMixer(rate, { seconds: 60 });
    m.command({ type: 'skip', on: true }); // (player.html, every core)
    m.command({ type: 'song', key: 'p3.84' });
    let t = feedAt(m, rate, A, 14).out.length;
    assert.ok(m.lib.has('p3.84'), 'the route’s loop is kept');
    assert.ok(Math.abs(m.found.lag - 6.4 * rate) < 0.002 * rate, `loop of ${(m.found.lag / rate).toFixed(3)} s`);
    for (const [round, step] of [[1, 4], [2, 16]]) {
      m.command({ type: 'speed', ratio: step }); // (16: "Max", as player.html sends it)
      const ff = feedAt(m, rate, skippingAt(rate, A, step, t), 3);
      assert.ok(ff.srcs.slice(Math.round((0.2 * rate) / 128)).every((s) => s === 'loop' || s === 'lib'), `round ${round}: the loop (${[...new Set(ff.srcs)]})`);
      assert.ok(longestQuiet(ff.out, 0, ff.out.length) * (SR / rate) < 0.1, `round ${round}: no silence`);
      m.command({ type: 'speed', ratio: 1 });
      const back = feedAt(m, rate, (i) => A(t + i), 3);
      t += back.out.length;
      assert.ok(back.srcs.slice(Math.round((0.3 * rate) / 128)).every((s) => s === 'game'), `round ${round}: the game’s sound again`);
    }
    // a scene change while fast-forwarding, to a song never heard at 1× (the player's "m405"): the game's own sound,
    // the song at its normal pitch – nothing slowed down
    m.command({ type: 'speed', ratio: 4 });
    feedAt(m, rate, skippingAt(rate, A, 4, t), 1);
    m.command({ type: 'song', key: 'm405' });
    const src = skippingAt(rate, C, 4, 0);
    const scene = feedAt(m, rate, src, 2);
    assert.ok(corr(scene.out, src, -m.dc.D, Math.round(0.4 * rate), scene.out.length) > 0.9, 'the game’s own sound');
    assert.ok(!scene.srcs.includes('stream'), 'never the slowed-down stream');
  });
}
