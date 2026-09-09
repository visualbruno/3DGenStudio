// A drag handle that resizes a pane by writing one CSS custom property.
//
// The first drag-resizer in this codebase, and it earns that because two of the
// three panes here are expensive to re-lay-out: the board is a React Flow
// viewport and the preview is a live WebGL canvas.
//
// IT DOES NOT setState DURING THE DRAG. The pointer handler writes
// `target.style.setProperty(variable, px)` inside a rAF, so a drag is a style
// recalculation on one element - no React render, no board reconciliation, and
// the canvas resizes once per frame at most. React only hears about it on
// pointerup, via onCommit, which is also the only thing that produces an undo-
// visible or persisted change. Driving this from state instead would re-render
// the whole editor sixty times a second while dragging, which is precisely the
// interaction where that is least affordable.
//
// The value therefore has TWO homes while the pointer is down - the DOM (live)
// and React (stale until commit) - and the DOM is authoritative. That is
// deliberate and it is why `value` is read into a ref at drag start rather than
// tracked as a dependency: a prop update mid-drag must not yank the pane.
//
// POINTER CAPTURE, not window listeners: the pointer can leave the 6px handle
// on the first frame of a fast drag, and setPointerCapture is what keeps the
// events coming. Same pattern as AnimationDopesheet.jsx.

import { useCallback, useEffect, useRef } from 'react'
import { writePaneSize } from '../../utils/vfx/panes.js'
import './VfxSplitter.css'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64

/**
 * @param {Object} props
 * @param {'vertical'|'horizontal'} props.orientation vertical = resizes width
 * @param {{current: HTMLElement|null}} props.targetRef element carrying the variable
 * @param {string} props.variable CSS custom property to write, e.g. '--vfx-preview-w'
 * @param {number} props.value current size in px (React's copy)
 * @param {(next: number) => void} props.onCommit called once, on pointerup
 * @param {number} props.min
 * @param {number} props.max maximum in px, or a function of the container
 * @param {number} [props.defaultValue] double-click resets to this
 * @param {boolean} [props.invert] true when dragging TOWARDS the pane shrinks it
 *   (a handle on the pane's left edge, i.e. the preview pane)
 * @param {string} props.label accessible name
 * @param {string} [props.storageKey] persists the committed size
 * @param {string} [props.className] extra classes - the page uses this to pin
 *   the handle to an explicit grid column
 */
export default function VfxSplitter({
  orientation = 'vertical',
  targetRef,
  variable,
  value,
  onCommit,
  min = 160,
  max = 1200,
  defaultValue = null,
  invert = false,
  label = 'Resize pane',
  storageKey = null,
  className = '',
}) {
  const drag = useRef(null)
  const frame = useRef(0)
  const pending = useRef(0)

  const clamp = useCallback(next => Math.max(min, Math.min(max, next)), [max, min])

  // One place that writes the variable, so the drag path, the keyboard path and
  // the reset path cannot disagree about units.
  const paint = useCallback(next => {
    const target = targetRef?.current
    if (target) target.style.setProperty(variable, `${Math.round(next)}px`)
  }, [targetRef, variable])

  const flush = useCallback(() => {
    frame.current = 0
    paint(pending.current)
  }, [paint])

  const handlePointerDown = useCallback(event => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    // The size at drag start, read ONCE. Deltas accumulate against this rather
    // than against the previous frame, so rounding cannot drift over a long
    // drag and a re-render mid-drag cannot move the origin.
    drag.current = {
      start: orientation === 'vertical' ? event.clientX : event.clientY,
      base: value,
    }
    pending.current = value
    document.body.classList.add(orientation === 'vertical' ? 'is-col-resizing' : 'is-row-resizing')
  }, [orientation, value])

  const handlePointerMove = useCallback(event => {
    if (!drag.current) return
    const position = orientation === 'vertical' ? event.clientX : event.clientY
    const delta = position - drag.current.start
    pending.current = clamp(drag.current.base + (invert ? -delta : delta))
    // Coalesced: a high-rate mouse or a pen can fire several moves per frame,
    // and each one would otherwise trigger its own style recalc and canvas
    // resize.
    if (!frame.current) frame.current = window.requestAnimationFrame(flush)
  }, [clamp, flush, invert, orientation])

  const endDrag = useCallback(event => {
    if (!drag.current) return
    drag.current = null
    document.body.classList.remove('is-col-resizing', 'is-row-resizing')
    if (frame.current) {
      window.cancelAnimationFrame(frame.current)
      frame.current = 0
    }
    // Paint before committing: React's render will set the same value from the
    // prop, so painting first means no frame where the pane snaps back.
    paint(pending.current)
    onCommit?.(pending.current)
    if (storageKey) writePaneSize(storageKey, pending.current)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Capture was already released - a lost capture, or the element went away.
    }
  }, [onCommit, paint, storageKey])

  const nudge = useCallback(amount => {
    const next = clamp(value + amount)
    paint(next)
    onCommit?.(next)
    if (storageKey) writePaneSize(storageKey, next)
  }, [clamp, onCommit, paint, storageKey, value])

  const handleKeyDown = useCallback(event => {
    const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    if (event.key === back) nudge(invert ? step : -step)
    else if (event.key === forward) nudge(invert ? -step : step)
    else if (event.key === 'Home' && defaultValue != null) nudge(defaultValue - value)
    else return
    event.preventDefault()
  }, [defaultValue, invert, nudge, orientation, value])

  const handleDoubleClick = useCallback(() => {
    if (defaultValue != null) nudge(defaultValue - value)
  }, [defaultValue, nudge, value])

  // The class survives an unmount mid-drag - a pane that disappears while being
  // dragged would otherwise leave the whole document with a resize cursor and
  // no text selection.
  useEffect(() => () => {
    document.body.classList.remove('is-col-resizing', 'is-row-resizing')
  }, [])

  return (
    <div
      className={`vfx-splitter is-${orientation}${className ? ` ${className}` : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      title={defaultValue != null ? `${label} (double-click to reset)` : label}
    >
      <span className="vfx-splitter__grip" aria-hidden="true" />
    </div>
  )
}
