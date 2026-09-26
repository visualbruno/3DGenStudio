import { useEffect, useState } from 'react'
import FolderBrowserDialog from './FolderBrowserDialog'
import {
  EXPORT_FORMATS,
  attachBakedMaps,
  browseFolders,
  exportObject3D,
  isGlbUrl,
  loadGlbBlob,
  loadObject3DFromUrl,
  lodFileName,
  measureUvHealth,
  mergeCollisionForUnreal,
  object3DHasUvs,
  sanitizeBaseName,
  uvsAreBroken,
  writeExportedFiles
} from '../utils/meshExport'
import {
  BAKE_MAP_LABELS,
  COLLISION_METHOD_OPTIONS,
  DEFAULT_BAKE_OPTIONS,
  DEFAULT_COLLISION_OPTIONS,
  DEFAULT_INSPECT_OPTIONS,
  DEFAULT_SIMPLIFY_OPTIONS,
  DEFAULT_AUTO_UV_OPTIONS,
  autoUv,
  bakeMaps,
  convertMesh,
  defaultLodRatios,
  ensureDesktopService,
  generateCollision,
  generateLods,
  inspectMesh
} from '../utils/meshTools'
import {
  DEFAULT_FLATTEN_OPTIONS,
  FLATTEN_SHADERS,
  flattenMeshMaterials,
  toUnlitGlb
} from '../utils/meshFlatten'
import './ExportMeshDialog.css'

const LAST_OUTPUT_FOLDER_KEY = 'exportMeshDialog:lastOutputFolder'

// Bake request order. 'orm' is never requested — the service packs it from
// ao/roughness/metallic — but it does come back in the result.
const LOD_BAKE_MAPS = ['normal', 'ao', 'base_color', 'roughness', 'metallic']

// Bake resolution for one level. Halving per level is what an engine wants
// anyway (LOD3 covers a fraction of LOD1's pixels), and it is what keeps a
// five-level chain from costing five full-resolution Blender bakes. Floors at
// 512 so the deepest level still has somewhere for a normal map to live.
function lodBakeResolution(base, level, falloff) {
  if (!falloff) return base
  return Math.max(512, Math.round(base / 2 ** Math.max(0, level - 1)))
}

// Reusable export popup. Provide either `getObject3D` (an async function that
// returns the in-memory THREE.Object3D to export) or `meshUrl` (a mesh URL the
// dialog loads itself). `defaultName` seeds the output file name.
//
// Engine presets (Blender/Unity/Unreal/FBX) are only offered in `meshUrl` mode:
// they exist to carry the rig + animation clips of saved assets, while
// `getObject3D` callers (the mesh editor) hand over rig-free geometry.
export default function ExportMeshDialog({ getObject3D, meshUrl, defaultName = 'mesh', onClose }) {
  const [format, setFormat] = useState('glb')
  const [fileName, setFileName] = useState(sanitizeBaseName(defaultName))
  const [outputFolder, setOutputFolder] = useState('')
  const [showFolderBrowser, setShowFolderBrowser] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Game-ready extras. All three are opt-in: they cost real time (gltfpack runs
  // once per level, CoACD is seconds, the check uploads the mesh) and most
  // exports do not need them.
  const [lodEnabled, setLodEnabled] = useState(false)
  const [lodLevels, setLodLevels] = useState(4)
  // Re-bake the original's textures onto each simplified level. Off by default:
  // it is the single most expensive thing this dialog can do (one headless
  // Blender bake per level, serialized by the service).
  const [bakeEnabled, setBakeEnabled] = useState(false)
  const [bakeMapNames, setBakeMapNames] = useState(['normal', 'ao', 'base_color'])
  const [bakeResolution, setBakeResolution] = useState(2048)
  const [bakeSamples, setBakeSamples] = useState(DEFAULT_BAKE_OPTIONS.samples)
  const [bakeFalloff, setBakeFalloff] = useState(true)
  // On by default: a bake onto a scrambled layout is worse than no bake at all,
  // and by the time you can see that, the export has already cost minutes.
  const [reunwrapBroken, setReunwrapBroken] = useState(true)
  // How gltfpack is driven for the levels above. Only reachable while the chain
  // is on, because this dialog runs the simplifier nowhere else.
  const [simplifyOptions, setSimplifyOptions] = useState({
    allow_seam_breaking: false,
    ...DEFAULT_SIMPLIFY_OPTIONS,
  })
  // Mobile: bake every material's full PBR look into ONE lit albedo. Opt-in and
  // expensive (a lit Cycles bake), and it replaces the materials, so it must
  // never be something an export does by default.
  const [flattenEnabled, setFlattenEnabled] = useState(false)
  const [flattenShader, setFlattenShader] = useState(DEFAULT_FLATTEN_OPTIONS.shader)
  const [flattenResolution, setFlattenResolution] = useState(DEFAULT_FLATTEN_OPTIONS.resolution)
  const [flattenSamples, setFlattenSamples] = useState(DEFAULT_FLATTEN_OPTIONS.samples)
  const [flattenExposure, setFlattenExposure] = useState(DEFAULT_FLATTEN_OPTIONS.exposure)
  const [collisionEnabled, setCollisionEnabled] = useState(false)
  const [collisionMethod, setCollisionMethod] = useState(DEFAULT_COLLISION_OPTIONS.method)
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState(null)

  const formats = getObject3D ? EXPORT_FORMATS.filter(entry => entry.kind === 'local') : EXPORT_FORMATS
  const selectedFormat = formats.find(entry => entry.value === format) || formats[0]
  const lodRatios = defaultLodRatios(lodLevels)
  // Unreal is the one target that wants collision *inside* the render mesh file,
  // under its UCX naming convention. Everywhere else it ships as its own file.
  const embedsCollision = collisionEnabled && selectedFormat.preset === 'unreal'
  const setSimplifyOption = (key, value) => setSimplifyOptions(prev => ({ ...prev, [key]: value }))
  const selectedFlattenShader = FLATTEN_SHADERS.find(entry => entry.value === flattenShader) || FLATTEN_SHADERS[0]
  // Only GLB can say "unlit"; every other format gets the rough non-metal
  // material the flatten produces, which imports as a plain textured diffuse.
  const writesUnlit = flattenEnabled && flattenShader === 'unlit'
  // A flattened source has one channel left worth transferring, so a level
  // re-bake carries just that one: a normal or ORM map would feed a PBR shader
  // the flatten exists to avoid.
  const effectiveBakeMaps = flattenEnabled
    ? (bakeMapNames.length ? ['base_color'] : [])
    : bakeMapNames
  // The extras only outgrow a single column once one of them is expanded (or a
  // check report is on screen); until then the dialog stays a narrow form.
  const wideLayout = lodEnabled || collisionEnabled || flattenEnabled || !!report
  // The simplifier column exists only while there are levels to simplify.
  const showSimplifyColumn = lodEnabled

  // Recall the last folder used, but drop it silently if it no longer exists.
  useEffect(() => {
    const saved = localStorage.getItem(LAST_OUTPUT_FOLDER_KEY)
    if (!saved) return
    browseFolders(saved)
      .then(() => setOutputFolder(saved))
      .catch(() => localStorage.removeItem(LAST_OUTPUT_FOLDER_KEY))
  }, [])

  // Source GLB for the preset paths. When the asset is already a .glb, use its
  // original bytes (perfect fidelity — skin weights, clips and textures
  // untouched); otherwise serialize through three.js, which now carries the
  // loaded animations onto the exported GLB.
  const getSourceGlbBlob = async base => {
    if (!getObject3D && meshUrl && isGlbUrl(meshUrl)) {
      const response = await fetch(meshUrl)
      if (!response.ok) {
        throw new Error('Could not fetch the source mesh.')
      }
      return await response.blob()
    }
    const object = getObject3D ? await getObject3D() : await loadObject3DFromUrl(meshUrl)
    if (!object) {
      throw new Error('No mesh is available to export.')
    }
    const files = await exportObject3D(object, { format: 'glb', baseName: base })
    return files[0].blob
  }

  // Run the Game-Ready check against exactly the mesh that is about to be
  // written. Read-only — it never blocks or changes the export, it only tells you
  // what an engine will complain about before you find out in the engine.
  const handleCheck = async () => {
    setChecking(true)
    setError('')
    setReport(null)
    try {
      await ensureDesktopService('meshtools')
      const base = sanitizeBaseName(fileName)
      const glbBlob = await getSourceGlbBlob(base)
      setReport(await inspectMesh(glbBlob, {
        options: DEFAULT_INSPECT_OPTIONS,
        fileName: `${base}.glb`,
      }))
    } catch (err) {
      setError(err.message || 'The Game-Ready check failed.')
    } finally {
      setChecking(false)
    }
  }

  // Turn one source GLB into the file(s) the selected format needs. Used for
  // every artefact that starts life as a GLB blob — the simplified LOD levels and
  // the collision hulls — so they all land in the same format as the main export.
  const filesFromGlb = async (glbBlob, base, onProgress) => {
    if (selectedFormat.value === 'glb') {
      return [{ filename: `${base}.glb`, blob: writesUnlit ? await toUnlitGlb(glbBlob, base) : glbBlob }]
    }
    if (selectedFormat.kind === 'preset') {
      const { blob } = await convertMesh(glbBlob, {
        options: { preset: selectedFormat.preset },
        fileName: `${base}.glb`,
        onProgress,
      })
      return [{ filename: `${base}.${selectedFormat.extension}`, blob }]
    }
    const object = await loadGlbBlob(glbBlob)
    return await exportObject3D(object, { format: selectedFormat.value, baseName: base })
  }

  const handleExport = async () => {
    const folder = outputFolder.trim()
    const base = sanitizeBaseName(fileName)

    if (!folder) {
      setError('Choose an output folder first.')
      return
    }

    setExporting(true)
    setError('')
    setSuccess('')
    setProgress(null)

    try {
      const files = []
      const notes = []
      const needsService = selectedFormat.kind === 'preset' || lodEnabled || collisionEnabled || flattenEnabled
      // LOD0 keeps the primary file's name unless a chain was requested.
      const primaryBase = lodEnabled ? lodFileName(base, 0) : base

      if (needsService) {
        setProgress({ frac: 0.03, message: 'Starting the Mesh Tools service…' })
        await ensureDesktopService('meshtools')
      }

      // The extras all derive from one source GLB, generated once.
      let sourceGlb = null
      if (lodEnabled || collisionEnabled || flattenEnabled || selectedFormat.value === 'glb' || selectedFormat.kind === 'preset') {
        setProgress({ frac: 0.06, message: 'Preparing source GLB…' })
        sourceGlb = await getSourceGlbBlob(base)
      }

      // ── Flatten to one lit albedo ──────────────────────────────────────────
      // First, because everything after it — LODs, collision, the format
      // conversion — should work from the mesh that actually ships. The result
      // replaces the source GLB outright: same geometry, same rig and clips, one
      // material with one texture.
      if (flattenEnabled) {
        const flat = await flattenMeshMaterials(sourceGlb, {
          shader: flattenShader,
          resolution: flattenResolution,
          samples: flattenSamples,
          exposure: flattenExposure,
          baseName: base,
          onProgress: evt => setProgress({
            frac: 0.07 + 0.05 * (evt.frac ?? 0),
            message: evt.message || 'Flattening materials…',
          }),
        })
        sourceGlb = flat.blob
        notes.push(`flattened to one ${flattenResolution}px lit albedo`
          + (flat.atlas.repacked ? ` (${flat.atlas.islands.toLocaleString()} UV islands repacked)` : ' (original UV layout kept)'))
        // More than one only when parts differ in culling or transparency; they
        // all share the texture.
        if (flat.materialCount > 1) {
          notes.push(`${flat.materialCount} materials sharing it (parts differ in sidedness or transparency)`)
        }
        if (flat.atlas.unmapped) {
          notes.push(`${flat.atlas.unmapped.toLocaleString()} triangle${flat.atlas.unmapped === 1 ? '' : 's'} without usable UVs mapped one by one`)
        }
        if (flat.stats?.has_alpha) notes.push('alpha kept')
        // Worth saying: a tenth of the texels flattened at the shoulder of the
        // tone curve means the exposure is washing the brightest parts out.
        if ((flat.stats?.clipped_frac || 0) > 0.1) {
          notes.push(`${Math.round(flat.stats.clipped_frac * 100)}% of the albedo hit the highlight roll-off — lower the exposure if it looks washed out`)
        }
      }

      // Simplify from the ORIGINAL source, before any collision merge — hulls
      // must not be fed to the simplifier.
      let lods = []
      if (lodEnabled) {
        setProgress({ frac: 0.12, message: `Generating ${lodRatios.length} LOD levels…` })
        lods = await generateLods(sourceGlb, {
          ratios: lodRatios,
          // Without these the chain ran on backend defaults, so the simplifier
          // settings shown here had no way to reach it.
          allowSeamBreaking: !!simplifyOptions.allow_seam_breaking,
          simplify: simplifyOptions,
          fileName: `${base}.glb`,
          onProgress: evt => setProgress({ frac: 0.12 + 0.1 * (evt.frac ?? 0), message: evt.message }),
        })
      }

      // Levels that were actually simplified. LOD0 is `passthrough` — the source
      // bytes, textures included — so it never needs a bake and never gets one.
      const reduced = lods.filter(lod => !lod.passthrough)

      // ── Re-bake the original's textures onto each level ────────────────────
      // Simplification moves vertices and can weld UV seams, so the source
      // texture stops landing where it did and the level looks smeared. Baking
      // from the original mesh onto the simplified UVs is the fix.
      if (bakeEnabled && reduced.length && effectiveBakeMaps.length) {
        const span = 0.28 / reduced.length
        for (let index = 0; index < reduced.length; index += 1) {
          const lod = reduced[index]
          const resolution = lodBakeResolution(bakeResolution, lod.level, bakeFalloff)
          const levelBase = lodFileName(base, lod.level)
          const at = 0.22 + span * index
          setProgress({
            frac: at,
            message: `Baking LOD${lod.level} textures at ${resolution}px (${index + 1}/${reduced.length})…`,
          })
          // Kept so a failed bake can put the level back. Re-unwrapping moves
          // where the existing texture lands, so a level that got new UVs but no
          // new texture is worse off than one that was left alone — and a bake
          // failure below is explicitly non-fatal.
          const blobBeforeUnwrap = lod.blob
          try {
            // Load first so a UV-less mesh is caught before a multi-minute bake,
            // and so the scene the maps attach to is the one already in hand.
            let scene = await loadGlbBlob(lod.blob)

            // A bake writes each triangle where the UV layout says it goes, so
            // baking onto a scrambled layout faithfully reproduces the scramble —
            // the level comes back a kaleidoscope no matter how good the bake was.
            // Re-unwrapping first is the only fix, and it has to happen here,
            // before the maps are generated against the old layout.
            //
            // Measured rather than inferred from `seamsBroken`: that flag knows
            // which pass gltfpack ran, not whether the UVs are usable, so it
            // misses a source whose layout was already broken on the way in. Both
            // are checked, because each catches what the other cannot.
            const health = measureUvHealth(scene)
            const brokenUvs = uvsAreBroken(health) || !!lod.seamsBroken
            if (brokenUvs && reunwrapBroken) {
              setProgress({ frac: at, message: `Re-unwrapping LOD${lod.level} before baking…` })
              const unwrapped = await autoUv(lod.blob, {
                options: DEFAULT_AUTO_UV_OPTIONS,
                fileName: `${levelBase}.glb`,
                onProgress: evt => setProgress({
                  frac: at,
                  message: `Re-unwrapping LOD${lod.level} — ${evt.message || 'working…'}`,
                }),
              })
              // The level ships with these UVs, so the bake target and the file
              // written at the end have to be the same mesh.
              lod.blob = unwrapped.blob
              lod.reunwrapped = true
              scene = await loadGlbBlob(lod.blob)
            }

            if (!object3DHasUvs(scene)) {
              notes.push('texture bake skipped — the mesh has no UVs to bake onto')
              break
            }
            const { maps, stats } = await bakeMaps(lod.blob, sourceGlb, {
              options: {
                ...DEFAULT_BAKE_OPTIONS,
                maps: effectiveBakeMaps,
                resolution,
                samples: bakeSamples,
              },
              fileName: `${levelBase}.glb`,
              sourceName: `${base}.glb`,
              onProgress: evt => setProgress({
                frac: at + span * (evt.frac ?? 0),
                message: `Baking LOD${lod.level} (${index + 1}/${reduced.length}) — ${evt.message || 'working…'}`,
              }),
            })
            await attachBakedMaps(scene, maps, { ormChannels: stats?.orm_channels || [] })
            const baked = await exportObject3D(scene, { format: 'glb', baseName: levelBase })
            lod.blob = baked[0].blob
            lod.baked = true
          } catch (bakeError) {
            // A failed bake must not cost the export. The level still ships — it
            // just keeps the textures simplification left it with.
            console.error(`Baking LOD${lod.level} failed:`, bakeError)
            if (lod.reunwrapped) {
              // Undo the unwrap along with it: new UVs without the bake that was
              // supposed to fill them would ship the old texture in the wrong
              // places, which is a worse mesh than the one we started with.
              lod.blob = blobBeforeUnwrap
              lod.reunwrapped = false
            }
            notes.push(`LOD${lod.level} bake failed (${bakeError.message || 'unknown error'}), so that level keeps its simplified textures`)
          }
        }
        const bakedCount = reduced.filter(lod => lod.baked).length
        if (bakedCount) {
          notes.push(`${bakedCount} level${bakedCount === 1 ? '' : 's'} re-baked from the original`)
        }
        const unwrappedCount = reduced.filter(lod => lod.reunwrapped).length
        if (unwrappedCount) {
          notes.push(`${unwrappedCount} level${unwrappedCount === 1 ? '' : 's'} re-unwrapped before baking (their UVs were unusable)`)
        }
      }

      let collisionGlb = null
      if (collisionEnabled) {
        setProgress({ frac: 0.5, message: 'Generating collision hulls…' })
        const { blob, stats } = await generateCollision(sourceGlb, {
          options: { ...DEFAULT_COLLISION_OPTIONS, method: collisionMethod },
          fileName: `${base}.glb`,
          onProgress: evt => setProgress({
            frac: 0.5 + 0.12 * (evt.frac ?? 0),
            message: evt.message || 'Generating collision hulls…',
          }),
        })
        collisionGlb = blob
        const tool = stats?.tool
        if (tool) {
          notes.push(`${tool.parts} collision hull${tool.parts === 1 ? '' : 's'}`)
          if (tool.fallback) notes.push(tool.fallback)
        }
      }

      // ── Primary file (LOD0) ────────────────────────────────────────────────
      // LOD0 is the source mesh, so it needs no bake — but it does need the
      // resolution the bake was asked for. Without this a chain whose every
      // simplified level is 1024px still ships a 4096px LOD0, which reads as the
      // setting having been ignored (and hands the engine a chain whose biggest
      // texture belongs to the level that is on screen least). Resampling is the
      // whole job here: LOD0's UVs are the source's, so the image only has to
      // get smaller — no rays, no Blender, no round trip through the service.
      let primaryGlb = sourceGlb
      const primaryResolution = bakeEnabled && effectiveBakeMaps.length
        ? lodBakeResolution(bakeResolution, 0, bakeFalloff)
        : 0
      if (lodEnabled && primaryResolution) {
        setProgress({ frac: 0.6, message: `Resampling LOD0 textures to ${primaryResolution}px…` })
        try {
          const object = await loadGlbBlob(sourceGlb)
          const resampled = await exportObject3D(object, {
            format: 'glb',
            baseName: primaryBase,
            maxTextureSize: primaryResolution,
          })
          primaryGlb = resampled[0].blob
        } catch (resampleError) {
          // Same contract as a failed bake: the level still ships, at the
          // resolution it already had.
          console.error('Resampling the LOD0 textures failed:', resampleError)
          notes.push(`LOD0 textures kept their original resolution (${resampleError.message || 'resampling failed'})`)
        }
      }

      setProgress({ frac: 0.62, message: 'Exporting the mesh…' })
      if (embedsCollision) {
        // Unreal: the hulls have to travel inside the render mesh, so the primary
        // file is rebuilt from a merged GLB rather than the untouched source.
        const merged = await mergeCollisionForUnreal(primaryGlb, collisionGlb, primaryBase)
        files.push(...await filesFromGlb(merged.blob, primaryBase, evt => setProgress({
          frac: 0.62 + 0.23 * (evt.frac ?? 0),
          message: evt.message || 'Converting to FBX…',
        })))
        notes.push(`${merged.hullCount} UCX collision node${merged.hullCount === 1 ? '' : 's'} embedded`)
      } else if (selectedFormat.value === 'glb') {
        // Byte-passthrough when the source is a .glb (rig/animations/textures
        // untouched); three.js re-export otherwise — or the resampled copy above,
        // when a bake resolution was asked for.
        files.push(...await filesFromGlb(primaryGlb, primaryBase))
      } else if (selectedFormat.kind !== 'preset') {
        // A flattened export has to write the flattened mesh, not re-read the
        // original with its PBR materials.
        const object = flattenEnabled
          ? await loadGlbBlob(sourceGlb)
          : (getObject3D ? await getObject3D() : await loadObject3DFromUrl(meshUrl))
        if (!object) {
          throw new Error('No mesh is available to export.')
        }
        // No maxTextureSize: this branch is PLY/STL/OBJ, none of which embed the
        // texture the way GLB does.
        files.push(...await exportObject3D(object, { format: selectedFormat.value, baseName: primaryBase }))
      } else {
        const { blob, stats } = await convertMesh(primaryGlb, {
          options: { preset: selectedFormat.preset },
          fileName: `${primaryBase}.glb`,
          onProgress: evt => setProgress({
            frac: 0.62 + 0.23 * (evt.frac ?? 0),
            message: evt.message || 'Converting to FBX…',
          }),
        })
        files.push({ filename: `${primaryBase}.fbx`, blob })
        const tool = stats?.tool
        if (tool) {
          const clipCount = Array.isArray(tool.clips) ? tool.clips.length : 0
          notes.push(`${tool.bones || 0} bones, ${clipCount} animation clip${clipCount === 1 ? '' : 's'}`)
        }
      }

      // ── Remaining LOD levels ───────────────────────────────────────────────
      for (let index = 0; index < reduced.length; index += 1) {
        const lod = reduced[index]
        const span = 0.1 / Math.max(1, reduced.length)
        setProgress({
          frac: 0.85 + span * index,
          message: `Exporting LOD${lod.level} (${lod.triangles ? lod.triangles.toLocaleString() : '…'} triangles)…`,
        })
        files.push(...await filesFromGlb(lod.blob, lodFileName(base, lod.level)))
      }
      if (reduced.length) {
        notes.push(`${reduced.length + 1} LOD levels`)
      }
      // Say so when a level could not reach its target. The files are still
      // written and still valid — they are just coarser than requested, and
      // silently shipping an LOD3 that is barely smaller than LOD0 is worse than
      // saying why.
      const seamLimited = lods.filter(lod => lod.seamLimited).length
      if (seamLimited) {
        notes.push(`${seamLimited} level${seamLimited === 1 ? '' : 's'} stopped short of target — raise the error budget, or allow attribute seams to break`)
      }
      // Worth its own note: this is the one outcome that changes how the level is
      // shaded, and it is easy to miss in a folder of files that all look right.
      const seamsBroken = lods.filter(lod => lod.seamsBroken).length
      if (seamsBroken) {
        notes.push(`${seamsBroken} level${seamsBroken === 1 ? '' : 's'} welded attribute seams — check the hard edges and the texture`)
      }

      // ── Standalone collision file ──────────────────────────────────────────
      if (collisionEnabled && !embedsCollision) {
        setProgress({ frac: 0.96, message: 'Exporting collision hulls…' })
        files.push(...await filesFromGlb(collisionGlb, `${base}_collision`))
      }

      setProgress({ frac: 0.97, message: 'Writing files…' })
      const result = await writeExportedFiles(folder, files)
      localStorage.setItem(LAST_OUTPUT_FOLDER_KEY, folder)
      const writtenNames = (result?.written || files.map(file => file.filename)).join(', ')
      const noteText = notes.length ? ` — ${notes.join(', ')}` : ''
      setSuccess(`Exported ${files.length} file${files.length === 1 ? '' : 's'}: ${writtenNames}${noteText}`)
    } catch (err) {
      setError(err.message || 'Failed to export the mesh.')
    } finally {
      setExporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="export-mesh-overlay" role="presentation" onClick={onClose}>
      <div
        className={`export-mesh${wideLayout ? ' export-mesh--wide' : ''}${showSimplifyColumn ? ' export-mesh--wide3' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Export mesh"
        onClick={event => event.stopPropagation()}
      >
        <div className="export-mesh__header">
          <h3 className="export-mesh__title font-headline">Export mesh</h3>
          <button type="button" className="export-mesh__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="export-mesh__body">
          <div className="export-mesh__columns">
            <div className="export-mesh__column">
              <label className="export-mesh__field">
                <span className="export-mesh__label">Format</span>
                <select
                  className="export-mesh__select"
                  value={format}
                  onChange={event => { setFormat(event.target.value); setSuccess('') }}
                >
                  {formats.map(entry => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </select>
              </label>

              <label className="export-mesh__field">
                <span className="export-mesh__label">File name</span>
                <div className="export-mesh__filename-row">
                  <input
                    className="export-mesh__input"
                    value={fileName}
                    onChange={event => setFileName(event.target.value)}
                    spellCheck={false}
                  />
                  <span className="export-mesh__ext">.{selectedFormat.extension}</span>
                </div>
              </label>

              <label className="export-mesh__field">
                <span className="export-mesh__label">Output folder</span>
                <div className="export-mesh__folder-row">
                  <input
                    className="export-mesh__input"
                    value={outputFolder}
                    onChange={event => setOutputFolder(event.target.value)}
                    placeholder="Choose a folder to export to"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="export-mesh__browse"
                    onClick={() => setShowFolderBrowser(true)}
                  >
                    <span className="material-symbols-outlined">folder_open</span>
                    Browse
                  </button>
                </div>
              </label>

              {selectedFormat.hint && (
                <p className="export-mesh__hint">{selectedFormat.hint}</p>
              )}
            </div>

            <div className="export-mesh__column">
              <div className="export-mesh__extras">
                <label className="export-mesh__check">
                  <input
                    type="checkbox"
                    checked={flattenEnabled}
                    onChange={event => { setFlattenEnabled(event.target.checked); setSuccess('') }}
                  />
                  <span>Flatten to one lit albedo (mobile)</span>
                </label>
                {flattenEnabled && (
                  <div className="export-mesh__extra-body">
                    <label className="export-mesh__inline-field">
                      <span>Target shader</span>
                      <select
                        className="export-mesh__select export-mesh__select--inline"
                        value={flattenShader}
                        onChange={event => setFlattenShader(event.target.value)}
                      >
                        {FLATTEN_SHADERS.map(entry => (
                          <option key={entry.value} value={entry.value}>{entry.label}</option>
                        ))}
                      </select>
                    </label>
                    <p className="export-mesh__hint">{selectedFlattenShader.hint}</p>
                    <label className="export-mesh__inline-field">
                      <span>Resolution</span>
                      <select
                        className="export-mesh__select export-mesh__select--inline"
                        value={String(flattenResolution)}
                        onChange={event => setFlattenResolution(Number(event.target.value))}
                      >
                        {[512, 1024, 2048, 4096].map(n => (
                          <option key={n} value={String(n)}>{n} × {n}</option>
                        ))}
                      </select>
                    </label>
                    <label className="export-mesh__inline-field">
                      <span>Samples</span>
                      <select
                        className="export-mesh__select export-mesh__select--inline"
                        value={String(flattenSamples)}
                        onChange={event => setFlattenSamples(Number(event.target.value))}
                      >
                        {[16, 32, 64, 128, 256].map(n => (
                          <option key={n} value={String(n)}>{n}{n === 16 ? ' (preview)' : ''}</option>
                        ))}
                      </select>
                    </label>
                    <label className="export-mesh__inline-field">
                      <span>Exposure</span>
                      <input
                        className="export-mesh__input export-mesh__input--inline"
                        type="number"
                        min={-3}
                        max={3}
                        step={0.25}
                        value={flattenExposure}
                        onChange={event => setFlattenExposure(Math.min(3, Math.max(-3, Number(event.target.value) || 0)))}
                      />
                      <span className="export-mesh__hint">stops</span>
                    </label>
                    <p className="export-mesh__hint">
                      Bakes the normal detail, occlusion, roughness and metal of every material into a
                      single colour texture under a neutral studio light, then gives every mesh a
                      material that uses it. Specular highlights and cast shadows are left out on
                      purpose: they belong to one camera and one light, and baked in they would stay
                      stuck on the surface. Metals keep their colour. The existing UV islands are
                      repacked into one atlas rather than re-unwrapped, so a rig, its skin weights and
                      its animation clips come through unchanged.
                    </p>
                    <p className="export-mesh__hint">
                      Runs a lit Cycles bake on the Mesh Tools service: seconds for a prop at 64
                      samples, a few minutes for a dense character at 4096px. Raise the samples if
                      cavities look grainy.
                    </p>
                  </div>
                )}

                <label className="export-mesh__check">
                  <input
                    type="checkbox"
                    checked={lodEnabled}
                    onChange={event => { setLodEnabled(event.target.checked); setSuccess('') }}
                  />
                  <span>Generate LOD chain</span>
                </label>
                {lodEnabled && (
                  <div className="export-mesh__extra-body">
                    <label className="export-mesh__inline-field">
                      <span>Levels</span>
                      <select
                        className="export-mesh__select export-mesh__select--inline"
                        value={String(lodLevels)}
                        onChange={event => setLodLevels(Number(event.target.value))}
                      >
                        {[2, 3, 4, 5, 6].map(n => <option key={n} value={String(n)}>{n}</option>)}
                      </select>
                    </label>
                    <p className="export-mesh__hint">
                      Writes {lodRatios.map((_, index) => `${sanitizeBaseName(fileName)}_LOD${index}`).join(', ')}
                      {' '}at {lodRatios.map(r => `${Math.round(r * 100)}%`).join(' / ')} of the source triangle count.
                      Each level is simplified from the original, not from the level above it.
                    </p>

                    <label className="export-mesh__check">
                      <input
                        type="checkbox"
                        checked={bakeEnabled}
                        onChange={event => { setBakeEnabled(event.target.checked); setSuccess('') }}
                      />
                      <span>Bake textures from the original</span>
                    </label>
                    {bakeEnabled && (
                      <div className="export-mesh__extra-body">
                        {flattenEnabled && (
                          <p className="export-mesh__hint">
                            With the flatten on, each level re-bakes the flattened albedo only — it
                            is the one channel the shipped material has.
                          </p>
                        )}
                        <div className="export-mesh__map-row" style={flattenEnabled ? { display: 'none' } : undefined}>
                          {LOD_BAKE_MAPS.map(name => (
                            <label className="export-mesh__check" key={name}>
                              <input
                                type="checkbox"
                                checked={bakeMapNames.includes(name)}
                                onChange={event => setBakeMapNames(event.target.checked
                                  // Keep the service's request order rather than click order.
                                  ? LOD_BAKE_MAPS.filter(entry => entry === name || bakeMapNames.includes(entry))
                                  : bakeMapNames.filter(entry => entry !== name))}
                              />
                              <span>{BAKE_MAP_LABELS[name] || name}</span>
                            </label>
                          ))}
                        </div>
                        <label className="export-mesh__inline-field">
                          <span>Resolution</span>
                          <select
                            className="export-mesh__select export-mesh__select--inline"
                            value={String(bakeResolution)}
                            onChange={event => setBakeResolution(Number(event.target.value))}
                          >
                            {[512, 1024, 2048, 4096].map(n => (
                              <option key={n} value={String(n)}>{n} × {n}</option>
                            ))}
                          </select>
                        </label>
                        <label className="export-mesh__inline-field">
                          <span>Samples</span>
                          <input
                            className="export-mesh__input export-mesh__input--inline"
                            type="number"
                            min={1}
                            max={512}
                            step={1}
                            value={bakeSamples}
                            onChange={event => setBakeSamples(Math.min(512, Math.max(1, Number(event.target.value) || 1)))}
                          />
                          <span className="export-mesh__hint">Only the AO pass needs more than a few</span>
                        </label>
                        <label className="export-mesh__check">
                          <input
                            type="checkbox"
                            checked={bakeFalloff}
                            onChange={event => setBakeFalloff(event.target.checked)}
                          />
                          <span>Halve the resolution each level</span>
                        </label>
                        <label className="export-mesh__check">
                          <input
                            type="checkbox"
                            checked={reunwrapBroken}
                            onChange={event => setReunwrapBroken(event.target.checked)}
                          />
                          <span>Re-unwrap levels whose UVs are unusable</span>
                        </label>
                        <p className="export-mesh__hint">
                          Checks each level&apos;s UV layout before baking and runs Auto UV on the ones
                          that come back contested — where two surfaces claim the same texels, which
                          is what the aggressive simplifier leaves behind. Baking onto that layout
                          reproduces it exactly, so the bake alone cannot save the level; it needs
                          new UVs first. Adds an unwrap per affected level, and replaces that
                          level&apos;s UVs in the exported file.
                        </p>
                        <p className="export-mesh__hint">
                          Bakes {effectiveBakeMaps.length ? effectiveBakeMaps.map(name => BAKE_MAP_LABELS[name] || name).join(', ') : 'nothing'}
                          {' '}from the unsimplified mesh onto each level&apos;s own UVs, at{' '}
                          {lodRatios.slice(1).map((_, index) => `${lodBakeResolution(bakeResolution, index + 1, bakeFalloff)}px`).join(' / ')}.
                          LOD0 is the source, so it is never baked — its geometry and UVs are
                          untouched and its textures are simply resampled to{' '}
                          {lodBakeResolution(bakeResolution, 0, bakeFalloff)}px, so the whole chain
                          honours the resolution you picked. This is what fixes the smearing you get
                          when a simplified mesh reuses the original texture — levels whose UV seams
                          had to be welded need it most.
                        </p>
                        <p className="export-mesh__hint">
                          Runs headless Blender on the Mesh Tools service, one level at a time — a
                          high-resolution AO bake against a dense mesh takes minutes per level.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <label className="export-mesh__check">
                  <input
                    type="checkbox"
                    checked={collisionEnabled}
                    onChange={event => { setCollisionEnabled(event.target.checked); setSuccess('') }}
                  />
                  <span>Generate collision mesh</span>
                </label>
                {collisionEnabled && (
                  <div className="export-mesh__extra-body">
                    <label className="export-mesh__inline-field">
                      <span>Method</span>
                      <select
                        className="export-mesh__select export-mesh__select--inline"
                        value={collisionMethod}
                        onChange={event => setCollisionMethod(event.target.value)}
                      >
                        {COLLISION_METHOD_OPTIONS.map(option => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <p className="export-mesh__hint">
                      {embedsCollision
                        ? `Hulls are embedded in the FBX as UCX_${sanitizeBaseName(fileName)}_01… nodes, which Unreal picks up automatically on import.`
                        : `Written as a separate ${sanitizeBaseName(fileName)}_collision file. In Unity, add it under a Mesh Collider with Convex enabled.`}
                    </p>
                  </div>
                )}

                <div className="export-mesh__check-row">
                  <button
                    type="button"
                    className="export-mesh__btn export-mesh__btn--secondary"
                    onClick={handleCheck}
                    disabled={checking || exporting}
                    title="Analyze this mesh against engine-readiness budgets before exporting"
                  >
                    {checking ? 'Checking…' : 'Run Game-Ready check'}
                  </button>
                  {report && (
                    <span className={`export-mesh__verdict export-mesh__verdict--${
                      report.summary.fail ? 'fail' : report.summary.warn ? 'warn' : 'pass'
                    }`}>
                      {report.summary.fail
                        ? `${report.summary.fail} blocking issue${report.summary.fail === 1 ? '' : 's'}`
                        : report.summary.warn
                          ? `${report.summary.warn} warning${report.summary.warn === 1 ? '' : 's'}`
                          : 'Game-ready'}
                    </span>
                  )}
                </div>

                {report && (
                  <ul className="export-mesh__findings">
                    {report.checks
                      .filter(check => check.status === 'fail' || check.status === 'warn')
                      .map(check => (
                        <li key={check.id} className={`export-mesh__finding export-mesh__finding--${check.status}`}>
                          <strong>{check.label}:</strong> {check.value}
                          {check.detail ? ` — ${check.detail}` : ''}
                        </li>
                      ))}
                    {!report.summary.fail && !report.summary.warn && (
                      <li className="export-mesh__finding export-mesh__finding--pass">
                        Everything passed — nothing to fix before importing.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>

            {showSimplifyColumn && (
              <div className="export-mesh__column">
                <div className="export-mesh__extras">
                  <span className="export-mesh__label">Simplifier (meshoptimizer)</span>

                  {/* The knob that decides whether a level reaches its ratio at
                      all. gltfpack's own default is 1%, strict enough that a
                      level routinely stalls well above its target — and the
                      stall reads as "the UV seams did this", which sends the run
                      to the pass that reshades the mesh. */}
                  <label className="export-mesh__inline-field">
                    <span>Error budget</span>
                    <input
                      className="export-mesh__input export-mesh__input--inline"
                      type="number"
                      min={0.1}
                      max={50}
                      step={0.1}
                      value={Number(((simplifyOptions.simplify_error ?? 0.05) * 100).toFixed(1))}
                      onChange={event => setSimplifyOption(
                        'simplify_error',
                        Math.min(50, Math.max(0.1, Number(event.target.value) || 0.1)) / 100
                      )}
                    />
                    <span>%</span>
                  </label>
                  <p className="export-mesh__hint">
                    How far a level may move off the original surface. This, not the UV seams,
                    is usually what stops a level short of its ratio — raising it reaches the
                    target while leaving normals and UVs alone. gltfpack&apos;s own default is 1%.
                  </p>

                  <label className="export-mesh__check">
                    <input
                      type="checkbox"
                      checked={!!simplifyOptions.lock_border}
                      onChange={event => setSimplifyOption('lock_border', event.target.checked)}
                    />
                    <span>Lock border vertices</span>
                  </label>
                  <p className="export-mesh__hint">
                    Pins open edges, so a level of one piece of a larger set does not pull away
                    from its neighbours at the shared edge. Costs some reduction.
                  </p>

                  <label className="export-mesh__check">
                    <input
                      type="checkbox"
                      checked={!!simplifyOptions.allow_seam_breaking}
                      onChange={event => setSimplifyOption('allow_seam_breaking', event.target.checked)}
                    />
                    <span>Allow attribute seams to break</span>
                  </label>
                  {simplifyOptions.allow_seam_breaking && (
                    <div className="export-mesh__extra-body">
                      <label className="export-mesh__check">
                        <input
                          type="checkbox"
                          checked={!!simplifyOptions.permissive}
                          onChange={event => setSimplifyOption('permissive', event.target.checked)}
                        />
                        <span>Permissive collapses</span>
                      </label>
                      <label className="export-mesh__check">
                        <input
                          type="checkbox"
                          checked={!!simplifyOptions.aggressive}
                          onChange={event => setSimplifyOption('aggressive', event.target.checked)}
                        />
                        <span>Aggressive pass (last resort)</span>
                      </label>
                      {simplifyOptions.aggressive ? (
                        <p className="export-mesh__hint">
                          The aggressive pass rebuilds the vertex set, so normals and UVs are both
                          reassigned: hard edges smooth over and the texture scrambles. It is the
                          only thing that breaks a real seam floor. Turn it off to keep the shading
                          and ship coarser levels instead.
                        </p>
                      ) : (
                        <p className="export-mesh__hint">
                          Shading is protected: a level that cannot reach its target stops above it
                          and is reported, rather than shipped reshaded.
                        </p>
                      )}
                    </div>
                  )}
                  <p className="export-mesh__hint">
                    A level will not collapse an edge across an attribute discontinuity, and on a
                    UV-mapped mesh every island boundary is one — so a seam-heavy mesh has a floor
                    no error budget will pass. Raise the budget first; it is the cheaper fix and
                    usually the real limit. Welded seams are exactly what the texture bake above
                    repairs.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Progress and the result messages belong to the pinned footer, not to
            the scrolling body. With the LOD and simplifier columns expanded the
            body is far taller than the viewport, so a progress bar at the end of
            it sits below the fold at exactly the moment it matters: you press
            Export and the dialog looks inert until you happen to scroll. */}
        <div className="export-mesh__footer">
          {(progress || error || success) && (
            <div className="export-mesh__status">
              {progress && (
                <div className="export-mesh__progress" role="status">
                  <div className="export-mesh__progress-track">
                    <div
                      className="export-mesh__progress-bar"
                      style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.frac)) * 100)}%` }}
                    />
                  </div>
                  <span className="export-mesh__progress-message">{progress.message}</span>
                </div>
              )}

              {error && <div className="export-mesh__message export-mesh__message--error">{error}</div>}
              {success && <div className="export-mesh__message export-mesh__message--success">{success}</div>}
            </div>
          )}

          <div className="export-mesh__actions">
            <button type="button" className="export-mesh__btn export-mesh__btn--secondary" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="export-mesh__btn export-mesh__btn--primary"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          </div>
        </div>
      </div>

      {showFolderBrowser && (
        <FolderBrowserDialog
          initialPath={outputFolder.trim()}
          onSelect={path => { setOutputFolder(path); setShowFolderBrowser(false) }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  )
}
