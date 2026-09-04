// Owns the Mesh Assembly document: loading, autosave, mutation and undo.
//
// The page below this hook never touches the document directly — it calls the
// mutators, which is what keeps AssemblyPage a shell instead of the next
// MeshEditorPage.jsx (12k lines, all state inline).
//
// Autosave follows BoardPage's proven shape (src/pages/BoardPage.jsx:186-265):
// a debounce timer, a signature guard so an idle canvas never writes, and a
// flush on unmount / pagehide / tab-hide. The one addition is that document
// writes send ONLY `state`, so a concurrent rename cannot be clobbered.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  assemblySignature,
  createEmptyAssembly,
  createPiece,
  normalizeAssembly,
  presetForMaterialClass,
} from '../utils/assemblyHelpers'
import {
  createAssembly as apiCreateAssembly,
  deleteAssembly as apiDeleteAssembly,
  getAssembly as apiGetAssembly,
  listAssemblies as apiListAssemblies,
  renameAssembly as apiRenameAssembly,
  saveAssemblyState as apiSaveAssemblyState,
} from '../utils/assemblyApi'

const AUTOSAVE_DELAY = 700

// Documents are small JSON (no geometry, by design), so snapshot undo costs
// almost nothing and needs no command objects.
const UNDO_LIMIT = 30

export default function useAssemblyDocument({ assemblyId, onAssemblyIdChange }) {
  const [assemblies, setAssemblies] = useState([])
  const [meta, setMeta] = useState(null)          // { id, name, thumbnailPath, ... }
  const [doc, setDoc] = useState(null)            // the normalized document
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveStatus, setSaveStatus] = useState('idle') // idle | saving | saved | error

  const bootstrappingRef = useRef(false)   // guards StrictMode's double effect run
  const saveTimerRef = useRef(null)
  const lastSavedSigRef = useRef('')
  const latestDocRef = useRef(null)        // newest document, for the debounced writer
  const assemblyIdRef = useRef(null)       // so an async save targets the right row
  const undoRef = useRef([])
  const redoRef = useRef([])
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 })

  // ---- Loading -------------------------------------------------------------

  const refreshAssemblies = useCallback(async () => {
    const list = await apiListAssemblies()
    setAssemblies(list)
    return list
  }, [])

  // List + bootstrap. Unlike BoardPage this is not scoped to a project, so the
  // very first visit on a fresh install is the empty case.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        let list = await apiListAssemblies()
        if (cancelled) return

        if (!assemblyId) {
          if (list.length === 0) {
            if (bootstrappingRef.current) return
            bootstrappingRef.current = true
            const created = await apiCreateAssembly('Assembly 1')
            list = [created]
          }
          if (cancelled) return
          setAssemblies(list)
          onAssemblyIdChange?.(String(list[0].id))
          return
        }

        setAssemblies(list)
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load assemblies')
      }
    })()

    return () => { cancelled = true }
  }, [assemblyId, onAssemblyIdChange])

  // The selected document.
  useEffect(() => {
    let cancelled = false

    // Nothing selected — which happens after deleting the last assembly. The
    // document has to be cleared, or the page keeps rendering the piece list
    // of the assembly that was just deleted.
    if (!assemblyId) {
      assemblyIdRef.current = null
      latestDocRef.current = null
      lastSavedSigRef.current = ''
      undoRef.current = []
      redoRef.current = []
      setHistoryDepth({ undo: 0, redo: 0 })
      setMeta(null)
      setDoc(null)
      setLoading(false)
      return undefined
    }

    setLoading(true)
    setLoadError('')
    setSaveStatus('idle')
    assemblyIdRef.current = assemblyId
    undoRef.current = []
    redoRef.current = []
    setHistoryDepth({ undo: 0, redo: 0 })

    ;(async () => {
      try {
        const loaded = await apiGetAssembly(assemblyId)
        if (cancelled) return
        const normalized = normalizeAssembly(loaded?.state)
        setMeta(loaded)
        setDoc(normalized)
        latestDocRef.current = normalized
        // Seed the guard with what the server already has, so simply opening an
        // assembly never triggers a write. normalizeAssembly is not a no-op
        // (it elects a base, drops stale selection), so the signature is taken
        // from the NORMALIZED form — otherwise every open would look dirty.
        lastSavedSigRef.current = assemblySignature(normalized)
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Failed to load the assembly')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [assemblyId])

  // ---- Saving --------------------------------------------------------------

  const persistNow = useCallback(async () => {
    const targetId = assemblyIdRef.current
    const pending = latestDocRef.current
    if (!targetId || !pending) return

    setSaveStatus('saving')
    try {
      await apiSaveAssemblyState(targetId, pending)
      setSaveStatus('saved')
    } catch (err) {
      console.error('Failed to save the assembly', err)
      setSaveStatus('error')
    }
  }, [])

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { saveTimerRef.current = null; persistNow() }, AUTOSAVE_DELAY)
  }, [persistNow])

  const flushSave = useCallback(() => {
    if (!saveTimerRef.current) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    persistNow()
  }, [persistNow])

  // Flush a pending write on unmount and on assembly switch, or the last edit
  // before navigating away is lost.
  useEffect(() => () => { flushSave() }, [flushSave])

  useEffect(() => {
    window.addEventListener('pagehide', flushSave)
    document.addEventListener('visibilitychange', flushSave)
    return () => {
      window.removeEventListener('pagehide', flushSave)
      document.removeEventListener('visibilitychange', flushSave)
    }
  }, [flushSave])

  // ---- Mutation ------------------------------------------------------------

  // The single write path. `mutate` gets a structural clone and returns the
  // next document (or null to abort, which is how a no-op mutator avoids
  // dirtying the autosave).
  //
  // `history: false` is for continuous gestures — a gizmo drag writes on every
  // frame, and one undo entry per frame would bury the previous state 60 deep.
  // The drag commits once, with history, on mouse-up.
  const applyChange = useCallback((mutate, { history = true } = {}) => {
    // Everything here runs OUTSIDE setDoc, against latestDocRef. React
    // double-invokes state updaters in StrictMode, so a `setDoc(cur => ...)`
    // that pushed an undo entry or ran a mutator with side effects would do it
    // twice — undo would end up two deep for one edit. Computing the next
    // document first and handing setDoc a plain value keeps that impossible.
    const current = latestDocRef.current
    if (!current) return

    const draft = structuredClone(current)
    const next = mutate(draft)
    if (!next) return

    const sig = assemblySignature(next)
    if (sig === lastSavedSigRef.current) return

    if (history) {
      undoRef.current.push(current)
      if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
      redoRef.current = []
    }

    lastSavedSigRef.current = sig
    latestDocRef.current = next
    setHistoryDepth({ undo: undoRef.current.length, redo: redoRef.current.length })
    setDoc(next)
    scheduleSave()
  }, [scheduleSave])

  const restore = useCallback((from, to) => {
    const current = latestDocRef.current
    if (!current || !from.current.length) return
    const previous = from.current.pop()

    to.current.push(current)
    if (to.current.length > UNDO_LIMIT) to.current.shift()

    lastSavedSigRef.current = assemblySignature(previous)
    latestDocRef.current = previous
    setHistoryDepth({ undo: undoRef.current.length, redo: redoRef.current.length })
    setDoc(previous)
    scheduleSave()
  }, [scheduleSave])

  const undo = useCallback(() => restore(undoRef, redoRef), [restore])
  const redo = useCallback(() => restore(redoRef, undoRef), [restore])

  const patchPiece = useCallback((pieceId, patch, options) => {
    applyChange(draft => {
      const piece = draft.pieces.find(p => p.id === pieceId)
      if (!piece) return null
      Object.assign(piece, typeof patch === 'function' ? patch(piece) : patch)
      return draft
    }, options)
  }, [applyChange])

  // Adding the first mesh makes it the base: an assembly with garments and no
  // body has nothing to fit against.
  const addPieces = useCallback(assets => {
    const list = Array.isArray(assets) ? assets : [assets]
    if (!list.length) return
    applyChange(draft => {
      for (const asset of list) {
        const isFirst = draft.pieces.length === 0
        const piece = createPiece(asset, { role: isFirst ? 'base' : 'piece' })
        draft.pieces.push(piece)
        if (isFirst) draft.basePieceId = piece.id
      }
      draft.settings.selectedPieceId = draft.pieces[draft.pieces.length - 1].id
      return draft
    })
  }, [applyChange])

  const removePiece = useCallback(pieceId => {
    applyChange(draft => {
      const index = draft.pieces.findIndex(p => p.id === pieceId)
      if (index === -1) return null
      draft.pieces.splice(index, 1)

      // Removing the base promotes the next piece rather than leaving the
      // assembly baseless, which every consumer would have to special-case.
      if (draft.basePieceId === pieceId) {
        draft.basePieceId = draft.pieces[0]?.id || null
        for (const piece of draft.pieces) piece.role = piece.id === draft.basePieceId ? 'base' : 'piece'
      }
      if (draft.settings.selectedPieceId === pieceId) draft.settings.selectedPieceId = null
      if (draft.settings.isolatedPieceId === pieceId) draft.settings.isolatedPieceId = null
      return draft
    })
  }, [applyChange])

  // Clone a piece, optionally reflected across the base. `patch` carries the
  // mirror transform (computed by the caller, which has the base's bounds).
  //
  // The clone gets a fresh id and drops everything that described the ORIGINAL's
  // relationship to the base: landmark pairs were picked for that placement, and
  // a fit result and its saved version belong to the piece that produced them.
  // Carrying either over would silently attribute one piece's work to another.
  const duplicatePiece = useCallback((pieceId, patch = {}) => {
    applyChange(draft => {
      const index = draft.pieces.findIndex(p => p.id === pieceId)
      if (index === -1) return null
      const source = draft.pieces[index]
      const clone = {
        ...structuredClone(source),
        id: `${source.id}-copy-${Date.now().toString(36)}`,
        name: `${source.name} copy`,
        role: 'piece',
        landmarks: [],
        fit: { status: 'idle', message: '', stats: {}, fittedAt: null },
        fittedVersionAssetId: null,
        ...patch,
      }
      draft.pieces.splice(index + 1, 0, clone)
      draft.settings.selectedPieceId = clone.id
      return draft
    })
  }, [applyChange])

  const setBase = useCallback(pieceId => {
    applyChange(draft => {
      if (!draft.pieces.some(p => p.id === pieceId)) return null
      draft.basePieceId = pieceId
      for (const piece of draft.pieces) piece.role = piece.id === pieceId ? 'base' : 'piece'
      return draft
    })
  }, [applyChange])

  const reorderPieces = useCallback((fromIndex, toIndex) => {
    applyChange(draft => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 || fromIndex >= draft.pieces.length ||
        toIndex < 0 || toIndex >= draft.pieces.length
      ) return null
      const [moved] = draft.pieces.splice(fromIndex, 1)
      draft.pieces.splice(toIndex, 0, moved)
      return draft
    })
  }, [applyChange])

  const patchSettings = useCallback((patch, options) => {
    applyChange(draft => {
      Object.assign(draft.settings, typeof patch === 'function' ? patch(draft.settings) : patch)
      return draft
    }, options)
  }, [applyChange])

  // Choosing a class REPLACES the stage flags and knobs; that is the whole
  // point of a preset. 'custom' keeps whatever is there — it is the state a
  // piece lands in after the user edits one knob by hand.
  const setMaterialClass = useCallback((pieceId, materialClass) => {
    applyChange(draft => {
      const piece = draft.pieces.find(p => p.id === pieceId)
      if (!piece) return null
      piece.materialClass = materialClass
      if (materialClass !== 'custom') {
        const preset = presetForMaterialClass(materialClass)
        piece.fitStages = { ...preset.stages }
        piece.fitOptions = { ...preset.options }
      }
      return draft
    })
  }, [applyChange])

  // ---- Assembly-level operations (not document edits) ----------------------

  const createNewAssembly = useCallback(async name => {
    flushSave()
    const created = await apiCreateAssembly(name || `Assembly ${assemblies.length + 1}`)
    await refreshAssemblies()
    onAssemblyIdChange?.(String(created.id))
    return created
  }, [assemblies.length, flushSave, refreshAssemblies, onAssemblyIdChange])

  const renameCurrentAssembly = useCallback(async name => {
    if (!assemblyIdRef.current) return
    const updated = await apiRenameAssembly(assemblyIdRef.current, name)
    setMeta(current => (current ? { ...current, name: updated.name } : current))
    await refreshAssemblies()
  }, [refreshAssemblies])

  const deleteCurrentAssembly = useCallback(async () => {
    const targetId = assemblyIdRef.current
    if (!targetId) return
    // Drop any pending write first: persisting to a row that is about to be
    // deleted is at best wasted, and at worst races the delete.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await apiDeleteAssembly(targetId)
    const list = await refreshAssemblies()
    const remaining = list.filter(a => String(a.id) !== String(targetId))
    onAssemblyIdChange?.(remaining.length ? String(remaining[0].id) : null)
  }, [refreshAssemblies, onAssemblyIdChange])

  const selectAssembly = useCallback(id => {
    flushSave()
    onAssemblyIdChange?.(id ? String(id) : null)
  }, [flushSave, onAssemblyIdChange])

  return useMemo(() => ({
    assemblies,
    meta,
    doc: doc || createEmptyAssembly(),
    ready: !!doc,
    loading,
    loadError,
    saveStatus,
    canUndo: historyDepth.undo > 0,
    canRedo: historyDepth.redo > 0,

    patchPiece,
    addPieces,
    duplicatePiece,
    removePiece,
    setBase,
    reorderPieces,
    patchSettings,
    setMaterialClass,
    undo,
    redo,

    createNewAssembly,
    renameCurrentAssembly,
    deleteCurrentAssembly,
    selectAssembly,
    refreshAssemblies,
    flushSave,
  }), [
    assemblies, meta, doc, loading, loadError, saveStatus, historyDepth,
    patchPiece, addPieces, duplicatePiece, removePiece, setBase, reorderPieces, patchSettings,
    setMaterialClass, undo, redo, createNewAssembly, renameCurrentAssembly,
    deleteCurrentAssembly, selectAssembly, refreshAssemblies, flushSave,
  ])
}
