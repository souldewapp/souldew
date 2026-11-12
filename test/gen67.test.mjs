// Gen 6/7 (3DS) live party: PK6/PK7 crypto checked against real Pokémon files (PKHeX test data), the RAM slot layout,
// update versions, empty and stale slots, and the whole path the page takes (findEntry → regionsFor → readLiveParty).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { decryptPK6, encryptPK6, pk6Mon, slotBytes, partyFromRegion, readGen67, readGen67Battle, SLOT_STRIDE, STATS_OFFSET, BOX_SIZE, PARTY_BYTES } from '../shared/live/gen67.mjs';
import { findEntry, regionsFor, readLiveParty, regionReader, readLiveBattle } from '../shared/live/parse.mjs';
import { areaLabel } from '../shared/overlay.mjs';

const fixture = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/pk67/${f}`, import.meta.url)));
const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));
const loc6 = JSON.parse(readFileSync(new URL('../shared/data/locations_gen6.json', import.meta.url), 'utf8'));
const loc7 = JSON.parse(readFileSync(new URL('../shared/data/locations_gen7.json', import.meta.url), 'utf8'));

const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const w32 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};

/** A decrypted 260-byte party PK6/PK7 (checksum written by encryptPK6). */
function mon({ ec = 0x12345678, pid = 0xa1b2c3d4, species = 25, nick = 'Pika', level = 12, hp = 30, maxHp = 35, status = 0, tid = 12345, sid = 54321, met = 8, egg = false, form = 0, gender = 1 } = {}) {
  const d = new Uint8Array(BOX_SIZE + 0x1c);
  w32(d, 0, ec);
  w16(d, 0x08, species);
  w16(d, 0x0c, tid);
  w16(d, 0x0e, sid);
  w32(d, 0x18, pid);
  d[0x1d] = (form << 3) | (gender << 1);
  for (let i = 0; i < nick.length; i++) w16(d, 0x40 + i * 2, nick.charCodeAt(i));
  w16(d, 0x5a, 84);
  w16(d, 0x5c, 45);
  w32(d, 0x74, egg ? 0x40000000 : 0);
  w16(d, 0xda, met);
  d[0xdd] = 5;
  w32(d, 0xe8, status);
  d[0xec] = level;
  w16(d, 0xf0, hp);
  w16(d, 0xf2, maxHp);
  for (let o = 0xf4; o < 0xfe; o += 2) w16(d, o, 20);
  return d;
}

/** Six RAM slots (0x1E4 apart): encrypted box data at +0, encrypted party stats at +0x158. */
function ramParty(mons) {
  const r = new Uint8Array(PARTY_BYTES);
  mons.forEach((m, i) => {
    const e = encryptPK6(m);
    r.set(e.subarray(0, BOX_SIZE), i * SLOT_STRIDE);
    r.set(e.subarray(BOX_SIZE), i * SLOT_STRIDE + STATS_OFFSET);
  });
  return r;
}

test('real PK6/PK7 files (PKHeX test data): checksum, species, nickname, met location and level, form', () => {
  const expect = {
    'spewpa-route7.pk6': { species: 665, nick: 'Spewpa', met: 38, metLevel: 14, form: 17, place: loc6.map['38'].en },
    'zigzagoon.pk6': { species: 263, nick: 'Zigzagoon', met: 206, metLevel: 3, form: 0, place: loc6.map['206'].en },
    'scatterbug.pk7': { species: 664, nick: 'Scatterbug', met: 20, metLevel: 9, form: 7, place: loc7.map['20'].en },
    'jynx-lola.pk7': { species: 124, nick: 'LOLA', met: 30013, metLevel: 29, form: 0, place: loc7.map['30013'].en },
  };
  assert.deepEqual(readdirSync(new URL('./fixtures/pk67/', import.meta.url)).filter((f) => /\.pk[67]$/.test(f)).sort(), Object.keys(expect).sort());
  for (const [file, e] of Object.entries(expect)) {
    const plain = fixture(file);
    // the game's own checksum matches ours on the decrypted data: encrypt → decrypt is the identity
    const enc = encryptPK6(plain);
    assert.notDeepEqual(enc.subarray(8, 64), plain.subarray(8, 64), `${file} is really encrypted`);
    const { data, checksumOk } = decryptPK6(enc);
    assert.ok(checksumOk, file);
    assert.deepEqual(data, plain, file);
    // a party mon: give it party stats and read it like the live reader does
    const party = new Uint8Array(BOX_SIZE + 0x1c);
    party.set(plain.subarray(0, BOX_SIZE));
    party[0xec] = 30;
    w16(party, 0xf0, 40);
    w16(party, 0xf2, 50);
    const m = pk6Mon(encryptPK6(party), file.endsWith('7') ? 7 : 6);
    assert.equal(m.species, e.species, file);
    assert.equal(m.nickname, e.nick, file);
    assert.equal(m.metLocation, e.met, file);
    assert.equal(m.metLevel, e.metLevel, file);
    assert.equal(m.form, e.form, file);
    assert.ok(e.place, `${file}: met location ${e.met} has a name`);
  }
  // the file names say where they were caught
  assert.equal(expect['spewpa-route7.pk6'].place, 'Route 7');
  assert.equal(expect['jynx-lola.pk7'].place, 'the Kanto region'); // moved over from the Virtual Console Red/Blue/Yellow
});

test('pk6Mon: the 3DS games\' status numbers become the app\'s status codes (a paralysed mon read 1 in Ultra Sun)', () => {
  const st = (status) => pk6Mon(encryptPK6(mon({ status })), 7).status;
  assert.equal(st(0), 0);
  assert.equal(st(1), 0x40); // paralysis – read as "asleep" before
  assert.equal(st(2), 1); // sleep
  assert.equal(st(3), 0x20); // freeze
  assert.equal(st(4), 0x10); // burn
  assert.equal(st(5), 0x08); // poison
  assert.equal(st(0x40), 0x40); // a Gen 3–5 flag value is still read as such
});

test('pk6Mon: fields, shiny, gender signs, and what it rejects', () => {
  const m = pk6Mon(encryptPK6(mon({ nick: 'Nidoran', level: 7, hp: 0, maxHp: 22, status: 0x08, met: 8 })), 6);
  assert.equal(m.nickname, 'Nidoran♀');
  assert.equal(m.species, 25);
  assert.equal(m.level, 7);
  assert.equal(m.hp, 0);
  assert.equal(m.status, 0x08);
  assert.equal(m.gender, 'F');
  assert.equal(m.metLocation, 8);
  assert.deepEqual(m.moves, [84, 45]);
  assert.equal(m.key, `a1b2c3d4-12345-54321`);
  assert.equal(m.shiny, false);
  // Gen 6+: shiny below 16 (Gen 3–5: below 8)
  const pid = ((12345 ^ 54321 ^ 0xc3d4 ^ 12) << 16 | 0xc3d4) >>> 0;
  assert.equal(pk6Mon(encryptPK6(mon({ pid })), 6).shiny, true);
  const bad = encryptPK6(mon());
  bad[0x20] ^= 1; // one flipped bit in the box data
  assert.equal(pk6Mon(bad, 6), null);
  assert.equal(pk6Mon(encryptPK6(mon({ species: 800 })), 6), null, 'Gen 7 species in a Gen 6 game');
  assert.equal(pk6Mon(encryptPK6(mon({ species: 800 })), 7).species, 800);
  assert.equal(pk6Mon(encryptPK6(mon({ level: 0 })), 6), null);
  assert.equal(pk6Mon(encryptPK6(mon({ hp: 40, maxHp: 35 })), 6), null);
  assert.equal(pk6Mon(encryptPK6(mon({ status: 0x1234 })), 6), null);
  assert.equal(pk6Mon(encryptPK6(mon({ egg: true, level: 1, hp: 0, maxHp: 0 })), 6).isEgg, true);
});

test('the RAM party: slots in order, empty and stale slots end it, a swap in progress is no party', () => {
  const a = mon({ ec: 1, pid: 11, species: 650, nick: 'Chespin' });
  const b = mon({ ec: 2, pid: 22, species: 661, nick: 'Fletchling' });
  const c = mon({ ec: 3, pid: 33, species: 659, nick: 'Bunnelby' });
  const ram = ramParty([a, b, c]);
  assert.deepEqual(partyFromRegion(ram, 6).map((m) => m.nickname), ['Chespin', 'Fletchling', 'Bunnelby']);
  assert.deepEqual(slotBytes(ram, 1).subarray(0, BOX_SIZE), encryptPK6(b).subarray(0, BOX_SIZE));
  // blank slots (the games' "empty" Pokémon: all zero, encrypted) end the party as well
  const blank = ramParty([a, b, new Uint8Array(BOX_SIZE + 0x1c)]);
  assert.equal(partyFromRegion(blank, 6).length, 2);
  // what a deposited Pokémon left behind, half overwritten: the party ends there
  const stale = ramParty([a, b, c]);
  stale.fill(0x77, 2 * SLOT_STRIDE + 40, 2 * SLOT_STRIDE + 80);
  assert.equal(partyFromRegion(stale, 6).length, 2);
  // slot 0 not a Pokémon (title screen, another update's address): no party
  assert.equal(partyFromRegion(new Uint8Array(PARTY_BYTES), 6), null);
  assert.equal(partyFromRegion(ramParty([mon({ status: 0xffff })]), 6), null);
  // the same Pokémon twice: read while the party menu swaps two slots
  assert.equal(partyFromRegion(ramParty([a, a]), 6), null);
  assert.equal(partyFromRegion(ram.subarray(0, 100), 6), null);
});

test('addresses: the four 3DS entries, found by title ID or game code, every update version read', () => {
  const ctr = addresses.games.filter((g) => g.platform === '3ds');
  assert.deepEqual(ctr.map((g) => [g.id, g.gen]), [['xy', 6], ['oras', 6], ['sm', 7], ['usum', 7]]);
  assert.equal(findEntry(addresses, { platform: '3ds', titleId: '0004000000055E00' }).id, 'xy');
  assert.equal(findEntry(addresses, { platform: '3ds', titleId: '000400000011c400' }).id, 'oras');
  assert.equal(findEntry(addresses, { platform: '3ds', code: 'A2BA' }).id, 'usum');
  assert.equal(findEntry(addresses, { platform: '3ds', titleId: '0004000000099999' }), null);
  // XY and ORAS: the 1.0 cartridge and the last update keep the party (and the badges) in different places, moved by
  // the same distance – three trackers agree on these
  const xy = ctr[0].partyAddrs;
  assert.equal(parseInt(xy[0].addr, 16) - parseInt(xy[1].addr, 16), parseInt(xy[0].badges, 16) - parseInt(xy[1].badges, 16));
  const oras = ctr[1].partyAddrs;
  assert.equal(parseInt(oras[0].addr, 16) - parseInt(oras[1].addr, 16), parseInt(oras[0].badges, 16) - parseInt(oras[1].badges, 16));
  const regions = regionsFor(ctr[0]);
  assert.deepEqual(regions.map((r) => [r.name, r.len]), [['party', PARTY_BYTES], ['party', PARTY_BYTES], ['badges', 1], ['badges', 1], ['battle', 580 * 12], ['battle', 580 * 12], ['zone', 2]]);
  assert.ok(regions.every((r) => r.len <= 32 * 1024), 'each region is one RPC request');
  assert.ok(regions.length <= 16, 'the 3DS host watches at most 16 regions');
  // Gen 7: one battle base and the two flags
  assert.deepEqual(regionsFor(ctr[2]).filter((r) => r.name.startsWith('battle')).map((r) => r.len), [816 * 24, 1, 1]);
});

/** A memory reader over { address: bytes }. */
const memory = (map) => (addr, len) => {
  for (const [a, b] of Object.entries(map)) {
    const at = addr - Number(a);
    if (at >= 0 && at + len <= b.length) return b.subarray(at, at + len);
  }
  return null;
};

test('readGen67: the update the game runs is found and kept; badges; a shrinking party is confirmed first', () => {
  const xy = addresses.games.find((g) => g.id === 'xy');
  const a = mon({ ec: 1, pid: 11, species: 650, nick: 'Chespin', level: 9 });
  const b = mon({ ec: 2, pid: 22, species: 661, nick: 'Fletchling' });
  // cartridge 1.0: the 1.5 address is only 0x10 further on – it reads this party shifted, which isn't one
  const state = {};
  const ram = new Uint8Array(PARTY_BYTES + 0x100);
  ram.set(ramParty([a, b]));
  const mem = { 0x08ce1ce8: ram, 0x08c6a6a0: Uint8Array.of(0b111) };
  const r = readGen67(xy, memory(mem), state);
  assert.equal(r.version, '1.0');
  assert.equal(r.badges, 3);
  assert.equal(r.party.length, 2);
  assert.equal(state.g67, 1);
  // one Pokémon deposited: the first read with fewer is held back, the second one counts
  ram.set(ramParty([a]));
  assert.equal(readGen67(xy, memory(mem), state), null);
  assert.equal(readGen67(xy, memory(mem), state).party.length, 1);
  // updated to 1.5
  const s2 = {};
  const r2 = readGen67(xy, memory({ 0x08ce1cf8: ramParty([b]), 0x08c6a6b0: Uint8Array.of(0xff) }), s2);
  assert.equal(r2.version, '1.5');
  assert.equal(r2.badges, 8);
  // nothing there (title screen): null
  assert.equal(readGen67(xy, memory({}), {}), null);
});

test('Bad Eggs: a slot failing its checksum with the very same bytes is skipped after a few reads – the team behind it stays', () => {
  const xy = addresses.games.find((g) => g.id === 'xy');
  const a = mon({ ec: 1, pid: 11, species: 650, nick: 'Chespin' });
  const b = mon({ ec: 2, pid: 22, species: 661, nick: 'Fletchling' });
  const c = mon({ ec: 3, pid: 33, species: 659, nick: 'Bunnelby' });
  const egg = (r, slot) => {
    r[slot * SLOT_STRIDE + 0x30] ^= 0x5a; // a damaged byte in the box data: the checksum fails
    return r;
  };
  // in the middle: first read as the party's end (a write in progress), then skipped
  const mid = egg(ramParty([a, b, c]), 1);
  const s1 = {};
  const reads = [];
  for (let i = 0; i < 4; i++) reads.push(readGen67(xy, memory({ 0x08ce1ce8: mid }), s1)?.party.map((m) => m.nickname) || null);
  assert.deepEqual(reads.at(-1), ['Chespin', 'Bunnelby']);
  // in slot 0: no team at first, then the team without it
  const first = egg(ramParty([a, b, c]), 0);
  const s2 = {};
  for (let i = 0; i < 2; i++) assert.equal(readGen67(xy, memory({ 0x08ce1ce8: first }), s2), null);
  assert.deepEqual(readGen67(xy, memory({ 0x08ce1ce8: first }), s2).party.map((m) => m.nickname), ['Fletchling', 'Bunnelby']);
  // bytes that change between reads are a write in progress, never a Bad Egg
  const s3 = {};
  for (let i = 0; i < 5; i++) {
    const r = ramParty([a, b, c]);
    r[1 * SLOT_STRIDE + 0x30] ^= i + 1;
    assert.equal(partyFromRegion(r, 6, (s3.bad ||= {})).length, 1);
  }
  // only garbage that never changes (another update's address): no party, however often it is read
  const junk = new Uint8Array(PARTY_BYTES).fill(0x3c);
  const s4 = {};
  for (let i = 0; i < 5; i++) assert.equal(readGen67(xy, memory({ 0x08ce1ce8: junk }), s4), null);
});

test('the page\'s path: Azahar regions → regionReader → readLiveParty; outside battle no battle panel', () => {
  const sm = findEntry(addresses, { platform: '3ds', titleId: '0004000000164800' });
  const party = ramParty([mon({ species: 722, nick: 'Rowlet', level: 5, hp: 20, maxHp: 20, met: 6 })]);
  const regions = regionsFor(sm).map((rg) => ({ ...rg, hex: Buffer.from(rg.addr === 0x34195e10 ? party : new Uint8Array(rg.len)).toString('hex') }));
  const res = readLiveParty(sm, regionReader(regions), null, {});
  assert.equal(res.party[0].nickname, 'Rowlet');
  assert.equal(res.party[0].species, 722);
  assert.equal(res.party[0].metLocation, 6);
  assert.equal(loc7.map['6'].en, 'Route 1');
  assert.equal(readLiveBattle(sm, regionReader(regions), null, {}, res.party), null);
});

test('location tables: places only on even ids, link trades / events / eggs in their banks, German names', () => {
  for (const L of [loc6, loc7]) {
    const ids = Object.keys(L.map).map(Number);
    assert.ok(ids.filter((i) => i < 30000).every((i) => i % 2 === 0), 'odd lines are the subtitle of the place before');
    assert.equal(L.map['30002'].en, 'a Link Trade');
    assert.ok(L.map['60002'], 'eggs from the Day Care / Nursery');
  }
  assert.equal(loc6.map['6'].en, 'Vaniville Town');
  assert.equal(loc6.map['6'].de, 'Escissia');
  assert.equal(loc6.map['170'].en, 'Littleroot Town'); // ORAS's Hoenn starts at 170
  assert.equal(loc6.map['170'].de, 'Wurzelheim');
});

test('stream overlay: Gen 6/7 catch areas by their met location, in the overlay\'s language', () => {
  const tables = { loc6, loc7 };
  assert.equal(areaLabel('m6-10', { tables, lang: 'de' }), 'Aquarellia');
  assert.equal(areaLabel('m6-12', { tables, lang: 'de' }), 'Route 2');
  assert.equal(areaLabel('m7-6', { tables, lang: 'en' }), 'Route 1');
  assert.equal(areaLabel('m6-99999', { tables }), 'm6-99999');
});

/** A battle block as Omega Ruby keeps it (unencrypted): species, max HP, HP, level, battle slot. */
function battleBlock(b, at, { species, maxHp, hp, level, slot }) {
  w16(b, at + 4, species);
  w16(b, at + 6, maxHp);
  w16(b, at + 8, hp);
  b[at + 0x10] = level;
  b[at + 0x11] = slot;
}

test('battles (Gen 6): the wild or trainer base with both sides – what Omega Ruby showed live (Torchic 17/20 vs Poochyena 10/15)', () => {
  const oras = addresses.games.find((g) => g.id === 'oras');
  const party = [{ species: 255, level: 5, maxHp: 20, hp: 20 }];
  const wild = new Uint8Array(580 * 12);
  battleBlock(wild, 0, { species: 255, maxHp: 20, hp: 17, level: 5, slot: 0 });
  battleBlock(wild, 580, { species: 261, maxHp: 15, hp: 10, level: 3, slot: 12 });
  const b = readGen67Battle(oras, memory({ 0x082041fc: wild }), party);
  assert.deepEqual(b, { kind: 'wild', enemy: { species: 261, level: 3, hp: 10, maxHp: 15 }, active: { index: 0, hp: 17, maxHp: 20 } });
  // a trainer battle lives at the other base
  const t = readGen67Battle(oras, memory({ 0x08205d0c: wild }), party);
  assert.equal(t.kind, 'trainer');
  // after the battle the base is cleared: no battle; one side only is no battle either
  assert.equal(readGen67Battle(oras, memory({ 0x082041fc: new Uint8Array(580 * 12) }), party), null);
  const half = new Uint8Array(580 * 12);
  battleBlock(half, 0, { species: 255, maxHp: 20, hp: 17, level: 5, slot: 0 });
  assert.equal(readGen67Battle(oras, memory({ 0x082041fc: half }), party), null);
  // a fainted lead foe: the next one standing is shown
  battleBlock(wild, 1160, { species: 263, maxHp: 12, hp: 12, level: 2, slot: 13 });
  w16(wild, 580 + 8, 0);
  assert.equal(readGen67Battle(oras, memory({ 0x082041fc: wild }), party).enemy.species, 263);
});

test('battles (Gen 7): the opponents after the player\'s 12 battlers, the in-battle and battle-type flags decide – Ultra Sun as seen live', () => {
  const usum = addresses.games.find((g) => g.id === 'usum');
  // Rowlet L5 23/23 at battler 0, the wild Yungoos L3 16/16 at battler 12 (slot 12) – what Ultra Sun 1.0 had in memory
  const blocks = new Uint8Array(816 * 24);
  battleBlock(blocks, 0, { species: 722, maxHp: 23, hp: 23, level: 5, slot: 0 });
  battleBlock(blocks, 816 * 12, { species: 734, maxHp: 16, hp: 16, level: 3, slot: 12 });
  const mem = { 0x30002770: blocks, 0x33fc1f65: Uint8Array.of(1), 0x33fc1f44: Uint8Array.of(0) };
  assert.deepEqual(readGen67Battle(usum, memory(mem), [{ species: 722, level: 5, maxHp: 23 }]),
    { kind: 'wild', enemy: { species: 734, level: 3, hp: 16, maxHp: 16 }, active: { index: 0, hp: 23, maxHp: 23 } });
  // Hau's Popplio: the type byte is 1 from the trainer's cutscene on
  mem[0x33fc1f44] = Uint8Array.of(1);
  assert.equal(readGen67Battle(usum, memory(mem), null).kind, 'trainer');
  mem[0x33fc1f65] = Uint8Array.of(0); // over – the battle memory may still be there
  assert.equal(readGen67Battle(usum, memory(mem), null), null);
  // Sun/Moon: the same layout at their flags
  const sm = addresses.games.find((g) => g.id === 'sm');
  assert.equal(readGen67Battle(sm, memory({ 0x30002770: blocks, 0x341c8ccd: Uint8Array.of(1), 0x341c8cac: Uint8Array.of(0) }), null).kind, 'wild');
});

test('the place sign (Gen 7): the zone in the player\'s position, both game pairs', () => {
  const usum = addresses.games.find((g) => g.id === 'usum');
  const sm = addresses.games.find((g) => g.id === 'sm');
  assert.equal(usum.zoneAddr, '0x33F6D74A');
  assert.equal(sm.zoneAddr, '0x34183CC6');
  assert.ok(regionsFor(usum).some((r) => r.name === 'zone' && r.addr === 0x33f6d74a && r.len === 2));
});
