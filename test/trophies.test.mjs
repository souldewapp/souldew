// Trophies: run digests from the shared doc, the cross-run Pokédex, the achievement rules (synthetic run
// histories), medals, the stored state's migration and the server's sync (back-fill, live unlocks, deleted runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-trophies-'));
process.env.SLS_DATA_DIR = DATA;
const T = await import('../shared/trophies.mjs');
const { syncTrophies, TROPHY_PATH } = await import('../server/lib/trophies.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// ---- a tiny doc builder ------------------------------------------------------------
const H = 3600000;
const T0 = Date.UTC(2026, 9, 1, 12);
let seq = 0;
function docOf(o) {
  const d = {};
  const put = (k, v) => (d[k] = { v, t: ++seq, by: 'x' });
  for (const [k, v] of Object.entries(o)) put(k, v);
  return d;
}
const caught = (species, at, extra = {}) => ({ outcome: 'caught', species, nickname: '', level: 5, metLevel: 5, at, ...extra });
const dead = (at, extra = {}) => ({ state: 'dead', diedAt: at, ...extra });
const feedCatch = (slot, area, species, at) => ({ type: 'catch', slot, area, species, at });
const feedEvolve = (slot, area, from, to, at) => ({ type: 'evolve', slot, area, at, msg: { vars: { from: { species: from }, to: { species: to } } } });
const feedBadge = (slot, n, at) => ({ type: 'badge', slot, at, msg: { vars: { n } } });
const solo = (id, extra = {}) => ({ id, name: `Run ${id}`, mode: 'nuzlocke', createdAt: new Date(T0).toISOString(), players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-firered', system: 'gba' }, randomizer: { enabled: true }, ...extra });
const pair = (id, extra = {}) => ({ id, name: `Link ${id}`, createdAt: new Date(T0).toISOString(), players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } }, game: { id: 'pokemon-heartgold', system: 'nds', code: 'IPKE' }, randomizer: { enabled: false }, ...extra });

const evalOf = (digests, moments = [], opts = {}) => Object.fromEntries(T.evaluate(T.context(digests, moments, opts)).map((s) => [s.id, s]));

// ---- digest ------------------------------------------------------------------------
test('digestRun: my catches with their first species, deaths with killers, badges, status – the partner apart', () => {
  const entries = docOf({
    'enc:starter:p1': caught(4, T0 + 1000, { nickname: 'CHAR', level: 36 }),
    'enc:m3-101:p1': caught(16, T0 + 2000, { shiny: true }),
    'enc:m3-102:p1': { outcome: 'missed', species: 19, at: T0 + 3000 },
    'enc:starter:p2': caught(7, T0 + 1500),
    'pair:m3-101': dead(T0 + 5000, { level: 12, by: 'p1', segment: 'gym2', killer: { species: 129, level: 15, kind: 'wild' } }),
    'feed:a': feedCatch('p1', 'starter', 4, T0 + 1000),
    'feed:b': feedEvolve('p1', 'starter', 4, 5, T0 + 4000),
    'feed:c': feedEvolve('p1', 'starter', 5, 6, T0 + 6000),
    'feed:d': feedBadge('p1', 1, T0 + 4500),
    'feed:e': feedBadge('p1', 1, T0 + 9000), // a savestate announced it again
    'feed:f': feedBadge('p2', 3, T0 + 4500), // the partner's badge
    'feed:g': { type: 'cheat', slot: 'p1', cheat: 'rareCandy', count: 3, at: T0 },
    'area:m3-101': { name: 'Route 1', met: [101], auto: true },
    'live:p1': { badges: 2, party: [{ species: 6, level: 36, hp: 1, maxHp: 100, area: 'starter' }] },
    'run:status': { state: 'won', at: T0 + 10 * H, by: 'p1' },
    'player:p2': { name: 'Robin' },
  });
  const d = T.digestRun(pair('aaaa0001'), entries, 'p1');
  assert.equal(d.mode, 'soullink');
  assert.equal(d.players, 2);
  assert.equal(d.catches.length, 2);
  const starter = d.catches.find((c) => c.area === 'starter');
  assert.equal(starter.first, 4, 'first species from the catch feed');
  assert.equal(starter.species, 4);
  const pidgey = d.catches.find((c) => c.species === 16);
  assert.equal(pidgey.areaName, 'Route 1');
  assert.equal(pidgey.dead, true);
  assert.deepEqual(pidgey.killer, { species: 129, level: 15, kind: 'wild' });
  assert.equal(pidgey.segment, 'gym2');
  assert.equal(d.missed.length, 1);
  assert.equal(d.partners.length, 1);
  assert.equal(d.partners[0].species, 7);
  assert.deepEqual(d.badgeAt, { 1: T0 + 4500 }, 'the first announcement counts, the partner’s badge doesn’t');
  assert.equal(d.badges, 2, 'live badge count is higher than the feed');
  assert.equal(d.cheats, 3);
  assert.equal(d.status.state, 'won');
  assert.equal(d.evolutions.length, 2);
  assert.equal(d.randomized, false);
  assert.equal(d.names.p2, 'Robin');
  // the partner's view of the same doc
  const p2 = T.digestRun(pair('aaaa0001'), entries, 'p2');
  assert.equal(p2.catches.length, 1);
  assert.equal(p2.catches[0].species, 7);
  assert.equal(p2.partners.length, 2);
  // garbage never throws
  assert.doesNotThrow(() => T.digestRun(null, { 'enc:x:p1': { v: 'junk', t: 1 }, 'pair:y': null, 'feed:z': { v: 7, t: 1 } }, 'p9'));
});

// ---- Pokédex -----------------------------------------------------------------------
test('buildDex: caught through evolutions, first catch, shiny, deaths; seen from misses, partners, killers and live battles', () => {
  const d = T.digestRun(pair('aaaa0002'), docOf({
    'enc:starter:p1': caught(6, T0 + 100, { nickname: 'BLAZE' }),
    'feed:a': feedCatch('p1', 'starter', 4, T0 + 100),
    'feed:b': feedEvolve('p1', 'starter', 4, 5, T0 + 200),
    'feed:c': feedEvolve('p1', 'starter', 5, 6, T0 + 300),
    'enc:r1:p1': caught(16, T0 + 400, { shiny: true }),
    'pair:r1': dead(T0 + 500, { killer: { species: 19, level: 3, kind: 'wild' } }),
    'enc:r2:p1': { outcome: 'missed', species: 41, at: T0 + 600 },
    'enc:r1:p2': caught(21, T0 + 450),
  }), 'p1');
  const later = T.digestRun(solo('aaaa0003', { createdAt: new Date(T0 + 50 * H).toISOString() }), docOf({
    'enc:starter:p1': caught(4, T0 + 51 * H, { nickname: 'CHARRY' }),
  }), 'p1');
  const dex = T.buildDex([later, d], { 150: T0 + 700 });
  assert.equal(dex[4].caught, 2);
  assert.equal(dex[4].first.runId, 'aaaa0002', 'first catch = the earliest run');
  assert.equal(dex[4].first.nickname, 'BLAZE');
  assert.equal(dex[5].caught, 1, 'evolution counts as caught');
  assert.equal(dex[6].caught, 1);
  assert.equal(dex[6].first.evolved, true);
  assert.equal(dex[16].shiny, 1);
  assert.equal(dex[16].died, 1);
  assert.equal(dex[41].caught, 0);
  assert.ok(dex[41].seenAt, 'a missed encounter is seen');
  assert.ok(dex[21].seenAt, 'the partner’s catch is seen');
  assert.ok(dex[19].seenAt, 'the killer is seen');
  assert.equal(dex[150].seenAt, T0 + 700, 'live battles');
  const totals = T.dexTotals(dex);
  assert.equal(totals.caught, 4); // 4, 5, 6, 16
  assert.equal(totals.seen, 8);
  assert.equal(totals.perGen[0].caught, 4);
  assert.equal(totals.perGen.find((g) => g.gen === 7).supported, true, 'Gen 6/7: the 3DS games');
  assert.equal(totals.perGen.find((g) => g.gen === 8).supported, false);
  assert.equal(T.obtainable(809), true);
  assert.equal(T.obtainable(810), false);
  assert.deepEqual(T.PLAYABLE_GENS, [1, 2, 3, 4, 5, 6, 7]);
  // Alola's goal leaves out its event mythicals and Meltan/Melmetal (Pokémon GO only)
  assert.equal(totals.perGen.find((g) => g.gen === 7).goal, 809 - 722 + 1 - 5);
  assert.equal(T.genOfSpecies(1025), 9);
});

// ---- achievement rules -------------------------------------------------------------
test('rules: progression – first catch, wins, badges and when they were reached', () => {
  const run = T.digestRun(solo('bbbb0001'), docOf({
    'enc:starter:p1': caught(1, T0 + 10),
    'enc:r1:p1': caught(16, T0 + 20),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`feed:b${i}`, feedBadge('p1', i + 1, T0 + (i + 1) * H)])),
    'live:p1': { badges: 8, party: [] },
    'run:status': { state: 'won', at: T0 + 20 * H },
  }), 'p1');
  const s = evalOf([run]);
  assert.equal(s.firstRun.ok, true);
  assert.equal(s.firstCatch.ok, true);
  assert.equal(s.firstCatch.at, T0 + 10);
  assert.equal(s.firstBadge.at, T0 + H);
  assert.equal(s.badges8.ok, true);
  assert.equal(s.badges8.at, T0 + 8 * H);
  assert.equal(s.badges16.ok, false);
  assert.equal(s.badges16.n, 8, 'progress');
  assert.equal(s.firstWin.ok, true);
  assert.equal(s.winNuzlocke.ok, true);
  assert.equal(s.winSoulLink.ok, false);
  assert.equal(s.deathlessWin.ok, true, 'won without a death');
  assert.equal(s.cleanBadge.ok, true);
  assert.equal(s.cleanFour.ok, true);
  assert.equal(s.randoStart.ok, true);
  assert.equal(s.randoWin.ok, true);
  assert.equal(s.vanillaWin.ok, false);
  assert.equal(s.catches50.n, 2);
  assert.equal(s.catches50.ok, false);
  assert.equal(s.dex10.n, 2);
});

test('rules: deaths – clean badges only without a death in between, the funny ones from killers and timing', () => {
  const run = T.digestRun(pair('bbbb0002'), docOf({
    'player:p2': { name: 'Robin' },
    'enc:starter:p1': caught(152, T0 + 10, { nickname: 'CHIKO' }),
    'pair:starter': dead(T0 + 30 * 60000, { by: 'p1', killer: { species: 158, level: 5, kind: 'trainer' } }), // rival's Totodile before badge 1
    'enc:r29:p1': caught(129, T0 + 20, { nickname: 'ROBIN' }),
    'pair:r29': dead(T0 + 30 * 60000 + 4000, { by: 'p1', killer: { species: 129, level: 4, kind: 'wild' } }), // same turn, a Magikarp
    'enc:r29:p2': caught(129, T0 + 25),
    'feed:e1': feedEvolve('p1', 'r29', 129, 130, T0 + 30 * 60000 - 60000),
    'feed:b1': feedBadge('p1', 1, T0 + 2 * H),
    'feed:b2': feedBadge('p1', 2, T0 + 3 * H),
    'enc:r30:p1': caught(19, T0 + 2.5 * H),
    // the run's first death: on the partner's side (Route 31, before the others)
    'enc:r31:p1': caught(21, T0 + 40),
    'pair:r31': dead(T0 + 20 * 60000, { by: 'p2' }),
    'run:status': { state: 'failed', reason: 'wipe', at: T0 + 25 * 60000 },
  }), 'p1');
  const s = evalOf([run]);
  assert.equal(s.rival.ok, true, 'killed by a starter-line trainer Pokémon before the first badge');
  assert.equal(s.starterDown.ok, true);
  assert.equal(s.magikarp.ok, true);
  assert.equal(s.magikarp.hidden, true);
  assert.equal(s.doubleTrouble.ok, true, 'two links died within one turn');
  assert.equal(s.soulTwins.ok, true, 'both caught Magikarp on Route 29');
  assert.equal(s.tooSoon.ok, true, 'named after the partner – and it died');
  assert.equal(s.notMe.ok, true, 'the first death was on the partner’s side');
  assert.equal(s.glowUp.ok, true, 'died a minute after evolving');
  assert.equal(s.speedrun.ok, true, 'failed within 30 minutes');
  assert.equal(s.cleanBadge.ok, true, 'badge 1 had deaths before it, badge 2 none since badge 1');
  assert.equal(s.cleanBadge.at, T0 + 3 * H);
  assert.equal(s.cleanFour.ok, false);
  assert.equal(s.deathlessWin.ok, false);
  assert.equal(s.firstLink.ok, true);
  assert.equal(s.groupLink.ok, false);
});

test('rules: clean badge after deaths earlier on; skill issue; bloodbath; carried vs atlas', () => {
  const deaths = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [
    [`enc:a${i}:p1`, caught(10 + i, T0 + i)],
    [`pair:a${i}`, dead(T0 + H + i * 1000 * 60, { segment: 'gym1', killer: { species: 20, level: 8, kind: 'trainer' } })],
  ]).flat());
  const run = T.digestRun(solo('bbbb0003', { randomizer: { enabled: false } }), docOf({
    ...deaths,
    'enc:keep:p1': caught(25, T0 + 10),
    'feed:b1': feedBadge('p1', 1, T0 + 3 * H),
    'feed:b2': feedBadge('p1', 2, T0 + 5 * H), // no death between badge 1 and 2
    'run:status': { state: 'failed', reason: 'blackout', at: T0 + 6 * H },
  }), 'p1');
  const s = evalOf([run]);
  assert.equal(s.cleanBadge.ok, true);
  assert.equal(s.cleanBadge.at, T0 + 5 * H);
  assert.equal(s.cleanFour.ok, false);
  assert.equal(s.bloodbath.ok, true, 'six deaths before the same gym');
  assert.equal(s.skillIssue.ok, true, 'the last death was to a trainer below level 10');
  assert.equal(s.rattata.ok, true, 'Raticate');
  assert.equal(s.speedrun.ok, false);

  const link = (mine, theirs) => T.digestRun(pair('bbbb0004'), docOf({
    'enc:starter:p1': caught(1, T0),
    'live:p1': { badges: 8, party: [{ species: 3, level: mine }] },
    'live:p2': { badges: 8, party: [{ species: 6, level: theirs }] },
    'run:status': { state: 'won', at: T0 + H },
  }), 'p1');
  assert.equal(evalOf([link(40, 55)]).carried.ok, true);
  assert.equal(evalOf([link(40, 55)]).atlas.ok, false);
  assert.equal(evalOf([link(60, 45)]).atlas.ok, true);
  assert.equal(evalOf([link(50, 52)]).carried.ok, false);
});

test('rules: collection counts across runs, regional dexes, types, legendaries, starters', () => {
  const many = (id, from, to, extra = {}) => T.digestRun(solo(id, extra), docOf(Object.fromEntries(
    Array.from({ length: to - from + 1 }, (_, i) => [`enc:x${i}:p1`, caught(from + i, T0 + (from + i) * 1000, { metLevel: 5 })]))), 'p1');
  const kanto = many('cccc0001', 1, 151);
  const s = evalOf([kanto], [], { typesOf: () => ['normal'] });
  assert.equal(s.dexKanto.ok, true);
  assert.equal(s.dexKanto.at, T0 + 150 * 1000, 'reached with Mewtwo – Mew is event-only and not needed');
  assert.equal(T.ACHIEVEMENTS.find((a) => a.id === 'dexKanto').target, 150);
  assert.equal(s.dex100.ok, true);
  assert.equal(s.dex100.at, T0 + 100 * 1000);
  assert.equal(s.dex250.n, 151);
  assert.equal(s.legendary5.ok, true, 'Articuno … Mew');
  assert.equal(s.starterTrio.ok, true);
  assert.equal(s.eevee.n, 3, 'Vaporeon, Jolteon, Flareon');
  assert.equal(s.fossil.ok, true);
  assert.equal(s.randoLegend.ok, true, 'a legendary at level 5 in a randomized run');
  assert.equal(s.allTypes.n, 1, 'typesOf decides');
  assert.equal(evalOf([kanto]).allTypes.n, 0, 'no type data – no progress, no crash');
  assert.equal(evalOf([many('cccc0002', 152, 251)]).dexJohto.ok, true);
  assert.equal(evalOf([kanto, many('cccc0003', 152, 400)]).dex250.ok, true);
  // later generations are not in the National Dex goal that souldew can reach
  assert.equal(T.ACHIEVEMENTS.find((a) => a.id === 'dexNational').target, T.SUPPORTED_MAX - T.EVENT_ONLY.size);
  const noMew = many('cccc0004', 1, 150);
  assert.equal(evalOf([noMew]).dexKanto.ok, true, 'Kanto complete without Mew');
  const dexMedal = T.medals([], T.dexTotals(T.buildDex([noMew]))).find((m) => m.id === 'dex-1');
  assert.equal(dexMedal.total, 150);
  assert.equal(dexMedal.tier, 4, 'the master tier without Mew');
});

test('rules: live moments – 1 HP, underleveled badges, monotype; Bidoof in the winning team', () => {
  const run = T.digestRun(solo('dddd0001'), docOf({ 'enc:starter:p1': caught(399, T0) }), 'p1');
  const s = evalOf([run], [
    { type: 'hp1', at: T0 + 1, species: 399 },
    { type: 'badge', n: 1, top: 12, cap: 14, at: T0 + 2 },
    { type: 'badge', n: 2, top: 20, cap: 18, at: T0 + 3 }, // over the ace level: no underdog
    { type: 'monotype', ptype: 'water', at: T0 + 4 },
  ]);
  assert.equal(s.oneHp.ok, true);
  assert.equal(s.underdog.ok, true);
  assert.equal(s.underdog.at, T0 + 2);
  assert.equal(s.underdog3.n, 1);
  assert.equal(s.monotype.ok, true);
  assert.equal(s.bidoof.ok, false);
  // a type rule forbids a monotype team: the moment doesn't count there (a SoulLink has it on by default)
  const linkRun = T.digestRun({ id: 'dddd0003', mode: 'soullink', createdAt: new Date(T0).toISOString() }, docOf({}), 'p1');
  assert.equal(evalOf([linkRun], [{ type: 'monotype', ptype: 'water', at: T0, runId: 'dddd0003' }]).monotype.ok, false);
  const freeLink = T.digestRun({ id: 'dddd0004', mode: 'soullink', createdAt: new Date(T0).toISOString() }, docOf({ rules: { typeClause: 'off' } }), 'p1');
  assert.equal(evalOf([freeLink], [{ type: 'monotype', ptype: 'water', at: T0, runId: 'dddd0004' }]).monotype.ok, true);
  const party = [{ species: 400, level: 50 }, { species: 6, level: 52 }];
  const bidoofWin = T.digestRun(solo('dddd0002'), docOf({ 'live:p1': { badges: 8, party }, 'run:status': { state: 'won', at: T0 + 9 } }), 'p1');
  assert.equal(evalOf([bidoofWin]).bidoof.ok, true, 'a Bibarel in the winning team');
  const bidoofLoss = T.digestRun(solo('dddd0005'), docOf({ 'live:p1': { badges: 3, party }, 'run:status': { state: 'failed', at: T0 + 9 } }), 'p1');
  assert.equal(evalOf([bidoofLoss]).bidoof.ok, false, 'only a won run counts');
});

test('rules: every achievement has a unique id, a known category and rarity, and survives an empty history', () => {
  const ids = T.ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 60 && ids.length <= 120, `${ids.length} achievements`);
  for (const a of T.ACHIEVEMENTS) {
    assert.ok(T.CATEGORIES.includes(a.cat), a.id);
    assert.ok(T.RARITIES.includes(a.rarity), a.id);
  }
  const empty = T.evaluate(T.context([], []));
  assert.equal(empty.filter((s) => s.ok).length, 0);
  // a rule that throws on odd data counts as not reached instead of breaking the page
  const odd = [{ id: 'x', catches: [{ at: 'soon', level: 'high' }], deaths: null, badgeAt: {}, lives: {}, partners: [], missed: [], evolutions: [] }];
  assert.doesNotThrow(() => T.evaluate(T.context(odd, [{ type: 'badge' }])));
});

test('digest: savestate rewinds, the partner’s deaths, a solo run’s bonus Pokémon, twins by what was caught, Gen 7 trials', () => {
  const run = T.digestRun(pair('bbbb0009'), docOf({
    'enc:r1:p1': caught(5, T0 + 10),
    'feed:c1': feedCatch('p1', 'r1', 4, T0 + 10),
    // Charmander → Charmeleon, a savestate back (Charmeleon → Charmander), evolved again, then Charizard
    'feed:e1': feedEvolve('p1', 'r1', 4, 5, T0 + H),
    'feed:e2': feedEvolve('p1', 'r1', 5, 4, T0 + H + 60000),
    'feed:e3': feedEvolve('p1', 'r1', 4, 5, T0 + H + 120000),
    'feed:e4': feedEvolve('p1', 'r1', 5, 6, T0 + 2 * H),
    // the partner's Magikarp on Route 2 died to a wild Magikarp – the link is dead, the killer isn't mine
    'enc:r2:p1': caught(16, T0 + 20),
    'enc:r2:p2': caught(129, T0 + 25),
    'pair:r2': dead(T0 + 3 * H, { by: 'p2', level: 9, killer: { species: 129, level: 4, kind: 'wild' } }),
    // twins: both caught Charmander on Route 1; the partner's has evolved since
    'enc:r1:p2': caught(5, T0 + 30),
    'feed:c2': feedCatch('p2', 'r1', 4, T0 + 30),
  }), 'p1');
  assert.deepEqual(run.evolutions.map((e) => e.to), [5, 6], 'one evolution per step');
  const r2 = run.catches.find((x) => x.area === 'r2');
  assert.equal(r2.dead, true);
  assert.equal(r2.killer, null);
  assert.equal(r2.deathLevel, null);
  assert.equal(run.partners.find((p) => p.area === 'r1').first, 4);
  const s = evalOf([run]);
  assert.equal(s.magikarp.ok, false, 'the partner’s loss isn’t mine');
  assert.equal(s.soulTwins.ok, true, 'twins by the species both caught');
  // a false twin: my Charmander evolved, the partner caught a wild Charmeleon
  const run2 = T.digestRun(pair('bbbb0010'), docOf({
    'enc:r1:p1': caught(5, T0 + 10), 'feed:c1': feedCatch('p1', 'r1', 4, T0 + 10),
    'enc:r1:p2': caught(5, T0 + 30), 'feed:c2': feedCatch('p2', 'r1', 5, T0 + 30),
  }), 'p1');
  assert.equal(evalOf([run2]).soulTwins.ok, false);
  // a solo run's gift Pokémon died: the run isn't deathless
  const run3 = T.digestRun(solo('bbbb0011'), docOf({
    'enc:starter:p1': caught(1, T0 + 10),
    'extra:p1:gift1': { species: 133, at: T0 + 20, dead: true, diedAt: T0 + H },
    'run:status': { state: 'won', at: T0 + 20 * H },
  }), 'p1');
  assert.equal(run3.deaths.length, 1);
  assert.equal(evalOf([run3]).deathlessWin.ok, false);
  // Gen 7 (no badges – island trials): the starter lost at the Elite Four is no "before the first badge"
  const sun = { game: { id: 'pokemon-sun', system: '3ds', generation: 7 } };
  const starterAt = (diedAt, bosses = {}) => T.digestRun(solo('bbbb0012', sun), docOf({
    'enc:starter:p1': caught(722, T0 + 10), 'pair:starter': dead(diedAt, { by: 'p1' }), ...bosses,
  }), 'p1');
  assert.equal(evalOf([starterAt(T0 + 40 * H)]).starterDown.ok, false, 'no badge, no boss: not judged');
  assert.equal(evalOf([starterAt(T0 + H, { 'boss:hala': { at: T0 + 5 * H } })]).starterDown.ok, true, 'before the first boss');
  assert.equal(evalOf([starterAt(T0 + 9 * H, { 'boss:hala': { at: T0 + 5 * H } })]).starterDown.ok, false, 'after it');
  // a 3DS run whose game wasn't identified still counts for its system's first generation
  assert.equal(T.digestRun(solo('bbbb0013', { game: { system: '3ds' } }), docOf({}), 'p1').gen, 6);
});

test('medals: tiers per category, per regional dex and the champion’s medal', () => {
  const states = T.ACHIEVEMENTS.map((a) => ({ id: a.id, cat: a.cat, hidden: !!a.hidden, ok: a.cat === 'randomizer' || (a.cat === 'fun' && !a.hidden) }));
  const totals = T.dexTotals(Object.fromEntries(Array.from({ length: 151 }, (_, i) => [i + 1, { caught: 1, shiny: 0, seenAt: 0 }])));
  const m = Object.fromEntries(T.medals(states, totals).map((x) => [x.id, x]));
  assert.equal(m['cat-randomizer'].tier, 4, 'every randomizer achievement (none secret): master');
  assert.equal(m['cat-fun'].tier, 3, 'all open fun ones: platinum, the secret ones are missing for master');
  assert.equal(m['cat-skill'].tier, -1);
  // secret ones count, but never past "one open one missing": the value shown is the one the tiers use
  const sl = T.ACHIEVEMENTS.filter((a) => a.cat === 'soullink');
  const openSl = sl.filter((a) => !a.hidden);
  const almost = T.ACHIEVEMENTS.map((a) => ({ id: a.id, cat: a.cat, hidden: !!a.hidden, ok: a.cat === 'soullink' && (a.hidden || a.id !== openSl[0].id) }));
  const ms = T.medals(almost, totals).find((x) => x.id === 'cat-soullink');
  assert.equal(ms.value, openSl.length - 1);
  assert.equal(ms.tier, 2, 'gold, not platinum, with an open one missing');
  assert.equal(m['dex-1'].tier, 4, 'Kanto complete');
  assert.equal(m['dex-2'].tier, -1);
  assert.equal(m['dex-7'].tier, -1, 'Alola: a medal to earn');
  assert.ok(!m['dex-8'], 'no medal for a generation souldew doesn’t play');
  assert.ok(m.champion.tier >= 0);
  assert.equal(T.TIERS.length, 5);
});

test('stored state: migration keeps unknown fields, drops junk moments, dedupes by key', () => {
  const s = T.migrate({ schema: 1, future: { x: 1 }, moments: [{ type: 'hp1', species: 25, runId: 'abcd1234', at: 5 }, { type: 'nope' }, null, { type: 'badge', n: 99 }], unlocked: [], slots: 'x' });
  assert.deepEqual(s.future, { x: 1 });
  assert.equal(s.moments.length, 1);
  assert.deepEqual(s.unlocked, {});
  assert.deepEqual(s.slots, {});
  assert.equal(T.migrate(null).schema, T.SCHEMA);
  assert.equal(T.migrate({ schema: 7 }).schema, 7, 'a newer file keeps its schema number');
  assert.equal(T.momentKey({ type: 'badge', runId: 'abcd1234', n: 3 }), T.momentKey(T.cleanMoment({ type: 'badge', runId: 'abcd1234', n: 3, top: 5, cap: 9 })));
});

// ---- server sync -------------------------------------------------------------------
function writeRun(m, entries) {
  const dir = join(DATA, 'runs', m.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(m));
  writeFileSync(join(dir, 'doc.json'), JSON.stringify(entries));
}

test('syncTrophies: back-fills quietly on the first start, then unlocks live; keeps a deleted run; persists with a schema', async () => {
  writeRun(solo('eeee0001'), docOf({ 'enc:starter:p1': caught(1, T0), 'feed:b1': feedBadge('p1', 1, T0 + H) }));
  const first = syncTrophies({});
  assert.deepEqual(first.fresh, [], 'no toast storm on the first start');
  assert.ok(first.backfilled.includes('firstCatch'));
  assert.ok(first.backfilled.includes('firstBadge'));
  const fc = first.achievements.find((a) => a.id === 'firstCatch');
  assert.equal(fc.ok, true);
  assert.equal(fc.at, T0, 'back-filled with the time from the data');
  assert.equal(first.dex[1].caught, 1);
  const stored = JSON.parse(readFileSync(TROPHY_PATH, 'utf8'));
  assert.equal(stored.schema, T.SCHEMA);
  assert.ok(stored.runs.eeee0001.digest);

  // a live catch of a shiny + a 1 HP moment: unlocked now, reported as fresh once
  writeRun(solo('eeee0001'), docOf({ 'enc:starter:p1': caught(1, T0), 'enc:r1:p1': caught(16, Date.now(), { shiny: true }), 'feed:b1': feedBadge('p1', 1, T0 + H) }));
  const second = syncTrophies({ moments: [{ type: 'hp1', species: 16, runId: 'eeee0001' }], seen: [150, 'x', 99999] });
  assert.ok(second.fresh.includes('firstShiny'));
  assert.ok(second.fresh.includes('oneHp'));
  assert.ok(second.dex[150].seenAt, 'seen in a live battle');
  assert.deepEqual(syncTrophies({ moments: [{ type: 'hp1', species: 16, runId: 'eeee0001' }] }).fresh, [], 'reported once');

  // the slot this computer plays decides whose catches count
  writeRun(pair('eeee0002', { imported: true }), docOf({ 'enc:r1:p1': caught(25, T0), 'enc:r1:p2': caught(133, T0) }));
  let r = syncTrophies({});
  assert.equal(r.dex[133]?.caught, 1, 'an imported invite plays p2 by default');
  assert.ok(!r.dex[25]?.caught);
  r = syncTrophies({ slots: { eeee0002: 'p1' } });
  assert.equal(r.dex[25].caught, 1);
  assert.ok(!r.dex[133]?.caught);

  // deleting a run (moved to the trash) keeps its catches and the unlocks
  rmSync(join(DATA, 'runs', 'eeee0001'), { recursive: true });
  r = syncTrophies({});
  assert.equal(r.dex[16].caught, 1);
  assert.ok(r.runs.find((x) => x.id === 'eeee0001').archived);
  assert.equal(r.achievements.find((a) => a.id === 'firstShiny').ok, true);

  // a broken file starts afresh instead of failing
  writeFileSync(TROPHY_PATH, '{oops');
  assert.doesNotThrow(() => syncTrophies({}));
  assert.ok(existsSync(TROPHY_PATH));
});

test('syncTrophies: a run\'s generation is its game\'s – a hack\'s base game (Blaze Black 2: Gen 5, not "a DS game: 4"), a 3DS game\'s', () => {
  writeRun(solo('ffff0101', { game: { id: 'blaze-black-2-redux', system: 'nds', hackId: 'blaze-black-2-redux' } }), docOf({ 'enc:starter:p1': caught(495, T0) }));
  writeRun(solo('ffff0102', { game: { id: 'pokemon-x', system: '3ds' } }), docOf({ 'enc:starter:p1': caught(650, T0) }));
  writeRun(solo('ffff0103', { game: { id: null, system: 'nds', hackId: 'blaze-black' }, patch: { hackId: 'blaze-black' } }), docOf({}));
  const r = syncTrophies({});
  const gen = (id) => r.runs.find((x) => x.id === id).gen;
  assert.equal(gen('ffff0101'), 5);
  assert.equal(gen('ffff0102'), 6);
  assert.equal(gen('ffff0103'), 5, 'found through the hack\'s base game');
  for (const id of ['ffff0101', 'ffff0102', 'ffff0103']) rmSync(join(DATA, 'runs', id), { recursive: true });
});

test('syncTrophies: digests of an older version are made again; a deleted run gets its generation from its game id', () => {
  writeRun(solo('ffff0201', { game: { id: 'blaze-black-2-redux', system: 'nds', hackId: 'blaze-black-2-redux' } }), docOf({ 'enc:starter:p1': caught(495, T0) }));
  syncTrophies({});
  const st = JSON.parse(readFileSync(TROPHY_PATH, 'utf8'));
  // as an older version left them: a present run with the old signature and Gen 4, a deleted one with Gen 4
  st.runs.ffff0201 = { sig: 'old', digest: { ...st.runs.ffff0201.digest, gen: 4 } };
  st.runs.ffff0202 = { sig: 'old', archived: true, digest: { ...st.runs.ffff0201.digest, id: 'ffff0202', gen: 4 } };
  writeFileSync(TROPHY_PATH, JSON.stringify(st));
  const r = syncTrophies({});
  const gen = (id) => r.runs.find((x) => x.id === id).gen;
  assert.equal(gen('ffff0201'), 5, 'digested again');
  assert.equal(gen('ffff0202'), 5, 'the deleted run: from its game id');
  assert.equal(r.runs.find((x) => x.id === 'ffff0202').archived, true);
  rmSync(join(DATA, 'runs', 'ffff0201'), { recursive: true });
});

test('rules: the classic memes – Miltank, Garchomp, Selfdestruct, Abra, roamers, Gyarados, Feebas, Helix, Bird Jesus, too much water', () => {
  const run = T.digestRun(solo('eeee0001', { game: { id: 'pokemon-emerald', system: 'gba' } }), docOf({
    'enc:a1:p1': caught(16, T0 + 1),
    'pair:a1': dead(T0 + 50, { killer: { species: 241, level: 19, kind: 'trainer' } }),
    'enc:a2:p1': caught(25, T0 + 2, { shiny: true }),
    'pair:a2': dead(T0 + 60, { killer: { species: 74, level: 8, kind: 'wild' } }),
    'enc:a3:p1': { outcome: 'missed', species: 63, at: T0 + 3 },
    'enc:a4:p1': { outcome: 'missed', species: 244, at: T0 + 4 },
    'enc:a5:p1': caught(129, T0 + 5),
    'feed:e1': feedEvolve('p1', 'a5', 129, 130, T0 + 70),
    'enc:a6:p1': caught(349, T0 + 6),
    'enc:a7:p1': caught(138, T0 + 7),
    ...Object.fromEntries([7, 54, 60, 72, 118, 120].map((id, i) => [`enc:w${i}:p1`, caught(id, T0 + 10 + i)])),
    'live:p1': { badges: 8, party: [{ species: 18, level: 60 }] },
    'run:status': { state: 'won', at: T0 + 99 },
  }), 'p1');
  const water = new Set([7, 54, 60, 72, 118, 120, 129, 130, 349, 138]);
  const s = evalOf([run], [], { typesOf: (id) => (water.has(id) ? ['water'] : ['normal']) });
  for (const id of ['miltank', 'kaboom', 'teleport', 'roamer', 'shinyDown', 'gyarados', 'feebas', 'helix', 'birdJesus', 'tooMuchWater']) assert.equal(s[id].ok, true, id);
  assert.equal(s.garchomp.ok, false);
  // a wild Miltank or a trainer's Geodude is not the meme
  const other = T.digestRun(solo('eeee0002'), docOf({
    'enc:b1:p1': caught(16, T0 + 1), 'pair:b1': dead(T0 + 5, { killer: { species: 241, level: 19, kind: 'wild' } }),
    'enc:b2:p1': caught(17, T0 + 2), 'pair:b2': dead(T0 + 6, { killer: { species: 74, level: 12, kind: 'trainer' } }),
  }), 'p1');
  const o = evalOf([other]);
  assert.equal(o.miltank.ok, false);
  assert.equal(o.kaboom.ok, false);
  assert.equal(evalOf([run]).tooMuchWater.n, 0, 'no type data – no progress');
});

test('rules: Gen 6/7 (the 3DS games) – Kalos/Alola dexes, their starters, Sylveon, Kalos fossils, X/Y\'s roaming bird, all seven generations', () => {
  const xy = (id, extra = {}) => solo(id, { game: { id: 'pokemon-x', system: '3ds' }, ...extra });
  const run = T.digestRun(xy('ffff0001'), docOf({
    'enc:a1:p1': caught(650, T0 + 1),
    'enc:a2:p1': caught(653, T0 + 2),
    'enc:a3:p1': caught(656, T0 + 3),
    'enc:a4:p1': caught(696, T0 + 4),
    'enc:a5:p1': { outcome: 'missed', species: 144, at: T0 + 5 },
  }), 'p1', { gen: 6 });
  let s = evalOf([run]);
  for (const id of ['starterTrio', 'fossil', 'roamer']) assert.equal(s[id].ok, true, id);
  // Articuno in its cave (FireRed) doesn't roam: missing it isn't the meme
  const fr = T.digestRun(solo('ffff0002'), docOf({ 'enc:a5:p1': { outcome: 'missed', species: 144, at: T0 + 5 } }), 'p1', { gen: 3 });
  assert.equal(evalOf([fr]).roamer.ok, false);
  // Sylveon is the eighth Eeveelution
  const eevee = T.digestRun(xy('ffff0003'), docOf(Object.fromEntries([134, 135, 136, 196, 700].map((id, i) => [`enc:e${i}:p1`, caught(id, T0 + i)]))), 'p1', { gen: 6 });
  assert.equal(evalOf([eevee]).eevee.ok, true);
  // Kalos complete: every species from #650 to #721 but Diancie, Hoopa, Volcanion
  const kalos = T.digestRun(xy('ffff0004'), docOf(Object.fromEntries(Array.from({ length: 69 }, (_, i) => [`enc:k${i}:p1`, caught(650 + i, T0 + i)]))), 'p1', { gen: 6 });
  s = evalOf([kalos]);
  assert.equal(s.dexKalos.ok, true);
  assert.equal(s.dexAlola.ok, false);
  // a run in each of the seven generations
  const runs = [1, 2, 3, 4, 5, 6, 7].map((g) => T.digestRun(solo(`ffff01${g}0`), docOf({}), 'p1', { gen: g }));
  assert.equal(evalOf(runs.slice(0, 6)).allGens.ok, false);
  assert.equal(evalOf(runs).allGens.ok, true);
});
