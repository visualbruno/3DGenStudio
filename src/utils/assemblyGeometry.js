// three.js scene math for the Mesh Assembly workspace: turning document TRS into
// matrices, measuring pieces, and tearing their GPU resources down again.
//
// Kept out of assemblyHelpers.js on purpose — that module is pure JSON with no
// three.js import, which is what lets it be unit-tested in plain Node.
import * as THREE from 'three'
import { loadMeshRootFromUrl } from './meshTexturing'

const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _euler = new THREE.Euler()
const _mirror = new THREE.Matrix4().makeScale(-1, 1, 1)

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * The piece's world matrix, composed from its document TRS.
 *
 * `mirrorX` is applied as a reflection in the piece's OWN space, before its
 * rotation and translation — which is what makes "duplicate mirrored" produce a
 * left boot from a right one regardless of how the piece is currently turned.
 * It is a separate flag rather than a negative scale.x because the uniform-scale
 * lock would clobber the sign, and `Matrix4.decompose` normalises a negative
 * determinant onto whichever axis it likes, so a round trip through the document
 * could silently move the mirror to a different axis.
 */
export function composePieceMatrix(piece, target = new THREE.Matrix4()) {
  _position.fromArray(piece.position)
  _euler.set(piece.rotation[0], piece.rotation[1], piece.rotation[2], 'XYZ')
  _quaternion.setFromEuler(_euler)
  _scale.fromArray(piece.scale)

  target.compose(_position, _quaternion, _scale)
  if (piece.mirrorX) target.multiply(_mirror)
  return target
}

/**
 * True when the piece's matrix flips handedness, which happens with `mirrorX` or
 * an odd number of negative scale axes.
 *
 * Two consequences, both of which must be handled or the piece looks broken:
 *  - on screen, face winding inverts, so the material needs DoubleSide;
 *  - on EXPORT, the baked geometry is genuinely inside-out and the index winding
 *    has to be flipped (nobody notices until the GLB is in an engine).
 */
export function pieceIsFlipped(piece) {
  const [sx, sy, sz] = piece.scale
  const sign = Math.sign(sx) * Math.sign(sy) * Math.sign(sz)
  return piece.mirrorX ? sign > 0 : sign < 0
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load one piece's display graph.
 *
 * Unlike the mesh editor, the scene graph is KEPT: loadMeshRootFromUrl returns
 * the raw Object3D, and nothing here runs it through
 * createMergedGeometryFromObject, which bakes matrixWorld into the vertices and
 * welds every child into one geometry. That merge is exactly what an assembly
 * cannot afford — the whole point is that the armour stays the armour.
 *
 * NOTE the display graph's raw `position` attribute may still be quantized
 * (KHR_mesh_quantization). That is fine for RENDERING, because the node-level
 * scale that decodes it is part of the graph. Anything that reads vertex
 * positions numerically — landmarks, the fit payload — must dequantize first
 * (see dequantizeGeometryAttributes in utils/meshEditor.js). Getting this wrong
 * misplaces points on *some* assets only, which reads as randomness.
 */
export async function loadAssemblyPieceRoot(url) {
  const root = await loadMeshRootFromUrl(url)
  if (!root) throw new Error('The mesh could not be loaded.')

  const meshes = []
  let vertexCount = 0
  let faceCount = 0
  let hasSkin = false

  root.updateMatrixWorld(true)
  root.traverse(child => {
    if (!child.isMesh || !child.geometry) return
    meshes.push(child)
    if (child.isSkinnedMesh) hasSkin = true

    const position = child.geometry.getAttribute('position')
    if (position) vertexCount += position.count
    const index = child.geometry.getIndex()
    faceCount += index ? index.count / 3 : (position ? position.count / 3 : 0)

    // Frustum culling is measured per mesh against its own bounding sphere. A
    // piece can be scaled by 50x in the document, and a stale sphere makes it
    // pop out of view at certain camera angles.
    child.frustumCulled = false
  })

  if (!meshes.length) throw new Error('That file contains no renderable mesh.')

  const localBox = new THREE.Box3().setFromObject(root)

  return { root, meshes, localBox, vertexCount, faceCount: Math.round(faceCount), hasSkin }
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The piece's local box transformed by its placement — i.e. where it actually sits. */
export function pieceWorldBox(entry, piece, target = new THREE.Box3()) {
  if (!entry?.localBox || entry.localBox.isEmpty()) return target.makeEmpty()
  target.copy(entry.localBox).applyMatrix4(composePieceMatrix(piece))
  return target
}

export function unionBox(boxes) {
  const union = new THREE.Box3().makeEmpty()
  for (const box of boxes) {
    if (box && !box.isEmpty()) union.union(box)
  }
  return union
}

/**
 * An 8-vertex throwaway geometry spanning `box`.
 *
 * This is what lets CameraRig, ViewGizmo and meshFittingSphere work across N
 * meshes with NO changes to any of them: each takes a single `geometry` and
 * calls computeBoundingSphere() on it, and a sphere over these 8 corners covers
 * the whole assembly. Load framing, orbit clamps, ortho zoom clamps and the view
 * cube's double-click fit all then behave as they do for one mesh.
 *
 * The caller owns the result and must dispose it.
 */
export function boundsProxyGeometry(box) {
  const geometry = new THREE.BufferGeometry()
  if (!box || box.isEmpty()) {
    // A single point at the origin still yields a valid (radius 0) sphere, which
    // the framing helpers clamp to their minimum rather than dividing by zero.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
    geometry.computeBoundingSphere()
    return geometry
  }

  const { min, max } = box
  const corners = [
    min.x, min.y, min.z, max.x, min.y, min.z, min.x, max.y, min.z, max.x, max.y, min.z,
    min.x, min.y, max.z, max.x, min.y, max.z, min.x, max.y, max.z, max.x, max.y, max.z,
  ]
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3))
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

/** Longest diagonal of a box — the scale yardstick the UI compares pieces by. */
export function boxDiagonal(box) {
  if (!box || box.isEmpty()) return 0
  return box.getSize(new THREE.Vector3()).length()
}

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------

/**
 * Build a BVH for every mesh in the entry, so picking is a tree query instead of
 * a scan over every triangle.
 *
 * Called LAZILY, on the first interaction that needs it — never at load.
 * computeBoundsTree() on a 500k-vertex AI mesh is seconds of blocked main
 * thread, and importing six of those would freeze the page for ten seconds
 * before the user had done anything. Deferring it means the hitch lands once,
 * on a click, where it reads as the app doing work.
 *
 * three-mesh-bvh's prototype patch is applied by utils/meshEditor.js, which is
 * already in the bundle.
 */
export function ensurePieceBvh(entry) {
  if (!entry || entry.bvhBuilt) return
  for (const mesh of entry.meshes) {
    if (mesh.geometry?.boundsTree) continue
    mesh.geometry?.computeBoundsTree?.()
  }
  entry.bvhBuilt = true
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

// Every texture slot a glTF PBR material can carry. Disposing only `.map` is the
// leak that actually happens: AI-generated meshes routinely ship 2k-4k normal
// and roughness maps, so a piece re-picked a few times can strand hundreds of
// megabytes of GPU memory with nothing pointing at it.
const MAP_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'clearcoatMap',
  'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap',
  'sheenRoughnessMap', 'specularMap', 'specularColorMap', 'specularIntensityMap',
  'transmissionMap', 'thicknessMap', 'iridescenceMap', 'anisotropyMap',
]

function disposeMaterial(material) {
  if (!material) return
  for (const slot of MAP_SLOTS) {
    const texture = material[slot]
    if (texture?.isTexture) texture.dispose()
  }
  material.dispose?.()
}

/**
 * Release everything one entry owns. Called on piece removal, on a re-pick that
 * replaces the asset, and for every entry on unmount.
 *
 * Each entry owns its root exclusively — two pieces referencing the same asset
 * load it twice — so this can dispose unconditionally without checking whether
 * anything else still references the geometry.
 */
export function disposeAssemblyEntry(entry) {
  if (!entry?.root) return
  entry.root.traverse(child => {
    if (!child.isMesh) return
    child.geometry?.disposeBoundsTree?.()
    child.geometry?.dispose?.()
    const material = child.material
    if (Array.isArray(material)) material.forEach(disposeMaterial)
    else disposeMaterial(material)
  })
  entry.meshes = []
  entry.root = null
}
