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
import { composePieceMatrix } from './assemblyGeometry'

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
function buildGroup(entries, { toLocalOf = null } = {}) {
  const group = new THREE.Group()
  const inverse = toLocalOf ? new THREE.Matrix4().copy(toLocalOf).invert() : null

  for (const { piece, entry, preview } of entries) {
    const edited = pieceHasEdit(preview)
    const source = edited ? preview : entry
    const placement = composePieceMatrix(piece, new THREE.Matrix4())

    for (const mesh of source.meshes) {
      const geometry = mesh.geometry.clone()

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

async function exportGroup(group, baseName) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const buffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(group, resolve, reject, { binary: true, onlyVisible: false })
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
export async function exportMergedAssemblyGlb(entries, name) {
  const group = buildGroup(entries)
  group.name = `${sanitize(name)}_assembly`
  return exportGroup(group, `${name}-assembly`)
}
