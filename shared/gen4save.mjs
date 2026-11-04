// Pokémon HeartGold / SoulSilver battery save parser (512 KB .sav, also DeSmuME .dsv).
// Spec: research/gen4_formats.md (offsets verified against PKHeX + pokeheartgold decomp).

const PARTITION = 0x40000;
const GENERAL_SIZE = 0xf628;
const STORAGE_START = 0xf700;
const STORAGE_SIZE = 0x12310;
const MAGICS = [0x20060623, 0x20070903];
const PARTY_OFFSET = 0x98;
const PARTY_COUNT = 0x94;
const BOX_COUNT = 18;
const BOX_SLOTS = 30;
const BOX_SIZE = 0x1000;
const PK_STORED = 136;
const PK_PARTY = 236;

const BLOCK_POSITION = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 3, 1, 2], [0, 2, 3, 1], [0, 3, 2, 1],
  [1, 0, 2, 3], [1, 0, 3, 2], [2, 0, 1, 3], [3, 0, 1, 2], [2, 0, 3, 1], [3, 0, 2, 1],
  [1, 2, 0, 3], [1, 3, 0, 2], [2, 1, 0, 3], [3, 1, 0, 2], [2, 3, 0, 1], [3, 2, 0, 1],
  [1, 2, 3, 0], [1, 3, 2, 0], [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0],
];
const BLOCK_POSITION_INVERT = [0, 1, 2, 4, 3, 5, 6, 7, 12, 18, 13, 19, 8, 10, 14, 20, 16, 22, 9, 11, 15, 21, 17, 23];

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const w32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };

export function crc16ccitt(u8, start, end) {
  let top = 0xff;
  let bot = 0xff;
  for (let i = start; i < end; i++) {
    let x = u8[i] ^ top;
    x ^= x >> 4;
    top = (bot ^ (x >> 3) ^ (x << 4)) & 0xff;
    bot = (x ^ (x << 5)) & 0xff;
  }
  return (top << 8) | bot;
}

function footer(u8, base, size) {
  const end = base + size;
  const count = u32(u8, end - 0x10);
  const fsize = u32(u8, end - 0x0c);
  const magic = u32(u8, end - 0x08);
  const crc = u16(u8, end - 0x02);
  const valid = fsize === size && MAGICS.includes(magic) && count !== 0xffffffff && crc16ccitt(u8, base, end - 0x10) === crc;
  return { count, valid };
}

function cryptArray(u8, start, end, seed) {
  for (let i = start; i < end; i += 2) {
    seed = (Math.imul(0x41c64e6d, seed) + 0x6073) >>> 0;
    const v = (u8[i] | (u8[i + 1] << 8)) ^ (seed >>> 16);
    u8[i] = v & 0xff;
    u8[i + 1] = v >> 8;
  }
}

export function decryptPK4(src) {
  const d = src.slice();
  const pid = u32(d, 0);
  const chk = u16(d, 6);
  cryptArray(d, 8, 136, chk);
  if (d.length > 136) cryptArray(d, 136, d.length, pid);
  const row = BLOCK_POSITION[((pid >>> 13) & 31) % 24];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i] * 32, 8 + row[i] * 32 + 32), 8 + i * 32);
  let sum = 0;
  for (let i = 8; i < 136; i += 2) sum = (sum + u16(out, i)) & 0xffff;
  return { data: out, checksumOk: sum === chk };
}

/** Inverse of decryptPK4 (used by tests to build synthetic saves). */
export function encryptPK4(plain) {
  const d = plain.slice();
  const pid = u32(d, 0);
  let sum = 0;
  for (let i = 8; i < 136; i += 2) sum = (sum + u16(d, i)) & 0xffff;
  w16(d, 6, sum);
  const row = BLOCK_POSITION[BLOCK_POSITION_INVERT[((pid >>> 13) & 31) % 24]];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i] * 32, 8 + row[i] * 32 + 32), 8 + i * 32);
  cryptArray(out, 8, 136, sum);
  if (out.length > 136) cryptArray(out, 136, out.length, pid);
  return out;
}

/** Recompute both footers of one partition (tests / tooling). */
export function writeFooters(u8, partition, count) {
  for (const [start, size, slot] of [[0, GENERAL_SIZE, 0], [STORAGE_START, STORAGE_SIZE, 1]]) {
    const base = partition + start;
    const end = base + size;
    w32(u8, end - 0x10, count);
    w32(u8, end - 0x0c, size);
    w32(u8, end - 0x08, MAGICS[0]);
    w16(u8, end - 0x04, slot);
    w16(u8, end - 0x02, crc16ccitt(u8, base, end - 0x10));
  }
}

export const SAVE_LAYOUT = { PARTITION, GENERAL_SIZE, STORAGE_START, STORAGE_SIZE, PARTY_OFFSET, PARTY_COUNT, BOX_SIZE, PK_STORED, PK_PARTY };

export function decodeString(u8, off, maxChars, chars) {
  let s = '';
  for (let i = 0; i < maxChars; i++) {
    const c = u16(u8, off + i * 2);
    if (c === 0xffff || c === 0) break;
    s += chars[c] ?? '';
  }
  return s;
}

function levelFromExp(exp, growth, expTable) {
  const t = expTable[String(growth)];
  if (!t) return null;
  let lvl = 1;
  for (let l = 1; l <= 100; l++) {
    if (t[l - 1] <= exp) lvl = l;
    else break;
  }
  return lvl;
}

function parseMon(raw, data, { party }) {
  if (raw.every((b) => b === 0)) return null;
  const { data: d, checksumOk } = decryptPK4(raw);
  const species = u16(d, 0x08);
  if (!species) return null;
  const pid = u32(d, 0);
  const tid = u16(d, 0x0c);
  const sid = u16(d, 0x0e);
  const iv32 = u32(d, 0x38);
  const isEgg = !!(iv32 & 0x40000000);
  const metExt = u16(d, 0x46);
  const metLocation = metExt !== 0 ? metExt : u16(d, 0x80);
  const eggExt = u16(d, 0x44);
  const eggLocation = eggExt !== 0 ? eggExt : u16(d, 0x7e);
  const exp = u32(d, 0x10);
  const formByte = d[0x40];
  const mon = {
    key: `${pid.toString(16).padStart(8, '0')}-${tid}-${sid}`,
    pid,
    species,
    speciesName: data?.species?.[species] || `#${species}`,
    form: formByte >> 3,
    gender: ['M', 'F', '-'][(formByte >> 1) & 3] || '-',
    nickname: decodeString(d, 0x48, 11, data?.chars || {}),
    nicknamed: !!(iv32 & 0x80000000),
    isEgg,
    ot: decodeString(d, 0x68, 8, data?.chars || {}),
    tid,
    sid,
    heldItem: u16(d, 0x0a),
    exp,
    friendship: d[0x14],
    ability: d[0x15],
    nature: pid % 25,
    moves: [u16(d, 0x28), u16(d, 0x2a), u16(d, 0x2c), u16(d, 0x2e)].filter(Boolean),
    ivs: [0, 5, 10, 15, 20, 25].map((s) => (iv32 >>> s) & 31), // HP Atk Def Spe SpA SpD
    metLocation,
    eggLocation,
    metLevel: d[0x84] & 0x7f,
    metDate: d[0x7b] ? `20${String(d[0x7b]).padStart(2, '0')}-${String(d[0x7c]).padStart(2, '0')}-${String(d[0x7d]).padStart(2, '0')}` : null,
    ball: Math.max(d[0x86], d[0x83]),
    originGame: d[0x5f],
    shiny: (((pid >>> 16) ^ (pid & 0xffff) ^ tid ^ sid) >>> 0) < 8,
    checksumOk,
  };
  if (party && raw.length >= PK_PARTY) {
    mon.status = u32(d, 0x88) & 0xff;
    mon.level = d[0x8c];
    mon.hp = u16(d, 0x8e);
    mon.maxHp = u16(d, 0x90);
    mon.stats = [u16(d, 0x90), u16(d, 0x92), u16(d, 0x94), u16(d, 0x98), u16(d, 0x9a), u16(d, 0x96)]; // HP Atk Def SpA SpD Spe
  } else if (data?.growth && data?.exp) {
    mon.level = levelFromExp(exp, data.growth[species] ?? 0, data.exp);
  }
  return mon;
}

function pickPartition(u8) {
  const parts = [0, PARTITION].map((p) => {
    const g = footer(u8, p, GENERAL_SIZE);
    const s = footer(u8, p + STORAGE_START, STORAGE_SIZE);
    return { p, g, s, ok: g.valid && s.valid && g.count === s.count };
  });
  const good = parts.filter((x) => x.ok).sort((a, b) => b.g.count - a.g.count);
  if (good.length) return { general: good[0].p, storage: good[0].p + STORAGE_START, counter: good[0].g.count, coherent: true };
  // Fallback: choose general and storage independently.
  const gens = parts.filter((x) => x.g.valid).sort((a, b) => b.g.count - a.g.count);
  const stor = parts.filter((x) => x.s.valid).sort((a, b) => b.s.count - a.s.count);
  if (!gens.length) return null;
  return { general: gens[0].p, storage: stor.length ? stor[0].p + STORAGE_START : null, counter: gens[0].g.count, coherent: false };
}

/**
 * Parse a HGSS save.
 * @param {Uint8Array} file  raw .sav/.dsv contents
 * @param {object} data      shared/data/gen4.json (names, char table, exp tables)
 */
export function parseHgssSave(file, data) {
  if (file.length < 0x40000) throw new Error(`Save zu klein (${file.length} Bytes) – erwartet 512 KB`);
  // DeSmuME (and older souldew builds) keep a save only up to the last byte the game wrote: a fresh game has just the
  // first half (256 KB + 1). The rest of the 512 KB flash is erased – 0xFF – and the first partition holds the save.
  let u8 = file.length === 0x80000 ? file : file.subarray(0, 0x80000);
  if (u8.length < 0x80000) {
    const full = new Uint8Array(0x80000).fill(0xff);
    full.set(u8);
    u8 = full;
  }
  const pick = pickPartition(u8);
  if (!pick) throw new Error('Kein gültiger Spielstand gefunden (noch nie im Spiel gespeichert?)');
  const g = pick.general;
  const chars = data?.chars || {};
  const johto = u8[g + 0x7e];
  const kanto = u8[g + 0x83];
  const bits = (v) => Array.from({ length: 8 }, (_, i) => !!(v & (1 << i)));
  const partyCount = Math.min(6, u32(u8, g + PARTY_COUNT));
  const party = [];
  for (let i = 0; i < partyCount; i++) {
    const off = g + PARTY_OFFSET + i * PK_PARTY;
    const mon = parseMon(u8.subarray(off, off + PK_PARTY), data, { party: true });
    if (mon) party.push({ ...mon, slot: i });
  }
  const boxes = [];
  if (pick.storage !== null) {
    for (let b = 0; b < BOX_COUNT; b++) {
      for (let s = 0; s < BOX_SLOTS; s++) {
        const off = pick.storage + b * BOX_SIZE + s * PK_STORED;
        const mon = parseMon(u8.subarray(off, off + PK_STORED), data, { party: false });
        if (mon) boxes.push({ ...mon, box: b, slot: s });
      }
    }
  }
  const zone = u16(u8, g + 0x1234);
  return {
    counter: pick.counter,
    coherent: pick.coherent,
    trainer: {
      name: decodeString(u8, g + 0x64, 8, chars),
      tid: u16(u8, g + 0x74),
      sid: u16(u8, g + 0x76),
      money: u32(u8, g + 0x78),
      gender: u8[g + 0x7c] ? 'F' : 'M',
      version: u8[g + 0x80] === 8 ? 'SS' : 'HG',
    },
    badges: {
      johto: bits(johto),
      kanto: bits(kanto),
      count: bits(johto).filter(Boolean).length + bits(kanto).filter(Boolean).length,
    },
    playTime: { h: u16(u8, g + 0x86), m: u8[g + 0x88], s: u8[g + 0x89] },
    zone,
    party,
    boxes,
  };
}

export function locationName(id, data) {
  if (id >= 2000) return data?.locationsSpecial?.[String(id)] || `Ort ${id}`;
  return data?.locations?.[id] || `Ort ${id}`;
}

function monKey(raw) {
  const { data: d } = decryptPK4(raw);
  const pid = u32(d, 0);
  return { key: `${pid.toString(16).padStart(8, '0')}-${u16(d, 0x0c)}-${u16(d, 0x0e)}`, plain: d, species: u16(d, 0x08) };
}

/**
 * Move party Pokémon (by key "pid-tid-sid") into a graveyard box, newest partition only.
 * Works on a copy; the caller writes the result back. The emulator MUST be closed, otherwise
 * it overwrites the file with its in-memory save on the next flush.
 * @returns {{ file: Uint8Array, moved: string[], box: number }}
 */
export function moveToGraveyard(file, keys, { box = BOX_COUNT - 1 } = {}) {
  // a save cut after the last written byte (see parseHgssSave) is written back whole: 512 KB, the rest erased
  const out = file.length >= 0x80000 ? file.slice() : new Uint8Array(0x80000).fill(0xff);
  if (file.length < 0x80000) out.set(file);
  const u8 = out.length === 0x80000 ? out : out.subarray(0, 0x80000);
  const pick = pickPartition(u8);
  if (!pick || !pick.coherent) throw new Error('Spielstand ist nicht eindeutig – bitte einmal im Spiel speichern und erneut versuchen.');
  const g = pick.general;
  const s = pick.storage;
  const count = Math.min(6, u32(u8, g + PARTY_COUNT));
  const party = [];
  for (let i = 0; i < count; i++) {
    const off = g + PARTY_OFFSET + i * PK_PARTY;
    party.push(u8.slice(off, off + PK_PARTY));
  }
  const wanted = new Set(keys);
  const keep = [];
  const moving = [];
  for (const raw of party) {
    const k = monKey(raw);
    if (wanted.has(k.key)) moving.push(k);
    else keep.push(raw);
  }
  if (!moving.length) return { file: out, moved: [], box };
  if (!keep.length) throw new Error('Das Team darf nicht leer werden – mindestens ein Pokémon muss im Team bleiben.');

  // Free slots, starting with the graveyard box and walking backwards through the boxes.
  const free = [];
  for (let b = box; b >= 0 && free.length < moving.length; b--) {
    for (let slot = 0; slot < BOX_SLOTS && free.length < moving.length; slot++) {
      const off = s + b * BOX_SIZE + slot * PK_STORED;
      const raw = u8.subarray(off, off + PK_STORED);
      const empty = raw.every((x) => x === 0) || u16(decryptPK4(raw).data, 0x08) === 0;
      if (empty) free.push({ off, b });
    }
  }
  if (free.length < moving.length) throw new Error('Keine freien Box-Plätze mehr.');

  const touchedBoxes = new Set();
  moving.forEach((m, i) => {
    const plain = m.plain.slice(0, PK_STORED);
    plain[4] = 0; // sanity flags: not "party decrypted"
    plain[5] = 0;
    u8.set(encryptPK4(plain), free[i].off);
    touchedBoxes.add(free[i].b);
  });
  // Compact the party.
  for (let i = 0; i < 6; i++) {
    const off = g + PARTY_OFFSET + i * PK_PARTY;
    if (i < keep.length) u8.set(keep[i], off);
    else u8.fill(0, off, off + PK_PARTY);
  }
  w32(u8, g + PARTY_COUNT, keep.length);
  // Mark the boxes as modified (HGSS uses these flags for partial PC saves).
  let flags = u32(u8, s + 0x12004);
  for (const b of touchedBoxes) flags |= 1 << b;
  w32(u8, s + 0x12004, flags >>> 0);
  writeFooters(u8, g, pick.counter);
  return { file: out, moved: moving.map((m) => m.key), box };
}
