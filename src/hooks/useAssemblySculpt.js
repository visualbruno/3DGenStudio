// Manual sculpting on an assembly piece — currently one brush, Elastic Grab.
//
// This exists because the automatic fit gets a piece most of the way and then
// leaves small local defects: a spike poking through a tunic, a corner clipping
// an arm. Those are seconds of work by hand and are not worth another parameter.
//
// WHAT GETS SCULPTED: always the piece's PREVIEW, never its loaded mesh. The
// preview is the piece's "current edited shape" — the fit already produces one,
// and sculpting creates one on demand if there is none. That keeps a single
// rule for the whole workspace: the loaded asset is never mutated, Discard
// throws the edit away, and Save writes the preview out.
//
// Strokes are evaluated from a snapshot taken at pointer-down (see
// applyElasticGrab), so a drag is one continuous deformation rather than an
// accumulation of frames.
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { isPointerOverViewGizmo } from '../utils/viewGizmoLayout'
import { worldUnitsPerPixel } from '../utils/cameraViewport'
import {
  dragPointOnViewPlane,
  finishStroke,
  grabPieceMeshes,
  restoreGeometryPositions,
  snapshotGeometryPositions,
} from '../utils/assemblySculpt'

const UNDO_LIMIT = 20

const _raycaster = new THREE.Raycaster()
const _ndc = new THREE.Vector2()

export default function useAssemblySculpt({
  shellRef,
  cameraRef,
  // resolveTarget(raycaster) -> { entry, point } | null
  //
  // The PAGE decides what is under the cursor, because sculpting works on
  // whatever you click rather than on a pre-selected piece. Requiring a
  // selection first was friction with no purpose: the click already says which
  // piece you mean, and a disabled brush button with no explanation is worse
  // than no button.
  resolveTarget,
  enabled,
  radiusPixels,
  strength,
  // onEdited(pieceId) — fired whenever a stroke or an undo has changed a
  // piece's geometry, so the owner can mirror it to disk. The brush writes
  // into the preview's buffers directly, so there is no other way to notice.
  onEdited,
}) {
  const strokeRef = useRef(null)     // { meshes, snapshot, centre, entry }
  const undoRef = useRef([])         // [{ entry, snapshot }]
  const [undoDepth, setUndoDepth] = useState(0)
  const [cursor, setCursor] = useState(null)   // { x, y, radius } in shell pixels

  // A stroke in flight when the tool is switched off would otherwise be stuck
  // holding a snapshot forever.
  useEffect(() => {
    if (!enabled) {
      strokeRef.current = null
      setCursor(null)
    }
  }, [enabled])

  const pointerToNdc = useCallback((event, rect) => {
    _ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )
    return _ndc
  }, [])

  /** World radius matching the on-screen brush size at the grabbed depth. */
  const worldRadius = useCallback((camera, point, rect) => {
    const distance = camera.position.distanceTo(point)
    const perPixel = worldUnitsPerPixel(camera, distance, rect.height)
    return Math.max(perPixel * radiusPixels, 1e-6)
  }, [radiusPixels])

  const onPointerDown = useCallback(event => {
    if (!enabled || event.button !== 0) return false
    const shell = shellRef.current
    const camera = cameraRef.current
    if (!shell || !camera) return false

    const rect = shell.getBoundingClientRect()
    // The view cube lives inside the canvas, so its clicks reach here too.
    if (isPointerOverViewGizmo(event.clientX - rect.left, event.clientY - rect.top, rect)) return false

    _raycaster.setFromCamera(pointerToNdc(event, rect), camera)
    _raycaster.firstHitOnly = true

    const target = resolveTarget?.(_raycaster)
    if (!target?.entry?.meshes?.length) return false

    strokeRef.current = {
      entry: target.entry,
      meshes: target.entry.meshes,
      snapshot: snapshotGeometryPositions(target.entry.meshes),
      centre: target.point.clone(),
      radius: worldRadius(camera, target.point, rect),
      moved: false,
    }
    event.preventDefault()
    return true
  }, [enabled, shellRef, cameraRef, resolveTarget, pointerToNdc, worldRadius])

  const onPointerMove = useCallback(event => {
    const shell = shellRef.current
    const camera = cameraRef.current
    if (!enabled || !shell || !camera) return false
    const rect = shell.getBoundingClientRect()

    // The cursor ring follows the pointer whether or not a stroke is running.
    setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top, radius: radiusPixels })

    const stroke = strokeRef.current
    if (!stroke) return false

    _raycaster.setFromCamera(pointerToNdc(event, rect), camera)
    const point = dragPointOnViewPlane(_raycaster, camera, stroke.centre)
    if (!point) return false

    grabPieceMeshes(stroke.meshes, stroke.snapshot, {
      centre: stroke.centre,
      drag: point.sub(stroke.centre),
      radius: stroke.radius,
      strength,
    })
    stroke.moved = true
    event.preventDefault()
    return true
  }, [enabled, shellRef, cameraRef, pointerToNdc, radiusPixels, strength])

  const onPointerUp = useCallback(() => {
    const stroke = strokeRef.current
    strokeRef.current = null
    if (!stroke) return false

    if (!stroke.moved) return false      // a click with no drag changes nothing
    finishStroke(stroke.meshes)

    // The snapshot IS the undo entry — it is the state before the stroke.
    undoRef.current.push({ entry: stroke.entry, snapshot: stroke.snapshot })
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
    setUndoDepth(undoRef.current.length)
    if (stroke.entry?.pieceId) onEdited?.(stroke.entry.pieceId)
    return true
  }, [onEdited])

  const undo = useCallback(() => {
    const last = undoRef.current.pop()
    setUndoDepth(undoRef.current.length)
    if (!last?.entry?.meshes?.length) return
    restoreGeometryPositions(last.entry.meshes, last.snapshot)
    finishStroke(last.entry.meshes)
    // An undo is an edit too: without this the stored copy keeps the stroke
    // that was just taken back, and reopening would bring it right back.
    if (last.entry?.pieceId) onEdited?.(last.entry.pieceId)
  }, [onEdited])

  // Strokes reference geometries owned by a preview. Once that preview is gone
  // (discarded, re-fitted, piece removed) the entries are stale and restoring
  // one would write into disposed buffers.
  const forgetHistoryFor = useCallback(entry => {
    undoRef.current = undoRef.current.filter(item => item.entry !== entry)
    setUndoDepth(undoRef.current.length)
    if (strokeRef.current?.entry === entry) strokeRef.current = null
  }, [])

  const clearHistory = useCallback(() => {
    undoRef.current = []
    setUndoDepth(0)
    strokeRef.current = null
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave: useCallback(() => setCursor(null), []),
    cursor,
    canUndo: undoDepth > 0,
    undo,
    forgetHistoryFor,
    clearHistory,
    isStroking: () => !!strokeRef.current,
  }
}
