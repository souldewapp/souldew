// Tiny synthesized cues, plus a few recorded ones (web/assets/sounds/, decoded once and kept).
let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = 'square', gain = 0.06, slide = 0 } = {}) {
  const a = ac();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + start);
  if (slide) o.frequency.linearRampToValueAtTime(freq + slide, a.currentTime + start + dur);
  g.gain.setValueAtTime(gain, a.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.02);
}

const SAMPLES = {
  cartInsert: '/assets/sounds/cart-insert.wav', // a module clicking into its slot – the click is 68 ms in
  boot: '/assets/sounds/boot.wav', // power-on: swells in ~0.1 s, carries ~1.2 s, gone after 2 s
};
// The recording of the click is very quiet (RMS ~0.025, a twelfth of the boot sound): lifted this much, through a
// compressor so its peak can't clip.
const GAIN = { cartInsert: 3.2 };
const decoded = {};
function sample(name) {
  decoded[name] ||= fetch(SAMPLES[name]).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  }).then((b) => ac().decodeAudioData(b)).catch((e) => {
    delete decoded[name]; // try again next time
    throw e;
  });
  return decoded[name];
}

/** Fetch and decode a recorded cue ahead of time, so it plays on the dot. */
export function preload(name) {
  if (SAMPLES[name]) sample(name).catch(() => {});
}

async function playSample(name, { volume = 1, fallback } = {}) {
  let buf;
  try {
    buf = await sample(name);
  } catch {
    sounds[fallback]?.(); // the file couldn't be loaded – the synthesized version still says it
    return;
  }
  const a = ac();
  const src = a.createBufferSource();
  src.buffer = buf;
  const g = a.createGain();
  g.gain.value = Math.max(0, Math.min(1, volume)) * (GAIN[name] || 1);
  if (GAIN[name]) {
    const limit = a.createDynamicsCompressor();
    limit.threshold.value = -10; // measured: peak 0.92 instead of 0.56, about 6× louder than at a 30 % game volume
    limit.knee.value = 4;
    limit.ratio.value = 20;
    limit.attack.value = 0;
    limit.release.value = 0.08;
    src.connect(g).connect(limit).connect(a.destination);
  } else {
    src.connect(g).connect(a.destination);
  }
  src.start();
}

export const sounds = {
  catch() {
    tone(660, 0, 0.09);
    tone(880, 0.1, 0.09);
    tone(1320, 0.2, 0.18);
  },
  death() {
    tone(392, 0, 0.35, { type: 'triangle', gain: 0.12, slide: -60 });
    tone(311, 0.35, 0.35, { type: 'triangle', gain: 0.12, slide: -50 });
    tone(196, 0.7, 0.8, { type: 'triangle', gain: 0.14, slide: -40 });
  },
  ping() {
    tone(988, 0, 0.08, { type: 'sine', gain: 0.1 });
    tone(1319, 0.09, 0.14, { type: 'sine', gain: 0.1 });
  },
  boot() {
    playSample('boot', { fallback: 'bootChime' }).catch(() => {});
  },
  bootChime() {
    // two-note power-on chime – when the recorded boot sound can't be loaded
    tone(1046.5, 0, 0.07, { type: 'square', gain: 0.07 });
    tone(2093, 0.08, 0.55, { type: 'square', gain: 0.06 });
  },
  click() {
    tone(1800, 0, 0.025, { type: 'square', gain: 0.03 });
  },
  cartIn() {
    // a module clicking into its slot: a short plastic clack (filtered noise), a low thump, then the latch
    const a = ac();
    const noise = (start, dur, freq, gain) => {
      const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
      const src = a.createBufferSource();
      src.buffer = buf;
      const bp = a.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 1.4;
      const g = a.createGain();
      g.gain.value = gain;
      src.connect(bp).connect(g).connect(a.destination);
      src.start(a.currentTime + start);
    };
    noise(0, 0.05, 2400, 0.9);
    tone(140, 0, 0.09, { type: 'sine', gain: 0.22, slide: -60 });
    noise(0.07, 0.025, 4200, 0.5);
  },
  badge() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.14));
  },
  /** an app sound like the others: only the sounds setting turns it off, not the game's volume */
  cartInsert(opts = {}) {
    playSample('cartInsert', { fallback: 'cartIn', ...opts }).catch(() => {});
  },
};

export function play(name, enabled = true, opts) {
  if (!enabled) return;
  try {
    sounds[name]?.(opts);
  } catch {
    // audio blocked until first user interaction
  }
}
