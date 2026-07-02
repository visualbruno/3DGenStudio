// Optimize mode left panel. Runs the bundled gltfpack (meshoptimizer) binary
// server-side to simplify the mesh, and offers Keep/Revert on the result.
// Presentational: option state + handlers come from MeshEditorPage.
import { RangeField } from './MeshToolField'
import MeshToolResult from './MeshToolResult'
import MeshToolProgress from './MeshToolProgress'

export default function OptimizeToolsPanel({
  options,
  setOption,
  currentFaces = 0,
  running,
  result,
  progress,
  onRun,
  onKeepResult,
  onRevertResult,
  disabled,
}) {
  const o = options
  const fieldsDisabled = disabled || running
  const targetFaces = currentFaces ? Math.max(1, Math.round(currentFaces * o.simplify_ratio)) : null

  return (
    <>{/* OPTIMIZE */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Optimize</span>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running}
          title="Simplify the mesh with gltfpack (meshoptimizer)"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'compress'}</span>
          <span>{running ? 'Optimizing…' : 'Run Optimize'}</span>
        </button>

        {running && <MeshToolProgress progress={progress} />}

        {result && (
          <MeshToolResult
            title="Optimization applied"
            rows={result.rows}
            onKeep={onKeepResult}
            onRevert={onRevertResult}
            disabled={running}
          />
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Simplify</span>
        <RangeField label="Simplify ratio" min={0.001} max={1} step={0.001} decimals={3}
          value={o.simplify_ratio} onChange={v => setOption('simplify_ratio', v)} disabled={fieldsDisabled}
          hint="Target triangle count as a fraction of the original (1 = no simplification)" />
        {currentFaces ? (
          <div className="mesh-editor-texture-workflow-meta">
            <span><strong>Current faces:</strong> {currentFaces.toLocaleString()}</span>
            <span><strong>Target faces:</strong> ~{targetFaces.toLocaleString()}</span>
          </div>
        ) : null}
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Optimize runs the bundled gltfpack (meshoptimizer) binary.</span>
        <span className="mesh-editor-panel__hint">The result replaces the mesh; use Keep or Revert to decide.</span>
      </div>
    </>
  )
}
