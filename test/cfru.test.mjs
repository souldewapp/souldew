// Complete FireRed Upgrade hacks – Pokémon Unbound and Radical Red (checked in the running games): what souldew reads
// from their ROMs and RAM. Their own species table behind a shorter row of '?' (the retail one stays in the ROM), item
// names (some through a pointer) and moves in an order of their own, place names in mixed case, FireRed's RAM layout
// with the Pokémon data stored unencrypted, and FireRed's 0x58-byte battlers. Synthetic data shaped like what was
// measured in the games (numbers in comments); no ROM, save or patch of the hacks is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const DATA = mkdtempSync(join(tmpdir(), 'sls-cfru-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const { romSpecies, gen3ItemNames, gen3MoveNames, gen3MoveMap } = await import('../shared/live/romspecies.mjs');
const { gen3Names } = await import('../shared/live/romloc.mjs');
const { readLiveParty, readLiveBattle, findEntry, LiveTables, expandedEntry } = await import('../shared/live/parse.mjs');
const { crc32 } = await import('../shared/checksum.mjs');

const ROOT = new URL('../', import.meta.url);
const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const cs3 = json('charset_gen3.json');
const api = json('pokeapi.json');
const dexNames = api.names.en;
const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};

function gba(size) {
  const rom = new Uint8Array(size);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'POKEMON FIREBPRE'].map((c) => c.charCodeAt(0)), 0xa0);
  return rom;
}

/** A name table: `names` in `stride`-byte fields from `at` (terminated, padded with 0). */
const table = (rom, at, names, stride) => names.forEach((n, i) => {
  rom.fill(0, at + i * stride, at + (i + 1) * stride);
  rom.set([...enc3(n), 0xff], at + i * stride);
});

test('species: the hack\'s own table behind "??????" (Unbound) or "?" (Radical Red) wins over the retail one left in the ROM', () => {
  for (const first of ['??????', '?']) {
    const rom = gba(0x40000);
    // the retail table (Radical Red even renamed its Pokémon there) – 411 species
    table(rom, 0x1000, ['??????????', ...dexNames.slice(1, 412)], 11);
    // the hack's own: 1293 entries in Unbound, 1375 in Radical Red; Unown's forms named after the letter
    const names = [first, ...dexNames.slice(1, 480), 'Unown !', 'Unown ?', 'Unown B', 'UNOWNC', 'Poltegeist', 'Warrior'];
    table(rom, 0x10000, names, 11);
    const r = romSpecies(rom, { gen3Charset: cs3, dexNames, dexNamesOther: ['de', 'fr', 'es', 'it'].map((l) => api.names[l]) });
    assert.equal(r.engine, 'expanded', first);
    assert.equal(r.source.names, 0x10000, `${first}: the longest table`);
    assert.equal(r.count, names.length - 1);
    const at = (s) => names.indexOf(s);
    for (const u of ['Unown !', 'Unown ?', 'Unown B', 'UNOWNC']) assert.equal(r.map[at(u)], 201, `${u} is Unown`);
    assert.equal(r.map[at('Poltegeist')], 855, 'shortened – fits the English and the French name of one Pokémon');
    assert.equal(r.map[at('Warrior')], 0);
    assert.equal(r.unknown[at('Warrior')], 'Warrior', 'a name of its own stays unknown');
  }
});

test('items: the hack\'s item table (44 bytes per item), a name through a pointer (Unbound), the retail table left alone', () => {
  const rom = gba(0x40000);
  const item = (at, i, name, id = i) => {
    const o = at + i * 44;
    rom.fill(0, o, o + 44);
    if (name !== null) rom.set([...enc3(name), 0xff], o);
    rom[o + 14] = id & 0xff;
    rom[o + 15] = id >> 8;
  };
  const retail = ['????????', 'MASTER BALL', 'ULTRA BALL', 'GREAT BALL', 'POKé BALL', 'SAFARI BALL'];
  retail.forEach((n, i) => item(0x1000, i, n));
  const own = ['????????', 'Master Ball', 'Ultra Ball', 'Great Ball', 'Poké Ball', 'Safari Ball', null, null, 'Life Orb', 'Leftovers'];
  own.forEach((n, i) => item(0x8000, i, n ?? ''));
  // entry 6: no name (its first byte 0xFF – a hidden item); entry 7: "Wishing Piece" through a pointer, the field's own
  // text overwritten by it (Unbound 0x08EB922A)
  rom[0x8000 + 6 * 44] = 0xff;
  rom.set([...enc3('Wishing Piece'), 0xff], 0x20000);
  put32(rom, 0x8000 + 7 * 44, 0x08020000);
  rom.fill(0xff, 0x8000 + 10 * 44, 0x8000 + 11 * 44); // the end of the table
  const r = gen3ItemNames(rom, cs3);
  assert.equal(r.offset, 0x8000);
  assert.equal(r.names.length, 10);
  assert.deepEqual([r.names[1], r.names[6], r.names[7], r.names[8]], ['Master Ball', '', 'Wishing Piece', 'Life Orb']);
  assert.equal(gen3ItemNames(gba(0x4000), cs3), null, 'no table, no names');
});

test('moves: Complete FireRed Upgrade\'s own order after the retail 354 → the National numbers, compared in the ROM\'s language', () => {
  const en = api.moves.en;
  const lists = ['en', 'de', 'fr', 'es', 'it'].map((l) => api.moves[l]);
  // (the games' 12 letters: "ThunderPunch", "SmellingSalt")
  const short = (n) => (n.length > 12 ? n.replace(/ /g, '').slice(0, 12) : n);
  const names = ['-', ...en.slice(1, 355).map(short)];
  names[136] = 'Hi Jump Kick'; // the retail spellings
  names[185] = 'Faint Attack';
  names[265] = 'SmellingSalt';
  // Unbound #355 on: its own order (Leech Fang isn't a real move), then moves German calls Follow Me / Self-Destruct
  names.push('Leech Fang', 'Air Slash', 'Aqua Jet', 'Spotlight', 'Finale', 'Psystrike');
  const m = gen3MoveMap(names, lists);
  assert.deepEqual([m.map[1], m.map[136], m.map[185], m.map[265]], [1, 136, 185, 265], 'the retail moves keep their numbers');
  const at = (s) => names.indexOf(s);
  assert.equal(m.map[at('Leech Fang')], 0, 'a move the app doesn\'t know is left out');
  assert.equal(m.map[at('Air Slash')], 403);
  assert.equal(m.map[at('Aqua Jet')], 453);
  assert.equal(m.map[at('Spotlight')], 671, 'the Gen 7 move – not Follow Me ("Spotlight" in German)');
  assert.equal(m.map[at('Finale')], 0, 'not Self-Destruct ("Finale" in German)');
  assert.equal(m.map[at('Psystrike')], 540);
  assert.ok(m.moved >= 3);
  // pokeemerald-expansion keeps the National order: nothing moved, no map is used (server/lib/romloc.mjs)
  assert.equal(gen3MoveMap(['-', ...en.slice(1, 500)], lists).moved, 0);
  // the table in a ROM: entry 0 "-", Pound next; Radical Red has a second one for long names – the longest wins
  const rom = gba(0x40000);
  table(rom, 0x1000, names.slice(0, 356), 13);
  table(rom, 0x8000, names, 13);
  const t = gen3MoveNames(rom, cs3, lists.map((l) => l[1]));
  assert.deepEqual([t.offset, t.stride, t.names.length, t.names[357]], [0x8000, 13, names.length, 'Aqua Jet']);
});

test('place names: FireRed\'s table rewritten in mixed case (Unbound "Frozen Heights", Radical Red "Pallet Town")', () => {
  const rom = gba(0x40000);
  const places = Array.from({ length: 109 }, (_, i) => (i ? `Route ${i}` : 'Frozen Heights'));
  let text = 0x20000;
  const ptr = (s) => {
    rom.set([...enc3(s), 0xff], text);
    const p = 0x08000000 + text;
    text += s.length + 1;
    return p;
  };
  places.forEach((s, i) => put32(rom, 0x1000 + i * 4, ptr(s)));
  // another table of short mixed-case names (move names, …), longer than a byte can number from 0x58 on: not it
  for (let i = 0; i < 300; i++) put32(rom, 0x3000 + i * 4, ptr(`Move ${i}`));
  const g = gen3Names(rom, cs3);
  assert.equal(g.layout, 'mapNamePointers');
  assert.equal(g.base, 0x58);
  assert.equal(g.names[0x58], 'Frozen Heights');
  assert.equal(g.names[0x58 + 108], 'Route 108');
});

/** A party struct the way Unbound and Radical Red store it: checksum 0, the data not encrypted, always Growth, Attacks, EVs, Misc. */
function plainPk3({ pid, otId, species, item = 0, moves = [33], exp = 1000, level = 5, hp = 20, maxHp = 20, egg = false, status = 0 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d.set([...enc3('MON'), 0xff], 8);
  d[0x13] = egg ? 0x06 : 0x02; // hasSpecies (| isEgg)
  dv.setUint16(32, species, true);
  dv.setUint16(34, item, true);
  dv.setUint32(36, exp, true);
  moves.forEach((m, i) => {
    dv.setUint16(44 + i * 2, m, true);
    d[52 + i] = 20;
  });
  dv.setUint32(72, egg ? 0x40000000 : 0x3fffffff, true); // IVs (bit 30: egg)
  dv.setUint32(80, status, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

/** A retail (encrypted, checksummed) party struct. */
function pk3({ pid, otId, species, level = 5, hp = 20, maxHp = 20 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  d[0x13] = 0x02;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, species, true);
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

/** One of FireRed's BattlePokemon (0x58 bytes: hp +0x28, level +0x2A, maxHP +0x2C, personality +0x48, status1 +0x4C, otId +0x54). */
function battler(raw, species, hp, maxHp, level, status = 0) {
  const d = new Uint8Array(0x58);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, species, true);
  dv.setUint16(0x28, hp, true);
  d[0x2a] = level;
  dv.setUint16(0x2c, maxHp, true);
  d.set(raw.subarray(0, 4), 0x48);
  dv.setUint32(0x4c, status, true);
  d.set(raw.subarray(4, 8), 0x54);
  return d;
}

test('Unbound / Radical Red: the team at FireRed\'s address, unencrypted, with the game\'s item names and moves; battles in FireRed\'s battlers', () => {
  const fr = findEntry(json('addresses.json'), { platform: 'gba', code: 'BPRE' });
  const entry = expandedEntry(fr, null);
  // internal species numbers of the hack (Unbound: 445 Infernape, 42 Golbat, 248 Tyranitar, 4 Charmander)
  const ids = Object.assign([], { 445: 392, 42: 42, 248: 248, 4: 4, 298: 273 });
  const items = { names: Object.assign([''], { 55: 'Life Orb', 200: 'Leftovers' }) };
  const moves = { map: Object.assign([], { 252: 252, 442: 369, 7: 7, 371: 0, 33: 33 }) };
  const T = new LiveTables({ charsetGen3: cs3 }).withSpecies({ engine: 'expanded', map: ids }, { items, moves });
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  const ME = 0x7e0e3343;
  const ME_PID = 0xd681a1e5;
  const lead = plainPk3({ pid: ME_PID, otId: ME, species: 445, item: 55, moves: [252, 442, 7, 371], exp: 1059860, level: 100, hp: 293, maxHp: 293 });
  const second = plainPk3({ pid: 0x11112222, otId: ME, species: 248, item: 200, level: 100, hp: 403, maxHp: 403, status: 0x40 });
  const egg = plainPk3({ pid: 0x33334444, otId: ME, species: 4, egg: true, level: 5, hp: 19, maxHp: 19 });
  put(0x02024029, [3]); // gPlayerPartyCount – 3 bytes in front of gEnemyParty
  put(0x02024284, [...lead, ...second, ...egg]);
  // the last opponent is still in gEnemyParty (a retail-encrypted one, a Lv 47 with the player's ID): never the team
  put(0x0202402c, [...pk3({ pid: 0x0c250a0a, otId: ME, species: 42, level: 47, hp: 0, maxHp: 137 })]);
  const state = {};
  const r = readLiveParty(entry, read, T, state);
  assert.equal(state.party3, 0x02024284, 'FireRed\'s gPlayerParty');
  assert.equal(state.count3, 0x02024029);
  assert.deepEqual(r.party.map((m) => [m.species, m.level, m.hp, m.maxHp, m.isEgg]), [[392, 100, 293, 293, false], [248, 100, 403, 403, false], [4, 5, 19, 19, true]]);
  assert.deepEqual([r.party[0].itemOwn, r.party[0].itemName, r.party[1].itemName], [true, 'Life Orb', 'Leftovers'], 'held items by the game\'s names');
  assert.deepEqual(r.party[0].moves, [252, 369, 7], 'the National numbers, a move the app doesn\'t know left out');
  assert.equal(r.party[1].status, 0x40);
  // the same block encrypted the retail way still reads (and an unencrypted one only in an expanded engine)
  const retailT = new LiveTables({ charsetGen3: cs3 });
  put(0x02024029, [1]);
  assert.equal(readLiveParty(fr, read, retailT, {}).party, undefined, 'a retail FireRed takes no unencrypted block');
  put(0x02024029, [3]);
  // an unencrypted block that doesn't read as one (an experience no growth rate reaches): torn, not a Pokémon
  const broken = plainPk3({ pid: 0x11112222, otId: ME, species: 248, level: 100, hp: 403, maxHp: 403, exp: 0x7fffffff });
  put(0x02024284 + 100, [...broken]);
  assert.deepEqual(readLiveParty(entry, read, T, state), { torn: true });
  put(0x02024284 + 100, [...second]);

  // a wild Golbat (Icy Hole, Lv 47): gEnemyParty with the player's ID, FireRed's gBattleMons at 0x02023BE4
  const golbat = pk3({ pid: 0x0c250a0a, otId: ME, species: 42, level: 47, hp: 137, maxHp: 137 });
  put(0x0202402c, [...golbat]);
  put(0x02023be4, [...battler(lead, 445, 293, 293, 100), ...battler(golbat, 42, 60, 137, 47)]);
  put(0x03003529, [0x02]); // gMain.inBattle (as in FireRed)
  const party = readLiveParty(entry, read, T, state).party;
  state.lastBmScan3 = 0;
  const w = readLiveBattle(entry, read, T, state, party);
  assert.deepEqual([w.kind, w.enemy.species, w.enemy.level, w.enemy.hp, w.enemy.maxHp], ['wild', 42, 47, 60, 137]);
  assert.deepEqual(w.active, { index: 0, hp: 293, maxHp: 293, status: 0 });
  assert.equal(state.bmons3, 0x02023be4);
  assert.equal(state.bmSize3, 0x58, 'FireRed\'s battlers, not pokeemerald-expansion\'s');
  // a trainer (Battle Tower): the opponents' ID isn't the player's; after a switch the panel follows Tyranitar
  const t1 = pk3({ pid: 0x201aa519, otId: 0xd32dbb8a, species: 298, level: 100, hp: 201, maxHp: 201 });
  const t2 = pk3({ pid: 0x0143dde0, otId: 0xd32dbb8a, species: 42, level: 100, hp: 290, maxHp: 290 });
  put(0x0202402c, [...t1, ...t2]);
  put(0x02023be4, [...battler(second, 248, 380, 403, 100), ...battler(t1, 298, 0, 201, 100)]);
  const t = readLiveBattle(entry, read, T, state, party);
  assert.deepEqual([t.kind, t.enemy.species, t.enemy.hp], ['trainer', 273, 0]);
  assert.deepEqual(t.active, { index: 1, hp: 380, maxHp: 403, status: 0 });
  // a double battle: the right-hand opponent (battler 3) once the left one is down
  put(0x02023be4 + 2 * 0x58, [...battler(lead, 445, 200, 293, 100), ...battler(t2, 42, 150, 290, 100)]);
  const d = readLiveBattle(entry, read, T, state, party);
  assert.deepEqual([d.enemy.species, d.enemy.hp], [42, 150]);
  put(0x03003529, [0]);
  assert.equal(readLiveBattle(entry, read, T, state, party), null, 'over with the flag');
});

test('a hack\'s own item names reach the run document and the stream API; the disk cache keeps them', async () => {
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx)) });
  const R = await import('../web/lib/run.mjs');
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const { buildState } = await import('../shared/streamapi.mjs');
  const doc = new RunDoc('t');
  doc.by = 'a';
  doc._persistSoon = () => {};
  const manifest = { id: 'aaaa0002', mode: 'nuzlocke', players: { p1: { name: 'A' } }, game: { system: 'gba', code: 'BPRE', hackId: 'unbound' } };
  const named = { key: 'g3-1', species: 392, nickname: 'MON', level: 100, hp: 293, maxHp: 293, item: 55, itemOwn: true, itemName: 'Life Orb', metLocation: null };
  const unnamed = { key: 'g3-2', species: 248, nickname: 'MON', level: 100, hp: 403, maxHp: 403, item: 700, itemOwn: true, metLocation: null };
  R.applySnapshot(doc, manifest, 3, 'p1', { source: 'live', party: [named, unnamed], here: { gen: 3, id: 0x58, name: 'Frozen Heights' } });
  const party = doc.get('live:p1').party;
  assert.deepEqual([party[0].itemOwn, party[0].itemName, party[1].itemName], [true, 'Life Orb', undefined]);
  const s = JSON.stringify(buildState(manifest, { 'live:p1': { v: doc.get('live:p1'), t: 1, by: 'a' } }, { itemName: () => 'Potion' }));
  assert.match(s, /"item":\{"id":55,"name":"Life Orb"\}/, 'the game\'s own name');
  assert.match(s, /"item":\{"id":700,"name":null\}/, 'never a retail name for the hack\'s own number');
  const { ROMDATA_NONE, fromRomCache } = await import('../server/lib/romloc.mjs');
  assert.ok('items' in ROMDATA_NONE && 'moves' in ROMDATA_NONE);
  assert.deepEqual(fromRomCache({ items: { names: ['', 'Master Ball'] }, moves: { map: [0, 1] } }), { ...ROMDATA_NONE, items: { names: ['', 'Master Ball'] }, moves: { map: [0, 1] } });
});

/** 4 bytes that make crc32(data + them) === target (the CRC's own algebra, run backwards). */
function forceCrc(data, target) {
  const T = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    T[n] = c >>> 0;
  }
  const rev = new Uint8Array(256);
  for (let n = 0; n < 256; n++) rev[T[n] >>> 24] = n;
  let reg = (~crc32(data)) >>> 0;
  const idx = [];
  let x = (~target) >>> 0;
  for (let i = 0; i < 4; i++) {
    idx.unshift(rev[x >>> 24]);
    x = ((x ^ T[idx[0]]) << 8) >>> 0;
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = (reg ^ idx[i]) & 0xff;
    reg = (T[idx[i]] ^ (reg >>> 8)) >>> 0;
  }
  return out;
}

test('library: a pre-patched Radical Red 4.1 ROM is the hack, not FireRed; the official Unbound UPS patch is Unbound by what it makes', async () => {
  const catalog = json('catalog.json');
  const rr = catalog.hacks.find((h) => h.id === 'radical-red');
  const ub = catalog.hacks.find((h) => h.id === 'unbound');
  assert.ok(rr.romCrc32.includes('FBA55DD8'));
  assert.equal(ub.patchFormat, 'ups');
  assert.ok(!ub.uncertain && !ub.uncertainFields, 'the patch format is known now');
  assert.ok(ub.romCrc32.includes('4B3D4957'), 'what the official patch makes');
  const { scanLibrary } = await import('../server/lib/library.mjs');
  const dir = join(DATA, 'Lib');
  mkdirSync(dir, { recursive: true });
  // a ROM with FireRed's header whose checksum is the pre-patched 4.1 ROM's, under a name that says nothing
  const head = gba(0x200);
  head.set([...'01'].map((c) => c.charCodeAt(0)), 0xb0);
  const rom = new Uint8Array(0x204);
  rom.set(head);
  rom.set(forceCrc(head, 0xfba55dd8), 0x200);
  assert.equal(crc32(rom) >>> 0, 0xfba55dd8);
  writeFileSync(join(dir, 'game 1.gba'), rom);
  // a UPS patch from FireRed (U) 1.0 to 4B3D4957, also under a name that says nothing
  const ups = new Uint8Array(4 + 2 + 12);
  ups.set([0x55, 0x50, 0x53, 0x31, 0x80, 0x80], 0);
  put32(ups, 6, 0xdd88761c);
  put32(ups, 10, 0x4b3d4957);
  writeFileSync(join(dir, 'patch.ups'), ups);
  const res = scanLibrary({ libraryFolders: [dir] });
  assert.equal(res.roms.find((r) => r.name.startsWith('game 1'))?.hackId, 'radical-red');
  assert.equal(res.patches.find((p) => p.name.startsWith('patch'))?.hackId, 'unbound');
});
