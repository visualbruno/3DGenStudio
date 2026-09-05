// Pointer picking across the N meshes in an assembly.
//
// A DOM handler on the canvas shell, not R3F's per-mesh `onClick`, for two
// reasons: the view-cube guard is a DOM concern (the cube is drawn inside the
// canvas, so its clicks reach the shell too), and choosing the frontmost hit
// across several independently-placed roots needs explicit control over the
// iteration rather than relying on R3F's event ordering.
import { useCallback } from 'react'
import * as THREE from 'three'
import { isPointerOverViewGizmo } from '../utils/viewGizmoLayout'
import { composePieceMatrix, ensurePieceBvh } from '../utils/assemblyGeometry'

const _raycaster = new THREE.Raycaster()
const _ndc = new THREE.Vector2()

export default function useAssemblyPicking({
  shellRef, cameraRef, entries, doc, gizmoDraggingRef,
  // What is actually DRAWN for each piece. A piece showing a fit preview is not
  // its loaded mesh any more, and picking the loaded one instead put landmarks
  // wherever the ray happened to cross the ORIGINAL surface — visibly away from
  // the click, by exactly the distance the fit had moved that spot.
  previews, showFitted,
}) {

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

      // Whatever the viewport is drawing for this piece — the same choice
      // AssemblyViewport makes. Picking must agree with what the user can see,
      // or every click lands somewhere they did not point at.
      const entry = (showFitted?.has(piece.id) ? previews?.get(piece.id) : null)
        || entries.get(piece.id)
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

    const { piece, hit } = best
    // The hit point with the piece's PLACEMENT divided out, so moving or
    // rescaling the piece later never invalidates a landmark.
    //
    // Divided out explicitly rather than via entry.root.worldToLocal(): the
    // consumers (LandmarkMarkers, buildLandmarkPayload) put the point back by
    // applying composePieceMatrix and nothing else, so this has to be its exact
    // inverse. worldToLocal also removes whatever transform the loaded root
    // carries, and for a preview the root is not the placed one at all — either
    // difference lands the marker away from the click.
    const localPoint = hit.point.clone()
      .applyMatrix4(composePieceMatrix(piece, new THREE.Matrix4()).invert())

    return {
      pieceId: piece.id,
      worldPoint: hit.point.clone(),
      localPoint,
      faceIndex: hit.faceIndex ?? null,
      normal: hit.face?.normal?.clone() || null,
      object: hit.object,
      distance: hit.distance,
    }
  }, [shellRef, cameraRef, entries, doc, previews, showFitted])

  /** Select-mode pointerdown: pick, or clear the selection on a miss. */
  const handleSelectPointerDown = useCallback((event, onSelect) => {
    if (gizmoDraggingRef.current) return
    if (event.button !== 0) return
    const hit = pickAt(event.clientX, event.clientY)
    onSelect(hit ? hit.pieceId : null)
  }, [pickAt, gizmoDraggingRef])

  return { pickAt, handleSelectPointerDown }
}
