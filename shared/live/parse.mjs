// Live party readers for Gen 1–7. Works on any memory source that can read system bus addresses:
// the integrated emulator (WASM heap), the mGBA Lua bridge or Azahar's RPC server (streamed regions) or a RAM dump.
// Gen 6/7 (3DS) lives in ./gen67.mjs.
// Output is the same normalized mon shape the save parser produces, so the SoulLink logic
// doesn't care where the data came from.
// Addresses/structs: research/live_ram.md (pret disassemblies + PKHeX), shared/data/addresses.json.
import { decryptPK4 } from '../gen4save.mjs';
import { readGen67, regions67, readGen67Battle, battleRegions } from './gen67.mjs';
import { catchRate3ds } from './catch3ds.mjs';
import { ctrNoBalls } from './cheats.mjs';

const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u24be = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

/** Find the address-table entry for a running game. header: { platform, title, code } */
export function findEntry(table, header) {
  const games = table?.games || [];
  const code = String(header.code || '').trim().toUpperCase();
  const title = String(header.title || '').trim().toUpperCase();
  for (const g of games) {
    const m = g.match || {};
    const codes = [].concat(m.gameCode || [], m.manufacturerCode || []).map((c) => String(c).toUpperCase());
    if (code && codes.includes(code)) return g;
  }
  // 3DS: the running title ID (Azahar's process list) – a game started from its installed .cia has no file to read
  const titleId = String(header.titleId || '').toUpperCase();
  if (titleId) {
    const g = games.find((x) => (x.match?.titleIds || []).some((t) => String(t).toUpperCase() === titleId));
    if (g) return g;
  }
  // (a Game Boy Color-enhanced cart without a manufacturer code: its title runs on into the four bytes identifyRom reads as
  // one – Yellow's "POKEMON YELLOW" with the CGB flag reads as "POKEMON YEL" and "LOW")
  const long = title.length === 11 ? title + code : title;
  for (const g of games) {
    const m = g.match || {};
    if (m.title && title && (g.platform === 'gb' || g.platform === 'gbc') && long.startsWith(String(m.title).toUpperCase())) return g;
  }
  // Same game code family on DS (e.g. IPKD German HeartGold → IPKE layout via scan)
  if (header.platform === 'nds' && code.length === 4) {
    const fam = games.find((g) => g.platform === 'nds' && String(g.match?.gameCode || '').slice(0, 3) === code.slice(0, 3));
    if (fam) return { ...fam, id: `${fam.id}~${code}`, saveDataPtrAddr: null, partyBaseAddr: null, scanOnly: true };
  }
  return null;
}

/** Memory regions (bus address + length) that contain the party – for streaming bridges. */
export function regionsFor(entry) {
  if (!entry) return [];
  if (entry.gen <= 2) {
    const start = hex(entry.partyCountAddr);
    const end = hex(entry.nicknamesAddr) + entry.nameLength * 6;
    return [{ addr: start, len: end - start, name: 'party' }];
  }
  if (entry.gen === 3) {
    return [
      { addr: hex(entry.partyCountAddr), len: 1, name: 'count' },
      { addr: hex(entry.partyAddr), len: entry.structSize * 6, name: 'party' },
    ];
  }
  if (entry.gen >= 6) {
    // every update's party address, and its badge byte (Gen 6)
    const badges = (entry.partyAddrs || []).filter((a) => a.badges).map((a) => ({ addr: hex(a.badges), len: 1, name: 'badges' }));
    const zone = entry.zoneAddr ? [{ addr: hex(entry.zoneAddr), len: 2, name: 'zone' }] : [];
    return [...regions67(entry).map((r) => ({ ...r, name: 'party' })), ...badges, ...battleRegions(entry), ...zone];
  }
  return [];
}

function decodeText(bytes, charset, terminator) {
  let s = '';
  for (const b of bytes) {
    if (b === terminator) break;
    const c = charset?.[b] ?? charset?.[String(b)] ?? charset?.[`0x${b.toString(16).toUpperCase().padStart(2, '0')}`];
    if (c === undefined || c === null) continue;
    s += c;
  }
  return s.trim();
}

function charsetMap(json) {
  if (!json) return {};
  // { table: { "80": "A", … } } with hex byte keys (research/live_ram.md)
  const src = json.table || json.map || json;
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('_')) continue;
    const n = parseInt(k.replace(/^0x/i, ''), 16);
    if (!Number.isNaN(n) && typeof v === 'string') out[n] = v;
  }
  return out;
}

function indexMap(json) {
  if (!json) return null;
  if (Array.isArray(json)) return json;
  const src = json.map || json.table || json;
  const arr = [];
  for (const [k, v] of Object.entries(src)) if (!k.startsWith('_')) arr[Number(k)] = v;
  return arr;
}

/**
 * Species numbers above this stand for a Pokémon only the ROM knows (a ROM hack's own, "fakémon"): FAKEMON + its index
 * in the game. The UI names them from the ROM (web/lib/data.mjs setRomSpecies).
 */
export const FAKEMON = 20000;

export class LiveTables {
  constructor({ charsetGen1, charsetGen2, charsetGen3, gen1Index, gen3Index, gen4 }) {
    this.cs1 = charsetMap(charsetGen1);
    this.cs2 = charsetMap(charsetGen2);
    this.cs3 = charsetMap(charsetGen3);
    this.idx1 = indexMap(gen1Index);
    this.idx3 = indexMap(gen3Index);
    this.fake3 = null;
    this.gen4 = gen4;
  }

  /**
   * These tables with a GBA ROM's own species table (shared/live/romspecies.mjs romSpecies()): a ROM hack that put
   * other Pokémon into the slots reads as what the game shows. Without a changed table the tables stay as they are.
   */
  withSpecies(sp, own = null) {
    if (!sp?.map) return this;
    const t = Object.create(this);
    t.idx3 = sp.map;
    t.fake3 = sp.unknown && Object.keys(sp.unknown).length ? sp.unknown : null;
    t.expanded3 = sp.engine === 'expanded';
    // an expanded engine's own item names and move numbers (server/lib/romloc.mjs ownTables3: `items`, `moves`)
    t.items3 = t.expanded3 ? own?.items?.names || null : null;
    t.moves3 = t.expanded3 ? own?.moves?.map || null : null;
    return t;
  }

  /**
   * These tables with what the server read from the running ROM (server/lib/romloc.mjs): its types (`types3`: the
   * battle's current types are named with them) and the badge flags its leaders' scripts set (`badges3`, romcaps.mjs).
   */
  withRom(rom) {
    if (!rom?.types && !rom?.caps) return this;
    const t = Object.create(this);
    t.types3 = rom.types?.keys && rom.types?.species ? rom.types : null;
    t.badges3 = Number.isInteger(rom.caps?.badgeFlags) ? rom.caps.badgeFlags : null;
    return t;
  }

  /**
   * These tables for a run whose game compares with another shiny threshold (shared/shiny.mjs shinyThreshold – the
   * run's shiny rate): a Pokémon is shiny when its shiny value is below it, as the game itself decides.
   */
  withShinyOdds(odds) {
    if (!Number.isInteger(odds) || odds === SHINY_ODDS) return this;
    const t = Object.create(this);
    t.shinyOdds = odds;
    return t;
  }
}

/** Gen 3–5: shiny when the XOR of the halves of OT ID and personality is below this (8 – or the run's own, withShinyOdds). */
const SHINY_ODDS = 8;
const isShiny = (pid, otId, T) => (((pid >>> 16) ^ (pid & 0xffff) ^ (otId >>> 16) ^ (otId & 0xffff)) >>> 0) < (T?.shinyOdds ?? SHINY_ODDS);

// ---------------------------------------------------------------------------
// Gen 1 / 2 (Game Boy): plain structs, big-endian HP, internal species index in Gen 1.

function readGB(entry, read, T, state = {}) {
  const gen = entry.gen;
  const countAddr = hex(entry.partyCountAddr);
  const head = read(countAddr, 8);
  if (!head) return null;
  const count = head[0];
  if (count > 6) return { invalid: true };
  if (count > 0 && head[1 + count] !== 0xff) return { invalid: true };
  const size = entry.structSize;
  const mons = read(hex(entry.partyAddr), size * 6) || new Uint8Array(size * 6);
  const nicks = read(hex(entry.nicknamesAddr), entry.nameLength * 6) || new Uint8Array(66);
  // The game rewrites the party a byte at a time (a swap in the party menu, the save loading, a level-up) and a
  // frame can end halfway. There is no checksum: Gen 1 keeps HP in front of the OT ID and DVs, so a slot rewritten
  // that far reads as the incoming mon's species and HP under the old mon's key – a death or an "evolution" that
  // never happened. So a party that changed counts once it reads the same twice in a row (one poll later).
  const sig = `${Array.prototype.join.call(head.subarray(0, 1 + count), ',')}|${Array.prototype.join.call(mons.subarray(0, count * size), ',')}|${Array.prototype.join.call(nicks.subarray(0, count * entry.nameLength), ',')}`;
  const changed = state.gbSig !== undefined && state.gbSig !== sig;
  state.gbSig = sig;
  if (changed) return { torn: true };
  const cs = gen === 1 ? T.cs1 : T.cs2;
  const party = [];
  for (let i = 0; i < count; i++) {
    const d = mons.subarray(i * size, (i + 1) * size);
    const raw = d[0];
    const species = gen === 1 ? T.idx1?.[raw] || 0 : raw;
    if (!species || species > 251) return { invalid: true };
    const isEgg = gen === 2 && head[1 + i] === 0xfd;
    const otId = gen === 1 ? u16be(d, 0x0c) : u16be(d, 0x06);
    const dvOff = gen === 1 ? 0x1b : 0x15;
    const dv = u16be(d, dvOff);
    const atk = d[dvOff] >> 4;
    const def = d[dvOff] & 15;
    const spe = d[dvOff + 1] >> 4;
    const spc = d[dvOff + 1] & 15;
    const level = gen === 1 ? d[0x21] : d[0x1f];
    const hp = gen === 1 ? u16be(d, 0x01) : u16be(d, 0x22);
    const maxHp = gen === 1 ? u16be(d, 0x22) : u16be(d, 0x24);
    if (level < 1 || level > 100 || hp > maxHp || maxHp === 0) return { invalid: true };
    let metLocation = null;
    let metLevel = null;
    if (gen === 2 && entry.caughtData) {
      metLocation = d[0x1e] & 0x7f || null;
      metLevel = d[0x1d] & 0x3f || null;
    }
    party.push({
      key: `g${gen}-${otId.toString(16)}-${dv.toString(16).padStart(4, '0')}`,
      species, nickname: decodeText(nicks.subarray(i * entry.nameLength, (i + 1) * entry.nameLength), cs, 0x50),
      level, hp, maxHp, status: gen === 1 ? d[0x04] : d[0x20], item: gen === 2 ? d[0x01] : 0,
      moves: gen === 1 ? [d[8], d[9], d[10], d[11]].filter(Boolean) : [d[2], d[3], d[4], d[5]].filter(Boolean),
      shiny: gen === 2 && def === 10 && spe === 10 && spc === 10 && [2, 3, 6, 7, 10, 11, 14, 15].includes(atk),
      metLocation, metLevel, isEgg, otId,
    });
  }
  // No party = title screen / intro (WRAM cleared): the badge byte means nothing yet – a 0 here would
  // lower the level cap and make the real count look "newly earned" once the save is loaded.
  return { party, badges: count ? readBadgeBits(entry, read) : undefined };
}

const popcount = (n) => n.toString(2).replace(/0/g, '').length;

/** Badge count from a plain bit field (Gen 1: 1 byte, Gen 2: Johto + Kanto bytes). */
function readBadgeBits(entry, read) {
  if (!entry.badges?.addr) return undefined;
  const b = read(hex(entry.badges.addr), entry.badges.bytes || 1);
  return b ? [...b].reduce((n, x) => n + popcount(x), 0) : undefined;
}

// ---------------------------------------------------------------------------
// Gen 3 (GBA): 100-byte party struct, 48-byte data block XOR-encrypted with PID ^ OTID,
// substructures ordered by PID % 24.

const GEN3_ORDERS = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'];

export function parsePk3(d, T) {
  const pid = u32le(d, 0);
  const otId = u32le(d, 4);
  if (!pid && !otId) return null;
  const key = (pid ^ otId) >>> 0;
  const data = new Uint8Array(48);
  for (let i = 0; i < 48; i += 4) {
    const v = (u32le(d, 32 + i) ^ key) >>> 0;
    data[i] = v & 0xff;
    data[i + 1] = (v >>> 8) & 0xff;
    data[i + 2] = (v >>> 16) & 0xff;
    data[i + 3] = (v >>> 24) & 0xff;
  }
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + u16le(data, i)) & 0xffff;
  let order = GEN3_ORDERS[pid % 24];
  if (sum !== u16le(d, 28)) {
    // Unbound keeps the data block as it is: not encrypted, the substructures always in the order Growth, Attacks, EVs,
    // Misc, and no checksum (0). Taken only from an expanded engine and only when the block reads as one that way.
    if (!T.expanded3 || !plainPk3(d, T)) return { bad: true };
    data.set(d.subarray(32, 80));
    order = 'GAEM';
  }
  const sub = (ch) => data.subarray(order.indexOf(ch) * 12, order.indexOf(ch) * 12 + 12);
  const G = sub('G');
  const A = sub('A');
  const M = sub('M');
  // (newer pokeemerald-expansion builds keep the Tera type in the top 5 bits: species:11, teraType:5 – Too Many
  // Types 2's Chimchar reads 0x5986 = 390 | 11 << 11)
  const internal = T.expanded3 ? u16le(G, 0) & 0x7ff : u16le(G, 0);
  const species = T.idx3?.[internal] || (T.fake3?.[internal] ? FAKEMON + internal : 0);
  if (!species) return null;
  const origins = u16le(M, 2);
  const ivs = u32le(M, 4);
  const shiny = isShiny(pid, otId, T);
  const item = u16le(G, 2);
  const moves = [u16le(A, 0), u16le(A, 2), u16le(A, 4), u16le(A, 6)];
  return {
    key: `g3-${pid.toString(16).padStart(8, '0')}-${otId.toString(16)}`,
    pid, species, nickname: decodeText(d.subarray(8, 18), T.cs3, 0xff), item,
    // (an expanded engine that numbers its moves its own way: the National numbers, a move the app doesn't know left out)
    moves: (T.moves3 ? moves.map((m) => T.moves3[m] || 0) : moves).filter(Boolean),
    // the egg flag: bit 30 of the IV word in the retail games. Expanded engines moved the IVs (Run & Bun keeps them at
    // bits 1–30, so bit 30 is the top of the Sp. Def IV – every second Pokémon read as an egg and was never filed as a
    // catch); the copy in the plain header (BoxPokemon +0x13 bit 2, set together with it by SetBoxMonData) is the same
    // in every engine
    metLocation: M[1], metLevel: origins & 0x7f, isEgg: T.expanded3 ? !!(d[0x13] & 4) : !!(ivs & 0x40000000), shiny,
    status: u32le(d, 80) & 0xff, level: d[84], hp: u16le(d, 86), maxHp: u16le(d, 88),
    // an expanded engine numbers its items its own way: the retail item names would be wrong ones – the game's own name
    // goes along where the ROM's item table is known
    ...(T.expanded3 ? { itemOwn: true, ...(item && T.items3?.[item] ? { itemName: T.items3[item] } : {}) } : {}),
  };
}

/**
 * A data block stored unencrypted (Unbound): checksum 0, the "has species" flag set and no Bad Egg flag, a species the
 * ROM names, an experience no growth rate passes (1,640,000 is the most), PP within what PP Ups allow (64) and a first
 * move. An encrypted block read that way passes all of it about never.
 */
function plainPk3(d, T) {
  if (u16le(d, 28) !== 0 || (d[0x13] & 3) !== 2) return false;
  const sp = u16le(d, 32) & 0x7ff;
  if (!T.idx3?.[sp] && !T.fake3?.[sp]) return false;
  if (u32le(d, 36) > 1640000 || !u16le(d, 44)) return false;
  for (let o = 52; o < 56; o++) if (d[o] > 64) return false;
  return true;
}

function gen3StatsOk(d, isEgg) {
  for (let o = 88; o < 100; o += 2) {
    const v = u16le(d, o);
    if (v > 999) return false;
  }
  return true;
}

/**
 * An expanded GBA engine (entry.scan3): gPlayerParty isn't at the base game's address. Searched for in EWRAM – the
 * party count byte 3 bytes before `count` valid 100-byte structs (checksums) – and remembered while it holds; Run & Bun
 * keeps it at 0x02023A98 (count 0x02023A95), gEnemyParty 600 bytes on, as in the base game.
 * Newer pokeemerald-expansion builds keep the count elsewhere and gEnemyParty in front of the player's (Too Many
 * Types 2: gEnemyParty 0x02032A3C, gPlayerParty 0x02032C94, the count at 0x02032715 – measured). For them the ROM's
 * code names the pair (`entry.party3At` = romloc.mjs gen3MapTable `party3`: the two addresses 600 bytes apart that
 * the code loads most often, the player's the busier one) and the team is the valid structs from its start on.
 * Complete FireRed Upgrade (Unbound, Radical Red) keeps FireRed's RAM layout: its team is at the base game's addresses
 * (`entry.partyAddr`, the count at `entry.partyCountAddr`), which are tried first. There the count byte sits 3 bytes in
 * front of gEnemyParty – the search below would take the opponent's party for the player's, so it skips that address.
 * state.party3 = the player's party, state.enemy3 = the opponent's, state.count3 = where the count is (null: counted).
 */
const validPk3 = (m) => m && !m.bad && m.level >= 1 && m.level <= 100 && m.maxHp >= 1 && m.hp <= m.maxHp;

/**
 * The run of valid structs at `o` in `ram` (no PID twice) and whether the slots after it are empty. `state` (the
 * party poll's): an invalid slot with the very same bytes for several polls is a Bad Egg, not a write in progress –
 * it counts as a slot (readGen3 skips it) instead of freezing the team as "torn" for good.
 */
function pk3Run(ram, o, T, state = null) {
  const pids = [];
  let n = 0;
  for (; n < 6; n++) {
    const d = ram.subarray(o + n * 100, o + n * 100 + 100);
    const pid = u32le(d, 0);
    if (!pid && !u32le(d, 4)) break;
    const m = parsePk3(d, T);
    // (a struct the game is writing right now, or a slot shown twice while the menu swaps two: torn, read again)
    if (!validPk3(m) || pids.includes(pid)) {
      if (state && !pids.includes(pid) && m?.bad) {
        const sig = Array.prototype.join.call(d.subarray(0, 32), ',');
        const seen = state.runBad || (state.runBad = {});
        seen[n] = seen[n]?.sig === sig ? { sig, n: seen[n].n + 1 } : { sig, n: 1 };
        if (seen[n].n >= 3) {
          pids.push(pid);
          continue;
        }
      }
      return { n: 0, empty: false, torn: true };
    }
    if (state?.runBad) delete state.runBad[n]; // a good read: a Bad Egg there has to be seen three times anew
    pids.push(pid);
  }
  let empty = true;
  for (let i = n; i < 6; i++) if (ram.subarray(o + i * 100, o + i * 100 + 8).some((b) => b)) empty = false;
  return { n, empty };
}

function findGen3Party(read, T, state, hint = null, base = null) {
  const teamOf = (ram, o, n) => {
    if (n < 1 || n > 6) return false;
    for (let i = 0; i < n; i++) {
      const m = parsePk3(ram.subarray(o + i * 100, o + i * 100 + 100), T);
      if (!validPk3(m)) return false;
    }
    return true;
  };
  const okAt = (ram, o) => teamOf(ram, o, ram[o - 3]);
  // a count byte of its own (the base game's place) and as many structs behind it (a Bad Egg among them counts, pk3Run)
  const okBase = (count, party) => {
    const n = read(count, 1)?.[0];
    const b = read(party, 600);
    if (!b || !(n >= 1 && n <= 6)) return false;
    const r = pk3Run(b, 0, T, state);
    return !r.torn && r.n === n;
  };
  if (state.party3) {
    if (state.count3 === null) {
      // (a static array: kept unless it holds no team any more – a torn read is read again by readGen3)
      const b = read(state.party3, 600);
      const r = b ? pk3Run(b, 0, T) : null;
      if (r && (r.n >= 1 || r.torn)) return state.party3;
    } else if (state.count3 !== state.party3 - 3) {
      // (the base game's static array, found with a whole team: kept while its count byte makes sense – a struct the
      // game is writing is read again by readGen3, a Bad Egg skipped there)
      const n = read(state.count3, 1)?.[0];
      if (n >= 1 && n <= 6) return state.party3;
    } else {
      const b = read(state.party3 - 4, 4 + 600);
      if (b && okAt(b, 4)) return state.party3;
    }
  }
  if (state.lastScan3 && Date.now() - state.lastScan3 < 3000) return null;
  state.lastScan3 = Date.now();
  if (base?.party && base.count && okBase(base.count, base.party)) {
    Object.assign(state, { count3: base.count, enemy3: base.enemy || base.party + 600 });
    return (state.party3 = base.party);
  }
  const ram = read(0x02000000, 0x40000);
  if (!ram) return null;
  for (let o = 4; o + 600 <= ram.length; o += 4) {
    if (ram[o] === 0 && ram[o + 1] === 0 && ram[o + 2] === 0 && ram[o + 3] === 0) continue;
    if (base?.enemy === 0x02000000 + o) continue; // (FireRed's gEnemyParty, 3 bytes after the player's count)
    if (okAt(ram, o)) {
      // gEnemyParty: where the code names it next to this party (Modern Emerald keeps another party array between the
      // two), else right behind it as in the base game
      const at = 0x02000000 + o;
      Object.assign(state, { count3: at - 3, enemy3: hint?.player === at && hint.enemy ? hint.enemy : at + 600 });
      return (state.party3 = at);
    }
  }
  // no count byte in front of a team: the pair the ROM's code names, if its player half holds a team (and nothing
  // after it – a run of structs that goes on is some other array)
  const at = hint?.player;
  if (at >= 0x02000000 && at + 600 <= 0x02040000) {
    const r = pk3Run(ram, at - 0x02000000, T, state);
    if (r.n >= 1 && r.empty) {
      Object.assign(state, { count3: null, enemy3: hint.enemy });
      return (state.party3 = at);
    }
  }
  state.party3 = null;
  return null;
}

/** The size of the found team: the count byte, or (no count byte, see findGen3Party) its valid structs. */
function party3Count(read, T, state) {
  if (state.count3 === null) {
    const b = read(state.party3, 600);
    const r = b ? pk3Run(b, 0, T, state) : null;
    return r && !r.torn ? r.n : null; // null: torn – try again next poll
  }
  return read(state.count3 ?? state.party3 - 3, 1)?.[0] ?? 0;
}

/**
 * The memory-table entry for an expanded Gen 3 engine (Run & Bun, Too Many Types …): its team is searched for (scan3),
 * with the ROM's own hints from romloc.mjs gen3MapTable `maps3` – the party pair its code names and gMain, whose
 * battle flag (+0x439, bit 1) moved in newer builds (Too Many Types 2: gMain 0x03004084 instead of 0x030022C0).
 */
export function expandedEntry(entry, maps3 = null, items = null) {
  const out = { ...entry, scan3: true, party3At: maps3?.party3 || null, flags3: maps3?.flags3 || null };
  // a build that kept the base game's save data: the retail species and items (a decomp hack with moved RAM, `moved`),
  // or an Emerald build whose own item table still numbers Poké Ball 4 and Rare Candy 68 (Modern Emerald – Run & Bun and
  // pokeemerald-expansion renumber them, Complete FireRed Upgrade moved the bag and packs the PC). Its bag and PC boxes
  // sit where the base game keeps them in its save blocks – reached through the save block pointers the place reader
  // found (cheats.mjs, readBoxesGen3). `items3Max`: the highest item number the game knows (bag check).
  const name = (i) => String(items?.[i] || '').toUpperCase().replace('É', 'E');
  if (maps3?.moved || (/^emerald_/.test(String(entry.id)) && name(4) === 'POKE BALL' && name(68) === 'RARE CANDY')) {
    out.retail3 = true;
    if (items?.length > 1) out.items3Max = items.length - 1;
  }
  // the base game's addresses: tried first (Complete FireRed Upgrade kept them), checked like any other place
  if (entry.partyAddr && entry.partyCountAddr) out.party3Base = { party: hex(entry.partyAddr), count: hex(entry.partyCountAddr), enemy: entry.enemyPartyAddr ? hex(entry.enemyPartyAddr) : null };
  if (maps3?.gMain && entry.inBattle) out.inBattle = { ...entry.inBattle, addr: `0x${(maps3.gMain + 0x439).toString(16)}` };
  return out;
}

function readGen3(entry, read, T, state = {}) {
  let count;
  if (entry.scan3) {
    const at = findGen3Party(read, T, state, entry.party3At, entry.party3Base);
    if (!at) return null;
    count = party3Count(read, T, state);
    if (count === null) return { torn: true };
    entry = { ...entry, partyAddr: `0x${at.toString(16)}` };
  } else {
    const c = read(hex(entry.partyCountAddr), 1);
    if (!c) return null;
    count = c[0];
  }
  if (count > 6) return { invalid: true };
  const raw = read(hex(entry.partyAddr), entry.structSize * count);
  if (!raw) return null;
  let party = [];
  for (let i = 0; i < count; i++) {
    const slot = raw.subarray(i * 100, i * 100 + 100);
    const m = parsePk3(slot, T);
    if (!m) continue;
    if (m.bad) {
      // A checksum mismatch is normally a read while the game writes the struct ("torn") – try again next poll.
      // The very same bytes failing for several polls is a Bad Egg: skip that slot instead of stopping tracking.
      // (one counter per slot: two Bad Eggs at once don't reset each other)
      const sig = Array.prototype.join.call(slot.subarray(0, 32), ',');
      const seen = state.bad3 || (state.bad3 = {});
      seen[i] = seen[i]?.sig === sig ? { sig, n: seen[i].n + 1 } : { sig, n: 1 };
      if (seen[i].n < 3) return { torn: true };
      continue;
    }
    if (m.level < 1 || m.level > 100 || m.hp > m.maxHp) return { invalid: true };
    // Level, HP and stats (80-99) are neither encrypted nor checksummed: a slot the party menu is swapping reads as
    // one mon with the other's numbers – or the same mon twice. Stats over 999 or a duplicate: try again next poll.
    if (party.some((x) => x.pid === m.pid) || !gen3StatsOk(slot, m.isEgg)) return { torn: true };
    if (state.bad3) delete state.bad3[i]; // a good read: a Bad Egg there has to be seen three times anew
    party.push(m);
  }
  const lent = entry.scan3 ? null : lentParty3(entry, read, T, party);
  if (lent?.torn) return { torn: true };
  if (lent) party = lent;
  const badges = party.length ? gen3Badges(entry, read, T, state, party) : undefined;
  const boxes = party.length ? readBoxesGen3(entry, read, T, state) : null;
  return { party, ...(boxes ? { boxes } : {}), ...(badges === undefined ? {} : { badges }) };
}

/** Wally's Zigzagoon as his catching tutorial creates it in the first party slot (pokeemerald LoadWallyZigzagoon). */
const wallyZigzagoon = (m) => !!m && m.species === 263 && m.level === 7 && m.metLevel === 7 && m.metLocation === 7 && m.moves.length === 1 && m.moves[0] === 33;

/**
 * The player's own team while a script has lent the party out. Wally's catching tutorial puts his Zigzagoon (Lv. 7, met
 * at Lv. 7 in Petalburg City – MAPSEC 7 –, Tackle only) into the first party slot from before the battle until after it
 * (pokeemerald LoadWallyZigzagoon, pokeruby PutZigzagoonInPlayerParty), and FireRed/LeafGreen's Teachy TV replaces the
 * whole party with the Poké Dude's for its battles (InitPokedudePartyAndOpponent, which sets gBattleTypeFlags to
 * BATTLE_TYPE_POKEDUDE with it). Either way the script saved the real team to SaveBlock1 first (SavePlayerParty:
 * playerPartyCount/playerParty – Emerald and Ruby/Sapphire +0x234/+0x238, FireRed/LeafGreen +0x34/+0x38) and loads it
 * back afterwards: read it from there, so the borrowed Pokémon is never filed as a catch and the team doesn't seem to
 * vanish. → the saved team, { torn } while it can't be read (the last team stays), or null (nothing lent).
 */
function lentParty3(entry, read, T, party) {
  const id = String(entry.id || '');
  const fam = /^(ruby|sapphire)_us/.test(id) ? 'rs' : /^emerald_/.test(id) ? 'e' : frlg3(entry) ? 'frlg' : null;
  if (!fam || !party.length) return null;
  let lent = false;
  if (fam !== 'frlg') lent = wallyZigzagoon(party[0]);
  else if (entry.battleTypeFlagsAddr) {
    const f = read(hex(entry.battleTypeFlagsAddr), 4);
    lent = !!f && !!(u32le(f, 0) & 0x10000);
  }
  if (!lent) return null;
  const L = GBA_FLAGS[fam];
  let sb1 = L.sb1;
  if (!sb1) {
    const p = read(entry.saveBlockPtrs?.sb1 ? hex(entry.saveBlockPtrs.sb1) : L.sb1Ptr, 4);
    sb1 = p ? u32le(p, 0) : 0;
  }
  if (!(sb1 >= 0x02000000 && sb1 < 0x02040000)) return { torn: true };
  const at = sb1 + (fam === 'frlg' ? 0x34 : 0x234);
  const n = read(at, 1)?.[0];
  if (!(n >= 1 && n <= 6)) return { torn: true };
  const raw = read(at + 4, n * 100);
  const saved = [];
  for (let i = 0; raw && i < n; i++) {
    const m = parsePk3(raw.subarray(i * 100, i * 100 + 100), T);
    if (!m || m.bad || m.level < 1 || m.level > 100 || m.hp > m.maxHp || saved.some((x) => x.pid === m.pid)) return { torn: true };
    saved.push(m);
  }
  if (!raw) return { torn: true };
  if (fam !== 'frlg') return saved[0].pid !== party[0].pid ? saved : null;
  // the Poké Dude's party has none of the player's Pokémon (the flag stays set after the battle, when the team is back)
  return party.some((m) => saved.some((x) => x.pid === m.pid)) ? null : saved;
}

/**
 * Gen 3 PC boxes: PokemonStorage { u8 currentBox; BoxPokemon boxes[14][30]; … } – 80-byte structs, encrypted and
 * checksummed like the first 80 bytes of a party struct, an empty slot all zeros. Ruby/Sapphire (English and German)
 * keep it at a fixed place, Emerald and FireRed/LeafGreen behind gPokemonStoragePtr, right after the two save block
 * pointers (pret .sym files; the German, French, Italian and Spanish FireRed/LeafGreen: 0x03004F60, pokebot-gen3's
 * language patches). Without it a catch the game sent to the PC (full party) wasn't seen until it joined the team.
 * Only the retail engines and builds that kept their save data (expandedEntry `retail3`, every slot must read): an
 * expanded one may have moved, grown or packed the boxes. Read every 2.5 s at most (like Gen 4);
 * null when the block doesn't read as a PC – mostly failed checksums is a wrong place, not a PC full of Bad Eggs.
 */
const GBA_STORAGE = { rs: { at: 0x020300a0 }, e: { ptr: 0x03005d94 }, frlg: { ptr: 0x03005010 } };
/**
 * How many boxes a hack's PC has (Modern Emerald 15): PokemonStorage goes on with a name per box (9 bytes, ended by
 * 0xFF – "BOX1" …) and a wallpaper per box. The first count from 14 on whose names and wallpapers read as such – the
 * names of a wrong count land in the boxes' encrypted or empty slots. null: none.
 */
function boxCount3(read, at) {
  for (let n = 14; n <= 24; n++) {
    const o = at + 4 + n * 30 * 80;
    if (o + n * 10 > 0x02040000) return null;
    const b = read(o, n * 10);
    if (!b) return null;
    let ok = true;
    for (let k = 0; k < n && ok; k++) {
      const name = b.subarray(k * 9, k * 9 + 9);
      const end = name.indexOf(0xff);
      ok = end >= 1 && name[0] !== 0 && name.subarray(0, end).every((c) => c < 0xf7); // (0x00: a space)
    }
    if (ok && b.subarray(n * 9, n * 10).every((w) => w < 32)) return n;
  }
  return null;
}
function readBoxesGen3(entry, read, T, state) {
  // (a build that kept the retail save data – expandedEntry `retail3` – keeps gPokemonStoragePtr right after the save
  // block pointers, as found by the place reader)
  const kept = entry.scan3 && entry.retail3;
  if ((entry.scan3 || T.expanded3) && !kept) return null;
  if (kept && !state.sb1PtrAddr) return null;
  const id = String(entry.id || '');
  const L = kept ? { ptr: state.sb1PtrAddr + 8 } : GBA_STORAGE[/^(ruby|sapphire)_(us|de)$/.test(id) ? 'rs' : /^emerald_/.test(id) ? 'e' : /^(firered|leafgreen)_/.test(id) ? 'frlg' : ''];
  if (!L) return null;
  const now = Date.now();
  if (state.box3 && now - state.box3At < 2500) return state.box3;
  let at = L.at;
  if (!at) {
    const p = read(entry.saveBlockPtrs?.sb2 && !kept ? hex(entry.saveBlockPtrs.sb2) + 4 : L.ptr, 4);
    at = p ? u32le(p, 0) : 0;
  }
  if (!(at >= 0x02000000 && at < 0x02040000)) return null;
  const n = kept ? state.box3N || boxCount3(read, at) : 14;
  if (!n) return null;
  if (kept) state.box3N = n;
  const slots = n * 30;
  const len = 4 + slots * 80;
  if (!(at >= 0x02000000 && at + len <= 0x02040000)) return null;
  const raw = read(at, len);
  if (!raw || raw[0] >= n) return null; // currentBox
  const boxes = [];
  const buf = new Uint8Array(100); // parsePk3 reads a party struct: the box part, zeros for level / HP / stats
  let bad = 0;
  for (let i = 0; i < slots; i++) {
    const o = 4 + i * 80;
    const slot = raw.subarray(o, o + 80);
    if (slot.every((x) => x === 0)) continue;
    buf.fill(0);
    buf.set(slot);
    const m = parsePk3(buf, T);
    // (a hack's PC: every slot must read, or the boxes aren't what they seem – a Pokémon missing from them would be
    // reported as released)
    if (!m && kept) return null;
    if (!m) continue;
    if (m.bad) {
      bad++;
      continue;
    }
    boxes.push({ ...m, status: 0, box: Math.floor(i / 30), slot: i % 30, level: null, hp: null, maxHp: null });
  }
  if ((bad > 20 && boxes.length < bad) || (kept && bad)) return null;
  state.box3 = boxes;
  state.box3At = now;
  return boxes;
}

/**
 * Gen 3 badges: the badge flags in SaveBlock1's flag array (Ruby/Sapphire keep SaveBlock1 at a fixed place, Emerald
 * and FireRed/LeafGreen behind a pointer in IWRAM – the other-language FireRed/LeafGreen's in addresses.json). The
 * badge flags are the base game's, or the ones the ROM's own leader scripts set (romcaps.mjs, LiveTables.withRom); an
 * expanded engine only with those, its save block pointers as the place reader found them. Trusted only while
 * SaveBlock2's trainer ID is the one of a Pokémon in the team and "has a Pokémon" (FLAG_SYS_POKEMON_GET, 7 before the
 * badges in Ruby/Sapphire/Emerald, 8 after them in FireRed/LeafGreen) is set. German Ruby/Sapphire keep their RAM
 * elsewhere (their team 0x10 further on) and weren't checked: no badges there.
 */
const GBA_FLAGS = {
  rs: { sb1: 0x02025734, sb2: 0x02024ea4, flags: 0x1220, badge: 0x807, sys: -7 },
  e: { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, flags: 0x1270, badge: 0x867, sys: -7 },
  frlg: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, flags: 0xee0, badge: 0x820, sys: 8 },
};
function gen3Badges(entry, read, T, state, party) {
  const id = String(entry.id || '');
  if (/^(ruby|sapphire)_(?!us)/.test(id)) return undefined;
  const L = GBA_FLAGS[/^(ruby|sapphire)_/.test(id) ? 'rs' : /^emerald_/.test(id) ? 'e' : /^(firered|leafgreen)_/.test(id) ? 'frlg' : ''];
  if (!L) return undefined;
  const badge = T.badges3 ?? (entry.scan3 ? null : L.badge);
  if (badge === null || badge === undefined) return undefined;
  const ptr = (a) => {
    const p = read(a, 4);
    return p ? u32le(p, 0) : 0;
  };
  let sb1 = L.sb1;
  let sb2 = L.sb2;
  // an engine whose team is searched for: SaveBlock1's flags where its code says (romloc.mjs gen3FlagsAt – Modern
  // Emerald 0x1364), its save block pointers where the place reader found them (or the code names them)
  const found = entry.scan3 ? state.sb1PtrAddr || entry.flags3?.sb1Ptr || null : null;
  const flagsAt = entry.scan3 && entry.flags3?.flags ? entry.flags3.flags : L.flags;
  if (!sb1) {
    const at = entry.saveBlockPtrs?.sb1 ? hex(entry.saveBlockPtrs.sb1) : found || L.sb1Ptr;
    const at2 = entry.saveBlockPtrs?.sb2 ? hex(entry.saveBlockPtrs.sb2) : found ? found + 4 : L.sb2Ptr;
    sb1 = ptr(at);
    sb2 = ptr(at2);
  }
  const ram = (a) => a >= 0x02000000 && a < 0x02040000;
  if (!ram(sb1) || !ram(sb2)) return undefined;
  // SaveBlock2.playerTrainerId (+0x0A): one of the team's own Pokémon has it as its OT ID
  const tid = read(sb2 + 0x0a, 4);
  const ot = tid ? u32le(tid, 0).toString(16) : null;
  if (!ot || !party.some((m) => m.key?.split('-')[2] === ot)) return undefined;
  const flag = (f) => {
    const b = read(sb1 + flagsAt + (f >> 3), 1);
    return b ? (b[0] >> (f & 7)) & 1 : null;
  };
  if (flag(badge + L.sys) !== 1) return undefined;
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const f = flag(badge + i);
    if (f === null) return undefined;
    n += f;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Gen 4 / 5 (DS): party inside the heap-allocated save buffer. Prefer the pointer from the
// decomp linker maps; fall back to scanning main RAM for PartyCore { 6, count, mons[6] }.

// Gen 4/5 status word (pokeheartgold include/constants/battle.h): sleep turns (bits 0-2), or one of poison, burn,
// freeze, paralysis, or toxic (bit 7) with its counter in bits 8-11.
const statusOk = (s) => s === 0 || (s & ~7) === 0 || s === 8 || s === 16 || s === 32 || s === 64 || ((s & ~0xf80) === 0 && !!(s & 0x80));

/**
 * Gen 5 stores the status condition as a number, not as Gen 3/4's bits (PKHeX StatusType: 1 paralysis, 2 sleep,
 * 3 freeze, 4 burn, 5 poison – no sleep turns, and bad poison is plain poison outside battle). Read as bits, every one
 * of them has a "sleep counter" (1–7): every Pokémon with a status showed SLP. → the Gen 3/4 bits the app reads
 * everywhere (sleep as one turn), 0 for anything else.
 */
export const gen5Status = (s) => [0, 0x40, 1, 0x20, 0x10, 0x08][s & 0xff] ?? 0;

/**
 * The battle stats block of a party mon (0x88-0xEB) is not covered by the checksum. GetMonData/SetMonData decrypt
 * a mon in place – the battle stats first, then the box block – and encrypt it again afterwards, without setting the
 * lock flags (pokeheartgold src/pokemon.c GetMonData: DECRYPT_PTY, DECRYPT_BOX, …, ENCRYPT_PTY, ENCRYPT_BOX). The
 * game calls that all the time (menus, the walking Pokémon, battle UI), and a read that lands between the two
 * steps has a valid checksum but plaintext battle stats, which our decryption turns into garbage: "Lv. 172" with a
 * random HP bar, or 0 HP (a death that never happened). The block is decrypted from its first word on, so a torn
 * block always starts with a garbage status word – that, the level range and HP <= max HP give it away.
 */
function battleStatsOk(d, isEgg) {
  if (!statusOk(u32le(d, 0x88))) return false;
  const level = d[0x8c];
  const hp = u16le(d, 0x8e);
  const maxHp = u16le(d, 0x90);
  // Max HP and the five other stats (0x90-0x9B) never pass 999. A struct the game is copying (party menu swap, a
  // catch joining) or encrypting again reads as another mon's or plain words from somewhere in that range: a
  // "Max HP 18542" that took the HP bar with it.
  for (let o = 0x90; o < 0x9c; o += 2) {
    const v = u16le(d, o);
    if (v > 999) return false;
  }
  if (isEgg) return level <= 100 && hp <= maxHp;
  return level >= 1 && level <= 100 && maxHp > 0 && hp <= maxHp;
}

function pkMon(raw, gen, T) {
  const { data: d, checksumOk } = decryptPK4(raw);
  if (!checksumOk) return null;
  const species = u16le(d, 0x08);
  if (!species || species > 649) return null;
  if (raw.length > 136 && !battleStatsOk(d, !!(u32le(d, 0x38) & 0x40000000))) return null;
  const pid = u32le(d, 0);
  const tid = u16le(d, 0x0c);
  const sid = u16le(d, 0x0e);
  const iv32 = u32le(d, 0x38);
  let nickname = '';
  for (let i = 0; i < 11; i++) {
    const c = u16le(d, 0x48 + i * 2);
    if (c === 0xffff || c === 0) break;
    nickname += gen === 5 ? String.fromCharCode(c) : T.gen4?.chars?.[c] ?? '';
  }
  const metExt = u16le(d, 0x46);
  const metLocation = gen === 5 ? u16le(d, 0x80) : metExt || u16le(d, 0x80);
  // where the egg came from (0: not from an egg) – Platinum/HGSS's own places in the extended field, like the met place
  const eggLocation = gen === 5 ? u16le(d, 0x7e) : u16le(d, 0x44) || u16le(d, 0x7e);
  return {
    key: `${pid.toString(16).padStart(8, '0')}-${tid}-${sid}`,
    pid, species, nickname, isEgg: !!(iv32 & 0x40000000), item: u16le(d, 0x0a),
    moves: [u16le(d, 0x28), u16le(d, 0x2a), u16le(d, 0x2c), u16le(d, 0x2e)].filter(Boolean),
    metLocation, eggLocation, metLevel: d[0x84] & 0x7f, gender: ['M', 'F', '-'][(d[0x40] >> 1) & 3],
    shiny: isShiny(pid, ((sid << 16) | tid) >>> 0, T),
    status: gen === 5 ? gen5Status(d[0x88]) : d[0x88], level: d[0x8c], hp: u16le(d, 0x8e), maxHp: u16le(d, 0x90),
    // the alternate form (+0x40 bits 3–7: Rotom's appliances, Wormadam's cloaks, Shaymin's Sky Forme … – shared/forms.mjs)
    ...(d[0x40] >> 3 ? { form: d[0x40] >> 3 } : {}),
  };
}

function readPartyCore(read, addr, size, gen, T) {
  const head = read(addr, 8);
  if (!head) return null;
  const count = u32le(head, 4);
  if (count < 1 || count > 6) return null;
  const raw = read(addr + 8, size * count);
  if (!raw) return null;
  const party = [];
  for (let i = 0; i < count; i++) {
    const m = pkMon(raw.subarray(i * size, (i + 1) * size), gen, T);
    // the same mon twice: read halfway through a swap in the party menu (the copy is done, the old slot not yet)
    if (!m || party.some((x) => x.pid === m.pid)) return null;
    party.push(m);
  }
  return party;
}

/** Scan 4 MB of DS main RAM for PartyCore structs; returns candidate bus addresses. */
export function scanPartyCore(ram, size, gen, T, { limit = 8 } = {}) {
  const hits = [];
  for (let o = 0; o + 8 + size <= ram.length && hits.length < limit; o += 4) {
    const cap = u32le(ram, o);
    if (gen === 4 && cap !== 6) continue;
    const count = u32le(ram, o + 4);
    if (count < 1 || count > 6) continue;
    if (gen === 5 && cap !== 6 && cap !== 0) continue;
    const m = pkMon(ram.subarray(o + 8, o + 8 + size), gen, T);
    if (!m) continue;
    hits.push(0x02000000 + o);
  }
  return hits;
}

function readDS(entry, read, T, state) {
  const gen = entry.gen;
  const size = gen === 5 ? 220 : 236;
  // 1) known location (decomp linker map pointer / static address / community pointer)
  let core = null;
  if (entry.saveDataPtrAddr) {
    // ROM hacks can move .bss: derive the pointer from the NitroSDK module params like Ironmon
    // does (*(0x02000BA8)+0x20 on HGSS/Pt, *(0x02000B70)+0x20 on DP); fall back to the fixed one.
    let ptrAddr = hex(entry.saveDataPtrAddr);
    const isDP = /^(diamond|pearl)/.test(entry.id);
    const mp = read(isDP ? 0x02000b70 : 0x02000ba8, 4);
    const mpv = mp ? u32le(mp, 0) : 0;
    if (mpv >= 0x02000000 && mpv < 0x02400000 && Math.abs(mpv + 0x20 - ptrAddr) < 0x40000) ptrAddr = mpv + 0x20;
    const p = read(ptrAddr, 4);
    const base = p ? u32le(p, 0) : 0;
    if (base >= 0x02000000 && base < 0x02400000) {
      state.saveBase = base;
      core = base + hex(entry.partyMonsOffset || '0xA8') - 8;
    }
  } else if (entry.partyPtrAddr) {
    const p = read(hex(entry.partyPtrAddr), 4);
    if (p) core = 0x02000000 + (u32le(p, 0) & 0xffffff) + hex(entry.partyMonsOffsetFromPtr) - 8;
  } else if (entry.partyAddr) {
    core = hex(entry.partyAddr) - 8;
  }
  if (core && !state.noPointer) {
    const party = readPartyCore(read, core, size, gen, T);
    if (party) {
      state.partyAddr = core;
      state.ptrOk = true;
      return dsResult(entry, read, T, state, party);
    }
    // The pointer has worked in this session, so the layout is right and the party is just not there right
    // now (title screen after a soft reset, save being reloaded). Scanning would grab whatever PartyCore is
    // left in RAM – a stale battle copy or the last opponent's party – and report it as the player's team.
    if (state.ptrOk) {
      state.partyAddr = null;
      return null;
    }
  }
  // 2) remembered address from a previous scan
  if (state.partyAddr) {
    const party = readPartyCore(read, state.partyAddr, size, gen, T);
    if (party) return scannedResult(entry, read, T, state, party, size);
    state.partyAddr = null;
  }
  // 3) full scan (throttled by the caller)
  if (state.lastScan && Date.now() - state.lastScan < 3000) return null;
  state.lastScan = Date.now();
  const ram = read(0x02000000, 0x400000);
  if (!ram) return null;
  const hits = scanPartyCore(ram, size, gen, T);
  if (!hits.length) return null;
  // The canonical party is the lowest stable hit; battle copies come and go.
  state.partyAddr = hits[0];
  const party = readPartyCore(read, state.partyAddr, size, gen, T);
  if (!party) return null;
  return scannedResult(entry, read, T, state, party, size);
}

/** Party, PC boxes and badges of a DS game whose party was found at state.partyAddr. */
function dsResult(entry, read, T, state, party) {
  if (entry.gen === 5) {
    const boxes = readBoxesGen5(entry, read, T, state, party);
    return { party, ...(boxes ? { boxes } : {}), badges: readBadgesGen5(entry, read, state, party) };
  }
  return { party, boxes: readBoxesGen4(entry, read, T, state), badges: readBadgesGen4(entry, read, state, party) };
}

/**
 * A party found by scanning (the game's other languages – their static data sits elsewhere, so the English pointer
 * doesn't apply – or the pointer not working yet). Gen 4: the save data, and with it the badges and the PC, is found
 * from there (saveBaseFromScan); when the scan had settled on a copy of the party, the save's own party is taken.
 */
function scannedResult(entry, read, T, state, party, size) {
  if (entry.gen !== 4) return dsResult(entry, read, T, state, party);
  const base = saveBaseFromScan(entry, read, state, party);
  const own = base ? base + hex(entry.partyMonsOffset) - 8 : 0;
  if (own && own !== state.partyAddr) {
    const saved = readPartyCore(read, own, size, entry.gen, T);
    if (saved) {
      state.partyAddr = own;
      return dsResult(entry, read, T, state, saved);
    }
  }
  return dsResult(entry, read, T, state, party);
}

/**
 * The save data of a Gen 4 game whose party was found by scanning (every language but English): the party in the save
 * image sits a fixed step after the start of the SaveData (addresses.json partyMonsOffset), so the save data is where
 * the party is – or where Ironmon's module-params pointer leads (*(0x02000BA8)+0x20 on HGSS/Pt, *(0x02000B70)+0x20 on
 * DP), which also finds it when the scan settled on a copy of the party (a battle's). A place counts once the trainer in
 * its general block (TID/SID) owns a Pokémon of the team, or the pointer leads to the very party that was found.
 * Without that, no save data: badges and the PC stay unknown rather than read from the wrong place. Set as
 * state.saveBase (the badges, the PC, the battle structs and the bag go from there); returns it, or 0.
 */
function saveBaseFromScan(entry, read, state, party) {
  state.saveBase = 0;
  if (!entry.partyMonsOffset || !state.partyAddr) return 0;
  const mons = hex(entry.partyMonsOffset) - 8;
  const fromParty = state.partyAddr - mons;
  const mp = read(/^(diamond|pearl)/.test(entry.id) ? 0x02000b70 : 0x02000ba8, 4);
  const mpv = mp ? u32le(mp, 0) : 0;
  const p = mpv >= 0x02000000 && mpv < 0x02400000 ? read(mpv + 0x20, 4) : null;
  const viaPointer = p ? u32le(p, 0) : 0;
  const ok = (base) => base >= 0x02000000 && base + mons < 0x02400000;
  let base = 0;
  if (ok(fromParty) && (viaPointer === fromParty || ownsTeam(entry, read, fromParty, party))) base = fromParty;
  else if (ok(viaPointer) && ownsTeam(entry, read, viaPointer, party)) base = viaPointer;
  state.saveBase = base;
  return base;
}

/** The trainer data in the general block of the save data at `base` (PKHeX Trainer1: TID +0x10, SID +0x12), or null. */
function gen4Trainer(entry, read, base) {
  const b = entry.badges;
  if (!base || !b?.trainerOffset) return null;
  return read(base + hex(b.generalOffsetFromSaveBase) + hex(b.trainerOffset), 0x20);
}

/** Is the trainer of the save data at `base` the original trainer of a Pokémon in `party`? → the trainer data, or null */
function ownsTeam(entry, read, base, party) {
  const t = gen4Trainer(entry, read, base);
  return t && party?.some((m) => m.key?.endsWith(`-${u16le(t, 0x10)}-${u16le(t, 0x12)}`)) ? t : null;
}

/**
 * Gen 4 badges sit in the trainer data of the general block of the save image in RAM, like in the .sav file (PKHeX
 * Trainer1 + 0x1A, a bit per badge; HGSS: the Kanto badges at + 0x1F). Trusted only while the trainer ID and secret
 * ID in front of them (+0x10/+0x12) are those of a Pokémon in the team.
 */
function readBadgesGen4(entry, read, state, party = null) {
  const b = entry.badges;
  const t = ownsTeam(entry, read, state.saveBase, party);
  if (!t) return undefined;
  return popcount(t[0x1a]) + (b.kantoOffset ? popcount(t[hex(b.kantoOffset) - hex(b.trainerOffset)]) : 0);
}

/**
 * Gen 5 badges: the game keeps its save blocks in RAM in the order of the .sav (the bag 0xA00 before the party block –
 * shared/live/cheats.mjs), so the "Misc" block (money u32, badge flags u8 at +4) sits a fixed step after the party
 * block: 0x21200 − 0x18E00 in Black/White, 0x21100 − 0x18E00 in Black 2/White 2 (PKHeX SaveBlockAccessor5BW/B2W2.cs,
 * Misc5.cs). Only trusted when the trainer data block (0x19400: TID/SID at +0x14) belongs to the party's own trainer –
 * a scanned copy of the party (a battle's) has neither block behind it – and the money is a real amount.
 */
const GEN5_MISC = { bw: 0x21200 - 0x18e00, b2w2: 0x21100 - 0x18e00 };
const GEN5_TRAINER = 0x19400 - 0x18e00;
function readBadgesGen5(entry, read, state, party) {
  const core = state.partyAddr;
  if (!core || !party?.length) return undefined;
  const misc = /^(black2|white2)_/.test(entry.id) ? GEN5_MISC.b2w2 : GEN5_MISC.bw;
  const tr = read(core + GEN5_TRAINER + 0x14, 4);
  if (!tr) return undefined;
  const ot = `${u16le(tr, 0)}-${u16le(tr, 2)}`;
  if (!party.some((m) => m.key?.endsWith(`-${ot}`))) return undefined;
  const b = read(core + misc, 5);
  if (!b || u32le(b, 0) > 9999999) return undefined;
  return popcount(b[4]);
}

/**
 * Gen 5 PC boxes. The game keeps its save blocks in RAM in the order of the .sav (readBadgesGen5, the bag in cheats.mjs),
 * so the boxes – PKHeX SAV5: 24 boxes of 30 stored PK5 (136 bytes) from 0x400 on, 0x1000 apart – sit 0x18A00 in front of
 * the party block (0x18E00): in Black at 0x0221BFAC, where the community's RAM maps put box 1. Without them a catch the
 * game sent to the PC (full party) wasn't seen until it was taken out, and with a full party a wild Pokémon that got
 * away was never asked about (it could have been caught unseen). Trusted like the badges – only when the trainer data
 * behind the party is the party's own trainer (a scanned battle copy has nothing behind it) – and only when it reads as
 * a PC: every slot empty or a valid Pokémon (a few torn slots aside), at least one Pokémon in it (a PC read as nothing
 * at all can't be told from a wrong place, and would report every Pokémon in it as released). Read every 2.5 s at most.
 */
const GEN5_BOXES = 0x400 - 0x18e00;
function readBoxesGen5(entry, read, T, state, party) {
  const core = state.partyAddr;
  if (!core || !party?.length) return null;
  const now = Date.now();
  if (state.box5 !== undefined && now - state.box5At < 2500) return state.box5;
  state.box5At = now;
  state.box5 = null;
  const tr = read(core + GEN5_TRAINER + 0x14, 4);
  if (!tr || !party.some((m) => m.key?.endsWith(`-${u16le(tr, 0)}-${u16le(tr, 2)}`))) return null;
  const storage = read(core + GEN5_BOXES, 24 * 0x1000);
  if (!storage) return null;
  const boxes = [];
  let bad = 0;
  for (let b = 0; b < 24; b++) {
    for (let s = 0; s < 30; s++) {
      const o = b * 0x1000 + s * 136;
      const raw = storage.subarray(o, o + 136);
      if (raw.every((x) => x === 0)) continue;
      const m = pkMon(raw, 5, T);
      if (!m) {
        // (an emptied slot is zeros encrypted: a valid checksum, species 0)
        const { data, checksumOk } = decryptPK4(raw);
        if (!(checksumOk && !u16le(data, 0x08))) bad++;
        continue;
      }
      boxes.push({ ...m, box: b, slot: s, level: null, hp: null, maxHp: null, status: 0 });
    }
  }
  if (bad > 3 || !boxes.length) return null;
  state.box5 = boxes;
  return boxes;
}

/** HGSS keeps the whole save image in RAM: storage follows the general block like in the file. */
function readBoxesGen4(entry, read, T, state) {
  if (entry.gen !== 4 || !state.saveBase) return null;
  const now = Date.now();
  if (state.boxCache && now - state.boxCacheAt < 2500) return state.boxCache;
  const general = state.saveBase + (entry.id.startsWith('platinum') ? 0x14 : entry.id.startsWith('diamond') || entry.id.startsWith('pearl') ? 0x214 : 0x10);
  const storageOffset = entry.id.startsWith('heartgold') || entry.id.startsWith('soulsilver') ? 0xf700 : entry.id.startsWith('platinum') ? 0xcf2c : 0xc100;
  const storage = read(general + storageOffset, 18 * 0x1000);
  if (!storage) return null;
  const boxSize = entry.id.startsWith('heartgold') || entry.id.startsWith('soulsilver') ? 0x1000 : 0xff0;
  const offset = entry.id.startsWith('heartgold') || entry.id.startsWith('soulsilver') ? 0 : 4;
  const boxes = [];
  let bad = 0;
  for (let b = 0; b < 18; b++) {
    for (let s = 0; s < 30; s++) {
      const o = offset + b * boxSize + s * 136;
      const raw = storage.subarray(o, o + 136);
      if (raw.every((x) => x === 0)) continue;
      const m = pkMon(raw, 4, T);
      if (!m) {
        // The game clears a slot by zeroing and *encrypting* it: valid checksum, species 0 → empty, not bad.
        // Counting those as bad made every real PC (hundreds of empty slots) look like a wrong layout.
        const { data, checksumOk } = decryptPK4(raw);
        if (checksumOk && !u16le(data, 0x08)) continue;
        bad++;
        continue;
      }
      boxes.push({ ...m, box: b, slot: s, level: null, hp: null, maxHp: null });
    }
  }
  // If the layout guess is wrong almost everything fails the checksum – then report "unknown".
  if (bad > 20 && boxes.length < bad) return null;
  state.boxCache = boxes;
  state.boxCacheAt = now;
  return boxes;
}

/**
 * Read the party of a running game.
 * @param {object} entry  addresses.json entry (findEntry)
 * @param {(addr:number,len:number)=>Uint8Array|null} read  bus-address reader
 * @param {LiveTables} T
 * @param {object} state  per-session cache (keep the same object between calls)
 * @returns {{party, boxes?}|{invalid}|{torn}|null}
 */
export function readLiveParty(entry, read, T, state = {}) {
  if (!entry) return null;
  if (entry.gen <= 2) return readGB(entry, read, T, state);
  const res = entry.gen >= 6 ? readGen67(entry, read, state) : entry.gen === 3 ? readGen3(entry, read, T, state) : readDS(entry, read, T, state);
  return res?.party && !settled(res.party, state) ? { torn: true } : res;
}

/**
 * GBA / DS: a known mon's level or max HP changes only on a level-up, an evolution or a loaded savestate. A new value
 * counts once two reads in a row agree – a read torn in some way the checks above miss is not stored (or synced to
 * the partners) as the mon's level. HP and new mons show at once.
 */
function settled(party, state) {
  const known = state.dsStats || new Map();
  const next = new Map(party.map((m) => [m.pid, `${m.level}:${m.maxHp}`]));
  const changed = party.some((m) => known.has(m.pid) && known.get(m.pid) !== next.get(m.pid));
  const sig = [...next].join();
  if (changed && state.dsPending !== sig) {
    state.dsPending = sig;
    return false;
  }
  state.dsPending = null;
  state.dsStats = next;
  return true;
}

// ---------------------------------------------------------------------------
// Battle: who is out on the other side, and the player's live HP (the party struct lags in battle,
// see research/live_ram.md §5).

const gbShiny = (dv) => {
  const atk = dv >> 12, def = (dv >> 8) & 15, spe = (dv >> 4) & 15, spc = dv & 15;
  return def === 10 && spe === 10 && spc === 10 && [2, 3, 6, 7, 10, 11, 14, 15].includes(atk);
};

function battleGB(entry, read, T, state = {}, party = null) {
  const mode = read(hex(entry.inBattle.addr), 1)?.[0];
  const e = entry.battleEnemy;
  const b = entry.liveBattleHp;
  // The battle mode is set before the transition animation, but wEnemyMon / wBattleMon are only loaded after it:
  // for the first second or two they still hold the *previous* battle (an old shiny or legendary would flash
  // again, a fainted mon's 0 HP would be folded onto whoever sits at that party index now). So remember what the
  // structs held in the overworld and ignore them in battle until they change.
  const bytes = (a, n) => {
    const x = a ? read(hex(a), n) : null;
    return x ? Array.from(x).join('.') : '';
  };
  const enemySig = [bytes(e.speciesAddr, 1), bytes(e.levelAddr, 1), bytes(e.hpAddr, 2), bytes(e.maxHpAddr, 2), bytes(e.dvsAddr, 2)].join('|');
  const activeSig = b ? [bytes(b.activePartyIndexAddr, 1), bytes(b.speciesAddr, 1), bytes(b.levelAddr, 1), bytes(b.hpAddr, 2), bytes(b.maxHpAddr, 2)].join('|') : '';
  if (mode !== 1 && mode !== 2) { // 0 overworld, 0xFF lost (Gen 1)
    if (mode === 0) state.gbStale = { enemy: enemySig, active: activeSig };
    state.gbActive = null;
    return null;
  }
  const stale = state.gbStale;
  if (stale && stale.enemy !== enemySig) stale.enemy = null; // loaded for this battle – trust it from now on
  if (stale && stale.active !== activeSig) stale.active = null;
  const tutorial = gbTutorial(entry, read, mode) ? { tutorial: true } : {};
  if (stale?.enemy) return { kind: mode === 1 ? 'wild' : 'trainer', enemy: null, active: null, ...tutorial };
  const enemyRaw = read(hex(e.speciesAddr), 1)?.[0];
  const species = entry.gen === 1 ? T.idx1?.[enemyRaw] || 0 : enemyRaw;
  const level = read(hex(e.levelAddr), 1)?.[0];
  const ehp = read(hex(e.hpAddr), 2);
  const emax = read(hex(e.maxHpAddr), 2);
  const dvs = read(hex(e.dvsAddr), 2);
  const enemy = species && species <= 251 && level >= 1 && level <= 100 && ehp && emax
    ? { species, level, hp: u16be(ehp, 0), maxHp: u16be(emax, 0), shiny: entry.gen === 2 && !!dvs && gbShiny(u16be(dvs, 0)), ...gbCatch(e, read) }
    : null;
  // half-loaded (the next trainer Pokémon being sent out): no opponent for a moment, still a battle
  const filled = enemy && enemy.maxHp > 0 && enemy.hp <= enemy.maxHp ? enemy : null;
  return { kind: mode === 1 ? 'wild' : 'trainer', enemy: filled, active: activeGB(entry, read, T, state, party, stale), ...gbBalls(entry, read, mode), ...tutorial };
}

/**
 * A wild battle that isn't the player's: the old man's catching demo in Viridian City (pokered BATTLE_TYPE_OLD_MAN 1),
 * Professor Oak catching Pikachu at the start of Yellow (pokeyellow BATTLE_TYPE_PIKACHU 4) and the Dude's catching demo
 * on Route 29 (pokecrystal/pokegold BATTLETYPE_TUTORIAL 3). wBattleType says so (addresses.json battleEnemy.battleTypeAddr).
 */
function gbTutorial(entry, read, mode) {
  const at = entry.battleEnemy?.battleTypeAddr;
  const type = mode === 1 && at ? read(hex(at), 1)?.[0] : undefined;
  if (type === undefined) return false;
  if (entry.gen === 1) return type === 1 || (type === 4 && /^yellow/.test(String(entry.id || '')));
  return type === 3;
}

/**
 * What the catch chance needs from wEnemyMon (addresses.json battleEnemy, pret .sym): its status condition
 * (wEnemyMonStatus – the low byte the Gen 3/4 readers use too: sleep turns, PSN, BRN, FRZ, PAR) and the catch rate the
 * game loaded with it (Gen 1 wEnemyMonActualCatchRate, Gen 2 wEnemyMonCatchRate – the very byte the ball formula
 * reads, so a hack's or the randomizer's catch rates come along, and the Safari Zone's bait and rocks in Gen 1).
 */
function gbCatch(e, read) {
  const st = e.statusAddr ? read(hex(e.statusAddr), 1)?.[0] : undefined;
  const rate = e.catchRateAddr ? read(hex(e.catchRateAddr), 1)?.[0] : undefined;
  return {
    ...(st !== undefined && statusOk(st) ? { status: st } : {}),
    ...(rate >= 1 ? { catchRate: rate } : {}),
  };
}

/**
 * Wild battles where no ball can be thrown, or only the Safari Ball: wBattleType (pokered BATTLE_TYPE_OLD_MAN 1 /
 * BATTLE_TYPE_SAFARI 2, pokecrystal BATTLETYPE_TUTORIAL 3 / BATTLETYPE_CONTEST 6 – the Bug-Catching Contest's Park Balls).
 */
function gbBalls(entry, read, mode) {
  const at = entry.battleEnemy?.battleTypeAddr;
  const type = mode === 1 && at ? read(hex(at), 1)?.[0] : undefined;
  if (type === undefined) return {};
  if (entry.gen === 1) return type === 2 ? { balls: 'safari' } : type === 1 ? { balls: 'none' } : {};
  return type === 3 || type === 6 ? { balls: 'none' } : {};
}

/**
 * The player's mon that is out: wCurBattleMon (Gen 2) / wPlayerMonNumber (Gen 1) is the party slot, wBattleMon its
 * battle copy with the live HP. On a switch the slot is set before wBattleMon is reloaded, so the copy must fit that
 * slot (same level and max HP – Transform keeps both). While it doesn't, the copy still belongs to the mon that was
 * out: find it in the party by species, level and max HP. Failing that, keep the last slot seen in this battle
 * (without HP – nothing gets folded onto the wrong mon), so the battle panel doesn't jump back to the lead.
 */
function activeGB(entry, read, T, state, party, stale) {
  const b = entry.liveBattleHp;
  const index = read(hex(b.activePartyIndexAddr), 1)?.[0];
  const hpB = read(hex(b.hpAddr), 2);
  const maxB = read(hex(b.maxHpAddr), 2);
  if (stale?.active || !hpB || !maxB) return null; // still the previous battle's wBattleMon
  const hp = u16be(hpB, 0);
  const maxHp = u16be(maxB, 0);
  const lv = b.levelAddr ? read(hex(b.levelAddr), 1)?.[0] : undefined;
  const raw = b.speciesAddr ? read(hex(b.speciesAddr), 1)?.[0] : undefined;
  const species = raw === undefined ? undefined : entry.gen === 1 ? T.idx1?.[raw] || 0 : raw;
  // the party struct gets the battle's status condition only when the mon leaves the field – wBattleMon has it now
  const stB = b.statusAddr ? read(hex(b.statusAddr), 1)?.[0] : undefined;
  const ok = hp <= maxHp && maxHp > 0;
  const fits = (p) => !!p && (lv === undefined || p.level === lv) && (!p.maxHp || p.maxHp === maxHp);
  let found = null;
  if (ok && index !== undefined && index < 6 && (!party || fits(party[index]))) found = index;
  else if (ok && party) {
    const hits = party.map((p, i) => (fits(p) && (species === undefined || p.species === species) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) found = hits[0];
  }
  if (found !== null) {
    state.gbActive = found;
    return { index: found, hp, maxHp, ...(stB !== undefined && statusOk(stB) ? { status: stB } : {}) };
  }
  return state.gbActive !== null && state.gbActive !== undefined ? { index: state.gbActive } : null;
}

/**
 * An expanded engine's gBattleMons (pokeemerald-expansion's BattlePokemon: 0x5C bytes per battler, the base game's
 * 0x58 plus a third type and a 16-bit ability – species +0x00, hp +0x2A, level +0x2C, maxHP +0x2E, personality +0x4C,
 * status1 +0x50, otId +0x58). Measured in Run & Bun 1.07, where it sits at 0x020233FC – the address its code uses
 * third most often, as gBattleMons is in the base game. Like the party it is searched for, never assumed: battler 0
 * holds one of the player's Pokémon there (its PID and OT ID 12 bytes apart, species, level and max HP as in the
 * party) and battler 1 one of gEnemyParty's. The array is static, so once found it is kept for the session.
 * The fields sit where they sit in Run & Bun in other builds too, but a build may add fields at the end: Too Many
 * Types 1.6 has 0x60 bytes per battler (measured: Fennekin at 0x020230F8, the wild Poochyena 0x60 on). The size is
 * found with the array – battler 1 one of the opponent's at one of `sizes` on – and kept with it (state.bmSize3).
 * Complete FireRed Upgrade (Unbound, Radical Red) kept FireRed's own BattlePokemon (BMON3: 0x58 bytes, hp +0x28, level
 * +0x2A, maxHP +0x2C, personality +0x48, status1 +0x4C, otId +0x54 – measured in Unbound at FireRed's 0x02023BE4): both
 * layouts are searched for, the one found is kept (state.bmLayout3).
 */
const BMON3X = { size: 0x5c, sizes: [0x5c, 0x60, 0x64, 0x68], species: 0x00, types: 0x22, ntypes: 3, hp: 0x2a, level: 0x2c, maxHp: 0x2e, pid: 0x4c, status: 0x50, otId: 0x58 };
const BMON3 = { size: 0x58, sizes: [0x58], species: 0x00, types: 0x21, ntypes: 2, hp: 0x28, level: 0x2a, maxHp: 0x2c, pid: 0x48, status: 0x4c, otId: 0x54 };
const BMON3_LAYOUTS = [BMON3X, BMON3];

/** The mons of a gen 3 party array (count, 100-byte structs): raw PID and OT ID next to the parsed mon. */
function rawParty3(read, at, n, T) {
  const raw = read(at, n * 100);
  const out = [];
  for (let i = 0; raw && i < n; i++) {
    const d = raw.subarray(i * 100, i * 100 + 100);
    const m = parsePk3(d, T);
    if (m && !m.bad && m.level >= 1 && m.level <= 100 && m.hp <= m.maxHp) out.push({ m, pid: u32le(d, 0), otId: u32le(d, 4) });
  }
  return out;
}

/** The battler at `b` (one BattlePokemon of gBattleMons, layout `L`) if it is one of `mons` (rawParty3), with its live numbers. */
function battler3x(read, b, mons, L = BMON3X) {
  const d = read(b, L.size);
  if (!d) return null;
  const pid = u32le(d, L.pid);
  const p = mons.find((x) => x.pid === pid && x.otId === u32le(d, L.otId));
  if (!p) return null;
  const hp = u16le(d, L.hp);
  const maxHp = u16le(d, L.maxHp);
  // (level and max HP as in the party struct – both are written together with the battle's; HP at most the max)
  if (maxHp !== p.m.maxHp || d[L.level] !== p.m.level || hp > maxHp) return null;
  return { p, hp, maxHp, status: u32le(d, L.status) & 0xff, typeIds: [...d.subarray(L.types, L.types + L.ntypes)] };
}

/**
 * The types a battler has right now (BattlePokemon type1/type2 – CFRU and the retail games at +0x21, pokeemerald-
 * expansion's three at +0x22): a type change in battle, a hack's retyped or Fairy Pokémon. Named with the ROM's type
 * ids (LiveTables.withRom); trusted once the player's battler has read as its species' types in this session
 * (state.types3Ok) – before that, or without the ROM's types, none (the species' types stand in).
 */
function battlerTypes3(T, state, x, own = false) {
  const keys = T.types3?.keys;
  if (!keys || !x?.typeIds || x.typeIds.some((i) => i >= keys.length && i !== 0xff)) return null;
  const ks = [...new Set(x.typeIds.map((i) => keys[i]).filter((k) => k && k !== '???'))];
  if (!ks.length) return null;
  if (own && !state.types3Ok) {
    const want = T.types3.species?.[x.p.m.species];
    if (want && want.length === ks.length && want.every((k) => ks.includes(k))) state.types3Ok = true;
  }
  return state.types3Ok ? ks : null;
}

/**
 * gEnemyParty wasn't where it was expected (an engine with another party array next to the player's – Modern Emerald's
 * gPlayerPartyBackup – and no hint from the code): in a battle it is the array of valid structs one or two party sizes
 * from the player's that holds none of the player's own Pokémon (a backup of the team holds the same PIDs). Kept in
 * state.enemy3; at most once a second. → its mons (rawParty3) or [].
 */
function findEnemy3(read, T, state, mine) {
  if (state.lastEnemyScan3 && Date.now() - state.lastEnemyScan3 < 1000) return [];
  state.lastEnemyScan3 = Date.now();
  const own = new Set(mine.map((x) => x.pid));
  for (const d of [600, 1200, -600, -1200]) {
    const at = state.party3 + d;
    if (at < 0x02000000 || at + 600 > 0x02040000 || at === state.enemy3) continue;
    const foes = rawParty3(read, at, 6, T);
    if (foes.length && !foes.some((x) => own.has(x.pid))) {
      state.enemy3 = at;
      return foes;
    }
  }
  return [];
}

/** Finds gBattleMons in EWRAM (see BMON3X) while a battle is on; at most once a second while it isn't found. */
function findBattleMons3x(read, T, state, mine, foes) {
  if (state.bmons3) return state.bmons3;
  if (state.lastBmScan3 && Date.now() - state.lastBmScan3 < 1000) return null;
  state.lastBmScan3 = Date.now();
  const ram = read(0x02000000, 0x40000);
  if (!ram) return null;
  for (const L of BMON3_LAYOUTS) {
    const biggest = Math.max(...L.sizes);
    for (let o = L.pid; o + biggest * 2 <= ram.length; o += 4) {
      const pid = u32le(ram, o);
      if (!pid) continue;
      const p = mine.find((x) => x.pid === pid);
      if (!p || u32le(ram, o + L.otId - L.pid) !== p.otId) continue;
      const b = 0x02000000 + o - L.pid;
      // battler 0 is ours – the same species, level and max HP – and battler 1 one of the opponent's
      if (T.idx3?.[u16le(ram, o - L.pid + L.species)] !== p.m.species) continue;
      if (!battler3x(read, b, mine, L)) continue;
      const size = L.sizes.find((n) => battler3x(read, b + n, foes, L));
      if (!size) continue;
      state.bmSize3 = size;
      state.bmLayout3 = L;
      return (state.bmons3 = b);
    }
  }
  return null;
}

function battleGen3(entry, read, T, state = {}) {
  const flag = read(hex(entry.inBattle.addr), 1)?.[0];
  if (flag === undefined || !(flag & hex(entry.inBattle.mask || '0x02'))) return null;
  if (entry.scan3) {
    // an expanded engine: gMain (the flag) stays where it was, gBattleTypeFlags and gBattlerPartyIndexes moved. The
    // parties are found (gEnemyParty 600 bytes after the player's); who is out on both sides comes from gBattleMons
    // (searched for, findBattleMons3x) – without it the opponent is gEnemyParty's first one standing.
    if (!state.party3) return null;
    const count = party3Count(read, T, state) ?? 0;
    const mine = count >= 1 && count <= 6 ? rawParty3(read, state.party3, count, T) : [];
    let foes = rawParty3(read, state.enemy3 || state.party3 + 600, 6, T);
    // (none there, or the player's own Pokémon – a backup of the team: gEnemyParty is elsewhere)
    if (mine.length && (!foes.length || foes.some((x) => mine.some((y) => y.pid === x.pid)))) foes = findEnemy3(read, T, state, mine);
    if (!foes.length) return { kind: 'wild', enemy: null, active: null };
    const bm = mine.length ? findBattleMons3x(read, T, state, mine, foes) : null;
    const L = state.bmLayout3 || BMON3X;
    const size = state.bmSize3 || L.size; // (per build: see BMON3X)
    // (both battlers must belong to this battle: before the new battle's mons are sent out the array still holds
    // the previous battle's, whose opponent isn't in gEnemyParty any more)
    let me = bm ? battler3x(read, bm, mine, L) : null;
    let foe = me ? battler3x(read, bm + size, foes, L) : null;
    if (bm) {
      // a found address that keeps failing in battle (another copy of a battler pair, a hack with another layout):
      // search again rather than keep it for the session
      state.bmFail3 = me && foe ? 0 : (state.bmFail3 || 0) + 1;
      if (state.bmFail3 >= 10) {
        state.bmons3 = null;
        state.bmSize3 = null;
        state.bmLayout3 = null;
        state.bmFail3 = 0;
      }
    }
    if (me && foe) {
      // a double battle: once the left one of a side is down and not replaced, its partner (battlers 2 and 3) is the
      // one still fighting. Only when battler 3 is one of this battle's opponents is it a double battle at all –
      // battler 2 can still hold the partner of an earlier double battle (an opponent of an earlier battle is never
      // in gEnemyParty), which must not stand in for a fainted Pokémon in a single battle
      const foe2 = battler3x(read, bm + 3 * size, foes, L);
      if (foe2) {
        const me2 = battler3x(read, bm + 2 * size, mine, L);
        if (me.hp === 0 && me2?.hp > 0) me = me2;
        if (foe.hp === 0 && foe2.hp > 0) foe = foe2;
      }
    }
    const e = foe ? foe.p.m : (foes.find((x) => x.m.hp > 0) || foes[0]).m;
    const meTypes = me ? battlerTypes3(T, state, me, true) : null;
    const foeTypes = foe ? battlerTypes3(T, state, foe) : null;
    // (the status condition: gBattleMons' status1 where the battler was found, else the party struct's – the battle
    // writes it there with every change, BtlController_EmitSetMonData REQUEST_STATUS_BATTLE)
    const status = foe ? foe.status : e.status;
    const enemy = { species: e.species, level: e.level, hp: foe ? foe.hp : e.hp, maxHp: e.maxHp, shiny: e.shiny, moves: e.moves, ...(foeTypes ? { types: foeTypes } : {}), ...(statusOk(status) ? { status } : {}) };
    // wild or trainer: a wild Pokémon is created with the player's trainer ID (CreateWildMon → OT_ID_PLAYER_ID, the
    // same in pokeemerald-expansion), a trainer's with a random one (OT_ID_RANDOM_NO_SHINY) – the opponent's OT ID
    // is one of the team's (its own catches) only in a wild battle
    const ot = (foe ? foe.p : foes[0]).otId;
    const kind = mine.length ? (mine.some((x) => x.otId === ot) ? 'wild' : 'trainer') : foes.length > 1 ? 'trainer' : 'wild';
    // (the index into the team as readGen3 lists it – the same structs, the same checks)
    const active = me && foe ? { index: mine.indexOf(me.p), hp: me.hp, maxHp: me.maxHp, ...(statusOk(me.status) ? { status: me.status } : {}), ...(meTypes ? { types: meTypes } : {}) } : null;
    return { kind, enemy, active };
  }
  const types = read(hex(entry.battleTypeFlagsAddr), 4);
  const flags = types ? u32le(types, 0) : 0;
  const trainer = !!(flags & 0x08); // BATTLE_TYPE_TRAINER
  // gBattlerPartyIndexes: battler 1 is the opponent's first slot
  const idx = entry.liveBattleHp?.battlerPartyIndexesAddr ? read(hex(entry.liveBattleHp.battlerPartyIndexesAddr), 8) : null;
  const enemyIndex = idx ? u16le(idx, 2) : 0;
  const raw = read(hex(entry.enemyPartyAddr) + (enemyIndex < 6 ? enemyIndex : 0) * 100, 100);
  const m = raw && parsePk3(raw, T);
  // (the status condition from the party struct: the battle writes it there with every change – pokeemerald
  // BtlController_EmitSetMonData(REQUEST_STATUS_BATTLE) → the opponent controller's SetMonData into gEnemyParty; checked
  // live in Emerald and Sapphire: Spore on the wild Pokémon → its sleep turns here at once)
  const enemy = m && !m.bad && m.level >= 1 && m.level <= 100 ? { species: m.species, level: m.level, hp: m.hp, maxHp: m.maxHp, shiny: m.shiny, moves: m.moves, ...(statusOk(m.status) ? { status: m.status } : {}) } : null;
  const index = idx ? u16le(idx, 0) : null;
  const active = index !== null && index < 6 ? { index } : null;
  // the types both sides have right now, from gBattleMons (searched for as in an expanded engine) – with the ROM's types
  if (T.types3 && enemy) {
    const n = read(hex(entry.partyCountAddr), 1)?.[0];
    const mine = n >= 1 && n <= 6 ? rawParty3(read, hex(entry.partyAddr), n, T) : [];
    const foes = rawParty3(read, hex(entry.enemyPartyAddr), 6, T);
    const bm = mine.length && foes.length ? findBattleMons3x(read, T, state, mine, foes) : null;
    const L = state.bmLayout3 || BMON3;
    const me = bm ? battler3x(read, bm, mine, L) : null;
    const foe = me ? battler3x(read, bm + (state.bmSize3 || L.size), foes, L) : null;
    const mt = me ? battlerTypes3(T, state, me, true) : null;
    const ft = foe && foe.p.m.species === enemy.species ? battlerTypes3(T, state, foe) : null;
    if (ft) enemy.types = ft;
    if (mt && active && mine[active.index]?.pid === me.p.pid) active.types = mt;
  }
  return { kind: trainer ? 'trainer' : 'wild', enemy, active, ...(!trainer && noBalls3(flags) ? { balls: 'none' } : {}), ...(tutorial3(entry, flags) ? { tutorial: true } : {}) };
}

/**
 * Gen 3 battles that aren't the player's own (gBattleTypeFlags, pokeemerald/pokeruby/pokefirered include/constants/
 * battle.h): the catching tutorials – Wally's in Petalburg City (BATTLE_TYPE_WALLY_TUTORIAL) and the old man's in
 * Viridian City (BATTLE_TYPE_OLD_MAN_TUTORIAL, the same bit 9) – and FireRed/LeafGreen's Poké Dude battles on the Teachy
 * TV (BATTLE_TYPE_POKEDUDE, bit 16 – Emerald's Battle Dome there).
 */
const frlg3 = (entry) => /^(firered|leafgreen)_/.test(String(entry?.id || ''));
const tutorial3 = (entry, f) => !!(f & 0x200) || (frlg3(entry) && !!(f & 0x10000));

/**
 * Gen 3 wild battles where no ball can be thrown (pokeemerald/pokefirered include/constants/battle.h): the Safari
 * Zone (BATTLE_TYPE_SAFARI – its own Safari Balls and catch factor), the catching tutorials (Wally's, FireRed's old man:
 * BATTLE_TYPE_WALLY_TUTORIAL / OLD_MAN_TUTORIAL), the first battle (Birch's bag – BATTLE_TYPE_FIRST_BATTLE) and FireRed's
 * unidentified ghosts (BATTLE_TYPE_GHOST, bit 15 – Emerald's TWO_OPPONENTS, only ever set with a trainer – unless
 * GHOST_UNVEILED, bit 13, is set with it).
 */
const noBalls3 = (f) => !!(f & (0x80 | 0x200 | 0x10)) || ((f & 0x8000) !== 0 && (f & 0x2000) === 0);

/**
 * DS: during battle the heap holds extra PartyCore copies – the player's (same PIDs, live HP) and the
 * opponent's (none of the player's PIDs). Freed blocks keep stale copies after the battle, so a copy only counts
 * while the in-battle flag says so (HGSS) or, without a flag, while it still changes.
 * Scanning 4 MB takes ~8 ms – one dropped frame – so it runs in 1 MB steps on consecutive polls, and the
 * copies found are re-read directly in between.
 */
const SCAN_STEP = 0x100000;
function scanStep(read, size, gen, T, state) {
  const sc = state.scan || (state.scan = { off: 0, hits: [] });
  const ram = read(0x02000000 + sc.off, Math.min(SCAN_STEP + 8 + size, 0x400000 - sc.off)); // overlap: structs on the seam
  if (ram) for (const a of scanPartyCore(ram, size, gen, T, { limit: 16 })) sc.hits.push(a + sc.off);
  sc.off += SCAN_STEP;
  if (sc.off < 0x400000) return;
  // a copy the game was writing while the scan passed it doesn't look like one: keep the ones still held (below)
  const keep = [...(state.heldCopies?.keys() || [])];
  state.candidates = [...new Set([...sc.hits, ...keep])].slice(0, 24);
  state.scan = null;
}

/** Odd battle-flag reads in a row (Gen 5) after a battle value before the battle counts as over. */
const OTHER_STREAK = 3;

function battleFlag(entry, read, state = {}) {
  // only flags checked in a running game (addresses.json `verified`: HeartGold, Platinum, Pearl) – the community
  // addresses of the others haven't been, and a wrong flag would hide every battle
  if (!entry.inBattle?.addr || !entry.inBattle.verified) return null;
  const f = read(hex(entry.inBattle.addr), 2);
  if (!f) return null;
  const v = u16le(f, 0);
  const on = (entry.inBattle.inBattleValues || []).map(hex).includes(v);
  const off = !on && (entry.inBattle.notInBattleValues || []).map(hex).includes(v);
  if (on || off) {
    const seen = state.flagSeen || (state.flagSeen = new Set());
    seen.add(on);
    state.flagOn = on;
    state.otherStreak = 0;
    return on;
  }
  // Black/White, Black 2/White 2: the flag has its battle values in every battle and any other value means none
  // (NDS-Ironmon-Tracker reads it the same way). The summary screen of Black 2, for one, sets 0x88C2 – left to the
  // copies, a freed copy of the catching demo's party read as a battle against its Patrat / Lillipup there (#9).
  // The game's other languages (scanOnly) may keep the flag elsewhere: there only once this session has seen both its
  // battle and its overworld value at that address.
  if (entry.inBattle.othersNotInBattle && (!entry.scanOnly || state.flagSeen?.size === 2)) {
    // straight out of a battle value, one odd read isn't the end of the battle yet (that would retire the battle's
    // copies for good): only a few in a row are – from the overworld, an odd value means "no battle" at once
    state.otherStreak = (state.otherStreak || 0) + 1;
    if (state.flagOn && state.otherStreak < OTHER_STREAK) return true; // still the battle (not left to the copies, whose
    // staleness check could end it for good after a long wait in a menu)
    state.flagOn = false;
    return false;
  }
  return null; // some other screen – decide by the copies
}

const copyKey = (addr, mons) => `${addr}#${mons.map((m) => `${m.pid}:${m.hp}`).join()}`;

/**
 * The battle is over: remember what every copy holds now. Freed blocks keep that content, and an unchanged
 * leftover must not pass for the next battle's opponent (wrong species, a shiny/legendary flash at the start)
 * or for the player's live copy (its old HP would hide a faint that happens in the new battle).
 */
function retireCopies(read, size, gen, T, state) {
  const stale = state.staleCopies || (state.staleCopies = new Set());
  for (const addr of state.candidates || []) {
    const mons = readPartyCore(read, addr, size, gen, T);
    if (mons) stale.add(copyKey(addr, mons));
  }
  if (stale.size > 64) state.staleCopies = new Set([...stale].slice(-64));
  state.seenCopies = null;
  state.heldCopies = null;
}

/**
 * PID of the player's mon that is out (battler 0), from the battle mon struct (addresses.json battleActive) – only
 * when it is one of the player's PIDs (and, where known, the struct's species matches): before the battle has
 * loaded it, the memory holds the previous battle's mon or anything else.
 */
function battleMonPid(entry, read, state, party) {
  const a = entry.battleActive;
  if (!a) return null;
  const addr = a.pidOffsetFromSaveBase ? (state.saveBase ? state.saveBase + hex(a.pidOffsetFromSaveBase) : null) : a.pidAddr ? hex(a.pidAddr) : null;
  if (!addr) return null;
  const b = read(addr, 4);
  const pid = b ? u32le(b, 0) : 0;
  const m = pid && party.find((x) => x.pid === pid);
  if (!m) return null;
  if (a.speciesDelta) {
    const sp = read(addr + parseInt(a.speciesDelta, 16), 2);
    if (!sp || u16le(sp, 0) !== m.species) return null;
  }
  return pid;
}

/**
 * HGSS: the battle's own mon structs – what the battle screen shows (pokeheartgold include/battle/battle.h BattleMon,
 * 0xC0 bytes each, one per battler: 0 the player's, 1 the opponent's, 2 and 3 the second ones in a double battle).
 * The array sits at a fixed offset from the save data (addresses.json battleMons; the same in the Definitive
 * HeartGold hack). It is zeroed when a battle starts and filled once its mons are sent out, and it keeps the last
 * battle's mons afterwards – so it only counts in battle (flag), while battler 0 is one of the player's mons, and
 * not while the opponent is still the previous battle's (same PID as at the end of that one).
 * { me, foe, foe2 } or { why } when it can't be trusted right now.
 */
const BMON = 0xc0;
function battleMonAt(b, o) {
  return {
    species: u16le(b, o), level: b[o + 0x34], hp: u32le(b, o + 0x4c), maxHp: u32le(b, o + 0x50), pid: u32le(b, o + 0x68),
    status: u32le(b, o + 0x6c), otId: u32le(b, o + 0x74), moves: [0, 1, 2, 3].map((i) => u16le(b, o + 0x0c + i * 2)).filter(Boolean),
    // the types and form it has right now (BattleMon type1/type2 +0x24/+0x25, form +0x26 bits 0–4: Castform's weather,
    // Arceus's plate, a type change in battle)
    typeIds: [b[o + 0x24], b[o + 0x25]], form: b[o + 0x26] & 0x1f,
  };
}
const saneBattleMon = (m) => m.species >= 1 && m.species <= 493 && m.level >= 1 && m.level <= 100 && m.maxHp > 0 && m.maxHp <= 999 && m.hp <= m.maxHp;
function battleStructs(entry, read, state, party) {
  const a = entry.battleMons;
  if (!a || !state.saveBase) return { why: 'no-layout' };
  const b = read(state.saveBase + hex(a.offsetFromSaveBase), BMON * 4);
  if (!b) return { why: 'unreadable' };
  const [me, ally, foe, foe2] = [0, 2, 1, 3].map((i) => battleMonAt(b, i * BMON));
  if (!foe.species) return { why: 'foe-empty' };
  // battler 0 must be one of ours (Transform changes its species, not its PID)
  if (!saneBattleMon(me) || !party.some((p) => p.pid === me.pid)) return { why: me.species ? 'player-foreign' : 'player-empty' };
  if (!saneBattleMon(foe)) return { why: 'foe-insane' };
  if (state.bmonStale && state.bmonStale === foe.pid) return { why: 'foe-stale' };
  return { me, foe, foe2: saneBattleMon(foe2) && foe2.pid !== foe.pid ? foe2 : null, ally: saneBattleMon(ally) ? ally : null };
}

function battleDS(entry, read, T, state, party) {
  if (!party?.length) return null;
  const now = Date.now();
  const flag = battleFlag(entry, read, state);
  const size = entry.gen === 5 ? 220 : 236;
  if (flag === false) {
    // overworld: nothing to scan. The battle structs keep this battle's opponent until the next one is sent out.
    if (entry.battleMons && state.saveBase) {
      const b = read(state.saveBase + hex(entry.battleMons.offsetFromSaveBase) + BMON, BMON);
      const foe = b && battleMonAt(b, 0);
      if (foe && saneBattleMon(foe)) state.bmonStale = foe.pid;
    }
    state.bmonHeld = null;
    note(state, 'overworld', flag);
    if (state.candidates?.length) retireCopies(read, size, entry.gen, T, state);
    state.battle = null;
    state.battleHp = state.activePid = state.g5order = state.g5foeOrder = null;
    state.scan = null;
    state.candidates = null;
    return null;
  }
  scanStep(read, size, entry.gen, T, state);
  if (flag && !state.candidates?.length) scanStep(read, size, entry.gen, T, state); // battle just began: hurry
  const pids = new Set(party.map((m) => m.pid));
  const tid = party[0].key?.split('-')[1];
  const stale = state.staleCopies || new Set();
  const seen = state.seenCopies || (state.seenCopies = new Map());
  let mine = null;
  let anyDiff = false;
  let enemy = null;
  // The live copies are written all the time (each hit, each turn) and a read in the middle of that is rejected.
  // Then that copy keeps what it held a poll ago – taking the next best copy instead (the battle's frozen setup copy,
  // or none: the save party) showed a fainted mon with its old HP again for a moment, or the opponent at full HP.
  const held = state.heldCopies || new Map();
  const nextHeld = new Map();
  const copies = new Map(); // this battle's copies (address → how many Pokémon) – Gen 5's battle structs point into them
  const foreign = []; // this battle's copies without any of the player's Pokémon
  for (const addr of state.candidates || []) {
    if (addr === state.partyAddr) continue;
    const fresh = readPartyCore(read, addr, size, entry.gen, T);
    const h = held.get(addr);
    // held for a few polls at most: a block the game freed and reused stays unreadable
    const mons = fresh || (h && h.misses < 3 ? h.mons : null);
    if (!mons) continue;
    nextHeld.set(addr, { mons, misses: fresh ? 0 : h.misses + 1 });
    const ck = copyKey(addr, mons);
    if (stale.has(ck)) continue; // left over from an earlier battle, untouched since
    copies.set(addr, mons.length);
    if (!seen.has(addr)) seen.set(addr, ck);
    const changed = seen.get(addr) !== ck;
    if (mons.every((m) => pids.has(m.pid))) {
      // a player copy: prefer the one that changes during this battle, then one whose HP differs from the
      // frozen save party
      const diff = mons.some((m) => party.find((p) => p.pid === m.pid)?.hp !== m.hp);
      anyDiff ||= diff;
      const rank = (changed ? 2 : 0) + (diff ? 1 : 0);
      if (!mine || rank >= mine.rank) mine = { addr, mons, diff, rank };
    } else if (mons.every((m) => !pids.has(m.pid))) {
      foreign.push(mons);
      // wild mons carry the player's ID too. The opponent also has a frozen copy (the battle setup) next to
      // the live one – the live one is the one that has taken damage.
      const hp = mons.reduce((n, m) => n + m.hp, 0);
      if (!enemy || (enemy.sig === mons.map((m) => m.pid).join() && hp < enemy.hp)) enemy = { addr, mons, hp, sig: mons.map((m) => m.pid).join() };
    }
  }
  state.heldCopies = nextHeld;
  const live = mine?.mons || null;
  // a catching demo: someone else's battle, never the player's (no encounter, no death, no catch chance)
  const demo = !mine && flag !== false ? catchingDemo(entry, foreign) : null;
  if (demo) {
    note(state, `demo ${demo.species}/${demo.level}`, flag);
    return (state.battle = { kind: 'wild', tutorial: true, enemy: { species: demo.species, level: demo.level, hp: demo.hp, maxHp: demo.maxHp, shiny: demo.shiny, moves: demo.moves }, active: null });
  }
  // The battle structs say who is out on both sides – the heap copies are only a guess (a trainer's whole party,
  // the battle's frozen setup copy, a freed block of an earlier battle). Once they have worked in this session the
  // guess is never used for the opponent again: a wrong Pokémon is worse than none for a moment.
  if (flag !== false && entry.battleMons) {
    const s = battleStructs(entry, read, state, party);
    if (s.why === 'foe-empty' && flag) state.bmonStale = null; // zeroed: the new battle is being set up
    if (s.foe) {
      state.bmonOk = true;
      state.bmonHeld = { at: now, s };
    }
    const use = s.foe ? s : state.bmonHeld && now - state.bmonHeld.at < 3000 ? state.bmonHeld.s : null; // a switch in progress
    note(state, s.foe ? `struct ${s.foe.species}/${s.foe.level}` : use ? `held (${s.why})` : `none (${s.why})`, flag);
    if (use) return (state.battle = structBattle(use, party, live, T, state));
    if (state.bmonOk) {
      // in battle, the opponent not sent out yet (or the previous battle's still there): a battle without an opponent
      if (flag) return (state.battle = { kind: state.battle?.kind || 'wild', enemy: null, active: null });
      if (!state.battle) return null;
    }
  }
  const sig = enemy ? enemy.mons.map((m) => `${m.pid}:${m.hp}`).join() : '';
  if (sig && sig !== state.enemySig) {
    state.enemySig = sig;
    state.enemySince = now;
  }
  // Without a flag: "an opponent party that changed recently, or a player copy with different HP". The save party
  // stays as it was for the whole battle (HP, level, a catch all land in it when the battle ends), so once it differs
  // from what it was when the battle began, the battle is over – a Potion in battle doesn't touch it. (Black: the
  // rival's Pokémon stayed on the panel ~2 minutes after the fight otherwise.)
  const saveSig = party.map((m) => `${m.pid}:${m.level}:${m.hp}:${m.maxHp}`).join();
  if (enemy && state.battleStartSig === undefined) state.battleStartSig = saveSig;
  const over = flag === null && state.battleStartSig !== undefined && saveSig !== state.battleStartSig;
  const on = flag ?? (!over && ((!!enemy && now - (state.enemySince || 0) < 90000) || anyDiff));
  if (!on || !enemy) {
    // the battle flag says the battle goes on, but no opponent copy could be read this poll (being rewritten, the
    // heap search between two passes): keep showing the last one instead of blanking the panel until the next read
    if (flag === true && state.battle?.enemy) {
      note(state, 'held (no copy)', flag);
      return state.battle;
    }
    if (flag === null && state.battle) retireCopies(read, size, entry.gen, T, state); // battle ended (no flag)
    state.battleStartSig = undefined;
    state.battle = null;
    state.battleHp = state.activePid = state.g5order = state.g5foeOrder = null;
    return null;
  }
  // The active opponent: first one still standing (trainers send them in order). Gen 5: the copies keep the HP the
  // battle started with – who is still standing is in the battle's own structs (a trainer's first Pokémon stayed on
  // the panel at 0 HP while the next one fought).
  const structs = entry.gen === 5 ? gen5Structs(read, state, [...enemy.mons, ...party], copies) : null;
  const hps = structs && new Map([...structs].map(([pid, x]) => [pid, x.hp]));
  const hpOf = (m) => hps?.get(m.pid) ?? m.hp;
  // (Gen 5: the battle order says who is out – gen5Foe; Diamond/Pearl/Platinum: the battle's own BattleMon of the
  // opponent – foeOutDS)
  const fi = structs ? gen5Foe(read, state, enemy.mons, hpOf, structs) : foeOutDS(entry, read, state, enemy.mons);
  const foe = (fi !== null && enemy.mons[fi]) || enemy.mons.find((m) => hpOf(m) > 0) || enemy.mons[0];
  // Active player mon. Where we know the battle mon struct, its PID says who is out – a switch shows at once.
  // Otherwise: the last one whose HP changed in this battle (it took the hit – that follows a switch), else the
  // first one standing (the lead unless it fainted).
  // (Gen 5 without a known address for it – Black 2: the battle's own team order says who is out; the HP heuristic
  // below never fires there, the copies keep the starting HP)
  const g5 = structs && !entry.battleActive ? gen5Active(read, state, party, hpOf, structs) : null;
  const real = g5 !== null ? party[g5].pid : battleMonPid(entry, read, state, party);
  if (live) {
    const prev = state.battleHp || new Map();
    if (!real) for (const m of live) if (prev.has(m.pid) && prev.get(m.pid) !== m.hp) state.activePid = m.pid;
    state.battleHp = new Map(live.map((m) => [m.pid, m.hp]));
  }
  if (real) state.activePid = real;
  // The index is the save party's (the panel and the HP fold use that order) – the copy may be ordered otherwise.
  const byPid = new Map((live || party).map((m) => [m.pid, m]));
  const standing = (m) => hpOf(byPid.get(m.pid) || m) > 0;
  const hit = party.findIndex((m) => m.pid === state.activePid && (real || standing(m)));
  const index = live || real ? (hit >= 0 ? hit : Math.max(0, party.findIndex(standing))) : null;
  const cur = index !== null ? byPid.get(party[index].pid) || party[index] : null;
  note(state, `heap ${foe.species}/${foe.level}`, flag);
  // Gen 5: the HP the battle shows (the copies keep the starting HP) – the opponent's, and the player's Pokémon that is
  // out (the one of the team that has a battle struct)
  let active = cur ? { index, hp: cur.hp, maxHp: cur.maxHp, status: cur.status } : null;
  let foeHp = null;
  if (hps) {
    foeHp = hps.get(foe.pid) ?? null;
    const i = active ? active.index : party.findIndex((m) => hps.has(m.pid));
    // (a Pokémon that grew a level in this battle: its struct has the new max HP, the save party the old one until the end)
    if (i >= 0 && hps.has(party[i].pid)) active = { index: i, hp: Math.min(hps.get(party[i].pid), party[i].maxHp), maxHp: party[i].maxHp, status: active?.status ?? party[i].status };
  }
  state.battle = {
    kind: enemy.mons.length > 1 || foe.key.split('-')[1] !== tid ? 'trainer' : 'wild',
    enemy: { species: foe.species, level: foe.level, hp: foeHp ?? foe.hp, maxHp: foe.maxHp, shiny: foe.shiny, moves: foe.moves, ...(foe.form ? { form: foe.form } : {}), ...(structs ? foeStatus5(structs.get(foe.pid)) : foeStatusDS(entry, read, state, foe)) },
    active,
    // the battle's own party copy: HP and status conditions as they are now (the save party gets them at the end)
    party: live && live.map((m) => ({ pid: m.pid, hp: m.hp, maxHp: m.maxHp, status: m.status })),
  };
  // (Gen 5: the battle structs' HP wins over the party copy's starting HP – every team member has one)
  if (hps && state.battle.party) state.battle.party = state.battle.party.map((m) => (hps.has(m.pid) ? { ...m, hp: hps.get(m.pid) } : m));
  return state.battle;
}

/**
 * Diamond/Pearl/Platinum: which of a trainer's Pokémon is out – battler 1's BattleMon, or battler 3's in a double battle
 * once 1 is down (the structs foeStatusDS reads; a struct counts only with a PID of this opponent's party – before the
 * battle's Pokémon are sent out it holds the previous battle's). Not "the first one still standing": the AI picks the
 * next one itself. The one out stays (at 0 HP) until the next one is sent, unless only one is left standing.
 * → the index into `mons`, or null when it can't be told.
 */
function foeOutDS(entry, read, state, mons) {
  const off = entry.gen === 4 && !entry.battleMons ? entry.battleActive?.pidOffsetFromSaveBase : null;
  if (!off || !state.saveBase || mons.length < 2) return null;
  const at = state.saveBase + hex(off) - 0x68;
  const outs = [];
  for (const i of [1, 3]) {
    const b = read(at + i * BMON, BMON);
    const m = b && battleMonAt(b, 0);
    const k = m && m.pid ? mons.findIndex((x) => x.pid === m.pid) : -1;
    if (k >= 0 && m.maxHp > 0 && m.hp <= m.maxHp) outs.push({ k, hp: m.hp });
  }
  if (!outs.length) return null;
  const out = outs.find((x) => x.hp > 0) || outs[0];
  if (out.hp > 0) return out.k;
  const up = mons.map((m, i) => i).filter((i) => i !== out.k && mons[i].hp > 0);
  return up.length === 1 ? up[0] : out.k;
}

/**
 * The DS games' catching demos: an NPC catches a Pokémon in front of the player, with a party of their own on the
 * player's side – the battle's copies hold two one-Pokémon parties, neither with any of the player's Pokémon.
 * Diamond/Pearl/Platinum: Dawn's or Lucas's starter (Lv. 5) and a Bidoof (Lv. 2) on Route 202 (pokeplatinum
 * FieldBattleDTO_NewCatchingTutorial: the counterpart's starter, SPECIES_BIDOOF level 2); HeartGold/SoulSilver: Lyra's or
 * Ethan's Marill (Lv. 5) and a Rattata (Lv. 2) on Route 29 (pokeheartgold BattleSetup_New_Tutorial); Black/White:
 * Juniper's Minccino and a Patrat (Lv. 2) on Route 1 (seen in White); Black 2/White 2: Bianca's Lillipup and a Purrloin
 * (Lv. 2) on Route 19. The demo battles are flagged like any other (BATTLE_TYPE_CATCH_TUTORIAL lives in the battle's
 * own heap data only), so they are told by these parties. → the demo's wild Pokémon, or null.
 */
const DS_DEMOS = [
  { games: /^(diamond|pearl|platinum)_/, tutor: [387, 390, 393], wild: [399] },
  { games: /^(heartgold|soulsilver)_/, tutor: [183], wild: [19] },
  { games: /^(black|white|black2|white2)_/, tutor: [572, 506], wild: [504, 506, 509] },
];
function catchingDemo(entry, foreign) {
  const d = DS_DEMOS.find((x) => x.games.test(String(entry.id || '')));
  const ones = foreign.filter((mons) => mons.length === 1).map((mons) => mons[0]);
  if (!d || ones.length < 2) return null;
  const wild = ones.find((m) => m.level === 2 && d.wild.includes(m.species));
  const tutor = ones.find((m) => m !== wild && m.level >= 5 && d.tutor.includes(m.species));
  return wild && tutor ? wild : null;
}

/** Gen 5: the opponent's status condition from its battle struct (gen5Sick) – none when the struct isn't found. */
const foeStatus5 = (x) => (x && x.status !== undefined ? { status: x.status } : {});

/**
 * The opponent's status condition in Diamond/Pearl/Platinum. The heap copies don't get it during the battle (checked live
 * in Pearl: a wild Starly put to sleep stays at 0 in its copy), the battle's own BattleMon does – the struct the ball
 * formula reads (pokeplatinum BattleScript_CalcCatchShakes: battleMons[defender].status). The array sits where
 * addresses.json battleActive puts battler 0 (its personality at +0x68), 0xC0 bytes per battler (HGSS's layout,
 * pokeplatinum include/battle/battle_mon.h – checked live in Pearl: the Starly as battler 1 with status 1 after Spore).
 * Only a struct with the opponent's PID counts (battler 1, or 3 in a double battle); none gives no status rather than a
 * stale one.
 */
function foeStatusDS(entry, read, state, foe) {
  const off = entry.gen === 4 && !entry.battleMons ? entry.battleActive?.pidOffsetFromSaveBase : null;
  if (!off || !state.saveBase) return {};
  const at = state.saveBase + hex(off) - 0x68;
  for (const i of [1, 3]) {
    const b = read(at + i * BMON, BMON);
    const m = b && battleMonAt(b, 0);
    if (m && m.pid === foe.pid && m.species === foe.species && statusOk(m.status)) return { status: m.status };
  }
  return {};
}

/**
 * Gen 5: the battle's own Pokémon structs. The heap's party copies keep the HP the battle started with, so the live HP
 * comes from these: { u16 species, u16 max HP, u16 HP, … u8 level at +12 } for every Pokémon of both sides (found live in
 * Black: the rival's Snivy 19 → 14 → 4 HP at 0x0226D8D4 and a second copy 0x448 on; Tepig's 0x224 before it), each twice.
 * 0x0C before the species sits the struct's pointer to its Pokémon in the battle's party copy (found live in Black 2: the
 * player's Patrat → copy + 8, Tepig → copy + 8 + 220, the wild Patrat → its own copy + 8), and that one starts with
 * the PID – so a struct is told by whose Pokémon it is, not by what it looks like.
 * They used to be found by species, max HP and level. A wild Patrat with the same level and max HP as the player's then
 * shared its struct – and when the player's Patrat, switched out, grew a level from the shared EXP, its own struct no
 * longer matched the save party's old numbers and the search took the wild one, which had just fainted: the player's
 * Patrat "died" (#12, checked in Black 2 in souldew's fast player). Now a struct counts only when its pointer leads into
 * one of this battle's copies (`copies`: address → count – a freed struct of an earlier battle points into a copy that is
 * gone) and to the Pokémon's PID. Level and max HP may change (a level-up). Remembered per PID while that still holds,
 * rescanned at most every 2 s. → Map(pid → { hp, maxHp, addrs: [struct addresses, both copies] }).
 */
const G5MON = { maxHp: 2, hp: 4, level: 12, pp: -0x0c, sick: 0x10 };
const G5_PK = 220;
/**
 * The status condition in a Gen 5 battle struct: one u32 per condition from +0x10 on, in the order of the party status
 * numbers (gen5Status: +0x14 paralysis, +0x18 sleep, +0x1C freeze, +0x20 burn, +0x24 poison), non-zero while it lasts
 * (found live in Black, a wild Patrat: Thunder Wave → +0x14 = 1, Spore → +0x18 = 18, Will-O-Wisp → +0x20 = 1, Toxic →
 * +0x24 = 0x1E79 – the in-game SLP/PAR/BRN/PSN icon each time). → the Gen 3/4 bits (gen5Status), 0 for none, undefined when
 * more than one is set (not a struct read cleanly).
 */
function gen5Sick(b, o) {
  const set = [1, 2, 3, 4, 5].filter((k) => u32le(b, o + G5MON.sick + k * 4) !== 0);
  return set.length > 1 ? undefined : gen5Status(set[0] || 0);
}
function gen5Struct(read, a, m, copies) {
  const b = read(a + G5MON.pp, 0x0c + G5MON.sick + 0x18);
  if (!b) return null;
  const o = -G5MON.pp;
  const maxHp = u16le(b, o + G5MON.maxHp);
  const hp = u16le(b, o + G5MON.hp);
  const level = b[o + G5MON.level];
  if (u16le(b, o) !== m.species || !maxHp || maxHp > 999 || hp > maxHp || level < 1 || level > 100) return null;
  const pp = u32le(b, 0);
  let inCopy = false;
  for (const [c, n] of copies) {
    const off = pp - c - 8;
    if (off >= 0 && off % G5_PK === 0 && off / G5_PK < n) inCopy = true;
  }
  if (!inCopy) return null;
  const pid = read(pp, 4);
  return pid && u32le(pid, 0) === m.pid ? { hp, maxHp, status: gen5Sick(b, o) } : null;
}
function gen5Structs(read, state, mons, copies) {
  const cache = state.g5mons || (state.g5mons = new Map()); // pid → [struct addresses]
  const want = mons.filter(Boolean);
  const out = new Map();
  const check = (m) => {
    const ok = (cache.get(m.pid) || []).map((a) => [a, gen5Struct(read, a, m, copies)]).filter(([, x]) => x);
    if (ok.length) out.set(m.pid, { ...ok[0][1], addrs: ok.map(([a]) => a) });
    return ok.length > 0;
  };
  const missing = want.filter((m) => !check(m));
  const now = Date.now();
  if (missing.length && copies.size && (!state.g5scan || now - state.g5scan > 2000)) {
    state.g5scan = now;
    const bySpecies = new Map();
    for (const m of missing) bySpecies.set(m.species, [...(bySpecies.get(m.species) || []), m]);
    const found = new Map(missing.map((m) => [m.pid, []]));
    const BASE = 0x02200000;
    const ram = read(BASE, 0x200000); // the battle's heap (the Snivy above: 0x0226D8D4)
    if (ram) {
      for (let o = 0x0c; o + 14 <= ram.length; o += 2) {
        const ms = bySpecies.get(ram[o] | (ram[o + 1] << 8));
        if (!ms || u16le(ram, o + G5MON.hp) > u16le(ram, o + G5MON.maxHp) || u16le(ram, o + G5MON.maxHp) > 999) continue;
        for (const m of ms) if (gen5Struct(read, BASE + o, m, copies)) found.get(m.pid).push(BASE + o);
      }
    }
    for (const m of missing) {
      cache.set(m.pid, found.get(m.pid).slice(0, 4));
      check(m);
    }
    while (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  return out;
}

/**
 * Gen 5: which of the player's Pokémon is out. The battle keeps the team twice as arrays of pointers to the battle
 * structs (pointer = struct − 0x0C): once in the team's own order and once in battle order, the Pokémon that is out
 * first (found live in Black 2, a wild battle with Tepig and Purrloin: 0x0225736C [Tepig, Purrloin] turned
 * [Purrloin, Tepig] with the switch, 0x022573EC stayed; the same pair again for the structs' second copy). The arrays
 * are found from the structs (gen5Structs: the player's, told by PID) once per battle (rescanned at most every 2 s while
 * they don't check out) and read every poll. → the party index of the Pokémon that is out, or null when that can't be told.
 */
const G5PTR = -G5MON.pp;
/**
 * The battle's pointer arrays of one side's team (`team`, the Pokémon in the order of their party copy): every array of
 * team.length pointers that covers each of the team's structs once, read as team indexes. Found once per battle (kept in
 * state[key], rescanned at most every 2 s while they don't check out). → { o: state[key], orders: [[index, …], …] }
 * (orders empty: not found right now – o.last is what the caller decided the last time).
 */
function gen5Orders(read, state, key, team, structs) {
  const n = team.length;
  const ptrs = new Map(); // struct − 0x0C → team index, every struct of the team's this poll
  team.forEach((m, i) => {
    for (const a of structs.get(m.pid)?.addrs || []) ptrs.set(a - G5PTR, i);
  });
  const pids = team.map((m) => m.pid).join();
  const orderAt = (addr) => {
    const b = read(addr, n * 4);
    if (!b) return null;
    const order = [];
    for (let k = 0; k < n; k++) {
      const i = ptrs.get(u32le(b, k * 4));
      if (i === undefined || order.includes(i)) return null;
      order.push(i);
    }
    return order;
  };
  let o = state[key];
  let orders = o && o.pids === pids ? o.arrays.map(orderAt) : [];
  if (!orders.length || orders.some((x) => !x)) {
    const now = Date.now();
    if (o?.at && now - o.at < 2000) return { o, orders: [] };
    o = state[key] = { pids, at: now, arrays: [], last: o?.pids === pids ? o.last ?? null : null };
    if (ptrs.size < n) return { o, orders: [] };
    const BASE = 0x02200000;
    const ram = read(BASE, 0x200000);
    if (!ram) return { o, orders: [] };
    for (let x = 0; x + n * 4 <= ram.length && o.arrays.length < 8; x += 4) {
      if (!ptrs.has(u32le(ram, x))) continue;
      const seen = new Set();
      for (let k = 0; k < n; k++) seen.add(ptrs.get(u32le(ram, x + k * 4)));
      if (seen.size === n && !seen.has(undefined)) o.arrays.push(BASE + x);
    }
    orders = o.arrays.map(orderAt).filter(Boolean);
  }
  return { o, orders };
}

function gen5Active(read, state, party, hpOf, structs) {
  const n = party.length;
  if (n < 2) return n === 1 ? 0 : null;
  const { o, orders } = gen5Orders(read, state, 'g5order', party, structs);
  if (!orders.length) return o?.last ?? null;
  // the team's own order is the identity; an array that differs is the battle order. All the same: nobody switched –
  // the lead is out (unless it can't fight: then the game sent the first one that can)
  const moved = orders.find((x) => x.some((i, k) => i !== k));
  const lead = party.findIndex((m) => !m.isEgg && hpOf(m) > 0);
  o.last = moved ? moved[0] : party[0].isEgg || hpOf(party[0]) === 0 ? (lead >= 0 ? lead : 0) : 0;
  return o.last;
}

/**
 * Gen 5: which of the opponent's Pokémon is out – the same battle order as the player's (gen5Active), kept for the
 * opponent's team too: the one in front. A trainer doesn't send its Pokémon in party order (the AI picks the next one),
 * so "the first one still standing" showed the wrong Pokémon as soon as the lead was down – before the trainer had
 * chosen, and often one other than it then sent. The one out stays on the panel (at 0 HP) until the next one is sent –
 * unless only one is left standing: then that one is next for sure. → the index into `mons`, or null when the order
 * can't be read (then the first one standing stands in, as before).
 */
function gen5Foe(read, state, mons, hpOf, structs) {
  if (mons.length < 2) return null;
  const { o, orders } = gen5Orders(read, state, 'g5foeOrder', mons, structs);
  if (!orders.length) return o?.last ?? null;
  const moved = orders.find((x) => x.some((i, k) => i !== k));
  let out = moved ? moved[0] : 0;
  if (hpOf(mons[out]) === 0) {
    const up = mons.map((m, i) => i).filter((i) => hpOf(mons[i]) > 0);
    if (up.length === 1) out = up[0];
  }
  o.last = out;
  return out;
}

/** The battle from the battle structs; `live` is the battle's party copy (HP of the mons that aren't out). */
function structBattle({ me, foe, foe2, ally }, party, live, T, state = {}) {
  // a double battle: the one still standing (battler 1 first) leads, and both are listed while both stand
  const f = foe.hp === 0 && foe2?.hp > 0 ? foe2 : foe;
  // (status: BattleMon.status, what the ball formula reads – pokeheartgold CalculateBallShakes; the types and form it has
  // right now – structTypes)
  const myTypes = structTypes(T, state, me, true);
  const enemyOf = (x) => {
    const types = structTypes(T, state, x);
    return { species: x.species, level: x.level, hp: x.hp, maxHp: x.maxHp, shiny: isShiny(x.pid, x.otId, T), moves: x.moves, ...(x.form ? { form: x.form } : {}), ...(types ? { types } : {}), ...(statusOk(x.status) ? { status: x.status } : {}) };
  };
  const index = party.findIndex((p) => p.pid === me.pid);
  // the player's second battler in a double battle – only when it's one of the player's own (a multi battle's
  // partner sends out theirs)
  const allyIndex = foe2 && ally && ally.pid !== me.pid ? party.findIndex((p) => p.pid === ally.pid) : -1;
  const outs = [[me, index], [allyIndex >= 0 ? ally : null, allyIndex]].filter(([m, i]) => m && i >= 0);
  const byPid = new Map(outs.map(([m]) => [m.pid, { pid: m.pid, hp: m.hp, maxHp: m.maxHp, status: m.status }]));
  const standing = foe2 ? [foe, foe2].filter((x) => x.hp > 0) : [];
  return {
    // wild Pokémon carry the player's trainer ID
    kind: f.otId === me.otId ? 'wild' : 'trainer',
    ...(foe2 ? { double: true } : {}),
    enemy: enemyOf(f),
    ...(standing.length > 1 ? { foes: standing.map(enemyOf) } : {}),
    active: index >= 0 ? { index, hp: me.hp, maxHp: me.maxHp, status: me.status, ...(myTypes ? { types: myTypes } : {}) } : null,
    ...(outs.length > 1 ? { actives: outs.map(([m, i]) => ({ index: i, hp: m.hp, maxHp: m.maxHp, status: m.status })) } : {}),
    // the mons that are out as the structs have them (the copy can lag a hit behind), the others from the copy
    party: live ? live.map((m) => byPid.get(m.pid) || { pid: m.pid, hp: m.hp, maxHp: m.maxHp, status: m.status }) : [...byPid.values()],
  };
}

/**
 * The types a HeartGold/SoulSilver battler has right now (BattleMon type1/type2): Castform in the weather, Arceus with its
 * plate, Rotom's appliance, a type change in battle. Named with the ROM's type ids (LiveTables.withRom) and trusted once
 * the player's battler has read as its species' types in this session (state.typesDSOk) – before that, or without the
 * ROM's types, none (the species' or the form's types stand in).
 */
function structTypes(T, state, x, own = false) {
  const keys = T.types3?.keys;
  if (!keys || !x?.typeIds || x.typeIds.some((i) => i >= keys.length)) return null;
  const ks = [...new Set(x.typeIds.map((i) => keys[i]).filter((k) => k && k !== '???'))];
  if (!ks.length) return null;
  if (own && !state.typesDSOk && !x.form) {
    const want = T.types3.species?.[x.species];
    if (want && want.length === ks.length && want.every((k) => ks.includes(k))) state.typesDSOk = true;
  }
  return state.typesDSOk ? ks : null;
}

/** What the battle reader decided – for the diagnostics log (state.onDiag), only when it changes. */
function note(state, what, flag) {
  if (typeof state.onDiag !== 'function' || state.lastNote === what) return;
  state.lastNote = what;
  state.onDiag({ what, flag });
}

/**
 * Read the battle state: { kind: 'wild'|'trainer', tutorial?: true, enemy: { species, level, hp, maxHp, shiny, moves? }|null,
 * active: { index, hp?, maxHp? }|null, party?: [{ pid, hp, maxHp }] } – or null outside battle. A double battle
 * whose structs are known (HGSS) adds foes: [enemy, …] while both opponents stand and actives: [active, …] while
 * two of the player's own Pokémon are out; `enemy` / `active` stay the first of them.
 * `party` is the party just read with readLiveParty (DS needs it to tell the copies apart).
 */
/**
 * GBA: is gMain.inBattle set (addresses.json inBattle)? A cheap flag for the play view – an expanded engine's team
 * search that finds nothing during a battle has failed (nobody battles without a Pokémon). false for other systems.
 */
export function inBattleFlag(entry, read) {
  if (entry?.gen !== 3 || !entry.inBattle?.addr) return false;
  const b = read(hex(entry.inBattle.addr), 1);
  return !!b && !!(b[0] & hex(entry.inBattle.mask || '0x02'));
}

export function readLiveBattle(entry, read, T, state = {}, party = null) {
  if (!entry) return null;
  try {
    if (entry.gen <= 2) return withCatchRates(holdEnemy(state, entry.battleEnemy && entry.inBattle ? battleGB(entry, read, T, state, party) : null), entry, T);
    if (entry.gen === 3) return withCatchRates(holdEnemy(state, entry.enemyPartyAddr && entry.inBattle ? battleGen3(entry, read, T, state) : null), entry, T);
    if (entry.gen >= 6) {
      const fight = readGen67Battle(entry, read, party);
      // a wild fight with no ball in the bag can't be a catch (Birch's rescue on Route 101, the fights before the first
      // Poké Balls): the tracker asks no "not caught" question for it and shows no catch chance
      return withCatchRates(fight?.kind === 'wild' && ctrNoBalls(entry, read, state) === true ? { ...fight, balls: 'none' } : fight, entry, T);
    }
    return withCatchRates(battleDS(entry, read, T, state, party), entry, T);
  } catch {
    return null;
  }
}

/**
 * The battle as the tracker takes it: a catching demo or tutorial (readLiveBattle's `tutorial` – an NPC's battle, or the
 * Poké Dude's on the Teachy TV) is no battle of the player's – never an encounter, a missed encounter, a dupe, a catch
 * chance or a cause of death. → the battle, or null.
 */
export const playerBattle = (fight) => (fight?.tutorial ? null : fight);

/**
 * The opponents' catch rates for the catch chance (shared/catchrate.mjs): Gen 1/2 read one from RAM (gbCatch); the
 * others the species' from the running ROM's table (T.types3.catchRates, shared/live/romtypes.mjs – a hack's and the
 * randomizer's own) or, for the 3DS games, PKHeX's table of that game (catch3ds.mjs). Unknown: none.
 */
function withCatchRates(fight, entry, T) {
  if (!fight?.enemy) return fight;
  const rateOf = (f) => {
    if (!f?.species || f.catchRate) return f;
    const r = entry.gen >= 6 ? catchRate3ds(entry.id, f.species) : T?.types3?.catchRates?.[f.species];
    return r ? { ...f, catchRate: r } : f;
  };
  // (a new object: the DS reader keeps its last battle in its state and hands it out again)
  return { ...fight, enemy: rateOf(fight.enemy), ...(fight.foes ? { foes: fight.foes.map(rateOf) } : {}) };
}

/**
 * Gen 1–3: an opponent that can't be read for a poll (its struct being reloaded, a checksum mid-write) stays on the
 * panel for a few seconds instead of blinking out – until the battle ends or another one is read.
 */
function holdEnemy(state, fight) {
  if (!fight) {
    state.heldEnemy = null;
    return fight;
  }
  if (fight.enemy) {
    state.heldEnemy = { at: Date.now(), enemy: fight.enemy };
    return fight;
  }
  const h = state.heldEnemy;
  return h && Date.now() - h.at < 3000 ? { ...fight, enemy: h.enemy } : fight;
}

/**
 * The party with live battle HP folded in, so the tracker (and auto-death) sees a faint the moment it
 * happens instead of after the battle.
 */
export function withBattleHp(party, battle) {
  if (!battle || !party) return party;
  if (battle.party) {
    const byPid = new Map(battle.party.map((m) => [m.pid, m]));
    return party.map((m) => {
      const b = byPid.get(m.pid);
      // (a Pokémon that grew a level in this battle: the battle has its new max HP, the save party the old one until the end)
      return b ? { ...m, hp: m.maxHp > 0 ? Math.min(b.hp, m.maxHp) : b.hp, ...(b.status !== undefined ? { status: b.status } : {}) } : m;
    });
  }
  const a = battle.active;
  if (!a || a.hp === undefined || !party[a.index] || party[a.index].maxHp !== a.maxHp) return party;
  return party.map((m, i) => (i === a.index ? { ...m, hp: a.hp, ...(a.status !== undefined ? { status: a.status } : {}) } : m));
}

/**
 * A Pokémon that drops to 0 HP counts as down once the next read says 0 too. Every reader checks what it can (checksums,
 * torn structs, the battle's own structs), but a death is final – it takes the partner's Pokémon with it – and one read of
 * a struct the game is rewriting, or of the wrong struct, must never be enough for it (#12: a Pokémon that grew a level
 * on the bench showed 0 HP for a moment). On the first read the Pokémon keeps the HP it had before; a real faint stays
 * at 0 and shows one poll later. A Pokémon already at 0 HP when tracking starts isn't held (there is no HP to hold).
 * `state` is the reader state of the session (the same object every poll). → the party, held HP where needed.
 */
export function confirmFaints(party, state) {
  if (!Array.isArray(party)) return party;
  const before = state.faintHp || new Map(); // key → the HP reported last time
  const zero = state.faintZero || new Set(); // keys read at 0 last time
  const nextHp = new Map();
  const nextZero = new Set();
  const out = party.map((m) => {
    const id = m?.key;
    if (!id) return m;
    const down = m.maxHp > 0 && m.hp === 0;
    if (!down) {
      nextHp.set(id, m.hp);
      return m;
    }
    nextZero.add(id);
    const was = before.get(id);
    if (zero.has(id) || !(was > 0)) {
      nextHp.set(id, 0);
      return m;
    }
    nextHp.set(id, was); // first read at 0: wait for the next one
    return { ...m, hp: Math.min(was, m.maxHp) };
  });
  state.faintHp = nextHp;
  state.faintZero = nextZero;
  return out;
}

/** Bus reader over streamed regions [{ addr, hex }] (mGBA bridge). */
export function regionReader(regions) {
  const bufs = regions.map((r) => {
    const b = new Uint8Array(r.hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(r.hex.substr(i * 2, 2), 16);
    return { addr: r.addr, b };
  });
  return (addr, len) => {
    for (const { addr: a, b } of bufs) if (addr >= a && addr + len <= a + b.length) return b.subarray(addr - a, addr - a + len);
    return null;
  };
}

export { u24be };
