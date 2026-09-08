// Transferring a rig from one mesh onto another: skeleton, skin weights and
// animation clips, high-poly → low-poly.
//
// The case this exists for: you have a rigged (and possibly animated) mesh, and
// a second mesh of the same character that has no rig — a retopo, an LOD, a
// hand-modelled game version, or the very same asset after an edit rebuilt its
// topology and dropped the weights (the `rigDropped` warning in the Auto Rig
// panel). Re-running Auto Rig on it costs a GPU and gives a *different*
// skeleton, which throws away every bone correction and bone mapping made
// against the old one. Sampling the old rig instead keeps all of it.
//
// ── Why this is three problems and only one of them is hard ─────────────────
//
//   * the SKELETON is free. The editor keeps the bone graph aside from the
//     geometry (utils/meshRig.js) and binds it with an identity bind matrix, so
//     `buildRiggedObject` does not care which mesh a rig came from — it only
//     needs skinIndex/skinWeight on the geometry it is handed. Taking the source
//     skeleton whole is a pointer copy.
//   * the WEIGHTS are the real work, and they are already written:
//     utils/assemblyWeights.js does closest-point + barycentric sampling with
//     weld-group unification and smoothing, for fitting armour onto a body.
//     High-poly → low-poly is the *easier* direction of the same problem (the
//     two surfaces are near-coincident rather than offset), so this reuses it
//     verbatim rather than growing a second copy.
//   * the ANIMATIONS are free too, as long as the skeleton is taken whole:
//     clips address bones by name, so they keep working with no retargeting.
//     (Retargeting — utils/animationLibrary.js — is for the other case, where
//     the target keeps its own different skeleton.)
//
// ── The one thing that will ruin it ─────────────────────────────────────────
//
// The transfer is purely positional: every target vertex takes the weights of
// the nearest point on the source surface. Nothing guarantees the two meshes
// are in the same space — a library asset arrives in raw file space, and one
// click of the Game-Ready pivot fix separates two versions of the same mesh
// permanently. Sampled across a gap, the result is not "slightly wrong", it is
// every vertex bound to whichever bone happens to face it. So the fit is
// measured first, with the same box comparison the bake tool uses, and a source
// that only needs re-centring is re-centred rather than refused (see
// planRigSourceAlignment).
import * as THREE from 'three'
import { transferSkinFromBase, validateSkin, MAX_INFLUENCES } from './assemblyWeights'
import { measureBakeOverlap, BAKE_OVERLAP_BROKEN } from './meshExport'

export { validateSkin, MAX_INFLUENCES }

// Sampling further than this fraction of the mesh's diagonal means the surfaces
// are not really the same shape any more — a limb the source does not have, or
// two meshes that merely overlap. Not fatal (a low-poly cage legitimately sits
// off the surface), so it reports rather than refuses.
export const RIG_SOURCE_FAR_SAMPLE = 0.05


/**
 * Read a rigged object graph into flat, world-space arrays ready to sample.
 *
 * Two-phase on purpose: this half is cheap and yields the bounding box, so the
 * fit can be judged — and a hopeless source refused — before paying for the BVH
 * that `buildSkinSampler` builds (seconds, on the main thread, for a 500k-vertex
 * AI mesh).
 *
 * `boneNames` is the bone order the result must be expressed in — the order of
 * `rig.boneNames`, which is what the geometry's `skinIndex` attribute will be
 * read against. Every submesh's own skeleton is mapped into it BY NAME rather
 * than by index: a body + head + eyes export can carry several skeletons, and
 * merging their raw indices would silently bind the head to the leg bones.
 *
 * Returns null when the graph carries no skinning to sample.
 */
export function collectSkinSource(root, boneNames) {
  if (!root || !boneNames?.length) return null

  // First occurrence wins. Duplicate bone names are already ambiguous for the
  // clips and the bone mapping, so this changes nothing they do not.
  const boneIndex = new Map()
  boneNames.forEach((name, index) => {
    if (!boneIndex.has(name)) boneIndex.set(name, index)
  })

  const positions = []
  const indices = []
  const skinIndex = []
  const skinWeight = []
  const skipped = []
  let vertexBase = 0

  root.updateMatrixWorld(true)

  const skinned = []
  root.traverse(child => {
    if (child.isSkinnedMesh && child.skeleton?.bones?.length) skinned.push(child)
  })

  for (const mesh of skinned) {
    const geometry = mesh.geometry
    const position = geometry?.getAttribute('position')
    const joints = geometry?.getAttribute('skinIndex')
    const weights = geometry?.getAttribute('skinWeight')
    if (!position || !joints || !weights) continue

    const bones = mesh.skeleton.bones

    // Which of this submesh's bones actually carry weight, and can they all be
    // named in the target order? A submesh with even one unmappable *referenced*
    // bone is skipped whole rather than have those influences dropped: dropping
    // them leaves vertices with an all-zero weight set, which reads downstream
    // as "bound to bone 0" and pins that patch of the mesh to the root.
    const referenced = new Set()
    for (let i = 0; i < joints.count; i += 1) {
      for (let s = 0; s < 4; s += 1) {
        if (weights.getComponent(i, s) > 0) referenced.add(joints.getComponent(i, s))
      }
    }
    const unmappable = [...referenced].filter(index => {
      const bone = bones[index]
      return !bone || !boneIndex.has(bone.name)
    })
    if (unmappable.length) {
      skipped.push({
        name: mesh.name || 'mesh',
        reason: `${unmappable.length} of its bones are not in the skeleton being transferred`,
      })
      continue
    }
    const remap = bones.map(bone => (bone && boneIndex.has(bone.name) ? boneIndex.get(bone.name) : 0))

    // Rest-pose world position, exactly as loadEditableGeometryFromObject
    // derives it for the editable geometry — which is what makes the two
    // comparable. At rest every joint matrix is identity, so three's skinning
    // reduces to the plain `matrixWorld · position` this computes.
    const toWorld = mesh.matrixWorld
    const point = new THREE.Vector3()
    for (let i = 0; i < position.count; i += 1) {
      point.fromBufferAttribute(position, i).applyMatrix4(toWorld)
      positions.push(point.x, point.y, point.z)
      for (let s = 0; s < 4; s += 1) {
        skinIndex.push(remap[joints.getComponent(i, s)] ?? 0)
        skinWeight.push(weights.getComponent(i, s))
      }
    }

    const index = geometry.getIndex()
    if (index) {
      for (let i = 0; i < index.count; i += 1) indices.push(index.getX(i) + vertexBase)
    } else {
      // De-indexed geometry: three vertices per triangle, so sequential indices
      // reproduce the same triangles.
      for (let i = 0; i < position.count; i += 1) indices.push(i + vertexBase)
    }
    vertexBase += position.count
  }

  if (!indices.length) return null

  const positionArray = new Float32Array(positions)
  const box = new THREE.Box3()
  const corner = new THREE.Vector3()
  for (let i = 0; i < positionArray.length; i += 3) {
    box.expandByPoint(corner.set(positionArray[i], positionArray[i + 1], positionArray[i + 2]))
  }

  return {
    positions: positionArray,
    indices: new Uint32Array(indices),
    skinIndex: new Uint16Array(skinIndex),
    skinWeight: new Float32Array(skinWeight),
    box,
    meshes: skinned.length - skipped.length,
    skipped,
  }
}


/**
 * Decide whether a source can be sampled, and how far it has to move first.
 *
 * One home for the policy, so the panel's warning and the run's refusal cannot
 * disagree. `alignedOverlap` is the bake tool's measure of the overlap after
 * virtually re-centring the source, and it is only claimed when the two boxes
 * are the same size — at a different scale, re-centring would leave the surfaces
 * crossing each other and sample nonsense, so that is refused instead of
 * guessed at.
 */
export function planRigSourceAlignment(fit) {
  if (!fit) return { offset: null, recentred: false, refuse: null, warn: null }

  // A size mismatch that still overlaps is not refused, because the boxes agree
  // to within a tolerance sized for the extremities a decimation shaves off —
  // and because one box inside the other overlaps perfectly on every axis, so
  // the overlap measure cannot see it at all. It is worth saying out loud
  // though: sampling a source twice the size maps the mesh onto the middle of
  // it and hands back weights blended from the wrong place.
  const warn = fit.sameScale || !fit.sourceDiagonal ? null
    : `The source mesh is ${(fit.sourceDiagonal / fit.diagonal).toFixed(2)}x the size of this one. `
      + 'The weights can still be sampled, but they will come from the wrong part of the source unless '
      + 'the two are exported at the same scale — check the result before saving.'

  if (fit.overlap >= BAKE_OVERLAP_BROKEN) return { offset: null, recentred: false, refuse: null, warn }
  if (!fit.sameScale) {
    return {
      offset: null,
      recentred: false,
      warn,
      refuse: 'The two meshes are different sizes, so the weights cannot be sampled across them. '
        + 'Export both at the same scale (or fix the scale of one) and try again.',
    }
  }
  if (fit.alignedOverlap < BAKE_OVERLAP_BROKEN) {
    return {
      offset: null,
      recentred: false,
      warn,
      refuse: 'The two meshes barely overlap, so there is no source surface under most of this mesh. '
        + 'They need to be in the same space — pick a version of this same mesh, or align them first.',
    }
  }
  return { offset: fit.offset.clone(), recentred: true, refuse: null, warn }
}


/**
 * Build the sampler `transferSkin` needs: the source surface with a BVH over it.
 *
 * `offset` moves the source into the target's space (see planRigSourceAlignment)
 * and is applied to the baked positions here, so the sampler ends up in the same
 * space as the target's vertices and callers can query with plain world
 * positions. The skeleton has to make the same move — `translateRig` does that
 * half.
 */
export function buildSkinSampler(collected, offset = null) {
  if (!collected) return null

  const positions = new Float32Array(collected.positions)
  if (offset) {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] += offset.x
      positions[i + 1] += offset.y
      positions[i + 2] += offset.z
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(new THREE.Uint32BufferAttribute(collected.indices, 1))
  geometry.computeBoundsTree?.()

  return {
    geometry,
    skinIndex: collected.skinIndex,
    skinWeight: collected.skinWeight,
    dispose() {
      geometry.disposeBoundsTree?.()
      geometry.dispose()
    },
  }
}


/**
 * Sample `sampler` at every vertex of `targetGeometry` and write the weights on.
 *
 * A thin pass-through to the assembly transfer, which already does everything
 * needed: barycentric interpolation (not nearest-vertex, which quantises the
 * result to the SOURCE's resolution and stair-steps across every bone
 * boundary), weld-group unification (without which the mesh looks perfect at
 * rest and tears into holes the moment it is posed) and smoothing over those
 * groups. It exists so callers do not have to know the assembly vocabulary, and
 * so the diagonal-relative "sampled too far" judgement has one home.
 */
export function transferSkin(sampler, targetGeometry, { smoothIters = 2, diagonal = 0 } = {}) {
  return transferSkinFromBase(sampler, targetGeometry, targetGeometry.getAttribute('position').array, {
    smoothIters,
    maxInfluences: MAX_INFLUENCES,
    maxDistance: diagonal ? diagonal * RIG_SOURCE_FAR_SAMPLE : null,
  })
}


/** The box the editable geometry occupies, for the fit measurement. */
export function geometryBox(geometry) {
  if (!geometry?.getAttribute('position')) return new THREE.Box3()
  geometry.computeBoundingBox()
  return geometry.boundingBox.clone()
}


/**
 * Measure how well a source sits on the mesh being rigged.
 *
 * The bake measure plus the source's own diagonal, which is what turns its
 * `sameScale` boolean into something the panel can put a number on.
 */
export function measureRigSourceFit(targetGeometry, sourceBox) {
  const fit = measureBakeOverlap(geometryBox(targetGeometry), sourceBox)
  if (!fit) return null
  return { ...fit, sourceDiagonal: sourceBox.getSize(new THREE.Vector3()).length() }
}
