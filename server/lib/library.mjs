// Game library: scans the library folder(s) for ROMs and patches (also inside .zip files),
// identifies them by header + CRC32 and matches them to the catalog. Results are cached.
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, copyFileSync, openSync, readSync, closeSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, extname, basename, resolve, dirname, isAbsolute, posix, win32 } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { listZip, readZipEntry, extractZipEntry, entryFileName, freeBytes, inflateRatioTooHigh } from './zip.mjs';
import { APP_ROOT, DATA_DIR, DEV, LIBRARY_DIR, SHARED_DIR } from './paths.mjs';
import { crc32Hex } from '../../shared/checksum.mjs';
import { writeFileAtomic, httpError, safeFileName, isInside, samePath } from './fsutil.mjs';
import { identifyRom, matchCatalog, ROM_EXTENSIONS, PATCH_EXTENSIONS, CTR_EXTENSIONS, isCtrExt } from '../../shared/romid.mjs';
import { identifyCtr, identifyCtrBytes } from '../../shared/ctr.mjs';
import { wasPicked, insideAny } from './grants.mjs';
import { describePatch, detectPatchFormat } from '../../shared/patchers.mjs';
import { nameVersion, compareVersions, patchFamily } from '../../shared/patchname.mjs';
import { guessHack } from '../../shared/hackguess.mjs';

export { nameVersion, compareVersions };

const INDEX_PATH = join(DATA_DIR, DEV ? 'runs/library-index.json' : 'library-index.json');
const SKIP = new Set(['node_modules', 'runs', 'tools', 'web', 'shared', 'server', 'research', 'test', 'electron', 'dist', 'build', 'scripts']);

let catalogCache = null;
export function catalog() {
  if (!catalogCache) {
    try {
      catalogCache = JSON.parse(readFileSync(join(SHARED_DIR, 'data', 'catalog.json'), 'utf8'));
    } catch {
      catalogCache = { games: [], hacks: [] };
    }
  }
  return catalogCache;
}

export function libraryRoots(config = {}) {
  const roots = [LIBRARY_DIR, ...(config.libraryFolders || [])];
  if (DEV) roots.push(APP_ROOT);
  return [...new Set(roots.map((r) => resolve(r)))];
}

function loadIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveIndex(index) {
  try {
    mkdirSync(dirname(INDEX_PATH), { recursive: true });
    writeFileAtomic(INDEX_PATH, JSON.stringify(index));
  } catch {
    // cache only
  }
}

const sha1 = (b) => createHash('sha1').update(b).digest('hex');

export function makeId(path, entry) {
  return entry ? `${path}::${entry}` : path;
}

export function resolveId(id, config = {}) {
  if (!id) throw httpError(400, 'No file given', 'noFile');
  // split at the first '::' only – an entry inside the archive may contain '::' itself
  const s = String(id);
  const cut = s.indexOf('::');
  const file = cut < 0 ? s : s.slice(0, cut);
  const entry = cut < 0 ? undefined : s.slice(cut + 2);
  const abs = resolve(file);
  const roots = libraryRoots(config);
  if (!roots.some((r) => isInside(abs, r))) throw httpError(403, 'The file is not in a library folder', 'notInLibrary');
  if (!existsSync(abs)) throw httpError(404, `File not found: ${basename(abs)}`, 'fileNotFoundNamed', { name: basename(abs) });
  return { abs, entry };
}

export function loadFile(id, config = {}) {
  const { abs, entry } = resolveId(id, config);
  if (!entry) return new Uint8Array(readFileSync(abs));
  const e = listZip(abs).find((x) => x.name === entry);
  if (!e) throw httpError(404, `"${entry}" not found in the archive`, 'notInArchive', { entry });
  return new Uint8Array(readZipEntry(abs, e));
}

function headOf(path, len = 0x200) {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(len);
    const n = readSync(fd, b, 0, len, 0);
    return new Uint8Array(b.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/**
 * A 3DS file: identified from a few header reads (shared/ctr.mjs) – no CRC32, these files are 1–4 GB. null for
 * anything that isn't a playable 3DS game file: no 3DS header, or an update / DLC / system title (those are installed
 * in Azahar, not played from the library).
 */
export function ctrInfo(path, ext) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const readAt = (o, n) => {
      const b = Buffer.alloc(n);
      const got = readSync(fd, b, 0, n, o);
      return new Uint8Array(b.buffer, b.byteOffset, got);
    };
    const info = identifyCtr(readAt, ext);
    if (!info || notPlayable(info)) return null;
    return { ...info, crc: null };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Updates, DLC and system titles: installed in Azahar, not played from the library. */
const notPlayable = (info) => ['update', 'dlc', 'system'].includes(info?.kind);

/** How much of a zipped 3DS game is inflated to identify it: its NCSD header and the game's NCCH header (at 0x4000). */
const CTR_HEAD = 0x10000;

/**
 * The 3DS games inside a zip (a 3DS game is 1–4 GB – only its first 64 KB are inflated): [{ entry, ext, info }], info as
 * ctrInfo gives it. Updates / DLC, entries that aren't 3DS files and entries souldew can't unpack are left out.
 */
export function zipCtrGames(path, entries = null) {
  if (!entries) {
    try {
      entries = listZip(path);
    } catch {
      return [];
    }
  }
  const out = [];
  for (const e of entries) {
    const ext = extname(e.name).slice(1).toLowerCase();
    if (junkEntry(e.name) || !isCtrExt(ext) || (e.flags & 1) || ![0, 8].includes(e.method) || inflateRatioTooHigh(e)) continue;
    try {
      const head = readZipEntry(path, e, { prefix: CTR_HEAD });
      const info = identifyCtrBytes(new Uint8Array(head.buffer, head.byteOffset, head.length), ext);
      if (info && !notPlayable(info)) out.push({ entry: e, ext, info: { ...info, crc: null } });
    } catch {
      // damaged entry – not offered
    }
  }
  return out;
}

/** Does a zip hold anything besides 3DS games that the library reads from the zip itself (ROMs, patches)? */
const zipHasOther = (entries) => entries.some((e) => !junkEntry(e.name) && [...ROM_EXTENSIONS, ...PATCH_EXTENSIONS].includes(extname(e.name).slice(1).toLowerCase()));

const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
/** Room left on the disk after unpacking (the library index, saves …). */
const SPACE_MARGIN = 256 * 1024 * 1024;
let unpackQueue = Promise.resolve();

/**
 * Unpack the 3DS games of a zip into the library folder (`dir`) as normal files – the 3DS player needs the file, and
 * a 4 GB game can't be inflated in memory. One unpack at a time (two would race for the disk). Each game: its name
 * checked (no path parts), free space checked first, streamed with its CRC32 checked, nothing left behind when it fails
 * (zip.mjs extractZipEntry). A game unpacked before (same name and size) isn't unpacked again. `onUnpack({ state:
 * 'start'|'progress'|'done'|'failed', name, gameId, size, done })` follows it (the page shows it as a toast).
 * → the library files, one per game. Throws httpErrors with codes for the player's message.
 */
export function unpackZipGames(zipPath, { games = null, onUnpack = null, dir = LIBRARY_DIR } = {}) {
  const run = unpackQueue.then(async () => {
    const added = [];
    for (const g of games || zipCtrGames(zipPath)) added.push(await unpackOne(zipPath, g, onUnpack, dir));
    return added;
  });
  unpackQueue = run.catch(() => {});
  return run;
}

async function unpackOne(zipPath, { entry, info }, onUnpack, dir) {
  let base;
  try {
    base = entryFileName(entry.name);
  } catch {
    throw httpError(400, `Unsafe file name in the zip: ${entry.name}`, 'zipEntryUnsafe', { name: entry.name });
  }
  let safe = safeFileName(base, { fallback: 'game.3ds', maxBytes: 200 });
  if (safe.startsWith('.')) safe = `_${safe.slice(1)}`; // hidden files are skipped by the library scan
  mkdirSync(dir, { recursive: true });
  const ext = extname(safe);
  let dest = join(dir, safe);
  for (let i = 2; existsSync(dest); i++) {
    if (statSync(dest).size === entry.uncompSize) return dest; // unpacked before
    dest = join(dir, `${safe.slice(0, safe.length - ext.length)} (${i})${ext}`);
  }
  const free = freeBytes(dir);
  if (free !== null && free < entry.uncompSize + SPACE_MARGIN) {
    throw httpError(507, `Not enough free disk space for ${base}: it needs ${gb(entry.uncompSize)}, ${gb(free)} are free`, 'diskFull', { name: base, need: gb(entry.uncompSize), free: gb(free) });
  }
  const ev = { name: base.replace(/\.[^.]+$/, ''), gameId: matchCatalog(info, catalog())?.game?.id || null, size: entry.uncompSize };
  onUnpack?.({ state: 'start', done: 0, ...ev });
  let last = Date.now();
  const onProgress = (done) => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    onUnpack?.({ state: 'progress', done, ...ev });
  };
  try {
    await extractZipEntry(zipPath, entry, dest, { maxSize: MAX_CTR_BYTES, onProgress });
  } catch (e) {
    onUnpack?.({ state: 'failed', ...ev });
    throw unpackError(e, base, entry.uncompSize, dir);
  }
  onUnpack?.({ state: 'done', done: entry.uncompSize, ...ev });
  return dest;
}

/** A failed unpack as the httpError the page translates (web/lib/errors.mjs). */
function unpackError(e, name, size, dir) {
  if (e.zipCode === 'damaged') return httpError(422, `${name} is damaged in the zip (${e.message})`, 'zipDamaged', { name });
  if (e.zipCode === 'method') return httpError(415, `${name}: ${e.message}`, 'zipMethod', { name });
  if (e.zipCode === 'tooLarge') return httpError(413, `File too large: ${name}`, 'fileTooLarge');
  if (e.code === 'ENOSPC') return httpError(507, `Not enough free disk space for ${name}`, 'diskFull', { name, need: gb(size), free: gb(freeBytes(dir) || 0) });
  return httpError(500, `${name} couldn’t be unpacked: ${e.message}`, 'unpackFailed', { name, why: e.message });
}

function describeRom(info, cat) {
  const m = matchCatalog(info, cat);
  // a ROM that was patched before it was added (Too Many Types from a download site): its CRC32 is a known version
  // of a hack – the run gets the hack, not only the base game it shares its header with
  const hack = info.crc ? (cat.hacks || []).find((h) => (h.romCrc32 || []).includes(info.crc)) : null;
  return { ...info, gameId: m?.game?.id || null, exact: !!m?.exact, hackId: hack?.id || null };
}

/** Scan all library folders. Fast after the first run thanks to the index cache. */
export function scanLibrary(config = {}) {
  const cat = catalog();
  const index = loadIndex();
  const nextIndex = {};
  const roms = [];
  const patches = [];
  const zipped = []; // 3DS games inside zips – played once unpacked (unpackZipGames)
  const seen = new Set(); // nested / overlapping library folders would list files twice
  const patchTime = new Map(); // patch → mtime of its file (or zip), to tell which of two versions came later

  const visit = (dir, depth) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') || name.startsWith('_') || SKIP.has(name)) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 2) visit(path, depth + 1);
        continue;
      }
      const ext = extname(name).slice(1).toLowerCase();
      const cacheKey = `${path}|${st.size}|${st.mtimeMs}`;
      if (isCtrExt(ext)) {
        const info = index[cacheKey] !== undefined ? index[cacheKey] : ctrInfo(path, ext);
        nextIndex[cacheKey] = info;
        if (info) roms.push(describeRom({ id: makeId(path), name, file: path, size: st.size, container: null, ...info }, cat));
      } else if (ROM_EXTENSIONS.includes(ext)) {
        let info = index[cacheKey];
        if (!info) {
          let buf;
          try {
            buf = readFileSync(path);
          } catch {
            continue; // unreadable file must not break the whole library
          }
          info = { ...identifyRom(new Uint8Array(buf.subarray(0, 0x200)), ext), crc: crc32Hex(buf) };
        }
        nextIndex[cacheKey] = info;
        roms.push(describeRom({ id: makeId(path), name, file: path, size: st.size, container: null, ...info }, cat));
      } else if (PATCH_EXTENSIONS.includes(ext)) {
        let info = index[cacheKey];
        if (!info || !('resultCrc' in info)) { // (indexes before 2.3.1 lack the result's checksum)
          let buf;
          try {
            buf = new Uint8Array(readFileSync(path));
          } catch {
            continue;
          }
          info = patchInfo(buf);
        }
        nextIndex[cacheKey] = info;
        const p = { id: makeId(path), name, file: path, size: st.size, container: null, ...info };
        patchTime.set(p, st.mtimeMs);
        patches.push(p);
      } else if (ext === 'zip') {
        let cached = index[cacheKey];
        // (indexes before 2.7.0 didn't look for 3DS games: no `ctr`; before 2.8.1 they skipped .sgb ROMs: no `sgb`)
        if (!cached || !cached.ctr || !cached.sgb || cached.patches?.some((x) => !('resultCrc' in x))) {
          cached = { roms: [], patches: [], notes: [], ctr: [], sgb: true };
          let entries = [];
          try {
            entries = listZip(path);
          } catch {
            entries = [];
          }
          for (const e of entries) {
            // macOS zips carry AppleDouble copies (__MACOSX/…/._game.nds) – resource forks, not ROMs
            if (junkEntry(e.name)) continue;
            const eext = extname(e.name).slice(1).toLowerCase();
            // Unsupported compression (Deflate64, LZMA …) or a damaged entry: skip just that entry.
            try {
              if (ROM_EXTENSIONS.includes(eext)) {
                const buf = readZipEntry(path, e, { prefix: 0x200 }); // header only – don't inflate the whole ROM
                cached.roms.push({ entry: e.name, size: e.uncompSize, ...identifyRom(new Uint8Array(buf.subarray(0, 0x200)), eext), crc: e.crc.toString(16).toUpperCase().padStart(8, '0') });
              } else if (PATCH_EXTENSIONS.includes(eext)) {
                cached.patches.push({ entry: e.name, size: e.uncompSize, ...patchInfo(new Uint8Array(readZipEntry(path, e))) });
              } else if (/readme|liesmich|\.txt$/i.test(e.name) && e.uncompSize < 64 * 1024) {
                cached.notes.push({ entry: e.name, text: readZipEntry(path, e).toString('utf8') });
              }
            } catch {
              // ignore this entry
            }
          }
          cached.ctr = zipCtrGames(path, entries).map(({ entry, info }) => ({ entry: entry.name, size: entry.uncompSize, ...info }));
        }
        nextIndex[cacheKey] = cached;
        for (const r of cached.roms) if (!junkEntry(r.entry)) roms.push(describeRom({ id: makeId(path, r.entry), name: entryBase(r.entry), file: path, container: name, ...r }, cat));
        for (const r of cached.ctr) zipped.push(describeRom({ id: makeId(path, r.entry), name: entryBase(r.entry), file: path, container: name, zipped: true, ...r }, cat));
        for (const p of cached.patches) {
          if (junkEntry(p.entry)) continue; // (indexes from older versions may still list them)
          const note = cached.notes[0];
          const patch = { id: makeId(path, p.entry), name: entryBase(p.entry), file: path, container: name, readme: note?.text || null, ...p,
            expectedCrc: p.expectedCrc || parseReadmeCrc(note?.text || '') };
          patchTime.set(patch, st.mtimeMs);
          patches.push(patch);
        }
      }
    }
  };
  for (const root of libraryRoots(config)) visit(root, 0);
  saveIndex(nextIndex);
  applyRomHacks(roms, config, cat);
  // a zipped 3DS game that is unpacked already (the same game, the same size) isn't offered again
  const ctrKey = (r) => `${r.titleId || r.code || r.title}|${r.size}`;
  const unpacked = new Set(roms.filter((r) => r.system === '3ds').map(ctrKey));

  // Link patches to hacks / base games
  for (const p of patches) {
    // (the longest name that fits wins: "Too Many Types 2" over "Too Many Types")
    const byName = [...(cat.hacks || [])].sort((a, b) => String(b.name).length - String(a.name).length);
    // by checksum first – the patch file's own SHA-1, or what a BPS/UPS patch says its result is (a known version of
    // the hack: "1.1.1 mirror.bps" is Too Many Types 2) –, then by name
    const hack = byName.find((h) => (p.sha1 && h.patchSha1 === p.sha1) || (p.resultCrc && (h.romCrc32 || []).includes(p.resultCrc)))
      || byName.find((h) => h.baseCrc32 && p.expectedCrc && String(h.baseCrc32).toUpperCase() === p.expectedCrc && nameLike(p.name, h.name))
      || byName.find((h) => nameLike(p.name, h.name));
    p.hackId = hack?.id || null;
    if (!p.expectedCrc && hack?.baseCrc32) p.expectedCrc = String(hack.baseCrc32).toUpperCase();
    p.baseRomId = roms.find((r) => p.expectedCrc && r.crc === p.expectedCrc)?.id || null;
    // a hack the catalog doesn't know: its versions are told together by the file name ("Crest v1.bps", "Crest v2.bps")
    if (!p.hackId) p.family = patchFamily(p.name);
  }
  return { roms, patches: newestFirst(patches, patchTime), zipped: zipped.filter((z) => !unpacked.has(ctrKey(z))), roots: libraryRoots(config), libraryDir: LIBRARY_DIR };
}

/**
 * What the player said an already-patched ROM is (config.romHacks, by the ROM's CRC32 – the same file under another
 * name or in another folder keeps it, rescans too): { hackId } a catalog hack → the ROM is that hack (r.hackId, on the
 * hack's page as "Your ROM", runs get the hack's catalog entry), { name } a hack the catalog doesn't know →
 * r.customHack, { none: true } "not a hack" (no more suggestion). A ROM that isn't an exact catalog dump and has no mark
 * gets r.suggestedHackId when its file name looks like a hack of its header's game (shared/hackguess.mjs).
 */
function applyRomHacks(roms, config, cat) {
  const marks = config.romHacks && typeof config.romHacks === 'object' ? config.romHacks : {};
  for (const r of roms) {
    if (!r.crc || r.hackId) continue; // (3DS games have no CRC32; a hack known by its checksum stays that)
    const m = marks[r.crc];
    const h = m?.hackId ? (cat.hacks || []).find((x) => x.id === m.hackId) : null;
    if (h) {
      r.hackId = h.id;
      r.hackMarked = true;
      if (!r.gameId) r.gameId = h.baseGameId || null; // (a ROM whose header the catalog doesn't know)
    } else if (typeof m?.name === 'string' && m.name) {
      r.customHack = m.name;
    } else if (!m && !r.exact) {
      const guess = guessHack(r.name, r.gameId, cat);
      if (guess) r.suggestedHackId = guess.id;
    }
  }
}

/**
 * The player's answer to "This is a ROM hack…" for the ROM with CRC32 `crc` → the new config.romHacks:
 * { hackId } (a catalog hack), { name } ("other / unknown hack", up to 80 characters), { none: true } (not a hack) or
 * {} (undo: forget it). Throws 400 for anything else.
 */
export function setRomHack(marks, { crc, hackId, name, none } = {}, cat = catalog()) {
  const key = String(crc || '').toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(key)) throw httpError(400, 'Invalid checksum', 'badRomHack');
  const next = { ...(marks && typeof marks === 'object' && !Array.isArray(marks) ? marks : {}) };
  if (hackId != null) {
    if (!(cat.hacks || []).some((h) => h.id === hackId)) throw httpError(400, 'Unknown ROM hack', 'badRomHack');
    next[key] = { hackId };
  } else if (name != null) {
    const clean = String(name).normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 80) throw httpError(400, 'Invalid name', 'badRomHack');
    next[key] = { name: clean };
  } else if (none) {
    next[key] = { none: true };
  } else {
    delete next[key];
  }
  return next;
}

/**
 * Several patches of one hack (an update added next to the old version): the newest first – the version in the file
 * name, else the file added later –, because the library and the new-run wizard use the first patch of a hack.
 * A hack the catalog doesn't know is told by its `family` (the file name without the version). Patches of different
 * hacks keep their order; the older versions get `olderVersion: true` (still selectable).
 */
function newestFirst(patches, time = new Map()) {
  const groups = new Map();
  for (const p of patches) {
    const key = p.hackId ? `hack:${p.hackId}` : p.family ? `file:${p.family}` : null;
    if (key) groups.set(key, [...(groups.get(key) || []), p]);
  }
  const order = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => compareVersions(nameVersion(b.name), nameVersion(a.name)) || (time.get(b) || 0) - (time.get(a) || 0));
    sorted.forEach((p, i) => {
      p.olderVersion = i > 0;
      order.set(list[i], p);
    });
  }
  return patches.map((p) => order.get(p) || p);
}

// ---- finding games elsewhere on this computer -----------------------------------------------------------------
// Where people keep ROMs: the usual folders, iCloud Drive / OneDrive, game / ROM folders, OpenEmu's library (Mac),
// RetroArch / RetroBat / LaunchBox (Windows). Only headers are read (a few hundred bytes per file), the walk is
// bounded in depth, files and time, and system folders, app bundles and photo libraries are never entered.
const DISCOVER_SKIP = /^(node_modules|Library|Applications|Pictures|Music|Movies|Videos|AppData|\$Recycle\.Bin|System Volume Information|WindowsApps|\.Trash|Caches?|DerivedData|Pods|venv|site-packages|__pycache__|target|vendor)$|\.(app|photoslibrary|bundle|framework|xcodeproj|xcworkspace|git|lproj)$/i;
const MAX_ROM_BYTES = 600 * 1024 * 1024;
/** 3DS cartridges are up to 4 GB (8 GB images exist for a handful of games). */
export const MAX_CTR_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * The real folders behind the Downloads / Desktop / Documents shortcuts – the desktop app passes them in
 * (Electron knows when Windows moved them, e.g. to OneDrive or another drive): SLS_USER_DIRS = JSON list.
 */
function userDirs(env, P) {
  try {
    const list = JSON.parse(env.SLS_USER_DIRS || '[]');
    return Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d.length < 1024 && P.isAbsolute(d)) : [];
  } catch {
    return [];
  }
}

/** One entry per real folder (ROMs / Roms / roms are one folder on case-insensitive disks), existing ones only. */
function uniqueDirs(dirs, platform) {
  const seen = new Set();
  return dirs.filter((d) => {
    let real;
    try {
      if (!statSync(d).isDirectory()) return false;
      real = realpathSync.native(d);
    } catch {
      return false;
    }
    const key = platform === 'win32' || platform === 'darwin' ? real.toLowerCase() : real;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const listNames = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Linux: the usual places plus the emulation setups – EmuDeck (~/Emulation/roms), RetroDECK (~/retrodeck/roms),
 * RetroArch (native and Flatpak) – and the same folders on SD cards and USB drives: /run/media/<user>/<label>
 * (SteamOS 3.5+, Fedora, Arch …), /run/media/<label> (older SteamOS: mmcblk0p1) and /media/<user>/<label> (Ubuntu,
 * Debian). `list` reads a folder's entries (only the mount folders are listed).
 */
function linuxCandidates(home, env, h, list) {
  const P = posix;
  const config = typeof env.XDG_CONFIG_HOME === 'string' && P.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : h('.config');
  const user = typeof env.USER === 'string' && /^[\w.-]+$/.test(env.USER) ? env.USER : P.basename(home);
  const under = (dir) => list(dir).filter((n) => typeof n === 'string' && n && !n.startsWith('.')).map((n) => P.join(dir, n));
  const mounts = [...under(P.join('/run/media', user)), ...under('/run/media').filter((m) => P.basename(m) !== user), ...under(P.join('/media', user))];
  const onDrive = (m) => [P.join(m, 'Emulation', 'roms'), P.join(m, 'retrodeck', 'roms'), P.join(m, 'ROMs'), P.join(m, 'Roms'), P.join(m, 'roms')];
  return [h('Emulation', 'roms'), h('retrodeck', 'roms'), P.join(config, 'retroarch', 'downloads'),
    h('.var', 'app', 'org.libretro.RetroArch', 'config', 'retroarch', 'downloads'), ...mounts.flatMap(onDrive)];
}

/**
 * Every place worth a look on this platform, existing or not (path rules of `platform`, testable anywhere; on Linux the
 * mount folders of SD cards and drives are listed through `list`).
 */
export function discoverCandidates(home = homedir(), { platform = process.platform, env = process.env, list = listNames } = {}) {
  const P = platform === 'win32' ? win32 : posix;
  const h = (...p) => P.join(home, ...p);
  if (platform === 'android') {
    // the phone's shared storage (the app's own home is private): needs "All files access" (MainActivity), else Android shows
    // an app nothing but its own files. Downloads is where a file that came over Bluetooth, a browser or a PC transfer ends up.
    const base = env.SLS_SHARED_DIR || '/storage/emulated/0';
    return ['Download', 'Documents', 'ROMs', 'Roms', 'roms', 'Games', 'Emulation', 'GBA', 'NDS', '3DS', 'Nintendo', 'RetroArch/roms'].map((d) => posix.join(base, d));
  }
  const common = [...userDirs(env, P), h('Downloads'), h('Desktop'), h('Documents'), h('Games'), h('ROMs'), h('Roms'), h('roms'), h('Emulation')];
  if (platform === 'win32') {
    const drive = `${(env.SystemDrive || 'C:').replace(/[\\/]+$/, '')}\\`;
    const appData = env.APPDATA || h('AppData', 'Roaming');
    const oneDrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((d) => typeof d === 'string' && P.isAbsolute(d));
    return [...common, ...oneDrive, h('OneDrive'), h('Emulators'), h('LaunchBox', 'Games'),
      P.join(appData, 'RetroArch', 'roms'), P.join(appData, 'RetroArch', 'downloads'),
      P.join(drive, 'RetroArch-Win64', 'roms'), P.join(drive, 'RetroArch-Win64', 'downloads'), P.join(drive, 'RetroBat', 'roms'),
      P.join(drive, 'ROMs'), P.join(drive, 'Games'), P.join(drive, 'Emulation'), P.join(drive, 'Emulators')];
  }
  if (platform === 'linux') return [...common, ...linuxCandidates(home, env, h, list)];
  return [...common, h('Library', 'Mobile Documents', 'com~apple~CloudDocs'), h('Library', 'Application Support', 'OpenEmu', 'Game Library')];
}

/** The folders "Search my Mac / PC" looks through: the candidates that exist, each real folder once. */
/**
 * An online-only cloud file (OneDrive "Files On-Demand" and other Windows cloud providers): it takes no space on the
 * disk yet, and reading even its first bytes would download it. Windows reports no allocated blocks for it (libuv:
 * st_blocks = allocation size / 512), while a real file of a ROM's size always has some. Never read those.
 */
export function onlineOnly(st, platform = process.platform) {
  return platform === 'win32' && st.size > 4096 && st.blocks === 0;
}

export function discoverRoots(home = homedir(), opts = {}) {
  return uniqueDirs(discoverCandidates(home, opts), opts.platform || process.platform);
}

/**
 * Look for ROMs outside the library: [{ path, entry?, name, size, system, title, code, gameId, inLibrary }].
 * Recognised games (in the catalog) come first. `known` = roms already in the library (scanLibrary().roms).
 */
export function discoverRoms({ roots = discoverRoots(), known = [], maxDepth = 4, maxEntries = 30000, budgetMs = 8000 } = {}) {
  const cat = catalog();
  const started = Date.now();
  const sig = (r) => `${r.system}|${(r.code || r.title || '').toUpperCase()}|${r.size}`;
  const have = new Set(known.map(sig));
  const found = [];
  const listed = new Set(); // a file reachable from two places (Documents inside OneDrive …) is listed once
  const fileKey = (info) => `${process.platform === 'win32' ? info.path.toLowerCase() : info.path}::${info.entry || ''}`;
  let entries = 0;
  let truncated = false;
  const add = (info) => {
    if (listed.has(fileKey(info))) return;
    listed.add(fileKey(info));
    const m = matchCatalog(info, cat);
    found.push({ ...info, gameId: m?.game?.id || null, inLibrary: have.has(sig(info)) });
  };
  // Breadth first, each place with its share of the time: a huge Downloads folder can't starve the others, and
  // files near the top (where people drop ROMs) are seen before deep folders.
  const visitRoot = (root, deadline) => {
    const queue = [[root, 0]];
    while (queue.length) {
      const [dir, depth] = queue.shift();
      let names;
      try {
        names = readdirSync(dir);
      } catch {
        continue; // no permission (macOS asks once per folder, Windows may lock some) or gone
      }
      for (const name of names) {
        if (++entries > maxEntries || Date.now() > deadline) {
          truncated = true;
          return;
        }
        if (name.startsWith('.') || DISCOVER_SKIP.test(name)) continue;
        const path = join(dir, name);
        if (samePath(path, LIBRARY_DIR) || isInside(path, LIBRARY_DIR)) continue; // already the library
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth < maxDepth) queue.push([path, depth + 1]);
          continue;
        }
        look(path, name, st);
      }
    }
  };
  const look = (path, name, st) => {
    const ext = extname(name).slice(1).toLowerCase();
    // (a zip may hold a 3DS game: 1–4 GB)
    if (!st.isFile() || st.size > (isCtrExt(ext) || ext === 'zip' ? MAX_CTR_BYTES : MAX_ROM_BYTES) || onlineOnly(st)) return;
    try {
      if (isCtrExt(ext)) {
        const info = ctrInfo(path, ext);
        if (info) add({ path, name, size: st.size, ...info });
      } else if (ROM_EXTENSIONS.includes(ext)) {
        add({ path, name, size: st.size, ...identifyRom(headOf(path), ext) });
      } else if (ext === 'zip') {
        const entries = listZip(path);
        for (const e of entries) {
          const eext = extname(e.name).slice(1).toLowerCase();
          if (junkEntry(e.name) || !ROM_EXTENSIONS.includes(eext)) continue;
          const head = readZipEntry(path, e, { prefix: 0x200 });
          add({ path, entry: e.name, name: entryBase(e.name), size: e.uncompSize, crc: e.crc.toString(16).toUpperCase().padStart(8, '0'),
            ...identifyRom(new Uint8Array(head.subarray(0, 0x200)), eext) });
        }
        // a zipped 3DS game: importing the zip unpacks it into the library
        for (const { entry, info } of zipCtrGames(path, entries)) add({ path, entry: entry.name, name: entryBase(entry.name), size: entry.uncompSize, zipped: true, ...info });
      }
    } catch {
      // unreadable or damaged file – skip it
    }
  };
  roots.forEach((root, i) => visitRoot(root, Date.now() + (budgetMs - (Date.now() - started)) / (roots.length - i)));
  found.sort((a, b) => Number(!a.gameId) - Number(!b.gameId) || Number(a.inLibrary) - Number(b.inLibrary) || a.name.localeCompare(b.name));
  return { found, roots, truncated, ms: Date.now() - started };
}

/** File name of a zip entry – zips made on Windows may use backslashes as separators. */
const entryBase = (name) => String(name).split(/[\\/]/).pop();
const junkEntry = (name) => /(^|[\\/])__MACOSX[\\/]/.test(name) || entryBase(name).startsWith('._');

function nameLike(file, hackName) {
  const norm = (s) => String(s || '').toLowerCase().replace(/pok[eé]mon/g, '').replace(/[^a-z0-9]+/g, '');
  const a = norm(file);
  const b = norm(hackName);
  return b.length > 3 && a.includes(b);
}

function patchInfo(buf) {
  const info = { format: detectPatchFormat(buf), sha1: sha1(buf), resultCrc: null };
  try {
    const d = describePatch(buf);
    info.targetName = d.targetName || null;
    if (d.sourceCrc !== undefined) info.expectedCrc = d.sourceCrc.toString(16).toUpperCase().padStart(8, '0');
    info.resultCrc = d.targetCrc !== undefined ? d.targetCrc.toString(16).toUpperCase().padStart(8, '0') : null;
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

function parseReadmeCrc(text) {
  const m = text.match(/CRC32[^\n]*?\b([0-9A-F]{8})\b/i) || text.match(/:\s*([0-9A-F]{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Folders a path from the page may come from without a pick in the native dialog: the library folder, the folders
 * included in it (config.libraryFolders) and the places "Search my Mac / PC" looks through (discoverRoots).
 */
export function importRoots(config = {}, { roots = discoverRoots() } = {}) {
  return [...libraryRoots(config), ...roots];
}

/**
 * A path the page asks to import (#23): absolute, and inside importRoots or picked in the native dialog this session
 * (server/lib/grants.mjs) – links followed. → the resolved path; otherwise 400 badPath / 403 pathNotApproved.
 */
export function approvedImportPath(p, config = {}, { roots } = {}) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !isAbsolute(p)) throw httpError(400, 'Invalid path', 'badPath');
  if (wasPicked(p) || insideAny(p, roots || importRoots(config))) return resolve(p);
  throw httpError(403, `Not approved: ${basename(p)} – pick it with “Add files”`, 'pathNotApproved', { name: basename(p) });
}

/**
 * A folder the page asks to include in the library (#23): one picked in the native dialog this session (or a
 * folder inside it), or one that is included already. Included folders are scanned and their files served to the
 * emulator (resolveId), so a raw path from the page is never enough. → the resolved path, else 400 / 403.
 */
export function approvedFolder(p, config = {}) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !isAbsolute(p)) throw httpError(400, 'Invalid path', 'badPath');
  const abs = resolve(p);
  if (wasPicked(abs) || (config.libraryFolders || []).some((f) => samePath(f, abs))) return abs;
  throw httpError(403, `Folder not approved: ${basename(abs)} – pick it with “Use a folder”`, 'folderNotApproved', { name: basename(abs) });
}

/**
 * Copy files into the library folder (the user's originals stay untouched). Every path must be approved
 * (approvedImportPath) – checked for all of them before the first one is copied: a refused batch throws right away.
 * A zip with a 3DS game in it isn't copied: the game is unpacked into the library instead (unpackZipGames, `onUnpack`
 * follows it) – the zip itself only when it holds other ROMs or patches too. → a Promise of the library files added.
 */
export function importFiles(paths, config = {}, { roots, onUnpack = null } = {}) {
  if (!Array.isArray(paths)) throw httpError(400, 'Invalid path', 'badPath');
  const allowedRoots = roots || importRoots(config);
  const files = paths.map((p) => approvedImportPath(p, config, { roots: allowedRoots }));
  return (async () => {
    mkdirSync(LIBRARY_DIR, { recursive: true });
    const added = [];
    for (const p of files) {
      const ext = extname(p).slice(1).toLowerCase();
      if (![...ROM_EXTENSIONS, ...CTR_EXTENSIONS, ...PATCH_EXTENSIONS, 'zip'].includes(ext)) continue;
      if (ext === 'zip') {
        let entries = [];
        try {
          entries = listZip(p);
        } catch {
          // not readable as a zip: copied as before, the scan skips it
        }
        const games = zipCtrGames(p, entries);
        if (games.length) {
          added.push(...await unpackZipGames(p, { games, onUnpack }));
          if (!zipHasOther(entries)) continue;
        }
      }
      const target = join(LIBRARY_DIR, basename(p));
      if (resolve(p) !== resolve(target)) copyFileSync(p, target);
      added.push(target);
    }
    return added;
  })();
}

/**
 * An uploaded zip (streamed to the hidden `tmp` in the library folder): its 3DS games are unpacked into the library and
 * the zip goes away – kept as `target` only when it holds other ROMs or patches (or no 3DS game at all, as before).
 * → the library files added.
 */
export async function placeUploadedZip(tmp, target, { onUnpack = null } = {}) {
  try {
    let entries = [];
    try {
      entries = listZip(tmp);
    } catch {
      // not readable as a zip: kept as it came, the scan skips it
    }
    const games = zipCtrGames(tmp, entries);
    const added = games.length ? await unpackZipGames(tmp, { games, onUnpack }) : [];
    if (!games.length || zipHasOther(entries)) {
      renameSync(tmp, target);
      added.push(target);
    }
    return added;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** A zipped 3DS game the library scan found (scanLibrary().zipped, id "zip::entry"): unpacked into the library folder. */
export async function unpackLibraryZip(id, config = {}, { onUnpack = null } = {}) {
  const { abs, entry } = resolveId(id, config);
  if (!entry) throw httpError(400, 'No zip entry given', 'noFile');
  const e = listZip(abs).find((x) => x.name === entry);
  if (!e) throw httpError(404, `"${entry}" not found in the archive`, 'notInArchive', { entry });
  const games = zipCtrGames(abs, [e]);
  if (!games.length) throw httpError(400, 'Not a Nintendo 3DS game', 'notCtr');
  return unpackZipGames(abs, { games, onUnpack });
}

/**
 * Where an uploaded file goes in the library – checked before any byte is read. The name is made safe for every
 * platform: no path parts, no characters Windows forbids, no control characters, no trailing dots / spaces,
 * no reserved device names (CON, NUL, COM1 …), composed Unicode (NFC) so the same name never exists twice.
 */
export function uploadTarget(name) {
  let safe = safeFileName(name, { fallback: '', maxBytes: 200 }); // file systems allow 255 bytes per name
  const ext = extname(safe).slice(1).toLowerCase();
  if (![...ROM_EXTENSIONS, ...CTR_EXTENSIONS, ...PATCH_EXTENSIONS, 'zip'].includes(ext)) throw httpError(400, 'Only ROMs (.gb/.gbc/.gba/.nds/.3ds/.cci/.cxi/.cia/.3dsx), patches or .zip', 'uploadType');
  if (safe.startsWith('.')) safe = `_${safe.slice(1)}`; // hidden files are skipped by the library scan
  mkdirSync(LIBRARY_DIR, { recursive: true });
  return join(LIBRARY_DIR, safe);
}
