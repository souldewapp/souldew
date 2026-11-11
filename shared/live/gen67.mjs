// Gen 6 / 7 (Nintendo 3DS: X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon, Ultra Sun/Ultra Moon) – the party in the running
// game's memory, read through Azahar's RPC server (server/lib/azahar.mjs).
//
// The party lies at a fixed address in the game's process (one per game and update version), six slots of 0x1E4 bytes:
// the encrypted 232-byte PK6/PK7 box data, and at +0x158 its encrypted party stats (status, level, HP, stats – the
// PK6 bytes 0xE8…). Addresses: Citra-Tracker (kcblack42) and Pokémon Stream Tool (Readek) agree on them, and XY's /
// ORAS's update moves the party and the badges by the same distance in both.
//
// PK6/PK7 crypto (PKHeX PokeCrypto): the encryption constant (bytes 0–3) seeds the LCG over 0x08–0xE7 and, started
// again, over the party stats; the four 56-byte blocks are shuffled by ((EC >> 13) & 31) % 24 like in Gen 4/5; the
// checksum (0x06) is the 16-bit sum of 0x08–0xE7.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));

export const SLOT_STRIDE = 0x1e4;
export const BOX_SIZE = 0xe8; // 232
export const STATS_OFFSET = 0x158; // party stats inside a RAM slot
export const STATS_SIZE = 0x1c; // PK6 0xE8–0x103
export const PARTY_BYTES = 6 * SLOT_STRIDE;

const BLOCK = 56;
const BLOCK_POSITION = [
  [0, 1, 2, 3], [0, 1, 3, 2], [0, 2, 1, 3], [0, 3, 1, 2], [0, 2, 3, 1], [0, 3, 2, 1],
  [1, 0, 2, 3], [1, 0, 3, 2], [2, 0, 1, 3], [3, 0, 1, 2], [2, 0, 3, 1], [3, 0, 2, 1],
  [1, 2, 0, 3], [1, 3, 0, 2], [2, 1, 0, 3], [3, 1, 0, 2], [2, 3, 0, 1], [3, 2, 0, 1],
  [1, 2, 3, 0], [1, 3, 2, 0], [2, 1, 3, 0], [3, 1, 2, 0], [2, 3, 1, 0], [3, 2, 1, 0],
];
const BLOCK_POSITION_INVERT = [0, 1, 2, 4, 3, 5, 6, 7, 12, 18, 13, 19, 8, 10, 14, 20, 16, 22, 9, 11, 15, 21, 17, 23];

function cryptArray(u8, start, end, seed) {
  for (let i = start; i + 1 < end; i += 2) {
    seed = (Math.imul(0x41c64e6d, seed) + 0x6073) >>> 0;
    const v = (u8[i] | (u8[i + 1] << 8)) ^ (seed >>> 16);
    u8[i] = v & 0xff;
    u8[i + 1] = v >> 8;
  }
}

/** Decrypt a PK6/PK7 (232 bytes, or 260 with the party stats). */
export function decryptPK6(src) {
  const d = Uint8Array.from(src);
  const ec = u32(d, 0);
  cryptArray(d, 8, BOX_SIZE, ec);
  if (d.length > BOX_SIZE) cryptArray(d, BOX_SIZE, d.length, ec);
  const row = BLOCK_POSITION[((ec >>> 13) & 31) % 24];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i] * BLOCK, 8 + row[i] * BLOCK + BLOCK), 8 + i * BLOCK);
  let sum = 0;
  for (let i = 8; i < BOX_SIZE; i += 2) sum = (sum + u16(out, i)) & 0xffff;
  return { data: out, checksumOk: sum === u16(out, 6) };
}

/** Inverse of decryptPK6 – writes the checksum (tests, fixtures). */
export function encryptPK6(plain) {
  const d = Uint8Array.from(plain);
  const ec = u32(d, 0);
  let sum = 0;
  for (let i = 8; i < BOX_SIZE; i += 2) sum = (sum + u16(d, i)) & 0xffff;
  w16(d, 6, sum);
  const row = BLOCK_POSITION[BLOCK_POSITION_INVERT[((ec >>> 13) & 31) % 24]];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i] * BLOCK, 8 + row[i] * BLOCK + BLOCK), 8 + i * BLOCK);
  cryptArray(out, 8, BOX_SIZE, ec);
  if (out.length > BOX_SIZE) cryptArray(out, BOX_SIZE, out.length, ec);
  return out;
}

// Gen 6/7 text is UTF-16; the gender signs sit in the private use area.
const CHAR_FIX = { 0xe08e: '♂', 0xe08f: '♀', 0xe08d: '…' };
function text(d, off, maxChars) {
  let s = '';
  for (let i = 0; i < maxChars; i++) {
    const c = u16(d, off + i * 2);
    if (!c || c === 0xffff) break;
    s += CHAR_FIX[c] || String.fromCharCode(c);
  }
  return s;
}

// Party status (as in Gen 3–5): sleep turns in bits 0–2, or one of poison, burn, freeze, paralysis, toxic.
const statusOk = (s) => s === 0 || (s & ~7) === 0 || s === 8 || s === 16 || s === 32 || s === 64 || s === 128;

/**
 * One party Pokémon from a decrypted 260-byte PK6/PK7, or null when the bytes are no Pokémon of this generation
 * (an empty slot, a struct the game is rewriting, garbage).
 */
export function pk6Mon(raw, gen) {
  const { data: d, checksumOk } = decryptPK6(raw);
  if (!checksumOk) return null;
  const species = u16(d, 0x08);
  if (!species || species > (gen >= 7 ? 807 : 721)) return null;
  const iv32 = u32(d, 0x74);
  const isEgg = !!(iv32 & 0x40000000);
  const status = u32(d, 0xe8);
  const level = d[0xec];
  const hp = u16(d, 0xf0);
  const maxHp = u16(d, 0xf2);
  if (!statusOk(status)) return null;
  if (isEgg ? level > 100 || hp > maxHp : level < 1 || level > 100 || !maxHp || hp > maxHp) return null;
  // the five other stats – a struct being rewritten reads as words far above any real stat
  for (let o = 0xf2; o < 0xfe; o += 2) if (u16(d, o) > 999) return null;
  const pid = u32(d, 0x18);
  const tid = u16(d, 0x0c);
  const sid = u16(d, 0x0e);
  const formByte = d[0x1d];
  return {
    key: `${pid.toString(16).padStart(8, '0')}-${tid}-${sid}`,
    pid, ec: u32(d, 0), species, form: formByte >> 3, nickname: text(d, 0x40, 12), isEgg, item: u16(d, 0x0a),
    moves: [u16(d, 0x5a), u16(d, 0x5c), u16(d, 0x5e), u16(d, 0x60)].filter(Boolean),
    metLocation: u16(d, 0xda), eggLocation: u16(d, 0xd8), metLevel: d[0xdd] & 0x7f,
    gender: ['M', 'F', '-'][(formByte >> 1) & 3] || '-',
    shiny: ((tid ^ sid ^ (pid >>> 16) ^ (pid & 0xffff)) >>> 0) < 16,
    status: status & 0xff, level, hp, maxHp,
  };
}

/** The 260-byte PK6/PK7 of RAM slot `i` in a 6-slot party region. */
export function slotBytes(region, i) {
  const at = i * SLOT_STRIDE;
  const out = new Uint8Array(BOX_SIZE + STATS_SIZE);
  out.set(region.subarray(at, at + BOX_SIZE), 0);
  out.set(region.subarray(at + STATS_OFFSET, at + STATS_OFFSET + STATS_SIZE), BOX_SIZE);
  return out;
}

/**
 * The party in a 6-slot region: the slots from the first on, up to the first empty one. null when slot 0 isn't a
 * Pokémon (title screen, another update's address) or a slot after it is damaged (the game rewriting the party).
 */
export function partyFromRegion(region, gen) {
  if (!region || region.length < PARTY_BYTES) return null;
  const party = [];
  for (let i = 0; i < 6; i++) {
    const raw = slotBytes(region, i);
    if (raw.every((b) => b === 0)) break;
    const m = pk6Mon(raw, gen);
    if (!m) {
      // slot 0 must hold a Pokémon. After it, the first slot that doesn't ends the party: empty slots hold blank
      // data (encryption constant 0, species 0), zeros or what was there before (readGen67 confirms a shrink).
      if (i === 0) return null;
      break;
    }
    // the same Pokémon twice: read while the party menu swaps two slots
    if (party.some((x) => x.pid === m.pid && x.ec === m.ec)) return null;
    party.push(m);
  }
  return party.length ? party : null;
}

/** Memory regions of a 3DS address-table entry: the party at every known update's address. */
export function regions67(entry) {
  return (entry.partyAddrs || []).map((a) => ({ addr: hex(a.addr ?? a), len: PARTY_BYTES }));
}

const popcount = (n) => n.toString(2).replace(/0/g, '').length;

/**
 * Read the party of a running Gen 6/7 game. The first address that holds a party wins and is kept for the session
 * (the game's update version doesn't change while it runs).
 * @returns {{party, badges?, version}|null}
 */
export function readGen67(entry, read, state = {}) {
  const addrs = entry.partyAddrs || [];
  const order = state.g67 != null ? [state.g67, ...addrs.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...addrs.keys()];
  for (const i of order) {
    const a = addrs[i];
    const region = read(hex(a.addr ?? a), PARTY_BYTES);
    const party = partyFromRegion(region, entry.gen);
    if (!party) continue;
    state.g67 = i;
    // fewer Pokémon than last time: only once a second read agrees (a slot the game is rewriting ends the party early)
    const sig = party.map((m) => m.key).join();
    if (state.g67Len && party.length < state.g67Len && state.g67Shrink !== sig) {
      state.g67Shrink = sig;
      return null;
    }
    state.g67Shrink = null;
    state.g67Len = party.length;
    const res = { party, version: a.version || null };
    if (a.badges) {
      const b = read(hex(a.badges), 1);
      if (b) res.badges = popcount(b[0]);
    }
    return res;
  }
  return null;
}

// ---- battles ------------------------------------------------------------------------------------------------------
// The battle keeps its Pokémon unencrypted (Pokémon Stream Tool, Readek: Raw Pokemon Battle.mjs / Battle Pokemon.mjs –
// checked live in Omega Ruby: Torchic 17/20 and the wild Poochyena 10/15 at 0x08204200 / 0x08204444): blocks of 580
// bytes (Gen 6) / 816 (Gen 7) from the battle's base address, in each { u32 exp, u16 species +4, u16 max HP +6,
// u16 HP +8, u8 level +0x10, u8 battle slot +0x11 (0–5 the player's side, 12–17 the opponent's) }. Gen 6 has one base
// per battle kind (wild / trainer) and clears it after the battle; Gen 7 uses one base for both and leaves the last
// battle in memory, so two flags say whether a battle runs and whether it is a trainer's.
const BATTLE_BLOCKS = 12;

export function battleRegions(entry) {
  const b = entry?.battle;
  if (!b) return [];
  const len = (b.stride || 580) * (b.blocks || BATTLE_BLOCKS);
  const bases = [b.wild, b.trainer].filter(Boolean).map(hex).filter((v, i, a) => a.indexOf(v) === i);
  return [
    ...bases.map((addr) => ({ addr, len, name: 'battle' })),
    ...[b.inBattle, b.isTrainer].filter(Boolean).map((a) => ({ addr: hex(a), len: 1, name: 'battleFlag' })),
  ];
}

function battleMons(bytes, stride, gen, blocks = BATTLE_BLOCKS) {
  const out = [];
  if (!bytes) return out;
  for (let i = 0; i < blocks && (i + 1) * stride <= bytes.length; i++) {
    const o = i * stride;
    const species = u16(bytes, o + 4);
    const maxHp = u16(bytes, o + 6);
    const hp = u16(bytes, o + 8);
    const level = bytes[o + 0x10];
    const slot = bytes[o + 0x11];
    if (!species || species > (gen >= 7 ? 807 : 721) || !maxHp || maxHp > 999 || hp > maxHp || level < 1 || level > 100) continue;
    out.push({ species, maxHp, hp, level, slot, block: i });
  }
  return out;
}

/**
 * The battle running now: { kind: 'wild' | 'trainer', enemy: { species, level, hp, maxHp }, active: { index, hp,
 * maxHp } | null } (the shape of shared/live/parse.mjs readLiveBattle) – or null outside battle. `party` maps the
 * player's battler to its party slot (species, level and max HP – the battle copy has no PID).
 */
export function readGen67Battle(entry, read, party = null) {
  const b = entry?.battle;
  if (!b) return null;
  const stride = b.stride || 580;
  // Gen 7 keeps the opponents' battlers after the player's 12 (Ultra Sun: a wild Yungoos at block 12, slot 12)
  const blocks = b.blocks || BATTLE_BLOCKS;
  let kind = null;
  let mons = [];
  if (b.inBattle) {
    // Gen 7: the flags decide, the one base holds wild and trainer battles alike
    const flag = read(hex(b.inBattle), 1);
    if (!flag || !flag[0]) return null;
    const trainer = b.isTrainer ? read(hex(b.isTrainer), 1) : null;
    kind = trainer && trainer[0] ? 'trainer' : 'wild';
    mons = battleMons(read(hex(b.wild || b.trainer), stride * blocks), stride, entry.gen, blocks);
  } else {
    for (const [k, base] of [['wild', b.wild], ['trainer', b.trainer]]) {
      if (!base) continue;
      const m = battleMons(read(hex(base), stride * blocks), stride, entry.gen, blocks);
      // a battle needs both sides
      if (m.some((x) => x.slot < 6) && m.some((x) => x.slot >= 12)) {
        kind = k;
        mons = m;
        break;
      }
    }
  }
  const mine = mons.filter((x) => x.slot < 6);
  const foes = mons.filter((x) => x.slot >= 12);
  if (!kind || !mine.length || !foes.length) return null;
  const me = mine[0];
  const foe = foes.find((x) => x.hp > 0) || foes[0];
  const index = party ? party.findIndex((p) => p.species === me.species && p.level === me.level && p.maxHp === me.maxHp) : -1;
  return {
    kind,
    enemy: { species: foe.species, level: foe.level, hp: foe.hp, maxHp: foe.maxHp },
    active: index >= 0 ? { index, hp: me.hp, maxHp: me.maxHp } : null,
  };
}

