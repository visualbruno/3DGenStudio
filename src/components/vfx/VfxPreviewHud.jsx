// The preview's numbers.
//
// READ FROM A REF AT 4Hz, not from React state at frame rate. VfxSystemView
// writes the stats into a ref sixty times a second; this polls it four times a
// second. Driving it from state instead would re-render the page on every frame
// and make the HUD the most expensive thing on screen - which is a comic way
// for a performance readout to behave.
//
// `dropped` IS ALWAYS SHOWN, even at zero. It is the capacity lesson: spawn
// rate times lifetime is how many particles exist at once, and when that
// exceeds the pool the rest are silently never emitted. An author who cannot
// see the number has no way to connect "my effect looks thin" to the cause.
//
// No backdrop-filter. This panel sits directly over a live WebGL canvas, and a
// blurred layer there forces a full canvas readback every composited frame -
// measured at roughly half the framerate in the Electron build. The rule is
// documented in src/pages/AssemblyPage.css and src/pages/TreeGenPage.css.

import { useEffect, useState } from 'react'

const POLL_MS = 250

const number = value => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-')
const ms = value => (Number.isFinite(value) ? value.toFixed(2) : '-')

export default function VfxPreviewHud({ statsRef, showKernels = false }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    const id = setInterval(() => {
      setStats(statsRef.current ? { ...statsRef.current } : null)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [statsRef])

  if (!stats) return null

  const fill = stats.capacity > 0 ? stats.alive / stats.capacity : 0
  const fillClass = fill >= 1 ? 'is-full' : fill > 0.8 ? 'is-high' : ''
  const fps = stats.simMs > 0 ? Math.min(999, 1000 / Math.max(stats.simMs, 1000 / 999)) : null

  return (
    <div className="vfx-hud">
      <div className="vfx-hud__row">
        <span className="vfx-hud__label">alive</span>
        <span className="vfx-hud__value">
          {number(stats.alive)}
          <span className="vfx-hud__dim"> / {number(stats.capacity)}</span>
        </span>
      </div>
      <div className={`vfx-hud__bar ${fillClass}`}>
        <span style={{ width: `${Math.min(100, fill * 100)}%` }} />
      </div>

      <div className="vfx-hud__row">
        <span className="vfx-hud__label">spawned</span>
        <span className="vfx-hud__value">{number(stats.spawned)}</span>
      </div>
      <div className={`vfx-hud__row ${stats.dropped > 0 ? 'is-bad' : ''}`}>
        <span className="vfx-hud__label">dropped</span>
        <span className="vfx-hud__value">{number(stats.dropped)}</span>
      </div>

      <div className="vfx-hud__rule" />

      <div className="vfx-hud__row">
        <span className="vfx-hud__label">sim</span>
        <span className="vfx-hud__value">{ms(stats.simMs)} ms</span>
      </div>
      <div className="vfx-hud__row">
        <span className="vfx-hud__label">worst</span>
        <span className="vfx-hud__value">{ms(stats.worstMs)} ms</span>
      </div>
      <div className="vfx-hud__row">
        <span className="vfx-hud__label">sim headroom</span>
        <span className="vfx-hud__value">{fps ? `${Math.round(fps)}/s` : '-'}</span>
      </div>

      <div className="vfx-hud__rule" />

      <div className="vfx-hud__row">
        <span className="vfx-hud__label">draws</span>
        <span className="vfx-hud__value">{number(stats.drawCalls)}</span>
      </div>
      <div className="vfx-hud__row">
        <span className="vfx-hud__label">tris</span>
        <span className="vfx-hud__value">{number(stats.triangles)}</span>
      </div>
      <div className="vfx-hud__row">
        <span className="vfx-hud__label">time</span>
        <span className="vfx-hud__value">{Number.isFinite(stats.time) ? stats.time.toFixed(2) : '-'}s</span>
      </div>

      {showKernels && stats.kernels && stats.kernels.length > 0 && (
        <>
          <div className="vfx-hud__rule" />
          {/* Worst first, which is the order an author wants: the top row is
              the block to cut. This attribution is the concrete payoff of
              running the block stack as separate kernels rather than one fused
              loop - a fused loop gives one number and no way to act on it. */}
          {stats.kernels.slice(0, 6).map(kernel => (
            <div className="vfx-hud__row" key={kernel.name}>
              <span className="vfx-hud__label">{kernel.name}</span>
              <span className="vfx-hud__value">{kernel.perFrameMs.toFixed(2)} ms</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
