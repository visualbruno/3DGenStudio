// Bake mode left panel. Captures a high-poly source's detail onto the current
// mesh's UVs via headless Blender, then applies the result to the mesh.
//
// This is what makes Auto Retopo and Optimize non-destructive: on their own they
// return clean topology with the detail deleted. The editor snapshots the mesh
// before every tool run, so the detail is still available to sample from — those
// snapshots are the source list below.
// Presentational: option state + handlers come from MeshEditorPage.
import { NumberField, RangeField, SelectField, ToggleField } from './MeshToolField'
import MeshToolProgress from './MeshToolProgress'
import { BAKE_MAP_LABELS } from '../../utils/meshTools'
import { BAKE_COVERAGE_COMPLETE } from '../../utils/meshExport'

// Request order for the checkboxes. 'orm' is never requested — the service packs
// it from ao/roughness/metallic — but it does come back in the result.
const MAP_ORDER = ['normal', 'ao', 'base_color', 'roughness', 'metallic']
const RESULT_ORDER = [...MAP_ORDER, 'orm']

export default function BakeToolsPanel({
  options,
  setOption,
  sources = [],
  sourceId,
  onSourceChange,
  onPickAsset,
  loadingSource,
  running,
  progress,
  result,
  onRun,
  onApply,
  hasUvs,
  disabled,
}) {
  const o = options
  const fieldsDisabled = disabled || running
  const selectedMaps = Array.isArray(o.maps) ? o.maps : []
  const coverageIsLow = typeof result?.stats?.coverage === 'number'
    && result.stats.coverage < BAKE_COVERAGE_COMPLETE

  const toggleMap = (name, on) => {
    const next = on
      ? MAP_ORDER.filter(entry => entry === name || selectedMaps.includes(entry))
      : selectedMaps.filter(entry => entry !== name)
    setOption('maps', next)
  }

  // Newest first, so the list reads as a history. Face count and time both go in
  // the label because several entries can share a name (three Auto Retopo runs).
  const sourceOptions = sources.map(source => ({
    value: source.id,
    label: [
      source.label,
      source.faces ? `${source.faces.toLocaleString()} faces` : null,
      source.at,
    ].filter(Boolean).join(' · '),
  }))

  return (
    <>{/* BAKE */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Bake</span>

        {!hasUvs && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
            This mesh has no UVs, so there is nowhere to bake to. Run Auto UV first.
          </span>
        )}

        {sources.length === 0 ? (
          <span className="mesh-editor-panel__hint">
            No high-poly source yet. Run Auto Retopo or Optimize and the mesh from just before it
            is kept here automatically — or choose one from the library below.
          </span>
        ) : (
          <SelectField label="High-poly source" value={sourceId || sourceOptions[0]?.value || ''}
            onChange={onSourceChange} options={sourceOptions} disabled={fieldsDisabled}
            hint="The mesh whose detail is captured. Snapshots are taken automatically before every tool run." />
        )}

        <button
          type="button"
          className="mesh-editor-btn"
          onClick={onPickAsset}
          disabled={fieldsDisabled}
          title="Pick a mesh from the asset library — versions count, so an earlier high-poly version of this mesh works"
        >
          <span className="material-symbols-outlined">{loadingSource ? 'progress_activity' : 'inventory_2'}</span>
          <span>{loadingSource ? 'Loading asset…' : 'Choose a mesh asset…'}</span>
        </button>

        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running || !hasUvs || sources.length === 0}
          title="Bake the source's detail onto this mesh's UVs"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'flare'}</span>
          <span>{running ? 'Baking…' : 'Run Bake'}</span>
        </button>

        {running && <MeshToolProgress progress={progress} />}
      </div>

      {result?.maps && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Result</span>
          <div className="mesh-editor-bake-grid">
            {RESULT_ORDER.filter(name => result.maps[name]).map(name => (
              <figure className="mesh-editor-bake-map" key={name}>
                <img src={result.maps[name].url} alt={BAKE_MAP_LABELS[name] || name} />
                <figcaption>{BAKE_MAP_LABELS[name] || name}</figcaption>
              </figure>
            ))}
          </div>
          {result.stats && (
            <div className="mesh-editor-texture-workflow-meta">
              <span><strong>Resolution:</strong> {result.stats.resolution}px</span>
              <span><strong>Source:</strong> {result.stats.high_faces?.toLocaleString()} faces</span>
              <span><strong>Target:</strong> {result.stats.low_faces?.toLocaleString()} faces</span>
              {/* The figure that says whether the bake worked. Shown even at 100%,
                  because a number that only appears when it is bad is a number
                  nobody learns to read. */}
              {typeof result.stats.coverage === 'number' && (
                <span style={coverageIsLow ? { color: '#e0603a' } : undefined}>
                  <strong>Coverage:</strong> {(result.stats.coverage * 100).toFixed(coverageIsLow ? 0 : 1)}% of the UVs
                </span>
              )}
              {result.stats.orm_channels?.length > 0 && (
                <span><strong>Packed:</strong> {result.stats.orm_channels.join(' / ')}</span>
              )}
            </div>
          )}

          {coverageIsLow && (
            <span className="mesh-editor-panel__hint" style={{ color: '#e0603a' }}>
              The rays only reached {(result.stats.coverage * 100).toFixed(0)}% of the UV layout — the
              remaining {(100 - result.stats.coverage * 100).toFixed(0)}% came back blank. Applying this
              leaves those texels as they are rather than blacking them out, but the mesh will still be
              missing that detail. Either the source is not the mesh this one came from, or the cage
              extrusion is too small to reach detail that sticks out.
            </span>
          )}

          {result.stats?.alignment?.mode === 'applied' && (
            <span className="mesh-editor-panel__hint">
              The source sat {result.stats.alignment.distance?.toFixed(3)}m away from this mesh and was
              re-centred onto it before baking — the two had different pivots.
            </span>
          )}

          {result.stats?.alignment?.mode === 'skipped-scale' && (
            <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
              The source is a different size from this mesh, so it was baked where it stands rather than
              being lined up automatically — lining up meshes at different scales would be a guess.
            </span>
          )}

          {result.stats?.low_objects_ignored > 0 && (
            <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
              This mesh arrived as {result.stats.low_objects_ignored + 1} separate objects and only the
              first was baked to. Baking writes to one UV layout, so the others were skipped.
            </span>
          )}

          {result.stats?.flat_channels?.length > 0 && (
            <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
              {result.stats.flat_channels.join(' and ')} came from a constant on the source
              material, not a texture, so {result.stats.flat_channels.length === 1 ? 'that map is' : 'those maps are'} flat.
              The material&apos;s own value is better than baking it — leave{' '}
              {result.stats.flat_channels.length === 1 ? 'it' : 'them'} unchecked.
            </span>
          )}
          <button
            type="button"
            className="mesh-editor-btn mesh-editor-btn--primary"
            onClick={onApply}
            disabled={running}
            title="Attach normal/AO to the material and draw a base-colour transfer into the texture"
          >
            <span className="material-symbols-outlined">done_all</span>
            <span>Apply to mesh</span>
          </button>
          <span className="mesh-editor-panel__hint">
            Normal attaches to the material; AO, roughness and metallic attach as the single packed
            ORM texture glTF expects; a base-colour transfer is drawn into the paint texture. They
            all then travel with the mesh on save and export.
          </span>
        </div>
      )}

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Maps</span>
        {MAP_ORDER.map(name => (
          <label className="mesh-editor-workflow-field mesh-editor-workflow-field--checkbox" key={name}>
            <input
              type="checkbox"
              checked={selectedMaps.includes(name)}
              onChange={event => toggleMap(name, event.target.checked)}
              disabled={fieldsDisabled}
            />
            <span>{BAKE_MAP_LABELS[name] || name}</span>
          </label>
        ))}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Quality</span>
        <SelectField label="Resolution" value={String(o.resolution)}
          onChange={value => setOption('resolution', Number(value))} disabled={fieldsDisabled}
          options={[512, 1024, 2048, 4096].map(n => ({ value: String(n), label: `${n} × ${n}` }))}
          hint="Cost scales with the square of this" />
        <NumberField label="Samples" min={1} max={512} step={1} value={o.samples}
          onChange={v => setOption('samples', v)} disabled={fieldsDisabled}
          hint="Only the AO pass is noisy enough to need more than a few" />
        <RangeField label="Cage extrusion" min={0} max={0.5} step={0.005} decimals={3} suffix="m"
          value={o.cage_extrusion} onChange={v => setOption('cage_extrusion', v)} disabled={fieldsDisabled}
          hint="How far the rays start outside the surface. 0 scales it to the mesh (2% of its bounding-box diagonal), which is right far more often than any fixed distance." />
        {o.cage_extrusion === 0 && (
          <span className="mesh-editor-panel__hint">Cage extrusion: automatic.</span>
        )}
        <NumberField label="Margin (texels)" min={0} max={64} step={1} value={o.margin}
          onChange={v => setOption('margin', v)} disabled={fieldsDisabled}
          hint="Dilates the baked islands so filtering cannot sample the empty gutter and bleed seams" />
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Alignment</span>
        <ToggleField label="Align source to mesh" value={o.align_source !== false}
          onChange={v => setOption('align_source', v)} disabled={fieldsDisabled}
          hint="A bake casts rays from this mesh onto the source, so the two must occupy the same space. Moving the pivot after picking a source separates them, and the bake then comes back blank where they no longer overlap. This re-centres a source that is the same size as the mesh; one at a different scale is never moved." />
        <ToggleField label="Refuse a source that does not overlap" value={(o.require_overlap ?? 0.5) > 0}
          onChange={v => setOption('require_overlap', v ? 0.5 : 0)} disabled={fieldsDisabled}
          hint="Stops in seconds rather than spending minutes of ray casting to return blank maps. Turn off to bake a source that only covers part of the mesh on purpose." />
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Baking runs headless Blender on the Mesh Tools service (Settings → Mesh Tools).</span>
        <span className="mesh-editor-panel__hint">A 4096px AO bake against a dense source can take minutes.</span>
      </div>
    </>
  )
}
