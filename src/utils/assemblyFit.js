// Client for the assembly fit service (/api/meshes/fit).
//
// The wire contract is POSITIONS, not a mesh, and that shapes this whole file.
//
// The fit never changes the piece's vertex count or order, so the service
// returns only the new coordinates and this module writes them back onto CLONES
// of the piece's own geometries. UVs, materials, textures, submesh structure and
// skinning therefore never leave the browser. Returning a GLB instead would
// route the piece back through trimesh, whose loader concatenates a
// multi-material mesh into one and cannot represent skinning at all — a fitted
// piece would come back materially degraded.
import * as THREE from 'three'
import { API_BASE } from '../config'
import { ensureDesktopService, readSseStream } from './meshTools'
import { dequantizeGeometryAttributes } from './meshEditor'
import { composePieceMatrix, pieceWorldBox } from './assemblyGeometry'

// Mirrors python-server/app/schemas.py FitOptions. Keep the two in step.
export const DEFAULT_FIT_OPTIONS = {
  // Penetration only by default. Conforming is opt-in until it stops flattening
  // thick pieces — see the note above MATERIAL_CLASS_PRESETS in assemblyHelpers.js.
  stages: ['penetration'],
  offset: 0.004,
  iterations: 20,
  tolerance: 0.02,
  vote_rounds: 2,
  smooth_rounds: 2,
  smooth_alpha: 0.45,
  step_clamp: 0.5,
  lock_vertical: true,
  preserve_centroid: true,
  field_centres: 400,
  field_smoothing: 1.0,
  strength: 1.0,
  flip_abort_frac: 0.01,
  min_thickness: 0,
  rebuild_shell: false,
  max_distance_ratio: 0.25,
  body_face_budget: 60000,
  device: 'auto',
}

export const FIT_STAGE_LABELS = {
  rigid: 'Seat on the body',
  warp: 'Match the landmarks',
  shrinkwrap: 'Reshape to the body',
  penetration: 'Push out of the body',
}

export const FIT_STAGE_HINTS = {
  warp: 'Bends the piece so each landmark pair meets — the only stage that can '
    + 'correct PROPORTIONS, like a sleeve cut for a longer arm. Needs at least four '
    + 'pairs, SPREAD in all three directions: pairs in a line down the piece leave '
    + 'the warp unconstrained sideways, and it refuses rather than mangling it. '
    + 'Everything far from a landmark fades back to where you put it.',
  rigid: 'Moves, turns and resizes the piece as one solid object until it stops '
    + 'clipping into the body. Never deforms it, so plate keeps its edges — and '
    + 'because the result is a placement, it shows up in the transform fields and '
    + 'undoes like any move. A piece that is already clear is left exactly where you '
    + 'put it, including the gap you left inside it. It will not shrink a piece that '
    + 'is merely too big — use Fit to region for that.',
  shrinkwrap: 'Reshapes the whole piece toward the body. Experimental: on a thick '
    + 'piece it currently flattens it and can invert faces.',
  penetration: 'Only moves what is inside the body. Fixes clipping, keeps the shape, '
    + 'and leaves the piece where you placed it.',
}

const _matrix = new THREE.Matrix4()

/**
 * Build the payload geometry for one placed piece.
 *
 * Returns `{ positions, indices, ranges }` in WORLD space, where `ranges` maps
 * each display submesh to its slice of the vertex array so the result can be
 * scattered back.
 *
 * Deliberately NOT welded, and deliberately not `createMergedGeometryFromObject`
 * (utils/meshEditor.js): that helper welds with mergeVertices, which reorders
 * vertices and would destroy the mapping back to the piece's own geometries —
 * and with it the UVs. The service welds internally for its graph work and
 * scatters back, so it does not need us to.
 *
 * Positions are read through `dequantizeGeometryAttributes` because
 * KHR_mesh_quantization is common in AI-generated GLBs: such a mesh RENDERS
 * correctly (the decoding scale lives on its node) while its raw `position`
 * attribute is Int16. Reading it directly would send integer garbage, and only
 * for some assets, which reads as randomness.
 */
/**
 * Which of a piece's meshes go into a payload, and where each one's vertices
 * land in the flat run — WITHOUT building the payload.
 *
 * Restoring a stored fit needs exactly this and nothing else: the positions
 * come from the file, so cloning every geometry and re-transforming it just to
 * learn the offsets would be pure waste on a 200k-vertex piece.
 *
 * It is a separate function rather than a second copy of the loop because the
 * two must agree about which meshes are skipped and in what order. If they ever
 * disagreed, a restore would paste one mesh's vertices onto another — visible
 * as a piece exploding on load, and only for multi-submesh assets.
 */
/**
 * Landmark pairs in the SHARED WORLD SPACE both meshes are uploaded in.
 *
 * Stored per-mesh-local so that moving either mesh never invalidates a pair;
 * converted here, deliberately in the same module that bakes the placement into
 * the uploaded GLB. If these two ever disagreed about which space they are in,
 * the warp would pull the piece toward a point that is nowhere near where the
 * user clicked — and it would look like a bad spline rather than a bad space.
 *
 * `piece` must be the placement the PAYLOAD was built from. After a rigid seat
 * that is the seated piece, not the one the user last saw.
 */
export function buildLandmarkPayload(piece, base) {
  if (!piece || !base) return []
  const pieceMatrix = composePieceMatrix(piece, new THREE.Matrix4())
  const baseMatrix = composePieceMatrix(base, new THREE.Matrix4())
  const point = (landmark, matrix) =>
    new THREE.Vector3(...landmark.point).applyMatrix4(matrix).toArray()

  return (piece.landmarks || [])
    .filter(pair => pair.base && pair.piece)
    .map(pair => ({
      piece: point(pair.piece, pieceMatrix),
      body: point(pair.base, baseMatrix),
    }))
}

export function buildFitRanges(entry) {
  const ranges = []
  let vertexTotal = 0
  for (const mesh of entry.meshes) {
    const position = mesh.geometry?.getAttribute('position')
    if (!position) continue
    ranges.push({ mesh, start: vertexTotal, count: position.count })
    vertexTotal += position.count
  }
  return { ranges, vertexCount: vertexTotal }
}

export function buildFitPayloadGeometry(entry, piece) {
  const placement = piece ? composePieceMatrix(piece, _matrix.clone()) : new THREE.Matrix4()

  const chunks = []
  let vertexTotal = 0
  let indexTotal = 0

  for (const mesh of entry.meshes) {
    const source = mesh.geometry
    // Same skip rule as buildFitRanges — keep the two in step.
    if (!source?.getAttribute('position')) continue

    const geometry = source.clone()
    dequantizeGeometryAttributes(geometry)

    // World = placement * (the submesh's transform RELATIVE TO THE PIECE ROOT).
    //
    // That relative matrix has to be derived, not read: `mesh.matrixWorld` is
    // the mesh's transform in the SCENE, and the root is mounted inside the
    // <group matrix={placement}> that positions the piece — so matrixWorld
    // already contains the placement. Multiplying by it again applied the
    // placement TWICE and uploaded the piece at roughly double its offset
    // (a chest piece arrived at head height), where the service then fitted it
    // perfectly to the wrong part of the body.
    //
    // Going through the root's inverse makes this independent of where the root
    // happens to sit in the scene graph, which is the only way it can be
    // correct both while mounted and while not.
    entry.root.updateMatrixWorld(true)
    mesh.updateMatrixWorld(true)
    const meshToRoot = new THREE.Matrix4()
      .copy(entry.root.matrixWorld).invert()
      .multiply(mesh.matrixWorld)
    const toWorld = placement.clone().multiply(meshToRoot)
    geometry.applyMatrix4(toWorld)

    const position = geometry.getAttribute('position')
    const index = geometry.getIndex()
    const count = position.count
    const triangleIndices = index
      ? Array.from(index.array)
      // Non-indexed geometry is an implicit 0,1,2,... triangle list.
      : Array.from({ length: count }, (_, i) => i)

    chunks.push({ mesh, geometry, position, triangleIndices, start: vertexTotal, count })
    vertexTotal += count
    indexTotal += triangleIndices.length
  }

  if (!vertexTotal) throw new Error('That piece has no geometry to fit.')

  const positions = new Float32Array(vertexTotal * 3)
  const indices = new Uint32Array(indexTotal)
  let indexCursor = 0

  for (const chunk of chunks) {
    positions.set(chunk.position.array.subarray(0, chunk.count * 3), chunk.start * 3)
    for (const value of chunk.triangleIndices) {
      indices[indexCursor] = value + chunk.start
      indexCursor += 1
    }
    // The clone was scratch for the transform; the payload owns its own copy.
    chunk.geometry.dispose()
  }

  // The payload must occupy the same world space the viewport draws the piece
  // in. Checked rather than assumed, because getting it wrong is SILENT: the
  // service happily fits whatever it is given, and the only symptom is a
  // perfectly-fitted piece attached to the wrong part of the body.
  if (piece && entry.localBox && !entry.localBox.isEmpty()) {
    const expected = pieceWorldBox(entry, piece)
    const built = new THREE.Box3().setFromArray(positions)
    const drift = built.getCenter(new THREE.Vector3())
      .distanceTo(expected.getCenter(new THREE.Vector3()))
    const scale = Math.max(expected.getSize(new THREE.Vector3()).length(), 1e-6)
    if (drift > scale * 0.05) {
      throw new Error(
        `Internal error: the fit payload is in the wrong space (off by ${drift.toFixed(4)}). `
        + 'Fitting was stopped rather than reshaping the piece against the wrong place.')
    }
  }

  return {
    positions,
    indices,
    ranges: chunks.map(chunk => ({ mesh: chunk.mesh, start: chunk.start, count: chunk.count })),
    vertexCount: vertexTotal,
  }
}

/** A minimal GLB carrying just position + index — all the service reads. */
export async function payloadToGlb(payload, name) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(payload.positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(payload.indices, 1))

  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
  const buffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(mesh, resolve, reject, { binary: true })
  })
  geometry.dispose()
  mesh.material.dispose()
  return new File([buffer], `${name}.glb`, { type: 'model/gltf-binary' })
}

/**
 * Run the fit for one piece against one base.
 *
 * Mirrors bakeMaps in utils/meshTools.js rather than callMeshTool, because of
 * the two-file form AND because the terminal event carries `positions_b64`
 * instead of `mesh_b64` — callMeshTool's decode path assumes a mesh.
 */
export async function fitPiece({ pieceFile, baseFile, options, onProgress, signal }) {
  await ensureDesktopService('meshtools')

  const form = new FormData()
  form.append('meshFile', pieceFile)     // the PIECE — the thing being modified
  form.append('sourceFile', baseFile)    // the BASE body it is fitted to
  form.append('options', JSON.stringify({ ...DEFAULT_FIT_OPTIONS, ...options }))

  const response = await fetch(`${API_BASE}/meshes/fit`, { method: 'POST', body: form, signal })
  if (!response.ok) {
    let message = `Fit failed (${response.status})`
    try {
      const payload = await response.json()
      message = payload.detail
        ? `${payload.error}: ${typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail)}`
        : (payload.error || message)
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message)
  }

  const done = await readSseStream(response, onProgress)
  if (done.format !== 'positions' || !done.positions_b64) {
    throw new Error('The fit service returned an unexpected result.')
  }

  const binary = atob(done.positions_b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const positions = new Float32Array(bytes.buffer)

  if (positions.length !== done.count * 3) {
    throw new Error(`The fit returned ${positions.length / 3} vertices, expected ${done.count}.`)
  }
  // `transform` is the rigid stage's similarity matrix, or null. Positions are
  // always authoritative; this exists so a rigid-ONLY run can be folded into
  // the piece's placement rather than becoming a mesh edit.
  return { positions, transform: done.transform || null, stats: done.stats || {} }
}

/**
 * Build the preview graph from the fitted positions.
 *
 * One mesh per original submesh, each with a CLONE of its geometry whose
 * `position` is overwritten from the result. Everything else — uv, normal
 * source, skinning attributes, groups — comes along in the clone untouched,
 * which is the entire point of the positions-only contract.
 *
 * The positions are already in world space, so the preview renders with an
 * IDENTITY matrix while the original renders with its placement. Easiest thing
 * in the feature to get backwards; AssemblyPieceMesh takes `matrix` explicitly
 * for that reason.
 */
export function buildFitPreview(payload, positions) {
  const group = new THREE.Group()
  group.name = 'assembly-fit-preview'

  for (const range of payload.ranges) {
    const geometry = range.mesh.geometry.clone()
    dequantizeGeometryAttributes(geometry)

    const slice = positions.subarray(range.start * 3, (range.start + range.count) * 3)
    const attribute = geometry.getAttribute('position')
    if (attribute.count !== range.count) {
      throw new Error('The fit result does not line up with the piece geometry.')
    }
    attribute.array.set(slice)
    attribute.needsUpdate = true

    // Recompute normals ONLY if the source had them.
    //
    // A glTF primitive with no NORMAL attribute is flat-shaded by spec, and
    // three implements that by setting `material.flatShading = true` on load
    // (GLTFLoader: `useFlatShading = geometry.attributes.normal === undefined`).
    // Adding a smooth normal attribute here would give the fitted piece a
    // different shading model from the original it is meant to be a preview of
    // — and these AI-generated meshes frequently ship without normals.
    //
    // Where they DO exist the vertices have moved, so the file's normals now
    // describe the old shape and must be recomputed.
    if (geometry.getAttribute('normal')) geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()

    // Material is BORROWED from the original, not cloned: it carries the
    // textures, and cloning would double their GPU footprint. The preview must
    // therefore never dispose materials — see disposeFitPreview.
    const mesh = new THREE.Mesh(geometry, range.mesh.material)
    mesh.frustumCulled = false
    group.add(mesh)
  }

  const box = new THREE.Box3().setFromObject(group)
  return { root: group, meshes: group.children.slice(), localBox: box, bvhBuilt: false }
}

/**
 * A preview of the piece exactly as placed — no fitting applied.
 *
 * Lets sculpting work on a piece that has never been fitted, without a second
 * notion of "edited geometry": the preview is the piece's current edited shape
 * whether that shape came from a fit, from sculpting, or from both.
 */
export function createPreviewFromPiece(entry, piece) {
  const payload = buildFitPayloadGeometry(entry, piece)
  return { ...buildFitPreview(payload, payload.positions), payload }
}

/**
 * Release a preview. Disposes the geometries it created and NOTHING else —
 * its materials and textures belong to the piece it was previewing.
 */
export function disposeFitPreview(preview) {
  if (!preview?.root) return
  for (const mesh of preview.root.children) {
    mesh.geometry?.disposeBoundsTree?.()
    mesh.geometry?.dispose?.()
  }
  preview.root.clear()
  preview.root = null
  preview.meshes = []
}
