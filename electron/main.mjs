// souldew – desktop app shell (macOS, Windows and Linux).
// Starts the local server in-process on a free port and shows the UI in a native window.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, session, powerSaveBlocker, screen } from 'electron';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';
import { setupUpdater } from './updater.mjs';
import { appImageFromEnv, appImageRelaunch } from './update-core.mjs';
import { writeFileAtomic } from '../server/lib/fsutil.mjs';
import { chromiumSwitches, startDecision, crashDecision, gpuInfoSummary } from '../shared/gpu.mjs';
import { sameOrigin, safeExternalUrl, subframeNavigationAllowed, permissionAllowed, isTrustedIpcSender, titleBarColors, initialWindowSize } from './guards.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const LINUX = process.platform === 'linux';
app.setName('souldew');
// Windows: the same id as the installer's shortcuts (package.json → build.appId), so the taskbar groups the window
// with a pinned shortcut and shows the app's own name and icon.
if (WIN) app.setAppUserModelId('studio.soullink.app');
// The app used to be called "SoulLink Studio": its data folder keeps that name, so runs, saves, settings and the
// web storage (localStorage, EmulatorJS' IndexedDB) carry over after the rename. (macOS: ~/Library/Application
// Support/SoulLink Studio, Windows: %APPDATA%\SoulLink Studio, Linux: ~/.config/SoulLink Studio – $XDG_CONFIG_HOME.)
// An explicit --user-data-dir (tests, a second profile) still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'SoulLink Studio'));
// Boot chime + emulator audio without a prior click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The game must keep running when the window is covered by another app: without these Chromium treats an
// occluded window as hidden and stops drawing it – the emulator, live tracking and the partner's picture freeze.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Writable data lives in the data folder (see above); bundled tools sit next to the code.
process.env.SLS_DATA_DIR = app.getPath('userData');
process.env.SLS_TOOLS_DIR = app.isPackaged ? join(process.resourcesPath, 'tools') : join(here, '..', 'tools');
// Where "Search my Mac / PC" looks first: the real Downloads / Desktop / Documents folders (Windows may have moved
// them to OneDrive or another drive, Linux names them per language in ~/.config/user-dirs.dirs – Electron knows both).
process.env.SLS_USER_DIRS = JSON.stringify(['downloads', 'desktop', 'documents'].map((k) => {
  try {
    return app.getPath(k);
  } catch {
    return null;
  }
}).filter(Boolean));

// A second start only brings the running window to the front (second-instance below) – it must not boot a server
// and a window of its own while app.quit() is still on its way.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

// config.json in the data folder – the file the server reads and writes (server/lib/paths.mjs CONFIG_PATH with
// SLS_DATA_DIR = userData). The graphics backend has to be read from it here, before the app is ready.
const CONFIG_FILE = join(app.getPath('userData'), 'config.json');
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function patchConfig(patch) {
  if (!patch) return;
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileAtomic(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch (e) {
    console.warn('writing config.json failed:', e.message);
  }
}

// Graphics backend (Settings › General, shared/gpu.mjs) plus the power-user flags from SOULDEW_CHROMIUM_FLAGS. Only
// the first instance counts its start – a second one quits right away. A start that never shows the window with a
// chosen backend is remembered (gpuStart); after a few of them the backend goes back to "Automatic".
const gpu = { backend: 'auto', switches: [], pending: false };
if (primary) {
  const { backend, patch } = startDecision(readConfig(), process.platform);
  patchConfig(patch);
  gpu.backend = backend;
  gpu.pending = backend !== 'auto';
  gpu.switches = chromiumSwitches({ backend, platform: process.platform, envFlags: process.env.SOULDEW_CHROMIUM_FLAGS || '' });
  for (const [name, value] of gpu.switches) {
    if (value == null) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
}
/** The window showed (or the start failed for another reason): this start doesn't count against the backend. */
function gpuStartOk() {
  if (!gpu.pending) return;
  gpu.pending = false;
  patchConfig({ gpuStart: null });
}
// A GPU process that keeps crashing with a chosen backend: the next start uses "Automatic" (and says so once). Only
// while the setting still is the backend this session runs with – a newer choice of the user stays.
let gpuCrashes = 0;
// Every child process that went away, with the time (for "Save diagnostics": a GPU process restart takes the game's
// graphics context and, with it, its sound – the emulator then re-inits its audio in a new AudioContext).
const goneLog = [];
app.on('child-process-gone', (e, details) => {
  goneLog.push({ at: new Date().toISOString(), type: details?.type ?? null, reason: details?.reason ?? null, exitCode: details?.exitCode ?? null });
  if (goneLog.length > 20) goneLog.shift();
  if (details?.type !== 'GPU' || details.reason === 'clean-exit') return;
  gpuCrashes++;
  console.warn(`GPU process gone (${details.reason}, ${gpuCrashes}×)`);
  const patch = crashDecision(gpu.backend, gpuCrashes);
  if (patch && readConfig().gpuBackend === gpu.backend) patchConfig(patch);
});

let win = null;
let serverUrl = null;

async function boot() {
  const { startServer } = await import('../server/app.mjs');
  // A fixed port keeps the page origin stable, so localStorage and EmulatorJS' IndexedDB survive
  // restarts; only if it's taken fall back to a random one.
  const { url } = await startServer({ port: 47390 }).catch((e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    return startServer({ port: 0 });
  });
  serverUrl = url;
  createWindow();
}

/** Height of the title bar area on Windows (window buttons drawn over the page, styles.css .platform-win32). */
const TITLEBAR_HEIGHT = 36;

/**
 * The window frame per platform. macOS: the page reaches under the title bar, traffic lights inset at the top left.
 * Windows: likewise, with the minimize / maximize / close buttons drawn by Windows over the top right corner in the
 * app's colours (titleBarOverlay; the page keeps that corner free and makes the top strip draggable). There is no
 * visible menu bar on Windows – the menu's keyboard shortcuts still work. Linux: the desktop's own frame and title
 * bar (window decorations differ between GNOME, KDE, Steam Deck's desktop mode … and X11 / Wayland, so the app doesn't
 * draw its own); the menu bar stays hidden until Alt is pressed. The page needs no room for window buttons there
 * (styles.css .platform-linux).
 */
function windowChrome() {
  if (MAC) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } };
  if (WIN) return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#1c1b21', symbolColor: '#ebe6da', height: TITLEBAR_HEIGHT } };
  return { autoHideMenuBar: true };
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  // Never larger than the screen: the Steam Deck's is 1280×800, smaller than the window's usual size.
  let workArea = null;
  try {
    workArea = screen.getPrimaryDisplay().workAreaSize;
  } catch {
    // no display information – the usual size
  }
  win = new BrowserWindow({
    ...initialWindowSize(workArea),
    title: 'souldew',
    backgroundColor: '#1b1a1f',
    ...windowChrome(),
    // the window / taskbar icon when running from source (`npm run app`) – and always on Linux, where X11 window
    // managers take it from the window (a packaged app elsewhere uses the icon of its .exe / .app)
    ...((!app.isPackaged && !MAC) || LINUX ? { icon: join(here, '..', 'build', 'icon.png') } : {}),
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep the emulator and live sync running when the window is behind others
    },
  });
  win.once('ready-to-show', () => {
    gpuStartOk();
    win.show();
  });
  // Window fullscreen (macOS: green button / ⌃⌘F, Windows / Linux: F11): the page folds the side rail away
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
  win.webContents.on('did-finish-load', () => send('fullscreen', win.isFullScreen()));
  win.loadURL(serverUrl);
  // External links open in the default browser, never inside the app – and only https links. The app never
  // opens a second window of its own (it would get the preload bridge), so new windows are always denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // Origin comparison, not startsWith: 'http://localhost:47390@evil.com/' starts with the app URL.
  win.webContents.on('will-navigate', (e) => {
    if (sameOrigin(e.url, serverUrl)) return;
    e.preventDefault();
    openExternalSafe(e.url);
  });
  // The emulator iframe (and any other subframe) stays on the app origin; it never opens anything outside.
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || subframeNavigationAllowed(e.url, serverUrl)) return;
    e.preventDefault();
  });
  // A server-side redirect must not leave the app origin either (main frame or iframe).
  win.webContents.on('will-redirect', (e) => {
    if (sameOrigin(e.url, serverUrl)) return;
    e.preventDefault();
  });
  // Closing the window (or quitting – Cmd+Q / Alt+F4 close it too) while the game has progress since the last
  // in-game save asks first. The page reports that state with its texts in the UI language.
  win.webContents.on('did-navigate', () => {
    unsaved = null; // a reloaded page reports again once its game runs
  });
  win.on('close', (e) => {
    if (closeOk || !unsaved) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    const u = unsaved;
    dialog.showMessageBox(win, { type: 'warning', buttons: [u.keep, u.quit], defaultId: 0, cancelId: 0, message: u.title, detail: u.text })
      .then(({ response }) => {
        if (response !== 1) {
          app.emit('sls-quit-cancelled'); // e.g. a pending update install must not start (electron/updater.mjs)
          return;
        }
        closeOk = true;
        app.quit();
      })
      .finally(() => {
        asking = false;
      });
  });
  win.on('closed', () => {
    win = null;
  });
}

let unsaved = null; // { title, text, keep, quit } while the running game has unsaved in-game progress
let closeOk = false;
let asking = false;
/** IPC is only answered for the app window's main frame on the app origin (see guards.mjs). */
const trusted = (e) => isTrustedIpcSender(e, win?.webContents, serverUrl);
/** ipcMain.handle with the sender check: anything else gets an error instead of the handler. */
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!trusted(e)) throw new Error('Not allowed');
  return fn(e, ...args);
});
const openExternalSafe = (url) => {
  const safe = safeExternalUrl(url);
  if (safe) shell.openExternal(safe);
};

ipcMain.on('unsaved', (e, info) => {
  if (!trusted(e)) return;
  const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  const u = info && typeof info === 'object' ? { title: str(info.title, 200), text: str(info.text, 1000), keep: str(info.keep, 60), quit: str(info.quit, 60) } : null;
  unsaved = u && u.title && u.keep && u.quit ? u : null;
});

// While a game runs the display stays on: playing with a controller, the OS sees no input and would dim and sleep
// mid-battle. (EmulatorJS asks for a screen wake lock itself – Electron has no permission for it.)
let awake = null;
ipcMain.on('playing', (e, on) => {
  if (!trusted(e)) return;
  if (on && awake === null) awake = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awake !== null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
});

const send = (channel, ...args) => win?.webContents.send(channel, ...args);

// The menu bar speaks the app's language: the page sends its labels once it knows the language, and on every change.
ipcMain.on('menu-labels', (e, labels) => {
  if (!trusted(e) || !labels || typeof labels !== 'object') return;
  buildMenu(labels);
});

// Windows: the window buttons take the colour of the page's top edge (it changes with Settings › Appearance).
ipcMain.on('titlebar-colors', (e, colors) => {
  if (!trusted(e) || !WIN || !win) return;
  const c = titleBarColors(colors);
  if (c) win.setTitleBarOverlay({ ...c, height: TITLEBAR_HEIGHT });
});

/**
 * labels: the page's texts in the app language (see 'menu-labels'); German until the page has sent them.
 * macOS gets the usual app menu; Windows has no visible menu bar (titleBarOverlay), so there the menu only carries
 * the keyboard shortcuts (Ctrl instead of ⌘, F11 for fullscreen) – Settings and Quit move into "File". Linux: the same
 * menu as Windows, hidden until Alt is pressed (autoHideMenuBar).
 */
function buildMenu(labels = {}) {
  const l = (key, fallback) => (typeof labels[key] === 'string' && labels[key] ? labels[key].slice(0, 80) : fallback);
  const nav = (route) => () => send('navigate', route);
  const emu = (action) => () => send('emu', action);
  const settings = { label: l('settings', 'Einstellungen …'), accelerator: 'CmdOrCtrl+,', click: nav('settings') };
  const template = [
    ...(MAC ? [{
      label: 'souldew',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settings,
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: l('file', 'Ablage'),
      submenu: [
        { label: l('addGames', 'Spiele hinzufügen …'), accelerator: 'CmdOrCtrl+O', click: () => send('menu', 'add-games') },
        { label: l('revealLibrary', MAC ? 'Bibliotheksordner im Finder' : WIN ? 'Bibliotheksordner im Explorer' : 'Bibliotheksordner im Dateimanager'), click: () => send('menu', 'reveal-library') },
        { type: 'separator' },
        // Windows: no Ctrl+W – it would close the window and with it the app; Alt+F4 does that the Windows way
        ...(MAC ? [{ role: 'close' }] : [settings, { type: 'separator' }, { role: 'quit', label: l('quit', 'Beenden') }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: l('go', 'Gehe zu'),
      submenu: [
        { label: l('library', 'Bibliothek'), accelerator: 'CmdOrCtrl+1', click: nav('library') },
        { label: l('soullink', 'SoulLink'), accelerator: 'CmdOrCtrl+2', click: nav('soullink') },
        { label: l('nuzlocke', 'Nuzlocke'), accelerator: 'CmdOrCtrl+3', click: nav('nuzlocke') },
        { label: l('link', 'Verbindung'), accelerator: 'CmdOrCtrl+4', click: nav('link') },
        { label: l('stream', 'Stream'), accelerator: 'CmdOrCtrl+5', click: nav('stream') },
      ],
    },
    {
      label: l('emulator', 'Emulator'),
      submenu: [
        { label: l('pause', 'Pause / Weiter'), accelerator: 'P', registerAccelerator: false, click: emu('pause') },
        { label: l('turbo', 'Turbo umschalten'), accelerator: 'T', registerAccelerator: false, click: emu('turbo') },
        { label: l('faster', 'Schneller'), accelerator: 'CmdOrCtrl+Plus', click: emu('faster') },
        { label: l('slower', 'Langsamer'), accelerator: 'CmdOrCtrl+-', click: emu('slower') },
        { type: 'separator' },
        { label: l('quicksave', 'Schnellspeichern'), accelerator: 'F5', registerAccelerator: false, click: emu('quicksave') },
        { label: l('quickload', 'Schnellladen'), accelerator: 'F8', registerAccelerator: false, click: emu('quickload') },
        { label: l('screenshot', 'Screenshot'), accelerator: 'F12', registerAccelerator: false, click: emu('screenshot') },
        { label: l('mute', 'Ton an/aus'), accelerator: 'M', registerAccelerator: false, click: emu('mute') },
        { type: 'separator' },
        { label: l('fullscreen', 'Vollbild'), accelerator: MAC ? 'Ctrl+Cmd+F' : 'F11', role: 'togglefullscreen' },
      ],
    },
    ...(MAC ? [{ role: 'windowMenu' }] : []),
    {
      role: 'help',
      submenu: [
        { label: l('shortcuts', 'Tastenkürzel'), accelerator: 'CmdOrCtrl+/', click: () => send('menu', 'shortcuts') },
        { label: l('guide', 'Anleitung'), click: nav('guide') },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }, { role: 'reload' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

handle('pick-files', async (e, opts) => {
  if (!opts || typeof opts !== 'object') opts = {};
  const r = await dialog.showOpenDialog(win, {
    title: typeof opts.title === 'string' && opts.title ? opts.title.slice(0, 200) : 'Spiele hinzufügen',
    properties: opts.folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
    filters: opts.folder ? undefined : [
      { name: 'ROMs, Patches & Archive', extensions: ['gb', 'gbc', 'gba', 'nds', '3ds', 'cci', 'cxi', 'cia', '3dsx', 'zcci', 'zcxi', 'z3dsx', 'zip', 'xdelta', 'vcdiff', 'bps', 'ups', 'ips', 'json'] },
    ],
  });
  if (r.canceled || !r.filePaths?.length) return [];
  // Only dialog-picked paths (plus Search-my-PC / library roots) may hit /api/library/import|folders.
  const { approveLibraryPaths } = await import('../server/lib/library.mjs');
  approveLibraryPaths(r.filePaths);
  return r.filePaths;
});
handle('reveal', (e, path) => {
  // an absolute local path of this platform (/Users/… on macOS, C:\… on Windows, /home/… on Linux) – no network or device paths
  // (\\server\…, \\?\…, \\.\…): showing one would make Windows contact that server or open a device
  if (typeof path === 'string' && path.length < 4096 && isAbsolute(path) && !/^[\\/]{2}/.test(path) && !path.includes('\0')) shell.showItemInFolder(path);
});
handle('open-external', (e, url) => openExternalSafe(url));
handle('app-info', () => ({ version: app.getVersion(), packaged: app.isPackaged, dataDir: app.getPath('userData'), platform: process.platform }));
// The graphics backend this session runs with (Settings compares it with the saved one) and, for "Save diagnostics",
// the switches, Chromium's feature status and the graphics cards with their drivers.
handle('gpu-info', async () => {
  let info = null;
  try {
    info = gpuInfoSummary(await app.getGPUInfo('basic'));
  } catch {
    // no GPU information (e.g. the GPU process is down)
  }
  let featureStatus = null;
  try {
    featureStatus = app.getGPUFeatureStatus();
  } catch {}
  return { backend: gpu.backend, switches: gpu.switches.map(([n, v]) => (v == null ? `--${n}` : `--${n}=${v}`)), featureStatus, info, processesGone: goneLog.slice() };
});
// "Restart now" (e.g. after changing the graphics backend): quit as usual – the unsaved-progress question may still
// keep the game open – and start again once quitting is final. Linux: the AppImage file, as the updater does.
let relaunching = false;
handle('relaunch', () => {
  relaunching = true;
  app.quit();
});
app.on('sls-quit-cancelled', () => {
  relaunching = false;
});
app.on('will-quit', () => {
  if (!relaunching) return;
  const appImage = app.isPackaged && LINUX ? appImageFromEnv() : null;
  if (appImage) app.relaunch(appImageRelaunch(appImage));
  else app.relaunch();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!win && serverUrl) createWindow();
});

/**
 * Permissions: only what the app uses (guards.mjs APP_PERMISSIONS: fullscreen, clipboard write), only for the
 * app origin. Everything else – camera, microphone, notifications, geolocation, MIDI, HID/USB/serial,
 * pointer lock, external protocols … – is denied, for requests and for permission queries alike.
 */
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissionAllowed(permission, details?.requestingUrl || wc?.getURL?.() || '', serverUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, serverUrl));
  ses.setDevicePermissionHandler(() => false);
}

app.whenReady().then(async () => {
  if (!primary) return;
  setupPermissions();
  buildMenu();
  setupUpdater({ send, trusted });
  try {
    await boot();
  } catch (e) {
    gpuStartOk(); // not the graphics backend's fault – it doesn't count as a failed start
    dialog.showErrorBox('souldew konnte nicht starten', String(e?.stack || e));
    app.quit();
  }
});
