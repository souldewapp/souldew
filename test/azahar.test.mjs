// Azahar (3DS): the RPC client against a stand-in RPC server (the protocol of src/core/rpc/packet.h), the bridge that
// turns it into live frames, switching the RPC server on in qt-config.ini, and installing / launching Azahar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AzaharRpc, AzaharBridge, packet, parseReply, parseProcessList, withRpcEnabled, rpcEnabledIn, configCandidates, configPath, enableRpc, readRpcSetting, portableUserDir, TYPE, MAX_DATA } from '../server/lib/azahar.mjs';
import { pickAsset, assetPatterns, EMULATORS, validCustomPath, linuxSystemPaths, windowsSystemPaths } from '../server/lib/emulator.mjs';
import { encryptPK6, SLOT_STRIDE, STATS_OFFSET, BOX_SIZE, PARTY_BYTES } from '../shared/live/gen67.mjs';
import { findEntry, readLiveParty, regionReader } from '../shared/live/parse.mjs';

const addresses = JSON.parse(readFileSync(new URL('../shared/data/addresses.json', import.meta.url), 'utf8'));
const TMP = mkdtempSync(join(tmpdir(), 'sls-azahar-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

/**
 * A stand-in for Azahar's RPC server: version-2 packets, a process list, a selected process and its memory
 * ({ pid: { address: bytes } }). `drop` = how many requests to ignore (a lost UDP packet).
 */
async function fakeAzahar({ processes = [], memory = {}, drop = 0, version = 2 } = {}) {
  const s = createSocket('udp4');
  const st = { selected: 0xffffffff, requests: [], drop };
  s.on('message', (msg, rinfo) => {
    const h = { version: msg.readUInt32LE(0), id: msg.readUInt32LE(4), type: msg.readUInt32LE(8), size: msg.readUInt32LE(12) };
    const a = msg.readUInt32LE(16);
    const b = msg.readUInt32LE(20);
    st.requests.push({ type: h.type, a, b });
    if (st.drop > 0) {
      st.drop--;
      return;
    }
    let data = Buffer.alloc(0);
    if (h.version !== 2) data = Buffer.alloc(0);
    else if (h.type === TYPE.ProcessList) {
      const list = processes.slice(a, a + b);
      data = Buffer.alloc(4 + list.length * 0x14);
      data.writeUInt32LE(list.length, 0);
      list.forEach((p, i) => {
        const o = 4 + i * 0x14;
        data.writeUInt32LE(p.pid, o);
        data.writeUInt32LE(parseInt(p.titleId.slice(8), 16), o + 4);
        data.writeUInt32LE(parseInt(p.titleId.slice(0, 8), 16), o + 8);
        data.write(p.name, o + 12, 'latin1');
      });
    } else if (h.type === TYPE.SetGetProcess) {
      if (a === 0) {
        data = Buffer.alloc(4);
        data.writeUInt32LE(st.selected, 0);
      } else st.selected = b;
    } else if (h.type === TYPE.ReadMemory) {
      data = Buffer.alloc(b); // unmapped memory reads as zeros
      for (const [addr, bytes] of Object.entries(memory[st.selected] || {})) {
        const at = a - Number(addr);
        for (let i = 0; i < b; i++) if (at + i >= 0 && at + i < bytes.length) data[i] = bytes[at + i];
      }
    }
    const out = Buffer.alloc(16);
    out.writeUInt32LE(version, 0);
    out.writeUInt32LE(h.id, 4);
    out.writeUInt32LE(h.type, 8);
    out.writeUInt32LE(data.length, 12);
    s.send(Buffer.concat([out, data]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  s.setSendBufferSize(64 * 1024); // like Azahar (udp_server.cpp EnsureBufferSize) – 32 KiB replies
  return { port: s.address().port, st, close: () => s.close() };
}

const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
function party(...names) {
  const r = new Uint8Array(PARTY_BYTES);
  names.forEach((nick, i) => {
    const d = new Uint8Array(BOX_SIZE + 0x1c);
    d[0] = i + 1;
    w16(d, 0x08, 650 + i);
    d[0x18] = 0x40 + i;
    for (let k = 0; k < nick.length; k++) w16(d, 0x40 + k * 2, nick.charCodeAt(k));
    d[0xec] = 5;
    w16(d, 0xf0, 20);
    w16(d, 0xf2, 20);
    const e = encryptPK6(d);
    r.set(e.subarray(0, BOX_SIZE), i * SLOT_STRIDE);
    r.set(e.subarray(BOX_SIZE), i * SLOT_STRIDE + STATS_OFFSET);
  });
  return r;
}

test('packets: version-2 header, replies checked for size, process list entries', () => {
  const p = packet(0xdeadbeef, TYPE.ReadMemory, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(p.length, 24);
  assert.equal(p.readUInt32LE(0), 2);
  assert.equal(p.readUInt32LE(4), 0xdeadbeef);
  assert.equal(p.readUInt32LE(12), 8);
  assert.equal(parseReply(Buffer.alloc(8)), null);
  const r = Buffer.alloc(20);
  r.writeUInt32LE(2, 0);
  r.writeUInt32LE(4, 12);
  assert.equal(parseReply(r).data.length, 4);
  r.writeUInt32LE(9, 12); // claims more than it carries
  assert.equal(parseReply(r), null);
  const list = Buffer.alloc(4 + 0x14);
  list.writeUInt32LE(1, 0);
  list.writeUInt32LE(0x31, 4);
  list.writeUInt32LE(0x00055d00, 8);
  list.writeUInt32LE(0x00040000, 12);
  list.write('kujira-1', 16, 'latin1');
  assert.deepEqual(parseProcessList(list), [{ pid: 0x31, titleId: '0004000000055D00', name: 'kujira-1' }]);
});

test('the RPC client: process list, selecting the game, reads above 32 KiB, a lost packet, nobody listening', async () => {
  const big = new Uint8Array(MAX_DATA + 5000).map((_, i) => i & 0xff);
  const az = await fakeAzahar({
    processes: [{ pid: 2, titleId: '0004013000001502', name: 'fs' }, { pid: 0x31, titleId: '0004000000055D00', name: 'kujira-1' }],
    memory: { 0x31: { 0x08000000: big } },
  });
  const rpc = new AzaharRpc({ port: az.port, timeout: 200 });
  try {
    assert.equal((await rpc.processList()).length, 2);
    assert.equal(await rpc.selectedProcess(), 0xffffffff);
    assert.ok(await rpc.selectProcess(0x31));
    assert.equal(await rpc.selectedProcess(), 0x31);
    const got = await rpc.read(0x08000000, big.length);
    assert.deepEqual(new Uint8Array(got), big);
    assert.equal(az.st.requests.filter((r) => r.type === TYPE.ReadMemory).length, 2, 'two requests of at most 32 KiB');
    az.st.drop = 1; // a lost UDP packet: that request times out, the next one works
    assert.equal(await rpc.read(0x08000000, 4), null);
    assert.ok(await rpc.read(0x08000000, 4));
  } finally {
    rpc.close();
    az.close();
  }
  // nobody listening (Azahar closed, RPC server off): null after the timeout, no exception
  const none = new AzaharRpc({ port: az.port, timeout: 100 });
  assert.equal(await none.processList(), null);
  none.close();
});

test('the RPC client ignores replies from older servers (version 1) and from other addresses', async () => {
  const old = await fakeAzahar({ processes: [{ pid: 1, titleId: '0004000000055D00', name: 'x' }], version: 1 });
  const rpc = new AzaharRpc({ port: old.port, timeout: 100 });
  assert.equal(await rpc.processList(), null);
  rpc.close();
  old.close();
});

test('the bridge: not connected → connected without a game → an unknown game → a game souldew reads', async () => {
  const frames = [];
  const statuses = [];
  const emit = (ev, d) => (ev === 'live' ? frames.push(d) : statuses.push(d));
  // nothing listening
  const off = new AzaharBridge(emit, { rpc: new AzaharRpc({ port: 9, timeout: 80 }), table: addresses });
  assert.ok((await off.poll()) >= 2000);
  assert.equal(off.state.connected, false);
  off.stop();

  const procs = [{ pid: 1, titleId: '0004013000002C02', name: 'nim' }];
  const az = await fakeAzahar({ processes: procs, memory: { 0x40: { 0x34195e10: party('Rowlet', 'Pikipek') } } });
  const bridge = new AzaharBridge(emit, { rpc: new AzaharRpc({ port: az.port, timeout: 300 }), table: addresses });
  try {
    await bridge.poll();
    assert.equal(bridge.state.connected, true);
    assert.equal(bridge.state.game, null, 'only system modules run: the HOME menu');
    // homebrew from a .3dsx: no title ID (Azahar reports 0)
    procs.push({ pid: 0x11, titleId: '0000000000000000', name: 'Checkpoi' });
    await bridge.poll();
    assert.equal(bridge.state.game.title, 'Checkpoi');
    assert.equal(bridge.state.supported, false);
    procs.pop();
    // a game souldew has no data for (Mario Kart 7)
    procs.push({ pid: 0x30, titleId: '0004000000030800', name: 'kart' });
    await bridge.poll();
    assert.equal(bridge.state.supported, false);
    assert.equal(bridge.state.game.titleId, '0004000000030800');
    assert.equal(frames.length, 0);
    // Pokémon Sun
    procs.splice(1, 1, { pid: 0x40, titleId: '0004000000164800', name: 'niji_loc' });
    assert.equal(await bridge.poll(), 500);
    assert.equal(bridge.state.supported, true);
    assert.equal(bridge.state.game.entryId, 'sm');
    assert.equal(az.st.selected, 0x40, 'reads go to the game process, not a system module');
    const f = frames.at(-1);
    assert.equal(f.source, 'azahar');
    // what the page does with the frame (web/views/play.mjs ExternalPlay)
    const entry = findEntry(addresses, f.game);
    const res = readLiveParty(entry, regionReader(f.regions), null, {});
    assert.deepEqual(res.party.map((m) => [m.nickname, m.species]), [['Rowlet', 650], ['Pikipek', 651]]);
    // Azahar closed: back to not connected
    az.close();
    bridge.rpc.timeout = 80;
    await bridge.poll();
    assert.equal(bridge.state.connected, false);
    assert.ok(statuses.length >= 3, 'status changes are pushed to the page');
  } finally {
    bridge.stop();
  }
});

test('qt-config.ini: switching the RPC server on keeps everything else (and the line endings)', () => {
  assert.equal(withRpcEnabled(''), '[Debugging]\nenable_rpc_server\\default=false\nenable_rpc_server=true\n');
  const ini = '[Layout]\nlayout_option=0\n\n[Debugging]\nrecord_frame_times=false\nenable_rpc_server\\default=true\nenable_rpc_server=false\n\n[WebService]\nenable_telemetry=false\n';
  const on = withRpcEnabled(ini);
  assert.ok(rpcEnabledIn(on));
  assert.ok(!rpcEnabledIn(ini));
  assert.match(on, /\[Debugging\]\nrecord_frame_times=false\nenable_rpc_server\\default=false\nenable_rpc_server=true\n\n\[WebService\]/);
  assert.match(on, /^\[Layout\]\nlayout_option=0\n/);
  assert.equal(withRpcEnabled(on), on, 'twice is the same as once');
  // a [Debugging] section without the keys, Windows line endings
  const crlf = withRpcEnabled('[Debugging]\r\nuse_gdbstub=false\r\n[UI]\r\nx=1\r\n');
  assert.equal(crlf, '[Debugging]\r\nuse_gdbstub=false\r\nenable_rpc_server\\default=false\r\nenable_rpc_server=true\r\n[UI]\r\nx=1\r\n');
  assert.ok(!rpcEnabledIn('[Other]\nenable_rpc_server=true\n'), 'only in [Debugging]');
});

test('where Azahar keeps its settings, per system – and in its portable folder next to the program', () => {
  const home = '/home/u';
  assert.deepEqual(configCandidates({ platform: 'linux', env: {}, home }), ['/home/u/.config/azahar-emu/qt-config.ini', '/home/u/.var/app/org.azahar_emu.Azahar/config/azahar-emu/qt-config.ini']);
  assert.equal(configCandidates({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x' }, home })[0], '/x/azahar-emu/qt-config.ini');
  assert.equal(configCandidates({ platform: 'darwin', env: {}, home: '/Users/u' })[1], '/Users/u/Library/Application Support/Azahar/config/qt-config.ini');
  assert.equal(configPath({ platform: 'darwin', env: { XDG_CONFIG_HOME: join(TMP, 'nope') }, home: '/Users/u' }), '/Users/u/Library/Application Support/Azahar/config/qt-config.ini');
  assert.match(configCandidates({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' })[0], /Azahar[\\/]config[\\/]qt-config\.ini$/);
  // portable: a "user" folder next to Azahar.app (macOS – Azahar starts in the .app's folder) / azahar.exe (Windows)
  const dir = join(TMP, 'azahar-macos-universal');
  mkdirSync(join(dir, 'Azahar.app'), { recursive: true });
  assert.equal(portableUserDir(join(dir, 'Azahar.app'), 'darwin'), null, 'no user folder: not portable');
  mkdirSync(join(dir, 'user'));
  assert.equal(portableUserDir(join(dir, 'Azahar.app'), 'darwin'), join(dir, 'user'));
  assert.equal(portableUserDir(join(dir, 'Azahar.app') + '/', 'darwin'), join(dir, 'user'));
  assert.equal(portableUserDir(join(dir, 'azahar.exe'), 'win32'), join(dir, 'user'));
  assert.equal(portableUserDir(join(dir, 'azahar.AppImage'), 'linux'), null, 'Linux: the working directory decides');
  assert.equal(portableUserDir(null, 'darwin'), null);
  assert.equal(configPath({ emuPath: join(dir, 'Azahar.app'), platform: 'darwin' }), join(dir, 'user', 'config', 'qt-config.ini'));
  // switching it on writes there – a real Azahar setup in the home folder is never touched by this test
  const emuPath = join(dir, 'Azahar.app');
  assert.equal(readRpcSetting({ emuPath, platform: 'darwin' }).enabled, false);
  mkdirSync(join(dir, 'user', 'config'), { recursive: true });
  writeFileSync(join(dir, 'user', 'config', 'qt-config.ini'), '[UI]\ntheme=dark\n');
  enableRpc({ emuPath, platform: 'darwin' });
  assert.equal(readRpcSetting({ emuPath, platform: 'darwin' }).enabled, true);
  assert.match(readFileSync(join(dir, 'user', 'config', 'qt-config.ini'), 'utf8'), /^\[UI\]\ntheme=dark\n\n\[Debugging\]\n/);
  // the bridge reports the setting of the Azahar it was given
  const bridge = new AzaharBridge(() => {}, { rpc: new AzaharRpc({ port: 9, timeout: 50 }), emuPath: () => emuPath });
  assert.equal(bridge.status().setting.path, join(dir, 'user', 'config', 'qt-config.ini'));
  assert.equal(bridge.status().setting.enabled, true);
});

test('installing Azahar: the right file of its release on every system', () => {
  // the files of Azahar 2126.2 (github.com/azahar-emu/azahar/releases/tag/2126.2)
  const assets = ['azahar-android-googleplay-2126.2.apk', 'azahar-libretro-macos-arm64-2126.2.zip', 'azahar-libretro-windows-x86_64-2126.2.zip',
    'azahar-libretro-linux-x86_64-2126.2.zip', 'azahar-macos-arm64-2126.2.zip', 'azahar-macos-universal-2126.2.zip', 'azahar-macos-x86_64-2126.2.zip',
    'azahar-room-x86_64-2126.2.dockerimage', 'azahar-unified-source-2126.2.tar.xz', 'azahar-windows-msvc-2126.2-installer.exe', 'azahar-windows-msvc-2126.2.zip',
    'azahar-windows-msys2-2126.2-installer.exe', 'azahar-windows-msys2-2126.2.zip', 'azahar-windows-mxe-2126.2.zip', 'azahar.AppImage'].map((name) => ({ name }));
  assert.equal(pickAsset(assets, 'azahar', 'darwin', 'arm64').name, 'azahar-macos-universal-2126.2.zip');
  assert.equal(pickAsset(assets, 'azahar', 'darwin', 'x64').name, 'azahar-macos-universal-2126.2.zip');
  assert.equal(pickAsset(assets, 'azahar', 'win32', 'x64').name, 'azahar-windows-msvc-2126.2.zip');
  assert.equal(pickAsset(assets, 'azahar', 'win32', 'arm64').name, 'azahar-windows-msvc-2126.2.zip', 'Windows on ARM runs the x64 build');
  assert.equal(pickAsset(assets, 'azahar', 'linux', 'x64').name, 'azahar.AppImage');
  assert.equal(pickAsset(assets, 'azahar', 'linux', 'arm64').name, 'azahar.AppImage');
  assert.deepEqual(assetPatterns('azahar', 'freebsd'), []);
  assert.equal(EMULATORS.azahar.live, 'rpc');
  assert.deepEqual(EMULATORS.azahar.systems, ['3ds']);
  assert.ok(EMULATORS.azahar.exe.test('azahar.exe') && EMULATORS.azahar.exe.test('azahar.AppImage') && EMULATORS.azahar.exe.test('org.azahar_emu.Azahar'));
  assert.ok(!EMULATORS.azahar.exe.test('sh'));
  assert.ok(linuxSystemPaths('azahar', '/home/u').includes('/home/u/.local/share/flatpak/exports/bin/org.azahar_emu.Azahar'));
  assert.ok(windowsSystemPaths('azahar', { ProgramFiles: 'C:\\Program Files' }).some((p) => /Azahar[\\/]azahar\.exe$/.test(p)));
  // a chosen path must look like Azahar
  const fake = join(TMP, 'tool.sh');
  writeFileSync(fake, '#!/bin/sh\n');
  assert.equal(validCustomPath('azahar', fake), null);
});
