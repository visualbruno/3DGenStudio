// Rig preservation for the Mesh Editor.
//
// The editor works on one flattened, world-space BufferGeometry — that is what
// makes its tools simple. A rigged mesh therefore has to be taken apart on load
// and put back together on save:
//
//   * the per-vertex skin data (skinIndex/skinWeight) rides along as ordinary
//     geometry attributes, so anything that only moves vertices — sculpting,
//     painting, projection, the pivot fix — keeps it valid for free;
//   * the skeleton itself (bones + inverse bind matrices) is captured here at
//     load time and kept aside, because it is a scene graph, not vertex data,
//     and nothing in the editing pipeline can carry it.
//
// On export the two are recombined into a SkinnedMesh.
//
// ── Why the bind matrix becomes identity ────────────────────────────────────
// loadEditableGeometryFromObject bakes each vertex through `child.matrixWorld`,
// so the editable geometry holds rest-pose *world* positions rather than bind
// space. Writing p' = bindMatrix·p, three's skinning of the original mesh
// reduces at rest to Σ(boneᵢ.matrixWorld · boneInverseᵢ · p' · wᵢ) = p'. Feeding
// the already-baked p' back in with bindMatrix = I therefore reproduces exactly
// the same rest pose — which is why the node transform is pinned to identity
// too. Keeping the original bind matrix instead would apply it twice and deform
// the mesh.
import * as THREE from 'three'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'

// True when a geometry carries usable per-vertex skin data.
export function geometryHasSkin(geometry) {
  return !!(geometry?.attributes?.skinIndex && geometry?.attributes?.skinWeight)
}

// Capture the rig of a freshly-loaded object graph, or null when it has none.
//
// The graph is deep-cloned with SkeletonUtils (a plain clone would leave the
// copy's SkinnedMesh pointing at the original skeleton) so that later edits to
// the loaded root — the editor swaps geometry onto it and pins its transforms —
// cannot disturb what will be exported.
export function extractRigFromObject(root) {
  if (!root) return null

  let sourceSkinned = null
  root.traverse(child => {
    if (!sourceSkinned && child.isSkinnedMesh && child.skeleton?.bones?.length) {
      sourceSkinned = child
    }
  })
  if (!sourceSkinned) return null

  let rigScene
  try {
    rigScene = skeletonClone(root)
  } catch (err) {
    console.warn('Could not clone the rig for preservation:', err)
    return null
  }

  let rigMesh = null
  rigScene.traverse(child => {
    if (!rigMesh && child.isSkinnedMesh) rigMesh = child
  })
  if (!rigMesh?.skeleton?.bones?.length) return null

  return {
    rigScene,
    boneCount: rigMesh.skeleton.bones.length,
    boneNames: rigMesh.skeleton.bones.map(bone => bone.name),
    // Clips travel with the skeleton, not with the geometry: they address bones
    // by NAME, so they stay valid through every edit that keeps the bone graph —
    // and they are meaningless without it. Keeping them here is what stops an
    // animated mesh losing its animations the first time it is saved from the
    // editor, and what lets a transferred rig bring its clips along.
    //
    // Read off the CLONE rather than `root`: Object3D.copy slices `animations`,
    // so the clone already holds them and the scene stays the one source of
    // truth through every later cloneRigScene (undo, redo, export).
    //
    // Renaming a bone by hand invalidates the tracks that name it. The rig editor
    // warns about the bone MAPPING for the same reason; the clips are the same
    // trade and are left alone rather than silently rewritten.
    animations: Array.isArray(rigScene.animations) ? rigScene.animations : [],
  }
}

// Put a set of animation clips on a rig, keeping the record and the scene it
// caches from in step. The scene is the source of truth (a clone carries its
// `animations` along for free, which is what makes the undo stack keep them);
// the record's copy is what the UI counts.
export function setRigAnimations(rig, clips) {
  if (!rig?.rigScene) return rig
  const animations = Array.isArray(clips) ? [...clips] : []
  rig.rigScene.animations = animations
  rig.animations = animations
  return rig
}

// Move the captured skeleton with the mesh.
//
// Anything that translates the editable geometry bodily — the Game-Ready pivot
// fix — leaves the captured bones behind, because they live in their own scene
// graph. At rest that is invisible: every joint matrix is identity there, so the
// already-translated vertices render in the right place regardless. It only
// surfaces once the rig is *posed*, when the bones rotate about points that are
// no longer inside the mesh. Silent until it reaches an engine, in other words.
//
// The inverse bind matrices are recalculated afterwards. Without that the joint
// matrices stop being identity at rest — they become the translation itself —
// and the export would shift the mesh a second time.
export function translateRig(rig, offsetX, offsetY, offsetZ) {
  const scene = rig?.rigScene
  if (!scene) return

  const bones = []
  scene.traverse(node => { if (node.isBone) bones.push(node) })
  if (!bones.length) return

  const boneSet = new Set(bones)
  const offset = new THREE.Vector3(offsetX, offsetY, offsetZ)
  const worldPosition = new THREE.Vector3()
  const parentInverse = new THREE.Matrix4()

  scene.updateMatrixWorld(true)
  for (const bone of bones) {
    // Only the roots move; every descendant follows through the hierarchy.
    if (boneSet.has(bone.parent)) continue
    bone.getWorldPosition(worldPosition).add(offset)
    if (bone.parent) {
      bone.parent.updateWorldMatrix(true, false)
      parentInverse.copy(bone.parent.matrixWorld).invert()
      worldPosition.applyMatrix4(parentInverse)
    }
    bone.position.copy(worldPosition)
  }
  scene.updateMatrixWorld(true)

  scene.traverse(node => {
    if (node.isSkinnedMesh && node.skeleton) node.skeleton.calculateInverses()
  })
}

// Rebuild an exportable scene: the captured bone hierarchy plus a SkinnedMesh
// carrying `geometry`. Returns null when the geometry has no skin data to bind,
// so callers fall back to a plain static export rather than emit a SkinnedMesh
// with nothing to skin (which is what three crashes on).
export function buildRiggedObject(rig, geometry, material = null) {
  if (!rig?.rigScene || !geometryHasSkin(geometry)) return null

  let scene
  try {
    scene = skeletonClone(rig.rigScene)
  } catch (err) {
    console.warn('Could not rebuild the rig for export:', err)
    return null
  }

  let mesh = null
  scene.traverse(child => {
    if (!mesh && child.isSkinnedMesh) mesh = child
  })
  if (!mesh) return null

  mesh.geometry = geometry
  if (material) mesh.material = material

  // The geometry is already in world space (see the note at the top), so this
  // node contributes nothing further.
  mesh.position.set(0, 0, 0)
  mesh.quaternion.identity()
  mesh.scale.set(1, 1, 1)
  mesh.updateMatrix()
  mesh.matrixWorldNeedsUpdate = true

  mesh.bind(mesh.skeleton, new THREE.Matrix4())
  scene.updateMatrixWorld(true)

  // exportObject3D reads `object.animations`, so this is the single point that
  // puts the clips back into every save/export path at once. Tracks naming a
  // node the rebuilt scene does not have are dropped by GLTFExporter with a
  // warning rather than failing the export.
  scene.animations = Array.isArray(rig.animations) ? rig.animations : []

  return scene
}
