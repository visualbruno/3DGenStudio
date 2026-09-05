// Runs the fit for the assembly's pieces and holds the previews.
//
// SEQUENTIAL, deliberately. The Python service is one process, so parallel
// calls contend for the same GPU; five concurrent SSE streams cannot be
// reported honestly; and ensureDesktopService('meshtools') has to finish once
// before anything starts. A queue is also the only thing that makes
// cancellation meaningful.
//
// The fit NEVER mutates the loaded piece. A result becomes a preview held here,
// and the viewport decides which of the two to draw — which is what makes
// revert free: drop the preview. Nothing is written to an asset until the user
// explicitly saves (Phase 4).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildFitPayloadGeometry,
  buildFitPreview,
  createPreviewFromPiece,
  disposeFitPreview,
  fitPiece,
  payloadToGlb,
} from '../utils/assemblyFit'

export default function useAssemblyFitRun({ doc, getEntry, patchPiece, onPreviewReplaced }) {
  const previewsRef = useRef(new Map())        // pieceId -> preview entry
  const [previews, setPreviews] = useState(new Map())
  const [showFitted, setShowFitted] = useState(new Set())
  const [running, setRunning] = useState(null)  // { pieceId, index, total } | null
  const [progress, setProgress] = useState({ frac: 0, message: '' })
  const [error, setError] = useState('')

  const cancelRef = useRef(false)
  const abortRef = useRef(null)
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false
    const store = previewsRef
    return () => {
      unmountedRef.current = true
      abortRef.current?.abort()
      for (const preview of store.current.values()) disposeFitPreview(preview)
      store.current.clear()
    }
  }, [])

  const publish = useCallback(() => {
    setPreviews(new Map(previewsRef.current))
  }, [])

  const dropPreview = useCallback(pieceId => {
    const preview = previewsRef.current.get(pieceId)
    if (!preview) return
    // Tell anything holding references (sculpt undo) before the buffers go.
    onPreviewReplaced?.(preview)
    disposeFitPreview(preview)
    previewsRef.current.delete(pieceId)
    publish()
    setShowFitted(previous => {
      if (!previous.has(pieceId)) return previous
      const next = new Set(previous)
      next.delete(pieceId)
      return next
    })
  }, [publish, onPreviewReplaced])

  /** Revert one piece to how the user aligned it. Free — the fit never mutated it. */
  const revert = useCallback(pieceId => {
    dropPreview(pieceId)
    patchPiece(pieceId, { fit: { status: 'idle', message: '', stats: {}, fittedAt: null } })
  }, [dropPreview, patchPiece])

  const toggleFitted = useCallback((pieceId, next) => {
    setShowFitted(previous => {
      const set = new Set(previous)
      const wanted = next === undefined ? !set.has(pieceId) : next
      if (wanted) set.add(pieceId)
      else set.delete(pieceId)
      return set
    })
  }, [])

  const cancel = useCallback(() => {
    cancelRef.current = true
    abortRef.current?.abort()
  }, [])

  /**
   * Fit `pieceIds` against the base, one after another.
   *
   * The base's payload is built ONCE: it is the same mesh for every piece, and
   * exporting a 200k-vertex body per piece would dominate the runtime.
   */
  const run = useCallback(async pieceIds => {
    const base = doc.pieces.find(piece => piece.id === doc.basePieceId)
    const baseEntry = base ? getEntry(base.id) : null
    if (!base || !baseEntry) {
      setError('The base mesh has not loaded yet.')
      return
    }

    const targets = pieceIds
      .map(id => ({ piece: doc.pieces.find(p => p.id === id), entry: getEntry(id) }))
      .filter(target => target.piece && target.entry && target.piece.id !== base.id)

    if (!targets.length) {
      setError('Nothing to fit — add a piece other than the base.')
      return
    }

    cancelRef.current = false
    setError('')

    let baseFile
    try {
      baseFile = await payloadToGlb(buildFitPayloadGeometry(baseEntry, base), 'base')
    } catch (err) {
      setError(err.message || 'Could not prepare the base mesh.')
      return
    }

    for (let index = 0; index < targets.length; index += 1) {
      if (cancelRef.current || unmountedRef.current) break
      const { piece, entry } = targets[index]

      setRunning({ pieceId: piece.id, index, total: targets.length })
      setProgress({ frac: 0, message: 'Starting…' })
      patchPiece(piece.id, {
        fit: { status: 'running', message: '', stats: {}, fittedAt: null },
      }, { history: false })

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const payload = buildFitPayloadGeometry(entry, piece)
        const pieceFile = await payloadToGlb(payload, 'piece')

        const { positions, stats } = await fitPiece({
          pieceFile,
          baseFile,
          options: { stages: activeStages(piece), ...piece.fitOptions },
          signal: controller.signal,
          onProgress: event => setProgress({
            frac: event.frac ?? 0,
            message: event.message || '',
          }),
        })
        if (unmountedRef.current) break

        // Replace rather than accumulate: a re-fit of the same piece must not
        // strand the previous preview's geometry on the GPU.
        const existing = previewsRef.current.get(piece.id)
        if (existing) {
          onPreviewReplaced?.(existing)
          disposeFitPreview(existing)
        }

        previewsRef.current.set(piece.id, { ...buildFitPreview(payload, positions), pieceId: piece.id })
        publish()
        setShowFitted(previous => new Set(previous).add(piece.id))

        patchPiece(piece.id, {
          fit: {
            status: 'ready',
            message: describeResult(stats),
            stats: summarizeStats(stats),
            fittedAt: Date.now(),
          },
        }, { history: false })
      } catch (err) {
        if (unmountedRef.current) break
        const aborted = err.name === 'AbortError' || cancelRef.current
        patchPiece(piece.id, {
          fit: {
            status: aborted ? 'idle' : 'error',
            message: aborted ? '' : (err.message || 'Fit failed'),
            stats: {},
            fittedAt: null,
          },
        }, { history: false })
        if (!aborted) setError(`${piece.name}: ${err.message || 'Fit failed'}`)
      } finally {
        abortRef.current = null
      }
    }

    if (!unmountedRef.current) {
      setRunning(null)
      setProgress({ frac: 0, message: '' })
    }
  }, [doc, getEntry, patchPiece, publish, onPreviewReplaced])

  /**
   * The piece's editable preview, created from its current placement if it has
   * never been fitted. Sculpting calls this so it always has something of its
   * own to modify rather than touching the loaded asset.
   */
  const ensurePreview = useCallback(pieceId => {
    const existing = previewsRef.current.get(pieceId)
    if (existing) return existing
    const piece = doc.pieces.find(p => p.id === pieceId)
    const entry = getEntry(pieceId)
    if (!piece || !entry) return null
    const preview = { ...createPreviewFromPiece(entry, piece), pieceId }
    previewsRef.current.set(pieceId, preview)
    publish()
    setShowFitted(previous => new Set(previous).add(pieceId))
    return preview
  }, [doc, getEntry, publish])

  return {
    previews,
    showFitted,
    ensurePreview,
    running,
    progress,
    error,
    clearError: useCallback(() => setError(''), []),
    run,
    cancel,
    revert,
    dropPreview,
    toggleFitted,
  }
}

// Which stages the piece's material class turns on, in pipeline order.
function activeStages(piece) {
  const stages = []
  if (piece.fitStages?.shrinkwrap) stages.push('shrinkwrap')
  if (piece.fitStages?.penetration) stages.push('penetration')
  return stages
}

// Only the numbers worth persisting. The full stats dict includes per-stage
// timings and iteration counts, which are debugging detail, not document state.
function summarizeStats(stats) {
  return {
    penetratingBefore: stats.penetrating_before ?? null,
    penetratingAfter: stats.penetrating_after ?? null,
    maxDepthBefore: stats.max_depth_before ?? null,
    maxDepthAfter: stats.max_depth_after ?? null,
    flippedFaces: stats.flipped_faces ?? null,
    faceCount: stats.piece_faces ?? null,
    bodyWatertight: stats.body_watertight ?? null,
    converged: stats.converged ?? null,
    stoppedOnInversion: stats.stopped_on_inversion ?? false,
    surfacesTouching: stats.surfaces_touching ?? false,
    reshaped: !!stats.stages?.shrinkwrap,
  }
}

// The one-line verdict. Flipped faces come first when there are any: that is
// the number that says the result may be unusable, and it should not be buried
// behind a reassuring penetration count.
function describeResult(stats) {
  const flipped = stats.flipped_faces ?? 0
  const faces = stats.piece_faces ?? 0
  if (flipped > 0 && faces > 0 && flipped / faces > 0.01) {
    return `${flipped} of ${faces} faces inverted — check the result`
  }
  const before = stats.penetrating_before ?? 0
  const after = stats.penetrating_after ?? 0

  if (before === 0 && after === 0) {
    // The common confusion: a piece sitting AROUND the body has nothing inside
    // it, so the push has nothing to do and the button looks broken. Say what
    // to reach for instead of just reporting a zero.
    return stats.stages?.shrinkwrap
      ? 'Reshaped — nothing was clipping'
      : 'Nothing was inside the body, so nothing moved. Turn on "Reshape to the body" to make the piece follow its shape.'
  }
  return `Clipping ${before} → ${after} vertices`
}
