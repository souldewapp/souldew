// Lint setup: `npm run lint`. Plain ESM everywhere – browser code in web/, Node in server/, electron/,
// scripts/ and test/, and shared/ runs in both.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['web/vendor/**', 'node_modules/**', 'dist/**', 'tools/**', 'runs/**', 'library/**', 'research/**', '_ref/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      'no-eval': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  { files: ['web/**/*.mjs'], languageOptions: { globals: globals.browser } },
  // the website (site/): a classic browser script, no modules
  { files: ['site/**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.browser }, rules: { eqeqeq: ['error', 'always', { null: 'ignore' }], 'no-var': 'error', 'prefer-const': 'error' } },
  // AudioWorkletGlobalScope (not in this version of `globals`)
  { files: ['web/lib/turboaudio-worklet.mjs', 'web/lib/ctr-audio-worklet.mjs', 'web/lib/native-audio-worklet.mjs'], languageOptions: { globals: { sampleRate: 'readonly', currentTime: 'readonly', AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly' } } },
  { files: ['server/**/*.mjs', 'electron/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'], languageOptions: { globals: globals.node } },
  // the preload script (CommonJS, sandboxed: require + a limited process object)
  { files: ['electron/**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  // file and player names are cleaned of control characters on purpose (/[\u0000-\u001f]/)
  { files: ['server/**/*.mjs'], rules: { 'no-control-regex': 'off' } },
  { files: ['shared/**/*.mjs'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  // tests stub browser globals (fetch, document, localStorage …) to run browser modules in Node
  { files: ['test/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
