import { useEffect, useRef, useState } from 'react'

export default function BoardSwitcher({
  projectId,
  boards = [],
  currentBoard,
  onBoardsChanged,
  createBoard,
  updateBoard,
  deleteBoard,
  onSelect
}) {
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false)
        setRenamingId(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const handleCreate = async () => {
    if (busy) return
    setBusy(true)
    try {
      const name = `Board ${boards.length + 1}`
      const created = await createBoard(projectId, name)
      onBoardsChanged()
      setOpen(false)
      onSelect(created.id)
    } catch (err) {
      console.error('Failed to create board', err)
    } finally {
      setBusy(false)
    }
  }

  const startRename = (board) => {
    setRenamingId(board.id)
    setRenameValue(board.name)
  }

  const commitRename = async (board) => {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name || name === board.name) return
    try {
      await updateBoard(board.id, { name })
      onBoardsChanged()
    } catch (err) {
      console.error('Failed to rename board', err)
    }
  }

  const handleDelete = async (board) => {
    if (boards.length <= 1) {
      window.alert('A project must keep at least one board.')
      return
    }
    if (!window.confirm(`Delete board "${board.name}"? This cannot be undone.`)) return
    try {
      await deleteBoard(board.id)
      const remaining = boards.filter(b => String(b.id) !== String(board.id))
      onBoardsChanged()
      if (String(board.id) === String(currentBoard?.id) && remaining[0]) {
        onSelect(remaining[0].id)
      }
    } catch (err) {
      console.error('Failed to delete board', err)
    }
  }

  return (
    <div className="board-switcher" ref={rootRef}>
      <button
        type="button"
        className="board-switcher__current"
        onClick={() => setOpen(o => !o)}
        title="Switch board"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>dashboard</span>
        <span className="board-switcher__name">{currentBoard?.name || 'Select board'}</span>
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>expand_more</span>
      </button>

      <button type="button" className="board-switcher__btn" onClick={handleCreate} disabled={busy}>
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add</span>
        New
      </button>

      {open && (
        <div className="board-switcher__menu" role="menu">
          {boards.map(board => {
            const isActive = String(board.id) === String(currentBoard?.id)
            const isRenaming = renamingId === board.id
            return (
              <div
                key={board.id}
                className={`board-switcher__item ${isActive ? 'board-switcher__item--active' : ''}`}
                onClick={() => {
                  if (isRenaming) return
                  setOpen(false)
                  onSelect(board.id)
                }}
              >
                {isRenaming ? (
                  <input
                    className="board-switcher__input"
                    value={renameValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(board)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(board)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                  />
                ) : (
                  <>
                    <span className="board-switcher__name">{board.name}</span>
                    <span className="board-switcher__item-actions">
                      <button
                        type="button"
                        className="board-switcher__icon-btn"
                        title="Rename board"
                        onClick={(e) => { e.stopPropagation(); startRename(board) }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit</span>
                      </button>
                      <button
                        type="button"
                        className="board-switcher__icon-btn"
                        title="Delete board"
                        onClick={(e) => { e.stopPropagation(); handleDelete(board) }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                      </button>
                    </span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
