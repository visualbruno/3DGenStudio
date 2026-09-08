// The "Transfer Rig From Mesh" block of the Auto Rig panel: take the skeleton,
// skin weights and animations off another mesh instead of generating them.
//
// It sits next to Run Auto Rig because it answers the same question by the other
// route, and it is the better route whenever a rigged version of the mesh
// already exists — a high-poly the low-poly was retopologised from, an LOD, or
// this very asset before an edit rebuilt its topology and dropped the weights.
// Generating a rig again would produce a *different* skeleton and throw away
// every bone correction, weight edit and bone mapping made against the old one.
//
// Presentational: every value and handler comes from MeshEditorPage. Rendered
// unconditionally by AutoRigToolsPanel.
import { RangeField } from './MeshToolField'

export default function RigTransferSection({
  source = null,
  loading = false,
  onPickSource,
  onClearSource,
  fit = null,
  smoothing = 2,
  onSmoothingChange,
  running = false,
  result = null,
  onRun,
  onRevert,
  onDismiss,
  disabled = false,
}) {
  const fieldsDisabled = disabled || running
  // A refusal is not a warning: the run will not start, so it is said before the
  // button rather than after it.
  const refusal = fit?.refuse || null

  return (
    <div className="mesh-editor-panel__section">
      <span className="mesh-editor-panel__section-title">Transfer Rig From Mesh</span>

      {!source ? (
        <span className="mesh-editor-panel__hint">
          Copy a skeleton, its skin weights and any animations from another mesh onto this one —
          high-poly to low-poly, or back from an earlier rigged version after an edit lost the rig.
          No GPU needed.
        </span>
      ) : (
        <div className="mesh-editor-texture-workflow-meta">
          <span><strong>Source:</strong> {source.name}</span>
          <span><strong>Bones:</strong> {source.boneCount}</span>
          {source.clipCount > 0 && (
            <span><strong>Animations:</strong> {source.clipCount} clip{source.clipCount === 1 ? '' : 's'}</span>
          )}
        </div>
      )}

      {/* Submeshes whose bones are not in the skeleton being transferred are left
          out entirely — including them would bind that patch of the mesh to the
          wrong bones. Worth saying: it explains a hole in the result. */}
      {!!source?.skipped?.length && (
        <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em', color: '#e0a030' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>warning</span>
          <span>
            {source.skipped.length} part{source.skipped.length === 1 ? '' : 's'} of the source
            {source.skipped.length === 1 ? ' was' : ' were'} skipped ({source.skipped[0].reason}), so
            anything only they covered will come back unweighted.
          </span>
        </div>
      )}

      <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
        <button
          type="button"
          className="mesh-editor-btn"
          onClick={onPickSource}
          disabled={fieldsDisabled || loading}
          title="Pick the rigged mesh to copy from — versions count, so an earlier rigged version of this mesh works"
        >
          <span className="material-symbols-outlined">{loading ? 'progress_activity' : 'inventory_2'}</span>
          <span>{loading ? 'Loading mesh…' : source ? 'Change source…' : 'Choose rigged mesh…'}</span>
        </button>
        <button
          type="button"
          className="mesh-editor-btn"
          onClick={onClearSource}
          disabled={fieldsDisabled || !source}
          title="Forget the chosen source mesh"
        >
          <span className="material-symbols-outlined">close</span>
          <span>Clear source</span>
        </button>
      </div>

      {/* The transfer is positional: each vertex takes the weights of the nearest
          point on the source surface. Two meshes in different spaces therefore
          produce a rig that is not slightly wrong but meaningless, and the box
          measurement is the only warning available before it happens. */}
      {refusal && (
        <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em', color: '#ff8a80' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>block</span>
          <span>{refusal}</span>
        </div>
      )}
      {/* Not a refusal: the boxes overlap, so the run would go ahead and produce
          weights sampled from the wrong part of the source. */}
      {!refusal && fit?.warn && (
        <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em', color: '#e0a030' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>straighten</span>
          <span>{fit.warn}</span>
        </div>
      )}
      {!refusal && fit?.recentred && (
        <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>open_with</span>
          <span>
            The source sits away from this mesh but is the same size, so it will be re-centred onto it
            before sampling — the skeleton moves with it.
          </span>
        </div>
      )}

      <RangeField label="Weight smoothing" min={0} max={4} step={1}
        value={smoothing} onChange={onSmoothingChange} disabled={fieldsDisabled}
        hint="Averaging passes over the transferred weights. Softens the hard line a sparse mesh picks up where the nearest source point flips from one bone to another; too much washes small parts toward one bone." />

      <button
        type="button"
        className="mesh-editor-btn mesh-editor-btn--primary"
        onClick={onRun}
        disabled={fieldsDisabled || !source || !!refusal}
        title={source
          ? 'Copy the skeleton, skin weights and animations from the source mesh onto this one'
          : 'Choose a rigged mesh to copy from first'}
      >
        <span className="material-symbols-outlined">{running ? 'progress_activity' : 'content_copy'}</span>
        <span>{running ? 'Transferring…' : 'Transfer Rig'}</span>
      </button>

      {result && (
        <div className="mesh-editor-patch-preview">
          <strong className="mesh-editor-patch-preview__title">
            <span className="material-symbols-outlined">check_circle</span>
            Rig transferred
          </strong>

          <div className="mesh-editor-texture-workflow-meta">
            {result.rows.map(row => (
              <span key={row.label}><strong>{row.label}:</strong> {row.value}</span>
            ))}
          </div>

          {/* Sampling far from the source means the two surfaces are not really
              the same shape there — a limb the source does not have, or a cage
              that stands well off it. The weights are still the best available
              answer, so this reports rather than refuses. */}
          {result.farSample && (
            <div className="mesh-editor-panel__hint" style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4em', color: '#e0a030' }}>
              <span className="material-symbols-outlined" style={{ fontSize: '1.1em' }}>warning</span>
              <span>
                Some vertices took their weights from a long way off the source surface. Check the
                extremities in the Animations tab before saving — those are the parts to look at.
              </span>
            </div>
          )}

          <span className="mesh-editor-panel__hint">
            The skeleton is on your mesh. Save, Save as version and Export in the toolbar all keep it,
            together with the materials and textures.
          </span>

          <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double mesh-editor-patch-preview__actions">
            <button
              type="button"
              className="mesh-editor-btn"
              onClick={onDismiss}
              title="Dismiss this result (keeps the transferred rig)"
            >
              <span className="material-symbols-outlined">close</span>
              <span>Keep</span>
            </button>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={onRevert}
              title="Put back the rig this mesh had before the transfer"
            >
              <span className="material-symbols-outlined">undo</span>
              <span>Revert</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
