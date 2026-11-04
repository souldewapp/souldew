// Who plays a run: 1–4 player slots (p1..pN) and the run mode. Shared by the server (builds, summaries)
// and the browser (web/lib/run.mjs re-exports it), so both read a manifest the same way.

export const ALL_SLOTS = ['p1', 'p2', 'p3', 'p4'];
export const MODES = ['soullink', 'nuzlocke'];

/** 'soullink' (2–4 players) or 'nuzlocke' (solo). Runs from before modes existed are SoulLinks. */
export function runMode(manifest) {
  return manifest?.mode === 'nuzlocke' ? 'nuzlocke' : 'soullink';
}

/** A solo Nuzlocke (one player, no partner) rather than a SoulLink. */
export const isNuzlocke = (manifest) => runMode(manifest) === 'nuzlocke';

/**
 * The run's slots in order. Players are contiguous (p1..pN); a SoulLink has at least two – older manifests
 * (and packs) always had p1+p2, and a missing p2 there still means "the partner who hasn't joined yet".
 */
export function slotsOf(manifest) {
  if (runMode(manifest) === 'nuzlocke') return ['p1'];
  const players = manifest?.players && typeof manifest.players === 'object' ? manifest.players : {};
  const slots = [];
  for (const s of ALL_SLOTS) {
    if (!players[s]) break;
    slots.push(s);
  }
  return slots.length >= 2 ? slots : ['p1', 'p2'];
}

/** A new run's name when none is given: "Lou & Noa", "Lou, Noa & Robin" – or "Lou – Nuzlocke" solo. */
export function defaultRunName(players, mode) {
  const names = ALL_SLOTS.filter((s) => players?.[s]).map((s) => players[s].name || s.toUpperCase());
  if (mode === 'nuzlocke') return `${names[0]} – Nuzlocke`;
  return names.length > 2 ? `${names.slice(0, -1).join(', ')} & ${names.at(-1)}` : names.join(' & ');
}

/** The other players of the run (empty in a solo Nuzlocke). */
export function othersOf(slot, manifest) {
  return slotsOf(manifest).filter((s) => s !== slot);
}
