// The coffee button's Pokémon moments: timing, variety and when they must stay away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COFFEE_FX, COFFEE_VARIANTS, nextDelay, pickVariant, variantSprite, fxBlocked } from '../web/lib/coffeefx.mjs';

test('coffee moments: every 3–8 minutes', () => {
  assert.equal(nextDelay(() => 0), 3 * 60 * 1000);
  assert.equal(nextDelay(() => 0.999999), 8 * 60 * 1000);
  for (let i = 0; i < 200; i++) {
    const d = nextDelay();
    assert.ok(d >= COFFEE_FX.MIN_MS && d <= COFFEE_FX.MAX_MS, String(d));
  }
});

test('coffee moments: several variants, never the same twice in a row, each 2–4 s with a real sprite', () => {
  const ids = Object.keys(COFFEE_VARIANTS);
  assert.ok(ids.length >= 3);
  for (const id of ids) {
    for (const r of [0, 0.3, 0.6, 0.9999]) assert.notEqual(pickVariant(id, () => r), id);
    const v = COFFEE_VARIANTS[id];
    assert.ok(v.ms >= 2000 && v.ms <= 4000, `${id}: ${v.ms} ms`);
    assert.match(variantSprite(id), /^\/sprites\/gen3\/\d+\.png$/);
  }
  assert.ok(ids.includes(pickVariant(null, () => 0.5)));
});

test('coffee moments: never during play, with a dialog, in the background, with reduced motion, after a click or too often', () => {
  assert.equal(fxBlocked({}), null);
  assert.equal(fxBlocked({ busy: true }), 'busy');
  assert.equal(fxBlocked({ hidden: true }), 'hidden');
  assert.equal(fxBlocked({ dialogOpen: true }), 'dialog');
  assert.equal(fxBlocked({ reducedMotion: true }), 'reducedMotion');
  assert.equal(fxBlocked({ clicked: true }), 'clicked');
  assert.equal(fxBlocked({ shown: COFFEE_FX.MAX_PER_SESSION }), 'enough');
  assert.equal(fxBlocked({ shown: COFFEE_FX.MAX_PER_SESSION - 1 }), null);
});

test('coffee moments: pixel-crisp, quiet for reduced motion, no clicks, no sound', () => {
  const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.cfx img \{[^}]*image-rendering: pixelated/);
  assert.match(css, /\.cfx \{[^}]*pointer-events: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.cfx \{ display: none; \}/);
  const view = readFileSync(new URL('../web/views/coffee.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(view, /lib\/sound\.mjs|new Audio|AudioContext/);
  assert.match(view, /aria-hidden="true"/);
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /fxBusy\.current = playing \|\| fs \|\| boot \|\| showOnboarding/);
});
