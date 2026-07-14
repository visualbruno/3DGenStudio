// Auto Rig mode left panel. Generates a skeleton + skin weights for the current
// mesh via the SkinTokens/TokenRig rigging service, shows the resulting skeleton
// as an overlay in the viewport, and lets you save the rigged GLB as a new
// version or download it. Presentational: option state + handlers come from
// MeshEditorPage.
//
// Unlike Auto UV / Auto Retopo, the rig result is a SKINNED GLB whose value is
// the skeleton itself, so it is NOT flattened back into the editable mesh — hence
// Save/Download instead of Keep/Revert.
import { RangeField, ToggleField, SelectField } from './MeshToolField'
import MeshToolProgress from './MeshToolProgress'

export default function AutoRigToolsPanel({
  options,
  setOption,
  running,
  progress,
  result,
  onRun,
  onSaveResult,
  onDownloadResult,
  onDismissResult,
  saving,
  hasSkeleton,
  showSkeleton,
  onToggleSkeleton,
  disabled,
}) {
  const o = options
  const fieldsDisabled = disabled || running

  return (
    <>{/* AUTO RIG */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Auto Rig</span>

        <ToggleField
          label="Show skeleton"
          value={showSkeleton}
          onChange={onToggleSkeleton}
          disabled={!hasSkeleton}
          hint={hasSkeleton
            ? 'Overlay the skeleton (bones) on the mesh in the viewport'
            : 'No skeleton yet — rig the mesh (or load an already-rigged one) to see its bones'}
        />
        {!hasSkeleton && (
          <span className="mesh-editor-panel__hint">This mesh has no skeleton yet. Run Auto Rig to generate one.</span>
        )}

        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running}
          title="Generate a skeleton and skin weights with the rigging service"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'accessibility_new'}</span>
          <span>{running ? 'Rigging…' : 'Run Auto Rig'}</span>
        </button>

        {running && <MeshToolProgress progress={progress} />}

        {result && (
          <div className="mesh-editor-patch-preview">
            <strong className="mesh-editor-patch-preview__title">
              <span className="material-symbols-outlined">check_circle</span>
              Rig generated
            </strong>

            <div className="mesh-editor-texture-workflow-meta">
              {result.rows.map(row => (
                <span key={row.label}><strong>{row.label}:</strong> {row.value}</span>
              ))}
            </div>

            <span className="mesh-editor-panel__hint">
              The skeleton is shown in the viewport. Save it as a new version or download the rigged GLB.
            </span>

            <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double mesh-editor-patch-preview__actions">
              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--primary"
                onClick={onSaveResult}
                disabled={saving}
                title="Save the rigged mesh as a new version in the asset library"
              >
                <span className="material-symbols-outlined">{saving ? 'progress_activity' : 'save'}</span>
                <span>{saving ? 'Saving…' : 'Save as version'}</span>
              </button>
              <button
                type="button"
                className="mesh-editor-btn"
                onClick={onDownloadResult}
                disabled={saving}
                title="Download the rigged GLB"
              >
                <span className="material-symbols-outlined">download</span>
                <span>Download</span>
              </button>
            </div>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={onDismissResult}
              disabled={saving}
              title="Dismiss this result (keeps the skeleton overlay)"
            >
              <span className="material-symbols-outlined">close</span>
              <span>Dismiss</span>
            </button>
          </div>
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Skeleton</span>
        <SelectField label="Bone names" value={o.rename_bones}
          onChange={v => setOption('rename_bones', v)} disabled={fieldsDisabled}
          options={[
            { value: 'mixamo', label: 'Mixamo' },
            { value: 'ue5', label: 'Unreal Engine 5' },
            { value: 'original', label: 'Keep model names' },
          ]}
          hint="Rename the generated bones to a standard humanoid convention for retargeting" />
        <ToggleField label="Preserve texture & scale" value={o.use_transfer}
          onChange={v => setOption('use_transfer', v)} disabled={fieldsDisabled}
          hint="Transfer the rig onto your original mesh (keeps its texture and scale). Recommended — leave on." />
        <ToggleField label="Voxel-skin postprocess" value={o.use_postprocess}
          onChange={v => setOption('use_postprocess', v)} disabled={fieldsDisabled}
          hint="Clean up skin weights with a voxel pass to reduce bleed across disconnected parts" />
        <ToggleField label="Keep model loaded in memory" value={o.keep_loaded}
          onChange={v => setOption('keep_loaded', v)} disabled={fieldsDisabled}
          hint="Keep the rig model in (GPU) memory for fast repeat rigs. Uncheck to free memory after each rig — the next rig reloads it (slower first run)." />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Generation (advanced)</span>
        <RangeField label="Top-k" min={1} max={200} step={1}
          value={o.top_k} onChange={v => setOption('top_k', v)} disabled={fieldsDisabled}
          hint="Top-k sampling" />
        <RangeField label="Top-p" min={0.1} max={1} step={0.01} decimals={2}
          value={o.top_p} onChange={v => setOption('top_p', v)} disabled={fieldsDisabled}
          hint="Nucleus (top-p) sampling" />
        <RangeField label="Temperature" min={0.1} max={2} step={0.1} decimals={1}
          value={o.temperature} onChange={v => setOption('temperature', v)} disabled={fieldsDisabled} />
        <RangeField label="Repetition penalty" min={0.5} max={3} step={0.1} decimals={1}
          value={o.repetition_penalty} onChange={v => setOption('repetition_penalty', v)} disabled={fieldsDisabled} />
        <RangeField label="Beams" min={1} max={20} step={1}
          value={o.num_beams} onChange={v => setOption('num_beams', v)} disabled={fieldsDisabled}
          hint="Beam-search width" />
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Auto Rig runs on the SkinTokens rigging service (Settings → Rigging). Needs an NVIDIA GPU.</span>
        <span className="mesh-editor-panel__hint">The result is a skinned mesh; save it as a new version to keep the rig.</span>
      </div>
    </>
  )
}
