// Saved randomizer presets: create / rename / update / delete, sanitizing, and the config round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server modules read their data directory at import time → point them at a scratch dir first.
const DATA = mkdtempSync(join(tmpdir(), 'sls-presets-'));
process.env.SLS_DATA_DIR = DATA;
const { listPresets, savePreset, deletePreset, MAX_PRESETS } = await import('../server/lib/presets.mjs');
const { loadConfig, saveConfig } = await import('../server/app.mjs');
const { CONFIG_PATH } = await import('../server/lib/paths.mjs');
const { PRESETS, withDefaults, sameSettings } = await import('../shared/randomizer-options.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const chaos = PRESETS.find((p) => p.id === 'chaos').values;

test('save, rename, update and delete a preset', () => {
  let { preset, presets } = savePreset([], { name: '  Our   run  ', values: chaos }, 'T1');
  assert.match(preset.id, /^u-[a-f0-9]{8}$/);
  assert.equal(preset.name, 'Our run');
  assert.deepEqual(preset.values, chaos);
  assert.equal(preset.createdAt, 'T1');
  assert.equal(presets.length, 1);

  const second = savePreset(presets, { name: 'Second', values: { wildPokemonMod: 'RANDOM' } });
  assert.notEqual(second.preset.id, preset.id);
  presets = second.presets;

  const renamed = savePreset(presets, { id: preset.id, name: 'Renamed' }, 'T2');
  assert.equal(renamed.preset.name, 'Renamed');
  assert.deepEqual(renamed.preset.values, chaos, 'rename keeps the values');
  assert.equal(renamed.preset.createdAt, 'T1');
  assert.equal(renamed.preset.updatedAt, 'T2');
  assert.equal(renamed.presets.length, 2);

  const updated = savePreset(renamed.presets, { id: preset.id, name: 'Renamed', values: { trainersMod: 'TYPE_THEMED' } });
  assert.deepEqual(updated.preset.values, { trainersMod: 'TYPE_THEMED' });

  const left = deletePreset(updated.presets, preset.id);
  assert.deepEqual(left.map((p) => p.name), ['Second']);
  assert.throws(() => deletePreset(left, preset.id), { status: 404 });
});

test('preset input is validated and sanitized', () => {
  assert.throws(() => savePreset([], { name: '   ', values: chaos }), { status: 400 });
  assert.throws(() => savePreset([], { name: 'x' }), { status: 400 });
  assert.throws(() => savePreset([], { id: 'u-00000000', name: 'x' }), { status: 404 });
  const { preset } = savePreset([], { name: 'a'.repeat(80) + '\n\t', values: { wildPokemonMod: 'BOGUS', blockWildLegendaries: true, evil: 1 } });
  assert.equal(preset.name.length, 40);
  assert.deepEqual(preset.values, { blockWildLegendaries: true });
  let list = [];
  for (let i = 0; i < MAX_PRESETS; i++) list = savePreset(list, { name: `P${i}`, values: {} }).presets;
  assert.throws(() => savePreset(list, { name: 'one too many', values: {} }), { status: 400 });
});

test('listPresets drops malformed entries from a hand-edited config', () => {
  const list = listPresets({
    randomizerPresets: [
      { id: 'u-0123abcd', name: 'ok', values: { wildPokemonMod: 'RANDOM', nonsense: 1 } },
      { id: '../evil', name: 'bad id', values: {} },
      { id: 'u-11112222', name: '', values: {} },
      null, 'string',
    ],
  });
  assert.deepEqual(list.map((p) => p.id), ['u-0123abcd']);
  assert.deepEqual(list[0].values, { wildPokemonMod: 'RANDOM' });
  assert.deepEqual(listPresets({}), []);
  assert.deepEqual(listPresets({ randomizerPresets: 'nope' }), []);
});

test('presets survive the config round trip and load back as the same settings', () => {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ playerName: 'Lou' }));
  const { presets } = savePreset(listPresets(loadConfig()), { name: 'Chaos light', values: { ...chaos, typesMod: 'UNCHANGED' } });
  saveConfig({ randomizerPresets: presets });

  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(cfg.playerName, 'Lou', 'other config keys stay');
  const [loaded] = listPresets(loadConfig());
  assert.equal(loaded.name, 'Chaos light');
  // what New Run builds with after picking the saved preset
  const values = withDefaults(loaded.values);
  assert.ok(sameSettings(values, { ...chaos, typesMod: 'UNCHANGED' }));
  assert.ok(!sameSettings(values, chaos));
});
