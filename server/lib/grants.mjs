// Files and folders the player picked in the desktop app's own "open" dialog during this session. The page can only
// hand the server path strings – a page that went wrong (a bug, injected script) could name any file on the disk. So
// the library takes paths from outside its own folders only where the player clearly pointed: the usual ROM places
// "Search my Mac / PC" looks through, folders already included in the library, and what was picked in the native
// dialog. electron/main.mjs registers those picks here, in the main process, straight from the dialog's result – the
// page never can. Nothing is stored: a restart forgets them (an included folder stays included via config.json).
//
// No imports of paths.mjs here: electron/main.mjs loads this before the server and its data folder are set up.
import { resolve, isAbsolute } from 'node:path';
import { realPathOf, realInside, samePath } from './fsutil.mjs';

const pickedFiles = new Set();
const pickedFolders = new Set();

/** The real path (links resolved), or null when it can't be read. */
function real(p) {
  try {
    return realPathOf(resolve(String(p)));
  } catch {
    return null;
  }
}

/**
 * The paths of one native dialog: files (openFile) or the chosen folders (openDirectory). Strings only, absolute
 * only – called by electron/main.mjs with dialog.showOpenDialog's filePaths.
 */
export function grantPicked(paths, { folder = false } = {}) {
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !isAbsolute(p)) continue;
    const r = real(p);
    if (r) (folder ? pickedFolders : pickedFiles).add(r);
  }
}

/** Forget every pick (tests). */
export function clearPicked() {
  pickedFiles.clear();
  pickedFolders.clear();
}

/** Was this file picked itself, or does it lie in a folder picked this session? */
export function wasPicked(path) {
  const r = real(path);
  if (!r) return false;
  for (const f of pickedFiles) if (samePath(r, f)) return true;
  for (const d of pickedFolders) if (samePath(r, d) || realInside(r, d)) return true;
  return false;
}

/** Is `path` (links followed) inside one of `roots` (or one of them itself)? */
export function insideAny(path, roots) {
  return (roots || []).some((root) => realInside(path, root));
}
