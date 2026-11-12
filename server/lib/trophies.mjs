// Trophies on disk: the Pokédex, achievements and medals across every run of this computer.
// trophies.json in the data folder keeps a digest per run (so a deleted run's catches stay in the Pokédex), the
// species seen in live battles, the live moments (1 HP, underleveled badges …), which slot this computer plays per
// run and when each achievement was unlocked. The rules themselves are pure: shared/trophies.mjs.
import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_DIR, DEV, SHARED_DIR } from './paths.mjs';
import { writeFileAtomic } from './fsutil.mjs';
import { listRuns, runDir } from './build.mjs';
import { catalog } from './library.mjs';
import { PROGRESSION } from '../../shared/routes.mjs';
import { slotsOf } from '../../shared/slots.mjs';
import { digestRun, buildDex, dexTotals, context, evaluate, medals, migrate, cleanMoment, momentKey, MAX_MOMENTS, MAX_SPECIES, SCHEMA } from '../../shared/trophies.mjs';

export const TROPHY_PATH = join(DATA_DIR, DEV ? 'runs/trophies.json' : 'trophies.json');

let pokeapi = null;
let gen4 = null;
function data() {
  if (!pokeapi) {
    try {
      pokeapi = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'pokeapi.json'), 'utf8'));
    } catch {
      pokeapi = {};
    }
    try {
      gen4 = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'gen4.json'), 'utf8'));
    } catch {
      gen4 = {};
    }
  }
  return { pokeapi, gen4 };
}

const typesOf = (id) => data().pokeapi.types?.[id] || [];
/** Is `nick` just the species' own name in any language the data knows? null when that can't be told. */
function isDefaultName(id, nick) {
  const names = data().pokeapi.names;
  if (!names || !nick || !id) return null;
  const norm = (x) => String(x).normalize('NFC').toUpperCase().replace(/\s+/g, '');
  return Object.values(names).some((byId) => byId?.[id] && norm(byId[id]) === norm(nick));
}
/** Curated route names (HeartGold/SoulSilver): the game's own place name, like the board shows it. */
function curatedAreaName(key) {
  const a = PROGRESSION.find((x) => x.key === key);
  if (!a) return '';
  const met = a.met?.[0];
  return (met !== undefined && data().gen4.locations?.[met]) || a.name || '';
}

function load() {
  try {
    return migrate(JSON.parse(readFileSync(TROPHY_PATH, 'utf8')));
  } catch {
    return null;
  }
}
function save(state) {
  mkdirSync(dirname(TROPHY_PATH), { recursive: true });
  writeFileAtomic(TROPHY_PATH, JSON.stringify(state));
}

/** Which slot this computer plays in a run when the page never said: the only game built here, else host = p1. */
function guessSlot(m) {
  const slots = slotsOf(m);
  const built = Object.keys(m.outputs || {}).filter((s) => slots.includes(s));
  if (built.length === 1) return built[0];
  return m.imported && slots.length > 1 ? 'p2' : 'p1';
}

// Bump when digestRun (shared/trophies.mjs) or the generation lookup here reads a run differently: every run is
// digested again (2: a hack's base game's generation, evolutions once per step, the partner's deaths, bonus deaths).
const DIGEST_VERSION = 2;

/** The generation of a run's game – or a hack's base game (a hack run's game id can be the hack's). */
function genOf(m, games) {
  const hackIds = [m.game?.hackId, m.patch?.hackId].filter(Boolean);
  const hack = (catalog().hacks || []).find((h) => hackIds.includes(h.id) || h.id === m.game?.id);
  const game = [m.game?.id, m.base?.gameId, hack?.baseGameId].filter(Boolean).map((id) => games.find((g) => g.id === id)).find(Boolean);
  return game?.generation || null;
}

/** Re-read the runs whose doc changed since the last digest (by size + mtime + slot + digest version). */
function refreshRuns(state) {
  const games = catalog().games || [];
  const present = new Set();
  for (const m of listRuns()) {
    present.add(m.id);
    const slot = slotsOf(m).includes(state.slots[m.id]) ? state.slots[m.id] : guessSlot(m);
    let sig = `v${DIGEST_VERSION}:none:${slot}`;
    const p = join(runDir(m.id), 'doc.json');
    try {
      const st = statSync(p);
      sig = `v${DIGEST_VERSION}:${st.size}:${Math.round(st.mtimeMs)}:${slot}:${m.updatedAt || ''}:${m.name || ''}`;
    } catch {
      // no doc yet – a fresh run still counts as started
    }
    const prev = state.runs[m.id];
    if (prev?.sig === sig && prev.digest && !prev.archived) continue;
    let entries = {};
    try {
      if (existsSync(p)) entries = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // a damaged doc: keep what was known of it
      if (prev?.digest) continue;
    }
    // its generation from the game, not guessed from the system (a DS hack of Black 2 is Gen 5, a 3DS game has its own)
    state.runs[m.id] = { sig, digest: digestRun(m, entries, slot, { areaName: curatedAreaName, gen: genOf(m, games) }) };
  }
  // a deleted run stays in the trophies (its catches really happened); it is only marked – its doc is gone, so an older
  // digest only gets its generation from its game id again (a DS hack of Gen 5 was counted as Gen 4)
  for (const [id, r] of Object.entries(state.runs)) {
    if (present.has(id)) continue;
    const gen = r.digest?.gameId ? genOf({ game: { id: r.digest.gameId } }, games) : null;
    const digest = gen && r.digest.gen !== gen ? { ...r.digest, gen } : r.digest;
    if (!r.archived || digest !== r.digest) state.runs[id] = { ...r, digest, archived: true };
  }
}

/**
 * Bring the trophies up to date: the page's slot choices, newly seen species and live moments go in, every changed
 * run is digested again, and achievements that are now reached get their unlock time. Returns the full picture plus
 * `fresh` (ids unlocked by this call – the page shows a toast for each). The very first call back-fills from the
 * runs already there: those unlocks come back as `backfilled` (one quiet summary instead of a toast storm).
 */
export function syncTrophies({ slots = {}, seen = [], moments = [] } = {}) {
  const loaded = load();
  const first = !loaded;
  const state = loaded || migrate({ schema: SCHEMA, createdAt: Date.now() });
  const before = first ? '' : JSON.stringify(state);
  for (const [id, s] of Object.entries(slots && typeof slots === 'object' ? slots : {})) {
    if (/^[a-f0-9]{8}$/.test(id) && /^p[1-4]$/.test(s)) state.slots[id] = s;
  }
  const now = Date.now();
  for (const id of Array.isArray(seen) ? seen.slice(0, 200) : []) {
    const n = Number(id);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_SPECIES && !state.seen[n]) state.seen[n] = now;
  }
  const keys = new Set(state.moments.map(momentKey));
  for (const raw of Array.isArray(moments) ? moments.slice(0, 50) : []) {
    const m = cleanMoment(raw);
    if (m && !keys.has(momentKey(m))) {
      keys.add(momentKey(m));
      state.moments.push(m);
    }
  }
  state.moments = state.moments.slice(-MAX_MOMENTS);
  refreshRuns(state);

  const digests = Object.values(state.runs).map((r) => r.digest).filter(Boolean);
  const dex = buildDex(digests, state.seen);
  const totals = dexTotals(dex);
  const states = evaluate(context(digests, state.moments, { dex, typesOf, isDefaultName }));
  const fresh = [];
  for (const s of states) {
    if (!s.ok || state.unlocked[s.id]) continue;
    // back-filled ones keep the time the data tells (or now); live ones are unlocked now
    state.unlocked[s.id] = { at: first ? s.at || now : now };
    fresh.push(s.id);
  }
  if (first) state.backfilledAt = now;
  if (JSON.stringify(state) !== before) save(state); // nothing new (a sync while nothing happened): no write

  const achievements = states.map((s) => ({ ...s, ...(state.unlocked[s.id] ? { ok: true, at: state.unlocked[s.id].at, n: s.target } : {}) }));
  return {
    schema: state.schema,
    achievements,
    medals: medals(achievements, totals),
    dex,
    totals,
    runs: Object.entries(state.runs).map(([id, r]) => ({ id, name: r.digest?.name || id, mode: r.digest?.mode, gen: r.digest?.gen, archived: !!r.archived })),
    fresh: first ? [] : fresh,
    backfilled: first ? fresh : [],
  };
}
