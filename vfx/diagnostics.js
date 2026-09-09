// Compile diagnostics: what the editor's warning strip shows, and what the
// export bundle records.
//
// This file is where the "the audience is a developer, not a VFX artist"
// requirement actually gets paid for. Every message here has to do three
// things a conventional validator does not:
//
//   SAY WHAT WILL HAPPEN, not what rule was broken. "Particles never die, so
//   the pool fills and emission stops after about a second" beats "missing
//   required block", because the first one describes the symptom the author is
//   already looking at.
//
//   SHOW THE ARITHMETIC. A capacity warning that names the rate, the lifetime,
//   their product and the capacity teaches the relationship. One that says
//   "capacity exceeded" teaches nothing, and the author will hit it again.
//
//   OFFER A FIX THAT IS ONE CLICK. Fixes are DESCRIPTORS - {label, action,
//   args} - not functions, because a diagnostic has to survive JSON.stringify
//   into an export bundle. The editor keeps a registry of appliers keyed by
//   `action`, and each applier is a pure doc -> doc transform, so applying a
//   fix is an ordinary undo entry like any other edit.
//
// Severity means something specific here:
//   error - the effect cannot work. Nothing renders, or the compile is invalid.
//   warn  - it will run, and it will not do what the author intended.
//   info  - it will run and look right here, but something is worth knowing
//           (usually a fidelity gap on the way into an engine).

/** @type {Readonly<{ERROR: string, WARN: string, INFO: string}>} */
export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
});

// Thousands separators, because the numbers in these messages are the point
// and "12000" reads as noise where "12,000" reads as a quantity.
const n = (value) => {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return rounded.toLocaleString('en-US');
};

const pct = (value) => `${Math.round(value * 100)}%`;

// A brightness of 0.00002 rounds to "0%", which reads as a formatting bug
// rather than as a measurement. Below one percent, say so in words instead.
const pctSmall = (value) => (value >= 0.01 ? `${Math.round(value * 100)}%` : 'under 1%');

// Round up to the next power of two. Capacity is a pool size, and the runtime
// allocates powers of two, so suggesting 8,192 rather than 8,000 means the fix
// is the number the author will actually end up with.
const nextPow2 = (value) => {
  let size = 1;
  while (size < value && size < 1 << 24) size <<= 1;
  return size;
};

/**
 * Every diagnostic the compiler can raise.
 *
 * Keyed by code so the editor can style, group and filter by it, and so a
 * bundle's warnings stay meaningful to a plugin that has never seen our UI.
 * `message` and `hint` are functions of the facts the compiler gathered;
 * `fix` is optional and only present where there is an unambiguous action.
 */
const DEFS = Object.freeze({
  // --- Structure: the effect cannot work at all -----------------------------
  E_NO_SPAWN: {
    severity: SEVERITY.ERROR,
    title: 'Nothing is being emitted',
    message: (d) => `"${d.systemName}" has no spawn block, so it never emits a particle.`,
    hint: () => 'A Spawn Rate block emits a steady stream; a Spawn Burst emits a batch at once. Impacts are usually bursts, fire and smoke are usually rates.',
    fix: (d) => ({
      label: 'Add Spawn Rate',
      action: 'addBlock',
      args: { systemId: d.systemId, contextKind: 'spawn', blockType: 'spawn.rate' },
    }),
  },
  E_NO_OUTPUT: {
    severity: SEVERITY.ERROR,
    title: 'Nothing is drawn',
    message: (d) => `"${d.systemName}" simulates particles but has no Output, so none of them are drawn.`,
    hint: () => 'An Output decides how a particle is rendered - as a camera-facing sprite, a stretched streak, or a mesh.',
    fix: (d) => ({
      label: 'Add a sprite Output',
      action: 'addContext',
      args: { systemId: d.systemId, contextKind: 'output' },
    }),
  },
  E_NO_LIFETIME: {
    severity: SEVERITY.ERROR,
    title: 'Particles never die',
    message: (d) => `"${d.systemName}" never sets a lifetime, so its particles live forever. The pool fills to ${n(d.capacity)} and emission then stops.`,
    hint: () => 'Everything measured "over life" also needs this, because there is no life to measure against without it.',
    fix: (d) => ({
      label: 'Add Set Lifetime (1.5s)',
      action: 'addBlock',
      args: { systemId: d.systemId, contextKind: 'initialize', blockType: 'initialize.setLifetime' },
    }),
  },
  E_DUPLICATE_CONTEXT: {
    severity: SEVERITY.ERROR,
    title: 'Duplicated stage',
    message: (d) => `"${d.systemName}" has ${d.count} ${d.contextKind} stages. Only one is allowed, and only the first would run.`,
    hint: () => 'Merge the blocks into a single stage. A system is one linear chain: spawn, then initialize, then update, then one or more outputs.',
  },
  E_BLOCK_WRONG_CONTEXT: {
    severity: SEVERITY.ERROR,
    title: 'Block in the wrong stage',
    message: (d) => `"${d.blockLabel}" cannot go in the ${d.contextKind} stage.`,
    hint: (d) => `It belongs in ${d.allowed.join(' or ')}. ${d.reason || ''}`.trim(),
    fix: (d) => ({
      label: `Move to ${d.allowed[0]}`,
      action: 'moveBlock',
      args: { blockId: d.blockId, toContextKind: d.allowed[0] },
    }),
  },
  E_UNKNOWN_BLOCK: {
    severity: SEVERITY.ERROR,
    title: 'Unrecognised block',
    message: (d) => `This effect uses a block type this build does not know: "${d.blockType}".`,
    hint: () => 'Either it was saved by a newer version of the app - updating should restore it - or the name is wrong. Removing the block lets the rest of the effect run.',
    fix: (d) => ({ label: 'Remove the block', action: 'removeBlock', args: { blockId: d.blockId } }),
  },
  E_CYCLE: {
    severity: SEVERITY.ERROR,
    title: 'Wiring loops back on itself',
    message: (d) => `These nodes feed each other in a circle: ${d.nodeIds.join(' -> ')} -> ${d.nodeIds[0]}.`,
    hint: () => 'A value cannot depend on itself. Cut one of the wires in the loop.',
  },
  E_FREQ_MISMATCH: {
    severity: SEVERITY.ERROR,
    title: 'A per-particle value cannot drive this',
    message: (d) => `"${d.propLabel}" on ${d.blockLabel} is being fed ${d.gotLabel}, but it can only accept ${d.wantLabel}.`,
    hint: (d) => `${d.reason} Wire something that does not vary per particle, or set the property directly.`,
  },

  // --- Behaviour: it runs, but not as intended ------------------------------
  W_CAPACITY: {
    severity: SEVERITY.WARN,
    title: 'Particles will be dropped',
    message: (d) => (
      `${d.exact ? '' : 'At its current settings, '}"${d.systemName}" asks for about `
      + `${n(d.peak)} particles at once (${n(d.rate)}/s for up to ${n(d.lifetime)}s), `
      + `but its capacity is ${n(d.capacity)}. `
      + `Roughly ${pct(1 - d.capacity / d.peak)} of them will never be emitted.`
    ),
    hint: (d) => (
      'Spawn rate times the longest lifetime is how many particles exist at once. Either raise the capacity or lower one of those two.'
      + (d.exact ? '' : ' This one is an estimate, because the spawn rate is driven by something that can change while the effect runs.')
    ),
    fix: (d) => ({
      label: `Raise capacity to ${n(nextPow2(d.peak))}`,
      action: 'setSystemCapacity',
      args: { systemId: d.systemId, capacity: nextPow2(d.peak) },
    }),
  },
  E_EVENT_NO_SOURCE: {
    severity: SEVERITY.ERROR,
    title: 'This sub-emitter is not watching anything',
    message: (d) => (
      `"${d.systemName}" is set to emit when ${d.trigger}, but no system has `
      + 'been chosen to watch - so nothing will ever trigger it.'
    ),
    hint: () => 'Pick the system whose particles should raise the event, in the Event stage.',
  },
  E_EVENT_SELF: {
    severity: SEVERITY.ERROR,
    title: 'A system cannot watch itself',
    message: (d) => (
      `"${d.systemName}" is watching its own particles, so every particle it `
      + 'emits would immediately emit more - without limit.'
    ),
    hint: () => 'Sub-emitters need a different system as their source. Duplicate this one and have the copy watch the original.',
  },
  E_EVENT_CYCLE: {
    severity: SEVERITY.ERROR,
    title: 'Sub-emitters form a loop',
    message: (d) => (
      `"${d.systemName}" is part of a chain that leads back to itself, so its `
      + 'particles would spawn each other without limit.'
    ),
    hint: () => 'Follow the "Watching" setting on each Event stage: somewhere along the chain one of them points back at an earlier system.',
  },
  E_EVENT_TOO_DEEP: {
    severity: SEVERITY.ERROR,
    title: 'Sub-emitters are nested too deeply',
    message: (d) => (
      `"${d.systemName}" is at the end of a chain more than ${d.limit} systems `
      + 'long. Each level multiplies the particle count, so the limit is a '
      + 'guard rather than a preference.'
    ),
    hint: () => 'Three levels - a shell, its sparks, and their smoke - covers essentially every effect. Beyond that the count grows faster than any capacity can hold.',
  },
  W_UNKNOWN_PROP: {
    severity: SEVERITY.WARN,
    title: 'A property this block does not have',
    message: (d) => `"${d.blockLabel}" was given a property called "${d.prop}", which it does not have - so it is being ignored and the real one is using its default.`,
    // A WARNING, NOT AN ERROR, for the same reason E_UNKNOWN_BLOCK is tolerant:
    // an effect saved by a newer build should still run. But it MUST be
    // reported, because the failure is otherwise invisible - the block keeps
    // working, on defaults, and the value the author (or the agent) set does
    // nothing at all.
    //
    // THIS EXISTS BECAUSE AGENTS WRITE DOCUMENTS NOW. A human using the editor
    // cannot produce an unknown property: the inspector only offers the ones
    // the catalog declares. Anything writing JSON directly - the MCP tools, a
    // hand-edited file, a script - does it constantly, and used to get silence.
    hint: (d) => (d.known?.length
      ? `This block's properties are: ${d.known.join(', ')}.`
      : 'This block has no properties.'),
    fix: (d) => ({
      label: `Remove "${d.prop}"`,
      action: 'removeProp',
      args: { blockId: d.blockId, prop: d.prop },
    }),
  },
  W_UNKNOWN_MODE: {
    severity: SEVERITY.WARN,
    title: 'A choice this block does not offer',
    message: (d) => `"${d.blockLabel}" has ${d.mode} set to "${d.value}", which is not one of its choices - it is running as "${d.fallback}" instead.`,
    hint: (d) => `Valid values are: ${d.options.join(', ')}.`,
    fix: (d) => ({
      label: `Set to "${d.fallback}"`,
      action: 'setBlockMode',
      args: { blockId: d.blockId, mode: d.mode, value: d.fallback },
    }),
  },
  W_UNKNOWN_PARAM: {
    severity: SEVERITY.WARN,
    title: 'A setting this stage does not offer',
    message: (d) => `The ${d.contextLabel} stage in "${d.systemName}" has ${d.param} set to "${d.value}", which is not one of its choices - it is running as "${d.fallback}" instead.`,
    hint: (d) => `Valid values are: ${d.options.join(', ')}.`,
    fix: (d) => ({
      label: `Set to "${d.fallback}"`,
      action: 'setContextParam',
      args: { contextId: d.contextId, param: d.param, value: d.fallback },
    }),
  },
  W_MESH_EMITTER_NO_MESH: {
    severity: SEVERITY.WARN,
    title: 'The mesh emitter has no mesh',
    message: (d) => `"${d.systemName}" spawns over a mesh, but no model has been chosen - so every particle is born at one point instead.`,
    // A WARNING rather than an info, unlike the missing sprite. A missing
    // texture still draws something reasonable (the built-in blob); a missing
    // emitter mesh collapses the whole SHAPE of the effect to a single point,
    // which is not a degraded version of what was asked for.
    hint: () => 'Pick a mesh from the library, or swap the block for a shape that needs no asset - Sphere, Box and Line all describe themselves.',
    fix: (d) => ({
      label: 'Choose a mesh...',
      action: 'pickAsset',
      args: { blockId: d.blockId, prop: 'mesh', assetType: 'mesh' },
    }),
  },
  W_MESH_EMITTER_FLAT: {
    severity: SEVERITY.INFO,
    title: 'Mesh emission has no direction',
    message: (d) => `"${d.systemName}" spawns over a mesh with Normal speed at 0, so nothing carries the surface's direction.`,
    // The single most common way a mesh emitter disappoints: the silhouette is
    // right and the effect still reads as noise, because without the normals
    // nothing tells the viewer which way the surface faced. Info rather than a
    // warning, because pairing it with a separate velocity block is a perfectly
    // good reason to leave it at zero.
    hint: () => 'Raise Normal speed so particles leave along the surface they were born on. Skip this if another block already gives them a direction.',
    fix: (d) => ({
      label: 'Set Normal speed to 0.5',
      action: 'setProp',
      args: { blockId: d.blockId, prop: 'normalSpeed', value: 0.5 },
    }),
  },
  W_MESH_MODE_MISSING: {
    severity: SEVERITY.WARN,
    title: 'The chosen mesh is not being used',
    message: (d) => (
      `"${d.systemName}" has a Particle Mesh block, but its Output is set to `
      + `draw as "${d.mode}" - so the model is ignored and flat sprites are `
      + 'drawn instead.'
    ),
    hint: () => 'Two settings have to agree: the block chooses WHICH model, and the Output\'s "Render as" chooses whether a model is drawn at all.',
    fix: (d) => ({
      label: 'Draw as Mesh',
      action: 'setContextParam',
      args: { contextId: d.contextId, param: 'mode', value: 'mesh' },
    }),
  },
  W_FLIPBOOK_FRAME_COUNT: {
    severity: SEVERITY.WARN,
    title: 'The player and the sheet disagree',
    message: (d) => `"${d.systemName}" has a ${d.columns} by ${d.rows} sheet - ${d.tiles} frames - but Play Sprite Sheet is set to ${d.frames}.`,
    // THE HALF-CONFIGURED CASE THAT SURVIVES THE OTHER FIX. Adding the player
    // through W_FLIPBOOK_NOT_PLAYED gives it the DEFAULT 16 frames, which is
    // right for a 4x4 sheet and wrong for every other size - and being wrong
    // looks like a broken animation rather than a mismatched number: too few
    // and the last frames never show, too many and it plays past the sheet into
    // whatever the atlas has after it.
    hint: (d) => (d.frames < d.tiles
      ? `Only the first ${d.frames} of ${d.tiles} frames are ever shown.`
      : `It runs past the end of the sheet after frame ${d.tiles}.`),
    fix: (d) => ({
      label: `Play all ${d.tiles} frames`,
      action: 'setProp',
      args: { blockId: d.blockId, prop: 'frames', value: d.tiles },
    }),
  },
  W_FLIPBOOK_NOT_PLAYED: {
    severity: SEVERITY.WARN,
    title: 'The sprite sheet never advances',
    message: (d) => (
      `"${d.systemName}" declares a ${d.frames}-frame sprite sheet but has no `
      + 'Play Sprite Sheet block, so every particle will show frame 1 for its '
      + 'whole life.'
    ),
    hint: () => 'That looks exactly like a texture that has been cropped, which is why it is worth saying: the Output block sets the LAYOUT, and a block in the Update stage is what steps through it.',
    fix: (d) => ({
      label: 'Add Play Sprite Sheet',
      action: 'addBlock',
      args: { systemId: d.systemId, contextKind: 'update', blockType: 'update.flipbook' },
    }),
  },
  W_ZERO_SIZE: {
    severity: SEVERITY.WARN,
    title: 'Particles have no size',
    message: (d) => `Every particle in "${d.systemName}" is zero-sized for its whole life, so nothing will be visible.`,
    hint: () => 'Either Set Size is 0, or a Size Over Life curve sits at 0 throughout.',
    fix: (d) => ({
      label: 'Set size to 0.25m',
      action: 'setProp',
      args: { blockId: d.blockId, prop: 'size', value: 0.25 },
    }),
  },
  W_ZERO_ALPHA: {
    severity: SEVERITY.WARN,
    title: 'Particles are fully transparent',
    message: (d) => `The colour ramp in "${d.systemName}" never rises above ${pct(d.maxAlpha)} opacity, so nothing will show up.`,
    hint: () => 'The alpha rail of the gradient is the fade. It needs to reach full opacity somewhere in the middle.',
    fix: (d) => ({
      label: 'Use the Fade In And Out ramp',
      action: 'setGradientPreset',
      args: { blockId: d.blockId, prop: d.prop, preset: 'fadeInOut' },
    }),
  },
  W_ADDITIVE_DARK: {
    severity: SEVERITY.WARN,
    title: 'Additive blending on a dark colour',
    message: (d) => `"${d.systemName}" uses Additive blending, but its colour ramp averages ${pctSmall(d.luminance)} brightness - it will be nearly invisible.`,
    hint: () => 'Additive blending ADDS light to the scene, so dark is the same as transparent. Either brighten the colour or switch to Alpha blending, which is what smoke wants.',
    fix: (d) => ({
      label: 'Switch to Alpha blending',
      action: 'setContextParam',
      args: { contextId: d.contextId, param: 'blend', value: 'alpha' },
    }),
  },
  I_DEFAULT_SPRITE: {
    severity: SEVERITY.INFO,
    title: 'Using the built-in sprite',
    message: (d) => `The Output in "${d.systemName}" has no texture of its own, so it is drawing with the built-in soft blob.`,
    // Deliberately an info rather than a warning: the effect looks reasonable
    // as it is. The renderer always binds a soft radial sprite when none is
    // chosen (see src/utils/vfx/assets.js), so there is nothing broken here -
    // only something the author might want to improve on.
    hint: () => 'That is the right shape for most smoke, fire and glow. Pick your own for anything with character - a streak, a shard, a flipbook. With Additive blending the texture needs no alpha channel, because its black areas are already invisible.',
    // TWO STATES, TWO DIFFERENT FIXES, and conflating them made the button
    // useless. This fires both when the Output has no Sprite Texture BLOCK and
    // when it has one whose slot is empty; the fix used to be `pickAsset` for
    // both, so in the first case - which is every template that draws with the
    // built-in blob - it pointed at `blockId: ''`. There was nothing to pick a
    // texture FOR. Now the first click adds the block and the second picks the
    // image, and each button says which it does.
    fix: (d) => (d.blockId
      ? {
        label: 'Choose a sprite...',
        action: 'pickAsset',
        args: { blockId: d.blockId, prop: 'texture', assetType: 'image' },
      }
      : {
        label: 'Add a Sprite Texture',
        action: 'addBlock',
        args: { contextId: d.contextId, blockType: 'output.setMainTexture' },
      }),
  },
  W_MISSING_ASSET: {
    severity: SEVERITY.WARN,
    title: 'A referenced asset is missing',
    message: (d) => `The ${d.kind} slot "${d.slot}" points at an asset that is no longer in the library.`,
    hint: () => 'It may have been deleted, or this effect may have come from another installation. Pick a replacement to restore it.',
    fix: (d) => ({
      label: 'Pick a replacement...',
      action: 'pickAsset',
      args: { slot: d.slot, assetType: d.kind === 'mesh' ? 'mesh' : 'image' },
    }),
  },
  W_ALL_BLOCKS_OFF: {
    severity: SEVERITY.WARN,
    title: 'Every block in a stage is switched off',
    message: (d) => `All ${n(d.count)} blocks in the ${d.contextKind} stage of "${d.systemName}" are off, so the stage does nothing.`,
    hint: () => 'A switched-off block is kept but skipped. If this was for debugging, switch them back on.',
  },
  W_UNCONNECTED_OP: {
    severity: SEVERITY.WARN,
    title: 'An operator is not wired to anything',
    message: (d) => `"${d.label}" is not connected to any property, so it has no effect.`,
    hint: () => 'Drag from its output to a block property, or delete it.',
    fix: (d) => ({ label: 'Delete the node', action: 'removeOperator', args: { nodeId: d.nodeId } }),
  },
  W_SORT_COST: {
    severity: SEVERITY.WARN,
    title: 'Depth sorting is expensive here',
    message: (d) => `"${d.systemName}" depth-sorts up to ${n(d.peak)} particles every frame, which costs roughly ${n(d.estimateMs)}ms of CPU time.`,
    hint: () => 'Additive and premultiplied blending are order-independent, so they do not need sorting at all. Only alpha blending usually does.',
    fix: (d) => ({
      label: 'Turn sorting off',
      action: 'setContextParam',
      args: { contextId: d.contextId, param: 'sort', value: 'none' },
    }),
  },

  // --- Engine fidelity ------------------------------------------------------
  W_SCHEDULE_UNEXPORTABLE: {
    severity: SEVERITY.WARN,
    title: 'Timeline clips will not survive export',
    message: (d) => `"${d.systemName}" has ${n(d.windows)} overlapping timed windows on its track. Unity and Niagara each support one spawn window per emitter, so only the first would be imported.`,
    hint: () => 'Bursts (zero-length clips) export cleanly however many there are - it is overlapping timed windows that do not. Either split them across separate systems, or convert them to bursts.',
    fix: (d) => ({
      label: 'Split into separate systems',
      action: 'splitSchedule',
      args: { systemId: d.systemId },
    }),
  },
  W_ENGINE_UNSUPPORTED: {
    severity: SEVERITY.WARN,
    title: 'Block has no equivalent in the target engine',
    message: (d) => `${d.engineLabel} has no equivalent for "${d.blockLabel}". It will be dropped on import.`,
    hint: (d) => d.note || 'The effect will still work here, but it will look different in the engine.',
  },
  I_ENGINE_APPROX: {
    severity: SEVERITY.INFO,
    title: 'Block is approximated in the target engine',
    message: (d) => `"${d.blockLabel}" maps onto ${d.engineLabel} approximately.`,
    hint: (d) => d.note || 'It will behave similarly but not identically once imported.',
  },
  I_NO_UPDATE: {
    severity: SEVERITY.INFO,
    title: 'Particles do not move',
    message: (d) => `"${d.systemName}" has no Update stage, so particles stay where they are born and never change.`,
    hint: () => 'That is right for a static decal or a flash. Add an Update stage for motion, fading or growth.',
  },
  I_TRAIL_UNSUPPORTED: {
    severity: SEVERITY.INFO,
    title: 'Trails draw as billboards here',
    message: (d) => (
      `"${d.systemName}" is set to draw as a trail. The setting is carried into `
      + 'the export, but this preview draws billboards instead.'
    ),
    hint: () => 'A trail needs a per-particle position history and a rebuilt strip, which is a different renderer rather than a setting. For a ribbon that previews correctly, use Stretched with a high spawn rate - the Trail template does exactly that.',
    fix: (d) => ({
      label: 'Draw as Stretched',
      action: 'setContextParam',
      args: { contextId: d.contextId, param: 'mode', value: 'stretched' },
    }),
  },
  I_SOFT_UNSUPPORTED: {
    severity: SEVERITY.INFO,
    title: 'Soft particles are not previewed',
    message: () => 'Soft particle fading is carried into the export but is not shown in this preview.',
    hint: () => 'It needs a scene depth pass the preview does not yet run. Both Unity and Niagara support it, so the value is not lost.',
  },
});

/**
 * Every code, for the UI to enumerate and for a test to check coverage.
 * @type {ReadonlyArray<string>}
 */
export const DIAGNOSTIC_CODES = Object.freeze(Object.keys(DEFS));

/**
 * The definition behind a code.
 * @param {string} code
 * @returns {Object|null}
 */
export function diagnosticDef(code) {
  return DEFS[code] || null;
}

/**
 * @typedef {Object} VfxDiagnostic
 * @property {string} code
 * @property {'error'|'warn'|'info'} severity
 * @property {string} title short label for a collapsed strip row
 * @property {string} message what will happen, with the arithmetic
 * @property {string} hint why, and what to do about it
 * @property {Object} target ids so the UI can select and centre the culprit
 * @property {{label: string, action: string, args: Object}} [fix]
 */

/**
 * Collects diagnostics during a compile.
 *
 * Deliberately a sink rather than a returned array: the compiler raises
 * findings from nine different phases, and threading an accumulator through
 * them all was the alternative. It also de-duplicates, because the same
 * missing texture is reachable from both the asset pass and the output pass
 * and the author should see it once.
 *
 * @returns {{report: Function, list: Function, hasErrors: Function, count: Function}}
 */
export function createDiagnostics() {
  /** @type {VfxDiagnostic[]} */
  const items = [];
  const seen = new Set();

  /**
   * @param {string} code
   * @param {Object} target {systemId, contextId, blockId, nodeId, prop}
   * @param {Object} [data] facts the message and fix are built from
   */
  const report = (code, target = {}, data = {}) => {
    const def = DEFS[code];
    if (!def) throw new Error(`VFX diagnostics: unknown code ${code}`);

    // One row per (code, target). A duplicate is a bug in the compiler, not
    // something the author should have to read twice.
    const key = `${code}|${target.systemId || ''}|${target.contextId || ''}|${target.blockId || ''}|${target.nodeId || ''}|${target.prop || ''}`;
    if (seen.has(key)) return;
    seen.add(key);

    const facts = { ...target, ...data };
    items.push({
      code,
      severity: def.severity,
      title: def.title,
      message: def.message(facts),
      hint: def.hint ? def.hint(facts) : '',
      target: { ...target },
      ...(def.fix ? { fix: def.fix(facts) } : {}),
    });
  };

  return {
    report,
    /** Errors first, then warnings, then info - the order the strip shows. */
    list: () => {
      const rank = { [SEVERITY.ERROR]: 0, [SEVERITY.WARN]: 1, [SEVERITY.INFO]: 2 };
      return items.slice().sort((a, b) => rank[a.severity] - rank[b.severity]);
    },
    hasErrors: () => items.some((d) => d.severity === SEVERITY.ERROR),
    count: (severity) => (severity ? items.filter((d) => d.severity === severity).length : items.length),
  };
}

/**
 * The one-line summary the diagnostics strip shows when it is collapsed.
 *
 * When there is nothing wrong this does NOT go blank - it reports the cost
 * instead. A green line that says "1,400 particles, 1 draw call, Unity and
 * Unreal ready" is a running lesson in what those numbers mean, and it is the
 * only place a developer learns what a cheap effect looks like.
 *
 * @param {VfxDiagnostic[]} diagnostics
 * @param {{peakParticles?: number, drawCalls?: number, engines?: Object}} stats
 * @returns {{tone: string, text: string}}
 */
export function summarizeDiagnostics(diagnostics, stats = {}) {
  const errors = diagnostics.filter((d) => d.severity === SEVERITY.ERROR).length;
  const warnings = diagnostics.filter((d) => d.severity === SEVERITY.WARN).length;

  if (errors > 0) {
    return {
      tone: SEVERITY.ERROR,
      text: `${errors} problem${errors === 1 ? '' : 's'} stopping this effect from working`,
    };
  }
  if (warnings > 0) {
    return {
      tone: SEVERITY.WARN,
      text: `${warnings} thing${warnings === 1 ? '' : 's'} that will not do what you intended`,
    };
  }

  const parts = [];
  if (Number.isFinite(stats.peakParticles)) parts.push(`~${n(stats.peakParticles)} particles`);
  if (Number.isFinite(stats.drawCalls)) {
    parts.push(`${n(stats.drawCalls)} draw call${stats.drawCalls === 1 ? '' : 's'}`);
  }
  const ready = [];
  if (stats.engines?.unity === 'native') ready.push('Unity');
  if (stats.engines?.unreal === 'native') ready.push('Unreal');
  if (ready.length) parts.push(`${ready.join(' + ')} ready`);

  return {
    tone: 'ok',
    text: parts.length ? `No problems - ${parts.join(' - ')}` : 'No problems',
  };
}
