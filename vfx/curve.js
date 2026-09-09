// Over-life curves: the representation, evaluation, and the bake to a lookup
// table that the particle simulation actually samples.
//
// WHY HERMITE, and not the piecewise Bezier that most JS particle libraries
// use. A curve authored here has to survive two trips: into our own baked LUT,
// and out to Unity and Unreal. Both engines store curves as Hermite keys with
// in/out tangents - Unity's Keyframe is
// {time, value, inTangent, outTangent, weightedMode} and Unreal's
// FRichCurveKey is {Time, Value, ArriveTangent, LeaveTangent, InterpMode}. So
// authoring in Hermite makes import a field rename on both sides, and leaves
// the preview as the only place that converts anything. Authoring in Bezier
// would mean BOTH importers convert, independently, and tangent-scaling
// conventions are exactly the kind of thing two implementations disagree about
// in the third decimal place - which shows up as an effect that fades subtly
// differently in each engine and is nearly impossible to attribute.
//
// Tangents are in dv/dt (value change per unit of normalised time), matching
// Unity's convention, NOT per-segment. That distinction matters: a per-segment
// tangent silently changes meaning when a neighbouring key moves, so dragging
// one key would alter the shape of a segment the user did not touch.
//
// TIME IS ALWAYS NORMALISED to 0..1. What that 0..1 spans is the property's
// business, not the curve's - a domain of 'life' means age/lifetime, 'speed'
// means speed over a declared range, 'time' means effect time. Keeping the
// curve unitless is what lets one curve be reused across properties with
// different units, and what lets the gradient editor share the same t axis.

// Bake sizing policy is shared with vfx/gradient.js; see vfx/bake.js.
import {
  BAKE_ERROR_PROBE_SAMPLES,
  BAKE_SAMPLE_LADDER,
  DEFAULT_MAX_BAKE_ERROR,
} from './bake.js';

/** A curve key's interpolation mode. Governs the segment STARTING at that key. */
export const CURVE_INTERP = Object.freeze({
  /** Smooth, with tangents derived from the neighbours (Catmull-Rom). */
  AUTO: 'auto',
  /** Straight line to the next key. */
  LINEAR: 'linear',
  /** Hold this key's value until the next key - a step. */
  CONSTANT: 'constant',
  /** Use the explicit outTangent / next inTangent the author dragged. */
  FREE: 'free',
});

/** What happens outside 0..1. */
export const CURVE_WRAP = Object.freeze({
  CLAMP: 'clamp',
  LOOP: 'loop',
  PINGPONG: 'pingpong',
});

/**
 * @typedef {Object} VfxCurveKey
 * @property {number} t normalised time, 0..1
 * @property {number} v value
 * @property {number} inTangent dv/dt arriving at this key
 * @property {number} outTangent dv/dt leaving this key
 * @property {'auto'|'linear'|'constant'|'free'} interp mode of the segment
 *   starting at this key
 */

/**
 * @typedef {Object} VfxCurve
 * @property {VfxCurveKey[]} keys ascending by t, at least one
 * @property {'clamp'|'loop'|'pingpong'} preWrap behaviour below t=0
 * @property {'clamp'|'loop'|'pingpong'} postWrap behaviour above t=1
 */

/**
 * @param {Partial<VfxCurveKey>} [key]
 * @returns {VfxCurveKey}
 */
export function createCurveKey(key = {}) {
  return {
    t: Number.isFinite(key.t) ? key.t : 0,
    v: Number.isFinite(key.v) ? key.v : 0,
    inTangent: Number.isFinite(key.inTangent) ? key.inTangent : 0,
    outTangent: Number.isFinite(key.outTangent) ? key.outTangent : 0,
    interp: key.interp === CURVE_INTERP.LINEAR
      || key.interp === CURVE_INTERP.CONSTANT
      || key.interp === CURVE_INTERP.FREE
      ? key.interp
      : CURVE_INTERP.AUTO,
  };
}

/**
 * Build a curve, sorting and defaulting whatever the caller supplied. Every
 * entry point into this module goes through here, so nothing downstream has to
 * cope with unsorted keys or missing fields.
 *
 * @param {Array<Partial<VfxCurveKey>>} [keys]
 * @param {{preWrap?: string, postWrap?: string}} [wrap]
 * @returns {VfxCurve}
 */
export function createCurve(keys = [], wrap = {}) {
  const built = (Array.isArray(keys) ? keys : []).map(createCurveKey);
  built.sort((a, b) => a.t - b.t);
  // A curve with no keys is a real state to reach - deleting the last key in
  // the editor - and evaluating to 0 is friendlier than throwing on a path
  // that runs sixty times a second.
  if (built.length === 0) built.push(createCurveKey({ t: 0, v: 0 }));
  const wrapMode = (mode) => (
    mode === CURVE_WRAP.LOOP || mode === CURVE_WRAP.PINGPONG ? mode : CURVE_WRAP.CLAMP
  );
  return {
    keys: built,
    preWrap: wrapMode(wrap.preWrap),
    postWrap: wrapMode(wrap.postWrap),
  };
}

/**
 * A flat curve at v.
 * @param {number} v
 * @returns {VfxCurve}
 */
export function constantCurve(v) {
  return createCurve([
    { t: 0, v, interp: CURVE_INTERP.LINEAR },
    { t: 1, v, interp: CURVE_INTERP.LINEAR },
  ]);
}

/**
 * A straight ramp.
 * @param {number} a
 * @param {number} b
 * @returns {VfxCurve}
 */
export function linearCurve(a, b) {
  return createCurve([
    { t: 0, v: a, interp: CURVE_INTERP.LINEAR },
    { t: 1, v: b, interp: CURVE_INTERP.LINEAR },
  ]);
}

// Catmull-Rom tangent through a key, one-sided at the ends, CLAMPED at local
// extrema. This is what 'auto' means, and it is why an author can drop three
// keys and get a curve that already looks intentional without ever touching a
// tangent handle.
//
// The clamp is the part that matters, and it is Unity's ClampedAuto rather than
// plain Catmull-Rom for a concrete reason. Keys at 0 -> 1 -> 1 -> 0, which is
// the single most common shape an author draws (fade in, hold, fade out),
// overshoots to 1.18 under an unclamped tangent. On an alpha ramp that is alpha
// above 1, so the hold lasts visibly longer than the keys say; on a size ramp
// the particle grows 18% past the number the author typed. Either way the
// effect disagrees with the curve on screen, and a developer who has never
// authored a curve has no way to work out why.
//
// Flattening the tangent to zero wherever a key is a local maximum or minimum
// removes the overshoot without affecting monotonic runs, where Catmull-Rom is
// exactly what is wanted. An author who WANTS overshoot - an elastic pop, an
// anticipation dip - sets the key to 'free' and drags the handle, which is the
// deliberate path rather than an accident of interpolation.
function autoTangent(keys, i) {
  const key = keys[i];
  const prev = i > 0 ? keys[i - 1] : null;
  const next = i < keys.length - 1 ? keys[i + 1] : null;
  if (!prev && !next) return 0;
  if (!prev) return (next.v - key.v) / Math.max(next.t - key.t, 1e-6);
  if (!next) return (key.v - prev.v) / Math.max(key.t - prev.t, 1e-6);
  // Local extremum (including a flat run, where both deltas are zero): hold.
  const risingInto = key.v - prev.v;
  const risingOut = next.v - key.v;
  if (risingInto * risingOut <= 0) return 0;
  return (next.v - prev.v) / Math.max(next.t - prev.t, 1e-6);
}

// The tangent arriving at key i. Mirrors autoTangent unless the PREVIOUS key
// declared free tangents, in which case the author's dragged handle wins.
function arriveTangent(keys, i) {
  if (i <= 0) return keys[0].inTangent;
  return keys[i - 1].interp === CURVE_INTERP.FREE ? keys[i].inTangent : autoTangent(keys, i);
}

// The two tangents bounding the segment from key i to key i+1. Resolved
// per-segment rather than stored, so moving a neighbouring key updates an
// 'auto' curve the way the author expects.
function segmentTangents(keys, i) {
  const a = keys[i];
  const b = keys[i + 1];
  if (a.interp === CURVE_INTERP.FREE) return [a.outTangent, b.inTangent];
  return [autoTangent(keys, i), autoTangent(keys, i + 1)];
}

// Map t into the key range according to the wrap modes.
function applyWrap(curve, t, t0, t1) {
  const span = t1 - t0;
  if (span <= 1e-9) return t0;
  if (t < t0) {
    if (curve.preWrap === CURVE_WRAP.CLAMP) return t0;
    const k = (t0 - t) / span;
    if (curve.preWrap === CURVE_WRAP.LOOP) return t1 - (k % 1) * span;
    const phase = k % 2;
    return phase <= 1 ? t0 + phase * span : t1 - (phase - 1) * span;
  }
  if (t > t1) {
    if (curve.postWrap === CURVE_WRAP.CLAMP) return t1;
    const k = (t - t1) / span;
    if (curve.postWrap === CURVE_WRAP.LOOP) return t0 + (k % 1) * span;
    const phase = k % 2;
    return phase <= 1 ? t1 - phase * span : t0 + (phase - 1) * span;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------
//
// Pure, immutable, and here rather than in the editor component for two
// reasons. Sorting is the whole difficulty - a key dragged past its neighbour
// changes its own index, and an editor that tracked selection by index would
// select a different key mid-drag - so every mutator returns the new curve AND
// the index the touched key ended up at. That is not something a React
// component should be working out for itself, and it is not something that can
// be checked by looking at a screenshot.
//
// The second reason: the compiler bakes these curves and the engine importers
// re-emit them, so a mutator that produced an unsorted key list would fail
// somewhere far from the drag that caused it.

/**
 * @typedef {Object} VfxCurveEdit
 * @property {VfxCurve} curve the new curve
 * @property {number} index where the touched key ended up, or -1
 */

/** Wrap a key list back into a curve, preserving the wrap modes. */
function rebuild(curve, keys) {
  return createCurve(keys, { preWrap: curve.preWrap, postWrap: curve.postWrap });
}

/**
 * Sort keys and report where one of them landed.
 *
 * The identity is carried on a temporary symbol-free marker property rather
 * than by comparing values, because two keys may legitimately share a value
 * (a flat hold) and comparing t is exactly what a drag past a neighbour
 * breaks.
 */
function sortTracking(curve, keys, tracked) {
  const marked = keys.map((key, i) => ({ key, was: i }));
  marked.sort((a, b) => (a.key.t - b.key.t) || (a.was - b.was));
  const index = marked.findIndex((entry) => entry.was === tracked);
  return { curve: rebuild(curve, marked.map((entry) => entry.key)), index };
}

/**
 * Add a key.
 *
 * The value defaults to the curve's OWN value at t, so clicking empty space in
 * the editor adds a key without changing the shape. An author who wanted the
 * shape changed will drag it; one who was adding a key to pin a shape they
 * already like must not have it move under them.
 *
 * @param {VfxCurve} curve
 * @param {number} t
 * @param {number} [v] defaults to evalCurve(curve, t)
 * @returns {VfxCurveEdit}
 */
export function addCurveKey(curve, t, v) {
  const clampedT = Math.min(1, Math.max(0, t));
  const value = Number.isFinite(v) ? v : evalCurve(curve, clampedT);
  // The new key inherits the interpolation of the segment it was dropped into,
  // so adding a key to a stepped curve does not silently smooth it.
  const before = curve.keys.filter((key) => key.t <= clampedT);
  const interp = before.length > 0 ? before[before.length - 1].interp : curve.keys[0].interp;
  const keys = [...curve.keys, createCurveKey({ t: clampedT, v: value, interp })];
  return sortTracking(curve, keys, keys.length - 1);
}

/**
 * Move a key.
 *
 * @param {VfxCurve} curve
 * @param {number} index
 * @param {{t?: number, v?: number}} to
 * @returns {VfxCurveEdit}
 */
export function moveCurveKey(curve, index, to) {
  if (index < 0 || index >= curve.keys.length) return { curve, index: -1 };
  const keys = curve.keys.map((key, i) => (
    i === index
      ? createCurveKey({
        ...key,
        t: Number.isFinite(to.t) ? Math.min(1, Math.max(0, to.t)) : key.t,
        v: Number.isFinite(to.v) ? to.v : key.v,
      })
      : key
  ));
  return sortTracking(curve, keys, index);
}

/**
 * Remove a key.
 *
 * The LAST key cannot be removed. A curve with no keys evaluates to zero,
 * which on a size property means invisible particles and on an alpha property
 * means the same - and the author would be looking at an empty viewport having
 * only pressed Delete on a graph.
 *
 * @param {VfxCurve} curve
 * @param {number} index
 * @returns {VfxCurveEdit}
 */
export function removeCurveKey(curve, index) {
  if (curve.keys.length <= 1) return { curve, index: -1 };
  if (index < 0 || index >= curve.keys.length) return { curve, index: -1 };
  const keys = curve.keys.filter((_, i) => i !== index);
  return { curve: rebuild(curve, keys), index: Math.min(index, keys.length - 1) };
}

/**
 * Set a key's interpolation mode.
 *
 * Switching TO 'free' seeds the handles from what 'auto' was already
 * producing, so the curve does not jump the moment the author decides to take
 * manual control - they start from the shape they were looking at.
 *
 * @param {VfxCurve} curve
 * @param {number} index
 * @param {string} interp
 * @returns {VfxCurveEdit}
 */
export function setKeyInterp(curve, index, interp) {
  if (index < 0 || index >= curve.keys.length) return { curve, index: -1 };
  const seedOut = autoTangent(curve.keys, index);
  const keys = curve.keys.map((key, i) => {
    if (i !== index) return key;
    if (interp === CURVE_INTERP.FREE && key.interp !== CURVE_INTERP.FREE) {
      return createCurveKey({ ...key, interp, outTangent: seedOut, inTangent: key.inTangent });
    }
    return createCurveKey({ ...key, interp });
  });
  // The NEXT key's inTangent is what the free segment reads at its far end, so
  // it is seeded too - otherwise the first thing a 'free' segment does is snap
  // flat at its right-hand end.
  if (interp === CURVE_INTERP.FREE && index + 1 < keys.length) {
    keys[index + 1] = createCurveKey({
      ...keys[index + 1],
      inTangent: autoTangent(curve.keys, index + 1),
    });
  }
  return { curve: rebuild(curve, keys), index };
}

// The order a double-click walks. Smooth -> straight -> step is the order an
// author thinks in, and 'free' is deliberately NOT in the cycle: it is reached
// by dragging a handle, because arriving at it by accident leaves a curve whose
// shape no longer follows its neighbours and no visible reason why.
const INTERP_CYCLE = Object.freeze([
  CURVE_INTERP.AUTO,
  CURVE_INTERP.LINEAR,
  CURVE_INTERP.CONSTANT,
]);

/**
 * Advance a key's interpolation to the next mode in the cycle.
 * @param {VfxCurve} curve
 * @param {number} index
 * @returns {VfxCurveEdit}
 */
export function cycleKeyInterp(curve, index) {
  if (index < 0 || index >= curve.keys.length) return { curve, index: -1 };
  const at = INTERP_CYCLE.indexOf(curve.keys[index].interp);
  // 'free' is not in the cycle, so a double-click on a hand-tuned key returns
  // it to 'auto' rather than to whatever happens to be next.
  const next = INTERP_CYCLE[(at + 1) % INTERP_CYCLE.length];
  return setKeyInterp(curve, index, at < 0 ? CURVE_INTERP.AUTO : next);
}

/**
 * Set one of a key's tangent handles.
 *
 * Setting a tangent implies 'free' - the mode exists precisely to mean "the
 * author dragged this" - so it is applied here rather than requiring two calls
 * that could be made in the wrong order.
 *
 * @param {VfxCurve} curve
 * @param {number} index
 * @param {'in'|'out'} side
 * @param {number} slope dv/dt
 * @returns {VfxCurveEdit}
 */
export function setKeyTangent(curve, index, side, slope) {
  if (index < 0 || index >= curve.keys.length) return { curve, index: -1 };
  const value = Number.isFinite(slope) ? slope : 0;
  const keys = curve.keys.map((key, i) => {
    if (i !== index) return key;
    return createCurveKey({
      ...key,
      [side === 'in' ? 'inTangent' : 'outTangent']: value,
      // Dragging the OUT handle makes this key's own segment free. Dragging the
      // IN handle makes the PREVIOUS segment free, which is handled below -
      // this key's own mode is left alone in that case.
      interp: side === 'out' ? CURVE_INTERP.FREE : key.interp,
    });
  });
  if (side === 'in' && index > 0) {
    keys[index - 1] = createCurveKey({ ...keys[index - 1], interp: CURVE_INTERP.FREE });
  }
  return { curve: rebuild(curve, keys), index };
}

/**
 * A one-line description of a curve's shape, in words.
 *
 * The accessible name for the editor canvas, and the tooltip on a collapsed
 * row. A canvas is invisible to a screen reader, and "curve" is not a
 * description - "starts at 0, rises to 1, ends at 0, 3 keys" is.
 *
 * @param {VfxCurve} curve
 * @param {{unit?: string}} [options]
 * @returns {string}
 */
export function describeCurve(curve, options = {}) {
  const unit = options.unit ? ` ${options.unit}` : '';
  const round = (n) => String(Math.round(n * 1000) / 1000);
  const keys = curve.keys;
  if (keys.length === 1) return `constant ${round(keys[0].v)}${unit}`;

  const { min, max } = curveExtent(curve);
  const first = keys[0].v;
  const last = keys[keys.length - 1].v;
  const shape = Math.abs(max - min) < 1e-6
    ? 'flat'
    : last > first ? 'rising' : last < first ? 'falling' : 'a hump';
  return `${shape}, from ${round(first)} to ${round(last)}${unit},`
    + ` ranging ${round(min)} to ${round(max)}, ${keys.length} keys`;
}

/**
 * Evaluate a curve. This is the reference implementation - the LUT bake below
 * is measured against it, and so is anything the engine importers generate.
 *
 * @param {VfxCurve} curve
 * @param {number} t normalised time; outside 0..1 the wrap modes apply
 * @returns {number}
 */
export function evalCurve(curve, t) {
  const keys = curve.keys;
  const n = keys.length;
  if (n === 1) return keys[0].v;

  const wrapped = applyWrap(curve, t, keys[0].t, keys[n - 1].t);
  if (wrapped <= keys[0].t) return keys[0].v;
  if (wrapped >= keys[n - 1].t) return keys[n - 1].v;

  // Linear scan. Authored curves have a handful of keys, and a binary search
  // costs more in branch misprediction than it saves at this size. The hot
  // path in the simulation is the LUT below, not this.
  let i = 0;
  while (i < n - 2 && keys[i + 1].t <= wrapped) i += 1;

  const a = keys[i];
  const b = keys[i + 1];
  if (a.interp === CURVE_INTERP.CONSTANT) return a.v;

  const dt = b.t - a.t;
  if (dt <= 1e-9) return b.v;
  const s = (wrapped - a.t) / dt;
  if (a.interp === CURVE_INTERP.LINEAR) return a.v + (b.v - a.v) * s;

  const [m0, m1] = segmentTangents(keys, i);
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  // The dt factors convert dv/dt tangents into this segment's parameter space.
  return h00 * a.v + h10 * dt * m0 + h01 * b.v + h11 * dt * m1;
}

/**
 * True if any segment is a hard step.
 * @param {VfxCurve} curve
 * @returns {boolean}
 */
export function curveHasSteps(curve) {
  const keys = curve.keys;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (keys[i].interp === CURVE_INTERP.CONSTANT) return true;
  }
  return false;
}

/**
 * The value range a curve actually spans. Three different consumers need it:
 * the capacity and bounds solve (a lifetime curve's max bounds the worst-case
 * particle count), the zero-alpha and zero-size diagnostics, and the decision
 * of whether instanced colour can be packed into bytes instead of floats.
 *
 * Sampled rather than solved analytically because a Hermite segment can
 * overshoot well past both of its endpoints - the extreme of a curve is often
 * at neither a key nor a midpoint.
 *
 * @param {VfxCurve} curve
 * @param {number} [samples]
 * @returns {{min: number, max: number}}
 */
export function curveExtent(curve, samples = BAKE_ERROR_PROBE_SAMPLES) {
  let min = Infinity;
  let max = -Infinity;
  for (const key of curve.keys) {
    if (key.v < min) min = key.v;
    if (key.v > max) max = key.v;
  }
  for (let i = 0; i <= samples; i += 1) {
    const v = evalCurve(curve, i / samples);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Bake to a lookup table of n samples spanning t = 0..1 inclusive.
 * @param {VfxCurve} curve
 * @param {number} n
 * @returns {Float32Array}
 */
export function bakeCurve(curve, n) {
  const count = Math.max(2, n | 0);
  const lut = new Float32Array(count);
  const last = count - 1;
  for (let i = 0; i < count; i += 1) lut[i] = evalCurve(curve, i / last);
  return lut;
}

/**
 * Sample a baked table. The simulation's inner loop runs this shape of code
 * inline; it lives here so the bake-accuracy test measures the same
 * reconstruction the runtime will actually perform.
 *
 * Linear between samples, deliberately: nearest gives visible stepping on a
 * size ramp, and cubic costs four loads on the hot path to refine something
 * already below the perceptual threshold at these table sizes.
 *
 * @param {Float32Array} lut
 * @param {number} t clamped to 0..1
 * @returns {number}
 */
export function evalCurveLut(lut, t) {
  const last = lut.length - 1;
  if (!(t > 0)) return lut[0];
  if (t >= 1) return lut[last];
  const x = t * last;
  const i = x | 0;
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

/**
 * Pick the smallest table size that reconstructs this curve within tolerance.
 *
 * Chosen by MEASURING reconstruction error against the reference evaluator,
 * not by a second-derivative heuristic. The heuristic is the wrong instrument
 * in both directions: a three-key curve can carry a sharper corner than a
 * twelve-key one, so any rule keyed on key count is wrong, and peak curvature
 * does not map linearly onto sampling error either. Measuring the actual error
 * costs a few thousand evaluations once, at compile time, and is exact.
 *
 * @param {VfxCurve} curve
 * @param {{maxError?: number}} [options] maxError as a fraction of the curve's
 *   own value range
 * @returns {number} an entry from the sample ladder
 */
export function chooseCurveSampleCount(curve, options = {}) {
  const maxError = Number.isFinite(options.maxError) ? options.maxError : DEFAULT_MAX_BAKE_ERROR;
  const largest = BAKE_SAMPLE_LADDER[BAKE_SAMPLE_LADDER.length - 1];

  // A step is a discontinuity: no finite table reconstructs it, so the error
  // metric would reject every size and always fall through to the largest.
  // Return that directly rather than pretending the answer was measured.
  if (curveHasSteps(curve)) return largest;

  const { min, max } = curveExtent(curve, BAKE_ERROR_PROBE_SAMPLES);
  const range = max - min;
  // A flat curve reconstructs exactly at any size, so take the smallest.
  if (!(range > 1e-9)) return BAKE_SAMPLE_LADDER[0];

  const tolerance = maxError * range;
  for (const n of BAKE_SAMPLE_LADDER) {
    const lut = bakeCurve(curve, n);
    let worst = 0;
    for (let i = 0; i <= BAKE_ERROR_PROBE_SAMPLES; i += 1) {
      const t = i / BAKE_ERROR_PROBE_SAMPLES;
      const err = Math.abs(evalCurveLut(lut, t) - evalCurve(curve, t));
      if (err > worst) worst = err;
    }
    if (worst <= tolerance) return n;
  }
  return largest;
}

// ---------------------------------------------------------------------------
// Engine conversions
// ---------------------------------------------------------------------------
// These live here, next to the representation, so that the claim in the header
// - that import is a field rename - is either true in code or visibly false.

/**
 * Unity AnimationCurve keyframes. Unity has no per-key "constant" mode; a step
 * is expressed with infinite tangents, which is what Unity's own editor writes
 * when a key is set to Constant.
 *
 * @param {VfxCurve} curve
 * @returns {Array<{time: number, value: number, inTangent: number, outTangent: number}>}
 */
export function curveToUnityKeyframes(curve) {
  const keys = curve.keys;
  return keys.map((key, i) => {
    const isLast = i === keys.length - 1;
    const stepsOut = key.interp === CURVE_INTERP.CONSTANT && !isLast;
    const stepsIn = i > 0 && keys[i - 1].interp === CURVE_INTERP.CONSTANT;
    const out = isLast ? key.outTangent : segmentTangents(keys, i)[0];
    return {
      time: key.t,
      value: key.v,
      inTangent: stepsIn ? Infinity : arriveTangent(keys, i),
      outTangent: stepsOut ? Infinity : out,
    };
  });
}

/**
 * Unreal FRichCurveKey rows. Unreal names the same two tangents Arrive/Leave
 * and carries the step as an explicit interp mode, so this direction is
 * lossless without the infinity trick.
 *
 * @param {VfxCurve} curve
 * @returns {Array<{Time: number, Value: number, ArriveTangent: number, LeaveTangent: number, InterpMode: string}>}
 */
export function curveToUnrealRichCurve(curve) {
  const keys = curve.keys;
  return keys.map((key, i) => {
    const isLast = i === keys.length - 1;
    const out = isLast ? key.outTangent : segmentTangents(keys, i)[0];
    let mode = 'RCIM_Cubic';
    if (key.interp === CURVE_INTERP.LINEAR) mode = 'RCIM_Linear';
    else if (key.interp === CURVE_INTERP.CONSTANT) mode = 'RCIM_Constant';
    return {
      Time: key.t,
      Value: key.v,
      ArriveTangent: arriveTangent(keys, i),
      LeaveTangent: out,
      InterpMode: mode,
    };
  });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
// Every preset carries a plain-language hint naming an effect it is right for.
// The audience is a developer who has never authored a curve, and "Spike" means
// nothing on its own - "bright instantly, then fades; this is a muzzle flash"
// is the thing that actually lets them choose.
export const CURVE_PRESETS = Object.freeze([
  {
    id: 'constant',
    label: 'Constant',
    hint: 'Never changes over the particle life.',
    build: () => constantCurve(1),
  },
  {
    id: 'rampUp',
    label: 'Ramp up',
    hint: 'Grows steadily. Expanding shockwaves and rising smoke.',
    build: () => linearCurve(0, 1),
  },
  {
    id: 'rampDown',
    label: 'Ramp down',
    hint: 'Shrinks steadily. The simplest fade.',
    build: () => linearCurve(1, 0),
  },
  {
    id: 'easeIn',
    label: 'Ease in',
    hint: 'Slow to start, then accelerates.',
    build: () => createCurve([
      { t: 0, v: 0, interp: CURVE_INTERP.FREE, outTangent: 0 },
      { t: 1, v: 1, interp: CURVE_INTERP.FREE, inTangent: 2 },
    ]),
  },
  {
    id: 'easeOut',
    label: 'Ease out',
    hint: 'Fast to start, then settles. A good default for size.',
    build: () => createCurve([
      { t: 0, v: 0, interp: CURVE_INTERP.FREE, outTangent: 2 },
      { t: 1, v: 1, interp: CURVE_INTERP.FREE, inTangent: 0 },
    ]),
  },
  {
    id: 'spike',
    label: 'Spike',
    hint: 'Bright instantly, then fades away. This is a muzzle flash.',
    build: () => createCurve([
      { t: 0, v: 1, interp: CURVE_INTERP.FREE, outTangent: -6 },
      { t: 0.25, v: 0.3 },
      { t: 1, v: 0 },
    ]),
  },
  {
    id: 'fadeInOut',
    label: 'Fade in and out',
    hint: 'Appears, holds, disappears. The safe choice for smoke opacity.',
    build: () => createCurve([
      { t: 0, v: 0 },
      { t: 0.15, v: 1 },
      { t: 0.7, v: 1 },
      { t: 1, v: 0 },
    ]),
  },
  {
    id: 'bell',
    label: 'Bell',
    hint: 'Peaks in the middle. Puffs that swell, then vanish.',
    build: () => createCurve([{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }]),
  },
  {
    id: 'pulse',
    label: 'Pulse',
    hint: 'On, off, on. Flickering magic and electrical arcs.',
    build: () => createCurve([
      { t: 0, v: 1, interp: CURVE_INTERP.CONSTANT },
      { t: 0.33, v: 0, interp: CURVE_INTERP.CONSTANT },
      { t: 0.66, v: 1, interp: CURVE_INTERP.CONSTANT },
      { t: 1, v: 1, interp: CURVE_INTERP.CONSTANT },
    ]),
  },
]);
