// Workspace → Mesh module: generate a 3D model from one image, or from several
// views of the same object (Multi-View). The dropdown lists the installed
// ComfyUI workflows that fit the tab, then the cloud APIs (Tripo AI, Hitem3D,
// and Tencent Cloud for a single image). For a workflow, Target Faces, Texture
// Size and Seed are mapped onto its own parameters (src/utils/workspaceMesh.js);
// a cloud API is submitted here and polled by the page
// (src/hooks/useWorkspaceCloudTasks.js, src/utils/workspaceMeshCloud.js).
//
// A generated mesh is a new ROOT asset (its input is an image, so it is not a
// version of anything); the history entry remembers the image it came from.
import { useEffect, useMemo, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { useSettings } from '../../context/SettingsContext.shared'
import { useNotifications } from '../../context/NotificationContext'
import { useWorkflowJobs } from '../../context/WorkflowJobsContext'
import { assetUrl } from '../../config'
import { createComfyExecutionId } from '../../utils/ids'
import { createMeshThumbnailFileFromUrl } from '../../utils/meshThumbnail'
import { createWorkflowInputNoneValue } from '../../utils/workflowFileInputs'
import { addWorkspaceHistory, fetchComfyWorkflows, submitCloudMeshGeneration, uploadAssetThumbnail } from '../../utils/workspaceApi'
import {
  CLOUD_MESH_DEFAULTS,
  buildCloudMeshRequest,
  cloudMeshModelsForTab,
  cloudMeshValue,
  cloudSupports,
  cloudTaskFromSubmit,
  findCloudMeshModel,
  formatCloudFaces,
  normalizeCloudOptions
} from '../../utils/workspaceMeshCloud'
import { coerceParameterValue, defaultParameterValues, getParameterValueType, randomSeed } from '../../utils/workspaceImage'
import {
  FACE_PRESETS,
  TEXTURE_SIZES,
  describeViews,
  filterMeshWorkflows,
  formatFaceCount,
  meshWorkflowLabel,
  resolveMeshRoles,
  snapToEnums
} from '../../utils/workspaceMesh'
import AssetSelectorModal from '../AssetSelectorModal'
import WorkspaceImageSlot from './WorkspaceImageSlot'
import WorkspaceParamField from './WorkspaceParamField'
import WorkspaceCloudMeshFields from './WorkspaceCloudMeshFields'

const SETTINGS_KEY = 'workspace.mesh.settings.v1'

const TABS = [
  { id: 'single', label: 'Single Image', icon: 'image' },
  { id: 'multiview', label: 'Multi-View', icon: 'view_in_ar' }
]

// The layout used before a multi-view workflow is chosen (and when none is
// installed): Front large, then Left / Right / Back.
const DEFAULT_VIEWS = describeViews([
  { id: 'front', name: 'Front Image' },
  { id: 'left', name: 'Left Image' },
  { id: 'right', name: 'Right Image' },
  { id: 'back', name: 'Back Image' }
])

const DEFAULT_SETTINGS = {
  tab: 'single',
  workflowIds: { single: '', multiview: '' },
  faces: null,        // null = the workflow's own default
  textureSize: null,  // null = the workflow's own default
  randomSeed: true,
  cloud: CLOUD_MESH_DEFAULTS, // per cloud API: its option values
  cloudSeed: ''
}

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      workflowIds: { ...DEFAULT_SETTINGS.workflowIds, ...(parsed.workflowIds || {}) },
      cloud: Object.fromEntries(Object.entries(CLOUD_MESH_DEFAULTS)
        .map(([id, defaults]) => [id, { ...defaults, ...(parsed.cloud?.[id] || {}) }]))
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

function meshName(source, workflow) {
  const base = String(source?.name || '').replace(/\.[^.]+$/, '').trim()
  return base ? `${base} 3D`.slice(0, 60) : meshWorkflowLabel(workflow)
}

export default function WorkspaceMeshPanel({
  projectId,
  projectName,
  source,
  sourceBusy,
  onSourceChange,
  importers,
  selectedImageEntry,
  onRunComplete,
  onCloudTaskSubmitted,
  onGoToImageModule,
  reuse
}) {
  const { runComfyWorkflow } = useProjects()
  const { settings: appSettings } = useSettings()
  const { addNotification } = useNotifications()
  const { registerJob, completeJob } = useWorkflowJobs()

  const [workflows, setWorkflows] = useState([])
  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [workflowsError, setWorkflowsError] = useState('')
  const [workflowsVersion, setWorkflowsVersion] = useState(0)
  const [settings, setSettings] = useState(readSettings)
  const [valuesByWorkflow, setValuesByWorkflow] = useState({})
  const [views, setViews] = useState({})          // view key -> source
  const [busyViews, setBusyViews] = useState({})  // view key -> true while importing
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [status, setStatus] = useState(null)
  const [assetPicker, setAssetPicker] = useState(null) // 'single' | view key
  const [appliedReuseNonce, setAppliedReuseNonce] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchComfyWorkflows()
      .then(list => {
        if (cancelled) return
        setWorkflows(Array.isArray(list) ? list : [])
        setWorkflowsError('')
      })
      .catch(err => {
        if (!cancelled) setWorkflowsError(err.message || 'Failed to load ComfyUI workflows')
      })
      .finally(() => {
        if (!cancelled) setWorkflowsLoading(false)
      })
    return () => { cancelled = true }
  }, [workflowsVersion])

  useEffect(() => { writeSettings(settings) }, [settings])

  const tab = settings.tab === 'multiview' ? 'multiview' : 'single'
  const tabWorkflows = useMemo(() => filterMeshWorkflows(workflows, tab), [workflows, tab])
  const tabCloudModels = cloudMeshModelsForTab(tab)
  const storedChoice = settings.workflowIds[tab]
  const storedWorkflow = tabWorkflows.find(wf => String(wf.id) === String(storedChoice)) || null
  // A cloud API when one is chosen for this tab — or when no workflow fits, so
  // the module is usable without ComfyUI.
  const storedCloud = findCloudMeshModel(storedChoice)
  const cloudModel = (storedCloud && storedCloud.tabs.includes(tab) ? storedCloud : null)
    || (!storedWorkflow && !tabWorkflows.length && !workflowsLoading ? tabCloudModels[0] || null : null)
  const workflow = cloudModel ? null : (storedWorkflow || tabWorkflows[0] || null)
  const cloudOptions = cloudModel ? (settings.cloud?.[cloudModel.id] || CLOUD_MESH_DEFAULTS[cloudModel.id]) : null
  const cloudKeyReady = cloudModel ? cloudModel.hasKey(appSettings) : false
  const roles = useMemo(() => (workflow ? resolveMeshRoles(workflow) : null), [workflow])
  const values = workflow ? (valuesByWorkflow[workflow.id] || defaultParameterValues(workflow)) : {}
  const layoutViews = tab === 'multiview' ? (roles?.views?.length ? roles.views : DEFAULT_VIEWS) : []

  const facesValue = roles?.faces
    ? (settings.faces ?? (Number(values[roles.faces.id]) || null))
    : null
  const textureValue = roles?.textureSize
    ? (settings.textureSize ?? (Number(values[roles.textureSize.id]) || null))
    : null

  // "Reuse settings" on a mesh entry: tab, workflow, face count, texture size
  // and the advanced values. Applied while rendering, once per request.
  if (reuse && reuse.nonce !== appliedReuseNonce) {
    setAppliedReuseNonce(reuse.nonce)
    const params = reuse.entry.params || {}
    const reuseTab = params.tab === 'multiview' ? 'multiview' : 'single'
    const reuseCloud = params.cloud ? findCloudMeshModel(`api:${params.cloud}`) : null
    if (reuseCloud) {
      setSettings(prev => ({
        ...prev,
        tab: reuseTab,
        workflowIds: { ...prev.workflowIds, [reuseTab]: cloudMeshValue(reuseCloud) },
        cloud: { ...prev.cloud, [reuseCloud.id]: { ...(prev.cloud?.[reuseCloud.id] || {}), ...(params.options || {}) } }
      }))
    } else {
      setSettings(prev => ({
        ...prev,
        tab: reuseTab,
        workflowIds: reuse.entry.workflowId ? { ...prev.workflowIds, [reuseTab]: String(reuse.entry.workflowId) } : prev.workflowIds,
        faces: Number(params.faces) || prev.faces,
        textureSize: Number(params.textureSize) || prev.textureSize
      }))
    }
    if (reuse.entry.workflowId && params.values && typeof params.values === 'object') {
      setValuesByWorkflow(prev => ({ ...prev, [reuse.entry.workflowId]: { ...(prev[reuse.entry.workflowId] || {}), ...params.values } }))
    }
  }

  const updateSettings = (patch) => setSettings(prev => ({ ...prev, ...patch }))

  const setValue = (parameterId, value) => {
    if (!workflow) return
    setValuesByWorkflow(prev => ({
      ...prev,
      [workflow.id]: { ...(prev[workflow.id] || defaultParameterValues(workflow)), [parameterId]: value }
    }))
  }

  const selectWorkflow = (id) => {
    setSettings(prev => ({ ...prev, workflowIds: { ...prev.workflowIds, [tab]: id } }))
  }

  const updateCloudOptions = (patch) => {
    if (!cloudModel) return
    setSettings(prev => ({
      ...prev,
      cloud: {
        ...prev.cloud,
        [cloudModel.id]: normalizeCloudOptions(cloudModel, { ...(prev.cloud?.[cloudModel.id] || CLOUD_MESH_DEFAULTS[cloudModel.id]), ...patch })
      }
    }))
  }

  const fail = (err, fallback) => setStatus({ tone: 'error', message: err?.message || fallback })

  // --- filling image slots ------------------------------------------------
  const fillSingle = async (load) => {
    setBusyViews(prev => ({ ...prev, single: true }))
    try {
      onSourceChange(await load())
      setStatus(null)
    } catch (err) {
      fail(err, 'Could not use that image.')
    } finally {
      setBusyViews(prev => ({ ...prev, single: false }))
    }
  }

  const singleBusy = Boolean(sourceBusy || busyViews.single)

  const fillView = async (key, load) => {
    setBusyViews(prev => ({ ...prev, [key]: true }))
    try {
      const loaded = await load()
      setViews(prev => ({ ...prev, [key]: loaded }))
      setStatus(null)
    } catch (err) {
      fail(err, 'Could not use that image.')
    } finally {
      setBusyViews(prev => ({ ...prev, [key]: false }))
    }
  }

  const handleAssetPicked = (asset) => {
    const target = assetPicker
    setAssetPicker(null)
    if (!asset) return
    if (target === 'single') fillSingle(() => importers.fromAsset(asset))
    else fillView(target, () => importers.fromAsset(asset))
  }

  const useSelected = selectedImageEntry ? () => importers.fromEntry(selectedImageEntry) : null

  // --- run ------------------------------------------------------------------
  const blocker = (() => {
    if (cloudModel) {
      if (!cloudKeyReady) return `Add your ${cloudModel.keyHint} in Settings`
      if (tab === 'single') {
        if (singleBusy) return 'Importing the image…'
        if (!source?.sourceReference) return 'Choose the image to turn into 3D'
      } else {
        // Both providers need the front view and at least one more.
        if (!views.front?.sourceReference) return 'Add the Front view'
        if (DEFAULT_VIEWS.filter(view => views[view.key]?.sourceReference).length < 2) return 'Add at least one more view'
      }
      return null
    }
    if (!workflow) {
      return tab === 'multiview' ? 'No multi-view mesh workflow installed' : 'No image-to-mesh workflow installed'
    }
    if (tab === 'single') {
      if (singleBusy) return 'Importing the image…'
      if (!source?.sourceReference) return 'Choose the image to turn into 3D'
    } else {
      // Only the first view (Front, or "First Image") is required; the workflow
      // copes with the others missing.
      const required = layoutViews[0]
      if (required && !views[required.key]?.sourceReference) return `Add the ${required.label} view`
    }
    return null
  })()

  const runCloud = async () => {
    const runModel = cloudModel
    const runOptions = cloudOptions
    const runTab = tab
    const runSource = runTab === 'single' ? source : views.front
    const seed = cloudSupports(runModel, runOptions).seed
      ? (settings.randomSeed ? randomSeed() : (settings.cloudSeed === '' ? null : Number(settings.cloudSeed)))
      : null
    const viewReferences = runTab === 'multiview'
      ? Object.fromEntries(DEFAULT_VIEWS
        .filter(view => views[view.key]?.sourceReference)
        .map(view => [view.key, views[view.key].sourceReference]))
      : null
    const name = meshName(runSource, { name: runModel.label })
    const versionLabel = runOptions.modelVersion || runOptions.hitemModel || ''
    const label = `Mesh · ${runModel.label}${versionLabel ? ` ${versionLabel}` : ''}`
    setStatus(null)

    try {
      const response = await submitCloudMeshGeneration(buildCloudMeshRequest(runModel, runOptions, {
        projectId,
        name,
        imageSource: runTab === 'single' ? runSource.sourceReference : undefined,
        views: viewReferences,
        seed
      }))
      onCloudTaskSubmitted(cloudTaskFromSubmit(runModel, response, {
        name,
        label,
        history: {
          sourceAssetId: runSource?.assetId ?? null,
          workflowName: `${runModel.label}${versionLabel ? ` · ${versionLabel}` : ''}`,
          params: {
            tab: runTab,
            cloud: runModel.id,
            ...(runOptions.faces != null ? { faces: runOptions.faces } : {}),
            ...(seed != null ? { seed } : {}),
            ...(viewReferences
              ? { views: Object.fromEntries(Object.keys(viewReferences).map(key => [key, views[key]?.assetId ?? null])) }
              : {}),
            options: runOptions
          }
        }
      }))
    } catch (err) {
      console.error('Workspace cloud mesh submit failed', err)
      fail(err, `${runModel.label} rejected the request.`)
      addNotification({
        title: 'Mesh generation failed',
        message: err.message || `${runModel.label} rejected the request`,
        tone: 'error',
        source: runModel.label,
        projectId
      })
    }
  }

  const run = async () => {
    if (blocker) return
    if (cloudModel) {
      await runCloud()
      return
    }
    const runWorkflow = workflow
    const runRoles = roles
    const runTab = tab
    const runSource = runTab === 'single' ? source : views[layoutViews[0]?.key]

    const scalarValues = {}
    for (const parameter of runWorkflow.parameters || []) {
      if (['image', 'video', 'mesh'].includes(getParameterValueType(parameter))) continue
      if ([runRoles.faces, runRoles.textureSize, runRoles.seed].includes(parameter)) continue
      if (Object.prototype.hasOwnProperty.call(values, parameter.id)) {
        scalarValues[parameter.id] = coerceParameterValue(parameter, values[parameter.id])
      }
    }
    const seed = runRoles.seed
      ? (settings.randomSeed ? randomSeed() : Number(values[runRoles.seed.id]) || 0)
      : null
    const imageInputs = {}
    const viewAssetIds = {}
    if (runTab === 'single') {
      imageInputs[runRoles.images[0].id] = { source: source.sourceReference, name: source.name }
    } else {
      for (const view of runRoles.views) {
        const picked = views[view.key]
        if (picked?.sourceReference) {
          imageInputs[view.parameter.id] = { source: picked.sourceReference, name: picked.name }
          viewAssetIds[view.key] = picked.assetId ?? null
        } else {
          // An empty view sends nothing: the input keeps the value saved in the
          // workflow (the "None" marker — see src/utils/workflowFileInputs.js).
          imageInputs[view.parameter.id] = createWorkflowInputNoneValue()
        }
      }
    }
    const inputs = {
      ...scalarValues,
      ...imageInputs,
      ...(runRoles.faces && facesValue ? { [runRoles.faces.id]: snapToEnums(runRoles.faces, facesValue) } : {}),
      ...(runRoles.textureSize && textureValue ? { [runRoles.textureSize.id]: snapToEnums(runRoles.textureSize, textureValue) } : {}),
      ...(runRoles.seed ? { [runRoles.seed.id]: seed } : {})
    }

    const promptId = createComfyExecutionId('comfy-prompt')
    const clientId = createComfyExecutionId('comfy-client')
    const label = meshWorkflowLabel(runWorkflow)
    setStatus(null)
    registerJob({
      id: promptId,
      projectId,
      projectName,
      page: 'workspace',
      targetId: 'mesh',
      kind: 'mesh',
      label: `Mesh · ${label}`
    })

    try {
      const assets = await runComfyWorkflow(projectId, {
        workflowId: runWorkflow.id,
        inputs,
        name: meshName(runSource, runWorkflow),
        clientId,
        promptId,
        persistProcessingCard: false,
        detachedAsset: true,
        autoParentFromInputs: false
      })
      const meshes = (Array.isArray(assets) ? assets : [assets])
        .filter(asset => asset && asset.id != null && asset.type === 'mesh')

      // The backend renders a thumbnail through the mesh-tools service when it
      // runs; otherwise render one here so the history shows the model.
      for (const [index, mesh] of meshes.entries()) {
        if (mesh.thumbnail || !mesh.filename) continue
        try {
          const fileName = String(mesh.filename).split('/').pop() || 'mesh.glb'
          const thumbnailFile = await createMeshThumbnailFileFromUrl(assetUrl(mesh.filename), fileName)
          if (thumbnailFile) meshes[index] = { ...mesh, ...(await uploadAssetThumbnail(mesh.id, thumbnailFile)) }
        } catch (err) {
          console.warn('Could not render a thumbnail for the generated mesh', err)
        }
      }

      const entries = meshes.length
        ? await addWorkspaceHistory(projectId, meshes.map(mesh => ({
            assetId: mesh.id,
            module: 'mesh',
            action: 'generate',
            runId: promptId,
            sourceAssetId: runSource?.assetId ?? null,
            workflowId: runWorkflow.id,
            workflowName: runWorkflow.name,
            params: {
              tab: runTab,
              ...(runRoles.faces && facesValue ? { faces: inputs[runRoles.faces.id] } : {}),
              ...(runRoles.textureSize && textureValue ? { textureSize: inputs[runRoles.textureSize.id] } : {}),
              ...(runRoles.seed ? { seed } : {}),
              ...(runTab === 'multiview' ? { views: viewAssetIds } : {}),
              values: scalarValues
            }
          })))
        : []
      completeJob(promptId, { status: 'completed' })
      if (!entries.length) setStatus({ tone: 'error', message: 'The workflow finished without returning a mesh.' })
      onRunComplete(entries)
    } catch (err) {
      if (err?.cancelled) {
        completeJob(promptId, { status: 'cancelled' })
        return
      }
      console.error('Workspace mesh run failed', err)
      completeJob(promptId, { status: 'error', error: err.message })
      fail(err, 'The workflow failed.')
      addNotification({
        title: 'Mesh generation failed',
        message: err.message || 'ComfyUI workflow failed',
        tone: 'error',
        source: runWorkflow.name,
        projectId
      })
    }
  }

  const renderMultiView = () => {
    const [main, ...others] = layoutViews
    const renderSlot = (view, variant) => (
      <WorkspaceImageSlot
        key={view.key}
        variant={variant}
        label={view.label}
        hint={view === main ? 'Required — drop an image, or use the buttons' : 'Optional'}
        value={views[view.key] || null}
        busy={Boolean(busyViews[view.key])}
        onFile={(file) => fillView(view.key, () => importers.fromFile(file))}
        onDropEntry={(entry) => fillView(view.key, () => importers.fromEntry(entry))}
        onPickAsset={() => setAssetPicker(view.key)}
        onUseSelected={useSelected ? () => fillView(view.key, useSelected) : null}
        onClear={() => setViews(prev => ({ ...prev, [view.key]: null }))}
      />
    )
    return (
      <div className="workspace-views">
        {main && renderSlot(main, 'large')}
        {others.length > 0 && (
          <div className="workspace-views__row" style={{ gridTemplateColumns: `repeat(${others.length}, minmax(0, 1fr))` }}>
            {others.map(view => renderSlot(view, 'small'))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">deployed_code</span>
        Generate Mesh
      </div>

      <div className="workspace-panel__scroll">
        <div className="workspace-tabs" role="tablist">
          {TABS.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`workspace-tab ${tab === entry.id ? 'workspace-tab--active' : ''}`}
              onClick={() => updateSettings({ tab: entry.id })}
            >
              <span className="material-symbols-outlined">{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </div>

        {tab === 'single' ? (
          <div className="workspace-section">
            <WorkspaceImageSlot
              hint="JPG, PNG or WEBP — one object, plain background works best"
              value={source}
              busy={singleBusy}
              onFile={(file) => fillSingle(() => importers.fromFile(file))}
              onDropEntry={(entry) => fillSingle(() => importers.fromEntry(entry))}
              onPickAsset={() => setAssetPicker('single')}
              onUseSelected={useSelected ? () => fillSingle(useSelected) : null}
              onClear={() => onSourceChange(null)}
            />
            <button type="button" className="workspace-link-btn" onClick={onGoToImageModule}>
              Generate an image for 3D
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
          </div>
        ) : (
          <div className="workspace-section">
            {renderMultiView()}
            <span className="workspace-hint">
              The same object seen from each side, ideally on a plain background.
            </span>
          </div>
        )}

        <div className="workspace-section">
          <div className="workspace-section__head">
            <span>AI Model</span>
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
            value={cloudModel ? cloudMeshValue(cloudModel) : (workflow ? String(workflow.id) : '')}
            onChange={event => selectWorkflow(event.target.value)}
          >
            {!cloudModel && !workflow && <option value="">Loading workflows…</option>}
            <optgroup label="ComfyUI (local)">
              {tabWorkflows.map(wf => (
                <option key={wf.id} value={String(wf.id)} title={wf.name}>{meshWorkflowLabel(wf)}</option>
              ))}
              {!tabWorkflows.length && (
                <option value="" disabled>{workflowsLoading ? 'Loading…' : 'No compatible workflow installed'}</option>
              )}
            </optgroup>
            <optgroup label="Cloud APIs">
              {tabCloudModels.map(model => (
                <option key={model.id} value={cloudMeshValue(model)}>
                  {model.label}{model.hasKey(appSettings) ? '' : ' — no API key'}
                </option>
              ))}
            </optgroup>
          </select>
          {workflowsError && <span className="workspace-hint workspace-hint--error">{workflowsError}</span>}
          {cloudModel && (
            <span className={`workspace-hint ${cloudKeyReady ? '' : 'workspace-hint--error'}`}>
              {cloudKeyReady
                ? `Runs on ${cloudModel.provider}'s servers — a paid request. The result arrives in the history when ready, even after a reload.`
                : `No ${cloudModel.keyHint} — add it in Settings → APIs.`}
            </span>
          )}
          {!cloudModel && !workflowsLoading && !workflowsError && !tabWorkflows.length && (
            <span className="workspace-hint">
              {tab === 'multiview'
                ? 'Install a multi-view workflow (Trellis2 MultiView, Pixal3D MultiView) from the Setup Wizard, or pick a cloud API.'
                : 'Install an image-to-mesh workflow (Trellis2, Pixal3D, Hunyuan…) from the Setup Wizard, or pick a cloud API.'}
            </span>
          )}
        </div>

        {cloudModel && cloudOptions && (
          <WorkspaceCloudMeshFields
            model={cloudModel}
            options={cloudOptions}
            tab={tab}
            onChange={updateCloudOptions}
            seed={settings.cloudSeed}
            onSeedChange={(value) => updateSettings({ cloudSeed: value })}
            randomSeed={settings.randomSeed}
            onToggleRandomSeed={() => updateSettings({ randomSeed: !settings.randomSeed })}
          />
        )}

        {roles?.faces && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Target Faces</span>
              <span className="workspace-section__aside">{formatFaceCount(facesValue)}</span>
            </div>
            <div className="workspace-chips workspace-chips--even">
              {FACE_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  className={`workspace-chip workspace-chip--box ${facesValue === preset.value ? 'workspace-chip--active' : ''}`}
                  onClick={() => updateSettings({ faces: preset.value })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <input
              className="workspace-input"
              type="number"
              min={100}
              step={1000}
              value={facesValue ?? ''}
              onChange={event => updateSettings({ faces: event.target.value === '' ? null : Number(event.target.value) })}
              aria-label="Target face count"
            />
          </div>
        )}

        {roles?.textureSize && (
          <div className="workspace-section">
            <div className="workspace-section__head"><span>Texture Size</span></div>
            <div className="workspace-chips workspace-chips--even">
              {TEXTURE_SIZES.map(size => (
                <button
                  key={size}
                  type="button"
                  className={`workspace-chip workspace-chip--box ${textureValue === size ? 'workspace-chip--active' : ''}`}
                  onClick={() => updateSettings({ textureSize: size })}
                  title={`${size} × ${size}`}
                >
                  {size >= 1024 ? `${size / 1024}K` : size}
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
              onToggleRandomSeed={() => updateSettings({ randomSeed: !settings.randomSeed })}
            />
          </div>
        )}

        {roles?.advanced.length > 0 && (
          <div className="workspace-section">
            <button
              type="button"
              className="workspace-disclosure"
              onClick={() => setShowAdvanced(open => !open)}
              aria-expanded={showAdvanced}
            >
              <span>Advanced</span>
              <span className="material-symbols-outlined">{showAdvanced ? 'expand_less' : 'expand_more'}</span>
            </button>
            {showAdvanced && (
              <div className="workspace-advanced">
                {roles.advanced.map(parameter => (
                  <WorkspaceParamField
                    key={parameter.id}
                    parameter={parameter}
                    value={values[parameter.id]}
                    onChange={setValue}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="workspace-panel__footer">
        {status && (
          <div className={`workspace-status ${status.tone === 'error' ? 'workspace-status--error' : ''}`}>{status.message}</div>
        )}
        {!cloudModel && workflow && tab === 'multiview' && layoutViews.length > 0 && (
          <span className="workspace-hint workspace-hint--center">
            {layoutViews.filter(view => views[view.key]?.sourceReference).length} of {layoutViews.length} views · {layoutViews[0].label} required, the others optional
          </span>
        )}
        {cloudModel && tab === 'multiview' && (
          <span className="workspace-hint workspace-hint--center">
            {DEFAULT_VIEWS.filter(view => views[view.key]?.sourceReference).length} of 4 views · Front + at least one more
          </span>
        )}
        <button
          type="button"
          className="workspace-run-btn"
          onClick={run}
          disabled={Boolean(blocker)}
          title={blocker || (cloudModel ? `Send to ${cloudModel.label} (${formatCloudFaces(cloudOptions?.faces)} faces)` : 'Generate the 3D model')}
        >
          <span className="material-symbols-outlined">deployed_code</span>
          Generate Mesh
        </button>
        {blocker && <span className="workspace-hint workspace-hint--center">{blocker}</span>}
      </div>

      {assetPicker && (
        <AssetSelectorModal
          assetType="image"
          showEdits
          onSelect={handleAssetPicked}
          onClose={() => setAssetPicker(null)}
        />
      )}
    </div>
  )
}
