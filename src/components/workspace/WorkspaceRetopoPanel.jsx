// Workspace → Retopo module. Run on a stored mesh:
//   - Auto Retopo: check the mesh, Repair its non-manifold edges, then rebuild
//     clean topology (optionally as a watertight shell) — Mesh Editor tools,
//     src/utils/workspaceRetopo.js;
//   - Optimize: decimate with gltfpack, keeping UVs / texture;
//   - Refine: rebuild the mesh's detail from a reference image with a ComfyUI
//     workflow (Refine Mesh with Trellis2 / Hi3D — isRefineWorkflow).
// Every result is saved as a new VERSION of the source mesh, logged to the
// history, and becomes the panel's source — so the tools chain.
import { useEffect, useMemo, useState } from 'react'
import { useProjects } from '../../context/ProjectContext'
import { useNotifications } from '../../context/NotificationContext'
import { useWorkflowJobs } from '../../context/WorkflowJobsContext'
import { assetUrl } from '../../config'
import { createComfyExecutionId } from '../../utils/ids'
import { DEFAULT_AUTO_RETOPO_OPTIONS, DEFAULT_OPTIMIZE_OPTIONS, DEFAULT_REPAIR_OPTIONS } from '../../utils/meshTools'
import { createMeshThumbnailFile, createMeshThumbnailFileFromUrl } from '../../utils/meshThumbnail'
import { fetchComfyWorkflows, resolveSourceReference, uploadAssetThumbnail } from '../../utils/workspaceApi'
import { coerceParameterValue, defaultParameterValues, getParameterValueType, randomSeed } from '../../utils/workspaceImage'
import { FACE_PRESETS, formatFaceCount, snapToEnums } from '../../utils/workspaceMesh'
import { filterRefineWorkflows, refineWorkflowLabel, resolveRefineRoles } from '../../utils/workspaceTexture'
import WorkspaceImageSlot from './WorkspaceImageSlot'
import WorkspaceParamField from './WorkspaceParamField'
import {
  OPTIMIZE_RATIO_PRESETS,
  RETOPO_FACE_PRESETS,
  RETOPO_TOOLS,
  checkMesh,
  describeResult,
  runRetopoTool,
  saveMeshVersion,
  versionName
} from '../../utils/workspaceRetopo'
import AssetSelectorModal from '../AssetSelectorModal'
import WorkspaceMeshSlot from './WorkspaceMeshSlot'
import { Disclosure, NumberInput, ResultRows, Select, Switch } from './WorkspaceControls'

const SETTINGS_KEY = 'workspace.retopo.settings.v1'

const TABS = [
  { id: 'autoretopo', label: 'Auto Retopo', icon: 'grid_4x4' },
  { id: 'optimize', label: 'Optimize', icon: 'compress' },
  { id: 'refine', label: 'Refine', icon: 'auto_fix_high' }
]

const TAB_IDS = TABS.map(entry => entry.id)

const DEFAULT_REFINE = {
  workflowId: '',
  faces: null,      // null = the workflow's own default
  randomSeed: true
}

const DEFAULT_SETTINGS = {
  tab: 'autoretopo',
  retopo: DEFAULT_AUTO_RETOPO_OPTIONS,
  repair: DEFAULT_REPAIR_OPTIONS,
  optimize: DEFAULT_OPTIMIZE_OPTIONS,
  refine: DEFAULT_REFINE
}

function refinedName(asset) {
  const base = String(asset?.name || 'Mesh').replace(/\.[^.]+$/, '').replace(/\s*\((retopo|repaired|optimized|refined)\)$/i, '')
  return `${base} (refined)`
}

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    return {
      tab: TAB_IDS.includes(parsed.tab) ? parsed.tab : 'autoretopo',
      retopo: { ...DEFAULT_AUTO_RETOPO_OPTIONS, ...(parsed.retopo || {}) },
      repair: { ...DEFAULT_REPAIR_OPTIONS, ...(parsed.repair || {}) },
      optimize: { ...DEFAULT_OPTIMIZE_OPTIONS, ...(parsed.optimize || {}) },
      refine: { ...DEFAULT_REFINE, ...(parsed.refine || {}) }
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

const CHECK_STATUS_ICONS = { pass: 'check_circle', warn: 'warning', fail: 'error' }

export default function WorkspaceRetopoPanel({
  target,
  targetBusy,
  importers,
  imageImporters,
  onTargetChange,
  selectedMeshEntry,
  selectedImageEntry,
  onResult,
  onPendingAdd,
  onPendingUpdate,
  onPendingRemove,
  reuse,
  projectId,
  projectName
}) {
  const { runComfyWorkflow } = useProjects()
  const { addNotification } = useNotifications()
  const { registerJob, completeJob } = useWorkflowJobs()
  const [settings, setSettings] = useState(readSettings)
  const [running, setRunning] = useState(null)       // tool id
  const [progress, setProgress] = useState(null)     // { frac, message }
  const [status, setStatus] = useState(null)
  const [lastResult, setLastResult] = useState(null) // { label, rows, assetId }
  // Refine: the installed workflows, the reference image, per-workflow values.
  const [workflows, setWorkflows] = useState([])
  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [workflowsError, setWorkflowsError] = useState('')
  const [workflowsVersion, setWorkflowsVersion] = useState(0)
  const [refineImage, setRefineImage] = useState(null)
  const [refineImageBusy, setRefineImageBusy] = useState(false)
  const [valuesByWorkflow, setValuesByWorkflow] = useState({})
  const [imagePicker, setImagePicker] = useState(false)
  const [check, setCheck] = useState(null)           // { assetId, loading, result, error }
  const [assetPicker, setAssetPicker] = useState(false)
  const [slotBusy, setSlotBusy] = useState(false)
  const [appliedReuseNonce, setAppliedReuseNonce] = useState(null)

  useEffect(() => { writeSettings(settings) }, [settings])

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

  // "Reuse settings" on a Retopo history entry: its tool and options.
  if (reuse && reuse.nonce !== appliedReuseNonce) {
    setAppliedReuseNonce(reuse.nonce)
    const params = reuse.entry.params || {}
    if (params.tool === 'refine') {
      setSettings(prev => ({
        ...prev,
        tab: 'refine',
        refine: {
          ...prev.refine,
          workflowId: params.workflowId ? String(params.workflowId) : prev.refine.workflowId,
          faces: Number(params.faces) || prev.refine.faces
        }
      }))
      if (params.workflowId && params.values) {
        setValuesByWorkflow(prev => ({ ...prev, [params.workflowId]: { ...(prev[params.workflowId] || {}), ...params.values } }))
      }
    } else {
      const key = params.tool === 'optimize' ? 'optimize' : params.tool === 'repair' ? 'repair' : 'retopo'
      setSettings(prev => ({
        ...prev,
        tab: params.tool === 'optimize' ? 'optimize' : 'autoretopo',
        [key]: { ...prev[key], ...(params.options || {}) }
      }))
    }
  }

  const tab = TAB_IDS.includes(settings.tab) ? settings.tab : 'autoretopo'
  const retopo = settings.retopo
  const repair = settings.repair
  const optimize = settings.optimize
  const refine = settings.refine
  const setOptions = (key, patch) => setSettings(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }))

  const refineWorkflows = useMemo(() => filterRefineWorkflows(workflows), [workflows])
  const refineWorkflow = refineWorkflows.find(wf => String(wf.id) === String(refine.workflowId)) || refineWorkflows[0] || null
  const refineRoles = useMemo(() => (refineWorkflow ? resolveRefineRoles(refineWorkflow) : null), [refineWorkflow])
  const refineValues = refineWorkflow ? (valuesByWorkflow[refineWorkflow.id] || defaultParameterValues(refineWorkflow)) : {}
  const refineFaces = refineRoles?.faces
    ? (refine.faces ?? (Number(refineValues[refineRoles.faces.id]) || null))
    : null
  const setRefineValue = (parameterId, value) => {
    if (!refineWorkflow) return
    setValuesByWorkflow(prev => ({
      ...prev,
      [refineWorkflow.id]: { ...(prev[refineWorkflow.id] || defaultParameterValues(refineWorkflow)), [parameterId]: value }
    }))
  }

  const busy = Boolean(running) || targetBusy || slotBusy || refineImageBusy
  const currentCheck = check && check.assetId === target?.assetId ? check : null
  const currentResult = lastResult && lastResult.assetId === target?.assetId ? lastResult : null

  const fillTarget = async (load) => {
    setSlotBusy(true)
    try {
      onTargetChange(await load())
      setStatus(null)
    } catch (err) {
      setStatus({ tone: 'error', message: err.message || 'Could not use that mesh.' })
    } finally {
      setSlotBusy(false)
    }
  }

  const runCheck = async () => {
    if (!target) return
    const assetId = target.assetId
    setCheck({ assetId, loading: true })
    try {
      setCheck({ assetId, loading: false, result: await checkMesh({ id: assetId, ...target }) })
    } catch (err) {
      setCheck({ assetId, loading: false, error: err.message || 'The check failed.' })
    }
  }

  const runTool = async (toolId, options) => {
    if (!target || running) return
    const runTarget = target
    const tool = RETOPO_TOOLS[toolId]
    const pendingId = createComfyExecutionId('workspace-retopo')
    setRunning(toolId)
    setStatus(null)
    setProgress({ frac: 0, message: `${tool.label}…` })
    onPendingAdd?.({ id: pendingId, label: `${tool.label} · ${runTarget.name}`, cloud: true, stoppable: false, progressPercent: 0 })
    try {
      const { blob, stats } = await runRetopoTool(toolId, { id: runTarget.assetId, ...runTarget }, options, {
        onProgress: (evt) => {
          setProgress(evt)
          const frac = Number(evt?.frac)
          if (Number.isFinite(frac)) onPendingUpdate?.(pendingId, { progressPercent: Math.round(frac * 90) })
        }
      })
      setProgress({ frac: 0.95, message: 'Saving the new version…' })
      onPendingUpdate?.(pendingId, { progressPercent: 95 })
      let saved = await saveMeshVersion({ id: runTarget.assetId, name: runTarget.name }, blob, versionName(runTarget, toolId))
      // A version starts with its parent's thumbnail; the topology changed, so
      // render the real one (best-effort).
      try {
        const thumbnail = await createMeshThumbnailFile(new File([blob], 'mesh.glb', { type: 'model/gltf-binary' }))
        if (thumbnail) saved = { ...saved, ...(await uploadAssetThumbnail(saved.id, thumbnail)) }
      } catch (err) {
        console.warn('Could not render the new version thumbnail', err)
      }
      const rows = describeResult(toolId, stats)
      await onResult({ asset: saved, toolId, options, rows, source: runTarget })
      setLastResult({ label: tool.label, rows, assetId: saved.id })
    } catch (err) {
      console.error(`Workspace ${tool.label} failed`, err)
      setStatus({ tone: 'error', message: err.message || `${tool.label} failed.` })
      addNotification({ title: `${tool.label} failed`, message: err.message || `${tool.label} failed`, tone: 'error', source: tool.label, projectId })
    } finally {
      setRunning(null)
      setProgress(null)
      onPendingRemove?.(pendingId)
    }
  }

  const fillRefineImage = async (load) => {
    setRefineImageBusy(true)
    try {
      setRefineImage(await load())
      setStatus(null)
    } catch (err) {
      setStatus({ tone: 'error', message: err.message || 'Could not use that image.' })
    } finally {
      setRefineImageBusy(false)
    }
  }

  const refineBlocker = (() => {
    if (!refineWorkflow) return workflowsLoading ? 'Loading workflows…' : 'No refine workflow installed'
    if (!refineImage?.sourceReference) return 'Choose the reference image'
    return null
  })()

  // A ComfyUI run (not the Mesh Tools service): the job store tracks it, so it
  // shows in the history with ComfyUI's own progress and can be cancelled there.
  const runRefine = async () => {
    if (!target || busy || refineBlocker) return
    const runTarget = target
    const runWorkflow = refineWorkflow
    const runRoles = refineRoles
    const runImage = refineImage
    const label = refineWorkflowLabel(runWorkflow)
    const promptId = createComfyExecutionId('comfy-prompt')
    const clientId = createComfyExecutionId('comfy-client')
    setRunning('refine')
    setStatus(null)
    registerJob({ id: promptId, projectId, projectName, page: 'workspace', targetId: 'retopo', kind: 'mesh', label: `Refine · ${label}` })
    try {
      const meshRef = (await resolveSourceReference(projectId, 'mesh', runTarget.filePath || runTarget.filename)).sourceReference
      const scalarValues = {}
      for (const parameter of runWorkflow.parameters || []) {
        if (['image', 'video', 'mesh'].includes(getParameterValueType(parameter))) continue
        if ([runRoles.faces, runRoles.seed].includes(parameter)) continue
        if (Object.prototype.hasOwnProperty.call(refineValues, parameter.id)) {
          scalarValues[parameter.id] = coerceParameterValue(parameter, refineValues[parameter.id])
        }
      }
      const seed = runRoles.seed
        ? (refine.randomSeed ? randomSeed() : Number(refineValues[runRoles.seed.id]) || 0)
        : null
      const inputs = {
        ...scalarValues,
        [runRoles.mesh.id]: { source: meshRef, name: runTarget.name },
        [runRoles.image.id]: { source: runImage.sourceReference, name: runImage.name },
        ...(runRoles.faces && refineFaces ? { [runRoles.faces.id]: snapToEnums(runRoles.faces, refineFaces) } : {}),
        ...(runRoles.seed ? { [runRoles.seed.id]: seed } : {})
      }
      const assets = await runComfyWorkflow(projectId, {
        workflowId: runWorkflow.id,
        inputs,
        name: refinedName(runTarget),
        clientId,
        promptId,
        persistProcessingCard: false,
        detachedAsset: true,
        // A version of the mesh being refined, named explicitly rather than
        // inferred from the inputs.
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
          console.warn('Could not render the refined mesh thumbnail', err)
        }
      }
      completeJob(promptId, { status: 'completed' })
      const rows = [
        { label: 'Workflow', value: label },
        { label: 'Reference', value: runImage.name },
        ...(runRoles.faces && refineFaces ? [{ label: 'Target faces', value: formatFaceCount(inputs[runRoles.faces.id]) }] : []),
        ...(seed != null ? [{ label: 'Seed', value: seed }] : [])
      ]
      await onResult({
        asset: saved,
        module: 'retopo',
        label: `Refine · ${label}`,
        source: runTarget,
        params: {
          tool: 'refine',
          workflowId: runWorkflow.id,
          ...(runRoles.faces && refineFaces ? { faces: inputs[runRoles.faces.id] } : {}),
          ...(seed != null ? { seed } : {}),
          values: scalarValues,
          imageAssetId: runImage.assetId ?? null,
          summary: rows
        }
      })
      setLastResult({ label: `Refine · ${label}`, rows, assetId: saved.id })
    } catch (err) {
      if (err?.cancelled) {
        completeJob(promptId, { status: 'cancelled' })
      } else {
        console.error('Workspace Refine failed', err)
        completeJob(promptId, { status: 'error', error: err.message })
        setStatus({ tone: 'error', message: err.message || 'Refine failed.' })
        addNotification({ title: 'Refine failed', message: err.message || 'ComfyUI workflow failed', tone: 'error', source: runWorkflow.name, projectId })
      }
    } finally {
      setRunning(null)
    }
  }

  const useSelectedImage = selectedImageEntry ? () => imageImporters.fromEntry(selectedImageEntry) : null

  const renderRefine = () => (
    <>
      <div className="workspace-section">
        <div className="workspace-section__head"><span>Reference Image</span></div>
        <WorkspaceImageSlot
          hint="The image the mesh should match — ideally the one it was generated from"
          value={refineImage}
          busy={refineImageBusy}
          onFile={(file) => fillRefineImage(() => imageImporters.fromFile(file))}
          onDropEntry={(entry) => fillRefineImage(() => imageImporters.fromEntry(entry))}
          onPickAsset={() => setImagePicker(true)}
          onUseSelected={useSelectedImage ? () => fillRefineImage(useSelectedImage) : null}
          onClear={() => setRefineImage(null)}
        />
        <span className="workspace-hint">Rebuilds the mesh's shape and detail from the image. The result is untextured — texture it afterwards.</span>
      </div>

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
          value={refineWorkflow ? String(refineWorkflow.id) : ''}
          onChange={event => setOptions('refine', { workflowId: event.target.value })}
          disabled={!refineWorkflows.length}
        >
          {!refineWorkflows.length && (
            <option value="">{workflowsLoading ? 'Loading workflows…' : 'No refine workflow installed'}</option>
          )}
          {refineWorkflows.map(wf => <option key={wf.id} value={String(wf.id)} title={wf.name}>{refineWorkflowLabel(wf)}</option>)}
        </select>
        {workflowsError && <span className="workspace-hint workspace-hint--error">{workflowsError}</span>}
        {!workflowsLoading && !workflowsError && !refineWorkflows.length && (
          <span className="workspace-hint">Install “Refine Mesh with Trellis2” or “Refine Mesh with Hi3D” from the Setup Wizard.</span>
        )}
      </div>

      {refineRoles?.faces && (
        <div className="workspace-section">
          <div className="workspace-section__head">
            <span>Target Faces</span>
            <span className="workspace-section__aside">{formatFaceCount(refineFaces)}</span>
          </div>
          <div className="workspace-chips workspace-chips--even">
            {FACE_PRESETS.map(preset => (
              <button
                key={preset.value}
                type="button"
                className={`workspace-chip workspace-chip--box ${refineFaces === preset.value ? 'workspace-chip--active' : ''}`}
                onClick={() => setOptions('refine', { faces: preset.value })}
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
            value={refineFaces ?? ''}
            onChange={event => setOptions('refine', { faces: event.target.value === '' ? null : Number(event.target.value) })}
            aria-label="Target face count"
          />
        </div>
      )}

      {refineRoles?.seed && (
        <div className="workspace-section">
          <WorkspaceParamField
            parameter={refineRoles.seed}
            label="Seed"
            value={refineValues[refineRoles.seed.id]}
            onChange={setRefineValue}
            randomSeed={refine.randomSeed}
            onToggleRandomSeed={() => setOptions('refine', { randomSeed: !refine.randomSeed })}
          />
        </div>
      )}

      {refineRoles?.advanced.length > 0 && (
        <Disclosure label="Advanced">
          {refineRoles.advanced.map(parameter => (
            <WorkspaceParamField key={parameter.id} parameter={parameter} value={refineValues[parameter.id]} onChange={setRefineValue} />
          ))}
        </Disclosure>
      )}
    </>
  )

  const renderCheck = () => {
    if (!target) return null
    const result = currentCheck?.result
    return (
      <div className="workspace-section">
        <div className="workspace-section__head">
          <span>Mesh Health</span>
          <button type="button" className="workspace-chip" onClick={runCheck} disabled={busy || currentCheck?.loading}>
            {currentCheck?.loading ? 'Checking…' : (result ? 'Check again' : 'Check mesh')}
          </button>
        </div>
        {currentCheck?.error && <span className="workspace-hint workspace-hint--error">{currentCheck.error}</span>}
        {result && (
          <ul className="workspace-checks">
            {[result.faces, result.nonManifold, result.openEdges, result.watertight, result.degenerate, result.duplicates]
              .filter(Boolean)
              .map(item => (
                <li key={item.id} className={`workspace-checks__item workspace-checks__item--${item.status}`} title={item.detail || item.hint || ''}>
                  <span className="material-symbols-outlined">{CHECK_STATUS_ICONS[item.status] || 'info'}</span>
                  <span className="workspace-checks__label">{item.label}</span>
                  <span className="workspace-checks__value">{item.value}</span>
                </li>
              ))}
          </ul>
        )}
        {!result && !currentCheck?.loading && (
          <span className="workspace-hint">Looks for non-manifold edges, holes and broken faces before retopology.</span>
        )}
      </div>
    )
  }

  const renderAutoRetopo = () => (
    <>
      {renderCheck()}

      <div className="workspace-section">
        <div className="workspace-section__head">
          <span>Fix the Mesh</span>
          {currentCheck?.result?.needsRepair && <span className="workspace-section__aside workspace-section__aside--warn">Recommended</span>}
        </div>
        <span className="workspace-hint">
          Removes non-manifold edges, duplicate and degenerate faces and seals small holes, without rebuilding the topology. The texture is kept.
        </span>
        <button type="button" className="workspace-action-btn workspace-action-btn--wide" onClick={() => runTool('repair', repair)} disabled={!target || busy}>
          <span className="material-symbols-outlined">healing</span>
          {running === 'repair' ? 'Repairing…' : 'Repair Mesh'}
        </button>
        <Disclosure label="Repair options">
          <Select
            label="Non-manifold edges"
            value={repair.method}
            onChange={value => setOptions('repair', { method: value })}
            options={[
              { value: 'remove', label: 'Remove faces (then close holes)' },
              { value: 'split', label: 'Split vertices (keep faces)' }
            ]}
          />
          <Switch label="Close holes" value={repair.close_holes} onChange={value => setOptions('repair', { close_holes: value })} />
          <NumberInput label="Largest hole to close (edges)" value={repair.max_hole_size} min={0} max={5000} step={1} onChange={value => setOptions('repair', { max_hole_size: value })} disabled={!repair.close_holes} />
          <Switch
            label="Keep UVs (and texture)"
            value={repair.preserve_uv}
            onChange={value => setOptions('repair', { preserve_uv: value })}
            hint="Off falls back to a stronger rebuild for badly broken meshes, which discards the UVs."
          />
        </Disclosure>
      </div>

      <div className="workspace-section">
        <div className="workspace-section__head">
          <span>Retopology</span>
          <span className="workspace-section__aside">{formatFaceCount(retopo.target_faces)} faces</span>
        </div>
        <div className="workspace-chips workspace-chips--even">
          {RETOPO_FACE_PRESETS.map(value => (
            <button
              key={value}
              type="button"
              className={`workspace-chip workspace-chip--box ${retopo.target_faces === value ? 'workspace-chip--active' : ''}`}
              onClick={() => setOptions('retopo', { target_faces: value })}
            >
              {formatFaceCount(value)}
            </button>
          ))}
        </div>
        <input
          className="workspace-input"
          type="number"
          min={50}
          max={5000000}
          step={100}
          value={retopo.target_faces ?? ''}
          onChange={event => setOptions('retopo', { target_faces: event.target.value === '' ? '' : Number(event.target.value) })}
          aria-label="Target faces"
        />
        <Switch
          label="Watertight (closed shell)"
          value={retopo.watertight}
          onChange={value => setOptions('retopo', { watertight: value })}
          hint="Rebuild through a voxel shell: closes holes and merges intersecting parts. Off remeshes the surface as it is, staying closer to the original."
        />
        <Switch
          label="Keep sharp edges"
          value={retopo.preserve_features}
          onChange={value => setOptions('retopo', { preserve_features: value })}
          hint="Hard-surface mode: keeps creases crisp."
        />
        <Select
          label="Symmetry"
          value={retopo.mirror}
          onChange={value => setOptions('retopo', { mirror: value })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'auto', label: 'Auto (most symmetric axis)' },
            { value: 'x', label: 'X axis' },
            { value: 'y', label: 'Y axis' },
            { value: 'z', label: 'Z axis' }
          ]}
          hint="Mirror one half onto the other so both sides share the same edge flow."
        />
      </div>

      <Disclosure label="Advanced">
        <NumberInput label="Shell resolution" value={retopo.shell_resolution} min={16} max={1024} step={8} onChange={value => setOptions('retopo', { shell_resolution: value })} disabled={!retopo.watertight} hint="Voxel cells along the longest side." />
        <NumberInput label="Shell smoothing" value={retopo.shell_smooth} min={0} max={5} step={0.05} onChange={value => setOptions('retopo', { shell_smooth: value })} disabled={!retopo.watertight} hint="Lower keeps small detail; raise toward 1.4 for buildings and hard surfaces." />
        <NumberInput label="Close iterations" value={retopo.shell_close_iter} min={0} max={20} step={1} onChange={value => setOptions('retopo', { shell_close_iter: value })} disabled={!retopo.watertight} hint="Bridges cracks before the shell is built." />
        <Switch label="Curvature-adaptive" value={retopo.adaptive} onChange={value => setOptions('retopo', { adaptive: value })} hint="More faces where the surface bends." />
        <Switch label="Project to surface" value={retopo.project} onChange={value => setOptions('retopo', { project: value })} hint="Pull the new mesh back onto the original surface." />
        <Select
          label="Device"
          value={retopo.device}
          onChange={value => setOptions('retopo', { device: value })}
          options={[
            { value: 'auto', label: 'Auto (GPU if NVIDIA)' },
            { value: 'cpu', label: 'CPU' },
            { value: 'cuda', label: 'CUDA (NVIDIA GPU)' }
          ]}
        />
        <NumberInput label="Seed" value={retopo.seed} min={0} step={1} onChange={value => setOptions('retopo', { seed: value })} />
      </Disclosure>
    </>
  )

  const renderOptimize = () => (
    <>
      <div className="workspace-section">
        <div className="workspace-section__head">
          <span>Reduce To</span>
          <span className="workspace-section__aside">
            {optimize.target_faces ? `${formatFaceCount(optimize.target_faces)} faces` : `${Math.round((optimize.simplify_ratio || 0) * 100)}% of the faces`}
          </span>
        </div>
        <div className="workspace-chips workspace-chips--even">
          {OPTIMIZE_RATIO_PRESETS.map(ratio => (
            <button
              key={ratio}
              type="button"
              className={`workspace-chip workspace-chip--box ${!optimize.target_faces && optimize.simplify_ratio === ratio ? 'workspace-chip--active' : ''}`}
              onClick={() => setOptions('optimize', { simplify_ratio: ratio, target_faces: null })}
            >
              {Math.round(ratio * 100)}%
            </button>
          ))}
        </div>
        <label className="workspace-field">
          <span className="workspace-field__label">Or a face budget</span>
          <input
            className="workspace-input"
            type="number"
            min={100}
            step={1000}
            placeholder="e.g. 20000"
            value={optimize.target_faces ?? ''}
            onChange={event => setOptions('optimize', { target_faces: event.target.value === '' ? null : Number(event.target.value) })}
          />
        </label>
        <Switch
          label="Allow seam breaking"
          value={optimize.allow_seam_breaking}
          onChange={value => setOptions('optimize', { allow_seam_breaking: value })}
          hint="Reaches the target on seamed meshes by welding UV seams — can damage the texture and hard edges."
        />
        <Switch
          label="Step by step"
          value={optimize.multi_step}
          onChange={value => setOptions('optimize', { multi_step: value })}
          hint="Halve the face count per pass (up to 10 passes) instead of one big pass."
        />
      </div>

      <Disclosure label="Advanced">
        <NumberInput label="Error budget" value={optimize.simplify_error} min={0.001} max={1} step={0.005} onChange={value => setOptions('optimize', { simplify_error: value })} hint="How far the surface may move. Raise it when the target is not reached." />
        <Switch label="Aggressive" value={optimize.aggressive} onChange={value => setOptions('optimize', { aggressive: value })} />
        <Switch label="Permissive" value={optimize.permissive} onChange={value => setOptions('optimize', { permissive: value })} />
        <Switch label="Lock border" value={optimize.lock_border} onChange={value => setOptions('optimize', { lock_border: value })} />
        <Switch label="Update attributes" value={optimize.simplify_update} onChange={value => setOptions('optimize', { simplify_update: value })} hint="Rewrite positions, normals and UVs for a closer fit (gltfpack -sv)." />
      </Disclosure>
    </>
  )

  const runLabel = tab === 'optimize'
    ? (running === 'optimize' ? 'Optimizing…' : 'Optimize')
    : tab === 'refine'
      ? (running === 'refine' ? 'Refining…' : 'Refine Mesh')
      : (running === 'autoretopo' ? 'Retopologizing…' : 'Retopologize')
  const runIcon = tab === 'optimize' ? 'compress' : tab === 'refine' ? 'auto_fix_high' : 'grid_4x4'
  const blocker = !target ? 'Choose a mesh first' : (tab === 'refine' ? refineBlocker : null)
  const runActive = () => {
    if (tab === 'optimize') runTool('optimize', optimize)
    else if (tab === 'refine') runRefine()
    else runTool('autoretopo', retopo)
  }

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">grid_4x4</span>
        Retopology
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
              onClick={() => setSettings(prev => ({ ...prev, tab: entry.id }))}
            >
              <span className="material-symbols-outlined">{entry.icon}</span>
              {entry.label}
            </button>
          ))}
        </div>

        <WorkspaceMeshSlot
          value={target}
          busy={targetBusy || slotBusy}
          onFile={(file) => fillTarget(() => importers.fromMeshFile(file))}
          onPickAsset={() => setAssetPicker(true)}
          onUseSelected={selectedMeshEntry ? () => fillTarget(() => importers.fromEntry(selectedMeshEntry)) : null}
          onDropEntry={(entry) => fillTarget(() => importers.fromEntry(entry))}
          onClear={() => onTargetChange(null)}
        />

        {tab === 'autoretopo' ? renderAutoRetopo() : tab === 'refine' ? renderRefine() : renderOptimize()}

        {currentResult && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Last Result</span>
              <span className="workspace-section__aside">{currentResult.label}</span>
            </div>
            <ResultRows rows={currentResult.rows} />
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
        <button
          type="button"
          className="workspace-run-btn"
          onClick={runActive}
          disabled={Boolean(blocker) || busy}
          title={blocker || 'Saved as a new version of the mesh'}
        >
          <span className="material-symbols-outlined">{runIcon}</span>
          {runLabel}
        </button>
        {blocker && <span className="workspace-hint workspace-hint--center">{blocker}</span>}
      </div>

      {assetPicker && (
        <AssetSelectorModal
          assetType="mesh"
          showEdits
          onSelect={(asset) => {
            setAssetPicker(false)
            if (asset) fillTarget(() => importers.fromMeshAsset(asset))
          }}
          onClose={() => setAssetPicker(false)}
        />
      )}

      {imagePicker && (
        <AssetSelectorModal
          assetType="image"
          showEdits
          onSelect={(asset) => {
            setImagePicker(false)
            if (asset) fillRefineImage(() => imageImporters.fromAsset(asset))
          }}
          onClose={() => setImagePicker(false)}
        />
      )}
    </div>
  )
}
