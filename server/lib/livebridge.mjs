// Live bridge for external emulators with a scripting API (mGBA ≥ 0.10).
// A small Lua script runs inside the emulator, connects to this TCP port and streams the
// memory regions we ask for (the player's party) a few times per second. Parsing happens in
// the UI with the same code used for the integrated emulator.
//
// Protocol (one line per message, "\n"-terminated, ASCII):
//   script → souldew  HELLO <token> <platform> <code> <title…>   first line; again after a reset / another game
//                     V <version>                                 script version (since version 2)
//                     D <i> <hex>                                 region i (1-based) of the current snapshot
//                     F <frame>                                   snapshot complete
//                     RESET                                       (version 1 only) the game was reset
//   souldew → script  OK                                          HELLO accepted – forget the regions asked so far
//                     R <addr hex> <len>                          a region to stream
//                     N <reason>                                  no live data for this game (nothing to stream)
//                     ERR <reason>                                HELLO rejected (outdated script / other install)
// Version 1 scripts (souldew ≤ 2.1.0) ignore OK / N / ERR and keep working.
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DATA_DIR, DEV, SHARED_DIR } from './paths.mjs';
import { writeFileAtomic } from './fsutil.mjs';
import { findEntry, regionsFor } from '../../shared/live/parse.mjs';

/**
 * Ports the bridge may listen on, preferred first. The script tries all of them, so a script loaded earlier still
 * finds souldew when the first port is taken (a second instance, or a range Windows reserves for Hyper-V / WSL).
 */
export const PORTS = [47123, 47124, 47125, 38123, 29123];
/** Version of the generated Lua script – a connected script reporting less is outdated (load it again). */
export const SCRIPT_VERSION = 2;

/** Secret shared by the server and the generated Lua script: proves a connection comes from that script. */
export const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);
/** A browser sending a request to the bridge port (cross-protocol) starts with an HTTP request line. */
export const looksLikeHttp = (line) => /^[A-Z]+ \S+ HTTP\//.test(line);

/**
 * The bare product code the address tables use ("BPEE"). mGBA 0.10 reports it with the system in front
 * ("AGB-BPEE", "CGB-AAUE", "DMG-????" for carts without a code), development builds (0.11) without; the script
 * sends "-" for none.
 */
export function normalizeGameCode(code) {
  const c = String(code || '').trim().toUpperCase().replace(/^(AGB|DMG|CGB)-/, '');
  return /^[A-Z0-9]{1,8}$/.test(c) ? c : '';
}

/** HELLO <token> <platform> <code> <title…> – returns the parsed parts or null if the token doesn't match. */
export function parseHello(line, token) {
  if (!isToken(token) || !line.startsWith('HELLO ')) return null;
  const [, got, platform, code, ...title] = line.split(' ');
  if (!isToken(got)) return null;
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(token))) return null;
  // header titles are padded with NULs on some carts
  return { platform, code: normalizeGameCode(code), title: title.join(' ').replace(/[\x00-\x1f\x7f]/g, '').trim() };
}

/** Why a HELLO line was rejected: 'old' (a script from before the token existed) or 'token' (another install's). */
export function helloRejection(line) {
  const got = line.split(' ')[1];
  return isToken(got) ? 'token' : 'old';
}

/** Lua long-string literal that can't be closed by the content (paths may contain "]]"). */
function luaLong(s) {
  let eq = '';
  while (s.includes(`]${eq}]`)) eq += '=';
  return `[${eq}[${s}]${eq}]`;
}

/**
 * The script for mGBA. Plain ASCII with "\n" line endings: mGBA's Lua reads it byte by byte on every system.
 * `port` is tried first, then the other PORTS.
 */
export function luaScript(port, token, { scriptPath = '' } = {}) {
  if (!isToken(token)) throw new Error('live bridge token missing');
  const ports = [port, ...PORTS.filter((p) => p !== port)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return `-- souldew live bridge for mGBA (script version ${SCRIPT_VERSION})
-- Load it in mGBA: Tools > Scripting..., then File > Load script... and choose this file.
-- mGBA 0.10 doesn't load scripts by itself: after restarting mGBA, load it again (the File menu lists it).
-- It streams your party to souldew on this computer and reconnects on its own. Safe to leave loaded.
-- Messages appear in mGBA's scripting window - include them when you report a problem.
-- The token below is this installation's key for the bridge - don't share this file.
local VERSION = ${SCRIPT_VERSION}
local PORTS = { ${ports.join(', ')} }
local TOKEN = "${token}"
local SCRIPT = ${luaLong(String(scriptPath).replace(/[\r\n]/g, ''))}

local AGAIN = (socket.ERRORS and socket.ERRORS.AGAIN) or "temporary failure"
local sock = nil
local portIndex = 1
local regions = {}
local inbuf = ""
local outbuf = ""
local tick = 0
local nextTry = 0
local delay = 120
local waitOk = nil
local helloPending = false
local lastProblem = nil
local errors = 0

local function say(msg) console:log("[souldew] " .. msg) end

-- A problem is logged once until a different one happens, so a waiting script doesn't flood the console.
local function problem(msg)
  if msg ~= lastProblem then
    lastProblem = msg
    console:warn("[souldew] " .. msg)
  end
end

local function hex(s)
  return (s:gsub(".", function(c) return string.format("%02x", string.byte(c)) end))
end

-- The next port to try. After a whole round without souldew, wait longer between attempts.
local function nextPort()
  portIndex = portIndex % #PORTS + 1
  if portIndex == 1 then delay = math.min(delay * 2, 900) end
end

-- mGBA 0.10 closes a socket a second time when Lua garbage-collects it - by then the number may belong to a newer
-- socket (or a file) of mGBA. Keeping closed sockets referenced keeps the collector away from them.
local closed = {}

local function drop(reason)
  if sock then
    pcall(function() sock:close() end)
    closed[#closed + 1] = sock
    -- closed before souldew accepted us: whatever listens there isn't this souldew - try the next port
    if waitOk then nextPort() end
  end
  sock = nil
  waitOk = nil
  regions = {}
  inbuf = ""
  outbuf = ""
  nextTry = tick + 30
  if reason then problem(reason) end
end

local function hello()
  local code = tostring(emu:getGameCode() or ""):gsub("%s", "")
  if code == "" then code = "-" end
  local title = tostring(emu:getGameTitle() or ""):gsub("%c", "")
  return "HELLO " .. TOKEN .. " " .. tostring(emu:platform()) .. " " .. code .. " " .. title .. "\\n" .. "V " .. VERSION .. "\\n"
end

-- Sends what fits. A partial send keeps the rest for the next frame; a new snapshot waits until the last one is out.
local function flush()
  local rounds = 0
  while sock and #outbuf > 0 and rounds < 16 do
    rounds = rounds + 1
    local n, err = sock:send(outbuf)
    if n == nil then
      if err ~= AGAIN then drop("connection to souldew lost (" .. tostring(err) .. ") - reconnecting") end
      return
    end
    if n <= 0 then return end
    outbuf = outbuf:sub(n + 1)
  end
end

-- One port per attempt: a refused connection can block mGBA for a moment (on Windows up to about two seconds).
local function connect()
  if tick < nextTry then return end
  local s, err = socket.connect("127.0.0.1", PORTS[portIndex])
  if not s then
    nextPort()
    nextTry = tick + delay
    if portIndex == 1 then problem("souldew not reachable (" .. tostring(err) .. ") - is souldew open? Retrying on its own.") end
    return
  end
  sock = s
  regions = {}
  inbuf = ""
  outbuf = hello()
  helloPending = false
  waitOk = tick + 300
  flush()
end

local function handle(line)
  local a, l = line:match("^R (%x+) (%d+)")
  if a then
    table.insert(regions, { tonumber(a, 16), tonumber(l) })
  elseif line == "OK" then
    if waitOk then
      lastProblem = nil
      delay = 120
      say("connected to souldew (port " .. PORTS[portIndex] .. ") - game " .. tostring(emu:getGameCode() or "?") .. " " .. tostring(emu:getGameTitle() or ""))
    end
    waitOk = nil
    regions = {}
  elseif line:sub(1, 2) == "N " then
    problem("souldew has no live data for this game (" .. line:sub(3) .. ") - saves still sync in souldew")
  elseif line:sub(1, 4) == "ERR " then
    drop("souldew on port " .. PORTS[portIndex] .. " rejected this script (" .. line:sub(5) .. "): it is outdated or from another souldew installation. Load the script souldew shows on its play page again.")
  end
end

local function lines()
  while sock do
    local nl = inbuf:find("\\n", 1, true)
    if not nl then break end
    local line = inbuf:sub(1, nl - 1):gsub("\\r$", "")
    inbuf = inbuf:sub(nl + 1)
    handle(line)
  end
end

local function receive()
  local rounds = 0
  while sock and rounds < 8 do
    rounds = rounds + 1
    local ready, err = sock:hasdata()
    if err then return drop("connection error (" .. tostring(err) .. ") - reconnecting") end
    if not ready then break end
    local chunk, rerr = sock:receive(4096)
    if not chunk then
      if rerr == AGAIN then break end
      lines() -- what souldew said before closing (ERR ...) explains why
      if not sock then return end
      if waitOk then return drop("port " .. PORTS[portIndex] .. " closed the connection - trying the next port") end
      return drop("souldew closed the connection - reconnecting")
    end
    inbuf = inbuf .. chunk
  end
  lines()
end

local function step()
  tick = tick + 1
  if emu == nil then return end
  if not sock then connect() end
  if not sock then return end
  receive()
  if not sock then return end
  if waitOk and tick > waitOk then
    return drop("no answer on port " .. PORTS[portIndex] .. " (another program?) - trying the next port")
  end
  if helloPending then
    outbuf = outbuf .. hello()
    helloPending = false
  end
  if tick % 20 == 0 and #regions > 0 and #outbuf == 0 then
    local out = {}
    for i, r in ipairs(regions) do
      out[#out + 1] = "D " .. i .. " " .. hex(emu:readRange(r[1], r[2]))
    end
    out[#out + 1] = "F " .. emu:currentFrame()
    outbuf = table.concat(out, "\\n") .. "\\n"
  end
  flush()
end

callbacks:add("frame", function()
  local ok, err = pcall(step)
  if not ok then
    errors = errors + 1
    if errors <= 5 then console:error("[souldew] script error: " .. tostring(err)) end
    drop(nil)
    nextTry = tick + delay
  end
end)

-- A reset or another game: tell souldew what runs now (it answers with that game's regions).
callbacks:add("reset", function()
  if sock then helloPending = true end
end)

say("live bridge (script version " .. VERSION .. ") loaded from " .. SCRIPT)
if emu == nil then say("start a game - the script connects to souldew as soon as it runs") end
`;
}

export class LiveBridge {
  constructor(emit) {
    this.emit = emit;
    this.port = null;
    this.error = null;
    this.clients = new Set();
    this.states = new Map(); // socket → what its script said (game, regions, version)
    this.lastFrame = null;
    this.current = null; // the connection that said HELLO last
    this.rejected = null; // { at, reason } of the last script turned away
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
    const c = this.current && this.clients.has(this.current.socket) ? this.current : null;
    return {
      port: this.port,
      error: this.error,
      clients: this.clients.size,
      script: this.luaScriptPath(),
      scriptVersion: SCRIPT_VERSION,
      lastAt: this.lastFrame?.at || null,
      game: this.lastFrame?.game || null,
      // what the connected script reported, before any data arrives
      connection: c ? { game: c.game, supported: c.regions.length > 0, version: c.version, since: c.since } : null,
      rejected: this.rejected,
    };
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
    if (!this.port) {
      this.error = 'noPort';
      throw new Error('kein freier Port');
    }
    mkdirSync(dirname(this.luaScriptPath()), { recursive: true });
    this.token = this.loadToken();
    writeFileAtomic(this.luaScriptPath(), luaScript(this.port, this.token, { scriptPath: this.luaScriptPath() }));
  }

  handle(socket) {
    socket.setEncoding('utf8');
    socket.setNoDelay?.(true);
    let buffer = '';
    const state = { socket, game: null, regions: [], data: [], authed: false, version: 1, since: Date.now() };
    // Only counted as a client once the script has proven itself with the token.
    const auth = setTimeout(() => socket.destroy(), 10000);
    auth.unref?.();
    socket.on('data', (chunk) => {
      if (socket.destroyed || state.closing) return;
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
            if (line.startsWith('HELLO ')) {
              // A script, but not this install's current one: say so (in mGBA's console and in the UI).
              this.rejected = { at: Date.now(), reason: helloRejection(line) };
              state.closing = true;
              socket.end(`ERR ${this.rejected.reason}\n`);
              setTimeout(() => socket.destroy(), 1000).unref?.();
              this.emit('live-status', this.status());
              return;
            }
            return socket.destroy();
          }
          clearTimeout(auth);
          state.authed = true;
          this.rejected = null;
          this.clients.add(socket);
          this.states.set(socket, state);
        }
        this.line(socket, state, line);
      }
    });
    const bye = () => {
      clearTimeout(auth);
      if (!this.clients.delete(socket)) return;
      this.states.delete(socket);
      // another mGBA window may still be connected
      if (this.current === state) this.current = [...this.states.values()].filter((s) => s.game).at(-1) || null;
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
      state.data = [];
      this.current = state;
      const reply = ['OK', ...state.regions.map((r) => `R ${r.addr.toString(16)} ${r.len}`)];
      if (!state.regions.length) reply.push(`N ${[plat.toUpperCase(), code || '-', title].filter(Boolean).join(' ')}`);
      socket.write(reply.join('\n') + '\n');
      this.emit('live-status', this.status());
    } else if (line.startsWith('V ')) {
      const v = Number.parseInt(line.slice(2), 10);
      if (Number.isInteger(v) && v > 0 && v < 1000) state.version = v;
      if (this.current === state) this.emit('live-status', this.status());
    } else if (line === 'RESET') {
      state.data = [];
    } else if (line.startsWith('D ')) {
      const [, idx, hex] = line.split(' ');
      const i = Number(idx) - 1;
      // only the regions asked for, and only well-formed hex of the asked length
      if (Number.isInteger(i) && i >= 0 && i < state.regions.length && hex?.length === state.regions[i].len * 2 && /^[0-9a-f]*$/i.test(hex)) {
        state.data[i] = hex;
      }
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
