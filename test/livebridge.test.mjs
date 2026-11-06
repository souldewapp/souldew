// The mGBA live bridge (server/lib/livebridge.mjs): what the Lua script in mGBA sends, byte for byte, and what the
// server makes of it. The script's stream is simulated here – with the game codes mGBA really reports (0.10.x puts
// the system in front: "AGB-BPEE") and with the small, arbitrary chunks a non-blocking socket delivers on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { LiveBridge, parseHello, normalizeGameCode, luaScript, PORTS, SCRIPT_VERSION } from '../server/lib/livebridge.mjs';
import { findEntry, readLiveParty, regionReader, LiveTables } from '../shared/live/parse.mjs';
import { bridgeState, REJECTED_FRESH } from '../web/lib/livebridge.mjs';

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const TABLE = L('addresses.json');
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const TOKEN = '0123456789abcdef'.repeat(2);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('game codes as mGBA reports them match the address tables', () => {
  // mGBA 0.10.x: GBAGetGameCode → "AGB-" + code, GBGetGameCode → "CGB-"/"DMG-" + maker code or "????"
  assert.equal(normalizeGameCode('AGB-BPEE'), 'BPEE');
  assert.equal(normalizeGameCode('CGB-AAUE'), 'AAUE');
  assert.equal(normalizeGameCode('DMG-????'), '');
  assert.equal(normalizeGameCode('agb-bpre'), 'BPRE');
  // development builds (0.11) report the bare code; the new script sends "-" for none
  assert.equal(normalizeGameCode('BPEE'), 'BPEE');
  assert.equal(normalizeGameCode('-'), '');
  assert.equal(normalizeGameCode(''), '');
  assert.equal(normalizeGameCode(undefined), '');

  // the bug from 2.1.0: "AGB-BPEE" matched no game, so souldew never asked for memory and the UI waited forever
  const emerald = parseHello(`HELLO ${TOKEN} 0 AGB-BPEE POKEMON EMER`, TOKEN);
  assert.deepEqual(emerald, { platform: '0', code: 'BPEE', title: 'POKEMON EMER' });
  assert.equal(findEntry(TABLE, { platform: 'gba', ...emerald })?.id, 'emerald_us');
  assert.equal(findEntry(TABLE, { platform: 'gba', ...parseHello(`HELLO ${TOKEN} 0 AGB-BPRE POKEMON FIRE`, TOKEN) })?.id, 'firered_us');
  // Game Boy: no product code on Red, a NUL-padded title, an empty code field (two spaces)
  const red = parseHello(`HELLO ${TOKEN} 1 DMG-???? POKEMON RED\0\0\0\0`, TOKEN);
  assert.deepEqual(red, { platform: '1', code: '', title: 'POKEMON RED' });
  assert.equal(findEntry(TABLE, { platform: 'gb', ...red })?.id, 'red_us');
  assert.equal(findEntry(TABLE, { platform: 'gb', ...parseHello(`HELLO ${TOKEN} 1  POKEMON RED`, TOKEN) })?.id, 'red_us');
  assert.equal(findEntry(TABLE, { platform: 'gb', ...parseHello(`HELLO ${TOKEN} 1 CGB-BYTE PM_CRYSTAL`, TOKEN) })?.id, 'crystal_us');
});

test('the generated script: ASCII, LF, every port with the current one first, closed sockets kept from the GC', () => {
  const lua = luaScript(47124, TOKEN, { scriptPath: 'C:\\Users\\Zoë\\AppData\\Roaming\\SoulLink Studio\\Live\\soullink-mgba.lua' });
  assert.ok(!lua.startsWith('\uFEFF'));
  assert.ok(!lua.includes('\r'));
  // only the path the user's own folder brings in may be non-ASCII (Lua keeps it as bytes inside a long string)
  assert.ok([...lua.replace(/local SCRIPT = .*\n/, '')].every((ch) => ch.charCodeAt(0) < 128));
  assert.match(lua, new RegExp(`local PORTS = \\{ 47124, ${PORTS.filter((p) => p !== 47124).join(', ')} \\}`));
  assert.match(lua, new RegExp(`local TOKEN = "${TOKEN}"`));
  assert.match(lua, new RegExp(`local VERSION = ${SCRIPT_VERSION}\\b`));
  assert.match(lua, /local SCRIPT = \[\[C:\\Users\\Zoë\\AppData/);
  // mGBA 0.10 closes a socket again when it is garbage-collected (the number may belong to a newer socket by then)
  assert.match(lua, /closed\[#closed \+ 1\] = sock/);
  // partial sends keep the rest; AGAIN ("temporary failure") is not a lost connection
  assert.match(lua, /outbuf = outbuf:sub\(n \+ 1\)/);
  assert.match(lua, /if err ~= AGAIN then drop/);
  // messages for the user go to mGBA's console
  assert.match(lua, /console:warn\("\[souldew\] "/);
  // a path containing "]]" can't end the long string early
  assert.match(luaScript(47123, TOKEN, { scriptPath: '/a]]b/x.lua' }), /local SCRIPT = \[=\[\/a\]\]b\/x\.lua\]=\]/);
  assert.throws(() => luaScript(47123, 'nope'));
});

/** A LiveBridge on a random port with the real address table; `emitted` collects its events. */
async function bridge() {
  const emitted = [];
  const b = new LiveBridge((ev, data) => emitted.push([ev, data]));
  b.token = TOKEN;
  b.table = TABLE;
  const server = createServer((s) => b.handle(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { b, emitted, port: server.address().port, close: () => server.close() };
}

/**
 * A client speaking like the Lua script. `send` writes the bytes in chunks of `sizes` (cycled) with a pause between
 * them, so they arrive as separate reads – a line may be split anywhere, also between "\r" and "\n".
 */
async function scriptClient(port) {
  const sock = connect(port, '127.0.0.1');
  sock.setNoDelay(true);
  sock.setEncoding('utf8');
  let got = '';
  sock.on('data', (d) => (got += d));
  sock.on('error', () => {});
  const closed = new Promise((r) => sock.once('close', () => r(true)));
  await new Promise((r) => sock.once('connect', r));
  return {
    sock,
    closed,
    received: () => got,
    async send(text, sizes = [text.length]) {
      let i = 0;
      for (let k = 0; i < text.length; k++) {
        const n = sizes[k % sizes.length];
        sock.write(text.slice(i, i + n));
        i += n;
        await tick(2);
      }
    },
    async waitFor(re, ms = 1000) {
      const end = Date.now() + ms;
      while (!re.test(got) && Date.now() < end) await tick();
      return got;
    },
  };
}

/** Gen 3 party struct as the game keeps it (encrypted substructures), see test/live.test.mjs. */
function pk3({ pid, otId, internal, level, hp, maxHp }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, internal, true);
  pv.setUint16(order.indexOf('M') * 12 + 2, 5, true);
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
const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('script v2 on mGBA 0.10 (Emerald, "AGB-BPEE"): regions asked, chunked frames parsed into the party', async () => {
  const { b, emitted, port, close } = await bridge();
  try {
    const c = await scriptClient(port);
    // HELLO split mid-token, CRLF split between \r and \n (mGBA on Windows sends whatever fits)
    await c.send(`HELLO ${TOKEN} 0 AGB-BPEE POKEMON EMER\r\nV 2\r\n`, [7, 1, 13, 3]);
    const reply = await c.waitFor(/R [0-9a-f]+ 600\n/);
    assert.match(reply, /^OK\n/);
    assert.deepEqual([...reply.matchAll(/^R ([0-9a-f]+) (\d+)$/gm)].map((m) => [m[1], +m[2]]), [['20244e9', 1], ['20244ec', 600]]);
    let st = b.status();
    assert.equal(st.clients, 1);
    assert.deepEqual([st.connection.game.entryId, st.connection.supported, st.connection.version], ['emerald_us', true, 2]);
    assert.equal(st.lastAt, null);
    assert.equal(bridgeState(st).key, 'connected');

    const party = new Uint8Array(600);
    party.set(pk3({ pid: 0x12345677, otId: 0xbeefcafe, internal: 277, level: 9, hp: 20, maxHp: 28 }), 0);
    const frame = `D 1 02\nD 2 ${hex(party)}\nF 120\n`;
    // a Windows-like partial send: the 1.2 kB snapshot arrives in odd pieces
    await c.send(frame, [5, 1, 333, 64, 2]);
    for (let i = 0; i < 100 && !emitted.some(([ev]) => ev === 'live'); i++) await tick();
    const live = emitted.filter(([ev]) => ev === 'live').map(([, d]) => d);
    assert.equal(live.length, 1);
    assert.equal(live[0].game.entryId, 'emerald_us');
    const res = readLiveParty(findEntry(TABLE, live[0].game), regionReader(live[0].regions), T, {});
    assert.deepEqual(res.party.map((m) => [m.species, m.level, m.hp, m.maxHp]), [[252, 9, 20, 28]]);
    st = b.status();
    assert.ok(st.lastAt);
    assert.equal(bridgeState(st, { fresh: true }).key, 'live');

    // a reset or another game: the script says HELLO again, souldew answers OK + that game's regions
    const before = c.received().length;
    await c.send(`HELLO ${TOKEN} 0 AGB-BPRE POKEMON FIRE\nV 2\n`, [9]);
    const again = (await c.waitFor(/R 2024284 600\n[^]*$/)).slice(before);
    assert.match(again, /^OK\nR 2024029 1\nR 2024284 600\n$/);
    assert.equal(b.status().connection.game.entryId, 'firered_us');
    // a torn or foreign data line doesn't overwrite a region
    await c.send(`D 2 zz\nD 9 00\nD 1 0201\nF 140\n`);
    for (let i = 0; i < 100 && emitted.filter(([ev]) => ev === 'live').length < 2; i++) await tick();
    const last = emitted.filter(([ev]) => ev === 'live').at(-1)[1];
    assert.deepEqual(last.regions.map((r) => r.hex), ['', '']); // nothing from before the reset, nothing malformed
    c.sock.destroy();
    await c.closed;
    await tick(10);
    assert.equal(b.status().clients, 0);
    assert.equal(b.status().connection, null);
    assert.equal(bridgeState(b.status()).key, 'waiting');
  } finally {
    close();
  }
});

test('an unknown game gets "N", the version-1 script still works, foreign scripts get ERR', async () => {
  const { b, emitted, port, close } = await bridge();
  try {
    // a game souldew has no addresses for: told so instead of silence
    const ruby = await scriptClient(port);
    await ruby.send(`HELLO ${TOKEN} 0 AGB-AXVJ POKEMON RUBY\nV 2\n`);
    assert.match(await ruby.waitFor(/N .*\n/), /^OK\nN GBA AXVJ POKEMON RUBY\n$/);
    assert.deepEqual([b.status().connection.supported, bridgeState(b.status()).key], [false, 'unsupported']);
    assert.equal(bridgeState(b.status()).game.title, 'POKEMON RUBY');
    ruby.sock.destroy();
    await ruby.closed;

    // souldew 2.1.0's script: no V line, RESET lines, ignores OK – works now and is reported as outdated
    const v1 = await scriptClient(port);
    await v1.send(`HELLO ${TOKEN} 0 AGB-BPEE POKEMON EMER\n`, [4]);
    await v1.waitFor(/R 20244ec 600\n/);
    await v1.send(`RESET\nD 1 01\nD 2 ${'00'.repeat(600)}\nF 20\n`, [100]);
    for (let i = 0; i < 100 && !emitted.some(([ev]) => ev === 'live'); i++) await tick();
    assert.ok(emitted.some(([ev]) => ev === 'live'));
    assert.equal(b.status().connection.version, 1);
    assert.deepEqual(bridgeState(b.status()), { key: 'connected', outdated: true, game: b.status().connection.game });
    v1.sock.destroy();
    await v1.closed;

    // a script from another install (other token) and one from before the token: ERR + closed + a hint for the UI
    for (const [hello, reason] of [[`HELLO ${'f'.repeat(32)} 0 AGB-BPEE POKEMON EMER`, 'token'], ['HELLO 0 AGB-BPEE POKEMON EMER', 'old']]) {
      const c = await scriptClient(port);
      await c.send(`${hello}\nV 2\n`);
      assert.equal(await c.closed, true);
      assert.equal(c.received(), `ERR ${reason}\n`);
      assert.equal(b.status().rejected.reason, reason);
      assert.equal(b.status().clients, 0);
    }
    assert.equal(bridgeState(b.status()).key, 'rejected');
    assert.equal(bridgeState(b.status(), { now: Date.now() + REJECTED_FRESH + 1 }).key, 'waiting');
    // the right script afterwards clears the hint
    const ok = await scriptClient(port);
    await ok.send(`HELLO ${TOKEN} 0 AGB-BPEE POKEMON EMER\nV 2\n`);
    await ok.waitFor(/R 20244ec 600\n/);
    assert.equal(b.status().rejected, null);
    ok.sock.destroy();
  } finally {
    close();
  }
});

test('the panel tells the bridge states apart', () => {
  assert.equal(bridgeState(null).key, 'waiting');
  assert.equal(bridgeState({ port: null, error: 'noPort' }).key, 'noPort');
  assert.equal(bridgeState({ port: 47123, connection: null, rejected: null }).key, 'waiting');
  const conn = { game: { title: 'POKEMON EMER', code: 'BPEE' }, supported: true, version: 2 };
  assert.deepEqual(bridgeState({ port: 47123, scriptVersion: 2, connection: conn }), { key: 'connected', outdated: false, game: conn.game });
  assert.equal(bridgeState({ port: 47123, scriptVersion: 2, connection: conn }, { fresh: true }).key, 'live');
  assert.equal(bridgeState({ port: 47123, scriptVersion: 2, connection: { ...conn, supported: false } }).key, 'unsupported');
  assert.equal(bridgeState({ port: 47123, scriptVersion: 2, connection: { ...conn, version: 1 } }).outdated, true);
});
