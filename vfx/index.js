// The VFX contract: everything about a VFX effect that both the browser and
// the backend have to agree on.
//
// WHY THIS IS A ROOT DIRECTORY and not src/utils/vfx/. The server needs the
// document schema (to validate an imported .vfx.json), the catalog (to build
// the engine-mapping table) and the compiler (to produce the IR an export
// bundle carries) - and src/ IS NOT SHIPPED in a packaged build. Only dist/
// is. So shared code cannot live under src/ without breaking the desktop app
// and the Docker image, which is why db/ and mcp/ are laid out the same way.
//
// THREE BUILD REGISTRATIONS ARE MANDATORY for that to hold, and the repo has
// been bitten by forgetting them before - serverMode.js:90 notes that user
// asset directories shipped missing twice. They are:
//
//   electron-builder.yml  files:            - vfx/**/*
//   Dockerfile                              COPY --chown=node:node vfx ./vfx
//   .dockerignore                           !vfx/
//
// The .dockerignore entry is needed TWICE OVER: the builder stage's `COPY . .`
// is filtered by that allowlist too, so without it the FRONTEND build also
// fails to resolve ../../vfx/*.js and the whole image build dies at vite.
//
// WHAT BELONGS HERE: pure, environment-neutral modules. No React, no three.js,
// no fs, no process. Everything in this directory has to run identically in a
// browser tab, in Node, and inside a test harness - which is also what makes
// it all testable with plain `node vfx/*.test.mjs`.
//
// WHAT DOES NOT: the simulation itself and anything that touches the GPU. The
// particle pool, the kernels, the batched renderer and the R3F components live
// in src/utils/vfx/ and src/components/vfx/, because only the preview runs
// them - the engine importers consume the IR instead.

export {
  BAKE_ERROR_PROBE_SAMPLES,
  BAKE_SAMPLE_LADDER,
  DEFAULT_MAX_BAKE_ERROR,
  DEFAULT_MAX_GRADIENT_BAKE_ERROR,
} from './bake.js';

export {
  PCG_STATE_WORDS,
  pcgAt,
  pcgFloat,
  pcgFloatAt,
  pcgHash2,
  pcgInit,
  pcgNext,
  pcgReseed,
  triple32,
} from './random.js';

export {
  CURVE_INTERP,
  CURVE_PRESETS,
  CURVE_WRAP,
  bakeCurve,
  chooseCurveSampleCount,
  constantCurve,
  createCurve,
  createCurveKey,
  curveExtent,
  curveHasSteps,
  curveToUnityKeyframes,
  curveToUnrealRichCurve,
  evalCurve,
  evalCurveLut,
  linearCurve,
} from './curve.js';

export {
  GRADIENT_MODE,
  GRADIENT_PRESETS,
  bakeGradient,
  chooseGradientSampleCount,
  createAlphaKey,
  createColorKey,
  createGradient,
  evalGradient,
  evalGradientLut,
  gradientAlphaExtent,
  gradientMaxComponent,
  gradientMeanLuminance,
  gradientToUnityGradient,
  gradientToUnrealCurveLinearColor,
  hexToSrgb,
  linearToSrgb,
  srgbToHex,
  srgbToLinear,
} from './gradient.js';

export {
  RANDOM_FREQ,
  VALUE_DOMAIN,
  VALUE_MODE,
  constFold,
  constValue,
  curveValue,
  describeValue,
  exposedValue,
  gradientValue,
  isAnimated,
  linkValue,
  modeSwitchLosesWork,
  normalizeValue,
  randomValue,
  readValue,
  setValueMode,
  valueChannels,
  valueRange,
} from './value.js';

export {
  CONTEXT_KIND,
  FLOW_ORDER,
  MIGRATIONS,
  REF_KIND,
  VFX_DOC_FORMAT,
  VFX_DOC_KIND,
  collectVfxAssetRefs,
  createClip,
  createEffectSettings,
  createEmptyVfxDoc,
  formatAssetRef,
  nextVfxId,
  normalizeVfxDoc,
  parseAssetRef,
  serializeVfxDoc,
  vfxSignature,
} from './doc.js';
