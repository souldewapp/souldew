// SoulLink groups of 1–4 players: link/fail/death rules for 3 and 4 players, wipes, and the solo Nuzlocke mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const run = (n, extra = {}) => ({ ...HG, mode: 'soullink', players: Object.fromEntries(['Lou', 'Robin', 'Kim', 'Alex'].slice(0, n).map((name, i) => [`p${i + 1}`, { name }])), ...extra });
const M3 = run(3);
const M4 = run(4);
const SOLO = { ...HG, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } };

function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, ...o });
const caught = (species = 16) => ({ outcome: 'caught', species });
const feedTexts = (d) => R.feedList(d).map((f) => f.text);

test('slots and mode come from the manifest; older runs are a p1+p2 SoulLink', () => {
  assert.deepEqual(R.ALL_SLOTS, ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(R.slotsOf(HG), ['p1', 'p2']);
  assert.deepEqual(R.slotsOf({ players: { p1: {}, p2: {} } }), ['p1', 'p2']);
  assert.deepEqual(R.slotsOf(M3), ['p1', 'p2', 'p3']);
  assert.deepEqual(R.slotsOf(M4), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(R.slotsOf(SOLO), ['p1']);
  assert.equal(R.runMode(HG), 'soullink');
  assert.equal(R.runMode(SOLO), 'nuzlocke');
  assert.deepEqual(R.othersOf('p2', M4), ['p1', 'p3', 'p4']);
  assert.deepEqual(R.othersOf('p1', SOLO), []);
  assert.deepEqual(Object.keys(R.players(mkDoc(), M3)), ['p1', 'p2', 'p3']);
  assert.equal(R.players(mkDoc(), M4).p4.name, 'Alex');
});

test('3 players: the group links only once everyone caught; one miss fails it', () => {
  const d = mkDoc();
  const slots = R.slotsOf(M3);
  d.set('enc:route-29:p1', caught());
  d.set('enc:route-29:p2', caught(19));
  assert.equal(R.pairState(d, 'route-29', slots).state, 'waiting');
  assert.equal(R.pairState(d, 'route-29').state, 'linked', 'without slots it is the old p1+p2 pair');
  d.set('enc:route-29:p3', caught(21));
  const st = R.pairState(d, 'route-29', M3); // the manifest works as well
  assert.equal(st.state, 'linked');
  assert.deepEqual(Object.keys(st.encs), ['p1', 'p2', 'p3']);
  assert.equal(st.encs.p3.species, 21);
  assert.equal(st.a.species, 16, 'legacy alias a = p1');
  assert.equal(st.b.species, 19, 'legacy alias b = p2');

  d.set('enc:route-30:p1', caught());
  d.set('enc:route-30:p3', { outcome: 'missed' });
  assert.equal(R.pairState(d, 'route-30', slots).state, 'failed');
  assert.equal(R.pairState(d, 'route-31', slots).state, 'empty');
  const c = R.counts(d, M3);
  assert.equal(c.linked, 1);
  assert.equal(c.failed, 1);
});

test('4 players: one fainted Pokémon kills the whole group', () => {
  const d = mkDoc();
  for (const s of ['p1', 'p2', 'p3', 'p4']) R.applySnapshot(d, M4, 4, s, { source: 'live', party: [mon({ key: `k${s}` })] });
  assert.equal(R.pairState(d, 'starter', M4).state, 'linked');
  const res = R.applySnapshot(d, M4, 4, 'p3', { source: 'live', party: [mon({ key: 'kp3', hp: 0 })] });
  assert.deepEqual(res.deaths, ['starter']);
  assert.equal(R.pairState(d, 'starter', M4).state, 'dead');
  assert.equal(d.get('pair:starter').by, 'p3');
  assert.ok(feedTexts(d).some((x) => x.includes('the linked group died')));
  // the dead group is still in all four teams → one error for the area that names everyone
  const errors = R.checks(d, M4, null).filter((x) => x.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].area, 'starter');
  assert.equal(R.counts(d, M4).dead, 1);
});

test('a missed encounter carried by several players: one error for the area that names them', () => {
  const d = mkDoc();
  d.set('enc:route-29:p1', { outcome: 'missed' });
  for (const s of ['p2', 'p3', 'p4']) { d.set(`enc:route-29:${s}`, { outcome: 'caught', species: 16 }); d.set(`party:${s}`, ['route-29']); }
  const errors = R.checks(d, M4, null).filter((x) => x.level === 'error' && x.area === 'route-29');
  assert.equal(errors.length, 1);
  for (const s of ['p2', 'p3', 'p4']) assert.ok(errors[0].text.includes(M4.players[s].name), s);
});

test('N players: any one team wiped fails the run', () => {
  const d = mkDoc();
  const team = (s, o = {}) => [mon({ key: `k${s}`, ...o }), mon({ key: `w${s}`, species: 16, metLocation: 177, ...o })];
  // p1–p3 also caught something on Route 30 (p4 did not, so that group only waits)
  for (const s of ['p1', 'p2', 'p3']) R.applySnapshot(d, M4, 4, s, { source: 'live', party: [...team(s), mon({ key: `x${s}`, species: 19, metLocation: 178 })] });
  R.applySnapshot(d, M4, 4, 'p4', { source: 'live', party: team('p4') });
  assert.equal(R.wipedSlot(d, M4), null);
  // p4's whole team faints: the starter and Route 29 groups die with it
  R.applySnapshot(d, M4, 4, 'p4', { source: 'live', party: team('p4', { hp: 0 }) });
  assert.equal(R.pairState(d, 'route-29', M4).state, 'dead');
  assert.equal(R.pairState(d, 'route-30', M4).state, 'waiting');
  assert.equal(R.wipedSlot(d, M4), 'p4');
  assert.equal(R.wipedSlot(d), 'p4', 'by default every slot is looked at');
  assert.equal(R.wipedSlot(d, ['p1', 'p2', 'p3']), null, 'the others still have their Route 30 catch');
  assert.equal(R.failRun(d, M4, 'p4'), true);
  assert.ok(feedTexts(d).some((x) => x.includes('Alex') && x.includes('run has failed')));
});

test('the whole group belongs in the team – only players who play right now are compared', () => {
  const d = mkDoc();
  for (const s of ['p1', 'p2', 'p3']) d.set(`enc:route-29:${s}`, caught());
  d.set('party:p1', ['route-29']);
  d.set('party:p2', ['route-29']);
  d.set('party:p3', []);
  const warn = () => R.checks(d, M3, null).filter((x) => x.level === 'warn' && x.area === 'route-29');
  assert.equal(warn().length, 0, 'nobody is live');
  d.set('live:p3', { party: [], at: Date.now() - 60 * 60 * 1000 });
  assert.equal(warn().length, 0, 'p3 stopped playing an hour ago');
  d.set('live:p3', { party: [], at: Date.now() });
  assert.equal(warn().length, 1, 'one warning for the area, not one per holder');
  assert.ok(warn()[0].text.includes('Kim'));
  // two players: the old partner message
  const d2 = mkDoc();
  d2.set('enc:route-29:p1', caught());
  d2.set('enc:route-29:p2', caught());
  d2.set('party:p1', ['route-29']);
  d2.set('live:p2', { party: [], at: Date.now() });
  const w2 = R.checks(d2, run(2), null).filter((x) => x.level === 'warn');
  assert.equal(w2.length, 1);
  assert.ok(w2[0].text.includes('Lou'));
});

test('type clause spans every player of the group', () => {
  const d = mkDoc();
  const rd = { types: (id) => ({ 16: ['normal'], 19: ['normal'], 25: ['electric'] })[id] || [], familyRoot: (id) => id };
  d.set('enc:route-29:p1', caught(25));
  d.set('enc:route-29:p2', caught(25));
  d.set('enc:route-29:p3', caught(25));
  d.set('enc:route-30:p1', caught(25));
  d.set('enc:route-30:p2', caught(25));
  d.set('enc:route-30:p3', caught(19));
  d.set('enc:route-31:p3', caught(16));
  d.set('party:p1', ['route-29']);
  d.set('party:p3', ['route-30', 'route-31']);
  const typeWarnings = () => R.checks(d, M3, rd).filter((x) => x.text.startsWith('Type rule'));
  assert.equal(typeWarnings().length, 1, 'p3 has two normal types in the team');
  d.set('party:p3', ['route-30']);
  assert.equal(typeWarnings().length, 0);
  d.set('rules', { typeClause: 'player' });
  d.set('party:p3', ['route-30', 'route-31']);
  assert.equal(typeWarnings().length, 1);
});

test('solo Nuzlocke: a catch is alive, a faint is death, a wipe fails the run – no partner checks', () => {
  const d = mkDoc();
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 })] });
  assert.equal(R.pairState(d, 'starter', SOLO).state, 'linked', 'caught = alive');
  assert.equal(R.pairState(d, 'route-29', SOLO).state, 'linked');
  assert.deepEqual(R.counts(d, SOLO), { linked: 2, dead: 0, failed: 0, waiting: 0 });
  assert.deepEqual(R.checks(d, SOLO, { types: (id) => [id === 16 ? 'normal' : 'grass'], familyRoot: (id) => id }), [], 'no partner warnings');

  d.set('enc:route-30:p1', { outcome: 'missed' });
  assert.equal(R.pairState(d, 'route-30', SOLO).state, 'failed');

  const res = R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ hp: 0 }), mon({ key: 'k2', species: 16, metLocation: 177 })] });
  assert.deepEqual(res.deaths, ['starter'], 'autoDeath');
  assert.equal(R.pairState(d, 'starter', SOLO).state, 'dead');
  assert.ok(feedTexts(d).some((x) => x.includes('the Pokémon died')));
  assert.ok(R.checks(d, SOLO, null).some((x) => x.level === 'error' && x.area === 'starter' && x.text.includes('dead Pokémon')));
  assert.equal(R.wipedSlot(d, SOLO), null);

  // the whole party down = blackout: applySnapshot ends the Nuzlocke by itself
  const end = R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ hp: 0 }), mon({ key: 'k2', species: 16, metLocation: 177, hp: 0 })] });
  assert.equal(end.failed, 'blackout');
  assert.equal(R.wipedSlot(d, SOLO), 'p1');
  assert.equal(R.failRun(d, SOLO, 'p1'), false, 'already over');
  assert.equal(d.get('run:status').state, 'failed');
  assert.equal(d.get('run:status').reason, 'blackout');
  assert.ok(feedTexts(d).some((x) => x.includes('the Nuzlocke has failed')));
});

test('solo Nuzlocke without autoDeath: a faint is only an alert', () => {
  const d = mkDoc();
  d.set('rules', { autoDeath: false });
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon()] });
  const res = R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ hp: 0 })] });
  assert.deepEqual(res.deaths, []);
  assert.deepEqual(res.alerts.map((a) => a.type), ['fainted']);
  assert.equal(R.pairState(d, 'starter', SOLO).state, 'linked');
});

test('type rule: partners at the same place with the same primary type – a board warning, and the battle panel says so', () => {
  const d = mkDoc();
  const rd = { types: (id) => ({ 16: ['normal'], 19: ['normal'], 25: ['electric'], 60: ['water'] })[id] || [], familyRoot: (id) => id };
  const M2 = run(2);
  // both caught a Normal type on Route 29 and have it in the team: only one may
  d.set('enc:route-29:p1', caught(16));
  d.set('enc:route-29:p2', caught(19));
  d.set('party:p1', ['route-29']);
  d.set('party:p2', ['route-29']);
  const pair = R.checks(d, M2, rd).filter((x) => x.text.includes('share the primary type'));
  assert.equal(pair.length, 1, 'one warning for the area, not one per player');
  assert.equal(pair[0].area, 'route-29');
  assert.match(pair[0].text, /only one of you/);
  d.set('enc:route-29:p2', caught(60));
  assert.equal(R.checks(d, M2, rd).filter((x) => x.text.includes('share the primary type')).length, 0, 'different types are fine');

  // in battle: Robin caught a Normal type here (Route 29 = met location 177), Lou meets another one
  d.set('enc:route-29:p2', caught(19));
  d.set('where:p1', { gen: 4, id: 177, at: Date.now() });
  const now = R.pairTypeClash(d, M2, rd, 'p1', 16);
  assert.deepEqual(now, { slot: 'p2', species: 19, type: 'normal', now: false });
  assert.equal(R.pairTypeClash(d, M2, rd, 'p1', 60), null, 'another type: no clash');

  // nothing caught there yet, but Robin is fighting a Normal type at the same place right now
  d.set('enc:route-29:p2', { outcome: 'missed' });
  d.set('live:p2', { at: Date.now(), party: [] });
  d.set('where:p2', { gen: 4, id: 177, at: Date.now(), fight: { kind: 'wild', species: 19, level: 3 } });
  assert.deepEqual(R.pairTypeClash(d, M2, rd, 'p1', 16), { slot: 'p2', species: 19, type: 'normal', now: true });
  d.set('where:p2', { gen: 4, id: 178, at: Date.now(), fight: { kind: 'wild', species: 19, level: 3 } });
  assert.equal(R.pairTypeClash(d, M2, rd, 'p1', 16), null, 'a different place');
  d.set('rules', { typeClause: 'player' });
  d.set('where:p2', { gen: 4, id: 177, at: Date.now(), fight: { kind: 'wild', species: 19, level: 3 } });
  assert.equal(R.pairTypeClash(d, M2, rd, 'p1', 16), null, 'per-player type rule: the partner’s types don’t count');
});
