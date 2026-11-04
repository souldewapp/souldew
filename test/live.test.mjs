import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findEntry, readLiveParty, LiveTables, regionsFor, regionReader, parsePk3 } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';

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

function pk3({ pid, otId, internal, nick, level, hp, maxHp, met }) {
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
