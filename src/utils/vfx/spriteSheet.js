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
 * @param {THREE.Camera} options.camera the live preview camera; only its world
 *   transform and vertical field of view are used
 * @param {Object} options.plan from planSpriteSheet
 * @param {Map<number, THREE.Texture>} [options.textures]
 * @param {Map<number, Object>} [options.meshes]
 * @param {boolean} [options.transparent] false bakes a black background in
 * @param {boolean} [options.toneMapped] ACES, matching the preview
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<Blob>} a PNG
 */
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
  const cell = squareCameraFrom(camera)
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
