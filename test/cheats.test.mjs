// Cheats: Rare Candies and Max Repels written into the bag in RAM (shared/live/cheats.mjs) – synthetic RAM per bag
// layout, the checks that keep it from writing anywhere else, when the play screen offers them, and the run side
// (rule, log, Honest Work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, regionsFor } from '../shared/live/parse.mjs';
import { addRareCandies, addMaxRepels, applyCheat, addItem, cheatSupported, cheatsFor, cheatBlock, cheatRegions, readBalls, locateCtrBag, ctrScanPlan, ctrScanWindow, CTR_WINDOW, RARE_CANDY, MAX_REPEL, POKE_BALL, CHEATS } from '../shared/live/cheats.mjs';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const TABLE = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url)));
const entry = (header) => findEntry(TABLE, header);

/** Sparse bus memory: unwritten bytes read as 0, later writes win. `writes` counts what the cheat wrote. */
function memory() {
  const blocks = [];
  const mem = {
    writes: 0,
    poke(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) {
        for (let i = 0; i < len; i++) {
          const o = addr + i - b.addr;
          if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
        }
      }
      return out;
    },
    write(addr, bytes) {
      mem.writes++;
      mem.poke(addr, bytes);
      return true;
    },
  };
  return mem;
}
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const slot = (id, qty) => [...le16(id), ...le16(qty)];
const u16 = (m, a) => { const b = m.read(a, 2); return b[0] | (b[1] << 8); };

test('item ids per generation (pret constants, PokeAPI game_indices)', () => {
  assert.deepEqual(RARE_CANDY, { 1: 0x28, 2: 0x20, 3: 68, 4: 50, 5: 50, 6: 50, 7: 50 });
  // pokered MAX_REPEL $39, pokecrystal $2B, pokeemerald ITEM_MAX_REPEL 84, pokeheartgold 77 (unchanged up to Gen 7)
  assert.deepEqual(MAX_REPEL, { 1: 0x39, 2: 0x2b, 3: 84, 4: 77, 5: 77, 6: 77, 7: 77 });
  // the play screen's menu: Rare Candies first, ten Max Repels a use, into the Items pocket – then the cheats of 3.0
  // (test/cheatmenu.test.mjs)
  assert.deepEqual(Object.keys(CHEATS).slice(0, 2), ['rareCandy', 'maxRepel']);
  assert.deepEqual([CHEATS.rareCandy.count, CHEATS.maxRepel.count, CHEATS.maxRepel.pocket], [99, 10, 'items']);
});

test('which games can get Rare Candies', () => {
  for (const h of [{ platform: 'gb', title: 'POKEMON RED' }, { platform: 'gb', title: 'POKEMON YELLOW' }, { platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' },
    { platform: 'gbc', title: 'POKEMON_SLV', code: 'AAXE' }, { platform: 'gba', code: 'AXVD' }, { platform: 'gba', code: 'BPEE' }, { platform: 'gba', code: 'BPGE' },
    { platform: 'nds', code: 'IPGE' }, { platform: 'nds', code: 'IPKD' }, { platform: 'nds', code: 'CPUE' }, { platform: 'nds', code: 'APAE' },
    { platform: 'nds', code: 'IRBO' }, { platform: 'nds', code: 'IRDO' }]) {
    assert.ok(cheatSupported(entry(h)), JSON.stringify(h));
  }
  // the German Emerald shares the English RAM; the French, Italian and Spanish one keep the bag where the English game
  // does too (the ROM matrix's catch in the Italian game throws balls this cheat's way put into the bag)
  for (const code of ['BPED', 'BPEF', 'BPEI', 'BPES']) assert.ok(cheatSupported(entry({ platform: 'gba', code })), code);
  // the French, Italian and Spanish Ruby/Sapphire keep SaveBlock1 where the English and the German game do
  for (const code of ['AXVI', 'AXPI', 'AXVF', 'AXPS']) assert.ok(cheatSupported(entry({ platform: 'gba', code })), code);
  // no addresses for the Japanese Ruby – the cheat isn't offered there
  assert.equal(cheatSupported(entry({ platform: 'gba', code: 'AXVJ' })), false);
  assert.equal(cheatSupported(null), false);
  assert.deepEqual(addRareCandies(null, memory(), {}), { error: 'unsupported' });
});

test('Max Repels: offered in every game that gets Rare Candies, and nowhere else', () => {
  const headers = [{ platform: 'gb', title: 'POKEMON RED' }, { platform: 'gb', title: 'POKEMON BLUE' }, { platform: 'gb', title: 'POKEMON YELLOW' },
    { platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' }, { platform: 'gbc', title: 'POKEMON_GLD', code: 'AAUE' }, { platform: 'gbc', title: 'POKEMON_SLV', code: 'AAXE' },
    { platform: 'gba', code: 'AXVE' }, { platform: 'gba', code: 'AXPD' }, { platform: 'gba', code: 'BPEE' }, { platform: 'gba', code: 'BPRE' }, { platform: 'gba', code: 'BPGD' },
    { platform: 'gba', code: 'BPED' }, { platform: 'gba', code: 'BPES' }, { platform: 'nds', code: 'IPKE' }, { platform: 'nds', code: 'IPGD' }, { platform: 'nds', code: 'CPUE' }, { platform: 'nds', code: 'ADAE' },
    { platform: 'nds', code: 'IRBO' }, { platform: 'nds', code: 'IREO' }, { platform: '3ds', titleId: '0004000000055D00' }, { platform: '3ds', titleId: '0004000000164800' },
    { platform: '3ds', titleId: '00040000001B5100' }];
  for (const h of headers) {
    const e = entry(h);
    assert.equal(cheatSupported(e, 'maxRepel'), cheatSupported(e), JSON.stringify(h));
    assert.deepEqual(cheatsFor(e).slice(0, 2), cheatSupported(e) ? ['rareCandy', 'maxRepel'] : [], JSON.stringify(h));
  }
  assert.deepEqual(cheatsFor(null), []);
  assert.equal(cheatSupported(entry({ platform: 'gb', title: 'POKEMON RED' }), 'infiniteMoney'), false);
  assert.deepEqual(addMaxRepels(null, memory(), {}), { error: 'unsupported' });
  assert.deepEqual(applyCheat('infiniteMoney', entry({ platform: 'gb', title: 'POKEMON RED' }), memory(), {}), { error: 'unsupported' });
});

test('when the play screen lets a cheat be used: a known bag, the run’s rules, live tracking, no battle', () => {
  const ok = { supported: true, allowed: true, live: true, inBattle: false };
  assert.equal(cheatBlock(ok), null);
  assert.equal(cheatBlock({ ...ok, supported: false }), 'unsupported');
  assert.equal(cheatBlock({ ...ok, allowed: false }), 'off', 'the rules (in a SoulLink the host’s) don’t allow cheats');
  assert.equal(cheatBlock({ ...ok, live: false }), 'waiting', 'live tracking hasn’t found the team yet');
  assert.equal(cheatBlock({ ...ok, inBattle: true }), 'inBattle');
  // the first thing the player can't change is named: an unknown bag before the rules, the rules before the wait
  assert.equal(cheatBlock({ supported: false, allowed: false, live: false, inBattle: true }), 'unsupported');
  assert.equal(cheatBlock({ supported: true, allowed: false, live: false, inBattle: true }), 'off');
  assert.equal(cheatBlock({ supported: true, allowed: true, live: false, inBattle: true }), 'waiting');
});

test('Gen 1 (Red/Yellow): new pair before the terminator, count + 1; an existing stack tops up to 99', () => {
  const e = entry({ platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  m.poke(0xd31d, [2, 0x14, 5, 0x04, 10, 0xff]); // Potion ×5, Poké Ball ×10
  m.poke(0xd347, [0x00, 0x30, 0x00]); // ₽3000 (BCD)
  assert.deepEqual(addRareCandies(e, m, {}), { ok: true, before: 0, after: 99, added: 99 });
  assert.deepEqual([...m.read(0xd31d, 8)], [3, 0x14, 5, 0x04, 10, 0x28, 99, 0xff]);
  assert.deepEqual(addRareCandies(e, m, {}), { error: 'max', before: 99 });

  const y = entry({ platform: 'gb', title: 'POKEMON YELLOW' });
  const n = memory();
  n.poke(0xd31c, [1, 0x28, 10, 0xff]);
  n.poke(0xd346, [0x00, 0x05, 0x00]);
  assert.deepEqual(addRareCandies(y, n, {}, 99), { ok: true, before: 10, after: 99, added: 89 });
  assert.deepEqual([...n.read(0xd31c, 4)], [1, 0x28, 99, 0xff]);
});

test('Gen 1: anything that is not a bag is left alone', () => {
  const e = entry({ platform: 'gb', title: 'POKEMON BLUE' });
  const cases = {
    'no terminator': (m) => { m.poke(0xd31d, [2, 0x14, 5, 0x04, 10, 0x00]); m.poke(0xd347, [0, 0x30, 0]); },
    'count > 20': (m) => { m.poke(0xd31d, [21]); m.poke(0xd347, [0, 0x30, 0]); },
    'quantity 0': (m) => { m.poke(0xd31d, [1, 0x14, 0, 0xff]); m.poke(0xd347, [0, 0x30, 0]); },
    'money not BCD (another layout)': (m) => { m.poke(0xd31d, [0, 0xff]); m.poke(0xd347, [0, 0x3a, 0]); },
  };
  for (const [name, fill] of Object.entries(cases)) {
    const m = memory();
    fill(m);
    assert.deepEqual(addRareCandies(e, m, {}), { error: 'notFound' }, name);
    assert.equal(m.writes, 0, name);
  }
  const full = memory();
  full.poke(0xd31d, [20, ...Array.from({ length: 20 }, (_, i) => [i + 1, 1]).flat(), 0xff]);
  full.poke(0xd347, [0, 0, 0]);
  assert.deepEqual(addRareCandies(e, full, {}), { error: 'full' });
  assert.equal(full.writes, 0);
});

test('Gen 2 (Crystal, Gold): items pocket, key items checked too', () => {
  const c = entry({ platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' });
  const m = memory();
  m.poke(0xd892, [1, 0x12, 3, 0xff]); // Potion ×3
  m.poke(0xd8bc, [1, 0x07, 0xff]); // one key item
  assert.equal(addRareCandies(c, m, {}).added, 99);
  assert.deepEqual([...m.read(0xd892, 6)], [2, 0x12, 3, 0x20, 99, 0xff]);

  const g = entry({ platform: 'gbc', title: 'POKEMON_GLD', code: 'AAUE' });
  const n = memory();
  n.poke(0xd5b7, [0, 0xff]);
  n.poke(0xd5e1, [0, 0xff]);
  assert.equal(addRareCandies(g, n, {}).added, 99);
  assert.deepEqual([...n.read(0xd5b7, 4)], [1, 0x20, 99, 0xff]);
  // key item list without its terminator → not the bag
  const bad = memory();
  bad.poke(0xd5b7, [0, 0xff]);
  bad.poke(0xd5e1, [2, 0x07, 0x08, 0x00]);
  assert.deepEqual(addRareCandies(g, bad, {}), { error: 'notFound' });
});

test('Gen 3 Ruby/Sapphire (US + German): fixed SaveBlock1, plain quantities', () => {
  for (const code of ['AXVE', 'AXPD']) {
    const e = entry({ platform: 'gba', code });
    const sb1 = 0x02025734;
    const m = memory();
    m.poke(sb1 + 0x490, le32(3000));
    m.poke(sb1 + 0x560, [...slot(13, 5)]); // Potion ×5
    m.poke(sb1 + 0x600, [...slot(4, 10)]); // Poké Ball ×10
    assert.deepEqual(addRareCandies(e, m, {}), { ok: true, before: 0, after: 99, added: 99 }, code);
    assert.deepEqual([u16(m, sb1 + 0x564), u16(m, sb1 + 0x566)], [68, 99]);
  }
});

function gen3Encrypted({ sb1Ptr, sb2Ptr, keyOff, money, items, balls }, { key = 0x1234abcd, sb1 = 0x02025a00, sb2 = 0x02024a00 } = {}) {
  const m = memory();
  const k = key & 0xffff;
  m.poke(sb1Ptr, le32(sb1));
  m.poke(sb2Ptr, le32(sb2));
  m.poke(sb2 + keyOff, le32(key));
  m.poke(sb1 + money, le32((3000 ^ key) >>> 0));
  m.poke(sb1 + items, [...slot(13, 5 ^ k), ...slot(68, 10 ^ k), ...slot(0, k)]);
  m.poke(sb1 + balls, [...slot(4, 10 ^ k)]);
  return { m, sb1, k };
}

test('Gen 3 Emerald / FireRed: through the save block pointers, quantities XOR the encryption key', () => {
  const layouts = {
    BPEE: { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, money: 0x490, items: 0x560, balls: 0x650 },
    BPRE: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 },
    BPGE: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 },
    // the German, French, Italian and Spanish FireRed/LeafGreen: same save blocks, pointers 0xB0 lower in IWRAM
    BPGD: { sb1Ptr: 0x03004f58, sb2Ptr: 0x03004f5c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 },
    BPRS: { sb1Ptr: 0x03004f58, sb2Ptr: 0x03004f5c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 },
  };
  for (const [code, L] of Object.entries(layouts)) {
    const e = entry({ platform: 'gba', code });
    const { m, sb1, k } = gen3Encrypted(L);
    // Rare Candy ×10 in slot 1: topped up to 99 (the bag's stack size), stored encrypted
    assert.deepEqual(addRareCandies(e, m, {}), { ok: true, before: 10, after: 99, added: 89 }, code);
    assert.equal(u16(m, sb1 + L.items + 6), 99 ^ k);
    assert.deepEqual(addRareCandies(e, m, {}), { error: 'max', before: 99 });
    // a wrong key (money decodes to nonsense) or a pointer outside EWRAM: no write
    const wrong = gen3Encrypted(L);
    wrong.m.poke(0x02024a00 + L.keyOff, le32(0x0badf00d));
    assert.deepEqual(addRareCandies(e, wrong.m, {}), { error: 'notFound' }, `${code} key`);
    const off = gen3Encrypted(L, { sb1: 0x03001000 });
    assert.deepEqual(addRareCandies(e, off.m, {}), { error: 'notFound' }, `${code} pointer`);
    assert.equal(wrong.m.writes + off.m.writes, 0);
  }
  // no Rare Candy yet: into the first free slot
  const L = layouts.BPEE;
  const { m, sb1, k } = gen3Encrypted(L);
  m.poke(sb1 + L.items + 4, slot(0, k)); // slot 1 cleared
  assert.deepEqual(addRareCandies(entry({ platform: 'gba', code: 'BPEE' }), m, {}), { ok: true, before: 0, after: 99, added: 99 });
  assert.deepEqual([u16(m, sb1 + L.items + 4), u16(m, sb1 + L.items + 6)], [68, 99 ^ k]);
});

/** A Gen 4/5 bag: pockets at their offsets, medicine first slot Potion ×2. */
function dsBag(m, bag, { key, tm, medicine }, { tmItem = 425, med = [slot(17, 2)] } = {}) {
  m.poke(bag + key, slot(468, 1));
  m.poke(bag + tm, slot(tmItem, 1));
  m.poke(bag + medicine, med.flat());
}

test('Gen 4 HeartGold/SoulSilver: medicine pocket in the save data, 999 per slot', () => {
  const e = entry({ platform: 'nds', code: 'IPKE' });
  const saveBase = 0x0227c2c8; // as read from a real HeartGold RAM image
  const bag = saveBase + 0x10 + 0x644;
  const m = memory();
  dsBag(m, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 });
  assert.deepEqual(addRareCandies(e, m, { saveBase }), { ok: true, before: 0, after: 99, added: 99 });
  assert.deepEqual([u16(m, bag + 0x524), u16(m, bag + 0x526)], [50, 99]);
  assert.deepEqual(addRareCandies(e, m, { saveBase }, 950), { ok: true, before: 99, after: 999, added: 900 });
  // without the pointer: from where the party was found (German HeartGold scans for it)
  const scanned = memory();
  dsBag(scanned, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 });
  const ger = entry({ platform: 'nds', code: 'IPKD' });
  assert.equal(addRareCandies(ger, scanned, { partyAddr: saveBase + 0xa8 - 8 }).added, 99);
  assert.equal(u16(scanned, bag + 0x524), 50);
});

test('Gen 4: an empty, foreign or broken bag is never written', () => {
  const e = entry({ platform: 'nds', code: 'IPGE' });
  const saveBase = 0x0227c2c8;
  const bag = saveBase + 0x10 + 0x644;
  const empty = memory();
  assert.deepEqual(addRareCandies(e, empty, { saveBase }), { error: 'notFound' }, 'nothing in it (zeros pass every other check)');
  const notTm = memory();
  dsBag(notTm, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 }, { tmItem: 17 });
  assert.deepEqual(addRareCandies(e, notTm, { saveBase }), { error: 'notFound' }, 'a Potion in the TM pocket');
  const qty = memory();
  dsBag(qty, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 }, { med: [slot(17, 1000)] });
  assert.deepEqual(addRareCandies(e, qty, { saveBase }), { error: 'notFound' }, 'quantity over 999');
  assert.deepEqual(addRareCandies(e, memory(), {}), { error: 'notFound' }, 'no party read yet');
  assert.equal(empty.writes + notTm.writes + qty.writes, 0);
  const full = memory();
  dsBag(full, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 }, { med: Array.from({ length: 40 }, (_, i) => slot(200 + i, 1)) });
  assert.deepEqual(addRareCandies(e, full, { saveBase }), { error: 'full' });
});

test('Gen 4 Platinum / Diamond: their own general block and bag offsets', () => {
  const pt = entry({ platform: 'nds', code: 'CPUE' });
  const m = memory();
  const saveBase = 0x02270000;
  dsBag(m, saveBase + 0x14 + 0x630, { key: 0x294, tm: 0x35c, medicine: 0x51c });
  assert.equal(addRareCandies(pt, m, { saveBase }).added, 99);
  assert.equal(u16(m, saveBase + 0x14 + 0x630 + 0x51c + 4), 50);
  const dp = entry({ platform: 'nds', code: 'ADAE' });
  const n = memory();
  dsBag(n, saveBase + 0x214 + 0x624, { key: 0x294, tm: 0x35c, medicine: 0x51c });
  assert.equal(addRareCandies(dp, n, { partyAddr: saveBase + 0x2ac - 8 }).added, 99);
  assert.equal(u16(n, saveBase + 0x214 + 0x624 + 0x51c + 4), 50);
});

test('Gen 5 Black/White/B2W2: inventory block 0xA00 before the party block', () => {
  for (const code of ['IRBO', 'IREO']) {
    const e = entry({ platform: 'nds', code });
    const partyAddr = 0x022349ac; // Black: mons at 0x022349B4, the block starts 8 bytes earlier
    const bag = partyAddr - 0xa00;
    const m = memory();
    dsBag(m, bag, { key: 0x4d8, tm: 0x624, medicine: 0x7d8 }, { tmItem: 618 }); // TM93 (Gen 5 numbering)
    assert.deepEqual(addRareCandies(e, m, { partyAddr }), { ok: true, before: 0, after: 99, added: 99 }, code);
    assert.deepEqual([u16(m, bag + 0x7d8 + 4), u16(m, bag + 0x7d8 + 6)], [50, 99]);
  }
});

test('a write the emulator refuses is reported, not logged as done', () => {
  const e = entry({ platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  m.poke(0xd31d, [0, 0xff]);
  m.poke(0xd347, [0, 0, 0]);
  assert.deepEqual(addRareCandies(e, { read: m.read, write: () => false }, {}), { error: 'write' });
  // the emulator says yes but the bytes didn't change
  assert.deepEqual(addRareCandies(e, { read: m.read, write: () => true }, {}), { error: 'write' });
});

// ---- 3DS (Gen 6/7) ------------------------------------------------------------------------------------------

const ctr = (titleId) => entry({ platform: '3ds', titleId });
const XY = '0004000000055D00';
const ORAS = '000400000011C400';
const SM = '0004000000164800';
const USUM = '00040000001B5100'; // Ultra Moon
const u32 = (m, a) => { const b = m.read(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
const g7 = (id, qty, sort = 0, isNew = false) => le32((id | (qty << 10) | (sort << 20) | (isNew ? 0x40000000 : 0)) >>> 0);
/** Sun/Moon's bag as seen live in Sun 1.0: the key item from Hala, nothing else, the pocket pointers behind the block. */
function sunBag(base = 0x330d5934, { ptrs = true } = {}) {
  const m = memory();
  m.poke(base + 0x6b8, g7(845, 1, 0, true)); // Sparkling Stone, NEW
  // the order the game keeps them in: Medicine, Items, TMs, Berries, Key Items, Z-Crystals
  if (ptrs) m.poke(base + 0xde0, [0xb48, 0x000, 0x998, 0xc48, 0x6b8, 0xd68].flatMap((o) => le32(base + o)));
  return m;
}

test('3DS: all four games can get Rare Candies – the bag is watched with the party', () => {
  for (const t of [XY, '0004000000055E00', ORAS, '000400000011C500', SM, '0004000000175E00', '00040000001B5000', USUM]) assert.ok(cheatSupported(ctr(t)), t);
  assert.deepEqual(cheatRegions(ctr(XY)).map((r) => [r.addr, r.len]), [[0x08c67564, 0xb88 + 20], [0x08c67554, 0xb88 + 20]]);
  assert.deepEqual(cheatRegions(ctr(ORAS)).map((r) => r.addr), [0x08c6ec70, 0x08c6ac80]);
  assert.deepEqual(cheatRegions(ctr(SM)).map((r) => [r.addr, r.len]), [[0x330d5934, 0xde0 + 24]]);
  assert.deepEqual(cheatRegions(ctr(USUM)).map((r) => [r.addr, r.len]), [[0x33011934, 0xe28 + 28]]);
  assert.deepEqual(cheatRegions(entry({ platform: 'nds', code: 'IPKE' })), []);
  // Medicine items only: nothing lands in the wrong pocket (Poké Balls: into Items, asked for as 'balls' or 'items')
  assert.deepEqual(addItem(ctr(SM), sunBag(), {}, 4, 5), { error: 'unsupported' });
  assert.equal(POKE_BALL[7], 4);
});

test('Sun/Moon: a new Medicine slot as the game files items (NEW, not in Free Space), then the stack grows to 999', () => {
  const e = ctr(SM);
  const m = sunBag();
  const med = 0x330d5934 + 0xb48;
  assert.deepEqual(addRareCandies(e, m, { g67: 0 }), { ok: true, before: 0, after: 99, added: 99 });
  assert.equal(u32(m, med), (50 | (99 << 10) | 0x40000000) >>> 0);
  assert.equal(u32(m, 0x330d5934 + 0x6b8), (845 | (1 << 10) | 0x40000000) >>> 0); // the key item untouched
  // the stack: only the count changes – its Free Space place and NEW mark stay
  m.poke(med, g7(50, 900, 3, true));
  assert.deepEqual(addRareCandies(e, m, {}), { ok: true, before: 900, after: 999, added: 99 });
  assert.equal(u32(m, med), (50 | (999 << 10) | (3 << 20) | 0x40000000) >>> 0);
  assert.deepEqual(addRareCandies(e, m, {}), { error: 'max', before: 999 });
  assert.equal(m.writes, 2);
  // behind other medicine: the first free slot
  const m2 = sunBag();
  m2.poke(med, [...g7(17, 3, 1), ...g7(18, 2)]);
  assert.equal(addRareCandies(e, m2, {}).ok, true);
  assert.equal(u32(m2, med + 8), (50 | (99 << 10) | 0x40000000) >>> 0);
  assert.equal(u32(m2, med), (17 | (3 << 10) | (1 << 20)) >>> 0);
});

test('Sun/Moon: the 3DS player answers later – a Promise of the result', async () => {
  const e = ctr(SM);
  const m = sunBag();
  const later = { read: m.read, write: (a, b) => new Promise((r) => setTimeout(() => r(m.write(a, b)), 5)) };
  const p = addRareCandies(e, later, {});
  assert.equal(typeof p.then, 'function');
  assert.deepEqual(await p, { ok: true, before: 0, after: 99, added: 99 });
  // refused by the host (the game changed the bag meanwhile, the page went away): nothing is logged as done
  const refused = { read: m.read, write: () => Promise.resolve(false) };
  assert.deepEqual(await addRareCandies(e, refused, {}), { error: 'write' });
  assert.deepEqual(await addRareCandies(e, { read: m.read, write: () => Promise.reject(new Error('gone')) }, {}), { error: 'write' });
  // the host's reason comes along: the game changed the bag meanwhile – its own message; anything else stays a failed
  // write, with the reason for the diagnostics
  const why = (w) => ({ read: m.read, write: () => Promise.resolve({ ok: false, why: w }) });
  assert.deepEqual(await addRareCandies(e, why('changed'), {}), { error: 'changed' });
  assert.deepEqual(await addRareCandies(e, why('failed'), {}), { error: 'write', why: 'failed' });
  assert.deepEqual(await addRareCandies(e, why('notFound'), {}), { error: 'write', why: 'notFound' });
  assert.deepEqual(addRareCandies(e, { read: m.read, write: () => ({ ok: false, why: 'range' }) }, {}), { error: 'write', why: 'range' });
});

test('3DS: anything that is not the bag is never written', () => {
  const e = ctr(SM);
  const med = 0x330d5934 + 0xb48;
  const tries = [
    ['nothing there (title screen, another game in that memory)', () => memory()],
    ['pointers to other pockets', () => {
      const m = sunBag();
      m.poke(0x330d5934 + 0xde0, le32(0x330d0000));
      return m;
    }],
    ['a non-medicine id in Medicine', () => { const m = sunBag(); m.poke(med, g7(4, 5)); return m; }],
    ['an id past the last item', () => { const m = sunBag(); m.poke(0x330d5934, g7(1000, 1)); return m; }],
    ['a count above 999', () => { const m = sunBag(); m.poke(0x330d5934, g7(4, 1000)); return m; }],
    ['bit 31', () => { const m = sunBag(); m.poke(0x330d5934, le32((4 | (1 << 10) | 0x80000000) >>> 0)); return m; }],
    ['a count without an item', () => { const m = sunBag(); m.poke(0x330d5934 + 8, g7(0, 3)); return m; }],
    ['a non-TM in the TM pocket', () => { const m = sunBag(); m.poke(0x330d5934 + 0x998, g7(17, 1)); return m; }],
  ];
  for (const [why, mk] of tries) {
    const m = mk();
    assert.equal(addRareCandies(e, m, {}).error, 'notFound', why);
    assert.equal(m.writes, 0, why);
  }
  // without the pointer table (or a game that has none): the slots alone decide
  assert.equal(addRareCandies(e, sunBag(undefined, { ptrs: false }), {}).ok, true);
  // a full pocket
  const full = sunBag();
  for (let i = 0; i < 64; i++) full.poke(med + i * 4, g7(17 + (i % 33), 1)); // (no Rare Candy among them)
  assert.deepEqual(addRareCandies(e, full, {}), { error: 'full' });
  assert.equal(full.writes, 0);
});

test('Ultra Sun/Ultra Moon: their own pockets (Medicine at +0xB74)', () => {
  const base = 0x33011934;
  const m = memory();
  m.poke(base + 0x6ac, g7(845, 1));
  m.poke(base + 0xe28, [0xb74, 0x000, 0x9c4, 0xc64, 0x6ac, 0xd70, 0xdfc].flatMap((o) => le32(base + o)));
  assert.equal(addRareCandies(ctr(USUM), m, { g67: 0 }).ok, true);
  assert.equal(u32(m, base + 0xb74), (50 | (99 << 10) | 0x40000000) >>> 0);
  // Sun/Moon's offsets would be wrong here: Sun's pointer layout at USUM's address is refused
  const sm = sunBag(base);
  assert.deepEqual(addRareCandies(ctr(USUM), sm, {}), { error: 'notFound', why: 'missing', tried: [{ at: '0x33011934', why: 'slot z#32 0x33011FEC' }] });
});

test('X/Y and ORAS: { u16 id, u16 count } slots, the update the party was found at first', () => {
  // X/Y 1.0 (the party found at partyAddrs[1]): the bag 0x10 before 1.5's
  const xy = ctr(XY);
  const b10 = 0x08c67554;
  const m = memory();
  m.poke(b10, slot(4, 10)); // Poké Balls
  m.poke(b10 + 0x968, slot(17, 2)); // Potions in Medicine
  assert.deepEqual(addRareCandies(xy, m, { g67: 1 }), { ok: true, before: 0, after: 99, added: 99 });
  assert.equal(u16(m, b10 + 0x968 + 4), 50);
  assert.equal(u16(m, b10 + 0x968 + 6), 99);
  assert.equal(u16(m, b10 + 0x968 + 2), 2);
  // a stack: the count's two bytes only
  m.writes = 0;
  assert.deepEqual(addRareCandies(xy, m, { g67: 1 }), { ok: true, before: 99, after: 198, added: 99 });
  assert.equal(u16(m, b10 + 0x968 + 6), 198);
  assert.equal(m.writes, 1);
  // ORAS: Medicine at +0x970; 1.4's address is tried even when the state knows no update yet
  const oras = ctr(ORAS);
  const b14 = 0x08c6ec70;
  const m2 = memory();
  m2.poke(b14 + 0x640, slot(457, 1)); // a key item
  m2.poke(b14 + 0x970, slot(65, 1)); // a flute – Medicine in ORAS
  assert.equal(addRareCandies(oras, m2, {}).ok, true);
  assert.equal(u16(m2, b14 + 0x970 + 4), 50);
  // a Potion in the TM pocket isn't a bag
  const m3 = memory();
  m3.poke(b14, slot(4, 1));
  m3.poke(b14 + 0x7c0, slot(17, 1));
  assert.deepEqual(addRareCandies(oras, m3, {}), { error: 'notFound', why: 'missing', tried: [{ at: '0x08C6EC70', why: 'slot tm#0 0x00010011' }, { at: '0x08C6AC80', why: 'empty' }] });
  assert.equal(m3.writes, 0);
});

// ---- 3DS: an empty bag, and a bag that isn't where souldew knows it (2.8.4) ------------------------------------
// Ultra Moon 1.0 (checked live, US cartridge): the bag at 0x33011934 – the same as 1.2 –, all zeros until the game puts
// a first item in (no key item with the starter: the bag stays empty for a while), the game's pocket table right
// behind it from the intro on, in the order Medicine, Items, TMs, Berries, Key Items, Z-Crystals, Rotom Powers.

const UM_ORDER = [0xb74, 0x000, 0x9c4, 0xc64, 0x6ac, 0xd70, 0xdfc];
const SUN_ORDER = [0xb48, 0x000, 0x998, 0xc48, 0x6b8, 0xd68];
/** A Gen 7 bag at `base`: its pocket table behind the block (unless `table` false), `items` as [offset, u32 bytes]. */
function g7Bag(m, base, { size = 0xe28, order = UM_ORDER, table = true, items = [] } = {}) {
  if (table) m.poke(base + size, order.flatMap((o) => le32(base + o)));
  for (const [off, bytes] of items) m.poke(base + off, bytes);
  return m;
}
/** The 3DS player's view of `m`: only what it watches reads (the game's bag regions and what watch() asked for). */
function player(m, e, { watchOk = true } = {}) {
  let extra = [];
  const seen = (a, len) => [...cheatRegions(e), ...extra].some((r) => a >= r.addr && a + len <= r.addr + r.len);
  const p = {
    asked: [],
    read: (a, len) => (seen(a, len) ? m.read(a, len) : null),
    write: (a, b) => (seen(a, b.length) ? m.write(a, b) : false),
    watch: async (regions) => {
      p.asked.push(regions.map((r) => r.addr));
      extra = watchOk ? regions : [];
      return watchOk;
    },
  };
  return p;
}

test('Ultra Moon / Sun 1.0: an empty bag is the bag where the game’s pocket table vouches for it', () => {
  for (const [t, base, size, order] of [[USUM, 0x33011934, 0xe28, UM_ORDER], ['00040000001B5000', 0x33011934, 0xe28, UM_ORDER], [SM, 0x330d5934, 0xde0, SUN_ORDER]]) {
    const e = ctr(t);
    const m = g7Bag(memory(), base, { size, order });
    assert.equal(readBalls(e, m.read, { g67: 0 }), 0, `${t}: a bag without balls, not "unknown"`);
    assert.deepEqual(addRareCandies(e, m, { g67: 0 }), { ok: true, before: 0, after: 99, added: 99 }, t);
    assert.deepEqual(addMaxRepels(e, m, {}), { ok: true, before: 0, after: 10, added: 10 }, t);
    assert.equal(u32(m, base), (77 | (10 << 10) | 0x40000000) >>> 0);
    // all zeros and no table: it can't be told from any other memory – nothing written, and the reason says so
    const z = memory();
    assert.deepEqual(addRareCandies(e, z, {}), { error: 'notFound', why: 'empty', tried: [{ at: `0x${base.toString(16).toUpperCase()}`, why: 'empty' }] });
    assert.equal(readBalls(e, z.read, {}), null);
    assert.equal(z.writes, 0);
  }
  // the table of a block somewhere else, or with one pocket off by a slot: not this bag
  const m = memory();
  m.poke(0x33011934 + 0xe28, UM_ORDER.map((o, i) => 0x33011934 + o + (i === 3 ? 4 : 0)).flatMap(le32));
  assert.deepEqual(addRareCandies(ctr(USUM), m, {}), { error: 'notFound', why: 'missing', tried: [{ at: '0x33011934', why: 'pointers' }] });
  // X/Y 1.0 and 1.5 (no table known there): an empty bag at either is refused, both named
  assert.deepEqual(addRareCandies(ctr(XY), memory(), { g67: 1 }).tried, [{ at: '0x08C67554', why: 'empty' }, { at: '0x08C67564', why: 'empty' }]);
});

test('Ultra Sun / Ultra Moon: a slot the game emptied but kept the id of (count 0) doesn’t hide the bag (#45)', () => {
  for (const t of [USUM, '00040000001B5000']) {
    const e = ctr(t);
    const base = 0x33011934;
    // a Quick Claw given to a Pokémon: its id stays in the slot with count 0 (seen in slot 3 and in the last slot)
    for (const at of [3 * 4, 426 * 4]) {
      const m = g7Bag(memory(), base, { items: [[0, g7(1, 5)], [at, g7(217, 0)]] });
      assert.deepEqual(addRareCandies(e, m, { g67: 0 }), { ok: true, before: 0, after: 99, added: 99 }, `${t} @${at}`);
      assert.equal(u32(m, base + 0xb74), (50 | (99 << 10) | 0x40000000) >>> 0);
      assert.equal(u32(m, base + at), (217 >>> 0), 'the emptied slot stays as the game left it');
    }
    // still refused: an id beyond the game's items with count 0
    const bad = g7Bag(memory(), base, { table: false, items: [[0, g7(1, 5)], [12, g7(1000, 0)]] });
    assert.equal(addRareCandies(e, bad, { g67: 0 }).error, 'notFound');
  }
});

test('3DS search: Ultra Moon’s bag where no known update keeps it – found by the pocket table, kept for the session', async () => {
  const e = ctr(USUM);
  for (const shift of [0x1f000, -0x2f2c4, 0x4f000]) {
    const base = 0x33011934 + shift;
    const m = g7Bag(memory(), base, { items: [[0x6ac, g7(845, 1)]] }); // the Sparkling Stone, nothing else
    const p = player(m, e);
    const state = { g67: 0 };
    assert.equal(readBalls(e, p.read, state), null, 'not at the known address');
    const res = await addRareCandies(e, p, state);
    assert.deepEqual(res, { ok: true, before: 0, after: 99, added: 99 }, shift.toString(16));
    assert.deepEqual(state.ctrBag, { base, how: 'table' });
    assert.equal(u32(m, base + 0xb74), (50 | (99 << 10) | 0x40000000) >>> 0);
    assert.ok(p.asked.length >= 2 && p.asked.at(-1).length === 1 && p.asked.at(-1)[0] === base, 'only the bag stays watched');
    // from now on it is tried first – no search
    const asked = p.asked.length;
    assert.deepEqual(await addMaxRepels(e, p, state), { ok: true, before: 0, after: 10, added: 10 });
    assert.equal(readBalls(e, p.read, state), 0);
    assert.equal(p.asked.length, asked);
  }
  // further away than the search goes: not found – what was tried and how the search went, for the diagnostics
  const far = player(g7Bag(memory(), 0x33011934 + 0x80000), e);
  const res = await addRareCandies(e, far, {});
  assert.deepEqual(res, { error: 'notFound', why: 'empty', tried: [{ at: '0x33011934', why: 'empty' }], scan: { found: null, why: 'none', windows: 11 } });
  assert.deepEqual(far.asked.at(-1), [], 'the windows are let go');
  // a player that can't read more: no search, the answer as before
  const no = player(g7Bag(memory(), 0x33011934 + 0x1000), e, { watchOk: false });
  assert.deepEqual((await addRareCandies(e, no, {})).scan, { found: null, why: 'noMemory', windows: 0 });
  // without watch (the other players): no search at all, the answer right away
  assert.equal(addRareCandies(e, { read: no.read, write: no.write }, {}).error, 'notFound');
});

test('3DS search: near misses are refused – a wrong table, a broken slot, two bags', async () => {
  const e = ctr(USUM);
  const base = 0x33011934 + 0x9000;
  const tries = [
    ['a table one pocket off', () => {
      const m = memory();
      m.poke(base + 0xe28, UM_ORDER.map((o, i) => base + o + (i === 6 ? 4 : 0)).flatMap(le32));
      return m;
    }],
    ['Sun’s table at Ultra Moon’s size', () => g7Bag(memory(), base, { size: 0xe28, order: SUN_ORDER })],
    ['a Poké Ball in Medicine', () => g7Bag(memory(), base, { items: [[0xb74, g7(4, 5)]] })],
    ['a count above 999', () => g7Bag(memory(), base, { items: [[0, g7(4, 1000)]] })],
    ['two places with a table (a copy)', () => g7Bag(g7Bag(memory(), base), base + 0x3000)],
  ];
  for (const [why, mk] of tries) {
    const m = mk();
    const state = {};
    const res = await addRareCandies(e, player(m, e), state);
    assert.equal(res.error, 'notFound', why);
    assert.equal(m.writes, 0, why);
    assert.equal(state.ctrBag, undefined, why);
  }
  const two = await addRareCandies(e, player(tries[4][1](), e), {});
  assert.deepEqual(two.scan, { found: null, why: 'ambiguous', windows: 6, candidates: 2 }); // (a table found: no further round)
});

test('3DS search: X/Y without a pocket table – found by its slots when nothing else nearby looks like a bag', async () => {
  const e = ctr(XY);
  const base = 0x08c67564 + 0x7a10; // (between the windows' overlaps and anywhere else alike)
  const xyBag = (m, b, { gap = false, dup = false } = {}) => {
    m.poke(b, [...slot(4, 10), ...slot(2, 1), ...(gap ? slot(0, 0) : []), ...slot(dup ? 4 : 3, 2)]); // Poké / Ultra / Great Balls
    m.poke(b + 0x640, slot(457, 1)); // a key item
    m.poke(b + 0x968, slot(17, 2)); // Potions
    return m;
  };
  const m = xyBag(memory(), base);
  const state = {};
  assert.deepEqual(await addRareCandies(e, player(m, e), state), { ok: true, before: 0, after: 99, added: 99 });
  assert.deepEqual(state.ctrBag, { base, how: 'slots' });
  assert.deepEqual([u16(m, base + 0x968 + 4), u16(m, base + 0x968 + 6)], [50, 99]);
  // ORAS: the same by its own layout
  const ob = 0x08c6ec70 - 0x20000;
  const om = memory();
  om.poke(ob, slot(4, 3));
  om.poke(ob + 0x640, slot(457, 1));
  const os = {};
  assert.equal((await addMaxRepels(ctr(ORAS), player(om, ctr(ORAS)), os)).ok, true);
  assert.deepEqual(os.ctrBag, { base: ob, how: 'slots' });
  // refused: a gap in a pocket, an item twice, only one pocket with anything in it, two such bags, the X/Y bag in ORAS
  const tries = [
    ['a gap', () => xyBag(memory(), base, { gap: true })],
    ['an item twice', () => xyBag(memory(), base, { dup: true })],
    ['one pocket only', () => { const n = memory(); n.poke(base, [...slot(4, 10), ...slot(2, 1)]); return n; }],
    ['two bags', () => xyBag(xyBag(memory(), base), base + 0x5000)],
  ];
  for (const [why, mk] of tries) {
    const n = mk();
    const res = await addRareCandies(e, player(n, e), {});
    assert.equal(res.error, 'notFound', why);
    assert.equal(n.writes, 0, why);
  }
  assert.equal((await addRareCandies(e, player(tries[3][1](), e), {})).scan.why, 'ambiguous');
});

test('3DS search: the windows – 64 KB, overlapping by more than a bag, a few per read, around every known address', () => {
  for (const t of [XY, ORAS, SM, USUM]) {
    const e = ctr(t);
    const plan = ctrScanPlan(e);
    const wins = plan.flat();
    const len = cheatRegions(e)[0].len;
    assert.ok(plan.every((r) => r.length <= 6), t);
    // next to the game's own regions: never more than the player reads (16)
    assert.ok(regionsFor(e).length + cheatRegions(e).length + 6 <= 16, t);
    assert.ok(wins.every((w) => w.len === CTR_WINDOW && w.len <= 65536), t);
    const sorted = wins.map((w) => w.addr).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] <= CTR_WINDOW - len, `${t}: windows overlap by a bag`);
    // ±0x50000 around each known address, nearest first
    for (const { addr } of cheatRegions(e)) {
      assert.ok(sorted[0] <= addr - 0x50000 && sorted.at(-1) + CTR_WINDOW >= addr + 0x50000 + len, t);
      assert.ok(wins[0].addr <= addr + 0x8000 || cheatRegions(e).length > 1, t);
    }
  }
  assert.deepEqual(ctrScanPlan(entry({ platform: 'nds', code: 'IPKE' })), []);
  // a window's own search, as the research uses it: the one table in it
  const m = g7Bag(memory(), 0x33012000);
  assert.deepEqual(ctrScanWindow(ctr(USUM), 0x33010000, m.read(0x33010000, 0x10000)), [{ base: 0x33012000, how: 'table' }]);
  assert.deepEqual(ctrScanWindow(ctr(USUM), 0x33010000, m.read(0x33010000, 0x10000), { table: false }), [], 'an empty bag has no slots to go by');
});

test('3DS search: several asks at once share one search', async () => {
  const e = ctr(SM);
  const base = 0x330d5934 - 0x4000;
  const m = g7Bag(memory(), base, { size: 0xde0, order: SUN_ORDER });
  const p = player(m, e);
  const state = {};
  const [a, b] = await Promise.all([locateCtrBag(e, p, state), locateCtrBag(e, p, state)]);
  assert.equal(a, b);
  assert.deepEqual(a, { found: '0x330D1934', how: 'table', windows: 6, candidates: 1 });
  assert.equal(state.ctrBagSearch, null);
  assert.equal(await locateCtrBag(entry({ platform: 'nds', code: 'IPKE' }), p, {}), null);
});

// ---- Max Repels: the Items pocket in every generation ------------------------------------------------------

test('Max Repels, Gen 1 (Red/Yellow): ten as a new pair, then up to 99; a full bag is left alone', () => {
  const e = entry({ platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  m.poke(0xd31d, [2, 0x14, 5, 0x28, 99, 0xff]); // Potion ×5, Rare Candy ×99
  m.poke(0xd347, [0x00, 0x30, 0x00]);
  assert.deepEqual(addMaxRepels(e, m, {}), { ok: true, before: 0, after: 10, added: 10 });
  assert.deepEqual([...m.read(0xd31d, 8)], [3, 0x14, 5, 0x28, 99, 0x39, 10, 0xff]);
  // the same through the play screen's id
  assert.deepEqual(applyCheat('maxRepel', e, m, {}), { ok: true, before: 10, after: 20, added: 10 });
  assert.equal(m.read(0xd31d + 6, 1)[0], 20);
  const y = entry({ platform: 'gb', title: 'POKEMON YELLOW' });
  const n = memory();
  n.poke(0xd31c, [1, 0x39, 95, 0xff]);
  n.poke(0xd346, [0x00, 0x05, 0x00]);
  assert.deepEqual(addMaxRepels(y, n, {}), { ok: true, before: 95, after: 99, added: 4 }, 'capped at the stack size');
  assert.deepEqual(addMaxRepels(y, n, {}), { error: 'max', before: 99 });
  const full = memory();
  full.poke(0xd31d, [20, ...Array.from({ length: 20 }, (_, i) => [i + 1, 1]).flat(), 0xff]);
  full.poke(0xd347, [0, 0, 0]);
  assert.deepEqual(addMaxRepels(e, full, {}), { error: 'full' });
  assert.equal(full.writes, 0);
});

test('Max Repels, Gen 2 (Crystal, Gold): the items pocket, not the balls behind the key items', () => {
  const c = entry({ platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' });
  const m = memory();
  m.poke(0xd892, [1, 0x12, 3, 0xff]);
  m.poke(0xd8bc, [1, 0x07, 0xff]);
  assert.equal(addMaxRepels(c, m, {}).added, 10);
  assert.deepEqual([...m.read(0xd892, 6)], [2, 0x12, 3, 0x2b, 10, 0xff]);
  assert.deepEqual([...m.read(0xd8bc, 3)], [1, 0x07, 0xff], 'the key items untouched');
  const g = entry({ platform: 'gbc', title: 'POKEMON_GLD', code: 'AAUE' });
  const n = memory();
  n.poke(0xd5b7, [0, 0xff]);
  n.poke(0xd5e1, [0, 0xff]);
  assert.equal(addMaxRepels(g, n, {}).added, 10);
  assert.deepEqual([...n.read(0xd5b7, 4)], [1, 0x2b, 10, 0xff]);
});

test('Max Repels, Gen 3: Ruby/Sapphire plain, Emerald/FireRed encrypted – the Items pocket, 99 a stack', () => {
  for (const code of ['AXVE', 'AXPD']) {
    const e = entry({ platform: 'gba', code });
    const sb1 = 0x02025734;
    const m = memory();
    m.poke(sb1 + 0x490, le32(3000));
    m.poke(sb1 + 0x560, [...slot(13, 5)]);
    m.poke(sb1 + 0x600, [...slot(4, 10)]);
    assert.deepEqual(addMaxRepels(e, m, {}), { ok: true, before: 0, after: 10, added: 10 }, code);
    assert.deepEqual([u16(m, sb1 + 0x564), u16(m, sb1 + 0x566)], [84, 10]);
    assert.deepEqual([u16(m, sb1 + 0x600), u16(m, sb1 + 0x602)], [4, 10], 'the Poké Balls untouched');
  }
  const layouts = {
    BPEE: { sb1Ptr: 0x03005d8c, sb2Ptr: 0x03005d90, keyOff: 0xac, money: 0x490, items: 0x560, balls: 0x650 },
    BPRE: { sb1Ptr: 0x03005008, sb2Ptr: 0x0300500c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 },
    BPGD: { sb1Ptr: 0x03004f58, sb2Ptr: 0x03004f5c, keyOff: 0xf20, money: 0x290, items: 0x310, balls: 0x430 },
  };
  for (const [code, L] of Object.entries(layouts)) {
    const e = entry({ platform: 'gba', code });
    const { m, sb1, k } = gen3Encrypted(L); // Potion ×5, Rare Candy ×10, then an empty slot
    assert.deepEqual(addMaxRepels(e, m, {}), { ok: true, before: 0, after: 10, added: 10 }, code);
    assert.deepEqual([u16(m, sb1 + L.items + 8), u16(m, sb1 + L.items + 10)], [84, 10 ^ k], `${code}: into the free slot, encrypted`);
    assert.equal(u16(m, sb1 + L.items + 6), 10 ^ k, 'the Rare Candies untouched');
    m.poke(sb1 + L.items + 10, le16(95 ^ k));
    assert.deepEqual(addMaxRepels(e, m, {}), { ok: true, before: 95, after: 99, added: 4 });
    const wrong = gen3Encrypted(L);
    wrong.m.poke(0x02024a00 + L.keyOff, le32(0x0badf00d));
    assert.deepEqual(addMaxRepels(e, wrong.m, {}), { error: 'notFound' }, `${code} key`);
    assert.equal(wrong.m.writes, 0);
  }
});

test('Max Repels, Gen 4/5: the Items pocket at the bag’s start, 999 a stack; Medicine untouched', () => {
  const cases = [
    [{ platform: 'nds', code: 'IPKE' }, 0x0227c2c8 + 0x10 + 0x644, { key: 0x294, tm: 0x35c, medicine: 0x520 }, { saveBase: 0x0227c2c8 }],
    [{ platform: 'nds', code: 'CPUE' }, 0x02270000 + 0x14 + 0x630, { key: 0x294, tm: 0x35c, medicine: 0x51c }, { saveBase: 0x02270000 }],
    [{ platform: 'nds', code: 'ADAE' }, 0x02270000 + 0x214 + 0x624, { key: 0x294, tm: 0x35c, medicine: 0x51c }, { partyAddr: 0x02270000 + 0x2ac - 8 }],
    [{ platform: 'nds', code: 'IRBO' }, 0x022349ac - 0xa00, { key: 0x4d8, tm: 0x624, medicine: 0x7d8 }, { partyAddr: 0x022349ac }, { tmItem: 618 }],
    [{ platform: 'nds', code: 'IREO' }, 0x022349ac - 0xa00, { key: 0x4d8, tm: 0x624, medicine: 0x7d8 }, { partyAddr: 0x022349ac }, { tmItem: 618 }],
  ];
  for (const [h, bag, P, state, opts] of cases) {
    const m = memory();
    dsBag(m, bag, P, opts);
    m.poke(bag, slot(4, 5)); // Poké Balls in the Items pocket's first slot (Gen 5 keeps them there; Gen 4 doesn't care)
    assert.deepEqual(addMaxRepels(entry(h), m, state), { ok: true, before: 0, after: 10, added: 10 }, h.code);
    assert.deepEqual([u16(m, bag + 4), u16(m, bag + 6)], [77, 10], h.code);
    assert.deepEqual([u16(m, bag + P.medicine), u16(m, bag + P.medicine + 2), u16(m, bag + P.medicine + 4)], [17, 2, 0], `${h.code}: Medicine untouched`);
    m.poke(bag + 6, le16(995));
    assert.deepEqual(addMaxRepels(entry(h), m, state), { ok: true, before: 995, after: 999, added: 4 }, h.code);
    assert.deepEqual(addMaxRepels(entry(h), m, state), { error: 'max', before: 999 }, h.code);
  }
  // a full Items pocket (165 slots in HeartGold) is refused, and so is a bag that isn't one
  const bag = 0x0227c2c8 + 0x10 + 0x644;
  const full = memory();
  dsBag(full, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 });
  full.poke(bag, Array.from({ length: 165 }, (_, i) => slot(80 + (i % 100), 1)).flat());
  assert.deepEqual(addMaxRepels(entry({ platform: 'nds', code: 'IPKE' }), full, { saveBase: 0x0227c2c8 }), { error: 'full' });
  const notTm = memory();
  dsBag(notTm, bag, { key: 0x294, tm: 0x35c, medicine: 0x520 }, { tmItem: 17 });
  assert.deepEqual(addMaxRepels(entry({ platform: 'nds', code: 'IPKE' }), notTm, { saveBase: 0x0227c2c8 }), { error: 'notFound' });
  assert.equal(full.writes + notTm.writes, 0);
});

test('Max Repels, 3DS: the Items pocket (NEW, not in Free Space), the update the party was found at first', () => {
  // Sun/Moon: Items at the block's start
  const sm = ctr(SM);
  const m = sunBag();
  const base = 0x330d5934;
  assert.deepEqual(addMaxRepels(sm, m, { g67: 0 }), { ok: true, before: 0, after: 10, added: 10 });
  assert.equal(u32(m, base), (77 | (10 << 10) | 0x40000000) >>> 0);
  assert.equal(u32(m, base + 0xb48), 0, 'Medicine untouched');
  // the stack: only the count, its Free Space place and NEW mark stay
  m.poke(base, g7(77, 995, 4, true));
  assert.deepEqual(addMaxRepels(sm, m, {}), { ok: true, before: 995, after: 999, added: 4 });
  assert.equal(u32(m, base), (77 | (999 << 10) | (4 << 20) | 0x40000000) >>> 0);
  assert.deepEqual(addMaxRepels(sm, m, {}), { error: 'max', before: 999 });
  // Ultra Sun/Ultra Moon: same place in its own block
  const ub = 0x33011934;
  const um = memory();
  um.poke(ub + 0x6ac, g7(845, 1));
  um.poke(ub + 0xe28, [0xb74, 0x000, 0x9c4, 0xc64, 0x6ac, 0xd70, 0xdfc].flatMap((o) => le32(ub + o)));
  assert.equal(addMaxRepels(ctr(USUM), um, {}).ok, true);
  assert.equal(u32(um, ub), (77 | (10 << 10) | 0x40000000) >>> 0);
  // X/Y 1.0 ({ u16 id, u16 count }): behind the Poké Balls in the Items pocket
  const b10 = 0x08c67554;
  const xy = memory();
  xy.poke(b10, slot(4, 10));
  xy.poke(b10 + 0x968, slot(17, 2));
  assert.deepEqual(addMaxRepels(ctr(XY), xy, { g67: 1 }), { ok: true, before: 0, after: 10, added: 10 });
  assert.deepEqual([u16(xy, b10 + 4), u16(xy, b10 + 6)], [77, 10]);
  // ORAS 1.4
  const b14 = 0x08c6ec70;
  const oras = memory();
  oras.poke(b14 + 0x640, slot(457, 1));
  assert.equal(addMaxRepels(ctr(ORAS), oras, {}).ok, true);
  assert.deepEqual([u16(oras, b14), u16(oras, b14 + 2)], [77, 10]);
  // a full Items pocket, a broken bag: nothing written
  const full = sunBag();
  for (let i = 0; i < 430; i++) full.poke(base + i * 4, g7(80 + (i % 100), 1));
  assert.deepEqual(addMaxRepels(sm, full, {}), { error: 'full' });
  const broken = sunBag();
  broken.poke(base + 0xb48, g7(4, 5)); // a Poké Ball in Medicine
  assert.deepEqual(addMaxRepels(sm, broken, {}), { error: 'notFound', why: 'missing', tried: [{ at: '0x330D5934', why: 'slot medicine#0 0x00001404' }] });
  assert.equal(full.writes + broken.writes, 0);
  // the Items pocket takes no Medicine or TM item: those stay where they belong
  assert.deepEqual(addItem(sm, sunBag(), {}, 50, 1, { pocket: 'items' }), { error: 'unsupported' });
  assert.deepEqual(addItem(sm, sunBag(), {}, 328, 1, { pocket: 'items' }), { error: 'unsupported' });
});

test('Max Repels: the 3DS player answers later, a refused write is no success', async () => {
  const m = sunBag();
  const later = { read: m.read, write: (a, b) => new Promise((r) => setTimeout(() => r(m.write(a, b)), 5)) };
  const p = applyCheat('maxRepel', ctr(SM), later, {});
  assert.equal(typeof p.then, 'function');
  assert.deepEqual(await p, { ok: true, before: 0, after: 10, added: 10 });
  assert.deepEqual(await applyCheat('maxRepel', ctr(SM), { read: m.read, write: () => Promise.resolve({ ok: false, why: 'changed' }) }, {}), { error: 'changed' });
  const r = memory();
  r.poke(0xd31d, [0, 0xff]);
  r.poke(0xd347, [0, 0, 0]);
  assert.deepEqual(addMaxRepels(entry({ platform: 'gb', title: 'POKEMON RED' }), { read: r.read, write: () => false }, {}), { error: 'write' });
});

// ---- run side -----------------------------------------------------------------------------------------------

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const PAIR = { ...HG, players: { p1: { name: 'Tim' }, p2: { name: 'Robin' } } };
const SOLO = { ...HG, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}

test('cheats are off by default; allowed, every use lands in the shared log', () => {
  assert.equal(R.rules(mkDoc(), PAIR).cheats, false);
  assert.equal(R.rules(mkDoc(), SOLO).cheats, false);
  assert.equal(R.presetOf({ ...R.rules(mkDoc(), SOLO), cheats: true }), 'classic', 'allowing cheats is no rule set of its own');
  const off = mkDoc();
  assert.equal(R.logCheat(off, PAIR, 'p1', { added: 99 }), false);
  assert.equal(R.feedList(off).length, 0);

  const d = mkDoc({ cheats: true });
  assert.equal(R.logCheat(d, PAIR, 'p1', { added: 99 }), true);
  const [f] = R.feedList(d);
  assert.deepEqual([f.type, f.slot, f.cheat, f.count, f.text], ['cheat', 'p1', 'rareCandy', 99, 'used a cheat: 99 Rare Candies']);
  // rendered from the message on every computer (the partner's language), the name in front comes from the log view
  assert.equal(R.feedText(d, PAIR, f), 'used a cheat: 99 Rare Candies');
  const s = mkDoc({ cheats: true });
  R.logCheat(s, SOLO, 'p1', { added: 1 });
  assert.equal(R.feedList(s)[0].text, 'Cheat used: 1 Rare Candy');
});

test('Max Repels in the log: named for everyone, refused while the rules don’t allow cheats', () => {
  const off = mkDoc();
  assert.equal(R.logCheat(off, PAIR, 'p1', { added: 10, cheat: 'maxRepel' }), false);
  assert.equal(R.feedList(off).length, 0);
  const d = mkDoc({ cheats: true });
  assert.equal(R.logCheat(d, PAIR, 'p2', { added: 10, cheat: 'maxRepel' }), true);
  const [f] = R.feedList(d);
  assert.deepEqual([f.type, f.slot, f.cheat, f.count, f.text], ['cheat', 'p2', 'maxRepel', 10, 'used a cheat: 10 Max Repels']);
  assert.equal(R.feedText(d, PAIR, f), 'used a cheat: 10 Max Repels');
  const s = mkDoc({ cheats: true });
  R.logCheat(s, SOLO, 'p1', { added: 1, cheat: 'maxRepel' });
  assert.equal(R.feedList(s)[0].text, 'Cheat used: 1 Max Repel');
  // a cheat the log doesn't know isn't written as something it isn't
  assert.equal(R.logCheat(s, SOLO, 'p1', { added: 5, cheat: 'infiniteMoney' }), false);
  assert.equal(R.feedList(s).length, 1);
});

test('switching the cheat rule is logged too', () => {
  const d = mkDoc();
  R.logCheatRule(d, PAIR, 'p2', true);
  R.logCheatRule(d, SOLO, 'p1', false);
  assert.deepEqual(R.feedList(d).map((f) => [f.type, f.text]).sort(), [['cheat', 'Cheats turned off for this run'], ['cheat', 'allowed cheats for this run']]);
});

// ---- the fast player: the read-back reads the core, not the player's own copy -----------------------------------

/**
 * The fast player as web/lib/nativeplayer.mjs is: a `core` (what the game holds) and the page's `mirror` of it. A write
 * goes into the mirror at once and to the host, which writes it into the core between two frames – unless `lose` (the
 * game moved its memory just then: the write lands nowhere it reads). The host only sends blocks that changed, so a lost
 * write never comes back into the mirror; fresh() is RESYNC: the whole core into the mirror.
 */
function fastPlayer({ lose = false } = {}) {
  const core = memory();
  const mirror = memory();
  return {
    core,
    mirror,
    read: (a, n) => mirror.read(a, n),
    write: (a, b) => {
      mirror.poke(a, b);
      if (!lose) core.poke(a, b);
      return Promise.resolve(true); // (writeChecked: the host answered "written")
    },
    fresh: async () => {
      for (const [a, n] of [[0xd000, 0x1000]]) mirror.poke(a, core.read(a, n));
      return true;
    },
  };
}

test('the fast player: a cheat counts only once the core holds it – read back after the write, not from the page\'s copy', async () => {
  const e = entry({ platform: 'gb', title: 'POKEMON RED' });
  for (const lose of [false, true]) {
    const p = fastPlayer({ lose });
    for (const m of [p.core, p.mirror]) {
      m.poke(0xd31d, [1, 0x14, 5, 0xff]); // Potion ×5
      m.poke(0xd347, [0x00, 0x30, 0x00]);
    }
    const res = await applyCheat('maxRepel', e, p, {});
    if (!lose) assert.deepEqual(res, { ok: true, before: 0, after: 10, added: 10 });
    else {
      assert.deepEqual(res, { error: 'write' }, 'the game never got it: no "+10 in your bag"');
      assert.equal(p.mirror.read(0xd31d, 1)[0], 1, 'and the page reads the bag as the game has it again');
    }
  }
  // no answer from the host for the whole memory: not claimed either
  const p = fastPlayer();
  p.core.poke(0xd31d, [1, 0x14, 5, 0xff]);
  p.mirror.poke(0xd31d, [1, 0x14, 5, 0xff]);
  assert.deepEqual(await applyCheat('maxRepel', e, { ...p, fresh: async () => false }, {}), { error: 'write', why: 'unverified' });
  // the host refused the write
  assert.deepEqual(await applyCheat('maxRepel', e, { ...p, write: () => Promise.resolve(false) }, {}), { error: 'write' });
});
