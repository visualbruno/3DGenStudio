// Assembly picker: switch, create, rename, delete.
//
// Forked from src/components/board/BoardSwitcher.jsx rather than generalising
// it — that component is wired to a projectId and enforces "a project must
// keep at least one board", neither of which applies here, and touching it
// would put a shipped page at risk for no gain.
//
// The differences that matter: no project scope (assemblies are global), and
// deleting the last assembly IS allowed — an empty catalogue is a legitimate
// state that the page renders as its own empty view.
import { useEffect, useRef, useState } from 'react'

export default function AssemblySwitcher({
  assemblies = [],
  currentId,
  currentName,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false)
        setRenaming(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const handleCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onCreate()
      setOpen(false)
    } catch (err) {
      console.error('Failed to create assembly', err)
    } finally {
      setBusy(false)
    }
  }

  const commitRename = async () => {
    const name = renameValue.trim()
    setRenaming(false)
    if (!name || name === currentName) return
    try {
      await onRename(name)
    } catch (err) {
      console.error('Failed to rename assembly', err)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${currentName}"? The meshes it references are not affected.`)) return
    setOpen(false)
    try {
      await onDelete()
    } catch (err) {
      console.error('Failed to delete assembly', err)
    }
  }

  return (
    <div className="assembly-switcher" ref={rootRef}>
      {renaming ? (
        <input
          className="assembly-switcher__input"
          value={renameValue}
          autoFocus
          onChange={event => setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={event => {
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') setRenaming(false)
          }}
        />
      ) : (
        <button
          type="button"
          className="assembly-switcher__current"
          onClick={() => setOpen(o => !o)}
          title="Switch assembly"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>precision_manufacturing</span>
          <span className="assembly-switcher__name">{currentName || 'Select assembly'}</span>
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>expand_more</span>
        </button>
      )}

      {currentId && !renaming && (
        <>
          <button
            type="button"
            className="assembly-switcher__icon-btn"
            title="Rename assembly"
            onClick={() => { setRenameValue(currentName || ''); setRenaming(true) }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit</span>
          </button>
          <button
            type="button"
            className="assembly-switcher__icon-btn"
            title="Delete assembly"
            onClick={handleDelete}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </>
      )}

      <button type="button" className="assembly-switcher__btn" onClick={handleCreate} disabled={busy}>
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>
        New
      </button>

      {open && (
        <div className="assembly-switcher__menu" role="menu">
          {assemblies.length === 0 && (
            <div className="assembly-switcher__empty">No assemblies yet</div>
          )}
          {assemblies.map(assembly => (
            <div
              key={assembly.id}
              className={`assembly-switcher__item ${String(assembly.id) === String(currentId) ? 'assembly-switcher__item--active' : ''}`}
              onClick={() => { setOpen(false); onSelect(assembly.id) }}
            >
              <span className="assembly-switcher__name">{assembly.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
