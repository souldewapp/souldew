// The parody "please buy a license" window (views/nag.mjs) – a joke on old shareware nag screens. souldew is free and
// stays free: the window only says thanks and points at the coffee link. When it may show up: pure, testable.

export const NAG = {
  FROM_LAUNCH: 5, // never in the first four launches
  CHANCE: 0.15, // then each launch has this chance …
  MIN_DAYS: 3, // … and never twice within this many days
};
const DAY = 86400000;

/** The stored state ({ launches, lastShown } in the config) cleaned up – junk becomes a fresh start. */
export function nagState(raw) {
  const launches = Number.isInteger(raw?.launches) && raw.launches >= 0 ? Math.min(raw.launches, 1e6) : 0;
  const lastShown = Number.isFinite(raw?.lastShown) && raw.lastShown > 0 ? raw.lastShown : null;
  return { launches, lastShown };
}

/** One more launch. */
export const countLaunch = (raw) => ({ ...nagState(raw), launches: nagState(raw).launches + 1 });

/**
 * Show it on this launch? `launches` already counts this one. `off`: switched off in Settings. A clock that went
 * backwards (lastShown in the future) counts as "just shown".
 */
export function shouldNag({ launches = 0, lastShown = null, off = false, now = Date.now(), rand = Math.random } = {}) {
  if (off || launches < NAG.FROM_LAUNCH) return false;
  if (lastShown && (now < lastShown || now - lastShown < NAG.MIN_DAYS * DAY)) return false;
  return rand() < NAG.CHANCE;
}
