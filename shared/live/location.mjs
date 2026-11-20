// Where the player is right now – read live from the game's RAM. Gen 1/2 the copy of the current map's header in WRAM
// (wCurMapHeader; wMapPartial + wMapAttributes), Gen 3 `gMapHeader` (the same, a copy of the ROM's MapHeader), Gen 4
// the current map id in the save data (LocalFieldData / FieldOverworldState), Gen 5 the copy of the current zone's
// header, the 3DS games the zone id. Every result is turned into the same location ids the met-location tables use
// (gen 2: Crystal landmark ids, gen 3: MAPSEC, gen 4: location names), so a place compares directly with a catch's
// `metLocation`. Gen 1 has no met location; its ids are `maps.gen1Locations` (the town-map names).
// Addresses and tables: shared/data/maps.json (generated from the pret disassemblies, see its _generated).
// With the ROM's own location data (shared/live/romloc.mjs: `ctx.rom`, for Game Boy games `ctx.gbMaps`) the map →
// location step and the names come from the game itself instead – randomized games, other languages and ROM hacks with
// their own maps included – and games without a maps.json entry work too where the engine says where the current map
// id lives (Gen 4: the save data, found through the NitroSDK module params; Gen 5: the zone header copy).
// The rule for every reader: the right place or none, never a wrong one. A fixed address is only verified for the games
// whose symbols or checks it comes from (mostly the English ones), so wherever the game keeps a copy of ROM data the
// copy is matched against the ROM's own (Gen 1/2/3/5), and found elsewhere in RAM when it isn't at the fixed address
// (another language) – rarely (a search every few seconds at most, a single hit only, then remembered); the Gen 4 save
// data is taken only when the party reader confirmed it or it holds a trainer. Zeroed RAM (the title screen, a game
// still booting) never reads as a place – it used to: Pallet Town in Red, Black City in Black/White and Black 2/White 2.
// Garbage in RAM (a hack with another layout) gives null, never throws.

import { shiftEntry } from './romwram.mjs';

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ok = (b, n) => !!b && typeof b.length === 'number' && b.length >= n;

/** The maps.json entry for a game – `entry` is the addresses.json entry (findEntry) or its id. */
export function mapEntryFor(maps, entry) {
  const id = typeof entry === 'string' ? entry : entry?.id;
  if (!id || !maps?.games) return null;
  // ids like "heartgold_us~IPKD" are another language found by scanning: its addresses are unknown
  const m = maps.games[id] || null;
  // a Game Boy hack whose variables moved (shared/live/romwram.mjs: the entry carries the shift)
  return m && entry?.wram ? shiftEntry(m, entry.wram) : m;
}

// The link rooms (trades and battles between players, docs/MULTIPLAYER.md) aren't places of the region: the tables
// would name them after whatever their map shares a number with (Gen 1 "Pokémon League", Gen 3 "Ferry"). A reading
// in one gives { id: 'link:<room>', link: '<room>' } – the sign says "Trade Center" / "Colosseum" / "Cable Club" /
// "Union Room", and no area of the run counts it.
const linkRoom = (room, map) => ({ id: `link:${room}`, link: room, map });
const GEN1_LINK = { 239: 'trade', 240: 'colosseum' }; // pokered TRADE_CENTER $EF, COLOSSEUM $F0 (Yellow the same)
const GEN2_LINK = { '20.2': 'trade', '20.3': 'colosseum', '20.4': 'timecapsule' }; // the CableClub map group (G/S/C)
// Gen 4: the Union Room and the two Colosseums of the Pokémon Center's wireless club (2 and 4 players – pret's
// MAP_DIRECT2 / MAP_DIRECT4). Platinum's and Diamond/Pearl's Union Room measured in the link host; the rest from
// pret's map constants (pokeplatinum map_headers 332/333/466, pokediamond maps.h 332/333/466, pokeheartgold maps.h MAP_UNION 2,
// MAP_DIRECT2 4, MAP_DIRECT4 5 – in HG/SS they sit at the start of the list, where the region tables have no place).
const GEN4_COLOSSEUM = { 332: 'colosseum', 333: 'colosseum' };
const GEN4_LINK = { pt: { 466: 'union', ...GEN4_COLOSSEUM }, dp: { 466: 'union', ...GEN4_COLOSSEUM }, hgss: { 2: 'union', 4: 'colosseum', 5: 'colosseum' } };

// Game Boy (Gen 1/2): the game keeps a copy of the current map's header in WRAM – Gen 1 the 10 bytes LoadMapHeader
// copies to wCurMapHeader (tileset, size, blocks/text/script pointers, connections; pokered home/overworld.asm), Gen 2
// the 17 bytes of wMapPartial + wMapAttributes (pokecrystal home/map.asm CopyMapPartial / CopyMapAttributes). Those
// bytes are the ROM's own (server/lib/romloc.mjs `gbMaps`, shared/live/romloc.mjs gbMapHeaders) and name the map: the
// place is read from the copy, at the address of pret's English symbols (maps.json `headerAddr`) – and where it isn't
// there (another language's WRAM layout; pret has no symbols for the German, French … games), wherever it is in WRAM
// (searched for at most every GB_SCAN_MS, a single hit only, then remembered in the live reader's state). The map
// number the game keeps (wCurMap, wMapGroup/wMapNumber) alone proves nothing: zeroed WRAM (the title screen, Oak's
// intro – Gen 1 map 0 is Pallet Town) or another language's variables read as a real map. Without the ROM's headers
// (not loaded, or a hack with maps of its own) the fixed addresses are read as before, but an empty header copy
// (zeroed WRAM) is no place.
const GB_WRAM = 0xc000;
const GB_WRAM_LEN = 0x2000; // WRAM0 + WRAMX bank 1: what the live readers can read (web/player.html toOff)
const GB_SCAN_MS = 2000;
const GEN1_CUR_MAP = 9; // wCurMapHeader − wCurMap (pokered.sym 0xD367 − 0xD35E, pokeyellow.sym 0xD366 − 0xD35D)
const GEN1_SPAN = 10;
const GEN2_SPAN = 17;

const gbIndexes = new WeakMap(); // gbMaps → { gen, sigs: [{ bytes, maps }], byKey: Map }
/** A key for the header copy at `o` (the bytes most different from map to map): Gen 1 size + blocks + text pointer, Gen 2 its first five bytes. */
const gbKey = (gen, b, o) => (gen === 1 ? ((b[o + 1] * 256 + b[o + 2]) * 65536 + u16le(b, o + 3)) * 65536 + u16le(b, o + 5) : (b[o] * 65536 + b[o + 1] * 256 + b[o + 2]) * 65536 + u16le(b, o + 3));

/** The ROM's headers of `gb` (gbMaps), indexed for the search: one entry per distinct header, with every map it is. */
function gbIndex(gb) {
  if (gbIndexes.has(gb)) return gbIndexes.get(gb);
  let idx = null;
  const span = gb?.gen === 1 ? GEN1_SPAN : GEN2_SPAN;
  const list = gb?.gen === 1 && Array.isArray(gb.headers) ? gb.headers.map((h, i) => [i, h]) : gb?.gen === 2 && gb.maps ? Object.entries(gb.maps) : null;
  if (list) {
    const bySig = new Map();
    for (const [map, h] of list) {
      if (typeof h !== 'string' || h.length !== span * 2) continue;
      if (!bySig.has(h)) bySig.set(h, { bytes: Uint8Array.from({ length: span }, (_, i) => parseInt(h.substr(i * 2, 2), 16)), maps: [] });
      bySig.get(h).maps.push(map);
    }
    const byKey = new Map();
    for (const s of bySig.values()) {
      const k = gbKey(gb.gen, s.bytes, 0);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s);
    }
    idx = byKey.size ? { gen: gb.gen, span, byKey } : null;
  }
  gbIndexes.set(gb, idx);
  return idx;
}

/** The maps whose ROM header the bytes at `o` are a copy of (Gen 1: the tileset byte without its "reloaded" bit 7), or null. */
function gbHeaderMaps(idx, b, o) {
  if (o < 0 || o + idx.span > b.length) return null;
  const cands = idx.byKey.get(gbKey(idx.gen, b, o));
  if (!cands) return null;
  const first = idx.gen === 1 ? b[o] & 0x7f : b[o];
  for (const s of cands) {
    if (first !== s.bytes[0]) continue;
    let i = 1;
    while (i < idx.span && b[o + i] === s.bytes[i]) i++;
    if (i === idx.span) return s.maps;
  }
  return null;
}

/**
 * The place of a header copy that names `maps` (one map, or maps sharing a header – Red's unused ids, the two halves of
 * a building): its location when all of them are one place; else the map the game's own map number names (Gen 1:
 * wCurMap, GEN1_CUR_MAP before the copy – `cur`, or null). { id, map } or null.
 */
function gbPlace(gen, maps, table, cur) {
  const pick = maps.length === 1 ? maps[0] : maps.includes(cur) ? cur : null;
  const ids = new Set(maps.map((k) => table?.[String(k)]));
  const map = pick ?? (ids.size === 1 ? maps[0] : null);
  if (map === null) return null;
  const id = table?.[String(map)];
  // (Gen 2 landmark 0 = LANDMARK_SPECIAL: Pokémon Center 2F, trade/colosseum rooms – no place to show)
  return Number.isInteger(id) && (gen === 1 || id > 0) ? { id, map } : null;
}

/**
 * Where the game keeps the copy of the current map's header: the address it was found at before, else pret's
 * (`fixed`), else searched for in WRAM (with the live reader's state `st` only, at most every GB_SCAN_MS; exactly one
 * copy counts). → { at, maps, cur } or null.
 */
function gbHeaderCopy(read, idx, fixed, st) {
  const pre = idx.gen === 1 ? GEN1_CUR_MAP : 0;
  if (st && st.gbHeaderFor !== idx) Object.assign(st, { gbHeaderFor: idx, gbHeaderAt: null, gbHeaderScan: 0 }); // another game
  const tried = [];
  for (const a of [st?.gbHeaderAt, fixed]) {
    if (!a || tried.includes(a) || a - pre < GB_WRAM || a + idx.span > GB_WRAM + GB_WRAM_LEN) continue;
    tried.push(a);
    const b = read(a - pre, pre + idx.span);
    const maps = ok(b, pre + idx.span) ? gbHeaderMaps(idx, b, pre) : null;
    if (maps) {
      if (st) st.gbHeaderAt = a;
      return { at: a, maps, cur: pre ? b[0] : null };
    }
  }
  if (!st || (st.gbHeaderScan && Date.now() - st.gbHeaderScan < GB_SCAN_MS)) return null;
  st.gbHeaderScan = Date.now();
  const ram = read(GB_WRAM, GB_WRAM_LEN);
  if (!ok(ram, GB_WRAM_LEN)) return null;
  let hit = null;
  for (let o = pre; o + idx.span <= GB_WRAM_LEN; o++) {
    const maps = gbHeaderMaps(idx, ram, o);
    if (!maps) continue;
    if (hit) return null; // two copies: neither is trusted
    hit = { at: GB_WRAM + o, maps, cur: pre ? ram[o - pre] : null };
  }
  if (hit) st.gbHeaderAt = hit.at;
  return hit;
}

/** The link room a header copy names (one of `rooms`' maps: the copy's only map, or the game's own map number among them), or null. */
function linkMapOf(c, rooms) {
  const map = c.maps.length === 1 ? c.maps[0] : c.maps.includes(c.cur) ? c.cur : null;
  return map != null && Object.hasOwn(rooms, String(map)) ? map : null;
}

function readGen1(m, read, maps, entry, ctx = {}) {
  const table = maps.tables?.gen1?.[m.table];
  const idx = ctx.gbMaps?.gen === 1 ? gbIndex(ctx.gbMaps) : null;
  if (idx) {
    const c = gbHeaderCopy(read, idx, m.headerAddr ? hex(m.headerAddr) : hex(m.curMapAddr) + GEN1_CUR_MAP, ctx.state || null);
    const room = c && linkMapOf(c, GEN1_LINK);
    if (room != null) return linkRoom(GEN1_LINK[room], room);
    return c ? gbPlace(1, c.maps, table, c.cur) : null;
  }
  // without the ROM's headers: wCurMap – once a map's header has been loaded (height and width are never 0)
  const b = read(hex(m.curMapAddr), GEN1_CUR_MAP + 3);
  if (!ok(b, GEN1_CUR_MAP + 3) || !b[GEN1_CUR_MAP + 1] || !b[GEN1_CUR_MAP + 2]) return null;
  if (GEN1_LINK[b[0]]) return linkRoom(GEN1_LINK[b[0]], b[0]);
  const id = table?.[String(b[0])];
  return Number.isInteger(id) ? { id, map: b[0] } : null;
}

function readGen2(m, read, maps, entry, ctx = {}) {
  const table = maps.tables?.gen2?.[m.table];
  const idx = ctx.gbMaps?.gen === 2 ? gbIndex(ctx.gbMaps) : null;
  if (idx && m.headerAddr) {
    const c = gbHeaderCopy(read, idx, hex(m.headerAddr), ctx.state || null);
    const room = c && linkMapOf(c, GEN2_LINK);
    if (room != null) return linkRoom(GEN2_LINK[room], room);
    return c ? gbPlace(2, c.maps, table, null) : null;
  }
  // without the ROM's headers: wMapGroup/wMapNumber (zeroed WRAM is map 0.0, which no table has)
  const g = read(hex(m.mapGroupAddr), 1);
  const n = read(hex(m.mapNumberAddr), 1);
  if (!ok(g, 1) || !ok(n, 1)) return null;
  const key = `${g[0]}.${n[0]}`;
  if (GEN2_LINK[key]) return linkRoom(GEN2_LINK[key], key);
  const id = table?.[key];
  // landmark 0 = LANDMARK_SPECIAL (Pokémon Center 2F, trade/colosseum rooms): no place to show
  return Number.isInteger(id) && id > 0 ? { id, map: key } : null;
}

const gen3Indexes = new WeakMap(); // ROM data → Map(events pointer → section, -1: maps of different sections share it)
/** The ROM's maps (romloc.mjs gen3MapHeaders `headers3`: events pointer and section per map) by events pointer, or null. */
function gen3Index(rom) {
  if (gen3Indexes.has(rom)) return gen3Indexes.get(rom);
  const h = typeof rom.headers3 === 'string' ? rom.headers3 : '';
  let idx = null;
  if (h.length && h.length % 10 === 0) {
    idx = new Map();
    const byte = (i) => parseInt(h.substr(i, 2), 16);
    for (let i = 0; i < h.length; i += 10) {
      const events = (byte(i) | (byte(i + 2) << 8) | (byte(i + 4) << 16) | (byte(i + 6) << 24)) >>> 0;
      const sec = byte(i + 8);
      idx.set(events, idx.has(events) && idx.get(events) !== sec ? -1 : sec);
    }
  }
  gen3Indexes.set(rom, idx);
  return idx;
}

function readGen3(m, read, maps, entry, ctx = {}) {
  // struct MapHeader: +0x00 mapLayout (a ROM pointer), +0x04 events (a ROM pointer), +0x14 regionMapSectionId. Before
  // the overworld has loaded once the header is all zeroes – which would read as MAPSEC 0 (Littleroot Town).
  const b = read(hex(m.mapHeaderAddr), 0x18);
  if (!ok(b, 0x18)) return null;
  const layout = u32le(b, 0);
  const events = u32le(b, 4);
  const rom = (p) => p >= 0x08000000 && p < 0x0a000000;
  if (!rom(layout) || !rom(events)) return null;
  const sec = b[0x14];
  // Ruby/Sapphire/Emerald's link rooms (Trade Center, Colosseums, Record Corner) share MAPSEC 0x57 with the S.S. Tidal
  // – told apart by their music (0x1A6), measured in the link host
  if (sec === 0x57 && u16le(b, 0x10) === 0x1a6) return linkRoom('cableclub', sec);
  // gMapHeader is a copy of the current map's header in the ROM (romloc.mjs gen3MapHeaders): with the ROM's headers
  // at hand, a copy whose events and section aren't one of its maps' – another language's RAM, a hack's – is no place
  const idx = ctx.rom?.gen === 3 ? gen3Index(ctx.rom) : null;
  if (idx && idx.get(events) !== sec) return null;
  // 0xD5+ = MAPSEC_NONE / dynamic (Emerald), 0xC5+ in FireRed/LeafGreen are special sections
  return sec < 0xd5 ? { id: sec, map: sec } : null;
}

// Gen 4 engines: where LocalFieldData/FieldOverworldState keeps the current map id in the save data (see maps.json
// sources), and where the NitroSDK module params word sits whose value + 0x20 holds the SaveData pointer (the party
// reader uses the same: shared/live/parse.mjs readDS – Ironmon's *(0x02000BA8)+0x20, DP *(0x02000B70)+0x20). `trainer`:
// PKHeX Trainer1 in the save data (the general block + its offset, as addresses.json `badges`): the name (8 u16, 0xFFFF
// after it), TID/SID, money (u32 at +0x14), gender (+0x18).
const GEN4_ENGINE = {
  hgss: { mapIdOffset: 0x1244, params: 0x02000ba8, trainer: 0x10 + 0x64 },
  pt: { mapIdOffset: 0x1294, params: 0x02000ba8, trainer: 0x14 + 0x68 },
  dp: { mapIdOffset: 0x144c, params: 0x02000b70, trainer: 0x214 + 0x64 },
};
const inRam = (a) => a >= 0x02000000 && a < 0x02400000;

/** Gen 4 family of an addresses.json entry (or the ROM data): 'hgss' | 'pt' | 'dp' | null. */
function gen4Family(entry, rom) {
  if (rom?.gen === 4 && GEN4_ENGINE[rom.family]) return rom.family;
  const id = String(entry?.id || entry || '');
  return /^(heartgold|soulsilver)/.test(id) ? 'hgss' : /^platinum/.test(id) ? 'pt' : /^(diamond|pearl)/.test(id) ? 'dp' : null;
}

/**
 * Does the save data at `base` hold a trainer? A named one (a Gen 4 name: 1–7 characters of the game's table, then
 * 0xFFFF), money the game allows (≤ 999,999) and a gender (0/1). What another pointer, the save data before the
 * player is named (the intro) or zeroed RAM never do.
 */
function gen4HasTrainer(read, base, fam) {
  const t = read(base + GEN4_ENGINE[fam].trainer, 0x1a);
  if (!ok(t, 0x1a) || t[0x18] > 1 || u32le(t, 0x14) > 999999) return false;
  for (let i = 0; i < 8; i++) {
    const c = u16le(t, i * 2);
    if (c === 0xffff) return i > 0;
    if (!c || c >= 0x200) return false;
  }
  return false;
}

/**
 * The SaveData address of a running Gen 4 game, or 0. The party reader's when it has one (shared/live/parse.mjs
 * readDS: an English game's through the pointer below; every other language's where the scan found the team, trusted
 * once the save's trainer owns it – saveBaseFromScan). Else, before the team is read, the pointer: an English game's
 * own (maps.json saveDataPtrAddr, from pret's linker maps), else the NitroSDK module params' word + 0x20 (close to the
 * English pointer when there is one: a hack that moved its static data; another language's static data sits
 * elsewhere, where the module params were never checked) – a save data that doesn't hold a trainer (gen4HasTrainer) is
 * none. Never the scanned party's address minus its offset: that party may be a battle's copy (a wrong map id – a
 * wrong place on the sign).
 */
function gen4SaveBase(m, entry, read, ctx, fam) {
  const st = ctx.state;
  if (st && inRam(st.saveBase)) return st.saveBase;
  const ptrs = [];
  const fixed = m?.saveDataPtrAddr ? hex(m.saveDataPtrAddr) : 0;
  const mp = read(GEN4_ENGINE[fam].params, 4);
  const viaParams = ok(mp, 4) && inRam(u32le(mp, 0)) ? u32le(mp, 0) + 0x20 : 0;
  if (viaParams && (!fixed || Math.abs(viaParams - fixed) < 0x40000)) ptrs.push(viaParams);
  if (fixed) ptrs.push(fixed);
  for (const a of ptrs) {
    const p = read(a, 4);
    const base = ok(p, 4) ? u32le(p, 0) : 0;
    if (inRam(base) && gen4HasTrainer(read, base, fam)) return base;
  }
  return 0;
}

function readGen4(m, read, maps, entry, ctx = {}) {
  const fam = gen4Family(entry, ctx.rom);
  if (!fam) return null;
  const save = gen4SaveBase(m, entry, read, ctx, fam);
  if (!save) return null;
  const b = read(save + (m?.mapIdOffset ? hex(m.mapIdOffset) : GEN4_ENGINE[fam].mapIdOffset), 4);
  if (!ok(b, 4)) return null;
  const mapId = u32le(b, 0);
  if (GEN4_LINK[fam]?.[mapId]) return linkRoom(GEN4_LINK[fam][mapId], mapId);
  const list = ctx.rom?.gen === 4 ? ctx.rom.mapLoc : maps.tables?.gen4?.[m?.table];
  if (!Array.isArray(list) || mapId >= list.length) return null;
  const id = list[mapId];
  // location 0 = Mystery Zone (MAP_EVERYWHERE / NOTHING / Union Room …): nothing to show
  return Number.isInteger(id) && id > 0 ? { id, map: u16le(b, 0) } : null;
}

// Gen 5: the zone the player is in (a u16 zone id) and its parent zone (a building's town).
//  - Black 2/White 2: behind the main pointer the game keeps at 0x02000024, masked like the party pointer
//    (addresses.json black2_us) – NDS-Ironmon-Tracker constants/MemoryAddresses.lua MAIN_POINTER 0x24, childMapHeader
//    0x41B5C, parentMapHeader 0x41B44 (community values; checked by souldew in Black 2 / White 2 US). Before the game
//    wrote the pointer (power-on) there is no zone: zeroed RAM would read as zone 0, Black City.
//  - Black/White: the game keeps a copy of the current zone's header – the 48 bytes of the ROM's zone table a/0/1/2
//    (romloc.mjs `zoneHeaders`), the zone's own id at +0x16, its parent zone at +0x18 – and the zone id again right
//    after it (+0x30). Verified by souldew in Black US (IRBO) and White US (IRAO), in the fast player (melonDS) and the
//    browser player (DeSmuME), 2026-11-16: byte for byte the ROM's header of the zone the player is in (391 the room,
//    390 downstairs, 389 Nuvema Town, 396 Juniper's lab with parent 389, 317 Route 1, during battles too) at
//    0x0225929C in Black and 0x022592BC in White – the copy NDS-Ironmon-Tracker reads as childMapHeader 0x022592B2 /
//    parentMapHeader 0x022592B4 (+0x20 in White). Those static addresses are the English games' only: another
//    language's static data sits elsewhere, and what souldew read there before was no zone (zeroes: zone 0, Black
//    City – also on the title screen of the English games – and then nothing at all, a player's report on Discord).
//    So the copy is taken where it matches the ROM's own header: at the English address, else wherever the copy is in
//    RAM (searched for at most every few seconds, then remembered for the session in the live reader's state). Black
//    2/White 2's pointer doesn't apply: in Black/White *(0x02000024) moves with the emulator (0x0221B2F0 in melonDS,
//    0x0221B5F0 in DeSmuME, the zone at the same address in both).
const GEN5_MAIN_PTR = 0x02000024;
// Gen 5: the Union Room behind the left counter of the Pokémon Center's upper floor (zone 422) and the Colosseum a
// battle from it takes both players to (150 "Battles for two"; 151 its twin, the room "Battles for four" goes to) – the
// three zones the ROM's zone → place table gives no place (0). Measured in Black in the link host (two consoles: the
// copy below read 422 in the Union Room, 150 in the battle's room); read the same way in a running White and Black 2
// (19 Nov 2026, recorded sessions with Black). White 2's zones 150, 151 and 422 have the same maps and scripts, but
// White 2 wasn't run in a link room yet: no sign there until it is (gen5Link's `code`).
const GEN5_ROOMS = { 150: 'colosseum', 151: 'colosseum', 422: 'union' };
const GEN5_LINK = { bw: GEN5_ROOMS, b2w2: GEN5_ROOMS };
const gen5Link = (fam, zones, code = '') => (zones && GEN5_LINK[fam]?.[zones[0]] && !/^IRD/i.test(code) ? linkRoom(GEN5_LINK[fam][zones[0]], zones[0]) : null);
const BW_HEADER = 48;
const BW_HEADER_AT = [0x0225929c, 0x022592bc]; // Black US, White US
// The search for the copy: every BW_SCAN_MS, after BW_SCAN_SLOW_AFTER searches without a hit only every BW_SCAN_SLOW_MS
// (a 4 MiB scan; on the title screen or in a ROM whose copy never matches it would otherwise run every 3 s for good) –
// back to the fast pace once the copy is found, another game runs or the game has set up something new (gen5Setup: the
// title screen left, a save loaded – the copy turns up then, not 30 s later). A remembered copy that doesn't match for
// a poll (the game rewriting it on a zone change) keeps the last place for up to BW_KEEP polls, and its address is
// checked again on every poll after that (a read of 50 bytes – back on the title screen and into the game again, the
// copy is where it was).
const BW_SCAN_MS = 3000;
const BW_SCAN_SLOW_MS = 30000;
const BW_SCAN_SLOW_AFTER = 4;
const BW_KEEP = 3;
const BW_READ = 0x32; // the header and the zone id after it

/** 'bw' | 'b2w2' when the ROM's data lets the place be read (Black/White: with its zone headers), else null. */
const gen5Family = (rom) => {
  const c = String(rom?.code || '').slice(0, 3).toUpperCase();
  const fam = rom?.family || (c === 'IRB' || c === 'IRA' ? 'bw' : c === 'IRE' || c === 'IRD' ? 'b2w2' : null);
  return (fam === 'bw' && rom.zoneHeaders) || fam === 'b2w2' ? fam : null;
};

const zoneTables = new WeakMap(); // ROM data → its zone headers as bytes
function bwZoneHeaders(rom) {
  if (zoneTables.has(rom)) return zoneTables.get(rom);
  const hex = typeof rom.zoneHeaders === 'string' ? rom.zoneHeaders : '';
  let t = null;
  if (hex.length && hex.length % (BW_HEADER * 2) === 0) {
    t = new Uint8Array(hex.length / 2);
    for (let i = 0; i < t.length; i++) t[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  zoneTables.set(rom, t);
  return t;
}

/** The zone whose header `b` (at `o`) is a copy of, or -1. */
function bwZoneOf(b, o, t) {
  const zone = u16le(b, o + 0x16);
  if ((zone + 1) * BW_HEADER > t.length) return -1;
  for (let i = 0; i < BW_HEADER; i++) if (b[o + i] !== t[zone * BW_HEADER + i]) return -1;
  return zone;
}

/**
 * An English game's copy at its static address whose bytes differ from the ROM's header (a zone whose header the game
 * changes while it runs): taken when its id fields agree – the zone at +0x16 again at +0x30, in the table, mapping to
 * a place with a name (its own or its parent's) – and most of the header is the ROM's. Never zone 0 (Black City): that
 * is what zeroed RAM reads as, and Black City's copy matches the ROM's anyway. The zone, or -1.
 */
function bwLooseZone(b, t, rom) {
  const zone = u16le(b, 0x16);
  if (!zone || u16le(b, 0x30) !== zone || (zone + 1) * BW_HEADER > t.length) return -1;
  const named = (z) => {
    const id = Number.isInteger(z) && z < (rom.mapLoc?.length || 0) ? rom.mapLoc[z] : null;
    return Number.isInteger(id) && id > 0 && !!rom.names?.[id];
  };
  if (!named(zone) && !named(u16le(b, 0x18))) return -1;
  let same = 0;
  for (let i = 0; i < BW_HEADER; i++) if (b[i] === t[zone * BW_HEADER + i]) same++;
  return same >= BW_HEADER / 2 ? zone : -1;
}

const bwEnglish = (rom) => String(rom?.code || '').toUpperCase().endsWith('O');

/**
 * [zone, parent zone] from a copy of the header at `a`, or null: exact and followed by its zone id, as the search takes
 * it (a header of the table loaded side by side with others is none); at an English game's own address the exact header
 * alone, or bwLooseZone.
 */
function bwZonesAt(read, a, t, rom) {
  const b = read(a, BW_READ);
  if (!ok(b, BW_READ)) return null;
  const own = BW_HEADER_AT.includes(a);
  const zone = bwZoneOf(b, 0, t);
  if ((zone >= 0 && (own || u16le(b, 0x30) === zone)) || (own && bwEnglish(rom) && bwLooseZone(b, t, rom) >= 0)) return [u16le(b, 0x16), u16le(b, 0x18)];
  return null;
}

/**
 * What the game has set up, cheaply: the main pointer's value and where the party reader found the team (its state
 * `partyAddr` – none on the title screen). When it changes the search for the copy of the zone header starts over at the
 * fast pace: the field is set up a moment after the title screen, and the copy only exists from then on.
 */
function gen5Setup(read, st) {
  const p = read(GEN5_MAIN_PTR, 4);
  return `${ok(p, 4) ? u32le(p, 0) : 0}|${st.partyAddr || 0}`;
}

/** The one copy of the current zone's header in main RAM (followed by the zone id again), or 0. */
function bwSearch(read, t) {
  const ram = read(0x02000000, 0x400000);
  if (!ok(ram, 0x400000)) return 0;
  // the copy is followed by the zone id again; a few headers of the table loaded side by side (the zones next to a
  // town) are not – and only one copy counts
  const hits = [];
  for (let o = 0; o + BW_READ <= ram.length; o += 4) {
    const zone = bwZoneOf(ram, o, t);
    if (zone >= 0 && u16le(ram, o + 0x30) === zone) hits.push(0x02000000 + o);
  }
  return hits.length === 1 ? hits[0] : 0;
}

/**
 * Black/White: [zone, parent zone] from the copy of the current zone's header, or null. Where the copy is: where it
 * was found before, else the English address, else searched for in main RAM – only with the live reader's state `st`
 * (it keeps the address, the last zones, the misses and the time of the last search; see BW_SCAN_MS).
 */
function bwZones(read, rom, ctx) {
  const t = bwZoneHeaders(rom);
  if (!t) return null;
  const st = ctx.state || null;
  const game = `${rom.code}|${t.length}`;
  if (st && st.bwGame !== game) Object.assign(st, { bwGame: game, bwZoneAt: null, bwLast: null, bwMiss: 0, bwZoneScan: 0, bwScanMiss: 0, bwSetup: null }); // another game
  const found = (a, z) => {
    if (st) Object.assign(st, { bwZoneAt: a, bwLast: z, bwMiss: 0, bwScanMiss: 0 });
    return z;
  };
  if (st?.bwZoneAt) {
    const z = bwZonesAt(read, st.bwZoneAt, t, rom);
    if (z) return found(st.bwZoneAt, z);
    if (++st.bwMiss < BW_KEEP) return st.bwLast; // (one poll mid-rewrite: the place stays)
    st.bwLast = null; // (no place now – the address stays, checked on every poll)
  }
  for (const a of BW_HEADER_AT) {
    const z = a !== st?.bwZoneAt ? bwZonesAt(read, a, t, rom) : null;
    if (z) return found(a, z);
  }
  if (!st) return null;
  const setup = gen5Setup(read, st);
  if (st.bwSetup !== setup) Object.assign(st, { bwSetup: setup, bwScanMiss: 0 });
  if (st.bwZoneScan && Date.now() - st.bwZoneScan < (st.bwScanMiss >= BW_SCAN_SLOW_AFTER ? BW_SCAN_SLOW_MS : BW_SCAN_MS)) return null;
  st.bwZoneScan = Date.now();
  const a = bwSearch(read, t);
  const z = a ? bwZonesAt(read, a, t, rom) : null;
  if (z) return found(a, z);
  st.bwScanMiss++;
  return null;
}

/** Black/White: the zone header copy (bwZones); Black 2/White 2 go through readB2W2. */
function readGen5(m, read, maps, entry, ctx = {}) {
  const rom = ctx.rom;
  if (rom?.gen !== 5 || gen5Family(rom) !== 'bw') return null;
  const zones = bwZones(read, rom, ctx);
  const link = gen5Link('bw', zones);
  if (link) return link;
  // the zone itself first, else its parent zone (a building without a name of its own)
  for (const zone of zones || []) {
    const id = Number.isInteger(zone) && zone < rom.mapLoc.length ? rom.mapLoc[zone] : null;
    if (Number.isInteger(id) && id > 0 && rom.names[id]) return { id, map: zone };
  }
  return null;
}

// Black 2/White 2 keep a copy of the current zone's header too: the 48 bytes of the ROM's zone table a/0/1/2
// (romloc.mjs `zoneHeaders`) – its parent zone at +0x18, its place name at +0x1A – and the zone's id right after it
// (+0x30). Unlike Black/White's, a Black 2/White 2 header doesn't hold the zone's own id (+0x16 is something else), so
// the copy is matched by the id after it. NDS-Ironmon-Tracker's parentMapHeader (main pointer + 0x41B44) is its +0x18
// and childMapHeader (+0x41B5C) the id after it, so the copy starts at main pointer + 0x41B2C – checked by souldew in
// Black 2 and White 2 (US/EU) live, 2026-11-16: byte for byte the ROM's header of the zone named after it (428 the
// player's room – parent 427 –, 427 Aspertia City, 435, 438 Aspertia Gate, 437 Route 19, in battles too). Read like
// Black/White's: at the address behind the main pointer when the copy there is the ROM's header of the zone it names,
// else wherever the copy is in RAM (searched for like Black/White's – BW_SCAN_MS –, a single hit only, remembered in
// the live reader's state). The pointer alone was taken on trust before: in another language, or before the game has set up
// the field, its zone id read as a place – zeroes, zone 0: "Black City" at power-on (Black 2 and White 2 US, live).
const B2W2_HEADER = 0x41b2c;

/** Is the copy at `o` (48 bytes + the zone id) the ROM's header of the zone it names? → that zone, or -1. */
function b2w2ZoneOf(b, o, t) {
  const zone = u16le(b, o + BW_HEADER);
  if ((zone + 1) * BW_HEADER > t.length) return -1;
  for (let i = 0; i < BW_HEADER; i++) if (b[o + i] !== t[zone * BW_HEADER + i]) return -1;
  return zone;
}

/**
 * An English game's copy behind its main pointer whose bytes differ from the ROM's header (a zone whose header the game
 * changes while it runs – as bwLooseZone for Black/White): taken when the zone after it and the parent in it are the
 * ROM's, the zone has a place, and most of the header is the ROM's. Never zone 0 (Black City: zeroed RAM). Zone or -1.
 */
function b2w2LooseZone(b, t, rom) {
  const zone = u16le(b, BW_HEADER);
  if (!zone || (zone + 1) * BW_HEADER > t.length || u16le(b, 0x18) !== u16le(t, zone * BW_HEADER + 0x18)) return -1;
  const named = (z) => {
    const id = z < (rom.mapLoc?.length || 0) ? rom.mapLoc[z] : null;
    return Number.isInteger(id) && id > 0 && !!rom.names?.[id];
  };
  if (!named(zone) && !named(u16le(b, 0x18))) return -1;
  let same = 0;
  for (let i = 0; i < BW_HEADER; i++) if (b[i] === t[zone * BW_HEADER + i]) same++;
  return same >= BW_HEADER / 2 ? zone : -1;
}

/** [zone, parent zone] from a copy at `a` (exact; behind an English game's own pointer also b2w2LooseZone), or null. */
function b2w2ZonesAt(read, a, t, rom, viaPtr) {
  if (!inRam(a) || !inRam(a + BW_READ - 1)) return null;
  const b = read(a, BW_READ);
  if (!ok(b, BW_READ)) return null;
  if (b2w2ZoneOf(b, 0, t) >= 0 || (a === viaPtr && bwEnglish(rom) && b2w2LooseZone(b, t, rom) >= 0)) return [u16le(b, BW_HEADER), u16le(b, 0x18)];
  return null;
}

/** The one copy of the current zone's header in main RAM, or 0. */
function b2w2Search(read, t) {
  const ram = read(0x02000000, 0x400000);
  if (!ok(ram, 0x400000)) return 0;
  let hit = 0;
  for (let o = 0; o + BW_READ <= ram.length; o += 4) {
    if (b2w2ZoneOf(ram, o, t) < 0) continue;
    if (hit) return 0; // two copies: neither is trusted
    hit = 0x02000000 + o;
  }
  return hit;
}

/**
 * Black 2/White 2: [zone, parent zone] from the copy of the current zone's header, or null – where it was found
 * before, else behind the main pointer, else searched for in main RAM (only with the live reader's state `st`; the
 * same pace, misses and keeping of the last place as Black/White's, see BW_SCAN_MS).
 */
function b2w2CopyZones(read, rom, ctx) {
  const t = bwZoneHeaders(rom);
  if (!t) return null;
  const st = ctx.state || null;
  const game = `${rom.code}|${t.length}`;
  if (st && st.b2w2Game !== game) Object.assign(st, { b2w2Game: game, b2w2ZoneAt: null, b2w2Last: null, b2w2Miss: 0, b2w2ZoneScan: 0, b2w2ScanMiss: 0, b2w2Setup: null }); // another game
  const found = (a, z) => {
    if (st) Object.assign(st, { b2w2ZoneAt: a, b2w2Last: z, b2w2Miss: 0, b2w2ScanMiss: 0 });
    return z;
  };
  const p = read(GEN5_MAIN_PTR, 4);
  const off = ok(p, 4) ? u32le(p, 0) & 0xffffff : 0;
  const viaPtr = off ? 0x02000000 + off + B2W2_HEADER : 0;
  if (st?.b2w2ZoneAt) {
    const z = b2w2ZonesAt(read, st.b2w2ZoneAt, t, rom, viaPtr);
    if (z) return found(st.b2w2ZoneAt, z);
    if (++st.b2w2Miss < BW_KEEP) return st.b2w2Last; // (one poll mid-rewrite: the place stays)
    st.b2w2Last = null; // (no place now – the address stays, checked on every poll)
  }
  const z = viaPtr && viaPtr !== st?.b2w2ZoneAt ? b2w2ZonesAt(read, viaPtr, t, rom, viaPtr) : null;
  if (z) return found(viaPtr, z);
  if (!st) return null;
  const setup = gen5Setup(read, st);
  if (st.b2w2Setup !== setup) Object.assign(st, { b2w2Setup: setup, b2w2ScanMiss: 0 });
  if (st.b2w2ZoneScan && Date.now() - st.b2w2ZoneScan < (st.b2w2ScanMiss >= BW_SCAN_SLOW_AFTER ? BW_SCAN_SLOW_MS : BW_SCAN_MS)) return null;
  st.b2w2ZoneScan = Date.now();
  const a = b2w2Search(read, t);
  const zs = a ? b2w2ZonesAt(read, a, t, rom, viaPtr) : null;
  if (zs) return found(a, zs);
  st.b2w2ScanMiss++;
  return null;
}

/** Black 2/White 2: the place from the copy of the current zone's header – the zone's, else its parent's. */
function readB2W2(read, rom, ctx) {
  const zones = b2w2CopyZones(read, rom, ctx);
  const link = gen5Link('b2w2', zones, rom.code);
  if (link) return link;
  for (const zone of zones || []) {
    const id = Number.isInteger(zone) && zone < rom.mapLoc.length ? rom.mapLoc[zone] : null;
    if (Number.isInteger(id) && id > 0 && rom.names[id]) return { id, map: zone };
  }
  return null;
}

/** Gen 5: Black 2/White 2 by the copy of the zone header (readB2W2), Black/White by readGen5. */
function readGen5Any(m, read, maps, entry, ctx = {}) {
  const rom = ctx.rom;
  if (rom?.gen === 5 && gen5Family(rom) === 'b2w2') return readB2W2(read, rom, ctx);
  return readGen5(m, read, maps, entry, ctx);
}

/**
 * An expanded GBA engine (Run & Bun & co.): gMapHeader moved, so the place comes from SaveBlock1's map (group, number at
 * +4/+5) and the ROM's own map → section table (romloc.mjs gen3MapTable `maps3`). gSaveBlock1Ptr is one of the IWRAM
 * addresses the code loads most often (`maps3.iwram`): the one that leads to a map the table knows, with a position
 * that fits, is remembered for the session.
 */
function readGen3x(m, read, maps, entry, ctx = {}) {
  const t = ctx.rom?.maps3;
  if (!t?.mapsec) return null;
  const st = ctx.state || {};
  // a hack that put fields of its own in front of SaveBlock1's position (Pokémon Quetzal: 0x470 bytes – addresses.json
  // `saveBlock1Pos`), and whose gSaveBlock1Ptr the entry names (measured – tried first)
  const at = entry?.saveBlock1Pos ? hex(entry.saveBlock1Pos) : 0;
  const own = entry?.saveBlockPtrs?.sb1 ? hex(entry.saveBlockPtrs.sb1) : 0;
  const tryPtr = (a) => {
    const p = read(a, 4);
    const sb1 = ok(p, 4) ? u32le(p, 0) : 0;
    if (sb1 < 0x02000000 || sb1 + at >= 0x02040000) return null;
    const b = read(sb1 + at, 6);
    if (!ok(b, 6)) return null;
    // a SaveBlock1 still empty (title screen, intro: no save loaded yet) reads as map 0.0 at 0,0 – Petalburg City
    if (b.every((v) => v === 0)) return { empty: true };
    const x = (u16le(b, 0) << 16) >> 16;
    const y = (u16le(b, 2) << 16) >> 16;
    const sec = t.mapsec[`${b[4]}.${b[5]}`];
    return Number.isInteger(sec) && x >= -8 && x < 512 && y >= -8 && y < 512 ? { id: sec, map: `${b[4]}.${b[5]}` } : null;
  };
  if (st.sb1PtrAddr) {
    const r = tryPtr(st.sb1PtrAddr);
    if (r?.empty) return null;
    if (r) return r.id < 0xd5 ? r : null;
  }
  for (const a of own ? [own, ...(t.iwram || []).filter((x) => x !== own)] : t.iwram || []) {
    const r = tryPtr(a);
    if (r?.empty) return null; // (no place yet – and no other address is tried and remembered meanwhile)
    if (r) {
      st.sb1PtrAddr = a;
      return r.id < 0xd5 ? r : null;
    }
  }
  return null;
}

/**
 * Nintendo 3DS (Gen 6/7): the zone the game is in (u16 at the addresses.json entry's zoneAddr – PKMN-NTR's mapidoff
 * for X/Y and Omega Ruby/Alpha Sapphire) and its place from the game's own zone table (server/lib/romloc.mjs ctrData
 * – shared/live/ctrzones.mjs). Only once the team is in memory: before that (title screen, intro) the zone is
 * whatever the last scene left.
 */
function readCtr(_m, read, _maps, entry, ctx) {
  const places = ctx.rom?.ctr?.places;
  if (!places || !entry?.zoneAddr || !(ctx.state?.g67Len > 0)) return null;
  const b = read(hex(entry.zoneAddr), 2);
  if (!ok(b, 2)) return null;
  const zone = u16le(b, 0);
  const id = places[zone];
  return Number.isInteger(id) && id > 0 ? { id, map: zone } : null;
}

const READERS = { gen1: readGen1, gen2: readGen2, gen3: readGen3, gen3x: readGen3x, gen4: readGen4, gen5: readGen5Any, ctr: readCtr };

/**
 * Which reader serves this game: the maps.json entry's, else one the ROM's location data makes possible (a game or
 * language maps.json doesn't list). null: no location for this game.
 */
function readerFor(maps, entry, rom) {
  if (rom?.gen === 3 && rom.maps3) return { m: null, kind: 'gen3x', gen: 3 };
  if (rom?.ctr && entry?.zoneAddr) return { m: null, kind: 'ctr', gen: rom.gen };
  const m = mapEntryFor(maps, entry);
  if (m && READERS[m.kind]) return { m, kind: m.kind, gen: m.gen };
  if (rom?.gen === 4 && gen4Family(entry, rom)) return { m: null, kind: 'gen4', gen: 4 };
  if (rom?.gen === 5 && gen5Family(rom)) return { m: null, kind: 'gen5', gen: 5 };
  return null;
}

/** Can readLocation find the place of this game? (`rom` = romLocations() result or null) */
export function canReadLocation(maps, entry, rom = null) {
  return !!readerFor(maps, entry, rom);
}

/**
 * Current location of the running game: { gen, id, map } (+ romName with ROM data) or null.
 * `entry` = addresses.json entry (or its id), `read(addr, len)` = bus read returning bytes or null,
 * `ctx` = { rom: romLocations() result (the game's own map → location step and names), gbMaps: a Game Boy ROM's map
 * headers (server/lib/romloc.mjs romData `gbMaps`), state: the live party reader's state (its SaveData address; the
 * readers remember where they found a header copy in it) } – all optional; without `state` nothing is searched for.
 * `romName` = the game's own name for the place, or null.
 */
export function readLocation(maps, entry, read, ctx = {}) {
  try {
    if (typeof read !== 'function') return null;
    const rom = ctx.rom || null;
    const r0 = readerFor(maps, entry, rom);
    if (!r0) return null;
    const r = READERS[r0.kind](r0.m, read, maps, entry, ctx);
    if (!r) return null;
    if (!rom || rom.gen !== r0.gen) return { gen: r0.gen, ...r };
    return { gen: r0.gen, ...r, romName: rom.names?.[r.id] || null };
  } catch {
    return null;
  }
}

/** The song number the game keeps in RAM ('m<id>'), or null: no address, nothing reads, no music, out of range. */
function readSong(m, read) {
  if (!m.musicAddr) return null;
  const n = m.musicSize === 2 ? 2 : 1;
  const b = read(hex(m.musicAddr), n);
  if (!ok(b, n)) return null;
  const v = n === 2 ? u16le(b, 0) : b[0];
  if (!v || v === (n === 2 ? 0xffff : 0xff)) return null;
  if (m.musicRange && (v < m.musicRange[0] || v > m.musicRange[1])) return null;
  return `m${v}`;
}

/**
 * What the game's music is right now, for the turbo mixer: { song, map, expected, playing } or null.
 * `song` the song number the game keeps ('m<id>': HGSS SND_WORK.currentSeqNo, battles included – `playing`; Gen 1/2
 * the map's music wMapMusicSoundID / wMapMusic, Gen 3 sCurrentMapMusic, not a battle's – maps that share a song share
 * it), `map` the map the player is on ('p<gen>.<map>'), `expected` the music the map header names ('m<id>', HGSS – the
 * same numbers as `song`), `own` the song is the player's own (bicycle, surfing). Any of them may be null; never throws.
 * `ctx.state`: the live party reader's state (the 3DS games, see ctrMusicInfo).
 */
export function readMusicInfo(maps, entry, read, ctx = {}) {
  try {
    if (typeof read !== 'function') return null;
    const m = mapEntryFor(maps, entry);
    if (!m) return ctrMusicInfo(entry, read, ctx);
    const r = readLocation(maps, entry, read);
    const music = r && m.musicTable ? maps.tables?.gen4Music?.[m.musicTable]?.[r.map] : null;
    const song = readSong(m, read);
    // a song of the player's own (bicycle, surfing) replaces the map's music on purpose: not a sign of a wrong address
    const own = !!song && (m.musicOwn || []).includes(Number(song.slice(1)));
    return { song, map: r ? `p${r.gen}.${r.map}` : null, expected: Number.isInteger(music) && music > 0 ? `m${music}` : null, playing: !!m.musicPlaying, own };
  } catch {
    return null;
  }
}

/**
 * Nintendo 3DS (Gen 6/7): no song number is known in RAM, so the turbo mixer's key is the zone the game is in
 * ('p<gen>.<zone>', the u16 at the entry's zoneAddr – as readCtr) – and a battle is 'battle' (MusicKeyTracker). Without
 * any key the mixer could only tell a song change by a silence, and a 3DS game hardly ever falls silent (the ambience
 * goes on, a battle starts straight out of the field music): "Music continues" kept the battle's loop through the battle's
 * end and the next fast-forwards (a Windows player, Pokémon Y, 2.7.4). Only once the live reader found the party at one
 * of the game's addresses (`ctx.state.g67Len`, as the location sign): before that the update version – and with it
 * whether zoneAddr holds the zone – is unknown, and a key that changes all the time switches the music all the time.
 */
function ctrMusicInfo(entry, read, ctx) {
  if (entry?.platform !== '3ds' || !entry.zoneAddr || !(ctx.state?.g67Len > 0)) return null;
  const b = read(hex(entry.zoneAddr), 2);
  if (!ok(b, 2)) return null;
  const zone = u16le(b, 0);
  if (zone >= 0x400) return null; // (no 3DS Pokémon game has that many zones: not the zone)
  return { song: null, map: `p${entry.gen}.${zone}`, expected: null, playing: false, own: false };
}

/** The song key alone (readMusicInfo): the game's song number, else the map. */
export function readMusicKey(maps, entry, read) {
  const i = readMusicInfo(maps, entry, read);
  return i ? i.song || i.map : null;
}

/**
 * Turns readMusicInfo readings (a few per second) into the mixer's song key, robust against a song address that
 * doesn't hold the song (a ROM hack with another sound layout: the same number everywhere, or noise). The song
 * number is used while it follows the game: once it stayed the same through STUCK changes of the map's music (or,
 * without a map-music table, through STUCK_MAPS different maps), it is distrusted for the session and the map's music
 * (else the map itself) is the key. Where the key doesn't cover battles (the map's music, Gen 1–3), a battle is 'battle'.
 */
export class MusicKeyTracker {
  constructor({ stuck = 3, stuckMaps = 8, settle = 8 } = {}) {
    Object.assign(this, { stuck, stuckMaps, settle });
    this.trusted = true;
    this.lastSong = null;
    this.lastExpected = null;
    this.sinceSong = 0; // changes of the map's music the song number didn't follow, in a row
    this.judgedSong = null;
    this.mapsSince = new Set(); // maps visited since then
    this.mapKey = null;
    this.stable = 0; // readings the map stayed the same
  }

  next(info, battle = false) {
    if (!info) return null;
    const { song, map, expected } = info;
    if (map !== this.mapKey) {
      this.mapKey = map;
      this.stable = 0;
    } else this.stable++;
    if (song && song !== this.lastSong) {
      this.lastSong = song;
      this.mapsSince.clear();
    }
    // judged once the map has settled (the song changes a moment after the map: fade-out first)
    if (this.trusted && this.stable === this.settle && map) {
      if (expected && expected !== this.lastExpected) {
        if (this.lastExpected && !info.own) this.sinceSong = this.lastSong === this.judgedSong ? this.sinceSong + 1 : 0;
        this.lastExpected = expected;
        this.judgedSong = this.lastSong;
      }
      this.mapsSince.add(map);
      if (this.sinceSong >= this.stuck || (!expected && this.mapsSince.size >= this.stuckMaps)) this.trusted = false;
    }
    const useSong = this.trusted && !!song;
    if (battle && !(useSong && info.playing)) return 'battle';
    return (useSong ? song : expected || map) || null;
  }
}

/** The name of a location table entry ({ en, de, es, fr, it }) in `lang` – English where it has none (or is the same). */
export const nameIn = (e, lang = 'en') => (e && typeof e === 'object' ? e[lang] || e.en || '' : '');

/**
 * Name of a met / current location id in `lang` (the app's languages), '' when the tables don't know it.
 * `tables` = { maps, loc2 … loc7, gen4 } (shared/data: maps.json, locations_gen<N>.json, gen4.json; any may be
 * missing). Gen 1 ids are maps.json's gen1Locations; Gen 4 falls back to gen4.json's English names without loc4.
 */
export function locationLabel(gen, id, tables = {}, lang = 'en') {
  if (!Number.isInteger(id)) return '';
  if (gen === 1) return nameIn(tables.maps?.gen1Locations?.[String(id)], lang);
  if (gen === 4) {
    const en = id >= 2000 ? tables.gen4?.locationsSpecial?.[String(id)] : tables.gen4?.locations?.[id];
    return nameIn(tables.loc4?.map?.[String(id)], lang) || en || '';
  }
  if (gen >= 2 && gen <= 7) return nameIn(tables[`loc${gen}`]?.map?.[String(id)], lang);
  return '';
}

/**
 * The name the sign shows for a readLocation result. `rom` = the ROM's location data (romLocations() + `vanilla` from
 * the server), `table` = the app's own name for the place (locationLabel, in the app's language), `lang` = the app's
 * language. A modified ROM (randomized, a ROM hack – its CRC isn't a retail one) always shows the game's own name: a
 * hack's maps may reuse a vanilla place id for somewhere else. An unmodified one shows the game's name when it speaks
 * the app's language (the name the game itself shows), else the app's translation; a place the tables don't know
 * keeps the game's name either way.
 */
export function placeName(r, { rom = null, table = '', lang = 'en' } = {}) {
  if (!r) return '';
  const own = r.romName || '';
  if (own && rom?.vanilla === false) return own;
  if (own && rom?.lang && rom.lang === lang) return own;
  return table || own;
}

/** Same place? (two readLocation results) */
export const sameLocation = (a, b) => (!a && !b) || (!!a && !!b && a.gen === b.gen && a.id === b.id);
