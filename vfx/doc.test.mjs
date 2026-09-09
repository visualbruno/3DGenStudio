// Checks for vfx/doc.js. No test framework - run it directly:
//
//     node vfx/doc.test.mjs
//
// Organised around the four invariants in vfx/doc.js's header, because each of
// them is load-bearing for something the author would experience as a bug
// rather than as a broken invariant:
//
//   1. edges authoritative  -> a wire that says one thing and behaves another
//   2. layout not simulated -> dragging a node restarts a 60k-particle effect
//   3. slots not asset ids  -> a deleted texture nobody can trace
//   4. 'asset:<id>' strings -> an exported effect whose textures do not travel
//
// Invariant 4 is the one with a known precedent: tree presets store bare
// numeric asset ids, so a tree in a .3dgp does not carry its bark texture and
// its ids point at the exporting machine's numbering after import. It fails
// silently and only in a second installation. The case below pins the string
// form against the same regex storage.js uses, so the shape cannot drift back.
//
// KNOWN GAP: nothing here proves storage.js actually walks our digest, because
// importing storage.js pulls in the database drivers. The regex is replicated
// from storage.js:5627 with a comment; if that line ever changes, this test
// will keep passing while export quietly breaks. A phase-9 end-to-end export
// and re-import into a fresh install is the check that would catch it, and it
// is in the plan for exactly that reason.
import {
  CONTEXT_KIND,
  FLOW_ORDER,
  VFX_DOC_FORMAT,
  collectVfxAssetRefs,
  createClip,
  createEmptyVfxDoc,
  formatAssetRef,
  normalizeVfxDoc,
  parseAssetRef,
  serializeVfxDoc,
  vfxSignature,
} from './doc.js';
import { VALUE_MODE, readValue } from './value.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(52)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// A document with one block carrying one property, plus an operator, so the
// reconciler has something to wire. Built by hand rather than via the catalog,
// which does not exist until phase 2.
function fixture() {
  const doc = createEmptyVfxDoc({ name: 'Test' });
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  init.blocks.push({
    id: 'blk-life',
    type: 'initialize.setLifetime',
    enabled: true,
    props: { lifetime: 2 },
  });
  doc.operators.push({ id: 'op-curve', type: 'op.curve', props: {} });
  return normalizeVfxDoc(doc);
}

const lifetimeOf = (doc) => doc.systems[0].contexts
  .find((c) => c.kind === CONTEXT_KIND.INITIALIZE).blocks
  .find((b) => b.id === 'blk-life').props.lifetime;

// ---------------------------------------------------------------------------
// 1. A new document runs rather than being blank
// ---------------------------------------------------------------------------
{
  const doc = createEmptyVfxDoc();
  const kinds = doc.systems[0].contexts.map((c) => c.kind);
  const chain = kinds.join(' ') === 'spawn initialize update output';
  check('a new document has a wired flow chain', chain, kinds.join(' -> '));
  check('  and exactly one system', doc.systems.length === 1);
  check('  and format is current', doc.format === VFX_DOC_FORMAT);
}

{
  // The flow order table is the single source both the compiler and the board
  // read, so a missing entry would let the board offer an illegal connection.
  const covered = Object.values(CONTEXT_KIND).every((kind) => Array.isArray(FLOW_ORDER[kind]));
  check('every context kind has a flow rule', covered);
  check('  and output is terminal', FLOW_ORDER[CONTEXT_KIND.OUTPUT].length === 0);
}

// ---------------------------------------------------------------------------
// 2. Defensive normalisation - hand-edited and model-generated documents
// ---------------------------------------------------------------------------
{
  const doc = normalizeVfxDoc({
    effect: { fixedDt: 0, duration: -5, seed: -1, capacity: 0, maxSubSteps: 0 },
  });
  // A fixedDt of zero would spin the accumulator loop forever - this is the one
  // bad value in the document that hangs the tab rather than looking wrong.
  const ok = doc.effect.fixedDt > 0
    && doc.effect.duration >= 0
    && doc.effect.seed >= 0
    && doc.effect.capacity >= 1
    && doc.effect.maxSubSteps >= 1;
  check('hostile effect settings are clamped', ok, `fixedDt ${doc.effect.fixedDt}, seed ${doc.effect.seed}`);
}

{
  const doc = normalizeVfxDoc({});
  const ok = Array.isArray(doc.systems) && Array.isArray(doc.edges)
    && Array.isArray(doc.operators) && Array.isArray(doc.exposed)
    && doc.references && typeof doc.references === 'object';
  check('an empty object normalises to a valid document', ok);
}

{
  const doc = normalizeVfxDoc({ format: 0, systems: [] });
  check('an older format still normalises', doc.format === VFX_DOC_FORMAT);
}

{
  // Soft-mute must keep the block, not remove it: the id is what the undo
  // history, the diagnostics and the inspector selection all refer to.
  const doc = fixture();
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  init.blocks[0].enabled = false;
  const round = normalizeVfxDoc(clone(doc));
  const block = round.systems[0].contexts
    .find((c) => c.kind === CONTEXT_KIND.INITIALIZE).blocks[0];
  check('a disabled block keeps its id and props', block.id === 'blk-life' && block.enabled === false);
}

// ---------------------------------------------------------------------------
// 3. Timeline clips
// ---------------------------------------------------------------------------
{
  const doc = normalizeVfxDoc({
    systems: [{ schedule: { clips: [{ at: 1.5 }, { at: 0.2 }, { at: 0.9 }] } }],
  });
  const times = doc.systems[0].schedule.clips.map((c) => c.at);
  check('clips are sorted by time', times.join() === '0.2,0.9,1.5', times.join(' '));
}

{
  // Zero duration is a one-shot burst, which most impact effects are built
  // from - it must not be "helpfully" widened to something non-zero.
  const clip = createClip({ at: 0.5, duration: 0 });
  check('a zero-duration clip survives', clip.duration === 0);
}

{
  const doc = normalizeVfxDoc({ systems: [{ schedule: { clips: [] } }] });
  check('a system with no clips gets a default', doc.systems[0].schedule.clips.length === 1);
}

{
  const doc = normalizeVfxDoc({ systems: [{}, {}] });
  const offsets = doc.systems.map((s) => s.seedOffset);
  check('systems get distinct seed offsets', offsets[0] !== offsets[1], offsets.join(' vs '));
}

// ---------------------------------------------------------------------------
// 4. Invariant 1 - edges are authoritative for wiring
// ---------------------------------------------------------------------------
{
  const doc = fixture();
  doc.edges.push({
    id: 'e1',
    from: { nodeId: 'op-curve', port: 'out' },
    to: { blockId: 'blk-life', prop: 'lifetime' },
  });
  const wired = normalizeVfxDoc(clone(doc));
  const value = lifetimeOf(wired);
  check(
    'an edge makes the property a link',
    value.mode === VALUE_MODE.LINK && value.nodeId === 'op-curve',
    `${value.mode} from ${value.nodeId}`,
  );
  check('  and the literal is kept as a fallback', readValue(value) === 2, String(readValue(value)));
}

{
  // Cut the wire. The property must revert to a constant at its literal, not
  // keep claiming to be linked and not collapse to zero.
  const doc = fixture();
  doc.edges.push({
    id: 'e1',
    from: { nodeId: 'op-curve', port: 'out' },
    to: { blockId: 'blk-life', prop: 'lifetime' },
  });
  const wired = normalizeVfxDoc(clone(doc));
  wired.edges = [];
  const unwired = normalizeVfxDoc(clone(wired));
  const value = lifetimeOf(unwired);
  check(
    'removing the edge reverts the property',
    value.mode === VALUE_MODE.CONST && readValue(value) === 2,
    `${value.mode} = ${readValue(value)}`,
  );
}

{
  // The combined case, and the one that actually happens: the author deletes
  // the operator node. The edge is now dangling AND the mirror is stale, and
  // both have to be resolved in the same pass.
  const doc = fixture();
  doc.edges.push({
    id: 'e1',
    from: { nodeId: 'op-curve', port: 'out' },
    to: { blockId: 'blk-life', prop: 'lifetime' },
  });
  const wired = normalizeVfxDoc(clone(doc));
  wired.operators = [];
  const after = normalizeVfxDoc(clone(wired));
  const value = lifetimeOf(after);
  check(
    'deleting the source node prunes and reverts',
    after.edges.length === 0 && value.mode === VALUE_MODE.CONST && readValue(value) === 2,
    `${after.edges.length} edges, ${value.mode} = ${readValue(value)}`,
  );
}

{
  // A link asserted in the document with no edge behind it is a lie, whether
  // it came from a hand edit or from a model. Edges win.
  const doc = fixture();
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  init.blocks[0].props.lifetime = { mode: 'link', nodeId: 'op-curve', port: 'out', v: 3 };
  const normalized = normalizeVfxDoc(clone(doc));
  const value = lifetimeOf(normalized);
  check(
    'a link with no edge is not honoured',
    value.mode === VALUE_MODE.CONST && readValue(value) === 3,
    `${value.mode} = ${readValue(value)}`,
  );
}

{
  const doc = fixture();
  doc.edges.push(
    { id: 'e1', from: { nodeId: 'ghost' }, to: { blockId: 'blk-life', prop: 'lifetime' } },
    { id: 'e2', from: { nodeId: 'op-curve' }, to: { blockId: 'ghost-block', prop: 'x' } },
    { id: 'e3', from: { nodeId: 'op-curve' }, to: { blockId: 'blk-life' } },
  );
  const pruned = normalizeVfxDoc(clone(doc));
  // React Flow logs an error for every edge whose endpoints it cannot place, so
  // leaving these in makes the console useless after a delete.
  check('dangling edges are pruned', pruned.edges.length === 0, `${pruned.edges.length} left`);
}

{
  // A scalar curve driving just the y of a vec3 is the most common wiring move
  // there is, and it is expressed on the edge so the author never has to insert
  // a Compose node by hand.
  const doc = fixture();
  doc.edges.push({
    id: 'e1',
    from: { nodeId: 'op-curve', port: 'out' },
    to: { blockId: 'blk-life', prop: 'lifetime', component: 1 },
  });
  const kept = normalizeVfxDoc(clone(doc));
  check('a component target survives', kept.edges[0].to.component === 1);

  doc.edges[0].to.component = 9;
  const dropped = normalizeVfxDoc(clone(doc));
  check('an out-of-range component is dropped', dropped.edges[0].to.component === undefined);
}

// ---------------------------------------------------------------------------
// 5. Invariants 3 and 4 - asset references
// ---------------------------------------------------------------------------
{
  const doc = normalizeVfxDoc({
    references: {
      tex_a: { kind: 'image', ref: 118, name: 'spark.png' },
      tex_b: { kind: 'image', ref: 'asset:97' },
      mesh_a: { kind: 'mesh', ref: 'asset:240' },
      nested: { kind: 'vfx', ref: 'asset:400' },
      tex_missing: { kind: 'image' },
    },
  });
  // A bare number is what a hand-written or model-generated document produces;
  // it must be accepted on the way in and STORED canonically.
  check('bare numeric refs are canonicalised', doc.references.tex_a.ref === 'asset:118', doc.references.tex_a.ref);

  const digest = collectVfxAssetRefs(doc);
  check('the digest sorts and splits by kind',
    digest.textureRefs.join() === 'asset:97,asset:118'
    && digest.meshRefs.join() === 'asset:240'
    && digest.vfxRefs.join() === 'asset:400',
    JSON.stringify(digest.all));
  // An empty slot is the "choose a sprite" diagnostic's input. Dropping it
  // silently would make an unfinished effect look complete.
  check('an empty slot is reported, not dropped', digest.missing.join() === 'tex_missing');
}

{
  // THE INVARIANT 4 CASE. This regex is copied from storage.js:5627
  // (collectAssetIdsFromValue); remapReferencesDeep at storage.js:6006 matches
  // the same shape on import. Both only look at STRINGS, and reach inside
  // ARRAYS - so a digest of 'asset:<id>' strings in arrays is carried by the
  // existing project export and renumbered by the existing import with no new
  // code at all. Bare numbers are invisible to both, which is the bug tree
  // presets ship with.
  const STORAGE_REF_PATTERN = /^asset:(\d+)$/;
  const digest = collectVfxAssetRefs(normalizeVfxDoc({
    references: { a: { kind: 'image', ref: 118 }, b: { kind: 'mesh', ref: 'asset:240' } },
  }));
  const allMatch = digest.all.length === 2
    && digest.all.every((ref) => typeof ref === 'string' && STORAGE_REF_PATTERN.test(ref));
  check("every ref matches storage.js's walker", allMatch, digest.all.join(' '));

  // And the ids come back out, which is what import needs to renumber them.
  const ids = digest.all.map(parseAssetRef);
  check('  and parses back to the ids', ids.join() === '118,240', ids.join(' '));
  check('  formatAssetRef round trips', parseAssetRef(formatAssetRef(77)) === 77);
}

{
  const digest = collectVfxAssetRefs(normalizeVfxDoc({
    references: {
      one: { kind: 'image', ref: 'asset:5' },
      two: { kind: 'image', ref: 'asset:5' },
    },
  }));
  // Two slots may legitimately share one texture; the dependency list must not
  // list it twice or the export copies the same bytes twice.
  check('duplicate refs are deduped', digest.textureRefs.length === 1);
}

// ---------------------------------------------------------------------------
// 6. Invariant 2 - the signature drives recompilation
// ---------------------------------------------------------------------------
{
  const doc = fixture();
  const moved = normalizeVfxDoc(clone(doc));
  moved.layout = { nodes: { 'blk-life': { x: 400, y: 120 } } };
  moved.savedAt = 12345;
  moved.systems[0].solo = true;
  moved.name = 'Renamed';
  check(
    'signature ignores layout, savedAt, solo and name',
    vfxSignature(doc) === vfxSignature(moved),
  );
}

{
  const doc = fixture();
  const variants = {
    capacity: (d) => { d.effect.capacity = 8192; },
    seed: (d) => { d.effect.seed = 999; },
    'block prop': (d) => { lifetimeOf(d).v = 5; },
    'block order': (d) => {
      const init = d.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
      init.blocks.push({ id: 'blk-2', type: 'x', enabled: true, props: {} });
    },
    'block enabled': (d) => {
      d.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE).blocks[0].enabled = false;
    },
    'clip time': (d) => { d.systems[0].schedule.clips[0].at = 0.4; },
    'clip loop': (d) => { d.systems[0].schedule.clips[0].loop = true; },
    'system enabled': (d) => { d.systems[0].enabled = false; },
  };
  const base = vfxSignature(doc);
  const missed = [];
  for (const [label, mutate] of Object.entries(variants)) {
    const variant = normalizeVfxDoc(clone(doc));
    mutate(variant);
    if (vfxSignature(variant) === base) missed.push(label);
  }
  check('signature notices every simulated change', missed.length === 0, missed.join(', ') || 'all detected');
}

{
  // A save and load must not appear to be a change, or the editor recompiles
  // the moment a document is opened.
  const doc = fixture();
  const revived = normalizeVfxDoc(JSON.parse(JSON.stringify(doc)));
  check('signature is stable across a JSON round trip', vfxSignature(doc) === vfxSignature(revived));
}

{
  const doc = fixture();
  const { doc: saved, refs } = serializeVfxDoc(doc, { name: 'Renamed' });
  check(
    'serialize bumps savedAt, renames and digests',
    saved.name === 'Renamed' && saved.savedAt >= doc.savedAt && Array.isArray(refs.all),
  );
  check('  and normalisation is idempotent', vfxSignature(normalizeVfxDoc(clone(saved))) === vfxSignature(saved));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
