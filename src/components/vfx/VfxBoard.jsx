// The node board.
//
// A thin shell over React Flow: the document → nodes/edges conversion is in
// src/utils/vfx/flow.js (pure), the editing is in src/utils/vfx/edits.js
// (pure), and the actions reach the node components through VfxBoardContext.
// What is left here is the parts that genuinely need the React Flow instance.
//
// WIRING CANNOT BE WRONG, and three mechanisms enforce that rather than one:
//
//   - flow edges are not drawn from stored wiring at all, so an illegal stage
//     order is unrepresentable (see toFlowEdges);
//   - a data wire dropped on a BLOCK opens a chooser of that block's
//     compatible properties, instead of guessing which one was meant;
//   - a second wire into a property REPLACES the first rather than being
//     refused - refusing would leave the author to discover they must delete
//     the old one, and replacing is what dropping a second wire there means.
//
// IT MUST BE MOUNTED INSIDE A <ReactFlowProvider>. This component calls
// useReactFlow itself (for screenToFlowPosition), which needs a provider ABOVE
// the <ReactFlow> it renders - so the page supplies one. That also means the
// page can hold the instance and pan the board when an undo changes something
// off-screen.
//
// POSITIONS COMMIT ON DRAG STOP, NOT DURING THE DRAG. React Flow moves nodes
// itself while the pointer is down; committing per frame would mean a document
// change, a recompile check and a normalise pass sixty times a second. On
// release the position lands with a coalesce key and no undo label, because
// moving a node is cosmetic - `layout` is the one part of the document the
// compiler never reads.

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import { CATALOG, PROP_TYPE, propChannels } from '../../../vfx/catalog.js'
import { toFlowEdges, toFlowNodes } from '../../utils/vfx/flow.js'
import { VfxBoardContext } from './VfxBoardContext'
import VfxContextNode from './VfxContextNode'
import VfxOperatorNode from './VfxOperatorNode'
import VfxFlowEdge from './VfxFlowEdge'
import VfxDataEdge from './VfxDataEdge'
import './VfxBoard.css'

// Declared at module scope. React Flow warns - loudly, and correctly - when
// these objects change identity between renders, because it re-registers every
// node type when they do.
const NODE_TYPES = { vfxContext: VfxContextNode, vfxOperator: VfxOperatorNode }
const EDGE_TYPES = { vfxFlow: VfxFlowEdge, vfxData: VfxDataEdge }

// Property types a numeric wire can drive. A texture or mesh slot names an
// asset, so there is nothing for an operator to compute into it.
const WIRABLE = new Set([PROP_TYPE.FLOAT, PROP_TYPE.INT, PROP_TYPE.VEC3, PROP_TYPE.COLOR])

/**
 * @param {Object} props
 * @param {Object} props.doc
 * @param {Array<Object>} props.diagnosticIndex from indexDiagnostics
 * @param {Object} props.actions the action bundle (see VfxBoardContext)
 * @param {Object} props.expanded blockId -> bool
 * @param {Object} props.fieldProps blockId -> { propName -> extra field props }
 * @param {string|null} props.selectedBlockId
 * @param {string|null} props.selectedContextId
 * @param {string|null} props.engineTarget
 * @param {string} props.level disclosure level
 * @param {(instance: Object) => void} [props.onInit]
 */
export default function VfxBoard({
  doc,
  diagnosticIndex,
  actions,
  expanded,
  fieldProps,
  selectedBlockId,
  selectedContextId,
  engineTarget,
  level,
  onInit = null,
}) {
  const { screenToFlowPosition } = useReactFlow()
  const pointer = useRef({ x: 0, y: 0 })
  const [chooser, setChooser] = useState(null)

  const nodes = useMemo(() => toFlowNodes(doc, {
    diagnostics: diagnosticIndex,
    selectedBlockId,
    selectedContextId,
    engineTarget,
    level,
  }), [diagnosticIndex, doc, engineTarget, level, selectedBlockId, selectedContextId])

  const edges = useMemo(() => toFlowEdges(doc), [doc])

  // The whole bundle in one memo, so a node's useVfxBoard() does not see a new
  // object on every render of this component.
  const board = useMemo(
    () => ({ actions, expanded, fieldProps, engineTarget, level }),
    [actions, engineTarget, expanded, fieldProps, level],
  )

  const handleNodeDragStop = useCallback((_event, node) => {
    actions.moveNode(node.id, node.position)
  }, [actions])

  const handleConnect = useCallback(connection => {
    const { source, targetHandle } = connection
    if (!source || !targetHandle) return

    // Dropped straight on a wired property: the author aimed at a specific one.
    if (targetHandle.startsWith('prop:')) {
      const [, blockId, prop] = targetHandle.split(':')
      actions.wire(source, blockId, prop)
      return
    }

    // Dropped on the block: ask which property. Only the compatible ones are
    // offered, so the answer cannot be wrong.
    if (targetHandle.startsWith('block:')) {
      const blockId = targetHandle.slice('block:'.length)
      const block = doc.systems
        .flatMap(system => system.contexts)
        .flatMap(context => context.blocks)
        .find(entry => entry.id === blockId)
      const def = block ? CATALOG.block(block.type) : null
      const options = Object.entries(def?.props || {})
        .filter(([, propDef]) => WIRABLE.has(propDef.type))
        .map(([name, propDef]) => ({
          name,
          label: propDef.label || name,
          channels: propChannels(propDef.type),
          hint: propDef.hint || '',
        }))

      if (options.length === 0) return
      if (options.length === 1) {
        actions.wire(source, blockId, options[0].name)
        return
      }
      setChooser({
        fromNodeId: source,
        blockId,
        blockLabel: def?.label || block.type,
        options,
        x: pointer.current.x,
        y: pointer.current.y,
      })
    }
  }, [actions, doc])

  // Only edges the author can actually remove reach here; flow edges are not
  // interactive.
  const handleEdgesDelete = useCallback(deleted => {
    for (const edge of deleted) {
      if (edge.type === 'vfxData') actions.removeEdge(edge.id)
    }
  }, [actions])

  const handlePaneClick = useCallback(() => {
    setChooser(null)
    actions.select(null)
  }, [actions])

  // A single click selects the node - but NOT when the click landed on a block
  // row, which has already selected the block itself. React Flow's node click
  // fires on the way up, so without this check selecting a block would
  // immediately be overwritten by selecting its context.
  const handleNodeClick = useCallback((event, node) => {
    if (event.target instanceof Element && event.target.closest('.vfx-block')) return
    if (node.type === 'vfxOperator') actions.selectOperator(node.id)
    else actions.selectContext(node.id)
  }, [actions])

  // Only an operator output may start a wire, and only a block or property
  // socket may receive one. The flow handles are declared unconnectable in the
  // node components, so this is the second line of defence rather than the
  // first - it also rejects a wire dragged from a handle React Flow believes is
  // connectable because a future node type forgot to say otherwise.
  const isValidConnection = useCallback(connection => {
    if (!connection.sourceHandle || !connection.targetHandle) return false
    if (connection.sourceHandle !== 'out') return false
    return connection.targetHandle.startsWith('block:')
      || connection.targetHandle.startsWith('prop:')
  }, [])

  return (
    <VfxBoardContext.Provider value={board}>
      <div
        className="vfx-board"
        // A plain ref, updated on every move: the chooser needs a screen
        // position and putting the pointer in state would re-render the board
        // on mouse movement.
        onPointerMove={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          pointer.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onInit={onInit}
          onConnect={handleConnect}
          isValidConnection={isValidConnection}
          onEdgesDelete={handleEdgesDelete}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          // NO onNodesChange, AND THAT IS DELIBERATE. The document is the
          // single source of truth for what this effect contains, so React
          // Flow's copy is a projection of it and never the other way round.
          // Two consequences, both checked against the library's behaviour:
          // a node still moves smoothly during a drag (the position lives in
          // React Flow's internal nodeLookup for the duration, and we commit it
          // in onNodeDragStop), and node selection is OURS - `selected` comes
          // from toFlowNodes, so a select change with nowhere to go is exactly
          // right.
          nodesConnectable
          nodesDraggable
          elementsSelectable
          minZoom={0.25}
          maxZoom={1.75}
          defaultViewport={{ x: 40, y: 40, zoom: 0.85 }}
          // Backspace inside a text field would otherwise delete the selected
          // node, which is how you lose work in a graph editor.
          deleteKeyCode={null}
          // Space is play/pause on this page and the most-pressed key on it.
          // React Flow's default pan-on-space would swallow every press.
          panActivationKeyCode={null}
          selectionKeyCode="Shift"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={22} size={1} color="#24272e" />
          <Controls showInteractive={false} position="bottom-right" />

          <Panel position="top-left" className="vfx-board__panel">
            <button
              type="button"
              onClick={() => actions.addSystem()}
              title="A system is one emitter: its own particles, its own capacity, its own timeline track."
            >
              <span className="material-symbols-outlined">add</span>
              System
            </button>
            <button
              type="button"
              onClick={() => {
                const position = screenToFlowPosition({
                  x: pointer.current.x + 200,
                  y: pointer.current.y,
                })
                actions.addOperator('op.constant', position)
              }}
              title="A number you can wire into several properties at once, so there is only one to change."
            >
              <span className="material-symbols-outlined">function</span>
              Value node
            </button>
            <button
              type="button"
              onClick={() => actions.tidy()}
              title="Forget every node position and lay the board out again"
            >
              <span className="material-symbols-outlined">account_tree</span>
              Tidy
            </button>
          </Panel>
        </ReactFlow>

        {chooser && (
          <div
            className="vfx-board__chooser"
            style={{ left: chooser.x, top: chooser.y }}
            role="menu"
          >
            <div className="vfx-board__chooser-head">
              Wire into {chooser.blockLabel}
              <button type="button" onClick={() => setChooser(null)} aria-label="Cancel">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            {chooser.options.map(option => (
              <button
                key={option.name}
                type="button"
                className="vfx-board__chooser-item"
                role="menuitem"
                title={option.hint}
                onClick={() => {
                  actions.wire(chooser.fromNodeId, chooser.blockId, option.name)
                  setChooser(null)
                }}
              >
                <span>{option.label}</span>
                {option.channels > 1 && (
                  <span className="vfx-board__chooser-width">{option.channels} ch</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </VfxBoardContext.Provider>
  )
}
