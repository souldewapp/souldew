// Location data read from the game ROM itself, so the "where am I" sign works without hand-made tables – for
// randomized games, other languages and ROM hacks that keep the engine's formats (their own maps and place names
// included). What stays built in is knowledge per engine, not per game:
//   Gen 3  the region map's section table (x, y, width, height, name pointer – Ruby/Sapphire/Emerald) or the
//          name pointer table (FireRed/LeafGreen); the section id itself is read live from gMapHeader in RAM.
//   Gen 4  the map header table in the ARM9 binary (24 bytes per map, location name index at +0x12) and the game's
//          location-name text file (encrypted msg format). The current map id is read live from the save data
//          (shared/live/location.mjs finds it through the NitroSDK module params, like the party reader).
//   Gen 5  the zone headers (a/0/1/2, 48 bytes per zone, name index at +0x1A) and the location-name text file of
//          a/0/0/2 (#89 Black/White, #109 Black 2/White 2) – checked against the US/EU ROMs of all four games: the
//          names equal PKHeX's Gen 5 met locations. All four also hand over the zone headers themselves
//          (`zoneHeaders`, hex): the game keeps a copy of the current zone's header in RAM, and that copy is how the
//          live reader finds the zone in every language.
// The location name index is the same number the game stores as a catch's met location, so a place read this way
// pairs with catches exactly like the table-based one (shared/live/location.mjs). Tables are found by their
// structure (signature scans), not by fixed offsets; anything that doesn't validate gives null, never a guess.
import { ndsHeader, listNdsFiles, parseNarc, ndsArm9, ndsFile } from '../nds.mjs';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Language of a game code's last letter (E/O English, D German, …); null when unknown. */
export function langOfCode(code) {
  return { E: 'en', O: 'en', P: 'en', D: 'de', F: 'fr', I: 'it', S: 'es', H: 'nl', J: 'ja', K: 'ko' }[String(code || '').slice(3, 4).toUpperCase()] || null;
}

/**
 * "ROUTE 101" → "Route 101", "MT. PYRE" → "Mt. Pyre", "S.S. TIDAL" → "S.S. Tidal"; a capitals name with a lower-case
 * letter or two is one too ("POKéMON-HAUS" → "Pokémon-Haus", German "DIGDAs HÖHLE" → "Digdas Höhle"). Mixed-case names
 * stay as they are.
 */
export function prettyName(s) {
  if (!s) return s;
  const lower = (s.match(/[a-zß-ÿ]/g) || []).length;
  const upper = (s.match(/[A-ZÀ-Þ]/g) || []).length;
  if (lower * 3 >= upper) return s;
  return s.toLowerCase().replace(/(^|[\s.\-(])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
}

// ---------------------------------------------------------------- Gen 1/2 (Game Boy)

// The Game Boy games keep a copy of the current map's header in WRAM, and that copy is how the live reader tells where
// the player is in every language (shared/live/location.mjs readGen1/readGen2): the header's bytes are the ROM's own,
// wherever another language keeps its variables. Here: the ROM's headers, found by their structure.
const gbPtr = (p) => p >= 0x4000 && p < 0x8000;
const gbAt = (bank, ptr) => bank * 0x4000 + (ptr - 0x4000);
const gbHex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Gen 1 (Red/Blue/Yellow): the map headers by map id – pokered MapHeaderPointers (dw per map, home bank; Yellow: bank
 * 0x3F) and MapHeaderBanks (db per map). A header starts with the 10 bytes LoadMapHeader copies to wCurMapHeader
 * (home/overworld.asm): tileset, height, width, blocks, text and script pointers, connection flags. The two tables are
 * found by the first nine maps (the towns Pallet … Fuchsia: tileset 0, OVERWORLD, in every game and language) and
 * kept when nearly every entry is a header. `maps`: how many map ids the game has (NUM_MAPS – pokered 248, pokeyellow
 * 249: Summer Beach House). → { headers: [hex of the 10 bytes, or null], offset: { pointers, banks } } or null.
 * ~0.2 s for 1 MB; the work stays bounded for any bytes (a damaged or made-up ROM gives null, it never runs on).
 */
export function gen1MapHeaders(rom, maps = 248) {
  const N = maps;
  const banks = Math.min(rom.length >> 14, 256); // (a bank is one byte in MapHeaderBanks)
  const header = (o) => o >= 0 && o + 10 <= rom.length && rom[o] < 0x18 && rom[o + 1] >= 1 && rom[o + 1] <= 0x60 && rom[o + 2] >= 1 && rom[o + 2] <= 0x60 && gbPtr(u16(rom, o + 3)) && gbPtr(u16(rom, o + 5)) && gbPtr(u16(rom, o + 7)) && !(rom[o + 9] & 0xf0);
  // a header (a town's: tileset 0) in bank k behind pointer ptr
  const at = (k, ptr) => k >= 1 && k < banks && header(gbAt(k, ptr));
  const town = (k, ptr) => at(k, ptr) && rom[gbAt(k, ptr)] === 0;
  // whether any bank holds such a header behind a pointer – worked out once per pointer, so the search stays a pass or
  // two over the ROM whatever its bytes are (bit 0 known, bit 1 a header, bit 2 a town's)
  const behind = new Uint8Array(0x4000);
  const any = (ptr) => {
    const i = ptr - 0x4000;
    if (!behind[i]) {
      behind[i] = 1;
      for (let k = 1; k < banks && behind[i] !== 7; k++) if (at(k, ptr)) behind[i] |= rom[gbAt(k, ptr)] === 0 ? 6 : 2;
    }
    return behind[i];
  };
  const TOWNS = 9;
  const MIN = 200;
  // A game has one pair of tables – and the same tables a map or more in (Red: 17 pointer tables, 15 pairs). The bounds
  // keep bytes made to look like many of them from taking minutes (each pointer table costs a pass over the ROM): past
  // them, no tables – never a guess
  const MAX_STARTS = 4096;
  const MAX_TABLES = 64;
  const MAX_PAIRS = 256;
  const count = (p, b) => {
    let n = 0;
    for (let i = 0; i < N && p + i * 2 + 2 <= rom.length && b + i < rom.length; i++) {
      const k = rom[b + i];
      if (k && k < banks && gbPtr(u16(rom, p + i * 2)) && header(gbAt(k, u16(rom, p + i * 2)))) n++;
    }
    return n;
  };
  let best = null;
  let tie = false;
  let starts = 0;
  let tables = 0;
  let pairs = 0;
  for (let p = 0; p + N * 2 <= rom.length; p++) {
    let i = 0;
    while (i < TOWNS && gbPtr(u16(rom, p + i * 2)) && any(u16(rom, p + i * 2)) & 4) i++;
    if (i < TOWNS) continue;
    if (++starts > MAX_STARTS) return null;
    // nearly every pointer of the table leads to a header in some bank (before the pass over the ROM for the banks)
    let led = 0;
    for (let t = 0; t < N && led + N - t >= MIN; t++) if (gbPtr(u16(rom, p + t * 2)) && any(u16(rom, p + t * 2)) & 2) led++;
    if (led < MIN) continue;
    if (++tables > MAX_TABLES) return null;
    // the banks byte of each town must be one its pointer can be in (a pointer to the start of a bank fits many) –
    // looked up per byte value, so the pass is a few array reads per ROM byte
    const ok = new Uint8Array(TOWNS * 256);
    for (let j = 0; j < TOWNS; j++) for (let k = 1; k < 256; k++) ok[j * 256 + k] = town(k, u16(rom, p + j * 2)) ? 1 : 0;
    for (let b = 0; b + N <= rom.length; b++) {
      let j = 0;
      while (j < TOWNS && ok[j * 256 + rom[b + j]]) j++;
      if (j < TOWNS) continue;
      if (++pairs > MAX_PAIRS) return null;
      const n = count(p, b);
      // (the same tables a few maps in are a candidate too – with fewer headers: the start has the most)
      if (!best || n > best.n) [best, tie] = [{ p, b, n }, false];
      else if (n === best.n && best.p - p !== 2 * (best.b - b)) tie = true;
    }
  }
  if (!best || tie || best.n < MIN) return null;
  const headers = [];
  for (let i = 0; i < N; i++) {
    const k = rom[best.b + i];
    const o = gbAt(k, u16(rom, best.p + i * 2));
    headers.push(k && k < banks && gbPtr(u16(rom, best.p + i * 2)) && header(o) ? gbHex(rom.subarray(o, o + 10)) : null);
  }
  return { headers, offset: { pointers: best.p, banks: best.b } };
}

/**
 * Gen 2 (Gold/Silver/Crystal): every map's 17 bytes that the game copies to wMapPartial + wMapAttributes (pokecrystal
 * home/map.asm CopyMapPartial, CopyMapAttributes; wram.asm: the two follow each other) – the map's header in
 * MapGroupPointers' group (bank of the attributes, tileset, environment, attributes pointer) and its 12 bytes of
 * attributes (border block, height, width, blocks bank + pointer, scripts bank + pointer, events pointer,
 * connections). Found by the group table's structure: 20+ pointers in one bank, each to 9-byte map headers whose
 * attributes are valid. → { maps: { 'group.number' (1-based, as pret's constants): hex }, offset } or null.
 */
export function gen2MapHeaders(rom) {
  const banks = rom.length >> 14;
  const bankOk = (k) => k >= 1 && k < banks;
  const attrs = (o) => o + 12 <= rom.length && rom[o + 1] >= 1 && rom[o + 1] <= 0x60 && rom[o + 2] >= 1 && rom[o + 2] <= 0x60 && bankOk(rom[o + 3]) && gbPtr(u16(rom, o + 4)) && bankOk(rom[o + 6]) && gbPtr(u16(rom, o + 7)) && gbPtr(u16(rom, o + 9)) && !(rom[o + 11] & 0xf0);
  // environment 1–7: TOWN … DUNGEON (pokecrystal constants/map_data_constants.asm)
  const header = (o) => o + 9 <= rom.length && bankOk(rom[o]) && rom[o + 2] >= 1 && rom[o + 2] <= 7 && gbPtr(u16(rom, o + 3)) && attrs(gbAt(rom[o], u16(rom, o + 3)));
  const MIN = 20;
  for (let g = 0x4000; g + MIN * 2 <= rom.length; g++) {
    const bank = g >> 14;
    let n = 0;
    while (n < 64 && g + n * 2 + 2 <= (bank + 1) * 0x4000 && gbPtr(u16(rom, g + n * 2)) && header(gbAt(bank, u16(rom, g + n * 2)))) n++;
    if (n < MIN) continue;
    const ptrs = Array.from({ length: n }, (_, i) => u16(rom, g + i * 2));
    const maps = {};
    ptrs.forEach((p, gi) => {
      // a group's maps end where the next group's begin
      const next = ptrs.filter((x) => x > p).sort((a, b) => a - b)[0] ?? 0x8000;
      for (let m = 0; m < 128 && p + m * 9 < next; m++) {
        const o = gbAt(bank, p + m * 9);
        if (!header(o)) break;
        const a = gbAt(rom[o], u16(rom, o + 3));
        maps[`${gi + 1}.${m + 1}`] = gbHex(rom.subarray(o, o + 5)) + gbHex(rom.subarray(a, a + 12));
      }
    });
    return { maps, offset: g };
  }
  return null;
}

/**
 * The map headers of a Game Boy game for the live reader (gen1MapHeaders / gen2MapHeaders), checked against the map
 * table souldew has for its memory table entry (shared/data/maps.json `table`): Gen 2 must have exactly the maps of
 * that table – the same groups, the same number of maps in each – so a map's number means the same place; Gen 1's
 * table has all map ids (Red/Blue 248, Yellow 249 – the unused ones too, which have no header: Red US 226 headers). → { gen: 1, headers } /
 * { gen: 2, maps } or null (another layout: a hack with maps of its own, or a table not found – the reader then falls
 * back to the fixed addresses).
 */
export function gbMapHeaders(rom, gen, table) {
  try {
    if (!rom || !table) return null;
    const keys = Object.keys(table).filter((k) => !k.startsWith('_'));
    if (gen === 1) {
      const g = gen1MapHeaders(rom, keys.length);
      return g && g.headers.length === keys.length ? { gen: 1, headers: g.headers } : null;
    }
    if (gen === 2) {
      const g = gen2MapHeaders(rom);
      if (!g) return null;
      const found = Object.keys(g.maps);
      return found.length === keys.length && keys.every((k) => g.maps[k]) ? { gen: 2, maps: g.maps } : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Gen 3 (GBA)

// argument bytes of the 0xFC control codes (pokeemerald include/characters.h); the code byte itself not counted
const FC_ARGS = [1, 1, 1, 1, 3, 1, 1, 0, 1, 0, 0, 2, 1, 1, 1, 0, 2, 1, 1, 1, 1, 0, 0, 0, 0];

/**
 * A Gen 3 string at a ROM pointer, or null when it isn't one (not a ROM address, unknown byte, too long). An empty
 * string (just the terminator) is '' – Emerald's MAPSEC_DYNAMIC has one, in the middle of the table. `ph` = the team
 * names the game puts in for its placeholders ("{AQUA} HIDEOUT").
 */
function gen3String(rom, ptr, table, max = 40, ph = null) {
  if (ptr < 0x08000000 || ptr >= 0x08000000 + rom.length) return null;
  const o = ptr - 0x08000000;
  let s = '';
  for (let k = 0; k < max && o + k < rom.length; k++) {
    const c = rom[o + k];
    if (c === 0xff) return s.replace(/\s+/g, ' ').trim();
    if (c === 0xfc) {
      k += 1 + (FC_ARGS[rom[o + k + 1]] ?? 0); // formatting (colour, spacing): a space at most
      s += ' ';
      continue;
    }
    if (c === 0xfd) {
      // a placeholder: the team names are known per game (pokeemerald PLACEHOLDER_ID_AQUA 8 / _MAGMA 9), any other
      // one depends on the game state – left out
      s += ph?.[rom[o + k + 1]] || '';
      k += 1;
      continue;
    }
    if (c === 0xfe) {
      s += ' ';
      continue;
    }
    const ch = table[c.toString(16).toUpperCase().padStart(2, '0')];
    if (ch === undefined) return null;
    s += ch;
  }
  return null;
}

/** What the team placeholders say in a game: Ruby swaps them (its villains are Team Magma) – pokeruby src/strings. */
const gen3Teams = (code) => (String(code || '').startsWith('AXV') ? { 8: 'MAGMA', 9: 'AQUA' } : { 8: 'AQUA', 9: 'MAGMA' });

/** Longest run of `stride`-byte entries passing `ok(offset)`, over 4-byte aligned offsets: { start, len }. */
function longestRun(bytes, stride, ok, from = 0, to = bytes.length) {
  let best = { start: -1, len: 0 };
  for (let r = 0; r < stride; r += 4) {
    let run = 0;
    let start = 0;
    for (let o = from + r; o + stride <= to; o += stride) {
      if (ok(o)) {
        if (!run) start = o;
        run++;
        if (run > best.len) best = { start, len: run };
      } else run = 0;
    }
  }
  return best;
}

/** Every run of at least `min` `stride`-byte entries passing `ok(offset)`, over 4-byte aligned offsets: [{ start, len }]. */
function allRuns(bytes, stride, ok, min) {
  const out = [];
  for (let r = 0; r < stride; r += 4) {
    let run = 0;
    let start = 0;
    for (let o = r; o + stride <= bytes.length; o += stride) {
      if (ok(o)) {
        if (!run) start = o;
        run++;
      } else {
        if (run >= min) out.push({ start, len: run });
        run = 0;
      }
    }
    if (run >= min) out.push({ start, len: run });
  }
  return out;
}

/**
 * Gen 3 place names by region map section id (MAPSEC). Ruby/Sapphire/Emerald: struct RegionMapLocation
 * { u8 x, y, width, height; const u8 *name } – one per section, section 0 first. FireRed/LeafGreen: const u8 *name[]
 * for the Kanto sections, starting at section 0x58.
 */
export function gen3Names(rom, charset, code = String.fromCharCode(...rom.subarray(0xac, 0xb0))) {
  const table = charset?.table || charset || {};
  const teams = gen3Teams(code);
  // (the scans below decode the same pointers more than once – a 32 MB hack holds millions of them)
  const memo = new Map();
  const str = (p) => {
    if (p < 0x08000000 || p >= 0x08000000 + rom.length) return null;
    if (memo.has(p)) return memo.get(p);
    const v = gen3String(rom, p, table, 40, teams);
    memo.set(p, v);
    return v;
  };
  const struct = longestRun(rom, 8, (o) => rom[o] < 32 && rom[o + 1] < 32 && rom[o + 2] >= 1 && rom[o + 2] <= 16 && rom[o + 3] >= 1 && rom[o + 3] <= 16 && str(u32(rom, o + 4)) !== null);
  if (struct.len >= 60) {
    const names = [];
    for (let i = 0; i < struct.len; i++) names.push(prettyName(str(u32(rom, struct.start + i * 8 + 4))));
    return { names, base: 0, layout: 'regionMapLocations', offset: struct.start };
  }
  // FireRed/LeafGreen: short one-line names in capitals (move descriptions & co. are pointer tables too, with longer
  // text) – a letter or two in lower case is allowed: the German games call Diglett's Cave "DIGDAs HÖHLE".
  const shortName = (p) => {
    const s = str(p);
    return !!s && s.length <= 20 && (s.match(/[a-z]/g) || []).length <= 2;
  };
  // Not the longest such table: the German games' Fame Checker has a longer one ("ALABASTIA", "POKéMON-LABOR",
  // "POKéMON-LABOR", … then people), and there is a run of blank names. The place names are the one with the most
  // different names.
  const pick = (runs) => runs
    .map((r) => ({ ...r, distinct: new Set(Array.from({ length: r.len }, (_, i) => str(u32(rom, r.start + i * 4)))).size }))
    .sort((a, b) => b.distinct - a.distinct || b.len - a.len)[0] || { len: 0 };
  let ptrs = pick(allRuns(rom, 4, (o) => shortName(u32(rom, o)), 60));
  if (ptrs.len < 60) {
    // Complete FireRed Upgrade hacks (Unbound, Radical Red) rewrote the table in mixed case ("Route 1", "Frozen
    // Heights"). Many tables are made of short mixed-case names; this one is indexed by a byte from 0x58 on, so it has
    // at most 0xFF - 0x58 entries – a longer run is another table (move names, …) – and nearly every name is different.
    const placeName = (p) => {
      const s = str(p);
      return !!s && s.length >= 2 && s.length <= 20 && /^[A-Z0-9]/.test(s);
    };
    const runs = allRuns(rom, 4, (o) => placeName(u32(rom, o)), 60).filter((r) => r.len <= 0xff - 0x58);
    const best = pick(runs);
    if (best.len >= 60 && best.distinct >= best.len * 0.8) ptrs = best;
  }
  if (ptrs.len >= 60) {
    const names = new Array(0x58).fill(null);
    for (let i = 0; i < ptrs.len; i++) names.push(prettyName(str(u32(rom, ptrs.start + i * 4))));
    return { names, base: 0x58, layout: 'mapNamePointers', offset: ptrs.start };
  }
  return null;
}

/**
 * Gen 3 map → region map section, from the ROM's map header table (gMapGroups: group pointers → arrays of MapHeader
 * pointers; MapHeader +0x14 regionMapSectionId), and the IWRAM addresses the code loads most often (gSaveBlock1Ptr is
 * among them). For engines whose RAM layout moved (pokeemerald-expansion builds like Run & Bun): the live reader then
 * finds the player's map through SaveBlock1 instead of gMapHeader. → { mapsec: { 'group.num': section }, iwram: [addr…] }
 * or null.
 */
export function gen3MapTable(rom) {
  const groups = gen3MapGroups(rom);
  if (!groups) return null;
  const mapsec = {};
  for (const [key, h] of groups.maps) mapsec[key] = rom[h + 0x14];
  const len = rom.length;
  // IWRAM addresses in the code's literal pools, most used first
  const count = new Map();
  for (let o = 0; o + 4 <= len; o += 4) {
    const v = u32(rom, o);
    if (v >= 0x03000000 && v < 0x03008000 && (v & 3) === 0) count.set(v, (count.get(v) || 0) + 1);
  }
  const iwram = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([v]) => v);
  return { mapsec, iwram, party3: partyPair(rom), gMain: gMainOf(rom), flags3: gen3FlagsAt(rom, iwram), offset: groups.offset };
}

/**
 * The ROM's map headers for the live reader's check of gMapHeader (shared/live/location.mjs readGen3): the game copies
 * the current map's header there (pokeemerald src/overworld.c LoadCurrentMapData: gMapHeader =
 * *Overworld_GetMapHeaderByGroupAndId(…)), so its events pointer (+0x04) and region map section (+0x14) are those of
 * one of the ROM's maps. (Not the layout pointer at +0x00: LoadCurrentMapData puts in the layout the save names, which
 * the Trick House, the Battle Pyramid and others change – GetMapLayout.) → hex of 5 bytes per map (events u32 in the
 * ROM's byte order, section u8), or null. Emerald: 518 maps.
 */
export function gen3MapHeaders(rom) {
  const groups = gen3MapGroups(rom);
  if (!groups) return null;
  let out = '';
  for (const [, h] of groups.maps) for (const o of [4, 5, 6, 7, 0x14]) out += rom[h + o].toString(16).padStart(2, '0');
  return out;
}

/** Every map's region map section, by 'group.num' (the map header table's +0x14), or null when the table isn't found. */
export function gen3MapSections(rom) {
  const groups = gen3MapGroups(rom);
  return groups ? new Map(groups.maps.map(([key, h]) => [key, rom[h + 0x14]])) : null;
}

/** gMapGroups: the group table's offset and every map's header offset ['group.num', offset], or null. */
function gen3MapGroups(rom) {
  const len = rom.length;
  const isPtr = (v) => v >= 0x08000000 && v < 0x08000000 + len && (v & 3) === 0;
  const header = (v) => {
    if (!isPtr(v)) return false;
    const o = v - 0x08000000;
    if (o + 0x1c > len) return false;
    const c = u32(rom, o + 12);
    const scripts = u32(rom, o + 8); // (map scripts are byte code: any alignment)
    return isPtr(u32(rom, o)) && isPtr(u32(rom, o + 4)) && scripts >= 0x08000000 && scripts < 0x08000000 + len && (c === 0 || isPtr(c)) && rom[o + 22] < 0x30 && rom[o + 23] < 0x10;
  };
  const groupOk = (g) => isPtr(g) && header(u32(rom, g - 0x08000000)) && header(u32(rom, g - 0x08000000 + 4));
  let table = -1;
  for (let o = 0; o + 80 <= len; o += 4) {
    if (!groupOk(u32(rom, o))) continue;
    let n = 1;
    while (n < 20 && groupOk(u32(rom, o + n * 4))) n++;
    if (n >= 20) {
      table = o;
      break;
    }
  }
  if (table < 0) return null;
  const groups = [];
  for (let i = 0; table + i * 4 < len && groupOk(u32(rom, table + i * 4)); i++) groups.push(u32(rom, table + i * 4));
  const maps = [];
  groups.forEach((g, gi) => {
    // a group's array ends where the next one's begins (they are laid out one after the other)
    const next = groups.filter((x) => x > g).sort((a, b) => a - b)[0];
    for (let n = 0; n < 256; n++) {
      const at = g - 0x08000000 + n * 4;
      if (next && g + n * 4 >= next) break;
      const h = u32(rom, at);
      if (!header(h)) break;
      maps.push([`${gi}.${n}`, h - 0x08000000]);
    }
  });
  return { maps, offset: table };
}

/**
 * Where SaveBlock1 keeps the event flags, from the code: GetFlagPointer (and the FlagGet/FlagSet it is inlined into)
 * loads gSaveBlock1Ptr and the offset of `flags` from one literal pool, next to the bound of the special flags (0x3FFF
 * in the retail build, -0x4000 and gSpecialFlags in a newer compiler's). Retail Emerald: 0x1270 behind 0x03005D8C;
 * Modern Emerald grew SaveBlock1 in front of them: 0x1364 behind 0x030036F0 (both measured). `iwram`: the IWRAM
 * addresses the code names most (gSaveBlock1Ptr among them). → { sb1Ptr, flags } (the pair seen most) or null.
 */
export function gen3FlagsAt(rom, iwram = []) {
  const top = new Set(iwram);
  const count = new Map();
  for (let o = 12; o + 16 <= rom.length; o += 4) {
    const p = u32(rom, o);
    if (!top.has(p)) continue;
    const near = (d) => u32(rom, o + d);
    if (![-12, -8, -4, 4, 8].some((d) => near(d) === 0x3fff || near(d) === 0xffffc000)) continue;
    for (const d of [-4, 4]) {
      const c = near(d);
      if (c >= 0x800 && c < 0x8000 && c !== 0x3fff) count.set(`${p}:${c}`, (count.get(`${p}:${c}`) || 0) + 1);
    }
  }
  const [best, second] = [...count.entries()].sort((a, b) => b[1] - a[1]);
  if (!best || (second && second[1] === best[1])) return null;
  const [sb1Ptr, flags] = best[0].split(':').map(Number);
  return { sb1Ptr, flags };
}

/**
 * gMain of a Gen 3 engine, from the code: the battle flag is read as gMain + 0x439 (`ldr` gMain and the offset 0x439
 * from one literal pool), so the IWRAM address most often next to a literal 0x439 is gMain – 0x030022C0 in Emerald,
 * 0x03004084 in Too Many Types 2 (measured: bit 1 of 0x030044BD is set in its battles only). null if none stands out.
 */
export function gMainOf(rom) {
  const count = new Map();
  for (let o = 0; o + 4 <= rom.length; o += 4) {
    if (u32(rom, o) !== 0x439) continue;
    for (let d = -16; d <= 16; d += 4) {
      const v = d && o + d >= 0 && o + d + 4 <= rom.length ? u32(rom, o + d) : 0;
      if (v >= 0x03000000 && v < 0x03008000) count.set(v, (count.get(v) || 0) + 1);
    }
  }
  const [best, second] = [...count.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 10 && best[1] >= 3 * (second?.[1] || 0) ? best[0] : null;
}

/**
 * gPlayerParty and gEnemyParty of an expanded Gen 3 engine, from the code: two EWRAM addresses 600 bytes apart (six
 * 100-byte structs, or twelve with another party array between them) among the ones its literal pools hold most often – the pair used most, the player's party the
 * busier of the two (Too Many Types 2: 0x02032C94 577 times, gEnemyParty 0x02032A3C 275 times). → { player, enemy } or
 * null. Only a hint: the live reader takes it when the RAM there holds a team (parse.mjs findGen3Party).
 */
export function partyPair(rom) {
  const count = new Map();
  for (let o = 0; o + 4 <= rom.length; o += 4) {
    const v = u32(rom, o);
    if (v >= 0x02000000 && v < 0x02040000 && (v & 3) === 0) count.set(v, (count.get(v) || 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64);
  let best = null;
  // (two arrays apart: Modern Emerald keeps gPlayerPartyBackup between the two – named twice, the parties 600 and 205
  // times)
  for (const gap of [600, 1200]) {
    for (const [a, n] of top) {
      const m = count.get(a + gap) || 0;
      if (m < 20 || !top.some(([v]) => v === a + gap)) continue;
      if (!best || n + m > best.n) best = { n: n + m, player: n >= m ? a : a + gap, enemy: n >= m ? a + gap : a };
    }
  }
  return best ? { player: best.player, enemy: best.enemy } : null;
}

/**
 * Did a Gen 3 ROM move the base game's RAM? The retail code names gPlayerParty (addresses.json `partyAddr`) in hundreds
 * of literal pools (Emerald 1,091 times), and so does a binary hack built on it (Light Platinum, Emerald Kaizo). A hack
 * rebuilt from the pret disassembly with variables of its own (Modern Emerald: gPlayerParty 0x0201D9CC instead of
 * 0x020244EC, gSaveBlock1Ptr and gMain moved too) names it a handful of times at most – its team, its save blocks and
 * its battle flag have to be found instead of read at the retail addresses.
 */
export function gen3RamMoved(rom, entry) {
  const at = typeof entry?.partyAddr === 'string' ? parseInt(entry.partyAddr, 16) : Number(entry?.partyAddr);
  if (!(at >= 0x02000000 && at < 0x02040000)) return false;
  let n = 0;
  for (let o = 0; o + 4 <= rom.length; o += 4) if (u32(rom, o) === at && ++n >= 16) return false;
  return true;
}

// ---------------------------------------------------------------- Gen 4 (DS)

/** Decrypts a Gen 4 message file (pokeheartgold/pokeplatinum msgdata format) → strings; `chars` = gen4.json chars. */
export function gen4Messages(buf, chars) {
  const n = u16(buf, 0);
  const seed = u16(buf, 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (((seed * 0x2fd) & 0xffff) * (i + 1)) & 0xffff;
    const k32 = (k | (k << 16)) >>> 0;
    const off = (u32(buf, 4 + i * 8) ^ k32) >>> 0;
    const len = (u32(buf, 8 + i * 8) ^ k32) >>> 0;
    if (off + len * 2 > buf.length) {
      out.push('');
      continue;
    }
    let ck = (0x91bd3 * (i + 1)) & 0xffff;
    let cs = [];
    for (let j = 0; j < len; j++) {
      cs.push(u16(buf, off + j * 2) ^ ck);
      ck = (ck + 0x493d) & 0xffff;
    }
    // a compressed string (0xF100 first – the trainer names of Diamond/Pearl/Platinum): 9-bit characters, low bits
    // first, 15 bits of each word
    if (cs[0] === 0xf100) {
      const out = [];
      let acc = 0;
      let bits = 0;
      for (let j = 1; j < cs.length; j++) {
        acc |= (cs[j] & 0x7fff) << bits;
        bits += 15;
        while (bits >= 9) {
          const c = acc & 0x1ff;
          acc >>>= 9;
          bits -= 9;
          out.push(c === 0x1ff ? 0xffff : c);
        }
      }
      cs = out;
    }
    let s = '';
    for (let j = 0; j < cs.length; j++) {
      const c = cs[j];
      if (c === 0xffff) break;
      if (c === 0xe000 || c === 0x25bc || c === 0x25bd) s += ' ';
      else if (c === 0xfffe) j += 2 + (cs[j + 2] || 0); // variable: type, argument count, arguments
      else s += chars?.[c] ?? chars?.[String(c)] ?? '';
    }
    out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
}

// HGSS: wild/area bytes, ?, matrix, scripts, level scripts, text, music day, music night, events, name+icon …
// DP/Pt: area, matrix, scripts, level scripts, text, music day, music night, wild, events, name … – music sits at
// u16 5/6 (DP/Pt) or 6/7 (HGSS); the name index is the byte at +0x12 in all of them (u16 in DP, < 256 anyway).
const GEN4 = {
  hgss: { msgNarc: 'a/0/2/7', msgFile: 279 },
  pt: { msgNarc: 'msgdata/pl_msg.narc', msgFile: 433 },
  dp: { msgNarc: 'msgdata/msg.narc', msgFile: 382 },
};

function gen4Family(code, files) {
  const c = String(code || '').slice(0, 3).toUpperCase();
  if (c === 'IPK' || c === 'IPG') return 'hgss';
  if (c === 'CPU') return 'pt';
  if (c === 'ADA' || c === 'APA') return 'dp';
  // a hack with another game code: tell the engines apart by their file layout
  const has = (p) => files.some((f) => f.path === p);
  if (has('a/0/2/7') && has('a/0/1/2')) return 'hgss';
  if (has('msgdata/pl_msg.narc')) return 'pt';
  if (has('msgdata/msg.narc')) return 'dp';
  return null;
}

/** The map header table: map id → location name index (an array), found by its shape in the ARM9 binary. */
export function gen4MapLocations(arm9) {
  const music = (v) => v >= 1000 && v <= 1300;
  let best = { start: -1, len: 0, at: 0 };
  for (const at of [5, 6]) {
    const run = longestRun(arm9, 24, (o) => music(u16(arm9, o + at * 2)) && music(u16(arm9, o + at * 2 + 2)));
    if (run.len > best.len) best = { ...run, at };
  }
  if (best.len < 100) return null;
  const map = [];
  for (let i = 0; i < best.len; i++) map.push(arm9[best.start + i * 24 + 0x12]);
  return { map, offset: best.start };
}

function gen4(rom, h, files, opts) {
  const family = gen4Family(h.code, files);
  if (!family) return null;
  const arm9 = ndsArm9(rom);
  const headers = gen4MapLocations(arm9.bytes);
  if (!headers) return null;
  const narc = ndsFile(rom, GEN4[family].msgNarc, files);
  if (!narc) return null;
  const msg = parseNarc(narc)[GEN4[family].msgFile];
  if (!msg) return null;
  const names = gen4Messages(msg, opts.gen4Chars);
  const max = Math.max(...headers.map);
  if (names.length <= max) return null; // not the location names: a hack moved the file
  return { gen: 4, family, mapLoc: headers.map, names, source: { headers: headers.offset, msg: `${GEN4[family].msgNarc}#${GEN4[family].msgFile}` } };
}

// ---------------------------------------------------------------- Gen 5 (DS)

/** Decrypts a Gen 5 message file → strings of its first section (BW/B2W2 text format). */
export function gen5Messages(buf) {
  const sections = u16(buf, 0);
  const n = u16(buf, 2);
  if (!sections || 12 + sections * 4 > buf.length) return [];
  const sec = u32(buf, 12);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = sec + 4 + i * 8;
    if (e + 8 > buf.length) break;
    const off = sec + u32(buf, e);
    const len = u16(buf, e + 4);
    if (!len || off + len * 2 > buf.length) {
      out.push('');
      continue;
    }
    let cs = new Array(len);
    let key = u16(buf, off + (len - 1) * 2) ^ 0xffff;
    for (let j = len - 1; j >= 0; j--) {
      cs[j] = u16(buf, off + j * 2) ^ key;
      key = ((key >> 3) | (key << 13)) & 0xffff;
    }
    // a compressed string (0xF100 first – trainer names): 9-bit characters, low bits first, all 16 bits of each word
    if (cs[0] === 0xf100) {
      const out = [];
      let acc = 0;
      let bits = 0;
      for (let j = 1; j < cs.length; j++) {
        acc |= cs[j] << bits;
        bits += 16;
        while (bits >= 9) {
          const c = acc & 0x1ff;
          acc >>>= 9;
          bits -= 9;
          out.push(c === 0x1ff ? 0xffff : c);
        }
      }
      cs = out;
    }
    let s = '';
    for (let j = 0; j < cs.length; j++) {
      const c = cs[j];
      if (c === 0xffff) break;
      if (c === 0xfffe) s += ' ';
      else if (c === 0xf000) {
        s = ''; // a name built from variables ("{player}'s {…}") isn't a place to show
        break;
      } else if (c >= 0x20 && c < 0xd800) s += String.fromCharCode(c);
    }
    out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
}

/**
 * The place names of a Gen 5 text file: its strings without the empty ones at the end – a hack may pad the file for
 * places still to come (Blaze Black 2 Redux: 660 entries, 155 used).
 */
export function gen5PlaceNames(buf) {
  const names = gen5Messages(buf);
  while (names.length && !names[names.length - 1]) names.pop();
  return names;
}

const GEN5 = {
  bw: { msgFile: 89 },
  b2w2: { msgFile: 109 },
};

function gen5Family(code) {
  const c = String(code || '').slice(0, 3).toUpperCase();
  if (c === 'IRB' || c === 'IRA') return 'bw';
  if (c === 'IRE' || c === 'IRD') return 'b2w2';
  return null;
}

/** Zone headers (a/0/1/2: one file, 48 bytes per zone) → zone id → location name index. */
export function gen5ZoneLocations(zones) {
  if (!zones || zones.length < 48 * 50 || zones.length % 48) return null;
  const map = [];
  for (let o = 0; o < zones.length; o += 48) map.push(zones[o + 0x1a]);
  return map;
}

function gen5(rom, h, files) {
  const family = gen5Family(h.code);
  if (!family) return null;
  const zoneNarc = ndsFile(rom, 'a/0/1/2', files);
  const msgNarc = ndsFile(rom, 'a/0/0/2', files);
  if (!zoneNarc || !msgNarc) return null;
  const zones = parseNarc(zoneNarc)[0];
  const map = gen5ZoneLocations(zones);
  const msg = parseNarc(msgNarc)[GEN5[family].msgFile];
  if (!map || !msg) return null;
  const names = gen5PlaceNames(msg);
  // fail closed: nearly every zone must name an existing place, and most places must have a name
  const inRange = map.filter((v) => v < names.length).length;
  if (names.length < 50 || inRange < map.length * 0.95 || names.filter(Boolean).length < names.length * 0.6) return null;
  const out = { gen: 5, family, mapLoc: map.map((v) => (v < names.length ? v : 0)), names, source: { zones: 'a/0/1/2#0', msg: `a/0/0/2#${GEN5[family].msgFile}` } };
  // the games keep a copy of the current zone's header in RAM (shared/live/location.mjs finds it by these bytes) –
  // Black/White since 2.7.5, Black 2/White 2 since 2.8.0
  out.zoneHeaders = Array.from(zones, (v) => v.toString(16).padStart(2, '0')).join('');
  return out;
}

// ---------------------------------------------------------------- entry point

/**
 * Location data of a ROM: { gen, family, code, lang, names, mapLoc, source } or null when the ROM isn't one
 * of the supported engines (or a table doesn't validate). `names[id]` = place name (the game's own text, in the
 * ROM's language), `mapLoc[mapId]` = location id (Gen 4/5; null for Gen 3, whose RAM holds the location id itself).
 * `opts` = { gen3Charset: charset_gen3.json, gen4Chars: gen4.json chars }. Never throws.
 */
export function romLocations(rom, opts = {}) {
  try {
    if (!rom || rom.length < 0x200) return null;
    // GBA: fixed byte 0x96 at 0xB2, game code at 0xAC
    if (rom[0xb2] === 0x96 && rom[3] === 0xea) {
      const code = String.fromCharCode(...rom.subarray(0xac, 0xb0));
      const g = gen3Names(rom, opts.gen3Charset);
      return g ? { gen: 3, family: g.layout === 'mapNamePointers' ? 'frlg' : 'rse', code, lang: langOfCode(code), names: g.names, mapLoc: null, source: { names: g.offset } } : null;
    }
    const h = ndsHeader(rom);
    if (!/^[A-Z0-9]{4}$/.test(h.code) || h.fnt.offset + h.fnt.size > rom.length || h.fat.offset + h.fat.size > rom.length) return null;
    const files = listNdsFiles(rom);
    const r = gen5Family(h.code) ? gen5(rom, h, files) : gen4(rom, h, files, opts);
    return r ? { code: h.code, lang: langOfCode(h.code), ...r } : null;
  } catch {
    return null;
  }
}
