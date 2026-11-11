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

// ---- which connected device plays (issue #2: a USB microphone was taken for the controller) ----
const fakePad = (index, id, { mapping = '', buttons = 17, axes = 4, connected = true } = {}) => ({
  index, id, mapping, connected, buttons: Array.from({ length: buttons }, () => ({ pressed: false, value: 0 })), axes: Array(axes).fill(0),
});
const DUALSENSE = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const MIC = 'DGM20 USB Microphone (Vendor: 1fc9 Product: 0117)';

test('controllers: a USB microphone listed first never beats the PS5 controller', async () => {
  const c = await import('../web/lib/controls.mjs');
  const mic = fakePad(0, MIC, { buttons: 3, axes: 0 });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  assert.equal(c.pickPad([mic, ps5]), ps5);
  assert.equal(c.pickPad([ps5, mic]), ps5);
  // the microphone alone is no controller – nothing plays rather than the mic
  assert.equal(c.pickPad([mic]), null);
  assert.equal(c.looksLikePad(mic), false);
  // even a microphone/headset that reports plenty of buttons and axes, by its name
  assert.equal(c.pickPad([fakePad(0, 'HyperX Cloud II Wireless Headset (Vendor: 03f0)', { buttons: 12, axes: 2 })]), null);
  assert.equal(c.pickPad([fakePad(0, 'USB Audio Device (Vendor: 0d8c Product: 0014)', { buttons: 8, axes: 1 })]), null);
  // anything with 0–3 buttons and no standard layout
  for (const n of [0, 1, 2, 3]) assert.equal(c.pickPad([fakePad(0, `HID device ${n} (Vendor: 1234 Product: 5678)`, { buttons: n, axes: n ? 1 : 0 })]), null, `${n} buttons`);
  // "Microsoft" is no "mic": an Xbox pad by its maker's name still plays
  assert.ok(c.looksLikePad(fakePad(0, 'Controller (Xbox One For Windows) (Vendor: 045e Product: 02ea) Microsoft', { mapping: 'standard' })));
});

test('controllers: the most controller-like device plays – standard layout, known make, buttons and sticks', async () => {
  const c = await import('../web/lib/controls.mjs');
  const xbox = fakePad(2, XBOX, { mapping: 'standard' });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  const generic = fakePad(0, 'USB Gamepad (Vendor: 0079 Product: 0011)', { buttons: 10, axes: 2 });
  // a cheap pad without the standard layout is still a controller – and plays when it is the only one
  assert.equal(c.pickPad([generic]), generic);
  assert.ok(c.padScore(ps5) > c.padScore(generic));
  // standard + known make: the lowest index among equals (the one connected first)
  assert.equal(c.pickPad([generic, ps5, xbox]), ps5);
  assert.equal(c.pickPad([xbox, generic]), xbox);
  // disconnected slots and holes (Chrome keeps null for a pad that left)
  assert.equal(c.pickPad([null, fakePad(1, DUALSENSE, { mapping: 'standard', connected: false }), xbox]), xbox);
  assert.equal(c.pickPad([]), null);
  assert.equal(c.pickPad(null), null);
  // counts work as well as arrays (the Settings page keeps counts)
  assert.equal(c.padScore({ id: DUALSENSE, standard: true, buttons: 17, axes: 4 }), c.padScore(ps5));
});

test('controllers: the controller chosen in Settings plays whenever it is connected – even one that looks odd', async () => {
  const c = await import('../web/lib/controls.mjs');
  const mic = fakePad(0, MIC, { buttons: 3, axes: 0 });
  const ps5 = fakePad(1, DUALSENSE, { mapping: 'standard' });
  const xbox = fakePad(2, XBOX, { mapping: 'standard' });
  assert.equal(c.pickPad([mic, ps5, xbox], XBOX), xbox);
  // the player's own choice wins over the heuristics
  assert.equal(c.pickPad([mic, ps5], MIC), mic);
  // remembered but not connected: the automatic choice
  assert.equal(c.pickPad([mic, ps5], 'Some Other Pad (Vendor: 0001)'), ps5);
  // the stored key is the trimmed id (indexes change from start to start, the id doesn't)
  assert.equal(c.padKey(`  ${DUALSENSE} `), DUALSENSE);
  assert.equal(c.pickPad([mic, xbox, ps5], ` ${DUALSENSE}`), ps5);
  assert.equal(c.padKey('x'.repeat(300)).length, 200);
});
