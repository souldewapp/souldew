// Colour scheme of the whole app: html[data-theme] (styles.css). Remembered in localStorage as well, so the
// page starts in the right colours before the server's config has loaded.
const KEY = 'sl-theme';
export const THEME_IDS = ['classic', 'contrast', 'deutan', 'tritan'];

/** Windows: the title bar buttons (drawn by Windows over the page) take the colours of the page's top edge. */
function syncTitleBar() {
  if (window.sls?.platform !== 'win32' || !window.sls.setTitleBarColors) return;
  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (/^#[0-9a-f]{6}$/i.test(css.getPropertyValue(name).trim()) ? css.getPropertyValue(name).trim() : fallback);
  window.sls.setTitleBarColors({ color: pick('--bg-top', '#1c1b21'), symbolColor: pick('--ink', '#ebe6da') });
}

export function applyTheme(id) {
  const theme = THEME_IDS.includes(id) ? id : 'classic';
  if (theme === 'classic') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  syncTitleBar();
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage blocked – the config still has it
  }
}

/** Before the first render: the last scheme used on this computer. */
export function applyStoredTheme() {
  try {
    applyTheme(localStorage.getItem(KEY) || 'classic');
  } catch {
    applyTheme('classic');
  }
}
