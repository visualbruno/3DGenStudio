// Elastic Grab for the assembly workspace: pull the surface around by hand to
// fix what the automatic fit could not.
//
// This is Blender's "Elastic Grab", not its plain "Grab". Plain grab translates
// every vertex in a sphere rigidly, which leaves a visible disc of moved
// surface with a crease around it. Elastic grab instead evaluates the
// displacement an elastic SOLID would undergo if you pulled one point of it, so
// the surface stretches away smoothly with no boundary at all — which is what
// makes it usable for tidying a garment.
//
// The maths is a regularized Kelvinlet (de Goes & James, "Regularized
// Kelvinlets: Sculpting Brushes based on Fundamental Solutions of Elasticity",
// SIGGRAPH 2017). The regularization is what keeps it finite at the grab point;
// the raw Kelvinlet is singular there.
//
// Deliberately NOT built on utils/meshSculpt.js, even though that has a full
// brush engine. Two reasons, both structural:
//
//   * meshSculpt's context requires ONE indexed geometry, and an assembly piece
//     is often several submeshes. Merging them would need the same welding and
//     scatter-back machinery the fit payload uses.
//   * more importantly, this kernel does not need any of it. The displacement
//     depends only on a vertex's POSITION relative to the grab point, so
//     coincident vertices on either side of a UV seam or a submesh boundary
//     receive identical displacement and the seam cannot tear. Adjacency-based
//     brushes (smooth, pinch) do not have that property and would need the
//     welded path.
import * as THREE from 'three'

// Poisson ratio of the imaginary material. 0.5 would be perfectly
// incompressible; a little below that gives the surface some give, which reads
// as cloth rather than rubber.
export const DEFAULT_POISSON_RATIO = 0.4

// The Kelvinlet's regularisation, as a fraction of the brush radius. Smaller
// concentrates the pull near the cursor and leaves the rest of the ring barely
// touched; larger drags the whole ring more evenly. 0.35 gives a falloff close
// to Blender's default.
const EPSILON_RATIO = 0.35

/**
 * Kelvinlet coefficients for a given Poisson ratio.
 *
 * `a` folds in the shear modulus, which only scales the result — and the result
 * is normalized below anyway — so it is fixed at 1 and the material is
 * described entirely by `b`.
 */
function kelvinletCoefficients(poissonRatio) {
  const nu = Math.min(0.49, Math.max(0, poissonRatio))
  const a = 1
  const b = a / (4 * (1 - nu))
  // Displacement at the grab point itself, for a unit force, MINUS its 1/eps
  // factor — the caller multiplies that back in, because eps is not known here.
  //
  // Dropping the eps was a real bug: the response at r=0 is (1.5a - b)/eps, so
  // normalising by (1.5a - b) alone amplified every stroke by 1/eps. At a
  // 0.05-unit brush that is 20x, and nudging the mouse a few pixels threw the
  // mesh across the screen. A unit test with radius = 1 cannot see it, which is
  // exactly why one now runs at several radii.
  const centre = 1.5 * a - b
  return { a, b, centre }
}

/**
 * Apply one elastic-grab step.
 *
 * Always evaluated from `restPositions` — the positions as they were when the
 * stroke STARTED — using the total drag so far, never incrementally from the
 * current positions. Accumulating per-frame would make the result depend on
 * mouse sampling rate and drift as the cursor wanders, and there would be no
 * way back to the original shape without an undo. Recomputing from rest means
 * dragging back to where you started restores the surface exactly.
 *
 * `positions` and `restPositions` are flat xyz Float32Arrays of the same
 * length. Written in place, zero allocation, so this can run every pointer move.
 */
export function applyElasticGrab(positions, restPositions, {
  centre,          // THREE.Vector3, the grab point in the same space as positions
  drag,            // THREE.Vector3, total movement since the stroke began
  radius,
  strength = 1,
  poissonRatio = DEFAULT_POISSON_RATIO,
}) {
  // The brush RADIUS is the visible ring, and the deformation must die inside
  // it — a user sizing the ring is saying "affect this much". The Kelvinlet's
  // own regularisation eps is a fraction of it, which sets how peaked the
  // falloff is within the ring.
  const cutoff = Math.max(radius, 1e-6)
  const epsilon = cutoff * EPSILON_RATIO
  const { a, b, centre: centreResponse } = kelvinletCoefficients(poissonRatio)
  // ... and here the eps comes back in, so the grabbed point tracks the cursor
  // at any brush size.
  const scale = (strength * epsilon) / centreResponse

  const fx = drag.x * scale
  const fy = drag.y * scale
  const fz = drag.z * scale
  const cx = centre.x
  const cy = centre.y
  const cz = centre.z
  const eps2 = epsilon * epsilon

  // A true Kelvinlet has infinite support, so it must be cut off or every
  // stroke moves the whole mesh. Cut off AT THE RING, and taper with a window
  // reaching zero with ZERO SLOPE — a hard cut would leave a faint crease at
  // the boundary, the very artifact elastic grab exists to avoid.
  //
  // Cutting at 3x the ring (an earlier version) meant the brush quietly
  // affected nine times the area it drew, so on a piece only a few hundred
  // pixels across a single stroke moved the whole thing.
  const cutoff2 = cutoff * cutoff

  for (let i = 0; i < positions.length; i += 3) {
    const rx = restPositions[i] - cx
    const ry = restPositions[i + 1] - cy
    const rz = restPositions[i + 2] - cz
    const r2 = rx * rx + ry * ry + rz * rz
    if (r2 > cutoff2) {
      positions[i] = restPositions[i]
      positions[i + 1] = restPositions[i + 1]
      positions[i + 2] = restPositions[i + 2]
      continue
    }

    const re = Math.sqrt(r2 + eps2)
    const re3 = re * re * re

    // u(r) = [(a-b)/re + a*eps^2/(2*re^3)] f  +  [b/re^3] (r . f) r
    const linear = (a - b) / re + (a * eps2) / (2 * re3)
    const radial = (b / re3) * (rx * fx + ry * fy + rz * fz)

    const window = 1 - r2 / cutoff2
    const taper = window * window

    positions[i] = restPositions[i] + (linear * fx + radial * rx) * taper
    positions[i + 1] = restPositions[i + 1] + (linear * fy + radial * ry) * taper
    positions[i + 2] = restPositions[i + 2] + (linear * fz + radial * rz) * taper
  }
}

/** Snapshot every geometry's positions, so a stroke can be evaluated from rest. */
export function snapshotGeometryPositions(meshes) {
  return meshes.map(mesh => Float32Array.from(mesh.geometry.attributes.position.array))
}

export function restoreGeometryPositions(meshes, snapshot) {
  meshes.forEach((mesh, index) => {
    const attribute = mesh.geometry.attributes.position
    attribute.array.set(snapshot[index])
    attribute.needsUpdate = true
  })
}

/**
 * Run one grab step across every submesh of a piece.
 *
 * Each submesh is handled independently, which is safe precisely because the
 * kernel is position-based: two coincident vertices in different submeshes get
 * the same displacement, so the boundary between them cannot open up.
 */
export function grabPieceMeshes(meshes, snapshot, options) {
  meshes.forEach((mesh, index) => {
    const attribute = mesh.geometry.attributes.position
    applyElasticGrab(attribute.array, snapshot[index], options)
    attribute.needsUpdate = true
  })
}

/** Recompute normals and bounds after a stroke. Cheap enough to run on release. */
export function finishStroke(meshes) {
  for (const mesh of meshes) {
    // Only where the source actually had normals — see the note in
    // buildFitPreview. Adding them to a mesh authored without them switches it
    // from flat to smooth shading and makes the edit look like a texture bug.
    if (mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals()
    mesh.geometry.computeBoundingBox()
    mesh.geometry.computeBoundingSphere()
    // The BVH is now stale. Dropped rather than refit: picking rebuilds it
    // lazily, and refitting after every stroke would cost more than it saves.
    mesh.geometry.disposeBoundsTree?.()
  }
}

/**
 * Where the cursor is in 3D, for the current drag.
 *
 * Projected onto the plane through the grab point facing the camera, which is
 * what makes a drag follow the mouse rather than sliding along the surface.
 */
const _plane = new THREE.Plane()
const _normal = new THREE.Vector3()
const _hit = new THREE.Vector3()

export function dragPointOnViewPlane(raycaster, camera, grabPoint) {
  camera.getWorldDirection(_normal)
  _plane.setFromNormalAndCoplanarPoint(_normal, grabPoint)
  return raycaster.ray.intersectPlane(_plane, _hit) ? _hit.clone() : null
}
