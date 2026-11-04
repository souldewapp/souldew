// Small filesystem helpers shared by the server modules.
import { writeFileSync, renameSync, rmSync } from 'node:fs';
import { extname, posix, win32 } from 'node:path';

/**
 * rename that rides out Windows' transient locks: an antivirus scanner or the search indexer briefly opening the
 * target makes MoveFileEx fail with EPERM / EACCES / EBUSY. Retried for about a second, then the error stands.
 */
export function renameRetry(from, to, { platform = process.platform, rename = renameSync } = {}) {
  for (let i = 0; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= 10) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

/**
 * Write a file atomically: temp file in the same directory, then rename over the target.
 * A crash or full disk mid-write leaves the previous version intact instead of a truncated file.
 */
export function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameRetry(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Device names Windows reserves in every folder, with or without an extension and with spaces before it
 * (CON, NUL, COM1, LPT1.txt, "CON .txt", CONIN$ …).
 */
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i;
const TRAILING = /[. ]+$/;

/**
 * A file name that is valid on Windows, macOS and Linux alike: no path parts, no characters Windows forbids
 * (\ / : * ? " < > |) or control characters, no trailing dots / spaces, no reserved device names, composed Unicode
 * (NFC) and at most `maxBytes` UTF-8 bytes (the extension is kept). Empty results become `fallback`.
 */
export function safeFileName(name, { fallback = '_', maxBytes = 200 } = {}) {
  // (bidirectional controls go too: "ab\u202Egnp.exe" would display as "abexe.png")
  let safe = String(name ?? '').normalize('NFC').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069:*?"<>|]+/g, '_').replace(TRAILING, '').trim();
  if (RESERVED.test(safe)) safe = `_${safe}`;
  if (Buffer.byteLength(safe) > maxBytes) {
    // keep a real extension (short, no spaces); the stem is cut on a character boundary, never ending in . or space
    const ext = /^\.[^. ]{1,15}$/.test(extname(safe)) ? extname(safe) : '';
    const stem = Array.from(safe.slice(0, safe.length - ext.length));
    while (stem.length && Buffer.byteLength(stem.join('')) + Buffer.byteLength(ext) > maxBytes) stem.pop();
    safe = `${stem.join('').replace(TRAILING, '').trim()}${ext}`.replace(TRAILING, '');
  }
  return safe || fallback;
}

/** Same file or folder by the platform's rules (case-insensitive on Windows). */
export function samePath(a, b, platform = process.platform) {
  const p = platform === 'win32' ? win32 : posix;
  return p.relative(p.resolve(a), p.resolve(b)) === '';
}

/**
 * Is `child` inside the folder `parent` (not the folder itself)? Uses the platform's path rules – on Windows
 * case-insensitive and with drive roots like D:\ – instead of a string prefix check.
 */
export function isInside(child, parent, platform = process.platform) {
  const p = platform === 'win32' ? win32 : posix;
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  return !!rel && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

/**
 * Error carrying an HTTP status for the API error handler. `code` (+ `vars`) lets the UI show the message in the
 * player's language (web/lib/errors.mjs); `message` stays the text for logs and for clients without that code.
 */
export function httpError(status, message, code, vars) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...(vars ? { vars } : {}) });
}
