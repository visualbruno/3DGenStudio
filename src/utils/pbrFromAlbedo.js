// PBR maps from an albedo texture: height, normal, roughness, metalness and
// ambient occlusion estimated from the colour alone, plus an optional
// de-lighting pass on the colour itself.
//
// Ported from ComfyUI-PBR-Material-Generator (FullPBRThreeJSPreview,
// https://github.com/aimpowerment/ComfyUI-PBR-Material-Generator, commit
// 5f425fc), Copyright aimpowerment, licensed under the Apache License 2.0 —
// see public/licenses/ComfyUI-PBR-Material-Generator.LICENSE.txt (copied into
// dist/, so it ships with the app; the minifier strips this comment).
// Modified for 3D Gen Studio, 2026:
//   - rewritten from PyTorch to plain JavaScript over typed arrays;
//   - UV-atlas aware: the empty gutter between UV islands is filled (pull-push)
//     before any filter runs, so blurs and gradients at an island's edge do not
//     sample the gutter and draw a dark rim / a ridge in the normal map along
//     every seam. The original works on a single tiling image and has no notion
//     of islands;
//   - normals are written in the glTF (OpenGL, +Y up) convention by default —
//     the original's default is DirectX (its `invert_normal_y` gives OpenGL);
//   - pixel radii and the gradient strength are scaled with the texture size
//     (the settings mean what they meant on a 1024px image), so the same
//     settings give the same look on a 512px and a 4096px atlas;
//   - blurs pad by replicating the edge rather than with zeros, so the image
//     border no longer darkens;
//   - roughness, metalness and AO are packed into one ORM texture (R = AO,
//     G = roughness, B = metalness), the layout glTF expects.
//
// Pure: no DOM, no three.js. The editor rasterises the UVs into `coverage` and
// moves the results in and out of canvases; see MeshEditorPage.

export const PBR_REFERENCE_SIZE = 1024

export const DEFAULT_PBR_OPTIONS = Object.freeze({
  // Which maps to generate and attach.
  maps: Object.freeze({ normal: true, roughness: true, metalness: true, ao: true }),
  // 1. Albedo de-lighting (0 = leave the colour alone).
  delightStrength: 0,
  // 2. Height (derived from luminance).
  depthContrast: 1,
  depthSmoothness: 1,
  invertDepth: false,
  // 3. Normal.
  normalStrength: 2,
  normalBlur: 0,
  detailMix: 0.35,
  // false = glTF / OpenGL (green up). true = DirectX.
  invertNormalY: false,
  // 4. Roughness.
  roughnessBase: 0.5,
  roughnessContrast: 1.2,
  invertRoughness: true,
  // 5. Metalness. Strength 0 = a fully dielectric map.
  metalnessThreshold: 0.65,
  metalnessStrength: 0,
  // 6. Ambient occlusion.
  aoStrength: 1.2,
  aoRadius: 8,
})

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value)

// Scale a pixel radius set against a 1024px image to this texture. A radius the
// user set above zero never rounds down to "off".
function scaleRadius(radius, scale) {
  const r = Math.round(Number(radius) || 0)
  if (r <= 0) return 0
  return Math.max(1, Math.round(r * scale))
}

// Separable box blur, replicate-padded, O(N) whatever the radius.
export function boxBlur(src, width, height, radius) {
  const r = Math.floor(radius)
  if (r <= 0) return Float32Array.from(src)
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const size = r * 2 + 1

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let k = -r; k <= r; k += 1) {
      sum += src[row + Math.min(width - 1, Math.max(0, k))]
    }
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / size
      const add = Math.min(width - 1, x + r + 1)
      const sub = Math.max(0, x - r)
      sum += src[row + add] - src[row + sub]
    }
  }

  // Vertical pass swept row by row with one running sum per column — walking
  // each column instead strides the whole image per step and was 3x slower.
  const colSum = new Float64Array(width)
  for (let k = -r; k <= r; k += 1) {
    const row = Math.min(height - 1, Math.max(0, k)) * width
    for (let x = 0; x < width; x += 1) colSum[x] += tmp[row + x]
  }
  const inv = 1 / size
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    const add = Math.min(height - 1, y + r + 1) * width
    const sub = Math.max(0, y - r) * width
    for (let x = 0; x < width; x += 1) {
      out[row + x] = colSum[x] * inv
      colSum[x] += tmp[add + x] - tmp[sub + x]
    }
  }

  return out
}

// Fill every texel outside `coverage` from the covered ones around it
// (pull-push: average down a pyramid of the covered texels, then interpolate
// back up into the holes). Smooth, reaches arbitrarily wide gutters, and
// leaves covered texels untouched. In place.
export function fillUncovered(values, coverage, width, height) {
  if (!coverage) return values
  const levels = []
  let w = width
  let h = height
  let sum = new Float32Array(width * height)
  let weight = new Float32Array(width * height)
  let any = false
  for (let i = 0; i < sum.length; i += 1) {
    if (coverage[i]) {
      sum[i] = values[i]
      weight[i] = 1
      any = true
    }
  }
  if (!any) return values
  levels.push({ w, h, sum, weight })

  // Pull.
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2))
    const nh = Math.max(1, Math.ceil(h / 2))
    const nsum = new Float32Array(nw * nh)
    const nweight = new Float32Array(nw * nh)
    for (let y = 0; y < h; y += 1) {
      const ny = y >> 1
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (!weight[i]) continue
        const j = ny * nw + (x >> 1)
        nsum[j] += sum[i]
        nweight[j] += weight[i]
      }
    }
    w = nw
    h = nh
    sum = nsum
    weight = nweight
    levels.push({ w, h, sum, weight })
  }

  // Normalised value per level; holes are filled top-down from the parent.
  const value = levels.map(level => {
    const v = new Float32Array(level.w * level.h)
    for (let i = 0; i < v.length; i += 1) {
      if (level.weight[i] > 0) v[i] = level.sum[i] / level.weight[i]
    }
    return v
  })

  for (let l = levels.length - 2; l >= 0; l -= 1) {
    const { w: lw, h: lh, weight: lweight } = levels[l]
    const { w: pw, h: ph } = levels[l + 1]
    const parent = value[l + 1]
    const current = value[l]
    for (let y = 0; y < lh; y += 1) {
      // Bilinear sample of the parent at this texel's centre.
      const py = Math.min(ph - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
      const y0 = Math.floor(py)
      const y1 = Math.min(ph - 1, y0 + 1)
      const fy = py - y0
      for (let x = 0; x < lw; x += 1) {
        const i = y * lw + x
        if (lweight[i] > 0) continue
        const px = Math.min(pw - 1, Math.max(0, (x + 0.5) / 2 - 0.5))
        const x0 = Math.floor(px)
        const x1 = Math.min(pw - 1, x0 + 1)
        const fx = px - x0
        const top = parent[y0 * pw + x0] * (1 - fx) + parent[y0 * pw + x1] * fx
        const bottom = parent[y1 * pw + x0] * (1 - fx) + parent[y1 * pw + x1] * fx
        current[i] = top * (1 - fy) + bottom * fy
      }
    }
  }

  const base = value[0]
  for (let i = 0; i < values.length; i += 1) {
    if (!coverage[i]) values[i] = base[i]
  }
  return values
}

// Normal map from two height fields: the macro shape (smoothed height) plus a
// `mix` of the fine detail (raw luminance). Each is a central-difference
// gradient turned into a unit tangent-space normal; the two are summed and
// renormalised. `greenUp` true is the glTF / OpenGL convention: the image's top
// is +Y and image rows run downwards, so a slope rising down the rows tilts the
// normal up (+Y).
//
// The stages below are separate small functions with plain-number arguments on
// purpose: as one long function reading `options.x` inside its loops, V8
// optimised it badly and a 2048px texture took a second.
function writeNormals(macro, fine, width, height, strength, fineStrength, mix, greenUp, out) {
  const ySign = greenUp ? 1 : -1
  const ms = 0.5 * strength
  const fs = 0.5 * fineStrength
  for (let y = 0; y < height; y += 1) {
    const up = (y > 0 ? y - 1 : 0) * width
    const down = (y < height - 1 ? y + 1 : height - 1) * width
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const left = row + (x > 0 ? x - 1 : 0)
      const right = row + (x < width - 1 ? x + 1 : width - 1)
      let ax = -(macro[right] - macro[left]) * ms
      let ay = ySign * (macro[down + x] - macro[up + x]) * ms
      let inv = 1 / Math.sqrt(ax * ax + ay * ay + 1 + 1e-8)
      let nx = ax * inv
      let ny = ay * inv
      let nz = inv
      if (mix > 0) {
        ax = -(fine[right] - fine[left]) * fs
        ay = ySign * (fine[down + x] - fine[up + x]) * fs
        inv = 1 / Math.sqrt(ax * ax + ay * ay + 1 + 1e-8)
        nx += ax * inv * mix
        ny += ay * inv * mix
        nz += inv * mix
        inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
        nx *= inv
        ny *= inv
        nz *= inv
      }
      // Uint8ClampedArray rounds on assignment.
      const j = (row + x) * 4
      out[j] = (nx * 0.5 + 0.5) * 255
      out[j + 1] = (ny * 0.5 + 0.5) * 255
      out[j + 2] = (nz * 0.5 + 0.5) * 255
      out[j + 3] = 255
    }
  }
}

function readLuminance(rgba, count, lum, sat) {
  const k = 1 / 255
  for (let i = 0, j = 0; i < count; i += 1, j += 4) {
    const r = rgba[j] * k
    const g = rgba[j + 1] * k
    const b = rgba[j + 2] * k
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b)
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b)
    sat[i] = (max - min) / (max + 1e-6)
  }
}

// Local mean luminance → the gain that brings it to mid-grey (upstream's
// formula), in place.
function toDelightGain(avg, count) {
  for (let i = 0; i < count; i += 1) {
    const gain = 0.5 / (avg[i] + 0.15)
    avg[i] = gain < 0.4 ? 0.4 : gain > 2.2 ? 2.2 : gain
  }
}

// De-light `rgba` (width x height) with a gain field of any resolution,
// sampled bilinearly. Writes into `out` (may be a copy of rgba). Texels outside
// `coverage` keep their colour, so the gutter's existing padding survives.
export function applyDelight(rgba, width, height, gain, gainWidth, gainHeight, strength, out, coverage = null) {
  const s = clamp01(Number(strength) || 0)
  const k = 1 / 255
  const sx = gainWidth / width
  const sy = gainHeight / height
  const cover = coverage && coverage.length === width * height ? coverage : null
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(gainHeight - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(gy)
    const y1 = Math.min(gainHeight - 1, y0 + 1)
    const fy = gy - y0
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      if (cover && !cover[i]) continue
      const gx = Math.min(gainWidth - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(gx)
      const x1 = Math.min(gainWidth - 1, x0 + 1)
      const fx = gx - x0
      const top = gain[y0 * gainWidth + x0] * (1 - fx) + gain[y0 * gainWidth + x1] * fx
      const bottom = gain[y1 * gainWidth + x0] * (1 - fx) + gain[y1 * gainWidth + x1] * fx
      const g = top * (1 - fy) + bottom * fy
      const j = i * 4
      for (let c = 0; c < 3; c += 1) {
        const v = rgba[j + c] * k
        let lit = v * g
        if (lit > 1) lit = 1
        out[j + c] = (v + (lit - v) * s) * 255
      }
    }
  }
  return out
}

function shapeDepth(depth, count, contrast, invert) {
  for (let i = 0; i < count; i += 1) {
    let d = (depth[i] - 0.5) * contrast + 0.5
    d = d < 0 ? 0 : d > 1 ? 1 : d
    depth[i] = invert ? 1 - d : d
  }
}

function writeGrey(values, count, out) {
  for (let i = 0, j = 0; i < count; i += 1, j += 4) {
    const v = values[i] * 255
    out[j] = v
    out[j + 1] = v
    out[j + 2] = v
    out[j + 3] = 255
  }
}

// R = AO, G = roughness, B = metalness. A channel that is off is written
// neutral: AO white; roughness/metalness are never bound when off, so their
// bytes only need to be harmless.
function writeOrm(depth, lum, sat, small, large, count, p, out) {
  const span = 1 / Math.max(1e-4, 1 - p.metalThreshold)
  const aoGain = p.aoStrength * 3
  for (let i = 0, j = 0; i < count; i += 1, j += 4) {
    const d = depth[i]
    if (small) {
      let cavity = (small[i] - d) * 0.6 + (large[i] - d) * 0.4
      cavity = cavity < 0 ? 0 : cavity > 1 ? 1 : cavity
      const ao = 1 - cavity * aoGain
      out[j] = (ao < 0 ? 0 : ao) * 255
    } else {
      out[j] = 255
    }
    if (p.roughness) {
      const src = p.invertRoughness ? 1 - d : d
      const r = (src - 0.5) * p.roughnessContrast + p.roughnessBase
      out[j + 1] = (r < 0 ? 0 : r > 1 ? 1 : r) * 255
    } else {
      out[j + 1] = 255
    }
    if (p.metalness) {
      let raw = (lum[i] - p.metalThreshold) * span
      raw = raw < 0 ? 0 : raw > 1 ? 1 : raw
      const m = raw * (1 - sat[i] * 0.35) * p.metalStrength
      out[j + 2] = (m > 1 ? 1 : m) * 255
    } else {
      out[j + 2] = 0
    }
    out[j + 3] = 255
  }
}

// `rgba`: Uint8ClampedArray (canvas ImageData data) of the ALBEDO, never of an
// already de-lit copy. `coverage`: optional Uint8Array, 1 where a UV triangle
// covers the texel. Returns RGBA byte arrays for every requested map, ready for
// putImageData.
export function generatePbrMaps(rgba, width, height, options = {}, coverage = null) {
  const o = { ...DEFAULT_PBR_OPTIONS, ...options, maps: { ...DEFAULT_PBR_OPTIONS.maps, ...(options.maps || {}) } }
  const count = width * height
  const scale = Math.max(width, height) / PBR_REFERENCE_SIZE
  const cover = coverage && coverage.length === count ? coverage : null

  const lum = new Float32Array(count)
  const sat = new Float32Array(count)
  readLuminance(rgba, count, lum, sat)
  // Everything below reads `lum` through a filter, so the gutter has to carry
  // something continuous with the islands first.
  if (cover) fillUncovered(lum, cover, width, height)

  const result = { width, height }

  // 1. De-lighting, returned as a gain field rather than as colour: the gain
  // comes from a wide blur, so it can be computed on a downscaled preview and
  // still be applied to the full-resolution albedo (applyDelight) without
  // blurring the colour itself.
  if ((Number(o.delightStrength) || 0) > 0) {
    const avg = boxBlur(lum, width, height, Math.max(1, Math.round(16 * scale)))
    toDelightGain(avg, count)
    result.delightGain = avg
  }

  // 2. Height.
  const depth = boxBlur(lum, width, height, scaleRadius(o.depthSmoothness, scale))
  shapeDepth(depth, count, Number(o.depthContrast), !!o.invertDepth)
  result.height = new Uint8ClampedArray(count * 4)
  writeGrey(depth, count, result.height)

  // 3. Normal: macro shape from the (smoothed) height plus fine detail from the
  // raw luminance. Strength scales with resolution — the per-texel slope halves
  // every time the texture doubles.
  if (o.maps.normal) {
    const strength = Number(o.normalStrength) * scale
    const blur = scaleRadius(o.normalBlur, scale)
    const macro = blur > 0 ? boxBlur(depth, width, height, blur) : depth
    result.normal = new Uint8ClampedArray(count * 4)
    writeNormals(macro, lum, width, height, strength, strength * 0.75,
      Math.max(0, Number(o.detailMix) || 0), !o.invertNormalY, result.normal)
  }

  // 4–6. Roughness, metalness and AO, packed as glTF's ORM.
  if (o.maps.roughness || o.maps.metalness || o.maps.ao) {
    let small = null
    let large = null
    if (o.maps.ao) {
      const radius = Math.max(1, Math.round((Number(o.aoRadius) || 1) * scale))
      small = boxBlur(depth, width, height, Math.max(1, radius >> 1))
      large = boxBlur(depth, width, height, Math.max(2, radius))
    }
    result.orm = new Uint8ClampedArray(count * 4)
    writeOrm(depth, lum, sat, small, large, count, {
      roughness: !!o.maps.roughness,
      metalness: !!o.maps.metalness,
      invertRoughness: !!o.invertRoughness,
      roughnessContrast: Number(o.roughnessContrast),
      roughnessBase: Number(o.roughnessBase),
      metalThreshold: Number(o.metalnessThreshold),
      metalStrength: Number(o.metalnessStrength),
      aoStrength: Number(o.aoStrength),
    }, result.orm)
  }

  return result
}

// Mark every texel a UV triangle covers. `uvPixels` is a Float32Array of
// x,y pairs already in texel units (u * width, v * height in canvas rows), and
// `indices` triples into it (null = non-indexed). Conservative: texels whose
// centre is inside, plus the texel under each vertex, plus a one-texel ring —
// bilinear sampling reaches half a texel past an island's edge, and those
// texels must hold real colour, not gutter fill.
export function rasterizeUvCoverage(uvPixels, indices, width, height, coverage = null) {
  const mask = coverage || new Uint8Array(width * height)
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(uvPixels.length / 6)
  const mark = (x, y) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    if (ix >= 0 && iy >= 0 && ix < width && iy < height) mask[iy * width + ix] = 1
  }
  for (let t = 0; t < triCount; t += 1) {
    const a = indices ? indices[t * 3] : t * 3
    const b = indices ? indices[t * 3 + 1] : t * 3 + 1
    const c = indices ? indices[t * 3 + 2] : t * 3 + 2
    const ax = uvPixels[a * 2]
    const ay = uvPixels[a * 2 + 1]
    const bx = uvPixels[b * 2]
    const by = uvPixels[b * 2 + 1]
    const cx = uvPixels[c * 2]
    const cy = uvPixels[c * 2 + 1]
    if (!Number.isFinite(ax + ay + bx + by + cx + cy)) continue
    mark(ax, ay)
    mark(bx, by)
    mark(cx, cy)
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(area) < 1e-12) continue
    const sign = area > 0 ? 1 : -1
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)))
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * sign
        const w1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * sign
        const w2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * sign
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) mask[y * width + x] = 1
      }
    }
  }

  // One-texel ring.
  const grown = Uint8Array.from(mask)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      if (mask[i]) continue
      if ((x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1])
        || (y > 0 && mask[i - width]) || (y < height - 1 && mask[i + width])) {
        grown[i] = 1
      }
    }
  }
  return grown
}

// One channel of an RGBA byte map spread to an opaque grey image — how the
// packed ORM's roughness / metalness / AO are shown and downloaded separately.
export function extractChannel(bytes, channel) {
  const out = new Uint8ClampedArray(bytes.length)
  for (let i = 0; i < bytes.length; i += 4) {
    const v = bytes[i + channel]
    out[i] = v
    out[i + 1] = v
    out[i + 2] = v
    out[i + 3] = 255
  }
  return out
}

export function coverageFraction(coverage) {
  if (!coverage?.length) return 0
  let n = 0
  for (let i = 0; i < coverage.length; i += 1) n += coverage[i]
  return n / coverage.length
}
