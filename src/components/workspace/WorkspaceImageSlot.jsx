// An image input of a Workspace panel: empty drop zone or the chosen image.
// Filled from the computer (click / drop), the Assets library, the image
// selected in the history, or a history image dragged onto it.
import { useRef, useState } from 'react'
import { assetUrl } from '../../config'
import { readEntryDragData } from '../../utils/workspaceDrag'

export default function WorkspaceImageSlot({
  value,
  label,
  hint,
  variant = 'large',
  busy = false,
  disabled = false,
  onFile,
  onPickAsset,
  onUseSelected,
  onDropEntry,
  onClear
}) {
  const fileRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const takeFiles = (files) => {
    const file = Array.from(files || []).find(candidate => candidate.type?.startsWith('image/'))
    if (file) onFile(file)
  }

  const small = variant === 'small'

  return (
    <div
      className={[
        'workspace-slot',
        small ? 'workspace-slot--small' : '',
        value ? 'workspace-slot--filled' : '',
        dragOver ? 'workspace-slot--drag' : '',
        disabled ? 'workspace-slot--disabled' : ''
      ].filter(Boolean).join(' ')}
      onDragOver={(event) => { if (!disabled) { event.preventDefault(); setDragOver(true) } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        if (disabled || busy) return
        // A history image (replaces what is there), else files from the computer.
        const entry = readEntryDragData(event)
        if (entry) {
          if (entry.asset.type === 'image') onDropEntry?.(entry)
          return
        }
        takeFiles(event.dataTransfer?.files)
      }}
    >
      {value ? (
        <>
          <img src={assetUrl(value.thumbnail || value.filename)} alt={value.name} className="workspace-slot__image" draggable={false} />
          {label && <span className="workspace-slot__tag">{label}</span>}
          <button type="button" className="workspace-slot__clear" onClick={onClear} title="Remove this image">
            <span className="material-symbols-outlined">close</span>
          </button>
        </>
      ) : (
        <button
          type="button"
          className="workspace-slot__empty"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy}
          title="Choose an image from the computer (or drop one here)"
        >
          <span className="material-symbols-outlined workspace-slot__icon">{busy ? 'hourglass_top' : 'add_photo_alternate'}</span>
          <span className="workspace-slot__label">{busy ? 'Importing…' : (label || 'Upload')}</span>
          {!small && hint && <span className="workspace-slot__hint">{hint}</span>}
        </button>
      )}

      {!value && !disabled && (
        <div className="workspace-slot__actions">
          <button type="button" className="workspace-slot__action" onClick={onPickAsset} title="Pick from the Assets library" disabled={busy}>
            <span className="material-symbols-outlined">photo_library</span>
          </button>
          {onUseSelected && (
            <button type="button" className="workspace-slot__action" onClick={onUseSelected} title="Use the image selected in the history" disabled={busy}>
              <span className="material-symbols-outlined">ads_click</span>
            </button>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(event) => { takeFiles(event.target.files); event.target.value = '' }}
      />
    </div>
  )
}
