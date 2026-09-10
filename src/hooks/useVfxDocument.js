// Loading, saving and draft recovery for one VFX effect.
//
// LOCAL DRAFT PLUS AN EXPLICIT SAVE - deliberately not a debounced server
// autosave like the Brainstorming Board's. Three reasons, and the third is the
// one that decides it:
//
//   - every server save is a full multipart file replace PLUS a WebGL
//     thumbnail render. On a two-second debounce that is a PNG render and two
//     round trips per slider drag.
//   - replaceAssetFileById has no optimistic-concurrency check, so two tabs
//     autosaving is a silent last-write-wins.
//   - the one thing in this repo that DOES autosave, Mesh Assembly, earned it
//     by having a partial-update route: updateMeshAssembly writes only the
//     fields present, with a comment saying "an autosave in flight can never
//     clobber a rename". VFX has no such route, and adding one means a new
//     top-level prefix and a serverMode.js classification entry.
//
// So the draft goes to localStorage on a short debounce and the author presses
// Save. Nothing is lost to a crash or a stray navigation, and nothing is
// written to the library the author did not ask for.
//
// THE LOAD-ONCE GUARD HAS NO CANCELLATION FLAG, and that is not an oversight.
// TreeGenPage.jsx:391 records the bug: combining a cleanup flag with a
// run-once ref meant StrictMode's mount -> cleanup -> re-mount cancelled the
// first fetch while the second self-skipped, so the document silently never
// loaded and the page showed a default that looked like a successful load. The
// ref alone is correct.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createEmptyVfxDoc, normalizeVfxDoc, vfxSignature } from '../../vfx/doc.js'
import { loadVfxAsset, saveVfxAsset, vfxAssetId } from '../utils/vfxApi.js'
import useVfxHistory from './useVfxHistory.js'

const DRAFT_PREFIX = 'vfx:draft:'
const DRAFT_DEBOUNCE_MS = 1000

const draftKey = assetId => `${DRAFT_PREFIX}${assetId ?? 'new'}`

// localStorage throws in a few real contexts - a private window, site data
// blocked, a thumbnail capture - so every access is guarded and a failure
// degrades to "no draft" rather than taking the editor down.
function readDraft(key) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.doc) return null
    return { doc: parsed.doc, savedAt: parsed.savedAt || 0, name: parsed.name || '' }
  } catch {
    return null
  }
}

function writeDraft(key, payload) {
  try {
    window.localStorage.setItem(key, JSON.stringify(payload))
  } catch {
    // Quota, or a browser refusing storage. Nothing to do and nothing worth
    // telling the author: the document is still in memory and Save still works.
  }
}

function clearDraft(key) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // As above.
  }
}

/**
 * @param {{assetId?: string|number|null, onError?: (message: string) => void}} options
 */
export default function useVfxDocument({ assetId = null, onError = null } = {}) {
  const numericId = vfxAssetId(assetId)
  const key = draftKey(numericId)

  // A factory, so the empty document is built once on mount rather than on
  // every render - useState reads a function as a lazy initialiser.
  const history = useVfxHistory(() => createEmptyVfxDoc({ name: 'Untitled effect' }))
  const doc = history.value
  // Destructured because `history` is a fresh object each render while these
  // three are useCallback-stable. Depending on the object would make every
  // callback below unstable, and the board's memoised nodes would re-render on
  // every keystroke anywhere on the page.
  const { commit: commitHistory, reset: resetHistory } = history
  const [name, setName] = useState('Untitled effect')
  const [savedAssetId, setSavedAssetId] = useState(numericId)
  const [status, setStatus] = useState(numericId ? 'loading' : 'idle')
  // Read in a state initialiser rather than an effect: reading storage during
  // render is fine, and setting state from an effect body is what the hooks
  // linter (correctly) objects to.
  const [draft, setDraft] = useState(() => readDraft(key))

  const [savedSignature, setSavedSignature] = useState(() => vfxSignature(doc))
  const loadedRef = useRef(null)

  /**
   * Record an edit, with an undo label and an optional coalesce key.
   *
   * Normalising here rather than in each caller means a mutator can return a
   * loosely-shaped document and the reconciler in normalizeVfxDoc still runs -
   * which is what keeps the link mirror and the edge list in step.
   */
  const commit = useCallback((next, meta = {}) => {
    commitHistory(
      current => normalizeVfxDoc(typeof next === 'function' ? next(current) : next),
      meta,
    )
  }, [commitHistory])

  // Load the asset named in the URL. Runs once per id - see the header for why
  // there is no cancellation flag.
  useEffect(() => {
    if (numericId == null) return
    if (loadedRef.current === numericId) return
    loadedRef.current = numericId

    loadVfxAsset(numericId)
      .then(({ doc: loaded, record }) => {
        resetHistory(loaded)
        setName(loaded.name || record?.name || 'Effect')
        setSavedAssetId(numericId)
        setSavedSignature(vfxSignature(loaded))
        setStatus('idle')
      })
      .catch(error => {
        setStatus('error')
        onError?.(error?.message || 'Could not open that effect')
      })
    // onError is intentionally absent: it is a fresh closure each render and
    // including it would re-fetch on every keystroke elsewhere on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericId])

  const signature = vfxSignature(doc)
  const dirty = signature !== savedSignature

  // Mirror to localStorage while dirty. Debounced, and skipped entirely when
  // clean, so opening an effect and looking at it writes nothing.
  useEffect(() => {
    if (!dirty) return undefined
    const timer = setTimeout(() => {
      writeDraft(key, { doc, name, savedAt: Date.now() })
    }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [dirty, doc, key, name])

  // A draft has to survive the tab closing, which the debounce above cannot
  // promise on its own. pagehide rather than beforeunload: it fires on mobile
  // and on back-forward cache navigations too, which is the same reason
  // BoardPage.jsx uses it.
  useEffect(() => {
    const flush = () => {
      if (signature !== savedSignature) {
        writeDraft(key, { doc, name, savedAt: Date.now() })
      }
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      flush()
    }
  }, [doc, key, name, savedSignature, signature])

  const restoreDraft = useCallback(() => {
    if (!draft) return
    resetHistory(normalizeVfxDoc(draft.doc))
    if (draft.name) setName(draft.name)
    setDraft(null)
  }, [draft, resetHistory])

  const discardDraft = useCallback(() => {
    clearDraft(key)
    setDraft(null)
  }, [key])

  // Takes either a TEMPLATE, which carries a builder, or a PRESET, which
  // carries the document itself - a preset is JSON on disk, so there is nothing
  // to build. One path rather than two, because everything after this line
  // (resetting history, clearing the asset id) is identical and getting it
  // right twice is how the two drift.
  const loadTemplate = useCallback(source => {
    const built = normalizeVfxDoc(
      typeof source.build === 'function' ? source.build() : source.doc,
    )
    // reset, not commit: a template is a different document, and an undo that
    // replaced the open effect with the previous one would be startling.
    resetHistory(built)
    setName(source.name)
    // A template is a NEW effect, not an edit of the open one: clearing the
    // asset id is what stops Save silently overwriting whatever the author had
    // open with something they picked out of a gallery.
    setSavedAssetId(null)
    setSavedSignature(vfxSignature(built))
    setStatus('idle')
  }, [resetHistory])

  /**
   * @param {{saveAs?: boolean, thumbnail?: File|Blob|null}} [options]
   */
  const save = useCallback(async (options = {}) => {
    setStatus('saving')
    try {
      const targetId = options.saveAs ? null : savedAssetId
      const result = await saveVfxAsset({
        name,
        doc,
        thumbnail: options.thumbnail || null,
        assetId: targetId,
      })
      const newId = vfxAssetId(result) ?? targetId
      setSavedAssetId(newId)
      setSavedSignature(vfxSignature(doc))
      // The draft only exists to survive a crash before a save; once the
      // library has the document, keeping it would mean offering to restore
      // something older than what is on screen.
      clearDraft(key)
      setDraft(null)
      setStatus('saved')
      return { ...result, id: newId }
    } catch (error) {
      setStatus('error')
      onError?.(error?.message || 'Could not save the effect')
      throw error
    }
  }, [doc, key, name, onError, savedAssetId])

  return {
    doc,
    commit,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
    name,
    setName,
    assetId: savedAssetId,
    status,
    dirty,
    draft,
    restoreDraft,
    discardDraft,
    loadTemplate,
    save,
  }
}
