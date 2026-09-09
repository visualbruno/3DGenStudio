// A context node: one stage of a system, holding a stack of blocks.
//
// This is the shape Unity VFX Graph and Niagara both use, and copying it is
// deliberate - a developer who has seen either will recognise this board, and
// the effects authored here have somewhere to land.
//
// EVERY CONTROL IS `nodrag`, AND THE HEADER IS THE ONLY DRAG SURFACE. The body
// of this node is a list of buttons, sliders and selects; if the card itself
// were draggable, React Flow would swallow the pointerdown on every one of
// them and nothing inside would work. `dragHandle: '.vfx-node__drag-handle'`
// is set in src/utils/vfx/flow.js and the header carries that class.
//
// THE STACK SAYS WHAT ORDER MEANS. "Runs top to bottom" is on the node, not in
// a manual, because block order is the single most common thing a newcomer
// gets wrong: a Set Size after a Size Over Life overwrites it every frame and
// the curve appears to do nothing. Naming the rule where the rule applies is
// most of the fix.
//
// THE INSERTION POINT IS A LINE, NOT A GAP. During a reorder the other rows
// stay put and a 2px line marks where the block will land. Shifting siblings
// would mean animating each row by its own height, and rows here are not
// uniform - an expanded block is three times the height of a collapsed one, so
// "translate by 100%" would overlap or leave holes. A line is unambiguous at
// any row height and at any zoom.

import { Fragment, useMemo, useRef, useState } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import { CATALOG } from '../../../vfx/catalog.js'
import { CONTEXT_KIND } from '../../../vfx/doc.js'
import useVfxBlockDrag from '../../hooks/useVfxBlockDrag'
import useVfxHoverCard from '../../hooks/useVfxHoverCard'
import { useVfxBoard } from './VfxBoardContext'
import VfxBlockRow from './VfxBlockRow'
import VfxHoverCard from './VfxHoverCard'
import './VfxContextNode.css'

// Below this zoom the engine chips are hidden. GraphPage.css:734-737 records a
// measured collapse to ~2 fps in Electron from blurred badges inside the React
// Flow viewport; small text scaled down is the same cost for no legibility.
const BADGE_ZOOM = 0.7

export default function VfxContextNode({ id, data, selected }) {
  const { context, system, def, blocks, diagnostics, wiredProps, systemIndex } = data
  const { actions, expanded, fieldProps, engineTarget, level } = useVfxBoard()
  const listRef = useRef(null)
  const [adding, setAdding] = useState(false)
  // The palette is where a newcomer decides, so it is where the explanation has
  // to be. Portalled, so it is legible at 0.4 zoom and does not scale with the
  // board - see VfxHoverCard.
  const hover = useVfxHoverCard()

  // Subscribed narrowly to the zoom scalar rather than to the whole transform,
  // so a pan does not re-render every node on the board.
  const zoom = useStore(state => state.transform[2])
  const showBadges = zoom >= BADGE_ZOOM

  const { dragging, startDrag } = useVfxBlockDrag({
    listRef,
    blocks: context.blocks,
    onReorder: (blockId, toIndex) => actions.moveBlock(blockId, toIndex),
  })

  // Which blocks may be added here, from the catalog's own `contexts` list.
  // Filtered by disclosure level so 'guided' offers only the beginner set -
  // twenty options is not help.
  const addable = useMemo(() => {
    const all = CATALOG.blocks.filter(entry => entry.contexts.includes(context.kind))
    return level === 'guided' ? all.filter(entry => entry.beginner) : all
  }, [context.kind, level])

  const errorCount = diagnostics.filter(d => d.severity === 'error').length
  const warnCount = diagnostics.filter(d => d.severity === 'warn').length

  return (
    <div
      className={[
        'vfx-node',
        `is-${context.kind}`,
        selected ? 'is-selected' : '',
        errorCount ? 'has-error' : warnCount ? 'has-warn' : '',
      ].filter(Boolean).join(' ')}
      // The accent colour matches the system's swatch in the timeline, so a
      // five-system effect reads as the same five things in both places.
      style={{ '--vfx-system-accent': `var(--vfx-accent-${systemIndex % 6})` }}
    >
      {/* Flow sockets. Always mounted, exactly two, and NOT connectable: the
          stage chain is derived from the contexts a system has (see
          toFlowEdges), so it cannot be rewired into an illegal order - it can
          only be changed by adding or removing a stage. */}
      {context.kind !== CONTEXT_KIND.EVENT && (
        <Handle
          type="target"
          position={Position.Top}
          id="flow-in"
          className="vfx-node__flow"
          isConnectable={false}
        />
      )}
      {context.kind !== CONTEXT_KIND.OUTPUT && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="flow-out"
          className="vfx-node__flow"
          isConnectable={false}
        />
      )}

      <div
        className="vfx-node__header vfx-node__drag-handle"
        onDoubleClick={() => actions.selectContext(id)}
      >
        <span className="vfx-node__icon material-symbols-outlined">{def.icon}</span>
        <span className="vfx-node__titles">
          <span className="vfx-node__kind">{def.label}</span>
          <span className="vfx-node__system">{system.name}</span>
        </span>
        <button
          type="button"
          className="vfx-node__tool nodrag"
          onClick={() => actions.selectContext(id)}
          title={`${def.blurb}\n\n${def.flowNote}`}
          aria-label="Context settings"
        >
          <span className="material-symbols-outlined">tune</span>
        </button>
      </div>

      {/* The flow note is the sentence that answers "when does this run?" -
          the question that decides whether a block belongs in Initialize or
          Update, and the one nothing else on screen answers. */}
      <p className="vfx-node__note">{def.flowNote}</p>

      <ul className="vfx-node__stack" ref={listRef}>
        {context.blocks.map((block, index) => {
          const entry = blocks[index]
          const showDrop = dragging
            && dragging.toIndex === index
            && dragging.fromIndex !== index
          return (
            <Fragment key={block.id}>
              {/* Zero-height, so it costs no layout. That matters: the drag's
                  bands were measured before this appeared, and an indicator
                  that pushed the rows down 2px would make the row jump under
                  the pointer and the insertion point chase itself. */}
              {showDrop && <li className="vfx-node__drop" aria-hidden="true" />}
              <VfxBlockRow
                block={block}
                def={entry?.def || CATALOG.block(block.type)}
                index={index}
                diagnostics={entry?.diagnostics || []}
                wiredProps={wiredProps}
                selected={data.selectedBlockId === block.id}
                expanded={Boolean(expanded[block.id])}
                showBadges={showBadges}
                engineTarget={engineTarget}
                actions={actions}
                onGripDown={startDrag}
                fieldProps={fieldProps[block.id] || {}}
              />
            </Fragment>
          )
        })}
        {dragging && dragging.toIndex >= context.blocks.length && (
          <li className="vfx-node__drop" aria-hidden="true" />
        )}
      </ul>

      {context.blocks.length === 0 && (
        <p className="vfx-node__empty">
          Nothing here yet.
          {context.kind === CONTEXT_KIND.SPAWN && ' Add Spawn Rate or Spawn Burst to emit particles.'}
          {context.kind === CONTEXT_KIND.INITIALIZE && ' Every particle needs a lifetime and a size.'}
          {context.kind === CONTEXT_KIND.UPDATE && ' Add a force, or a value that changes over life.'}
          {context.kind === CONTEXT_KIND.OUTPUT && ' Add a Sprite Texture, or leave it to draw plain quads.'}
        </p>
      )}

      {/* Context params - an Output's blend mode, an Update's integrator. They
          are settings on the stage itself rather than blocks in it, mirroring
          how VFX Graph splits an Output's render state from its blocks. */}
      {Object.keys(def.params || {}).length > 0 && (
        <div className="vfx-node__params nodrag">
          {Object.entries(def.params).map(([param, paramDef]) => (
            <label className="vfx-node__param" key={param} title={paramDef.hint || ''}>
              <span>{paramDef.label}</span>
              <select
                value={context.params?.[param] ?? paramDef.default}
                onChange={event => actions.setContextParam(id, param, event.target.value)}
              >
                {paramDef.options.map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      <div className="vfx-node__footer nodrag">
        {adding ? (
          <div className="vfx-node__add-menu nowheel">
            <div className="vfx-node__add-head">
              <span>Add to {def.label}</span>
              <button type="button" onClick={() => setAdding(false)} aria-label="Close">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            {addable.length === 0 && <p className="vfx-node__add-empty">Nothing to add here yet.</p>}
            {addable.map(entry => (
              <button
                key={entry.id}
                type="button"
                className="vfx-node__add-item"
                onClick={() => {
                  actions.addBlock(id, entry.id)
                  setAdding(false)
                }}
                {...hover.bind(entry)}
              >
                <span className="vfx-node__add-name">{entry.label}</span>
                {/* The blurb is always visible, never hover-only: a palette
                    that requires hovering to be understood is a palette a
                    newcomer scrolls past. */}
                <span className="vfx-node__add-blurb">{entry.blurb}</span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="vfx-node__add" onClick={() => setAdding(true)}>
            <span className="material-symbols-outlined">add</span>
            Add block
          </button>
        )}
        <span className="vfx-node__order">runs top to bottom</span>
      </div>

      {hover.card && <VfxHoverCard anchor={hover.card.anchor} def={hover.card.def} />}
    </div>
  )
}
