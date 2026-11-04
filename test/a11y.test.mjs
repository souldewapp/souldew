// Arrow-key movement through the app's radio groups and tab lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rovingIndex } from '../web/lib/a11y.mjs';

test('arrow keys move through a group and wrap around', () => {
  assert.equal(rovingIndex('ArrowRight', 0, 4), 1);
  assert.equal(rovingIndex('ArrowDown', 3, 4), 0);
  assert.equal(rovingIndex('ArrowLeft', 0, 4), 3);
  assert.equal(rovingIndex('ArrowUp', 2, 4), 1);
  assert.equal(rovingIndex('Home', 2, 4), 0);
  assert.equal(rovingIndex('End', 0, 4), 3);
});

test('other keys and empty groups do nothing', () => {
  assert.equal(rovingIndex('Enter', 1, 4), -1);
  assert.equal(rovingIndex(' ', 1, 4), -1);
  assert.equal(rovingIndex('ArrowRight', 0, 0), -1);
});
