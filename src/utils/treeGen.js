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
import { API_BASE, assetUrl } from '../config'
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
  // Pivots stay POSITIONAL with the images, so an entry that failed to load is
  // dropped from both lists together — otherwise every later leaf would be
  // framed with the wrong leaf's pivot.
  const keptImages = []
  const keptPivots = []
  leafImages.forEach((image, index) => {
    if (!image) return
    keptImages.push(image)
    keptPivots.push(leaves[index]?.pivot || null)
  })

  return {
    barkTexture: trunk,
    branchTexture: branches,
    leafImages: keptImages,
    leafPivots: keptPivots,
  }
}

// Full generation. Resolves to { blob, spec, stats } — `spec` is the resolved
// document including the seed actually used, which is what gets saved as the
// asset; asking for a preset alone would otherwise leave the caller unable to
// reproduce what it just got.
export async function generateTree({
  spec, preset, seed, overrides,
  barkTexture = null, branchTexture = null, leafImages = null, leafPivots = null, leafAtlas = null,
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
      leaf_pivots: leafPivots?.length ? leafPivots : null,
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

/**
 * Generate the LOD chain (and optionally an impostor) in one request.
 *
 * Resolves to { levels: [{ level, blob, stats }], impostor, spec, seconds }.
 * Every level comes from the same skeleton, so branches never move between
 * them — see the service's lod.py for why that is the load-bearing property.
 */
export async function generateTreeLods({
  spec, preset, seed, overrides,
  barkTexture = null, branchTexture = null, leafImages = null, leafPivots = null, leafAtlas = null,
  onProgress = null, signal = null,
} = {}) {
  await ensureDesktopService('meshtools')
  const response = await fetch(`${API_BASE}/tree/lods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spec, preset, seed, overrides,
      format: 'glb',
      bark_texture_b64: barkTexture,
      branch_texture_b64: branchTexture,
      leaf_images_b64: leafImages?.length ? leafImages : null,
      leaf_pivots: leafPivots?.length ? leafPivots : null,
      leaf_atlas_b64: leafAtlas,
    }),
    signal,
  })
  if (!response.ok) throw await readError(response, 'LOD generation failed')

  const data = await readSseStream(response, onProgress)
  return {
    levels: (data.levels || []).map(entry => ({
      level: entry.level,
      blob: base64ToBlob(entry.mesh_b64, 'model/gltf-binary'),
      stats: entry.stats,
    })),
    impostor: data.impostor ? {
      blob: base64ToBlob(data.impostor.mesh_b64, 'model/gltf-binary'),
      albedo: base64ToBlob(data.impostor.albedo_b64, 'image/png'),
      normal: base64ToBlob(data.impostor.normal_b64, 'image/png'),
      meta: data.impostor.meta,
    } : null,
    spec: data.spec || null,
    skeleton: data.skeleton || null,
    seconds: data.seconds,
  }
}

// ---------------------------------------------------------------------------
// Texture slot entries
// ---------------------------------------------------------------------------

// Where an asset's BYTES live.
//
// A library asset carries two paths that look interchangeable and are not:
// `filename` ("images/x.png") is relative to the /assets mount, while `filePath`
// ("data/assets/images/x.png") is storage-prefixed. Handing the second to
// assetUrl() yields /assets/data/assets/... and a 404.
export function assetFileUrl(asset) {
  if (asset?.url) return asset.url
  const relative = String(asset?.filename || asset?.filePath || '')
    .replace(/^\/+/, '')
    .replace(/^data\/assets\//, '')
  return relative ? assetUrl(relative) : null
}

// One texture slot entry. Uploaded Files and library assets both end up in this
// shape so the panel does not care which it is holding.
export function assetToTextureEntry(asset) {
  const source = assetFileUrl(asset)
  return {
    // Top-level library rows expose the real id as `assetId` beside a prefixed
    // "library:<id>" display id; an EDIT (a child row) has only `id`. Both come
    // from the same Assets sequence, so either is a valid reference.
    id: asset.assetId ?? asset.id ?? null,
    name: asset.name || asset.filename || 'Image',
    url: asset.thumbnailUrl || source,
    source,
    file: null,
  }
}

// Flatten the library, INCLUDING edits and versions.
//
// This is the part that is easy to get wrong: the texture picker runs with
// `showEdits`, so the images a user actually reaches for — a background-removed
// leaf, a bark map just run through Seamless — are child rows, not top-level
// assets. A resolver that only walks the top level finds none of them and
// silently drops every texture on load.
export function flattenAssetLibrary(library) {
  const byId = new Map()
  const visit = asset => {
    if (!asset) return
    const id = asset.assetId ?? asset.id
    if (id != null && !byId.has(Number(id))) byId.set(Number(id), asset)
    for (const key of ['children', 'edits', 'versions']) {
      if (Array.isArray(asset[key])) asset[key].forEach(visit)
    }
  }
  for (const group of Object.values(library || {})) {
    if (Array.isArray(group)) group.forEach(visit)
  }
  return byId
}

/**
 * Turn saved texture ids back into slot entries.
 *
 * Resolved against the live library so an image deleted since the save empties
 * its slot instead of becoming a broken thumbnail; `missing` says how many.
 */
export async function resolveTextureAssetIds(refs, { signal } = {}) {
  const empty = { trunk: null, branches: null, leaves: [], missing: 0 }
  if (!refs) return empty

  const response = await fetch(`${API_BASE}/assets/library`, { signal })
  if (!response.ok) throw await readError(response, 'Could not load the asset library')
  const byId = flattenAssetLibrary(await response.json())

  const lookup = id => {
    if (id == null) return null
    const asset = byId.get(Number(id))
    return asset ? assetToTextureEntry(asset) : null
  }

  const trunk = lookup(refs.trunk)
  const branches = lookup(refs.branches)
  // A leaf reference is {id, pivot} now and was a bare id before.
  const wanted = (Array.isArray(refs.leaves) ? refs.leaves : [])
    .map(entry => (entry && typeof entry === 'object' ? entry : { id: entry, pivot: null }))
  const leaves = wanted
    .map(entry => {
      const resolved = lookup(entry.id)
      return resolved ? { ...resolved, pivot: entry.pivot || null } : null
    })
    .filter(Boolean)

  const missing = (refs.trunk != null && !trunk ? 1 : 0)
    + (refs.branches != null && !branches ? 1 : 0)
    + (wanted.length - leaves.length)

  return { trunk, branches, leaves, missing }
}

/**
 * Detect the stem in each leaf image, as normalized {x, y} or null.
 *
 * Used to seed the pivot editor when leaves are added, so the user is nudging a
 * guess rather than placing every point from scratch. Advisory by design — the
 * detector is right most of the time and wrong in ways that are obvious on
 * sight, which is why the point is editable at all.
 */
export async function detectLeafPivots(imagesBase64, { signal } = {}) {
  if (!imagesBase64?.length) return []
  await ensureDesktopService('meshtools')
  const response = await fetch(`${API_BASE}/tree/leaf-pivots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images_b64: imagesBase64 }),
    signal,
  })
  if (!response.ok) throw await readError(response, 'Leaf stem detection failed')
  return (await response.json()).pivots || []
}

// ---------------------------------------------------------------------------
// Tree presets as ASSETS
// ---------------------------------------------------------------------------
//
// A saved tree is an ordinary library asset of type 'tree', not a row in a
// bespoke table. That is what makes it browsable in the Assets page with a
// thumbnail, taggable, searchable and pickable through the same modal as every
// other asset — a private list would have had to reinvent all of it.
//
// The stored FILE is the document below: the spec plus the ids of the images it
// wore. Textures are referenced, never copied, so one bark photo can dress fifty
// trees without fifty copies of it.

export const TREE_PRESET_FORMAT = 1

export function buildTreePresetDocument(spec, textureRefs) {
  return {
    format: TREE_PRESET_FORMAT,
    kind: 'tree-preset',
    savedAt: Date.now(),
    spec,
    textures: {
      trunk: textureRefs?.trunk ?? null,
      branches: textureRefs?.branches ?? null,
      // Each leaf is {id, pivot}. Older presets stored a bare id, which
      // `resolveTextureAssetIds` still accepts — a saved tree must not stop
      // opening because the format grew a field.
      leaves: Array.isArray(textureRefs?.leaves) ? textureRefs.leaves : [],
    },
  }
}

/**
 * Save a tree preset as a library asset.
 *
 * `thumbnail` is a File to attach after the upload — always supplied by the
 * page, because a grid of identical placeholder icons is exactly what an asset
 * library is meant to avoid.
 *
 * Pass `assetId` to overwrite that preset instead of creating another one. An
 * editor that can only ever fork is not an editor: opening a preset, nudging a
 * parameter and saving used to leave the original untouched and a near-identical
 * copy beside it, so the library filled up with versions and none of them was
 * the one links pointed at. Replacing keeps the id, which is what the Assets
 * page's Edit link and any saved reference resolve through.
 */
export async function saveTreePresetAsset({
  name, spec, textureRefs, thumbnail = null, stats = null, assetId = null,
}) {
  const safeName = String(name || 'Tree').trim() || 'Tree'
  const document = buildTreePresetDocument(spec, textureRefs)
  const file = new File(
    [JSON.stringify(document, null, 2)],
    `${safeName.replace(/[^\w.-]+/g, '_')}.tree.json`,
    { type: 'application/json' },
  )

  const form = new FormData()
  form.append('file', file)
  form.append('type', 'tree')
  form.append('name', safeName)
  // Mirrored into metadata so a listing (or an MCP client) can read the seed and
  // the texture ids without fetching and parsing the file.
  form.append('metadata', JSON.stringify({
    source: 'TREE GENERATOR',
    kind: 'tree-preset',
    format: TREE_PRESET_FORMAT,
    preset: spec?.preset ?? null,
    seed: spec?.seed ?? null,
    height: spec?.height ?? null,
    crown: spec?.crown?.shape ?? null,
    textureAssetIds: document.textures,
    stats,
  }))

  if (assetId) {
    // The replace route speaks a different multipart dialect to library-upload:
    // one `payload` JSON part rather than loose fields, and it takes the new
    // thumbnail in the same request instead of a follow-up POST.
    const replaceForm = new FormData()
    replaceForm.append('file', file)
    if (thumbnail) replaceForm.append('thumbnail', thumbnail)
    replaceForm.append('payload', JSON.stringify({
      name: safeName,
      type: 'tree',
      metadata: form.get('metadata') ? JSON.parse(form.get('metadata')) : {},
    }))
    const replaced = await fetch(`${API_BASE}/assets/${assetId}/replace`, {
      method: 'POST', body: replaceForm,
    })
    const result = await replaced.json().catch(() => ({}))
    if (!replaced.ok) throw new Error(result?.error || 'Could not update the tree preset')
    return result
  }

  const response = await fetch(`${API_BASE}/assets/library-upload`, { method: 'POST', body: form })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not save the tree preset')

  if (thumbnail && payload?.id) {
    const thumbForm = new FormData()
    thumbForm.append('thumbnail', thumbnail)
    // Cosmetic: the preset is already saved, so a failed thumbnail must not
    // surface as a failed save.
    await fetch(`${API_BASE}/assets/${payload.id}/thumbnail`, { method: 'POST', body: thumbForm })
      .catch(() => null)
  }
  return payload
}

/** Read a tree preset asset back into { spec, textures }. */
export async function loadTreePresetAsset(asset, { signal } = {}) {
  const source = asset?.url
    || (asset?.filename || asset?.filePath
      ? `${API_BASE.replace(/\/api$/, '')}/assets/${String(asset.filename || asset.filePath).replace(/^data\/assets\//, '')}`
      : null)
  if (!source) throw new Error('That tree preset has no stored file.')

  const response = await fetch(source, { signal, cache: 'reload' })
  if (!response.ok) throw new Error(`Could not read the tree preset (${response.status}).`)
  const document = await response.json()

  const spec = document?.spec || (document?.version ? document : null)
  if (!spec) throw new Error('That file is not a tree preset.')
  return {
    spec,
    textures: {
      trunk: document?.textures?.trunk ?? null,
      branches: document?.textures?.branches ?? null,
      leaves: Array.isArray(document?.textures?.leaves) ? document.textures.leaves : [],
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
