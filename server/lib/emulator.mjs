// External emulators: detection, one-click install from GitHub releases, launching.
// The integrated emulator (EmulatorJS inside the app) needs none of this.
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, cpSync, statSync, chmodSync } from 'node:fs';
import { join, basename, dirname, isAbsolute, resolve, posix } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TOOLS_DIR } from './paths.mjs';
import { httpError } from './fsutil.mjs';
import { extractArchiveAsync } from './archive.mjs';

// assets: which file of the emulator's latest GitHub release to download – per platform, and per architecture
// where the project builds for several (an arm64 Windows PC runs the x64 build of mGBA through emulation). On Linux
// both ship AppImages (melonDS inside a zip as melonDS-x86_64.AppImage, mGBA as mGBA-0.10.5-appimage-x64.appimage).
// exe: the program file names the app accepts – the official builds and, on Linux, the distribution packages
// (melonDS, mgba-qt) and Flathub's launchers (net.kuribo64.melonDS, io.mgba.mGBA).
export const EMULATORS = {
  melonds: {
    name: 'melonDS',
    systems: ['nds'],
    repo: 'melonDS-emu/melonDS',
    live: 'save', // reads the .sav after every in-game save
    assets: { darwin: /macOS-universal\.zip$/i, win32: { x64: /windows-x86_64\.zip$/i, arm64: /windows-aarch64\.zip$/i }, linux: { x64: /appimage-x86_64\.zip$/i, arm64: /appimage-aarch64\.zip$/i } },
    app: /^melonDS.*\.app$/i,
    exe: /^(?:melonDS(?:\.exe)?|melonDS[\w.+-]*\.AppImage|net\.kuribo64\.melonDS)$/i,
  },
  mgba: {
    name: 'mGBA',
    systems: ['gb', 'gbc', 'gba'],
    repo: 'mgba-emu/mgba',
    live: 'script', // Lua bridge streams the party in real time
    assets: { darwin: /-macos\.dmg$/i, win32: /-win64\.7z$/i, linux: { x64: /appimage-x64\.appimage$/i, arm64: /appimage-arm64\.appimage$/i } },
    app: /^mGBA\.app$/i,
    exe: /^(?:mGBA(?:\.exe)?|mgba-qt|mGBA[\w.+-]*\.AppImage|io\.mgba\.mGBA)$/i,
  },
  // Nintendo 3DS. Live data through its RPC server (server/lib/azahar.mjs) – switched on from the play view.
  azahar: {
    name: 'Azahar',
    systems: ['3ds'],
    repo: 'azahar-emu/azahar',
    live: 'rpc',
    assets: { darwin: /^azahar-macos-universal-[\w.]+\.zip$/i, win32: { x64: /^azahar-windows-msvc-[\w.]+\.zip$/i }, linux: { x64: /^azahar\.AppImage$/i } },
    app: /^Azahar\.app$/i,
    exe: /^(?:azahar(?:\.exe)?|azahar[\w.+-]*\.AppImage|org\.azahar_emu\.Azahar)$/i,
  },
};

/**
 * Release-asset patterns for an emulator on this platform / architecture, best first: the native build, then the
 * x64 one (Windows on ARM and macOS run x64 builds through emulation) – a release without an arm64 build still
 * installs. Empty when there is no build for the platform at all.
 */
export function assetPatterns(id, platform = process.platform, arch = process.arch) {
  const a = EMULATORS[id]?.assets?.[platform];
  if (!a) return [];
  if (a instanceof RegExp) return [a];
  return [...new Set([a[arch], a.x64].filter(Boolean))];
}

/** The asset of a GitHub release to install: the first pattern that matches one of its files. */
export function pickAsset(assets, id, platform = process.platform, arch = process.arch) {
  for (const pattern of assetPatterns(id, platform, arch)) {
    const hit = (assets || []).find((a) => pattern.test(a.name));
    if (hit) return hit;
  }
  return null;
}

/** Where the official Windows installers put the emulators (mGBA's installer; melonDS only ships a zip). */
export function windowsSystemPaths(id, env = process.env) {
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const exe = id === 'mgba' ? ['mGBA', 'mGBA.exe'] : id === 'melonds' ? ['melonDS', 'melonDS.exe'] : id === 'azahar' ? ['Azahar', 'azahar.exe'] : null;
  return exe ? bases.map((b) => join(b, ...exe)) : [];
}

/**
 * Where Linux installs put the emulators: AppImages in ~/Applications (EmuDeck on the Steam Deck, AppImageLauncher),
 * the distribution's packages, and Flatpak's launchers (system-wide and per user). Pure – posix paths for `home`.
 */
export function linuxSystemPaths(id, home = process.env.HOME || '') {
  const names = {
    melonds: { appimage: ['melonDS.AppImage', 'melonDS-x86_64.AppImage'], bin: ['melonDS'], flatpak: 'net.kuribo64.melonDS' },
    mgba: { appimage: ['mGBA.AppImage', 'mgba.AppImage'], bin: ['mgba-qt'], flatpak: 'io.mgba.mGBA' },
    azahar: { appimage: ['azahar.AppImage', 'Azahar.AppImage'], bin: ['azahar'], flatpak: 'org.azahar_emu.Azahar' },
  }[id];
  if (!names) return [];
  const h = (...p) => (home && posix.isAbsolute(home) ? [posix.join(home, ...p)] : []);
  return [
    ...names.appimage.flatMap((n) => h('Applications', n)),
    ...names.bin.flatMap((n) => ['/usr/bin', '/usr/local/bin', '/usr/games'].map((d) => posix.join(d, n))),
    ...h('.local', 'share', 'flatpak', 'exports', 'bin', names.flatpak),
    posix.join('/var/lib/flatpak/exports/bin', names.flatpak),
  ];
}

const dirFor = (id) => join(TOOLS_DIR, 'emulators', id);

function findIn(dir, predicate, depth = 3) {
  if (!existsSync(dir) || depth < 0) return null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (predicate(name, p)) return p;
    if (!name.endsWith('.app')) {
      try {
        const sub = findIn(p, predicate, depth - 1);
        if (sub) return sub;
      } catch {
        // file, not a directory
      }
    }
  }
  return null;
}

/**
 * A user-chosen emulator location is only accepted if it really looks like that emulator: an absolute path to
 * an `.app` bundle (directory) or an executable whose file name matches the emulator (mGBA / melonDS …).
 * Anything else – a shell script, /bin/sh, a ROM – is ignored, so a tampered config can't run arbitrary programs.
 */
export function validCustomPath(id, p) {
  const emu = EMULATORS[id];
  if (!emu || typeof p !== 'string' || !p || p.length > 4096 || /[\0\r\n]/.test(p) || !isAbsolute(p)) return null;
  const abs = resolve(p);
  const name = basename(abs.replace(/[\\/]+$/, ''));
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (/\.app$/i.test(name)) return process.platform === 'darwin' && st.isDirectory() && emu.app.test(name) ? abs : null;
  return st.isFile() && emu.exe.test(name) ? abs : null;
}

export function detectEmulator(id, customPath) {
  const emu = EMULATORS[id];
  if (!emu) return { installed: false };
  const candidates = [];
  const custom = customPath ? validCustomPath(id, customPath) : null;
  if (custom) candidates.push({ path: custom, source: 'custom' });
  const local = findIn(dirFor(id), (n) => (process.platform === 'darwin' ? emu.app.test(n) : emu.exe.test(n)));
  if (local) candidates.push({ path: local, source: 'app' });
  // legacy location from earlier versions
  if (id === 'melonds') {
    const legacy = findIn(join(TOOLS_DIR, 'emulator'), (n) => emu.app.test(n) || emu.exe.test(n));
    if (legacy) candidates.push({ path: legacy, source: 'app' });
  }
  if (process.platform === 'darwin') {
    const appName = { mgba: 'mGBA.app', melonds: 'melonDS.app', azahar: 'Azahar.app' }[id];
    candidates.push({ path: `/Applications/${appName}`, source: 'system' }, { path: join(process.env.HOME || '', 'Applications', appName), source: 'system' });
  }
  if (process.platform === 'win32') {
    for (const path of windowsSystemPaths(id)) candidates.push({ path, source: 'system' });
  }
  if (process.platform === 'linux') {
    for (const path of linuxSystemPaths(id)) candidates.push({ path, source: 'system' });
  }
  const found = candidates.find((c) => existsSync(c.path));
  return found ? { installed: true, ...found } : { installed: false };
}

export async function installEmulator(id) {
  const emu = EMULATORS[id];
  if (!emu) throw httpError(404, 'Unbekannter Emulator', 'unknownEmulator');
  const relRes = await fetch(`https://api.github.com/repos/${emu.repo}/releases/latest`, { headers: { 'User-Agent': 'souldew' } });
  if (!relRes.ok) throw new Error(`GitHub antwortete ${relRes.status} – später erneut versuchen`);
  const rel = await relRes.json();
  const asset = pickAsset(rel.assets, id);
  if (!asset) throw new Error(`Kein ${emu.name}-Download für ${process.platform} gefunden`);
  const res = await fetch(asset.browser_download_url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer()); // download fully before removing a working install
  const dir = dirFor(id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset.name);
  writeFileSync(file, bytes);
  let ok = true;
  if (process.platform !== 'darwin' && /\.(zip|7z)$/i.test(asset.name)) {
    // Windows / Linux: unpacked in JavaScript – no PowerShell quoting, and Windows 10's tar.exe can't read 7z (LZMA)
    try {
      await extractArchiveAsync(file, dir); // on a worker thread: the app's window stays responsive
    } catch (e) {
      rmSync(dir, { recursive: true, force: true }); // no half-unpacked emulator left to be found
      throw new Error(`Entpacken fehlgeschlagen: ${e.message}`);
    }
  } else if (asset.name.endsWith('.dmg')) {
    const mount = join(dir, 'mnt');
    mkdirSync(mount, { recursive: true });
    ok = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file]).status === 0;
    if (ok) {
      const app = findIn(mount, (n) => emu.app.test(n), 1);
      if (app) cpSync(app, join(dir, app.split('/').pop()), { recursive: true, verbatimSymlinks: true });
      spawnSync('hdiutil', ['detach', mount, '-force']);
      rmSync(mount, { recursive: true, force: true });
      ok = !!app;
    }
  } else if (asset.name.endsWith('.zip')) {
    ok = spawnSync('ditto', ['-x', '-k', file, dir]).status === 0; // macOS: keeps the .app bundle intact
  } else if (/appimage$/i.test(asset.name)) {
    chmodSync(file, 0o755);
  }
  if (!ok) throw new Error('Entpacken fehlgeschlagen');
  if (!/appimage$/i.test(asset.name)) rmSync(file, { force: true });
  const inner = findIn(dir, (n) => /\.AppImage$/i.test(n));
  if (inner) chmodSync(inner, 0o755);
  if (process.platform === 'darwin') {
    const app = findIn(dir, (n) => emu.app.test(n));
    if (app) spawnSync('xattr', ['-dr', 'com.apple.quarantine', app]);
  }
  return { ...detectEmulator(id), version: rel.tag_name };
}

/** Resolves once the process has started; rejects if it can't be spawned (e.g. not executable). */
export async function launchRom(id, romPath, { customPath, script } = {}) {
  const emu = detectEmulator(id, customPath);
  if (!emu.installed) throw new Error(`${EMULATORS[id]?.name || id} ist nicht installiert`);
  // A .cia isn't started from the file – Azahar installs it (File › Install CIA) and lists the game; open it empty.
  const args = romPath && !(id === 'azahar' && /\.z?cia$/i.test(romPath)) ? [romPath] : [];
  let child;
  const exeName = basename(emu.path.replace(/[\\/]+$/, ''));
  if (id === 'azahar') {
    // One Azahar at a time: a second one would find its RPC port taken (no live data), and on macOS `open -a` only
    // brings an open Azahar to the front without handing it the game.
    if (emulatorRunning(/(?:^|[\\/"])azahar(?:\.exe)?(?:"|$)/im)) throw httpError(409, 'Azahar läuft schon – starte das Spiel dort oder schließe Azahar zuerst', 'emulatorOpen', { emu: 'Azahar' });
  }
  if (process.platform === 'darwin' && /\.app$/i.test(exeName)) {
    if (!EMULATORS[id].app.test(exeName)) throw httpError(400, 'Ungültiger Emulator-Pfad', 'badEmulatorPath');
    child = spawn('open', ['-a', emu.path, '--args', ...args], { detached: true, stdio: 'ignore' });
  } else {
    if (!EMULATORS[id].exe.test(exeName)) throw httpError(400, 'Ungültiger Emulator-Pfad', 'badEmulatorPath');
    // Windows: started from its own folder, so mGBA's portable.ini (settings next to the exe) and its DLLs are found
    child = spawn(emu.path, args, { detached: true, stdio: 'ignore', ...(process.platform === 'win32' ? { cwd: dirname(emu.path) } : {}) });
  }
  // An unhandled 'error' event on the child would crash the whole server.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => reject(new Error(`${EMULATORS[id]?.name || id} konnte nicht gestartet werden: ${e.message}`)));
  });
  child.unref();
  return { ...emu, script };
}

/**
 * The command that shows `path` selected in the file manager (Finder / Explorer), as [command, args, options].
 * Linux has no common "select this file" command: xdg-open opens the folder (a file's own folder – xdg-open on the
 * file itself would open it, e.g. start an emulator with a ROM).
 */
export function revealCommand(path, platform = process.platform, { isDir = false } = {}) {
  if (platform === 'darwin') return ['open', ['-R', path], {}];
  // Explorer parses its own command line: /select,"C:\path with spaces\file" – passed verbatim, quoted by hand
  // (Windows paths can't contain quotes).
  if (platform === 'win32') return ['explorer.exe', [`/select,"${path.replace(/"/g, '')}"`], { windowsVerbatimArguments: true }];
  return ['xdg-open', [isDir ? path : posix.dirname(path)], {}];
}

export function revealInFileManager(path) {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    // gone meanwhile – its folder is still worth showing
  }
  const [cmd, args, opts] = revealCommand(path, process.platform, { isDir });
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
  child.on('error', (e) => console.warn('reveal failed:', e.message));
  child.unref();
}

/**
 * Is an external emulator process running? (It would overwrite edits to the .sav.) `names`: which program names
 * count (default: every emulator souldew knows).
 */
export function emulatorRunning(names = /melonDS|NooDS|DeSmuME|desmume|mGBA|azahar/i) {
  try {
    if (process.platform === 'win32') {
      return names.test(spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || '');
    }
    // every process's command name (procps on Linux spells "all processes" -e, BSD / macOS ps -ax)
    const out = spawnSync('ps', process.platform === 'linux' ? ['-eo', 'comm='] : ['-axo', 'comm='], { encoding: 'utf8' }).stdout || '';
    return out.split('\n').some((line) => names.test(line.split('/').pop()));
  } catch {
    return false;
  }
}
