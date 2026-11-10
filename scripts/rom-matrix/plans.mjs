// Input plans for scripts/rom-matrix.mjs --live: from power-on to the first Pokémon (and a battle) per game, driven
// frame by frame through souldew's player page (page.mjs runs the steps). Each `check` step records what the app's
// live readers see; `expect[check name]` says what must be there. Plans were built against the US/EU retail ROMs and
// work for hacks and randomized games of the same game where the intro is the same (a randomized starter is any
// Pokémon – only its level and a valid read are required then).
//
// Step reference (page.mjs): wait {frames} · press {keys, hold, gap, times} · walk {dir, steps} · go {x, y, order, map,
// leave, patience, required} (walks with `pos`, an expression → [map, x, y]) · mash {keys, every, max, until, required}
// · until {until, max} · tap {x, y} (DS bottom screen) · check {name} · shot {name} · log {name, expr}.
// Conditions: 'party', 'party>=N', 'battle', 'nobattle', 'overworld' or { expr } (read, place, team, ctx).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gen1Pos = '[read(0xD35E,1)[0], read(0xD362,1)[0], read(0xD361,1)[0]]';

const RED = {
  id: 'red',
  pos: gen1Pos,
  steps: [
    { do: 'wait', frames: 600 },
    { do: 'mash', keys: [['A'], ['START']], max: 4000, note: 'intro, name "A"' },
    { do: 'mash', keys: [['A']], max: 2500 },
    { do: 'mash', keys: [['B']], max: 600 },
    { do: 'check', name: 'home' },
    { do: 'go', x: 5, y: 1, order: 'xy' },
    { do: 'go', x: 7, order: 'x', leave: true, map: 38, note: 'stairs' },
    { do: 'walk', dir: 'RIGHT', steps: 2 },
    { do: 'wait', frames: 120 },
    { do: 'go', y: 6, x: 7, order: 'yx', required: false, patience: 6 },
    { do: 'go', x: 3, y: 6, order: 'xy', required: false, patience: 6 },
    { do: 'go', y: 6, x: 3, order: 'yx' },
    { do: 'go', y: 9, leave: true, map: 37, note: 'out of the house' },
    { do: 'wait', frames: 200 },
    { do: 'go', x: 9, y: 2, order: 'xy' },
    { do: 'go', x: 10, order: 'x' },
    { do: 'go', y: 1, order: 'y', required: false, patience: 3, note: 'Oak stops you' },
    { do: 'mash', keys: [['A']], max: 3000 },
    { do: 'mash', keys: [['B']], max: 1500 },
    { do: 'press', keys: 'RIGHT', hold: 3 },
    { do: 'mash', keys: [['A']], max: 4000, until: 'party', note: 'take a Poké Ball, nickname it' },
    { do: 'mash', keys: [['A'], ['A'], ['START']], max: 1500 },
    { do: 'mash', keys: [['B']], max: 1500 },
    { do: 'check', name: 'starter' },
    { do: 'go', y: 11, order: 'y', required: false, patience: 4 },
    { do: 'mash', keys: [['B']], max: 3000, until: 'battle', note: 'the rival' },
    { do: 'mash', keys: [['B']], max: 600 },
    { do: 'check', name: 'rival' },
    { do: 'shot', name: 'rival' },
    { do: 'mash', keys: [['A']], max: 8000, until: 'nobattle' },
    { do: 'check', name: 'after' },
  ],
  expect: {
    home: { place: 'Pallet Town' },
    starter: { party: { species: [1, 4, 7], level: 5 }, place: 'Pallet Town' },
    rival: { battle: { kind: 'trainer', level: 5, species: [1, 4, 7] } },
    after: { party: { level: [5, 6] } },
  },
};

/** Plans by memory-table entry (addresses.json id), and by catalog hack id where a hack needs its own. */
export const PLANS = { red_us: RED, blue_us: RED };
export const HACK_PLANS = {};

// the longer plans live as JSON next to this file (plans/*.json: { id, entries?, hacks?, core?, pos, steps, expect })
const dir = join(dirname(fileURLToPath(import.meta.url)), 'plans');
for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []) {
  const plan = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const id of plan.entries || []) PLANS[id] = plan;
  for (const id of plan.hacks || []) HACK_PLANS[id] = plan;
}

/** The plan for a matrix ROM (scripts/rom-matrix.mjs row): its hack's own, else its game's. */
export function planFor(r) {
  if (r.hack && HACK_PLANS[r.hack]) return HACK_PLANS[r.hack];
  if (r.hack && HACK_PLANS[r.hack] === null) return null;
  return PLANS[r.entry] || null;
}
