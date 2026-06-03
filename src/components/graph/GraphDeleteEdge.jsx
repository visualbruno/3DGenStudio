import { memo, useEffect, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react'

// Deletable connection edge for the node graph, with an inline actions menu.
const GraphDeleteEdge = memo(function GraphDeleteEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })

  useEffect(() => {
    if (!menuOpen) {
      return undefined
    }

    const handleDocumentPointerDown = () => {
      setMenuOpen(false)
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown)
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown)
  }, [menuOpen])

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className="graph-page__edge-menu nodrag nopan"
          style={{
            left: `${labelX}px`,
            top: `${labelY}px`,
						'z-index':0
          }}
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            type="button"
            className="graph-page__edge-delete"
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(current => !current)
            }}
            title="Connection actions"
          >
            <span className="material-symbols-outlined">more_horiz</span>
          </button>

          {menuOpen && (
            <div className="graph-page__edge-dropdown">
              <button
                type="button"
                className="graph-page__edge-dropdown-action"
                onClick={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenuOpen(false)
                  data?.onDelete?.()
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
})

export default GraphDeleteEdge
