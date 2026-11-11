// Nintendo 3DS in souldew's own player: the native host (native/ctr-host) runs Azahar's libretro core with Vulkan and
// speaks a small binary protocol on stdin/stdout (see the header of native/ctr-host/ctrhost.c). This module finds the
// tools, starts one session at a time and hands the host's output to the player page as it comes (one HTTP stream,
// the host's messages unchanged); the page's commands (input, speed, save states, which memory to watch) go back in.
//
// tools/ctr/<platform>-<arch>/ (bundled with the app, or in the data folder's tools):
//   ctrhost[.exe]                                  the host
//   azahar_libretro.dylib | .dll | .so             the core – souldew's build reads the game's memory for live data
//                                                   (native/azahar-patch); Azahar's own core runs the game without it
//   libMoltenVK.dylib (macOS)                      Vulkan on Metal; Windows/Linux use the system's Vulkan loader
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { BUNDLED_TOOLS, TOOLS_DIR, DATA_DIR, DEV, APP_ROOT } from './paths.mjs';
import { httpError } from './fsutil.mjs';

export const PLATFORM_DIR = `${process.platform}-${process.arch}`;
const EXE = process.platform === 'win32' ? 'ctrhost.exe' : 'ctrhost';
const CORE = process.platform === 'win32' ? 'azahar_libretro.dll' : process.platform === 'darwin' ? 'azahar_libretro.dylib' : 'azahar_libretro.so';
const VULKAN = { darwin: 'libMoltenVK.dylib', win32: 'vulkan-1.dll', linux: 'libvulkan.so.1' }[process.platform];

/** Message types of the protocol (ctrhost.c). */
export const MSG = { HELLO: 1, VIDEO: 2, AUDIO: 3, MEM: 4, STATE: 5, LOG: 6, EVENT: 7 };
export const CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, WATCH: 5, QUIT: 6, RESET: 7, FRAMESKIP: 8 };

/** Is the system's Vulkan loader there (Windows, Linux)? Looked up where the dynamic linker finds it. */
export function systemVulkan({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === 'win32') {
    const sys = env.SystemRoot || env.windir || 'C:\\Windows';
    return exists(join(sys, 'System32', 'vulkan-1.dll'));
  }
  if (platform === 'linux') {
    const dirs = [...String(env.LD_LIBRARY_PATH || '').split(':').filter(Boolean), '/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib/x86_64-linux-gnu', '/lib64', '/usr/local/lib', '/run/host/usr/lib/x86_64-linux-gnu'];
    return dirs.some((d) => exists(join(d, 'libvulkan.so.1')));
  }
  return true;
}

/** Where the 3DS tools are, the first folder that has the host and the core. */
export function ctrDirs() {
  return [join(BUNDLED_TOOLS, 'ctr', PLATFORM_DIR), join(TOOLS_DIR, 'ctr', PLATFORM_DIR), ...(DEV ? [join(APP_ROOT, 'tools', 'ctr', PLATFORM_DIR)] : [])];
}

/**
 * The tools for this computer: { ok, host, core, vulkan, liveMemory } – or { ok: false, missing } when something is
 * missing. Vulkan on macOS: the bundled MoltenVK, else the one inside an installed Azahar.app.
 */
export function ctrTools({ azaharApp = null } = {}) {
  const dir = ctrDirs().find((d) => existsSync(join(d, EXE)) && existsSync(join(d, CORE)));
  if (!dir) return { ok: false, missing: 'host' };
  let vulkan = null;
  if (process.platform === 'darwin') {
    const own = join(dir, VULKAN);
    const fromApp = azaharApp ? join(azaharApp, 'Contents', 'Frameworks', VULKAN) : null;
    vulkan = existsSync(own) ? own : fromApp && existsSync(fromApp) ? fromApp : null;
    if (!vulkan) return { ok: false, missing: 'vulkan', dir };
  } else {
    const own = join(dir, VULKAN);
    // the system's loader (Windows: with the graphics driver; Linux: libvulkan1), found by the dynamic linker – without
    // it the 3DS games open in Azahar itself instead of failing in the player
    if (existsSync(own)) vulkan = own;
    else if (systemVulkan()) vulkan = VULKAN;
    else return { ok: false, missing: 'vulkan', dir };
  }
  return { ok: true, dir, host: join(dir, EXE), core: join(dir, CORE), vulkan, souldewCore: existsSync(join(dir, 'SOULDEW_CORE')) };
}

/** A save folder per game / run slot: the 3DS's SD card and system memory of that playthrough. */
export function saveDirFor(key) {
  const h = createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
  return join(DATA_DIR, DEV ? 'runs/.ctr' : 'ctr', 'saves', h);
}

/**
 * A fingerprint of the games' own saves in a save folder: the files under the SD card's title data (path, size, time –
 * nothing is read). It changes when the game saves – the play view's "not saved in the game yet" follows it.
 */
export function saveStamp(saveDir) {
  const root = join(saveDir, 'Azahar', 'sdmc', 'Nintendo 3DS');
  const parts = [];
  const walk = (dir, depth) => {
    let names = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, n.name);
      if (n.isDirectory()) {
        if (depth < 10) walk(p, depth + 1);
      } else if (/[\\/]title[\\/][0-9a-f]{8}[\\/][0-9a-f]{8}[\\/]data[\\/]/i.test(p)) {
        try {
          const st = statSync(p);
          parts.push(`${p.slice(root.length)}:${st.size}:${Math.round(st.mtimeMs)}`);
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(root, 0);
  return parts.length ? createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16) : null;
}

/** Parse host output: complete messages from a buffer → [{ type, payload }], and the rest. */
export function splitMessages(buf) {
  const out = [];
  let p = 0;
  while (buf.length - p >= 8) {
    const type = buf.readUInt32LE(p);
    const len = buf.readUInt32LE(p + 4);
    if (buf.length - p - 8 < len) break;
    out.push({ type, payload: buf.subarray(p + 8, p + 8 + len) });
    p += 8 + len;
  }
  return { messages: out, rest: buf.subarray(p) };
}

/** One framed command for the host. */
export function command(type, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(type, 0);
  h.writeUInt32LE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

/**
 * Commands a page may send, checked before they reach the host: only known types, sane sizes. `body` holds one or
 * more framed commands. Returns the buffer to forward, or throws a 400.
 */
export function checkCommands(body) {
  const { messages, rest } = splitMessages(body);
  if (rest.length || !messages.length) throw httpError(400, 'Ungültiger Befehl', 'badCommand');
  const limits = { [CMD.INPUT]: 32, [CMD.SPEED]: 4, [CMD.SAVE]: 0, [CMD.LOAD]: 256 * 1024 * 1024, [CMD.WATCH]: 4 + 16 * 8, [CMD.QUIT]: 0, [CMD.RESET]: 0, [CMD.FRAMESKIP]: 4 };
  for (const m of messages) {
    if (!(m.type in limits) || m.payload.length > limits[m.type]) throw httpError(400, 'Ungültiger Befehl', 'badCommand');
  }
  return body;
}

export class CtrSessions {
  constructor() {
    this.current = null; // { id, child, stream, buffered, events, exit }
  }

  status() {
    const s = this.current;
    return s ? { id: s.id, running: !s.exit, exit: s.exit, events: s.events.slice(-5) } : null;
  }

  /** Start the game `rom` (a path) with the save folder of `key`; ends a session that still runs. */
  start({ rom, key, tools, scale = 1 }) {
    this.stop();
    const save = saveDirFor(key);
    const system = join(save, 'system');
    mkdirSync(system, { recursive: true });
    const args = ['--core', tools.core, '--vulkan', tools.vulkan, '--rom', rom, '--system', system, '--save', save, '--scale', String(scale)];
    const child = spawn(tools.host, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const s = { id: randomBytes(8).toString('hex'), save, child, stream: null, buffered: [], bufferedBytes: 0, events: [], exit: null, log: [] };
    child.stdout.on('data', (chunk) => {
      if (s.stream && !s.stream.destroyed) {
        // the page reads the host's messages as they are; a slow page holds the host back (no frames pile up)
        if (!s.stream.write(chunk)) {
          child.stdout.pause();
          s.stream.once('drain', () => child.stdout.resume());
        }
      } else if (s.bufferedBytes < 8 * 1024 * 1024) {
        // before the page connects: keep the start (the "loaded" event) – a few frames at most
        s.buffered.push(chunk);
        s.bufferedBytes += chunk.length;
      }
      this.peek(s, chunk);
    });
    child.stderr.on('data', (d) => {
      s.log.push(String(d));
      if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
    });
    child.on('exit', (code, signal) => {
      s.exit = { code, signal };
      s.stream?.end();
    });
    child.on('error', (e) => {
      s.exit = { error: e.message };
      s.stream?.end();
    });
    child.stdin.on('error', () => {});
    this.current = s;
    return s.id;
  }

  /** Remember the host's events (loaded, title, errors) for the status – without parsing every frame twice. */
  peek(s, chunk) {
    s.peekBuf = s.peekBuf ? Buffer.concat([s.peekBuf, chunk]) : chunk;
    for (;;) {
      if (s.peekBuf.length < 8) return;
      const type = s.peekBuf.readUInt32LE(0);
      const len = s.peekBuf.readUInt32LE(4);
      if (s.peekBuf.length < 8 + len) return;
      if (type === MSG.EVENT) {
        try {
          s.events.push(JSON.parse(s.peekBuf.subarray(8, 8 + len).toString('utf8')));
          if (s.events.length > 50) s.events.shift();
        } catch {
          // not JSON – skip
        }
      }
      s.peekBuf = s.peekBuf.subarray(8 + len);
    }
  }

  get(id) {
    const s = this.current;
    if (!s || s.id !== id) throw httpError(404, 'Keine laufende 3DS-Sitzung', 'noCtrSession');
    return s;
  }

  /** The page's stream of host messages (only one: a new one replaces the old). */
  attach(id, res) {
    const s = this.get(id);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    s.stream?.end();
    clearTimeout(s.orphan);
    s.stream = res;
    for (const b of s.buffered) res.write(b);
    s.buffered = [];
    s.bufferedBytes = 0;
    if (s.exit) res.end();
    res.on('close', () => {
      if (s.stream !== res) return;
      s.stream = null;
      s.child.stdout.resume();
      // the player page is gone (closed without saying so, crashed): end the game unless a new page takes over
      clearTimeout(s.orphan);
      s.orphan = setTimeout(() => {
        if (!s.stream && this.current === s) this.stop();
      }, 5000);
      s.orphan.unref?.();
    });
  }

  send(id, body) {
    const s = this.get(id);
    if (s.exit) throw httpError(409, 'Die 3DS-Sitzung ist beendet', 'ctrEnded');
    s.child.stdin.write(checkCommands(body));
  }

  stop() {
    const s = this.current;
    if (!s) return;
    this.current = null;
    try {
      s.child.stdin.write(command(CMD.QUIT));
      s.child.stdin.end();
    } catch {
      // gone
    }
    const kill = setTimeout(() => s.child.kill('SIGKILL'), 3000);
    kill.unref?.();
    s.child.once('exit', () => clearTimeout(kill));
    s.stream?.end();
  }
}

/** The installed tools folder's contents (for the status / diagnostics). */
export function ctrInventory() {
  const dir = ctrDirs().find((d) => existsSync(d));
  try {
    return dir ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}
