// Turbo audio: keeps the game's music going at normal speed while the emulator fast-forwards.
//
// The emulated sound chip mixes music and sound effects into one signal, so they can't be told apart.
// Instead the mixer records the game's sound while it runs at 1×. During fast-forward it mutes the
// sped-up sound and loops the recorded music. The loop point comes from a similarity search: the last
// seconds of the recording are compared with every earlier stretch on a coarse spectrogram (a dozen
// band energies every ~20 ms – enough to tell melodies apart), the best match is then aligned to the
// sample – so the jump back sounds like the music simply goes on.
//
// The music can change during fast-forward (new area, battle). RetroArch plays the sped-up sound in full
// (audio_fastforward_speedup, set by player.html), so the mixer slows it back down by the speed ratio –
// that is the game's music at its normal pitch, just r× more of it than fits. It listens for the silence
// between two songs: then the old loop fades out, the new song plays from the slowed-down recording and, once it
// repeats, becomes the new loop. (Comparing the heard music with the loop to catch songs that follow without a
// pause was tried: on real Game Boy music the same song scored as low as a different one – false alarms.)
//
// Around a speed command the sped-up sound is unreliable (measured in the app): OpenAL still plays sound made at
// the old speed, RetroArch's speed-up of the sound settles over a few frames and OpenAL runs dry for a while
// (holes of digital silence). Slowed down, that came out as drop-outs and stretches at the wrong pitch. So the
// recording leaves out the first moments after a command, takes the holes out, and crossfades where it skips.
//
// Since then two better sources came first where they exist: the song number the game keeps in RAM ({ type: 'song' },
// shared/live/location.mjs) files every loop under its song and switches with it, and for DS games the song is
// synthesized from the ROM's own sound archive (sdat.mjs, sdat-synth.mjs) – no recording needed. DeSmuME's
// fast-forward sound is not sped up but skips (audio_fastforward_speedup off) – since 2.2 for every core. That skipping
// sound is the song at its normal pitch, but it races ahead in pieces: to the ear it is sped-up music, exactly what
// "Music continues" is there to avoid (a Windows player heard it after every scene change in 2.2.1-beta.1 and took it for
// the turbo music being broken, as "Music continues", "Sped-up original" and "Plain" then all sounded the same). So in
// "music" the game's own fast-forward sound is never heard: a song with nothing recorded yet keeps the music that played
// before it (the previous song's loop – "music continues"), and only with nothing recorded at all is fast-forward quiet.
//
// Plain DSP without Web Audio types: it runs in the AudioWorklet (turboaudio-worklet.mjs), in the
// ScriptProcessor fallback of player.html and in test/turboaudio.test.mjs. The search is sliced into
// small steps (generators), so one render quantum never does much work.

import { SdatSynth } from './sdat-synth.mjs';

export const HOP = 1024; // samples per analysis frame
export const TURBO_MODES = ['music', 'mute', 'original'];
const BANDS = 12; // band-pass filters, log-spaced from 110 Hz up
const SIL_LEVEL = 1e-5; // mean power below this (≈ –50 dBFS) counts as silence
const MIN_SCORE = 0.6; // spectrogram similarity below this: no believable loop – stay quiet instead
const GOOD = 0.8; // spectrogram similarity that counts as "the music repeats here"
const FINE_GOOD = 0.9; // waveform similarity at the splice that allows a short crossfade
const BUDGET = 24000; // multiply-adds of search work per 128 samples of audio
const HOLE = 16; // this many exact zeros in a row inside sped-up sound: OpenAL ran dry (a hole), not music
const BED_MIN = 12; // seconds: a music bed jumps back at least this far (shorter recordings: as far as they go)
const BED_XFADE = 2; // seconds of crossfade at a music bed's jump
const UNDERRUN = 64; // samples over which a streamed song fades out when its recording runs out
const MIN_PLAY = 3.5; // seconds: a loop or bed shorter than this is a stutter, not music going on – the game's sound instead
const SHORT_LOOP = 6; // seconds: a loop shorter than this repeats a phrase, not the song – ranked like a bed
const LIB_LEN = 30; // seconds: the longest stretch of a loop or bed kept per song (int16 stereo, ≈5.5 MB at 48 kHz)
const LIB_TOTAL = 90; // seconds kept over all songs – the least recently heard go first
const Q = 32767;
// The DS song synthesized from the ROM (sdat-synth.mjs) is about this much quieter than the game's own mix
// (measured on HeartGold: New Bark Town, Route 29, Elm's lab, wild battle – 1.23 to 1.8, music and effects).
const SYNTH_GAIN = 1.45;

/** Stereo ring buffer addressed by absolute sample positions (samples ever written). */
export class AudioRing {
  constructor(capacity) {
    this.cap = Math.max(1, capacity | 0);
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.written = 0;
  }
  /** Oldest position still held. */
  get oldest() {
    return Math.max(0, this.written - this.cap);
  }
  /** True while [from, to) is fully in the buffer. */
  has(from, to) {
    return from >= this.oldest && to <= this.written && from <= to;
  }
  push(l, r = l, n = l.length) {
    if (n > this.cap) {
      this.written += n - this.cap;
      l = l.subarray(n - this.cap, n);
      r = r.subarray(n - this.cap, n);
      n = this.cap;
    }
    const at = this.written % this.cap;
    const first = Math.min(n, this.cap - at);
    this.l.set(first === l.length ? l : l.subarray(0, first), at);
    this.r.set(first === r.length ? r : r.subarray(0, first), at);
    if (first < n) {
      this.l.set(l.subarray(first, n), 0);
      this.r.set(r.subarray(first, n), 0);
    }
    this.written += n;
  }
  /** Mono copy, (L + R) / 2, of [from, from + len). */
  mono(from, len, out = new Float32Array(len)) {
    for (let i = 0; i < len; i++) {
      const k = (from + i) % this.cap;
      out[i] = (this.l[k] + this.r[k]) * 0.5;
    }
    return out;
  }
}

/** Runs a sliced search to the end (tests, or when there is time to spare). */
export function runAll(gen) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/**
 * Coarse loop search on analysis frames (oldest first, `n` frames per feature array). Compares the last
 * `win` frames with the `win` frames ending `lag` earlier, for every lag ≥ minLag that fits, by one
 * correlation over all features (each centred on its own mean, so busy bands weigh more than quiet
 * ones). Of the lags that score within `tol` of the best, the longest (local peak) wins: a full musical
 * period sounds more natural than a repeated bar.
 * Yields the work done since the last yield; returns { lag, score } in frames, or null.
 */
export function* coarseLag(feats, n, { minLag, win, tol = 0.03, chunk = 4096 }) {
  const maxLag = n - win;
  if (win < 8 || maxLag < minLag) return null;
  // frame-major copy (n × K) so each comparison is one tight loop; the target window centred per feature
  const K = feats.length;
  const X = new Float32Array(n * K);
  const A = new Float32Array(win * K);
  const pre = new Float64Array((n + 1) * K); // running sums per feature …
  const pre2 = new Float64Array((n + 1) * K); // … and of squares, for each window's variance
  const used = [];
  let normA = 0;
  for (let d = 0; d < K; d++) {
    const f = feats[d];
    let mean = 0;
    for (let i = n - win; i < n; i++) mean += f[i];
    mean /= win;
    let norm = 0;
    for (let i = 0; i < win; i++) norm += (f[n - win + i] - mean) ** 2;
    for (let i = 0; i < n; i++) {
      X[i * K + d] = f[i];
      pre[(i + 1) * K + d] = pre[i * K + d] + f[i];
      pre2[(i + 1) * K + d] = pre2[i * K + d] + f[i] * f[i];
    }
    yield 3 * n;
    if (Math.sqrt(norm / win) < 0.01) continue; // flat feature: says nothing about the music's position
    for (let i = 0; i < win; i++) A[i * K + d] = f[n - win + i] - mean;
    normA += norm;
    used.push(d);
  }
  if (!used.length) return null; // nothing changes in the last seconds – no position to match
  normA = Math.sqrt(normA);
  const scores = new Float32Array(maxLag + 2);
  const W = win * K;
  let ops = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = n - lag - win;
    const dot = dotAt(A, X, s * K, W); // A is zero-mean per feature → equals the centred dot product
    let varB = 0;
    for (const d of used) {
      const sum = pre[(s + win) * K + d] - pre[s * K + d];
      varB += pre2[(s + win) * K + d] - pre2[s * K + d] - (sum * sum) / win;
    }
    scores[lag] = varB > 1e-9 ? dot / (normA * Math.sqrt(varB)) : 0;
    if ((ops += W) >= chunk) {
      yield ops;
      ops = 0;
    }
  }
  let best = -Infinity;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (scores[lag] > best) [best, bestLag] = [scores[lag], lag];
  // only a clearly longer period counts (another multiple of the bar), not a jagged neighbour of the best lag –
  // a loop a few frames too long drifts audibly
  for (let lag = maxLag; lag >= bestLag + Math.max(4, minLag >> 1); lag--) {
    const peak = (lag === minLag || scores[lag] >= scores[lag - 1]) && (lag === maxLag || scores[lag] >= scores[lag + 1]);
    if (peak && scores[lag] >= best - tol) return { lag, score: scores[lag] };
  }
  return { lag: bestLag, score: best };
}

// Hot loops live in plain functions: the JIT optimises them well, independent of the generators.
/** Catmull-Rom value between a[i] and a[i + 1] at fraction f. */
function hermite(a, i, f) {
  const y0 = a[i - 1];
  const y1 = a[i];
  const y2 = a[i + 1];
  const y3 = a[i + 2];
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}

function dotAt(a, b, off, len) {
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[off + i];
  return dot;
}

/**
 * Sample-exact alignment around a coarse lag: normalised cross-correlation of the last `win` samples
 * before `end` with the stretch `lag ± radius` earlier. Returns { lag, corr }.
 */
export function* refineLag(ring, end, lag, { radius = HOP, win = 2048, chunk = 8192 } = {}) {
  const a = ring.mono(end - win, win);
  const from = end - lag - radius - win;
  const b = ring.mono(from, win + 2 * radius);
  let na = 0;
  for (let i = 0; i < win; i++) na += a[i] * a[i];
  if (na < 1e-9) return { lag, corr: 0 };
  na = Math.sqrt(na);
  const pre = new Float64Array(b.length + 1);
  for (let i = 0; i < b.length; i++) pre[i + 1] = pre[i] + b[i] * b[i];
  // the window for lag + d starts at offset radius − d in b
  const corr = (o) => {
    const nb = pre[o + win] - pre[o];
    return nb > 1e-9 ? dotAt(a, b, o, win) / (na * Math.sqrt(nb)) : 0;
  };
  let best = -Infinity;
  let bestO = radius;
  let ops = 0;
  for (let o = 0; o <= 2 * radius; o += 4) {
    const c = corr(o);
    if (c > best) [best, bestO] = [c, o];
    if ((ops += win) >= chunk) {
      yield ops;
      ops = 0;
    }
  }
  const mid = bestO;
  for (let o = Math.max(0, mid - 3); o <= Math.min(2 * radius, mid + 3); o++) {
    if (o === mid) continue;
    const c = corr(o);
    if (c > best) [best, bestO] = [c, o];
  }
  yield ops + 6 * win;
  return { lag: lag + radius - bestO, corr: best };
}

/**
 * Full search for a loop that ends at `end` (absolute sample position of the end of the last frame).
 * Returns { start, end, lag, xfade, curve, score, fine } in samples, or null.
 */
export function* findLoop(ring, feats, n, end, sampleRate) {
  const fps = sampleRate / HOP;
  const minLag = Math.round(2.5 * fps);
  const win = Math.min(Math.round(3 * fps), n - minLag);
  const coarse = yield* coarseLag(feats, n, { minLag, win });
  if (!coarse) return null;
  if (coarse.score < MIN_SCORE) return yield* findBed(ring, feats, n, end, sampleRate, win);
  const fine = yield* refineLag(ring, end, coarse.lag * HOP, { radius: 3 * HOP }); // the coarse grid can be a frame or two off
  const good = fine.corr >= FINE_GOOD;
  const xfade = fitXfade(Math.round(sampleRate * (good ? 0.05 : coarse.score >= GOOD ? 0.25 : 1)), fine.lag, n);
  return { start: end - fine.lag, end, lag: fine.lag, xfade, curve: good ? 'linear' : 'power', score: coarse.score, fine: fine.corr };
}

/** The crossfade before a loop's start must stay inside the searched stretch – before it, another song may play. */
function fitXfade(xfade, lag, n) {
  return Math.max(0, Math.min(xfade, n * HOP - lag - HOP));
}

/**
 * No loop in the music (a long song, or one that doesn't repeat yet): a "music bed" instead – the most self-similar
 * jump back of at least BED_MIN seconds (as long as the recording allows), with a long equal-power crossfade, so
 * it sounds like the song goes on. Only used where the sped-up sound can't be slowed down (DeSmuME, see judgeChop).
 */
function* findBed(ring, feats, n, end, sampleRate, win) {
  const fps = sampleRate / HOP;
  // A bed jumps back as far as the recording allows: with only a few seconds of it, how similar the two spots are
  // matters less than how much music plays before the jump (a 2 s bed is a stutter). So the compared stretch is short
  // (1 s), and the jump plus its crossfade (a quarter of it) must fit into what was recorded.
  const bwin = Math.min(win, Math.round(fps));
  const room = Math.floor((n - bwin) / 1.25);
  const minLag = Math.max(Math.round(2.5 * fps), Math.min(Math.round(BED_MIN * fps), room - 8));
  if (n - bwin < minLag) return null;
  const coarse = yield* coarseLag(feats, n, { minLag, win: bwin, tol: 0.1 });
  if (!coarse) return null;
  const fine = yield* refineLag(ring, end, coarse.lag * HOP, { radius: 3 * HOP });
  const xfade = fitXfade(Math.round(Math.min(BED_XFADE * sampleRate, fine.lag * 0.25)), fine.lag, n);
  return { bed: true, start: end - fine.lag, end, lag: fine.lag, xfade, curve: 'power', score: coarse.score, fine: fine.corr };
}

/**
 * The mixer between the emulator's sound and the speakers. Feed it every block with process(); control
 * it with command({ type: 'speed', ratio } | { type: 'mode', mode } | { type: 'paused', paused } | { type: 'cut' } |
 * { type: 'skip', on } | { type: 'rate', ratio }).
 * onEvent receives small status objects ({ type: 'found' | 'turbo', … }) for debugging.
 */
export class TurboMixer {
  constructor(sampleRate, { seconds = 60, onEvent = null, minPlay = MIN_PLAY } = {}) {
    const S = (sec) => Math.round(sec * sampleRate);
    this.sr = sampleRate;
    this.k = { minSeg: S(5), minBedSeg: S(4), sil: S(0.4), settle: S(0.4), hold: S(0.15), fade: S(0.08), margin: S(2), research: Math.round((3 * sampleRate) / HOP) };
    this.ring = new AudioRing(S(seconds));
    this.fcap = Math.ceil(this.ring.cap / HOP) + 2;
    // band-pass biquads (RBJ, 0 dB peak, b1 = 0) and the log energy of each band per frame
    const top = Math.min(7000, sampleRate * 0.4);
    this.bands = Array.from({ length: BANDS }, (_, i) => {
      const w = (2 * Math.PI * 110 * (top / 110) ** (i / (BANDS - 1))) / sampleRate;
      const alpha = Math.sin(w) / (2 * 1.8);
      const a0 = 1 + alpha;
      return { b0: alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0, e: 0 };
    });
    this.feats = this.bands.map(() => new Float32Array(this.fcap));
    this.frames = 0;
    this.acc = { start: 0, n: 0, e: 0 };
    // A segment is one stretch of continuous 1× sound: a pause keeps it going, fast-forward, a long
    // silence (area change, fade to black) or a loaded state ends it.
    this.seg = null; // { id, start (sample), frame }
    this.segIds = 0;
    this.open = false;
    this.silent = 0; // samples of silence (or no sound at all) in a row
    this.mode = 'music';
    this.turbo = false;
    this.paused = false;
    this.settle = 0; // samples to skip after fast-forward: OpenAL still holds sped-up sound
    this.hold = 0; // samples the loop keeps playing after fast-forward ends, for the same reason
    this.job = null;
    this.lastJob = { segId: 0, frame: 0 }; // searches repeat every few seconds per stretch
    this.song = 0; // counts song changes (a long silence, a cut, a change heard during fast-forward)
    this.bed = null; // latest music bed (DeSmuME without a loop), kept across song changes { segId, start, end, lag, xfade, … }
    this.found = null; // latest search result { segId, start, end, lag, xfade, curve, score, fine, pos }
    this.carry = null; // the loop chosen at the last switch – reused while the new stretch is too short
    this.pending = false; // fast-forward started while a search was still needed
    this.voice = null; // the loop that is playing
    this.live = { v: 1, t: 1, s: 0 };
    this.loop = { v: 0, t: 0, s: 0 };
    this.onEvent = onEvent;
    this.info = {};
    this.ratio = 1; // the speed asked for
    this.real = 0; // the speed the emulator really reaches (measured by the page; 0 = not yet known)
    // DeSmuME: RetroArch runs without audio_fastforward_speedup there (player.html), so its fast-forward sound is
    // the classic one – the song at normal pitch, in pieces, skipping ahead. Nothing to slow down: it is played as
    // it is (with the jumps smoothed), unless a loop or music bed recorded at 1× is there to play instead.
    this.skip = false;
    const D = Math.max(4, Math.round(0.001 * sampleRate));
    // de-click: a 1 ms delay line, the last two inputs per side, the usual error level, where the dip stands
    this.dc = { D, l: new Float32Array(D), r: new Float32Array(D), at: 0, x0: 0, x1: 0, y0: 0, y1: 0, lvl: 0, dip: 0, bl: null, br: null };
    this.tRec = false; // fast-forward: recording the slowed-down sound (no loop to keep, or the music changed)
    this.tSil = 0; // fast-forward: sped-up samples of silence in a row while the old loop plays
    this.tGrace = 0; // fast-forward: sped-up samples still to skip right after the switch
    this.sx = { t: 3, hl: new Float32Array(3), hr: new Float32Array(3), bl: null, br: null, L: null, R: null }; // slow-down state
    this.k.tquiet = S(0.25); // …but never shorter than this in real time: a stutter of the emulator isn't a song change
    this.k.tgrace = S(0.8); // after switching to fast-forward OpenAL hiccups (a gap, then sped-up sound): not judged
    // After a speed command the sound is not yet at the new speed: OpenAL still plays ~60 ms made at the old one, and
    // RetroArch's speed-up of the sound follows the new pace over a few frames (until souldew 2.1 a step change even
    // switched fast-forward off for ~70 ms). Slowed down by the new ratio that would come out at the wrong pitch (a 1×
    // stretch at 3× sounds an octave and a fifth too low) – that stretch is not recorded.
    this.k.tskip = S(0.25);
    this.k.lead = S(0.1); // a streamed song starts once this much of it is recorded – never right at the write head
    this.tSkip = 0; // fast-forward: samples of sound still to leave out of the recording after a speed command
    // The slowed-down sound reaches the ring through a short hold-back (`tail`), so where the recording skips ahead
    // the old end and the new start can be crossfaded instead of butted together (a click).
    this.k.splice = S(0.005);
    this.tail = { l: new Float32Array(this.k.splice), r: new Float32Array(this.k.splice), n: 0, xf: false };
    this.cat = { l: null, r: null };
    this.zb = { l: null, r: null }; // the sped-up block without its holes
    this.zrun = 0; // zeros at the end of the last block, not yet known to be a hole
    this.zhole = false; // inside a hole
    // DeSmuME's sped-up sound (measured with HeartGold, threaded or not) is chopped: ~280-sample pieces with holes
    // in between, 40–47 % of the time and ~75 times a second, and the pieces don't join up (sound is lost). Slowed
    // down that is a loud buzz, not music – so while the sped-up sound is choppy, nothing is recorded or streamed
    // (a loop recorded at 1× still plays). Judged per 0.25 s; kept across fast-forwards, so the next one knows.
    // Only holes of 2–30 ms, at least 60 a second, count (DeSmuME's: ~5 ms, 75–95 a second). The low half waves of a
    // Game Boy square wave (PSG) are runs of exact zeros too – measured on a GBA tune in mGBA at 48 kHz: 0.5–1.9 ms at
    // 1× and sped up, 20–45 % of the time –, and OpenAL running dry while the pacer fast-forwards leaves ~6 ms holes
    // ~8 times a second. Neither loses sound, but counted they made the level stick at "choppy" after the first
    // fast-forward, and the next one without a loop stayed silent.
    this.k.chopWin = S(0.25);
    this.k.minHole = Math.max(HOLE, S(0.002));
    this.k.maxHole = S(0.03);
    this.k.chopHoles = Math.ceil(60 * 0.25);
    this.chop = { z: 0, n: 0, run: 0, k: 0, level: 0 };
    // The game says which song plays ({ type: 'song', key } – its music id from RAM, else the map): a loop or bed
    // found at 1× is copied out of the ring per song, so on a route change during fast-forward the new route's
    // music plays (or, for DeSmuME, the game's own skipping sound), never the old route's. Without a key the
    // mixer listens for the silence between songs, as before.
    this.key = null;
    this.lib = new Map(); // key → { l, r, start, end, lag, xfade, curve, bed, score, fine } (Int16, least recent first)
    this.k.libLen = S(LIB_LEN);
    this.k.libTotal = S(LIB_TOTAL);
    this.k.minPlay = S(minPlay);
    this.k.shortLoop = S(SHORT_LOOP);
    this.k.keyLag = S(1); // how late a song key may come after the music changed (see songKey), with room to spare
    this.k.keyTrim = Math.ceil(S(0.6) / HOP); // frames left out at the start of a stretch that began with a key change
    this.trimNext = false;
    this.segBest = 0; // the longest loop or bed found in the stretch segBestId so far
    this.segBestId = 0;
    // DS games: the page reads the sound archive out of the ROM ({ type: 'sdat-ready' }) and sends each song as it
    // comes up ({ type: 'sdat', key, pack }). The song then plays along silently at 1× from the moment its key
    // appears, and in fast-forward it is the music – the real song at normal speed, never heard at 1× or not,
    // ahead of every recorded loop. Without it (other systems, unreadable archive) everything above applies.
    this.synth = null;
    this.syn = { v: 0, t: 0, s: 0 };
    // What the mixer before this one handed over when the core rebuilt its sound (player.html: a new AudioContext after a
    // lost graphics context – Windows restarts its GPU process now and then): its song library, and the music that played
    // last, so fast-forward after the rebuild still has music instead of starting from nothing.
    this.held = null; // { key, l, r, start, end, lag, xfade, curve, bed, score, fine } (Int16, like a library entry)
    this.quanta = 0; // render blocks processed (diagnostics: is the audio thread running this mixer at all?)
  }

  emit(e) {
    try {
      this.onEvent?.(e);
    } catch {
      // the listener's problem
    }
  }

  /** What the mixer is doing (diagnostics: "Save diagnostics" keeps one after every speed, mode, pause and cut command). */
  state() {
    const kind = (v) => (!v ? null : v.lib ? 'lib' : v.stream ? 'stream' : v.bed ? 'bed' : 'loop');
    const sec = (x) => (Number.isFinite(x) ? +(x / this.sr).toFixed(2) : null);
    return {
      turbo: this.turbo,
      live: +this.live.t.toFixed(2), // where the game's own sound is headed (0 = muted by the mixer)
      mode: this.mode,
      paused: this.paused,
      ratio: this.ratio,
      rate: +this.rate.toFixed(2),
      skip: this.skip,
      chop: this.chop.level,
      rec: this.tRec,
      open: this.open,
      seg: this.seg ? sec(this.ring.written - this.seg.start) : null, // seconds recorded in the current stretch
      carry: kind(this.carry),
      carrySec: sec(this.carry?.lag),
      voice: kind(this.voice),
      found: sec(this.found?.lag),
      lib: this.lib.size,
      key: this.key,
      song: this.song,
      grace: sec(Math.max(0, this.tGrace)),
      silent: sec(this.silent),
      sr: this.sr,
      held: !!this.held,
      quanta: this.quanta,
    };
  }

  command(m) {
    if (!m) return;
    this.cmd(m);
    if (['speed', 'mode', 'paused', 'cut', 'skip'].includes(m.type)) this.emit({ type: 'state', cmd: m.type, arg: m.ratio ?? m.mode ?? m.paused ?? m.on ?? null, ...this.state() });
  }

  cmd(m) {
    if (m.type === 'speed') {
      const change = this.turbo && m.ratio > 1 && m.ratio !== this.ratio;
      if (m.ratio > 1) this.ratio = m.ratio;
      this.real = 0; // a new step: the old measurement doesn't hold
      this.setTurbo(m.ratio > 1);
      if (change) this.speedChange();
    } else if (m.type === 'mode' && TURBO_MODES.includes(m.mode)) {
      this.mode = m.mode;
      if (this.turbo && m.mode === 'music' && !this.carry) {
        this.wantSearch();
        if (this.noStream) this.carry = this.fromLib() || this.fallback(); // (nothing to slow down: what was recorded)
        this.tRec = !this.carry;
      }
      this.retarget();
    } else if (m.type === 'paused') {
      if (this.paused && !m.paused) this.silent = 0; // the gap around a pause isn't a silence in the music
      this.paused = !!m.paused;
      this.retarget();
    } else if (m.type === 'skip') {
      this.skip = !!m.on;
      this.retarget();
    } else if (m.type === 'rate') {
      // the measured speed: a machine that can't hold 4× (≈2.7×) gives sound sped up 2.7×, not 4×
      if (this.turbo && m.ratio > 0) this.real = this.real ? this.real * 0.7 + m.ratio * 0.3 : m.ratio; // (measurement noise)
    } else if (m.type === 'song') {
      this.songKey(m.key ?? null);
    } else if (m.type === 'sdat-ready') {
      if (!this.synth) this.synth = new SdatSynth(this.sr, { gain: SYNTH_GAIN });
      if (this.key) this.synth.song(this.key);
    } else if (m.type === 'sdat') {
      if (!this.synth) this.synth = new SdatSynth(this.sr, { gain: SYNTH_GAIN });
      this.synth.add(m.key, m.pack);
      this.retarget();
    } else if (m.type === 'export') {
      this.emit({ type: 'export', ...this.exportMemory() });
    } else if (m.type === 'import') {
      this.importMemory(m);
    } else if (m.type === 'probe') {
      this.emit({ type: 'probe', id: m.id ?? null, playing: this.playing().src, ...this.state() });
    } else if (m.type === 'cut') {
      // the game jumped (state loaded, reset): the recording doesn't lead into what comes next, and the song key is
      // unknown until the page reads it again (the place may be another one now)
      this.open = false;
      this.carry = this.turbo && this.noStream && this.mode === 'music' ? this.playable() : null; // (music goes on, see fallback)
      this.key = null;
      this.synth?.song(null);
      this.song++;
      if (this.turbo) this.tRec = !this.carry;
      this.retarget();
    }
  }

  /**
   * The game's music changed (RAM says so – sooner and surer than a silence): follow it, at 1× and in fast-forward.
   * The first key (after the start or a loaded state) is a change too: what played before it – the title screen, the
   * place before the jump – is not filed under it.
   */
  songKey(key) {
    if (key == null || key === this.key) return;
    this.key = key;
    this.synth?.song(key);
    // The key arrives a moment after the music changed (read every 100 ms, plus the sound’s own latency): a search
    // whose stretch reaches into that time may already have the new song at its end – it's dropped, not kept for the
    // old song. And the new stretch leaves out its first moments (the old song can still be fading there).
    if (this.job && this.job.end > this.ring.written - this.k.keyLag) this.job = null;
    this.trimNext = true;
    this.song++;
    this.open = false; // a new stretch: the next search must not mix two songs
    this.pending = false;
    const prev = this.turbo && this.mode === 'music' && this.noStream ? this.playable() : null;
    this.carry = null;
    if (this.turbo && this.mode === 'music') {
      // the new song's loop from the library, else (sped-up sound) its sound slowed down, else (the classic skipping
      // fast-forward sound, every core since 2.2) the music that played before goes on – never the skipping sound
      this.carry = this.fromLib() || prev;
      this.tRec = !this.carry && !this.noStream;
      this.tSil = 0;
      this.emit({ type: 'turbo', on: true, loop: this.carry ? this.describe(this.carry) : null, changed: true, key, lib: !!this.carry?.lib && this.carry.key === key, kept: !!this.carry && this.carry === prev });
    }
    this.retarget();
  }

  /** Copies a loop or bed found at 1× out of the ring (at most libLen of it), so its song can come back later. */
  keep(l) {
    if (l.key == null || !this.valid(l) || l.lag < this.k.minPlay) return;
    const had = this.lib.get(l.key);
    if (had && this.rank(had) > this.rank(l)) {
      // what the song has is better (a real loop, a longer bed – a short visit later finds less): keep it, as recently heard
      this.lib.delete(l.key);
      this.lib.set(l.key, had);
      return;
    }
    let { start, lag, xfade, curve } = l;
    const bed = l.bed || lag > this.k.libLen;
    if (lag > this.k.libLen) {
      // too long to keep: its last libLen as a bed (a long crossfade at the jump)
      lag = this.k.libLen;
      start = l.end - lag;
      xfade = Math.round(Math.min(BED_XFADE * this.sr, lag * 0.25));
      curve = 'power';
    }
    const from = start - xfade;
    if (from < this.ring.oldest) return;
    const len = xfade + lag;
    const L = new Int16Array(len);
    const R = new Int16Array(len);
    const { cap, l: rl, r: rr } = this.ring;
    for (let i = 0; i < len; i++) {
      const k = (from + i) % cap;
      L[i] = Math.max(-Q, Math.min(Q, Math.round(rl[k] * Q)));
      R[i] = Math.max(-Q, Math.min(Q, Math.round(rr[k] * Q)));
    }
    this.lib.delete(l.key);
    this.lib.set(l.key, { l: L, r: R, start: xfade, end: len, lag, xfade, curve, bed, score: l.score, fine: l.fine });
    let total = 0;
    for (const e of this.lib.values()) total += e.end;
    for (const [k, e] of this.lib) {
      if (total <= this.k.libTotal || k === l.key) break;
      this.lib.delete(k);
      total -= e.end;
    }
    this.emit({ type: 'kept', key: l.key, seconds: +(lag / this.sr).toFixed(2), bed, songs: this.lib.size });
  }

  /** How much music a loop or bed gives before it repeats (a bed's long crossfade and a short loop's phrase count less). */
  rank(l) {
    const lag = Math.min(l.lag, this.k.libLen);
    return l.bed || lag < this.k.shortLoop ? lag * 0.8 : lag;
  }

  /** A voice for the current song from the library (it starts at its loop's beginning), or null. */
  fromLib() {
    const e = this.key != null && this.lib.get(this.key);
    if (!e) return null;
    this.lib.delete(this.key);
    this.lib.set(this.key, e); // recently heard
    return this.libVoice(e, this.key);
  }

  /** A voice that plays a library entry (or the handed-over `held` music) from its loop's beginning. */
  libVoice(e, key) {
    return { lib: e, key, song: this.song, start: e.start, end: e.end, lag: e.lag, xfade: e.xfade, curve: e.curve, bed: e.bed, score: e.score, fine: e.fine, pos: e.start };
  }

  /** The music playing (or chosen) right now, if it can go on: recorded, still in the ring, long enough to be music. */
  playable() {
    for (const v of [this.voice, this.carry]) if (v && !v.stream && this.valid(v) && v.lag >= this.k.minPlay) return v;
    return null;
  }

  /**
   * Nothing recorded for the song playing now, and the fast-forward sound can't be slowed down into it (the classic
   * skipping sound): the music that played last goes on rather than the skipping sound – what's playing, else what the
   * previous mixer handed over, else the most recently recorded song, else the latest bed. Null: nothing recorded at all.
   */
  fallback() {
    const p = this.playable();
    if (p) return p;
    if (this.held) return this.libVoice(this.held, this.held.key ?? null);
    const recent = [...this.lib].at(-1);
    if (recent && recent[1].lag >= this.k.minPlay) return this.libVoice(recent[1], recent[0]);
    return this.bed && this.valid(this.bed) && this.bed.lag >= this.k.minPlay ? this.bed : null;
  }

  /** Copies a ring voice out (at most libLen of it, like keep()), so it outlives the ring – and this mixer. */
  copyOut(v) {
    if (!v || v.stream) return null;
    if (v.lib) return { key: v.key ?? null, ...v.lib };
    if (!this.valid(v) || v.lag < this.k.minPlay) return null;
    let { start, lag, xfade, curve } = v;
    if (lag > this.k.libLen) {
      lag = this.k.libLen;
      start = v.end - lag;
      xfade = Math.round(Math.min(BED_XFADE * this.sr, lag * 0.25));
      curve = 'power';
    }
    const from = start - xfade;
    if (from < this.ring.oldest) return null;
    const len = xfade + lag;
    const L = new Int16Array(len);
    const R = new Int16Array(len);
    const { cap, l: rl, r: rr } = this.ring;
    for (let i = 0; i < len; i++) {
      const k = (from + i) % cap;
      L[i] = Math.max(-Q, Math.min(Q, Math.round(rl[k] * Q)));
      R[i] = Math.max(-Q, Math.min(Q, Math.round(rr[k] * Q)));
    }
    return { key: v.key ?? null, l: L, r: R, start: xfade, end: len, lag, xfade, curve, bed: !!v.bed || lag !== v.lag, score: v.score ?? 0, fine: v.fine ?? 0 };
  }

  /** What the next mixer needs to carry on (player.html, when the core rebuilt its sound): the library and the last music. */
  exportMemory() {
    const lib = [...this.lib].map(([key, e]) => ({ key, ...e }));
    const last = this.copyOut(this.playable()) || this.copyOut(this.found) || this.copyOut(this.bed) || this.held;
    return { sr: this.sr, lib, last: last || null };
  }

  /** Takes over what the previous mixer recorded (same sample rate only – the samples are not resampled). */
  importMemory(m) {
    if (m.sr !== this.sr) return this.emit({ type: 'import', ok: false, why: 'rate', from: m.sr, sr: this.sr });
    let total = [...this.lib.values()].reduce((s, e) => s + e.end, 0);
    const imp = [];
    // newest first, so the least recently heard are the ones left out when there is no room
    for (const e of [...(m.lib || [])].reverse()) {
      if (e?.key == null || !(e.l instanceof Int16Array) || this.lib.has(e.key)) continue; // (what this mixer recorded itself wins)
      if (total + e.end > this.k.libTotal) continue;
      total += e.end;
      const { key, ...entry } = e;
      imp.unshift([key, entry]);
    }
    // older than anything this mixer heard itself: in front of the least recently heard
    this.lib = new Map([...imp, ...this.lib]);
    if (m.last?.l instanceof Int16Array && m.last.lag >= this.k.minPlay) this.held = m.last;
    this.emit({ type: 'import', ok: true, songs: this.lib.size, held: !!this.held });
    if (this.turbo && this.mode === 'music' && !this.carry) {
      this.carry = this.fromLib() || (this.noStream ? this.fallback() : null);
      if (this.carry) {
        this.tRec = false;
        this.pending = false;
        this.emit({ type: 'turbo', on: true, loop: this.describe(this.carry), imported: true });
      }
    }
    this.retarget();
  }

  setTurbo(on) {
    if (on === this.turbo) return;
    this.turbo = on;
    if (on) {
      this.hold = 0;
      const loop = this.chooseLoop();
      if (!loop || (this.noStream && loop.song !== this.song)) this.wantSearch(); // (DeSmuME: another song's music for now)
      this.emit({ type: 'turbo', on: true, loop: loop ? this.describe(loop) : null, searching: this.pending });
      this.open = false; // after fast-forward the music has moved on – a new stretch starts
      this.tRec = !loop; // nothing to continue: record the slowed-down music right away
      this.tSil = 0;
      this.tGrace = this.k.tgrace;
      this.tSkip = this.k.tskip;
      this.chop.z = this.chop.n = this.chop.run = this.chop.k = 0;
      this.tail.n = 0; // a new stretch: nothing to crossfade with
      this.tail.xf = false;
      this.zrun = 0;
      this.zhole = false;
      this.resetStretch();
    } else {
      this.pending = false;
      this.tRec = false;
      if (this.carry?.stream) this.carry = null;
      this.open = false; // the sound held in OpenAL is skipped (settle) – the 1× recording starts afresh
      this.settle = this.k.settle;
      this.hold = this.k.hold;
      this.emit({ type: 'turbo', on: false });
    }
    this.retarget();
  }

  /** The speed the sped-up sound really has: the measured one when known (never above the requested step). */
  get rate() {
    // within 5 % of the step it is the step (no wobble from measurement noise when the speed holds)
    return this.real > 1 && this.real < this.ratio * 0.95 ? this.real : this.ratio;
  }

  /** Recorded 1× sound a stretch needs before it is searched (a bed needs less than a loop: DeSmuME has nothing else). */
  get minSeg() {
    return this.noStream ? this.k.minBedSeg : this.k.minSeg;
  }

  /** Beds instead of streams: the sped-up sound can't be slowed down (choppy, or not sped up at all). */
  get noStream() {
    return this.skip || this.chop.level > 0;
  }

  /** A new step while fast-forwarding: the sound around the re-toggle is at the wrong speed and has holes. */
  speedChange() {
    this.tGrace = Math.max(this.tGrace, this.k.tgrace); // no song-change judgement on the hiccup
    this.tSil = 0;
    this.tSkip = this.k.tskip;
    this.endSplice();
  }

  resetStretch() {
    this.sx.t = 3; // index 3 = the first sample of the next block
    this.sx.hl.fill(0);
    this.sx.hr.fill(0);
  }

  /** The recording skips ahead from here: crossfade into whatever comes next. */
  endSplice() {
    if (this.tail.xf) return;
    this.tail.xf = true;
    this.resetStretch();
  }

  /** Slowed-down sound into the ring, through the hold-back (crossfaded with it after a skip). */
  put(l, r, n) {
    const t = this.tail;
    const K = this.k.splice;
    const c = this.cat;
    if (!this.open) t.n = 0; // a new stretch starts (song change, cut): the held-back end belongs to the old one
    if (t.xf && t.n && n < t.n) return; // too little to crossfade with yet: still part of the skip
    const len = t.n + n;
    if (!c.l || c.l.length < len) {
      c.l = new Float32Array(len + 256);
      c.r = new Float32Array(len + 256);
    }
    c.l.set(t.l.subarray(0, t.n));
    c.r.set(t.r.subarray(0, t.n));
    let m = t.n;
    let i = 0;
    if (t.xf) {
      // the held-back old end and the new start overlap (both the same song, the skipped stretch apart)
      for (; i < t.n; i++) {
        const g = (i + 1) / (t.n + 1);
        c.l[i] = c.l[i] * (1 - g) + l[i] * g;
        c.r[i] = c.r[i] * (1 - g) + r[i] * g;
      }
    }
    t.xf = false;
    for (; i < n; i++, m++) {
      c.l[m] = l[i];
      c.r[m] = r[i];
    }
    const out = Math.max(0, m - K);
    if (out) this.store(c.l, c.r, out);
    t.n = m - out;
    t.l.set(c.l.subarray(out, m));
    t.r.set(c.r.subarray(out, m));
  }

  describe(l) {
    const r = (x, d) => (Number.isFinite(x) ? +x.toFixed(d) : null); // (a stream has no length, score or fine – never throw here)
    return { seconds: r(l.lag / this.sr, 2), score: r(l.score, 3), fine: r(l.fine, 3), xfade: r(l.xfade / this.sr, 2) };
  }

  valid(l) {
    return !!l.lib || this.ring.has(l.start - l.xfade, l.end);
  }

  /** Recorded for the song playing now (by its key; without keys: since the last song change). */
  fits(l) {
    return this.key != null ? l.key === this.key : l.song === this.song;
  }

  /**
   * At the switch to fast-forward: this stretch's own loop (it has the music playing now), else the one
   * from before the last switch – a short 1× stretch between two fast-forwards is the same music.
   */
  chooseLoop() {
    const keyed = this.key != null;
    const cur = this.open && this.silent < this.k.sil && this.found && this.found.segId === this.seg?.id && this.valid(this.found) && (!keyed || this.found.key === this.key) ? this.found : null;
    const old = this.carry && this.valid(this.carry) && (!keyed || this.carry.key === this.key) ? this.carry : null;
    if (!cur && this.noStream) {
      // nothing to slow down: this song's bed, else what played last time. Fast-forward splits a song into
      // stretches; what was found in an earlier stretch of the same song counts too. With keys: this song's loop
      // from the library, else nothing (the game's own sound, see retarget). Without: the most recent song's bed –
      // a guess after a song change, but never the skipping sound or silence while there is any.
      const same = (l) => (l && this.fits(l) && (keyed || this.silent < this.k.sil) && this.valid(l) && l.lag >= this.k.minPlay ? l : null);
      // the one that gives the most music before it repeats; recorded in this stretch wins a tie (it continues the song)
      const cands = [same(this.found), same(old), same(this.bed)].filter(Boolean);
      const lib = keyed && this.lib.get(this.key);
      let pick = cands.sort((a, b) => this.rank(b) - this.rank(a))[0] || null;
      if (lib && lib.lag >= this.k.minPlay && (!pick || this.rank(lib) > this.rank(pick) * 1.2)) pick = this.fromLib();
      if (!pick) pick = keyed ? this.fallback() : old || this.validBed() || this.fallback();
      if (pick && pick !== old && !pick.lib) pick.pos = this.continuation(pick);
      return (this.carry = pick);
    }
    if (cur) {
      cur.pos = this.continuation(cur);
      this.carry = cur;
    } else this.carry = old || this.fromLib();
    return this.carry;
  }

  /** The music bed of the stretch that was playing, if it's still in the ring (else null). */
  validBed() {
    const b = this.bed && this.valid(this.bed) && this.bed.lag >= this.k.minPlay ? this.bed : null;
    if (this.key == null) return b;
    const own = b && b.key === this.key ? b : null;
    const lib = this.lib.get(this.key);
    return lib && (!own || this.rank(lib) > this.rank(own) * 1.2) ? this.fromLib() : own;
  }

  /** Fast-forward with choppy sound and no loop: play the music bed (if there is one) instead of nothing. */
  useBed() {
    this.pending = false;
    const b = this.validBed();
    this.carry = b;
    if (b) {
      if (!b.lib) b.pos = this.continuation(b);
      if (this.turbo) this.tRec = false; // keep its samples, and listen for a song change
      this.emit({ type: 'turbo', on: this.turbo, loop: this.describe(b), bed: true, searching: false });
    }
    this.retarget();
    return b;
  }

  /** Where in the loop the game's music is right now (it repeats every `lag` samples). */
  continuation(l) {
    return l.start + ((this.ring.written - l.end) % l.lag);
  }

  /** No loop yet but enough sound recorded: search now and fade the music in once it's found. */
  wantSearch() {
    const u = this.usable();
    if (!u || this.silent >= this.k.sil || u.n * HOP < this.minSeg) return;
    if (!this.job || this.job.segId !== this.seg.id) this.startJob(u);
    this.pending = true;
  }

  /** The current stretch's frames that are safe to read (the ring keeps overwriting its oldest end). */
  usable() {
    const s = this.seg;
    if (!s || !this.open) return null;
    let f0 = s.frame + (s.trim || 0);
    const minStart = this.ring.oldest + this.k.margin;
    if (s.start < minStart && this.ring.oldest > 0) f0 += Math.ceil((minStart - s.start) / HOP);
    const n = this.frames - f0;
    return n > 0 ? { f0, n, end: s.start + (this.frames - s.frame) * HOP } : null;
  }

  /** Frames until the stretch is searched again: soon while what it gave is still too short to play (a few seconds more help). */
  researchAfter() {
    return this.segBest >= this.k.minPlay || this.segBestId !== this.seg?.id ? this.k.research : this.k.research >> 1;
  }

  startJob(u) {
    this.lastJob = { segId: this.seg.id, frame: this.frames };
    this.job = { segId: this.seg.id, song: this.song, key: this.key, at1: !this.turbo, end: u.end, gen: this.search(u) };
  }

  *search(u) {
    const feats = [];
    for (const src of this.feats) {
      const f = new Float32Array(u.n);
      for (let i = 0; i < u.n; i++) f[i] = src[(u.f0 + i) % this.fcap];
      feats.push(f);
      yield u.n;
    }
    return yield* findLoop(this.ring, feats, u.n, u.end, this.sr);
  }

  finishJob(res) {
    const { segId, song, key, at1 } = this.job;
    this.job = null;
    if (!res) {
      this.emit({ type: 'nofind', seg: segId, n: (this.info.nofind = (this.info.nofind || 0) + 1) });
      if (this.pending) this.emit({ type: 'turbo', on: this.turbo, loop: null, searching: false });
      this.pending = false;
      return;
    }
    res.segId = segId;
    res.song = song;
    res.key = key;
    res.pos = res.start;
    if (this.segBestId !== segId) [this.segBestId, this.segBest] = [segId, 0];
    this.segBest = Math.max(this.segBest, res.lag);
    if (at1) this.keep(res); // 1× material only: the slowed-down recording is a stand-in
    // the song changed while the search ran: the result is kept for that song, but it's not what plays now
    if (this.key != null && key !== this.key) {
      if (this.pending) this.emit({ type: 'turbo', on: this.turbo, loop: null, searching: false });
      this.pending = false;
      return;
    }
    if (res.bed) {
      this.bed = res;
      this.emit({ type: 'bed', ...this.describe(res) });
      if (this.pending && this.noStream && (!this.carry || this.carry.song !== res.song)) return this.useBed();
      if (this.pending) this.emit({ type: 'turbo', on: this.turbo, loop: null, searching: false });
      this.pending = false;
      return;
    }
    if (res.lag < this.k.minPlay || (this.found?.segId === segId && this.rank(this.found) > this.rank(res) && this.valid(this.found))) {
      // a repeated bar, not the song (or less than this stretch gave before): keep what plays – the game's sound, the
      // slowed-down stream, the better loop – and search again later
      this.emit({ type: 'found', short: true, ...this.describe(res) });
      if (this.pending) this.emit({ type: 'turbo', on: this.turbo, loop: null, searching: false });
      this.pending = false;
      return;
    }
    this.found = res;
    this.emit({ type: 'found', ...this.describe(res) });
    if (this.pending) {
      this.pending = false;
      res.pos = this.continuation(res);
      this.carry = res;
      if (this.turbo) this.tRec = false; // keep the loop's samples: stop writing over the ring
      this.emit({ type: 'turbo', on: this.turbo, loop: this.describe(res), searching: false });
      this.retarget();
    }
  }

  work(n) {
    if (!this.job && this.turbo) {
      if (this.mode !== 'music' || !this.tRec || this.paused || !this.open || this.silent >= this.k.sil) return;
      // a new song: play it from the slowed-down recording right away …
      // The recording grows r× faster than it plays, so a song without a loop falls behind: once it trails by
      // half the ring, it jumps ahead (a short fade) instead of running into overwritten samples.
      const behind = this.carry?.stream && this.ring.written - this.carry.pos > this.ring.cap / 2;
      if (this.noStream) return; // choppy or not sped up: nothing worth streaming
      if ((!this.carry && this.ring.written - this.seg.start >= this.k.lead) || behind) {
        const at = Math.max(this.seg.start, this.ring.written - this.k.margin);
        this.carry = { stream: true, key: this.key, song: this.song, start: at, pos: at, end: Infinity, lag: Infinity, xfade: 0, g: 0 };
        this.retarget();
        this.emit({ type: 'stream', seg: this.seg.id, jump: !!behind });
      }
      // … and look for its loop as soon as there is enough of it
      const u = this.usable();
      if (!u || u.n * HOP < this.minSeg) return;
      if (this.lastJob.segId === this.seg.id && this.frames - this.lastJob.frame < this.researchAfter()) return;
      this.startJob(u);
      this.pending = true;
      return;
    }
    if (!this.job) {
      if (this.turbo || this.paused || this.silent >= this.k.sil) return;
      const u = this.usable();
      if (!u || u.n * HOP < this.minSeg) return;
      if (this.lastJob.segId === this.seg.id && this.frames - this.lastJob.frame < this.researchAfter()) return;
      this.startJob(u);
      return;
    }
    let budget = Math.ceil((BUDGET * n) / 128) * (this.pending ? 4 : 1);
    while (budget > 0) {
      const r = this.job.gen.next();
      if (r.done) {
        this.finishJob(r.value);
        break;
      }
      budget -= r.value;
    }
  }

  ramp(r, target) {
    if (r.t === target && (r.v === target || r.s !== 0)) return;
    if (!this.quanta) {
      // nothing played yet (a mixer made while fast-forwarding): start where the mode says, no fade from 1×
      r.v = r.t = target;
      r.s = 0;
      return;
    }
    r.t = target;
    r.s = (target - r.v) / this.k.fade;
    if (r.s === 0) r.v = target;
  }

  /** Where live sound and loop should be headed now; the ramps get there without clicks. */
  retarget() {
    const ff = this.turbo || this.hold > 0; // sped-up sound may still be coming out of OpenAL
    if (ff && this.mode === 'music' && !this.paused && this.synth?.has(this.key)) {
      // the song itself, synthesized: game sound and loops fade out
      this.ramp(this.live, 0);
      this.ramp(this.loop, 0);
      this.ramp(this.syn, 1);
      return;
    }
    this.ramp(this.syn, 0);
    // "music" and "mute" never let the sped-up (or skipping) game sound through while fast-forwarding – "music" plays
    // what was recorded at 1×, or nothing; only "original" is the game's own fast-forward sound
    const quiet = ff && this.mode !== 'original';
    let loop = quiet && this.mode === 'music' && !this.paused;
    if (loop && this.turbo && this.carry && this.voice !== this.carry && this.loop.v === 0) this.voice = this.carry;
    if (this.voice && this.turbo && this.voice !== this.carry) loop = false; // another loop was chosen: fade this one out first
    if (!this.voice) loop = false;
    this.ramp(this.live, quiet ? 0 : 1);
    this.ramp(this.loop, loop ? 1 : 0);
  }

  record(l, r, n) {
    if (this.paused) return;
    if (this.turbo) return this.recordTurbo(l, r, n);
    if (this.settle > 0) {
      this.settle -= n;
      return;
    }
    this.store(l, r, n);
  }

  /** Fast-forward: listen for the silence of a song change, and record the sound slowed down when needed. */
  recordTurbo(l, r, n) {
    if (this.mode !== 'music') return;
    const skip = this.tSkip > 0;
    if (skip) this.tSkip -= n;
    if (this.tGrace > 0) {
      this.tGrace -= n;
      if (!this.tRec) return; // the old loop plays on; listening starts once the sound is settled
    }
    let e = 0;
    for (let i = 0; i < n; i++) {
      const m = (l[i] + r[i]) * 0.5;
      e += m * m;
    }
    if (e / n < SIL_LEVEL) this.turboQuiet(n);
    else this.tSil = 0;
    if (!this.tRec) return;
    if (skip || this.noStream) {
      this.zrun = 0;
      this.zhole = false;
      return this.endSplice();
    }
    // OpenAL's holes carry no music (the samples come late, not lost): leave them out – slowed down they would
    // be r× longer drop-outs – but count them as silence, like a block without any sound
    const h = this.unhole(l, r, n);
    if (h.holes) this.gap(h.holes);
    if (!h.n) return;
    const s = this.stretch(h.l, h.r, h.n);
    this.put(s.l, s.r, s.n);
  }

  /**
   * The block without runs of HOLE or more exact zeros (both channels). A run at the end of a block is held back
   * until the next one shows how long it gets. Returns { l, r, n, holes }.
   */
  unhole(l, r, n) {
    const z = this.zb;
    if (!z.l || z.l.length < n + HOLE) {
      z.l = new Float32Array(n + HOLE);
      z.r = new Float32Array(n + HOLE);
    }
    let run = this.zrun;
    let hole = this.zhole;
    let holes = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (l[i] === 0 && r[i] === 0) {
        if (hole) holes++;
        else if (++run >= HOLE) {
          holes += run;
          run = 0;
          hole = true;
        }
        continue;
      }
      for (; run > 0; run--) z.l[j] = z.r[j++] = 0; // a few zeros in the music itself
      hole = false;
      z.l[j] = l[i];
      z.r[j++] = r[i];
    }
    this.zrun = run;
    this.zhole = hole;
    return { l: z.l, r: z.r, n: j, holes };
  }

  /**
   * Softens the jumps of DeSmuME's fast-forward sound (RetroArch drops what doesn't fit, so the song jumps every
   * few ms): the sound runs ~1 ms late, and where a sample leaves the line of the two before by far more than the
   * sound usually does, a 1 ms fade-out/fade-in dips over the jump instead of a click. Only while `dips`.
   */
  declick(l, r, n, dips) {
    const d = this.dc;
    const D = d.D;
    if (!d.bl || d.bl.length < n) {
      d.bl = new Float32Array(n);
      d.br = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      const vl = l[i];
      const vr = r[i];
      const e = Math.max(Math.abs(vl - 2 * d.x1 + d.x0), Math.abs(vr - 2 * d.y1 + d.y0));
      if (dips && e > 0.03 && e > 8 * d.lvl) {
        // the jump reaches the output in D samples: be at zero by then
        d.dip = D + Math.round(Math.min(1, d.dip > D ? (d.dip - D) / D : d.dip === 0 ? 1 : (D - d.dip) / D) * D);
        d.x0 = d.x1 = vl;
        d.y0 = d.y1 = vr;
      } else {
        d.lvl += (e - d.lvl) * 0.002;
        d.x0 = d.x1;
        d.x1 = vl;
        d.y0 = d.y1;
        d.y1 = vr;
      }
      const k = d.at;
      const g = d.dip === 0 ? 1 : d.dip > D ? (d.dip - D) / D : (D - d.dip) / D;
      if (d.dip > 0) d.dip--;
      d.bl[i] = d.l[k] * g;
      d.br[i] = d.r[k] * g;
      d.l[k] = vl;
      d.r[k] = vr;
      d.at = (k + 1) % D;
    }
    return [d.bl, r === l ? d.bl : d.br];
  }

  zeros(n) {
    if (!this.zb0 || this.zb0.length < n) this.zb0 = new Float32Array(n);
    return this.zb0;
  }

  /** Share of short holes (not a silence – those are long) per 0.25 s of sped-up sound: many make it choppy. */
  judgeChop(l, r, n) {
    const c = this.chop;
    if (!l) c.run += n;
    else
      for (let i = 0; i < n; i++) {
        if (l[i] === 0 && r[i] === 0) c.run++;
        else if (c.run) {
          if (c.run >= this.k.minHole && c.run <= this.k.maxHole) {
            c.z += c.run;
            c.k++;
          }
          c.run = 0;
        }
      }
    c.n += n;
    if (c.n < this.k.chopWin) return;
    const share = c.z / c.n;
    const many = c.k >= this.k.chopHoles;
    c.z = c.n = c.k = 0;
    const was = c.level;
    if (share < 0.1 || !many) c.level = Math.max(0, c.level - 1);
    else if (share > 0.2) c.level = Math.min(3, c.level + 1);
    if (c.level !== was) this.emit({ type: 'chop', level: c.level, share: +share.toFixed(2) });
    if (c.level >= 2 && (this.carry?.stream || (!this.carry && this.tRec && this.bed))) {
      // the song being streamed would turn into buzz: the music bed takes over (or nothing); a new stretch
      // starts once the sound is clean again
      this.open = false;
      this.emit({ type: 'choppy' });
      this.useBed();
    }
  }

  /** Silence in the sped-up sound while the old loop plays: the song ended (area change) – stop it, listen anew. */
  turboQuiet(n) {
    if ((this.tRec && !this.noStream) || this.mode !== 'music') return; // while recording, store()/gap() judge the slowed-down sound
    if (this.tGrace > 0) return;
    this.tSil += n;
    if (this.tSil < Math.max(this.k.sil / (this.skip ? 1 : this.rate), this.k.tquiet)) return;
    this.tSil = 0;
    this.song++;
    if (this.noStream) {
      // the new song can't be heard in this sound (DeSmuME): keep the music going rather than fall silent
      this.emit({ type: 'turbo', on: true, loop: this.carry ? this.describe(this.carry) : null, changed: true, kept: true });
      return;
    }
    this.tRec = true;
    this.open = false;
    this.carry = null;
    this.emit({ type: 'turbo', on: true, loop: null, changed: true });
    this.retarget();
  }

  /** The sped-up block slowed down by the speed ratio (4-point Hermite interpolation, carried across blocks). */
  stretch(l, r, n) {
    const x = this.sx;
    const len = n + 3;
    const ratio = this.rate;
    const max = Math.ceil(len * ratio) + 2;
    if (!x.L || x.L.length < max) {
      x.L = new Float32Array(max);
      x.R = new Float32Array(max);
    }
    if (!x.bl || x.bl.length < len) {
      x.bl = new Float32Array(len);
      x.br = new Float32Array(len);
    }
    // the last three samples of the previous block, then this one
    x.bl.set(x.hl, 0);
    x.br.set(x.hr, 0);
    x.bl.set(l.subarray(0, n), 3);
    x.br.set(r.subarray(0, n), 3);
    const step = 1 / ratio;
    let t = x.t;
    let j = 0;
    while (Math.floor(t) + 2 < len) {
      const i = Math.floor(t);
      x.L[j] = hermite(x.bl, i, t - i);
      x.R[j] = hermite(x.br, i, t - i);
      j++;
      t += step;
    }
    x.t = t - n;
    x.hl.set(x.bl.subarray(n, n + 3));
    x.hr.set(x.br.subarray(n, n + 3));
    return { l: x.L, r: x.R, n: j };
  }

  store(l, r, n) {
    const a = this.acc;
    if (!this.open) {
      this.open = true;
      this.seg = { id: ++this.segIds, start: this.ring.written, frame: this.frames, trim: this.trimNext ? this.k.keyTrim : 0 };
      this.trimNext = false;
      a.start = this.ring.written;
      a.n = 0;
      a.e = 0;
      for (const b of this.bands) b.e = 0;
    }
    this.ring.push(l, r, n);
    const bands = this.bands;
    for (let i = 0; i < n; i++) {
      const m = (l[i] + r[i]) * 0.5;
      a.e += m * m;
      for (let j = 0; j < BANDS; j++) {
        const b = bands[j];
        const y = b.b0 * m + b.z1;
        b.z1 = b.z2 - b.a1 * y;
        b.z2 = -b.b0 * m - b.a2 * y;
        b.e += y * y;
      }
      if (++a.n === HOP) this.frame();
    }
  }

  frame() {
    const a = this.acc;
    const k = this.frames % this.fcap;
    const e = a.e / HOP;
    // floor at –60 dB: quiet bands stay flat instead of adding noise-floor jitter to the comparison
    for (let j = 0; j < BANDS; j++) {
      this.feats[j][k] = Math.log10(this.bands[j].e / HOP + 1e-6);
      this.bands[j].e = 0;
    }
    const start = a.start;
    this.frames++;
    a.start += HOP;
    a.n = 0;
    a.e = 0;
    if (e < SIL_LEVEL) {
      // a long silence: the music stopped (area change, fade to black) – the old loop is stale
      const was = this.silent;
      if ((this.silent += HOP) >= this.k.sil) {
        this.carry = null; // (a bed stays: the most recent song's, for DeSmuME)
        if (was < this.k.sil) this.song++;
      }
    } else {
      if (this.silent >= this.k.sil) this.seg = { id: ++this.segIds, start, frame: this.frames - 1 };
      this.silent = 0;
    }
  }

  /** A block without any sound (core not running, buffer gap, digital silence). */
  gap(n) {
    if (this.paused) return;
    if (this.turbo) {
      if (this.mode !== 'music') return;
      // the grace after the switch runs out in real time, sound or not: counted only on blocks with sound, a mixer whose
      // input stopped right after the switch (the core rebuilt its audio, player.html) never judged the silence and
      // played its loop on forever
      if (this.tGrace > 0) this.tGrace -= n;
      if (!this.tRec || this.noStream) return this.turboQuiet(n); // nothing recorded: judged on the sped-up sound
      n = Math.round(n * this.rate); // in slowed-down time
    } else if (this.settle > 0) {
      this.settle -= n; // (the sound held in OpenAL drains in silence too)
      return;
    }
    const was = this.silent;
    if ((this.silent += n) >= this.k.sil && this.open) {
      this.open = false;
      this.carry = null;
    }
    if (was < this.k.sil && this.silent >= this.k.sil) this.song++;
  }

  process(inL, inR, outL, outR, n = outL.length) {
    this.quanta++;
    if (inL && !inR) inR = inL;
    if (inL) {
      let i = 0;
      while (i < n && inL[i] === 0 && inR[i] === 0) i++;
      if (i === n) inL = inR = null;
    }
    if (this.turbo && this.mode === 'music' && !this.paused && !this.skip) this.judgeChop(inL, inR, n);
    if (inL) this.record(inL, inR, n);
    else {
      this.zrun = 0; // a block without any sound: whatever zeros came before belong to the hole
      this.zhole = true;
      this.gap(n);
    }
    this.work(n);
    if (this.hold > 0 && (this.hold -= n) <= 0) this.retarget();
    // DeSmuME: always through the 1 ms delay (switching it would jump), dips only while its sound skips
    if (this.skip) [inL, inR] = this.declick(inL || this.zeros(n), inR || this.zeros(n), n, this.turbo || this.hold > 0);
    this.mix(inL, inR, outL, outR, n);
    this.tellPlaying();
  }

  /** What reaches the speakers now: 'game' (its own sound), 'lib' / 'loop' / 'bed' / 'stream' (and for which song), 'quiet'. */
  playing() {
    if (this.syn.t > 0) return { src: 'sdat', of: this.synth.cur?.key ?? null, key: this.key, turbo: this.turbo, mode: this.mode };
    const v = this.voice && this.loop.t > 0 ? this.voice : null;
    const src = v ? (v.lib ? 'lib' : v.stream ? 'stream' : v.bed ? 'bed' : 'loop') : this.live.t > 0 ? 'game' : 'quiet';
    return { src, of: v ? (v.key ?? null) : null, key: this.key, turbo: this.turbo, mode: this.mode };
  }

  /** Tells the page whenever that changes (diagnostics: which music played when). */
  tellPlaying() {
    const p = this.playing();
    const sig = `${p.src}|${p.of}|${p.key}|${p.turbo}|${p.mode}|${this.voice ? this.voice.start : ''}`;
    if (sig === this.playSig) return;
    this.playSig = sig;
    this.emit({ type: 'play', ...p, seconds: this.voice && Number.isFinite(this.voice.lag) ? +(this.voice.lag / this.sr).toFixed(2) : null });
  }

  mix(inL, inR, outL, outR, n) {
    this.mixGame(inL, inR, outL, outR, n);
    const sy = this.syn;
    if (!this.synth || (this.paused && sy.v === 0)) return; // (paused: the song waits with the game)
    if (sy.v === sy.t && sy.v === 0) return this.synth.render(outL, outR, n, 0); // plays along silently, in time
    // the fade is per block: the synth's own crossfades between songs are per sample
    const from = sy.v;
    if (sy.v !== sy.t) {
      sy.v += sy.s * n;
      if ((sy.s > 0 && sy.v >= sy.t) || (sy.s < 0 && sy.v <= sy.t)) sy.v = sy.t;
    }
    const level = (from + sy.v) / 2;
    this.synth.render(outL, outR, n, outR === outL ? level / 2 : level); // (mono out: both sides land in one)
  }

  mixGame(inL, inR, outL, outR, n) {
    const lv = this.live;
    const lp = this.loop;
    const v = this.voice;
    if (!v && lv.v === 1 && lv.t === 1) {
      if (inL) {
        outL.set(inL.length === n ? inL : inL.subarray(0, n));
        if (outR !== outL) outR.set(inR.length === n ? inR : inR.subarray(0, n));
      } else {
        outL.fill(0, 0, n);
        outR.fill(0, 0, n);
      }
      return;
    }
    const { cap, l: L, r: R } = this.ring;
    if (v && !v.lib && (v.stream ? v.pos : v.start - v.xfade) < this.ring.oldest) {
      // overwritten meanwhile (long fast-forward) – drop it rather than play other samples
      this.voice = null;
      if (this.carry === v) this.carry = this.turbo && this.mode === 'music' && this.noStream ? this.fallback() : null;
      lp.v = lp.t = lp.s = 0;
      this.retarget(); // (nothing left to play: quiet then)
      return this.mixGame(inL, inR, outL, outR, n);
    }
    for (let i = 0; i < n; i++) {
      if (lv.v !== lv.t) {
        lv.v += lv.s;
        if ((lv.s > 0 && lv.v >= lv.t) || (lv.s < 0 && lv.v <= lv.t)) lv.v = lv.t;
      }
      if (lp.v !== lp.t) {
        lp.v += lp.s;
        if ((lp.s > 0 && lp.v >= lp.t) || (lp.s < 0 && lp.v <= lp.t)) lp.v = lp.t;
      }
      let l = 0;
      let r = 0;
      if (inL && lv.v > 0) {
        l = inL[i] * lv.v;
        r = inR[i] * lv.v;
      }
      let g = 1;
      if (v?.stream) {
        // the recording ran out (sound came late): fade out and wait instead of dropping to silence
        const left = this.ring.written - v.pos;
        v.g = left > UNDERRUN ? Math.min(1, v.g + 1 / UNDERRUN) : Math.max(0, Math.min(v.g, (left - 1) / UNDERRUN));
        g = v.g;
      }
      if (v && lp.v > 0 && g > 0) {
        // a library voice reads its own copy (int16, position = index), the others the ring
        const lib = v.lib;
        const k = lib ? v.pos : v.pos % cap;
        let a = lib ? (lib.l[k] / Q) * g : L[k] * g;
        let b = lib ? (lib.r[k] / Q) * g : R[k] * g;
        const into = v.pos - (v.end - v.xfade);
        if (into >= 0) {
          // approaching the loop end: blend into the stretch just before the loop start
          const t = into / v.xfade;
          const g1 = v.curve === 'linear' ? 1 - t : Math.cos(t * Math.PI * 0.5);
          const g2 = v.curve === 'linear' ? t : Math.sin(t * Math.PI * 0.5);
          const k2 = lib ? v.pos - v.lag : (v.pos - v.lag) % cap;
          a = a * g1 + (lib ? lib.l[k2] / Q : L[k2]) * g2;
          b = b * g1 + (lib ? lib.r[k2] / Q : R[k2]) * g2;
        }
        l += a * lp.v;
        r += b * lp.v;
        if (++v.pos >= v.end) v.pos -= v.lag;
      }
      outL[i] = l;
      if (outR !== outL) outR[i] = r;
    }
    if (v && lp.v === 0 && lp.t === 0) {
      this.voice = null;
      this.retarget(); // may start the newly chosen loop
    }
  }
}
