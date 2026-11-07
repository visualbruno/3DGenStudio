// Workspace → Texture module: texture the selected mesh.
//   Single Image    — ComfyUI workflow: mesh + one reference image;
//   Multiple Images — ComfyUI workflow: mesh + several views (only the first
//                     view is required, like the Mesh module's multi-view);
//   Bake            — transfer a high-poly mesh's texture: the built-in Blender
//                     bake, or a ComfyUI workflow taking two meshes.
// The result is saved as a VERSION of the selected mesh (explicit
// parentAssetId), logged to the history and becomes the next source.
import { useEffect, useMemo, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { useNotifications } from '../../context/NotificationContext'
import { useWorkflowJobs } from '../../context/WorkflowJobsContext'
import { assetUrl } from '../../config'
import { createComfyExecutionId } from '../../utils/ids'
import { createMeshThumbnailFile, createMeshThumbnailFileFromUrl } from '../../utils/meshThumbnail'
import { createWorkflowInputNoneValue } from '../../utils/workflowFileInputs'
import { fetchComfyWorkflows, resolveSourceReference, uploadAssetThumbnail } from '../../utils/workspaceApi'
import { BAKE_MAP_CHOICES, DEFAULT_WORKSPACE_BAKE, runWorkspaceBake } from '../../utils/workspaceBake'
import { coerceParameterValue, defaultParameterValues, getParameterValueType, randomSeed } from '../../utils/workspaceImage'
import { snapToEnums } from '../../utils/workspaceMesh'
import { saveMeshVersion } from '../../utils/workspaceRetopo'
import {
  TEXTURE_SIZE_PRESETS,
  filterTextureWorkflows,
  resolveTextureRoles,
  textureWorkflowLabel
} from '../../utils/workspaceTexture'
import AssetSelectorModal from '../AssetSelectorModal'
import WorkspaceImageSlot from './WorkspaceImageSlot'
import WorkspaceMeshSlot from './WorkspaceMeshSlot'
import WorkspaceParamField from './WorkspaceParamField'
import { Disclosure, NumberInput, ResultRows, Switch } from './WorkspaceControls'

const SETTINGS_KEY = 'workspace.texture.settings.v1'
const BUILTIN_BAKE = 'builtin'

const TABS = [
  { id: 'single', label: 'Single Image', icon: 'image' },
  { id: 'multi', label: 'Multi-Images', icon: 'view_in_ar' },
  { id: 'bake', label: 'Bake', icon: 'local_fire_department' }
]

// Empty multi-view layout (no workflow chosen yet).
const DEFAULT_VIEW_KEYS = [
  { key: 'front', label: 'Front' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
  { key: 'back', label: 'Back' }
]

const DEFAULT_SETTINGS = {
  tab: 'single',
  workflowIds: { single: '', multi: '', bake: BUILTIN_BAKE },
  textureSize: null, // null = the workflow's own default
  randomSeed: true,
  bake: DEFAULT_WORKSPACE_BAKE
}

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      workflowIds: { ...DEFAULT_SETTINGS.workflowIds, ...(parsed.workflowIds || {}) },
      bake: { ...DEFAULT_WORKSPACE_BAKE, ...(parsed.bake || {}) }
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function writeSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable — nothing to keep
  }
}

function texturedName(asset, suffix) {
  const base = String(asset?.name || 'Mesh').replace(/\.[^.]+$/, '').replace(/\s*\((retopo|repaired|optimized|uv|textured|baked)\)$/i, '')
  return `${base} (${suffix})`
}

function sizeLabel(value) {
  return value >= 1024 ? `${value / 1024}K` : String(value)
}

export default function WorkspaceTexturePanel({
  projectId,
  projectName,
  target,
  targetBusy,
  meshImporters,
  imageImporters,
  onTargetChange,
  selectedMeshEntry,
  selectedImageEntry,
  onResult,
  onPendingAdd,
  onPendingUpdate,
  onPendingRemove,
  reuse
}) {
  const { runComfyWorkflow } = useProjects()
  const { addNotification } = useNotifications()
  const { registerJob, completeJob } = useWorkflowJobs()

  const [workflows, setWorkflows] = useState([])
  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [workflowsError, setWorkflowsError] = useState('')
  const [workflowsVersion, setWorkflowsVersion] = useState(0)
  const [settings, setSettings] = useState(readSettings)
  const [valuesByWorkflow, setValuesByWorkflow] = useState({})
  const [image, setImage] = useState(null)
  const [views, setViews] = useState({})
  const [high, setHigh] = useState(null)
  const [busySlots, setBusySlots] = useState({})
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [status, setStatus] = useState(null)
  const [lastResult, setLastResult] = useState(null) // { assetId, rows, label }
  const [picker, setPicker] = useState(null) // { kind: 'target' | 'high' | 'image', key? }
  const [appliedReuseNonce, setAppliedReuseNonce] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchComfyWorkflows()
      .then(list => {
        if (cancelled) return
        setWorkflows(Array.isArray(list) ? list : [])
        setWorkflowsError('')
      })
      .catch(err => { if (!cancelled) setWorkflowsError(err.message || 'Failed to load ComfyUI workflows') })
      .finally(() => { if (!cancelled) setWorkflowsLoading(false) })
    return () => { cancelled = true }
  }, [workflowsVersion])

  useEffect(() => { writeSettings(settings) }, [settings])

  const tab = ['single', 'multi', 'bake'].includes(settings.tab) ? settings.tab : 'single'
  const tabWorkflows = useMemo(() => filterTextureWorkflows(workflows, tab), [workflows, tab])
  const storedChoice = settings.workflowIds[tab]
  const builtinBake = tab === 'bake' && (storedChoice === BUILTIN_BAKE || !tabWorkflows.some(wf => String(wf.id) === String(storedChoice)))
  const workflow = builtinBake ? null : (tabWorkflows.find(wf => String(wf.id) === String(storedChoice)) || tabWorkflows[0] || null)
  const roles = useMemo(() => (workflow ? resolveTextureRoles(workflow) : null), [workflow])
  const values = workflow ? (valuesByWorkflow[workflow.id] || defaultParameterValues(workflow)) : {}
  const layoutViews = tab === 'multi' ? (roles?.views?.length ? roles.views : DEFAULT_VIEW_KEYS) : []
  const textureValue = roles?.textureSize ? (settings.textureSize ?? (Number(values[roles.textureSize.id]) || null)) : null
  const bake = settings.bake

  if (reuse && reuse.nonce !== appliedReuseNonce) {
    setAppliedReuseNonce(reuse.nonce)
    const params = reuse.entry.params || {}
    const reuseTab = ['single', 'multi', 'bake'].includes(params.tab) ? params.tab : 'single'
    setSettings(prev => ({
      ...prev,
      tab: reuseTab,
      workflowIds: { ...prev.workflowIds, [reuseTab]: params.workflowId ? String(params.workflowId) : (reuseTab === 'bake' ? BUILTIN_BAKE : prev.workflowIds[reuseTab]) },
      textureSize: Number(params.textureSize) || prev.textureSize,
      bake: params.bake ? { ...prev.bake, ...params.bake } : prev.bake
    }))
    if (params.workflowId && params.values) {
      setValuesByWorkflow(prev => ({ ...prev, [params.workflowId]: { ...(prev[params.workflowId] || {}), ...params.values } }))
    }
  }

  const update = (patch) => setSettings(prev => ({ ...prev, ...patch }))
  const setBake = (patch) => setSettings(prev => ({ ...prev, bake: { ...prev.bake, ...patch } }))
  const setValue = (parameterId, value) => {
    if (!workflow) return
    setValuesByWorkflow(prev => ({ ...prev, [workflow.id]: { ...(prev[workflow.id] || defaultParameterValues(workflow)), [parameterId]: value } }))
  }

  const fill = async (key, load, apply) => {
    setBusySlots(prev => ({ ...prev, [key]: true }))
    try {
      apply(await load())
      setStatus(null)
    } catch (err) {
      setStatus({ tone: 'error', message: err.message || 'Could not use that file.' })
    } finally {
      setBusySlots(prev => ({ ...prev, [key]: false }))
    }
  }
  const fillTarget = (load) => fill('target', load, onTargetChange)
  const fillHigh = (load) => fill('high', load, setHigh)
  const fillImage = (load) => fill('image', load, setImage)
  const fillView = (key, load) => fill(`view:${key}`, load, value => setViews(prev => ({ ...prev, [key]: value })))

  const busy = running || targetBusy || Object.values(busySlots).some(Boolean)

  const blocker = (() => {
    if (!target) return 'Choose the mesh to texture'
    if (tab === 'bake') {
      if (!high) return 'Choose the high-poly mesh to bake from'
      if (high.assetId === target.assetId) return 'The high poly must be another mesh'
      if (builtinBake && !bake.maps.length) return 'Choose at least one map'
      return null
    }
    if (!workflow) return tab === 'multi' ? 'No multi-image texturing workflow installed' : 'No texturing workflow installed'
    if (tab === 'single' && !image?.sourceReference) return 'Choose the reference image'
    if (tab === 'multi' && layoutViews[0] && !views[layoutViews[0].key]?.sourceReference) return `Add the ${layoutViews[0].label} view`
    return null
  })()

  const finish = async ({ asset, label, rows, params }) => {
    await onResult({ asset, module: 'texture', label, source: target, params: { ...params, summary: rows } })
    setLastResult({ assetId: asset.id, rows, label })
  }

  const runBuiltinBake = async () => {
    const runTarget = target
    const runHigh = high
    const runBake = bake
    const pendingId = createComfyExecutionId('workspace-bake')
    setRunning(true)
    setStatus(null)
    setProgress({ frac: 0, message: 'Bake…' })
    onPendingAdd?.({ id: pendingId, label: `Bake · ${runTarget.name}`, cloud: true, stoppable: false, progressPercent: 0 })
    try {
      const result = await runWorkspaceBake({ id: runTarget.assetId, ...runTarget }, { id: runHigh.assetId, ...runHigh }, runBake, {
        onProgress: (evt) => {
          setProgress(evt)
          const frac = Number(evt?.frac)
          if (Number.isFinite(frac)) onPendingUpdate?.(pendingId, { progressPercent: Math.round(frac * 95) })
        }
      })
      setProgress({ frac: 0.97, message: 'Saving the new version…' })
      let saved = await saveMeshVersion({ id: runTarget.assetId, name: runTarget.name }, result.blob, texturedName(runTarget, 'baked'))
      try {
        const thumbnail = await createMeshThumbnailFile(new File([result.blob], 'mesh.glb', { type: 'model/gltf-binary' }))
        if (thumbnail) saved = { ...saved, ...(await uploadAssetThumbnail(saved.id, thumbnail)) }
      } catch (err) {
        console.warn('Could not render the new version thumbnail', err)
      }
      await finish({
        asset: saved,
        label: 'Bake',
        rows: [{ label: 'From', value: runHigh.name }, ...result.rows],
        params: { tab: 'bake', bake: runBake, highAssetId: runHigh.assetId }
      })
    } catch (err) {
      console.error('Workspace bake failed', err)
      const message = /uv/i.test(err.message || '') && !runBake.unwrapFirst
        ? `${err.message} — turn on "Unwrap UVs first", or unwrap it in the UV module.`
        : (err.message || 'The bake failed.')
      setStatus({ tone: 'error', message })
      addNotification({ title: 'Bake failed', message, tone: 'error', source: 'Bake', projectId })
    } finally {
      setRunning(false)
      setProgress(null)
      onPendingRemove?.(pendingId)
    }
  }

  const runWorkflow = async () => {
    const runWorkflowDef = workflow
    const runRoles = roles
    const runTarget = target
    const runTab = tab
    setStatus(null)
    setRunning(true)
    const promptId = createComfyExecutionId('comfy-prompt')
    const clientId = createComfyExecutionId('comfy-client')
    const label = textureWorkflowLabel(runWorkflowDef)
    registerJob({ id: promptId, projectId, projectName, page: 'workspace', targetId: 'texture', kind: 'mesh', label: `Texture · ${label}` })
    try {
      const meshRef = (await resolveSourceReference(projectId, 'mesh', runTarget.filePath || runTarget.filename)).sourceReference
      const scalarValues = {}
      for (const parameter of runWorkflowDef.parameters || []) {
        if (['image', 'video', 'mesh'].includes(getParameterValueType(parameter))) continue
        if ([runRoles.textureSize, runRoles.seed].includes(parameter)) continue
        if (Object.prototype.hasOwnProperty.call(values, parameter.id)) {
          scalarValues[parameter.id] = coerceParameterValue(parameter, values[parameter.id])
        }
      }
      const seed = runRoles.seed ? (settings.randomSeed ? randomSeed() : Number(values[runRoles.seed.id]) || 0) : null
      const inputs = {
        ...scalarValues,
        ...(runRoles.textureSize && textureValue ? { [runRoles.textureSize.id]: snapToEnums(runRoles.textureSize, textureValue) } : {}),
        ...(runRoles.seed ? { [runRoles.seed.id]: seed } : {})
      }
      if (runTab === 'bake') {
        const highRef = (await resolveSourceReference(projectId, 'mesh', high.filePath || high.filename)).sourceReference
        inputs[runRoles.bakeHigh.id] = { source: highRef, name: high.name }
        inputs[runRoles.bakeLow.id] = { source: meshRef, name: runTarget.name }
      } else {
        inputs[runRoles.mesh.id] = { source: meshRef, name: runTarget.name }
        if (runTab === 'single') {
          inputs[runRoles.image.id] = { source: image.sourceReference, name: image.name }
        } else {
          for (const view of runRoles.views) {
            const picked = views[view.key]
            inputs[view.parameter.id] = picked?.sourceReference
              ? { source: picked.sourceReference, name: picked.name }
              : createWorkflowInputNoneValue()
          }
        }
      }

      const assets = await runComfyWorkflow(projectId, {
        workflowId: runWorkflowDef.id,
        inputs,
        name: texturedName(runTarget, runTab === 'bake' ? 'baked' : 'textured'),
        clientId,
        promptId,
        persistProcessingCard: false,
        detachedAsset: true,
        // A version of the mesh being textured — named explicitly, because a
        // bake workflow has TWO mesh inputs and the first is the high poly.
        parentAssetId: runTarget.assetId,
        autoParentFromInputs: false
      })
      const meshes = (Array.isArray(assets) ? assets : [assets]).filter(asset => asset && asset.id != null && asset.type === 'mesh')
      if (!meshes.length) throw new Error('The workflow finished without returning a mesh')
      let saved = meshes[0]
      if (saved.filename) {
        try {
          const thumbnail = await createMeshThumbnailFileFromUrl(assetUrl(saved.filename), String(saved.filename).split('/').pop() || 'mesh.glb')
          if (thumbnail) saved = { ...saved, ...(await uploadAssetThumbnail(saved.id, thumbnail)) }
        } catch (err) {
          console.warn('Could not render the textured mesh thumbnail', err)
        }
      }
      completeJob(promptId, { status: 'completed' })
      const rows = [{ label: 'Workflow', value: label }]
      if (runRoles.textureSize && textureValue) rows.push({ label: 'Texture size', value: `${inputs[runRoles.textureSize.id]} px` })
      if (runTab === 'bake') rows.unshift({ label: 'From', value: high.name })
      await finish({
        asset: saved,
        label: textureWorkflowLabel(runWorkflowDef),
        rows,
        params: {
          tab: runTab,
          workflowId: runWorkflowDef.id,
          textureSize: runRoles.textureSize ? inputs[runRoles.textureSize.id] : undefined,
          ...(seed != null ? { seed } : {}),
          values: scalarValues,
          imageAssetId: runTab === 'single' ? image?.assetId ?? null : null
        }
      })
    } catch (err) {
      if (err?.cancelled) {
        completeJob(promptId, { status: 'cancelled' })
      } else {
        console.error('Workspace texturing failed', err)
        completeJob(promptId, { status: 'error', error: err.message })
        setStatus({ tone: 'error', message: err.message || 'The workflow failed.' })
        addNotification({ title: 'Texturing failed', message: err.message || 'ComfyUI workflow failed', tone: 'error', source: runWorkflowDef.name, projectId })
      }
    } finally {
      setRunning(false)
    }
  }

  const run = () => {
    if (blocker || busy) return
    if (tab === 'bake' && builtinBake) runBuiltinBake()
    else runWorkflow()
  }

  const handlePicked = (asset) => {
    const target = picker
    setPicker(null)
    if (!asset || !target) return
    if (target.kind === 'target') fillTarget(() => meshImporters.fromMeshAsset(asset))
    else if (target.kind === 'high') fillHigh(() => meshImporters.fromMeshAsset(asset))
    else if (target.kind === 'image') fillImage(() => imageImporters.fromAsset(asset))
    else if (target.kind === 'view') fillView(target.key, () => imageImporters.fromAsset(asset))
  }

  const useSelectedImage = selectedImageEntry ? () => imageImporters.fromEntry(selectedImageEntry) : null
  const useSelectedMesh = selectedMeshEntry ? () => meshImporters.fromEntry(selectedMeshEntry) : null

  const renderViews = () => {
    const [main, ...others] = layoutViews
    const slot = (view, variant) => (
      <WorkspaceImageSlot
        key={view.key}
        variant={variant}
        label={view.label}
        hint={view === main ? 'Required — drop an image, or use the buttons' : 'Optional'}
        value={views[view.key] || null}
        busy={Boolean(busySlots[`view:${view.key}`])}
        onFile={(file) => fillView(view.key, () => imageImporters.fromFile(file))}
        onDropEntry={(entry) => fillView(view.key, () => imageImporters.fromEntry(entry))}
        onPickAsset={() => setPicker({ kind: 'view', key: view.key })}
        onUseSelected={useSelectedImage ? () => fillView(view.key, useSelectedImage) : null}
        onClear={() => setViews(prev => ({ ...prev, [view.key]: null }))}
      />
    )
    return (
      <div className="workspace-views">
        {main && slot(main, 'large')}
        {others.length > 0 && (
          <div className="workspace-views__row" style={{ gridTemplateColumns: `repeat(${others.length}, minmax(0, 1fr))` }}>
            {others.map(view => slot(view, 'small'))}
          </div>
        )}
      </div>
    )
  }

  const runLabel = running
    ? (tab === 'bake' ? 'Baking…' : 'Texturing…')
    : (tab === 'bake' ? 'Bake Texture' : 'Texture Mesh')

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">texture</span>
        Texture
      </div>

      <div className="workspace-panel__scroll">
        <div className="workspace-tabs workspace-tabs--compact" role="tablist">
          {TABS.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`workspace-tab ${tab === entry.id ? 'workspace-tab--active' : ''}`}
              onClick={() => update({ tab: entry.id })}
            >
              <span className="material-symbols-outlined">{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </div>

        <WorkspaceMeshSlot
          value={target}
          label="Mesh to texture"
          emptyLabel="Choose the mesh to texture"
          busy={targetBusy || busySlots.target}
          onFile={(file) => fillTarget(() => meshImporters.fromMeshFile(file))}
          onPickAsset={() => setPicker({ kind: 'target' })}
          onUseSelected={useSelectedMesh ? () => fillTarget(useSelectedMesh) : null}
          onDropEntry={(entry) => fillTarget(() => meshImporters.fromEntry(entry))}
          onClear={() => onTargetChange(null)}
        />

        {tab === 'single' && (
          <div className="workspace-section">
            <div className="workspace-section__head"><span>Reference Image</span></div>
            <WorkspaceImageSlot
              hint="The look to paint onto the mesh — ideally the image it was generated from"
              value={image}
              busy={Boolean(busySlots.image)}
              onFile={(file) => fillImage(() => imageImporters.fromFile(file))}
              onDropEntry={(entry) => fillImage(() => imageImporters.fromEntry(entry))}
              onPickAsset={() => setPicker({ kind: 'image' })}
              onUseSelected={useSelectedImage ? () => fillImage(useSelectedImage) : null}
              onClear={() => setImage(null)}
            />
          </div>
        )}

        {tab === 'multi' && (
          <div className="workspace-section">
            {renderViews()}
            <span className="workspace-hint">The object seen from each side; only the first view is required.</span>
          </div>
        )}

        {tab === 'bake' && (
          <div className="workspace-section">
            <WorkspaceMeshSlot
              value={high}
              label="High poly (texture source)"
              emptyLabel="Choose the high-poly mesh"
              hint="The detailed, textured mesh to bake from"
              busy={Boolean(busySlots.high)}
              onFile={(file) => fillHigh(() => meshImporters.fromMeshFile(file))}
              onPickAsset={() => setPicker({ kind: 'high' })}
              onUseSelected={useSelectedMesh ? () => fillHigh(useSelectedMesh) : null}
              onDropEntry={(entry) => fillHigh(() => meshImporters.fromEntry(entry))}
              onClear={() => setHigh(null)}
            />
          </div>
        )}

        <div className="workspace-section">
          <div className="workspace-section__head">
            <span>{tab === 'bake' ? 'Bake With' : 'AI Model'}</span>
            <button
              type="button"
              className="workspace-icon-btn workspace-icon-btn--small"
              onClick={() => { setWorkflowsLoading(true); setWorkflowsVersion(version => version + 1) }}
              title="Reload the installed workflows"
            >
              <span className="material-symbols-outlined">refresh</span>
            </button>
          </div>
          <select
            className="workspace-input workspace-input--large"
            value={builtinBake ? BUILTIN_BAKE : (workflow ? String(workflow.id) : '')}
            onChange={event => setSettings(prev => ({ ...prev, workflowIds: { ...prev.workflowIds, [tab]: event.target.value } }))}
            disabled={tab !== 'bake' && !tabWorkflows.length}
          >
            {tab === 'bake' && <option value={BUILTIN_BAKE}>Blender Bake (built-in)</option>}
            {tab !== 'bake' && !tabWorkflows.length && (
              <option value="">{workflowsLoading ? 'Loading workflows…' : 'No compatible workflow installed'}</option>
            )}
            {tabWorkflows.length > 0 && (
              <optgroup label="ComfyUI (local)">
                {tabWorkflows.map(wf => <option key={wf.id} value={String(wf.id)} title={wf.name}>{textureWorkflowLabel(wf)}</option>)}
              </optgroup>
            )}
          </select>
          {workflowsError && <span className="workspace-hint workspace-hint--error">{workflowsError}</span>}
          {tab !== 'bake' && !workflowsLoading && !workflowsError && !tabWorkflows.length && (
            <span className="workspace-hint">
              {tab === 'multi'
                ? 'Install a multi-view texturing workflow (Texture Mesh MultiView with Trellis2) from the Setup Wizard.'
                : 'Install a texturing workflow (UltraTex, Texture Mesh with Trellis2) from the Setup Wizard.'}
            </span>
          )}
        </div>

        {tab === 'bake' && builtinBake && (
          <>
            <div className="workspace-section">
              <div className="workspace-section__head"><span>Maps</span></div>
              <div className="workspace-chips">
                {BAKE_MAP_CHOICES.map(choice => {
                  const on = bake.maps.includes(choice.id)
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      className={`workspace-chip ${on ? 'workspace-chip--active' : ''}`}
                      aria-pressed={on}
                      title={choice.hint}
                      onClick={() => setBake({ maps: on ? bake.maps.filter(id => id !== choice.id) : [...bake.maps, choice.id] })}
                    >
                      {choice.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="workspace-section">
              <div className="workspace-section__head">
                <span>Texture Size</span>
                <span className="workspace-section__aside">{bake.resolution} px</span>
              </div>
              <div className="workspace-chips workspace-chips--even">
                {[1024, 2048, 4096].map(size => (
                  <button
                    key={size}
                    type="button"
                    className={`workspace-chip workspace-chip--box ${bake.resolution === size ? 'workspace-chip--active' : ''}`}
                    onClick={() => setBake({ resolution: size })}
                  >
                    {sizeLabel(size)}
                  </button>
                ))}
              </div>
              <Switch
                label="Unwrap UVs first"
                value={bake.unwrapFirst}
                onChange={value => setBake({ unwrapFirst: value })}
                hint="The bake writes onto the mesh's UVs; a retopologized mesh has none. Runs Auto UV before baking."
              />
            </div>
            <Disclosure label="Advanced">
              <NumberInput label="Samples" value={bake.samples} min={1} max={512} step={1} onChange={value => setBake({ samples: value })} hint="Only AO is noisy enough to need more than a few." />
              <NumberInput label="Margin (texels)" value={bake.margin} min={0} max={64} step={1} onChange={value => setBake({ margin: value })} hint="Island dilation, so filtering does not bleed the empty gutter into the surface." />
              <NumberInput label="Cage extrusion (m)" value={bake.cage_extrusion} min={0} max={10} step={0.01} onChange={value => setBake({ cage_extrusion: value })} hint="0 scales it to the mesh (2% of its size)." />
              <Switch label="Align the high poly" value={bake.align_source} onChange={value => setBake({ align_source: value })} hint="Move the high poly into the mesh's space when they are offset or scaled." />
              <Switch label="Refuse a poor overlap" value={bake.require_overlap > 0} onChange={value => setBake({ require_overlap: value ? 0.5 : 0 })} hint="Stop early instead of baking blank maps when the meshes barely overlap." />
            </Disclosure>
          </>
        )}

        {roles?.textureSize && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Texture Size</span>
              {textureValue && <span className="workspace-section__aside">{textureValue} px</span>}
            </div>
            <div className="workspace-chips workspace-chips--even">
              {TEXTURE_SIZE_PRESETS.map(size => (
                <button
                  key={size}
                  type="button"
                  className={`workspace-chip workspace-chip--box ${textureValue === size ? 'workspace-chip--active' : ''}`}
                  onClick={() => update({ textureSize: size })}
                >
                  {sizeLabel(size)}
                </button>
              ))}
            </div>
          </div>
        )}

        {roles?.seed && (
          <div className="workspace-section">
            <WorkspaceParamField
              parameter={roles.seed}
              label="Seed"
              value={values[roles.seed.id]}
              onChange={setValue}
              randomSeed={settings.randomSeed}
              onToggleRandomSeed={() => update({ randomSeed: !settings.randomSeed })}
            />
          </div>
        )}

        {roles?.advanced.length > 0 && (
          <Disclosure label="Advanced">
            {roles.advanced.map(parameter => (
              <WorkspaceParamField key={parameter.id} parameter={parameter} value={values[parameter.id]} onChange={setValue} />
            ))}
          </Disclosure>
        )}

        {lastResult && lastResult.assetId === target?.assetId && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Last Result</span>
              <span className="workspace-section__aside">{lastResult.label}</span>
            </div>
            <ResultRows rows={lastResult.rows} />
          </div>
        )}
      </div>

      <div className="workspace-panel__footer">
        {progress && (
          <div className="workspace-progress">
            <div className="workspace-progress__bar">
              <div className="workspace-progress__fill" style={{ width: `${Math.max(3, Math.round((Number(progress.frac) || 0) * 100))}%` }} />
            </div>
            <span className="workspace-hint workspace-hint--center">{progress.message || progress.stage || 'Working…'}</span>
          </div>
        )}
        {status && <div className={`workspace-status ${status.tone === 'error' ? 'workspace-status--error' : ''}`}>{status.message}</div>}
        <button type="button" className="workspace-run-btn" onClick={run} disabled={Boolean(blocker) || busy} title={blocker || 'Saved as a new version of the mesh'}>
          <span className="material-symbols-outlined">{tab === 'bake' ? 'local_fire_department' : 'texture'}</span>
          {runLabel}
        </button>
        {blocker && <span className="workspace-hint workspace-hint--center">{blocker}</span>}
      </div>

      {picker && (
        <AssetSelectorModal
          assetType={picker.kind === 'image' || picker.kind === 'view' ? 'image' : 'mesh'}
          showEdits
          onSelect={handlePicked}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
