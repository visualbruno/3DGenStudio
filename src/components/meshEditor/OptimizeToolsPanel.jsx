// Optimize / LOD mode left panel. Runs the bundled gltfpack (meshoptimizer)
// binary server-side — either once at a chosen ratio, or as a whole LOD ladder —
// and offers Keep/Revert on the result.
// Presentational: option state + handlers come from MeshEditorPage.
import { RangeField, SelectField, ToggleField } from './MeshToolField'
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
  // LOD chain
  lodLevels,
  onLodLevelsChange,
  lodRatios = [],
  lodChain = [],
  lodSourceFaces = 0,
  lodGenerating,
  lodProgress,
  onGenerateLods,
  onApplyLod,
}) {
  const o = options
  const fieldsDisabled = disabled || running
  const targetFaces = currentFaces ? Math.max(1, Math.round(currentFaces * o.simplify_ratio)) : null
  // Which level the viewport is currently showing, matched on face count. This
  // is what distinguishes "you applied LOD2" from "you edited the mesh and these
  // numbers are now stale" — both leave currentFaces != lodSourceFaces, but only
  // the second one invalidates the chain.
  const currentLevel = lodChain.reduce((found, lod) => {
    if (found != null) return found
    const faces = lod.passthrough ? lodSourceFaces : lod.triangles
    return faces && faces === currentFaces ? lod.level : null
  }, null)

  // The chain is built from one snapshot of the mesh. Editing after that leaves
  // the numbers describing a mesh that no longer exists, so say so rather than
  // showing figures that quietly stopped being true.
  const chainStale = lodChain.length > 0 && lodSourceFaces > 0 && currentLevel == null

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

        {/* The knob that actually decides whether a mesh reaches its target.
            gltfpack's own default is 1%, which is strict enough that most meshes
            stall well above the requested ratio — and the stall used to be read
            as "UV seams are blocking this", sending the run to the destructive
            pass that reshades the whole mesh. Raising this reaches the target by
            moving the surface instead, which leaves normals and UVs alone. */}
        <RangeField label="Error budget" min={0.1} max={50} step={0.1} decimals={1} suffix="%"
          value={Number(((o.simplify_error ?? 0.05) * 100).toFixed(1))}
          onChange={v => setOption('simplify_error', v / 100)} disabled={fieldsDisabled}
          hint="How far the simplifier may move the surface away from the original. This, not the UV seams, is usually what stops a mesh short of its target — raising it reaches the target without touching normals or UVs. gltfpack's own default is 1%." />
        {(o.simplify_error ?? 0.05) >= 0.3 && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
            Budgets this large deform the silhouette, and at the extreme they collapse
            the mesh outright — a run that empties the mesh is refused rather than kept.
          </span>
        )}

        {/* The one knob here that improves the result without trading anything
            away: it does not change the triangle count, so it neither helps nor
            hinders reaching the ratio. It sits above the seam section because it
            belongs with "get a better mesh", not with "get a smaller one". */}
        <ToggleField label="Optimize vertex positions" value={!!o.simplify_update}
          onChange={v => setOption('simplify_update', v)} disabled={fieldsDisabled}
          hint="gltfpack's -sv: instead of only choosing which vertices survive, move the survivors to sit closer to the original surface and rewrite their normals, colours and UVs to match. The triangle count is identical either way — this buys a better-looking mesh at the same cost, so it is worth leaving on unless you need the output to match an earlier run. Meshes with morph targets or a second UV set skip it automatically." />

        <ToggleField label="Multi-step" value={!!o.multi_step}
          onChange={v => setOption('multi_step', v)} disabled={fieldsDisabled}
          hint="Reach the target by halving the face count on each run instead of in one pass, stopping at the target, when a step no longer removes anything meaningful, or after 10 steps. Each step gets the full error budget, so a large reduction is far less likely to stall and fall back to the quality-blind pass." />

        <ToggleField label="Lock border vertices" value={!!o.lock_border}
          onChange={v => setOption('lock_border', v)} disabled={fieldsDisabled}
          hint="Pins vertices on an open edge, so a mesh that is one piece of a larger set does not pull away from its neighbours along the shared edge. Costs some reduction." />

        <ToggleField label="Allow attribute seams to break" value={!!o.allow_seam_breaking}
          onChange={v => setOption('allow_seam_breaking', v)} disabled={fieldsDisabled}
          hint="The simplifier will not collapse an edge across an attribute discontinuity, and on a UV-mapped mesh every island boundary is one — so a heavily-seamed mesh has a floor it will not pass however high the error budget goes. Allowing seams to weld reaches the target, at the cost of the texture and of every hard edge. Raise the error budget first: it is the cheaper fix and it is usually the real limit." />
        {o.allow_seam_breaking && (
          <>
            <ToggleField label="Permissive collapses" value={!!o.permissive}
              onChange={v => setOption('permissive', v)} disabled={fieldsDisabled}
              hint="gltfpack's -sp: cross attribute discontinuities while still picking collapses by quality. It made no difference on any mesh measured here, so treat it as worth trying rather than as the fix." />
            <ToggleField label="Aggressive pass (last resort)" value={!!o.aggressive}
              onChange={v => setOption('aggressive', v)} disabled={fieldsDisabled}
              hint="gltfpack's -sa: reach the ratio regardless of quality. It is the only thing that breaks a real seam floor, and it does so by rebuilding the vertex set — normals and UVs are both reassigned, so hard edges smooth over and the texture scrambles. Turn it off to keep the shading and accept a coarser mesh." />
            {o.aggressive ? (
              <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
                On a mesh that needs this pass, hard edges and the texture are both rebuilt.
                This is the setting that makes a simplified mesh come back wrongly shaded.
              </span>
            ) : (
              <span className="mesh-editor-panel__hint">
                Shading is protected: a mesh that cannot reach its target will stop above it
                and say so, rather than come back reshaded.
              </span>
            )}
          </>
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">LOD chain</span>

        <SelectField label="Levels" value={String(lodLevels)}
          onChange={value => onLodLevelsChange(Number(value))}
          disabled={fieldsDisabled || lodGenerating}
          options={[2, 3, 4, 5, 6].map(n => ({ value: String(n), label: `${n} levels` }))}
          hint="LOD0 is the mesh as it stands; each level after it roughly halves the triangle count" />

        <div className="mesh-editor-texture-workflow-meta">
          <span><strong>Ratios:</strong> {lodRatios.map(r => `${Math.round(r * 100)}%`).join(' / ')}</span>
        </div>

        <button
          type="button"
          className="mesh-editor-btn"
          onClick={onGenerateLods}
          disabled={disabled || running || lodGenerating}
          title="Build every level and report its real triangle count"
        >
          <span className="material-symbols-outlined">{lodGenerating ? 'progress_activity' : 'stacked_bar_chart'}</span>
          <span>{lodGenerating ? 'Generating…' : 'Generate LOD chain'}</span>
        </button>

        {lodGenerating && <MeshToolProgress progress={lodProgress} />}

        {chainStale && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
            Built from a {lodSourceFaces.toLocaleString()}-face mesh; the current one has{' '}
            {currentFaces.toLocaleString()}. Regenerate to match.
          </span>
        )}

        {lodChain.length > 0 && (
          <>
            <div className="mesh-editor-lod-table">
              {lodChain.map(lod => (
                <div className="mesh-editor-lod-row" key={lod.level}>
                  <span className="mesh-editor-lod-row__name">LOD{lod.level}</span>
                  <span className="mesh-editor-lod-row__ratio">
                    {/* Show what was actually reached, not what was asked for. */}
                    {lod.achievedRatio != null ? Math.round(lod.achievedRatio * 100) : Math.round(lod.ratio * 100)}%
                  </span>
                  <strong className="mesh-editor-lod-row__count">
                    {lod.seamLimited && (
                      <span className="material-symbols-outlined mesh-editor-lod-row__warn" title="Stopped early to protect the UVs">
                        warning
                      </span>
                    )}
                    {lod.triangles != null ? `${lod.triangles.toLocaleString()} tris` : `${lodSourceFaces.toLocaleString()} tris`}
                  </strong>
                  <button
                    type="button"
                    className="mesh-editor-lod-row__apply"
                    onClick={() => onApplyLod(lod.level)}
                    disabled={disabled || running || lodGenerating || currentLevel === lod.level}
                    title={currentLevel === lod.level
                      ? `LOD${lod.level} is what the viewport is showing`
                      : lod.passthrough
                        ? 'Go back to the mesh the chain was built from (undoable)'
                        : `Replace the mesh with LOD${lod.level} (undoable)`}
                  >
                    {currentLevel === lod.level ? 'current' : lod.passthrough ? 'Restore' : 'Apply'}
                  </button>
                </div>
              ))}
            </div>

            {lodChain.some(lod => lod.seamLimited) && (
              <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
                Marked levels stopped short of their target. Raise the <em>Error budget</em> first —
                that is the usual limit, and it costs nothing in normals or UVs. If they still stop
                short, the mesh has a real attribute-seam floor and only “Allow attribute seams to
                break” will pass it.
              </span>
            )}
            {lodChain.some(lod => lod.seamsBroken) && (
              <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
                Some levels welded attribute seams to reach their target — check the texture
                <em>and the hard edges</em> on those.
              </span>
            )}
          </>
        )}

        <span className="mesh-editor-panel__hint">
          Applying a level swaps the mesh here so you can judge it in the viewport; <em>Restore</em> on
          LOD0 brings back the mesh the chain was built from. To write every level to disk as
          <em> name_LOD0…n</em>, use Export → “Generate LOD chain”.
        </span>
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Optimize runs the bundled gltfpack (meshoptimizer) binary.</span>
        <span className="mesh-editor-panel__hint">The result replaces the mesh; use Keep or Revert to decide.</span>
        <span className="mesh-editor-panel__hint">
          Reaching a low ratio is usually a matter of the error budget, not the seams. Seam welding
          is the last step, and the only one that changes how the mesh is shaded.
        </span>
        <span className="mesh-editor-panel__hint">
          Normals are recomputed from the simplified topology when the result loads, so a mesh whose
          look depended on authored (custom or weighted) normals will shade differently either way.
        </span>
      </div>
    </>
  )
}
