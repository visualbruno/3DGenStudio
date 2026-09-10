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
  indexInstalledPackAssets,
  presetAssetName,
} from '../../../vfx/preset.js'
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
