// Auto Retopo mode left panel. Exposes every autoretopo.RetopoConfig field, runs
// the retopology via the Python mesh-tools service, and offers Keep/Revert on the
// result. Presentational: option state + handlers come from MeshEditorPage.
import { RangeField, NumberField, ToggleField, SelectField } from './MeshToolField'
import MeshToolResult from './MeshToolResult'
import MeshToolProgress from './MeshToolProgress'

export default function AutoRetopoToolsPanel({
  options,
  setOption,
  running,
  result,
  progress,
  watertight,
  watertightChecking,
  onCheckWatertight,
  onCleanNonManifold,
  repairOptions,
  setRepairOption,
  repairRunning,
  repairResult,
  repairProgress,
  onKeepRepairResult,
  onRevertRepairResult,
  onRun,
  onKeepResult,
  onRevertResult,
  disabled,
}) {
  const o = options
  const fieldsDisabled = disabled || running

  const watertightLabel = () => {
    if (watertight.watertight) return 'Mesh is already watertight — no need to build a shell.'
    const parts = []
    if (watertight.boundaryEdges > 0) parts.push(`${watertight.boundaryEdges} open edge${watertight.boundaryEdges === 1 ? '' : 's'}`)
    if (watertight.nonManifoldEdges > 0) parts.push(`${watertight.nonManifoldEdges} non-manifold edge${watertight.nonManifoldEdges === 1 ? '' : 's'}`)
    return parts.length ? `Mesh is not watertight (${parts.join(', ')}).` : 'Mesh is not watertight.'
  }

  return (
    <>{/* AUTO RETOPO */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Auto Retopo</span>

        <button
          type="button"
          className="mesh-editor-btn"
          onClick={onCheckWatertight}
          disabled={disabled || running || watertightChecking}
          title="Analyze the current mesh topology for open or non-manifold edges"
        >
          <span className="material-symbols-outlined">{watertightChecking ? 'progress_activity' : 'water_drop'}</span>
          <span>{watertightChecking ? 'Checking…' : 'Check if Watertight'}</span>
        </button>

        {watertight && !watertightChecking && (
          <div
            className="mesh-editor-panel__hint"
            style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: '1.1em', color: watertight.watertight ? '#4caf50' : '#e0a030' }}
            >
              {watertight.watertight ? 'check_circle' : 'warning'}
            </span>
            <span>{watertightLabel()}</span>
          </div>
        )}

        {watertight && !watertightChecking && !watertight.watertight && watertight.nonManifoldEdges > 0 && (
          <>
            <button
              type="button"
              className="mesh-editor-btn"
              onClick={onCleanNonManifold}
              disabled={disabled || running || repairRunning}
              title="Resolve non-manifold edges directly (weld, drop duplicate faces, remove/split the offending faces, close small holes) without a full retopo"
            >
              <span className="material-symbols-outlined">{repairRunning ? 'progress_activity' : 'cleaning_services'}</span>
              <span>{repairRunning ? 'Repairing…' : 'Clean Non-Manifold Edges'}</span>
            </button>
            {repairOptions && (
              <>
                <SelectField label="Repair method" value={repairOptions.method}
                  onChange={v => setRepairOption('method', v)} disabled={fieldsDisabled || repairRunning}
                  options={[
                    { value: 'remove', label: 'Remove faces (then close holes)' },
                    { value: 'split', label: 'Split vertices (keep faces)' },
                  ]}
                  hint="Remove deletes the offending faces; Split detaches the sheets and leaves open edges" />
                <ToggleField label="Close resulting holes" value={repairOptions.close_holes}
                  onChange={v => setRepairOption('close_holes', v)} disabled={fieldsDisabled || repairRunning}
                  hint="Seal the small holes that face removal opens (uncheck to leave them and guarantee no new non-manifold edges)" />
                <NumberField label="Max hole size" min={0} max={5000} step={1}
                  value={repairOptions.max_hole_size} onChange={v => setRepairOption('max_hole_size', v)}
                  disabled={fieldsDisabled || repairRunning || !repairOptions.close_holes}
                  hint="Largest hole (in edges) to close; bigger openings are left intact" />
              </>
            )}
          </>
        )}

        {repairRunning && <MeshToolProgress progress={repairProgress} />}

        {repairResult && (
          <MeshToolResult
            title="Repair applied"
            rows={repairResult.rows}
            onKeep={onKeepRepairResult}
            onRevert={onRevertRepairResult}
            disabled={repairRunning}
          />
        )}

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

        {running && <MeshToolProgress progress={progress} />}

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
        {watertight?.watertight && o.watertight && (
          <span className="mesh-editor-panel__hint">The mesh is already watertight; you can turn this off to remesh the surface directly and stay closer to the original.</span>
        )}
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
          hint="SDF blur sigma in voxels; kills voxel ripple (lower = crisper)" />
        <RangeField label="Taubin polish" min={0} max={100} step={1}
          value={o.shell_taubin} onChange={v => setOption('shell_taubin', v)}
          disabled={fieldsDisabled || !o.watertight}
          hint="Taubin smoothing steps on the dense shell (0 disables)" />
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
        <span className="mesh-editor-panel__section-title">Feature preservation</span>
        <ToggleField label="Preserve features" value={o.preserve_features}
          onChange={v => setOption('preserve_features', v)} disabled={fieldsDisabled}
          hint="Hard-surface mode: keep sharp creases crisp, skip smoothing/projection" />
        <RangeField label="Feature angle" suffix="°" min={0} max={180} step={1}
          value={o.feature_angle} onChange={v => setOption('feature_angle', v)}
          disabled={fieldsDisabled || !o.preserve_features}
          hint="Crease angle treated as a hard edge when preserve features is on" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Silhouette projection</span>
        {o.preserve_features && !o.watertight && (
          <span className="mesh-editor-panel__hint">Projection is skipped while Preserve features is on (surface mode only).</span>
        )}
        {o.preserve_features && o.watertight && (
          <span className="mesh-editor-panel__hint">Watertight shells are always projected onto the original surface, even with Preserve features on.</span>
        )}
        <ToggleField label="Project to surface" value={o.project}
          onChange={v => setOption('project', v)} disabled={fieldsDisabled || (o.preserve_features && !o.watertight)}
          hint="Project the remesh back onto the original surface" />
        <NumberField label="Projection iterations" min={0} max={100} step={1}
          value={o.project_iters} onChange={v => setOption('project_iters', v)}
          disabled={fieldsDisabled || !o.project || (o.preserve_features && !o.watertight)} />
        <RangeField label="Move clamp" min={0} max={10} step={0.1} decimals={1}
          value={o.project_clamp} onChange={v => setOption('project_clamp', v)}
          disabled={fieldsDisabled || !o.project || (o.preserve_features && !o.watertight)}
          hint="Max per-vertex move as a multiple of local edge length" />
        <RangeField label="Relax strength" min={0} max={1} step={0.05} decimals={2}
          value={o.relax_strength} onChange={v => setOption('relax_strength', v)}
          disabled={fieldsDisabled || !o.project || (o.preserve_features && !o.watertight)}
          hint="Tangential relaxation factor per iteration" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Compute</span>
        <SelectField label="Device" value={o.device}
          onChange={v => setOption('device', v)} disabled={fieldsDisabled}
          options={[
            { value: 'auto', label: 'Auto (GPU if NVIDIA)' },
            { value: 'cpu', label: 'CPU' },
            { value: 'cuda', label: 'CUDA (NVIDIA GPU)' },
          ]}
          hint="Runs the watertight-shell stage (CuPy) and the surface-projection stage (NVIDIA Warp) on NVIDIA GPUs; falls back to CPU when unavailable. Remesh / 'Building clean topology' always runs on the CPU." />
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
