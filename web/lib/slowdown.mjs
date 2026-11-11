// "This computer can't run the game at full speed" – noticed and explained in the play view (issue #4).
//
// The built-in emulator runs the whole console on one CPU core in WebAssembly, without the just-in-time compiler the
// standalone emulators use. Pokémon Platinum on Route 201 takes 13.3–13.7 ms per frame with melonDS on an M1 (of the
// 16.7 ms a frame may take at 60 fps; multi-threaded or not, the same). A player's Windows PC needed ~30 ms there: the
// game ran at half speed (≈31 fps) and the sound crackled because only half of it was made – while the standalone
// melonDS ran fine. Nothing in the app can make the core itself fast enough on such a computer, so the play view
// watches for a lasting slowdown at normal speed and tells the player what helps.
//
// Plain logic without DOM types: test/slowdown.test.mjs.

/** A measuring window counts as slow below this share of full speed (51 of 60 frames a second). */
export const SLOW_SHARE = 0.85;
/** Slow windows in a row before the notice (play.mjs measures every 2 s: ~10 s of slowdown). */
export const SLOW_WINDOWS = 5;

export class SlowWatch {
  /**
   * @param {object} [o]
   * @param {number} [o.fps] full speed in frames a second
   * @param {number} [o.share] SLOW_SHARE
   * @param {number} [o.need] SLOW_WINDOWS
   */
  constructor({ fps = 60, share = SLOW_SHARE, need = SLOW_WINDOWS } = {}) {
    Object.assign(this, { fps, share, need });
    this.fired = false;
    this.reset();
  }

  /** Forget the current streak (paused, fast-forward, hidden, a setting changed that may help). */
  reset() {
    this.streak = 0;
    this.sum = 0;
  }

  /**
   * One measuring window at normal speed: `fps` frames a second. Returns true once – the first time the slowdown has
   * lasted `need` windows in a row.
   */
  add(fps) {
    if (!Number.isFinite(fps) || fps < 0) return false;
    if (fps >= this.fps * this.share) {
      this.reset();
      return false;
    }
    this.streak++;
    this.sum += fps;
    if (this.streak < this.need || this.fired) return false;
    this.fired = true;
    return true;
  }

  /** The share of full speed reached during the current streak (0.52 = half speed), or null. */
  reached() {
    return this.streak ? Math.round((this.sum / this.streak / this.fps) * 100) / 100 : null;
  }
}

/**
 * What helps, best first, for a game that runs too slowly in the built-in emulator:
 * - 'external' – a DS game: the standalone melonDS (souldew installs it and syncs the run on every in-game save) has
 *                a just-in-time compiler and runs DS games at full speed on computers where the built-in one can't
 * - 'graphics' – Windows and Linux: another graphics backend (Settings › General) – it helped players whose emulator
 *                stuttered with one of them
 * - 'power'    – always: plugged in / a performance power plan, other programs closed
 * Switching the DS core is no tip: DeSmuME needs as long per frame there as melonDS (Platinum, Route 201, M1:
 * 11.5–12.5 ms against 11.7–14.4 ms, with frame skipping 11.0–12.7 ms – not the factor of two such a PC lacks).
 * `system`: 'nds' | 'gba' | …, `backends`: the graphics backends this platform offers (shared/gpu.mjs gpuBackends).
 */
export function slowTips({ system, backends = [] }) {
  const tips = [];
  if (system === 'nds') tips.push('external');
  if (backends.length > 1) tips.push('graphics');
  tips.push('power');
  return tips;
}
