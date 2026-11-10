// Live party readers for Gen 1–5. Works on any memory source that can read system bus addresses:
// the integrated emulator (WASM heap), the mGBA Lua bridge (streamed regions) or a RAM dump.
// Output is the same normalized mon shape the save parser produces, so the SoulLink logic
// doesn't care where the data came from.
// Addresses/structs: research/live_ram.md (pret disassemblies + PKHeX), shared/data/addresses.json.
import { decryptPK4 } from '../gen4save.mjs';

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
  for (const g of games) {
    const m = g.match || {};
    if (m.title && title && (g.platform === 'gb' || g.platform === 'gbc') && title.startsWith(String(m.title).toUpperCase())) return g;
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
  withSpecies(sp) {
    if (!sp?.map) return this;
    const t = Object.create(this);
    t.idx3 = sp.map;
    t.fake3 = sp.unknown && Object.keys(sp.unknown).length ? sp.unknown : null;
    return t;
  }
}

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
  if (sum !== u16le(d, 28)) return { bad: true };
  const order = GEN3_ORDERS[pid % 24];
  const sub = (ch) => data.subarray(order.indexOf(ch) * 12, order.indexOf(ch) * 12 + 12);
  const G = sub('G');
  const A = sub('A');
  const M = sub('M');
  const internal = u16le(G, 0);
  const species = T.idx3?.[internal] || (T.fake3?.[internal] ? FAKEMON + internal : 0);
  if (!species) return null;
  const origins = u16le(M, 2);
  const ivs = u32le(M, 4);
  const shiny = (((pid >>> 16) ^ (pid & 0xffff) ^ (otId >>> 16) ^ (otId & 0xffff)) >>> 0) < 8;
  return {
    key: `g3-${pid.toString(16).padStart(8, '0')}-${otId.toString(16)}`,
    pid, species, nickname: decodeText(d.subarray(8, 18), T.cs3, 0xff), item: u16le(G, 2),
    moves: [u16le(A, 0), u16le(A, 2), u16le(A, 4), u16le(A, 6)].filter(Boolean),
    metLocation: M[1], metLevel: origins & 0x7f, isEgg: !!(ivs & 0x40000000), shiny,
    status: u32le(d, 80) & 0xff, level: d[84], hp: u16le(d, 86), maxHp: u16le(d, 88),
  };
}

function gen3StatsOk(d, isEgg) {
  for (let o = 88; o < 100; o += 2) {
    const v = u16le(d, o);
    if (v > 999) return false;
  }
  return true;
}

function readGen3(entry, read, T, state = {}) {
  const c = read(hex(entry.partyCountAddr), 1);
  if (!c) return null;
  const count = c[0];
  if (count > 6) return { invalid: true };
  const raw = read(hex(entry.partyAddr), entry.structSize * count);
  if (!raw) return null;
  const party = [];
  for (let i = 0; i < count; i++) {
    const slot = raw.subarray(i * 100, i * 100 + 100);
    const m = parsePk3(slot, T);
    if (!m) continue;
    if (m.bad) {
      // A checksum mismatch is normally a read while the game writes the struct ("torn") – try again next poll.
      // The very same bytes failing for several polls is a Bad Egg: skip that slot instead of stopping tracking.
      const sig = `${i}:${Array.prototype.join.call(slot.subarray(0, 32), ',')}`;
      state.badSeen = state.badSig === sig ? (state.badSeen || 0) + 1 : 1;
      state.badSig = sig;
      if (state.badSeen < 3) return { torn: true };
      continue;
    }
    if (m.level < 1 || m.level > 100 || m.hp > m.maxHp) return { invalid: true };
    // Level, HP and stats (80-99) are neither encrypted nor checksummed: a slot the party menu is swapping reads as
    // one mon with the other's numbers – or the same mon twice. Stats over 999 or a duplicate: try again next poll.
    if (party.some((x) => x.pid === m.pid) || !gen3StatsOk(slot, m.isEgg)) return { torn: true };
    party.push(m);
  }
  return { party };
}

// ---------------------------------------------------------------------------
// Gen 4 / 5 (DS): party inside the heap-allocated save buffer. Prefer the pointer from the
// decomp linker maps; fall back to scanning main RAM for PartyCore { 6, count, mons[6] }.

// Gen 4/5 status word (pokeheartgold include/constants/battle.h): sleep turns (bits 0-2), or one of poison, burn,
// freeze, paralysis, or toxic (bit 7) with its counter in bits 8-11.
const statusOk = (s) => s === 0 || (s & ~7) === 0 || s === 8 || s === 16 || s === 32 || s === 64 || ((s & ~0xf80) === 0 && !!(s & 0x80));

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
  return {
    key: `${pid.toString(16).padStart(8, '0')}-${tid}-${sid}`,
    pid, species, nickname, isEgg: !!(iv32 & 0x40000000), item: u16le(d, 0x0a),
    moves: [u16le(d, 0x28), u16le(d, 0x2a), u16le(d, 0x2c), u16le(d, 0x2e)].filter(Boolean),
    metLocation, metLevel: d[0x84] & 0x7f, gender: ['M', 'F', '-'][(d[0x40] >> 1) & 3],
    shiny: (((pid >>> 16) ^ (pid & 0xffff) ^ tid ^ sid) >>> 0) < 8,
    status: d[0x88], level: d[0x8c], hp: u16le(d, 0x8e), maxHp: u16le(d, 0x90),
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
      return { party, boxes: readBoxesGen4(entry, read, T, state), badges: readBadgesGen4(entry, read, state) };
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
    if (party) {
      saveBaseFromScan(entry, read, state);
      return { party };
    }
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
  return party ? { party } : null;
}

/**
 * Scanned party (other languages): if Ironmon's module-params pointer leads to exactly this party, that pointer is
 * the save data – the battle mon struct (battleActive) is found relative to it.
 */
function saveBaseFromScan(entry, read, state) {
  if (state.saveBase || !entry.partyMonsOffset || !entry.battleActive?.pidOffsetFromSaveBase) return;
  const mp = read(/^(diamond|pearl)/.test(entry.id) ? 0x02000b70 : 0x02000ba8, 4);
  const mpv = mp ? u32le(mp, 0) : 0;
  if (mpv < 0x02000000 || mpv >= 0x02400000) return;
  const p = read(mpv + 0x20, 4);
  const base = p ? u32le(p, 0) : 0;
  if (base >= 0x02000000 && base < 0x02400000 && base + hex(entry.partyMonsOffset) - 8 === state.partyAddr) state.saveBase = base;
}

/** HGSS badges sit in the general block of the save image in RAM, like in the .sav file. */
function readBadgesGen4(entry, read, state) {
  const b = entry.badges;
  if (!b?.johtoOffset || !state.saveBase) return undefined;
  const general = state.saveBase + hex(b.generalOffsetFromSaveBase);
  const j = read(general + hex(b.johtoOffset), 1);
  const k = read(general + hex(b.kantoOffset), 1);
  return j && k ? popcount(j[0]) + popcount(k[0]) : undefined;
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
  const res = entry.gen === 3 ? readGen3(entry, read, T, state) : readDS(entry, read, T, state);
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
  if (stale?.enemy) return { kind: mode === 1 ? 'wild' : 'trainer', enemy: null, active: null };
  const enemyRaw = read(hex(e.speciesAddr), 1)?.[0];
  const species = entry.gen === 1 ? T.idx1?.[enemyRaw] || 0 : enemyRaw;
  const level = read(hex(e.levelAddr), 1)?.[0];
  const ehp = read(hex(e.hpAddr), 2);
  const emax = read(hex(e.maxHpAddr), 2);
  const dvs = read(hex(e.dvsAddr), 2);
  const enemy = species && species <= 251 && level >= 1 && level <= 100 && ehp && emax
    ? { species, level, hp: u16be(ehp, 0), maxHp: u16be(emax, 0), shiny: entry.gen === 2 && !!dvs && gbShiny(u16be(dvs, 0)) }
    : null;
  // half-loaded (the next trainer Pokémon being sent out): no opponent for a moment, still a battle
  const filled = enemy && enemy.maxHp > 0 && enemy.hp <= enemy.maxHp ? enemy : null;
  return { kind: mode === 1 ? 'wild' : 'trainer', enemy: filled, active: activeGB(entry, read, T, state, party, stale) };
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

function battleGen3(entry, read, T) {
  const flag = read(hex(entry.inBattle.addr), 1)?.[0];
  if (flag === undefined || !(flag & hex(entry.inBattle.mask || '0x02'))) return null;
  const types = read(hex(entry.battleTypeFlagsAddr), 4);
  const trainer = !!types && !!(u32le(types, 0) & 0x08); // BATTLE_TYPE_TRAINER
  // gBattlerPartyIndexes: battler 1 is the opponent's first slot
  const idx = entry.liveBattleHp?.battlerPartyIndexesAddr ? read(hex(entry.liveBattleHp.battlerPartyIndexesAddr), 8) : null;
  const enemyIndex = idx ? u16le(idx, 2) : 0;
  const raw = read(hex(entry.enemyPartyAddr) + (enemyIndex < 6 ? enemyIndex : 0) * 100, 100);
  const m = raw && parsePk3(raw, T);
  const enemy = m && !m.bad && m.level >= 1 && m.level <= 100 ? { species: m.species, level: m.level, hp: m.hp, maxHp: m.maxHp, shiny: m.shiny, moves: m.moves } : null;
  const index = idx ? u16le(idx, 0) : null;
  return { kind: trainer ? 'trainer' : 'wild', enemy, active: index !== null && index < 6 ? { index } : null };
}

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

function battleFlag(entry, read) {
  if (!entry.inBattle?.addr || !/^heartgold|^soulsilver/.test(entry.id)) return null;
  const f = read(hex(entry.inBattle.addr), 2);
  if (!f) return null;
  const v = u16le(f, 0);
  if ((entry.inBattle.inBattleValues || []).map(hex).includes(v)) return true;
  if ((entry.inBattle.notInBattleValues || []).map(hex).includes(v)) return false;
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
const shinyOf = (pid, otId) => (((pid >>> 16) ^ (pid & 0xffff) ^ (otId >>> 16) ^ (otId & 0xffff)) >>> 0) < 8;

function battleDS(entry, read, T, state, party) {
  if (!party?.length) return null;
  const now = Date.now();
  const flag = battleFlag(entry, read);
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
    state.battleHp = state.activePid = null;
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
      // wild mons carry the player's ID too. The opponent also has a frozen copy (the battle setup) next to
      // the live one – the live one is the one that has taken damage.
      const hp = mons.reduce((n, m) => n + m.hp, 0);
      if (!enemy || (enemy.sig === mons.map((m) => m.pid).join() && hp < enemy.hp)) enemy = { addr, mons, hp, sig: mons.map((m) => m.pid).join() };
    }
  }
  state.heldCopies = nextHeld;
  const live = mine?.mons || null;
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
    if (use) return (state.battle = structBattle(use, party, live));
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
  // Without a flag: "an opponent party that changed recently, or a player copy with different HP".
  const on = flag ?? ((!!enemy && now - (state.enemySince || 0) < 90000) || anyDiff);
  if (!on || !enemy) {
    if (flag === null && state.battle) retireCopies(read, size, entry.gen, T, state); // battle ended (no flag)
    state.battle = null;
    state.battleHp = state.activePid = null;
    return null;
  }
  // The active opponent: first one still standing (trainers send them in order).
  const foe = enemy.mons.find((m) => m.hp > 0) || enemy.mons[0];
  // Active player mon. Where we know the battle mon struct, its PID says who is out – a switch shows at once.
  // Otherwise: the last one whose HP changed in this battle (it took the hit – that follows a switch), else the
  // first one standing (the lead unless it fainted).
  const real = battleMonPid(entry, read, state, party);
  if (live) {
    const prev = state.battleHp || new Map();
    if (!real) for (const m of live) if (prev.has(m.pid) && prev.get(m.pid) !== m.hp) state.activePid = m.pid;
    state.battleHp = new Map(live.map((m) => [m.pid, m.hp]));
  }
  if (real) state.activePid = real;
  // The index is the save party's (the panel and the HP fold use that order) – the copy may be ordered otherwise.
  const byPid = new Map((live || party).map((m) => [m.pid, m]));
  const standing = (m) => (byPid.get(m.pid)?.hp ?? m.hp) > 0;
  const hit = party.findIndex((m) => m.pid === state.activePid && (real || standing(m)));
  const index = live || real ? (hit >= 0 ? hit : Math.max(0, party.findIndex(standing))) : null;
  const cur = index !== null ? byPid.get(party[index].pid) || party[index] : null;
  note(state, `heap ${foe.species}/${foe.level}`, flag);
  state.battle = {
    kind: enemy.mons.length > 1 || foe.key.split('-')[1] !== tid ? 'trainer' : 'wild',
    enemy: { species: foe.species, level: foe.level, hp: foe.hp, maxHp: foe.maxHp, shiny: foe.shiny, moves: foe.moves },
    active: cur ? { index, hp: cur.hp, maxHp: cur.maxHp, status: cur.status } : null,
    // the battle's own party copy: HP and status conditions as they are now (the save party gets them at the end)
    party: live && live.map((m) => ({ pid: m.pid, hp: m.hp, maxHp: m.maxHp, status: m.status })),
  };
  return state.battle;
}

/** The battle from the battle structs; `live` is the battle's party copy (HP of the mons that aren't out). */
function structBattle({ me, foe, foe2 }, party, live) {
  // a double battle: the one still standing (battler 1 first)
  const f = foe.hp === 0 && foe2?.hp > 0 ? foe2 : foe;
  const index = party.findIndex((p) => p.pid === me.pid);
  const out = { pid: me.pid, hp: me.hp, maxHp: me.maxHp, status: me.status };
  return {
    // wild Pokémon carry the player's trainer ID
    kind: f.otId === me.otId ? 'wild' : 'trainer',
    ...(foe2 ? { double: true } : {}),
    enemy: { species: f.species, level: f.level, hp: f.hp, maxHp: f.maxHp, shiny: shinyOf(f.pid, f.otId), moves: f.moves },
    active: index >= 0 ? { index, hp: me.hp, maxHp: me.maxHp, status: me.status } : null,
    // the mon that is out as the struct has it (the copy can lag a hit behind), the others from the copy
    party: live ? live.map((m) => (m.pid === me.pid ? out : { pid: m.pid, hp: m.hp, maxHp: m.maxHp, status: m.status })) : [out],
  };
}

/** What the battle reader decided – for the diagnostics log (state.onDiag), only when it changes. */
function note(state, what, flag) {
  if (typeof state.onDiag !== 'function' || state.lastNote === what) return;
  state.lastNote = what;
  state.onDiag({ what, flag });
}

/**
 * Read the battle state: { kind: 'wild'|'trainer', enemy: { species, level, hp, maxHp, shiny, moves? }|null,
 * active: { index, hp?, maxHp? }|null, party?: [{ pid, hp, maxHp }] } – or null outside battle.
 * `party` is the party just read with readLiveParty (DS needs it to tell the copies apart).
 */
export function readLiveBattle(entry, read, T, state = {}, party = null) {
  if (!entry) return null;
  try {
    if (entry.gen <= 2) return holdEnemy(state, entry.battleEnemy && entry.inBattle ? battleGB(entry, read, T, state, party) : null);
    if (entry.gen === 3) return holdEnemy(state, entry.enemyPartyAddr && entry.inBattle ? battleGen3(entry, read, T) : null);
    return battleDS(entry, read, T, state, party);
  } catch {
    return null;
  }
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
      return b ? { ...m, hp: b.hp, ...(b.status !== undefined ? { status: b.status } : {}) } : m;
    });
  }
  const a = battle.active;
  if (!a || a.hp === undefined || !party[a.index] || party[a.index].maxHp !== a.maxHp) return party;
  return party.map((m, i) => (i === a.index ? { ...m, hp: a.hp, ...(a.status !== undefined ? { status: a.status } : {}) } : m));
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
