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
 * Fold a world-space matrix into a piece's own TRS.
 *
 * What makes a rigid seating a PLACEMENT rather than an edit. The stage returns
 * a similarity transform, and applying it here means the piece stays
 * un-deformed, the numeric panel shows where it actually is, and undo works
 * through the document like any other move — where baking it into vertices
 * would turn "the armour was seated" into "the armour is now a modified mesh".
 *
 * `mirrorX` is divided out before decomposing and put back afterwards. It has
 * to be: Matrix4.decompose normalises a negative determinant onto ONE axis of
 * its choosing, so decomposing a mirrored placement directly moves the mirror
 * to whichever axis it picks and silently reflects the piece differently.
 */
export function applyMatrixToPiece(piece, elements) {
  const world = new THREE.Matrix4().fromArray(elements)
  const next = world.multiply(composePieceMatrix(piece, new THREE.Matrix4()))
  if (piece.mirrorX) next.multiply(_mirror)      // _mirror is its own inverse

  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  next.decompose(position, quaternion, scale)

  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
  return {
    position: position.toArray(),
    rotation: [euler.x, euler.y, euler.z],
    scale: scale.toArray(),
  }
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

  return {
    root, meshes, localBox, vertexCount, faceCount: Math.round(faceCount), hasSkin,
    // Only ever read from the BASE, and only by the merged export.
    animations: root.animations || [],
  }
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

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Regions of the base body a piece can be fitted to.
 *
 * These are FIXED FRACTIONAL BANDS of the base's bounding box, not anatomy
 * detection — head is the top 13% of its height, and so on. That is a
 * deliberate trade: it is one small pure function, it is explainable to the user
 * ("the top eighth of the body"), and its answer is a STARTING POINT they then
 * nudge with the gizmo. It is not a claim about where the head actually is.
 *
 * It does assume the base is Y-up and roughly A- or T-posed, which is what this
 * app's generators produce. A curled-up or Z-up body gives nonsense, and the
 * honest answer there is to pick `whole` and align by hand.
 */
export const FIT_REGIONS = ['whole', 'head', 'torso', 'hands', 'feet']

export const FIT_REGION_LABELS = {
  whole: 'Whole body',
  head: 'Head',
  torso: 'Torso',
  hands: 'Hands',
  feet: 'Feet',
}

// [yMin, yMax] as fractions of the base's height, measured from its bottom.
const REGION_BANDS = {
  whole: [0, 1],
  head: [0.87, 1],
  torso: [0.3, 0.7],
  hands: [0.4, 0.65],
  feet: [0, 0.1],
}

// Fraction of the base's WIDTH kept on one side, for regions that are a
// left/right pair rather than a single volume.
const HAND_SIDE_FRACTION = 0.18

/**
 * The box for one region of `baseBox`.
 *
 * `referencePoint` disambiguates the paired regions: a gauntlet fits to the hand
 * on its OWN side, decided by which side of the body it currently sits on.
 * Without it, "hands" would be two disjoint volumes with no way to choose.
 */
export function baseRegionBox(baseBox, region, { referencePoint = null } = {}) {
  if (!baseBox || baseBox.isEmpty()) return new THREE.Box3().makeEmpty()
  if (region === 'whole' || !REGION_BANDS[region]) return baseBox.clone()

  const box = baseBox.clone()
  const size = baseBox.getSize(new THREE.Vector3())
  const [low, high] = REGION_BANDS[region]

  box.min.y = baseBox.min.y + size.y * low
  box.max.y = baseBox.min.y + size.y * high

  if (region === 'hands') {
    const slab = size.x * HAND_SIDE_FRACTION
    const centre = baseBox.getCenter(new THREE.Vector3())
    // Defaults to +X so the result is deterministic with no reference given.
    const rightSide = !referencePoint || referencePoint.x >= centre.x
    if (rightSide) box.min.x = baseBox.max.x - slab
    else box.max.x = baseBox.min.x + slab
  }

  return box
}

/**
 * Scale and translate `piece` so it occupies `regionBox` — the one click that
 * addresses the actual complaint, that an AI-generated garment is nowhere near
 * the body's size.
 *
 * Returns a `{ position, scale }` patch, or null when it cannot be computed.
 *
 * `axes: 'uniform'` keeps the piece's proportions (right for anything whose
 * shape carries meaning); `'xyz'` stretches per axis to fill the region, which
 * distorts and is only occasionally wanted.
 *
 * The order here is not interchangeable: scale is resolved FIRST, the box is
 * re-measured, and only then is the translation computed. Scaling happens about
 * the piece's own origin and therefore MOVES its box, so solving for the
 * position against the pre-scale box would leave the piece offset by however far
 * the scale shifted it.
 */
export function fitPieceToRegion(piece, entry, regionBox, { axes = 'uniform' } = {}) {
  if (!entry?.localBox || entry.localBox.isEmpty()) return null
  if (!regionBox || regionBox.isEmpty()) return null

  const current = pieceWorldBox(entry, piece)
  if (current.isEmpty()) return null

  const currentSize = current.getSize(new THREE.Vector3())
  const regionSize = regionBox.getSize(new THREE.Vector3())
  let scale = [...piece.scale]

  if (axes === 'xyz') {
    scale = scale.map((value, index) => {
      const from = currentSize.getComponent(index)
      const to = regionSize.getComponent(index)
      return from > 1e-9 ? value * (to / from) : value
    })
  } else {
    const from = currentSize.length()
    const to = regionSize.length()
    if (from > 1e-9) {
      const factor = to / from
      scale = scale.map(value => value * factor)
    }
  }

  // Re-measure with the new scale before solving for the translation.
  const scaled = pieceWorldBox(entry, { ...piece, scale })
  if (scaled.isEmpty()) return null

  const delta = regionBox.getCenter(new THREE.Vector3()).sub(scaled.getCenter(new THREE.Vector3()))
  return {
    position: [
      piece.position[0] + delta.x,
      piece.position[1] + delta.y,
      piece.position[2] + delta.z,
    ],
    scale,
  }
}

/** Translate `piece` so its box centre lands on `regionBox`'s, size untouched. */
export function movePieceToRegion(piece, entry, regionBox) {
  if (!regionBox || regionBox.isEmpty()) return null
  const current = pieceWorldBox(entry, piece)
  if (current.isEmpty()) return null
  const delta = regionBox.getCenter(new THREE.Vector3()).sub(current.getCenter(new THREE.Vector3()))
  return {
    position: [
      piece.position[0] + delta.x,
      piece.position[1] + delta.y,
      piece.position[2] + delta.z,
    ],
  }
}

/**
 * Drop `piece` straight down until it rests on the base — or on the ground
 * plane when it misses — with `offset` of clearance.
 *
 * A downward ray from the box centre, not a nearest-surface query: "drop" has to
 * be predictable, and gravity is the mental model. Snapping to the nearest
 * surface would pull the piece sideways, which reads as the tool moving
 * something the user did not ask it to move.
 *
 * Needs the base's BVH, so callers must ensurePieceBvh(baseEntry) first.
 */
export function dropPieceToSurface(piece, entry, baseEntry, basePiece, { offset = 0 } = {}) {
  const current = pieceWorldBox(entry, piece)
  if (current.isEmpty()) return null

  const centre = current.getCenter(new THREE.Vector3())
  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(centre.x, current.max.y + 1e-3, centre.z),
    new THREE.Vector3(0, -1, 0),
  )
  raycaster.firstHitOnly = true

  let landingY = 0   // the grid, when there is nothing below
  if (baseEntry?.root && basePiece) {
    baseEntry.root.matrix.copy(composePieceMatrix(basePiece))
    baseEntry.root.matrixAutoUpdate = false
    baseEntry.root.updateMatrixWorld(true)
    const hits = raycaster.intersectObject(baseEntry.root, true)
    // Discard hits at or above the piece's own top: those are the base's far
    // side seen from inside it, and landing on one would launch the piece up.
    const below = hits.find(hit => hit.point.y < current.max.y - 1e-6)
    if (below) landingY = below.point.y
  }

  const targetMinY = landingY + offset
  return {
    position: [
      piece.position[0],
      piece.position[1] + (targetMinY - current.min.y),
      piece.position[2],
    ],
  }
}

/**
 * Reflect `piece` across the base's centre plane in X, for building a left/right
 * pair: `mirrorX` flips its geometry and its position mirrors about the body.
 *
 * Rotation about Y and Z is negated because those turn INTO the reflected axis.
 * Rotation about X is unaffected by a reflection in X, so it is left alone.
 */
export function mirrorPieceAcrossBase(piece, baseBox) {
  const centreX = baseBox && !baseBox.isEmpty() ? baseBox.getCenter(new THREE.Vector3()).x : 0
  return {
    mirrorX: !piece.mirrorX,
    position: [2 * centreX - piece.position[0], piece.position[1], piece.position[2]],
    rotation: [piece.rotation[0], -piece.rotation[1], -piece.rotation[2]],
  }
}
