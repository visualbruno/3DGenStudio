// One compiled emitter: a pool, the two kernel chains, and the spawn logic
// that decides how many particles are born on a given step.
//
// CLIP SEMANTICS, which are the part worth reading before changing anything.
//
// A timeline clip is {at, duration, loop}. There is exactly one rule for
// duration, and it applies to both kinds of spawn block:
//
//     duration === 0  means the window OPENS at `at` and never closes.
//
// From that one rule both behaviours fall out without a special case:
//
//   - a BURST block fires once, when a window opens. A burst clip is
//     zero-length, so it opens at `at` and the burst fires there. Nothing about
//     "instantaneous" needs encoding separately.
//   - a RATE block emits continuously while any window is open. A rate with a
//     zero-length clip therefore runs for the whole effect, which is what the
//     default clip on a newly added system means, and a rate with a 0.4s clip
//     runs for 0.4s.
//
// The alternative - making duration 0 mean "instant" for bursts and "forever"
// for rates - is the same behaviour with two meanings for one field, and it
// would have to be explained at every call site instead of once here.
//
// `loop` on a clip repeats it with a period equal to its own duration. Windows
// that abut therefore make emission continuous, which is correct: there is no
// gap to leave. `loop` on a zero-length clip is a no-op within one play, since
// the window never closes - repetition of a burst across plays is the EFFECT's
// loop flag, not the clip's.
//
// Clip times arrive already snapped to whole simulation steps by the compiler,
// so a clip at 0.02s fires on the same step on every replay and every scrub,
// whatever floating point does to the frame accumulator.

import { buildKernel, particleSeed, runOps } from './kernels.js';
import { claimSlots, createPool, resetPool } from './pool.js';
import { pcgFloatAt } from '../../../vfx/random.js';
import { eventCount, readEvent } from './events.js';
import { BINDING_SRC } from '../../../vfx/ir.js';

// A scalar read with no particle in scope. Spawn properties live here: the
// compiler has already rejected anything per-particle feeding a spawn stage
// (E_FREQ_MISMATCH), so only the frequencies below can reach this.
function readSpawnScalar(binding, env) {
  if (!binding) return 0;
  switch (binding.src) {
    case BINDING_SRC.CONST:
      return env.consts[binding.index];
    case BINDING_SRC.UNIFORM:
      return env.uniforms[binding.index];
    case BINDING_SRC.REGISTER:
      // No broadcast here: every spawn property is a scalar, so a source width
      // narrower than the property cannot arise.
      return env.regs[binding.index];
    case BINDING_SRC.RANDOM: {
      const lo = env.consts[binding.loIndex];
      const hi = env.consts[binding.hiIndex];
      const seed = binding.freq === 'perSpawnEvent' ? env.spawnEventSeed : env.frameSeed;
      return lo + (hi - lo) * pcgFloatAt(seed, binding.slot >>> 0);
    }
    case BINDING_SRC.CURVE: {
      const table = env.tables[binding.index];
      const t = env.duration > 0 ? Math.min(1, Math.max(0, env.time / env.duration)) : 0;
      const x = t * (table.n - 1);
      const i = x | 0;
      const f = x - i;
      const a = table.data[i];
      const b = table.data[Math.min(table.n - 1, i + 1)];
      return (a + (b - a) * f) * (Number.isFinite(binding.scale) ? binding.scale : 1);
    }
    default:
      return 0;
  }
}

// Is any spawn window open on this step?
function anyWindowOpen(clips, step) {
  for (const clip of clips) {
    if (step < clip.atStep) continue;
    if (clip.durationSteps <= 0) return true;
    if (clip.loop) return true;
    if (step - clip.atStep < clip.durationSteps) return true;
  }
  return false;
}

// Does a window OPEN on exactly this step? That is when bursts fire.
function windowOpensOn(clip, step) {
  if (step < clip.atStep) return false;
  const since = step - clip.atStep;
  if (since === 0) return true;
  if (clip.loop && clip.durationSteps > 0 && since % clip.durationSteps === 0) return true;
  return false;
}

/**
 * Build a runnable emitter for one IR system.
 *
 * @param {Object} irSystem
 * @param {Object} ir
 * @param {Object} env shared runtime environment
 * @returns {Object}
 */
export function createEmitter(irSystem, ir, env) {
  const pool = createPool(irSystem, ir);

  const initChain = [];
  for (const block of irSystem.init) {
    const entry = buildKernel(block, env);
    if (entry) initChain.push(entry);
  }
  const updateChain = [];
  for (const block of irSystem.update) {
    const entry = buildKernel(block, env);
    if (entry) updateChain.push(entry);
  }

  // Spawn blocks are read directly rather than built as kernels: they produce
  // one number for the whole step, not a pass over the pool.
  const rateBlocks = irSystem.spawn.filter((b) => b.kernel === 'spawn.rate');
  const burstBlocks = irSystem.spawn.filter((b) => b.kernel === 'spawn.burst');

  return {
    id: irSystem.id,
    name: irSystem.name,
    irSystem,
    pool,
    initChain,
    updateChain,
    clips: irSystem.schedule.clips,
    rateBlocks,
    burstBlocks,
    // Present only on a sub-emitter: which channel it watches, and how often it
    // responds. Its presence is what makes spawnStep ignore the clips entirely.
    listen: irSystem.listen || null,
    seedOffset: irSystem.seedOffset,
    // Fractional carry for rate spawning. Deterministic because dt is fixed:
    // the same sequence of additions happens on every run, so the same steps
    // emit the same counts.
    debt: 0,
    muted: false,
  };
}

/**
 * Reset an emitter to its pre-play state.
 * @param {Object} emitter
 */
export function resetEmitter(emitter) {
  resetPool(emitter.pool);
  emitter.debt = 0;
}

/**
 * How many particles this emitter should spawn on the given step.
 *
 * @param {Object} emitter
 * @param {number} step
 * @param {number} dt
 * @param {Object} env
 * @returns {number}
 */
export function computeSpawnCount(emitter, step, dt, env) {
  if (emitter.muted) return 0;
  let count = 0;

  if (emitter.rateBlocks.length > 0 && anyWindowOpen(emitter.clips, step)) {
    let perSecond = 0;
    for (const block of emitter.rateBlocks) {
      // The spawn path does NOT go through buildKernel, so it has to run its
      // own operator ops. Forgetting this was the second half of the same bug:
      // wiring an operator into a spawn rate read register zero and the emitter
      // silently stopped emitting - no error, no diagnostic, no particles.
      if (block.pre && block.pre.length > 0) runOps(block.pre, env);
      perSecond += readSpawnScalar(block.bindings.find((b) => b.prop === 'rate'), env);
    }
    emitter.debt += perSecond * dt;
    // Whole particles only; the remainder carries. Rounding instead would
    // make a rate of 0.5/s emit one particle every step at 60fps.
    const whole = Math.floor(emitter.debt);
    if (whole > 0) {
      emitter.debt -= whole;
      count += whole;
    }
  }

  if (emitter.burstBlocks.length > 0) {
    for (const clip of emitter.clips) {
      if (!windowOpensOn(clip, step)) continue;
      for (const block of emitter.burstBlocks) {
        // As the rate path above: burst blocks are not built through
        // buildKernel either, so a wired count would read register zero.
        if (block.pre && block.pre.length > 0) runOps(block.pre, env);
        count += Math.round(readSpawnScalar(block.bindings.find((b) => b.prop === 'count'), env));
      }
    }
  }

  return count;
}

/**
 * Spawn from the events a sub-emitter is watching.
 *
 * ONE BURST PER EVENT. The child's own Spawn context supplies the count, so a
 * burst of 5 on a system watching deaths gives five children per death - which
 * reuses the ordinary burst machinery rather than inventing a second way to
 * express a count.
 *
 * The payload is written into the pool BEFORE the init chain runs, which means
 * an init block that sets position or velocity will overwrite it. That is the
 * same top-to-bottom rule every stack follows, and it is why the position
 * blocks are not what a sub-emitter usually wants - Inherit Velocity scales
 * what is already there instead.
 *
 * @param {Object} emitter
 * @param {Object} env
 * @returns {number} how many were born
 */
function spawnFromEvents(emitter, env) {
  const queue = env.events;
  if (!queue) return 0;
  const channel = emitter.listen.channel;
  const available = eventCount(queue, channel);
  if (available <= 0) return 0;

  // The count comes from the child's own burst blocks. A sub-emitter with no
  // burst block emits nothing, which the compiler reports as E_NO_SPAWN like
  // any other system.
  let perEvent = 0;
  for (const block of emitter.burstBlocks) {
    perEvent += Math.round(readSpawnScalar(block.bindings.find((b) => b.prop === 'count'), env));
  }
  if (perEvent <= 0) return 0;

  const probability = emitter.listen.probability;
  const pool = emitter.pool;
  let born = 0;

  for (let e = 0; e < available; e += 1) {
    readEvent(queue, channel, e, _payload);
    // Rolled per EVENT, not per child: "a quarter of the sparks make a puff"
    // is what an author means, not "each puff has a one-in-four chance of
    // existing", and the two give visibly different results at low counts.
    //
    // Drawn from the parent's own seed so the choice is reproducible - a
    // counter would make it depend on how many other events fired first.
    if (probability < 1) {
      const roll = pcgFloatAt(_payload[6] >>> 0, 0x1f83d9ab);
      if (roll > probability) continue;
    }

    const { i0, i1 } = claimSlots(pool, perEvent);
    if (i1 <= i0) break;
    for (let i = i0; i < i1; i += 1) {
      const index = pool.spawnCursor;
      pool.spawnCursor = index + 1;
      // Hashed from the PARENT'S seed as well as the child's spawn index, so
      // two children of the same parent differ, and a replay reproduces both.
      pool.planes.seed[i] = particleSeed(
        env.effectSeed ^ (_payload[6] >>> 0),
        emitter.seedOffset,
        index,
      );
      if (pool.planes.spawnIndex) pool.planes.spawnIndex[i] = index;
      const o = i * 3;
      pool.planes.position[o] = _payload[0];
      pool.planes.position[o + 1] = _payload[1];
      pool.planes.position[o + 2] = _payload[2];
      if (pool.planes.velocity) {
        pool.planes.velocity[o] = _payload[3];
        pool.planes.velocity[o + 1] = _payload[4];
        pool.planes.velocity[o + 2] = _payload[5];
      }
      born += 1;
    }
  }
  return born;
}

// Module-level scratch for one event payload, the house idiom. Only one
// sub-emitter drains at a time.
const _payload = new Float32Array(7);

/**
 * Spawn and initialise particles for this step.
 *
 * The seed is written BEFORE the init chain runs, because almost every init
 * kernel draws against it - the shape, the velocity, the random lifetime. It is
 * a hash of the effect seed and the particle's own spawn index, so a particle's
 * numbers do not depend on how many were alive when it was born or on how the
 * frame accumulator split the step.
 *
 * @param {Object} emitter
 * @param {number} step
 * @param {number} dt
 * @param {Object} env
 * @returns {number} how many were actually born
 */
export function spawnStep(emitter, step, dt, env) {
  // A SUB-EMITTER IGNORES ITS OWN CLIPS ENTIRELY. Its timing comes from the
  // events it is watching, and letting the clips fire as well would make it
  // emit twice - once where a parent particle died, and once at the origin on
  // its own schedule, which is exactly the "why is there a puff of smoke at the
  // world origin" bug.
  if (emitter.listen) return spawnFromEvents(emitter, env);

  const wanted = computeSpawnCount(emitter, step, dt, env);
  if (wanted <= 0) return 0;

  const pool = emitter.pool;
  const { i0, i1 } = claimSlots(pool, wanted);
  if (i1 <= i0) return 0;

  const seeds = pool.planes.seed;
  const spawnIndexPlane = pool.planes.spawnIndex;
  for (let i = i0; i < i1; i += 1) {
    const index = pool.spawnCursor;
    pool.spawnCursor = index + 1;
    seeds[i] = particleSeed(env.effectSeed, emitter.seedOffset, index);
    if (spawnIndexPlane) spawnIndexPlane[i] = index;
  }

  // Defaults every particle needs before Initialize runs. Lifetime especially:
  // a system whose author forgot Set Lifetime would otherwise have particles
  // with lifetime 0 and die on their first step, which looks like "nothing
  // spawns" rather than like the missing block that it is. The compiler raises
  // E_NO_LIFETIME for it; this makes the preview show something in the
  // meantime.
  const lifetime = pool.planes.lifetime;
  const size = pool.planes.size;
  const color = pool.planes.color;
  for (let i = i0; i < i1; i += 1) {
    lifetime[i] = 1;
    if (size) size[i] = 1;
    if (color) {
      const o = i * 4;
      color[o] = 1;
      color[o + 1] = 1;
      color[o + 2] = 1;
      color[o + 3] = 1;
    }
  }

  return i1 - i0;
}
