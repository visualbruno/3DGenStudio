// Turning an assembly into assets: a new version of each edited piece, and one
// merged GLB of the whole assembled character.
//
// Two different spaces, deliberately:
//
//   * a PIECE version is written in that piece's OWN local space, with the
//     placement divided back out. It is still the same asset, just a better
//     shape — so it keeps its origin and scale, drops back into any assembly
//     the way the original did, and is not silently welded to one body's
//     coordinates.
//   * the MERGED asset is written in world space, because that IS the
//     assembled character: every piece where the user put it, ready for Auto
//     Rig or export.
import * as THREE from 'three'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { composePieceMatrix } from './assemblyGeometry'
import { transferSkinFromBase, validateSkin } from './assemblyWeights'
import { rebindClipForExport } from './animationLibrary'
import { removeMaskedFaces } from './assemblyHiddenFaces'

/**
 * The geometry to save for one piece: its preview when it has been fitted or
 * sculpted, otherwise its loaded mesh.
 *
 * Returns null when the piece has no edit worth saving.
 */
export function pieceHasEdit(preview) {
  return !!preview?.meshes?.length
}

function sanitize(name) {
  return String(name || 'piece').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'piece'
}

/**
 * Flip triangle winding, for geometry baked through a mirrored placement.
 *
 * A negative determinant turns the surface inside out: it still LOOKS right in
 * the viewport because the material is DoubleSide, and then it imports
 * inside-out into an engine, where nobody notices until much later. So the
 * winding is corrected at export, where the transform is baked in for good.
 */
function flipWinding(geometry) {
  const index = geometry.getIndex()
  if (index) {
    const array = index.array
    for (let i = 0; i < array.length; i += 3) {
      const swap = array[i]
      array[i] = array[i + 2]
      array[i + 2] = swap
    }
    index.needsUpdate = true
    return
  }
  // Non-indexed: swap the 1st and 3rd vertex of every triangle, across every
  // attribute, or the UVs stop matching the positions.
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.attributes[name]
    const size = attribute.itemSize
    const array = attribute.array
    for (let i = 0; i < attribute.count; i += 3) {
      for (let c = 0; c < size; c += 1) {
        const a = i * size + c
        const b = (i + 2) * size + c
        const swap = array[a]
        array[a] = array[b]
        array[b] = swap
      }
    }
    attribute.needsUpdate = true
  }
}

/**
 * A THREE.Group of the piece's meshes, baked into `targetMatrix` space.
 *
 * `preview` geometry already holds WORLD positions (see buildFitPreview), so
 * for it the bake is the inverse of wherever we want it to end up. An unedited
 * piece is still in its own local space and needs the placement applying.
 *
 * Every geometry is CLONED. Materials are shared with the live scene and must
 * never be disposed by the caller — the same discipline exportPartsToGlb uses.
 */
function buildGroup(entries, { toLocalOf = null, faceMasks = null } = {}) {
  const group = new THREE.Group()
  const inverse = toLocalOf ? new THREE.Matrix4().copy(toLocalOf).invert() : null

  for (const { piece, entry, preview } of entries) {
    const edited = pieceHasEdit(preview)
    const source = edited ? preview : entry
    const placement = composePieceMatrix(piece, new THREE.Matrix4())

    for (const mesh of source.meshes) {
      let geometry = mesh.geometry.clone()

      // Occluded faces go before anything else touches the geometry, so the
      // transform and winding work below runs on what is actually being kept.
      const mask = faceMasks?.get(mesh)
      if (mask) {
        const trimmed = removeMaskedFaces(geometry, mask)
        if (trimmed !== geometry) geometry.dispose()
        geometry = trimmed
      }

      if (edited) {
        // Preview positions are world-space already.
        if (inverse) geometry.applyMatrix4(inverse)
      } else {
        // Unedited: local -> world, then optionally back down.
        mesh.updateMatrixWorld(true)
        source.root.updateMatrixWorld(true)
        const meshToRoot = new THREE.Matrix4()
          .copy(source.root.matrixWorld).invert()
          .multiply(mesh.matrixWorld)
        const toWorld = placement.clone().multiply(meshToRoot)
        geometry.applyMatrix4(inverse ? inverse.clone().multiply(toWorld) : toWorld)
      }

      // Winding follows the NET transform from the file's own space to the
      // space being written, which is the placement followed by whatever this
      // export bakes. That composition is the same on both paths: an edited
      // piece's preview already carries the placement, an unedited one gets it
      // applied above. (meshToRoot is left out — a loader node with negative
      // scale would already render inside-out in three, so it is not ours to
      // correct here.)
      //
      // Testing a proxy instead gets three of the four cases wrong, and only
      // one of them is visible in the viewport: DoubleSide hides an inverted
      // surface right up until it reaches an engine.
      const net = (inverse ? inverse.clone() : new THREE.Matrix4()).multiply(placement)
      if (net.determinant() < 0) flipWinding(geometry)

      if (geometry.getAttribute('normal')) geometry.computeVertexNormals()
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()

      const out = new THREE.Mesh(geometry, mesh.material)
      out.name = sanitize(piece.name)
      group.add(out)
    }
  }
  return group
}

async function exportGroup(group, baseName, animations = []) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const buffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(group, resolve, reject, {
      binary: true, onlyVisible: false, animations,
    })
  })
  // Dispose only what this module created. The materials belong to the live
  // scene and disposing them would blank the viewport.
  for (const child of group.children) child.geometry?.dispose?.()
  group.clear()
  return new File([buffer], `${sanitize(baseName)}.glb`, { type: 'model/gltf-binary' })
}

/**
 * One piece as a GLB in its OWN local space, for saving as a new version of
 * that piece's asset.
 */
export async function exportPieceGlb({ piece, entry, preview }) {
  const placement = composePieceMatrix(piece, new THREE.Matrix4())
  const group = buildGroup([{ piece, entry, preview }], { toLocalOf: placement })
  return exportGroup(group, piece.name)
}

/**
 * The whole assembly as one GLB in world space.
 *
 * Separate nodes per piece, never one welded geometry: the entire point of an
 * assembly is that the armour is still the armour. Each piece keeps its OWN
 * material, unlike exportPartsToGlb's segmentation case where one material is
 * shared — these pieces have distinct textures.
 */
export async function exportMergedAssemblyGlb(entries, name, {
  rig = null, sampler = null, animations = [], faceMasks = null,
} = {}) {
  const group = buildGroup(entries, { faceMasks })
  group.name = `${sanitize(name)}_assembly`

  if (rig?.rigScene && sampler) {
    const skinned = buildSkinnedAssembly(group, rig, sampler, name)
    if (skinned.scene) {
      // The base's own clips, carried onto the merged character. They target
      // bones by NAME, and skeletonClone preserves names, so they bind to the
      // shared skeleton without remapping — every piece then animates with the
      // body instead of the asset arriving rigged but motionless.
      //
      // Clips only ride along on the SKINNED path: with no skeleton in the file
      // there is nothing for their tracks to address.
      const clips = (animations || []).map(rebindClipForExport)
      const file = await exportGroup(skinned.scene, `${name}-assembly`, clips)
      return {
        file, skinned: true, warnings: skinned.warnings,
        bones: skinned.bones, clips: clips.length,
      }
    }
    // Fall through to the static export, carrying the reason with it. A
    // silently-unrigged asset is the failure people notice three steps later.
    stripSkin(group)
    return { file: await exportGroup(group, `${name}-assembly`),
             skinned: false, warnings: skinned.warnings }
  }

  stripSkin(group)
  return { file: await exportGroup(group, `${name}-assembly`), skinned: false, warnings: [] }
}

/**
 * Drop skin attributes from a STATIC export.
 *
 * The base's geometry still carries the skinIndex/skinWeight it was loaded
 * with. Without a `skin` to go with them they are dead weight in the file —
 * ignored by every loader, and misleading to anyone inspecting it to work out
 * why the asset does not animate.
 */
function stripSkin(group) {
  for (const child of group.children) {
    child.geometry?.deleteAttribute?.('skinIndex')
    child.geometry?.deleteAttribute?.('skinWeight')
  }
}

/**
 * Re-home every piece under ONE skeleton cloned from the base.
 *
 * The subtle part of the whole feature. buildRiggedObject clones the rig on
 * every call, so calling it per piece yields N skeletons in the file — Auto Rig
 * and Animations then see several rigs and none of them drives the whole
 * character. The clone therefore happens exactly once here, and every piece is
 * bound to that same Skeleton instance.
 *
 * The bind matrix is identity because the geometry is already in world/rest
 * space, which is the invariant meshRig.js documents at length: at rest the
 * bone matrices reduce to identity, so feeding baked positions back with
 * bindMatrix = I reproduces the same pose. Keeping the original bind matrix
 * would apply it twice and fold the piece inside the body.
 *
 * NOTE ON THE EXPORTED FILE: GLTFExporter writes one `skin` object per
 * SkinnedMesh, so a two-piece assembly shows `skins: 2` even though both were
 * bound to the same Skeleton instance. That is not several skeletons and does
 * not need fixing — the skins carry IDENTICAL joint lists pointing at the same
 * bone NODES (measured: 2 skins, 28 joints each, 28 distinct nodes between
 * them), so one animation drives every piece. Counting `skins` and concluding
 * the share failed is the mistake waiting to be made here; count distinct
 * joint nodes instead.
 */
function buildSkinnedAssembly(group, rig, sampler, name) {
  const warnings = []
  let scene
  try {
    scene = skeletonClone(rig.rigScene)
  } catch (error) {
    return { scene: null, warnings: [`the base's rig could not be cloned (${error.message})`] }
  }

  let skeleton = null
  const templates = []
  scene.traverse(child => {
    if (child.isSkinnedMesh && child.skeleton) {
      if (!skeleton) skeleton = child.skeleton
      templates.push(child)
    }
  })
  if (!skeleton?.bones?.length) {
    return { scene: null, warnings: ['the base has no usable skeleton'] }
  }

  // The rig scene carries the BASE's own skinned mesh. It is a template for the
  // skeleton, not content: the base is already in `group` as a plain mesh if
  // the user asked to include it, and leaving both would export the body twice.
  for (const template of templates) template.removeFromParent()

  const boneCount = skeleton.bones.length
  const pieces = [...group.children]
  for (const mesh of pieces) {
    const positions = mesh.geometry.getAttribute('position').array
    transferSkinFromBase(sampler, mesh.geometry, positions)

    const problem = validateSkin(mesh.geometry, boneCount)
    if (problem) {
      // One bad piece invalidates the whole skinned export: a partial rig loads
      // fine and then animates into knots, which is far harder to diagnose than
      // an asset that is simply not rigged.
      warnings.push(`${mesh.name} ${problem}`)
      return { scene: null, warnings }
    }
  }

  for (const mesh of pieces) {
    const skinnedMesh = new THREE.SkinnedMesh(mesh.geometry, mesh.material)
    skinnedMesh.name = mesh.name
    skinnedMesh.frustumCulled = false
    skinnedMesh.position.set(0, 0, 0)
    skinnedMesh.quaternion.identity()
    skinnedMesh.scale.set(1, 1, 1)
    skinnedMesh.updateMatrix()
    scene.add(skinnedMesh)
    skinnedMesh.bind(skeleton, new THREE.Matrix4())
  }
  group.clear()          // the geometries now belong to the skinned meshes

  scene.name = `${sanitize(name)}_assembly`
  scene.updateMatrixWorld(true)
  return { scene, warnings, bones: boneCount }
}
