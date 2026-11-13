// Update check and install for the desktop app (main process). Checks the feed at start and every few
// hours, pushes its state to the window ('update' channel) and does the download / install on request.
// The platform work itself is in update-core.mjs: macOS swaps the .app bundle, Windows runs the NSIS installer,
// Linux replaces the AppImage file.
import { app, ipcMain, shell } from 'electron';
import { readFileSync, existsSync, mkdirSync, rmSync, renameSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedUrlFrom, updateAction, actionFor, assetFor, dmgAssetName, winAssetName, linuxAssetName } from '../shared/update.mjs';
import {
  fetchFeed, downloadFile, verifyFile, bundleFromExe, canReplace, cleanupStaging, stageFromDmg, swapBundle,
  nsisInstallDir, launchInstaller, windowsInstallPlan, cleanupWorkDir,
  appImageFromEnv, appImageStagedPath, canReplaceAppImage, makeExecutable, swapAppImage, cleanupAppImageStaging, appImageRelaunch,
  requirePackagedPublicKey,
} from './update-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIRST_CHECK = 20 * 1000;
const CHECK_EVERY = 4 * 60 * 60 * 1000;
const BUSY = ['downloading', 'installing', 'ready', 'manual'];
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const LINUX = process.platform === 'linux';

function readUpdatesConfig() {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).updates || {};
  } catch {
    return {};
  }
}

/** File name of this platform's download (the feed names it; older feeds only have the DMG's URL). */
const assetName = (u) => basename(u.asset?.name || '') || (WIN ? winAssetName(u.version, process.arch) : LINUX ? linuxAssetName(u.version, process.arch) : dmgAssetName(u.version));

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
  // What can replace itself: the installed .app on macOS, an app installed by the NSIS installer on Windows, the
  // AppImage on Linux. Anything else (`npm run app`, an unpacked or portable build) gets the verified download handed
  // over instead – and a Linux install from the .deb (owned by root) the download page.
  const bundle = app.isPackaged && MAC ? bundleFromExe(app.getPath('exe')) : null;
  const installDir = app.isPackaged && WIN ? nsisInstallDir(app.getPath('exe')) : null;
  const appImage = app.isPackaged && LINUX ? appImageFromEnv() : null;
  const workDir = join(app.getPath('temp'), 'souldew Update');
  const repo = typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
  // Ed25519 key the feed must be signed with (see scripts/release.mjs --init-key). Packaged builds require it;
  // without it in dev the feed is only protected by HTTPS – warn so forks notice.
  const publicKey = typeof cfg.publicKey === 'string' && cfg.publicKey.trim() ? cfg.publicKey.trim() : null;
  if (feedUrl && !publicKey && !app.isPackaged) console.warn('update: no updates.publicKey in package.json – the update feed is NOT signature-checked (run `npm run release -- --init-key`)');
  const pageFor = (u) => u.page || (repo ? `https://github.com/${repo}/releases/tag/v${u.version}` : u.url);
  const target = { platform: process.platform, arch: process.arch };

  let state = {
    phase: 'idle', // idle · checking · uptodate · available · downloading · installing · ready · manual · error
    current,
    platform: process.platform, // the page picks its texts by it (Finder / Explorer …)
    configured: !!feedUrl,
    canInstall: !!(bundle || installDir || appImage), // only the installed app replaces itself – never `npm run app`'s Electron
    update: null, // validated feed + { action, page, asset }
    progress: null, // { received, total }
    step: null, // installing: verify · mount · copy (macOS) · launch (Windows)
    error: null, // download / install failure (shown in the banner)
    checkError: null, // last failed check (shown in Settings; BAD_SIGNATURE also in the sidebar)
    checkedAt: null,
    reason: null, // why the manual route was taken
    updatedFrom: null, // first start after an in-app update: the version that was replaced
  };
  // Written when the update is put in place, read once on the next start: the "Updated" toast must not depend on
  // the page's localStorage, whose origin changes when the fixed port is taken.
  const marker = join(app.getPath('userData'), 'update-from.json');
  try {
    const { from } = JSON.parse(readFileSync(marker, 'utf8'));
    rmSync(marker, { force: true });
    if (typeof from === 'string' && from !== current) state.updatedFrom = from.slice(0, 64);
  } catch {
    // no update since the last start
  }
  const writeMarker = () => {
    try {
      writeFileSync(marker, JSON.stringify({ from: current }));
    } catch {
      // only the toast depends on it
    }
  };
  let staged = null; // macOS: the new bundle next to the old one; Linux: the new AppImage next to the old one
  let download = null; // the verified DMG / installer / AppImage
  let abort = null;
  let swapped = false;
  const plan = windowsInstallPlan(); // Windows: when the installer may start (only once the quit is certain)
  const set = (patch) => {
    state = { ...state, ...patch };
    send('update', state);
    return state;
  };

  // Leftovers of the previous update: the replaced old bundle and the downloaded DMG / installer – right at the start,
  // before anything new is downloaded. On Windows the installer that just updated the app may still be finishing
  // (it starts the new version itself): a file it still holds is skipped and goes on the next start.
  if (bundle) {
    try {
      cleanupStaging(bundle);
      rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('update cleanup failed:', e.message);
    }
  } else if (installDir) {
    cleanupWorkDir(workDir, { keep: download });
  } else if (appImage) {
    cleanupAppImageStaging(appImage);
    cleanupWorkDir(workDir);
  }

  async function check({ manual = false } = {}) {
    if (!feedUrl || BUSY.includes(state.phase) || state.phase === 'checking') return state;
    const prev = state.phase;
    set({ phase: 'checking', checkError: null });
    try {
      requirePackagedPublicKey(app.isPackaged, publicKey);
      const feed = await fetchFeed(feedUrl, { allowLocal, publicKey });
      // A release without a download for this platform (e.g. macOS only) is no update here.
      const action = actionFor(feed, current, target); // (minVersion never sends Windows to the manual route)
      if (action === 'none') return set({ phase: 'uptodate', update: null, checkedAt: Date.now() });
      const asset = assetFor(feed, target.platform, target.arch);
      return set({ phase: 'available', update: { ...feed, action, asset, page: pageFor(feed) }, error: null, checkedAt: Date.now() });
    } catch (e) {
      if (!manual || e.code === 'BAD_SIGNATURE' || e.code === 'NO_PUBLIC_KEY') console.warn('update check failed:', e.code || '', e.message);
      // A refused signature / missing key is shown in the sidebar too (UpdateBanner); nothing of that feed is used.
      return set({ phase: prev === 'available' || prev === 'error' ? prev : 'idle', checkError: { code: e.code || null, message: e.message }, checkedAt: Date.now() });
    }
  }

  // Not replaceable in place (read-only location, translocated, blocked, not installed by the installer): hand the
  // verified download to the user – macOS opens the DMG's Finder window, Windows shows the installer in Explorer,
  // Linux shows the (executable) AppImage in the file manager.
  async function manualRoute(reason) {
    const dest = join(app.getPath('downloads'), assetName(state.update));
    if (download !== dest) {
      rmSync(dest, { force: true });
      try {
        renameSync(download, dest);
      } catch {
        copyFileSync(download, dest);
        rmSync(download, { force: true });
      }
      download = dest;
    }
    let err = null;
    if (LINUX) {
      try {
        makeExecutable(dest); // ready to double-click
      } catch (e) {
        console.warn('chmod of the downloaded AppImage failed:', e.message);
      }
    }
    if (WIN || LINUX) shell.showItemInFolder(dest); // never run it from here – the user starts it once the app is closed
    else err = await shell.openPath(dest); // mounts it and opens its Finder window
    return set({ phase: 'manual', reason, step: null, progress: null, error: err || null });
  }

  async function install() {
    const u = state.update;
    if (!u || !['available', 'error'].includes(state.phase)) return state;
    if (updateAction(u, current) === 'none') return set({ phase: 'error', error: 'Refusing to install an older or the same version' });
    const asset = u.asset;
    if (!asset) return set({ phase: 'error', error: 'This update has no download for this computer' });
    abort = new AbortController();
    // Linux: straight into the AppImage's folder when it can be replaced there (the swap is then a single rename).
    const inPlace = appImage && canReplaceAppImage(appImage).ok ? appImageStagedPath(appImage) : null;
    const file = inPlace || join(workDir, assetName(u));
    set({ phase: 'downloading', progress: { received: 0, total: asset.size }, error: null, step: null });
    try {
      mkdirSync(workDir, { recursive: true });
      let last = 0;
      await downloadFile(asset.url, file, {
        size: asset.size, sha256: asset.sha256, allowLocal, signal: abort.signal,
        onProgress: (p) => {
          const now = Date.now();
          if (now - last > 200 || p.received === p.total) { last = now; set({ progress: p }); }
        },
      });
      abort = null;
      download = file;
      set({ phase: 'installing', step: 'verify' });
      await verifyFile(file, asset); // once more from disk – what gets installed is exactly what was checked
      if (WIN) {
        if (!installDir) return manualRoute(app.isPackaged ? 'portable' : 'dev');
        // The installer runs when the app quits ("Restart now", or later) – it closes the app to replace it.
        return set({ phase: 'ready', step: null, progress: null });
      }
      if (LINUX) {
        if (!appImage) return manualRoute(app.isPackaged ? 'not-appimage' : 'dev');
        if (!inPlace) return manualRoute(canReplaceAppImage(appImage).reason || 'read-only');
        makeExecutable(file);
        staged = file; // put in place on "Restart now", or when the app quits after "Later"
        return set({ phase: 'ready', step: null, progress: null });
      }
      if (!bundle || u.action === 'manual') return manualRoute(!bundle ? 'dev' : 'minVersion');
      const can = canReplace(bundle);
      if (!can.ok) return manualRoute(can.reason);
      try {
        staged = await stageFromDmg({ dmg: file, bundle, version: u.version, log: (step) => set({ step }) });
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
    if (LINUX) swapAppImage(appImage, staged);
    else swapBundle(bundle, staged);
    swapped = true;
    writeMarker();
    return true;
  }

  async function restart() {
    if (state.phase !== 'ready') return state;
    if (WIN) {
      set({ phase: 'installing', step: 'launch' });
      try {
        await verifyFile(download, state.update.asset); // it sat in the temp folder since the download
      } catch (e) {
        download = null;
        return set({ phase: 'error', error: e.message, step: null });
      }
      // Only quit here: the installer starts in will-quit, when closing can't be called off any more (the
      // unsaved-progress question may still keep the game open – then the card goes back to "Restart now").
      plan.restart();
      app.quit();
      return state;
    }
    if (LINUX) {
      set({ phase: 'installing', step: 'verify' });
      try {
        await verifyFile(staged, state.update.asset); // it sat next to the AppImage since the download
      } catch (e) {
        staged = null;
        download = null;
        cleanupAppImageStaging(appImage);
        return set({ phase: 'error', error: e.message, step: null });
      }
      // back to "ready": if the unsaved-progress question keeps the app open, the card offers the restart again
      set({ phase: 'ready', step: null });
    }
    try {
      swap();
    } catch (e) {
      // e.g. macOS "App Management" privacy setting blocked replacing the app – let the user do it in the Finder.
      console.warn('replacing the app failed:', e.message);
      staged = null;
      return manualRoute(LINUX ? 'copy-failed' : 'blocked');
    }
    // Starts the (new) app once this one has exited. Linux: the AppImage file itself – the binary this process runs
    // from lives in the old AppImage's mount, which goes away with it.
    if (LINUX) app.relaunch(appImageRelaunch(appImage));
    else app.relaunch();
    app.quit();
    return state;
  }

  // The quit was called off (unsaved progress → "keep playing", electron/main.mjs): no installer, back to "ready".
  app.on('sls-quit-cancelled', () => {
    if (WIN && plan.quitCancelled() && state.phase === 'installing') set({ phase: 'ready', step: null });
  });

  // Quitting for good. Windows: start the installer now – after "Restart now" it starts the new version when done,
  // after "Later" it only installs. (The spawn happens synchronously, before the app is gone; it was verified.)
  // macOS / Linux: a staged update ("Later") is put in place, so the next start is the new version.
  app.on('will-quit', () => {
    if (WIN) {
      const go = plan.willQuit({ ready: state.phase === 'ready', installer: download });
      if (!go) return;
      launchInstaller(download, go).catch((e) => console.warn('starting the installer on quit failed:', e.message));
      writeMarker();
      return;
    }
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
  handle('update-show', () => {
    if (!download || !existsSync(download)) return null;
    if (WIN || LINUX) return shell.showItemInFolder(download); // showing, not running the installer / AppImage
    return shell.openPath(download);
  });

  if (feedUrl) {
    setTimeout(() => check(), FIRST_CHECK);
    setInterval(() => check(), CHECK_EVERY);
  }
  return { check };
}
