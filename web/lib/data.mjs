// Pokémon data for the UI: PokeAPI-derived names/types (multi-language), the game catalog,
// and per-run randomized ROM data (types/evolutions exported by the randomizer bridge).
import { api } from './api.mjs';
import { currentLang } from './i18n.mjs';
import { slotsOf } from '/shared/slots.mjs';

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
const FAKEMON = 20000; // = shared/live/parse.mjs FAKEMON (PokeAPI's form ids run from 10001)
let ROM_SPECIES = null;
export function setRomSpecies(sp) {
  ROM_SPECIES = sp?.unknown && Object.keys(sp.unknown).length ? sp.unknown : null;
}

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
  return P?.typeNames?.[currentLang()]?.[t] || P?.typeNames?.en?.[t] || t;
}

export function moveName(id) {
  const l = P?.moves?.[currentLang()] ? currentLang() : 'en';
  return P?.moves?.[l]?.[id] || '';
}

/** Sprite in the art style of the game's generation (served + cached by the local server). */
export function spriteUrl(id, { gen = 4, shiny = false } = {}) {
  if (!id || id > FAKEMON) return ''; // (a ROM hack's own Pokémon has no sprite here)
  const g = Math.min(Math.max(gen || 4, 1), 5);
  if (id > [0, 151, 251, 386, 493, 649][g]) return `/sprites/${shiny ? 'shiny' : 'default'}/${id}.png`;
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
    return this;
  }

  /** The ROM data of `slot` – or of any player this computer has it for (each one builds only their own game). */
  _map(slot) {
    return this.byId[slot] || Object.keys(this.byId).sort().map((s) => this.byId[s]).find(Boolean) || null;
  }

  types(id, slot) {
    const p = this.byId[slot]?.get(id) || Object.keys(this.byId).sort().map((s) => this.byId[s]?.get(id)).find(Boolean);
    if (p) return p.types.filter(Boolean).map((t) => t.toLowerCase());
    return baseTypes(id, this.gen);
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
  return { gb: 1, gbc: 2, gba: 3, nds: 4 }[game.system] || null;
}
