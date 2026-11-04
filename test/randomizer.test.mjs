// Randomizer options → UPR settings: every exposed key/value exists in the bundled UPR ZX,
// presets map to valid properties, and the per-generation build rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPTION_GROUPS, PRESETS, DEFAULT_VALUES, MISC_TWEAK_LABELS, toProperties, buildValues, sameSettings, sanitizeValues,
  fieldActive, fieldEnabled, forGen, withDefaults, randomizerStrings,
} from '../shared/randomizer-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// `java -cp PokeRandoZX.jar:tools/upr-bridge SoulLinkBridge fields` of UPR ZX 4.6.1 (re-checked live below)
const UPR = JSON.parse(readFileSync(join(root, 'test', 'data', 'upr-settings-fields.json'), 'utf8'));
const FIELDS = OPTION_GROUPS.flatMap((g) => g.fields).filter((f) => f.type !== 'head');
const byKey = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/** properties text → { key: value } (what SoulLinkBridge.readSettings parses) */
const parseProps = (text) => Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

/** Would the bridge accept `key=value`? Mirrors its reflection rules (boolean / int / enum). */
function uprAccepts(key, value) {
  if (key === '@miscTweaks') return value === '' || value.split(',').every((x) => UPR['@miscTweaks'].values.includes(x));
  const f = UPR[key];
  if (!f) return false;
  if (f.type === 'boolean') return value === 'true' || value === 'false';
  if (f.type === 'int') return /^-?\d+$/.test(value);
  if (f.values) return f.values.includes(value);
  return false;
}

test('every exposed option is a real UPR 4.6.1 setting with a matching type', () => {
  for (const f of FIELDS) {
    const u = UPR[f.key];
    assert.ok(u, `${f.key} is not a UPR Settings field`);
    if (f.type === 'bool') assert.equal(u.type, 'boolean', f.key);
    else if (f.type === 'int' || f.numeric) assert.equal(u.type, 'int', f.key);
    else {
      assert.ok(u.values, `${f.key} is not an enum`);
      for (const [v] of f.options) assert.ok(u.values.includes(v), `${f.key}=${v} is not a UPR value`);
    }
  }
  for (const k of Object.keys(MISC_TWEAK_LABELS)) assert.ok(UPR['@miscTweaks'].values.includes(k), `tweak ${k}`);
});

test('defaults cover every field, and every default and preset maps to properties the bridge accepts', () => {
  for (const f of FIELDS) assert.ok(f.key in DEFAULT_VALUES, `no default for ${f.key}`);
  for (const values of [DEFAULT_VALUES, ...PRESETS.map((p) => p.values)]) {
    const props = parseProps(toProperties(values));
    for (const [k, v] of Object.entries(props)) assert.ok(uprAccepts(k, v), `${k}=${v}`);
    for (const [k, v] of Object.entries(values)) {
      const f = byKey[k];
      if (f?.type === 'int') assert.ok(v >= f.min && v <= f.max, `${k}=${v} outside ${f.min}…${f.max}`);
      if (f?.type === 'select') assert.ok(f.options.some(([o]) => o === v), `${k}=${v} not offered`);
    }
  }
});

test('new options map 1:1 to UPR settings lines', () => {
  const text = toProperties({
    updateBaseStats: true, updateBaseStatsToGeneration: 7, updateMoves: true, updateMovesToGeneration: 6,
    standardizeEXPCurves: true, selectedEXPCurve: 'FAST', expCurveMod: 'ALL', eliteFourUniquePokemonNumber: 2,
    tmsForceGoodDamaging: true, tmsGoodDamagingPercent: 40, randomizeMoveCategory: true, staticLevelModified: true, staticLevelModifier: -10,
    '@miscTweaks': ['FASTEST_TEXT', 'RUN_WITHOUT_RUNNING_SHOES'],
  });
  const p = parseProps(text);
  assert.equal(p.updateBaseStatsToGeneration, '7');
  assert.equal(p.updateMovesToGeneration, '6');
  assert.equal(p.selectedEXPCurve, 'FAST');
  assert.equal(p.expCurveMod, 'ALL');
  assert.equal(p.eliteFourUniquePokemonNumber, '2');
  assert.equal(p.tmsGoodDamagingPercent, '40');
  assert.equal(p.staticLevelModifier, '-10');
  assert.equal(p['@miscTweaks'], 'FASTEST_TEXT,RUN_WITHOUT_RUNNING_SHOES');
  for (const [k, v] of Object.entries(p)) assert.ok(uprAccepts(k, v), `${k}=${v}`);
});

test('options added later default to UPR\'s own default unless they only matter behind a parent', () => {
  // the bridge fills a missing key with UPR's default – old runs (without these keys) must build the same
  const uprDefault = (k) => (UPR[k].type === 'boolean' ? false : UPR[k].type === 'int' ? 0 : k === 'selectedEXPCurve' ? 'MEDIUM_FAST' : UPR[k].values[0]);
  const added = ['balanceShakingGrass', 'trainersMatchTypingDistribution', 'allowTrainerAlternateFormes', 'eliteFourUniquePokemonNumber',
    'randomizeHeldItemsForImportantTrainerPokemon', 'randomizeHeldItemsForRegularTrainerPokemon', 'sensibleItemsOnlyForTrainerPokemon',
    'consumableItemsOnlyForTrainerPokemon', 'highestLevelOnlyGetsItemsForTrainerPokemon', 'limitMainGameLegendaries', 'limit600',
    'staticLevelModified', 'staticLevelModifier', 'ensureTwoAbilities', 'weighDuplicateAbilitiesTogether', 'assignEvoStatsRandomly',
    'updateBaseStats', 'updateBaseStatsToGeneration', 'selectedEXPCurve', 'expCurveMod', 'updateMoves', 'updateMovesToGeneration',
    'randomizeMovePPs', 'randomizeMoveCategory', 'tmsForceGoodDamaging', 'tmsGoodDamagingPercent', 'blockBrokenTMMoves', 'tmLevelUpMoveSanity',
    'tmsFollowEvolutions', 'keepFieldMoveTutors', 'tutorsForceGoodDamaging', 'tutorsGoodDamagingPercent', 'blockBrokenTutorMoves',
    'tutorLevelUpMoveSanity', 'tutorFollowEvolutions', 'banBadRandomShopItems', 'banRegularShopItems', 'banBadRandomPickupItems', 'randomizeInGameTradesOTs'];
  for (const k of added) {
    if (DEFAULT_VALUES[k] === uprDefault(k)) continue;
    assert.ok(!fieldActive(byKey[k], DEFAULT_VALUES), `${k}: default ${DEFAULT_VALUES[k]} ≠ UPR ${uprDefault(k)} while active`);
  }
});

test('dependsOn chains: fieldActive / fieldEnabled', () => {
  const v = withDefaults({});
  assert.equal(fieldActive(byKey.tmsGoodDamagingPercent, v), false);
  assert.equal(fieldActive(byKey.tmsGoodDamagingPercent, { ...v, tmsForceGoodDamaging: true }), false, 'parent of parent (tmsMod) is off');
  assert.equal(fieldActive(byKey.tmsGoodDamagingPercent, { ...v, tmsMod: 'RANDOM', tmsForceGoodDamaging: true }), true);
  assert.equal(fieldActive(byKey.trainersMatchTypingDistribution, { ...v, trainersMod: 'RANDOM' }), false);
  assert.equal(fieldActive(byKey.trainersMatchTypingDistribution, { ...v, trainersMod: 'TYPE_THEMED' }), true);
  assert.equal(fieldActive(byKey.sensibleItemsOnlyForTrainerPokemon, { ...v, randomizeHeldItemsForRegularTrainerPokemon: true }), true);
  assert.equal(fieldActive(byKey.rivalCarriesStarterThroughout, { ...v, startersMod: 'COMPLETELY_RANDOM' }), true);
  assert.equal(fieldEnabled(byKey.tmsFollowEvolutions, { ...v, tmsHmsCompatibilityMod: 'COMPLETELY_RANDOM', evolutionsMod: 'RANDOM_EVERY_LEVEL' }), false);
  assert.equal(forGen(byKey.abilitiesMod, 2), false);
  assert.equal(forGen(byKey.abilitiesMod, 4), true);
  assert.equal(forGen(byKey.abilitiesMod, null), true);
});

test('buildValues applies the generation and "new every level" rules without touching the input', () => {
  const hard = PRESETS.find((p) => p.id === 'hardcore').values;
  const frozen = JSON.stringify(hard);
  const g2 = buildValues(hard, 2);
  assert.equal(JSON.stringify(hard), frozen);
  // extra trainer Pokémon crash UPR on Gen 2 (Gen2RomHandler.getTrainers) – the GUI hides them below Gen 3
  assert.equal(g2.additionalBossTrainerPokemon, 0);
  assert.equal(g2.additionalImportantTrainerPokemon, 0);
  assert.equal(g2.randomizeHeldItemsForBossTrainerPokemon, false);
  assert.equal(buildValues(hard, 4).additionalBossTrainerPokemon, 1);
  assert.deepEqual(buildValues(hard, null), hard, 'unknown generation: unchanged');

  assert.equal(buildValues({ trainersMod: 'MAINPLAYTHROUGH' }, 4).trainersMod, 'RANDOM');
  assert.equal(buildValues({ trainersMod: 'MAINPLAYTHROUGH' }, 5).trainersMod, 'MAINPLAYTHROUGH');
  assert.equal(buildValues({ evolutionsMod: 'RANDOM_EVERY_LEVEL' }, 2).evolutionsMod, 'RANDOM');

  const every = buildValues({ ...withDefaults({}), evolutionsMod: 'RANDOM_EVERY_LEVEL', typesMod: 'RANDOM_FOLLOW_EVOLUTIONS', startersMod: 'RANDOM_WITH_TWO_EVOLUTIONS',
    tmsFollowEvolutions: true, changeImpossibleEvolutions: true }, 4);
  assert.equal(every.baseStatsFollowEvolutions, false); // UPR loops forever otherwise
  assert.equal(every.tmsFollowEvolutions, false);
  assert.equal(every.changeImpossibleEvolutions, false);
  assert.equal(every.typesMod, 'COMPLETELY_RANDOM');
  assert.equal(every.startersMod, 'COMPLETELY_RANDOM');

  // never adds keys (a run saved without them builds exactly as before), and is stable
  assert.deepEqual(buildValues({ wildPokemonMod: 'RANDOM' }, 4), { wildPokemonMod: 'RANDOM' });
  const once = buildValues(hard, 2);
  assert.deepEqual(buildValues(once, 2), once);
});

test('sameSettings: missing keys = defaults, ignored when the parent is off, tweak order irrelevant', () => {
  const classic = PRESETS[0].values;
  // a run created before the new options existed only has the old keys
  const old = Object.fromEntries(Object.entries(classic).filter(([k]) => !['updateMoves', 'updateMovesToGeneration', 'limit600', 'randomizeMovePPs'].includes(k)));
  assert.ok(sameSettings(classic, old));
  assert.ok(sameSettings(classic, { ...classic, updateMovesToGeneration: 5 }), 'parent updateMoves is off');
  assert.ok(!sameSettings(classic, { ...classic, updateMoves: true }));
  assert.ok(sameSettings(classic, { ...classic, '@miscTweaks': [...classic['@miscTweaks']].reverse() }));
  assert.ok(!sameSettings(classic, { ...classic, wildPokemonMod: 'AREA_MAPPING' }));
  assert.ok(!sameSettings(classic, { ...classic, someFutureKey: true }), 'unknown keys must match exactly');
  for (const p of PRESETS) assert.equal(PRESETS.filter((q) => sameSettings(p.values, q.values)).length, 1, `${p.id} is distinct`);
});

test('sanitizeValues keeps only known options with valid values', () => {
  const s = sanitizeValues({
    wildPokemonMod: 'RANDOM', startersMod: 'NOPE', blockWildLegendaries: 'yes', useMinimumCatchRate: true,
    minimumCatchRateLevel: 99, wildLevelModifier: '-80', guaranteedMoveCount: null, updateMovesToGeneration: '7',
    '@miscTweaks': ['FASTEST_TEXT', 'FASTEST_TEXT', 'EVIL', 3], customNames: 'x',
  });
  assert.deepEqual(s, {
    wildPokemonMod: 'RANDOM', useMinimumCatchRate: true, minimumCatchRateLevel: 5, wildLevelModifier: -50, updateMovesToGeneration: 7,
    '@miscTweaks': ['FASTEST_TEXT'],
  });
  assert.deepEqual(sanitizeValues(null), {});
  assert.deepEqual(sanitizeValues([1, 2]), {});
  for (const p of PRESETS) assert.deepEqual(sanitizeValues(p.values), p.values, `${p.id} survives sanitizing`);
});

test('every randomizer string has a stable i18n key', () => {
  const s = randomizerStrings();
  assert.equal(s['rnd.group.tms'], 'TMs & HMs');
  assert.equal(s['rnd.preset.vanilla-plus.name'], 'Vanilla+');
  assert.equal(s['rnd.head.trainerItems'], 'Held items & movesets');
  assert.ok(!('rnd.updateMovesToGeneration.9' in s), 'numeric options are not translated');
  for (const [k, v] of Object.entries(s)) assert.ok(typeof v === 'string' && v.length, k);
});

// The snapshot above must describe the UPR that actually ships. Needs the bundled Java runtime.
const { detectJava, UPR_JAR, runBridge } = await import('../server/lib/toolchain.mjs');
const canRunBridge = detectJava().ok && existsSync(UPR_JAR);
test('the UPR settings snapshot matches the bundled UPR', { skip: !canRunBridge && 'no Java / UPR here' }, async () => {
  const res = await runBridge(['fields'], { timeoutMs: 60000 });
  assert.deepEqual(res.json, UPR);
});
