import { useState } from 'react'
import Viewer from './Viewer'
import './MeshPreviewDialog.css'

export default function MeshPreviewDialog({ asset, titleId = 'mesh-preview-dialog-title', onClose }) {
  const [showNormals, setShowNormals] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showLightSlider, setShowLightSlider] = useState(false)
  const [lightIntensity, setLightIntensity] = useState(2.2)

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
          <div className="mesh-preview-dialog__viewer">
            <div className="mesh-preview-dialog__toolbar nodrag">
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showNormals ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowNormals(current => !current)}
                aria-pressed={showNormals}
                title="Toggle normal material"
              >
                N
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showGrid ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowGrid(current => !current)}
                aria-pressed={showGrid}
                title="Toggle grid"
              >
                G
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showLightSlider ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowLightSlider(current => !current)}
                aria-pressed={showLightSlider}
                title="Adjust light"
              >
                L
              </button>
              {showLightSlider && (
                <div className="mesh-preview-dialog__light-panel">
                  <input
                    type="range"
                    min="0.4"
                    max="4"
                    step="0.1"
                    value={lightIntensity}
                    onChange={event => setLightIntensity(Number(event.target.value))}
                  />
                </div>
              )}
            </div>
            <Viewer
              height="100%"
              modelUrl={asset.url}
              showNormals={showNormals}
              showGrid={showGrid}
              lightIntensity={lightIntensity}
              fitMode="center"
            />
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
