import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSample, typicalReach, offeredSteps, beyondReach, KEEP, MIN_SAMPLES } from '../web/lib/reach.mjs';

const MAX = Infinity;
const many = (n, set, reached, list = []) => {
  for (let i = 0; i < n; i++) list = addSample(list, set, reached);
  return list;
};

test('addSample keeps the last KEEP windows, stores "Max" as 0 and ignores 1× and nonsense', () => {
  let l = addSample([], 4, 1.567);
  assert.deepEqual(l, [[4, 1.57]]);
  l = addSample(l, MAX, 1.6);
  assert.deepEqual(l.at(-1), [0, 1.6]);
  assert.equal(JSON.stringify(l), '[[4,1.57],[0,1.6]]'); // survives localStorage (JSON has no Infinity)
  assert.equal(addSample(l, 1, 1).length, 2);
  assert.equal(addSample(l, 4, NaN).length, 2);
  assert.equal(addSample(l, 4, 0).length, 2);
  assert.equal(addSample(l, 4, Infinity).length, 2);
  assert.deepEqual(addSample(null, 2, 2), [[2, 2]]);
  assert.deepEqual(addSample([['x'], [2, 2], null], 3, 3), [[2, 2], [3, 3]]); // a broken stored list doesn't stick
  assert.equal(many(KEEP + 10, 4, 1.5).length, KEEP);
});

test('typicalReach: HeartGold in town on an M1 (every step ends at ~1.6×)', () => {
  let l = many(4, 2, 1.48);
  l = many(4, 3, 1.51, l);
  l = many(4, 4, 1.58, l);
  assert.equal(typicalReach(l), 1.5);
  assert.equal(typicalReach(many(MIN_SAMPLES, MAX, 1.6)), 1.6); // "Max" always counts: it is the computer's limit
});

test('typicalReach: nothing to report with too few windows or when the steps mostly hold', () => {
  assert.equal(typicalReach([]), null);
  assert.equal(typicalReach(undefined), null);
  assert.equal(typicalReach(many(MIN_SAMPLES - 1, 4, 1.5)), null);
  assert.equal(typicalReach(many(10, 4, 3.98)), null); // held (≥ 92 % of the step)
  // a GBA game that holds 4× nearly always, with a heavy moment now and then
  assert.equal(typicalReach(many(3, 4, 2.5, many(10, 4, 4))), null);
});

test('typicalReach: a game that is light in places and heavy in others follows the bulk of the windows', () => {
  // HeartGold: the 2D menus and the opening hold 4×, the 3D towns get ~1.6×
  const l = many(12, 4, 1.6, many(5, 4, 4));
  assert.equal(typicalReach(l), 1.6);
  // the median, so one odd window (a loading screen) doesn't move it
  assert.equal(typicalReach(addSample(many(9, 4, 2.4), 4, 0.3)), 2.4);
});

test('offeredSteps: only the steps this computer reaches, then the highest one', () => {
  const S = [1, 2, 3, 4];
  assert.deepEqual(offeredSteps(S, null), S);
  assert.deepEqual(offeredSteps(S, 1.6), [1, 4]);
  assert.deepEqual(offeredSteps(S, 1.9), [1, 2, 4]); // 2× is within the measuring wobble of 1.9×
  assert.deepEqual(offeredSteps(S, 2.6), [1, 2, 4]);
  assert.deepEqual(offeredSteps(S, 3.2), [1, 2, 3, 4]);
  assert.deepEqual(offeredSteps(S, 9.6), S);
  assert.deepEqual(offeredSteps([...S, MAX], 1.6), [1, 4, MAX]); // "Max" (Settings) stays
});

test('beyondReach: the step label tells when the computer usually falls short', () => {
  assert.equal(beyondReach(4, 1.6), true);
  assert.equal(beyondReach(MAX, 1.6), true);
  assert.equal(beyondReach(2, 1.9), false);
  assert.equal(beyondReach(4, null), false);
  assert.equal(beyondReach(1, 0.5), false);
});
