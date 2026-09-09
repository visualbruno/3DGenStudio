// The gradient editor.
//
// Three stacked strips, top to bottom: the ALPHA rail, the composited PREVIEW
// bar, and the COLOUR rail. That order is not arbitrary - it is Unity's, and an
// author who has used Unity's gradient field will reach for the right rail
// without being told which is which.
//
// THE PREVIEW BAR IS DRAWN BY SAMPLING evalGradient PER PIXEL, never with a CSS
// `linear-gradient`. CSS interpolates in sRGB between the stops it is given,
// while the simulation interpolates in LINEAR light - so a CSS bar would show a
// different ramp from the one the particles use, and fidelity is the entire
// reason the bar exists. (The collapsed row in VfxPropertyField does use a CSS
// gradient, but of 24 stops that are each a real evalGradient sample, so CSS is
// only filling 1/23rd of the width between two correct values. Here, where the
// author is judging the ramp, every pixel is a sample.)
//
// CLICKING EMPTY RAIL ADDS A STOP SAMPLED FROM THE GRADIENT AT THAT POSITION,
// so adding never changes the look. See addColorKey in vfx/gradient.js - it is
// the single most important behaviour in a gradient editor, because an author
// adding a stop is almost always about to adjust it, and a stop that arrives as
// white has already destroyed the ramp they were refining.
//
// HDR IS FIRST-CLASS. A colour stop is a hex plus a BRIGHTNESS multiplier, and
// the multiplier may exceed 1. That is what makes an additive core blow out
// through the tonemapper instead of clipping to white, it is exactly Unity's
// HDR colour field and Niagara's colour scale so it exports 1:1, and the bar
// shows a "over 1" marker where the ramp exceeds white - because the bar itself
// physically cannot display it.
//
// THE COLOUR PICKER IS THE NATIVE ONE, deliberately. A hand-rolled HSV wheel is
// a few hundred lines that would be worse than what the browser already has:
// no OS eyedropper, no keyboard support, no high-contrast handling, no
// familiarity. What the native input CANNOT do is HDR, and that is handled by
// the separate brightness field rather than by replacing the picker.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  GRADIENT_PRESETS,
  addAlphaKey,
  addColorKey,
  describeGradient,
  evalGradient,
  gradientMaxComponent,
  linearToSrgb,
  removeAlphaKey,
  removeColorKey,
  updateAlphaKey,
  updateColorKey,
} from '../../../vfx/gradient.js'
import { CLIP_KIND, decodeClip, encodeClip, readClipText, writeClipText } from '../../utils/vfx/clipboard.js'
import VfxDragNumber from './VfxDragNumber'
import './VfxGradientEditor.css'

const BAR_HEIGHT = 30
const RAIL_HEIGHT = 16
const HIT_FRACTION = 0.035

/** Which stop, if any, is under a click at fraction `t` of the rail. */
function stopAt(keys, t) {
  let best = -1
  let bestDistance = HIT_FRACTION
  keys.forEach((key, index) => {
    const distance = Math.abs(key.t - t)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}

export default function VfxGradientEditor({
  value,
  onChange,
  onCommit,
  onClose = null,
  label = 'Colour',
}) {
  const barRef = useRef(null)
  const wrapRef = useRef(null)
  // Authoritative while the pointer is down; React's `value` is stale then.
  const draftRef = useRef(value)
  const drag = useRef(null)
  const [selected, setSelected] = useState({ rail: 'color', index: 0 })
  const [notice, setNotice] = useState('')
  const [width, setWidth] = useState(260)

  useEffect(() => {
    if (!drag.current) draftRef.current = value
  }, [value])

  // ---- the preview bar ----------------------------------------------------

  const paintBar = useCallback(() => {
    const canvas = barRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const gradient = draftRef.current
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(width))
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, w, BAR_HEIGHT)

    // The checkerboard, so an alpha ramp reads as transparency rather than as a
    // fade to the panel colour.
    const cell = 6
    for (let y = 0; y < BAR_HEIGHT; y += cell) {
      for (let x = 0; x < w; x += cell) {
        context.fillStyle = ((x / cell) + (y / cell)) % 2 === 0 ? '#191b20' : '#24272e'
        context.fillRect(x, y, cell, cell)
      }
    }

    // One evalGradient per pixel column - see the header for why this is not a
    // CSS gradient.
    const rgba = new Float64Array(4)
    for (let x = 0; x < w; x += 1) {
      evalGradient(gradient, x / Math.max(1, w - 1), rgba)
      const r = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgba[0]))) * 255)
      const g = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgba[1]))) * 255)
      const b = Math.round(Math.min(1, Math.max(0, linearToSrgb(rgba[2]))) * 255)
      context.fillStyle = `rgba(${r},${g},${b},${Math.min(1, Math.max(0, rgba[3]))})`
      context.fillRect(x, 0, 1, BAR_HEIGHT)

      // Where the ramp exceeds white, a hatch along the top edge. The bar
      // cannot show HDR - the screen has no headroom - so it says so instead
      // of quietly clipping, which is how an author ends up wondering why the
      // preview glows and the swatch does not.
      if (rgba[0] > 1.002 || rgba[1] > 1.002 || rgba[2] > 1.002) {
        context.fillStyle = 'rgba(255, 216, 138, 0.85)'
        context.fillRect(x, 0, 1, 2)
      }
    }
  }, [width])

  const frame = useRef(0)
  const pendingChange = useRef(false)

  // COALESCED TO ONE onChange AND ONE REPAINT PER FRAME - see the same note in
  // VfxCurveEditor. The bar is drawn one evalGradient per pixel column, so
  // repainting it on every pointermove of a stop drag was several hundred
  // evaluations per frame for one visible result.
  const emit = useCallback((gradient, commit) => {
    draftRef.current = gradient
    if (commit) {
      pendingChange.current = false
      onCommit?.(gradient)
      paintBar()
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
      paintBar()
    })
  }, [onChange, onCommit, paintBar])

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const canvas = barRef.current
    if (!wrap || !canvas) return undefined
    const resize = () => {
      const next = Math.max(120, Math.round(wrap.getBoundingClientRect().width))
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(next * dpr)
      canvas.height = Math.round(BAR_HEIGHT * dpr)
      canvas.style.width = `${next}px`
      canvas.style.height = `${BAR_HEIGHT}px`
      setWidth(next)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    paintBar()
  }, [paintBar, value])

  // ---- rails --------------------------------------------------------------

  const railFraction = (event, element) => {
    const rect = element.getBoundingClientRect()
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
  }

  const handleRailDown = useCallback((event, rail) => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const t = railFraction(event, element)
    const gradient = draftRef.current
    const keys = rail === 'color' ? gradient.colorKeys : gradient.alphaKeys
    const hit = stopAt(keys, t)

    if (hit >= 0) {
      setSelected({ rail, index: hit })
      drag.current = { rail, index: hit }
      return
    }
    // Empty rail: add a stop sampled from the gradient, then start dragging it.
    const result = rail === 'color'
      ? addColorKey(gradient, t)
      : addAlphaKey(gradient, t)
    setSelected({ rail, index: result.index })
    drag.current = { rail, index: result.index }
    // emit() repaints on its own frame; calling paintBar() here as well would
    // draw the bar twice for one change.
    emit(result.gradient, false)
  }, [emit])

  const handleRailMove = useCallback(event => {
    const state = drag.current
    if (!state) return
    const t = railFraction(event, event.currentTarget)
    const result = state.rail === 'color'
      ? updateColorKey(draftRef.current, state.index, { t })
      : updateAlphaKey(draftRef.current, state.index, { t })
    // The index follows a stop dragged past its neighbours - that is what the
    // mutators return it for.
    if (result.index >= 0 && result.index !== state.index) {
      state.index = result.index
      setSelected({ rail: state.rail, index: result.index })
    }
    emit(result.gradient, false)
  }, [emit])

  const endRailDrag = useCallback(event => {
    if (!drag.current) return
    drag.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released.
    }
    onCommit?.(draftRef.current)
  }, [onCommit])

  const removeSelected = useCallback(() => {
    const result = selected.rail === 'color'
      ? removeColorKey(draftRef.current, selected.index)
      : removeAlphaKey(draftRef.current, selected.index)
    if (result.index < 0) {
      setNotice('A gradient needs at least one stop on each rail.')
      return
    }
    setNotice('')
    setSelected({ rail: selected.rail, index: result.index })
    emit(result.gradient, true)
  }, [emit, selected])

  // ---- clipboard ----------------------------------------------------------

  const copy = useCallback(async () => {
    const ok = await writeClipText(encodeClip(CLIP_KIND.GRADIENT, draftRef.current))
    setNotice(ok
      ? 'Copied as text - it will paste into a message or a file.'
      : 'The browser would not let us write to the clipboard.')
  }, [])

  const paste = useCallback(async () => {
    const text = await readClipText()
    if (text == null) {
      setNotice('The browser would not let us read the clipboard.')
      return
    }
    const result = decodeClip(text, CLIP_KIND.GRADIENT)
    if (!result.ok) {
      setNotice(result.error)
      return
    }
    setNotice('')
    setSelected({ rail: 'color', index: 0 })
    emit(result.payload, true)
  }, [emit])

  // ---- render -------------------------------------------------------------

  // `value`, not the draft ref - see the same note in VfxCurveEditor. The
  // draft is for the canvas, which repaints from paintBar() rather than from a
  // render.
  const gradient = value
  const colorKey = gradient.colorKeys[selected.rail === 'color' ? selected.index : -1] || null
  const alphaKey = gradient.alphaKeys[selected.rail === 'alpha' ? selected.index : -1] || null
  const peak = gradientMaxComponent(gradient)

  return (
    <div className="vfx-grad">
      <div className="vfx-grad__head">
        <span className="vfx-grad__title">{label} over life</span>
        <select
          className="vfx-grad__preset"
          value=""
          onChange={event => {
            const preset = GRADIENT_PRESETS.find(entry => entry.id === event.target.value)
            if (!preset) return
            setSelected({ rail: 'color', index: 0 })
            emit(preset.build(), true)
          }}
          aria-label="Replace with a preset ramp"
        >
          <option value="">Ramp…</option>
          {GRADIENT_PRESETS.map(preset => (
            <option key={preset.id} value={preset.id} title={preset.hint}>{preset.label}</option>
          ))}
        </select>
        <button type="button" onClick={copy} title="Copy as plain text">
          <span className="material-symbols-outlined">content_copy</span>
        </button>
        <button type="button" onClick={paste} title="Paste a copied gradient">
          <span className="material-symbols-outlined">content_paste</span>
        </button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close the gradient editor">
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </div>

      <div
        className="vfx-grad__body"
        ref={wrapRef}
        role="application"
        aria-label={`${label}: ${describeGradient(gradient)}`}
      >
        {/* Alpha rail, above the bar. Unity's order. */}
        <div
          className="vfx-grad__rail is-alpha"
          style={{ height: RAIL_HEIGHT }}
          onPointerDown={event => handleRailDown(event, 'alpha')}
          onPointerMove={handleRailMove}
          onPointerUp={endRailDrag}
          onPointerCancel={endRailDrag}
          title="Opacity over life. Click to add a stop, drag to move it."
        >
          {gradient.alphaKeys.map((key, index) => (
            <span
              key={index}
              className={`vfx-grad__stop is-alpha${selected.rail === 'alpha' && selected.index === index ? ' is-selected' : ''}`}
              style={{ left: `${key.t * 100}%`, opacity: 0.25 + key.a * 0.75 }}
            />
          ))}
        </div>

        <canvas ref={barRef} className="vfx-grad__bar" />

        <div
          className="vfx-grad__rail is-color"
          style={{ height: RAIL_HEIGHT }}
          onPointerDown={event => handleRailDown(event, 'color')}
          onPointerMove={handleRailMove}
          onPointerUp={endRailDrag}
          onPointerCancel={endRailDrag}
          title="Colour over life. Click to add a stop, drag to move it."
        >
          {gradient.colorKeys.map((key, index) => (
            <span
              key={index}
              className={`vfx-grad__stop is-color${selected.rail === 'color' && selected.index === index ? ' is-selected' : ''}`}
              style={{ left: `${key.t * 100}%`, background: key.hex }}
            />
          ))}
        </div>
      </div>

      {/* The selected-stop row. One row for both rails, because only one stop
          is ever selected and two rows would leave one of them permanently
          disabled. */}
      <div className="vfx-grad__selected">
        {colorKey && (
          <>
            <input
              type="color"
              className="vfx-grad__swatch"
              value={colorKey.hex}
              onChange={event => {
                const result = updateColorKey(draftRef.current, selected.index, {
                  hex: event.target.value,
                })
                emit(result.gradient, true)
              }}
              aria-label="Stop colour"
            />
            <label className="vfx-grad__field">
              <span>Hex</span>
              <input
                type="text"
                value={colorKey.hex}
                onChange={event => {
                  const result = updateColorKey(draftRef.current, selected.index, {
                    hex: event.target.value,
                  })
                  emit(result.gradient, true)
                  paintBar()
                }}
                spellCheck={false}
              />
            </label>
            <label
              className="vfx-grad__field is-narrow"
              title="Brightness. Above 1 is HDR: it blows out through the tonemapper, which is what makes a glowing core read as hot. Exports as Unity's HDR colour and Niagara's colour scale."
            >
              <span>Bright</span>
              <VfxDragNumber
                value={colorKey.intensity}
                min={0}
                max={16}
                step={0.1}
                label="Stop brightness"
                onChange={next => {
                  const result = updateColorKey(draftRef.current, selected.index, {
                    intensity: next,
                  })
                  emit(result.gradient, false)
                  paintBar()
                }}
                onCommit={next => {
                  const result = updateColorKey(draftRef.current, selected.index, {
                    intensity: next,
                  })
                  emit(result.gradient, true)
                  paintBar()
                }}
              />
            </label>
          </>
        )}

        {alphaKey && (
          <label className="vfx-grad__field">
            <span>Opacity</span>
            <VfxDragNumber
              value={alphaKey.a}
              min={0}
              max={1}
              step={0.01}
              label="Stop opacity"
              onChange={next => {
                const result = updateAlphaKey(draftRef.current, selected.index, { a: next })
                emit(result.gradient, false)
              }}
              onCommit={next => {
                const result = updateAlphaKey(draftRef.current, selected.index, { a: next })
                emit(result.gradient, true)
              }}
            />
          </label>
        )}

        <label className="vfx-grad__field is-narrow">
          <span>At</span>
          <VfxDragNumber
            value={(colorKey || alphaKey)?.t ?? 0}
            min={0}
            max={1}
            step={0.01}
            label="Stop position"
            onChange={next => {
              const result = selected.rail === 'color'
                ? updateColorKey(draftRef.current, selected.index, { t: next })
                : updateAlphaKey(draftRef.current, selected.index, { t: next })
              if (result.index >= 0) setSelected({ rail: selected.rail, index: result.index })
              emit(result.gradient, false)
              paintBar()
            }}
            onCommit={() => onCommit?.(draftRef.current)}
          />
        </label>

        <button
          type="button"
          className="vfx-grad__remove"
          onClick={removeSelected}
          title="Remove this stop"
          aria-label="Remove this stop"
        >
          <span className="material-symbols-outlined">delete</span>
        </button>
      </div>

      {peak > 1.002 && (
        <p className="vfx-grad__hdr">
          Peaks at {Math.round(peak * 100) / 100}x white. The hatched edge on the
          bar is where it exceeds what the screen can show - the preview will
          glow there.
        </p>
      )}

      {notice && <p className="vfx-grad__notice">{notice}</p>}
    </div>
  )
}
