// Complete FireRed Upgrade hacks – Radical Red, Unbound (issue #17: "Pokémon not showing when added to your team"):
// their own species table, their unencrypted party structs and FireRed's party addresses, as measured in Radical Red
// 4.1 (FireRed USA 1.0 + the author's 4.1.ups): the starter Charmander L5 19/19 at gPlayerParty 0x02024284.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gen3SpeciesNames, romSpecies } from '../shared/live/romspecies.mjs';
import { LiveTables, parsePk3, readLiveParty, expandedEntry } from '../shared/live/parse.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const cs3 = json('charset_gen3.json');
const idx3 = json('gen3_index_to_dex.json');
const dexNames = json('pokeapi.json').names.en;
const vanilla3 = [];
for (const [k, v] of Object.entries(idx3.map)) vanilla3[Number(k)] = v;
const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);
const addresses = json('addresses.json');
const firered = addresses.games.find((g) => g.id === 'firered_us');

/** A FireRed-based ROM image: FireRed's own name table (entry 0 "??????????") and a CFRU one (entry 0 `first`). */
function cfruRom({ first = '?', extra = 0 } = {}) {
  const rom = new Uint8Array(0x30000);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'BPRE'].map((c) => c.charCodeAt(0)), 0xac);
  const put = (at, names) => names.forEach((n, i) => {
    const o = at + i * 11;
    rom.fill(0xff, o, o + 11);
    rom.set(enc3(n).slice(0, 10), o);
  });
  const retail = Array.from({ length: 411 }, (_, i) => (vanilla3[i + 1] ? dexNames[vanilla3[i + 1]].toUpperCase() : '?'));
  put(0x1000, ['??????????', ...retail]);
  // the hack's: the same first 411 (its own spelling), "Unown !" / "Unown ?", then Sinnoh on in National Dex order
  const own = [...retail.map((n) => (n === '?' ? '?' : n[0] + n.slice(1).toLowerCase())), 'Unown !', 'Unown ?'];
  for (let id = 387; id < 387 + extra; id++) own.push(dexNames[id].slice(0, 10));
  put(0x10000, [first, ...own]);
  return rom;
}

test('#17 species: a CFRU table ("?" first, Unown ! / ?) is found and wins over FireRed\'s that stays in the ROM', () => {
  for (const first of ['?', '??????']) {
    const t = gen3SpeciesNames(cfruRom({ first, extra: 120 }), cs3);
    assert.equal(t.offset, 0x10000, `entry 0 "${first}"`);
    assert.equal(t.names.length - 1, 411 + 2 + 120);
  }
  const sp = romSpecies(cfruRom({ extra: 120 }), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  assert.equal(sp.engine, 'expanded');
  assert.equal(sp.map[4], 4, 'Charmander (internal 4) is #4');
  assert.equal(sp.map[414], 387, 'the first species after the Unown forms: Turtwig');
  // a plain FireRed: only its own table – vanilla as before
  const fr = cfruRom();
  fr.fill(0, 0x10000);
  assert.equal(romSpecies(fr, { gen3Charset: cs3, gen3Index: vanilla3, dexNames }).engine, 'vanilla');
});

/** A party struct as Radical Red keeps it: blocks unencrypted, always Growth/Attacks/EVs/Misc, checksum 0. */
function cfruMon({ pid = 0x3430e3bd, otId = 0xdcefc476, internal = 4, level = 5, hp = 19, maxHp = 19 } = {}) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d.set(enc3('Charmander'), 8);
  dv.setUint16(32, internal, true); // Growth: species
  dv.setUint32(36, 134, true); // exp
  dv.setUint16(44, 10, true); // Attacks: Scratch
  dv.setUint16(46, 45, true); // Growl
  d[69] = 157; // Misc: met location
  dv.setUint16(70, 0x0205, true); // origins: met level 5
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}

const tables = () => new LiveTables({ charsetGen1: json('charset_gen1.json'), charsetGen2: json('charset_gen2.json'), charsetGen3: cs3, gen1Index: json('gen1_index_to_dex.json'), gen3Index: idx3, gen4: json('gen4.json') });

test('#17 party struct: CFRU\'s unencrypted blocks read where the team sits at FireRed\'s addresses – nowhere else', () => {
  const sp = romSpecies(cfruRom({ extra: 120 }), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  const T = Object.assign(Object.create(tables().withSpecies(sp)), { plain3: true });
  const m = parsePk3(cfruMon(), T);
  assert.deepEqual({ species: m.species, nickname: m.nickname, level: m.level, hp: m.hp, maxHp: m.maxHp, moves: m.moves, metLevel: m.metLevel },
    { species: 4, nickname: 'Charmander', level: 5, hp: 19, maxHp: 19, moves: [10, 45], metLevel: 5 });
  assert.equal(parsePk3(cfruMon(), tables()).bad, true, 'a retail FireRed: a bad checksum, as before');
  assert.equal(parsePk3(cfruMon(), tables().withSpecies(sp)).bad, true, 'an expanded engine elsewhere in RAM: a checksum of 0 proves nothing');
  // a stored checksum that matches neither: a struct being written, not CFRU's
  const torn = cfruMon();
  torn[28] = 0x12;
  assert.equal(parsePk3(torn, T).bad, true);
});

test('#17 live team: FireRed\'s own addresses (count 0x02024029, party 0x02024284 – far apart) are searched too', () => {
  const sp = romSpecies(cfruRom({ extra: 120 }), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  const T = tables().withSpecies(sp);
  const ewram = new Uint8Array(0x40000);
  ewram[0x24029] = 1;
  ewram.set(cfruMon(), 0x24284);
  const read = (addr, len) => (addr >= 0x02000000 && addr + len <= 0x02040000 ? ewram.subarray(addr - 0x02000000, addr - 0x02000000 + len) : new Uint8Array(len));
  const ent = expandedEntry(firered);
  const state = {};
  const res = readLiveParty(ent, read, T, state);
  assert.deepEqual(res.party.map((m) => [m.species, m.level, m.hp, m.maxHp]), [[4, 5, 19, 19]]);
  assert.equal(state.party3, 0x02024284);
  // a second Pokémon: the count byte says so
  ewram[0x24029] = 2;
  ewram.set(cfruMon({ pid: 0x11112222, internal: 1, level: 3, hp: 12, maxHp: 12 }), 0x24284 + 100);
  assert.deepEqual(readLiveParty(ent, read, T, state).party.map((m) => m.species), [4, 1]);
});

test('#17 no made-up team: the RAM search never takes an unencrypted struct (Unbound\'s intro read as a fainted Bulbasaur)', () => {
  const sp = romSpecies(cfruRom({ extra: 120 }), { gen3Charset: cs3, gen3Index: vanilla3, dexNames });
  const T = tables().withSpecies(sp);
  const ewram = new Uint8Array(0x40000);
  // intro leftovers: a count byte 1 three bytes before an unencrypted-looking struct – not at FireRed's addresses
  ewram[0x10000 - 3] = 1;
  ewram.set(cfruMon({ internal: 1, level: 16, hp: 0, maxHp: 16 }), 0x10000);
  const read = (addr, len) => (addr >= 0x02000000 && addr + len <= 0x02040000 ? ewram.subarray(addr - 0x02000000, addr - 0x02000000 + len) : new Uint8Array(len));
  const res = readLiveParty(expandedEntry(firered), read, T, {});
  assert.ok(!res?.party?.length, 'no team');
});

test('#17 catalog: Radical Red and Unbound are recognised by their patched ROMs; a hack in its own region says which', () => {
  const catalog = json('catalog.json');
  const rr = catalog.hacks.find((h) => h.id === 'radical-red');
  const ub = catalog.hacks.find((h) => h.id === 'unbound');
  assert.deepEqual([rr.romCrc32, ub.romCrc32], [['FBA55DD8'], ['4B3D4957']]);
  assert.equal(ub.patchFormat, 'ups', 'the official file is a .ups');
  assert.equal(ub.region, 'Borrius');
  assert.equal(rr.region, undefined, 'Radical Red is Kanto: FireRed\'s place names are its own');
  for (const h of catalog.hacks.filter((x) => x.region)) assert.ok(h.romCrc32?.length, `${h.id}: a region needs the patched ROM's checksum to be found`);
});
