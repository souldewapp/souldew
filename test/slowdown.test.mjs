import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlowWatch, slowTips, SLOW_WINDOWS } from '../web/lib/slowdown.mjs';

test('a lasting slowdown at normal speed is reported once – the half-speed Platinum of issue #4', () => {
  const w = new SlowWatch();
  const hits = [];
  // the player's diagnostics: ≈31 fps window after window
  for (let i = 0; i < 12; i++) hits.push(w.add(31));
  assert.equal(hits.filter(Boolean).length, 1, 'only once');
  assert.equal(hits.indexOf(true), SLOW_WINDOWS - 1, 'after SLOW_WINDOWS windows in a row');
  assert.equal(w.reached(), 0.52);
});

test('short dips, full speed and nonsense don’t count', () => {
  const w = new SlowWatch();
  // a heavy scene for a few seconds, then full speed again – the streak starts over
  for (let k = 0; k < 5; k++) {
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) assert.equal(w.add(40), false);
    assert.equal(w.add(59.9), false);
  }
  assert.equal(w.reached(), null);
  // 52 of 60 is still fine (above 85 %)
  for (let i = 0; i < 20; i++) assert.equal(w.add(52), false);
  for (const x of [NaN, -1, Infinity, undefined]) assert.equal(w.add(x), false);
  // reset() (paused, fast-forward) forgets the streak
  for (let i = 0; i < SLOW_WINDOWS - 1; i++) w.add(30);
  w.reset();
  assert.equal(w.add(30), false);
});

test('tips: the melonDS app for DS games, the graphics backend where there is a choice, power always', () => {
  assert.deepEqual(slowTips({ system: 'nds', backends: ['auto', 'd3d11', 'vulkan', 'gl'] }), ['external', 'graphics', 'power']);
  assert.deepEqual(slowTips({ system: 'nds', backends: ['auto'] }), ['external', 'power']); // macOS
  assert.deepEqual(slowTips({ system: 'gba', backends: ['auto', 'gl', 'vulkan'] }), ['graphics', 'power']);
  assert.deepEqual(slowTips({ system: 'gb' }), ['power']);
});
