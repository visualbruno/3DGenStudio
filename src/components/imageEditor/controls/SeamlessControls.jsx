// Seamless (tileable texture) tool control panel.
//
// The tiled preview is the point of this panel, not decoration. A seam is
// invisible on the texture itself and obvious the moment it repeats, so judging
// the result on the ordinary single-image canvas is guesswork — you have to see
// it tiled to know whether the tool worked.
import { useEffect, useRef } from 'react'
import {
  applySeamlessToCanvas, describeSeam, drawTiledPreview, measureSeam,
} from '../../../utils/seamlessTexture'

const PREVIEW_PX = 220
// The preview is computed from a downscaled copy. A 4K texture would otherwise
// be reprocessed on every slider tick to fill a 220px box.
const PREVIEW_SOURCE_MAX = 384

function downscale(canvas, maxSize) {
  if (!canvas?.width) return null
  const scale = Math.min(1, maxSize / Math.max(canvas.width, canvas.height))
  if (scale >= 1) return canvas
  const small = document.createElement('canvas')
  small.width = Math.max(8, Math.round(canvas.width * scale))
  small.height = Math.max(8, Math.round(canvas.height * scale))
  const context = small.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, small.width, small.height)
  return small
}

export default function SeamlessControls({
  seamlessValues,
  setSeamlessValues,
  setSeamlessPreviewDirty,
  getSourceCanvas,
  sourceRevision,
  onReset,
  onApply,
}) {
  const beforeRef = useRef(null)
  const afterRef = useRef(null)
  const beforeVerdictRef = useRef(null)
  const afterVerdictRef = useRef(null)

  const handleChange = key => event => {
    const raw = event.target.value
    const value = event.target.type === 'checkbox'
      ? event.target.checked
      : (event.target.type === 'range' || event.target.type === 'number' ? Number(raw) : raw)
    setSeamlessValues(prev => ({ ...prev, [key]: value }))
    setSeamlessPreviewDirty(true)
  }

  // The layer canvas lives in a ref on the page, so it is resolved here inside
  // the effect rather than passed down as a prop — reading a ref during render
  // is exactly what React warns about. `sourceRevision` is what re-runs this
  // when the layer's pixels change underneath us.
  //
  // The verdicts are written straight into their nodes rather than held in
  // state: this whole block is imperative canvas drawing already, and routing
  // one string back through a state update just to re-render the same effect is
  // both a render loop waiting to happen and a lint error.
  useEffect(() => {
    const previewSource = downscale(getSourceCanvas?.(), PREVIEW_SOURCE_MAX)
    const processed = previewSource ? applySeamlessToCanvas(previewSource, seamlessValues) : null

    if (previewSource && beforeRef.current) drawTiledPreview(beforeRef.current, previewSource, 2)
    if (processed && afterRef.current) drawTiledPreview(afterRef.current, processed, 2)

    const label = (node, canvas) => {
      if (!node) return
      const verdict = canvas ? describeSeam(measureSeam(canvas).ratio) : ''
      node.textContent = verdict ? ` · ${verdict}` : ''
      node.dataset.verdict = verdict
    }
    label(beforeVerdictRef.current, previewSource)
    label(afterVerdictRef.current, processed)
  }, [getSourceCanvas, sourceRevision, seamlessValues])

  return (
    <div className="image-editor-controls">
      <div className="seamless-preview">
        <figure>
          <canvas ref={beforeRef} width={PREVIEW_PX} height={PREVIEW_PX} />
          <figcaption>
            Before
            <span className="seamless-verdict" ref={beforeVerdictRef} />
          </figcaption>
        </figure>
        <figure>
          <canvas ref={afterRef} width={PREVIEW_PX} height={PREVIEW_PX} />
          <figcaption>
            After
            <span className="seamless-verdict" ref={afterVerdictRef} />
          </figcaption>
        </figure>
      </div>
      <p className="seamless-hint">
        Each preview is the texture tiled 2×2 — a seam shows as a cross through the middle.
      </p>

      <label className="image-editor-label">
        Method
        <select
          className="image-editor-input"
          value={seamlessValues.mode}
          onChange={handleChange('mode')}
        >
          <option value="cut">Cut — hides the join in existing detail (best for photos)</option>
          <option value="blend">Blend — cross-fades the edges (smooth, can ghost)</option>
          <option value="mirror">Mirror — perfect tiling, visibly symmetrical</option>
        </select>
      </label>

      {seamlessValues.mode !== 'mirror' && (
        <>
          <label className="image-editor-label">
            Overlap ({seamlessValues.overlap}%)
            <input
              className="image-editor-input"
              type="range"
              min="4"
              max="40"
              value={seamlessValues.overlap}
              onChange={handleChange('overlap')}
            />
          </label>
          <label className="image-editor-label">
            Softness ({seamlessValues.feather}px)
            <input
              className="image-editor-input"
              type="range"
              min="0"
              max="12"
              value={seamlessValues.feather}
              onChange={handleChange('feather')}
            />
          </label>
        </>
      )}

      <label className="image-editor-label">
        Flatten lighting ({seamlessValues.flatten}%)
        <input
          className="image-editor-input"
          type="range"
          min="0"
          max="100"
          value={seamlessValues.flatten}
          onChange={handleChange('flatten')}
        />
      </label>
      <p className="seamless-hint">
        Evens out large-scale brightness. Matching edges is only half the job — a texture that is
        darker on one side still reads as a grid when it repeats.
      </p>

      <label className="image-editor-toggle">
        <input
          type="checkbox"
          checked={seamlessValues.keepSize !== false}
          onChange={handleChange('keepSize')}
        />
        <span>Keep original size</span>
      </label>

      <div className="image-editor-toggle-row">
        <button type="button" className="image-editor-btn" onClick={onReset}>
          Reset
        </button>
        <button type="button" className="image-editor-btn image-editor-btn--primary" onClick={onApply}>
          Make Seamless
        </button>
      </div>
    </div>
  )
}
