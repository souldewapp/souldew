// What souldew reads from the ROM file itself besides the place names: which Pokémon a GBA game's species numbers
// stand for (shared/live/romspecies.mjs – ROM hacks like Light Platinum put other Pokémon into the slots, expanded
// engines like Run & Bun / Unbound are recognised), whether a ROM is an unmodified retail dump (server/lib/romloc.mjs),
// and which place name the sign and new catches get (shared/live/location.mjs placeName, web/lib/run.mjs).
// Real ROMs – when present – are checked too:
//   SOULDEW_TEST_ROMS=/folder/with/roms node --test test/romdata.test.mjs
// (any .gb/.gbc/.gba/.nds in the folder, retail dumps, hacks and randomized games alike; never commit ROMs). Without
// the variable those tests are skipped. scripts/rom-matrix.mjs runs the whole matrix incl. the built-in emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { gen3SpeciesNames, gen3SpeciesMap, romSpecies, nameKey } from '../shared/live/romspecies.mjs';
import { gen3Names, gen5Messages, gen5PlaceNames, romLocations } from '../shared/live/romloc.mjs';
import { placeName } from '../shared/live/location.mjs';
import { LiveTables, parsePk3, FAKEMON } from '../shared/live/parse.mjs';
import { romData } from '../server/lib/romloc.mjs';

const ROOT = new URL('../', import.meta.url);
const json = (f) => JSON.parse(readFileSync(new URL(`shared/data/${f}`, ROOT), 'utf8'));
const cs3 = json('charset_gen3.json');
const idx3 = json('gen3_index_to_dex.json');
const dexNames = json('pokeapi.json').names.en;
const vanilla3 = [];
for (const [k, v] of Object.entries(idx3.map)) vanilla3[Number(k)] = v;
const SHARED = new URL('shared', ROOT).pathname;

const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};

/** A GBA ROM image with a species-name table at `at` (entry 0 "??????????", then `names`, 11 bytes each). */
function gbaWithNames(names, { at = 0x1000, size = 0x10000, stride = 11 } = {}) {
  const rom = new Uint8Array(size);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'BPEE'].map((c) => c.charCodeAt(0)), 0xac);
  const all = ['??????????', ...names];
  all.forEach((n, i) => {
    const o = at + i * stride;
    rom.fill(0xff, o, o + stride);
    rom.set(enc3(n).slice(0, stride - 1), o);
  });
  return rom;
}

/** The retail order of the first `n` species names (internal index → National Dex → English name, upper case). */
const retailNames = (n) => Array.from({ length: n }, (_, i) => (vanilla3[i + 1] ? dexNames[vanilla3[i + 1]].toUpperCase() : '?'));

test('species names: comparable keys for the odd ones', () => {
  assert.equal(nameKey('Farfetch’d'), nameKey("FARFETCH'D"));
  assert.notEqual(nameKey('Nidoran♀'), nameKey('Nidoran♂'));
  assert.equal(nameKey('Flabébé'), 'FLABEBE');
  assert.equal(nameKey('MR. MIME'), nameKey('Mr. Mime'));
});

test('Gen 3 species table: a retail one maps like the built-in table and changes nothing', () => {
  const rom = gbaWithNames(retailNames(411));
  const t = gen3SpeciesNames(rom, cs3);
  assert.equal(t.offset, 0x1000);
  assert.equal(t.names.length, 412);
  const r = romSpecies(rom, { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  assert.deepEqual([r.engine, r.count, r.changed, r.map], ['vanilla', 411, 0, undefined]);
});

test('Gen 3 species table: a hack\'s other Pokémon are mapped by name, a fakémon is never a real one', () => {
  const names = retailNames(411);
  names[12] = 'Venipede'; // internal 13 = Weedle in the retail games
  names[251] = 'Turtwig'; // internal 252 = an unused "?" slot
  names[287] = 'Croagunk'; // internal 288 = Zigzagoon
  names[300] = 'Flufftail'; // no such Pokémon
  const r = romSpecies(gbaWithNames(names), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  assert.equal(r.engine, 'vanilla');
  assert.deepEqual([r.map[13], r.map[252], r.map[288], r.map[1], r.map[277]], [543, 387, 453, 1, 252]);
  assert.equal(r.map[301], 0);
  assert.deepEqual(r.unknown, { 301: 'Flufftail' });
  assert.equal(r.changed, 4);
  // the live reader uses it: the struct says internal 13, the game shows a Venipede
  const T = new LiveTables({ charsetGen3: cs3, gen3Index: idx3 });
  assert.equal(T.withSpecies(null), T, 'nothing changed → the same tables');
  const TT = T.withSpecies(r);
  assert.equal(parsePk3(pk3({ internal: 13 }), T).species, 13, 'the retail table says Weedle');
  assert.equal(parsePk3(pk3({ internal: 13 }), TT).species, 543);
  assert.equal(parsePk3(pk3({ internal: 252 }), TT).species, 387, 'an unused slot of the retail game');
  assert.equal(parsePk3(pk3({ internal: 301 }), TT).species, FAKEMON + 301, 'a fakémon gets a number of its own');
  assert.equal(parsePk3(pk3({ internal: 252 }), T), null, 'without the ROM\'s table the slot is no Pokémon at all');
});

test('Gen 3 species table: an expanded engine (hundreds more species) is recognised, not mapped', () => {
  const names = retailNames(411);
  for (let i = 0; i < 600; i++) names.push(`Mon${String.fromCharCode(65 + (i % 26))}x`);
  const r = romSpecies(gbaWithNames(names, { size: 0x20000 }), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  assert.equal(r.engine, 'expanded');
  assert.equal(r.map, undefined);
  assert.equal(romSpecies(new Uint8Array(0x10000), { gen3Charset: cs3 }), null, 'no table, no guess');
  assert.equal(romSpecies(Uint8Array.from({ length: 0x400 }, () => 0x55), {}), null, 'not a GBA ROM');
});

test('gen3SpeciesMap: the vanilla Pokémon of a slot wins over a same-named later one', () => {
  const m = gen3SpeciesMap(['', 'BULBASAUR', 'IVYSAUR'], [0, 1, 2], dexNames);
  assert.deepEqual(m, { map: [0, 1, 2], unknown: {}, changed: 0 });
});

function pk3({ pid = 0x01020304, otId = 0x0a0b0c0d, internal, level = 5, hp = 20, maxHp = 20 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, internal, true);
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + pv.getUint16(i, true)) & 0xffff;
  dv.setUint16(28, sum, true);
  const key = (pid ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (pv.getUint32(i, true) ^ key) >>> 0, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

test('Gen 3 region map: an empty name in the middle (Emerald MAPSEC_DYNAMIC) doesn\'t cut the table; team placeholders', () => {
  const build = (code) => {
    const rom = new Uint8Array(0x4000);
    rom[0xb2] = 0x96;
    rom.set([...code].map((c) => c.charCodeAt(0)), 0xac);
    let str = 0x2000;
    for (let i = 0; i < 120; i++) {
      const o = 0x400 + i * 8;
      rom.set([i % 28, i % 20, 1, 1], o);
      put32(rom, o + 4, 0x08000000 + str);
      // section 70: "{AQUA} HIDEOUT", section 87: empty, everything after it a Kanto name
      const bytes = i === 87 ? [0xff] : i === 70 ? [0xfd, 0x08, 0x00, ...enc3('HIDEOUT'), 0xff] : [...enc3(i === 0 ? 'LITTLEROOT TOWN' : i > 87 ? `KANTO ${i}` : `ROUTE ${100 + i}`), 0xff];
      rom.set(bytes, str);
      str += bytes.length;
    }
    return gen3Names(rom, cs3);
  };
  const g = build('BPEE');
  assert.equal(g.offset, 0x400, 'the table starts at section 0');
  assert.equal(g.names.length, 120);
  assert.deepEqual([g.names[0], g.names[87], g.names[88], g.names[70]], ['Littleroot Town', '', 'Kanto 88', 'Aqua Hideout']);
  assert.equal(build('AXVE').names[70], 'Magma Hideout', 'Ruby\'s villains are Team Magma');
});

test('Gen 5 place names: a hack\'s padding of empty entries is no reason to give up', () => {
  const f = gen5File(['', 'Mystery Zone', 'Nuvema Town', '', '', '']);
  assert.deepEqual(gen5Messages(f), ['', 'Mystery Zone', 'Nuvema Town', '', '', '']);
  assert.deepEqual(gen5PlaceNames(f), ['', 'Mystery Zone', 'Nuvema Town'], 'the padding goes, the empty first entry stays');
});

/** Builds a Gen 5 message file (one section; as in test/romloc.test.mjs). */
function gen5File(strings) {
  const encd = strings.map((s) => [...[...s].map((c) => c.charCodeAt(0)), 0xffff]);
  const secOff = 16;
  const table = 4 + strings.length * 8;
  const size = secOff + table + encd.reduce((n, e) => n + e.length * 2, 0);
  const b = new Uint8Array(size);
  const p16 = (o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
  p16(0, 1);
  p16(2, strings.length);
  put32(b, 12, secOff);
  put32(b, secOff, size - secOff);
  let off = table;
  encd.forEach((e, i) => {
    put32(b, secOff + 4 + i * 8, off);
    p16(secOff + 8 + i * 8, e.length);
    let k = 0x7a3c;
    for (let j = e.length - 1; j >= 0; j--) {
      p16(secOff + off + j * 2, e[j] ^ k);
      k = ((k >> 3) | (k << 13)) & 0xffff;
    }
    off += e.length * 2;
  });
  return b;
}

test('placeName: a modified ROM shows its own names, a retail one the app\'s translation when the languages differ', () => {
  const r = { gen: 3, id: 0, romName: 'Yellow Town' };
  const hack = { gen: 3, lang: 'en', vanilla: false };
  const retail = { gen: 3, lang: 'en', vanilla: true };
  assert.equal(placeName(r, { rom: hack, table: 'Wurzelheim', lang: 'de' }), 'Yellow Town', 'Light Platinum in a German app: its own region');
  assert.equal(placeName({ ...r, romName: 'Littleroot Town' }, { rom: retail, table: 'Wurzelheim', lang: 'de' }), 'Wurzelheim');
  assert.equal(placeName({ ...r, romName: 'Littleroot Town' }, { rom: retail, table: 'Littleroot Town', lang: 'en' }), 'Littleroot Town');
  assert.equal(placeName({ ...r, romName: 'Hack Cave' }, { rom: retail, table: '', lang: 'de' }), 'Hack Cave', 'a place the tables don\'t know');
  assert.equal(placeName({ ...r, romName: null }, { rom: hack, table: 'Wurzelheim', lang: 'de' }), 'Wurzelheim', 'no ROM name: the table');
  assert.equal(placeName({ ...r, romName: 'Littleroot Town' }, { rom: { gen: 3, lang: 'en' }, table: 'Wurzelheim', lang: 'de' }), 'Wurzelheim', 'unknown vanilla state: as before');
  assert.equal(placeName(null), '');
});

test('catches are named like the sign: Gen 5 gets the ROM\'s names, a hack its own', async () => {
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx)) });
  const R = await import('../web/lib/run.mjs');
  await R.loadLocationTables().catch(() => {});
  assert.equal(R.locationName(5, 6), '#6', 'no ROM data: Gen 5 has no table');
  R.setRomPlaces({ gen: 5, lang: 'en', vanilla: true, names: ['', 'Mystery Zone', 'Faraway place', '', 'Nuvema Town', 'Accumula Town', 'Striaton City'] });
  assert.equal(R.locationName(5, 6), 'Striaton City');
  R.setRomPlaces({ gen: 4, lang: 'en', vanilla: false, names: ['Mystery Zone', 'Hack Town'] });
  assert.equal(R.locationName(4, 1), 'Hack Town', 'a modified ROM: its own name, not the table\'s');
  assert.equal(R.locationName(5, 6), '#6', 'names of another generation don\'t apply');
  R.setRomPlaces(null);
});

// ---------------------------------------------------------------- real ROMs (optional)

const DIR = process.env.SOULDEW_TEST_ROMS;
const files = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.(gba|nds)$/i.test(f)).map((f) => join(DIR, f)) : [];

test('real ROMs: retail dumps are vanilla with the retail species; hacks are told apart', { skip: files.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f));
    const r = romData(bytes, SHARED);
    const gba = bytes[0xb2] === 0x96;
    if (gba) assert.ok(r.species, `${f}: a species table`);
    if (r.vanilla) {
      if (gba) assert.deepEqual([r.species.engine, r.species.changed], ['vanilla', 0], `${f}: a retail game has the retail species`);
      if (r.data?.gen === 3 && r.data.family === 'rse' && r.data.lang === 'en') assert.equal(r.data.names[0], 'Littleroot Town', f);
      continue;
    }
    // a modified ROM: whatever it is, the place data (when there is some) must come from the ROM's own tables
    if (r.data) assert.equal(r.data.vanilla, false, f);
    if (gba && r.species.engine === 'vanilla' && r.species.changed) {
      for (const [i, n] of Object.entries(r.species.unknown || {})) assert.ok(!dexNames.some((d) => d && nameKey(d) === nameKey(n)), `${f}: ${i} ${n} is a real Pokémon`);
      assert.ok(r.species.map.every((v) => v >= 0 && v <= 1025), f);
    }
  }
});

test('real ROMs: romLocations never throws and finds data for every Gen 3–5 retail dump', { skip: files.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(f));
    const r = romData(bytes, SHARED);
    if (!r.vanilla) continue;
    const frlg = /^BP[RG]/.test(String.fromCharCode(...bytes.subarray(0xac, 0xb0)));
    if (!frlg) assert.ok(romLocations(bytes, { gen3Charset: cs3, gen4Chars: json('gen4.json').chars }), `${f}: location data`);
  }
});
