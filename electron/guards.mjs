// Security checks for the Electron shell: navigation, external links, permissions and IPC senders – and the window size.
// Pure functions (no 'electron' import), so they are testable with node --test (test/guards.test.mjs).

/** Origin of a URL ('http://localhost:47390'), or null when it can't be parsed / has no real origin. */
export function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

/**
 * Same scheme, host and port. Unlike `url.startsWith(appUrl)` this can't be fooled by
 * 'http://localhost:47390@evil.com/' or 'http://localhost:473901/'.
 */
export function sameOrigin(url, appUrl) {
  const a = originOf(url);
  return !!a && a === originOf(appUrl);
}

/** The URL to hand to shell.openExternal, or null: only https:, never with user name / password. */
export function safeExternalUrl(url) {
  if (typeof url !== 'string' || url.length > 4096) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  return u.href;
}

/** Where a subframe (the emulator iframe) may navigate: the app itself, or an empty document. */
export function subframeNavigationAllowed(url, appUrl) {
  return sameOrigin(url, appUrl) || url === 'about:blank' || url === 'about:srcdoc';
}

/**
 * Permissions the app actually uses: fullscreen (Play view + emulator iframe) and writing text to the
 * clipboard (copy buttons, navigator.clipboard.writeText). Audio autoplay is a command-line switch, not a
 * permission; WebRTC with a canvas stream needs no 'media' permission; pointer lock is disabled on purpose
 * (web/player.html). Everything else is denied.
 */
export const APP_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** Allow `permission` only for the app's own origin (`requestingUrl` may be a full URL or an origin). */
export function permissionAllowed(permission, requestingUrl, appUrl) {
  return APP_PERMISSIONS.has(permission) && !!appUrl && sameOrigin(requestingUrl, appUrl);
}

/**
 * IPC may only come from the app window's main frame while it shows the app origin (not from an iframe,
 * another window or a page it navigated to). `event` is an ipcMain event, `webContents` the app window's.
 */
export function isTrustedIpcSender(event, webContents, appUrl) {
  if (!event || !webContents || !appUrl) return false;
  if (event.sender !== webContents) return false;
  const frame = event.senderFrame;
  if (!frame) return false; // the frame navigated away or was destroyed meanwhile
  const main = webContents.mainFrame;
  const isMain = frame === main || (!frame.parent && !!main && frame.processId === main.processId && frame.routingId === main.routingId);
  return isMain && sameOrigin(frame.url, appUrl);
}

/**
 * Colours for the Windows title bar buttons, sent by the page ({ color, symbolColor }): only plain #rrggbb values
 * are passed on to win.setTitleBarOverlay – anything else is ignored (null).
 */
export function titleBarColors(colors) {
  if (!colors || typeof colors !== 'object') return null;
  const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);
  const color = hex(colors.color);
  const symbolColor = hex(colors.symbolColor);
  return color && symbolColor ? { color, symbolColor } : null;
}

/**
 * The window's first size: 1360×880 (at least 980×640), but never larger than the screen's work area – the Steam Deck
 * has 1280×800, small laptops less. `workArea` is screen.getPrimaryDisplay().workAreaSize (null: unknown).
 */
export function initialWindowSize(workArea) {
  const size = { width: 1360, height: 880, minWidth: 980, minHeight: 640 };
  const w = Number(workArea?.width);
  const h = Number(workArea?.height);
  if (!(w > 0 && h > 0)) return size;
  const width = Math.min(size.width, Math.floor(w));
  const height = Math.min(size.height, Math.floor(h));
  return { width, height, minWidth: Math.min(size.minWidth, width), minHeight: Math.min(size.minHeight, height) };
}
