// The VFX runtime benchmark. Run it directly:
//
//     node src/utils/vfx/bench.mjs
//
// This is the measurement the whole feature was staked on. The plan committed
// to a CPU simulation with GPU rendering over a GPU-simulated design, on the
// argument that CPU keeps every module type available (collision, mesh
// sampling, sub-emitters, arbitrary sampling) and stays closest to what the
// engines actually run - and that it would fit in the frame budget. Phases 1
// to 3 deliver no pixels precisely so that this number arrives before anything
// is built on top of it.
//
// The budget: 16.67 ms is a 60fps frame, and the effect should own no more
// than about 6 ms of it, leaving room for React, the node board and the gizmo.
//
// TWO NUMBERS, NOT ONE. Profiling costs two performance.now() calls per kernel
// per frame, and that overhead would be attributed to the kernels themselves.
// So the honest total is measured with profiling OFF, and the attribution is a
// separate run with it ON. They are different measurements and conflating them
// would flatter the result.
//
// Re-run this after touching anything under src/utils/vfx/. It is also the
// place to check a new block's cost before shipping it: a block that doubles
// the frame time is a product decision, not just an implementation one.
import { compileVfxGraph } from '../../../vfx/compile.js';
import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc } from '../../../vfx/doc.js';
import { CURVE_PRESETS } from '../../../vfx/curve.js';
import { GRADIENT_PRESETS } from '../../../vfx/gradient.js';
import { constValue, curveValue, gradientValue, randomValue } from '../../../vfx/value.js';
import { stagedExplosion } from '../../../vfx/fixtures.mjs';
import { createVfxRuntime, reset, runtimeStats, step } from './system.js';
import { poolChecksum } from './pool.js';

const FRAME_MS = 1000 / 60;

let n = 0;
const blk = (type, props, modes) => {
  const b = { id: `b${(n += 1)}`, type, enabled: true, props };
  if (modes) b.modes = modes;
  return b;
};
const preset = (list, id) => list.find((p) => p.id === id).build();

function benchDoc({ rate, lifetime, capacity, turbulence, curves }) {
  const doc = createEmptyVfxDoc({ name: 'Bench' });
  // Duration 0 so the effect never ends and the bench runs as long as asked.
  doc.effect.duration = 0;
  doc.effect.loop = false;
  doc.effect.capacity = capacity;
  doc.references = { tex: { kind: 'image', ref: 'asset:1', name: 't.png', colorSpace: 'srgb' } };

  const update = [
    blk('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
    blk('update.drag', { drag: constValue(1.2) }),
  ];
  if (turbulence) {
    update.push(blk('update.turbulence', { strength: constValue(1.2), frequency: constValue(0.6) }));
  }
  if (curves) {
    update.push(blk('update.sizeOverLife', { scale: curveValue(preset(CURVE_PRESETS, 'bell'), { scale: 1.5 }) }));
    update.push(blk('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'fire')) }));
  }

  const system = doc.systems[0];
  system.capacity = capacity;
  system.contexts = [
    { id: 'c1', kind: CONTEXT_KIND.SPAWN, blocks: [blk('spawn.rate', { rate: constValue(rate) })], params: {} },
    {
      id: 'c2',
      kind: CONTEXT_KIND.INITIALIZE,
      blocks: [
        blk('initialize.setLifetime', { lifetime: randomValue(lifetime * 0.8, lifetime * 1.2) }),
        blk('initialize.setSize', { size: randomValue(0.03, 0.08) }),
        blk('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
        blk('initialize.positionSphere', { radius: constValue(0.4) }, { fill: 'volume' }),
        blk('initialize.velocityRandom', { min: constValue([-2, 1, -2]), max: constValue([2, 4, 2]) }),
      ],
      params: {},
    },
    { id: 'c3', kind: CONTEXT_KIND.UPDATE, blocks: update, params: {} },
    {
      id: 'c4',
      kind: CONTEXT_KIND.OUTPUT,
      blocks: [blk('output.setMainTexture', { texture: constValue('tex') })],
      params: { mode: 'billboard', blend: 'additive', sort: 'none' },
    },
  ];
  return normalizeVfxDoc(doc);
}

function measure(label, config, { profile = false, warmup = 90, frames = 240 } = {}) {
  const { ir, diagnostics } = compileVfxGraph(benchDoc(config), { assetIndex: new Set([1]) });
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) {
    console.log(`  ${label}: COMPILE ERRORS ${errors.map((d) => d.code).join(' ')}`);
    return null;
  }
  const runtime = createVfxRuntime(ir, { profile });

  // Warm up to steady state first: a rate emitter takes one full lifetime to
  // reach its population, and measuring during the ramp would report a cost
  // for a particle count the effect never actually runs at.
  for (let i = 0; i < warmup; i += 1) step(runtime);
  const alive = runtimeStats(runtime).alive;

  runtime.stats.reset();
  const start = performance.now();
  for (let i = 0; i < frames; i += 1) step(runtime);
  const perFrame = (performance.now() - start) / frames;

  console.log(
    `  ${label.padEnd(32)} ${String(alive).padStart(7)} alive  `
    + `${perFrame.toFixed(2).padStart(6)} ms  ${((perFrame / FRAME_MS) * 100).toFixed(0).padStart(3)}% of a frame`,
  );
  return { runtime, perFrame, alive };
}

console.log('\nVFX runtime benchmark. Budget: 16.67 ms per frame at 60fps; the');
console.log('effect should own no more than about 6 ms of it.\n');

console.log('=== Steady-state cost (profiling OFF - the honest number) ===');
measure('20k, gravity + drag', { rate: 20000, lifetime: 1, capacity: 32768 });
measure('60k, gravity + drag', { rate: 60000, lifetime: 1, capacity: 65536 });
measure('60k, + size/colour curves', { rate: 60000, lifetime: 1, capacity: 65536, curves: true });
measure('60k, + curves + turbulence', {
  rate: 60000, lifetime: 1, capacity: 65536, curves: true, turbulence: true,
});
measure('120k, + curves', { rate: 120000, lifetime: 1, capacity: 131072, curves: true });
measure('120k, + curves + turbulence', {
  rate: 120000, lifetime: 1, capacity: 131072, curves: true, turbulence: true,
});

console.log('\n=== Per-kernel attribution at 60k (profiling ON, adds overhead) ===');
const profiled = measure('60k, + curves + turbulence', {
  rate: 60000, lifetime: 1, capacity: 65536, curves: true, turbulence: true,
}, { profile: true });
if (profiled) {
  const kernels = profiled.runtime.stats.kernels();
  const total = kernels.reduce((sum, k) => sum + k.perFrameMs, 0);
  for (const kernel of kernels) {
    const share = ((kernel.perFrameMs / total) * 100).toFixed(0);
    console.log(`    ${kernel.name.padEnd(24)} ${kernel.perFrameMs.toFixed(3).padStart(6)} ms  ${share.padStart(3)}%`);
  }
}

console.log('\n=== A staged multi-system schedule spawns on the right steps ===');
{
  const { ir } = compileVfxGraph(stagedExplosion(), { assetIndex: new Set([118, 97]) });
  const runtime = createVfxRuntime(ir);
  const expected = ir.systems.map((s) => ({
    name: s.name,
    atStep: s.schedule.clips[0].atStep,
    kind: s.spawn.some((b) => b.kernel === 'spawn.burst') ? 'burst' : 'rate',
  }));
  const firstSeen = new Map();
  for (let i = 0; i < 60; i += 1) {
    step(runtime);
    for (const emitter of runtime.emitters) {
      if (!firstSeen.has(emitter.name) && emitter.pool.count > 0) firstSeen.set(emitter.name, i);
    }
  }
  for (const row of expected) {
    const seen = firstSeen.get(row.name);
    const ok = seen === row.atStep;
    console.log(
      `  ${row.name.padEnd(8)} ${row.kind.padEnd(6)} clip at step ${String(row.atStep).padStart(2)}  `
      + `first particles on step ${String(seen ?? -1).padStart(2)}  ${ok ? 'ok' : '*** MISMATCH ***'}`,
    );
  }
}

console.log('\n=== Determinism ===');
{
  const config = { rate: 20000, lifetime: 1, capacity: 32768, curves: true, turbulence: true };
  const { ir } = compileVfxGraph(benchDoc(config), { assetIndex: new Set([1]) });
  const a = createVfxRuntime(ir);
  const b = createVfxRuntime(ir);
  for (let i = 0; i < 120; i += 1) step(a);
  for (let i = 0; i < 120; i += 1) step(b);
  const checksum = poolChecksum(a.emitters[0].pool);
  console.log(`  two runtimes, 120 steps: ${checksum} / ${poolChecksum(b.emitters[0].pool)} `
    + `${checksum === poolChecksum(b.emitters[0].pool) ? 'IDENTICAL' : '*** DIVERGED ***'}`);
  reset(a);
  for (let i = 0; i < 120; i += 1) step(a);
  console.log(`  after reset and replay:   ${poolChecksum(a.emitters[0].pool) === checksum ? 'IDENTICAL' : '*** DIVERGED ***'}`);
}

console.log('\n=== Memory ===');
{
  const { ir, stats } = compileVfxGraph(
    benchDoc({ rate: 60000, lifetime: 1, capacity: 65536, curves: true }),
    { assetIndex: new Set([1]) },
  );
  const runtime = createVfxRuntime(ir);
  const pool = runtime.emitters[0].pool;
  const bytes = pool.buffer.byteLength + pool.accel.byteLength;
  console.log(`  ${stats.floatsPerParticle} floats (${stats.bytesPerParticle} B) per particle`);
  console.log(`  ${(bytes / 1048576).toFixed(2)} MB pool at ${pool.capacity.toLocaleString('en-US')} capacity`);
  console.log(`  attributes: ${ir.attributes.map((a) => a.name).join(' ')}`);
}
console.log();
