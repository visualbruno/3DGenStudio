// Workspace → Rig module: the Mesh Editor's Auto Rig (SkinTokens / TokenRig,
// the rigging service) on a stored mesh — the path the Graph's Rig Mesh node
// takes. The skinned GLB is saved as a VERSION of the mesh, logged to the
// history and becomes the next source. Bone editing, weight painting and
// animations stay in the Mesh Editor (Open in Mesh Editor on the result).
import { useEffect, useState } from 'react'
import { useNotifications } from '../../context/NotificationContext'
import { createComfyExecutionId } from '../../utils/ids'
import {
  AUTO_RIG_BONE_NAME_OPTIONS,
  DEFAULT_AUTO_RIG_OPTIONS,
  autoRig,
  ensureDesktopService,
  pickAutoRigOptions
} from '../../utils/meshTools'
import { createMeshThumbnailFile } from '../../utils/meshThumbnail'
import { alignMeshToGround, uploadAssetThumbnail } from '../../utils/workspaceApi'
import { fetchAssetBlob, saveMeshVersion } from '../../utils/workspaceRetopo'
import AssetSelectorModal from '../AssetSelectorModal'
import WorkspaceMeshSlot from './WorkspaceMeshSlot'
import { Disclosure, NumberInput, ResultRows, Select, Switch } from './WorkspaceControls'

const SETTINGS_KEY = 'workspace.rig.settings.v1'

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null')
    return pickAutoRigOptions(parsed && typeof parsed === 'object' ? parsed : DEFAULT_AUTO_RIG_OPTIONS)
  } catch {
    return DEFAULT_AUTO_RIG_OPTIONS
  }
}

function writeSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable — nothing to keep
  }
}

function groundedName(asset) {
  const base = String(asset?.name || 'Mesh').replace(/\.[^.]+$/, '').replace(/\s*\((grounded)\)$/i, '')
  return `${base} (grounded)`
}

function formatMetres(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return `${number >= 0 ? '+' : ''}${(Math.round(number * 1000) / 1000).toString()} m`
}

function riggedName(asset) {
  const base = String(asset?.name || 'Mesh').replace(/\.[^.]+$/, '').replace(/\s*\((retopo|repaired|optimized|uv|textured|baked|rigged)\)$/i, '')
  return `${base} (rigged)`
}

export default function WorkspaceRigPanel({
  projectId,
  target,
  targetBusy,
  importers,
  onTargetChange,
  selectedMeshEntry,
  onResult,
  onOpenInEditor,
  showBoneLabels = false,
  onShowBoneLabelsChange,
  onPendingAdd,
  onPendingUpdate,
  onPendingRemove,
  reuse
}) {
  const { addNotification } = useNotifications()
  const [options, setOptions] = useState(readSettings)
  const [running, setRunning] = useState(false)
  const [aligning, setAligning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [status, setStatus] = useState(null)
  const [lastResult, setLastResult] = useState(null) // { assetId, rows, asset }
  const [assetPicker, setAssetPicker] = useState(false)
  const [slotBusy, setSlotBusy] = useState(false)
  const [appliedReuseNonce, setAppliedReuseNonce] = useState(null)

  useEffect(() => { writeSettings(options) }, [options])

  if (reuse && reuse.nonce !== appliedReuseNonce) {
    setAppliedReuseNonce(reuse.nonce)
    setOptions(prev => pickAutoRigOptions({ ...prev, ...(reuse.entry.params?.options || {}) }))
  }

  const set = (key, value) => setOptions(prev => ({ ...prev, [key]: value }))
  const busy = running || aligning || targetBusy || slotBusy
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

  // Put the mesh on the ground: lowest point on Y = 0, centred on X / Z (the
  // backend's ground pivot, which edits only the node tree, so a rig, its
  // weights and its clips come through untouched). Saved as a version.
  const alignToGround = async () => {
    if (!target || busy) return
    const runTarget = target
    setAligning(true)
    setStatus(null)
    try {
      const meshBlob = await fetchAssetBlob(runTarget)
      const { blob, stats } = await alignMeshToGround(meshBlob, String(runTarget.filename || 'mesh.glb').split('/').pop() || 'mesh.glb')
      if (!stats?.moved) {
        setStatus({ tone: 'info', message: 'Already on the ground — nothing to change.' })
        return
      }
      let saved = await saveMeshVersion({ id: runTarget.assetId, name: runTarget.name }, blob, groundedName(runTarget))
      try {
        const thumbnail = await createMeshThumbnailFile(new File([blob], 'mesh.glb', { type: 'model/gltf-binary' }))
        if (thumbnail) saved = { ...saved, ...(await uploadAssetThumbnail(saved.id, thumbnail)) }
      } catch (err) {
        console.warn('Could not render the grounded mesh thumbnail', err)
      }
      // `delta` = the real movement; `offset` is the absolute pivot wrapper value,
      // which differs when the file had already been moved once.
      const offset = Array.isArray(stats.delta) ? stats.delta : (Array.isArray(stats.offset) ? stats.offset : [0, 0, 0])
      const rows = [
        { label: 'Moved', value: `X ${formatMetres(offset[0])}, Y ${formatMetres(offset[1])}, Z ${formatMetres(offset[2])}` },
        { label: 'Lowest point', value: 'Y = 0, centred on X / Z' }
      ]
      await onResult({
        asset: saved,
        module: 'rig',
        label: 'Align to the Ground',
        source: runTarget,
        params: { tool: 'ground', summary: rows }
      })
      setLastResult({ assetId: saved.id, rows, asset: saved, label: 'Align to the Ground' })
    } catch (err) {
      console.error('Workspace Align to the Ground failed', err)
      setStatus({ tone: 'error', message: err.message || 'Could not align the mesh.' })
      addNotification({ title: 'Align to the Ground failed', message: err.message || 'Could not align the mesh', tone: 'error', source: 'Align to the Ground', projectId })
    } finally {
      setAligning(false)
    }
  }

  const run = async () => {
    if (!target || busy) return
    const runTarget = target
    const runOptions = pickAutoRigOptions(options)
    const pendingId = createComfyExecutionId('workspace-rig')
    setRunning(true)
    setStatus(null)
    setProgress({ frac: 0, message: 'Starting the rigging service…' })
    onPendingAdd?.({ id: pendingId, label: `Auto Rig · ${runTarget.name}`, cloud: true, stoppable: false, progressPercent: 0 })
    try {
      // Desktop: start the rigging service on demand (no-op elsewhere).
      await ensureDesktopService('rigging')
      setProgress({ frac: 0.02, message: 'Loading the mesh…' })
      const meshBlob = await fetchAssetBlob(runTarget)
      const { blob, stats } = await autoRig(meshBlob, {
        options: runOptions,
        fileName: String(runTarget.filename || 'mesh.glb').split('/').pop() || 'mesh.glb',
        onProgress: (evt) => {
          setProgress(evt)
          const frac = Number(evt?.frac)
          if (Number.isFinite(frac)) onPendingUpdate?.(pendingId, { progressPercent: Math.round(frac * 95) })
        }
      })
      setProgress({ frac: 0.97, message: 'Saving the rigged mesh…' })
      let saved = await saveMeshVersion({ id: runTarget.assetId, name: runTarget.name }, blob, riggedName(runTarget))
      try {
        const thumbnail = await createMeshThumbnailFile(new File([blob], 'mesh.glb', { type: 'model/gltf-binary' }))
        if (thumbnail) saved = { ...saved, ...(await uploadAssetThumbnail(saved.id, thumbnail)) }
      } catch (err) {
        console.warn('Could not render the rigged mesh thumbnail', err)
      }
      const tool = stats?.tool || {}
      const rows = []
      if (tool.bones != null) rows.push({ label: 'Bones', value: tool.bones })
      rows.push({ label: 'Bone names', value: AUTO_RIG_BONE_NAME_OPTIONS.find(option => option.value === runOptions.rename_bones)?.label || runOptions.rename_bones })
      rows.push({ label: 'Texture & scale', value: runOptions.use_transfer ? 'kept' : 'from the rig model' })
      await onResult({
        asset: saved,
        module: 'rig',
        label: 'Auto Rig',
        source: runTarget,
        params: { tool: 'autorig', options: runOptions, summary: rows }
      })
      setLastResult({ assetId: saved.id, rows, asset: saved, label: 'Auto Rig' })
    } catch (err) {
      console.error('Workspace Auto Rig failed', err)
      setStatus({ tone: 'error', message: err.message || 'Auto Rig failed.' })
      addNotification({ title: 'Auto Rig failed', message: err.message || 'Auto Rig failed', tone: 'error', source: 'Auto Rig', projectId })
    } finally {
      setRunning(false)
      setProgress(null)
      onPendingRemove?.(pendingId)
    }
  }

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">accessibility_new</span>
        Auto Rig
      </div>

      <div className="workspace-panel__scroll">
        <WorkspaceMeshSlot
          value={target}
          label="Mesh to rig"
          emptyLabel="Choose the mesh to rig"
          busy={targetBusy || slotBusy}
          onFile={(file) => fillTarget(() => importers.fromMeshFile(file))}
          onPickAsset={() => setAssetPicker(true)}
          onUseSelected={selectedMeshEntry ? () => fillTarget(() => importers.fromEntry(selectedMeshEntry)) : null}
          onDropEntry={(entry) => fillTarget(() => importers.fromEntry(entry))}
          onClear={() => onTargetChange(null)}
        />

        <div className="workspace-section">
          <div className="workspace-section__head"><span>Placement &amp; View</span></div>
          <button
            type="button"
            className="workspace-action-btn workspace-action-btn--wide"
            onClick={alignToGround}
            disabled={!target || busy}
            title="Move the mesh so its lowest point sits on the ground (Y = 0), centred on X / Z. Keeps the rig and animations. Saved as a new version."
          >
            <span className="material-symbols-outlined">vertical_align_bottom</span>
            {aligning ? 'Aligning…' : 'Align to the Ground'}
          </button>
          <Switch
            label="Show bone labels"
            value={showBoneLabels}
            onChange={value => onShowBoneLabelsChange?.(value)}
            hint="Write each bone's name next to it in the 3D view (rigged meshes; shows the skeleton too)."
          />
        </div>

        <div className="workspace-section">
          <span className="workspace-hint">
            Builds a skeleton and skin weights with SkinTokens. Works best on a character standing in a T- or A-pose, facing forward.
          </span>
          <Select
            label="Bone names"
            value={options.rename_bones}
            onChange={value => set('rename_bones', value)}
            options={AUTO_RIG_BONE_NAME_OPTIONS}
            hint="Name the bones after a standard rig, so animations retarget onto it by name."
          />
          <Switch
            label="Preserve texture & scale"
            value={options.use_transfer}
            onChange={value => set('use_transfer', value)}
            hint="Transfer the rig onto the original mesh, keeping its texture and scale. Recommended."
          />
          <Switch
            label="Clean up skin weights"
            value={options.use_postprocess}
            onChange={value => set('use_postprocess', value)}
            hint="A voxel pass that stops weights bleeding across disconnected parts."
          />
        </div>

        <Disclosure label="Advanced">
          <Switch label="Keep the model loaded" value={options.keep_loaded} onChange={value => set('keep_loaded', value)} hint="Keep the rig model in GPU memory for fast repeat rigs." />
          <NumberInput label="Top-k" value={options.top_k} min={1} max={200} step={1} onChange={value => set('top_k', value)} />
          <NumberInput label="Top-p" value={options.top_p} min={0.1} max={1} step={0.01} onChange={value => set('top_p', value)} />
          <NumberInput label="Temperature" value={options.temperature} min={0.1} max={2} step={0.1} onChange={value => set('temperature', value)} />
          <NumberInput label="Repetition penalty" value={options.repetition_penalty} min={0.5} max={3} step={0.1} onChange={value => set('repetition_penalty', value)} />
          <NumberInput label="Beams" value={options.num_beams} min={1} max={20} step={1} onChange={value => set('num_beams', value)} />
          <NumberInput
            label="Length penalty"
            value={options.length_penalty}
            min={0.5}
            max={3}
            step={0.05}
            onChange={value => set('length_penalty', value)}
            hint="Above 1.0 favours skeletons with more bones — raise it when a rig stops short of the fingers or the tail."
          />
          <button type="button" className="workspace-action-btn workspace-action-btn--wide" onClick={() => setOptions(DEFAULT_AUTO_RIG_OPTIONS)}>
            <span className="material-symbols-outlined">restart_alt</span>
            Reset to defaults
          </button>
        </Disclosure>

        {currentResult && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Last Result</span>
              <span className="workspace-section__aside">{currentResult.label}</span>
            </div>
            <ResultRows rows={currentResult.rows} />
            <span className="workspace-hint">Turn on Skeleton in the viewer toolbar to see the bones. Bone editing, weight painting and animations are in the Mesh Editor.</span>
            <button type="button" className="workspace-action-btn workspace-action-btn--wide" onClick={() => onOpenInEditor?.(currentResult.asset)}>
              <span className="material-symbols-outlined">open_in_new</span>
              Open in Mesh Editor
            </button>
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
        <button type="button" className="workspace-run-btn" onClick={run} disabled={!target || busy} title={!target ? 'Choose a mesh first' : 'Saved as a new version of the mesh'}>
          <span className="material-symbols-outlined">accessibility_new</span>
          {running ? 'Rigging…' : 'Auto Rig'}
        </button>
        {!target && <span className="workspace-hint workspace-hint--center">Choose a mesh first</span>}
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
    </div>
  )
}
