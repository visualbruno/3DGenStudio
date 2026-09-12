// Transport for VFX assets: save, load, list.
//
// A plain fetch module rather than functions on ProjectContext, because VFX
// effects are LIBRARY-GLOBAL. The rule is written in the header of
// src/utils/assemblyApi.js: a global resource lives here, not in the project
// data layer. Tree presets do the same in src/utils/treeGen.js, and this file
// is deliberately shaped like that one.
//
// WHY VFX IS LIBRARY-GLOBAL, since it constrains everything below: a graph
// references textures and meshes that routinely come from different projects,
// so binding the effect to one of them would be arbitrary. The consequence to
// know about is that a VFX asset does NOT appear in `GET /api/assets?projectId=`
// - that query drives the Kanban board and the graph canvas and is hardcoded to
// Image and Mesh. The Assets page reads effects from /api/assets/library
// instead, exactly as it does for tree presets.
//
// EVERY CALL REUSES AN EXISTING ROUTE. There is no /api/vfx. Create is
// library-upload, save-in-place is :id/replace, load is :id/record plus a fetch
// of the file, rename and delete are the library routes. That is not a
// shortcut: those routes already carry the ownership checks, the remote-mode
// forwarding and the upload staging, and a new prefix would have to be added to
// serverMode.js's classification and would be a fourth place to forget.
//
// THE TWO MULTIPART DIALECTS ARE A REAL TRAP, and hiding them is most of the
// reason this file exists. library-upload takes loose form fields; :id/replace
// takes ONE `payload` JSON part and accepts the thumbnail in the same request.
// Getting them the wrong way round produces a 400 that says nothing useful.

import { API_BASE, SERVER_ORIGIN, assetUrl } from '../config.js'
import { indexLibraryAssets, vfxAssetId } from './vfx/library.js'
import { normalizeVfxDoc, serializeVfxDoc, vfxAssetDigest } from '../../vfx/doc.js'

export const VFX_ASSET_TYPE = 'vfx'

// Re-exported rather than defined here: this module imports src/config.js for
// API_BASE, which reads import.meta.env and cannot be loaded by a node test.
// The id and listing logic is the part with bugs in it, so it lives in a pure
// module that a test CAN import - see the header of ./vfx/library.js.
// A plain re-export, so the ~six existing importers of vfxApi keep working.
// Imported above as well, because a re-export creates no LOCAL binding and
// two functions in this file call vfxAssetId.
export { indexLibraryAssets, vfxAssetId }

/**
 * The URL an asset's bytes are served from.
 *
 * Handles every shape a stored path arrives in, because a listing row, an
 * ingest response and an asset record do not agree on the field name - the same
 * normalisation buildAssetUrl does in src/utils/meshTexturing.js.
 */
export function vfxFileUrl(asset) {
  const raw = asset?.url || asset?.filename || asset?.filePath || ''
  if (!raw) return null
  const text = String(raw)
  if (/^(https?:|data:|blob:)/.test(text)) return text
  return assetUrl(text.replace(/\\/g, '/').replace(/^\/?(?:data\/)?assets\//, '').replace(/^\/+/, ''))
}

/**
 * Every VFX effect in the library.
 * @returns {Promise<Array<Object>>}
 */
export async function listVfxAssets() {
  const response = await fetch(`${API_BASE}/assets/library`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not list VFX effects')
  return Array.isArray(payload?.vfx) ? payload.vfx : []
}

/**
 * One asset's record, by id.
 *
 * Uses GET /api/assets/record, which exists and is ownership-checked.
 * Deliberately NOT the pattern TreeGenPage uses, which fetches the entire
 * asset library and scans it because a comment in mcp/tools/tree.js claims
 * there is no lookup by id. There is.
 *
 * @param {number|string} assetId
 * @returns {Promise<Object>}
 */
export async function getVfxAssetRecord(assetId) {
  const id = vfxAssetId(assetId)
  if (id == null) throw new Error(`"${assetId}" is not a valid asset id.`)
  const response = await fetch(`${API_BASE}/assets/record?assetId=${id}`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not read that effect')

  // This route returns the RAW database row - it does not go through
  // mapAssetRow the way the listings do - so `metadata` arrives as a JSON
  // STRING rather than an object. Parsing it here means every caller gets the
  // same shape whichever route the record came from, instead of each one
  // discovering the difference for itself.
  if (typeof payload?.metadata === 'string') {
    try {
      payload.metadata = JSON.parse(payload.metadata)
    } catch {
      payload.metadata = {}
    }
  }
  return payload
}

/**
 * Read a VFX graph document back, by asset id or by an asset row.
 *
 * @param {number|string|Object} target
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{doc: Object, record: Object|null}>}
 */
export async function loadVfxAsset(target, options = {}) {
  let record = null
  let url = typeof target === 'object' ? vfxFileUrl(target) : null

  if (!url) {
    record = await getVfxAssetRecord(target)
    url = vfxFileUrl(record)
  }
  if (!url) throw new Error('That effect has no stored file.')

  // cache: 'reload' because a stale copy here is indistinguishable from a save
  // that did not take. Note that /replace assigns a NEW filePath even though it
  // keeps the asset id, so a caller holding an old row's url is reading the
  // previous version - always resolve through the record after a save.
  const response = await fetch(url, { signal: options.signal, cache: 'reload' })
  if (!response.ok) throw new Error(`Could not read that effect (${response.status}).`)
  const raw = await response.json()

  if (raw?.kind && raw.kind !== 'vfx-graph') throw new Error('That file is not a VFX effect.')
  return { doc: normalizeVfxDoc(raw), record }
}

// The digest mirrored into the metadata column. Kept in step with
// readVfxGraphMetadata on the server, which computes the same thing for an
// imported file - two producers, one shape, so the fields are the same
// whichever way the asset arrived.
//
// Read by project export and import, by GET /api/assets/record and by MCP -
// but NOT by the Assets grid, because listLibraryAssetsByType does not project
// the metadata column. Do not build UI that expects it in a listing row.
// Moved into vfx/doc.js as vfxAssetDigest, because the MCP save path writes the
// same digest and the two must not drift - see the note there.

/**
 * Save an effect. Creates a new asset, or replaces an existing one in place.
 *
 * Replace rather than always-fork, for the reason written at
 * src/utils/treeGen.js:375 - an editor that can only ever fork is not an
 * editor. Keeping the id is what makes the Assets page's Edit link and any
 * saved reference keep resolving.
 *
 * @param {Object} params
 * @param {string} params.name
 * @param {Object} params.doc the graph document
 * @param {File|Blob|null} [params.thumbnail]
 * @param {number|string|null} [params.assetId] replace this asset when given
 * @returns {Promise<Object>} the saved asset row
 */
export async function saveVfxAsset({ name, doc, thumbnail = null, assetId = null }) {
  const safeName = String(name || 'Effect').trim() || 'Effect'
  const { doc: document } = serializeVfxDoc(doc, { name: safeName })
  const metadata = vfxAssetDigest(document, { source: 'VFX EDITOR' })

  const file = new File(
    [JSON.stringify(document, null, 2)],
    `${safeName.replace(/[^\w.-]+/g, '_')}.vfx.json`,
    { type: 'application/json' },
  )

  const id = vfxAssetId(assetId)
  if (assetId && id == null) throw new Error(`"${assetId}" is not a valid asset id.`)

  if (id != null) {
    // The replace dialect: one `payload` part, and the thumbnail rides along.
    const form = new FormData()
    form.append('file', file)
    if (thumbnail) form.append('thumbnail', thumbnail)
    form.append('payload', JSON.stringify({ name: safeName, type: VFX_ASSET_TYPE, metadata }))
    const response = await fetch(`${API_BASE}/assets/${id}/replace`, { method: 'POST', body: form })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload?.error || 'Could not update the effect')
    return payload
  }

  // The library-upload dialect: loose fields, and the thumbnail is a follow-up.
  const form = new FormData()
  form.append('file', file)
  form.append('type', VFX_ASSET_TYPE)
  form.append('name', safeName)
  form.append('metadata', JSON.stringify(metadata))

  const response = await fetch(`${API_BASE}/assets/library-upload`, { method: 'POST', body: form })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not save the effect')

  if (thumbnail && payload?.id) {
    // Cosmetic, and the effect is already saved - so a failed thumbnail must
    // never surface as a failed save.
    await fetch(`${API_BASE}/assets/${payload.id}/thumbnail`, {
      method: 'POST',
      body: (() => {
        const thumbForm = new FormData()
        thumbForm.append('thumbnail', thumbnail)
        return thumbForm
      })(),
    }).catch(() => null)
  }
  return payload
}

/**
 * Write an engine export bundle to a folder on the machine running the server.
 *
 * THE SERVER WRITES IT, NOT THE BROWSER, and that is not a shortcut: a bundle is
 * a folder of files, and a browser can offer one download at a time. The same
 * split as project export - and the route is deliberately kept off the
 * gateway's forward list, because in remote mode the folder is on the user's
 * machine and not the shared server's.
 *
 * @param {number|string} assetId a saved Vfx asset
 * @param {{folder: string, name?: string, engineTarget?: string|null}} options
 * @returns {Promise<{folder: string, name: string, fileCount: number, warnings: Array<Object>}>}
 */
export async function exportVfxBundle(
  assetId,
  { folder, name = '', engineTarget = null, includeUnityImporter = false },
) {
  const id = vfxAssetId(assetId)
  if (id == null) throw new Error(`"${assetId}" is not a valid asset id.`)
  const response = await fetch(`${API_BASE}/assets/${id}/vfx-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, name, engineTarget, includeUnityImporter }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not export the effect')
  return payload
}

/**
 * Build the `resolveUrl` the runtime needs to turn IR asset ids into URLs.
 *
 * The runtime deliberately has no opinion about where assets live (see the
 * header of src/utils/vfx/assets.js), so the mapping is supplied from here,
 * where the library listing is already in hand.
 *
 * TAKES EVERY TYPE THE GRAPH CAN REFERENCE, not just images. useVfxRuntime
 * hands this one function to both loadVfxTextures AND loadVfxMeshes, so a
 * resolver built from the image listing alone made every mesh asset unresolvable
 * - `loadVfxMeshes` put it straight into `failed` and the mesh renderer had
 * nothing to draw, with no error anywhere.
 *
 * @param {Array<Object>} rows library rows of any type
 * @returns {(asset: Object) => string|null}
 */
export function makeAssetResolver(rows) {
  const byId = indexLibraryAssets(rows)
  return asset => {
    const row = byId.get(asset.assetId)
    return row ? vfxFileUrl(row) : null
  }
}

// ── The preset library ─────────────────────────────────────────────────────
// Ready-made effects, stored as files under resources/vfx/presets/ and served
// read-only unless this installation carries the author marker. See
// vfx/preset.js for the format and why a preset may not reference assets.
//
// THE LISTING DOES NOT CARRY THE GRAPHS. A staged explosion is tens of
// kilobytes of blocks and the dialog needs none of it to draw a card, so the
// document is fetched only when a preset is actually opened. Fifty presets list
// in a few kilobytes this way instead of a megabyte.

/**
 * @returns {Promise<{presets: Object[], authorMode: boolean}>}
 */
export async function listVfxPresets() {
  const response = await fetch(`${API_BASE}/vfx/presets`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not read the preset library')
  return { presets: payload.presets || [], authorMode: Boolean(payload.authorMode) }
}

/**
 * @param {string} id
 * @returns {Promise<Object>} the preset, including its `doc`
 */
export async function getVfxPreset(id) {
  const response = await fetch(`${API_BASE}/vfx/presets/${encodeURIComponent(id)}`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not read the preset')
  return payload.preset
}

/**
 * Create or replace a preset. Author installations only - everyone else gets a
 * 403, which is the point.
 *
 * @param {string} id
 * @param {Object} preset
 * @returns {Promise<{preset: Object, warnings: string[]}>}
 */
export async function saveVfxPreset(id, preset) {
  const response = await fetch(`${API_BASE}/vfx/presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preset),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not save the preset')
  return { preset: payload.preset, warnings: payload.warnings || [] }
}

/**
 * @param {string} id
 */
export async function deleteVfxPreset(id) {
  const response = await fetch(`${API_BASE}/vfx/presets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload?.error || 'Could not delete the preset')
  }
}

/**
 * What is already in the shipped preset asset pack.
 *
 * Read before bundling so the Save dialog can say "that filename is taken" in
 * the form rather than as a 409 after the author has pressed Save.
 *
 * @returns {Promise<{assets: Array<Object>, authorMode: boolean}>}
 */
export async function listVfxPackAssets() {
  const response = await fetch(`${API_BASE}/vfx/preset-assets`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'Could not read the preset asset pack')
  return { assets: payload.assets || [], authorMode: Boolean(payload.authorMode) }
}

/**
 * Copy one file into the preset asset pack.
 *
 * This is the step that makes a custom effect shippable: the bytes move OUT of
 * the author's install-specific library and INTO resources/vfx/assets/, where a
 * filename is all the reference a preset needs. Author installations only.
 *
 * @param {{name: string, dataUrl: string, overwrite?: boolean}} spec
 * @returns {Promise<{file: string, kind: string, name: string}>}
 */
export async function addVfxPackAsset({ name, dataUrl, overwrite = false }) {
  const response = await fetch(`${API_BASE}/vfx/preset-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dataUrl, overwrite }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    // The 409 carries the filename that clashed, and the caller needs it to
    // decide between reusing that file and asking for a different name - so it
    // travels on the error rather than being flattened into the message.
    const error = new Error(payload?.error || 'Could not add that file to the pack')
    error.status = response.status
    error.file = payload?.file || ''
    throw error
  }
  return payload
}

/**
 * Store a card thumbnail, as a PNG data URL straight off a canvas.
 *
 * @param {string} id
 * @param {string} dataUrl
 */
export async function saveVfxPresetThumbnail(id, dataUrl) {
  const response = await fetch(`${API_BASE}/vfx/presets/${encodeURIComponent(id)}/thumbnail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload?.error || 'Could not save the thumbnail')
  }
}

/**
 * Where a preset's thumbnail lives. Served by the static /resources mount, so
 * there is no route to add and no auth to consider - the same path works in the
 * browser, in Electron and behind the gateway.
 *
 * @param {string} id
 * @returns {string}
 */
export function vfxPresetThumbnailUrl(id) {
  return `${SERVER_ORIGIN}/resources/vfx/thumbnails/${encodeURIComponent(id)}.png`
}
