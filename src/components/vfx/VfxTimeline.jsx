// The timeline dock: one track per system, clips are spawn windows.
//
// WHAT A CLIP MEANS. `{ at, duration, loop }` is a window during which that
// system's Spawn context is active. `duration: 0` is a one-shot burst (which is
// what most impacts are made of, so it gets its own marker shape rather than a
// zero-width bar nobody can grab); `duration > 0` is a rate-spawn window;
// `loop` repeats the clip to the end of the effect. SEVERAL CLIPS ON ONE TRACK
// is how the same system fires more than once, and it is the case this whole
// dock exists for.
//
// IT IS SUGAR OVER MACHINERY THAT ALREADY EXISTS, not a parallel timing system:
// the compiler lowers these clips into a per-system activation table that the
// spawn kernel consults, with times snapped to `fixedDt` multiples so
// scheduling stays deterministic. That snapping is applied HERE too, while
// dragging, so the number the author sees is the number the compiler will use -
// a UI that let them set 0.333 and then silently ran at 0.3333 would make the
// preview look wrong for no visible reason.
//
// THE DOCK OWNS THE TRANSPORT AND THE PLAYHEAD, so the preview panel has no
// scrubber of its own. One playhead drives the preview, the ruler and (from
// phase 7) the curve editor's playhead line, which is what makes the effect
// read as one object across all three surfaces.
//
// THE PLAYHEAD IS NOT REACT STATE. It moves every frame; a setState per frame
// would re-render every track and every clip sixty times a second. A rAF loop
// writes one `transform` on one element - the same discipline as
// VfxPreviewHud's 4 Hz state flush, taken one step further because this needs
// to be smooth rather than merely current.
//
// THE TRACK LIST DOUBLES AS THE SYSTEM MANAGER, which the editor otherwise
// lacked: rename, reorder, add, duplicate, delete, a colour swatch matching the
// board node's accent, and mute/solo. Solo is the most useful debugging
// affordance in a five-system effect and costs one boolean.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './VfxTimeline.css'

const TRACK_HEIGHT = 26
const MIN_CLIP_PX = 10
const BURST_WIDTH_PX = 8
const RULER_TARGET_SPACING = 64

/** Round to a multiple of the simulation step, which is what the compiler does. */
function snap(seconds, step) {
  if (!(step > 0)) return Math.max(0, seconds)
  return Math.max(0, Math.round(seconds / step) * step)
}

/** Tick spacing that gives roughly RULER_TARGET_SPACING pixels per label. */
function chooseTickStep(duration, width) {
  const rough = (duration * RULER_TARGET_SPACING) / Math.max(1, width)
  for (const candidate of [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]) {
    if (candidate >= rough) return candidate
  }
  return 10
}

const formatTime = seconds => `${seconds.toFixed(2)}s`

/**
 * @param {Object} props
 * @param {Object} props.doc
 * @param {Object} props.actions the page's edit bundle
 * @param {boolean} props.playing
 * @param {() => void} props.onTogglePlay
 * @param {() => void} props.onRestart
 * @param {() => void} props.onStep
 * @param {(seconds: number) => void} props.onSeek
 * @param {() => number} props.getTime current sim time, read per frame
 * @param {number} props.timescale
 * @param {(next: number) => void} props.onTimescale
 * @param {string|null} props.selectedSystemId
 * @param {boolean} props.collapsed
 * @param {() => void} props.onToggleCollapsed
 */
export default function VfxTimeline({
  doc,
  actions,
  playing,
  onTogglePlay,
  onRestart,
  onStep,
  onSeek,
  getTime,
  timescale = 1,
  onTimescale,
  selectedSystemId = null,
  collapsed = false,
  onToggleCollapsed,
}) {
  const lanesRef = useRef(null)
  const playheadRef = useRef(null)
  const readoutRef = useRef(null)
  const drag = useRef(null)
  const frame = useRef(0)
  const [laneWidth, setLaneWidth] = useState(600)

  const duration = doc.effect.duration || 1
  const step = doc.effect.fixedDt || 1 / 60
  const pps = laneWidth / duration

  // Measured rather than assumed: the dock spans all three panes and its width
  // changes whenever the params pane opens or a splitter moves.
  useLayoutEffect(() => {
    const element = lanesRef.current
    if (!element) return undefined
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width
      if (width > 0) setLaneWidth(width)
    })
    observer.observe(element)
    setLaneWidth(element.clientWidth || 600)
    return () => observer.disconnect()
  }, [collapsed])

  // The playhead loop. Runs whether or not the sim is playing, because a seek
  // or a single step has to move it too, and one rAF that writes two DOM
  // properties is cheaper than the bookkeeping to start and stop it.
  useEffect(() => {
    let raf = 0
    let lastText = ''
    const tick = () => {
      raf = window.requestAnimationFrame(tick)
      const time = getTime?.() ?? 0
      const head = playheadRef.current
      if (head) {
        // transform, not `left`: `left` invalidates layout for the whole dock
        // every frame, transform is a compositor-only change.
        head.style.transform = `translateX(${(time / duration) * laneWidth}px)`
      }
      const readout = readoutRef.current
      const text = formatTime(time)
      if (readout && text !== lastText) {
        lastText = text
        readout.textContent = text
      }
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [duration, getTime, laneWidth])

  // --- clip dragging -------------------------------------------------------

  const flush = useCallback(() => {
    frame.current = 0
    const current = drag.current
    if (!current) return
    const { element, at, length } = current.preview
    element.style.left = `${at * pps}px`
    if (current.mode !== 'move' || length > 0) {
      element.style.width = `${Math.max(length * pps, length > 0 ? MIN_CLIP_PX : BURST_WIDTH_PX)}px`
    }
  }, [pps])

  const handleMove = useCallback(event => {
    const current = drag.current
    if (!current) return
    // Screen pixels straight to seconds: the dock is NOT inside a scaled
    // viewport, so there is no zoom division here - unlike the block-row drag,
    // which lives inside React Flow's transform.
    const delta = (event.clientX - current.startX) / pps
    // Shift is the fine modifier everywhere in this editor; here it means
    // "ignore the step grid" so a clip can sit between two simulation frames
    // even though the compiler will round it.
    const quantize = value => (event.shiftKey ? Math.max(0, value) : snap(value, step))

    if (current.mode === 'move') {
      current.preview.at = Math.min(
        Math.max(0, quantize(current.baseAt + delta)),
        Math.max(0, duration - current.baseDuration),
      )
    } else if (current.mode === 'end') {
      current.preview.length = Math.max(0, quantize(current.baseDuration + delta))
    } else {
      // Trimming the start moves `at` and shortens `duration` by the same
      // amount, so the clip's END stays where it is. Dragging the left edge and
      // watching the right edge move is the classic timeline annoyance.
      const nextAt = Math.min(
        Math.max(0, quantize(current.baseAt + delta)),
        current.baseAt + current.baseDuration,
      )
      current.preview.at = nextAt
      current.preview.length = current.baseAt + current.baseDuration - nextAt
    }
    if (!frame.current) frame.current = window.requestAnimationFrame(flush)
  }, [duration, flush, pps, step])

  // The listeners are torn down through a ref rather than by naming endDrag
  // inside itself: a useCallback cannot reference its own identity, and the
  // one that closed over a stale copy would leave a listener attached for the
  // life of the page.
  const detach = useRef(() => {})

  const endDrag = useCallback(() => {
    const current = drag.current
    drag.current = null
    detach.current()
    document.body.classList.remove('is-col-resizing')
    if (frame.current) {
      window.cancelAnimationFrame(frame.current)
      frame.current = 0
    }
    if (!current || !current.moved) return
    // The inline styles are cleared so React's render owns the geometry again.
    // Done BEFORE the commit so there is no frame where both apply.
    current.preview.element.style.left = ''
    current.preview.element.style.width = ''
    actions.updateClip(current.systemId, current.clipId, {
      at: current.preview.at,
      duration: current.preview.length,
    })
  }, [actions])

  const startClipDrag = useCallback((event, systemId, clip, mode) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget.closest('[data-clip-id]')
    if (!element) return
    drag.current = {
      systemId,
      clipId: clip.id,
      mode,
      startX: event.clientX,
      baseAt: clip.at,
      baseDuration: clip.duration,
      moved: false,
      preview: { element, at: clip.at, length: clip.duration },
    }
    // Set immediately rather than after a slop threshold: a click on a clip
    // also selects its system, and there is no competing gesture to protect.
    drag.current.moved = true
    document.body.classList.add('is-col-resizing')
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    detach.current = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [endDrag, handleMove])

  useEffect(() => () => {
    detach.current()
    document.body.classList.remove('is-col-resizing')
  }, [])

  // --- scrubbing -----------------------------------------------------------

  const scrubFrom = useCallback(event => {
    const lanes = lanesRef.current
    if (!lanes) return
    const rect = lanes.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onSeek?.(snap(ratio * duration, step))
  }, [duration, onSeek, step])

  const handleRulerDown = useCallback(event => {
    event.currentTarget.setPointerCapture(event.pointerId)
    scrubFrom(event)
  }, [scrubFrom])

  const handleRulerMove = useCallback(event => {
    if (event.buttons !== 1) return
    scrubFrom(event)
  }, [scrubFrom])

  // --- render --------------------------------------------------------------

  const tickStep = chooseTickStep(duration, laneWidth)
  const ticks = []
  for (let t = 0; t <= duration + 1e-6; t += tickStep) ticks.push(Number(t.toFixed(4)))

  const anySolo = doc.systems.some(system => system.solo)

  return (
    <section className={`vfx-timeline${collapsed ? ' is-collapsed' : ''}`} aria-label="Timeline">
      <header className="vfx-timeline__bar">
        <button
          type="button"
          className="vfx-timeline__collapse"
          onClick={onToggleCollapsed}
          title={collapsed ? 'Show the timeline' : 'Hide the timeline'}
          aria-expanded={!collapsed}
        >
          <span className="material-symbols-outlined">
            {collapsed ? 'expand_less' : 'expand_more'}
          </span>
          Timeline
        </button>

        <div className="vfx-timeline__transport">
          <button type="button" onClick={onRestart} title="Restart from the beginning">
            <span className="material-symbols-outlined">replay</span>
          </button>
          <button type="button" onClick={onTogglePlay} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
            <span className="material-symbols-outlined">{playing ? 'pause' : 'play_arrow'}</span>
          </button>
          <button type="button" onClick={onStep} title="Step one simulation frame">
            <span className="material-symbols-outlined">skip_next</span>
          </button>
        </div>

        {/* Written by the rAF loop, not by React - see the header. */}
        <span className="vfx-timeline__time">
          <strong ref={readoutRef}>0.00s</strong>
          {' / '}
          {formatTime(duration)}
        </span>

        <label className="vfx-timeline__speed" title="Slow the whole effect down to see what it is doing. Changes nothing in the document.">
          <span>Speed</span>
          <select value={timescale} onChange={event => onTimescale?.(Number(event.target.value))}>
            <option value={0.1}>0.1x</option>
            <option value={0.25}>0.25x</option>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
          </select>
        </label>

        <label className="vfx-timeline__loop" title="Restart the effect when it reaches the end.">
          <input
            type="checkbox"
            checked={Boolean(doc.effect.loop)}
            onChange={event => actions.setEffectSettings({ loop: event.target.checked })}
          />
          Loop effect
        </label>

        <button
          type="button"
          className="vfx-timeline__add"
          onClick={() => actions.addSystem()}
          title="Add another system: its own particles, its own capacity, its own track."
        >
          <span className="material-symbols-outlined">add</span>
          System
        </button>
      </header>

      {!collapsed && (
        <div className="vfx-timeline__grid">
          <div className="vfx-timeline__tracks">
            <div className="vfx-timeline__tracks-head">Systems</div>
            {doc.systems.map((system, index) => (
              <div
                key={system.id}
                className={[
                  'vfx-timeline__track',
                  selectedSystemId === system.id ? 'is-selected' : '',
                  system.enabled === false ? 'is-muted' : '',
                  anySolo && !system.solo ? 'is-silenced' : '',
                ].filter(Boolean).join(' ')}
                style={{ '--vfx-track-accent': `var(--vfx-accent-${index % 6})` }}
              >
                <span className="vfx-timeline__swatch" aria-hidden="true" />
                <button
                  type="button"
                  className="vfx-timeline__name"
                  onClick={() => actions.selectSystem(system.id)}
                  title={`${system.name} - capacity ${system.capacity}`}
                >
                  {system.name}
                </button>
                <button
                  type="button"
                  className={`vfx-timeline__flag${system.enabled === false ? ' is-on' : ''}`}
                  onClick={() => actions.updateSystem(system.id, { enabled: system.enabled === false })}
                  title={system.enabled === false ? 'Unmute' : 'Mute: stop this system emitting'}
                  aria-label="Mute"
                >
                  <span className="material-symbols-outlined">
                    {system.enabled === false ? 'volume_off' : 'volume_up'}
                  </span>
                </button>
                <button
                  type="button"
                  className={`vfx-timeline__flag${system.solo ? ' is-on' : ''}`}
                  onClick={() => actions.updateSystem(system.id, { solo: !system.solo })}
                  title="Solo: silence every other system, to see what this one does"
                  aria-label="Solo"
                  aria-pressed={Boolean(system.solo)}
                >
                  <span className="material-symbols-outlined">headphones</span>
                </button>
              </div>
            ))}
          </div>

          <div className="vfx-timeline__lanes-wrap">
            <div
              className="vfx-timeline__ruler"
              onPointerDown={handleRulerDown}
              onPointerMove={handleRulerMove}
              role="slider"
              tabIndex={0}
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={0}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') onSeek?.(Math.max(0, (getTime?.() || 0) - step))
                else if (event.key === 'ArrowRight') onSeek?.((getTime?.() || 0) + step)
                else return
                event.preventDefault()
              }}
            >
              {ticks.map(tick => (
                <span
                  key={tick}
                  className="vfx-timeline__tick"
                  style={{ left: `${(tick / duration) * 100}%` }}
                >
                  {tick === 0 ? '0' : tick.toFixed(tickStep < 0.1 ? 2 : tickStep < 1 ? 2 : 0)}
                </span>
              ))}
            </div>

            <div className="vfx-timeline__lanes" ref={lanesRef}>
              {doc.systems.map((system, index) => (
                <div
                  key={system.id}
                  className="vfx-timeline__lane"
                  style={{
                    height: TRACK_HEIGHT,
                    '--vfx-track-accent': `var(--vfx-accent-${index % 6})`,
                  }}
                  onDoubleClick={event => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    const at = snap(((event.clientX - rect.left) / rect.width) * duration, step)
                    actions.addClip(system.id, { at, duration: 0 })
                  }}
                  title="Double-click to add a burst here"
                >
                  {system.schedule.clips.map(clip => {
                    const burst = clip.duration <= 0
                    return (
                      <div
                        key={clip.id}
                        data-clip-id={clip.id}
                        className={[
                          'vfx-timeline__clip',
                          burst ? 'is-burst' : '',
                          clip.loop ? 'is-loop' : '',
                        ].filter(Boolean).join(' ')}
                        style={{
                          left: `${clip.at * pps}px`,
                          width: burst
                            ? BURST_WIDTH_PX
                            : `${Math.max(clip.duration * pps, MIN_CLIP_PX)}px`,
                        }}
                        title={burst
                          ? `Burst at ${formatTime(clip.at)}. Drag the right edge to turn it into a window.`
                          : `${formatTime(clip.at)} to ${formatTime(clip.at + clip.duration)}${clip.loop ? ', repeating' : ''}`}
                      >
                        {!burst && (
                          <span
                            className="vfx-timeline__handle is-start"
                            onPointerDown={event => startClipDrag(event, system.id, clip, 'start')}
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className="vfx-timeline__clip-body"
                          onPointerDown={event => startClipDrag(event, system.id, clip, 'move')}
                        />
                        <span
                          className="vfx-timeline__handle is-end"
                          onPointerDown={event => startClipDrag(event, system.id, clip, 'end')}
                          aria-hidden="true"
                        />
                        <span className="vfx-timeline__clip-tools">
                          <button
                            type="button"
                            className={clip.loop ? 'is-on' : ''}
                            onClick={() => actions.updateClip(system.id, clip.id, { loop: !clip.loop })}
                            title="Repeat this clip to the end of the effect"
                            aria-label="Loop clip"
                          >
                            <span className="material-symbols-outlined">repeat</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => actions.removeClip(system.id, clip.id)}
                            title={system.schedule.clips.length <= 1
                              ? 'A track needs at least one clip - delete the system instead'
                              : 'Delete this clip'}
                            disabled={system.schedule.clips.length <= 1}
                            aria-label="Delete clip"
                          >
                            <span className="material-symbols-outlined">close</span>
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}

              <div className="vfx-timeline__playhead" ref={playheadRef} aria-hidden="true" />
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
