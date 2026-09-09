// The compiler: VFX graph document in, flat IR plus diagnostics out.
//
// Pure. No React, no three.js, no I/O, no clock - so it runs identically in a
// browser tab, in the export endpoint on the server, and under
// `node vfx/compile.test.mjs`. That is the whole reason the phases below are
// testable at all, and it is why the riskiest part of the feature (does 60k
// particles fit in the frame budget?) can be answered before any pixels exist.
//
// NINE PHASES, in order. Each one exists because doing its work later, or
// merging it into a neighbour, breaks something:
//
//   0 normalize     nothing else should have to cope with a half-edited doc
//   1 structure     cheap checks first: most authoring errors are structural
//   2 topo sort     an operator's inputs must be resolved before it is
//   3 frequency     decides what is hoisted out of the per-particle loop, and
//                   catches errors the UI cannot see (a spawn rate that
//                   depends on a particle attribute is not meaningful)
//   4 bake          curves and gradients to tables, content-addressed
//   5 expressions   operator subtrees to register ops
//   6 blocks        the block stack to kernels and bindings
//   7 capacity      spawn arithmetic, so the capacity warning is KNOWN rather
//                   than guessed - this is what phase 3's folding buys
//   8 behaviour     the diagnostics that need the whole picture
//
// Phase 7 depends on phase 3 having folded constants, and phase 8 depends on
// phase 7's numbers. That ordering is the only reason the capacity warning can
// print real arithmetic instead of "capacity may be exceeded".

import { CATALOG, ENGINE_SUPPORT, PROP_TYPE, propChannels } from './catalog.js';
import { CONTEXT_KIND, normalizeVfxDoc, parseAssetRef, vfxSignature } from './doc.js';
import { createDiagnostics } from './diagnostics.js';
import {
  BINDING_SRC,
  FREQ,
  FREQ_LABEL,
  VFX_IR_FORMAT,
  createConstantPool,
  createTablePool,
  drawSlot,
  hashString,
  layoutAttributes,
} from './ir.js';
import {
  bakeCurve,
  chooseCurveSampleCount,
  curveExtent,
} from './curve.js';
import {
  bakeGradient,
  chooseGradientSampleCount,
  gradientAlphaExtent,
  gradientMeanLuminance,
} from './gradient.js';
import { RANDOM_FREQ, VALUE_MODE, normalizeValue, valueRange } from './value.js';

const ENGINE_LABEL = Object.freeze({
  unity: 'Unity VFX Graph',
  unreal: 'Unreal Niagara',
});

// The highest frequency a property in each context kind may be fed.
//
// A spawn rate is a property of the emitter, not of a particle, so feeding it
// something per-particle is a category error rather than a performance
// problem - there is no particle in scope when the spawn stage runs. Every
// other stage runs per particle, so anything goes.
const MAX_FREQ_BY_CONTEXT = Object.freeze({
  [CONTEXT_KIND.EVENT]: FREQ.PER_FRAME,
  [CONTEXT_KIND.SPAWN]: FREQ.PER_FRAME,
  [CONTEXT_KIND.INITIALIZE]: FREQ.PER_PARTICLE,
  [CONTEXT_KIND.UPDATE]: FREQ.PER_PARTICLE,
  [CONTEXT_KIND.OUTPUT]: FREQ.PER_PARTICLE,
});

// Which birth-value attribute an over-life kernel needs kept.
//
// The snapshot is a separate injected pass rather than something the setter
// blocks do, because the author can order Initialize any way they like: Set
// Size might run before or after whatever else touches size, and a setter that
// also wrote the birth copy would capture the wrong moment. One pass at the end
// of Initialize captures the finished state whatever the order.
const START_ATTRIBUTE = Object.freeze({
  size: 'startSize',
  color: 'startColor',
});

const FREQ_BY_NAME = Object.freeze({
  const: FREQ.CONST,
  uniform: FREQ.UNIFORM,
  perFrame: FREQ.PER_FRAME,
  perSpawn: FREQ.PER_SPAWN,
  perParticle: FREQ.PER_PARTICLE,
});

// The frequency of a VfxValue considered on its own, ignoring any wiring.
function valueFreq(value) {
  if (!value) return FREQ.CONST;
  switch (value.mode) {
    case VALUE_MODE.CONST: return FREQ.CONST;
    case VALUE_MODE.EXPOSED: return FREQ.UNIFORM;
    case VALUE_MODE.CURVE:
    case VALUE_MODE.GRADIENT:
      // A curve over effect time changes once a frame; over life or speed it
      // is a property of the individual particle.
      return value.domain === 'time' ? FREQ.PER_FRAME : FREQ.PER_PARTICLE;
    case VALUE_MODE.RANDOM:
      if (value.freq === RANDOM_FREQ.PER_FRAME) return FREQ.PER_FRAME;
      if (value.freq === RANDOM_FREQ.PER_SPAWN_EVENT) return FREQ.PER_SPAWN;
      return FREQ.PER_PARTICLE;
    default: return FREQ.CONST;
  }
}

// Blocks in a context, in stack order, skipping the switched-off ones. The id
// of a disabled block is deliberately preserved in the document (the undo
// history and the inspector selection both refer to it) - it is only the
// compile that ignores it.
function enabledBlocks(context) {
  return context.blocks.filter((block) => block.enabled !== false);
}

function contextsOfKind(system, kind) {
  return system.contexts.filter((context) => context.kind === kind);
}

// ---------------------------------------------------------------------------
// Phase 2: operator dependency order
// ---------------------------------------------------------------------------

// One cycle through the operator graph, for a message that names the ring
// rather than saying "a cycle exists somewhere". Highlighting the actual loop
// is the only actionable form of this error.
function findCycle(nodeIds, outgoing) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map(nodeIds.map((id) => [id, WHITE]));
  const stack = [];

  const visit = (id) => {
    colour.set(id, GREY);
    stack.push(id);
    for (const next of outgoing.get(id) || []) {
      const state = colour.get(next);
      if (state === GREY) return stack.slice(stack.indexOf(next));
      if (state === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    colour.set(id, BLACK);
    return null;
  };

  for (const id of nodeIds) {
    if (colour.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function sortOperators(doc, diag) {
  const ids = doc.operators.map((op) => op.id);
  const byId = new Map(doc.operators.map((op) => [op.id, op]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  const inDegree = new Map(ids.map((id) => [id, 0]));

  for (const edge of doc.edges) {
    // Only operator-to-operator edges affect evaluation order. An edge into a
    // block property is a consumer, not a dependency.
    if (!byId.has(edge.from.nodeId)) continue;
    if (!edge.to.nodeId || !byId.has(edge.to.nodeId)) continue;
    outgoing.get(edge.from.nodeId).push(edge.to.nodeId);
    inDegree.set(edge.to.nodeId, inDegree.get(edge.to.nodeId) + 1);
  }

  const queue = ids.filter((id) => inDegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id)) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }

  if (order.length !== ids.length) {
    const ring = findCycle(ids, outgoing) || ids.filter((id) => inDegree.get(id) > 0);
    diag.report('E_CYCLE', { nodeId: ring[0] }, { nodeIds: ring });
    // Return the acyclic prefix so the rest of the compile can still produce
    // something the editor can show. A broken wire should not blank the board.
    return { order, byId, cyclic: true };
  }
  return { order, byId, cyclic: false };
}

// ---------------------------------------------------------------------------
// Phase 3: frequency classification
// ---------------------------------------------------------------------------

function classifyOperators(doc, catalog, sorted, diag) {
  const freqById = new Map();
  // Which operator output feeds each operator input.
  const inputEdge = new Map();
  for (const edge of doc.edges) {
    if (!edge.to.nodeId || !edge.to.port) continue;
    inputEdge.set(`${edge.to.nodeId}::${edge.to.port}`, edge.from.nodeId);
  }

  for (const id of sorted.order) {
    const node = sorted.byId.get(id);
    const def = catalog.operator(node.type);
    if (!def) {
      // An unrecognised operator cannot be classified. Treat it as constant so
      // the rest of the pass proceeds; the block lowering reports it.
      freqById.set(id, FREQ.CONST);
      continue;
    }

    let freq = FREQ_BY_NAME[def.freq] ?? FREQ.CONST;
    if (def.freq === 'inherit') {
      freq = FREQ.CONST;
      for (const prop of Object.keys(def.props || {})) {
        const upstream = inputEdge.get(`${id}::${prop}`);
        const own = upstream !== undefined
          ? (freqById.get(upstream) ?? FREQ.CONST)
          : valueFreq(node.props[prop]);
        if (own > freq) freq = own;
      }
    }
    freqById.set(id, freq);
  }

  // An operator wired to nothing is dead weight and almost always a leftover.
  const consumed = new Set();
  for (const edge of doc.edges) {
    if (sorted.byId.has(edge.from.nodeId)) consumed.add(edge.from.nodeId);
  }
  for (const node of doc.operators) {
    if (consumed.has(node.id)) continue;
    const def = catalog.operator(node.type);
    diag.report('W_UNCONNECTED_OP', { nodeId: node.id }, { label: def?.label || node.type });
  }

  return freqById;
}

// ---------------------------------------------------------------------------
// Phase 5: expression lowering
// ---------------------------------------------------------------------------

// Lower the operator subtree feeding one block property into a list of ops
// over a small register file, and return the register holding the result.
//
// Registers are allocated per block: a block's `pre` ops run, the kernel
// consumes them, and the next block starts over. That keeps the file tiny (a
// handful of slots) and means one module-level scratch array serves every
// emitter, which is the zero-allocation style src/utils/meshSculpt.js
// established.
function lowerOperatorTree(rootId, ctx) {
  const { catalog, sorted, constants, registers } = ctx;
  if (registers.has(rootId)) return registers.get(rootId);

  const node = sorted.byId.get(rootId);
  if (!node) return null;
  const def = catalog.operator(node.type);
  if (!def) return null;

  const inputEdge = ctx.inputEdge;
  const inputs = [];
  for (const prop of Object.keys(def.props || {})) {
    const upstream = inputEdge.get(`${rootId}::${prop}`);
    if (upstream !== undefined) {
      const reg = lowerOperatorTree(upstream, ctx);
      inputs.push({ kind: 'register', index: reg });
    } else {
      const value = normalizeValue(node.props[prop]);
      const literal = Array.isArray(value.v) ? value.v[0] : value.v;
      inputs.push({ kind: 'const', index: constants.add(Number(literal) || 0) });
    }
  }

  const out = ctx.nextRegister();
  const op = {
    op: OPERATOR_OPS[node.type] || 'const',
    out,
    in: inputs,
    width: 1,
  };
  if (node.modes) op.modes = { ...node.modes };
  ctx.ops.push(op);
  registers.set(rootId, out);
  return out;
}

// Catalog operator id -> IR op name. Kept as a table rather than derived from
// the id so renaming a catalog entry's label or grouping cannot change the IR.
const OPERATOR_OPS = Object.freeze({
  'op.constant': 'const',
  'op.multiply': 'mul',
  'op.time': 'time',
  'op.getAttribute': 'attr',
});

// ---------------------------------------------------------------------------
// Phase 4 + 6: bindings
// ---------------------------------------------------------------------------

// Turn one authored property into one IR binding. Every mode lands on the same
// shape, which is what lets a kernel read its inputs without knowing how the
// author expressed them - guarantee 5 in vfx/ir.js.
function lowerBinding(prop, propDef, value, block, ctx) {
  const width = propChannels(propDef.type);
  const base = { prop, width };

  // An edge into this property wins over whatever mode the value claims -
  // doc.js reconciles the two, but the compiler must not depend on that having
  // happened, because it also compiles documents built in memory.
  const wiredFrom = ctx.propEdge.get(`${block.id}::${prop}`);
  if (wiredFrom !== undefined) {
    const reg = lowerOperatorTree(wiredFrom, ctx);
    if (reg !== null) return { ...base, src: BINDING_SRC.REGISTER, index: reg };
  }

  switch (value.mode) {
    case VALUE_MODE.EXPOSED: {
      const index = ctx.uniformIndex(value.exposedId, width);
      if (index !== null) return { ...base, src: BINDING_SRC.UNIFORM, index };
      // The blackboard entry was renamed or removed. Fall through to the
      // literal every mode carries rather than failing the compile.
      break;
    }
    case VALUE_MODE.RANDOM: {
      const lo = ctx.constants.addMany(spread(value.a, width));
      const hi = ctx.constants.addMany(spread(value.b, width));
      return {
        ...base,
        src: BINDING_SRC.RANDOM,
        loIndex: lo,
        hiIndex: hi,
        slot: drawSlot(block.id, prop),
        freq: value.freq || RANDOM_FREQ.PER_PARTICLE,
        ...(value.uniform ? { uniformDraw: true } : {}),
      };
    }
    case VALUE_MODE.CURVE: {
      const n = chooseCurveSampleCount(value.curve);
      const extent = curveExtent(value.curve);
      const index = ctx.tables.add({
        kind: 'curve',
        n,
        // Array.from, not the Float32Array itself: the IR is plain JSON, and a
        // typed array survives JSON.stringify as an object with numeric keys.
        data: Array.from(bakeCurve(value.curve, n)),
        min: extent.min,
        max: extent.max,
      });
      ctx.curves.push(value.curve);
      return {
        ...base,
        src: BINDING_SRC.CURVE,
        index,
        domain: value.domain || 'life',
        scale: Number.isFinite(value.scale) ? value.scale : 1,
        ...(value.randomScale ? { randomScale: value.randomScale.slice() } : {}),
      };
    }
    case VALUE_MODE.GRADIENT: {
      const n = chooseGradientSampleCount(value.gradient);
      const index = ctx.tables.add({
        kind: 'gradient',
        n,
        data: Array.from(bakeGradient(value.gradient, n)),
      });
      ctx.gradients.push(value.gradient);
      return { ...base, src: BINDING_SRC.GRADIENT, index, domain: value.domain || 'life' };
    }
    default:
      break;
  }

  return { ...base, src: BINDING_SRC.CONST, index: ctx.constants.addMany(spread(value.v, width)) };
}

function spread(value, width) {
  if (width <= 1) return [Number(Array.isArray(value) ? value[0] : value) || 0];
  const out = new Array(width);
  for (let i = 0; i < width; i += 1) {
    out[i] = Number(Array.isArray(value) ? (value[i] ?? value[0]) : value) || 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The compile
// ---------------------------------------------------------------------------

/**
 * Compile a VFX graph document into IR.
 *
 * @param {Object} document a VFX graph document, normalised or not
 * @param {Object} [options]
 * @param {Object} [options.catalog] block/operator catalog; defaults to CATALOG.
 *   Injectable so a test can exercise paths the shipped catalog has no entry
 *   for - the 'no engine equivalent' branch in particular.
 * @param {'unity'|'unreal'|null} [options.engineTarget] raises export-fidelity
 *   diagnostics when set
 * @param {Set<number>|null} [options.assetIndex] ids present in the library;
 *   when given, missing references are reported
 * @returns {{ir: Object, diagnostics: Array<Object>, stats: Object}}
 */
export function compileVfxGraph(document, options = {}) {
  const catalog = options.catalog || CATALOG;
  const engineTarget = options.engineTarget || null;
  const assetIndex = options.assetIndex || null;
  const diag = createDiagnostics();

  // --- Phase 0: normalize ---------------------------------------------------
  const doc = normalizeVfxDoc(document);

  // --- Phase 2: operator order (before anything reads an operator) ----------
  const sorted = sortOperators(doc, diag);

  // --- Phase 3: frequency ---------------------------------------------------
  const operatorFreq = classifyOperators(doc, catalog, sorted, diag);

  // Shared pools. One per compile, so two blocks using the same curve or the
  // same literal share an entry.
  const constants = createConstantPool();
  const tables = createTablePool();
  const curves = [];
  const gradients = [];

  // Blackboard -> uniform slots.
  const uniforms = [];
  const uniformByExposedId = new Map();
  let uniformOffset = 0;
  for (const entry of doc.exposed) {
    const width = propChannels(entry.type === 'color' ? PROP_TYPE.COLOR
      : entry.type === 'vec3' ? PROP_TYPE.VEC3 : PROP_TYPE.FLOAT);
    uniformByExposedId.set(entry.id, { index: uniformOffset, width });
    uniforms.push({ name: entry.name, exposedId: entry.id, offset: uniformOffset, width });
    uniformOffset += width;
  }
  const uniformIndex = (exposedId, width) => {
    const slot = uniformByExposedId.get(exposedId);
    if (!slot) return null;
    return slot.width >= width ? slot.index : null;
  };

  // Asset slots, resolved once. Referenced by index from block asset props.
  const assets = [];
  const assetIndexBySlot = new Map();
  for (const [slot, entry] of Object.entries(doc.references)) {
    const id = parseAssetRef(entry.ref);
    if (id === null) {
      // An empty slot is not the same thing as a deleted asset, and it needs no
      // report of its own: whatever references it already raises the diagnostic
      // for the CONSEQUENCE (W_NO_TEXTURE for an output with no sprite), which
      // is the actionable one. Reporting both shows two rows for one problem.
      continue;
    }
    if (assetIndex && !assetIndex.has(id)) {
      diag.report('W_MISSING_ASSET', { prop: slot }, { slot, kind: entry.kind });
    }
    assetIndexBySlot.set(slot, assets.length);
    assets.push({
      slot,
      kind: entry.kind,
      ref: entry.ref,
      assetId: id,
      colorSpace: entry.colorSpace,
      // glTF convention for a texture that came off a loaded mesh, canvas
      // convention for one from the image library. Recorded at compile time
      // rather than guessed by the shader - see the colour-space rule in
      // src/utils/assemblyAtlasBake.js.
      flipY: entry.kind === 'image',
    });
  }

  // Edge lookups.
  const propEdge = new Map();
  const inputEdge = new Map();
  for (const edge of doc.edges) {
    if (edge.to.blockId && edge.to.prop) {
      propEdge.set(`${edge.to.blockId}::${edge.to.prop}`, edge.from.nodeId);
    } else if (edge.to.nodeId && edge.to.port) {
      inputEdge.set(`${edge.to.nodeId}::${edge.to.port}`, edge.from.nodeId);
    }
  }

  const capabilities = new Set();
  const usedDefs = [];
  let registerCount = 0;

  const irSystems = [];
  const attributeRequests = new Set();
  let totalPeak = 0;
  let totalPeakExact = true;

  for (const system of doc.systems) {
    if (!system.enabled) continue;

    // --- Phase 1: structure -------------------------------------------------
    const spawnContexts = contextsOfKind(system, CONTEXT_KIND.SPAWN);
    const initContexts = contextsOfKind(system, CONTEXT_KIND.INITIALIZE);
    const updateContexts = contextsOfKind(system, CONTEXT_KIND.UPDATE);
    const outputContexts = contextsOfKind(system, CONTEXT_KIND.OUTPUT);

    for (const [kind, list] of [
      [CONTEXT_KIND.SPAWN, spawnContexts],
      [CONTEXT_KIND.INITIALIZE, initContexts],
      [CONTEXT_KIND.UPDATE, updateContexts],
    ]) {
      if (list.length > 1) {
        diag.report('E_DUPLICATE_CONTEXT', { systemId: system.id, contextId: list[1].id },
          { systemName: system.name, contextKind: kind, count: list.length });
      }
    }
    if (outputContexts.length === 0) {
      diag.report('E_NO_OUTPUT', { systemId: system.id }, { systemName: system.name });
    }
    if (updateContexts.length === 0) {
      diag.report('I_NO_UPDATE', { systemId: system.id }, { systemName: system.name });
    }

    const spawnBlocks = spawnContexts.flatMap(enabledBlocks);
    if (spawnBlocks.length === 0) {
      diag.report('E_NO_SPAWN', { systemId: system.id }, { systemName: system.name });
    }

    for (const context of system.contexts) {
      if (context.blocks.length > 0 && enabledBlocks(context).length === 0) {
        diag.report('W_ALL_BLOCKS_OFF', { systemId: system.id, contextId: context.id },
          { systemName: system.name, contextKind: context.kind, count: context.blocks.length });
      }
      for (const block of context.blocks) {
        const def = catalog.block(block.type);
        if (!def) {
          diag.report('E_UNKNOWN_BLOCK', { systemId: system.id, blockId: block.id },
            { blockType: block.type });
          continue;
        }
        if (!def.contexts.includes(context.kind)) {
          diag.report('E_BLOCK_WRONG_CONTEXT', { systemId: system.id, blockId: block.id }, {
            blockLabel: def.label,
            contextKind: context.kind,
            allowed: def.contexts,
            blockId: block.id,
            reason: def.contexts.includes(CONTEXT_KIND.UPDATE)
              ? 'It reads the previous frame, which only exists once a particle is alive.'
              : '',
          });
        }
      }
    }

    // --- Phases 4-6: lowering ----------------------------------------------
    const systemAttrs = new Set();
    const lowerContextBlocks = (contexts) => {
      const out = [];
      for (const context of contexts) {
        for (const block of enabledBlocks(context)) {
          const def = catalog.block(block.type);
          if (!def || !def.contexts.includes(context.kind)) continue;
          usedDefs.push(def);

          const ops = [];
          const registers = new Map();
          let nextReg = 0;
          const ctx = {
            catalog, sorted, constants, tables, curves, gradients,
            propEdge, inputEdge, uniformIndex, registers, ops,
            nextRegister: () => { const r = nextReg; nextReg += 1; return r; },
          };

          const bindings = [];
          const assetSlots = {};
          for (const [prop, propDef] of Object.entries(def.props)) {
            const raw = block.props[prop] !== undefined ? block.props[prop] : propDef.default;
            const value = normalizeValue(raw, { channels: propChannels(propDef.type) });

            if (propDef.type === PROP_TYPE.TEXTURE || propDef.type === PROP_TYPE.MESH) {
              const slot = typeof value.v === 'string' ? value.v : '';
              if (slot && assetIndexBySlot.has(slot)) assetSlots[prop] = assetIndexBySlot.get(slot);
              else assetSlots[prop] = -1;
              continue;
            }

            // Phase 3 applied to this property: an operator feeding it must not
            // vary faster than the stage can accommodate.
            const wiredFrom = propEdge.get(`${block.id}::${prop}`);
            if (wiredFrom !== undefined) {
              const got = operatorFreq.get(wiredFrom) ?? FREQ.CONST;
              const allowed = MAX_FREQ_BY_CONTEXT[context.kind] ?? FREQ.PER_PARTICLE;
              if (got > allowed) {
                const opDef = catalog.operator(sorted.byId.get(wiredFrom)?.type);
                diag.report('E_FREQ_MISMATCH', { systemId: system.id, blockId: block.id, prop }, {
                  propLabel: propDef.label,
                  blockLabel: def.label,
                  gotLabel: FREQ_LABEL[got],
                  wantLabel: FREQ_LABEL[allowed],
                  reason: `${opDef?.label || 'That node'} produces a different value for every particle, and the ${context.kind} stage runs before any particle exists.`,
                });
                continue;
              }
            }

            bindings.push(lowerBinding(prop, propDef, value, block, ctx));
          }

          for (const attr of def.attributes || []) systemAttrs.add(attr);
          registerCount = Math.max(registerCount, nextReg);

          out.push({
            kernel: def.kernel,
            srcBlockId: block.id,
            srcBlockType: block.type,
            modes: { ...(block.modes || {}) },
            bindings,
            ...(Object.keys(assetSlots).length ? { assetSlots } : {}),
            pre: ops,
            // Copied, not aliased. def.attributes is a frozen array shared by
            // every block of this type, and putting it straight into the IR
            // would make the IR share structure with the catalog - so anything
            // that touched the IR would reach back into the definitions, and
            // two blocks of one type would be indistinguishable by reference.
            attributes: [...(def.attributes || [])],
          });
        }
      }
      return out;
    };

    const irSpawn = lowerContextBlocks(spawnContexts);
    const irInit = lowerContextBlocks(initContexts);
    const irUpdateBlocks = lowerContextBlocks(updateContexts);
    const irOutputBlocks = outputContexts.map((context) => ({
      context,
      blocks: lowerContextBlocks([context]),
    }));

    // Over-life blocks scale a BIRTH value, so that value has to be preserved.
    // Requesting the attribute here - after the update stack is lowered, so we
    // know which targets are actually driven - is what keeps an effect with no
    // over-life block from paying for the copies.
    const startPairs = [];
    for (const block of irUpdateBlocks) {
      if (block.kernel !== 'attr.overLife' && block.kernel !== 'color.overLife') continue;
      const target = block.attributes[0];
      const startName = START_ATTRIBUTE[target];
      if (!startName || startPairs.some((p) => p[1] === startName)) continue;
      startPairs.push([target, startName]);
      systemAttrs.add(target);
      systemAttrs.add(startName);
    }
    if (startPairs.length > 0) {
      irInit.push({
        kernel: 'init.snapshot',
        srcBlockId: '',
        srcBlockType: '',
        modes: {},
        bindings: [],
        pre: [],
        // Pairs of [live, birth]. An extra field on an IR block is fine - the
        // IR is plain JSON - and it beats making the kernel infer the pairing
        // from a flat attribute list.
        snapshot: startPairs.map(([from, to]) => ({ from, to })),
        attributes: startPairs.flat(),
      });
    }

    // Injected kernels - guarantee 3 in vfx/ir.js. Age advance plus the kill
    // sweep must run before anything touches a particle, and integration after
    // every force has accumulated. Neither is author-placeable, because a stack
    // the author can break by dragging is a footgun and neither engine exposes
    // the integrator as a module either.
    const irUpdate = [
      { kernel: 'age.advance', srcBlockId: '', srcBlockType: '', modes: {}, bindings: [], pre: [], attributes: ['age', 'lifetime'] },
      ...irUpdateBlocks,
    ];
    if (systemAttrs.has('velocity')) {
      irUpdate.push({
        kernel: updateContexts[0]?.params?.integrator === 'euler' ? 'integrate.euler' : 'integrate.semiImplicit',
        srcBlockId: '', srcBlockType: '', modes: {}, bindings: [], pre: [],
        attributes: ['position', 'velocity'],
      });
    }

    // Lifetime is the one attribute whose absence is fatal rather than merely
    // odd: without it nothing dies, the pool fills, and emission stops.
    const writesLifetime = irInit.some((b) => (b.attributes || []).includes('lifetime'));
    if (!writesLifetime && spawnBlocks.length > 0) {
      diag.report('E_NO_LIFETIME', { systemId: system.id },
        { systemName: system.name, capacity: system.capacity });
    }

    // --- Phase 7: capacity ---------------------------------------------------
    const lifetimeRange = findBindingRange(irInit, 'attr.set', 'lifetime', constants)
      || { lo: 1, hi: 1, exact: false };
    let peak = 0;
    let peakRate = 0;
    let peakExact = lifetimeRange.exact;
    for (const block of irSpawn) {
      if (block.kernel === 'spawn.rate') {
        const rate = bindingHigh(block, 'rate', constants);
        if (!rate.exact) peakExact = false;
        peakRate = Math.max(peakRate, rate.value);
        peak += rate.value * lifetimeRange.hi;
      } else if (block.kernel === 'spawn.burst') {
        const count = bindingHigh(block, 'count', constants);
        if (!count.exact) peakExact = false;
        peak += count.value;
      }
    }
    peak = Math.ceil(peak);
    totalPeak += peak;
    if (!peakExact) totalPeakExact = false;
    if (peak > system.capacity) {
      diag.report('W_CAPACITY', { systemId: system.id }, {
        systemId: system.id,
        systemName: system.name,
        peak,
        rate: peakRate,
        lifetime: lifetimeRange.hi,
        capacity: system.capacity,
        exact: peakExact,
      });
    }

    // --- Phase 8: behaviour, per system -------------------------------------
    runSystemDiagnostics({ system, doc, catalog, diag, outputContexts, peak, engineTarget });

    // --- Schedule lowering --------------------------------------------------
    const fixedDt = doc.effect.fixedDt;
    const clips = system.schedule.clips.map((clip) => ({
      id: clip.id,
      at: clip.at,
      duration: clip.duration,
      loop: clip.loop,
      // Snapped to whole simulation steps so scheduling is deterministic: a
      // clip at 0.02s must fire on the same step every replay and every scrub,
      // whatever floating point does to the accumulator.
      atStep: Math.round(clip.at / fixedDt),
      durationSteps: Math.round(clip.duration / fixedDt),
    }));

    const outputs = irOutputBlocks.map(({ context, blocks }) => {
      const params = { ...contextParamDefaults(catalog, CONTEXT_KIND.OUTPUT), ...context.params };
      capabilities.add(`output.${params.mode}`);
      capabilities.add(`blend.${params.blend}`);
      return {
        contextId: context.id,
        mode: params.mode,
        blend: params.blend,
        sort: params.sort,
        blocks,
        // Outputs sharing this key can be drawn in one instanced call. The
        // criterion is material state plus render mode, which is the same
        // grouping three.quarks' BatchedRenderer.equals uses.
        batchKey: hashString(JSON.stringify([
          params.mode, params.blend, params.sort,
          blocks.map((b) => b.assetSlots?.texture ?? -1),
        ])),
      };
    });

    for (const attr of systemAttrs) attributeRequests.add(attr);
    for (const block of [...irInit, ...irUpdate]) {
      if (block.kernel === 'force.curlNoise') capabilities.add('force.curlNoise');
    }

    irSystems.push({
      id: system.id,
      srcSystemId: system.id,
      name: system.name,
      capacity: system.capacity,
      space: system.simulationSpace === 'inherit' ? doc.effect.simulationSpace : system.simulationSpace,
      seedOffset: system.seedOffset,
      schedule: { clips },
      spawn: irSpawn,
      init: irInit,
      update: irUpdate,
      outputs,
      peakParticles: peak,
      peakExact,
    });
  }

  const { attributes, floatsPerParticle } = layoutAttributes(attributeRequests);

  const ir = {
    irFormat: VFX_IR_FORMAT,
    graphHash: String(hashString(vfxSignature(doc))),
    effect: {
      seed: doc.effect.seed,
      duration: doc.effect.duration,
      loop: doc.effect.loop,
      fixedDt: doc.effect.fixedDt,
      maxSubSteps: doc.effect.maxSubSteps,
      capacity: doc.effect.capacity,
      simulationSpace: doc.effect.simulationSpace,
      boundsMin: doc.effect.boundsMin.slice(),
      boundsMax: doc.effect.boundsMax.slice(),
      prewarm: doc.effect.prewarm,
      timeScale: doc.effect.timeScale,
    },
    attributes,
    constants: constants.values(),
    uniforms,
    tables: tables.values(),
    curves,
    gradients,
    assets,
    systems: irSystems,
    events: doc.events,
    capabilities: [...capabilities].sort(),
    registerCount,
  };

  const engines = {
    unity: worstOf(usedDefs, 'unity'),
    unreal: worstOf(usedDefs, 'unreal'),
  };

  return {
    ir,
    diagnostics: diag.list(),
    stats: {
      peakParticles: totalPeak,
      // False when a spawn rate or count is driven by a blackboard property or
      // a wired operator, so anything reading this knows to say "about".
      peakExact: totalPeakExact,
      floatsPerParticle,
      bytesPerParticle: floatsPerParticle * 4,
      drawCalls: new Set(irSystems.flatMap((s) => s.outputs.map((o) => o.batchKey))).size,
      tableCount: ir.tables.length,
      constantCount: ir.constants.length,
      engines,
    },
  };
}

function worstOf(defs, target) {
  let worst = ENGINE_SUPPORT.NATIVE;
  for (const def of defs) {
    const support = def?.engines?.[target];
    if (support === ENGINE_SUPPORT.NONE) return ENGINE_SUPPORT.NONE;
    if (support === ENGINE_SUPPORT.APPROX) worst = ENGINE_SUPPORT.APPROX;
  }
  return worst;
}

function contextParamDefaults(catalog, kind) {
  const def = catalog.contexts?.[kind];
  const out = {};
  for (const [name, param] of Object.entries(def?.params || {})) out[name] = param.default;
  return out;
}

// The high end of a constant or random binding, read back out of the pool.
// Used by the capacity solve, which needs the worst case rather than nominal.
function bindingHigh(irBlock, prop, constants) {
  const binding = irBlock.bindings.find((b) => b.prop === prop);
  if (!binding) return { value: 0, exact: true };
  const values = constants.values();
  if (binding.src === BINDING_SRC.CONST) return { value: values[binding.index] || 0, exact: true };
  if (binding.src === BINDING_SRC.RANDOM) return { value: values[binding.hiIndex] || 0, exact: true };
  if (binding.src === BINDING_SRC.CURVE) {
    const scale = binding.scale ?? 1;
    const hi = Array.isArray(binding.randomScale) ? Math.max(...binding.randomScale) : scale;
    return { value: hi, exact: true };
  }
  // A blackboard property or a wired operator cannot be folded: a host can
  // change the first at runtime and the second depends on the frame. Returning
  // 0 would silently suppress the capacity warning on exactly the effects most
  // likely to blow the budget, so report a nominal value and mark it INEXACT -
  // the message then says it is an estimate rather than asserting a number.
  return { value: 1, exact: false };
}

function findBindingRange(irBlocks, kernel, prop, constants) {
  for (const block of irBlocks) {
    if (block.kernel !== kernel) continue;
    const binding = block.bindings.find((b) => b.prop === prop);
    if (!binding) continue;
    const values = constants.values();
    if (binding.src === BINDING_SRC.CONST) {
      const v = values[binding.index] || 0;
      return { lo: v, hi: v, exact: true };
    }
    if (binding.src === BINDING_SRC.RANDOM) {
      return { lo: values[binding.loIndex] || 0, hi: values[binding.hiIndex] || 0, exact: true };
    }
    return { lo: 0, hi: 1, exact: false };
  }
  return null;
}

// Phase 8, per system. Everything here needs the lowered blocks plus the
// capacity number, which is why it runs last rather than alongside phase 1.
function runSystemDiagnostics(args) {
  const { system, doc, catalog, diag, outputContexts, peak, engineTarget } = args;

  const docBlocks = system.contexts.flatMap((c) => c.blocks.map((b) => ({ block: b, context: c })));
  const findDocBlock = (type) => docBlocks.find((entry) => entry.block.type === type);

  // Zero size: either Set Size is 0, or a Size Over Life curve is flat at 0.
  const sizeEntry = findDocBlock('initialize.setSize');
  if (sizeEntry) {
    const value = normalizeValue(sizeEntry.block.props.size);
    const range = valueRange(value);
    const overLife = findDocBlock('update.sizeOverLife');
    const overRange = overLife
      ? valueRange(normalizeValue(overLife.block.props.scale))
      : { hi: [1] };
    if (range.hi[0] <= 0 || (overRange.hi[0] ?? 1) <= 0) {
      diag.report('W_ZERO_SIZE', { systemId: system.id, blockId: sizeEntry.block.id },
        { systemName: system.name, blockId: sizeEntry.block.id });
    }
  }

  // Zero alpha and dark additive both read the colour ramp, so resolve it once.
  const colorEntry = findDocBlock('update.colorOverLife') || findDocBlock('initialize.setColor');
  let gradient = null;
  let maxAlpha = 1;
  let luminance = 1;
  if (colorEntry) {
    const propName = colorEntry.block.type === 'update.colorOverLife' ? 'color' : 'color';
    const value = normalizeValue(colorEntry.block.props[propName], { channels: 4 });
    if (value.mode === VALUE_MODE.GRADIENT) {
      gradient = value.gradient;
      maxAlpha = gradientAlphaExtent(gradient).max;
      luminance = gradientMeanLuminance(gradient);
    } else {
      const literal = Array.isArray(value.v) ? value.v : [1, 1, 1, 1];
      maxAlpha = literal[3] ?? 1;
      luminance = ((literal[0] + literal[1] + literal[2]) / 3) * maxAlpha;
    }
    if (maxAlpha < 0.02) {
      diag.report('W_ZERO_ALPHA', { systemId: system.id, blockId: colorEntry.block.id },
        { systemName: system.name, maxAlpha, blockId: colorEntry.block.id, prop: propName });
    }
  }

  for (const context of outputContexts) {
    const params = { ...contextParamDefaults(catalog, CONTEXT_KIND.OUTPUT), ...context.params };

    // Additive blending ADDS light, so a dark ramp is the same as transparent.
    // This is the classic "my smoke is invisible" and "my smoke is a white
    // blob" pair, and it is only diagnosable by looking at blend and colour
    // together.
    if (params.blend === 'additive' && colorEntry && luminance < 0.06) {
      diag.report('W_ADDITIVE_DARK', { systemId: system.id, contextId: context.id },
        { systemName: system.name, luminance, contextId: context.id });
    }

    const textureBlock = context.blocks.find((b) => b.type === 'output.setMainTexture');
    const slot = textureBlock ? normalizeValue(textureBlock.props.texture).v : '';
    if (!textureBlock || !slot || !doc.references[slot]) {
      diag.report('W_NO_TEXTURE', { systemId: system.id, contextId: context.id },
        { systemName: system.name, blockId: textureBlock?.id || '' });
    }

    if (params.sort === 'depth' && peak > 20000) {
      diag.report('W_SORT_COST', { systemId: system.id, contextId: context.id }, {
        systemName: system.name,
        peak,
        // Measured shape of a 3-pass 11-bit radix over float keys: roughly
        // 0.75ms at 60k, scaling linearly.
        estimateMs: (peak / 60000) * 0.75,
        contextId: context.id,
      });
    }
  }

  // Timeline clips that cannot round-trip. Bursts are fine at any count -
  // both engines take a burst list - but each engine supports ONE timed spawn
  // window per emitter, so overlapping windows are the case that degrades.
  const timed = system.schedule.clips.filter((clip) => clip.duration > 0);
  if (timed.length > 1) {
    const overlapping = timed.some((clip, i) => timed.slice(i + 1).some((other) => (
      other.at < clip.at + clip.duration && clip.at < other.at + other.duration
    )));
    if (overlapping || timed.length > 1) {
      diag.report('W_SCHEDULE_UNEXPORTABLE', { systemId: system.id },
        { systemId: system.id, systemName: system.name, windows: timed.length });
    }
  }

  // Engine fidelity, only when the author has picked a target.
  if (engineTarget) {
    const seen = new Set();
    for (const entry of docBlocks) {
      const def = catalog.block(entry.block.type);
      if (!def || seen.has(def.id)) continue;
      seen.add(def.id);
      const support = def.engines?.[engineTarget];
      const facts = {
        blockLabel: def.label,
        engineLabel: ENGINE_LABEL[engineTarget] || engineTarget,
        note: def.engines?.note,
      };
      if (support === ENGINE_SUPPORT.NONE) {
        diag.report('W_ENGINE_UNSUPPORTED', { systemId: system.id, blockId: entry.block.id }, facts);
      } else if (support === ENGINE_SUPPORT.APPROX) {
        diag.report('I_ENGINE_APPROX', { systemId: system.id, blockId: entry.block.id }, facts);
      }
    }
  }
}
