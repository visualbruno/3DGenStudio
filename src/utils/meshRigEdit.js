// Hand-editing the captured rig: move a joint, rename a bone, delete bones that
// Auto Rig got wrong. Operates on the same `rig` object utils/meshRig.js builds
// ({ rigScene, boneCount, boneNames }) plus the editable geometry that carries
// the per-vertex weights, and leaves both in a state the existing export path
// (buildRiggedObject) can consume unchanged.
//
// ── Three index spaces, and why that matters ────────────────────────────────
// A bone can be addressed three ways here:
//   * OVERLAY index — position in `collectSkeletonBones()` traverse order. This
//     is what `selectedBone`, the Skeleton tree and SkeletonOverlay all use.
//   * SKELETON index — position in `skeleton.bones`. This is what the geometry's
//     `skinIndex` attribute stores.
//   * the bone object itself — the only thing both agree on.
// They usually coincide and are not required to. Every weight edit below maps
// overlay → object → skeleton index; none of them assumes the two are equal.
//
// ── Moving a joint does not move the mesh ───────────────────────────────────
// The editable geometry holds rest-pose world positions and is exported with an
// identity bind matrix (see the note at the top of meshRig.js), which works
// because each joint matrix — bone.matrixWorld · boneInverse — is identity at
// rest. Recomputing the inverses after a move restores that identity, so the
// surface stays exactly where it was and only the pivot the vertices will rotate
// about has changed. That is precisely the auto-rig mistake worth fixing, and it
// is invisible until the rig is posed.
import * as THREE from 'three'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { collectSkeletonBones, boneParentIndices } from './skeleton'

const _matrix = new THREE.Matrix4()
const _parentInverse = new THREE.Matrix4()

function collectSkinnedMeshes(scene) {
  const meshes = []
  scene.traverse(node => { if (node.isSkinnedMesh && node.skeleton) meshes.push(node) })
  return meshes
}

// Skeleton.clone() hands the copy the SAME boneInverses array, and
// calculateInverses() empties that array in place — so a cloned rig shares bind
// data with its source until this is called, and recomputing inverses on one
// silently rewrites the other. Undo snapshots depend on the two being separate.
function detachBoneInverses(scene) {
  const seen = new Set()
  for (const mesh of collectSkinnedMeshes(scene)) {
    if (seen.has(mesh.skeleton)) continue
    seen.add(mesh.skeleton)
    mesh.skeleton.boneInverses = mesh.skeleton.boneInverses.map(m => m.clone())
  }
}

export function cloneRigScene(scene) {
  const copy = skeletonClone(scene)
  detachBoneInverses(copy)
  return copy
}

// Re-derive the bind pose after the bones have moved, so the rest pose renders
// unchanged. Mirrors what translateRig does for the pivot fix.
function refreshBindPose(scene) {
  scene.updateMatrixWorld(true)
  // The captured rig is a SkeletonUtils clone of the loaded mesh, and cloning
  // shares the boneInverses array with the source — so recomputing here would
  // also rewrite the bind pose of the graph we were cloned from. Split them
  // first; after the first edit this is a no-op on already-detached arrays.
  detachBoneInverses(scene)
  const seen = new Set()
  for (const mesh of collectSkinnedMeshes(scene)) {
    if (seen.has(mesh.skeleton)) continue
    seen.add(mesh.skeleton)
    mesh.skeleton.calculateInverses()
  }
}

// A `rig` record for a scene, in the shape extractRigFromObject returns.
export function rigFromScene(rigScene) {
  const bones = collectSkeletonBones(rigScene)
  if (!bones.length) return null
  return {
    rigScene,
    boneCount: bones.length,
    boneNames: bones.map(b => b.name),
    // Carried by the scene itself through cloneRigScene, so undoing a bone edit
    // does not quietly drop the mesh's animations along with it.
    animations: Array.isArray(rigScene.animations) ? rigScene.animations : [],
  }
}

// Refresh the cached counts/names after an edit changed them.
export function refreshRigMeta(rig) {
  if (!rig?.rigScene) return rig
  const bones = collectSkeletonBones(rig.rigScene)
  rig.boneCount = bones.length
  rig.boneNames = bones.map(b => b.name)
  return rig
}

export function rigBones(rig) {
  return rig?.rigScene ? collectSkeletonBones(rig.rigScene) : []
}

// ── Move ────────────────────────────────────────────────────────────────────

// Put bone `index` at a world-space position.
//
// `moveChildren: false` (the default) keeps every child joint exactly where it
// is by rewriting its local transform — the elbow moves, the wrist does not.
// That is almost always what fixing a mis-placed joint means; dragging the whole
// limb along is the opt-in.
export function moveRigBone(rig, index, worldPosition, { moveChildren = false } = {}) {
  const scene = rig?.rigScene
  if (!scene) return false
  const bones = collectSkeletonBones(scene)
  const bone = bones[index]
  if (!bone) return false

  scene.updateMatrixWorld(true)
  const children = bone.children.slice()
  const childWorld = moveChildren ? null : children.map(child => child.matrixWorld.clone())

  const local = new THREE.Vector3(worldPosition.x, worldPosition.y, worldPosition.z)
  if (bone.parent) {
    bone.parent.updateWorldMatrix(true, false)
    local.applyMatrix4(_parentInverse.copy(bone.parent.matrixWorld).invert())
  }
  bone.position.copy(local)
  bone.updateMatrixWorld(true)

  if (childWorld) {
    const inverse = _matrix.copy(bone.matrixWorld).invert()
    children.forEach((child, i) => {
      const childLocal = new THREE.Matrix4().multiplyMatrices(inverse, childWorld[i])
      childLocal.decompose(child.position, child.quaternion, child.scale)
    })
    bone.updateMatrixWorld(true)
  }

  refreshBindPose(scene)
  return true
}

// ── Rename ──────────────────────────────────────────────────────────────────

// Bone names are the retargeting contract (the Animations tab maps clips by
// name), so they have to stay unique.
export function renameRigBone(rig, index, rawName) {
  const scene = rig?.rigScene
  if (!scene) return null
  const bones = collectSkeletonBones(scene)
  const bone = bones[index]
  if (!bone) return null

  const name = String(rawName || '').trim()
  if (!name || name === bone.name) return null
  const taken = new Set(bones.filter((_, i) => i !== index).map(b => b.name))
  let unique = name
  let suffix = 2
  while (taken.has(unique)) unique = `${name}_${suffix++}`

  bone.name = unique
  refreshRigMeta(rig)
  return unique
}

// ── Add ─────────────────────────────────────────────────────────────────────

// Where a new child bone should appear when the user hasn't placed it yet:
// carrying on in the direction the chain was already going, at a fraction of the
// last bone's length. That reads as "the next joint down the limb" — a finger
// tip, a tail link — and lands somewhere visible to grab. Bones with no
// grandparent to give a direction get a small step up instead.
function defaultChildOffset(bone, bones) {
  const world = bone.getWorldPosition(new THREE.Vector3())
  let parentBone = bone.parent
  while (parentBone && !parentBone.isBone) parentBone = parentBone.parent

  if (parentBone) {
    const parentWorld = parentBone.getWorldPosition(new THREE.Vector3())
    const direction = world.clone().sub(parentWorld)
    const length = direction.length()
    if (length > 1e-6) return world.add(direction.multiplyScalar(0.6))
  }

  // Fall back to a tenth of the whole rig's extent, so the step suits its scale.
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  for (const other of bones) box.expandByPoint(other.getWorldPosition(point))
  const size = box.isEmpty() ? 1 : box.getSize(point).length()
  return world.add(new THREE.Vector3(0, Math.max(size * 0.1, 1e-3), 0))
}

// Add a child bone under `parentIndex`, and register it with the skeleton so
// weights can address it. It starts with NO influence — a weight cannot be
// invented for a bone that did not exist when the mesh was skinned — which makes
// it immediately useful as an attachment point, and a candidate for
// takeWeightsFromParent when it is meant to deform.
//
// Returns { index, name } in OVERLAY terms, so the caller can select it.
export function addChildBone(rig, parentIndex, { name, position } = {}) {
  const scene = rig?.rigScene
  if (!scene) return null
  scene.updateMatrixWorld(true)

  const bones = collectSkeletonBones(scene)
  const parent = bones[parentIndex]
  if (!parent) return null

  const taken = new Set(bones.map(b => b.name))
  const base = String(name || '').trim() || `${parent.name || 'bone'}_child`
  let unique = base
  let suffix = 2
  while (taken.has(unique)) unique = `${base}_${suffix++}`

  const bone = new THREE.Bone()
  bone.name = unique
  parent.add(bone)

  const world = position
    ? new THREE.Vector3(position[0], position[1], position[2])
    : defaultChildOffset(parent, bones)
  parent.updateWorldMatrix(true, false)
  bone.position.copy(world.applyMatrix4(_parentInverse.copy(parent.matrixWorld).invert()))
  scene.updateMatrixWorld(true)

  // Extend every skeleton that holds the parent. The new bone's inverse is taken
  // from where it stands right now: that pose becomes its bind pose, so the rest
  // pose is unaffected by its arrival.
  const meshes = collectSkinnedMeshes(scene)
  const patched = new Set()
  for (const mesh of meshes) {
    const skeleton = mesh.skeleton
    if (patched.has(skeleton) || !skeleton.bones.includes(parent)) continue
    patched.add(skeleton)
    const nextBones = [...skeleton.bones, bone]
    const nextInverses = [
      ...skeleton.boneInverses.map(m => m.clone()),
      new THREE.Matrix4().copy(bone.matrixWorld).invert(),
    ]
    const nextSkeleton = new THREE.Skeleton(nextBones, nextInverses)
    // Mark the replacement as handled too: rebinding below moves every mesh that
    // shared the old skeleton onto it, and a later pass would otherwise see a
    // skeleton containing the parent and append the bone a second time.
    patched.add(nextSkeleton)
    for (const other of meshes) {
      if (other.skeleton === skeleton) other.bind(nextSkeleton, other.bindMatrix)
    }
    skeleton.dispose?.()
  }

  refreshRigMeta(rig)
  const index = collectSkeletonBones(scene).indexOf(bone)
  return { index, name: unique }
}

// Hand a bone the share of its parent's vertices that lie past it, so a newly
// added joint actually deforms something.
//
// The split is the standard one: project each of the parent's weighted vertices
// onto the parent→bone axis and transfer by a smooth band around the bone's own
// position, rather than a hard plane that would crease the surface. Total weight
// per vertex is untouched — this moves influence between two bones, it does not
// create any.
export function takeWeightsFromParent(rig, geometry, index, { band = 0.35 } = {}) {
  const scene = rig?.rigScene
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  const result = { geometry, moved: 0, weight: 0, reason: null }
  if (!scene || !skinIndex || !skinWeight) {
    result.reason = 'This mesh has no skin weights to share.'
    return result
  }

  scene.updateMatrixWorld(true)
  const bones = collectSkeletonBones(scene)
  const parents = boneParentIndices(bones)
  const bone = bones[index]
  const parent = parents[index] >= 0 ? bones[parents[index]] : null
  if (!bone || !parent) {
    result.reason = 'A root bone has no parent to take weights from.'
    return result
  }

  const skeleton = collectSkinnedMeshes(scene)[0]?.skeleton
  const skelIndexOf = new Map((skeleton?.bones || []).map((b, i) => [b, i]))
  const boneSkel = skelIndexOf.get(bone)
  const parentSkel = skelIndexOf.get(parent)
  if (boneSkel == null || parentSkel == null) {
    result.reason = 'These bones are not part of the skinned skeleton.'
    return result
  }

  const origin = parent.getWorldPosition(new THREE.Vector3())
  const axis = bone.getWorldPosition(new THREE.Vector3()).sub(origin)
  const length = axis.length()
  if (length <= 1e-6) {
    result.reason = 'Move the bone away from its parent first — they share a position.'
    return result
  }
  axis.divideScalar(length)

  const positions = geometry.attributes.position
  const indices = skinIndex.array
  const values = Float32Array.from(skinWeight.array)
  const nextIndices = Uint16Array.from(indices)
  const point = new THREE.Vector3()
  const low = 1 - band
  const high = 1 + band

  for (let v = 0; v < skinIndex.count; v += 1) {
    let slot = -1
    let existing = -1
    for (let k = 0; k < 4; k += 1) {
      if (values[v * 4 + k] > 0 && indices[v * 4 + k] === parentSkel) slot = k
      if (values[v * 4 + k] > 0 && indices[v * 4 + k] === boneSkel) existing = k
    }
    if (slot < 0) continue

    // How far along the parent→bone axis this vertex sits, 1 being the bone.
    point.fromBufferAttribute(positions, v).sub(origin)
    const t = point.dot(axis) / length
    const s = Math.min(1, Math.max(0, (t - low) / (high - low)))
    const fraction = s * s * (3 - 2 * s)      // smoothstep
    if (fraction <= 1e-4) continue

    const share = values[v * 4 + slot] * fraction
    if (share <= 1e-6) continue

    if (existing >= 0) {
      values[v * 4 + slot] -= share
      values[v * 4 + existing] += share
    } else {
      // glTF gives a vertex four influences and no more, so a fifth has to
      // displace one. Take an empty slot if there is one, else the weakest — and
      // only when it is weaker than what we are adding, since trading a stronger
      // influence away would do more harm than the new bone does good.
      let victim = -1
      let smallest = Infinity
      for (let k = 0; k < 4; k += 1) {
        if (k === slot) continue
        const w = values[v * 4 + k]
        if (w < smallest) { smallest = w; victim = k }
      }
      if (victim < 0 || smallest >= share) continue
      values[v * 4 + slot] -= share
      values[v * 4 + victim] = share
      nextIndices[v * 4 + victim] = boneSkel
    }
    result.moved += 1
    result.weight += share
  }

  if (!result.moved) {
    result.reason = 'No vertices of the parent reach past this bone.'
    return result
  }

  // Renormalise: dropping a weakest influence above can leave a vertex short.
  for (let v = 0; v < skinIndex.count; v += 1) {
    let sum = 0
    for (let k = 0; k < 4; k += 1) sum += values[v * 4 + k]
    if (sum <= 0 || Math.abs(sum - 1) < 1e-6) continue
    for (let k = 0; k < 4; k += 1) values[v * 4 + k] /= sum
  }

  const next = geometry.clone()
  next.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(nextIndices, 4))
  next.setAttribute('skinWeight', new THREE.Float32BufferAttribute(values, 4))
  result.geometry = next
  return result
}

// ── Influence ───────────────────────────────────────────────────────────────

// overlay index → skeleton index (-1 for a bone the skinned skeleton does not
// hold). The one bridge between the two spaces described at the top of this
// file; everything that reads or writes `skinIndex` from a UI selection has to
// cross it, so it lives in exactly one place.
export function rigSkeletonIndices(rig) {
  const scene = rig?.rigScene
  if (!scene) return new Int32Array(0)
  const bones = collectSkeletonBones(scene)
  const skeleton = collectSkinnedMeshes(scene)[0]?.skeleton
  const skelIndexOf = new Map((skeleton?.bones || []).map((bone, i) => [bone, i]))
  const out = new Int32Array(bones.length).fill(-1)
  bones.forEach((bone, overlay) => {
    const skel = skelIndexOf.get(bone)
    if (skel != null) out[overlay] = skel
  })
  return out
}

// Per-bone skin influence in OVERLAY order: how many vertices each bone moves
// and what share of the total weight it carries. This is what makes deleting a
// bone a decision rather than a gamble — a bone at 0% moves nothing.
export function computeRigInfluence(rig, geometry) {
  const scene = rig?.rigScene
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  if (!scene) return null

  const bones = collectSkeletonBones(scene)
  const counts = new Int32Array(bones.length)
  const weights = new Float32Array(bones.length)
  if (!skinIndex || !skinWeight) {
    return { counts, weights, total: 0, hasSkin: false }
  }

  // skeleton index → overlay index, so a single pass over the weights can score
  // straight into overlay order.
  const skeleton = collectSkinnedMeshes(scene)[0]?.skeleton
  const toSkeleton = rigSkeletonIndices(rig)
  const toOverlay = new Int32Array(skeleton?.bones?.length || 0).fill(-1)
  toSkeleton.forEach((skel, overlay) => { if (skel >= 0) toOverlay[skel] = overlay })

  const indices = skinIndex.array
  const values = skinWeight.array
  let total = 0
  for (let i = 0; i < indices.length; i += 1) {
    const w = values[i]
    if (!(w > 1e-4)) continue
    const overlay = toOverlay[indices[i]]
    if (overlay < 0) continue
    counts[overlay] += 1
    weights[overlay] += w
    total += w
  }

  return { counts, weights, total, hasSkin: true }
}

// Bones whose whole subtree moves nothing — the `Extra_*` tails Auto Rig likes
// to hang off hands and feet. Roots are excluded: they hold the rig together and
// have nowhere to fold into.
export function findUnusedBones(rig, geometry, influence = null) {
  const scene = rig?.rigScene
  if (!scene) return []
  const stats = influence || computeRigInfluence(rig, geometry)
  if (!stats?.hasSkin) return []

  const bones = collectSkeletonBones(scene)
  const parents = boneParentIndices(bones)
  // Roll each bone's own influence up into its ancestors, so a bone only counts
  // as unused when nothing beneath it is weighted either.
  const subtree = Float32Array.from(stats.weights)
  const order = bones.map((_, i) => i).sort((a, b) => depthOf(parents, b) - depthOf(parents, a))
  for (const i of order) {
    const p = parents[i]
    if (p >= 0) subtree[p] += subtree[i]
  }

  return bones
    .map((_, i) => i)
    .filter(i => parents[i] >= 0 && subtree[i] <= 0)
}

function depthOf(parents, index) {
  let depth = 0
  let p = parents[index]
  while (p >= 0) { depth += 1; p = parents[p] }
  return depth
}

// ── Delete ──────────────────────────────────────────────────────────────────

// Remove bones, folding their skin weights into the nearest surviving ancestor
// and reparenting their children (world transforms preserved). Exact — no
// weights are invented, and every vertex keeps a total weight of 1.
//
// Returns the rewritten geometry; the rig scene is mutated in place. Callers are
// expected to have snapshotted both first.
export function deleteRigBones(rig, geometry, indices) {
  const scene = rig?.rigScene
  const result = { geometry, removed: 0, removedNames: [], blocked: [] }
  if (!scene || !indices?.length) return result

  scene.updateMatrixWorld(true)
  const bones = collectSkeletonBones(scene)
  const parents = boneParentIndices(bones)

  const doomed = new Set()
  for (const index of indices) {
    if (!bones[index]) continue
    // A root has nothing to fold its weights into, and deleting it would take
    // the rig with it.
    if (parents[index] < 0) result.blocked.push(bones[index].name)
    else doomed.add(index)
  }
  if (!doomed.size) return result

  const skinnedMeshes = collectSkinnedMeshes(scene)
  const skeleton = skinnedMeshes[0]?.skeleton || null
  const oldBones = skeleton?.bones || []
  const skelIndexOf = new Map(oldBones.map((bone, i) => [bone, i]))

  // Where each doomed bone's weight goes: the nearest ancestor that survives.
  const inheritor = new Map()
  for (const index of doomed) {
    let p = parents[index]
    while (p >= 0 && doomed.has(p)) p = parents[p]
    inheritor.set(index, p)
  }

  // Surviving skeleton bones keep their bind matrices: nothing moves, so every
  // inverse still holds.
  const survivors = []
  const survivorInverses = []
  const newSkelIndex = new Int32Array(oldBones.length).fill(-1)
  const doomedSkel = new Set()
  for (const index of doomed) {
    const skel = skelIndexOf.get(bones[index])
    if (skel != null) doomedSkel.add(skel)
  }
  oldBones.forEach((bone, skel) => {
    if (doomedSkel.has(skel)) return
    newSkelIndex[skel] = survivors.length
    survivors.push(bone)
    survivorInverses.push(skeleton.boneInverses[skel]?.clone() || new THREE.Matrix4())
  })

  // old skeleton index → new skeleton index, with doomed bones pointing at their
  // inheritor instead of dropping their weight on the floor.
  const redirect = Int32Array.from(newSkelIndex)
  for (const index of doomed) {
    const skel = skelIndexOf.get(bones[index])
    if (skel == null) continue
    const heir = inheritor.get(index)
    const heirSkel = heir >= 0 ? skelIndexOf.get(bones[heir]) : null
    redirect[skel] = heirSkel == null ? -1 : newSkelIndex[heirSkel]
  }

  // Detach deepest-first so every bone is a leaf by the time it goes, and each
  // reparented child lands on a node that is itself still standing.
  const order = [...doomed].sort((a, b) => depthOf(parents, b) - depthOf(parents, a))
  for (const index of order) {
    const bone = bones[index]
    const host = bone.parent
    if (!host) continue
    scene.updateMatrixWorld(true)
    for (const child of [...bone.children]) host.attach(child)   // keeps world transforms
    host.remove(bone)
    result.removedNames.push(bone.name)
    result.removed += 1
  }
  scene.updateMatrixWorld(true)

  if (skeleton) {
    const nextSkeleton = new THREE.Skeleton(survivors, survivorInverses)
    for (const mesh of skinnedMeshes) {
      if (mesh.skeleton === skeleton) mesh.bind(nextSkeleton, mesh.bindMatrix)
    }
    skeleton.dispose?.()
  }

  result.geometry = remapSkinAttributes(geometry, redirect)
  refreshRigMeta(rig)
  return result
}

// Rewrite skinIndex/skinWeight through a bone remap, merging the entries that
// collapse onto the same bone and renormalising each vertex back to 1.
function remapSkinAttributes(geometry, redirect) {
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  if (!skinIndex || !skinWeight) return geometry

  const count = skinIndex.count
  const oldIndices = skinIndex.array
  const oldWeights = skinWeight.array
  const nextIndices = new Uint16Array(count * 4)
  const nextWeights = new Float32Array(count * 4)
  const merged = new Map()

  for (let v = 0; v < count; v += 1) {
    merged.clear()
    for (let k = 0; k < 4; k += 1) {
      const w = oldWeights[v * 4 + k]
      if (!(w > 0)) continue
      const target = redirect[oldIndices[v * 4 + k]]
      if (target == null || target < 0) continue
      merged.set(target, (merged.get(target) || 0) + w)
    }
    // A vertex can end up with more than four influences once bones merge; keep
    // the strongest four, which is all glTF can carry anyway.
    const entries = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    let sum = 0
    for (const [, w] of entries) sum += w
    if (sum <= 0) continue      // was already unweighted — leave it that way
    entries.forEach(([bone, w], k) => {
      nextIndices[v * 4 + k] = bone
      nextWeights[v * 4 + k] = w / sum
    })
  }

  const next = geometry.clone()
  // JOINTS_0 must stay an integer accessor for glTF (see createIndexedGeometry).
  next.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(nextIndices, 4))
  next.setAttribute('skinWeight', new THREE.Float32BufferAttribute(nextWeights, 4))
  return next
}

// ── Undo ────────────────────────────────────────────────────────────────────

// A rig edit spans two things that must move together: the bone scene graph and
// the weights on the geometry. Snapshotting only one of them would let undo
// restore a skeleton that its weights no longer describe.
export function snapshotRig(rig, geometry) {
  if (!rig?.rigScene) return null
  const skinIndex = geometry?.attributes?.skinIndex
  const skinWeight = geometry?.attributes?.skinWeight
  return {
    rigScene: cloneRigScene(rig.rigScene),
    vertexCount: geometry?.attributes?.position?.count ?? 0,
    skinIndex: skinIndex ? new Uint16Array(skinIndex.array) : null,
    skinWeight: skinWeight ? new Float32Array(skinWeight.array) : null,
  }
}

// Rebuild a rig + geometry from a snapshot. The snapshot itself is left intact
// and reusable, so the same entry can serve an undo and the redo after it.
export function restoreRigSnapshot(snapshot, geometry) {
  if (!snapshot?.rigScene) return null
  const rig = rigFromScene(cloneRigScene(snapshot.rigScene))
  if (!rig) return null

  let nextGeometry = geometry
  const sameMesh = geometry?.attributes?.position?.count === snapshot.vertexCount
  if (sameMesh && snapshot.skinIndex && snapshot.skinWeight) {
    nextGeometry = geometry.clone()
    nextGeometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(snapshot.skinIndex), 4))
    nextGeometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(snapshot.skinWeight), 4))
  }
  return { rig, geometry: nextGeometry }
}
