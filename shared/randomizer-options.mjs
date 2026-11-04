// Curated Universal Pokemon Randomizer ZX options (Gen 4 relevant).
// Keys are UPR Settings field names — the Java bridge applies them by reflection.
// Every key and enum value here exists in the bundled UPR ZX 4.6.1 (test/data/upr-settings-fields.json,
// checked by test/randomizer.test.mjs).
// User-visible strings are English source text; the UI translates them via localizeRandomizer(t)
// with stable keys (see rndKey below). The server only uses toProperties(), never the labels.

// Optional field props (last argument `more`):
//   dependsOn  key | [keys] (any of them on) | { key, in: [values] } – the field only matters while that is on;
//              a select counts as "on" unless it is UNCHANGED / NONE (see fieldActive).
//   gens       [min, max] – only shown for games of these generations (UPR ignores the rest anyway).
//   numeric    select whose values are numbers.
// Select options are [value, label] or [value, label, { gens, fallback }] (fallback: used instead in other generations).
const sel = (key, label, options, help, more) => ({ key, label, type: 'select', options, help, ...more });
const bool = (key, label, help, dependsOn, more) => ({ key, label, type: 'bool', help, dependsOn, ...more });
const num = (key, label, min, max, help, dependsOn, more) => ({ key, label, type: 'int', min, max, help, dependsOn, ...more });
/** A small sub-heading inside a group (no value). */
const head = (key, label) => ({ key, label, type: 'head' });

const TRAINER_ITEMS = ['randomizeHeldItemsForBossTrainerPokemon', 'randomizeHeldItemsForImportantTrainerPokemon', 'randomizeHeldItemsForRegularTrainerPokemon'];
const GEN_TO = (from) => [9, 8, 7, 6, 5, 4, 3, 2].filter((g) => g >= from).reverse().map((g) => [g, `Gen ${g}`, { gens: [1, g - 1] }]);

export const OPTION_GROUPS = [
  {
    id: 'starters',
    title: 'Starters',
    icon: '⭐',
    fields: [
      sel('startersMod', 'Starters', [
        ['UNCHANGED', 'Unchanged'],
        ['COMPLETELY_RANDOM', 'Completely random'],
        ['RANDOM_WITH_TWO_EVOLUTIONS', 'Random with two evolutions (3 stages)'],
      ], 'With two evolutions: basic Pokémon that evolve twice – fair and never legendary.'),
      bool('randomizeStartersHeldItems', 'Starters hold a random item', null, null, { gens: [2, 9] }),
      bool('banBadRandomStarterHeldItems', 'Exclude useless items', null, 'randomizeStartersHeldItems', { gens: [2, 9] }),
      bool('allowStarterAltFormes', 'Allow alternate forms', null, 'startersMod', { gens: [6, 9] }),
    ],
  },
  {
    id: 'wild',
    title: 'Wild Pokémon',
    icon: '🌿',
    fields: [
      sel('wildPokemonMod', 'Wild Pokémon', [
        ['UNCHANGED', 'Unchanged'],
        ['RANDOM', 'Completely random (every slot)'],
        ['AREA_MAPPING', 'Random, 1:1 per area'],
        ['GLOBAL_MAPPING', 'Global 1:1 swap (e.g. every Pidgey → X)'],
      ], 'Recommended for SoulLinks: completely random – the most variety per route.'),
      sel('wildPokemonRestrictionMod', 'Restriction', [
        ['NONE', 'None'],
        ['SIMILAR_STRENGTH', 'Similar strength (BST)'],
        ['CATCH_EM_ALL', 'Catch \'em all (every Pokémon at least once)'],
        ['TYPE_THEME_AREAS', 'Type theme per area'],
      ], null, { dependsOn: 'wildPokemonMod' }),
      bool('useTimeBasedEncounters', 'Randomize time-of-day encounters separately', 'Morning, day and night get their own pools.', 'wildPokemonMod'),
      bool('blockWildLegendaries', 'No legendaries in the wild', null, 'wildPokemonMod'),
      bool('allowWildAltFormes', 'Allow alternate forms', null, 'wildPokemonMod', { gens: [5, 9] }),
      bool('balanceShakingGrass', 'Balance shaking-grass Pokémon', 'Shaking grass gets Pokémon of a fitting strength.', 'wildPokemonMod', { gens: [5, 5] }),
      bool('useMinimumCatchRate', 'Raise the minimum catch rate'),
      num('minimumCatchRateLevel', 'Catch rate level (1–5)', 1, 5, '1 = slightly higher … 5 = always catchable', 'useMinimumCatchRate'),
      bool('wildLevelsModified', 'Adjust wild Pokémon levels'),
      num('wildLevelModifier', 'Level change in %', -50, 50, null, 'wildLevelsModified'),
      bool('randomizeWildPokemonHeldItems', 'Randomize items held by wild Pokémon', null, null, { gens: [2, 9] }),
      bool('banBadRandomWildPokemonHeldItems', 'Exclude useless items', null, 'randomizeWildPokemonHeldItems', { gens: [2, 9] }),
    ],
  },
  {
    id: 'trainers',
    title: 'Trainers',
    icon: '⚔️',
    fields: [
      sel('trainersMod', 'Trainer Pokémon', [
        ['UNCHANGED', 'Unchanged (original teams)'],
        ['RANDOM', 'Random'],
        ['DISTRIBUTED', 'Evenly distributed'],
        ['MAINPLAYTHROUGH', 'Evenly distributed (main story only)', { gens: [5, 5], fallback: 'RANDOM' }],
        ['TYPE_THEMED', 'Type theme per trainer'],
        ['TYPE_THEMED_ELITE4_GYMS', 'Type theme for gyms & Elite Four only'],
      ], '"Unchanged" keeps the trainers\' original teams – including the reworked teams of ROM hacks.'),
      bool('trainersUsePokemonOfSimilarStrength', 'Similar strength to the original', null, 'trainersMod'),
      bool('trainersMatchTypingDistribution', 'Weight types by how many Pokémon have them', 'Fewer repeats, but sometimes several trainers of one type in a row.',
        { key: 'trainersMod', in: ['TYPE_THEMED', 'TYPE_THEMED_ELITE4_GYMS'] }),
      bool('rivalCarriesStarterThroughout', 'Rival keeps their starter', null, ['trainersMod', 'startersMod']),
      bool('trainersBlockLegendaries', 'No legendaries for trainers', null, 'trainersMod'),
      bool('trainersBlockEarlyWonderGuard', 'No early Wonder Guard', null, 'trainersMod', { gens: [3, 9] }),
      bool('allowTrainerAlternateFormes', 'Allow alternate forms', null, 'trainersMod', { gens: [4, 9] }),
      num('eliteFourUniquePokemonNumber', 'Elite Four: unique Pokémon (0 = off)', 0, 2, 'Their strongest Pokémon appear on no other trainer.', 'trainersMod', { gens: [3, 9] }),
      head('head.trainerLevels', 'Levels & team size'),
      bool('trainersForceFullyEvolved', 'Fully evolved from level X'),
      num('trainersForceFullyEvolvedLevel', 'From level', 30, 65, null, 'trainersForceFullyEvolved'),
      bool('trainersLevelModified', 'Adjust trainer levels'),
      num('trainersLevelModifier', 'Level change in %', -50, 50, null, 'trainersLevelModified'),
      num('additionalBossTrainerPokemon', 'Extra Pokémon for bosses (gyms / Elite Four)', 0, 5, null, null, { gens: [3, 9] }),
      num('additionalImportantTrainerPokemon', 'Extra Pokémon for rival / villain team', 0, 5, null, null, { gens: [3, 9] }),
      num('additionalRegularTrainerPokemon', 'Extra Pokémon for regular trainers', 0, 5, null, null, { gens: [3, 9] }),
      head('head.trainerItems', 'Held items & movesets'),
      bool('randomizeHeldItemsForBossTrainerPokemon', 'Boss Pokémon hold items', null, null, { gens: [3, 9] }),
      bool('randomizeHeldItemsForImportantTrainerPokemon', 'Rival / villain Pokémon hold items', null, null, { gens: [3, 9] }),
      bool('randomizeHeldItemsForRegularTrainerPokemon', 'Regular trainers\' Pokémon hold items', null, null, { gens: [3, 9] }),
      bool('sensibleItemsOnlyForTrainerPokemon', 'Only sensible items', 'Items that fit the Pokémon (e.g. a Yache Berry only on Ice-weak Pokémon).', TRAINER_ITEMS, { gens: [3, 9] }),
      bool('consumableItemsOnlyForTrainerPokemon', 'Only consumable items (mostly berries)', null, TRAINER_ITEMS, { gens: [3, 9] }),
      bool('highestLevelOnlyGetsItemsForTrainerPokemon', 'Only the highest-level Pokémon gets an item', null, TRAINER_ITEMS, { gens: [3, 9] }),
      bool('betterTrainerMovesets', 'Better trainer movesets', null, null, { gens: [3, 9] }),
      head('head.trainerNames', 'Names'),
      bool('randomizeTrainerNames', 'Randomize trainer names'),
      bool('randomizeTrainerClassNames', 'Randomize trainer class names'),
    ],
  },
  {
    id: 'statics',
    title: 'Static Pokémon',
    icon: '🗿',
    fields: [
      sel('staticPokemonMod', 'Legendaries / gifts / static encounters', [
        ['UNCHANGED', 'Unchanged'],
        ['RANDOM_MATCHING', 'Random (legendary ↔ legendary)'],
        ['COMPLETELY_RANDOM', 'Completely random'],
        ['SIMILAR_STRENGTH', 'Similar strength'],
      ], 'Not possible for ROM hacks that move the event scripts – it is set to "Unchanged" automatically there.'),
      bool('limitMainGameLegendaries', 'Cap the story legendaries', 'Legendaries you must face in the story (e.g. Lugia / Ho-Oh) get a beatable replacement.',
        { key: 'staticPokemonMod', in: ['SIMILAR_STRENGTH'] }),
      bool('limit600', 'Fully random for 600+ BST Pokémon', null, { key: 'staticPokemonMod', in: ['SIMILAR_STRENGTH'] }),
      bool('staticLevelModified', 'Adjust static Pokémon levels'),
      num('staticLevelModifier', 'Level change in %', -50, 50, null, 'staticLevelModified'),
    ],
  },
  {
    id: 'evolutions',
    title: 'Evolutions',
    icon: '🔁',
    fields: [
      sel('evolutionsMod', 'Evolutions', [['UNCHANGED', 'Unchanged'], ['RANDOM', 'Random'], ['RANDOM_EVERY_LEVEL', 'New every level (chaos)', { gens: [3, 9], fallback: 'RANDOM' }]]),
      bool('evosSimilarStrength', 'Similar strength', null, { key: 'evolutionsMod', in: ['RANDOM'] }),
      bool('evosSameTyping', 'Same type', null, 'evolutionsMod'),
      bool('evosMaxThreeStages', 'At most 3 stages', null, { key: 'evolutionsMod', in: ['RANDOM'] }),
      bool('evosForceChange', 'Every evolution must change', null, 'evolutionsMod'),
      head('head.evoTweaks', 'Easier evolving'),
      bool('changeImpossibleEvolutions', 'Replace trade evolutions', 'Important without a trading partner – some ROM hacks already do this themselves.'),
      bool('makeEvolutionsEasier', 'Make evolutions easier (level 40 at most)'),
      bool('removeTimeBasedEvolutions', 'Remove time-of-day evolutions'),
    ],
  },
  {
    id: 'pokemon',
    title: 'Pokémon traits',
    icon: '🧬',
    fields: [
      sel('typesMod', 'Types', [
        ['UNCHANGED', 'Unchanged'],
        ['RANDOM_FOLLOW_EVOLUTIONS', 'Random (follows evolutions)'],
        ['COMPLETELY_RANDOM', 'Completely random'],
      ]),
      bool('dualTypeOnly', 'Dual types only', null, 'typesMod'),
      sel('abilitiesMod', 'Abilities', [['UNCHANGED', 'Unchanged'], ['RANDOMIZE', 'Random']], null, { gens: [3, 9] }),
      bool('abilitiesFollowEvolutions', 'Abilities follow evolutions', null, 'abilitiesMod', { gens: [3, 9] }),
      bool('ensureTwoAbilities', 'Every Pokémon gets two abilities', null, 'abilitiesMod', { gens: [3, 9] }),
      bool('weighDuplicateAbilitiesTogether', 'Count look-alike abilities once', 'E.g. Insomnia and Vital Spirit share one chance.', 'abilitiesMod', { gens: [3, 9] }),
      bool('allowWonderGuard', 'Allow Wonder Guard', null, 'abilitiesMod', { gens: [3, 9] }),
      bool('banTrappingAbilities', 'Ban trapping abilities (Shadow Tag etc.)', null, 'abilitiesMod', { gens: [3, 9] }),
      bool('banNegativeAbilities', 'Ban negative abilities (Truant etc.)', null, 'abilitiesMod', { gens: [3, 9] }),
      bool('banBadAbilities', 'Ban weak abilities', null, 'abilitiesMod', { gens: [3, 9] }),
      head('head.stats', 'Base stats & EXP'),
      sel('baseStatisticsMod', 'Base stats', [['UNCHANGED', 'Unchanged'], ['SHUFFLE', 'Shuffle'], ['RANDOM', 'Random']]),
      bool('baseStatsFollowEvolutions', 'Base stats follow evolutions', null, 'baseStatisticsMod'),
      bool('assignEvoStatsRandomly', 'Spread the stats gained on evolution randomly', null, 'baseStatsFollowEvolutions'),
      bool('updateBaseStats', 'Update base stats to a newer generation', null, null, { gens: [1, 8] }),
      sel('updateBaseStatsToGeneration', 'Base stats as in', GEN_TO(6), null, { dependsOn: 'updateBaseStats', numeric: true, gens: [1, 8] }),
      bool('standardizeEXPCurves', 'Standardize EXP curves'),
      sel('selectedEXPCurve', 'EXP curve', [['MEDIUM_FAST', 'Medium fast'], ['MEDIUM_SLOW', 'Medium slow'], ['FAST', 'Fast'], ['SLOW', 'Slow'], ['ERRATIC', 'Erratic'], ['FLUCTUATING', 'Fluctuating']],
        null, { dependsOn: 'standardizeEXPCurves' }),
      sel('expCurveMod', 'Applies to', [['LEGENDARIES', 'All but legendaries (they stay slow)'], ['STRONG_LEGENDARIES', 'All but strong legendaries'], ['ALL', 'All Pokémon']],
        null, { dependsOn: 'standardizeEXPCurves' }),
    ],
  },
  {
    id: 'moves',
    title: 'Moves',
    icon: '💥',
    fields: [
      sel('movesetsMod', 'Movesets (level-up)', [
        ['UNCHANGED', 'Unchanged'],
        ['RANDOM_PREFER_SAME_TYPE', 'Random (prefers same type)'],
        ['COMPLETELY_RANDOM', 'Completely random'],
        ['METRONOME_ONLY', 'Metronome only 🙃'],
      ]),
      bool('startWithGuaranteedMoves', 'Start with guaranteed moves', null, { key: 'movesetsMod', in: ['RANDOM_PREFER_SAME_TYPE', 'COMPLETELY_RANDOM'] }),
      num('guaranteedMoveCount', 'Number of moves', 2, 4, null, 'startWithGuaranteedMoves'),
      bool('reorderDamagingMoves', 'Order damaging moves by power'),
      bool('movesetsForceGoodDamaging', 'Force good damaging moves', null, { key: 'movesetsMod', in: ['RANDOM_PREFER_SAME_TYPE', 'COMPLETELY_RANDOM'] }),
      num('movesetsGoodDamagingPercent', 'Share in %', 0, 100, null, 'movesetsForceGoodDamaging'),
      bool('blockBrokenMovesetMoves', 'Block broken moves', null, { key: 'movesetsMod', in: ['RANDOM_PREFER_SAME_TYPE', 'COMPLETELY_RANDOM'] }),
      head('head.moveData', 'Move data'),
      bool('updateMoves', 'Update moves to a newer generation', 'Power, accuracy and PP as in later games (no new Fairy type).', null, { gens: [1, 8] }),
      sel('updateMovesToGeneration', 'Moves as in', GEN_TO(2), null, { dependsOn: 'updateMoves', numeric: true, gens: [1, 8] }),
      bool('randomizeMovePowers', 'Randomize move power'),
      bool('randomizeMoveAccuracies', 'Randomize move accuracy'),
      bool('randomizeMovePPs', 'Randomize move PP'),
      bool('randomizeMoveTypes', 'Randomize move types'),
      bool('randomizeMoveCategory', 'Randomize physical / special', null, null, { gens: [4, 9] }),
    ],
  },
  {
    id: 'tms',
    title: 'TMs & HMs',
    icon: '💿',
    fields: [
      sel('tmsMod', 'TM moves', [['UNCHANGED', 'Unchanged'], ['RANDOM', 'Random']]),
      bool('keepFieldMoveTMs', 'Keep field-move TMs', null, 'tmsMod'),
      bool('tmsForceGoodDamaging', 'Force good damaging moves', null, 'tmsMod'),
      num('tmsGoodDamagingPercent', 'Share in %', 0, 100, null, 'tmsForceGoodDamaging'),
      bool('blockBrokenTMMoves', 'Block broken moves', null, 'tmsMod'),
      sel('tmsHmsCompatibilityMod', 'TM/HM compatibility', [
        ['UNCHANGED', 'Unchanged'], ['RANDOM_PREFER_TYPE', 'Random (prefers type)'], ['COMPLETELY_RANDOM', 'Completely random'], ['FULL', 'Everyone learns everything'],
      ]),
      bool('tmLevelUpMoveSanity', 'Pokémon can learn TMs of their level-up moves', null, { key: 'tmsHmsCompatibilityMod', in: ['RANDOM_PREFER_TYPE', 'COMPLETELY_RANDOM'] }),
      bool('tmsFollowEvolutions', 'Compatibility follows evolutions', null, { key: 'tmsHmsCompatibilityMod', in: ['RANDOM_PREFER_TYPE', 'COMPLETELY_RANDOM'] }),
      bool('fullHMCompat', 'Every Pokémon can learn every HM', 'Handy when the randomizer leaves you without HM users.'),
    ],
  },
  {
    id: 'tutors',
    title: 'Move tutors',
    icon: '🎓',
    fields: [
      sel('moveTutorMovesMod', 'Move tutors', [['UNCHANGED', 'Unchanged'], ['RANDOM', 'Random']], 'Only games with move tutors – ignored otherwise.'),
      bool('keepFieldMoveTutors', 'Keep field-move tutors', null, 'moveTutorMovesMod'),
      bool('tutorsForceGoodDamaging', 'Force good damaging moves', null, 'moveTutorMovesMod'),
      num('tutorsGoodDamagingPercent', 'Share in %', 0, 100, null, 'tutorsForceGoodDamaging'),
      bool('blockBrokenTutorMoves', 'Block broken moves', null, 'moveTutorMovesMod'),
      sel('moveTutorsCompatibilityMod', 'Tutor compatibility', [
        ['UNCHANGED', 'Unchanged'], ['RANDOM_PREFER_TYPE', 'Random (prefers type)'], ['COMPLETELY_RANDOM', 'Completely random'], ['FULL', 'Everyone learns everything'],
      ]),
      bool('tutorLevelUpMoveSanity', 'Pokémon can learn tutor moves of their level-up moves', null, { key: 'moveTutorsCompatibilityMod', in: ['RANDOM_PREFER_TYPE', 'COMPLETELY_RANDOM'] }),
      bool('tutorFollowEvolutions', 'Compatibility follows evolutions', null, { key: 'moveTutorsCompatibilityMod', in: ['RANDOM_PREFER_TYPE', 'COMPLETELY_RANDOM'] }),
    ],
  },
  {
    id: 'items',
    title: 'Items & trades',
    icon: '🎒',
    fields: [
      sel('fieldItemsMod', 'Items on the map', [['UNCHANGED', 'Unchanged'], ['SHUFFLE', 'Shuffle'], ['RANDOM', 'Random'], ['RANDOM_EVEN', 'Random (even)']]),
      bool('banBadRandomFieldItems', 'Exclude useless items', null, { key: 'fieldItemsMod', in: ['RANDOM', 'RANDOM_EVEN'] }),
      sel('shopItemsMod', 'Shop items', [['UNCHANGED', 'Unchanged'], ['SHUFFLE', 'Shuffle'], ['RANDOM', 'Random']]),
      bool('banBadRandomShopItems', 'Exclude useless items', null, { key: 'shopItemsMod', in: ['RANDOM'] }),
      bool('banRegularShopItems', 'No regular shop items (Potions, Poké Balls …)', null, { key: 'shopItemsMod', in: ['RANDOM'] }),
      bool('banOPShopItems', 'Ban overpowered shop items', null, 'shopItemsMod'),
      bool('guaranteeEvolutionItems', 'Guarantee evolution items', null, 'shopItemsMod'),
      bool('guaranteeXItems', 'Guarantee X items', null, 'shopItemsMod'),
      bool('balanceShopPrices', 'Balance shop prices'),
      sel('pickupItemsMod', 'Pickup items', [['UNCHANGED', 'Unchanged'], ['RANDOM', 'Random']], null, { gens: [3, 9] }),
      bool('banBadRandomPickupItems', 'Exclude useless items', null, 'pickupItemsMod', { gens: [3, 9] }),
      head('head.trades', 'In-game trades'),
      sel('inGameTradesMod', 'In-game trades', [['UNCHANGED', 'Unchanged'], ['RANDOMIZE_GIVEN', 'Random Pokémon received'], ['RANDOMIZE_GIVEN_AND_REQUESTED', 'Both random']]),
      bool('randomizeInGameTradesNicknames', 'Randomize nicknames', null, 'inGameTradesMod'),
      bool('randomizeInGameTradesOTs', 'Randomize original trainers', null, 'inGameTradesMod'),
      bool('randomizeInGameTradesIVs', 'Randomize IVs', null, 'inGameTradesMod'),
      bool('randomizeInGameTradesItems', 'Randomize items', null, 'inGameTradesMod'),
    ],
  },
];

/** Every code tweak of UPR 4.6.1 – the UI only offers those the loaded ROM supports (bridge `info`). */
export const MISC_TWEAK_LABELS = {
  FASTEST_TEXT: 'Fastest text',
  NATIONAL_DEX_AT_START: 'National Pokédex from the start (needed so Pokémon from other regions can evolve)',
  UPDATE_TYPE_EFFECTIVENESS: 'Update type effectiveness to Gen 6',
  LOWER_CASE_POKEMON_NAMES: 'Mixed-case Pokémon names',
  RANDOMIZE_CATCHING_TUTORIAL: 'Randomize the catching tutorial Pokémon',
  BAN_LUCKY_EGG: 'Ban Lucky Egg',
  RUN_WITHOUT_RUNNING_SHOES: 'Run without Running Shoes',
  FASTER_HP_AND_EXP_BARS: 'Faster HP and EXP bars',
  UPDATE_ROTOM_FORME_TYPING: 'Update Rotom form types',
  RUNNING_SHOES_INDOORS: 'Running Shoes indoors',
  RANDOMIZE_PC_POTION: 'Randomize the Potion in your PC',
  ALLOW_PIKACHU_EVOLUTION: 'Allow Pikachu to evolve',
  BAN_BIG_MANIAC_ITEMS: 'Ban valuable sell-only items',
  NO_FREE_LUCKY_EGG: 'No free Lucky Egg',
  BALANCE_STATIC_LEVELS: 'Balance fossil / gift levels',
  FAST_DISTORTION_WORLD: 'Fast Distortion World',
  DISABLE_LOW_HP_MUSIC: 'Disable low-HP music',
  BW_EXP_PATCH: 'Black/White EXP system',
  NERF_X_ACCURACY: 'Nerf X Accuracy',
  FIX_CRIT_RATE: 'Fix the critical-hit rate',
  FORCE_CHALLENGE_MODE: 'Force Challenge Mode',
  RETAIN_ALT_FORMES: 'Keep temporary forms after reset',
  SOS_BATTLES_FOR_ALL: 'All wild Pokémon can call allies',
};

// Defaults for every exposed field. Keys added after the first release use UPR's own default
// (what the bridge sets when a key is missing) or only matter while their parent option is on,
// so runs saved without them build exactly the same.
const BASE = {
  wildPokemonMod: 'UNCHANGED', wildPokemonRestrictionMod: 'NONE', useTimeBasedEncounters: false, blockWildLegendaries: false,
  useMinimumCatchRate: false, minimumCatchRateLevel: 1, randomizeWildPokemonHeldItems: false, banBadRandomWildPokemonHeldItems: false,
  wildLevelsModified: false, wildLevelModifier: 0, allowWildAltFormes: false,
  startersMod: 'UNCHANGED', randomizeStartersHeldItems: false, banBadRandomStarterHeldItems: false, allowStarterAltFormes: false,
  trainersMod: 'UNCHANGED', trainersUsePokemonOfSimilarStrength: false, rivalCarriesStarterThroughout: false, trainersBlockLegendaries: false,
  trainersBlockEarlyWonderGuard: false, trainersForceFullyEvolved: false, trainersForceFullyEvolvedLevel: 30, trainersLevelModified: false,
  trainersLevelModifier: 0, additionalBossTrainerPokemon: 0, additionalImportantTrainerPokemon: 0, additionalRegularTrainerPokemon: 0,
  randomizeHeldItemsForBossTrainerPokemon: false, betterTrainerMovesets: false, randomizeTrainerNames: false, randomizeTrainerClassNames: false,
  typesMod: 'UNCHANGED', dualTypeOnly: false, abilitiesMod: 'UNCHANGED', abilitiesFollowEvolutions: true, allowWonderGuard: false,
  banTrappingAbilities: true, banNegativeAbilities: true, banBadAbilities: false, baseStatisticsMod: 'UNCHANGED', baseStatsFollowEvolutions: true,
  evolutionsMod: 'UNCHANGED', evosSimilarStrength: false, evosSameTyping: false, evosMaxThreeStages: false, evosForceChange: false,
  changeImpossibleEvolutions: false, makeEvolutionsEasier: false, removeTimeBasedEvolutions: false, standardizeEXPCurves: false,
  movesetsMod: 'UNCHANGED', startWithGuaranteedMoves: false, guaranteedMoveCount: 2, reorderDamagingMoves: false, movesetsForceGoodDamaging: false,
  movesetsGoodDamagingPercent: 0, blockBrokenMovesetMoves: false, randomizeMovePowers: false, randomizeMoveAccuracies: false, randomizeMoveTypes: false,
  tmsMod: 'UNCHANGED', keepFieldMoveTMs: true, tmsHmsCompatibilityMod: 'UNCHANGED', fullHMCompat: false, moveTutorMovesMod: 'UNCHANGED',
  moveTutorsCompatibilityMod: 'UNCHANGED', fieldItemsMod: 'UNCHANGED', banBadRandomFieldItems: false, shopItemsMod: 'UNCHANGED', banOPShopItems: false,
  guaranteeEvolutionItems: false, guaranteeXItems: false, balanceShopPrices: false, pickupItemsMod: 'UNCHANGED', inGameTradesMod: 'UNCHANGED',
  randomizeInGameTradesNicknames: false, randomizeInGameTradesIVs: false, randomizeInGameTradesItems: false, staticPokemonMod: 'UNCHANGED',
  // added in 2.1 – UPR defaults
  balanceShakingGrass: false, trainersMatchTypingDistribution: false, allowTrainerAlternateFormes: false, eliteFourUniquePokemonNumber: 0,
  randomizeHeldItemsForImportantTrainerPokemon: false, randomizeHeldItemsForRegularTrainerPokemon: false, sensibleItemsOnlyForTrainerPokemon: false,
  consumableItemsOnlyForTrainerPokemon: false, highestLevelOnlyGetsItemsForTrainerPokemon: false,
  limitMainGameLegendaries: false, limit600: false, staticLevelModified: false, staticLevelModifier: 0,
  ensureTwoAbilities: false, weighDuplicateAbilitiesTogether: false, assignEvoStatsRandomly: false,
  updateBaseStats: false, updateBaseStatsToGeneration: 9, selectedEXPCurve: 'MEDIUM_FAST', expCurveMod: 'LEGENDARIES',
  updateMoves: false, updateMovesToGeneration: 9, randomizeMovePPs: false, randomizeMoveCategory: false,
  tmsForceGoodDamaging: false, tmsGoodDamagingPercent: 0, blockBrokenTMMoves: false, tmLevelUpMoveSanity: false, tmsFollowEvolutions: false,
  keepFieldMoveTutors: false, tutorsForceGoodDamaging: false, tutorsGoodDamagingPercent: 0, blockBrokenTutorMoves: false,
  tutorLevelUpMoveSanity: false, tutorFollowEvolutions: false,
  banBadRandomShopItems: false, banRegularShopItems: false, banBadRandomPickupItems: false, randomizeInGameTradesOTs: false,
  '@miscTweaks': [],
};
/** Defaults for every exposed option (a fresh "everything unchanged" setup). */
export const DEFAULT_VALUES = BASE;

export const PRESETS = [
  {
    id: 'soullink',
    name: 'Classic',
    badge: 'Recommended',
    description: 'Random wild Pokémon & starters (similar strength); trainers keep their original teams. Fair, exciting, no broken movesets.',
    values: {
      ...BASE,
      wildPokemonMod: 'RANDOM', wildPokemonRestrictionMod: 'SIMILAR_STRENGTH', useTimeBasedEncounters: true, blockWildLegendaries: true,
      useMinimumCatchRate: true, minimumCatchRateLevel: 2,
      startersMod: 'RANDOM_WITH_TWO_EVOLUTIONS', randomizeStartersHeldItems: false,
      inGameTradesMod: 'RANDOMIZE_GIVEN', fullHMCompat: true,
      '@miscTweaks': ['FASTEST_TEXT', 'NATIONAL_DEX_AT_START', 'FASTER_HP_AND_EXP_BARS'],
    },
  },
  {
    id: 'soullink-trainers',
    name: 'Classic + trainers',
    badge: 'Variety',
    description: 'Like classic, plus random trainer teams of similar strength (rival keeps their starter, bosses get +1 Pokémon).',
    values: {
      ...BASE,
      wildPokemonMod: 'RANDOM', wildPokemonRestrictionMod: 'SIMILAR_STRENGTH', useTimeBasedEncounters: true, blockWildLegendaries: true,
      useMinimumCatchRate: true, minimumCatchRateLevel: 2,
      startersMod: 'RANDOM_WITH_TWO_EVOLUTIONS',
      trainersMod: 'RANDOM', trainersUsePokemonOfSimilarStrength: true, rivalCarriesStarterThroughout: true, trainersBlockLegendaries: true,
      trainersBlockEarlyWonderGuard: true, trainersForceFullyEvolved: true, trainersForceFullyEvolvedLevel: 45, additionalBossTrainerPokemon: 1,
      randomizeHeldItemsForBossTrainerPokemon: true, betterTrainerMovesets: true,
      inGameTradesMod: 'RANDOMIZE_GIVEN', fullHMCompat: true,
      '@miscTweaks': ['FASTEST_TEXT', 'NATIONAL_DEX_AT_START', 'FASTER_HP_AND_EXP_BARS'],
    },
  },
  {
    id: 'hardcore',
    name: 'Nuzlocke hard mode',
    badge: 'Hard',
    description: 'Like classic + trainers, but tougher: +20 % trainer levels, extra Pokémon for bosses and rivals, sensible held items, smarter movesets.',
    values: {
      ...BASE,
      wildPokemonMod: 'RANDOM', wildPokemonRestrictionMod: 'SIMILAR_STRENGTH', useTimeBasedEncounters: true, blockWildLegendaries: true,
      useMinimumCatchRate: true, minimumCatchRateLevel: 2,
      startersMod: 'RANDOM_WITH_TWO_EVOLUTIONS',
      trainersMod: 'RANDOM', trainersUsePokemonOfSimilarStrength: true, rivalCarriesStarterThroughout: true, trainersBlockLegendaries: true,
      trainersBlockEarlyWonderGuard: true, trainersForceFullyEvolved: true, trainersForceFullyEvolvedLevel: 40,
      trainersLevelModified: true, trainersLevelModifier: 20, additionalBossTrainerPokemon: 1, additionalImportantTrainerPokemon: 1,
      randomizeHeldItemsForBossTrainerPokemon: true, randomizeHeldItemsForImportantTrainerPokemon: true, sensibleItemsOnlyForTrainerPokemon: true,
      betterTrainerMovesets: true,
      changeImpossibleEvolutions: true, inGameTradesMod: 'RANDOMIZE_GIVEN', fullHMCompat: true,
      '@miscTweaks': ['FASTEST_TEXT', 'NATIONAL_DEX_AT_START', 'FASTER_HP_AND_EXP_BARS'],
    },
  },
  {
    id: 'chaos',
    name: 'Chaos',
    badge: 'Wild',
    description: 'Almost everything random: types, abilities, evolutions, movesets, TMs, items. Not for the faint of heart.',
    values: {
      ...BASE,
      wildPokemonMod: 'RANDOM', useTimeBasedEncounters: true, blockWildLegendaries: true, useMinimumCatchRate: true, minimumCatchRateLevel: 3,
      startersMod: 'COMPLETELY_RANDOM',
      trainersMod: 'RANDOM', trainersUsePokemonOfSimilarStrength: true, rivalCarriesStarterThroughout: true, trainersBlockEarlyWonderGuard: true,
      typesMod: 'RANDOM_FOLLOW_EVOLUTIONS', abilitiesMod: 'RANDOMIZE', evolutionsMod: 'RANDOM', evosSimilarStrength: true, evosMaxThreeStages: true,
      changeImpossibleEvolutions: true, movesetsMod: 'RANDOM_PREFER_SAME_TYPE', startWithGuaranteedMoves: true, guaranteedMoveCount: 4,
      movesetsForceGoodDamaging: true, movesetsGoodDamagingPercent: 40, blockBrokenMovesetMoves: true, tmsMod: 'RANDOM',
      tmsHmsCompatibilityMod: 'RANDOM_PREFER_TYPE', fullHMCompat: true, moveTutorMovesMod: 'RANDOM', moveTutorsCompatibilityMod: 'RANDOM_PREFER_TYPE',
      fieldItemsMod: 'RANDOM_EVEN', banBadRandomFieldItems: true, inGameTradesMod: 'RANDOMIZE_GIVEN_AND_REQUESTED',
      '@miscTweaks': ['FASTEST_TEXT', 'NATIONAL_DEX_AT_START', 'FASTER_HP_AND_EXP_BARS'],
    },
  },
  {
    id: 'vanilla-plus',
    name: 'Vanilla+',
    badge: 'Original',
    description: 'The original Pokémon everywhere, with quality-of-life fixes: no trade evolutions, better catch rates, moves and stats as in newer games, faster text.',
    values: {
      ...BASE,
      useMinimumCatchRate: true, minimumCatchRateLevel: 2, changeImpossibleEvolutions: true,
      updateMoves: true, updateMovesToGeneration: 9, updateBaseStats: true, updateBaseStatsToGeneration: 9,
      '@miscTweaks': ['FASTEST_TEXT', 'NATIONAL_DEX_AT_START', 'FASTER_HP_AND_EXP_BARS', 'RUN_WITHOUT_RUNNING_SHOES'],
    },
  },
  {
    id: 'light',
    name: 'Wild only',
    badge: 'Light',
    description: 'Only wild Pokémon are random; everything else stays as in the original game.',
    values: {
      ...BASE,
      wildPokemonMod: 'RANDOM', wildPokemonRestrictionMod: 'SIMILAR_STRENGTH', useTimeBasedEncounters: true, blockWildLegendaries: true,
      '@miscTweaks': ['NATIONAL_DEX_AT_START'],
    },
  },
];

/**
 * Stable i18n keys for every user-visible string above. The UI translates with
 * localizeRandomizer(t) – the English text in this file is the fallback/source text.
 */
export const rndKey = {
  group: (groupId) => `rnd.group.${groupId}`,
  label: (fieldKey) => `rnd.${fieldKey}`,
  help: (fieldKey) => `rnd.${fieldKey}.help`,
  option: (fieldKey, value) => `rnd.${fieldKey}.${value}`,
  preset: (presetId, part) => `rnd.preset.${presetId}.${part}`, // part: name | badge | description
  tweak: (tweakId) => `rnd.tweak.${tweakId}`,
};

/** Translated copies of OPTION_GROUPS / PRESETS / MISC_TWEAK_LABELS. `t` is web/lib/i18n.mjs' t(key, fallback). */
export function localizeRandomizer(t) {
  return {
    groups: OPTION_GROUPS.map((g) => ({
      ...g,
      title: t(rndKey.group(g.id), g.title),
      fields: g.fields.map((f) => ({
        ...f,
        label: t(rndKey.label(f.key), f.label),
        help: f.help ? t(rndKey.help(f.key), f.help) : f.help,
        // numeric options ("Gen 6" …) read the same in every language
        options: f.options ? f.options.map(([v, l, more]) => [v, f.numeric ? l : t(rndKey.option(f.key, v), l), more]) : f.options,
      })),
    })),
    presets: PRESETS.map((p) => ({
      ...p,
      name: t(rndKey.preset(p.id, 'name'), p.name),
      badge: t(rndKey.preset(p.id, 'badge'), p.badge),
      description: t(rndKey.preset(p.id, 'description'), p.description),
    })),
    tweaks: Object.fromEntries(Object.entries(MISC_TWEAK_LABELS).map(([k, l]) => [k, t(rndKey.tweak(k), l)])),
  };
}

/** { key: English } for every randomizer string – for the i18n extractor (keys are built dynamically). */
export function randomizerStrings() {
  const out = {};
  localizeRandomizer((key, english) => {
    out[key] = english;
    return english;
  });
  return out;
}

const FIELDS = new Map(OPTION_GROUPS.flatMap((g) => g.fields).filter((f) => f.type !== 'head').map((f) => [f.key, f]));
const isOn = (v) => !!v && v !== 'UNCHANGED' && v !== 'NONE';

/** Does field `f` matter with these values, i.e. is its whole dependsOn chain switched on? */
export function fieldActive(f, values) {
  const dep = f.dependsOn;
  if (!dep) return true;
  const holds = (key, test) => {
    const parent = FIELDS.get(key);
    return test(values[key] ?? BASE[key]) && (!parent || fieldActive(parent, values));
  };
  if (Array.isArray(dep)) return dep.some((k) => holds(k, isOn));
  if (typeof dep === 'object') return holds(dep.key, (v) => dep.in.includes(v));
  return holds(dep, isOn);
}

/** Is a field (or a select option's extra object) meant for games of generation `gen`? Unknown gen → yes. */
export const forGen = (item, gen) => !gen || !item?.gens || (gen >= item.gens[0] && gen <= item.gens[1]);

/** Preset or saved values completed with the defaults – what New Run starts editing from. */
export const withDefaults = (values) => ({ ...BASE, ...(values || {}) });

/**
 * Do two option sets build the same game? Missing keys count as their default and options whose
 * parent is off in both are ignored – so an old run's values still match the preset they came from.
 */
export function sameSettings(a = {}, b = {}) {
  const A = withDefaults(a);
  const B = withDefaults(b);
  for (const f of FIELDS.values()) {
    if (!fieldActive(f, A) && !fieldActive(f, B)) continue;
    if (JSON.stringify(A[f.key]) !== JSON.stringify(B[f.key])) return false;
  }
  const tweaks = (v) => JSON.stringify([...new Set(v['@miscTweaks'] || [])].sort());
  if (tweaks(A) !== tweaks(B)) return false;
  // keys this version doesn't know (e.g. from a newer app) have to match exactly
  const other = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !FIELDS.has(k) && k !== '@miscTweaks'));
  return [...other].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

// UPR's GUI switches these off for "new evolution every level" – with them on, UPR loops (follow
// evolutions over endless evolution chains) or the option makes no sense.
const EVERY_LEVEL_OFF = ['baseStatsFollowEvolutions', 'abilitiesFollowEvolutions', 'tmsFollowEvolutions', 'tutorFollowEvolutions',
  'changeImpossibleEvolutions', 'makeEvolutionsEasier', 'removeTimeBasedEvolutions', 'trainersForceFullyEvolved', 'rivalCarriesStarterThroughout',
  'evosSimilarStrength', 'evosMaxThreeStages'];

/**
 * The values a new run is built with: options the game's generation doesn't have go back to their
 * default (e.g. extra trainer Pokémon crash UPR on Gen 2) and the GUI's rules for "new every level" apply.
 * Only for creating a run – the result is stored in the run, so the partner builds with exactly these.
 */
export function buildValues(values, gen) {
  const v = { ...values };
  for (const f of FIELDS.values()) {
    if (!(f.key in v)) continue;
    if (!forGen(f, gen)) v[f.key] = BASE[f.key];
    const opt = f.options?.find(([o]) => o === v[f.key]);
    if (opt && !forGen(opt[2], gen)) v[f.key] = opt[2].fallback ?? BASE[f.key];
  }
  if (v.evolutionsMod === 'RANDOM_EVERY_LEVEL') {
    for (const k of EVERY_LEVEL_OFF) if (k in v) v[k] = false;
    if (v.typesMod === 'RANDOM_FOLLOW_EVOLUTIONS') v.typesMod = 'COMPLETELY_RANDOM';
    if (v.startersMod === 'RANDOM_WITH_TWO_EVOLUTIONS') v.startersMod = 'COMPLETELY_RANDOM';
  }
  return v;
}
/** Can the user change this field right now? (dependsOn chain on, not overridden by "new every level") */
export const fieldEnabled = (f, values) => fieldActive(f, values) && !(values.evolutionsMod === 'RANDOM_EVERY_LEVEL' && EVERY_LEVEL_OFF.includes(f.key));

/**
 * Keep only known options with valid values (bools, clamped ints, existing select values, known tweaks).
 * Used for saved presets – never for a run's values, which must reach the bridge untouched.
 */
export function sanitizeValues(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    if (k === '@miscTweaks') {
      if (Array.isArray(v)) out[k] = [...new Set(v.filter((x) => typeof x === 'string' && Object.hasOwn(MISC_TWEAK_LABELS, x)))];
      continue;
    }
    const f = FIELDS.get(k);
    if (!f) continue;
    if (f.type === 'bool') {
      if (typeof v === 'boolean') out[k] = v;
    } else if (f.type === 'int') {
      const n = Number(v);
      if (v !== null && v !== '' && Number.isFinite(n)) out[k] = Math.max(f.min, Math.min(f.max, Math.round(n)));
    } else {
      const opt = f.options.find(([o]) => String(o) === String(v));
      if (opt) out[k] = opt[0];
    }
  }
  return out;
}

/** Turn an options object into the properties text the Java bridge reads. */
export function toProperties(values, { baseSettingsString } = {}) {
  // Values can come from an invite pack (the partner): no line breaks or '=' that would smuggle in extra keys.
  const clean = (s) => String(s).replace(/[\r\n=]/g, '');
  const lines = ['# souldew → UPR ZX settings'];
  // (a UPR settings string is base64 – its '=' padding must stay; only line breaks are removed)
  if (baseSettingsString) lines.push(`@base=${String(baseSettingsString).replace(/[\r\n]/g, '')}`);
  for (const [k, v] of Object.entries(values || {})) {
    const key = clean(k).replace(/[\s:#!]/g, '');
    if (!key) continue;
    if (key === '@miscTweaks') lines.push(`@miscTweaks=${[].concat(v || []).map(clean).join(',')}`);
    else if (v !== undefined && v !== null) lines.push(`${key}=${clean(v)}`);
  }
  return lines.join('\n') + '\n';
}

export function randomSeed() {
  // Java long; keep it positive and < 2^53 so it survives JSON / JS numbers if ever parsed.
  const hi = Math.floor(Math.random() * 0x1fffff);
  const lo = Math.floor(Math.random() * 0x100000000);
  return String(hi * 0x100000000 + lo);
}
