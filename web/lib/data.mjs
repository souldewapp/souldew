// Pokémon data for the UI: PokeAPI-derived names/types (multi-language), the game catalog,
// and per-run randomized ROM data (types/evolutions exported by the randomizer bridge).
import { api } from './api.mjs';
import { currentLang } from './i18n.mjs';
import { slotsOf } from '/shared/slots.mjs';
import { speciesCeiling } from '/shared/live/romspecies.mjs';
import { setTypeChart } from '/shared/typechart.mjs';

let P = null;
let CATALOG = { games: [], hacks: [] };
let GEN4 = null;

export async function loadData() {
  const [p, c, g] = await Promise.all([
    fetch('/shared/data/pokeapi.json').then((r) => r.json()),
    api.get('/api/catalog').catch(() => ({ games: [], hacks: [] })),
    fetch('/shared/data/gen4.json').then((r) => r.json()),
  ]);
  P = p;
  CATALOG = c;
  GEN4 = g;
}

export const pokeapi = () => P;
export const catalog = () => CATALOG;
export const gen4data = () => GEN4;

const nameLang = () => (P?.names?.[currentLang()] ? currentLang() : 'en');

// Pokémon only the running ROM knows (a ROM hack's own: shared/live/parse.mjs FAKEMON + their index in the game),
// named as the game names them (shared/live/romspecies.mjs `unknown`).
export const FAKEMON = 20000; // = shared/live/parse.mjs FAKEMON (PokeAPI's form ids run from 10001)
let ROM_SPECIES = null;
let ROM_CEILING = null; // the highest National Dex number the running ROM holds (a hack with later Pokémon)
export function setRomSpecies(sp) {
  ROM_SPECIES = sp?.unknown && Object.keys(sp.unknown).length ? sp.unknown : null;
  ROM_CEILING = speciesCeiling(sp);
}

/** The last National Dex number of each generation's games. */
export const GEN_MAX_ID = [0, 151, 251, 386, 493, 649, 721, 809];

// The running ROM's types (shared/live/romtypes.mjs via server/lib/romloc.mjs): the game's own – each Pokémon's, the
// chart, the moves', the names of types only it has (Too Many Types) – so a hack that changed them shows what it uses.
// The chart goes to shared/typechart.mjs for the battle helper.
let ROM_TYPES = null;
const TYPE_LABELS = {}; // a game's own types by key ('x-monke') → the game's name ("Monke")
export function setRomTypes(t) {
  ROM_TYPES = t?.species ? t : null;
  Object.assign(TYPE_LABELS, ROM_TYPES?.labels || {});
  setTypeChart(ROM_TYPES);
}
export const romTypesNow = () => ROM_TYPES;

export function speciesName(id, lang = nameLang()) {
  if (!id) return '';
  if (id > FAKEMON && ROM_SPECIES?.[id - FAKEMON]) return ROM_SPECIES[id - FAKEMON];
  return P?.names?.[lang]?.[id] || P?.names?.en?.[id] || `#${id}`;
}

/** Types valid in a given generation (PokeAPI typesGen: smallest key ≥ gen wins). */
export function baseTypes(id, gen = 9) {
  if (!P || !id) return [];
  const past = P.typesGen?.[id];
  if (past) {
    const keys = Object.keys(past).map(Number).sort((a, b) => a - b);
    const k = keys.find((x) => x >= gen);
    if (k !== undefined) return past[k];
  }
  return P.types?.[id] || [];
}

export function typeLabel(type) {
  const t = String(type || '').toLowerCase();
  return TYPE_LABELS[t] || P?.typeNames?.[currentLang()]?.[t] || P?.typeNames?.en?.[t] || t;
}

export function moveName(id) {
  const l = P?.moves?.[currentLang()] ? currentLang() : 'en';
  return P?.moves?.[l]?.[id] || '';
}

/**
 * A held item's name: the game's item number → PokeAPI's name in the app's language (Gen 3, 4 and 5 number their
 * items differently – pokeapi.json items.gen3/gen4/gen5). '' when unknown: Gen 1/2, an item only a ROM hack has.
 */
export function itemName(id, gen, lang = currentLang()) {
  const items = P?.items;
  const key = Number.isInteger(id) && id > 0 && gen >= 3 && gen <= 5 ? items?.[`gen${gen}`]?.[id] : null;
  return key ? items.names?.[lang]?.[key] || items.names?.en?.[key] || '' : '';
}

/** Sprite in the art style of the game's generation (served + cached by the local server). */
export function spriteUrl(id, { gen = 4, shiny = false } = {}) {
  if (!id || id > FAKEMON) return ''; // (a ROM hack's own Pokémon has no sprite here)
  // Gen 6/7 (3DS games have 3D models, no sprite set of their own): the current artwork-style sprites
  if (gen >= 6) return `/sprites/${shiny ? 'shiny' : 'default'}/${id}.png`;
  const g = Math.min(Math.max(gen || 4, 1), 5);
  if (id > GEN_MAX_ID[g]) return `/sprites/${shiny ? 'shiny' : 'default'}/${id}.png`;
  const set = { 1: 'gen1', 2: shiny ? 'gen2shiny' : 'gen2', 3: shiny ? 'gen3shiny' : 'gen3', 4: shiny ? 'gen4shiny' : 'gen4', 5: shiny ? 'gen5shiny' : 'gen5' }[g];
  return `/sprites/${set}/${id}.png`;
}

export function gameById(id) {
  return CATALOG.games?.find((g) => g.id === id) || null;
}
export function hackById(id) {
  return CATALOG.hacks?.find((h) => h.id === id) || null;
}
export function gameTitle(g) {
  if (!g) return '';
  return (currentLang() === 'de' && g.titleDe) || g.title;
}

/** Per-run game data: generation, randomized types/evolutions per player. */
export class RunData {
  constructor() {
    this.gen = 4;
    this.romData = {};
    this.byId = {};
  }

  async load(manifest) {
    const game = gameById(manifest?.game?.id) || gameById(manifest?.base?.gameId);
    this.gen = game?.generation || genFromSystem(manifest?.game) || 4;
    this.game = game;
    for (const slot of manifest ? slotsOf(manifest) : ['p1', 'p2']) {
      const d = manifest ? await api.get(`/api/runs/${manifest.id}/data/${slot}`).catch(() => null) : null;
      this.romData[slot] = d;
      this.byId[slot] = d ? new Map(d.pokemon.filter((p) => p.forme === 0).map((p) => [p.id, p])) : null;
    }
    // the game's own data from its ROM (server/lib/romloc.mjs): its types (any game – a hack may have changed them) and,
    // for a GBA game, which Pokémon it holds (a hack with later generations' Pokémon: Run & Bun, Light Platinum – also a
    // ROM that was patched before it was added)
    this.romTypes = null;
    this.romSpecies = null;
    this.romVanilla = null;
    const out = Object.entries(manifest?.outputs || {}).find(([s, o]) => !this.byId[s] && o?.rom);
    if (out) {
      const src = `/api/runs/${manifest.id}/file?inline=1&name=${encodeURIComponent(out[1].rom)}`;
      const j = await fetch(`/api/rom/locations?src=${encodeURIComponent(src)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      this.romTypes = j?.types?.species ? j.types : null;
      this.romSpecies = j?.species || null;
      this.romVanilla = j ? j.vanilla !== false : null;
      Object.assign(TYPE_LABELS, this.romTypes?.labels || {});
      // a hack's own Pokémon are named as the game names them – on the board too, not only while the game runs
      if (this.romSpecies?.unknown && Object.keys(this.romSpecies.unknown).length) setRomSpecies(this.romSpecies);
    }
    return this;
  }

  /** A ROM hack's own Pokémon (no National Dex number): their ids (FAKEMON + the game's index), for the picker. */
  ownSpecies() {
    const unknown = this.romSpecies?.unknown || (this.gen === 3 ? ROM_SPECIES : null) || {};
    return Object.keys(unknown).map((i) => FAKEMON + Number(i));
  }

  /**
   * The highest National Dex number the run's game can hold – what the species picker offers. The generation's last
   * Pokémon, or more for a game that has later ones: a ROM hack's species table (Run & Bun: 1000+, Light Platinum: Gen
   * 4/5 Pokémon in a Ruby ROM), the randomizer's Pokémon list, or the ROM running right now.
   */
  maxSpecies() {
    let max = GEN_MAX_ID[this.gen] || 649;
    for (const m of Object.values(this.byId)) if (m) for (const id of m.keys()) if (id > max && id < FAKEMON) max = id;
    const own = speciesCeiling(this.romSpecies);
    if (own > max) max = own;
    // (the play view sets the running ROM's table – the same game in a run)
    if (this.gen === 3 && ROM_CEILING > max) max = ROM_CEILING;
    return max;
  }

  /** The ROM data of `slot` – or of any player this computer has it for (each one builds only their own game). */
  _map(slot) {
    return this.byId[slot] || Object.keys(this.byId).sort().map((s) => this.byId[s]).find(Boolean) || null;
  }

  types(id, slot) {
    const p = this.byId[slot]?.get(id) || Object.keys(this.byId).sort().map((s) => this.byId[s]?.get(id)).find(Boolean);
    if (p) return p.types.filter(Boolean).map((t) => t.toLowerCase());
    // the game's own types (read from the ROM: loaded with the run, or from the game running right now); a Pokémon
    // its table doesn't list (Gen 1's Mew where that entry wasn't found, a type the game doesn't name) has the official
    // ones – unless the game has types of its own, where those would be wrong
    const rt = this.romTypes || ROM_TYPES;
    if (rt) return rt.species[id] || (rt.own ? [] : baseTypes(id, this.gen));
    // no types read from the ROM (a modified one whose tables weren't found too): the official ones – the battle
    // helper then shows no matchups for a modified ROM (matchupsKnown), as they may be wrong there
    return baseTypes(id, this.gen);
  }

  /** Can the battle helper tell matchups? The game's own chart, or the official one where the game has only those types. */
  get matchupsKnown() {
    const rt = this.romTypes || ROM_TYPES;
    if (!rt) return this.romVanilla !== false; // (a modified ROM whose types couldn't be read: official types, no matchups)
    return !!rt.chart || !rt.own;
  }

  /** Does the game have the Fairy type (a hack that added it)? */
  get fairy() {
    // Gen 6 brought the Fairy type; before that only a hack that added it
    return this.gen >= 6 || !!(this.romTypes || ROM_TYPES)?.fairy;
  }

  familyRoot(id, slot) {
    const map = this._map(slot);
    let cur = id;
    const seen = new Set();
    for (;;) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const prev = map ? map.get(cur)?.evolvesFrom?.[0] : P?.evolvesFrom?.[cur];
      if (!prev) break;
      cur = prev;
    }
    return cur;
  }

  sprite(id, shiny) {
    return spriteUrl(id, { gen: this.gen, shiny });
  }

  encounterTables(slot) {
    const d = this.romData[slot];
    if (!d) return [];
    const TOKENS = [' Morning ', ' Day ', ' Night ', ' Hoenn/Sinnoh', ' Swarms', ' Surfing', ' Old Rod', ' Good Rod', ' Super Rod',
      ' Fishing Swarm', ' Headbutt', ' Rock Smash', ' Bug Catching', ' Grass/Cave', ' Grass', ' Cave', ' Fishing', ' Surf'];
    const groups = new Map();
    for (const set of d.encounters) {
      const name = ` ${set.area} `;
      let cut = -1;
      for (const tk of TOKENS) {
        const i = name.indexOf(tk, 1);
        if (i > 0 && (cut < 0 || i < cut)) cut = i;
      }
      const area = (cut > 0 ? name.slice(0, cut) : name).trim();
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area).push({ method: (cut > 0 ? name.slice(cut) : '').trim(), slots: set.slots });
    }
    return [...groups.entries()].map(([area, sets]) => ({ area, sets }));
  }

  starters(slot) {
    return this.romData[slot]?.starters || [];
  }
}

export function genFromSystem(game) {
  if (!game) return null;
  return { gb: 1, gbc: 2, gba: 3, nds: 4 }[game.system] || (game.system === '3ds' ? game.generation || 6 : null);
}
