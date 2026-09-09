// The thin wire from an operator's output into a block property.
//
// These ARE stored (doc.edges) and ARE removable, so unlike a flow edge this
// one is interactive: hovering shows an X at its midpoint. That follows
// GraphDeleteEdge.jsx, which solved the same problem on the asset graph - a
// wire with no visible way to remove it sends people hunting through menus.
//
// The removal goes through the board's action bundle rather than React Flow's
// own onEdgesDelete, so it lands as one labelled undo entry alongside every
// other edit.

import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import { useVfxBoard } from './VfxBoardContext'

export default function VfxDataEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected,
}) {
  const { actions } = useVfxBoard()
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  })

  return (
    <>
      <BaseEdge
        path={path}
        style={{ stroke: selected ? '#d4a6ff' : '#8c5fc0', strokeWidth: 1.5 }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="vfx-edge__remove nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={() => actions.removeEdge(id)}
          title="Disconnect. The property keeps the last value it was given."
          aria-label="Disconnect"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
