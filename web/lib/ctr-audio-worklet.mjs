// AudioWorklet of the 3DS player (lib/ctrplayer.mjs): a ring buffer the page fills with the core's stereo samples
// (already at the context's rate) and the audio thread drains. Underruns play silence; an overfull buffer (the page
// fell behind, a hiccup) drops the oldest samples so the delay stays short.
class CtrSink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 32768; // frames (~1 s at 32 kHz)
    this.l = new Float32Array(this.size);
    this.r = new Float32Array(this.size);
    this.read = 0;
    this.write = 0;
    this.maxLag = 4096; // ~125 ms – more is dropped
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === 'clear') {
        this.read = this.write = 0;
        return;
      }
      const n = d.length >> 1;
      for (let i = 0; i < n; i++) {
        this.l[this.write] = d[i * 2];
        this.r[this.write] = d[i * 2 + 1];
        this.write = (this.write + 1) % this.size;
      }
      const lag = (this.write - this.read + this.size) % this.size;
      if (lag > this.maxLag) this.read = (this.write - (this.maxLag >> 1) + this.size) % this.size;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      if (this.read === this.write) {
        L[i] = 0;
        R[i] = 0;
        continue;
      }
      L[i] = this.l[this.read];
      R[i] = this.r[this.read];
      this.read = (this.read + 1) % this.size;
    }
    return true;
  }
}
registerProcessor('ctr-sink', CtrSink);
