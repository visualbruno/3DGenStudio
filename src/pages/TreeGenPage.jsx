// Procedural Tree Generator workspace.
//
// GLOBAL, not project-scoped, for the same reason the assembly workspace is: a
// tree is a library asset that borrows bark from one project and a leaf atlas
// from another, and forcing it to belong to one of them would be arbitrary.
// Hence /trees with no projectId and a Header nav link.
//
// The interaction model is the whole design. Two request paths, deliberately
// asymmetric:
//   - moving a slider refreshes the SKELETON preview (~100ms, branch lines only)
//   - committing builds the mesh (~1s)
// Scrubbing a slider must never wait on a mesh build, so the cheap thing is
// live and the expensive thing is an explicit button. The most-pressed control
// on the page is the dice, because re-rolling a seed is the main loop.
//
// This file is a shell on purpose: the viewport is TreeViewport, the sliders are
// TreeParamPanel, the schema is treeParams.js, and the transport is
// utils/treeGen.js. The thing being avoided is MeshEditorPage.jsx, which is
// 12k lines because everything went inline.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import TreeViewport from '../components/treeGen/TreeViewport'
import TreeParamPanel from '../components/treeGen/TreeParamPanel'
import TreeTexturePanel from '../components/treeGen/TreeTexturePanel'
import { affectsSkeleton } from '../components/treeGen/treeParams'
import {
  fetchTreePresets, flattenAssetLibrary, generateTree, loadTreePresetAsset, previewTree,
  resolveTextureAssetIds, resolveTextures, rollSeed, saveTreePresetAsset, setSpecValue,
} from '../utils/treeGen'
import AssetSelectorModal from '../components/AssetSelectorModal'
import { createMeshThumbnailFile } from '../utils/meshThumbnail'
import { createZip } from '../utils/zipArchive'
import { useProjects } from '../context/ProjectContext'
import { API_BASE } from '../config'
import './TreeGenPage.css'

// Long enough that dragging a slider does not fire a request per pixel, short
// enough that letting go feels immediate.
const PREVIEW_DEBOUNCE_MS = 220

function formatCount(value) {
  if (value == null) return '—'
  return value.toLocaleString()
}

// Wind data rides in COLOR_0, and glTF defines COLOR_0 as a MULTIPLIER on base
// colour — so a spec-compliant renderer (three.js included) paints the tree with
// branch phase and flutter noise: a green trunk and confetti foliage. The data
// is correct; it is just not a colour. Turn the tint off for the viewport so the
// preview shows the material, while the exported GLB keeps the channel an engine
// wind shader reads.
function stripWindTint(object) {
  object.traverse(node => {
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      if (material?.vertexColors) {
        material.vertexColors = false
        material.needsUpdate = true
      }
    }
  })
  return object
}

export default function TreeGenPage() {
  const { uploadAssetThumbnail } = useProjects()
  const [searchParams, setSearchParams] = useSearchParams()
  // Read once, on the first render: the effect below clears the parameter, and
  // the preset loader has to stay keyed to what the URL originally said.
  const [deepLinkPresetId] = useState(() => searchParams.get('presetAssetId'))
  const [showSettings, setShowSettings] = useState(false)

  const [presets, setPresets] = useState([])
  const [presetId, setPresetId] = useState('oak')
  const [spec, setSpec] = useState(null)

  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState(null)

  const [meshObject, setMeshObject] = useState(null)
  const [meshStats, setMeshStats] = useState(null)
  const [meshBlob, setMeshBlob] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [saveState, setSaveState] = useState(null)

  // { trunk: entry|null, branches: entry|null, leaves: entry[] }
  const [textures, setTextures] = useState({ trunk: null, branches: null, leaves: [] })

  const [presetBusy, setPresetBusy] = useState(false)
  const [variantsRunning, setVariantsRunning] = useState(false)
  const [showPresetPicker, setShowPresetPicker] = useState(false)
  const [notice, setNotice] = useState(null)

  const [frameKey, setFrameKey] = useState(0)
  const [orthographic, setOrthographic] = useState(false)

  const previewAbortRef = useRef(null)
  const generateAbortRef = useRef(null)
  const variantsAbortRef = useRef(null)
  const meshObjectRef = useRef(null)
  const fileInputRef = useRef(null)

  // ---- presets ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    fetchTreePresets()
      .then(list => {
        if (cancelled) return
        setPresets(list)
        // Seeding a default would race the deep-linked preset and, because this
        // request goes out to the Python service, usually WIN — landing after it
        // and replacing the opened tree with a fresh random oak.
        if (deepLinkPresetId) return
        const first = list.find(entry => entry.id === 'oak') || list[0]
        if (first) {
          setPresetId(first.id)
          setSpec({ ...first.spec, seed: rollSeed() })
        }
      })
      .catch(err => !cancelled && setError(err.message))
    return () => { cancelled = true }
  }, [deepLinkPresetId])

  const selectPreset = useCallback(id => {
    const entry = presets.find(p => p.id === id)
    if (!entry) return
    setPresetId(id)
    // Keep the seed across a species change: comparing an oak and a pine grown
    // from the same seed is a genuinely useful thing to do, and re-rolling
    // silently would take it away.
    setSpec(current => ({ ...entry.spec, seed: current?.seed ?? entry.spec.seed }))
  }, [presets])

  // ---- live skeleton preview ------------------------------------------
  useEffect(() => {
    if (!spec) return undefined
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller

    const timer = setTimeout(() => {
      setPreviewing(true)
      previewTree({ spec, signal: controller.signal })
        .then(payload => {
          setPreview(payload)
          setPreviewError(null)
        })
        .catch(err => {
          if (err.name === 'AbortError') return
          setPreviewError(err.message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewing(false)
        })
    }, PREVIEW_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [spec])

  const handleParamChange = useCallback((path, value) => {
    setSpec(current => (current ? setSpecValue(current, path, value) : current))
    // A mesh built from the previous parameters is now a lie about what the
    // panel says. Drop it rather than leave it on screen looking current.
    if (affectsSkeleton(path)) setMeshObject(null)
  }, [])

  const reroll = useCallback(() => {
    setSpec(current => (current ? { ...current, seed: rollSeed() } : current))
    setMeshObject(null)
  }, [])

  // ---- generate --------------------------------------------------------
  const disposeMesh = useCallback(object => {
    object?.traverse?.(node => {
      node.geometry?.dispose?.()
      const material = node.material
      if (Array.isArray(material)) material.forEach(m => m?.dispose?.())
      else material?.dispose?.()
    })
  }, [])

  useEffect(() => {
    // Replacing the drawn object leaves the old GPU buffers allocated; a
    // generator whose main loop is "press generate again" would leak a tree per
    // press without this.
    const previous = meshObjectRef.current
    meshObjectRef.current = meshObject
    if (previous && previous !== meshObject) disposeMesh(previous)
  }, [meshObject, disposeMesh])

  useEffect(() => () => disposeMesh(meshObjectRef.current), [disposeMesh])

  const generate = useCallback(async () => {
    if (!spec || generating) return
    generateAbortRef.current?.abort()
    const controller = new AbortController()
    generateAbortRef.current = controller

    setGenerating(true)
    setError(null)
    setSaveState(null)
    setProgress({ frac: 0, message: 'Starting…' })
    try {
      // Texture bytes are fetched here rather than at pick time, so choosing a
      // handful of leaves costs nothing until a build actually needs them.
      setProgress({ frac: 0, message: 'Loading textures…' })
      const resolved = await resolveTextures(textures, { signal: controller.signal })
      const result = await generateTree({
        spec,
        ...resolved,
        signal: controller.signal,
        onProgress: event => setProgress({ frac: event.frac, message: event.message || event.stage }),
      })
      const url = URL.createObjectURL(result.blob)
      try {
        const gltf = await new GLTFLoader().loadAsync(url)
        setMeshObject(stripWindTint(gltf.scene))
      } finally {
        URL.revokeObjectURL(url)
      }
      setMeshBlob(result.blob)
      setMeshStats(result.stats)
      // The service echoes the resolved spec, seed included. Adopting it is what
      // makes "save" reproducible when the request only named a preset.
      if (result.spec) setSpec(result.spec)
      setFrameKey(key => key + 1)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }, [spec, generating, textures])

  const cancel = useCallback(() => generateAbortRef.current?.abort(), [])

  // Declared here rather than beside the download helpers: the preset handlers
  // below list it as a dependency, and a dependency array is evaluated during
  // render — a `const` declared further down would be in its temporal dead zone
  // and throw before the page ever painted.
  const treeName = useMemo(() => {
    const base = spec?.name || 'Tree'
    return `${base.replace(/\s+/g, '_')}_${spec?.seed ?? 0}`
  }, [spec])

  // ---- tree presets (saved as library assets) --------------------------
  //
  // A saved tree is an asset of type 'tree', not a private list: it shows up in
  // the Assets page with a thumbnail, takes tags, and is picked with the same
  // modal as everything else.

  // Textures are stored as asset references. An UPLOADED file cannot be one —
  // its bytes only ever existed in this tab — so its slot is saved empty rather
  // than as a name that would resolve to nothing later.
  const textureRefs = useMemo(() => ({
    trunk: textures.trunk?.id ?? null,
    branches: textures.branches?.id ?? null,
    leaves: (textures.leaves || []).map(entry => entry.id).filter(Boolean),
  }), [textures])

  // A preset is worth nothing in a visual library without a picture, and the
  // user may never have pressed Generate — so build a mesh here if there is not
  // one already. Textures are irrelevant to this: an untextured tree still
  // thumbnails to a recognisable shape, which is the point.
  const buildThumbnail = useCallback(async (signal) => {
    try {
      let blob = meshBlob
      if (!blob) {
        setNotice('Rendering a preview for the thumbnail…')
        const resolved = await resolveTextures(textures, { signal })
        blob = (await generateTree({ spec, ...resolved, signal })).blob
      }
      return await createMeshThumbnailFile(
        new File([blob], `${treeName}.glb`, { type: 'model/gltf-binary' })
      )
    } catch (err) {
      console.warn('Could not render the tree preset thumbnail', err)
      return null
    }
  }, [meshBlob, spec, textures, treeName])

  const handleSavePreset = useCallback(async () => {
    if (!spec) return
    const name = window.prompt('Save this tree preset as', spec.name || 'Tree')
    if (!name?.trim()) return

    setPresetBusy(true)
    setError(null)
    try {
      const thumbnail = await buildThumbnail(null)
      const asset = await saveTreePresetAsset({
        name: name.trim(),
        spec,
        textureRefs,
        thumbnail,
        stats: meshStats?.tool ?? null,
      })
      setNotice(
        `Saved "${asset?.name || name.trim()}" to Assets → Tree Presets`
        + (thumbnail ? '.' : ' (without a thumbnail).')
      )
    } catch (err) {
      setError(err.message)
    } finally {
      setPresetBusy(false)
    }
  }, [spec, textureRefs, meshStats, buildThumbnail])

  const handleOpenPreset = useCallback(async asset => {
    setShowPresetPicker(false)
    if (!asset) return
    setPresetBusy(true)
    setError(null)
    try {
      const { spec: loadedSpec, textures: refs } = await loadTreePresetAsset(asset)
      setSpec(loadedSpec)
      setPresetId(loadedSpec.preset || '')
      setMeshObject(null)

      // Resolved against the live library, walking EDITS as well as top-level
      // assets: the texture picker shows edits, so a background-removed leaf or
      // a bark map run through Seamless is a child row, and a top-level-only
      // lookup finds none of them.
      const resolved = await resolveTextureAssetIds(refs)
      setTextures({ trunk: resolved.trunk, branches: resolved.branches, leaves: resolved.leaves })
      setNotice(resolved.missing > 0
        ? `Loaded "${asset.name}". ${resolved.missing} texture${resolved.missing === 1 ? '' : 's'} `
          + 'could not be found in the library and were left empty.'
        : `Loaded "${asset.name}".`)
    } catch (err) {
      setError(err.message)
    } finally {
      setPresetBusy(false)
    }
  }, [])

  // Assets -> Tree Presets -> EDIT lands here with ?presetAssetId=<id>.
  //
  // The id is looked up in the library rather than trusted as a path: the preset
  // file carries the spec and its texture references, so the id is all the URL
  // needs to carry, and a stale link fails as a message instead of a bad fetch.
  //
  // Deliberately WITHOUT a cancellation flag. Combining one with the run-once
  // ref is what broke this: StrictMode mounts, cleans up and re-mounts, so the
  // first attempt got cancelled while the second skipped itself as already
  // started, and the preset silently never loaded — leaving a default oak that
  // looks close enough to a successful load to be mistaken for one. The ref
  // alone is the correct guard; a late state update on a still-mounted page is
  // harmless.
  const openedPresetRef = useRef(null)
  useEffect(() => {
    if (!deepLinkPresetId || openedPresetRef.current === deepLinkPresetId) return
    openedPresetRef.current = deepLinkPresetId

    fetch(`${API_BASE}/assets/library`)
      .then(response => response.json())
      .then(library => {
        const asset = flattenAssetLibrary(library).get(Number(deepLinkPresetId))
        if (!asset) throw new Error('That tree preset is no longer in the library.')
        return handleOpenPreset(asset)
      })
      // Cleared only after the load, so a failure leaves the link intact to retry.
      .then(() => setSearchParams({}, { replace: true }))
      .catch(err => setError(err.message))
  }, [deepLinkPresetId, handleOpenPreset, setSearchParams])

  // ---- output ----------------------------------------------------------
  const download = useCallback((blob, filename) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }, [])

  // Batch re-roll: N trees, one new seed each, delivered as a single archive.
  //
  // A zip rather than N downloads because browsers treat repeated programmatic
  // downloads as suspicious — Chrome prompts on the second and can drop the
  // rest — and because a folder of trees is what the user actually wants anyway.
  const handleDownloadVariants = useCallback(async () => {
    if (!spec) return
    if (variantsRunning) {
      variantsAbortRef.current?.abort()
      return
    }

    const answer = window.prompt(
      `How many variants? Each is generated with a new random seed.\n`
      + `About ${(meshStats?.tool?.seconds || 1).toFixed(1)}s each, downloaded as one zip.`,
      '5',
    )
    if (answer === null) return
    const count = Math.max(1, Math.min(50, Math.round(Number(answer) || 0)))

    const controller = new AbortController()
    variantsAbortRef.current = controller
    setVariantsRunning(true)
    setError(null)
    setNotice(null)

    const baseName = (spec.name || 'Tree').replace(/\s+/g, '_')
    const files = []
    const seeds = []
    try {
      // Resolved ONCE. The textures are identical across variants, and fetching
      // and base64-ing them per tree would cost more than the geometry does.
      setProgress({ frac: 0, message: 'Loading textures…' })
      const resolved = await resolveTextures(textures, { signal: controller.signal })

      for (let index = 0; index < count; index += 1) {
        if (controller.signal.aborted) break
        const seed = rollSeed()
        const done = index / count
        setProgress({ frac: done, message: `Variant ${index + 1} of ${count} — seed ${seed}` })
        try {
          const result = await generateTree({
            spec: { ...spec, seed },
            ...resolved,
            signal: controller.signal,
            onProgress: event => setProgress({
              frac: done + (event.frac || 0) / count,
              message: `Variant ${index + 1} of ${count} — ${event.message || event.stage}`,
            }),
          })
          files.push({
            name: `${baseName}_${seed}.glb`,
            data: new Uint8Array(await result.blob.arrayBuffer()),
          })
          seeds.push(seed)
        } catch (variantError) {
          if (variantError.name === 'AbortError') break
          throw variantError
        }
      }

      if (!files.length) {
        setNotice('Cancelled before the first variant finished.')
        return
      }

      // The manifest makes the archive reproducible: the base spec plus the
      // seed of every file in it regenerates the whole set exactly.
      files.push({
        name: 'variants.json',
        data: JSON.stringify({
          generatedAt: new Date().toISOString(),
          name: spec.name || 'Tree',
          count: seeds.length,
          seeds,
          spec,
        }, null, 2),
      })

      setProgress({ frac: 1, message: 'Packing archive…' })
      download(createZip(files), `${baseName}_variants.zip`)
      setNotice(controller.signal.aborted
        ? `Cancelled — downloaded the ${seeds.length} variant${seeds.length === 1 ? '' : 's'} already generated.`
        : `Downloaded ${seeds.length} variant${seeds.length === 1 ? '' : 's'}.`)
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      setVariantsRunning(false)
      setProgress(null)
    }
  }, [spec, textures, variantsRunning, meshStats, download])

  const saveToLibrary = useCallback(async () => {
    if (!meshBlob || !spec) return
    setSaveState({ status: 'saving' })
    try {
      const form = new FormData()
      form.append('file', new File([meshBlob], `${treeName}.glb`, { type: 'model/gltf-binary' }))
      form.append('type', 'mesh')
      form.append('name', treeName)
      // The spec rides in the asset's metadata, which is the point of the whole
      // design: the saved mesh carries the ~2KB document that regenerates it, so
      // it can be reopened here with every slider and the seed restored.
      form.append('metadata', JSON.stringify({
        source: 'TREE GENERATOR',
        treeSpec: spec,
        // Which images were worn, so a saved tree can be rebuilt with the same
        // surface and not just the same shape.
        textureAssetIds: {
          trunk: textures.trunk?.id ?? null,
          branches: textures.branches?.id ?? null,
          leaves: (textures.leaves || []).map(entry => entry.id).filter(Boolean),
        },
        specVersion: spec.version,
        preset: spec.preset ?? presetId,
        stats: meshStats?.tool ?? null,
        savedAt: Date.now(),
      }))
      const response = await fetch(`${API_BASE}/assets/library-upload`, { method: 'POST', body: form })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || 'Could not save the tree')

      // Render a thumbnail so the tree is recognisable in the asset library — a
      // grid of identical placeholder icons is useless once you have made more
      // than two. Best-effort on purpose: the mesh is already saved, and losing
      // the save over a cosmetic render would be the wrong trade.
      setSaveState({ status: 'thumbnailing', assetId: payload?.id ?? null })
      try {
        const thumbnail = await createMeshThumbnailFile(
          new File([meshBlob], `${treeName}.glb`, { type: 'model/gltf-binary' })
        )
        if (thumbnail && payload?.id) await uploadAssetThumbnail(payload.id, thumbnail)
      } catch (thumbError) {
        console.warn('Could not render the tree thumbnail', thumbError)
      }

      setSaveState({ status: 'saved', assetId: payload?.id ?? null })
    } catch (err) {
      setSaveState({ status: 'error', message: err.message })
    }
  }, [meshBlob, spec, treeName, presetId, meshStats, textures, uploadAssetThumbnail])

  const importSpec = useCallback(event => {
    const file = event.target.files?.[0]
    if (!file) return
    file.text()
      .then(text => {
        const parsed = JSON.parse(text)
        setSpec(parsed)
        setPresetId(parsed.preset || '')
        setMeshObject(null)
        setError(null)
      })
      .catch(err => setError(`Could not read that spec: ${err.message}`))
    event.target.value = ''
  }, [])

  const tool = meshStats?.tool
  const bounds = preview?.bounds || null

  return (
    <div className="treegen">
      <Header
        title={spec?.name ? `Tree Generator — ${spec.name}` : 'Tree Generator'}
        centerTitle
        onSettingsClick={() => setShowSettings(true)}
      />

      <div className="treegen__body">
        {/* --- left: species + seed --- */}
        <aside className="treegen__sidebar treegen__sidebar--left">
          <h2 className="treegen__title">Species</h2>
          <div className="treegen__presets">
            {presets.map(entry => (
              <button
                key={entry.id}
                type="button"
                className={`treegen__preset ${presetId === entry.id ? 'treegen__preset--active' : ''}`}
                onClick={() => selectPreset(entry.id)}
              >
                <span className="treegen__preset-label">{entry.label}</span>
                <span className="treegen__preset-meta">{entry.height}m · {entry.crown}</span>
              </button>
            ))}
          </div>

          <h2 className="treegen__title">Seed</h2>
          <div className="treegen__seed-row">
            <input
              type="number"
              min={0}
              max={2147483647}
              value={spec?.seed ?? 0}
              onChange={event => handleParamChange('seed', Number(event.target.value))}
            />
            <button type="button" className="treegen__dice" onClick={reroll} title="Roll a new seed">
              🎲
            </button>
          </div>

          <h2 className="treegen__title">Tree presets</h2>
          <div className="treegen__spec-io">
            <button type="button" onClick={handleSavePreset} disabled={!spec || presetBusy}>
              {presetBusy ? 'Working…' : 'Save preset…'}
            </button>
            <button type="button" onClick={() => setShowPresetPicker(true)} disabled={presetBusy}>
              Open preset…
            </button>
          </div>
          <p className="treegen__saved-empty">
            Saved as an asset with a thumbnail, so presets are browsable under
            Assets → Tree Presets. Textures are stored as references, so an image
            uploaded from disk cannot be saved with one.
          </p>

          <div className="treegen__spec-io">
            <button type="button" onClick={() => fileInputRef.current?.click()}>Import spec…</button>
            <button
              type="button"
              disabled={!spec}
              onClick={() => download(
                new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }),
                `${treeName}.tree.json`,
              )}
            >
              Export spec
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={importSpec}
              hidden
            />
          </div>
        </aside>

        {/* --- centre: viewport --- */}
        <main className="treegen__viewport">
          <div className="treegen__viewport-toolbar">
            <span className="treegen__mode">
              {meshObject ? 'Mesh' : 'Skeleton preview'}
              {previewing && !meshObject && <span className="treegen__spinner" />}
            </span>
            <div className="treegen__toolbar-spacer" />
            <button
              type="button"
              className={orthographic ? 'is-active' : ''}
              onClick={() => setOrthographic(value => !value)}
            >
              {orthographic ? 'Orthographic' : 'Perspective'}
            </button>
            <button type="button" onClick={() => setFrameKey(key => key + 1)}>Frame</button>
            {meshObject && (
              <button type="button" onClick={() => setMeshObject(null)}>Show skeleton</button>
            )}
          </div>

          <TreeViewport
            polylines={preview?.polylines || null}
            meshObject={meshObject}
            bounds={bounds}
            frameKey={frameKey}
            orthographic={orthographic}
            showGrid
          />

          <div className="treegen__actions">
            <button
              type="button"
              className="treegen__generate"
              onClick={generating ? cancel : generate}
              disabled={!spec || variantsRunning}
            >
              {generating ? 'Cancel' : 'Generate mesh'}
            </button>
            {(generating || variantsRunning) && progress && (
              <div className="treegen__progress">
                <div className="treegen__progress-bar" style={{ width: `${(progress.frac || 0) * 100}%` }} />
                <span>{progress.message}</span>
              </div>
            )}
            {meshBlob && !generating && (
              <>
                <button type="button" onClick={() => download(meshBlob, `${treeName}.glb`)}>
                  Download GLB
                </button>
                <button type="button" onClick={handleDownloadVariants}>
                  {variantsRunning ? 'Cancel variants' : 'Download GLB Variants'}
                </button>
                <button type="button" onClick={saveToLibrary} disabled={saveState?.status === 'saving' || variantsRunning}>
                  {saveState?.status === 'saving' ? 'Saving…'
                    : saveState?.status === 'thumbnailing' ? 'Rendering thumbnail…'
                      : saveState?.status === 'saved' ? 'Saved to library ✓' : 'Save to library'}
                </button>
              </>
            )}
          </div>

          {(error || previewError || saveState?.status === 'error') && (
            <p className="treegen__error">{error || previewError || saveState.message}</p>
          )}
          {notice && !error && <p className="treegen__notice">{notice}</p>}
        </main>

        {/* --- right: parameters + stats --- */}
        <aside className="treegen__sidebar treegen__sidebar--right">
          <h2 className="treegen__title">Textures</h2>
          <TreeTexturePanel
            textures={textures}
            onChange={(key, value) => setTextures(current => ({ ...current, [key]: value }))}
          />

          <h2 className="treegen__title">Parameters</h2>
          <TreeParamPanel spec={spec} onChange={handleParamChange} disabled={generating} />

          <h2 className="treegen__title">Stats</h2>
          <dl className="treegen__stats">
            <div><dt>Preview nodes</dt><dd>{formatCount(preview?.stats?.nodes)}</dd></div>
            <div><dt>Preview branches</dt><dd>{formatCount(preview?.stats?.chains)}</dd></div>
            <div><dt>Preview time</dt><dd>{preview ? `${Math.round(preview.stats.seconds * 1000)} ms` : '—'}</dd></div>
            <div className="treegen__stats-rule" />
            <div><dt>Triangles</dt><dd>{formatCount(meshStats?.faceCount)}</dd></div>
            <div><dt>Vertices</dt><dd>{formatCount(meshStats?.vertexCount)}</dd></div>
            <div><dt>Leaf cards</dt><dd>{formatCount(tool?.foliage?.cards)}</dd></div>
            <div><dt>Branch order</dt><dd>{tool?.skeleton?.max_order ?? '—'}</dd></div>
            <div><dt>Draw calls</dt><dd>{tool?.totals?.draw_calls ?? '—'}</dd></div>
            <div><dt>Build time</dt><dd>{tool ? `${tool.seconds.toFixed(2)} s` : '—'}</dd></div>
          </dl>
        </aside>
      </div>

      {showPresetPicker && (
        <AssetSelectorModal
          assetType="tree"
          title="Open a tree preset"
          onSelect={handleOpenPreset}
          onClose={() => setShowPresetPicker(false)}
        />
      )}

      <Footer variant="kanban" />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
