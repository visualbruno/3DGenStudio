// Skin-weight transfer: making fitted armour move with the body that wears it.
//
// The last step of the assembly pipeline. A piece that has been fitted still
// knows nothing about the skeleton underneath it, so animating the merged
// character would leave the armour standing still while the body walks out of
// it. This samples the base's skinning at each fitted vertex and writes it onto
// the piece.
//
// ---- Why this is client-side ------------------------------------------------
//
// trimesh cannot read or write glTF skinning at all -- 2,259 lines of
// trimesh/exchange/gltf with zero occurrences of skin, joint, JOINTS_0 or
// WEIGHTS_0. The codebase already knows this twice over: the FBX convert
// endpoint exists because trimesh "flattens skinned meshes", and the rigging
// service runs a bpy subprocess in its own venv for the same reason. So a rig
// sent to python-server is silently destroyed, and every rig operation stays
// here. The browser already has the skeleton parsed by GLTFLoader and a BVH
// from three-mesh-bvh, which is everything the transfer needs.
//
// ---- Why at SAVE time, not at fit time --------------------------------------
//
// Weights are a function of the FINAL vertex positions, and "final" is not
// known until the user stops working: a fit, then possibly several brush
// strokes. Computing them earlier means recomputing after every stroke, or
// shipping weights that describe a shape the piece no longer has.
//
// It also sidesteps persistence entirely. Working geometry stores positions
// only (see assemblyWorking.js), so weights computed at fit time would be
// silently dropped on the next page load and the piece would export unrigged
// with no indication why.
import * as THREE from 'three'
import { composePieceMatrix } from './assemblyGeometry'

// glTF's limit, and the default every engine expects. More influences per
// vertex is not more accurate here — the extras are always the small ones.
export const MAX_INFLUENCES = 4


/**
 * The base's skinned surface, in world space, ready to sample.
 *
 * One merged geometry rather than a query per submesh: a body arrives as head +
 * body + eyes often enough, and picking the nearest point across several BVHs
 * means comparing distances by hand for no gain.
 *
 * Returns null when the base carries no skinning, which is the ordinary case
 * for an unrigged body and must not be an error.
 */
export function buildBaseSkinSampler(baseEntry, basePiece) {
  if (!baseEntry?.meshes?.length) return null

  const placement = composePieceMatrix(basePiece, new THREE.Matrix4())
  const positions = []
  const indices = []
  const skinIndex = []
  const skinWeight = []
  let vertexBase = 0

  baseEntry.root.updateMatrixWorld(true)

  for (const mesh of baseEntry.meshes) {
    const geometry = mesh.geometry
    const position = geometry?.getAttribute('position')
    const joints = geometry?.getAttribute('skinIndex')
    const weights = geometry?.getAttribute('skinWeight')
    // A submesh with no skinning contributes nothing to sample FROM. Including
    // it would hand nearby piece vertices an all-zero weight set, which reads
    // as "bound to bone 0" and pins that part of the armour to the root.
    if (!position || !joints || !weights) continue

    // World = placement x (this mesh's transform relative to the piece root).
    // Derived through the root's inverse rather than read from matrixWorld,
    // which already contains the placement — the same trap documented at
    // length in buildFitPayloadGeometry.
    mesh.updateMatrixWorld(true)
    const meshToRoot = new THREE.Matrix4()
      .copy(baseEntry.root.matrixWorld).invert()
      .multiply(mesh.matrixWorld)
    const toWorld = placement.clone().multiply(meshToRoot)

    const point = new THREE.Vector3()
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(toWorld)
      positions.push(point.x, point.y, point.z)
      skinIndex.push(joints.getX(i), joints.getY(i), joints.getZ(i), joints.getW(i))
      skinWeight.push(weights.getX(i), weights.getY(i), weights.getZ(i), weights.getW(i))
    }

    const index = geometry.getIndex()
    if (index) {
      for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + vertexBase)
    } else {
      for (let i = 0; i < position.count; i += 1) indices.push(i + vertexBase)
    }
    vertexBase += position.count
  }

  if (!indices.length) return null

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeBoundsTree?.()

  return {
    geometry,
    skinIndex: new Uint16Array(skinIndex),
    skinWeight: new Float32Array(skinWeight),
    dispose() {
      geometry.disposeBoundsTree?.()
      geometry.dispose()
    },
  }
}


/** Vertex adjacency as CSR, for smoothing. */
function buildAdjacency(geometry) {
  const index = geometry.getIndex()
  const count = geometry.getAttribute('position').count
  const degree = new Uint32Array(count)
  const get = index ? i => index.getX(i) : i => i
  const total = index ? index.count : count

  for (let i = 0; i < total; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      degree[get(i + k)] += 2
    }
  }
  const offsets = new Uint32Array(count + 1)
  for (let i = 0; i < count; i += 1) offsets[i + 1] = offsets[i] + degree[i]

  const cursor = offsets.slice(0, count)
  const neighbours = new Uint32Array(offsets[count])
  for (let i = 0; i < total; i += 3) {
    const a = get(i)
    const b = get(i + 1)
    const c = get(i + 2)
    neighbours[cursor[a]++] = b; neighbours[cursor[a]++] = c
    neighbours[cursor[b]++] = c; neighbours[cursor[b]++] = a
    neighbours[cursor[c]++] = a; neighbours[cursor[c]++] = b
  }
  return { offsets, neighbours }
}


/** Keep the strongest `limit` influences and renormalise to sum 1. */
function compress(map, limit) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  let total = 0
  for (const [, weight] of entries) total += weight
  if (total <= 1e-12) return [[0, 1], [0, 0], [0, 0], [0, 0]].slice(0, limit)
  return entries.map(([bone, weight]) => [bone, weight / total])
}


/**
 * Sample the base's skinning at each of `targetPositions` and write it onto
 * `targetGeometry`.
 *
 * `targetPositions` is the geometry's vertices in WORLD space — the same space
 * the sampler is in. They are passed separately because a piece version is
 * saved in its own local space while the weights must still be sampled where
 * the piece actually sits on the body.
 */
export function transferSkinFromBase(sampler, targetGeometry, targetPositions, {
  maxInfluences = MAX_INFLUENCES,
  smoothIters = 2,
  maxDistance = null,
} = {}) {
  if (!sampler || !targetGeometry) return null

  const count = targetGeometry.getAttribute('position').count
  const baseIndex = sampler.geometry.getIndex()
  const raycaster = new THREE.Vector3()
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 }

  const outIndex = new Uint16Array(count * 4)
  const outWeight = new Float32Array(count * 4)

  const triangle = new THREE.Triangle()
  const bary = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const basePosition = sampler.geometry.getAttribute('position')

  let missed = 0
  let farthest = 0

  for (let v = 0; v < count; v += 1) {
    raycaster.set(targetPositions[v * 3], targetPositions[v * 3 + 1], targetPositions[v * 3 + 2])
    hit.faceIndex = -1
    sampler.geometry.boundsTree.closestPointToPoint(raycaster, hit)
    if (hit.faceIndex < 0) { missed += 1; continue }
    farthest = Math.max(farthest, hit.distance)

    const i0 = baseIndex.getX(hit.faceIndex * 3)
    const i1 = baseIndex.getX(hit.faceIndex * 3 + 1)
    const i2 = baseIndex.getX(hit.faceIndex * 3 + 2)
    a.fromBufferAttribute(basePosition, i0)
    b.fromBufferAttribute(basePosition, i1)
    c.fromBufferAttribute(basePosition, i2)

    // Barycentric, not nearest-vertex. Nearest-vertex quantises the result to
    // the BODY's resolution, so a denser piece gets visible banding wherever
    // two bones meet — a stair-step across the shoulder instead of a blend.
    triangle.set(a, b, c)
    triangle.getBarycoord(hit.point, bary)
    if (!Number.isFinite(bary.x) || !Number.isFinite(bary.y) || !Number.isFinite(bary.z)) {
      bary.set(1, 0, 0)          // degenerate triangle: fall back to one corner
    }

    const blended = new Map()
    const corners = [i0, i1, i2]
    const shares = [bary.x, bary.y, bary.z]
    for (let k = 0; k < 3; k += 1) {
      const share = shares[k]
      if (share <= 0) continue
      const base = corners[k] * 4
      for (let s = 0; s < 4; s += 1) {
        const weight = sampler.skinWeight[base + s] * share
        if (weight <= 0) continue
        const bone = sampler.skinIndex[base + s]
        blended.set(bone, (blended.get(bone) || 0) + weight)
      }
    }

    const kept = compress(blended, maxInfluences)
    for (let s = 0; s < kept.length; s += 1) {
      outIndex[v * 4 + s] = kept[s][0]
      outWeight[v * 4 + s] = kept[s][1]
    }
  }

  const stats = { vertices: count, missed, farthest, smoothed: 0 }

  if (smoothIters > 0) {
    smoothWeights(targetGeometry, outIndex, outWeight, smoothIters, maxInfluences)
    stats.smoothed = smoothIters
  }

  targetGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(outIndex, 4))
  targetGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(outWeight, 4))

  if (maxDistance && farthest > maxDistance) stats.suspicious = true
  return stats
}


/**
 * Average each vertex's weights with its neighbours', in place.
 *
 * A piece that spans two body regions picks up a hard line where the nearest
 * body point flips from one to the other — across a shoulder, or where a tasset
 * hangs between hip and thigh. The body itself has no such line because its own
 * weights were painted smooth; the transfer reintroduces it by sampling
 * pointwise. A couple of rounds over the piece's own topology removes it.
 */
function smoothWeights(geometry, outIndex, outWeight, rounds, maxInfluences) {
  const { offsets, neighbours } = buildAdjacency(geometry)
  const count = geometry.getAttribute('position').count

  for (let round = 0; round < rounds; round += 1) {
    const nextIndex = new Uint16Array(outIndex.length)
    const nextWeight = new Float32Array(outWeight.length)

    for (let v = 0; v < count; v += 1) {
      const blended = new Map()
      // The vertex counts as much as all its neighbours together, so smoothing
      // softens the seam without washing the piece toward one average bone.
      const add = (slot, scale) => {
        for (let s = 0; s < 4; s += 1) {
          const weight = outWeight[slot * 4 + s] * scale
          if (weight <= 0) continue
          const bone = outIndex[slot * 4 + s]
          blended.set(bone, (blended.get(bone) || 0) + weight)
        }
      }
      add(v, 1)
      const start = offsets[v]
      const end = offsets[v + 1]
      if (end > start) {
        const share = 1 / (end - start)
        for (let n = start; n < end; n += 1) add(neighbours[n], share)
      }

      const kept = compress(blended, maxInfluences)
      for (let s = 0; s < kept.length; s += 1) {
        nextIndex[v * 4 + s] = kept[s][0]
        nextWeight[v * 4 + s] = kept[s][1]
      }
    }
    outIndex.set(nextIndex)
    outWeight.set(nextWeight)
  }
}


/**
 * Does this geometry carry skinning every engine will accept?
 *
 * The gate in front of the skinned merged export. A piece missing weights, or
 * referencing a bone the shared skeleton does not have, produces a GLB that
 * loads and then animates into knots — the silent partial rig meshRig.js warns
 * about. Better to fall back to a static export and say which piece failed.
 */
export function validateSkin(geometry, boneCount) {
  const joints = geometry?.getAttribute('skinIndex')
  const weights = geometry?.getAttribute('skinWeight')
  if (!joints || !weights) return 'has no skin weights'
  if (joints.count !== geometry.getAttribute('position').count) {
    return 'has skin weights for the wrong number of vertices'
  }

  let worstSum = 0
  for (let i = 0; i < joints.count; i += 1) {
    let sum = 0
    for (let s = 0; s < 4; s += 1) {
      const bone = joints.getComponent(i, s)
      if (bone < 0 || bone >= boneCount) {
        return `references bone ${bone}, but the skeleton has ${boneCount}`
      }
      sum += weights.getComponent(i, s)
    }
    worstSum = Math.max(worstSum, Math.abs(sum - 1))
  }
  // Unnormalised weights are not fatal in every engine, but they are always a
  // bug here — the transfer normalises, so a drift means something else wrote.
  if (worstSum > 0.01) return `has weights summing to ${(1 + worstSum).toFixed(3)}`
  return null
}
