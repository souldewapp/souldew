// The "Buy me a coffee" button's little Pokémon moments: when one may play and which. Pure – the timer and the
// pixels live in views/coffee.mjs.

export const COFFEE_FX = {
  MIN_MS: 3 * 60 * 1000, // the next one comes 3–8 minutes after the last (and after the start)
  MAX_MS: 8 * 60 * 1000,
  MAX_PER_SESSION: 6, // then the button stays quiet until the app restarts
};

/**
 * The variants: `mon` = the National Dex number of the Pokémon in it (gen 3 pixel sprite, served and cached by the
 * app like every other sprite), `ms` = how long it runs, `float` = also fits the small folded-rail button.
 */
export const COFFEE_VARIANTS = {
  peek: { mon: 25, ms: 3200 }, // Pikachu peeks out of the cup, hops onto it and sparks
  nap: { mon: 143, ms: 3600 }, // Snorlax naps on the cup – Z z z
  ball: { mon: 175, ms: 3000 }, // a Poké Ball lands on the cup, wobbles three times and pops: Togepi!
  hop: { mon: 39, ms: 2800 }, // Jigglypuff hops along the button, singing
};

/** Milliseconds until the next moment (`rand` → [0, 1)). */
export function nextDelay(rand = Math.random) {
  return Math.round(COFFEE_FX.MIN_MS + rand() * (COFFEE_FX.MAX_MS - COFFEE_FX.MIN_MS));
}

/** A variant other than the last one (two in a row of the same feel like a loop). */
export function pickVariant(last = null, rand = Math.random) {
  const ids = Object.keys(COFFEE_VARIANTS).filter((id) => id !== last);
  return ids[Math.min(ids.length - 1, Math.floor(rand() * ids.length))];
}

/** The sprite of a variant's Pokémon. */
export const variantSprite = (id) => `/sprites/gen3/${COFFEE_VARIANTS[id].mon}.png`;

/**
 * Why a moment must not play now (null = it may). Never during play – a game is running (full or in the corner),
 * the game's fullscreen, the boot screen or onboarding –, never with a dialog open, the window in the background,
 * "reduce motion" asked for, once the button was clicked or after MAX_PER_SESSION.
 */
export function fxBlocked({ busy = false, hidden = false, reducedMotion = false, dialogOpen = false, clicked = false, shown = 0 } = {}) {
  if (reducedMotion) return 'reducedMotion';
  if (clicked) return 'clicked';
  if (shown >= COFFEE_FX.MAX_PER_SESSION) return 'enough';
  if (busy) return 'busy';
  if (hidden) return 'hidden';
  if (dialogOpen) return 'dialog';
  return null;
}
