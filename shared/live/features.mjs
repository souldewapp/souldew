// What souldew can read for a game, feature by feature – so the app shows only what it can read with confidence and
// hides the rest instead of showing made-up values. Two stages:
// - romFeatures: what the ROM data makes possible at all (server/lib/romloc.mjs romData + the memory table entry) –
//   for the library's "what souldew reads" line and as the starting point of a session;
// - FeatureCheck: what the live readers have confirmed in this session (a team read cleanly a few times, held items
//   and moves that all have names, a place, a battle, a catch filed) – the play view and the diagnostics file.
// Status per feature: 'yes' (can read / confirmed), 'partial' (part of it: types without their matchups), 'wait' (can
// read, not confirmed yet), 'no' (can't – hidden).
import { findEntry } from './parse.mjs';

export const FEATURES = ['party', 'items', 'moves', 'location', 'battle', 'catch', 'types', 'caps'];

/**
 * From the ROM data alone. `rom` = romData() result (header, species, data, types, caps, items, moves, vanilla),
 * `addresses` = addresses.json, `curatedCaps` = the game has a curated cap list (shared/routes.mjs: HeartGold/SoulSilver,
 * the unmodified Gen 1/2/5 games). → { party, items, moves, location, battle, catch, types, caps } of 'yes'|'partial'|'no'.
 */
export function romFeatures(rom, addresses, { curatedCaps = false } = {}) {
  const out = Object.fromEntries(FEATURES.map((f) => [f, 'no']));
  const h = rom?.header;
  if (!h?.system) return out;
  const entry = findEntry(addresses, { platform: h.system, code: h.code, title: h.title });
  const gen = entry?.gen || { gb: 1, gbc: 2, gba: 3, nds: 4 }[h.system];
  const expanded = rom.species?.engine === 'expanded';
  // the team: a memory table entry, and for an expanded GBA engine its species table (else "not supported")
  if (!entry || (expanded && !rom.species?.map)) return out;
  out.party = 'yes';
  out.catch = 'yes';
  // held items: none in Gen 1; an expanded engine numbers them its own way – named only from its item table
  out.items = gen === 1 ? 'no' : expanded ? (rom.items ? 'yes' : 'no') : 'yes';
  out.moves = 'yes';
  // the place: Gen 1/2 from the tables, Gen 3–5 from the ROM's own place names
  out.location = gen <= 2 || rom.data ? 'yes' : 'no';
  out.battle = gen <= 2 ? (entry.battleEnemy ? 'yes' : 'no') : gen === 3 ? (entry.enemyPartyAddr ? 'yes' : 'no') : 'yes';
  // types: the game's own (read from the ROM); a game with types of its own needs its chart for matchups; a ROM whose
  // types couldn't be read: only an unmodified one has the official ones
  const t = rom.types;
  out.types = t?.species ? (t.chart || !t.own ? 'yes' : 'partial') : rom.vanilla ? 'yes' : 'no';
  // level caps: a curated list, or caps read from the game's trainers – and its badges must be readable live (an
  // expanded engine's only through the badge flags its own scripts name)
  out.caps = curatedCaps || (rom.caps && (!expanded || Number.isInteger(rom.caps.badgeFlags))) ? 'yes' : 'no';
  return out;
}

/** Reads in a row before a feature counts as confirmed. */
const CONFIRM = 3;

/**
 * A session's confirmed features. `start` = romFeatures() (what can be read at all); each note*() call is one poll's
 * reading. status() → { feature: 'yes'|'partial'|'wait'|'no' }; changed() says whether it differs from the last call
 * (for the diagnostics log).
 */
export class FeatureCheck {
  constructor(start = {}) {
    this.start = { ...Object.fromEntries(FEATURES.map((f) => [f, 'yes'])), ...start };
    this.ok = {}; // feature → good reads in a row
    this.bad = {}; // feature → why it was given up for this session
    this.last = '';
  }

  _good(f, n = 1) {
    this.ok[f] = (this.ok[f] || 0) + n;
  }

  _fail(f, why) {
    this.bad[f] ||= why;
  }

  /** A team read: `party` (readLiveParty().party) or null/undefined (none this poll). */
  noteParty(party) {
    if (!party?.length) return;
    this._good('party');
  }

  /** The team's held items and moves: `itemName(mon)` / `moveName(id)` → '' for one the app can't name. */
  noteNames(party, { itemName, moveName }) {
    if (!party?.length) return;
    const items = party.filter((m) => m.item);
    if (items.some((m) => !itemName(m))) this._fail('items', 'an item without a name');
    else if (items.length) this._good('items');
    const moves = party.flatMap((m) => m.moves || []);
    if (moves.some((id) => !moveName(id))) this._fail('moves', 'a move without a name');
    else if (moves.length) this._good('moves');
  }

  /** The place sign: `here` (readHere()) – a name confirms it. */
  noteLocation(here) {
    if (here?.name) this._good('location');
  }

  /** A battle read (readLiveBattle()): an opponent with a sane level and HP confirms it. */
  noteBattle(fight) {
    const e = fight?.enemy;
    if (!e) return;
    if (!(e.level >= 1 && e.level <= 100) || !(e.maxHp > 0 && e.hp <= e.maxHp)) this._fail('battle', 'an opponent with impossible numbers');
    else this._good('battle');
  }

  /** A catch filed under an area (applySnapshot().newCatches). */
  noteCatch(n) {
    if (n > 0) this._good('catch', CONFIRM);
  }

  /** Types: `kind` 'yes' (the game's chart or the official one), 'partial' (types only), 'no'. */
  noteTypes(kind) {
    this.types = kind;
  }

  /** Level caps: a cap shown (`cap` a number) – needs the caps and badges read from the game. */
  noteCap(cap) {
    if (Number.isInteger(cap)) this._good('caps', CONFIRM);
  }

  status() {
    const out = {};
    for (const f of FEATURES) {
      const s = this.start[f];
      if (s === 'no' || this.bad[f]) out[f] = 'no';
      else if (f === 'types') out[f] = this.types || s;
      else out[f] = (this.ok[f] || 0) >= CONFIRM ? s : 'wait';
    }
    return out;
  }

  /** The status, and whether it changed since the last call. */
  changed() {
    const st = this.status();
    const sig = JSON.stringify([st, this.bad]);
    const ch = sig !== this.last;
    this.last = sig;
    return { status: st, why: { ...this.bad }, changed: ch };
  }
}
