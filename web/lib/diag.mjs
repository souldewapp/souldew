// Diagnostics: a small in-memory log of what the live tracker and the turbo mixer decided, so a player can save
// it (Help › "Save diagnostics") and send it along with a bug report. Nothing leaves the computer on its own, and
// no ROM, save or invite data goes in – only readings like species, levels, song keys and the mixer's choices.

const MAX = 4000; // entries kept per kind
const logs = new Map();
const t0 = Date.now();

/** Records one entry of `kind` ('battle', 'music', …). Cheap enough to call on every poll. */
export function diag(kind, data) {
  let l = logs.get(kind);
  if (!l) logs.set(kind, (l = []));
  l.push({ t: Date.now() - t0, ...data });
  if (l.length > MAX) l.splice(0, l.length - MAX);
}

/** Everything recorded so far, oldest first per kind, plus `extra` (app version, game …). */
export function diagDump(extra = {}) {
  return { format: 'souldew/diagnostics@1', startedAt: new Date(t0).toISOString(), savedAt: new Date().toISOString(), ...extra, logs: Object.fromEntries(logs) };
}
