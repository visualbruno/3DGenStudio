// Seamless (tileable texture) tool control panel.
//
// The tiled preview is the point of this panel, not decoration. A seam is
// invisible on the texture itself and obvious the moment it repeats, so judging
// the result on the ordinary single-image canvas is guesswork — you have to see
// it tiled to know whether the tool worked.
import { useEffect, useRef, useState } from 'react'
import {
  applySeamlessToCanvas, describeSeam, describeTiling, drawTiledPreview, measureSeam,
} from '../../../utils/seamlessTexture'

// Fallback only. The canvases are sized from their real laid-out box below,
// because the CSS stretches them to the panel width — a fixed backing store
// gets magnified by the browser and the preview looks soft for reasons that
// have nothing to do with the texture, which is a bad way to judge a tool whose
// whole job is sharpness at a join.
const PREVIEW_PX = 220
// The preview is computed from a downscaled copy. A 4K texture would otherwise
// be reprocessed on every slider tick to fill a small box.
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
  const beforeTilingRef = useRef(null)
  const afterTilingRef = useRef(null)
  const [displayRevision, setDisplayRevision] = useState(0)

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
  // Match each canvas's backing store to the pixels it actually occupies on
  // this display, so the tiled preview is not itself being upscaled.
  useEffect(() => {
    const nodes = [beforeRef.current, afterRef.current].filter(Boolean)
    if (!nodes.length || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setDisplayRevision(value => value + 1))
    nodes.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const ratio = window.devicePixelRatio || 1
    const fit = node => {
      if (!node) return
      const box = node.getBoundingClientRect()
      const size = Math.max(64, Math.round((box.width || PREVIEW_PX) * ratio))
      if (node.width !== size) node.width = size
      if (node.height !== size) node.height = size
    }
    fit(beforeRef.current)
    fit(afterRef.current)

    const previewSource = downscale(getSourceCanvas?.(), PREVIEW_SOURCE_MAX)
    const processed = previewSource ? applySeamlessToCanvas(previewSource, seamlessValues) : null

    if (previewSource && beforeRef.current) drawTiledPreview(beforeRef.current, previewSource, 2)
    if (processed && afterRef.current) drawTiledPreview(afterRef.current, processed, 2)

    // Two verdicts, because there are two ways to fail. The seam verdict only
    // ever looks at the join; a texture that fades from light to dark scores
    // "invisible" on it and still reads as a grid the moment it repeats, so the
    // tiling verdict reports that separately.
    const label = (node, verdict) => {
      if (!node) return
      node.textContent = verdict ? ` · ${verdict}` : ''
      node.dataset.verdict = verdict
    }
    const measure = canvas => (canvas ? measureSeam(canvas) : null)
    const before = measure(previewSource)
    const after = measure(processed)
    label(beforeVerdictRef.current, before ? describeSeam(before.ratio) : '')
    label(afterVerdictRef.current, after ? describeSeam(after.ratio) : '')
    label(beforeTilingRef.current, before ? describeTiling(before.bias) : '')
    label(afterTilingRef.current, after ? describeTiling(after.bias) : '')
  }, [getSourceCanvas, sourceRevision, seamlessValues, displayRevision])

  return (
    <div className="image-editor-controls">
      <div className="seamless-preview">
        <figure>
          <canvas ref={beforeRef} width={PREVIEW_PX} height={PREVIEW_PX} />
          <figcaption>
            Before
            <span className="seamless-verdict" ref={beforeVerdictRef} />
            <span className="seamless-verdict" ref={beforeTilingRef} />
          </figcaption>
        </figure>
        <figure>
          <canvas ref={afterRef} width={PREVIEW_PX} height={PREVIEW_PX} />
          <figcaption>
            After
            <span className="seamless-verdict" ref={afterVerdictRef} />
            <span className="seamless-verdict" ref={afterTilingRef} />
          </figcaption>
        </figure>
      </div>
      <p className="seamless-hint">
        Each preview is the texture tiled 2×2 — a seam shows as a cross through the middle. The
        first verdict is the join; the second is whether the tile is evenly lit. A texture needs
        both before it stops looking tiled.
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
          <p className="seamless-hint">
            Quoted for a 1K texture and scaled from there, so the preview softens the join by the
            same amount, relative to the picture, as the full-size result will.
          </p>
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
        Evens out large-scale brightness across the finished tile. Matching edges is only half the
        job — a texture that is darker on one side still reads as a grid when it repeats, and no
        amount of overlap fixes that. Turn it down if you want to keep the photo&apos;s own lighting.
      </p>

      <label className="image-editor-toggle">
        <input
          type="checkbox"
          checked={seamlessValues.keepSize !== false}
          onChange={handleChange('keepSize')}
        />
        <span>Keep original size</span>
      </label>
      <p className="seamless-hint">
        Joining spends the overlap, so keeping the original size means resampling — at a 17%
        overlap that is a 1.17× magnification of everything, not just the edges. Turn it off for
        a slightly smaller but pixel-exact texture.
      </p>

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
