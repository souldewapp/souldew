// souldew – embeddable local server. Serves the UI and does the heavy lifting:
// library scanning, patching, randomizing (bundled Java), save files, emulator management,
// and the live bridge for external emulators. Used by the Electron app and by `npm start`.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, createWriteStream, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { once } from 'node:events';
import { join, extname, normalize, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { WEB_DIR, SHARED_DIR, CACHE_DIR, DATA_DIR, CONFIG_PATH, NODE_MODULES, DEV, LIBRARY_DIR } from './lib/paths.mjs';
import { writeFileAtomic, httpError, safeFileName } from './lib/fsutil.mjs';
import { detectJava, uprStatus, installUpr, runBridge } from './lib/toolchain.mjs';
import { preparePatchedRom, KNOWN_PATCHES } from './lib/roms.mjs';
import { ROM_EXTENSIONS, PATCH_EXTENSIONS } from '../shared/romid.mjs';
import { ALL_SLOTS, slotsOf, runMode } from '../shared/slots.mjs';
import { scanLibrary, catalog, loadFile, importFiles, uploadTarget, resolveId, discoverRoms } from './lib/library.mjs';
import { saveCover, deleteCover, coverFile, customCovers, coverUrl, COVER_LIMIT } from './lib/covers.mjs';
import { buildRun, listRuns, readManifest, writeManifest, runDir, runPack, runSummary, trashRun, checkPack, stripLocalRules, isDiscordWebhook, mergeDocEntries, renamePlayers } from './lib/build.mjs';
import { SaveWatcher } from './lib/savewatch.mjs';
import { EMULATORS, detectEmulator, installEmulator, launchRom, revealInFileManager, emulatorRunning } from './lib/emulator.mjs';
import { LiveBridge } from './lib/livebridge.mjs';
import { moveToGraveyard, parseHgssSave } from '../shared/gen4save.mjs';
import { listPresets, savePreset, deletePreset } from './lib/presets.mjs';
import { pageHeaders } from './lib/csp.mjs';
import { hostAllowed, apiRequestError } from './lib/guard.mjs';
import { overlaySnapshot, TEST_SPECIES } from '../shared/overlay.mjs';
import { startPokelinkBridge, pokelinkPlayers, POKELINK_PORT } from './lib/pokelink.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.lua': 'text/plain; charset=utf-8',
};

const VENDOR = {
  '/vendor/htm-preact.mjs': join(NODE_MODULES, 'htm', 'preact', 'standalone.module.js'),
  '/vendor/mqtt.esm.js': join(NODE_MODULES, 'mqtt', 'dist', 'mqtt.esm.js'),
};

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
export function saveConfig(patch) {
  const c = { ...loadConfig(), ...patch };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileAtomic(CONFIG_PATH, JSON.stringify(c, null, 2));
  return c;
}

/** Save a webhook that came in the old way (inside the rules) – only if this run has none in the local config yet. */
function adoptLegacyWebhook(runId, hook) {
  const saved = loadConfig().discordWebhooks || {};
  if (typeof saved[runId] === 'string' || !isDiscordWebhook(hook)) return;
  saveConfig({ discordWebhooks: { ...saved, [runId]: hook } });
}

/**
 * This computer's Discord webhook for a run ('' = none). Older versions kept it in the run rules, which sync to
 * the partner and go into invite packs: such a webhook is moved into the local config once and removed from
 * the manifest's rules.
 */
function discordWebhookFor(runId) {
  const m = readManifest(runId);
  if (m?.rules && typeof m.rules === 'object' && 'discordWebhook' in m.rules) {
    adoptLegacyWebhook(runId, m.rules.discordWebhook);
    m.rules = stripLocalRules(m.rules);
    writeManifest(m);
  }
  const hook = loadConfig().discordWebhooks?.[runId];
  return typeof hook === 'string' && isDiscordWebhook(hook) ? hook : '';
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || body instanceof Uint8Array;
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** 413 before reading a body that announces itself as too big – the client gets the answer instead of a reset. */
function checkLength(req, limit) {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > limit) throw httpError(413, 'Request zu groß', 'requestTooLarge');
}

async function readRaw(req, limit = 512 * 1024 * 1024) {
  checkLength(req, limit);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request zu groß', 'requestTooLarge');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const UPLOAD_LIMIT = 600 * 1024 * 1024; // the biggest DS ROMs are 512 MB

/** Write a request body to `target` via a temp file (renamed at the end) – never more than `limit` bytes. */
export async function streamToFile(req, target, limit) {
  checkLength(req, limit);
  const tmp = `${target}.${process.pid}.upload`;
  let size = 0;
  const out = createWriteStream(tmp);
  let failed = null;
  out.on('error', (e) => (failed ||= e)); // disk full / no permission – without a listener the server would crash
  try {
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw httpError(413, 'Datei zu groß', 'fileTooLarge');
      if (failed) throw failed;
      if (!out.write(c)) await Promise.race([once(out, 'drain'), once(out, 'close')]);
    }
    if (!size) throw httpError(400, 'Leere Datei', 'emptyFile');
    out.end();
    if (!out.closed) await once(out, 'close');
    if (failed) throw failed;
    renameSync(tmp, target);
  } catch (e) {
    out.destroy();
    if (!out.closed) await once(out, 'close').catch(() => {}); // the file may only now be opened (and created)
    rmSync(tmp, { force: true });
    throw e;
  }
}

async function readBody(req) {
  const text = (await readRaw(req, 32 * 1024 * 1024)).toString('utf8');
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, 'Ungültiges JSON', 'badJson');
  }
  // Handlers destructure the body – null / arrays / primitives would throw a TypeError there.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'JSON-Objekt erwartet', 'jsonObject');
  return body;
}

function serveFile(res, path, extraHeaders = {}, head = false) {
  if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': statSync(path).size, ...extraHeaders });
  if (head) return res.end(); // EmulatorJS asks for the size first (HEAD) before it downloads the ROM
  // Without a listener a read error (file removed / unreadable) would crash the whole server.
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}

/** Only HeartGold/SoulSilver battery saves can be parsed (shared/gen4save.mjs). */
const isHgssRun = (m) => /^IP[KG]/i.test(m?.game?.code || '') || /heartgold|soulsilver/i.test(m?.game?.id || '');

function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  if (p !== base && !p.startsWith(base + '/') && !p.startsWith(base + '\\')) return null;
  return p;
}

const keyOf = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** Save files of solo games (not part of a run) live here, keyed by the library id. */
const SOLO_SAVES = join(DATA_DIR, DEV ? 'runs/.saves' : 'Saves');

// ---- save states of the built-in emulator -------------------------------------------
// states/<key>-<slot>.state, plus a small JPEG (.jpg) and an info file (.json: party, core …) per state.
// Slots 1–8 are the player's, 99 is "where you left off", 96–98 keep older copies of 99.
const STATE_DIR = join(SOLO_SAVES, 'states');
const AUTO_SLOT = 99;
const BACKUP_SLOTS = [98, 97, 96]; // newest first
const BACKUP_EVERY = 10 * 60 * 1000;
const STATE_EXT = ['state', 'jpg', 'json'];
const statePath = (key, slot, ext) => join(STATE_DIR, `${key}-${slot}.${ext}`);
const mtimeOf = (p) => {
  try {
    return Math.round(statSync(p).mtimeMs);
  } catch {
    return 0;
  }
};

/** Before "where you left off" is replaced it becomes a backup – if the newest backup is ≥ 10 min older. */
function rotateAutoState(key) {
  const auto = mtimeOf(statePath(key, AUTO_SLOT, 'state'));
  if (!auto || auto - mtimeOf(statePath(key, BACKUP_SLOTS[0], 'state')) < BACKUP_EVERY) return;
  const move = (from, to) => {
    for (const ext of STATE_EXT) {
      if (existsSync(statePath(key, from, ext))) renameSync(statePath(key, from, ext), statePath(key, to, ext)); // keeps the mtime
      else rmSync(statePath(key, to, ext), { force: true });
    }
  };
  for (let i = BACKUP_SLOTS.length - 1; i > 0; i--) move(BACKUP_SLOTS[i - 1], BACKUP_SLOTS[i]);
  move(AUTO_SLOT, BACKUP_SLOTS[0]);
}

/**
 *   GET    /api/saves/states?id=                 list: [{ slot, at, thumb, info }]
 *   GET    /api/saves/state?id=&slot=            state bytes      PUT: write   DELETE: remove (with picture + info)
 *   GET    /api/saves/state/thumb?id=&slot=      JPEG thumbnail
 *   PUT    /api/saves/state/info?id=&slot=       { thumb: base64 JPEG, info: {…} } for an existing state
 * Files are named by a hash of the id and an integer slot, so no request can reach outside STATE_DIR.
 */
async function handleStates(req, res, path, url) {
  const id = url.searchParams.get('id');
  if (!id) return send(res, 400, { error: 'id fehlt', code: 'idMissing' });
  const key = keyOf(id);
  if (path === '/api/saves/states' && req.method === 'GET') {
    let names = [];
    try {
      names = readdirSync(STATE_DIR);
    } catch {
      // no states yet
    }
    const list = [];
    for (const name of names) {
      const m = name.match(/^([0-9a-f]{16})-(\d{1,2})\.state$/);
      if (!m || m[1] !== key) continue;
      const slot = Number(m[2]);
      let info = null;
      try {
        info = JSON.parse(readFileSync(statePath(key, slot, 'json'), 'utf8'));
      } catch {
        // older state without info
      }
      list.push({ slot, at: mtimeOf(statePath(key, slot, 'state')), thumb: existsSync(statePath(key, slot, 'jpg')), info });
    }
    return send(res, 200, list.sort((a, b) => a.slot - b.slot));
  }
  const slot = Number(url.searchParams.get('slot') ?? 1);
  if (!Number.isInteger(slot) || slot < 1 || slot > 99) return send(res, 400, { error: 'Ungültiger Slot', code: 'badSlot' });
  const file = statePath(key, slot, 'state');
  if (path === '/api/saves/state/thumb' && req.method === 'GET') {
    const jpg = statePath(key, slot, 'jpg');
    return existsSync(jpg) ? send(res, 200, readFileSync(jpg), { 'Content-Type': 'image/jpeg' }) : send(res, 404, { error: 'no thumbnail' });
  }
  if (path === '/api/saves/state/info' && req.method === 'PUT') {
    if (!existsSync(file)) return send(res, 404, { error: 'no state' });
    let body = null;
    try {
      body = JSON.parse((await readRaw(req, 1024 * 1024)).toString('utf8'));
    } catch (e) {
      if (e.status) throw e;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'JSON-Objekt erwartet', code: 'jsonObject' });
    if (body.thumb != null) {
      const jpg = Buffer.from(String(body.thumb), 'base64');
      if (jpg.length < 4 || jpg.length > 256 * 1024 || jpg[0] !== 0xff || jpg[1] !== 0xd8) return send(res, 400, { error: 'Kein JPEG' });
      writeFileAtomic(statePath(key, slot, 'jpg'), jpg);
    }
    if (body.info && typeof body.info === 'object' && !Array.isArray(body.info)) {
      const text = JSON.stringify(body.info);
      if (text.length > 16 * 1024) return send(res, 413, { error: 'Info zu groß' });
      writeFileAtomic(statePath(key, slot, 'json'), text);
    }
    return send(res, 200, { ok: true });
  }
  if (path !== '/api/saves/state') return false;
  if (req.method === 'GET') return existsSync(file) ? send(res, 200, readFileSync(file)) : send(res, 404, { error: 'no state' });
  if (req.method === 'PUT') {
    const bytes = await readRaw(req, 64 * 1024 * 1024);
    if (!bytes.length) return send(res, 400, { error: 'Leerer Spielstand – nicht gespeichert', code: 'emptySave' });
    mkdirSync(STATE_DIR, { recursive: true });
    if (slot === AUTO_SLOT) rotateAutoState(key);
    writeFileAtomic(file, bytes);
    // picture and info belonged to the state that was just replaced
    rmSync(statePath(key, slot, 'jpg'), { force: true });
    rmSync(statePath(key, slot, 'json'), { force: true });
    return send(res, 200, { ok: true, at: mtimeOf(file) });
  }
  if (req.method === 'DELETE') {
    for (const ext of STATE_EXT) rmSync(statePath(key, slot, ext), { force: true });
    return send(res, 200, { ok: true });
  }
  return false;
}

// ---- file export ("save as …") ---------------------------------------------------
// Only hands out copies of files that already exist locally: the user's own dumps and patches
// from the library, ROMs patched/randomized from them, and save files. Nothing is fetched remotely.

/** RFC 6266 Content-Disposition: ASCII fallback + the exact UTF-8 name (RFC 5987 encoded). */
function attachmentHeader(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'download';
  const ascii = clean.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');
  const star = encodeURIComponent(clean).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** Send a file (absolute path) or an in-memory buffer as a download. HEAD only sends the headers. */
function sendDownload(req, res, name, source) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': attachmentHeader(name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (typeof source === 'string') {
    let st = null;
    try {
      st = statSync(source);
    } catch {
      // missing
    }
    if (!st?.isFile()) return send(res, 404, { error: 'Datei nicht gefunden', code: 'fileNotFound' });
    res.writeHead(200, { ...headers, 'Content-Length': st.size, 'Last-Modified': st.mtime.toUTCString() });
    if (req.method === 'HEAD') return res.end();
    createReadStream(source).on('error', () => res.destroy()).pipe(res);
    return;
  }
  const buf = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  res.writeHead(200, { ...headers, 'Content-Length': buf.length });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

/**
 * The library listing plus the player's own cover pictures: `customCovers` { 'game:<id>' | 'hack:<id>' | 'rom:<CRC>': url }
 * for every catalog entry and unknown ROM that has one, and on each ROM its `coverId` and `customCover` (or null).
 */
function withCustomCovers(lib) {
  const cat = catalog();
  const idOf = (r) => (r.gameId ? `game:${r.gameId}` : r.crc ? `rom:${r.crc}` : null);
  const covers = customCovers([
    ...(cat.games || []).map((g) => `game:${g.id}`), ...(cat.hacks || []).map((h) => `hack:${h.id}`),
    ...lib.roms.map(idOf).filter(Boolean),
  ]);
  for (const r of lib.roms) {
    r.coverId = idOf(r);
    r.customCover = covers[r.coverId] || null;
  }
  return { ...lib, customCovers: covers };
}

/** File name part of a library id ("dir/file.nds" or "dir/archive.zip::inner/file.nds"). */
const idFileName = (id) => String(id || '').split('::').pop().split(/[\\/]/).pop();
const idExt = (id) => extname(idFileName(id)).slice(1).toLowerCase();

/** Display name of a patched game: known patch > catalog hack > patch file name. */
function patchedTitle(patchId, config) {
  try {
    const p = scanLibrary(config).patches.find((x) => x.id === patchId);
    if (p?.sha1 && KNOWN_PATCHES[p.sha1]) return KNOWN_PATCHES[p.sha1].name;
    const hack = p?.hackId && (catalog().hacks || []).find((h) => h.id === p.hackId);
    if (hack?.name) return hack.name;
  } catch {
    // fall back to the file name
  }
  return idFileName(patchId).replace(/\.\w+$/, '').replace(/[\s_-]*patch$/i, '').trim() || 'Patched';
}

/**
 * GET/HEAD export routes. Returns false when the path isn't one of them.
 *   /api/library/download?id=<romId>              raw ROM (extracted from its zip if needed)
 *   /api/library/download?romId=<id>&patchId=<id> patched ROM
 *   /api/library/download?patchId=<id>            the patch file itself
 *   /api/runs/:id/download?what=rom|save|spoiler|pack&slot=p1..p4
 *   /api/saves/solo/download?id=<solo id>         save file of a solo game
 */
function handleExport(req, res, path, url) {
  const q = (k) => url.searchParams.get(k) || '';
  if (path === '/api/library/download') {
    const config = loadConfig();
    const romId = q('romId') || q('id');
    const patchId = q('patchId');
    if (romId && !ROM_EXTENSIONS.includes(idExt(romId))) return send(res, 400, { error: 'Keine ROM-Datei', code: 'notRom' });
    if (patchId && !PATCH_EXTENSIONS.includes(idExt(patchId))) return send(res, 400, { error: 'Keine Patch-Datei', code: 'notPatch' });
    if (romId && patchId) {
      const r = preparePatchedRom(romId, patchId, () => {}, config);
      return sendDownload(req, res, `${patchedTitle(patchId, config)}${extname(r.path)}`, r.path);
    }
    const id = romId || patchId;
    if (!id) return send(res, 400, { error: 'id, romId oder patchId fehlt', code: 'idMissing' });
    const { abs, entry } = resolveId(id, config);
    if (!entry) return sendDownload(req, res, basename(abs), abs);
    return sendDownload(req, res, idFileName(id), loadFile(id, config));
  }
  if (path === '/api/saves/solo/download') {
    const id = q('id');
    if (!id) return send(res, 400, { error: 'id fehlt', code: 'idMissing' });
    const file = join(SOLO_SAVES, `${keyOf(id)}.sav`);
    if (!existsSync(file)) return send(res, 404, { error: 'Noch kein Spielstand', code: 'noSaveYet' });
    const [romId, patchId] = id.split('|');
    const base = patchId ? patchedTitle(patchId, loadConfig()) : idFileName(romId).replace(/\.\w+$/, '');
    return sendDownload(req, res, `${base || 'Spielstand'}.sav`, file);
  }
  const run = path.match(/^\/api\/runs\/([a-f0-9]{8})\/download$/);
  if (run) {
    const manifest = readManifest(run[1]);
    if (!manifest) return send(res, 404, { error: 'Run nicht gefunden', code: 'runNotFound' });
    const what = q('what') || 'rom';
    const slot = q('slot') || 'p1';
    if (!ALL_SLOTS.includes(slot)) return send(res, 400, { error: 'slot muss p1 bis p4 sein', code: 'badPlayer' });
    const out = manifest.outputs?.[slot];
    let name = null;
    let downloadName = null;
    if (what === 'rom') name = out?.rom;
    else if (what === 'spoiler') name = out?.log;
    else if (what === 'save') name = out?.rom ? basename(defaultSavePath(manifest, slot)) : null;
    else if (what === 'pack') {
      name = 'run-pack.soullink.json';
      downloadName = `${manifest.name || 'SoulLink'}.soullink.json`;
    } else return send(res, 400, { error: 'what muss rom, save, spoiler oder pack sein' });
    if (!name) return send(res, 404, { error: 'Datei nicht vorhanden' });
    const file = safeJoin(runDir(run[1]), name);
    if (!file) return send(res, 400, { error: 'bad name' });
    return sendDownload(req, res, downloadName || name, file);
  }
  return false;
}

/**
 * Start the server.
 * @param {{port?: number, host?: string, onReady?: (url:string)=>void}} opts
 */
export function startServer({ port = 7373, host = '127.0.0.1', background = true } = {}) {
  const GEN4 = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'gen4.json'), 'utf8'));
  const sseClients = new Set();
  const emit = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  const watcher = new SaveWatcher(GEN4, emit);
  const live = new LiveBridge(emit);
  // Stream overlays (web/overlay.html in OBS): per run, the open event streams with their language. A doc
  // upload or a renamed run pushes a fresh snapshot (shared/overlay.mjs) – only what an overlay may show.
  const overlayClients = new Map(); // runId → Map(res → { lang, w, preview, alerts })
  let overlayNames = null;
  const overlayLookups = (lang) => {
    if (!overlayNames) {
      const read = (f) => {
        try {
          return JSON.parse(readFileSync(join(SHARED_DIR, 'data', f), 'utf8'));
        } catch {
          return null;
        }
      };
      overlayNames = { names: read('pokeapi.json')?.names || {}, tables: { gen4: GEN4, loc2: read('locations_gen2_crystal.json'), loc3: read('locations_gen3.json') } };
    }
    const list = overlayNames.names[lang] || overlayNames.names.en || [];
    return { lang, tables: overlayNames.tables, speciesName: (id) => list[id] || overlayNames.names.en?.[id] || `#${id}` };
  };
  // Pokélink themes (server/lib/pokelink.mjs): a socket.io bridge on its own port, switched on in the Stream page.
  // It follows the run chosen there, else the run played last (its doc changed last).
  const pokelink = { bridge: null, error: null, run: null, starting: null };
  let pokelinkLookup = null;
  const pokelinkLookups = () => {
    if (!pokelinkLookup) {
      const read = (f) => {
        try {
          return JSON.parse(readFileSync(join(SHARED_DIR, 'data', f), 'utf8'));
        } catch {
          return {};
        }
      };
      const api = read('pokeapi.json');
      pokelinkLookup = { names: api.names?.en || [], types: api.types || [], typesGen: api.typesGen || {}, typeNames: api.typeNames?.en || {},
        moveNames: api.moves?.en || [], moveTypes: read('moves.json').type || [], tables: overlayLookups('en').tables };
    }
    return pokelinkLookup;
  };
  const pokelinkRun = () => {
    const want = loadConfig().pokelink?.run;
    if (want && readManifest(want)) return want;
    let best = null;
    for (const m of listRuns()) {
      let t = 0;
      try {
        t = statSync(join(runDir(m.id), 'doc.json')).mtimeMs;
      } catch {}
      if (!best || t > best.t) best = { id: m.id, t };
    }
    return best?.id || null;
  };
  const pokelinkList = () => {
    const id = (pokelink.run = pokelinkRun());
    const manifest = id && readManifest(id);
    return manifest ? pokelinkPlayers(manifest, readDoc(id) || {}, pokelinkLookups()) : [];
  };
  const pokelinkApply = async () => {
    const want = loadConfig().pokelink || {};
    const port = Number.isInteger(want.port) && want.port > 0 && want.port < 65536 ? want.port : POKELINK_PORT;
    if (pokelink.bridge && (!want.enabled || pokelink.bridge.port !== port)) {
      await pokelink.bridge.close();
      pokelink.bridge = null;
    }
    pokelink.error = null;
    if (want.enabled && !pokelink.bridge) {
      try {
        pokelink.bridge = await startPokelinkBridge({ port, players: pokelinkList });
      } catch (e) {
        pokelink.error = e.code === 'EADDRINUSE' ? 'portInUse' : 'failed';
      }
    }
  };
  const pokelinkState = () => {
    const c = loadConfig().pokelink || {};
    return { enabled: !!c.enabled, port: pokelink.bridge?.port || c.port || POKELINK_PORT, running: !!pokelink.bridge, error: pokelink.error,
      run: pokelink.bridge ? pokelink.run : c.run || null, clients: pokelink.bridge?.clients() || 0 };
  };
  const overlayLang = (v) => (['en', 'de', 'fr', 'es', 'it'].includes(String(v || '').slice(0, 2)) ? String(v).slice(0, 2) : 'en');
  const overlayData = (runId, lang) => {
    const manifest = readManifest(runId);
    if (!manifest) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    return overlaySnapshot(manifest, readDoc(runId) || {}, overlayLookups(lang));
  };
  const overlayTimers = new Map();
  const pushOverlay = (runId) => {
    if (pokelink.bridge && !overlayTimers.has(`pl:${runId}`)) {
      overlayTimers.set(`pl:${runId}`, setTimeout(() => {
        overlayTimers.delete(`pl:${runId}`);
        pokelink.bridge?.push();
      }, 150));
    }
    if (!overlayClients.get(runId)?.size || overlayTimers.has(runId)) return;
    // a burst of uploads (every 600 ms while playing) → one snapshot shortly after
    overlayTimers.set(runId, setTimeout(() => {
      overlayTimers.delete(runId);
      const byLang = new Map();
      for (const [res, { lang }] of overlayClients.get(runId) || []) {
        try {
          if (!byLang.has(lang)) byLang.set(lang, `event: snapshot\ndata: ${JSON.stringify(overlayData(runId, lang))}\n\n`);
          res.write(byLang.get(lang));
        } catch {
          res.write('event: gone\ndata: {}\n\n');
        }
      }
    }, 150));
  };
  setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
    for (const set of overlayClients.values()) for (const res of set.keys()) res.write(': ping\n\n');
  }, 20000).unref();

  for (const [runId, path] of Object.entries(loadConfig().watches || {})) {
    try {
      if (readManifest(runId)) watcher.watch(runId, path);
    } catch {
      // stale entry
    }
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---- status & config ------------------------------------------------------------
  route('GET', /^\/api\/status$/, () => {
    const config = loadConfig();
    return {
      platform: process.platform,
      arch: process.arch,
      app: !DEV,
      java: detectJava(),
      upr: uprStatus(),
      emulators: Object.fromEntries(Object.entries(EMULATORS).map(([id, e]) => [id, { name: e.name, systems: e.systems, live: e.live, ...detectEmulator(id, config.emulatorPaths?.[id]) }])),
      runs: listRuns().map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt, mode: runMode(m), players: m.players, outputs: m.outputs, imported: !!m.imported, game: m.game || null, randomized: m.randomizer?.enabled !== false, summary: runSummary(m.id, m) })),
      live: live.status(),
      config: {
        lang: config.lang || null,
        onboarded: !!config.onboarded,
        playerName: config.playerName || '',
        libraryFolders: config.libraryFolders || [],
        emulatorFor: config.emulatorFor || {},
        lastRun: config.lastRun || null,
        bootAnimation: config.bootAnimation !== false,
        sounds: config.sounds !== false,
        shareScreen: config.shareScreen !== false,
        controls: config.controls || null,
        theme: config.theme || 'classic',
        speedGuard: config.speedGuard === true,
        pads: config.pads || null,
      },
    };
  });

  route('POST', /^\/api\/config$/, async (req) => {
    const body = await readBody(req);
    const allowed = {};
    // No path-like keys here: emulatorPaths decides which program /launch runs, libraryFolders which folders are
    // scanned (set via /api/library/folders). Neither may be writable by a plain config POST.
    for (const k of ['lang', 'onboarded', 'playerName', 'emulatorFor', 'lastRun', 'bootAnimation', 'sounds', 'shareScreen', 'shortcuts', 'controls', 'theme', 'pads', 'speedGuard']) {
      if (k in body) allowed[k] = body[k];
    }
    // shape checks for the newer keys – the page validates too, but the config file shouldn't hold junk
    if ('theme' in allowed && !['classic', 'contrast', 'deutan', 'tritan'].includes(allowed.theme)) delete allowed.theme;
    if ('speedGuard' in allowed) allowed.speedGuard = allowed.speedGuard === true;
    if ('pads' in allowed) {
      const p = allowed.pads;
      const ok = p === null || (typeof p === 'object' && !Array.isArray(p) && (!p.preset || ['nintendo', 'xbox'].includes(p.preset))
        && (!p.map || (typeof p.map === 'object' && Object.entries(p.map).length <= 16 && Object.values(p.map).every((v) => typeof v === 'string' && /^[A-Z_0-9]{1,24}$/.test(v)))));
      if (!ok) delete allowed.pads;
      else if (p) allowed.pads = { ...(p.preset ? { preset: p.preset } : {}), ...(p.map ? { map: Object.fromEntries(Object.entries(p.map).filter(([k]) => /^[a-z]{1,8}$/.test(k))) } : {}) };
    }
    return saveConfig(allowed);
  });

  // ---- randomizer presets (user-saved, built-ins live in shared/randomizer-options.mjs) ----
  route('GET', /^\/api\/randomizer\/presets$/, () => ({ presets: listPresets(loadConfig()) }));
  route('POST', /^\/api\/randomizer\/presets$/, async (req) => {
    const body = await readBody(req);
    const { preset, presets } = savePreset(listPresets(loadConfig()), body);
    saveConfig({ randomizerPresets: presets });
    return { preset, presets };
  });
  route('DELETE', /^\/api\/randomizer\/presets\/(u-[a-f0-9]{8})$/, (req, m) => {
    const presets = deletePreset(listPresets(loadConfig()), m[1]);
    saveConfig({ randomizerPresets: presets });
    return { presets };
  });

  route('POST', /^\/api\/java\/recheck$/, () => detectJava(true));
  route('POST', /^\/api\/upr\/install$/, async () => installUpr());

  // ---- library & catalog ----------------------------------------------------------
  route('GET', /^\/api\/catalog$/, () => catalog());
  route('GET', /^\/api\/library$/, () => withCustomCovers(scanLibrary(loadConfig())));
  route('POST', /^\/api\/library\/import$/, async (req) => {
    const { paths } = await readBody(req);
    return { added: importFiles(paths || []) };
  });
  // Search this Mac / PC for ROMs (the usual folders) – the import below then copies the ones the player picked.
  route('POST', /^\/api\/library\/discover$/, () => discoverRoms({ known: scanLibrary(loadConfig()).roms }));
  route('POST', /^\/api\/library\/upload$/, async (req, m, url) => {
    // name checked first (a wrong file type is refused before its bytes are read), then streamed to disk:
    // a 512 MB DS ROM must not be held in memory twice
    const target = uploadTarget(url.searchParams.get('name') || 'rom.bin');
    await streamToFile(req, target, UPLOAD_LIMIT);
    return { added: [target] };
  });
  // The player's own picture for an entry without a cover (id: game:<id> | hack:<id> | rom:<CRC32>, covers.mjs).
  // GET is served below, next to the other file responses.
  route('PUT', /^\/api\/library\/cover$/, async (req, m, url) => {
    const id = url.searchParams.get('id');
    let bytes;
    try {
      bytes = await readRaw(req, COVER_LIMIT);
    } catch (e) {
      throw e.status === 413 ? httpError(413, 'Bild zu groß (höchstens 4 MB)', 'coverTooLarge') : e;
    }
    const f = saveCover(id, bytes);
    return { id, url: coverUrl(id, f.mtimeMs) };
  });
  route('DELETE', /^\/api\/library\/cover$/, (req, m, url) => ({ removed: deleteCover(url.searchParams.get('id')) }));
  route('POST', /^\/api\/library\/folders$/, async (req) => {
    const { add, remove } = await readBody(req);
    const cfg = loadConfig();
    let folders = new Set(cfg.libraryFolders || []);
    if (add) folders.add(resolve(String(add)));
    if (remove) folders.delete(resolve(String(remove)));
    folders = [...folders].filter((f) => existsSync(f));
    saveConfig({ libraryFolders: folders });
    return { libraryFolders: folders };
  });
  route('POST', /^\/api\/library\/reveal$/, async (req) => {
    const { id } = await readBody(req);
    // (no library scan needed here – a full scan can take seconds on big folders)
    mkdirSync(LIBRARY_DIR, { recursive: true });
    const target = id ? resolveId(id, loadConfig()).abs : LIBRARY_DIR;
    revealInFileManager(target);
    return { ok: true };
  });

  // ---- saves for the integrated emulator ------------------------------------------
  route('PUT', /^\/api\/saves\/solo$/, async (req, m, url) => {
    if (!url.searchParams.get('id')) throw httpError(400, 'id fehlt', 'idMissing'); // would all land in one shared "null" save
    mkdirSync(SOLO_SAVES, { recursive: true });
    const bytes = await readRaw(req, 4 * 1024 * 1024);
    if (!bytes.length) throw httpError(400, 'Leerer Spielstand – nicht gespeichert', 'emptySave');
    writeFileAtomic(join(SOLO_SAVES, `${keyOf(url.searchParams.get('id'))}.sav`), bytes);
    return { ok: true, size: bytes.length };
  });

  // ---- ROM inspection & run building ----------------------------------------------
  route('POST', /^\/api\/rom\/inspect$/, async (req) => {
    const { romId, patchId } = await readBody(req);
    const log = [];
    const patched = preparePatchedRom(romId, patchId || null, (l) => log.push(l), loadConfig());
    let info = null;
    try {
      info = (await runBridge(['info', patched.path])).json;
    } catch (e) {
      // missingTool: the game may be fine – Java or the randomizer is what's missing (the UI says so instead of
      // "this game can't be randomized")
      const missingTool = !detectJava().ok ? 'java' : !uprStatus().installed ? 'upr' : null;
      info = { unsupported: true, error: e.message, missingTool };
    }
    return { patched: { crc: patched.crc, baseCrc: patched.baseCrc, size: patched.size, header: patched.header, patchName: patched.patchName, system: patched.system }, info, log };
  });

  const building = new Set(); // run ids with a build in progress
  route('POST', /^\/api\/runs\/build$/, async (req) => {
    const body = await readBody(req);
    const log = [];
    let identity = null;
    if (body.runId) {
      const m = readManifest(body.runId);
      if (!m) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
      identity = { id: m.id, room: m.room, secret: m.secret };
      // Two builds of the same run would write the same ROM files at the same time.
      if (building.has(m.id)) throw httpError(409, 'Dieser Run wird gerade gebaut', 'runBuilding');
      building.add(m.id);
    }
    try {
      if (body.runId) discordWebhookFor(body.runId); // moves a legacy webhook out of the rules before they are rewritten
      const manifest = await buildRun({ ...body, identity, config: loadConfig() }, (l) => log.push(l));
      adoptLegacyWebhook(manifest.id, body.rules?.discordWebhook); // older clients still send it inside the rules
      saveConfig({ lastRun: manifest.id });
      return { manifest, log };
    } finally {
      if (identity) building.delete(identity.id);
    }
  });

  route('POST', /^\/api\/runs\/import$/, async (req) => {
    const { pack } = await readBody(req);
    // The pack comes from another computer (file, clipboard, code invite): bad input is the sender's, a 400 with a code.
    if (!pack || typeof pack !== 'object' || pack.format !== 'soullink-studio/run-pack@1') throw httpError(400, 'Kein gültiges Run-Paket', 'packInvalid');
    if (typeof pack.id !== 'string' || !/^[a-f0-9]{8}$/.test(pack.id)) throw httpError(400, 'Run-Paket ist beschädigt (id)', 'packBroken', { what: 'id' });
    const checked = checkPack(pack);
    const existing = readManifest(pack.id);
    // A pack must never replace a run this computer created itself (its room/secret, rules and builds).
    if (existing && !existing.imported) throw httpError(409, 'Dieser Run wurde auf diesem Computer erstellt und kann nicht durch ein Run-Paket ersetzt werden', 'runIsLocal');
    const manifest = {
      ...(existing || {}),
      id: pack.id, ...checked, updatedAt: new Date().toISOString(),
      base: pack.base, patch: pack.patch, randomizer: pack.randomizer, rules: stripLocalRules(pack.rules ?? null), game: pack.game || null,
      expectedOutputs: pack.outputs, outputs: existing?.outputs || {}, imported: true,
    };
    writeManifest(manifest);
    saveConfig({ lastRun: manifest.id });
    return manifest;
  });

  route('GET', /^\/api\/runs\/([a-f0-9]{8})$/, (req, m) => {
    if (readManifest(m[1])) discordWebhookFor(m[1]); // one-time migration out of the shared rules
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    const defaultSaves = Object.fromEntries(slotsOf(manifest).map((s) => [s, defaultSavePath(manifest, s)]));
    return { ...manifest, pack: runPack(manifest), watch: watcher.status(m[1]), defaultSaves };
  });

  // Delete = move the run folder to runs/.trash (recoverable by hand), forget watches / lastRun.
  route('DELETE', /^\/api\/runs\/([a-f0-9]{8})$/, (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    if (building.has(m[1])) throw httpError(409, 'Dieser Run wird gerade gebaut', 'runBuilding');
    watcher.unwatch(m[1]);
    const trash = trashRun(m[1]);
    const cfg = loadConfig();
    const watches = { ...(cfg.watches || {}) };
    delete watches[m[1]];
    saveConfig({ watches, ...(cfg.lastRun === m[1] ? { lastRun: null } : {}) });
    return { ok: true, trash };
  });

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/meta$/, async (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    const body = await readBody(req);
    if (body.rules && typeof body.rules === 'object' && !Array.isArray(body.rules)) {
      discordWebhookFor(m[1]); // migrate a legacy webhook first, so it isn't lost
      adoptLegacyWebhook(m[1], body.rules.discordWebhook);
      manifest.rules = stripLocalRules(body.rules);
    }
    if (body.name) manifest.name = String(body.name).slice(0, 80);
    if (body.players) manifest.players = renamePlayers(manifest, body.players);
    writeManifest(manifest);
    pushOverlay(m[1]);
    return manifest;
  });

  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/data\/(p[1-4])$/, (req, m) => {
    const p = join(runDir(m[1]), `${m[2]}.data.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  });
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/log\/(p[1-4])$/, (req, m) => {
    const name = readManifest(m[1])?.outputs?.[m[2]]?.log;
    const p = name ? safeJoin(runDir(m[1]), name) : null;
    return p && existsSync(p) ? readFileSync(p, 'utf8') : '';
  });
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/doc$/, (req, m) => readDoc(m[1]));
  // what a stream overlay shows of the run (no keys, paths or spoilers) – the event stream below pushes it live
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/overlay$/, (req, m, url) => overlayData(m[1], overlayLang(url.searchParams.get('lang'))));
  // "Send a test alert" in the app's Stream page: every open overlay of the run shows a sample (in OBS too)
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/overlay\/test$/, async (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    const body = await readBody(req);
    const type = ['death', 'catch', 'badge', 'evolve', 'level', 'run'].includes(body?.type) ? body.type : 'catch';
    // the sample may show Pokémon the run hasn't met: their names come along, in each overlay's language
    let n = 0;
    for (const [res, c] of overlayClients.get(m[1]) || []) {
      const { speciesName } = overlayLookups(c.lang);
      const species = Object.fromEntries(TEST_SPECIES.map((id) => [id, speciesName(id)]));
      res.write(`event: test\ndata: ${JSON.stringify({ type, species, at: Date.now() })}\n\n`);
      if (!c.preview && c.alerts) n++;
    }
    return { ok: true, overlays: n };
  });
  // the Pokélink bridge: on/off, port and run (the Stream page's "Pokélink themes" card)
  route('GET', /^\/api\/pokelink$/, () => pokelinkState());
  route('POST', /^\/api\/pokelink$/, async (req) => {
    const body = await readBody(req);
    const c = loadConfig().pokelink || {};
    const port = Number(body.port);
    saveConfig({ pokelink: {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : !!c.enabled,
      port: Number.isInteger(port) && port >= 1024 && port < 65536 ? port : c.port || POKELINK_PORT,
      run: body.run === null ? null : /^[a-f0-9]{8}$/.test(String(body.run || '')) ? body.run : c.run || null,
    } });
    await pokelinkApply();
    pokelink.bridge?.push();
    return pokelinkState();
  });
  // which overlays are open outside the app's own previews (OBS, a browser) – the Stream page shows "live in OBS"
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/overlay\/clients$/, (req, m) => {
    const widgets = {};
    for (const c of overlayClients.get(m[1])?.values() || []) if (!c.preview) widgets[c.w] = (widgets[c.w] || 0) + 1;
    return { widgets, total: Object.values(widgets).reduce((a, b) => a + b, 0) };
  });
  route('PUT', /^\/api\/runs\/([a-f0-9]{8})\/doc$/, async (req, m) => {
    const body = await readBody(req);
    // never resurrect a deleted run from a stale tab
    if (!existsSync(runDir(m[1]))) throw httpError(404, 'Run not found', 'runNotFound');
    const p = join(runDir(m[1]), 'doc.json');
    // Merge instead of overwrite (sync read + write, so no other request runs in between): an upload that
    // overtook a newer one, or a second tab, can't roll entries back.
    writeFileAtomic(p, JSON.stringify(mergeDocEntries(readDoc(m[1]), body)));
    rmSync(p + '.tmp', { force: true }); // left behind by older versions
    pushOverlay(m[1]);
    return { ok: true };
  });

  // Run save file: written by the integrated emulator, read back when playing again.
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/save\/(p[1-4])$/, (req, m) => {
    const p = defaultSavePath(readManifest(m[1]), m[2]);
    if (!p || !existsSync(p)) throw httpError(404, 'Noch kein Spielstand', 'noSaveYet');
    return readFileSync(p);
  });
  route('PUT', /^\/api\/runs\/([a-f0-9]{8})\/save\/(p[1-4])$/, async (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    const p = defaultSavePath(manifest, m[2]);
    if (!p) throw httpError(409, 'Kein ROM für diesen Spieler', 'noRomForPlayer');
    const bytes = await readRaw(req, 4 * 1024 * 1024);
    if (!bytes.length) throw httpError(400, 'Leerer Spielstand – nicht gespeichert', 'emptySave');
    writeFileAtomic(p, bytes);
    // Other games' saves can't be parsed – watching them would only produce error toasts.
    if (isHgssRun(manifest) && !watcher.status(m[1]).watching) {
      watcher.watch(m[1], p);
      const cfg = loadConfig();
      saveConfig({ watches: { ...(cfg.watches || {}), [m[1]]: p } });
    }
    return { ok: true, size: bytes.length };
  });

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/watch$/, async (req, m) => {
    const { path } = await readBody(req);
    if (path && typeof path !== 'string') throw httpError(400, 'Ungültiger Pfad', 'badPath');
    const cfg = loadConfig();
    const watches = { ...(cfg.watches || {}) };
    if (!path) {
      watcher.unwatch(m[1]);
      delete watches[m[1]];
      saveConfig({ watches });
      return watcher.status(m[1]);
    }
    const abs = resolve(path.replace(/^~(?=\/)/, process.env.HOME || '~'));
    watches[m[1]] = abs;
    saveConfig({ watches });
    return watcher.watch(m[1], abs);
  });
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/rescan$/, (req, m) => watcher.read(m[1], true) || watcher.last(m[1]));
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/save-parsed$/, (req, m) => watcher.last(m[1]));

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/graveyard$/, async (req, m) => {
    const { keys } = await readBody(req);
    const status = watcher.status(m[1]);
    if (!status.watching || !existsSync(status.path)) throw httpError(500, 'Kein überwachter Spielstand für diesen Run.', 'noWatchedSave');
    if (emulatorRunning()) throw httpError(409, 'Der externe Emulator läuft noch. Im Spiel speichern, Emulator schließen, dann erneut versuchen.', 'emulatorRunning');
    const original = readFileSync(status.path);
    const { file, moved, box } = moveToGraveyard(new Uint8Array(original), keys || []);
    if (!moved.length) return { moved: [] };
    const check = parseHgssSave(file, GEN4);
    const ok = moved.every((k) => check.boxes.some((b) => b.key === k && b.checksumOk) && !check.party.some((p) => p.key === k));
    if (!ok) throw httpError(500, 'Prüfung nach dem Bearbeiten fehlgeschlagen – Spielstand wurde nicht verändert.', 'graveyardCheckFailed');
    const backupDir = join(runDir(m[1]), 'backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(backupDir, `${stamp}.sav`), original);
    writeFileSync(status.path, file);
    return { moved, box: box + 1, backup: `backups/${stamp}.sav`, save: watcher.read(m[1], true) };
  });

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/reveal$/, async (req, m) => {
    const { file } = await readBody(req);
    const target = file ? safeJoin(runDir(m[1]), file) : runDir(m[1]);
    if (!target || !existsSync(target)) throw httpError(500, 'Datei nicht gefunden', 'fileNotFound');
    revealInFileManager(target);
    return { ok: true };
  });

  // ---- emulators -----------------------------------------------------------------
  route('POST', /^\/api\/emulators\/([a-z0-9]+)\/install$/, async (req, m) => installEmulator(m[1]));
  route('GET', /^\/api\/emulators\/running$/, () => ({ running: emulatorRunning() }));
  route('POST', /^\/api\/emulators\/([a-z0-9]+)\/launch$/, async (req, m) => {
    const { runId, slot, romId, patchId } = await readBody(req);
    let romPath;
    if (!runId && patchId) {
      // ROM hacks: launch the patched copy from the cache, not the vanilla base ROM
      romPath = preparePatchedRom(romId, patchId, () => {}, loadConfig()).path;
    } else if (runId) {
      if (!ALL_SLOTS.includes(slot)) throw httpError(400, 'Ungültiger Spieler', 'badPlayer');
      const manifest = readManifest(runId);
      const out = manifest?.outputs?.[slot];
      if (!out) throw httpError(409, 'ROM für diesen Spieler wurde noch nicht gebaut', 'romNotBuilt');
      romPath = join(runDir(runId), out.rom);
      const sav = defaultSavePath(manifest, slot);
      if (sav && isHgssRun(manifest) && !watcher.status(runId).watching) watcher.watch(runId, sav);
    } else {
      // external emulators need a real file: unpack zipped ROMs into the cache
      const { abs, entry } = resolveId(romId, loadConfig());
      if (entry) {
        const dir = join(CACHE_DIR, 'unzipped');
        mkdirSync(dir, { recursive: true });
        // one folder per archive entry: different zips often contain equally named ROMs
        // (the entry's own name, made valid here – "Pokémon: X.nds" from a Mac zip can't be created on Windows)
        romPath = join(dir, keyOf(romId), safeFileName(entry, { fallback: `rom.${extname(entry).slice(1) || 'bin'}` }));
        if (!existsSync(romPath)) {
          mkdirSync(dirname(romPath), { recursive: true });
          writeFileAtomic(romPath, loadFile(romId, loadConfig()));
        }
      } else romPath = abs;
    }
    const script = m[1] === 'mgba' ? live.luaScriptPath() : null;
    return launchRom(m[1], romPath, { customPath: loadConfig().emulatorPaths?.[m[1]], script });
  });

  route('GET', /^\/api\/live$/, () => live.status());
  // The mGBA script lives in a hidden folder on Windows (%APPDATA%) – show it instead of making people type the path.
  route('POST', /^\/api\/live\/reveal$/, () => {
    if (!existsSync(live.luaScriptPath())) throw httpError(404, 'Skript fehlt', 'scriptMissing');
    revealInFileManager(live.luaScriptPath());
    return { ok: true };
  });

  // ---- Discord webhook: local to this computer (config.discordWebhooks[runId]), never in the shared rules ----
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/discord$/, (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    return { webhook: discordWebhookFor(m[1]) };
  });
  route('PUT', /^\/api\/runs\/([a-f0-9]{8})\/discord$/, async (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
    discordWebhookFor(m[1]); // finish a pending migration so it can't overwrite this later
    const { webhook } = await readBody(req);
    const hook = typeof webhook === 'string' ? webhook.trim() : '';
    if (hook && !isDiscordWebhook(hook)) throw httpError(400, 'Ungültige Discord-Webhook-URL', 'badWebhook');
    saveConfig({ discordWebhooks: { ...(loadConfig().discordWebhooks || {}), [m[1]]: hook } });
    return { webhook: hook };
  });
  route('POST', /^\/api\/notify\/discord$/, async (req) => {
    const { runId, content } = await readBody(req);
    if (typeof runId !== 'string' || !/^[a-f0-9]{8}$/.test(runId)) throw httpError(400, 'Ungültiger Run', 'badRun');
    const webhook = discordWebhookFor(runId);
    if (!webhook) return { ok: false, skipped: true };
    const r = await fetch(webhook, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions: names come from the partner – no @everyone / role / user pings
      body: JSON.stringify({ content: String(content || '').slice(0, 2000), username: 'souldew', allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) throw new Error(`Discord antwortete ${r.status}`);
    return { ok: true };
  });

  // ---- images: sprites & covers (cached, offline after first fetch) ------------------
  let spriteSources = null;
  const spriteUrl = (set, id) => {
    if (!spriteSources) {
      try {
        spriteSources = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'sprite_sources.json'), 'utf8'));
      } catch {
        spriteSources = {};
      }
    }
    const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
    const map = {
      default: `${base}${id}.png`,
      shiny: `${base}shiny/${id}.png`,
      gen1: `${base}versions/generation-i/red-blue/transparent/${id}.png`,
      gen2: `${base}versions/generation-ii/crystal/transparent/${id}.png`,
      gen2shiny: `${base}versions/generation-ii/crystal/transparent/shiny/${id}.png`,
      gen3: `${base}versions/generation-iii/emerald/${id}.png`,
      gen3shiny: `${base}versions/generation-iii/emerald/shiny/${id}.png`,
      gen3frlg: `${base}versions/generation-iii/firered-leafgreen/${id}.png`,
      gen4: `${base}versions/generation-iv/heartgold-soulsilver/${id}.png`,
      gen4shiny: `${base}versions/generation-iv/heartgold-soulsilver/shiny/${id}.png`,
      gen4pt: `${base}versions/generation-iv/platinum/${id}.png`,
      gen5: `${base}versions/generation-v/black-white/${id}.png`,
      gen5shiny: `${base}versions/generation-v/black-white/shiny/${id}.png`,
      gen5anim: `${base}versions/generation-v/black-white/animated/${id}.gif`,
      artwork: `${base}other/official-artwork/${id}.png`,
    };
    return map[set] || null;
  };

  async function serveCached(res, file, url) {
    if (!existsSync(file)) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(String(r.status));
        mkdirSync(dirname(file), { recursive: true });
        writeFileAtomic(file, Buffer.from(await r.arrayBuffer()));
      } catch {
        return send(res, 404, 'not available');
      }
    }
    serveFile(res, file, { 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  async function prefetchSprites() {
    // Default art for every species + the Gen 4 set (HeartGold/SoulSilver runs) so boards work offline.
    const todo = [];
    for (const [set, max] of [['default', 649], ['gen4', 493]]) {
      for (let id = 1; id <= max; id++) if (!existsSync(join(CACHE_DIR, 'sprites', set, `${id}.png`))) todo.push([set, id]);
    }
    const worker = async () => {
      while (todo.length) {
        const [set, id] = todo.shift();
        try {
          const r = await fetch(spriteUrl(set, id), { signal: AbortSignal.timeout(15000) });
          if (r.ok) {
            mkdirSync(join(CACHE_DIR, 'sprites', set), { recursive: true });
            writeFileAtomic(join(CACHE_DIR, 'sprites', set, `${id}.png`), Buffer.from(await r.arrayBuffer()));
          }
        } catch {
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // ---- request handling ------------------------------------------------------------
  const server = createServer(async (req, res) => {
    if (!hostAllowed(req.headers.host)) return send(res, 403, 'Forbidden host');
    let url;
    let path;
    try {
      // Parsed here (not from the Host header) so a malformed URL can't throw outside the try.
      url = new URL(req.url, 'http://localhost');
      path = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { error: 'Ungültige URL' });
    }
    try {
      if (path.startsWith('/api/')) {
        // Origin / Sec-Fetch-Site / x-soullink checks (server/lib/guard.mjs) – before any API route, SSE included.
        const denied = apiRequestError(req, server.address()?.port);
        if (denied) return send(res, 403, { error: denied });
      }
      const overlayEvents = path.match(/^\/api\/runs\/([a-f0-9]{8})\/overlay\/events$/);
      if (overlayEvents && req.method === 'GET') {
        const lang = overlayLang(url.searchParams.get('lang'));
        const first = overlayData(overlayEvents[1], lang); // unknown run → 404 before the stream opens
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify(first)}\n\n`);
        if (!overlayClients.has(overlayEvents[1])) overlayClients.set(overlayEvents[1], new Map());
        const w = String(url.searchParams.get('w') || 'team').slice(0, 12);
        overlayClients.get(overlayEvents[1]).set(res, { lang, w, preview: url.searchParams.get('preview') === '1', alerts: w === 'alerts' || url.searchParams.get('alerts') === '1' });
        res.on('close', () => overlayClients.get(overlayEvents[1])?.delete(res));
        return;
      }
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        sseClients.add(res);
        res.on('close', () => sseClients.delete(res));
        return;
      }
      if (path.startsWith('/api/')) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          // "Save as file": exports of files the user already has (library, builds, saves).
          const handled = handleExport(req, res, path, url);
          if (handled !== false) return handled;
        }
        const download = path.match(/^\/api\/runs\/([a-f0-9]{8})\/file$/);
        if (download && (req.method === 'GET' || req.method === 'HEAD')) {
          const name = url.searchParams.get('name') || '';
          const file = safeJoin(runDir(download[1]), name);
          if (!file) return send(res, 400, { error: 'bad name' });
          return serveFile(res, file, url.searchParams.get('inline') ? {} : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }, req.method === 'HEAD');
        }
        if (path === '/api/library/patched' && req.method === 'GET') {
          const r = preparePatchedRom(url.searchParams.get('romId'), url.searchParams.get('patchId'), () => {}, loadConfig());
          return serveFile(res, r.path);
        }
        if (path.startsWith('/api/saves/state')) {
          const handled = await handleStates(req, res, path, url);
          if (handled !== false) return handled;
        }
        if (path === '/api/library/rom' && req.method === 'GET') {
          return send(res, 200, Buffer.from(loadFile(url.searchParams.get('id'), loadConfig())));
        }
        if (path === '/api/library/rom' && req.method === 'HEAD') {
          // EmulatorJS asks first (HEAD); the size of a zipped ROM is only known after unpacking, so just say whether it exists
          let found = false;
          try { found = existsSync(resolveId(url.searchParams.get('id'), loadConfig()).abs); } catch {}
          res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/octet-stream' });
          return res.end();
        }
        if (path === '/api/library/cover' && (req.method === 'GET' || req.method === 'HEAD')) {
          const f = coverFile(url.searchParams.get('id'));
          if (!f) return send(res, 404, { error: 'Kein eigenes Bild', code: 'noCover' });
          // the url carries the file's time (?v=…) – a new picture gets a new url, so this one may be cached
          return serveFile(res, f.path, { 'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff',
            'Cache-Control': url.searchParams.get('v') ? 'private, max-age=31536000, immutable' : 'no-cache' });
        }
        if (path === '/api/saves/solo' && req.method === 'GET') {
          const file = join(SOLO_SAVES, `${keyOf(url.searchParams.get('id'))}.sav`);
          return existsSync(file) ? send(res, 200, readFileSync(file)) : send(res, 404, { error: 'no save' });
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = path.match(r.pattern);
          if (!m) continue;
          const result = await r.handler(req, m, url);
          return send(res, 200, result === undefined ? null : result);
        }
        return send(res, 404, { error: 'Unbekannter API-Endpunkt' });
      }
      const sprite = path.match(/^\/sprites\/([a-z0-9]+)\/(\d{1,4})\.(png|gif)$/);
      if (sprite) {
        const u = spriteUrl(sprite[1], Number(sprite[2]));
        return u ? serveCached(res, join(CACHE_DIR, 'sprites', sprite[1], `${sprite[2]}.${sprite[3]}`), u) : send(res, 404, 'unknown set');
      }
      const cover = path.match(/^\/covers\/([a-z0-9-]+)\.png$/);
      if (cover) {
        const bundled = join(WEB_DIR, 'assets', 'covers', `${cover[1]}.png`);
        if (existsSync(bundled)) return serveFile(res, bundled, { 'Cache-Control': 'public, max-age=86400' });
        const g = (catalog().games || []).find((x) => x.id === cover[1]);
        if (!g?.cover) return send(res, 404, 'no cover');
        return serveCached(res, join(CACHE_DIR, 'covers', `${cover[1]}.png`), g.cover);
      }
      // Unique, file-like ROM URLs for the emulator: EmulatorJS names the in-memory ROM (and its
      // battery save) after the last URL segment, so every game needs its own name.
      if (/^\/rom\/[a-z0-9-]+\.(nds|gba|gbc|gb)$/.test(path)) {
        const src = url.searchParams.get('src') || '';
        if (!src.startsWith('/api/')) return send(res, 400, 'bad src');
        res.writeHead(302, { Location: src, 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (VENDOR[path]) return serveFile(res, VENDOR[path]);
      if (path === '/live/soullink.lua') {
        // contains the live bridge token – same origin rules as the API
        if (apiRequestError(req, server.address()?.port)) return send(res, 403, 'Forbidden');
        return serveFile(res, live.luaScriptPath());
      }
      if (path.startsWith('/shared/')) {
        const f = safeJoin(SHARED_DIR, path.slice('/shared/'.length));
        return f ? serveFile(res, f) : send(res, 400, 'bad path');
      }
      const page = path === '/' ? 'index.html' : path === '/overlay' ? 'overlay.html' : path.slice(1);
      const f = safeJoin(WEB_DIR, page);
      return f ? serveFile(res, f, pageHeaders(f)) : send(res, 400, 'bad path'); // CSP for .html pages
    } catch (e) {
      console.error(`[${req.method} ${path}]`, e.message);
      if (res.headersSent) return res.destroy();
      return send(res, e.status || 500, { error: e.message, code: e.status ? e.code : undefined, vars: e.status ? e.vars : undefined, details: e.details ? { stderr: String(e.details.stderr || '').slice(0, 4000) } : undefined });
    }
  });

  server.on('close', () => {
    pokelink.bridge?.close();
    pokelink.bridge = null;
  });

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      // background work: the mGBA bridge port and the offline sprite cache (tests start without it)
      if (background) {
        pokelinkApply().catch(() => {});
        live.start().catch((e) => console.warn('live bridge unavailable:', e.message));
        prefetchSprites().catch(() => {});
      }
      resolvePromise({ server, port: actual, url: `http://localhost:${actual}` });
    });
  });
}

/**
 * The run's doc.json, or null when there is none. A damaged file is kept as doc.json.corrupt-<time> and reads as
 * null, so the board still opens (the browser's local copy and the partner fill it again) instead of failing.
 */
export function readDoc(runId) {
  const p = join(runDir(runId), 'doc.json');
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    const doc = JSON.parse(text);
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
  } catch {
    // fall through
  }
  console.warn(`run ${runId}: doc.json unlesbar – als Kopie aufbewahrt`);
  try {
    renameSync(p, `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  } catch {
    // read-only – still answer
  }
  return null;
}

function defaultSavePath(manifest, slot) {
  const out = manifest?.outputs?.[slot];
  if (!out) return null;
  return join(runDir(manifest.id), out.rom.replace(/\.(nds|gba|gbc|gb)$/i, '.sav'));
}

