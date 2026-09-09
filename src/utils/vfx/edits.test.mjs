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
import { VFX_TEMPLATES } from './templates.js';
import * as edits from './edits.js';
import {
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

  const size = blocksOf(doc).find((b) => b.type === 'update.sizeOverLife');
  if (size) {
    const spike = pure('setCurvePreset', doc,
      (d) => edits.setCurvePreset(d, size.id, 'size', 'rampDown'));
    const value = blocksOf(spike).find((b) => b.id === size.id).props.size;
    const expected = CURVE_PRESETS.find((p) => p.id === 'rampDown').build();
    check('setCurvePreset writes the preset shape',
      value.curve.keys.length === expected.keys.length
      && value.curve.keys[0].v === expected.keys[0].v);
    check('setCurvePreset refuses an unknown preset',
      edits.setCurvePreset(doc, size.id, 'size', 'nope') === doc);
  }

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

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
