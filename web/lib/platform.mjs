// Which computer the app runs on – for texts and shortcuts: ⌘ / Finder / "Search my Mac" on macOS,
// Ctrl / Explorer / "Search my PC" on Windows, Ctrl / the file manager / "Search my PC" on Linux. The desktop app says it (preload: window.sls.platform);
// in a browser (`npm start`) the browser's platform is used – the server runs on the same computer.
import { t } from './i18n.mjs';

const KNOWN = ['darwin', 'win32', 'linux'];

/** 'darwin' | 'win32' | 'linux' from the preload bridge, else from the browser's navigator. */
export function detectPlatform(env = globalThis) {
  const fromApp = env.sls?.platform;
  if (KNOWN.includes(fromApp)) return fromApp;
  const nav = env.navigator;
  const s = `${nav?.userAgentData?.platform || ''} ${nav?.platform || ''} ${nav?.userAgent || ''}`;
  if (/mac|iphone|ipad/i.test(s)) return 'darwin';
  if (/win/i.test(s)) return 'win32';
  return 'linux';
}

export const PLATFORM = detectPlatform();
export const IS_MAC = PLATFORM === 'darwin';
export const IS_WIN = PLATFORM === 'win32';
export const IS_LINUX = PLATFORM === 'linux';

// <html class="platform-win32"> – styles.css keeps the corner under the Windows title bar buttons free
// (platform-linux: a normal window frame, no room needed)
if (typeof document !== 'undefined') document.documentElement.classList.add(`platform-${PLATFORM}`);

/**
 * A keyboard shortcut for display: 'Mod+B' → '⌘B' on a Mac, 'Ctrl+B' elsewhere (German keyboards: 'Strg+B').
 * Modifiers: Mod (⌘ on a Mac, Ctrl elsewhere), Ctrl, Shift, Alt. `space`: '⌘ B' / '⇧ 1–4' (Mac only, the
 * look of the shortcut tables).
 */
export function shortcut(combo, { mac = IS_MAC, space = false } = {}) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  const names = mac
    ? { mod: '⌘', cmd: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥' }
    : { mod: t('key.ctrl', 'Ctrl'), ctrl: t('key.ctrl', 'Ctrl'), shift: t('key.shift', 'Shift'), alt: t('key.alt', 'Alt') };
  const mods = parts.map((m) => names[m.toLowerCase()] || m);
  if (mac) return `${mods.join('')}${space && mods.length ? ' ' : ''}${key}`;
  return [...mods, key].join('+');
}

/**
 * A file's place for display, shortened: ~/…, iCloud Drive, OpenEmu on a Mac; ~\\…, OneDrive… on Windows; ~/… on
 * Linux (/home/<user>, /var/home/<user> on Fedora Atomic / Bazzite).
 */
export function shortPath(p) {
  return String(p)
    .replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/, 'iCloud Drive')
    .replace(/^\/Users\/[^/]+\/Library\/Application Support\/OpenEmu\/Game Library/, 'OpenEmu').replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/storage\/emulated\/0(?=\/|$)/, 'Internal storage')
    .replace(/^\/(?:var\/)?home\/[^/]+(?=\/|$)/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\(OneDrive[^\\]*)/i, '$1').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
}

/**
 * Sounds checkbox text: "this computer" on a computer, "this device" on a phone or tablet (IS_TOUCH, defined below – read
 * when called, not at load).
 */
export const soundsText = () => (IS_TOUCH
  ? t('set.soundsDevice', 'Sounds on this device (start-up chime, catches, deaths, badges, pings)')
  : t('set.soundsAll', 'Sounds on this computer (start-up chime, catches, deaths, badges, pings)'));

/** The Android app (its WebView says Android). */
export const IS_ANDROID = (() => {
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
})();

/** An iPhone or iPad: the app there has no randomizer (no Java), no 3DS player (no JIT) and no way to scan the device. */
export const IS_IOS = (() => {
  try {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  } catch {
    return false;
  }
})();

/**
 * A touch screen is the main way to point (a phone or tablet – not a laptop with a touch screen next to a mouse): the
 * game fills the screen and its controls sit in an overlay (views/play.mjs, styles.css .touch-play). `?touch=1` / `?touch=0`
 * in the address forces it, for a browser that reports its screen wrongly (desktop mode on a tablet).
 */
export const IS_TOUCH = (() => {
  try {
    const forced = new URLSearchParams(location.hash.split('?')[1] || location.search).get('touch');
    if (forced) return forced === '1';
    return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
})();
