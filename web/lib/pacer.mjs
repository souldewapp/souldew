// Frame pacing for the built-in emulator (player.html).
//
// RetroArch's web build times the game with sleeps: at 1× its audio sync waits for room in the sound buffer, while
// fast-forwarding its frame limiter waits out the rest of each frame. Both sleeps are setTimeout calls (Asyncify), and a
// timer fires only on the system's timer tick – every 15.6 ms on many Windows PCs. With such a tick (measured: 2 ms
// sleeps that take 15.6) 4× reaches 2.1× and 2× 1.7×, and at 1× the picture stalls for up to ~40–50 ms while the core
// waits for its sound. So player.html switches both off in RetroArch (audio_sync, fastforward_ratio 0), catches the
// core's requests for its next main-loop step (requestAnimationFrame at 1×, setImmediate while fast-forwarding) and
// hands them to this pacer, which runs the steps from the display's frames: as many as the chosen speed needs since the
// last display frame. One per refresh on a 60 Hz screen, 4 in 5 at 75 Hz, 2 in 5 at 144 Hz – no timers in the game loop.
//
// Plain logic without DOM types: test/pacer.test.mjs drives it with a fake clock.

/** The rate RetroArch makes its sound for (video_refresh_rate in player.html's RetroArch config). */
export const PACE_FPS = 60;

/**
 * The sample rate the emulator's sound runs at (its AudioContext, RetroArch's audio_out_rate), for a sound card running
 * at `device` Hz: the card's own rate up to 48 kHz, above it 48 kHz (44.1 kHz for 88.2 / 176.4 kHz). A card set to
 * 96 or 192 kHz (a player's Windows PC: 96 kHz) gains nothing for Game Boy and DS sound, but doubles or quadruples
 * the work on the audio thread – the turbo mixer filters and searches every sample – and its loops and the
 * slowdowns were only ever measured up to 48 kHz. Chrome converts the finished mix to the card's rate in one piece.
 * 0 = unknown (RetroArch's and the browser's defaults then).
 */
export function soundRate(device) {
  const r = Math.round(Number(device) || 0);
  if (r < 22050 || r > 768000) return 0;
  if (r <= 48000) return r;
  return r % 44100 === 0 ? 44100 : 48000;
}

export class Pacer {
  /**
   * @param {object} [o]
   * @param {number} [o.fps] game frames per second at 1×
   * @param {() => number} [o.now] clock in ms (performance.now)
   */
  constructor({ fps = PACE_FPS, now = () => performance.now() } = {}) {
    this.fps = fps;
    this.now = now;
    this.step = null; // the core's next step, waiting for its turn
    this.speed = 1; // 1, 2, 3, 4 … or Infinity ("Max": as many frames as fit)
    this.corr = 0; // small speed correction that steers the sound buffer to its target (1× only, see player.html)
    this.acc = 0; // ms of game time owed
    this.last = 0; // timestamp of the last display frame
    this.disp = 0; // the display's frame interval, smoothed
    this.lastFrame = 0; // when the core last ran a frame
    this.resetStats();
  }

  resetStats() {
    this.ticks = 0; // display frames seen
    this.frames = 0; // core steps run
    this.busy = 0; // ms spent running them
    this.maxGap = 0; // longest stretch without a core step (ms)
    this.budgetHits = 0; // display frames in which the core used up its share and frames were left out
  }

  /** The core asks to run its next step. */
  request(step) {
    this.step = step;
  }

  /** A new speed step: starts without debt. */
  setSpeed(speed) {
    this.speed = speed === Infinity ? Infinity : Math.max(1, Number(speed) || 1);
    this.acc = 0;
  }

  /** ms per game frame at the current speed (0 = no limit). */
  period() {
    if (this.speed <= 1) return 1000 / this.fps;
    return Number.isFinite(this.speed) ? 1000 / (this.fps * this.speed) : 0;
  }

  /** A display frame at time `t` (ms): runs the steps that are due. Returns how many ran. */
  tick(t) {
    const dt = this.last ? Math.min(250, t - this.last) : 0;
    this.last = t;
    if (dt > 0 && dt < 60) this.disp = this.disp ? this.disp * 0.95 + dt * 0.05 : dt;
    this.ticks++;
    if (!this.step) {
      this.acc = 0; // paused, or a step still under way: no debt builds up meanwhile
      return 0;
    }
    const period = this.period();
    let d = dt;
    if (this.speed <= 1) {
      d *= 1 + this.corr;
      // A display at (a multiple of) the game's rate: exactly one frame per refresh. The tiny difference (59.94 vs
      // 60 Hz) is RetroArch's audio rate control's job – counted by the clock, the two would beat (a skipped or doubled
      // frame every few seconds).
      const k = Math.round(d / period);
      if (k >= 1 && k <= 4 && Math.abs(d - k * period) < k * period * 0.006) d = k * period;
    }
    this.acc += d;
    const start = this.now();
    // the rest of the display frame belongs to the page (the app shares this thread)
    const budget = Math.max(4, Math.min(this.disp || 1000 / 60, 33) * 0.75);
    const slack = Math.min(2, period * 0.12);
    let n = 0;
    while (this.step && (period === 0 || this.acc >= period - slack)) {
      if (n > 0 && this.now() - start > budget) {
        // this computer can't do more right now: forget the rest instead of catching up in a burst later
        this.budgetHits++;
        this.acc = Math.min(this.acc, period);
        break;
      }
      const step = this.step;
      this.step = null;
      const s = this.now();
      if (this.lastFrame) this.maxGap = Math.max(this.maxGap, s - this.lastFrame);
      this.lastFrame = s;
      step();
      this.acc -= period;
      this.frames++;
      n++;
    }
    this.busy += this.now() - start;
    this.acc = period === 0 ? 0 : Math.max(-period, Math.min(this.acc, 2 * period));
    return n;
  }
}
