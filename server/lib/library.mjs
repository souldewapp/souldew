// Game library: scans the library folder(s) for ROMs and patches (also inside .zip files),
// identifies them by header + CRC32 and matches them to the catalog. Results are cached.
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, copyFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, basename, resolve, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { listZip, readZipEntry } from './zip.mjs';
import { APP_ROOT, DATA_DIR, DEV, LIBRARY_DIR, SHARED_DIR } from './paths.mjs';
import { crc32Hex } from '../../shared/checksum.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { identifyRom, matchCatalog, ROM_EXTENSIONS, PATCH_EXTENSIONS } from '../../shared/romid.mjs';
import { describePatch, detectPatchFormat } from '../../shared/patchers.mjs';

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
  if (!id) throw httpError(400, 'Keine Datei angegeben', 'noFile');
  // split at the first '::' only – an entry inside the archive may contain '::' itself
  const s = String(id);
  const cut = s.indexOf('::');
  const file = cut < 0 ? s : s.slice(0, cut);
  const entry = cut < 0 ? undefined : s.slice(cut + 2);
  const abs = resolve(file);
  const roots = libraryRoots(config);
  if (!roots.some((r) => abs.startsWith(r + sep))) throw httpError(403, 'Datei liegt nicht in einem Bibliotheksordner', 'notInLibrary');
  if (!existsSync(abs)) throw httpError(404, `Datei nicht gefunden: ${basename(abs)}`, 'fileNotFoundNamed', { name: basename(abs) });
  return { abs, entry };
}

export function loadFile(id, config = {}) {
  const { abs, entry } = resolveId(id, config);
  if (!entry) return new Uint8Array(readFileSync(abs));
  const e = listZip(abs).find((x) => x.name === entry);
  if (!e) throw httpError(404, `"${entry}" nicht im Archiv gefunden`, 'notInArchive', { entry });
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

function describeRom(info, cat) {
  const m = matchCatalog(info, cat);
  return { ...info, gameId: m?.game?.id || null, exact: !!m?.exact };
}

/** Scan all library folders. Fast after the first run thanks to the index cache. */
export function scanLibrary(config = {}) {
  const cat = catalog();
  const index = loadIndex();
  const nextIndex = {};
  const roms = [];
  const patches = [];
  const seen = new Set(); // nested / overlapping library folders would list files twice

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
      if (ROM_EXTENSIONS.includes(ext)) {
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
        if (!info) {
          let buf;
          try {
            buf = new Uint8Array(readFileSync(path));
          } catch {
            continue;
          }
          info = patchInfo(buf);
        }
        nextIndex[cacheKey] = info;
        patches.push({ id: makeId(path), name, file: path, size: st.size, container: null, ...info });
      } else if (ext === 'zip') {
        let cached = index[cacheKey];
        if (!cached) {
          cached = { roms: [], patches: [], notes: [] };
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
        }
        nextIndex[cacheKey] = cached;
        for (const r of cached.roms) if (!junkEntry(r.entry)) roms.push(describeRom({ id: makeId(path, r.entry), name: entryBase(r.entry), file: path, container: name, ...r }, cat));
        for (const p of cached.patches) {
          if (junkEntry(p.entry)) continue; // (indexes from older versions may still list them)
          const note = cached.notes[0];
          patches.push({ id: makeId(path, p.entry), name: entryBase(p.entry), file: path, container: name, readme: note?.text || null, ...p,
            expectedCrc: p.expectedCrc || parseReadmeCrc(note?.text || '') });
        }
      }
    }
  };
  for (const root of libraryRoots(config)) visit(root, 0);
  saveIndex(nextIndex);

  // Link patches to hacks / base games
  for (const p of patches) {
    const hack = (cat.hacks || []).find((h) => (p.sha1 && h.patchSha1 === p.sha1) || (h.baseCrc32 && p.expectedCrc && String(h.baseCrc32).toUpperCase() === p.expectedCrc && nameLike(p.name, h.name)))
      || (cat.hacks || []).find((h) => nameLike(p.name, h.name));
    p.hackId = hack?.id || null;
    if (!p.expectedCrc && hack?.baseCrc32) p.expectedCrc = String(hack.baseCrc32).toUpperCase();
    p.baseRomId = roms.find((r) => p.expectedCrc && r.crc === p.expectedCrc)?.id || null;
  }
  return { roms, patches, roots: libraryRoots(config), libraryDir: LIBRARY_DIR };
}

// ---- finding games elsewhere on this Mac ----------------------------------------------------------------------
// Where people keep ROMs: the usual folders, iCloud Drive, game / ROM folders, OpenEmu's library. Only headers are
// read (a few hundred bytes per file), the walk is bounded in depth, files and time, and system folders, app
// bundles and photo libraries are never entered.
const DISCOVER_SKIP = /^(node_modules|Library|Applications|Pictures|Music|Movies|\.Trash|Caches?|DerivedData|Pods|venv|site-packages|__pycache__|target|vendor)$|\.(app|photoslibrary|bundle|framework|xcodeproj|xcworkspace|git|lproj)$/i;
const MAX_ROM_BYTES = 600 * 1024 * 1024;

export function discoverRoots(home = homedir()) {
  const h = (...p) => join(home, ...p);
  return [h('Downloads'), h('Desktop'), h('Documents'), h('Games'), h('ROMs'), h('Roms'), h('roms'), h('Emulation'),
    h('Library', 'Mobile Documents', 'com~apple~CloudDocs'), h('Library', 'Application Support', 'OpenEmu', 'Game Library')]
    .filter((d, i, all) => all.indexOf(d) === i && existsSync(d));
}

/**
 * Look for ROMs outside the library: [{ path, entry?, name, size, system, title, code, gameId, inLibrary }].
 * Recognised games (in the catalog) come first. `known` = roms already in the library (scanLibrary().roms).
 */
export function discoverRoms({ roots = discoverRoots(), known = [], maxDepth = 4, maxEntries = 30000, budgetMs = 8000 } = {}) {
  const cat = catalog();
  const started = Date.now();
  const libraryDirs = [LIBRARY_DIR].map((d) => resolve(d) + sep);
  const sig = (r) => `${r.system}|${(r.code || r.title || '').toUpperCase()}|${r.size}`;
  const have = new Set(known.map(sig));
  const found = [];
  let entries = 0;
  let truncated = false;
  const add = (info) => {
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
        continue; // no permission (macOS asks once per folder) or gone
      }
      for (const name of names) {
        if (++entries > maxEntries || Date.now() > deadline) {
          truncated = true;
          return;
        }
        if (name.startsWith('.') || DISCOVER_SKIP.test(name)) continue;
        const path = join(dir, name);
        if (libraryDirs.some((d) => (path + sep).startsWith(d))) continue; // already the library
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
    if (!st.isFile() || st.size > MAX_ROM_BYTES) return;
    const ext = extname(name).slice(1).toLowerCase();
    try {
      if (ROM_EXTENSIONS.includes(ext)) {
        add({ path, name, size: st.size, ...identifyRom(headOf(path), ext) });
      } else if (ext === 'zip') {
        for (const e of listZip(path)) {
          const eext = extname(e.name).slice(1).toLowerCase();
          if (junkEntry(e.name) || !ROM_EXTENSIONS.includes(eext)) continue;
          const head = readZipEntry(path, e, { prefix: 0x200 });
          add({ path, entry: e.name, name: entryBase(e.name), size: e.uncompSize, crc: e.crc.toString(16).toUpperCase().padStart(8, '0'),
            ...identifyRom(new Uint8Array(head.subarray(0, 0x200)), eext) });
        }
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
  const info = { format: detectPatchFormat(buf), sha1: sha1(buf) };
  try {
    const d = describePatch(buf);
    info.targetName = d.targetName || null;
    if (d.sourceCrc !== undefined) info.expectedCrc = d.sourceCrc.toString(16).toUpperCase().padStart(8, '0');
  } catch (e) {
    info.error = e.message;
  }
  return info;
}

function parseReadmeCrc(text) {
  const m = text.match(/CRC32[^\n]*?\b([0-9A-F]{8})\b/i) || text.match(/:\s*([0-9A-F]{8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

/** Copy files into the library folder (the user's originals stay untouched). */
export function importFiles(paths) {
  mkdirSync(LIBRARY_DIR, { recursive: true });
  const added = [];
  for (const p of paths) {
    const ext = extname(p).slice(1).toLowerCase();
    if (![...ROM_EXTENSIONS, ...PATCH_EXTENSIONS, 'zip'].includes(ext)) continue;
    const target = join(LIBRARY_DIR, basename(p));
    if (resolve(p) !== resolve(target)) copyFileSync(p, target);
    added.push(target);
  }
  return added;
}

/**
 * Where an uploaded file goes in the library – checked before any byte is read. The name is made safe for every
 * platform: no path parts, no characters Windows forbids, no control characters, no trailing dots / spaces,
 * no reserved device names (CON, NUL, COM1 …), composed Unicode (NFC) so the same name never exists twice.
 */
export function uploadTarget(name) {
  let safe = String(name ?? '').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f:*?"<>|]+/g, '_').replace(/[. ]+$/, '').trim();
  const ext = extname(safe).slice(1).toLowerCase();
  if (![...ROM_EXTENSIONS, ...PATCH_EXTENSIONS, 'zip'].includes(ext)) throw httpError(400, 'Nur ROMs (.gb/.gbc/.gba/.nds), Patches oder .zip', 'uploadType');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe)) safe = `_${safe}`;
  if (safe.startsWith('.')) safe = `_${safe.slice(1)}`; // hidden files are skipped by the library scan
  if (Buffer.byteLength(safe) > 200) { // file systems allow 255 bytes per name
    const stem = Array.from(safe.slice(0, -(ext.length + 1)));
    while (Buffer.byteLength(stem.join('')) > 180) stem.pop();
    safe = `${stem.join('').trim()}.${ext}`;
  }
  mkdirSync(LIBRARY_DIR, { recursive: true });
  return join(LIBRARY_DIR, safe);
}
