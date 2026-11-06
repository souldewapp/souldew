// Windows support: file names, paths, archives (zip / 7z), "Search my PC", emulator downloads, Java, shortcuts.
// Everything here runs on every OS – Windows path rules are tested with path.win32 – and on the Windows CI runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFileName, isInside, renameRetry, samePath } from '../server/lib/fsutil.mjs';
import { read7z, bcjX86Decode, bcj2Decode } from '../server/lib/sevenzip.mjs';
import { extractArchive, extractArchiveAsync, entryTarget } from '../server/lib/archive.mjs';
import { discoverCandidates, discoverRoots, discoverRoms, onlineOnly } from '../server/lib/library.mjs';
import { assetPatterns, pickAsset, windowsSystemPaths, revealCommand, EMULATORS } from '../server/lib/emulator.mjs';
import { windowsJavaCandidates, JAVA_OPTS } from '../server/lib/toolchain.mjs';
import { titleBarColors } from '../electron/guards.mjs';
import { decodeLzma2 } from '../shared/xz.mjs';
import { crc32 } from '../shared/checksum.mjs';
import { detectPlatform, shortcut, shortPath } from '../web/lib/platform.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-win-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
const FIX = fileURLToPath(new URL('./fixtures/7z/', import.meta.url));

// ---- file names and paths ----------------------------------------------------------------
test('safeFileName: valid on Windows, macOS and Linux', () => {
  assert.equal(safeFileName('Pokémon: Feuerrot?.gba'), 'Pokémon_ Feuerrot_.gba');
  assert.equal(safeFileName('a<b>c|d"e*f.nds'), 'a_b_c_d_e_f.nds');
  assert.equal(safeFileName('dir\\sub/name.gb'), 'name.gb');
  assert.equal(safeFileName('trailing dots... '), 'trailing dots');
  assert.equal(safeFileName('con'), '_con');
  assert.equal(safeFileName('NUL.txt'), '_NUL.txt');
  assert.equal(safeFileName('com1.gba'), '_com1.gba');
  assert.equal(safeFileName('console.gba'), 'console.gba'); // only the exact device names are reserved
  assert.equal(safeFileName('tab\there\u0001.gb'), 'tab_here_.gb');
  assert.equal(safeFileName('Pok\u0065\u0301mon.gb'), 'Pokémon.gb'); // composed (NFC)
  assert.equal(safeFileName(''), '_');
  assert.equal(safeFileName('...', { fallback: 'rom.nds' }), 'rom.nds');
  const long = safeFileName(`${'ä'.repeat(300)}.nds`);
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.nds'), long);
  // Windows also reserves these, and "CON .txt" (spaces before the dot) is still CON
  assert.equal(safeFileName('CON .txt'), '_CON .txt');
  assert.equal(safeFileName('CONIN$'), '_CONIN$');
  assert.equal(safeFileName('conout$.log'), '_conout$.log');
  assert.equal(safeFileName('ab\u202Egnp.exe'), 'ab_gnp.exe'); // no right-to-left tricks
  // cut to length: never ending in a dot or space (Windows would drop them and change the name)
  for (const name of [`${'a'.repeat(198)}.b${'c'.repeat(30)}`, `${'a'.repeat(199)}. x`, `${'a'.repeat(199)} .x`, `${'b'.repeat(197)}...${'c'.repeat(40)}`]) {
    const out = safeFileName(name);
    assert.ok(Buffer.byteLength(out) <= 200 && !/[. ]$/.test(out), JSON.stringify(out));
  }
});

test('samePath: case-insensitive on Windows only', () => {
  assert.ok(samePath('C:\\Users\\Ana\\Library', 'c:\\users\\ana\\library\\', 'win32'));
  assert.ok(!samePath('C:\\Users\\Ana\\Library', 'C:\\Users\\Ana', 'win32'));
  assert.ok(samePath('/Users/ana/Library/', '/Users/ana/Library', 'darwin'));
  assert.ok(!samePath('/Users/ana/library', '/Users/ana/Library', 'linux'));
});

test('isInside: Windows drive roots and case-insensitivity, POSIX as before', () => {
  assert.ok(isInside('D:\\ROMs\\game.nds', 'D:\\', 'win32')); // a whole drive as library folder
  assert.ok(isInside('c:\\users\\ana\\Library\\x.gba', 'C:\\Users\\Ana\\Library', 'win32'));
  assert.ok(!isInside('C:\\Users\\Ana\\Library2\\x.gba', 'C:\\Users\\Ana\\Library', 'win32'));
  assert.ok(!isInside('C:\\Users\\Ana\\Library', 'C:\\Users\\Ana\\Library', 'win32'));
  assert.ok(!isInside('C:\\Users\\Ana\\Library\\..\\secret.txt', 'C:\\Users\\Ana\\Library', 'win32'));
  assert.ok(!isInside('D:\\x.nds', 'C:\\', 'win32'));
  assert.ok(isInside('\\\\nas\\share\\roms\\a.gb', '\\\\nas\\share', 'win32'));
  assert.ok(isInside('/Users/a/Library/x.gba', '/Users/a/Library', 'darwin'));
  assert.ok(!isInside('/Users/a/Library2/x.gba', '/Users/a/Library', 'darwin'));
  assert.ok(isInside('/Volumes/USB/x.gba', '/', 'darwin'));
  assert.ok(isInside('/Users/a/Library/..foo', '/Users/a/Library', 'darwin')); // a name starting with '..' is fine
});

test('renameRetry rides out short Windows locks and gives up eventually', () => {
  let calls = 0;
  const flaky = () => {
    if (++calls < 3) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };
  renameRetry('a', 'b', { platform: 'win32', rename: flaky });
  assert.equal(calls, 3);
  calls = 0;
  assert.throws(() => renameRetry('a', 'b', { platform: 'darwin', rename: flaky }), /EPERM/); // no retries elsewhere
  assert.equal(calls, 1);
  const locked = () => {
    calls++;
    throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  };
  calls = 0;
  assert.throws(() => renameRetry('a', 'b', { platform: 'win32', rename: locked }), /EBUSY/);
  assert.equal(calls, 11);
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.throws(() => renameRetry('a', 'b', { platform: 'win32', rename: missing }), /ENOENT/);
});

// ---- 7z ------------------------------------------------------------------------------------
/** The files inside test/fixtures/7z/*.7z (made with bsdtar: LZMA, LZMA2, Deflate and stored). */
function fixtureData() {
  let x = 1;
  const data = new Uint8Array(3000);
  for (let i = 0; i < data.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    data[i] = (x >> 16) & 0xff;
  }
  return data;
}

test('read7z unpacks LZMA, LZMA2, Deflate and stored archives with folders, empty and Unicode files', () => {
  for (const name of ['lzma1.7z', 'lzma2.7z', 'deflate.7z', 'store.7z']) {
    const entries = read7z(readFileSync(join(FIX, name)));
    const files = Object.fromEntries(entries.filter((e) => !e.dir).map((e) => [e.name, Buffer.from(e.data)]));
    assert.deepEqual(entries.filter((e) => e.dir).map((e) => e.name).sort(), ['a', 'a/sub'], name);
    assert.equal(files['a/hello.txt'].toString(), 'Hello souldew\n'.repeat(50), name);
    assert.equal(files['a/empty.bin'].length, 0, name);
    assert.equal(files['Pokémon – ümlaut.txt'].toString(), 'Glurak ♂ é\n', name);
    assert.deepEqual(files['data.bin'], Buffer.from(fixtureData()), name);
  }
});

test('read7z refuses damaged and foreign data instead of unpacking garbage', () => {
  const good = readFileSync(join(FIX, 'store.7z'));
  assert.throws(() => read7z(Buffer.from('PK\x03\x04 not a 7z at all, just some bytes')), (e) => e.code === 'BAD_7Z');
  assert.throws(() => read7z(good.subarray(0, 200)), (e) => e.code === 'BAD_7Z'); // truncated
  const flipped = Buffer.from(good);
  flipped[40] ^= 0xff; // inside the stored hello.txt → its CRC no longer matches
  assert.throws(() => read7z(flipped), (e) => e.code === 'BAD_7Z' && /CRC/.test(e.message));
});

/** A minimal .7z: one file 'a' in one folder with one coder (0x030101 LZMA, or 0x00 stored) – optionally a CRC. */
function tiny7z({ size, packed, coder = 'lzma', crc = null }) {
  const num = (v) => {
    const b = Buffer.alloc(5);
    b[0] = 0xf0;
    b.writeUInt32LE(v, 1);
    return b;
  };
  const name = Buffer.from('a\0', 'utf16le');
  const coderBytes = coder === 'lzma' ? [0x23, 0x03, 0x01, 0x01, 0x05, 0x5d, 0, 0, 0x10, 0] : [0x01, 0x00];
  const crcBytes = crc === null ? [] : [0x0a, 0x01, ...Buffer.from(Uint32Array.of(crc).buffer)];
  const header = Buffer.concat([
    Buffer.from([0x01, 0x04, 0x06, 0x00, 0x01, 0x09, packed.length, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, ...coderBytes, 0x0c]), num(size),
    Buffer.from([...crcBytes, 0x00, 0x00, 0x05, 0x01, 0x11, name.length + 1, 0x00]), name, Buffer.from([0x00, 0x00])]);
  const start = Buffer.alloc(32);
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]).copy(start);
  start.writeBigUInt64LE(BigInt(packed.length), 12);
  start.writeBigUInt64LE(BigInt(header.length), 20);
  return Buffer.concat([start, packed, header]);
}

test('7z bombs: a tiny archive that claims a huge file is refused at once, not decoded from thin air', () => {
  const packed = Buffer.from([0, 0x80, 0x55, 0xaa, 0x13, 0x37, 0, 0, 0, 0]); // ten bytes of "LZMA"
  for (const size of [10_000_000, 1_000_000_000, 2_000_000_000]) {
    const t = Date.now();
    assert.throws(() => read7z(tiny7z({ size, packed })), (e) => e.code === 'BAD_7Z', String(size));
    assert.ok(Date.now() - t < 1000, `${size}: took ${Date.now() - t} ms`);
  }
  // stored data must carry a checksum – and match it
  const hello = Buffer.from('hello souldew');
  assert.throws(() => read7z(tiny7z({ size: hello.length, packed: hello, coder: 'copy' })), (e) => e.code === 'BAD_7Z' && /checksum/.test(e.message));
  assert.throws(() => read7z(tiny7z({ size: hello.length, packed: hello, coder: 'copy', crc: 1 })), (e) => e.code === 'BAD_7Z' && /CRC/.test(e.message));
  const ok = read7z(tiny7z({ size: hello.length, packed: hello, coder: 'copy', crc: crc32(hello) }));
  assert.equal(Buffer.from(ok[0].data).toString(), 'hello souldew');
});

test('LZMA / LZMA2 streams that end early are errors, not zeros', () => {
  const lzma2 = readFileSync(join(FIX, 'bcj-x86.lzma2'));
  assert.throws(() => decodeLzma2(lzma2.subarray(0, 2000), 4096), /ended early/);
  assert.throws(() => decodeLzma2(lzma2.subarray(0, 3), 4096), /ended early/);
});

test('BCJ x86 filter decodes what liblzma (xz) encoded', () => {
  // test/fixtures/7z/bcj-x86.lzma2: Python's lzma.compress(data, FORMAT_RAW, [FILTER_X86, FILTER_LZMA2]) of the data below
  let x = 7;
  const r = () => {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    return (x >> 16) & 0xff;
  };
  const data = new Uint8Array(4096);
  for (let i = 0; i < data.length; i++) data[i] = r();
  for (let i = 0, k = 0; i + 5 < data.length; i += 37, k++) {
    data[i] = k % 3 ? 0xe8 : 0xe9;
    data[i + 1] = r();
    data[i + 2] = r();
    data[i + 3] = r() & 0x0f;
    data[i + 4] = k % 2 ? 0 : 0xff;
  }
  const filtered = decodeLzma2(readFileSync(join(FIX, 'bcj-x86.lzma2')), data.length);
  assert.notDeepEqual(Buffer.from(filtered), Buffer.from(data)); // the filter did change the calls …
  assert.deepEqual(Buffer.from(bcjX86Decode(new Uint8Array(filtered))), Buffer.from(data)); // … and decoding undoes it
});

test('BCJ2: plain bytes pass, converted calls come back relative', () => {
  // main: 0x90, E8 (call), 0x90; call stream: absolute target 0x00001005 (big endian). Range coder input of all
  // 0xff bytes decodes a 1 bit ("this call was converted"), all zeros a 0 bit ("left as it was").
  const main = Uint8Array.of(0x90, 0xe8, 0x90);
  const call = Uint8Array.of(0x00, 0x00, 0x10, 0x05);
  const rc = new Uint8Array(16).fill(0xff);
  const out = bcj2Decode(main, call, new Uint8Array(0), rc, 7);
  // E8 at 1 → operand at 2..5, relative = 0x1005 − (2 + 4) = 0x0fff
  assert.deepEqual([...out], [0x90, 0xe8, 0xff, 0x0f, 0x00, 0x00, 0x90]);
  // bit 0 ("not converted"): code 0 → the E8 stays a plain byte
  assert.deepEqual([...bcj2Decode(main, call, new Uint8Array(0), new Uint8Array(16), 3)], [0x90, 0xe8, 0x90]);
  assert.throws(() => bcj2Decode(main, new Uint8Array(0), new Uint8Array(0), rc, 7), /branch stream/);
});

// ---- extracting downloads ------------------------------------------------------------------
const le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data, crc = crc32(data) } of entries) {
    const n = Buffer.from(name);
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(crc), ...le(data.length), ...le(data.length), n.length, 0, 0, 0]);
    local.push(head, n, Buffer.from(data));
    central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(crc), ...le(data.length), ...le(data.length),
      n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(offset)]), n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...local, cd, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, entries.length, 0, entries.length, 0, ...le(cd.length), ...le(offset), 0, 0])]);
}

test('extractArchive unpacks zip and 7z, keeps folders and checks CRCs', () => {
  const zip = join(TMP, 'melonDS-1.1-windows-x86_64.zip');
  writeFileSync(zip, makeZip([{ name: 'melonDS.exe', data: Buffer.from('MZ melon') }, { name: 'docs\\readme.txt', data: Buffer.from('hi') }]));
  const out = join(TMP, 'x-zip');
  const written = extractArchive(zip, out);
  assert.equal(written.length, 2);
  assert.equal(readFileSync(join(out, 'melonDS.exe'), 'utf8'), 'MZ melon');
  assert.equal(readFileSync(join(out, 'docs', 'readme.txt'), 'utf8'), 'hi'); // Windows separators inside the zip
  const seven = join(TMP, 'x.7z');
  writeFileSync(seven, readFileSync(join(FIX, 'lzma2.7z')));
  const out7 = join(TMP, 'x-7z');
  extractArchive(seven, out7);
  assert.equal(readFileSync(join(out7, 'a', 'hello.txt'), 'utf8'), 'Hello souldew\n'.repeat(50));
  assert.ok(existsSync(join(out7, 'a', 'sub')));
  assert.equal(readFileSync(join(out7, 'a', 'empty.bin')).length, 0);
  // a damaged entry: nothing is "installed" from it
  const bad = join(TMP, 'bad.zip');
  writeFileSync(bad, makeZip([{ name: 'mGBA.exe', data: Buffer.from('MZ'), crc: 1234 }]));
  assert.throws(() => extractArchive(bad, join(TMP, 'x-bad')), /CRC/);
  assert.throws(() => extractArchive(join(TMP, 'x.rar'), join(TMP, 'x-rar')), /Unsupported/);
});

test('extractArchiveAsync unpacks on a worker thread and reports its errors', async () => {
  const seven = join(TMP, 'async.7z');
  writeFileSync(seven, readFileSync(join(FIX, 'lzma1.7z')));
  const out = join(TMP, 'x-async');
  const written = await extractArchiveAsync(seven, out);
  assert.equal(written.length, 4);
  assert.equal(readFileSync(join(out, 'a', 'hello.txt'), 'utf8'), 'Hello souldew\n'.repeat(50));
  const bomb = join(TMP, 'bomb.7z');
  writeFileSync(bomb, tiny7z({ size: 1_000_000_000, packed: Buffer.alloc(10) }));
  await assert.rejects(extractArchiveAsync(bomb, join(TMP, 'x-bomb')), (e) => e.code === 'BAD_7Z');
});

test('archive entries can never land outside the target folder', () => {
  const dest = join(TMP, 'safe');
  for (const evil of ['../evil.exe', 'a/../../evil.exe', '..\\evil.exe', '/etc/passwd', '\\Windows\\evil.dll', 'C:\\Windows\\evil.dll', 'c:evil.exe']) {
    assert.equal(entryTarget(dest, evil), null, evil);
  }
  assert.equal(entryTarget(dest, 'dir/Pokémon: X.nds'), join(dest, 'dir', 'Pokémon_ X.nds'));
  assert.equal(entryTarget(dest, './a//b.txt'), join(dest, 'a', 'b.txt'));
  const zip = join(TMP, 'slip.zip');
  writeFileSync(zip, makeZip([{ name: '../../slip.txt', data: Buffer.from('x') }]));
  assert.throws(() => extractArchive(zip, join(TMP, 'slip-out')), /Unsafe path/);
  assert.ok(!existsSync(join(TMP, 'slip.txt')));
});

// ---- "Search my PC" ------------------------------------------------------------------------
test('Search my PC looks in the Windows places people keep ROMs', () => {
  const env = {
    SystemDrive: 'C:', APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming', OneDrive: 'C:\\Users\\Ana\\OneDrive',
    SLS_USER_DIRS: JSON.stringify(['D:\\Ana\\Downloads', 'relative\\nope', 42]),
  };
  const c = discoverCandidates('C:\\Users\\Ana', { platform: 'win32', env });
  for (const p of ['D:\\Ana\\Downloads', 'C:\\Users\\Ana\\Downloads', 'C:\\Users\\Ana\\Desktop', 'C:\\Users\\Ana\\Documents', 'C:\\Users\\Ana\\OneDrive',
    'C:\\Users\\Ana\\AppData\\Roaming\\RetroArch\\roms', 'C:\\RetroArch-Win64\\roms', 'C:\\RetroBat\\roms', 'C:\\Users\\Ana\\LaunchBox\\Games', 'C:\\ROMs', 'C:\\Users\\Ana\\Emulation']) {
    assert.ok(c.includes(p), p);
  }
  assert.ok(!c.some((p) => p.includes('relative') || p.includes('/')), 'only absolute Windows paths');
  assert.ok(!c.some((p) => /Library|OpenEmu|CloudDocs/.test(p)), 'no Mac places on Windows');
  const mac = discoverCandidates('/Users/ana', { platform: 'darwin', env: {} });
  assert.ok(mac.includes('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs'));
  assert.ok(mac.includes('/Users/ana/Downloads'));
});

test('discoverRoots: only existing folders, each real folder once (ROMs / roms on case-insensitive disks)', () => {
  const home = join(TMP, 'home');
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  mkdirSync(join(home, 'ROMs'), { recursive: true });
  writeFileSync(join(home, 'Desktop'), 'a file, not a folder');
  const roots = discoverRoots(home, { env: { SLS_USER_DIRS: JSON.stringify([join(home, 'Downloads')]) } });
  assert.equal(roots.filter((r) => /downloads$/i.test(r)).length, 1);
  assert.equal(roots.filter((r) => /roms$/i.test(r)).length, 1); // ROMs, Roms and roms are one folder on Windows/macOS
  assert.ok(!roots.some((r) => r.endsWith('Desktop')));
  assert.ok(roots.every((r) => existsSync(r)));
});

test('Search my PC: online-only OneDrive files are never read (that would download them), real files are found', () => {
  assert.equal(onlineOnly({ size: 16 * 1024 * 1024, blocks: 0 }, 'win32'), true); // placeholder: nothing on the disk
  assert.equal(onlineOnly({ size: 16 * 1024 * 1024, blocks: 32768 }, 'win32'), false);
  assert.equal(onlineOnly({ size: 600, blocks: 0 }, 'win32'), false); // tiny files live inside the file table
  assert.equal(onlineOnly({ size: 16 * 1024 * 1024, blocks: 0 }, 'darwin'), false);
  // on this computer (Windows in CI): an ordinary ROM-sized file reports blocks and is found
  const root = join(TMP, 'discover');
  mkdirSync(root, { recursive: true });
  const gba = new Uint8Array(64 * 1024);
  gba[0xb2] = 0x96;
  writeFileSync(join(root, 'game.gba'), gba);
  const r = discoverRoms({ roots: [root] });
  assert.deepEqual(r.found.map((f) => f.name), ['game.gba']);
});

test('found files are shown with short paths on both systems', () => {
  assert.equal(shortPath('/Users/ana/Downloads/x.nds'), '~/Downloads/x.nds');
  assert.equal(shortPath('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/ROMs/x.nds'), 'iCloud Drive/ROMs/x.nds');
  assert.equal(shortPath('C:\\Users\\Ana\\Downloads\\x.nds'), '~\\Downloads\\x.nds');
  assert.equal(shortPath('C:\\Users\\Ana\\OneDrive - Firma\\ROMs\\x.nds'), 'OneDrive - Firma\\ROMs\\x.nds');
  assert.equal(shortPath('D:\\ROMs\\x.nds'), 'D:\\ROMs\\x.nds');
});

// ---- emulators -----------------------------------------------------------------------------
test('emulator downloads: the right official build per platform and architecture', () => {
  const melon = ['melonDS-1.1-appimage-x86_64.zip', 'melonDS-1.1-macOS-universal.zip', 'melonDS-1.1-windows-aarch64.zip', 'melonDS-1.1-windows-x86_64.zip'];
  const mgba = ['mGBA-0.10.5-macos.dmg', 'mGBA-0.10.5-win32.7z', 'mGBA-0.10.5-win64-installer.exe', 'mGBA-0.10.5-win64.7z', 'mGBA-0.10.5-appimage-x64.appimage'];
  const pick = (id, list, platform, arch) => pickAsset(list.map((name) => ({ name })), id, platform, arch)?.name || null;
  assert.equal(pick('melonds', melon, 'win32', 'x64'), 'melonDS-1.1-windows-x86_64.zip');
  assert.equal(pick('melonds', melon, 'win32', 'arm64'), 'melonDS-1.1-windows-aarch64.zip');
  assert.equal(pick('melonds', melon, 'darwin', 'arm64'), 'melonDS-1.1-macOS-universal.zip');
  assert.equal(pick('mgba', mgba, 'win32', 'x64'), 'mGBA-0.10.5-win64.7z'); // not the installer, not 32-bit
  assert.equal(pick('mgba', mgba, 'win32', 'arm64'), 'mGBA-0.10.5-win64.7z'); // x64 build under emulation
  assert.equal(pick('mgba', mgba, 'darwin', 'x64'), 'mGBA-0.10.5-macos.dmg');
  assert.deepEqual(assetPatterns('mgba', 'sunos', 'x64'), []);
  // a release without a Windows ARM build: the x64 one (runs through emulation) instead of nothing
  assert.equal(pick('melonds', melon.filter((n) => !/aarch64/.test(n)), 'win32', 'arm64'), 'melonDS-1.1-windows-x86_64.zip');
  assert.equal(pick('melonds', ['melonDS-1.1-ubuntu-x86_64.zip'], 'win32', 'x64'), null);
  assert.ok(EMULATORS.mgba.exe.test('mGBA.exe') && !EMULATORS.mgba.exe.test('mgba-sdl.exe'));
  assert.ok(EMULATORS.melonds.exe.test('melonDS.exe'));
});

test('Windows: installed emulators are found, Explorer selects files with spaces in their path', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' };
  const paths = windowsSystemPaths('mgba', env);
  assert.ok(paths.some((p) => /Program Files.mGBA.mGBA\.exe$/.test(p)), paths.join());
  assert.deepEqual(windowsSystemPaths('nope', env), []);
  const [cmd, args, opts] = revealCommand('C:\\Users\\Ana\\AppData\\Roaming\\SoulLink Studio\\Library', 'win32');
  assert.equal(cmd, 'explorer.exe');
  assert.deepEqual(args, ['/select,"C:\\Users\\Ana\\AppData\\Roaming\\SoulLink Studio\\Library"']);
  assert.equal(opts.windowsVerbatimArguments, true);
  assert.deepEqual(revealCommand('/Users/ana/Library', 'darwin'), ['open', ['-R', '/Users/ana/Library'], {}]);
});

// ---- Java ------------------------------------------------------------------------------------
test('Java: JDKs in the usual Windows folders are found, newest first; UTF-8 everywhere', () => {
  const dirs = {
    'C:/Program Files/Java': ['jdk1.8.0_202', 'jdk-17'],
    'C:/Program Files/Eclipse Adoptium': ['jdk-21.0.4.7-hotspot'],
  };
  const list = (p) => {
    const key = p.replace(/\\/g, '/');
    if (!dirs[key]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return [...dirs[key]];
  };
  const found = windowsJavaCandidates({ ProgramFiles: 'C:\\Program Files' }, list);
  assert.equal(found.length, 3);
  // newest Java first, whichever vendor folder it is in – an old Java 8 never wins over a current one
  assert.ok(found[0].includes('jdk-21') && found[1].includes('jdk-17') && found[2].includes('jdk1.8.0_202'), found.join('\n'));
  assert.ok(found.every((p) => p.endsWith('java.exe')));
  assert.ok(JAVA_OPTS.includes('-Dfile.encoding=UTF-8'));
  assert.ok(JAVA_OPTS.includes('-Djava.awt.headless=true'));
});

// ---- the window and the page -------------------------------------------------------------
test('title bar colours: only #rrggbb values reach the window', () => {
  assert.deepEqual(titleBarColors({ color: '#1C1B21', symbolColor: '#ebe6da' }), { color: '#1c1b21', symbolColor: '#ebe6da' });
  for (const bad of [null, 'x', {}, { color: 'red', symbolColor: '#fff000' }, { color: '#000', symbolColor: '#ffffff' }, { color: '#000000; x', symbolColor: '#ffffff' }]) {
    assert.equal(titleBarColors(bad), null, JSON.stringify(bad));
  }
});

test('platform: the app says which one, the browser is the fallback; shortcuts read ⌘ or Ctrl', () => {
  assert.equal(detectPlatform({ sls: { platform: 'win32' }, navigator: { platform: 'MacIntel' } }), 'win32');
  assert.equal(detectPlatform({ navigator: { userAgentData: { platform: 'Windows' } } }), 'win32');
  assert.equal(detectPlatform({ navigator: { platform: 'MacIntel', userAgent: '' } }), 'darwin');
  assert.equal(detectPlatform({ navigator: { platform: 'Linux x86_64', userAgent: '' } }), 'linux');
  assert.equal(detectPlatform({ sls: { platform: 'evil' }, navigator: { platform: 'Win32' } }), 'win32');
  assert.equal(shortcut('Mod+B', { mac: true }), '⌘B');
  assert.equal(shortcut('Mod+B', { mac: false }), 'Ctrl+B');
  assert.equal(shortcut('Mod+1–5', { mac: true, space: true }), '⌘ 1–5');
  assert.equal(shortcut('Shift+1–4', { mac: true, space: true }), '⇧ 1–4');
  assert.equal(shortcut('Shift+1–4', { mac: false, space: true }), 'Shift+1–4');
  assert.equal(shortcut('Alt+F4', { mac: false }), 'Alt+F4');
  assert.equal(shortcut('F11', { mac: false }), 'F11');
});

test('Mac wording only where the page picks texts by platform', () => {
  // Every text that speaks of ⌘, the Finder, Applications or "Mac" is either shown behind a platform switch
  // (IS_MAC / isWin) or only reachable on macOS (states only the macOS updater produces). New ones must be added here.
  const SWITCHED = ['disc.button', 'disc.title', 'disc.privacy', 'ext.revealMac', 'menu.revealLibrary', 'upd.dataSafe', 'upd.gatekeeper', 'upd.manual1', 'upd.manual2'];
  const MAC_STATES = ['upd.reasonBlocked', 'upd.reasonDmg', 'upd.reasonTranslocated', 'upd.stepMount'];
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  const macish = Object.keys(en).filter((k) => /⌘|⇧|⌥|\bMacs?\b|Finder|macOS|Applications|Apple|disk image|Library folder/.test(en[k]));
  assert.deepEqual(macish.sort(), [...SWITCHED, ...MAC_STATES].sort());
  const root = fileURLToPath(new URL('../web/', import.meta.url));
  const files = ['app.mjs', ...readdirSync(join(root, 'views')).map((f) => `views/${f}`), ...readdirSync(join(root, 'lib')).map((f) => `lib/${f}`)];
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const key of SWITCHED) {
      if (src.includes(`t('${key}',`)) assert.match(src, /IS_MAC \?|isWin\(s\) \?/, `${f} shows ${key} without a platform switch`);
    }
  }
});
