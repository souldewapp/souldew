// AudioWorklet of the fast player (lib/nativeplayer.mjs): a ring buffer the page fills with the host's stereo samples
// (at the context's rate), drained through souldew's turbo mixer (turboaudio.mjs) – at 1× the game's sound as it is,
// while fast-forwarding the music at normal speed ("music"), silence ("mute") or the sped-up original ("original"; "plain"
// leaves the mixer out). The host sends fast-forward sound sped up by the real speed, as RetroArch does for player.html,
// so the mixer works here exactly as there. Underruns play silence; an overfull buffer (the page fell behind) drops the
// oldest samples so the delay stays short. If the mixer ever fails, the sound passes through as it is.
import { TurboMixer } from './turboaudio.mjs';

class NativeAudio extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = 65536; // frames (~2 s at 32 kHz)
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.maxLag = 4096; // ~125 ms – more is dropped
    this.inL = new Float32Array(128);
    this.inR = new Float32Array(128);
    this.plain = false;
    this.broken = false;
    this.mixer = new TurboMixer(sampleRate, { onEvent: (e) => this.port.postMessage({ type: 'mixer', e }) });
    for (const m of options?.processorOptions?.init || []) this.command(m);
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Float32Array) return this.push(d);
      if (d === 'clear') {
        this.read = this.write = 0;
        return;
      }
      this.command(d);
    };
  }

  command(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'mode') this.plain = m.mode === 'plain';
    try {
      this.mixer.command(m.type === 'mode' && m.mode === 'plain' ? { type: 'mode', mode: 'original' } : m);
    } catch (err) {
      this.fail(err);
    }
  }

  fail(err) {
    if (!this.broken) this.port.postMessage({ type: 'mixer', e: { type: 'error', message: String(err?.message || err) } });
    this.broken = true;
  }

  push(d) {
    const n = d.length >> 1;
    for (let i = 0; i < n; i++) {
      this.l[this.write] = d[i * 2];
      this.r[this.write] = d[i * 2 + 1];
      this.write = (this.write + 1) % this.size;
    }
    const lag = (this.write - this.read + this.size) % this.size;
    if (lag > this.maxLag) this.read = (this.write - (this.maxLag >> 1) + this.size) % this.size;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    if (this.inL.length < n) {
      this.inL = new Float32Array(n);
      this.inR = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      if (this.read === this.write) {
        this.inL[i] = 0;
        this.inR[i] = 0;
        continue;
      }
      this.inL[i] = this.l[this.read];
      this.inR[i] = this.r[this.read];
      this.read = (this.read + 1) % this.size;
    }
    if (!this.plain && !this.broken) {
      try {
        this.mixer.process(this.inL, this.inR, L, R, n);
        return true;
      } catch (err) {
        this.fail(err);
      }
    }
    L.set(this.inL.subarray(0, n));
    if (R !== L) R.set(this.inR.subarray(0, n));
    return true;
  }
}
registerProcessor('native-audio', NativeAudio);
