// Tiled preview for the Seamless tool.
//
// This lives in the right column rather than above the sliders it belongs to,
// which looks like the wrong place until you use the tool: a seam is invisible
// on the texture itself and obvious the moment it repeats, so the ONLY way to
// judge a setting is to watch the tiled preview while you drag. Sitting at the
// top of the controls panel it scrolled out of view the moment you reached the
// stamp sliders, and you were tuning blind — dragging, scrolling up to look,
// scrolling back down. Out here it cannot scroll away.
import { useEffect, useRef, useState } from 'react'
import {
  applySeamlessToCanvas, describeSeam, describeTiling, drawTiledPreview, measureSeam,
} from '../../utils/seamlessTexture'

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

export default function SeamlessPreview({ seamlessValues, getSourceCanvas, sourceRevision }) {
  const beforeRef = useRef(null)
  const afterRef = useRef(null)
  const beforeVerdictRef = useRef(null)
  const afterVerdictRef = useRef(null)
  const beforeTilingRef = useRef(null)
  const afterTilingRef = useRef(null)
  const [displayRevision, setDisplayRevision] = useState(0)

  // Match each canvas's backing store to the pixels it actually occupies on
  // this display, so the tiled preview is not itself being upscaled.
  useEffect(() => {
    const nodes = [beforeRef.current, afterRef.current].filter(Boolean)
    if (!nodes.length || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setDisplayRevision(value => value + 1))
    nodes.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [])

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
    <aside className="seamless-preview-panel">
      <div className="seamless-preview-panel__header">
        <span className="seamless-preview-panel__title">Tiled preview</span>
      </div>
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
    </aside>
  )
}
