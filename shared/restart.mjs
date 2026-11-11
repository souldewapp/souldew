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

// ---- several players pressing "New attempt" ------------------------------------------------------------------
// When a run ends, every player gets the "run is over" notice with a "New attempt" button. Each new run has its own
// room and secret (server/lib/build.mjs), so two players who both build one never meet again – the sync looks
// broken. The old run's document carries `run:restart` (key and its final shape { id, name, by, at, pack } are what
// 2.3.0 reads – keep them): before building, the one who restarts writes a claim { by, at, building, claim } there,
// and everyone else waits for that invite instead of building their own. Clicks at the same moment: the document's
// last-writer-wins merge picks the same claim on every computer, the others step back (and set their build aside).
// 2.3.0 ignores a claim (no id / pack) and keeps reading the final entry as before.

/** The old run's document key that announces its new attempt. */
export const RESTART_KEY = 'run:restart';
/** A claim nobody finished within this time (app closed or crashed mid-build) no longer blocks the others. */
export const CLAIM_TTL = 10 * 60000;
/** After claiming, wait this long before building: a claim made at the same moment elsewhere arrives meanwhile. */
export const CLAIM_SETTLE = 1500;

const isEntry = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const newClaim = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

/**
 * What "New attempt" should do in a run whose document holds `entry` (its `run:restart` value), for player `me`:
 *   { action: 'build' }                    nobody else restarted it – build the new run
 *   { action: 'join', offer }              another player's new run is ready – join it (offer = their entry)
 *   { action: 'open', id, name, by }       already joined that new run on this computer – open it
 *   { action: 'wait', by, byName, at }     another player is building it right now – their invite comes soon
 * runs: the runs on this computer ({ id }) · now: for the claim's age.
 */
export function restartPlan(entry, { me, runs = [], now = Date.now() } = {}) {
  if (!isEntry(entry)) return { action: 'build' };
  const built = typeof entry.id === 'string' && entry.id && isEntry(entry.pack);
  // our own finished new attempt: open it again rather than building yet another one (unless it was deleted here)
  if (entry.by === me) return built && (runs || []).some((r) => r?.id === entry.id) ? { action: 'open', id: entry.id, name: entry.name || '', by: entry.by } : { action: 'build' };
  if (built) {
    return (runs || []).some((r) => r?.id === entry.id) ? { action: 'open', id: entry.id, name: entry.name || '', by: entry.by } : { action: 'join', offer: entry };
  }
  const at = Number(entry.at);
  if (entry.building && Number.isFinite(at) && now - at < CLAIM_TTL) return { action: 'wait', by: entry.by, byName: entry.byName || null, at };
  return { action: 'build' };
}

/**
 * "New attempt" for a SoulLink with several players – claim, build, announce:
 *   doc      the old run's live document (null: not open / solo – then nothing is claimed or announced)
 *   entry    its saved `run:restart` value when there is no live document
 *   me       this computer's slot in the old run · byName: its player name (for the others' "X is building …")
 *   runs     the runs on this computer
 *   build()  builds the new run → { manifest, pack, … } (web/lib/restart.mjs restartRun)
 *   discard(id)  removes a new run that lost a race against another player's
 *   settle / wait(ms)  see CLAIM_SETTLE (tests pass shorter times)
 * → { started: <build result> } – or { plan } (restartPlan: join / open / wait) when another player's new attempt
 *   is the one to play; `discarded` names our own build that was set aside for it.
 */
export async function newAttempt({ doc = null, entry = null, me, byName = null, runs = [], build, discard = async () => {}, settle = CLAIM_SETTLE, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const read = () => (doc ? doc.get(RESTART_KEY) : entry) ?? null;
  const first = restartPlan(read(), { me, runs });
  if (first.action !== 'build') return { plan: first };
  if (!doc) return { started: await build() };
  const prev = read();
  const claim = newClaim();
  // another player's entry now wins over our claim → what to do instead (null: ours still stands)
  const lostTo = () => {
    const cur = read();
    if (!isEntry(cur) || cur.claim === claim) return null;
    const p = restartPlan(cur, { me, runs });
    return p.action === 'build' ? null : p;
  };
  doc.set(RESTART_KEY, { by: me, ...(byName ? { byName } : {}), at: Date.now(), building: true, claim });
  if (settle > 0) await wait(settle);
  const early = lostTo();
  if (early) return { plan: early };
  let res;
  try {
    res = await build();
  } catch (e) {
    // the build failed: our claim must not keep the others waiting (an earlier invite of ours stays)
    if (isEntry(read()) && read().claim === claim) doc.set(RESTART_KEY, isEntry(prev) && prev.id && prev.pack ? prev : null);
    throw e;
  }
  const late = lostTo();
  if (late) {
    await Promise.resolve(discard(res.manifest?.id)).catch(() => {});
    return { plan: late, discarded: res.manifest?.id || null };
  }
  doc.set(RESTART_KEY, { id: res.manifest.id, name: res.manifest.name, by: me, ...(byName ? { byName } : {}), at: Date.now(), pack: res.pack, claim });
  return { started: res };
}
