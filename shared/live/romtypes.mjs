// Types read from the ROM itself, so a game that changed them shows what it really uses – Fairy added (Renegade
// Platinum, Blaze Black 2 Redux, Complete FireRed Upgrade, pokeemerald-expansion), Pokémon retyped, or types of its own
// (Too Many Types: 57 / 80): the type names, each species' types, the type chart and the moves' types.
//
// - GBA (retail, Complete FireRed Upgrade, pokeemerald-expansion): the type-name table, the base stats (or gSpeciesInfo)
//   found by Bulbasaur's and Ivysaur's stats, the chart as the retail (attacker, defender, ×10) triples or as a matrix
//   (CFRU and older expansions: ×10 bytes or 4.12 fixed point halfwords; newer expansions: 4.12 words), and
//   gBattleMoves found by its first four moves.
// - Game Boy: the base data (types after the stats) and TypeMatchups (triples, Gen 2 with the Foresight marker).
// - DS: the personal data (types at +6/+7) and the chart in the ARM9 binary or a battle overlay (triples in Gen 4, a
//   17×17 or 18×18 matrix of 0/2/4/8 in Gen 5).
//
// Every table is validated against the retail chart before it is trusted (a hack keeps most matchups); what can't be
// found that way is null, never a guess. A key per type: the app's own ('fire', 'fairy') for the official types, 'x-…'
// for a type only the game has (named as the game names it, `labels`).
import { listNdsFiles, ndsFile, parseNarc, ndsArm9, blzDecompress } from '../nds.mjs';
import { retailSingle } from '../typechart.mjs';

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** The official types in the games' id order (Gen 3/4: '???' at 9; Gen 5 has none, Fairy hacks add it as 17). */
export const TYPES34 = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', '???', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
export const TYPES5 = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark', 'fairy'];
// Game Boy type ids (pokered/pokecrystal constants/type_constants.asm): 6 is BIRD, 0x13 CURSE_TYPE ('???')
const GB_IDS = { 0: 'normal', 1: 'fighting', 2: 'flying', 3: 'poison', 4: 'ground', 5: 'rock', 7: 'bug', 8: 'ghost', 9: 'steel', 0x13: '???', 0x14: 'fire', 0x15: 'water', 0x16: 'grass', 0x17: 'electric', 0x18: 'psychic', 0x19: 'ice', 0x1a: 'dragon', 0x1b: 'dark' };
const STD = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
// Fairy in the languages the games came out in (a hack's type-name table names it)
const FAIRY = /^(fairy|fee|fée|hada|folletto|fata)$/i;

// ---------------------------------------------------------------- text

function codes(table) {
  const code = {};
  for (const [k, v] of Object.entries(table)) if (typeof v === 'string' && v.length === 1 && !(v in code)) code[v] = parseInt(k, 16);
  return code;
}

/** Gen 3 text of at most `n` bytes that ends with its terminator → string; null when a byte isn't a character. */
function text3(rom, o, n, table) {
  let s = '';
  for (let k = 0; k < n && o + k < rom.length; k++) {
    const c = rom[o + k];
    if (c === 0xff) return s;
    const ch = table[c.toString(16).toUpperCase().padStart(2, '0')];
    if (ch === undefined || ch.length !== 1) return null;
    s += ch;
  }
  return null;
}

const TYPE_NAME = /^[A-Za-zÀ-ÿ?][A-Za-zÀ-ÿ0-9?'’ .-]*$/;
// the second type in every language: Fighting
const SECOND = /^(fight|kampf|combat|lucha|lotta)/i;

/**
 * The type-name table of a GBA ROM: "Normal" (any case, Italian "Normale"), then "Fight…" one entry on, `stride` bytes
 * per entry (7 in the retail games, a struct field in newer expansions). Empty entries are kept (Complete FireRed
 * Upgrade leaves 18–22 empty and puts Fairy at 23). Of all tables found the one with the most names.
 * → { offset, stride, names } or null.
 */
export function gbaTypeNames(rom, charset) {
  const table = charset?.table || charset || {};
  const code = codes(table);
  const firsts = ['Normal', 'NORMAL', 'Normale', 'NORMALE'].map((w) => [...w].map((c) => code[c])).filter((b) => b.every((x) => x !== undefined));
  if (!firsts.length) return null;
  let best = null;
  const lead = new Set(firsts.map((b) => b[0]));
  for (let o = 0; o + 64 < rom.length; o++) {
    if (!lead.has(rom[o])) continue;
    const w = firsts.find((b) => rom[o] === b[0] && b.every((x, k) => rom[o + k] === x) && rom[o + b.length] === 0xff);
    if (!w) continue;
    for (let stride = w.length + 1; stride <= 48; stride++) {
      const second = text3(rom, o + stride, Math.min(stride, 13), table)?.trim();
      if (!second || !SECOND.test(second)) continue;
      const names = [];
      let blanks = 0;
      for (let i = 0; i < 255; i++) {
        const v = text3(rom, o + i * stride, Math.min(stride, 13), table);
        if (v === null) break;
        const t = v.trim();
        if (!t || !TYPE_NAME.test(t)) {
          if (++blanks > 8) break;
          names.push('');
          continue;
        }
        blanks = 0;
        names.push(t);
      }
      while (names.length && !names[names.length - 1]) names.pop();
      const count = names.filter(Boolean).length;
      if (count >= 17 && (!best || count > best.count)) best = { offset: o, stride, names, count };
    }
  }
  return best ? { offset: best.offset, stride: best.stride, names: best.names } : null;
}

// ---------------------------------------------------------------- species types

/**
 * GBA base stats (28 bytes per species in the retail games, 36 in older expansions, a field of gSpeciesInfo in newer
 * ones): Bulbasaur's stats (45/49/49/45/65/65), Ivysaur's one entry on, Venusaur's after it; the types at +6/+7. Of the
 * tables found (Radical Red keeps FireRed's next to its own) the one with the most entries that look like species.
 * → { offset, stride, types: [[id, id] | null] } (index = the game's species number) or null.
 */
export function gbaBaseStats(rom, count) {
  const B = [45, 49, 49, 45, 65, 65];
  const I = [60, 62, 63, 60, 80, 80];
  const V = [80, 82, 83, 80, 100, 100];
  const at = (o, sig) => sig.every((v, k) => rom[o + k] === v);
  let best = null;
  for (let o = 0; o + 0x400 < rom.length; o++) {
    if (rom[o] !== 45 || !at(o, B)) continue;
    for (let s = 0x1c; s <= 0x200; s++) {
      if (!at(o + s, I) || !at(o + 2 * s, V) || o < s) continue;
      const start = o - s;
      const types = [null];
      let ok = 0;
      for (let i = 1; i <= count && start + i * s + 8 <= rom.length; i++) {
        const e = start + i * s;
        const a = rom[e + 6];
        const b = rom[e + 7];
        const stats = rom[e] || rom[e + 1] || rom[e + 2];
        types[i] = stats && a < 0x80 && b < 0x80 ? [a, b] : null;
        if (types[i]) ok++;
      }
      if (!best || ok > best.ok) best = { offset: start, stride: s, types, ok };
    }
  }
  return best && best.ok >= Math.min(count, 386) * 0.9 ? { offset: best.offset, stride: best.stride, types: best.types } : null;
}

/** Game Boy base data: Bulbasaur's entry (dex 1, then its stats), 28 bytes per species in Gen 1, 32 in Gen 2. */
function gbBaseStats(rom, gen) {
  const sig = gen === 1 ? [1, 45, 49, 49, 45, 65] : [1, 45, 49, 49, 45, 65, 65];
  const size = gen === 1 ? 28 : 32;
  const t = gen === 1 ? 6 : 7;
  for (let o = 0; o + size * 251 < rom.length; o++) {
    if (rom[o] !== 1 || !sig.every((v, k) => rom[o + k] === v)) continue;
    if (rom[o + size] !== 2 || rom[o + 2 * size] !== 3) continue; // Ivysaur and Venusaur after it, by dex number
    const out = [];
    const last = gen === 1 ? 150 : 251; // (Gen 1 keeps Mew apart)
    for (let i = 0; i < last; i++) {
      const e = o + i * size;
      if (rom[e] !== i + 1) break;
      out[i + 1] = [rom[e + t], rom[e + t + 1]];
    }
    if (out.length > last * 0.9) return { offset: o, stride: size, types: out };
  }
  return null;
}

// ---------------------------------------------------------------- the chart

/** The retail chart (Gen 2–5; Gen 1 for the Game Boy's first games) by key, for checking a table found in a ROM. */
const retail = (gen) => (a, d) => retailSingle(a, d, gen === 1 ? 1 : 4);

/**
 * How well a chart (`mult(atkId, defId)`) agrees with the retail one on the official types (`idOf(key)`): the number
 * of mismatches, Steel no longer resisting Ghost and Dark (Gen 6, the Fairy hacks) not counted.
 */
function mismatches(mult, idOf, gen) {
  const want = retail(gen);
  const types = gen === 1 ? STD.filter((t) => t !== 'dark' && t !== 'steel') : STD;
  let bad = 0;
  for (const a of types) {
    for (const d of types) {
      const ai = idOf(a);
      const di = idOf(d);
      if (ai === undefined || di === undefined) return Infinity;
      const got = mult(ai, di);
      const exp = want(a, d);
      if (got === exp) continue;
      if (d === 'steel' && (a === 'ghost' || a === 'dark') && got === 1) continue;
      bad++;
    }
  }
  return bad;
}

/**
 * Charts stored as triples (attacker, defender, multiplier ×10 – 0, 5 or 20) up to 0xFF: the retail GBA and DS games,
 * Complete FireRed Upgrade (Fairy as 23) and the Game Boy games (`gb`: a single 0xFE byte before the Foresight
 * entries, GBA: 0xFE 0xFE 0x00). → [{ offset, cells: Float32Array(64 × 64) of the multipliers, -1 where none is listed }].
 */
function tripleCharts(rom, { gb = false, maxId = 0x40, min = 60 } = {}) {
  const out = [];
  const ok = (a, b, m) => a < maxId && b < maxId && (m === 0 || m === 5 || m === 20) && !(a === 0 && b === 0);
  const dead = [0, 0, 0]; // per alignment: a run that came to nothing ends here – a start inside it would too
  for (let o = 0; o + 3 < rom.length; o++) {
    if (o < dead[o % 3] || !ok(rom[o], rom[o + 1], rom[o + 2])) continue;
    const cells = new Float32Array(64 * 64).fill(-1);
    let p = o;
    let n = 0;
    while (p + 2 < rom.length) {
      const a = rom[p];
      if (a === 0xff) break;
      if (a === 0xfe && gb) {
        p++;
        continue;
      }
      if (a === 0xfe && rom[p + 1] === 0xfe) {
        p += 3;
        continue;
      }
      if (!ok(a, rom[p + 1], rom[p + 2])) break;
      const k = a * 64 + rom[p + 1];
      if (cells[k] < 0) cells[k] = rom[p + 2] / 10;
      n++;
      p += 3;
    }
    if (rom[p] === 0xff && n >= min) {
      out.push({ offset: o, cells, n });
      o = p;
    } else dead[o % 3] = p;
  }
  return out;
}

/**
 * Charts stored as a matrix (row = attacker, column = defender), in whatever numbers the engine uses: ×10 bytes, 4.12
 * fixed point halfwords (older pokeemerald-expansion) or words (newer ones), Gen 5's 0/2/4/8, Radical Red's bytes with
 * 0 for ×1 and 1 for ×0. Found by the Normal row (Rock and Steel ×½, Ghost ×0, the rest ×1) and the Fighting row one
 * stride on; the four values seen there are the encoding, and a matrix with any other value isn't one. `shift` = the
 * id of Normal (1 where TYPE_NONE comes first). → [{ offset, n, cell, mult(atkId, defId) }].
 */
function matrixCharts(rom, shift = 0) {
  const out = [];
  // (typed views over the ROM – a 32 MB scan per cell size)
  const buf = rom.byteOffset % 4 ? rom.slice() : rom;
  for (const cell of [1, 2, 4]) {
    const v = cell === 1 ? buf : cell === 2 ? new Uint16Array(buf.buffer, buf.byteOffset, buf.length >> 1) : new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
    const rd = (o) => v[o / cell];
    for (let i = 0; i + 9 * 20 < v.length; i++) {
      const X = v[i];
      if (v[i + 1] !== X || v[i + 2] !== X || v[i + 3] !== X || v[i + 4] !== X || v[i + 6] !== X) continue;
      const Y = v[i + 5];
      const Z = v[i + 7];
      if (X === Y || X === Z || Y === Z || v[i + 8] !== Y) continue;
      const o = i * cell;
      for (let n = 17; n <= 128; n++) {
        const f = (k) => rd(o + (n + k) * cell);
        const W = f(0);
        if (W === X || W === Y || W === Z) continue;
        if (f(1) !== X || f(2) !== Y || f(3) !== Y || f(4) !== X || f(5) !== W || f(6) !== Y || f(7) !== Z || f(8) !== W) continue;
        const origin = o - shift * cell - shift * n * cell;
        if (origin < 0 || origin + n * n * cell > rom.length) continue;
        // a linear encoding (×10, 4.12, 0/2/4/8) can hold other multipliers too (Too Many Types has ×4 and ×3 ones);
        // any other encoding only the four values seen
        const linear = Z === 0 && W === 2 * X && Y * 2 === X;
        const value = new Map([[X, 1], [Y, 0.5], [Z, 0], [W, 2]]);
        const of = (v) => (linear ? (v / X <= 8 ? v / X : undefined) : value.get(v));
        let clean = true;
        for (let i = 0; i < n * n && clean; i++) if (of(rd(origin + i * cell)) === undefined) clean = false;
        if (clean) out.push({ offset: origin, n, cell, mult: (a, d) => (a < n && d < n ? of(rd(origin + (a * n + d) * cell)) : 1) });
      }
    }
  }
  return out;
}

/**
 * The best chart of `candidates` that agrees with the retail one (at most 2 cells off): the one with matchups for the
 * most types (a hack's Fairy-aware chart over the retail one it left in the ROM), then the bigger one.
 * `idOf(key)` → the game's id of an official type. → { mult, ids, offset } or null.
 */
function pickChart(candidates, idOf, gen, maxId) {
  let best = null;
  for (const c of candidates) {
    if (mismatches(c.mult, idOf, gen) > 2) continue;
    const ids = new Set();
    for (let a = 0; a < maxId; a++) for (let d = 0; d < maxId; d++) if (c.mult(a, d) !== 1) ids.add(a).add(d);
    const score = ids.size * 10000 + (c.n || 0);
    if (!best || score > best.score) best = { ...c, ids, score };
  }
  return best;
}

const fromTriples = (t) => ({ ...t, mult: (a, d) => (a < 64 && d < 64 && t.cells[a * 64 + d] >= 0 ? t.cells[a * 64 + d] : 1) });

// what Fairy deals and takes (Gen 6) – for a game whose Pokémon have the type but whose chart (found by the retail
// matchups) has none for it: Renegade Platinum keeps the retail chart and handles Fairy elsewhere
const FAIRY_ATK = { fighting: 2, poison: 0.5, steel: 0.5, fire: 0.5, dragon: 2, dark: 2 };
const FAIRY_DEF = { fighting: 0.5, bug: 0.5, poison: 2, steel: 2, dragon: 0, dark: 0.5 };
function withFairy(chart) {
  if (!chart || chart.fairy || Object.values(chart).some((r) => 'fairy' in r)) return chart;
  const out = { ...chart, fairy: { ...FAIRY_ATK } };
  for (const [a, m] of Object.entries(FAIRY_DEF)) out[a] = { ...out[a], fairy: m };
  // (Steel stops resisting Ghost and Dark with the type)
  for (const a of ['ghost', 'dark']) if (out[a]?.steel === 0.5) {
    out[a] = { ...out[a] };
    delete out[a].steel;
  }
  return out;
}

/** A chart by id → by key, only what isn't ×1. */
function chartByKey(mult, keys) {
  const chart = {};
  keys.forEach((a, ai) => {
    if (!a || a === '???') return;
    keys.forEach((d, di) => {
      if (!d || d === '???') return;
      const m = mult(ai, di);
      if (m !== 1) (chart[a] ||= {})[d] = m;
    });
  });
  return chart;
}

// ---------------------------------------------------------------- moves

/**
 * GBA gBattleMoves, found by moves no game changed – Pound and Scratch (power 40, Normal, 100 %, 35 PP), Karate Chop
 * (50, Fighting, 100 %, 25), Ember and Water Gun (40, Fire / Water, 100 %, 25) – at the same place in entries of any
 * size (power, type, accuracy and PP follow each other in the retail struct, CFRU's and older expansions'). A build that
 * packs them into bitfields (newer expansions) isn't found. → { offset, stride, types: [id] (index = the game's move) }
 * or null. `shift` = the id of Normal.
 */
function gbaMoveTypes(rom, shift, max = 1000) {
  const at = (o, v) => v.every((x, k) => rom[o + k] === x);
  const N = shift;
  let best = null;
  for (let p = 0; p + 64 < rom.length; p++) {
    if (rom[p] !== 40 || !at(p, [40, N, 100, 35])) continue;
    for (let s = 8; s <= 64; s++) {
      if (p + 55 * s > rom.length || !at(p + s, [50, N + 1, 100, 25]) || !at(p + 9 * s, [40, N, 100, 35]) || !at(p + 51 * s, [40, N + 10, 100, 25]) || !at(p + 54 * s, [40, N + 11, 100, 25])) continue;
      const types = [null];
      for (let i = 1; i < max && p + i * s < rom.length; i++) {
        const e = p + (i - 1) * s;
        if (rom[e + 1] >= 0x40 || rom[e + 2] > 100 || rom[e + 3] > 64) break;
        types[i] = rom[e + 1];
      }
      // (of the tables found the longest: Radical Red keeps FireRed's next to its own)
      if (types.length > 300 && (!best || types.length > best.types.length)) best = { offset: p - 1, stride: s, types };
    }
  }
  return best;
}

// ---------------------------------------------------------------- DS

/** The ARM9 overlays of a DS ROM, decompressed (NitroSDK backward LZ where the table flags it). */
export function ndsOverlays(rom) {
  const off = u32(rom, 0x50);
  const size = u32(rom, 0x54);
  const fat = u32(rom, 0x48);
  const out = [];
  if (!off || off + size > rom.length) return out;
  for (let o = off; o + 32 <= off + size; o += 32) {
    const file = u32(rom, o + 0x18);
    const flags = u32(rom, o + 0x1c);
    const start = u32(rom, fat + file * 8);
    const end = u32(rom, fat + file * 8 + 4);
    if (end <= start || end > rom.length) continue;
    let bytes = rom.subarray(start, end);
    if (flags & 0x01000000) {
      try {
        bytes = blzDecompress(bytes);
      } catch {
        continue;
      }
    }
    out.push({ id: u32(rom, o), bytes });
  }
  return out;
}

function dsPersonal(rom, gen, files, code) {
  const path = gen === 5 ? 'a/0/1/6' : /^IP[KG]$/.test(code) ? 'a/0/0/2' : (files.find((f) => /^poketool\/personal(_\w+)?\/pl_personal\.narc$/.test(f.path)) || files.find((f) => /^poketool\/personal(_\w+)?\/personal\.narc$/.test(f.path)))?.path;
  const narc = path ? ndsFile(rom, path, files) : null;
  if (!narc) return null;
  const parts = parseNarc(narc);
  const count = gen === 5 ? 649 : 493;
  if (parts.length < count) return null;
  const out = [];
  for (let i = 1; i <= count; i++) out[i] = parts[i]?.length > 8 ? [parts[i][6], parts[i][7]] : null;
  return { path, types: out };
}

// ---------------------------------------------------------------- entry point

/** The key of a type a game has beyond the official ones: 'x-' + its name ("Monke" → 'x-monke'). */
const ownKey = (name, id, used) => {
  let k = `x-${String(name).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '') || id}`;
  if (used.has(k)) k = `${k}-${id}`;
  used.add(k);
  return k;
};

/**
 * The types of a ROM. `opts`: gen3Charset, `speciesMap` (romSpecies() result: the game's species → National Dex, its
 * own Pokémon as `fakemon` + index), `vanillaIndex` (the retail Gen 3 map), `baseTypes(id, gen)` (the app's types – to
 * tell where Normal sits in the game's ids), `moveMap` (an expanded engine's move numbers → National, romspecies.mjs
 * gen3MoveMap), `fakemon`.
 * → { gen, keys, labels, species, chart, moves, fairy, own, source } or null (no species table found). `keys[id]` = the
 * type key of the game's type id, `species[national]` = its types, `chart` = { atk: { def: mult } } without the ×1
 * matchups (null when no chart passed the checks), `moves[national move]` = its type (GBA, where found), `own` = the
 * number of types the game has beyond the official ones. Never throws.
 */
export function romTypes(rom, opts = {}) {
  try {
    if (!rom || rom.length < 0x200) return null;
    if (rom[0xb2] === 0x96 && rom[3] === 0xea) return gbaTypes(rom, opts);
    const sys = rom[0x104] === 0xce && rom[0x105] === 0xed ? 'gb' : null;
    if (sys) return gbTypes(rom, opts);
    return dsTypes(rom, opts);
  } catch {
    return null;
  }
}

function gbaTypes(rom, opts) {
  const fakemon = opts.fakemon || 20000;
  const sp = opts.speciesMap;
  const count = Math.max(411, (sp?.map?.length || 0) - 1, sp?.count || 0);
  const base = gbaBaseStats(rom, count);
  if (!base) return null;
  const names = gbaTypeNames(rom, opts.gen3Charset);
  // the game's species → National Dex (the ROM's own map for a hack with other Pokémon or an expanded engine)
  const national = (i) => (sp?.map ? sp.map[i] || (sp.unknown?.[i] ? fakemon + i : 0) : opts.vanillaIndex?.[i] || 0);
  // where Normal sits in the game's ids: 0, or 1 where TYPE_NONE comes first (newer expansions) – the one that gives
  // most Pokémon of the first generations the types they have in the app (a hack retypes a few)
  let shift = 0;
  if (typeof opts.baseTypes === 'function') {
    const score = [0, 1].map((k) => {
      let n = 0;
      for (let i = 1; i < base.types.length; i++) {
        const id = national(i);
        const t = base.types[i];
        if (!t || !id || id > 386) continue;
        const want = opts.baseTypes(id, 3) || [];
        const got = [...new Set(t.map((x) => TYPES34[x - k]))];
        if (want.length && got.join('/') === want.join('/')) n++;
      }
      return n;
    });
    shift = score[1] > score[0] ? 1 : 0;
    if (Math.max(...score) < 150) return null; // the ids don't fit the official types at all
  }
  // keys by id: the official 18 by position, beyond them by name (Fairy in any language, else a type of its own – one
  // that a Pokémon has)
  const usedIds = new Set(base.types.filter(Boolean).flat());
  const maxId = Math.max(shift + 18, ...base.types.filter(Boolean).flat().map((x) => x + 1), names ? names.names.length + shift : 0);
  const keys = [];
  const labels = {};
  const used = new Set();
  for (let id = 0; id < maxId; id++) {
    const pos = id - shift;
    if (pos < 0) keys[id] = null;
    else if (pos < 18) keys[id] = TYPES34[pos];
    else {
      const n = names?.names[pos] || '';
      if (!n) keys[id] = null;
      else if (FAIRY.test(n)) keys[id] = 'fairy';
      else if (!usedIds.has(id)) keys[id] = null; // (a name no Pokémon has: CFRU's leftover "Fight" at 18, Stellar)
      else {
        keys[id] = ownKey(n, id, used);
        labels[keys[id]] = n;
      }
    }
  }
  const species = {};
  for (let i = 1; i < base.types.length; i++) {
    const id = national(i);
    const t = base.types[i];
    if (!id || !t || species[id]) continue;
    const ks = [...new Set(t.map((x) => keys[x]))];
    if (ks.some((k) => !k)) continue; // a type id without a name: not shown rather than guessed
    species[id] = ks.filter((k) => k !== '???');
  }
  // the chart: the retail triples, CFRU's (Fairy 23), or a matrix
  const idOf = (k) => (k === '???' ? undefined : keys.indexOf(k) >= 0 ? keys.indexOf(k) : undefined);
  const cands = [...tripleCharts(rom, { maxId: Math.min(maxId, 0x40), min: 90 }).map(fromTriples), ...matrixCharts(rom, shift)];
  const c = pickChart(cands, idOf, 3, maxId);
  const hasFairy = Object.values(species).some((t) => t.includes('fairy'));
  const chart = c ? (hasFairy ? withFairy(chartByKey(c.mult, keys)) : chartByKey(c.mult, keys)) : null;
  // the moves' types (where gBattleMoves is found), by the app's move numbers
  let moves = null;
  const mt = gbaMoveTypes(rom, shift);
  if (mt) {
    moves = {};
    mt.types.forEach((t, i) => {
      const n = opts.moveMap ? opts.moveMap[i] || 0 : i;
      if (n && keys[t] && keys[t] !== '???' && !moves[n]) moves[n] = keys[t];
    });
  }
  const own = Object.keys(labels).length;
  return {
    gen: 3, keys, labels, species, chart, moves, fairy: keys.includes('fairy') && Object.values(species).some((t) => t.includes('fairy')), own,
    source: { baseStats: base.offset, stride: base.stride, names: names?.offset ?? null, chart: c ? c.offset : null, moves: mt?.offset ?? null, shift },
  };
}

function gbTypes(rom) {
  const gen = rom[0x143] === 0x80 || rom[0x143] === 0xc0 ? 2 : 1;
  // (a Gen 1 game with the CGB flag: Yellow's is 0x80 too – told apart by the base data's shape)
  const base = gbBaseStats(rom, gen) || gbBaseStats(rom, gen === 2 ? 1 : 2);
  if (!base) return null;
  const g = base.stride === 28 ? 1 : 2;
  const keys = [];
  for (const [id, k] of Object.entries(GB_IDS)) keys[Number(id)] = k;
  if (g === 1) keys[9] = keys[0x1b] = undefined;
  const species = {};
  base.types.forEach((t, id) => {
    if (!t) return;
    const ks = [...new Set(t.map((x) => keys[x]))];
    if (!ks.some((k) => !k)) species[id] = ks.filter((k) => k !== '???');
  });
  if (Object.keys(species).length < base.types.length * 0.9) return null;
  const idOf = (k) => { const i = keys.indexOf(k); return i >= 0 ? i : undefined; };
  const c = pickChart(tripleCharts(rom, { gb: true, maxId: 0x1c, min: 60 }).map(fromTriples), idOf, g, 0x1c);
  return { gen: g, keys, labels: {}, species, chart: c ? chartByKey(c.mult, keys) : null, moves: null, fairy: false, own: 0, source: { baseStats: base.offset, chart: c ? c.offset : null } };
}

function dsTypes(rom) {
  const code = String.fromCharCode(...rom.subarray(0x0c, 0x10)).slice(0, 3);
  if (!/^[A-Z0-9]{3}$/.test(code)) return null;
  const gen = /^IR[ABDE]$/.test(code) ? 5 : 4;
  const files = listNdsFiles(rom);
  const p = dsPersonal(rom, gen, files, code);
  if (!p) return null;
  const names = gen === 5 ? TYPES5 : TYPES34;
  // Fairy: a Gen 4 '???' that a Pokémon really has (no retail Pokémon of #1–493 is '???'), Gen 5's type 17
  const fairyId = gen === 5 ? 17 : 9;
  const fairy = p.types.some((t) => t && (t[0] === fairyId || t[1] === fairyId));
  const keys = names.map((k, i) => (i === fairyId && fairy ? 'fairy' : gen === 5 && i === 17 ? null : k));
  const species = {};
  p.types.forEach((t, id) => {
    if (!t) return;
    const ks = [...new Set(t.map((x) => keys[x]))];
    if (!ks.some((k) => !k)) species[id] = ks.filter((k) => k !== '???');
  });
  // the chart: in the ARM9 binary or a battle overlay
  const idOf = (k) => { const i = keys.indexOf(k); return i >= 0 ? i : undefined; };
  const bins = [{ id: 'arm9', bytes: ndsArm9(rom).bytes }, ...ndsOverlays(rom)];
  let c = null;
  for (const b of bins) {
    const cands = gen === 4 ? tripleCharts(b.bytes, { maxId: 18, min: 90 }).map(fromTriples) : matrixCharts(b.bytes, 0).filter((m) => m.cell === 1 && (m.n === 17 || m.n === 18));
    const got = pickChart(cands, idOf, gen, 18);
    if (got && (!c || got.score > c.score)) c = { ...got, where: `${b.id}+0x${got.offset.toString(16)}` };
  }
  const chart = c ? chartByKey(c.mult, keys) : null;
  return { gen, keys, labels: {}, species, chart: fairy ? withFairy(chart) : chart, moves: null, fairy, own: 0, source: { personal: p.path, chart: c?.where || null } };
}
