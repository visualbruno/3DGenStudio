// Checks for pbrFromAlbedo.js. No test framework — run it directly:
//
//     node src/utils/pbrFromAlbedo.test.mjs
//
// The normal map's green direction is the one part that cannot be eyeballed
// from the code (the upstream node's default is DirectX, glTF wants OpenGL, and
// three.js flips green again on export for meshes without tangents), so it is
// pinned here with a bump whose slopes have a known direction.
import assert from 'node:assert/strict'
import {
  boxBlur, fillUncovered, generatePbrMaps, rasterizeUvCoverage, coverageFraction, applyDelight,
} from './pbrFromAlbedo.js'

let passed = 0
const check = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`) }

const W = 64
const H = 64

// A bright disc on a dark field: luminance = height, so the disc is a bump.
function bumpImage(width = W, height = H) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const v = Math.round(255 * Math.max(0, 1 - d / (width * 0.3)))
      const j = (y * width + x) * 4
      rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255
    }
  }
  return rgba
}

const at = (bytes, x, y, c, width = W) => bytes[(y * width + x) * 4 + c]

check('box blur keeps a constant field constant, edges included', () => {
  const src = new Float32Array(W * H).fill(0.4)
  const out = boxBlur(src, W, H, 7)
  for (const v of out) assert.ok(Math.abs(v - 0.4) < 1e-6)
})

check('normals: glTF / OpenGL green points to the top of the image', () => {
  const { normal } = generatePbrMaps(bumpImage(), W, H, { normalStrength: 40, detailMix: 0 })
  // Above the bump (smaller row) the surface faces up (towards row 0): G > 128.
  assert.ok(at(normal, 32, 22, 1) > 140, `G above bump = ${at(normal, 32, 22, 1)}`)
  // Below it, down: G < 128.
  assert.ok(at(normal, 32, 41, 1) < 116, `G below bump = ${at(normal, 32, 41, 1)}`)
  // Right of it, right: R > 128. Left of it: R < 128.
  assert.ok(at(normal, 41, 32, 0) > 140, `R right of bump = ${at(normal, 41, 32, 0)}`)
  assert.ok(at(normal, 22, 32, 0) < 116, `R left of bump = ${at(normal, 22, 32, 0)}`)
})

check('normals: invertNormalY gives the DirectX convention', () => {
  const { normal } = generatePbrMaps(bumpImage(), W, H, { normalStrength: 40, detailMix: 0, invertNormalY: true })
  assert.ok(at(normal, 32, 22, 1) < 116)
  assert.ok(at(normal, 32, 41, 1) > 140)
})

check('normal strength is resolution independent', () => {
  // The same bump at 2x the resolution must tilt the normal by the same amount.
  const small = generatePbrMaps(bumpImage(64, 64), 64, 64, { normalStrength: 40, detailMix: 0 }).normal
  const big = generatePbrMaps(bumpImage(128, 128), 128, 128, { normalStrength: 40, detailMix: 0 }).normal
  const gSmall = at(small, 32, 22, 1, 64)
  const gBig = at(big, 64, 44, 1, 128)
  assert.ok(Math.abs(gSmall - gBig) <= 6, `small ${gSmall} vs big ${gBig}`)
})

check('flat albedo gives a flat normal and no occlusion', () => {
  const rgba = new Uint8ClampedArray(W * H * 4).fill(128)
  const { normal, orm } = generatePbrMaps(rgba, W, H)
  for (let i = 0; i < W * H; i += 1) {
    assert.equal(normal[i * 4], 128)
    assert.equal(normal[i * 4 + 1], 128)
    assert.equal(normal[i * 4 + 2], 255)
    assert.equal(orm[i * 4], 255) // AO
  }
})

check('defaults reproduce the upstream roughness formula', () => {
  // Grey 0.5 albedo, depth = 0.5, inverted roughness 0.5 → (0.5-0.5)*1.2 + 0.5 = 0.5.
  const rgba = new Uint8ClampedArray(W * H * 4).fill(128)
  const { orm } = generatePbrMaps(rgba, W, H)
  assert.ok(Math.abs(orm[1] - 128) <= 1, `roughness = ${orm[1]}`)
  assert.equal(orm[2], 0) // metalness strength defaults to 0
})

check('pull-push fills the gutter from the island and leaves the island alone', () => {
  const values = new Float32Array(W * H)
  const coverage = new Uint8Array(W * H)
  for (let y = 10; y < 30; y += 1) {
    for (let x = 10; x < 30; x += 1) { values[y * W + x] = 0.8; coverage[y * W + x] = 1 }
  }
  fillUncovered(values, coverage, W, H)
  for (let i = 0; i < values.length; i += 1) {
    assert.ok(Math.abs(values[i] - 0.8) < 1e-5, `texel ${i} = ${values[i]}`)
  }
})

check('the gutter does not draw a ridge in the normal map at an island edge', () => {
  // A flat mid-grey island in a BLACK gutter. Without the fill the island's edge
  // reads as a cliff; with it, the edge stays flat.
  const rgba = new Uint8ClampedArray(W * H * 4)
  const coverage = new Uint8Array(W * H)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const j = (y * W + x) * 4
      rgba[j + 3] = 255
      if (x >= 16 && x < 48 && y >= 16 && y < 48) {
        rgba[j] = 150; rgba[j + 1] = 150; rgba[j + 2] = 150
        coverage[y * W + x] = 1
      }
    }
  }
  const withFill = generatePbrMaps(rgba, W, H, { normalStrength: 40 }, coverage).normal
  const without = generatePbrMaps(rgba, W, H, { normalStrength: 40 }).normal
  assert.ok(Math.abs(at(withFill, 16, 32, 0) - 128) <= 1, `edge R with fill = ${at(withFill, 16, 32, 0)}`)
  assert.ok(Math.abs(at(without, 16, 32, 0) - 128) > 20, 'the unfilled case should show the cliff')
})

check('UV rasteriser covers a triangle plus a one-texel ring, either winding', () => {
  const uv = new Float32Array([8, 8, 40, 8, 8, 40])
  const ccw = rasterizeUvCoverage(uv, null, W, H)
  const cw = rasterizeUvCoverage(uv, [0, 2, 1], W, H)
  assert.deepEqual(ccw, cw)
  assert.equal(ccw[10 * W + 10], 1) // inside
  assert.equal(ccw[7 * W + 10], 1) // ring above the top edge
  assert.equal(ccw[50 * W + 50], 0) // outside
  const frac = coverageFraction(ccw)
  assert.ok(frac > 0.12 && frac < 0.18, `coverage ${frac}`)
})

check('de-lighting only touches covered texels', () => {
  const rgba = bumpImage()
  const coverage = new Uint8Array(W * H)
  coverage.fill(1, 0, (W * H) / 2)
  const { delightGain } = generatePbrMaps(rgba, W, H, { delightStrength: 1 }, coverage)
  const baseColor = applyDelight(rgba, W, H, delightGain, W, H, 1, new Uint8ClampedArray(rgba), coverage)
  const last = (W * H - 1) * 4
  assert.equal(baseColor[last], rgba[last])
  let changed = 0
  for (let i = 0; i < (W * H) / 2; i += 1) if (baseColor[i * 4] !== rgba[i * 4]) changed += 1
  assert.ok(changed > 0)
})

check('a preview-resolution gain de-lights the full-resolution albedo the same way', () => {
  // The preview path computes the gain at half size and applies it at full
  // size; the result must match computing it at full size.
  const full = bumpImage(128, 128)
  const half = bumpImage(64, 64)
  const gFull = generatePbrMaps(full, 128, 128, { delightStrength: 1 }).delightGain
  const gHalf = generatePbrMaps(half, 64, 64, { delightStrength: 1 }).delightGain
  const a = applyDelight(full, 128, 128, gFull, 128, 128, 1, new Uint8ClampedArray(full))
  const b = applyDelight(full, 128, 128, gHalf, 64, 64, 1, new Uint8ClampedArray(full))
  let worst = 0
  for (let i = 0; i < a.length; i += 4) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  assert.ok(worst <= 12, `worst channel difference ${worst}`)
})

console.log(`\n${passed} checks passed`)
