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
import VfxNoteNode from './VfxNoteNode'
import VfxFlowEdge from './VfxFlowEdge'
import VfxDataEdge from './VfxDataEdge'
import './VfxBoard.css'

// Declared at module scope. React Flow warns - loudly, and correctly - when
// these objects change identity between renders, because it re-registers every
// node type when they do.
const NODE_TYPES = {
  vfxContext: VfxContextNode,
  vfxOperator: VfxOperatorNode,
  vfxNote: VfxNoteNode,
}
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
 * @param {string|null} [props.selectedOperatorId]
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
  selectedOperatorId,
  engineTarget,
  level,
  onInit = null,
}) {
  // getInternalNode, not getNode: the measured size is on the INTERNAL node.
  // See the Tidy button for why that distinction is load-bearing.
  const { screenToFlowPosition, getInternalNode } = useReactFlow()
  const pointer = useRef({ x: 0, y: 0 })
  const [chooser, setChooser] = useState(null)
  // BOARD-LOCAL, and deliberately not document selection: a note is edited in
  // place - its text, its colour, its size are all on the node itself - so it
  // has nothing to show in the Parameters panel. All this drives is the ring
  // and the resize handles.
  const [selectedNoteId, setSelectedNoteId] = useState(null)

  // POSITIONS OF NODES CURRENTLY UNDER THE POINTER, and nothing else.
  //
  // THE BUG: a dragged node did not follow the cursor - it stayed put until the
  // mouse was released, then jumped to where it had been let go. React Flow
  // applies a node change ITSELF only when it owns the array (`defaultNodes`);
  // with a controlled `nodes` prop, `triggerNodeChanges` calls onNodesChange
  // and applies nothing (see @xyflow/react's store). With no handler at all,
  // every position change a drag produced went into the void, and the node's
  // rendered position stayed whatever the document said until pointer-up
  // committed the edit. The comment on <ReactFlow> below used to assert the
  // opposite; it was a guess, and this is what the library actually does.
  //
  // Why a separate map rather than making the whole array stateful: the
  // document remains the single source of truth for what this effect CONTAINS.
  // This holds the one thing the document deliberately does not have - where a
  // node is WHILE it is being dragged - and it is emptied the instant the
  // gesture ends, in the same React batch as the real edit, so there is no
  // frame where the two disagree and no second copy of the graph to keep in
  // sync.
  const [dragPositions, setDragPositions] = useState(null)

  // A DRAG MOVES ONLY WHAT YOU GRABBED, and this ref is what enforces it.
  //
  // React Flow drags the node under the pointer TOGETHER WITH everything
  // `selected` (getDragItems in @xyflow/system). That is right in an editor
  // where selection is a deliberate multi-select; it is wrong here, because
  // `selected` on this board means "the node open in the Parameters panel".
  // Clicking Initialize to edit it and then dragging Update would move
  // Initialize as well, for no reason the author could see. Filtering to the
  // node the gesture started on is the whole prevention - and it is only needed
  // now that a drag moves anything on screen at all.
  const dragOrigin = useRef(null)

  const handleNodeDragStart = useCallback((_event, node) => {
    dragOrigin.current = node.id
  }, [])

  const handleNodesChange = useCallback(changes => {
    // Position changes only, and only for the node under the pointer.
    // Selection is ours (it comes from the document, via toFlowNodes) and
    // dimensions live in React Flow's own lookup, so every other change is
    // correctly a no-op here.
    let moving = null
    let settled = false
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue
      if (change.id !== dragOrigin.current) continue
      if (change.dragging) {
        if (!moving) moving = new Map()
        moving.set(change.id, change.position)
      } else {
        // `dragging: false` is the release. onNodeDragStop fires from the same
        // event, so clearing here and committing there land in one batch.
        settled = true
      }
    }
    if (moving) {
      setDragPositions(previous => {
        const next = new Map(previous)
        for (const [id, position] of moving) next.set(id, position)
        return next
      })
    } else if (settled) {
      setDragPositions(null)
    }
  }, [])

  // TWO MEMOS, NOT ONE, AND THE SPLIT IS LOAD-BEARING.
  //
  // React Flow re-derives its internal node whenever the user node's IDENTITY
  // changes, and it reads `measured` and the handle bounds from the user node -
  // which ours never carry, because the document has no idea how tall anything
  // rendered. So a new object means a node that is briefly unmeasured with no
  // handle bounds, until the ResizeObserver reports it again a frame later.
  //
  // One memo over both dependencies would rebuild EVERY node on every pointer
  // move of a drag, so the whole board would re-measure itself sixty times a
  // second and every edge would be re-routed from missing handle bounds. Split,
  // the document's array stays identical for the length of a gesture and only
  // the node actually being dragged gets a new object - which is exactly what
  // React Flow's own applyNodeChanges does.
  const flowNodes = useMemo(() => toFlowNodes(doc, {
    diagnostics: diagnosticIndex,
    selectedBlockId,
    selectedContextId,
    selectedOperatorId,
    selectedNoteId,
    engineTarget,
    level,
  }), [
    diagnosticIndex, doc, engineTarget, level,
    selectedBlockId, selectedContextId, selectedNoteId, selectedOperatorId,
  ])

  const nodes = useMemo(() => {
    if (!dragPositions || dragPositions.size === 0) return flowNodes
    return flowNodes.map(node => {
      const position = dragPositions.get(node.id)
      if (!position) return node
      // The measured size is carried forward for the one node that does get a
      // new object, so even it does not re-measure mid-drag. React Flow's own
      // controlled pattern gets this for free because applyNodeChanges writes
      // `measured` onto the user node from a dimensions change; we ignore
      // dimensions changes (React Flow's lookup is their home), so this is
      // where that value comes back from.
      const measured = getInternalNode(node.id)?.measured
      return measured?.width && measured?.height
        ? { ...node, position, measured }
        : { ...node, position }
    })
  }, [dragPositions, flowNodes, getInternalNode])

  const edges = useMemo(() => toFlowEdges(doc), [doc])

  // The whole bundle in one memo, so a node's useVfxBoard() does not see a new
  // object on every render of this component.
  const board = useMemo(
    () => ({ actions, expanded, fieldProps, engineTarget, level }),
    [actions, engineTarget, expanded, fieldProps, level],
  )

  // Only the node the gesture STARTED on - see dragOrigin.
  const handleNodeDragStop = useCallback((_event, node) => {
    dragOrigin.current = null
    // A note's position is its own content rather than layout state, so it goes
    // to updateNote - clearLayout deliberately does not reset notes, and
    // routing them through moveNode would put them in the map Tidy clears.
    if (node.type === 'vfxNote') actions.updateNote(node.id, {
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
    })
    else actions.moveNode(node.id, node.position)
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
    setSelectedNoteId(null)
    actions.select(null)
  }, [actions])

  // A single click selects the node - but NOT when the click landed on a block
  // row, which has already selected the block itself. React Flow's node click
  // fires on the way up, so without this check selecting a block would
  // immediately be overwritten by selecting its context.
  const handleNodeClick = useCallback((event, node) => {
    if (event.target instanceof Element && event.target.closest('.vfx-block')) return
    setSelectedNoteId(node.type === 'vfxNote' ? node.id : null)
    // A note has no Parameters panel of its own, so selecting one CLEARS the
    // document selection rather than setting it. It used to fall through to
    // selectContext, which pointed the panel at a context id that does not
    // exist.
    if (node.type === 'vfxNote') actions.select(null)
    else if (node.type === 'vfxOperator') actions.selectOperator(node.id)
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
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onNodesChange={handleNodesChange}
          // onNodesChange HANDLES ONE CHANGE TYPE - a position while dragging -
          // and ignores the rest on purpose: the document is the single source
          // of truth for what this effect contains, so React Flow's copy is a
          // projection of it and never the other way round. Selection is ours
          // (`selected` comes from toFlowNodes), dimensions are React Flow's,
          // and the committed position is written by onNodeDragStop. See
          // handleNodesChange for why the drag needs the handler at all.
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
              onClick={() => {
                const position = screenToFlowPosition({
                  x: pointer.current.x,
                  y: pointer.current.y + 40,
                })
                actions.addNote(position)
              }}
              title="Leave a note on the board - for yourself, or for whoever opens this next"
            >
              <span className="material-symbols-outlined">sticky_note_2</span>
              Note
            </button>
            <button
              type="button"
              onClick={() => {
                // MEASURED, not derived: autoLayout packs each column by the
                // real height of each node, which is what an author means by
                // "tidy" once a stage has eight blocks in it.
                //
                // THE MEASUREMENTS ARE NOT ON THE NODES WE PASS IN. Tidy used
                // to read `node.measured` off the array `toFlowNodes` builds,
                // where that field has never existed - so every node measured
                // zero, autoLayout fell back to a uniform 160px row for all of
                // them, and a stage with eight blocks overlapped the one below
                // it. Which is the bug Tidy exists to fix, reported as Tidy
                // causing it.
                //
                // React Flow writes measured sizes into its own nodeLookup
                // (`updateNodeInternals` sets `measured` on the INTERNAL node,
                // never on the user node), so getInternalNode is the only
                // source. A node that has not been measured yet - one just
                // added, or hidden - returns null and autoLayout uses its
                // fallback for that one node rather than for all of them.
                actions.tidy(id => {
                  const measured = getInternalNode(id)?.measured
                  return measured?.width && measured?.height
                    ? { width: measured.width, height: measured.height }
                    : null
                })
              }}
              title="Lay the board out again, packing each system to fit its own blocks"
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
