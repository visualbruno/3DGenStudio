// Make a texture tile without visible seams.
//
// Two different faults show up as "seams" when a texture repeats, and they need
// different fixes — which is why this has more than one control:
//
//  1. THE EDGES DO NOT MATCH. The left edge butts against the right edge and the
//     content jumps. Fixed by overlapping the image with itself and joining the
//     two along a path (`cut` / `blend` below).
//
//  2. THE LIGHTING IS UNEVEN. A photograph of bark is usually brighter on one
//     side. Every edge can match perfectly and the tiling is still obvious,
//     because a dark corner repeating every tile reads as a grid. Fixed by
//     flattening the low-frequency luminance (`flatten`).
//
// A texture can need one, the other, or both. Fixing only the edges on a photo
// with a gradient is the common disappointment: the seam goes away and the
// tiling is still glaring.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

function canvasToImageData(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function imageDataToCanvas(imageData) {
  const canvas = makeCanvas(imageData.width, imageData.height)
  canvas.getContext('2d').putImageData(imageData, 0, 0)
  return canvas
}

// ---------------------------------------------------------------------------
// 1. Lighting flatten
// ---------------------------------------------------------------------------

// Divide out the image's own low-frequency luminance, so a texture lit from one
// side stops announcing its tile boundaries.
//
// The blur is done by scaling down to a few pixels and back up rather than by a
// real Gaussian: at this radius (the whole image) the two are visually
// identical, and the browser's bilinear resample is orders of magnitude faster
// than convolving a kernel wide enough to matter.
function flattenLighting(canvas, strength) {
  const amount = Math.max(0, Math.min(1, strength / 100))
  if (amount <= 0) return canvas

  const { width, height } = canvas
  const small = makeCanvas(Math.max(2, Math.round(width / 64)), Math.max(2, Math.round(height / 64)))
  const smallContext = small.getContext('2d')
  smallContext.imageSmoothingEnabled = true
  smallContext.imageSmoothingQuality = 'high'
  smallContext.drawImage(canvas, 0, 0, small.width, small.height)

  const blurred = makeCanvas(width, height)
  const blurredContext = blurred.getContext('2d')
  blurredContext.imageSmoothingEnabled = true
  blurredContext.imageSmoothingQuality = 'high'
  blurredContext.drawImage(small, 0, 0, width, height)

  const source = canvasToImageData(canvas)
  const light = canvasToImageData(blurred)
  const src = source.data
  const lit = light.data

  // Mean luminance of the blur is the level everything is normalised back to,
  // so the image keeps its overall exposure instead of turning grey.
  let mean = 0
  for (let i = 0; i < lit.length; i += 4) {
    mean += 0.2126 * lit[i] + 0.7152 * lit[i + 1] + 0.0722 * lit[i + 2]
  }
  mean /= lit.length / 4
  if (mean < 1) return canvas

  for (let i = 0; i < src.length; i += 4) {
    const local = 0.2126 * lit[i] + 0.7152 * lit[i + 1] + 0.0722 * lit[i + 2]
    // Clamp the correction: a near-black region would otherwise be multiplied
    // by a huge gain and explode into noise.
    const gain = Math.max(0.25, Math.min(4, mean / Math.max(local, 1)))
    const mix = 1 + (gain - 1) * amount
    src[i] = Math.max(0, Math.min(255, src[i] * mix))
    src[i + 1] = Math.max(0, Math.min(255, src[i + 1] * mix))
    src[i + 2] = Math.max(0, Math.min(255, src[i + 2] * mix))
  }
  return imageDataToCanvas(source)
}

// ---------------------------------------------------------------------------
// 2. Joining the overlap
// ---------------------------------------------------------------------------

// Squared RGB difference between two pixels of the same ImageData.
function pixelError(data, a, b) {
  const dr = data[a] - data[b]
  const dg = data[a + 1] - data[b + 1]
  const db = data[a + 2] - data[b + 2]
  return dr * dr + dg * dg + db * db
}

// Minimum-error boundary cut (Efros & Freeman, image quilting).
//
// Given an overlap band holding two candidate images, find the path through it
// where they disagree least and join along that. This is the whole reason `cut`
// beats `blend` on natural textures: a linear cross-fade shows both images at
// once in the overlap — on bark you see a ghosted double exposure of the grain —
// whereas cutting along a low-error path hides the join inside detail that
// already matched, and stays sharp.
//
// `error[y * band + x]` is the cost of switching at that pixel. Returns one cut
// column per row.
function minErrorPath(error, band, rows) {
  const cost = new Float64Array(band * rows)
  const back = new Int32Array(band * rows)

  for (let x = 0; x < band; x += 1) cost[x] = error[x]

  for (let y = 1; y < rows; y += 1) {
    for (let x = 0; x < band; x += 1) {
      let best = cost[(y - 1) * band + x]
      let bestX = x
      if (x > 0 && cost[(y - 1) * band + x - 1] < best) {
        best = cost[(y - 1) * band + x - 1]
        bestX = x - 1
      }
      if (x < band - 1 && cost[(y - 1) * band + x + 1] < best) {
        best = cost[(y - 1) * band + x + 1]
        bestX = x + 1
      }
      cost[y * band + x] = error[y * band + x] + best
      back[y * band + x] = bestX
    }
  }

  // Walk back from the cheapest end.
  let end = 0
  let bestCost = Infinity
  for (let x = 0; x < band; x += 1) {
    const value = cost[(rows - 1) * band + x]
    if (value < bestCost) {
      bestCost = value
      end = x
    }
  }
  const path = new Int32Array(rows)
  path[rows - 1] = end
  for (let y = rows - 1; y > 0; y -= 1) path[y - 1] = back[y * band + path[y]]
  return path
}

// Join the wrap along one axis. Works on the horizontal axis; the caller
// transposes for the vertical pass so there is only one implementation of the
// tricky part.
//
// Output is `width - band` wide. For x in [0, band) the two candidates are:
//   wrapped  = source(width - band + x, y)   the content that precedes the wrap
//   natural  = source(x, y)
// At x = 0 the output MUST be the wrapped candidate (that is what makes the left
// edge continue from the right edge); by x = band it must be the natural one, so
// it meets the untouched middle. Everything here is about getting from one to
// the other invisibly.
function joinAxis(imageData, band, mode, feather) {
  const { width, height } = imageData
  const src = imageData.data
  const outWidth = width - band
  const output = new ImageData(outWidth, height)
  const dst = output.data

  // The untouched middle.
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * width * 4
    const dstRow = y * outWidth * 4
    for (let x = band; x < outWidth; x += 1) {
      const s = srcRow + x * 4
      const d = dstRow + x * 4
      dst[d] = src[s]
      dst[d + 1] = src[s + 1]
      dst[d + 2] = src[s + 2]
      dst[d + 3] = src[s + 3]
    }
  }

  let path = null
  if (mode === 'cut') {
    const error = new Float64Array(band * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < band; x += 1) {
        const wrapped = (y * width + (width - band + x)) * 4
        const natural = (y * width + x) * 4
        error[y * band + x] = pixelError(src, wrapped, natural)
      }
    }
    path = minErrorPath(error, band, height)
  }

  for (let y = 0; y < height; y += 1) {
    const dstRow = y * outWidth * 4
    for (let x = 0; x < band; x += 1) {
      const wrapped = (y * width + (width - band + x)) * 4
      const natural = (y * width + x) * 4
      const d = dstRow + x * 4

      let alpha // 0 = wrapped, 1 = natural
      if (mode === 'cut') {
        const cut = path[y]
        // Feather across a few pixels either side of the cut, so the join is not
        // a hard 1px staircase on smooth areas.
        alpha = feather > 0
          ? Math.max(0, Math.min(1, (x - cut) / feather + 0.5))
          : (x < cut ? 0 : 1)
      } else {
        alpha = x / band
      }

      const inv = 1 - alpha
      dst[d] = src[wrapped] * inv + src[natural] * alpha
      dst[d + 1] = src[wrapped + 1] * inv + src[natural + 1] * alpha
      dst[d + 2] = src[wrapped + 2] * inv + src[natural + 2] * alpha
      dst[d + 3] = src[wrapped + 3] * inv + src[natural + 3] * alpha
    }
  }

  return output
}

function transpose(imageData) {
  const { width, height } = imageData
  const src = imageData.data
  const output = new ImageData(height, width)
  const dst = output.data
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4
      const d = (x * height + y) * 4
      dst[d] = src[s]
      dst[d + 1] = src[s + 1]
      dst[d + 2] = src[s + 2]
      dst[d + 3] = src[s + 3]
    }
  }
  return output
}

// ---------------------------------------------------------------------------
// 3. Mirror
// ---------------------------------------------------------------------------

// Fold the image into quadrants that mirror each other. Tiling is then perfect
// by construction — opposite edges are the same pixels — at the cost of obvious
// bilateral symmetry and half the feature scale. Right for noise and abstract
// grain, wrong for anything with recognisable objects in it.
function mirrorTile(canvas) {
  const { width, height } = canvas
  const halfWidth = Math.max(1, Math.floor(width / 2))
  const halfHeight = Math.max(1, Math.floor(height / 2))

  const quadrant = makeCanvas(halfWidth, halfHeight)
  const quadrantContext = quadrant.getContext('2d')
  quadrantContext.imageSmoothingQuality = 'high'
  quadrantContext.drawImage(canvas, 0, 0, width, height, 0, 0, halfWidth, halfHeight)

  const out = makeCanvas(halfWidth * 2, halfHeight * 2)
  const context = out.getContext('2d')
  for (const [flipX, flipY] of [[false, false], [true, false], [false, true], [true, true]]) {
    context.save()
    context.translate(flipX ? halfWidth * 2 : 0, flipY ? halfHeight * 2 : 0)
    context.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    context.drawImage(quadrant, 0, 0)
    context.restore()
  }
  return out
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

export const DEFAULT_SEAMLESS_VALUES = {
  mode: 'cut',
  overlap: 12,        // % of the shorter side
  feather: 2,         // px of softening either side of the cut
  flatten: 0,         // % lighting flatten
  keepSize: true,     // scale back to the original dimensions
}

/**
 * Make `sourceCanvas` tile seamlessly. Returns a NEW canvas, or null if the
 * input is unusable.
 */
export function applySeamlessToCanvas(sourceCanvas, values = DEFAULT_SEAMLESS_VALUES) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null

  const settings = { ...DEFAULT_SEAMLESS_VALUES, ...values }
  const originalWidth = sourceCanvas.width
  const originalHeight = sourceCanvas.height

  let working = flattenLighting(sourceCanvas, settings.flatten)

  if (settings.mode === 'mirror') {
    // Never rescaled: mirrored edges are the same pixels, and a resample would
    // blend each edge with a clamped neighbour and break that exactness. For
    // even dimensions the fold already returns the original size anyway.
    return mirrorTile(working)
  }

  // Band is a fraction of the SHORTER side so a long thin texture does not get a
  // band wider than its own height.
  const shortest = Math.min(originalWidth, originalHeight)
  const band = Math.max(2, Math.min(
    Math.floor(shortest * (settings.overlap / 100)),
    Math.floor(originalWidth / 2) - 1,
    Math.floor(originalHeight / 2) - 1,
  ))
  if (band < 2) return null

  // Joining consumes `band` pixels per axis. To land back on the original size,
  // resample BEFORE joining rather than after.
  //
  // Rescaling the finished tile is the obvious move and it is wrong: a bilinear
  // resample clamps at the image border instead of wrapping, so it blends the
  // outermost pixels with themselves and re-opens the seam the join just closed.
  // Measured on a bark photo, that cost more than half the improvement (1.11x
  // the interior noise floor, degraded to 1.49x). Growing the source first means
  // the only resample happens on an image whose edges do not matter yet.
  if (settings.keepSize) {
    working = rescale(working, originalWidth + band, originalHeight + band)
  }

  let data = canvasToImageData(working)
  data = joinAxis(data, band, settings.mode, settings.feather)      // horizontal
  data = transpose(joinAxis(transpose(data), band, settings.mode, settings.feather))  // vertical
  return imageDataToCanvas(data)
}

function rescale(canvas, width, height) {
  if (canvas.width === width && canvas.height === height) return canvas
  const out = makeCanvas(width, height)
  const context = out.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, width, height)
  return out
}

/**
 * Draw `canvas` tiled `repeat` times into `target`.
 *
 * The single most useful thing in this whole tool: a seam is invisible on the
 * texture itself and obvious the moment it repeats, so judging the result on an
 * untiled image is guesswork.
 */
export function drawTiledPreview(target, canvas, repeat = 2) {
  if (!target || !canvas?.width) return
  const context = target.getContext('2d')
  context.clearRect(0, 0, target.width, target.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const cellWidth = target.width / repeat
  const cellHeight = target.height / repeat
  for (let row = 0; row < repeat; row += 1) {
    for (let column = 0; column < repeat; column += 1) {
      context.drawImage(canvas, column * cellWidth, row * cellHeight, cellWidth, cellHeight)
    }
  }
}

/**
 * How visible the tiling seam is.
 *
 * Returns { seam, floor, ratio }. The raw edge difference is meaningless alone:
 * neighbouring pixels in any natural texture differ, so even a perfect tile
 * scores well above zero. What matters is the edge difference measured against
 * the image's OWN interior neighbour difference — its noise floor. A ratio near
 * 1 means the seam is no more of a discontinuity than the texture's own grain,
 * which is precisely what invisible means.
 */
export function measureSeam(canvas) {
  const blank = { seam: 0, floor: 0, ratio: 0 }
  if (!canvas?.width || canvas.width < 2 || canvas.height < 2) return blank

  const imageData = canvasToImageData(canvas)
  const { width, height } = imageData
  const { data } = imageData
  const delta = (a, b) => (Math.abs(data[a] - data[b])
    + Math.abs(data[a + 1] - data[b + 1])
    + Math.abs(data[a + 2] - data[b + 2])) / 3

  let seam = 0
  for (let y = 0; y < height; y += 1) {
    seam += delta((y * width) * 4, (y * width + width - 1) * 4)
  }
  for (let x = 0; x < width; x += 1) {
    seam += delta(x * 4, ((height - 1) * width + x) * 4)
  }
  seam = (seam / (width + height)) * (100 / 255)

  // Interior noise floor, sampled on a stride: this runs on every slider move
  // and a full pass over a 4K texture would be felt.
  let total = 0
  let count = 0
  const step = Math.max(1, Math.floor(Math.min(width, height) / 256))
  for (let y = 0; y < height - 1; y += step) {
    for (let x = 0; x < width - 1; x += step) {
      const here = (y * width + x) * 4
      total += delta(here, here + 4) + delta(here, ((y + 1) * width + x) * 4)
      count += 2
    }
  }
  const floor = count ? (total / count) * (100 / 255) : 0
  return { seam, floor, ratio: floor > 0.01 ? seam / floor : 0 }
}

/** A plain-language verdict for the ratio from `measureSeam`. */
export function describeSeam(ratio) {
  if (!ratio) return 'unknown'
  if (ratio < 1.25) return 'invisible'
  if (ratio < 1.6) return 'faint'
  if (ratio < 2.2) return 'visible'
  return 'obvious'
}
