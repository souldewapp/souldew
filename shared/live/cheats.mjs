// Cheats that write into the running game's memory – today one: Rare Candies into the bag.
//
// Why RAM and not cheat codes: Action Replay / GameShark codes are made for one version and region each, and the
// cores in this build differ in what they accept. Writing the item where the game keeps its bag works the same for
// every build of a supported game, randomized or not (the randomizer doesn't move the bag), and every write is
// checked first: the bag must look exactly like a bag (counts, terminators, item ids and quantities in range) or
// nothing is written. Layouts: research/live_ram.md §7 (pret disassemblies, PKHeX, checked against a HeartGold RAM
// image). Works on any memory source with read(addr, len) / write(addr, bytes) on console bus addresses – the 3DS
// player's write answers later (a Promise: the native host writes between two frames), the others right away.

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];

/** Rare Candy's item id per generation (pret item constants; PokeAPI game_indices agree). */
export const RARE_CANDY = { 1: 0x28, 2: 0x20, 3: 68, 4: 50, 5: 50, 6: 50, 7: 50 };

// Gen 1/2: a count byte, then (id, quantity) pairs closed by 0xFF. Bag 20 slots, 99 per slot (pokered
// constants/menu_constants.asm BAG_ITEM_CAPACITY, pokecrystal constants/item_data_constants.asm MAX_ITEMS / MAX_ITEM_STACK).
// `money` (Gen 1, BCD) and `keyItems` (Gen 2: count + ids + 0xFF) follow right after – checked as well.
const GB = {
  red_us: { addr: 0xd31d, money: 0xd347 }, // pokered.sym wNumBagItems, wPlayerMoney
  blue_us: { addr: 0xd31d, money: 0xd347 },
  yellow_us: { addr: 0xd31c, money: 0xd346 }, // pokeyellow.sym
  gold_us: { addr: 0xd5b7, keyItems: 0xd5e1 }, // pokegold.sym wNumItems, wNumKeyItems (Silver identical)
  silver_us: { addr: 0xd5b7, keyItems: 0xd5e1 },
  crystal_us: { addr: 0xd892, keyItems: 0xd8bc }, // pokecrystal.sym
};

// Gen 3: SaveBlock1 holds the pockets as { u16 id, u16 quantity } (include/global.h). Ruby/Sapphire keep it at a fixed
// address and the quantities plain; Emerald and FireRed/LeafGreen move the save blocks around (pointers in IWRAM) and
// XOR every bag quantity with the low half of SaveBlock2's encryptionKey (src/item.c GetBagItemQuantity), money with
// all of it.
const GBA = {
  ruby: { sb1: 0x02025734, items: [0x560, 20], balls: [0x600, 16], money: 0x490, maxId: 348 }, // pokeruby(_de).sym gSaveBlock1
  emerald: { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, items: [0x560, 30], balls: [0x650, 16], money: 0x490, maxId: 376 },
  firered: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, items: [0x310, 42], balls: [0x430, 13], money: 0x290, maxId: 374 },
};

// Gen 4/5: the bag is part of the save data the game keeps in RAM, pockets of { u16 id, u16 quantity }, 999 per slot.
// Rare Candy sits in the Medicine pocket. Gen 4: offsets in the general block (PKHeX PlayerBag4*.cs), the general
// block at SaveData + `general` (the same as for the badges and boxes in parse.mjs). Gen 5: the inventory block is
// 0xA00 before the party block, like in the .sav (PKHeX SaveBlockAccessor5*.cs: 0x18400 / 0x18E00).
const TM4 = (id) => id >= 328 && id <= 427;
const TM5 = (id) => TM4(id) || (id >= 618 && id <= 620);
const DS = {
  hgss: { gen: 4, general: 0x10, bag: 0x644, maxId: 536, tm: TM4, pockets: { items: [0x000, 165], key: [0x294, 50], tm: [0x35c, 101], medicine: [0x520, 40], balls: [0x6c0, 24] } },
  platinum: { gen: 4, general: 0x14, bag: 0x630, maxId: 536, tm: TM4, pockets: { items: [0x000, 165], key: [0x294, 50], tm: [0x35c, 100], medicine: [0x51c, 40], balls: [0x6bc, 15] } },
  dp: { gen: 4, general: 0x214, bag: 0x624, maxId: 536, tm: TM4, pockets: { items: [0x000, 165], key: [0x294, 50], tm: [0x35c, 100], medicine: [0x51c, 40], balls: [0x6bc, 15] } },
  bw: { gen: 5, fromParty: -0xa00, maxId: 638, tm: TM5, pockets: { items: [0x000, 310], key: [0x4d8, 83], tm: [0x624, 109], medicine: [0x7d8, 48] } },
};

// Gen 6/7 (3DS): the bag is the save data's MyItem block, which the game keeps in its heap at a fixed address per
// game and update (addresses.json partyAddrs[].bag – Multi-PokemonFramework (semaj14, GPL-3) writes the pockets there
// for X/Y 1.5, ORAS 1.4, Sun/Moon 1.2 and Ultra Sun/Moon 1.2; the 1.0 addresses moved by the same distance as the party
// and the badges; Sun 1.0 checked live). Pockets as in PKHeX PlayerBag6XY / 6AO / 7SM / 7USUM (offsets in the block,
// slots). Gen 6 slots are { u16 id, u16 count }; Gen 7 slots one u32: id (bits 0–9), count (10–19), the place in the
// Free Space pocket (20–29, 0: not in it), NEW (30), bit 31 unused (PKHeX InventoryItem7). 999 per slot. Rare Candy goes into Medicine.
// Sun/Moon keep a table of pointers to the pockets right behind the block (seen live in Sun 1.0) – when it is there it
// has to point at exactly these pockets; either way every slot has to look like an item of its pocket.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const MED67 = new Set([...range(17, 54), 65, 66, 67, 134, 504, ...range(565, 571), 591, 645, 708, 709, 852]); // PKHeX ItemStorage6XY/6AO/7SM Medicine
const TM67 = new Set([...range(328, 425), 618, 619, 620, ...range(690, 694), 737]); // TMs, HMs (ORAS: 425, 737)
const CTR = {
  xy: { gen: 6, maxId: 717, size: 0xb88, pockets: { items: [0x000, 400], key: [0x640, 96], tm: [0x7c0, 106], medicine: [0x968, 64], berries: [0xa68, 72] } },
  oras: { gen: 6, maxId: 775, size: 0xb90, pockets: { items: [0x000, 400], key: [0x640, 96], tm: [0x7c0, 108], medicine: [0x970, 64], berries: [0xa70, 72] } },
  sm: { gen: 7, maxId: 920, size: 0xde0, pockets: { items: [0x000, 430], key: [0x6b8, 184], tm: [0x998, 108], medicine: [0xb48, 64], berries: [0xc48, 72], z: [0xd68, 30] } },
  usum: { gen: 7, maxId: 959, size: 0xe28, pockets: { items: [0x000, 427], key: [0x6ac, 198], tm: [0x9c4, 108], medicine: [0xb74, 60], berries: [0xc64, 67], z: [0xd70, 35], battle: [0xdfc, 11] } },
};
/** The bag's addresses to try for a 3DS game: the update the party was found at first (state.g67), then the others. */
function ctrBags(entry, state) {
  const all = (entry.partyAddrs || []).map((a) => (a?.bag ? parseInt(a.bag, 16) : 0));
  const first = state?.g67 != null && all[state.g67] ? [all[state.g67]] : [];
  return [...new Set([...first, ...all.filter(Boolean)])];
}
/** The memory a 3DS game's bag needs (the block and the pointer table behind it) – for the 3DS player's watch list. */
export function cheatRegions(entry) {
  const L = layoutOf(entry);
  if (L?.kind !== 'ctr') return [];
  return ctrBags(entry, null).map((addr) => ({ addr, len: L.size + Object.keys(L.pockets).length * 4, name: 'bag' }));
}

function layoutOf(entry) {
  if (!entry) return null;
  if (entry.gen >= 6) return CTR[entry.id] && entry.gen === CTR[entry.id].gen ? { kind: 'ctr', ...CTR[entry.id] } : null;
  const id = String(entry.id || '').replace(/~.*$/, ''); // scanned DS relatives: "heartgold_us~IPKD"
  if (entry.gen <= 2) {
    if (!GB[id]) return null;
    // a Game Boy hack whose WRAMX bank moved (shared/live/romwram.mjs: the entry carries the shift) keeps its bag there too
    const d = entry.wram && Object.keys(entry.wram.moved || {}).some((a) => /^0xD/i.test(a)) ? entry.wram.delta : 0;
    const L = { kind: 'gb', ...GB[id] };
    for (const k of ['addr', 'money', 'keyItems']) if (L[k] >= 0xd000 && L[k] < 0xe000) L[k] += d;
    return L;
  }
  if (entry.gen === 3) {
    const key = /^(ruby|sapphire)_/.test(id) ? 'ruby' : /^emerald_/.test(id) ? 'emerald' : /^(firered|leafgreen)_/.test(id) ? 'firered' : null;
    if (!key) return null;
    // a hack whose team is searched for (parse.mjs expandedEntry): only one that kept the base game's save data and item
    // numbers (`retail3` – Modern Emerald) has the bag where the base game keeps it, its save block pointers wherever
    // the place reader found them (gbaBag: state.sb1PtrAddr). Run & Bun, pokeemerald-expansion and Complete FireRed
    // Upgrade number their items their own way or moved the bag: no cheats there (the ROM test matrix passes the save
    // block pointers it measured, `saveBlockPtrs`, to give Poké Balls in Run & Bun).
    if (entry.scan3 && !entry.saveBlockPtrs) return entry.retail3 && key !== 'ruby' ? { kind: 'gba', ...GBA[key], found: true, ...(entry.items3Max ? { maxId: entry.items3Max } : {}) } : null;
    // the other-language FireRed/LeafGreen keep the save block pointers elsewhere in IWRAM (addresses.json saveBlockPtrs)
    const P = entry.saveBlockPtrs;
    const ptrs = P ? { sb1Ptr: parseInt(P.sb1, 16), sb2Ptr: parseInt(P.sb2, 16), ...(P.keyOff ? { keyOff: parseInt(P.keyOff, 16) } : {}) } : {};
    return { kind: 'gba', ...GBA[key], ...ptrs };
  }
  const key = /^(heartgold|soulsilver)_/.test(id) ? 'hgss' : /^platinum_/.test(id) ? 'platinum' : /^(diamond|pearl)_/.test(id) ? 'dp'
    : /^(black|white|black2|white2)_/.test(id) ? 'bw' : null;
  return key ? { kind: 'ds', ...DS[key] } : null;
}

/** Can this game get Rare Candies at all? (The bag still has to be found when it is used.) */
export const cheatSupported = (entry) => !!layoutOf(entry) && !!RARE_CANDY[entry.gen];

// ---------------------------------------------------------------------------
// Gen 1/2

const bcdOk = (b) => b.every((x) => (x >> 4) <= 9 && (x & 15) <= 9);
const gbItemOk = (gen, id) => (gen === 1 ? (id >= 1 && id <= 0x53) || (id >= 0xc4 && id <= 0xfe) : id >= 1 && id <= 0xfe);

function gbBag(L, gen, read) {
  const b = read(L.addr, 42);
  if (!b) return null;
  const n = b[0];
  if (n > 20 || b[1 + n * 2] !== 0xff) return null;
  for (let i = 0; i < n; i++) if (!gbItemOk(gen, b[1 + i * 2]) || b[2 + i * 2] < 1 || b[2 + i * 2] > 99) return null;
  if (L.money) {
    const m = read(L.money, 3);
    if (!m || !bcdOk(m)) return null;
  }
  if (L.keyItems) {
    const k = read(L.keyItems, 27);
    if (!k || k[0] > 25 || k[1 + k[0]] !== 0xff) return null;
  }
  return { n, bytes: b };
}

function gbAdd(L, gen, mem, item, count) {
  const bag = gbBag(L, gen, mem.read);
  if (!bag) return { error: 'notFound' };
  const { n, bytes } = bag;
  for (let i = 0; i < n; i++) {
    if (bytes[1 + i * 2] !== item) continue;
    const before = bytes[2 + i * 2];
    const after = Math.min(99, before + count);
    if (after === before) return { error: 'max', before };
    return commit(mem, [[L.addr + 2 + i * 2, [after]]], before, after);
  }
  if (n >= 20) return { error: 'full' };
  const after = Math.min(99, count);
  // the new pair over the old terminator, a new terminator behind it, then the count
  return commit(mem, [[L.addr + 1 + n * 2, [item, after, 0xff]], [L.addr, [n + 1]]], 0, after);
}

// ---------------------------------------------------------------------------
// Gen 3

const inEwram = (a) => a >= 0x02000000 && a < 0x02040000;

function gbaBag(L, read, pocketName = 'items') {
  let sb1 = L.sb1;
  let key = 0;
  if (L.sb1Ptr) {
    const p1 = read(L.sb1Ptr, 4);
    const p2 = read(L.sb2Ptr, 4);
    if (!p1 || !p2) return null;
    sb1 = u32le(p1, 0);
    const sb2 = u32le(p2, 0);
    if (!inEwram(sb1) || !inEwram(sb2)) return null;
    const k = read(sb2 + L.keyOff, 4);
    if (!k) return null;
    key = u32le(k, 0);
    if (L.found) {
      key = foundKey(L, read, sb1, sb2);
      if (key === null) return null;
    }
  }
  const money = read(sb1 + L.money, 4);
  if (!money || ((u32le(money, 0) ^ key) >>> 0) > 999999) return null;
  const q = (v) => (v ^ key) & 0xffff;
  const pocket = (off, n, ok) => {
    const b = read(sb1 + off, n * 4);
    if (!b) return null;
    for (let i = 0; i < n; i++) {
      const id = u16le(b, i * 4);
      if (id && (!ok(id) || q(u16le(b, i * 4 + 2)) < 1 || q(u16le(b, i * 4 + 2)) > 99)) return null;
    }
    return b;
  };
  const items = pocket(L.items[0], L.items[1], (id) => id <= L.maxId);
  const balls = pocket(L.balls[0], L.balls[1], (id) => id <= 12); // Master Ball … Premier Ball
  if (!items || !balls) return null;
  const [off, n] = L[pocketName];
  return { addr: sb1 + off, slots: n, bytes: pocketName === 'balls' ? balls : items, q };
}

/**
 * The bag key of a hack whose SaveBlock2 grew in front of encryptionKey (Modern Emerald's options – the key isn't at
 * +0xAC there): every slot's quantity is XORed with the key's low half, an empty slot's too, so an empty slot of the
 * items or the Poké Ball pocket shows it; the key is the word of SaveBlock2 with that low half that makes the money
 * (XORed with all of it) a sum of money – at +0xAC first. null: no empty slot, or no such word.
 */
function foundKey(L, read, sb1, sb2) {
  const low = (off, n) => {
    const b = read(sb1 + off, n * 4);
    if (!b) return null;
    for (let i = n - 1; i >= 0; i--) if (!u16le(b, i * 4)) return u16le(b, i * 4 + 2);
    return null;
  };
  const kl = low(L.items[0], L.items[1]) ?? low(L.balls[0], L.balls[1]);
  const m = read(sb1 + L.money, 4);
  const s2 = read(sb2, 0x1000);
  if (kl === null || !m || !s2) return null;
  const money = u32le(m, 0);
  for (const o of [L.keyOff, ...Array.from({ length: 0x400 }, (_, i) => i * 4)]) {
    const v = u32le(s2, o);
    if ((v & 0xffff) === kl && ((money ^ v) >>> 0) <= 999999) return v;
  }
  return null;
}

function slotAdd(bag, mem, item, count, cap, enc) {
  const { addr, slots, bytes, q } = bag;
  for (let i = 0; i < slots; i++) {
    if (u16le(bytes, i * 4) !== item) continue;
    const before = q(u16le(bytes, i * 4 + 2));
    const after = Math.min(cap, before + count);
    if (after === before) return { error: 'max', before };
    return commit(mem, [[addr + i * 4 + 2, le16(enc(after))]], before, after);
  }
  for (let i = 0; i < slots; i++) {
    if (u16le(bytes, i * 4) !== 0) continue;
    const after = Math.min(cap, count);
    return commit(mem, [[addr + i * 4, [...le16(item), ...le16(enc(after))]]], 0, after);
  }
  return { error: 'full' };
}

// ---------------------------------------------------------------------------
// Gen 4/5

function dsBag(L, entry, read, state, pocketName = 'medicine', allowEmpty = false) {
  let bag = null;
  if (L.gen === 4) {
    // the save data: from the pointer the party reader followed, else from where it found the party
    const save = state?.saveBase || (state?.partyAddr && entry.partyMonsOffset ? state.partyAddr + 8 - parseInt(entry.partyMonsOffset, 16) : 0);
    if (save) bag = save + L.general + L.bag;
  } else if (state?.partyAddr) bag = state.partyAddr + L.fromParty;
  if (!bag || bag < 0x02000000 || bag >= 0x02400000) return null;
  const read16 = (off, n) => read(bag + off, n * 4);
  let used = 0;
  const out = {};
  for (const [name, [off, n]] of Object.entries(L.pockets)) {
    const b = read16(off, n);
    if (!b) return null;
    for (let i = 0; i < n; i++) {
      const id = u16le(b, i * 4);
      const qty = u16le(b, i * 4 + 2);
      if (!id) {
        if (qty) return null; // the game clears a slot to 0/0
        continue;
      }
      if (id > L.maxId || qty < 1 || qty > 999 || (name === 'tm' && !L.tm(id))) return null;
      used++;
    }
    out[name] = b;
  }
  // an all-zero region passes the checks above: a real bag has something in it (a fresh game's empty bag is refused too)
  if (!used && !allowEmpty) return null;
  const name = L.pockets[pocketName] ? pocketName : 'items'; // (Gen 5 keeps the Poké Balls with the items)
  const [off, n] = L.pockets[name];
  return { addr: bag + off, slots: n, bytes: out[name], q: (v) => v };
}

// ---------------------------------------------------------------------------
// Gen 6/7

function ctrBagAt(L, base, read) {
  const b = read(base, L.size);
  if (!b) return null;
  const g7 = L.gen === 7;
  const slot = (o) => (g7 ? u32le(b, o) : u16le(b, o) | (u16le(b, o + 2) << 16)) >>> 0;
  const idOf = (v) => (g7 ? v & 0x3ff : v & 0xffff);
  const countOf = (v) => (g7 ? (v >>> 10) & 0x3ff : v >>> 16);
  let used = 0;
  for (const [name, [off, n]] of Object.entries(L.pockets)) {
    for (let i = 0; i < n; i++) {
      const v = slot(off + i * 4);
      const id = idOf(v);
      const qty = countOf(v);
      if (!id) {
        if (qty) return null; // (an empty slot has no count)
        continue;
      }
      if (id > L.maxId || qty < 1 || qty > 999 || (g7 && v >>> 31)) return null;
      if ((name === 'medicine' && !MED67.has(id)) || (name === 'tm' && !TM67.has(id))) return null;
      used++;
    }
  }
  // an all-zero region passes the checks above: a real bag has something in it (the key item that comes with the
  // starter, at the latest)
  if (!used) return null;
  // the pocket pointers behind the block (Sun / Moon): when they are there, they point at these pockets and no others
  const n = Object.keys(L.pockets).length;
  const t = read(base + L.size, n * 4);
  if (t) {
    const want = new Set(Object.values(L.pockets).map(([off]) => (base + off) >>> 0));
    const got = new Set(Array.from({ length: n }, (_, i) => u32le(t, i * 4)));
    const anyPtr = [...got].some((p) => p >= 0x08000000 && p < 0x40000000);
    if (anyPtr && (got.size !== want.size || [...got].some((p) => !want.has(p)))) return null;
  }
  const [off, slots] = L.pockets.medicine;
  return { addr: base + off, slots, bytes: b.subarray(off, off + slots * 4), g7, slot: (i) => slot(off + i * 4), idOf, countOf, block: b, slotAt: slot };
}

/**
 * The balls a wild battle can use, Gen 6/7 item numbers (PKHeX ItemStorage): Master … Premier, Dusk, Heal, Quick (1–15
 * but the Safari Ball, 5), Cherish (16), Fast … Sport (492–499, not the Park Ball), Dream (576), Beast (851).
 */
const CATCH_BALLS = new Set([1, 2, 3, 4, ...range(6, 16), ...range(492, 499), 576, 851]);

/**
 * Nintendo 3DS: is there no ball to throw? true: the bag was read as a bag (at the update the party was found at, first)
 * and its Items pocket – where Gen 6/7 keep the Poké Balls – has none; false: it has one; null: no bag was found, or
 * it looks like none (unknown – callers behave as if balls were there). The first fights of Omega Ruby / Alpha Sapphire
 * (Birch's rescue, the rival's battle) are fought before the first ball is handed out.
 */
export function ctrNoBalls(entry, read, state) {
  const L = layoutOf(entry);
  if (L?.kind !== 'ctr') return null;
  for (const base of ctrBags(entry, state)) {
    const bag = ctrBagAt(L, base, read);
    if (!bag) continue;
    const [off, n] = L.pockets.items;
    for (let i = 0; i < n; i++) if (CATCH_BALLS.has(bag.idOf(bag.slotAt(off + i * 4)))) return false;
    return true;
  }
  return null;
}

function ctrAdd(L, entry, mem, state, item, count) {
  let bag = null;
  for (const base of ctrBags(entry, state)) if ((bag = ctrBagAt(L, base, mem.read))) break;
  if (!bag) return { error: 'notFound' };
  const { addr, slots, g7, slot, idOf, countOf } = bag;
  const enc = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (let i = 0; i < slots; i++) {
    const v = slot(i);
    if (idOf(v) !== item) continue;
    const before = countOf(v);
    const after = Math.min(999, before + count);
    if (after === before) return { error: 'max', before };
    // the count only – Gen 7 keeps its sort index and NEW mark
    return g7 ? commit(mem, [[addr + i * 4, enc(((v & ~(0x3ff << 10)) | (after << 10)) >>> 0)]], before, after)
      : commit(mem, [[addr + i * 4 + 2, le16(after)]], before, after);
  }
  for (let i = 0; i < slots; i++) {
    if (idOf(slot(i))) continue;
    const after = Math.min(999, count);
    if (!g7) return commit(mem, [[addr + i * 4, [...le16(item), ...le16(after)]]], 0, after);
    // as the game files a new item: marked NEW, not in the Free Space pocket (index 0 – seen in Sun: the key item from
    // Hala; a higher index would put it there)
    return commit(mem, [[addr + i * 4, enc((item | (after << 10) | 0x40000000) >>> 0)]], 0, after);
  }
  return { error: 'full' };
}

// ---------------------------------------------------------------------------

// A write's answer: true, or a refusal – false, or (the 3DS player) { ok: false, why } with its host's reason
// (native/ctr-host/ctrhost.c mem_write: 'changed' – the game holds other bytes there now –, 'range', 'failed' …)
const refusal = (r) => (r === false ? {} : r && typeof r === 'object' && r.ok === false ? r : null);
const refused = ({ why }) => (why === 'changed' ? { error: 'changed' } : { error: 'write', ...(why ? { why: String(why) } : {}) });

function commit(mem, writes, before, after) {
  const check = (results) => {
    const no = results.map(refusal).find(Boolean);
    if (no) return refused(no);
    // read back: the emulator really holds it now
    for (const [addr, bytes] of writes) {
      const got = mem.read(addr, bytes.length);
      if (!got || bytes.some((x, i) => got[i] !== x)) return { error: 'write' };
    }
    return { ok: true, before, after, added: after - before };
  };
  const results = [];
  for (const [addr, bytes] of writes) {
    const r = mem.write(addr, Uint8Array.from(bytes));
    if (refusal(r)) return refused(refusal(r));
    results.push(r);
  }
  // the 3DS player answers once its host has written (between two frames)
  return results.some((r) => typeof r?.then === 'function') ? Promise.all(results).then(check, () => ({ error: 'write' })) : check(results);
}

/**
 * Put `count` Rare Candies into the player's bag (onto the stack they have, else into a free slot; capped at the
 * game's stack size: 99, Gen 4–7 999).
 * @param {object} entry   addresses.json entry (findEntry)
 * @param {{read:(addr:number,len:number)=>Uint8Array|null, write:(addr:number,bytes:Uint8Array)=>boolean|Promise<boolean|{ok:false,why:string}>}} mem
 * @param {object} state   the live reader's state (readLiveParty) – DS games find the bag through the party, 3DS games
 *                         try the update the party was found at first
 * @returns the result – a Promise of it when `mem.write` answers later (the 3DS player):
 *          {ok:true, before:number, after:number, added:number} | {error:'unsupported'|'notFound'|'full'|'max'|'changed'}
 *          | {error:'write', why?:string} ('changed': the game changed those bytes just then; `why`: the 3DS host's reason)
 */
export function addRareCandies(entry, mem, state, count = 99) {
  return addItem(entry, mem, state, RARE_CANDY[entry?.gen], count);
}

/** Poké Ball's item id per generation (pret item constants: Gen 1 POKE_BALL 0x04, Gen 2 0x05, Gen 3–5 4). */
export const POKE_BALL = { 1: 0x04, 2: 0x05, 3: 4, 4: 4, 5: 4 };

/**
 * Put `count` of an item into the bag – the same checks as addRareCandies. `pocket` 'balls' puts it into the Poké Ball
 * pocket where the game has one (Gen 2–4; Gen 1 and 5 keep balls with the items). Used by the ROM test matrix
 * (scripts/rom-matrix) to catch a wild Pokémon early in a game; the app's cheats menu only offers Rare Candies.
 * `allowEmpty` accepts a Gen 4 bag with nothing in it yet when the save data came from the pointer (not a scan).
 */
export function addItem(entry, mem, state, item, count = 1, { pocket = null, allowEmpty = false } = {}) {
  const L = layoutOf(entry);
  if (!L || !item) return { error: 'unsupported' };
  if (L.kind === 'ctr') return pocket || !MED67.has(item) ? { error: 'unsupported' } : ctrAdd(L, entry, mem, state, item, count); // (Medicine items only)
  if (L.kind === 'gb') {
    // Gen 2's ball pocket follows the key items: wNumKeyItems, 25 ids + 0xFF, then wNumBalls (pokecrystal wram.asm)
    const B = pocket === 'balls' && entry.gen === 2 ? { ...L, addr: L.keyItems + 27, keyItems: null } : L;
    return gbAdd(B, entry.gen, mem, item, count);
  }
  // (a found build's save block pointers: where the place reader found them – none yet, no bag)
  const G = L.found ? (state?.sb1PtrAddr ? { ...L, sb1Ptr: state.sb1PtrAddr, sb2Ptr: state.sb1PtrAddr + 4 } : null) : L;
  if (!G) return { error: 'notFound' };
  const bag = L.kind === 'gba' ? gbaBag(G, mem.read, pocket === 'balls' ? 'balls' : 'items') : dsBag(L, entry, mem.read, state, pocket || 'medicine', allowEmpty && !!state?.saveBase);
  if (!bag) return { error: 'notFound' };
  const key = L.kind === 'gba' ? bag.q(0) : 0; // q(0) = the key's low half (0 in Ruby/Sapphire)
  return slotAdd(bag, mem, item, count, L.kind === 'ds' ? 999 : 99, (v) => (v ^ key) & 0xffff);
}
