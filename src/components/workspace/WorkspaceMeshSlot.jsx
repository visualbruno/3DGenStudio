// The mesh a Workspace mesh-processing module works on (Retopo, and later UV /
// Texture / Rig): its thumbnail and name, or an empty drop zone. Filled from the
// history (selected or dragged), the Assets library, or a file from the computer.
import { useRef, useState } from 'react'
import { assetUrl } from '../../config'
import { MESH_FILE_EXTENSIONS } from '../../utils/graphHelpers'
import { readEntryDragData } from '../../utils/workspaceDrag'

const ACCEPT = MESH_FILE_EXTENSIONS.map(ext => `.${ext}`).join(',')

function isMeshFile(file) {
  const ext = String(file?.name || '').split('.').pop().toLowerCase()
  return MESH_FILE_EXTENSIONS.includes(ext)
}

export default function WorkspaceMeshSlot({
  value,
  busy,
  label = 'Source mesh',
  emptyLabel = 'Choose a mesh',
  hint = 'Click a mesh in the history, drag one here, or upload',
  onFile,
  onPickAsset,
  onUseSelected,
  onDropEntry,
  onClear
}) {
  const fileRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const takeFiles = (files) => {
    const file = Array.from(files || []).find(isMeshFile)
    if (file) onFile(file)
  }

  return (
    <div
      className={['workspace-meshslot', value ? 'workspace-meshslot--filled' : '', dragOver ? 'workspace-meshslot--drag' : ''].filter(Boolean).join(' ')}
      onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        if (busy) return
        const entry = readEntryDragData(event)
        if (entry) {
          if (entry.asset.type === 'mesh') onDropEntry?.(entry)
          return
        }
        takeFiles(event.dataTransfer?.files)
      }}
    >
      <div className="workspace-meshslot__preview">
        {value?.thumbnail
          ? <img src={assetUrl(value.thumbnail)} alt={value.name} draggable={false} />
          : <span className="material-symbols-outlined">{busy ? 'hourglass_top' : 'deployed_code'}</span>}
      </div>
      <div className="workspace-meshslot__meta">
        {value ? (
          <>
            <span className="workspace-meshslot__label">{label}</span>
            <span className="workspace-meshslot__name" title={value.name}>{value.name}</span>
          </>
        ) : (
          <>
            <span className="workspace-meshslot__name">{busy ? 'Loading…' : emptyLabel}</span>
            <span className="workspace-meshslot__hint">{hint}</span>
          </>
        )}
        <div className="workspace-meshslot__actions">
          <button type="button" className="workspace-slot__action" onClick={() => fileRef.current?.click()} title="Upload a mesh from the computer (GLB, FBX, OBJ…)" disabled={busy}>
            <span className="material-symbols-outlined">upload</span>
          </button>
          <button type="button" className="workspace-slot__action" onClick={onPickAsset} title="Pick a mesh from the Assets library" disabled={busy}>
            <span className="material-symbols-outlined">photo_library</span>
          </button>
          {onUseSelected && (
            <button type="button" className="workspace-slot__action" onClick={onUseSelected} title="Use the mesh selected in the history" disabled={busy}>
              <span className="material-symbols-outlined">ads_click</span>
            </button>
          )}
          {value && (
            <button type="button" className="workspace-slot__action" onClick={onClear} title="Clear" disabled={busy}>
              <span className="material-symbols-outlined">close</span>
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(event) => { takeFiles(event.target.files); event.target.value = '' }}
      />
    </div>
  )
}
