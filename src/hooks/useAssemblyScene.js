// Owns the LOADED MESHES for an assembly — one entry per document piece.
//
// The entry map is React STATE, replaced (not mutated) whenever a piece loads or
// goes away. The heavy things inside it — THREE.Object3D graphs, their
// BufferGeometries and textures — keep stable identity across those swaps, which
// is what makes this safe: R3F reconciles `<primitive object={...}>` on object
// identity, so re-rendering with the same Object3D does NOT remount it or
// re-upload its GPU buffers.
//
// An earlier version kept the map in a ref and forced renders with a counter.
// That worked but read the ref during render, which makes what gets drawn depend
// on mutation timing React cannot see. State is both correct and simpler.
//
// The one ref that remains, `entriesRef`, is a mirror used ONLY by imperative
// code: the unmount disposal (which must see the latest map without
// re-subscribing) and picking (a pointer callback, not render).
//
// Where these live also makes WebGL context loss survivable: the entries belong
// to the page, not to the Canvas, so a `key={contextRevision}` remount re-mounts
// the SAME Object3Ds under the new renderer. The GPU buffers went with the
// context, but the BufferAttribute arrays and texture images are still in JS
// memory, so three re-uploads them on the next render.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { buildAssetUrl } from '../utils/meshTexturing'
import {
  disposeAssemblyEntry,
  loadAssemblyPieceRoot,
  pieceWorldBox,
  unionBox,
} from '../utils/assemblyGeometry'

export default function useAssemblyScene(doc) {
  const [entries, setEntries] = useState(() => new Map())  // pieceId -> Entry
  const [loadErrors, setLoadErrors] = useState({})         // pieceId -> message

  const loadingRef = useRef(new Set())   // pieceIds with a load in flight
  const cancelledRef = useRef(false)     // set on unmount
  const entriesRef = useRef(entries)     // mirror, for imperative use only
  const docRef = useRef(doc)             // ditto, for async callbacks

  // Mirrors updated in an effect rather than assigned during render: a render is
  // allowed to be discarded or replayed, so writing refs there makes what the
  // async callbacks below observe depend on renders that may never have
  // committed. Declared FIRST so it runs before the reconcile effect, which
  // reads both mirrors.
  useEffect(() => {
    entriesRef.current = entries
    docRef.current = doc
  }, [entries, doc])

  // What the entry map is reconciled against: which piece points at which mesh
  // FILE, and nothing else. Deliberately excludes placement — `doc` changes on
  // every frame of a gizmo drag, and depending on it would re-run the reconcile
  // sixty times a second.
  const pieceSourceKey = JSON.stringify(
    (doc?.pieces || []).map(piece => [piece.id, piece.assetId === null ? '' : buildAssetUrl(piece)])
  )

  // Reconcile: load what is new, drop what is gone, reload a piece whose asset
  // was swapped underneath it.
  useEffect(() => {
    const wanted = new Map()
    for (const piece of docRef.current?.pieces || []) {
      if (piece.assetId === null) continue        // missing asset: nothing to load
      const url = buildAssetUrl(piece)
      if (url) wanted.set(piece.id, url)
    }

    // Work out what survives ONCE, here, and use that single answer for both the
    // teardown and the skip-check below.
    //
    // Reading the ref mirror for the skip-check instead would be wrong: the
    // mirror is only refreshed on the next commit, so a piece whose asset was
    // re-pointed would still appear present under its OLD url, the load would be
    // skipped, and the piece would silently vanish from the scene.
    const surviving = new Map()
    const stale = []
    for (const [pieceId, entry] of entriesRef.current) {
      if (wanted.get(pieceId) === entry.url) surviving.set(pieceId, entry)
      else stale.push(entry)
    }

    // Disposal happens out here, not inside the setEntries updater: React
    // double-invokes updaters in StrictMode, and a side effect in one runs twice.
    // (disposeAssemblyEntry is idempotent, but relying on that is a trap for the
    // next person to add something to it.)
    if (stale.length) {
      for (const entry of stale) disposeAssemblyEntry(entry)
      setEntries(surviving)
    }

    for (const [pieceId, url] of wanted) {
      if (surviving.has(pieceId) || loadingRef.current.has(pieceId)) continue
      loadingRef.current.add(pieceId)

      loadAssemblyPieceRoot(url)
        .then(loaded => {
          // Landing after unmount, or after the piece was removed / re-pointed,
          // means nothing will ever render this graph. Dispose it here rather
          // than storing it, or it leaks silently.
          const piece = (docRef.current?.pieces || []).find(p => p.id === pieceId)
          if (cancelledRef.current || !piece || buildAssetUrl(piece) !== url) {
            disposeAssemblyEntry(loaded)
            return
          }
          setEntries(previous => {
            const next = new Map(previous)
            next.set(pieceId, { pieceId, url, bvhBuilt: false, ...loaded })
            return next
          })
          setLoadErrors(previous => {
            if (!previous[pieceId]) return previous
            const next = { ...previous }
            delete next[pieceId]
            return next
          })
        })
        .catch(error => {
          if (cancelledRef.current) return
          console.error(`Failed to load assembly piece ${pieceId}`, error)
          setLoadErrors(previous => ({ ...previous, [pieceId]: error.message || 'Failed to load' }))
        })
        .finally(() => loadingRef.current.delete(pieceId))
    }
  }, [pieceSourceKey])

  // Dispose everything on unmount. Must exist — otherwise leaving the page
  // strands every loaded mesh and all its textures on the GPU.
  useEffect(() => {
    cancelledRef.current = false
    const mirror = entriesRef
    return () => {
      cancelledRef.current = true
      for (const entry of mirror.current.values()) disposeAssemblyEntry(entry)
    }
  }, [])

  const getEntry = useCallback(pieceId => entries.get(pieceId) || null, [entries])

  /** World-space box over the given pieces, for those that are loaded. */
  const getVisibleBounds = useCallback(visiblePieces => {
    const boxes = []
    for (const piece of visiblePieces) {
      const entry = entries.get(piece.id)
      if (entry) boxes.push(pieceWorldBox(entry, piece, new THREE.Box3()))
    }
    return unionBox(boxes)
  }, [entries])

  /** Ids of the pieces that are actually loaded, in document order. */
  const loadedPieceIds = useMemo(
    () => (doc?.pieces || []).filter(piece => entries.has(piece.id)).map(piece => piece.id),
    [doc, entries],
  )

  return {
    entries,
    entriesRef,
    loadErrors,
    loadedPieceIds,
    getEntry,
    getVisibleBounds,
  }
}
