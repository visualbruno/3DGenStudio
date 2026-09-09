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
import { implementedOps } from './kernels.js';
import { OPERATOR_OPS } from '../../../vfx/compile.js';
import { templateById } from './templates.js';
import { addEdge, addOperator, setOperatorProp } from './edits.js';
import * as fixtures from '../../../vfx/fixtures.mjs';
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

// ---------------------------------------------------------------------------
console.log('\n--- Operator nodes actually compute something ---');
// ---------------------------------------------------------------------------
//
// THE BUG THIS SECTION EXISTS FOR. The compiler lowered an operator subtree
// into `irBlock.pre` and bindings read `src: 'register'` - and nothing ever
// executed that list. `env.regs` stayed all zeros, so wiring a Value node of 5
// into Set Size produced a size of ZERO. Every visible signal said it was
// working: the node was on the board, the wire was drawn, the compile was
// clean, `compile.test.mjs` was green because it checks the IR's SHAPE. Only
// running the simulation and reading the pool catches it, which is what these
// checks do.
{
  // --- coverage, in both directions --------------------------------------
  const compilerOps = new Set(Object.values(OPERATOR_OPS));
  const runtimeOps = new Set(implementedOps());
  const unevaluated = [...compilerOps].filter((op) => !runtimeOps.has(op));
  const unreachable = [...runtimeOps].filter((op) => !compilerOps.has(op));
  // An op the compiler emits and the runtime cannot evaluate reads as zero -
  // exactly the original bug, one operator at a time.
  check('every op the compiler emits has a runtime evaluator',
    unevaluated.length === 0, unevaluated.join(', '));
  check('  and every evaluator is reachable from the catalog',
    unreachable.length === 0, unreachable.join(', '));

  // ARITY. lowerOperatorTree pushes one input per catalog prop in DECLARATION
  // ORDER, and each evaluator reads op.in[0], op.in[1], ... positionally. So
  // an operator with fewer props than its evaluator reads is a silent zero in
  // the middle of an expression.
  const arity = { const: 1, add: 2, sub: 2, mul: 2, div: 2, lerp: 3, clamp: 3, remap: 5, sin: 1, random: 2, time: 0, attr: 0 };
  const wrongArity = [];
  for (const def of CATALOG.operators) {
    const op = OPERATOR_OPS[def.id];
    const props = Object.keys(def.props || {}).length;
    if (arity[op] !== undefined && arity[op] !== props) {
      wrongArity.push(`${def.id}: ${props} props, evaluator reads ${arity[op]}`);
    }
  }
  check('  and every operator declares as many props as its evaluator reads',
    wrongArity.length === 0, wrongArity.join('; '));

  // --- the three paths that read a register ------------------------------
  const smoke = normalizeVfxDoc(templateById('smoke').build());
  const blocksOf = (d) => d.systems.flatMap((sys) => sys.contexts.flatMap((c) => c.blocks));
  const sizeBlock = blocksOf(smoke).find((b) => b.type === 'initialize.setSize');
  const rateBlock = blocksOf(smoke).find((b) => b.type === 'spawn.rate');

  const wire = (doc, ops, blockId, prop) => {
    let next = doc;
    for (const [type, props] of ops) {
      next = addOperator(next, type);
      const id = next.operators.at(-1).id;
      for (const [key, value] of Object.entries(props)) {
        next = setOperatorProp(next, id, key, value);
      }
    }
    return addEdge(next, { fromNodeId: next.operators.at(-1).id, blockId, prop });
  };

  const runFor = (doc, steps) => {
    const { ir } = compileVfxGraph(doc);
    const runtime = createVfxRuntime(ir);
    for (let i = 0; i < steps; i += 1) step(runtime);
    return runtime;
  };

  // 1. An INIT kernel. Checked against startSize, the birth value, because the
  //    live size has already been through Size Over Life.
  const sized = wire(smoke, [['op.constant', { value: 5 }]], sizeBlock.id, 'size');
  const sizedRuntime = runFor(sized, 10);
  check('a wired Value reaches an initialize kernel',
    near(sizedRuntime.emitters[0].pool.planes.startSize[0], 5, 1e-6),
    String(sizedRuntime.emitters[0].pool.planes.startSize[0]));

  // Changing the operator changes the result - which distinguishes "the wire
  // works" from "the default happened to look right".
  const resized = setOperatorProp(sized, sized.operators[0].id, 'value', 0.25);
  check('  and follows the operator when it changes',
    near(runFor(resized, 10).emitters[0].pool.planes.startSize[0], 0.25, 1e-6));

  // 2. The SPAWN RATE path, which does not go through buildKernel at all and
  //    needed its own runOps call.
  const baseline = runFor(smoke, 60).emitters[0].pool.spawnCursor;
  const rated = wire(smoke, [['op.constant', { value: 200 }]], rateBlock.id, 'rate');
  const ratedCount = runFor(rated, 60).emitters[0].pool.spawnCursor;
  check('a wired Value reaches a spawn rate',
    ratedCount > baseline * 3 && ratedCount >= 195 && ratedCount <= 205,
    `${baseline} -> ${ratedCount} in one second`);

  // 3. The BURST path, likewise.
  const sparks = normalizeVfxDoc(templateById('sparks').build());
  const burstBlock = sparks.systems.flatMap((sys) => sys.contexts.flatMap((c) => c.blocks))
    .find((b) => b.type === 'spawn.burst');
  const bursted = wire(sparks, [['op.constant', { value: 7 }]], burstBlock.id, 'count');
  check('a wired Value reaches a burst count',
    runFor(bursted, 10).emitters[0].pool.spawnCursor === 7,
    String(runFor(bursted, 10).emitters[0].pool.spawnCursor));

  // --- a CHAIN, which is what registers are for -------------------------
  // Value(3) -> Multiply(b = 4) -> size. This is the case a single-op test
  // cannot cover: the second op has to read the register the first one wrote,
  // in the order the compiler's topological sort put them.
  let chained = addOperator(smoke, 'op.constant');
  const valueId = chained.operators.at(-1).id;
  chained = setOperatorProp(chained, valueId, 'value', 3);
  chained = addOperator(chained, 'op.multiply');
  const mulId = chained.operators.at(-1).id;
  chained = setOperatorProp(chained, mulId, 'b', 4);
  chained = normalizeVfxDoc({
    ...chained,
    edges: [...chained.edges, { from: { nodeId: valueId, port: 'out' }, to: { nodeId: mulId, port: 'a' } }],
  });
  chained = addEdge(chained, { fromNodeId: mulId, blockId: sizeBlock.id, prop: 'size' });
  check('a chain of operators evaluates in order',
    near(runFor(chained, 10).emitters[0].pool.planes.startSize[0], 12, 1e-6),
    String(runFor(chained, 10).emitters[0].pool.planes.startSize[0]));

  // --- the arithmetic ----------------------------------------------------
  // Each operator checked against a known answer rather than against itself.
  const cases = [
    ['op.add', { a: 2, b: 3 }, 5],
    ['op.subtract', { a: 7, b: 2 }, 5],
    ['op.multiply', { a: 2.5, b: 4 }, 10],
    ['op.divide', { a: 9, b: 3 }, 3],
    // Zero rather than Infinity: an infinity in a particle position turns the
    // system to NaN a frame later, which is far harder to diagnose.
    ['op.divide', { a: 9, b: 0 }, 0],
    ['op.lerp', { a: 10, b: 20, t: 0.25 }, 12.5],
    ['op.clamp', { value: 50, min: 0, max: 8 }, 8],
    ['op.clamp', { value: -50, min: 0, max: 8 }, 0],
    ['op.remap', { value: 0.5, inMin: 0, inMax: 1, outMin: 100, outMax: 200 }, 150],
    // A collapsed input range maps to the low end rather than dividing by zero.
    ['op.remap', { value: 0.5, inMin: 1, inMax: 1, outMin: 100, outMax: 200 }, 100],
    ['op.sine', { phase: 0.25 }, 1],
  ];
  const wrong = [];
  for (const [type, props, expected] of cases) {
    const doc = wire(smoke, [[type, props]], sizeBlock.id, 'size');
    const got = runFor(doc, 10).emitters[0].pool.planes.startSize[0];
    if (!near(got, expected, 1e-5)) {
      wrong.push(`${type}(${JSON.stringify(props)}) = ${got}, want ${expected}`);
    }
  }
  check('every operator computes the right answer', wrong.length === 0, wrong.join('; '));

  // op.random is deterministic for a given seed - the whole premise of
  // vfx/random.js - so the same effect run twice draws the same number.
  const randomDoc = wire(smoke, [['op.random', { min: 10, max: 20 }]], sizeBlock.id, 'size');
  const a = runFor(randomDoc, 10).emitters[0].pool.planes.startSize[0];
  const b = runFor(randomDoc, 10).emitters[0].pool.planes.startSize[0];
  check('op.random is reproducible', near(a, b, 1e-9), `${a} vs ${b}`);
  check('  and inside its range', a >= 10 && a <= 20, String(a));

  // op.time changes between frames, which is the case that rules out hoisting
  // the ops to build time.
  //
  // Read as the SPREAD of birth times across the pool, not as particle 0's.
  // Particle 0 was born in the first frame, so its birth time is ~0.017 however
  // long the simulation runs - the first version of this check compared 0.017
  // against 0.017 and called it a failure of the operator rather than of the
  // measurement.
  const timeDoc = wire(smoke, [['op.time', {}]], sizeBlock.id, 'size');
  const timed = runFor(timeDoc, 55).emitters[0].pool;
  let earliest = Infinity;
  let latest = -Infinity;
  for (let i = 0; i < timed.count; i += 1) {
    const born = timed.planes.startSize[i];
    if (born < earliest) earliest = born;
    if (born > latest) latest = born;
  }
  check('op.time advances with the simulation', latest > earliest + 0.5,
    `birth times span ${earliest.toFixed(3)} to ${latest.toFixed(3)} over ${timed.count} particles`);
}

// ---------------------------------------------------------------------------
console.log('\n--- The phase-8 kernels, against closed-form answers ---');
// ---------------------------------------------------------------------------
//
// Each of these is checked against arithmetic done by hand, never against the
// kernel's own output. A kernel that is self-consistently wrong - a spread that
// concentrates down its axis, a bounce that sinks - passes any test written by
// running it and recording what happened.
{
  const burstOf = (count) => [blk('spawn.burst', { count: constValue(count) })];
  const runSteps = (spec, steps) => {
    const { runtime } = build(spec);
    for (let i = 0; i < steps; i += 1) step(runtime);
    return runtime.emitters[0].pool;
  };

  // --- shape.position.box -------------------------------------------------
  {
    const pool = runSteps({
      spawn: burstOf(400),
      init: [...inertInit(), blk('initialize.positionBox', { size: constValue([4, 2, 6]) })],
    }, 1);
    let outside = 0;
    let sumX = 0;
    for (let i = 0; i < pool.count; i += 1) {
      const o = i * 3;
      const x = pool.planes.position[o];
      const y = pool.planes.position[o + 1];
      const z = pool.planes.position[o + 2];
      if (Math.abs(x) > 2 + 1e-6 || Math.abs(y) > 1 + 1e-6 || Math.abs(z) > 3 + 1e-6) outside += 1;
      sumX += x;
    }
    check('box emission stays inside the box', outside === 0, `${outside} of ${pool.count} outside`);
    // CENTRED, not corner-anchored: resizing a box emitter must not also move
    // the effect. With 400 samples the mean is within ~0.15 of zero.
    check('  and is centred on the origin', Math.abs(sumX / pool.count) < 0.2,
      `mean x ${(sumX / pool.count).toFixed(4)}`);
  }

  // --- shape.position.circle ---------------------------------------------
  {
    const pool = runSteps({
      spawn: burstOf(300),
      init: [...inertInit(), blk('initialize.positionCircle', {
        radius: constValue(2),
        thickness: constValue(0.5),
      })],
    }, 1);
    let bad = 0;
    let offPlane = 0;
    for (let i = 0; i < pool.count; i += 1) {
      const o = i * 3;
      const r = Math.hypot(pool.planes.position[o], pool.planes.position[o + 2]);
      if (r < 1.5 - 1e-5 || r > 2 + 1e-5) bad += 1;
      if (Math.abs(pool.planes.position[o + 1]) > 1e-9) offPlane += 1;
    }
    check('ring emission stays within the band', bad === 0, `${bad} of ${pool.count} outside 1.5..2`);
    // XZ, because Y is up everywhere else in this runtime and a ring emitter is
    // nearly always flat on the ground.
    check('  and lies flat in the XZ plane', offPlane === 0, `${offPlane} off plane`);
  }

  // --- vel.radial ---------------------------------------------------------
  {
    const pool = runSteps({
      spawn: burstOf(200),
      init: [
        ...inertInit(),
        blk('initialize.positionSphere', { radius: constValue(1) }, { fill: 'surface' }),
        blk('initialize.velocityRadial', { speed: constValue(3) }),
      ],
    }, 1);
    let wrongSpeed = 0;
    let notParallel = 0;
    for (let i = 0; i < pool.count; i += 1) {
      const o = i * 3;
      const px = pool.planes.position[o];
      const py = pool.planes.position[o + 1];
      const pz = pool.planes.position[o + 2];
      const vx = pool.planes.velocity[o];
      const vy = pool.planes.velocity[o + 1];
      const vz = pool.planes.velocity[o + 2];
      if (!near(Math.hypot(vx, vy, vz), 3, 1e-4)) wrongSpeed += 1;
      // Parallel to the offset from the origin: the cross product vanishes.
      const cross = Math.hypot(py * vz - pz * vy, pz * vx - px * vz, px * vy - py * vx);
      if (cross > 1e-4) notParallel += 1;
    }
    check('outward velocity has the requested speed', wrongSpeed === 0, `${wrongSpeed} wrong`);
    check('  and points directly away from the origin', notParallel === 0, `${notParallel} not parallel`);

    // A particle AT the origin has no direction to derive, and must not end up
    // motionless - a burst from a point emitter would otherwise sit still.
    const atOrigin = runSteps({
      spawn: burstOf(50),
      init: [...inertInit(), blk('initialize.velocityRadial', { speed: constValue(3) })],
    }, 1);
    let still = 0;
    for (let i = 0; i < atOrigin.count; i += 1) {
      const o = i * 3;
      if (Math.hypot(atOrigin.planes.velocity[o], atOrigin.planes.velocity[o + 1],
        atOrigin.planes.velocity[o + 2]) < 1e-6) still += 1;
    }
    check('  and a particle at the origin still gets a direction', still === 0,
      `${still} of ${atOrigin.count} motionless`);
  }

  // --- vel.direction ------------------------------------------------------
  {
    // Spread 0 is exact: direction times speed, no randomness at all.
    const exact = runSteps({
      spawn: burstOf(20),
      init: [...inertInit(), blk('initialize.velocityDirection', {
        direction: constValue([0, -1, 0]),
        speed: constValue(8),
        spread: constValue(0),
      })],
    }, 1);
    check('a zero spread gives exactly direction times speed',
      near(exact.planes.velocity[0], 0, 1e-6)
      && near(exact.planes.velocity[1], -8, 1e-6)
      && near(exact.planes.velocity[2], 0, 1e-6),
      Array.from(exact.planes.velocity.slice(0, 3)).map((v) => v.toFixed(4)).join(','));

    // A 20-degree spread must keep every particle inside 20 degrees, AND must
    // actually use the cone rather than collapsing onto the axis. The second
    // half is the one that catches an even-in-angle draw, which concentrates
    // particles down the axis and makes a wide spread look narrow.
    const spread = runSteps({
      spawn: burstOf(400),
      init: [...inertInit(), blk('initialize.velocityDirection', {
        direction: constValue([0, -1, 0]),
        speed: constValue(8),
        spread: constValue(20),
      })],
    }, 1);
    let outsideCone = 0;
    let sumAngle = 0;
    for (let i = 0; i < spread.count; i += 1) {
      const o = i * 3;
      const vx = spread.planes.velocity[o];
      const vy = spread.planes.velocity[o + 1];
      const vz = spread.planes.velocity[o + 2];
      const length = Math.hypot(vx, vy, vz) || 1;
      // Angle from the -Y axis.
      const angle = Math.acos(Math.min(1, Math.max(-1, -vy / length))) * (180 / Math.PI);
      if (angle > 20 + 1e-3) outsideCone += 1;
      sumAngle += angle;
    }
    check('every particle stays inside the spread cone', outsideCone === 0,
      `${outsideCone} of ${spread.count} outside 20 degrees`);
    // Even over the SOLID angle puts the mean at about 2/3 of the half-angle
    // (13.3 for 20). Even over the angle itself would put it at half (10).
    const meanAngle = sumAngle / spread.count;
    check('  spread evenly over the cone, not over the angle',
      meanAngle > 11.5 && meanAngle < 15, `mean angle ${meanAngle.toFixed(2)} deg, want ~13.3`);
  }

  // --- force.attract ------------------------------------------------------
  {
    // One particle at the origin, an attractor 2m up. It has to move UP.
    const pulled = runSteps({
      spawn: burstOf(1),
      init: inertInit(),
      update: [blk('update.attractor', {
        position: constValue([0, 2, 0]),
        strength: constValue(10),
        radius: constValue(10),
      })],
    }, 30);
    check('an attractor pulls towards its point', pulled.planes.position[1] > 0.05,
      `y ${pulled.planes.position[1].toFixed(4)}`);
    // Negative strength pushes - stated in the block's hint, so it has to be true.
    const pushed = runSteps({
      spawn: burstOf(1),
      init: inertInit(),
      update: [blk('update.attractor', {
        position: constValue([0, 2, 0]),
        strength: constValue(-10),
        radius: constValue(10),
      })],
    }, 30);
    check('  and a negative strength pushes away', pushed.planes.position[1] < -0.05,
      `y ${pushed.planes.position[1].toFixed(4)}`);
  }

  // --- force.vortex -------------------------------------------------------
  {
    const pool = runSteps({
      spawn: burstOf(1),
      init: [...inertInit(), blk('initialize.positionCircle', {
        radius: constValue(2),
        thickness: constValue(0),
      })],
      update: [blk('update.vortex', {
        position: constValue([0, 0, 0]),
        axis: constValue([0, 1, 0]),
        strength: constValue(3),
        inward: constValue(2),
      })],
    }, 30);
    const x = pool.planes.position[0];
    const z = pool.planes.position[2];
    // The inward pull is the half that makes a vortex read as one rather than
    // as a widening spiral, so the radius must SHRINK.
    check('a vortex pulls its particles inward', Math.hypot(x, z) < 2,
      `radius ${Math.hypot(x, z).toFixed(4)} from 2`);
    // And it has to be rotating: the velocity is not purely radial.
    const vx = pool.planes.velocity[0];
    const vz = pool.planes.velocity[2];
    const radial = (x * vx + z * vz) / (Math.hypot(x, z) || 1);
    const tangential = Math.abs(x * vz - z * vx) / (Math.hypot(x, z) || 1);
    check('  while also swirling around the axis', tangential > Math.abs(radial) * 0.2,
      `tangential ${tangential.toFixed(3)} vs radial ${radial.toFixed(3)}`);
  }

  // --- vel.limit ----------------------------------------------------------
  {
    const pool = runSteps({
      spawn: burstOf(30),
      init: [...inertInit(), blk('initialize.velocityDirection', {
        direction: constValue([0, -1, 0]),
        speed: constValue(50),
        spread: constValue(0),
      })],
      update: [
        blk('update.gravity', { gravity: constValue([0, -100, 0]) }),
        blk('update.speedLimit', { speed: constValue(4) }),
      ],
    }, 30);
    let over = 0;
    for (let i = 0; i < pool.count; i += 1) {
      const o = i * 3;
      if (Math.hypot(pool.planes.velocity[o], pool.planes.velocity[o + 1],
        pool.planes.velocity[o + 2]) > 4 + 1e-3) over += 1;
    }
    check('a speed limit holds against stacked forces', over === 0,
      `${over} of ${pool.count} over the cap`);
  }

  // --- rot.spin -----------------------------------------------------------
  {
    // 90 deg/s for 60 steps of 1/60s is exactly a quarter turn.
    const pool = runSteps({
      spawn: burstOf(1),
      init: [...inertInit(), blk('initialize.setRotation', { rotation: constValue(0) })],
      update: [blk('update.spin', { speed: constValue(90) })],
    }, 60);
    check('spin turns at the rate it says',
      near(pool.planes.rotation[0], Math.PI / 2, 2e-2),
      `${pool.planes.rotation[0].toFixed(4)} rad, want ${(Math.PI / 2).toFixed(4)}`);
  }

  // --- collide.plane ------------------------------------------------------
  {
    const dropped = (bounce) => runSteps({
      spawn: burstOf(1),
      init: [
        ...inertInit(),
        blk('initialize.positionBox', { size: constValue([0, 0, 0]) }),
        blk('initialize.velocityDirection', {
          direction: constValue([0, -1, 0]),
          speed: constValue(5),
          spread: constValue(0),
        }),
      ],
      update: [
        blk('update.gravity', { gravity: constValue([0, -9.81, 0]) }),
        blk('update.collidePlane', {
          height: constValue(0),
          bounce: constValue(bounce),
          friction: constValue(0),
        }),
      ],
    }, 120);

    // Bounce 0: it settles on the floor and stays there. THE FAILURE THIS
    // CATCHES is correcting only the velocity - the particle then spends every
    // frame below the plane, never climbs out, and sinks while jittering.
    const stuck = dropped(0);
    check('a zero bounce settles the particle on the floor',
      near(stuck.planes.position[1], 0, 1e-3) && Math.abs(stuck.planes.velocity[1]) < 1e-3,
      `y ${stuck.planes.position[1].toExponential(2)}, vy ${stuck.planes.velocity[1].toExponential(2)}`);
    // And it must never end up BELOW the plane, which is the sinking failure.
    check('  and never below it', stuck.planes.position[1] >= -1e-6,
      String(stuck.planes.position[1]));

    // Bounce 1 keeps it moving: a lossless bounce against gravity is a
    // particle that is still going after two seconds.
    const bouncy = dropped(1);
    check('a full bounce keeps the particle moving',
      Math.abs(bouncy.planes.velocity[1]) > 1,
      `vy ${bouncy.planes.velocity[1].toFixed(3)}`);
  }

  // --- kill.bounds --------------------------------------------------------
  {
    const pool = runSteps({
      spawn: burstOf(20),
      init: [
        ...inertInit(),
        blk('initialize.velocityDirection', {
          direction: constValue([0, -1, 0]),
          speed: constValue(20),
          spread: constValue(0),
        }),
      ],
      update: [blk('update.killOnBounds', { size: constValue([4, 4, 4]) })],
    }, 60);
    // At 20 m/s downward they leave a 2m half-height box in a tenth of a
    // second, so after a full second none can be left - even though their
    // lifetime is 10s.
    check('particles leaving the box are collected', pool.count === 0,
      `${pool.count} still alive after a second`);

    // And a particle that stays inside is NOT killed, or the block would be a
    // way to delete an effect rather than to bound it.
    const inside = runSteps({
      spawn: burstOf(20),
      init: inertInit(),
      update: [blk('update.killOnBounds', { size: constValue([4, 4, 4]) })],
    }, 60);
    check('  while the ones inside are left alone', inside.count === 20,
      `${inside.count} of 20`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- Sub-emitters and the event queue ---');
// ---------------------------------------------------------------------------
//
// A spark that dies becomes a puff of smoke. Checked against counted
// arithmetic rather than against the queue's own output, because a queue that
// drops half its records, or spawns from the previous frame, or reads a payload
// after the pool has been compacted, is self-consistent in all three cases.
{
  const runFor = (doc, steps) => {
    const { ir, diagnostics } = compileVfxGraph(doc, { assetIndex: new Set([118, 119]) });
    const errors = diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) throw new Error(errors.map((d) => d.code).join(' '));
    const runtime = createVfxRuntime(ir);
    for (let i = 0; i < steps; i += 1) step(runtime);
    return { ir, runtime };
  };
  const poolFor = (runtime, name) => runtime.emitters.find((e) => e.name === name).pool;

  // The parent bursts 8 with a 0.2s lifetime (12 steps); the child spawns 3 per
  // death. So after 20 steps every parent has died and exactly 24 children
  // exist - a number that is wrong if any record is dropped, double-counted, or
  // consumed on a later frame.
  const { runtime } = runFor(fixtures.subEmitter(), 20);
  const parent = poolFor(runtime, 'Sparks');
  const child = poolFor(runtime, 'Puffs');
  check('every parent particle has died', parent.count === 0, String(parent.count));
  check('  and each death spawned exactly the burst count',
    child.spawnCursor === 24, `${child.spawnCursor}, want 8 x 3`);
  check('  with none dropped', runtimeStats(runtime).eventsDropped === 0);

  // WHERE, not just how many. A child at the origin means the payload was read
  // after swapRemove had already overwritten the slot - the single most likely
  // way to get this wrong, and one that looks like the events are firing in the
  // wrong place rather than being read at the wrong moment.
  let atOrigin = 0;
  for (let i = 0; i < child.count; i += 1) {
    const o = i * 3;
    if (Math.hypot(child.planes.position[o], child.planes.position[o + 1],
      child.planes.position[o + 2]) < 1e-6) atOrigin += 1;
  }
  check('children appear where their parent died, not at the origin',
    atOrigin === 0, `${atOrigin} of ${child.count} at the origin`);

  // SAME-FRAME, not next-frame. The compiler orders parents before children and
  // each drains its channel during its own spawn, so a death recorded in step N
  // produces a child in step N. A one-frame lag would be invisible here but
  // compounds down a chain - three levels would lag an impact by three frames.
  const fresh = compileVfxGraph(fixtures.subEmitter(), { assetIndex: new Set([118, 119]) });
  const single = createVfxRuntime(fresh.ir);
  let firstDeathStep = -1;
  let firstChildStep = -1;
  for (let i = 0; i < 20; i += 1) {
    const before = poolFor(single, 'Sparks').count;
    step(single);
    const after = poolFor(single, 'Sparks').count;
    if (firstDeathStep < 0 && after < before) firstDeathStep = i;
    if (firstChildStep < 0 && poolFor(single, 'Puffs').spawnCursor > 0) firstChildStep = i;
  }
  check('a child is born on the same step its parent died',
    firstDeathStep >= 0 && firstChildStep === firstDeathStep,
    `death on step ${firstDeathStep}, child on step ${firstChildStep}`);

  // The queue must not spawn twice from one record.
  const twice = compileVfxGraph(fixtures.subEmitter(), { assetIndex: new Set([118, 119]) });
  const twiceRuntime = createVfxRuntime(twice.ir);
  for (let i = 0; i < 40; i += 1) step(twiceRuntime);
  check('  and never twice from one death',
    poolFor(twiceRuntime, 'Puffs').spawnCursor === 24,
    String(poolFor(twiceRuntime, 'Puffs').spawnCursor));

  // Determinism, which the whole seeding scheme exists for: a child's randoms
  // are hashed from its PARENT'S seed, so a replay reproduces the sub-emitter
  // as well as the emitter.
  const a = runFor(fixtures.subEmitter(), 20);
  const b = runFor(fixtures.subEmitter(), 20);
  check('a sub-emitter replays identically',
    poolChecksum(poolFor(a.runtime, 'Puffs')) === poolChecksum(poolFor(b.runtime, 'Puffs')));

  // Inherit Velocity is what makes a sub-emitter look attached. At 0.25 the
  // children must be moving, and slower than the parents were.
  let maxChildSpeed = 0;
  for (let i = 0; i < child.count; i += 1) {
    const o = i * 3;
    const speed = Math.hypot(child.planes.velocity[o], child.planes.velocity[o + 1],
      child.planes.velocity[o + 2]);
    if (speed > maxChildSpeed) maxChildSpeed = speed;
  }
  check('inherited velocity is present and scaled down',
    maxChildSpeed > 0.01 && maxChildSpeed < 3,
    `fastest child ${maxChildSpeed.toFixed(3)} m/s`);

  // A sub-emitter must NOT also fire its own clips. Doing both is the "why is
  // there a puff of smoke at the world origin" bug, and it is invisible in an
  // effect whose parent happens to start at the origin too.
  const clipped = fixtures.subEmitter();
  clipped.systems[1].schedule = { clips: [{ id: 'c', at: 0, duration: 0, loop: false }] };
  const { runtime: clippedRuntime } = runFor(clipped, 3);
  check('a sub-emitter ignores its own timeline clips',
    poolFor(clippedRuntime, 'Puffs').spawnCursor === 0,
    `${poolFor(clippedRuntime, 'Puffs').spawnCursor} spawned before any parent died`);

  // Collision events, the other trigger. A parent bouncing off the floor should
  // raise them.
  const collideDoc = fixtures.subEmitter();
  collideDoc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE).blocks.push({
    id: 'floor', type: 'update.collidePlane', enabled: true,
    props: { height: constValue(-0.05), bounce: constValue(0.4), friction: constValue(0.1) },
  });
  collideDoc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE).blocks
    .find((b) => b.type === 'initialize.setLifetime').props.lifetime = constValue(5);
  collideDoc.systems[1].contexts[0].params.trigger = 'onCollide';
  const { runtime: collideRuntime } = runFor(normalizeVfxDoc(collideDoc), 40);
  check('a collision raises events too',
    poolFor(collideRuntime, 'Puffs').spawnCursor > 0,
    `${poolFor(collideRuntime, 'Puffs').spawnCursor} children from floor hits`);

  // Probability thins the events rather than the children: "a quarter of the
  // sparks make a puff" is what an author means.
  const thinned = fixtures.subEmitter();
  thinned.systems[1].contexts[0].params.probability = '0.5';
  const { runtime: thinnedRuntime } = runFor(normalizeVfxDoc(thinned), 20);
  const thinnedCount = poolFor(thinnedRuntime, 'Puffs').spawnCursor;
  // Every child of one event is spawned or none is, so the total must be a
  // multiple of the burst count - which is what distinguishes rolling per event
  // from rolling per child.
  check('probability is rolled per event, not per particle',
    thinnedCount % 3 === 0 && thinnedCount < 24 && thinnedCount > 0,
    `${thinnedCount} children, a multiple of the burst count 3`);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
