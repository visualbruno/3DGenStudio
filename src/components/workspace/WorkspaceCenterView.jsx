// Center of the Workspace: the selected history entry, large, with what made it
// and what can be done with it next.
import { assetUrl } from '../../config'
import { workflowLabel } from '../../utils/workspaceImage'

const ACTION_LABELS = { generate: 'Generated', edit: 'Edited', import: 'Imported' }

function formatDate(timestamp) {
  if (!timestamp) return ''
  try {
    return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

export default function WorkspaceCenterView({
  entry,
  sourceEntry,
  emptyTitle,
  emptyText,
  onEdit,
  onReuse,
  onSelectEntry,
  onOpenInEditor
}) {
  if (!entry) {
    return (
      <div className="workspace-center workspace-center--empty">
        <span className="material-symbols-outlined workspace-center__empty-icon">imagesmode</span>
        <h2 className="workspace-center__empty-title">{emptyTitle}</h2>
        <p className="workspace-center__empty-text">{emptyText}</p>
      </div>
    )
  }

  const { asset } = entry
  const isImage = asset.type === 'image'

  return (
    <div className="workspace-center">
      <div className="workspace-center__stage">
        {isImage ? (
          <img
            key={asset.id}
            src={assetUrl(asset.filename)}
            alt={asset.name}
            className="workspace-center__image"
          />
        ) : (
          <div className="workspace-center__empty-text">Preview for {asset.type || 'this asset'} comes with its module.</div>
        )}
      </div>

      <div className="workspace-center__info">
        <div className="workspace-center__meta">
          <span className={`workspace-center__tag workspace-center__tag--${entry.action}`}>{ACTION_LABELS[entry.action] || entry.action}</span>
          {entry.workflowName && (
            <span className="workspace-center__meta-item" title={entry.workflowName}>
              <span className="material-symbols-outlined">account_tree</span>
              {workflowLabel({ name: entry.workflowName })}
            </span>
          )}
          {asset.width > 0 && (
            <span className="workspace-center__meta-item">
              <span className="material-symbols-outlined">aspect_ratio</span>
              {asset.width} × {asset.height}
            </span>
          )}
          {entry.params?.seed !== undefined && (
            <span className="workspace-center__meta-item" title="Seed">
              <span className="material-symbols-outlined">casino</span>
              {entry.params.seed}
            </span>
          )}
          <span className="workspace-center__meta-item">
            <span className="material-symbols-outlined">schedule</span>
            {formatDate(entry.createdAt)}
          </span>
          {entry.action === 'edit' && sourceEntry && (
            <button type="button" className="workspace-center__link" onClick={() => onSelectEntry(sourceEntry)}>
              <span className="material-symbols-outlined">subdirectory_arrow_left</span>
              Show source
            </button>
          )}
        </div>

        {entry.prompt && <p className="workspace-center__prompt">{entry.prompt}</p>}

        <div className="workspace-center__actions">
          {isImage && (
            <button type="button" className="workspace-action-btn workspace-action-btn--primary" onClick={() => onEdit(entry)}>
              <span className="material-symbols-outlined">auto_fix_high</span>
              Edit this image
            </button>
          )}
          {entry.action !== 'import' && (
            <button type="button" className="workspace-action-btn" onClick={() => onReuse(entry)} title="Load this prompt, workflow and settings into the panel">
              <span className="material-symbols-outlined">replay</span>
              Reuse settings
            </button>
          )}
          {isImage && (
            <button type="button" className="workspace-action-btn" onClick={() => onOpenInEditor(entry)} title="Layers, paint, crop, inpaint… in the full Image Editor">
              <span className="material-symbols-outlined">open_in_new</span>
              Image Editor
            </button>
          )}
          <a className="workspace-action-btn" href={assetUrl(asset.filename)} download>
            <span className="material-symbols-outlined">download</span>
            Download
          </a>
        </div>
      </div>
    </div>
  )
}
