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
import { gen3SpeciesNames, gen3SpeciesMap, romSpecies, nameKey, speciesCeiling } from '../shared/live/romspecies.mjs';
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

test('Gen 3 species table: an expanded engine (hundreds more species) is recognised and mapped by name', () => {
  const names = retailNames(411);
  for (let i = 0; i < 600; i++) names.push(`Mon${String.fromCharCode(65 + (i % 26))}x`);
  const r = romSpecies(gbaWithNames(names, { size: 0x20000 }), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  assert.equal(r.engine, 'expanded');
  assert.equal(r.map[1], 1, 'Bulbasaur by its name');
  assert.equal(r.map[277], 252, 'by name, not by the retail numbering');
  assert.equal(r.unknown[412], 'MonAx');
  assert.equal(romSpecies(new Uint8Array(0x10000), { gen3Charset: cs3 }), null, 'no table, no guess');
  assert.equal(romSpecies(Uint8Array.from({ length: 0x400 }, () => 0x55), {}), null, 'not a GBA ROM');
});

test('gen3SpeciesMap: the vanilla Pokémon of a slot wins over a same-named later one', () => {
  const m = gen3SpeciesMap(['', 'BULBASAUR', 'IVYSAUR'], [0, 1, 2], dexNames);
  assert.deepEqual(m, { map: [0, 1, 2], unknown: {}, changed: 0 });
});

test('gen3SpeciesMap: a name the game shortened to its 10 letters is still that Pokémon (Run & Bun), a made-up one stays unknown', () => {
  const names = ['', 'Corvknight', 'Flechinder', 'Crabminabl', 'Polteageis', 'Basclegion', 'Goombario', 'Koopatroop'];
  const m = gen3SpeciesMap(names, [], dexNames);
  assert.deepEqual(m.map.slice(1, 6), [823, 662, 740, 855, 902]);
  assert.deepEqual(m.unknown, { 6: 'Goombario', 7: 'Koopatroop' });
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

test('the species picker offers every Pokémon a hack holds: speciesCeiling = the highest National Dex number in its table', () => {
  assert.equal(speciesCeiling(null), null);
  assert.equal(speciesCeiling({ engine: 'vanilla', changed: 0 }), null, 'a retail table adds nothing');
  // Light Platinum (Ruby): Gen 4/5 Pokémon in the slots
  assert.equal(speciesCeiling({ engine: 'vanilla', map: [0, 1, 543, 387, 0] }), 543);
  // Run & Bun: National Dex order up to the newest generation
  assert.equal(speciesCeiling({ engine: 'expanded', map: Object.assign([0], { 390: 390, 905: 905, 1100: 263 }) }), 905);
  assert.equal(speciesCeiling({ engine: 'expanded', map: [0, 0, 0], unknown: { 1: 'Goomba', 2: 'Koopa' } }), null, 'only its own creatures: nothing past the base game');
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
      assert.equal(r.types, null, `${f}: a retail game's types are the app's own`);
      if (gba) assert.deepEqual([r.species.engine, r.species.changed], ['vanilla', 0], `${f}: a retail game has the retail species`);
      if (r.data?.gen === 3 && r.data.family === 'rse' && r.data.lang === 'en') assert.equal(r.data.names[0], 'Littleroot Town', f);
      continue;
    }
    // a modified ROM: whatever it is, the place data (when there is some) must come from the ROM's own tables
    if (r.data) assert.equal(r.data.vanilla, false, f);
    // Run & Bun: the Sinnoh starters (and everything up to the newest generation) can be picked by hand
    if (gba && r.species.engine === 'expanded') assert.ok(speciesCeiling(r.species) >= 905 && r.species.map.includes(390), `${f}: Chimchar and Gen 8 in the picker`);
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

test('Game Boy hacks: moved RAM variables are found from the code\'s references, the retail game stays as it is', async () => {
  const { gbWramShift, shiftEntry, wramRefs } = await import('../shared/live/romwram.mjs');
  const addresses = json('addresses.json');
  const maps = json('maps.json');
  const entry = addresses.games.find((g) => g.id === 'crystal_us');
  const mapEntry = maps.games.crystal_us;
  /** A ROM whose code names each address `n` times (ld a,[nn]). */
  const rom = (refs) => {
    const b = new Uint8Array(0x8000);
    let o = 0x150;
    for (const [addr, n] of refs) for (let i = 0; i < n; i++, o += 3) b.set([0xfa, addr & 0xff, addr >> 8], o);
    return b;
  };
  const retail = rom([[0xdcd7, 190], [0xd22d, 70], [0xdcb5, 46], [0xc62c, 12], [0xd213, 18]]);
  assert.equal(wramRefs(retail)[0xdcd7 - 0xc000], 190);
  assert.equal(gbWramShift(retail, entry, mapEntry), null, 'the retail addresses');
  // Crystal Legacy: WRAMX 11 bytes on, WRAM0 (the battle mon) where it was; a busy neighbour must not hold an address back
  const legacy = rom([[0xdce2, 191], [0xd238, 73], [0xdcc0, 49], [0xc62c, 12], [0xd213, 39], [0xd21e, 18]]);
  const s = gbWramShift(legacy, entry, mapEntry);
  assert.equal(s.delta, 11);
  assert.equal(s.moved['0xDCD7'], '0xDCE2');
  assert.equal(s.moved['0xD213'], '0xD21E', 'the enemy level follows its bank');
  assert.equal(s.moved['0xC62C'], undefined, 'WRAM0 stays: no evidence it moved');
  const e = shiftEntry(entry, s);
  assert.deepEqual([e.partyCountAddr, e.nicknamesAddr, e.inBattle.addr, e.battleEnemy.levelAddr, e.liveBattleHp.speciesAddr], ['0xDCE2', '0xDE4C', '0xD238', '0xD21E', '0xC62C']);
  assert.equal(shiftEntry(mapEntry, s).mapGroupAddr, '0xDCC0');
  assert.equal(entry.partyCountAddr, '0xDCD7', 'the table itself is untouched');
  // one busy address near an anchor isn't a shift: every anchor has to agree
  assert.equal(gbWramShift(rom([[0xdcd7, 5], [0xd22d, 5], [0xdcb5, 5], [0xd270, 300]]), entry, mapEntry), null);
  assert.equal(gbWramShift(retail, addresses.games.find((g) => g.id === 'emerald_us')), null, 'GB games only');
});

test('a Game Boy hack\'s location follows its moved map variables', async () => {
  const { readLocation } = await import('../shared/live/location.mjs');
  const maps = json('maps.json');
  const entry = { id: 'crystal_us', gen: 2, wram: { delta: 11, moved: { '0xDCB5': '0xDCC0', '0xDCB6': '0xDCC1' } } };
  const mem = { 0xdcc0: 24, 0xdcc1: 3, 0xdcb5: 1, 0xdcb6: 1 };
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem[a + i] ?? 0);
  const r = readLocation(maps, entry, read);
  assert.equal(r.map, '24.3', 'Route 29 from the moved variables');
  assert.equal(readLocation(maps, { id: 'crystal_us', gen: 2 }, read).map, '1.1', 'the retail entry reads the old place');
});

test('Rare Candies in a Game Boy hack with moved RAM go into its bag, not where the retail game keeps one', async () => {
  const { addRareCandies } = await import('../shared/live/cheats.mjs');
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const bus = { read: (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0), write: (a, bytes) => (put(a, [...bytes]), true) };
  // Crystal Legacy: the bag at 0xD892 + 11 with one Potion (0x12 ×5), the key items after it
  put(0xd89d, [1, 0x12, 5, 0xff]);
  put(0xd8c7, [0, 0xff]);
  const entry = { id: 'crystal_us', gen: 2, wram: { delta: 11, moved: { '0xDCD7': '0xDCE2' } } };
  const r = addRareCandies(entry, bus, {}, 99);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual([...bus.read(0xd89d, 6)], [2, 0x12, 5, 0x20, 99, 0xff]);
  assert.equal(addRareCandies({ id: 'crystal_us', gen: 2 }, bus, {}, 99).error, 'notFound', 'the retail address holds no bag here');
});

test('Gen 5 battle without a flag: over once the battle\'s HP is copied back into the party, not 90 s later', async () => {
  const { readLiveParty, readLiveBattle, findEntry, LiveTables } = await import('../shared/live/parse.mjs');
  const { encryptPK4 } = await import('../shared/gen4save.mjs');
  const T5 = new LiveTables({ gen4: json('gen4.json') });
  const BLACK = findEntry(json('addresses.json'), { platform: 'nds', code: 'IRBO' });
  const m = new Uint8Array(0x400000);
  const w = (addr, bytes) => m.set(bytes, addr - 0x02000000);
  const read = (addr, len) => (addr >= 0x02000000 && addr + len <= 0x02400000 ? m.slice(addr - 0x02000000, addr - 0x02000000 + len) : null);
  const pk5 = ({ pid, species, tid = 4242, level = 5, hp = 21, maxHp = 21 }) => {
    const d = new Uint8Array(220);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, pid, true);
    dv.setUint16(0x08, species, true);
    dv.setUint16(0x0c, tid, true);
    dv.setUint16(0x80, 4, true);
    d[0x8c] = level;
    dv.setUint16(0x8e, hp, true);
    dv.setUint16(0x90, maxHp, true);
    return encryptPK4(d);
  };
  const core = (mons) => [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...pk5(x)])];
  const party = 0x022349b4 - 8;
  const me = { pid: 0x4e912661, species: 498 };
  w(party, core([me]));
  w(0x02300000, core([{ pid: 0x0bad0001, species: 495, tid: 7 }])); // Bianca's Snivy
  w(0x02310000, core([{ ...me, hp: 11 }])); // the battle's copy of the player's party: Tepig got hit
  const state = {};
  const poll = (n = 1) => {
    let f = null;
    for (let i = 0; i < n; i++) f = readLiveBattle(BLACK, read, T5, state, readLiveParty(BLACK, read, T5, state)?.party);
    return f;
  };
  assert.equal(poll(6)?.enemy?.species, 495, 'in battle');
  // the battle's own structs { species, max HP, HP, …, level at +12 } hold the HP the screen shows
  const bmon = (species, maxHp, hp, level) => { const b = new Uint8Array(16); b.set([species & 0xff, species >> 8, maxHp & 0xff, maxHp >> 8, hp & 0xff, hp >> 8]); b[12] = level; return b; };
  w(0x0226d6b0, bmon(498, 21, 9, 5));
  w(0x0226d8d4, bmon(495, 21, 8, 5)); // (Snivy's maxHp in the copy: 21)
  state.g5scan = 0;
  const f = poll(1);
  assert.deepEqual([f.enemy.hp, f.active.hp], [8, 9], 'live HP from the battle structs, not the copies\' starting HP');
  w(0x0226d6b0, new Uint8Array(16));
  w(0x0226d8d4, new Uint8Array(16));
  w(0x02310000, core([me])); // a Potion heals Tepig to full: the copy agrees with the save party, the fight goes on
  assert.equal(poll(2)?.enemy?.species, 495, 'still in battle');
  w(0x02310000, core([{ ...me, hp: 11 }])); // hit again
  poll(2);
  w(party, core([{ ...me, hp: 11 }])); // the fight is over: the game writes the battle's HP back
  assert.equal(poll(2), null, 'over right away');
  assert.equal(poll(6), null, 'and the leftover copies don\'t bring it back');
});

test('Gen 1 and Gold/Silver: a Pokémon that joins right after a wild battle is filed under the place the sign shows', async () => {
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx)) });
  const R = await import('../web/lib/run.mjs');
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const doc = new RunDoc('t');
  doc.by = 'a';
  doc._persistSoon = () => {};
  const manifest = { id: 't', mode: 'nuzlocke', players: { p1: { name: 'A' } }, game: { system: 'gb', code: '' } };
  const charmander = { key: 'g1-1', species: 4, nickname: 'A', level: 6, hp: 20, maxHp: 20, metLocation: null };
  const rattata = { key: 'g1-2', species: 19, nickname: 'RATTATA', level: 3, hp: 15, maxHp: 15, metLocation: null };
  const route1 = { gen: 1, id: 11, name: 'Route 1' };
  R.applySnapshot(doc, manifest, 1, 'p1', { source: 'live', party: [charmander], here: { gen: 1, id: 0, name: 'Pallet Town' } });
  assert.equal(doc.get('enc:starter:p1').species, 4);
  // the wild battle on Route 1, then the catch joins the team
  R.applySnapshot(doc, manifest, 1, 'p1', { source: 'live', party: [charmander], here: route1 }, { battle: { kind: 'wild', enemy: { species: 19, level: 3 } } });
  const res = R.applySnapshot(doc, manifest, 1, 'p1', { source: 'live', party: [charmander, rattata], here: route1 });
  assert.deepEqual(res.newCatches, ['m1-11']);
  assert.equal(R.areaName(doc, manifest, 'm1-11'), 'Route 1');
  // a Pokémon that turns up without a wild battle (a gift, a trade) still goes to the inbox
  const eevee = { key: 'g1-3', species: 133, nickname: 'EEVEE', level: 25, hp: 60, maxHp: 60, metLocation: null };
  const doc2 = new RunDoc('t2');
  doc2.by = 'a';
  doc2._persistSoon = () => {};
  R.applySnapshot(doc2, manifest, 1, 'p1', { source: 'live', party: [charmander], here: route1 });
  const r2 = R.applySnapshot(doc2, manifest, 1, 'p1', { source: 'live', party: [charmander, eevee], here: route1 });
  assert.equal(r2.newCatches.length, 0);
  assert.equal(r2.inbox[0].mon.species, 133);
});

test('types from the ROM: a Gen 3 hack\'s own types; Fairy matchups only matter where a hack has the type', async () => {
  const { romTypes } = await import('../shared/live/romspecies.mjs');
  const { effectiveness, defenseChart, typesOfGen } = await import('../shared/typechart.mjs');
  // a GBA ROM with a base stats table: Bulbasaur's entry as the anchor, internal #13 retyped to Bug/Poison → Fire
  const rom = new Uint8Array(0x8000);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  const T = 0x1000;
  for (let i = 1; i <= 411; i++) rom.set([45, 49, 49, 45, 65, 65, 0, 0], T + i * 28);
  rom.set([12, 3], T + 28 + 6); // Bulbasaur Grass/Poison
  rom.set([10, 10], T + 13 * 28 + 6); // #13 (Weedle in the retail games) – Fire in this hack
  const base = (id) => ({ 1: ['grass', 'poison'], 13: ['bug', 'poison'] }[id] || ['normal']);
  const r = romTypes(rom, { baseTypes: base, vanillaIndex: Array.from({ length: 412 }, (_, i) => i) });
  assert.deepEqual(r.types[13], ['fire']);
  assert.equal(r.types[1], undefined, 'unchanged types aren\'t listed');
  assert.equal(r.fairy, false);
  // with the hack's own species map (Venipede in slot 13) the types belong to that Pokémon
  const r2 = romTypes(rom, { baseTypes: base, speciesMap: { map: Object.assign(Array.from({ length: 412 }, (_, i) => i), { 13: 543 }) } });
  assert.deepEqual(r2.types[543], ['fire']);
  assert.equal(romTypes(new Uint8Array(0x8000).fill(1), { baseTypes: base }), null, 'no table, no guess');
  // Fairy: Dragon can't touch it, it beats Dragon; the retail chart is unchanged for everything else
  assert.equal(effectiveness('dragon', ['fairy']), 0);
  assert.equal(effectiveness('fairy', ['dragon', 'dark']), 4);
  assert.equal(effectiveness('steel', ['fairy', 'normal']), 2);
  assert.equal(effectiveness('fire', ['grass']), 2);
  assert.ok(!typesOfGen(4).includes('fairy'));
  assert.ok(defenseChart(['dragon'], 4, { fairy: true })[2].includes('fairy'), 'a Fairy hack: Dragon is weak to it');
  assert.ok(!defenseChart(['dragon'], 4)[2].includes('fairy'), 'a retail game: no Fairy');
});

test('expanded GBA engines (Run & Bun): the team is searched for in EWRAM, the place read through SaveBlock1', async () => {
  const { readLiveParty, readLiveBattle, findEntry, LiveTables } = await import('../shared/live/parse.mjs');
  const { readLocation } = await import('../shared/live/location.mjs');
  const maps = json('maps.json');
  const emerald = findEntry(json('addresses.json'), { platform: 'gba', code: 'BPEE' });
  const entry = { ...emerald, scan3: true };
  // Run & Bun numbers its species in National Dex order: the ROM's map (romSpecies, by name) – Chimchar is 390
  const T = new LiveTables({ charsetGen3: cs3, gen3Index: idx3 }).withSpecies({ map: Object.assign([], { 390: 390, 987: 263 }) });
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  put(0x02023a95, [1]);
  put(0x02023a98, [...pk3({ internal: 390, level: 5, hp: 20, maxHp: 20 })]);
  put(0x02023a98 + 600, [...pk3({ pid: 0x55667788, internal: 987, level: 2, hp: 9, maxHp: 14 })]);
  const state = {};
  const r = readLiveParty(entry, read, T, state);
  assert.deepEqual(r.party.map((m) => [m.species, m.level, m.hp]), [[390, 5, 20]], 'found where the base game has nothing');
  assert.equal(readLiveParty(emerald, read, T, {})?.party?.length || 0, 0, 'the base game\'s address holds no team');
  put(0x030026f9, [0x02]); // gMain.inBattle (gMain didn't move)
  const f = readLiveBattle(entry, read, T, state, r.party);
  assert.deepEqual([f.kind, f.enemy.species, f.enemy.level, f.enemy.hp], ['wild', 263, 2, 9], 'a Galarian Zigzagoon is a Zigzagoon');
  // the place: gSaveBlock1Ptr among the code's busiest IWRAM addresses → SaveBlock1 { x, y, mapGroup, mapNum }
  const rom = { gen: 3, family: 'rse', lang: 'en', vanilla: false, names: Object.assign([], { 16: 'Route 101' }), mapLoc: null, maps3: { mapsec: { '0.16': 16, '0.9': 0 }, iwram: [0x03005e10, 0x03005d9c] } };
  put(0x03005d9c, [0xbc, 0x4c, 0x02, 0x02]);
  put(0x02024cbc, [10, 0, 15, 0, 0, 16]);
  assert.deepEqual(readLocation(maps, emerald, read, { rom, state }), { gen: 3, id: 16, map: '0.16', romName: 'Route 101' });
  assert.equal(state.sb1PtrAddr, 0x03005d9c);
  // the title screen: SaveBlock1 still empty – no place (it read as Petalburg City, map 0.0 at 0,0)
  put(0x02024cbc, [0, 0, 0, 0, 0, 0]);
  assert.equal(readLocation(maps, emerald, read, { rom, state }), null);
  assert.equal(readLocation(maps, emerald, read, { rom, state: {} }), null, 'and no other pointer is taken for it');
});

test('Platinum and Pearl: the battle flag (checked live) ends a battle at once, also one that left no HP change', async () => {
  const { readLiveParty, readLiveBattle, findEntry, LiveTables } = await import('../shared/live/parse.mjs');
  const { encryptPK4 } = await import('../shared/gen4save.mjs');
  const T4 = new LiveTables({ gen4: json('gen4.json') });
  const PT = findEntry(json('addresses.json'), { platform: 'nds', code: 'CPUE' });
  const m = new Uint8Array(0x400000);
  const w = (addr, bytes) => m.set(bytes, addr - 0x02000000);
  const read = (addr, len) => (addr >= 0x02000000 && addr + len <= 0x02400000 ? m.slice(addr - 0x02000000, addr - 0x02000000 + len) : null);
  const pk4 = ({ pid, species, tid = 4242, level = 5, hp = 20, maxHp = 20 }) => {
    const d = new Uint8Array(236);
    const dv = new DataView(d.buffer);
    dv.setUint32(0, pid, true);
    dv.setUint16(0x08, species, true);
    dv.setUint16(0x0c, tid, true);
    dv.setUint16(0x46, 16, true);
    d[0x8c] = level;
    dv.setUint16(0x8e, hp, true);
    dv.setUint16(0x90, maxHp, true);
    return encryptPK4(d);
  };
  const core = (mons) => [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...pk4(x)])];
  const BASE = 0x0227e14c; // the save data (seen live in Platinum)
  w(0x02000ba8, [0x2c, 0x1d, 0x10, 0x02]); // module params → *(+0x20) = SaveData pointer at 0x02101D4C
  w(0x02101d4c, [BASE & 0xff, (BASE >> 8) & 0xff, (BASE >> 16) & 0xff, BASE >>> 24]);
  w(BASE + 0xb4 - 8, core([{ pid: 0x11111111, species: 387 }]));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 399, tid: 7, level: 3, hp: 12, maxHp: 12 }])); // a wild Bidoof
  const state = {};
  const poll = (n = 1) => {
    let f = null;
    for (let i = 0; i < n; i++) f = readLiveBattle(PT, read, T4, state, readLiveParty(PT, read, T4, state)?.party);
    return f;
  };
  w(0x0224a55a, [0x00, 0x21]);
  assert.equal(poll(6)?.enemy?.species, 399, 'in battle (flag 0x2100)');
  w(0x0224a55a, [0x00, 0x28]); // ran away: back on the overworld
  assert.equal(poll(1), null, 'over at once, not 90 s later');
});
