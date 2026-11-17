// The Pokémon Finder's logic over a Gen 3 ROM's encounter tables (shared/live/romwild.mjs gen3Wild): which slot has which
// chance, where one Pokémon can be found, which Pokémon an area holds. Plain functions, used by web/views/finder.mjs.

/**
 * The chance of each slot in per cent (pokeemerald ChooseWildMonIndex_Land / _WaterRock / _Fishing, the same numbers in
 * pokefirered and pokeruby). Land: 20 20 10 10 10 10 5 5 4 4 1 1; water and rock smash: 60 30 5 4 1; the rods pick among
 * their own slots – old 70 30, good 60 20 20, super 40 40 15 4 1.
 */
export const CHANCES = {
  land: [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1],
  surf: [60, 30, 5, 4, 1],
  rock: [60, 30, 5, 4, 1],
  old: [70, 30],
  good: [60, 20, 20],
  super: [40, 40, 15, 4, 1],
};
/** Which slots of the fishing table a rod draws from. */
const RODS = { old: [0, 2], good: [2, 5], super: [5, 10] };
export const METHODS = ['land', 'surf', 'rock', 'old', 'good', 'super'];

const slot = ([min, max, s, i], pct) => ({ min, max, s, i, pct });

/** One game's encounters of an area as a list per method, with the slot chances applied (for the Finder). */
export function methodSlots(area) {
  const out = {};
  for (const m of ['land', 'surf', 'rock']) if (area.slots[m]) out[m] = area.slots[m].map((x, k) => slot(x, CHANCES[m][k]));
  if (area.slots.fish) {
    for (const [rod, [a, b]] of Object.entries(RODS)) out[rod] = area.slots.fish.slice(a, b).map((x, k) => slot(x, CHANCES[rod][k]));
  }
  return out;
}

/** The rate byte of a method (the fishing rate counts for all three rods). */
export function methodRate(area, m) {
  return area.rates[m === 'old' || m === 'good' || m === 'super' ? 'fish' : m] ?? null;
}

/** Slots of one species merged: chance, lowest and highest level of a Pokémon within one method's list. */
export function mergeSlots(list) {
  const by = new Map();
  for (const x of list) {
    const k = x.s || `i${x.i}`;
    const e = by.get(k);
    if (e) {
      e.pct += x.pct;
      e.min = Math.min(e.min, x.min);
      e.max = Math.max(e.max, x.max);
    } else by.set(k, { ...x });
  }
  return [...by.values()];
}

/** The key a Pokémon goes by in the Finder: its National Dex number, else (a hack's own Pokémon) its internal index. */
export const monKey = (x) => (x.s ? x.s : `i${x.i}`);

/** Every Pokémon the table holds: Map key → { s, i }, in the order of their first appearance. */
export function wildMons(wild) {
  const out = new Map();
  for (const a of wild?.areas || []) {
    for (const list of Object.values(a.slots)) {
      for (const [, , s, i] of list) {
        const k = monKey({ s, i });
        if (!out.has(k)) out.set(k, { s, i });
      }
    }
  }
  return out;
}

/** The name an area goes by: the game's place name, else its map number. */
export const areaLabel = (a) => a.name || `${a.group}.${a.num}`;

/**
 * Where one Pokémon (key from monKey) can be found: [{ area, method, pct, min, max, rate }] – one row per area table and
 * method (a species in several slots of one table is merged: chances added, levels widened), in the order of the table.
 */
export function whereIs(wild, key) {
  const rows = [];
  for (const area of wild?.areas || []) {
    const ms = methodSlots(area);
    for (const m of METHODS) {
      if (!ms[m]) continue;
      const hit = mergeSlots(ms[m].filter((x) => monKey(x) === key))[0];
      if (hit) rows.push({ area, method: m, pct: hit.pct, min: hit.min, max: hit.max, rate: methodRate(area, m) });
    }
  }
  return rows;
}

/**
 * The areas under one name (a cave's floors, a route's two halves), for the area picker: [{ name, areas }] in the order of
 * the table, case-insensitively filtered by `q`.
 */
export function areaGroups(wild, q = '') {
  const by = new Map();
  for (const a of wild?.areas || []) {
    const name = areaLabel(a);
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(a);
  }
  const s = q.trim().toLowerCase();
  return [...by].filter(([name]) => !s || name.toLowerCase().includes(s)).map(([name, areas]) => ({ name, areas }));
}
