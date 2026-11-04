import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTONS, RESERVED, PRESETS, bindable, detectLayout, currentLayout, tableLayout, layoutForLang, keyFor, presetMap, activePreset, resolve, keyLabel, ejsControls, defaults }
  from '../web/lib/controls.mjs';

const QWERTY = tableLayout('qwerty');
const QWERTZ = tableLayout('qwertz');
const AZERTY = tableLayout('azerty');
const LAYOUTS = { QWERTY, QWERTZ, AZERTY };
// what the Keyboard Map API would report for a real German keyboard
const realQwertz = { id: 'system', real: true, get: (c) => QWERTZ.get(c) };
const labels = (m, lay) => BUTTONS.map((b) => keyLabel(m[b.id], lay)).join(' ');

test('every preset binds all 12 buttons, distinct, bindable and never on an app shortcut – on every layout', () => {
  for (const p of PRESETS) {
    assert.deepEqual(Object.keys(p.keys).sort(), BUTTONS.map((b) => b.id).sort(), p.id);
    for (const [name, lay] of Object.entries(LAYOUTS)) {
      const m = presetMap(p.id, lay);
      const codes = BUTTONS.map((b) => m[b.id].keyCode);
      assert.equal(new Set(codes).size, codes.length, `${p.id} on ${name}: doubled key`);
      for (const c of codes) {
        assert.ok(bindable(c), `${p.id} on ${name}: ${c} not bindable`);
        assert.ok(!(c in RESERVED), `${p.id} on ${name}: ${c} is ${RESERVED[c]}`);
      }
      // the app's letter shortcuts match on the printed character – none of them may be printed on a preset key
      for (const b of BUTTONS) assert.ok(!/^[fmprt]$/i.test(m[b.id].key), `${p.id} on ${name}: ${b.id} prints ${m[b.id].key}`);
      assert.deepEqual(resolve(m, lay), m, `${p.id} on ${name} survives resolve()`);
    }
  }
});

test('the arrow-key preset is the classic default on QWERTY', () => {
  const m = presetMap('arrows', QWERTY);
  for (const b of BUTTONS) assert.equal(m[b.id].keyCode, b.keyCode, b.id);
  assert.deepEqual(defaults(QWERTY), m);
  assert.deepEqual(ejsControls(null, QWERTY), ejsControls(m, QWERTY));
});

test('WASD means the same physical keys on every layout, printed as the layout prints them', () => {
  const dpad = (lay) => ['up', 'left', 'down', 'right'].map((id) => keyLabel(presetMap('wasd', lay)[id], lay)).join('');
  assert.equal(dpad(QWERTY), 'WASD');
  assert.equal(dpad(QWERTZ), 'WASD');
  assert.equal(dpad(AZERTY), 'ZQSD');
  // keyCode follows the printed letter: on AZERTY "up" is the key printing Z
  assert.equal(presetMap('wasd', AZERTY).up.keyCode, 90);
  assert.equal(presetMap('wasd', AZERTY).left.keyCode, 81);
  assert.equal(presetMap('wasd', AZERTY).up.code, 'KeyW');
});

test('QWERTZ swaps Y and Z, AZERTY moves A/Q/W/Z', () => {
  assert.deepEqual(keyFor('KeyZ', QWERTZ), { keyCode: 89, key: 'y', code: 'KeyZ' });
  assert.deepEqual(keyFor('KeyY', QWERTZ), { keyCode: 90, key: 'z', code: 'KeyY' });
  assert.equal(keyFor('KeyQ', AZERTY).keyCode, 65);
  assert.equal(keyFor('Semicolon', AZERTY).keyCode, 77);
  assert.equal(keyFor('KeyM', AZERTY), null); // prints "," – keyCode not predictable
  assert.equal(keyFor('Digit1', AZERTY).keyCode, 49);
  assert.deepEqual(keyFor('ArrowUp', AZERTY), { keyCode: 38, key: 'ArrowUp', code: 'ArrowUp' });
  assert.equal(keyFor('Space', QWERTY).keyCode, 32);
  // non-Latin layouts (e.g. Russian): browsers report the US letter
  assert.equal(keyFor('KeyF', { real: true, get: () => 'а' }).keyCode, 70);
  assert.equal(labels(presetMap('arrows', QWERTZ), QWERTZ), '↑ ↓ ← → Y X A S Q E Enter V');
  assert.equal(labels(presetMap('arrows', AZERTY), AZERTY), '↑ ↓ ← → W X Q S A E Enter V');
});

test('the fallback layout follows the UI language', () => {
  assert.equal(layoutForLang('de').id, 'qwertz');
  assert.equal(layoutForLang('de-AT').id, 'qwertz');
  assert.equal(layoutForLang('fr').id, 'azerty');
  for (const l of ['en', 'es', 'it', '', null, undefined]) assert.equal(layoutForLang(l).id, 'qwerty');
});

test('active preset or custom', () => {
  assert.equal(activePreset(null, QWERTZ), 'arrows');
  for (const [, lay] of Object.entries(LAYOUTS)) for (const p of PRESETS) assert.equal(activePreset(presetMap(p.id, lay), lay), p.id);
  const m = presetMap('wasd', QWERTY);
  assert.equal(activePreset({ ...m, select: { keyCode: 66, key: 'b', code: 'KeyB' } }, QWERTY), null);
  // an old config without codes that equals the classic default is still recognised
  const old = Object.fromEntries(BUTTONS.map((b) => [b.id, { keyCode: b.keyCode, key: b.key }]));
  assert.equal(activePreset(old, QWERTY), 'arrows');
});

test('old configs (keyCode only) keep their keys; physical codes follow the real layout', () => {
  const old = { a: { keyCode: 75, key: 'k' }, up: { keyCode: 87, key: 'w' } };
  for (const lay of [QWERTY, QWERTZ, realQwertz]) {
    const m = resolve(old, lay);
    assert.equal(m.a.keyCode, 75);
    assert.equal(m.up.keyCode, 87);
  }
  // the arrow preset saved on a US keyboard, later played on a real German keyboard: still the same physical keys
  const saved = presetMap('arrows', QWERTY);
  assert.equal(saved.a.keyCode, 90);
  assert.equal(resolve(saved, realQwertz).a.keyCode, 89);
  assert.equal(keyLabel(saved.a, realQwertz), 'Y');
  // a guessed layout never overrides what was stored (label and keyCode stay consistent)
  assert.equal(resolve(saved, QWERTZ).a.keyCode, 90);
  assert.equal(keyLabel(saved.a, QWERTZ), 'Z');
  // EmulatorJS table carries the live keyCodes
  assert.equal(ejsControls(saved, realQwertz)[0][8].value, 89);
});

test('reserved, unbindable or doubled saved keys fall back to the layout default', () => {
  const m = resolve({ a: { keyCode: 80, key: 'p' }, b: { keyCode: 16, key: 'Shift' }, x: { keyCode: 38, key: 'ArrowUp' } }, QWERTZ);
  assert.equal(m.a.keyCode, 89); // P = pause → default (QWERTZ Y)
  assert.equal(m.b.keyCode, 88);
  assert.equal(m.up.keyCode, 38);
  assert.equal(m.x.keyCode, 65); // ArrowUp already taken by up
});

test('detectLayout guesses from the language, then prefers the Keyboard Map API (kept across language changes)', async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
    assert.equal((await detectLayout('fr')).id, 'azerty');
    assert.equal((await detectLayout(null)).id, 'qwerty'); // no app language yet → the browser's
    assert.equal(keyLabel(resolve(null).a), 'Z');
    globalThis.navigator.keyboard = { getLayoutMap: async () => new Map([['KeyZ', 'y'], ['KeyY', 'z'], ['KeyW', 'w']]) };
    assert.equal((await detectLayout('fr')).real, true);
    assert.equal(keyLabel(resolve(null).a), 'Y');
    assert.equal((await detectLayout('en')).id, 'system');
    assert.equal(currentLayout().real, true);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    else delete globalThis.navigator;
  }
});

test('controllers: Nintendo layout by default, family from the id, re-bound buttons never doubled', async () => {
  const c = await import('../web/lib/controls.mjs');
  const def = c.padMap(null);
  assert.equal(def.a, 'BUTTON_2'); // right face button, like on the GBA / DS
  assert.equal(def.b, 'BUTTON_1');
  assert.equal(c.padMap({ preset: 'xbox' }).a, 'BUTTON_1');
  // a re-bound button wins, a hotkey (turbo trigger) is refused, no label is used twice
  const m = c.padMap({ preset: 'nintendo', map: { a: 'BUTTON_4', select: 'RIGHT_BOTTOM_SHOULDER' } });
  assert.equal(m.a, 'BUTTON_4');
  assert.equal(m.select, 'SELECT');
  const labels = Object.values(m).filter(Boolean);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(c.padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'playstation');
  assert.equal(c.padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'), 'xbox');
  assert.equal(c.padFamily('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'switch');
  assert.equal(c.padFamily('8BitDo SN30 Pro (Vendor: 2dc8)'), 'generic');
  assert.equal(c.padLabel('BUTTON_2', 'switch'), 'A');
  assert.equal(c.padLabel('BUTTON_1', 'playstation'), '✕');
  // the EmulatorJS table carries the controller labels next to the keys
  const table = c.ejsControls(null, undefined, { preset: 'xbox' });
  assert.equal(table[0][8].value2, 'BUTTON_1'); // RetroArch A
});
