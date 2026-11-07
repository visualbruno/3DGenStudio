// Workspace → UV module: the Mesh Editor's Auto UV on a stored mesh
// (src/utils/workspaceUv.js). The new layout is saved as a VERSION of the
// source mesh, logged to the history and becomes the source; "Keep the texture"
// bakes the old texture onto the new UVs so the result is not left blank.
import { useEffect, useState } from 'react'
import { useNotifications } from '../../context/NotificationContext'
import { createComfyExecutionId } from '../../utils/ids'
import { DEFAULT_AUTO_UV_OPTIONS } from '../../utils/meshTools'
import { createMeshThumbnailFile } from '../../utils/meshThumbnail'
import { uploadAssetThumbnail } from '../../utils/workspaceApi'
import { saveMeshVersion } from '../../utils/workspaceRetopo'
import { BAKE_RESOLUTIONS, UV_RESOLUTIONS, describeUvResult, runWorkspaceAutoUv } from '../../utils/workspaceUv'
import AssetSelectorModal from '../AssetSelectorModal'
import WorkspaceMeshSlot from './WorkspaceMeshSlot'
import { Disclosure, NumberInput, ResultRows, Select, Switch } from './WorkspaceControls'

const SETTINGS_KEY = 'workspace.uv.settings.v1'

const DEFAULT_SETTINGS = {
  uv: DEFAULT_AUTO_UV_OPTIONS,
  keepTexture: true,
  bakeResolution: 2048,
  // On: colour alone loses a metallic / glossy finish (the result reads darker
  // and flatter than the source), so roughness + metallic travel with it.
  bakePbr: true
}

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...parsed, uv: { ...DEFAULT_AUTO_UV_OPTIONS, ...(parsed.uv || {}) } }
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

function uvVersionName(asset) {
  const base = String(asset?.name || 'Mesh').replace(/\.[^.]+$/, '').replace(/\s*\((retopo|repaired|optimized|uv)\)$/i, '')
  return `${base} (uv)`
}

function sizeLabel(value) {
  return value >= 1024 ? `${value / 1024}K` : String(value)
}

export default function WorkspaceUvPanel({
  projectId,
  target,
  targetBusy,
  importers,
  onTargetChange,
  selectedMeshEntry,
  onResult,
  onPendingAdd,
  onPendingUpdate,
  onPendingRemove,
  reuse
}) {
  const { addNotification } = useNotifications()
  const [settings, setSettings] = useState(readSettings)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [status, setStatus] = useState(null)
  const [lastResult, setLastResult] = useState(null) // { assetId, rows, previewUrl }
  const [assetPicker, setAssetPicker] = useState(false)
  const [slotBusy, setSlotBusy] = useState(false)
  const [appliedReuseNonce, setAppliedReuseNonce] = useState(null)

  useEffect(() => { writeSettings(settings) }, [settings])

  if (reuse && reuse.nonce !== appliedReuseNonce) {
    setAppliedReuseNonce(reuse.nonce)
    const params = reuse.entry.params || {}
    setSettings(prev => ({
      ...prev,
      uv: { ...prev.uv, ...(params.options || {}) },
      keepTexture: params.keepTexture ?? prev.keepTexture,
      bakeResolution: params.bakeResolution || prev.bakeResolution,
      bakePbr: params.bakePbr ?? prev.bakePbr
    }))
  }

  const uv = settings.uv
  const setUv = (patch) => setSettings(prev => ({ ...prev, uv: { ...prev.uv, ...patch } }))
  const update = (patch) => setSettings(prev => ({ ...prev, ...patch }))
  const busy = running || targetBusy || slotBusy
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

  const run = async () => {
    if (!target || running) return
    const runTarget = target
    const runSettings = settings
    const pendingId = createComfyExecutionId('workspace-uv')
    setRunning(true)
    setStatus(null)
    setProgress({ frac: 0, message: 'Auto UV…' })
    onPendingAdd?.({ id: pendingId, label: `Auto UV · ${runTarget.name}`, cloud: true, stoppable: false, progressPercent: 0 })
    try {
      const result = await runWorkspaceAutoUv({ id: runTarget.assetId, ...runTarget }, {
        uvOptions: runSettings.uv,
        keepTexture: runSettings.keepTexture,
        bakeResolution: runSettings.bakeResolution,
        bakePbr: runSettings.bakePbr,
        onProgress: (evt) => {
          setProgress(evt)
          const frac = Number(evt?.frac)
          if (Number.isFinite(frac)) onPendingUpdate?.(pendingId, { progressPercent: Math.round(frac * 95) })
        }
      })
      setProgress({ frac: 0.97, message: 'Saving the new version…' })
      let saved = await saveMeshVersion({ id: runTarget.assetId, name: runTarget.name }, result.blob, uvVersionName(runTarget))
      try {
        const thumbnail = await createMeshThumbnailFile(new File([result.blob], 'mesh.glb', { type: 'model/gltf-binary' }))
        if (thumbnail) saved = { ...saved, ...(await uploadAssetThumbnail(saved.id, thumbnail)) }
      } catch (err) {
        console.warn('Could not render the new version thumbnail', err)
      }
      const rows = describeUvResult(result.stats, result.bake)
      await onResult({
        asset: saved,
        module: 'uv',
        label: 'Auto UV',
        source: runTarget,
        params: {
          tool: 'autouv',
          options: runSettings.uv,
          keepTexture: runSettings.keepTexture,
          bakeResolution: runSettings.bakeResolution,
          bakePbr: runSettings.bakePbr,
          summary: rows
        }
      })
      setLastResult({ assetId: saved.id, rows, previewUrl: result.previewUrl })
    } catch (err) {
      console.error('Workspace Auto UV failed', err)
      setStatus({ tone: 'error', message: err.message || 'Auto UV failed.' })
      addNotification({ title: 'Auto UV failed', message: err.message || 'Auto UV failed', tone: 'error', source: 'Auto UV', projectId })
    } finally {
      setRunning(false)
      setProgress(null)
      onPendingRemove?.(pendingId)
    }
  }

  return (
    <div className="workspace-panel__inner">
      <div className="workspace-panel__title">
        <span className="material-symbols-outlined">view_quilt</span>
        Auto UV
      </div>

      <div className="workspace-panel__scroll">
        <WorkspaceMeshSlot
          value={target}
          busy={targetBusy || slotBusy}
          onFile={(file) => fillTarget(() => importers.fromMeshFile(file))}
          onPickAsset={() => setAssetPicker(true)}
          onUseSelected={selectedMeshEntry ? () => fillTarget(() => importers.fromEntry(selectedMeshEntry)) : null}
          onDropEntry={(entry) => fillTarget(() => importers.fromEntry(entry))}
          onClear={() => onTargetChange(null)}
        />

        <div className="workspace-section">
          <div className="workspace-section__head">
            <span>UV Atlas</span>
            <span className="workspace-section__aside">{uv.resolution} px</span>
          </div>
          <div className="workspace-chips workspace-chips--even">
            {UV_RESOLUTIONS.map(size => (
              <button
                key={size}
                type="button"
                className={`workspace-chip workspace-chip--box ${uv.resolution === size ? 'workspace-chip--active' : ''}`}
                onClick={() => setUv({ resolution: size })}
                title="The texture size the islands are packed for (sets the padding in texels)"
              >
                {sizeLabel(size)}
              </button>
            ))}
          </div>
          <NumberInput label="Padding (texels)" value={uv.padding_texels} min={0} max={64} step={1} onChange={value => setUv({ padding_texels: value })} hint="Space between islands, so mipmaps do not bleed across seams." />
          <Switch label="Hide seams" value={uv.hide_seams} onChange={value => setUv({ hide_seams: value })} hint="Place seams where they are least visible (under arms, inside creases)." />
          <Switch label="Character layout" value={uv.character_rescue} onChange={value => setUv({ character_rescue: value })} hint="Keep limbs and joints in clean islands on characters." />
          <Switch label="Seam on the mirror plane" value={uv.symmetry} onChange={value => setUv({ symmetry: value })} hint="Cut along the symmetry plane so both halves unwrap alike." />
        </div>

        <div className="workspace-section">
          <Switch
            label="Keep the texture"
            value={settings.keepTexture}
            onChange={value => update({ keepTexture: value })}
            hint="Bake the current texture onto the new UVs. Off returns the new UV layout with no texture."
          />
          {settings.keepTexture && (
            <>
              <div className="workspace-section__head">
                <span>Texture Size</span>
                <span className="workspace-section__aside">{settings.bakeResolution} px</span>
              </div>
              <div className="workspace-chips workspace-chips--even">
                {BAKE_RESOLUTIONS.map(size => (
                  <button
                    key={size}
                    type="button"
                    className={`workspace-chip workspace-chip--box ${settings.bakeResolution === size ? 'workspace-chip--active' : ''}`}
                    onClick={() => update({ bakeResolution: size })}
                  >
                    {sizeLabel(size)}
                  </button>
                ))}
              </div>
              <Switch label="Also roughness & metallic" value={settings.bakePbr} onChange={value => update({ bakePbr: value })} hint="Transfer the PBR channels too, not only the colour." />
            </>
          )}
          {!settings.keepTexture && (
            <span className="workspace-hint">The new UVs will not match the current texture: the result is untextured.</span>
          )}
        </div>

        <Disclosure label="Advanced">
          <Select
            label="Method"
            value={uv.method}
            onChange={value => setUv({ method: value })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'lscm', label: 'LSCM' },
              { value: 'arap', label: 'ARAP' },
              { value: 'planar', label: 'Planar' }
            ]}
          />
          <NumberInput label="Normal-cone cap (°)" value={uv.max_cone_deg} min={1} max={180} step={1} onChange={value => setUv({ max_cone_deg: value })} hint="How curved one island may get before it is cut." />
          <NumberInput label="Min faces per island" value={uv.min_faces} min={1} step={1} onChange={value => setUv({ min_faces: value })} />
          <Switch label="Re-join islands" value={uv.rejoin} onChange={value => setUv({ rejoin: value })} />
          <Switch label="Relax stretched islands" value={uv.relax_creases} onChange={value => setUv({ relax_creases: value })} />
          <Switch label="Stack repeats" value={uv.stack_repeats} onChange={value => setUv({ stack_repeats: value })} hint="Identical parts share one island." />
          <Switch label="Preserve normals" value={uv.preserve_normals} onChange={value => setUv({ preserve_normals: value })} />
          <Select
            label="World up"
            value={uv.orient_up}
            onChange={value => setUv({ orient_up: value })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'y', label: 'Y (glTF up)' },
              { value: 'z', label: 'Z' },
              { value: 'x', label: 'X' }
            ]}
          />
        </Disclosure>

        {currentResult && (
          <div className="workspace-section">
            <div className="workspace-section__head">
              <span>Last Result</span>
              <span className="workspace-section__aside">Auto UV</span>
            </div>
            {currentResult.previewUrl && (
              <img className="workspace-uv-preview" src={currentResult.previewUrl} alt="UV layout" />
            )}
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
          onClick={run}
          disabled={!target || busy}
          title={!target ? 'Choose a mesh first' : 'Saved as a new version of the mesh'}
        >
          <span className="material-symbols-outlined">view_quilt</span>
          {running ? 'Unwrapping…' : 'Unwrap UVs'}
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
