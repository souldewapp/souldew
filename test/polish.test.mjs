// Edge cases of runs with 1–4 players found in a logic review: undoing a deathless death, a death in the tick the
// battle ended, the missed-encounter question, who "me" is, invite seats, run packs, file names and seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

const DATA = mkdtempSync(join(tmpdir(), 'sls-polish-'));
process.env.SLS_DATA_DIR = DATA;
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// web/lib/*.mjs import browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const { RunData } = await import('../web/lib/data.mjs');
const { suggestSlot } = await import('../web/lib/invitecode.mjs');
const { mySlotIn } = await import('../web/lib/restart.mjs');
const { defaultRunName } = await import('../shared/slots.mjs');
const { checkPack, seedsFor, outputLabels, renamePlayers } = await import('../server/lib/build.mjs');

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const SOLO = { ...HG, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } };
const PAIR = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };
const M4 = { ...HG, mode: 'soullink', players: { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Kim' }, p4: { name: 'Alex' } } };

function mkDoc(rules, by = 'a') {
  const d = new RunDoc('t');
  d.by = by;
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, ...o });
const pidgey = (o = {}) => mon({ key: 'k2', species: 16, nickname: 'PIDGE', metLocation: 177, level: 3, metLevel: 3, ...o });
const snap = (d, party, opts, m = SOLO) => R.applySnapshot(d, m, 4, 'p1', { source: 'live', party }, opts);
const later = (ms, fn) => {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
};

test('deathless: undoing the death that ended the run reopens it; another death does not', () => {
  const d = mkDoc({ deathless: true, blackout: 'off' });
  snap(d, [mon(), pidgey()]);
  snap(d, [mon(), pidgey({ hp: 0 })]);
  assert.equal(d.get('run:status').reason, 'deathless');
  assert.equal(d.get('run:status').area, 'route-29');
  R.revive(d, 'starter'); // not the death that ended it
  assert.equal(d.get('run:status').reason, 'deathless');
  R.revive(d, 'route-29');
  assert.equal(d.get('run:status', null), null, 'the death was a mistake – the run goes on');
  assert.equal(d.get('pair:route-29').state, 'alive');
  // the next real death ends it again
  R.markDead(d, SOLO, 'starter', { slot: 'p1' });
  assert.equal(d.get('run:status').reason, 'deathless');
  // a run given up by hand stays given up
  const g = mkDoc({ deathless: true });
  R.markDead(g, PAIR, 'starter', { slot: 'p1' });
  g.set('run:status', { state: 'failed', at: Date.now(), by: 'p1', note: null });
  R.revive(g, 'starter');
  assert.equal(g.get('run:status').state, 'failed');
});

test('deathless: undoing the death that ended the run while another still stands keeps it failed (#35)', () => {
  const d = mkDoc({ deathless: true, blackout: 'off', autoDeath: false });
  snap(d, [mon(), pidgey()]);
  later(-2000, () => R.markDead(d, SOLO, 'starter', { slot: 'p1' }));
  assert.equal(d.get('run:status').area, 'starter');
  R.markDead(d, SOLO, 'route-29', { slot: 'p1' }); // marked on the board after the run had ended
  assert.equal(d.get('run:status').area, 'starter', 'the first death stays the cause');
  const at = d.get('run:status').at;
  R.revive(d, 'starter');
  assert.equal(d.get('run:status').state, 'failed', 'Route 29 is still dead');
  assert.equal(d.get('run:status').area, 'route-29', 'the death still standing is the cause now');
  assert.equal(d.get('run:status').at, at);
  R.revive(d, 'route-29');
  assert.equal(d.get('run:status', null), null, 'no death left – the run goes on');
});

test('a bonus Pokémon\'s death counts: it ends a deathless run, undoing it reopens it (#37)', () => {
  const d = mkDoc({ deathless: true, blackout: 'off', autoDeath: false });
  snap(d, [mon()]);
  d.set('extra:p1:gift', { species: 133, at: 1, reason: 'gift' });
  assert.equal(R.markExtraDead(d, SOLO, 'p1', 'nope'), false, 'no such bonus Pokémon');
  assert.equal(R.markExtraDead(d, SOLO, 'p1', 'gift'), true);
  assert.equal(R.markExtraDead(d, SOLO, 'p1', 'gift'), false, 'already dead');
  assert.equal(d.get('extra:p1:gift').dead, true);
  assert.ok(d.get('extra:p1:gift').diedAt);
  assert.deepEqual([d.get('run:status').reason, d.get('run:status').extra, d.get('run:status').area], ['deathless', 'p1:gift', undefined]);
  // an area death on top, then the bonus death undone: the area death is the cause now
  R.markDead(d, SOLO, 'starter', { slot: 'p1' });
  R.markExtraDead(d, SOLO, 'p1', 'gift', false);
  assert.deepEqual([d.get('extra:p1:gift').dead, d.get('extra:p1:gift').diedAt], [false, null]);
  assert.deepEqual([d.get('run:status').state, d.get('run:status').area, d.get('run:status').extra], ['failed', 'starter', undefined]);
  R.revive(d, 'starter');
  assert.equal(d.get('run:status', null), null);
  // the other way round: an area death undone while a bonus Pokémon is still dead
  R.markDead(d, SOLO, 'starter', { slot: 'p1' });
  R.markExtraDead(d, SOLO, 'p1', 'gift');
  R.revive(d, 'starter');
  assert.equal(d.get('run:status').extra, 'p1:gift');
  R.markExtraDead(d, SOLO, 'p1', 'gift', false);
  assert.equal(d.get('run:status', null), null);
  // without the rule (or in a SoulLink) a bonus death ends nothing
  const n = mkDoc({ blackout: 'off' });
  n.set('extra:p1:gift', { species: 133, at: 1 });
  R.markExtraDead(n, SOLO, 'p1', 'gift');
  assert.equal(n.get('run:status', null), null);
  // "box" blackout: undoing the bonus death that left nothing alive reopens the run, like an area death
  const b = mkDoc({ blackout: 'box', autoDeath: false });
  snap(b, [mon()]);
  b.set('extra:p1:gift', { species: 133, at: 1 });
  R.markDead(b, SOLO, 'starter', { slot: 'p1' });
  R.markExtraDead(b, SOLO, 'p1', 'gift');
  assert.equal(snap(b, [mon({ hp: 0 })]).failed, 'blackout');
  R.markExtraDead(b, SOLO, 'p1', 'gift', false);
  assert.equal(b.get('run:status', null), null);
});

test('blackout "box": undoing a death after nothing was left alive reopens the run', () => {
  const d = mkDoc({ blackout: 'box' });
  snap(d, [mon(), pidgey()]);
  snap(d, [mon({ hp: 0 }), pidgey({ hp: 0 })]);
  assert.equal(d.get('run:status').reason, 'blackout');
  R.revive(d, 'route-29');
  assert.equal(d.get('run:status', null), null);
  assert.equal(R.blackout(d, SOLO), false, 'something is alive again');
  // "party" blackouts don't depend on deaths: undoing one changes nothing
  const p = mkDoc({ blackout: 'party' });
  snap(p, [mon(), pidgey()]);
  snap(p, [mon({ hp: 0 }), pidgey({ hp: 0 })]);
  assert.equal(p.get('run:status').reason, 'blackout');
  R.revive(p, 'route-29');
  assert.equal(p.get('run:status').reason, 'blackout');
});

test('failRun twice, egg-only and save-file parties: no second status, no blackout', () => {
  const d = mkDoc();
  assert.equal(R.failRun(d, SOLO, 'p1', 'blackout'), true);
  const st = d.get('run:status');
  assert.equal(R.failRun(d, SOLO, 'p1', 'deathless'), false);
  assert.deepEqual(d.get('run:status'), st);
  const e = mkDoc();
  snap(e, [mon({ key: 'egg', species: 175, isEgg: true, hp: 0, maxHp: 0 })]);
  assert.equal(R.blackout(e, SOLO), false, 'an egg alone is no team');
  const s = mkDoc();
  snap(s, [mon(), pidgey()]);
  R.applySnapshot(s, SOLO, 4, 'p1', { source: 'save', party: [mon({ hp: 0 }), pidgey({ hp: 0 })], boxes: [] });
  assert.equal(R.blackout(s, SOLO), false, 'a save file is no live read');
  // "continue anyway" with the party still down: no instant second failure
  const c = mkDoc({ autoDeath: false });
  snap(c, [mon(), pidgey()]);
  assert.equal(snap(c, [mon({ hp: 0 }), pidgey({ hp: 0 })]).failed, 'blackout');
  R.resumeRun(c, 'p1');
  assert.equal(later(60000, () => snap(c, [mon({ hp: 0 }), pidgey({ hp: 0 })]).failed), null);
  assert.equal(c.get('run:status', null), null);
});

test('a Pokémon that falls in the tick its battle ended still gets the opponent as its cause', () => {
  const d = mkDoc({ blackout: 'off' });
  const battle = { kind: 'wild', enemy: { species: 95, level: 14 } };
  snap(d, [mon(), pidgey()]);
  snap(d, [mon(), pidgey()], { battle });
  snap(d, [mon(), pidgey({ hp: 0 })], { battle: null }); // the last blow ended the battle before this read
  assert.deepEqual(d.get('pair:route-29').killer, { species: 95, level: 14, kind: 'wild' });
  // long after the battle: no opponent
  later(30000, () => snap(d, [mon({ hp: 0 }), pidgey({ hp: 0 })], { battle: null }));
  assert.equal(d.get('pair:starter').killer, null);
  // a save file never borrows a battle
  const s = mkDoc({ blackout: 'off' });
  snap(s, [mon(), pidgey()], { battle });
  R.applySnapshot(s, SOLO, 4, 'p1', { source: 'save', party: [mon(), pidgey({ hp: 0 })], boxes: [] });
  assert.equal(s.get('pair:route-29', null), null);
});

test('missed encounter question: only after a wild battle without a catch that the app could have seen', () => {
  const d = mkDoc();
  snap(d, [mon()]);
  const foe = { species: 16, level: 3 };
  const base = { foe, wild: true, from: 1000, newMonAt: 0, boxes: true, partySize: 1 };
  const ask = (o, m = SOLO, doc = d) => R.missedQuestion(doc, m, null, 'p1', { ...base, ...o });
  assert.equal(ask({}), true);
  assert.equal(ask({ newMonAt: 2000 }), false, 'a new Pokémon turned up after the battle began');
  assert.equal(ask({ wild: false }), false, 'a trainer battle (or one that looked like one at any point)');
  assert.equal(ask({ foe: null }), false);
  assert.equal(ask({ boxes: false, partySize: 6 }), false, 'full party and the PC is not read live: a catch would be invisible');
  assert.equal(ask({ boxes: false, partySize: 5 }), true, 'room in the party: a catch shows up there');
  assert.equal(ask({ foe: { ...foe, shiny: true } }), false, 'shiny clause');
  assert.equal(ask({}), true, 'solo: asked without a place sign too (it offers the open areas)');
  assert.equal(ask({}, PAIR), false, 'a SoulLink asks only where the place is known (a "yes" fails the pair)');
  assert.equal(ask({ here: { gen: 4, id: 178, name: 'Route 30' } }, PAIR), true, 'a SoulLink asks each player too (2.8.0)');
  // where the place sign says the battle was: asked only while that area is still open for the player
  const route29 = { gen: 4, id: 177, name: 'Route 29' };
  assert.equal(ask({ here: route29 }), true);
  snap(d, [mon(), pidgey()]);
  assert.equal(ask({ here: route29 }), false, 'the encounter of Route 29 is entered already');
  assert.equal(ask({ here: { gen: 4, id: 178, name: 'Route 30' } }), true);
  const dupe = mkDoc({ dupes: 'species' });
  snap(dupe, [mon(), pidgey()]);
  assert.equal(ask({}, SOLO, dupe), false, 'a dupe doesn’t count anyway');
  d.set('run:status', { state: 'failed', at: Date.now() });
  assert.equal(ask({}), false, 'the run is over');
});

test('my slot: a stored choice outside the run (fewer players now, a solo run) falls back', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    store.set('sl-me-run1', JSON.stringify('p3'));
    assert.equal(mySlotIn(M4), 'p3');
    assert.equal(mySlotIn(PAIR), 'p1', 'p3 is not a player of this run');
    assert.equal(mySlotIn({ ...PAIR, imported: true }), 'p2');
    assert.equal(mySlotIn({ ...SOLO, imported: true }), 'p1', 'a Nuzlocke has p1 only');
    store.set('sl-me-run1', 'garbage');
    assert.equal(mySlotIn(M4), 'p1');
  } finally {
    delete globalThis.localStorage;
  }
});

test('invite seat: somebody re-joining under their name gets their own seat back, even when it is taken', () => {
  const players = M4.players;
  assert.equal(suggestSlot(players, ['p1', 'p3'], 'kim'), 'p3', 're-joining (another computer, a code that failed halfway)');
  assert.equal(suggestSlot(players, ['p1'], 'Kim'), 'p3');
  assert.equal(suggestSlot(players, ['p1'], 'Mika'), 'p2', 'a new name: the first free seat');
  assert.equal(suggestSlot({ p1: { name: 'Sam' }, p2: { name: 'Sam' } }, ['p1'], 'Sam'), 'p2', 'a free seat with the name wins');
  assert.equal(suggestSlot(players, ['p1', 'p2', 'p3', 'p4'], 'Nobody'), null);
});

test('run packs: players must be contiguous; old packs and a missing p2 still import', () => {
  const pack = { room: 'glurak-evoli-1234', secret: 'secret-secret', players: { p1: { name: 'A' }, p3: { name: 'C' } } };
  assert.throws(() => checkPack(pack), /players/);
  assert.throws(() => checkPack({ ...pack, players: { p2: { name: 'B' } } }), /players/);
  assert.deepEqual(Object.keys(checkPack({ ...pack, players: { p1: { name: 'A' } } }).players), ['p1']);
  assert.deepEqual(Object.keys(checkPack({ ...pack, players: { p1: {}, p2: {}, p3: {}, p4: {}, p5: {} } }).players), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(checkPack({ ...pack, players: { p1: {}, p2: { name: '' } } }).players.p2.name, 'Player 2');
  assert.deepEqual(checkPack({ ...pack, mode: 'nuzlocke', players: { p1: { name: 'A' }, p3: { name: 'C' } } }).players, { p1: { name: 'A' } }, 'solo: only p1 counts');
});

test('ROM file names: players whose names differ only in case or form never share a file', () => {
  const l = outputLabels({ p1: { name: 'Lou' }, p2: { name: 'lou' }, p3: { name: 'Kim' } });
  assert.equal(l.p3, 'Kim');
  assert.notEqual(l.p1.toLowerCase(), l.p2.toLowerCase());
  const nfd = outputLabels({ p1: { name: 'Zoë' }, p2: { name: 'Zoë' } }); // same name on an APFS disk
  assert.notEqual(nfd.p1.normalize('NFC').toLowerCase(), nfd.p2.normalize('NFC').toLowerCase());
  const tricky = outputLabels({ p1: { name: 'Sam' }, p2: { name: 'Sam' }, p3: { name: 'Sam (P2)' } });
  assert.equal(new Set(Object.values(tricky).map((x) => x.toLowerCase())).size, 3);
  assert.deepEqual(outputLabels({ p1: { name: 'Sam' }, p2: { name: 'Sam' } }), { p1: 'Sam (P1)', p2: 'Sam (P2)' }, 'as before');
});

test('seeds: a shared seed gives every player the same one; renaming keeps the run’s players', () => {
  assert.deepEqual(seedsFor(['p1', 'p2', 'p3'], { p1: '7', p2: '8', p3: '9' }, true), { p1: '7', p2: '7', p3: '7' });
  assert.deepEqual(seedsFor(['p1', 'p2'], { p1: '7', p2: '8' }, false), { p1: '7', p2: '8' });
  const m = { players: { p1: { name: 'A' }, p2: { name: 'B' }, p3: { name: 'C' } }, mode: 'soullink' };
  assert.deepEqual(renamePlayers(m, { p2: { name: 'Bea/' }, p3: 5, p5: { name: 'X' } }), { p1: { name: 'A' }, p2: { name: 'Bea' }, p3: { name: 'C' } });
  assert.deepEqual(renamePlayers({ players: { p1: { name: 'A' }, p2: { name: 'B' } } }, { p1: { name: 'Ann' } }), { p1: { name: 'Ann' }, p2: { name: 'B' } }, 'an old run');
  assert.deepEqual(renamePlayers({ mode: 'nuzlocke', players: { p1: { name: 'A' } } }, { p2: { name: 'B' } }), { p1: { name: 'A' } });
});

test('run names go by slot order; a player without a name is not "undefined"', () => {
  assert.equal(defaultRunName({ p2: { name: 'Robin' }, p1: { name: 'Lou' } }), 'Lou & Robin');
  assert.equal(defaultRunName({ p1: { name: 'A' }, p2: { name: 'B' }, p3: { name: 'C' }, p4: { name: 'D' } }), 'A, B, C & D');
  assert.equal(defaultRunName({ p1: {} }, 'nuzlocke'), 'P1 – Nuzlocke');
});

test('run data: a player on p3/p4 has only their own ROM data – lookups for the others use it, not vanilla', () => {
  const rd = new RunData();
  rd.byId.p3 = new Map([[16, { id: 16, types: ['FIRE', null] }], [17, { id: 17, types: ['FIRE'], evolvesFrom: [16] }]]);
  assert.deepEqual(rd.types(16, 'p1'), ['fire']);
  assert.equal(rd.familyRoot(17, 'p2'), 16);
});

test('4 peers: the doc converges whatever order the edits arrive in (last writer wins per key)', () => {
  const peers = ['a', 'b', 'c', 'd'].map((by) => mkDoc(null, by));
  peers.forEach((p, i) => {
    p.clock = 1000; // same clock: the device id breaks the tie
    p.set('rules', { n: i });
    p.set(`live:p${i + 1}`, { at: i });
  });
  const all = peers.map((p) => ({ ...p.entries }));
  const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1]];
  const results = orders.map((o) => {
    const x = mkDoc(null, 'z');
    for (const i of o) x.merge(all[i]);
    for (const i of o) x.merge(all[i]); // duplicates are harmless
    return JSON.stringify(Object.keys(x.entries).sort().map((k) => [k, x.entries[k]]));
  });
  assert.equal(new Set(results).size, 1);
  const x = mkDoc(null, 'z');
  for (const e of all) x.merge(e);
  assert.deepEqual(x.get('rules'), { n: 3 }, 'equal time: the larger device id wins');
  for (let i = 1; i <= 4; i++) assert.deepEqual(x.get(`live:p${i}`), { at: i - 1 });
});

// Alpha Sapphire, SoulLink (3DS): the "not caught" question came up while the catch's nickname screen was still open, the
// area was marked missed – and the Pokémon then reached the team. The catch wins; it used to land in the inbox ("occupied")
// while the area and the whole group stayed "missed".
test('a catch that reaches the team after its area was marked missed replaces the miss (3DS)', () => {
  const ORAS = { id: 'run3ds', mode: 'soullink', game: { code: 'ECLA', system: '3ds' }, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };
  const d = mkDoc();
  const starter = { key: 'aaaa-1-1', species: 246, nickname: 'Larvitar', level: 5, hp: 20, maxHp: 20, metLocation: 204, metLevel: 5 };
  const rattata = { key: 'bbbb-1-1', species: 19, nickname: 'Rattata', level: 2, hp: 12, maxHp: 12, metLocation: 204, metLevel: 2 };
  const apply = (party) => R.applySnapshot(d, ORAS, 6, 'p1', { source: 'live', party });
  apply([starter]);
  apply([starter]);
  R.markMissed(d, ORAS, 'm6-204', 'p1', { species: 19, by: 'p1' });
  assert.equal(R.encounter(d, 'm6-204', 'p1').outcome, 'missed');
  const res = apply([starter, rattata]);
  assert.equal(R.encounter(d, 'm6-204', 'p1').outcome, 'caught');
  assert.equal(R.encounter(d, 'm6-204', 'p1').species, 19);
  assert.equal(res.inbox.length, 0, 'the catch is not left in the inbox');
  assert.notEqual(R.pairState(d, 'm6-204').state, 'failed');
  // a miss of another Pokémon (or a long time ago) stays
  const e = mkDoc();
  R.applySnapshot(e, ORAS, 6, 'p1', { source: 'live', party: [starter] });
  R.markMissed(e, ORAS, 'm6-204', 'p1', { species: 16, by: 'p1' });
  const res2 = R.applySnapshot(e, ORAS, 6, 'p1', { source: 'live', party: [starter, rattata] });
  assert.equal(R.encounter(e, 'm6-204', 'p1').outcome, 'missed', 'another species: not this miss');
  assert.equal(res2.inbox.length, 1);
  const f = mkDoc();
  R.applySnapshot(f, ORAS, 6, 'p1', { source: 'live', party: [starter] });
  R.markMissed(f, ORAS, 'm6-204', 'p1', { species: 19, by: 'p1' });
  later(10 * 60 * 1000, () => R.applySnapshot(f, ORAS, 6, 'p1', { source: 'live', party: [starter, rattata] }));
  assert.equal(R.encounter(f, 'm6-204', 'p1').outcome, 'missed', 'ten minutes later it is no late catch');
});

test('missed encounter question: a party that grew since the battle began was a catch', () => {
  const d = mkDoc();
  snap(d, [mon()]);
  const base = { foe: { species: 16, level: 3 }, wild: true, from: 1000, newMonAt: 0, boxes: false, partySize: 2, partyAtStart: 1 };
  assert.equal(R.missedQuestion(d, SOLO, null, 'p1', base), false, 'the team has one more Pokémon than at the start');
  assert.equal(R.missedQuestion(d, SOLO, null, 'p1', { ...base, partyAtStart: 2 }), true, 'same size: nothing was caught');
  assert.equal(R.missedQuestion(d, SOLO, null, 'p1', { ...base, partyAtStart: null }), true, 'size at the start unknown: the old rules');
});
