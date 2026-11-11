// Too Many Types 1 and 2 (pokeemerald-expansion builds, checked in the running games for 2.3.1): what souldew reads
// from their ROMs and RAM where they differ from Run & Bun – the species names inside gSpeciesInfo (TMT2), a party
// with its count elsewhere and gEnemyParty in front (TMT2), gMain moved (TMT2), the Tera type in the species field
// (TMT2), 0x60-byte battlers (both) and a type table of their own (both). Synthetic data shaped like what was
// measured in the games (numbers in comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-tmt-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const { romSpecies, gen3TypeNames, OWN_TYPES_ABOVE } = await import('../shared/live/romspecies.mjs');
const { partyPair, gMainOf } = await import('../shared/live/romloc.mjs');
const { readLiveParty, readLiveBattle, findEntry, LiveTables, expandedEntry } = await import('../shared/live/parse.mjs');

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const cs3 = json('charset_gen3.json');
const dexNames = json('pokeapi.json').names.en;
const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};

function gba(size) {
  const rom = new Uint8Array(size);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'BPEE'].map((c) => c.charCodeAt(0)), 0xac);
  return rom;
}

test('TMT2: species names inside gSpeciesInfo (0x104 bytes per species) are read, empty entries skipped', () => {
  const STRIDE = 0x104;
  const rom = gba(0x80000);
  const at = 0x1000;
  const names = ['??????????', ...dexNames.slice(1, 420)];
  names[200] = ''; // a species the build left out: a zeroed entry
  names.push('Ligmiblin'); // one of its own
  names.forEach((n, i) => {
    const o = at + i * STRIDE;
    rom.fill(0x11, o + 13, o + STRIDE); // the rest of the struct: anything
    if (n) {
      rom.fill(0xff, o, o + 13);
      rom.set(enc3(n).slice(0, 12), o);
    } else rom.fill(0, o, o + STRIDE);
  });
  // a second array of the same struct right after it (TMT2 has one) is not more species
  const second = at + names.length * STRIDE;
  ['??????????', 'Bulbasaur', 'Ivysaur'].forEach((n, i) => {
    rom.fill(0xff, second + i * STRIDE, second + i * STRIDE + 13);
    rom.set(enc3(n), second + i * STRIDE);
  });
  const r = romSpecies(rom, { gen3Charset: cs3, dexNames });
  assert.equal(r.engine, 'expanded');
  assert.equal(r.source.stride, STRIDE);
  assert.equal(r.count, names.length - 1, 'up to its own Pokémon, not into the second array');
  assert.equal(r.map[1], 1);
  assert.equal(r.map[390], 390, 'Chimchar');
  assert.equal(r.map[200], 0, 'a left-out species is no Pokémon');
  assert.equal(r.unknown[names.length - 1], 'Ligmiblin');
});

test('TMT1 / TMT2: a type table of their own is told apart from the retail one and pokeemerald-expansion\'s', () => {
  const build = (names, stride) => {
    const rom = gba(0x4000);
    names.forEach((n, i) => {
      const o = 0x800 + i * stride;
      rom.fill(0, o, o + stride);
      rom.set([...enc3(n), 0xff], o);
    });
    return rom;
  };
  const retail = ['NORMAL', 'FIGHT', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST', 'STEEL', '???', 'FIRE', 'WATER', 'GRASS', 'ELECTR', 'PSYCHC', 'ICE', 'DRAGON', 'DARK'];
  assert.equal(gen3TypeNames(build(retail, 7), cs3).count, 18);
  const expansion = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy', 'Stellar'];
  const rnb = gen3TypeNames(build(expansion, 40), cs3);
  assert.ok(rnb.count <= OWN_TYPES_ABOVE, 'Fairy and Stellar are no types of a hack\'s own');
  // Too Many Types 2: 81 entries, 40 bytes apart (gTypesInfo) – "Monke", "Sus" …
  const tmt = gen3TypeNames(build([...expansion, 'Monke', 'Sus', 'Gamer', 'Crab', 'Bean'], 40), cs3);
  assert.ok(tmt.count > OWN_TYPES_ABOVE);
  assert.equal(tmt.names[20], 'Monke');
  assert.equal(gen3TypeNames(gba(0x4000), cs3), null, 'no table, no guess');
});

/** A literal pool full of `value` (as the code of a build holds its RAM addresses), `n` times. */
const pool = (rom, at, value, n, neighbour = null) => {
  for (let i = 0; i < n; i++) {
    put32(rom, at + i * 16, value);
    if (neighbour !== null) put32(rom, at + i * 16 + 4, neighbour);
  }
};

test('TMT2: gPlayerParty / gEnemyParty and gMain come from the code (the pair 600 bytes apart; gMain next to 0x439)', () => {
  const rom = gba(0x40000);
  pool(rom, 0x1000, 0x02032c94, 50); // gPlayerParty (577 times in TMT2)
  pool(rom, 0x2000, 0x02032a3c, 25); // gEnemyParty (275 times), in front of it
  pool(rom, 0x3000, 0x03004084, 30, 0x439); // gMain + the battle flag's offset
  pool(rom, 0x4000, 0x030022c0, 3, 0x439); // the base game's gMain, a few times
  assert.deepEqual(partyPair(rom), { player: 0x02032c94, enemy: 0x02032a3c }, 'the busier one is the player\'s');
  assert.equal(gMainOf(rom), 0x03004084);
  assert.equal(partyPair(gba(0x4000)), null);
  assert.equal(gMainOf(gba(0x4000)), null);
});

/** A party struct of an expanded engine (100 bytes), the species field with a Tera type in its top bits. */
function pk3x({ pid, otId, species, tera = 0, level = 5, hp = 20, maxHp = 20 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  d[0x13] = 0x02; // hasSpecies
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, species | (tera << 11), true);
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

test('TMT2: the team without a count byte in front, the Tera type masked off, the moved battle flag, 0x60-byte battlers', () => {
  const emerald = findEntry(json('addresses.json'), { platform: 'gba', code: 'BPEE' });
  const maps3 = { party3: { player: 0x02032c94, enemy: 0x02032a3c }, gMain: 0x03004084 };
  const entry = expandedEntry(emerald, maps3);
  assert.equal(entry.inBattle.addr, '0x30044bd', 'gMain + 0x439 (measured: bit 1 set in its battles only)');
  assert.deepEqual(expandedEntry(emerald, null).inBattle, emerald.inBattle, 'without a hint the base game\'s flag');
  const ids = Object.assign([], { 390: 390, 656: 656, 540: 540 });
  const T = new LiveTables({ charsetGen3: cs3 }).withSpecies({ engine: 'expanded', map: ids });
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  const ME = 0x66ded035;
  // the intro's leftover in gEnemyParty (a Lv 50 with the player's ID) before the starter – not the team
  put(0x02032a3c, [...pk3x({ pid: 0x6ff7645b, otId: ME, species: 540, level: 50, hp: 75, maxHp: 75 })]);
  const s0 = {};
  assert.equal(readLiveParty(entry, read, T, s0), null, 'no team before the starter');
  // Chimchar arrives: 0x5986 in the species field = 390 | Tera type 11 << 11
  const chimchar = pk3x({ pid: 0x05f5e9e8, otId: ME, species: 390, tera: 11, level: 5, hp: 20, maxHp: 20 });
  put(0x02032c94, [...chimchar]);
  const state = {};
  const r = readLiveParty(entry, read, T, state);
  assert.deepEqual(r.party.map((m) => [m.species, m.level, m.hp, m.isEgg]), [[390, 5, 20, false]]);
  assert.equal(state.party3, 0x02032c94);
  // the rival's Froakie: a trainer battle; gBattleMons with 0x60 bytes per battler (TMT2 0x020005AC, TMT1 0x020230F8)
  const froakie = pk3x({ pid: 0x12345678, otId: 0x0badf00d, species: 656, level: 5, hp: 19, maxHp: 19 });
  put(0x02032a3c, [...froakie]);
  const BM = 0x020005ac;
  const battler = (i, raw, species, hp, maxHp, level) => {
    const d = new Uint8Array(0x60);
    const dv = new DataView(d.buffer);
    dv.setUint16(0, species, true);
    dv.setUint16(0x2a, hp, true);
    d[0x2c] = level;
    dv.setUint16(0x2e, maxHp, true);
    d.set(raw.subarray(0, 4), 0x4c);
    d.set(raw.subarray(4, 8), 0x58);
    put(BM + i * 0x60, [...d]);
  };
  battler(0, chimchar, 390, 17, 20, 5);
  battler(1, froakie, 656, 11, 19, 5);
  assert.equal(readLiveBattle(entry, read, T, state, r.party), null, 'no battle while the flag is off');
  put(0x030044bd, [0x02]);
  state.lastBmScan3 = 0;
  const f = readLiveBattle(entry, read, T, state, r.party);
  assert.deepEqual([f.kind, f.enemy.species, f.enemy.hp], ['trainer', 656, 11]);
  assert.deepEqual(f.active, { index: 0, hp: 17, maxHp: 20, status: 0 });
  assert.equal(state.bmSize3, 0x60);
  // a catch: the team is the structs from gPlayerParty on (two now)
  put(0x02032c94 + 100, [...pk3x({ pid: 0x0a0b0c0d, otId: ME, species: 540, level: 2, hp: 14, maxHp: 14 })]);
  put(0x030044bd, [0]);
  assert.deepEqual(readLiveParty(entry, read, T, state).party.map((m) => m.species), [390, 540]);
});
