// "The preview never fails silently."
//
// After a grace period with nothing drawn, this names the FIRST render-blocking
// cause in causal order and offers its fix. The decision table is pure and
// lives in src/utils/vfx/blame.js; this component supplies the two things the
// table cannot compute on its own - the live stats and whether the effect is
// inside the camera frustum - and draws the answer.
//
// THE GRACE PERIOD IS LOAD-BEARING. Every effect is empty at t = 0, a burst
// effect is empty between clips, and a recompile restarts the sim. Showing the
// overlay immediately would make it flash on every edit, and an overlay that
// flashes is one the author learns to ignore. 800 ms is long enough that a
// normal frame gap never trips it and short enough that a genuinely broken
// effect explains itself before the author starts hunting.
//
// IT POLLS AT 4 Hz, matching VfxPreviewHud. The stats it reads are written to a
// ref every frame by VfxSystemView; reading them into React state at frame rate
// would make this overlay the most expensive thing on the page, which for a
// component that is invisible almost all of the time would be absurd.
//
// THE FRUSTUM TEST IS THE POINT. "Nothing is being produced" and "particles
// exist but the camera cannot see them" look identical and have opposite fixes.
// Getting that wrong sends the author to edit a graph that was working.

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { BLAME_ACTION, diagnoseEmptyPreview } from '../../utils/vfx/blame.js'
import { liveParticleBounds } from '../../utils/vfxThumbnail.js'
import './VfxEmptyOverlay.css'

const POLL_MS = 250
const GRACE_MS = 800

// Module-level scratch, the house idiom. Only one overlay is ever mounted.
const frustum = new THREE.Frustum()
const projectionView = new THREE.Matrix4()

/**
 * Whether any live particle is inside the camera's frustum.
 *
 * Returns null when it cannot be decided - no camera yet, or nothing alive to
 * test - so the table can tell "off screen" apart from "not known", and never
 * reports an effect as off screen on the strength of a missing camera.
 */
function isOnScreen(runtime, camera) {
  if (!runtime || !camera) return null
  const box = liveParticleBounds(runtime)
  if (box.isEmpty()) return null
  camera.updateMatrixWorld()
  projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(projectionView)
  return frustum.intersectsBox(box)
}

/**
 * @param {Object} props
 * @param {{current: Object}} props.statsRef written per frame by VfxSystemView
 * @param {Object|null} props.runtime
 * @param {{current: Object|null}} props.cameraRef
 * @param {Array<Object>} props.diagnostics compile diagnostics
 * @param {boolean} props.playing
 * @param {number} props.mutedSystems
 * @param {number} props.totalSystems
 * @param {(action: string) => void} props.onAction
 * @param {(fix: Object) => void} props.onFix
 * @param {(fix: Object) => boolean} props.canFix
 */
export default function VfxEmptyOverlay({
  statsRef,
  runtime,
  cameraRef,
  diagnostics = [],
  playing = true,
  mutedSystems = 0,
  totalSystems = 1,
  onAction,
  onFix,
  canFix,
}) {
  const [blame, setBlame] = useState(null)
  // When the preview last had something visible. Held in a ref so the grace
  // period does not itself cause a render. Initialised to 0 rather than to
  // performance.now(): calling a clock during render is impure, and the effect
  // below sets it before the first poll can read it.
  const lastGoodRef = useRef(0)

  useEffect(() => {
    // Reset on every (re)start of the poll, which includes a recompile handing
    // over a fresh runtime. Without it, editing a working effect would show the
    // overlay for one poll while the new simulation warmed up.
    //
    // A ref write, deliberately - not setBlame(null). Clearing the state here
    // would be a synchronous setState in an effect body, and it is not needed:
    // the next poll is at most 250 ms away and recomputes the answer from
    // scratch.
    lastGoodRef.current = performance.now()

    const id = window.setInterval(() => {
      const stats = statsRef.current || {}
      const onScreen = isOnScreen(runtime, cameraRef.current)
      const visible = (stats.drawn || 0) > 0 && onScreen !== false

      if (visible) {
        lastGoodRef.current = performance.now()
        setBlame(current => (current ? null : current))
        return
      }
      if (performance.now() - lastGoodRef.current < GRACE_MS) return

      const next = diagnoseEmptyPreview({
        diagnostics,
        spawned: stats.spawned || 0,
        alive: stats.alive || 0,
        drawn: stats.drawn || 0,
        playing,
        finished: Boolean(stats.finished),
        mutedSystems,
        totalSystems,
        onScreen,
      })
      // Compared by code, not by identity: the table builds a fresh object each
      // poll, and replacing an identical one four times a second would re-render
      // the overlay for nothing.
      setBlame(current => (current?.code === next?.code ? current : next))
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [cameraRef, diagnostics, mutedSystems, playing, runtime, statsRef, totalSystems])

  if (!blame) return null

  const fixable = blame.fix && canFix?.(blame.fix)

  return (
    <div className="vfx-empty" role="status">
      <div className="vfx-empty__card">
        <span className="material-symbols-outlined vfx-empty__icon">visibility_off</span>
        <div className="vfx-empty__text">
          <strong>{blame.title}</strong>
          <p>{blame.message}</p>
        </div>
        <div className="vfx-empty__actions">
          {fixable && (
            <button type="button" className="is-primary" onClick={() => onFix(blame.fix)}>
              {blame.fix.label}
            </button>
          )}
          {blame.action && (
            <button
              type="button"
              className={fixable ? '' : 'is-primary'}
              onClick={() => onAction(blame.action)}
            >
              {blame.actionLabel}
            </button>
          )}
          {/* A dismiss is deliberately absent. The overlay disappears the
              moment something is drawn, so a dismiss button would only let the
              author hide a message they still need - and it would have to
              remember not to come back, which is state that means "I am
              ignoring a broken effect". */}
        </div>
      </div>
    </div>
  )
}

export { BLAME_ACTION }
