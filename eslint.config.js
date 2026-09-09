import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
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
])
