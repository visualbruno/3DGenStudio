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
// revert free: drop the preview. Nothing is written to an ASSET until the user
// explicitly saves.
//
// A preview is not lost on navigation, though. It is mirrored to disk as
// working geometry (src/utils/assemblyWorking.js) and restored when the
// assembly is reopened — the alternative was silently throwing away a fit and a
// sculpting session because the user clicked Assets. That mirror is scratch
// state belonging to the assembly, not an Asset: Revert still deletes it, and
// saving a version is still the separate, explicit step.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildFitPayloadGeometry,
  buildFitPreview,
  buildFitRanges,
  createPreviewFromPiece,
  disposeFitPreview,
  fitPiece,
  payloadToGlb,
} from '../utils/assemblyFit'
import {
  decodeWorkingGeometry,
  deleteWorkingGeometry,
  encodeWorkingGeometry,
  fetchWorkingGeometry,
  listWorkingGeometry,
  putWorkingGeometry,
} from '../utils/assemblyWorking'
import { buildAssetUrl } from '../utils/meshTexturing'

// Long enough that a burst of brush strokes writes once, short enough that
// clicking away straight after a stroke still catches it. The unmount flush
// below is what makes the exact number uncritical.
const PERSIST_DELAY = 900

export default function useAssemblyFitRun({
  assemblyId, doc, entries, getEntry, patchPiece, onPreviewReplaced,
}) {
  const previewsRef = useRef(new Map())        // pieceId -> preview entry
  const [previews, setPreviews] = useState(new Map())
  const [showFitted, setShowFitted] = useState(new Set())
  const [running, setRunning] = useState(null)  // { pieceId, index, total } | null
  const [progress, setProgress] = useState({ frac: 0, message: '' })
  const [error, setError] = useState('')

  const cancelRef = useRef(false)
  const abortRef = useRef(null)
  const unmountedRef = useRef(false)

  // Persistence bookkeeping. Refs throughout: none of it renders, and the
  // debounce has to survive the re-renders a stroke causes.
  const persistTimersRef = useRef(new Map())     // pieceId -> timeout
  const flushPersistRef = useRef(null)           // set in an effect, read on unmount
  const restoredRef = useRef(new Set())          // pieces already attempted this assembly
  const storedRef = useRef(new Set())            // pieces the server has a file for
  const listedRef = useRef(false)                // has the listing been fetched?
  // Mirrors of the current props, so the debounced writers and the unmount
  // flush read what is true NOW rather than whatever was captured when the
  // timer was set. Assigned in an effect: writing a ref during render is what
  // makes a Strict-Mode double render commit twice.
  const docRef = useRef(doc)
  const assemblyIdRef = useRef(assemblyId)
  useEffect(() => { docRef.current = doc }, [doc])
  useEffect(() => { assemblyIdRef.current = assemblyId }, [assemblyId])

  useEffect(() => {
    unmountedRef.current = false
    const store = previewsRef
    const timers = persistTimersRef
    return () => {
      unmountedRef.current = true
      abortRef.current?.abort()
      // Anything still debounced is written NOW, before the geometry it reads
      // is disposed two lines down. This is the case the whole feature exists
      // for: the user sculpts and immediately navigates away.
      for (const [pieceId, timer] of timers.current) {
        clearTimeout(timer)
        flushPersistRef.current?.(pieceId)
      }
      timers.current.clear()
      for (const preview of store.current.values()) disposeFitPreview(preview)
      store.current.clear()
    }
  }, [])

  // A different assembly has a different set of files and a different set of
  // pieces, so every per-assembly conclusion has to be dropped. Without this,
  // opening a second assembly would decide it had already tried each piece.
  useEffect(() => {
    listedRef.current = false
    storedRef.current = new Set()
    restoredRef.current = new Set()
  }, [assemblyId])

  const publish = useCallback(() => {
    setPreviews(new Map(previewsRef.current))
  }, [])

  /** Mirror one piece's current preview to disk. Never throws at the caller. */
  const persistNow = useCallback(async pieceId => {
    const id = assemblyIdRef.current
    const preview = previewsRef.current.get(pieceId)
    const piece = docRef.current?.pieces?.find(p => p.id === pieceId)
    if (!id || !preview?.meshes?.length || !piece) return
    try {
      const buffer = encodeWorkingGeometry({
        sourceUrl: buildAssetUrl(piece),
        meshes: preview.meshes,
      })
      if (!buffer) return
      await putWorkingGeometry(id, pieceId, buffer)
      storedRef.current.add(pieceId)
    } catch (err) {
      // A failed mirror costs the user nothing right now — the preview is still
      // on screen. Shouting about it mid-stroke would be worse than the loss it
      // warns of, so it is logged and the next stroke tries again.
      console.warn('Could not store the fitted geometry for this piece', err)
    }
  }, [])

  // Held in a ref because the unmount cleanup is declared above persistNow and
  // must not close over a stale one. Assigned in an effect, never during render.
  useEffect(() => { flushPersistRef.current = persistNow }, [persistNow])

  /** Debounced: a brush stroke fires this on every mouse-up. */
  const persistPiece = useCallback(pieceId => {
    const timers = persistTimersRef.current
    clearTimeout(timers.get(pieceId))
    timers.set(pieceId, setTimeout(() => {
      timers.delete(pieceId)
      persistNow(pieceId)
    }, PERSIST_DELAY))
  }, [persistNow])

  const dropPreview = useCallback(pieceId => {
    const preview = previewsRef.current.get(pieceId)
    if (!preview) return
    // Tell anything holding references (sculpt undo) before the buffers go.
    onPreviewReplaced?.(preview)
    disposeFitPreview(preview)
    previewsRef.current.delete(pieceId)

    // The stored copy goes with it, and any write still queued is cancelled —
    // otherwise a debounced stroke would land a moment later and resurrect the
    // fit the user just reverted.
    clearTimeout(persistTimersRef.current.get(pieceId))
    persistTimersRef.current.delete(pieceId)
    restoredRef.current.add(pieceId)
    if (storedRef.current.delete(pieceId) && assemblyIdRef.current) {
      deleteWorkingGeometry(assemblyIdRef.current, pieceId)
    }

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
        // Straight away, not debounced: a fit is minutes of work and the user
        // may well click away the moment they see the result.
        persistNow(piece.id)

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
  }, [doc, getEntry, patchPiece, publish, onPreviewReplaced, persistNow])

  // ---- Restoring a stored fit ----------------------------------------------
  //
  // Runs as pieces finish loading, because rebuilding a preview needs the
  // source asset's geometry: the file holds positions only, and the UVs,
  // materials and topology come from the asset. Anything that no longer lines
  // up is discarded rather than pasted on (see decodeWorkingGeometry) — a
  // re-pointed asset is exactly the case that produces a mismatch.
  useEffect(() => {
    if (!assemblyId) return undefined
    let cancelled = false

    ;(async () => {
      let stored = storedRef.current
      if (!listedRef.current) {
        listedRef.current = true
        try {
          stored = new Set(await listWorkingGeometry(assemblyId))
          storedRef.current = stored
        } catch {
          return
        }
      }
      if (cancelled || !stored.size) return

      for (const piece of doc.pieces) {
        if (cancelled) break
        if (!stored.has(piece.id)) continue
        if (restoredRef.current.has(piece.id)) continue
        if (previewsRef.current.has(piece.id)) continue
        const entry = entries.get(piece.id)
        if (!entry?.meshes?.length) continue          // not loaded yet; a later pass gets it

        restoredRef.current.add(piece.id)
        try {
          const buffer = await fetchWorkingGeometry(assemblyId, piece.id)
          if (cancelled || !buffer) continue
          const { ranges, vertexCount } = buildFitRanges(entry)
          const decoded = decodeWorkingGeometry(buffer, {
            sourceUrl: buildAssetUrl(piece),
            vertexCount,
          })
          if (!decoded) {
            // Stale against the asset it claims to belong to. Removing it stops
            // the same rejected file being fetched on every future open.
            storedRef.current.delete(piece.id)
            deleteWorkingGeometry(assemblyId, piece.id)
            continue
          }
          if (cancelled || previewsRef.current.has(piece.id)) continue

          previewsRef.current.set(piece.id, {
            ...buildFitPreview({ ranges }, decoded.positions),
            pieceId: piece.id,
          })
          publish()
          setShowFitted(previous => new Set(previous).add(piece.id))
        } catch (err) {
          console.warn(`Could not restore the stored fit for ${piece.name}`, err)
        }
      }
    })()

    return () => { cancelled = true }
  }, [assemblyId, doc, entries, publish])

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
    // Called by the sculpt brush on mouse-up: the stroke writes into the
    // preview's geometry directly, so this hook cannot see it any other way.
    persistPiece,
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
