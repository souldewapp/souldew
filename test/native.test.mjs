// The fast player (server/lib/native.mjs, native/retro-host): which tools and cores are found, the host's arguments,
// which commands a page may send, the session around the host – and, when the native part is built (npm run native),
// the real host with the real Game Boy core on a tiny ROM made here: the RAM mirror, cheats, save states, the battery
// save handed in and out, exact frame steps and a broken command stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const DATA = mkdtempSync(join(tmpdir(), 'sls-native-'));
process.env.SLS_DATA_DIR = DATA;
const { NATIVE_CORES, NCMD, nativeTools, hostArgs, checkNativeCommands, NativeSessions, nativeSaveDir, nativeDirs } = await import('../server/lib/native.mjs');
const { command, splitMessages } = await import('../server/lib/ctr.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const EXE = process.platform === 'win32' ? 'retrohost.exe' : 'retrohost';
const EXT = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

test('the tools: the host and whichever cores are there', () => {
  const files = new Set(['/t/a/' + EXE, `/t/a/melondsds_libretro.${EXT}`, `/t/a/gambatte_libretro.${EXT}`].map((f) => join(f)));
  const tl = nativeTools({ dirs: [join('/t/none'), join('/t/a')], exists: (p) => files.has(join(p)) });
  assert.equal(tl.ok, true);
  assert.equal(tl.host, join('/t/a', EXE));
  assert.equal(tl.cores.nds, join('/t/a', `melondsds_libretro.${EXT}`));
  assert.equal(tl.cores.gba, null);
  assert.equal(tl.cores.gb, tl.cores.gbc); // one core for both
  assert.deepEqual(nativeTools({ dirs: ['/t/none'], exists: () => false }), { ok: false, missing: 'host', cores: {} });
  // a host without any core plays nothing
  assert.equal(nativeTools({ dirs: ['/t/a'], exists: (p) => p.endsWith(EXE) }).ok, false);
});

test('the host\'s arguments: the core, the RAM the live reader needs, souldew\'s core options', () => {
  const a = hostArgs({ system: 'nds', core: '/c/melon', rom: '/r/p.nds', saveDir: '/s', systemDir: '/y', sram: '/s/boot.sav' });
  const pairs = [];
  for (let i = 0; i < a.length; i += 2) pairs.push([a[i], a[i + 1]]);
  assert.deepEqual(pairs.slice(0, 5), [['--core', '/c/melon'], ['--rom', '/r/p.nds'], ['--system', '/y'], ['--save', '/s'], ['--sram', '/s/boot.sav']]);
  assert.deepEqual(pairs.filter(([k]) => k === '--ram').map(([, v]) => v), ['0x2000000:0x400000']);
  const opts = Object.fromEntries(pairs.filter(([k]) => k === '--option').map(([, v]) => v.split('=')));
  assert.equal(opts.melonds_jit_enable, 'enabled');
  assert.equal(opts.melonds_network_mode, 'disabled'); // never online through the core
  assert.equal(opts.melonds_console_mode, 'ds');
  // GBA: EWRAM and IWRAM, as player.html maps them
  assert.deepEqual(hostArgs({ system: 'gba', core: 'c', rom: 'r', saveDir: 's', systemDir: 'y' }).filter((x, i, l) => l[i - 1] === '--ram'), ['0x2000000:0x40000', '0x3000000:0x8000']);
  assert.ok(!hostArgs({ system: 'gb', core: 'c', rom: 'r', saveDir: 's', systemDir: 'y' }).includes('--sram')); // no save: none given
  assert.throws(() => hostArgs({ system: '3ds', core: 'c', rom: 'r', saveDir: 's', systemDir: 'y' }), /nativer Kern/);
  // every core has its own id for save states (a browser-emulator state can't be loaded here)
  assert.equal(new Set(Object.values(NATIVE_CORES).map((c) => c.id)).size, 3);
});

test('the commands a page may send: known types, sane sizes, nothing left over', () => {
  const ok = Buffer.concat([command(NCMD.INPUT, Buffer.alloc(17)), command(NCMD.SPEED, Buffer.from(new Float32Array([2]).buffer)), command(NCMD.WRITE, Buffer.concat([u32(0x02000000), Buffer.from([1, 2])])), command(NCMD.STEP, u32(10)), command(NCMD.RESYNC)]);
  assert.equal(checkNativeCommands(ok), ok);
  const bad = [
    command(99), // unknown
    command(NCMD.INPUT, Buffer.alloc(3)), // too short
    command(NCMD.SPEED, Buffer.alloc(8)), // too long
    command(NCMD.WRITE, u32(5)), // an address, no bytes
    command(NCMD.WRITE, Buffer.alloc(4 + 65537)), // more than 64 KB
    command(NCMD.SRAM, Buffer.alloc(0)), // an empty save
    command(NCMD.QUIT, Buffer.alloc(1)),
    Buffer.concat([command(NCMD.RESET), Buffer.from([1, 2, 3])]), // a cut-off message after it
    Buffer.alloc(0),
  ];
  for (const b of bad) assert.throws(() => checkNativeCommands(b), (e) => e.code === 'badCommand' || /Befehl/.test(e.message));
});

/** A stand-in host: records how it was started and what it was sent. */
function fakeSpawn(calls) {
  return (exe, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGKILL');
    child.sent = [];
    child.stdin.on('data', (d) => child.sent.push(d));
    calls.push({ exe, args, child });
    return child;
  };
}

test('a session: the battery save goes to the host as a file, commands are checked, one session at a time', () => {
  const calls = [];
  const s = new NativeSessions({ spawn: fakeSpawn(calls) });
  const tools = { host: '/t/retrohost', cores: { gb: '/t/gambatte' } };
  const id = s.startNative({ rom: '/r/red.gb', key: 'solo-red', system: 'gb', tools, save: Buffer.from([1, 2, 3, 4]) });
  const args = calls[0].args;
  const sram = args[args.indexOf('--sram') + 1];
  assert.equal(sram, join(nativeSaveDir('solo-red'), 'boot.sav'));
  assert.deepEqual([...readFileSync(sram)], [1, 2, 3, 4]);
  s.send(id, command(NCMD.RESET));
  assert.throws(() => s.send(id, command(77)), /Befehl/);
  assert.throws(() => s.send('nope', command(NCMD.RESET)), /Keine laufende Sitzung/);
  // no save the next time: the old one doesn't come back
  s.startNative({ rom: '/r/red.gb', key: 'solo-red', system: 'gb', tools, save: null });
  assert.ok(!calls[1].args.includes('--sram'));
  assert.equal(existsSync(sram), false);
  // the first host was told to quit
  assert.ok(Buffer.concat(calls[0].child.sent).includes(command(NCMD.QUIT)));
  assert.throws(() => s.startNative({ rom: 'r', key: 'k', system: 'nds', tools }), /fehlt/);
  assert.throws(() => s.startNative({ rom: 'r', key: 'k', system: 'gb', tools, save: Buffer.alloc(5 * 1024 * 1024) }), /zu groß/);
  // the battery save is kept for a page that connects late, like events and save states
  assert.ok(s.keepTypes.includes(9));
  s.stop();
});

// ---- the real host --------------------------------------------------------------------------------------------------
const hosts = []; // the real hosts started here – killed when a test failed half way
test.after(() => hosts.forEach((p) => p.exitCode === null && p.kill('SIGKILL')));
const toolsDir = nativeDirs().find((d) => existsSync(join(d, EXE)) && existsSync(join(d, `gambatte_libretro.${EXT}`)));

/**
 * A 32 KB Game Boy ROM (MBC1 + 8 KB battery RAM): it switches the cartridge RAM on, then counts up 0xC000 forever and
 * copies it to 0xA000 – RAM and the battery save change all the time; 0xA001 on is never written.
 */
function testRom() {
  const r = Buffer.alloc(0x8000);
  r.set([0x00, 0xc3, 0x50, 0x01], 0x100); // nop; jp 0x0150
  r.write('SOULDEWTEST', 0x134, 'latin1');
  r[0x147] = 0x03; // MBC1 + RAM + battery
  r[0x148] = 0x00; // 32 KB
  r[0x149] = 0x02; // 8 KB RAM
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - r[i] - 1) & 0xff;
  r[0x14d] = x;
  // ld a,0x0A; ld (0x0000),a; ld hl,0xC000; loop: inc (hl); ld a,(hl); ld (0xA000),a; jr loop
  r.set([0x3e, 0x0a, 0xea, 0x00, 0x00, 0x21, 0x00, 0xc0, 0x34, 0x7e, 0xea, 0x00, 0xa0, 0x18, 0xf9], 0x150);
  return r;
}

/** The host on the test ROM, spoken to like the page does. */
function startHost(dir, { sram } = {}) {
  const rom = join(dir, 'test.gb');
  writeFileSync(rom, testRom());
  const args = hostArgs({ system: 'gb', core: join(toolsDir, `gambatte_libretro.${EXT}`), rom, saveDir: dir, systemDir: dir, sram });
  const p = spawn(join(toolsDir, EXE), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const h = { p, events: [], ram: new Map(), states: [], srams: [], video: 0, waiters: [], exit: new Promise((res) => p.on('exit', (code) => res(code))) };
  let buf = Buffer.alloc(0);
  p.stderr.on('data', () => {});
  p.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    const { messages, rest } = splitMessages(buf);
    buf = Buffer.from(rest);
    for (const m of messages) {
      if (m.type === 7) h.events.push(JSON.parse(m.payload.toString()));
      if (m.type === 2) h.video++;
      if (m.type === 5) h.states.push(Buffer.from(m.payload));
      if (m.type === 9) h.srams.push(Buffer.from(m.payload));
      if (m.type === 8) {
        const n = m.payload.readUInt32LE(0);
        let o = 4;
        for (let i = 0; i < n; i++) {
          const addr = m.payload.readUInt32LE(o);
          const len = m.payload.readUInt32LE(o + 4);
          h.ram.set(addr, Buffer.from(m.payload.subarray(o + 8, o + 8 + len)));
          o += 8 + len;
        }
      }
    }
    for (const w of h.waiters.splice(0)) if (!w()) h.waiters.push(w);
  });
  h.send = (type, payload) => p.stdin.write(command(type, payload));
  h.until = (cond, ms = 10000) => new Promise((res, rej) => {
    if (cond()) return res();
    const t = setTimeout(() => rej(new Error(`timeout: ${cond}`)), ms);
    h.waiters.push(() => (cond() ? (clearTimeout(t), res(), true) : false));
  });
  h.read = (addr, len) => {
    for (const [a, b] of h.ram) if (addr >= a && addr + len <= a + b.length) return b.subarray(addr - a, addr - a + len);
    return null;
  };
  return h;
}

test('the real host: RAM mirror, exact steps, cheats, save states, the battery save – and a broken stream', { skip: !toolsDir && 'native part not built (npm run native)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-native-host-'));
  try {
    const boot = join(dir, 'boot.sav');
    const given = Buffer.alloc(8192, 0x5a);
    writeFileSync(boot, given);
    const h = startHost(dir, { sram: boot });
    hosts.push(h.p);
    await h.until(() => h.events.some((e) => e.event === 'loaded'));
    const loaded = h.events.find((e) => e.event === 'loaded');
    assert.deepEqual(loaded.ram, [{ addr: 0xc000, len: 0x2000, ok: true }]);
    assert.equal(loaded.saveSize, 8192);

    // exact steps: paused afterwards, the frame count is what was asked for
    h.send(NCMD.STEP, u32(30));
    await h.until(() => h.events.some((e) => e.event === 'stepped'));
    // (the host runs from its start at normal speed – the step counts from wherever it was)
    const first = h.events.find((e) => e.event === 'stepped').frame;
    assert.ok(first >= 30 && first < 60, String(first));
    await h.until(() => h.read(0xc000, 1) !== null);
    const c1 = h.read(0xc000, 1)[0];
    h.send(NCMD.STEP, u32(3));
    await h.until(() => h.events.filter((e) => e.event === 'stepped').length === 2);
    assert.equal(h.events.filter((e) => e.event === 'stepped')[1].frame, first + 3); // paused in between, exactly 3
    await h.until(() => h.read(0xc000, 1)[0] !== c1); // the counter moved on – the mirror follows
    assert.ok(h.video > 0);

    // a cheat inside the RAM, one outside it
    h.send(NCMD.WRITE, Buffer.concat([u32(0xc100), Buffer.from([7, 8, 9])]));
    h.send(NCMD.WRITE, Buffer.concat([u32(0x9000), Buffer.from([1])]));
    await h.until(() => h.events.filter((e) => e.event === 'written').length === 2);
    const w = h.events.filter((e) => e.event === 'written');
    assert.deepEqual(w.map((e) => e.ok), [true, false]);
    await h.until(() => h.read(0xc100, 3)?.equals(Buffer.from([7, 8, 9])));

    // the battery save: the one given at the start is in the core (0xA001 is never written by the ROM)
    h.send(NCMD.FLUSH);
    await h.until(() => h.srams.length >= 1);
    const s1 = h.srams.at(-1);
    assert.equal(s1.length, 8192);
    assert.equal(s1[1], 0x5a);
    assert.notEqual(s1[0], 0x5a); // the game wrote its counter there

    // a save state, then back to it
    h.send(NCMD.SAVE);
    await h.until(() => h.states.length === 1);
    assert.ok(h.states[0].length > 1000);
    h.send(NCMD.LOAD, h.states[0]);
    await h.until(() => h.events.some((e) => e.event === 'stateLoaded'));
    assert.equal(h.events.find((e) => e.event === 'stateLoaded').ok, true);
    h.send(NCMD.LOAD, Buffer.from('not a state'));
    await h.until(() => h.events.filter((e) => e.event === 'stateLoaded').length === 2);
    assert.equal(h.events.filter((e) => e.event === 'stateLoaded')[1].ok, false); // refused, the game goes on

    // another battery save given later: the game starts over with it
    const steps = h.events.filter((e) => e.event === 'stepped').length;
    h.send(NCMD.SRAM, Buffer.alloc(8192, 0x33));
    h.send(NCMD.STEP, u32(2));
    await h.until(() => h.events.filter((e) => e.event === 'stepped').length > steps);
    h.send(NCMD.FLUSH);
    await h.until(() => h.srams.some((b) => b[1] === 0x33));

    // runs at speed and reports it
    h.send(NCMD.SPEED, Buffer.from(new Float32Array([1000]).buffer));
    await h.until(() => h.events.some((e) => e.event === 'stats' && e.speed > 1.5), 15000);

    // a header that announces more than the host takes: it ends cleanly (as when souldew goes away)
    h.p.stdin.write(Buffer.concat([u32(1), u32(0x7fffffff)]));
    assert.equal(await h.exit, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real host: QUIT hands over the last battery save; a ROM it can\'t load is an error event', { skip: !toolsDir && 'native part not built (npm run native)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sls-native-host-'));
  try {
    const h = startHost(dir);
    hosts.push(h.p);
    await h.until(() => h.events.some((e) => e.event === 'loaded'));
    h.send(NCMD.STEP, u32(10));
    await h.until(() => h.events.some((e) => e.event === 'stepped'));
    h.send(NCMD.QUIT);
    assert.equal(await h.exit, 0);
    assert.ok(h.srams.length >= 1); // the counter changed the save: it came before the host left

    const bad = join(dir, 'bad.gb');
    writeFileSync(bad, Buffer.alloc(16));
    const p = spawn(join(toolsDir, EXE), ['--core', join(toolsDir, `gambatte_libretro.${EXT}`), '--rom', bad, '--system', dir, '--save', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    p.stdout.on('data', (c) => (out = Buffer.concat([out, c])));
    p.stderr.on('data', () => {});
    const code = await new Promise((res) => p.on('exit', res));
    assert.equal(code, 1);
    const ev = splitMessages(out).messages.filter((m) => m.type === 7).map((m) => JSON.parse(m.payload.toString()));
    assert.ok(ev.some((e) => e.event === 'error'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
