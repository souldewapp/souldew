// Plays a DS song (a pack from sdat.mjs) the way the DS's sound driver does: the sequencer ticks at the song's
// tempo (48 ticks per quarter, updated ~192 times a second like the ARM7's sound timer), 16 channels with the
// driver's envelopes (attack/decay/sustain/release), LFO, portamento, pitch bend, pan and its decibel volume
// tables. Plain DSP without Web Audio types: it runs inside the turbo mixer (AudioWorklet or its fallback) and in
// tests. Output is the music alone, at normal speed – no sound effects.

const UPDATE_HZ = 33513982 / (64 * 2728); // ≈ 191.97: how often the driver updates sequences and channels
const AMPL_MIN = -92544; // envelope floor (-723 × 128): silent
const VOL_MIN = -723;

// the driver's volume curve: 0.1 dB steps of (x / 127)², floored at -72.2 dB
const DB_SQUARE = Array.from({ length: 128 }, (_, x) => (x === 0 ? -32768 : x === 1 ? -722 : x === 2 ? -721 : Math.round(400 * Math.log10(x / 127))));
const cnvSust = (v) => DB_SQUARE[Math.max(0, Math.min(127, v | 0))];
const ATTACK_LUT = [0x00, 0x01, 0x05, 0x0e, 0x1a, 0x26, 0x33, 0x3f, 0x49, 0x54, 0x5c, 0x64, 0x6d, 0x74, 0x7b, 0x7f, 0x84, 0x89, 0x8f];
const cnvAttack = (a) => (a >= 0x6d ? ATTACK_LUT[0x7f - a] : 0xff - a);
const cnvFall = (f) => (f === 0x7f ? 0xffff : f === 0x7e ? 0x3c00 : f < 0x32 ? ((f << 1) + 1) & 0xffff : Math.floor(0x1e00 / (0x7e - f)) & 0xffff);
// quarter sine in 33 steps (the driver's SND_SinIdx), 0…127
const SIN = Array.from({ length: 33 }, (_, i) => Math.round(127 * Math.sin((i / 32) * (Math.PI / 2))));
const sinIdx = (x) => (x < 32 ? SIN[x] : x < 64 ? SIN[64 - x] : x < 96 ? -SIN[x - 64] : -SIN[128 - x]);
const PSG_RATE = 33513982 / 2 / 8006; // the driver's PSG timer: an 8-step wave at this sample rate

const ATTACK = 0;
const DECAY = 1;
const SUSTAIN = 2;
const RELEASE = 3;

/** Deterministic pseudo-random numbers (the sequence's random commands; the same song plays the same way). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

class Track {
  constructor(player, num, pos) {
    this.p = player;
    this.num = num;
    this.pos = pos;
    this.wait = 0;
    this.ended = false;
    this.calls = [];
    this.loops = [];
    this.noteWait = true;
    this.tie = false;
    this.prg = 0;
    this.vol = 127;
    this.expr = 127;
    this.pan = 64;
    this.transpose = 0;
    this.bend = 0;
    this.bendRange = 2;
    this.prio = 64;
    this.portaOn = false;
    this.portaKey = 60;
    this.portaTime = 0;
    this.sweep = 0;
    this.mod = { depth: 0, speed: 16, type: 0, range: 1, delay: 0 };
    this.adsr = [0xff, 0xff, 0xff, 0xff];
    this.flag = true;
    this.chans = [];
  }
}

class Channel {
  constructor(i) {
    this.i = i;
    this.on = false;
  }
}

/** One song: its sequencer and channels. render() adds its sound into the given buffers. */
export class SseqPlayer {
  constructor(pack, sampleRate, { seed = 1 } = {}) {
    this.pack = pack;
    this.sr = sampleRate;
    this.seq = pack.seq;
    this.vol = pack.vol ?? 127;
    this.master = 127;
    this.tempo = 120;
    this.tempoCount = 0;
    this.vars = new Int16Array(32).fill(-1);
    this.rand = rng(seed * 2654435761 + (pack.id | 0));
    this.tracks = [new Track(this, 0, 0)];
    this.chans = Array.from({ length: 16 }, (_, i) => new Channel(i));
    this.toNext = 0; // output samples left until the next driver update
    this.perUpdate = sampleRate / UPDATE_HZ;
    this.ended = false;
    this.ticks = 0;
  }

  // ---- reading the command stream
  u8(t) {
    return this.seq[t.pos++] ?? 0;
  }
  u16(t) {
    const v = this.u8(t);
    return v | (this.u8(t) << 8);
  }
  s16(t) {
    return (this.u16(t) << 16) >> 16;
  }
  u24(t) {
    const v = this.u16(t);
    return v | (this.u8(t) << 16);
  }
  varlen(t) {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8(t);
      v = (v << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return v;
  }

  /** Argument kinds per command, for random (0xA0) and variable (0xA1) prefixes: the last one is replaced. */
  argKinds(cmd) {
    if (cmd < 0x80) return ['u8', 'var'];
    if (cmd === 0x80 || cmd === 0x81) return ['var'];
    if (cmd === 0x93) return ['u8', 'u24'];
    if (cmd === 0x94 || cmd === 0x95) return ['u24'];
    if (cmd >= 0xb0 && cmd <= 0xbd) return ['u8', 's16'];
    if (cmd >= 0xc0 && cmd <= 0xd6) return ['u8'];
    if (cmd === 0xe0 || cmd === 0xe1 || cmd === 0xe3) return ['s16'];
    if (cmd === 0xfe) return ['u16'];
    return [];
  }

  readArg(t, kind) {
    return kind === 'u8' ? this.u8(t) : kind === 'u16' ? this.u16(t) : kind === 's16' ? this.s16(t) : kind === 'u24' ? this.u24(t) : this.varlen(t);
  }

  /** Runs one command of track t. */
  step(t) {
    let cmd = this.u8(t);
    let mode = null;
    let cond = true;
    if (cmd === 0xa2) {
      cond = t.flag;
      cmd = this.u8(t);
    }
    if (cmd === 0xa0 || cmd === 0xa1) {
      mode = cmd;
      cmd = this.u8(t);
    }
    let args;
    if (mode) {
      const kinds = this.argKinds(cmd);
      args = kinds.slice(0, -1).map((k) => this.readArg(t, k));
      if (mode === 0xa0) {
        const lo = this.s16(t);
        const hi = this.s16(t);
        args.push(lo + Math.floor(this.rand() * (hi - lo + 1)));
      } else args.push(this.vars[this.u8(t) & 31]);
    } else args = this.argKinds(cmd).map((k) => this.readArg(t, k));
    if (!cond) return;
    this.exec(t, cmd, args);
  }

  exec(t, cmd, a) {
    if (cmd < 0x80) return this.note(t, cmd, a[0], a[1]);
    switch (cmd) {
      case 0x80:
        t.wait = a[0];
        return;
      case 0x81:
        t.prg = a[0];
        return;
      case 0x93:
        if (!this.tracks.some((x) => x.num === a[0]) && this.tracks.length < 16) this.tracks.push(new Track(this, a[0], a[1]));
        return;
      case 0x94:
        t.pos = a[0];
        return;
      case 0x95:
        if (t.calls.length < 3) {
          t.calls.push(t.pos);
          t.pos = a[0];
        }
        return;
      case 0xfd:
        if (t.calls.length) t.pos = t.calls.pop();
        return;
      case 0xd4:
        if (t.loops.length < 3) t.loops.push({ pos: t.pos, count: a[0] });
        return;
      case 0xfc: {
        const l = t.loops[t.loops.length - 1];
        if (!l) return;
        if (l.count === 0 || --l.count > 0) t.pos = l.pos;
        else t.loops.pop();
        return;
      }
      case 0xff:
        t.ended = true;
        for (const c of t.chans) this.release(c);
        return;
      case 0xfe:
        return;
      case 0xc0:
        t.pan = a[0];
        return;
      case 0xc1:
        t.vol = a[0];
        return;
      case 0xc2:
        this.master = a[0];
        return;
      case 0xc3:
        t.transpose = (a[0] << 24) >> 24;
        return;
      case 0xc4:
        t.bend = (a[0] << 24) >> 24;
        return;
      case 0xc5:
        t.bendRange = a[0];
        return;
      case 0xc6:
        t.prio = a[0];
        return;
      case 0xc7:
        t.noteWait = !!a[0];
        return;
      case 0xc8:
        t.tie = !!a[0];
        if (!t.tie) for (const c of t.chans) this.release(c);
        return;
      case 0xc9:
        t.portaKey = a[0] + t.transpose;
        t.portaOn = true;
        return;
      case 0xca:
        t.mod.depth = a[0];
        return;
      case 0xcb:
        t.mod.speed = a[0];
        return;
      case 0xcc:
        t.mod.type = a[0];
        return;
      case 0xcd:
        t.mod.range = a[0];
        return;
      case 0xce:
        t.portaOn = !!a[0];
        return;
      case 0xcf:
        t.portaTime = a[0];
        return;
      case 0xd0:
      case 0xd1:
      case 0xd2:
      case 0xd3:
        t.adsr[cmd - 0xd0] = a[0];
        return;
      case 0xd5:
        t.expr = a[0];
        return;
      case 0xe0:
        t.mod.delay = a[0] & 0xffff;
        return;
      case 0xe1:
        this.tempo = a[0] & 0xffff;
        return;
      case 0xe3:
        t.sweep = a[0];
        return;
      default:
        if (cmd >= 0xb0 && cmd <= 0xbd) return this.varOp(t, cmd, a[0] & 31, a[1]);
    }
  }

  varOp(t, cmd, v, x) {
    const V = this.vars;
    switch (cmd) {
      case 0xb0: V[v] = x; break;
      case 0xb1: V[v] += x; break;
      case 0xb2: V[v] -= x; break;
      case 0xb3: V[v] *= x; break;
      case 0xb4: if (x) V[v] = Math.trunc(V[v] / x); break;
      case 0xb5: V[v] = x >= 0 ? V[v] << x : V[v] >> -x; break;
      case 0xb6: V[v] = x >= 0 ? Math.floor(this.rand() * (x + 1)) : -Math.floor(this.rand() * (-x + 1)); break;
      case 0xb8: t.flag = V[v] === x; break;
      case 0xb9: t.flag = V[v] >= x; break;
      case 0xba: t.flag = V[v] > x; break;
      case 0xbb: t.flag = V[v] <= x; break;
      case 0xbc: t.flag = V[v] < x; break;
      case 0xbd: t.flag = V[v] !== x; break;
    }
  }

  region(prg, key) {
    const regions = this.pack.programs[prg];
    if (!regions) return null;
    for (const r of regions) if (key >= r.lo && key <= r.hi) return r;
    return null;
  }

  /** A free channel for this kind (PSG only on 8–13, noise on 14–15), else the quietest releasing / lowest one. */
  alloc(kind, prio) {
    const allowed = kind === 'psg' ? [8, 9, 10, 11, 12, 13] : kind === 'noise' ? [14, 15] : [4, 5, 6, 7, 2, 0, 3, 1, 8, 9, 10, 11, 14, 12, 15, 13];
    let best = null;
    for (const i of allowed) {
      const c = this.chans[i];
      if (!c.on) return c;
      const score = (c.state === RELEASE ? 0 : 1e6) + c.prio * 1e3 + (c.ampl - AMPL_MIN) / 100;
      if (!best || score < best.score) best = { c, score };
    }
    if (best && (best.c.state === RELEASE || best.c.prio <= prio)) return best.c;
    return null;
  }

  note(t, key, vel, len) {
    key += t.transpose;
    if (t.noteWait) t.wait = len;
    if (t.tie) {
      const c = t.chans.find((x) => x.on && x.state !== RELEASE);
      if (c) {
        c.key = key;
        c.vel = cnvSust(vel);
        c.len = -1;
        if (t.portaOn) this.porta(t, c, key, len);
        t.portaKey = key;
        return;
      }
    }
    const r = this.region(t.prg, key);
    if (!r) return;
    const prio = t.prio;
    const c = this.alloc(r.kind, prio);
    if (!c) return;
    if (c.on && c.track) c.track.chans = c.track.chans.filter((x) => x !== c);
    c.on = true;
    c.track = t;
    c.prio = prio;
    c.r = r;
    c.kind = r.kind;
    c.wave = r.kind === 'pcm' ? this.pack.waves[r.wave] : null;
    if (r.kind === 'pcm' && !c.wave) {
      c.on = false;
      return;
    }
    c.key = key;
    c.vel = cnvSust(vel);
    c.len = t.tie ? -1 : len;
    c.attack = cnvAttack(t.adsr[0] !== 0xff ? t.adsr[0] : r.a);
    c.decay = cnvFall(t.adsr[1] !== 0xff ? t.adsr[1] : r.d);
    c.sustain = cnvSust(t.adsr[2] !== 0xff ? t.adsr[2] : r.s) << 7;
    c.release = cnvFall(t.adsr[3] !== 0xff ? t.adsr[3] : r.r);
    c.ampl = AMPL_MIN;
    c.state = ATTACK;
    c.pos = 0;
    c.lfsr = 0x7fff;
    c.noiseOut = 0;
    c.modCount = 0;
    c.modDelay = 0;
    c.sweepPitch = t.sweep;
    c.sweepLen = 0;
    c.sweepCnt = 0;
    if (t.portaOn) this.porta(t, c, key, len);
    t.portaKey = key;
    t.chans.push(c);
    c.lastL = c.lastR = 0;
    this.updateChannel(c, true);
  }

  porta(t, c, key, len) {
    c.sweepPitch += (t.portaKey - key) << 6;
    if (t.portaTime === 0) c.sweepLen = len;
    else {
      const sq = t.portaTime * t.portaTime;
      c.sweepLen = (Math.abs(c.sweepPitch) * sq) >> 11;
    }
    c.sweepCnt = 0;
  }

  release(c) {
    if (c.on && c.state !== RELEASE) c.state = RELEASE;
  }

  kill(c) {
    c.on = false;
    if (c.track) c.track.chans = c.track.chans.filter((x) => x !== c);
    c.track = null;
  }

  /** One sequencer tick for every track: note lengths count down, then commands run until the next wait. */
  tick() {
    this.ticks++;
    for (const t of this.tracks) {
      for (const c of t.chans) {
        if (c.len > 0 && --c.len === 0) this.release(c);
      }
      if (t.ended) continue;
      if (t.wait > 0 && --t.wait > 0) continue;
      let guard = 0;
      while (!t.ended && t.wait === 0 && guard++ < 10000) {
        if (t.pos >= this.seq.length) {
          t.ended = true;
          break;
        }
        this.step(t);
      }
    }
    if (this.tracks.every((t) => t.ended) && this.chans.every((c) => !c.on)) this.ended = true;
  }

  /** The driver's per-update channel work: envelope, LFO, sweep → this update's gains and pitch. */
  updateChannel(c, first = false) {
    const t = c.track;
    if (!first) {
      if (c.state === ATTACK) {
        c.ampl = Math.trunc((c.attack * c.ampl) / 256);
        if (c.ampl === 0) c.state = DECAY;
      } else if (c.state === DECAY) {
        c.ampl -= c.decay;
        if (c.ampl <= c.sustain) {
          c.ampl = c.sustain;
          c.state = SUSTAIN;
        }
      } else if (c.state === RELEASE) {
        c.ampl -= c.release;
        if (c.ampl <= AMPL_MIN) return this.kill(c);
      }
    }
    // LFO
    let lfo = 0;
    const m = t ? t.mod : null;
    if (m && m.depth) {
      if (c.modDelay < m.delay) c.modDelay++;
      else {
        const speed = m.speed << 6;
        let counter = (c.modCount + speed) >> 8;
        while (counter >= 0x80) counter -= 0x80;
        c.modCount = ((c.modCount + speed) & 0xff) | (counter << 8);
        const v = sinIdx(c.modCount >> 8) * m.depth * m.range;
        lfo = m.type === 1 ? (v * 60) >> 14 : v >> 8;
      }
    }
    // sweep (portamento)
    let sweep = 0;
    if (c.sweepPitch && c.sweepLen > 0 && c.sweepCnt <= c.sweepLen) {
      sweep = Math.trunc((c.sweepPitch * (c.sweepLen - c.sweepCnt)) / c.sweepLen);
      c.sweepCnt++;
    } else if (c.sweepPitch && !c.sweepLen) sweep = c.sweepPitch;
    // volume in 0.1 dB
    let vol = (c.ampl >> 7) + c.vel;
    if (t) vol += cnvSust(t.vol) + cnvSust(t.expr);
    vol += cnvSust(this.vol) + cnvSust(this.master);
    if (m && m.type === 1) vol += lfo;
    const gain = vol <= VOL_MIN ? 0 : Math.pow(10, vol / 200);
    // pan 0…127
    let pan = (t ? t.pan : 64) + (c.r.pan - 64);
    if (m && m.type === 2) pan += lfo;
    pan = Math.max(0, Math.min(127, pan));
    c.gL = (gain * (127 - pan)) / 127;
    c.gR = (gain * pan) / 127;
    // pitch in 1/64 semitone
    let pitch = (c.key - c.r.base) * 64 + sweep;
    if (t) pitch += (t.bend * t.bendRange) >> 1;
    if (m && m.type === 0) pitch += lfo;
    const ratio = Math.pow(2, pitch / 768);
    const rate = c.kind === 'pcm' ? c.wave.rate : PSG_RATE;
    c.step = (rate * ratio) / this.sr;
  }

  /** Adds n samples of the song into outL/outR (from `at`), scaled by `gain`. */
  render(outL, outR, at, n, gain = 1) {
    let i = 0;
    while (i < n) {
      if (this.toNext <= 0) {
        // one driver update: sequencer ticks at the tempo, then the channels
        this.tempoCount += this.tempo;
        while (this.tempoCount >= 240) {
          this.tempoCount -= 240;
          this.tick();
        }
        for (const c of this.chans) if (c.on) this.updateChannel(c);
        this.toNext += this.perUpdate;
      }
      const len = Math.min(n - i, Math.ceil(this.toNext));
      for (const c of this.chans) if (c.on) this.voice(c, outL, outR, at + i, len, gain);
      this.toNext -= len;
      i += len;
    }
  }

  voice(c, outL, outR, at, n, gain) {
    // gains glide over the block (the driver changes them per update; a glide avoids zipper noise)
    const gl = c.gL * gain;
    const gr = c.gR * gain;
    const dl = (gl - c.lastL) / n;
    const dr = (gr - c.lastR) / n;
    let vl = c.lastL;
    let vr = c.lastR;
    c.lastL = gl;
    c.lastR = gr;
    const step = c.step;
    if (c.kind === 'pcm') {
      const w = c.wave;
      const d = w.data;
      const len = d.length;
      const ls = w.loop ? Math.min(w.loopStart, len - 1) : 0;
      let pos = c.pos;
      for (let k = 0; k < n; k++) {
        if (pos >= len) {
          if (!w.loop || len - ls < 1) {
            this.kill(c);
            break;
          }
          pos = ls + ((pos - len) % (len - ls));
        }
        const j = pos | 0;
        const f = pos - j;
        const a = d[j];
        const b = j + 1 < len ? d[j + 1] : w.loop ? d[ls] : 0;
        const x = a + (b - a) * f;
        vl += dl;
        vr += dr;
        outL[at + k] += x * vl;
        outR[at + k] += x * vr;
        pos += step;
      }
      c.pos = pos;
    } else if (c.kind === 'psg') {
      const duty = c.r.duty ?? 0;
      let pos = c.pos;
      for (let k = 0; k < n; k++) {
        const ph = (pos | 0) & 7;
        const x = duty === 7 ? -0.5 : ph <= duty ? 0.5 : -0.5;
        vl += dl;
        vr += dr;
        outL[at + k] += x * vl;
        outR[at + k] += x * vr;
        pos += step;
        if (pos >= 8) pos -= 8;
      }
      c.pos = pos;
    } else {
      // noise: a 15-bit LFSR clocked at the channel's rate
      let pos = c.pos;
      let x = c.noiseOut;
      let s = c.lfsr;
      for (let k = 0; k < n; k++) {
        pos += step;
        while (pos >= 1) {
          pos -= 1;
          const carry = s & 1;
          s >>= 1;
          if (carry) {
            s ^= 0x6000;
            x = -0.5;
          } else x = 0.5;
        }
        vl += dl;
        vr += dr;
        outL[at + k] += x * vl;
        outR[at + k] += x * vr;
      }
      c.pos = pos;
      c.lfsr = s;
      c.noiseOut = x;
    }
  }
}

/**
 * The songs as the mixer uses them: one plays (the current song key), the one before fades out. Songs start when
 * their key appears and run on silently at 1×, so during fast-forward the music is where the game's would be.
 */
export class SdatSynth {
  constructor(sampleRate, { gain = 1, fade = 0.35 } = {}) {
    this.sr = sampleRate;
    this.gain = gain;
    this.packs = new Map(); // key → pack (the latest few)
    this.waves = new Map(); // uid → decoded sample, shared by the songs that use it
    this.cur = null; // { key, player, g, s }
    this.old = null;
    this.fadeLen = Math.round(fade * sampleRate);
    this.pendingKey = null;
    this.pendingAt = 0;
    this.clock = 0; // samples rendered so far
    this.tmpL = null;
    this.tmpR = null;
  }

  has(key) {
    return !!key && this.cur?.key === key;
  }

  /** A pack for `key` arrived (from the worker; samples this synth already has come as { uid } only). */
  add(key, pack) {
    if (!key || !pack) return;
    pack = { ...pack, waves: pack.waves.map((w) => {
      if (!w.uid) return w;
      if (w.data) this.waves.set(w.uid, w);
      return this.waves.get(w.uid) || null;
    }) };
    this.packs.delete(key);
    this.packs.set(key, pack);
    // (samples stay: the worker sends each one once, and a game's songs share a few banks – tens of MB at most)
    while (this.packs.size > 8) this.packs.delete(this.packs.keys().next().value);
    if (this.pendingKey === key) this.start(key, this.clock - this.pendingAt);
  }

  /** The game's song changed: start that song (caught up by the time its pack took to arrive). */
  song(key) {
    if (this.cur?.key === key) return;
    this.pendingKey = key;
    this.pendingAt = this.clock;
    if (this.cur) {
      this.old = { ...this.cur, g: this.cur.g, s: -1 / this.fadeLen };
      this.cur = null;
    }
    if (key && this.packs.has(key)) this.start(key, 0);
  }

  start(key, late) {
    const pack = this.packs.get(key);
    if (!pack) return;
    const player = new SseqPlayer(pack, this.sr);
    // catch up: the song has been playing in the game for `late` samples already
    if (late > 0) {
      const max = Math.min(late, this.sr * 10);
      const scratch = new Float32Array(1024);
      for (let done = 0; done < max; done += 1024) {
        const n = Math.min(1024, max - done);
        player.render(scratch, scratch, 0, n, 0);
      }
    }
    this.cur = { key, player, g: this.old ? 0 : 1, s: this.old ? 1 / this.fadeLen : 0 };
    this.pendingKey = null;
  }

  /** Adds n samples of music (× level) into outL/outR; level is the mixer's fade for the synth (0 = silent). */
  render(outL, outR, n, level) {
    this.clock += n;
    if (!this.tmpL || this.tmpL.length < n) {
      this.tmpL = new Float32Array(n);
      this.tmpR = new Float32Array(n);
    }
    for (const v of [this.old, this.cur]) {
      if (!v) continue;
      const L = this.tmpL;
      const R = this.tmpR;
      L.fill(0, 0, n);
      R.fill(0, 0, n);
      v.player.render(L, R, 0, n, this.gain);
      if (level <= 0 && v.s === 0) continue; // runs on silently, in time with the game
      for (let i = 0; i < n; i++) {
        if (v.s) {
          v.g += v.s;
          if (v.g >= 1) {
            v.g = 1;
            v.s = 0;
          } else if (v.g <= 0) {
            v.g = 0;
            v.s = 0;
          }
        }
        const g = v.g * level;
        outL[i] += L[i] * g;
        outR[i] += R[i] * g;
      }
    }
    if (this.old && this.old.g <= 0) this.old = null;
  }
}
