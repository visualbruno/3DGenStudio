// Placing landmark pairs: "this point on the armour goes on that point of the body."
//
// A pair is the only way the fit can be told about PROPORTIONS. Every other
// stage measures distance to the nearest surface, which says nothing about
// which part of the piece belongs on which part of the body — so a sleeve cut
// for a longer arm cannot be corrected by any of them. See warp.py.
//
// ---- The state machine ------------------------------------------------------
//
//   idle -> awaitingBase -> awaitingPiece -> idle
//
// Base first, deliberately: the body is the thing that does not move, so
// picking the destination before the thing being moved reads the same way as
// the sentence the pair expresses. Esc abandons a half-placed pair.
//
// ---- Space ------------------------------------------------------------------
//
// Both sides are stored in their OWN mesh's local space, pre-placement, so
// moving or rescaling either afterwards never invalidates a pair. Converting
// to the shared world space happens once, in assemblyFit.js, next to the code
// that bakes the same placement into the uploaded GLB — the payload and the
// geometry must not be able to disagree about which space they are in.
import { useCallback, useEffect, useState } from 'react'
import { createLandmarkPair } from '../utils/assemblyHelpers'

export const LANDMARK_MODES = { OFF: 'off', BASE: 'awaitingBase', PIECE: 'awaitingPiece' }

export default function useAssemblyLandmarks({ doc, base, selectedPiece, pickAt, patchPiece }) {
  const [mode, setMode] = useState(LANDMARK_MODES.OFF)
  const [pendingBase, setPendingBase] = useState(null)
  const [hoveredPairId, setHoveredPairId] = useState(null)

  // The piece the current run belongs to, so selecting a different piece
  // mid-pair cannot staple a body point onto the wrong garment. State rather
  // than a ref: the panel and the markers both render from it.
  const [targetPieceId, setTargetPieceId] = useState(null)

  // DERIVED, not synchronised. Whether placing is live depends on the mode, on
  // the target piece still existing, and on it still being the selected one —
  // all three of which are already state. An effect that watched them and
  // called stop() would be a cascading render for something that is just an
  // expression, and it would silently discard the mode when the user clicked
  // another piece to look at it. This way the run pauses and resumes instead.
  const targetAlive = !!targetPieceId && doc.pieces.some(piece => piece.id === targetPieceId)
  const active = mode !== LANDMARK_MODES.OFF && targetAlive
    && selectedPiece?.id === targetPieceId

  const stop = useCallback(() => {
    setMode(LANDMARK_MODES.OFF)
    setPendingBase(null)
    setTargetPieceId(null)
  }, [])

  const start = useCallback(() => {
    if (!base || !selectedPiece || selectedPiece.id === base.id) return
    setTargetPieceId(selectedPiece.id)
    setPendingBase(null)
    setMode(LANDMARK_MODES.BASE)
  }, [base, selectedPiece])

  // Esc abandons the pair in progress rather than the whole session: the common
  // mistake is a bad first click, and losing the pairs already placed to fix it
  // would be a much worse trade.
  useEffect(() => {
    if (!active) return undefined
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (pendingBase) {
        setPendingBase(null)
        setMode(LANDMARK_MODES.BASE)
      } else {
        stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, pendingBase, stop])

  /**
   * A click while placing. Returns true when it was consumed, so the page's
   * normal select-on-click does not also run.
   */
  const handlePointerDown = useCallback(event => {
    if (!active || event.button !== 0) return false
    const pieceId = targetPieceId
    const piece = doc.pieces.find(item => item.id === pieceId)
    if (!base || !piece) return false

    // Restricted to the side being asked for, so a stray click on a third piece
    // does nothing at all rather than silently recording a point on it.
    const wantBase = mode === LANDMARK_MODES.BASE
    const hit = pickAt(event.clientX, event.clientY, {
      candidates: [wantBase ? base.id : pieceId],
    })
    event.preventDefault()
    if (!hit) return true          // consumed: a miss must not deselect mid-run

    const landmark = {
      point: hit.localPoint.toArray(),
      // Left null: the point is authoritative and the index would only ever be
      // advisory, because Python snaps to its own nearest vertex anyway and a
      // piece re-saved in the Mesh Editor has different topology entirely. The
      // field exists in the document so a future snap-to-vertex toggle has
      // somewhere to write; nothing reads it today.
      vertexIndex: null,
    }

    if (wantBase) {
      setPendingBase(landmark)
      setMode(LANDMARK_MODES.PIECE)
      return true
    }

    patchPiece(pieceId, current => ({
      landmarks: [...(current.landmarks || []),
        { ...createLandmarkPair(), base: pendingBase, piece: landmark }],
    }))
    // Straight back to placing the next pair: the warp needs at least four, so
    // stopping after each one would mean re-arming the tool four times.
    setPendingBase(null)
    setMode(LANDMARK_MODES.BASE)
    return true
  }, [active, mode, base, doc, pickAt, pendingBase, patchPiece, targetPieceId])

  const removePair = useCallback((pieceId, pairId) => {
    patchPiece(pieceId, current => ({
      landmarks: (current.landmarks || []).filter(pair => pair.id !== pairId),
    }))
  }, [patchPiece])

  const clearPairs = useCallback(pieceId => {
    patchPiece(pieceId, { landmarks: [] })
  }, [patchPiece])

  return {
    mode,
    active,
    pendingBase,
    targetPieceId,
    hoveredPairId,
    setHoveredPairId,
    start,
    stop,
    handlePointerDown,
    removePair,
    clearPairs,
  }
}
