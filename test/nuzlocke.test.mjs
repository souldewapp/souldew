// Solo Nuzlocke rules: presets, blackout / deathless run end, death causes, Nuzlocke checks, missed
// encounters and the run stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const { loadData } = await import('../web/lib/data.mjs');

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const SOLO = { ...HG, mode: 'nuzlocke', name: 'Lou – Nuzlocke #3', players: { p1: { name: 'Lou' } } };
const PAIR = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };

function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, metLevel: 5, ...o });
const pidgey = (o = {}) => mon({ key: 'k2', species: 16, nickname: 'PIDGE', metLocation: 177, level: 3, metLevel: 3, ...o });
const feedTexts = (d) => R.feedList(d).map((f) => f.text);
const snap = (d, party, opts, m = SOLO) => R.applySnapshot(d, m, 4, 'p1', { source: 'live', party }, opts);

test('rules: Nuzlocke defaults per mode, presets, giftsCount still understood', () => {
  const d = mkDoc();
  const r = R.rules(d, SOLO);
  for (const [k, v] of Object.entries(R.NUZLOCKE_RULES)) assert.equal(r[k], v, k);
  assert.equal(r.blackout, 'party');
  assert.equal(r.typeClause, 'off');
  assert.equal(R.rules(d).typeClause, 'global', 'without a manifest: SoulLink defaults (old signature)');
  assert.equal(R.rules(d, PAIR).dupes, 'player');
  assert.equal(R.presetOf(r), 'classic');
  assert.equal(R.presetOf({ ...r, ...R.RULE_PRESETS.hardcore }), 'hardcore');
  assert.equal(R.presetOf({ ...r, ...R.RULE_PRESETS.hardcore, levelCaps: true }), 'hardcore');
  assert.equal(R.presetOf({ ...r, deathless: true }), 'custom');
  assert.equal(R.presetOf({ ...r, sounds: false }), 'classic', 'tool settings are no rule');
  assert.equal(R.RULE_PRESETS.hardcore.noBattleItems, true);
  assert.equal(R.RULE_PRESETS.hardcore.setMode, true);
  // older docs: giftsCount
  assert.equal(R.rules(mkDoc({ giftsCount: false }), SOLO).gifts, 'free');
  assert.equal(R.rules(mkDoc({ gifts: 'banned' }), SOLO).giftsCount, true);
  assert.equal(R.rules(mkDoc({ gifts: 'free' })).giftsCount, false);
});

test('blackout "party": the whole party at 0 HP ends the run, no marked death needed', () => {
  const d = mkDoc({ autoDeath: false });
  snap(d, [mon(), pidgey()]);
  assert.equal(R.blackout(d, SOLO), false);
  const res = snap(d, [mon({ hp: 0 }), pidgey({ hp: 0 }), mon({ key: 'egg', species: 175, isEgg: true, hp: 0, maxHp: 0 })]);
  assert.deepEqual(res.deaths, []);
  assert.equal(res.failed, 'blackout');
  assert.equal(d.get('run:status').reason, 'blackout');
  assert.ok(feedTexts(d).some((x) => x.includes('blacked out')));
  // "play on": the same blackout doesn't end it again, a new one does
  const realNow = Date.now;
  let now = realNow() + 1000;
  Date.now = () => now;
  try {
    R.resumeRun(d, 'p1');
    now += 1000;
    assert.equal(snap(d, [mon({ hp: 0 }), pidgey({ hp: 0 })]).failed, null);
    snap(d, [mon(), pidgey()]);
    now += 1000;
    assert.equal(snap(d, [mon({ hp: 0 }), pidgey({ hp: 0 })]).failed, 'blackout');
  } finally {
    Date.now = realNow;
  }
  // a save file is no live read; a SoulLink never ends this way
  const s = mkDoc();
  R.applySnapshot(s, SOLO, 4, 'p1', { source: 'save', party: [mon({ hp: 0 })] });
  assert.equal(R.blackout(s, SOLO), false);
  const p = mkDoc();
  assert.equal(snap(p, [mon({ hp: 0 })], {}, PAIR).failed, null);
  assert.equal(p.get('run:status', null), null);
});

test('blackout "box" waits until nothing alive is left; "off" never ends the run', () => {
  const d = mkDoc({ blackout: 'box' });
  snap(d, [mon(), pidgey()]);
  assert.equal(snap(d, [mon({ hp: 0 }), pidgey()]).failed, null, 'Pidgey lives');
  assert.equal(d.get('pair:starter').state, 'dead');
  assert.equal(snap(d, [mon({ hp: 0 }), pidgey({ hp: 0 })]).failed, 'blackout');
  assert.equal(R.wipedSlot(d, [], SOLO), 'p1', 'wipedSlot follows the Nuzlocke rule with a manifest');

  const bonus = mkDoc({ blackout: 'box' });
  snap(bonus, [mon()]);
  bonus.set('extra:p1:shiny', { species: 25, at: 1 });
  assert.equal(snap(bonus, [mon({ hp: 0 })]).failed, null, 'a bonus shiny in the box is still alive');

  const off = mkDoc({ blackout: 'off' });
  snap(off, [mon()]);
  assert.equal(snap(off, [mon({ hp: 0 })]).failed, null);
  assert.equal(R.wipedSlot(off, SOLO), null);
});

test('deathless: the first death ends the Nuzlocke (SoulLinks ignore the rule)', () => {
  const d = mkDoc({ deathless: true, blackout: 'off' });
  snap(d, [mon(), pidgey()]);
  const res = snap(d, [mon(), pidgey({ hp: 0 })]);
  assert.deepEqual(res.deaths, ['route-29']);
  assert.equal(res.failed, 'deathless');
  assert.equal(d.get('run:status').reason, 'deathless');
  assert.ok(feedTexts(d).some((x) => x.includes('deathless')));
  const p = mkDoc({ deathless: true });
  R.applySnapshot(p, PAIR, 4, 'p1', { source: 'live', party: [mon()] });
  R.applySnapshot(p, PAIR, 4, 'p1', { source: 'live', party: [mon({ hp: 0 })] });
  assert.equal(p.get('pair:starter').state, 'dead');
  assert.equal(p.get('run:status', null), null);
});

test('a death in battle keeps the opponent, its level and the level at death', () => {
  const d = mkDoc({ blackout: 'off' });
  snap(d, [mon(), pidgey()]);
  snap(d, [mon({ level: 12 }), pidgey({ hp: 0, level: 7 })], { battle: { kind: 'trainer', enemy: { species: 74, level: 14 } } });
  const p = d.get('pair:route-29');
  assert.equal(p.level, 7);
  assert.deepEqual(p.killer, { species: 74, level: 14, kind: 'trainer' });
  assert.equal(p.segment, R.levelCap(d, SOLO, 'p1').boss.key, 'the boss segment it fell in');
  const death = R.feedList(d).find((f) => f.type === 'death');
  assert.match(death.text, /fainted against #74 \(Lv\. 14, trainer battle\)/);
  // without a battle (and none that just ended – that one would still count, see polish.test.mjs): the old cause
  const real = Date.now;
  Date.now = () => real() + 60000;
  try {
    snap(d, [mon({ hp: 0, level: 12 })]);
  } finally {
    Date.now = real;
  }
  assert.equal(d.get('pair:starter').killer, null);
  assert.match(R.feedList(d).find((f) => f.type === 'death' && f.area === 'starter').text, /CHIKO fainted/);
});

test('Nuzlocke checks: second catch on a spent area, no partner checks, strict caps', () => {
  const d = mkDoc();
  snap(d, [mon(), pidgey()]);
  // a second Route 29 catch is used in the team
  const res = snap(d, [mon(), pidgey(), mon({ key: 'k3', species: 19, nickname: 'RAT', metLocation: 177, level: 2, metLevel: 2 })]);
  assert.equal(res.inbox[0].reason, 'occupied');
  const spent = () => R.checks(d, SOLO, null).filter((c) => c.text.includes('second catch'));
  assert.equal(spent().length, 1);
  assert.equal(spent()[0].area, 'route-29');
  d.set('extra:p1:k3', { species: 19, at: 1 }); // kept as a bonus → fine
  assert.equal(spent().length, 0);
  // a shiny (clause on) is no violation
  const s = mkDoc();
  snap(s, [mon(), pidgey()]);
  snap(s, [mon(), pidgey(), mon({ key: 'k3', species: 19, metLocation: 177, shiny: true })]);
  assert.equal(R.checks(s, SOLO, null).filter((c) => c.text.includes('second catch')).length, 0);

  // strict caps: over the cap is an error (Hardcore), warn mode a warning
  const c = mkDoc({ levelCaps: 'strict' });
  snap(c, [mon({ level: 60 })]);
  assert.ok(R.checks(c, SOLO, null).some((x) => x.level === 'error' && x.text.startsWith('Level cap')));
  c.set('rules', { levelCaps: 'warn' });
  assert.ok(R.checks(c, SOLO, null).some((x) => x.level === 'warn' && x.text.startsWith('Level cap')));
  c.set('rules', { levelCaps: false });
  assert.ok(!R.checks(c, SOLO, null).some((x) => x.text.startsWith('Level cap')));
});

test('a badge won while over the cap is a rule break (levels gained in that fight are fine)', () => {
  const d = mkDoc({ levelCaps: 'warn' });
  snap(d, [mon({ level: 8 })], {}, SOLO);
  const cap0 = R.levelCap(d, SOLO, 'p1').cap;
  // beaten within the cap; the mon levels past it in the fight → no break
  // (live data arrives every poll; a jump of more than 5 levels counts once a second read agrees)
  for (let i = 0; i < 2; i++) R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: cap0 + 3 })], badges: 1 });
  assert.equal(Object.keys(d.scan('capbreak:p1:')).length, 0);
  // next gym: already over the (new) cap before the badge
  const cap1 = R.levelCap(d, SOLO, 'p1').cap;
  for (let i = 0; i < 2; i++) R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: cap1 + 5 })], badges: 1 });
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: cap1 + 5 })], badges: 2 });
  const breaks = Object.values(d.scan('capbreak:p1:'));
  assert.equal(breaks.length, 1);
  assert.deepEqual([breaks[0].badge, breaks[0].cap, breaks[0].level], [2, cap1, cap1 + 5]);
  assert.ok(R.checks(d, SOLO, null).some((x) => x.text.startsWith('Badge 2 was won')));
  d.set('rules', { levelCaps: false });
  assert.ok(!R.checks(d, SOLO, null).some((x) => x.text.startsWith('Badge')));
  // SoulLinks don't track this
  const p = mkDoc();
  R.applySnapshot(p, PAIR, 4, 'p1', { source: 'live', party: [mon({ level: 90 })], badges: 0 });
  R.applySnapshot(p, PAIR, 4, 'p1', { source: 'live', party: [mon({ level: 90 })], badges: 1 });
  assert.equal(Object.keys(p.scan('capbreak:')).length, 0);
});

test('nickname rule: a mon still carrying its species name is an info', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/shared/')) throw new Error('offline');
    const body = readFileSync(new URL('..' + url, import.meta.url), 'utf8');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
  };
  try {
    await loadData();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(R.isDefaultName(152, 'CHIKORITA'), true);
  assert.equal(R.isDefaultName(152, 'Endivie'), true, 'any language');
  assert.equal(R.isDefaultName(152, 'CHIKO'), false);
  const d = mkDoc({ nicknames: true });
  snap(d, [mon({ nickname: 'CHIKORITA' }), pidgey()]);
  const infos = R.checks(d, SOLO, null).filter((c) => c.level === 'info');
  assert.equal(infos.length, 1);
  assert.equal(infos[0].area, 'starter');
  d.set('rules', { nicknames: false });
  assert.equal(R.checks(d, SOLO, null).filter((c) => c.level === 'info').length, 0);
});

test('dupes: "species" only blocks the same species, "line" the whole evolution line', () => {
  const rd = { familyRoot: (id) => ({ 17: 16, 18: 16 })[id] || id, types: () => [] };
  const line = mkDoc();
  snap(line, [mon(), pidgey()], { rd });
  snap(line, [mon(), pidgey(), mon({ key: 'k3', species: 17, metLocation: 178 })], { rd });
  assert.equal(line.get('enc:route-30:p1', null), null, 'Pidgeotto is a dupe of Pidgey');
  const species = mkDoc({ dupes: 'species' });
  snap(species, [mon(), pidgey()], { rd });
  snap(species, [mon(), pidgey(), mon({ key: 'k3', species: 17, metLocation: 178 })], { rd });
  assert.equal(species.get('enc:route-30:p1').species, 17);
  assert.deepEqual(R.dupeOf(species, SOLO, rd, 16, 'p1', 'route-31'), { area: 'route-29', slot: 'p1' });
});

test('markMissed spends an area once; openAreas lists the rest', () => {
  const d = mkDoc();
  const before = R.openAreas(d, SOLO, 'p1').length;
  assert.ok(before > 10);
  assert.equal(R.markMissed(d, SOLO, 'route-30', 'p1', { species: 19, by: 'p1' }), true);
  assert.equal(R.markMissed(d, SOLO, 'route-30', 'p1', { species: 16 }), false, 'already spent');
  assert.deepEqual(d.get('enc:route-30:p1').outcome, 'missed');
  assert.equal(d.get('enc:route-30:p1').species, 19);
  assert.equal(R.pairState(d, 'route-30', SOLO).state, 'failed');
  assert.ok(feedTexts(d).some((x) => x.includes('got away – the area is spent')));
  assert.equal(R.feedList(d).find((f) => f.type === 'missed').species, 19);
  const open = R.openAreas(d, SOLO, 'p1');
  assert.equal(open.length, before - 1);
  assert.ok(!open.some((a) => a.key === 'route-30'));
  assert.ok(open.every((a) => a.kind === 'area'));
});

test('runStats: encounters, deaths per boss segment, deadliest opponent, longest survivor', () => {
  const d = mkDoc({ blackout: 'off' });
  assert.deepEqual(R.runStats(d, SOLO).catchRate, null);
  snap(d, [mon(), pidgey(), mon({ key: 'k3', species: 41, metLocation: 178, level: 4, metLevel: 4 })]);
  R.markMissed(d, SOLO, 'route-31', 'p1', { species: 10 });
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: 20 }), pidgey({ level: 9 }), mon({ key: 'k3', species: 41, metLocation: 178, level: 6 })], playTime: { h: 2, m: 5 } });
  // Zubat and Pidgey fall to the same Geodude, the starter keeps going
  const foe = { kind: 'trainer', enemy: { species: 74, level: 10 } };
  snap(d, [mon({ level: 20 }), pidgey({ level: 9 }), mon({ key: 'k3', species: 41, metLocation: 178, level: 6, hp: 0 })], { battle: foe });
  snap(d, [mon({ level: 20 }), pidgey({ level: 9, hp: 0 })], { battle: foe });
  const st = R.runStats(d, SOLO);
  assert.equal(st.caught, 3);
  assert.equal(st.missed, 1);
  assert.equal(st.dead, 2);
  assert.equal(st.alive, 1);
  assert.equal(st.open, R.openAreas(d, SOLO).length);
  assert.equal(st.catchRate, 0.75);
  assert.equal(st.deathsBySegment.length, 1);
  assert.equal(st.deathsBySegment[0].deaths, 2);
  assert.equal(st.deathsBySegment[0].boss, R.levelCap(d, SOLO, 'p1').boss.key);
  assert.deepEqual(st.deadliest, [{ species: 74, kills: 2 }]);
  assert.deepEqual(st.longestSurvivor, { area: 'starter', species: 152, levels: 15 });
  assert.equal(st.bossesBeaten, 0);
  assert.equal(st.attempt, 3, 'from the "#3" of a restarted run');
  assert.deepEqual(st.playTime, { h: 2, m: 5 });
  assert.equal(R.runStats(mkDoc(), { ...SOLO, name: 'x' }).attempt, 1);
  assert.equal(R.runStats(mkDoc(), SOLO).playTime, null);
});

test('loading an older savestate (fewer badges) does not announce or judge a badge again when it comes back', () => {
  const d = mkDoc({ levelCaps: 'warn' });
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: 8 })], badges: 0 });
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: 8 })], badges: 1 });
  const badgeFeed = () => R.feedList(d).filter((f) => f.type === 'badge').length;
  assert.equal(badgeFeed(), 1);
  // an older state: badge 1 not won yet there – the cap follows the game as it is now
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: 30 })], badges: 0 });
  assert.equal(R.levelCap(d, SOLO, 'p1').boss.key, R.levelCap(mkDoc(), SOLO, 'p1').boss.key);
  // back to the newer state: the same badge again is no news and no rule break
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: 30 })], badges: 1 });
  assert.equal(badgeFeed(), 1);
  assert.equal(Object.keys(d.scan('capbreak:p1:')).length, 0);
  // a really new badge still counts
  R.applySnapshot(d, SOLO, 4, 'p1', { source: 'live', party: [mon({ level: 30 })], badges: 2 });
  assert.equal(badgeFeed(), 2);
  assert.equal(Object.keys(d.scan('capbreak:p1:')).length, 1);
});
