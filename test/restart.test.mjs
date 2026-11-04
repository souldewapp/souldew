// One-click "Start over": the new run's build request keeps everything but the seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartRequest, numberedName, baseName } from '../shared/restart.mjs';
import { PRESETS } from '../shared/randomizer-options.mjs';

const old = {
  id: 'abcd1234', name: 'Lou & Noa', imported: false,
  players: { p1: { name: 'Lou' }, p2: { name: 'Noa' } },
  base: { crc: 'c180a0e9', name: 'HG.nds' },
  patch: { name: 'Definitive HG.xdelta', sha1: 'aaa', hackId: 'definitive-heartgold' },
  game: { id: 'pokemon-heartgold', system: 'nds', hackId: 'definitive-heartgold' },
  randomizer: { enabled: true, values: PRESETS[1].values, seeds: { p1: '1', p2: '2' }, sharedSeed: false },
  rules: { dupes: 'off' },
  outputs: { p1: { sha1: 'x' }, p2: { sha1: 'y' } },
};
const library = {
  roms: [{ id: 'other', crc: '11111111', gameId: 'pokemon-silver' }, { id: 'hg', crc: 'C180A0E9', gameId: 'pokemon-heartgold' }],
  patches: [{ id: 'p-old', sha1: 'bbb', hackId: 'definitive-heartgold' }, { id: 'p-def', sha1: 'aaa', hackId: 'definitive-heartgold' }],
};
let n = 0;
const seed = () => String(1000 + ++n);

test('restart keeps game, hack, options, seed mode, players, slots and rules – only seeds are new', () => {
  const body = restartRequest(old, { library, runs: [{ name: 'Lou & Noa' }], rules: { dupes: 'both' }, mySlot: 'p1', gameTitle: 'Definitive HG', seed });
  assert.equal(body.romId, 'hg');
  assert.equal(body.patchId, 'p-def', 'the exact patch file (sha1), not just the same hack');
  assert.deepEqual(body.values, old.randomizer.values);
  assert.equal(body.randomize, true);
  assert.equal(body.sharedSeed, false);
  assert.notEqual(body.seeds.p1, body.seeds.p2);
  assert.ok(![old.randomizer.seeds.p1, old.randomizer.seeds.p2].includes(body.seeds.p1));
  assert.deepEqual(body.players, old.players);
  assert.deepEqual(body.buildFor, ['p1', 'p2']);
  assert.equal(body.gameId, 'pokemon-heartgold');
  assert.equal(body.hackId, 'definitive-heartgold');
  assert.equal(body.gameTitle, 'Definitive HG');
  assert.equal(body.name, 'Lou & Noa #2');
  assert.deepEqual(body.rules, { dupes: 'both' }, 'the live doc rules win over the manifest copy');
  assert.equal(body.runId, undefined, 'a new run, never a rebuild of the old one');
});

test('shared seed, rules fallback, slot of the joiner, no randomizer, no patch', () => {
  const shared = restartRequest({ ...old, randomizer: { ...old.randomizer, sharedSeed: true }, outputs: { p2: {} } }, { library, mySlot: 'p2', seed });
  assert.equal(shared.seeds.p1, shared.seeds.p2);
  assert.equal(shared.sharedSeed, true);
  assert.deepEqual(shared.rules, { dupes: 'off' });
  assert.deepEqual(shared.buildFor, ['p2']);
  assert.equal(shared.name, 'Lou & Noa');

  const plain = restartRequest({ ...old, patch: null, game: { id: 'pokemon-heartgold' }, randomizer: { enabled: false, values: {} } }, { library, seed });
  assert.equal(plain.patchId, null);
  assert.equal(plain.randomize, false);
  assert.equal(plain.hackId, null);
});

test('missing game or patch is reported, not silently swapped', () => {
  assert.throws(() => restartRequest(old, { library: { roms: [], patches: [] } }), { code: 'no-rom' });
  assert.throws(() => restartRequest(old, { library: { ...library, patches: [library.patches[0]] } }), { code: 'no-patch' });
});

test('run names count up from the base name', () => {
  assert.equal(baseName('Lou & Noa #3'), 'Lou & Noa');
  assert.equal(numberedName('Lou & Noa', [{ name: 'Lou & Noa' }, { name: 'Lou & Noa #3' }]), 'Lou & Noa #4');
  assert.equal(restartRequest({ ...old, name: 'Lou & Noa #2' }, { library, runs: [{ name: 'Lou & Noa' }, { name: 'Lou & Noa #2' }] }).name, 'Lou & Noa #3');
  assert.equal(numberedName('A (b)', [{ name: 'A (b)' }]), 'A (b) #2');
});
