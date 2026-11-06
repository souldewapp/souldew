// Path layout. Code (web/, shared/, bundled tools) can live read-only inside the .app bundle / the install folder;
// everything the app writes goes to the data directory (~/Library/Application Support/SoulLink Studio on macOS,
// %APPDATA%\SoulLink Studio on Windows, ~/.config/SoulLink Studio on Linux when running as an app, the project folder
// in development).
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEV = !process.env.SLS_DATA_DIR;
export const DATA_DIR = process.env.SLS_DATA_DIR ? resolve(process.env.SLS_DATA_DIR) : APP_ROOT;

/** Tools shipped with the app (randomizer, bridge, Java runtime). */
export const BUNDLED_TOOLS = process.env.SLS_TOOLS_DIR ? resolve(process.env.SLS_TOOLS_DIR) : join(APP_ROOT, 'tools');
/** Tools downloaded at runtime (emulators, randomizer fallback). */
export const TOOLS_DIR = DEV ? join(APP_ROOT, 'tools') : join(DATA_DIR, 'tools');

export const RUNS_DIR = join(DATA_DIR, 'runs');
export const LIBRARY_DIR = DEV ? join(APP_ROOT, 'library') : join(DATA_DIR, 'Library');
export const CACHE_DIR = DEV ? join(APP_ROOT, 'runs', '.cache') : join(DATA_DIR, 'cache');
export const CONFIG_PATH = join(DATA_DIR, DEV ? 'runs/config.json' : 'config.json');

export const WEB_DIR = join(APP_ROOT, 'web');
export const SHARED_DIR = join(APP_ROOT, 'shared');
export const NODE_MODULES = join(APP_ROOT, 'node_modules');
