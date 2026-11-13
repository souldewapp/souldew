// Server-side security checks: request gate, emulator path validation, live bridge auth, decompression limits,
// pack import checks, local-only Discord webhook, doc merge hardening, randomizer properties.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, connect } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { hostAllowed, apiRequestError, privateRequestError } from '../server/lib/guard.mjs';
import { validCustomPath } from '../server/lib/emulator.mjs';
import { LiveBridge, parseHello, looksLikeHttp, luaScript } from '../server/lib/livebridge.mjs';
import { readZipEntry, listZip } from '../server/lib/zip.mjs';
import { applyPatch } from '../shared/patchers.mjs';
import { checkPack, stripLocalRules, runPack, isDiscordWebhook } from '../server/lib/build.mjs';
import { toProperties } from '../shared/randomizer-options.mjs';
import { RunDoc } from '../web/lib/doc.mjs';

const req = (method, headers = {}) => ({ method, headers });

test('request gate: only the app origin reaches the API', () => {
  const P = 47390;
  assert.ok(hostAllowed('localhost:47390'));
  assert.ok(hostAllowed('127.0.0.1:1'));
  assert.ok(hostAllowed('[::1]:47390'));
  assert.ok(!hostAllowed('evil.com'));
  assert.ok(!hostAllowed('localhost.evil.com:47390'));
  // the app itself: same-origin fetches (Origin only on non-GET), typed URLs (none), old clients (no headers)
  assert.equal(apiRequestError(req('GET'), P), null);
  assert.equal(apiRequestError(req('GET', { 'sec-fetch-site': 'same-origin' }), P), null);
  assert.equal(apiRequestError(req('GET', { 'sec-fetch-site': 'none' }), P), null);
  assert.equal(apiRequestError(req('POST', { origin: 'http://localhost:47390', 'sec-fetch-site': 'same-origin', 'x-soullink': '1' }), P), null);
  assert.equal(apiRequestError(req('PUT', { origin: 'http://127.0.0.1:47390', 'x-soullink': '1' }), P), null);
  // foreign origins, other ports, opaque origins
  assert.ok(apiRequestError(req('POST', { origin: 'https://evil.com', 'x-soullink': '1' }), P));
  assert.ok(apiRequestError(req('POST', { origin: 'http://localhost:8080', 'x-soullink': '1' }), P));
  assert.ok(apiRequestError(req('POST', { origin: 'null', 'x-soullink': '1' }), P));
  assert.ok(apiRequestError(req('GET', { origin: 'https://evil.com' }), P));
  // <img src="http://localhost:47390/api/library/patched?…"> from a website: no Origin, but Sec-Fetch-Site
  assert.ok(apiRequestError(req('GET', { 'sec-fetch-site': 'cross-site' }), P));
  assert.ok(apiRequestError(req('GET', { 'sec-fetch-site': 'same-site' }), P));
  // state-changing requests still need the app header
  assert.ok(apiRequestError(req('POST', { 'sec-fetch-site': 'same-origin' }), P));
  assert.ok(apiRequestError(req('DELETE', {}), P));
});

test('private GETs (run pack, files, spoiler log, webhook, stream token, folders) need the app itself (#21)', () => {
  const get = (headers = {}) => req('GET', headers);
  const own = [{ 'x-soullink': '1' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'same-origin', 'x-soullink': '1' }];
  const notOwn = [{}, { 'sec-fetch-site': 'none' }, { 'x-soullink': '0' }, { 'sec-fetch-site': 'same-site' }];
  const privatePaths = ['/api/runs/c0ffee01', '/api/runs/c0ffee01/download', '/api/runs/c0ffee01/file', '/api/runs/c0ffee01/log/p2',
    '/api/runs/c0ffee01/data/p1', '/api/runs/c0ffee01/doc', '/api/runs/c0ffee01/discord', '/api/stream', '/api/status'];
  for (const path of privatePaths) {
    for (const h of own) assert.equal(privateRequestError(get(h), path), null, `${path} ${JSON.stringify(h)}`);
    for (const h of notOwn) assert.ok(privateRequestError(get(h), path), `${path} ${JSON.stringify(h)}`);
    assert.ok(privateRequestError(req('HEAD', {}), path), `HEAD ${path}`);
  }
  // what OBS and the overlays read stays as it was (the general gate still applies)
  for (const path of ['/api/runs/c0ffee01/overlay', '/api/runs/current/overlay/events', '/api/library', '/api/catalog', '/api/runs/c0ffee01/save/p1']) {
    assert.equal(privateRequestError(get({}), path), null, path);
  }
  // other methods are the general gate's (they need the app header there)
  assert.equal(privateRequestError(req('PUT', {}), '/api/runs/c0ffee01/doc'), null);
});

test('custom emulator path: only a matching .app bundle or emulator executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-emu-'));
  try {
    const exe = join(dir, process.platform === 'win32' ? 'mGBA.exe' : 'mGBA');
    writeFileSync(exe, '');
    const script = join(dir, 'evil.sh');
    writeFileSync(script, '#!/bin/sh\n');
    mkdirSync(join(dir, 'mGBA.app'));
    mkdirSync(join(dir, 'Calculator.app'));
    assert.equal(validCustomPath('mgba', exe), exe);
    assert.equal(validCustomPath('mgba', script), null);
    assert.equal(validCustomPath('mgba', '/bin/sh'), null);
    assert.equal(validCustomPath('melonds', exe), null); // name must match the emulator
    assert.equal(validCustomPath('mgba', 'mGBA'), null); // relative
    assert.equal(validCustomPath('mgba', join(dir, 'missing', 'mGBA')), null);
    assert.equal(validCustomPath('mgba', { path: exe }), null);
    assert.equal(validCustomPath('nope', exe), null);
    assert.equal(validCustomPath('mgba', join(dir, 'Calculator.app')), null);
    assert.equal(validCustomPath('mgba', join(dir, 'mGBA.app')), process.platform === 'darwin' ? join(dir, 'mGBA.app') : null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live bridge: token in the Lua script, HELLO must carry it', () => {
  const token = 'ab'.repeat(16);
  const lua = luaScript(47123, token);
  assert.match(lua, new RegExp(`local TOKEN = "${token}"`));
  assert.match(lua, /"HELLO " \.\. TOKEN \.\. " "/);
  assert.throws(() => luaScript(47123, ''));
  assert.deepEqual(parseHello(`HELLO ${token} 0 BPEE POKEMON EMER`, token), { platform: '0', code: 'BPEE', title: 'POKEMON EMER' });
  assert.equal(parseHello('HELLO 0 BPEE POKEMON EMER', token), null); // old script without token
  assert.equal(parseHello(`HELLO ${'cd'.repeat(16)} 0 BPEE X`, token), null);
  assert.equal(parseHello(`HELLO ${token} 0 BPEE X`, undefined), null);
  assert.ok(looksLikeHttp('POST /x HTTP/1.1'));
  assert.ok(!looksLikeHttp(`HELLO ${token} 0 BPEE X`));
});

/** Connects a client to a LiveBridge.handle() and returns { emitted, closed } after sending `lines`. */
async function bridgeSession(token, lines) {
  const emitted = [];
  const bridge = new LiveBridge((ev, data) => emitted.push([ev, data]));
  bridge.token = token;
  bridge.table = { games: [] };
  const server = createServer((s) => bridge.handle(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const sock = connect(server.address().port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    const closed = new Promise((r) => sock.once('close', () => r(true)));
    sock.on('error', () => {});
    sock.resume(); // read what the bridge answers, like the script does (an unread stream never sees the server's end)
    sock.write(lines);
    const result = await Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 300))]);
    const clients = bridge.clients.size;
    sock.destroy();
    return { emitted, closed: result, clients };
  } finally {
    server.close();
  }
}

test('live bridge: HTTP requests and wrong tokens are dropped, the real script is accepted', async () => {
  const token = '0123456789abcdef'.repeat(2);
  const http = await bridgeSession(token, 'POST / HTTP/1.1\r\nHost: 127.0.0.1:47123\r\n\r\nF 1\n');
  assert.equal(http.closed, true);
  assert.equal(http.emitted.length, 0);
  const wrong = await bridgeSession(token, `HELLO ${'f'.repeat(32)} 0 BPEE X\nF 1\n`);
  assert.equal(wrong.closed, true);
  assert.equal(wrong.clients, 0);
  // only the hint for the UI ("a script from another install tried") – no data, no client
  assert.deepEqual(wrong.emitted.map(([ev, d]) => [ev, d.rejected?.reason, d.clients]), [['live-status', 'token', 0]]);
  const frameFirst = await bridgeSession(token, 'F 1\n');
  assert.equal(frameFirst.closed, true);
  assert.equal(frameFirst.emitted.length, 0);
  const ok = await bridgeSession(token, `HELLO ${token} 0 BPEE POKEMON EMER\nF 20\n`);
  assert.equal(ok.closed, false);
  assert.equal(ok.clients, 1);
  assert.deepEqual(ok.emitted.map(([ev]) => ev), ['live-status', 'live']);
});

/** Minimal single-entry zip (deflate) with a chosen declared uncompressed size. */
function makeZip(name, data, declaredSize = data.length) {
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(declaredSize, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(declaredSize, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOffset = 30 + nameBuf.length + comp.length;
  const cdLen = 46 + nameBuf.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdLen, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([lh, nameBuf, comp, cd, nameBuf, eocd]);
}

test('zip: inflate never exceeds the declared size, headers are read without inflating the ROM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-zip-'));
  try {
    const rom = Buffer.alloc(4 * 1024 * 1024, 0);
    rom.write('POKEMON EMER', 0xa0);
    const good = join(dir, 'good.zip');
    writeFileSync(good, makeZip('game.gba', rom));
    const [entry] = listZip(good);
    assert.equal(readZipEntry(good, entry).length, rom.length);
    const head = readZipEntry(good, entry, { prefix: 0x200 });
    assert.equal(head.length, 0x200);
    assert.equal(head.subarray(0xa0, 0xac).toString(), 'POKEMON EMER');
    // a "bomb": 4 MB of zeros declared as 1 KB
    const bomb = join(dir, 'bomb.zip');
    writeFileSync(bomb, makeZip('game.gba', rom, 1024));
    const [b] = listZip(bomb);
    assert.throws(() => readZipEntry(bomb, b));
    // entry pointing past the end of the file
    assert.throws(() => readZipEntry(good, { ...entry, compSize: 1e12 }));
    assert.throws(() => readZipEntry(good, { ...entry, uncompSize: 2 ** 40 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** BPS/UPS varint as written by beat/flips. */
function varint(n) {
  const out = [];
  for (;;) {
    const x = n % 128;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(0x80 | x);
      return out;
    }
    out.push(x);
    n--;
  }
}

test('BPS/UPS: an absurd target size is refused before allocating', () => {
  const src = new Uint8Array(16);
  const bps = new Uint8Array([...Buffer.from('BPS1'), ...varint(16), ...varint(2 ** 40), ...varint(0), ...new Array(12).fill(0)]);
  assert.throws(() => applyPatch(src, bps), /implausibly large/);
  const ups = new Uint8Array([...Buffer.from('UPS1'), ...varint(16), ...varint(2 ** 40), ...new Array(12).fill(0)]);
  assert.throws(() => applyPatch(src, ups), /implausibly large/);
});

test('pack import checks types of room, secret and players', () => {
  const pack = { id: '0123abcd', room: 'evoli-mew-1a2b', secret: 'abcdefghijklmnop', name: 'Run', players: { p1: { name: 'Lou' }, p2: { name: 'Noa/../x' } } };
  const ok = checkPack(pack);
  assert.equal(ok.room, pack.room);
  assert.equal(ok.secret, pack.secret);
  assert.deepEqual(Object.keys(ok.players), ['p1', 'p2']);
  assert.ok(!ok.players.p2.name.includes('/'));
  assert.throws(() => checkPack({ ...pack, room: { toString: 1 } }));
  assert.throws(() => checkPack({ ...pack, room: 'x'.repeat(500) }));
  assert.throws(() => checkPack({ ...pack, secret: 42 }));
  assert.throws(() => checkPack({ ...pack, secret: 'short' }));
  assert.throws(() => checkPack({ ...pack, secret: 'abcdefgh\nijkl' }));
  assert.throws(() => checkPack({ ...pack, players: [] }));
  assert.throws(() => checkPack({ ...pack, players: { p1: 'Lou' } }));
  assert.throws(() => checkPack({ ...pack, randomizer: 'x' }));
});

test('Discord webhook stays local: stripped from rules and packs, URL validated', () => {
  const rules = { typeClause: 'global', discordWebhook: 'https://discord.com/api/webhooks/123/abc' };
  assert.deepEqual(stripLocalRules(rules), { typeClause: 'global' });
  assert.equal(stripLocalRules(null), null);
  const pack = runPack({ id: '0123abcd', room: 'r', secret: 's', rules });
  assert.ok(!('discordWebhook' in pack.rules));
  assert.ok(isDiscordWebhook('https://discord.com/api/webhooks/123456/abc-DEF_9'));
  assert.ok(isDiscordWebhook('https://discordapp.com/api/webhooks/1/x'));
  assert.ok(!isDiscordWebhook('http://discord.com/api/webhooks/1/x'));
  assert.ok(!isDiscordWebhook('https://discord.com.evil.com/api/webhooks/1/x'));
  assert.ok(!isDiscordWebhook('https://user:pw@discord.com/api/webhooks/1/x'));
  assert.ok(!isDiscordWebhook('https://discord.com/api/webhooks/'));
  assert.ok(!isDiscordWebhook(null));
});

test('doc merge ignores prototype keys and clamps future timestamps', () => {
  const d = new RunDoc('sec');
  d._persistSoon = () => {};
  const evil = JSON.parse('{"__proto__": {"v": {"polluted": true}, "t": 1, "by": "x"}, "constructor": {"v": 1, "t": 1, "by": "x"}, "prototype": {"v": 1, "t": 1, "by": "x"}}');
  assert.deepEqual(d.merge(evil), []);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(d.entries), Object.prototype);
  const far = Date.now() + 365 * 86400000;
  d.merge({ rules: { v: { typeClause: 'off' }, t: far, by: 'x' } });
  assert.ok(d.entries.rules.t <= Date.now() + 86400000 + 1000);
  // a local edit can still override it (the clock follows the clamped timestamp)
  d.set('rules', { typeClause: 'party' });
  assert.equal(d.get('rules').typeClause, 'party');
  assert.deepEqual(d.merge({ x: { v: 1, t: NaN, by: 'x' }, y: null, z: 'str' }), []);
});

test('randomizer properties: values cannot inject extra lines or keys', () => {
  const text = toProperties({ trainersMod: 'RANDOM\n@base=EVIL', 'evil\nkey=x': 'y', '@miscTweaks': ['A\r\nB', 'C=D'], limit600: true });
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 5);
  assert.ok(!lines.some((l) => l.startsWith('@base')));
  assert.equal(lines[1], 'trainersMod=RANDOM@baseEVIL');
  assert.equal(lines[2], 'evilkeyx=y');
  assert.equal(lines[3], '@miscTweaks=AB,CD');
  assert.equal(lines[4], 'limit600=true');
});
