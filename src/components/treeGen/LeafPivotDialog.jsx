// Place a leaf's pivot: the point where its stem meets the branch.
//
// The generator hangs each card from this point, so it is the difference
// between a leaf that grows off a twig and one dangling by its tip. A detector
// seeds it when the leaf is added, but generated cut-outs come at arbitrary
// angles and it gets a fair number wrong — so the authoritative answer is a
// click, and the detection is only a starting guess.
//
// The pivot is stored on the tree preset, never written into the image: the same
// leaf photo can be shared by several trees, and each is free to hang it
// differently.
import { useCallback, useEffect, useRef, useState } from 'react'

const PREVIEW = 120

export default function LeafPivotDialog({ entry, onSave, onClose }) {
  const [pivot, setPivot] = useState(() => entry?.pivot || { x: 0.5, y: 0.05 })
  const imageRef = useRef(null)
  const previewRef = useRef(null)
  const [loaded, setLoaded] = useState(false)

  const place = useCallback(event => {
    const box = event.currentTarget.getBoundingClientRect()
    setPivot({
      x: Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((event.clientY - box.top) / box.height, 0), 1),
    })
  }, [])

  useEffect(() => {
    const handler = event => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Enter') onSave(pivot)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onSave, pivot])

  // Live preview of how the card will actually be framed: rotated so the blade
  // hangs straight down from the pivot, with the pivot at the top edge. Drawn
  // here rather than round-tripped to the service so it tracks the cursor.
  useEffect(() => {
    const canvas = previewRef.current
    const image = imageRef.current
    if (!canvas || !image || !loaded) return
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, canvas.width, canvas.height)

    const width = image.naturalWidth
    const height = image.naturalHeight
    const anchorX = pivot.x * width
    const anchorY = pivot.y * height
    // The leaf hangs away from its attachment, so the direction is simply
    // pivot -> image centre. Same rule the service uses, which is what keeps
    // this preview honest.
    const angle = Math.atan2(width / 2 - anchorX, height / 2 - anchorY)

    const scale = PREVIEW / Math.max(width, height)
    context.save()
    context.translate(canvas.width / 2, 6)
    context.rotate(-angle)
    context.scale(scale, scale)
    context.drawImage(image, -anchorX, -anchorY)
    context.restore()

    context.fillStyle = '#ff4d4d'
    context.beginPath()
    context.arc(canvas.width / 2, 6, 4, 0, Math.PI * 2)
    context.fill()
  }, [pivot, loaded])

  if (!entry) return null

  return (
    <div className="leafpivot__overlay" role="presentation" onClick={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div className="leafpivot" role="dialog" aria-modal="true">
        <header className="leafpivot__header">
          <h2>Leaf pivot — {entry.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className="leafpivot__hint">
          Click where the stem meets the branch. The leaf will hang from that point.
        </p>

        <div className="leafpivot__body">
          <div className="leafpivot__stage" onClick={place}>
            <img
              ref={imageRef}
              src={entry.url}
              alt={entry.name}
              onLoad={() => setLoaded(true)}
              draggable={false}
            />
            <span
              className="leafpivot__marker"
              style={{ left: `${pivot.x * 100}%`, top: `${pivot.y * 100}%` }}
            />
          </div>

          <div className="leafpivot__side">
            <span className="leafpivot__side-label">On the branch</span>
            <canvas ref={previewRef} width={PREVIEW} height={PREVIEW} />
            <code>x {pivot.x.toFixed(3)}<br />y {pivot.y.toFixed(3)}</code>
          </div>
        </div>

        <footer className="leafpivot__footer">
          <button type="button" onClick={() => setPivot({ x: 0.5, y: 0.05 })}>Reset to top</button>
          <div className="leafpivot__spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="leafpivot__primary" onClick={() => onSave(pivot)}>
            Save pivot
          </button>
        </footer>
      </div>
    </div>
  )
}
