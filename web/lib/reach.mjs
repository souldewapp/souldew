// What fast-forward really reaches in a game on this computer, and which turbo steps are worth offering.
//
// The built-in emulator runs a game on one CPU core, and some games cost more per frame than a fast-forward step
// leaves. HeartGold in town takes ~10 ms per emulated frame with DeSmuME on an M1 – measured with every lever there
// is: frame skipping (0 or 9 of 10 frames not drawn – the same; the emulated CPUs take the time, not the drawing), the
// 3D settings (edge marking, line/texture hacks, resolution, texture scaling, colour depth), the single- and the
// multi-threaded build and the older "DeSmuME 2015" all land between 9.7 and 10.8 ms, and melonDS (slower than DeSmuME
// in the 2D menus anyway) can't load HeartGold's saves ("A communication error has occurred"). So 2×, 3× and 4× all end at ~1.6× there. The play view measures what each
// fast-forward window reaches, remembers it per game and core, and offers only the steps this computer gets to: the
// ones it reaches, then the highest one as "as fast as this computer manages, up to 4×" – instead of 2× → 3× → 4×
// that all play at the same 1.6×.
//
// Plain logic without DOM types: test/reach.test.mjs.

/** Measuring windows remembered per game (play.mjs measures one every 1.3 s while fast-forwarding). */
export const KEEP = 40;
/** A window that reached this share of its step held it (play.mjs shows "≈" below it). */
export const HELD = 0.92;
/** Windows needed before a game's reach counts – a few seconds of fast-forward. */
export const MIN_SAMPLES = 6;
// a step counts as reachable up to this far above the typical reach (the measurement wobbles by a few percent)
const MARGIN = 1.08;

const valid = (x) => Array.isArray(x) && Number.isFinite(x[0]) && x[0] >= 0 && Number.isFinite(x[1]) && x[1] > 0;

/**
 * Adds one measuring window – fast-forward step `set` (Infinity: "Max"), `reached` × measured – to the list remembered
 * for a game and returns the new list (at most KEEP windows; "Max" is stored as 0, JSON has no Infinity).
 */
export function addSample(list, set, reached) {
  const prev = Array.isArray(list) ? list.filter(valid) : [];
  if (!(set > 1) || !(reached > 0) || !Number.isFinite(reached)) return prev;
  return [...prev, [Number.isFinite(set) ? set : 0, Math.round(reached * 100) / 100]].slice(-KEEP);
}

/**
 * The speed this computer typically reaches in the game when fast-forward is held back by it (the median of the
 * windows that fell short of their step, to 0.1×), or null: too few windows yet, or most of them held their step –
 * then nothing is held back and every step stays on offer.
 */
export function typicalReach(list, min = MIN_SAMPLES) {
  const all = Array.isArray(list) ? list.filter(valid) : [];
  if (all.length < min) return null;
  // "Max" (0) never holds a step – what it reaches is what the computer can
  const short = all.filter(([s, r]) => s === 0 || r < s * HELD).map(([, r]) => r).sort((a, b) => a - b);
  if (short.length * 2 < all.length) return null;
  const mid = short.length >> 1;
  const median = short.length % 2 ? short[mid] : (short[mid - 1] + short[mid]) / 2;
  return Math.round(median * 10) / 10;
}

/**
 * The turbo steps to offer (`steps`: 1, 2, 3, 4 and maybe Infinity for "Max") when this computer typically reaches
 * `reach`× in the game: 1×, the steps it reaches, and the highest finite step – which then runs as fast as the
 * computer manages, up to that step, so lighter scenes still get it. "Max" stays when it was chosen in Settings.
 */
export function offeredSteps(steps, reach) {
  if (!(reach > 0)) return steps;
  const top = Math.max(...steps.filter(Number.isFinite));
  return steps.filter((s) => !Number.isFinite(s) || s <= 1 || s === top || s <= reach * MARGIN);
}

/** Whether step `s` is more than the computer typically reaches in the game (its label then says so). */
export const beyondReach = (s, reach) => reach > 0 && s > 1 && s > reach * MARGIN;
