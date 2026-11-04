// AudioWorklet wrapper around TurboMixer (turboaudio.mjs) – sits between the emulator's OpenAL output and
// the volume gain in player.html. Runs on the audio thread, so the emulator's thread is never touched.
import { TurboMixer } from './turboaudio.mjs';

class TurboAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mixer = new TurboMixer(sampleRate, { onEvent: (e) => this.port.postMessage(e) });
    this.broken = false;
    this.port.onmessage = (e) => {
      try {
        this.mixer.command(e.data);
      } catch (err) {
        this.fail(err);
      }
    };
  }

  fail(err) {
    if (!this.broken) this.port.postMessage({ type: 'error', message: String(err?.message || err) });
    this.broken = true;
  }

  process(inputs, outputs) {
    const inp = inputs[0] || [];
    const out = outputs[0];
    const l = inp[0] || null;
    const r = inp[1] || l;
    if (!this.broken) {
      try {
        this.mixer.process(l, r, out[0], out[1] || out[0], out[0].length);
        return true;
      } catch (err) {
        this.fail(err);
      }
    }
    // something went wrong: plain pass-through, the game keeps its sound
    if (l) {
      out[0].set(l);
      out[1]?.set(r);
    }
    return true;
  }
}

registerProcessor('turbo-audio', TurboAudio);
