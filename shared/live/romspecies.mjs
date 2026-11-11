// Which Pokémon a GBA game's species numbers stand for – read from the ROM's own species-name table, so a ROM hack
// that put other Pokémon into the slots (Light Platinum: Venipede where Weedle was, Turtwig in the unused slots
// 252–276) is shown as what the game shows, not as the vanilla Pokémon of that number. Gen 1/2 and the DS games keep
// the National Dex numbers in their structs (hacks of them add no new numbers we could misread); Gen 3 stores an
// internal index, which only the vanilla table (shared/data/gen3_index_to_dex.json) knew so far.
//
// Expanded engines (Complete FireRed Upgrade – Unbound, Radical Red –, pokeemerald-expansion and builds like Run & Bun)
// carry 900–1500 species in a table of their own order. They are reported as `engine: 'expanded'` (mapped by name):
// their RAM layout isn't the vanilla one either, so the live reader finds the party by searching for it and the map
// through SaveBlock1 (shared/live/parse.mjs, location.mjs, web/views/play.mjs) – or says the hack isn't supported.

import { listNdsFiles, ndsFile, parseNarc } from '../nds.mjs';

/** Gen 3 text → string (null when a byte isn't a character of the table). */
function decode(rom, o, n, table) {
  let s = '';
  for (let k = 0; k < n; k++) {
    const c = rom[o + k];
    if (c === 0xff) return s;
    const ch = table[c.toString(16).toUpperCase().padStart(2, '0')];
    if (ch === undefined || ch.length !== 1) return null;
    s += ch;
  }
  return s;
}

// a species name: letters first, then letters, digits and the few signs names use ("Mr. Mime", "Ho-Oh", "Nidoran♀",
// "Type: Null"; Complete FireRed Upgrade's Unown forms "Unown !" / "UNOWN?")
const NAME = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'’\-♂♀:!?]*$/;
// (the unused slots 252–276 of the retail games are named "?")
const okName = (s) => s !== null && s.length >= 1 && s.length <= 12 && (/^\?+$/.test(s) || (s.length >= 2 && NAME.test(s) && s.trim() === s && !/\s{2}/.test(s)));

/**
 * The species-name table of a GBA Pokémon ROM: entry 0 is "??????????" (ten '?' and the terminator), then one name per
 * species, `stride` bytes each (11 in the retail games). → { offset, stride, names } or null.
 * Complete FireRed Upgrade hacks start their own, longer table with a shorter row of '?' (Unbound "??????", Radical Red
 * a single "?") and leave the retail one in the ROM (Radical Red even renamed its Pokémon there): of all tables found,
 * the one with the most names is the game's.
 */
export function gen3SpeciesNames(rom, charset) {
  const table = charset?.table || charset || {};
  const q = Object.entries(table).find(([, v]) => v === '?')?.[0];
  if (!q) return null;
  const Q = parseInt(q, 16);
  let best = null;
  for (let o = 0; o + 0x40 < rom.length; o++) {
    if (rom[o] !== Q) continue;
    let k = 1;
    while (k < 10 && rom[o + k] === Q) k++;
    if (rom[o + k] !== 0xff) {
      o += k - 1;
      continue;
    }
    let found = null;
    for (const stride of [11, 12, 13]) {
      const names = [];
      for (let i = 1; o + (i + 1) * stride <= rom.length; i++) {
        const s = decode(rom, o + i * stride, stride, table);
        if (!okName(s)) break;
        names.push(s);
      }
      if (names.length >= 380 && (!found || names.length > found.names.length - 1)) found = { offset: o, stride, names: ['', ...names] };
    }
    // (the gSpeciesInfo layout starts with the retail "??????????" only)
    if (!found && k === 10) found = speciesInfoNames(rom, o, table);
    if (found && (!best || found.names.length > best.names.length)) best = found;
    // (past a table found: its "?" placeholder slots would start shorter copies of it)
    o = found ? found.offset + found.names.length * found.stride - 1 : o + k - 1;
  }
  return best;
}

/**
 * Newer pokeemerald-expansion builds (Too Many Types 2) have no name table: each species' name is a 13-byte field of
 * its entry in gSpeciesInfo, a struct of a few hundred bytes (0x104 in Too Many Types 2). The entry of "??????????"
 * (SPECIES_NONE) starts the field, the stride is where Bulbasaur's name follows. Species the build left out are
 * zeroed – an empty name (no Pokémon) – and the table ends at the first entry that is neither, or where a second
 * array of the same struct starts again with the first species. → { offset, stride, names } or null.
 */
function speciesInfoNames(rom, o, table) {
  const field = (p) => {
    if (p + 13 > rom.length) return null;
    let blank = true;
    for (let k = 0; k < 13; k++) if (rom[p + k] !== 0) blank = false;
    if (blank) return '';
    const s = decode(rom, p, 13, table);
    return okName(s) && !/^\?+$/.test(s) ? s : null;
  };
  for (let stride = 14; stride <= 0x400; stride++) {
    if (!field(o + stride) || !field(o + 2 * stride) || !field(o + 3 * stride)) continue;
    const names = [''];
    let blanks = 0;
    for (let i = 1; ; i++) {
      const s = field(o + i * stride);
      if (s === null) break;
      if (i > 2 && s && s === names[1] && field(o + (i + 1) * stride) === names[2]) break; // a second array
      blanks = s ? 0 : blanks + 1;
      if (blanks > 16) break;
      names.push(s);
    }
    while (names.length > 1 && !names[names.length - 1]) names.pop();
    if (names.length > 380) return { offset: o, stride, names };
  }
  return null;
}

/** Name → comparable key: "Farfetch’d" = "FARFETCH'D" = "FARFETCHD", "Nidoran♀" = "NIDORANF". */
export const nameKey = (s) => String(s || '').toUpperCase().replace(/♀/g, 'F').replace(/♂/g, 'M').normalize('NFD').replace(/[^A-Z0-9]/g, '');

/**
 * internal index → National Dex number for a Gen 3 ROM. `names` = gen3SpeciesNames().names, `vanilla` = the retail
 * index table (gen3_index_to_dex.json map), `dexNames` = English species names by National Dex number, `otherNames` =
 * the same lists in the other languages the games came out in (German, French, Spanish, Italian: a German ROM calls
 * Charmander "GLUMANDA"). A slot whose name is the vanilla Pokémon's – in any of these languages – keeps the vanilla
 * number; any other name is looked up by name (English first); a name no Pokémon has (a fakémon) is listed in
 * `unknown`, never mapped to a real one. → { map, unknown, changed }
 */
export function gen3SpeciesMap(names, vanilla, dexNames, otherNames = []) {
  const byKey = new Map();
  for (const list of [dexNames, ...otherNames]) {
    (list || []).forEach((n, id) => {
      if (n && id && !byKey.has(nameKey(n))) byKey.set(nameKey(n), id);
    });
  }
  const isVanilla = (v, key) => [dexNames, ...otherNames].some((list) => list?.[v] && nameKey(list[v]) === key);
  // A name that fills the game's 10 letters may be a shortened longer one (Run & Bun: "Corvknight", "Flechinder",
  // "Crabminabl"): the one longer Pokémon name that has its letters in that order and starts the same is it.
  const longer = [...byKey.entries()].filter(([k]) => k.length > 10);
  const inOrder = (short, long) => {
    let j = 0;
    for (let k = 0; k < long.length && j < short.length; k++) if (long[k] === short[j]) j++;
    return j === short.length;
  };
  const abbreviated = (key) => {
    if (key.length < 10) return 0;
    // (one Pokémon, in whichever language: Radical Red's "Poltegeist" fits the English and the French name alike)
    const hits = new Set(longer.filter(([k]) => k[0] === key[0] && k.length > key.length && inOrder(key, k)).map(([, id]) => id));
    return hits.size === 1 ? [...hits][0] : 0;
  };
  // Complete FireRed Upgrade names Unown's forms ("Unown B", Radical Red "UNOWNB"): they are Unown
  const unown = byKey.get('UNOWN');
  const form = (key) => (unown && /^UNOWN[A-Z]$/.test(key) ? unown : 0);
  const map = [0];
  const unknown = {};
  let changed = 0;
  for (let i = 1; i < names.length; i++) {
    const v = vanilla[i] || 0;
    const key = nameKey(names[i]);
    if (v && isVanilla(v, key)) {
      map[i] = v;
      continue;
    }
    // "?" placeholder slots (252–276 in the retail games) are no Pokémon
    if (!key) {
      map[i] = 0;
      continue;
    }
    const id = byKey.get(key) || abbreviated(key) || form(key) || 0;
    map[i] = id;
    if (!id) unknown[i] = names[i];
    if (id !== v) changed++;
  }
  return { map, unknown, changed };
}

/**
 * Species data of a ROM for the live reader: Gen 3 only (see the top). `opts` = { gen3Charset, gen3Index (the
 * vanilla map), dexNames, dexNamesOther (gen3SpeciesMap otherNames) }. → { gen: 3, engine: 'vanilla' | 'expanded', count, changed, map?, unknown?, source } or
 * null (not a GBA Pokémon ROM, or no species table found). `map` is left out when nothing differs from vanilla.
 * Never throws.
 */
export function romSpecies(rom, opts = {}) {
  try {
    if (!rom || rom.length < 0x200 || rom[0xb2] !== 0x96 || rom[3] !== 0xea) return null;
    const t = gen3SpeciesNames(rom, opts.gen3Charset);
    if (!t) return null;
    // the retail games have 412 entries (411 species + "??????????"); an engine with hundreds more is an expanded one
    const engine = t.names.length > 450 || t.stride !== 11 ? 'expanded' : 'vanilla';
    const source = { names: t.offset, stride: t.stride };
    // an expanded engine numbers its species its own way (Run & Bun: National Dex order, forms after them) – mapped by
    // name alone; a form ("Zigzagoon" from Galar) is its species
    const m = gen3SpeciesMap(t.names, engine === 'expanded' ? [] : opts.gen3Index || [], opts.dexNames || [], opts.dexNamesOther || []);
    const out = { gen: 3, engine, count: t.names.length - 1, changed: m.changed, source };
    if (m.changed) Object.assign(out, { map: m.map, unknown: m.unknown });
    return out;
  } catch {
    return null;
  }
}

/**
 * The highest National Dex number a GBA ROM's species table holds (romSpecies() result): a hack with Pokémon of later
 * generations – Light Platinum's Gen 4/5 ones, Run & Bun's 1000+ – lets the player pick them by hand, not only the base
 * game's 386. null when the ROM keeps the retail species (nothing to add) or nothing is known.
 */
export function speciesCeiling(species) {
  if (!species?.map?.length) return null;
  let max = 0;
  for (const id of species.map) if (id > max) max = id;
  return max || null;
}

// ---------------------------------------------------------------- items and moves of an expanded engine

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const codeOf = (table, ch) => {
  const k = Object.entries(table).find(([, v]) => v === ch)?.[0];
  return k === undefined ? -1 : parseInt(k, 16);
};
/** Gen 3 text with its terminator within `n` bytes, else null. */
const terminated = (rom, o, n, table) => {
  const s = decode(rom, o, n, table);
  return s !== null && rom.subarray(o, o + n).includes(0xff) ? s : null;
};

/**
 * The item table of a GBA Pokémon ROM (gItems: 44 bytes per item, its name in the first 14, its own number at +14):
 * entry 0 "????????" numbered 0, Master Ball 1, Ultra Ball 2 … An expanded engine numbers its items its own way – Complete
 * FireRed Upgrade hacks keep the retail struct in a longer table of their own (Unbound 729 entries, Radical Red 750; the
 * retail table stays in the ROM) and Unbound names a few items through a pointer in place of the text ("Wishing Piece",
 * "Deep Sea Tooth"). The table ends at the first entry of 0xFF bytes. → { offset, names } (names[item]: the game's
 * name, '' for an entry without one, null where nothing could be read) or null; of the tables found the longest.
 */
export function gen3ItemNames(rom, charset) {
  try {
    const table = charset?.table || charset || {};
    const Q = codeOf(table, '?');
    if (Q < 0) return null;
    const nameAt = (o) => {
      if (rom[o] === 0xff) return '';
      const p = u32(rom, o);
      if (rom[o + 3] >= 0x08 && rom[o + 3] <= 0x09 && p - 0x08000000 < rom.length) {
        const s = terminated(rom, p - 0x08000000, 24, table);
        if (s) return s;
      }
      return terminated(rom, o, 14, table);
    };
    let best = null;
    for (let o = 0; o + 44 * 8 <= rom.length; o += 4) {
      if (rom[o] !== Q || rom[o + 8] !== 0xff || u16(rom, o + 14) !== 0) continue;
      let k = 1;
      while (k < 8 && rom[o + k] === Q) k++;
      if (k < 8) continue;
      if (![1, 2, 3, 4].every((i) => u16(rom, o + i * 44 + 14) === i && nameAt(o + i * 44))) continue;
      const names = [''];
      let bad = 0;
      for (let i = 1; i < 4096 && o + (i + 1) * 44 <= rom.length; i++) {
        const e = o + i * 44;
        if (rom.subarray(e, e + 16).every((b) => b === 0xff)) break;
        const s = nameAt(e);
        bad = s === null ? bad + 1 : 0;
        if (bad > 8) break;
        names.push(s);
      }
      while (names.length > 1 && names[names.length - 1] === null) names.pop();
      if (!best || names.length > best.names.length) best = { offset: o, names };
      o += 44 * names.length - 4;
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * The move-name table of a GBA Pokémon ROM: entry 0 "-", then one name per move, `stride` bytes each (13 in the retail
 * games; Radical Red keeps a second one of 17 for long names). `firsts` = the names of move 1 (Pound) in the languages
 * the games came out in. → { offset, stride, names } or null; of the tables found the one with the most names.
 */
export function gen3MoveNames(rom, charset, firsts = ['Pound']) {
  try {
    const table = charset?.table || charset || {};
    const dash = codeOf(table, '-');
    if (dash < 0) return null;
    const keys = new Set(firsts.map(nameKey));
    let best = null;
    for (let o = 0; o + 64 < rom.length; o++) {
      if (rom[o] !== dash || rom[o + 1] !== 0xff) continue;
      for (let stride = 13; stride <= 20; stride++) {
        const first = terminated(rom, o + stride, stride, table);
        if (!first || !keys.has(nameKey(first))) continue;
        const names = [''];
        for (let i = 1; o + (i + 1) * stride <= rom.length; i++) {
          const s = terminated(rom, o + i * stride, stride, table);
          if (!s) break;
          names.push(s);
        }
        if (names.length > 354 && (!best || names.length > best.names.length)) best = { offset: o, stride, names };
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** Levenshtein distance of two short strings. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A ROM's move numbers → the National move numbers the app's move data uses (`lists` = the move names by number, English
 * first, then the other languages). Complete FireRed Upgrade keeps the retail 354 moves in their places but sorts the
 * later ones its own way (Unbound #355 is Leech Fang, the National #355 Roost); pokeemerald-expansion keeps the National
 * order. Moves 1–354 keep their number while the name is the retail one or a renamed spelling of it ("Hi Jump Kick",
 * "Faint Attack", "SmellingSalt"); any other move is looked up by name – also a shortened one ("Psystrike" fits, a
 * 12-letter field) – and a move the app doesn't know, or a hack's own one, maps to 0 (left out). Names are compared in
 * the ROM's language alone, the list that fits most of the retail moves: in German "Spotlight" is Follow Me and "Finale"
 * Self-Destruct, while an English hack's Spotlight and Finale are other moves.
 * → { map, changed, moved } (map[rom move] = National number or 0; `moved` = the known moves at another number).
 */
export function gen3MoveMap(names, lists = []) {
  const fit = (list) => {
    let n = 0;
    for (let i = 1; i <= 354 && i < names.length; i++) if (list?.[i] && nameKey(list[i]) === nameKey(names[i])) n++;
    return n;
  };
  const own = (lists || []).reduce((a, l) => (fit(l) > fit(a) ? l : a), lists?.[0] || []);
  lists = [own];
  const byKey = new Map();
  for (const list of lists) {
    (list || []).forEach((n, id) => {
      if (n && id && !byKey.has(nameKey(n))) byKey.set(nameKey(n), id);
    });
  }
  const longer = [...byKey.entries()];
  const inOrder = (short, long) => {
    let j = 0;
    for (let k = 0; k < long.length && j < short.length; k++) if (long[k] === short[j]) j++;
    return j === short.length;
  };
  const lookup = (key) => {
    if (byKey.has(key)) return byKey.get(key);
    if (key.length < 9) return 0;
    const hits = new Set(longer.filter(([k]) => k[0] === key[0] && k.length > key.length && inOrder(key, k)).map(([, id]) => id));
    return hits.size === 1 ? [...hits][0] : 0;
  };
  const near = (key, id) => (lists || []).some((list) => {
    const k = nameKey(list?.[id]);
    return !!k && k[0] === key[0] && (k === key || inOrder(key, k) || distance(key, k) <= 2);
  });
  const map = [0];
  let changed = 0;
  let moved = 0;
  for (let i = 1; i < names.length; i++) {
    const key = nameKey(names[i]);
    const id = !key ? 0 : i <= 354 && near(key, i) ? i : lookup(key);
    map[i] = id;
    if (id !== i) changed++;
    if (id && id !== i) moved++;
  }
  return { map, changed, moved };
}

// ---------------------------------------------------------------- types from the ROM

/**
 * The type names of a GBA Pokémon ROM (gTypeNames, in pokeemerald-expansion the names in gTypesInfo): "Normal" /
 * "NORMAL", then "Fight…" one entry on, as many entries as are names. The retail games have 18 (with "???"),
 * pokeemerald-expansion adds Fairy and Stellar; a hack with types of its own has more – Too Many Types 58 entries,
 * Too Many Types 2 81. → { count, names } or null (no table found). Never throws.
 */
export function gen3TypeNames(rom, charset) {
  try {
    const table = charset?.table || charset || {};
    const code = {};
    for (const [k, v] of Object.entries(table)) if (v.length === 1 && !(v in code)) code[v] = parseInt(k, 16);
    const enc = (w) => [...w].map((c) => code[c]);
    const starts = [enc('Normal'), enc('NORMAL')].filter((b) => b.every((x) => x !== undefined));
    const TYPE = /^[A-Za-z?][A-Za-z0-9?'’ -]*$/;
    const nameAt = (o, n) => {
      const v = decode(rom, o, n, table);
      return v && v.length <= 12 && TYPE.test(v.trim()) ? v.trim() : null;
    };
    for (let o = 0; o + 64 < rom.length; o++) {
      const b = starts.find((w) => w.every((x, k) => rom[o + k] === x) && rom[o + w.length] === 0xff);
      if (!b) continue;
      for (let stride = 7; stride <= 48; stride++) {
        if (!/^fight/i.test(nameAt(o + stride, Math.min(stride, 13)) || '')) continue;
        const names = [];
        for (let i = 0; i < 255; i++) {
          const v = nameAt(o + i * stride, Math.min(stride, 13));
          if (!v) break;
          names.push(v);
        }
        if (names.length >= 17) return { count: names.length, names };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** More type names than the retail games and pokeemerald-expansion have (18 + Fairy + Stellar): types of its own. */
export const OWN_TYPES_ABOVE = 24; // retail 18, pokeemerald-expansion 20: a hack with a type or two more keeps its types

// type ids of the games' own tables (pokeemerald include/constants/pokemon.h, pokeplatinum, pokeblack):
// Gen 3/4 have '???' (9) in the middle – Fairy hacks of Gen 4 (Renegade Platinum) reuse it; Gen 5 has none and Fairy
// hacks (Blaze Black 2 Redux) add it as 17.
const TYPES34 = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', '???', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
const TYPES5 = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark', 'fairy'];

/** Gen 3 base stats table (28 bytes per species, types at +6/+7): found by Bulbasaur's entry, which hacks keep. */
function gen3BaseTypes(rom, count) {
  const sig = [45, 49, 49, 45, 65, 65, 12, 3];
  for (let o = 28; o + 28 * (count + 1) <= rom.length; o += 4) {
    if (rom[o] !== 45 || !sig.every((v, i) => rom[o + i] === v)) continue;
    const start = o - 28;
    if (rom.subarray(start, start + 28).some((b) => b)) continue; // entry 0 ("??????????") is all zeroes
    const out = [];
    let ok = 0;
    for (let i = 1; i <= count; i++) {
      const a = rom[start + i * 28 + 6];
      const b = rom[start + i * 28 + 7];
      out[i] = a < 18 && b < 18 ? [a, b] : null;
      if (out[i]) ok++;
    }
    if (ok >= count * 0.95) return out;
  }
  return null;
}

/** DS personal data (one file per species, types at +6/+7) → { [species]: [id, id] }. */
function dsBaseTypes(rom, path, count) {
  const narc = ndsFileSafe(rom, path);
  if (!narc) return null;
  const files = parseNarcSafe(narc);
  if (!files || files.length < count) return null;
  const out = [];
  for (let i = 1; i <= count; i++) out[i] = files[i]?.length > 8 ? [files[i][6], files[i][7]] : null;
  return out;
}

const ndsFileSafe = (rom, path) => {
  try {
    return ndsFile(rom, path, listNdsFiles(rom));
  } catch {
    return null;
  }
};
const parseNarcSafe = (b) => {
  try {
    return parseNarc(b);
  } catch {
    return null;
  }
};

/**
 * The types a ROM gives its Pokémon where they differ from the retail games' (`baseTypes(id, gen)` = the app's own
 * data): hacks that add Fairy (Renegade Platinum: in the '???' slot, Blaze Black 2 Redux: as type 17) or retype
 * Pokémon, and the types of a Gen 3 hack's own Pokémon. → { gen, fairy, types: { [species]: ['grass', 'fairy'] } } or
 * null (no table found, a system without one). `species` is the National Dex number the live reader reports (Gen 3:
 * through `speciesMap` = romSpecies().map, its fakémon as FAKEMON + index). Never throws.
 */
export function romTypes(rom, { baseTypes, speciesMap = null, vanillaIndex = [], fakemon = 20000 } = {}) {
  try {
    if (!rom || rom.length < 0x200 || typeof baseTypes !== 'function') return null;
    let gen;
    let raw;
    let names;
    if (rom[0xb2] === 0x96 && rom[3] === 0xea) {
      gen = 3;
      names = TYPES34;
      const t = gen3BaseTypes(rom, 411);
      if (!t) return null;
      // internal index → National Dex (the ROM's own map for a hack with other Pokémon, else the retail one)
      raw = [];
      for (let i = 1; i < t.length; i++) {
        const id = speciesMap ? speciesMap.map?.[i] || (speciesMap.unknown?.[i] ? fakemon + i : 0) : vanillaIndex[i] || 0;
        if (id && t[i] && !raw[id]) raw[id] = t[i];
      }
    } else {
      const code = String.fromCharCode(...rom.subarray(0x0c, 0x10)).slice(0, 3);
      const gen5 = /^IR[ABDE]$/.test(code);
      gen = gen5 ? 5 : 4;
      names = gen5 ? TYPES5 : TYPES34;
      const files = listNdsFiles(rom);
      const path = gen5 ? 'a/0/1/6' : /^IP[KG]$/.test(code) ? 'a/0/0/2' : files.find((f) => /^poketool\/personal(_\w+)?\/(pl_)?personal\.narc$/.test(f.path))?.path;
      raw = path ? dsBaseTypes(rom, path, gen5 ? 649 : 493) : null;
      if (!raw) return null;
    }
    // Fairy: a Gen 4 '???' that a Pokémon really has (no retail Pokémon of #1–493 is '???'), Gen 5 type 17
    const fairyId = gen === 5 ? 17 : 9;
    const fairy = raw.some((t) => t && (t[0] === fairyId || t[1] === fairyId));
    const nameOf = (id) => (id === fairyId && fairy ? 'fairy' : names[id] || null);
    const types = {};
    raw.forEach((t, id) => {
      if (!t) return;
      const mine = [...new Set(t.map(nameOf))].filter((x) => x && x !== '???');
      const base = id >= fakemon ? [] : baseTypes(id, gen) || [];
      if (mine.length && mine.join('/') !== base.join('/')) types[id] = mine;
    });
    return { gen, fairy, types };
  } catch {
    return null;
  }
}
