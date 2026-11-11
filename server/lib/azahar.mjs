// Azahar (Nintendo 3DS emulator, github.com/azahar-emu/azahar): live data through its RPC server.
//
// Azahar answers UDP requests on port 45987 when "Enable RPC server" is on (Settings › Debug, config key
// [Debugging] enable_rpc_server). Protocol (src/core/rpc/packet.h, dist/scripting/AzaharRPC.py – version 2 since
// Azahar 2126): a 16-byte header { u32 version = 2, u32 id, u32 type, u32 data size } and up to 32 KiB of data, all
// little-endian; the reply repeats the header with its own data. Requests used here – souldew only ever reads:
//   1 ReadMemory      { u32 address, u32 size }        → the bytes (of the selected process)
//   3 ProcessList     { u32 start, u32 max }           → { u32 count, count × { u32 pid, u64 title ID, char[8] name } }
//   4 SetGetProcess   { u32 0 = get / 1 = set, u32 pid } → get: { u32 pid }
// The server listens on every network interface, not only this computer: while it is on, anyone on the same network
// can read and change the running game's memory. souldew therefore switches it on only when asked to (the button
// in the play view explains that), never by itself.
//
// AzaharBridge polls it: which title runs (the process list), and for a game souldew knows (shared/data/addresses.json,
// platform '3ds') the memory regions of its party – emitted as the same 'live' frames the mGBA bridge sends, so the
// page parses them with the same code.
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { findEntry, regionsFor } from '../../shared/live/parse.mjs';
import { titleKind } from '../../shared/ctr.mjs';

export const RPC_PORT = 45987;
export const RPC_VERSION = 2;
export const MAX_DATA = 32 * 1024;
export const TYPE = { ReadMemory: 1, WriteMemory: 2, ProcessList: 3, SetGetProcess: 4 };

/** A request packet: header + data (Buffer). */
export function packet(id, type, data = Buffer.alloc(8)) {
  const h = Buffer.alloc(16);
  h.writeUInt32LE(RPC_VERSION, 0);
  h.writeUInt32LE(id >>> 0, 4);
  h.writeUInt32LE(type, 8);
  h.writeUInt32LE(data.length, 12);
  return Buffer.concat([h, data]);
}

/** A reply: { version, id, type, data } – null if it isn't a well-formed RPC packet. */
export function parseReply(buf) {
  if (!buf || buf.length < 16) return null;
  const size = buf.readUInt32LE(12);
  if (size !== buf.length - 16 || size > MAX_DATA) return null;
  return { version: buf.readUInt32LE(0), id: buf.readUInt32LE(4), type: buf.readUInt32LE(8), data: buf.subarray(16) };
}

const args = (a, b) => {
  const d = Buffer.alloc(8);
  d.writeUInt32LE(a >>> 0, 0);
  d.writeUInt32LE(b >>> 0, 4);
  return d;
};

/** Process list reply → [{ pid, titleId, name }]. */
export function parseProcessList(data) {
  if (!data || data.length < 4) return [];
  const n = data.readUInt32LE(0);
  const out = [];
  for (let i = 0; i < n && 4 + (i + 1) * 0x14 <= data.length; i++) {
    const o = 4 + i * 0x14;
    const hi = data.readUInt32LE(o + 8);
    const lo = data.readUInt32LE(o + 4);
    const titleId = (hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')).toUpperCase();
    const name = data.subarray(o + 12, o + 20).toString('latin1').replace(/\0.*$/s, '');
    out.push({ pid: data.readUInt32LE(o), titleId, name });
  }
  return out;
}

/** UDP client for Azahar's RPC server (one socket, requests matched to replies by id). */
export class AzaharRpc {
  constructor({ host = '127.0.0.1', port = RPC_PORT, timeout = 400 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.pending = new Map();
    this.socket = null;
  }

  open() {
    if (this.socket) return;
    const s = createSocket('udp4');
    s.on('message', (msg, rinfo) => {
      // only replies from the address asked (another program on the network can't slip data in)
      if (rinfo.address !== this.host || rinfo.port !== this.port) return;
      const r = parseReply(msg);
      const p = r && this.pending.get(r.id);
      if (!p || r.type !== p.type || r.version !== RPC_VERSION) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      p.resolve(r.data);
    });
    s.on('error', () => this.close());
    // replies are up to 32 KiB + header; macOS allows 9 KiB datagrams by default (Azahar raises its own buffers too)
    s.on('listening', () => {
      try {
        if (s.getRecvBufferSize() < MAX_DATA * 4) s.setRecvBufferSize(MAX_DATA * 4);
        if (s.getSendBufferSize() < MAX_DATA * 2) s.setSendBufferSize(MAX_DATA * 2);
      } catch {
        // the system's limit – small reads still work
      }
    });
    s.bind(0);
    s.unref?.();
    this.socket = s;
  }

  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }

  /** Send one request; resolves with the reply data, or null after the timeout (Azahar not running / RPC off). */
  request(type, data) {
    this.open();
    const id = randomBytes(4).readUInt32LE(0);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, this.timeout);
      // (not unref'd: a request someone awaits keeps the process until its answer or the timeout – an unref'd timer
      // left the promise pending forever when nothing else ran, e.g. Azahar closed and no other work)
      this.pending.set(id, { type, resolve, timer });
      this.socket.send(packet(id, type, data), this.port, this.host, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      });
    });
  }

  async processList() {
    const all = [];
    for (let start = 0; start < 256;) {
      const d = await this.request(TYPE.ProcessList, args(start, 0x7fffffff));
      if (!d) return all.length ? all : null;
      const got = parseProcessList(d);
      if (!got.length) break;
      all.push(...got);
      start += got.length;
    }
    return all;
  }

  async selectedProcess() {
    const d = await this.request(TYPE.SetGetProcess, args(0, 0));
    return d && d.length >= 4 ? d.readUInt32LE(0) : null;
  }

  async selectProcess(pid) {
    return (await this.request(TYPE.SetGetProcess, args(1, pid))) !== null;
  }

  /** Read `len` bytes at `addr` of the selected process (in 32 KiB requests); null if any request fails. */
  async read(addr, len) {
    const out = Buffer.alloc(len);
    for (let done = 0; done < len;) {
      const n = Math.min(MAX_DATA, len - done);
      const d = await this.request(TYPE.ReadMemory, args(addr + done, n));
      if (!d || d.length !== n) return null;
      d.copy(out, done);
      done += n;
    }
    return out;
  }
}

// ---- Azahar's settings ------------------------------------------------------------------------------------------

/**
 * Where Azahar keeps qt-config.ini (src/common/file_util.cpp SetUserPath) when it isn't portable: %APPDATA%\Azahar on
 * Windows; on macOS ~/Library/Application Support/Azahar unless the XDG folders of an older setup exist; on Linux
 * $XDG_CONFIG_HOME/azahar-emu (Flathub's build: its own under ~/.var/app). The one in use first.
 */
export function configCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  // (that system's path rules – the tests ask for another system's paths, Windows CI for Linux's)
  const { join: pj } = platform === 'win32' ? win32 : posix;
  const xdgConfig = env.XDG_CONFIG_HOME || pj(home, '.config');
  if (platform === 'win32') return [pj(env.APPDATA || pj(home, 'AppData', 'Roaming'), 'Azahar', 'config', 'qt-config.ini')];
  if (platform === 'darwin') {
    return [pj(xdgConfig, 'azahar-emu', 'qt-config.ini'), pj(home, 'Library', 'Application Support', 'Azahar', 'config', 'qt-config.ini')];
  }
  return [pj(xdgConfig, 'azahar-emu', 'qt-config.ini'), pj(home, '.var', 'app', 'org.azahar_emu.Azahar', 'config', 'azahar-emu', 'qt-config.ini')];
}

/**
 * Azahar's portable mode: a "user" folder next to the program holds everything (settings, saves). Windows looks next
 * to azahar.exe; macOS next to Azahar.app (Azahar makes the .app's folder its working directory at start-up,
 * src/citra_qt/citra_qt.cpp LaunchQtFrontend, and then looks for ./user). Linux only looks in the working directory a
 * launcher started it in – not something souldew can know. `emuPath` = the .app / the executable.
 */
export function portableUserDir(emuPath, platform = process.platform) {
  if (!emuPath || typeof emuPath !== 'string') return null;
  const clean = emuPath.replace(/[\\/]+$/, '');
  if (platform === 'darwin' ? !/\.app$/i.test(clean) : platform !== 'win32') return null;
  const dir = join(dirname(clean), 'user');
  return existsSync(dir) ? dir : null;
}

/** macOS: Azahar keeps using the XDG folders when an older setup created any of them. */
function macUsesXdg(env, home) {
  const dirs = [env.XDG_DATA_HOME || join(home, '.local', 'share'), env.XDG_CONFIG_HOME || join(home, '.config'), env.XDG_CACHE_HOME || join(home, '.cache')];
  return dirs.some((d) => existsSync(join(d, 'azahar-emu')));
}

/**
 * The config file Azahar reads: in its portable folder when it has one (`emuPath`: the installed Azahar), else the
 * first candidate that exists, else where a fresh install will put it.
 */
export function configPath(opts = {}) {
  const platform = opts.platform || process.platform;
  const portable = portableUserDir(opts.emuPath, platform);
  if (portable) return join(portable, 'config', 'qt-config.ini');
  const list = configCandidates(opts);
  if (platform === 'darwin') return macUsesXdg(opts.env || process.env, opts.home || homedir()) ? list[0] : list[1];
  return list.find((p) => existsSync(p)) || list[0];
}

/** Is [Debugging] enable_rpc_server on in this ini text? */
export function rpcEnabledIn(text) {
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (section === 'Debugging' && /^enable_rpc_server\s*=/.test(line)) return /=\s*true\s*$/i.test(line);
  }
  return false;
}

/**
 * The ini text with the RPC server switched on (Qt's QSettings format: "key\default=false" marks a value the user
 * changed). Everything else stays as it is – line endings included.
 */
export function withRpcEnabled(text) {
  const eol = /\r\n/.test(text || '') ? '\r\n' : '\n';
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const set = { 'enable_rpc_server\\default': 'false', enable_rpc_server: 'true' };
  const start = lines.findIndex((l) => l.trim() === '[Debugging]');
  if (start < 0) {
    if (lines.length) lines.push('');
    lines.push('[Debugging]', ...Object.entries(set).map(([k, v]) => `${k}=${v}`));
    return lines.join(eol) + eol;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  for (const [k, v] of Object.entries(set)) {
    const i = lines.findIndex((l, j) => j > start && j < end && l.trim().startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else {
      lines.splice(end, 0, `${k}=${v}`);
      end++;
    }
  }
  return lines.join(eol) + eol;
}

export function readRpcSetting(opts = {}) {
  const path = configPath(opts);
  try {
    return { path, enabled: rpcEnabledIn(readFileSync(path, 'utf8')), exists: true };
  } catch {
    return { path, enabled: false, exists: false };
  }
}

/** Switch the RPC server on in Azahar's config (takes effect the next time Azahar starts). */
export function enableRpc(opts = {}) {
  const path = configPath(opts);
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // Azahar hasn't run yet: a config with just this setting – Azahar fills in the rest
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, withRpcEnabled(text));
  return { path, enabled: true };
}

// ---- the bridge -------------------------------------------------------------------------------------------------

const POLL_LIVE = 500; // a game souldew reads: twice a second
const POLL_IDLE = 2000; // Azahar running, no game / an unknown one
const POLL_OFF = 3000; // no answer

export class AzaharBridge {
  /** emit(event, data) – 'live' frames like the mGBA bridge's; `table` = addresses.json */
  constructor(emit, { rpc = new AzaharRpc(), table = { games: [] }, now = () => Date.now(), emuPath = () => null, platform = process.platform } = {}) {
    this.emit = emit;
    this.platform = platform; // whose rules find Azahar's settings (tests check another system's)
    this.emuPath = emuPath; // where Azahar is installed – its portable folder has the settings
    this.rpc = rpc;
    this.table = table;
    this.now = now;
    this.timer = null;
    this.running = false;
    this.state = { connected: false, since: null, process: null, game: null, supported: false, lastAt: null, error: null };
    this.pid = null;
  }

  status() {
    return { ...this.state, setting: readRpcSetting({ emuPath: this.emuPath(), platform: this.platform }) };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      let wait = POLL_OFF;
      try {
        wait = await this.poll();
      } catch (e) {
        this.state.error = e.message;
      }
      if (this.running) this.timer = setTimeout(loop, wait);
      this.timer?.unref?.();
    };
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.rpc.close();
  }

  setState(patch) {
    const before = JSON.stringify(this.state);
    Object.assign(this.state, patch);
    if (JSON.stringify(this.state) !== before) this.emit('azahar-status', this.status());
  }

  /** One round: find the game, read its party. Returns the delay until the next one. */
  async poll() {
    const procs = await this.rpc.processList();
    if (!procs) {
      this.pid = null;
      this.setState({ connected: false, process: null, game: null, supported: false });
      return POLL_OFF;
    }
    if (!this.state.connected) this.setState({ connected: true, since: this.now(), error: null });
    // the running application: a game title (not a system module / applet) – or homebrew started from a .3dsx, which
    // runs without a title ID (0)
    const app = procs.find((p) => titleKind(p.titleId) === 'game') || procs.find((p) => /^0{16}$/.test(p.titleId)) || null;
    if (!app) {
      this.pid = null;
      this.setState({ process: null, game: null, supported: false });
      return POLL_IDLE;
    }
    const game = { platform: '3ds', code: '', title: app.name, titleId: app.titleId };
    const entry = findEntry(this.table, game);
    game.entryId = entry?.id || null;
    if (this.pid !== app.pid) {
      if (!(await this.rpc.selectProcess(app.pid))) return POLL_IDLE;
      this.pid = app.pid;
    }
    this.setState({ process: { pid: app.pid, titleId: app.titleId, name: app.name }, game, supported: !!entry });
    if (!entry) return POLL_IDLE;
    const regions = [];
    for (const r of regionsFor(entry)) {
      const b = await this.rpc.read(r.addr, r.len);
      if (!b) return POLL_IDLE; // Azahar busy (loading a state) or closed meanwhile
      regions.push({ ...r, hex: b.toString('hex') });
    }
    const frame = { source: 'azahar', at: this.now(), game, regions };
    this.state.lastAt = frame.at;
    this.emit('live', frame);
    return POLL_LIVE;
  }
}

