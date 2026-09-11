// Checks for the document edits and the React Flow adapter.
// No test framework - run it directly:
//
//     node src/utils/vfx/edits.test.mjs
//
// WHY THESE TWO MODULES GET A SUITE OF THEIR OWN. Everything the author does in
// the editor goes through src/utils/vfx/edits.js, and their bugs are the hardest
// kind to see: a reorder that silently drops a block, a property write that
// lands on the wrong instance of a duplicated block, an unwire that leaves the
// link mirror claiming a node that is gone. None of those throws, and all of
// them look like "the effect just went wrong" from the UI.
//
// TWO PROPERTIES ARE CHECKED ON EVERY MUTATOR, because the whole undo system
// rests on them:
//
//   1. IMMUTABILITY. The history is snapshot-based, so an edit that mutated in
//      place would corrupt every entry already on the stack - and the corruption
//      would only show up when the author pressed undo, long after the edit.
//      Checked by deep-comparing a serialised copy of the input taken before
//      the call.
//   2. IDENTITY ON A NO-OP. An edit that changed nothing must return the SAME
//      object, because useVfxHistory uses reference equality to decide whether
//      to push an entry. Returning a fresh-but-equal document would make a
//      refused edit (a move to the index it is already at, removing a track's
//      last clip) cost the author an undo press that appears to do nothing.
//
// KNOWN GAP: nothing here renders. The adapter's output is checked for shape
// and for the invariants React Flow imposes - stable identities, a handle
// mounted for every edge - but whether a node LOOKS right is phase 6's manual
// pass.

import { CATALOG } from '../../../vfx/catalog.js';
import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc, vfxSignature } from '../../../vfx/doc.js';
import { compileVfxGraph } from '../../../vfx/compile.js';
import { VALUE_MODE } from '../../../vfx/value.js';
import { CURVE_PRESETS } from '../../../vfx/curve.js';
import { VFX_TEMPLATES, templateById } from './templates.js';
import { emitterGizmos, gizmoMeshAssetId } from './gizmos.js';
import { indexLibraryAssets, vfxAssetId } from './library.js';
import * as edits from './edits.js';
import {
  HANDLE_WIDTH_PX,
  MIN_BODY_PX,
  clipHandles,
  clipWidth,
  resolveClipDrag,
  snapToStep,
} from './timelineDrag.js';
import {
  autoLayout,
  systemIdForSelection,
  clearLayout,
  indexDiagnostics,
  setNodePosition,
  toFlowEdges,
  toFlowNodes,
  wiredPropsByContext,
  wiredPropsForContext,
} from './flow.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(58)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const clone = (doc) => JSON.parse(JSON.stringify(doc));
// The stage order the layout uses, restated here rather than exported: a test
// that imported the module's own constant could not catch the order changing.
const STAGE_ORDER = [
  CONTEXT_KIND.EVENT, CONTEXT_KIND.SPAWN, CONTEXT_KIND.INITIALIZE,
  CONTEXT_KIND.UPDATE, CONTEXT_KIND.OUTPUT,
];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const blocksOf = (doc) => doc.systems.flatMap((s) => s.contexts.flatMap((c) => c.blocks));
const countBlocks = (doc) => blocksOf(doc).length;

/**
 * Run a mutator and assert it did not touch its input.
 *
 * The comparison is on a serialised snapshot taken BEFORE the call, so a
 * mutation anywhere in the tree is caught - not just at the top level, which is
 * where a spread accidentally shares a nested array.
 */
function pure(label, doc, fn) {
  const before = JSON.stringify(doc);
  const next = fn(doc);
  check(`${label} leaves its input alone`, JSON.stringify(doc) === before);
  return next;
}

const base = () => normalizeVfxDoc(VFX_TEMPLATES.find((t) => t.id === 'sparks').build());

let n = 0;
const section = (title) => console.log(`\n--- ${n += 1}. ${title} ---`);

// ---------------------------------------------------------------------------
section('Blocks: add, remove, duplicate, toggle');
// ---------------------------------------------------------------------------
{
  const doc = base();
  const update = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE);

  const added = pure('addBlock', doc, (d) => edits.addBlock(d, {
    contextId: update.id,
    blockType: 'update.drag',
  }));
  check('addBlock appends to the right context',
    added.systems[0].contexts.find((c) => c.id === update.id).blocks.at(-1).type === 'update.drag');
  check('  with the catalog defaults filled in',
    added.systems[0].contexts.find((c) => c.id === update.id).blocks.at(-1).props.drag !== undefined);
  check('  and a fresh id',
    new Set(blocksOf(added).map((b) => b.id)).size === countBlocks(added));

  check('addBlock refuses an unknown type',
    edits.addBlock(doc, { contextId: update.id, blockType: 'nope.nope' }) === doc);
  // The catalog says which contexts accept which block; a gravity block in an
  // Initialize stage would compile to nothing and confuse the author far more
  // than a refused click.
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  check('addBlock refuses a block that context cannot hold',
    edits.addBlock(doc, { contextId: init.id, blockType: 'update.gravity' }) === doc);

  const target = blocksOf(doc)[0];
  const removed = pure('removeBlock', doc, (d) => edits.removeBlock(d, target.id));
  check('removeBlock removes exactly one', countBlocks(removed) === countBlocks(doc) - 1);
  check('  and it is the right one', !blocksOf(removed).some((b) => b.id === target.id));
  check('removeBlock on a missing id is identity',
    edits.removeBlock(doc, 'blk_nope') === doc);

  const duped = pure('duplicateBlock', doc, (d) => edits.duplicateBlock(d, target.id));
  check('duplicateBlock adds one', countBlocks(duped) === countBlocks(doc) + 1);
  check('  with a NEW id, not the original',
    new Set(blocksOf(duped).map((b) => b.id)).size === countBlocks(duped));

  const off = pure('toggleBlock', doc, (d) => edits.toggleBlock(d, target.id));
  check('toggleBlock disables', blocksOf(off).find((b) => b.id === target.id).enabled === false);
  check('  and toggles back',
    blocksOf(edits.toggleBlock(off, target.id)).find((b) => b.id === target.id).enabled === true);
  // A disabled block must survive a save, or turning something off and reopening
  // the effect would quietly turn it back on.
  check('  and the disabled flag survives a normalise',
    normalizeVfxDoc(clone(off)).systems.flatMap((s) => s.contexts.flatMap((c) => c.blocks))
      .find((b) => b.id === target.id).enabled === false);
}

// ---------------------------------------------------------------------------
section('Reordering');
// ---------------------------------------------------------------------------
{
  const doc = base();
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  check('the fixture has enough blocks to reorder', init.blocks.length >= 3,
    `${init.blocks.length}`);

  const first = init.blocks[0].id;
  const moved = pure('moveBlock', doc, (d) => edits.moveBlock(d, first, { toIndex: 2 }));
  const after = moved.systems[0].contexts.find((c) => c.id === init.id).blocks;
  check('moveBlock lands at the requested index', after[2].id === first);
  check('  and keeps every block', after.length === init.blocks.length);
  check('  and loses none of the others',
    new Set(after.map((b) => b.id)).size === after.length);

  // Reference identity, not deep equality: useVfxHistory pushes an entry only
  // when the document object actually changed.
  check('moveBlock to the same index is identity',
    edits.moveBlock(doc, first, { toIndex: 0 }) === doc);
  check('moveBlock past the end clamps rather than dropping',
    edits.moveBlock(doc, first, { toIndex: 99 })
      .systems[0].contexts.find((c) => c.id === init.id).blocks.length === init.blocks.length);

  // Cross-context moves are a menu item, not a drag, precisely because they can
  // be illegal - so the mutator has to enforce what the menu offers.
  const gravity = blocksOf(doc).find((b) => b.type === 'update.gravity');
  if (gravity) {
    check('moveBlock refuses a context that cannot hold the block',
      edits.moveBlock(doc, gravity.id, { toContextKind: CONTEXT_KIND.INITIALIZE }) === doc);
  }
}

// ---------------------------------------------------------------------------
section('Properties and value modes');
// ---------------------------------------------------------------------------
{
  const doc = base();
  const lifetime = blocksOf(doc).find((b) => b.type === 'initialize.setLifetime');

  const set = pure('setBlockProp', doc, (d) => edits.setBlockProp(d, lifetime.id, 'lifetime', 2.5));
  check('setBlockProp normalises a bare number into a value',
    blocksOf(set).find((b) => b.id === lifetime.id).props.lifetime.mode === VALUE_MODE.CONST);
  check('  and stores it', blocksOf(set).find((b) => b.id === lifetime.id).props.lifetime.v === 2.5);

  const random = pure('setBlockPropMode', set,
    (d) => edits.setBlockPropMode(d, lifetime.id, 'lifetime', VALUE_MODE.RANDOM));
  const range = blocksOf(random).find((b) => b.id === lifetime.id).props.lifetime;
  check('switching to random derives a range around the value',
    range.mode === VALUE_MODE.RANDOM && range.a < 2.5 && range.b > 2.5,
    `${range.a} to ${range.b}`);
  // The catalog's min is what stops a derived range offering a negative
  // lifetime, which is the one value that makes a particle system misbehave
  // rather than merely look wrong.
  check('  and never below the catalog minimum',
    range.a >= (CATALOG.block('initialize.setLifetime').props.lifetime.min ?? -Infinity));

  const backToConst = edits.setBlockPropMode(random, lifetime.id, 'lifetime', VALUE_MODE.CONST);
  const roundTrip = edits.setBlockPropMode(backToConst, lifetime.id, 'lifetime', VALUE_MODE.RANDOM);
  const restored = blocksOf(roundTrip).find((b) => b.id === lifetime.id).props.lifetime;
  // THE PROMISE THE MODE SWITCH MAKES. If this fails, the switch is a trap and
  // authors stop touching it.
  check('random -> const -> random restores the original range',
    restored.a === range.a && restored.b === range.b,
    `${restored.a} to ${restored.b}`);

  // The blocks these checks need are ADDED rather than looked for. The first
  // version of this section guarded on `if (size)` and the sparks fixture has
  // neither a Spawn Rate nor a Size Over Life - so every check inside silently
  // did not run. A vacuous test is worse than a missing one, because it reports
  // success.
  const updateStage = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE);
  const spawnStage = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.SPAWN);
  let rich = edits.addBlock(doc, {
    contextId: updateStage.id,
    blockType: 'update.sizeOverLife',
  });
  rich = edits.addBlock(rich, { contextId: spawnStage.id, blockType: 'spawn.rate' });

  const size = blocksOf(rich).find((b) => b.type === 'update.sizeOverLife');
  const rate = blocksOf(rich).find((b) => b.type === 'spawn.rate');
  check('the fixture really has the blocks these checks need',
    Boolean(size) && Boolean(rate));

  const spike = pure('setCurvePreset', rich,
    (d) => edits.setCurvePreset(d, size.id, 'scale', 'rampDown'));
  const shaped = blocksOf(spike).find((b) => b.id === size.id).props.scale;
  const expected = CURVE_PRESETS.find((entry) => entry.id === 'rampDown').build();
  check('setCurvePreset writes the preset shape',
    shaped.curve.keys.length === expected.keys.length
    && Math.abs(shaped.curve.keys[0].v - expected.keys[0].v) < 1e-9,
    `${shaped.curve.keys.length} keys, first ${shaped.curve.keys[0].v}`);
  check('setCurvePreset refuses an unknown preset',
    edits.setCurvePreset(rich, size.id, 'scale', 'nope') === rich);

  // WHICH AXIS A CURVE RUNS ALONG IS THE PROPERTY'S MEANING, NOT A CHOICE. A
  // spawn rate is a property of the emitter and has no particle whose age could
  // be read, so the catalog declares it as a curve over effect TIME. Before it
  // was declared, three places disagreed: the value said 'life', the runtime
  // sampled effect time anyway (readSpawnScalar has no particle to ask), and
  // the curve editor labelled its x axis "particle age".
  const curved = edits.setBlockPropMode(rich, rate.id, 'rate', VALUE_MODE.CURVE);
  check('a spawn rate becomes a curve over effect TIME',
    blocksOf(curved).find((b) => b.id === rate.id).props.rate.domain === 'time',
    blocksOf(curved).find((b) => b.id === rate.id).props.rate.domain);
  // Picking a shape must not silently move it onto the other axis.
  const reshaped = edits.setCurvePreset(curved, rate.id, 'rate', 'rampDown');
  check('  and a preset preserves the domain',
    blocksOf(reshaped).find((b) => b.id === rate.id).props.rate.domain === 'time');
  // The compiler carries it, which is what makes the frequency classification
  // honest: a per-frame value rather than a per-particle one.
  const spawnBindings = compileVfxGraph(reshaped).ir.systems[0].spawn
    .flatMap((entry) => entry.bindings)
    .filter((binding) => binding.prop === 'rate');
  check('  and the IR carries it through to the binding',
    spawnBindings.length > 0 && spawnBindings.every((b) => b.domain === 'time'),
    spawnBindings.map((b) => b.domain).join(','));

  check('an over-life property stays on the life axis',
    blocksOf(edits.setCurvePreset(rich, size.id, 'scale', 'rampDown'))
      .find((b) => b.id === size.id).props.scale.domain === 'life');

  check('setBlockProp on a missing block is identity',
    edits.setBlockProp(doc, 'blk_nope', 'x', 1) === doc);
}

// ---------------------------------------------------------------------------
section('Systems, contexts and clips');
// ---------------------------------------------------------------------------
{
  const doc = base();

  const withSystem = pure('addSystem', doc, (d) => edits.addSystem(d));
  check('addSystem adds one', withSystem.systems.length === doc.systems.length + 1);
  check('  that is immediately doing something',
    withSystem.systems.at(-1).contexts.length >= 3,
    `${withSystem.systems.at(-1).contexts.length} stages`);
  check('  and has a clip, so it emits',
    withSystem.systems.at(-1).schedule.clips.length === 1);

  const duped = pure('duplicateSystem', doc, (d) => edits.duplicateSystem(d, doc.systems[0].id));
  check('duplicateSystem adds one', duped.systems.length === doc.systems.length + 1);
  const ids = new Set();
  let collision = false;
  for (const block of blocksOf(duped)) {
    if (ids.has(block.id)) collision = true;
    ids.add(block.id);
  }
  // A duplicate that reused block ids would make every property write hit both
  // copies - the bug that looks like "editing one system changes the other".
  check('  with no id collisions anywhere in it', !collision);

  const removed = pure('removeSystem', duped, (d) => edits.removeSystem(d, duped.systems[0].id));
  check('removeSystem removes one', removed.systems.length === duped.systems.length - 1);
  check('removeSystem refuses to empty the effect',
    edits.removeSystem(doc, doc.systems[0].id).systems.length >= 1);

  const clipped = pure('addClip', doc, (d) => edits.addClip(d, doc.systems[0].id, {
    at: 0.5,
    duration: 0.25,
  }));
  check('addClip adds one', clipped.systems[0].schedule.clips.length
    === doc.systems[0].schedule.clips.length + 1);
  check('  sorted by time',
    clipped.systems[0].schedule.clips.every((c, i, all) => i === 0 || all[i - 1].at <= c.at));

  const clip = clipped.systems[0].schedule.clips.find((c) => c.at === 0.5);
  const retimed = pure('updateClip', clipped,
    (d) => edits.updateClip(d, doc.systems[0].id, clip.id, { at: 0.75 }));
  check('updateClip retimes it',
    retimed.systems[0].schedule.clips.some((c) => c.id === clip.id && c.at === 0.75));
  // duration 0 is a one-shot burst and has to survive - most impacts are built
  // from them, and a "helpful" minimum would silently turn every burst into a
  // window.
  const burst = edits.updateClip(clipped, doc.systems[0].id, clip.id, { duration: 0 });
  check('  and a zero duration survives, because that is a burst',
    burst.systems[0].schedule.clips.find((c) => c.id === clip.id).duration === 0);

  check('removeClip removes one',
    edits.removeClip(clipped, doc.systems[0].id, clip.id)
      .systems[0].schedule.clips.length === clipped.systems[0].schedule.clips.length - 1);
  // A track with no clips would never emit, and the author would be looking at a
  // system that silently does nothing with no indication why.
  const single = edits.removeClip(clipped, doc.systems[0].id, clip.id);
  check("removeClip refuses a track's last clip",
    edits.removeClip(single, doc.systems[0].id, single.systems[0].schedule.clips[0].id) === single);
}

// ---------------------------------------------------------------------------
section('Operators and wiring');
// ---------------------------------------------------------------------------
{
  let doc = base();
  doc = edits.addOperator(doc, 'op.constant', { x: 700, y: 40 });
  const node = doc.operators[0];
  check('addOperator adds a node', doc.operators.length === 1);
  check('  with catalog defaults', doc.operators[0].props.value.v === 1);
  check('  and remembers where it was dropped', doc.layout.nodes[node.id].x === 700);
  check('addOperator refuses an unknown type',
    edits.addOperator(doc, 'op.nope') === doc);

  const size = blocksOf(doc).find((b) => b.type === 'initialize.setSize');
  const wired = pure('addEdge', doc, (d) => edits.addEdge(d, {
    fromNodeId: node.id,
    blockId: size.id,
    prop: 'size',
  }));
  check('addEdge stores the wire', wired.edges.length === 1);
  // THE INVARIANT: edges are authoritative and normalizeVfxDoc derives the
  // property's mirror from them. No UI code ever writes mode: 'link'.
  check("  and the property's mode is DERIVED from it, not written",
    blocksOf(wired).find((b) => b.id === size.id).props.size.mode === VALUE_MODE.LINK);
  check('  naming the source node',
    blocksOf(wired).find((b) => b.id === size.id).props.size.nodeId === node.id);

  const twice = edits.addEdge(wired, { fromNodeId: node.id, blockId: size.id, prop: 'size' });
  check('a second wire into one property REPLACES rather than stacking',
    twice.edges.length === 1);

  const unwired = pure('removeEdge', wired, (d) => edits.removeEdge(d, wired.edges[0].id));
  check('removeEdge drops the wire', unwired.edges.length === 0);
  check('  and the property falls back to a constant',
    blocksOf(unwired).find((b) => b.id === size.id).props.size.mode === VALUE_MODE.CONST);
  check('removeEdge on a missing id is identity', edits.removeEdge(unwired, 'edge_nope') === unwired);

  check('unwireProp removes by destination',
    edits.unwireProp(wired, size.id, 'size').edges.length === 0);
  check('  and is identity when nothing feeds it',
    edits.unwireProp(unwired, size.id, 'size') === unwired);

  // Deleting a node must take its wiring with it, or normalizeVfxDoc's dangling
  // sweep would drop the edge later and React Flow would log for every edge it
  // could not place in between.
  const gone = pure('removeOperator', wired, (d) => edits.removeOperator(d, node.id));
  check('removeOperator takes its wires with it',
    gone.operators.length === 0 && gone.edges.length === 0);
  check('  and the property it fed still works',
    blocksOf(gone).find((b) => b.id === size.id).props.size.mode === VALUE_MODE.CONST);

  const valued = pure('setOperatorProp', wired,
    (d) => edits.setOperatorProp(d, node.id, 'value', 4));
  check('setOperatorProp writes through', valued.operators[0].props.value.v === 4);
  check('setOperatorProp on a missing node is identity',
    edits.setOperatorProp(wired, 'op_nope', 'value', 1) === wired);
}

// ---------------------------------------------------------------------------
section('Layout is cosmetic');
// ---------------------------------------------------------------------------
{
  const doc = base();
  const contextId = doc.systems[0].contexts[0].id;
  const moved = pure('setNodePosition', doc, (d) => setNodePosition(d, contextId, { x: 12.4, y: 88.6 }));
  check('setNodePosition stores a rounded position',
    moved.layout.nodes[contextId].x === 12 && moved.layout.nodes[contextId].y === 89);

  // A stored position must not disturb the ones already there, or moving one
  // node would erase the layout of everything the author had placed by hand.
  const stages = doc.systems[0].contexts;
  const secondId = stages[1].id;
  check('the fixture has a second stage to leave alone',
    Boolean(secondId) && secondId !== contextId);
  const seeded = setNodePosition(doc, secondId, { x: 500, y: 500 });
  const after = setNodePosition(seeded, contextId, { x: 1, y: 2 });
  check('  other stored positions are untouched',
    after.layout.nodes[secondId]?.x === 500, JSON.stringify(after.layout.nodes[secondId]));

  // THE REASON layout is a separate branch of the document: vfxSignature is the
  // recompile trigger, and dragging a node must not recompile the effect or the
  // simulation would restart every time the board was tidied.
  check('moving a node does NOT change the recompile signature',
    vfxSignature(moved) === vfxSignature(doc));
  const a = compileVfxGraph(doc).ir.graphHash;
  const b = compileVfxGraph(moved).ir.graphHash;
  check('  and does not change the compiled graph hash', a === b, `${a} vs ${b}`);

  check('clearLayout forgets every position',
    Object.keys(clearLayout(moved).layout.nodes).length === 0);
}

// ---------------------------------------------------------------------------
section('The React Flow adapter');
// ---------------------------------------------------------------------------
{
  const doc = normalizeVfxDoc(VFX_TEMPLATES.find((t) => t.id === 'muzzleFlash').build());
  const nodes = toFlowNodes(doc);
  const edges = toFlowEdges(doc);
  const contexts = doc.systems.flatMap((s) => s.contexts);

  check('every context becomes a node', nodes.filter((x) => x.type === 'vfxContext').length
    === contexts.length, `${nodes.length} nodes`);
  check('node ids are unique', new Set(nodes.map((x) => x.id)).size === nodes.length);
  check('every node has a finite position',
    nodes.every((x) => Number.isFinite(x.position.x) && Number.isFinite(x.position.y)));
  // Only the header may drag: the node body is a list of interactive controls,
  // and a draggable card would swallow the pointerdown on every one of them.
  check('every node restricts dragging to its header',
    nodes.every((x) => x.dragHandle === '.vfx-node__drag-handle'));

  check('the derived stage chain is drawn', edges.length > 0, `${edges.length} edges`);
  check('  with unique ids', new Set(edges.map((e) => e.id)).size === edges.length);
  const ids = new Set(nodes.map((x) => x.id));
  // React Flow logs for every edge whose endpoints it cannot find, and a board
  // that logs on every render is a board nobody will debug.
  check('  and both endpoints of every edge exist',
    edges.every((e) => ids.has(e.source) && ids.has(e.target)));

  // Flow edges are derived from which stages a system HAS, so an illegal order
  // is unrepresentable rather than merely rejected.
  const flowEdges = edges.filter((e) => e.type === 'vfxFlow');
  const order = [CONTEXT_KIND.EVENT, CONTEXT_KIND.SPAWN, CONTEXT_KIND.INITIALIZE,
    CONTEXT_KIND.UPDATE, CONTEXT_KIND.OUTPUT];
  const kindOf = (id) => contexts.find((c) => c.id === id)?.kind;
  check('  and every flow edge runs forwards through the stages',
    flowEdges.every((e) => order.indexOf(kindOf(e.source)) < order.indexOf(kindOf(e.target))));

  // The same document must produce the same layout twice, or a re-render would
  // shuffle the board.
  const again = toFlowNodes(doc);
  check('the adapter is deterministic',
    JSON.stringify(nodes.map((x) => [x.id, x.position])) === JSON.stringify(again.map((x) => [x.id, x.position])));

  // EVERY SELECTABLE NODE KIND MUST BE ABLE TO REPORT ITSELF SELECTED.
  //
  // Only contexts ever did. React Flow fills `selected` in from its own
  // selection state, which this board never applies - select changes are
  // dropped on purpose, because the document owns selection - so a field the
  // adapter does not write is a field that is permanently false. That was not a
  // cosmetic gap: a note's NodeResizer is gated on `selected`, so notes could
  // not be resized at all, and a selected operator drew no ring while its
  // Parameters panel was open, so the board and the panel disagreed about what
  // the author was editing.
  //
  // Checked as a SET rather than one kind at a time, so a node type added later
  // fails here rather than shipping with the same omission.
  {
    let noted = edits.addNote(doc, { x: 10, y: 20 });
    noted = edits.addOperator(noted, 'op.constant', { x: 0, y: 0 });
    const noteId = noted.layout.notes[0].id;
    const operatorId = noted.operators[noted.operators.length - 1].id;
    const contextId2 = noted.systems[0].contexts[0].id;
    check('the fixture has one node of each selectable kind',
      Boolean(noteId && operatorId && contextId2));

    const kinds = [
      ['context', contextId2, { selectedContextId: contextId2 }],
      ['operator', operatorId, { selectedOperatorId: operatorId }],
      ['note', noteId, { selectedNoteId: noteId }],
    ];
    for (const [label, id, options] of kinds) {
      const built = toFlowNodes(noted, options);
      const target = built.find((x) => x.id === id);
      check(`a selected ${label} reports selected`, target?.selected === true,
        String(target?.selected));
      // And exactly one node does, or clicking one thing would ring several.
      check(`  and it is the only one`,
        built.filter((x) => x.selected).length === 1,
        String(built.filter((x) => x.selected).length));
    }
    check('with nothing selected, no node is',
      toFlowNodes(noted).every((x) => !x.selected));
  }

  // THE STAGE CHAIN RUNS LEFT TO RIGHT AND A SYSTEM IS A ROW.
  //
  // It used to run top to bottom, one column per system. The reason to
  // transpose it is that a context node GROWS DOWNWARD as blocks are added, so
  // a vertical chain put the flow direction and the growth direction on the
  // same axis: every block added to Initialize pushed Update and Output further
  // away. Across, they are perpendicular and adding a block moves nothing.
  //
  // Asserted on the DERIVED layout, which is what an author sees before they
  // have dragged anything - and the thing a later refactor is most likely to
  // rotate back without noticing.
  {
    const fresh = toFlowNodes(doc);
    const byId = new Map(fresh.map((node) => [node.id, node]));
    let checkedSystems = 0;
    let sameRow = 0;
    let increasing = 0;
    for (const system of doc.systems) {
      const ordered = system.contexts.slice()
        .sort((a, b) => STAGE_ORDER.indexOf(a.kind) - STAGE_ORDER.indexOf(b.kind));
      if (ordered.length < 2) continue;
      checkedSystems += 1;
      const ys = new Set(ordered.map((c) => byId.get(c.id).position.y));
      if (ys.size === 1) sameRow += 1;
      const xs = ordered.map((c) => byId.get(c.id).position.x);
      if (xs.every((x, i) => i === 0 || x > xs[i - 1])) increasing += 1;
    }
    check('the fixture has a multi-stage system to check', checkedSystems > 0,
      `${checkedSystems} systems`);
    check('every stage of a system shares one row', sameRow === checkedSystems);
    check('  and x increases along the stage order', increasing === checkedSystems);
    // Two systems must not share a row, or they would draw on top of each other.
    if (doc.systems.length > 1) {
      const rowOf = (system) => byId.get(system.contexts[0].id).position.y;
      check('  and each system gets its own row',
        new Set(doc.systems.map(rowOf)).size === doc.systems.length);
    }
    check('  the fixture has more than one system', doc.systems.length > 1,
      `${doc.systems.length}`);
  }

  // THE BOARD SHOWS ONE SYSTEM AT A TIME.
  //
  // A four-system explosion is twenty context nodes, and an author works on one
  // emitter at a time - the rest is scenery to pan past. The filter has to
  // reach BOTH adapters: React Flow logs a warning for every edge whose
  // endpoints it cannot find, so filtering the nodes alone would make a
  // three-system effect log on every render.
  {
    const many = doc.systems.length;
    check('the fixture has several systems to filter', many > 1, `${many}`);
    const target = doc.systems[1];

    const all = toFlowNodes(doc);
    const one = toFlowNodes(doc, { systemId: target.id });
    check('filtering shows fewer nodes', one.length < all.length,
      `${one.length} of ${all.length}`);
    check('  and exactly the contexts of that system',
      one.filter((n) => n.type === 'vfxContext').length === target.contexts.length,
      `${one.filter((n) => n.type === 'vfxContext').length} vs ${target.contexts.length}`);
    check('  none of them from another system',
      one.filter((n) => n.type === 'vfxContext')
        .every((n) => target.contexts.some((c) => c.id === n.id)));

    // EVERY EDGE MUST STILL HAVE BOTH ENDS. This is the check that would catch
    // filtering one adapter and forgetting the other.
    const visible = new Set(one.map((n) => n.id));
    const dangling = toFlowEdges(doc, { systemId: target.id })
      .filter((e) => !visible.has(e.source) || !visible.has(e.target));
    check('  and no edge is left with a missing end', dangling.length === 0,
      dangling.map((e) => e.id).join(' '));

    // Unfiltered is unchanged, so the board can still show everything.
    check('  while no filter still shows every system',
      all.filter((n) => n.type === 'vfxContext').length
      === doc.systems.reduce((sum, sys) => sum + sys.contexts.length, 0));
  }

  // WHICH SYSTEM THE SELECTION MEANS. The board and the timeline have to agree,
  // so the answer comes from the selection rather than from a separate
  // "current system" the author sets by hand.
  {
    const system = doc.systems[1];
    const context = system.contexts[0];
    const block = context.blocks[0];
    check('the fixture has a block to select', Boolean(block), context.kind);

    check('selecting a system names itself',
      systemIdForSelection(doc, { kind: 'system', id: system.id }) === system.id);
    check('selecting a context names its system',
      systemIdForSelection(doc, { kind: 'context', id: context.id }) === system.id);
    check('selecting a block names its system too',
      systemIdForSelection(doc, { kind: 'block', id: block.id }) === system.id);

    // null means "leave the board where it is", NOT "show nothing" - an
    // operator and a note belong to no system, and the effect itself belongs to
    // all of them.
    check('an operator belongs to no system',
      systemIdForSelection(doc, { kind: 'operator', id: 'op-whatever' }) === null);
    check('  and so does the effect', systemIdForSelection(doc, { kind: 'effect', id: 'effect' }) === null);
    check('  and nothing selected', systemIdForSelection(doc, null) === null);
    check('a system id that no longer exists is null, not itself',
      systemIdForSelection(doc, { kind: 'system', id: 'sys-deleted' }) === null);
  }

  // A stored position must win over the derived one, or dragging a node would
  // appear to do nothing after the next render.
  const first = contexts[0].id;
  const pinned = setNodePosition(doc, first, { x: -400, y: -300 });
  check('a stored position overrides the derived one',
    toFlowNodes(pinned).find((x) => x.id === first).position.x === -400);
}

// ---------------------------------------------------------------------------
section('Lazily-mounted property handles');
// ---------------------------------------------------------------------------
{
  let doc = base();
  doc = edits.addOperator(doc, 'op.constant');
  const node = doc.operators[0];
  const size = blocksOf(doc).find((b) => b.type === 'initialize.setSize');
  doc = edits.addEdge(doc, { fromNodeId: node.id, blockId: size.id, prop: 'size' });

  const owner = doc.systems.flatMap((s) => s.contexts)
    .find((c) => c.blocks.some((b) => b.id === size.id));

  const grouped = wiredPropsByContext(doc);
  const single = wiredPropsForContext(doc, owner.id);
  check('the wired property is reported on its own context',
    grouped.get(owner.id)?.length === 1 && grouped.get(owner.id)[0].prop === 'size');
  // Two implementations of the same question - one grouped for the whole
  // document, one per context - so they have to agree.
  check('  and the grouped and per-context walks agree',
    JSON.stringify(grouped.get(owner.id)) === JSON.stringify(single));
  check('an unwired context reports nothing',
    (grouped.get(doc.systems[0].contexts.find((c) => c.id !== owner.id).id) || []).length === 0);

  // THE INVARIANT THAT MAKES LAZY HANDLES SAFE: React Flow keeps an edge in
  // state when its targetHandle has no mounted handle, but cannot render it and
  // logs. So there must be a handle for every data edge.
  const dataEdges = toFlowEdges(doc).filter((e) => e.type === 'vfxData');
  const mounted = new Set();
  for (const [contextId, list] of grouped) {
    for (const entry of list) mounted.add(`${contextId}|prop:${entry.blockId}:${entry.prop}`);
  }
  check('every data edge has a handle to land on',
    dataEdges.every((e) => mounted.has(`${e.target}|${e.targetHandle}`)),
    dataEdges.map((e) => e.targetHandle).join(', '));

  // A NON-HOT property must be reported too. The block row shows only hot
  // properties inline, and the first version of it therefore mounted handles
  // only for those - so expanding a block whose wire landed on a non-hot
  // property unmounted that handle while its edge was still alive. The pure
  // half of that fix is here; the JSX half is in VfxBlockRow.
  let deep = base();
  deep = edits.addOperator(deep, 'op.constant');
  const initStage = deep.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  deep = edits.addBlock(deep, { contextId: initStage.id, blockType: 'initialize.positionCone' });
  const cone = blocksOf(deep).find((b) => b.type === 'initialize.positionCone');
  check('  (the fixture has a block with a non-hot property)', Boolean(cone));
  if (cone) {
    const hot = CATALOG.block('initialize.positionCone').props.radius.hot;
    check('  (the fixture property really is non-hot)', !hot);
    deep = edits.addEdge(deep, {
      fromNodeId: deep.operators[0].id,
      blockId: cone.id,
      prop: 'radius',
    });
    const owning = deep.systems.flatMap((sys) => sys.contexts)
      .find((c) => c.blocks.some((b) => b.id === cone.id));
    check('a wire into a non-hot property is still reported',
      (wiredPropsByContext(deep).get(owning.id) || []).some((e) => e.prop === 'radius'));
  }

  // A context with no wires must get a STABLE empty array, or every node's data
  // object would be a new identity on every render and the memoisation that
  // keeps a forty-node board responsive would do nothing.
  const a = toFlowNodes(doc);
  const b = toFlowNodes(doc);
  const bare = a.find((x) => x.type === 'vfxContext' && x.data.wiredProps.length === 0);
  const bareAgain = b.find((x) => x.id === bare.id);
  check('an empty wiredProps list is a shared, stable array',
    bare.data.wiredProps === bareAgain.data.wiredProps);
}

// ---------------------------------------------------------------------------
section('Diagnostics: indexing and one-click fixes');
// ---------------------------------------------------------------------------
{
  // An effect with no Initialize stage at all: the compiler has to report it,
  // and the fix has to actually repair it.
  const doc = normalizeVfxDoc({
    ...createEmptyVfxDoc({ name: 'Broken' }),
    systems: [{
      name: 'S',
      capacity: 64,
      contexts: [
        {
          kind: CONTEXT_KIND.SPAWN,
          blocks: [{ type: 'spawn.rate', props: { rate: 50 } }],
        },
        {
          kind: CONTEXT_KIND.OUTPUT,
          blocks: [],
          params: { mode: 'billboard', blend: 'additive', sort: 'none' },
        },
      ],
    }],
  });

  const { diagnostics } = compileVfxGraph(doc);
  check('the broken effect reports something', diagnostics.length > 0,
    diagnostics.map((d) => d.code).join(', '));

  const index = indexDiagnostics(diagnostics);
  const targeted = diagnostics.filter((d) => d.target && Object.keys(d.target).length > 0);
  check('every targeted diagnostic is indexed by its target',
    targeted.every((d) => {
      const id = d.target.blockId || d.target.contextId || d.target.systemId || d.target.nodeId;
      return !id || (index.get(id) || []).includes(d);
    }));

  const fixable = diagnostics.filter((d) => d.fix && edits.canApplyFix(d.fix));
  check('at least one has an applicable fix', fixable.length > 0,
    fixable.map((d) => d.fix.action).join(', '));

  // Every applier must be a real edit that changes the document. A fix button
  // that does nothing is worse than no button: the author clicks it, the warning
  // stays, and they conclude the tool is broken.
  let inert = [];
  let impure = [];
  for (const diagnostic of fixable) {
    const before = JSON.stringify(doc);
    const fixed = edits.applyFix(doc, diagnostic.fix);
    if (JSON.stringify(doc) !== before) impure.push(diagnostic.fix.action);
    if (fixed === doc) inert.push(diagnostic.fix.action);
  }
  check('  and every applicable fix actually changes the document',
    inert.length === 0, inert.join(', '));
  check('  without mutating it', impure.length === 0, impure.join(', '));

  // The point of the whole exercise: applying the fix removes the diagnostic.
  const lifetimeFix = fixable.find((d) => d.code === 'E_NO_LIFETIME' || d.code === 'E_NO_INITIALIZE');
  if (lifetimeFix) {
    const fixed = edits.applyFix(doc, lifetimeFix.fix);
    const after = compileVfxGraph(fixed).diagnostics;
    check(`  and ${lifetimeFix.code} is gone afterwards`,
      !after.some((d) => d.code === lifetimeFix.code),
      after.map((d) => d.code).join(', '));
  }

  // EVERY FIX A DIAGNOSTIC CAN EMIT MUST LEAD SOMEWHERE.
  //
  // THE BUG THIS EXISTS FOR: `pickAsset` was a fix action with no applier and
  // no route to the picker either, and every surface decided whether to render
  // a fix button by asking canApplyFix. So "Choose a sprite..." and "Pick a
  // replacement..." were greyed out permanently - two diagnostics offering a
  // one-click fix that could never be clicked, on every effect drawing with the
  // built-in sprite, which is most of them.
  //
  // Swept across every template plus the broken fixture above, because a fix is
  // a FUNCTION of the diagnostic's data: there is no way to enumerate the fixes
  // without provoking the diagnostics that carry them.
  {
    const emitted = new Map();
    const sweep = (candidate) => {
      for (const diagnostic of compileVfxGraph(candidate).diagnostics) {
        if (diagnostic.fix) emitted.set(`${diagnostic.code}:${diagnostic.fix.action}`, diagnostic);
      }
    };
    sweep(doc);
    for (const template of VFX_TEMPLATES) sweep(normalizeVfxDoc(template.build()));

    // A DANGLING REFERENCE, built on purpose, because it is the OTHER fix that
    // routes to the picker and the only one that identifies its target by SLOT
    // rather than by block property - so without it the shape check below never
    // sees the case it exists for. The templates cannot provide it: they all
    // compile clean, which is the point of them.
    {
      const withRef = edits.setAssetReference(
        normalizeVfxDoc(templateById('fire').build()),
        'tex_dangling',
        { kind: 'image', ref: 'asset:999777', name: 'deleted.png', colorSpace: 'srgb' },
      );
      // An assetIndex is required, or the compiler cannot know it is missing -
      // an empty slot and a deleted asset are different things.
      for (const diagnostic of compileVfxGraph(withRef, { assetIndex: new Map() }).diagnostics) {
        if (diagnostic.fix) emitted.set(`${diagnostic.code}:${diagnostic.fix.action}`, diagnostic);
      }
      check('the dangling reference really was reported',
        [...emitted.keys()].some((key) => key.startsWith('W_MISSING_ASSET')),
        [...emitted.keys()].join(', '));
    }

    // Deliberately low: the 13 templates all compile with no errors and no
    // warnings, so most of what this sweep can reach comes from the two docs
    // broken on purpose above. The value is in the shape checks, not the count.
    check('the sweep provoked a useful number of fixes', emitted.size >= 3,
      [...emitted.keys()].join(', '));
    const dead = [...emitted.values()].filter((d) => !edits.canOfferFix(d.fix));
    check('  and every one of them leads somewhere', dead.length === 0,
      dead.map((d) => `${d.code} -> ${d.fix.action}`).join(', '));

    // A fix routed to the picker must carry enough to OPEN it: either the block
    // property it fills, or the slot whose reference it repairs.
    const underspecified = [...emitted.values()].filter((d) => {
      if (!edits.fixNeedsInput(d.fix)) return false;
      const args = d.fix.args || {};
      return !(args.slot || (args.blockId && args.prop));
    });
    check('  and a picker fix names a block property or a slot',
      underspecified.length === 0,
      underspecified.map((d) => `${d.code} ${JSON.stringify(d.fix.args)}`).join(', '));
  }

  // I_DEFAULT_SPRITE HAS TWO STATES AND THEY NEED DIFFERENT FIXES. It fires
  // both when the Output has no Sprite Texture BLOCK and when it has one whose
  // slot is empty. Offering `pickAsset` for both meant that in the first case -
  // which is every template drawing with the built-in blob - the fix pointed at
  // `blockId: ''`. There was nothing to pick a texture FOR.
  {
    const spriteOf = (candidate) => compileVfxGraph(candidate).diagnostics
      .find((d) => d.code === 'I_DEFAULT_SPRITE');

    const blank = spriteOf(doc);
    check('an Output with no texture block reports I_DEFAULT_SPRITE', Boolean(blank),
      compileVfxGraph(doc).diagnostics.map((d) => d.code).join(', '));
    check('  and its fix ADDS the block rather than opening a picker',
      blank.fix.action === 'addBlock'
      && blank.fix.args.blockType === 'output.setMainTexture',
      `${blank.fix.action} ${JSON.stringify(blank.fix.args)}`);
    check('  which is applicable with no further input',
      edits.canApplyFix(blank.fix));

    // One click, and the block is really there.
    const added = edits.applyFix(doc, blank.fix);
    const outputBlocks = added.systems[0].contexts
      .find((c) => c.kind === CONTEXT_KIND.OUTPUT).blocks;
    check('  applying it puts a Sprite Texture in the Output',
      outputBlocks.some((b) => b.type === 'output.setMainTexture'),
      outputBlocks.map((b) => b.type).join(', '));

    // And now the SECOND state: the block exists, the slot is empty, so the
    // next click has something to pick a texture for.
    const second = spriteOf(added);
    check('  the diagnostic then asks for the image itself',
      second && second.fix.action === 'pickAsset',
      second ? second.fix.action : 'gone');
    check('    naming the block it belongs to',
      second.fix.args.blockId === outputBlocks
        .find((b) => b.type === 'output.setMainTexture').id
      && second.fix.args.prop === 'texture',
      JSON.stringify(second.fix.args));
    check('    and that fix is offerable even though it needs a choice',
      edits.canOfferFix(second.fix) && edits.fixNeedsInput(second.fix)
      && !edits.canApplyFix(second.fix));
  }

  check('canOfferFix says no to an action nobody handles',
    edits.canOfferFix({ action: 'teleportTheParticles' }) === false);
  check('  and no to nothing at all', edits.canOfferFix(null) === false);

  check('canApplyFix says no to a fix that needs a choice',
    edits.canApplyFix({ action: 'pickAsset', label: 'Choose a texture' }) === false);
  check('applyFix on such a fix is identity',
    edits.applyFix(doc, { action: 'pickAsset' }) === doc);
  check('applyFix with no fix at all is identity', edits.applyFix(doc, null) === doc);
}

// ---------------------------------------------------------------------------
section('Every template still compiles after a round of editing');
// ---------------------------------------------------------------------------
{
  // The integration check: run a plausible authoring session over each shipped
  // template and confirm the result is still a document the compiler accepts.
  // This is what catches an edit that produces a shape only the UI tolerates.
  for (const template of VFX_TEMPLATES) {
    let doc = normalizeVfxDoc(template.build());
    const update = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE);
    if (update) doc = edits.addBlock(doc, { contextId: update.id, blockType: 'update.drag' });
    doc = edits.addSystem(doc);
    doc = edits.addClip(doc, doc.systems[0].id, { at: 0.3, duration: 0 });
    doc = edits.addOperator(doc, 'op.constant');
    const size = blocksOf(doc).find((b) => b.type === 'initialize.setSize');
    if (size) {
      doc = edits.addEdge(doc, {
        fromNodeId: doc.operators[0].id,
        blockId: size.id,
        prop: 'size',
      });
    }
    // Reorder and disable inside the UPDATE stage, deliberately not the Spawn
    // one. Turning off the only spawn block is a legitimate edit that
    // legitimately produces E_NO_SPAWN, so doing it here would be testing the
    // compiler's opinion rather than whether the edits left a valid document.
    const forces = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE);
    if (forces && forces.blocks.length >= 2) {
      doc = edits.moveBlock(doc, forces.blocks[0].id, { toIndex: 1 });
      doc = edits.toggleBlock(doc, forces.blocks[0].id);
    }
    doc = edits.setEffectSettings(doc, { duration: 3 });

    let errors = [];
    try {
      const result = compileVfxGraph(doc);
      errors = result.diagnostics.filter((d) => d.severity === 'error');
      // The adapter must survive it too - a document the compiler accepts but
      // the board cannot draw is just as broken from the author's seat.
      toFlowNodes(doc);
      toFlowEdges(doc);
      check(`${template.name}: edited and still compiles`, errors.length === 0,
        errors.map((d) => d.code).join(', '));
    } catch (error) {
      check(`${template.name}: edited and still compiles`, false, error.message);
    }
  }
}

// ---------------------------------------------------------------------------
section('Notes and auto-layout');
// ---------------------------------------------------------------------------
{
  const doc = normalizeVfxDoc(templateById('explosion').build());

  // NOTES MUST NOT RECOMPILE THE EFFECT. They live in `doc.layout`, which
  // vfxSignature excludes - so typing a sentence about an explosion cannot
  // restart the explosion. That is the whole reason for the placement, and it
  // is invisible until you watch the preview reset on every keystroke.
  const before = vfxSignature(doc);
  const noted = pure('addNote', doc, (d) => edits.addNote(d, { text: 'here', x: 40, y: 200 }));
  check('addNote adds one', noted.layout.notes.length === 1);
  check('  positioned where it was dropped',
    noted.layout.notes[0].x === 40 && noted.layout.notes[0].y === 200);
  check('  and does NOT change the recompile signature',
    vfxSignature(noted) === before);

  const noteId = noted.layout.notes[0].id;
  const edited = pure('updateNote', noted,
    (d) => edits.updateNote(d, noteId, { text: 'the debris lands here', width: 320 }));
  check('updateNote patches text and size',
    edited.layout.notes[0].text === 'the debris lands here'
    && edited.layout.notes[0].width === 320);
  check('  still without changing the signature', vfxSignature(edited) === before);
  check('updateNote on a missing id is identity',
    edits.updateNote(noted, 'note_nope', { text: 'x' }) === noted);

  // A note that vanished on reload would be worse than no notes, so `layout` is
  // saved even though it is not part of the identity.
  const reloaded = normalizeVfxDoc(JSON.parse(JSON.stringify(edited)));
  check('notes survive a save and reload',
    reloaded.layout.notes.length === 1
    && reloaded.layout.notes[0].text === 'the debris lands here');

  check('removeNote removes one', edits.removeNote(edited, noteId).layout.notes.length === 0);
  check('  and a missing id is identity', edits.removeNote(edited, 'note_nope') === edited);

  // Tidy must not be destructive. A note's position is its own content - it is
  // placed where it is because of what it says.
  check('clearLayout forgets node positions but KEEPS notes',
    Object.keys(clearLayout(edited).layout.nodes).length === 0
    && clearLayout(edited).layout.notes.length === 1);

  // --- autoLayout ---------------------------------------------------------
  //
  // THE DIFFERENCE FROM THE DERIVED LAYOUT is that this one measures. The
  // derived positions are a function of (system index, stage) with a fixed row
  // height, so a system with eight blocks in its Update stage overlaps the
  // Output beneath it. Checked with a measurer that reports a very tall Update.
  const tall = (id) => ({ width: 288, height: id.includes('update') ? 520 : 150 });
  // An operator is ADDED to the fixture rather than assumed: the band check
  // below is behind a length test, and a guard that never runs is the bug class
  // this suite has already been caught by once.
  const withOp = edits.addOperator(edited, 'op.constant', { x: 0, y: 0 });
  check('the layout fixture has an operator to place', withOp.operators.length > 0);
  const packed = pure('autoLayout', withOp, (d) => autoLayout(d, tall));

  const contexts = withOp.systems.flatMap((system) => system.contexts.map((c) => c.id));
  check('autoLayout positions every context',
    contexts.every((id) => packed.layout.nodes[id]),
    `${contexts.filter((id) => packed.layout.nodes[id]).length} of ${contexts.length}`);

  // No two ROWS may overlap, which is the property the derived layout cannot
  // promise: a row is as tall as its tallest stage, and only a measurer knows
  // that. The tall Update above is what makes this check bite.
  const rows = new Map();
  for (const id of contexts) {
    const at = packed.layout.nodes[id];
    const list = rows.get(at.y) || [];
    list.push({ id, height: tall(id).height });
    rows.set(at.y, list);
  }
  check('  one row per system', rows.size === withOp.systems.length,
    `${rows.size} rows for ${withOp.systems.length} systems`);
  const rowTops = [...rows.keys()].sort((a, b) => a - b);
  let overlaps = 0;
  for (let i = 1; i < rowTops.length; i += 1) {
    const tallest = Math.max(...rows.get(rowTops[i - 1]).map((entry) => entry.height));
    if (rowTops[i] < rowTops[i - 1] + tallest) overlaps += 1;
  }
  check('  packed by the measured height of each row, with no overlaps',
    overlaps === 0, `${overlaps} overlapping row pairs`);

  // AND THE STAGE COLUMNS LINE UP ACROSS SYSTEMS. Packing each row on its own
  // would stagger them wherever two nodes measured differently, and the board
  // would stop reading as systems x stages - which is the point of the shape.
  const byStage = new Map();
  for (const system of withOp.systems) {
    const ordered = system.contexts.slice()
      .sort((a, b) => STAGE_ORDER.indexOf(a.kind) - STAGE_ORDER.indexOf(b.kind));
    ordered.forEach((context, column) => {
      const list = byStage.get(column) || [];
      list.push(packed.layout.nodes[context.id].x);
      byStage.set(column, list);
    });
  }
  check('  with every stage column at one x across all systems',
    [...byStage.values()].every((xs) => new Set(xs).size === 1),
    [...byStage.entries()].map(([c, xs]) => `${c}:${[...new Set(xs)].join('/')}`).join(' '));
  check('  and the columns run left to right',
    [...byStage.keys()].sort((a, b) => a - b)
      .every((column, i, all) => i === 0 || byStage.get(all[i - 1])[0] < byStage.get(column)[0]));

  // Operators go in a band BELOW the last system row, not beyond the end of the
  // chain: their output socket is on the right and every block socket is on its
  // node's left, so sitting to the right of everything made each data edge
  // leave rightwards and travel all the way back across the board.
  if (withOp.operators.length) {
    const lowestRow = Math.max(...rowTops);
    check('  and operators sit below the last system row',
      withOp.operators.every((op) => packed.layout.nodes[op.id].y > lowestRow),
      `${withOp.operators.length} operators`);
  }
  check('  and notes keep their own positions',
    packed.layout.notes[0].x === 40 && packed.layout.notes[0].y === 200);
  // Cosmetic, like every other layout write. Compared against the document it
  // was laid out FROM, not against `before`: adding the operator above changes
  // the signature on purpose, because an operator is content rather than layout.
  check('  without changing the recompile signature',
    vfxSignature(packed) === vfxSignature(withOp));
  check('  though adding the operator itself DID change it',
    vfxSignature(withOp) !== before);

  // With no measurer it must still do something sensible rather than stacking
  // everything at zero.
  const unmeasured = autoLayout(edited, null);
  check('  and a missing measurer falls back to a fixed size',
    contexts.every((id) => Number.isFinite(unmeasured.layout.nodes[id].y))
    && new Set(contexts.map((id) => unmeasured.layout.nodes[id].y)).size > 1);

  // Notes render FIRST so they paint underneath the real nodes - a comment that
  // covers the thing it comments on is worse than no comment.
  const flow = toFlowNodes(edited);
  check('a note is emitted before every other node',
    flow[0].type === 'vfxNote' && flow.filter((n) => n.type === 'vfxNote').length === 1);
  check('  carrying its size, which the resizer needs',
    flow[0].width === 320 && flow[0].height === edited.layout.notes[0].height);
}

// ---------------------------------------------------------------------------
section('Dragging a timeline clip');
// ---------------------------------------------------------------------------
//
// THE BUG THIS SECTION EXISTS FOR: dragging a clip sideways truncated it to a
// sliver. The cause was that every mode committed `{at, duration}` - so a MOVE
// wrote back a duration taken from its own preview state, and the preview
// re-derived the clip's width from that same number. Sliding a clip cannot
// change how long it is, so the patch a move produces must not mention
// duration at all.
//
// None of that is visible in a screenshot, which is why the arithmetic was
// pulled out of the component.
{
  const drag = (mode, extra = {}) => ({
    mode,
    baseAt: 0.5,
    baseDuration: 0.65,
    duration: 3,
    step: 1 / 60,
    ...extra,
  });

  // --- move: `at` only ----------------------------------------------------
  const moved = resolveClipDrag(drag('move'), 0.3);
  check('a move keeps the duration', near(moved.duration, 0.65, 1e-9),
    String(moved.duration));
  // THE ACTUAL FIX. A patch that cannot mention duration cannot truncate.
  check('  and its patch does NOT mention duration',
    Object.keys(moved.patch).join(',') === 'at', Object.keys(moved.patch).join(','));
  check('  moving it by the delta', near(moved.at, 0.8, 1e-6), String(moved.at));

  // Backwards, and clamped at the start rather than going negative.
  check('a move cannot go below zero',
    resolveClipDrag(drag('move'), -5).at === 0);
  check('  and still keeps its duration',
    near(resolveClipDrag(drag('move'), -5).duration, 0.65, 1e-9));

  // The clip's END may not leave the effect, so the far limit accounts for its
  // length rather than being the effect's duration.
  const far = resolveClipDrag(drag('move'), 99);
  check('a move stops when the clip END reaches the effect end',
    near(far.at, 3 - 0.65, 1e-6), String(far.at));
  // A burst has no length, so it may sit at the very end.
  check('  while a burst may sit at the very end',
    near(resolveClipDrag(drag('move', { baseDuration: 0 }), 99).at, 3, 1e-6));

  // A BURST dragged sideways must stay a burst. This is the reported symptom
  // in its worst form: a move that turned a clip into a zero-length marker.
  const burst = resolveClipDrag(drag('move', { baseAt: 0, baseDuration: 0 }), 0.55);
  check('moving a burst leaves it a burst', burst.duration === 0
    && Object.keys(burst.patch).join(',') === 'at');

  // --- end: `duration` only -----------------------------------------------
  const stretched = resolveClipDrag(drag('end'), 0.35);
  check('an end-trim changes the duration', near(stretched.duration, 1, 1e-6),
    String(stretched.duration));
  check('  and its patch does NOT mention at',
    Object.keys(stretched.patch).join(',') === 'duration',
    Object.keys(stretched.patch).join(','));
  check('  leaving the start where it was', near(stretched.at, 0.5, 1e-9));
  // Dragged past the start, it becomes a burst rather than a negative clip.
  check('an end-trim past the start gives a zero length',
    resolveClipDrag(drag('end'), -5).duration === 0);

  // --- start: both, together ----------------------------------------------
  // Trimming the front must leave the END where it is. Dragging the left edge
  // and watching the right edge move is the classic timeline annoyance.
  const trimmed = resolveClipDrag(drag('start'), 0.2);
  check('a start-trim moves the start', near(trimmed.at, 0.7, 1e-6), String(trimmed.at));
  check('  keeping the END fixed',
    near(trimmed.at + trimmed.duration, 0.5 + 0.65, 1e-6),
    String(trimmed.at + trimmed.duration));
  check('  and patches both fields',
    Object.keys(trimmed.patch).sort().join(',') === 'at,duration');
  // Past its own end it collapses rather than inverting - a negative duration
  // would render the clip backwards.
  const collapsed = resolveClipDrag(drag('start'), 5);
  check('a start-trim past the end collapses rather than inverting',
    collapsed.duration === 0 && near(collapsed.at, 1.15, 1e-6),
    `${collapsed.at} + ${collapsed.duration}`);

  // --- snapping ------------------------------------------------------------
  // The number the author sees has to be the number that runs, so the drag
  // snaps to the same grid the compiler does.
  const snapped = resolveClipDrag(drag('move', { baseAt: 0 }), 0.333);
  check('a drag snaps to the simulation step',
    Math.abs(snapped.at / (1 / 60) - Math.round(snapped.at / (1 / 60))) < 1e-9,
    String(snapped.at));
  // Shift is the fine modifier everywhere in this editor.
  const free = resolveClipDrag(drag('move', { baseAt: 0 }), 0.333, { free: true });
  check('  unless Shift is held', near(free.at, 0.333, 1e-9), String(free.at));
  check('snapToStep tolerates a zero step', snapToStep(0.4, 0) === 0.4);
  check('  and never returns a negative', snapToStep(-3, 1 / 60) === 0);

  // --- the shared width helper --------------------------------------------
  // The render and the drag preview both call it, so they cannot disagree about
  // how wide a clip is - a preview that computed its own width is how a clip
  // appears to change size during a gesture that does not change its size.
  const sizes = { burstWidth: 8, minWidth: 10 };
  check('a burst is a fixed marker', clipWidth(0, 500, sizes) === 8);
  check('  and so is a negative duration', clipWidth(-1, 500, sizes) === 8);
  check('a short clip gets a minimum width', clipWidth(0.001, 500, sizes) === 10);
  check('a normal clip is its real width', clipWidth(0.65, 500, sizes) === 325);

  // --- and there is ALWAYS something to grab -------------------------------
  //
  // THE OTHER HALF OF THE REPORTED BUG. The trim handles were 5px each against
  // a 10px minimum clip width, so a minimum-width clip had a body of exactly
  // ZERO: every press landed on a trim handle, and the clip could be reshaped
  // but never moved. On a wide clip the same 5px strips sat unmarked at the
  // edges, so reaching for the bar to drag it hit the start-trim handle - which
  // moves the start and shortens the clip, exactly the truncation that was
  // reported.
  const narrow = clipHandles(0.001, clipWidth(0.001, 500, sizes));
  check('a minimum-width clip has NO trim handles',
    narrow.start === false && narrow.end === false);
  check('  so its whole width is draggable', narrow.bodyPx >= MIN_BODY_PX,
    String(narrow.bodyPx));

  const wide = clipHandles(0.65, 325);
  check('a wide clip can be trimmed at both ends', wide.start && wide.end);
  check('  and still has most of its width as a drag target',
    wide.bodyPx === 325 - 2 * HANDLE_WIDTH_PX, String(wide.bodyPx));

  // A burst keeps its end handle whatever its width: dragging it out to a
  // length is the only way to turn a burst into a window.
  const burstHandles = clipHandles(0, 8);
  check('a burst keeps an end handle so it can become a window',
    burstHandles.end === true && burstHandles.start === false);

  // The threshold has to leave room for both handles AND something between
  // them, or the fix reintroduces the bug at a different width.
  let unusable = [];
  for (let px = 8; px <= 200; px += 1) {
    const parts = clipHandles(0.5, px);
    const consumed = (parts.start ? HANDLE_WIDTH_PX : 0) + (parts.end ? HANDLE_WIDTH_PX : 0);
    if (px - consumed < MIN_BODY_PX && parts.start) unusable.push(px);
  }
  check('no clip width leaves the handles eating the whole clip',
    unusable.length === 0, unusable.slice(0, 5).join(', '));

  // --- and the whole gesture, through the document ------------------------
  // The unit above proves the patch is right; this proves the patch reaching
  // updateClip leaves the clip intact, which is what the author sees.
  let doc = normalizeVfxDoc(templateById('fire').build());
  const systemId = doc.systems[0].id;
  doc = edits.updateClip(doc, systemId, doc.systems[0].schedule.clips[0].id,
    { at: 0, duration: 0.65 });
  const clip = doc.systems[0].schedule.clips[0];
  const resolved = resolveClipDrag({
    mode: 'move',
    baseAt: clip.at,
    baseDuration: clip.duration,
    duration: doc.effect.duration,
    step: doc.effect.fixedDt,
  }, 0.55);
  const after = edits.updateClip(doc, systemId, clip.id, resolved.patch)
    .systems[0].schedule.clips[0];
  check('dragging a clip sideways preserves its duration',
    near(after.duration, 0.65, 1e-9),
    `${clip.at}..${clip.at + clip.duration} -> ${after.at}..${after.at + after.duration}`);
  check('  and moves it', after.at > clip.at);
}

// ---------------------------------------------------------------------------
section('Reading a library listing');
// ---------------------------------------------------------------------------
//
// THE BUG THIS SECTION EXISTS FOR: the asset picker could only select ROOT
// images. A sprite is very often an edit rather than the original - the
// generated image cropped, its background removed, its channels adjusted - and
// none of those could be chosen. The picker fix was one prop, but the reason it
// is worth a test is the shape underneath it: an edit is its own Assets row
// with its own id and its own file, and its listing id is a BARE NUMBER while a
// root's is the string `library:<n>`. Two call sites parsed that by hand.
{
  // --- id shapes ----------------------------------------------------------
  check('a root id is read through its library: prefix',
    vfxAssetId({ id: 'library:41' }) === 41);
  check('an edit id is a bare number', vfxAssetId({ id: 77 }) === 77);
  check('  and a bare numeric string too', vfxAssetId({ id: '77' }) === 77);
  check('a plain number is itself', vfxAssetId(12) === 12);
  check('a plain string is parsed', vfxAssetId('library:12') === 12);
  // assetId is the FALLBACK, not the primary: the resolver indexes by whatever
  // this returns, so the writer must agree with it or a picked asset is stored
  // under an id nothing can look up.
  check('id wins over assetId when both are present',
    vfxAssetId({ id: 'library:5', assetId: 9 }) === 5);
  check('  and assetId is used when there is no id',
    vfxAssetId({ assetId: 9 }) === 9);
  // Null rather than NaN, so callers can test with == null.
  check('an unparseable id is null', vfxAssetId({ id: 'library:abc' }) === null);
  check('  as is nothing at all', vfxAssetId(null) === null);
  check('  and an empty object', vfxAssetId({}) === null);
  check('NaN is not an id', vfxAssetId(Number.NaN) === null);

  // --- the children descent, which is the actual bug ----------------------
  const listing = [
    {
      id: 'library:10',
      assetId: 10,
      name: 'flare.png',
      filename: 'images/flare.png',
      children: [
        { id: 11, name: 'flare (no bg)', filename: 'images/flare-edit1.png', isEdit: true },
        { id: 12, name: 'flare (cropped)', filename: 'images/flare-edit2.png', isEdit: true },
      ],
    },
    // `edits` is the server's alias for the same array, and a listing row
    // carries both - so the index has to accept either name.
    {
      id: 'library:20',
      name: 'smoke.png',
      filename: 'images/smoke.png',
      edits: [{ id: 21, name: 'smoke (soft)', filename: 'images/smoke-edit1.png' }],
    },
    { id: 'library:30', name: 'spark.png', filename: 'images/spark.png' },
  ];

  const byId = indexLibraryAssets(listing);
  check('every root is indexed', [10, 20, 30].every((id) => byId.has(id)),
    [...byId.keys()].join(', '));
  check('AND every edit is indexed', [11, 12, 21].every((id) => byId.has(id)),
    [...byId.keys()].join(', '));
  check('  under `children` or `edits`, either name',
    byId.get(12)?.name === 'flare (cropped)' && byId.get(21)?.name === 'smoke (soft)');
  check('  and an edit maps to its OWN file, not its parent\'s',
    byId.get(11).filename === 'images/flare-edit1.png'
    && byId.get(11).filename !== byId.get(10).filename,
    byId.get(11).filename);
  check('nothing extra is indexed', byId.size === 6, String(byId.size));

  // A root with no children at all must not throw or add a phantom entry.
  check('a childless root is fine', indexLibraryAssets([{ id: 'library:1' }]).size === 1);
  check('an empty listing gives an empty index', indexLibraryAssets([]).size === 0);
  check('  and so does no listing', indexLibraryAssets(null).size === 0);
  check('a row with an unreadable id is skipped rather than crashing',
    indexLibraryAssets([{ id: 'nope', children: [{ id: 5 }] }]).size === 1);
}

// ---------------------------------------------------------------------------
section('Emitter gizmos');
// ---------------------------------------------------------------------------
//
// A GIZMO DRAWN WHERE THE PARTICLES ARE NOT IS WORSE THAN NO GIZMO: it turns
// "where do these come from?" into a confident wrong answer. So these check
// that the descriptor matches the BLOCK, and in particular the three rules that
// are easy to get subtly wrong.
{
  // Local, because this suite has no block fixtures of its own and reaching
  // into runtime.test.mjs for two three-line helpers would couple the files.
  let seq = 0;
  const constValue = (v) => ({ mode: 'const', v });
  const blk = (type, props, modes) => {
    seq += 1;
    const b = { id: `gz${seq}`, type, enabled: true, props };
    if (modes) b.modes = modes;
    return b;
  };

  const shaped = (blocks, extra = {}) => normalizeVfxDoc({
    ...createEmptyVfxDoc({ name: 'Gizmos' }),
    ...extra,
    systems: [{
      id: 'sys-g',
      name: 'S',
      capacity: 64,
      contexts: [
        { id: 'c-spawn', kind: CONTEXT_KIND.SPAWN, blocks: [], params: {} },
        { id: 'c-init', kind: CONTEXT_KIND.INITIALIZE, blocks, params: {} },
      ],
    }],
  });
  const one = (blocks, extra) => emitterGizmos(shaped(blocks, extra))[0];

  // --- every shape is described --------------------------------------------
  const sphere = one([blk('initialize.positionSphere', { radius: constValue(2.5) })]);
  check('a sphere reports its radius', sphere?.kind === 'sphere' && sphere.radius === 2.5,
    JSON.stringify(sphere));
  check('  and whether it is a shell',
    one([blk('initialize.positionSphere', { radius: constValue(1) }, { fill: 'surface' })]).hollow === true);
  check('  a volume fill is not', sphere.hollow === false);

  const box = one([blk('initialize.positionBox', { size: constValue([4, 2, 6]) })]);
  check('a box reports its full size', String(box.size) === '4,2,6', String(box.size));

  // The RING, not a disc: the kernel fills a band, and drawing a disc would
  // claim particles appear in the middle where none do.
  const ring = one([blk('initialize.positionCircle', {
    radius: constValue(2), thickness: constValue(0.5),
  })]);
  check('a circle reports its band, not just its radius',
    ring.radius === 2 && ring.inner === 1.5, `${ring.inner}..${ring.radius}`);
  check('  and a thickness past the radius clamps at zero rather than inverting',
    one([blk('initialize.positionCircle', {
      radius: constValue(1), thickness: constValue(5),
    })]).inner === 0);

  const line = one([blk('initialize.positionLine', {
    start: constValue([-1, 2, 0]), end: constValue([3, 2, 0]),
  })]);
  check('a line reports both endpoints',
    String(line.start) === '-1,2,0' && String(line.end) === '3,2,0',
    `${line.start} -> ${line.end}`);

  const point = one([blk('initialize.positionPoint', {
    offset: constValue([1, 2, 3]), jitter: constValue(0.25),
  })]);
  check('a point reports its position and jitter',
    String(point.offset) === '1,2,3' && point.radius === 0.25, JSON.stringify(point));

  // --- the transform, which is most of the point ---------------------------
  const placed = one([blk('initialize.positionCircle', {
    radius: constValue(1),
    thickness: constValue(0.1),
    offset: constValue([0, 1.5, 0]),
    rotation: constValue([90, 0, 0]),
  })]);
  check('a shape carries its offset', String(placed.offset) === '0,1.5,0');
  check('  and its rotation, in degrees as authored',
    String(placed.rotation) === '90,0,0', String(placed.rotation));

  // --- rule 1: every value mode keeps a usable literal ---------------------
  // A random radius still has to draw SOMETHING, or the gizmo gives up on
  // exactly the emitters worth looking at.
  const random = one([blk('initialize.positionSphere', {
    radius: { mode: 'random', a: 1, b: 3, v: 2 },
  })]);
  check('a random radius falls back to its literal', random.radius === 2, String(random.radius));

  // --- rule 2: a disabled block places no particles ------------------------
  const disabled = shaped([
    { ...blk('initialize.positionBox', { size: constValue([9, 9, 9]) }), enabled: false },
  ]);
  check('a disabled shape draws nothing', emitterGizmos(disabled).length === 0);

  // --- rule 3: the LAST shape in the stack wins ----------------------------
  // Blocks WRITE position rather than accumulating it, so a stage holding two
  // shapes emits from the second only. Drawing both would show a shape no
  // particle uses.
  const two = one([
    blk('initialize.positionSphere', { radius: constValue(5) }),
    blk('initialize.positionBox', { size: constValue([1, 1, 1]) }),
  ]);
  check('with two shapes in one stage, the last one wins', two.kind === 'box', two.kind);
  check('  and only one gizmo is produced',
    emitterGizmos(shaped([
      blk('initialize.positionSphere', { radius: constValue(5) }),
      blk('initialize.positionBox', { size: constValue([1, 1, 1]) }),
    ])).length === 1);
  // ...but a DISABLED last one hands it back to the enabled one above.
  const lastOff = one([
    blk('initialize.positionSphere', { radius: constValue(5) }),
    { ...blk('initialize.positionBox', { size: constValue([1, 1, 1]) }), enabled: false },
  ]);
  check('  unless the last one is off', lastOff.kind === 'sphere', lastOff.kind);

  // --- a stage with no shape at all ----------------------------------------
  check('a system with no shape block produces no gizmo',
    emitterGizmos(shaped([blk('initialize.setLifetime', { lifetime: constValue(1) })])).length === 0);

  // --- the mesh slot resolves through references, never by id -------------
  const meshDoc = shaped(
    [blk('initialize.positionMesh', { mesh: constValue('mesh_x'), scale: constValue(3) })],
    { references: { mesh_x: { kind: 'mesh', ref: 'asset:77', name: 'r.glb', colorSpace: 'srgb' } } },
  );
  const meshGizmo = emitterGizmos(meshDoc)[0];
  check('a mesh emitter reports its slot and scale',
    meshGizmo.slot === 'mesh_x' && meshGizmo.scale === 3, JSON.stringify(meshGizmo));
  check('  and the slot resolves to an asset id',
    gizmoMeshAssetId(meshDoc, meshGizmo.slot) === 77,
    String(gizmoMeshAssetId(meshDoc, meshGizmo.slot)));
  check('  while an unknown slot is null, not NaN',
    gizmoMeshAssetId(meshDoc, 'nope') === null);
  check('  and an empty slot too', gizmoMeshAssetId(meshDoc, '') === null);

  // --- one per system, across a real effect --------------------------------
  const explosion = normalizeVfxDoc(templateById('explosion').build());
  const all = emitterGizmos(explosion);
  check('every system of a template gets exactly one gizmo',
    all.length === explosion.systems.length, `${all.length} of ${explosion.systems.length}`);
  check('  each naming its own system',
    new Set(all.map((g) => g.systemId)).size === all.length);
}

// ---------------------------------------------------------------------------
section('Sprite sheets, configured in one move');
// ---------------------------------------------------------------------------
//
// A SHEET IS THREE BLOCKS IN TWO STAGES: `output.setFlipbook` cuts the atlas,
// `update.flipbook` steps through it, and they live in different contexts. The
// natural way to set one up is to add the Output block, see nothing happen, and
// conclude the texture is cropped - which is why the compiler has a warning for
// it. Setting them together is what makes that state unreachable from the UI.
{
  const base = () => normalizeVfxDoc(templateById('fire').build());
  const sys = (doc) => doc.systems[0].id;
  const blocksOf = (doc, kind) => doc.systems[0].contexts
    .filter((c) => c.kind === kind)
    .flatMap((c) => c.blocks.map((b) => b.type));

  // --- it reaches BOTH stages ----------------------------------------------
  {
    const doc = base();
    check('the fixture starts with no sheet',
      edits.readSpriteSheet(doc, sys(doc)).playing === false);

    const sheeted = pure('setSpriteSheet', doc,
      (d) => edits.setSpriteSheet(d, sys(d), { columns: 6, rows: 5, fps: 30 }));
    check('it adds the layout to the Output stage',
      blocksOf(sheeted, CONTEXT_KIND.OUTPUT).includes('output.setFlipbook'),
      blocksOf(sheeted, CONTEXT_KIND.OUTPUT).join(' '));
    // THE HALF THAT GETS FORGOTTEN.
    check('  AND the player to the Update stage',
      blocksOf(sheeted, CONTEXT_KIND.UPDATE).includes('update.flipbook'),
      blocksOf(sheeted, CONTEXT_KIND.UPDATE).join(' '));

    const read = edits.readSpriteSheet(sheeted, sys(sheeted));
    check('  reading back exactly what was set',
      read.columns === 6 && read.rows === 5 && read.fps === 30 && read.playing,
      JSON.stringify(read));

    // THE FRAME COUNT IS DERIVED, NOT TYPED - which is what stops the player
    // and the sheet disagreeing, the other half-configured state.
    const player = sheeted.systems[0].contexts
      .flatMap((c) => c.blocks).find((b) => b.type === 'update.flipbook');
    check('  and the frame count is the grid, never a separate number',
      player.props.frames.v === 30, String(player.props.frames.v));
    check('  which compiles with no flipbook complaint',
      compileVfxGraph(sheeted).diagnostics.every((d) => !d.code.startsWith('W_FLIPBOOK')),
      compileVfxGraph(sheeted).diagnostics.map((d) => d.code).join(' '));
  }

  // --- changing it edits in place rather than stacking blocks --------------
  {
    // The id has to come from the doc being EDITED. base() mints fresh ids on
    // every call, so `setSpriteSheet(base(), sys(base()), ...)` targets a
    // system that is not in the document it is editing - identity, silently.
    // The guard below caught exactly that.
    const start = base();
    const id = sys(start);
    let doc = edits.setSpriteSheet(start, id, { columns: 4, rows: 4, fps: 24 });
    check('  (the first grid really was applied)',
      edits.readSpriteSheet(doc, id).columns === 4,
      String(edits.readSpriteSheet(doc, id).columns));
    doc = edits.setSpriteSheet(doc, id, { columns: 8, rows: 2, fps: 12 });
    const sheets = doc.systems[0].contexts
      .flatMap((c) => c.blocks).filter((b) => b.type === 'output.setFlipbook');
    const players = doc.systems[0].contexts
      .flatMap((c) => c.blocks).filter((b) => b.type === 'update.flipbook');
    check('setting it twice edits rather than duplicating',
      sheets.length === 1 && players.length === 1,
      `${sheets.length} sheets, ${players.length} players`);
    const read = edits.readSpriteSheet(doc, id);
    check('  with the new grid', read.columns === 8 && read.rows === 2 && read.fps === 12,
      JSON.stringify(read));
    check('  and the frame count following it', players[0].props.frames.v === 16,
      String(players[0].props.frames.v));
  }

  // --- one tile is not a sheet ---------------------------------------------
  //
  // The honest inverse. Leaving a 1x1 flipbook block behind would keep the
  // shader's USE_FLIPBOOK define and its uniform for a sheet that has one cell.
  {
    const start = base();
    const id = sys(start);
    let doc = edits.setSpriteSheet(start, id, { columns: 4, rows: 4, fps: 24 });
    check('  (the sheet really was there first)',
      edits.readSpriteSheet(doc, id).playing === true);
    doc = edits.setSpriteSheet(doc, id, { columns: 1, rows: 1 });
    check('collapsing to one tile removes both blocks',
      !blocksOf(doc, CONTEXT_KIND.OUTPUT).includes('output.setFlipbook')
      && !blocksOf(doc, CONTEXT_KIND.UPDATE).includes('update.flipbook'),
      `${blocksOf(doc, CONTEXT_KIND.OUTPUT).join(' ')} / ${blocksOf(doc, CONTEXT_KIND.UPDATE).join(' ')}`);
  }

  // --- a system with no Update stage still gets a player -------------------
  //
  // Legal (the compiler only reports it as an info) but a sheet cannot play
  // without somewhere to put the player, so the stage is created rather than
  // the request being silently half-honoured.
  {
    let doc = base();
    const id = sys(doc);
    for (const context of doc.systems[0].contexts.filter((c) => c.kind === CONTEXT_KIND.UPDATE)) {
      doc = edits.removeContext(doc, context.id);
    }
    check('the fixture now has no Update stage',
      !doc.systems[0].contexts.some((c) => c.kind === CONTEXT_KIND.UPDATE),
      doc.systems[0].contexts.map((c) => c.kind).join(' '));
    doc = edits.setSpriteSheet(doc, id, { columns: 3, rows: 3, fps: 15 });
    check('  and the Update stage is created to hold the player',
      blocksOf(doc, CONTEXT_KIND.UPDATE).includes('update.flipbook'),
      doc.systems[0].contexts.map((c) => c.kind).join(' '));
  }

  // --- refusals -------------------------------------------------------------
  const untouched = base();
  check('an unknown system is identity',
    edits.setSpriteSheet(untouched, 'sys-nope', { columns: 4, rows: 4 }) === untouched);
  const forClamp = base();
  const clamped = edits.setSpriteSheet(forClamp, sys(forClamp), { columns: 0, rows: -3, fps: 0 });
  check('  and a nonsense grid collapses to no sheet rather than throwing',
    edits.readSpriteSheet(clamped, sys(clamped)).playing === false);
}


// --- A new block is USABLE the moment it is placed ---------------------------
//
// A path is block data rather than a property, so defaultProps cannot lay it
// down - and a curve emitter with no path is read by the kernel as a degenerate
// segment at the origin. Every particle spawns in one spot, the compile is
// clean, and the panel still draws a path editor: a block that looks placed
// and does nothing.
{
  console.log('\n--- A new curve emitter arrives with a path ---');

  const fresh = edits.createBlock('initialize.positionCurve');
  const declared = CATALOG.block('initialize.positionCurve').points;
  check('a new curve block carries a path', Array.isArray(fresh.points),
    JSON.stringify(fresh.points));
  check('  which is the catalog\'s own default',
    JSON.stringify(fresh.points) === JSON.stringify(declared.default));
  check('  at or above the minimum length',
    fresh.points.length >= declared.min, `${fresh.points.length} points`);
  // Copied, not shared: two curve blocks that alias one array would move
  // together, and the author would have no way to tell why.
  const second = edits.createBlock('initialize.positionCurve');
  second.points[0][0] = 99;
  check('  and copied rather than shared with the catalog',
    fresh.points[0][0] !== 99 && declared.default[0][0] !== 99);

  // THE REASON IT MATTERS: the path has to survive into the IR, which is what
  // the kernel and both importer plugins read.
  // Onto a template rather than an empty document, so the only thing that can
  // go wrong in the compile below is the block being added.
  let doc = normalizeVfxDoc(templateById('sparks').build());
  doc = edits.addBlock(doc, {
    systemId: doc.systems[0].id,
    contextKind: CONTEXT_KIND.INITIALIZE,
    blockType: 'initialize.positionCurve',
  });
  const { ir, diagnostics } = compileVfxGraph(doc, { assetIndex: new Set() });
  const compiled = ir.systems
    .flatMap((system) => system.init)
    .find((b) => b.srcBlockType === 'initialize.positionCurve');
  check('adding one through the palette reaches the IR with its path',
    JSON.stringify(compiled?.points) === JSON.stringify(declared.default),
    JSON.stringify(compiled?.points));
  check('  with no errors', !diagnostics.some((d) => d.severity === 'error'),
    diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(' '));

  // A block WITHOUT a path declaration must not grow one.
  check('a block with no path declaration gets none',
    edits.createBlock('initialize.positionSphere').points === undefined);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
