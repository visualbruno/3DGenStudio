// Auto Retopo mode left panel. Exposes every autoretopo.RetopoConfig field, runs
// the retopology via the Python mesh-tools service, and offers Keep/Revert on the
// result. Presentational: option state + handlers come from MeshEditorPage.
import { RangeField, NumberField, ToggleField } from './MeshToolField'
import MeshToolResult from './MeshToolResult'

export default function AutoRetopoToolsPanel({
  options,
  setOption,
  running,
  result,
  onRun,
  onKeepResult,
  onRevertResult,
  disabled,
}) {
  const o = options
  const fieldsDisabled = disabled || running

  return (
    <>{/* AUTO RETOPO */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Auto Retopo</span>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running}
          title="Rebuild clean topology with the Python service"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'grain'}</span>
          <span>{running ? 'Retopologizing…' : 'Run Auto Retopo'}</span>
        </button>

        {result && (
          <MeshToolResult
            title="Retopology applied"
            rows={result.rows}
            onKeep={onKeepResult}
            onRevert={onRevertResult}
            disabled={running}
          />
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Target</span>
        <NumberField label="Target faces" min={50} max={5000000} step={100}
          value={o.target_faces} onChange={v => setOption('target_faces', v)} disabled={fieldsDisabled}
          hint="Approximate face budget of the output" />
        <ToggleField label="Quad-dominant" value={o.quads}
          onChange={v => setOption('quads', v)} disabled={fieldsDisabled}
          hint="Convert to quad-dominant (reported in metrics; GLB stays triangulated)" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Watertight shell</span>
        <ToggleField label="Watertight shell" value={o.watertight}
          onChange={v => setOption('watertight', v)} disabled={fieldsDisabled}
          hint="Build a unified voxel shell (robust) vs. remesh the surface directly" />
        <NumberField label="Shell resolution" min={16} max={1024} step={8}
          value={o.shell_resolution} onChange={v => setOption('shell_resolution', v)}
          disabled={fieldsDisabled || !o.watertight}
          hint="Voxel grid cells along the longest bbox axis" />
        <RangeField label="Close iterations" min={0} max={20} step={1}
          value={o.shell_close_iter} onChange={v => setOption('shell_close_iter', v)}
          disabled={fieldsDisabled || !o.watertight}
          hint="Morphological closing to bridge cracks" />
        <RangeField label="Smooth (sigma)" min={0} max={5} step={0.05} decimals={2}
          value={o.shell_smooth} onChange={v => setOption('shell_smooth', v)}
          disabled={fieldsDisabled || !o.watertight}
          hint="Gaussian sigma on the occupancy field (lower = sharper)" />
        <RangeField label="Samples / pitch" min={1} max={8} step={0.5} decimals={1}
          value={o.shell_samples_per_pitch} onChange={v => setOption('shell_samples_per_pitch', v)}
          disabled={fieldsDisabled || !o.watertight}
          hint=">= 2 guarantees gap-free voxel coverage" />
        <NumberField label="Max memory (GB)" min={0} max={128} step={0.5}
          value={o.max_memory_gb} onChange={v => setOption('max_memory_gb', v)}
          disabled={fieldsDisabled || !o.watertight}
          hint="Auto-lower shell resolution to fit this budget (0 disables)" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Remesh</span>
        <ToggleField label="Curvature-adaptive" value={o.adaptive}
          onChange={v => setOption('adaptive', v)} disabled={fieldsDisabled}
          hint="More faces where the surface bends" />
        <NumberField label="Remesh iterations" min={1} max={100} step={1}
          value={o.remesh_iters} onChange={v => setOption('remesh_iters', v)} disabled={fieldsDisabled} />
        <RangeField label="Feature angle" suffix="°" min={0} max={180} step={1}
          value={o.feature_deg} onChange={v => setOption('feature_deg', v)} disabled={fieldsDisabled}
          hint="Crease angle preserved as a feature" />
        <RangeField label="Calibrate passes" min={0} max={10} step={1}
          value={o.calibrate_passes} onChange={v => setOption('calibrate_passes', v)} disabled={fieldsDisabled}
          hint="Rough edge-length correction passes" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Silhouette projection</span>
        <ToggleField label="Project to surface" value={o.project}
          onChange={v => setOption('project', v)} disabled={fieldsDisabled}
          hint="Project the remesh back onto the original surface" />
        <NumberField label="Projection iterations" min={0} max={100} step={1}
          value={o.project_iters} onChange={v => setOption('project_iters', v)}
          disabled={fieldsDisabled || !o.project} />
        <RangeField label="Move clamp" min={0} max={10} step={0.1} decimals={1}
          value={o.project_clamp} onChange={v => setOption('project_clamp', v)}
          disabled={fieldsDisabled || !o.project}
          hint="Max per-vertex move as a multiple of local edge length" />
        <RangeField label="Relax strength" min={0} max={1} step={0.05} decimals={2}
          value={o.relax_strength} onChange={v => setOption('relax_strength', v)}
          disabled={fieldsDisabled || !o.project}
          hint="Tangential relaxation factor per iteration" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Misc</span>
        <NumberField label="Seed" min={0} step={1}
          value={o.seed} onChange={v => setOption('seed', v)} disabled={fieldsDisabled}
          hint="RNG seed for reproducibility" />
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Auto Retopo runs on the Python mesh-tools service (Settings → Mesh Tools).</span>
        <span className="mesh-editor-panel__hint">The result replaces the mesh; use Keep or Revert to decide.</span>
      </div>
    </>
  )
}
