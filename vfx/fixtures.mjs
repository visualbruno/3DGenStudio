// Test and development fixtures: VFX documents built by hand, for the compiler
// and (from phase 3) the runtime to be checked against.
//
// These are NOT the shipped effect templates - those live in the editor and are
// authored to look good. These are built to exercise specific machinery, so
// each one names what it is for. Kept as a .mjs sibling of the tests rather
// than in a test file, because the compiler tests and the runtime tests need
// the same documents and duplicating them would let the two drift.
import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc } from './doc.js';
import { CURVE_PRESETS } from './curve.js';
import { GRADIENT_PRESETS } from './gradient.js';
import { constValue, curveValue, gradientValue, randomValue } from './value.js';

const preset = (list, id) => list.find((p) => p.id === id).build();

let seq = 0;
const bid = (name) => `b-${name}-${(seq += 1)}`;

/** A block, with props given as plain values or VfxValues. */
function block(type, props = {}, modes = undefined) {
  const entry = { id: bid(type.split('.').pop()), type, enabled: true, props };
  if (modes) entry.modes = modes;
  return entry;
}

/**
 * Assemble a system from stacks per stage.
 *
 * @param {Object} spec
 * @returns {Object} a document-shaped system
 */
function system(spec) {
  const contexts = [];
  contexts.push({ id: `c-spawn-${(seq += 1)}`, kind: CONTEXT_KIND.SPAWN, blocks: spec.spawn || [], params: {} });
  contexts.push({ id: `c-init-${(seq += 1)}`, kind: CONTEXT_KIND.INITIALIZE, blocks: spec.init || [], params: {} });
  if (spec.update) {
    contexts.push({ id: `c-update-${(seq += 1)}`, kind: CONTEXT_KIND.UPDATE, blocks: spec.update, params: spec.updateParams || {} });
  }
  for (const output of spec.outputs || []) {
    contexts.push({
      id: `c-out-${(seq += 1)}`,
      kind: CONTEXT_KIND.OUTPUT,
      blocks: output.blocks || [],
      params: output.params || {},
    });
  }
  return {
    id: spec.id || `s-${(seq += 1)}`,
    name: spec.name || 'System',
    enabled: true,
    capacity: spec.capacity ?? 1024,
    simulationSpace: 'inherit',
    contexts,
    schedule: spec.schedule ? { clips: spec.schedule } : undefined,
  };
}

/**
 * A minimal spark burst that compiles with no errors and no warnings.
 *
 * This is the baseline: if this ever produces a diagnostic, either the
 * diagnostic is wrong or the catalog defaults are. It is deliberately the
 * smallest thing that is genuinely complete - burst, lifetime, size, colour,
 * shape, velocity, gravity, a fade, and a textured output.
 */
export function sparkBurst() {
  const doc = createEmptyVfxDoc({ name: 'Spark Burst' });
  doc.effect.duration = 1.5;
  doc.effect.loop = false;
  doc.references = {
    tex_spark: { kind: 'image', ref: 'asset:118', name: 'spark.png', colorSpace: 'srgb' },
  };
  doc.systems = [system({
    name: 'Sparks',
    capacity: 256,
    spawn: [block('spawn.burst', { count: constValue(60) })],
    init: [
      block('initialize.setLifetime', { lifetime: randomValue(0.25, 0.6) }),
      block('initialize.setSize', { size: randomValue(0.03, 0.07) }),
      block('initialize.setColor', { color: constValue([3, 1.6, 0.6, 1]) }),
      block('initialize.positionSphere', { radius: constValue(0.05) }, { fill: 'volume' }),
      block('initialize.velocityRandom', {
        min: constValue([-3, 1, -3]),
        max: constValue([3, 5, 3]),
      }),
    ],
    update: [
      block('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
      block('update.drag', { drag: constValue(1.2) }),
      block('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'ember')) }),
    ],
    outputs: [{
      params: { mode: 'stretched', blend: 'additive', sort: 'none' },
      blocks: [block('output.setMainTexture', { texture: constValue('tex_spark') })],
    }],
  })];
  return normalizeVfxDoc(doc);
}

/**
 * A staged multi-system explosion: flash, sparks, smoke, with timeline clips
 * at different times and a looping track.
 *
 * Exercises the schedule lowering, multiple outputs with different blends,
 * curves and gradients in the same effect, and the turbulence block (which is
 * 'approx' on Niagara, so it is what makes the engine-fidelity diagnostics
 * fire on a real catalog entry rather than a synthetic one).
 */
export function stagedExplosion() {
  const doc = createEmptyVfxDoc({ name: 'Explosion' });
  doc.effect.duration = 2.5;
  doc.effect.loop = false;
  doc.effect.capacity = 8192;
  doc.references = {
    tex_flash: { kind: 'image', ref: 'asset:118', name: 'flash.png', colorSpace: 'srgb' },
    tex_smoke: { kind: 'image', ref: 'asset:97', name: 'smoke.png', colorSpace: 'srgb' },
  };
  doc.systems = [
    system({
      name: 'Flash',
      capacity: 32,
      schedule: [{ at: 0, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(4) })],
      init: [
        block('initialize.setLifetime', { lifetime: constValue(0.12) }),
        block('initialize.setSize', { size: constValue(2.4) }),
        block('initialize.setColor', { color: constValue([6, 5, 3.5, 1]) }),
      ],
      update: [
        block('update.sizeOverLife', { scale: curveValue(preset(CURVE_PRESETS, 'spike')) }),
        block('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'fire')) }),
      ],
      outputs: [{
        params: { mode: 'billboard', blend: 'additive', sort: 'none' },
        blocks: [block('output.setMainTexture', { texture: constValue('tex_flash') })],
      }],
    }),
    system({
      name: 'Sparks',
      capacity: 512,
      schedule: [{ at: 0.02, duration: 0, loop: false }],
      spawn: [block('spawn.burst', { count: constValue(120) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(0.3, 0.9) }),
        block('initialize.setSize', { size: randomValue(0.02, 0.06) }),
        block('initialize.setColor', { color: constValue([4, 2, 0.7, 1]) }),
        block('initialize.velocityRandom', { min: constValue([-6, -1, -6]), max: constValue([6, 8, 6]) }),
      ],
      update: [
        block('update.gravity', { gravity: constValue([0, -9.8, 0]) }),
        block('update.drag', { drag: constValue(0.8) }),
        block('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'ember')) }),
      ],
      outputs: [{
        params: { mode: 'stretched', blend: 'additive', sort: 'none' },
        blocks: [block('output.setMainTexture', { texture: constValue('tex_flash') })],
      }],
    }),
    system({
      name: 'Smoke',
      capacity: 2048,
      // Two clips on one track: a puff at 0.05 and a second wave at 0.6, both
      // timed windows - which is the case that cannot round-trip into an
      // engine and must raise W_SCHEDULE_UNEXPORTABLE.
      schedule: [
        { at: 0.05, duration: 0.4, loop: false },
        { at: 0.6, duration: 1.2, loop: false },
      ],
      spawn: [block('spawn.rate', { rate: constValue(120) })],
      init: [
        block('initialize.setLifetime', { lifetime: randomValue(2, 4) }),
        block('initialize.setSize', { size: randomValue(0.8, 1.6) }),
        block('initialize.setColor', { color: constValue([0.35, 0.33, 0.31, 1]) }),
        block('initialize.positionSphere', { radius: constValue(0.6) }, { fill: 'volume' }),
        block('initialize.velocityRandom', { min: constValue([-0.6, 0.4, -0.6]), max: constValue([0.6, 1.6, 0.6]) }),
      ],
      update: [
        block('update.gravity', { gravity: constValue([0, 0.35, 0]) }),
        block('update.drag', { drag: constValue(1.6) }),
        block('update.turbulence', { strength: constValue(0.8), frequency: constValue(0.5) }),
        block('update.sizeOverLife', { scale: curveValue(preset(CURVE_PRESETS, 'rampUp'), { scale: 2.2 }) }),
        block('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'smoke')) }),
      ],
      outputs: [{
        params: { mode: 'billboard', blend: 'alpha', sort: 'depth' },
        blocks: [block('output.setMainTexture', { texture: constValue('tex_smoke') })],
      }],
    }),
  ];
  return normalizeVfxDoc(doc);
}

/**
 * An effect wired with operator nodes: one shared Value feeding two properties
 * through a Multiply, plus an Effect Time node driving a spawn rate.
 *
 * Exercises the topological sort, frequency propagation through 'inherit',
 * expression lowering into registers, and the register count.
 */
export function operatorWired() {
  const doc = createEmptyVfxDoc({ name: 'Operator Wired' });
  doc.references = { tex: { kind: 'image', ref: 'asset:118', name: 't.png', colorSpace: 'srgb' } };
  const sizeBlock = block('initialize.setSize', { size: constValue(0.2) });
  const dragBlock = block('update.drag', { drag: constValue(1) });
  const rateBlock = block('spawn.rate', { rate: constValue(30) });

  doc.systems = [system({
    name: 'Wired',
    capacity: 512,
    spawn: [rateBlock],
    init: [
      block('initialize.setLifetime', { lifetime: constValue(1) }),
      sizeBlock,
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    ],
    update: [dragBlock, block('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'fadeOut')) })],
    outputs: [{
      params: { mode: 'billboard', blend: 'additive', sort: 'none' },
      blocks: [block('output.setMainTexture', { texture: constValue('tex') })],
    }],
  })];

  doc.operators = [
    { id: 'op-base', type: 'op.constant', props: { value: constValue(0.4) } },
    { id: 'op-scale', type: 'op.multiply', props: { a: constValue(1), b: constValue(2.5) } },
    { id: 'op-clock', type: 'op.time', props: {} },
  ];
  doc.edges = [
    // op-base -> op-scale.a -> setSize.size, so the multiply inherits its
    // frequency from a constant and the whole subtree folds to CONST.
    { id: 'e1', from: { nodeId: 'op-base', port: 'out' }, to: { nodeId: 'op-scale', port: 'a' } },
    { id: 'e2', from: { nodeId: 'op-scale', port: 'out' }, to: { blockId: sizeBlock.id, prop: 'size' } },
    // The same Value also drives drag directly - one node, two consumers.
    { id: 'e3', from: { nodeId: 'op-base', port: 'out' }, to: { blockId: dragBlock.id, prop: 'drag' } },
    // Effect time is per-frame, which a spawn rate accepts.
    { id: 'e4', from: { nodeId: 'op-clock', port: 'out' }, to: { blockId: rateBlock.id, prop: 'rate' } },
  ];
  return normalizeVfxDoc(doc);
}

/**
 * Deliberately broken, one fault per diagnostic. Used to prove each code fires
 * and that a compile with errors still returns usable IR rather than throwing -
 * a broken graph must still draw a board.
 */
export function brokenEffect() {
  const doc = createEmptyVfxDoc({ name: 'Broken' });
  doc.effect.capacity = 64;
  doc.references = {
    tex_gone: { kind: 'image', ref: 'asset:999999', name: 'deleted.png', colorSpace: 'srgb' },
    tex_empty: { kind: 'image', colorSpace: 'srgb' },
  };

  const offBlock = block('update.drag', { drag: constValue(1) });
  offBlock.enabled = false;

  doc.systems = [
    // No spawn, no output, no lifetime; a gravity block in the wrong stage; a
    // block type that does not exist; a stage where everything is switched off.
    system({
      name: 'Hopeless',
      capacity: 32,
      spawn: [],
      init: [
        block('update.gravity', { gravity: constValue([0, -1, 0]) }),
        block('does.not.exist', {}),
      ],
      update: [offBlock],
      outputs: [],
    }),
    // Runs, but wrong: zero size, transparent ramp, additive on black, no
    // texture, capacity far too small, depth sorting a large count.
    system({
      name: 'Misconfigured',
      capacity: 64,
      spawn: [block('spawn.rate', { rate: constValue(9000) })],
      init: [
        block('initialize.setLifetime', { lifetime: constValue(4) }),
        block('initialize.setSize', { size: constValue(0) }),
        block('initialize.setColor', { color: constValue([0, 0, 0, 1]) }),
      ],
      update: [
        block('update.colorOverLife', {
          color: gradientValue({
            colorKeys: [{ t: 0, hex: '#050505' }],
            alphaKeys: [{ t: 0, a: 0.005 }],
          }),
        }),
      ],
      outputs: [{
        params: { mode: 'billboard', blend: 'additive', sort: 'depth' },
        blocks: [],
      }],
    }),
  ];

  // An operator wired to nothing, and a cycle between two more.
  doc.operators = [
    { id: 'op-orphan', type: 'op.constant', props: { value: constValue(1) } },
    { id: 'op-a', type: 'op.multiply', props: {} },
    { id: 'op-b', type: 'op.multiply', props: {} },
  ];
  doc.edges = [
    { id: 'c1', from: { nodeId: 'op-a', port: 'out' }, to: { nodeId: 'op-b', port: 'a' } },
    { id: 'c2', from: { nodeId: 'op-b', port: 'out' }, to: { nodeId: 'op-a', port: 'a' } },
  ];
  return normalizeVfxDoc(doc);
}

/**
 * Half-finished in the way people actually leave things: a spawn block, a
 * sprite and a size, but no lifetime and no update stage at all.
 *
 * Both of those are worth saying out loud rather than leaving the author to
 * wonder. Without a lifetime nothing dies, so the pool fills and emission
 * stops after about a second - which looks like a bug in the tool rather than
 * a missing block. And a system with no update stage is not WRONG (a static
 * decal or a single flash is exactly that), so it is an info rather than a
 * warning.
 */
export function incompleteEffect() {
  const doc = createEmptyVfxDoc({ name: 'Half Finished' });
  doc.references = { tex: { kind: 'image', ref: 'asset:118', name: 't.png', colorSpace: 'srgb' } };
  doc.systems = [system({
    name: 'Forgot Lifetime',
    capacity: 128,
    spawn: [block('spawn.rate', { rate: constValue(40) })],
    init: [
      block('initialize.setSize', { size: constValue(0.3) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    ],
    // No update stage on purpose - `system()` omits the context entirely when
    // `update` is absent, which is the state this fixture exists to produce.
    outputs: [{
      params: { mode: 'billboard', blend: 'alpha', sort: 'none' },
      blocks: [block('output.setMainTexture', { texture: constValue('tex') })],
    }],
  })];
  return normalizeVfxDoc(doc);
}

/**
 * A per-particle attribute wired into a spawn rate: the category error only
 * the frequency classification can catch, since there is no particle in scope
 * when the spawn stage runs.
 */
export function frequencyMismatch() {
  const doc = createEmptyVfxDoc({ name: 'Freq Mismatch' });
  doc.references = { tex: { kind: 'image', ref: 'asset:118', name: 't.png', colorSpace: 'srgb' } };
  const rateBlock = block('spawn.rate', { rate: constValue(50) });
  doc.systems = [system({
    name: 'Bad Wiring',
    spawn: [rateBlock],
    init: [
      block('initialize.setLifetime', { lifetime: constValue(1) }),
      block('initialize.setSize', { size: constValue(0.2) }),
      block('initialize.setColor', { color: constValue([1, 1, 1, 1]) }),
    ],
    update: [block('update.colorOverLife', { color: gradientValue(preset(GRADIENT_PRESETS, 'fadeOut')) })],
    outputs: [{
      params: { mode: 'billboard', blend: 'additive', sort: 'none' },
      blocks: [block('output.setMainTexture', { texture: constValue('tex') })],
    }],
  })];
  doc.operators = [{ id: 'op-attr', type: 'op.getAttribute', props: {}, modes: { attribute: 'normalizedAge' } }];
  doc.edges = [
    { id: 'e1', from: { nodeId: 'op-attr', port: 'out' }, to: { blockId: rateBlock.id, prop: 'rate' } },
  ];
  return normalizeVfxDoc(doc);
}
