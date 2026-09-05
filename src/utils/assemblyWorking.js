// Persisting an unsaved fit so it survives leaving the page.
//
// A fit result used to live only in the session, which meant navigating away
// silently threw the work out. It now goes to disk as WORKING geometry: scratch
// state that belongs to the assembly, not an Asset. Saving a piece as a new
// version is still the separate, explicit step (useAssemblySave), and is still
// the only thing that produces something the rest of the app can see.
//
// ---- Why positions only, and not a GLB ------------------------------------
//
// The fit pipeline's wire contract already guarantees it never changes vertex
// count or order — that is what lets the result be applied as a position
// update onto the browser's own geometry, and it is why the textures survive a
// fit at all. Working files lean on the same invariant: they carry nothing but
// vertex positions, and everything else — UVs, materials, textures, submesh
// split, topology — is re-read from the source asset on load.
//
// The size difference is the whole argument. A 200k-vertex armour piece is
// 2.4 MB of positions; the same piece as a GLB with its 2k base-colour, normal
// and roughness maps is tens of megabytes, re-encoded on every sculpt stroke,
// and would route the geometry through an exporter that can degrade it. This
// format writes in one memcpy.
//
// ---- Why one file per piece ------------------------------------------------
//
// Because the edits are per piece. A fit runs on one piece at a time and a
// brush stroke touches exactly one, so a combined file would mean rewriting
// every piece's megabytes on each stroke. Per-piece also means removing a piece
// deletes one file, and a file that no longer matches its asset invalidates
// that piece alone instead of the assembly. They all live in one directory per
// assembly, so deleting the assembly is still a single recursive remove.
import { API_BASE } from '../config'

const MAGIC = 0x57443341            // 'A3DW' little-endian
const FORMAT_VERSION = 1

// The header is JSON so the format can gain fields without a version bump, and
// so a file is diagnosable with `head -c 200`.
const HEADER_OFFSET = 12            // magic + version + headerLength

/**
 * Is this machine little-endian?
 *
 * Positions are written as a raw Float32Array view — one memcpy, which is the
 * point of the format — and that is host-endian. Every platform this runs on is
 * little-endian, but a working file can travel to another machine through a
 * shared server, so the assumption is recorded and checked rather than hoped
 * for. A big-endian reader discards the file and refits; it never renders
 * scrambled vertices.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/**
 * Pack a piece's current preview positions.
 *
 * `meshes` are the preview's meshes IN PAYLOAD ORDER — the same order
 * buildFitPayloadGeometry produced, which is what makes the flat position run
 * reconstructible.
 */
export function encodeWorkingGeometry({ sourceUrl, meshes }) {
  const counts = []
  let total = 0
  for (const mesh of meshes) {
    const attribute = mesh.geometry?.getAttribute('position')
    if (!attribute) continue
    counts.push(attribute.count)
    total += attribute.count
  }
  if (!total) return null

  const header = JSON.stringify({
    // What these positions were computed FROM. Re-point the piece at a
    // different asset and the file is stale by definition, so this is the check
    // that stops a stale run of vertices being pasted onto a different mesh.
    sourceUrl: sourceUrl || '',
    vertexCount: total,
    meshes: counts,
    littleEndian: LITTLE_ENDIAN,
    savedAt: Date.now(),
  })
  const headerBytes = new TextEncoder().encode(header)
  // Float32 reads must be 4-byte aligned, so the header is padded to a
  // boundary. Without this the positions view throws on some inputs and not
  // others, purely on header length — the kind of bug that looks random.
  const padded = (headerBytes.length + 3) & ~3

  const buffer = new ArrayBuffer(HEADER_OFFSET + padded + total * 3 * 4)
  const view = new DataView(buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, FORMAT_VERSION, true)
  view.setUint32(8, padded, true)
  new Uint8Array(buffer, HEADER_OFFSET, headerBytes.length).set(headerBytes)

  const positions = new Float32Array(buffer, HEADER_OFFSET + padded, total * 3)
  let cursor = 0
  for (const mesh of meshes) {
    const attribute = mesh.geometry?.getAttribute('position')
    if (!attribute) continue
    positions.set(attribute.array.subarray(0, attribute.count * 3), cursor)
    cursor += attribute.count * 3
  }
  return buffer
}

/**
 * Unpack a working file, or return null when it cannot be trusted.
 *
 * Null is a normal outcome, not an error: the asset was re-pointed, the piece
 * was re-saved with different topology, the format moved on. The caller drops
 * the file and shows the unfitted mesh, which is recoverable. Pasting a
 * mismatched run of vertices onto a mesh is not.
 */
export function decodeWorkingGeometry(buffer, { sourceUrl, vertexCount } = {}) {
  if (!buffer || buffer.byteLength < HEADER_OFFSET) return null
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== MAGIC) return null
  if (view.getUint32(4, true) !== FORMAT_VERSION) return null

  const headerLength = view.getUint32(8, true)
  if (headerLength <= 0 || HEADER_OFFSET + headerLength > buffer.byteLength) return null

  let header
  try {
    header = JSON.parse(new TextDecoder().decode(
      new Uint8Array(buffer, HEADER_OFFSET, headerLength)).replace(/\0+$/, ''))
  } catch {
    return null
  }

  if (header.littleEndian !== LITTLE_ENDIAN) return null
  if (sourceUrl !== undefined && header.sourceUrl !== sourceUrl) return null
  if (vertexCount !== undefined && header.vertexCount !== vertexCount) return null

  const floats = header.vertexCount * 3
  const start = HEADER_OFFSET + headerLength
  if (buffer.byteLength - start < floats * 4) return null

  return { positions: new Float32Array(buffer, start, floats), header }
}

// ---- Transport -------------------------------------------------------------
//
// Under /api/mesh-assemblies, so these follow the document to a shared server
// through the same allowlist entry — working geometry belongs with the
// assembly, not with whichever machine happened to run the fit.

const geometryUrl = (assemblyId, pieceId) =>
  `${API_BASE}/mesh-assemblies/${assemblyId}/geometry/${encodeURIComponent(pieceId)}`

/**
 * The piece ids that have stored geometry.
 *
 * The directory is the authority, not the document. A per-piece flag in the
 * document would be two things that must agree, written at different moments —
 * and a write that lands while the page is unmounting would leave a file no
 * reload ever goes looking for. Asking cannot drift.
 */
export async function listWorkingGeometry(assemblyId) {
  const response = await fetch(`${API_BASE}/mesh-assemblies/${assemblyId}/geometry`)
  if (!response.ok) return []
  return (await response.json())?.pieces || []
}

export async function putWorkingGeometry(assemblyId, pieceId, buffer) {
  const response = await fetch(geometryUrl(assemblyId, pieceId), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  })
  if (!response.ok) {
    let message = `Could not store the fitted geometry (${response.status})`
    try { message = (await response.json())?.error || message } catch { /* keep it */ }
    throw new Error(message)
  }
  return response.json()
}

/** The raw bytes, or null when this piece has none stored. */
export async function fetchWorkingGeometry(assemblyId, pieceId) {
  const response = await fetch(geometryUrl(assemblyId, pieceId))
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Could not read the fitted geometry (${response.status})`)
  return response.arrayBuffer()
}

/** Best-effort: a working file left behind is wasted disk, never wrong output. */
export async function deleteWorkingGeometry(assemblyId, pieceId) {
  try {
    await fetch(geometryUrl(assemblyId, pieceId), { method: 'DELETE' })
  } catch (error) {
    console.warn('Could not remove the stored fit for this piece', error)
  }
}
