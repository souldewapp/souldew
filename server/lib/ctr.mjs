// Nintendo 3DS in souldew's own player: the native host (native/ctr-host) runs Azahar's libretro core with Vulkan and
// speaks a small binary protocol on stdin/stdout (see the header of native/ctr-host/ctrhost.c). This module finds the
// tools, starts one session at a time and hands the host's output to the player page as it comes (one HTTP stream,
// the host's messages unchanged); the page's commands (input, speed, save states, which memory to watch, cheats) go
// back in.
//
// tools/ctr/<platform>-<arch>/ (bundled with the app, or in the data folder's tools):
//   ctrhost[.exe]                                  the host
//   azahar_libretro.dylib | .dll | .so             the core – souldew's build reads the game's memory for live data
//                                                   (native/azahar-patch); Azahar's own core runs the game without it
//   libMoltenVK.dylib (macOS)                      Vulkan on Metal; Windows/Linux use the system's Vulkan loader
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { BUNDLED_TOOLS, TOOLS_DIR, DATA_DIR, DEV, APP_ROOT } from './paths.mjs';
import { httpError } from './fsutil.mjs';
import { identifyCtr } from '../../shared/ctr.mjs';
import { nextRenderer, rendererFailure, withRenderer, withArg, scaleFor } from './ctrrenderer.mjs';

export const PLATFORM_DIR = `${process.platform}-${process.arch}`;
// Android: the app's native library folder (SLS_NATIVE_DIR, set by NodeService) is the one place an app may run files
// from – the host is packed as libctrhost.so (an executable with a library's name), the core as libazahar_libretro.so,
// and the system has its own Vulkan loader (libvulkan.so).
const ANDROID = process.platform === 'android';
const EXE = ANDROID ? 'libctrhost.so' : process.platform === 'win32' ? 'ctrhost.exe' : 'ctrhost';
const CORE = ANDROID ? 'libazahar_libretro.so' : process.platform === 'win32' ? 'azahar_libretro.dll' : process.platform === 'darwin' ? 'azahar_libretro.dylib' : 'azahar_libretro.so';
const VULKAN = { darwin: 'libMoltenVK.dylib', win32: 'vulkan-1.dll', linux: 'libvulkan.so.1', android: 'libvulkan.so' }[process.platform];

/**
 * Core options the host sets from its environment (ctrhost.c CTRHOST_OPT_<option>), per platform. Android: the hardware
 * vertex shaders off – Adreno's driver (checked on an Adreno 750) answers vkCreateGraphicsPipelines with ErrorUnknown for
 * the pipelines of Azahar's hardware vertex shaders, which Azahar turns into an abort a few seconds into the game
 * (the first screen that needs one, e.g. Omega Ruby's language screen). Without them the game runs for minutes.
 * → undefined where the host needs no change (it then inherits the server's environment).
 */
export function androidHostEnv({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'android') return undefined;
  return { ...env, CTRHOST_OPT_citra_use_hw_shader: 'disabled' };
}

/** Message types of the protocol (ctrhost.c). */
export const MSG = { HELLO: 1, VIDEO: 2, AUDIO: 3, MEM: 4, STATE: 5, LOG: 6, EVENT: 7 };
export const CMD = { INPUT: 1, SPEED: 2, SAVE: 3, LOAD: 4, WATCH: 5, QUIT: 6, RESET: 7, FRAMESKIP: 8, WRITE: 9 };

/** The game's heaps – the only memory a cheat may write (the host checks the same: ctrhost.c write_ranges). */
export const CTR_WRITE_RANGES = [[0x08000000, 0x10000000], [0x14000000, 0x1c000000], [0x30000000, 0x40000000]];
export const CTR_WRITE_MAX = 256;

/**
 * Is this WRITE payload one souldew's player sends? { u32 id, u32 addr, u32 len, old[len], new[len] }: 1–256 bytes
 * inside one 4 KB page of the game's heaps.
 */
export function ctrWriteOk(p) {
  if (p.length < 12) return false;
  const addr = p.readUInt32LE(4);
  const len = p.readUInt32LE(8);
  if (!len || len > CTR_WRITE_MAX || p.length !== 12 + 2 * len || (addr & 0xfff) + len > 0x1000) return false;
  return CTR_WRITE_RANGES.some(([a, b]) => addr >= a && addr + len <= b);
}

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
  if (ANDROID) return process.env.SLS_NATIVE_DIR ? [process.env.SLS_NATIVE_DIR] : [];
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
  return { ok: true, dir, host: join(dir, EXE), core: join(dir, CORE), vulkan, souldewCore: ANDROID || existsSync(join(dir, 'SOULDEW_CORE')) };
}

/** Is the 3DS game file an encrypted dump? (Azahar plays decrypted games only.) Unreadable / unknown: false. */
export function ctrEncrypted(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const readAt = (o, n) => {
      const b = Buffer.alloc(n);
      return new Uint8Array(b.buffer, b.byteOffset, readSync(fd, b, 0, n, o));
    };
    return !!identifyCtr(readAt, extname(path).slice(1))?.encrypted;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
  if (rest.length || !messages.length) throw httpError(400, 'Invalid command', 'badCommand');
  const limits = { [CMD.INPUT]: 32, [CMD.SPEED]: 4, [CMD.SAVE]: 0, [CMD.LOAD]: 256 * 1024 * 1024, [CMD.WATCH]: 4 + 16 * 8, [CMD.QUIT]: 0, [CMD.RESET]: 0, [CMD.FRAMESKIP]: 4, [CMD.WRITE]: 12 + 2 * CTR_WRITE_MAX };
  for (const m of messages) {
    if (!(m.type in limits) || m.payload.length > limits[m.type]) throw httpError(400, 'Invalid command', 'badCommand');
    if (m.type === CMD.WRITE && !ctrWriteOk(m.payload)) throw httpError(400, 'Invalid command', 'badCommand');
  }
  return body;
}

/**
 * Splits the host's output into whole messages as it comes (chunks are cut anywhere): push(chunk) → complete
 * messages as [{ type, data }], `data` the message with its header – the bytes as the host sent them.
 */
export class MessageSplitter {
  constructor() {
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const out = [];
    for (;;) {
      if (this.size < 8) break;
      if (this.chunks[0].length < 8) this.merge(8);
      const head = this.chunks[0];
      const need = 8 + head.readUInt32LE(4);
      if (this.size < need) break; // (a picture comes in many chunks: merged once, when it is complete)
      if (head.length < need) this.merge(need);
      const first = this.chunks[0];
      out.push({ type: first.readUInt32LE(0), data: first.subarray(0, need) });
      if (first.length === need) this.chunks.shift();
      else this.chunks[0] = first.subarray(need);
      this.size -= need;
    }
    return out;
  }

  /** The first `n` bytes into the first chunk. */
  merge(n) {
    const all = Buffer.concat(this.chunks, this.size);
    this.chunks = [all];
    if (all.length < n) throw new Error('merge past the end');
  }
}

// Windows exception codes a crashed host ends with (the exit code is the NTSTATUS)
const NTSTATUS = {
  0xc0000005: 'access violation', 0xc000001d: 'illegal instruction', 0xc00000fd: 'stack overflow', 0xc0000094: 'division by zero',
  0xc0000409: 'stack buffer overrun / fail-fast', 0xc0000374: 'heap corruption', 0xc0000135: 'a DLL is missing', 0xc0000139: 'a DLL entry point is missing',
  0xc0000142: 'a DLL failed to initialise', 0x40000015: 'abort', 0xe06d7363: 'C++ exception',
};

/** How a host ended, readable: "exit code 0xC0000005 (access violation)", "signal SIGSEGV", "exit code 1". */
export function exitText(exit) {
  if (!exit) return '';
  if (exit.error) return exit.error;
  if (exit.signal) return `signal ${exit.signal}`;
  const c = Number(exit.code);
  if (!Number.isFinite(c)) return '';
  const u = c >>> 0;
  if (u >= 0x40000000) return `exit code 0x${u.toString(16).toUpperCase()}${NTSTATUS[u] ? ` (${NTSTATUS[u]})` : ''}`;
  return `exit code ${c}`;
}

/** Text from the host for diagnostics, with the home folder shortened (it holds the user name). */
export function redactHome(text, home = homedir()) {
  let out = String(text);
  if (!home || home.length < 3) return out;
  // as written, and as it reads inside JSON (Windows: C:\\Users\\Name)
  for (const h of new Set([home, JSON.stringify(home).slice(1, -1)])) out = out.split(h).join('~');
  return out;
}

/**
 * The players' log file (data folder › logs › players.log): every host that ended badly, one JSON line each – it
 * survives a restart of souldew (people often restart before they save the diagnostics). Kept small (rotated at 512 KB).
 */
export const PLAYER_LOG = join(DATA_DIR, DEV ? 'runs/logs' : 'logs', 'players.log');
export function appendPlayerLog(record, file = PLAYER_LOG) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    if (existsSync(file) && statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // a full disk or a read-only folder: the in-memory record still goes into the diagnostics
  }
}
/** The last `n` records of the players' log (newest last). */
export function readPlayerLog(n = 5, file = PLAYER_LOG) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Kept for a page that isn't connected (yet): the start, events and save states – pictures, sound only up to this. */
const BUFFER_LIMIT = 8 * 1024 * 1024;
/** A session no page ever connected to (the page failed right after starting it) ends after this. */
const NEVER_ATTACHED = 60 * 1000;

export class CtrSessions {
  /** `spawn`: how the host is started (tests start a stand-in) */
  constructor({ spawn: spawnHost = spawn } = {}) {
    this.spawn = spawnHost;
    this.current = null; // { id, child, stream, buffered, events, exit }
    this.last = null; // how the last session that went wrong ended (diagnostics – kept after it is gone)
    this.logFile = PLAYER_LOG;
    this.keepTypes = [MSG.EVENT, MSG.STATE]; // kept for a page that connects later even past BUFFER_LIMIT
  }

  status() {
    const s = this.current;
    return s ? { id: s.id, running: !s.exit, exit: s.exit, exitText: exitText(s.exit), events: s.events.slice(-5), gpu: s.gpu || null, ...(s.renderer ? { renderer: s.renderer, scale: s.scale || 1, fellBack: s.fellBack || [] } : {}) } : null;
  }

  /** For "Save diagnostics": the running session (with the end of its stderr) and how the last failed one ended. */
  diagnostics() {
    const s = this.current;
    return {
      session: s ? { ...this.status(), stderrStart: redactHome(s.head), stderr: redactHome(s.log.join('').slice(-4000)) } : null,
      last: this.last,
      log: readPlayerLog(5, this.logFile),
    };
  }

  /**
   * A session ended: remember (and log) it when it didn't end the normal way – a crash, an error from the host.
   * `retry`: the renderer the session goes on with (the 3DS player stepped down – see relaunch).
   */
  ended(s, exit, retry = null) {
    if (s.recorded) return;
    s.recorded = true;
    const error = [...s.events].reverse().find((e) => e?.event === 'error');
    const normal = exit && exit.code === 0 && !exit.signal && !error;
    if (normal || s.quit) return; // (s.quit: stopped by souldew – the host's _exit after QUIT, or the kill)
    this.last = {
      at: new Date().toISOString(),
      exit: exitText(exit) || null,
      error: error?.message ? redactHome(error.message).slice(0, 1000) : null,
      gpu: s.gpu || null,
      ...(s.renderer ? { renderer: s.renderer, scale: s.scale || 1 } : {}),
      ...(retry ? { retriedWith: retry } : {}),
      startedAt: s.startedAt,
      secondsRun: Math.round((Date.now() - s.startedAt) / 1000),
      stderrStart: redactHome(s.head),
      stderr: redactHome(s.log.join('').slice(-4000)),
    };
    appendPlayerLog({ player: this.label || '3ds', ...this.last }, this.logFile);
    console.warn(`[${this.label || '3ds'}] the host ended: ${this.last.exit || '?'}${this.last.error ? ` – ${this.last.error}` : ''}${s.gpu ? ` – GPU ${s.gpu.name} (driver ${s.gpu.driver})` : ''}${retry ? ` – renderer ${s.renderer}, trying ${retry}` : ''}`);
    const tail = this.last.stderr.trim().split('\n').slice(-8).join('\n');
    if (tail) console.warn(tail);
  }

  /**
   * Start the game `rom` (a path) with the save folder of `key`; ends a session that still runs. `renderer`: how the
   * host draws (server/lib/ctrrenderer.mjs); `auto`: a crash in the first seconds steps down to the next safer one.
   */
  start({ rom, key, tools, scale = 1, renderer = 'vulkan', auto = false }) {
    this.stop();
    const save = saveDirFor(key);
    const system = join(save, 'system');
    mkdirSync(system, { recursive: true });
    const sc = scaleFor(scale, renderer);
    const args = ['--core', tools.core, '--vulkan', tools.vulkan, '--rom', rom, '--system', system, '--save', save, '--scale', String(sc), '--renderer', renderer];
    return this.launch(tools.host, args, save, { renderer, scale: sc, auto: !!auto, fellBack: [] });
  }

  /**
   * Start a host (`exe` with `args`) as the current session – shared with the DS / GBA / GB host (native.mjs).
   * `extra`: more of the session (the 3DS renderer).
   */
  launch(exe, args, save, extra = {}) {
    this.stop();
    const s = { id: randomBytes(8).toString('hex'), exe, args, save, child: null, stream: null, buffered: [], bufferedBytes: 0, events: [], exit: null, closed: false, held: false, log: [], head: '', startedAt: Date.now(), lastCmds: {}, ...extra };
    s.orphan = setTimeout(() => {
      if (!s.stream && this.current === s) this.stop();
    }, NEVER_ATTACHED);
    s.orphan.unref?.();
    this.current = s;
    this.run(s);
    return s.id;
  }

  /** Spawn the session's host (again, after relaunch: the page's stream goes on). */
  run(s) {
    const env = this.hostEnv?.() ?? androidHostEnv();
    const child = this.spawn(s.exe, s.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) });
    Object.assign(s, { child, exit: null, recorded: false, held: false, events: [], heldErrors: [], startedAt: Date.now() });
    // the host may still step down (3DS, "auto"): its error event waits until it is clear the session doesn't go on
    // with another renderer – the page would show "the game has stopped" for a game that is about to run
    const mayRetry = !!(s.auto && s.renderer && nextRenderer(s.renderer));
    const mine = () => s.child === child;
    const split = new MessageSplitter();
    child.stdout.on('data', (chunk) => {
      if (!mine()) return;
      // whole messages only: a page that connects later (or a new one) must start at a message's beginning
      for (const m of split.push(chunk)) {
        if (m.type === MSG.EVENT) {
          const e = this.peek(s, m.data);
          if (mayRetry && e?.event === 'error') {
            s.heldErrors.push(m.data);
            continue;
          }
        }
        this.onMessage?.(s, m, writable(s.stream)); // (native.mjs: the last battery save after the page has gone)
        this.forward(s, m);
      }
    });
    child.stderr.on('data', (d) => {
      if (!mine()) return;
      // the start (the Vulkan loader, the graphics cards, the device) is kept apart: the core's warnings later would
      // push it out of the tail
      if (s.head.length < 10000) s.head += String(d).slice(0, 10000 - s.head.length);
      s.log.push(String(d));
      if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
    });
    child.on('exit', (code, signal) => {
      if (mine()) s.exit = { code, signal };
    });
    // the end of the stream once the host's output is all read: 'exit' can come before the last of it (the error
    // event a failing host sends right before it leaves), and a write after end() is an unhandled 'error'
    const done = () => {
      s.closed = true;
      clearTimeout(s.orphan);
      s.stream?.end();
    };
    // (after the last output is read: the host's error event comes right before it leaves)
    child.on('close', (code, signal) => {
      if (!mine()) return;
      s.exit ||= { code, signal };
      if (this.relaunch(s)) return;
      this.ended(s, s.exit);
      for (const data of s.heldErrors.splice(0)) this.forward(s, { type: MSG.EVENT, data });
      done();
    });
    child.on('error', (e) => {
      if (!mine()) return;
      s.exit = { error: e.message };
      this.ended(s, s.exit);
      for (const data of s.heldErrors.splice(0)) this.forward(s, { type: MSG.EVENT, data });
      done();
    });
    child.stdin.on('error', () => {});
  }

  /** One whole message of the host to the page – or kept for a page that connects later. */
  forward(s, m) {
    if (writable(s.stream)) {
      // the page reads the host's messages as they are; a slow page holds the host back (no frames pile up)
      if (!s.stream.write(m.data) && !s.held) {
        s.held = true;
        s.child.stdout.pause();
        s.stream.once('drain', () => this.release(s));
      }
    } else if (s.bufferedBytes + m.data.length <= BUFFER_LIMIT || this.keepTypes.includes(m.type)) {
      // before the page connects: keep the start (the "loaded" event, a few frames) and what is answered
      s.buffered.push(m.data);
      s.bufferedBytes += m.data.length;
    }
  }

  /**
   * 3DS, renderer "auto": the host ended in its first seconds the way a graphics driver problem ends – start it again
   * with the next safer renderer in the same session (the page's stream goes on, the memory it watches, its speed and
   * pause are handed to the new host). onRendererFailed remembers the step for this graphics card. False: not this case.
   */
  relaunch(s) {
    if (s.quit || this.current !== s || !s.auto || !s.renderer) return false;
    const next = nextRenderer(s.renderer);
    if (!next || !rendererFailure({ exit: s.exit, events: s.events, ms: Date.now() - s.startedAt })) return false;
    const from = s.renderer;
    this.ended(s, s.exit, next);
    s.heldErrors = [];
    s.fellBack.push(from);
    this.onRendererFailed?.({ gpu: s.gpu || null, from, to: next });
    s.log.push(`[souldew] the 3DS host ended in its first seconds with the renderer "${from}" – starting it again with "${next}"\n`);
    s.renderer = next;
    // (back to 1× resolution as well: a higher one asks more of a graphics card that just failed)
    s.scale = 1;
    s.args = withArg(withRenderer(s.args, next), '--scale', 1);
    this.run(s);
    for (const b of Object.values(s.lastCmds)) s.child.stdin.write(b);
    return true;
  }

  /** The page's commands the next host needs as well (relaunch): the last WATCH, SPEED and FRAMESKIP. */
  keepCommands(s, body) {
    for (const m of splitMessages(body).messages) {
      if (m.type === CMD.WATCH || m.type === CMD.SPEED || m.type === CMD.FRAMESKIP) s.lastCmds[m.type] = command(m.type, Buffer.from(m.payload));
    }
  }

  /** Let the host write again (the page caught up, or another page / none reads now). */
  release(s) {
    s.held = false;
    s.child.stdout.resume();
  }

  /** Remember the host's events (loaded, title, errors) for the status. `data`: one whole EVENT message. Returns it. */
  peek(s, data) {
    try {
      const e = JSON.parse(data.subarray(8).toString('utf8'));
      if (e?.event === 'ffrate') return e; // (the fast-forward sound's ratio, many a second: not worth keeping)
      s.events.push(e);
      if (s.events.length > 50) s.events.shift();
      if (e?.event === 'gpu') {
        s.gpu = { name: e.name, type: e.type, vendor: e.vendor, device: e.device, driver: e.driver, api: e.api, index: e.index, count: e.count };
        this.onGpu?.(s.gpu);
      }
      return e;
    } catch {
      return null; // not JSON – skip
    }
  }

  get(id) {
    const s = this.current;
    if (!s || s.id !== id) throw httpError(404, 'No 3DS game is running', 'noCtrSession');
    return s;
  }

  /** The page's stream of host messages (only one: a new one replaces the old). */
  attach(id, res) {
    const s = this.get(id);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.on('error', () => {}); // the page went away mid-write – 'close' handles it
    s.stream?.end();
    clearTimeout(s.orphan);
    s.stream = res;
    // the old stream may have held the host back (its 'drain' never comes once it is ended)
    this.release(s);
    for (const b of s.buffered) res.write(b);
    s.buffered = [];
    s.bufferedBytes = 0;
    if (s.closed) res.end();
    res.on('close', () => {
      if (s.stream !== res) return;
      s.stream = null;
      this.release(s);
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
    if (s.exit) throw httpError(409, 'The 3DS game has stopped', 'ctrEnded');
    s.child.stdin.write(this.check(body));
    if (s.auto) this.keepCommands(s, body);
  }

  /** The commands a page may send this host (checkCommands for the 3DS host). */
  check(body) {
    return checkCommands(body);
  }

  stop() {
    const s = this.current;
    if (!s) return;
    this.current = null;
    s.quit = true;
    clearTimeout(s.orphan);
    try {
      s.child.stdin.write(command(CMD.QUIT));
      s.child.stdin.end();
    } catch {
      // gone
    }
    // (a host held back by a page that no longer reads couldn't see the QUIT – let it write)
    this.release(s);
    s.stream?.end();
    if (s.exit) return;
    const kill = setTimeout(() => s.child.kill('SIGKILL'), 3000);
    kill.unref?.();
    s.child.once('exit', () => clearTimeout(kill));
  }
}

const writable = (res) => !!res && !res.destroyed && !res.writableEnded;

/** The installed tools folder's contents (for the status / diagnostics). */
export function ctrInventory() {
  const dir = ctrDirs().find((d) => existsSync(d));
  try {
    return dir ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}
