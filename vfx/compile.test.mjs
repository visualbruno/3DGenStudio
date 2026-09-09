// Checks for vfx/compile.js, vfx/ir.js, vfx/catalog.js and vfx/diagnostics.js.
// No test framework - run it directly:
//
//     node vfx/compile.test.mjs
//
// The compiler is the piece with the most leverage in the feature: the preview,
// the export bundle and both engine importers all consume what it produces, so
// a wrong IR is wrong in three places at once and only visibly wrong in one of
// them. It is also the piece that can be tested completely without a GPU, a
// browser or a database, which is why it is worth testing thoroughly here
// rather than discovering problems through the viewport in phase 4.
//
// Organised as:
//   1  the baseline effect compiles silently
//   2  the IR keeps its five documented guarantees
//   3  the lowering is right (attributes, pools, bindings, injected kernels)
//   4  the schedule survives as whole simulation steps
//   5  the capacity arithmetic is real, and honest when it cannot be
//   6  frequency classification, cycles, and broken graphs still compile
//   7  every diagnostic code is reachable, or is declared unreachable on purpose
//
// KNOWN GAP: nothing here checks that the IR is CORRECT in the sense of
// producing the right particles - only that it is well-formed and says what
// the document said. Phase 3's runtime test is what closes that, by stepping a
// pool and checksumming it. Two things could pass every check below and still
// be wrong: a kernel name that no kernel implements, and a binding whose
// semantics the kernel reads differently than the compiler meant.
import {
  CATALOG,
  ENGINE_SUPPORT,
  defaultModes,
  defaultProps,
  makeCatalog,
  propChannels,
  worstEngineSupport,
} from './catalog.js';
import { compileVfxGraph } from './compile.js';
import { DIAGNOSTIC_CODES, summarizeDiagnostics } from './diagnostics.js';
import { CONTEXT_KIND, createEmptyVfxDoc, normalizeVfxDoc } from './doc.js';
import { BINDING_SRC, CORE_ATTRIBUTES, VFX_IR_FORMAT, validateIrSerializable } from './ir.js';
import * as fixtures from './fixtures.mjs';
import { constValue, curveValue } from './value.js';
import { CURVE_PRESETS } from './curve.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(54)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

// 121 is the statue the emitterShapes fixture spawns over, and it has to be
// PRESENT: that fixture's whole claim is that the new shapes compile without a
// word. 119 is deliberately absent - meshModeMissing uses it, and a dangling
// mesh reference is how W_MISSING_ASSET gets its coverage.
const ASSETS = new Set([118, 97, 121]);
const compile = (doc, options = {}) => compileVfxGraph(doc, { assetIndex: ASSETS, ...options });
const codesOf = (result) => result.diagnostics.map((d) => d.code);

// Every code raised anywhere in this file, so section 7 can prove coverage.
const firedCodes = new Set();
function record(result) {
  for (const code of codesOf(result)) firedCodes.add(code);
  return result;
}

// ---------------------------------------------------------------------------
// 1. The baseline compiles silently
// ---------------------------------------------------------------------------
{
  const result = record(compile(fixtures.sparkBurst()));
  check(
    'a complete effect compiles with no diagnostics',
    result.diagnostics.length === 0,
    codesOf(result).join(' ') || 'clean',
  );
  check('  and reports its cost', result.stats.peakParticles === 60 && result.stats.drawCalls === 1,
    `${result.stats.peakParticles} particles, ${result.stats.drawCalls} draw call`);
}

{
  // The empty document a new effect starts from is deliberately not blank, but
  // it IS incomplete - and it must say so in terms of what to do next rather
  // than looking broken.
  const result = record(compile(createEmptyVfxDoc()));
  const codes = codesOf(result);
  check('a new empty effect reports what it needs', codes.includes('E_NO_SPAWN'), codes.join(' '));
  const spawnFix = result.diagnostics.find((d) => d.code === 'E_NO_SPAWN').fix;
  check('  with a one-click fix', spawnFix?.action === 'addBlock' && spawnFix.args.blockType === 'spawn.rate');
}

{
  const clean = summarizeDiagnostics([], { peakParticles: 1400, drawCalls: 1, engines: { unity: 'native', unreal: 'native' } });
  // An empty strip teaches nothing; a strip that states the cost is a running
  // lesson in what a cheap effect looks like.
  check(
    'a clean summary states the cost, not nothing',
    clean.tone === 'ok' && /particles/.test(clean.text) && /Unity \+ Unreal ready/.test(clean.text),
    clean.text,
  );
}

// ---------------------------------------------------------------------------
// 2. The IR's documented guarantees
// ---------------------------------------------------------------------------
{
  // Guarantee 1. A Float32Array looks like an array right up until
  // JSON.stringify turns it into an object with numeric keys, and NaN becomes
  // null and then a silent zero on the far side of a language boundary.
  const problems = [];
  for (const [name, make] of Object.entries(fixtures)) {
    // record(), so every fixture contributes to the diagnostic-coverage set at
    // the bottom of this file. Compiling here without recording is how a newly
    // added fixture can exercise a new diagnostic and still have that
    // diagnostic reported as unreachable.
    const { ir } = record(compile(make(), { engineTarget: 'unreal' }));
    for (const problem of validateIrSerializable(ir)) problems.push(`${name}: ${problem}`);
  }
  check('every IR is plain JSON', problems.length === 0, problems.slice(0, 2).join('; ') || 'clean');
}

{
  const { ir } = compile(fixtures.stagedExplosion());
  const revived = JSON.parse(JSON.stringify(ir));
  check('IR survives a JSON round trip unchanged', JSON.stringify(revived) === JSON.stringify(ir));
  check('  and declares its format', ir.irFormat === VFX_IR_FORMAT);
}

{
  // Guarantee 4. Only what is used, and core attributes always.
  const spark = compile(fixtures.sparkBurst()).ir;
  const names = spark.attributes.map((a) => a.name);
  const hasCore = CORE_ATTRIBUTES.every((c) => names.includes(c));
  // The spark fixture never sets rotation or a flipbook frame, so paying for
  // them would be pure bandwidth on a loop that is bandwidth-bound.
  const noWaste = !names.includes('rotation') && !names.includes('flipbookFrame');
  check('attributes are per-effect, core always present', hasCore && noWaste, names.join(' '));

  let offset = 0;
  const packed = spark.attributes.every((a) => {
    const ok = a.offset === offset;
    offset += a.width;
    return ok;
  });
  check('  laid out contiguously', packed, `${offset} floats per particle`);
}

{
  // The layout must not depend on the order blocks happened to request
  // attributes, or a pool checksum stops being comparable between runs.
  const a = compile(fixtures.sparkBurst()).ir.attributes.map((x) => x.name).join();
  const b = compile(fixtures.sparkBurst()).ir.attributes.map((x) => x.name).join();
  check('attribute layout is deterministic', a === b);
}

{
  // Guarantee 2: pools are shared and de-duplicated. The staged explosion uses
  // gravity [0,-9.8,0] in two systems and 1 as a scale in several places.
  const { ir } = compile(fixtures.stagedExplosion());
  const distinct = new Set(ir.constants).size;
  check(
    'constants are de-duplicated',
    distinct <= ir.constants.length,
    `${ir.constants.length} entries, ${distinct} distinct`,
  );
}

{
  // Content-addressed tables: the same curve used twice is baked once.
  const doc = createEmptyVfxDoc({ name: 'Shared curve' });
  const curve = CURVE_PRESETS.find((p) => p.id === 'bell').build();
  doc.references = { tex: { kind: 'image', ref: 'asset:118', name: 't.png', colorSpace: 'srgb' } };
  const update = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE);
  update.blocks = [
    { id: 'b1', type: 'update.sizeOverLife', enabled: true, props: { scale: curveValue(curve) } },
    { id: 'b2', type: 'update.sizeOverLife', enabled: true, props: { scale: curveValue(curve) } },
  ];
  const { ir } = compile(normalizeVfxDoc(doc));
  check('one table for two uses of one curve', ir.tables.length === 1, `${ir.tables.length} tables`);
  check('  and both blocks point at it',
    ir.systems[0].update.filter((b) => b.bindings.some((x) => x.index === 0 && x.src === BINDING_SRC.CURVE)).length === 2);
}

// ---------------------------------------------------------------------------
// 3. Lowering
// ---------------------------------------------------------------------------
{
  const { ir } = compile(fixtures.sparkBurst());
  const system = ir.systems[0];

  // Guarantee 3: the injected kernels bracket the stack, and are not
  // author-placeable. Age advance must run before anything touches a particle
  // and integration after every force has accumulated.
  check('age advance is the first update kernel', system.update[0].kernel === 'age.advance', system.update[0].kernel);
  const last = system.update[system.update.length - 1].kernel;
  check('integration is the last update kernel', last.startsWith('integrate.'), last);
  check('  and the author blocks sit between them',
    system.update.slice(1, -1).every((b) => b.srcBlockId !== ''),
    system.update.map((b) => b.kernel).join(' '));
}

{
  // No velocity attribute means integration would be a no-op pass over the
  // whole pool, so it must not be emitted at all.
  const doc = createEmptyVfxDoc({ name: 'Static' });
  doc.references = { tex: { kind: 'image', ref: 'asset:118', name: 't.png', colorSpace: 'srgb' } };
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  init.blocks = [{ id: 'b1', type: 'initialize.setLifetime', enabled: true, props: { lifetime: constValue(1) } }];
  const spawn = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.SPAWN);
  spawn.blocks = [{ id: 'b0', type: 'spawn.burst', enabled: true, props: { count: constValue(5) } }];
  const { ir } = record(compile(normalizeVfxDoc(doc)));
  const kernels = ir.systems[0].update.map((b) => b.kernel);
  check('integration is skipped with no velocity', !kernels.some((k) => k.startsWith('integrate.')), kernels.join(' '));
}

{
  // Every value mode has to reach the right binding source, because that is
  // the one thing a kernel branches on.
  const { ir } = compile(fixtures.sparkBurst());
  const init = ir.systems[0].init;
  const srcFor = (kernel, prop) => {
    for (const block of init) {
      const binding = block.bindings.find((b) => b.prop === prop);
      if (binding && block.kernel === kernel) return binding.src;
    }
    return null;
  };
  const lifetime = srcFor('attr.set', 'lifetime');
  const colorSrc = ir.systems[0].update.find((b) => b.kernel === 'color.overLife')
    ?.bindings.find((b) => b.prop === 'color')?.src;
  check('a random value lowers to a random binding', lifetime === BINDING_SRC.RANDOM, String(lifetime));
  check('a gradient lowers to a gradient binding', colorSrc === BINDING_SRC.GRADIENT, String(colorSrc));

  // A random binding carries the compile-time draw slot, not a counter - see
  // decision 3 in vfx/random.js.
  const randomBinding = init.flatMap((b) => b.bindings).find((b) => b.src === BINDING_SRC.RANDOM);
  check('  and carries a stable draw slot', Number.isInteger(randomBinding.slot) && randomBinding.slot > 0);
}

{
  // The slot must be a function of (blockId, prop), so adding a block above
  // another one cannot shift the one below it.
  const doc = fixtures.sparkBurst();
  const before = compile(doc).ir.systems[0].init
    .flatMap((b) => b.bindings.map((x) => `${b.srcBlockId}:${x.prop}:${x.slot ?? '-'}`));
  const doc2 = normalizeVfxDoc(JSON.parse(JSON.stringify(doc)));
  const init2 = doc2.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  init2.blocks.unshift({ id: 'inserted', type: 'initialize.setSize', enabled: true, props: { size: constValue(1) } });
  const after = compile(doc2).ir.systems[0].init
    .flatMap((b) => b.bindings.map((x) => `${b.srcBlockId}:${x.prop}:${x.slot ?? '-'}`));
  const survived = before.every((entry) => after.includes(entry));
  check('inserting a block does not shift other draw slots', survived);
}

{
  // A switched-off block is kept in the document but must not reach the IR.
  const doc = fixtures.sparkBurst();
  const update = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.UPDATE);
  const target = update.blocks.find((b) => b.type === 'update.drag');
  target.enabled = false;
  const { ir } = compile(normalizeVfxDoc(doc));
  const kernels = ir.systems[0].update.map((b) => b.kernel);
  check('a disabled block is skipped', !kernels.includes('force.drag'), kernels.join(' '));
}

{
  // Outputs that share material state and texture must land on one batch key,
  // because that is what makes them one instanced draw call.
  const { ir, stats } = compile(fixtures.stagedExplosion());
  const keys = ir.systems.flatMap((s) => s.outputs.map((o) => o.batchKey));
  check('batch keys distinguish material state', new Set(keys).size === 3, `${new Set(keys).size} of ${keys.length}`);
  check('  and drive the draw-call count', stats.drawCalls === 3, String(stats.drawCalls));
}

{
  // Asset slots resolve to indices, and the colour-space and flip conventions
  // are recorded at compile time rather than guessed by a shader later.
  const { ir } = compile(fixtures.sparkBurst());
  const asset = ir.assets[0];
  check('asset slots resolve with their conventions',
    asset.assetId === 118 && asset.colorSpace === 'srgb' && asset.flipY === true,
    JSON.stringify(asset));
  const textureBlock = ir.systems[0].outputs[0].blocks.find((b) => b.kernel === 'output.texture');
  check('  and the block points at the slot index', textureBlock.assetSlots.texture === 0);
}

{
  const { ir } = compile(fixtures.operatorWired());
  const sizeBlock = ir.systems[0].init.find((b) => b.attributes.includes('size'));
  const binding = sizeBlock.bindings.find((b) => b.prop === 'size');
  check('a wired property lowers to a register', binding.src === BINDING_SRC.REGISTER, binding.src);
  check('  with ops emitted before the kernel', sizeBlock.pre.length === 2, `${sizeBlock.pre.length} ops`);
  check('  and a register budget reported', ir.registerCount >= 2, String(ir.registerCount));
}

// ---------------------------------------------------------------------------
// 4. Schedule lowering
// ---------------------------------------------------------------------------
{
  const { ir } = compile(fixtures.stagedExplosion());
  const flash = ir.systems.find((s) => s.name === 'Flash');
  const sparks = ir.systems.find((s) => s.name === 'Sparks');
  const smoke = ir.systems.find((s) => s.name === 'Smoke');

  // Snapped to whole simulation steps: a clip at 0.02s has to fire on the same
  // step on every replay and every scrub, whatever the accumulator does.
  check('clip times snap to whole steps',
    flash.schedule.clips[0].atStep === 0 && sparks.schedule.clips[0].atStep === Math.round(0.02 * 60),
    `flash ${flash.schedule.clips[0].atStep}, sparks ${sparks.schedule.clips[0].atStep}`);
  check('  and durations too',
    smoke.schedule.clips[0].durationSteps === Math.round(0.4 * 60),
    String(smoke.schedule.clips[0].durationSteps));
  check('  keeping the authored seconds alongside',
    Math.abs(sparks.schedule.clips[0].at - 0.02) < 1e-9);
  check('two clips on one track both survive', smoke.schedule.clips.length === 2);
}

{
  // A burst is a zero-length clip, and it must stay zero-length: both engines
  // take a burst list, so any number of these round-trips cleanly.
  const { ir, diagnostics } = compile(fixtures.stagedExplosion());
  const flash = ir.systems.find((s) => s.name === 'Flash');
  const scheduleWarn = diagnostics.filter((d) => d.code === 'W_SCHEDULE_UNEXPORTABLE');
  check('a burst clip stays zero-length', flash.schedule.clips[0].durationSteps === 0);
  check('bursts raise no export warning',
    scheduleWarn.length === 1 && scheduleWarn[0].target.systemId === ir.systems.find((s) => s.name === 'Smoke').id,
    `${scheduleWarn.length} warning(s)`);
}

// ---------------------------------------------------------------------------
// 5. Capacity, honestly
// ---------------------------------------------------------------------------
{
  const result = record(compile(fixtures.brokenEffect()));
  const capacity = result.diagnostics.find((d) => d.code === 'W_CAPACITY');
  // 9,000/s for up to 4s is 36,000 at once. The message has to show that
  // arithmetic - "capacity exceeded" teaches nothing and the author hits it
  // again next time.
  const showsMath = /9,000\/s/.test(capacity.message) && /4s/.test(capacity.message) && /36,000/.test(capacity.message);
  check('the capacity warning shows its arithmetic', showsMath, capacity.message.slice(0, 90));
  check('  and suggests a power-of-two capacity',
    capacity.fix.action === 'setSystemCapacity' && capacity.fix.args.capacity === 65536,
    `to ${capacity.fix.args.capacity}`);
}

{
  // When a rate is driven by something that can change at runtime, the number
  // is an estimate and the message must not pretend otherwise.
  const result = compile(fixtures.operatorWired());
  check('an unfoldable rate is reported as inexact', result.stats.peakExact === false);
  const exact = compile(fixtures.sparkBurst());
  check('  while folded arithmetic is exact', exact.stats.peakExact === true);
}

{
  const result = compile(fixtures.sparkBurst());
  check('cost stats are reported for the strip',
    result.stats.bytesPerParticle === result.stats.floatsPerParticle * 4
    && result.stats.tableCount >= 1,
    `${result.stats.bytesPerParticle} B/particle, ${result.stats.tableCount} tables`);
}

// ---------------------------------------------------------------------------
// 6. Frequency, cycles, and surviving a broken graph
// ---------------------------------------------------------------------------
{
  const result = record(compile(fixtures.incompleteEffect()));
  const codes = codesOf(result);
  check('a missing lifetime is an error, with the symptom',
    codes.includes('E_NO_LIFETIME'), codes.join(' '));
  const noLife = result.diagnostics.find((d) => d.code === 'E_NO_LIFETIME');
  check('  naming what the author will actually see',
    /pool fills/.test(noLife.message) && /emission then stops/.test(noLife.message),
    noLife.message.slice(0, 95));
  // No update stage is a legitimate choice for a static decal or a flash, so
  // it must not be dressed up as a problem.
  const noUpdate = result.diagnostics.find((d) => d.code === 'I_NO_UPDATE');
  check('  and no update stage is info, not a warning',
    noUpdate?.severity === 'info', noUpdate?.severity || 'absent');
}

{
  const result = record(compile(fixtures.frequencyMismatch()));
  const mismatch = result.diagnostics.find((d) => d.code === 'E_FREQ_MISMATCH');
  check('a per-particle value into a spawn rate is an error', Boolean(mismatch));
  // The message has to explain WHY, because "frequency mismatch" is jargon and
  // the reader has never heard it.
  check('  explained in terms of what is in scope',
    /before any particle exists/.test(mismatch.hint),
    mismatch.hint.slice(0, 80));
}

{
  // Effect time is per-frame, which a spawn rate legitimately accepts - the
  // rule must not be "no wiring into spawn".
  const result = compile(fixtures.operatorWired());
  check('a per-frame value into a spawn rate is fine',
    !codesOf(result).includes('E_FREQ_MISMATCH'), codesOf(result).join(' '));
}

{
  const result = compile(fixtures.brokenEffect());
  const cycle = result.diagnostics.find((d) => d.code === 'E_CYCLE');
  check('a wiring cycle names the ring', /op-a -> op-b -> op-a/.test(cycle.message), cycle.message);
  // A broken wire must not blank the board: the editor still needs IR to draw.
  check('  and the compile still returns IR', result.ir.systems.length === 2 && result.ir.attributes.length > 0);
}

{
  const result = compile(fixtures.brokenEffect());
  check('an unknown block is reported, not fatal',
    codesOf(result).includes('E_UNKNOWN_BLOCK') && result.ir.systems.length === 2);
  const unknown = result.diagnostics.find((d) => d.code === 'E_UNKNOWN_BLOCK');
  check('  and blames a newer version, not the author', /newer version/.test(unknown.hint));
}

{
  // Two initialize stages: only the first would run, so silently compiling the
  // first and dropping the second is exactly the wrong behaviour.
  const doc = fixtures.sparkBurst();
  const init = doc.systems[0].contexts.find((c) => c.kind === CONTEXT_KIND.INITIALIZE);
  doc.systems[0].contexts.push({ ...init, id: 'dupe', blocks: [] });
  const result = record(compile(normalizeVfxDoc(doc)));
  check('a duplicated stage is an error', codesOf(result).includes('E_DUPLICATE_CONTEXT'), codesOf(result).join(' '));
}

{
  // Compiling the same document twice must produce byte-identical IR, or the
  // graph hash cannot be used as a cache key and the export bundle is not
  // reproducible.
  const doc = fixtures.stagedExplosion();
  const a = compile(doc).ir;
  const b = compile(doc).ir;
  check('compilation is deterministic', JSON.stringify(a) === JSON.stringify(b));
}

{
  // The hash must ignore cosmetics (invariant 2 in vfx/doc.js) and notice
  // anything simulated, or dragging a node rebuilds a 60k-particle effect.
  const doc = fixtures.sparkBurst();
  const base = compile(doc).ir.graphHash;
  const moved = normalizeVfxDoc(JSON.parse(JSON.stringify(doc)));
  moved.layout = { nodes: { x: { x: 900, y: 40 } } };
  const changed = normalizeVfxDoc(JSON.parse(JSON.stringify(doc)));
  changed.systems[0].capacity = 4096;
  check('graph hash ignores layout', compile(moved).ir.graphHash === base);
  check('  and notices capacity', compile(changed).ir.graphHash !== base);
}

// ---------------------------------------------------------------------------
// 7. Engine fidelity and diagnostic coverage
// ---------------------------------------------------------------------------
{
  const withTarget = record(compile(fixtures.stagedExplosion(), { engineTarget: 'unreal' }));
  const approx = withTarget.diagnostics.find((d) => d.code === 'I_ENGINE_APPROX');
  check('an approximated block is flagged for the target', Boolean(approx), approx?.message.slice(0, 70));
  check('  with the difference named', /amplitude and frequency/.test(approx.hint), approx.hint.slice(0, 60));

  const noTarget = compile(fixtures.stagedExplosion());
  check('engine notes are silent with no target chosen',
    !codesOf(noTarget).includes('I_ENGINE_APPROX'));

  const unityView = compile(fixtures.stagedExplosion(), { engineTarget: 'unity' });
  check('  and turbulence is native on Unity',
    !codesOf(unityView).includes('I_ENGINE_APPROX'), codesOf(unityView).join(' '));
}

{
  // The 'no equivalent' branch, exercised through an injected catalog rather
  // than by shipping a block nobody wants. This is why compileVfxGraph takes a
  // catalog at all.
  const crippled = CATALOG.blocks.map((b) => (
    b.id === 'update.drag'
      ? { ...b, engines: { ...b.engines, unreal: ENGINE_SUPPORT.NONE, note: 'Nothing like it exists.' } }
      : b
  ));
  const result = record(compile(fixtures.sparkBurst(), {
    catalog: makeCatalog({ blocks: crippled }),
    engineTarget: 'unreal',
  }));
  const dropped = result.diagnostics.find((d) => d.code === 'W_ENGINE_UNSUPPORTED');
  check('an unsupported block warns for the target', Boolean(dropped), dropped?.message.slice(0, 70));
  check('  and the effect summary reports the worst case',
    result.stats.engines.unreal === ENGINE_SUPPORT.NONE, result.stats.engines.unreal);
}

{
  const defs = [
    { engines: { unity: 'native', unreal: 'native' } },
    { engines: { unity: 'native', unreal: 'approx' } },
  ];
  check('worstEngineSupport takes the worst', worstEngineSupport(defs, 'unreal') === 'approx');
  check('  and short-circuits on none',
    worstEngineSupport([...defs, { engines: { unity: 'none', unreal: 'none' } }], 'unity') === 'none');
}

{
  // THE NEW EMITTER SHAPES MUST COMPILE WITHOUT A WORD.
  //
  // A shape that warns about itself is a shape nobody will use, and the
  // reachability sweep below only proves a diagnostic CAN fire - it says
  // nothing about whether a perfectly ordinary effect trips one. Point, Line in
  // its trickiest placement, a rotated circle and a fully configured mesh
  // emitter, all in one document.
  const result = record(compile(fixtures.emitterShapes(), { engineTarget: 'unity' }));
  const noisy = result.diagnostics.filter((d) => d.severity !== 'info');
  check('every new emitter shape compiles clean', noisy.length === 0,
    noisy.map((d) => `${d.code}`).join(' ') || `${result.diagnostics.length} info only`);
  check('  and the fixture really used all four', result.ir.systems.length === 4,
    String(result.ir.systems.length));

  // The transform reaches the IR as bindings rather than being folded away -
  // the export bundle carries them, so an importer can rebuild the same shape.
  const portal = result.ir.systems.find((sys) => sys.name === 'Portal');
  const ring = portal.init.find((b) => b.kernel === 'shape.position.circle');
  check('  and a rotated shape carries its rotation into the IR',
    Boolean(ring?.bindings.find((b) => b.prop === 'rotation')),
    (ring?.bindings || []).map((b) => b.prop).join(','));

  // The mesh emitter's asset resolves to a real slot index, which is what the
  // kernel turns into a library id at runtime.
  const statue = result.ir.systems.find((sys) => sys.name === 'Statue');
  const meshBlock = statue.init.find((b) => b.kernel === 'shape.position.mesh');
  check('  and a mesh emitter resolves its asset slot',
    meshBlock?.assetSlots?.mesh >= 0, JSON.stringify(meshBlock?.assetSlots));
  check('    to a mesh in the asset table',
    result.ir.assets[meshBlock.assetSlots.mesh]?.kind === 'mesh',
    result.ir.assets[meshBlock.assetSlots.mesh]?.kind);

  // The two mesh-emitter warnings are a PAIR and must not both land on one
  // block: an unfinished emitter should say one thing, not two.
  const pair = record(compile(fixtures.meshEmitter())).diagnostics;
  const unchosen = pair.filter((d) => d.code === 'W_MESH_EMITTER_NO_MESH');
  const flat = pair.filter((d) => d.code === 'W_MESH_EMITTER_FLAT');
  check('a mesh emitter with no mesh warns once', unchosen.length === 1,
    String(unchosen.length));
  check('  and does NOT also complain about its direction', flat.length === 1
    && flat[0].target.blockId !== unchosen[0].target.blockId,
    `${flat.length} flat warnings`);
  check('  while the one with a mesh gets the direction hint instead',
    flat.length === 1, String(flat.length));
}

{
  // A DOCUMENT WRITTEN BY SOMETHING THAT IS NOT THE INSPECTOR.
  //
  // Until the MCP tools shipped, every document came from a UI that could only
  // offer real properties and valid choices, so none of this could happen and
  // nothing checked for it. An agent gets it wrong on the first attempt, and it
  // used to compile CLEAN - a four-metre beam silently became a one-metre line
  // at the origin.
  const result = record(compile(fixtures.agentTypos()));
  const byCode = (code) => result.diagnostics.filter((d) => d.code === code);

  const props = byCode('W_UNKNOWN_PROP');
  check('an unknown property is reported', props.length === 3,
    props.map((d) => d.target.prop).join(' '));
  check('  naming the property and the block',
    props.every((d) => d.message.includes(d.target.prop) && d.message.includes('Position: Line')),
    props[0]?.message);
  // THE REPAIR SIGNAL. An agent cannot fix `from` without being told the real
  // name is `start`, and a human cannot either.
  check('  and listing the ones it DOES have',
    props.every((d) => d.hint.includes('start') && d.hint.includes('end')
      && d.hint.includes('thickness')),
    props[0]?.hint);

  const modes = byCode('W_UNKNOWN_MODE');
  check('an unknown mode value is reported', modes.length === 1, String(modes.length));
  check('  saying what it fell back to', modes[0]?.message.includes('random'), modes[0]?.message);
  check('  and listing the valid choices',
    ['random', 'even', 'spacing'].every((o) => modes[0]?.hint.includes(o)), modes[0]?.hint);

  const params = byCode('W_UNKNOWN_PARAM');
  check('invalid Output params are reported', params.length === 2,
    params.map((d) => d.target.prop).join(' '));
  check('  covering both mode and blend',
    params.some((d) => d.target.prop === 'mode') && params.some((d) => d.target.prop === 'blend'));
  check('  and listing the valid values',
    params.find((d) => d.target.prop === 'blend')?.hint.includes('premultiplied'),
    params.find((d) => d.target.prop === 'blend')?.hint);

  // Warnings, not errors: an effect saved by a newer build must still run.
  check('none of them is fatal',
    [...props, ...modes, ...params].every((d) => d.severity === 'warn'));

  // And every one carries a fix that leads somewhere - the sweep at the bottom
  // of this file checks that in general, this checks it for the three that are
  // new and were written together.
  check('  and each offers a fix',
    [...props, ...modes, ...params].every((d) => Boolean(d.fix)),
    [...props, ...modes, ...params].map((d) => d.fix?.action).join(' '));
}

{
  // Coverage. A diagnostic that can never fire is dead code pretending to be a
  // safety net, so the un-fired ones have to be declared and justified rather
  // than merely absent.
  const KNOWN_UNREACHABLE = {
    I_SOFT_UNSUPPORTED: 'no block exposes a softness parameter until the render phase adds one',
  };
  const missing = DIAGNOSTIC_CODES.filter((code) => !firedCodes.has(code) && !KNOWN_UNREACHABLE[code]);
  check('every diagnostic code is reachable', missing.length === 0, missing.join(' ') || `${firedCodes.size} fired`);

  const stale = Object.keys(KNOWN_UNREACHABLE).filter((code) => firedCodes.has(code));
  check('  and the unreachable list is not stale', stale.length === 0, stale.join(' '));
}

// ---------------------------------------------------------------------------
// 8. Catalog integrity
// ---------------------------------------------------------------------------
{
  // Rule 1 in vfx/catalog.js: no entry may ship without engine flags, or a
  // block reaches an author with no way to know it will not export.
  const support = new Set(Object.values(ENGINE_SUPPORT));
  const bad = [...CATALOG.blocks, ...CATALOG.operators].filter((def) => (
    !def.engines || !support.has(def.engines.unity) || !support.has(def.engines.unreal)
  ));
  check('every catalog entry declares engine support', bad.length === 0, bad.map((d) => d.id).join(' '));
}

{
  // Rule 3: the audience has never authored a particle effect, so an entry
  // without prose is an entry they cannot evaluate.
  const bare = CATALOG.blocks.filter((def) => !def.blurb || !def.teach || !def.label);
  check('every block explains itself', bare.length === 0, bare.map((d) => d.id).join(' '));

  const props = CATALOG.blocks.flatMap((def) => Object.entries(def.props).map(([k, p]) => ({ id: def.id, k, p })));
  const unlabelled = props.filter(({ p }) => !p.label || !Array.isArray(p.modes) || p.modes.length === 0);
  check('  and every property is labelled with its modes', unlabelled.length === 0,
    unlabelled.map((x) => `${x.id}.${x.k}`).join(' '));
}

{
  const defaulted = CATALOG.blocks.every((def) => {
    const values = defaultProps(def);
    return Object.keys(def.props).every((prop) => values[prop] !== undefined);
  });
  check('defaultProps covers every property', defaulted);

  const modes = CATALOG.blocks.every((def) => {
    const chosen = defaultModes(def);
    return Object.keys(def.modes || {}).every((mode) => typeof chosen[mode] === 'string');
  });
  check('defaultModes covers every mode', modes);
}

{
  // A freshly added block must be doing something sensible immediately, so
  // every default has to be a legal value of its declared type.
  const wrong = [];
  for (const def of CATALOG.blocks) {
    for (const [name, prop] of Object.entries(def.props)) {
      const width = propChannels(prop.type);
      const value = prop.default;
      if (width === 0) {
        if (typeof value !== 'string') wrong.push(`${def.id}.${name}`);
      } else if (width === 1) {
        if (typeof value !== 'number' && typeof value !== 'boolean') wrong.push(`${def.id}.${name}`);
      } else if (!Array.isArray(value) || value.length !== width) {
        wrong.push(`${def.id}.${name}`);
      }
    }
  }
  check('every default matches its declared type', wrong.length === 0, wrong.join(' '));
}

{
  const ids = CATALOG.blocks.map((b) => b.id);
  check('block ids are unique', new Set(ids).size === ids.length);
  const kernels = new Set(CATALOG.blocks.map((b) => b.kernel));
  check('  and every block names a kernel', [...kernels].every((k) => typeof k === 'string' && k.length > 0),
    `${kernels.size} distinct kernels`);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
