// The player's own cover pictures for library entries that have none (ROMs the catalog doesn't know, ROM hacks,
// a catalog cover that can't load). One file per entry: <data>/covers/<hash>.<png|jpg|webp>. The entry id is only
// ever hashed – it never becomes part of a path – and the bytes must really be one of the three image formats.
import { readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR, DEV } from './paths.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';

export const COVERS_DIR = join(DATA_DIR, DEV ? 'runs/.covers' : 'covers');
export const COVER_LIMIT = 4 * 1024 * 1024;
export const COVER_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

// game:<catalog id> · hack:<catalog id> · rom:<CRC32> (a ROM the catalog doesn't know – by content, so the picture
// stays when the file is renamed or moved) · ctr:<title ID> (a 3DS file the catalog doesn't know – no CRC32 there)
const ID = /^(?:(?:game|hack):[a-z0-9][a-z0-9-]{0,79}|rom:[0-9A-F]{8}|ctr:[0-9A-F]{16})$/;

export function checkCoverId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw httpError(400, 'Ungültige Bild-ID', 'badCoverId');
  return id;
}

const hashOf = (id) => createHash('sha1').update(id).digest('hex').slice(0, 24);

/** 'png' | 'jpg' | 'webp' from the first bytes, null for anything else (the file name or Content-Type don't count). */
export function imageKind(buf) {
  const b = buf || [];
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

/** The stored picture of an entry: { path, ext, type, mtimeMs } or null. */
export function coverFile(id) {
  const h = hashOf(checkCoverId(id));
  for (const ext of Object.keys(COVER_TYPES)) {
    const path = join(COVERS_DIR, `${h}.${ext}`);
    try {
      const st = statSync(path);
      if (st.isFile()) return { path, ext, type: COVER_TYPES[ext], mtimeMs: st.mtimeMs };
    } catch {
      // not this format
    }
  }
  return null;
}

export function saveCover(id, buf) {
  checkCoverId(id);
  if (!buf?.length) throw httpError(400, 'Leere Datei', 'emptyFile');
  if (buf.length > COVER_LIMIT) throw httpError(413, 'Bild zu groß (höchstens 4 MB)', 'coverTooLarge');
  const ext = imageKind(buf);
  if (!ext) throw httpError(415, 'Nur Bilder im Format PNG, JPEG oder WebP', 'coverType');
  mkdirSync(COVERS_DIR, { recursive: true });
  const h = hashOf(id);
  writeFileAtomic(join(COVERS_DIR, `${h}.${ext}`), buf);
  // a PNG replacing a JPEG: the old file must not win the lookup
  for (const other of Object.keys(COVER_TYPES)) if (other !== ext) rmSync(join(COVERS_DIR, `${h}.${other}`), { force: true });
  return coverFile(id);
}

export function deleteCover(id) {
  const h = hashOf(checkCoverId(id));
  let removed = false;
  for (const ext of Object.keys(COVER_TYPES)) {
    const path = join(COVERS_DIR, `${h}.${ext}`);
    try {
      rmSync(path);
      removed = true;
    } catch {
      // wasn't there
    }
  }
  return removed;
}

export const coverUrl = (id, mtimeMs) => `/api/library/cover?id=${encodeURIComponent(id)}&v=${Math.round(mtimeMs)}`;

/**
 * { [entry id]: url } for the given ids that have a picture – one directory read for the whole library listing.
 * The url carries the file's time, so a replaced picture is fetched again instead of coming from the cache.
 */
export function customCovers(ids) {
  let names;
  try {
    names = readdirSync(COVERS_DIR);
  } catch {
    return {};
  }
  const files = new Map();
  for (const n of names) {
    const m = n.match(/^([0-9a-f]{24})\.(png|jpg|webp)$/);
    if (m) files.set(m[1], n);
  }
  const out = {};
  if (!files.size) return out;
  for (const id of new Set(ids)) {
    if (!ID.test(id)) continue;
    const name = files.get(hashOf(id));
    if (!name) continue;
    try {
      out[id] = coverUrl(id, statSync(join(COVERS_DIR, name)).mtimeMs);
    } catch {
      // removed meanwhile
    }
  }
  return out;
}
