// What the play view needs from the ROM itself, computed here from the file instead of in the page (a DS ROM is
// 64–512 MB, and the page already holds one copy for the emulator): the "where am I" sign's place names and map →
// location step (shared/live/romloc.mjs), for GBA games which Pokémon the species numbers stand for
// (shared/live/romspecies.mjs) and for Game Boy hacks where their RAM variables moved (shared/live/romwram.mjs). Both are small and cached per file (path, size, time) in CACHE_DIR/romloc.
// `vanilla` says whether the file is an unmodified retail ROM (its CRC32 is in the catalog): a randomized game, a
// ROM hack or anything else changed shows the ROM's own place names (shared/live/location.mjs placeName).
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { romLocations, gen3MapTable } from '../../shared/live/romloc.mjs';
import { romSpecies, romTypes } from '../../shared/live/romspecies.mjs';
import { gbWramShift } from '../../shared/live/romwram.mjs';
import { findEntry } from '../../shared/live/parse.mjs';
import { identifyRom } from '../../shared/romid.mjs';
import { crc32 } from '../../shared/checksum.mjs';

const VERSION = 7; // bump when romLocations() / romSpecies() change what they find
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
    tables = { gen3Charset: j('charset_gen3.json'), gen4Chars: j('gen4.json').chars, retail, gen3Index, dexNames: api.names?.en || [], addresses: j('addresses.json'), maps: j('maps.json'), baseTypes };
  }
  return tables;
}

/** CRC32 of a ROM as hex (zlib's native one where Node has it – a DS ROM is up to 512 MB). */
export function romCrc(bytes) {
  const v = typeof zlib.crc32 === 'function' ? zlib.crc32(bytes) : crc32(bytes);
  return (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** All results for a ROM's bytes: { data (locations or null), species (or null), wram (or null), vanilla }. */
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
  // a modified ROM's own types where they differ from the app's (Fairy hacks, retyped or new Pokémon)
  const types = vanilla || species?.engine === 'expanded' ? null : romTypes(u8, { baseTypes: o.baseTypes, speciesMap: species?.map ? species : null, vanillaIndex: o.gen3Index });
  return { data, species, wram: vanilla ? null : gbShift(u8, o), types: types && (types.fairy || Object.keys(types.types).length) ? types : null, vanilla };
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
 * `types` a modified ROM's own Pokémon types where they differ from the app's (shared/live/romspecies.mjs romTypes).
 * Never throws.
 */
export function romDataFor({ file = null, bytes = null, key = null }, { sharedDir, cacheDir }) {
  const none = { data: null, species: null, wram: null, types: null, vanilla: null };
  let id;
  try {
    if (file) {
      const st = statSync(file);
      id = `${file}|${st.size}|${st.mtimeMs}`;
    } else id = `bytes|${key}|${bytes?.length}`;
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
        const r = { data: v.data, species: v.species, wram: v.wram ?? null, types: v.types ?? null, vanilla: v.vanilla };
        memo.set(id, r);
        return r;
      }
    } catch {
      // unreadable cache: compute again
    }
  }
  let r = none;
  try {
    const rom = bytes || readFileSync(file);
    r = romData(new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength), sharedDir);
  } catch {
    r = none;
  }
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
}

/** Location data alone (romDataFor().data). */
export const romLocationsFor = (src, env) => romDataFor(src, env).data;
