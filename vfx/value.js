// VfxValue: the single representation for every authorable property in a VFX
// graph. One block property, one operator input, one context setting - all of
// them are a VfxValue, whatever the author has done to it.
//
// This is the crux of both the editor and the compiler, so it is worth being
// explicit about what it buys. An author can express a property six ways:
//
//   const     a number they typed
//   random    a range, drawn per particle / per frame / per spawn event
//   curve     a shape over the particle's life (or speed, or effect time)
//   gradient  a colour ramp over the same
//   link      wired from an operator node's output
//   exposed   driven at runtime by a host, via the blackboard
//
// Six affordances in the UI, ONE access pattern in the simulation: the
// compiler resolves whichever it is into a binding, and every kernel reads its
// inputs through that binding without knowing or caring which of the six
// produced it. That collapse is what keeps the kernel catalog small and each
// kernel monomorphic, and it is why this type exists rather than six parallel
// property shapes.
//
// TWO DECISIONS worth defending, because both have an obvious-looking
// alternative that is worse.
//
// 1. EVERY MODE CARRIES A USABLE LITERAL `v`.
//    Not a tagged union of six disjoint shapes. The shared fallback is what
//    makes mode switching non-destructive and what keeps a broken reference
//    from breaking the effect: flip a property from curve back to const and it
//    lands on the value the curve actually REACHED (see curveFallback below,
//    which explains why "the value at t=0" is the wrong answer); delete the
//    operator an edge pointed at and the property keeps evaluating; open an
//    effect whose exposed property was renamed and it still runs. A mode
//    switcher the author trusts is one they use; one that loses their work is
//    one they undo out of and never touch again.
//
// 2. `link` MIRRORS THE EDGE LIST, ONE-DIRECTIONALLY.
//    doc.edges is authoritative - React Flow needs an edge array to render,
//    and one list is the only way to keep the board and the document in
//    agreement. But the property inspector needs to say "wired from Curve #3"
//    on a row without scanning every edge in the document per row per render,
//    so the mode is mirrored onto the property. normalizeVfxDoc re-derives
//    every link from edges on load and after every mutation, so EDGES ALWAYS
//    WIN. No UI code may set mode to 'link' directly; wiring is done by adding
//    an edge and letting the reconciler follow.

import { constantCurve, createCurve, curveExtent } from './curve.js';
import { createGradient, evalGradient } from './gradient.js';

/** The six ways a property can get its value. */
export const VALUE_MODE = Object.freeze({
  CONST: 'const',
  RANDOM: 'random',
  CURVE: 'curve',
  GRADIENT: 'gradient',
  LINK: 'link',
  EXPOSED: 'exposed',
});

/** How often a random value is redrawn. */
export const RANDOM_FREQ = Object.freeze({
  /** Once, at birth. The usual choice - varies particle to particle. */
  PER_PARTICLE: 'perParticle',
  /** Every simulation step. Flicker and jitter. */
  PER_FRAME: 'perFrame',
  /** Once per burst, shared by every particle in it. */
  PER_SPAWN_EVENT: 'perSpawnEvent',
});

/** What a curve or gradient is plotted against. */
export const VALUE_DOMAIN = Object.freeze({
  /** Normalised age: age / lifetime. The default and by far the most common. */
  LIFE: 'life',
  /** Particle speed, remapped through a declared range. */
  SPEED: 'speed',
  /** Effect time since play. */
  TIME: 'time',
});

/**
 * @typedef {Object} VfxValue
 * @property {'const'|'random'|'curve'|'gradient'|'link'|'exposed'} mode
 * @property {number|number[]|boolean|string} v the literal fallback, live in
 *   every mode - see decision 1 in the header
 * @property {number|number[]} [a] random low bound
 * @property {number|number[]} [b] random high bound
 * @property {'perParticle'|'perFrame'|'perSpawnEvent'} [freq] random frequency
 * @property {boolean} [uniform] random: one draw shared by all channels, so a
 *   colour randomises as a grey rather than as a hue
 * @property {import('./curve.js').VfxCurve} [curve]
 * @property {import('./gradient.js').VfxGradient} [gradient]
 * @property {'life'|'speed'|'time'} [domain] for curve and gradient
 * @property {number} [scale] curve: authored 0..1, multiplied by this
 * @property {[number, number]} [randomScale] curve: random between two scales,
 *   the Unity "random between two curves" idiom
 * @property {string} [nodeId] link: source operator node
 * @property {string} [port] link: source output port
 * @property {string} [exposedId] exposed: blackboard entry
 * @property {Object<string, *>} [stash] payloads from modes previously used,
 *   so switching back is lossless
 */

// Number, or an array of numbers, cloned so a value never shares state with
// whatever built it. Cheap, and it removes an entire class of bug where two
// properties end up aliasing one array.
function cloneLiteral(v) {
  return Array.isArray(v) ? v.slice() : v;
}

function asNumber(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

// Coerce a literal to `channels` numbers. Widening a scalar to a vector
// repeats it rather than zero-filling: a size of 0.4 becoming (0.4, 0.4, 0.4)
// is what the author meant, whereas (0.4, 0, 0) is a flat invisible particle.
function fitChannels(v, channels) {
  if (channels <= 1) {
    if (Array.isArray(v)) return asNumber(v[0]);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v;
    return asNumber(v);
  }
  const out = new Array(channels);
  if (Array.isArray(v)) {
    for (let i = 0; i < channels; i += 1) out[i] = asNumber(v[i], asNumber(v[0]));
  } else {
    const scalar = asNumber(v);
    for (let i = 0; i < channels; i += 1) out[i] = scalar;
  }
  return out;
}

/**
 * A constant value.
 * @param {number|number[]|boolean|string} v
 * @returns {VfxValue}
 */
export function constValue(v) {
  return { mode: VALUE_MODE.CONST, v: cloneLiteral(v) };
}

/**
 * A value drawn between two bounds.
 * @param {number|number[]} a
 * @param {number|number[]} b
 * @param {{freq?: string, uniform?: boolean}} [options]
 * @returns {VfxValue}
 */
export function randomValue(a, b, options = {}) {
  const value = {
    mode: VALUE_MODE.RANDOM,
    a: cloneLiteral(a),
    b: cloneLiteral(b),
    freq: options.freq || RANDOM_FREQ.PER_PARTICLE,
    v: 0,
  };
  if (options.uniform) value.uniform = true;
  value.v = midpointOf(value.a, value.b);
  return value;
}

// The fallback for a random value is the midpoint of its range, which is the
// least surprising thing to see when the range collapses to a single number.
function midpointOf(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const n = Math.max(Array.isArray(a) ? a.length : 1, Array.isArray(b) ? b.length : 1);
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const lo = Array.isArray(a) ? asNumber(a[i]) : asNumber(a);
      const hi = Array.isArray(b) ? asNumber(b[i]) : asNumber(b);
      out[i] = (lo + hi) / 2;
    }
    return out;
  }
  return (asNumber(a) + asNumber(b)) / 2;
}

// The literal a curve collapses to when the author switches the property to a
// constant: the extreme the curve actually REACHES, carrying its sign.
//
// Not the value at t=0, which was the first version and is wrong for the most
// common shape there is. A fade-in ramp, a bell and a fade-in-out ramp all
// start at zero, so switching any of them to a constant produced 0 - an
// invisible particle for a size property, a fully transparent one for alpha.
// The author who wrote "size ramps up to 7 over the life" and then asks for a
// constant means 7, not 0.
//
// Signed largest magnitude rather than the maximum, so a gravity curve running
// 0 to -9.8 collapses to -9.8 rather than to 0.
function curveFallback(curve) {
  const { min, max } = curveExtent(curve);
  return Math.abs(max) >= Math.abs(min) ? max : min;
}

/**
 * A value that follows a curve.
 * @param {import('./curve.js').VfxCurve} curve
 * @param {{domain?: string, scale?: number, randomScale?: [number, number]}} [options]
 * @returns {VfxValue}
 */
export function curveValue(curve, options = {}) {
  const scale = Number.isFinite(options.scale) ? options.scale : 1;
  const value = {
    mode: VALUE_MODE.CURVE,
    curve,
    domain: options.domain || VALUE_DOMAIN.LIFE,
    scale,
    v: curveFallback(curve) * scale,
  };
  if (Array.isArray(options.randomScale) && options.randomScale.length === 2) {
    value.randomScale = [asNumber(options.randomScale[0], 1), asNumber(options.randomScale[1], 1)];
  }
  return value;
}

/**
 * A colour that follows a gradient.
 * @param {import('./gradient.js').VfxGradient} gradient
 * @param {{domain?: string}} [options]
 * @returns {VfxValue}
 */
export function gradientValue(gradient, options = {}) {
  return {
    mode: VALUE_MODE.GRADIENT,
    gradient,
    domain: options.domain || VALUE_DOMAIN.LIFE,
    v: gradientFallback(gradient),
  };
}

// The colour a gradient collapses to: the one at PEAK ALPHA, which is the
// colour the particle most visibly shows.
//
// Same trap as curveFallback. Almost every usable ramp starts at alpha 0 so
// that particles fade in, so sampling t=0 handed the author a fully
// transparent colour the moment they switched the property to a constant.
function gradientFallback(gradient) {
  const rgba = new Float64Array(4);
  const best = new Float64Array(4);
  let bestAlpha = -1;
  for (let i = 0; i <= 64; i += 1) {
    evalGradient(gradient, i / 64, rgba);
    if (rgba[3] > bestAlpha) {
      bestAlpha = rgba[3];
      best.set(rgba);
    }
  }
  return [best[0], best[1], best[2], best[3]];
}

/**
 * A value wired from an operator node.
 *
 * Not for UI code to call directly - wiring happens by adding an edge, and the
 * document reconciler derives this. See decision 2 in the header.
 *
 * @param {string} nodeId
 * @param {string} port
 * @param {number|number[]|boolean} fallback kept live for when the source goes
 * @returns {VfxValue}
 */
export function linkValue(nodeId, port, fallback = 0) {
  return {
    mode: VALUE_MODE.LINK,
    nodeId: String(nodeId),
    port: String(port),
    v: cloneLiteral(fallback),
  };
}

/**
 * A value driven at runtime from the blackboard.
 * @param {string} exposedId
 * @param {number|number[]|boolean} fallback
 * @returns {VfxValue}
 */
export function exposedValue(exposedId, fallback = 0) {
  return {
    mode: VALUE_MODE.EXPOSED,
    exposedId: String(exposedId),
    v: cloneLiteral(fallback),
  };
}

// How many channels an input carries on its own evidence.
//
// Used when the caller does not say. Defaulting to 1 instead was the first
// version and loses data silently: normalizeValue([1, 2, 3]) came back as the
// scalar 1, so a hand-written or model-generated position of [1, 2, 3] quietly
// became [1] and the particle spawned on the x axis. Callers that know the
// property type still pass `channels` and that always wins - this only decides
// what happens when nobody said.
function inferChannels(input) {
  if (Array.isArray(input)) return Math.max(1, input.length);
  if (input && typeof input === 'object') {
    if (input.mode === VALUE_MODE.GRADIENT) return 4;
    if (Array.isArray(input.v)) return Math.max(1, input.v.length);
    if (Array.isArray(input.a)) return Math.max(1, input.a.length);
    if (Array.isArray(input.b)) return Math.max(1, input.b.length);
  }
  return 1;
}

/**
 * Coerce anything into a valid VfxValue.
 *
 * Bare numbers, arrays and booleans are accepted and wrapped as constants,
 * because that is what a hand-written document, a template literal and an AI
 * response all naturally produce - requiring the full wrapper everywhere would
 * make the document format tedious to write by hand for no gain.
 *
 * @param {*} input
 * @param {{channels?: number}} [options] `channels` comes from the property's
 *   catalog entry when there is one; without it the width is inferred from the
 *   input rather than assumed to be scalar.
 * @returns {VfxValue}
 */
export function normalizeValue(input, options = {}) {
  const channels = Number.isFinite(options.channels)
    ? Math.max(1, options.channels | 0)
    : inferChannels(input);

  if (input === null || input === undefined) return constValue(fitChannels(0, channels));
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'string') {
    return constValue(fitChannels(input, channels));
  }
  if (Array.isArray(input)) return constValue(fitChannels(input, channels));

  const mode = input.mode;
  const stash = input.stash && typeof input.stash === 'object' ? { ...input.stash } : undefined;

  if (mode === VALUE_MODE.RANDOM) {
    const value = randomValue(
      fitChannels(input.a, channels),
      fitChannels(input.b, channels),
      {
        freq: Object.values(RANDOM_FREQ).includes(input.freq) ? input.freq : RANDOM_FREQ.PER_PARTICLE,
        uniform: Boolean(input.uniform),
      },
    );
    if (stash) value.stash = stash;
    return value;
  }

  if (mode === VALUE_MODE.CURVE) {
    const curve = input.curve && Array.isArray(input.curve.keys)
      ? createCurve(input.curve.keys, input.curve)
      : constantCurve(asNumber(input.v, 1));
    const value = curveValue(curve, {
      domain: Object.values(VALUE_DOMAIN).includes(input.domain) ? input.domain : VALUE_DOMAIN.LIFE,
      scale: input.scale,
      randomScale: input.randomScale,
    });
    if (stash) value.stash = stash;
    return value;
  }

  if (mode === VALUE_MODE.GRADIENT) {
    const gradient = createGradient(input.gradient || {});
    const value = gradientValue(gradient, {
      domain: Object.values(VALUE_DOMAIN).includes(input.domain) ? input.domain : VALUE_DOMAIN.LIFE,
    });
    if (stash) value.stash = stash;
    return value;
  }

  if (mode === VALUE_MODE.LINK && input.nodeId) {
    const value = linkValue(input.nodeId, input.port || 'out', fitChannels(input.v, channels));
    if (stash) value.stash = stash;
    return value;
  }

  if (mode === VALUE_MODE.EXPOSED && input.exposedId) {
    const value = exposedValue(input.exposedId, fitChannels(input.v, channels));
    if (stash) value.stash = stash;
    return value;
  }

  // Anything unrecognised - including a link whose nodeId went missing, or a
  // mode string from a future document format - degrades to its own literal.
  // The property keeps working and the diagnostics pass reports the loss,
  // which beats throwing during a load.
  const value = constValue(fitChannels(input.v, channels));
  if (stash) value.stash = stash;
  return value;
}

/**
 * The literal a property evaluates to when nothing is animating it. This is
 * what a numeric field in the inspector shows and edits.
 *
 * @param {VfxValue} value
 * @returns {number|number[]|boolean|string}
 */
export function readValue(value) {
  return value ? cloneLiteral(value.v) : 0;
}

/**
 * How many numeric channels a value carries.
 * @param {VfxValue} value
 * @returns {number}
 */
export function valueChannels(value) {
  if (!value) return 1;
  if (value.mode === VALUE_MODE.GRADIENT) return 4;
  const literal = value.v;
  if (Array.isArray(literal)) return literal.length;
  if (Array.isArray(value.a)) return value.a.length;
  return 1;
}

/**
 * True if the value can change over a particle's life or between particles.
 *
 * The compiler's frequency classification does the precise version of this;
 * the UI uses it for the "this is animated" marker on a property row, and the
 * diagnostics pass uses it to decide whether a single sample is representative.
 *
 * @param {VfxValue} value
 * @returns {boolean}
 */
export function isAnimated(value) {
  if (!value) return false;
  if (value.mode === VALUE_MODE.CURVE || value.mode === VALUE_MODE.GRADIENT) return true;
  if (value.mode === VALUE_MODE.LINK) return true;
  if (value.mode === VALUE_MODE.RANDOM) return true;
  return false;
}

/**
 * The value as a plain literal if it is genuinely constant, else null.
 *
 * The compiler uses this for constant folding, and the capacity diagnostic
 * needs it to know a spawn rate exactly rather than guessing. An exposed value
 * is deliberately NOT constant even though it has a literal: a host can change
 * it at runtime, so folding it would bake in a default the author expects to be
 * overridable.
 *
 * @param {VfxValue} value
 * @returns {number|number[]|boolean|string|null}
 */
export function constFold(value) {
  if (!value) return null;
  return value.mode === VALUE_MODE.CONST ? cloneLiteral(value.v) : null;
}

/**
 * The worst-case range a value can take, which the capacity and bounds solve
 * both need. Returns per-channel low and high.
 *
 * A link is unknowable without evaluating the operator graph, so it reports its
 * fallback and the caller treats that as an estimate - which is why the
 * capacity diagnostic says "about" rather than a hard number whenever an
 * operator feeds a spawn rate.
 *
 * @param {VfxValue} value
 * @returns {{lo: number[], hi: number[], exact: boolean}}
 */
export function valueRange(value) {
  const channels = valueChannels(value);
  const lo = new Array(channels).fill(0);
  const hi = new Array(channels).fill(0);
  const spread = (v) => (Array.isArray(v) ? v.map(asNumber) : new Array(channels).fill(asNumber(v)));

  if (!value) return { lo, hi, exact: true };

  if (value.mode === VALUE_MODE.RANDOM) {
    const a = spread(value.a);
    const b = spread(value.b);
    for (let i = 0; i < channels; i += 1) {
      lo[i] = Math.min(a[i], b[i]);
      hi[i] = Math.max(a[i], b[i]);
    }
    return { lo, hi, exact: true };
  }

  if (value.mode === VALUE_MODE.CURVE) {
    const extent = curveExtent(value.curve);
    // randomScale widens the range: the effective value is the curve times a
    // scale drawn between two numbers, so the extremes multiply.
    const scales = value.randomScale
      ? [value.randomScale[0], value.randomScale[1]]
      : [value.scale ?? 1, value.scale ?? 1];
    const candidates = [
      extent.min * scales[0], extent.min * scales[1],
      extent.max * scales[0], extent.max * scales[1],
    ];
    for (let i = 0; i < channels; i += 1) {
      lo[i] = Math.min(...candidates);
      hi[i] = Math.max(...candidates);
    }
    return { lo, hi, exact: true };
  }

  if (value.mode === VALUE_MODE.GRADIENT) {
    const rgba = new Float64Array(4);
    const min = [Infinity, Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i <= 64; i += 1) {
      evalGradient(value.gradient, i / 64, rgba);
      for (let c = 0; c < 4; c += 1) {
        if (rgba[c] < min[c]) min[c] = rgba[c];
        if (rgba[c] > max[c]) max[c] = rgba[c];
      }
    }
    return { lo: min.slice(0, channels), hi: max.slice(0, channels), exact: true };
  }

  const literal = spread(value.v);
  for (let i = 0; i < channels; i += 1) {
    lo[i] = literal[i];
    hi[i] = literal[i];
  }
  // A link or an exposed property can be anything at runtime; the caller must
  // know its number is an estimate.
  const exact = value.mode === VALUE_MODE.CONST;
  return { lo, hi, exact };
}

// Which payload key each mode stashes, so a round trip through another mode
// does not lose it.
const STASH_KEYS = Object.freeze({
  [VALUE_MODE.RANDOM]: 'random',
  [VALUE_MODE.CURVE]: 'curve',
  [VALUE_MODE.GRADIENT]: 'gradient',
  [VALUE_MODE.LINK]: 'link',
  [VALUE_MODE.EXPOSED]: 'exposed',
});

function stashOf(value) {
  const key = STASH_KEYS[value.mode];
  if (!key) return null;
  if (value.mode === VALUE_MODE.RANDOM) return { key, payload: { a: value.a, b: value.b, freq: value.freq, uniform: value.uniform } };
  if (value.mode === VALUE_MODE.CURVE) return { key, payload: { curve: value.curve, domain: value.domain, scale: value.scale, randomScale: value.randomScale } };
  if (value.mode === VALUE_MODE.GRADIENT) return { key, payload: { gradient: value.gradient, domain: value.domain } };
  if (value.mode === VALUE_MODE.LINK) return { key, payload: { nodeId: value.nodeId, port: value.port } };
  return { key, payload: { exposedId: value.exposedId } };
}

/**
 * Switch a property to a different mode, keeping as much of the author's work
 * as possible.
 *
 * This is the function behind the mode switcher in the inspector, and the
 * stash is the whole point: an author who flips a curve to a constant to try a
 * number, then flips back, must get their curve back. Without that, the mode
 * switcher is a trap and people stop touching it.
 *
 * @param {VfxValue} value
 * @param {string} nextMode
 * @param {{channels?: number, range?: {min?: number, max?: number},
 *          domain?: string}} [options]
 *   `range` comes from the property's catalog entry and keeps a derived random
 *   range inside legal bounds - no negative lifetimes, no negative sizes.
 *   `domain` likewise: which axis a curve on this property runs along is a
 *   fact about the property, not something the author picks, so a spawn rate
 *   becomes a curve over effect TIME while a size becomes one over LIFE.
 * @returns {VfxValue} a new value; the input is not modified
 */
export function setValueMode(value, nextMode, options = {}) {
  const current = normalizeValue(value, options);
  if (current.mode === nextMode) return current;

  const channels = Number.isFinite(options.channels) ? Math.max(1, options.channels | 0) : valueChannels(current);
  const stash = { ...(current.stash || {}) };
  const outgoing = stashOf(current);
  if (outgoing) stash[outgoing.key] = outgoing.payload;

  const literal = readValue(current);
  const restored = stash[STASH_KEYS[nextMode]];
  let next;

  if (nextMode === VALUE_MODE.CONST) {
    next = constValue(fitChannels(literal, channels));
  } else if (nextMode === VALUE_MODE.RANDOM) {
    if (restored) {
      next = randomValue(restored.a, restored.b, { freq: restored.freq, uniform: restored.uniform });
    } else {
      // Derive a range around the current value rather than starting at 0..1.
      // A lifetime of 2 becoming a range of 1.5..2.5 is a useful first guess;
      // becoming 0..1 throws away the number the author already chose.
      const scalar = Array.isArray(literal) ? literal : [literal];
      // A collapsed range (both bounds equal) is a random value that cannot
      // vary, which is not what anyone means by switching to random. It
      // happens whenever the literal is zero - a gravity of 0, an unset
      // offset - so widen by an absolute amount in that case rather than by a
      // percentage of nothing.
      const lo = scalar.map((n) => {
        const x = asNumber(n);
        return Math.abs(x) > 1e-6 ? x * 0.75 : x - 0.5;
      });
      const hi = scalar.map((n) => {
        const x = asNumber(n);
        return Math.abs(x) > 1e-6 ? x * 1.25 : x + 0.5;
      });
      const bound = options.range;
      const clamp = (x) => {
        let out = x;
        if (bound && Number.isFinite(bound.min)) out = Math.max(out, bound.min);
        if (bound && Number.isFinite(bound.max)) out = Math.min(out, bound.max);
        return out;
      };
      next = randomValue(
        fitChannels(channels === 1 ? clamp(lo[0]) : lo.map(clamp), channels),
        fitChannels(channels === 1 ? clamp(hi[0]) : hi.map(clamp), channels),
      );
    }
  } else if (nextMode === VALUE_MODE.CURVE) {
    // The declared domain wins over a stashed one: the property's meaning does
    // not change because the author flipped modes twice, and a document written
    // before the domain was declared has to be corrected rather than preserved.
    const domain = options.domain || restored?.domain || VALUE_DOMAIN.LIFE;
    next = restored
      ? curveValue(createCurve(restored.curve.keys, restored.curve), { ...restored, domain })
      // A flat curve at the current value: the shape is unchanged until the
      // author drags a key, so switching to curve mode never alters the look.
      : curveValue(constantCurve(1), {
        scale: asNumber(Array.isArray(literal) ? literal[0] : literal, 1),
        domain,
      });
  } else if (nextMode === VALUE_MODE.GRADIENT) {
    const domain = options.domain || restored?.domain || VALUE_DOMAIN.LIFE;
    next = restored
      ? gradientValue(createGradient(restored.gradient), { ...restored, domain })
      : gradientValue(createGradient({}), { domain });
  } else if (nextMode === VALUE_MODE.LINK) {
    next = restored
      ? linkValue(restored.nodeId, restored.port, fitChannels(literal, channels))
      : linkValue('', 'out', fitChannels(literal, channels));
  } else if (nextMode === VALUE_MODE.EXPOSED) {
    next = restored
      ? exposedValue(restored.exposedId, fitChannels(literal, channels))
      : exposedValue('', fitChannels(literal, channels));
  } else {
    next = constValue(fitChannels(literal, channels));
  }

  if (Object.keys(stash).length > 0) next.stash = stash;
  return next;
}

/**
 * True if switching away from this mode and back would lose work - which is
 * what the "Curve kept - switch back to restore" note in the inspector is
 * telling the author is NOT the case.
 *
 * @param {VfxValue} value
 * @param {string} nextMode
 * @returns {boolean}
 */
export function modeSwitchLosesWork(value, nextMode) {
  if (!value || value.mode === nextMode) return false;
  return Boolean(STASH_KEYS[value.mode]);
}

const fmt = (n) => {
  const x = asNumber(n);
  if (Number.isInteger(x)) return String(x);
  return String(Math.round(x * 1000) / 1000);
};

const fmtLiteral = (v) => (Array.isArray(v) ? v.map(fmt).join(', ') : fmt(v));

/**
 * The one-line label under a property row. Plain language, because the reader
 * is a developer who has not learned this tool's vocabulary yet - "2.0 to 4.0,
 * per particle" tells them what will happen, "random" does not.
 *
 * @param {VfxValue} value
 * @param {{unit?: string, sourceLabel?: string}} [options]
 * @returns {string}
 */
export function describeValue(value, options = {}) {
  if (!value) return '';
  const unit = options.unit ? ` ${options.unit}` : '';

  if (value.mode === VALUE_MODE.CONST) {
    if (typeof value.v === 'boolean') return value.v ? 'On' : 'Off';
    return `${fmtLiteral(value.v)}${unit}`;
  }

  if (value.mode === VALUE_MODE.RANDOM) {
    const per = value.freq === RANDOM_FREQ.PER_FRAME
      ? 'every frame'
      : value.freq === RANDOM_FREQ.PER_SPAWN_EVENT ? 'per burst' : 'per particle';
    return `${fmtLiteral(value.a)} to ${fmtLiteral(value.b)}${unit}, ${per}`;
  }

  if (value.mode === VALUE_MODE.CURVE) {
    const over = value.domain === VALUE_DOMAIN.SPEED
      ? 'over speed'
      : value.domain === VALUE_DOMAIN.TIME ? 'over effect time' : 'over life';
    if (value.randomScale) {
      return `Curve ${over}, scaled ${fmt(value.randomScale[0])} to ${fmt(value.randomScale[1])}`;
    }
    const scale = value.scale !== undefined && value.scale !== 1 ? ` x ${fmt(value.scale)}` : '';
    return `Curve ${over}${scale}`;
  }

  if (value.mode === VALUE_MODE.GRADIENT) {
    const stops = value.gradient ? value.gradient.colorKeys.length : 0;
    return `Gradient over life, ${stops} colour stop${stops === 1 ? '' : 's'}`;
  }

  if (value.mode === VALUE_MODE.LINK) {
    if (!value.nodeId) return 'Not wired yet';
    return `Wired from ${options.sourceLabel || value.nodeId}`;
  }

  if (value.mode === VALUE_MODE.EXPOSED) {
    if (!value.exposedId) return 'Not assigned yet';
    return `Set at runtime: ${options.sourceLabel || value.exposedId}`;
  }

  return '';
}
