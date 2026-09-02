// Weight painting: the brush kernels behind Auto Rig's "Weight Painting" mode.
//
// Companion to utils/meshSculpt.js, and deliberately shaped like it: the caller
// owns the sculpt context (spatial grid, CSR adjacency, scratch buffers) and
// hands us the `(indices, falloff, count)` triple `queryRadius` produced, so a
// stroke allocates nothing per dab. Where sculpting moves `position`, this moves
// `skinWeight` / `skinIndex`.
//
// ── One bone, addressed by SKELETON index ──────────────────────────────────
// Everything here takes a plain `boneSkel` number — the bone's position in
// `skeleton.bones`, which is what the `skinIndex` attribute stores. It knows
// nothing about the rig object or the overlay ordering the UI uses; mapping
// between those is the caller's job (see the three-index-spaces note at the top
// of utils/meshRigEdit.js). Passing an overlay index here corrupts weights
// silently on any rig where the two orders differ.
//
// ── Why weights are mutated in place ───────────────────────────────────────
// The rest of the rig-editing code clones the geometry and hands back a new one,
// which is right for a one-shot operation but far too slow at brush cadence — a
// dab would copy every attribute in the mesh. Here the typed arrays are written
// directly; the stroke's undo entry is the snapshot `pushRigSnapshot` took
// before the first dab. The attribute *types* are preserved for free that way
// too, which matters: glTF requires JOINTS_0 to be an integer accessor, so
// `skinIndex` must stay Uint16 (see createIndexedGeometry in meshEditor.js).

import { ensureWeldedTopology } from './meshSculpt'

const EPSILON = 1e-5

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Per-vertex weight of one bone, for the heatmap.
//
// A vertex the bone does not move reads back as -1, not 0. glTF has no way to
// say "influences this vertex by exactly zero" — a slot whose weight is 0 is an
// unused slot, and its joint index is leftover data — so absence is the only
// meaning zero can carry. Keeping it out of the 0…1 range lets the ramp reserve
// its blue end for a weight that is small but real, which is the distinction
// that actually matters while painting: barely moved, versus not moved at all.
export function readBoneWeights(geometry, boneSkel, out = null) {
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  const count = geometry?.attributes?.position?.count || 0
  const result = out && out.length >= count ? out : new Float32Array(count)
  if (!skinIndex || !skinWeight) {
    result.fill(-1, 0, count)
    return result
  }

  const indices = skinIndex.array
  const values = skinWeight.array
  for (let v = 0; v < count; v += 1) {
    let weight = -1
    for (let k = 0; k < 4; k += 1) {
      if (indices[v * 4 + k] === boneSkel && values[v * 4 + k] > 0) {
        weight = values[v * 4 + k]
        break
      }
    }
    result[v] = weight
  }
  return result
}

// The share of a vertex the bone already holds, 0 when it holds none.
function currentWeight(indices, values, v, boneSkel) {
  for (let k = 0; k < 4; k += 1) {
    if (indices[v * 4 + k] === boneSkel && values[v * 4 + k] > 0) return values[v * 4 + k]
  }
  return 0
}

// ---------------------------------------------------------------------------
// Writing one vertex
// ---------------------------------------------------------------------------

// Give vertex `v` exactly `target` weight for `boneSkel`, and keep the vertex
// valid. Returns true when anything changed.
//
// The two rules that make this more than an array write:
//
//   * glTF gives a vertex four influences and no more. Painting a fifth bone
//     onto a full vertex has to displace one — an empty slot if there is one,
//     else the weakest, and only when that is weaker than what we are adding.
//     Trading a stronger influence away would do more harm than the new bone
//     does good. (Same rule as takeWeightsFromParent.)
//   * With `normalize`, the other influences are rescaled to fill 1 - target,
//     so the painted value is the one that survives exactly. Scaling everything
//     uniformly instead would leave the brush unable to reach the value it was
//     asked for, which reads as the brush not working.
//
// `fallbackBone` — normally the painted bone's PARENT — is what makes the brush
// work on a vertex this bone owns outright. There, lowering the weight has
// nowhere to put the share it frees: leaving the vertex summing to less than 1
// collapses it toward the origin once skinned, so without somewhere to send it
// the only valid answer is to snap back to 1, and Subtract silently does nothing
// on exactly the areas most likely to need it (a solid red region). Handing it
// up the chain is both valid and what a rigger would have done by hand.
export function writeVertexBoneWeight(indices, values, v, boneSkel, rawTarget, normalize = true, fallbackBone = -1) {
  const base = v * 4
  const target = rawTarget < 0 ? 0 : (rawTarget > 1 ? 1 : rawTarget)

  let slot = -1
  for (let k = 0; k < 4; k += 1) {
    if (indices[base + k] === boneSkel && values[base + k] > 0) { slot = k; break }
  }

  if (slot < 0) {
    // Nothing to remove, and nothing worth claiming a slot for.
    if (target <= EPSILON) return false

    let empty = -1
    let victim = -1
    let smallest = Infinity
    for (let k = 0; k < 4; k += 1) {
      const w = values[base + k]
      if (w <= EPSILON) { empty = k; break }
      if (w < smallest) { smallest = w; victim = k }
    }
    if (empty >= 0) slot = empty
    else if (victim >= 0 && smallest < target) slot = victim
    else return false
  } else if (Math.abs(values[base + slot] - target) <= EPSILON) {
    return false
  }

  indices[base + slot] = boneSkel
  values[base + slot] = target

  if (normalize) {
    let others = 0
    for (let k = 0; k < 4; k += 1) {
      if (k !== slot) others += values[base + k]
    }
    const rest = 1 - target
    if (others > EPSILON) {
      const scale = rest / others
      for (let k = 0; k < 4; k += 1) {
        if (k !== slot) values[base + k] *= scale
      }
    } else {
      // This bone owns the vertex outright. `others` being zero means at least
      // one slot is free, so the share can go to the fallback if there is one.
      let free = -1
      if (rest > EPSILON && fallbackBone >= 0 && fallbackBone !== boneSkel) {
        for (let k = 0; k < 4; k += 1) {
          if (k !== slot && values[base + k] <= EPSILON) { free = k; break }
        }
      }
      if (free >= 0) {
        indices[base + free] = fallbackBone
        values[base + free] = rest
      } else {
        // Nowhere for the freed weight to go — a root bone has no parent — so
        // the bone keeps the vertex rather than leaving it under-weighted.
        values[base + slot] = 1
      }
    }
  }

  // A slot that has been painted away is free for the next bone.
  for (let k = 0; k < 4; k += 1) {
    if (values[base + k] < EPSILON) values[base + k] = 0
  }
  return true
}

// Rescale a vertex's four influences back to a total of 1. Used by Clear, where
// removing a bone leaves the vertex short and there is no painted value to
// protect — whatever else was holding the vertex simply takes over the share.
function renormalizeVertex(values, v) {
  const base = v * 4
  let sum = 0
  for (let k = 0; k < 4; k += 1) sum += values[base + k]
  if (sum <= EPSILON || Math.abs(sum - 1) < EPSILON) return
  for (let k = 0; k < 4; k += 1) values[base + k] /= sum
}

// ---------------------------------------------------------------------------
// The brush
// ---------------------------------------------------------------------------

// Average of the bone's weight over a vertex's one-ring, for Blur. Vertices the
// bone does not reach count as 0 rather than being skipped — otherwise blurring
// the edge of an influence would drag it outwards instead of softening it.
//
// The ring is taken over the POSITION-welded surface (see ensureWeldedTopology)
// rather than over the index buffer. `mergeVertices` splits a vertex in two
// wherever a UV or hard-normal seam crosses it, so index adjacency stops at
// every seam: blurring across one would average each side against itself only
// and leave the seam standing as a hard line in the weights — the artefact that
// looks like the brush skipping a strip of the mesh.
function neighborAverage(ctx, topo, indices, values, v, boneSkel) {
  if (topo) {
    const node = topo.canonicalOf[v]
    const start = topo.neighborOffsets[node]
    const end = topo.neighborOffsets[node + 1]
    if (end > start) {
      let sum = 0
      let counted = 0
      for (let i = start; i < end; i += 1) {
        const w = topo.neighbors[i]
        const memberStart = topo.memberOffsets[w]
        const memberEnd = topo.memberOffsets[w + 1]
        if (memberEnd <= memberStart) continue
        // One neighbouring POSITION contributes once, however many vertices the
        // seam split it into, so a seam does not weight its own side double.
        let local = 0
        for (let m = memberStart; m < memberEnd; m += 1) {
          local += currentWeight(indices, values, topo.members[m], boneSkel)
        }
        sum += local / (memberEnd - memberStart)
        counted += 1
      }
      if (counted > 0) return sum / counted
    }
  }

  const start = ctx.vertexNeighborOffsets[v]
  const end = ctx.vertexNeighborOffsets[v + 1]
  if (end <= start) return currentWeight(indices, values, v, boneSkel)
  let sum = 0
  for (let i = start; i < end; i += 1) {
    sum += currentWeight(indices, values, ctx.vertexNeighbors[i], boneSkel)
  }
  return sum / (end - start)
}

// One brush dab. `brushIndices` / `falloff` / `count` are what queryRadius wrote
// into ctx._outIndices / ctx._outWeights (optionally narrowed by
// filterFrontFacing). Returns how many vertices actually changed.
//
// Blur reads the whole neighbourhood before writing anything: sampling from the
// array it is also editing would let a stroke smear weight along its own
// direction of travel instead of averaging.
export function applyWeightBrush(ctx, brushIndices, falloff, count, boneSkel, options = {}) {
  const geometry = ctx?.geometry
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  if (!skinIndex || !skinWeight || count <= 0) return 0

  const {
    mode = 'add',
    strength = 0.5,
    target = 1,
    normalize = true,
    fallbackBone = -1,
  } = options

  const indices = skinIndex.array
  const values = skinWeight.array

  let averages = null
  if (mode === 'blur') {
    averages = ctx._weightBlurScratch
    if (!averages || averages.length < count) {
      averages = ctx._weightBlurScratch = new Float32Array(Math.max(count, 4096))
    }
    const topo = ensureWeldedTopology(ctx)
    for (let i = 0; i < count; i += 1) {
      averages[i] = neighborAverage(ctx, topo, indices, values, brushIndices[i], boneSkel)
    }
  }

  let changed = 0
  for (let i = 0; i < count; i += 1) {
    const v = brushIndices[i]
    const amount = strength * falloff[i]
    if (amount <= 1e-4) continue

    const current = currentWeight(indices, values, v, boneSkel)
    let next
    if (mode === 'subtract') next = current - amount
    else if (mode === 'set') next = current + (target - current) * amount
    else if (mode === 'blur') next = current + (averages[i] - current) * amount
    else next = current + amount

    if (writeVertexBoneWeight(indices, values, v, boneSkel, next, normalize, fallbackBone)) changed += 1
  }
  return changed
}

// ---------------------------------------------------------------------------
// Whole-mesh operations
// ---------------------------------------------------------------------------

// Fill (value 1) or Clear (value 0) a bone across the entire mesh — the fast way
// to wipe an influence Auto Rig got badly wrong before repainting it.
export function fillBoneWeight(geometry, boneSkel, value, normalize = true, fallbackBone = -1) {
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  const count = geometry?.attributes?.position?.count || 0
  if (!skinIndex || !skinWeight || !count) return 0

  const indices = skinIndex.array
  const values = skinWeight.array
  let changed = 0

  if (value <= EPSILON) {
    for (let v = 0; v < count; v += 1) {
      let touched = false
      for (let k = 0; k < 4; k += 1) {
        if (indices[v * 4 + k] === boneSkel && values[v * 4 + k] > 0) {
          values[v * 4 + k] = 0
          touched = true
        }
      }
      if (!touched) continue
      if (normalize) {
        // Clearing the only bone holding a vertex would leave it weightless, so
        // the fallback inherits it whole — same reasoning as the brush.
        let sum = 0
        for (let k = 0; k < 4; k += 1) sum += values[v * 4 + k]
        if (sum <= EPSILON && fallbackBone >= 0 && fallbackBone !== boneSkel) {
          indices[v * 4] = fallbackBone
          values[v * 4] = 1
        } else {
          renormalizeVertex(values, v)
        }
      }
      changed += 1
    }
    return changed
  }

  for (let v = 0; v < count; v += 1) {
    if (writeVertexBoneWeight(indices, values, v, boneSkel, value, normalize, fallbackBone)) changed += 1
  }
  return changed
}

// ---------------------------------------------------------------------------
// Heatmap colours
// ---------------------------------------------------------------------------

// Blender's weight ramp: blue → cyan → green → yellow → red across 0…1.
//
// A vertex this bone does not move (weight < 0, see readBoneWeights) is drawn
// dark grey instead, so the coloured region is exactly the part of the mesh the
// bone carries — the shape you are actually painting. Blue is then a real but
// tiny weight rather than "no weight", which is the one the two would otherwise
// be confused for.
export function weightRamp(weight, out, offset) {
  if (weight < 0) {
    out[offset] = 0.09
    out[offset + 1] = 0.09
    out[offset + 2] = 0.1
    return
  }

  const w = weight > 1 ? 1 : weight
  let r
  let g
  let b
  if (w < 0.25) {
    const t = w / 0.25
    r = 0; g = t; b = 1
  } else if (w < 0.5) {
    const t = (w - 0.25) / 0.25
    r = 0; g = 1; b = 1 - t
  } else if (w < 0.75) {
    const t = (w - 0.5) / 0.25
    r = t; g = 1; b = 0
  } else {
    const t = (w - 0.75) / 0.25
    r = 1; g = 1 - t; b = 0
  }
  out[offset] = r
  out[offset + 1] = g
  out[offset + 2] = b
}

// Recolour the whole mesh from a per-vertex weight array.
export function writeWeightColors(colorArray, boneWeights) {
  const count = Math.min(boneWeights.length, Math.floor(colorArray.length / 3))
  for (let v = 0; v < count; v += 1) weightRamp(boneWeights[v], colorArray, v * 3)
}

// Recolour only the vertices a dab touched, reading their weights back out of
// the geometry. Keeps a stroke off the O(vertexCount) path.
export function refreshWeightColors(colorArray, boneWeights, geometry, boneSkel, brushIndices, count) {
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  if (!skinIndex || !skinWeight) return
  const indices = skinIndex.array
  const values = skinWeight.array

  for (let i = 0; i < count; i += 1) {
    const v = brushIndices[i]
    let weight = -1
    for (let k = 0; k < 4; k += 1) {
      if (indices[v * 4 + k] === boneSkel && values[v * 4 + k] > 0) {
        weight = values[v * 4 + k]
        break
      }
    }
    boneWeights[v] = weight
    weightRamp(weight, colorArray, v * 3)
  }
}
