// Cheats that write into the running game's memory – today one: Rare Candies into the bag.
//
// Why RAM and not cheat codes: Action Replay / GameShark codes are made for one version and region each, and the
// cores in this build differ in what they accept. Writing the item where the game keeps its bag works the same for
// every build of a supported game, randomized or not (the randomizer doesn't move the bag), and every write is
// checked first: the bag must look exactly like a bag (counts, terminators, item ids and quantities in range) or
// nothing is written. Layouts: research/live_ram.md §7 (pret disassemblies, PKHeX, checked against a HeartGold RAM
// image). Works on any memory source with read(addr, len) / write(addr, bytes) on console bus addresses.

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];

/** Rare Candy's item id per generation (pret item constants; PokeAPI game_indices agree). */
export const RARE_CANDY = { 1: 0x28, 2: 0x20, 3: 68, 4: 50, 5: 50 };

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

function layoutOf(entry) {
  if (!entry) return null;
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
    return key ? { kind: 'gba', ...GBA[key] } : null;
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

function dsBag(L, entry, read, state, pocketName = 'medicine') {
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
  if (!used) return null;
  const name = L.pockets[pocketName] ? pocketName : 'items'; // (Gen 5 keeps the Poké Balls with the items)
  const [off, n] = L.pockets[name];
  return { addr: bag + off, slots: n, bytes: out[name], q: (v) => v };
}

// ---------------------------------------------------------------------------

function commit(mem, writes, before, after) {
  for (const [addr, bytes] of writes) if (mem.write(addr, Uint8Array.from(bytes)) === false) return { error: 'write' };
  // read back: the emulator really holds it now
  for (const [addr, bytes] of writes) {
    const got = mem.read(addr, bytes.length);
    if (!got || bytes.some((x, i) => got[i] !== x)) return { error: 'write' };
  }
  return { ok: true, before, after, added: after - before };
}

/**
 * Put `count` Rare Candies into the player's bag (onto the stack they have, else into a free slot; capped at the
 * game's stack size: 99, Gen 4/5 999).
 * @param {object} entry   addresses.json entry (findEntry)
 * @param {{read:(addr:number,len:number)=>Uint8Array|null, write:(addr:number,bytes:Uint8Array)=>boolean}} mem
 * @param {object} state   the live reader's state (readLiveParty) – DS games find the bag through the party
 * @returns {{ok:true, before:number, after:number, added:number} | {error:'unsupported'|'notFound'|'full'|'max'|'write'}}
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
 */
export function addItem(entry, mem, state, item, count = 1, { pocket = null } = {}) {
  const L = layoutOf(entry);
  if (!L || !item) return { error: 'unsupported' };
  if (L.kind === 'gb') {
    // Gen 2's ball pocket follows the key items: wNumKeyItems, 25 ids + 0xFF, then wNumBalls (pokecrystal wram.asm)
    const B = pocket === 'balls' && entry.gen === 2 ? { ...L, addr: L.keyItems + 27, keyItems: null } : L;
    return gbAdd(B, entry.gen, mem, item, count);
  }
  const bag = L.kind === 'gba' ? gbaBag(L, mem.read, pocket === 'balls' ? 'balls' : 'items') : dsBag(L, entry, mem.read, state, pocket || 'medicine');
  if (!bag) return { error: 'notFound' };
  const key = L.kind === 'gba' ? bag.q(0) : 0; // q(0) = the key's low half (0 in Ruby/Sapphire)
  return slotAdd(bag, mem, item, count, L.kind === 'ds' ? 999 : 99, (v) => (v ^ key) & 0xffff);
}
