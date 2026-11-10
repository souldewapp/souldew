// Where the player is right now – read live from the game's RAM. Gen 1 `wCurMap`, Gen 2 `wMapGroup`/`wMapNumber`,
// Gen 3 `gMapHeader.regionMapSectionId`, Gen 4 the current map id in the save data (LocalFieldData /
// FieldOverworldState). Every result is turned into the same location ids the met-location tables use (gen 2:
// Crystal landmark ids, gen 3: MAPSEC, gen 4: location names), so a place compares directly with a catch's
// `metLocation`. Gen 1 has no met location; its ids are `maps.gen1Locations` (the town-map names).
// Addresses and tables: shared/data/maps.json (generated from the pret disassemblies, see its _generated).
// With the ROM's own location data (shared/live/romloc.mjs: `ctx.rom`) the map → location step and the names come
// from the game itself instead – randomized games, other languages and ROM hacks with their own maps included – and
// games without a maps.json entry work too where the engine says where the current map id lives (Gen 4: the save
// data, found through the NitroSDK module params; Gen 5: community addresses, unverified).
// Garbage in RAM (title screen, a game that is still booting, a hack with another layout) gives null, never throws.

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ok = (b, n) => !!b && typeof b.length === 'number' && b.length >= n;

/** The maps.json entry for a game – `entry` is the addresses.json entry (findEntry) or its id. */
export function mapEntryFor(maps, entry) {
  const id = typeof entry === 'string' ? entry : entry?.id;
  if (!id || !maps?.games) return null;
  // ids like "heartgold_us~IPKD" are another language found by scanning: its addresses are unknown
  return maps.games[id] || null;
}

function readGen1(m, read, maps) {
  const b = read(hex(m.curMapAddr), 1);
  if (!ok(b, 1)) return null;
  const id = maps.tables?.gen1?.[m.table]?.[String(b[0])];
  return Number.isInteger(id) ? { id, map: b[0] } : null;
}

function readGen2(m, read, maps) {
  const g = read(hex(m.mapGroupAddr), 1);
  const n = read(hex(m.mapNumberAddr), 1);
  if (!ok(g, 1) || !ok(n, 1)) return null;
  const key = `${g[0]}.${n[0]}`;
  const id = maps.tables?.gen2?.[m.table]?.[key];
  // landmark 0 = LANDMARK_SPECIAL (Pokémon Center 2F, trade/colosseum rooms): no place to show
  return Number.isInteger(id) && id > 0 ? { id, map: key } : null;
}

function readGen3(m, read) {
  // struct MapHeader: +0x00 mapLayout (a ROM pointer), +0x14 regionMapSectionId. Before the overworld has
  // loaded once the header is all zeroes – which would read as MAPSEC 0 (Littleroot Town).
  const b = read(hex(m.mapHeaderAddr), 0x18);
  if (!ok(b, 0x18)) return null;
  const layout = u32le(b, 0);
  const events = u32le(b, 4);
  const rom = (p) => p >= 0x08000000 && p < 0x0a000000;
  if (!rom(layout) || !rom(events)) return null;
  const sec = b[0x14];
  // 0xD5+ = MAPSEC_NONE / dynamic (Emerald), 0xC5+ in FireRed/LeafGreen are special sections
  return sec < 0xd5 ? { id: sec, map: sec } : null;
}

// Gen 4 engines: where LocalFieldData/FieldOverworldState keeps the current map id in the save data (see maps.json
// sources), and where the NitroSDK module params word sits whose value + 0x20 holds the SaveData pointer (the party
// reader uses the same: shared/live/parse.mjs readDS – Ironmon's *(0x02000BA8)+0x20, DP *(0x02000B70)+0x20)
const GEN4_ENGINE = {
  hgss: { mapIdOffset: 0x1244, params: 0x02000ba8 },
  pt: { mapIdOffset: 0x1294, params: 0x02000ba8 },
  dp: { mapIdOffset: 0x144c, params: 0x02000b70 },
};
const inRam = (a) => a >= 0x02000000 && a < 0x02400000;

/** Gen 4 family of an addresses.json entry (or the ROM data): 'hgss' | 'pt' | 'dp' | null. */
function gen4Family(entry, rom) {
  if (rom?.gen === 4 && GEN4_ENGINE[rom.family]) return rom.family;
  const id = String(entry?.id || entry || '');
  return /^(heartgold|soulsilver)/.test(id) ? 'hgss' : /^platinum/.test(id) ? 'pt' : /^(diamond|pearl)/.test(id) ? 'dp' : null;
}

/** The SaveData address of a running Gen 4 game, or 0. */
function gen4SaveBase(m, entry, read, ctx, fam) {
  const st = ctx.state;
  if (st && inRam(st.saveBase)) return st.saveBase;
  const ptrs = [];
  const fixed = m?.saveDataPtrAddr ? hex(m.saveDataPtrAddr) : 0;
  const mp = read(GEN4_ENGINE[fam].params, 4);
  const viaParams = ok(mp, 4) && inRam(u32le(mp, 0)) ? u32le(mp, 0) + 0x20 : 0;
  // a hack can move the static data: the module params follow it (sanity-checked against the known pointer, like readDS)
  if (viaParams && (!fixed || Math.abs(viaParams - fixed) < 0x40000)) ptrs.push(viaParams);
  if (fixed) ptrs.push(fixed);
  for (const a of ptrs) {
    const p = read(a, 4);
    if (ok(p, 4) && inRam(u32le(p, 0))) return u32le(p, 0);
  }
  // a party found by scanning (other languages): the save data sits a known distance before it
  if (st && inRam(st.partyAddr) && entry?.partyCoreOffset) return st.partyAddr - hex(entry.partyCoreOffset);
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
  const list = ctx.rom?.gen === 4 ? ctx.rom.mapLoc : maps.tables?.gen4?.[m?.table];
  if (!Array.isArray(list) || mapId >= list.length) return null;
  const id = list[mapId];
  // location 0 = Mystery Zone (MAP_EVERYWHERE / NOTHING / Union Room …): nothing to show
  return Number.isInteger(id) && id > 0 ? { id, map: u16le(b, 0) } : null;
}

// Gen 5: the current zone id (u16) – NDS-Ironmon-Tracker constants/MemoryAddresses.lua childMapHeader /
// parentMapHeader (community values, not verified by souldew yet). Black 2/White 2 behind the main pointer at
// 0x02000024 (masked like the party pointer, addresses.json black2_us), Black/White static (White = Black + 0x20).
const GEN5_ZONE = {
  IRB: { addrs: [0x022592b2, 0x022592b4] },
  IRA: { addrs: [0x022592d2, 0x022592d4] },
  IRE: { ptr: 0x02000024, offsets: [0x41b5c, 0x41b44] },
  IRD: { ptr: 0x02000024, offsets: [0x41b5c, 0x41b44] },
};
const gen5Zone = (code) => GEN5_ZONE[String(code || '').slice(0, 3).toUpperCase()] || null;

function readGen5(m, read, maps, entry, ctx = {}) {
  const rom = ctx.rom;
  const z = rom?.gen === 5 && gen5Zone(rom.code);
  if (!z) return null;
  let addrs = z.addrs;
  if (z.ptr) {
    const p = read(z.ptr, 4);
    if (!ok(p, 4)) return null;
    const base = 0x02000000 + (u32le(p, 0) & 0xffffff);
    addrs = z.offsets.map((o) => base + o);
  }
  // the zone itself first, else its parent zone (a building without a name of its own)
  for (const a of addrs) {
    const b = read(a, 2);
    if (!ok(b, 2)) continue;
    const zone = u16le(b, 0);
    const id = zone < rom.mapLoc.length ? rom.mapLoc[zone] : null;
    if (Number.isInteger(id) && id > 0 && rom.names[id]) return { id, map: zone };
  }
  return null;
}

const READERS = { gen1: readGen1, gen2: readGen2, gen3: readGen3, gen4: readGen4, gen5: readGen5 };

/**
 * Which reader serves this game: the maps.json entry's, else one the ROM's location data makes possible (a game or
 * language maps.json doesn't list). null: no location for this game.
 */
function readerFor(maps, entry, rom) {
  const m = mapEntryFor(maps, entry);
  if (m && READERS[m.kind]) return { m, kind: m.kind, gen: m.gen };
  if (rom?.gen === 4 && gen4Family(entry, rom)) return { m: null, kind: 'gen4', gen: 4 };
  if (rom?.gen === 5 && gen5Zone(rom.code)) return { m: null, kind: 'gen5', gen: 5 };
  return null;
}

/** Can readLocation find the place of this game? (`rom` = romLocations() result or null) */
export function canReadLocation(maps, entry, rom = null) {
  return !!readerFor(maps, entry, rom);
}

/**
 * Current location of the running game: { gen, id, map } (+ romName with ROM data) or null.
 * `entry` = addresses.json entry (or its id), `read(addr, len)` = bus read returning bytes or null,
 * `ctx` = { rom: romLocations() result (the game's own map → location step and names), state: the live party
 * reader's state (its SaveData address) } – both optional. `romName` = the game's own name for the place, or null.
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
 */
export function readMusicInfo(maps, entry, read) {
  try {
    const m = mapEntryFor(maps, entry);
    if (!m || typeof read !== 'function') return null;
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

/**
 * Display name of a location id. `tables` = { maps, loc2, loc3, gen4 } (the JSON files; any may be missing),
 * `lang` 'de' picks the German names where a table has them (gen 4 names are English, like locationName).
 */
export function locationLabel(gen, id, tables = {}, lang = 'en') {
  if (!Number.isInteger(id)) return '';
  const pick = (v) => (v ? (lang === 'de' && v.de) || v.en || '' : '');
  if (gen === 1) return pick(tables.maps?.gen1Locations?.[String(id)]);
  if (gen === 2) return pick(tables.loc2?.map?.[String(id)]);
  if (gen === 3) return pick(tables.loc3?.map?.[String(id)]);
  if (gen === 4) return tables.gen4?.locations?.[id] || '';
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
