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
// tiling is still glaring — measured on a bark photo, joining the edges left a
// quarter-strip brightness difference of 17 (of 255) between the left and the
// right of the tile, and that difference IS the grid you see. Which is why
// `flatten` defaults on rather than off.

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
// 0. Resampling
// ---------------------------------------------------------------------------

// A Catmull-Rom resample, done here rather than with drawImage, because this is
// the one place the tool can quietly ruin the whole picture.
//
// "Keep original size" has to grow the source by the overlap before joining
// (see `applySeamlessToCanvas`), so at a 17% overlap EVERY pixel of the result
// has been through one 1.17x magnification — not just the pixels near the seam.
// With the browser's bilinear that cost 36% of the image's gradient energy and
// the texture came back visibly soft. A cubic filter at the same magnification
// keeps far more of it, at the price of running on the CPU.
//
// That price is about 73ms per megapixel of output, and the image editor
// re-runs this for its live preview on every slider tick, so there is a ceiling
// above which the sharpness is not worth the drag: ~6 megapixels, which covers
// the 1K and 2K textures this app actually generates (+117ms and +390ms) and
// hands anything larger back to drawImage. Softness is the lesser evil against
// a second of lag per tick.
const CUBIC_FALLBACK_PIXELS = 6e6

function catmullRom(t) {
  const x = Math.abs(t)
  if (x < 1) return 1.5 * x * x * x - 2.5 * x * x + 1
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2
  return 0
}

// Tap list for one axis. The weights depend only on the coordinate, so they are
// built once per axis and reused for every row (or column).
function buildTaps(sourceSize, targetSize) {
  const scale = targetSize / sourceSize
  // Minifying has to widen the kernel in source space or it degenerates into
  // point sampling and aliases.
  const stretch = scale >= 1 ? 1 : scale
  const support = 2 / stretch
  const perSample = Math.ceil(support * 2) + 2
  const offsets = new Int32Array(targetSize * perSample)
  const weights = new Float32Array(targetSize * perSample)
  const counts = new Int32Array(targetSize)

  for (let i = 0; i < targetSize; i += 1) {
    const center = (i + 0.5) / scale - 0.5
    const first = Math.ceil(center - support)
    const last = Math.floor(center + support)
    let total = 0
    let count = 0
    for (let s = first; s <= last && count < perSample; s += 1) {
      const weight = catmullRom((s - center) * stretch)
      if (weight === 0) continue
      offsets[i * perSample + count] = Math.min(sourceSize - 1, Math.max(0, s))
      weights[i * perSample + count] = weight
      total += weight
      count += 1
    }
    // Renormalising is what keeps the clamped edge taps from darkening the
    // border — which on this of all images is the part that has to be right.
    if (total !== 0) for (let k = 0; k < count; k += 1) weights[i * perSample + k] /= total
    counts[i] = count
  }
  return { offsets, weights, counts, perSample }
}

function resampleImageData(image, targetWidth, targetHeight) {
  const { width, height, data } = image
  if (width === targetWidth && height === targetHeight) return image

  // Horizontal pass into a float buffer, so the vertical pass is not working
  // from already-rounded 8-bit values.
  const xTaps = buildTaps(width, targetWidth)
  const middle = new Float32Array(targetWidth * height * 4)
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4
    const out = y * targetWidth * 4
    for (let x = 0; x < targetWidth; x += 1) {
      const base = x * xTaps.perSample
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < xTaps.counts[x]; k += 1) {
        const weight = xTaps.weights[base + k]
        const s = row + xTaps.offsets[base + k] * 4
        r += data[s] * weight
        g += data[s + 1] * weight
        b += data[s + 2] * weight
        a += data[s + 3] * weight
      }
      const d = out + x * 4
      middle[d] = r
      middle[d + 1] = g
      middle[d + 2] = b
      middle[d + 3] = a
    }
  }

  const yTaps = buildTaps(height, targetHeight)
  const output = new ImageData(targetWidth, targetHeight)
  const dst = output.data
  for (let y = 0; y < targetHeight; y += 1) {
    const base = y * yTaps.perSample
    const out = y * targetWidth * 4
    for (let x = 0; x < targetWidth; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < yTaps.counts[y]; k += 1) {
        const weight = yTaps.weights[base + k]
        const s = (yTaps.offsets[base + k] * targetWidth + x) * 4
        r += middle[s] * weight
        g += middle[s + 1] * weight
        b += middle[s + 2] * weight
        a += middle[s + 3] * weight
      }
      // Cubic filters overshoot at hard edges; Uint8ClampedArray does the
      // clamping on assignment, which is the whole reason to write into one.
      const d = out + x * 4
      dst[d] = r
      dst[d + 1] = g
      dst[d + 2] = b
      dst[d + 3] = a
    }
  }
  return output
}

// ---------------------------------------------------------------------------
// 1. Lighting flatten
// ---------------------------------------------------------------------------

// The illumination estimate is a fixed CELL GRID, not a fixed pixel radius. A
// radius in pixels flattens the 384px preview and the 4K texture by different
// amounts, so the preview stops predicting the result — and predicting the
// result is the only reason the preview exists.
const FLATTEN_CELLS = 16

// Bilinear expansion of the coarse illumination grid, WRAPPING at the edges
// instead of clamping.
//
// This is what stops the lighting fix from undoing the seam fix. A clamped
// expansion reads the grid's first cell at x = 0 and its last cell at the far
// edge, so the two ends of the wrap — which the cut has just made neighbours —
// get divided by quite different gains, and the tonal step reappears exactly
// where the cut removed it. It is visible in the numbers: with the old clamped
// blur the worst local seam climbed from 1.4x the noise floor to 2.1x as
// flatten went from 0 to 100, i.e. the stronger the lighting fix, the worse the
// seam it was supposed to be helping. Wrapping holds it flat instead.
function expandFieldCyclic(grid, width, height) {
  const gridWidth = grid.width
  const gridHeight = grid.height
  const cells = grid.data
  const cellLuminance = (cx, cy) => {
    const x = ((cx % gridWidth) + gridWidth) % gridWidth
    const y = ((cy % gridHeight) + gridHeight) % gridHeight
    const i = (y * gridWidth + x) * 4
    return 0.2126 * cells[i] + 0.7152 * cells[i + 1] + 0.0722 * cells[i + 2]
  }

  const field = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const gy = ((y + 0.5) * gridHeight) / height - 0.5
    const y0 = Math.floor(gy)
    const ty = gy - y0
    for (let x = 0; x < width; x += 1) {
      const gx = ((x + 0.5) * gridWidth) / width - 0.5
      const x0 = Math.floor(gx)
      const tx = gx - x0
      const top = cellLuminance(x0, y0) * (1 - tx) + cellLuminance(x0 + 1, y0) * tx
      const bottom = cellLuminance(x0, y0 + 1) * (1 - tx) + cellLuminance(x0 + 1, y0 + 1) * tx
      field[y * width + x] = top * (1 - ty) + bottom * ty
    }
  }
  return field
}

// Divide out the image's own low-frequency luminance, so a texture lit from one
// side stops announcing its tile boundaries.
//
// Runs on the FINISHED tile, not on the source. On the source the two vertical
// borders are opposite sides of a photograph and genuinely lit differently, so
// no wrapping estimate of the lighting can be honest about both at once. On the
// joined tile they are adjacent pixels, the coarse grid agrees across the wrap
// by construction, and the large-scale variation that is left — dark edges,
// bright middle, or whatever the cut happened to leave — is precisely the
// pattern that reads as a grid when the tile repeats.
//
// The blur is done by scaling down to a few cells rather than by a real
// Gaussian: at this radius (the whole image) the two are visually identical,
// and the browser's resample is orders of magnitude faster than convolving a
// kernel wide enough to matter.
function flattenLighting(canvas, strength) {
  const amount = Math.max(0, Math.min(1, strength / 100))
  if (amount <= 0) return canvas

  const { width, height } = canvas
  const longest = Math.max(width, height)
  const small = makeCanvas(
    Math.max(2, Math.round((FLATTEN_CELLS * width) / longest)),
    Math.max(2, Math.round((FLATTEN_CELLS * height) / longest)),
  )
  const smallContext = small.getContext('2d')
  smallContext.imageSmoothingEnabled = true
  smallContext.imageSmoothingQuality = 'high'
  smallContext.drawImage(canvas, 0, 0, small.width, small.height)

  const field = expandFieldCyclic(canvasToImageData(small), width, height)
  const source = canvasToImageData(canvas)
  const src = source.data

  // Mean of the field is the level everything is normalised back to, so the
  // image keeps its overall exposure instead of turning grey.
  let mean = 0
  for (let i = 0; i < field.length; i += 1) mean += field[i]
  mean /= field.length
  if (mean < 1) return canvas

  for (let i = 0, p = 0; i < src.length; i += 4, p += 1) {
    // Clamp the correction: a near-black region would otherwise be multiplied
    // by a huge gain and explode into noise.
    const gain = Math.max(0.25, Math.min(4, mean / Math.max(field[p], 1)))
    const mix = 1 + (gain - 1) * amount
    src[i] = src[i] * mix
    src[i + 1] = src[i + 1] * mix
    src[i + 2] = src[i + 2] * mix
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

// Per-pixel cost of switching from the wrapped candidate to the natural one.
//
// Plain squared colour difference, deliberately. Adding the gradient term that
// graph-cut texture synthesis papers use, and pre-blurring the field so the cut
// follows structure rather than grain, both sounded obviously right and both
// measured as nothing: across twelve textures — including one built with hard
// crack edges and correlated grain specifically to favour them — the worst
// local seam moved from 1.28x the noise floor to 1.27x, while the extra passes
// cost CPU and nudged the cut into consistently worse-lit crops. Left out.
function overlapError(src, width, band, rows) {
  const error = new Float32Array(band * rows)
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < band; x += 1) {
      const wrapped = (y * width + (width - band + x)) * 4
      const natural = (y * width + x) * 4
      error[y * band + x] = pixelError(src, wrapped, natural)
    }
  }
  return error
}

// Keep the cut off the two ends of the band.
//
// At x = 0 the output has to be the wrapped candidate, and at x = band-1 the
// natural one — that is the entire reason the tile wraps. Nothing in the cost
// function forbids the path from running along either boundary, which would
// switch the candidate at exactly the pixel that had to stay put and re-open
// the seam. In practice the cost never chose those columns (0 rows out of 3072
// measured), so this is a guard rather than a fix; it is here because it is
// free — the path has to cross the band regardless, so it only ever wanted the
// interior anyway.
function penaliseBandEdges(error, band, rows, requestedMargin) {
  // Never penalise the whole band: a minimum-width band has nothing but edges,
  // and pricing every column out leaves the path to be decided by rounding.
  const margin = Math.min(requestedMargin, Math.floor((band - 1) / 2))
  if (margin < 1) return
  let worst = 0
  for (let i = 0; i < error.length; i += 1) if (error[i] > worst) worst = error[i]
  const penalty = (worst + 1) * band
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < margin; x += 1) {
      error[y * band + x] += penalty
      error[y * band + (band - 1 - x)] += penalty
    }
  }
}

// The column a closed cut should begin and end at: the cheapest place to be in
// the first row and the last row at once.
function bestAnchor(error, band, rows) {
  let anchor = band >> 1
  let best = Infinity
  const last = (rows - 1) * band
  for (let x = 0; x < band; x += 1) {
    const value = error[x] + error[last + x]
    if (value < best) {
      best = value
      anchor = x
    }
  }
  return anchor
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
// column per row. `anchor`, when given, pins the path to that column in the
// first AND last row; `joinAxis` explains why the second pass needs that.
function minErrorPath(error, band, rows, anchor = null) {
  const cost = new Float64Array(band * rows)
  const back = new Int32Array(band * rows)

  for (let x = 0; x < band; x += 1) {
    cost[x] = anchor === null || x === anchor ? error[x] : Infinity
  }

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

  // Walk back from the cheapest end — or from the anchor, when the two ends
  // have to agree. The anchor is only unreachable if the band is wider than the
  // image is long, which `applySeamlessToCanvas` already rules out; falling back
  // to the free end there keeps a degenerate input from returning garbage.
  let end = 0
  if (anchor !== null && Number.isFinite(cost[(rows - 1) * band + anchor])) {
    end = anchor
  } else {
    let bestCost = Infinity
    for (let x = 0; x < band; x += 1) {
      const value = cost[(rows - 1) * band + x]
      if (value < bestCost) {
        bestCost = value
        end = x
      }
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
//
// `closed` is for the second (vertical) pass. That pass is handed an image that
// is already seamless left-to-right and must not break it — and a cut that
// switches candidate at row 40 on the left edge but row 90 on the right edge
// does exactly that: for the fifty rows in between, one side of the wrap is
// taken from the top of the image and the other from the bottom. It showed up
// as a partial seam across the overlap band, measuring 1.6x the texture's own
// noise floor where the rest of the wrap measured 0.6x. Pinning both ends of
// the cut to the same row is what closes it.
function joinAxis(imageData, band, mode, feather, closed = false) {
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
    const error = overlapError(src, width, band, height)
    penaliseBandEdges(error, band, height, Math.max(1, Math.round(band / 24)))
    path = minErrorPath(error, band, height, closed ? bestAnchor(error, band, height) : null)
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

  const quadrant = imageDataToCanvas(
    resampleImageData(canvasToImageData(canvas), halfWidth, halfHeight),
  )

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
// 4. Stamping the seam
// ---------------------------------------------------------------------------
//
// Joining the overlap makes the two edges continuous, and it still leaves ONE
// perfectly straight line of continuity through the tile. On anything with
// large-scale structure — bark running vertically, planks, stone courses — the
// eye finds that line anyway, because everything else in the picture is
// irregular and that one thing is ruler-straight.
//
// Stamping breaks it up. Round patches lifted from elsewhere in the same
// texture are pasted ACROSS the seam with a soft, noise-eaten edge; each patch
// is written through a wrapping index, so the half that falls off the left
// comes back on the right and the patch is continuous around the wrap by
// construction. The straight line becomes a ragged one made of the texture's
// own detail.
//
// Because every stamp wraps, stamping can never re-open a seam — it composes
// with whatever ran before it, cut, blend or mirror, and with `overlap` at 0 it
// is the entire fix on its own. The algorithm and the parameter ranges are
// ported from the FImpossible Creations "Seamless Texture Generator" Unity
// tool, whose defaults are reproduced here so a setting that works there works
// here.

function clamp01(value) {
  return value < 0 ? 0 : (value > 1 ? 1 : value)
}

function lerpUnclamped(from, to, t) {
  return from + (to - from) * t
}

function lerp(from, to, t) {
  return lerpUnclamped(from, to, clamp01(t))
}

// Seeded PRNG (mulberry32). The seed has to produce the same stamps every time
// or the tool is unusable: the whole workflow is nudging a slider and watching
// the preview, and a result that reshuffles itself on every keystroke cannot be
// judged, let alone reproduced at full resolution.
function makeRandom(seed) {
  let state = (Math.imul(Math.trunc(seed) | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Draws exactly one value from `random` even when the range is empty, so the
// preview and the full-size run stay in step: they differ in pixel dimensions,
// which changes the ranges, and a range that collapsed at one size but not the
// other would desynchronise every stamp after it.
function randomInt(random, from, to) {
  return from + Math.floor(random() * Math.abs(to - from))
}

// --- perlin ----------------------------------------------------------------

// Classic 2D perlin with a fixed permutation, standing in for Unity's
// Mathf.PerlinNoise. It does not need to match that function value for value —
// it needs to be coherent noise in 0..1 at the same frequency, which is all the
// stamp mask asks of it.
const PERLIN_PERMUTATION = (() => {
  const table = new Uint8Array(512)
  const base = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) base[i] = i
  const random = makeRandom(1337)
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const swap = base[i]
    base[i] = base[j]
    base[j] = swap
  }
  for (let i = 0; i < 512; i += 1) table[i] = base[i & 255]
  return table
})()

function perlinFade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function perlinGradient(hash, x, y) {
  switch (hash & 3) {
    case 0: return x + y
    case 1: return y - x
    case 2: return x - y
    default: return -x - y
  }
}

function perlin2(x, y) {
  const xf = Math.floor(x)
  const yf = Math.floor(y)
  const xi = xf & 255
  const yi = yf & 255
  const dx = x - xf
  const dy = y - yf
  const u = perlinFade(dx)
  const v = perlinFade(dy)
  const a = PERLIN_PERMUTATION[xi] + yi
  const b = PERLIN_PERMUTATION[xi + 1] + yi
  const top = perlinGradient(PERLIN_PERMUTATION[a], dx, dy) * (1 - u)
    + perlinGradient(PERLIN_PERMUTATION[b], dx - 1, dy) * u
  const bottom = perlinGradient(PERLIN_PERMUTATION[a + 1], dx, dy - 1) * (1 - u)
    + perlinGradient(PERLIN_PERMUTATION[b + 1], dx - 1, dy - 1) * u
  return clamp01((top * (1 - v) + bottom * v) * 0.5 + 0.5)
}

// --- one stamp -------------------------------------------------------------

function clampIndex(value, size) {
  return value < 0 ? 0 : (value >= size ? size - 1 : value)
}

// Nearest-neighbour rotation about the centre, zero-filling what rotates in
// from outside. Zero alpha is what makes that safe: the corners the rotation
// empties are outside the stamp's disc anyway, and a zero-alpha pixel writes
// nothing when the stamp is pasted.
function rotateStamp(data, size, angle) {
  if (!angle) return
  const source = new Uint8ClampedArray(data)
  const phi = (Math.PI / 180) * angle
  const sin = Math.sin(phi)
  const cos = Math.cos(phi)
  const centre = size / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = (y * size + x) * 4
      const sx = Math.trunc(cos * (x - centre) + sin * (y - centre) + centre)
      const sy = Math.trunc(cos * (y - centre) - sin * (x - centre) + centre)
      if (sx < 0 || sx >= size || sy < 0 || sy >= size) {
        data[d] = 0
        data[d + 1] = 0
        data[d + 2] = 0
        data[d + 3] = 0
        continue
      }
      const s = (sy * size + sx) * 4
      data[d] = source[s]
      data[d + 1] = source[s + 1]
      data[d + 2] = source[s + 2]
      data[d + 3] = source[s + 3]
    }
  }
}

// Lift one round patch from a random spot in `source` and give it a soft,
// noise-eaten alpha mask.
//
// `hardness` does not scale that mask, it overshoots it: peak alpha is
// 255 + hardness * 215 and then clipped at 255, so a hard stamp stays opaque
// well past its centre and only fades over the last stretch, while a soft one
// fades the whole way. That is the difference between a stamp that reads as a
// patch of its own and one that dissolves into what is underneath.
function buildStamp(source, sourceWidth, sourceHeight, baseRadius, settings, random) {
  const { hardness, stampNoise, randomize, stampRotate } = settings

  // Size jitter is skewed (-0.2..1.0, not -0.6..0.6): stamps come out larger
  // than the nominal radius more often than smaller, which keeps coverage
  // complete when the placement jitter has pulled one off the seam.
  let radius = baseRadius
  if (randomize > 0) radius = Math.round(baseRadius * (1 + (-0.2 + random() * 1.2) * randomize))
  radius = Math.max(1, Math.min(radius, Math.floor(Math.min(sourceWidth, sourceHeight) / 2)))

  const size = radius * 2
  const data = new Uint8ClampedArray(size * size * 4)
  const originX = randomInt(random, radius, sourceWidth - radius)
  const originY = randomInt(random, radius, sourceHeight - radius)
  const noiseOffset = random() * 512

  const peak = 255 + hardness * 215
  const falloff = radius * 0.95
  // Above this the mask is solid and no amount of noise shows through, so the
  // perlin lookup — by far the expensive part — is skipped for the whole core.
  const noiseCeiling = 235 + hardness * 15 + stampNoise * 10

  for (let y = 0; y < size; y += 1) {
    const dy = y - radius
    const row = clampIndex(originY + dy, sourceHeight) * sourceWidth
    for (let x = 0; x < size; x += 1) {
      const dx = x - radius
      const i = (y * size + x) * 4
      const s = (row + clampIndex(originX + dx, sourceWidth)) * 4
      data[i] = source[s]
      data[i + 1] = source[s + 1]
      data[i + 2] = source[s + 2]

      const fade = Math.sqrt(dx * dx + dy * dy) / falloff
      let alpha = Math.min(255, lerp(peak, 0, fade))
      if (alpha <= 0) {
        data[i + 3] = 0
        continue
      }

      if (stampNoise > 0 && alpha < noiseCeiling) {
        const noise = perlin2((x / radius) * 3 + noiseOffset, (y / radius) * 3 + noiseOffset)
        let spread = clamp01(alpha / 255)
        let mask = stampNoise

        // Past 1 the noise stops being confined to the fading rim and starts
        // eating into the solid core: the mask is recomputed as if the stamp
        // were softer than it is, so holes open in the middle of it. Good for
        // scattering, and the setting that can punch a hole big enough to
        // expose the seam it was meant to be covering.
        if (mask > 1) {
          spread = clamp01(lerp(255 + lerpUnclamped(hardness * 215, 0, mask - 1), 0, fade) / 255)
          mask -= 1
        }

        let noiseAlpha = lerpUnclamped(1, noise, mask * 0.95)
        noiseAlpha = lerp(noiseAlpha, noiseAlpha * noiseAlpha, mask - 0.5)
        noiseAlpha = lerp(1, noiseAlpha, 1 - spread)
        alpha = spread * noiseAlpha * 255
      }
      data[i + 3] = alpha
    }
  }

  if (stampRotate >= 1) rotateStamp(data, size, randomInt(random, 0, stampRotate))
  return { size, data }
}

// Paste a stamp centred on (originX, originY), wrapping at every edge. The wrap
// is the entire point — it is what lets a patch sit half on one side of the
// seam and half on the other and still be one continuous patch when the texture
// repeats.
function pasteStamp(target, width, height, stamp, originX, originY) {
  const { size, data } = stamp
  const half = size / 2
  for (let y = 0; y < size; y += 1) {
    const ty = (((originY - half + y) % height) + height) % height
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const alpha = data[i + 3]
      if (alpha === 0) continue
      const tx = (((originX - half + x) % width) + width) % width
      const t = (ty * width + tx) * 4
      const mix = alpha / 255
      const inv = 1 - mix
      target[t] = target[t] * inv + data[i] * mix
      target[t + 1] = target[t + 1] * inv + data[i + 1] * mix
      target[t + 2] = target[t + 2] * inv + data[i + 2] * mix
      // The destination's own alpha is left alone on purpose: a stamp is a
      // patch of colour, not a hole punched through the layer.
    }
  }
}

// Run a line of stamps along each seam that is being made to loop.
function stampSeams(canvas, settings, loopX, loopY) {
  const { width, height } = canvas
  const image = canvasToImageData(canvas)
  const target = image.data
  // Stamps are lifted from a frozen copy, never from the running result:
  // sampling the destination lets one stamp feed the next, and the seam turns
  // into a smear of itself after a few of them.
  const source = new Uint8ClampedArray(target)
  const random = makeRandom(settings.seed)

  const radiusX = Math.max(1, Math.round(width * lerpUnclamped(0.05, 0.3, settings.stampRadius)))
  const radiusY = Math.max(1, Math.round(height * lerpUnclamped(0.05, 0.3, settings.stampRadius)))
  const stepX = Math.max(1, radiusX * lerpUnclamped(1.45, 0.45, settings.stampDensity))
  const stepY = Math.max(1, radiusY * lerpUnclamped(1.45, 0.45, settings.stampDensity))

  // Which line belongs to which axis is the one genuinely confusing part: a ROW
  // of stamps runs along X and sits on the horizontal seam, and the horizontal
  // seam is what stops the texture looping VERTICALLY. So the row belongs to
  // loopY, and the column to loopX.
  if (loopY) {
    const count = Math.floor(width / stepX)
    for (let i = 0; i <= count; i += 1) {
      const stamp = buildStamp(source, width, height, radiusX, settings, random)
      const jitter = Math.round(radiusY * (-1 + random() * 2) * settings.randomize)
      pasteStamp(target, width, height, stamp, Math.round(i * stepX), jitter)
    }
  }

  if (loopX) {
    const count = Math.floor(height / stepY)
    for (let i = 0; i <= count; i += 1) {
      const stamp = buildStamp(source, width, height, radiusY, settings, random)
      const jitter = Math.round(radiusX * (-1 + random() * 2) * settings.randomize)
      pasteStamp(target, width, height, stamp, jitter, Math.round(i * stepY))
    }
  }

  return imageDataToCanvas(image)
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------

// Softness is quoted against this shorter side and scaled from there. Read as
// raw pixels the same slider feathers a 384px preview nearly three times as
// hard, relative to the picture, as the 1K texture the preview is predicting.
const FEATHER_REFERENCE = 1024

export const DEFAULT_SEAMLESS_VALUES = {
  mode: 'cut',
  overlap: 12,        // % of the shorter side; 0 = do not join at all
  feather: 2,         // px of softening either side of the cut, at 1K
  flatten: 55,        // % lighting flatten
  keepSize: true,     // scale back to the original dimensions
  loopAxis: 'xy',     // which edges to make continuous: 'xy' | 'x' | 'y'
  // Stamping. Defaults are the Unity tool's, so a recipe that works there
  // transfers unchanged.
  stamp: true,        // break the straight seam with clone stamps
  seed: 11,           // -50..50, which stamps get picked
  stampRadius: 0.45,  // 0..1, mapped to 5%..30% of the texture
  stampDensity: 0.4,  // 0..1, how far consecutive stamps overlap
  hardness: 0.6,      // 0..1, how solid the stamp's core is
  stampNoise: 1,      // 0..2, perlin break-up of the stamp's edge
  randomize: 0.25,    // 0..0.5, size and placement jitter
  stampRotate: 1,     // 0..360, degrees of random rotation per stamp
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

  // 'x' means "make the left and right edges meet", i.e. loop along X — which
  // is the horizontal join and the COLUMN of stamps.
  const loopX = settings.loopAxis !== 'y'
  const loopY = settings.loopAxis !== 'x'

  const stamp = (canvas, x = loopX, y = loopY) => (
    settings.stamp ? stampSeams(canvas, settings, x, y) : canvas
  )

  if (settings.mode === 'mirror') {
    // Never rescaled: mirrored edges are the same pixels, and a resample would
    // blend each edge with a clamped neighbour and break that exactness. For
    // even dimensions the fold already returns the original size anyway.
    //
    // The flatten on top keeps that: the coarse grid of a mirror-symmetric
    // image is itself mirror-symmetric, and a cyclic expansion of a symmetric
    // grid gives the two edges the same gain. (Only exactly so when the grid
    // divides the width evenly; otherwise the residual is a fraction of a
    // percent of gain, which is nothing next to what it is removing.)
    //
    // Stamping is safe here too, and is usually what you want: a mirror tiles
    // perfectly and looks like a butterfly, and scattered stamps are the
    // cheapest way to hide the symmetry without touching the tiling. It does
    // cost the one thing mirror had that nothing else does — opposite edges
    // that are the SAME pixels rather than merely continuous ones — so the
    // measured seam goes from exactly zero to the texture's own noise floor.
    // Invisible either way; worth knowing before reading the verdict.
    //
    // Both axes, regardless of loopAxis: a mirror fold tiles in both directions
    // whether you asked for it or not, so there is no such thing as a mirror
    // seam that is only worth stamping on one axis.
    return stamp(flattenLighting(mirrorTile(sourceCanvas), settings.flatten), true, true)
  }

  let working = sourceCanvas

  // Band is a fraction of the SHORTER side so a long thin texture does not get a
  // band wider than its own height.
  const shortest = Math.min(originalWidth, originalHeight)
  const band = settings.overlap > 0
    ? Math.max(2, Math.min(
      Math.floor(shortest * (settings.overlap / 100)),
      Math.floor(originalWidth / 2) - 1,
      Math.floor(originalHeight / 2) - 1,
    ))
    : 0
  // Overlap 0 is a real setting, not a degenerate one: it skips the join
  // entirely and leaves the stamps to do the whole job, which is how the Unity
  // tool works. The join costs a strip of the texture and a resample of
  // everything else to win it back, and on a busy photo the stamps alone can be
  // enough. Only a band that collapsed because the IMAGE is too small is a
  // failure.
  if (settings.overlap > 0 && band < 2) return null

  if (band > 0) {
    // Joining consumes `band` pixels per joined axis. To land back on the
    // original size, resample BEFORE joining rather than after.
    //
    // Rescaling the finished tile is the obvious move and it is wrong: a
    // bilinear resample clamps at the image border instead of wrapping, so it
    // blends the outermost pixels with themselves and re-opens the seam the
    // join just closed. Measured on a bark photo, that cost more than half the
    // improvement (1.11x the interior noise floor, degraded to 1.49x). Growing
    // the source first means the only resample happens on an image whose edges
    // do not matter yet.
    if (settings.keepSize) {
      working = rescale(
        working,
        originalWidth + (loopX ? band : 0),
        originalHeight + (loopY ? band : 0),
      )
    }

    const feather = settings.feather * (shortest / FEATHER_REFERENCE)
    let data = canvasToImageData(working)
    if (loopX) data = joinAxis(data, band, settings.mode, feather)
    // `closed` only matters when the horizontal pass has already made the image
    // loop left-to-right and this pass must not break it, so it tracks loopX.
    if (loopY) data = transpose(joinAxis(transpose(data), band, settings.mode, feather, loopX))
    working = imageDataToCanvas(data)
  }

  const result = stamp(flattenLighting(working, settings.flatten))
  if (result !== sourceCanvas) return result

  // Every stage was a no-op (no join, no flatten, no stamps). Hand back a copy
  // rather than the caller's own canvas, which it is entitled to draw over.
  const copy = makeCanvas(originalWidth, originalHeight)
  copy.getContext('2d').drawImage(sourceCanvas, 0, 0)
  return copy
}


function rescale(canvas, width, height) {
  if (canvas.width === width && canvas.height === height) return canvas
  if (width * height > CUBIC_FALLBACK_PIXELS) {
    const out = makeCanvas(width, height)
    const context = out.getContext('2d')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(canvas, 0, 0, width, height)
    return out
  }
  return imageDataToCanvas(resampleImageData(canvasToImageData(canvas), width, height))
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

  // Halve repeatedly before the final draw. A single big minifying drawImage
  // point-samples badly enough to invent detail the texture does not have —
  // which, on a seam preview, means inventing seams that are not there.
  let tile = canvas
  while (tile.width >= cellWidth * 2 && tile.height >= cellHeight * 2) {
    const half = makeCanvas(Math.max(1, tile.width >> 1), Math.max(1, tile.height >> 1))
    const halfContext = half.getContext('2d')
    halfContext.imageSmoothingEnabled = true
    halfContext.imageSmoothingQuality = 'high'
    halfContext.drawImage(tile, 0, 0, half.width, half.height)
    tile = half
  }

  for (let row = 0; row < repeat; row += 1) {
    for (let column = 0; column < repeat; column += 1) {
      context.drawImage(tile, column * cellWidth, row * cellHeight, cellWidth, cellHeight)
    }
  }
}

/**
 * How visible the tiling seam is.
 *
 * Returns { seam, floor, ratio, bias }. The raw edge difference is meaningless
 * alone: neighbouring pixels in any natural texture differ, so even a perfect
 * tile scores well above zero. What matters is the edge difference measured
 * against the image's OWN interior neighbour difference — its noise floor. A
 * ratio near 1 means the seam is no more of a discontinuity than the texture's
 * own grain, which is precisely what invisible means.
 *
 * `bias` is the other half of the question, and the half that a seam metric on
 * its own will cheerfully report as solved: how much brighter one side of the
 * tile is than the other, in 0-100. There is no discontinuity to find when a
 * tile merely fades from light to dark — it just reads as a grid once it
 * repeats, which is the fault people describe as "not tileable".
 */
export function measureSeam(canvas) {
  const blank = { seam: 0, floor: 0, ratio: 0, bias: 0 }
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

  // Quarter-strip means, on the same stride, for the light/dark imbalance.
  const strip = [0, 0, 0, 0]
  const strips = [0, 0, 0, 0]
  const quarterX = Math.max(1, width >> 2)
  const quarterY = Math.max(1, height >> 2)
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      if (x < quarterX) { strip[0] += luminance; strips[0] += 1 }
      if (x >= width - quarterX) { strip[1] += luminance; strips[1] += 1 }
      if (y < quarterY) { strip[2] += luminance; strips[2] += 1 }
      if (y >= height - quarterY) { strip[3] += luminance; strips[3] += 1 }
    }
  }
  const stripMean = index => (strips[index] ? strip[index] / strips[index] : 0)
  const bias = Math.max(
    Math.abs(stripMean(0) - stripMean(1)),
    Math.abs(stripMean(2) - stripMean(3)),
  ) * (100 / 255)

  return { seam, floor, ratio: floor > 0.01 ? seam / floor : 0, bias }
}

/** A plain-language verdict for the ratio from `measureSeam`. */
export function describeSeam(ratio) {
  if (!ratio) return 'unknown'
  if (ratio < 1.25) return 'invisible'
  if (ratio < 1.6) return 'faint'
  if (ratio < 2.2) return 'visible'
  return 'obvious'
}

/** A plain-language verdict for the `bias` from `measureSeam`. */
export function describeTiling(bias) {
  if (bias < 1.5) return 'even'
  if (bias < 3.5) return 'slight banding'
  if (bias < 7) return 'banding'
  return 'strong banding'
}
