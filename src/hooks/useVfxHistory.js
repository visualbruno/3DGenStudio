// Undo and redo for the VFX document.
//
// SNAPSHOTS, NOT COMMANDS. Every edit in src/utils/vfx/edits.js already returns
// a new document built by spreads, so structural sharing is free and a snapshot
// costs almost nothing beyond the nodes that actually changed - a thirty-node
// graph is about forty kilobytes. A command system would need an inverse for
// each of some forty edit types in exchange for memory savings nobody would
// notice, and both existing undo systems in this repo are snapshot-based
// (src/hooks/useImageEditorHistory.js, and Assembly's).
//
// GRANULARITY LIVES ENTIRELY IN `coalesceKey`, and that is what makes the
// history usable rather than merely present:
//
//   - no key: a new entry every time. Structural edits - add a block, delete
//     one, reorder a stack, retime a clip - each get their own.
//   - a key, repeated within the window: merged into the entry already on top.
//     A slider drag commits on every rAF with the key
//     'prop:blk3:lifetime', so three hundred frames collapse to ONE undo
//     entry holding the final value, while the preview updated throughout.
//
// Without that, dragging a number for five seconds would bury every earlier
// edit under three hundred entries and undo would be useless.
//
// ENTRIES ARE NAMED. `undoLabel` drives the button tooltip - "Undo Move Add
// Gravity" rather than "Undo" - which is the cheapest confidence-builder in
// the editor: the author can see what they are about to reverse before they do
// it.
//
// SELECTION AND VIEWPORT ARE NOT IN HERE. They are not part of the document,
// so they are not undoable - but an entry carries a `focusNodeId` so the caller
// can select and reveal whatever the undo just changed. Undoing something you
// cannot see is the classic graph-editor failure.

import { useCallback, useRef, useState } from 'react'

const DEFAULT_LIMIT = 100
const COALESCE_WINDOW_MS = 600

/**
 * @param {*|Function} initial the starting document, or a factory returning it.
 *   Passed straight to useState, so a function is a LAZY INITIALISER - it runs
 *   once on mount instead of building a throwaway document on every render.
 *   That is the intended way to call this: `useVfxHistory(() => createEmptyVfxDoc())`.
 *   The corollary is that a document which is ITSELF a function cannot be
 *   stored, which is fine - a VFX document is plain JSON - but it is why
 *   `reset` below wraps its argument.
 * @param {{limit?: number, coalesceWindowMs?: number}} [options]
 */
export default function useVfxHistory(initial, options = {}) {
  const limit = options.limit || DEFAULT_LIMIT
  const window = options.coalesceWindowMs || COALESCE_WINDOW_MS

  const [value, setValue] = useState(initial)
  const undoStack = useRef([])
  const redoStack = useRef([])
  const lastCommit = useRef(null)

  // The flags are STATE, not derived from the ref stacks. A ref change does not
  // re-render, so reading stack length during render would leave the buttons
  // showing whether undo was available one edit ago.
  const [flags, setFlags] = useState({
    canUndo: false, canRedo: false, undoLabel: '', redoLabel: '',
  })

  const syncFlags = useCallback(() => {
    const top = undoStack.current[undoStack.current.length - 1]
    const next = redoStack.current[redoStack.current.length - 1]
    setFlags({
      canUndo: undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0,
      undoLabel: top?.label || '',
      redoLabel: next?.label || '',
    })
  }, [])

  /**
   * Record an edit.
   *
   * @param {*|Function} next the new document, or an updater
   * @param {{label?: string, coalesceKey?: string|null, focusNodeId?: string|null}} [meta]
   */
  const commit = useCallback((next, meta = {}) => {
    setValue(current => {
      const updated = typeof next === 'function' ? next(current) : next
      // Reference equality is enough: every edit helper returns the SAME object
      // when it changed nothing (a move to the index it is already at, a
      // removeClip on a single-clip track), and those must not create an entry
      // the author then has to undo twice.
      if (updated === current) return current

      const now = Date.now()
      const coalesce = Boolean(meta.coalesceKey)
        && lastCommit.current
        && lastCommit.current.key === meta.coalesceKey
        && now - lastCommit.current.at < window

      if (!coalesce) {
        undoStack.current.push({
          value: current,
          label: meta.label || '',
          focusNodeId: meta.focusNodeId || null,
        })
        if (undoStack.current.length > limit) undoStack.current.shift()
        // Any new edit invalidates the redo branch - there is no tree here,
        // only a line.
        redoStack.current = []
      } else if (undoStack.current.length > 0 && meta.label) {
        // Keep the label current while coalescing, so a drag that started as
        // "Set Lifetime" still says so after three hundred merged commits.
        undoStack.current[undoStack.current.length - 1].label = meta.label
      }

      lastCommit.current = { key: meta.coalesceKey || null, at: now }
      return updated
    })
    syncFlags()
  }, [limit, syncFlags, window])

  /** Step back. Returns the entry, so the caller can reveal what changed. */
  const undo = useCallback(() => {
    const entry = undoStack.current.pop()
    if (!entry) return null
    setValue(current => {
      redoStack.current.push({
        value: current,
        label: entry.label,
        focusNodeId: entry.focusNodeId,
      })
      return entry.value
    })
    // Cleared so the next slider drag opens a fresh entry rather than merging
    // into whatever the undo just restored.
    lastCommit.current = null
    syncFlags()
    return entry
  }, [syncFlags])

  /** Step forward. */
  const redo = useCallback(() => {
    const entry = redoStack.current.pop()
    if (!entry) return null
    setValue(current => {
      undoStack.current.push({
        value: current,
        label: entry.label,
        focusNodeId: entry.focusNodeId,
      })
      return entry.value
    })
    lastCommit.current = null
    syncFlags()
    return entry
  }, [syncFlags])

  /**
   * Replace the document and clear the history.
   *
   * Used on load and when opening a template. History is deliberately NOT
   * persisted, so Ctrl+Z immediately after opening an effect does nothing -
   * which is the honest behaviour and what Image Editor and Assembly already
   * do. Carrying a stack across documents would let an undo replace the open
   * effect with a different one.
   */
  const reset = useCallback(nextValue => {
    undoStack.current = []
    redoStack.current = []
    lastCommit.current = null
    // Wrapped, not passed through: reset takes a DOCUMENT, never an updater,
    // and setValue would read a bare function as one. Unlike `commit`, which
    // deliberately accepts both, there is no reason to reset from the current
    // value - if you have it, you can pass it.
    setValue(() => nextValue)
    syncFlags()
  }, [syncFlags])

  return {
    value,
    commit,
    undo,
    redo,
    reset,
    canUndo: flags.canUndo,
    canRedo: flags.canRedo,
    undoLabel: flags.undoLabel,
    redoLabel: flags.redoLabel,
  }
}
