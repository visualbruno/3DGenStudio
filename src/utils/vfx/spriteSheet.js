// Bake a running effect into a flipbook sprite sheet.
//
// WHAT THIS IS FOR: a particle effect that costs four systems and two thousand
// particles here can cost one quad in a game if it is baked to a flipbook. It
// is also the only way to take an effect built in this editor into a renderer
// that has no particle system at all - a UI layer, a shader, a decal.
//
// ONE RENDERER, ONE CANVAS, VIEWPORT PER CELL. The cells are NOT rendered to
// separate images and pasted together, and that is the load-bearing decision
// here. Two reasons:
//
//  1. A fresh WebGLRenderer per cell means one WebGL context per cell, and an
//     8x8 sheet would ask the browser for sixty-four. That is how you lose the
//     tab - the same lesson the preset library's bulk thumbnail pass carries.
//  2. Compositing through a 2D canvas would DESTROY the alpha. A 2D canvas
//     stores premultiplied colour, so an additive particle - bright rgb, low
//     alpha, which is most of what a particle is - would be multiplied down on
//     the way in and divided back up on the way out, and at alpha 0.1 that
//     round trip amplifies the quantisation error tenfold. Rendering straight
//     into cells of one WebGL canvas whose context is `premultipliedAlpha:
//     false` means the bytes `toBlob` writes are the bytes the shader produced.
//
// STRAIGHT ALPHA, NOT PREMULTIPLIED, for exactly that reason. `alpha: true`
// plus `premultipliedAlpha: false` gives a drawing buffer holding independent
// rgb and a, which is what a PNG stores and what an engine expects to sample.
//
// CELL ORDER IS THE SHADER'S ORDER: row-major, left to right, top to bottom,
// with row 0 at the TOP of the image. That is what buildVertexShader's flipbook
// block computes (see the V-flip note beside `uTiles` in materials.js), so a
// sheet baked here plays correctly in this editor's own flipbook without anyone
// having to think about it. Getting it upside down makes an explosion implode.
//
// THE SIMULATION IS RE-RUN FROM ZERO, not sampled from the live preview. A
// stateful sim cannot be rewound, so frame 40 is only reachable by stepping to
// it - and starting fresh with the effect's own seed is what makes a sheet
// REPRODUCIBLE: bake the same effect twice and the bytes match. Only the camera
// comes from the live preview, because where to stand is a judgement.
import * as THREE from 'three'
import { createBatches, disposeBatch, writeBatch } from './batch.js'
import { createVfxRuntime, installMeshSamplers, step } from './system.js'
import { squareCameraFrom } from '../vfxThumbnail.js'
// The same placement maths the headless preview uses, so a sheet and a
// render_vfx_preview frame of one effect are framed identically.
import { cameraPlacement, focusBounds } from '../../../vfx/preview.js'

/**
 * The largest sheet either dimension may reach.
 *
 * Well under what a desktop GPU reports for MAX_TEXTURE_SIZE, because the
 * binding limit in practice is neither the GPU nor this app: it is what the
 * consuming engine will accept and what a phone can hold. 8192 square is
 * already a 256MB uncompressed texture.
 */
export const MAX_SHEET_PIXELS = 8192

const clampInt = (value, low, high) => {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return low
  return Math.min(high, Math.max(low, number))
}

/**
 * Work out which simulation frames become which cells.
 *
 * Pure, and separated from the rendering because this is where all the
 * arithmetic that can be wrong lives - the render is just a loop over what this
 * returns.
 *
 * @param {Object} options
 * @param {number} options.startFrame first simulation step to capture
 * @param {number} options.endFrame last step of the range
 * @param {number} options.columns
 * @param {number} options.rows
 * @param {number} options.cell pixels per cell, square
 * @param {boolean} [options.loop] whether the effect loops
 * @returns {Object} the plan, including the frame index of every cell
 */
export function planSpriteSheet(options) {
  const columns = clampInt(options.columns, 1, 32)
  const rows = clampInt(options.rows, 1, 32)
  const cell = clampInt(options.cell, 8, 2048)
  const count = columns * rows

  const startFrame = clampInt(options.startFrame, 0, 100000)
  // At least one frame past the start, or the whole sheet is one instant.
  const endFrame = Math.max(startFrame + 1, clampInt(options.endFrame, 0, 100000))
  const span = endFrame - startFrame

  // THE LOOP SEAM. For a looping effect the last cell must NOT be the same
  // moment as the first, or the flipbook stutters once per cycle: dividing the
  // span by the cell COUNT lands the last cell one step short of the end, so
  // cell N-1 flows into cell 0. A one-shot has no seam to worry about and wants
  // both ends of the range, so it divides by count - 1 and captures the last
  // frame exactly.
  const divisor = options.loop ? count : Math.max(1, count - 1)
  const stepFrames = span / divisor

  const frames = []
  for (let index = 0; index < count; index += 1) {
    frames.push(startFrame + Math.round(index * stepFrames))
  }

  const width = columns * cell
  const height = rows * cell

  return {
    columns,
    rows,
    cell,
    count,
    startFrame,
    endFrame,
    frames,
    stepFrames,
    width,
    height,
    // A range shorter than the grid makes several cells land on the same frame.
    // Reported rather than silently produced: a sheet with repeated cells looks
    // like the effect stalled, and the cause is the numbers, not the effect.
    duplicates: count - new Set(frames).size,
    tooLarge: width > MAX_SHEET_PIXELS || height > MAX_SHEET_PIXELS,
  }
}

/**
 * Render the sheet.
 *
 * @param {Object} options
 * @param {Object} options.ir the compiled effect
 * @param {THREE.Camera} [options.camera] the live preview camera; only its world
 *   transform and vertical field of view are used. Required unless `view` is
 *   given.
 * @param {Object} [options.view] frame on the effect instead of on a camera:
 *   {azimuth, elevation, distance, fov} in degrees and effect-radii. This is
 *   the lever for baking a sheet with no viewport - `boundsAuto` never was one,
 *   and nothing here reads the declared bounds except as a last resort.
 * @param {Object} options.plan from planSpriteSheet
 * @param {Map<number, THREE.Texture>} [options.textures]
 * @param {Map<number, Object>} [options.meshes]
 * @param {boolean} [options.transparent] false bakes a black background in
 * @param {boolean} [options.toneMapped] ACES, matching the preview
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<Blob>} a PNG
 */
/**
 * A camera framed on the effect itself, for a bake with no author watching.
 *
 * WHY THIS EXISTS. The bake has always taken the LIVE PREVIEW CAMERA - the one
 * the author orbited - which is exactly right when a person is looking at the
 * screen and the only possible answer when they have framed something
 * deliberately. It is no answer at all for anything driving the bake without a
 * viewport, which had no lever on framing whatsoever.
 *
 * ONE CAMERA FOR THE WHOLE SHEET, SO IT MUST FIT EVERY CELL. An explosion is a
 * dot in cell 0 and fills the frame by cell 40; framing on either one alone
 * crops the other. So the boxes of every planned frame are unioned, which costs
 * a throwaway pre-simulation and is the only honest way to get one camera that
 * suits all of them.
 *
 * The box is the FOCUS box, not the total one - a few fast specks must not be
 * allowed to decide the distance. See focusBounds.
 *
 * @param {Object} ir
 * @param {Object} plan from planSpriteSheet
 * @param {Map} meshes
 * @param {Object} view azimuth / elevation / distance / fov
 * @returns {THREE.PerspectiveCamera}
 */
function autoFramedCamera(ir, plan, meshes, view) {
  const probe = createVfxRuntime(ir)
  installMeshSamplers(probe, meshes)

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let seen = false

  for (let index = 0; index < plan.count; index += 1) {
    while (probe.stepIndex < plan.frames[index]) step(probe)
    const box = focusBounds(probe.emitters)
    if (!box) continue
    seen = true
    for (let axis = 0; axis < 3; axis += 1) {
      if (box.min[axis] < min[axis]) min[axis] = box.min[axis]
      if (box.max[axis] > max[axis]) max[axis] = box.max[axis]
    }
  }

  // Nothing alive in any cell. The declared bounds are all there is, and a
  // camera pointed at them beats one pointed at a degenerate point.
  const place = seen
    ? cameraPlacement(min, max, view)
    : cameraPlacement(ir.effect.boundsMin, ir.effect.boundsMax, view)

  // Aspect 1 because cells are square - the same rule squareCameraFrom applies
  // to a live camera, so an auto-framed sheet and a hand-framed one crop alike.
  const camera = new THREE.PerspectiveCamera(place.fov, 1, 0.01, Math.max(100, place.radius * 40))
  camera.position.set(place.eye[0], place.eye[1], place.eye[2])
  camera.lookAt(place.target[0], place.target[1], place.target[2])
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

export async function captureSpriteSheet(options) {
  const { ir, camera, plan, onProgress } = options
  const textures = options.textures || new Map()
  const meshes = options.meshes || new Map()
  const transparent = options.transparent !== false

  if (plan.tooLarge) {
    throw new Error(`A ${plan.width}x${plan.height} sheet is too large; the limit is ${MAX_SHEET_PIXELS} per side.`)
  }

  const canvas = document.createElement('canvas')
  canvas.width = plan.width
  canvas.height = plan.height

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    // See the header: both of these, together, are what make the alpha usable.
    alpha: true,
    premultipliedAlpha: false,
    // toBlob reads the drawing buffer after every cell has been drawn into it,
    // which is a different task from the renders - so the buffer has to survive.
    preserveDrawingBuffer: true,
  })
  renderer.setSize(plan.width, plan.height, false)
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Matching the preview by default. Off gives the authored colour, for an
  // engine that will tone map the effect itself and would otherwise do it
  // twice - see the note on the dialog's control.
  renderer.toneMapping = options.toneMapped === false
    ? THREE.NoToneMapping
    : THREE.ACESFilmicToneMapping

  // Cleared ONCE, for the whole sheet, then never again: every cell render must
  // leave the other sixty-three alone.
  renderer.autoClear = false
  renderer.setClearColor(0x000000, transparent ? 0 : 1)
  renderer.setScissorTest(false)
  renderer.clear()

  const runtime = createVfxRuntime(ir)
  // MESH EMITTERS NEED THEIR SAMPLERS, and this is a FRESH runtime - the
  // preview's samplers belong to the preview's runtime. Without them a mesh
  // emitter spawns every particle at the origin and the sheet bakes a dot.
  installMeshSamplers(runtime, meshes)
  const batches = createBatches(ir, runtime.emitters, { textures, meshes })
  const scene = new THREE.Scene()
  // Deliberately NO scene.background: a background colour is an opaque clear,
  // which would fill the alpha channel and undo the whole point.
  // The author's camera when there is one, otherwise framed on the effect.
  // `view` wins when both are given, so a caller can override a stale viewport.
  const cell = options.view
    ? autoFramedCamera(ir, plan, meshes, options.view)
    : squareCameraFrom(camera)
  const view = new THREE.Vector3()
  cell.getWorldDirection(view)

  try {
    for (const batch of batches) scene.add(batch.mesh)
    renderer.setScissorTest(true)

    for (let index = 0; index < plan.count; index += 1) {
      // Step to this cell's frame. The frames are ascending, so the whole sheet
      // is ONE forward pass over the simulation rather than count re-runs from
      // zero - the difference between O(n) and O(n squared) steps.
      while (runtime.stepIndex < plan.frames[index]) step(runtime)

      const column = index % plan.columns
      const row = Math.floor(index / plan.columns)
      // GL's viewport origin is the BOTTOM-left of the buffer while the image's
      // row 0 is at the top, so the row is counted from the far end. This is
      // the same flip the flipbook shader performs when it samples.
      const x = column * plan.cell
      const y = plan.height - (row + 1) * plan.cell
      renderer.setViewport(x, y, plan.cell, plan.cell)
      renderer.setScissor(x, y, plan.cell, plan.cell)

      for (const batch of batches) writeBatch(batch, view)
      renderer.render(scene, cell)

      onProgress?.(index + 1, plan.count)
      // Hand the frame back so the progress text repaints. Without this the
      // whole bake is one long task and the dialog appears frozen.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    }

    renderer.setScissorTest(false)
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('The sprite sheet could not be encoded.'))
      }, 'image/png')
    })
  } finally {
    // Ours to release, all of it: the batches are this function's own geometry
    // and materials over this function's own runtime, and the preview never saw
    // any of it.
    for (const batch of batches) {
      scene.remove(batch.mesh)
      disposeBatch(batch)
    }
    renderer.dispose()
  }
}
