// Client for the procedural tree generator (/api/tree/*).
//
// The design the rest of the UI depends on: the TREE IS THE SPEC. A ~2KB seeded
// JSON document regenerates the mesh exactly, so re-rolling a seed or nudging a
// slider never needs the previous mesh, and the thing worth saving as an asset
// is the spec — the GLB is a derived output.
//
// Two request paths, deliberately asymmetric:
//   previewTree()  skeleton polylines only, ~100ms, safe to fire while a slider
//                  is being dragged.
//   generateTree() the full mesh over the same SSE contract the other mesh
//                  tools use, only on commit.
import { API_BASE } from '../config'
import { ensureDesktopService, readSseStream } from './meshTools'

// Decode a base64 string into a Blob of the given MIME type.
function base64ToBlob(base64, type) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type })
}

async function readError(response, fallback) {
  let message = `${fallback} (${response.status})`
  try {
    const payload = await response.json()
    message = payload.detail
      ? `${payload.error}: ${typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail)}`
      : (payload.error || message)
  } catch {
    // non-JSON error body — keep the status message
  }
  return new Error(message)
}

// The shipped species. Each entry carries its complete resolved spec, so the
// panel can populate every slider from a preset without a second round trip.
export async function fetchTreePresets({ signal } = {}) {
  await ensureDesktopService('meshtools')
  const response = await fetch(`${API_BASE}/tree/presets`, { signal })
  if (!response.ok) throw await readError(response, 'Could not load tree presets')
  const data = await response.json()
  return data.presets || []
}

// Skeleton polylines for live scrubbing. `quality` trades resolution for
// latency: the 0.2 default answers in ~100ms and reads as the same tree, while
// 1.0 matches the mesh the commit will actually build.
export async function previewTree({ spec, preset, seed, overrides, quality = 0.2, signal } = {}) {
  await ensureDesktopService('meshtools')
  const response = await fetch(`${API_BASE}/tree/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec, preset, seed, overrides, quality }),
    signal,
  })
  if (!response.ok) throw await readError(response, 'Tree preview failed')
  return response.json()
}

// Read a Blob/File as bare base64 (no data: prefix — the service accepts either,
// but the bare form keeps the request smaller).
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the image file.'))
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}

// Turn a texture slot entry ({ file } for an upload, { source } for a library
// asset) into base64. Fetched lazily, at generate time: picking six leaves must
// not download six images the user may never build with.
export async function resolveTextureEntry(entry, { signal } = {}) {
  if (!entry) return null
  if (entry.file) return blobToBase64(entry.file)
  if (!entry.source) return null
  const response = await fetch(entry.source, { signal })
  if (!response.ok) throw new Error(`Could not load the image "${entry.name}" (${response.status}).`)
  return blobToBase64(await response.blob())
}

export async function resolveTextures(textures = {}, { signal } = {}) {
  const leaves = Array.isArray(textures.leaves) ? textures.leaves : []
  const [trunk, branches, leafImages] = await Promise.all([
    resolveTextureEntry(textures.trunk, { signal }),
    resolveTextureEntry(textures.branches, { signal }),
    Promise.all(leaves.map(entry => resolveTextureEntry(entry, { signal }))),
  ])
  return {
    barkTexture: trunk,
    branchTexture: branches,
    leafImages: leafImages.filter(Boolean),
  }
}

// Full generation. Resolves to { blob, spec, stats } — `spec` is the resolved
// document including the seed actually used, which is what gets saved as the
// asset; asking for a preset alone would otherwise leave the caller unable to
// reproduce what it just got.
export async function generateTree({
  spec, preset, seed, overrides,
  barkTexture = null, branchTexture = null, leafImages = null, leafAtlas = null,
  onProgress = null, signal = null,
} = {}) {
  await ensureDesktopService('meshtools')
  const response = await fetch(`${API_BASE}/tree/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spec, preset, seed, overrides,
      format: 'glb',
      bark_texture_b64: barkTexture,
      branch_texture_b64: branchTexture,
      leaf_images_b64: leafImages?.length ? leafImages : null,
      leaf_atlas_b64: leafAtlas,
    }),
    signal,
  })
  if (!response.ok) throw await readError(response, 'Tree generation failed')

  const data = await readSseStream(response, onProgress)
  const stats = data.stats || {}
  return {
    blob: base64ToBlob(data.mesh_b64, 'model/gltf-binary'),
    spec: data.spec || null,
    stats: {
      vertexCount: stats.vertex_count ?? null,
      faceCount: stats.face_count ?? null,
      hasUv: !!stats.has_uv,
      tool: stats.tool || null,
    },
  }
}

// ---------------------------------------------------------------------------
// Spec helpers
// ---------------------------------------------------------------------------

// Immutably set a dotted path on a spec, cloning only the nodes along the way.
//
// Numeric segments index arrays, not object keys — `skeleton.tropism.1` has to
// produce a three-element array, because the service types that field as a
// tuple and an object `{1: 0.2}` fails validation. Getting this wrong is silent
// until the request 422s, so the array branch is explicit.
export function setSpecValue(spec, dottedPath, value) {
  const parts = dottedPath.split('.')

  const clone = (node, depth) => {
    const key = parts[depth]
    const isIndex = /^\d+$/.test(key)
    const base = node == null ? (isIndex ? [] : {}) : node
    const copy = Array.isArray(base) ? [...base] : { ...base }
    const index = isIndex ? Number(key) : key
    copy[index] = depth === parts.length - 1 ? value : clone(base[index], depth + 1)
    return copy
  }

  return clone(spec, 0)
}

export function readSpecValue(spec, dottedPath) {
  return dottedPath.split('.').reduce((node, key) => (node == null ? undefined : node[key]), spec)
}

// A fresh seed for the dice button. The main interaction loop is re-rolling,
// so this is the most-pressed control on the page.
export function rollSeed() {
  return Math.floor(Math.random() * 2147483647)
}
