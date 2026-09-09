// Persisted pane sizes for the VFX editor's splitters.
//
// A separate module from VfxSplitter.jsx only because of Fast Refresh: a file
// that exports both a component and a plain function loses hot reloading for
// the component (`react-refresh/only-export-components`), and this is a page
// where hot-reloading the layout while a simulation runs is genuinely useful.
//
// Reading is meant for a useState INITIALISER, so the first paint is already
// the right size - no flash of the default width, and no layout effect that
// resizes the WebGL canvas one frame after mount.

/**
 * @param {string} storageKey
 * @param {number} fallback
 * @returns {number}
 */
export function readPaneSize(storageKey, fallback) {
  try {
    const raw = window.localStorage.getItem(storageKey)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  } catch {
    // A private window, or storage blocked. The pane still works; it just does
    // not remember its width.
    return fallback
  }
}

/**
 * @param {string} storageKey
 * @param {number} value
 */
export function writePaneSize(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, String(Math.round(value)))
  } catch {
    // As above.
  }
}
