import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { findEntry, readLiveParty, LiveTables, regionsFor, regionReader, parsePk3 } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { matchCatalog } from '../shared/romid.mjs';

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const TABLE = L('addresses.json');

/** Sparse bus memory for tests. */
function memory() {
  const blocks = [];
  return {
    write(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
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
  };
}
const inv = (charset) => Object.fromEntries(Object.entries(charset.table).map(([k, v]) => [v, parseInt(k, 16)]));

test('entry lookup by game code / header title', () => {
  assert.equal(findEntry(TABLE, { platform: 'gba', code: 'BPRE' }).id, 'firered_us');
  // German Emerald (Smaragd) is tracked live like the English game – its RAM is the same (3.0 acceptance, verified in the
  // running game: team, place, cap, battle, bag, catch); French, Italian and Spanish Emerald share emerald_eu (the Italian one
  // checked in the running game)
  assert.equal(findEntry(TABLE, { platform: 'gba', code: 'BPED', title: 'POKEMON EMER' }).id, 'emerald_de');
  for (const code of ['BPEF', 'BPEI', 'BPES']) assert.equal(findEntry(TABLE, { platform: 'gba', code, title: 'POKEMON EMER' }).id, 'emerald_eu', code);
  assert.equal(findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' }).id, 'red_us');
  assert.equal(findEntry(TABLE, { platform: 'nds', code: 'IPKE' }).id, 'heartgold_us');
  assert.ok(findEntry(TABLE, { platform: 'nds', code: 'IPKD' }).scanOnly, 'German HG falls back to scanning');
});

test('Gen 1 (Red): party from WRAM', () => {
  const e = findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  m.write(0xd163, [1, 0x99, 0xff]); // count, Bulbasaur (internal 0x99), terminator
  const mon = new Uint8Array(44);
  mon[0] = 0x99;
  mon[1] = 0; mon[2] = 18; // HP 18 (big-endian)
  mon[0x0c] = 0x12; mon[0x0d] = 0x34; // OT ID
  mon[0x1b] = 0xab; mon[0x1c] = 0xcd; // DVs
  mon[0x21] = 7; // level
  mon[0x22] = 0; mon[0x23] = 23; // max HP
  m.write(0xd16b, mon);
  const cs = inv(L('charset_gen1.json'));
  m.write(0xd2b5, [...'BULBA'].map((c) => cs[c]).concat([0x50]));
  const r = readLiveParty(e, m.read, T);
  assert.equal(r.party.length, 1);
  assert.deepEqual([r.party[0].species, r.party[0].nickname, r.party[0].level, r.party[0].hp, r.party[0].maxHp], [1, 'BULBA', 7, 18, 23]);
  // the bridge region covers count → nicknames
  const [reg] = regionsFor(e);
  assert.equal(reg.addr, 0xd163);
  const hex = Array.from(m.read(reg.addr, reg.len), (b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(readLiveParty(e, regionReader([{ addr: reg.addr, hex }]), T).party[0].nickname, 'BULBA');
});

test('Gen 1 (#83): the box chosen in the PC is read too – where a catch goes with a full team', () => {
  const e = findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' });
  const m = memory();
  const cs = inv(L('charset_gen1.json'));
  m.write(0xd163, [1, 0x99, 0xff]);
  const mon = new Uint8Array(44);
  mon[0] = 0x99;
  mon[2] = 18;
  mon[0x21] = 7;
  mon[0x23] = 23;
  m.write(0xd16b, mon);
  m.write(0xd2b5, [...'BULBA'].map((c) => cs[c]).concat([0x50]));
  // an empty box: count 0, terminator
  m.write(0xda80, [0, 0xff]);
  assert.deepEqual(readLiveParty(e, m.read, T, {}).box, []);
  // a Pidgey caught into it (as Red wrote it, checked live: wNumInBox 1, species 0x24, terminator)
  const box = new Uint8Array(33);
  box[0] = 0x24;
  box[2] = 16;
  box[3] = 3; // the box level
  box[0x0c] = 0x56; box[0x0d] = 0x50; // OT ID
  box[0x1b] = 0x7b; box[0x1c] = 0x48; // DVs
  m.write(0xda80, [1, 0x24, 0xff]);
  m.write(0xda96, box);
  m.write(0xde06, [...'PIDGEY'].map((c) => cs[c]).concat([0x50]));
  const state = {};
  let r = readLiveParty(e, m.read, T, state);
  if (r.torn) r = readLiveParty(e, m.read, T, state); // (a changed box counts once it reads the same twice)
  assert.deepEqual(r.box.map((x) => [x.species, x.level, x.nickname, x.key, x.inBox]), [[16, 3, 'PIDGEY', 'g1-5650-7b48', true]]);
  assert.equal(r.party.length, 1, 'the team is the team');
  assert.equal(r.boxes, undefined, 'one box is not the whole PC');
  // what doesn't read as a box (a count over 20, no terminator, a species byte that doesn't match the list) is none
  m.write(0xda80, [1, 0x25, 0xff]);
  assert.equal(readLiveParty(e, m.read, T, {}).box, undefined);
  m.write(0xda80, [21]);
  assert.equal(readLiveParty(e, m.read, T, {}).box, undefined);
  // Yellow and Gen 2 keep no such box (unchecked / in the cartridge's RAM)
  assert.equal(findEntry(TABLE, { platform: 'gb', title: 'POKEMON YELLOW' }).box, undefined);
});

test('Gen 2 (Crystal): party with caught location', () => {
  const e = findEntry(TABLE, { platform: 'gbc', title: 'PM_CRYSTAL', code: 'BYTE' });
  const m = memory();
  m.write(0xdcd7, [1, 155, 0xff]);
  const mon = new Uint8Array(48);
  mon[0] = 155; // Cyndaquil
  mon[0x1d] = 5; mon[0x1e] = 2; // met level 5, Route 29
  mon[0x1f] = 6;
  mon[0x22] = 0; mon[0x23] = 20;
  mon[0x24] = 0; mon[0x25] = 22;
  m.write(0xdcdf, mon);
  m.write(0xde41, [0x50]);
  const r = readLiveParty(e, m.read, T);
  assert.deepEqual([r.party[0].species, r.party[0].level, r.party[0].hp, r.party[0].metLocation], [155, 6, 20, 2]);
});

function pk3({ pid, otId, internal, nick, level, hp, maxHp, met, ivWord = 0, flags = 0 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  const cs = inv(L('charset_gen3.json'));
  [...nick].forEach((c, i) => (d[8 + i] = cs[c]));
  d[8 + nick.length] = 0xff;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  const at = (ch) => order.indexOf(ch) * 12;
  pv.setUint16(at('G'), internal, true);
  pv.setUint16(at('A'), 33, true);
  plain[at('M') + 1] = met;
  pv.setUint16(at('M') + 2, 5, true); // met level 5
  pv.setUint32(at('M') + 4, ivWord, true); // IVs (+ the egg bit 30 in the retail games)
  d[0x13] = flags; // BoxPokemon +0x13: isBadEgg, hasSpecies, isEgg
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

test('Gen 3 (FireRed): encrypted party struct', () => {
  const e = findEntry(TABLE, { platform: 'gba', code: 'BPRE' });
  const m = memory();
  m.write(0x02024029, [2]);
  m.write(0x02024284, [
    ...pk3({ pid: 0x12345677, otId: 0xbeefcafe, internal: 277, nick: 'TREECKO', level: 9, hp: 0, maxHp: 28, met: 101 }),
    ...pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 16, nick: 'Birdy', level: 4, hp: 15, maxHp: 16, met: 101 }),
  ]);
  const r = readLiveParty(e, m.read, T);
  assert.deepEqual(r.party.map((x) => [x.species, x.nickname, x.level, x.hp, x.maxHp, x.metLocation]), [
    [252, 'TREECKO', 9, 0, 28, 101],
    [16, 'Birdy', 4, 15, 16, 101],
  ]);
  // corrupted (mid-write) struct is reported as torn, not parsed as garbage
  const bad = pk3({ pid: 1, otId: 2, internal: 1, nick: 'X', level: 5, hp: 1, maxHp: 1, met: 0 });
  bad[40] ^= 0xff;
  assert.ok(parsePk3(bad, T).bad);
});

test('Gen 3 Emerald in French, Italian and Spanish: its own table entry, the English RAM layout (German: emerald_de)', () => {
  const us = findEntry(TABLE, { platform: 'gba', code: 'BPEE' });
  assert.equal(us.id, 'emerald_us');
  for (const code of ['BPED', 'BPEF', 'BPEI', 'BPES']) {
    const e = findEntry(TABLE, { platform: 'gba', code });
    assert.equal(e?.id, code === 'BPED' ? 'emerald_de' : 'emerald_eu', code);
    assert.ok(!e.scanOnly, code);
    // every address as in the English game (the Italian ROM's literal pools, pokebot-gen3's language patch)
    for (const k of ['partyCountAddr', 'partyAddr', 'enemyPartyAddr', 'battleTypeFlagsAddr']) assert.equal(e[k], us[k], k);
    assert.equal(e.inBattle.addr, us.inBattle.addr);
    assert.deepEqual([e.liveBattleHp.battleMonsAddr, e.liveBattleHp.battlerPartyIndexesAddr], [us.liveBattleHp.battleMonsAddr, us.liveBattleHp.battlerPartyIndexesAddr]);
    assert.equal(e.saveBlockPtrs, undefined, 'the save block pointers are Emerald\'s own (gen3Badges, cheats)');
  }
  const maps = L('maps.json');
  for (const k of ['mapHeaderAddr', 'musicAddr', 'musicSize', 'kind']) assert.equal(maps.games.emerald_eu[k], maps.games.emerald_us[k], k);
  // the issue's ROM (Versione Smeraldo, BPEI): the party reads like the English one
  const it = findEntry(TABLE, { platform: 'gba', code: 'BPEI' });
  const m = memory();
  m.write(0x020244e9, [1]);
  m.write(0x020244ec, pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 1, nick: 'BULBASAUR', level: 5, hp: 20, maxHp: 21, met: 16 }));
  const r = readLiveParty(it, m.read, T);
  assert.deepEqual(r.party.map((x) => [x.species, x.nickname, x.level, x.hp, x.maxHp, x.metLocation]), [[1, 'BULBASAUR', 5, 20, 21, 16]]);
});

test('Gen 3 Ruby/Sapphire in French, Italian and Spanish: their own table entry, the German layout', () => {
  const maps = L('maps.json');
  for (const [game, c] of [['ruby', 'AXV'], ['sapphire', 'AXP']]) {
    const de = findEntry(TABLE, { platform: 'gba', code: `${c}D` });
    assert.equal(de.id, `${game}_de`);
    for (const l of ['F', 'I', 'S']) {
      const e = findEntry(TABLE, { platform: 'gba', code: c + l });
      assert.equal(e?.id, `${game}_eu`, c + l);
      // the team 0x10 further on than in the English game, like the German one (the Italian Ruby's literal pools)
      for (const k of ['partyCountAddr', 'partyAddr', 'enemyPartyAddr', 'battleTypeFlagsAddr']) assert.equal(e[k], de[k], k);
      assert.equal(e.inBattle.addr, de.inBattle.addr);
      assert.deepEqual(e.liveBattleHp.battleMonsAddr, de.liveBattleHp.battleMonsAddr);
    }
    for (const k of ['mapHeaderAddr', 'musicAddr', 'musicSize', 'kind']) assert.equal(maps.games[`${game}_eu`][k], maps.games[`${game}_de`][k], k);
  }
  assert.equal(findEntry(TABLE, { platform: 'gba', code: 'AXVE' }).id, 'ruby_us');
  // the issue's ROM (Versione Rubino, AXVI): the party at 0x03004370, its count at 0x03004360
  const it = findEntry(TABLE, { platform: 'gba', code: 'AXVI' });
  assert.deepEqual([it.partyCountAddr, it.partyAddr], ['0x03004360', '0x03004370']);
  const m = memory();
  m.write(0x03004360, [1]);
  m.write(0x03004370, pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 1, nick: 'BULBASAUR', level: 5, hp: 20, maxHp: 21, met: 16 }));
  const r = readLiveParty(it, m.read, T);
  assert.deepEqual(r.party.map((x) => [x.species, x.nickname, x.level, x.hp, x.maxHp, x.metLocation]), [[1, 'BULBASAUR', 5, 20, 21, 16]]);
});

test('the catalog knows the Italian, French and Spanish Gen 3 games as retail games, not as unknown ROMs', () => {
  const catalog = L('catalog.json');
  // the issue's file: "Pokemon - Versione Smeraldo (Italy).gba", BPEI, CRC32 A0AEC80A
  const hit = matchCatalog({ system: 'gba', title: 'POKEMON EMER', code: 'BPEI', crc: 'A0AEC80A' }, catalog);
  assert.deepEqual([hit.game.id, hit.game.variantOf, hit.exact], ['pokemon-emerald-it', 'pokemon-emerald', true]);
  for (const base of ['ruby', 'sapphire', 'emerald', 'firered', 'leafgreen']) {
    const root = catalog.games.find((g) => g.id === `pokemon-${base}`);
    for (const [lang, letter] of [['it', 'I'], ['fr', 'F'], ['es', 'S']]) {
      const g = catalog.games.find((x) => x.id === `pokemon-${base}-${lang}`);
      assert.ok(g, `${base}-${lang}`);
      assert.equal(g.variantOf, root.id);
      assert.equal(g.serial, root.serial.slice(0, 3) + letter);
      assert.ok(g.crc32.length === g.dumps.length && g.dumps.every((d) => d.uprSupported && d.sizeBytes === 16777216), g.id);
      assert.ok(existsSync(new URL(`../web/assets/covers/${g.id}.png`, import.meta.url)), `cover of ${g.id}`);
      // a modified copy (another CRC32) is still this game's
      assert.equal(matchCatalog({ system: 'gba', code: g.serial, crc: '00000000' }, catalog).game.id, g.id);
    }
  }
  const crcs = catalog.games.flatMap((g) => g.crc32 || []);
  assert.equal(new Set(crcs).size, crcs.length, 'no dump twice');
});

test('Gen 3 FireRed/LeafGreen in German, French, Italian and Spanish: their own table entry, the English EWRAM layout', () => {
  for (const code of ['BPRD', 'BPRF', 'BPRI', 'BPRS', 'BPGD', 'BPGF', 'BPGI', 'BPGS']) {
    const e = findEntry(TABLE, { platform: 'gba', code });
    assert.equal(e?.id, code[2] === 'R' ? 'firered_eu' : 'leafgreen_eu', code);
    assert.ok(!e.scanOnly, code);
  }
  // the English ROMs keep theirs
  assert.equal(findEntry(TABLE, { platform: 'gba', code: 'BPGE' }).id, 'leafgreen_us');
  const us = findEntry(TABLE, { platform: 'gba', code: 'BPGE' });
  const de = findEntry(TABLE, { platform: 'gba', code: 'BPGD' }); // the issue's ROM: "POKEMON LEAF", BPGD
  // EWRAM as in the English game (pokebot-gen3 language patches, Ironmon-Tracker Feuerrote.json …)
  for (const k of ['partyCountAddr', 'partyAddr', 'enemyPartyAddr', 'battleTypeFlagsAddr']) assert.equal(de[k], us[k], k);
  assert.deepEqual(de.liveBattleHp.battleMonsAddr, us.liveBattleHp.battleMonsAddr);
  // IWRAM from gMain on 0xB0 lower: gMain 0x03003040 + 0x439
  assert.equal(de.inBattle.addr, '0x03003479');
  assert.equal(parseInt(us.inBattle.addr, 16) - parseInt(de.inBattle.addr, 16), 0xb0);
  assert.deepEqual([de.saveBlockPtrs.sb1, de.saveBlockPtrs.sb2], ['0x03004F58', '0x03004F5C']);
  // the party reads like the English one
  const m = memory();
  m.write(0x02024029, [1]);
  m.write(0x02024284, pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 1, nick: 'BISASAM', level: 5, hp: 20, maxHp: 21, met: 88 }));
  const r = readLiveParty(de, m.read, T);
  assert.deepEqual(r.party.map((x) => [x.species, x.nickname, x.level, x.hp, x.maxHp, x.metLocation]), [[1, 'BISASAM', 5, 20, 21, 88]]);
  assert.deepEqual(regionsFor(de), regionsFor(us));
});

test('Gen 3 PC boxes: a catch sent to the PC (full party) is read – FireRed/LeafGreen in every language, Emerald, Ruby/Sapphire', () => {
  const party = pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 1, nick: 'BISASAM', level: 5, hp: 20, maxHp: 21, met: 88 });
  const caught = pk3({ pid: 0x13572468, otId: 0xbeefcafe, internal: 19, nick: 'RATTFRATZ', level: 3, hp: 12, maxHp: 12, met: 89 }).subarray(0, 80);
  const traded = pk3({ pid: 0x2468ace1, otId: 0x12345678, internal: 16, nick: 'TAUBSI', level: 7, hp: 1, maxHp: 1, met: 90 }).subarray(0, 80);
  const pc = (at) => {
    const m = memory();
    m.write(at, [3]); // currentBox
    m.write(at + 4 + 3 * 30 * 80, caught); // box 4, slot 1
    m.write(at + 4 + (13 * 30 + 29) * 80, traded); // the last slot of box 14
    return m;
  };
  const cases = [
    // German LeafGreen (the issue's game): gPokemonStoragePtr 0x03004F60, right after the save block pointers
    { code: 'BPGD', ptr: 0x03004f60, at: 0x0202a000, count: 0x02024029, team: 0x02024284 },
    { code: 'BPRE', ptr: 0x03005010, at: 0x02029314, count: 0x02024029, team: 0x02024284 },
    { code: 'BPEE', ptr: 0x03005d94, at: 0x02029808, count: 0x020244e9, team: 0x020244ec },
    { code: 'AXPE', at: 0x020300a0, count: 0x03004350, team: 0x03004360 },
  ];
  for (const c of cases) {
    const e = findEntry(TABLE, { platform: 'gba', code: c.code });
    assert.equal(e.partyAddr.toLowerCase(), `0x${c.team.toString(16).padStart(8, '0')}`, c.code);
    const m = pc(c.at);
    if (c.ptr) m.write(c.ptr, [c.at & 0xff, (c.at >> 8) & 0xff, (c.at >> 16) & 0xff, c.at >>> 24]);
    m.write(c.count, [1]);
    m.write(c.team, party);
    const r = readLiveParty(e, m.read, T, {});
    assert.deepEqual(r.party.map((x) => x.nickname), ['BISASAM'], c.code);
    assert.deepEqual(r.boxes.map((x) => [x.species, x.nickname, x.box, x.slot, x.metLocation, x.metLevel, x.level, x.hp]), [
      [19, 'RATTFRATZ', 3, 0, 89, 5, null, null],
      [16, 'TAUBSI', 13, 29, 90, 5, null, null],
    ], c.code);
    // the same key as in the party: moving it to the team and back is the same Pokémon
    assert.equal(r.boxes[0].key, parsePk3(pk3({ pid: 0x13572468, otId: 0xbeefcafe, internal: 19, nick: 'RATTFRATZ', level: 3, hp: 12, maxHp: 12, met: 89 }), T).key);
  }
  // not a PC: no pointer, a pointer outside EWRAM, a block of failed checksums – "unknown" (null), never an empty PC
  const e = findEntry(TABLE, { platform: 'gba', code: 'BPRE' });
  const team = (m) => {
    m.write(0x02024029, [1]);
    m.write(0x02024284, party);
    return m;
  };
  assert.equal(readLiveParty(e, team(memory()).read, T, {}).boxes, undefined, 'no storage pointer');
  const out = team(memory());
  out.write(0x03005010, [0, 0, 0, 0x08]); // a ROM address
  assert.equal(readLiveParty(e, out.read, T, {}).boxes, undefined, 'pointer outside EWRAM');
  const junk = team(memory());
  junk.write(0x03005010, [0x14, 0x93, 0x02, 0x02]);
  junk.write(0x02029314 + 4, Uint8Array.from({ length: 30 * 80 }, (_, i) => (i * 37 + 11) & 0xff));
  assert.equal(readLiveParty(e, junk.read, T, {}).boxes, undefined, 'failed checksums everywhere');
  // an empty PC is an empty list (the pointer is right, the boxes are all zeros)
  const empty = team(memory());
  empty.write(0x03005010, [0x14, 0x93, 0x02, 0x02]);
  assert.deepEqual(readLiveParty(e, empty.read, T, {}).boxes, []);
  // the expanded engines keep their boxes their own way: not read
  const hack = team(pc(0x02029314));
  hack.write(0x03005010, [0x14, 0x93, 0x02, 0x02]);
  const rh = readLiveParty({ ...e, scan3: true, party3Base: { party: 0x02024284, count: 0x02024029 } }, hack.read, T, {});
  assert.deepEqual([rh.party.length, rh.boxes], [1, undefined]);
});

test('Gen 3 expanded engines (Run & Bun): the egg flag comes from the plain header, not from bit 30 of the IVs', () => {
  // Run & Bun keeps the IVs at bits 1–30: a starter with a high Sp. Def IV has bit 30 set – read the retail way it was
  // an egg, and every such Pokémon was left out of the run (never filed as the starter or a catch)
  const map = [0, 1, 2, 3];
  const RB = T.withSpecies({ engine: 'expanded', map, changed: 1 });
  const mon = (flags) => parsePk3(pk3({ pid: 0xa15dde71, otId: 0xdc7ca513, internal: 1, nick: 'BULBA', level: 5, hp: 20, maxHp: 20, met: 0xff, ivWord: 0x77e3f7fe, flags }), RB);
  assert.equal(mon(0b010).isEgg, false, 'hasSpecies only: a Pokémon, whatever bit 30 says');
  assert.equal(mon(0b110).isEgg, true, 'the header’s isEgg bit');
  // the retail games: bit 30 as before (SetBoxMonData keeps both copies in step there)
  const retail = (ivWord, flags) => parsePk3(pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 1, nick: 'BULBA', level: 5, hp: 20, maxHp: 20, met: 16, ivWord, flags }), T).isEgg;
  assert.equal(retail(0x40000000, 0b110), true);
  assert.equal(retail(0x3fffffff, 0b010), false);
});

test('Gen 3: gMain.inBattle as a plain flag (an expanded engine’s team search that finds nothing in a battle has failed)', async () => {
  const { inBattleFlag } = await import('../shared/live/parse.mjs');
  const em = findEntry(TABLE, { platform: 'gba', code: 'BPEE' });
  const m = memory();
  assert.equal(inBattleFlag(em, m.read), false);
  m.write(0x030026f9, [0x02]);
  assert.equal(inBattleFlag(em, m.read), true);
  assert.equal(inBattleFlag(findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' }), m.read), false, 'Gen 3 only');
  const de = findEntry(TABLE, { platform: 'gba', code: 'BPGD' });
  m.write(0x03003479, [0x02]);
  assert.equal(inBattleFlag(de, m.read), true, 'German LeafGreen: gMain 0xB0 lower');
});

test('Gen 4 (HeartGold): party via save-data pointer', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const m = memory();
  const base = 0x0227c218;
  m.write(0x02111880, [0x18, 0xc2, 0x27, 0x02]);
  const mon = new Uint8Array(236);
  const dv = new DataView(mon.buffer);
  dv.setUint32(0, 0xdeadbeef, true);
  dv.setUint16(0x08, 152, true);
  dv.setUint16(0x0c, 4242, true);
  dv.setUint16(0x46, 177, true);
  mon[0x8c] = 12;
  dv.setUint16(0x8e, 0, true);
  dv.setUint16(0x90, 33, true);
  m.write(base + 0xa0, [6, 0, 0, 0, 1, 0, 0, 0, ...encryptPK4(mon)]);
  const r = readLiveParty(e, m.read, T, {});
  assert.deepEqual(r.party.map((x) => [x.species, x.level, x.hp, x.maxHp, x.metLocation]), [[152, 12, 0, 33, 177]]);
});

test('Gen 1/2: a party read halfway through a rewrite (party menu swap) is torn, not a fainted mon', () => {
  // Red: HP sits in front of the OT ID/DVs, so a slot rewritten up to byte 0x0B carries the incoming mon's species
  // and HP under the old mon's key – B fainted, so A would read as dead.
  const e = findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' });
  const mon = (internal, hp, ot, dv) => {
    const d = new Uint8Array(44);
    d[0] = internal;
    d[2] = hp;
    d[0x0c] = ot >> 8; d[0x0d] = ot & 0xff;
    d[0x1b] = dv >> 8; d[0x1c] = dv & 0xff;
    d[0x21] = 7;
    d[0x23] = 30;
    return d;
  };
  const A = mon(0x99, 20, 0x1234, 0xabcd); // Bulbasaur
  const B = mon(0x24, 0, 0x1234, 0x5555); // Pidgey, fainted
  const m = memory();
  m.write(0xd163, [2, 0x99, 0x24, 0xff]);
  m.write(0xd16b, [...A, ...B]);
  const state = {};
  const first = readLiveParty(e, m.read, T, state);
  assert.deepEqual(first.party.map((x) => x.hp), [20, 0]);
  // the swap: species list first, then slot 0 gets B byte by byte – stopped after 0x0B
  m.write(0xd163, [2, 0x24, 0x99, 0xff]);
  m.write(0xd16b, [...B.subarray(0, 0x0c), ...A.subarray(0x0c)]);
  const torn = readLiveParty(e, m.read, T, state);
  assert.ok(!torn.party, 'a rewrite in progress is not reported');
  // done: B in slot 0, A in slot 1 – taken once it reads the same twice
  m.write(0xd16b, [...B, ...A]);
  assert.ok(readLiveParty(e, m.read, T, state).torn);
  const done = readLiveParty(e, m.read, T, state);
  assert.deepEqual(done.party.map((x) => [x.species, x.hp]), [[16, 0], [1, 20]]);
  assert.equal(done.party[1].key, first.party[0].key);
});

// Gen 4/5 GetMonData/SetMonData decrypt a party mon in place – the battle stats block first, then the box block –
// and encrypt it again afterwards, without setting the lock flags (pokeheartgold src/pokemon.c GetMonData:
// DECRYPT_PTY, DECRYPT_BOX). A read in that window passes the checksum (it covers only the box block) while the
// level/HP bytes are already plaintext – "decrypting" them again gave the partner's Riolu "Lv. 172" and a random
// HP bar.
function hgParty(plainMons) {
  const m = memory();
  const base = 0x0227c218;
  m.write(0x02111880, [0x18, 0xc2, 0x27, 0x02]);
  const write = (mons) => m.write(base + 0xa0, [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...x])]);
  write(plainMons.map((p) => encryptPK4(p)));
  return { m, write };
}
function plainPk4({ pid = 0x1234abcd, species = 447, level = 12, hp = 30, maxHp = 34, status = 0 } = {}) {
  const mon = new Uint8Array(236);
  const dv = new DataView(mon.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, 4242, true);
  dv.setUint16(0x46, 177, true);
  dv.setUint32(0x88, status, true);
  mon[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  for (let i = 0x92; i < 0x9c; i += 2) dv.setUint16(i, 20 + i, true);
  return mon;
}

test('Gen 4: a party mon read while the game has it decrypted (GetMonData) never shows a garbage level or HP', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  let pid = 0x1234abcd;
  for (let round = 0; round < 40; round++) {
    pid = (Math.imul(pid, 1103515245) + 12345) >>> 0;
    const plain = plainPk4({ pid });
    const enc = encryptPK4(plain);
    // k words of the battle-stats block are plaintext already (DECRYPT_PTY runs from the status word on); 50 = all of
    // it, the box block still encrypted (between DECRYPT_PTY and DECRYPT_BOX)
    for (let k = 1; k <= 50; k++) {
      const torn = enc.slice();
      torn.set(plain.subarray(136, 136 + k * 2), 136);
      const { m, write } = hgParty([plain]);
      write([torn]);
      const r = readLiveParty(e, m.read, T, {});
      for (const x of r?.party || []) {
        assert.deepEqual([x.level, x.hp, x.maxHp, x.status], [12, 30, 34, 0], `pid ${pid.toString(16)} k=${k}`);
      }
    }
  }
});

test('Gen 4: a level or max-HP change of a known mon counts once it reads the same twice', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const { m, write } = hgParty([plainPk4({ level: 12 })]);
  const state = {};
  assert.equal(readLiveParty(e, m.read, T, state).party[0].level, 12);
  write([encryptPK4(plainPk4({ level: 13, hp: 33, maxHp: 37 }))]); // a level-up …
  assert.ok(!readLiveParty(e, m.read, T, state).party, 'first sight of a new level waits one poll');
  assert.equal(readLiveParty(e, m.read, T, state).party[0].level, 13); // … taken on the next one
  // a one-off flicker is never taken
  write([encryptPK4(plainPk4({ level: 99, hp: 1, maxHp: 300 }))]);
  assert.ok(!readLiveParty(e, m.read, T, state).party);
  write([encryptPK4(plainPk4({ level: 13, hp: 33, maxHp: 37 }))]);
  assert.equal(readLiveParty(e, m.read, T, state).party[0].level, 13);
  // HP alone (healing, poison) is no level jump and shows at once
  write([encryptPK4(plainPk4({ level: 13, hp: 10, maxHp: 37, status: 8 }))]);
  assert.deepEqual(readLiveParty(e, m.read, T, state).party.map((x) => [x.hp, x.status]), [[10, 8]]);
});

test('Gen 4: a party read halfway through a swap in the party menu or a catch joining is rejected, never shown', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const A = encryptPK4(plainPk4({ pid: 0x11112222, species: 152, level: 9 }));
  const B = encryptPK4(plainPk4({ pid: 0x33334444, species: 16, level: 4, hp: 12, maxHp: 16 }));
  const truth = new Map([[0x11112222, [152, 9, 30, 34]], [0x33334444, [16, 4, 12, 16]]]);
  const { m, write } = hgParty([A, B]);
  let shown = 0;
  // swap: slot 0 ← B (4 bytes at a time), then slot 1 ← A
  const cur = [A.slice(), B.slice()];
  for (const [to, src] of [[0, B], [1, A]]) {
    for (let i = 0; i < 236; i += 4) {
      cur[to].set(src.subarray(i, i + 4), i);
      write(cur);
      const r = readLiveParty(e, m.read, T, {});
      for (const x of r?.party || []) assert.deepEqual([x.species, x.level, x.hp, x.maxHp], truth.get(x.pid), `slot ${to} byte ${i}`);
      if (r?.party) shown++;
      assert.ok(!r?.party || new Set(r.party.map((x) => x.pid)).size === r.party.length, 'the same mon twice');
    }
  }
  assert.ok(shown > 0);
});

test('Gen 3: a slot the party menu is swapping (plain level/HP/stats) is torn, not another mon’s numbers', () => {
  const e = findEntry(TABLE, { platform: 'gba', code: 'BPRE' });
  const a = pk3({ pid: 0x01020304, otId: 0x0a0b0c0d, internal: 1, nick: 'BULBA', level: 12, hp: 30, maxHp: 34, met: 1 });
  const b = pk3({ pid: 0x11223344, otId: 0x0a0b0c0d, internal: 16, nick: 'PIDGEY', level: 5, hp: 9, maxHp: 19, met: 2 });
  const m = memory();
  const count = Number(e.partyCountAddr), at = Number(e.partyAddr);
  m.write(count, [2]);
  const half = Uint8Array.from([...b.subarray(0, 80), ...a.subarray(80, 100)]); // b's box data, a's battle stats
  m.write(at, [...half, ...b]);
  const r = readLiveParty(e, m.read, T, {});
  assert.ok(!r?.party, 'the same mon twice is not a party');
  // later in the swap: Pidgey's box data with Bulbasaur's level and HP, next to Bulbasaur – a known mon's level
  // changes only once two reads agree
  const state = {};
  m.write(at, [...a, ...b]);
  assert.equal(readLiveParty(e, m.read, T, state).party.length, 2);
  m.write(at, [...half, ...a]);
  const r2 = readLiveParty(e, m.read, T, state);
  for (const x of r2?.party || []) assert.ok(x.species !== 16 || x.level === 5, 'Pidgey with Bulbasaur’s level');
});

// Clones: a cloning glitch leaves the same Pokémon twice in the team – one PID, every lasting detail alike. It used to
// stop live tracking ("a misread"), so the Platinum link recordings' teams were never read. Two Pokémon now, each with
// its own key; a misread – a swap in progress, another Pokémon's data under the same PID – still isn't taken.
test('clones, Gen 3 (FireRed): the same Pokémon twice is two Pokémon with keys of their own – once a second read shows it too', () => {
  const e = findEntry(TABLE, { platform: 'gba', code: 'BPRE' });
  const A = (hp = 20) => pk3({ pid: 0x12345677, otId: 0xbeefcafe, internal: 277, nick: 'TREECKO', level: 9, hp, maxHp: 28, met: 101 });
  const B = pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 16, nick: 'Birdy', level: 4, hp: 15, maxHp: 16, met: 101 });
  const m = memory();
  m.write(0x02024029, [3]);
  m.write(0x02024284, [...A(), ...A(), ...B]);
  const state = {};
  assert.ok(readLiveParty(e, m.read, T, state).torn, 'first sight of the same Pokémon twice: once more (a swap looks like that for a moment)');
  const r = readLiveParty(e, m.read, T, state);
  assert.deepEqual(r.party.map((x) => x.species), [252, 252, 16]);
  const [k1, k2, k3] = r.party.map((x) => x.key);
  assert.equal(k2, `${k1}~2`, 'the clone: a key of its own');
  assert.equal(k3, 'g3-0badf00d-beefcafe');
  assert.equal(r.party[0].pid, r.party[1].pid);
  // the clone faints (an untracked clone or not – only its own HP), then the team is reordered: each keeps its key
  m.write(0x02024284, [...A(20), ...A(0), ...B]);
  assert.deepEqual(readLiveParty(e, m.read, T, state).party.map((x) => [x.key, x.hp]), [[k1, 20], [k2, 0], [k3, 15]]);
  m.write(0x02024284, [...B, ...A(0), ...A(20)]);
  assert.deepEqual(readLiveParty(e, m.read, T, state).party.map((x) => [x.key, x.hp]), [[k3, 15], [k2, 0], [k1, 20]], 'the fainted one stays the clone');
  m.write(0x02024284, [...A(0), ...B, ...A(20)]);
  assert.deepEqual(readLiveParty(e, m.read, T, state).party.map((x) => [x.key, x.hp]), [[k2, 0], [k3, 15], [k1, 20]]);
  // one of them traded away: the other keeps its key; the team counts one less
  m.write(0x02024029, [2]);
  m.write(0x02024284, [...A(0), ...B]);
  assert.deepEqual(readLiveParty(e, m.read, T, state).party.map((x) => x.key), [k2, k3]);
});

test('clones, Gen 3: a swap in the party menu (one Pokémon shown twice for a read) and another Pokémon under the same PID are still no team', () => {
  const e = findEntry(TABLE, { platform: 'gba', code: 'BPRE' });
  const A = pk3({ pid: 0x12345677, otId: 0xbeefcafe, internal: 277, nick: 'TREECKO', level: 9, hp: 20, maxHp: 28, met: 101 });
  const B = pk3({ pid: 0x0badf00d, otId: 0xbeefcafe, internal: 16, nick: 'Birdy', level: 4, hp: 15, maxHp: 16, met: 101 });
  const m = memory();
  m.write(0x02024029, [2]);
  m.write(0x02024284, [...A, ...B]);
  const state = {};
  const before = readLiveParty(e, m.read, T, state);
  // the swap: slot 1 already holds A, slot 0 still too – for one read
  m.write(0x02024284, [...A, ...A]);
  assert.ok(readLiveParty(e, m.read, T, state).torn);
  m.write(0x02024284, [...B, ...A]);
  const after = readLiveParty(e, m.read, T, state);
  assert.deepEqual(after.party.map((x) => x.key), [before.party[1].key, before.party[0].key], 'no clone key handed out');
  // the same PID with another species, other met data: never two Pokémon
  const other = pk3({ pid: 0x12345677, otId: 0xbeefcafe, internal: 16, nick: 'Birdy', level: 4, hp: 15, maxHp: 16, met: 102 });
  m.write(0x02024284, [...A, ...other]);
  for (let i = 0; i < 4; i++) assert.ok(readLiveParty(e, m.read, T, state).torn, `read ${i + 1}`);
});

test('clones, Gen 1 (Red): the same Pokémon twice gets two keys; two others that only share trainer ID and DVs stay as they were', () => {
  const e = findEntry(TABLE, { platform: 'gb', title: 'POKEMON RED' });
  const mon = (internal, hp, ot, dv) => {
    const d = new Uint8Array(44);
    d[0] = internal;
    d[2] = hp;
    d[0x0c] = ot >> 8; d[0x0d] = ot & 0xff;
    d[0x1b] = dv >> 8; d[0x1c] = dv & 0xff;
    d[0x21] = 7;
    d[0x23] = 30;
    return d;
  };
  const A = mon(0x99, 20, 0x1234, 0xabcd); // Bulbasaur
  const m = memory();
  m.write(0xd163, [2, 0x99, 0x99, 0xff]);
  m.write(0xd16b, [...A, ...A]);
  const state = {};
  assert.ok(readLiveParty(e, m.read, T, state).torn);
  const r = readLiveParty(e, m.read, T, state);
  assert.deepEqual(r.party.map((x) => x.key), ['g1-1234-abcd', 'g1-1234-abcd~2']);
  // Bulbasaur and a Pidgey with the same trainer ID and DVs: no clones – as before
  const s2 = {};
  m.write(0xd163, [2, 0x99, 0x24, 0xff]);
  m.write(0xd16b, [...A, ...mon(0x24, 12, 0x1234, 0xabcd)]);
  assert.deepEqual(readLiveParty(e, m.read, T, s2).party.map((x) => x.key), ['g1-1234-abcd', 'g1-1234-abcd']);
});
