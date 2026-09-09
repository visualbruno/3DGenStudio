// The VFX document as React Flow nodes and edges.
//
// A pure adapter, in the same spirit as toFlowEdge / toBaseFlowNode in
// src/utils/graphHelpers.js - all of the board's logic lives in the page and
// the node components are presentational.
//
// POSITIONS ARE DERIVED, NOT STORED, until the author moves something. A
// system is a vertical chain (Spawn -> Initialize -> Update -> Output) and
// systems sit side by side, so a tidy default layout is a function of two
// indices. Storing every position from the start would mean a freshly opened
// template carried coordinates that some later change to node sizing made
// wrong; deriving means the default is always tidy and only deliberate moves
// are remembered. Overrides go in doc.layout.nodes, which the compiler never
// reads (invariant 2 in vfx/doc.js), so dragging a node cannot recompile the
// effect.
//
// WHY NOT computeReorganizedLayout from graphHelpers: that lays a DAG out
// left-to-right by dependency depth, which is right for the asset graph. A VFX
// system is a fixed five-stage chain, so its layout is known without solving
// anything.

import { CATALOG, CONTEXT_DEFS } from '../../../vfx/catalog.js'
import { CONTEXT_KIND } from '../../../vfx/doc.js'

// Stage order within a system's column. Contexts are laid out in this order
// regardless of their order in the array, so a document that lists Output
// before Update still draws as a sensible chain.
const STAGE_ORDER = [
  CONTEXT_KIND.EVENT,
  CONTEXT_KIND.SPAWN,
  CONTEXT_KIND.INITIALIZE,
  CONTEXT_KIND.UPDATE,
  CONTEXT_KIND.OUTPUT,
]

const COLUMN_WIDTH = 320
const ROW_HEIGHT = 210
const OPERATOR_COLUMN_GAP = 120

function stageIndex(kind) {
  const at = STAGE_ORDER.indexOf(kind)
  return at < 0 ? STAGE_ORDER.length : at
}

/**
 * The tidy default position for a context node.
 *
 * Outputs stack below one another rather than sharing a row, because a system
 * may have several and overlapping them would hide all but the last.
 */
function defaultContextPosition(systemIndex, kind, outputOrdinal) {
  const row = stageIndex(kind) + (kind === CONTEXT_KIND.OUTPUT ? outputOrdinal : 0)
  return { x: systemIndex * COLUMN_WIDTH, y: row * ROW_HEIGHT }
}

function positionFor(doc, nodeId, fallback) {
  const stored = doc.layout?.nodes?.[nodeId]
  if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
    return { x: stored.x, y: stored.y }
  }
  return fallback
}

/**
 * Group diagnostics by the id they point at, so a node can show its own.
 *
 * @param {Array<Object>} diagnostics
 * @returns {Map<string, Array<Object>>}
 */
export function indexDiagnostics(diagnostics) {
  const byTarget = new Map()
  const add = (id, diagnostic) => {
    if (!id) return
    const list = byTarget.get(id)
    if (list) list.push(diagnostic)
    else byTarget.set(id, [diagnostic])
  }
  for (const diagnostic of diagnostics || []) {
    add(diagnostic.target?.blockId, diagnostic)
    add(diagnostic.target?.contextId, diagnostic)
    add(diagnostic.target?.systemId, diagnostic)
    add(diagnostic.target?.nodeId, diagnostic)
  }
  return byTarget
}

/**
 * Build the node list.
 *
 * @param {Object} doc
 * @param {Object} [options]
 * @param {Map<string, Array<Object>>} [options.diagnostics] from indexDiagnostics
 * @param {string|null} [options.selectedBlockId]
 * @param {string|null} [options.engineTarget]
 * @param {string} [options.level] 'guided' | 'standard' | 'full'
 * @returns {Array<Object>} React Flow nodes
 */
export function toFlowNodes(doc, options = {}) {
  const diagnostics = options.diagnostics || new Map()
  const nodes = []
  const wiredByContext = wiredPropsByContext(doc)

  doc.systems.forEach((system, systemIndex) => {
    let outputOrdinal = 0
    // Sorted for layout only; the document's own order is untouched.
    const ordered = system.contexts.slice().sort((a, b) => stageIndex(a.kind) - stageIndex(b.kind))

    for (const context of ordered) {
      const ordinal = context.kind === CONTEXT_KIND.OUTPUT ? outputOrdinal++ : 0
      const def = CONTEXT_DEFS[context.kind] || {}

      const blocks = context.blocks.map(block => ({
        block,
        def: CATALOG.block(block.type),
        diagnostics: diagnostics.get(block.id) || [],
      }))

      nodes.push({
        id: context.id,
        type: 'vfxContext',
        position: positionFor(
          doc,
          context.id,
          defaultContextPosition(systemIndex, context.kind, ordinal),
        ),
        // The body of a context node is a list of interactive rows, so the
        // whole card must not be a drag surface - React Flow would steal every
        // pointer down. Only the header drags.
        dragHandle: '.vfx-node__drag-handle',
        selected: options.selectedContextId === context.id,
        data: {
          context,
          system,
          def,
          blocks,
          diagnostics: diagnostics.get(context.id) || [],
          // Which of this context's block properties currently have an edge.
          // Computed here rather than in the node so a node does not have to
          // scan doc.edges on every render, and so the handle set is part of
          // the node's data - which is what useUpdateNodeInternals keys on.
          wiredProps: wiredByContext.get(context.id) || EMPTY_WIRED,
          selectedBlockId: options.selectedBlockId || null,
          engineTarget: options.engineTarget || null,
          level: options.level || 'standard',
          systemIndex,
        },
      })
    }
  })

  const operatorColumn = doc.systems.length * COLUMN_WIDTH + OPERATOR_COLUMN_GAP
  doc.operators.forEach((operator, index) => {
    nodes.push({
      id: operator.id,
      type: 'vfxOperator',
      position: positionFor(doc, operator.id, { x: operatorColumn, y: index * 140 }),
      dragHandle: '.vfx-node__drag-handle',
      data: {
        operator,
        def: CATALOG.operator(operator.type),
        diagnostics: diagnostics.get(operator.id) || [],
      },
    })
  })

  return nodes
}

/**
 * Build the edge list.
 *
 * FLOW EDGES ARE DERIVED FROM THE STAGE CHAIN, not from doc.edges. Within a
 * system the contexts ARE the chain - the document has no separate flow wiring
 * - which means an illegal ordering cannot be represented, let alone drawn.
 * doc.edges carries only the thin data wires from operators into block
 * properties.
 */
export function toFlowEdges(doc) {
  const edges = []

  for (const system of doc.systems) {
    const ordered = system.contexts.slice().sort((a, b) => stageIndex(a.kind) - stageIndex(b.kind))
    const outputs = ordered.filter(context => context.kind === CONTEXT_KIND.OUTPUT)
    const chain = ordered.filter(context => context.kind !== CONTEXT_KIND.OUTPUT)

    for (let i = 0; i < chain.length - 1; i += 1) {
      edges.push({
        id: `flow:${chain[i].id}:${chain[i + 1].id}`,
        source: chain[i].id,
        target: chain[i + 1].id,
        sourceHandle: 'flow-out',
        targetHandle: 'flow-in',
        type: 'vfxFlow',
        data: { systemId: system.id },
      })
    }

    // Every output hangs off the last simulation stage, so an effect with two
    // outputs shows both fed by the same particles - which is what happens.
    const last = chain[chain.length - 1]
    if (last) {
      for (const output of outputs) {
        edges.push({
          id: `flow:${last.id}:${output.id}`,
          source: last.id,
          target: output.id,
          sourceHandle: 'flow-out',
          targetHandle: 'flow-in',
          type: 'vfxFlow',
          data: { systemId: system.id },
        })
      }
    }
  }

  for (const edge of doc.edges) {
    if (!edge.to.blockId || !edge.to.prop) continue
    edges.push({
      id: edge.id,
      source: edge.from.nodeId,
      target: contextIdForBlock(doc, edge.to.blockId) || edge.to.blockId,
      sourceHandle: 'out',
      // A property handle only exists while an edge targets it - see the
      // three-tier socket model. This is the id it is mounted under.
      targetHandle: `prop:${edge.to.blockId}:${edge.to.prop}`,
      type: 'vfxData',
      data: { blockId: edge.to.blockId, prop: edge.to.prop },
    })
  }

  return edges
}

function contextIdForBlock(doc, blockId) {
  for (const system of doc.systems) {
    for (const context of system.contexts) {
      if (context.blocks.some(block => block.id === blockId)) return context.id
    }
  }
  return null
}

// One shared empty array, so a context with no wires gets a STABLE identity in
// its data object. A fresh `[]` per render would defeat every memo downstream.
const EMPTY_WIRED = Object.freeze([])

/**
 * Every wired property, grouped by the context that owns the block.
 *
 * One pass over doc.edges for the whole document rather than one pass per
 * context: an effect with twenty contexts and thirty edges would otherwise do
 * six hundred comparisons per render.
 *
 * @param {Object} doc
 * @returns {Map<string, Array<{blockId: string, prop: string}>>}
 */
export function wiredPropsByContext(doc) {
  const contextOf = new Map()
  for (const system of doc.systems) {
    for (const context of system.contexts) {
      for (const block of context.blocks) contextOf.set(block.id, context.id)
    }
  }
  const out = new Map()
  for (const edge of doc.edges) {
    if (!edge.to.blockId || !edge.to.prop) continue
    const contextId = contextOf.get(edge.to.blockId)
    if (!contextId) continue
    const entry = { blockId: edge.to.blockId, prop: edge.to.prop }
    const list = out.get(contextId)
    if (list) list.push(entry)
    else out.set(contextId, [entry])
  }
  return out
}

/**
 * Which property handles have to be mounted on a context node.
 *
 * The invariant that makes lazy property handles safe: React Flow keeps an edge
 * in state when its targetHandle has no mounted handle, but cannot render it
 * and logs an error. So a handle stays mounted for its edge's whole lifetime,
 * whatever the block's collapse state - collapsing repositions it rather than
 * removing it.
 *
 * @param {Object} doc
 * @param {string} contextId
 * @returns {Array<{blockId: string, prop: string}>}
 */
export function wiredPropsForContext(doc, contextId) {
  const context = doc.systems
    .flatMap(system => system.contexts)
    .find(entry => entry.id === contextId)
  if (!context) return []
  const blockIds = new Set(context.blocks.map(block => block.id))
  return doc.edges
    .filter(edge => edge.to.blockId && edge.to.prop && blockIds.has(edge.to.blockId))
    .map(edge => ({ blockId: edge.to.blockId, prop: edge.to.prop }))
}

/**
 * Reset every stored position, so the board returns to the tidy default.
 * @param {Object} doc
 * @returns {Object}
 */
export function clearLayout(doc) {
  return { ...doc, layout: { ...doc.layout, nodes: {} } }
}

/**
 * Store a moved node's position.
 *
 * Cosmetic by definition, so callers commit it WITHOUT an undo label and with
 * a coalesce key - a drag should not bury the author's real edits under a
 * hundred position entries.
 */
export function setNodePosition(doc, nodeId, position) {
  return {
    ...doc,
    layout: {
      ...doc.layout,
      nodes: {
        ...(doc.layout?.nodes || {}),
        [nodeId]: { x: Math.round(position.x), y: Math.round(position.y) },
      },
    },
  }
}
