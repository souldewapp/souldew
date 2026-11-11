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

// a species name: letters first, then letters, digits and the few signs names use ("Mr. Mime", "Ho-Oh", "Nidoran♀")
const NAME = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 .'’\-♂♀:]*$/;
// (the unused slots 252–276 of the retail games are named "?")
const okName = (s) => s !== null && s.length >= 1 && s.length <= 12 && (/^\?+$/.test(s) || (s.length >= 2 && NAME.test(s) && s.trim() === s && !/\s{2}/.test(s)));

/**
 * The species-name table of a GBA Pokémon ROM: entry 0 is "??????????" (ten '?' and the terminator), then one name per
 * species, `stride` bytes each (11 in the retail games). → { offset, stride, names } or null.
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
    if (k < 10 || rom[o + 10] !== 0xff) continue;
    for (const stride of [11, 12, 13]) {
      const names = [];
      for (let i = 1; o + (i + 1) * stride <= rom.length; i++) {
        const s = decode(rom, o + i * stride, stride, table);
        if (!okName(s)) break;
        names.push(s);
      }
      if (names.length >= 380 && (!best || names.length > best.names.length)) best = { offset: o, stride, names: ['', ...names] };
    }
    if (!best) best = speciesInfoNames(rom, o, table);
    if (best) break;
    o += 10;
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
    const hits = longer.filter(([k]) => k[0] === key[0] && k.length > key.length && inOrder(key, k));
    return hits.length === 1 ? hits[0][1] : 0;
  };
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
    const id = byKey.get(key) || abbreviated(key) || 0;
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
export const OWN_TYPES_ABOVE = 20;

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
