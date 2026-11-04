// Which computer the app runs on – for texts and shortcuts: ⌘ / Finder / "Search my Mac" on macOS,
// Ctrl / Explorer / "Search my PC" on Windows (and Linux). The desktop app says it (preload: window.sls.platform);
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

// <html class="platform-win32"> – styles.css keeps the corner under the Windows title bar buttons free
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

/** A file's place for display, shortened: ~/…, iCloud Drive, OpenEmu on a Mac; ~\\…, OneDrive… on Windows. */
export function shortPath(p) {
  return String(p)
    .replace(/^\/Users\/[^/]+\/Library\/Mobile Documents\/com~apple~CloudDocs/, 'iCloud Drive')
    .replace(/^\/Users\/[^/]+\/Library\/Application Support\/OpenEmu\/Game Library/, 'OpenEmu').replace(/^\/Users\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+\\(OneDrive[^\\]*)/i, '$1').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
}
