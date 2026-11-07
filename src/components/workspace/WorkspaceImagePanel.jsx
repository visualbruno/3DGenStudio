// Workspace → Image module. Generate an image from text, or — once a source
// image is attached — edit it. The dropdown lists the installed ComfyUI
// workflows that fit the mode, then the cloud image APIs (Nano Banana, GPT
// Image). For a workflow, prompt, size and number of images are mapped onto its
// own parameters (see src/utils/workspaceImage.js); for a cloud API they become
// the request's aspect ratio / size, and the count becomes that many requests.
//
// Saving is the app's usual: a generation is a new ROOT asset, an edit is
// saved as a child of its source (autoParentFromInputs). Every output is also
// logged to the project's Workspace history.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { useSettings } from '../../context/SettingsContext.shared'
import { useNotifications } from '../../context/NotificationContext'
import { useWorkflowJobs } from '../../context/WorkflowJobsContext'
import { assetUrl } from '../../config'
import { createComfyExecutionId } from '../../utils/ids'
import { readEntryDragData } from '../../utils/workspaceDrag'
import { addWorkspaceHistory, fetchComfyWorkflows, resolveSourceReference } from '../../utils/workspaceApi'
import {
  ASPECT_RATIOS,
  CLOUD_IMAGE_MODELS,
  CLOUD_PROVIDER_NAMES,
  IMAGE_COUNTS,
  SIZE_PRESETS,
  cloudModelValue,
  coerceParameterValue,
  defaultParameterValues,
  filterWorkflowsForMode,
  findCloudModel,
  getParameterValueType,
  hasCloudApiKey,
  nearestCloudAspectRatio,
  openAiSizeLabel,
  planSubmissions,
  randomSeed,
  resolveWorkflowRoles,
  sizeParameterValues,
  workflowLabel
} from '../../utils/workspaceImage'
import ComfyTextButton from '../comfy/ComfyTextButton'
import WorkspaceParamField from './WorkspaceParamField'
import AssetSelectorModal from '../AssetSelectorModal'

const SETTINGS_KEY = 'workspace.image.settings.v1'
const PROMPT_LIMIT = 10000

const DEFAULT_SETTINGS = {
  workflowIds: { generate: '', edit: '' },
  aspectIds: { generate: '1:1', edit: 'source' },
  size: 1024,
  cloudSize: '1K',
  count: 1,
  randomSeed: true
}

// Per-viewer convenience only: a blocked or cleared storage just means the
// panel opens on the defaults.
function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      workflowIds: { ...DEFAULT_SETTINGS.workflowIds, ...(parsed.workflowIds || {}) },
      aspectIds: { ...DEFAULT_SETTINGS.aspectIds, ...(parsed.aspectIds || {}) }
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

function resultName(prompt, workflow) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim()
  if (!text) return workflowLabel(workflow)
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

function describeExtraValue(value) {
  if (!value) return 'Choose image'
  if (value instanceof File) return value.name
  return value.name || 'Selected asset'
}

export default function WorkspaceImagePanel({
  projectId,
  projectName,
  source,
  sourceBusy,
  onPickSourceFile,
  onPickSourceAsset,
  onPickSourceEntry,
  onClearSource,
  onRunComplete,
  onPendingAdd,
  onPendingRemove,
  reuse
}) {
  const { runComfyWorkflow, generateImage, runImageEditApi } = useProjects()
  const { settings: appSettings } = useSettings()
  const { addNotification } = useNotifications()
  const { registerJob, completeJob } = useWorkflowJobs()

  const mode = source ? 'edit' : 'generate'

  const [workflows, setWorkflows] = useState([])
  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [workflowsError, setWorkflowsError] = useState('')
  const [workflowsVersion, setWorkflowsVersion] = useState(0)
  const [settings, setSettings] = useState(readSettings)
  const [prompt, setPrompt] = useState('')
  const [valuesByWorkflow, setValuesByWorkflow] = useState({})
  const [extraImages, setExtraImages] = useState({})
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [status, setStatus] = useState(null)
  const [assetPicker, setAssetPicker] = useState(null) // 'source' | parameter id
  const [dragOver, setDragOver] = useState(false)
  const [appliedReuseNonce, setAppliedReuseNonce] = useState(null)
  const sourceFileRef = useRef(null)
  const extraFileRefs = useRef({})

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

  const modeWorkflows = useMemo(() => filterWorkflowsForMode(workflows, mode), [workflows, mode])
  const storedWorkflowId = settings.workflowIds[mode]
  // A cloud API when one is chosen — or when no workflow fits at all, so the
  // panel is still usable on an install without ComfyUI workflows.
  const storedWorkflow = modeWorkflows.find(wf => String(wf.id) === String(storedWorkflowId)) || null
  const cloudModel = findCloudModel(storedWorkflowId)
    || (!storedWorkflow && !modeWorkflows.length && !workflowsLoading ? CLOUD_IMAGE_MODELS[0] : null)
  const workflow = cloudModel ? null : (storedWorkflow || modeWorkflows[0] || null)
  const cloudKeyReady = cloudModel ? hasCloudApiKey(cloudModel, appSettings) : false
  const roles = useMemo(() => (workflow ? resolveWorkflowRoles(workflow) : null), [workflow])
  const values = workflow ? (valuesByWorkflow[workflow.id] || defaultParameterValues(workflow)) : {}

  const aspectId = settings.aspectIds[mode] || '1:1'
  const sourceAspect = source?.width > 0 && source?.height > 0 ? { id: 'source', w: source.width, h: source.height } : null
  const aspect = aspectId === 'source'
    ? (sourceAspect || ASPECT_RATIOS[0])
    : (ASPECT_RATIOS.find(entry => entry.id === aspectId) || ASPECT_RATIOS[0])
  // What a cloud request asks for: "Source" becomes the closest ratio it takes.
  const cloudAspectRatio = aspectId === 'source'
    ? (sourceAspect ? nearestCloudAspectRatio(sourceAspect.w, sourceAspect.h) : '1:1')
    : (ASPECT_RATIOS.find(entry => entry.id === aspectId)?.id || '1:1')
  const cloudSize = cloudModel?.sizes
    ? (cloudModel.sizes.includes(settings.cloudSize) ? settings.cloudSize : cloudModel.sizes[0])
    : null

  // Reuse the settings of a history entry ("Reuse" in the center view). Applied
  // while rendering, once per request, so the fields never paint stale.
  if (reuse && reuse.nonce !== appliedReuseNonce) {
    setAppliedReuseNonce(reuse.nonce)
    const entry = reuse.entry
    setPrompt(entry.prompt || '')
    const reuseMode = entry.action === 'edit' ? 'edit' : 'generate'
    const params = entry.params || {}
    const reuseModel = params.api ? CLOUD_IMAGE_MODELS.find(model => model.id === params.api) : null
    const reuseValue = reuseModel ? cloudModelValue(reuseModel) : (entry.workflowId ? String(entry.workflowId) : null)
    setSettings(prev => ({
      ...prev,
      workflowIds: reuseValue ? { ...prev.workflowIds, [reuseMode]: reuseValue } : prev.workflowIds,
      aspectIds: params.aspect ? { ...prev.aspectIds, [reuseMode]: params.aspect } : prev.aspectIds,
      size: Number(params.size) || prev.size,
      cloudSize: params.cloudSize || prev.cloudSize,
      count: Number(params.count) || prev.count
    }))
    if (entry.workflowId && params.values && typeof params.values === 'object') {
      setValuesByWorkflow(prev => ({ ...prev, [entry.workflowId]: { ...(prev[entry.workflowId] || {}), ...params.values } }))
    }
  }

  const updateSettings = (patch) => setSettings(prev => ({ ...prev, ...patch }))

  const selectWorkflow = (id) => {
    setSettings(prev => ({ ...prev, workflowIds: { ...prev.workflowIds, [mode]: id } }))
    setExtraImages({})
  }

  const setAspect = (id) => {
    setSettings(prev => ({ ...prev, aspectIds: { ...prev.aspectIds, [mode]: id } }))
  }

  const setValue = (parameterId, value) => {
    if (!workflow) return
    setValuesByWorkflow(prev => ({
      ...prev,
      [workflow.id]: { ...(prev[workflow.id] || defaultParameterValues(workflow)), [parameterId]: value }
    }))
  }

  const handleSourceFiles = (files) => {
    const file = Array.from(files || []).find(candidate => candidate.type?.startsWith('image/'))
    if (file) onPickSourceFile(file)
  }

  // A history image dropped here becomes the image to edit; files from the
  // computer are imported first.
  const handleDrop = (event) => {
    event.preventDefault()
    setDragOver(false)
    if (sourceBusy) return
    const entry = readEntryDragData(event)
    if (entry) {
      if (entry.asset.type === 'image') onPickSourceEntry?.(entry)
      return
    }
    handleSourceFiles(event.dataTransfer?.files)
  }

  const handleAssetPicked = async (asset) => {
    const target = assetPicker
    setAssetPicker(null)
    if (!asset) return
    if (target === 'source') {
      onPickSourceAsset(asset)
      return
    }
    try {
      const { sourceReference } = await resolveSourceReference(projectId, 'image', asset.filename || asset.filePath)
      setExtraImages(prev => ({ ...prev, [target]: { source: sourceReference, name: asset.name || 'Selected asset' } }))
    } catch (err) {
      setStatus({ tone: 'error', message: err.message || 'Failed to use the selected asset.' })
    }
  }

  // Why the button is disabled, or null when a run can start.
  const blocker = (() => {
    if (cloudModel) {
      if (!cloudKeyReady) return `Add your ${CLOUD_PROVIDER_NAMES[cloudModel.provider]} API key in Settings`
      if (sourceBusy) return 'Importing the image…'
      if (!prompt.trim()) return mode === 'edit' ? 'Describe the change first' : 'Describe the image first'
      if (mode === 'edit' && !source?.sourceReference) return 'Choose a source image'
      return null
    }
    if (!workflow) return mode === 'edit' ? 'No image-edit workflow installed' : 'No text-to-image workflow installed'
    if (sourceBusy) return 'Importing the image…'
    if (roles.prompt && !prompt.trim()) return 'Describe the image first'
    const missingExtra = roles.extraImages.find(parameter => !extraImages[parameter.id])
    if (missingExtra) return `Choose the ${missingExtra.name}`
    if (mode === 'edit' && !source?.sourceReference) return 'Choose a source image'
    return null
  })()

  // Cloud API: one request per image. No ComfyUI job exists, so the history
  // panel shows a waiting tile (onPendingAdd/Remove) instead of progress.
  const runCloud = async () => {
    const runModel = cloudModel
    const runMode = mode
    const runSource = source
    const runPrompt = prompt.trim()
    const runId = createComfyExecutionId('workspace-run')
    const request = {
      selectedApi: runModel.id,
      prompt: runPrompt,
      name: resultName(runPrompt, { name: runModel.label }),
      detachedAsset: true,
      aspectRatio: cloudAspectRatio,
      ...(cloudSize ? { imageSize: cloudSize } : {})
    }
    const historyParams = {
      api: runModel.id,
      aspect: aspectId,
      ...(cloudSize ? { cloudSize } : {}),
      count: settings.count
    }
    const label = `${runMode === 'edit' ? 'Edit' : 'Generate'} · ${runModel.label}`
    setStatus(null)

    const runOne = async (index) => {
      const pendingId = `${runId}-${index}`
      onPendingAdd?.({ id: pendingId, label, cloud: true, createdAt: Date.now() })
      try {
        const assets = runMode === 'edit'
          ? ((await runImageEditApi(projectId, { ...request, imageSource: runSource.sourceReference }))?.savedEdits || [])
          : [await generateImage(projectId, request)]
        const images = assets.filter(asset => asset && asset.id != null)
        const entries = images.length
          ? await addWorkspaceHistory(projectId, images.map(asset => ({
              assetId: asset.id,
              module: 'image',
              action: runMode,
              runId,
              sourceAssetId: runMode === 'edit' ? runSource?.assetId ?? null : null,
              prompt: runPrompt,
              workflowName: runModel.label,
              params: historyParams
            })))
          : []
        onRunComplete(entries)
        return { ok: true }
      } catch (err) {
        console.error('Workspace cloud image run failed', err)
        addNotification({
          title: runMode === 'edit' ? 'Image edit failed' : 'Image generation failed',
          message: err.message || 'The image API failed',
          tone: 'error',
          source: runModel.label,
          projectId
        })
        return { ok: false, error: err.message }
      } finally {
        onPendingRemove?.(pendingId)
      }
    }

    const total = Math.max(1, Math.min(8, Number(settings.count) || 1))
    const results = await Promise.all(Array.from({ length: total }, (_, index) => runOne(index)))
    const failed = results.find(result => !result.ok)
    if (failed) setStatus({ tone: 'error', message: failed.error || 'The image API failed.' })
  }

  const run = async () => {
    if (blocker) return
    if (cloudModel) {
      await runCloud()
      return
    }
    if (!workflow) return
    const runWorkflow = workflow
    const runRoles = roles
    const runMode = mode
    const runSource = source
    const runPrompt = prompt.trim()
    const runId = createComfyExecutionId('workspace-run')

    // Scalars the user can see (coerced), then the friendly controls on top.
    const scalarValues = {}
    for (const parameter of runWorkflow.parameters || []) {
      if (['image', 'video', 'mesh'].includes(getParameterValueType(parameter))) continue
      if (Object.prototype.hasOwnProperty.call(values, parameter.id)) {
        scalarValues[parameter.id] = coerceParameterValue(parameter, values[parameter.id])
      }
    }
    const baseInputs = {
      ...scalarValues,
      ...sizeParameterValues(runRoles, { size: settings.size, aspect }),
      ...(runRoles.prompt ? { [runRoles.prompt.id]: runPrompt } : {}),
      ...(runRoles.sourceImage && runSource ? { [runRoles.sourceImage.id]: { source: runSource.sourceReference, name: runSource.name } } : {}),
      ...extraImages
    }
    const seed = runRoles.seed
      ? (settings.randomSeed ? randomSeed() : Number(values[runRoles.seed.id]) || 0)
      : null
    const submissions = planSubmissions({ roles: runRoles, baseInputs, count: settings.count, seed })
    const historyParams = {
      aspect: aspectId,
      size: settings.size,
      count: settings.count,
      values: scalarValues
    }

    setStatus(null)

    const runOne = async (submission) => {
      const promptId = createComfyExecutionId('comfy-prompt')
      const clientId = createComfyExecutionId('comfy-client')
      registerJob({
        id: promptId,
        projectId,
        projectName,
        page: 'workspace',
        targetId: 'image',
        kind: 'image',
        label: `${runMode === 'edit' ? 'Edit' : 'Generate'} · ${workflowLabel(runWorkflow)}`
      })
      try {
        const assets = await runComfyWorkflow(projectId, {
          workflowId: runWorkflow.id,
          inputs: submission.inputs,
          name: resultName(runPrompt, runWorkflow),
          clientId,
          promptId,
          persistProcessingCard: false,
          detachedAsset: true,
          // An edit is saved as a child of its source image; a generation has
          // no image input, so it stays a new root asset either way.
          autoParentFromInputs: runMode === 'edit'
        })
        const images = (Array.isArray(assets) ? assets : [assets])
          .filter(asset => asset && asset.id != null && (asset.type ? asset.type === 'image' : true))
        const seedValue = runRoles.seed ? submission.inputs[runRoles.seed.id] : undefined
        const entries = images.length
          ? await addWorkspaceHistory(projectId, images.map(asset => ({
              assetId: asset.id,
              module: 'image',
              action: runMode,
              runId,
              sourceAssetId: runMode === 'edit' ? runSource?.assetId ?? null : null,
              prompt: runPrompt,
              workflowId: runWorkflow.id,
              workflowName: runWorkflow.name,
              params: { ...historyParams, ...(seedValue !== undefined ? { seed: seedValue } : {}) }
            })))
          : []
        completeJob(promptId, { status: 'completed' })
        onRunComplete(entries)
        return { ok: true, count: entries.length }
      } catch (err) {
        if (err?.cancelled) {
          completeJob(promptId, { status: 'cancelled' })
          return { ok: false, cancelled: true }
        }
        console.error('Workspace image run failed', err)
        completeJob(promptId, { status: 'error', error: err.message })
        addNotification({
          title: runMode === 'edit' ? 'Image edit failed' : 'Image generation failed',
          message: err.message || 'ComfyUI workflow failed',
          tone: 'error',
          source: runWorkflow.name,
          projectId
        })
        return { ok: false, error: err.message }
      }
    }

    // Runs are queued on ComfyUI and report into the history panel as they
    // finish, so the button stays free for the next one.
    const results = await Promise.all(submissions.map(runOne))
    const failed = results.filter(result => !result.ok && !result.cancelled)
    if (failed.length) {
      setStatus({ tone: 'error', message: failed[0].error || 'The workflow failed.' })
    }
  }

  const renderScalarField = (parameter) => (
    <WorkspaceParamField
      key={parameter.id}
      parameter={parameter}
      value={values[parameter.id]}
      onChange={setValue}
      {...(roles?.seed === parameter
        ? { randomSeed: settings.randomSeed, onToggleRandomSeed: () => updateSettings({ randomSeed: !settings.randomSeed }) }
        : {})}
    />
  )

  const sizeSupportsAspect = roles?.sizeMode === 'wh'
  const showSize = Boolean(roles?.sizeMode)

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">{mode === 'edit' ? 'auto_fix_high' : 'imagesmode'}</span>
        {mode === 'edit' ? 'Edit Image' : 'Generate Image'}
      </div>

      <div className="workspace-panel__scroll">
        <div
          className={`workspace-prompt ${dragOver ? 'workspace-prompt--drag' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {source && (
            <div className="workspace-source">
              <img src={assetUrl(source.thumbnail || source.filename)} alt={source.name} className="workspace-source__thumb" />
              <div className="workspace-source__meta">
                <span className="workspace-source__label">Editing</span>
                <span className="workspace-source__name" title={source.name}>{source.name}</span>
                {source.width > 0 && <span className="workspace-source__dims">{source.width} × {source.height}</span>}
              </div>
              <button type="button" className="workspace-icon-btn" onClick={onClearSource} title="Stop editing — back to Generate">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
          )}

          <textarea
            className="workspace-prompt__text"
            value={prompt}
            maxLength={PROMPT_LIMIT}
            onChange={event => setPrompt(event.target.value)}
            disabled={Boolean(workflow) && !roles?.prompt}
            placeholder={
              workflow && !roles?.prompt
                ? 'This workflow takes no prompt.'
                : mode === 'edit'
                  ? 'Describe the change to make to the image…'
                  : 'Describe the image to create, or import an image to edit it…'
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                run()
              }
            }}
          />

          <div className="workspace-prompt__bar">
            <button
              type="button"
              className="workspace-icon-btn"
              onClick={() => sourceFileRef.current?.click()}
              title="Import an image from the computer to edit it"
              disabled={sourceBusy}
            >
              <span className="material-symbols-outlined">add_photo_alternate</span>
            </button>
            <button
              type="button"
              className="workspace-icon-btn"
              onClick={() => setAssetPicker('source')}
              title="Pick an image from the Assets library to edit it"
              disabled={sourceBusy}
            >
              <span className="material-symbols-outlined">photo_library</span>
            </button>
            {(!roles || roles.prompt) && <ComfyTextButton onResult={text => setPrompt(text)} title="Write the prompt with ComfyUI" />}
            <span className="workspace-prompt__count">{prompt.length}/{PROMPT_LIMIT}</span>
          </div>
          <input
            ref={sourceFileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(event) => { handleSourceFiles(event.target.files); event.target.value = '' }}
          />
        </div>

        <div className="workspace-section">
          <div className="workspace-section__head">
            <span>{mode === 'edit' ? 'Edit Model' : 'Generation Model'}</span>
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
            value={cloudModel ? cloudModelValue(cloudModel) : (workflow ? String(workflow.id) : '')}
            onChange={event => selectWorkflow(event.target.value)}
          >
            {!cloudModel && !workflow && <option value="">Loading workflows…</option>}
            <optgroup label="ComfyUI (local)">
              {modeWorkflows.map(wf => (
                <option key={wf.id} value={String(wf.id)} title={wf.name}>{workflowLabel(wf)}</option>
              ))}
              {!modeWorkflows.length && (
                <option value="" disabled>{workflowsLoading ? 'Loading…' : 'No compatible workflow installed'}</option>
              )}
            </optgroup>
            <optgroup label="Cloud APIs">
              {CLOUD_IMAGE_MODELS.map(model => (
                <option key={model.id} value={cloudModelValue(model)}>
                  {model.label}{hasCloudApiKey(model, appSettings) ? '' : ' — no API key'}
                </option>
              ))}
            </optgroup>
          </select>
          {workflowsError && <span className="workspace-hint workspace-hint--error">{workflowsError}</span>}
          {cloudModel && (
            <span className={`workspace-hint ${cloudKeyReady ? '' : 'workspace-hint--error'}`}>
              {cloudKeyReady
                ? `Runs on ${CLOUD_PROVIDER_NAMES[cloudModel.provider]}'s servers — each image is a paid request.`
                : `No ${CLOUD_PROVIDER_NAMES[cloudModel.provider]} API key — add one in Settings → APIs.`}
            </span>
          )}
          {!cloudModel && !workflowsLoading && !workflowsError && !modeWorkflows.length && (
            <span className="workspace-hint">
              {mode === 'edit'
                ? 'Install an image-edit workflow (Flux2 Klein, Qwen Image Edit…) from the Setup Wizard, or pick a cloud API.'
                : 'Install a text-to-image workflow (Flux2 Klein, Qwen Image, Z Image…) from the Setup Wizard, or pick a cloud API.'}
            </span>
          )}
        </div>

        {roles?.extraImages.length > 0 && (
          <div className="workspace-section">
            {roles.extraImages.map(parameter => (
              <div className="workspace-field" key={parameter.id}>
                <span className="workspace-field__label">{parameter.name}</span>
                <div className="workspace-field__row">
                  <button
                    type="button"
                    className={`workspace-file-btn ${extraImages[parameter.id] ? 'workspace-file-btn--set' : ''}`}
                    onClick={() => extraFileRefs.current[parameter.id]?.click()}
                    title="Choose a file from the computer"
                  >
                    <span className="material-symbols-outlined">upload</span>
                    <span className="workspace-file-btn__text">{describeExtraValue(extraImages[parameter.id])}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-icon-btn"
                    onClick={() => setAssetPicker(parameter.id)}
                    title="Pick from the Assets library"
                  >
                    <span className="material-symbols-outlined">photo_library</span>
                  </button>
                </div>
                <input
                  ref={element => { extraFileRefs.current[parameter.id] = element }}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) setExtraImages(prev => ({ ...prev, [parameter.id]: file }))
                    event.target.value = ''
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {(cloudModel || (showSize && sizeSupportsAspect)) && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Aspect Ratio</span>
              {cloudModel?.provider === 'openai' && (
                <span className="workspace-section__aside" title="GPT Image only makes square, landscape and portrait sizes">
                  {openAiSizeLabel(cloudAspectRatio)}
                </span>
              )}
              {cloudModel?.provider === 'google' && aspectId === 'source' && (
                <span className="workspace-section__aside">{cloudAspectRatio}</span>
              )}
            </div>
            <div className="workspace-chips">
              {mode === 'edit' && (
                <button
                  type="button"
                  className={`workspace-chip workspace-chip--box ${aspectId === 'source' ? 'workspace-chip--active' : ''}`}
                  onClick={() => setAspect('source')}
                  title="Keep the source image's proportions"
                >
                  Source
                </button>
              )}
              {ASPECT_RATIOS.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  className={`workspace-chip workspace-chip--box ${aspectId === entry.id ? 'workspace-chip--active' : ''}`}
                  onClick={() => setAspect(entry.id)}
                >
                  {entry.id}
                </button>
              ))}
            </div>
          </div>
        )}

        {cloudModel?.sizes && (
          <div className="workspace-section">
            <div className="workspace-section__head"><span>Resolution</span></div>
            <div className="workspace-chips workspace-chips--even">
              {cloudModel.sizes.map(size => (
                <button
                  key={size}
                  type="button"
                  className={`workspace-chip workspace-chip--box ${cloudSize === size ? 'workspace-chip--active' : ''}`}
                  onClick={() => updateSettings({ cloudSize: size })}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
        )}

        {!cloudModel && showSize && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>{sizeSupportsAspect ? 'Size (long side)' : 'Size'}</span>
              {sizeSupportsAspect && (() => {
                const width = sizeParameterValues(roles, { size: settings.size, aspect })[roles.width.id]
                const height = sizeParameterValues(roles, { size: settings.size, aspect })[roles.height.id]
                return <span className="workspace-section__aside">{width} × {height}</span>
              })()}
            </div>
            <div className="workspace-chips workspace-chips--even">
              {SIZE_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  className={`workspace-chip workspace-chip--box ${settings.size === preset.value ? 'workspace-chip--active' : ''}`}
                  onClick={() => updateSettings({ size: preset.value })}
                  title={`${preset.value} px`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="workspace-section">
          <div className="workspace-section__head">
            <span>Number of Images</span>
            {roles && !roles.count && settings.count > 1 && (
              <span className="workspace-section__aside" title="This workflow makes one image per run, so each image is its own run with its own seed">
                {settings.count} runs
              </span>
            )}
            {cloudModel && settings.count > 1 && (
              <span className="workspace-section__aside" title="One API request per image">
                {settings.count} requests
              </span>
            )}
          </div>
          <div className="workspace-chips workspace-chips--even">
            {IMAGE_COUNTS.map(count => (
              <button
                key={count}
                type="button"
                className={`workspace-chip workspace-chip--box ${settings.count === count ? 'workspace-chip--active' : ''}`}
                onClick={() => updateSettings({ count })}
              >
                {count}
              </button>
            ))}
          </div>
        </div>

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
                {roles.advanced.map(renderScalarField)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="workspace-panel__footer">
        {status && (
          <div className={`workspace-status ${status.tone === 'error' ? 'workspace-status--error' : ''}`}>{status.message}</div>
        )}
        <button
          type="button"
          className="workspace-run-btn"
          onClick={run}
          disabled={Boolean(blocker)}
          title={blocker || 'Ctrl+Enter'}
        >
          <span className="material-symbols-outlined">{mode === 'edit' ? 'auto_fix_high' : 'auto_awesome'}</span>
          {mode === 'edit' ? 'Edit Image' : 'Generate Image'}
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
