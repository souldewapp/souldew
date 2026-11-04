// "Start over": the build request for a fresh run with the same game, hack, randomizer options,
// seed mode, rules, mode and players as an old one – only the seeds are new. Pure, so it is testable;
// web/lib/restart.mjs gathers the inputs and sends it to POST /api/runs/build.
import { randomSeed } from './randomizer-options.mjs';
import { slotsOf, runMode, defaultRunName } from './slots.mjs';

/** "Lou & Noa" → "Lou & Noa #2" if that name is taken ("… #2" counts up from its base name). */
export function numberedName(base, runs) {
  const esc = base.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '(?: #(\\d+))?$');
  const taken = (runs || []).map((r) => r.name?.match(re)).filter(Boolean).map((m) => Number(m[1]) || 1);
  return taken.length ? `${base} #${Math.max(...taken) + 1}` : base;
}

/** The old run's base name without a "#n" suffix. */
export const baseName = (name) => String(name || '').replace(/\s+#\d+$/, '').trim();

/**
 * Body for POST /api/runs/build that restarts `old` (a full run manifest).
 * library: { roms, patches } from /api/library · runs: existing runs (for the "#n" name) ·
 * rules: the old run's current rules (doc `rules`; falls back to manifest.rules) ·
 * mySlot: which player of the old run is on this computer – slots (all 1–4 of them) stay as they were.
 * Throws (with .code) if the game or patch isn't in the library anymore.
 */
export function restartRequest(old, { library, runs, rules, mySlot = 'p1', gameTitle, seed = randomSeed } = {}) {
  const roms = library?.roms || [];
  const patches = library?.patches || [];
  const crc = String(old.base?.crc || '').toUpperCase();
  const fits = roms.filter((r) => String(r.crc || '').toUpperCase() === crc);
  const rom = fits.find((r) => old.game?.id && r.gameId === old.game.id) || fits[0];
  if (!rom) throw Object.assign(new Error('The game of this run is not in your library anymore'), { code: 'no-rom' });
  let patch = null;
  if (old.patch) {
    patch = patches.find((p) => old.patch.sha1 && p.sha1 === old.patch.sha1)
      || patches.find((p) => old.patch.hackId && p.hackId === old.patch.hackId && (!p.expectedCrc || p.expectedCrc === rom.crc) && (!old.patch.sha1 || !p.sha1));
    if (!patch) throw Object.assign(new Error('The ROM hack of this run is not in your library anymore'), { code: 'no-patch' });
  }
  const randomizer = old.randomizer || {};
  const shared = !!randomizer.sharedSeed;
  const mode = runMode(old);
  const slots = slotsOf(old);
  const s1 = seed();
  const seeds = Object.fromEntries(slots.map((s, i) => [s, shared || i === 0 ? s1 : seed()]));
  const players = Object.fromEntries(slots.map((s) => [s, { name: old.players?.[s]?.name || s.toUpperCase() }]));
  const built = Object.keys(old.outputs || {}).filter((s) => slots.includes(s));
  const hackId = old.game?.hackId || old.patch?.hackId || null;
  return {
    romId: rom.id,
    patchId: patch?.id || null,
    values: randomizer.values || {},
    randomize: randomizer.enabled !== false,
    mode,
    seeds,
    sharedSeed: shared,
    players,
    // the slots this computer built before (normally all), at least my own
    buildFor: [...new Set([...built, slots.includes(mySlot) ? mySlot : slots[0]])].sort(),
    gameId: old.game?.id || null,
    gameTitle: gameTitle || old.patch?.name || old.game?.title || null,
    hackId,
    name: numberedName(baseName(old.name) || defaultRunName(players, mode), runs),
    rules: rules ?? old.rules ?? null,
  };
}
