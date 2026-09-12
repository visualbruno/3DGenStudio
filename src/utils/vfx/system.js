// The effect runtime: fixed-step stepping, the emitters, and seeking.
//
// No React, no three.js, no DOM. The rendering layer (phase 4) reads pools out
// of here and writes instanced buffers; nothing in this file knows that exists.
//
// THE FIXED TIMESTEP IS NOT AN OPTIMISATION, it is the thing three separate
// features rest on. The timeline scrubber, the thumbnail generator and
// "what I see is what the engine plays" all assume that the same seed replays
// the same effect - and a variable dt makes that false immediately, because the
// particle count and the accumulator's fractional carry both depend on how the
// frames happened to land. Unity lets an author choose fixed dt; Niagara
// defaults to variable but exposes a fixed mode, and the importer has to set
// that flag. It is a real export-fidelity item, not a detail.
//
// SEEKING IS RE-SIMULATION, and the UI must say so rather than implying random
// access. A stateful particle sim cannot be run backwards: to reach t you reset
// and step to t. Snapshots make that cheap for the common case - seek from the
// nearest one forward instead of from zero - but they are a cache, not a
// rewind, and their memory budget is finite. What makes them safe is that a
// snapshot restores EVERYTHING that determines the future: the pool bytes, the
// live count, the spawn cursor, and each emitter's fractional spawn carry. Miss
// any one of those and a seek diverges from a full re-simulation in a way that
// only shows up as an effect that looks subtly different after scrubbing.

import { computeSpawnCount, createEmitter, resetEmitter, spawnStep } from './emitter.js';
import { poolBytes } from './pool.js';
import { clearEvents, createEventQueue, resetEventQueue } from './events.js';
import { createStats } from './stats.js';
import { buildMeshSampler } from './meshSample.js';
import { pcgHash2 } from '../../../vfx/random.js';

// How much memory snapshots may use in total. Sized to be generous on a desktop
// and irrelevant on a laptop: a 60k-particle pool is about 4.5 MB, so this is a
// dozen or so snapshots for a heavy effect and hundreds for a light one.
const DEFAULT_SNAPSHOT_BUDGET = 64 * 1024 * 1024;

/**
 * Build the runtime for a compiled effect.
 *
 * @param {Object} ir the IR from compileVfxGraph
 * @param {{profile?: boolean, snapshotBudgetBytes?: number}} [options]
 * @returns {Object}
 */
export function createVfxRuntime(ir, options = {}) {
  // Tables converted from plain JSON arrays to Float32Array exactly once, here.
  // The IR is plain JSON by contract (guarantee 1 in vfx/ir.js) and this is the
  // one place that conversion belongs - a typed array in the IR itself would
  // survive JSON.stringify as an object with numeric keys.
  const tables = ir.tables.map((table) => ({
    kind: table.kind,
    n: table.n,
    data: new Float32Array(table.data),
    min: table.min,
    max: table.max,
  }));

  const uniforms = new Float64Array(
    ir.uniforms.reduce((sum, u) => sum + u.width, 0) || 1,
  );
  for (const uniform of ir.uniforms) {
    // Blackboard defaults come from the document; a host overrides them later
    // through setUniform. Filling with 1 rather than 0 avoids the case where an
    // unset multiplier silently zeroes an effect.
    for (let c = 0; c < uniform.width; c += 1) uniforms[uniform.offset + c] = 1;
  }

  const env = {
    consts: new Float64Array(ir.constants),
    uniforms,
    tables,
    // The asset table, so a kernel can turn its own `assetSlots` index into the
    // library id the browser layer keys its loaded data by. Everything else
    // about an asset is the renderer's business; a mesh EMITTER is the one
    // kernel that needs to reach outside the pool.
    assets: ir.assets,
    // MESH SAMPLERS ARRIVE LATE AND MUTATE THIS MAP IN PLACE.
    //
    // Geometry is fetched asynchronously by the browser layer, long after this
    // runtime and its kernel chains were built. Rebuilding the runtime when a
    // mesh lands would restart the effect - which is exactly what the author
    // does not want while they are picking a mesh - so the bank is a mutable
    // Map the kernels read per invocation instead. Until it is filled, a mesh
    // emitter spawns at its offset: visibly wrong and actionable, rather than
    // an effect that never appears at all.
    meshSamplers: new Map(),
    regs: new Float64Array(Math.max(1, ir.registerCount * 4)),
    effectSeed: ir.effect.seed >>> 0,
    duration: ir.effect.duration,
    time: 0,
    stepIndex: 0,
    frameSeed: 0,
    spawnEventSeed: 0,
    // One channel per (source system, trigger) pair anything listens to. Sized
    // from the effect's own capacity rather than a fixed number: a parent
    // holding 60k particles can raise 60k deaths in the frame it ends, and a
    // channel a tenth that size would drop most of them.
    events: createEventQueue({
      channels: Math.max(1, (ir.eventChannels || []).length),
      capacity: Math.max(256, Math.min(16384, ir.effect.capacity || 1024)),
    }),
  };

  const emitters = ir.systems.map((irSystem) => createEmitter(irSystem, ir, env));
  const stats = createStats({ profile: Boolean(options.profile) });

  const bytesPerSnapshot = emitters.reduce((sum, e) => sum + poolBytes(e.pool), 0);
  const budget = options.snapshotBudgetBytes ?? DEFAULT_SNAPSHOT_BUDGET;
  const maxSnapshots = Math.max(1, Math.floor(budget / Math.max(1, bytesPerSnapshot)));

  const runtime = {
    ir,
    env,
    emitters,
    stats,
    time: 0,
    stepIndex: 0,
    accumulator: 0,
    finished: false,
    bytesPerSnapshot,
    maxSnapshots,
    snapshots: new Map(),
    snapshotStride: 0,
  };

  reset(runtime);
  return runtime;
}

/** Total live particles across every emitter. */
export function aliveCount(runtime) {
  let alive = 0;
  for (const emitter of runtime.emitters) alive += emitter.pool.count;
  return alive;
}

/** Total spawns refused for want of capacity. */
export function droppedCount(runtime) {
  let dropped = 0;
  for (const emitter of runtime.emitters) dropped += emitter.pool.dropped;
  return dropped;
}

/**
 * Return to the pre-play state.
 * @param {Object} runtime
 */
export function reset(runtime) {
  for (const emitter of runtime.emitters) resetEmitter(emitter);
  runtime.time = 0;
  runtime.stepIndex = 0;
  runtime.accumulator = 0;
  runtime.finished = false;
  runtime.env.time = 0;
  runtime.env.stepIndex = 0;
  runtime.snapshots.clear();
  // The dropped tally goes too, not just the counts: it is a report about this
  // run of the effect, and carrying it across a restart would leave the HUD
  // blaming the current playthrough for a previous one's overflow.
  resetEventQueue(runtime.env.events);

  // Prewarm: simulate before frame zero, so a looping effect opens mid-flow
  // rather than visibly filling up. Runs after the reset so it is part of the
  // baseline state a seek to t=0 restores.
  //
  // PREWARM IS PRE-ROLL, NOT A TIME OFFSET, and the clock says so below. It
  // used to leave `time` at the prewarm value, which is the same bug three
  // times over: the timeline opened at 4.5s on a 6s effect and the first 4.5s
  // were unreachable; every seek below the prewarm re-entered this function and
  // landed back at 4.5s, so dragging the playhead ran a full prewarm per mouse
  // move and locked the tab; and a seek to 0 could never show frame zero.
  const { fixedDt, duration, loop } = runtime.ir.effect;
  let prewarmSteps = Math.round(runtime.ir.effect.prewarm / fixedDt);
  // Capped BELOW the duration for a looping effect. Past it the effect restarts
  // - step() calls reset() - which both wipes the pool this is trying to fill
  // and re-enters here, recursing until the stack gives out. A prewarm longer
  // than one loop cannot mean anything anyway: the state at duration + n is the
  // state at n.
  if (loop && duration > 0) prewarmSteps = Math.min(prewarmSteps, Math.ceil(duration / fixedDt) - 1);
  if (prewarmSteps <= 0) return;

  for (let i = 0; i < prewarmSteps && !runtime.finished; i += 1) step(runtime);

  // Back to frame zero, carrying the particles forward but not the clock.
  runtime.time = 0;
  runtime.stepIndex = 0;
  runtime.accumulator = 0;
  runtime.finished = false;
  runtime.env.time = 0;
  runtime.env.stepIndex = 0;
  // The snapshots taken during the prewarm are keyed on step indices that no
  // longer exist, so a later seek would restore a state from the wrong time.
  runtime.snapshots.clear();
  // ...and one at the new frame zero, so seeking back to the start restores it
  // instead of re-running the whole prewarm. Without this a drag towards 0 pays
  // for the prewarm on every mouse move, which is what made the tab hang.
  //
  // Taken regardless of snapshotStride, unlike the ones maybeSnapshot takes:
  // the editor never calls enableScrubbing, so stride is 0 there and this would
  // be exactly the case that needs it most. One pool copy per reset.
  runtime.snapshots.set(0, captureSnapshot(runtime));
}

// Solo takes precedence over mute, because the reason to solo is to look at one
// system while everything else is out of the way - having to also unmute the
// others first would make the button useless.
function applyMuting(runtime) {
  const soloed = runtime.emitters.filter((e) => e.solo);
  for (const emitter of runtime.emitters) {
    emitter.muted = soloed.length > 0 ? !emitter.solo : Boolean(emitter.userMuted);
  }
}

/**
 * Mute or solo a system, for debugging a multi-system effect.
 *
 * Deliberately NOT part of the graph signature: muting must not restart the
 * effect, because the whole point is to watch the others keep running.
 *
 * @param {Object} runtime
 * @param {string} systemId
 * @param {{muted?: boolean, solo?: boolean}} state
 */
export function setSystemState(runtime, systemId, state) {
  const emitter = runtime.emitters.find((e) => e.id === systemId);
  if (!emitter) return;
  if (state.muted !== undefined) emitter.userMuted = Boolean(state.muted);
  if (state.solo !== undefined) emitter.solo = Boolean(state.solo);
  applyMuting(runtime);
}

// Run a chain, timing each kernel when profiling is on.
//
// The two variants are not duplication for its own sake: with profiling off
// there must be no timing calls at all, or the overhead lands inside the number
// the go/no-go measurement is reading.
function runChain(chain, pool, i0, dynamicEnd, dt, stats) {
  if (stats.profile) {
    for (const entry of chain) {
      const start = performance.now();
      entry.fn(pool, i0, dynamicEnd ? pool.count : i0 + (pool.count - i0), dt);
      stats.kernel(entry.name, performance.now() - start);
    }
    return;
  }
  for (const entry of chain) {
    entry.fn(pool, i0, dynamicEnd ? pool.count : i0 + (pool.count - i0), dt);
  }
}

/**
 * Advance the simulation by exactly one fixed step.
 *
 * @param {Object} runtime
 */
export function step(runtime) {
  const dt = runtime.ir.effect.fixedDt;
  const env = runtime.env;
  const stats = runtime.stats;

  env.time = runtime.time;
  env.stepIndex = runtime.stepIndex;
  // Per-frame and per-burst randoms draw against these rather than a particle
  // seed. Derived from the step index so they are the same on every replay.
  env.frameSeed = pcgHash2(env.effectSeed ^ 0x51a7f00d, runtime.stepIndex);
  env.spawnEventSeed = pcgHash2(env.effectSeed ^ 0x2b1d3c77, runtime.stepIndex);

  stats.beginFrame();

  // Cleared at the START of the step, not the end.
  //
  // The emitters are ordered parents-before-children by the compiler and each
  // drains its channel during its own spawn, so a death recorded by a parent's
  // update is consumed by its child later in this same loop. Clearing first is
  // what makes it impossible for a record to survive into a second step and
  // spawn twice.
  clearEvents(env.events);

  for (const emitter of runtime.emitters) {
    const pool = emitter.pool;

    // Spawn first, so a particle born this step gets its first update in the
    // same step - which is what both engines do, and what stops a burst
    // appearing to lag its clip by one frame.
    const born = spawnStep(emitter, runtime.stepIndex, dt, env);
    if (born > 0) {
      const i0 = pool.count - born;
      runChain(emitter.initChain, pool, i0, false, dt, stats);
    }

    // The update chain reads pool.count fresh per kernel, because age.advance
    // compacts the pool part-way through and everything after it must see the
    // survivors rather than the range that existed on entry.
    runChain(emitter.updateChain, pool, 0, true, dt, stats);
  }

  stats.endFrame();

  runtime.stepIndex += 1;
  runtime.time = runtime.stepIndex * dt;

  const duration = runtime.ir.effect.duration;
  if (duration > 0 && runtime.time >= duration) {
    if (runtime.ir.effect.loop) {
      // A looping effect restarts rather than continuing, so a burst at t=0
      // fires again. Snapshots stay valid because they are keyed on step index
      // and reset clears them.
      reset(runtime);
    } else {
      runtime.finished = true;
    }
  }

  maybeSnapshot(runtime);
}

/**
 * Advance by a wall-clock delta, in whole fixed steps.
 *
 * The accumulator is clamped to maxSubSteps: a dropped second must not turn
 * into sixty steps of simulation crammed into one frame, which is how a stall
 * becomes a freeze.
 *
 * @param {Object} runtime
 * @param {number} delta seconds
 * @returns {number} steps taken
 */
export function advance(runtime, delta) {
  const { fixedDt, maxSubSteps, timeScale } = runtime.ir.effect;
  if (runtime.finished) return 0;

  runtime.accumulator += Math.max(0, delta) * (timeScale || 1);
  const ceiling = fixedDt * maxSubSteps;
  if (runtime.accumulator > ceiling) runtime.accumulator = ceiling;

  let taken = 0;
  while (runtime.accumulator >= fixedDt && !runtime.finished) {
    step(runtime);
    runtime.accumulator -= fixedDt;
    taken += 1;
  }
  return taken;
}

/**
 * How far through the current step the clock is, 0..1.
 *
 * Used for shader-side extrapolation rather than CPU interpolation: the vertex
 * shader offsets a particle by velocity * alpha * dt, which removes the judder
 * of a 60Hz sim on a 144Hz display without a second position buffer - and
 * position is the biggest attribute there is.
 *
 * @param {Object} runtime
 * @returns {number}
 */
export function stepAlpha(runtime) {
  return runtime.accumulator / runtime.ir.effect.fixedDt;
}

// ---------------------------------------------------------------------------
// Snapshots and seeking
// ---------------------------------------------------------------------------

function captureSnapshot(runtime) {
  return {
    stepIndex: runtime.stepIndex,
    time: runtime.time,
    pools: runtime.emitters.map((emitter) => ({
      // A byte copy of the whole pool. Copying only the live prefix would be
      // smaller but would leave whatever was beyond it untouched on restore,
      // and a later spawn into that region would inherit stale values.
      buffer: runtime.emitters.length ? new Uint8Array(emitter.pool.buffer).slice() : null,
      count: emitter.pool.count,
      spawnCursor: emitter.pool.spawnCursor,
      dropped: emitter.pool.dropped,
      // The fractional spawn carry. Easy to forget, and forgetting it makes a
      // seek land within one particle of a full re-simulation instead of on it.
      debt: emitter.debt,
    })),
  };
}

function restoreSnapshot(runtime, snapshot) {
  runtime.stepIndex = snapshot.stepIndex;
  runtime.time = snapshot.time;
  runtime.accumulator = 0;
  runtime.finished = false;
  runtime.env.time = snapshot.time;
  runtime.env.stepIndex = snapshot.stepIndex;
  snapshot.pools.forEach((saved, i) => {
    const emitter = runtime.emitters[i];
    new Uint8Array(emitter.pool.buffer).set(saved.buffer);
    emitter.pool.count = saved.count;
    emitter.pool.spawnCursor = saved.spawnCursor;
    emitter.pool.dropped = saved.dropped;
    emitter.debt = saved.debt;
  });
}

function maybeSnapshot(runtime) {
  const stride = runtime.snapshotStride;
  if (stride <= 0) return;
  if (runtime.stepIndex % stride !== 0) return;
  if (runtime.snapshots.size >= runtime.maxSnapshots) return;
  runtime.snapshots.set(runtime.stepIndex, captureSnapshot(runtime));
}

/**
 * Enable snapshotting for scrubbing, sized to the effect's length.
 *
 * Called by the editor when a timeline is on screen, not by default: an effect
 * that is only ever played forward should not pay the memory or the copying.
 *
 * @param {Object} runtime
 * @param {number} [spanSeconds] how much of the effect will be scrubbed
 */
export function enableScrubbing(runtime, spanSeconds) {
  const { fixedDt, duration } = runtime.ir.effect;
  const span = spanSeconds || duration || 2;
  const totalSteps = Math.max(1, Math.ceil(span / fixedDt));
  runtime.snapshotStride = Math.max(1, Math.ceil(totalSteps / runtime.maxSnapshots));
  // The step-zero baseline survives, because it is not a cache entry - it is the
  // prewarmed state reset() built, and dropping it would send the next seek to
  // the start back through the whole prewarm.
  const baseline = runtime.snapshots.get(0);
  runtime.snapshots.clear();
  if (baseline) runtime.snapshots.set(0, baseline);
}

/**
 * Seek to a time, by re-simulating from the nearest snapshot at or before it.
 *
 * Returns how many steps were actually simulated, which is what the UI needs to
 * decide whether to show progress: a handful is instant, a thousand is not.
 *
 * @param {Object} runtime
 * @param {number} seconds
 * @returns {{steps: number, fromSnapshot: boolean}}
 */
export function seekTo(runtime, seconds) {
  const fixedDt = runtime.ir.effect.fixedDt;
  const targetStep = Math.max(0, Math.round(Math.max(0, seconds) / fixedDt));

  let best = null;
  for (const [at, snapshot] of runtime.snapshots) {
    if (at <= targetStep && (!best || at > best.stepIndex)) best = snapshot;
  }

  // `>= 0`, not `> 0`: reset() leaves a snapshot at step zero holding the
  // PREWARMED state, and that is the one a seek back to the start wants. Taking
  // the reset() branch instead would be correct but would re-run the prewarm,
  // which on a drag towards 0 is a full simulation per mouse move.
  const restored = Boolean(best && best.stepIndex >= 0);
  if (restored) {
    restoreSnapshot(runtime, best);
  } else {
    reset(runtime);
  }

  let steps = 0;
  while (runtime.stepIndex < targetStep) {
    step(runtime);
    steps += 1;
    // A non-looping effect that has ended cannot be stepped further; stopping
    // here rather than spinning is what keeps a seek past the end from hanging.
    if (runtime.finished) break;
  }
  return { steps, fromSnapshot: restored };
}

/**
 * The numbers the HUD shows.
 * @param {Object} runtime
 * @returns {Object}
 */
export function runtimeStats(runtime) {
  const timing = runtime.stats.summary();
  let capacity = 0;
  let spawned = 0;
  for (const emitter of runtime.emitters) {
    capacity += emitter.pool.capacity;
    spawned += emitter.pool.spawnCursor;
  }
  return {
    ...timing,
    time: runtime.time,
    stepIndex: runtime.stepIndex,
    alive: aliveCount(runtime),
    capacity,
    spawned,
    dropped: droppedCount(runtime),
    // Events lost to a full channel. Reported next to the dropped particles for
    // the same reason: dropping visibly beats hitching invisibly, and a
    // sub-emitter that quietly stops firing at high counts is otherwise
    // indistinguishable from one that is working.
    eventsDropped: runtime.env.events.dropped,
    finished: runtime.finished,
  };
}

/**
 * Set a blackboard property. The only thing a host can change without a
 * recompile, which is what makes the compiled chains cacheable.
 *
 * @param {Object} runtime
 * @param {string} name
 * @param {number|number[]} value
 * @returns {boolean} whether the name was found
 */
export function setUniform(runtime, name, value) {
  const uniform = runtime.ir.uniforms.find((u) => u.name === name);
  if (!uniform) return false;
  const values = Array.isArray(value) ? value : [value];
  for (let c = 0; c < uniform.width; c += 1) {
    runtime.env.uniforms[uniform.offset + c] = Number(values[c] ?? values[0]) || 0;
  }
  return true;
}

/**
 * Install (or replace) the surface sampler for a mesh asset.
 *
 * Separate from setUniform because it is not a blackboard value: a host cannot
 * set it, and it does not recompile anything. See `env.meshSamplers` for why it
 * is installed after the fact rather than captured at build time.
 *
 * @param {Object} runtime
 * @param {number} assetId the library id the IR references
 * @param {Object|null} sampler from buildMeshSampler, or null to clear
 */
export function setMeshSampler(runtime, assetId, sampler) {
  if (assetId == null) return;
  if (sampler) runtime.env.meshSamplers.set(assetId, sampler);
  else runtime.env.meshSamplers.delete(assetId);
}

/**
 * Install a sampler for every loaded mesh a runtime might emit from.
 *
 * WHY THIS EXISTS AS A FUNCTION. A mesh emitter with no sampler does not fail -
 * `shape.position.mesh` falls back to `placeShape(..., 0, 0, 0)` and every
 * particle spawns at the shape's origin, so the system collapses to a point.
 * The live preview installs samplers in useVfxRuntime and looked right, while
 * the sprite-sheet bake and the simulated thumbnail each built their own
 * runtime and installed nothing - so a mesh-emitted effect baked as a handful
 * of particles at the origin, with nothing anywhere saying why.
 *
 * Three call sites needed the same six lines, so they get one function. The
 * `meshes` map is the same one the batch builder takes: asset id to a
 * BufferGeometry-like object.
 *
 * @param {Object} runtime
 * @param {Map<number, {attributes?: Object, index?: Object}>} meshes
 * @returns {number} how many samplers were installed, for the caller to report
 */
export function installMeshSamplers(runtime, meshes) {
  if (!runtime || !meshes) return 0;
  let installed = 0;
  for (const [assetId, geometry] of meshes) {
    const positions = geometry?.attributes?.position?.array;
    if (!positions) continue;
    setMeshSampler(runtime, assetId, buildMeshSampler({
      positions,
      normals: geometry.attributes?.normal?.array || null,
      index: geometry.index?.array || null,
    }));
    installed += 1;
  }
  return installed;
}

/** Also used by computeSpawnCount's callers in tests. */
export { computeSpawnCount };
