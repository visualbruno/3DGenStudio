// The particle kernels: one function per IR kernel name, each a pass over a
// range of the pool.
//
// No React, no three.js, no DOM. Written in the zero-allocation typed-array
// style src/utils/meshSculpt.js established - read its header; the same
// "portable to a GPGPU pipeline later without changing the JS API" goal applies
// here, which is why nothing in this file touches anything but plain arrays and
// numbers.
//
// THE SHAPE OF A KERNEL, and why it is a factory rather than a plain function.
//
// Each entry in KERNELS is a BUILDER: it receives the IR block and the
// environment once, resolves its bindings, and returns a closure over locals.
// The returned closure is what runs sixty times a second. That split is the
// whole performance story:
//
//   - a constant binding is read ONCE, at build time, into a local. The inner
//     loop then adds a number, with no indirection at all. This is the common
//     case by a wide margin.
//   - a per-particle binding (a random range, a curve, a gradient) is read
//     inside the loop, but the BRANCH deciding which is hoisted outside it.
//
// That is what the compiler's frequency classification is for. Without it,
// every kernel would test "is this a curve?" per particle per property, which
// at 60k particles and a handful of properties is millions of branches a frame
// spent re-deciding something that was known at compile time.
//
// WHY A CHAIN OF CLOSURES AND NOT ONE GENERATED LOOP. The objection that sank
// three.quarks as a backend was per-PARTICLE virtual dispatch - 60k particles
// times 6 behaviours is 360k megamorphic calls a frame. This dispatches per
// BLOCK: the outer loop is four to ten iterations and the inner loop lives
// inside each kernel, so indirection costs ~10 calls a frame, not 360k. What
// the chain does cost is redundant memory traffic, since ten passes each
// re-read age and lifetime. That is real - roughly 2.4 MB of avoidable reads
// per frame at 60k - and it is what a fused `new Function` loop would attack.
// It is deliberately not attacked yet: the chain is debuggable (every kernel is
// a named function in a flame chart), individually timeable (which is what
// makes the HUD able to say "turbulence: 2.1ms"), unit-testable, and needs no
// eval in the shipped bundle. The fused path is worth building only once the
// profiler exists and can prove the win.

import { pcgFloatAt, pcgHash2 } from '../../../vfx/random.js';
import { sampleMeshSurface, sampleMeshVertex } from './meshSample.js';
import { pushEvent } from './events.js';
import { curl3 } from '../../../vfx/noise.js';
import { BINDING_SRC } from '../../../vfx/ir.js';

// Binding kinds as small integers. A string compare per particle would be a
// pointer chase; these are compared as immediates.
const B_CONST = 0;
const B_UNIFORM = 1;
const B_RANDOM = 2;
const B_CURVE = 3;
const B_GRADIENT = 4;
const B_REGISTER = 5;

const KIND_BY_SRC = {
  [BINDING_SRC.CONST]: B_CONST,
  [BINDING_SRC.UNIFORM]: B_UNIFORM,
  [BINDING_SRC.RANDOM]: B_RANDOM,
  [BINDING_SRC.CURVE]: B_CURVE,
  [BINDING_SRC.GRADIENT]: B_GRADIENT,
  [BINDING_SRC.REGISTER]: B_REGISTER,
};

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// Module-level scratch, the house idiom. These are only used by the paths that
// genuinely need a temporary; the hot paths work in locals.
const _v3 = new Float64Array(3);
const _v4 = new Float64Array(4);

/**
 * Resolve one IR binding into a form a kernel can read cheaply.
 *
 * @param {Object} binding an IR binding
 * @param {Object} env the runtime environment
 * @returns {Object} a prepared binding
 */
export function prepareBinding(binding, env) {
  const width = binding.width || 1;
  const kind = KIND_BY_SRC[binding.src] ?? B_CONST;
  const prep = { kind, width, prop: binding.prop };

  if (kind === B_CONST) {
    prep.fixed = env.consts.slice(binding.index, binding.index + width);
  } else if (kind === B_UNIFORM) {
    prep.offset = binding.index;
  } else if (kind === B_RANDOM) {
    prep.lo = env.consts.slice(binding.loIndex, binding.loIndex + width);
    prep.hi = env.consts.slice(binding.hiIndex, binding.hiIndex + width);
    prep.slot = binding.slot >>> 0;
    prep.freq = binding.freq || 'perParticle';
    prep.uniformDraw = Boolean(binding.uniformDraw);
  } else if (kind === B_CURVE || kind === B_GRADIENT) {
    prep.table = env.tables[binding.index];
    prep.domain = binding.domain || 'life';
    prep.scale = Number.isFinite(binding.scale) ? binding.scale : 1;
    prep.randomScale = binding.randomScale || null;
    prep.slot = (binding.slot >>> 0) || 0x5bf03635;
  } else if (kind === B_REGISTER) {
    prep.offset = binding.index;
    // A source narrower than the property broadcasts - see the note in
    // lowerBinding. Defaulted to the full width so a hand-written IR without
    // srcWidth behaves as it reads.
    prep.srcWidth = Number.isFinite(binding.srcWidth) ? binding.srcWidth : width;
    // A per-particle chain is re-evaluated inside the loop, so the prep carries
    // the op list and the env it needs. Without the ops here, readChannel would
    // have nothing to re-run and the binding would read whatever the last
    // particle left in the register.
    if (binding.perParticle) {
      prep.perParticle = true;
      prep.ops = binding.ops || null;
      prep.env = env;
    }
  }
  return prep;
}

// True when a binding's value is the same for every particle in a pass, so the
// kernel can read it once before the loop.
//
// A per-particle REGISTER is the exception, and getting this wrong is invisible:
// the kernel would hoist the read out of the loop and every particle would
// silently share one value - which is exactly the behaviour the per-particle
// support exists to remove.
function isFixed(prep) {
  if (prep.kind === B_REGISTER) return !prep.perParticle;
  return prep.kind === B_CONST || prep.kind === B_UNIFORM;
}

// The fixed value of such a binding, into out.
function readFixed(prep, env, out) {
  if (prep.kind === B_CONST) {
    for (let c = 0; c < prep.width; c += 1) out[c] = prep.fixed[c];
  } else if (prep.kind === B_UNIFORM) {
    for (let c = 0; c < prep.width; c += 1) out[c] = env.uniforms[prep.offset + c];
  } else {
    // Broadcast when the source is narrower: one operator output feeding all
    // three channels of a vec3, rather than reading two registers that belong
    // to other operators.
    const span = prep.srcWidth || prep.width;
    for (let c = 0; c < prep.width; c += 1) {
      out[c] = env.regs[prep.offset + (c < span ? c : span - 1)];
    }
  }
  return out;
}

// Sample a baked table. Mirrors evalCurveLut in vfx/curve.js deliberately -
// the bake-accuracy test measures that function, and the runtime has to perform
// the identical reconstruction or the measurement means nothing.
function sampleTable(data, n, t) {
  if (!(t > 0)) return data[0];
  if (t >= 1) return data[n - 1];
  const x = t * (n - 1);
  const i = x | 0;
  const f = x - i;
  return data[i] + (data[i + 1] - data[i]) * f;
}

function sampleTableRgba(data, n, t, out) {
  const last = n - 1;
  let i;
  let f;
  if (!(t > 0)) {
    i = 0;
    f = 0;
  } else if (t >= 1) {
    i = last;
    f = 0;
  } else {
    const x = t * last;
    i = x | 0;
    f = x - i;
  }
  const o = i * 4;
  if (f === 0) {
    out[0] = data[o];
    out[1] = data[o + 1];
    out[2] = data[o + 2];
    out[3] = data[o + 3];
    return out;
  }
  const p = o + 4;
  out[0] = data[o] + (data[p] - data[o]) * f;
  out[1] = data[o + 1] + (data[p + 1] - data[o + 1]) * f;
  out[2] = data[o + 2] + (data[p + 2] - data[o + 2]) * f;
  out[3] = data[o + 3] + (data[p + 3] - data[o + 3]) * f;
  return out;
}

// The normalised position along whatever a curve is plotted against.
function domainT(domain, pool, i, env) {
  if (domain === 'time') return env.duration > 0 ? env.time / env.duration : 0;
  // 'life' - and anything unrecognised falls back to it, because a curve that
  // silently evaluates at zero is far harder to diagnose than one plotted
  // against the wrong axis.
  const lifetime = pool.planes.lifetime[i];
  return lifetime > 0 ? pool.planes.age[i] / lifetime : 0;
}

// The seed a random binding draws against, by frequency. A per-frame or
// per-burst random must NOT vary between particles, which is exactly what
// makes it a different frequency rather than a different range.
function randomSeedFor(prep, pool, i, env) {
  if (prep.freq === 'perFrame') return env.frameSeed;
  if (prep.freq === 'perSpawnEvent') return env.spawnEventSeed;
  return pool.planes.seed[i];
}

// One channel of a per-particle binding.
function readChannel(prep, pool, i, env, c) {
  if (prep.kind === B_RANDOM) {
    const seed = randomSeedFor(prep, pool, i, env);
    const t = pcgFloatAt(seed, prep.uniformDraw ? prep.slot : prep.slot + c);
    return prep.lo[c] + (prep.hi[c] - prep.lo[c]) * t;
  }
  if (prep.kind === B_CURVE) {
    const table = prep.table;
    const t = domainT(prep.domain, pool, i, env);
    let scale = prep.scale;
    if (prep.randomScale) {
      const r = pcgFloatAt(pool.planes.seed[i], prep.slot);
      scale = prep.randomScale[0] + (prep.randomScale[1] - prep.randomScale[0]) * r;
    }
    return sampleTable(table.data, table.n, t) * scale;
  }
  if (prep.kind === B_CONST) return prep.fixed[c];
  if (prep.kind === B_UNIFORM) return env.uniforms[prep.offset + c];
  if (prep.perParticle && prep.ops) runOpsForParticle(prep.ops, env, pool, i);
  const span = prep.srcWidth || prep.width;
  return env.regs[prep.offset + (c < span ? c : span - 1)];
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------
// Each builder returns a named closure, or null when the kernel has nothing to
// do in the simulation (an output's texture, for instance, is render state).

// ---------------------------------------------------------------------------
// The shape transform
// ---------------------------------------------------------------------------
// EVERY SHAPE KERNEL ENDS BY CALLING placeShape, and it is one helper rather
// than seven copies for the obvious reason: an offset applied in six kernels
// and forgotten in the seventh is a shape that ignores a control the inspector
// shows. See SHAPE_TRANSFORM_PROPS in vfx/catalog.js for why the feature exists.
//
// ROTATE THEN OFFSET, never the other way round. Offsetting first and rotating
// after would swing the shape around the effect origin on an arc, so nudging
// the rotation of an offset emitter would also MOVE it - and an author reads
// those as two independent controls.
//
// THE CONSTANT CASE IS HOISTED, which is the whole reason this is a factory.
// Offset and rotation are almost always plain numbers, so the 3x3 matrix is
// built once per spawn batch instead of per particle; and when the rotation is
// zero (the overwhelming majority) the matrix multiply is skipped entirely and
// the transform costs three adds, or nothing at all when the offset is zero too.

/** Prepare the two transform bindings. Absent props are treated as zero. */
function prepareShapeTransform(block, env) {
  const offsetBinding = block.bindings.find((b) => b.prop === 'offset');
  const rotationBinding = block.bindings.find((b) => b.prop === 'rotation');
  return {
    offset: offsetBinding ? prepareBinding(offsetBinding, env) : null,
    rotation: rotationBinding ? prepareBinding(rotationBinding, env) : null,
    // Reused across every particle in a batch rather than allocated per
    // particle: a Float64Array(9) per spawn at 60k spawns is 60k allocations
    // the collector then has to walk.
    matrix: new Float64Array(9),
    vector: new Float64Array(3),
  };
}

/**
 * Read the transform for one particle and cache it on the state.
 *
 * Called once per particle, but reads nothing when both inputs are constant -
 * in which case `state.ready` short-circuits every call after the first.
 */
function resolveShapeTransform(state, pool, i, env) {
  const { offset, rotation } = state;
  const constant = (!offset || offset.kind === B_CONST)
    && (!rotation || rotation.kind === B_CONST);
  if (constant && state.ready) return;

  let ox = 0;
  let oy = 0;
  let oz = 0;
  if (offset) {
    if (offset.kind === B_CONST) {
      ox = offset.fixed[0];
      oy = offset.fixed[1];
      oz = offset.fixed[2];
    } else {
      ox = readChannel(offset, pool, i, env, 0);
      oy = readChannel(offset, pool, i, env, 1);
      oz = readChannel(offset, pool, i, env, 2);
    }
  }
  state.ox = ox;
  state.oy = oy;
  state.oz = oz;
  state.hasOffset = ox !== 0 || oy !== 0 || oz !== 0;

  let rx = 0;
  let ry = 0;
  let rz = 0;
  if (rotation) {
    if (rotation.kind === B_CONST) {
      rx = rotation.fixed[0];
      ry = rotation.fixed[1];
      rz = rotation.fixed[2];
    } else {
      rx = readChannel(rotation, pool, i, env, 0);
      ry = readChannel(rotation, pool, i, env, 1);
      rz = readChannel(rotation, pool, i, env, 2);
    }
  }
  state.hasRotation = rx !== 0 || ry !== 0 || rz !== 0;
  if (state.hasRotation) eulerMatrix(rx * DEG, ry * DEG, rz * DEG, state.matrix);
  state.ready = constant;
}

/**
 * Euler XYZ to a row-major 3x3, as R = Rz * Ry * Rx.
 *
 * XYZ INTRINSIC ORDER, matching three.js's default and therefore every other
 * rotation the author sees in this app. Getting the order wrong is invisible
 * for a single-axis rotation - which is the common case and so the one that
 * would pass a casual check - and wrong for any combination.
 */
function eulerMatrix(x, y, z, m) {
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  m[0] = cy * cz;
  m[1] = sx * sy * cz - cx * sz;
  m[2] = cx * sy * cz + sx * sz;
  m[3] = cy * sz;
  m[4] = sx * sy * sz + cx * cz;
  m[5] = cx * sy * sz - sx * cz;
  m[6] = -sy;
  m[7] = sx * cy;
  m[8] = cx * cy;
}

/** Rotate xyz by the state's matrix and add its offset, writing into `plane`. */
function placeShape(state, plane, o, x, y, z) {
  if (state.hasRotation) {
    const m = state.matrix;
    const rx = m[0] * x + m[1] * y + m[2] * z;
    const ry = m[3] * x + m[4] * y + m[5] * z;
    const rz = m[6] * x + m[7] * y + m[8] * z;
    plane[o] = rx + state.ox;
    plane[o + 1] = ry + state.oy;
    plane[o + 2] = rz + state.oz;
    return;
  }
  plane[o] = x + state.ox;
  plane[o + 1] = y + state.oy;
  plane[o + 2] = z + state.oz;
}

/**
 * Rotate a DIRECTION by the state's matrix - no offset.
 *
 * Separate from placeShape because a velocity is not a position: adding the
 * emitter's offset to it would send every particle drifting towards the offset
 * at a speed proportional to how far the shape was moved, which is a genuinely
 * baffling bug to look at.
 */
function rotateDirection(state, plane, o, x, y, z) {
  if (state.hasRotation) {
    const m = state.matrix;
    plane[o] = m[0] * x + m[1] * y + m[2] * z;
    plane[o + 1] = m[3] * x + m[4] * y + m[5] * z;
    plane[o + 2] = m[6] * x + m[7] * y + m[8] * z;
    return;
  }
  plane[o] = x;
  plane[o + 1] = y;
  plane[o + 2] = z;
}

const KERNELS = {
  /**
   * Advance age, kill what has expired, and clear the force accumulator.
   *
   * Injected, always first. Two things happen here that everything downstream
   * relies on: nothing after this point can touch a dead particle, and the
   * accumulator starts every step at zero so forces add rather than compound.
   */
  'age.advance': (block, env) => {
    // Which event channel this system's deaths feed, or -1 for none. Resolved
    // once at build: the overwhelming majority of systems have no death
    // listener, and those pay one comparison per frame rather than per
    // particle.
    const channel = Number.isInteger(block.deathChannel) ? block.deathChannel : -1;
    return function ageAdvance(pool, i0, i1, dt) {
      const age = pool.planes.age;
      const lifetime = pool.planes.lifetime;
      for (let i = i0; i < i1; i += 1) age[i] += dt;

      // Sweep for deaths. swapRemove moves the last live particle into i, so i
      // must be re-tested rather than advanced past - the incoming particle has
      // not been examined yet and may itself be dead.
      let i = i0;
      while (i < pool.count) {
        if (age[i] >= lifetime[i]) {
          // RECORDED BEFORE THE REMOVAL, because swapRemove overwrites slot i
          // with the last live particle - reading the payload afterwards would
          // give a child the position of a completely unrelated particle, which
          // is the kind of bug that looks like the events are firing in the
          // wrong place rather than being read at the wrong moment.
          if (channel >= 0) pushEvent(env.events, channel, pool, i);
          swapRemoveInline(pool, i);
        } else i += 1;
      }

      pool.accel.fill(0, 0, pool.count * 3);
    };
  },

  /**
   * Copy birth values aside, so over-life blocks can scale them.
   *
   * Injected at the end of Initialize. One pass after every setter has run,
   * rather than each setter writing its own copy - the author can order
   * Initialize any way they like, and a setter that also wrote the birth copy
   * would capture whatever the state was at ITS point in the stack.
   */
  'init.snapshot': (block) => {
    const pairs = (block.snapshot || []).map(({ from, to }) => [from, to]);
    return function initSnapshot(pool, i0, i1) {
      for (const [fromName, toName] of pairs) {
        const from = pool.planes[fromName];
        const to = pool.planes[toName];
        if (!from || !to) continue;
        const width = pool.widths[fromName];
        for (let i = i0 * width; i < i1 * width; i += 1) to[i] = from[i];
      }
    };
  },

  /**
   * Write an attribute from a binding.
   *
   * The target attribute is the BINDING'S PROPERTY NAME. That works because
   * every catalog block lowering to this kernel names its property after the
   * attribute it sets - lifetime, size, colour. It is a contract between the
   * catalog and this kernel, and catalog.test.mjs is where it would be caught
   * if a new block broke it. A missing plane is a no-op rather than a throw,
   * because the compiler allocating the wrong attribute set is a bug worth
   * seeing as a visibly wrong effect rather than a dead preview.
   */
  'attr.set': (block, env) => {
    const preps = block.bindings.map((b) => prepareBinding(b, env));
    return function attrSet(pool, i0, i1) {
      for (const prep of preps) {
        const plane = pool.planes[prep.prop];
        if (!plane) continue;
        const width = prep.width;
        if (isFixed(prep)) {
          readFixed(prep, env, _v4);
          for (let i = i0; i < i1; i += 1) {
            const o = i * width;
            for (let c = 0; c < width; c += 1) plane[o + c] = _v4[c];
          }
        } else {
          for (let i = i0; i < i1; i += 1) {
            const o = i * width;
            for (let c = 0; c < width; c += 1) plane[o + c] = readChannel(prep, pool, i, env, c);
          }
        }
      }
    };
  },

  /** Place particles in or on a sphere. */
  'shape.position.sphere': (block, env) => {
    const radius = prepareBinding(block.bindings.find((b) => b.prop === 'radius'), env);
    const surface = block.modes?.fill === 'surface';
    const transform = prepareShapeTransform(block, env);
    const slot = 0x51ed270b;
    return function shapePositionSphere(pool, i0, i1) {
      const position = pool.planes.position;
      const seeds = pool.planes.seed;
      transform.ready = false;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        resolveShapeTransform(transform, pool, i, env);
        const r0 = radius.kind === B_CONST ? radius.fixed[0] : readChannel(radius, pool, i, env, 0);
        // Uniform on the sphere: z uniform in [-1,1] and the azimuth uniform.
        // Picking two angles uniformly instead clusters points at the poles,
        // which reads as a visible seam on a shell emitter.
        const u = pcgFloatAt(seed, slot) * 2 - 1;
        const theta = pcgFloatAt(seed, slot + 1) * TAU;
        // Cube root for a volume fill: without it the same count of points
        // crowds the centre, because a shell's area grows as r squared.
        const r = surface ? r0 : r0 * Math.cbrt(pcgFloatAt(seed, slot + 2));
        const ring = Math.sqrt(Math.max(0, 1 - u * u));
        placeShape(transform, position, i * 3,
          r * ring * Math.cos(theta), r * ring * Math.sin(theta), r * u);
      }
    };
  },

  /**
   * Emit from a cone: position on the mouth, velocity along the spread.
   *
   * Both, in one kernel, because a cone that only positioned particles would
   * make its Spread property do nothing at all - and a property with no effect
   * is worse than a missing feature. Niagara's Cone Location sets both for the
   * same reason.
   */
  'shape.cone': (block, env) => {
    const angle = prepareBinding(block.bindings.find((b) => b.prop === 'angle'), env);
    const radius = prepareBinding(block.bindings.find((b) => b.prop === 'radius'), env);
    const speed = prepareBinding(block.bindings.find((b) => b.prop === 'speed'), env);
    const transform = prepareShapeTransform(block, env);
    const slot = 0x2f9a1c07;
    return function shapeCone(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      const seeds = pool.planes.seed;
      transform.ready = false;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        resolveShapeTransform(transform, pool, i, env);
        const halfAngle = (angle.kind === B_CONST ? angle.fixed[0] : readChannel(angle, pool, i, env, 0)) * DEG;
        const r0 = radius.kind === B_CONST ? radius.fixed[0] : readChannel(radius, pool, i, env, 0);
        const v0 = speed.kind === B_CONST ? speed.fixed[0] : readChannel(speed, pool, i, env, 0);

        const theta = pcgFloatAt(seed, slot) * TAU;
        // Square root, so the mouth fills evenly rather than crowding the axis.
        const rr = r0 * Math.sqrt(pcgFloatAt(seed, slot + 1));
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const o = i * 3;
        placeShape(transform, position, o, rr * cosT, 0, rr * sinT);

        // Direction: a polar angle drawn so the distribution is even across the
        // cone's solid angle, not even in the angle itself - the latter
        // concentrates particles down the axis and makes a wide cone look like
        // a narrow one with strays.
        const cosMax = Math.cos(halfAngle);
        const cosPhi = 1 - pcgFloatAt(seed, slot + 2) * (1 - cosMax);
        const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
        const dTheta = pcgFloatAt(seed, slot + 3) * TAU;
        // ROTATED, NOT PLACED: a velocity takes the shape's orientation but not
        // its offset - see rotateDirection. This is what makes Rotation turn a
        // cone into an angled jet rather than a cone that sprays up the Y axis
        // from a moved position.
        rotateDirection(transform, velocity, o,
          v0 * sinPhi * Math.cos(dTheta), v0 * cosPhi, v0 * sinPhi * Math.sin(dTheta));
      }
    };
  },

  /** Place particles inside a box. */
  'shape.position.box': (block, env) => {
    const size = prepareBinding(block.bindings.find((b) => b.prop === 'size'), env);
    const transform = prepareShapeTransform(block, env);
    const slot = 0x1d3a77b1;
    return function shapePositionBox(pool, i0, i1) {
      const position = pool.planes.position;
      const seeds = pool.planes.seed;
      const fixed = size.kind === B_CONST;
      transform.ready = false;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        resolveShapeTransform(transform, pool, i, env);
        // Centred on the origin, so a box emitter grows symmetrically when its
        // size changes. Growing from one corner would make resizing it also
        // move the effect - Offset is for moving it.
        const x = (pcgFloatAt(seed, slot) - 0.5) * (fixed ? size.fixed[0] : readChannel(size, pool, i, env, 0));
        const y = (pcgFloatAt(seed, slot + 1) - 0.5) * (fixed ? size.fixed[1] : readChannel(size, pool, i, env, 1));
        const z = (pcgFloatAt(seed, slot + 2) - 0.5) * (fixed ? size.fixed[2] : readChannel(size, pool, i, env, 2));
        placeShape(transform, position, i * 3, x, y, z);
      }
    };
  },

  /**
   * Place particles on or inside a circle in the XZ plane.
   *
   * XZ rather than XY because Y is up everywhere else in this runtime, and a
   * circle emitter is nearly always a ring on the ground or a portal mouth.
   */
  'shape.position.circle': (block, env) => {
    const radius = prepareBinding(block.bindings.find((b) => b.prop === 'radius'), env);
    const thickness = prepareBinding(block.bindings.find((b) => b.prop === 'thickness'), env);
    const transform = prepareShapeTransform(block, env);
    const slot = 0x63c9a8f3;
    return function shapePositionCircle(pool, i0, i1) {
      const position = pool.planes.position;
      const seeds = pool.planes.seed;
      transform.ready = false;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        resolveShapeTransform(transform, pool, i, env);
        const r0 = radius.kind === B_CONST ? radius.fixed[0] : readChannel(radius, pool, i, env, 0);
        const band = thickness.kind === B_CONST
          ? thickness.fixed[0]
          : readChannel(thickness, pool, i, env, 0);
        const theta = pcgFloatAt(seed, slot) * TAU;
        // Square root inside the band, so a filled disc does not crowd its
        // centre - the same correction as the cone's mouth.
        const inner = Math.max(0, r0 - band);
        const t = pcgFloatAt(seed, slot + 1);
        const r = Math.sqrt(inner * inner + t * (r0 * r0 - inner * inner));
        // Flat in XZ, and Rotation is what stands it up: (90, 0, 0) turns the
        // ring on the floor into a vertical one facing Z, which is what a
        // portal or a spell circle on a wall wants.
        placeShape(transform, position, i * 3, r * Math.cos(theta), 0, r * Math.sin(theta));
      }
    };
  },

  /**
   * Every particle at one coordinate, optionally softened into a small ball.
   *
   * THE JITTER IS A CUBE-ROOTED RADIUS, not a uniform one, for the same reason
   * the sphere's volume fill is: a uniform radius crowds the centre, so a
   * jittered point emitter would read as a dense core with a faint halo rather
   * than as a soft ball.
   */
  'shape.position.point': (block, env) => {
    const offset = prepareBinding(block.bindings.find((b) => b.prop === 'offset'), env);
    const jitter = prepareBinding(block.bindings.find((b) => b.prop === 'jitter'), env);
    const slot = 0x7b1e4d95;
    return function shapePositionPoint(pool, i0, i1) {
      const position = pool.planes.position;
      const seeds = pool.planes.seed;
      const fixedOffset = offset.kind === B_CONST;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        const ox = fixedOffset ? offset.fixed[0] : readChannel(offset, pool, i, env, 0);
        const oy = fixedOffset ? offset.fixed[1] : readChannel(offset, pool, i, env, 1);
        const oz = fixedOffset ? offset.fixed[2] : readChannel(offset, pool, i, env, 2);
        const j = jitter.kind === B_CONST ? jitter.fixed[0] : readChannel(jitter, pool, i, env, 0);
        const o = i * 3;
        if (!(j > 0)) {
          position[o] = ox;
          position[o + 1] = oy;
          position[o + 2] = oz;
          continue;
        }
        const u = pcgFloatAt(seed, slot) * 2 - 1;
        const theta = pcgFloatAt(seed, slot + 1) * TAU;
        const r = j * Math.cbrt(pcgFloatAt(seed, slot + 2));
        const ring = Math.sqrt(Math.max(0, 1 - u * u));
        position[o] = ox + r * ring * Math.cos(theta);
        position[o + 1] = oy + r * ring * Math.sin(theta);
        position[o + 2] = oz + r * u;
      }
    };
  },

  /**
   * Spread particles along the segment from `start` to `end`.
   *
   * THREE PLACEMENTS, AND THEY ARE NOT INTERCHANGEABLE:
   *
   *   random  - t drawn per particle. Scatters. What dust, fire and sparks want.
   *   even    - t spread across THIS SPAWN BATCH. A burst of 40 lands as 40
   *             equally spaced particles covering the whole line, which is what
   *             a beam appearing all at once looks like. Batch, not lifetime,
   *             because the kernel is handed [i0, i1) and that IS the batch -
   *             and for a rate emitter "even" then means each frame's handful
   *             is spread over the line, which is the same reading.
   *   spacing - t derived from the particle's GLOBAL SPAWN INDEX, so consecutive
   *             particles sit a fixed number of metres apart and the pattern
   *             marches along the line and wraps. This is the one that needs an
   *             identity rather than a random number, and it is why the block
   *             declares the spawnIndex attribute.
   *
   * The line's own endpoints carry its position and direction, so there is no
   * shape transform here - see SHAPE_TRANSFORM_PROPS in the catalog.
   */
  'shape.position.line': (block, env) => {
    const startB = prepareBinding(block.bindings.find((b) => b.prop === 'start'), env);
    const endB = prepareBinding(block.bindings.find((b) => b.prop === 'end'), env);
    const thickness = prepareBinding(block.bindings.find((b) => b.prop === 'thickness'), env);
    const spacingB = prepareBinding(block.bindings.find((b) => b.prop === 'spacing'), env);
    const placement = block.modes?.placement || 'random';
    const slot = 0x3ac7f61d;
    return function shapePositionLine(pool, i0, i1) {
      const position = pool.planes.position;
      const seeds = pool.planes.seed;
      const spawnIndices = pool.planes.spawnIndex;
      const fixedStart = startB.kind === B_CONST;
      const fixedEnd = endB.kind === B_CONST;
      // Hoisted: the batch size is what "even" divides by, and reading it once
      // keeps the loop body free of the branch. A single-particle batch sits at
      // the start rather than dividing by zero.
      const span = Math.max(1, i1 - i0 - 1);
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        const sx = fixedStart ? startB.fixed[0] : readChannel(startB, pool, i, env, 0);
        const sy = fixedStart ? startB.fixed[1] : readChannel(startB, pool, i, env, 1);
        const sz = fixedStart ? startB.fixed[2] : readChannel(startB, pool, i, env, 2);
        const ex = fixedEnd ? endB.fixed[0] : readChannel(endB, pool, i, env, 0);
        const ey = fixedEnd ? endB.fixed[1] : readChannel(endB, pool, i, env, 1);
        const ez = fixedEnd ? endB.fixed[2] : readChannel(endB, pool, i, env, 2);

        let t;
        if (placement === 'even') {
          t = (i - i0) / span;
        } else if (placement === 'spacing') {
          const dx = ex - sx;
          const dy = ey - sy;
          const dz = ez - sz;
          const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const step = spacingB.kind === B_CONST
            ? spacingB.fixed[0]
            : readChannel(spacingB, pool, i, env, 0);
          // A zero-length line or a zero spacing collapses to the start rather
          // than dividing by zero and writing NaN into the pool - one NaN
          // position propagates through every force and kills the whole system.
          if (!(length > 0) || !(step > 0)) t = 0;
          else {
            const index = spawnIndices ? spawnIndices[i] : (i - i0);
            // Wrapped with a remainder, so the pattern repeats along the line
            // instead of every particle after the first pass piling up at the
            // far end.
            t = ((index * step) % length) / length;
          }
        } else {
          t = pcgFloatAt(seed, slot);
        }

        let x = sx + (ex - sx) * t;
        let y = sy + (ey - sy) * t;
        let z = sz + (ez - sz) * t;

        const band = thickness.kind === B_CONST
          ? thickness.fixed[0]
          : readChannel(thickness, pool, i, env, 0);
        if (band > 0) {
          // A ball around the point rather than a disc perpendicular to the
          // line: building the perpendicular frame costs a cross product and a
          // normalise per particle, and at the thicknesses a line emitter is
          // used at - a few centimetres, to stop it reading as a hairline - the
          // two are indistinguishable.
          const u = pcgFloatAt(seed, slot + 1) * 2 - 1;
          const theta = pcgFloatAt(seed, slot + 2) * TAU;
          const r = band * Math.cbrt(pcgFloatAt(seed, slot + 3));
          const ring = Math.sqrt(Math.max(0, 1 - u * u));
          x += r * ring * Math.cos(theta);
          y += r * ring * Math.sin(theta);
          z += r * u;
        }

        const o = i * 3;
        position[o] = x;
        position[o + 1] = y;
        position[o + 2] = z;
      }
    };
  },

  /**
   * Spawn over the surface (or the vertices) of a mesh asset.
   *
   * THE SAMPLER ARRIVES LATE, AND THAT IS THE INTERESTING PART. Geometry is
   * loaded asynchronously by the browser layer, long after the kernel chain was
   * built, so this reads `env.meshSamplers` on every invocation rather than
   * capturing a sampler at build time. Until the mesh lands, every particle is
   * born at the shape's offset - visibly wrong in a way the author can act on,
   * rather than an effect that never appears. The lookup is one Map.get per
   * spawn batch, hoisted out of the particle loop.
   *
   * NORMAL SPEED IS WHAT MAKES IT READ AS A SURFACE. Without it a mesh emitter
   * is a cloud of points that happens to have the right silhouette, because
   * nothing tells the viewer which way the surface faced. It is left at zero by
   * default all the same, so the block composes with a separate velocity block
   * rather than fighting it.
   */
  'shape.position.mesh': (block, env) => {
    const scale = prepareBinding(block.bindings.find((b) => b.prop === 'scale'), env);
    const normalSpeed = prepareBinding(block.bindings.find((b) => b.prop === 'normalSpeed'), env);
    const transform = prepareShapeTransform(block, env);
    const vertexMode = block.modes?.sampling === 'vertex';
    const assetIndex = block.assetSlots ? block.assetSlots.mesh : -1;
    const assetId = assetIndex >= 0 ? env.assets?.[assetIndex]?.assetId ?? null : null;
    const slot = 0x5d8b23a7;
    const point = new Float64Array(3);
    const normal = new Float64Array(3);
    return function shapePositionMesh(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      const seeds = pool.planes.seed;
      const sampler = assetId != null ? env.meshSamplers?.get(assetId) : null;
      transform.ready = false;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        resolveShapeTransform(transform, pool, i, env);
        const s0 = scale.kind === B_CONST ? scale.fixed[0] : readChannel(scale, pool, i, env, 0);
        const o = i * 3;

        if (!sampler) {
          placeShape(transform, position, o, 0, 0, 0);
          continue;
        }

        if (vertexMode) {
          sampleMeshVertex(sampler, pcgFloatAt(seed, slot), point, normal);
        } else {
          sampleMeshSurface(
            sampler,
            pcgFloatAt(seed, slot),
            pcgFloatAt(seed, slot + 1),
            pcgFloatAt(seed, slot + 2),
            point,
            normal,
          );
        }

        placeShape(transform, position, o, point[0] * s0, point[1] * s0, point[2] * s0);

        const v0 = normalSpeed.kind === B_CONST
          ? normalSpeed.fixed[0]
          : readChannel(normalSpeed, pool, i, env, 0);
        // Guarded, not written unconditionally: at zero this block must leave
        // velocity for another block to set, and a plain write of zero would
        // silently undo whatever ran before it in the stack.
        if (v0 !== 0 && velocity) {
          rotateDirection(transform, velocity, o,
            normal[0] * v0, normal[1] * v0, normal[2] * v0);
        }
      }
    };
  },

  /**
   * Velocity pointing away from the origin - what an explosion is made of.
   *
   * Reads the position the shape block already set, so it must run AFTER one.
   * A particle exactly at the origin has no direction to move in, so it gets a
   * deterministic one from its own seed rather than a zero velocity: a burst
   * from a point emitter would otherwise leave every particle sitting still.
   */
  'vel.radial': (block, env) => {
    const speed = prepareBinding(block.bindings.find((b) => b.prop === 'speed'), env);
    const slot = 0x3ba71e05;
    return function velRadial(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      const seeds = pool.planes.seed;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const v0 = speed.kind === B_CONST ? speed.fixed[0] : readChannel(speed, pool, i, env, 0);
        let x = position[o];
        let y = position[o + 1];
        let z = position[o + 2];
        let length = Math.sqrt(x * x + y * y + z * z);
        if (length < 1e-6) {
          const seed = seeds[i];
          const u = pcgFloatAt(seed, slot) * 2 - 1;
          const theta = pcgFloatAt(seed, slot + 1) * TAU;
          const ring = Math.sqrt(Math.max(0, 1 - u * u));
          x = ring * Math.cos(theta);
          y = ring * Math.sin(theta);
          z = u;
          length = 1;
        }
        const scale = v0 / length;
        velocity[o] = x * scale;
        velocity[o + 1] = y * scale;
        velocity[o + 2] = z * scale;
      }
    };
  },

  /**
   * Velocity along a direction, with a cone of spread around it.
   *
   * Rain, snow and jets. The spread is drawn evenly over the cone's SOLID
   * angle, the same correction as shape.cone - spreading the angle itself
   * concentrates particles down the axis and makes a wide spread look like a
   * narrow one with strays.
   */
  'vel.direction': (block, env) => {
    const direction = prepareBinding(block.bindings.find((b) => b.prop === 'direction'), env);
    const speed = prepareBinding(block.bindings.find((b) => b.prop === 'speed'), env);
    const spread = prepareBinding(block.bindings.find((b) => b.prop === 'spread'), env);
    const slot = 0x4e17c2d9;
    return function velDirection(pool, i0, i1) {
      const velocity = pool.planes.velocity;
      const seeds = pool.planes.seed;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const dx = direction.kind === B_CONST ? direction.fixed[0] : readChannel(direction, pool, i, env, 0);
        const dy = direction.kind === B_CONST ? direction.fixed[1] : readChannel(direction, pool, i, env, 1);
        const dz = direction.kind === B_CONST ? direction.fixed[2] : readChannel(direction, pool, i, env, 2);
        const v0 = speed.kind === B_CONST ? speed.fixed[0] : readChannel(speed, pool, i, env, 0);
        const half = (spread.kind === B_CONST ? spread.fixed[0] : readChannel(spread, pool, i, env, 0)) * DEG;

        let length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // A zero direction falls back to down, which is what rain and snow
        // want and is at least a direction - a zero velocity would look like
        // the block was doing nothing.
        let ax = 0;
        let ay = -1;
        let az = 0;
        if (length > 1e-6) {
          ax = dx / length;
          ay = dy / length;
          az = dz / length;
        }

        if (half <= 1e-6) {
          velocity[o] = ax * v0;
          velocity[o + 1] = ay * v0;
          velocity[o + 2] = az * v0;
          continue;
        }

        const seed = seeds[i];
        const cosMax = Math.cos(half);
        const cosPhi = 1 - pcgFloatAt(seed, slot) * (1 - cosMax);
        const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
        const theta = pcgFloatAt(seed, slot + 1) * TAU;

        // An orthonormal basis around the axis. The tangent is built from
        // whichever cardinal is least parallel to the axis, because crossing
        // with a fixed one degenerates when the axis happens to match it -
        // which for a downward rain direction is exactly the common case.
        let tx = 0;
        let ty = 0;
        let tz = 0;
        if (Math.abs(ay) < 0.9) {
          tx = -az;
          ty = 0;
          tz = ax;
        } else {
          tx = ay;
          ty = -ax;
          tz = 0;
        }
        length = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tx /= length;
        ty /= length;
        tz /= length;
        const bx = ay * tz - az * ty;
        const by = az * tx - ax * tz;
        const bz = ax * ty - ay * tx;

        const cosTheta = Math.cos(theta) * sinPhi;
        const sinTheta = Math.sin(theta) * sinPhi;
        velocity[o] = (ax * cosPhi + tx * cosTheta + bx * sinTheta) * v0;
        velocity[o + 1] = (ay * cosPhi + ty * cosTheta + by * sinTheta) * v0;
        velocity[o + 2] = (az * cosPhi + tz * cosTheta + bz * sinTheta) * v0;
      }
    };
  },

  /**
   * Pull towards, or push away from, a point.
   *
   * The falloff is 1/(1 + d^2/radius^2) rather than the physical 1/d^2, which
   * would be infinite at the centre and put a particle at NaN the moment one
   * arrived. This form is finite everywhere, tends to the same shape far away,
   * and is what both engines' point-force modules use.
   */
  'force.attract': (block, env) => {
    const centre = prepareBinding(block.bindings.find((b) => b.prop === 'position'), env);
    const strength = prepareBinding(block.bindings.find((b) => b.prop === 'strength'), env);
    const radius = prepareBinding(block.bindings.find((b) => b.prop === 'radius'), env);
    return function forceAttract(pool, i0, i1) {
      const position = pool.planes.position;
      const accel = pool.accel;
      const fixedCentre = centre.kind === B_CONST;
      const cx = fixedCentre ? centre.fixed[0] : 0;
      const cy = fixedCentre ? centre.fixed[1] : 0;
      const cz = fixedCentre ? centre.fixed[2] : 0;
      const fixedStrength = strength.kind === B_CONST ? strength.fixed[0] : null;
      const fixedRadius = radius.kind === B_CONST ? radius.fixed[0] : null;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const px = fixedCentre ? cx : readChannel(centre, pool, i, env, 0);
        const py = fixedCentre ? cy : readChannel(centre, pool, i, env, 1);
        const pz = fixedCentre ? cz : readChannel(centre, pool, i, env, 2);
        const g = fixedStrength !== null ? fixedStrength : readChannel(strength, pool, i, env, 0);
        const r = fixedRadius !== null ? fixedRadius : readChannel(radius, pool, i, env, 0);

        const dx = px - position[o];
        const dy = py - position[o + 1];
        const dz = pz - position[o + 2];
        const distanceSq = dx * dx + dy * dy + dz * dz;
        const distance = Math.sqrt(distanceSq);
        if (distance < 1e-6) continue;
        const scale = r > 1e-6 ? 1 / (1 + distanceSq / (r * r)) : 1;
        const a = (g * scale) / distance;
        accel[o] += dx * a;
        accel[o + 1] += dy * a;
        accel[o + 2] += dz * a;
      }
    };
  },

  /**
   * Swirl around an axis through a point - a portal, a tornado, a drain.
   *
   * Two components, because one alone does not read as a vortex: a tangential
   * push produces the rotation, and an inward pull is what stops the particles
   * spiralling out of the effect within a second. Niagara's vortex force and
   * Unity's Vortex block are both this pair.
   */
  'force.vortex': (block, env) => {
    const centre = prepareBinding(block.bindings.find((b) => b.prop === 'position'), env);
    const axisBinding = prepareBinding(block.bindings.find((b) => b.prop === 'axis'), env);
    const strength = prepareBinding(block.bindings.find((b) => b.prop === 'strength'), env);
    const inward = prepareBinding(block.bindings.find((b) => b.prop === 'inward'), env);
    return function forceVortex(pool, i0, i1) {
      const position = pool.planes.position;
      const accel = pool.accel;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const cx = centre.kind === B_CONST ? centre.fixed[0] : readChannel(centre, pool, i, env, 0);
        const cy = centre.kind === B_CONST ? centre.fixed[1] : readChannel(centre, pool, i, env, 1);
        const cz = centre.kind === B_CONST ? centre.fixed[2] : readChannel(centre, pool, i, env, 2);
        let axX = axisBinding.kind === B_CONST ? axisBinding.fixed[0] : readChannel(axisBinding, pool, i, env, 0);
        let axY = axisBinding.kind === B_CONST ? axisBinding.fixed[1] : readChannel(axisBinding, pool, i, env, 1);
        let axZ = axisBinding.kind === B_CONST ? axisBinding.fixed[2] : readChannel(axisBinding, pool, i, env, 2);
        const g = strength.kind === B_CONST ? strength.fixed[0] : readChannel(strength, pool, i, env, 0);
        const pull = inward.kind === B_CONST ? inward.fixed[0] : readChannel(inward, pool, i, env, 0);

        let axisLength = Math.sqrt(axX * axX + axY * axY + axZ * axZ);
        if (axisLength < 1e-6) {
          axX = 0;
          axY = 1;
          axZ = 0;
          axisLength = 1;
        }
        axX /= axisLength;
        axY /= axisLength;
        axZ /= axisLength;

        const dx = position[o] - cx;
        const dy = position[o + 1] - cy;
        const dz = position[o + 2] - cz;
        // The component of the offset perpendicular to the axis. Using the raw
        // offset instead would make a particle above the centre swirl around a
        // point it is not level with, which reads as a wobble rather than a
        // rotation.
        const along = dx * axX + dy * axY + dz * axZ;
        const rx = dx - axX * along;
        const ry = dy - axY * along;
        const rz = dz - axZ * along;
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (r < 1e-6) continue;

        // Tangential: axis x radial.
        accel[o] += (axY * rz - axZ * ry) * g - (rx / r) * pull;
        accel[o + 1] += (axZ * rx - axX * rz) * g - (ry / r) * pull;
        accel[o + 2] += (axX * ry - axY * rx) * g - (rz / r) * pull;
      }
    };
  },

  /** Cap the speed, without changing the direction. */
  'vel.limit': (block, env) => {
    const limit = prepareBinding(block.bindings.find((b) => b.prop === 'speed'), env);
    return function velLimit(pool, i0, i1) {
      const velocity = pool.planes.velocity;
      const fixed = limit.kind === B_CONST ? limit.fixed[0] : null;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const max = fixed !== null ? fixed : readChannel(limit, pool, i, env, 0);
        if (!(max > 0)) continue;
        const vx = velocity[o];
        const vy = velocity[o + 1];
        const vz = velocity[o + 2];
        const speedSq = vx * vx + vy * vy + vz * vz;
        // Compared as squares, so the square root is only paid by the
        // particles that are actually over the limit.
        if (speedSq <= max * max) continue;
        const scale = max / Math.sqrt(speedSq);
        velocity[o] = vx * scale;
        velocity[o + 1] = vy * scale;
        velocity[o + 2] = vz * scale;
      }
    };
  },

  /**
   * Spin a particle, in degrees per second.
   *
   * A separate kernel rather than part of the integrator, because rotation is
   * only allocated when something asks for it - and an integrator that touched
   * a plane which might not exist would have to branch per particle.
   */
  'rot.spin': (block, env) => {
    const rate = prepareBinding(block.bindings.find((b) => b.prop === 'speed'), env);
    return function rotSpin(pool, i0, i1, dt) {
      const rotation = pool.planes.rotation;
      if (!rotation) return;
      const fixed = rate.kind === B_CONST ? rate.fixed[0] * DEG * dt : null;
      for (let i = i0; i < i1; i += 1) {
        rotation[i] += fixed !== null ? fixed : readChannel(rate, pool, i, env, 0) * DEG * dt;
      }
    };
  },

  /**
   * Bounce off an infinite horizontal plane.
   *
   * The one collision shape worth having before a full collision system: a
   * floor is what debris, blood and sparks need, and it costs one comparison
   * per particle with no acceleration structure at all.
   *
   * It corrects the POSITION as well as the velocity. Reflecting the velocity
   * alone leaves the particle below the plane for a frame, and with a low
   * bounce it never climbs back out - so it sinks, jittering, which reads as
   * the collision being broken rather than as inelastic.
   */
  'collide.plane': (block, env) => {
    const height = prepareBinding(block.bindings.find((b) => b.prop === 'height'), env);
    const bounce = prepareBinding(block.bindings.find((b) => b.prop === 'bounce'), env);
    const friction = prepareBinding(block.bindings.find((b) => b.prop === 'friction'), env);
    const channel = Number.isInteger(block.collideChannel) ? block.collideChannel : -1;
    return function collidePlane(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const y = height.kind === B_CONST ? height.fixed[0] : readChannel(height, pool, i, env, 0);
        if (position[o + 1] >= y) continue;
        const restitution = bounce.kind === B_CONST ? bounce.fixed[0] : readChannel(bounce, pool, i, env, 0);
        const drag = friction.kind === B_CONST ? friction.fixed[0] : readChannel(friction, pool, i, env, 0);
        // Reflected about the plane, so a particle that overshot by 0.1 ends up
        // 0.1 above it rather than exactly on it - which is what keeps a
        // bouncing particle's arc smooth instead of clipping to the floor.
        // Recorded BEFORE the correction, so the payload is the point of
        // contact rather than where the particle ended up after bouncing -
        // which is where a spark's impact puff belongs.
        if (channel >= 0) pushEvent(env.events, channel, pool, i);
        position[o + 1] = y + (y - position[o + 1]) * restitution;
        if (velocity[o + 1] < 0) velocity[o + 1] = -velocity[o + 1] * restitution;
        const keep = 1 - (drag > 1 ? 1 : drag < 0 ? 0 : drag);
        velocity[o] *= keep;
        velocity[o + 2] *= keep;
      }
    };
  },

  /**
   * Advance the flipbook frame over the particle's life.
   *
   * Frames are a FLOAT, and the shader floors it. Keeping the fraction lets an
   * author drive the frame from a curve without the value snapping, and costs
   * nothing - the alternative is rounding here and losing the ability to ease
   * through a sheet.
   *
   * `mode: 'life'` plays the whole sheet exactly once over the lifetime, which
   * is what an explosion or a puff sheet is authored for. `'rate'` plays at a
   * fixed frames-per-second and wraps, for a looping animation like a torch.
   */
  'flipbook.advance': (block, env) => {
    const frames = prepareBinding(block.bindings.find((b) => b.prop === 'frames'), env);
    const rate = prepareBinding(block.bindings.find((b) => b.prop === 'rate'), env);
    const overLife = block.modes?.timing !== 'rate';
    return function flipbookAdvance(pool, i0, i1, dt) {
      const tile = pool.planes.flipbookFrame;
      if (!tile) return;
      const age = pool.planes.age;
      const lifetime = pool.planes.lifetime;
      for (let i = i0; i < i1; i += 1) {
        const count = frames.kind === B_CONST ? frames.fixed[0] : readChannel(frames, pool, i, env, 0);
        if (!(count > 0)) continue;
        if (overLife) {
          const life = lifetime[i];
          const t = life > 1e-6 ? age[i] / life : 0;
          // Clamped just below the last frame rather than at it: a t of exactly
          // 1 would land on frame `count`, which wraps to frame 0 in the shader
          // and makes every sheet flash back to its first frame as it dies.
          tile[i] = Math.min(count - 1e-4, t * count);
        } else {
          const fps = rate.kind === B_CONST ? rate.fixed[0] : readChannel(rate, pool, i, env, 0);
          tile[i] = (tile[i] + fps * dt) % count;
        }
      }
    };
  },

  /**
   * Bounce off a sphere - an obstacle, or a container.
   *
   * `side: 'outside'` keeps particles out of the sphere (a rock, a shield);
   * `'inside'` keeps them in (a snow globe, a contained explosion). One kernel
   * for both, because the maths is the same comparison with the sense flipped,
   * and two kernels would be two places to get the position correction wrong.
   *
   * As collide.plane, this runs AFTER integration and corrects the POSITION as
   * well as the velocity. Reflecting the velocity alone leaves the particle
   * inside the surface for a frame, and with a low bounce it never gets out.
   */
  'collide.sphere': (block, env) => {
    const centre = prepareBinding(block.bindings.find((b) => b.prop === 'position'), env);
    const radius = prepareBinding(block.bindings.find((b) => b.prop === 'radius'), env);
    const bounce = prepareBinding(block.bindings.find((b) => b.prop === 'bounce'), env);
    const friction = prepareBinding(block.bindings.find((b) => b.prop === 'friction'), env);
    const inside = block.modes?.side === 'inside';
    const channel = Number.isInteger(block.collideChannel) ? block.collideChannel : -1;
    return function collideSphere(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const cx = centre.kind === B_CONST ? centre.fixed[0] : readChannel(centre, pool, i, env, 0);
        const cy = centre.kind === B_CONST ? centre.fixed[1] : readChannel(centre, pool, i, env, 1);
        const cz = centre.kind === B_CONST ? centre.fixed[2] : readChannel(centre, pool, i, env, 2);
        const r = radius.kind === B_CONST ? radius.fixed[0] : readChannel(radius, pool, i, env, 0);
        if (!(r > 0)) continue;

        const dx = position[o] - cx;
        const dy = position[o + 1] - cy;
        const dz = position[o + 2] - cz;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // A particle exactly at the centre has no normal to reflect about, and
        // normalising a zero vector gives NaN - which would spread to the
        // position and take the particle out of the world entirely.
        if (distance < 1e-6) continue;
        const penetrating = inside ? distance > r : distance < r;
        if (!penetrating) continue;

        if (channel >= 0) pushEvent(env.events, channel, pool, i);
        const restitution = bounce.kind === B_CONST ? bounce.fixed[0] : readChannel(bounce, pool, i, env, 0);
        const drag = friction.kind === B_CONST ? friction.fixed[0] : readChannel(friction, pool, i, env, 0);
        // The outward normal of the surface the particle hit. For a container
        // it points inward, which is the only difference between the two modes.
        const sign = inside ? -1 : 1;
        const nx = (dx / distance) * sign;
        const ny = (dy / distance) * sign;
        const nz = (dz / distance) * sign;

        // Pushed back to the surface, then out by the depth it went in times
        // the bounce - the same reflection collide.plane does, which is what
        // keeps a bouncing arc smooth rather than clipping to the surface.
        const depth = (inside ? distance - r : r - distance);
        const push = depth * (1 + restitution);
        position[o] += nx * push;
        position[o + 1] += ny * push;
        position[o + 2] += nz * push;

        const into = velocity[o] * nx + velocity[o + 1] * ny + velocity[o + 2] * nz;
        if (into < 0) {
          // Split into normal and tangential parts: the normal part bounces,
          // the tangential part is what friction slows. Scaling the whole
          // velocity instead would make a grazing hit lose as much speed as a
          // head-on one.
          const keep = 1 - (drag > 1 ? 1 : drag < 0 ? 0 : drag);
          const tx = velocity[o] - nx * into;
          const ty = velocity[o + 1] - ny * into;
          const tz = velocity[o + 2] - nz * into;
          velocity[o] = tx * keep - nx * into * restitution;
          velocity[o + 1] = ty * keep - ny * into * restitution;
          velocity[o + 2] = tz * keep - nz * into * restitution;
        }
      }
    };
  },

  /**
   * Bounce off an axis-aligned box, from the outside or the inside.
   *
   * The contact normal is the axis of LEAST penetration, which is what makes a
   * particle arriving near an edge leave along the face it actually crossed
   * rather than along whichever axis the code happened to test first.
   */
  'collide.box': (block, env) => {
    const centre = prepareBinding(block.bindings.find((b) => b.prop === 'position'), env);
    const size = prepareBinding(block.bindings.find((b) => b.prop === 'size'), env);
    const bounce = prepareBinding(block.bindings.find((b) => b.prop === 'bounce'), env);
    const friction = prepareBinding(block.bindings.find((b) => b.prop === 'friction'), env);
    const inside = block.modes?.side === 'inside';
    const channel = Number.isInteger(block.collideChannel) ? block.collideChannel : -1;
    return function collideBox(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const cx = centre.kind === B_CONST ? centre.fixed[0] : readChannel(centre, pool, i, env, 0);
        const cy = centre.kind === B_CONST ? centre.fixed[1] : readChannel(centre, pool, i, env, 1);
        const cz = centre.kind === B_CONST ? centre.fixed[2] : readChannel(centre, pool, i, env, 2);
        const hx = (size.kind === B_CONST ? size.fixed[0] : readChannel(size, pool, i, env, 0)) * 0.5;
        const hy = (size.kind === B_CONST ? size.fixed[1] : readChannel(size, pool, i, env, 1)) * 0.5;
        const hz = (size.kind === B_CONST ? size.fixed[2] : readChannel(size, pool, i, env, 2)) * 0.5;
        if (!(hx > 0 && hy > 0 && hz > 0)) continue;

        const dx = position[o] - cx;
        const dy = position[o + 1] - cy;
        const dz = position[o + 2] - cz;
        const withinX = Math.abs(dx) < hx;
        const withinY = Math.abs(dy) < hy;
        const withinZ = Math.abs(dz) < hz;
        const within = withinX && withinY && withinZ;
        if (inside ? within : !within) continue;

        if (channel >= 0) pushEvent(env.events, channel, pool, i);
        const restitution = bounce.kind === B_CONST ? bounce.fixed[0] : readChannel(bounce, pool, i, env, 0);
        const drag = friction.kind === B_CONST ? friction.fixed[0] : readChannel(friction, pool, i, env, 0);

        let axis = 0;
        let depth = 0;
        let normal = 1;
        if (inside) {
          // Inside a container: the nearest face is the one it is about to pass
          // through, so the smallest remaining gap wins.
          const gapX = hx - Math.abs(dx);
          const gapY = hy - Math.abs(dy);
          const gapZ = hz - Math.abs(dz);
          if (gapX <= gapY && gapX <= gapZ) { axis = 0; depth = -gapX; normal = dx < 0 ? 1 : -1; }
          else if (gapY <= gapZ) { axis = 1; depth = -gapY; normal = dy < 0 ? 1 : -1; }
          else { axis = 2; depth = -gapZ; normal = dz < 0 ? 1 : -1; }
        } else {
          // Outside an obstacle: the axis it has penetrated LEAST is the face
          // it came in through.
          const overX = hx - Math.abs(dx);
          const overY = hy - Math.abs(dy);
          const overZ = hz - Math.abs(dz);
          if (overX <= overY && overX <= overZ) { axis = 0; depth = overX; normal = dx < 0 ? -1 : 1; }
          else if (overY <= overZ) { axis = 1; depth = overY; normal = dy < 0 ? -1 : 1; }
          else { axis = 2; depth = overZ; normal = dz < 0 ? -1 : 1; }
        }

        const push = Math.abs(depth) * (1 + restitution) * normal;
        position[o + axis] += push;

        const into = velocity[o + axis] * normal;
        if (into < 0) {
          const keep = 1 - (drag > 1 ? 1 : drag < 0 ? 0 : drag);
          velocity[o + axis] = -velocity[o + axis] * restitution;
          // Friction on the two axes that are not the contact normal.
          for (let c = 0; c < 3; c += 1) {
            if (c !== axis) velocity[o + c] *= keep;
          }
        }
      }
    };
  },

  /**
   * Kill particles that leave a box around the origin.
   *
   * Written as an age assignment rather than as a direct kill, so the one place
   * that compacts the pool stays age.advance. Two kernels removing particles
   * would each have to agree about how swap-remove interacts with the loop
   * bounds they were handed, and they would not.
   */
  'kill.bounds': (block, env) => {
    const size = prepareBinding(block.bindings.find((b) => b.prop === 'size'), env);
    return function killBounds(pool, i0, i1) {
      const position = pool.planes.position;
      const age = pool.planes.age;
      const lifetime = pool.planes.lifetime;
      const fixed = size.kind === B_CONST;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const hx = (fixed ? size.fixed[0] : readChannel(size, pool, i, env, 0)) * 0.5;
        const hy = (fixed ? size.fixed[1] : readChannel(size, pool, i, env, 1)) * 0.5;
        const hz = (fixed ? size.fixed[2] : readChannel(size, pool, i, env, 2)) * 0.5;
        const x = position[o];
        const y = position[o + 1];
        const z = position[o + 2];
        if (x < -hx || x > hx || y < -hy || y > hy || z < -hz || z > hz) {
          // Past its lifetime, so the next age.advance sweep collects it.
          age[i] = lifetime[i] + 1;
        }
      }
    };
  },

  /**
   * Scale the velocity a sub-emitter's particle was born with.
   *
   * The event spawn has already written the parent's velocity into the pool, so
   * this only has to scale it - which is why it is one multiply rather than a
   * read of the event payload. That also means it does nothing at all in a
   * system that is not a sub-emitter, which is honest: the block's teach line
   * says as much.
   */
  'vel.inherit': (block, env) => {
    const scale = prepareBinding(block.bindings.find((b) => b.prop === 'scale'), env);
    return function velInherit(pool, i0, i1) {
      const velocity = pool.planes.velocity;
      const fixed = scale.kind === B_CONST ? scale.fixed[0] : null;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const k = fixed !== null ? fixed : readChannel(scale, pool, i, env, 0);
        velocity[o] *= k;
        velocity[o + 1] *= k;
        velocity[o + 2] *= k;
      }
    };
  },

  /** Set velocity from a random box. */
  'vel.random': (block, env) => {
    const min = prepareBinding(block.bindings.find((b) => b.prop === 'min'), env);
    const max = prepareBinding(block.bindings.find((b) => b.prop === 'max'), env);
    const slot = 0x7c1e3d95;
    return function velRandom(pool, i0, i1) {
      const velocity = pool.planes.velocity;
      const seeds = pool.planes.seed;
      const fixedMin = min.kind === B_CONST;
      const fixedMax = max.kind === B_CONST;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        const o = i * 3;
        for (let c = 0; c < 3; c += 1) {
          const lo = fixedMin ? min.fixed[c] : readChannel(min, pool, i, env, c);
          const hi = fixedMax ? max.fixed[c] : readChannel(max, pool, i, env, c);
          velocity[o + c] = lo + (hi - lo) * pcgFloatAt(seed, slot + c);
        }
      }
    };
  },

  /** Accumulate a constant acceleration. The cheapest kernel there is. */
  'force.add': (block, env) => {
    const prep = prepareBinding(block.bindings.find((b) => b.prop === 'gravity'), env);
    return function forceAdd(pool, i0, i1) {
      const accel = pool.accel;
      if (prep.kind === B_CONST) {
        const gx = prep.fixed[0];
        const gy = prep.fixed[1];
        const gz = prep.fixed[2];
        // No indirection at all in this loop: three adds against three locals.
        // This is what the const fast path buys, and gravity is on almost every
        // effect ever authored.
        for (let i = i0; i < i1; i += 1) {
          const o = i * 3;
          accel[o] += gx;
          accel[o + 1] += gy;
          accel[o + 2] += gz;
        }
        return;
      }
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        accel[o] += readChannel(prep, pool, i, env, 0);
        accel[o + 1] += readChannel(prep, pool, i, env, 1);
        accel[o + 2] += readChannel(prep, pool, i, env, 2);
      }
    };
  },

  /** Linear drag: an acceleration opposing velocity. */
  'force.drag': (block, env) => {
    const prep = prepareBinding(block.bindings.find((b) => b.prop === 'drag'), env);
    return function forceDrag(pool, i0, i1) {
      const accel = pool.accel;
      const velocity = pool.planes.velocity;
      if (prep.kind === B_CONST) {
        const k = prep.fixed[0];
        for (let i = i0; i < i1; i += 1) {
          const o = i * 3;
          accel[o] -= velocity[o] * k;
          accel[o + 1] -= velocity[o + 1] * k;
          accel[o + 2] -= velocity[o + 2] * k;
        }
        return;
      }
      for (let i = i0; i < i1; i += 1) {
        const k = readChannel(prep, pool, i, env, 0);
        const o = i * 3;
        accel[o] -= velocity[o] * k;
        accel[o + 1] -= velocity[o + 1] * k;
        accel[o + 2] -= velocity[o + 2] * k;
      }
    };
  },

  /**
   * Curl-noise turbulence. The most expensive kernel in the catalog: three
   * gradient-noise evaluations with derivatives, per particle, per step.
   */
  'force.curlNoise': (block, env) => {
    const strength = prepareBinding(block.bindings.find((b) => b.prop === 'strength'), env);
    const frequency = prepareBinding(block.bindings.find((b) => b.prop === 'frequency'), env);
    return function forceCurlNoise(pool, i0, i1) {
      const accel = pool.accel;
      const position = pool.planes.position;
      const constStrength = strength.kind === B_CONST;
      const constFreq = frequency.kind === B_CONST;
      const s0 = constStrength ? strength.fixed[0] : 0;
      const f0 = constFreq ? frequency.fixed[0] : 0;
      for (let i = i0; i < i1; i += 1) {
        const o = i * 3;
        const f = constFreq ? f0 : readChannel(frequency, pool, i, env, 0);
        const s = constStrength ? s0 : readChannel(strength, pool, i, env, 0);
        curl3(position[o] * f, position[o + 1] * f, position[o + 2] * f, _v3);
        accel[o] += _v3[0] * s;
        accel[o + 1] += _v3[1] * s;
        accel[o + 2] += _v3[2] * s;
      }
    };
  },

  /**
   * Scale a birth value by a curve over life.
   *
   * MULTIPLIES the snapshotted birth value rather than the live attribute -
   * applying the curve to the live value would compound it every frame, so a
   * scale of 1.1 would grow a particle by 1.1x per frame instead of once.
   */
  'attr.overLife': (block, env) => {
    const prep = prepareBinding(block.bindings[0], env);
    const target = block.attributes[0];
    const startName = `start${target.charAt(0).toUpperCase()}${target.slice(1)}`;
    return function attrOverLife(pool, i0, i1) {
      const plane = pool.planes[target];
      const start = pool.planes[startName];
      if (!plane || !start) return;
      const table = prep.table;
      const age = pool.planes.age;
      const lifetime = pool.planes.lifetime;
      if (prep.kind === B_CURVE && !prep.randomScale) {
        const data = table.data;
        const n = table.n;
        const scale = prep.scale;
        for (let i = i0; i < i1; i += 1) {
          const life = lifetime[i];
          const t = life > 0 ? age[i] / life : 0;
          plane[i] = start[i] * sampleTable(data, n, t) * scale;
        }
        return;
      }
      for (let i = i0; i < i1; i += 1) {
        plane[i] = start[i] * readChannel(prep, pool, i, env, 0);
      }
    };
  },

  /** Scale the birth colour by a gradient over life. */
  'color.overLife': (block, env) => {
    const prep = prepareBinding(block.bindings[0], env);
    return function colorOverLife(pool, i0, i1) {
      const color = pool.planes.color;
      const start = pool.planes.startColor;
      if (!color || !start) return;
      const age = pool.planes.age;
      const lifetime = pool.planes.lifetime;
      if (prep.kind === B_GRADIENT) {
        const data = prep.table.data;
        const n = prep.table.n;
        for (let i = i0; i < i1; i += 1) {
          const life = lifetime[i];
          const t = life > 0 ? age[i] / life : 0;
          sampleTableRgba(data, n, t, _v4);
          const o = i * 4;
          color[o] = start[o] * _v4[0];
          color[o + 1] = start[o + 1] * _v4[1];
          color[o + 2] = start[o + 2] * _v4[2];
          color[o + 3] = start[o + 3] * _v4[3];
        }
        return;
      }
      // A constant colour in this slot is legal and means a flat tint.
      readFixed(prep, env, _v4);
      for (let i = i0; i < i1; i += 1) {
        const o = i * 4;
        color[o] = start[o] * _v4[0];
        color[o + 1] = start[o + 1] * _v4[1];
        color[o + 2] = start[o + 2] * _v4[2];
        color[o + 3] = start[o + 3] * _v4[3];
      }
    };
  },

  /**
   * Semi-implicit Euler: velocity first, then position from the NEW velocity.
   *
   * Stabler than explicit Euler under strong drag, which matters because drag
   * is on most effects and an explicit step can overshoot into oscillation when
   * drag times dt approaches 1. Costs nothing extra - it is the same two lines
   * in the other order.
   */
  'integrate.semiImplicit': () => function integrateSemiImplicit(pool, i0, i1, dt) {
    const position = pool.planes.position;
    const velocity = pool.planes.velocity;
    const accel = pool.accel;
    for (let i = i0; i < i1; i += 1) {
      const o = i * 3;
      const vx = velocity[o] + accel[o] * dt;
      const vy = velocity[o + 1] + accel[o + 1] * dt;
      const vz = velocity[o + 2] + accel[o + 2] * dt;
      velocity[o] = vx;
      velocity[o + 1] = vy;
      velocity[o + 2] = vz;
      position[o] += vx * dt;
      position[o + 1] += vy * dt;
      position[o + 2] += vz * dt;
    }
  },

  /** Explicit Euler: position from the OLD velocity. */
  'integrate.euler': () => function integrateEuler(pool, i0, i1, dt) {
    const position = pool.planes.position;
    const velocity = pool.planes.velocity;
    const accel = pool.accel;
    for (let i = i0; i < i1; i += 1) {
      const o = i * 3;
      position[o] += velocity[o] * dt;
      position[o + 1] += velocity[o + 1] * dt;
      position[o + 2] += velocity[o + 2] * dt;
      velocity[o] += accel[o] * dt;
      velocity[o + 1] += accel[o + 1] * dt;
      velocity[o + 2] += accel[o + 2] * dt;
    }
  },

  // Render state, not simulation. Returning null keeps it out of the chain
  // entirely rather than paying for a no-op pass over the pool.
  // Output blocks are render STATE, not passes. They are listed here so the
  // catalog-coverage check can see that every block names a kernel somebody
  // wrote, and they return null so buildKernel leaves them out of the chain -
  // the compiler reads their bindings directly when it builds the batch key
  // and the material.
  'output.texture': () => null,
  'output.flipbook': () => null,
  'output.mesh': () => null,

  // Handled by the emitter, which needs the spawn bindings in a different shape
  // than a per-particle pass.
  'spawn.rate': () => null,
  'spawn.burst': () => null,
};

// A local copy of pool.js's swapRemove, inlined into this module so the
// death sweep does not pay a cross-module call per death. Kept byte-identical
// in behaviour; pool.js remains the documented definition.
function swapRemoveInline(pool, i) {
  const last = pool.count - 1;
  pool.count = last;
  if (i === last) return;
  const list = pool.planeList;
  for (let p = 0; p < list.length; p += 2) {
    const plane = list[p];
    const width = list[p + 1];
    const to = i * width;
    const from = last * width;
    for (let c = 0; c < width; c += 1) plane[to + c] = plane[from + c];
  }
  const accel = pool.accel;
  accel[i * 3] = accel[last * 3];
  accel[i * 3 + 1] = accel[last * 3 + 1];
  accel[i * 3 + 2] = accel[last * 3 + 2];
}

/**
 * Build the runnable closure for one IR block.
 *
 * @param {Object} irBlock
 * @param {Object} env
 * @returns {{name: string, fn: Function}|null} null when the block does no
 *   simulation work
 */
// ---------------------------------------------------------------------------
// Operator ops
// ---------------------------------------------------------------------------
//
// THIS IS WHAT MAKES A WIRED OPERATOR ACTUALLY DO SOMETHING. The compiler
// lowers an operator subtree into a list of register ops on the block that
// consumes it (`irBlock.pre`), and a binding then reads `src: 'register'`. Up
// to this point nothing executed that list, so `env.regs` stayed all zeros and
// wiring a Value node of 5 into Set Size silently produced a size of ZERO -
// the node was on the board, the wire was drawn, the compile was clean, and the
// property read nothing. That is the worst possible failure mode: every visible
// signal said it was working.
//
// THE OPS RUN PER KERNEL INVOCATION, not once at build. A `time` op changes
// every frame and an exposed property can change between frames, so hoisting
// them to factory time would freeze them at their first value. They are a
// handful of scalar operations against a Float64Array, evaluated once per block
// per pass - nothing next to a loop over tens of thousands of particles.
//
// ORDER IS THE COMPILER'S JOB. `pre` arrives in topological order (phase 3 of
// compileVfxGraph), so an op can read a register an earlier op in the same list
// wrote, and this evaluator never has to reason about dependencies.
//
// PER-PARTICLE OPERATORS ARE NOT SUPPORTED HERE, and are reported rather than
// approximated. `op.getAttribute` produces a different value for every particle,
// but a register is read once per pass - the kernel signature has no place to
// put a per-particle register file. Wiring one is a `W_PER_PARTICLE_OP`
// diagnostic at compile time; the runtime evaluates it as the attribute's
// average-case default so the effect still plays, and the author is told the
// value is not varying.

const OP_EVALUATORS = {
  /** A literal, or a pass-through of an upstream register. */
  const: (op, env) => readOpInput(op.in[0], env),
  add: (op, env) => readOpInput(op.in[0], env) + readOpInput(op.in[1], env),
  sub: (op, env) => readOpInput(op.in[0], env) - readOpInput(op.in[1], env),
  mul: (op, env) => readOpInput(op.in[0], env) * readOpInput(op.in[1], env),
  div: (op, env) => {
    const b = readOpInput(op.in[1], env);
    // Zero rather than Infinity: an Infinity here would propagate into a
    // particle position and put the whole system at NaN two frames later,
    // which is far harder to diagnose than a property that reads zero.
    return Math.abs(b) < 1e-9 ? 0 : readOpInput(op.in[0], env) / b;
  },
  lerp: (op, env) => {
    const a = readOpInput(op.in[0], env);
    const b = readOpInput(op.in[1], env);
    const t = readOpInput(op.in[2], env);
    return a + (b - a) * t;
  },
  clamp: (op, env) => {
    const lo = readOpInput(op.in[1], env);
    const hi = readOpInput(op.in[2], env);
    const x = readOpInput(op.in[0], env);
    return x < lo ? lo : x > hi ? hi : x;
  },
  remap: (op, env) => {
    const x = readOpInput(op.in[0], env);
    const inLo = readOpInput(op.in[1], env);
    const inHi = readOpInput(op.in[2], env);
    const outLo = readOpInput(op.in[3], env);
    const outHi = readOpInput(op.in[4], env);
    const span = inHi - inLo;
    // A collapsed input range maps everything to the low end rather than
    // dividing by zero.
    if (Math.abs(span) < 1e-9) return outLo;
    const t = (x - inLo) / span;
    return outLo + (outHi - outLo) * (t < 0 ? 0 : t > 1 ? 1 : t);
  },
  sin: (op, env) => Math.sin(readOpInput(op.in[0], env) * TAU),
  /** Seconds since the effect started. Changes every frame - see the header. */
  time: (_op, env) => env.time,
  /**
   * A new number every frame, shared by every particle that frame. Drawn from
   * the frame seed rather than from Math.random, so a replay of the same seed
   * produces the same effect - the whole point of vfx/random.js.
   */
  random: (op, env) => {
    const lo = readOpInput(op.in[0], env);
    const hi = readOpInput(op.in[1], env);
    return lo + (hi - lo) * pcgFloatAt(env.frameSeed, (op.out + 1) * 0x9e3779b9);
  },
  /**
   * A particle attribute.
   *
   * env.particle is the pool and index the chain is being evaluated for, set by
   * runOpsForParticle. It is absent when a per-particle chain somehow reaches
   * the once-per-pass path - a compiler bug rather than an authoring one - and
   * the fallback is mid-range so the effect stays visible while being wrong,
   * rather than collapsing to zero and looking deleted.
   */
  attr: (op, env) => {
    const which = op.modes?.attribute || 'normalizedAge';
    const particle = env.particle;
    if (!particle) return which === 'age' ? env.time : which === 'normalizedAge' ? 0.5 : 1;
    const { pool, index } = particle;
    const planes = pool.planes;
    switch (which) {
      case 'age':
        return planes.age ? planes.age[index] : 0;
      case 'lifetime':
        return planes.lifetime ? planes.lifetime[index] : 1;
      case 'size':
        return planes.size ? planes.size[index] : 1;
      case 'speed': {
        if (!planes.velocity) return 0;
        const o = index * 3;
        return Math.hypot(planes.velocity[o], planes.velocity[o + 1], planes.velocity[o + 2]);
      }
      case 'normalizedAge':
      default: {
        if (!planes.age || !planes.lifetime) return 0;
        const life = planes.lifetime[index];
        return life > 1e-6 ? planes.age[index] / life : 0;
      }
    }
  },
};

// One input of an op: either a literal from the constant pool or an upstream
// register this list already wrote.
function readOpInput(input, env) {
  if (!input) return 0;
  return input.kind === 'register' ? env.regs[input.index] : env.consts[input.index];
}

/**
 * Run a block's operator ops, writing their results into env.regs.
 *
 * Evaluates the WHOLE list, including per-particle ops - which then read
 * whatever env.particle happens to be. That is correct for the once-per-pass
 * call because a per-particle op's own consumer is read inside the loop and
 * re-evaluates the chain there; this pass just needs the non-particle registers
 * to hold their values.
 *
 * @param {Array<Object>} ops from irBlock.pre, in topological order
 * @param {Object} env the runtime environment
 */
export function runOps(ops, env) {
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    const evaluate = OP_EVALUATORS[op.op];
    // An unknown op name is a compiler/runtime mismatch. Zero rather than a
    // throw: this runs inside the frame loop, and taking the page down over one
    // unrecognised operator is worse than one property reading zero while the
    // diagnostics strip reports it.
    env.regs[op.out] = evaluate ? evaluate(op, env) : 0;
  }
}

/**
 * Re-run only the per-particle ops of a chain, for one particle.
 *
 * THIS IS WHAT MAKES `size = normalizedAge * 2` WORK. A register is otherwise
 * read once per pass, so a chain containing a particle attribute would give
 * every particle the same number - which was a warning
 * (`W_PER_PARTICLE_OP`) rather than a behaviour until this existed.
 *
 * Only the ops MARKED per-particle are re-run: the compiler propagates that
 * flag down a chain, so `2 * exposedScale` in the middle of an otherwise
 * per-particle expression is still evaluated once per frame by runOps and left
 * alone here. At sixty thousand particles the difference between re-running two
 * ops and re-running six is the whole reason the flag is per-op rather than
 * per-chain.
 *
 * @param {Array<Object>} ops from irBlock.pre
 * @param {Object} env
 * @param {Object} pool
 * @param {number} index
 */
export function runOpsForParticle(ops, env, pool, index) {
  // Written onto env rather than threaded through every evaluator's signature:
  // twelve evaluators would each grow two parameters they mostly ignore, and
  // the object is reused rather than allocated per particle.
  const scratch = env.particle || (env.particle = { pool: null, index: 0 });
  scratch.pool = pool;
  scratch.index = index;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (!op.perParticle) continue;
    const evaluate = OP_EVALUATORS[op.op];
    env.regs[op.out] = evaluate ? evaluate(op, env) : 0;
  }
}

/** Every op name the runtime can evaluate. The test compares it to the compiler's table. */
export function implementedOps() {
  return Object.keys(OP_EVALUATORS);
}

export function buildKernel(irBlock, env) {
  const builder = KERNELS[irBlock.kernel];
  if (!builder) {
    // An unimplemented kernel name is a compiler/runtime mismatch, and it is
    // exactly the gap compile.test.mjs's KNOWN GAP note calls out. Reported by
    // name so it is obvious which side is behind, rather than silently
    // producing an effect that is missing a behaviour.
    throw new Error(`VFX runtime: no kernel implements "${irBlock.kernel}"`);
  }
  const fn = builder(irBlock, env);
  if (!fn) return null;

  // Blocks with no wired properties - the overwhelming majority - get the bare
  // kernel, so the common path pays nothing for a feature it does not use.
  const ops = irBlock.pre;
  if (!ops || ops.length === 0) {
    return { name: fn.name || irBlock.kernel, kernel: irBlock.kernel, fn };
  }

  // Wrapped rather than folded into each kernel: forty kernels would otherwise
  // each need to remember to evaluate their own operator inputs, and the one
  // that forgot would read a stale register.
  const wrapped = function withOperators(pool, i0, i1, dt) {
    runOps(ops, env);
    fn(pool, i0, i1, dt);
  };
  // The kernel's own name is kept for the profiler, or every wired block would
  // show up in the flame chart as "withOperators".
  Object.defineProperty(wrapped, 'name', { value: fn.name || irBlock.kernel });
  return { name: fn.name || irBlock.kernel, kernel: irBlock.kernel, fn: wrapped };
}

/**
 * Every kernel name the runtime implements. The test compares this against
 * the catalog, so a block whose kernel nobody wrote fails at build rather than
 * at play.
 *
 * @returns {string[]}
 */
export function implementedKernels() {
  return Object.keys(KERNELS);
}

/**
 * The seed a particle is born with: a hash of the effect seed and the
 * particle's own spawn index, never a walk along a shared stream.
 *
 * @param {number} effectSeed
 * @param {number} systemSeedOffset
 * @param {number} spawnIndex
 * @returns {number} uint32
 */
export function particleSeed(effectSeed, systemSeedOffset, spawnIndex) {
  return pcgHash2((effectSeed ^ systemSeedOffset) >>> 0, spawnIndex >>> 0);
}
