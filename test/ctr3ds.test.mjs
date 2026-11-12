// Nintendo 3DS in souldew's own player: the zone tables read from the game's RomFS (the place sign), the host's
// message framing and the commands a page may send, the in-game save fingerprint, the place reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { familyOf, romfsFile, garcFile, lz11, ctrZonePlaces } from '../shared/live/ctrzones.mjs';
import { readLocation, locationLabel, canReadLocation } from '../shared/live/location.mjs';
import { cciWithRomfs, garc, lz11Literal } from './fixtures/ctr.mjs';
import { romFeatures } from '../shared/live/features.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-ctr3ds-'));
process.env.SLS_DATA_DIR = DATA;
const { splitMessages, command, checkCommands, saveStamp, CMD, MSG } = await import('../server/lib/ctr.mjs');
const { ctrData, romDataFor } = await import('../server/lib/romloc.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const maps = json('maps.json');
const addresses = json('addresses.json');
const reader = (u8) => (o, n) => (o >= u8.length ? new Uint8Array(0) : u8.subarray(o, Math.min(u8.length, o + n)));

/** A Gen 6 zone table: 56 bytes per zone, the place at +0x1C (9 bits; bit 9+ belongs to another field). */
function table6(places) {
  const b = new Uint8Array(places.length * 56);
  places.forEach((p, i) => {
    b[i * 56 + 0x1c] = p & 0xff;
    b[i * 56 + 0x1d] = (p >> 8) | 0xfe; // the other bits set: only bit 0 is the place's
  });
  return b;
}
/** A Gen 7 zone table: 0x54 bytes per zone, the place a u32 at +0x1C. */
function table7(places) {
  const b = new Uint8Array(places.length * 0x54);
  const v = new DataView(b.buffer);
  places.forEach((p, i) => v.setUint32(i * 0x54 + 0x1c, p, true));
  return b;
}

test('game families: product codes and title IDs of all eight games', () => {
  assert.equal(familyOf({ code: 'EKJA' }), 'xy');
  assert.equal(familyOf({ code: 'ecla' }), 'oras');
  assert.equal(familyOf({ titleId: '0004000000164800' }), 'sm');
  assert.equal(familyOf({ titleId: '00040000001b5100' }), 'usum');
  assert.equal(familyOf({ code: 'ABCD' }), null);
  assert.equal(familyOf(), null);
});

test('LZ11: literals, short and long back references; broken data is no table', () => {
  assert.deepEqual([...lz11(lz11Literal(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9)))], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // "abc" + a 6-byte copy 3 back
  assert.equal(Buffer.from(lz11(Uint8Array.of(0x11, 9, 0, 0, 0x10, 97, 98, 99, 0x50, 0x02))).toString(), 'abcabcabc');
  // one literal + a 0x11..0x110 copy (b0 >> 4 == 0): 0x20 zeros
  const long = lz11(Uint8Array.of(0x11, 0x21, 0, 0, 0x40, 0, 0x00, 0xf0, 0x00));
  assert.equal(long.length, 0x21);
  assert.ok(long.every((x) => x === 0));
  // a copy from before the start, a truncated stream
  assert.equal(lz11(Uint8Array.of(0x11, 4, 0, 0, 0x80, 0x30, 0x05)), null);
  assert.equal(lz11(Uint8Array.of(0x11, 9, 0, 0, 0x00, 1, 2)), null);
  // a back reference cut off after its first byte: damaged, not "zeros"
  assert.equal(lz11(Uint8Array.of(0x11, 6, 0, 0, 0x40, 97, 0x10)), null);
  // not LZ11: as it is
  const raw = Uint8Array.of(5, 6, 7);
  assert.equal(lz11(raw), raw);
});

test('Omega Ruby: the zone table is the encounter GARC\'s second-to-last file – zone → place, 9 bits', () => {
  const places = [0, 170, 204, 300, 170];
  const rom = cciWithRomfs({}, { 'a/0/1/2': garc([Uint8Array.of(1)]), 'a/0/1/3': garc([new Uint8Array(40), new Uint8Array(40), table6(places), new Uint8Array(1234)]), 'a/0/7/7': garc([Uint8Array.of(9)]) });
  const read = reader(rom);
  const f = romfsFile(read, 'a/0/1/3');
  assert.ok(f && f.size > 0);
  assert.equal(romfsFile(read, 'a/0/1/9'), null);
  assert.equal(romfsFile(read, 'a/9/1/3'), null);
  assert.equal(garcFile(read, f.offset, -1).length, 1234);
  assert.equal(garcFile(read, f.offset, 9), null);
  assert.deepEqual(ctrZonePlaces(read, { code: 'ECRA' }), { family: 'oras', gen: 6, places });
  // X/Y keep it last
  const xy = cciWithRomfs({ productCode: 'CTR-P-EKJA', titleId: '0004000000055D00' }, { 'a/0/1/2': garc([new Uint8Array(40), table6([0, 6, 6])]) });
  assert.deepEqual(ctrZonePlaces(reader(xy), { code: 'EKJA' }).places, [0, 6, 6]);
});

test('Sun/Moon, Ultra Sun/Ultra Moon: the zone GARC\'s first file, LZ11-packed, place as u32', () => {
  const places = [0, 24, 230, 6];
  const rom = cciWithRomfs({ productCode: 'CTR-P-A2AA', titleId: '00040000001B5000' }, { 'a/0/7/7': garc([lz11Literal(table7(places)), Uint8Array.of(1)]) });
  assert.deepEqual(ctrZonePlaces(reader(rom), { titleId: '00040000001B5000' }), { family: 'usum', gen: 7, places });
});

test('Omega Ruby: the second-to-last file first – a last file whose size fits 56-byte zones doesn\'t stand in for it', () => {
  const places = [0, 170, 204];
  const rom = cciWithRomfs({}, { 'a/0/1/3': garc([new Uint8Array(40), table6(places), new Uint8Array(56 * 7)]) });
  assert.deepEqual(ctrZonePlaces(reader(rom), { code: 'ECRA' }).places, places);
});

test('GARC: a damaged file count (far more entries than the table holds) is no archive – read at once, not looped through', () => {
  const g = garc([table6([0, 1]), new Uint8Array(8)]);
  const fb = 0x1c + 0x0c + 2 * 4;
  g.set([0xff, 0xff, 0xff, 0xff], fb + 8); // 4,294,967,295 files
  const t0 = Date.now();
  assert.equal(garcFile(reader(g), 0, -1), null);
  assert.ok(Date.now() - t0 < 1000);
});

test('no table: an encrypted game, another game, a table of the wrong size, garbage – never throws', () => {
  const tbl = { 'a/0/1/3': garc([table6([1, 2]), new Uint8Array(3)]) };
  assert.equal(ctrZonePlaces(reader(cciWithRomfs({ encrypted: true }, tbl)), { code: 'ECRA' }), null);
  assert.equal(ctrZonePlaces(reader(cciWithRomfs({}, tbl)), { code: 'BNDA' }), null);
  assert.equal(ctrZonePlaces(reader(cciWithRomfs({}, { 'a/0/1/3': garc([new Uint8Array(57), new Uint8Array(3)]) })), { code: 'ECRA' }), null);
  assert.equal(ctrZonePlaces(reader(new Uint8Array(0x5000).fill(0x41)), { code: 'ECRA' }), null);
  assert.equal(ctrZonePlaces(() => {
    throw new Error('io');
  }, { code: 'ECRA' }), null);
});

test('ctrData reads a .3ds file in pieces: the zone places for the place sign', () => {
  const file = join(DATA, 'or.3ds');
  writeFileSync(file, cciWithRomfs({}, { 'a/0/1/3': garc([table6([0, 170, 204]), new Uint8Array(8)]) }));
  const d = ctrData(file);
  assert.deepEqual(d.data, { gen: 6, ctr: { family: 'oras', places: [0, 170, 204] } });
  // not a 3DS game / no file: no data, no error
  writeFileSync(join(DATA, 'x.3ds'), 'hello');
  assert.equal(ctrData(join(DATA, 'x.3ds')).data, null);
  assert.equal(ctrData(join(DATA, 'missing.3ds')).data, null);
});

// (a sparse file: no disk space; Windows' NTFS may not keep it sparse)
test('a 3 GB game through the library\'s ROM data (the worker): read in pieces, never whole', { skip: process.platform === 'win32' }, async () => {
  const file = join(DATA, 'big.3ds');
  writeFileSync(file, cciWithRomfs({}, { 'a/0/1/3': garc([table6([0, 170, 204]), new Uint8Array(8)]) }));
  truncateSync(file, 3 * 1024 ** 3); // past what a whole read could take (2 GB)
  const d = await romDataFor({ file }, { sharedDir: null, cacheDir: null, timeoutMs: 30000 });
  assert.deepEqual(d.data, { gen: 6, ctr: { family: 'oras', places: [0, 170, 204] } });
  assert.equal(d.header.code, 'ECRA');
  rmSync(file);
});

test('what souldew reads in a 3DS game: its header finds the memory table entry (team, moves, items, place, battles)', () => {
  const file = join(DATA, 'or2.3ds');
  writeFileSync(file, cciWithRomfs({}, { 'a/0/1/3': garc([table6([0, 170]), new Uint8Array(8)]) }));
  const d = ctrData(file);
  assert.equal(d.header.system, '3ds');
  assert.equal(d.header.code, 'ECRA');
  const f = romFeatures(d, addresses);
  for (const k of ['party', 'items', 'moves', 'location', 'battle', 'catch', 'types']) assert.equal(f[k], 'yes', k);
  assert.equal(f.caps, 'no');
  // no zone table: no place, the rest still
  writeFileSync(file, cciWithRomfs({}, {}));
  const g = romFeatures(ctrData(file), addresses);
  assert.equal(g.location, 'no');
  assert.equal(g.moves, 'yes');
});

test('Gen 6/7 moves have names (the battle helper hides all moves when one has none)', () => {
  const api = json('pokeapi.json');
  for (const id of [560, 585, 617, 621, 670, 718, 728]) assert.ok(api.moves.en[id] && api.moves.de[id], `move ${id}`);
  assert.equal(api.moves.de[585], 'Mondgewalt');
  const moves = json('moves.json');
  for (let id = 1; id <= 728; id++) assert.ok(moves.type[id], `move ${id} has a type`);
});

test('the place sign: the zone the game reports → the place, once the live party has found the game', () => {
  const oras = addresses.games.find((g) => g.id === 'oras');
  const rom = { gen: 6, ctr: { family: 'oras', places: [0, 170, 204] } };
  const zone = Number(oras.zoneAddr);
  const read = (z) => (addr, len) => (addr === zone && len === 2 ? Uint8Array.of(z & 0xff, z >> 8) : null);
  assert.equal(canReadLocation(maps, oras, rom), true);
  assert.equal(canReadLocation(maps, oras, null), false);
  const ctx = { rom, state: { g67Len: 6 } };
  assert.deepEqual(readLocation(maps, oras, read(2), ctx), { gen: 6, id: 204, map: 2, romName: null });
  assert.equal(locationLabel(6, 170, { loc6: json('locations_gen6.json') }, 'de'), 'Wurzelheim');
  assert.equal(locationLabel(7, 24, { loc7: json('locations_gen7.json') }, 'en'), 'Iki Town');
  // before the party is read (title screen, the game's memory not set up) and on zones without a place: nothing
  assert.equal(readLocation(maps, oras, read(2), { rom, state: {} }), null);
  assert.equal(readLocation(maps, oras, read(0), ctx), null);
  assert.equal(readLocation(maps, oras, read(77), ctx), null);
  assert.equal(readLocation(maps, oras, () => null, ctx), null);
});

test('host messages: framed { u32 type, u32 length, payload } – split across chunks', () => {
  const a = command(MSG.EVENT, Buffer.from('{"event":"loaded"}'));
  const b = command(MSG.VIDEO, Buffer.alloc(16, 7));
  const all = Buffer.concat([a, b]);
  const first = splitMessages(all.subarray(0, a.length + 5));
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].type, MSG.EVENT);
  assert.equal(JSON.parse(first.messages[0].payload).event, 'loaded');
  const rest = splitMessages(Buffer.concat([first.rest, all.subarray(a.length + 5)]));
  assert.deepEqual(rest.messages.map((m) => [m.type, m.payload.length]), [[MSG.VIDEO, 16]]);
  assert.equal(rest.rest.length, 0);
});

test('commands a page may send: known types and sane sizes only', () => {
  const input = command(CMD.INPUT, Buffer.alloc(32));
  assert.equal(checkCommands(Buffer.concat([input, command(CMD.SPEED, Buffer.alloc(4)), command(CMD.SAVE)])).length, input.length + 12 + 8);
  const bad = (buf) => assert.throws(() => checkCommands(buf), (e) => e.status === 400 && e.code === 'badCommand');
  bad(Buffer.alloc(0));
  bad(command(99));
  bad(command(CMD.INPUT, Buffer.alloc(33)));
  bad(command(CMD.WATCH, Buffer.alloc(4 + 17 * 8)));
  bad(input.subarray(0, 20)); // cut off
});

test('the in-game save fingerprint: only the games\' save data on the SD card, changes when the game saves', () => {
  const dir = join(DATA, 'save');
  assert.equal(saveStamp(dir), null);
  const data = join(dir, 'Azahar', 'sdmc', 'Nintendo 3DS', '0'.repeat(32), '1'.repeat(32), 'title', '00040000', '0011c400', 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(dir, 'Azahar', 'sdmc', 'other.bin'), 'x');
  assert.equal(saveStamp(dir), null, 'no save data yet');
  writeFileSync(join(data, '00000001.sav'), Buffer.alloc(100));
  utimesSync(join(data, '00000001.sav'), 1000, 1000);
  const s1 = saveStamp(dir);
  assert.match(s1, /^[0-9a-f]{16}$/);
  assert.equal(saveStamp(dir), s1, 'same files: same stamp');
  utimesSync(join(data, '00000001.sav'), 2000, 2000);
  assert.notEqual(saveStamp(dir), s1, 'the game saved');
});

test('the system\'s Vulkan loader: Windows with the graphics driver, Linux libvulkan1 – else 3DS games open in Azahar', async () => {
  const { systemVulkan } = await import('../server/lib/ctr.mjs');
  const has = (paths) => (p) => paths.includes(p.replace(/\\/g, '/'));
  assert.equal(systemVulkan({ platform: 'win32', env: { SystemRoot: 'C:/Windows' }, exists: has(['C:/Windows/System32/vulkan-1.dll']) }), true);
  assert.equal(systemVulkan({ platform: 'win32', env: { SystemRoot: 'C:/Windows' }, exists: has([]) }), false);
  assert.equal(systemVulkan({ platform: 'linux', env: {}, exists: has(['/usr/lib/x86_64-linux-gnu/libvulkan.so.1']) }), true);
  assert.equal(systemVulkan({ platform: 'linux', env: { LD_LIBRARY_PATH: '/opt/gl' }, exists: has(['/opt/gl/libvulkan.so.1']) }), true);
  assert.equal(systemVulkan({ platform: 'linux', env: {}, exists: has([]) }), false);
  assert.equal(systemVulkan({ platform: 'darwin' }), true); // macOS: MoltenVK comes with souldew
});

test('the host\'s output split into whole messages, however the chunks are cut', async () => {
  const { MessageSplitter } = await import('../server/lib/ctr.mjs');
  const msgs = [command(MSG.EVENT, Buffer.from('{"event":"loaded"}')), command(MSG.VIDEO, Buffer.alloc(5000, 3)), command(MSG.AUDIO, Buffer.alloc(0)), command(MSG.MEM, Buffer.alloc(9, 1))];
  const all = Buffer.concat(msgs);
  for (const size of [1, 3, 7, 8, 9, 100, 4999, all.length]) {
    const sp = new MessageSplitter();
    const got = [];
    for (let o = 0; o < all.length; o += size) got.push(...sp.push(all.subarray(o, o + size)));
    assert.deepEqual(got.map((m) => m.type), [MSG.EVENT, MSG.VIDEO, MSG.AUDIO, MSG.MEM], `chunks of ${size}`);
    assert.ok(got.every((m, i) => m.data.equals(msgs[i])), `chunks of ${size}`);
  }
});

// ---- a session with a stand-in host (node -e …): what the page's stream gets ------------------------------------------
const FAKE_HOST = `
const mode = process.argv[process.argv.indexOf('--rom') + 1];
const msg = (type, p) => { const h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(p.length, 4); return Buffer.concat([h, p]); };
const ev = (o) => msg(7, Buffer.from(JSON.stringify(o)));
const write = (b) => new Promise((r) => (process.stdout.write(b) ? r() : process.stdout.once('drain', r)));
(async () => {
  const parts = [ev({ event: 'loaded' })];
  for (let i = 0; i < (mode === 'die' ? 20 : 120); i++) parts.push(msg(2, Buffer.alloc(mode === 'die' ? 1 << 20 : 256 * 1024, i)));
  parts.push(ev({ event: mode === 'die' ? 'error' : 'done', message: 'C:\\\\Users\\\\x' }));
  const all = Buffer.concat(parts);
  for (let o = 0; o < all.length; o += 777777) await write(all.subarray(o, o + 777777));
  if (mode === 'die') process.exit(1);
  process.stdin.on('data', (d) => d.readUInt32LE(0) === 6 && process.exit(0));
  process.stdin.on('end', () => process.exit(0));
})();
`;
const { Writable } = await import('node:stream');
const { spawn } = await import('node:child_process');
class FakeRes extends Writable {
  constructor({ hold = false } = {}) {
    super({ highWaterMark: 64 * 1024 });
    this.got = [];
    this.hold = hold;
  }
  writeHead() {}
  _write(c, e, cb) {
    this.got.push(c);
    if (!this.hold) cb();
  }
  messages() {
    return splitMessages(Buffer.concat(this.got));
  }
}
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; !fn();) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const fakeSessions = async () => {
  const { CtrSessions } = await import('../server/lib/ctr.mjs');
  return new CtrSessions({ spawn: (cmd, args, o) => spawn(process.execPath, ['-e', FAKE_HOST, '--', ...args], o) });
};
const tools = { host: 'ctrhost', core: 'core', vulkan: 'vk' };

test('a page that connects after the host failed: whole messages from the start, the last event, then the end', async () => {
  const ctr = await fakeSessions();
  const id = ctr.start({ rom: 'die', key: 'test-die', tools });
  const s = ctr.current;
  await until(() => s.closed);
  assert.equal(s.exit.code, 1);
  const res = new FakeRes();
  ctr.attach(id, res);
  await until(() => res.writableFinished);
  const { messages, rest } = res.messages();
  assert.equal(rest.length, 0, 'ends on a message boundary');
  assert.equal(messages[0].type, MSG.EVENT);
  const last = messages.at(-1);
  assert.equal(last.type, MSG.EVENT);
  assert.deepEqual(JSON.parse(last.payload), { event: 'error', message: 'C:\\Users\\x' });
  const pictures = messages.filter((m) => m.type === MSG.VIDEO);
  assert.ok(pictures.length >= 1 && pictures.length < 20, `pictures kept: ${pictures.length}`);
  assert.ok(pictures.every((m) => m.payload.length === 1 << 20));
  assert.equal(s.events.at(-1).event, 'error');
});

test('a new page takes over from one that stopped reading: the host goes on, the new page starts at a message', async () => {
  const ctr = await fakeSessions();
  const id = ctr.start({ rom: 'stream', key: 'test-stream', tools });
  const s = ctr.current;
  const a = new FakeRes({ hold: true });
  ctr.attach(id, a);
  await until(() => s.held);
  const b = new FakeRes();
  ctr.attach(id, b);
  await until(() => b.messages().messages.some((m) => m.type === MSG.EVENT && JSON.parse(m.payload).event === 'done'));
  const { messages } = b.messages();
  assert.ok(messages.every((m) => [MSG.VIDEO, MSG.EVENT].includes(m.type)), 'no torn message at the start');
  assert.ok(messages.filter((m) => m.type === MSG.VIDEO).every((m) => m.payload.length === 256 * 1024));
  ctr.stop();
  await until(() => s.closed);
  assert.equal(s.exit.code, 0, 'ended by QUIT, not killed');
});
