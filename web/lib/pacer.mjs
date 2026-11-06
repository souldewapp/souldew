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
// While fast-forwarding the core gets 75 % of each display frame and whatever doesn't fit is left out: the page (the
// app shares this thread) stays smooth, but a heavy core or a slow computer then stays below the chosen speed. Settings ›
// "Full-power turbo" (`full`) lifts that brake: the core may use the display frame up to FULL_SHARE of it, counted from
// the frame's start, in slices of at most FULL_SLICE ms – between them player.html yields (a message round trip, no
// timer), so clicks, keys and the app's own work still get through – and what is still owed when the frame is over is
// dropped as before (no burst afterwards). At 1× nothing changes.
//
// Plain logic without DOM types: test/pacer.test.mjs drives it with a fake clock.

/** The rate RetroArch makes its sound for (video_refresh_rate in player.html's RetroArch config). */
export const PACE_FPS = 60;
/** Share of a display frame the core may use while fast-forwarding at full power (the rest: drawing the page). */
export const FULL_SHARE = 0.92;
/** Longest stretch (ms) the core runs at full power before the page gets its turn. */
export const FULL_SLICE = 6;

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
    this.full = false; // Settings › "Full-power turbo": fast-forward may use (nearly) the whole display frame
    this.deadline = 0; // full power: the end of the current display frame's share (0 = no slices to come)
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
    if (this.deadline) this.settle(this.due()); // full power: the last frame's slices didn't come round (busy page)
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
    const frame = Math.min(this.disp || 1000 / 60, 33);
    if (this.full && this.speed > 1) {
      // full power: FULL_SHARE of a display frame, in slices
      this.deadline = start + frame * FULL_SHARE;
      return this.run(start, Math.min(this.deadline, start + FULL_SLICE));
    }
    // the rest of the display frame belongs to the page (the app shares this thread)
    return this.run(start, start + Math.max(4, frame * 0.75));
  }

  /** Full power: steps are still due in this display frame's share – player.html then calls slice() after a yield. */
  pending(t) {
    return !!this.deadline && t < this.deadline && this.due();
  }

  /** Full power: the next slice of the current display frame (after the page had its turn). Returns how many ran. */
  slice(t) {
    if (this.pending(t)) return this.run(this.now(), Math.min(this.deadline, t + FULL_SLICE));
    if (this.deadline) this.settle(t >= this.deadline && this.due()); // the page's turn took the rest of the frame
    return 0;
  }

  /** The core asks for its next step and the game time owed covers it. */
  due() {
    const period = this.period();
    return !!this.step && (period === 0 || this.acc >= period - Math.min(2, period * 0.12));
  }

  /** Runs the steps that are due until `until` (ms; the first one always runs). Returns how many ran. */
  run(start, until) {
    const period = this.period();
    let n = 0;
    let out = false; // this display frame's share is used up
    while (this.due()) {
      const s = this.now();
      if (n > 0 && s > until) {
        out = !this.deadline || s >= this.deadline;
        break;
      }
      const step = this.step;
      this.step = null;
      if (this.lastFrame) this.maxGap = Math.max(this.maxGap, s - this.lastFrame);
      this.lastFrame = s;
      step();
      this.acc -= period;
      this.frames++;
      n++;
    }
    const end = this.now();
    this.busy += end - start;
    if (!out && this.pending(end)) return n; // full power: the next slice carries on with what is owed
    this.settle(out);
    return n;
  }

  /** The display frame's work is done. `out`: time ran out with frames still owed. */
  settle(out) {
    const period = this.period();
    if (out) {
      // this computer can't do more right now: forget the rest instead of catching up in a burst later
      this.budgetHits++;
      this.acc = Math.min(this.acc, period);
    }
    this.acc = period === 0 ? 0 : Math.max(-period, Math.min(this.acc, 2 * period));
    this.deadline = 0;
  }
}
