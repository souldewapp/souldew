// Cheats: Rare Candies written into the bag in RAM (shared/live/cheats.mjs) – synthetic RAM per bag layout, the
// checks that keep it from writing anywhere else, and the run side (rule, log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry } from '../shared/live/parse.mjs';
import { addRareCandies, addItem, cheatSupported, cheatRegions, ctrNoBalls, RARE_CANDY, POKE_BALL } from '../shared/live/cheats.mjs';

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
});

test('which games can get Rare Candies', () => {
  for (const h of [{ platform: 'gb', title: 'POKEMON RED' }, { platform: 'gb', title: 'POKEMON YELLOW' }, { platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' },
    { platform: 'gbc', title: 'POKEMON_SLV', code: 'AAXE' }, { platform: 'gba', code: 'AXVD' }, { platform: 'gba', code: 'BPEE' }, { platform: 'gba', code: 'BPGE' },
    { platform: 'nds', code: 'IPGE' }, { platform: 'nds', code: 'IPKD' }, { platform: 'nds', code: 'CPUE' }, { platform: 'nds', code: 'APAE' },
    { platform: 'nds', code: 'IRBO' }, { platform: 'nds', code: 'IRDO' }]) {
    assert.ok(cheatSupported(entry(h)), JSON.stringify(h));
  }
  // no addresses for German Emerald / FireRed – the cheat isn't offered there
  assert.equal(cheatSupported(entry({ platform: 'gba', code: 'BPED' })), false);
  assert.equal(cheatSupported(null), false);
  assert.deepEqual(addRareCandies(null, memory(), {}), { error: 'unsupported' });
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
  // Medicine items only: nothing lands in the wrong pocket
  assert.deepEqual(addItem(ctr(SM), sunBag(), {}, 4, 5), { error: 'unsupported' });
  assert.equal(POKE_BALL[7], undefined);
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
    assert.deepEqual(addRareCandies(e, m, {}), { error: 'notFound' }, why);
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
  assert.deepEqual(addRareCandies(ctr(USUM), sm, {}), { error: 'notFound' });
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
  assert.deepEqual(addRareCandies(oras, m3, {}), { error: 'notFound' });
  assert.equal(m3.writes, 0);
});

test('3DS: no ball in the bag, so Birch rescue and the fights before the first Poké Balls cannot be catches', () => {
  const oras = ctr(ORAS);
  const b10 = 0x08c6ac80; // update 1.0 (the one a real Alpha Sapphire 1.0 game was read at: a single Potion in Medicine)
  const m = memory();
  m.poke(b10 + 0x970, slot(17, 1)); // Potion
  assert.equal(ctrNoBalls(oras, m.read, { g67: 1 }), true, 'a bag without a ball');
  assert.equal(ctrNoBalls(oras, m.read, {}), true, 'also when the update is not known yet');
  m.poke(b10, slot(4, 5)); // 5 Poké Balls in the Items pocket
  assert.equal(ctrNoBalls(oras, m.read, { g67: 1 }), false);
  const safari = memory();
  safari.poke(b10 + 0x970, slot(17, 1));
  safari.poke(b10, slot(5, 30)); // Safari Balls cannot be thrown in a normal wild battle
  assert.equal(ctrNoBalls(oras, safari.read, { g67: 1 }), true);
  const dream = memory();
  dream.poke(b10 + 0x970, slot(17, 1));
  dream.poke(b10, slot(576, 1));
  assert.equal(ctrNoBalls(oras, dream.read, { g67: 1 }), false, 'a Dream Ball is a ball');
  // unknown, never "no balls": nothing in memory, a Potion in the TM pocket (no bag), another game
  assert.equal(ctrNoBalls(oras, memory().read, { g67: 1 }), null);
  const junk = memory();
  junk.poke(b10, slot(4, 1));
  junk.poke(b10 + 0x7c0, slot(17, 1));
  assert.equal(ctrNoBalls(oras, junk.read, { g67: 1 }), null);
  assert.equal(ctrNoBalls(entry({ platform: 'gba', code: 'BPEE' }), m.read, {}), null);
  // Sun / Moon: one u32 per slot
  const sm = memory();
  sm.poke(0x330d5934 + 0xb48, [17, 0, 0, 0x4]); // a Potion (Medicine) – the slot format of Gen 7 differs, only used so the bag reads as one
  assert.ok([true, null].includes(ctrNoBalls(ctr(SM), sm.read, {})));
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

test('switching the cheat rule is logged too', () => {
  const d = mkDoc();
  R.logCheatRule(d, PAIR, 'p2', true);
  R.logCheatRule(d, SOLO, 'p1', false);
  assert.deepEqual(R.feedList(d).map((f) => [f.type, f.text]).sort(), [['cheat', 'Cheats turned off for this run'], ['cheat', 'allowed cheats for this run']]);
});
