// Live bridge for external emulators with a scripting API (mGBA ≥ 0.10).
// A small Lua script runs inside the emulator, connects to this TCP port and streams the
// memory regions we ask for (the player's party) a few times per second. Parsing happens in
// the UI with the same code used for the integrated emulator.
import { createServer } from 'node:net';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DATA_DIR, DEV, SHARED_DIR } from './paths.mjs';
import { findEntry, regionsFor } from '../../shared/live/parse.mjs';

const PORTS = [47123, 47124, 47125];

/** Secret shared by the server and the generated Lua script: proves a connection comes from that script. */
export const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);
/** A browser sending a request to the bridge port (cross-protocol) starts with an HTTP request line. */
export const looksLikeHttp = (line) => /^[A-Z]+ \S+ HTTP\//.test(line);

/** HELLO <token> <platform> <code> <title…> – returns the parsed parts or null if the token doesn't match. */
export function parseHello(line, token) {
  if (!isToken(token) || !line.startsWith('HELLO ')) return null;
  const [, got, platform, code, ...title] = line.split(' ');
  if (!isToken(got)) return null;
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(token))) return null;
  return { platform, code: code || '', title: title.join(' ').trim() };
}

export function luaScript(port, token) {
  if (!isToken(token)) throw new Error('live bridge token missing');
  return `-- souldew live bridge for mGBA (Tools > Scripting > File > Load script)
-- Streams your party to souldew on this computer. Safe to leave loaded.
-- The token below is this installation's key for the bridge – don't share this file.
local PORT = ${port}
local TOKEN = "${token}"
local sock = nil
local regions = {}
local buffer = ""
local lastTry = -1000
local sent = 0

local function hex(s)
  return (s:gsub(".", function(c) return string.format("%02x", string.byte(c)) end))
end

local function connect()
  if sock then return end
  if emu == nil then return end
  local f = emu:currentFrame()
  if f - lastTry < 180 then return end
  lastTry = f
  local s, err = socket.connect("127.0.0.1", PORT)
  if not s then return end
  sock = s
  regions = {}
  local code = emu:getGameCode() or ""
  local title = emu:getGameTitle() or ""
  sock:send("HELLO " .. TOKEN .. " " .. emu:platform() .. " " .. code .. " " .. title .. "\\n")
  console:log("[SoulLink] connected to souldew")
end

local function readLines()
  if not sock then return end
  while sock:hasdata() do
    local chunk, err = sock:receive(4096)
    if not chunk then sock = nil return end
    buffer = buffer .. chunk
  end
  while true do
    local nl = buffer:find("\\n")
    if not nl then break end
    local line = buffer:sub(1, nl - 1)
    buffer = buffer:sub(nl + 1)
    local a, l = line:match("^R (%x+) (%d+)")
    if a then table.insert(regions, { tonumber(a, 16), tonumber(l) }) end
    if line == "RESET" then regions = {} end
  end
end

callbacks:add("frame", function()
  connect()
  if not sock then return end
  readLines()
  if not sock then return end
  local f = emu:currentFrame()
  if f % 20 ~= 0 or #regions == 0 then return end
  local out = {}
  for i, r in ipairs(regions) do
    table.insert(out, "D " .. i .. " " .. hex(emu:readRange(r[1], r[2])))
  end
  table.insert(out, "F " .. f)
  local ok, err = sock:send(table.concat(out, "\\n") .. "\\n")
  if not ok then sock = nil end
end)

callbacks:add("reset", function() if sock then sock:send("RESET\\n") end end)
console:log("[SoulLink] live bridge loaded – waiting for souldew")
`;
}

export class LiveBridge {
  constructor(emit) {
    this.emit = emit;
    this.port = null;
    this.clients = new Set();
    this.lastFrame = null;
  }

  luaScriptPath() {
    return join(DATA_DIR, DEV ? 'runs/live' : 'Live', 'soullink-mgba.lua');
  }

  /** Per-install token (kept next to the script, so a script loaded earlier keeps working after a restart). */
  loadToken() {
    const file = join(dirname(this.luaScriptPath()), 'bridge-token');
    try {
      const t = readFileSync(file, 'utf8').trim();
      if (isToken(t)) return t;
    } catch {
      // first start
    }
    const t = randomBytes(16).toString('hex');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, t, { mode: 0o600 });
    return t;
  }

  status() {
    return { port: this.port, clients: this.clients.size, script: this.luaScriptPath(), lastAt: this.lastFrame?.at || null, game: this.lastFrame?.game || null };
  }

  async start() {
    try {
      this.table = readJson('addresses.json');
    } catch {
      this.table = { games: [] };
    }
    for (const port of PORTS) {
      try {
        await new Promise((resolve, reject) => {
          const server = createServer((socket) => this.handle(socket));
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            this.server = server;
            resolve();
          });
        });
        this.port = port;
        break;
      } catch {
        // port taken – next
      }
    }
    if (!this.port) throw new Error('kein freier Port');
    mkdirSync(join(this.luaScriptPath(), '..'), { recursive: true });
    this.token = this.loadToken();
    writeFileSync(this.luaScriptPath(), luaScript(this.port, this.token));
  }

  handle(socket) {
    socket.setEncoding('utf8');
    let buffer = '';
    const state = { game: null, regions: [], data: [], authed: false };
    // Only counted as a client once the script has proven itself with the token.
    const auth = setTimeout(() => socket.destroy(), 10000);
    auth.unref?.();
    socket.on('data', (chunk) => {
      if (socket.destroyed) return;
      buffer += chunk;
      // Nothing legitimate sends a long first line; afterwards keep the buffer bounded.
      if (!state.authed && buffer.length > 1024 && buffer.indexOf('\n') < 0) return socket.destroy();
      if (buffer.length > 1 << 20) buffer = buffer.slice(-65536);
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!state.authed) {
          // The first line must be HELLO with this install's token. HTTP (a website POSTing to the port
          // cross-protocol) or anything else → drop the connection without reading further.
          const hello = !looksLikeHttp(line) && parseHello(line, this.token);
          if (!hello) {
            clearTimeout(auth);
            buffer = '';
            return socket.destroy();
          }
          clearTimeout(auth);
          state.authed = true;
          this.clients.add(socket);
        }
        this.line(socket, state, line);
      }
    });
    const bye = () => {
      clearTimeout(auth);
      if (!this.clients.delete(socket)) return;
      this.emit('live-status', this.status());
    };
    socket.on('close', bye);
    socket.on('error', bye);
  }

  line(socket, state, line) {
    if (line.startsWith('HELLO ')) {
      const hello = parseHello(line, this.token);
      if (!hello) return;
      const { platform, code, title } = hello;
      // mGBA platform ids: 0 = GBA, 1 = GB/GBC
      const plat = Number(platform) === 0 ? 'gba' : 'gb';
      state.game = { platform: plat, code, title };
      const entry = findEntry(this.table, state.game);
      state.game.entryId = entry?.id || null;
      state.regions = regionsFor(entry);
      if (state.regions.length) {
        socket.write(state.regions.map((r) => `R ${r.addr.toString(16)} ${r.len}`).join('\n') + '\n');
      }
      this.emit('live-status', { ...this.status(), game: state.game, supported: state.regions.length > 0 });
    } else if (line === 'RESET') {
      state.data = [];
    } else if (line.startsWith('D ')) {
      const [, idx, hex] = line.split(' ');
      state.data[Number(idx) - 1] = hex;
    } else if (line.startsWith('F ')) {
      this.lastFrame = {
        source: 'mgba',
        at: Date.now(),
        game: state.game,
        regions: state.regions.map((r, i) => ({ ...r, hex: state.data[i] || '' })),
      };
      this.emit('live', this.lastFrame);
    }
  }
}

export function readJson(name) {
  return JSON.parse(readFileSync(join(SHARED_DIR, 'data', name), 'utf8'));
}
