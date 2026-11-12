// Linux support: the AppImage in the update feed (and older apps reading such a feed), the AppImage self-update,
// "Search my PC" (XDG folders, EmuDeck / RetroDECK / RetroArch, SD cards on the Steam Deck), the emulator downloads,
// file manager, window size and texts. Everything here runs on every OS – Linux paths are tested with path.posix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { validateFeed, assetFor, updateAction, actionFor, linuxAssetName, debAssetName, winAssetName, ASSET_PLATFORMS } from '../shared/update.mjs';
import {
  appImageFromEnv, appImageStagedPath, canReplaceAppImage, makeExecutable, swapAppImage, cleanupAppImageStaging, appImageRelaunch,
  signFeed, publicKeyBase64, verifyFeedSignature, fetchFeed,
} from '../electron/update-core.mjs';
import { buildFeed } from '../scripts/release.mjs';
import { discoverCandidates } from '../server/lib/library.mjs';
import { pickAsset, linuxSystemPaths, revealCommand, validCustomPath, EMULATORS } from '../server/lib/emulator.mjs';
import { initialWindowSize } from '../electron/guards.mjs';
import { detectPlatform, shortcut, shortPath } from '../web/lib/platform.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-linux-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const DMG_URL = 'https://github.com/o/r/releases/download/v2.2.0/souldew-2.2.0-arm64.dmg';
const APPIMAGE_URL = 'https://github.com/o/r/releases/download/v2.2.0/souldew-2.2.0-linux-x86_64.AppImage';
const feed = (over = {}) => ({ version: '2.2.0', notes: 'Linux', url: DMG_URL, sha256: 'a'.repeat(64), size: 1234, ...over });
const linuxAsset = (over = {}) => ({ name: 'souldew-2.2.0-linux-x86_64.AppImage', url: APPIMAGE_URL, sha256: 'd'.repeat(64), size: 123456, ...over });

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---- the feed ----------------------------------------------------------------------------------
test('feed: the Linux AppImage entry is validated like the Windows installer', () => {
  assert.equal(ASSET_PLATFORMS['linux-x64'], 'appimage');
  const ok = validateFeed(feed({ assets: { 'linux-x64': linuxAsset({ sha256: 'D'.repeat(64) }) } }));
  assert.deepEqual(ok.assets, { 'linux-x64': linuxAsset() });
  // the extension is compared case-insensitively (.AppImage, as electron-builder writes it, or .appimage)
  const lower = 'souldew-2.2.0-linux-x86_64.appimage';
  assert.equal(validateFeed(feed({ assets: { 'linux-x64': linuxAsset({ name: lower, url: APPIMAGE_URL.replace(/[^/]+$/, lower) }) } })).assets['linux-x64'].name, lower);
  const bad = [
    { 'linux-x64': null },
    { 'linux-x64': linuxAsset({ name: 'souldew-2.2.0-linux-amd64.deb', url: APPIMAGE_URL.replace(/[^/]+$/, 'souldew-2.2.0-linux-amd64.deb') }) }, // a .deb can't update itself
    { 'linux-x64': linuxAsset({ name: 'souldew.exe' }) },
    { 'linux-x64': linuxAsset({ name: '../souldew.AppImage' }) },
    { 'linux-x64': linuxAsset({ url: APPIMAGE_URL.replace('https:', 'http:') }) },
    { 'linux-x64': linuxAsset({ url: 'https://github.com/o/r/releases/download/v2.2.0/other.AppImage' }) },
    { 'linux-x64': linuxAsset({ sha256: 'xyz' }) },
    { 'linux-x64': linuxAsset({ size: 0 }) },
  ];
  for (const assets of bad) assert.throws(() => validateFeed(feed({ assets })), (e) => e.code === 'BAD_FEED', JSON.stringify(assets));
});

test('feed: Linux finds its AppImage; minVersion never sends it to the manual route', () => {
  const all = validateFeed(feed({ assets: { 'linux-x64': linuxAsset() } }));
  assert.deepEqual(assetFor(all, 'linux', 'x64'), linuxAsset());
  assert.equal(assetFor(all, 'linux', 'arm64'), null);
  assert.equal(assetFor(validateFeed(feed()), 'linux', 'x64'), null);
  assert.equal(updateAction(all, '2.1.0', { platform: 'linux', arch: 'x64' }), 'install');
  assert.equal(updateAction(all, '2.2.0', { platform: 'linux', arch: 'x64' }), 'none');
  // a release without an AppImage is no update for Linux – but still one for the Mac
  assert.equal(updateAction(validateFeed(feed()), '2.1.0', { platform: 'linux', arch: 'x64' }), 'none');
  const old = validateFeed(feed({ minVersion: '2.1.5', assets: { 'linux-x64': linuxAsset() } }));
  assert.equal(actionFor(old, '2.1.0', { platform: 'linux', arch: 'x64' }), 'install'); // the AppImage replaces any version
  assert.equal(actionFor(old, '2.1.0', { platform: 'darwin', arch: 'arm64' }), 'manual');
});

test('release: the asset names are exactly what electron-builder builds (package.json → build.linux)', () => {
  assert.equal(linuxAssetName('2.2.0'), 'souldew-2.2.0-linux-x86_64.AppImage');
  assert.equal(linuxAssetName('2.2.0', 'arm64'), 'souldew-2.2.0-linux-arm64.AppImage');
  assert.equal(debAssetName('2.2.0'), 'souldew-2.2.0-linux-amd64.deb');
  // electron-builder expands ${arch} per format: x86_64 for AppImage, amd64 for deb (builder-util getArtifactArchName)
  const expand = (arch, ext) => pkg.build.linux.artifactName.replaceAll('${version}', '2.2.0').replaceAll('${arch}', arch).replaceAll('${ext}', ext);
  assert.equal(expand('x86_64', 'AppImage'), linuxAssetName('2.2.0'));
  assert.equal(expand('amd64', 'deb'), debAssetName('2.2.0'));
  const targets = pkg.build.linux.target.map((t) => `${t.target}:${t.arch.join(',')}`);
  assert.deepEqual(targets, ['AppImage:x64', 'deb:x64']);
  // the bundled Java for the randomizer, the window icon, the desktop entry that matches the window (app id)
  assert.deepEqual(pkg.build.linux.extraResources, [{ from: 'tools/jre/linux-x64', to: 'tools/jre/linux-x64' }, { from: 'tools/ctr/linux-x64', to: 'tools/ctr/linux-x64' },
    { from: 'tools/native/linux-x64', to: 'tools/native/linux-x64', filter: ['retrohost*', '*_libretro.*', 'SOURCES.txt'] }]);
  assert.ok(pkg.build.linux.files.includes('build/icon.png'));
  assert.equal(pkg.desktopName, 'souldew.desktop');
  assert.equal(pkg.build.linux.executableName, 'souldew');
  assert.equal(pkg.build.linux.category, 'Game');
});

test('release: one feed carries the DMG, the Windows installer and the AppImage (never the .deb)', () => {
  const f = buildFeed({ version: '2.2.0', notes: 'Linux', repo: 'o/r', dmg: { sha256: 'a'.repeat(64), size: 1 }, win: { sha256: 'b'.repeat(64), size: 2 },
    linux: { sha256: 'c'.repeat(64), size: 3 }, pubDate: '2026-11-06T00:00:00.000Z' });
  assert.deepEqual(Object.keys(f.assets).sort(), ['linux-x64', 'win32-x64']);
  assert.deepEqual(f.assets['linux-x64'], { name: 'souldew-2.2.0-linux-x86_64.AppImage', url: 'https://github.com/o/r/releases/download/v2.2.0/souldew-2.2.0-linux-x86_64.AppImage', sha256: 'c'.repeat(64), size: 3 });
  assert.equal(f.assets['win32-x64'].name, winAssetName('2.2.0'));
  assert.ok(!JSON.stringify(f).includes('.deb'));
  const linuxOnly = buildFeed({ version: '2.2.0', notes: 'x', repo: 'o/r', dmg: { sha256: 'a'.repeat(64), size: 1 }, linux: { sha256: 'c'.repeat(64), size: 3 } });
  assert.deepEqual(Object.keys(linuxOnly.assets), ['linux-x64']);
  const macOnly = buildFeed({ version: '2.2.0', notes: 'x', repo: 'o/r', dmg: { sha256: 'a'.repeat(64), size: 1 } });
  assert.equal('assets' in macOnly, false); // exactly the 2.0 format
});

test('backward compatible: souldew 2.0.0 and 2.1.0 accept a signed feed with the Linux entry', async () => {
  // Verbatim copies of the released feed code (test/fixtures/update-2.0.0 and update-2.1.0).
  const v200 = { feed: await import('./fixtures/update-2.0.0/shared/update.mjs'), core: await import('./fixtures/update-2.0.0/electron/update-core.mjs') };
  const v210 = { feed: await import('./fixtures/update-2.1.0/shared/update.mjs'), core: await import('./fixtures/update-2.1.0/electron/update-core.mjs') };
  const { privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKeyBase64(privateKey);
  const built = buildFeed({ version: '2.2.0', notes: 'Linux support – “AppImage”, ümlauts', repo: 'souldewapp/souldew', dmg: { sha256: 'a'.repeat(64), size: 123456789 },
    win: { sha256: 'b'.repeat(64), size: 98765432 }, linux: { sha256: 'C'.repeat(64), size: 134217728 } });
  const text = JSON.stringify(signFeed(built, privateKey), null, 2) + '\n';
  const published = JSON.parse(text);
  assert.ok(published.assets['linux-x64'] && published.assets['win32-x64']);

  for (const [label, old] of [['2.0.0', v200], ['2.1.0', v210]]) {
    assert.ok(old.core.verifyFeedSignature(published, pub), `${label}: signature`);
    const seen = old.feed.validateFeed(published);
    assert.equal(seen.url, 'https://github.com/souldewapp/souldew/releases/download/v2.2.0/souldew-2.2.0-arm64.dmg', label);
    assert.equal(old.feed.updateAction(seen, '2.0.0'), 'install', label);
  }
  // 2.1.0 knows `assets`: it keeps the Windows installer, drops the unknown Linux key, and its Windows app updates
  const seen210 = v210.feed.validateFeed(published);
  assert.deepEqual(Object.keys(seen210.assets), ['win32-x64']);
  assert.equal(v210.feed.assetFor(seen210, 'win32', 'x64').name, 'souldew-2.2.0-win-x64-setup.exe');
  assert.equal(v210.feed.actionFor(seen210, '2.1.0', { platform: 'win32', arch: 'x64' }), 'install');
  assert.equal(v210.feed.actionFor(seen210, '2.1.0', { platform: 'darwin', arch: 'arm64' }), 'install');

  // End to end over HTTP: the installed 2.0.0 and 2.1.0 apps and this one read the same file
  await withServer((req, res) => (req.url === '/latest.json' ? res.end(text) : res.writeHead(404).end()), async (b) => {
    for (const old of [v200, v210]) assert.equal((await old.core.fetchFeed(`${b}/latest.json`, { allowLocal: true, publicKey: pub })).version, '2.2.0');
    const now = await fetchFeed(`${b}/latest.json`, { allowLocal: true, publicKey: pub });
    assert.deepEqual(assetFor(now, 'linux', 'x64'), { name: 'souldew-2.2.0-linux-x86_64.AppImage', url: 'https://github.com/souldewapp/souldew/releases/download/v2.2.0/souldew-2.2.0-linux-x86_64.AppImage', sha256: 'c'.repeat(64), size: 134217728 });
  });
  // The signature protects the Linux entry for every version: a changed AppImage hash is refused.
  const tampered = { ...published, assets: { ...published.assets, 'linux-x64': { ...published.assets['linux-x64'], sha256: 'f'.repeat(64) } } };
  for (const verify of [v200.core.verifyFeedSignature, v210.core.verifyFeedSignature, verifyFeedSignature]) {
    assert.throws(() => verify(tampered, pub), (e) => e.code === 'BAD_SIGNATURE');
  }
});

// ---- the AppImage updates itself ---------------------------------------------------------------
test('AppImage: only an app running from inside its own AppImage updates itself', () => {
  const env = { APPIMAGE: '/home/deck/Applications/souldew.AppImage', APPDIR: '/tmp/.mount_souldeAbC123' };
  const execPath = '/tmp/.mount_souldeAbC123/souldew';
  const exists = (p) => p === '/home/deck/Applications/souldew.AppImage';
  assert.equal(appImageFromEnv({ env, execPath, exists }), '/home/deck/Applications/souldew.AppImage');
  assert.equal(appImageFromEnv({ env: { ...env, APPDIR: '/tmp/.mount_souldeAbC123/' }, execPath, exists }), '/home/deck/Applications/souldew.AppImage');
  assert.equal(appImageFromEnv({ env: { ...env, APPIMAGE: '/home/deck/Applications/souldew-2.2.0-linux-x86_64.appimage' }, execPath, exists: () => true }),
    '/home/deck/Applications/souldew-2.2.0-linux-x86_64.appimage');
  const none = [
    { env: {}, execPath, exists }, // .deb install, unpacked build, development
    { env: { APPDIR: env.APPDIR }, execPath, exists },
    { env: { APPIMAGE: env.APPIMAGE }, execPath, exists },
    { env, execPath: '/opt/souldew/souldew', exists }, // a stray APPIMAGE inherited from another AppImage
    { env, execPath: '/tmp/.mount_souldeAbC1234/souldew', exists }, // a mount whose name merely starts the same
    { env: { ...env, APPIMAGE: 'souldew.AppImage' }, execPath, exists: () => true }, // relative
    { env: { ...env, APPIMAGE: '/home/deck/Applications/souldew' }, execPath, exists: () => true }, // not an AppImage
    { env: { ...env, APPDIR: '/' }, execPath, exists }, // a mount point can't be the root
    { env: { ...env, APPIMAGE: '/home/deck/x\0.AppImage' }, execPath, exists: () => true },
    { env, execPath, exists: () => false }, // the file is gone (moved while running)
  ];
  for (const c of none) assert.equal(appImageFromEnv(c), null, JSON.stringify(c.env) + c.execPath);
});

test('AppImage: the update is staged next to the file and replaces it with one rename, under the same name', () => {
  assert.equal(appImageStagedPath('/home/deck/Applications/souldew.AppImage'), '/home/deck/Applications/.souldew.AppImage.update');
  assert.deepEqual(canReplaceAppImage(null), { ok: false, reason: 'not-appimage' });
  const deny = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.deepEqual(canReplaceAppImage('/opt/apps/souldew.AppImage', { access: deny }), { ok: false, reason: 'read-only' });
  const asked = [];
  assert.deepEqual(canReplaceAppImage('/home/deck/Applications/souldew.AppImage', { access: (p, mode) => asked.push([p, mode]) }), { ok: true });
  assert.deepEqual(asked, [['/home/deck/Applications', constants.W_OK]]); // the folder, for the rename

  // with fakes: exactly one rename, the old file's path kept
  const renames = [];
  assert.equal(swapAppImage('/a/souldew.AppImage', '/a/.souldew.AppImage.update', { rename: (f, t) => renames.push([f, t]), exists: () => true }), '/a/souldew.AppImage');
  assert.deepEqual(renames, [['/a/.souldew.AppImage.update', '/a/souldew.AppImage']]);
  assert.throws(() => swapAppImage('/a/souldew.AppImage', '/b/.souldew.AppImage.update', { rename: () => {}, exists: () => true }), (e) => e.code === 'NO_STAGED');
  assert.throws(() => swapAppImage('/a/souldew.AppImage', '/a/.souldew.AppImage.update', { rename: () => {}, exists: () => false }), (e) => e.code === 'NO_STAGED');

  // relaunch: the AppImage file itself with this run's arguments
  assert.deepEqual(appImageRelaunch('/a/souldew.AppImage', ['/tmp/.mount_x/souldew', '--user-data-dir=/tmp/p']), { execPath: '/a/souldew.AppImage', args: ['--user-data-dir=/tmp/p'] });
  const modes = [];
  makeExecutable('/a/.souldew.AppImage.update', { chmod: (p, m) => modes.push([p, m]) });
  assert.deepEqual(modes, [['/a/.souldew.AppImage.update', 0o755]]);
});

test('AppImage: swap and cleanup on real files (the running file keeps its name)', { skip: process.platform === 'win32' && 'POSIX file modes and paths' }, () => {
  const dir = mkdtempSync(join(TMP, 'apps-'));
  const app = join(dir, 'souldew-2.1.0-linux-x86_64.AppImage'); // the old version's name stays – shortcuts point to it
  writeFileSync(app, 'old');
  const staged = appImageStagedPath(app);
  writeFileSync(staged, 'new');
  makeExecutable(staged);
  assert.equal(statSync(staged).mode & 0o777, 0o755);
  swapAppImage(app, staged);
  assert.equal(readFileSync(app, 'utf8'), 'new');
  assert.equal(statSync(app).mode & 0o777, 0o755);
  assert.equal(existsSync(staged), false);
  // an abandoned download (staged file and its .part) goes, everything else in the folder stays
  writeFileSync(staged, 'x');
  writeFileSync(`${staged}.part`, 'x');
  writeFileSync(join(dir, 'other.AppImage'), 'x');
  cleanupAppImageStaging(app);
  assert.deepEqual(readdirSync(dir).sort(), ['other.AppImage', 'souldew-2.1.0-linux-x86_64.AppImage']);
  cleanupAppImageStaging(null); // nothing to do
});

// ---- "Search my PC" ------------------------------------------------------------------------------
test('Search my PC on Linux: XDG folders, EmuDeck, RetroDECK, RetroArch and SD cards (Steam Deck)', () => {
  const mounts = {
    '/run/media/deck': ['SD-512', '.hidden'],
    '/run/media': ['deck', 'mmcblk0p1'],
    '/media/deck': ['USB'],
  };
  const list = (dir) => mounts[dir] || [];
  const env = { USER: 'deck', SLS_USER_DIRS: JSON.stringify(['/home/deck/Téléchargements', 'relative/nope']) };
  const c = discoverCandidates('/home/deck', { platform: 'linux', env, list });
  for (const p of ['/home/deck/Téléchargements', '/home/deck/Downloads', '/home/deck/Desktop', '/home/deck/Documents', '/home/deck/ROMs', '/home/deck/Emulation',
    '/home/deck/Emulation/roms', '/home/deck/retrodeck/roms', '/home/deck/.config/retroarch/downloads', '/home/deck/.var/app/org.libretro.RetroArch/config/retroarch/downloads',
    '/run/media/deck/SD-512/Emulation/roms', '/run/media/deck/SD-512/retrodeck/roms', '/run/media/mmcblk0p1/Emulation/roms', '/media/deck/USB/roms']) {
    assert.ok(c.includes(p), p);
  }
  assert.ok(!c.some((p) => p.includes('relative') || p.includes('\\')), 'only absolute posix paths');
  assert.ok(!c.some((p) => p.includes('.hidden') || p.startsWith('/run/media/deck/Emulation')), 'only real mounts');
  assert.ok(!c.some((p) => /Library|OpenEmu|CloudDocs|OneDrive|AppData/.test(p)), 'no Mac or Windows places on Linux');
  // $XDG_CONFIG_HOME moves RetroArch's folder; without $USER the home folder's name is the user
  const xdg = discoverCandidates('/home/ana', { platform: 'linux', env: { XDG_CONFIG_HOME: '/home/ana/.cfg' }, list: (d) => (d === '/run/media/ana' ? ['STICK'] : []) });
  assert.ok(xdg.includes('/home/ana/.cfg/retroarch/downloads'));
  assert.ok(xdg.includes('/run/media/ana/STICK/roms'));
  // macOS keeps its own list
  const mac = discoverCandidates('/Users/ana', { platform: 'darwin', env: {}, list: () => ['X'] });
  assert.ok(!mac.some((p) => /retrodeck|\/run\/media/.test(p)));
});

// ---- emulators ------------------------------------------------------------------------------------
test('emulators on Linux: the official AppImages, distribution packages and Flatpaks are recognised', () => {
  // the asset names of melonDS 1.1 and mGBA 0.10.5 as published on GitHub
  const melon = ['melonDS-1.1-appimage-aarch64.zip', 'melonDS-1.1-appimage-x86_64.zip', 'melonDS-1.1-ubuntu-x86_64.zip', 'melonDS-1.1-windows-x86_64.zip'];
  const mgba = ['mGBA-0.10.5-appimage-arm64.appimage', 'mGBA-0.10.5-appimage-x64.appimage', 'mGBA-0.10.5-ubuntu64-noble.tar.xz', 'mGBA-0.10.5-win64.7z'];
  const pick = (id, list, arch) => pickAsset(list.map((name) => ({ name })), id, 'linux', arch)?.name || null;
  assert.equal(pick('melonds', melon, 'x64'), 'melonDS-1.1-appimage-x86_64.zip');
  assert.equal(pick('melonds', melon, 'arm64'), 'melonDS-1.1-appimage-aarch64.zip');
  assert.equal(pick('mgba', mgba, 'x64'), 'mGBA-0.10.5-appimage-x64.appimage');
  assert.equal(pick('mgba', mgba, 'arm64'), 'mGBA-0.10.5-appimage-arm64.appimage');
  // what ends up in the tools folder (melonDS' zip holds melonDS-x86_64.AppImage), and what distributions install
  for (const n of ['melonDS-x86_64.AppImage', 'melonDS.AppImage', 'melonDS', 'net.kuribo64.melonDS', 'melonDS.exe']) assert.ok(EMULATORS.melonds.exe.test(n), n);
  for (const n of ['mGBA-0.10.5-appimage-x64.appimage', 'mGBA.AppImage', 'mgba-qt', 'io.mgba.mGBA', 'mGBA', 'mGBA.exe']) assert.ok(EMULATORS.mgba.exe.test(n), n);
  for (const n of ['melonDS-1.1-appimage-x86_64.zip', 'melonDS.sh', 'melonDS-x86_64.AppImage.zip', 'notmelonDS']) assert.ok(!EMULATORS.melonds.exe.test(n), n);
  for (const n of ['mGBA-0.10.5-win64.7z', 'mgba-qt.sh', 'mgba-sdl', 'io.mgba.mGBA.evil', 'x-mGBA.AppImage']) assert.ok(!EMULATORS.mgba.exe.test(n), n);

  const paths = linuxSystemPaths('mgba', '/home/deck');
  for (const p of ['/home/deck/Applications/mGBA.AppImage', '/usr/bin/mgba-qt', '/usr/games/mgba-qt', '/var/lib/flatpak/exports/bin/io.mgba.mGBA',
    '/home/deck/.local/share/flatpak/exports/bin/io.mgba.mGBA']) assert.ok(paths.includes(p), p);
  assert.ok(linuxSystemPaths('melonds', '/home/deck').includes('/var/lib/flatpak/exports/bin/net.kuribo64.melonDS'));
  assert.ok(linuxSystemPaths('melonds', '').every((p) => p.startsWith('/')), 'no home: only system-wide places');
  assert.deepEqual(linuxSystemPaths('nope', '/home/deck'), []);
  // every place the app looks is a name the launcher accepts
  for (const id of ['melonds', 'mgba']) for (const p of linuxSystemPaths(id, '/home/deck')) assert.ok(EMULATORS[id].exe.test(p.split('/').pop()), p);
});

test('emulators on Linux: a chosen AppImage is accepted, a look-alike script is not', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const dir = mkdtempSync(join(TMP, 'emu-'));
  const appImage = join(dir, 'mGBA-0.10.5-appimage-x64.appimage');
  writeFileSync(appImage, 'ELF');
  assert.equal(validCustomPath('mgba', appImage), appImage);
  const script = join(dir, 'mGBA.sh');
  writeFileSync(script, '#!/bin/sh');
  assert.equal(validCustomPath('mgba', script), null);
  assert.equal(validCustomPath('melonds', appImage), null); // the name must match the emulator
});

test('file manager on Linux: folders open, files open their folder (never the file itself)', () => {
  assert.deepEqual(revealCommand('/home/deck/.config/SoulLink Studio/Library', 'linux', { isDir: true }), ['xdg-open', ['/home/deck/.config/SoulLink Studio/Library'], {}]);
  assert.deepEqual(revealCommand('/home/deck/.config/SoulLink Studio/Library/Emerald.gba', 'linux'), ['xdg-open', ['/home/deck/.config/SoulLink Studio/Library'], {}]);
  assert.deepEqual(revealCommand('/Users/ana/Library', 'darwin'), ['open', ['-R', '/Users/ana/Library'], {}]); // unchanged elsewhere
});

// ---- window, platform, texts ---------------------------------------------------------------------
test('window: fits the Steam Deck (1280×800) and small screens, the usual size elsewhere', () => {
  assert.deepEqual(initialWindowSize({ width: 2560, height: 1415 }), { width: 1360, height: 880, minWidth: 980, minHeight: 640 });
  assert.deepEqual(initialWindowSize({ width: 1280, height: 800 }), { width: 1280, height: 800, minWidth: 980, minHeight: 640 });
  assert.deepEqual(initialWindowSize({ width: 1280, height: 752 }), { width: 1280, height: 752, minWidth: 980, minHeight: 640 }); // with a panel
  assert.deepEqual(initialWindowSize({ width: 960, height: 600 }), { width: 960, height: 600, minWidth: 960, minHeight: 600 });
  for (const none of [null, undefined, {}, { width: 0, height: 0 }, { width: 'x', height: 800 }]) {
    assert.deepEqual(initialWindowSize(none), { width: 1360, height: 880, minWidth: 980, minHeight: 640 }, JSON.stringify(none));
  }
});

test('platform on Linux: Ctrl shortcuts, ~ for the home folder', () => {
  assert.equal(detectPlatform({ sls: { platform: 'linux' }, navigator: { platform: 'MacIntel' } }), 'linux');
  assert.equal(detectPlatform({ navigator: { userAgentData: { platform: 'Linux' }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } }), 'linux');
  assert.equal(shortcut('Mod+B', { mac: false }), 'Ctrl+B');
  assert.equal(shortPath('/home/deck/Emulation/roms/gba/Emerald.gba'), '~/Emulation/roms/gba/Emerald.gba');
  assert.equal(shortPath('/var/home/ana/Downloads/x.nds'), '~/Downloads/x.nds'); // Fedora Atomic, Bazzite
  assert.equal(shortPath('/home/deck'), '~');
  assert.equal(shortPath('/homeless/x.nds'), '/homeless/x.nds');
  assert.equal(shortPath('/run/media/deck/SD/roms/x.nds'), '/run/media/deck/SD/roms/x.nds');
});

test('texts: Windows and Linux wording only behind a platform switch, translated everywhere', () => {
  const i18n = (lang) => JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
  const en = i18n('en');
  const WIN_ONLY = ['disc.searchingPc', 'ext.revealPc', 'menu.revealLibraryWin', 'upd.dataSafeWin', 'upd.manual2Win', 'upd.smartscreen'];
  const LINUX_ONLY = ['disc.searchingLinux', 'ext.revealLinux', 'menu.revealLibraryLinux', 'upd.dataSafeLinux', 'upd.manual2Linux'];
  const winish = Object.keys(en).filter((k) => /Explorer|AppData|SmartScreen|OneDrive/.test(en[k]));
  assert.deepEqual(winish.sort(), [...WIN_ONLY].sort());
  const linuxish = Object.keys(en).filter((k) => /AppImage|~\/\.config|file manager|EmuDeck|RetroDECK/.test(en[k]));
  assert.deepEqual(linuxish.sort(), [...LINUX_ONLY].sort());
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const tr = i18n(lang);
    for (const k of LINUX_ONLY) assert.ok(typeof tr[k] === 'string' && tr[k].length > 10, `${lang}: ${k}`);
    assert.ok(tr['upd.manual2Linux'].includes('{file}'), `${lang}: upd.manual2Linux keeps {file}`);
  }
  // where they are shown, the page picks by platform (IS_WIN / isLinux(s) next to the Mac switch)
  const web = fileURLToPath(new URL('../web/', import.meta.url));
  const src = (f) => readFileSync(join(web, f), 'utf8');
  assert.match(src('app.mjs'), /IS_MAC \? t\('menu\.revealLibrary'[^]*IS_WIN \? t\('menu\.revealLibraryWin'[^]*t\('menu\.revealLibraryLinux'/);
  assert.match(src('views/library.mjs'), /IS_WIN \? t\('disc\.searchingPc'[^]*t\('disc\.searchingLinux'/);
  assert.match(src('views/update.mjs'), /isLinux\(s\) \? html`[^]*upd\.manual2Linux[^]*upd\.dataSafeLinux/);
  // the window frame: Linux keeps the desktop's title bar, the page doesn't make room for window buttons there
  const css = src('styles.css');
  assert.match(css, /html\.platform-linux \.titlebar-drag \{ display: none; \}/);
});
