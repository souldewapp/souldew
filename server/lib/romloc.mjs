// What the play view needs from the ROM itself, computed here from the file instead of in the page (a DS ROM is
// 64–512 MB, and the page already holds one copy for the emulator): the "where am I" sign's place names and map →
// location step (shared/live/romloc.mjs), for GBA games which Pokémon the species numbers stand for
// (shared/live/romspecies.mjs) and for Game Boy hacks where their RAM variables moved (shared/live/romwram.mjs), its
// types and level caps (romtypes.mjs, romcaps.mjs). Computed in a worker thread (romdata-worker.mjs, romDataFor) – the
// result is small and cached per file (path, size, time) in CACHE_DIR/romloc.
// `vanilla` says whether the file is an unmodified retail ROM (its CRC32 is in the catalog): a randomized game, a
// ROM hack or anything else changed shows the ROM's own place names (shared/live/location.mjs placeName).
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import zlib from 'node:zlib';
import { romLocations, gen3MapTable } from '../../shared/live/romloc.mjs';
import { romSpecies, gen3ItemNames, gen3MoveNames, gen3MoveMap } from '../../shared/live/romspecies.mjs';
import { romTypes } from '../../shared/live/romtypes.mjs';
import { romCaps } from '../../shared/live/romcaps.mjs';
import { gbWramShift } from '../../shared/live/romwram.mjs';
import { findEntry } from '../../shared/live/parse.mjs';
import { identifyRom } from '../../shared/romid.mjs';
import { crc32 } from '../../shared/checksum.mjs';
import { resolveId } from './library.mjs';

const VERSION = 13; // bump when romData() changes what it finds or the shape of its result (13: types and level caps from the ROM)
const memo = new Map();
let tables = null;

function opts(sharedDir) {
  if (!tables) {
    const j = (f) => JSON.parse(readFileSync(join(sharedDir, 'data', f), 'utf8'));
    const retail = new Set();
    for (const g of j('catalog.json').games || []) for (const c of g.crc32 || []) retail.add(String(c).toUpperCase());
    const gen3Index = [];
    for (const [k, v] of Object.entries(j('gen3_index_to_dex.json').map || {})) gen3Index[Number(k)] = v;
    const api = j('pokeapi.json');
    // the app's own types of a Pokémon in a generation (web/lib/data.mjs baseTypes)
    const baseTypes = (id, gen) => {
      const past = api.typesGen?.[id];
      const k = past ? Object.keys(past).map(Number).sort((a, b) => a - b).find((x) => x >= gen) : undefined;
      return k !== undefined ? past[k] : api.types?.[id] || [];
    };
    tables = { gen3Charset: j('charset_gen3.json'), gen4Chars: j('gen4.json').chars, retail, gen3Index, dexNames: api.names?.en || [], dexNamesOther: ['de', 'fr', 'es', 'it'].map((l) => api.names?.[l]).filter(Boolean), addresses: j('addresses.json'), maps: j('maps.json'), baseTypes, moveNames: ['en', 'de', 'fr', 'es', 'it'].map((l) => api.moves?.[l]).filter(Boolean) };
  }
  return tables;
}

/** CRC32 of a ROM as hex (zlib's native one where Node has it – a DS ROM is up to 512 MB). */
export function romCrc(bytes) {
  const v = typeof zlib.crc32 === 'function' ? zlib.crc32(bytes) : crc32(bytes);
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** All results for a ROM's bytes: { data (locations or null), species, wram, types, caps, capsWhy, items, moves, vanilla }. */
export function romData(u8, sharedDir) {
  const o = opts(sharedDir);
  let vanilla = false;
  try {
    vanilla = o.retail.has(romCrc(u8));
  } catch {
    // no checksum: treated as modified
  }
  const data = romLocations(u8, o);
  if (data) data.vanilla = vanilla;
  const species = romSpecies(u8, o);
  // an expanded GBA engine moved gMapHeader: the place comes from SaveBlock1's map and the ROM's map table instead
  if (data && species?.engine === 'expanded') data.maps3 = gen3MapTable(u8);
  // an expanded engine numbers its items and moves its own way (Complete FireRed Upgrade: Unbound, Radical Red): the
  // game's item names (held items by name) and its moves in the app's numbering (the battle helper's moves)
  const own = species?.engine === 'expanded' ? ownTables3(u8, o) : { items: null, moves: null };
  // the game's types – names, each Pokémon's, the chart, the moves' (shared/live/romtypes.mjs): any ROM, so a hack that
  // changed them shows what it uses; a retail ROM reads as the app's own data
  const types = romTypes(u8, { gen3Charset: o.gen3Charset, speciesMap: species?.map ? species : null, vanillaIndex: o.gen3Index, baseTypes: o.baseTypes, moveMap: own.moves?.map || null });
  // level caps from the game's trainers (shared/live/romcaps.mjs) – only a clean result; `capsWhy` says why not
  const c = romCaps(u8, { gen3Charset: o.gen3Charset, gen4Chars: o.gen4Chars });
  const caps = c.caps ? { caps: c.caps, leaders: c.leaders, final: c.final, badgeFlags: c.badgeFlags ?? null } : null;
  // the header (system, game code, title): which memory table entry reads it (shared/live/features.mjs)
  const h = identifyRom(u8.subarray(0, 0x200));
  const header = h?.system ? { system: h.system, code: h.code || '', title: h.title || '' } : null;
  return { data, species, wram: vanilla ? null : gbShift(u8, o), types, caps, capsWhy: caps ? null : c.why || null, ...own, header, vanilla };
}

/**
 * An expanded GBA engine's item names ({ names }) and move numbers ({ map }) – the map only for an engine that sorts its
 * moves its own way (Complete FireRed Upgrade: hundreds of known moves elsewhere); pokeemerald-expansion keeps the
 * National order and its moves stay as they are.
 */
function ownTables3(u8, o) {
  const items = gen3ItemNames(u8, o.gen3Charset);
  const mn = gen3MoveNames(u8, o.gen3Charset, o.moveNames.map((l) => l[1]).filter(Boolean));
  const m = mn ? gen3MoveMap(mn.names, o.moveNames) : null;
  return { items: items ? { names: items.names } : null, moves: m && m.moved >= 10 ? { map: m.map } : null };
}

/** Game Boy hacks: where the code says the party, the battle and the map variables are (shared/live/romwram.mjs). */
function gbShift(u8, o) {
  const h = identifyRom(u8.subarray(0, 0x200));
  if (!h || (h.system !== 'gb' && h.system !== 'gbc')) return null;
  const entry = findEntry(o.addresses, { platform: h.system, code: h.code, title: h.title });
  return entry ? gbWramShift(u8, entry, o.maps.games?.[entry.id]) : null;
}

/**
 * The ROM's data by file path or (an unpacked archive entry) by its bytes plus a key: { data, species, wram, vanilla }
 * – `data` the location data (null when the ROM has none: another engine, an unsupported layout), `species` the GBA
 * species table (null for other systems), `wram` a Game Boy hack's moved variables (null: the retail addresses),
 * `types` the game's types (shared/live/romtypes.mjs), `caps` level caps from its trainers (shared/live/romcaps.mjs).
 */
/** What romDataFor finds when there's nothing to find – also the list of fields the disk cache must give back. */
export const ROMDATA_NONE = Object.freeze({ data: null, species: null, wram: null, types: null, caps: null, capsWhy: null, items: null, moves: null, header: null, vanilla: null });
/** A disk-cache entry back into romDataFor's result (every field of ROMDATA_NONE – a missing one would be lost on the
 * next start, as the own types of Too Many Types were). */
export const fromRomCache = (v) => Object.fromEntries(Object.keys(ROMDATA_NONE).map((k) => [k, v[k] ?? null]));

// ---- computed in a worker thread (server/lib/romdata-worker.mjs): a big ROM takes seconds – the server, which shares
// its thread with the app in Electron, keeps answering every other request meanwhile. One ROM at a time; a scan that
// fails or takes too long gives "unknown" (ROMDATA_NONE) – not remembered, so the next request tries again.
const TIMEOUT_MS = Number(process.env.SLS_ROMDATA_TIMEOUT_MS) || 180000;
let worker = null;
let seq = 0;
const jobs = new Map(); // job id → { w (its worker), resolve, reject, timer }
const pending = new Map(); // ROM id → its promise (two requests for one ROM share a scan)
let chain = Promise.resolve();

/** The jobs of worker `w` fail (it ended): a newer worker's jobs go on. */
function failAll(w, err) {
  for (const [id, j] of jobs) {
    if (j.w !== w) continue;
    clearTimeout(j.timer);
    jobs.delete(id);
    j.reject(err);
  }
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(new URL('./romdata-worker.mjs', import.meta.url));
  w.on('message', ({ id, result, error }) => {
    const j = jobs.get(id);
    if (!j) return;
    jobs.delete(id);
    clearTimeout(j.timer);
    if (error) j.reject(new Error(error));
    else j.resolve(result);
  });
  const gone = (err) => {
    if (worker === w) worker = null;
    failAll(w, err);
  };
  w.on('error', gone);
  w.on('exit', (code) => gone(new Error(`ROM data worker ended (${code})`)));
  w.unref(); // (after the listeners: an idle worker never keeps the app or a test from ending)
  return (worker = w);
}

/** One job in the worker, after the ones before it; rejects on an error or after `timeoutMs` (the worker is ended). */
function runJob(msg, timeoutMs) {
  const run = () => new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    const timer = setTimeout(() => {
      jobs.delete(id);
      reject(new Error('ROM data took too long'));
      if (worker === w) worker = null;
      w.terminate().catch(() => {});
    }, timeoutMs);
    jobs.set(id, { w, resolve, reject, timer });
    w.postMessage({ ...msg, id }, msg.bytes ? [msg.bytes] : []);
  });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/**
 * The ROM's data (see romData) for `src` – { file } (a path), { lib: { id, config } } (a library entry, maybe inside a
 * .zip: read in the worker) or { bytes, key } – with the memory and disk cache in front (CACHE_DIR/romloc, per file:
 * path, size, time). Resolves to ROMDATA_NONE's shape, never rejects; `env.timeoutMs` overrides the time limit.
 */
export async function romDataFor(src, { sharedDir, cacheDir, timeoutMs = TIMEOUT_MS }) {
  const none = { ...ROMDATA_NONE };
  let id;
  let msg;
  try {
    if (src.file) {
      const st = statSync(src.file);
      id = `${src.file}|${st.size}|${st.mtimeMs}`;
      msg = { file: src.file };
    } else if (src.lib) {
      const { abs, entry } = resolveId(src.lib.id, src.lib.config);
      const st = statSync(abs);
      id = `${abs}::${entry || ''}|${st.size}|${st.mtimeMs}`;
      msg = { lib: { id: src.lib.id, config: src.lib.config } };
    } else if (src.bytes) {
      id = `bytes|${src.key}|${src.bytes.length}`;
      const copy = new Uint8Array(src.bytes); // (handed over to the worker)
      msg = { bytes: copy.buffer };
    } else return none;
  } catch {
    return none;
  }
  if (memo.has(id)) return memo.get(id);
  const hash = createHash('sha1').update(`${VERSION}|${id}`).digest('hex');
  const cached = cacheDir && join(cacheDir, 'romloc', `${hash}.json`);
  if (cached && existsSync(cached)) {
    try {
      const v = JSON.parse(readFileSync(cached, 'utf8'));
      if (v.version === VERSION) {
        const r = fromRomCache(v);
        memo.set(id, r);
        return r;
      }
    } catch {
      // unreadable cache: compute again
    }
  }
  if (pending.has(id)) return pending.get(id);
  const p = runJob({ ...msg, sharedDir }, timeoutMs).then((result) => {
    const r = fromRomCache(result || {});
    memo.set(id, r);
    if (cached) {
      try {
        mkdirSync(join(cacheDir, 'romloc'), { recursive: true });
        writeFileSync(cached, JSON.stringify({ version: VERSION, ...r }));
      } catch {
        // a read-only cache folder only costs the next start a second parse
      }
    }
    return r;
  }, () => none).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}
