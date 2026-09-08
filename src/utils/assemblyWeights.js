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

// The maths moved to the repo root so the Node backend can run the same code
// (see the header there). Re-exported, so this module is still the one place
// the assembly feature imports from.
export { MAX_INFLUENCES, transferSkinFromBase, validateSkin } from '../../skinTransfer'


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
