// Auto UV mode left panel. Exposes every autouv.unwrap() parameter, runs the
// unwrap via the Python mesh-tools service, and offers Keep/Revert on the result.
// Presentational: option state + handlers come from MeshEditorPage.
import { RangeField, NumberField, ToggleField, SelectField } from './MeshToolField'
import MeshToolResult from './MeshToolResult'

export default function AutoUvToolsPanel({
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
    <>{/* AUTO UV */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Auto UV</span>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running}
          title="Unwrap UVs with the Python service"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'auto_awesome'}</span>
          <span>{running ? 'Unwrapping…' : 'Run Auto UV'}</span>
        </button>

        {result && (
          <MeshToolResult
            title="UV unwrap applied"
            rows={result.rows}
            previewUrl={result.previewUrl}
            previewAlt="UV layout"
            onKeep={onKeepResult}
            onRevert={onRevertResult}
            disabled={running}
          />
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Segmentation</span>
        <RangeField label="Normal-cone cap" suffix="°" min={1} max={180} step={1}
          value={o.max_cone_deg} onChange={v => setOption('max_cone_deg', v)} disabled={fieldsDisabled}
          hint="Higher = fewer, more distorted charts" />
        <RangeField label="Sharp-edge weight" min={0} max={1} step={0.01} decimals={2}
          value={o.sharp_weight} onChange={v => setOption('sharp_weight', v)} disabled={fieldsDisabled}
          hint="How strongly sharp edges attract seams" />
        <RangeField label="Fold cap" suffix="°" min={1} max={180} step={1}
          value={o.fold_cap_deg} onChange={v => setOption('fold_cap_deg', v)} disabled={fieldsDisabled}
          hint="Dihedral fold angle that forces a seam" />
        <NumberField label="Min faces / chart" min={1} step={1}
          value={o.min_faces} onChange={v => setOption('min_faces', v)} disabled={fieldsDisabled}
          hint="Charts smaller than this are dissolved into neighbours" />
        <NumberField label="Min area fraction" min={0} max={1} step={0.001}
          value={o.min_area_frac} onChange={v => setOption('min_area_frac', v)} disabled={fieldsDisabled}
          hint="Min chart area as a fraction of total surface area" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Refinement</span>
        <ToggleField label="Validated merge pass" value={o.refine}
          onChange={v => setOption('refine', v)} disabled={fieldsDisabled}
          hint="LSCM-validated chart merge (off = faster, more charts)" />
        <NumberField label="Merge below faces" min={1} step={1}
          value={o.refine_target_faces} onChange={v => setOption('refine_target_faces', v)}
          disabled={fieldsDisabled || !o.refine}
          hint="Charts below this face count are merge candidates" />
        <RangeField label="Merge distortion cap" min={1} max={10} step={0.01} decimals={2}
          value={o.refine_ad_thresh} onChange={v => setOption('refine_ad_thresh', v)}
          disabled={fieldsDisabled || !o.refine}
          hint="Max angle-distortion ratio a merge may introduce" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Parameterization</span>
        <SelectField label="Method" value={o.method} onChange={v => setOption('method', v)} disabled={fieldsDisabled}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'lscm', label: 'LSCM' },
            { value: 'arap', label: 'ARAP' },
            { value: 'planar', label: 'Planar' },
          ]} />
        <RangeField label="ARAP iterations" min={0} max={100} step={1}
          value={o.arap_iters} onChange={v => setOption('arap_iters', v)} disabled={fieldsDisabled}
          hint="0 disables ARAP (LSCM/planar only)" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Packing</span>
        <SelectField label="Atlas resolution" value={String(o.resolution)}
          onChange={v => setOption('resolution', Number(v))} disabled={fieldsDisabled}
          options={[256, 512, 1024, 2048, 4096, 8192].map(n => ({ value: String(n), label: `${n} px` }))} />
        <RangeField label="Padding" suffix=" texels" min={0} max={64} step={1}
          value={o.padding_texels} onChange={v => setOption('padding_texels', v)} disabled={fieldsDisabled} />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Topology repair</span>
        <ToggleField label="Proximity weld" value={o.weld}
          onChange={v => setOption('weld', v)} disabled={fieldsDisabled}
          hint="Weld coincident verts before unwrapping (stitches shattered shells)" />
        <RangeField label="Weld tolerance" min={0} max={1} step={0.01} decimals={2}
          value={o.weld_tol_frac} onChange={v => setOption('weld_tol_frac', v)}
          disabled={fieldsDisabled || !o.weld}
          hint="As a fraction of median edge length" />
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Auto UV runs on the Python mesh-tools service (Settings → Mesh Tools).</span>
        <span className="mesh-editor-panel__hint">The result replaces the mesh; use Keep or Revert to decide.</span>
      </div>
    </>
  )
}
