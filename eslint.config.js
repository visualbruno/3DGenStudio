import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output plus the git-ignored local installs: the managed-ComfyUI
  // reference env (comfyui/, ~12 GB with its venv) and the Python venvs carry
  // thousands of bundled .js files, and walking them runs ESLint out of memory.
  globalIgnores(['dist', 'release', 'data', 'comfyui', '.kilo', '.vs', '**/.venv', '**/venv', 'thirdparty/**/checkpoints', 'thirdparty/**/build']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    // Determinism guard for the VFX modules. Every one of the timeline
    // scrubber, the thumbnail generator and the engine exporters assumes that
    // the same seed replays the same effect, and a single Math.random anywhere
    // under these paths quietly breaks all three at once. The failure mode is
    // "it looks different every time I hit play", which is miserable to trace
    // back to its cause, so it is worth catching mechanically rather than in
    // review. See the header of vfx/random.js for the seeded alternatives.
    files: ['vfx/**/*.js', 'src/utils/vfx/**/*.js'],
    rules: {
      'no-restricted-properties': ['error', {
        object: 'Math',
        property: 'random',
        message: 'VFX code must be deterministic: use pcgAt / pcgHash2 / pcgFloat from vfx/random.js.',
      }],
    },
  },
  {
    // The same guard for the building generator, for the same reasons and one
    // more. A stored building is a ~20KB spec that has to regenerate its mesh
    // bit-for-bit: the live preview re-evaluates on every slider drag, the
    // thumbnail is rendered once and must keep matching, and the export has to
    // produce the building the author actually approved. A single Math.random
    // anywhere under these paths breaks all three, and the symptom - "the
    // windows move when I change the floor count" - reads as a design flaw
    // rather than a bug, so it is caught mechanically. building/random.js is
    // the only sanctioned source of randomness; see its header for why a slot's
    // seed is a hash of its identity rather than a position in a stream.
    files: ['building/**/*.js', 'src/utils/building/**/*.js'],
    rules: {
      'no-restricted-properties': ['error', {
        object: 'Math',
        property: 'random',
        message: 'Building code must be deterministic: use randomAt / instanceSeed / slotId from building/random.js.',
      }],
    },
  },
])
