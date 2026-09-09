// The wire between two stages of a system.
//
// NOT INTERACTIVE, and that is the point. Flow edges are DERIVED from which
// contexts a system has (see toFlowEdges in src/utils/vfx/flow.js) rather than
// stored, so there is nothing to select, drag or delete here - an illegal
// ordering cannot be drawn because it cannot be represented. Making the edge
// look inert is honest: a wire the author can grab but not change is worse than
// one that clearly is not a control.

import { BaseEdge, getSmoothStepPath } from '@xyflow/react'

export default function VfxFlowEdge({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd,
}) {
  const [path] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    borderRadius: 10,
  })
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      // Thicker than a data wire, because it carries particles rather than a
      // number, and the two must not be mistaken for each other.
      style={{ stroke: '#3d5f96', strokeWidth: 2.5 }}
      interactionWidth={0}
    />
  )
}
