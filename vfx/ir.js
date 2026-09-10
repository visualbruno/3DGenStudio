// The VFX intermediate representation: what the compiler produces and what
// every backend consumes.
//
// THIS IS THE CONTRACT. The preview runtime reads it, the export bundle
// carries it, and the Unity and Unreal importer plugins are written against
// it. The authoring graph can keep changing shape - new blocks, new modes, a
// reorganised document - without any of those three noticing, which is the
// whole reason the layer exists.
//
// FIVE PROPERTIES the IR guarantees, because backends are allowed to rely on
// them:
//
//  1. IT IS PLAIN JSON. No typed arrays, no functions, no class instances, no
//     NaN or Infinity. It has to survive JSON.stringify into an export bundle
//     and JSON.parse in C# and C++. Tables are number arrays; the preview
//     runtime converts them to Float32Array when it builds, which is the one
//     place that conversion belongs.
//
//  2. IT IS FLAT AND INDEX-ADDRESSED. Blocks refer to constants, uniforms and
//     tables by index into shared pools rather than embedding values. Two
//     blocks using the same curve share one table, and a backend can upload
//     each pool once.
//
//  3. EXECUTION ORDER IS THE ARRAY ORDER. `init` and `update` run front to
//     back, and two kernels are INJECTED rather than author-placed: age
//     advance plus the kill sweep runs first, integration runs last. Neither
//     Unity nor Niagara exposes the integrator as a reorderable module
//     either, and a stack the author can break by dragging is a footgun.
//
//  4. ATTRIBUTES ARE PER-EFFECT, NOT A FIXED STRUCT. `attributes` lists only
//     what some block in this effect actually touches. A simple spark needs
//     about 15 floats per particle; one with rotation, flipbook and custom
//     data needs 21. Not allocating the rest is a free cut on a loop that is
//     bandwidth-bound, and it is a compile-time decision so the runtime never
//     branches on it.
//
//  5. EVERY BINDING HAS THE SAME SHAPE. Whether the author typed a number,
//     dragged a curve, set a random range or wired an operator, a kernel
//     reads its input through one `VfxIrBinding`. That collapse is what keeps
//     the kernel catalog small and each kernel monomorphic - and it is the
//     payoff of the VfxValue union in vfx/value.js.
//
// WHAT THE IR DOES NOT PROMISE, stated here so no backend author infers it:
// bit-identical particles. Unity and Niagara each have their own RNG and
// neither lets us inject PCG32, so a spark that goes left in the preview may
// go right in an engine. What travels exactly is the structure - topology,
// block order, every curve and gradient key, constants, shapes, blend modes,
// clip timing, and WHICH properties are random over WHICH range. Seeds travel
// too, so an engine's result is reproducible even though it differs. The
// contract is statistical conformance: matching spawn counts, lifetime
// distributions, colour ramps and bounds.

/**
 * IR format version. Bump when a change would make an existing importer plugin
 * misread a bundle. A plugin declares the range it supports and must REFUSE a
 * version outside it rather than half-importing.
 */
export const VFX_IR_FORMAT = 1;

/**
 * Reserved particle attributes: the intersection of what our simulation, Unity
 * VFX Graph and Niagara can all represent per particle.
 *
 * Anything not expressible as one of these is, by definition, outside the
 * intersection and does not belong in the catalog. That constraint is what
 * keeps the importers honest.
 */
export const ATTRIBUTES = Object.freeze({
  position: { width: 3, type: 'float32', default: [0, 0, 0] },
  velocity: { width: 3, type: 'float32', default: [0, 0, 0] },
  age: { width: 1, type: 'float32', default: [0] },
  lifetime: { width: 1, type: 'float32', default: [1] },
  size: { width: 1, type: 'float32', default: [1] },
  color: { width: 4, type: 'float32', default: [1, 1, 1, 1] },
  rotation: { width: 1, type: 'float32', default: [0] },
  angularVelocity: { width: 1, type: 'float32', default: [0] },
  /** The particle's identity, hashed from the effect seed and its spawn index. */
  seed: { width: 1, type: 'uint32', default: [0] },
  spawnIndex: { width: 1, type: 'uint32', default: [0] },
  flipbookFrame: { width: 1, type: 'float32', default: [0] },
  mass: { width: 1, type: 'float32', default: [1] },
  /** Previous position, for stretched billboards and trails only. */
  prevPosition: { width: 3, type: 'float32', default: [0, 0, 0] },
  /**
   * Birth values, kept so an over-life block can MULTIPLY rather than
   * accumulate.
   *
   * Size Over Life scales the size a particle was born with. Applying the
   * curve to the live attribute instead would compound it every frame - a
   * scale of 1.1 would grow the particle by 1.1x per frame rather than once -
   * so the birth value has to survive. Allocated only when an over-life block
   * actually targets that attribute, which is what makes it free for the
   * effects that do not use one.
   */
  startSize: { width: 1, type: 'float32', default: [1] },
  startColor: { width: 4, type: 'float32', default: [1, 1, 1, 1] },
  custom0: { width: 1, type: 'float32', default: [0] },
  custom1: { width: 1, type: 'float32', default: [0] },
});

/**
 * Attributes the simulation cannot run without, so they are allocated whatever
 * the blocks ask for. Without age and lifetime nothing can die; without
 * position there is nothing to draw; seed is what makes randomness replayable.
 */
export const CORE_ATTRIBUTES = Object.freeze(['position', 'age', 'lifetime', 'seed']);

/** Where a binding reads its value from. */
export const BINDING_SRC = Object.freeze({
  /** A folded literal, in ir.constants. */
  CONST: 'const',
  /** A blackboard property a host can change at runtime, in ir.uniforms. */
  UNIFORM: 'uniform',
  /** A range drawn per particle / per frame / per burst. */
  RANDOM: 'random',
  /** A baked curve table in ir.tables, sampled by domain. */
  CURVE: 'curve',
  /** A baked RGBA gradient table in ir.tables. */
  GRADIENT: 'gradient',
  /** A register written by this block's `pre` ops. */
  REGISTER: 'register',
});

/**
 * How often a value can change. A total order, so the compiler can take the
 * max over a node's inputs and know where the work has to live.
 *
 * The payoff is concrete: anything below PER_PARTICLE is hoisted out of the
 * loop that runs sixty thousand times a frame, and CONST folds away entirely
 * at compile time. It also catches a class of error the UI cannot - a spawn
 * rate that depends on a particle attribute is not a meaningful thing to ask
 * for, and only this classification can tell.
 */
export const FREQ = Object.freeze({
  CONST: 0,
  UNIFORM: 1,
  PER_FRAME: 2,
  PER_SPAWN: 3,
  PER_PARTICLE: 4,
});

/** Human labels for FREQ, for diagnostics the author reads. */
export const FREQ_LABEL = Object.freeze({
  0: 'a fixed value',
  1: 'a runtime property',
  2: 'a per-frame value',
  3: 'a per-burst value',
  4: 'a per-particle value',
});

/**
 * The coordinate convention every vector in the IR is expressed in.
 *
 * DECLARED RATHER THAN ASSUMED, because the alternative is a mirrored effect
 * that nobody can explain. Measured on 2026-09-10 (see
 * plugins/unity/Spikes/): this editor is three.js's convention -
 * RIGHT-handed, Y-up, one unit to the metre - and **Unity is LEFT-handed**
 * with the same up axis and the same unit. Same up, same scale, opposite
 * handedness.
 *
 * So an importer targeting Unity must negate Z on every position, velocity,
 * direction and offset, and negate the X and Y of any euler rotation. Getting
 * that wrong mirrors the effect: obvious on a vortex or a directional emitter,
 * and invisible on a sphere emitter, which is what makes it worth stating in
 * the contract instead of in a comment in one plugin.
 *
 * It ships IN the IR, not only in the docs, so a plugin can refuse a bundle
 * whose space it does not recognise rather than importing it wrong.
 */
export const VFX_IR_SPACE = Object.freeze({
  handedness: 'right',
  up: 'Y',
  unit: 'metre',
});

/**
 * @typedef {Object} VfxIrBinding
 * @property {string} prop the block property this fills
 * @property {number} width channels
 * @property {string} src one of BINDING_SRC
 * @property {number} [index] into constants / uniforms / tables / registers
 * @property {number} [loIndex] random: low bound, into constants
 * @property {number} [hiIndex] random: high bound, into constants
 * @property {number} [slot] random: the compile-time draw identity, hashed
 *   from (blockId, prop) so inserting a block elsewhere cannot shift it
 * @property {string} [freq] random: 'perParticle' | 'perFrame' | 'perSpawnEvent'
 * @property {boolean} [uniformDraw] random: one draw shared across channels
 * @property {string} [domain] curve/gradient: 'life' | 'speed' | 'time'
 * @property {number} [scale] curve: multiplier on the 0..1 table
 * @property {number[]} [randomScale] curve: scale drawn between two values
 */

/**
 * @typedef {Object} VfxIrBlock
 * @property {string} kernel which kernel runs, NOT the catalog id
 * @property {string} srcBlockId back-pointer, for diagnostics and the profiler
 * @property {string} srcBlockType the catalog id, for the importers
 * @property {Object<string, string>} modes compile-time switches
 * @property {VfxIrBinding[]} bindings
 * @property {Object[]} pre expression ops evaluated before the kernel
 * @property {string[]} [attributes] what this kernel touches
 */

/**
 * @typedef {Object} VfxIr
 * @property {number} irFormat
 * @property {Object} space the coordinate convention every vector is in
 * @property {string} graphHash of the normalised document, layout excluded
 * @property {Object} effect seed, duration, loop, fixedDt, capacity, bounds
 * @property {Array<{name: string, width: number, type: string, offset: number}>} attributes
 * @property {number[]} constants
 * @property {Array<{name: string, exposedId: string, offset: number, width: number}>} uniforms
 * @property {Array<Object>} tables baked curve and gradient lookup tables,
 *   each carrying the authored curve or gradient it was baked from in
 *   `authored` - a binding's `index` addresses this array, so it is the only
 *   route from a binding to the keys an importer needs
 * @property {Array<Object>} assets resolved asset slots
 * @property {Array<Object>} systems
 * @property {Array<Object>} events
 * @property {string[]} capabilities what a backend must support to run this
 * @property {number} registerCount
 */

/**
 * A pool that de-duplicates numbers and hands back stable indices.
 *
 * De-duplication is not micro-optimisation here: a dozen blocks each defaulting
 * some property to 0 or 1 is the normal case, and one entry per distinct value
 * keeps the constants array short enough to read when debugging a bundle by eye.
 *
 * @returns {{add: (value: number) => number, addMany: (values: number[]) => number, values: () => number[]}}
 */
export function createConstantPool() {
  const values = [];
  const index = new Map();

  const add = (value) => {
    // Normalise -0 to 0 so the two do not occupy separate slots; they are
    // indistinguishable everywhere the IR is consumed.
    const v = value === 0 ? 0 : Number(value);
    if (!Number.isFinite(v)) {
      // NaN and Infinity would survive into the bundle as `null` through
      // JSON.stringify and then read back as a silent zero in C#. Refusing
      // here means the compiler reports it instead.
      throw new Error(`VFX IR: non-finite constant (${value})`);
    }
    const key = Object.is(v, -0) ? 0 : v;
    if (index.has(key)) return index.get(key);
    const at = values.length;
    values.push(key);
    index.set(key, at);
    return at;
  };

  return {
    add,
    /** Adds a run of numbers and returns the index of the first. */
    addMany: (list) => {
      const first = values.length;
      for (const value of list) {
        const v = value === 0 ? 0 : Number(value);
        if (!Number.isFinite(v)) throw new Error(`VFX IR: non-finite constant (${value})`);
        values.push(v);
      }
      // A run has to stay contiguous, so it cannot be de-duplicated against
      // scattered singles. Returning the run's own start is what keeps
      // multi-channel bindings readable with one index plus a width.
      return first;
    },
    values: () => values.slice(),
    /**
     * One constant, without copying the pool.
     *
     * `values()` returns a defensive copy, which is right for the caller that
     * puts the pool into the IR and wrong for a compiler pass that wants to
     * read back a single literal it just added - that one would copy the whole
     * array per lookup.
     */
    at: (i) => values[i],
  };
}

/**
 * A pool of baked lookup tables, keyed by content.
 *
 * Content-addressed on purpose: an author who uses one fade curve on size and
 * again on alpha gets one table, and an effect built from a template where
 * every system shares a ramp does not carry six copies of it into the bundle.
 *
 * @returns {{add: (table: Object) => number, values: () => Object[]}}
 */
export function createTablePool() {
  const tables = [];
  const index = new Map();
  return {
    add: (table) => {
      // The key includes the sample count and the data, because the same curve
      // baked at two resolutions is genuinely two tables.
      // The authored form is part of the key, not just the samples: two
      // curves that happen to bake to the same numbers but carry different
      // keys are one table to the preview and two different curves to an
      // importer, and the importer's answer is the one that has to be right.
      const key = `${table.kind}:${table.n}:${table.data.join(',')}`
        + `:${JSON.stringify(table.authored || null)}`;
      if (index.has(key)) return index.get(key);
      const at = tables.length;
      tables.push({ ...table, id: at });
      index.set(key, at);
      return at;
    },
    values: () => tables.slice(),
  };
}

/**
 * Lay out the attributes an effect needs, in a stable order with byte offsets.
 *
 * Core attributes come first and are always present; the rest follow in the
 * fixed ATTRIBUTES order rather than in the order blocks happened to request
 * them, so two effects needing the same set get the same layout - which makes
 * a pool checksum comparable across runs and a bundle diffable.
 *
 * @param {Iterable<string>} requested attribute names blocks asked for
 * @returns {{attributes: Array<Object>, floatsPerParticle: number}}
 */
export function layoutAttributes(requested) {
  const wanted = new Set(CORE_ATTRIBUTES);
  for (const name of requested) {
    if (ATTRIBUTES[name]) wanted.add(name);
  }

  const ordered = [];
  // CORE first, then catalog order. Object key order on a frozen literal is
  // insertion order in every engine we run on, so this is stable.
  for (const name of CORE_ATTRIBUTES) if (wanted.has(name)) ordered.push(name);
  for (const name of Object.keys(ATTRIBUTES)) {
    if (wanted.has(name) && !ordered.includes(name)) ordered.push(name);
  }

  let offset = 0;
  const attributes = ordered.map((name) => {
    const def = ATTRIBUTES[name];
    const entry = { name, width: def.width, type: def.type, offset };
    offset += def.width;
    return entry;
  });
  return { attributes, floatsPerParticle: offset };
}

/**
 * The per-instance vertex layout for one Output.
 *
 * ONE TABLE, BOTH SIDES. The JS write loop that fills the instanced buffer and
 * the shader's attribute declarations are both generated from this - which
 * matters because a hand-maintained layout is exactly where the two silently
 * desync. An offset wrong by one float does not error; it makes every particle
 * read its neighbour's size as its colour, and the result looks like a shader
 * bug rather than a bookkeeping one.
 *
 * Only what the output actually needs is included, on the same reasoning as
 * per-effect attributes: velocity is 12 bytes per instance that a plain
 * billboard has no use for, and the buffer write is one of the three biggest
 * per-frame costs.
 *
 * @param {Object} spec
 * @param {string} spec.mode output render mode
 * @param {Set<string>|string[]} spec.attributes attribute names the system has
 * @param {boolean} [spec.smoothing] sub-step extrapolation, which needs velocity
 * @returns {{stride: number, fields: Array<{name: string, size: number, offset: number, from: string}>}}
 */
export function buildInstanceLayout(spec) {
  const has = spec.attributes instanceof Set ? spec.attributes : new Set(spec.attributes || []);
  const fields = [];
  let offset = 0;
  const add = (name, size, from) => {
    fields.push({ name, size, offset, from });
    offset += size;
  };

  // Position, size and colour are on every particle that is drawn at all.
  add('iPos', 3, 'position');
  add('iSize', 1, 'size');
  add('iColor', 4, 'color');

  // Velocity is needed to orient a stretched billboard, and to extrapolate
  // between simulation steps so a 60Hz sim does not judder on a 144Hz display.
  const needsVelocity = spec.mode === 'stretched' || Boolean(spec.smoothing);
  if (needsVelocity && has.has('velocity')) add('iVelocity', 3, 'velocity');
  if (has.has('rotation')) add('iRotation', 1, 'rotation');
  if (has.has('flipbookFrame')) add('iTile', 1, 'flipbookFrame');

  return { stride: offset, fields };
}

/**
 * A short, stable hash of a string. Used for the graph hash that keys the
 * compile cache and for random draw slots.
 *
 * FNV-1a: not cryptographic and not meant to be. What it has to be is stable
 * across runs and across machines, which rules out anything seeded by object
 * identity or iteration order.
 *
 * @param {string} text
 * @returns {number} uint32
 */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The compile-time draw identity for one random-valued property.
 *
 * Hashed from the block id and the property name, NEVER from a counter. That
 * is what makes inserting a block above another block leave the one below it
 * untouched - see decision 3 in vfx/random.js. A counter would reshuffle every
 * random after the insertion point, which the author experiences as "editing
 * one thing changed everything else".
 *
 * @param {string} blockId
 * @param {string} prop
 * @returns {number} uint32
 */
export function drawSlot(blockId, prop) {
  return hashString(`${blockId}::${prop}`);
}

/**
 * Assert that an IR is JSON-safe before it goes into a bundle.
 *
 * Guarantee 1 is the easiest one to break by accident - a Float32Array looks
 * like an array until JSON.stringify turns it into an object with numeric
 * keys, and NaN becomes null and then a silent zero on the other side of the
 * language boundary. Checking costs nothing at compile time and the
 * alternative is a plugin author debugging our output.
 *
 * @param {VfxIr} ir
 * @returns {string[]} problems found; empty means clean
 */
export function validateIrSerializable(ir) {
  const problems = [];

  // Tracks the CURRENT PATH, not everything visited.
  //
  // The first version used a visited set, which reports any object reached
  // twice as circular - and that is wrong. A shared reference is not a cycle:
  // JSON.stringify duplicates it and both copies parse fine. The distinction
  // matters immediately, because two blocks of the same type legitimately point
  // at one shared list, and calling that an error sends the reader hunting for a
  // loop that does not exist. Only an ANCESTOR of the current node is a real
  // cycle, which is what JSON.stringify actually throws on.
  const ancestors = new Set();

  const walk = (value, path) => {
    if (value === null) return;
    const type = typeof value;
    if (type === 'number') {
      if (!Number.isFinite(value)) problems.push(`${path} is ${value}`);
      return;
    }
    if (type === 'string' || type === 'boolean') return;
    if (type === 'function' || type === 'undefined' || type === 'symbol' || type === 'bigint') {
      problems.push(`${path} is a ${type}`);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      problems.push(`${path} is a typed array (${value.constructor.name}); IR must be plain JSON`);
      return;
    }
    if (ancestors.has(value)) {
      problems.push(`${path} is a circular reference`);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
      && !Array.isArray(value)) {
      problems.push(`${path} is a class instance (${value.constructor?.name}); IR must be plain JSON`);
      return;
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) walk(value[i], `${path}[${i}]`);
    } else {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
    ancestors.delete(value);
  };

  walk(ir, 'ir');
  return problems;
}
