// Drag & drop of a history entry onto a Workspace image input (Mesh slots,
// Image prompt box). The entry travels as JSON under its own MIME type, so a
// drop target can tell it apart from files dragged in from the computer.
export const WORKSPACE_ENTRY_MIME = 'application/x-workspace-entry'

export function setEntryDragData(event, entry) {
  event.dataTransfer.setData(WORKSPACE_ENTRY_MIME, JSON.stringify({
    id: entry.id,
    module: entry.module,
    asset: entry.asset
  }))
  // Also as a plain URL-less text, so dropping outside the app does nothing odd.
  event.dataTransfer.setData('text/plain', entry.asset?.name || '')
  event.dataTransfer.effectAllowed = 'copy'
}

export function hasEntryDragData(event) {
  return Array.from(event.dataTransfer?.types || []).includes(WORKSPACE_ENTRY_MIME)
}

// The dropped history entry, or null (a file drop, or something else).
export function readEntryDragData(event) {
  try {
    const raw = event.dataTransfer?.getData(WORKSPACE_ENTRY_MIME)
    const entry = raw ? JSON.parse(raw) : null
    return entry?.asset ? entry : null
  } catch {
    return null
  }
}
