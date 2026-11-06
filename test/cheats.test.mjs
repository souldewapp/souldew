// Cheats: Rare Candies written into the bag in RAM (shared/live/cheats.mjs) – synthetic RAM per bag layout, the
// checks that keep it from writing anywhere else, and the run side (rule, log).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry } from '../shared/live/parse.mjs';
import { addRareCandies, cheatSupported, RARE_CANDY } from '../shared/live/cheats.mjs';

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
  assert.deepEqual(RARE_CANDY, { 1: 0x28, 2: 0x20, 3: 68, 4: 50, 5: 50 });
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
