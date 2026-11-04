// Live tracking & SoulLink rule logic: snapshots → encounters / deaths / badges, battle readers on synthetic RAM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { readLiveParty, readLiveBattle, withBattleHp, findEntry, LiveTables } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { levelCapFor } from '../shared/routes.mjs';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const TABLE = L('addresses.json');
const T = new LiveTables({ gen4: L('gen4.json') });
const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };

function mkDoc() {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  return d;
}
const mon = (o = {}) => ({ key: 'k1', species: 152, nickname: 'CHIKO', level: 5, hp: 20, maxHp: 20, metLocation: 126, ...o });
const feedTexts = (d) => R.feedList(d).map((f) => f.text);

// ---------------------------------------------------------------------------
// applySnapshot

test('a shiny starter in the inbox does not hand the starter slot to the next catch', () => {
  const d = mkDoc();
  const res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ shiny: true }), mon({ key: 'k2', species: 16, metLocation: 177 })] });
  assert.equal(d.get('enc:starter:p1', null), null);
  assert.equal(d.get('enc:route-29:p1').species, 16);
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.guess, i.reason]), [['k1', 'starter', 'shiny']]);
});

test('with the shiny clause off a shiny is an ordinary encounter', () => {
  const d = mkDoc();
  d.set('rules', { shinyClause: false });
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177, shiny: true })] });
  assert.equal(d.get('enc:route-29:p1').species, 16);
});

test('an empty live party (title screen / reset) neither wipes the team nor re-announces badges', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], badges: 3 });
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [], badges: 0 });
  assert.deepEqual(d.get('party:p1'), ['starter']);
  assert.equal(d.get('live:p1').badges, 3);
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], badges: 3 });
  assert.equal(feedTexts(d).filter((x) => x.includes('badge')).length, 0);
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], badges: 4 });
  assert.equal(feedTexts(d).filter((x) => x.includes('badge')).length, 1);
});

test('a mon in the party and in the (cached) PC data is one inbox entry, not two', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], boxes: [] });
  const w = mon({ key: 'k2', species: 16, metLocation: 177, shiny: true });
  const res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), w], boxes: [{ ...w, level: null, hp: null, maxHp: null }] });
  assert.equal(res.inbox.filter((i) => i.mon.key === 'k2').length, 1);
});

test('a tracked mon missing from live data is only reported once it stays missing', () => {
  const d = mkDoc();
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 })], boxes: [] });
    // k2 deposited: the party no longer has it, the cached PC data doesn't have it yet
    let res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], boxes: [] });
    assert.equal(res.alerts.filter((a) => a.type === 'missing').length, 0);
    now += 3000;
    res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], boxes: [{ ...mon({ key: 'k2', species: 16 }), level: null }] });
    assert.equal(res.alerts.length, 0);
    // really gone for a while → reported
    R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], boxes: [] });
    now += 20000;
    res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()], boxes: [] });
    assert.deepEqual(res.alerts.map((a) => [a.type, a.area]), [['missing', 'route-29']]);
    // a save file is one consistent picture → right away
    const d2 = mkDoc();
    R.applySnapshot(d2, HG, 4, 'p1', { source: 'save', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 })], boxes: [] });
    res = R.applySnapshot(d2, HG, 4, 'p1', { source: 'save', party: [mon()], boxes: [] });
    assert.equal(res.alerts.filter((a) => a.type === 'missing').length, 1);
  } finally {
    Date.now = realNow;
  }
});

test('dupes clause: an evolution-line dupe is not auto-entered as the area encounter', () => {
  const rd = { familyRoot: (id) => ({ 17: 16, 18: 16 })[id] || id, types: () => [] };
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 })] }, { rd });
  const res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 }), mon({ key: 'k3', species: 17, metLocation: 178 })] }, { rd });
  assert.equal(d.get('enc:route-30:p1', null), null);
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason, i.dupeArea]), [['k3', 'dupe', 'route-29']]);
  // two of a line in one pass (first look at a running game): only the first is entered
  const d2 = mkDoc();
  R.applySnapshot(d2, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 }), mon({ key: 'k3', species: 17, metLocation: 178 })] }, { rd });
  assert.equal(d2.get('enc:route-30:p1', null), null);
  // without run data (still loading) nothing breaks
  assert.doesNotThrow(() => R.applySnapshot(mkDoc(), HG, 4, 'p1', { source: 'live', party: [mon()] }));
});

test('a save slot with a bad checksum (Bad Egg) is not offered as a catch', () => {
  const save = { party: [{ ...mon(), heldItem: 0, checksumOk: true }], boxes: [{ ...mon({ key: 'junk', species: 4711 }), checksumOk: false }], badges: { count: 0 }, trainer: { name: 'A' } };
  const snap = R.snapshotFromSave(save);
  assert.deepEqual(snap.boxes, []);
  assert.equal(snap.party.length, 1);
});

test('checks() does not crash while the run data is still loading', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()] });
  assert.doesNotThrow(() => R.checks(d, HG, null));
});

test('HGSS level cap follows the Kanto badges: E4 implied after badge 9, Blue at 15, Red after 16', () => {
  assert.equal(levelCapFor(8).boss.key, 'will');
  assert.equal(levelCapFor(9).boss.key, 'kanto-leaders');
  assert.equal(levelCapFor(14).boss.key, 'kanto-leaders');
  assert.equal(levelCapFor(15).boss.key, 'blue');
  assert.equal(levelCapFor(16).boss.key, 'red');
  assert.equal(levelCapFor(16, {}, true).cap, 88);
  assert.equal(levelCapFor(8, { will: 1, koga: 1, bruno: 1, karen: 1, lance: 1 }).boss.key, 'kanto-leaders');
});

// ---------------------------------------------------------------------------
// Gen 2 RAM

function gbRam() {
  const m = new Uint8Array(0x10000);
  return { m, read: (a, n) => m.slice(a, a + n) };
}
const put16be = (m, a, v) => { m[a] = v >> 8; m[a + 1] = v & 0xff; };
const SILVER = TABLE.games.find((g) => g.id === 'silver_us');

test('Gen 2: no badge count from the title screen (party count 0)', () => {
  const { m, read } = gbRam();
  m[0xda22] = 0;
  m[0xd57c] = 0xff;
  m[0xd57d] = 0x01;
  const r = readLiveParty(SILVER, read, T);
  assert.deepEqual(r.party, []);
  assert.equal(r.badges, undefined);
});

test('Gen 2: the previous battle\'s enemy is not shown (or flashed) during the next battle intro', () => {
  const { m, read } = gbRam();
  const state = {};
  // overworld after a battle against a shiny Suicune
  m[0xd116] = 0;
  m[0xd0ef] = 245; m[0xd0fc] = 40; put16be(m, 0xd0ff, 0); put16be(m, 0xd101, 150); put16be(m, 0xd0f5, 0xaaaa);
  assert.equal(readLiveBattle(SILVER, read, T, state), null);
  // new wild battle starts – wEnemyMon not loaded yet
  m[0xd116] = 1;
  assert.equal(readLiveBattle(SILVER, read, T, state).enemy, null);
  // now loaded
  m[0xd0ef] = 16; m[0xd0fc] = 3; put16be(m, 0xd0ff, 12); put16be(m, 0xd101, 12); put16be(m, 0xd0f5, 0x1234);
  assert.deepEqual(readLiveBattle(SILVER, read, T, state).enemy, { species: 16, level: 3, hp: 12, maxHp: 12, shiny: false });
});

test('Gen 2: a stale fainted wBattleMon is not folded onto the mon now at that index', () => {
  const { m, read } = gbRam();
  const state = {};
  const party = [{ key: 'a', species: 152, level: 7, hp: 20, maxHp: 20 }, { key: 'b', species: 16, level: 7, hp: 20, maxHp: 20 }];
  // overworld: wBattleMon still holds the mon that fainted at index 1 last battle
  m[0xd116] = 0;
  m[0xcfc6] = 1; m[0xcb0c] = 19; m[0xcb19] = 7; put16be(m, 0xcb1c, 0); put16be(m, 0xcb1e, 20);
  m[0xd0ef] = 19; m[0xd0fc] = 3; put16be(m, 0xd0ff, 10); put16be(m, 0xd101, 10);
  readLiveBattle(SILVER, read, T, state, party);
  m[0xd116] = 1;
  m[0xd0ef] = 16; put16be(m, 0xd0ff, 11); put16be(m, 0xd101, 11); // the new enemy is already loaded
  const fight = readLiveBattle(SILVER, read, T, state, party);
  assert.equal(fight.active, null);
  assert.deepEqual(withBattleHp(party, fight).map((x) => x.hp), [20, 20]);
  // the lead is sent out and takes a hit → folded
  m[0xcfc6] = 0; m[0xcb0c] = 152; put16be(m, 0xcb1c, 0);
  assert.deepEqual(withBattleHp(party, readLiveBattle(SILVER, read, T, state, party)).map((x) => x.hp), [0, 20]);
  // a battle mon with another level isn't that party mon: the slot stays, its HP isn't folded
  m[0xcb19] = 9;
  const other = readLiveBattle(SILVER, read, T, state, party).active;
  assert.deepEqual(other, { index: 0 });
  assert.deepEqual(withBattleHp(party, { active: other }).map((x) => x.hp), [20, 20]);
});

// ---------------------------------------------------------------------------
// HeartGold RAM (4 MB main RAM)

const HGE = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
const BASE = 0x0227c218;
const CORE = BASE + 0xa0;
function dsRam() {
  const m = new Uint8Array(0x400000);
  const w = (addr, bytes) => m.set(bytes, addr - 0x02000000);
  w(0x02111880, [BASE & 0xff, (BASE >> 8) & 0xff, (BASE >> 16) & 0xff, BASE >>> 24]);
  const read = (addr, len) => (addr >= 0x02000000 && addr + len <= 0x02400000 ? m.slice(addr - 0x02000000, addr - 0x02000000 + len) : null);
  const flag = (v) => w(0x02246f48, [v & 0xff, v >> 8]);
  return { m, w, read, flag };
}
function pk4({ pid, species, tid = 4242, level = 10, hp = 20, maxHp = 20, met = 177, size = 236 }) {
  const d = new Uint8Array(size);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0c, tid, true);
  dv.setUint16(0x46, met, true);
  if (size > 136) {
    d[0x8c] = level;
    dv.setUint16(0x8e, hp, true);
    dv.setUint16(0x90, maxHp, true);
  }
  return encryptPK4(d);
}
const core = (mons) => [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...pk4(x)])];

test('HGSS: encrypted empty PC slots count as empty, so live PC data is not discarded', () => {
  const { w, read } = dsRam();
  w(CORE, core([{ pid: 0x11111111, species: 152 }]));
  const storage = BASE + 0x10 + 0xf700;
  const empty = encryptPK4(new Uint8Array(136));
  for (let b = 0; b < 18; b++) for (let s = 0; s < 30; s++) w(storage + b * 0x1000 + s * 136, empty);
  w(storage, pk4({ pid: 0x22222222, species: 16, size: 136 }));
  const r = readLiveParty(HGE, read, T, {});
  assert.deepEqual(r.boxes.map((x) => x.species), [16]);
});

test('HGSS: once the pointer worked, an empty party (soft reset) is not replaced by a scanned leftover', () => {
  const { w, read } = dsRam();
  const state = {};
  w(CORE, core([{ pid: 0x11111111, species: 152 }]));
  assert.equal(readLiveParty(HGE, read, T, state).party[0].species, 152);
  w(CORE + 4, [0, 0, 0, 0]); // title screen: no party
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 245, tid: 1 }])); // the last opponent's copy, still in RAM
  assert.equal(readLiveParty(HGE, read, T, state), null);
});

function poll(read, state, n = 1) {
  let fight = null;
  let party = null;
  for (let i = 0; i < n; i++) {
    party = readLiveParty(HGE, read, T, state)?.party;
    fight = readLiveBattle(HGE, read, T, state, party);
  }
  return { fight, party };
}

test('HGSS: a leftover opponent copy from an earlier battle is not the new opponent', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  w(CORE, core([{ pid: 0x11111111, species: 152 }]));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 245, tid: 1, level: 40, hp: 30, maxHp: 150 }]));
  flag(0x2100);
  assert.equal(poll(read, state, 3).fight.enemy.species, 245);
  flag(0x2800);
  assert.equal(poll(read, state).fight, null);
  // next battle: only the old copy is there so far → nothing (no Suicune flash)
  flag(0x2100);
  assert.equal(poll(read, state, 3).fight, null);
  // the new opponent's copy appears (above the old one)
  w(0x02310000, core([{ pid: 0xbbbb0001, species: 16, tid: 2, level: 3, hp: 12, maxHp: 12 }]));
  assert.equal(poll(read, state, 5).fight.enemy.species, 16);
});

test('HGSS: a leftover player copy does not hide a faint in the current battle', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }, { pid: 0x11111112, species: 16, hp: 30, maxHp: 30 }];
  w(CORE, core(P));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 19, tid: 1 }]));
  w(0x02320000, core([{ ...P[0], hp: 5 }, P[1]])); // battle 1: the lead got hurt
  flag(0x2100);
  poll(read, state, 3);
  flag(0x2800);
  poll(read, state); // battle over, party healed at the centre (CORE unchanged at full HP)
  // battle 2: the live copy (lower address) shows the lead fainted; the old copy still says 5 HP
  w(0x02310000, core([{ pid: 0xbbbb0001, species: 41, tid: 2 }]));
  w(0x02305000, core([{ ...P[0], hp: 0 }, P[1]]));
  flag(0x2100);
  const { fight, party } = poll(read, state, 3);
  assert.equal(fight.enemy.species, 41);
  assert.deepEqual(withBattleHp(party, fight).map((x) => x.hp), [0, 30]);
});

test('HGSS: after a switch the panel follows the mon that takes the hits, not the lead', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }, { pid: 0x11111112, species: 16, hp: 30, maxHp: 30 }];
  w(CORE, core(P));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 19, tid: 1 }]));
  w(0x02320000, core(P));
  flag(0x2100);
  assert.equal(poll(read, state, 3).fight.active.index, 0); // nothing happened yet → the lead
  w(0x02320000, core([P[0], { ...P[1], hp: 22 }])); // switched to Pidgey, which got hit
  assert.deepEqual(poll(read, state).fight.active, { index: 1, hp: 22, maxHp: 30, status: 0 });
  w(0x02320000, core([P[0], { ...P[1], hp: 0 }])); // Pidgey faints → back to the one still standing
  assert.equal(poll(read, state).fight.active.index, 0);
  flag(0x2800);
  poll(read, state);
  assert.equal(state.activePid, null); // forgotten after the battle
});

test('"a missed encounter costs the whole pair" off: the partner’s catch is no rule violation', () => {
  const d = mkDoc();
  d.set('enc:route-29:p1', { outcome: 'missed' });
  d.set('enc:route-29:p2', { outcome: 'caught', species: 16 });
  d.set('party:p2', ['route-29']);
  const rd = { types: () => ['normal'], familyRoot: (id) => id };
  const failed = (doc) => R.checks(doc, HG, rd).some((c) => c.area === 'route-29' && c.level === 'error');
  assert.equal(failed(d), true);
  d.set('rules', { ...R.rules(d), failKillsPair: false });
  assert.equal(failed(d), false);
});

test('a catch read before the game wrote its met data is not filed under "Mystery Zone"', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()] }); // starter
  // the wild Pokémon is in the party already, place and level still 0
  const res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 148, level: 2, metLocation: 0, metLevel: 0 })] });
  assert.equal(Object.keys(d.scan('area:')).length, 0, 'no Mystery Zone area');
  assert.equal(res.inbox.length, 0);
  // a moment later the met data is there → filed under the real route
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 148, level: 2, metLocation: 177, metLevel: 2 })] });
  assert.equal(d.get('enc:route-29:p1').species, 148);
});

test('hatched eggs and in-game trades are no route encounter – they go to the inbox', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()] });
  const res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(),
    mon({ key: 'egg', species: 175, metLocation: 177, metLevel: 0 }), // hatched on Route 29
    mon({ key: 'trade', species: 21, metLocation: 2001, metLevel: 10 })] }); // in-game trade
  assert.equal(d.get('enc:route-29:p1', null), null, 'the hatch place stays free for a real catch');
  assert.deepEqual(res.inbox.map((i) => [i.mon.key, i.reason]), [['egg', 'egg'], ['trade', 'special']]);
});

test('the whole team down → the run fails once; "play on" waves it off until the next death', () => {
  const d = mkDoc();
  const M = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };
  R.applySnapshot(d, M, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 16, metLocation: 177 })] });
  assert.equal(R.wipedSlot(d), null);
  // the starter falls, Pidgey still stands
  R.applySnapshot(d, M, 4, 'p1', { source: 'live', party: [mon({ hp: 0 }), mon({ key: 'k2', species: 16, metLocation: 177 })] });
  assert.equal(d.get('pair:starter').state, 'dead');
  assert.equal(R.wipedSlot(d), null);
  // Pidgey falls too (an egg in the party doesn't count)
  R.applySnapshot(d, M, 4, 'p1', { source: 'live', party: [mon({ hp: 0 }), mon({ key: 'k2', species: 16, metLocation: 177, hp: 0 }), mon({ key: 'e', species: 175, isEgg: true })] });
  assert.equal(R.wipedSlot(d), 'p1');
  assert.equal(R.failRun(d, M, 'p1'), true);
  assert.equal(d.get('run:status').state, 'failed');
  assert.equal(d.get('run:status').auto, true);
  assert.equal(R.failRun(d, M, 'p1'), false, 'only once');
  assert.ok(feedTexts(d).some((x) => x.includes('Lou')));
  // "mistake – play on": the same wipe doesn't end it again …
  R.resumeRun(d, 'p1');
  assert.equal(d.get('run:status', null), null);
  assert.equal(R.wipedSlot(d), null);
});

test('removing or swapping a catch by hand is logged with who did it', () => {
  const d = mkDoc();
  const M = { ...HG, players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } } };
  R.applySnapshot(d, M, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'k2', species: 246, metLocation: 220 })] });
  const area = Object.keys(d.scan('enc:')).find((k) => k.endsWith(':p1') && !k.startsWith('starter')).slice(0, -3);
  R.setEncounter(d, M, area, 'p1', { outcome: 'caught', species: 244 }, { by: 'p2' });
  R.setEncounter(d, M, area, 'p1', null, { by: 'p1' });
  const edits = R.feedList(d).filter((f) => f.type === 'edit');
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.map((f) => f.editor).sort(), ['p1', 'p2']);
  assert.ok(edits.some((f) => f.text.includes('Robin')) && edits.some((f) => f.text.includes('Lou')));
});

test('a second catch in an area never replaces the first by itself (Larvitar → Entei needed a manual delete)', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon()] }); // starter
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'larvitar', species: 246, metLocation: 220, level: 3 })] });
  const area = Object.keys(d.scan('enc:')).find((k) => k.endsWith(':p1') && !k.startsWith('starter')).slice(0, -3);
  assert.equal(d.get(`enc:${area}:p1`).species, 246);
  // Larvitar released, Entei caught in the same area: Entei goes to the inbox, the area keeps Larvitar
  for (let i = 0; i < 3; i++) {
    const res = R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'entei', species: 244, metLocation: 220, level: 4 })] });
    assert.equal(d.get(`enc:${area}:p1`).species, 246, 'still Larvitar');
    assert.deepEqual(res.inbox.map((x) => [x.mon.species, x.reason]), [[244, 'occupied']]);
  }
  // only removing the entry by hand frees the area – and that is logged now
  R.setEncounter(d, HG, area, 'p1', null, { by: 'p1' });
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon(), mon({ key: 'entei', species: 244, metLocation: 220, level: 4 })] });
  assert.equal(d.get(`enc:${area}:p1`).species, 244);
  assert.ok(R.feedList(d).some((f) => f.type === 'edit'));
});

test('a level outside 1–100 is never stored, and a big jump counts only once the next snapshot agrees', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 8 })] });
  assert.equal(d.get('enc:starter:p1').level, 8);
  // garbage from a torn read (or a partner on an older version): neither the encounter nor the synced team take it
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 172 })] });
  assert.equal(d.get('enc:starter:p1').level, 8);
  assert.equal(d.get('live:p1').party[0].level, 8);
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 0 })] });
  assert.equal(d.get('live:p1').party[0].level, 8);
  // +1 (a level-up) is taken at once
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 9 })] });
  assert.equal(d.get('enc:starter:p1').level, 9);
  // Lv. 9 → 60 in one step: implausible – only when the next snapshot still says 60 (a savestate, a hack)
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 60 })] });
  assert.equal(d.get('enc:starter:p1').level, 9);
  assert.equal(d.get('live:p1').party[0].level, 9);
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 60 })] });
  assert.equal(d.get('enc:starter:p1').level, 60);
  assert.equal(d.get('live:p1').party[0].level, 60);
});

test('HGSS: the active battler comes from the battle mon struct – a switch shows at once, before any hit', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }, { pid: 0x11111112, species: 16, hp: 30, maxHp: 30 }, { pid: 0x11111113, species: 19, hp: 15, maxHp: 15 }];
  w(CORE, core(P));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 19, tid: 1 }]));
  w(0x02320000, core(P));
  // BattleMon of player battler 0 (pokeheartgold include/battle/battle.h): species +0x00, personality +0x68
  const mon0 = BASE + 0x49e7c - 0x68;
  const sendOut = (p) => {
    w(mon0, [p.species & 0xff, p.species >> 8]);
    w(mon0 + 0x68, [p.pid & 0xff, (p.pid >>> 8) & 0xff, (p.pid >>> 16) & 0xff, p.pid >>> 24]);
  };
  sendOut(P[0]);
  flag(0x2100);
  assert.equal(poll(read, state, 3).fight.active.index, 0);
  sendOut(P[2]); // switched to Rattata – nothing hit yet
  assert.deepEqual(poll(read, state).fight.active, { index: 2, hp: 15, maxHp: 15, status: 0 });
  // the lead takes a hit later (a heuristic would jump back to it): still Rattata
  w(0x02320000, core([{ ...P[0], hp: 12 }, P[1], P[2]]));
  assert.equal(poll(read, state).fight.active.index, 2);
  // a PID that isn't ours (the struct being reloaded / something else) is ignored: the last one stays …
  w(mon0 + 0x68, [1, 2, 3, 4]);
  assert.equal(poll(read, state).fight.active.index, 2);
  // … until the HP-change heuristic sees another mon take a hit
  w(0x02320000, core([{ ...P[0], hp: 8 }, P[1], P[2]]));
  assert.equal(poll(read, state).fight.active.index, 0);
});

// The battle's BattleMon array (addresses.json battleMons): battler 0 the player's, 1 the opponent's, 2/3 the
// second ones in a double battle – 0xC0 bytes each.
const BMONS = BASE + 0x49e14;
function bmon({ species, level = 10, hp = 20, maxHp = 20, pid, otId = 4242, status = 0, moves = [33] }) {
  const d = new Uint8Array(0xc0);
  const dv = new DataView(d.buffer);
  dv.setUint16(0, species, true);
  moves.forEach((m, i) => dv.setUint16(0x0c + i * 2, m, true));
  d[0x34] = level;
  dv.setUint32(0x4c, hp, true);
  dv.setUint32(0x50, maxHp, true);
  dv.setUint32(0x68, pid, true);
  dv.setUint32(0x6c, status, true);
  dv.setUint32(0x74, otId, true);
  return d;
}
const sendOutAll = (w, battlers) => battlers.forEach((b, i) => w(BMONS + i * 0xc0, b ? bmon(b) : new Uint8Array(0xc0)));

test('HGSS: the opponent comes from the battle structs, not from a party copy in the heap', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }];
  w(CORE, core(P));
  // the heap holds a trainer's whole party (or an earlier battle's freed copy) – a guess that can be wrong
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 245, tid: 1, level: 40, hp: 150, maxHp: 150 }]));
  flag(0x2100);
  sendOutAll(w, [{ ...P[0], level: 10 }, { species: 300, level: 2, hp: 14, maxHp: 14, pid: 0xbbbb0001 }]);
  const { fight, party } = poll(read, state, 3);
  assert.deepEqual(fight.enemy, { species: 300, level: 2, hp: 14, maxHp: 14, shiny: false, moves: [33] });
  assert.equal(fight.kind, 'wild', 'a wild Pokémon carries the player’s ID');
  assert.deepEqual(fight.active, { index: 0, hp: 20, maxHp: 20, status: 0 });
  // a hit shows at once, on both sides
  sendOutAll(w, [{ ...P[0], hp: 11, status: 8 }, { species: 300, level: 2, hp: 3, maxHp: 14, pid: 0xbbbb0001 }]);
  const next = poll(read, state);
  assert.equal(next.fight.enemy.hp, 3);
  assert.deepEqual(withBattleHp(party, next.fight).map((x) => [x.hp, x.status]), [[11, 8]]);
});

test('HGSS: a trainer battle follows the opponent’s switches and its next Pokémon; doubles show the one standing', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }];
  w(CORE, core(P));
  flag(0x2100);
  sendOutAll(w, [P[0], { species: 16, level: 4, hp: 15, maxHp: 15, pid: 0xc1, otId: 777 }]);
  let f = poll(read, state, 2).fight;
  assert.equal(f.kind, 'trainer');
  assert.equal(f.enemy.species, 16);
  sendOutAll(w, [P[0], { species: 19, level: 5, hp: 18, maxHp: 18, pid: 0xc2, otId: 777 }]); // the next one is sent out
  assert.equal(poll(read, state).fight.enemy.species, 19);
  // double battle: battler 1 fainted, battler 3 still standing
  sendOutAll(w, [P[0], { species: 19, level: 5, hp: 0, maxHp: 18, pid: 0xc2, otId: 777 }, null, { species: 41, level: 6, hp: 20, maxHp: 20, pid: 0xc3, otId: 777 }]);
  f = poll(read, state).fight;
  assert.equal(f.enemy.species, 41);
  assert.equal(f.double, true);
});

test('HGSS: the previous battle’s opponent never shows at the start of the next one; a switch doesn’t blank the panel', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }];
  w(CORE, core(P));
  flag(0x2100);
  sendOutAll(w, [P[0], { species: 245, level: 40, hp: 150, maxHp: 150, pid: 0xdead0001 }]);
  assert.equal(poll(read, state, 2).fight.enemy.species, 245);
  flag(0x2800);
  assert.equal(poll(read, state).fight, null);
  // next battle: the structs still hold Suicune until the game resets them → a battle, no opponent yet
  flag(0x2100);
  let f = poll(read, state).fight;
  assert.equal(f.enemy, null);
  sendOutAll(w, [null, null]); // zeroed while the battle is set up
  assert.equal(poll(read, state).fight.enemy, null);
  sendOutAll(w, [P[0], { species: 245, level: 40, hp: 150, maxHp: 150, pid: 0xdead0001 }]); // same PID again (a rematch): fine now
  assert.equal(poll(read, state).fight.enemy.species, 245);
  // the struct is rewritten for a moment (a switch, a move animation): the panel keeps the opponent
  w(BMONS + 0xc0, new Uint8Array(0xc0));
  f = poll(read, state).fight;
  assert.equal(f.enemy.species, 245);
  // longer than that: no opponent – but never a guess from the heap once the structs have worked
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 16, tid: 1 }]));
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0 + 4000;
    f = poll(read, state, 5).fight;
    assert.equal(f.enemy, null);
  } finally {
    Date.now = realNow;
  }
});

test('HGSS: the active index refers to the save party order even if the battle copy is ordered differently', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }, { pid: 0x11111112, species: 16, hp: 30, maxHp: 30 }];
  w(CORE, core(P));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 19, tid: 1 }]));
  w(0x02320000, core([P[1], P[0]]));
  flag(0x2100);
  poll(read, state, 3);
  w(0x02320000, core([{ ...P[1], hp: 9 }, P[0]])); // Pidgey (save slot 1) is hit
  assert.deepEqual(poll(read, state).fight.active, { index: 1, hp: 9, maxHp: 30, status: 0 });
});

test('while RAM is read live, a save file (older party: last in-game save, or a loaded savestate’s) changes nothing', () => {
  const d = mkDoc();
  R.applySnapshot(d, HG, 4, 'p1', { source: 'live', party: [mon({ level: 14, hp: 31, maxHp: 40, status: 8 })] });
  R.applySnapshot(d, HG, 4, 'p1', { source: 'save', party: [mon({ level: 12, hp: 35, maxHp: 35, status: 0 })], boxes: [] });
  const m = d.get('live:p1').party[0];
  assert.deepEqual([m.level, m.hp, m.maxHp, m.status], [14, 31, 40, 8]);
  assert.equal(d.get('enc:starter:p1').level, 14);
  // no live reads for a while (external emulator, or the game closed): the save file counts again
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0 + 120000;
    R.applySnapshot(d, HG, 4, 'p1', { source: 'save', party: [mon({ level: 15, hp: 44, maxHp: 44 })], boxes: [] });
    assert.equal(d.get('live:p1').party[0].level, 15);
  } finally {
    Date.now = realNow;
  }
});

test('HGSS: the live battle copy read mid-write keeps its last HP – a fainted mon never flashes its old HP again', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 2, maxHp: 21 }];
  w(CORE, core(P)); // the save party: HP from before the battle
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 161, tid: 1, level: 3, hp: 10, maxHp: 15 }]));
  w(0x02305000, core([{ ...P[0], hp: 0 }])); // the battle's live copy: fainted
  flag(0x2100);
  const hpNow = () => { const p = poll(read, state); return withBattleHp(p.party, p.fight)[0].hp; };
  for (let i = 0; i < 6; i++) hpNow();
  assert.equal(hpNow(), 0);
  // the game rewrites the copy (decrypts its battle stats in place): unreadable for a poll or two
  const saved = read(0x02305000 + 8 + 136, 100);
  w(0x02305000 + 8 + 136, saved.map((b, i) => b ^ (i * 37 + 11)));
  assert.equal(hpNow(), 0, 'held, not the save party’s 2 HP');
  assert.equal(hpNow(), 0);
  // … and through a full rescan of the heap (the scan passed the copy while it was unreadable)
  for (let i = 0; i < 4; i++) poll(read, state);
  w(0x02305000 + 8 + 136, saved);
  for (let i = 0; i < 4; i++) assert.equal(hpNow(), 0);
});

test('HGSS: a status condition from the battle shows during the battle, not only after it', () => {
  const { w, read, flag } = dsRam();
  const state = {};
  const P = [{ pid: 0x11111111, species: 152, hp: 20, maxHp: 20 }];
  w(CORE, core(P));
  w(0x02300000, core([{ pid: 0xaaaa0001, species: 13, tid: 1, level: 3, hp: 10, maxHp: 15 }]));
  // poisoned in the battle copy (status word 0x88 lives in the encrypted battle stats; set it on the plain struct)
  const plain = new Uint8Array(236);
  const dv = new DataView(plain.buffer);
  dv.setUint32(0, P[0].pid, true); dv.setUint16(8, 152, true); dv.setUint16(0x0c, 4242, true); dv.setUint16(0x46, 177, true);
  dv.setUint32(0x88, 8, true); plain[0x8c] = 10; dv.setUint16(0x8e, 17, true); dv.setUint16(0x90, 20, true);
  w(0x02305000, [6, 0, 0, 0, 1, 0, 0, 0, ...encryptPK4(plain)]);
  flag(0x2100);
  const p = poll(read, state, 6);
  assert.deepEqual(withBattleHp(p.party, p.fight).map((x) => [x.hp, x.status]), [[17, 8]]);
});
