// Deleting the body faces the armour hides.
//
// A fully-armoured character carries a whole body's worth of triangles nobody
// will ever see. This asks the service which of the base's faces are completely
// occluded and drops them from the merged export.
//
// The base asset itself is never touched — like every other assembly operation,
// this only shapes what gets saved.
//
// ---- Why a mask comes back, not a mesh --------------------------------------
//
// Deleting faces changes the vertex count, which the positions-only contract
// the fit is built on cannot express. More decisively, the base is usually
// RIGGED, and trimesh cannot carry skinIndex/skinWeight through a load at all —
// a body round-tripped through Python would come back unskinned. So Python
// answers with one byte per face and the geometry never leaves the browser.
import * as THREE from 'three'
import { API_BASE } from '../config'
import { buildFitPayloadGeometry, payloadToGlb } from './assemblyFit'
import { ensureDesktopService, readSseStream } from './meshTools'

export const DEFAULT_HIDDEN_FACE_OPTIONS = {
  rays: 16,
  max_distance_ratio: 0.08,
  erode_rings: 1,
  device: 'auto',
}

/**
 * One GLB containing every occluding piece, in world space.
 *
 * Concatenated rather than sent per piece: the question is whether a body face
 * is hidden by the armour AS A WHOLE. Asking each piece separately would keep
 * every face that no single piece hides on its own — precisely the shoulder
 * covered half by a pauldron and half by a chest plate.
 */
/**
 * What the exporter will actually write for a piece: its preview when it has
 * one, otherwise its loaded mesh.
 *
 * This has to be the SAME choice buildGroup makes, and for the same objects.
 * Keying the mask by the loaded meshes while the exporter iterated the preview's
 * meshes is what made the first version a silent no-op: every lookup missed, and
 * a body with a stored fit — which is to say, always — kept every face.
 *
 * A preview's positions are world-space already, so it takes no placement; an
 * unedited piece needs its placement applied. Returning both together keeps the
 * two decisions from drifting apart.
 */
function drawnSource({ piece, entry, preview }) {
  return preview?.meshes?.length
    ? { source: preview, placement: null }
    : { source: entry, placement: piece }
}

async function buildOccluderGlb(entries) {
  const positions = []
  const indices = []
  let vertexBase = 0

  for (const item of entries) {
    const { source, placement } = drawnSource(item)
    if (!source?.meshes?.length) continue
    const payload = buildFitPayloadGeometry(source, placement)
    for (let i = 0; i < payload.positions.length; i += 1) positions.push(payload.positions[i])
    for (let i = 0; i < payload.indices.length; i += 1) indices.push(payload.indices[i] + vertexBase)
    vertexBase += payload.vertexCount
  }

  if (!indices.length) return null

  return payloadToGlb(
    { positions: new Float32Array(positions), indices: new Uint32Array(indices) },
    'occluders')
}

/**
 * Ask which of the base's faces the occluders hide.
 *
 * Returns `{ masks, stats }` where `masks` is a Map from the base's own
 * THREE.Mesh objects to a Uint8Array over that submesh's faces — keyed by the
 * mesh itself so the exporter, which iterates those same objects, needs no
 * index bookkeeping of its own.
 */
export async function findHiddenBaseFaces({
  base, occluders, options = {}, onProgress, signal,
}) {
  const { source: baseSource, placement } = drawnSource(base)
  if (!baseSource?.meshes?.length) return null
  const occluderFile = await buildOccluderGlb(occluders)
  if (!occluderFile) return null

  // Measured against what will be EXPORTED, not the source asset: the body may
  // itself have been fitted or sculpted, and occlusion depends on where its
  // surface actually is.
  const payload = buildFitPayloadGeometry(baseSource, placement)
  const bodyFile = await payloadToGlb(payload, 'body')

  await ensureDesktopService('meshtools')

  const form = new FormData()
  form.append('meshFile', bodyFile)          // the BODY — the thing being modified
  form.append('sourceFile', occluderFile)    // everything that occludes it
  form.append('options', JSON.stringify({ ...DEFAULT_HIDDEN_FACE_OPTIONS, ...options }))

  const response = await fetch(`${API_BASE}/meshes/hidden-faces`, {
    method: 'POST', body: form, signal,
  })
  if (!response.ok) {
    let message = `Could not find the hidden faces (${response.status})`
    try {
      const body = await response.json()
      message = body.detail ? `${body.error}: ${body.detail}` : (body.error || message)
    } catch { /* non-JSON body — keep the status message */ }
    throw new Error(message)
  }

  const done = await readSseStream(response, onProgress)
  if (done.format !== 'face_mask' || !done.mask_b64) {
    throw new Error('The hidden-face search returned an unexpected result.')
  }

  const binary = atob(done.mask_b64)
  const flat = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) flat[i] = binary.charCodeAt(i)

  if (flat.length !== payload.faceCount) {
    throw new Error(
      `The hidden-face mask covers ${flat.length} faces, expected ${payload.faceCount}.`)
  }

  // Split back onto the submeshes it came from.
  const masks = new Map()
  for (const range of payload.faceRanges) {
    masks.set(range.mesh, flat.subarray(range.start, range.start + range.count))
  }
  return { masks, stats: done.stats || {}, hidden: flat.reduce((sum, v) => sum + v, 0) }
}

/**
 * A copy of `geometry` with the masked faces removed.
 *
 * Unreferenced vertices are deliberately LEFT IN PLACE. Compacting them would
 * mean remapping every attribute — including skinIndex/skinWeight, which is the
 * whole reason this runs in the browser — for a saving the GLB exporter mostly
 * recovers anyway. The face count is what was being reduced.
 */
export function removeMaskedFaces(geometry, mask) {
  if (!mask || !mask.length) return geometry

  const index = geometry.getIndex()
  const count = geometry.getAttribute('position').count
  const get = index ? i => index.getX(i) : i => i
  const faces = index ? index.count / 3 : count / 3

  const kept = []
  for (let face = 0; face < faces; face += 1) {
    if (mask[face]) continue
    kept.push(get(face * 3), get(face * 3 + 1), get(face * 3 + 2))
  }

  // An empty index rather than null when everything is removed: null would mean
  // "non-indexed", i.e. draw every vertex, which is the exact opposite.
  const out = geometry.clone()
  out.setIndex(new THREE.BufferAttribute(
    count > 65535 ? new Uint32Array(kept) : new Uint16Array(kept), 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}
