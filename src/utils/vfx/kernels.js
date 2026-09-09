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
  }
  return prep;
}

// True when a binding's value is the same for every particle in a pass, so the
// kernel can read it once before the loop.
function isFixed(prep) {
  return prep.kind === B_CONST || prep.kind === B_UNIFORM || prep.kind === B_REGISTER;
}

// The fixed value of such a binding, into out.
function readFixed(prep, env, out) {
  if (prep.kind === B_CONST) {
    for (let c = 0; c < prep.width; c += 1) out[c] = prep.fixed[c];
  } else if (prep.kind === B_UNIFORM) {
    for (let c = 0; c < prep.width; c += 1) out[c] = env.uniforms[prep.offset + c];
  } else {
    for (let c = 0; c < prep.width; c += 1) out[c] = env.regs[prep.offset + c];
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
  return env.regs[prep.offset + c];
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------
// Each builder returns a named closure, or null when the kernel has nothing to
// do in the simulation (an output's texture, for instance, is render state).

const KERNELS = {
  /**
   * Advance age, kill what has expired, and clear the force accumulator.
   *
   * Injected, always first. Two things happen here that everything downstream
   * relies on: nothing after this point can touch a dead particle, and the
   * accumulator starts every step at zero so forces add rather than compound.
   */
  'age.advance': () => function ageAdvance(pool, i0, i1, dt) {
    const age = pool.planes.age;
    const lifetime = pool.planes.lifetime;
    for (let i = i0; i < i1; i += 1) age[i] += dt;

    // Sweep for deaths. swapRemove moves the last live particle into i, so i
    // must be re-tested rather than advanced past - the incoming particle has
    // not been examined yet and may itself be dead.
    let i = i0;
    while (i < pool.count) {
      if (age[i] >= lifetime[i]) swapRemoveInline(pool, i);
      else i += 1;
    }

    pool.accel.fill(0, 0, pool.count * 3);
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
    const slot = 0x51ed270b;
    return function shapePositionSphere(pool, i0, i1) {
      const position = pool.planes.position;
      const seeds = pool.planes.seed;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
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
        const o = i * 3;
        position[o] = r * ring * Math.cos(theta);
        position[o + 1] = r * ring * Math.sin(theta);
        position[o + 2] = r * u;
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
    const slot = 0x2f9a1c07;
    return function shapeCone(pool, i0, i1) {
      const position = pool.planes.position;
      const velocity = pool.planes.velocity;
      const seeds = pool.planes.seed;
      for (let i = i0; i < i1; i += 1) {
        const seed = seeds[i];
        const halfAngle = (angle.kind === B_CONST ? angle.fixed[0] : readChannel(angle, pool, i, env, 0)) * DEG;
        const r0 = radius.kind === B_CONST ? radius.fixed[0] : readChannel(radius, pool, i, env, 0);
        const v0 = speed.kind === B_CONST ? speed.fixed[0] : readChannel(speed, pool, i, env, 0);

        const theta = pcgFloatAt(seed, slot) * TAU;
        // Square root, so the mouth fills evenly rather than crowding the axis.
        const rr = r0 * Math.sqrt(pcgFloatAt(seed, slot + 1));
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        const o = i * 3;
        position[o] = rr * cosT;
        position[o + 1] = 0;
        position[o + 2] = rr * sinT;

        // Direction: a polar angle drawn so the distribution is even across the
        // cone's solid angle, not even in the angle itself - the latter
        // concentrates particles down the axis and makes a wide cone look like
        // a narrow one with strays.
        const cosMax = Math.cos(halfAngle);
        const cosPhi = 1 - pcgFloatAt(seed, slot + 2) * (1 - cosMax);
        const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
        const dTheta = pcgFloatAt(seed, slot + 3) * TAU;
        velocity[o] = v0 * sinPhi * Math.cos(dTheta);
        velocity[o + 1] = v0 * cosPhi;
        velocity[o + 2] = v0 * sinPhi * Math.sin(dTheta);
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
  'output.texture': () => null,

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
  return fn ? { name: fn.name || irBlock.kernel, kernel: irBlock.kernel, fn } : null;
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
