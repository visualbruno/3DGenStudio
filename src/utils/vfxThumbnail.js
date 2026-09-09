// The picture on a VFX asset card.
//
// ONE DETERMINISTIC FRAME, not a composite and not an animation. The Assets
// grid shows a static 512px image, and a composite of an explosion is grey
// mush. What makes a single frame work is choosing the right one and choosing
// it the same way every time.
//
// WHICH FRAME: run from t=0 with the effect's own seed for a FIXED number of
// fixed-size steps, and capture at 45% of the effect's duration, capped at
// 1.2s. Two things about that are deliberate:
//
//   - the warm-up matters. An effect at t=0 is a single bright dot at the
//     origin, because nothing has moved yet. Capturing there would give every
//     effect in the library the same thumbnail.
//   - the fixed step count is what makes it REPRODUCIBLE. Saving the same
//     effect twice has to produce the same card, or the grid flickers between
//     saves and a diff of two exports shows a changed thumbnail for no reason.
//     This is only possible because the runtime is deterministic - see the
//     header of vfx/random.js.
//
// TONE MAPPING IS ACES HERE TOO. The particle materials include three's
// tonemapping chunk gated on the renderer's own setting, so a thumbnail
// rendered with the default NoToneMapping would come out brighter and more
// saturated than the same effect in the preview. The card has to look like the
// thing it is a picture of.
//
// ALWAYS BEST-EFFORT. The caller wraps this in a try/catch and saves anyway.
// The effect is already stored; losing the save over a cosmetic render would
// be the wrong trade, and the house rule is written at TreeGenPage.jsx:622.

import * as THREE from 'three'
import { renderSceneToBlob } from './meshThumbnail.js'
import { createBatches, disposeBatch, writeBatch } from './vfx/batch.js'
import { createVfxRuntime, step } from './vfx/system.js'

const THUMBNAIL_SIZE = 512
const CAPTURE_FRACTION = 0.45
const CAPTURE_CAP_SECONDS = 1.2

// The bounding box of every live particle, so the camera frames what is
// actually on screen rather than the effect's declared bounds - which are a
// worst case and would leave a small effect as a speck in the middle.
function liveParticleBounds(runtime) {
  const box = new THREE.Box3()
  box.makeEmpty()
  const point = new THREE.Vector3()
  for (const emitter of runtime.emitters) {
    const { planes, count } = emitter.pool
    const position = planes.position
    const size = planes.size
    for (let i = 0; i < count; i += 1) {
      const radius = size ? size[i] * 0.5 : 0
      point.set(position[i * 3], position[i * 3 + 1], position[i * 3 + 2])
      box.expandByPoint(point)
      // Grown by the particle's own radius: a billboard extends beyond its
      // centre, and framing on centres alone crops the outermost sprites.
      if (radius > 0) {
        box.min.addScalar(-radius)
        box.max.addScalar(radius)
      }
    }
  }
  return box
}

/**
 * Render a compiled effect to a PNG File, ready to POST as a thumbnail.
 *
 * @param {Object} ir compiled IR
 * @param {Object} [options]
 * @param {string} [options.name] used for the filename
 * @param {number} [options.size]
 * @param {number} [options.captureTime] override, in seconds
 * @param {Map<number, THREE.Texture>} [options.textures]
 * @returns {Promise<File>}
 */
export async function createVfxThumbnailFile(ir, options = {}) {
  const size = options.size || THUMBNAIL_SIZE
  const duration = ir.effect.duration > 0 ? ir.effect.duration : CAPTURE_CAP_SECONDS / CAPTURE_FRACTION
  const captureTime = Number.isFinite(options.captureTime)
    ? options.captureTime
    : Math.min(duration * CAPTURE_FRACTION, CAPTURE_CAP_SECONDS)

  const runtime = createVfxRuntime(ir)
  const batches = createBatches(ir, runtime.emitters, { textures: options.textures || new Map() })

  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#121316')

  try {
    // A whole number of fixed steps, computed from the target time rather than
    // accumulated from a clock - that is what makes two runs identical.
    const steps = Math.max(1, Math.round(captureTime / ir.effect.fixedDt))
    for (let i = 0; i < steps; i += 1) step(runtime)

    const box = liveParticleBounds(runtime)
    // An empty box means nothing was alive at the capture time - a burst that
    // has already died, or an effect with no spawn. Fall back to the declared
    // bounds so the render is a dark card rather than a crash.
    if (box.isEmpty()) {
      box.set(
        new THREE.Vector3(...ir.effect.boundsMin),
        new THREE.Vector3(...ir.effect.boundsMax),
      )
    }

    const centre = box.getCenter(new THREE.Vector3())
    const extent = box.getSize(new THREE.Vector3())
    const maxDimension = Math.max(extent.x, extent.y, extent.z, 0.25)
    const distance = maxDimension * 2.2

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, maxDimension * 40)
    camera.position.set(
      centre.x + distance * 0.55,
      centre.y + distance * 0.35,
      centre.z + distance,
    )
    camera.lookAt(centre)
    camera.updateProjectionMatrix()

    camera.getWorldDirection(new THREE.Vector3())
    const view = new THREE.Vector3()
    camera.getWorldDirection(view)
    for (const batch of batches) {
      writeBatch(batch, view)
      scene.add(batch.mesh)
    }

    const blob = await renderSceneToBlob(scene, camera, {
      size,
      clearColor: '#121316',
      // Matches the preview viewport, which uses R3F's default. See the header.
      toneMapping: THREE.ACESFilmicToneMapping,
    })

    const safeName = String(options.name || ir.effect?.name || 'effect').replace(/[^\w.-]+/g, '_')
    return new File([blob], `${safeName}-thumbnail.png`, { type: 'image/png' })
  } finally {
    // The batches are ours, so they are ours to release. Nothing here relies
    // on R3F, which never saw this scene.
    for (const batch of batches) {
      scene.remove(batch.mesh)
      disposeBatch(batch)
    }
  }
}
