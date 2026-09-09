// What survives the trip into Unity and Unreal, and what does not.
//
// THE TABLE IS DERIVED, NEVER WRITTEN DOWN TWICE. Every fact here comes from
// the `engines` field each catalog entry has carried since the first commit,
// so there is exactly one place to update when a block's support changes - and
// `vfx/compile.test.mjs` already fails if any entry omits it. A hand-maintained
// copy in docs/ would drift the first time someone added a block, and the
// drift would be invisible until an importer plugin was written against it.
//
// IT LIVES IN vfx/ AND NOT IN docs/ FOR A CONCRETE REASON: docs/ is not
// shipped. The export bundle carries this table so an importer plugin can read
// it out of the manifest rather than being compiled against a particular
// version of this app, and the bundle is built by the SERVER - which means the
// data has to be importable from Node in a packaged build. `docs/` is a
// rendering of this module, produced by tools/gen-vfx-mapping.mjs.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: decide anything. It reports. The
// author-time decisions (which diagnostic to raise for an unsupported block,
// what the effect summary says) belong to the compiler, which reads the same
// `engines` fields directly.

import { CATALOG, ENGINE_SUPPORT, EVENT_TRIGGERS, PROP_TYPE } from './catalog.js';
import { VFX_IR_FORMAT } from './ir.js';

/** Engine keys, in the order every table here lists them. */
export const ENGINE_TARGETS = Object.freeze(['unity', 'unreal']);

export const ENGINE_LABELS = Object.freeze({
  unity: 'Unity VFX Graph',
  unreal: 'Unreal Niagara',
});

/**
 * WHAT IS PROMISED, AND WHAT IS NOT.
 *
 * Written here rather than in prose in a doc, because both the generated
 * document and the export bundle's manifest need it, and a plugin author
 * reading the bundle deserves the same words the doc gives a human. The
 * contract is STATISTICAL CONFORMANCE, not bit-identical particles: neither
 * engine lets us inject PCG32, so a spark that goes left in the preview may go
 * right in an engine. Seeds travel so that each engine's own result is
 * reproducible even though it differs.
 *
 * Kept in step with the header of vfx/ir.js, which states the same contract
 * for the IR itself.
 */
export const DETERMINISM = Object.freeze({
  survives: Object.freeze([
    'Graph topology: which systems exist, and which contexts each one has.',
    'Block order within every context stack.',
    'Every authored curve and gradient key, including tangents and interpolation mode - Hermite keys map field for field onto Unity Keyframes and Niagara FRichCurveKeys.',
    'Every constant, and the LOW and HIGH ends of every random range.',
    'Emitter shapes and their offsets and rotations.',
    'Blend modes, sort modes, render modes and flipbook layouts.',
    'Clip timing, as native spawn delays, loop durations and burst times.',
    'Blackboard properties, as Unity exposed properties and Niagara User Parameters.',
    'Seeds - so an engine reproduces its own result exactly, run after run.',
  ]),
  doesNotSurvive: Object.freeze([
    'Exact per-particle numbers. Each engine has its own RNG and neither accepts an injected one, so individual particles differ.',
    'Frame-exact positions, for the same reason plus a different integrator.',
    'Anything marked APPROX or NONE in the tables below - the importer reports each one rather than silently dropping it.',
  ]),
  contract: 'Statistical conformance: matching spawn counts, lifetime distributions, colour ramps, shapes and bounds.',
});

/**
 * How an author-time value mode reaches each engine.
 *
 * Not derived from the catalog because it is not a property OF a catalog
 * entry - it is a property of the VfxValue union, and every block that offers
 * the mode inherits the same answer.
 */
export const VALUE_MODE_MAPPING = Object.freeze([
  {
    mode: 'const',
    label: 'Constant',
    unity: ENGINE_SUPPORT.NATIVE,
    unreal: ENGINE_SUPPORT.NATIVE,
    note: 'A plain value on the block.',
  },
  {
    mode: 'random',
    label: 'Random between two',
    unity: ENGINE_SUPPORT.NATIVE,
    unreal: ENGINE_SUPPORT.NATIVE,
    note: 'Unity: Random Number with a per-particle seed. Niagara: Uniform Ranged Float/Vector.',
  },
  {
    mode: 'curve',
    label: 'Curve over life',
    unity: ENGINE_SUPPORT.NATIVE,
    unreal: ENGINE_SUPPORT.NATIVE,
    note: 'Hermite keys transfer field for field. The IR also carries a baked table for hosts that cannot rebuild a curve.',
  },
  {
    mode: 'gradient',
    label: 'Gradient over life',
    unity: ENGINE_SUPPORT.NATIVE,
    unreal: ENGINE_SUPPORT.NATIVE,
    note: 'Colour and alpha keys stay in SEPARATE lists, because Unity\'s Gradient does and a merged list cannot round-trip.',
  },
  {
    mode: 'link',
    label: 'Wired from an operator',
    unity: ENGINE_SUPPORT.NATIVE,
    unreal: ENGINE_SUPPORT.APPROX,
    note: 'Unity: an operator subgraph. Niagara has no free-form expression graph in a module, so a chain imports as a baked constant or a User Parameter unless the plugin ships a matching module.',
  },
  {
    mode: 'exposed',
    label: 'Blackboard property',
    unity: ENGINE_SUPPORT.NATIVE,
    unreal: ENGINE_SUPPORT.NATIVE,
    note: 'Unity exposed property; Niagara User Parameter. The only thing a host can change without a recompile.',
  },
]);

/** The Output context's render modes, and what draws them in each engine. */
export const RENDER_MODE_MAPPING = Object.freeze([
  { mode: 'billboard', unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE, note: 'Unity: Output Particle Quad. Niagara: Sprite Renderer.' },
  { mode: 'stretched', unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE, note: 'Unity: Output Particle Quad with Orient Along Velocity. Niagara: Sprite Renderer, Alignment = Velocity.' },
  { mode: 'mesh', unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE, note: 'Unity: Output Particle Mesh. Niagara: Mesh Renderer.' },
  { mode: 'trail', unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE, note: 'Unity: Output Particle Strip. Niagara: Ribbon Renderer. NOT drawn by this app\'s preview - it reports I_TRAIL_UNSUPPORTED and draws stretched billboards instead, so the value is authored blind.' },
  { mode: 'point', unity: ENGINE_SUPPORT.NATIVE, unreal: ENGINE_SUPPORT.NATIVE, note: 'Both draw it as a constant-screen-size quad, as the preview does.' },
]);

/**
 * The whole mapping, in a shape both the doc generator and the export bundle
 * can use.
 *
 * @returns {Object} a plain, JSON-safe object
 */
export function buildEngineMapping() {
  const entry = (def) => ({
    id: def.id,
    label: def.label,
    unity: def.engines.unity,
    unreal: def.engines.unreal,
    note: def.engines.note || '',
  });

  const blocks = CATALOG.blocks.map((def) => ({
    ...entry(def),
    contexts: [...def.contexts],
    category: def.category,
    kernel: def.kernel,
    // Which of its properties are asset slots, because that is what an importer
    // has to bind rather than set - and the plugin spike that mattered most was
    // "which exposed property TYPES can an Editor script actually write".
    assetProps: Object.entries(def.props)
      .filter(([, propDef]) => propDef.type === PROP_TYPE.TEXTURE || propDef.type === PROP_TYPE.MESH)
      .map(([name, propDef]) => ({ name, type: propDef.type })),
  }));

  const operators = CATALOG.operators.map(entry);

  const events = Object.values(EVENT_TRIGGERS).map((trigger) => ({
    id: trigger.id,
    label: trigger.label,
    payload: [...(trigger.payload || [])],
    unity: trigger.engines.unity,
    unreal: trigger.engines.unreal,
    note: trigger.engines.note || '',
  }));

  return {
    irFormat: VFX_IR_FORMAT,
    generatedFrom: 'vfx/catalog.js',
    targets: [...ENGINE_TARGETS],
    labels: { ...ENGINE_LABELS },
    determinism: {
      survives: [...DETERMINISM.survives],
      doesNotSurvive: [...DETERMINISM.doesNotSurvive],
      contract: DETERMINISM.contract,
    },
    blocks,
    operators,
    events,
    valueModes: VALUE_MODE_MAPPING.map((row) => ({ ...row })),
    renderModes: RENDER_MODE_MAPPING.map((row) => ({ ...row })),
    summary: {
      unity: summarise(blocks, operators, 'unity'),
      unreal: summarise(blocks, operators, 'unreal'),
    },
  };
}

/**
 * Everything that will not arrive intact on one engine.
 *
 * Used by the export bundle to fill its `warnings` list, so a bundle states its
 * own fidelity gaps rather than leaving a plugin author to diff two tables.
 *
 * @param {'unity'|'unreal'} target
 * @param {Object} [mapping] a prebuilt mapping, to avoid rebuilding it
 * @returns {Array<{kind: string, id: string, support: string, note: string}>}
 */
export function unsupportedFor(target, mapping = null) {
  const table = mapping || buildEngineMapping();
  const out = [];
  const collect = (kind, rows) => {
    for (const row of rows) {
      if (row[target] === ENGINE_SUPPORT.NATIVE) continue;
      out.push({ kind, id: row.id || row.mode, support: row[target], note: row.note || '' });
    }
  };
  collect('block', table.blocks);
  collect('operator', table.operators);
  collect('event', table.events);
  collect('valueMode', table.valueModes.map((row) => ({ ...row, id: row.mode })));
  collect('renderMode', table.renderModes.map((row) => ({ ...row, id: row.mode })));
  return out;
}

function summarise(blocks, operators, target) {
  const counts = { native: 0, approx: 0, none: 0 };
  for (const row of [...blocks, ...operators]) {
    const support = row[target];
    if (support === ENGINE_SUPPORT.NATIVE) counts.native += 1;
    else if (support === ENGINE_SUPPORT.APPROX) counts.approx += 1;
    else counts.none += 1;
  }
  return counts;
}
