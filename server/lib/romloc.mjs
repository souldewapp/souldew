// The ROM's own location data for the play view's "where am I" sign (shared/live/romloc.mjs), computed here from the
// file instead of in the page: a DS ROM is 64–512 MB, and the page already holds one copy for the emulator. The
// result is small (names + map → location ids) and cached per file (path, size, time) in CACHE_DIR/romloc.
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { romLocations } from '../../shared/live/romloc.mjs';

const VERSION = 1; // bump when romLocations() changes what it finds
const memo = new Map();
let charsets = null;

function opts(sharedDir) {
  if (!charsets) {
    const j = (f) => JSON.parse(readFileSync(join(sharedDir, 'data', f), 'utf8'));
    charsets = { gen3Charset: j('charset_gen3.json'), gen4Chars: j('gen4.json').chars };
  }
  return charsets;
}

/**
 * Location data for a ROM, by file path or (an unpacked archive entry) by its bytes plus a key. Never throws:
 * null when the ROM has none (another engine, an unsupported layout).
 */
export function romLocationsFor({ file = null, bytes = null, key = null }, { sharedDir, cacheDir }) {
  let id;
  try {
    if (file) {
      const st = statSync(file);
      id = `${file}|${st.size}|${st.mtimeMs}`;
    } else id = `bytes|${key}|${bytes?.length}`;
  } catch {
    return null;
  }
  if (memo.has(id)) return memo.get(id);
  const hash = createHash('sha1').update(`${VERSION}|${id}`).digest('hex');
  const cached = cacheDir && join(cacheDir, 'romloc', `${hash}.json`);
  if (cached && existsSync(cached)) {
    try {
      const v = JSON.parse(readFileSync(cached, 'utf8'));
      memo.set(id, v.data);
      return v.data;
    } catch {
      // unreadable cache: compute again
    }
  }
  let data = null;
  try {
    const rom = bytes || readFileSync(file);
    data = romLocations(new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength), opts(sharedDir));
  } catch {
    data = null;
  }
  memo.set(id, data);
  if (cached) {
    try {
      mkdirSync(join(cacheDir, 'romloc'), { recursive: true });
      writeFileSync(cached, JSON.stringify({ version: VERSION, data }));
    } catch {
      // a read-only cache folder only costs the next start a second parse
    }
  }
  return data;
}
