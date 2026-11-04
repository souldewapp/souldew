// Colour scheme of the whole app: html[data-theme] (styles.css). Remembered in localStorage as well, so the
// page starts in the right colours before the server's config has loaded.
const KEY = 'sl-theme';
export const THEME_IDS = ['classic', 'contrast', 'deutan', 'tritan'];

export function applyTheme(id) {
  const theme = THEME_IDS.includes(id) ? id : 'classic';
  if (theme === 'classic') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
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
