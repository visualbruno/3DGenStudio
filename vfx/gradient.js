// Colour-over-life gradients: representation, evaluation, and the bake to the
// linear RGBA table the simulation samples.
//
// THREE DECISIONS, each of which has a wrong version that looks fine at first.
//
// 1. COLOUR AND ALPHA ARE SEPARATE KEY LISTS. Unity's Gradient has
//    independent colorKeys and alphaKeys arrays with independent counts, and
//    Niagara likewise drives colour and opacity from separate curves. A merged
//    list cannot round-trip either of them: an author with three colour stops
//    and seven alpha stops would come back from a save with something else.
//    Keeping them apart also matches how effects are actually authored - the
//    fade is usually simple while the colour ramp is not, or vice versa.
//
// 2. A STOP STORES ITS HEX PLUS AN INTENSITY, not a linear triple. Storing
//    only linear RGB loses which colour the author picked: linear
//    (4.0, 2.0, 1.0) could be #FF8040 at intensity 4, or a dimmer hex at a
//    higher intensity, and the picker cannot show the author what they chose.
//    Hex is also readable and diffable in the saved JSON, and the split is
//    exactly how Unity's HDR colour field behaves. Linear RGB is DERIVED, by
//    evalGradient.
//
// 3. INTERPOLATION HAPPENS IN LINEAR SPACE, and values may exceed 1. Additive
//    and emissive particles are light, and light adds linearly - a gradient
//    interpolated in sRGB darkens through its midpoints in a way that reads as
//    a muddy band halfway through every fade. Allowing above 1 is what makes a
//    spark core able to blow out through the tonemapper the way a real
//    overexposed spark does.
//
//    CONSEQUENCE FOR THE UI, worth knowing before building the gradient
//    editor: the preview bar must be drawn by sampling evalGradient and
//    encoding to sRGB per pixel. A CSS linear-gradient interpolates in sRGB
//    and would therefore show the author a ramp that is not the ramp the
//    simulation runs - which defeats the entire purpose of a preview.

// Bake sizing policy is shared with vfx/curve.js; see vfx/bake.js.
import {
  BAKE_ERROR_PROBE_SAMPLES,
  BAKE_SAMPLE_LADDER,
  DEFAULT_MAX_GRADIENT_BAKE_ERROR,
} from './bake.js';

/** How a gradient interpolates between stops. */
export const GRADIENT_MODE = Object.freeze({
  /** Smooth blend between neighbouring stops. */
  BLEND: 'blend',
  /** Hard bands - each stop holds until the next. For sprite-sheet looks. */
  FIXED: 'fixed',
});

// Rec. 709 luminance weights, applied to LINEAR values. Used by the
// additive-blend diagnostic, which asks "is this ramp bright enough to be
// visible when added to the scene".
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * @typedef {Object} VfxGradientColorKey
 * @property {number} t normalised time, 0..1
 * @property {string} hex sRGB hex, "#rrggbb"
 * @property {number} intensity linear multiplier; 1 is the plain colour, above
 *   1 is HDR and will blow out through the tonemapper
 */

/**
 * @typedef {Object} VfxGradientAlphaKey
 * @property {number} t normalised time, 0..1
 * @property {number} a 0..1
 */

/**
 * @typedef {Object} VfxGradient
 * @property {VfxGradientColorKey[]} colorKeys ascending by t, at least one
 * @property {VfxGradientAlphaKey[]} alphaKeys ascending by t, at least one
 * @property {'blend'|'fixed'} mode
 */

/**
 * sRGB component (0..1) to linear. The IEC 61966-2-1 transfer function, not
 * the pow(2.2) approximation: the app already carries one sRGB round-trip bug
 * per the header of src/utils/assemblyAtlasBake.js, and matching three.js and
 * both engines exactly costs nothing here.
 *
 * @param {number} c 0..1
 * @returns {number}
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Linear component to sRGB (0..1). Needed by the editor to draw a gradient the
 * author can trust, and by the thumbnail path.
 *
 * @param {number} c
 * @returns {number}
 */
export function linearToSrgb(c) {
  if (!(c > 0)) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Parse "#rgb" or "#rrggbb" to three sRGB components in 0..1. Unparseable
 * input becomes white rather than throwing: this runs on documents that may
 * have been hand-edited, and a white particle is a visible, obvious problem
 * whereas an exception during a bake is not.
 *
 * @param {string} hex
 * @returns {[number, number, number]}
 */
const HEX_PATTERN = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Is this a colour this app can read?
 *
 * Exported so the compiler can REPORT a bad one rather than leaving hexToSrgb
 * to swallow it - see W_BAD_COLOR.
 *
 * @param {unknown} hex
 * @returns {boolean}
 */
export function isValidHex(hex) {
  return typeof hex === 'string' && HEX_PATTERN.test(hex.trim());
}

export function hexToSrgb(hex) {
  const text = String(hex || '').trim().replace(/^#/, '');

  // MATCHED IN FULL, NOT PARSED LENIENTLY, and this is a real bug being fixed
  // rather than tidiness. parseInt STOPS at the first character it cannot read
  // and returns what it got so far; it only yields NaN when the FIRST character
  // is bad. So "c96a<full-width 2>b" - six characters, with a full-width 2 that an
  // editor or a paste can introduce invisibly - parsed as "c96a" and became a
  // TEAL, while the author had typed an orange. Number.isFinite never saw a
  // problem. A wrong colour that looks deliberate is far worse than white.
  if (!HEX_PATTERN.test(text)) return [1, 1, 1];

  if (text.length === 3) {
    return [
      parseInt(text[0] + text[0], 16) / 255,
      parseInt(text[1] + text[1], 16) / 255,
      parseInt(text[2] + text[2], 16) / 255,
    ];
  }
  const n = parseInt(text, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Three sRGB components in 0..1 to "#rrggbb".
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string}
 */
export function srgbToHex(r, g, b) {
  const byte = (c) => Math.max(0, Math.min(255, Math.round(c * 255)));
  const n = (byte(r) << 16) | (byte(g) << 8) | byte(b);
  return `#${n.toString(16).padStart(6, '0')}`;
}

/**
 * @param {Partial<VfxGradientColorKey>} [key]
 * @returns {VfxGradientColorKey}
 */
export function createColorKey(key = {}) {
  return {
    t: Number.isFinite(key.t) ? Math.min(1, Math.max(0, key.t)) : 0,
    hex: typeof key.hex === 'string' ? key.hex : '#ffffff',
    // Intensity below zero is not a colour, it is a bug. Clamp rather than
    // reject, for the same reason hexToSrgb falls back instead of throwing.
    intensity: Number.isFinite(key.intensity) && key.intensity >= 0 ? key.intensity : 1,
  };
}

/**
 * @param {Partial<VfxGradientAlphaKey>} [key]
 * @returns {VfxGradientAlphaKey}
 */
export function createAlphaKey(key = {}) {
  return {
    t: Number.isFinite(key.t) ? Math.min(1, Math.max(0, key.t)) : 0,
    a: Number.isFinite(key.a) ? Math.min(1, Math.max(0, key.a)) : 1,
  };
}

/**
 * Build a gradient, sorting and defaulting whatever the caller supplied. As
 * with createCurve, everything enters through here so nothing downstream has
 * to cope with unsorted or empty key lists.
 *
 * @param {{colorKeys?: Array<Partial<VfxGradientColorKey>>,
 *          alphaKeys?: Array<Partial<VfxGradientAlphaKey>>,
 *          mode?: string}} [spec]
 * @returns {VfxGradient}
 */
export function createGradient(spec = {}) {
  const colorKeys = (Array.isArray(spec.colorKeys) ? spec.colorKeys : []).map(createColorKey);
  const alphaKeys = (Array.isArray(spec.alphaKeys) ? spec.alphaKeys : []).map(createAlphaKey);
  colorKeys.sort((a, b) => a.t - b.t);
  alphaKeys.sort((a, b) => a.t - b.t);
  if (colorKeys.length === 0) colorKeys.push(createColorKey({ t: 0, hex: '#ffffff' }));
  if (alphaKeys.length === 0) alphaKeys.push(createAlphaKey({ t: 0, a: 1 }));
  return {
    colorKeys,
    alphaKeys,
    mode: spec.mode === GRADIENT_MODE.FIXED ? GRADIENT_MODE.FIXED : GRADIENT_MODE.BLEND,
  };
}

// The linear RGB a colour stop resolves to. Written into out to keep the bake
// allocation-free.
function resolveColorKey(key, out) {
  const [r, g, b] = hexToSrgb(key.hex);
  out[0] = srgbToLinear(r) * key.intensity;
  out[1] = srgbToLinear(g) * key.intensity;
  out[2] = srgbToLinear(b) * key.intensity;
  return out;
}

// Module-level scratch, the house idiom. evalGradient runs per particle during
// a bake and per pixel while drawing the editor's preview bar.
const _colorA = new Float64Array(3);
const _colorB = new Float64Array(3);

// Index of the last key at or before t, or -1 if t precedes every key.
function findKeyIndex(keys, t) {
  let i = -1;
  for (let k = 0; k < keys.length; k += 1) {
    if (keys[k].t <= t) i = k;
    else break;
  }
  return i;
}

/**
 * Evaluate a gradient into linear RGBA. Non-allocating: writes four floats
 * into out and returns it.
 *
 * RGB may exceed 1 (HDR); alpha never does. Alpha is STRAIGHT, not
 * premultiplied - the material premultiplies in the shader, and doing it here
 * as well is the double-multiply that makes additive fades wrong.
 *
 * @param {VfxGradient} gradient
 * @param {number} t clamped to 0..1
 * @param {Float32Array|Float64Array|number[]} out at least 4 long
 * @returns {Float32Array|Float64Array|number[]} out
 */
export function evalGradient(gradient, t, out) {
  const clamped = t > 0 ? (t < 1 ? t : 1) : 0;
  const fixed = gradient.mode === GRADIENT_MODE.FIXED;

  const colorKeys = gradient.colorKeys;
  const ci = findKeyIndex(colorKeys, clamped);
  if (ci < 0) {
    resolveColorKey(colorKeys[0], _colorA);
    out[0] = _colorA[0];
    out[1] = _colorA[1];
    out[2] = _colorA[2];
  } else if (ci >= colorKeys.length - 1 || fixed) {
    resolveColorKey(colorKeys[ci], _colorA);
    out[0] = _colorA[0];
    out[1] = _colorA[1];
    out[2] = _colorA[2];
  } else {
    const a = colorKeys[ci];
    const b = colorKeys[ci + 1];
    const span = b.t - a.t;
    const f = span > 1e-9 ? (clamped - a.t) / span : 0;
    resolveColorKey(a, _colorA);
    resolveColorKey(b, _colorB);
    out[0] = _colorA[0] + (_colorB[0] - _colorA[0]) * f;
    out[1] = _colorA[1] + (_colorB[1] - _colorA[1]) * f;
    out[2] = _colorA[2] + (_colorB[2] - _colorA[2]) * f;
  }

  const alphaKeys = gradient.alphaKeys;
  const ai = findKeyIndex(alphaKeys, clamped);
  if (ai < 0) out[3] = alphaKeys[0].a;
  else if (ai >= alphaKeys.length - 1 || fixed) out[3] = alphaKeys[ai].a;
  else {
    const a = alphaKeys[ai];
    const b = alphaKeys[ai + 1];
    const span = b.t - a.t;
    const f = span > 1e-9 ? (clamped - a.t) / span : 0;
    out[3] = a.a + (b.a - a.a) * f;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
//
// Pure and immutable, and here for the same reasons as the curve editors: the
// sort is the difficulty, and the sort is what an index-based selection gets
// wrong the moment a stop is dragged past its neighbour. Every mutator returns
// the new gradient AND the index the touched stop ended up at.
//
// COLOUR AND ALPHA ARE SEPARATE LISTS and stay separate. Unity's Gradient is
// two lists, so merging them would not round-trip: a colour stop at t=0.3 and
// an alpha stop at t=0.7 cannot be expressed as one list of four-component
// stops without inventing values the author never set.

/**
 * @typedef {Object} VfxGradientEdit
 * @property {VfxGradient} gradient
 * @property {number} index where the touched stop ended up, or -1
 */

function rebuildGradient(gradient, colorKeys, alphaKeys) {
  return createGradient({ colorKeys, alphaKeys, mode: gradient.mode });
}

// As sortTracking in curve.js: the identity is carried by the original index,
// because two stops may legitimately share a t while being dragged apart.
function sortTrackingKeys(keys, tracked) {
  const marked = keys.map((key, i) => ({ key, was: i }));
  marked.sort((a, b) => (a.key.t - b.key.t) || (a.was - b.was));
  return {
    keys: marked.map((entry) => entry.key),
    index: marked.findIndex((entry) => entry.was === tracked),
  };
}

/**
 * Add a colour stop.
 *
 * The colour defaults to the gradient's OWN colour at t, so clicking empty
 * rail adds a stop WITHOUT changing the look. That is the single most
 * important behaviour in a gradient editor: an author adding a stop is almost
 * always about to adjust it, and a stop that arrives as white has already
 * destroyed the ramp they were refining.
 *
 * "Without changing the look" is true to the precision the FORMAT has, not
 * exactly. Stops are stored as hex plus an intensity - because that is what
 * Unity's Gradient is, and storing floats instead would stop the round trip
 * working - so a sampled colour makes one trip through 8-bit sRGB and can come
 * back up to half a bit different. That is ~0.4% in linear light at mid tones
 * and invisible; the test asserts the bound rather than equality, and the bound
 * is a property of hex storage rather than of this function.
 *
 * @param {VfxGradient} gradient
 * @param {number} t
 * @param {{hex?: string, intensity?: number}} [spec]
 * @returns {VfxGradientEdit}
 */
export function addColorKey(gradient, t, spec = {}) {
  const clamped = Math.min(1, Math.max(0, t));
  let hex = spec.hex;
  let intensity = spec.intensity;
  if (typeof hex !== 'string') {
    const rgba = new Float64Array(4);
    evalGradient(gradient, clamped, rgba);
    // The sampled colour is linear and may exceed 1, so it is split back into a
    // hex plus an intensity the same way the inspector's colour field does -
    // otherwise sampling an HDR gradient would clamp the new stop to white.
    const peak = Math.max(rgba[0], rgba[1], rgba[2], 1);
    intensity = Number.isFinite(intensity) ? intensity : peak;
    hex = srgbToHex(
      linearToSrgb(rgba[0] / peak),
      linearToSrgb(rgba[1] / peak),
      linearToSrgb(rgba[2] / peak),
    );
  }
  const keys = [...gradient.colorKeys, createColorKey({ t: clamped, hex, intensity })];
  const sorted = sortTrackingKeys(keys, keys.length - 1);
  return {
    gradient: rebuildGradient(gradient, sorted.keys, gradient.alphaKeys),
    index: sorted.index,
  };
}

/**
 * Add an alpha stop, defaulting to the gradient's own alpha at t.
 * @param {VfxGradient} gradient
 * @param {number} t
 * @param {number} [a]
 * @returns {VfxGradientEdit}
 */
export function addAlphaKey(gradient, t, a) {
  const clamped = Math.min(1, Math.max(0, t));
  let value = a;
  if (!Number.isFinite(value)) {
    const rgba = new Float64Array(4);
    evalGradient(gradient, clamped, rgba);
    value = rgba[3];
  }
  const keys = [...gradient.alphaKeys, createAlphaKey({ t: clamped, a: value })];
  const sorted = sortTrackingKeys(keys, keys.length - 1);
  return {
    gradient: rebuildGradient(gradient, gradient.colorKeys, sorted.keys),
    index: sorted.index,
  };
}

/**
 * Patch a colour stop - its position, hex or intensity.
 * @param {VfxGradient} gradient
 * @param {number} index
 * @param {{t?: number, hex?: string, intensity?: number}} patch
 * @returns {VfxGradientEdit}
 */
export function updateColorKey(gradient, index, patch) {
  if (index < 0 || index >= gradient.colorKeys.length) return { gradient, index: -1 };
  const keys = gradient.colorKeys.map((key, i) => (
    i === index ? createColorKey({ ...key, ...patch }) : key
  ));
  const sorted = sortTrackingKeys(keys, index);
  return {
    gradient: rebuildGradient(gradient, sorted.keys, gradient.alphaKeys),
    index: sorted.index,
  };
}

/**
 * Patch an alpha stop.
 * @param {VfxGradient} gradient
 * @param {number} index
 * @param {{t?: number, a?: number}} patch
 * @returns {VfxGradientEdit}
 */
export function updateAlphaKey(gradient, index, patch) {
  if (index < 0 || index >= gradient.alphaKeys.length) return { gradient, index: -1 };
  const keys = gradient.alphaKeys.map((key, i) => (
    i === index ? createAlphaKey({ ...key, ...patch }) : key
  ));
  const sorted = sortTrackingKeys(keys, index);
  return {
    gradient: rebuildGradient(gradient, gradient.colorKeys, sorted.keys),
    index: sorted.index,
  };
}

/**
 * Remove a colour stop. The last one cannot go - createGradient would put a
 * white one back, so the author would press Delete and watch the ramp turn
 * white instead of nothing happening.
 *
 * @param {VfxGradient} gradient
 * @param {number} index
 * @returns {VfxGradientEdit}
 */
export function removeColorKey(gradient, index) {
  if (gradient.colorKeys.length <= 1) return { gradient, index: -1 };
  if (index < 0 || index >= gradient.colorKeys.length) return { gradient, index: -1 };
  const keys = gradient.colorKeys.filter((_, i) => i !== index);
  return {
    gradient: rebuildGradient(gradient, keys, gradient.alphaKeys),
    index: Math.min(index, keys.length - 1),
  };
}

/**
 * Remove an alpha stop. As above: the last one stays.
 * @param {VfxGradient} gradient
 * @param {number} index
 * @returns {VfxGradientEdit}
 */
export function removeAlphaKey(gradient, index) {
  if (gradient.alphaKeys.length <= 1) return { gradient, index: -1 };
  if (index < 0 || index >= gradient.alphaKeys.length) return { gradient, index: -1 };
  const keys = gradient.alphaKeys.filter((_, i) => i !== index);
  return {
    gradient: rebuildGradient(gradient, gradient.colorKeys, keys),
    index: Math.min(index, keys.length - 1),
  };
}

/**
 * A one-line description of a gradient, in words.
 *
 * The accessible name for the editor. Named colours rather than hex, because
 * "#ff8a1e" tells a screen-reader user nothing and "orange" tells them what
 * they need.
 *
 * @param {VfxGradient} gradient
 * @returns {string}
 */
export function describeGradient(gradient) {
  const parts = gradient.colorKeys.map((key) => (
    `${nameColor(key.hex)} at ${Math.round(key.t * 100)}%${key.intensity > 1.001 ? ` (${Math.round(key.intensity * 10) / 10}x bright)` : ''}`
  ));
  const alpha = gradient.alphaKeys.map((key) => (
    `${Math.round(key.a * 100)}% at ${Math.round(key.t * 100)}%`
  ));
  return `Colour: ${parts.join(', ')}. Opacity: ${alpha.join(', ')}.`;
}

// A coarse colour name from a hex string. Twelve buckets by hue plus the
// achromatic cases - enough to be useful in a spoken description, and
// deliberately not a 140-entry CSS colour table nobody can hear the difference
// between.
const HUE_NAMES = Object.freeze([
  'red', 'orange', 'yellow', 'lime', 'green', 'teal',
  'cyan', 'azure', 'blue', 'violet', 'magenta', 'pink',
]);

function nameColor(hex) {
  const [r, g, b] = hexToSrgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (max < 0.08) return 'black';
  if (chroma < 0.08) return max > 0.85 ? 'white' : max > 0.4 ? 'grey' : 'dark grey';

  let hue;
  if (max === r) hue = ((g - b) / chroma + 6) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;

  // hue is in SEXTANTS (0..6) from the standard HSV derivation, and there are
  // twelve names, so it doubles. Getting this wrong is silent: every colour
  // still gets a name, just the wrong half of the wheel.
  const name = HUE_NAMES[Math.round(hue * 2) % 12] || HUE_NAMES[0];
  const shade = max < 0.35 ? 'dark ' : min > 0.55 ? 'pale ' : '';
  return `${shade}${name}`;
}

/**
 * Bake to a linear RGBA table of n samples spanning t = 0..1 inclusive.
 *
 * Prefer chooseGradientSampleCount over passing a literal - see the note there
 * about why "gradients are piecewise linear so any table size is fine" is not
 * actually true.
 *
 * @param {VfxGradient} gradient
 * @param {number} [n]
 * @returns {Float32Array} n * 4 linear RGBA
 */
export function bakeGradient(gradient, n = 65) {
  const count = Math.max(2, n | 0);
  const lut = new Float32Array(count * 4);
  const last = count - 1;
  const scratch = new Float64Array(4);
  for (let i = 0; i < count; i += 1) {
    evalGradient(gradient, i / last, scratch);
    const o = i * 4;
    lut[o] = scratch[0];
    lut[o + 1] = scratch[1];
    lut[o + 2] = scratch[2];
    lut[o + 3] = scratch[3];
  }
  return lut;
}

/**
 * Sample a baked gradient table into out (4 floats). Linear between samples,
 * for the same reasons as evalCurveLut.
 *
 * @param {Float32Array} lut
 * @param {number} t clamped to 0..1
 * @param {Float32Array|Float64Array|number[]} out
 * @returns {Float32Array|Float64Array|number[]} out
 */
export function evalGradientLut(lut, t, out) {
  const count = lut.length >> 2;
  const last = count - 1;
  if (!(t > 0)) {
    out[0] = lut[0];
    out[1] = lut[1];
    out[2] = lut[2];
    out[3] = lut[3];
    return out;
  }
  if (t >= 1) {
    const o = last * 4;
    out[0] = lut[o];
    out[1] = lut[o + 1];
    out[2] = lut[o + 2];
    out[3] = lut[o + 3];
    return out;
  }
  const x = t * last;
  const i = x | 0;
  const f = x - i;
  const o = i * 4;
  const p = o + 4;
  out[0] = lut[o] + (lut[p] - lut[o]) * f;
  out[1] = lut[o + 1] + (lut[p + 1] - lut[o + 1]) * f;
  out[2] = lut[o + 2] + (lut[p + 2] - lut[o + 2]) * f;
  out[3] = lut[o + 3] + (lut[p + 3] - lut[o + 3]) * f;
  return out;
}

/**
 * Pick the smallest table size that reconstructs this gradient within
 * tolerance. Same ladder and same measured-error approach as
 * chooseCurveSampleCount, for the same reason: it measures the thing we care
 * about instead of predicting it.
 *
 * It would be tempting to skip this on the grounds that a gradient is
 * piecewise linear and linear data survives linear resampling exactly. That is
 * true only where the samples land ON the stops, and a fixed grid almost never
 * does: a stop at t=0.08 falls between the 65-entry grid's samples at 0.0781
 * and 0.0938, so the table cuts the corner at the stop. On an SDR ramp that
 * error is invisible; on an HDR core at intensity 6 it is a measurable chunk of
 * a channel, and on a tight alpha spike it is the difference between a particle
 * reaching full opacity and not quite getting there.
 *
 * Error is judged PER CHANNEL and RELATIVE to that channel's own range, which
 * is what makes one threshold meaningful across both a 0..1 alpha ramp and a
 * 0..6 HDR colour channel.
 *
 * @param {VfxGradient} gradient
 * @param {{maxError?: number}} [options] as a fraction of each channel's range
 * @returns {number}
 */
export function chooseGradientSampleCount(gradient, options = {}) {
  const maxError = Number.isFinite(options.maxError)
    ? options.maxError
    : DEFAULT_MAX_GRADIENT_BAKE_ERROR;
  const largest = BAKE_SAMPLE_LADDER[BAKE_SAMPLE_LADDER.length - 1];

  // Hard bands are discontinuous; no finite table reconstructs an edge.
  if (gradient.mode === GRADIENT_MODE.FIXED) return largest;

  // Per-channel range, from a dense probe of the reference evaluator.
  const probe = new Float64Array(4);
  const min = [Infinity, Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i <= BAKE_ERROR_PROBE_SAMPLES; i += 1) {
    evalGradient(gradient, i / BAKE_ERROR_PROBE_SAMPLES, probe);
    for (let c = 0; c < 4; c += 1) {
      if (probe[c] < min[c]) min[c] = probe[c];
      if (probe[c] > max[c]) max[c] = probe[c];
    }
  }
  const scale = [0, 1, 2, 3].map((c) => max[c] - min[c]);

  const a = new Float64Array(4);
  const b = new Float64Array(4);
  for (const n of BAKE_SAMPLE_LADDER) {
    const lut = bakeGradient(gradient, n);
    let worst = 0;
    for (let i = 0; i <= BAKE_ERROR_PROBE_SAMPLES; i += 1) {
      const t = i / BAKE_ERROR_PROBE_SAMPLES;
      evalGradient(gradient, t, a);
      evalGradientLut(lut, t, b);
      for (let c = 0; c < 4; c += 1) {
        // A flat channel is reconstructed exactly, so it cannot fail and must
        // not divide by ~zero.
        if (scale[c] <= 1e-9) continue;
        const rel = Math.abs(a[c] - b[c]) / scale[c];
        if (rel > worst) worst = rel;
      }
    }
    if (worst <= maxError) return n;
  }
  return largest;
}

/**
 * Alpha range over the whole gradient. The zero-alpha diagnostic ("nothing
 * will be visible") reads this.
 *
 * @param {VfxGradient} gradient
 * @returns {{min: number, max: number}}
 */
export function gradientAlphaExtent(gradient) {
  let min = Infinity;
  let max = -Infinity;
  for (const key of gradient.alphaKeys) {
    if (key.a < min) min = key.a;
    if (key.a > max) max = key.a;
  }
  return { min, max };
}

/**
 * Largest linear colour component anywhere in the gradient.
 *
 * Two consumers, both of which need it at compile time: the additive-blend
 * diagnostic, and the decision of whether instanced colour can be packed as
 * four normalised bytes instead of four floats. That packing halves the
 * biggest per-instance field, and it is valid exactly when nothing exceeds 1 -
 * which only the compiler can know, and only from this.
 *
 * @param {VfxGradient} gradient
 * @returns {number}
 */
export function gradientMaxComponent(gradient) {
  const scratch = new Float64Array(3);
  let max = 0;
  for (const key of gradient.colorKeys) {
    resolveColorKey(key, scratch);
    max = Math.max(max, scratch[0], scratch[1], scratch[2]);
  }
  return max;
}

/**
 * Mean Rec.709 luminance of the gradient, weighted by its own alpha.
 *
 * This is what the additive-blend diagnostic asks about: an additive particle
 * contributes light in proportion to colour times alpha, so a bright ramp at
 * 2% alpha is as invisible as a black one at full alpha, and only the product
 * distinguishes "will glow" from "will not show up at all".
 *
 * @param {VfxGradient} gradient
 * @param {number} [samples]
 * @returns {number}
 */
export function gradientMeanLuminance(gradient, samples = 64) {
  const scratch = new Float64Array(4);
  let total = 0;
  for (let i = 0; i <= samples; i += 1) {
    evalGradient(gradient, i / samples, scratch);
    total += (scratch[0] * LUMA_R + scratch[1] * LUMA_G + scratch[2] * LUMA_B) * scratch[3];
  }
  return total / (samples + 1);
}

// ---------------------------------------------------------------------------
// Engine conversions
// ---------------------------------------------------------------------------

/**
 * Unity Gradient rows. Unity's colorKeys carry an HDR Color, so intensity is
 * folded into the linear components; its alphaKeys stay separate, which is the
 * shape we already store. Note Unity gradients cap at 8 keys per channel - the
 * importer has to report, not silently drop, anything beyond that, so the
 * count is returned rather than trimmed here.
 *
 * @param {VfxGradient} gradient
 * @returns {{mode: string,
 *            colorKeys: Array<{time: number, linear: [number, number, number]}>,
 *            alphaKeys: Array<{time: number, alpha: number}>}}
 */
export function gradientToUnityGradient(gradient) {
  const scratch = new Float64Array(3);
  return {
    mode: gradient.mode === GRADIENT_MODE.FIXED ? 'Fixed' : 'Blend',
    colorKeys: gradient.colorKeys.map((key) => {
      resolveColorKey(key, scratch);
      return { time: key.t, linear: [scratch[0], scratch[1], scratch[2]] };
    }),
    alphaKeys: gradient.alphaKeys.map((key) => ({ time: key.t, alpha: key.a })),
  };
}

/**
 * Unreal CurveLinearColor keys. Niagara drives colour from a single RGBA curve
 * set, so colour and alpha stops are merged onto one time axis here - the one
 * place the two-list representation has to give something up.
 *
 * The merge is a UNION of both time axes, with each channel evaluated at every
 * resulting time. That is lossless for piecewise-linear data: sampling both
 * channels wherever either has a stop reproduces both exactly.
 *
 * @param {VfxGradient} gradient
 * @returns {Array<{Time: number, R: number, G: number, B: number, A: number}>}
 */
export function gradientToUnrealCurveLinearColor(gradient) {
  const times = new Set();
  for (const key of gradient.colorKeys) times.add(key.t);
  for (const key of gradient.alphaKeys) times.add(key.t);
  const scratch = new Float64Array(4);
  return [...times].sort((a, b) => a - b).map((t) => {
    evalGradient(gradient, t, scratch);
    return { Time: t, R: scratch[0], G: scratch[1], B: scratch[2], A: scratch[3] };
  });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
// As with the curve presets, each carries a hint naming what it is for. These
// are the ramps that make the difference between an effect reading as fire and
// reading as orange dots, and a developer has no reason to know them.
export const GRADIENT_PRESETS = Object.freeze([
  {
    id: 'fire',
    label: 'Fire',
    hint: 'White-hot core through orange to smoke. The default for flame.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#fff6d5', intensity: 3 },
        { t: 0.25, hex: '#ffb545', intensity: 2 },
        { t: 0.6, hex: '#d1441a', intensity: 1.2 },
        { t: 1, hex: '#2a2320', intensity: 1 },
      ],
      alphaKeys: [{ t: 0, a: 0 }, { t: 0.08, a: 1 }, { t: 0.7, a: 0.7 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'smoke',
    label: 'Smoke',
    hint: 'Dark and dense, thinning as it rises. Use with Alpha blending.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#6e6a66' },
        { t: 0.5, hex: '#4a4744' },
        { t: 1, hex: '#2e2c2a' },
      ],
      alphaKeys: [{ t: 0, a: 0 }, { t: 0.2, a: 0.55 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'ember',
    label: 'Ember',
    hint: 'Glowing orange that cools to red and winks out. Sparks and cinders.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#ffd9a0', intensity: 4 },
        { t: 0.4, hex: '#ff7a1a', intensity: 2.2 },
        { t: 1, hex: '#8c1b06', intensity: 1 },
      ],
      alphaKeys: [{ t: 0, a: 1 }, { t: 0.75, a: 1 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'ice',
    label: 'Ice',
    hint: 'Pale cyan to deep blue. Frost, chill and water magic.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#eafcff', intensity: 2.4 },
        { t: 0.45, hex: '#7fdcff', intensity: 1.6 },
        { t: 1, hex: '#1d5fb8', intensity: 1 },
      ],
      alphaKeys: [{ t: 0, a: 0 }, { t: 0.15, a: 1 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'toxic',
    label: 'Toxic',
    hint: 'Acid green. Poison clouds and corrosion.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#e8ff9c', intensity: 2 },
        { t: 0.4, hex: '#7ee03a', intensity: 1.5 },
        { t: 1, hex: '#1f5c22', intensity: 1 },
      ],
      alphaKeys: [{ t: 0, a: 0 }, { t: 0.2, a: 0.85 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'blood',
    label: 'Blood',
    hint: 'Bright arterial red darkening as it falls. Impacts and gore.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#c8241c' },
        { t: 0.5, hex: '#8a1210' },
        { t: 1, hex: '#3d0806' },
      ],
      alphaKeys: [{ t: 0, a: 1 }, { t: 0.8, a: 1 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'magic',
    label: 'Magic',
    hint: 'Violet through pink with a hot core. Spells and enchantments.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#ffffff', intensity: 3.5 },
        { t: 0.3, hex: '#c78bff', intensity: 2.2 },
        { t: 0.7, hex: '#7b3ff2', intensity: 1.5 },
        { t: 1, hex: '#2a0d5c', intensity: 1 },
      ],
      alphaKeys: [{ t: 0, a: 0 }, { t: 0.1, a: 1 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'electric',
    label: 'Electric',
    hint: 'Blue-white arc. Lightning, shocks and sci-fi weapons.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#ffffff', intensity: 6 },
        { t: 0.35, hex: '#9fd8ff', intensity: 3 },
        { t: 1, hex: '#2a6bff', intensity: 1.4 },
      ],
      alphaKeys: [{ t: 0, a: 1 }, { t: 0.6, a: 0.8 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'fadeOut',
    label: 'Fade out (white)',
    hint: 'Plain white that fades. The neutral starting point for a new effect.',
    build: () => createGradient({
      colorKeys: [{ t: 0, hex: '#ffffff' }],
      alphaKeys: [{ t: 0, a: 1 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'fadeInOut',
    label: 'Fade in and out (white)',
    hint: 'White that appears and disappears. Safe for smoke and dust.',
    build: () => createGradient({
      colorKeys: [{ t: 0, hex: '#ffffff' }],
      alphaKeys: [{ t: 0, a: 0 }, { t: 0.2, a: 1 }, { t: 0.8, a: 1 }, { t: 1, a: 0 }],
    }),
  },
  {
    id: 'rainbow',
    label: 'Rainbow',
    hint: 'Full hue sweep. Rarely right for a game effect, useful for debugging.',
    build: () => createGradient({
      colorKeys: [
        { t: 0, hex: '#ff0000' },
        { t: 0.17, hex: '#ffff00' },
        { t: 0.34, hex: '#00ff00' },
        { t: 0.5, hex: '#00ffff' },
        { t: 0.67, hex: '#0000ff' },
        { t: 0.84, hex: '#ff00ff' },
        { t: 1, hex: '#ff0000' },
      ],
      alphaKeys: [{ t: 0, a: 1 }],
    }),
  },
]);
