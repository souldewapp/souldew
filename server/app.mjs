// souldew – embeddable local server. Serves the UI and does the heavy lifting:
// library scanning, patching, randomizing (bundled Java), save files, emulator management,
// and the live bridge for external emulators. Used by the Electron app and by `npm start`.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream, createWriteStream, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync, utimesSync } from 'node:fs';
import { once } from 'node:events';
import { join, extname, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { upgradeStep, backupInfo, majorOf } from './lib/upgrade.mjs';
import { AUTO_SLOT, STATE_EXT, mtimeOf, statePath as statePathIn, rotateAutoState as rotateAutoStateIn } from './lib/statefiles.mjs';
import { WEB_DIR, SHARED_DIR, CACHE_DIR, DATA_DIR, CONFIG_PATH, NODE_MODULES, DEV, LIBRARY_DIR } from './lib/paths.mjs';
import { writeFileAtomic, httpError, safeFileName, safeJoin, realInside, logLine, readRange } from './lib/fsutil.mjs';
import { detectJava, uprStatus, installUpr, runBridge, inspectRom, javaDiagnostics, missingToolNow } from './lib/toolchain.mjs';
import { preparePatchedRom, KNOWN_PATCHES } from './lib/roms.mjs';
import { ROM_EXTENSIONS, PATCH_EXTENSIONS, isCtrExt, matchCatalog } from '../shared/romid.mjs';
import { ALL_SLOTS, slotsOf, runMode } from '../shared/slots.mjs';
import { scanLibrary, catalog, loadFile, importFiles, removeStaleParts, uploadTarget, resolveId, discoverRoms, approvedFolder, placeUploadedZip, unpackLibraryZip, MAX_CTR_BYTES, setRomHack, removeCtrUpdate } from './lib/library.mjs';
import { freeBytes } from './lib/zip.mjs';
import { saveCover, deleteCover, coverFile, customCovers, coverUrl, COVER_LIMIT } from './lib/covers.mjs';
import { inspectCtr, ncchSizeOf } from './lib/ctrrando.mjs';
import { shinySupport, isOriginalRom } from './lib/shiny.mjs';
import { packFormatState, packMinVersion } from '../shared/runpack.mjs';
import { okLibraryId } from '../shared/playtogether.mjs';
import { isHostKey, unsigned } from '../shared/hostrules.mjs';
import { signRules, isHostComputer } from './lib/hostkey.mjs';
import { shinyThreshold } from '../shared/shiny.mjs';
import { buildRun, listRuns, readManifest, writeManifest, runDir, runPack, runSummary, trashRun, checkPack, stripLocalRules, isDiscordWebhook, mergeDocEntries, renamePlayers } from './lib/build.mjs';
import { SaveWatcher, saveParser, isHgssGame } from './lib/savewatch.mjs';
import { EMULATORS, detectEmulator, installEmulator, launchRom, revealInFileManager, emulatorRunning, melonConfigFiles, melonSaveDirs } from './lib/emulator.mjs';
import { LiveBridge } from './lib/livebridge.mjs';
import { AzaharBridge, enableRpc } from './lib/azahar.mjs';
import { CtrSessions, ctrTools, saveStamp, ctrInventory, redactHome, ctrEncrypted, ctrFileReport, saveDirFor } from './lib/ctr.mjs';
import { prepareUpdate, updateStamp } from './lib/ctrupdate.mjs';
import { pickUpdate } from '../shared/ctr/update.mjs';
import { pickRenderer, validRenderer, gpuKey, remember, validScale, scaleFor } from './lib/ctrrenderer.mjs';
import { NativeSessions, nativeTools, NATIVE_CORES, linkTool, MAX_SAVE, MAX_STATE, GB_LOOKS, gbModel, nativeCoreId, ENGINE_SYSTEMS } from './lib/native.mjs';
import { LINK_SYSTEMS, MAX_LINK_SEATS, sameLinkSystem, linkUnavailable } from '../shared/link.mjs';
import { cleanFavourites } from '../shared/favourites.mjs';
import { cleanHandheld, cleanLaunchLook, cleanLaunchPace, cleanClearTint } from '../shared/handheld.mjs';
import { ownSeat, resolveSeat, pickSeat, extractTarget, partnerBuildRequest } from './lib/linkroms.mjs';
import { linkIceServers } from './lib/linkice.mjs';
import { needsIdenticalRom, baseRomsFor } from '../shared/restart.mjs';
import { moveToGraveyard, parseHgssSave } from '../shared/gen4save.mjs';
import { listPresets, savePreset, deletePreset } from './lib/presets.mjs';
import { pageHeaders } from './lib/csp.mjs';
import { gpuBackends, validBackend, fallbackNotice } from '../shared/gpu.mjs';
import { validUiScale } from '../shared/uiscale.mjs';
import { hostAllowed, apiRequestError, privateRequestError, rendererSecretError } from './lib/guard.mjs';
import { acceptStream, refuse } from './lib/wsstream.mjs';
import { overlaySnapshot, TEST_SPECIES, currentRunId } from '../shared/overlay.mjs';
import { startPokelinkBridge, pokelinkPlayers, POKELINK_PORT } from './lib/pokelink.mjs';
import { romDataFor } from './lib/romloc.mjs';
import { createStreamHub, streamSettings, streamMigration } from './lib/streamapi.mjs';
import { COFFEE_CORNERS } from '../shared/coffee.mjs';
import { LINKS } from '../shared/links.mjs';
import { randomBytes } from 'node:crypto';
import { syncTrophies } from './lib/trophies.mjs';
import { checkImport, replaceSave, undoImport, lastImport, unzipSingleSave, readZipFiles, checkCtrImport, replaceCtrSave, undoCtrImport, ctrSaveArchives } from './lib/saveimport.mjs';
import { listIntroSaves, introFor, introKeyFor, introKeyForLibrary, publicIntro, keepIntroSave, removeIntroSave, applyIntroSave, introState } from './lib/introsave.mjs';
import * as liveRuns from './lib/liveruns.mjs';
import { createAccounts } from './lib/accounts/index.mjs';
import { isPackagedBuild } from './lib/accounts/enttoken.mjs';

/** The environment switches only development and tests may use (an installed app ignores them). */
export const DEV_SWITCHES = ['SLS_ACCOUNTS_URL', 'SLS_PLUS_DEV_PACK', 'SLS_PLUS_DEV_KEY', 'SLS_ACCOUNTS_DEV_ENT_KEY'];
export function withoutDevSwitches(env) {
  const out = { ...env };
  for (const k of DEV_SWITCHES) delete out[k];
  return out;
}
import { createPlusPack, plusRoutes } from './lib/pluspack.mjs';
import { createPlusPreviews, servePreview } from './lib/pluspreviews.mjs';
import { presence as presenceCounter } from './lib/presence.mjs';
import { createUsage } from './lib/usage.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
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

/** A souldew+ skin / launch animation id as the catalog writes them – anything else is no choice at all. */
const validSkinId = (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : null);

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
  if (Number.isFinite(len) && len > limit) throw httpError(413, 'Request too large', 'requestTooLarge');
}

async function readRaw(req, limit = 512 * 1024 * 1024) {
  checkLength(req, limit);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'Request too large', 'requestTooLarge');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const UPLOAD_LIMIT = 600 * 1024 * 1024; // the biggest DS ROMs are 512 MB
/** An imported save (a zip of a 3DS backup at most – a DS save is 1 MB, a 3DS game's `main` under 0.5 MB). */
const IMPORT_LIMIT = 24 * 1024 * 1024;
/** 3DS games (1–4 GB) and zips (which may hold one) may be as big as library.mjs lets a 3DS game be. */
const uploadLimitFor = (name) => {
  const ext = extname(String(name)).slice(1).toLowerCase();
  return isCtrExt(ext) || ext === 'zip' ? MAX_CTR_BYTES : UPLOAD_LIMIT;
};

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
      if (size > limit) throw httpError(413, 'File too large', 'fileTooLarge');
      if (failed) throw failed;
      if (!out.write(c)) {
        // (the listener that didn't fire is taken off again – a multi-GB upload waits here thousands of times)
        const ac = new AbortController();
        await Promise.race([once(out, 'drain', { signal: ac.signal }), once(out, 'close', { signal: ac.signal })]).finally(() => ac.abort());
      }
    }
    if (!size) throw httpError(400, 'Empty file', 'emptyFile');
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
    throw httpError(400, 'Invalid JSON', 'badJson');
  }
  // Handlers destructure the body – null / arrays / primitives would throw a TypeError there.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'JSON object expected', 'jsonObject');
  return body;
}

function serveFile(res, path, extraHeaders = {}, head = false) {
  if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': statSync(path).size, ...extraHeaders });
  if (head) return res.end(); // EmulatorJS asks for the size first (HEAD) before it downloads the ROM
  // Without a listener a read error (file removed / unreadable) would crash the whole server.
  createReadStream(path).on('error', () => res.destroy()).pipe(res);
}

/** HeartGold/SoulSilver: their saves have their own parser (shared/gen4save.mjs), the only ones the graveyard edits. */
const isHgssRun = (m) => isHgssGame(m?.game);

/**
 * A file in a run's folder by name (a query parameter, or a name from run.json – which can be damaged or edited by
 * hand): null unless it stays inside that folder, also after following links. '' is the folder itself.
 */
export function runPath(runId, name) {
  const dir = runDir(runId);
  const p = safeJoin(dir, name);
  return p && realInside(p, dir) ? p : null;
}

const keyOf = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** Save files of solo games (not part of a run) live here, keyed by the library id. */
const SOLO_SAVES = join(DATA_DIR, DEV ? 'runs/.saves' : 'Saves');
/** A library game's battery save (its free play's – and a Play together run's that plays it). */
export const librarySavePath = (id) => join(SOLO_SAVES, `${keyOf(id)}.sav`);

// ---- save states of the built-in emulator (server/lib/statefiles.mjs) -----------------
const STATE_DIR = join(SOLO_SAVES, 'states');
const statePath = (key, slot, ext) => statePathIn(STATE_DIR, key, slot, ext);
const rotateAutoState = (key) => rotateAutoStateIn(STATE_DIR, key);

/**
 *   GET    /api/saves/states?id=                 list: [{ slot, at, thumb, info }]
 *   GET    /api/saves/state?id=&slot=            state bytes      PUT: write   DELETE: remove (with picture + info)
 *   GET    /api/saves/state/thumb?id=&slot=      JPEG thumbnail
 *   PUT    /api/saves/state/info?id=&slot=       { thumb: base64 JPEG, info: {…} } for an existing state
 * Files are named by a hash of the id and an integer slot, so no request can reach outside STATE_DIR.
 */
async function handleStates(req, res, path, url) {
  const id = url.searchParams.get('id');
  if (!id) return send(res, 400, { error: 'ID missing', code: 'idMissing' });
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
  if (!Number.isInteger(slot) || slot < 1 || slot > 99) return send(res, 400, { error: 'Invalid slot', code: 'badSlot' });
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'JSON object expected', code: 'jsonObject' });
    if (body.thumb != null) {
      const jpg = Buffer.from(String(body.thumb), 'base64');
      if (jpg.length < 4 || jpg.length > 256 * 1024 || jpg[0] !== 0xff || jpg[1] !== 0xd8) return send(res, 400, { error: 'Not a JPEG picture', code: 'badThumb' });
      writeFileAtomic(statePath(key, slot, 'jpg'), jpg);
    }
    if (body.info && typeof body.info === 'object' && !Array.isArray(body.info)) {
      const text = JSON.stringify(body.info);
      if (text.length > 16 * 1024) return send(res, 413, { error: 'Request too large', code: 'requestTooLarge' });
      writeFileAtomic(statePath(key, slot, 'json'), text);
    }
    return send(res, 200, { ok: true });
  }
  if (path !== '/api/saves/state') return false;
  if (req.method === 'GET') return existsSync(file) ? send(res, 200, readFileSync(file)) : send(res, 404, { error: 'no state' });
  if (req.method === 'PUT') {
    const bytes = await readRaw(req, 64 * 1024 * 1024);
    if (!bytes.length) return send(res, 400, { error: 'Empty save file – not saved', code: 'emptySave' });
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
    if (!st?.isFile()) return send(res, 404, { error: 'File not found', code: 'fileNotFound' });
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
  const idOf = (r) => (r.gameId ? `game:${r.gameId}` : r.crc ? `rom:${r.crc}` : /^[0-9A-F]{16}$/.test(r.titleId || '') ? `ctr:${r.titleId}` : null);
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
    if (romId && !ROM_EXTENSIONS.includes(idExt(romId))) return send(res, 400, { error: 'Not a ROM file', code: 'notRom' });
    if (patchId && !PATCH_EXTENSIONS.includes(idExt(patchId))) return send(res, 400, { error: 'Not a patch file', code: 'notPatch' });
    if (romId && patchId) {
      const r = preparePatchedRom(romId, patchId, () => {}, config);
      return sendDownload(req, res, `${patchedTitle(patchId, config)}${extname(r.path)}`, r.path);
    }
    const id = romId || patchId;
    if (!id) return send(res, 400, { error: 'id, romId or patchId missing', code: 'idMissing' });
    const { abs, entry } = resolveId(id, config);
    if (!entry) return sendDownload(req, res, basename(abs), abs);
    return sendDownload(req, res, idFileName(id), loadFile(id, config));
  }
  if (path === '/api/saves/solo/download') {
    const id = q('id');
    if (!id) return send(res, 400, { error: 'ID missing', code: 'idMissing' });
    const file = join(SOLO_SAVES, `${keyOf(id)}.sav`);
    if (!existsSync(file)) return send(res, 404, { error: 'No save file yet', code: 'noSaveYet' });
    const [romId, patchId] = id.split('|');
    const base = patchId ? patchedTitle(patchId, loadConfig()) : idFileName(romId).replace(/\.\w+$/, '');
    return sendDownload(req, res, `${base || 'Save'}.sav`, file);
  }
  const run = path.match(/^\/api\/runs\/([a-f0-9]{8})\/download$/);
  if (run) {
    const manifest = readManifest(run[1]);
    if (!manifest) return send(res, 404, { error: 'Run not found', code: 'runNotFound' });
    const what = q('what') || 'rom';
    const slot = q('slot') || 'p1';
    if (!ALL_SLOTS.includes(slot)) return send(res, 400, { error: 'slot must be p1 to p4', code: 'badPlayer' });
    const out = manifest.outputs?.[slot];
    let name = null;
    let downloadName = null;
    if (what === 'rom') name = out?.rom;
    else if (what === 'spoiler') name = out?.log;
    else if (what === 'save') {
      const sav = defaultSavePath(manifest, slot);
      // (Play together: the library game's own save, outside the run folder – named after the run's game file)
      if (sav && runMode(manifest) === 'together') {
        if (!existsSync(sav)) return send(res, 404, { error: 'No save file yet', code: 'noSaveYet' });
        return sendDownload(req, res, String(out?.rom || 'Save').replace(/\.\w+$/, '.sav'), sav);
      }
      name = sav ? basename(sav) : null;
    }
    else if (what === 'pack') {
      name = 'run-pack.soullink.json';
      downloadName = `${manifest.name || 'SoulLink'}.soullink.json`;
    } else return send(res, 400, { error: 'what must be rom, save, spoiler or pack', code: 'badRequest' });
    if (!name) return send(res, 404, { error: 'File not found', code: 'fileNotFound' });
    const file = runPath(run[1], name);
    if (!file) return send(res, 400, { error: 'bad name', code: 'badRequest' });
    return sendDownload(req, res, downloadName || name, file);
  }
  return false;
}

/**
 * The JSON answer for an error a handler threw: message, and the code/vars the app translates. A tool's output
 * (the randomizer's stderr in `details`, full of local paths) goes to the server's log, never into the answer.
 */
export function errorBody(e) {
  return { error: e.message, code: e.status ? e.code : undefined, vars: e.status ? e.vars : undefined };
}

/**
 * Start the server.
 * @param {{port?: number, host?: string, onReady?: (url:string)=>void}} opts
 * The desktop app also passes the souldew account's helpers (server/lib/accounts/index.mjs): secureStore (Electron's
 * safeStorage – without it a session is kept in memory only), openExternal (the system browser for "Sign in with
 * Discord") and focus (bring the window forward when the browser hands the sign-in back).
 * The saved sign-in is read only after the server is up and never awaited by it (it may mean the keychain, and the
 * keychain a password prompt): right after listen, or – deferAccount – when the caller calls loadAccount() (the
 * desktop app: once its window is open). An account route that comes earlier starts it itself.
 */
export function startServer({ port = 7373, host = '127.0.0.1', background = true, secureStore = null, openExternal = null, focus = () => {}, packaged = isPackagedBuild(), rendererSecret = null, deferAccount = false } = {}) {
  // An installed app never takes the account service, a dev pack or a dev key from the environment (only development
  // and tests do) – otherwise a changed environment could send the tokens elsewhere or make the app trust another key.
  const env = packaged ? withoutDevSwitches(process.env) : process.env;
  const GEN4 = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'gen4.json'), 'utf8'));
  // The first start of a new major version (server/lib/upgrade.mjs): the backup of the player's data comes before any
  // migration below touches it, and the "What's new" cards are noted. Not in development (the data folder is the
  // project folder there) – the version is still noted. A config that can't be read is left alone.
  try {
    const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
    upgradeStep({ dataDir: DATA_DIR, config, current: liveRuns.souldewVersion(), save: saveConfig, backups: !DEV });
  } catch (e) {
    console.warn('[upgrade] skipped:', e.message);
  }
  // The stream API's localPages switch (server/lib/streamapi.mjs streamMigration): an install set up before it
  // existed keeps reading from local pages without a token, a new one starts strict. A config that can't be read
  // is left alone (saveConfig would replace it with this one patch).
  try {
    const patch = streamMigration(existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {});
    if (patch) saveConfig(patch);
  } catch {
    // unreadable config – streamSettings reads localPages as off
  }
  const sseClients = new Set();
  const emit = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  let addressTable = null;
  const addresses = () => {
    if (!addressTable) {
      try {
        addressTable = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'addresses.json'), 'utf8'));
      } catch {
        addressTable = { games: [] };
      }
    }
    return addressTable;
  };
  /** How the battery save of a run's game is read, or null: souldew can't (shared/live/parse.mjs readSaveFile). */
  const parserOfRun = (manifest) => (manifest ? saveParser(manifest.game, { gen4: GEN4, addresses: addresses() }) : null);
  const watcher = new SaveWatcher(GEN4, emit, {
    parserFor: (id) => {
      try {
        return parserOfRun(readManifest(id));
      } catch {
        return null;
      }
    },
    shinyOdds: (id) => {
      try {
        return shinyThreshold(readManifest(id)?.shiny);
      } catch {
        return shinyThreshold(null); // (an unreadable run.json – the games' own odds)
      }
    },
  });
  /**
   * Watch a run's battery save – where the built-in players keep it and, for an external emulator, wherever else it
   * may write it (`more`: melonDS's own save folder) – for every game whose saves souldew reads (it used to be
   * HeartGold/SoulSilver only). A save the built-in players write starts a watch only where there is none yet;
   * launching an emulator from the play view (`replace`) watches the places it writes to now – a watch kept from an
   * earlier session may name a file the run doesn't use anymore.
   */
  const sameFile = (a, b) => (process.platform === 'win32' || process.platform === 'darwin' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const watchRunSave = (runId, manifest, path, { more = [], replace = false } = {}) => {
    if (!path || !parserOfRun(manifest)) return;
    const want = [path, ...more.filter((p) => p && !sameFile(p, path))];
    const now = watcher.paths(runId);
    if (now && (!replace || (now.length === want.length && want.every((p, i) => sameFile(p, now[i]))))) return;
    watcher.watch(runId, want);
    saveConfig({ watches: { ...(loadConfig().watches || {}), [runId]: want.length > 1 ? want : path } });
  };
  /** The save watch of a run as the page gets it – with whether souldew can read and edit (the graveyard) its saves. */
  const watchStatus = (runId, manifest) => ({ ...watcher.status(runId), readable: !!parserOfRun(manifest), graveyard: isHgssRun(manifest) });
  // the anonymous "playing now" heartbeat – it reads the setting on every call, so "off" applies at once
  const playingNow = presenceCounter({ enabled: () => loadConfig().presence !== false });
  // the anonymous daily usage ping (server/lib/usage.mjs) – same switch; only a packaged app (or a test's mock bot) sends
  const usagePing = createUsage({ enabled: () => loadConfig().presence !== false, allowed: packaged || !!env.SOULDEW_LIVE_URL, env,
    file: join(dirname(CONFIG_PATH), 'usage.json'), configPath: CONFIG_PATH });
  usagePing.start();
  const live = new LiveBridge(emit);
  // 3DS in souldew's own player (server/lib/ctr.mjs): one game at a time
  const ctr = new CtrSessions();
  // the 3DS renderer "auto" (server/lib/ctrrenderer.mjs): which graphics card the last game ran on, and the step down
  // a card / driver needed – the next start takes it right away
  ctr.onGpu = (gpu) => {
    const key = gpuKey(gpu);
    if (loadConfig().ctrLastGpu !== key) saveConfig({ ctrLastGpu: key });
  };
  ctr.onRendererFailed = ({ gpu, to }) => {
    const cfg = loadConfig();
    const key = gpu ? gpuKey(gpu) : cfg.ctrLastGpu || '?';
    saveConfig({ ctrRendererMemo: remember(cfg.ctrRendererMemo, key, to), ctrLastGpu: key });
  };
  const ctrRendererNow = (cfg = loadConfig()) => pickRenderer({ setting: cfg.ctrRenderer, memo: cfg.ctrRendererMemo, lastGpu: cfg.ctrLastGpu });
  // A battery save the host sends after its page has gone (closed right after saving in the game): stored where the
  // play view would have put it – the run's save (and its HeartGold/SoulSilver watcher) or the solo game's.
  const native = new NativeSessions({
    writeSave: ({ path, runId }, bytes) => {
      writeFileAtomic(path, bytes);
      const manifest = runId ? readManifest(runId) : null;
      if (manifest) watchRunSave(runId, manifest, path);
    },
  });
  /** Where the play view keeps the battery save behind `saveUrl` (its GET/PUT address), or null. */
  const saveTargetFromUrl = (saveUrl) => {
    let u;
    try {
      u = new URL(String(saveUrl || ''), 'http://localhost');
    } catch {
      return null;
    }
    if (u.pathname === '/api/saves/solo' && u.searchParams.get('id')) {
      mkdirSync(SOLO_SAVES, { recursive: true });
      return { path: join(SOLO_SAVES, `${keyOf(u.searchParams.get('id'))}.sav`), runId: null };
    }
    const m = u.pathname.match(/^\/api\/runs\/([a-f0-9]{8})\/save\/(p[1-4])$/);
    if (m) {
      const p = defaultSavePath(readManifest(m[1]), m[2]);
      return p ? { path: p, runId: m[1] } : null;
    }
    return null;
  };
  /**
   * The save an import is for (POST /api/saves/import…): a solo game's (?id=<library id>) or a run player's
   * (?run=&slot=). → { system, gameId (the catalog id – a hack's: null, it gets the size check only), path (the battery
   * save), backupDir + key (where its backups go, by which name), archive() (3DS: the game's save folder, or null),
   * running() ('player': the fast / 3DS player has it open, 'emulator': an external one is open – a run's save is where
   * melonDS writes too –, false), runId, slot }
   */
  const importTarget = (url) => {
    const q = (k) => url.searchParams.get(k);
    const sessionOn = (s) => !!s && !s.exit;
    if (q('run')) {
      const runId = q('run');
      if (!/^[a-f0-9]{8}$/.test(runId)) throw httpError(400, 'Invalid run', 'badRequest');
      const manifest = readManifest(runId);
      if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
      const slot = q('slot');
      if (!slotsOf(manifest).includes(slot)) throw httpError(400, 'Invalid player', 'badPlayer');
      if (!manifest.outputs?.[slot]) throw httpError(409, 'The ROM for this player hasn’t been built yet', 'romNotBuilt');
      const system = manifest.game?.system;
      const hacked = !!(manifest.patch || manifest.game?.hackId || manifest.game?.hackName);
      const gameId = hacked ? null : manifest.game?.id || manifest.base?.gameId || null;
      const ctrKey = `run-${runId}-${slot}`;
      const path = system === '3ds' ? null : defaultSavePath(manifest, slot);
      if (system !== '3ds' && !path) throw httpError(409, 'No ROM for this player', 'noRomForPlayer');
      const titles = (catalog().games || []).find((g) => g.id === manifest.game?.id)?.titleIds || null;
      // (Play together: the library game's own save – its backups go where that game's always go)
      const lib = runMode(manifest) === 'together' ? manifest.outputs[slot].library : null;
      return {
        system, gameId, path, runId, slot, manifest, ...(lib ? { backupDir: join(SOLO_SAVES, 'backups'), key: keyOf(lib) } : { backupDir: join(runDir(runId), 'backups'), key: slot }),
        archive: () => (system === '3ds' ? ctrSaveArchives(join(saveDirFor(ctrKey), 'Azahar', 'sdmc', 'Nintendo 3DS'), titles)[0] || null : null),
        // the fast player / 3DS player on this save – or an external emulator, which writes the run's save next to its ROM
        running: () => (system === '3ds' ? (sessionOn(ctr.current) && sameFile(ctr.current.save, saveDirFor(ctrKey)) ? 'player' : false)
          : sessionOn(native.current) && !!native.current.saveFile && sameFile(native.current.saveFile.path, path) ? 'player' : emulatorRunning() ? 'emulator' : false),
      };
    }
    const id = q('id');
    if (!id || id.length > 2000) throw httpError(400, 'ID missing', 'idMissing');
    const [romId, patchId] = id.split('|');
    const lib = scanLibrary(loadConfig());
    const rom = lib.roms.find((r) => r.id === romId);
    if (!rom) throw httpError(404, 'Game not found in the library', 'romNotFound');
    const system = rom.system;
    const gameId = patchId || rom.hackId || rom.customHack ? null : rom.gameId || null;
    const key = keyOf(id);
    const path = join(SOLO_SAVES, `${key}.sav`);
    const titles = (catalog().games || []).find((g) => g.id === rom.gameId)?.titleIds || null;
    return {
      system, gameId, path, runId: null, slot: null, backupDir: join(SOLO_SAVES, 'backups'), key,
      archive: () => (system === '3ds' ? ctrSaveArchives(join(saveDirFor(id), 'Azahar', 'sdmc', 'Nintendo 3DS'), titles)[0] || null : null),
      running: () => ((system === '3ds' ? sessionOn(ctr.current) && sameFile(ctr.current.save, saveDirFor(id))
        : sessionOn(native.current) && !!native.current.saveFile && sameFile(native.current.saveFile.path, path)) ? 'player' : false),
    };
  };
  /** A 3DS backup's files from the request: a zip, JSON [{ path, data }] (a folder the page read) or `main` alone. */
  const ctrFilesOf = (body, url) => {
    const kind = url.searchParams.get('kind');
    if (kind === 'files') {
      let list;
      try {
        list = JSON.parse(body.toString('utf8'))?.files;
      } catch {
        list = null;
      }
      if (!Array.isArray(list)) throw httpError(400, 'Invalid save files', 'saveImportFormat', { detail: 'files' });
      return list.map((f) => ({ path: String(f?.path || ''), bytes: new Uint8Array(Buffer.from(String(f?.data || ''), 'base64')) }));
    }
    if (kind === 'zip') return readZipFiles(body, join(CACHE_DIR, 'tmp'));
    return [{ path: 'main', bytes: new Uint8Array(body) }];
  };
  /** Never under a running game: the player (the page closes it first) or an external emulator. */
  const refuseRunning = (t) => {
    const r = t.running();
    if (r === 'emulator') throw httpError(409, 'An emulator is still open – save in the game, close the emulator, then try again', 'emulatorRunning');
    if (r) throw httpError(409, 'The game is still running – close it first', 'saveGameRunning');
  };
  /** What the page may know of the step back: when, from which file, whether there was a save before. */
  const publicUndo = (u) => (u ? { at: u.at, name: u.name || null, hadSave: !!u.backup } : null);
  /**
   * After an import or its undo: a run notes it in run.json (`saveImports` – the trophies leave such a run's wins and
   * badges out, shared/trophies.mjs) and its save watch reads the new save; nothing else changes.
   */
  const afterSaveChange = (t, { import: at = null, undo = null }) => {
    if (!t.runId) return;
    const m = readManifest(t.runId);
    if (!m) return;
    const list = Array.isArray(m.saveImports?.[t.slot]) ? m.saveImports[t.slot] : [];
    if (at) list.push({ at });
    else if (undo && list.length) list[list.length - 1] = { ...list[list.length - 1], undone: undo };
    m.saveImports = { ...(m.saveImports && typeof m.saveImports === 'object' ? m.saveImports : {}), [t.slot]: list.slice(-50) };
    writeManifest(m);
    if (t.path && watcher.paths(t.runId)) watcher.read(t.runId, true);
  };
  const ctrToolsNow = () => ctrTools({ azaharApp: detectEmulator('azahar', loadConfig().emulatorPaths?.azahar).path || null });
  /** The file behind a ROM URL the page has (/api/library/rom?id=… or a run's /api/runs/<id>/file?name=…). */
  const romPathFromUrl = (src) => {
    let u;
    try {
      u = new URL(String(src || ''), 'http://localhost');
    } catch {
      throw httpError(400, 'Invalid game address', 'badRomUrl');
    }
    if (u.pathname === '/api/library/rom') {
      const { abs, entry } = resolveId(u.searchParams.get('id'), loadConfig());
      if (entry) throw httpError(400, 'Unpack the 3DS game from its archive into the library first', 'ctrInArchive');
      return abs;
    }
    const run = u.pathname.match(/^\/api\/runs\/([a-f0-9]{8})\/file$/);
    if (run) {
      const f = runPath(run[1], u.searchParams.get('name') || '');
      if (!f || !existsSync(f)) throw httpError(404, 'Game file not found', 'romNotFound');
      return f;
    }
    throw httpError(400, 'Invalid game address', 'badRomUrl');
  };
  // The native host opens the game from a file: a ROM inside an archive and a ROM patched on the fly are written to a
  // cache file first (the two newest stay – DS games are up to 512 MB). Plain library files and runs' games as they are.
  const nativeRomPath = (src) => {
    let u;
    try {
      u = new URL(String(src || ''), 'http://localhost');
    } catch {
      throw httpError(400, 'Invalid game address', 'badRomUrl');
    }
    if (u.pathname === '/api/library/patched') return preparePatchedRom(u.searchParams.get('romId'), u.searchParams.get('patchId'), () => {}, loadConfig()).path;
    if (u.pathname === '/api/library/rom') {
      const id = u.searchParams.get('id');
      const { abs, entry } = resolveId(id, loadConfig());
      if (!entry) return abs;
      const st = statSync(abs);
      const dir = join(CACHE_DIR, 'native-roms');
      const ext = (extname(entry).toLowerCase().match(/^\.[a-z0-9]{1,4}$/) || ['.bin'])[0];
      const file = join(dir, `${createHash('sha1').update(`${abs}\0${entry}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 20)}${ext}`);
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.part`;
        try {
          writeFileSync(tmp, loadFile(id, loadConfig()));
          renameSync(tmp, file);
        } finally {
          rmSync(tmp, { force: true });
        }
      } else {
        try {
          const now = new Date();
          utimesSync(file, now, now); // (used now: the tidying below goes by when a file was last played)
        } catch {
          // read-only – it is only the order of tidying
        }
      }
      try {
        const playing = native.current && !native.current.exit ? native.current.rom : null;
        const names = readdirSync(dir);
        // left over from an unpacking that never finished (a crash): gone after an hour
        for (const n of names.filter((x) => x.endsWith('.part'))) {
          if (Date.now() - statSync(join(dir, n)).mtimeMs > 3600000) rmSync(join(dir, n), { force: true });
        }
        const old = names.filter((n) => /^[0-9a-f]{20}\.[a-z0-9]{1,4}$/.test(n)).map((n) => ({ p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }))
          .filter((f) => f.p !== file && f.p !== playing).sort((a, b) => b.t - a.t).slice(1);
        for (const f of old) rmSync(f.p, { force: true });
      } catch {
        // tidying is best effort
      }
      return file;
    }
    return romPathFromUrl(src);
  };
  const nativeStatus = () => {
    const tl = nativeTools();
    const look = loadConfig().gbLook;
    // engine: the souldew engine (the link host as the fast player) is in this build – Settings › "souldew engine (beta)"
    return { ok: tl.ok, cores: Object.fromEntries(Object.entries(tl.cores || {}).map(([k, v]) => [k, !!v])), ids: Object.fromEntries(Object.keys(NATIVE_CORES).map((k) => [k, nativeCoreId(k, gbModel(k, look))])),
      engine: !!linkTool() };
  };
  // Azahar (3DS): polled once someone plays a 3DS game – the play view asks for its status, a launch starts it too
  let azahar = null;
  const azaharBridge = () => {
    if (!azahar) {
      let table = { games: [] };
      try {
        table = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'addresses.json'), 'utf8'));
      } catch {
        // no live data without the table
      }
      azahar = new AzaharBridge(emit, { table, emuPath: () => detectEmulator('azahar', loadConfig().emulatorPaths?.azahar).path || null });
      azahar.start();
    }
    return azahar;
  };
  // Stream overlays (web/overlay.html in OBS): per run, the open event streams with their language. A doc
  // upload or a renamed run pushes a fresh snapshot (shared/overlay.mjs) – only what an overlay may show.
  // An overlay that follows the current run (`/overlay?run=current`) sits in the map under the run it shows right now,
  // marked `follow`; followCheck() moves it along when another run becomes current ('' = no run at all).
  const overlayClients = new Map(); // runId → Map(res → { lang, w, preview, alerts, follow })
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
      const api = read('pokeapi.json');
      overlayNames = { names: api?.names || {}, items: api?.items || {}, tables: { gen4: GEN4, loc2: read('locations_gen2_crystal.json'), ...Object.fromEntries([3, 4, 5, 6, 7].map((g) => [`loc${g}`, read(`locations_gen${g}.json`)])) } };
    }
    const list = overlayNames.names[lang] || overlayNames.names.en || [];
    const items = overlayNames.items;
    return {
      lang, tables: overlayNames.tables, speciesName: (id) => list[id] || overlayNames.names.en?.[id] || `#${id}`,
      // the game's item ID → its name (Gen 3–5 tables; Gen 1/2 items have no table)
      itemName: (id, gen) => {
        const key = items[`gen${gen}`]?.[id];
        return key ? items.names?.[lang]?.[key] || items.names?.en?.[key] || null : null;
      },
      gameName: (id) => {
        const g = (catalog().games || []).find((x) => x.id === id);
        return g ? (lang === 'de' && g.titleDe) || g.title || null : null;
      },
    };
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
  /** The run "current" means (overlays that follow it, the stream API, Pokélink): the one open in the app, else the one
   *  played last – its doc changed last (shared/overlay.mjs currentRunId). */
  const currentRun = () => {
    const lastRun = loadConfig().lastRun;
    if (lastRun && /^[a-f0-9]{8}$/.test(lastRun) && readManifest(lastRun)) return lastRun;
    return currentRunId({ runs: listRuns().map((m) => {
      let playedAt = 0;
      try {
        playedAt = statSync(join(runDir(m.id), 'doc.json')).mtimeMs;
      } catch {}
      return { id: m.id, playedAt };
    }) });
  };
  const pokelinkRun = () => {
    const want = loadConfig().pokelink?.run;
    if (want && readManifest(want)) return want;
    return currentRun();
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
        pokelink.bridge = await startPokelinkBridge({ port, players: pokelinkList, access: () => ({ appPort: server.address()?.port, localPages: !!loadConfig().pokelink?.localPages }) });
      } catch (e) {
        pokelink.error = e.code === 'EADDRINUSE' ? 'portInUse' : 'failed';
      }
    }
  };
  const pokelinkState = () => {
    const c = loadConfig().pokelink || {};
    return { enabled: !!c.enabled, port: pokelink.bridge?.port || c.port || POKELINK_PORT, running: !!pokelink.bridge, error: pokelink.error, localPages: !!c.localPages,
      run: pokelink.bridge ? pokelink.run : c.run || null, pinned: c.run || null, clients: pokelink.bridge?.clients() || 0 };
  };
  const overlayLang = (v) => (['en', 'de', 'fr', 'es', 'it'].includes(String(v || '').slice(0, 2)) ? String(v).slice(0, 2) : 'en');
  const overlayData = (runId, lang) => {
    const manifest = readManifest(runId);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    const L = overlayLookups(lang);
    const snap = overlaySnapshot(manifest, readDoc(runId) || {}, L);
    // the coffee pop-up while it is on screen (server/lib/streamapi.mjs decides) – with its Pokémon's name
    const popup = streamHub?.popupFor(runId);
    if (popup) {
      snap.popup = popup;
      snap.species[popup.species] ??= L.speciesName(popup.species);
    }
    return snap;
  };
  // overlays that ask every few seconds instead of holding a stream (OBS with many sources): `${run}|${w}` → time
  const overlayPolls = new Map();
  const overlayListening = (runId) => {
    if (overlayClients.get(runId)?.size) return true;
    const now = Date.now();
    for (const [k, t] of overlayPolls) if (k.startsWith(`${runId}|`) && now - t < 15000) return true;
    return false;
  };
  let streamHub = null;
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
  // ---- overlays that follow the current run ----
  let followRun; // the run they show (undefined until someone follows; '' = none)
  const overlayAdd = (runId, res, c) => {
    if (!overlayClients.has(runId)) overlayClients.set(runId, new Map());
    overlayClients.get(runId).set(res, c);
  };
  const overlayFollowers = () => {
    for (const set of overlayClients.values()) for (const c of set.values()) if (c.follow) return true;
    return false;
  };
  const overlayNoRun = 'event: norun\ndata: {}\n\n';
  /** Has another run become current (a run opened in the app, a new one built or joined, the open one deleted)? Then
   *  every overlay that follows it switches at once – OBS keeps the same browser source – and so do the stream API's
   *  streams for `current` and the Pokélink bridge. */
  const followCheck = () => {
    const id = currentRun() || '';
    if (id === followRun) return id;
    followRun = id;
    const moving = [];
    for (const [runId, set] of overlayClients) {
      if (runId === id) continue;
      for (const [res, c] of set) if (c.follow) { set.delete(res); moving.push([res, c]); }
    }
    const byLang = new Map();
    for (const [res, c] of moving) {
      overlayAdd(id, res, c);
      try {
        if (!byLang.has(c.lang)) byLang.set(c.lang, id ? `event: snapshot\ndata: ${JSON.stringify(overlayData(id, c.lang))}\n\n` : overlayNoRun);
        res.write(byLang.get(c.lang));
      } catch {
        res.write(overlayNoRun);
      }
    }
    if (id) streamHub?.prime(id);
    streamHub?.follow(id || null); // streams already on this run stay as they are
    pokelink.bridge?.push();
    return id;
  };

  // The open stream API (/api/v1, docs/STREAM_API.md) and the coffee pop-up on legendary encounters
  streamHub = createStreamHub({
    readManifest, readDoc, listRuns, activeRun: currentRun, lookups: overlayLookups, loadConfig, saveConfig, docs: LINKS.streamApiDocs,
    overlayListening,
    serveSprite: (res, src, headers) => serveCached(res, join(CACHE_DIR, 'sprites', src.set, basename(src.path)),
      `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${src.path}`, headers),
    popupLayer: (runId) => {
      for (const c of overlayClients.get(runId)?.values() || []) if (c.w === 'popup' && !c.preview) return true;
      return Date.now() - (overlayPolls.get(`${runId}|popup`) || 0) < 15000;
    },
    onPopup: (runId) => pushOverlay(runId),
  });
  setInterval(() => {
    for (const res of sseClients) res.write(': ping\n\n');
    for (const set of overlayClients.values()) for (const res of set.keys()) res.write(': ping\n\n');
  }, 20000).unref();
  // the run played last can change without anything calling followCheck (no run open in the app): look now and then
  setInterval(() => {
    if (overlayFollowers() || streamHub.followers() || pokelink.bridge) followCheck();
  }, 2000).unref();

  for (const [runId, path] of Object.entries(loadConfig().watches || {})) {
    try {
      if (readManifest(runId)) watcher.watch(runId, path);
    } catch {
      // stale entry
    }
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---- souldew+ premium pack: the encrypted cache (server/lib/pluspack.mjs – never decrypted or run here) ----
  const plusPack = createPlusPack({ dir: join(DATA_DIR, DEV ? 'runs/.plus' : 'plus'), packaged, env, devDir: packaged ? '' : env.SLS_PLUS_DEV_PACK || '' });
  plusRoutes(route, plusPack, readBody);
  // souldew+ preview media: signed pictures of every premium item – for everyone, signed in or not
  const plusPreviews = createPlusPreviews({ dir: join(DATA_DIR, DEV ? 'runs/.plus' : 'plus'), packaged, env, devDir: packaged ? '' : env.SLS_PLUS_DEV_PACK || '' });
  route('GET', /^\/api\/plus\/previews$/, () => plusPreviews.state());
  // ---- souldew account (sign-in, profile, friends, presence, invites): server/lib/accounts/index.mjs ----------------
  // a pack key that changed or went away (tier dropped, key rotated, signed out) takes the encrypted pack cache with it
  const accounts = createAccounts({ secure: secureStore, port: () => server.address()?.port, emit, openExternal, focus, lang: () => loadConfig().lang || 'en', packaged, env,
    onPackKeyChange: () => { if (!plusPack.dev) plusPack.wipe(); } });
  routes.push(...accounts.routes);
  route('GET', /^\/api\/account\/diagnostics$/, () => accounts.diagnostics());

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
      ctr: (() => {
        const tl = ctrToolsNow();
        // renderer: what the next 3DS game starts with ("auto" may have stepped down for this graphics card)
        return { ok: tl.ok, missing: tl.missing || null, liveMemory: !!tl.souldewCore, renderer: ctrRendererNow(config).mode, scale: validScale(config.ctrScale) };
      })(),
      native: nativeStatus(),
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
        turboMax: config.turboMax === true,
        fullTurbo: config.fullTurbo !== false,
        nativeCore: config.nativeCore !== false,
        nativeEngine: config.nativeEngine === true,
        gbLook: GB_LOOKS.includes(config.gbLook) ? config.gbLook : 'original',
        pads: config.pads || null,
        gpuBackend: validBackend(config.gpuBackend, process.platform),
        gpuFallback: fallbackNotice(config.gpuFallback),
        nag: config.nag || null,
        nagOff: config.nagOff === true,
        padNav: config.padNav !== false,
        ctrRenderer: validRenderer(config.ctrRenderer),
        ctrScale: validScale(config.ctrScale),
        ctrFfHintOff: config.ctrFfHintOff === true,
        wholePixels: config.wholePixels === true,
        skin: validSkinId(config.skin),
        launchAnimation: cleanLaunchLook(config.launchAnimation),
        launchPace: cleanLaunchPace(config.launchPace),
        launchClear: cleanClearTint(config.launchClear),
        handheld: cleanHandheld(config.handheld),
        favourites: cleanFavourites(config.favourites),
        presence: config.presence !== false,
        // Settings › About "Check for updates automatically" – the desktop app's updater reads it (electron/updater.mjs)
        updateCheck: config.updateCheck !== false,
        // the "What's new" cards after an update to a new major version ('3.0'), until closed (server/lib/upgrade.mjs)
        whatsNew: typeof config.whatsNew === 'string' ? config.whatsNew : null,
        uiScale: validUiScale(config.uiScale),
        uiScaleHint: config.uiScaleHint === true,
      },
      // the backup made before the first start of this major version (Settings › About) – or why there is none
      upgradeBackup: backupInfo(config.upgradeBackups?.[majorOf(liveRuns.souldewVersion())]),
      plusDev: plusPack.dev,
    };
  });

  route('POST', /^\/api\/config$/, async (req) => {
    const body = await readBody(req);
    const allowed = {};
    // No path-like keys here: emulatorPaths decides which program /launch runs, libraryFolders which folders are
    // scanned (set via /api/library/folders). Neither may be writable by a plain config POST.
    for (const k of ['lang', 'onboarded', 'playerName', 'emulatorFor', 'lastRun', 'bootAnimation', 'sounds', 'shareScreen', 'shortcuts', 'controls', 'theme', 'pads', 'speedGuard', 'turboMax', 'fullTurbo', 'nativeCore', 'nativeEngine', 'gbLook', 'gpuBackend', 'gpuFallback', 'nag', 'nagOff', 'padNav', 'ctrRenderer', 'ctrScale', 'wholePixels', 'skin', 'launchAnimation', 'launchPace', 'launchClear', 'handheld', 'favourites', 'presence', 'updateCheck', 'whatsNew', 'uiScale', 'uiScaleHint', 'ctrFfHintOff']) {
      if (k in body) allowed[k] = body[k];
    }
    // the "What's new" cards: the page can only close them (the server opens them, server/lib/upgrade.mjs)
    if ('whatsNew' in allowed && allowed.whatsNew !== null) delete allowed.whatsNew;
    // the interface size (shared/uiscale.mjs; electron/main.mjs reads it for the window) and its one-time hint on a big screen
    if ('uiScale' in allowed) allowed.uiScale = validUiScale(allowed.uiScale);
    if ('uiScaleHint' in allowed) allowed.uiScaleHint = allowed.uiScaleHint === true;
    // the 3DS renderer (server/lib/ctrrenderer.mjs): a new choice forgets what "auto" learned – it starts afresh
    if ('ctrRenderer' in allowed) {
      allowed.ctrRenderer = validRenderer(allowed.ctrRenderer);
      allowed.ctrRendererMemo = {};
    }
    // the 3DS resolution (1×–3×, server/lib/ctrrenderer.mjs CTR_SCALES): applies to the next 3DS game
    if ('ctrScale' in allowed) allowed.ctrScale = validScale(allowed.ctrScale);
    // the play view's hint that the 3DS resolution holds back fast-forward (web/lib/ffhint.mjs): "Don't show again"
    if ('ctrFfHintOff' in allowed) allowed.ctrFfHintOff = allowed.ctrFfHintOff === true;
    // the joke license window (web/lib/nag.mjs): launch count + when it last showed, and its off switch
    if ('nagOff' in allowed) allowed.nagOff = allowed.nagOff === true;
    if ('wholePixels' in allowed) allowed.wholePixels = allowed.wholePixels === true;
    // souldew+ look (web/lib/cosmetics): an id from the catalog – whether the account owns it is the page's business
    // (the pack is only there when it does); the config just must not hold anything but an id
    if ('skin' in allowed) allowed.skin = validSkinId(allowed.skin);
    // the launch animation (shared/handheld.mjs): a family id (an older id – the 2.x cartridge, an earlier souldew+
    // animation – becomes "Your colours"), Full / Quick / Off, the Clear shell's colour
    if ('launchAnimation' in allowed) allowed.launchAnimation = cleanLaunchLook(allowed.launchAnimation);
    if ('launchPace' in allowed) allowed.launchPace = cleanLaunchPace(allowed.launchPace);
    if ('launchClear' in allowed) allowed.launchClear = cleanClearTint(allowed.launchClear);
    // "Your handheld" (a local setting nobody else sees): its shape only – known ids, ≤ 8 stickers per device, ≤ 12 designs,
    // numbers clamped, ≤ 32 KB. What the account owns is the page's business (the launch plays owned items only).
    if ('handheld' in allowed) allowed.handheld = cleanHandheld(allowed.handheld);
    // the starred cosmetics (shared/favourites.mjs): ids per kind only – what they are is the catalog's business
    if ('favourites' in allowed) allowed.favourites = cleanFavourites(allowed.favourites);
    if ('nag' in allowed) {
      const n = allowed.nag;
      if (!n || typeof n !== 'object' || Array.isArray(n)) delete allowed.nag;
      else {
        allowed.nag = {
          launches: Number.isInteger(n.launches) && n.launches >= 0 ? Math.min(n.launches, 1e6) : 0,
          lastShown: Number.isFinite(n.lastShown) && n.lastShown > 0 ? n.lastShown : null,
        };
      }
    }
    // shape checks for the newer keys – the page validates too, but the config file shouldn't hold junk
    if ('theme' in allowed && !['classic', 'contrast', 'deutan', 'tritan'].includes(allowed.theme)) delete allowed.theme;
    if ('speedGuard' in allowed) allowed.speedGuard = allowed.speedGuard === true;
    if ('turboMax' in allowed) allowed.turboMax = allowed.turboMax === true;
    if ('fullTurbo' in allowed) allowed.fullTurbo = allowed.fullTurbo !== false; // on unless switched off
    if ('nativeCore' in allowed) allowed.nativeCore = allowed.nativeCore !== false; // the fast player: on unless switched off
    if ('nativeEngine' in allowed) allowed.nativeEngine = allowed.nativeEngine === true; // the souldew engine (beta): off unless switched on
    if ('gbLook' in allowed && !GB_LOOKS.includes(allowed.gbLook)) delete allowed.gbLook; // Game Boy games: original / GBC colours
    if ('padNav' in allowed) allowed.padNav = allowed.padNav !== false; // controller navigation (web/lib/padnav.mjs): on unless switched off
    if ('presence' in allowed) allowed.presence = allowed.presence !== false; // the anonymous "playing now" count: on unless switched off
    if ('updateCheck' in allowed) allowed.updateCheck = allowed.updateCheck !== false; // the automatic update check: on unless switched off
    // the graphics backend electron/main.mjs applies at the next start; the fallback notice can only be dismissed
    if ('gpuBackend' in allowed) {
      if (gpuBackends(process.platform).includes(allowed.gpuBackend)) allowed.gpuStart = null; // a new choice starts counting afresh
      else delete allowed.gpuBackend;
    }
    if ('gpuFallback' in allowed && allowed.gpuFallback !== null) delete allowed.gpuFallback;
    if ('pads' in allowed) {
      const p = allowed.pads;
      const ok = p === null || (typeof p === 'object' && !Array.isArray(p) && (!p.preset || ['nintendo', 'xbox'].includes(p.preset))
        && (!p.map || (typeof p.map === 'object' && Object.entries(p.map).length <= 16 && Object.values(p.map).every((v) => typeof v === 'string' && /^[A-Z_0-9]{1,24}$/.test(v))))
        // device: the controller chosen in Settings (the id the browser reports for it, web/lib/controls.mjs pickPad)
        && (p.device == null || (typeof p.device === 'string' && p.device.length <= 200 && !/[\u0000-\u001f]/.test(p.device))));
      if (!ok) delete allowed.pads;
      else if (p) {
        allowed.pads = { ...(p.preset ? { preset: p.preset } : {}), ...(p.map ? { map: Object.fromEntries(Object.entries(p.map).filter(([k]) => PAD_MAP_IDS.has(k))) } : {}),
          ...(p.device ? { device: p.device.trim() } : {}) };
      }
    }
    const saved = saveConfig(allowed);
    if (allowed.presence === false) playingNow.stop().catch(() => {}); // switched off: the bot forgets this game right away
    if ('lastRun' in allowed) followCheck(); // another run opened in the app: the overlays that follow it switch
    return saved;
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
  // Paths from the page only from approved places (library.mjs approvedImportPath): "Search my Mac / PC"'s folders,
  // the library's folders, and files / folders picked in the native dialog this session (electron/main.mjs).
  // A zipped 3DS game is unpacked into the library (library.mjs unpackZipGames) – the page shows its progress from the
  // "unpack" events.
  const onUnpack = (p) => emit('unpack', p);
  route('POST', /^\/api\/library\/import$/, async (req) => {
    const { paths } = await readBody(req);
    // (skipped: files souldew can't take – a .7z / .rar archive – the page says so instead of "0 files added")
    const skipped = [];
    return { added: await importFiles(paths || [], loadConfig(), { onUnpack, skipped }), skipped };
  });
  // a zipped 3DS game in a library folder (scanLibrary().zipped): unpacked into the library folder, the zip stays
  route('POST', /^\/api\/library\/unpack$/, async (req) => {
    const { id } = await readBody(req);
    return { added: await unpackLibraryZip(id, loadConfig(), { onUnpack }) };
  });
  // "This is a ROM hack…": what an already-patched ROM is, by its CRC32 (library.mjs setRomHack; {} = undo)
  route('POST', /^\/api\/library\/romhack$/, async (req) => {
    const body = await readBody(req);
    const romHacks = setRomHack(loadConfig().romHacks, body);
    saveConfig({ romHacks });
    return { romHacks };
  });
  // a 3DS game's update taken off it (library.mjs removeCtrUpdate): souldew's copy deleted, or the player's own file marked
  route('POST', /^\/api\/library\/ctr-update\/remove$/, async (req) => {
    const { id } = await readBody(req);
    const { deleted, ctrUpdatesDetached } = removeCtrUpdate(id, loadConfig());
    saveConfig({ ctrUpdatesDetached });
    return { removed: true, deleted };
  });
  // Search this Mac / PC for ROMs (the usual folders) – the import below then copies the ones the player picked.
  route('POST', /^\/api\/library\/discover$/, () => discoverRoms({ known: scanLibrary(loadConfig()).roms }));
  route('POST', /^\/api\/library\/upload$/, async (req, m, url) => {
    // name checked first (a wrong file type is refused before its bytes are read), then streamed to disk:
    // a 512 MB DS ROM must not be held in memory twice
    const name = url.searchParams.get('name') || 'rom.bin';
    const target = uploadTarget(name);
    const limit = uploadLimitFor(target);
    const free = freeBytes(dirname(target));
    const len = Number(req.headers['content-length']);
    if (free !== null && Number.isFinite(len) && len <= limit && len > free - 64 * 1024 * 1024) {
      throw httpError(507, `Not enough free disk space for ${basename(target)}`, 'diskFull', { name: basename(target), need: `${(len / 1024 ** 3).toFixed(1)} GB`, free: `${(free / 1024 ** 3).toFixed(1)} GB` });
    }
    if (extname(target).toLowerCase() !== '.zip') {
      await streamToFile(req, target, limit);
      return { added: [target] };
    }
    // a zip: to a hidden file first (the scan skips it) – a 3DS game in it is unpacked, the zip itself not kept
    const tmp = join(dirname(target), `.upload-${process.pid}-${randomBytes(4).toString('hex')}.zip`);
    await streamToFile(req, tmp, limit);
    return { added: await placeUploadedZip(tmp, target, { onUnpack }) };
  });
  // The player's own picture for an entry without a cover (id: game:<id> | hack:<id> | rom:<CRC32>, covers.mjs).
  // GET is served below, next to the other file responses.
  route('PUT', /^\/api\/library\/cover$/, async (req, m, url) => {
    const id = url.searchParams.get('id');
    let bytes;
    try {
      bytes = await readRaw(req, COVER_LIMIT);
    } catch (e) {
      throw e.status === 413 ? httpError(413, 'Picture too large (4 MB at most)', 'coverTooLarge') : e;
    }
    const f = saveCover(id, bytes);
    return { id, url: coverUrl(id, f.mtimeMs) };
  });
  route('DELETE', /^\/api\/library\/cover$/, (req, m, url) => ({ removed: deleteCover(url.searchParams.get('id')) }));
  route('POST', /^\/api\/library\/folders$/, async (req) => {
    const { add, remove } = await readBody(req);
    const cfg = loadConfig();
    let folders = new Set(cfg.libraryFolders || []);
    if (add) folders.add(approvedFolder(add, cfg)); // picked in the native dialog this session (library.mjs)
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
    if (!url.searchParams.get('id')) throw httpError(400, 'ID missing', 'idMissing'); // would all land in one shared "null" save
    mkdirSync(SOLO_SAVES, { recursive: true });
    const bytes = await readRaw(req, 4 * 1024 * 1024);
    if (!bytes.length) throw httpError(400, 'Empty save file – not saved', 'emptySave');
    writeFileAtomic(join(SOLO_SAVES, `${keyOf(url.searchParams.get('id'))}.sav`), bytes);
    return { ok: true, size: bytes.length };
  });

  // The ROM's own data for the play view (server/lib/romloc.mjs): the place sign's names and map → location step, and
  // for GBA games which Pokémon the species numbers stand for. `src` is the same /api/… URL the emulator loads (a run's
  // file, a library ROM – zipped ones unpacked –, or a patched ROM). { data: null } = no location data for this game.
  // The scan runs in a worker thread (server/lib/romloc.mjs): a big ROM takes seconds the first time, and every other
  // request is answered meanwhile – the play view fills in what depends on it once it arrives.
  route('GET', /^\/api\/rom\/locations$/, (req, m, url) => {
    const src = new URL(url.searchParams.get('src') || '', 'http://local');
    const env = { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR };
    const run = src.pathname.match(/^\/api\/runs\/([a-f0-9]{8})\/file$/);
    if (run) {
      const file = runPath(run[1], src.searchParams.get('name') || '');
      if (!file) throw httpError(400, 'bad name', 'badRequest');
      return romDataFor({ file }, env);
    }
    if (src.pathname === '/api/library/rom') {
      const id = src.searchParams.get('id');
      const config = loadConfig();
      const { abs, entry } = resolveId(id, config);
      // (an entry inside a .zip is unpacked in the worker too)
      return entry ? romDataFor({ lib: { id, config } }, env) : romDataFor({ file: abs }, env);
    }
    if (src.pathname === '/api/library/patched') {
      // (patched in the worker too – a hack's detail view never patches or hashes a ROM on this thread)
      return romDataFor({ patched: { romId: src.searchParams.get('romId'), patchId: src.searchParams.get('patchId'), config: loadConfig() } }, env);
    }
    throw httpError(400, 'bad src', 'badRequest');
  });

  // ---- ROM inspection & run building ----------------------------------------------
  route('POST', /^\/api\/rom\/inspect$/, async (req) => {
    const { romId, patchId } = await readBody(req);
    const log = [];
    const patched = preparePatchedRom(romId, patchId || null, (l) => log.push(l), loadConfig());
    let info = null;
    if (patched.system === '3ds') {
      // a cut-off copy can't be randomized or played (server/lib/ctrcheck.mjs)
      if (ctrFileReport(patched.path).integrity?.state === 'damaged') throw httpError(409, 'This 3DS game file is incomplete', 'ctrIncomplete');
      // UPR ZX randomizes X/Y, ORAS, Sun/Moon and USUM (decrypted dumps only – server/lib/ctrrando.mjs); the generation
      // for the rest of the form comes from the catalog when UPR can't read the game
      const game = (catalog().games || []).find((g) => g.system === '3ds' && (g.serial === patched.header?.code || g.productCode === patched.header?.code || (g.titleIds || []).includes(patched.header?.titleId)));
      info = await inspectCtr(patched.path, patched.header, runBridge);
      if (info.unsupported && missingToolNow()) info.missingTool = missingToolNow();
      // outputSize: what one randomized game will take (its NCCH – a cartridge image is padded to 2/4 GB)
      return { patched: { crc: null, baseCrc: null, size: patched.size, outputSize: ncchSizeOf(patched.path), header: patched.header, patchName: null, system: '3ds' },
        info: { generation: game?.generation || null, ...info }, shiny: { ok: false, reason: 'game' }, log };
    }
    // (missingTool: the game may be fine – Java or the randomizer is what's missing, the UI says so instead of "this
    // game can't be randomized"; the generation picks the trial run's values)
    info = await inspectRom(patched.path, { gen: matchCatalog({ crc: patched.crc, ...patched.header }, catalog())?.game?.generation || null });
    // another shiny rate: Gen 3–5 originals whose shiny check is where it should be (server/lib/shiny.mjs)
    const shiny = shinySupport(patched.path, { original: isOriginalRom(patched, patchId) });
    return { patched: { crc: patched.crc, baseCrc: patched.baseCrc, size: patched.size, header: patched.header, patchName: patched.patchName, system: patched.system }, info, shiny, log };
  });

  const building = new Set(); // run ids with a build in progress
  // A build's log and progress while it runs (a 3DS game takes minutes): the page sends its own `progressId` with the
  // build and polls GET /api/runs/progress/<id>. Kept a minute after the build ended.
  const buildProgress = new Map();
  route('GET', /^\/api\/runs\/progress\/([a-z0-9]{8,32})$/, (req, m) => {
    const p = buildProgress.get(m[1]);
    return p ? { log: p.log, progress: p.progress, done: p.done } : { log: [], progress: null, done: false };
  });
  route('POST', /^\/api\/runs\/build$/, async (req) => {
    const body = await readBody(req);
    const log = [];
    const progressId = typeof body.progressId === 'string' && /^[a-z0-9]{8,32}$/.test(body.progressId) ? body.progressId : null;
    const track = { log, progress: null, done: false };
    if (progressId) {
      if (buildProgress.size > 20) buildProgress.delete(buildProgress.keys().next().value); // (only pages of this computer – a small bound anyway)
      buildProgress.set(progressId, track);
    }
    let identity = null;
    if (body.runId) {
      const m = readManifest(body.runId);
      if (!m) throw httpError(404, 'Run not found', 'runNotFound');
      identity = { id: m.id, room: m.room, secret: m.secret };
      // Two builds of the same run would write the same ROM files at the same time.
      if (building.has(m.id)) throw httpError(409, 'This run is being built right now', 'runBuilding');
      building.add(m.id);
    }
    try {
      if (body.runId) discordWebhookFor(body.runId); // moves a legacy webhook out of the rules before they are rewritten
      let manifest = await buildRun({ ...body, identity, config: loadConfig() }, (l) => log.push(l), (p) => (track.progress = p));
      // "Start from my intro save": the player on this computer (introSlot) begins with the intro save of the game –
      // only theirs, and only while they have no save in this run yet
      // (never in Play together: the slot's save is the player's own game – an intro save would replace its progress)
      if (body.introSave === true && ALL_SLOTS.includes(body.introSlot) && runMode(manifest) !== 'together') {
        const started = applyIntroSave(manifest.id, body.introSlot, { savePath: defaultSavePath });
        if (started) {
          manifest = started;
          log.push(logLine('introApplied', 'Your game starts from your intro save'));
        }
      }
      adoptLegacyWebhook(manifest.id, body.rules?.discordWebhook); // older clients still send it inside the rules
      saveConfig({ lastRun: manifest.id });
      followCheck();
      return { manifest, log };
    } finally {
      if (identity) building.delete(identity.id);
      track.done = true;
      if (progressId) setTimeout(() => buildProgress.get(progressId) === track && buildProgress.delete(progressId), 60000).unref?.();
    }
  });

  route('POST', /^\/api\/runs\/import$/, async (req) => {
    const { pack } = await readBody(req);
    // The pack comes from another computer (file, clipboard, code invite): bad input is the sender's, a 400 with a code.
    // (a format of a later version: say to update – shared/runpack.mjs)
    const format = packFormatState(pack);
    if (format === 'newer') {
      const version = packMinVersion(pack);
      if (version) throw httpError(400, `This run needs souldew ${version} or newer – update souldew to join it`, 'packNewer', { version });
      throw httpError(400, 'This run needs a newer souldew – update souldew to join it', 'packNewerAny');
    }
    if (format !== 'ok') throw httpError(400, 'Not a valid run pack', 'packInvalid');
    if (typeof pack.id !== 'string' || !/^[a-f0-9]{8}$/.test(pack.id)) throw httpError(400, 'The run pack is damaged (id)', 'packBroken', { what: 'id' });
    const checked = checkPack(pack);
    const existing = readManifest(pack.id);
    // A pack must never replace a run this computer created itself (its room/secret, rules and builds).
    if (existing && !existing.imported) throw httpError(409, 'This run was created on this computer and can’t be replaced by a run pack', 'runIsLocal');
    const manifest = {
      ...(existing || {}),
      id: pack.id, ...checked, updatedAt: new Date().toISOString(),
      base: pack.base, patch: pack.patch, randomizer: pack.randomizer, rules: stripLocalRules(pack.rules ?? null), game: pack.game || null,
      expectedOutputs: pack.outputs, outputs: existing?.outputs || {}, imported: true,
    };
    writeManifest(manifest);
    saveConfig({ lastRun: manifest.id });
    followCheck();
    return manifest;
  });

  route('GET', /^\/api\/runs\/([a-f0-9]{8})$/, (req, m) => {
    if (readManifest(m[1])) discordWebhookFor(m[1]); // one-time migration out of the shared rules
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    const defaultSaves = Object.fromEntries(slotsOf(manifest).map((s) => [s, defaultSavePath(manifest, s)]));
    return { ...manifest, pack: runPack(manifest), watch: watchStatus(m[1], manifest), defaultSaves };
  });

  // Delete = move the run folder to runs/.trash (recoverable by hand), forget watches / lastRun.
  route('DELETE', /^\/api\/runs\/([a-f0-9]{8})$/, (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run not found', 'runNotFound');
    if (building.has(m[1])) throw httpError(409, 'This run is being built right now', 'runBuilding');
    watcher.unwatch(m[1]);
    const trash = trashRun(m[1]);
    const cfg = loadConfig();
    const watches = { ...(cfg.watches || {}) };
    delete watches[m[1]];
    saveConfig({ watches, ...(cfg.lastRun === m[1] ? { lastRun: null } : {}) });
    followCheck();
    return { ok: true, trash };
  });

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/meta$/, async (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    const body = await readBody(req);
    // (the host's computer keeps its signed rules – they change through POST …/rules)
    if (body.rules && typeof body.rules === 'object' && !Array.isArray(body.rules) && !(isHostComputer(manifest) && manifest.hostKey)) {
      discordWebhookFor(m[1]); // migrate a legacy webhook first, so it isn't lost
      adoptLegacyWebhook(m[1], body.rules.discordWebhook);
      manifest.rules = stripLocalRules(body.rules);
    }
    // a run joined before 2.8.2: the host's key as their app announced it in the doc (shared/hostrules.mjs) – taken
    // once, never replaced (a key that came with the invite stays too)
    if (manifest.imported && !manifest.hostKey && isHostKey(body.hostKey) && runMode(manifest) === 'soullink') {
      manifest.hostKey = body.hostKey;
      manifest.host = slotsOf(manifest).includes(body.host) ? body.host : 'p1';
    }
    if (body.name) manifest.name = String(body.name).slice(0, 80);
    if (body.players) manifest.players = renamePlayers(manifest, body.players);
    writeManifest(manifest);
    pushOverlay(m[1]);
    return manifest;
  });

  // The host changes a SoulLink's rules (shared/hostrules.mjs): signed here with the run's key, which only the computer
  // that created the run has – any other computer gets a 403. body: { rules, after: the newest doc timestamp the app
  // has seen, me: the slot that plays on this computer (a run from before 2.8.2 names its host by it) } → the signed
  // value for the doc's `rules`, written at its `rev`.
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/rules$/, async (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    const body = await readBody(req);
    const rules = body.rules;
    if (!rules || typeof rules !== 'object' || Array.isArray(rules) || JSON.stringify(rules).length > 4000) throw httpError(400, 'Invalid rules', 'badRules');
    discordWebhookFor(m[1]); // a legacy webhook in the rules moves into the local config first
    adoptLegacyWebhook(m[1], rules.discordWebhook);
    const signed = signRules(manifest, stripLocalRules(unsigned(rules)), { after: Number(body.after) || 0, mySlot: body.me });
    writeManifest(manifest);
    pushOverlay(m[1]);
    return { rules: signed, host: manifest.host, hostKey: manifest.hostKey };
  });

  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/data\/(p[1-4])$/, (req, m) => {
    const p = join(runDir(m[1]), `${m[2]}.data.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  });
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/log\/(p[1-4])$/, (req, m) => {
    const name = readManifest(m[1])?.outputs?.[m[2]]?.log;
    const p = name ? runPath(m[1], name) : null;
    return p && existsSync(p) ? readFileSync(p, 'utf8') : '';
  });
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/doc$/, (req, m) => readDoc(m[1]));
  // what a stream overlay shows of the run (no keys, paths or spoilers) – the event stream below pushes it live
  // `current` instead of an ID: the run being played (a link that keeps working across runs)
  route('GET', /^\/api\/runs\/(current|[a-f0-9]{8})\/overlay$/, (req, m, url) => {
    const runId = m[1] === 'current' ? followCheck() : m[1];
    if (!runId) throw httpError(404, 'Run not found', 'runNotFound');
    if (url.searchParams.get('preview') !== '1') {
      overlayPolls.set(`${runId}|${String(url.searchParams.get('w') || 'team').slice(0, 12)}`, Date.now());
      streamHub.prime(runId);
    }
    return overlayData(runId, overlayLang(url.searchParams.get('lang')));
  });
  // Stream page: the open API's address and token, the coffee pop-up's switch and corner
  const streamState = (port) => {
    const s = streamSettings(loadConfig());
    return { ...s, base: `http://127.0.0.1:${port}/api/v1`, docs: LINKS.streamApiDocs, clients: streamHub.clients(), current: currentRun() };
  };
  route('GET', /^\/api\/stream$/, () => streamState(server.address()?.port));
  route('POST', /^\/api\/stream$/, async (req) => {
    const body = await readBody(req);
    const cur = loadConfig().stream || {};
    const next = { ...cur };
    if (typeof body.coffee === 'boolean') next.coffee = body.coffee;
    if (COFFEE_CORNERS.includes(body.corner)) next.corner = body.corner;
    if (body.token === 'new') next.token = randomBytes(18).toString('base64url');
    else if (body.token === '') next.token = '';
    if (typeof body.localPages === 'boolean') next.localPages = body.localPages; // pages from disk / localhost without the token
    saveConfig({ stream: next });
    return streamState(server.address()?.port);
  });
  // "Preview pop-up": a sample coffee pop-up in every overlay of the run (OBS too) and to the API's clients
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/coffee\/preview$/, (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run not found', 'runNotFound');
    const popup = streamHub.previewCoffee(m[1]);
    const lang = overlayLang(loadConfig().lang);
    let n = 0;
    for (const c of overlayClients.get(m[1])?.values() || []) if (!c.preview && (c.w === 'popup' || (c.alerts && !popup.layer))) n++;
    return { ok: true, popup, name: overlayLookups(lang).speciesName(popup.species), overlays: n };
  });
  // "Send a test alert" in the app's Stream page: every open overlay of the run shows a sample (in OBS too)
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/overlay\/test$/, async (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run not found', 'runNotFound');
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
      // themes served by another local web server (localhost on any port) – off unless switched on (pokelink.mjs)
      localPages: typeof body.localPages === 'boolean' ? body.localPages : !!c.localPages,
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
    streamHub.prime(m[1]); // the state before this upload – the stream API's events are the difference
    writeFileAtomic(p, JSON.stringify(mergeDocEntries(readDoc(m[1]), body)));
    rmSync(p + '.tmp', { force: true }); // left behind by older versions
    streamHub.docChanged(m[1]);
    pushOverlay(m[1]);
    return { ok: true };
  });

  // Run save file: written by the integrated emulator, read back when playing again.
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/save\/(p[1-4])$/, (req, m) => {
    const p = defaultSavePath(readManifest(m[1]), m[2]);
    if (!p || !existsSync(p)) throw httpError(404, 'No save file yet', 'noSaveYet');
    return readFileSync(p);
  });
  route('PUT', /^\/api\/runs\/([a-f0-9]{8})\/save\/(p[1-4])$/, async (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    const p = defaultSavePath(manifest, m[2]);
    if (!p) throw httpError(409, 'No ROM for this player', 'noRomForPlayer');
    const bytes = await readRaw(req, 4 * 1024 * 1024);
    if (!bytes.length) throw httpError(400, 'Empty save file – not saved', 'emptySave');
    writeFileAtomic(p, bytes);
    // (games whose saves can't be read aren't watched – that would only produce error toasts)
    watchRunSave(m[1], manifest, p);
    return { ok: true, size: bytes.length };
  });

  // ---- intro saves (server/lib/introsave.mjs): a save after the intro that new attempts of the game start from ----
  route('GET', /^\/api\/intro-saves$/, () => ({ saves: listIntroSaves().map(publicIntro) }));
  // the one kept for a run's game (?run=<id>) or for a library ROM + patch the new-run wizard picked (?romId=&patchId=)
  route('GET', /^\/api\/intro-saves\/for$/, (req, m, url) => {
    const runId = url.searchParams.get('run');
    let key = null;
    if (runId) {
      const manifest = readManifest(runId);
      if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
      key = introKeyFor(manifest);
    } else {
      const lib = scanLibrary(loadConfig());
      const rom = lib.roms.find((r) => r.id === url.searchParams.get('romId'));
      const patchId = url.searchParams.get('patchId');
      const patch = patchId ? lib.patches.find((p) => p.id === patchId) : null;
      if (!rom || (patchId && !patch)) return { intro: null };
      key = introKeyForLibrary(rom, patch);
    }
    return { intro: publicIntro(introFor(key)) };
  });
  route('DELETE', /^\/api\/intro-saves\/([a-f0-9]{16})$/, (req, m) => ({ removed: removeIntroSave(m[1]) }));
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/intro\/(p[1-4])$/, (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    return introState(manifest, m[2], { savePath: defaultSavePath });
  });
  // keep this player's current battery save (3DS: save folder) as the intro save of the run's game
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/intro\/(p[1-4])$/, (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    if (!slotsOf(manifest).includes(m[2])) throw httpError(400, 'Invalid player', 'badPlayer');
    return { intro: publicIntro(keepIntroSave(manifest, m[2], { savePath: defaultSavePath })) };
  });

  // ---- importing a battery save (server/lib/saveimport.mjs): a .sav from elsewhere, the replaced one backed up first --
  //   POST /api/saves/import/check?<target>   body: the file → what it is, whether it fits the game, what it replaces
  //   POST /api/saves/import?<target>&confirm=1&name=   body: the file → written (the old one backed up)
  //   POST /api/saves/import/undo?<target>     the replaced save goes back (once)
  //   GET  /api/saves/import/last?<target>     the step back that is kept, or null
  // <target>: id=<library id> (a solo game) or run=<id>&slot=p1…p4. A 3DS game: kind=zip|files|main (a Checkpoint /
  // JKSM backup – zipped, its files as JSON [{ path, data (base64) }], or the `main` file alone).
  route('POST', /^\/api\/saves\/import\/check$/, async (req, m, url) => {
    const t = importTarget(url);
    const body = await readRaw(req, IMPORT_LIMIT);
    if (t.system === '3ds') {
      const res = checkCtrImport(ctrFilesOf(body, url), { archive: t.archive(), gameId: t.gameId });
      return { system: '3ds', files: res.files.length, family: res.family, check: { verdict: res.verdict, found: res.family, want: res.want }, missing: res.missing.slice(0, 20),
        current: { exists: !!t.archive() }, running: t.running(), undo: publicUndo(lastImport(t.backupDir, t.key)) };
    }
    const { bytes } = unzipSingleSave(body, join(CACHE_DIR, 'tmp'));
    const res = checkImport(new Uint8Array(bytes), { system: t.system, gameId: t.gameId });
    let current = { exists: false };
    try {
      const st = statSync(t.path);
      current = { exists: st.size > 0, size: st.size, at: Math.round(st.mtimeMs) };
    } catch {
      // no save yet
    }
    return { system: t.system, size: res.size, from: res.from, notes: res.notes, check: res.check, current, running: t.running(), undo: publicUndo(lastImport(t.backupDir, t.key)) };
  });
  route('POST', /^\/api\/saves\/import$/, async (req, m, url) => {
    const t = importTarget(url);
    // a run's save is a big change: the page asks first, and says so here (a request without it changes nothing)
    if (t.runId && url.searchParams.get('confirm') !== '1') throw httpError(400, 'Importing a save into a run needs a confirmation', 'saveImportConfirm');
    refuseRunning(t);
    const body = await readRaw(req, IMPORT_LIMIT);
    const name = String(url.searchParams.get('name') || '').slice(0, 120) || null;
    let result;
    if (t.system === '3ds') {
      const res = checkCtrImport(ctrFilesOf(body, url), { archive: t.archive(), gameId: t.gameId });
      result = { ...replaceCtrSave({ archive: t.archive(), files: res.files, backupDir: t.backupDir, key: t.key }), check: { verdict: res.verdict, found: res.family, want: res.want } };
    } else {
      const { bytes, name: inner } = unzipSingleSave(body, join(CACHE_DIR, 'tmp'));
      const res = checkImport(new Uint8Array(bytes), { system: t.system, gameId: t.gameId });
      result = { ...replaceSave({ path: t.path, bytes: res.bytes, backupDir: t.backupDir, key: t.key, name: inner || name }), size: res.size, notes: res.notes, check: res.check };
    }
    console.log(`[saves] imported ${t.system} save${t.runId ? ` into run ${t.runId} ${t.slot}` : ''} (${result.check?.verdict || '?'}${result.replaced || result.backup ? ', old one backed up' : ''})`);
    afterSaveChange(t, { import: result.at });
    return result;
  });
  route('POST', /^\/api\/saves\/import\/undo$/, async (req, m, url) => {
    const t = importTarget(url);
    refuseRunning(t);
    const r = t.system === '3ds' ? undoCtrImport({ archive: t.archive(), backupDir: t.backupDir, key: t.key }) : undoImport({ path: t.path, backupDir: t.backupDir, key: t.key });
    console.log(`[saves] import undone${t.runId ? ` in run ${t.runId} ${t.slot}` : ''}`);
    afterSaveChange(t, { undo: Date.now() });
    return r;
  });
  route('GET', /^\/api\/saves\/import\/last$/, (req, m, url) => {
    const t = importTarget(url);
    let hasSave = false;
    try {
      hasSave = t.system === '3ds' ? !!t.archive() : statSync(t.path).size > 0;
    } catch {
      // none yet
    }
    return { undo: publicUndo(lastImport(t.backupDir, t.key)), running: t.running(), hasSave };
  });

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/watch$/, async (req, m) => {
    const { path } = await readBody(req);
    if (path && typeof path !== 'string') throw httpError(400, 'Invalid path', 'badPath');
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
  // what is watched for the run's save, for the play view of an external emulator ("souldew reads p1.sav – 14:32")
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/watch$/, (req, m) => {
    const manifest = readManifest(m[1]);
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    return watchStatus(m[1], manifest);
  });
  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/rescan$/, (req, m) => watcher.read(m[1], true) || watcher.last(m[1]));
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/save-parsed$/, (req, m) => watcher.last(m[1]));

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/graveyard$/, async (req, m) => {
    const { keys } = await readBody(req);
    const status = watcher.status(m[1]);
    if (!status.watching || !existsSync(status.path)) throw httpError(500, 'No watched save file for this run.', 'noWatchedSave');
    if (emulatorRunning()) throw httpError(409, 'The external emulator is still running. Save in the game, close the emulator, then try again.', 'emulatorRunning');
    const original = readFileSync(status.path);
    let result;
    try {
      result = moveToGraveyard(new Uint8Array(original), keys || []);
    } catch (e) {
      throw e.code ? httpError(409, e.message, e.code, e.vars) : e; // the save can't be edited (shared/gen4save.mjs saveError)
    }
    const { file, moved, box } = result;
    if (!moved.length) return { moved: [] };
    const check = parseHgssSave(file, GEN4);
    const ok = moved.every((k) => check.boxes.some((b) => b.key === k && b.checksumOk) && !check.party.some((p) => p.key === k));
    if (!ok) throw httpError(500, 'The check after editing failed – the save file was not changed.', 'graveyardCheckFailed');
    const backupDir = join(runDir(m[1]), 'backups');
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(backupDir, `${stamp}.sav`), original);
    writeFileSync(status.path, file);
    return { moved, box: box + 1, backup: `backups/${stamp}.sav`, save: watcher.read(m[1], true) };
  });

  route('POST', /^\/api\/runs\/([a-f0-9]{8})\/reveal$/, async (req, m) => {
    const { file } = await readBody(req);
    const target = file ? runPath(m[1], String(file)) : runDir(m[1]);
    if (!target || !existsSync(target)) throw httpError(500, 'File not found', 'fileNotFound');
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
      if (!ALL_SLOTS.includes(slot)) throw httpError(400, 'Invalid player', 'badPlayer');
      const manifest = readManifest(runId);
      const out = manifest?.outputs?.[slot];
      if (!out) throw httpError(409, 'The ROM for this player hasn’t been built yet', 'romNotBuilt');
      // Play together plays the library game's own save (shared/playtogether.mjs): an outside emulator would write a
      // second one next to the run's copy of the ROM – play it in souldew, or from the library
      if (runMode(manifest) === 'together') throw httpError(409, 'Play together runs in souldew’s own player – your game’s save stays one', 'togetherBuiltIn');
      romPath = typeof out.rom === 'string' && out.rom ? runPath(runId, out.rom) : null;
      if (!romPath) throw httpError(409, 'The ROM for this player hasn’t been built yet', 'romNotBuilt');
      // melonDS writes "<ROM name>.sav" next to the ROM – or into the save folder set in its own settings
      const sav = defaultSavePath(manifest, slot);
      const more = m[1] === 'melonds' && sav ? melonSaveDirs(melonConfigFiles({ exePath: detectEmulator('melonds', loadConfig().emulatorPaths?.melonds).path || null })).map((d) => join(d, basename(sav))) : [];
      watchRunSave(runId, manifest, sav, { more, replace: true });
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
    if (m[1] === 'azahar') azaharBridge();
    return launchRom(m[1], romPath, { customPath: loadConfig().emulatorPaths?.[m[1]], script });
  });

  // ---- trophies: Pokédex, achievements, medals across every run (server/lib/trophies.mjs) ----
  route('GET', /^\/api\/trophies$/, () => syncTrophies());
  // the page hands in which slot it plays per run, species seen in live battles and live moments (1 HP, badges …)
  route('POST', /^\/api\/trophies\/sync$/, async (req) => {
    const body = await readBody(req);
    return syncTrophies({ slots: body?.slots, seen: body?.seen, moments: body?.moments });
  });

  route('GET', /^\/api\/live$/, () => live.status());
  // Azahar's RPC server: what it reports, and switching it on in Azahar's settings (only on request – it is reachable
  // from the local network while Azahar runs, see server/lib/azahar.mjs)
  route('GET', /^\/api\/live\/azahar$/, () => azaharBridge().status());
  // ---- 3DS in the built-in player ------------------------------------------------------------------------------
  route('GET', /^\/api\/ctr\/status$/, () => ({ tools: ctrToolsNow(), session: ctr.status() }));
  // "Save diagnostics": the graphics card, how the last 3DS / fast-player game ended and what its host wrote last
  // "Save diagnostics": the Java check – every candidate's path (home shortened), how it ended, its first lines (#40)
  route('GET', /^\/api\/diagnostics\/java$/, () => javaDiagnostics());
  route('GET', /^\/api\/diagnostics\/players$/, () => JSON.parse(redactHome(JSON.stringify({ ctr: { tools: ctrToolsNow(), inventory: ctrInventory(), ...ctr.diagnostics() }, native: native.diagnostics() }))));
  route('POST', /^\/api\/ctr\/start$/, async (req) => {
    const { rom, key, scale } = await readBody(req);
    const tools = ctrToolsNow();
    if (!tools.ok) throw httpError(409, 'The 3DS part of souldew is missing', 'ctrMissing');
    if (typeof key !== 'string' || !key || key.length > 600) throw httpError(400, 'Invalid save key', 'badKey');
    const romPath = romPathFromUrl(rom);
    // what the file is (size, header, its own hashes – server/lib/ctrcheck.mjs): checked before the game starts, and
    // kept for "Save diagnostics"
    const file = ctrFileReport(romPath);
    // an encrypted cartridge dump: Azahar's core plays decrypted games only – say so instead of "couldn't load the game"
    if (file.encrypted || (file.encrypted == null && ctrEncrypted(romPath))) throw httpError(409, 'This 3DS game file is encrypted', 'ctrEncrypted');
    // a copy that was cut off (souldew closed while copying, a download that stopped): the header is there, the game
    // isn't – it would start to a black screen (ticket #19)
    if (file.integrity?.state === 'damaged') {
      ctr.last = { at: new Date().toISOString(), error: 'game file incomplete', file };
      throw httpError(409, 'This 3DS game file is incomplete', 'ctrIncomplete');
    }
    const cfg = loadConfig();
    const { mode, auto } = ctrRendererNow(cfg);
    // the resolution: Settings › Emulators › "3DS resolution" unless the page asks for one (tests, diagnostics)
    const sc = scaleFor(Number.isInteger(scale) ? scale : cfg.ctrScale, mode);
    // the game's update (server/lib/ctrupdate.mjs): the one the library has for it goes onto this save folder's SD card,
    // where the core finds it – a randomized run's game never gets it (the update's code would undo the randomization)
    ctr.stop(); // (the game that runs now may play from the same save folder)
    const update = file.kind === 'game' ? await ctrUpdateFor(rom, file.titleId, key) : null;
    const id = ctr.start({ rom: romPath, key, tools, scale: sc, renderer: mode, auto, file: update ? { ...file, update } : file });
    return { id, liveMemory: tools.souldewCore, renderer: mode, auto, scale: sc, update };
  });
  /** The update a 3DS game starts with (prepareUpdate): from the library – none for a randomized run's game. */
  const ctrUpdateFor = async (rom, titleId, key) => {
    let randomized = false;
    try {
      const run = new URL(String(rom || ''), 'http://localhost').pathname.match(/^\/api\/runs\/([a-f0-9]{8})\/file$/);
      randomized = !!(run && readManifest(run[1])?.randomizer?.enabled);
    } catch {
      // (romPathFromUrl accepted it already)
    }
    const lib = scanLibrary(loadConfig());
    const keep = [];
    for (const u of lib.ctrUpdates || []) {
      try {
        keep.push(updateStamp(u.file));
      } catch {
        // gone meanwhile
      }
    }
    return prepareUpdate({ saveDir: saveDirFor(key), gameTid: titleId, update: pickUpdate(lib.ctrUpdates, titleId), randomized, keep });
  };
  // the game's own saves changed? (a fingerprint – see saveStamp)
  route('GET', /^\/api\/ctr\/savestamp$/, (req, m, url) => ({ stamp: saveStamp(ctr.get(url.searchParams.get('id')).save) }));
  route('POST', /^\/api\/ctr\/stop$/, async (req) => {
    const { id } = await readBody(req);
    if (ctr.current?.id === id) ctr.stop();
    return { ok: true };
  });
  // ---- DS / GBA / GB in the fast native player (server/lib/native.mjs) -------------------------------------------
  route('GET', /^\/api\/native\/status$/, () => ({ tools: nativeStatus(), session: native.status() }));
  route('POST', /^\/api\/native\/start$/, async (req) => {
    const { rom, key, system, save, saveUrl, state, model: asked } = await readBody(req);
    if (typeof key !== 'string' || !key || key.length > 600) throw httpError(400, 'Invalid save key', 'badKey');
    if (!Object.hasOwn(NATIVE_CORES, system)) throw httpError(400, 'The fast player doesn’t play this system', 'nativeSystem');
    const b64ok = (v, maxBytes) => typeof v === 'string' && v.length <= Math.ceil(maxBytes / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(v);
    if (save != null && !b64ok(save, MAX_SAVE)) throw httpError(400, 'Invalid save file', 'badSave');
    // (state: the save state to go on from – the player's own console as a link session left it, docs/MULTIPLAYER.md)
    if (state != null && !b64ok(state, MAX_STATE)) throw httpError(400, 'Invalid save state', 'badSave');
    const tools = nativeTools();
    // the souldew engine (beta): the link host plays the game (the same states and protocol); else retrohost and its core
    const engine = loadConfig().nativeEngine === true && ENGINE_SYSTEMS.includes(system) ? linkTool() : null;
    if (!engine && !tools.cores?.[system]) throw httpError(409, 'The fast player is missing for this system', 'nativeMissing');
    // a Game Boy game's console: Settings › "Game Boy look" – or the one a state to go on from was made on
    const model = system === 'gb' && (asked === 'dmg' || asked === 'cgb') ? asked : gbModel(system, loadConfig().gbLook);
    const id = await native.startNative({ rom: nativeRomPath(rom), key, system, tools, save: save ? Buffer.from(save, 'base64') : null, saveFile: saveTargetFromUrl(saveUrl),
      state: state ? Buffer.from(state, 'base64') : null, model, engine });
    return { id, core: nativeCoreId(system, model), model, engine: !!engine };
  });
  // the engine's link session is over: its game goes on alone in the same process (no state travels, no new player)
  route('POST', /^\/api\/native\/unlink$/, async (req) => {
    const { id } = await readBody(req);
    // (only with the engine switched on – a link host started from the board otherwise hands over to retrohost as before)
    const r = typeof id === 'string' && loadConfig().nativeEngine === true ? await native.unlink(id) : null;
    if (!r) throw httpError(409, 'This game has no link session', 'noNativeSession');
    return r;
  });
  // ---- link sessions: trades and battles between the players of a run (docs/MULTIPLAYER.md) -----------------------
  // Every seat's game must be a file on this computer (server/lib/linkroms.mjs: the run's builds, a file the player
  // picked, or the library – ROMs never travel), byte-identical to the one its player plays: by SHA-1, never by name.
  const linkDeps = (manifest) => {
    const dir = runDir(manifest.id);
    const lib = scanLibrary(loadConfig());
    return {
      runFile: runPath, dir,
      libraryRoms: lib.roms.filter((r) => sameLinkSystem(r.system, manifest.game?.system)),
      extract: (rom) => { // (named with the entry's CRC: an existing file is that game already)
        const target = extractTarget(dir, rom);
        if (!existsSync(target)) writeFileAtomic(target, Buffer.from(loadFile(rom.id, loadConfig())));
        return target;
      },
      lib,
    };
  };
  const linkManifest = (runId) => {
    const manifest = readManifest(String(runId || ''));
    if (!manifest) throw httpError(404, 'Run not found', 'runNotFound');
    return manifest;
  };
  // the run's peer connections: STUN + short-lived TURN credentials from souldew's bot (server/lib/linkice.mjs)
  route('GET', /^\/api\/link\/ice$/, () => linkIceServers());
  route('GET', /^\/api\/link\/check$/, (req, m, url) => {
    const manifest = linkManifest(url.searchParams.get('runId'));
    const system = manifest.game?.system || null;
    const slots = Object.fromEntries(slotsOf(manifest).map((s) => {
      const r = ownSeat(manifest, s, runPath);
      return [s, { rom: !!r.path, sha1: r.sha1, crc: r.crc }];
    }));
    // model: this player's console for a Game Boy game that boots for the link (Settings › "Game Boy look")
    return { tool: !!linkTool(), system, supported: !linkUnavailable(manifest.game), game: manifest.game?.id || null, slots,
      randomized: needsIdenticalRom(manifest), model: gbModel(system, loadConfig().gbLook) };
  });
  // Which seats' games are here: { seats: { slot: { ok, how } }, missing: [{ slot, canBuild }] }. `seats`: { slot:
  // { sha1, crc } } as each player announced their own.
  route('POST', /^\/api\/link\/resolve$/, async (req) => {
    const { runId, seats } = await readBody(req);
    const manifest = linkManifest(runId);
    if (!seats || typeof seats !== 'object') throw httpError(400, 'Invalid seats', 'linkSeats');
    const runSlots = slotsOf(manifest);
    const deps = linkDeps(manifest);
    const out = {};
    const missing = [];
    for (const [slot, v] of Object.entries(seats)) {
      if (!runSlots.includes(slot)) throw httpError(400, 'Invalid seats', 'linkSeats');
      const r = resolveSeat(manifest, slot, v?.sha1, v?.crc, deps);
      out[slot] = { ok: !!r, how: r?.how || null };
      if (!r) missing.push({ slot, canBuild: needsIdenticalRom(manifest) && !!(baseRomsFor(manifest, deps.lib.roms).length) });
    }
    return { seats: out, missing };
  });
  // "Pick your copy of FireRed": a library ROM for a partner's seat – taken only when its SHA-1 is the partner's.
  route('POST', /^\/api\/link\/pick$/, async (req) => {
    const { runId, slot, sha1, romId } = await readBody(req);
    const manifest = linkManifest(runId);
    if (!slotsOf(manifest).includes(slot)) throw httpError(400, 'Invalid seat', 'linkSeats');
    const deps = linkDeps(manifest);
    const rom = deps.lib.roms.find((r) => r.id === romId);
    if (!rom) throw httpError(404, 'File not found', 'noFile');
    const p = pickSeat(rom, sha1, { dir: deps.dir, extract: deps.extract });
    if (!p) throw httpError(409, 'Das ist eine andere Fassung des Spiels', 'linkPickDiffers', { slot });
    return { ok: true };
  });
  // "Build Tim's game": a randomized / patched run joined before every player's game was built here – that slot only,
  // from the run's own base ROM, patch, settings and seed.
  route('POST', /^\/api\/link\/build$/, async (req) => {
    const { runId, slot } = await readBody(req);
    const manifest = linkManifest(runId);
    if (!slotsOf(manifest).includes(slot)) throw httpError(400, 'Invalid seat', 'linkSeats');
    let body;
    try {
      body = partnerBuildRequest(manifest, slot, scanLibrary(loadConfig()));
    } catch (e) {
      if (e.code !== 'no-rom' && e.code !== 'no-patch') throw e;
      throw httpError(409, 'The base game of this run is missing from the library', e.code === 'no-patch' ? 'linkBuildNoPatch' : 'linkBuildNoRom');
    }
    if (building.has(manifest.id)) throw httpError(409, 'Dieser Run wird gerade gebaut', 'runBuilding');
    building.add(manifest.id);
    try {
      const log = [];
      const built = await buildRun({ ...body, identity: { id: manifest.id, room: manifest.room, secret: manifest.secret }, config: loadConfig() }, (l) => log.push(l));
      return { ok: true, sha1: built.outputs?.[slot]?.sha1 || null, log };
    } finally {
      building.delete(manifest.id);
    }
  });
  route('POST', /^\/api\/link\/start$/, async (req) => {
    const { runId, local, seats, delay, rtc, state } = await readBody(req);
    const manifest = linkManifest(runId);
    const system = manifest.game?.system;
    if (!LINK_SYSTEMS.includes(system)) throw httpError(400, 'Linking isn’t available for this system yet', 'linkSystem');
    // (a ROM hack whose link was never checked – Pokémon Quetzal: shared/link.mjs linkUnavailable)
    if (linkUnavailable(manifest.game) === 'hack') throw httpError(400, 'Linking isn’t available for this ROM hack', 'linkHack');
    const runSlots = slotsOf(manifest);
    if (!Array.isArray(seats) || seats.length < 2 || seats.length > MAX_LINK_SEATS) throw httpError(400, 'Invalid seats', 'linkSeats');
    if (new Set(seats.map((s) => s?.slot)).size !== seats.length || !seats.every((s) => runSlots.includes(s?.slot))) throw httpError(400, 'Invalid seats', 'linkSeats');
    const localIndex = seats.findIndex((s) => s.slot === local);
    if (localIndex < 0) throw httpError(400, 'Invalid seat', 'linkSeats');
    const deps = linkDeps(manifest);
    const out = seats.map((s, i) => {
      const r = resolveSeat(manifest, s.slot, s.sha1, s.crc, deps);
      if (!r) throw httpError(409, 'This player’s game is missing here', 'linkRomMissing', { slot: s.slot });
      let save = null;
      if (i === localIndex) { // our own save: from disk, never from the page
        const p = defaultSavePath(manifest, s.slot);
        save = p && existsSync(p) ? readFileSync(p) : null;
      } else if (typeof s.save === 'string' && s.save) save = Buffer.from(s.save, 'base64');
      // (a rejoin starts from the session's state – the saves are inside it; the local one is still checked)
      if (save && typeof s.saveSha1 === 'string' && s.saveSha1 && createHash('sha1').update(save).digest('hex') !== s.saveSha1.toLowerCase()) {
        throw httpError(409, 'The save file is damaged', 'linkSaveDiffers', { slot: s.slot });
      }
      // the player's running game (docs/MULTIPLAYER.md › "Seamless"): the fast player's save state, deflated – every
      // peer starts that seat from exactly these bytes (checked by SHA-1), not from the battery save
      let st = null;
      if (typeof s.state === 'string' && s.state) {
        try {
          st = inflateRawSync(Buffer.from(s.state, 'base64'), { maxOutputLength: MAX_STATE });
        } catch {
          throw httpError(409, 'The save state is damaged', 'linkStateDiffers', { slot: s.slot });
        }
        if (typeof s.stateSha1 !== 'string' || createHash('sha1').update(st).digest('hex') !== s.stateSha1.toLowerCase()) throw httpError(409, 'The save state is damaged', 'linkStateDiffers', { slot: s.slot });
      }
      // a Game Boy seat's console, as its player announced it (every peer gets the same list – gbModel's values)
      // (the seat's own announcement first: in a Blue ↔ Yellow session the peers' own games differ, the list must not)
      const model = system === 'gb' || system === 'gbc' ? (s.model === 'cgb' || s.model === 'dmg' ? s.model : system === 'gbc' ? 'cgb' : 'dmg') : null;
      return { rom: r.path, save, state: st, model };
    });
    let stateBytes = null;
    if (typeof state === 'string' && state) {
      stateBytes = Buffer.from(state, 'base64');
      if (stateBytes.length > MAX_STATE) throw httpError(413, 'The save state is too large', 'saveTooLarge');
    }
    const savePath = defaultSavePath(manifest, local);
    // the save as it was before the session: what a session that falls out of step goes back to (/api/link/restore).
    // Read before the session starts – and a rejoin (the session's state given) keeps the one its session began with:
    // the save on disk holds the session's own in-game saves by then
    const earlier = stateBytes && savePath ? [native.current, native.lastLink].find((c) => c?.link && c.preLinkFor && sameFile(c.preLinkFor, savePath)) : null;
    const preLink = stateBytes ? earlier?.preLink || null : savePath && existsSync(savePath) ? readFileSync(savePath) : null;
    const id = await native.startLink({
      host: linkTool(), system, seats: out, local: localIndex, delay, rtc, key: `${manifest.id}:${local}`, state: stateBytes,
      saveFile: savePath ? { path: savePath, runId: manifest.id } : null,
    });
    Object.assign(native.current, { preLink, preLinkFor: savePath || null });
    return { id, system, local: localIndex, seats: seats.length };
  });
  // A session that fell out of step: the run's save goes back to what it was before the session (both players do it,
  // so nobody keeps a Pokémon the other didn't lose); the session's last save stays next to it as a backup.
  route('POST', /^\/api\/link\/restore$/, async (req) => {
    const { runId, id, slot } = await readBody(req);
    const manifest = linkManifest(runId);
    const p = slotsOf(manifest).includes(slot) ? defaultSavePath(manifest, slot) : null;
    if (!p) throw httpError(400, 'Invalid seat', 'linkSeats'); // (checked before the session is stopped)
    // (only the save the session played: another run's or player's never gets this session's earlier save)
    const own = native.current?.id === id ? native.current : native.lastLink?.id === id ? native.lastLink : null;
    if (own && own.preLinkFor && !sameFile(own.preLinkFor, p)) throw httpError(400, 'Invalid seat', 'linkSeats');
    const sess = native.linkRestore(id);
    if (!sess) throw httpError(404, 'No link session', 'noNativeSession');
    let backup = null;
    if (existsSync(p)) {
      backup = `${p.replace(/\.[^./\\]+$/, '')}.link-${new Date().toISOString().replace(/[:.]/g, '-')}.sav`;
      writeFileAtomic(backup, readFileSync(p));
    }
    const restored = !!sess.preLink;
    if (sess.preLink) writeFileAtomic(p, sess.preLink);
    sess.preLink = null; // (done: the save isn't kept in memory any longer)
    return { ok: true, restored, backup: backup ? basename(backup) : null };
  });
  route('POST', /^\/api\/native\/stop$/, async (req) => {
    const { id } = await readBody(req);
    if (native.current?.id === id) native.stop();
    return { ok: true };
  });
  route('POST', /^\/api\/live\/azahar\/enable$/, async (req) => {
    const body = await readBody(req);
    if (body?.confirm !== true) throw httpError(400, 'Please confirm first', 'confirmMissing');
    enableRpc({ emuPath: detectEmulator('azahar', loadConfig().emulatorPaths?.azahar).path || null });
    return azaharBridge().status();
  });
  // The mGBA script lives in a hidden folder on Windows (%APPDATA%) – show it instead of making people type the path.
  // the backup from before this major version (Settings › About): its folder, as the config names it – no path from the page
  route('POST', /^\/api\/backup\/reveal$/, () => {
    const b = loadConfig().upgradeBackups?.[majorOf(liveRuns.souldewVersion())];
    const dir = b?.name && /^pre-[\w.-]+$/.test(b.name) ? join(DATA_DIR, 'backups', b.name) : null;
    if (!dir || !existsSync(dir)) throw httpError(404, 'The backup folder is gone', 'backupGone');
    revealInFileManager(dir);
    return { ok: true };
  });
  route('POST', /^\/api\/live\/reveal$/, () => {
    if (!existsSync(live.luaScriptPath())) throw httpError(404, 'The mGBA script is missing', 'scriptMissing');
    revealInFileManager(live.luaScriptPath());
    return { ok: true };
  });

  // ---- Discord webhook: local to this computer (config.discordWebhooks[runId]), never in the shared rules ----
  route('GET', /^\/api\/runs\/([a-f0-9]{8})\/discord$/, (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run not found', 'runNotFound');
    return { webhook: discordWebhookFor(m[1]) };
  });
  route('PUT', /^\/api\/runs\/([a-f0-9]{8})\/discord$/, async (req, m) => {
    if (!readManifest(m[1])) throw httpError(404, 'Run not found', 'runNotFound');
    discordWebhookFor(m[1]); // finish a pending migration so it can't overwrite this later
    const { webhook } = await readBody(req);
    const hook = typeof webhook === 'string' ? webhook.trim() : '';
    if (hook && !isDiscordWebhook(hook)) throw httpError(400, 'Invalid Discord webhook URL', 'badWebhook');
    saveConfig({ discordWebhooks: { ...(loadConfig().discordWebhooks || {}), [m[1]]: hook } });
    return { webhook: hook };
  });
  route('POST', /^\/api\/notify\/discord$/, async (req) => {
    const { runId, content } = await readBody(req);
    if (typeof runId !== 'string' || !/^[a-f0-9]{8}$/.test(runId)) throw httpError(400, 'Invalid run', 'badRun');
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
    if (!r.ok) throw httpError(502, `Discord answered ${r.status}`, 'discordFailed', { status: r.status });
    return { ok: true };
  });

  // ---- "Playing now" (server/lib/presence.mjs): the page reports a running game every minute, the server sends the
  // anonymous heartbeat (only with the setting on) – { system, mode } while playing, { playing: false } when it closed
  route('POST', /^\/api\/presence$/, async (req) => {
    const body = await readBody(req);
    return body?.playing === false ? { sent: await playingNow.stop() } : playingNow.beat(body);
  });

  // ---- "Share to Discord" (Live runs, server/lib/liveruns.mjs): the token stays here, the page gets the outcome ----
  route('GET', /^\/api\/liveruns$/, (req, m, url) => (url.searchParams.get('check') === '1' ? liveRuns.status() : liveRuns.publicState()));
  route('POST', /^\/api\/liveruns\/link$/, async (req) => {
    const { code } = await readBody(req);
    return liveRuns.link(typeof code === 'string' ? code : '');
  });
  route('DELETE', /^\/api\/liveruns\/link$/, () => liveRuns.unlink());
  route('POST', /^\/api\/liveruns\/post$/, async (req) => {
    const { meta, image } = await readBody(req);
    return liveRuns.post({ meta, image });
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

  async function serveCached(res, file, url, headers = {}) {
    if (!existsSync(file)) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(String(r.status));
        mkdirSync(dirname(file), { recursive: true });
        writeFileAtomic(file, Buffer.from(await r.arrayBuffer()));
      } catch {
        return send(res, 404, 'not available', headers);
      }
    }
    serveFile(res, file, { 'Cache-Control': 'public, max-age=31536000, immutable', ...headers });
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
      return send(res, 400, { error: 'Invalid URL', code: 'badRequest' });
    }
    try {
      // the open stream API has its own rules (localhost pages or the token, CORS, read-only): server/lib/streamapi.mjs
      if ((path === '/api/v1' || path.startsWith('/api/v1/')) && await streamHub.handle(req, res, path, url)) return;
      if (path.startsWith('/api/')) {
        // Origin / Sec-Fetch-Site / x-soullink checks (server/lib/guard.mjs) – before any API route, SSE included – and,
        // in the desktop app, the window's per-launch secret for the account and souldew+ routes.
        const denied = apiRequestError(req, server.address()?.port) || privateRequestError(req, path) || rendererSecretError(req, path, rendererSecret);
        if (denied) return send(res, 403, { error: denied });
      }
      const overlayEvents = path.match(/^\/api\/runs\/(current|[a-f0-9]{8})\/overlay\/events$/);
      if (overlayEvents && req.method === 'GET') {
        const lang = overlayLang(url.searchParams.get('lang'));
        // `current` follows the run being played: no run yet → the stream opens anyway and says so (event: norun)
        const follow = overlayEvents[1] === 'current';
        const runId = follow ? followCheck() : overlayEvents[1];
        const first = runId ? overlayData(runId, lang) : null; // unknown run → 404 before the stream opens
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`retry: 2000\n\n${first ? `event: snapshot\ndata: ${JSON.stringify(first)}\n\n` : overlayNoRun}`);
        const w = String(url.searchParams.get('w') || 'team').slice(0, 12);
        overlayAdd(runId, res, { lang, w, preview: url.searchParams.get('preview') === '1', alerts: w === 'alerts' || url.searchParams.get('alerts') === '1', follow });
        // a follower may have moved to another run's list since
        res.on('close', () => { for (const set of overlayClients.values()) set.delete(res); });
        if (runId) streamHub.prime(runId);
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
          const file = runPath(download[1], name);
          if (!file) return send(res, 400, { error: 'bad name', code: 'badRequest' });
          return serveFile(res, file, url.searchParams.get('inline') ? {} : { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }, req.method === 'HEAD');
        }
        // (awaited: a rejection must reach the catch below – an un-awaited one is an unhandled rejection, which leaves the
        // request without an answer in the app and ends the server of the browser build)
        if (path === '/api/account/avatar') return await accounts.avatar(req, res, url);
        if (path === '/api/plus/previews/file' && req.method === 'GET') return await servePreview(plusPreviews, res, url);
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
          if (!f) return send(res, 404, { error: 'No picture of your own yet', code: 'noCover' });
          // the url carries the file's time (?v=…) – a new picture gets a new url, so this one may be cached
          return serveFile(res, f.path, { 'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff',
            'Cache-Control': url.searchParams.get('v') ? 'private, max-age=31536000, immutable' : 'no-cache' });
        }
        // 3DS: the host's messages to the player page, and the page's commands to the host (binary)
        if (path === '/api/ctr/stream' && req.method === 'GET') return ctr.attach(url.searchParams.get('id'), res);
        if (path === '/api/ctr/cmd' && req.method === 'POST') {
          ctr.send(url.searchParams.get('id'), await readRaw(req, 300 * 1024 * 1024));
          return send(res, 200, { ok: true });
        }
        // 3DS music from the ROM (web/lib/rommusic.mjs): the game's music streams (found once per ROM in the ROM data
        // worker, cached), and bytes of its RomFS straight from the file – only for the game file of that session
        if (path === '/api/ctr/music' && req.method === 'GET') {
          const rom = ctr.romOf(url.searchParams.get('id'));
          const r = rom ? await romDataFor({ file: rom }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR }) : null;
          return send(res, 200, { music: r?.music || null });
        }
        if (path === '/api/ctr/romfs' && req.method === 'GET') {
          const rom = ctr.romOf(url.searchParams.get('id'));
          const r = rom ? await romDataFor({ file: rom }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR }) : null;
          const off = Number(url.searchParams.get('off'));
          const len = Number(url.searchParams.get('len'));
          if (!r?.music || !Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len <= 0 || len > 64 * 1024 * 1024) throw httpError(400, 'bad range', 'badRequest');
          return send(res, 200, readRange(rom, r.music.base + off, len));
        }
        // DS / GBA / GB native host: the same two binary channels
        if (path === '/api/native/stream' && req.method === 'GET') return native.attach(url.searchParams.get('id'), res);
        if (path === '/api/native/cmd' && req.method === 'POST') {
          native.send(url.searchParams.get('id'), await readRaw(req, 80 * 1024 * 1024));
          return send(res, 200, { ok: true });
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
        return send(res, 404, { error: 'Unknown API endpoint', code: 'badRequest' });
      }
      const sprite = path.match(/^\/sprites\/([a-z0-9]+)\/(\d{1,5})\.(png|gif)$/); // (10001+: PokeAPI's forms)
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
      // the system browser's way back after "Sign in with Discord" (a navigation from the accounts service, not the app)
      if (path === '/auth/done') return await accounts.authDone(req, res, url);
      if (VENDOR[path]) return serveFile(res, VENDOR[path]);
      if (path === '/live/soullink.lua') {
        // embeds the live bridge token – PRIVATE_GETS (app header or same-origin), not a typed URL / other program
        const denied = apiRequestError(req, server.address()?.port) || privateRequestError(req, path);
        if (denied) return send(res, 403, { error: denied });
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
      // (the account's routes carry user / invite ids: logged without them – and their errors are expected answers)
      if (path.startsWith('/api/account')) {
        if (!e.status || e.status >= 500) console.error(`[${req.method} /api/account/…]`, e.code || e.name);
      } else console.error(`[${req.method} ${path}]`, e.message);
      if (e.details?.stderr) console.error(String(e.details.stderr).slice(-4000));
      if (res.headersSent) return res.destroy();
      return send(res, e.status || 500, errorBody(e));
    }
  });

  // The players' host streams as WebSockets (#38: an endless HTTP response filled C:\Windows\Temp through antivirus
  // HTTP scanning): the same checks as the API (this computer's Host, the app's own Origin – a browser always sends one
  // for a WebSocket), then the session takes the socket as it took the response.
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return refuse(socket, 400);
    }
    const sessions = url.pathname === '/api/ctr/stream' ? ctr : url.pathname === '/api/native/stream' ? native : null;
    if (!sessions) return refuse(socket, 404);
    if (!hostAllowed(req.headers.host) || !req.headers.origin || apiRequestError(req, server.address()?.port)) return refuse(socket, 403);
    const id = url.searchParams.get('id');
    try {
      sessions.get(id);
    } catch {
      return refuse(socket, 404);
    }
    const ws = acceptStream(req, socket);
    if (ws) sessions.attachStream(id, ws);
  });
  server.on('close', () => {
    accounts.close();
    ctr.stop();
    azahar?.stop();
    streamHub.close();
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
        // what an interrupted copy / unpack / upload left in the library folder (souldew closed meanwhile)
        setTimeout(() => removeStaleParts(), 2000).unref?.();
      }
      if (!deferAccount) setTimeout(() => accounts.loadSession(), 0).unref?.();
      // goOffline: the desktop app awaits it (bounded) before it quits – friends see the player go offline at once
      resolvePromise({ server, port: actual, url: `http://localhost:${actual}`, goOffline: () => accounts.goOffline(), loadAccount: () => accounts.loadSession() });
    });
  });
}

/** What config.pads.map may bind (web/lib/controls.mjs): the game buttons (BUTTONS) and the controller shortcuts
 *  (PAD_HOTKEY_IDS – fast-forward hold/toggle, turbo, pause). test/server-fixes.test.mjs keeps the two lists equal. */
export const PAD_MAP_IDS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select', 'sneak', 'ffHold', 'ffToggle', 'turbo', 'pause']);

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
  console.warn(`run ${runId}: doc.json unreadable – kept as a copy`);
  try {
    renameSync(p, `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  } catch {
    // read-only – still answer
  }
  return null;
}

/**
 * The battery save next to a run's ROM ("<ROM name>.sav"), or null: no ROM yet, a game without battery saves (3DS
 * saves live in the player's own folder – the ROM itself must never be served or overwritten as its "save"), or a
 * name in run.json that would leave the run's folder.
 */
export function defaultSavePath(manifest, slot) {
  // Play together (shared/playtogether.mjs › save model): the slot plays the library game's own battery save
  const lib = runMode(manifest) === 'together' ? manifest?.outputs?.[slot]?.library : null;
  if (lib !== undefined && lib !== null) return okLibraryId(lib) && manifest.outputs[slot].rom ? librarySavePath(lib) : null;
  const rom = manifest?.outputs?.[slot]?.rom;
  if (typeof rom !== 'string' || !/\.(nds|gba|gbc|gb|sgb)$/i.test(rom)) return null;
  return runPath(manifest.id, rom.replace(/\.(nds|gba|gbc|gb|sgb)$/i, '.sav'));
}

