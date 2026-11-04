import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decryptPK4, encryptPK4, writeFooters, parseHgssSave, crc16ccitt, SAVE_LAYOUT } from '../shared/gen4save.mjs';

const data = JSON.parse(readFileSync(new URL('../shared/data/gen4.json', import.meta.url)));
const inv = Object.fromEntries(Object.entries(data.chars).map(([k, v]) => [v, Number(k)]));
const w16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const w32 = (b, o, v) => { w16(b, o, v & 0xffff); w16(b, o + 2, v >>> 16); };
const str = (b, o, s, max) => { [...s].forEach((c, i) => w16(b, o + i * 2, inv[c])); w16(b, o + s.length * 2, 0xffff); };

function makeMon({ pid, species, nick, met, level, hp, party = true }) {
  const m = new Uint8Array(party ? 236 : 136);
  w32(m, 0, pid);
  w16(m, 0x08, species);
  w16(m, 0x0c, 12345);
  w16(m, 0x0e, 54321);
  w32(m, 0x10, 1000);
  w16(m, 0x28, 33);
  w32(m, 0x38, (31 << 0) | (1 << 31));
  str(m, 0x48, nick, 11);
  str(m, 0x68, 'Lou', 8);
  w16(m, 0x46, met);
  w16(m, 0x80, 3002);
  m[0x84] = 4;
  m[0x86] = 4;
  if (party) { m[0x8c] = level; w16(m, 0x8e, hp); w16(m, 0x90, 20); }
  return m;
}

test('PK4 encrypt/decrypt round-trip for every block order', () => {
  for (let sv = 0; sv < 32; sv++) {
    const plain = makeMon({ pid: (sv << 13) | 0x1234, species: 25, nick: 'Pika', met: 177, level: 5, hp: 20 });
    let sum = 0; for (let i = 8; i < 136; i += 2) sum = (sum + (plain[i] | (plain[i + 1] << 8))) & 0xffff;
    w16(plain, 6, sum);
    const { data: back, checksumOk } = decryptPK4(encryptPK4(plain));
    assert.ok(checksumOk);
    assert.deepEqual([...back], [...plain]);
  }
});

test('CRC16-CCITT-FALSE check value', () => {
  assert.equal(crc16ccitt(new TextEncoder().encode('123456789'), 0, 9), 0x29b1);
});

test('parses party, boxes, badges and picks the newest partition', () => {
  const sav = new Uint8Array(0x80000);
  const L = SAVE_LAYOUT;
  // Older save in partition A with one mon, newer in B with two.
  for (const [p, count, mons] of [[0, 4, 1], [0x40000, 5, 2]]) {
    str(sav, p + 0x64, 'Lou', 8);
    w16(sav, p + 0x74, 12345);
    sav[p + 0x7e] = 0b00000111; // 3 Johto badges
    w32(sav, p + L.PARTY_COUNT, mons);
    sav.set(encryptPK4(makeMon({ pid: 0xdeadbeef, species: 152, nick: 'Chiko', met: 126, level: 7, hp: 0 })), p + L.PARTY_OFFSET);
    if (mons > 1) sav.set(encryptPK4(makeMon({ pid: 0x0badf00d, species: 16, nick: 'Pidgey', met: 177, level: 3, hp: 12 })), p + L.PARTY_OFFSET + 236);
    sav.set(encryptPK4(makeMon({ pid: 0x11112222, species: 19, nick: 'Ratti', met: 178, party: false })), p + L.STORAGE_START + 0x1000 + 136 * 2);
    writeFooters(sav, p, count);
  }
  const s = parseHgssSave(sav, data);
  assert.equal(s.counter, 5);
  assert.equal(s.trainer.name, 'Lou');
  assert.equal(s.badges.count, 3);
  assert.equal(s.party.length, 2);
  assert.equal(s.party[0].speciesName, 'Chikorita');
  assert.equal(s.party[0].nickname, 'Chiko');
  assert.equal(s.party[0].hp, 0);
  assert.equal(s.party[0].metLocation, 126);
  assert.equal(s.party[1].level, 3);
  assert.equal(s.boxes.length, 1);
  assert.equal(s.boxes[0].box, 1);
  assert.equal(s.boxes[0].slot, 2);
  assert.equal(s.boxes[0].speciesName, 'Rattata');
});

test('corrupt newest partition falls back to the older one', () => {
  const sav = new Uint8Array(0x80000);
  for (const [p, count] of [[0, 1], [0x40000, 2]]) {
    w32(sav, p + SAVE_LAYOUT.PARTY_COUNT, 0);
    writeFooters(sav, p, count);
  }
  sav[0x40000 + 0x100] ^= 0xff; // break CRC of partition B general block
  assert.equal(parseHgssSave(sav, data).counter, 1);
});

test('moveToGraveyard moves a party mon into the last box and keeps the save valid', async () => {
  const { moveToGraveyard } = await import('../shared/gen4save.mjs');
  const sav = new Uint8Array(0x80000);
  const p = 0x40000;
  w32(sav, p + SAVE_LAYOUT.PARTY_COUNT, 3);
  const mons = [
    makeMon({ pid: 0x11111111, species: 152, nick: 'Eins', met: 126, level: 9, hp: 20 }),
    makeMon({ pid: 0x22222222, species: 16, nick: 'Zwei', met: 177, level: 8, hp: 0 }),
    makeMon({ pid: 0x33333333, species: 19, nick: 'Drei', met: 178, level: 7, hp: 5 }),
  ];
  mons.forEach((m, i) => sav.set(encryptPK4(m), p + SAVE_LAYOUT.PARTY_OFFSET + i * 236));
  writeFooters(sav, p, 9);
  const before = parseHgssSave(sav, data);
  const dead = before.party[1].key;
  const { file, moved } = moveToGraveyard(sav, [dead]);
  assert.deepEqual(moved, [dead]);
  const after = parseHgssSave(file, data);
  assert.equal(after.counter, 9);
  assert.equal(after.coherent, true);
  assert.deepEqual(after.party.map((m) => m.nickname), ['Eins', 'Drei']);
  assert.equal(after.boxes.length, 1);
  assert.equal(after.boxes[0].box, 17);
  assert.equal(after.boxes[0].key, dead);
  assert.equal(after.boxes[0].nickname, 'Zwei');
  assert.ok(after.boxes[0].checksumOk);
  assert.throws(() => moveToGraveyard(file, after.party.map((m) => m.key)), /leer/);
});

test('a save DeSmuME cut after the last written byte (256 KB + 1, first partition only) still parses', () => {
  const sav = new Uint8Array(0x80000).fill(0xff);
  const L = SAVE_LAYOUT;
  sav.fill(0, 0, 0x40000);
  str(sav, 0x64, 'Lou', 8);
  w32(sav, L.PARTY_COUNT, 1);
  sav.set(encryptPK4(makeMon({ pid: 0xdeadbeef, species: 152, nick: 'Chiko', met: 126, level: 7, hp: 20 })), L.PARTY_OFFSET);
  writeFooters(sav, 0, 3);
  const cut = sav.slice(0, 0x40001);
  const s = parseHgssSave(cut, data);
  assert.equal(s.counter, 3);
  assert.equal(s.trainer.name, 'Lou');
  assert.equal(s.party.length, 1);
  assert.throws(() => parseHgssSave(sav.slice(0, 0x20000), data), /zu klein/);
});
