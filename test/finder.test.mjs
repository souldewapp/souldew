// Pokémon Finder: the wild encounter reader (shared/live/romwild.mjs) on a synthetic Gen 3 ROM, the lookups over its
// result (shared/finder.mjs) and – with SOULDEW_TEST_ROMS=/folder/with/roms – the real Ruby, Sapphire, FireRed and
// Emerald dumps. No ROM is in the repository; the synthetic one is built here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gen3Wild, SLOTS } from '../shared/live/romwild.mjs';
import { romSpecies, gen3SpeciesNames } from '../shared/live/romspecies.mjs';
import { romLocations } from '../shared/live/romloc.mjs';
import { CHANCES, METHODS, methodSlots, methodRate, mergeSlots, wildMons, whereIs, areaGroups, areaLabel } from '../shared/finder.mjs';

const BASE = 0x08000000;
const put32 = (b, o, v) => new DataView(b.buffer).setUint32(o, v, true);
const put16 = (b, o, v) => new DataView(b.buffer).setUint16(o, v, true);

/**
 * A GBA ROM with a map header table (20 groups of 3 maps, section = 10 + the map's index) and a wild encounter table for
 * the first `maps` of them. `tables(group, num)` → { land, surf, rock, fish } (each: { rate, slots: [[min, max, species]…] }
 * or undefined); `extra` = more headers appended behind them (a second table of a map: a variant).
 */
function build({ maps = 45, tables, extra = [], terminator = true } = {}) {
  const b = new Uint8Array(0x20000);
  b[3] = 0xea;
  b[0xb2] = 0x96;
  // map headers: 60 × 0x1c at 0x1000; the arrays of pointers per group at 0x2000; the group table at 0x2400
  const hdr = (i) => 0x1000 + i * 0x1c;
  for (let i = 0; i < 60; i++) {
    put32(b, hdr(i), BASE + 0x100); // layout
    put32(b, hdr(i) + 4, BASE + 0x100 + i * 4); // events
    put32(b, hdr(i) + 8, BASE + 0x110); // scripts
    b[hdr(i) + 0x14] = 10 + i;
  }
  for (let g = 0; g < 20; g++) {
    for (let n = 0; n < 3; n++) put32(b, 0x2000 + (g * 3 + n) * 4, BASE + hdr(g * 3 + n));
    put32(b, 0x2400 + g * 4, BASE + 0x2000 + g * 12);
  }
  // wild table: headers at 0x4000, info structs and slot arrays after them
  let at = 0x8000;
  const slots = (list) => {
    const o = at;
    for (const [min, max, sp] of list) {
      b[at] = min;
      b[at + 1] = max;
      put16(b, at + 2, sp);
      at += 4;
    }
    return o;
  };
  const info = (x) => {
    if (!x) return 0;
    const s = slots(x.slots);
    const o = at;
    b[o] = x.rate;
    put32(b, o + 4, BASE + s);
    at += 8;
    return BASE + o;
  };
  const list = [];
  for (let i = 0; i < maps; i++) list.push([Math.floor(i / 3), i % 3, tables(Math.floor(i / 3), i % 3)]);
  for (const [g, n, t] of extra) list.push([g, n, t]);
  list.forEach(([g, n, t], i) => {
    const o = 0x4000 + i * 20;
    b[o] = g;
    b[o + 1] = n;
    put32(b, o + 4, info(t.land));
    put32(b, o + 8, info(t.surf));
    put32(b, o + 12, info(t.rock));
    put32(b, o + 16, info(t.fish));
  });
  if (terminator) {
    const o = 0x4000 + list.length * 20;
    b[o] = 0xff;
    b[o + 1] = 0xff;
  }
  return b;
}

const fill = (n, sp, min = 3, max = 5) => Array.from({ length: n }, () => [min, max, sp]);
const std = (g, n) => ({
  land: { rate: 20, slots: [...fill(10, 16 + g), [2, 6, 100 + n], [2, 6, 100 + n]] },
  surf: n === 1 ? { rate: 4, slots: fill(5, 72, 5, 35) } : undefined,
  fish: n === 2 ? { rate: 30, slots: [...fill(2, 129, 5, 10), ...fill(3, 118, 10, 30), ...fill(5, 130, 20, 45)] } : undefined,
});
const opts = { speciesCount: 411, names: Array.from({ length: 80 }, (_, i) => (i < 10 ? '' : `Place ${i}`)), toDex: (i) => (i === 300 ? 0 : i), speciesNames: (i) => `MON${i}` };

test('the encounter tables of a ROM are found by their shape and named by map', () => {
  const w = gen3Wild(build({ tables: std }), opts);
  assert.equal(w.offset, 0x4000);
  assert.equal(w.areas.length, 45);
  const a = w.areas[4]; // map 1.1
  assert.deepEqual([a.group, a.num, a.sec, a.name], [1, 1, 14, 'Place 14']);
  assert.deepEqual(a.rates, { land: 20, surf: 4 });
  assert.equal(a.slots.land.length, SLOTS.land);
  assert.equal(a.slots.surf.length, SLOTS.surf);
  assert.deepEqual(a.slots.land[0], [3, 5, 17, 17]);
  assert.equal(a.slots.fish, undefined, 'no fishing table: none');
  assert.deepEqual(w.areas[2].slots.fish.length, SLOTS.fish);
  assert.equal(w.names[17], 'MON17', 'the ROM’s own name of each Pokémon used');
});

test('a hack’s own Pokémon (no Dex number) keep their internal index', () => {
  const w = gen3Wild(build({ tables: (g, n) => ({ land: { rate: 10, slots: fill(12, 300) } }) }), opts);
  assert.deepEqual(w.areas[0].slots.land[0], [3, 5, 0, 300]);
  assert.equal(w.names[300], 'MON300');
});

test('nothing is returned where the table can’t be trusted', () => {
  assert.equal(gen3Wild(build({ tables: std }), { ...opts, speciesCount: 0 }), null, 'no species table: no way to tell the numbers');
  assert.equal(gen3Wild(build({ tables: std, terminator: false }), opts), null, 'a run of headers without its end');
  assert.equal(gen3Wild(build({ tables: std, maps: 30 }), opts), null, 'too short to be the game’s table');
  assert.equal(gen3Wild(build({ tables: std }), { ...opts, speciesCount: 20 }), null, 'slots with Pokémon the game doesn’t have');
  assert.equal(gen3Wild(build({ tables: (g, n) => (n === 1 && g === 7 ? { land: { rate: 20, slots: fill(12, 5, 9, 3) } } : std(g, n)) }), opts), null, 'a minimum level above the maximum breaks the run');
  assert.equal(gen3Wild(new Uint8Array(0x20000), opts), null, 'zeros');
  assert.equal(gen3Wild(new Uint8Array(0x100), opts), null, 'not a ROM');
  const notGba = build({ tables: std });
  notGba[0xb2] = 0;
  assert.equal(gen3Wild(notGba, opts), null, 'not a GBA Pokémon ROM');
  const noise = new Uint8Array(0x40000);
  let x = 12345;
  for (let i = 0; i < noise.length; i++) noise[i] = (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 16;
  noise[3] = 0xea;
  noise[0xb2] = 0x96;
  assert.equal(gen3Wild(noise, opts), null, 'noise');
});

test('a map with several tables (Altering Cave, Safari Zone) lists them as variants; a header without tables is fine', () => {
  const w = gen3Wild(build({
    tables: (g, n) => (g === 3 && n === 0 ? {} : std(g, n)),
    extra: [[5, 0, std(5, 0)], [5, 0, std(6, 0)]].map(([g, n, t]) => [g, n, t]),
  }), opts);
  assert.equal(w.areas.length, 47);
  assert.deepEqual(w.areas[9].slots, {}, 'a map with a header and no table');
  const v = w.areas.filter((a) => a.group === 5 && a.num === 0);
  assert.deepEqual(v.map((a) => [a.variant, a.variants]), [[1, 3], [2, 3], [3, 3]]);
  assert.equal(w.areas[0].variant, undefined);
});

test('slot chances: the retail games’ numbers, and every table adds up to 100', () => {
  for (const [m, list] of Object.entries(CHANCES)) assert.equal(list.reduce((a, b) => a + b, 0), 100, m);
  assert.equal(CHANCES.land.length, SLOTS.land);
  assert.equal(CHANCES.surf.length, SLOTS.surf);
    assert.equal(CHANCES.old.length + CHANCES.good.length + CHANCES.super.length, SLOTS.fish, 'the three rods use 2 + 3 + 5 of the 10 slots');
});

test('a table’s slots by method, with the rods split and a Pokémon in several slots merged', () => {
  const w = gen3Wild(build({ tables: std }), opts);
  const fish = w.areas[2]; // 0.2
  const ms = methodSlots(fish);
  assert.deepEqual(Object.keys(ms), ['land', 'old', 'good', 'super']);
  assert.deepEqual(ms.old.map((x) => [x.s, x.pct]), [[129, 70], [129, 30]]);
  assert.deepEqual(mergeSlots(ms.old).map((x) => [x.s, x.pct, x.min, x.max]), [[129, 100, 5, 10]]);
  assert.deepEqual(ms.good.map((x) => x.pct), [60, 20, 20]);
  assert.deepEqual(ms.super.map((x) => x.pct), [40, 40, 15, 4, 1]);
  assert.equal(methodRate(fish, 'super'), 30);
  assert.equal(methodRate(fish, 'land'), 20);
  assert.equal(methodRate(fish, 'surf'), null);
  const land = mergeSlots(methodSlots(w.areas[0]).land);
  assert.equal(land.reduce((a, x) => a + x.pct, 0), 100);
  assert.deepEqual(land.find((x) => x.s === 16), { min: 3, max: 5, s: 16, i: 16, pct: 98 });
});

test('where a Pokémon lives, which Pokémon an area has', () => {
  const w = gen3Wild(build({ tables: std }), opts);
  assert.equal(wildMons(w).has(16), true);
  assert.equal(wildMons(w).has('i300'), false);
  const rows = whereIs(w, 129);
  assert.deepEqual(rows.map((r) => [areaLabel(r.area), r.method, r.pct]), Array.from({ length: 15 }, (_, g) => [`Place ${10 + g * 3 + 2}`, 'old', 100]).concat([]).slice(0, 0).concat(
    Array.from({ length: 15 }, (_, g) => [`Place ${10 + g * 3 + 2}`, 'old', 100]),
  ));
  assert.deepEqual(whereIs(w, 118).map((r) => r.method), Array(15).fill('good'));
  assert.deepEqual(whereIs(w, 77), [], 'a Pokémon the game never has in the wild');
  const groups = areaGroups(w);
  assert.equal(groups.length, 45);
  assert.deepEqual(areaGroups(w, 'place 1').map((g) => g.name).slice(0, 3), ['Place 10', 'Place 11', 'Place 12']);
  assert.deepEqual(areaGroups(w, 'zzz'), []);
  assert.deepEqual(METHODS, ['land', 'surf', 'rock', 'old', 'good', 'super']);
});

test('areas that share a name are grouped, unnamed ones go by their map number', () => {
  const w = gen3Wild(build({ tables: std }), { ...opts, names: Array.from({ length: 80 }, () => 'Cave') });
  const g = areaGroups(w);
  assert.equal(g.length, 1);
  assert.equal(g[0].areas.length, 45);
  const unnamed = gen3Wild(build({ tables: std }), { ...opts, names: [] });
  assert.equal(areaLabel(unnamed.areas[4]), '1.1');
});

// ---- real ROMs ----------------------------------------------------------------------

const DIR = process.env.SOULDEW_TEST_ROMS;
const files = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.gba$/i.test(f)).map((f) => join(DIR, f)) : [];
const data = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));

test('real ROMs: Ruby, Sapphire, FireRed and Emerald (any of them in the folder) are read; the known places agree', { skip: files.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  const charset = data('charset_gen3.json');
  const api = data('pokeapi.json');
  const index = [];
  for (const [k, v] of Object.entries(data('gen3_index_to_dex.json').map)) index[Number(k)] = v;
  const o = { gen3Charset: charset, gen3Index: index, dexNames: api.names.en, dexNamesOther: ['de', 'fr', 'es', 'it'].map((l) => api.names[l]) };
  let checked = 0;
  for (const f of files) {
    const rom = new Uint8Array(readFileSync(f));
    const code = String.fromCharCode(...rom.subarray(0xac, 0xb0));
    if (!/^(AXV|AXP|BPE|BPR)E$/.test(code)) continue; // the USA games
    const loc = romLocations(rom, o);
    const sp = romSpecies(rom, o);
    const names = gen3SpeciesNames(rom, charset).names;
    const w = gen3Wild(rom, { speciesCount: sp.count, names: loc.names, toDex: (i) => (sp.map ? sp.map[i] : index[i]) || 0, speciesNames: (i) => names[i] });
    assert.ok(w, `${f}: encounter tables found`);
    assert.ok(w.areas.length >= 90, `${f}: ${w.areas.length} areas`);
    assert.equal(w.areas.filter((a) => !a.name).length, 0, `${f}: every area has a place name`);
    const find = (name, i = 0) => w.areas.filter((a) => a.name?.toLowerCase() === name.toLowerCase())[i];
    const dex = (a, m) => mergeSlots(methodSlots(a)[m]).map((x) => [api.names.en[x.s], x.min, x.max, x.pct]);
    if (code === 'BPEE') {
      // Route 102 in Emerald (Bulbapedia / pokeemerald wild_encounters.h): Poochyena 30, Wurmple 30, Lotad 20, Zigzagoon 15, Ralts 4, Seedot 1
      assert.deepEqual(dex(find('ROUTE 102'), 'land'), [['Poochyena', 3, 4, 30], ['Wurmple', 3, 4, 30], ['Lotad', 3, 4, 20], ['Zigzagoon', 3, 4, 15], ['Ralts', 4, 4, 4], ['Seedot', 3, 3, 1]]);
      assert.equal(w.areas.length, 124);
    }
    if (code === 'BPRE') {
      assert.deepEqual(dex(find('ROUTE 1'), 'land'), [['Pidgey', 2, 5, 50], ['Rattata', 2, 4, 50]]);
      assert.equal(w.areas.length, 132);
    }
    if (code === 'AXVE' || code === 'AXPE') {
      assert.deepEqual(dex(find('ROUTE 101'), 'land'), [['Wurmple', 2, 3, 45], ['Zigzagoon', 2, 3, 45], ['Poochyena', 2, 3, 10]]);
    }
    checked++;
  }
  assert.ok(checked > 0, 'a USA Gen 3 game was checked');
});
