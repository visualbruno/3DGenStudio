// Every way the editor can change a VFX document, as pure functions.
//
// PURE, AND IMMUTABLE. Each function takes a document and returns a new one,
// cloning only the nodes along the path it touched. Two things depend on that:
//
//   - the undo history is snapshot-based (see useVfxHistory), so an edit that
//     mutated in place would corrupt every entry already on the stack;
//   - vfxSignature is the recompile trigger, and it only changes when the
//     document identity does.
//
// NO REACT AND NO THREE, so the whole edit surface is testable headlessly -
// which matters because these are the operations an author performs thousands
// of times and the ones whose bugs are hardest to see (a reorder that drops a
// block, a prop write that lands on the wrong instance).
//
// THE FIX APPLIERS AT THE BOTTOM ARE WHY THIS FILE HAS A REGISTRY. A compile
// diagnostic carries `{label, action, args}` rather than a function, because it
// has to survive JSON.stringify into an export bundle. This is the other half:
// the map from `action` to the transform that performs it. Every applier is one
// of the ordinary edits above, so clicking a fix produces exactly one undo
// entry, indistinguishable from doing it by hand.

import {
  CATALOG,
  defaultContextParams,
  defaultModes,
  defaultProps,
} from '../../../vfx/catalog.js'
import {
  CONTEXT_KIND,
  createClip,
  nextVfxId,
  normalizeVfxDoc,
} from '../../../vfx/doc.js'
import { GRADIENT_PRESETS } from '../../../vfx/gradient.js'
import { CURVE_PRESETS } from '../../../vfx/curve.js'
import {
  curveValue,
  gradientValue,
  normalizeValue,
  setValueMode,
} from '../../../vfx/value.js'
import { propChannels } from '../../../vfx/catalog.js'

// Rebuild a document with one system replaced, cloning only that branch.
//
// A TRANSFORM THAT RETURNS ITS INPUT COUNTS AS UNTOUCHED, and the whole
// document is then returned by identity. That is what lets a mutator REFUSE an
// edit - removeClip on a track's last clip, say - without costing the author an
// undo press that appears to do nothing, because useVfxHistory decides whether
// to push an entry by reference equality.
function withSystem(doc, systemId, transform) {
  let touched = false
  const systems = doc.systems.map(system => {
    if (system.id !== systemId) return system
    const next = transform(system)
    if (next === system) return system
    touched = true
    return next
  })
  if (!touched) return doc
  return normalizeVfxDoc({ ...doc, systems })
}

// Rebuild with one context replaced, found by id across every system.
function withContext(doc, contextId, transform) {
  let touched = false
  const systems = doc.systems.map(system => {
    if (!system.contexts.some(context => context.id === contextId)) return system
    const contexts = system.contexts.map(context => (
      context.id === contextId ? transform(context, system) : context
    ))
    // Same refusal contract as withSystem above.
    if (contexts.every((context, i) => context === system.contexts[i])) return system
    touched = true
    return { ...system, contexts }
  })
  if (!touched) return doc
  return normalizeVfxDoc({ ...doc, systems })
}

// Rebuild with the context that OWNS a block replaced.
function withBlockContext(doc, blockId, transform) {
  let touched = false
  const systems = doc.systems.map(system => {
    if (!system.contexts.some(c => c.blocks.some(b => b.id === blockId))) return system
    const contexts = system.contexts.map(context => (
      context.blocks.some(b => b.id === blockId) ? transform(context, system) : context
    ))
    if (contexts.every((context, i) => context === system.contexts[i])) return system
    touched = true
    return { ...system, contexts }
  })
  if (!touched) return doc
  return normalizeVfxDoc({ ...doc, systems })
}

/**
 * Locate a block and everything around it.
 * @returns {{system: Object, context: Object, block: Object, index: number}|null}
 */
export function findBlock(doc, blockId) {
  for (const system of doc.systems) {
    for (const context of system.contexts) {
      const index = context.blocks.findIndex(block => block.id === blockId)
      if (index >= 0) return { system, context, block: context.blocks[index], index }
    }
  }
  return null
}

/** Locate a context by id. */
export function findContext(doc, contextId) {
  for (const system of doc.systems) {
    const context = system.contexts.find(entry => entry.id === contextId)
    if (context) return { system, context }
  }
  return null
}

/**
 * Build a fresh block instance of a catalog type, at its defaults.
 *
 * At its DEFAULTS, not at zero: a block the author just added should already
 * be doing something sensible, so they can see what it does before they touch
 * a number.
 */
export function createBlock(blockType) {
  const def = CATALOG.block(blockType)
  if (!def) return null
  const block = {
    id: nextVfxId('blk'),
    type: blockType,
    enabled: true,
    props: defaultProps(def),
  }
  const modes = defaultModes(def)
  if (Object.keys(modes).length > 0) block.modes = modes
  return block
}

/**
 * Add a block to a context, by context id or by (system, kind).
 *
 * @param {Object} doc
 * @param {{systemId?: string, contextId?: string, contextKind?: string, blockType: string, index?: number}} spec
 */
export function addBlock(doc, spec) {
  const block = createBlock(spec.blockType)
  if (!block) return doc
  const def = CATALOG.block(spec.blockType)

  const insert = context => {
    // Refused rather than inserted: the catalog's `contexts` list is the rule,
    // and a block in a stage that cannot run it compiles to nothing - which
    // reads as the block being broken rather than misplaced. The palette only
    // offers legal blocks, so this is the guard behind the guard.
    if (!def.contexts.includes(context.kind)) return context
    const blocks = context.blocks.slice()
    const at = Number.isInteger(spec.index) ? Math.max(0, Math.min(blocks.length, spec.index)) : blocks.length
    blocks.splice(at, 0, block)
    return { ...context, blocks }
  }

  if (spec.contextId) return withContext(doc, spec.contextId, insert)

  // By kind, which is how a diagnostic's fix addresses it - a fix knows the
  // author needs a Spawn block, not which context id happens to hold spawns.
  const systemId = spec.systemId || doc.systems[0]?.id
  const kind = spec.contextKind
  if (!def.contexts.includes(kind)) return doc
  return withSystem(doc, systemId, system => {
    const target = system.contexts.find(context => context.kind === kind)
    if (!target) {
      // The stage does not exist yet. Creating it is the only way the fix can
      // work, and it is what the author wanted anyway.
      return {
        ...system,
        contexts: [...system.contexts, {
          id: nextVfxId('ctx'),
          kind,
          blocks: [block],
          params: {},
        }],
      }
    }
    return {
      ...system,
      contexts: system.contexts.map(context => (
        context.id === target.id ? insert(context) : context
      )),
    }
  })
}

/** Remove a block. */
export function removeBlock(doc, blockId) {
  return withBlockContext(doc, blockId, context => ({
    ...context,
    blocks: context.blocks.filter(block => block.id !== blockId),
  }))
}

/** Duplicate a block, inserted directly below the original. */
export function duplicateBlock(doc, blockId) {
  const found = findBlock(doc, blockId)
  if (!found) return doc
  const copy = {
    ...found.block,
    id: nextVfxId('blk'),
    props: JSON.parse(JSON.stringify(found.block.props)),
  }
  return withBlockContext(doc, blockId, context => {
    const blocks = context.blocks.slice()
    blocks.splice(found.index + 1, 0, copy)
    return { ...context, blocks }
  })
}

/**
 * Move a block within its stack, or to another context.
 *
 * ORDER IS SEMANTICS in a block stack - forces accumulate, setters overwrite -
 * so this is a real edit and not a cosmetic one. It gets its own undo entry.
 */
export function moveBlock(doc, blockId, spec = {}) {
  const found = findBlock(doc, blockId)
  if (!found) return doc

  // Within the same stack: splice out and back in.
  if (!spec.toContextId && !spec.toContextKind) {
    const toIndex = Number.isInteger(spec.toIndex) ? spec.toIndex : found.index
    if (toIndex === found.index) return doc
    return withBlockContext(doc, blockId, context => {
      const blocks = context.blocks.slice()
      const [moved] = blocks.splice(found.index, 1)
      blocks.splice(Math.max(0, Math.min(blocks.length, toIndex)), 0, moved)
      return { ...context, blocks }
    })
  }

  // Across contexts. Done as remove-then-add so both halves go through the
  // normal paths, including the create-the-stage branch above.
  //
  // The destination is checked FIRST, against the catalog, because the two
  // halves are not atomic: a move to a stage that cannot hold the block would
  // otherwise remove it and then fail to place it, and the block would be gone.
  const def = CATALOG.block(found.block.type)
  const destinationKind = spec.toContextKind
    || findContext(doc, spec.toContextId)?.context?.kind
  if (!def || !destinationKind || !def.contexts.includes(destinationKind)) return doc

  const without = removeBlock(doc, blockId)
  const target = spec.toContextId
    ? { contextId: spec.toContextId }
    : { systemId: found.system.id, contextKind: spec.toContextKind }

  let touched = false
  const systems = without.systems.map(system => {
    const context = spec.toContextId
      ? system.contexts.find(entry => entry.id === spec.toContextId)
      : (system.id === found.system.id
        ? system.contexts.find(entry => entry.kind === spec.toContextKind)
        : null)
    if (!context) return system
    touched = true
    return {
      ...system,
      contexts: system.contexts.map(entry => (
        entry.id === context.id
          ? { ...entry, blocks: [...entry.blocks, found.block] }
          : entry
      )),
    }
  })
  if (touched) return normalizeVfxDoc({ ...without, systems })
  // The destination stage does not exist; addBlock's create-the-stage path
  // handles it, but it makes a fresh block, so carry the props across.
  const added = addBlock(without, { ...target, blockType: found.block.type })
  const newBlock = findBlock(added, null)
  return newBlock ? added : setBlockPropsFromTemplate(added, target, found.block)
}

// Copy an existing block's props onto the most recently added block of the same
// type in the target context. Only reached by the cross-context move above,
// when the destination stage had to be created.
function setBlockPropsFromTemplate(doc, target, template) {
  const contexts = []
  for (const system of doc.systems) {
    for (const context of system.contexts) {
      if (target.contextId ? context.id === target.contextId : context.kind === target.contextKind) {
        contexts.push(context)
      }
    }
  }
  const last = contexts.flatMap(context => context.blocks).filter(block => block.type === template.type).pop()
  if (!last) return doc
  return withBlockContext(doc, last.id, context => ({
    ...context,
    blocks: context.blocks.map(block => (
      block.id === last.id
        ? { ...block, props: JSON.parse(JSON.stringify(template.props)), modes: template.modes }
        : block
    )),
  }))
}

/**
 * Switch a block on or off.
 *
 * A soft mute: the block keeps its id and its props, and only the compile
 * skips it. That is what lets the author flip something off to see what it was
 * doing without losing their settings - and it is why the undo history and the
 * inspector selection can keep referring to it.
 */
export function toggleBlock(doc, blockId, enabled) {
  return withBlockContext(doc, blockId, context => ({
    ...context,
    blocks: context.blocks.map(block => (
      block.id === blockId
        ? { ...block, enabled: enabled === undefined ? block.enabled === false : Boolean(enabled) }
        : block
    )),
  }))
}

/** Write one property on one block. */
export function setBlockProp(doc, blockId, prop, value) {
  const found = findBlock(doc, blockId)
  if (!found) return doc
  const def = CATALOG.block(found.block.type)
  const channels = def?.props?.[prop] ? propChannels(def.props[prop].type) : undefined

  return withBlockContext(doc, blockId, context => ({
    ...context,
    blocks: context.blocks.map(block => (
      block.id === blockId
        ? { ...block, props: { ...block.props, [prop]: normalizeValue(value, { channels }) } }
        : block
    )),
  }))
}

/**
 * Switch a property between constant / random / curve / gradient.
 *
 * Goes through setValueMode so the outgoing payload is stashed and switching
 * back is lossless - the single detail that makes a mode switcher something an
 * author will use rather than undo out of. The catalog's min/max are passed
 * along so a derived random range cannot offer a negative lifetime.
 */
export function setBlockPropMode(doc, blockId, prop, mode) {
  const found = findBlock(doc, blockId)
  if (!found) return doc
  const def = CATALOG.block(found.block.type)
  const propDef = def?.props?.[prop]
  const channels = propDef ? propChannels(propDef.type) : undefined
  const range = propDef ? { min: propDef.min, max: propDef.max } : undefined
  // Which axis a curve runs along is the property's own meaning, not a choice -
  // so it comes from the catalog rather than from the author.
  const domain = propDef?.domain

  return withBlockContext(doc, blockId, context => ({
    ...context,
    blocks: context.blocks.map(block => (
      block.id === blockId
        ? {
          ...block,
          props: {
            ...block.props,
            [prop]: setValueMode(block.props[prop], mode, { channels, range, domain }),
          },
        }
        : block
    )),
  }))
}

/** Set a curve preset on a property. */
export function setCurvePreset(doc, blockId, prop, presetId) {
  const preset = CURVE_PRESETS.find(entry => entry.id === presetId)
  if (!preset) return doc
  const found = findBlock(doc, blockId)
  const current = found?.block?.props?.[prop]
  // The existing scale is kept: a preset changes the SHAPE, and the author's
  // magnitude is a separate decision they have already made.
  const scale = current?.mode === 'curve' && Number.isFinite(current.scale) ? current.scale : 1
  // And so is the domain - picking a new shape must not silently turn a curve
  // over effect time into one over particle life.
  const domain = CATALOG.block(found?.block?.type)?.props?.[prop]?.domain || current?.domain
  return setBlockProp(doc, blockId, prop, curveValue(preset.build(), { scale, domain }))
}

/** Set a gradient preset on a property. */
export function setGradientPreset(doc, blockId, prop, presetId) {
  const preset = GRADIENT_PRESETS.find(entry => entry.id === presetId)
  if (!preset) return doc
  const found = findBlock(doc, blockId)
  const domain = CATALOG.block(found?.block?.type)?.props?.[prop]?.domain
    || found?.block?.props?.[prop]?.domain
  return setBlockProp(doc, blockId, prop, gradientValue(preset.build(), { domain }))
}

/** Assign an asset slot to a texture or mesh property. */
export function setBlockAssetSlot(doc, blockId, prop, slot) {
  return setBlockProp(doc, blockId, prop, String(slot || ''))
}

/** Register (or replace) an asset reference slot. */
export function setAssetReference(doc, slot, entry) {
  return normalizeVfxDoc({
    ...doc,
    references: { ...doc.references, [slot]: entry },
  })
}

/**
 * Point a system's Output at an image asset, creating what it needs.
 *
 * THE "AND NOW WIRE IT UP" STEP, and it is three things rather than one: the
 * Output needs a Sprite Texture block, the block needs a slot key, and the slot
 * needs an entry in `references`. Doing them by hand is how a generated sprite
 * ends up sitting in the library while the effect still draws the built-in blob.
 *
 * The slot key is derived from the BLOCK, not from the asset, so re-pointing the
 * same block replaces the reference rather than accumulating slots - the same
 * rule the asset picker follows.
 *
 * @param {Object} doc
 * @param {string} systemId
 * @param {{assetId: number, name?: string, kind?: string}} asset
 * @returns {Object}
 */
export function setSystemTexture(doc, systemId, asset) {
  const id = Number(asset?.assetId)
  if (!Number.isFinite(id)) return doc
  const system = doc.systems.find(entry => entry.id === systemId)
  const output = system?.contexts.find(context => context.kind === CONTEXT_KIND.OUTPUT)
  if (!output) return doc

  let next = doc
  let block = output.blocks.find(entry => entry.type === 'output.setMainTexture')
  if (!block) {
    next = addBlock(next, { contextId: output.id, blockType: 'output.setMainTexture' })
    block = next.systems.find(entry => entry.id === systemId).contexts
      .find(context => context.id === output.id).blocks
      .filter(entry => entry.type === 'output.setMainTexture').pop()
  }
  if (!block) return doc

  const slot = `tex_${block.id}_texture`
  next = setAssetReference(next, slot, {
    kind: asset.kind || 'image',
    ref: `asset:${id}`,
    name: asset.name || '',
    colorSpace: 'srgb',
  })
  return setBlockAssetSlot(next, block.id, 'texture', slot)
}

/**
 * Drop a property the catalog does not define.
 *
 * THE ONE MUTATOR THAT DELETES A PROP RATHER THAN SETTING ONE, and it exists
 * only for W_UNKNOWN_PROP: a document written by hand or by an agent can carry
 * `from`/`to` on a block whose properties are `start`/`end`, where they survive
 * every save, do nothing, and are invisible in the inspector because the
 * inspector renders the CATALOG's list.
 *
 * It refuses to remove a property the block really has - that would be a
 * different operation with a different name, and a fix button that could delete
 * a real value by mistyping is worse than no button.
 */
export function removeBlockProp(doc, blockId, prop) {
  const found = findBlock(doc, blockId)
  if (!found) return doc
  if (!(prop in (found.block.props || {}))) return doc
  // Refuses to remove a REAL property, so a mistyped fix cannot delete a value
  // the author set. Only the unknown ones.
  if (CATALOG.block(found.block.type)?.props?.[prop]) return doc

  return withBlockContext(doc, blockId, context => ({
    ...context,
    blocks: context.blocks.map(block => {
      if (block.id !== blockId) return block
      const props = { ...block.props }
      delete props[prop]
      return { ...block, props }
    }),
  }))
}

export function setBlockMode(doc, blockId, mode, value) {
  return withBlockContext(doc, blockId, context => ({
    ...context,
    blocks: context.blocks.map(block => (
      block.id === blockId
        ? { ...block, modes: { ...(block.modes || {}), [mode]: String(value) } }
        : block
    )),
  }))
}

/** Set a context parameter (an Output's blend mode, an Update's integrator). */
export function setContextParam(doc, contextId, param, value) {
  return withContext(doc, contextId, context => ({
    ...context,
    params: { ...context.params, [param]: value },
  }))
}

/** Add a stage to a system. */
export function addContext(doc, systemId, kind) {
  if (!Object.values(CONTEXT_KIND).includes(kind)) return doc
  return withSystem(doc, systemId, system => {
    // ONE OF EACH STAGE, except Output. A second Spawn or Update context is
    // E_DUPLICATE_CONTEXT - the compiler reports it and lowers only one - so
    // letting the UI create one would be offering an action whose only effect
    // is an error. Outputs are the exception because an effect legitimately
    // draws its particles more than once: a core and a glow, additive and
    // alpha, from one simulation.
    if (kind !== CONTEXT_KIND.OUTPUT && system.contexts.some(c => c.kind === kind)) {
      return system
    }
    return {
      ...system,
      contexts: [
        ...system.contexts,
        { id: nextVfxId('ctx'), kind, blocks: [], params: defaultContextParams(kind) },
      ],
    }
  })
}

/** Remove a stage, and everything in it. */
export function removeContext(doc, contextId) {
  const systems = doc.systems.map(system => ({
    ...system,
    contexts: system.contexts.filter(context => context.id !== contextId),
  }))
  return normalizeVfxDoc({ ...doc, systems })
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

/**
 * Add a system, pre-wired with the four stages.
 *
 * Never an empty shell: a system with no stages has no affordance and produces
 * two error diagnostics the moment it exists, which reads as the tool being
 * broken rather than as the author having more to do.
 */
export function addSystem(doc, spec = {}) {
  // A SKELETON THAT ALREADY WORKS, not four empty stages.
  //
  // An empty system compiles to "nothing is emitted", "no lifetime" and
  // "nothing is drawn", so the old version handed the author three errors in
  // exchange for one click - and the fix for all three was to guess at blocks
  // they had not learned about yet. These five are the minimum that emits
  // visible particles with zero diagnostics, which is the same standard the
  // plan sets for "Start blank".
  const stage = (kind, blockTypes, params = {}) => ({
    id: nextVfxId('ctx'),
    kind,
    blocks: blockTypes.map(createBlock).filter(Boolean),
    params,
  })

  const system = {
    id: nextVfxId('sys'),
    name: spec.name || `System ${doc.systems.length + 1}`,
    enabled: true,
    capacity: spec.capacity || 512,
    simulationSpace: 'inherit',
    contexts: spec.blank
      ? [
        stage(CONTEXT_KIND.SPAWN, []),
        stage(CONTEXT_KIND.INITIALIZE, []),
        stage(CONTEXT_KIND.UPDATE, []),
        stage(CONTEXT_KIND.OUTPUT, []),
      ]
      : [
        stage(CONTEXT_KIND.SPAWN, ['spawn.rate']),
        stage(CONTEXT_KIND.INITIALIZE, [
          'initialize.setLifetime',
          'initialize.setSize',
          'initialize.setColor',
        ]),
        stage(CONTEXT_KIND.UPDATE, ['update.sizeOverLife']),
        stage(CONTEXT_KIND.OUTPUT, ['output.setMainTexture']),
      ],
  }
  return normalizeVfxDoc({ ...doc, systems: [...doc.systems, system] })
}

/**
 * Remove a system.
 *
 * The last one cannot be removed. An effect with no systems draws nothing and
 * offers nothing to add a block to, so the author would be left with an empty
 * board and no route back except undo - and if they saved in between, not even
 * that. Deleting the effect is an Assets-page action, not an editor one.
 */
export function removeSystem(doc, systemId) {
  if (doc.systems.length <= 1) return doc
  if (!doc.systems.some(system => system.id === systemId)) return doc
  return normalizeVfxDoc({
    ...doc,
    systems: doc.systems.filter(system => system.id !== systemId),
  })
}

/** Duplicate a system, ids and all regenerated. */
export function duplicateSystem(doc, systemId) {
  const source = doc.systems.find(system => system.id === systemId)
  if (!source) return doc
  const copy = JSON.parse(JSON.stringify(source))
  copy.id = nextVfxId('sys')
  copy.name = `${source.name} copy`
  // A fresh seed offset, or the copy draws the same randoms as the original and
  // the two overlap exactly - which looks like the duplicate did nothing.
  copy.seedOffset = (source.seedOffset + 0x9e37) >>> 0
  for (const context of copy.contexts) {
    context.id = nextVfxId('ctx')
    for (const block of context.blocks) block.id = nextVfxId('blk')
  }
  if (copy.schedule?.clips) {
    for (const clip of copy.schedule.clips) clip.id = nextVfxId('clip')
  }
  return normalizeVfxDoc({ ...doc, systems: [...doc.systems, copy] })
}

/** Patch a system's own fields (name, capacity, enabled, space). */
export function updateSystem(doc, systemId, patch) {
  return withSystem(doc, systemId, system => ({ ...system, ...patch }))
}

/** Move a system in the track order. */
export function moveSystem(doc, systemId, toIndex) {
  const from = doc.systems.findIndex(system => system.id === systemId)
  if (from < 0) return doc
  const systems = doc.systems.slice()
  const [moved] = systems.splice(from, 1)
  systems.splice(Math.max(0, Math.min(systems.length, toIndex)), 0, moved)
  return normalizeVfxDoc({ ...doc, systems })
}

// ---------------------------------------------------------------------------
// Timeline clips
// ---------------------------------------------------------------------------

/** Add a clip to a system's track. */
export function addClip(doc, systemId, spec = {}) {
  return withSystem(doc, systemId, system => ({
    ...system,
    schedule: { clips: [...system.schedule.clips, createClip(spec)] },
  }))
}

/** Patch one clip. */
export function updateClip(doc, systemId, clipId, patch) {
  return withSystem(doc, systemId, system => ({
    ...system,
    schedule: {
      clips: system.schedule.clips.map(clip => (
        clip.id === clipId ? createClip({ ...clip, ...patch }) : clip
      )),
    },
  }))
}

/**
 * Remove a clip.
 *
 * The last clip cannot be removed: a track with none would never emit, and the
 * author would be looking at a system that silently does nothing with no
 * indication why. Clearing the track means deleting the system.
 */
export function removeClip(doc, systemId, clipId) {
  return withSystem(doc, systemId, system => {
    if (system.schedule.clips.length <= 1) return system
    return {
      ...system,
      schedule: { clips: system.schedule.clips.filter(clip => clip.id !== clipId) },
    }
  })
}

/** Patch the effect-wide settings. */
export function setEffectSettings(doc, patch) {
  return normalizeVfxDoc({ ...doc, effect: { ...doc.effect, ...patch } })
}

/** Remove an operator node, and any wiring into it. */
export function removeOperator(doc, nodeId) {
  return normalizeVfxDoc({
    ...doc,
    operators: doc.operators.filter(node => node.id !== nodeId),
    edges: doc.edges.filter(edge => edge.from.nodeId !== nodeId && edge.to.nodeId !== nodeId),
  })
}

/** Add an operator node. */
export function addOperator(doc, type, position = null) {
  const def = CATALOG.operator(type)
  if (!def) return doc
  const node = {
    id: nextVfxId('op'),
    type,
    props: defaultProps(def),
    modes: defaultModes(def),
  }
  const next = { ...doc, operators: [...doc.operators, node] }
  if (position) {
    next.layout = {
      ...doc.layout,
      nodes: { ...(doc.layout?.nodes || {}), [node.id]: position },
    }
  }
  return normalizeVfxDoc(next)
}

/** Write one property on an operator node. */
export function setOperatorProp(doc, nodeId, prop, value) {
  const node = doc.operators.find(entry => entry.id === nodeId)
  if (!node) return doc
  const def = CATALOG.operator(node.type)
  const channels = def?.props?.[prop] ? propChannels(def.props[prop].type) : undefined
  return normalizeVfxDoc({
    ...doc,
    operators: doc.operators.map(entry => (
      entry.id === nodeId
        ? { ...entry, props: { ...entry.props, [prop]: normalizeValue(value, { channels }) } }
        : entry
    )),
  })
}

/** Set one of an operator's discrete mode switches. */
export function setOperatorMode(doc, nodeId, mode, value) {
  return normalizeVfxDoc({
    ...doc,
    operators: doc.operators.map(entry => (
      entry.id === nodeId
        ? { ...entry, modes: { ...(entry.modes || {}), [mode]: String(value) } }
        : entry
    )),
  })
}

/**
 * Wire an operator output into a block property.
 *
 * A SECOND WIRE INTO THE SAME PROPERTY REPLACES THE FIRST rather than being
 * refused. A property can only have one source, so refusing the drop would
 * leave the author to work out that they must delete the old wire first - and
 * "replace" is what they meant by dropping a second one there.
 *
 * The property's `mode` is NOT set here. normalizeVfxDoc derives the link
 * mirror from `edges` on every pass, so writing it by hand is the one way the
 * two could disagree (invariant 1 in vfx/doc.js).
 */
export function addEdge(doc, spec) {
  const { fromNodeId, blockId, prop, port = 'out', component = null } = spec || {}
  if (!fromNodeId || !blockId || !prop) return doc
  const to = { blockId, prop }
  if (Number.isInteger(component)) to.component = component

  const kept = doc.edges.filter(edge => !(
    edge.to.blockId === blockId
    && edge.to.prop === prop
    && edge.to.component === to.component
  ))

  return normalizeVfxDoc({
    ...doc,
    edges: [...kept, { id: nextVfxId('edge'), from: { nodeId: fromNodeId, port }, to }],
  })
}

/**
 * Remove one wire.
 *
 * The property keeps the last literal the link carried - every VfxValue mode
 * holds a usable `v` for exactly this case - so unwiring degrades to a constant
 * at the value the author was seeing rather than to zero.
 */
export function removeEdge(doc, edgeId) {
  if (!doc.edges.some(edge => edge.id === edgeId)) return doc
  return normalizeVfxDoc({ ...doc, edges: doc.edges.filter(edge => edge.id !== edgeId) })
}

/** Remove the wire feeding one property, by its destination rather than its id. */
export function unwireProp(doc, blockId, prop) {
  const kept = doc.edges.filter(edge => !(edge.to.blockId === blockId && edge.to.prop === prop))
  if (kept.length === doc.edges.length) return doc
  return normalizeVfxDoc({ ...doc, edges: kept })
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
//
// Comment groups, in the plan's language. They live in `doc.layout`, which
// vfxSignature excludes - so writing, moving or resizing a note cannot
// recompile the effect. That is not an optimisation: a note at the top level
// would be part of the document's identity, and typing in one would rebuild the
// runtime on every keystroke.

/** Add a note at a board position. */
export function addNote(doc, spec = {}) {
  const note = {
    id: nextVfxId('note'),
    text: typeof spec.text === 'string' ? spec.text : '',
    x: Number.isFinite(spec.x) ? Math.round(spec.x) : 0,
    y: Number.isFinite(spec.y) ? Math.round(spec.y) : 0,
    width: Number.isFinite(spec.width) ? Math.max(120, spec.width) : 240,
    height: Number.isFinite(spec.height) ? Math.max(60, spec.height) : 120,
    accent: Number.isInteger(spec.accent) ? spec.accent : 0,
  }
  return {
    ...doc,
    layout: { ...doc.layout, notes: [...(doc.layout?.notes || []), note] },
  }
}

/** Patch a note's text, position, size or accent. */
export function updateNote(doc, noteId, patch) {
  const notes = doc.layout?.notes || []
  if (!notes.some(note => note.id === noteId)) return doc
  return {
    ...doc,
    layout: {
      ...doc.layout,
      notes: notes.map(note => (note.id === noteId ? { ...note, ...patch } : note)),
    },
  }
}

/** Remove a note. */
export function removeNote(doc, noteId) {
  const notes = doc.layout?.notes || []
  if (!notes.some(note => note.id === noteId)) return doc
  return {
    ...doc,
    layout: { ...doc.layout, notes: notes.filter(note => note.id !== noteId) },
  }
}

// ---------------------------------------------------------------------------
// Diagnostic fix appliers
// ---------------------------------------------------------------------------

/**
 * The other half of a diagnostic's `fix` descriptor.
 *
 * Diagnostics carry `{label, action, args}` rather than a closure, because they
 * have to survive JSON.stringify into an export bundle. This maps `action` to a
 * transform, so clicking a fix is one ordinary undo entry - the author can undo
 * it exactly like anything they did by hand.
 *
 * Two actions are deliberately absent, and the UI handles them itself:
 * `pickAsset` needs a modal, and `splitSchedule` needs the author to choose how
 * to split. An applier that guessed at either would be worse than a button that
 * opens the right surface.
 */
/**
 * Configure a system's sprite sheet in one move.
 *
 * A SHEET IS THREE BLOCKS IN TWO STAGES, and that is the whole reason this
 * exists. `output.setFlipbook` says how the atlas is cut, `update.flipbook`
 * steps through it, and the two live in DIFFERENT contexts - so the natural way
 * to set one up is to add the Output block, see nothing happen, and conclude
 * the texture is simply cropped. That is the hardest flipbook mistake to
 * diagnose from the viewport, and the compiler has a warning for it precisely
 * because it kept happening.
 *
 * Setting them together also makes W_FLIPBOOK_FRAME_COUNT unreachable from the
 * UI: the frame count is DERIVED from the grid rather than typed, so the player
 * and the sheet cannot disagree.
 *
 * `columns * rows <= 1` REMOVES both, which is the honest inverse - a one-tile
 * sheet is not a sheet, and leaving a 1x1 flipbook block behind would keep the
 * shader's USE_FLIPBOOK define and its uniform for no reason.
 *
 * @param {Object} doc
 * @param {string} systemId
 * @param {{columns?: number, rows?: number, fps?: number}} spec
 * @returns {Object}
 */
export function setSpriteSheet(doc, systemId, spec = {}) {
  const system = doc.systems.find(entry => entry.id === systemId)
  if (!system) return doc

  const whole = (value, fallback) => {
    const n = Math.round(Number(value))
    return Number.isFinite(n) && n >= 1 ? n : fallback
  }
  const columns = whole(spec.columns, 1)
  const rows = whole(spec.rows, 1)
  const fps = Number.isFinite(Number(spec.fps)) && Number(spec.fps) > 0 ? Number(spec.fps) : 24
  const tiles = columns * rows

  const output = system.contexts.find(context => context.kind === CONTEXT_KIND.OUTPUT)
  if (!output) return doc

  const sheetBlock = output.blocks.find(block => block.type === 'output.setFlipbook')
  const findPlayer = (d) => {
    const sys = d.systems.find(entry => entry.id === systemId)
    for (const context of sys?.contexts || []) {
      const block = context.blocks.find(entry => entry.type === 'update.flipbook')
      if (block) return block
    }
    return null
  }

  let next = doc

  if (tiles <= 1) {
    if (sheetBlock) next = removeBlock(next, sheetBlock.id)
    const player = findPlayer(next)
    if (player) next = removeBlock(next, player.id)
    return next
  }

  if (sheetBlock) {
    next = setBlockProp(next, sheetBlock.id, 'columns', columns)
    next = setBlockProp(next, sheetBlock.id, 'rows', rows)
  } else {
    next = addBlock(next, { contextId: output.id, blockType: 'output.setFlipbook' })
    const added = next.systems.find(entry => entry.id === systemId).contexts
      .find(context => context.id === output.id).blocks
      .filter(block => block.type === 'output.setFlipbook').pop()
    if (added) {
      next = setBlockProp(next, added.id, 'columns', columns)
      next = setBlockProp(next, added.id, 'rows', rows)
    }
  }

  // THE UPDATE STAGE MAY NOT EXIST. A system without one is legal - the
  // compiler only reports it as an info - but a sheet cannot play without
  // somewhere to put the player, so it is created rather than silently skipped.
  let updateContext = next.systems.find(entry => entry.id === systemId).contexts
    .find(context => context.kind === CONTEXT_KIND.UPDATE)
  if (!updateContext) {
    next = addContext(next, systemId, CONTEXT_KIND.UPDATE)
    updateContext = next.systems.find(entry => entry.id === systemId).contexts
      .find(context => context.kind === CONTEXT_KIND.UPDATE)
  }
  if (!updateContext) return next

  let player = findPlayer(next)
  if (!player) {
    next = addBlock(next, { contextId: updateContext.id, blockType: 'update.flipbook' })
    player = findPlayer(next)
  }
  if (player) {
    // DERIVED, never typed: this is what keeps the player and the sheet in step.
    next = setBlockProp(next, player.id, 'frames', tiles)
    next = setBlockProp(next, player.id, 'rate', fps)
  }
  return next
}

/**
 * The sheet a system is currently configured for.
 *
 * Read back by the inspector so the control shows what is really set rather
 * than what was last typed into it.
 *
 * @param {Object} doc
 * @param {string} systemId
 * @returns {{columns: number, rows: number, fps: number, playing: boolean}}
 */
export function readSpriteSheet(doc, systemId) {
  const system = doc.systems.find(entry => entry.id === systemId)
  const literal = (block, prop, fallback) => {
    const value = block?.props?.[prop]?.v
    return Number.isFinite(value) ? value : fallback
  }
  let sheet = null
  let player = null
  for (const context of system?.contexts || []) {
    for (const block of context.blocks) {
      if (block.type === 'output.setFlipbook') sheet = block
      if (block.type === 'update.flipbook') player = block
    }
  }
  return {
    columns: literal(sheet, 'columns', 1),
    rows: literal(sheet, 'rows', 1),
    fps: literal(player, 'rate', 24),
    playing: Boolean(player),
  }
}

const FIX_APPLIERS = {
  addBlock: (doc, args) => addBlock(doc, args),
  addContext: (doc, args) => addContext(doc, args.systemId, args.contextKind),
  moveBlock: (doc, args) => moveBlock(doc, args.blockId, { toContextKind: args.toContextKind }),
  removeBlock: (doc, args) => removeBlock(doc, args.blockId),
  removeOperator: (doc, args) => removeOperator(doc, args.nodeId),
  setSystemCapacity: (doc, args) => updateSystem(doc, args.systemId, { capacity: args.capacity }),
  setProp: (doc, args) => setBlockProp(doc, args.blockId, args.prop, args.value),
  setGradientPreset: (doc, args) => setGradientPreset(doc, args.blockId, args.prop, args.preset),
  setContextParam: (doc, args) => setContextParam(doc, args.contextId, args.param, args.value),
  setBlockMode: (doc, args) => setBlockMode(doc, args.blockId, args.mode, args.value),
  removeProp: (doc, args) => removeBlockProp(doc, args.blockId, args.prop),
}

// FIXES THAT NEED THE AUTHOR TO CHOOSE SOMETHING, and therefore cannot be a
// pure doc -> doc applier. They are dispatched by the page to the asset picker.
//
// THE BUG THIS EXISTS FOR: `pickAsset` was a fix action with no applier, and
// every surface decided whether to render a fix button by asking
// canApplyFix - so "Choose a sprite..." and "Pick a replacement..." were
// permanently greyed out. Two diagnostics offered a one-click fix that could
// never be clicked. Keeping canApplyFix honest (it means what its name says)
// and adding a second question is what fixes that without making applyFix
// return an unchanged document and burn an undo entry.
const UI_FIX_ACTIONS = new Set(['pickAsset'])

/** Whether a diagnostic's fix can be applied without further input. */
export function canApplyFix(fix) {
  return Boolean(fix && FIX_APPLIERS[fix.action])
}

/** Whether a fix has to go through a chooser rather than straight to the doc. */
export function fixNeedsInput(fix) {
  return Boolean(fix && UI_FIX_ACTIONS.has(fix.action))
}

/**
 * Whether a fix leads anywhere at all - the question the UI actually wants
 * before it draws a button.
 */
export function canOfferFix(fix) {
  return canApplyFix(fix) || fixNeedsInput(fix)
}

/**
 * Apply a diagnostic's fix.
 * @returns {Object} the new document, or the original when the action needs UI
 */
export function applyFix(doc, fix) {
  const applier = fix && FIX_APPLIERS[fix.action]
  if (!applier) return doc
  return applier(doc, fix.args || {})
}
