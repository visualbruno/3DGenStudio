// Import an exported VFX bundle folder into this library.
//
// THE BROWSER DOES THIS, NOT THE SERVER, and that is the one design decision
// here worth defending - because EXPORT is a server route and the symmetry is
// tempting.
//
// Export has to be server-side: a browser can offer one download at a time and
// cannot write a folder of files. READING a folder is the opposite problem. A
// directory picker hands the page real File objects, so every byte the import
// needs is already in the tab - and going through the server instead would mean
// a route that reads the USER's disk while writing the SHARED database, which
// is precisely the split serverMode.js has to special-case for project import
// (a staging upload, a second route, an entry in two classifier lists). Doing
// it here costs none of that and works identically in local, Electron and
// Docker-server installs.
//
// It also honours the rule at the top of vfxApi.js: every call reuses an
// existing route. Uploading is /api/assets/library/import, saving the effect is
// saveVfxAsset. There is no /api/vfx-import.
//
// WHAT MAKES THIS MORE THAN A FILE COPY is the reference remap, and that lives
// in vfx/bundle.js where it can be tested - see the header there for why a slot
// the bundle could not supply must be EMPTIED rather than left pointing at the
// exporting machine's asset id.
//
// THE UPLOAD ORDER IS NOT THE RESPONSE ORDER. /api/assets/library/import maps
// its files through Promise.all and pushes results as they finish, so
// `imported[i]` is NOT the i-th file sent. Matching by index silently wires
// every slot to the wrong texture, which looks like a working import. So each
// file is given a filename unique within its batch and matched back by name.

import {
  VfxBundleError,
  applyBundleAssets,
  bundleAssetNeeds,
  bundleEffectName,
  bundleGraphSource,
  bundleThumbnailPath,
  bundleWarnings,
  normalizeBundlePath,
  parseBundleManifest,
  summarizeBundle,
} from '../../../vfx/bundle.js'
import { normalizeVfxDoc } from '../../../vfx/doc.js'
// From library.js and not from vfxApi.js, deliberately: vfxApi imports
// src/config.js, which reads `import.meta.env` and therefore cannot be loaded
// by a node test at all - the reason library.js was split out in the first
// place. Saving arrives as `saveEffect` for the same reason, which is what
// lets bundleImport.test.mjs exercise the matching below.
import { vfxAssetId } from './library.js'

/** Bundle asset kind -> the library type the upload route understands. */
const ASSET_TYPE = { image: 'image', mesh: 'mesh', vfx: 'vfx' }

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tga: 'image/x-tga',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain',
  json: 'application/json',
}

const extensionOf = (path) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(path || ''))
  return match ? match[1].toLowerCase() : ''
}

/**
 * The path a picked file sits at, relative to the folder that was chosen.
 *
 * `webkitRelativePath` is what a directory input fills in and it always leads
 * with the picked folder's own name. It is empty for a file that arrived any
 * other way, so the plain name is the fallback.
 */
const relativePathOf = (file) => normalizeBundlePath(file?.webkitRelativePath || file?.name || '')

/**
 * Index a directory selection, finding the bundle root by its manifest.
 *
 * TOLERANT OF WHICH FOLDER WAS PICKED. Export writes `<chosen>/<effect>/`, so
 * an author who picks the folder they exported INTO rather than the effect
 * folder inside it is making the obvious mistake - and the fix is to look for
 * the manifest rather than to insist. Several manifests means several bundles,
 * which is a question only the user can answer.
 *
 * @param {FileList|File[]} selection
 * @returns {{root: string, files: Map<string, File>, manifestFile: File}}
 */
export function indexBundleFiles(selection) {
  const picked = Array.from(selection || [])
  if (picked.length === 0) throw new VfxBundleError('No files were selected.')

  const manifests = picked.filter((file) => {
    const path = relativePathOf(file)
    return path === 'manifest.json' || path.endsWith('/manifest.json')
  })
  if (manifests.length === 0) {
    throw new VfxBundleError(
      'That folder has no manifest.json in it. Choose the folder an effect was exported to - the one holding manifest.json, vfx/ and assets/.'
    )
  }
  // Shallowest first, so a bundle that happens to contain another one (an
  // UnityImporter folder never does, but a hand-assembled folder might) is read
  // from the outside in.
  manifests.sort((a, b) => relativePathOf(a).split('/').length - relativePathOf(b).split('/').length)
  const depth = relativePathOf(manifests[0]).split('/').length
  const shallowest = manifests.filter((file) => relativePathOf(file).split('/').length === depth)
  if (shallowest.length > 1) {
    throw new VfxBundleError(
      `That folder holds ${shallowest.length} exported effects. Choose one of them rather than the folder they are all in.`
    )
  }

  const manifestFile = shallowest[0]
  const root = relativePathOf(manifestFile).replace(/manifest\.json$/, '')
  const files = new Map()
  for (const file of picked) {
    const path = relativePathOf(file)
    if (root && !path.startsWith(root)) continue
    files.set(path.slice(root.length), file)
  }
  return { root, files, manifestFile }
}

/**
 * Read a picked folder into everything the dialog needs to describe it, and
 * everything the import needs to perform it.
 *
 * READS, WRITES NOTHING. The dialog shows what is in the bundle before the user
 * commits to installing it, which is the whole reason this is split from
 * importVfxBundle - an import that starts by uploading six textures and then
 * discovers the manifest is from a newer build has already made a mess.
 *
 * @param {FileList|File[]} selection
 * @returns {Promise<Object>} a bundle handle to pass to importVfxBundle
 */
export async function readVfxBundle(selection) {
  const { root, files, manifestFile } = indexBundleFiles(selection)
  const manifest = parseBundleManifest(await manifestFile.text())

  // The manifest embeds the graph AND the same bytes are written under vfx/.
  // Prefer the embedded copy - it is the one the format guarantees - and fall
  // back to the file so a bundle hand-trimmed to save space still imports.
  const source = bundleGraphSource(manifest)
  let raw = source.graph
  if (!raw) {
    const file = files.get(source.file)
    if (!file) {
      throw new VfxBundleError(
        `The bundle's manifest points at "${source.file}", which is not in the folder.`
      )
    }
    try {
      raw = JSON.parse(await file.text())
    } catch {
      throw new VfxBundleError(`"${source.file}" is not valid JSON. The bundle may be damaged.`)
    }
  }

  const doc = normalizeVfxDoc(raw)
  const needs = bundleAssetNeeds(manifest)
  const missingFiles = needs.filter((need) => need.file && !files.get(need.file))

  return {
    root,
    files,
    manifest,
    doc,
    needs,
    name: bundleEffectName(manifest) || 'Imported effect',
    thumbnail: files.get(bundleThumbnailPath(manifest)) || null,
    summary: summarizeBundle(manifest),
    warnings: bundleWarnings(manifest),
    // Listed separately from the manifest's own warnings: this one means the
    // FOLDER is short of files the manifest says it wrote, which is a different
    // problem from an effect that was exported incomplete.
    missingFiles,
  }
}

/**
 * The key two names are considered the same asset under.
 *
 * THE EXTENSION IS DROPPED, and that is not tidiness - it is what makes a
 * re-import adopt rather than duplicate. The exporting library's display name
 * is whatever the author typed ("Spark"); the name it lands under HERE is the
 * file it arrived as ("Spark.png"), because /api/assets/library/import names an
 * asset after its file. Matched literally, those two never meet, so importing
 * the same bundle twice quietly left two copies of every texture - which the
 * cross-install e2e caught and no amount of single-install testing could.
 *
 * KEYED BY KIND TOO, so a "flame.png" cannot be adopted as the mesh a
 * "flame.glb" slot wants once both have lost their extensions.
 */
function reuseKey(kind, name) {
  const stem = String(name || '')
    .trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .trim()
    .toLowerCase()
  return stem ? `${kind}:${stem}` : ''
}

/**
 * Index library rows for the reuse pass, by kind and name stem.
 *
 * Descends into edits and versions for the same reason indexLibraryAssets does:
 * a sprite is very often an edit rather than the original, and an index built
 * from roots alone re-uploads a copy of something already here.
 *
 * @param {Object} byKind `{image: rows, mesh: rows, vfx: rows}`
 */
function indexByName(byKind) {
  const index = new Map()
  const add = (kind, row) => {
    const id = vfxAssetId(row)
    const key = reuseKey(kind, row?.name)
    // FIRST WINS, so the reuse target is stable across imports rather than
    // depending on listing order.
    if (id != null && key && !index.has(key)) index.set(key, id)
  }
  for (const [kind, rows] of Object.entries(byKind || {})) {
    for (const row of rows || []) {
      add(kind, row)
      for (const child of row?.children || row?.edits || []) add(kind, child)
    }
  }
  return index
}

/**
 * The filename one bundle file is uploaded under.
 *
 * The library names an imported asset after the file it arrived as, so this is
 * also the name it will carry in the Assets grid - which is why it prefers the
 * name the EXPORTING library used ("spark.png") over the bundle's storage
 * filename ("1787-41.png"), and why it has to stay unique within the batch:
 * the upload response is matched back by name.
 */
export function uploadFilename(need, taken = new Set()) {
  const extension = extensionOf(need.file)
  const stem = String(need.name || need.file.split('/').pop() || 'asset')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || 'asset'

  let candidate = extension ? `${stem}.${extension}` : stem
  let counter = 2
  while (taken.has(candidate.toLowerCase())) {
    candidate = extension ? `${stem}-${counter}.${extension}` : `${stem}-${counter}`
    counter += 1
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/**
 * Install a bundle: its textures and meshes into the library, then the effect.
 *
 * BEST-EFFORT PER FILE, like every other bundle operation in this repo. One
 * texture that will not upload must not cost the author the other five and the
 * effect - it costs that one slot, which comes back empty and is reported.
 *
 * @param {Object} bundle from readVfxBundle
 * @param {Object} options
 * @param {string} [options.name] the name to save the effect under
 * @param {boolean} [options.reuseExisting] match library assets by name instead
 *   of uploading a second copy
 * @param {(assets: Array<Object>, opts: Object) => Promise<Object>} options.uploadAssets
 *   ProjectContext's importLibraryAssets
 * @param {() => Promise<Object>} options.listLibrary ProjectContext's getLibraryAssets
 * @param {(spec: Object) => Promise<Object>} options.saveEffect vfxApi's saveVfxAsset
 * @param {(step: {done: number, total: number, label: string}) => void} [options.onProgress]
 * @returns {Promise<{asset: Object, name: string, installed: string[],
 *   reused: string[], failed: Object[], missing: Object[]}>}
 */
export async function importVfxBundle(bundle, {
  name = '',
  reuseExisting = true,
  uploadAssets,
  listLibrary,
  saveEffect,
  onProgress,
} = {}) {
  const effectName = String(name || bundle.name || 'Imported effect').trim() || 'Imported effect'

  // One entry per distinct FILE, not per slot: export dedups by destination, so
  // a sprite used by two systems ships once and must be installed once.
  const byFile = new Map()
  for (const need of bundle.needs) {
    if (!need.file) continue
    if (!byFile.has(need.file)) byFile.set(need.file, need)
  }

  const idsByFile = new Map()
  const installed = []
  const reused = []
  const failed = []
  const total = byFile.size
  let done = 0
  const step = (label) => {
    done += 1
    onProgress?.({ done, total, label })
  }

  if (total > 0) {
    const byName = reuseExisting ? indexByName(await listLibraryRows(listLibrary)) : new Map()

    // Grouped by asset type because the upload route takes ONE assetType for
    // the whole request - and it is the only thing that can tell a .json that
    // is a nested effect from a .json that is anything else.
    const batches = new Map()
    const taken = new Set()

    for (const [file, need] of byFile) {
      const existing = byName.get(reuseKey(need.kind, need.name || need.file.split('/').pop()))
      if (existing != null) {
        idsByFile.set(file, existing)
        reused.push(need.name || file)
        step(need.name || file)
        continue
      }
      const blob = bundle.files.get(file)
      if (!blob) {
        failed.push({ ...need, error: 'that file is not in the folder' })
        step(need.name || file)
        continue
      }
      const type = ASSET_TYPE[need.kind] || 'image'
      const filename = uploadFilename(need, taken)
      const upload = new File([blob], filename, { type: MIME[extensionOf(file)] || blob.type })
      if (!batches.has(type)) batches.set(type, [])
      batches.get(type).push({ file, need, filename, upload })
    }

    for (const [type, entries] of batches) {
      let response = null
      try {
        response = await uploadAssets(entries.map((entry) => ({ file: entry.upload })), { assetType: type })
      } catch (err) {
        for (const entry of entries) {
          failed.push({ ...entry.need, error: err?.message || 'the upload failed' })
          step(entry.need.name || entry.file)
        }
        continue
      }
      // BY NAME, NEVER BY INDEX - see the module header.
      const imported = new Map(
        (response?.imported || []).map((row) => [String(row?.name || ''), vfxAssetId(row)])
      )
      const skipped = new Map(
        (response?.skipped || []).map((row) => [String(row?.name || ''), String(row?.reason || '')])
      )
      for (const entry of entries) {
        const id = imported.get(entry.filename)
        if (id != null) {
          idsByFile.set(entry.file, id)
          installed.push(entry.filename)
        } else {
          failed.push({
            ...entry.need,
            error: skipped.get(entry.filename) || 'the library did not accept it',
          })
        }
        step(entry.need.name || entry.file)
      }
    }
  }

  const { doc, missing } = applyBundleAssets(bundle.doc, bundle.needs, idsByFile)
  const asset = await saveEffect({ name: effectName, doc, thumbnail: bundle.thumbnail })

  return { asset, name: effectName, installed, reused, failed, missing }
}

/** The library rows the reuse index considers, grouped by the kinds a bundle can carry. */
async function listLibraryRows(listLibrary) {
  try {
    const library = await listLibrary?.()
    return {
      image: library?.images || [],
      mesh: library?.meshes || [],
      vfx: library?.vfx || [],
    }
  } catch {
    // Reuse is an optimisation. A listing that failed means everything gets
    // uploaded, which is correct - just not thrifty.
    return {}
  }
}
