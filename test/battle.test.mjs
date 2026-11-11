// Battle helper: type chart, per-generation move data, and reading the opponent / live HP from RAM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveness, defenseChart, moveInfo, single, matchup } from '../shared/typechart.mjs';
import { readLiveBattle, withBattleHp, LiveTables } from '../shared/live/parse.mjs';
import { vanillaCapFor, gymCapsFamily } from '../shared/routes.mjs';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const MOVES = json('../shared/data/moves.json');
const ADDR = json('../shared/data/addresses.json');
const entry = (id) => ADDR.games.find((g) => g.id === id);

test('type chart: dual types multiply, immunities win, Gen 1 quirks', () => {
  assert.equal(effectiveness('fire', ['grass', 'steel']), 4);
  assert.equal(effectiveness('water', ['water', 'dragon']), 0.25);
  assert.equal(effectiveness('electric', ['water', 'ground']), 0);
  assert.equal(effectiveness('ghost', ['psychic'], 1), 0); // the Gen 1 bug
  assert.equal(effectiveness('ghost', ['psychic'], 2), 2);
  assert.equal(single('bug', 'poison', 1), 2);
  assert.equal(single('bug', 'poison', 3), 0.5);
  assert.equal(single('ice', 'fire', 1), 1);
  assert.equal(single('dark', 'steel', 4), 0.5); // Steel still resists Dark before Gen 6
  // Gen 6 on (the 3DS games): Steel takes Ghost and Dark normally, and every chart has Fairy
  assert.equal(single('dark', 'steel', 6), 1);
  assert.equal(single('ghost', 'steel', 7), 1);
  assert.equal(effectiveness('dragon', ['fairy'], 6), 0);
  assert.ok(defenseChart(['dragon'], 6)[2].includes('fairy'));
  assert.ok(!defenseChart(['dragon'], 5)[2].includes('fairy'), 'Gen 5: no Fairy (unless a hack has it)');
  const c = defenseChart(['water', 'flying']);
  assert.deepEqual(c[4], ['electric']);
  assert.ok(c[0].includes('ground'));
  assert.ok(c[0.5].includes('fire') && c[0.5].includes('bug'));
});

test('move data follows the generation', () => {
  assert.equal(moveInfo(MOVES, 44, 1).type, 'normal'); // Bite
  assert.equal(moveInfo(MOVES, 44, 2).type, 'dark');
  assert.equal(moveInfo(MOVES, 33, 4).power, 35); // Tackle
  assert.equal(moveInfo(MOVES, 33, 5).power, 50);
  assert.equal(moveInfo(MOVES, 85, 3).cls, 'special'); // Thunderbolt: by type before Gen 4
  assert.equal(moveInfo(MOVES, 7, 3).cls, 'special'); // Fire Punch is special in Gen 3 …
  assert.equal(moveInfo(MOVES, 7, 4).cls, 'physical'); // … and physical from Gen 4
  assert.equal(moveInfo(MOVES, 174, 2).type, null); // Curse: ??? type
});

test('switch-in check: best hit and worst incoming per team member, by moves or by types', () => {
  const mv = (...ids) => ids.map((id) => ({ id, ...moveInfo(MOVES, id, 5) }));
  // Tepig (Ember, Tackle, Tail Whip) against a wild Pidove (Normal/Flying) that knows Gust and Quick Attack
  const pidove = { types: ['normal', 'flying'], moves: mv(16, 98) };
  const tepig = matchup({ types: ['fire'], moves: mv(52, 33, 39) }, pidove, 5);
  assert.deepEqual(tepig, { deals: 1, dealsBy: 52, takes: 1, takesBy: 16 });
  // Snivy (Vine Whip): Grass on Normal/Flying ×½, Tackle ×1 is its best; Gust hits it ×2
  const snivy = matchup({ types: ['grass'], moves: mv(22, 33) }, pidove, 5);
  assert.deepEqual(snivy, { deals: 1, dealsBy: 33, takes: 2, takesBy: 16 });
  // status moves never count as a hit; with only status moves there is nothing to deal
  assert.equal(matchup({ types: ['grass'], moves: mv(45, 39) }, pidove, 5).deals, null, 'Growl and Tail Whip');
  // moves unknown on either side: the types stand in (what their STAB would do)
  const geodude = { types: ['rock', 'ground'], moves: [] };
  const oshawott = matchup({ types: ['water'], moves: [] }, geodude, 5);
  assert.deepEqual(oshawott, { deals: 4, dealsBy: 'water', takes: 1, takesBy: 'rock' });
  const pikachu = matchup({ types: ['electric'], moves: [] }, geodude, 5);
  assert.deepEqual(pikachu, { deals: 0, dealsBy: 'electric', takes: 2, takesBy: 'ground' });
  // no types known for the opponent (data still loading): nothing to show
  assert.deepEqual(matchup({ types: ['water'], moves: [] }, { types: [], moves: [] }, 5), { deals: null, dealsBy: null, takes: null, takesBy: null });
});

/** A bus reader over a sparse byte map. */
function ram(bytes) {
  return (addr, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bytes[addr + i] ?? 0;
    return out;
  };
}
const put16be = (m, a, v) => { m[a] = v >> 8; m[a + 1] = v & 0xff; };

test('Gen 2: wild opponent, live HP of the active mon and the shiny DVs', () => {
  const e = entry('silver_us');
  const m = {};
  m[0xd116] = 1; // wBattleMode: wild
  m[0xd0ef] = 172; // Pichu
  m[0xd0fc] = 4;
  put16be(m, 0xd0ff, 9);
  put16be(m, 0xd101, 16);
  put16be(m, 0xd0f5, 0xaaaa); // shiny DVs (atk 10, def/spe/spc 10)
  m[0xcfc6] = 0; // wCurBattleMon
  put16be(m, 0xcb1c, 3);
  put16be(m, 0xcb1e, 20);
  const b = readLiveBattle(e, ram(m), new LiveTables({}));
  assert.equal(b.kind, 'wild');
  assert.deepEqual(b.enemy, { species: 172, level: 4, hp: 9, maxHp: 16, shiny: true });
  assert.deepEqual(b.active, { index: 0, hp: 3, maxHp: 20, status: 0 });
  // outside battle → null
  m[0xd116] = 0;
  assert.equal(readLiveBattle(e, ram(m), new LiveTables({})), null);
});

test('Gen 2: an opponent that is being reloaded for a poll stays on the panel; the battle end clears it', () => {
  const e = entry('silver_us');
  const T = new LiveTables({});
  const state = {};
  const m = {};
  m[0xd116] = 2; // trainer battle
  m[0xd0ef] = 16;
  m[0xd0fc] = 5;
  put16be(m, 0xd0ff, 18);
  put16be(m, 0xd101, 18);
  assert.equal(readLiveBattle(e, ram(m), T, state).enemy.species, 16);
  put16be(m, 0xd101, 0); // the next Pokémon is half loaded
  const mid = readLiveBattle(e, ram(m), T, state);
  assert.equal(mid.kind, 'trainer', 'still a battle, not "battle over"');
  assert.equal(mid.enemy.species, 16);
  m[0xd0ef] = 19;
  put16be(m, 0xd101, 20);
  put16be(m, 0xd0ff, 20);
  assert.equal(readLiveBattle(e, ram(m), T, state).enemy.species, 19);
  m[0xd116] = 0;
  assert.equal(readLiveBattle(e, ram(m), T, state), null);
  m[0xd116] = 1;
  put16be(m, 0xd101, 0); // next battle, nothing loaded yet: no leftover from the last one
  assert.equal(readLiveBattle(e, ram(m), T, state).enemy, null);
});

test('battle HP is folded into the party only for the matching mon', () => {
  const party = [{ key: 'a', species: 152, hp: 20, maxHp: 20 }, { key: 'b', species: 16, hp: 15, maxHp: 15 }];
  assert.equal(withBattleHp(party, { active: { index: 0, hp: 0, maxHp: 20 } })[0].hp, 0);
  assert.equal(withBattleHp(party, { active: { index: 0, hp: 0, maxHp: 99 } })[0].hp, 20); // other struct → ignore
  const ds = [{ pid: 1, hp: 30, maxHp: 30 }, { pid: 2, hp: 10, maxHp: 10 }];
  assert.deepEqual(withBattleHp(ds, { party: [{ pid: 2, hp: 0, maxHp: 10 }] }).map((m) => m.hp), [30, 0]);
  assert.equal(withBattleHp(party, null), party);
});

test('vanilla level caps for Gen 1/2 by badge count', () => {
  assert.equal(gymCapsFamily('pokemon-silver-de'), 'gs');
  assert.equal(gymCapsFamily('pokemon-emerald'), null);
  assert.equal(vanillaCapFor('rb', 0).cap, 14);
  assert.equal(vanillaCapFor('gs', 8).boss.name, 'Lance');
  assert.equal(vanillaCapFor('gs', 9).boss.name, 'Blue'); // Kanto badges come after the Elite Four
  assert.equal(vanillaCapFor('crystal', 16).cap, 81);
  assert.equal(vanillaCapFor('gs', undefined), null);
});

test('full Gen 2–5 chart: every non-neutral matchup, row by row', () => {
  // attacker: [super effective], [not very effective], [no effect] – the official Gen 2–5 table
  const T = {
    normal: [[], ['rock', 'steel'], ['ghost']],
    fighting: [['normal', 'rock', 'steel', 'ice', 'dark'], ['flying', 'poison', 'bug', 'psychic'], ['ghost']],
    flying: [['fighting', 'bug', 'grass'], ['rock', 'steel', 'electric'], []],
    poison: [['grass'], ['poison', 'ground', 'rock', 'ghost'], ['steel']],
    ground: [['poison', 'rock', 'steel', 'fire', 'electric'], ['bug', 'grass'], ['flying']],
    rock: [['flying', 'bug', 'fire', 'ice'], ['fighting', 'ground', 'steel'], []],
    bug: [['grass', 'psychic', 'dark'], ['fighting', 'flying', 'poison', 'ghost', 'steel', 'fire'], []],
    ghost: [['ghost', 'psychic'], ['steel', 'dark'], ['normal']],
    steel: [['rock', 'ice'], ['steel', 'fire', 'water', 'electric'], []],
    fire: [['bug', 'steel', 'grass', 'ice'], ['rock', 'fire', 'water', 'dragon'], []],
    water: [['ground', 'rock', 'fire'], ['water', 'grass', 'dragon'], []],
    grass: [['ground', 'rock', 'water'], ['flying', 'poison', 'bug', 'steel', 'fire', 'grass', 'dragon'], []],
    electric: [['flying', 'water'], ['grass', 'electric', 'dragon'], ['ground']],
    psychic: [['fighting', 'poison'], ['steel', 'psychic'], ['dark']],
    ice: [['flying', 'ground', 'grass', 'dragon'], ['steel', 'fire', 'water', 'ice'], []],
    dragon: [['dragon'], ['steel'], []],
    dark: [['ghost', 'psychic'], ['fighting', 'steel', 'dark'], []],
  };
  const all = Object.keys(T);
  for (const atk of all) {
    const [se, nve, none] = T[atk];
    for (const def of all) {
      const want = se.includes(def) ? 2 : nve.includes(def) ? 0.5 : none.includes(def) ? 0 : 1;
      assert.equal(single(atk, def, 3), want, `${atk} → ${def}`);
    }
  }
});

test('Gen 3: a torn read retries, a Bad Egg that stays broken is skipped instead of stopping tracking', async () => {
  const { readLiveParty } = await import('../shared/live/parse.mjs');
  const e = entry('emerald_us');
  const m = {};
  const count = Number(e.partyCountAddr);
  const party = Number(e.partyAddr);
  m[count] = 1;
  for (let i = 0; i < 100; i++) m[party + i] = (i * 37 + 11) & 0xff; // PID/OT set, checksum wrong
  const state = {};
  const T = new LiveTables({});
  assert.deepEqual(readLiveParty(e, ram(m), T, state), { torn: true });
  assert.deepEqual(readLiveParty(e, ram(m), T, state), { torn: true });
  assert.deepEqual(readLiveParty(e, ram(m), T, state), { party: [] }); // third identical failure → Bad Egg, skipped
});

test('Gen 2: after a switch the active mon follows wCurBattleMon; while wBattleMon is still loading it stays on the mon that is out', () => {
  const e = entry('silver_us');
  const T = new LiveTables({});
  const party = [{ key: 'a', species: 152, level: 7, hp: 20, maxHp: 22 }, { key: 'b', species: 16, level: 9, hp: 25, maxHp: 25 }];
  const m = {};
  const state = {};
  const battleMon = (p, hp) => { m[0xcb0c] = p.species; m[0xcb19] = p.level; put16be(m, 0xcb1c, hp); put16be(m, 0xcb1e, p.maxHp); };
  m[0xd116] = 0;
  readLiveBattle(e, ram(m), T, state, party); // overworld
  m[0xd116] = 2;
  m[0xd0ef] = 19; m[0xd0fc] = 5; put16be(m, 0xd0ff, 15); put16be(m, 0xd101, 15);
  m[0xcfc6] = 0; battleMon(party[0], 18);
  assert.deepEqual(readLiveBattle(e, ram(m), T, state, party).active, { index: 0, hp: 18, maxHp: 22, status: 0 });
  // switch: the index is set, wBattleMon still holds Chikorita → still Chikorita (no HP fold onto Pidgey)
  m[0xcfc6] = 1;
  const mid = readLiveBattle(e, ram(m), T, state, party).active;
  assert.equal(mid.index, 0);
  assert.deepEqual(withBattleHp(party, { active: mid }).map((x) => x.hp), [18, 25]);
  // Pidgey loaded
  battleMon(party[1], 25);
  assert.deepEqual(readLiveBattle(e, ram(m), T, state, party).active, { index: 1, hp: 25, maxHp: 25, status: 0 });
  // a battle mon matching nobody (Transform aside, a struct being written) keeps the last one, without HP
  m[0xcb19] = 50;
  const odd = readLiveBattle(e, ram(m), T, state, party).active;
  assert.equal(odd.index, 1);
  assert.equal(odd.hp, undefined);
});

test('Gen 3: the active mon is gBattlerPartyIndexes[0] and follows a switch', () => {
  const e = entry('emerald_us');
  const T = new LiveTables({});
  const m = {};
  m[Number(e.inBattle.addr)] = 0x02;
  const idx = Number(e.liveBattleHp.battlerPartyIndexesAddr);
  m[idx] = 0; m[idx + 2] = 0;
  assert.equal(readLiveBattle(e, ram(m), T, {}).active.index, 0);
  m[idx] = 3;
  assert.equal(readLiveBattle(e, ram(m), T, {}).active.index, 3);
});
