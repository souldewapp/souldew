// A run's rule defaults – SoulLink and solo Nuzlocke – shared by the app (web/lib/run.mjs) and the open stream API
// (shared/streamapi.mjs), which shows a run's rules with the defaults filled in.

export const DEFAULT_RULES = {
  typeClause: 'global',
  dupes: 'player',
  shinyClause: true,
  gifts: 'area', // 'area' (a gift is that area's encounter) | 'free' | 'banned' – older docs say giftsCount: true/false
  giftsCount: true,
  levelCaps: true,
  failKillsPair: true,
  autoAssign: true,
  autoDeath: true,
  sounds: true,
  cheats: false, // the play screen's cheats (Rare Candies) – off until the run allows them; every use goes to the log
  // (the Discord webhook is not a rule: it stays on this computer – GET/PUT /api/runs/:id/discord)
};

// Solo Nuzlocke rules. A preset only sets the rule toggles; tool settings (autoAssign, sounds) stay as they are.
const CLASSIC = {
  autoDeath: true, // faint = dead
  blackout: 'party', // 'party' (a whiteout ends the run) | 'box' (only when nothing alive is left anywhere) | 'off'
  deathless: false, // the first death ends the run
  dupes: 'line', // 'off' | 'species' | 'line' (dead ones count too)
  shinyClause: true,
  gifts: 'area',
  statics: 'area', // 'area' | 'free' | 'banned'
  nicknames: false,
  levelCaps: false, // false | 'warn' | 'strict'
  noBattleItems: false,
  setMode: false,
  centerLimit: 0, // Pokémon Center visits per badge, 0 = no limit (counted by hand)
  typeClause: 'off', // 'off' | 'party'
};
export const RULE_PRESETS = {
  classic: CLASSIC,
  hardcore: { ...CLASSIC, levelCaps: 'strict', noBattleItems: true, setMode: true },
};
export const NUZLOCKE_RULES = { ...CLASSIC, autoAssign: true, sounds: true };

/** The run's rules: the stored `rules` over the defaults of its mode ('soullink' | 'nuzlocke'). */
export function rulesWithDefaults(stored, mode) {
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const r = { ...(mode === 'nuzlocke' ? { ...DEFAULT_RULES, ...NUZLOCKE_RULES } : DEFAULT_RULES), ...s };
  // `giftsCount` (true/false) came first; `gifts` is the same rule with a third option
  if (s.gifts === undefined && s.giftsCount !== undefined) r.gifts = s.giftsCount ? 'area' : 'free';
  r.giftsCount = r.gifts !== 'free';
  return r;
}
