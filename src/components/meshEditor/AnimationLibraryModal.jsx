// Picker for the custom-animation library (Auto Rig → Custom), and the place
// animation FILES are imported.
//
// It replaces a dropdown, which stopped working at the size this library is meant
// to reach: a marketplace pack is dozens of clips, and a dropdown has no search, no
// multi-select, no room for "which rig is this from" and nowhere to put an import
// button. The popup is the same shape as the saved-motion picker next door, so the
// two read as one idea.
//
// Import is a two-step on purpose: a file is PARSED first and its clips listed, then
// the user picks. A pack FBX with fifty takes should not silently become fifty
// library rows, and parsing is also where a file that carries no skeleton — the one
// failure that matters — is caught before anything is written.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ANIMATION_IMPORT_ACCEPT } from '../../utils/animationImport'

function formatDuration(seconds) {
  const s = Number(seconds) || 0
  return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`
}

// What a parsed file turned out to contain, and which of its clips to keep.
//
// Its own component so the tick state can be INITIALISED from the parse and reset
// by a `key` on the caller's side, rather than an effect copying props into state
// on every change.
function ImportPreview({ parsed, importing, progress, onImport, onCancel }) {
  const [picked, setPicked] = useState(() => new Set(parsed.clips.map(c => c.name)))

  const toggle = name => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })

  return (
    <div className="mesh-editor-animpick__import">
      <div className="mesh-editor-animpick__import-head">
        <span className="material-symbols-outlined">folder_zip</span>
        <strong>{parsed.fileName}</strong>
        <span className="mesh-editor-panel__hint">
          {parsed.clips.length} animation{parsed.clips.length === 1 ? '' : 's'} ·{' '}
          {parsed.boneNames?.length || 0} bones
        </span>
      </div>
      {/* Worth saying out loud: an FBX that misdeclares its up axis is common, and
          a rig we had to stand back up is the first thing to eyeball on the mesh. */}
      {parsed.straightened && (
        <span className="mesh-editor-panel__hint">
          This file declares a Z-up axis but its data is Y-up, so the rig was stood upright on
          import. If the motion still looks tipped over, say so — that judgement is a heuristic.
        </span>
      )}
      <div className="mesh-editor-animpick__import-clips">
        {parsed.clips.map(clip => (
          <button
            key={clip.name}
            type="button"
            className={`mesh-editor-animpick__clip ${picked.has(clip.name) ? 'mesh-editor-animpick__clip--on' : ''}`}
            onClick={() => toggle(clip.name)}
            aria-pressed={picked.has(clip.name)}
            disabled={importing}
          >
            <span className="material-symbols-outlined">
              {picked.has(clip.name) ? 'check_box' : 'check_box_outline_blank'}
            </span>
            <span className="mesh-editor-animpick__clip-name">{clip.name}</span>
            <span className="mesh-editor-panel__hint">
              {formatDuration(clip.duration)} · {clip.frameCount}f
            </span>
          </button>
        ))}
      </div>
      <div className="mesh-editor-animpick__import-actions">
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={() => onImport?.([...picked])}
          disabled={importing || !picked.size}
        >
          <span className="material-symbols-outlined">{importing ? 'progress_activity' : 'download_done'}</span>
          <span>
            {importing && progress
              ? `Importing ${progress.done} of ${progress.total}…`
              : `Import ${picked.size} animation${picked.size === 1 ? '' : 's'}`}
          </span>
        </button>
        <button type="button" className="mesh-editor-btn mesh-editor-btn--ghost"
          onClick={onCancel} disabled={importing}>
          <span className="material-symbols-outlined">close</span>
          <span>Cancel</span>
        </button>
      </div>
    </div>
  )
}

export default function AnimationLibraryModal({
  animations = [],
  loading = false,
  error = null,
  busy = false,
  busyId = null,
  applyDisabled = false,
  applyDisabledReason = '',
  // Import
  importing = false,
  importProgress = null,   // { done, total } while writing
  parsed = null,           // { fileName, clips: [{ name, duration, frameCount }] }
  onParseFiles,            // (FileList) — read a file, do not write anything yet
  onImport,                // (pickedNames[]) — write the picked clips to the library
  onCancelImport,
  onApply,                 // (animations[])
  onRename,                // (id, name)
  onDelete,                // (animations[])
  onClose,
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const searchRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return animations
    return animations.filter(a =>
      (a.name || '').toLowerCase().includes(q) || (a.sourceMesh || '').toLowerCase().includes(q))
  }, [animations, search])

  const selectedRows = useMemo(
    () => animations.filter(a => selected.has(a.id)),
    [animations, selected],
  )
  const visibleSelected = filtered.filter(a => selected.has(a.id)).length
  const allVisibleSelected = filtered.length > 0 && visibleSelected === filtered.length

  const toggle = id => {
    setConfirmDelete(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setConfirmDelete(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) filtered.forEach(a => next.delete(a.id))
      else filtered.forEach(a => next.add(a.id))
      return next
    })
  }

  const deleteSelected = () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setConfirmDelete(false)
    onDelete?.(selectedRows)
    setSelected(new Set())
  }

  return (
    <div className="mesh-editor-bonemap__overlay" onClick={onClose}>
      <div className="mesh-editor-motionpick" onClick={e => e.stopPropagation()}>
        <div className="mesh-editor-bonemap__header">
          <div>
            <h2 className="mesh-editor-bonemap__title">Animation library</h2>
            <p className="mesh-editor-bonemap__subtitle">
              Animations you saved or imported, from any project. Each one carries the skeleton it
              was made on, so applying it retargets it onto the mesh you have open — whatever rig
              it came from.
            </p>
          </div>
          <button type="button" className="mesh-editor-bonemap__close" onClick={onClose} title="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Import bar. FBX is what marketplace packs ship in; the same path reads
            an animated GLB or a BVH. */}
        <div className="mesh-editor-motionpick__toolbar">
          <input
            ref={fileRef}
            type="file"
            accept={ANIMATION_IMPORT_ACCEPT}
            multiple
            style={{ display: 'none' }}
            onChange={e => { onParseFiles?.(e.target.files); e.target.value = '' }}
          />
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--primary"
            onClick={() => fileRef.current?.click()}
            disabled={busy || importing}
            title="Import animations from an FBX, GLB or BVH file — a marketplace pack, a Mixamo download, or anything exported from Blender"
          >
            <span className="material-symbols-outlined">{importing ? 'progress_activity' : 'upload_file'}</span>
            <span>Import file…</span>
          </button>

          <div className="mesh-editor-anim__search mesh-editor-motionpick__search">
            <span className="material-symbols-outlined">search</span>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or source file"
              aria-label="Search animations"
            />
            {search && (
              <button type="button" className="mesh-editor-anim__search-clear" onClick={() => setSearch('')}>
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>

          <button
            type="button"
            className="mesh-editor-btn"
            onClick={toggleAllVisible}
            disabled={!filtered.length || busy}
          >
            <span className="material-symbols-outlined">
              {allVisibleSelected ? 'check_box' : 'select_all'}
            </span>
            <span>{allVisibleSelected ? 'Deselect these' : 'Select these'}</span>
          </button>

          <span className="mesh-editor-panel__hint mesh-editor-motionpick__count">
            {search.trim() ? `${filtered.length} of ${animations.length}` : `${animations.length} saved`}
            {selected.size ? ` · ${selected.size} selected` : ''}
          </span>
        </div>

        {error && (
          <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-motionpick__error">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </div>
        )}

        {/* Nothing is written until the clips are picked. `key` resets the ticks
            when another file is parsed. */}
        {parsed && (
          <ImportPreview
            key={`${parsed.fileName}:${parsed.clips.length}`}
            parsed={parsed}
            importing={importing}
            progress={importProgress}
            onImport={onImport}
            onCancel={onCancelImport}
          />
        )}

        <div className="mesh-editor-motionpick__list">
          {loading && !animations.length ? (
            <div className="mesh-editor-layers-panel__empty">Loading…</div>
          ) : !animations.length ? (
            <div className="mesh-editor-layers-panel__empty">
              Nothing here yet. Import an FBX pack above, or edit a clip in the animation editor and
              save it.
            </div>
          ) : !filtered.length ? (
            <div className="mesh-editor-layers-panel__empty">No animation matches “{search.trim()}”.</div>
          ) : (
            filtered.map(animation => {
              const checked = selected.has(animation.id)
              const rowBusy = busyId === animation.id
              const renaming = renamingId === animation.id
              return (
                <div
                  key={animation.id}
                  className={`mesh-editor-motionpick__row ${checked ? 'mesh-editor-motionpick__row--on' : ''}`}
                  onClick={() => !renaming && toggle(animation.id)}
                  role="checkbox"
                  aria-checked={checked}
                  tabIndex={0}
                  onKeyDown={e => {
                    if (renaming) return
                    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(animation.id) }
                  }}
                >
                  <span className="material-symbols-outlined mesh-editor-motionpick__check">
                    {checked ? 'check_box' : 'check_box_outline_blank'}
                  </span>

                  <span className="mesh-editor-motionpick__text">
                    {renaming ? (
                      <input
                        type="text"
                        className="mesh-editor-panel__input"
                        value={draftName}
                        autoFocus
                        onClick={e => e.stopPropagation()}
                        onChange={e => setDraftName(e.target.value)}
                        onKeyDown={e => {
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            if (draftName.trim()) onRename?.(animation.id, draftName)
                            setRenamingId(null)
                          } else if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => {
                          if (draftName.trim()) onRename?.(animation.id, draftName)
                          setRenamingId(null)
                        }}
                        aria-label="Animation name"
                      />
                    ) : (
                      <span className="mesh-editor-motionpick__name">{animation.name}</span>
                    )}
                    {/* Where it came from is what tells two "Walk" rows apart once a
                        pack and a hand-edited clip live in the same list. */}
                    {animation.sourceMesh && (
                      <span className="mesh-editor-motionpick__prompt">{animation.sourceMesh}</span>
                    )}
                  </span>

                  <span className="mesh-editor-motionpick__meta">
                    {animation.duration ? formatDuration(animation.duration) : '—'}
                    {animation.frameCount ? ` · ${animation.frameCount}f` : ''}
                    {animation.boneCount ? ` · ${animation.boneCount} bones` : ''}
                    {animation.createdAt ? ` · ${new Date(animation.createdAt).toLocaleDateString()}` : ''}
                  </span>

                  <button
                    type="button"
                    className="mesh-editor-motionpick__play"
                    onClick={e => { e.stopPropagation(); setDraftName(animation.name); setRenamingId(animation.id) }}
                    disabled={busy}
                    title="Rename"
                  >
                    <span className="material-symbols-outlined">edit</span>
                  </button>

                  {/* Applying one was a single click before this popup existed; keep
                      it one. Stops the row's own toggle. */}
                  <button
                    type="button"
                    className="mesh-editor-motionpick__play"
                    onClick={e => { e.stopPropagation(); onApply?.([animation]) }}
                    disabled={busy || applyDisabled}
                    title={applyDisabled ? applyDisabledReason : 'Apply this animation to the open mesh'}
                  >
                    <span className="material-symbols-outlined">
                      {rowBusy ? 'progress_activity' : 'play_circle'}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="mesh-editor-bonemap__footer">
          <span className="mesh-editor-panel__hint">
            {applyDisabled
              ? applyDisabledReason
              : 'Click a row to select it. Applied animations appear in the clip list, ready to preview and edit.'}
          </span>
          <div className="mesh-editor-bonemap__footer-actions">
            <button
              type="button"
              className={`mesh-editor-btn ${confirmDelete ? 'mesh-editor-motionpick__danger' : ''}`}
              onClick={deleteSelected}
              disabled={!selected.size || busy}
              title={confirmDelete ? 'Click again to delete permanently' : 'Delete the selected animations'}
            >
              <span className="material-symbols-outlined">delete</span>
              <span>{confirmDelete ? `Delete ${selectedRows.length}? Click again` : 'Delete'}</span>
            </button>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--primary"
              onClick={() => onApply?.(selectedRows)}
              disabled={!selected.size || busy || applyDisabled}
              title={applyDisabled ? applyDisabledReason : 'Apply the selected animations to the open mesh'}
            >
              <span className="material-symbols-outlined">{busy ? 'progress_activity' : 'play_circle'}</span>
              <span>Apply {selected.size || ''}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
