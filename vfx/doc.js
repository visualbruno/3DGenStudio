// The VFX graph document: the thing a .vfx.json file contains, and the only
// definition of its shape. Pure functions over plain JSON - no React, no
// three.js, no I/O - the same division of labour src/utils/assemblyHelpers.js
// has with MeshAssemblies and src/utils/batchHelpers.js has with BatchConfigs.
//
// The server stores this file verbatim under data/assets/vfx/ and mirrors a
// small digest of it into the Assets.metadata column. It is a FILE and not a
// metadata blob for a reason worth knowing before anyone tries to move it:
// storage.js merges metadata rather than replacing it (replaceAssetFileById,
// storage.js:2476), so a document held there could never lose a key. Delete a
// block, save, reload, and the block would come back. A file is replaced whole.
//
// FOUR INVARIANTS. Each has a plausible-looking alternative that breaks
// something specific.
//
//  1. `edges` IS AUTHORITATIVE FOR WIRING. A block property that is driven by
//     an operator also carries mode:'link' so the inspector can label the row
//     without scanning every edge per render, but that mirror is DERIVED.
//     normalizeVfxDoc rebuilds it from edges every time, so the two can never
//     drift apart, and no other code may write mode:'link' directly.
//
//  2. `layout` IS NEVER READ BY THE COMPILER. Node positions, collapsed
//     flags, pane widths - all cosmetic. vfxSignature() omits them, which is
//     what makes the signature usable as a recompile trigger: dragging a node
//     around must not rebuild the simulation. Same idea as the pieceSourceKey
//     trick in src/hooks/useAssemblyScene.js.
//
//  3. ASSET REFERENCES ARE SLOT KEYS, RESOLVED THROUGH ONE TABLE. A block says
//     'tex_spark', and doc.references maps that to an asset. This gives the
//     bundle builder one place to walk, project import one place to remap, and
//     turns a deleted texture into a dangling KEY - reportable and repairable
//     in the editor - rather than a dangling asset id nobody can trace.
//
//  4. EVERY REFERENCE IS THE STRING 'asset:<id>'. Not a bare number.
//     storage.js's collectAssetIdsFromValue (:5627) and remapReferencesDeep
//     (:6006) both match /^asset:(\d+)$/ against strings, so this shape makes
//     project export carry a VFX effect's textures and project import renumber
//     them with ZERO changes to either walker. Tree presets store bare numbers
//     and therefore ship broken across installations - the reference file is
//     src/utils/treeGen.js:405, and it is the mistake this invariant exists to
//     avoid repeating.

import { normalizeValue, VALUE_MODE } from './value.js';

/**
 * Document format version. Bump when a change cannot be read by the previous
 * normaliser, and add a MIGRATIONS entry in the same commit.
 */
export const VFX_DOC_FORMAT = 1;

/** Discriminator, so a JSON file can be recognised without guessing. */
export const VFX_DOC_KIND = 'vfx-graph';

/** The five flow contexts, in execution order. */
export const CONTEXT_KIND = Object.freeze({
  EVENT: 'event',
  SPAWN: 'spawn',
  INITIALIZE: 'initialize',
  UPDATE: 'update',
  OUTPUT: 'output',
});

/**
 * Legal successors on the particle-flow wire. Enforced by the compiler and by
 * the board's isValidConnection, from this one table - so the rule cannot be
 * stricter in one place than the other.
 */
export const FLOW_ORDER = Object.freeze({
  [CONTEXT_KIND.EVENT]: [CONTEXT_KIND.SPAWN],
  [CONTEXT_KIND.SPAWN]: [CONTEXT_KIND.INITIALIZE],
  [CONTEXT_KIND.INITIALIZE]: [CONTEXT_KIND.UPDATE, CONTEXT_KIND.OUTPUT],
  [CONTEXT_KIND.UPDATE]: [CONTEXT_KIND.OUTPUT],
  [CONTEXT_KIND.OUTPUT]: [],
});

/** What an asset slot points at. */
export const REF_KIND = Object.freeze({
  IMAGE: 'image',
  MESH: 'mesh',
  /** A nested VFX effect, for sub-emitters that reuse a saved effect. */
  VFX: 'vfx',
});

const REF_PATTERN = /^asset:(\d+)$/;

/**
 * @typedef {Object} VfxClip
 * @property {string} id
 * @property {number} at seconds from effect start
 * @property {number} duration seconds; 0 is a one-shot burst
 * @property {boolean} loop repeat to the end of the effect
 */

/**
 * @typedef {Object} VfxSchedule
 * @property {VfxClip[]} clips timeline clips for this system's spawn context
 */

/**
 * @typedef {Object} VfxBlock
 * @property {string} id document-local instance id
 * @property {string} type catalog key, e.g. 'update.force.gravity'
 * @property {boolean} enabled soft-mute; the compiler skips it but keeps the id
 * @property {Object<string, import('./value.js').VfxValue>} props
 * @property {Object<string, string>} [modes] discrete switches that change the
 *   generated code path rather than a value - kept out of props so the compiler
 *   can branch at compile time and the importers can map them onto an engine
 *   enum directly
 */

/**
 * @typedef {Object} VfxContext
 * @property {string} id
 * @property {'event'|'spawn'|'initialize'|'update'|'output'} kind
 * @property {string} [label]
 * @property {VfxBlock[]} blocks the reorderable stack; ORDER IS SEMANTICS
 * @property {Object} params kind-specific settings
 */

/**
 * @typedef {Object} VfxSystem
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {boolean} [solo] editor-only debugging state, not exported
 * @property {number} capacity per-system particle pool size
 * @property {'local'|'world'|'inherit'} simulationSpace
 * @property {number} seedOffset mixed into this system's random stream
 * @property {VfxContext[]} contexts
 * @property {VfxSchedule} schedule
 */

/**
 * @typedef {Object} VfxDoc
 * @property {number} format
 * @property {'vfx-graph'} kind
 * @property {number} savedAt
 * @property {string} name
 * @property {Object} effect effect-wide settings
 * @property {VfxSystem[]} systems
 * @property {Object[]} events effect-scoped event nodes
 * @property {Object[]} operators effect-scoped operator nodes
 * @property {Object[]} edges the authoritative wiring
 * @property {Object[]} exposed the blackboard
 * @property {Object<string, {kind: string, ref: string, name?: string}>} references
 * @property {Object} layout cosmetic only; never read by the compiler
 */

let idCounter = 0;

/**
 * A document-local id. Deliberately not an asset id: the same texture can fill
 * two slots and the same block type can appear twice in one stack, so both need
 * an identity of their own. Same reasoning as nextPieceId in
 * src/utils/assemblyHelpers.js.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function nextVfxId(prefix = 'n') {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

const asNumber = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const asBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const asString = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

/**
 * Default effect-wide settings.
 *
 * fixedDt is 1/60 and is not merely a default - the simulation steps in exact
 * multiples of it so that a replay, a timeline scrub and a thumbnail all land
 * on the same frames. maxSubSteps caps catch-up after a stall, because a
 * dropped second should not turn into sixty steps of simulation in one frame.
 *
 * @returns {Object}
 */
export function createEffectSettings() {
  return {
    seed: 12345,
    duration: 2,
    loop: true,
    fixedDt: 1 / 60,
    maxSubSteps: 4,
    simulationSpace: 'local',
    capacity: 4096,
    boundsMin: [-2, -2, -2],
    boundsMax: [2, 2, 2],
    boundsAuto: true,
    prewarm: 0,
    timeScale: 1,
  };
}

function normalizeEffectSettings(input = {}) {
  const defaults = createEffectSettings();
  const vec3 = (v, fallback) => (
    Array.isArray(v) && v.length === 3 ? v.map((n, i) => asNumber(n, fallback[i])) : fallback.slice()
  );
  return {
    // Seed is a uint32: the RNG hashes it as one, and a negative or fractional
    // seed would silently become a different number than the author sees.
    seed: (asNumber(input.seed, defaults.seed) >>> 0),
    duration: Math.max(0, asNumber(input.duration, defaults.duration)),
    loop: asBool(input.loop, defaults.loop),
    // A fixedDt of zero would make the accumulator loop forever.
    fixedDt: Math.max(1 / 1000, asNumber(input.fixedDt, defaults.fixedDt)),
    maxSubSteps: Math.max(1, Math.round(asNumber(input.maxSubSteps, defaults.maxSubSteps))),
    simulationSpace: input.simulationSpace === 'world' ? 'world' : 'local',
    capacity: Math.max(1, Math.round(asNumber(input.capacity, defaults.capacity))),
    boundsMin: vec3(input.boundsMin, defaults.boundsMin),
    boundsMax: vec3(input.boundsMax, defaults.boundsMax),
    boundsAuto: asBool(input.boundsAuto, defaults.boundsAuto),
    prewarm: Math.max(0, asNumber(input.prewarm, defaults.prewarm)),
    timeScale: Math.max(0, asNumber(input.timeScale, defaults.timeScale)),
  };
}

/**
 * A timeline clip: a window during which a system's spawn context is active.
 *
 * @param {Partial<VfxClip>} [clip]
 * @returns {VfxClip}
 */
export function createClip(clip = {}) {
  return {
    id: asString(clip.id) || nextVfxId('clip'),
    at: Math.max(0, asNumber(clip.at, 0)),
    // Zero duration is meaningful and must survive: it is a one-shot burst,
    // which is what most impact effects are built from.
    duration: Math.max(0, asNumber(clip.duration, 0)),
    loop: asBool(clip.loop, false),
  };
}

function normalizeSchedule(input = {}) {
  const clips = (Array.isArray(input.clips) ? input.clips : []).map(createClip);
  clips.sort((a, b) => a.at - b.at);
  // A system with no clips spawns for the whole effect. That is the right
  // default for a newly added system - it does something immediately rather
  // than appearing to be broken - and it is what an effect authored before the
  // timeline existed means.
  if (clips.length === 0) clips.push(createClip({ at: 0, duration: 0, loop: false }));
  return { clips };
}

function normalizeBlock(input = {}) {
  const props = {};
  const rawProps = input.props && typeof input.props === 'object' ? input.props : {};
  for (const [key, value] of Object.entries(rawProps)) {
    // No channel count here on purpose: the catalog owns property types, and it
    // is consulted in the compiler's typing pass. normalizeValue infers the
    // width from the input, which is right for a structural pass like this one.
    props[key] = normalizeValue(value);
  }
  const block = {
    id: asString(input.id) || nextVfxId('blk'),
    type: asString(input.type),
    enabled: asBool(input.enabled, true),
    props,
  };
  if (input.modes && typeof input.modes === 'object') {
    block.modes = {};
    for (const [key, value] of Object.entries(input.modes)) block.modes[key] = asString(value);
  }
  return block;
}

function normalizeContext(input = {}) {
  const kind = Object.values(CONTEXT_KIND).includes(input.kind) ? input.kind : CONTEXT_KIND.UPDATE;
  return {
    id: asString(input.id) || nextVfxId('ctx'),
    kind,
    label: asString(input.label),
    blocks: (Array.isArray(input.blocks) ? input.blocks : []).map(normalizeBlock),
    params: input.params && typeof input.params === 'object' ? { ...input.params } : {},
  };
}

function normalizeSystem(input = {}, index = 0) {
  return {
    id: asString(input.id) || nextVfxId('sys'),
    name: asString(input.name) || `System ${index + 1}`,
    enabled: asBool(input.enabled, true),
    solo: asBool(input.solo, false),
    capacity: Math.max(1, Math.round(asNumber(input.capacity, 1024))),
    simulationSpace: ['local', 'world', 'inherit'].includes(input.simulationSpace)
      ? input.simulationSpace
      : 'inherit',
    // A per-system offset so two systems with the same effect seed do not draw
    // identical randoms. Derived from the index when absent rather than left at
    // zero, which is what made every system in an early test look alike.
    seedOffset: (asNumber(input.seedOffset, (index + 1) * 0x9e37) >>> 0),
    contexts: (Array.isArray(input.contexts) ? input.contexts : []).map(normalizeContext),
    schedule: normalizeSchedule(input.schedule),
  };
}

function normalizeOperator(input = {}) {
  const props = {};
  const rawProps = input.props && typeof input.props === 'object' ? input.props : {};
  for (const [key, value] of Object.entries(rawProps)) props[key] = normalizeValue(value);
  const operator = {
    id: asString(input.id) || nextVfxId('op'),
    type: asString(input.type),
    props,
  };
  if (input.modes && typeof input.modes === 'object') {
    operator.modes = {};
    for (const [key, value] of Object.entries(input.modes)) operator.modes[key] = asString(value);
  }
  return operator;
}

/**
 * Cosmetic board state: node positions, and the author's own notes.
 *
 * NOTES LIVE HERE, NOT AT THE TOP LEVEL, and that placement is the whole
 * design. `layout` is excluded from vfxSignature (invariant 2), so writing a
 * note - or dragging one, or resizing one - cannot recompile the effect or
 * restart the simulation. A note at the top level would be part of the
 * document's identity, and typing in one would rebuild the runtime on every
 * keystroke.
 *
 * They are still SAVED, because `layout` is part of the file even though it is
 * not part of the signature. A note that vanished on reload would be worse than
 * no notes at all.
 */
function normalizeLayout(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const nodes = raw.nodes && typeof raw.nodes === 'object' ? { ...raw.nodes } : {};
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((note) => ({
    id: asString(note?.id) || nextVfxId('note'),
    text: asString(note?.text),
    x: asNumber(note?.x, 0),
    y: asNumber(note?.y, 0),
    width: Math.max(120, asNumber(note?.width, 240)),
    height: Math.max(60, asNumber(note?.height, 120)),
    // Six accents, matching the system swatches, so a note can be visually
    // tied to the systems it is about.
    accent: Math.max(0, Math.min(5, Math.round(asNumber(note?.accent, 0)))),
  }));
  return { nodes, notes };
}

function normalizeEvent(input = {}) {
  const triggers = ['start', 'stop', 'custom', 'particleDeath', 'particleOverTime', 'particleCollide'];
  return {
    id: asString(input.id) || nextVfxId('evt'),
    trigger: triggers.includes(input.trigger) ? input.trigger : 'start',
    name: asString(input.name),
    sourceSystemId: asString(input.sourceSystemId),
    probability: Math.min(1, Math.max(0, asNumber(input.probability, 1))),
    rate: input.rate === undefined ? undefined : normalizeValue(input.rate),
  };
}

function normalizeExposed(input = {}, index = 0) {
  const types = ['float', 'vec2', 'vec3', 'vec4', 'color', 'bool', 'int', 'texture', 'mesh', 'curve', 'gradient'];
  return {
    id: asString(input.id) || nextVfxId('exp'),
    name: asString(input.name) || `Property ${index + 1}`,
    type: types.includes(input.type) ? input.type : 'float',
    defaultValue: input.defaultValue === undefined ? 0 : input.defaultValue,
    min: Number.isFinite(input.min) ? input.min : undefined,
    max: Number.isFinite(input.max) ? input.max : undefined,
    tooltip: asString(input.tooltip),
    category: asString(input.category),
  };
}

function normalizeEdge(input = {}) {
  const from = input.from && typeof input.from === 'object' ? input.from : {};
  const to = input.to && typeof input.to === 'object' ? input.to : {};
  const edge = {
    id: asString(input.id) || nextVfxId('edge'),
    from: { nodeId: asString(from.nodeId), port: asString(from.port) || 'out' },
    to: {},
  };
  if (to.nodeId) edge.to.nodeId = asString(to.nodeId);
  if (to.port) edge.to.port = asString(to.port);
  if (to.blockId) edge.to.blockId = asString(to.blockId);
  if (to.prop) edge.to.prop = asString(to.prop);
  // A component target is how a scalar curve drives just the y of a vec3, which
  // is the single most common wiring move there is. Modelling it as part of the
  // edge means the author does not have to insert a Compose node by hand - the
  // compiler synthesises it.
  if (Number.isInteger(to.component) && to.component >= 0 && to.component <= 3) {
    edge.to.component = to.component;
  }
  return edge;
}

function normalizeReferences(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [slot, entry] of Object.entries(input)) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = asString(entry.ref);
    // Accept a bare number as well as 'asset:<id>' - a hand-written or
    // model-generated document will produce one - but STORE the canonical
    // string form, because that is what makes invariant 4 hold.
    const canonical = REF_PATTERN.test(ref)
      ? ref
      : (Number.isFinite(entry.ref) ? `asset:${entry.ref >>> 0}` : '');
    out[slot] = {
      kind: Object.values(REF_KIND).includes(entry.kind) ? entry.kind : REF_KIND.IMAGE,
      ref: canonical,
      name: asString(entry.name),
      colorSpace: entry.colorSpace === 'linear' ? 'linear' : 'srgb',
    };
  }
  return out;
}

/**
 * Ordered migration ladder. Each entry upgrades one format to the next, and
 * normalizeVfxDoc applies them in a loop, so a format-1 document opened by a
 * format-4 build walks 1 -> 2 -> 3 -> 4 rather than needing a direct path.
 *
 * @type {ReadonlyArray<{from: number, to: number, migrate: (doc: Object) => Object}>}
 */
export const MIGRATIONS = Object.freeze([]);

/**
 * An empty document. Note it is not actually empty: it carries one system with
 * a pre-wired Spawn -> Initialize -> Output chain.
 *
 * That is deliberate and it is a product decision, not a convenience. A truly
 * blank board is the wrong first screen for someone who has never authored a
 * particle effect - it has no affordance and no feedback. A skeleton that
 * already runs, with zero warnings, gives them something to change.
 *
 * @param {{name?: string}} [options]
 * @returns {VfxDoc}
 */
export function createEmptyVfxDoc(options = {}) {
  const spawn = normalizeContext({ kind: CONTEXT_KIND.SPAWN, blocks: [] });
  const init = normalizeContext({ kind: CONTEXT_KIND.INITIALIZE, blocks: [] });
  const update = normalizeContext({ kind: CONTEXT_KIND.UPDATE, blocks: [] });
  const output = normalizeContext({ kind: CONTEXT_KIND.OUTPUT, blocks: [] });

  const doc = {
    format: VFX_DOC_FORMAT,
    kind: VFX_DOC_KIND,
    savedAt: Date.now(),
    name: asString(options.name) || 'Untitled effect',
    effect: createEffectSettings(),
    systems: [normalizeSystem({
      name: 'Particles',
      contexts: [spawn, init, update, output],
    }, 0)],
    events: [],
    operators: [],
    edges: [],
    exposed: [],
    references: {},
    layout: { nodes: {}, notes: [] },
  };
  return normalizeVfxDoc(doc);
}

// Rebuild every props[...] link from the edge list - invariant 1.
//
// Two directions to get right. An edge that targets a block property makes
// that property a link; a property still claiming to be a link with no edge
// behind it must fall back to its literal. Doing both in one pass is what
// guarantees the mirror and the edges cannot disagree, whatever mutated the
// document.
function reconcileLinks(doc) {
  const wanted = new Map();
  for (const edge of doc.edges) {
    if (!edge.to.blockId || !edge.to.prop) continue;
    const key = `${edge.to.blockId}::${edge.to.prop}`;
    wanted.set(key, edge);
  }

  for (const system of doc.systems) {
    for (const context of system.contexts) {
      for (const block of context.blocks) {
        for (const [prop, value] of Object.entries(block.props)) {
          const edge = wanted.get(`${block.id}::${prop}`);
          if (edge) {
            if (value.mode !== VALUE_MODE.LINK
              || value.nodeId !== edge.from.nodeId
              || value.port !== edge.from.port) {
              block.props[prop] = {
                ...value,
                mode: VALUE_MODE.LINK,
                nodeId: edge.from.nodeId,
                port: edge.from.port,
              };
            }
          } else if (value.mode === VALUE_MODE.LINK) {
            // The edge is gone - the operator was deleted, or the wire was cut.
            // Fall back to the literal every mode carries, so the property
            // keeps working instead of taking the effect down with it.
            const reverted = { ...value, mode: VALUE_MODE.CONST };
            delete reverted.nodeId;
            delete reverted.port;
            block.props[prop] = reverted;
          }
        }
      }
    }
  }
  return doc;
}

// Drop edges whose endpoints no longer exist. Deleting a node leaves dangling
// edges, and React Flow logs an error for every edge it cannot place - so this
// is what keeps the console usable after a delete.
function pruneEdges(doc) {
  const nodeIds = new Set();
  const blockIds = new Set();
  for (const operator of doc.operators) nodeIds.add(operator.id);
  for (const event of doc.events) nodeIds.add(event.id);
  for (const system of doc.systems) {
    for (const context of system.contexts) {
      nodeIds.add(context.id);
      for (const block of context.blocks) blockIds.add(block.id);
    }
  }
  doc.edges = doc.edges.filter((edge) => {
    if (!edge.from.nodeId || !nodeIds.has(edge.from.nodeId)) return false;
    if (edge.to.blockId) return blockIds.has(edge.to.blockId) && Boolean(edge.to.prop);
    if (edge.to.nodeId) return nodeIds.has(edge.to.nodeId);
    return false;
  });
  return doc;
}

/**
 * Bring any document - freshly parsed, hand-edited, model-generated, or from an
 * older format - into the current canonical shape.
 *
 * Everything that reads a document goes through here first, so nothing
 * downstream has to cope with a missing array, an unsorted clip list, a
 * dangling edge or a stale link mirror.
 *
 * @param {Object} input
 * @returns {VfxDoc}
 */
export function normalizeVfxDoc(input) {
  let raw = input && typeof input === 'object' ? input : {};

  // Walk the migration ladder before anything else looks at the shape.
  let format = Math.max(0, Math.round(asNumber(raw.format, VFX_DOC_FORMAT)));
  let guard = 0;
  while (format < VFX_DOC_FORMAT && guard < 64) {
    const step = MIGRATIONS.find((m) => m.from === format);
    if (!step) break;
    raw = step.migrate(raw);
    format = step.to;
    guard += 1;
  }

  const doc = {
    format: VFX_DOC_FORMAT,
    kind: VFX_DOC_KIND,
    savedAt: asNumber(raw.savedAt, Date.now()),
    name: asString(raw.name) || 'Untitled effect',
    effect: normalizeEffectSettings(raw.effect),
    systems: (Array.isArray(raw.systems) ? raw.systems : []).map(normalizeSystem),
    events: (Array.isArray(raw.events) ? raw.events : []).map(normalizeEvent),
    operators: (Array.isArray(raw.operators) ? raw.operators : []).map(normalizeOperator),
    edges: (Array.isArray(raw.edges) ? raw.edges : []).map(normalizeEdge),
    exposed: (Array.isArray(raw.exposed) ? raw.exposed : []).map(normalizeExposed),
    references: normalizeReferences(raw.references),
    layout: normalizeLayout(raw.layout),
  };

  pruneEdges(doc);
  reconcileLinks(doc);
  return doc;
}

/**
 * Parse the numeric asset id out of an 'asset:<id>' string.
 * @param {string} ref
 * @returns {number|null}
 */
export function parseAssetRef(ref) {
  const match = REF_PATTERN.exec(String(ref || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Format an asset id as the canonical reference string.
 * @param {number} id
 * @returns {string}
 */
export function formatAssetRef(id) {
  return `asset:${Number(id) >>> 0}`;
}

/**
 * The digest of asset references that gets mirrored into Assets.metadata.
 *
 * Every list holds 'asset:<id>' STRINGS inside ARRAYS, and both of those
 * details are load-bearing rather than stylistic - see invariant 4 in the
 * header. It is the array branch of storage.js's collectAssetIdsFromValue that
 * finds them on export and remapReferencesDeep that renumbers them on import,
 * and neither needs a line of new code to handle a VFX asset because of it.
 *
 * Mirrored out of the file so the Assets grid, a project export and an MCP
 * client can all see an effect's dependencies without fetching and parsing the
 * graph - the same reasoning as readTreePresetMetadata at server.js:3933.
 *
 * @param {VfxDoc} doc
 * @returns {{textureRefs: string[], meshRefs: string[], vfxRefs: string[],
 *            all: string[], missing: string[]}}
 */
export function collectVfxAssetRefs(doc) {
  const textureRefs = new Set();
  const meshRefs = new Set();
  const vfxRefs = new Set();
  const missing = [];

  for (const [slot, entry] of Object.entries(doc.references || {})) {
    if (!entry.ref) {
      // A slot with no asset behind it. Reported rather than dropped: this is
      // the "choose a sprite" diagnostic's input, and silently omitting it
      // would make an unfinished effect look complete.
      missing.push(slot);
      continue;
    }
    if (entry.kind === REF_KIND.MESH) meshRefs.add(entry.ref);
    else if (entry.kind === REF_KIND.VFX) vfxRefs.add(entry.ref);
    else textureRefs.add(entry.ref);
  }

  const byId = (a, b) => (parseAssetRef(a) || 0) - (parseAssetRef(b) || 0);
  const texture = [...textureRefs].sort(byId);
  const mesh = [...meshRefs].sort(byId);
  const vfx = [...vfxRefs].sort(byId);
  return {
    textureRefs: texture,
    meshRefs: mesh,
    vfxRefs: vfx,
    all: [...new Set([...texture, ...mesh, ...vfx])].sort(byId),
    missing: missing.sort(),
  };
}

/**
 * A stable string identifying everything about a document that affects the
 * SIMULATION, and nothing that does not.
 *
 * This is the recompile trigger, so what it omits matters as much as what it
 * includes: `layout` and `savedAt` are excluded (invariant 2), which is what
 * lets an author drag nodes around a board with a 60k-particle effect running
 * without rebuilding it every frame. `solo` is excluded too - it is a
 * debugging toggle, and muting a system to look at another one should not
 * restart the effect.
 *
 * @param {VfxDoc} doc
 * @returns {string}
 */
export function vfxSignature(doc) {
  const stripped = {
    format: doc.format,
    effect: doc.effect,
    systems: doc.systems.map((system) => ({
      id: system.id,
      enabled: system.enabled,
      capacity: system.capacity,
      simulationSpace: system.simulationSpace,
      seedOffset: system.seedOffset,
      schedule: system.schedule,
      contexts: system.contexts.map((context) => ({
        id: context.id,
        kind: context.kind,
        params: context.params,
        blocks: context.blocks.map((block) => ({
          id: block.id,
          type: block.type,
          enabled: block.enabled,
          props: block.props,
          modes: block.modes,
        })),
      })),
    })),
    events: doc.events,
    operators: doc.operators,
    edges: doc.edges,
    exposed: doc.exposed,
    references: doc.references,
  };
  return JSON.stringify(stripped);
}

/**
 * The metadata digest mirrored into the asset row alongside the graph file.
 *
 * DEFINED ONCE, HERE, BECAUSE TWO CALLERS WRITE IT AND THEY MUST AGREE. The
 * editor saves through src/utils/vfxApi.js and an agent saves through
 * mcp/tools/vfx.js; a digest that differed between them would mean an effect's
 * textures travelled inside a .3dgp when a human saved it and not when an agent
 * did - which is the kind of bug that only shows up in a second installation.
 *
 * THE REFS ARE `asset:<id>` STRINGS IN ARRAYS, and that is the whole trick. It
 * is the exact shape storage.js's collectAssetIdsFromValue already matches and
 * remapReferencesDeep already rewrites, so a VFX effect's dependencies travel
 * through project export and get renumbered on import with NO changes to either
 * walker. Tree presets store bare numbers and therefore ship broken across
 * installations - that is the cautionary tale, not the model.
 *
 * @param {VfxDoc} doc a NORMALISED document
 * @param {{source?: string}} [options] who wrote it, for support questions
 * @returns {Object} a plain, JSON-safe digest
 */
export function vfxAssetDigest(doc, options = {}) {
  const refs = collectVfxAssetRefs(doc);
  const blockCount = doc.systems.reduce((total, system) => total + system.contexts.reduce(
    (sum, context) => sum + context.blocks.length,
    0,
  ), 0);
  return {
    source: options.source || 'VFX',
    kind: 'vfx-graph',
    format: doc.format,
    duration: doc.effect.duration,
    looping: doc.effect.loop,
    systemCount: doc.systems.length,
    blockCount,
    textureRefs: refs.textureRefs,
    meshRefs: refs.meshRefs,
  };
}

/**
 * Serialise for saving. Bumps savedAt and refreshes the reference digest so the
 * file and the metadata mirror can never be written out of step.
 *
 * @param {VfxDoc} doc
 * @param {{name?: string}} [options]
 * @returns {{doc: VfxDoc, refs: ReturnType<typeof collectVfxAssetRefs>}}
 */
export function serializeVfxDoc(doc, options = {}) {
  const normalized = normalizeVfxDoc(doc);
  normalized.savedAt = Date.now();
  if (options.name) normalized.name = options.name;
  return { doc: normalized, refs: collectVfxAssetRefs(normalized) };
}
