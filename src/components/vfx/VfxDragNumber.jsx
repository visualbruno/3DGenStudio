// A scrubbable number field: drag to change, click to type.
//
// The single most-used control in the editor, so it is worth getting exactly
// right. Two decisions carry the weight:
//
// UNCONTROLLED DURING A DRAG, CONTROLLED AT THE EDGES. While the pointer is
// down the value lives in a ref and is written straight onto the <input> and
// forwarded to onChange (so the preview updates live); React's `value` prop is
// stale for that whole time and deliberately not read. On pointerup, onCommit
// fires once. That split is what stops a two-second drag producing a hundred
// and twenty undo entries - the caller passes a `coalesceKey` on the onChange
// path and nothing on the onCommit path, and useVfxHistory does the rest.
//
// DRAG AND CLICK ARE DISAMBIGUATED BY DISTANCE, NOT BY WHERE YOU PRESS. A
// field you can only scrub from a narrow gutter is a field nobody discovers
// you can scrub. So the whole control is a drag surface, and a press that
// travels under three pixels before release is treated as a click and focuses
// the input for typing. This is how Unity, Blender and Niagara all behave, and
// matching them means a developer's existing muscle memory works.
//
// TYPING IS NOT CLAMPED, DRAGGING IS. `min`/`max` in the catalog are the
// sensible authoring range, not a hard limit (the header of vfx/catalog.js says
// so), so scrubbing stays inside them - which is what makes a drag feel
// controlled - while a typed 20000 is accepted. Refusing a typed value the
// author meant is worse than letting them be unusual.

import { useCallback, useEffect, useRef, useState } from 'react'
import './VfxDragNumber.css'

const CLICK_SLOP_PX = 3
const FINE_MULTIPLIER = 0.2
const COARSE_MULTIPLIER = 5

/** How many pixels of travel one full range should take. */
const DRAG_RANGE_PX = 260

function decimalsFor(step) {
  if (!Number.isFinite(step) || step <= 0) return 3
  const text = String(step)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1)
}

/** Round to the step's own precision, so a drag cannot produce 0.30000000000000004. */
function quantize(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function formatValue(value, decimals) {
  if (!Number.isFinite(value)) return '0'
  // Not toFixed: it would render 50 as "50.000" and make a whole column of
  // integers unreadable. Trailing zeros are dropped, precision is kept.
  return String(quantize(value, decimals))
}

/**
 * @param {Object} props
 * @param {number} props.value
 * @param {(next: number) => void} props.onChange live, during a drag
 * @param {(next: number) => void} [props.onCommit] once, at the end
 * @param {number} [props.min] soft lower bound - clamps dragging, not typing
 * @param {number} [props.max]
 * @param {number} [props.step]
 * @param {boolean} [props.integer]
 * @param {string} [props.unit]
 * @param {string} [props.label] accessible name
 * @param {boolean} [props.disabled]
 * @param {string} [props.title]
 */
export default function VfxDragNumber({
  value,
  onChange,
  onCommit = null,
  min = null,
  max = null,
  step = null,
  integer = false,
  unit = '',
  label = 'Value',
  disabled = false,
  title = '',
}) {
  const decimals = integer ? 0 : decimalsFor(step ?? 0.01)
  const inputRef = useRef(null)
  const drag = useRef(null)
  const frame = useRef(0)
  const pending = useRef(value)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')

  // Per-pixel sensitivity. Derived from the property's own range when it has
  // one, so a 0-1 alpha and a 0-10000 spawn rate both take the same hand
  // movement to cross - which is what makes the control feel like it knows
  // what it is editing.
  const perPixel = (() => {
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      return (max - min) / DRAG_RANGE_PX
    }
    if (Number.isFinite(step) && step > 0) return step
    return Math.max(Math.abs(value) / DRAG_RANGE_PX, 0.01)
  })()

  const clampDrag = useCallback(next => {
    let out = next
    if (Number.isFinite(min)) out = Math.max(min, out)
    if (Number.isFinite(max)) out = Math.min(max, out)
    return out
  }, [max, min])

  const flush = useCallback(() => {
    frame.current = 0
    const next = pending.current
    // Written directly, bypassing React: this is the "uncontrolled during a
    // drag" half of the contract, and it is why the input shows the live number
    // even though the `value` prop has not caught up.
    if (inputRef.current) inputRef.current.value = formatValue(next, decimals)
    onChange?.(next)
  }, [decimals, onChange])

  const handlePointerDown = useCallback(event => {
    if (disabled || editing || event.button !== 0) return
    // Not preventDefault: that would stop the click that focuses the input for
    // typing. The distance check below decides which gesture this was.
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, base: value, moved: false }
    pending.current = value
  }, [disabled, editing, value])

  const handlePointerMove = useCallback(event => {
    const state = drag.current
    if (!state) return
    const dx = event.clientX - state.x
    if (!state.moved) {
      if (Math.abs(dx) < CLICK_SLOP_PX && Math.abs(event.clientY - state.y) < CLICK_SLOP_PX) return
      state.moved = true
      document.body.classList.add('is-col-resizing')
    }
    const multiplier = event.shiftKey ? FINE_MULTIPLIER : event.altKey ? COARSE_MULTIPLIER : 1
    let next = state.base + dx * perPixel * multiplier
    if (integer) next = Math.round(next)
    else if (Number.isFinite(step) && step > 0) next = Math.round(next / step) * step
    pending.current = quantize(clampDrag(next), decimals)
    if (!frame.current) frame.current = window.requestAnimationFrame(flush)
  }, [clampDrag, decimals, flush, integer, perPixel, step])

  const endDrag = useCallback(event => {
    const state = drag.current
    if (!state) return
    drag.current = null
    document.body.classList.remove('is-col-resizing')
    if (frame.current) {
      window.cancelAnimationFrame(frame.current)
      frame.current = 0
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Already released.
    }
    if (!state.moved) {
      // A click. Hand the field over for typing, with the text selected so the
      // first keystroke replaces rather than appends.
      setText(formatValue(value, decimals))
      setEditing(true)
      return
    }
    flush()
    onCommit?.(pending.current)
  }, [decimals, flush, onCommit, value])

  // Focus and select once the input has actually become editable. A layout
  // effect would run before the readOnly flip is painted in some browsers, and
  // select() on a readOnly input is a no-op there.
  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  const commitText = useCallback(() => {
    setEditing(false)
    // Comma as a decimal separator, because a French or German keyboard puts it
    // on the numeric keypad and typing "0,5" is not a mistake the author made.
    const parsed = Number.parseFloat(String(text).replace(',', '.'))
    if (!Number.isFinite(parsed)) return
    const next = integer ? Math.round(parsed) : quantize(parsed, decimals)
    if (next === value) return
    onChange?.(next)
    onCommit?.(next)
  }, [decimals, integer, onChange, onCommit, text, value])

  const handleKeyDown = useCallback(event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitText()
      inputRef.current?.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(false)
      setText('')
      inputRef.current?.blur()
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const unitStep = (Number.isFinite(step) && step > 0 ? step : integer ? 1 : 0.1)
        * (event.shiftKey ? 10 : 1)
      const direction = event.key === 'ArrowUp' ? 1 : -1
      const next = quantize(clampDrag(value + unitStep * direction), decimals)
      setText(formatValue(next, decimals))
      onChange?.(next)
      onCommit?.(next)
    }
  }, [clampDrag, commitText, decimals, integer, onChange, onCommit, step, value])

  useEffect(() => () => {
    document.body.classList.remove('is-col-resizing')
  }, [])

  return (
    <div
      className={`vfx-num${disabled ? ' is-disabled' : ''}${editing ? ' is-editing' : ''}`}
      title={title || `${label}: drag to change, click to type`}
    >
      <input
        ref={inputRef}
        className="vfx-num__input"
        type="text"
        inputMode="decimal"
        aria-label={label}
        // While not editing the input is readOnly rather than disabled: a
        // disabled input is skipped by the tab order and reports nothing to a
        // screen reader, whereas readOnly still announces its value.
        readOnly={!editing || disabled}
        value={editing ? text : formatValue(value, decimals)}
        onChange={event => setText(event.target.value)}
        onBlur={() => { if (editing) commitText() }}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      {unit && <span className="vfx-num__unit">{unit}</span>}
    </div>
  )
}
