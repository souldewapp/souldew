// Update check and install for the desktop app (main process). Checks the feed at start and every few
// hours, pushes its state to the window ('update' channel) and does the download / install on request.
// The macOS work itself is in update-core.mjs.
import { app, ipcMain, shell } from 'electron';
import { readFileSync, existsSync, mkdirSync, rmSync, renameSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedUrlFrom, updateAction, dmgAssetName } from '../shared/update.mjs';
import { fetchFeed, downloadFile, verifyFile, bundleFromExe, canReplace, cleanupStaging, stageFromDmg, swapBundle } from './update-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIRST_CHECK = 20 * 1000;
const CHECK_EVERY = 4 * 60 * 60 * 1000;
const BUSY = ['downloading', 'installing', 'ready', 'manual'];

function readUpdatesConfig() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).updates || {};
  } catch {
    return {};
  }
}

/**
 * @param {{ send: Function, trusted: (e: Electron.IpcMainInvokeEvent) => boolean }} opts
 *   `trusted` decides per IPC call whether the sender is the app's main frame on the app origin.
 */
export function setupUpdater({ send, trusted = () => false }) {
  const current = app.getVersion();
  const cfg = readUpdatesConfig();
  // SLS_UPDATE_FEED overrides the feed for testing – only while developing (`npm run app`): an installed app
  // never takes its update source from the environment. Plain http://localhost is likewise development-only.
  const feedUrl = (!app.isPackaged && process.env.SLS_UPDATE_FEED) || feedUrlFrom(cfg);
  const allowLocal = !app.isPackaged;
  const bundle = app.isPackaged && process.platform === 'darwin' ? bundleFromExe(app.getPath('exe')) : null;
  const workDir = join(app.getPath('temp'), 'souldew Update');
  const repo = typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
  // Ed25519 key the feed must be signed with (see scripts/release.mjs --init-key). Without it the feed is only
  // protected by HTTPS – kept working for older setups, but said out loud.
  const publicKey = typeof cfg.publicKey === 'string' && cfg.publicKey.trim() ? cfg.publicKey.trim() : null;
  if (feedUrl && !publicKey) console.warn('update: no updates.publicKey in package.json – the update feed is NOT signature-checked (run `npm run release -- --init-key`)');
  const pageFor = (u) => u.page || (repo ? `https://github.com/${repo}/releases/tag/v${u.version}` : u.url);

  let state = {
    phase: 'idle', // idle · checking · uptodate · available · downloading · installing · ready · manual · error
    current,
    configured: !!feedUrl,
    canInstall: !!bundle, // only the installed app replaces itself – never `npm run app`'s Electron
    update: null, // validated feed + { action, page }
    progress: null, // { received, total }
    step: null, // installing: mount · copy · verify
    error: null, // download / install failure (shown in the banner)
    checkError: null, // last failed check (shown in Settings; BAD_SIGNATURE also in the sidebar)
    checkedAt: null,
    reason: null, // why the manual route was taken
    updatedFrom: null, // first start after an in-app update: the version that was replaced
  };
  // Written when the bundles are swapped, read once on the next start: the "Updated" toast must not depend on
  // the page's localStorage, whose origin changes when the fixed port is taken.
  const marker = join(app.getPath('userData'), 'update-from.json');
  try {
    const { from } = JSON.parse(readFileSync(marker, 'utf8'));
    rmSync(marker, { force: true });
    if (typeof from === 'string' && from !== current) state.updatedFrom = from.slice(0, 64);
  } catch {
    // no update since the last start
  }
  let staged = null;
  let dmgPath = null;
  let abort = null;
  let swapped = false;
  const set = (patch) => {
    state = { ...state, ...patch };
    send('update', state);
    return state;
  };

  // Leftovers of the previous update: the replaced old bundle and the downloaded DMG.
  if (bundle) {
    try {
      cleanupStaging(bundle);
      rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('update cleanup failed:', e.message);
    }
  }

  async function check({ manual = false } = {}) {
    if (!feedUrl || BUSY.includes(state.phase) || state.phase === 'checking') return state;
    const prev = state.phase;
    set({ phase: 'checking', checkError: null });
    try {
      const feed = await fetchFeed(feedUrl, { allowLocal, publicKey });
      const action = updateAction(feed, current);
      if (action === 'none') return set({ phase: 'uptodate', update: null, checkedAt: Date.now() });
      return set({ phase: 'available', update: { ...feed, action, page: pageFor(feed) }, error: null, checkedAt: Date.now() });
    } catch (e) {
      if (!manual || e.code === 'BAD_SIGNATURE') console.warn('update check failed:', e.code || '', e.message);
      // A refused signature is shown in the sidebar too (UpdateBanner); nothing of that feed is used.
      return set({ phase: prev === 'available' || prev === 'error' ? prev : 'idle', checkError: { code: e.code || null, message: e.message }, checkedAt: Date.now() });
    }
  }

  // Not replaceable in place (read-only location, translocated, blocked): hand the verified DMG to the user.
  async function manualRoute(reason) {
    const target = join(app.getPath('downloads'), dmgAssetName(state.update.version));
    if (dmgPath !== target) {
      rmSync(target, { force: true });
      try {
        renameSync(dmgPath, target);
      } catch {
        copyFileSync(dmgPath, target);
        rmSync(dmgPath, { force: true });
      }
      dmgPath = target;
    }
    const err = await shell.openPath(target); // mounts it and opens its Finder window
    return set({ phase: 'manual', reason, step: null, progress: null, error: err || null });
  }

  async function install() {
    const u = state.update;
    if (!u || !['available', 'error'].includes(state.phase)) return state;
    if (updateAction(u, current) === 'none') return set({ phase: 'error', error: 'Refusing to install an older or the same version' });
    abort = new AbortController();
    const dmg = join(workDir, dmgAssetName(u.version));
    set({ phase: 'downloading', progress: { received: 0, total: u.size }, error: null, step: null });
    try {
      mkdirSync(workDir, { recursive: true });
      let last = 0;
      await downloadFile(u.url, dmg, {
        size: u.size, sha256: u.sha256, allowLocal, signal: abort.signal,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last > 200 || p.received === p.total) { last = now; set({ progress: p }); }
        },
      });
      abort = null;
      dmgPath = dmg;
      set({ phase: 'installing', step: 'verify' });
      await verifyFile(dmg, u); // once more from disk – what gets mounted is exactly what was checked
      if (!bundle || u.action === 'manual') return manualRoute(!bundle ? 'dev' : 'minVersion');
      const can = canReplace(bundle);
      if (!can.ok) return manualRoute(can.reason);
      try {
        staged = await stageFromDmg({ dmg, bundle, version: u.version, log: (step) => set({ step }) });
      } catch (e) {
        if (e.code === 'BAD_DMG') throw e;
        console.warn('staging failed, falling back to the DMG:', e.message);
        // An unverifiable signature is never "fixed" by re-signing – the user installs from the DMG (Gatekeeper checks it).
        return manualRoute(e.code === 'SIGNATURE' ? 'signature' : 'copy-failed');
      }
      return set({ phase: 'ready', step: null, progress: null });
    } catch (e) {
      const cancelled = abort?.signal.aborted && abort.signal.reason?.code === 'CANCELLED';
      abort = null;
      if (cancelled) return set({ phase: 'available', progress: null, step: null });
      console.warn('update failed:', e.message);
      return set({ phase: 'error', error: e.message, progress: null, step: null });
    }
  }

  function swap() {
    if (swapped || !staged) return false;
    swapBundle(bundle, staged);
    swapped = true;
    try {
      writeFileSync(marker, JSON.stringify({ from: current }));
    } catch {
      // only the toast depends on it
    }
    return true;
  }

  async function restart() {
    if (state.phase !== 'ready') return state;
    try {
      swap();
    } catch (e) {
      // e.g. macOS "App Management" privacy setting blocked replacing the app – let the user do it in the Finder.
      console.warn('replacing the app failed:', e.message);
      staged = null;
      return manualRoute('blocked');
    }
    app.relaunch(); // starts the (new) app once this one has exited
    app.quit();
    return state;
  }

  // "Later": a staged update is put in place when the app quits, so the next start is the new version.
  app.on('will-quit', () => {
    if (state.phase !== 'ready') return;
    try {
      swap();
    } catch (e) {
      console.warn('installing the update on quit failed:', e.message);
    }
  });

  // Every channel checks its sender: only the app window's main frame may download, install or restart.
  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Not allowed');
    return fn(...args);
  });
  handle('update-state', () => state);
  handle('update-check', () => check({ manual: true }));
  handle('update-install', () => install());
  handle('update-cancel', () => {
    const e = new Error('Cancelled');
    e.code = 'CANCELLED';
    abort?.abort(e);
  });
  handle('update-restart', () => restart());
  handle('update-show', () => (dmgPath && existsSync(dmgPath) ? shell.openPath(dmgPath) : null));

  if (feedUrl) {
    setTimeout(() => check(), FIRST_CHECK);
    setInterval(() => check(), CHECK_EVERY);
  }
  return { check };
}
