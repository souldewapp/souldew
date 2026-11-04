// External emulators: detection, one-click install from GitHub releases, launching.
// The integrated emulator (EmulatorJS inside the app) needs none of this.
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, basename, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TOOLS_DIR } from './paths.mjs';
import { httpError } from './fsutil.mjs';

export const EMULATORS = {
  melonds: {
    name: 'melonDS',
    systems: ['nds'],
    repo: 'melonDS-emu/melonDS',
    live: 'save', // reads the .sav after every in-game save
    assets: { darwin: /macOS-universal\.zip$/i, win32: /windows-x86_64\.zip$/i, linux: /appimage-x86_64\.zip$/i },
    app: /^melonDS.*\.app$/i,
    exe: /^melonDS(\.exe|\.AppImage)?$/i,
  },
  mgba: {
    name: 'mGBA',
    systems: ['gb', 'gbc', 'gba'],
    repo: 'mgba-emu/mgba',
    live: 'script', // Lua bridge streams the party in real time
    assets: { darwin: /-macos\.dmg$/i, win32: /-win64\.7z$/i, linux: /appimage-x64\.appimage$/i },
    app: /^mGBA\.app$/i,
    exe: /^mGBA(\.exe)?$/i,
  },
};

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
    const appName = id === 'mgba' ? 'mGBA.app' : 'melonDS.app';
    candidates.push({ path: `/Applications/${appName}`, source: 'system' }, { path: join(process.env.HOME || '', 'Applications', appName), source: 'system' });
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
  const pattern = emu.assets[process.platform];
  const asset = (rel.assets || []).find((a) => pattern?.test(a.name));
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
  if (asset.name.endsWith('.dmg')) {
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
    ok = (process.platform === 'darwin' ? spawnSync('ditto', ['-x', '-k', file, dir]) : process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${file}' -DestinationPath '${dir}'`])
      : spawnSync('unzip', ['-o', file, '-d', dir])).status === 0;
  } else if (asset.name.endsWith('.7z')) {
    ok = spawnSync('tar', ['-xf', file, '-C', dir]).status === 0; // bsdtar on Windows 10+ reads 7z
  } else if (/appimage$/i.test(asset.name)) {
    spawnSync('chmod', ['+x', file]);
  }
  if (!ok) throw new Error('Entpacken fehlgeschlagen');
  if (!/appimage$/i.test(asset.name)) rmSync(file, { force: true });
  const inner = findIn(dir, (n) => /\.AppImage$/i.test(n));
  if (inner) spawnSync('chmod', ['+x', inner]);
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
  const args = [romPath];
  let child;
  const exeName = basename(emu.path.replace(/[\\/]+$/, ''));
  if (process.platform === 'darwin' && /\.app$/i.test(exeName)) {
    if (!EMULATORS[id].app.test(exeName)) throw httpError(400, 'Ungültiger Emulator-Pfad', 'badEmulatorPath');
    child = spawn('open', ['-a', emu.path, '--args', ...args], { detached: true, stdio: 'ignore' });
  } else {
    if (!EMULATORS[id].exe.test(exeName)) throw httpError(400, 'Ungültiger Emulator-Pfad', 'badEmulatorPath');
    child = spawn(emu.path, args, { detached: true, stdio: 'ignore' });
  }
  // An unhandled 'error' event on the child would crash the whole server.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (e) => reject(new Error(`${EMULATORS[id]?.name || id} konnte nicht gestartet werden: ${e.message}`)));
  });
  child.unref();
  return { ...emu, script };
}

export function revealInFileManager(path) {
  const cmd = process.platform === 'darwin' ? ['open', ['-R', path]] : process.platform === 'win32' ? ['explorer', [`/select,${path}`]] : ['xdg-open', [path]];
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.warn('reveal failed:', e.message));
  child.unref();
}

/** Is an external emulator process running? (It would overwrite edits to the .sav.) */
export function emulatorRunning() {
  const names = /melonDS|NooDS|DeSmuME|desmume|mGBA/i;
  try {
    if (process.platform === 'win32') {
      return names.test(spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '');
    }
    const out = spawnSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).stdout || '';
    return out.split('\n').some((line) => names.test(line.split('/').pop()));
  } catch {
    return false;
  }
}
