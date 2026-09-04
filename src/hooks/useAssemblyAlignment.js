// The alignment actions for the selected piece: fit to a body region, drop to
// the surface, mirror, duplicate, reset, copy/paste transform, and the gizmo
// drag lifecycle.
//
// Extracted from AssemblyPage so the page stays a shell. The geometry itself
// lives in utils/assemblyGeometry.js, which has no React import and is unit
// tested in plain Node; this hook is only the wiring between it, the document
// mutators, and the piece that happens to be selected.
import { useCallback, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  baseRegionBox,
  dropPieceToSurface,
  ensurePieceBvh,
  fitPieceToRegion,
  mirrorPieceAcrossBase,
  movePieceToRegion,
  pieceWorldBox,
} from '../utils/assemblyGeometry'

export default function useAssemblyAlignment({
  base,
  selectedPiece,
  selectedEntry,
  getEntry,
  patchPiece,
  duplicatePiece,
  gizmoDraggingRef,
}) {
  // Clipboard for Copy/Paste transform. A ref, not state: nothing renders from
  // it except the paste button's enabled-ness, which `clipboardFilled` tracks.
  const clipboardRef = useRef(null)
  const [clipboardFilled, setClipboardFilled] = useState(false)

  /** The base's world box, which every alignment action is measured against. */
  const baseBox = useMemo(() => {
    const entry = base ? getEntry(base.id) : null
    return entry ? pieceWorldBox(entry, base) : null
  }, [base, getEntry])

  // The region the selected piece is aiming at. Its own centre is the reference
  // that picks a SIDE for the paired regions, so a gauntlet sitting on the
  // body's left fits to the left hand rather than always the right.
  const targetRegionBox = useCallback(region => {
    if (!baseBox || !selectedPiece || !selectedEntry) return null
    const centre = pieceWorldBox(selectedEntry, selectedPiece).getCenter(new THREE.Vector3())
    return baseRegionBox(baseBox, region || selectedPiece.fitRegion, { referencePoint: centre })
  }, [baseBox, selectedPiece, selectedEntry])

  // Every action funnels through here, so a geometry helper returning null (it
  // could not be computed) is a no-op rather than a crash.
  const commit = useCallback(patch => {
    if (patch && selectedPiece) patchPiece(selectedPiece.id, patch)
  }, [patchPiece, selectedPiece])

  const fitToRegion = useCallback(axes => {
    if (!selectedPiece || !selectedEntry) return
    commit(fitPieceToRegion(selectedPiece, selectedEntry, targetRegionBox(), { axes }))
  }, [commit, selectedPiece, selectedEntry, targetRegionBox])

  const moveToRegion = useCallback(() => {
    if (!selectedPiece || !selectedEntry) return
    commit(movePieceToRegion(selectedPiece, selectedEntry, targetRegionBox()))
  }, [commit, selectedPiece, selectedEntry, targetRegionBox])

  const dropToSurface = useCallback(() => {
    if (!selectedPiece || !selectedEntry) return
    const baseEntry = base ? getEntry(base.id) : null
    // The drop is a raycast, so the base needs its spatial index. Built on
    // demand here for the same reason picking does it — never at import, where
    // a 500k-vertex body would freeze the page.
    if (baseEntry) ensurePieceBvh(baseEntry)
    commit(dropPieceToSurface(selectedPiece, selectedEntry, baseEntry, base))
  }, [commit, selectedPiece, selectedEntry, base, getEntry])

  const mirror = useCallback(() => {
    if (!selectedPiece) return
    commit(mirrorPieceAcrossBase(selectedPiece, baseBox))
  }, [commit, selectedPiece, baseBox])

  const duplicate = useCallback(({ mirrored }) => {
    if (!selectedPiece) return
    duplicatePiece(selectedPiece.id, mirrored ? mirrorPieceAcrossBase(selectedPiece, baseBox) : {})
  }, [duplicatePiece, selectedPiece, baseBox])

  const reset = useCallback(() => {
    commit({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirrorX: false })
  }, [commit])

  const copyTransform = useCallback(() => {
    if (!selectedPiece) return
    const { position, rotation, scale, mirrorX } = selectedPiece
    clipboardRef.current = { position, rotation, scale, mirrorX }
    setClipboardFilled(true)
  }, [selectedPiece])

  const pasteTransform = useCallback(() => {
    if (clipboardRef.current) commit({ ...clipboardRef.current })
  }, [commit])

  // ---- Gizmo drag ----------------------------------------------------------
  // Suppressing history mid-drag is what keeps undo usable: TransformControls
  // fires on every frame, so one entry per frame would bury the pre-drag state
  // dozens deep. The commit on mouse-up is the single undoable step.
  const onGizmoDragStart = useCallback(() => {
    gizmoDraggingRef.current = true
  }, [gizmoDraggingRef])

  const onGizmoDrag = useCallback(trs => {
    if (selectedPiece) patchPiece(selectedPiece.id, trs, { history: false })
  }, [patchPiece, selectedPiece])

  const onGizmoDragEnd = useCallback(trs => {
    if (selectedPiece) patchPiece(selectedPiece.id, trs)
    // Cleared on the next tick, not now: the pointerup that ends the drag is
    // still on its way to the shell's handler, and clearing synchronously would
    // let the release re-pick whatever happens to be under the cursor.
    setTimeout(() => { gizmoDraggingRef.current = false }, 0)
  }, [patchPiece, selectedPiece, gizmoDraggingRef])

  return {
    baseBox,
    commit,
    fitToRegion,
    moveToRegion,
    dropToSurface,
    mirror,
    duplicate,
    reset,
    copyTransform,
    pasteTransform,
    clipboardFilled,
    onGizmoDragStart,
    onGizmoDrag,
    onGizmoDragEnd,
  }
}
