// Small filesystem helpers shared by the server modules.
import { writeFileSync, renameSync, rmSync } from 'node:fs';

/**
 * Write a file atomically: temp file in the same directory, then rename over the target.
 * A crash or full disk mid-write leaves the previous version intact instead of a truncated file.
 */
export function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Error carrying an HTTP status for the API error handler. `code` (+ `vars`) lets the UI show the message in the
 * player's language (web/lib/errors.mjs); `message` stays the text for logs and for clients without that code.
 */
export function httpError(status, message, code, vars) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...(vars ? { vars } : {}) });
}
