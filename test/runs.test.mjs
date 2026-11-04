// Run list summaries (from the shared doc), deleting a run into the trash folder, and building runs for 1–4 players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-runs-'));
process.env.SLS_DATA_DIR = DATA;
const { summarizeDoc, runSummary, trashRun, listRuns, buildRun, readManifest, checkPack, runPlayers, seedsFor } = await import('../server/lib/build.mjs');
const { restartRequest } = await import('../shared/restart.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const e = (v, t = 1) => ({ v, t, by: 'x' });

test('summarizeDoc counts pairs, status, badges and live timestamps', () => {
  const s = summarizeDoc({
    'player:p1': e({ name: 'Lou' }),
    'enc:r29:p1': e({ outcome: 'caught' }), 'enc:r29:p2': e({ outcome: 'caught' }),
    'enc:r30:p1': e({ outcome: 'caught' }), 'enc:r30:p2': e({ outcome: 'caught' }), 'pair:r30': e({ state: 'dead' }),
    'enc:r31:p1': e({ outcome: 'missed' }), 'enc:r32:p2': e({ outcome: 'caught' }),
    'pair:r33': e({ state: 'alive' }),
    'live:p2': e({ badges: 3, at: 5000 }, 7),
    'run:status': e({ state: 'failed', at: 9, by: 'p1' }, 9),
    'rules': e(null, 99),
  });
  assert.equal(s.alive, 1);
  assert.equal(s.dead, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.caught, 5);
  assert.deepEqual(s.badges, { p1: 0, p2: 3 });
  assert.deepEqual(s.live, { p1: null, p2: 5000 });
  assert.equal(s.status.state, 'failed');
  assert.equal(s.names.p1, 'Lou');
  assert.equal(s.lastPlayed, 5000);
  assert.equal(summarizeDoc({}).status, null);
  assert.equal(summarizeDoc({ 'run:status': e(null) }).status, null); // reopened run
});

test('runSummary reads doc.json and survives a missing / broken doc', () => {
  const dir = join(DATA, 'runs', 'aaaa0001');
  mkdirSync(dir, { recursive: true });
  assert.equal(runSummary('aaaa0001').alive, 0);
  writeFileSync(join(dir, 'doc.json'), '{broken');
  assert.equal(runSummary('aaaa0001').dead, 0);
  writeFileSync(join(dir, 'doc.json'), JSON.stringify({ 'pair:x': e({ state: 'dead' }) }));
  assert.equal(runSummary('aaaa0001').dead, 1);
});

test('trashRun moves the run folder to runs/.trash and refuses unknown runs', () => {
  const dir = join(DATA, 'runs', 'bbbb0002');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id: 'bbbb0002', name: 'x', game: { id: 'x' } }));
  writeFileSync(join(dir, 'doc.json'), '{}');
  assert.ok(listRuns().some((m) => m.id === 'bbbb0002'));
  const target = trashRun('bbbb0002');
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(join(target, 'run.json')));
  assert.ok(readdirSync(join(DATA, 'runs', '.trash'))[0].startsWith('bbbb0002-'));
  assert.ok(!listRuns().some((m) => m.id === 'bbbb0002'));
  assert.throws(() => trashRun('bbbb0002'), /nicht gefunden/);
  assert.throws(() => trashRun('../etc'), /Ungültige/);
});

test('summarizeDoc: a group of 3 is alive only once all three caught; live and badges for every slot', () => {
  const s = summarizeDoc({
    'enc:r29:p1': e({ outcome: 'caught' }), 'enc:r29:p2': e({ outcome: 'caught' }), 'enc:r29:p3': e({ outcome: 'caught' }),
    'enc:r30:p1': e({ outcome: 'caught' }), 'enc:r30:p2': e({ outcome: 'caught' }),
    'enc:r31:p3': e({ outcome: 'missed' }),
    'live:p3': e({ badges: 2, at: 8000 }), 'player:p3': e({ name: 'Kim' }),
  }, ['p1', 'p2', 'p3']);
  assert.equal(s.alive, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.caught, 5);
  assert.deepEqual(s.badges, { p1: 0, p2: 0, p3: 2 });
  assert.deepEqual(s.live, { p1: null, p2: null, p3: 8000 });
  assert.equal(s.names.p3, 'Kim');
  assert.equal(s.lastPlayed, 8000);
  // solo: one catch is one living Pokémon
  const solo = summarizeDoc({ 'enc:r29:p1': e({ outcome: 'caught' }), 'live:p1': e({ badges: 1, at: 3 }) }, ['p1']);
  assert.equal(solo.alive, 1);
  assert.deepEqual(solo.badges, { p1: 1 });
});

test('runPlayers / seedsFor: 1–4 contiguous players, a mode, one seed per slot', () => {
  assert.deepEqual(runPlayers({}).slots, ['p1', 'p2'], 'older requests: a pair');
  assert.deepEqual(runPlayers({ players: { p1: { name: 'A' } } }).players, { p1: { name: 'A' }, p2: { name: 'Spieler 2' } });
  assert.deepEqual(runPlayers({ players: { p1: {}, p2: {}, p3: {}, p4: {} } }).slots, ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(runPlayers({ mode: 'nuzlocke', players: { p1: { name: 'A' }, p2: { name: 'B' } } }), { mode: 'nuzlocke', slots: ['p1'], players: { p1: { name: 'A' } } });
  assert.equal(runPlayers({}, { mode: 'nuzlocke', players: { p1: { name: 'A' } } }).mode, 'nuzlocke', 'a rebuild keeps the mode');
  assert.throws(() => runPlayers({ players: { p1: {}, p3: {} } }), /lückenlos/);
  assert.throws(() => runPlayers({ mode: 'battle-royale' }), /Modus/);
  assert.deepEqual(seedsFor(['p1', 'p2', 'p3'], { p1: '1', p2: '2', p3: '3', p4: '4' }, false), { p1: '1', p2: '2', p3: '3' });
  assert.deepEqual(seedsFor(['p1', 'p2', 'p3'], { p1: '7' }, true), { p1: '7', p2: '7', p3: '7' });
});

// A tiny fake Game Boy ROM in the library: building without the randomizer only copies it per player.
const LIB = join(DATA, 'Library');
mkdirSync(LIB, { recursive: true });
const ROM = join(LIB, 'Fake.gb');
writeFileSync(ROM, Buffer.alloc(0x8000, 7));

test('build a 3-player run: one ROM per slot, seeds per slot, the pack carries mode and players', async () => {
  const m = await buildRun({
    romId: ROM, randomize: false, config: {}, seeds: { p1: '11', p2: '22', p3: '33' },
    players: { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Kim' } },
  });
  assert.equal(m.mode, 'soullink');
  assert.deepEqual(Object.keys(m.players), ['p1', 'p2', 'p3']);
  assert.equal(m.name, 'Lou, Robin & Kim');
  assert.deepEqual(Object.keys(m.outputs).sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(m.randomizer.seeds, { p1: '11', p2: '22', p3: '33' });
  for (const s of ['p1', 'p2', 'p3']) assert.ok(existsSync(join(DATA, 'runs', m.id, m.outputs[s].rom)));
  const pack = JSON.parse(readFileSync(join(DATA, 'runs', m.id, 'run-pack.soullink.json'), 'utf8'));
  assert.equal(pack.mode, 'soullink');
  assert.deepEqual(Object.keys(pack.outputs).sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(Object.keys(checkPack(pack).players), ['p1', 'p2', 'p3']);
  assert.equal(runSummary(m.id).live.p3, null, 'the summary lists every slot of the run');
  assert.ok('p3' in runSummary(m.id).badges);

  // the third player imports the pack and builds only their own ROM: it matches the host's byte for byte
  const again = await buildRun({
    identity: { id: m.id, room: m.room, secret: m.secret }, romId: ROM, randomize: false, config: {},
    players: pack.players, seeds: pack.randomizer.seeds, buildFor: ['p3'], expectedOutputs: pack.outputs,
  });
  assert.equal(again.outputs.p3.matchesFriend, true);
  assert.equal(again.outputs.p1.matchesFriend, undefined, 'p1 was not rebuilt');
  assert.equal(readManifest(m.id).mode, 'soullink');
});

test('build a solo Nuzlocke: p1 only, one ROM, mode in manifest and pack', async () => {
  const m = await buildRun({
    romId: ROM, randomize: false, config: {}, mode: 'nuzlocke', seeds: { p1: '5', p2: '6' },
    players: { p1: { name: 'Lou' }, p2: { name: 'Ghost' } }, buildFor: ['p1', 'p2'],
  });
  assert.equal(m.mode, 'nuzlocke');
  assert.deepEqual(m.players, { p1: { name: 'Lou' } });
  assert.deepEqual(Object.keys(m.outputs), ['p1']);
  assert.deepEqual(m.randomizer.seeds, { p1: '5' });
  assert.equal(m.name, 'Lou – Nuzlocke');
  const pack = JSON.parse(readFileSync(join(DATA, 'runs', m.id, 'run-pack.soullink.json'), 'utf8'));
  assert.equal(pack.mode, 'nuzlocke');
  const checked = checkPack(pack);
  assert.equal(checked.mode, 'nuzlocke');
  assert.deepEqual(Object.keys(checked.players), ['p1']);
  assert.deepEqual(Object.keys(runSummary(m.id).badges), ['p1']);
  assert.throws(() => checkPack({ ...pack, mode: 'x' }), /mode/);
  // a request to build a slot the run doesn't have is refused
  await assert.rejects(buildRun({ romId: ROM, randomize: false, config: {}, mode: 'nuzlocke', players: { p1: {} }, buildFor: ['p2'] }), /Kein gültiger Spieler/);
});

test('a two-player build without a mode works as before (equal names get the slot in the file name)', async () => {
  const m = await buildRun({ romId: ROM, randomize: false, config: {}, players: { p1: { name: 'Sam' }, p2: { name: 'Sam' } }, buildFor: ['p1', 'p2'] });
  assert.equal(m.name, 'Sam & Sam');
  assert.deepEqual(Object.keys(m.players), ['p1', 'p2']);
  assert.notEqual(m.outputs.p1.rom, m.outputs.p2.rom);
  assert.ok(m.outputs.p1.rom.includes('(P1)'));
  const pack = JSON.parse(readFileSync(join(DATA, 'runs', m.id, 'run-pack.soullink.json'), 'utf8'));
  const { mode, ...legacy } = pack; // a pack from before modes existed
  assert.equal(mode, 'soullink');
  assert.equal(checkPack(legacy).mode, undefined);
  assert.deepEqual(Object.keys(checkPack(legacy).players), ['p1', 'p2']);
});

test('a new attempt keeps all four players and the mode, with a new seed for every slot', () => {
  const old = {
    id: 'abcd1234', name: 'Lou, Robin, Kim & Alex', mode: 'soullink',
    players: { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Kim' }, p4: { name: 'Alex' } },
    base: { crc: 'AAAA0000' }, game: { id: 'pokemon-x' },
    randomizer: { enabled: true, values: {}, seeds: { p1: '1', p2: '2', p3: '3', p4: '4' }, sharedSeed: false },
    outputs: { p1: {}, p2: {}, p3: {}, p4: {} },
  };
  const library = { roms: [{ id: 'rom', crc: 'aaaa0000', gameId: 'pokemon-x' }], patches: [] };
  let n = 0;
  const seed = () => String(100 + ++n);
  const body = restartRequest(old, { library, mySlot: 'p3', seed });
  assert.equal(body.mode, 'soullink');
  assert.deepEqual(body.players, old.players);
  assert.deepEqual(Object.keys(body.seeds), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(new Set(Object.values(body.seeds)).size, 4);
  assert.ok(Object.values(body.seeds).every((s) => !Object.values(old.randomizer.seeds).includes(s)));
  assert.deepEqual(body.buildFor, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(body.name, 'Lou, Robin, Kim & Alex');
  const shared = restartRequest({ ...old, randomizer: { ...old.randomizer, sharedSeed: true }, outputs: {} }, { library, mySlot: 'p4', seed });
  assert.equal(new Set(Object.values(shared.seeds)).size, 1);
  assert.deepEqual(shared.buildFor, ['p4']);
  const solo = restartRequest({ ...old, mode: 'nuzlocke', name: '', players: { p1: { name: 'Lou' } }, outputs: { p1: {} } }, { library, seed });
  assert.equal(solo.mode, 'nuzlocke');
  assert.deepEqual(Object.keys(solo.seeds), ['p1']);
  assert.deepEqual(solo.players, { p1: { name: 'Lou' } });
  assert.deepEqual(solo.buildFor, ['p1']);
  assert.equal(solo.name, 'Lou – Nuzlocke');
});
