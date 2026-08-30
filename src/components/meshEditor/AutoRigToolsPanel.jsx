// Auto Rig mode left panel. Generates a skeleton + skin weights for the current
// mesh via the SkinTokens/TokenRig rigging service, shows the resulting skeleton
// as an overlay in the viewport, and lets you save the rigged GLB as a new
// version or download it. Presentational: option state + handlers come from
// MeshEditorPage.
//
// Unlike Auto UV / Auto Retopo, the rig result is a SKINNED GLB — but the editor
// adopts it whole (geometry, weights and skeleton), so the page's own Save / Save
// as version / Export carry the rig along with the materials, and the result card
// only reports what happened. It keeps a save/download of its own for the single
// case the editor cannot adopt — a result that came back without UVs on a
// textured mesh — where the generated file is the only copy of the rig.
import { RangeField, ToggleField, SelectField } from './MeshToolField'
import MeshToolProgress from './MeshToolProgress'
import WeightPaintSection from './WeightPaintSection'
import { AUTO_RIG_BONE_NAME_OPTIONS } from '../../utils/meshTools'

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
  showBoneNames,
  onToggleBoneNames,
  rigPreserved,
  rigBoneCount,
  rigDropped,
  rigEdited,
  boneMappings,
  weightPaint,
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
            ? 'Overlay the skeleton (bones) on the mesh in this mode. Other modes never draw it.'
            : 'No skeleton yet — rig the mesh (or load an already-rigged one) to see its bones'}
        />
        {/* Only meaningful once there is a rig to name, so it appears with one.
            Follows the skeleton overlay: the labels ride on it, so with the
            skeleton hidden there is nothing for them to sit on. */}
        {hasSkeleton && (
          <button
            type="button"
            className="mesh-editor-btn"
            onClick={() => onToggleBoneNames(!showBoneNames)}
            disabled={!showSkeleton}
            title={showSkeleton
              ? 'Show or hide the name of every bone in the viewport'
              : 'Turn the skeleton overlay on first — the labels are drawn on its joints'}
          >
            <span className="material-symbols-outlined">{showBoneNames ? 'label_off' : 'label'}</span>
            <span>{showBoneNames ? 'Hide Bone Names' : 'Show Bone Names'}</span>
          </button>
        )}
        {!hasSkeleton && (
          <span className="mesh-editor-panel__hint">This mesh has no skeleton yet. Run Auto Rig to generate one.</span>
        )}

        {/* Whether saving will actually carry the rig. Editing bakes the mesh to
            flat world-space geometry, so this is the one place that can say
            whether the weights survived — before you find out in the engine. */}
        {rigPreserved && (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: '#4caf50' }}>check_circle</span>
            <span>Rig preserved — saving keeps the skeleton and {rigBoneCount} bones&apos; skin weights.</span>
          </div>
        )}
        {/* Bone and weight edits live in memory until something writes the mesh
            out, and both look identical at rest — so say so here rather than let
            the corrections be lost to a page away. */}
        {rigEdited && (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#8ff5ff' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>edit</span>
            <span>Rig edited by hand — save the mesh (or a new version) to keep the bone and weight changes.</span>
          </div>
        )}
        {/* Bone mappings are as much a part of an animatable mesh as its weights,
            and they are just as invisible: the Animations / Kimodo / Custom tabs
            all read them, but nothing else in the editor shows they exist. Saying
            it here is also the only place that can warn that a mapping made this
            session is still only in memory. */}
        {!!boneMappings?.labels?.length && (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em', color: '#4caf50' }}>link</span>
            <span>
              Bone mapping saved with this mesh for {boneMappings.labels.join(', ')} — reopening it
              goes straight to the clips.
            </span>
          </div>
        )}
        {boneMappings?.dirty && (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#8ff5ff' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>info</span>
            <span>
              The bone mapping you just made is only in memory — save the mesh (or a new version) to
              keep it with the mesh.
            </span>
          </div>
        )}
        {rigDropped && (
          <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'center', gap: '0.4em', color: '#e0a030' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>warning</span>
            <span>
              An edit rebuilt the topology, so the skin weights were lost — saving now writes a
              static mesh. Run Auto Rig again to re-rig it.
            </span>
          </div>
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

            {/* The rig is on the editor's mesh now, and Save / Save as version /
                Export in the toolbar all reattach it alongside the textures — a
                second save button here would only be a divergent copy of them. */}
            {!result.blobOnly ? (
              <span className="mesh-editor-panel__hint">
                The skeleton is on your mesh. Save, Save as version and Export in the toolbar all keep
                it, together with the materials and textures.
              </span>
            ) : (
              <>
                <span className="mesh-editor-panel__hint">
                  This rig could not be applied to the mesh in the editor, so it lives only in the
                  generated file — save or download it here. The toolbar would save your mesh without
                  the skeleton.
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
              </>
            )}
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

      <WeightPaintSection {...weightPaint} />

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Skeleton</span>
        <SelectField label="Bone names" value={o.rename_bones}
          onChange={v => setOption('rename_bones', v)} disabled={fieldsDisabled}
          options={AUTO_RIG_BONE_NAME_OPTIONS}
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
