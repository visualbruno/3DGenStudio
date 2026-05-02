// Sculpting utilities: spatial indexing, brush kernels, incremental normals.
//
// All kernels operate directly on the BufferGeometry's typed-array attributes
// (zero allocations per stamp) and on caller-owned scratch buffers, so they
// can later be ported to a GPGPU pipeline (positions/normals as DataTextures,
// brush params as uniforms, falloff in fragment shader) without changing the
// JS API.
//
// Geometry assumption: indexed BufferGeometry with welded vertices (the form
// produced by `loadEditableGeometryFromObject` in src/utils/meshEditor.js).

import * as THREE from 'three'

const MAX_GRID_CELLS = 4_000_000 // cap memory footprint of the uniform grid
const INITIAL_QUERY_CAP = 4096

/**
 * Build a sculpt context for an indexed BufferGeometry.
 * Computes vertex-triangle and vertex-vertex adjacency (CSR layout) for
 * incremental normal recompute and the smooth/auto-smooth kernels. The
 * uniform grid is built lazily by `ensureGrid` since it depends on brush
 * radius.
 */
export function createSculptContext(geometry) {
  if (!geometry?.index) {
    throw new Error('Sculpting requires an indexed BufferGeometry')
  }

  const positionAttr = geometry.attributes.position
  if (!positionAttr) {
    throw new Error('Geometry has no position attribute')
  }

  // Ensure a normal attribute exists (Three.js Float32 attribute).
  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals()
  }

  const vertexCount = positionAttr.count
  const indices = geometry.index.array
  const triCount = indices.length / 3

  // --- Vertex -> triangle adjacency (CSR) ---------------------------------
  const vertexTriOffsets = new Int32Array(vertexCount + 1)
  for (let i = 0; i < indices.length; i++) {
    vertexTriOffsets[indices[i] + 1] += 1
  }
  for (let i = 1; i <= vertexCount; i++) {
    vertexTriOffsets[i] += vertexTriOffsets[i - 1]
  }
  const vertexTris = new Int32Array(indices.length)
  {
    const cursors = new Int32Array(vertexCount)
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]
        vertexTris[vertexTriOffsets[v] + cursors[v]] = t
        cursors[v] += 1
      }
    }
  }

  // --- Vertex -> unique vertex neighbors (CSR) ----------------------------
  // Use a per-vertex "stamp" trick to dedupe without a Set per iteration.
  const stamps = new Int32Array(vertexCount)
  const neighborCounts = new Int32Array(vertexCount)
  let stamp = 0
  for (let v = 0; v < vertexCount; v++) {
    stamp += 1
    let count = 0
    const triStart = vertexTriOffsets[v]
    const triEnd = vertexTriOffsets[v + 1]
    for (let i = triStart; i < triEnd; i++) {
      const t = vertexTris[i]
      for (let k = 0; k < 3; k++) {
        const w = indices[t * 3 + k]
        if (w !== v && stamps[w] !== stamp) {
          stamps[w] = stamp
          count += 1
        }
      }
    }
    neighborCounts[v] = count
  }

  const vertexNeighborOffsets = new Int32Array(vertexCount + 1)
  for (let v = 0; v < vertexCount; v++) {
    vertexNeighborOffsets[v + 1] = vertexNeighborOffsets[v] + neighborCounts[v]
  }
  const vertexNeighbors = new Int32Array(vertexNeighborOffsets[vertexCount])

  stamps.fill(0)
  stamp = 0
  for (let v = 0; v < vertexCount; v++) {
    stamp += 1
    let writeIdx = vertexNeighborOffsets[v]
    const triStart = vertexTriOffsets[v]
    const triEnd = vertexTriOffsets[v + 1]
    for (let i = triStart; i < triEnd; i++) {
      const t = vertexTris[i]
      for (let k = 0; k < 3; k++) {
        const w = indices[t * 3 + k]
        if (w !== v && stamps[w] !== stamp) {
          stamps[w] = stamp
          vertexNeighbors[writeIdx++] = w
        }
      }
    }
  }

  return {
    geometry,
    vertexCount,
    triCount,
    indices,
    vertexTriOffsets,
    vertexTris,
    vertexNeighborOffsets,
    vertexNeighbors,
    // Lazy uniform grid for radius queries
    grid: null,
    gridCellSize: 0,
    // Dirty bitset for incremental normal recompute
    dirtyMask: new Uint8Array(vertexCount),
    // Reusable output buffers for queryRadius (auto-grow)
    _outIndices: new Int32Array(INITIAL_QUERY_CAP),
    _outWeights: new Float32Array(INITIAL_QUERY_CAP)
  }
}

// ---------------------------------------------------------------------------
// Uniform grid
// ---------------------------------------------------------------------------

function buildGrid(ctx, requestedCellSize) {
  let cellSize = Math.max(1e-6, requestedCellSize)
  const positions = ctx.geometry.attributes.position.array
  const vertexCount = ctx.vertexCount

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3]
    const y = positions[v * 3 + 1]
    const z = positions[v * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  // Coarsen if the cell count would blow up memory.
  let dimX, dimY, dimZ, cellCount
  for (;;) {
    const inv = 1 / cellSize
    dimX = Math.max(1, Math.ceil((maxX - minX) * inv) + 1)
    dimY = Math.max(1, Math.ceil((maxY - minY) * inv) + 1)
    dimZ = Math.max(1, Math.ceil((maxZ - minZ) * inv) + 1)
    cellCount = dimX * dimY * dimZ
    if (cellCount <= MAX_GRID_CELLS) break
    cellSize *= Math.cbrt(cellCount / MAX_GRID_CELLS) * 1.05
  }

  const inv = 1 / cellSize
  const cellOffsets = new Int32Array(cellCount + 1)

  // Pass 1: count.
  for (let v = 0; v < vertexCount; v++) {
    const cx = Math.min(dimX - 1, Math.max(0, Math.floor((positions[v * 3] - minX) * inv)))
    const cy = Math.min(dimY - 1, Math.max(0, Math.floor((positions[v * 3 + 1] - minY) * inv)))
    const cz = Math.min(dimZ - 1, Math.max(0, Math.floor((positions[v * 3 + 2] - minZ) * inv)))
    cellOffsets[cx + cy * dimX + cz * dimX * dimY + 1] += 1
  }
  for (let i = 1; i <= cellCount; i++) cellOffsets[i] += cellOffsets[i - 1]

  // Pass 2: scatter.
  const cellEntries = new Int32Array(vertexCount)
  const cursors = new Int32Array(cellCount)
  for (let v = 0; v < vertexCount; v++) {
    const cx = Math.min(dimX - 1, Math.max(0, Math.floor((positions[v * 3] - minX) * inv)))
    const cy = Math.min(dimY - 1, Math.max(0, Math.floor((positions[v * 3 + 1] - minY) * inv)))
    const cz = Math.min(dimZ - 1, Math.max(0, Math.floor((positions[v * 3 + 2] - minZ) * inv)))
    const cell = cx + cy * dimX + cz * dimX * dimY
    cellEntries[cellOffsets[cell] + cursors[cell]] = v
    cursors[cell] += 1
  }

  return {
    cellSize, inv,
    minX, minY, minZ,
    dimX, dimY, dimZ,
    cellOffsets, cellEntries
  }
}

/**
 * Ensure the spatial grid is sized appropriately for the given brush radius.
 * Rebuilds only if the desired cell size differs by >2× from the cached one,
 * so consecutive strokes at similar radii reuse the same grid.
 */
export function ensureGrid(ctx, brushRadius) {
  const desired = Math.max(1e-6, brushRadius * 1.5)
  if (!ctx.grid
    || desired > ctx.gridCellSize * 2
    || desired < ctx.gridCellSize * 0.5) {
    ctx.grid = buildGrid(ctx, desired)
    ctx.gridCellSize = ctx.grid.cellSize
  }
}

/**
 * Force a grid rebuild on next ensureGrid call. Use after a stroke if many
 * vertices moved far enough that their grid cell assignment is now wrong.
 */
export function invalidateGrid(ctx) {
  ctx.grid = null
  ctx.gridCellSize = 0
}

// ---------------------------------------------------------------------------
// Radius query with falloff weighting
// ---------------------------------------------------------------------------

/**
 * Find vertices within `radius` of (cx, cy, cz). Writes indices and falloff
 * weights into ctx._outIndices / ctx._outWeights and returns the count.
 *
 * Falloff is a smoothstep bell shaped by `hardness`:
 *   hardness=0  → soft bell (smoothstep)
 *   hardness=1  → near-binary disk
 */
export function queryRadius(ctx, cx, cy, cz, radius, hardness) {
  const grid = ctx.grid
  if (!grid) return 0

  const positions = ctx.geometry.attributes.position.array
  const r2 = radius * radius
  const inv = grid.inv

  const xMin = Math.max(0, Math.floor((cx - radius - grid.minX) * inv))
  const xMax = Math.min(grid.dimX - 1, Math.floor((cx + radius - grid.minX) * inv))
  const yMin = Math.max(0, Math.floor((cy - radius - grid.minY) * inv))
  const yMax = Math.min(grid.dimY - 1, Math.floor((cy + radius - grid.minY) * inv))
  const zMin = Math.max(0, Math.floor((cz - radius - grid.minZ) * inv))
  const zMax = Math.min(grid.dimZ - 1, Math.floor((cz + radius - grid.minZ) * inv))

  const h = Math.max(0, Math.min(1, hardness))
  const stepX = grid.dimX
  const stepZ = grid.dimX * grid.dimY

  let outIndices = ctx._outIndices
  let outWeights = ctx._outWeights
  let count = 0
  let cap = outIndices.length

  for (let z = zMin; z <= zMax; z++) {
    for (let y = yMin; y <= yMax; y++) {
      const rowBase = y * stepX + z * stepZ
      for (let x = xMin; x <= xMax; x++) {
        const cell = x + rowBase
        const start = grid.cellOffsets[cell]
        const end = grid.cellOffsets[cell + 1]
        for (let i = start; i < end; i++) {
          const v = grid.cellEntries[i]
          const dx = positions[v * 3] - cx
          const dy = positions[v * 3 + 1] - cy
          const dz = positions[v * 3 + 2] - cz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 > r2) continue

          // t in [0,1]: 1 at center, 0 at radius.
          const t = 1 - Math.sqrt(d2) / radius
          const smooth = t * t * (3 - 2 * t)
          const pill = h < 0.999 ? Math.min(1, t / Math.max(1e-6, 1 - h)) : (t > 0 ? 1 : 0)
          const w = smooth * (1 - h) + pill * h

          if (count >= cap) {
            cap *= 2
            const newIdx = new Int32Array(cap)
            const newWts = new Float32Array(cap)
            newIdx.set(outIndices)
            newWts.set(outWeights)
            ctx._outIndices = outIndices = newIdx
            ctx._outWeights = outWeights = newWts
          }
          outIndices[count] = v
          outWeights[count] = w
          count += 1
        }
      }
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Brush kernels (zero-alloc, write directly to position.array / normal.array)
// ---------------------------------------------------------------------------

/**
 * Standard brush: push affected vertices along a single (averaged) normal.
 * `displacement` is a unit-radius reference distance; the actual push is
 * `displacement * strength * weight * direction` per vertex.
 */
export function applyStandard(ctx, indices, weights, count, normal, strength, displacement, direction = 1) {
  const positions = ctx.geometry.attributes.position.array
  const dirty = ctx.dirtyMask
  const k = strength * displacement * direction
  const dx = normal.x * k
  const dy = normal.y * k
  const dz = normal.z * k
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i]
    positions[v * 3]     += dx * w
    positions[v * 3 + 1] += dy * w
    positions[v * 3 + 2] += dz * w
    dirty[v] = 1
  }
}

/**
 * Smooth brush: lerp each affected vertex toward the mean of its 1-ring
 * neighbors. Reads the same array it writes — order-dependent in theory,
 * but visually fine for a single stamp because per-vertex strength is tiny.
 */
export function applySmooth(ctx, indices, weights, count, strength) {
  const positions = ctx.geometry.attributes.position.array
  const offsets = ctx.vertexNeighborOffsets
  const neighbors = ctx.vertexNeighbors
  const dirty = ctx.dirtyMask
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i] * strength
    if (w <= 0) continue
    const start = offsets[v]
    const end = offsets[v + 1]
    const n = end - start
    if (n === 0) continue
    let sx = 0, sy = 0, sz = 0
    for (let j = start; j < end; j++) {
      const nb = neighbors[j]
      sx += positions[nb * 3]
      sy += positions[nb * 3 + 1]
      sz += positions[nb * 3 + 2]
    }
    const invN = 1 / n
    const tx = sx * invN
    const ty = sy * invN
    const tz = sz * invN
    const px = positions[v * 3]
    const py = positions[v * 3 + 1]
    const pz = positions[v * 3 + 2]
    positions[v * 3]     = px + (tx - px) * w
    positions[v * 3 + 1] = py + (ty - py) * w
    positions[v * 3 + 2] = pz + (tz - pz) * w
    dirty[v] = 1
  }
}

/**
 * Inflate brush: push each affected vertex along its own (current) normal.
 */
export function applyInflate(ctx, indices, weights, count, strength, displacement, direction = 1) {
  const positions = ctx.geometry.attributes.position.array
  const normals = ctx.geometry.attributes.normal.array
  const dirty = ctx.dirtyMask
  const k = strength * displacement * direction
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i] * k
    positions[v * 3]     += normals[v * 3]     * w
    positions[v * 3 + 1] += normals[v * 3 + 1] * w
    positions[v * 3 + 2] += normals[v * 3 + 2] * w
    dirty[v] = 1
  }
}

/**
 * Flatten brush: pull (or push, with `direction = -1`) vertices toward a
 * plane defined by `(planeOriginX/Y/Z, normalX/Y/Z)`. The plane is normally
 * built from the brush hit point and the average surface normal there.
 */
export function applyFlatten(ctx, indices, weights, count,
  planeOriginX, planeOriginY, planeOriginZ,
  normalX, normalY, normalZ,
  strength, direction = 1) {
  const positions = ctx.geometry.attributes.position.array
  const dirty = ctx.dirtyMask
  const sign = direction >= 0 ? 1 : -1
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i] * strength
    if (w <= 0) continue
    const dx = positions[v * 3]     - planeOriginX
    const dy = positions[v * 3 + 1] - planeOriginY
    const dz = positions[v * 3 + 2] - planeOriginZ
    // Signed distance from plane along the brush normal.
    const d = dx * normalX + dy * normalY + dz * normalZ
    // Pull to plane on +direction; push away on -direction.
    const k = -d * w * sign
    positions[v * 3]     += normalX * k
    positions[v * 3 + 1] += normalY * k
    positions[v * 3 + 2] += normalZ * k
    dirty[v] = 1
  }
}

/**
 * Clay brush: behaves like Standard but capped against a target offset
 * plane. Vertices that have already passed that plane stop moving — that's
 * what creates the "stripe of clay" feel as the brush is dragged across
 * the surface.
 */
export function applyClay(ctx, indices, weights, count,
  planeOriginX, planeOriginY, planeOriginZ,
  normalX, normalY, normalZ,
  strength, displacement, direction = 1) {
  const positions = ctx.geometry.attributes.position.array
  const dirty = ctx.dirtyMask
  const sign = direction >= 0 ? 1 : -1
  // Target plane is offset from the brush plane along the brush normal.
  const targetOffset = sign * displacement * 0.6
  const stepSize = strength * displacement * sign
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i]
    if (w <= 0) continue
    const dx = positions[v * 3]     - planeOriginX
    const dy = positions[v * 3 + 1] - planeOriginY
    const dz = positions[v * 3 + 2] - planeOriginZ
    const current = dx * normalX + dy * normalY + dz * normalZ
    const remaining = targetOffset - current
    if (remaining * sign <= 0) continue // already at/past target
    let step = stepSize * w
    // Don't overshoot the target offset.
    if (sign > 0) {
      if (step > remaining) step = remaining
    } else {
      if (step < remaining) step = remaining
    }
    positions[v * 3]     += normalX * step
    positions[v * 3 + 1] += normalY * step
    positions[v * 3 + 2] += normalZ * step
    dirty[v] = 1
  }
}

/**
 * Pinch brush: pull each affected vertex toward the brush center along the
 * tangent plane of the brush normal (so the surface compresses laterally
 * without ballooning along the normal). With `direction = -1` it acts as a
 * magnify brush, pushing vertices radially outward.
 */
export function applyPinch(ctx, indices, weights, count,
  centerX, centerY, centerZ,
  normalX, normalY, normalZ,
  strength, direction = 1) {
  const positions = ctx.geometry.attributes.position.array
  const dirty = ctx.dirtyMask
  const sign = direction >= 0 ? 1 : -1
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i] * strength * sign
    if (w === 0) continue
    let vx = centerX - positions[v * 3]
    let vy = centerY - positions[v * 3 + 1]
    let vz = centerZ - positions[v * 3 + 2]
    const nDot = vx * normalX + vy * normalY + vz * normalZ
    vx -= nDot * normalX
    vy -= nDot * normalY
    vz -= nDot * normalZ
    positions[v * 3]     += vx * w
    positions[v * 3 + 1] += vy * w
    positions[v * 3 + 2] += vz * w
    dirty[v] = 1
  }
}

/**
 * Grab brush kernel: translate the captured vertices by a precomputed
 * world-space delta. Unlike the other brushes, Grab is NOT applied per
 * stamp — `MeshEditorPage` captures the affected indices/weights once on
 * pointerdown and feeds incremental deltas on pointermove.
 */
export function applyGrab(ctx, indices, weights, count,
  deltaX, deltaY, deltaZ, strength) {
  const positions = ctx.geometry.attributes.position.array
  const dirty = ctx.dirtyMask
  const dx = deltaX * strength
  const dy = deltaY * strength
  const dz = deltaZ * strength
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const w = weights[i]
    positions[v * 3]     += dx * w
    positions[v * 3 + 1] += dy * w
    positions[v * 3 + 2] += dz * w
    dirty[v] = 1
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Compact-in-place filter that keeps only vertices facing the camera.
 * `cameraX/Y/Z` are the camera world-space coordinates (since the mesh is
 * rendered with an identity transform, world == object). A vertex is
 * "front-facing" when its outward normal points toward the camera, i.e.
 * `dot(normal, vertex - camera) < 0`.
 *
 * Mutates `indices` and `weights` and returns the new compacted count.
 */
export function filterFrontFacing(ctx, indices, weights, count,
  cameraX, cameraY, cameraZ) {
  const positions = ctx.geometry.attributes.position.array
  const normals = ctx.geometry.attributes.normal.array
  let writeIdx = 0
  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const vx = positions[v * 3]     - cameraX
    const vy = positions[v * 3 + 1] - cameraY
    const vz = positions[v * 3 + 2] - cameraZ
    const dot = normals[v * 3] * vx + normals[v * 3 + 1] * vy + normals[v * 3 + 2] * vz
    if (dot < 0) {
      indices[writeIdx] = v
      weights[writeIdx] = weights[i]
      writeIdx += 1
    }
  }
  return writeIdx
}

// ---------------------------------------------------------------------------
// Textured-falloff brush stamp
// ---------------------------------------------------------------------------

/**
 * Modulate the per-vertex weights in place by sampling an alpha map across
 * the tangent plane of the brush. Vertices that fall outside the unit-square
 * footprint of the brush are zero-weighted so the brush stamp is bounded by
 * the image (not by the spherical query radius).
 *
 * The tangent basis is derived deterministically from the brush normal:
 *   tangent   = normalize(cross(reference, normal))
 *   bitangent = cross(normal, tangent)
 * with `reference` chosen to avoid degeneracy when the normal is near (0,1,0).
 *
 * `rotationRad` rotates the (tangent, bitangent) basis in-plane so the user
 * can spin the stamp.
 *
 * `alphaMap` is a `Uint8Array` of size `texW * texH` containing premultiplied
 * brush opacity (0..255). Bilinear sampling is used. Out-of-bounds samples
 * receive weight 0.
 *
 * NOTE on a future GPGPU path: this exact projection (tangent basis + alpha
 * sample) maps directly onto a fragment shader; the only piece that changes
 * is the data source (DataTexture instead of Float32Array). Kept as a pure
 * function over typed arrays to make that port mechanical.
 */
export function applyBrushTextureWeights(ctx, indices, weights, count,
  centerX, centerY, centerZ,
  normalX, normalY, normalZ,
  radius, alphaMap, texW, texH, rotationRad = 0) {
  if (!alphaMap || texW <= 0 || texH <= 0 || radius <= 0) return count
  const positions = ctx.geometry.attributes.position.array

  // Pick a reference vector that's not (near) parallel to the normal.
  let refX = 0, refY = 1, refZ = 0
  if (Math.abs(normalY) > 0.9) { refX = 1; refY = 0; refZ = 0 }

  // tangent = normalize(cross(ref, normal))
  let tx = refY * normalZ - refZ * normalY
  let ty = refZ * normalX - refX * normalZ
  let tz = refX * normalY - refY * normalX
  const lenT = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
  tx /= lenT; ty /= lenT; tz /= lenT

  // bitangent = cross(normal, tangent)
  const bx = normalY * tz - normalZ * ty
  const by = normalZ * tx - normalX * tz
  const bz = normalX * ty - normalY * tx

  // Rotate (tangent, bitangent) in-plane.
  const cosR = Math.cos(rotationRad)
  const sinR = Math.sin(rotationRad)
  const tx2 = tx * cosR + bx * sinR
  const ty2 = ty * cosR + by * sinR
  const tz2 = tz * cosR + bz * sinR
  const bx2 = -tx * sinR + bx * cosR
  const by2 = -ty * sinR + by * cosR
  const bz2 = -tz * sinR + bz * cosR

  const invR = 1 / radius
  const wMax = texW - 1
  const hMax = texH - 1

  for (let i = 0; i < count; i++) {
    const v = indices[i]
    const dx = positions[v * 3]     - centerX
    const dy = positions[v * 3 + 1] - centerY
    const dz = positions[v * 3 + 2] - centerZ
    const u = (dx * tx2 + dy * ty2 + dz * tz2) * invR // -1..1
    const s = (dx * bx2 + dy * by2 + dz * bz2) * invR // -1..1

    // Map -1..1 to 0..1 brush UV; bail out if outside the brush footprint.
    const tu = u * 0.5 + 0.5
    const tv = s * 0.5 + 0.5
    if (tu < 0 || tu > 1 || tv < 0 || tv > 1) {
      weights[i] = 0
      continue
    }

    // Bilinear alpha sample. Texture origin is top-left so flip V.
    const fx = tu * wMax
    const fy = (1 - tv) * hMax
    const x0 = fx | 0
    const y0 = fy | 0
    const x1 = x0 < wMax ? x0 + 1 : x0
    const y1 = y0 < hMax ? y0 + 1 : y0
    const ax = fx - x0
    const ay = fy - y0
    const a00 = alphaMap[y0 * texW + x0]
    const a10 = alphaMap[y0 * texW + x1]
    const a01 = alphaMap[y1 * texW + x0]
    const a11 = alphaMap[y1 * texW + x1]
    const aTop = a00 + (a10 - a00) * ax
    const aBot = a01 + (a11 - a01) * ax
    const alpha = (aTop + (aBot - aTop) * ay) / 255

    weights[i] = weights[i] * alpha
  }
  return count
}

// ---------------------------------------------------------------------------
// Symmetry
// ---------------------------------------------------------------------------

/**
 * Enumerate the 1/2/4/8 axis-mirror combinations selected by the symmetry
 * toggles. Returns an array of `[sx, sy, sz]` flip tuples (each ±1). The
 * first entry is always the identity `[1, 1, 1]`. Mirror is across the
 * world origin planes (the editor renders meshes at identity, so this is
 * also the object-space origin).
 */
export function getSymmetryMirrors(symmetry) {
  const axes = []
  if (symmetry?.x) axes.push(0)
  if (symmetry?.y) axes.push(1)
  if (symmetry?.z) axes.push(2)
  const n = axes.length
  if (n === 0) return [[1, 1, 1]]
  const out = new Array(1 << n)
  for (let i = 0; i < (1 << n); i++) {
    const flip = [1, 1, 1]
    for (let b = 0; b < n; b++) {
      if (i & (1 << b)) flip[axes[b]] = -1
    }
    out[i] = flip
  }
  return out
}

// ---------------------------------------------------------------------------
// Normal recompute
// ---------------------------------------------------------------------------

/**
 * Incremental normal recompute: only touches vertices that share a triangle
 * with any vertex in the dirty mask. Cheap during a stroke; we still call
 * the full recompute on stroke end for safety.
 */
export function incrementalRecomputeNormals(ctx) {
  const positions = ctx.geometry.attributes.position.array
  const normals = ctx.geometry.attributes.normal.array
  const indices = ctx.indices
  const triOffsets = ctx.vertexTriOffsets
  const tris = ctx.vertexTris
  const dirty = ctx.dirtyMask
  const vertexCount = ctx.vertexCount

  // Mark all vertices belonging to any dirty triangle as needing recompute.
  // Reuse a transient Uint8Array stored on ctx for this pass.
  if (!ctx._recomputeMask || ctx._recomputeMask.length !== vertexCount) {
    ctx._recomputeMask = new Uint8Array(vertexCount)
  }
  const recompute = ctx._recomputeMask
  recompute.fill(0)

  for (let v = 0; v < vertexCount; v++) {
    if (!dirty[v]) continue
    const start = triOffsets[v]
    const end = triOffsets[v + 1]
    for (let i = start; i < end; i++) {
      const t = tris[i]
      recompute[indices[t * 3]] = 1
      recompute[indices[t * 3 + 1]] = 1
      recompute[indices[t * 3 + 2]] = 1
    }
  }

  for (let v = 0; v < vertexCount; v++) {
    if (!recompute[v]) continue
    let nx = 0, ny = 0, nz = 0
    const start = triOffsets[v]
    const end = triOffsets[v + 1]
    for (let i = start; i < end; i++) {
      const t = tris[i]
      const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2]
      const ax = positions[ia * 3],     ay = positions[ia * 3 + 1],     az = positions[ia * 3 + 2]
      const bx = positions[ib * 3],     by = positions[ib * 3 + 1],     bz = positions[ib * 3 + 2]
      const cx = positions[ic * 3],     cy = positions[ic * 3 + 1],     cz = positions[ic * 3 + 2]
      const ex = bx - ax, ey = by - ay, ez = bz - az
      const fx = cx - ax, fy = cy - ay, fz = cz - az
      nx += ey * fz - ez * fy
      ny += ez * fx - ex * fz
      nz += ex * fy - ey * fx
    }
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    normals[v * 3]     = nx / len
    normals[v * 3 + 1] = ny / len
    normals[v * 3 + 2] = nz / len
  }
}

export function clearDirtyMask(ctx) {
  ctx.dirtyMask.fill(0)
}

// ---------------------------------------------------------------------------
// Stroke lifecycle helpers
// ---------------------------------------------------------------------------

/** Mark only the dirty position range as needing GPU upload (Three.js r152+). */
export function markPositionRangeDirty(ctx) {
  const attr = ctx.geometry.attributes.position
  // No range-tracking yet; just mark the whole attribute. (Future: track
  // min/max touched index per stamp and call attr.addUpdateRange.)
  attr.needsUpdate = true
  ctx.geometry.attributes.normal.needsUpdate = true
}

/**
 * Finalize a stroke: full normal recompute, bounding sphere recompute, and
 * BVH refit. Topology is unchanged so refit is O(n) and avoids a full
 * rebuild. If the geometry has no boundsTree yet we leave it alone — the
 * caller can compute one on demand.
 */
export function finalizeStroke(ctx) {
  const geometry = ctx.geometry
  geometry.attributes.position.needsUpdate = true
  geometry.attributes.normal.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox?.()
  if (geometry.boundsTree?.refit) {
    try {
      geometry.boundsTree.refit()
    } catch {
      // Topology unchanged so refit should always succeed; if it doesn't,
      // fall back to a full rebuild.
      geometry.computeBoundsTree?.()
    }
  }
  clearDirtyMask(ctx)
}

export function snapshotPositions(geometry) {
  return new Float32Array(geometry.attributes.position.array)
}

export function restorePositions(geometry, snapshot) {
  geometry.attributes.position.array.set(snapshot)
  geometry.attributes.position.needsUpdate = true
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox?.()
  if (geometry.boundsTree?.refit) {
    try { geometry.boundsTree.refit() } catch { geometry.computeBoundsTree?.() }
  }
}

// ---------------------------------------------------------------------------
// Raycast helper using the geometry's BVH (already installed by meshEditor.js)
// ---------------------------------------------------------------------------

const _ray = new THREE.Raycaster()

/**
 * Raycast `mesh` from a screen-space pointer (in canvas-local pixels).
 * Returns { point, normal, faceIndex, distance } or null.
 *
 * The mesh's geometry must have a `boundsTree` (computed once, refit per
 * stroke) for accelerated raycasting.
 */
export function raycastMesh(mesh, camera, pointerX, pointerY, canvasWidth, canvasHeight) {
  if (!mesh || !camera || canvasWidth <= 0 || canvasHeight <= 0) return null
  _ray.firstHitOnly = true
  const ndcX = (pointerX / canvasWidth) * 2 - 1
  const ndcY = -((pointerY / canvasHeight) * 2 - 1)
  _ray.setFromCamera({ x: ndcX, y: ndcY }, camera)
  mesh.updateMatrixWorld?.(true)
  const hits = _ray.intersectObject(mesh, false)
  if (!hits.length) return null
  const hit = hits[0]

  // Ensure we return a face normal in object-space (geometry is what we
  // sculpt). If face is missing, fall back to the hit's `face.normal`.
  const normal = hit.face?.normal?.clone() || new THREE.Vector3(0, 1, 0)
  // hit.point is world-space; translate back to object-space.
  const localPoint = hit.point.clone()
  mesh.worldToLocal(localPoint)
  return {
    point: localPoint,
    normal,
    faceIndex: hit.faceIndex,
    distance: hit.distance,
    worldPoint: hit.point.clone()
  }
}
