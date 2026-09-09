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
    hint: () => 'It was probably saved by a newer version of the app. Updating should restore it; removing the block will let the rest of the effect run.',
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
    fix: (d) => ({
      label: 'Choose a sprite...',
      action: 'pickAsset',
      args: { blockId: d.blockId, prop: 'texture', assetType: 'image' },
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
