import { useState } from 'react'
import Viewer from './Viewer'
import './MeshPreviewDialog.css'

export default function MeshPreviewDialog({ asset, titleId = 'mesh-preview-dialog-title', onClose }) {
  const [showNormals, setShowNormals] = useState(false)

  if (!asset) {
    return null
  }

  return (
    <div className="mesh-preview-dialog-overlay" role="presentation" onClick={onClose}>
      <div className="mesh-preview-dialog mesh-preview-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={event => event.stopPropagation()}>
        <div className="mesh-preview-dialog__header">
          <h2 id={titleId} className="mesh-preview-dialog__title font-headline">{asset.name}</h2>
          <button type="button" className="mesh-preview-dialog__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="mesh-preview-dialog__body mesh-preview-dialog__body--viewer">
          <aside className="mesh-preview-dialog__sidebar">
            <label className="mesh-preview-dialog__toggle">
              <span className="mesh-preview-dialog__toggle-label">Normal</span>
              <button
                type="button"
                className={`mesh-preview-dialog__toggle-switch ${showNormals ? 'mesh-preview-dialog__toggle-switch--active' : ''}`}
                onClick={() => setShowNormals(prev => !prev)}
                aria-pressed={showNormals}
                aria-label="Toggle normal material preview"
              >
                <span className="mesh-preview-dialog__toggle-thumb" />
              </button>
            </label>
          </aside>
          <div className="mesh-preview-dialog__viewer">
            <Viewer height="100%" modelUrl={asset.url} showNormals={showNormals} />
          </div>
        </div>
        <div className="mesh-preview-dialog__actions">
          <button type="button" className="mesh-preview-dialog__btn mesh-preview-dialog__btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
