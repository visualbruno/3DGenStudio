// The curve editor.
//
// Canvas, pointer capture and rAF, following AnimationDopesheet.jsx - DPR
// sizing, a ResizeObserver, setPointerCapture, and repaint driven through a ref
// rather than through state.
//
// UNCONTROLLED DURING A DRAG, CONTROLLED AT THE EDGES. While the pointer is
// down the curve lives in `draftRef`; `onChange` fires per rAF so the preview
// updates live, and `onCommit` fires once on pointerup. That split is what
// stops a 60 fps drag producing sixty undo entries - the caller passes a
// coalesceKey on the change path and nothing on the commit path.
//
// AXES ARE LABELLED IN THE PROPERTY'S REAL UNITS, not 0..1. A curve is stored
// normalised and multiplied by `scale`, but an author tuning a lifetime wants
// to read "0.35 s", not "0.35 of something". The vertical axis therefore shows
// value x scale with the unit appended, and the horizontal axis shows what the
// domain actually is - particle age for a curve over life, seconds for one over
// effect time.
//
// THE PLAYHEAD IS THE BEST TEACHING DEVICE IN THE EDITOR, and it is not a
// single line. For a curve over LIFE, every living particle is at a different
// point on it, so the overlay draws a tick per sampled particle: the author can
// see the population sweeping left to right and watch the curve and the effect
// be visibly the same object. For a curve over effect TIME there is exactly one
// position, so it is one line. Read through a callback in the editor's own rAF
// loop, so a moving playhead never re-renders React.
//
// IT ONLY EVER OPENS IN THE PARAMETERS PANEL, never inside a node. A canvas
// with pointer capture inside React Flow's scaled, panned viewport means every
// coordinate needs the zoom division and every drag competes with the pane; the
// plan rules it out and this component assumes it.
//
// "EDIT AS NUMBERS" IS A REAL EDITING PATH, not a fallback. It is the accessible
// route and the precise route - an author who wants a key at exactly 0.25 should
// not have to hit it with a mouse - and it costs about forty lines.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CURVE_INTERP,
  CURVE_PRESETS,
  addCurveKey,
  createCurve,
  cycleKeyInterp,
  describeCurve,
  curveExtent,
  evalCurve,
  moveCurveKey,
  removeCurveKey,
  setKeyTangent,
} from '../../../vfx/curve.js'
import { VALUE_DOMAIN } from '../../../vfx/value.js'
import { CLIP_KIND, decodeClip, encodeClip, readClipText, writeClipText } from '../../utils/vfx/clipboard.js'
import './VfxCurveEditor.css'

const PAD = { left: 34, right: 10, top: 10, bottom: 18 }
const KEY_RADIUS = 4
const HIT_RADIUS = 9
const TANGENT_ARM = 34
const MAX_PLAYHEAD_TICKS = 160

const DOMAIN_AXIS = {
  [VALUE_DOMAIN.LIFE]: 'particle age',
  [VALUE_DOMAIN.TIME]: 'effect time',
  [VALUE_DOMAIN.SPEED]: 'speed',
}

const INTERP_LABEL = {
  [CURVE_INTERP.AUTO]: 'smooth',
  [CURVE_INTERP.LINEAR]: 'straight',
  [CURVE_INTERP.CONSTANT]: 'stepped',
  [CURVE_INTERP.FREE]: 'hand-tuned',
}

/** The value range the graph shows, padded and never zero-height. */
function viewRange(curve) {
  const { min, max } = curveExtent(curve)
  const lo = Math.min(0, min)
  const hi = Math.max(max, lo + 1e-6)
  const span = hi - lo
  const pad = span * 0.12 || 0.5
  return { lo: lo - pad, hi: hi + pad }
}

export default function VfxCurveEditor({
  value,
  unit = '',
  scale = 1,
  domain = VALUE_DOMAIN.LIFE,
  onChange,
  onCommit,
  getPlayhead = null,
  onClose = null,
  label = 'Curve',
}) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  // The curve being edited. React's `value` is stale for the duration of a
  // drag; this ref is authoritative until the commit lands.
  const draftRef = useRef(value)
  const drag = useRef(null)
  const frame = useRef(0)
  const sizeRef = useRef({ width: 320, height: 170 })
  const [selected, setSelected] = useState(-1)
  const [numbersOpen, setNumbersOpen] = useState(false)
  const [notice, setNotice] = useState('')

  // Kept in step when the document changes underneath us - an undo, a preset,
  // a paste - but never during a drag, when the draft is the truth.
  useEffect(() => {
    if (!drag.current) draftRef.current = value
  }, [value])

  const toPixels = useCallback((t, v, range) => {
    const { width, height } = sizeRef.current
    const w = width - PAD.left - PAD.right
    const h = height - PAD.top - PAD.bottom
    return {
      x: PAD.left + t * w,
      y: PAD.top + (1 - (v - range.lo) / (range.hi - range.lo)) * h,
    }
  }, [])

  const fromPixels = useCallback((x, y, range) => {
    const { width, height } = sizeRef.current
    const w = width - PAD.left - PAD.right
    const h = height - PAD.top - PAD.bottom
    return {
      t: Math.min(1, Math.max(0, (x - PAD.left) / w)),
      v: range.lo + (1 - (y - PAD.top) / h) * (range.hi - range.lo),
    }
  }, [])

  // ---- painting -----------------------------------------------------------

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const curve = draftRef.current
    const { width, height } = sizeRef.current
    const dpr = window.devicePixelRatio || 1
    const range = viewRange(curve)

    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    const plotW = width - PAD.left - PAD.right
    const plotH = height - PAD.top - PAD.bottom

    context.fillStyle = '#101216'
    context.fillRect(PAD.left, PAD.top, plotW, plotH)

    // Grid and axis labels. The vertical axis is in REAL units - value times
    // the property's scale - which is the whole reason the editor takes a
    // `scale` and a `unit`.
    context.strokeStyle = '#22252c'
    context.fillStyle = '#5f6673'
    context.font = '9px system-ui, sans-serif'
    context.lineWidth = 1
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    for (let i = 0; i <= 4; i += 1) {
      const y = PAD.top + (i / 4) * plotH
      context.beginPath()
      context.moveTo(PAD.left, y)
      context.lineTo(PAD.left + plotW, y)
      context.stroke()
      const v = (range.hi - (i / 4) * (range.hi - range.lo)) * scale
      const text = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)
      context.fillText(`${text}${unit ? ` ${unit}` : ''}`, PAD.left - 3, y)
    }
    context.textAlign = 'center'
    context.textBaseline = 'top'
    for (let i = 0; i <= 4; i += 1) {
      const x = PAD.left + (i / 4) * plotW
      context.strokeStyle = '#22252c'
      context.beginPath()
      context.moveTo(x, PAD.top)
      context.lineTo(x, PAD.top + plotH)
      context.stroke()
      context.fillStyle = '#5f6673'
      context.fillText(`${Math.round((i / 4) * 100)}%`, x, PAD.top + plotH + 3)
    }

    // The zero line, drawn brighter, because "where does this cross zero" is
    // the question a velocity or offset curve is usually being read for.
    if (range.lo < 0 && range.hi > 0) {
      const zero = toPixels(0, 0, range)
      context.strokeStyle = '#39404d'
      context.beginPath()
      context.moveTo(PAD.left, zero.y)
      context.lineTo(PAD.left + plotW, zero.y)
      context.stroke()
    }

    // The playhead(s). Drawn under the curve so the curve stays readable.
    const playhead = getPlayhead?.()
    if (playhead) {
      if (domain === VALUE_DOMAIN.LIFE && playhead.ages?.length > 0) {
        // A tick per living particle. This is what makes the curve and the
        // effect visibly the same object.
        context.strokeStyle = 'rgba(255, 95, 95, 0.5)'
        const stride = Math.max(1, Math.ceil(playhead.ages.length / MAX_PLAYHEAD_TICKS))
        context.beginPath()
        for (let i = 0; i < playhead.ages.length; i += stride) {
          const at = toPixels(Math.min(1, Math.max(0, playhead.ages[i])), 0, range)
          context.moveTo(at.x, PAD.top + plotH)
          context.lineTo(at.x, PAD.top + plotH - 7)
        }
        context.stroke()
      }
      if (Number.isFinite(playhead.t)) {
        const at = toPixels(Math.min(1, Math.max(0, playhead.t)), 0, range)
        context.strokeStyle = '#ff5f5f'
        context.beginPath()
        context.moveTo(at.x, PAD.top)
        context.lineTo(at.x, PAD.top + plotH)
        context.stroke()
      }
    }

    // The curve itself, sampled per pixel so a stepped segment reads as a step
    // rather than as a diagonal between two keys.
    context.strokeStyle = '#6fa8ff'
    context.lineWidth = 1.75
    context.beginPath()
    for (let px = 0; px <= plotW; px += 1) {
      const t = px / plotW
      const point = toPixels(t, evalCurve(curve, t), range)
      if (px === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    }
    context.stroke()

    // Tangent handles, on the SELECTED key only. Showing every handle turns a
    // five-key curve into a thicket and makes the keys themselves hard to hit.
    if (selected >= 0 && selected < curve.keys.length) {
      const key = curve.keys[selected]
      const centre = toPixels(key.t, key.v, range)
      const arms = []
      if (selected > 0) arms.push({ side: 'in', slope: key.inTangent, dir: -1 })
      if (selected < curve.keys.length - 1) arms.push({ side: 'out', slope: key.outTangent, dir: 1 })
      for (const arm of arms) {
        // The slope is dv/dt in data space, so it has to be converted through
        // both axes' scales to become a screen direction.
        const dt = (arm.dir * TANGENT_ARM) / plotW
        const dv = arm.slope * dt
        const end = toPixels(key.t + dt, key.v + dv, range)
        context.strokeStyle = '#8c5fc0'
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(centre.x, centre.y)
        context.lineTo(end.x, end.y)
        context.stroke()
        context.fillStyle = '#d4a6ff'
        context.beginPath()
        context.arc(end.x, end.y, 3, 0, Math.PI * 2)
        context.fill()
      }
    }

    // Keys last, so they sit on top of everything.
    curve.keys.forEach((key, index) => {
      const point = toPixels(key.t, key.v, range)
      const isSelected = index === selected
      context.fillStyle = isSelected ? '#ffffff' : '#6fa8ff'
      context.strokeStyle = '#101216'
      context.lineWidth = 1.5
      context.beginPath()
      // A stepped key is drawn as a square, so the interpolation mode is
      // visible on the graph rather than only in the row below it.
      if (key.interp === CURVE_INTERP.CONSTANT) {
        context.rect(point.x - KEY_RADIUS, point.y - KEY_RADIUS, KEY_RADIUS * 2, KEY_RADIUS * 2)
      } else {
        context.arc(point.x, point.y, isSelected ? KEY_RADIUS + 1 : KEY_RADIUS, 0, Math.PI * 2)
      }
      context.fill()
      context.stroke()
    })
  }, [domain, getPlayhead, scale, selected, toPixels, unit])

  const schedulePaint = useCallback(() => {
    if (frame.current) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      paint()
    })
  }, [paint])

  // DPR-aware sizing. The canvas backing store is in device pixels while every
  // coordinate above is in CSS pixels, and the transform in paint() bridges
  // them - the trap AnimationDopesheet.jsx documents.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return undefined
    const resize = () => {
      const rect = wrap.getBoundingClientRect()
      const width = Math.max(160, Math.round(rect.width))
      const height = Math.max(120, Math.round(rect.height))
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width, height }
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      paint()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [paint])

  useEffect(() => {
    paint()
  }, [paint, value])

  // The playhead loop.
  //
  // It repaints only when the playhead has actually MOVED. The loop itself has
  // to keep running - there is no event for "the simulation advanced" - but a
  // paused effect, or one whose particles have all died, then costs one cheap
  // comparison per frame instead of a full repaint. Without this an open curve
  // editor redrew its grid, axes, curve and keys sixty times a second while the
  // author sat looking at a paused frame.
  useEffect(() => {
    if (!getPlayhead) return undefined
    let raf = 0
    let last = ''
    const tick = () => {
      raf = window.requestAnimationFrame(tick)
      const playhead = getPlayhead()
      // Rounded, because a t that differs in the twelfth decimal is not a
      // movement anyone can see.
      const signature = playhead
        ? `${Math.round((playhead.t || 0) * 2000)}:${playhead.ages?.length || 0}`
        : ''
      if (signature === last) return
      last = signature
      paint()
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [getPlayhead, paint])

  useEffect(() => () => {
    if (frame.current) window.cancelAnimationFrame(frame.current)
  }, [])

  // ---- editing ------------------------------------------------------------

  // COALESCED TO ONE onChange PER FRAME. A pointermove can fire several times
  // per animation frame on a high-rate mouse or a pen, and each one would
  // otherwise be a document commit, a normalise pass and a recompile check -
  // for a curve nobody will see until the next paint. The commit path is NOT
  // coalesced: it happens once, on pointerup, and it must not be dropped.
  const pendingChange = useRef(false)
  const emit = useCallback((curve, commit) => {
    draftRef.current = curve
    if (commit) {
      pendingChange.current = false
      onCommit?.(curve)
      schedulePaint()
      return
    }
    pendingChange.current = true
    if (frame.current) return
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0
      if (pendingChange.current) {
        pendingChange.current = false
        onChange?.(draftRef.current)
      }
      paint()
    })
  }, [onChange, onCommit, paint, schedulePaint])

  const hitTest = useCallback((x, y) => {
    const curve = draftRef.current
    const range = viewRange(curve)

    // Tangent handles are tested FIRST, because they sit near their key and a
    // key that always won would make the handles unusable.
    if (selected >= 0 && selected < curve.keys.length) {
      const key = curve.keys[selected]
      const plotW = sizeRef.current.width - PAD.left - PAD.right
      for (const arm of [{ side: 'in', slope: key.inTangent, dir: -1 },
        { side: 'out', slope: key.outTangent, dir: 1 }]) {
        const dt = (arm.dir * TANGENT_ARM) / plotW
        const end = toPixels(key.t + dt, key.v + arm.slope * dt, range)
        if ((end.x - x) ** 2 + (end.y - y) ** 2 <= HIT_RADIUS ** 2) {
          return { kind: 'tangent', index: selected, side: arm.side }
        }
      }
    }

    for (let i = curve.keys.length - 1; i >= 0; i -= 1) {
      const point = toPixels(curve.keys[i].t, curve.keys[i].v, range)
      if ((point.x - x) ** 2 + (point.y - y) ** 2 <= HIT_RADIUS ** 2) {
        return { kind: 'key', index: i }
      }
    }
    return null
  }, [selected, toPixels])

  const localPoint = event => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handlePointerDown = useCallback(event => {
    if (event.button !== 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(event.pointerId)
    const { x, y } = localPoint(event)
    const hit = hitTest(x, y)

    if (!hit) {
      // Clicking empty space adds a key AT THE CURVE'S OWN VALUE, so the shape
      // does not change - see addCurveKey. The new key is then immediately
      // being dragged, which is what makes "click and drag to place a key"
      // work as one gesture.
      const range = viewRange(draftRef.current)
      const at = fromPixels(x, y, range)
      const result = addCurveKey(draftRef.current, at.t, at.v)
      setSelected(result.index)
      drag.current = { kind: 'key', index: result.index, startX: x, startY: y, axis: null }
      emit(result.curve, false)
      return
    }

    setSelected(hit.index)
    drag.current = { ...hit, startX: x, startY: y, axis: null }
    schedulePaint()
  }, [emit, fromPixels, hitTest, schedulePaint])

  const handlePointerMove = useCallback(event => {
    const state = drag.current
    if (!state) return
    const { x, y } = localPoint(event)
    const range = viewRange(draftRef.current)

    if (state.kind === 'tangent') {
      const key = draftRef.current.keys[state.index]
      const centre = toPixels(key.t, key.v, range)
      const plotW = sizeRef.current.width - PAD.left - PAD.right
      const plotH = sizeRef.current.height - PAD.top - PAD.bottom
      // Screen delta back into data slope. dx is guarded away from zero: a
      // vertical drag is an infinite slope, and clamping the arm rather than
      // the slope keeps the handle where the pointer is.
      const dxPixels = state.side === 'in' ? Math.min(-1, x - centre.x) : Math.max(1, x - centre.x)
      const dt = dxPixels / plotW
      const dv = ((centre.y - y) / plotH) * (range.hi - range.lo)
      const result = setKeyTangent(draftRef.current, state.index, state.side, dv / dt)
      emit(result.curve, false)
      return
    }

    // Shift locks the drag to whichever axis it started along - the standard
    // graph-editor modifier, and the only way to move a key in time without
    // nudging its value.
    let axis = state.axis
    if (event.shiftKey && !axis) {
      axis = Math.abs(x - state.startX) >= Math.abs(y - state.startY) ? 'x' : 'y'
      state.axis = axis
    } else if (!event.shiftKey) {
      state.axis = null
      axis = null
    }

    const at = fromPixels(x, y, range)
    const key = draftRef.current.keys[state.index]
    // Ctrl snaps time to 5% and value to two decimals - enough to hit round
    // numbers without making free placement impossible.
    const t = axis === 'y' ? key.t : (event.ctrlKey || event.metaKey ? Math.round(at.t * 20) / 20 : at.t)
    const v = axis === 'x' ? key.v : (event.ctrlKey || event.metaKey ? Math.round(at.v * 100) / 100 : at.v)

    const result = moveCurveKey(draftRef.current, state.index, { t, v })
    // The index follows the key past its neighbours - that is what
    // moveCurveKey returns it for, and without this the drag would silently
    // jump to a different key.
    if (result.index >= 0 && result.index !== state.index) {
      state.index = result.index
      setSelected(result.index)
    }
    emit(result.curve, false)
  }, [emit, fromPixels, toPixels])

  const endDrag = useCallback(event => {
    if (!drag.current) return
    drag.current = null
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      // Already released.
    }
    onCommit?.(draftRef.current)
  }, [onCommit])

  const handleDoubleClick = useCallback(event => {
    const { x, y } = localPoint(event)
    const hit = hitTest(x, y)
    if (!hit || hit.kind !== 'key') return
    const result = cycleKeyInterp(draftRef.current, hit.index)
    emit(result.curve, true)
  }, [emit, hitTest])

  const handleKeyDown = useCallback(event => {
    const curve = draftRef.current
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selected < 0) return
      event.preventDefault()
      const result = removeCurveKey(curve, selected)
      setSelected(result.index)
      emit(result.curve, true)
      return
    }
    if (selected < 0) return
    const key = curve.keys[selected]
    const stepT = event.shiftKey ? 0.1 : 0.01
    const stepV = (viewRange(curve).hi - viewRange(curve).lo) * (event.shiftKey ? 0.05 : 0.01)
    let next = null
    if (event.key === 'ArrowLeft') next = { t: key.t - stepT, v: key.v }
    else if (event.key === 'ArrowRight') next = { t: key.t + stepT, v: key.v }
    else if (event.key === 'ArrowUp') next = { t: key.t, v: key.v + stepV }
    else if (event.key === 'ArrowDown') next = { t: key.t, v: key.v - stepV }
    else if (event.key === 'Enter') {
      event.preventDefault()
      const result = cycleKeyInterp(curve, selected)
      emit(result.curve, true)
      return
    }
    if (!next) return
    event.preventDefault()
    const result = moveCurveKey(curve, selected, next)
    if (result.index >= 0) setSelected(result.index)
    emit(result.curve, true)
  }, [emit, selected])

  // ---- clipboard ----------------------------------------------------------

  const copy = useCallback(async () => {
    const ok = await writeClipText(encodeClip(CLIP_KIND.CURVE, draftRef.current))
    setNotice(ok ? 'Copied as text - it will paste into a message or a file.' : 'The browser would not let us write to the clipboard.')
  }, [])

  const paste = useCallback(async () => {
    const text = await readClipText()
    if (text == null) {
      setNotice('The browser would not let us read the clipboard. Paste into "Edit as numbers" instead.')
      return
    }
    const result = decodeClip(text, CLIP_KIND.CURVE)
    if (!result.ok) {
      setNotice(result.error)
      return
    }
    setSelected(-1)
    setNotice('')
    emit(result.payload, true)
  }, [emit])

  // ---- render -------------------------------------------------------------

  // `value`, not the draft ref. The draft exists so the CANVAS can repaint
  // mid-drag without a React render - paint() reads it from a rAF. Everything
  // below is ordinary render output, and `value` follows the drag anyway
  // because onChange commits per frame; it is also the version that has been
  // through normalizeVfxDoc, which the raw draft has not.
  const curve = value
  const selectedKey = selected >= 0 && selected < curve.keys.length ? curve.keys[selected] : null

  return (
    <div className="vfx-curve">
      <div className="vfx-curve__head">
        <span className="vfx-curve__title">{label} over {DOMAIN_AXIS[domain] || 'life'}</span>
        <select
          className="vfx-curve__preset"
          value=""
          onChange={event => {
            const preset = CURVE_PRESETS.find(entry => entry.id === event.target.value)
            if (!preset) return
            setSelected(-1)
            emit(preset.build(), true)
          }}
          aria-label="Replace with a preset shape"
        >
          <option value="">Shape…</option>
          {CURVE_PRESETS.map(preset => (
            <option key={preset.id} value={preset.id} title={preset.hint}>{preset.label}</option>
          ))}
        </select>
        <button type="button" onClick={copy} title="Copy as plain text">
          <span className="material-symbols-outlined">content_copy</span>
        </button>
        <button type="button" onClick={paste} title="Paste a copied curve">
          <span className="material-symbols-outlined">content_paste</span>
        </button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close the curve editor">
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </div>

      <div className="vfx-curve__canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="vfx-curve__canvas"
          // role="application" tells a screen reader that the arrow keys belong
          // to this widget rather than to the page, which is what makes the
          // keyboard path above reachable.
          role="application"
          tabIndex={0}
          aria-label={`${label}: ${describeCurve(curve, { unit })}. Arrow keys move the selected key, Enter changes its smoothing, Delete removes it.`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className="vfx-curve__status">
        {selectedKey ? (
          <>
            <span>
              Key at {Math.round(selectedKey.t * 100)}%, value{' '}
              {(selectedKey.v * scale).toFixed(3)}{unit ? ` ${unit}` : ''}
            </span>
            <span className="vfx-curve__interp">{INTERP_LABEL[selectedKey.interp]}</span>
          </>
        ) : (
          <span className="vfx-curve__hint">
            Click the graph to add a key. Double-click a key to change its smoothing.
            Shift locks an axis, Ctrl snaps.
          </span>
        )}
      </div>

      {notice && <p className="vfx-curve__notice">{notice}</p>}

      {/* A genuine editing path, not a disclosure of read-only detail. It is
          also the answer for "I want a key at exactly 0.25" and for anyone not
          using a mouse. */}
      <details
        className="vfx-curve__numbers"
        open={numbersOpen}
        onToggle={event => setNumbersOpen(event.currentTarget.open)}
      >
        <summary>Edit as numbers</summary>
        <table>
          <thead>
            <tr>
              <th>At</th>
              <th>Value{unit ? ` (${unit})` : ''}</th>
              <th>Smoothing</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {curve.keys.map((key, index) => (
              <tr key={index} className={index === selected ? 'is-selected' : ''}>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="1"
                    value={Math.round(key.t * 1000) / 1000}
                    onChange={event => {
                      const result = moveCurveKey(curve, index, { t: Number(event.target.value) })
                      if (result.index >= 0) setSelected(result.index)
                      emit(result.curve, true)
                    }}
                    aria-label={`Key ${index + 1} position`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    value={Math.round(key.v * scale * 1000) / 1000}
                    onChange={event => {
                      // Typed in real units, stored normalised - the same
                      // conversion the axis labels apply, in reverse.
                      const real = Number(event.target.value)
                      const next = scale === 0 ? real : real / scale
                      emit(moveCurveKey(curve, index, { v: next }).curve, true)
                    }}
                    aria-label={`Key ${index + 1} value`}
                  />
                </td>
                <td>
                  <select
                    value={key.interp}
                    onChange={event => {
                      const result = setKeyTangentSafe(curve, index, event.target.value)
                      emit(result, true)
                    }}
                    aria-label={`Key ${index + 1} smoothing`}
                  >
                    {Object.entries(INTERP_LABEL).map(([mode, text]) => (
                      <option key={mode} value={mode}>{text}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      const result = removeCurveKey(curve, index)
                      setSelected(result.index)
                      emit(result.curve, true)
                    }}
                    disabled={curve.keys.length <= 1}
                    aria-label={`Remove key ${index + 1}`}
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

// The numbers table's smoothing column writes an interp mode directly, which
// setKeyInterp handles - but it also has to cope with 'free' being chosen from
// the menu, where there are no handles to seed from yet. Going through
// createCurve keeps the tangents the key already had.
function setKeyTangentSafe(curve, index, interp) {
  const keys = curve.keys.map((key, i) => (i === index ? { ...key, interp } : key))
  return createCurve(keys, curve)
}
