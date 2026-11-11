// Reading a game's data from its ROM instead of per-game patches: types (names, each Pokémon's, the chart, the moves'),
// level caps from the trainers, Gen 3 badges and the battle's current types, and what souldew can read per feature.
// Synthetic ROMs and RAM shaped like what was measured in the real games (numbers in comments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

const { romTypes, TYPES34 } = await import('../shared/live/romtypes.mjs');
const { gen3Caps, capsFrom, bossKind } = await import('../shared/live/romcaps.mjs');
const { romFeatures, FeatureCheck } = await import('../shared/live/features.mjs');
const { gen4Messages, gen5Messages } = await import('../shared/live/romloc.mjs');
const { readLiveParty, readLiveBattle, findEntry, LiveTables } = await import('../shared/live/parse.mjs');
const { retailSingle, setTypeChart, effectiveness, typesOfGen } = await import('../shared/typechart.mjs');
const { romCapFor, prettyTrainer } = await import('../shared/routes.mjs');
const { levelCapOf } = await import('../shared/streamapi.mjs');

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const cs3 = json('charset_gen3.json');
const api = json('pokeapi.json');
const addresses = json('addresses.json');
const code3 = Object.fromEntries(Object.entries(cs3.table).filter(([, v]) => v.length === 1).map(([k, v]) => [v, parseInt(k, 16)]));
const enc3 = (s) => [...s].map((c) => code3[c]);
const put16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const put32 = (b, o, v) => {
  for (let i = 0; i < 4; i++) b[o + i] = (v >>> (i * 8)) & 0xff;
};
const baseTypes = (id, gen) => {
  const past = api.typesGen?.[id];
  const k = past ? Object.keys(past).map(Number).sort((a, b) => a - b).find((x) => x >= gen) : undefined;
  return k !== undefined ? past[k] : api.types?.[id] || [];
};
function gba(size, code = 'BPRE') {
  const rom = new Uint8Array(size);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...code].map((c) => c.charCodeAt(0)), 0xac);
  return rom;
}
const STD = ['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
const RETAIL_NAMES = ['NORMAL', 'FIGHT', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST', 'STEEL', '???', 'FIRE', 'WATER', 'GRASS', 'ELECTR', 'PSYCHC', 'ICE', 'DRAGON', 'DARK'];
const FAIRY_ATK = { fighting: 2, poison: 0.5, steel: 0.5, fire: 0.5, dragon: 2, dark: 2 };
const FAIRY_DEF = { fighting: 0.5, bug: 0.5, poison: 2, steel: 2, dragon: 0, dark: 0.5 };

/**
 * A GBA ROM with the tables souldew reads types from: type names (`names`, `stride`), base stats (entry `bsStride`, the
 * National Dex order for #1–386 with the app's Gen 3 types, ids `+ shift`), the chart (`chart(rom, idOf)`) and moves.
 */
function typesRom({ names = RETAIL_NAMES, stride = 7, bsStride = 28, shift = 0, retype = {}, chart, moves = true } = {}) {
  const rom = gba(0x100000);
  names.forEach((n, i) => {
    const o = 0x1000 + i * stride;
    rom.fill(0, o, o + stride);
    rom.set([...(n ? enc3(n) : []), 0xff], o); // (an empty entry: just the terminator, as CFRU's 18–22)
  });
  const id = (k) => (typeof k === 'number' ? k : TYPES34.indexOf(k) + shift);
  const BS = 0x4000;
  for (let i = 1; i <= 411; i++) {
    const o = BS + i * bsStride;
    rom.set([50, 50, 50, 50, 50, 50], o);
    const t = retype[i] || (i <= 386 ? baseTypes(i, 3) : ['normal']);
    rom.set([id(t[0]), id(t[1] || t[0])], o + 6);
  }
  rom.set([45, 49, 49, 45, 65, 65], BS + 1 * bsStride);
  rom.set([60, 62, 63, 60, 80, 80], BS + 2 * bsStride);
  rom.set([80, 82, 83, 80, 100, 100], BS + 3 * bsStride);
  if (chart) chart(rom, id);
  if (moves) {
    // gBattleMoves: 12 bytes (effect, power, type, accuracy, PP …); Pound, Karate Chop, Scratch, Ember, Water Gun
    const M = 0x60000;
    for (let i = 1; i <= 400; i++) rom.set([0, 60, id('normal'), 90, 20], M + i * 12);
    const set = (n, power, type, acc, pp) => rom.set([0, power, id(type), acc, pp], M + n * 12);
    set(1, 40, 'normal', 100, 35);
    set(2, 50, 'fighting', 100, 25);
    set(10, 40, 'normal', 100, 35);
    set(52, 40, 'fire', 100, 25);
    set(55, 40, 'water', 100, 25);
    set(204, 0, retype.charm ?? 'normal', 100, 20); // Charm – a Fairy move in a hack that has the type
  }
  return rom;
}

/** The retail chart as triples (+ Fairy's matchups with `fairyId`) at `at`: what the retail games and CFRU store. */
function triples(at, { fairyId = null, gen6 = false } = {}) {
  return (rom, id) => {
    let o = at;
    const put = (a, d, m) => {
      rom.set([a, d, m * 10], o);
      o += 3;
    };
    for (const a of STD) {
      for (const d of STD) {
        const m = gen6 && d === 'steel' && (a === 'ghost' || a === 'dark') ? 1 : retailSingle(a, d, 4);
        if (m !== 1) put(id(a), id(d), m);
      }
    }
    if (fairyId !== null) {
      for (const [d, m] of Object.entries(FAIRY_ATK)) put(fairyId, id(d), m);
      for (const [a, m] of Object.entries(FAIRY_DEF)) put(id(a), fairyId, m);
    }
    rom.set([0xff, 0xff, 0], o);
  };
}

test('GBA types from the ROM: Complete FireRed Upgrade-style Fairy as type 23, its chart over the retail one left in the ROM, the moves\' types', () => {
  // the type-name table: the retail 18, 18–22 empty, Fairy at 23 (Unbound, Radical Red)
  const names = [...RETAIL_NAMES, '', '', '', '', '', 'Fairy'];
  const rom = typesRom({
    names,
    retype: { 35: [23, 23], 36: [23, 23], charm: 23 },
    chart: (r, id) => {
      triples(0x20000)(r, id); // the retail chart, left in the ROM
      triples(0x30000, { fairyId: 23, gen6: true })(r, id); // the hack's own
    },
  });
  const t = romTypes(rom, { gen3Charset: cs3, vanillaIndex: Array.from({ length: 412 }, (_, i) => i), baseTypes });
  assert.equal(t.gen, 3);
  assert.equal(t.keys[23], 'fairy');
  assert.equal(t.own, 0, 'Fairy is no type of the hack\'s own');
  assert.deepEqual(t.species[35], ['fairy'], 'Clefairy');
  assert.deepEqual(t.species[1], ['grass', 'poison']);
  assert.equal(t.fairy, true);
  assert.equal(t.source.chart, 0x30000, 'the chart with Fairy, not the retail one');
  assert.equal(t.chart.dragon.fairy, 0);
  assert.equal(t.chart.fairy.dragon, 2);
  assert.equal(t.chart.ghost.steel, undefined, 'Steel no longer resists Ghost (Gen 6)');
  assert.equal(t.chart.fire.grass, 2);
  assert.equal(t.moves[204], 'fairy', 'Charm');
  assert.equal(t.moves[52], 'fire', 'Ember');
});

test('GBA types from the ROM: a hack with types of its own (Too Many Types) – TYPE_NONE first, 4.12 fixed point chart words, named as the game names them', () => {
  const names = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy', 'Stellar', 'Monke'];
  const N = 22; // TYPE_NONE + 21
  const rom = typesRom({
    names, stride: 40, bsStride: 0x104, shift: 1, moves: false,
    retype: { 25: [21, 21], 26: [21, 'electric'] }, // Pikachu Monke, Raichu Monke/Electric
    chart: (r, id) => {
      const M = 0x80000;
      for (let i = 0; i < N * N; i++) put32(r, M + i * 4, 0x1000);
      for (const a of STD) for (const d of STD) put32(r, M + (id(a) * N + id(d)) * 4, retailSingle(a, d, 4) * 0x1000);
      put32(r, M + (21 * N + id('normal')) * 4, 0x2000); // Monke hits Normal hard
      put32(r, M + (id('normal') * N + 21) * 4, 0x800);
      put32(r, M + (21 * N + id('psychic')) * 4, 0x3000); // and Psychic ×3 (Too Many Types has such)
    },
  });
  const t = romTypes(rom, { gen3Charset: cs3, vanillaIndex: Array.from({ length: 412 }, (_, i) => i), baseTypes });
  assert.equal(t.source.shift, 1);
  assert.equal(t.keys[21], 'x-monke');
  assert.equal(t.labels['x-monke'], 'Monke');
  assert.equal(t.own, 1);
  assert.deepEqual(t.species[25], ['x-monke']);
  assert.deepEqual(t.species[26], ['x-monke', 'electric']);
  assert.equal(t.chart['x-monke'].normal, 2);
  assert.equal(t.chart['x-monke'].psychic, 3);
  assert.equal(t.chart.normal['x-monke'], 0.5);
  assert.equal(t.keys[20], null, 'Stellar: a name no Pokémon has');
  assert.equal(t.moves, null, 'no move table: their types aren\'t guessed');
  // the battle helper uses the game's chart while it is set
  setTypeChart(t);
  try {
    assert.equal(effectiveness('x-monke', ['normal', 'psychic']), 6);
    assert.ok(typesOfGen(3).includes('x-monke'));
  } finally {
    setTypeChart(null);
  }
  assert.equal(effectiveness('x-monke', ['normal']), 1, 'unset: the built-in chart again');
});

test('GBA types from the ROM: Radical Red\'s matrix (0 = ×1, 1 = ×0); a chart that doesn\'t agree with the retail one isn\'t taken; no table, no guess', () => {
  const N = 24;
  const enc = { 1: 0, 0: 1, 0.5: 5, 2: 20 };
  const matrix = (bad = false) => (r, id) => {
    const M = 0x80000;
    for (const a of STD) for (const d of STD) r[M + id(a) * N + id(d)] = enc[retailSingle(a, d, 4)];
    if (bad) for (const d of STD) r[M + id('fire') * N + id(d)] = 20; // Fire beats everything: not a chart a game has
  };
  const vi = Array.from({ length: 412 }, (_, i) => i);
  const t = romTypes(typesRom({ chart: matrix() }), { gen3Charset: cs3, vanillaIndex: vi, baseTypes });
  assert.equal(t.source.chart, 0x80000);
  assert.equal(t.chart.normal.ghost, 0);
  assert.equal(t.chart.water.fire, 2);
  assert.equal(romTypes(typesRom({ chart: matrix(true) }), { gen3Charset: cs3, vanillaIndex: vi, baseTypes }).chart, null);
  assert.equal(romTypes(gba(0x40000), { gen3Charset: cs3, baseTypes }), null);
});

test('Game Boy types from the ROM: base data (dex number, stats, types) and TypeMatchups with the Foresight marker', () => {
  const rom = new Uint8Array(0x40000);
  rom[0x104] = 0xce;
  rom[0x105] = 0xed;
  rom[0x143] = 0x80; // a Game Boy Color game
  const GB = { normal: 0, fighting: 1, flying: 2, poison: 3, ground: 4, rock: 5, bug: 7, ghost: 8, steel: 9, fire: 0x14, water: 0x15, grass: 0x16, electric: 0x17, psychic: 0x18, ice: 0x19, dragon: 0x1a, dark: 0x1b };
  const B = 0x8000;
  for (let i = 1; i <= 251; i++) {
    const t = baseTypes(i, 2);
    rom.set([i, 50, 50, 50, 50, 50, 50, GB[t[0]], GB[t[1] || t[0]]], B + (i - 1) * 32);
  }
  rom.set([1, 45, 49, 49, 45, 65, 65, GB.grass, GB.poison], B);
  let o = 0x20000;
  for (const a of STD) {
    for (const d of STD) {
      const m = retailSingle(a, d, 2);
      if (m === 1 || (a === 'normal' && d === 'ghost') || (a === 'fighting' && d === 'ghost')) continue;
      rom.set([GB[a], GB[d], m * 10], o);
      o += 3;
    }
  }
  rom.set([0xfe, GB.normal, GB.ghost, 0, GB.fighting, GB.ghost, 0, 0xff], o);
  const t = romTypes(rom, {});
  assert.equal(t.gen, 2);
  assert.deepEqual(t.species[1], ['grass', 'poison']);
  assert.deepEqual(t.species[35], ['normal'], 'Clefairy is Normal in Gen 2');
  assert.equal(t.chart.normal.ghost, 0, 'the entries after the Foresight marker count');
  assert.equal(t.chart.ghost.steel, 0.5);
});

// ---------------------------------------------------------------- level caps

/**
 * A Gen 3 ROM with trainers (40-byte gTrainers, 8-byte party members), class names (13 bytes) and trainerbattle
 * scripts that set flags after the leaders' battles (FireRed: FLAG_DEFEATED_BROCK 0x4B0 …, FLAG_BADGE01_GET 0x820 …).
 * `bosses` = [{ cls: 'leader'|'elite'|'champion', name, levels, badge?, script? }].
 */
function capsRom(bosses, { scripts = true } = {}) {
  const rom = gba(0x200000);
  const CLASSES = 0x10000;
  const classNames = ['PKMN TRAINER', 'HIKER', 'LASS', 'ELITE FOUR', 'LEADER', 'CHAMPION', 'AQUA LEADER'];
  for (let i = 0; i < 40; i++) {
    const n = classNames[i] || `CLASS${String.fromCharCode(65 + (i % 26))}`;
    rom.fill(0, CLASSES + i * 13, CLASSES + i * 13 + 13);
    rom.set([...enc3(n), 0xff], CLASSES + i * 13);
  }
  const clsId = { leader: 4, elite: 3, champion: 5, hiker: 1, lass: 2 };
  const T = 0x20000;
  const P = 0x40000;
  let party = P;
  const trainers = [{ cls: 'none' }];
  for (let i = 0; i < 120; i++) trainers.push({ cls: i % 2 ? 'hiker' : 'lass', name: `JOE${i}`, levels: [5 + (i % 30)] });
  const first = trainers.length;
  trainers.push(...bosses);
  trainers.forEach((tr, id) => {
    const o = T + id * 40;
    if (tr.cls === 'none') {
      rom[o + 4] = 0xff;
      return;
    }
    rom[o + 1] = clsId[tr.cls];
    rom.set([...enc3(tr.name), 0xff], o + 4);
    rom[o + 0x20] = tr.levels.length;
    put32(rom, o + 0x24, 0x08000000 + party);
    for (const lv of tr.levels) {
      put16(rom, party + 2, lv);
      put16(rom, party + 4, 25);
      party += 8;
    }
  });
  if (scripts) {
    let s = 0x60000;
    let c = 0x70000;
    bosses.forEach((b, k) => {
      if (b.script === false) return;
      const id = first + k;
      const flags = Number.isInteger(b.badge) ? [0x4b0 + b.badge, 0x820 + b.badge] : [];
      rom.set([0x5c, 1, id & 0xff, id >> 8, 0, 0], s);
      put32(rom, s + 6, 0x08000000 + 0x7f000);
      put32(rom, s + 10, 0x08000000 + 0x7f000);
      put32(rom, s + 14, 0x08000000 + c);
      s += 18;
      for (const f of flags) {
        rom.set([0x29, f & 0xff, f >> 8], c);
        c += 3;
      }
      rom[c] = 0x02; // end
      c = (c + 0x100) & ~0xff; // (scripts lie apart, with other code between them)
    });
  }
  return rom;
}
// FireRed's bosses (ace levels as in the game): the order comes from the badge flags their scripts set
const FR = [
  { cls: 'leader', name: 'GIOVANNI', levels: [45, 50], badge: 7 },
  { cls: 'leader', name: 'BROCK', levels: [12, 14], badge: 0 },
  { cls: 'leader', name: 'MISTY', levels: [18, 21], badge: 1 },
  { cls: 'leader', name: 'LT. SURGE', levels: [21, 24], badge: 2 },
  { cls: 'leader', name: 'ERIKA', levels: [24, 29], badge: 3 },
  { cls: 'leader', name: 'KOGA', levels: [37, 43], badge: 4 },
  { cls: 'leader', name: 'BLAINE', levels: [42, 47], badge: 6 },
  { cls: 'leader', name: 'SABRINA', levels: [38, 43], badge: 5 },
  { cls: 'elite', name: 'LORELEI', levels: [52, 54] },
  { cls: 'elite', name: 'BRUNO', levels: [53, 56] },
  { cls: 'elite', name: 'AGATHA', levels: [54, 58] },
  { cls: 'elite', name: 'LANCE', levels: [56, 60] },
  { cls: 'champion', name: 'TERRY', levels: [59, 63] },
  // the rematches (after the National Dex): stronger, the same names
  { cls: 'elite', name: 'LORELEI', levels: [64, 66] },
  { cls: 'champion', name: 'TERRY', levels: [72, 75] },
];

test('level caps from a GBA ROM\'s trainers: leaders by class name, ordered by the badge flags their scripts set, the champion after the last badge', () => {
  const r = gen3Caps(capsRom(FR), { gen3Charset: cs3 });
  assert.deepEqual(r.caps, [14, 21, 24, 29, 43, 43, 47, 50]);
  assert.deepEqual(r.leaders, ['BROCK', 'MISTY', 'LT. SURGE', 'ERIKA', 'KOGA', 'SABRINA', 'BLAINE', 'GIOVANNI']);
  assert.equal(r.badgeFlags, 0x820, 'the badge flags (FLAG_DEFEATED_* count up too: the higher run)');
  assert.deepEqual(r.final, { name: 'Champion', cap: 63 }, 'the champion\'s first team, not the rematch');
});

test('level caps from a GBA ROM\'s trainers: the trainers a script battles; without scripts by ace; nothing when it isn\'t clean', () => {
  // a leader copy no script battles (Emerald's rematches, FireRed's leftover Ruby leaders) doesn't count
  const extra = [...FR, { cls: 'leader', name: 'ROXANNE', levels: [5], script: false }];
  assert.deepEqual(gen3Caps(capsRom(extra), { gen3Charset: cs3 }).caps, [14, 21, 24, 29, 43, 43, 47, 50]);
  // no trainerbattle scripts at all (Unbound starts its battles another way): sorted by ace
  const noFlags = FR.map(({ badge, ...b }) => b);
  assert.deepEqual(gen3Caps(capsRom(noFlags, { scripts: false }), { gen3Charset: cs3 }).caps, [14, 21, 24, 29, 43, 43, 47, 50]);
  // a leader with teams of a few levels apart (difficulty settings): which one the player meets isn't known
  const diff = [...noFlags, { cls: 'leader', name: 'BROCK', levels: [15, 17] }];
  assert.match(gen3Caps(capsRom(diff, { scripts: false }), { gen3Charset: cs3 }).why, /BROCK: teams of several difficulties/);
  // two regions' leaders (Radical Red's Johto ones, Light Platinum's second region): not eight
  const more = [...noFlags, { cls: 'leader', name: 'FALKNER', levels: [80, 85] }];
  assert.match(gen3Caps(capsRom(more, { scripts: false }), { gen3Charset: cs3 }).why, /9 gym leaders/);
  assert.equal(gen3Caps(gba(0x40000), { gen3Charset: cs3 }).why, 'no trainer table');
});

test('capsFrom: aces must rise with the badges, the champion must top the Elite Four; boss class names in five languages and the hacks\'', () => {
  const L = (name, ace, badge) => ({ id: badge, kind: 'leader', name, ace, badge });
  const eight = [L('A', 14, 0), L('B', 21, 1), L('C', 24, 2), L('D', 29, 3), L('E', 43, 4), L('F', 43, 5), L('G', 47, 6), L('H', 50, 7)];
  assert.deepEqual(capsFrom(eight).caps, [14, 21, 24, 29, 43, 43, 47, 50]);
  assert.equal(capsFrom(eight).final, null, 'no Elite Four, no champion: nothing after the last badge');
  // Radical Red's leftover FireRed Giovanni (ace 50) as the 8th of leaders up to 76: not its real one
  assert.match(capsFrom([...eight.slice(0, 7).map((l, i) => ({ ...l, ace: 20 + i * 9 })), L('H', 50, 7)]).why, /below/);
  const withTop = [...eight, { id: 9, kind: 'elite', name: 'X', ace: 60 }, { id: 10, kind: 'champion', name: 'Y', ace: 55 }, { id: 11, kind: 'champion', name: 'Z', ace: 68 }];
  assert.deepEqual(capsFrom(withTop).final, { name: 'Champion', cap: 68 }, 'the weakest champion at least as strong as the Elite Four');
  for (const n of ['LEADER', 'Leader', 'LEITER', 'Arenaleiter', 'Gym Leader', 'Líder', 'Capopalestra']) assert.equal(bossKind(n), 'leader', n);
  for (const n of ['ELITE FOUR', 'Top Vier', 'Conseil 4', 'Alto Mando', 'Superquattro']) assert.equal(bossKind(n), 'elite', n);
  for (const n of ['CHAMPION', 'CHAMP', 'Maître', 'Campeón', 'Campione']) assert.equal(bossKind(n), 'champion', n);
  assert.equal(bossKind('AQUA LEADER'), null);
  assert.equal(bossKind('Hiker'), null);
});

test('DS text: compressed trainer names (0xF100) – 15 bits per word in Gen 4, 16 in Gen 5 – read in full', () => {
  // pack 9-bit characters, low bits first, `w` bits of each word
  const pack = (chars, w) => {
    const out = [0xf100];
    let acc = 0;
    let bits = 0;
    for (const c of [...chars, 0x1ff]) {
      acc |= c << bits;
      bits += 9;
      while (bits >= w) {
        out.push(acc & ((1 << w) - 1));
        acc >>>= w;
        bits -= w;
      }
    }
    if (bits) out.push(acc & ((1 << w) - 1));
    out.push(0xffff);
    return out;
  };
  // Gen 4: one string, encrypted as pokeplatinum's msgdata (seed, per-entry key, running character key)
  const chars = json('gen4.json').chars;
  const code4 = Object.fromEntries(Object.entries(chars).map(([k, v]) => [v, Number(k)]));
  const words4 = pack([...'Volkner'].map((c) => code4[c]), 15);
  const b4 = new Uint8Array(12 + words4.length * 2);
  const seed = 0x1234;
  put16(b4, 0, 1);
  put16(b4, 2, seed);
  const k = ((seed * 0x2fd) & 0xffff) * 1 & 0xffff;
  const k32 = (k | (k << 16)) >>> 0;
  put32(b4, 4, (12 ^ k32) >>> 0);
  put32(b4, 8, (words4.length ^ k32) >>> 0);
  let ck = 0x91bd3 & 0xffff;
  words4.forEach((w, j) => {
    put16(b4, 12 + j * 2, w ^ ck);
    ck = (ck + 0x493d) & 0xffff;
  });
  assert.deepEqual(gen4Messages(b4, chars), ['Volkner']);
  // Gen 5: one section, one string, the key running backwards from the last character
  const words5 = pack([...'Drayden'].map((c) => c.charCodeAt(0)), 16);
  const b5 = new Uint8Array(16 + 4 + 8 + words5.length * 2);
  put16(b5, 0, 1);
  put16(b5, 2, 1);
  put32(b5, 12, 16);
  put32(b5, 20, 12);
  put16(b5, 24, words5.length);
  let key = 0x5a5a;
  const enc = new Array(words5.length);
  for (let j = words5.length - 1; j >= 0; j--) {
    enc[j] = words5[j] ^ key;
    key = ((key >> 3) | (key << 13)) & 0xffff;
  }
  // (the last word is the terminator 0xFFFF encrypted with the first key: the decoder gets the key back from it)
  enc.forEach((w, j) => put16(b5, 28 + j * 2, w));
  assert.deepEqual(gen5Messages(b5), ['Drayden']);
});

// ---------------------------------------------------------------- badges and battle types (RAM)

function pk3({ pid = 0x01020300, otId = 0x0a0b0c0d, internal, level = 5, hp = 20, maxHp = 20 }) {
  const d = new Uint8Array(100);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint32(4, otId, true);
  d[8] = 0xff;
  const order = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG', 'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'][pid % 24];
  const plain = new Uint8Array(48);
  const pv = new DataView(plain.buffer);
  pv.setUint16(order.indexOf('G') * 12, internal, true);
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + pv.getUint16(i, true)) & 0xffff;
  dv.setUint16(28, sum, true);
  const key = (pid ^ otId) >>> 0;
  for (let i = 0; i < 48; i += 4) dv.setUint32(32 + i, (pv.getUint32(i, true) ^ key) >>> 0, true);
  d[84] = level;
  dv.setUint16(86, hp, true);
  dv.setUint16(88, maxHp, true);
  return d;
}
const idx3 = json('gen3_index_to_dex.json').map;

test('Gen 3 badges: SaveBlock1\'s badge flags, trusted only while "has a Pokémon" is set; a hack\'s own badge flags from its scripts', () => {
  const fr = findEntry(addresses, { platform: 'gba', code: 'BPRE' });
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  put(parseInt(fr.partyCountAddr, 16), [1]);
  put(parseInt(fr.partyAddr, 16), [...pk3({ internal: 4, level: 14, hp: 30, maxHp: 39 })]);
  const SB1 = 0x0202552c;
  const p = new Uint8Array(4);
  put32(p, 0, SB1);
  put(0x03005008, [...p]); // gSaveBlock1Ptr
  const flag = (f) => mem.set(SB1 + 0xee0 + (f >> 3), (mem.get(SB1 + 0xee0 + (f >> 3)) || 0) | (1 << (f & 7)));
  const T = new LiveTables({ charsetGen3: cs3, gen3Index: idx3 });
  for (const f of [0x820, 0x821, 0x822]) flag(f); // Boulder, Cascade, Thunder Badge
  assert.equal(readLiveParty(fr, read, T, {}).badges, undefined, 'no FLAG_SYS_POKEMON_GET (0x828): not the flag array');
  flag(0x828);
  assert.equal(readLiveParty(fr, read, T, {}).badges, 3);
  // a hack whose leaders' scripts set other flags (romcaps.mjs badgeFlags)
  for (const f of [0x900, 0x901]) flag(f);
  flag(0x908);
  assert.equal(readLiveParty(fr, read, T.withRom({ caps: { badgeFlags: 0x900 } }), {}).badges, 2);
  // an expanded engine only with its own badge flags
  assert.equal(readLiveParty({ ...fr, scan3: true, party3Base: { party: parseInt(fr.partyAddr, 16), count: parseInt(fr.partyCountAddr, 16) } }, read, T, {}).badges, undefined);
});

test('Gen 3 battle: the battlers\' current types from gBattleMons (FireRed\'s layout, type1/type2 at +0x21), trusted once the player\'s read as its species\' types', () => {
  const fr = findEntry(addresses, { platform: 'gba', code: 'BPRE' });
  const mem = new Map();
  const put = (a, bytes) => bytes.forEach((b, i) => mem.set(a + i, b));
  const read = (a, n) => Uint8Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0);
  const me = { pid: 0x01020300, otId: 0x0a0b0c0d, internal: 6, level: 36, hp: 100, maxHp: 120 }; // Charizard
  const foe = { pid: 0x11223300, otId: 0x55667788, internal: 9, level: 34, hp: 90, maxHp: 105 }; // Blastoise
  put(parseInt(fr.partyCountAddr, 16), [1]);
  put(parseInt(fr.partyAddr, 16), [...pk3(me)]);
  put(parseInt(fr.enemyPartyAddr, 16), [...pk3(foe)]);
  put(parseInt(fr.inBattle.addr, 16), [0x02]);
  put(parseInt(fr.battleTypeFlagsAddr, 16), [0x08, 0, 0, 0]);
  const BM = 0x02023be4;
  const battler = (at, m, types) => {
    const d = new Uint8Array(0x58);
    put16(d, 0, m.internal);
    d.set(types, 0x21);
    put16(d, 0x28, m.hp);
    d[0x2a] = m.level;
    put16(d, 0x2c, m.maxHp);
    put32(d, 0x48, m.pid);
    put32(d, 0x54, m.otId);
    put(at, [...d]);
  };
  const keys = [...TYPES34];
  const types = { gen: 3, keys, species: { 6: ['fire', 'flying'], 9: ['water'] } };
  battler(BM, me, [10, 2]); // Fire/Flying, as its species
  battler(BM + 0x58, foe, [11, 11]);
  const T = new LiveTables({ charsetGen3: cs3, gen3Index: idx3 }).withRom({ types });
  const state = {};
  const party = readLiveParty(fr, read, T, state).party;
  let b = readLiveBattle(fr, read, T, state, party);
  assert.deepEqual(b.enemy.types, ['water']);
  // a type change in battle (Soak on the opponent: Water → Psychic, say) shows at once
  battler(BM + 0x58, foe, [14, 14]);
  b = readLiveBattle(fr, read, T, state, party);
  assert.deepEqual(b.enemy.types, ['psychic']);
  // without the ROM's types: none from the battle (the species' types stand in)
  assert.equal(readLiveBattle(fr, read, new LiveTables({ charsetGen3: cs3, gen3Index: idx3 }), {}, party).enemy.types, undefined);
  // a battler whose types don't fit its species before anything was confirmed: not trusted
  const s2 = {};
  battler(BM, me, [11, 11]);
  readLiveParty(fr, read, T, s2);
  assert.equal(readLiveBattle(fr, read, T, s2, party).enemy.types, undefined);
});

// ---------------------------------------------------------------- caps in the run, features

test('level caps read from the ROM: the cap with n badges, the champion\'s after the last, the leader\'s name; the stream API needs badges read from the game', () => {
  const rc = { caps: [14, 21, 24, 29, 43, 43, 47, 50], leaders: ['BROCK', 'MISTY'], final: { name: 'Champion', cap: 63 } };
  assert.deepEqual(romCapFor(rc, 0), { cap: 14, boss: { key: 'gym1', badge: 0, leader: 'BROCK' } });
  assert.equal(romCapFor(rc, 7).cap, 50);
  assert.deepEqual(romCapFor(rc, 8), { cap: 63, boss: { key: 'champion', name: 'Champion' } });
  assert.equal(romCapFor({ ...rc, final: null }, 8), null);
  assert.equal(romCapFor(rc, undefined), null, 'badges unknown: no cap');
  assert.equal(romCapFor(null, 2), null);
  assert.equal(prettyTrainer('LT. SURGE'), 'Lt. Surge');
  assert.equal(prettyTrainer('Mirskle'), 'Mirskle');
  const manifest = { game: { id: 'pokemon-firered', code: 'BPRE', system: 'gba' } };
  const raw = { 'romcaps:p1': { v: rc }, 'live:p1': { v: { badges: 2, badgesRead: true } } };
  assert.deepEqual(levelCapOf(manifest, { levelCaps: 'warn' }, raw, 2, 'p1'), { cap: 24, boss: { key: 'gym3', name: 'Gym 3' } });
  assert.equal(levelCapOf(manifest, { levelCaps: 'warn' }, { 'romcaps:p1': { v: rc }, 'live:p1': { v: { badges: 0 } } }, 0, 'p1'), null, 'badges never read: no cap');
  assert.equal(levelCapOf(manifest, { levelCaps: false }, raw, 2, 'p1'), null, 'caps off in the rules');
});

test('what souldew can read: from the ROM data, then confirmed poll by poll – a held item without a name turns items off for the session', () => {
  const rom = { header: { system: 'gba', code: 'BPRE', title: 'POKEMON FIRE' }, species: { engine: 'vanilla' }, data: { gen: 3 }, types: { species: { 1: ['grass'] }, chart: {}, own: 0 }, caps: { caps: [14], badgeFlags: 0x820 }, vanilla: true };
  assert.deepEqual(romFeatures(rom, addresses), { party: 'yes', items: 'yes', moves: 'yes', location: 'yes', battle: 'yes', catch: 'yes', types: 'yes', caps: 'yes' });
  // an expanded engine without its species table: nothing ("not supported")
  assert.equal(romFeatures({ ...rom, species: { engine: 'expanded' } }, addresses).party, 'no');
  // types of its own without their chart: the types, no matchups
  assert.equal(romFeatures({ ...rom, types: { species: {}, chart: null, own: 57 } }, addresses).types, 'partial');
  // a modified ROM whose types couldn't be read
  assert.equal(romFeatures({ ...rom, types: null, vanilla: false }, addresses).types, 'no');
  // an expanded engine's caps need the badge flags its own scripts name
  assert.equal(romFeatures({ ...rom, species: { engine: 'expanded', map: [] }, items: null, caps: { caps: [14], badgeFlags: null } }, addresses).caps, 'no');
  assert.equal(romFeatures(null, addresses).party, 'no');
  const fc = new FeatureCheck(romFeatures(rom, addresses));
  assert.equal(fc.status().party, 'wait');
  const party = [{ species: 4, item: 13, moves: [10, 52] }];
  const names = { itemName: (m) => (m.item === 13 ? 'Potion' : ''), moveName: (id) => (id < 400 ? 'x' : '') };
  for (let i = 0; i < 3; i++) {
    fc.noteParty(party);
    fc.noteNames(party, names);
    fc.noteBattle({ enemy: { level: 3, hp: 5, maxHp: 11 } });
  }
  let st = fc.changed();
  assert.equal(st.changed, true);
  assert.equal(st.status.party, 'yes');
  assert.equal(st.status.items, 'yes');
  assert.equal(st.status.battle, 'yes');
  assert.equal(fc.changed().changed, false);
  fc.noteNames([{ species: 4, item: 999, moves: [10] }], names);
  st = fc.changed();
  assert.equal(st.status.items, 'no');
  assert.match(st.why.items, /without a name/);
  fc.noteBattle({ enemy: { level: 172, hp: 5, maxHp: 11 } });
  assert.equal(fc.status().battle, 'no', 'an impossible level: the battle reading is given up');
});

test('run: the caps read from the ROM are filed with the run; the cap shows with badges read from the game; the first badge count isn\'t news', async () => {
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const R = await import('../web/lib/run.mjs');
  const doc = new RunDoc('caps');
  doc.by = 'a';
  doc._persistSoon = () => {};
  const manifest = { id: 'caps', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-firered', code: 'BPRE', system: 'gba' } };
  doc.set('rules', { levelCaps: 'warn' });
  const mon = { key: 'g3-1', species: 4, level: 12, hp: 30, maxHp: 35, metLocation: 88, metLevel: 5 };
  const romCaps = { caps: [14, 21, 24, 29, 43, 43, 47, 50], leaders: ['BROCK', 'MISTY', 'LT. SURGE'], final: { name: 'Champion', cap: 63 } };
  R.applySnapshot(doc, manifest, 3, 'p1', { source: 'live', party: [mon], romCaps });
  assert.deepEqual(doc.get('romcaps:p1'), romCaps);
  assert.equal(R.levelCap(doc, manifest, 'p1').cap, null, 'no badges read from the game yet: no cap');
  // the first count after none (a save with two badges loaded): where the player stands – no "badge earned"
  R.applySnapshot(doc, manifest, 3, 'p1', { source: 'live', party: [mon], badges: 2, romCaps });
  assert.equal(R.feedList(doc).filter((f) => f.type === 'badge').length, 0);
  const cap = R.levelCap(doc, manifest, 'p1');
  assert.equal(cap.cap, 24);
  assert.equal(cap.rom, true);
  assert.match(cap.boss.name, /Lt\. Surge/);
  // a badge won now is news
  R.applySnapshot(doc, manifest, 3, 'p1', { source: 'live', party: [mon], badges: 3, romCaps });
  assert.equal(R.feedList(doc).filter((f) => f.type === 'badge').length, 1);
  assert.equal(R.levelCap(doc, manifest, 'p1').cap, 29);
  // a hack: no curated list, the caps read from its ROM still count
  const hack = { ...manifest, game: { ...manifest.game, hackId: 'some-hack' } };
  assert.equal(R.levelCap(doc, hack, 'p1').cap, 29);
  // a game without caps read (Run & Bun): nothing
  doc.set('romcaps:p1', null);
  assert.equal(R.levelCap(doc, manifest, 'p1').cap, null);
});
