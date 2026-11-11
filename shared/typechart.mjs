// Type effectiveness. Gen 1–5: no Fairy, Steel still resists Ghost and Dark – ROM hacks that add the Fairy type
// (Renegade Platinum, Blaze Black 2 Redux – shared/live/romspecies.mjs romTypes) get its Gen 6 matchups on top.
// Gen 6 on (X/Y to Ultra Sun/Ultra Moon): Fairy is there, and Steel takes Ghost and Dark normally.
// Gen 1 differences: no Dark/Steel, Ghost → Psychic does nothing (the famous bug), Bug ↔ Poison
// are super effective on each other, and Ice → Fire is neutral.

export const TYPES = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel',
  'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];

// attacker → { defender: multiplier } for everything that isn't 1×
const CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fighting: { normal: 2, flying: 0.5, poison: 0.5, rock: 2, bug: 0.5, ghost: 0, steel: 2, psychic: 0.5, ice: 2, dark: 2 },
  flying: { fighting: 2, rock: 0.5, bug: 2, steel: 0.5, grass: 2, electric: 0.5 },
  poison: { poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, grass: 2 },
  ground: { flying: 0, poison: 2, rock: 2, bug: 0.5, steel: 2, fire: 2, grass: 0.5, electric: 2 },
  rock: { fighting: 0.5, flying: 2, ground: 0.5, bug: 2, steel: 0.5, fire: 2, ice: 2 },
  bug: { fighting: 0.5, flying: 0.5, poison: 0.5, ghost: 0.5, steel: 0.5, fire: 0.5, grass: 2, psychic: 2, dark: 2 },
  ghost: { normal: 0, ghost: 2, steel: 0.5, psychic: 2, dark: 0.5 },
  steel: { rock: 2, steel: 0.5, fire: 0.5, water: 0.5, electric: 0.5, ice: 2 },
  fire: { rock: 0.5, bug: 2, steel: 2, fire: 0.5, water: 0.5, grass: 2, ice: 2, dragon: 0.5 },
  water: { ground: 2, rock: 2, fire: 2, water: 0.5, grass: 0.5, dragon: 0.5 },
  grass: { flying: 0.5, poison: 0.5, ground: 2, rock: 2, bug: 0.5, steel: 0.5, fire: 0.5, water: 2, grass: 0.5, dragon: 0.5 },
  electric: { flying: 2, ground: 0, water: 2, grass: 0.5, electric: 0.5, dragon: 0.5 },
  psychic: { fighting: 2, poison: 2, steel: 0.5, psychic: 0.5, dark: 0 },
  ice: { flying: 2, ground: 2, steel: 0.5, fire: 0.5, water: 0.5, grass: 2, ice: 0.5, dragon: 2 },
  dragon: { steel: 0.5, dragon: 2 },
  dark: { fighting: 0.5, ghost: 2, steel: 0.5, psychic: 2, dark: 0.5, fairy: 0.5 },
  fairy: { fighting: 2, poison: 0.5, steel: 0.5, fire: 0.5, dragon: 2, dark: 2 },
};
// what Fairy takes (only a hack's Pokémon have the type): resisted by it, super effective on it, Dragon does nothing
Object.assign(CHART.fighting, { fairy: 0.5 });
Object.assign(CHART.bug, { fairy: 0.5 });
Object.assign(CHART.poison, { fairy: 2 });
Object.assign(CHART.steel, { fairy: 2 });
Object.assign(CHART.dragon, { fairy: 0 });

const GEN1 = {
  ghost: { psychic: 0 },
  bug: { poison: 2 },
  poison: { bug: 2 },
  ice: { fire: 1 },
};

/** The attacking types of a generation; `fairy` adds the type for a hack that has it. */
export const typesOfGen = (gen, fairy = false) => (gen === 1 ? TYPES.filter((t) => t !== 'dark' && t !== 'steel') : fairy || gen >= 6 ? [...TYPES, 'fairy'] : TYPES);

/** Multiplier of one attacking type against one defending type. Unknown types ('???', Curse) are neutral. */
export function single(atk, def, gen = 4) {
  if (gen === 1 && GEN1[atk]?.[def] !== undefined) return GEN1[atk][def];
  if (gen >= 6 && def === 'steel' && (atk === 'ghost' || atk === 'dark')) return 1;
  return CHART[atk]?.[def] ?? 1;
}

/** Multiplier of an attacking type against a (one or two) typed defender: 0, 0.25, 0.5, 1, 2 or 4. */
export function effectiveness(atk, defTypes, gen = 4) {
  return [...new Set(defTypes.filter(Boolean))].reduce((m, d) => m * single(atk, d, gen), 1);
}

/**
 * How a defender fares against every attacking type, grouped like a Pokédex weakness chart:
 * { 4: [...], 2: [...], 0.5: [...], 0.25: [...], 0: [...] } (1× left out).
 */
export function defenseChart(defTypes, gen = 4, { fairy = false } = {}) {
  const out = { 4: [], 2: [], 0.5: [], 0.25: [], 0: [] };
  for (const atk of typesOfGen(gen, fairy || defTypes.includes('fairy'))) {
    const m = effectiveness(atk, defTypes, gen);
    if (m !== 1) out[m]?.push(atk);
  }
  return out;
}

/** Before Gen 4 the damage class depends on the type; from Gen 4 on every move has its own. */
const SPECIAL_BEFORE_4 = new Set(['fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark']);
export const physicalSpecialSplit = (type, cls, gen) => (cls === 'status' ? 'status' : gen >= 4 ? cls : SPECIAL_BEFORE_4.has(type) ? 'special' : 'physical');

/** Move data for a generation from shared/data/moves.json: { type, power, cls }. */
export function moveInfo(moves, id, gen = 4) {
  if (!moves || !id || !moves.type[id]) return null;
  const old = moves.byGen?.[gen]?.[id];
  const type = old ? old[0] : moves.type[id];
  const power = old ? old[1] : moves.power[id];
  return { type: type === 'unknown' ? null : type, power, cls: physicalSpecialSplit(type, moves.cls[id], gen) };
}

/**
 * Switch-in check for the battle helper: how a Pokémon fares against the opponent. `deals` – its best damaging move
 * against the opponent's types (its own types when its moves aren't known: what its STAB would do); `takes` – the
 * worst the opponent's known damaging moves do to it (the opponent's own types while its moves aren't known).
 * mon / foe = { types: [...], moves: [{ id, type, power, cls }] } (moves through moveInfo; status moves don't count).
 * → { deals, dealsBy, takes, takesBy } – multipliers and the move id or type behind them; null when there's nothing to go by.
 */
export function matchup(mon, foe, gen = 4) {
  const hits = (list) => (list || []).filter((m) => m && m.type && m.cls !== 'status' && m.power > 0);
  const best = (attacks, def) => {
    let out = { m: null, by: null };
    if (!def?.length) return out;
    for (const a of attacks) {
      const m = effectiveness(a.type, def, gen);
      if (out.m === null || m > out.m) out = { m, by: a.by };
    }
    return out;
  };
  const myHits = hits(mon.moves);
  const foeHits = hits(foe.moves);
  // (known moves that are all status moves: nothing to deal – the types only stand in while the moves aren't known)
  const mine = mon.moves?.length ? myHits.map((m) => ({ type: m.type, by: m.id })) : (mon.types || []).map((ty) => ({ type: ty, by: ty }));
  const theirs = foeHits.length ? foeHits.map((m) => ({ type: m.type, by: m.id })) : (foe.types || []).map((ty) => ({ type: ty, by: ty }));
  const d = best(mine, foe.types);
  const k = best(theirs, mon.types);
  return { deals: d.m, dealsBy: d.by, takes: k.m, takesBy: k.by };
}
