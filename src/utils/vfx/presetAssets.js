// Install the sprites and meshes a preset needs, then point the preset at them.
//
// THE PROBLEM THIS SOLVES. A preset ships with the application. `asset:41` is a
// row in the authoring machine's database, so a preset that stored one would
// open on someone else's install pointing at nothing - or, worse, at a
// different image, which is a bug the author can never see because their
// library does contain 41. That is the trap tree presets ship with today.
//
// So a preset names a FILE in `resources/vfx/assets/` instead, and this module
// closes the gap at the moment it is opened: fetch the bundled bytes, install
// them into this library (or find the copy already there), and rewrite the
// slots to whatever ids they got here. What lands on the board is an ordinary
// document with ordinary asset ids - which is the whole point, because the
// compiler, the runtime, the export bundle and the eventual engine plugins then
// need to know nothing about any of this.
//
// DEDUP IS BY NAME, and that is forced rather than chosen: the library listing
// does NOT project the metadata column (recorded in vfxApi.js), so there is
// nowhere to hide a content hash or a marker that a listing could match on. It
// is also exactly what /api/setup/install-workflows already does for bundled
// workflows, so it is the house answer rather than a new one. The name carries
// a `VFX ` prefix so an unprefixed asset the user happens to own with the same
// name is not silently adopted.
//
// INSTALLING IS IDEMPOTENT BUT NOT FREE. The first open of a preset that wants
// two sprites is two uploads; every open after that is one listing read. That
// asymmetry is why the caller reports what it installed rather than doing it
// invisibly - an author who sees "added 2 textures to your library" is not
// surprised later to find them there.
import {
  applyPresetAssets,
  bundlePresetAssets,
  collectPresetAssetNeeds,
  indexInstalledPackAssets,
  presetAssetName,
} from '../../../vfx/preset.js'
import { addVfxPackAsset, indexLibraryAssets, vfxFileUrl } from '../vfxApi.js'
import { API_BASE, SERVER_ORIGIN } from '../../config.js'

/** Where a bundled pack file is served from. Static, so no route is involved. */
export const packAssetUrl = (file) => `${SERVER_ORIGIN}/resources/vfx/assets/${encodeURIComponent(file)}`

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
}

/**
 * Upload one bundled file into the library.
 *
 * @param {Object} need a normalized asset need
 * @returns {Promise<number>} the new asset id
 */
async function installPackAsset(need) {
  const response = await fetch(packAssetUrl(need.file))
  if (!response.ok) {
    throw new Error(`The preset asset "${need.file}" is missing from this installation.`)
  }
  const blob = await response.blob()
  const extension = need.file.split('.').pop().toLowerCase()

  const form = new FormData()
  // The FILENAME keeps the pack's name so the asset is traceable back to it,
  // while the DISPLAY NAME is what dedup matches on.
  form.append('file', new File([blob], need.file, { type: MIME[extension] || blob.type }))
  form.append('type', need.kind === 'mesh' ? 'mesh' : 'image')
  form.append('name', presetAssetName(need))

  const upload = await fetch(`${API_BASE}/assets/library-upload`, { method: 'POST', body: form })
  const saved = await upload.json().catch(() => ({}))
  if (!upload.ok) {
    throw new Error(saved?.error || `Could not add "${need.file}" to the library.`)
  }
  // library-upload answers with either a bare id or a "library:<id>" handle
  // depending on the type - see the notes in vfxApi.js.
  const id = Number(String(saved.id).replace('library:', ''))
  if (!Number.isFinite(id)) throw new Error(`The library did not return an id for "${need.file}".`)
  return id
}

/**
 * Resolve every asset a preset declares, installing what is missing.
 *
 * @param {Object} preset a normalized preset, document included
 * @param {Object} options
 * @param {() => Promise<Array<Object>>} options.listLibrary reads the library
 *   rows the dedup index is built from
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{doc: Object, installed: string[], missing: Object[]}>}
 */
export async function resolvePresetAssets(preset, options) {
  const needs = preset.assets || []
  if (needs.length === 0) return { doc: preset.doc, installed: [], missing: [] }

  const rows = await options.listLibrary()
  const byName = indexInstalledPackAssets(rows)

  const idsByFile = new Map()
  const installed = []
  const failed = []

  for (let index = 0; index < needs.length; index += 1) {
    const need = needs[index]
    const existing = byName.get(presetAssetName(need))
    if (existing !== undefined) {
      idsByFile.set(need.file, existing)
    } else {
      try {
        const id = await installPackAsset(need)
        idsByFile.set(need.file, id)
        installed.push(presetAssetName(need))
        // So a second need for the same file in one preset reuses the upload
        // rather than adding a duplicate.
        byName.set(presetAssetName(need), id)
      } catch (err) {
        // NOT FATAL, AND NOT SILENT. One texture that failed to install should
        // still let the author open the effect and see the other three; what it
        // must not do is leave them wondering why one system is a grey blob.
        // applyPresetAssets reports the slot, and the caller says so.
        failed.push({ ...need, error: err?.message || 'install failed' })
      }
    }
    options.onProgress?.(index + 1, needs.length)
  }

  const { doc, missing } = applyPresetAssets(preset.doc, needs, idsByFile)
  // `missing` covers anything unresolvable for any reason - a failed upload, or
  // a declaration naming a slot the document does not have. Merge the reasons
  // in so the message can be specific.
  const reasons = new Map(failed.map((entry) => [entry.file, entry.error]))
  return {
    doc,
    installed,
    missing: missing.map((need) => ({ ...need, error: reasons.get(need.file) || 'not wired' })),
  }
}

// ---------------------------------------------------------------------------
// The save side
// ---------------------------------------------------------------------------
// Everything above runs when a preset is OPENED. What follows runs when one is
// SAVED, and it is the half that was missing: validatePreset refused any
// document still holding `asset:41` and told the author the Save dialog would
// offer to bundle it, while the dialog offered nothing of the sort. The pack
// route existed and only the MCP tools ever called it.

/**
 * What the author's own asset rows say about the slots a document references.
 *
 * Separate from the bundling so the dialog can DRAW the list before anything is
 * uploaded - an author about to copy three sprites into the shipped pack should
 * see which three first.
 *
 * @param {Object} doc the document being saved
 * @param {Array<Object>} rows the library listing
 * @returns {Array<Object>} one entry per referenced slot, `row` null if the
 *   asset is no longer in the library
 */
export function describeDocAssets(doc, rows) {
  const byId = indexLibraryAssets(rows || [])
  return collectPresetAssetNeeds(doc).map((need) => {
    const row = byId.get(need.assetId) || null
    return {
      ...need,
      row,
      // What the file will be called in the pack, before the author edits it.
      // The slot's own name first: it is what the params panel shows, so it is
      // the name they already associate with this texture.
      suggested: packSlug(need.name || row?.name || `asset-${need.assetId}`),
      extension: extensionOf(row),
    }
  })
}

/** The filename stem the pack route will derive from a display name. */
export function packSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
}

function extensionOf(row) {
  const url = row ? vfxFileUrl(row) : null
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url || ''))
  return match ? match[1].toLowerCase() : ''
}

/**
 * Read an asset's bytes as a data URL the pack route will accept.
 *
 * THE MIME TYPE COMES FROM THE EXTENSION, not from the response. The route maps
 * the data URL's declared type to a file extension, and a static mount that
 * answers `application/octet-stream` for a .png - or a blob with an empty type -
 * would land the bytes in the pack as a .glb.
 */
async function readAssetAsDataUrl(row) {
  const url = vfxFileUrl(row)
  if (!url) throw new Error('that asset has no file on this server')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`could not read its file (${response.status})`)
  const blob = await response.blob()
  const extension = extensionOf(row)
  const mime = MIME[extension] || blob.type || 'application/octet-stream'

  const raw = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('could not read its bytes'))
    reader.readAsDataURL(blob)
  })
  return raw.replace(/^data:[^;]*;base64,/, `data:${mime};base64,`)
}

/**
 * Copy every library asset a document references into the shipped pack, and
 * hand back the document with the ids replaced by filenames.
 *
 * A NAME CLASH REUSES RATHER THAN OVERWRITES, unless the author says otherwise.
 * The pack ships with the app and shipped presets name its files, so replacing
 * one silently would break every preset that names it - which is why the route
 * answers 409 instead of writing. Reusing is right far more often than not: the
 * usual clash is an author saving the same effect twice, or using the same
 * sprite a shipped preset already uses. It is reported either way.
 *
 * @param {Object} doc the document being saved
 * @param {Object} options
 * @param {() => Promise<Array<Object>>} options.listLibrary
 * @param {Object} [options.names] slot to author-chosen pack name
 * @param {Object} [options.replace] slot to true, to overwrite a clashing file
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{doc: Object, assets: Object[], added: string[],
 *   reused: string[], failed: Object[]}>}
 */
export async function bundleDocAssets(doc, options) {
  const rows = await options.listLibrary()
  const entries = describeDocAssets(doc, rows)
  if (entries.length === 0) return { doc, assets: [], added: [], reused: [], failed: [] }

  const filesBySlot = new Map()
  const added = []
  const reused = []
  const failed = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const name = options.names?.[entry.slot] || entry.suggested
    try {
      if (!entry.row) throw new Error('it is no longer in your library')
      const dataUrl = await readAssetAsDataUrl(entry.row)
      try {
        const saved = await addVfxPackAsset({
          name,
          dataUrl,
          overwrite: Boolean(options.replace?.[entry.slot]),
        })
        filesBySlot.set(entry.slot, saved.file)
        added.push(saved.file)
      } catch (err) {
        // 409: the name is taken. Wire the slot to the file that is already
        // there rather than failing the save or clobbering it.
        if (err?.status !== 409 || !err.file) throw err
        filesBySlot.set(entry.slot, err.file)
        reused.push(err.file)
      }
    } catch (err) {
      // NOT FATAL. One sprite that cannot be copied should still let the other
      // two through - the save then fails validation naming exactly the slot
      // that is still holding an id, which is a far better error than a whole
      // save refused for a reason the author has to guess at.
      failed.push({ ...entry, error: err?.message || 'could not be bundled' })
    }
    options.onProgress?.(index + 1, entries.length)
  }

  return { ...bundlePresetAssets(doc, filesBySlot), added, reused, failed }
}
