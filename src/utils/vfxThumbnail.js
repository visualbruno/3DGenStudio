// The picture on a VFX asset card.
//
// TWO WAYS TO GET ONE, and which is used depends on whether there is a live
// preview to borrow from.
//
// 1. THE LIVE FRAME (preferred, and what the editor uses). The particles that
//    are on screen right now, from the camera the author has orbited to, at
//    the moment they pressed Save. Pause the timeline on the frame that looks
//    best and that is the frame that becomes the card. This is the one people
//    actually want: the effect's best moment is a judgement call, and the
//    author is the only one in a position to make it.
//
// 2. A SIMULATED FRAME (the fallback). Run from t=0 with the effect's own seed
//    for a FIXED number of fixed-size steps and capture at 45% of the
//    duration, capped at 1.2s, framing the camera on whatever is alive. Used
//    when there is no runtime to read - a save from MCP, a batch re-thumbnail,
//    or a live frame that turned out to be empty.
//
// WHY THE WARM-UP EXISTS IN PATH 2: an effect at t=0 is a single bright dot at
// the origin, because nothing has moved yet. Capturing there would give every
// effect in the library the same thumbnail.
//
// THE DETERMINISM TRADE IS DELIBERATE. Path 2 is reproducible - saving the
// same effect twice produces the same bytes, which is only possible because
// the runtime is deterministic (see the header of vfx/random.js). Path 1 is
// NOT: it depends on when Save was pressed and where the camera was, so two
// saves of an unchanged effect can differ and a diff of two exports may show a
// changed thumbnail. That is the right trade here - a card the author chose
// beats a card that is merely stable - but it is a trade, so it is written
// down rather than discovered.
//
// IT NEVER TOUCHES THE PREVIEW'S OWN OBJECTS. `scene.add(mesh)` in three
// REPARENTS: adding the live batch meshes to a capture scene would remove them
// from the R3F scene and blank the viewport. So the capture builds its own
// batches - fresh geometry and materials - reading the SAME pools. Only the
// textures are shared, and those are not owned here.
//
// TONE MAPPING IS ACES IN BOTH PATHS. The particle materials include three's
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

/**
 * How many particles are alive across every system.
 *
 * Exported for the tests: it is what decides between the live frame and the
 * simulated fallback, and getting it wrong means either a blank card or the
 * author's chosen frame being silently discarded.
 *
 * @param {Object} runtime
 * @returns {number}
 */
export function aliveCount(runtime) {
  let total = 0
  for (const emitter of runtime.emitters) total += emitter.pool.count
  return total
}

/**
 * The bounding box of every live particle, so the camera frames what is
 * actually on screen rather than the effect's declared bounds - which are a
 * worst case and would leave a small effect as a speck in the middle.
 *
 * Exported for the tests. See the note inside about why the radius is applied
 * once rather than per particle.
 *
 * @param {Object} runtime
 * @returns {THREE.Box3}
 */
export function liveParticleBounds(runtime) {
  const box = new THREE.Box3()
  box.makeEmpty()
  const point = new THREE.Vector3()
  let maxRadius = 0
  for (const emitter of runtime.emitters) {
    const { planes, count } = emitter.pool
    const position = planes.position
    const size = planes.size
    for (let i = 0; i < count; i += 1) {
      point.set(position[i * 3], position[i * 3 + 1], position[i * 3 + 2])
      box.expandByPoint(point)
      // The LARGEST radius, applied once at the end. A billboard extends beyond
      // its centre so the box has to grow, but growing it per particle - which
      // the first version of this did - adds the SUM of every radius: a
      // thousand particles of size 0.1 inflated the box by fifty units and
      // framed the effect as a distant speck.
      if (size && size[i] > maxRadius) maxRadius = size[i]
    }
  }
  if (!box.isEmpty() && maxRadius > 0) box.expandByScalar(maxRadius * 0.5)
  return box
}

/**
 * A square camera matching a live one.
 *
 * The vertical field of view is kept and the aspect forced to 1, so the card
 * shows the same vertical extent as the viewport, cropped horizontally. That is
 * the predictable answer: what the author framed vertically is what they get.
 *
 * The transform is taken from `matrixWorld` rather than from the local
 * position/quaternion, so a camera that turns out to be parented to a rig still
 * captures from where it actually is.
 */
function squareCameraFrom(source) {
  const camera = source.clone()
  source.updateMatrixWorld()
  source.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale)

  if (camera.isPerspectiveCamera) {
    camera.aspect = 1
  } else if (camera.isOrthographicCamera) {
    const halfHeight = (camera.top - camera.bottom) / 2
    const centreX = (camera.left + camera.right) / 2
    camera.left = centreX - halfHeight
    camera.right = centreX + halfHeight
  }
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

/** A camera framed on whatever is alive, for the simulated path. */
function framedCamera(runtime, ir) {
  const box = liveParticleBounds(runtime)
  // An empty box means nothing was alive at the capture time - a burst that has
  // already died, or an effect with no spawn. Fall back to the declared bounds
  // so the render is a dark card rather than a crash.
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
  camera.updateMatrixWorld(true)
  return camera
}

/**
 * Render one frame of a runtime's CURRENT state to a PNG blob.
 *
 * @param {Object} ir
 * @param {Object} runtime whose pools are read as they stand
 * @param {THREE.Camera} camera
 * @param {Map<number, THREE.Texture>} textures
 * @param {Map<number, Object>} meshes
 * @param {number} size
 * @returns {Promise<Blob>}
 */
async function renderRuntimeFrame(ir, runtime, camera, textures, meshes, size) {
  // Fresh batches over the SAME pools - see the reparenting note in the header.
  const batches = createBatches(ir, runtime.emitters, { textures, meshes })
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#121316')

  try {
    const view = new THREE.Vector3()
    camera.getWorldDirection(view)
    for (const batch of batches) {
      writeBatch(batch, view)
      scene.add(batch.mesh)
    }
    return await renderSceneToBlob(scene, camera, {
      size,
      clearColor: '#121316',
      // Matches the preview viewport, which uses R3F's default. See the header.
      toneMapping: THREE.ACESFilmicToneMapping,
    })
  } finally {
    // The batches are ours, so they are ours to release. Nothing here relies on
    // R3F, which never saw this scene - and critically, the meshes disposed
    // here are the capture's own, never the preview's.
    for (const batch of batches) {
      scene.remove(batch.mesh)
      disposeBatch(batch)
    }
  }
}

/**
 * Render a compiled effect to a PNG File, ready to POST as a thumbnail.
 *
 * @param {Object} ir compiled IR
 * @param {Object} [options]
 * @param {string} [options.name] used for the filename
 * @param {number} [options.size]
 * @param {Object} [options.runtime] a LIVE runtime; its current pool state is
 *   captured as-is, with no stepping. This is the "pause on the frame you like"
 *   path. Falls back to a simulated frame when nothing is alive.
 * @param {THREE.Camera} [options.camera] the live preview camera. Only used
 *   alongside `runtime` - a camera pointed at a simulation that has not run
 *   would frame nothing.
 * @param {number} [options.captureTime] override for the simulated path
 * @param {Map<number, THREE.Texture>} [options.textures]
 * @param {Map<number, Object>} [options.meshes] loaded particle meshes; without
 *   them a mesh output falls back to the built-in chip, so a card would not
 *   match the preview beside it
 * @returns {Promise<File>}
 */
export async function createVfxThumbnailFile(ir, options = {}) {
  const size = options.size || THUMBNAIL_SIZE
  const textures = options.textures || new Map()
  const meshes = options.meshes || new Map()
  const safeName = String(options.name || ir.effect?.name || 'effect').replace(/[^\w.-]+/g, '_')
  const toFile = blob => new File([blob], `${safeName}-thumbnail.png`, { type: 'image/png' })

  // --- Path 1: the frame on screen ----------------------------------------
  //
  // Guarded on something being alive. A live frame at t=0, or after a one-shot
  // burst has died, is an empty card - and silently saving that would look like
  // the thumbnail feature is broken rather than like the author caught the
  // effect at a bad moment.
  if (options.runtime && options.camera && aliveCount(options.runtime) > 0) {
    return toFile(await renderRuntimeFrame(
      ir,
      options.runtime,
      squareCameraFrom(options.camera),
      textures,
      meshes,
      size,
    ))
  }

  // --- Path 2: a simulated frame ------------------------------------------
  const duration = ir.effect.duration > 0
    ? ir.effect.duration
    : CAPTURE_CAP_SECONDS / CAPTURE_FRACTION
  const captureTime = Number.isFinite(options.captureTime)
    ? options.captureTime
    : Math.min(duration * CAPTURE_FRACTION, CAPTURE_CAP_SECONDS)

  // A private runtime, so this never disturbs a preview that may be running.
  const runtime = createVfxRuntime(ir)
  // A whole number of fixed steps, computed from the target time rather than
  // accumulated from a clock - that is what makes two runs identical.
  const steps = Math.max(1, Math.round(captureTime / ir.effect.fixedDt))
  for (let i = 0; i < steps; i += 1) step(runtime)

  return toFile(await renderRuntimeFrame(
    ir,
    runtime,
    framedCamera(runtime, ir),
    textures,
    meshes,
    size,
  ))
}
