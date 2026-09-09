// Checks for the VFX runtime: pool, kernels, emitter, system.
// No test framework - run it directly:
//
//     node src/utils/vfx/runtime.test.mjs
//
// This closes the gap vfx/compile.test.mjs declares. That file proves the IR is
// well-formed and says what the document said; it explicitly cannot prove the
// IR is CORRECT, and it names the two ways it could pass while being wrong:
//
//   - a kernel name that no kernel implements
//   - a binding whose semantics the kernel reads differently than the compiler
//     meant
//
// Section 1 covers the first directly. The rest cover the second by checking
// the physics against closed-form answers rather than against itself, which is
// the only way to catch a kernel that is self-consistently wrong.
//
// KNOWN GAP: nothing here renders anything, so nothing here can catch a
// mismatch between what the sim produces and what the instanced buffer draws -
// a swapped colour channel, a size in the wrong units, a flipped V. That is
// phase 4's, and it needs eyes on a frame rather than a checksum.
import { compileVfxGraph } from '../../../vfx/compile.js';
import { CATALOG } from '../../../vfx/catalog.js';
import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc } from '../../../vfx/doc.js';
import { CURVE_PRESETS, constantCurve } from '../../../vfx/curve.js';
import { GRADIENT_PRESETS } from '../../../vfx/gradient.js';
import { constValue, curveValue, gradientValue, randomValue } from '../../../vfx/value.js';
import { pcgFloatAt } from '../../../vfx/random.js';
import { implementedKernels, particleSeed } from './kernels.js';
import { poolChecksum } from './pool.js';
import {
  advance,
  createVfxRuntime,
  enableScrubbing,
  reset,
  runtimeStats,
  seekTo,
  setSystemState,
  setUniform,
  step,
} from './system.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const preset = (list, id) => list.find((p) => p.id === id).build();

let n = 0;
const blk = (type, props = {}, modes) => {
  const b = { id: `b${(n += 1)}`, type, enabled: true, props };
  if (modes) b.modes = modes;
  return b;
};

/**
 * Build a one-system document from stage stacks. Deliberately explicit rather
 * than reusing vfx/fixtures.mjs: these cases need surgical control over which
 * blocks exist, and a shared fixture that grows a block breaks the arithmetic
 * the physics checks depend on.
 */
function doc({ spawn, init, update, capacity = 1024, duration = 0, loop = false, clips, outputParams }) {
  const d = createEmptyVfxDoc({ name: 'Runtime test' });
  d.effect.duration = duration;
  d.effect.loop = loop;
  d.effect.capacity = capacity;
  d.references = { tex: { kind: 'image', ref: 'asset:1', name: 't.png', colorSpace: 'srgb' } };
  const s = d.systems[0];
  s.capacity = capacity;
  if (clips) s.schedule = { clips };
  s.contexts = [
    { id: 'c1', kind: CONTEXT_KIND.SPAWN, blocks: spawn || [], params: {} },
    { id: 'c2', kind: CONTEXT_KIND.INITIALIZE, blocks: init || [], params: {} },
    { id: 'c3', kind: CONTEXT_KIND.UPDATE, blocks: update || [], params: {} },
    {
      id: 'c4',
      kind: CONTEXT_KIND.OUTPUT,
      blocks: [blk('output.setMainTexture', { texture: constValue('tex') })],
      params: outputParams || { mode: 'billboard', blend: 'additive', sort: 'none' },
    },
  ];
  return normalizeVfxDoc(d);
}

function build(spec, options = {}) {
  const { ir, diagnostics } = compileVfxGraph(doc(spec), { assetIndex: new Set([1]) });
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`fixture has compile errors: ${errors.map((d) => d.code).join(' ')}`);
  return { ir, runtime: createVfxRuntime(ir, options) };
}

// A stack that is complete enough to compile without errors, with the pieces
// the caller does not care about held at values that do nothing.
const inertInit = () => [
  blk('initialize.setLifetime', { lifetime: constValue(10) }),
  blk('initialize.setSize', { size: constValue(1) }),
  blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
];

// ---------------------------------------------------------------------------
// 1. Every kernel the catalog names actually exists
// ---------------------------------------------------------------------------
{
  const declared = new Set(CATALOG.blocks.map((b) => b.kernel));
  // Injected by the compiler rather than named by a block.
  declared.add('age.advance');
  declared.add('init.snapshot');
  declared.add('integrate.semiImplicit');
  declared.add('integrate.euler');
  const implemented = new Set(implementedKernels());
  const missing = [...declared].filter((k) => !implemented.has(k));
  check('every catalog kernel is implemented', missing.length === 0, missing.join(' ') || `${declared.size} kernels`);

  const orphans = [...implemented].filter((k) => !declared.has(k));
  check('  and no kernel is orphaned', orphans.length === 0, orphans.join(' '));
}

// ---------------------------------------------------------------------------
// 2. The physics matches closed-form answers
// ---------------------------------------------------------------------------
{
  // Semi-implicit Euler under constant gravity, from rest:
  //   v_n = n * g * dt
  //   p_n = g * dt^2 * n(n+1)/2
  // Checking against the formula rather than against a recorded number is what
  // distinguishes "the integrator is right" from "the integrator has not
  // changed".
  const g = -9.8;
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(1) })],
    init: inertInit(),
    update: [blk('update.gravity', { gravity: constValue([0, g, 0]) })],
  });
  const steps = 30;
  for (let i = 0; i < steps; i += 1) step(runtime);
  const dt = runtime.ir.effect.fixedDt;
  const pool = runtime.emitters[0].pool;
  const expectedV = steps * g * dt;
  const expectedP = g * dt * dt * (steps * (steps + 1)) / 2;
  check(
    'semi-implicit gravity matches the closed form',
    near(pool.planes.velocity[1], expectedV, 1e-3) && near(pool.planes.position[1], expectedP, 1e-3),
    `v ${pool.planes.velocity[1].toFixed(4)} vs ${expectedV.toFixed(4)}, p ${pool.planes.position[1].toFixed(4)} vs ${expectedP.toFixed(4)}`,
  );
}

{
  // Drag must decelerate, and must not overshoot into oscillation - which is
  // the reason the default integrator is semi-implicit rather than explicit.
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(1) })],
    init: [
      ...inertInit(),
      blk('initialize.velocityRandom', { min: constValue([10, 0, 0]), max: constValue([10, 0, 0]) }),
    ],
    update: [blk('update.drag', { drag: constValue(20) })],
  });
  const pool = runtime.emitters[0].pool;
  let signFlips = 0;
  let previous = 10;
  for (let i = 0; i < 60; i += 1) {
    step(runtime);
    const v = pool.planes.velocity[0];
    if (v * previous < 0) signFlips += 1;
    previous = v;
  }
  check('strong drag decays without oscillating', signFlips === 0 && previous > 0 && previous < 0.5,
    `${signFlips} sign flips, final v ${previous.toFixed(5)}`);
}

// ---------------------------------------------------------------------------
// 3. Lifetime, death, and compaction
// ---------------------------------------------------------------------------
{
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(10) })],
    init: [
      blk('initialize.setLifetime', { lifetime: constValue(0.1) }),
      blk('initialize.setSize', { size: constValue(1) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    ],
    update: [],
  });
  const pool = runtime.emitters[0].pool;
  // 0.1s at 1/60 per step is 6 steps of ageing; the sixth takes age to 0.1,
  // which is not less than lifetime, so they die on step 6.
  for (let i = 0; i < 5; i += 1) step(runtime);
  const aliveBefore = pool.count;
  step(runtime);
  check('particles die on the right step', aliveBefore === 10 && pool.count === 0,
    `${aliveBefore} before, ${pool.count} after`);
}

{
  // COMPACTION COHERENCE, and the reason it is worth a real test: swapRemove
  // copies every attribute plane, and getting one plane's stride wrong would
  // leave a particle wearing another particle's position while keeping its own
  // seed. Nothing else would notice.
  //
  // Sphere placement is a pure function of the seed, and with no forces the
  // position never changes after birth - so every survivor's position can be
  // recomputed from its own seed and compared. An independent derivation, not a
  // recorded snapshot.
  const radius = 0.7;
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(200) })],
    init: [
      // A wide random lifetime so deaths are spread across many steps, which is
      // what makes the pool churn rather than empty all at once.
      blk('initialize.setLifetime', { lifetime: randomValue(0.05, 0.9) }),
      blk('initialize.setSize', { size: constValue(1) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      blk('initialize.positionSphere', { radius: constValue(radius) }, { fill: 'volume' }),
    ],
    update: [],
  });

  // The same arithmetic shapePositionSphere uses, re-derived here on purpose.
  const SPHERE_SLOT = 0x51ed270b;
  const expectPosition = (seed) => {
    const u = pcgFloatAt(seed, SPHERE_SLOT) * 2 - 1;
    const theta = pcgFloatAt(seed, SPHERE_SLOT + 1) * Math.PI * 2;
    const r = radius * Math.cbrt(pcgFloatAt(seed, SPHERE_SLOT + 2));
    const ring = Math.sqrt(Math.max(0, 1 - u * u));
    return [r * ring * Math.cos(theta), r * ring * Math.sin(theta), r * u];
  };

  const pool = runtime.emitters[0].pool;
  let worst = 0;
  let checked = 0;
  for (let s = 0; s < 40; s += 1) {
    step(runtime);
    for (let i = 0; i < pool.count; i += 1) {
      const [ex, ey, ez] = expectPosition(pool.planes.seed[i]);
      worst = Math.max(
        worst,
        Math.abs(pool.planes.position[i * 3] - ex),
        Math.abs(pool.planes.position[i * 3 + 1] - ey),
        Math.abs(pool.planes.position[i * 3 + 2] - ez),
      );
      checked += 1;
    }
  }
  check('compaction keeps attributes paired', worst < 1e-6 && checked > 1000,
    `${checked} particle-steps, worst drift ${worst.toExponential(1)}`);
  check('  and the pool did churn', pool.count < 200 && pool.count > 0, `${pool.count} of 200 left`);
}

{
  // Every particle's seed must be unique, or two of them share every random
  // draw and the effect visibly doubles up.
  const { runtime } = build({
    spawn: [blk('spawn.rate', { rate: constValue(600) })],
    init: inertInit(),
    update: [],
    capacity: 4096,
  });
  const pool = runtime.emitters[0].pool;
  for (let i = 0; i < 120; i += 1) step(runtime);
  const seeds = new Set();
  for (let i = 0; i < pool.count; i += 1) seeds.add(pool.planes.seed[i]);
  check('particle seeds are unique', seeds.size === pool.count, `${seeds.size} of ${pool.count}`);
}

// ---------------------------------------------------------------------------
// 4. Over-life scales the birth value, and does not compound
// ---------------------------------------------------------------------------
{
  // The trap this exists for: applying the curve to the LIVE attribute instead
  // of the birth copy means a scale of 1.5 multiplies again every frame, so
  // after 30 frames the particle is 1.5^30 times too big. That looks like an
  // exploding effect and reads as a physics bug rather than a compounding one.
  const startSize = 0.4;
  const flat = 1.5;
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(1) })],
    init: [
      blk('initialize.setLifetime', { lifetime: constValue(10) }),
      blk('initialize.setSize', { size: constValue(startSize) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    ],
    update: [blk('update.sizeOverLife', { scale: curveValue(constantCurve(1), { scale: flat }) })],
  });
  const pool = runtime.emitters[0].pool;
  for (let i = 0; i < 30; i += 1) step(runtime);
  check('size over life multiplies the birth size once',
    near(pool.planes.size[0], startSize * flat, 1e-5),
    `${pool.planes.size[0].toFixed(5)} vs ${(startSize * flat).toFixed(5)}`);
}

{
  // The curve must actually be sampled over life, not evaluated at one point.
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(1) })],
    init: [
      blk('initialize.setLifetime', { lifetime: constValue(1) }),
      blk('initialize.setSize', { size: constValue(1) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    ],
    update: [blk('update.sizeOverLife', { scale: curveValue(preset(CURVE_PRESETS, 'bell')) })],
  });
  const pool = runtime.emitters[0].pool;
  const samples = [];
  for (let i = 0; i < 60; i += 1) {
    step(runtime);
    if (pool.count > 0) samples.push(pool.planes.size[0]);
  }
  const peak = Math.max(...samples);
  const peakAt = samples.indexOf(peak) / samples.length;
  // A bell peaks in the middle, so the largest size should be near half-life.
  check('a bell curve peaks mid-life', peakAt > 0.35 && peakAt < 0.65 && near(peak, 1, 0.02),
    `peak ${peak.toFixed(3)} at ${(peakAt * 100).toFixed(0)}% of life`);
}

{
  // Colour over life multiplies the birth colour too, which is what makes a
  // per-particle tint and a shared ramp compose instead of one overwriting the
  // other.
  const tint = [0.5, 0.25, 2, 1];
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(1) })],
    init: [
      blk('initialize.setLifetime', { lifetime: constValue(1) }),
      blk('initialize.setSize', { size: constValue(1) }),
      blk('initialize.setColor', { color: constValue(tint) }),
    ],
    update: [blk('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'fadeOut')) })],
  });
  const pool = runtime.emitters[0].pool;
  step(runtime);
  // fadeOut is white with alpha ramping 1 -> 0, so rgb should still be the
  // tint and alpha should have started falling.
  const ok = near(pool.planes.color[0], tint[0], 0.02)
    && near(pool.planes.color[2], tint[2], 0.02)
    && pool.planes.color[3] < 1 && pool.planes.color[3] > 0.9;
  check('colour over life multiplies the tint', ok,
    [0, 1, 2, 3].map((c) => pool.planes.color[c].toFixed(3)).join(', '));
}

// ---------------------------------------------------------------------------
// 5. Timeline clips
// ---------------------------------------------------------------------------
{
  // A burst fires on the step its window opens, and only then.
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(7) })],
    init: inertInit(),
    update: [],
    clips: [{ at: 0.05, duration: 0, loop: false }],
  });
  const pool = runtime.emitters[0].pool;
  const atStep = Math.round(0.05 * 60);
  const counts = [];
  for (let i = 0; i < 8; i += 1) {
    step(runtime);
    counts.push(pool.count);
  }
  check('a burst fires on its clip step',
    counts[atStep - 1] === 0 && counts[atStep] === 7 && counts[atStep + 1] === 7,
    `counts ${counts.join(',')} (expect first 7 at index ${atStep})`);
}

{
  // A timed window gates a rate: nothing before it opens, nothing after it
  // closes, emission in between.
  const { runtime } = build({
    spawn: [blk('spawn.rate', { rate: constValue(600) })],
    init: inertInit(),
    update: [],
    capacity: 4096,
    clips: [{ at: 0.1, duration: 0.2, loop: false }],
  });
  const pool = runtime.emitters[0].pool;
  for (let i = 0; i < 6; i += 1) step(runtime);
  const beforeOpen = pool.count;
  for (let i = 0; i < 12; i += 1) step(runtime);
  const duringWindow = pool.count;
  for (let i = 0; i < 30; i += 1) step(runtime);
  const afterClose = pool.count;
  check('a timed window gates a rate',
    beforeOpen === 0 && duringWindow > 0 && afterClose === duringWindow,
    `${beforeOpen} before, ${duringWindow} during, ${afterClose} after`);
}

{
  // Duration zero means the window never closes - the single rule that makes
  // bursts instantaneous and rates continuous without a special case.
  const { runtime } = build({
    spawn: [blk('spawn.rate', { rate: constValue(60) })],
    init: inertInit(),
    update: [],
    capacity: 4096,
    clips: [{ at: 0, duration: 0, loop: false }],
  });
  const pool = runtime.emitters[0].pool;
  for (let i = 0; i < 120; i += 1) step(runtime);
  check('a zero-duration clip leaves the window open', pool.count > 100, `${pool.count} alive after 2s at 60/s`);
}

{
  // Two clips on one track: the case the whole timeline feature exists for.
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(5) })],
    init: inertInit(),
    update: [],
    clips: [{ at: 0, duration: 0, loop: false }, { at: 0.2, duration: 0, loop: false }],
  });
  const pool = runtime.emitters[0].pool;
  step(runtime);
  const afterFirst = pool.count;
  for (let i = 0; i < 20; i += 1) step(runtime);
  check('two clips both fire', afterFirst === 5 && pool.count === 10, `${afterFirst} then ${pool.count}`);
}

{
  // A looping window repeats with a period equal to its own duration.
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(3) })],
    init: inertInit(),
    update: [],
    clips: [{ at: 0, duration: 0.1, loop: true }],
  });
  const pool = runtime.emitters[0].pool;
  for (let i = 0; i < 30; i += 1) step(runtime);
  // 30 steps at 1/60 is 0.5s; a 0.1s period fires at 0, 0.1, 0.2, 0.3, 0.4.
  check('a looping window re-fires its burst', pool.count === 15, `${pool.count} particles (expect 15)`);
}

// ---------------------------------------------------------------------------
// 6. Capacity, and dropping visibly
// ---------------------------------------------------------------------------
{
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(500) })],
    init: inertInit(),
    update: [],
    capacity: 100,
  });
  step(runtime);
  const stats = runtimeStats(runtime);
  // Dropping is the designed behaviour; what matters is that it is COUNTED, so
  // the HUD can show it instead of the author wondering where the particles
  // went.
  check('overflow is dropped and counted', stats.alive === 100 && stats.dropped === 400,
    `${stats.alive} alive, ${stats.dropped} dropped`);
}

// ---------------------------------------------------------------------------
// 7. Determinism
// ---------------------------------------------------------------------------
{
  const spec = {
    spawn: [blk('spawn.rate', { rate: constValue(900) })],
    init: [
      blk('initialize.setLifetime', { lifetime: randomValue(0.2, 0.8) }),
      blk('initialize.setSize', { size: randomValue(0.05, 0.2) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      blk('initialize.positionSphere', { radius: constValue(0.5) }, { fill: 'volume' }),
      blk('initialize.velocityRandom', { min: constValue([-2, 0, -2]), max: constValue([2, 3, 2]) }),
    ],
    update: [
      blk('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
      blk('update.drag', { drag: constValue(1.1) }),
      blk('update.turbulence', { strength: constValue(1), frequency: constValue(0.7) }),
      blk('update.sizeOverLife', { scale: curveValue(preset(CURVE_PRESETS, 'bell')) }),
      blk('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'fire')) }),
    ],
    capacity: 4096,
  };

  const a = build(spec).runtime;
  const b = build(spec).runtime;
  for (let i = 0; i < 120; i += 1) step(a);
  for (let i = 0; i < 120; i += 1) step(b);
  const checksumA = poolChecksum(a.emitters[0].pool);
  check('two runtimes agree after 120 steps', checksumA === poolChecksum(b.emitters[0].pool), String(checksumA));

  reset(a);
  for (let i = 0; i < 120; i += 1) step(a);
  check('  and a replay after reset agrees', poolChecksum(a.emitters[0].pool) === checksumA);
}

{
  // Frame pacing must not change the result. advance() with one big delta and
  // advance() with many small ones have to land on the same state, or the
  // preview looks different on a 144Hz display than on a 60Hz one - and the
  // thumbnail would differ from both.
  const spec = {
    spawn: [blk('spawn.rate', { rate: constValue(300) })],
    init: [
      blk('initialize.setLifetime', { lifetime: randomValue(0.3, 0.7) }),
      blk('initialize.setSize', { size: constValue(0.1) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      blk('initialize.velocityRandom', { min: constValue([-1, 0, -1]), max: constValue([1, 2, 1]) }),
    ],
    update: [blk('update.gravity', { gravity: constValue([0, -9.8, 0]) })],
    capacity: 2048,
  };
  const dt = 1 / 60;
  const stepped = build(spec).runtime;
  for (let i = 0; i < 60; i += 1) step(stepped);

  const paced = build(spec).runtime;
  // Awkward deltas on purpose, none of them a whole step. Advanced until the
  // step INDEX matches, rather than for a fixed amount of wall time: summing
  // floats to "exactly" 60 * dt leaves a sub-step remainder, so 59 whole steps
  // plus a carry is the correct outcome and comparing step counts would be
  // testing float addition rather than the simulation.
  const deltas = [dt * 0.4, dt * 1.7, dt * 0.9, dt * 2.3];
  let k = 0;
  while (paced.stepIndex < stepped.stepIndex) {
    advance(paced, deltas[k % deltas.length]);
    k += 1;
    if (k > 10000) break;
  }
  check('frame pacing does not change the result',
    paced.stepIndex === stepped.stepIndex
      && poolChecksum(paced.emitters[0].pool) === poolChecksum(stepped.emitters[0].pool),
    `${paced.stepIndex} steps over ${k} frames vs ${stepped.stepIndex} steps over ${stepped.stepIndex}`);
}

{
  // A stall must not turn into a freeze: the accumulator is clamped, so a
  // dropped second simulates maxSubSteps and then gives up the rest.
  const { runtime } = build({
    spawn: [blk('spawn.burst', { count: constValue(1) })],
    init: inertInit(),
    update: [],
  });
  const taken = advance(runtime, 1.0);
  check('a long delta is clamped to maxSubSteps', taken === runtime.ir.effect.maxSubSteps,
    `${taken} steps for a 1s delta`);
}

// ---------------------------------------------------------------------------
// 8. Seeking - the snapshot path must equal a full re-simulation
// ---------------------------------------------------------------------------
{
  // The check the plan names explicitly. A snapshot restores the pool bytes,
  // the live count, the spawn cursor AND each emitter's fractional spawn carry;
  // miss any one and a seek lands near a full re-simulation rather than on it,
  // which shows up as an effect that looks subtly different after scrubbing and
  // is close to impossible to attribute.
  const spec = {
    spawn: [blk('spawn.rate', { rate: constValue(437) })],
    init: [
      blk('initialize.setLifetime', { lifetime: randomValue(0.2, 0.6) }),
      blk('initialize.setSize', { size: randomValue(0.05, 0.15) }),
      blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      blk('initialize.positionSphere', { radius: constValue(0.3) }, { fill: 'volume' }),
      blk('initialize.velocityRandom', { min: constValue([-1, 1, -1]), max: constValue([1, 3, 1]) }),
    ],
    update: [
      blk('update.gravity', { gravity: constValue([0, -5, 0]) }),
      blk('update.turbulence', { strength: constValue(0.7), frequency: constValue(0.5) }),
    ],
    capacity: 2048,
  };
  const target = 1.25;

  // Ground truth: no snapshots at all, stepped from zero.
  const truth = build(spec).runtime;
  const steps = Math.round(target / truth.ir.effect.fixedDt);
  for (let i = 0; i < steps; i += 1) step(truth);
  const expected = poolChecksum(truth.emitters[0].pool);

  // Seek with scrubbing enabled AND a deliberately tiny snapshot budget, so
  // the stride is sparse and a seek has to restore a snapshot and then step
  // forward. With the default budget this pool is small enough to get a
  // snapshot every single step, which made every seek an exact hit and left
  // the restore-then-resimulate path - the one that can actually be wrong -
  // completely untested.
  const scrubbed = build(spec, { snapshotBudgetBytes: 900 * 1024 }).runtime;
  enableScrubbing(scrubbed, 2);
  for (let i = 0; i < steps; i += 1) step(scrubbed);
  const forward = seekTo(scrubbed, target);
  check('seek forward lands where stepping did',
    poolChecksum(scrubbed.emitters[0].pool) === expected,
    `${forward.steps} steps, from snapshot: ${forward.fromSnapshot}`);

  // The case that matters: seeking BACKWARDS, which is what a scrubber does.
  for (let i = 0; i < 40; i += 1) step(scrubbed);
  const backward = seekTo(scrubbed, target);
  check('  and seeking backwards lands there too',
    poolChecksum(scrubbed.emitters[0].pool) === expected,
    `${backward.steps} steps re-simulated, from snapshot: ${backward.fromSnapshot}`);
  check('  using a snapshot rather than starting over',
    backward.fromSnapshot && backward.steps > 0 && backward.steps < steps,
    `${backward.steps} of ${steps} steps re-simulated, stride ${scrubbed.snapshotStride}`);

  // And with no snapshots the answer must still be right, just slower.
  const cold = build(spec).runtime;
  const coldSeek = seekTo(cold, target);
  check('  a cold seek is correct without snapshots',
    poolChecksum(cold.emitters[0].pool) === expected,
    `${coldSeek.steps} steps, from snapshot: ${coldSeek.fromSnapshot}`);
}

// ---------------------------------------------------------------------------
// 9. Editor controls that must not restart the effect
// ---------------------------------------------------------------------------
{
  const d = createEmptyVfxDoc({ name: 'Two systems' });
  d.effect.capacity = 4096;
  d.references = { tex: { kind: 'image', ref: 'asset:1', name: 't.png', colorSpace: 'srgb' } };
  const makeSystem = (id, name) => ({
    id,
    name,
    enabled: true,
    capacity: 512,
    simulationSpace: 'inherit',
    contexts: [
      { id: `${id}-s`, kind: CONTEXT_KIND.SPAWN, blocks: [blk('spawn.rate', { rate: constValue(300) })], params: {} },
      { id: `${id}-i`, kind: CONTEXT_KIND.INITIALIZE, blocks: inertInit(), params: {} },
      { id: `${id}-u`, kind: CONTEXT_KIND.UPDATE, blocks: [], params: {} },
      {
        id: `${id}-o`,
        kind: CONTEXT_KIND.OUTPUT,
        blocks: [blk('output.setMainTexture', { texture: constValue('tex') })],
        params: { mode: 'billboard', blend: 'additive', sort: 'none' },
      },
    ],
  });
  d.systems = [makeSystem('sysA', 'A'), makeSystem('sysB', 'B')];
  const { ir } = compileVfxGraph(normalizeVfxDoc(d), { assetIndex: new Set([1]) });
  const runtime = createVfxRuntime(ir);

  for (let i = 0; i < 30; i += 1) step(runtime);
  const beforeA = runtime.emitters[0].pool.count;
  check('both systems emit', beforeA > 0 && runtime.emitters[1].pool.count > 0);

  // Solo must silence the others WITHOUT clearing them - the whole point is to
  // watch one system while the rest keep their state.
  setSystemState(runtime, 'sysA', { solo: true });
  const bBefore = runtime.emitters[1].pool.count;
  for (let i = 0; i < 30; i += 1) step(runtime);
  check('solo stops the others spawning', runtime.emitters[1].pool.count <= bBefore
    && runtime.emitters[0].pool.count > beforeA,
  `A ${runtime.emitters[0].pool.count}, B ${runtime.emitters[1].pool.count} (was ${bBefore})`);

  setSystemState(runtime, 'sysA', { solo: false });
  setSystemState(runtime, 'sysB', { muted: true });
  const bMuted = runtime.emitters[1].pool.count;
  for (let i = 0; i < 20; i += 1) step(runtime);
  check('mute stops one system', runtime.emitters[1].pool.count <= bMuted);
}

{
  // A blackboard property is the only thing a host may change without a
  // recompile, which is what makes the compiled chains cacheable.
  const d = createEmptyVfxDoc({ name: 'Exposed' });
  d.references = { tex: { kind: 'image', ref: 'asset:1', name: 't.png', colorSpace: 'srgb' } };
  d.exposed = [{ id: 'x1', name: 'Intensity', type: 'float', defaultValue: 1 }];
  const s = d.systems[0];
  s.capacity = 256;
  s.contexts = [
    { id: 'c1', kind: CONTEXT_KIND.SPAWN, blocks: [blk('spawn.burst', { count: constValue(1) })], params: {} },
    {
      id: 'c2',
      kind: CONTEXT_KIND.INITIALIZE,
      blocks: [
        blk('initialize.setLifetime', { lifetime: constValue(5) }),
        blk('initialize.setSize', { size: { mode: 'exposed', exposedId: 'x1', v: 1 } }),
        blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
      ],
      params: {},
    },
    { id: 'c3', kind: CONTEXT_KIND.UPDATE, blocks: [], params: {} },
    {
      id: 'c4',
      kind: CONTEXT_KIND.OUTPUT,
      blocks: [blk('output.setMainTexture', { texture: constValue('tex') })],
      params: { mode: 'billboard', blend: 'additive', sort: 'none' },
    },
  ];
  const { ir } = compileVfxGraph(normalizeVfxDoc(d), { assetIndex: new Set([1]) });
  const runtime = createVfxRuntime(ir);
  check('an exposed property becomes a uniform', ir.uniforms.length === 1 && ir.uniforms[0].name === 'Intensity');
  check('  and can be set by name', setUniform(runtime, 'Intensity', 3.25) === true);
  check('  and an unknown name is refused', setUniform(runtime, 'Nope', 1) === false);
  step(runtime);
  check('  and the sim reads it', near(runtime.emitters[0].pool.planes.size[0], 3.25, 1e-5),
    String(runtime.emitters[0].pool.planes.size[0]));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
