// The one component inside the Canvas that knows the simulation exists.
//
// It holds the SINGLE useFrame for the whole effect. Not one per batch: the
// simulation has to finish before any instance buffer is written, and R3F makes
// no promise about the order of sibling useFrame callbacks, so splitting them
// would write half the batches from the previous step's particles. One hook,
// one ordering, no ambiguity.
//
// Priority stays at the default 0. drei's GizmoHelper - which ViewGizmo uses -
// takes over the render loop at priority 1, drawing the scene, clearing depth
// and then drawing the cube on top. Default-priority work runs first, which is
// what we need: the buffers must be filled before anything draws them. The
// header of src/components/meshEditor/ViewGizmo.jsx documents that arrangement.
//
// It holds no particle state of its own. The runtime and the batches are both
// owned by useVfxRuntime, above the Canvas, for the reasons in that hook's
// header. This component is a mount point and a clock.

import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { updateBatch, writeBatch } from '../../utils/vfx/batch.js'
import { advance, runtimeStats, stepAlpha } from '../../utils/vfx/system.js'

// Module-level scratch, the house idiom (see src/utils/meshSculpt.js). Reused
// every frame rather than allocated, and there is only ever one of these
// components mounted at a time.
const cameraDirection = new Vector3()

/**
 * @param {Object} props
 * @param {Object|null} props.runtime
 * @param {Array<Object>} props.batches
 * @param {boolean} props.playing
 * @param {{current: Object}} props.statsRef written each frame; the HUD polls it
 */
export default function VfxSystemView({ runtime, batches, playing, statsRef }) {
  const camera = useThree(state => state.camera)
  const gl = useThree(state => state.gl)

  // Draw-call and triangle counts come from the renderer's own per-frame
  // accounting rather than from our batch list, so the number in the HUD is
  // what the GPU was actually asked to do - including anything else in the
  // scene. R3F resets gl.info each frame.

  useFrame((state, delta) => {
    if (!runtime) return

    if (playing) {
      // Clamped before it reaches the accumulator as well as inside it: a tab
      // that was backgrounded hands back a delta of many seconds, and there is
      // no reason to simulate any of it.
      advance(runtime, Math.min(delta, 0.25))
    }

    camera.getWorldDirection(cameraDirection)
    const alphaDt = playing ? stepAlpha(runtime) * runtime.ir.effect.fixedDt : 0

    let drawn = 0
    for (const batch of batches) {
      updateBatch(batch, { alphaDt })
      // Written every frame, even when paused. A paused effect still has to
      // show its particles - after a seek, after a mute, after the textures
      // finish loading - and skipping the write would leave the last frame's
      // buffer on screen or, worse, an empty one.
      drawn += writeBatch(batch, cameraDirection)
    }

    if (statsRef) {
      const stats = runtimeStats(runtime)
      // Written to a ref at frame rate and read by the HUD at 4Hz. Putting this
      // in React state would re-render the page sixty times a second and make
      // the HUD the most expensive thing on screen.
      statsRef.current = {
        ...stats,
        drawn,
        drawCalls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        kernels: runtime.stats.profile ? runtime.stats.kernels() : null,
      }
    }
  })

  return (
    <>
      {batches.map(batch => (
        // dispose={null} keeps ownership with useVfxRuntime. Without it R3F
        // disposes the geometry and material on unmount - which happens on
        // every WebGL context-loss remount - and the same reasoning is
        // documented on AssemblyPieceMesh.jsx.
        <primitive key={batch.output.contextId} object={batch.mesh} dispose={null} />
      ))}
    </>
  )
}
