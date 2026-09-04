// Pointer picking across the N meshes in an assembly.
//
// A DOM handler on the canvas shell, not R3F's per-mesh `onClick`, for two
// reasons: the view-cube guard is a DOM concern (the cube is drawn inside the
// canvas, so its clicks reach the shell too), and choosing the frontmost hit
// across several independently-placed roots needs explicit control over the
// iteration rather than relying on R3F's event ordering.
import { useCallback, useRef } from 'react'
import * as THREE from 'three'
import { isPointerOverViewGizmo } from '../utils/viewGizmoLayout'
import { ensurePieceBvh } from '../utils/assemblyGeometry'

const _raycaster = new THREE.Raycaster()
const _ndc = new THREE.Vector2()

export default function useAssemblyPicking({ shellRef, cameraRef, entries, doc }) {
  // Set by the transform gizmo while a drag is in progress (Phase 2). A drag that
  // ends over a different piece must not re-select it.
  const gizmoDraggingRef = useRef(false)

  /**
   * What is under the pointer, or null.
   *
   * `candidates` restricts the search — landmark picking passes just the base or
   * just one piece, so a stray click on a third mesh does nothing at all.
   */
  const pickAt = useCallback((clientX, clientY, { candidates = null } = {}) => {
    const shell = shellRef.current
    const camera = cameraRef.current
    if (!shell || !camera) return null

    const rect = shell.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    // FIRST, always. The view cube sits inside the canvas, so without this a
    // click on it would also select a piece (or, later, drop a landmark) —
    // exactly the class of bug utils/viewGizmoLayout.js was written to prevent.
    if (isPointerOverViewGizmo(x, y, rect)) return null
    if (rect.width <= 0 || rect.height <= 0) return null

    _ndc.set((x / rect.width) * 2 - 1, -((y / rect.height) * 2 - 1))
    _raycaster.setFromCamera(_ndc, camera)
    // Honoured by three-mesh-bvh's accelerated raycast (patched onto the THREE
    // prototypes in utils/meshEditor.js); harmless without a BVH.
    _raycaster.firstHitOnly = true

    const isolated = doc?.settings?.isolatedPieceId
    let best = null

    for (const piece of doc?.pieces || []) {
      if (candidates && !candidates.includes(piece.id)) continue
      if (!piece.visible || piece.locked) continue
      // Isolate hides the rest, and a hidden piece must not be pickable — a
      // click would otherwise select something the user cannot see.
      if (isolated && piece.id !== isolated && piece.id !== doc.basePieceId) continue

      const entry = entries.get(piece.id)
      if (!entry?.root) continue

      // Built here rather than at load: see ensurePieceBvh. The cost lands once
      // per piece, on the first click, instead of freezing the page on import.
      ensurePieceBvh(entry)

      const hits = _raycaster.intersectObject(entry.root, true)
      if (!hits.length) continue
      const hit = hits[0]
      if (best && hit.distance >= best.distance) continue

      best = { piece, entry, hit, distance: hit.distance }
    }

    if (!best) return null

    const { piece, entry, hit } = best
    // The hit point in the PIECE ROOT's space as well as the world's. Landmarks
    // are stored per-mesh and pre-placement, so that a piece being moved or
    // rescaled later never invalidates a pair.
    const localPoint = hit.point.clone()
    entry.root.updateMatrixWorld(true)
    entry.root.worldToLocal(localPoint)

    return {
      pieceId: piece.id,
      worldPoint: hit.point.clone(),
      localPoint,
      faceIndex: hit.faceIndex ?? null,
      normal: hit.face?.normal?.clone() || null,
      object: hit.object,
      distance: hit.distance,
    }
  }, [shellRef, cameraRef, entries, doc])

  /** Select-mode pointerdown: pick, or clear the selection on a miss. */
  const handleSelectPointerDown = useCallback((event, onSelect) => {
    if (gizmoDraggingRef.current) return
    if (event.button !== 0) return
    const hit = pickAt(event.clientX, event.clientY)
    onSelect(hit ? hit.pieceId : null)
  }, [pickAt])

  return { pickAt, handleSelectPointerDown, gizmoDraggingRef }
}
