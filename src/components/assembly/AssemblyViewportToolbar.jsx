// View and gizmo controls, overlaid on the top-left of the assembly viewport.
//
// Top-LEFT deliberately: the view cube reserves the top-right (see
// VIEW_GIZMO_MARGIN / VIEW_GIZMO_HIT_RADIUS in utils/viewGizmoLayout.js), and
// buttons under it would be unclickable.
const GIZMO_MODES = [
  { id: 'translate', icon: 'open_with', label: 'Move (G)' },
  { id: 'rotate', icon: 'rotate_right', label: 'Rotate (R)' },
  { id: 'scale', icon: 'aspect_ratio', label: 'Scale (S)' },
]

export default function AssemblyViewportToolbar({
  settings,
  onPatchSettings,
  onFrameAll,
  hasSelection,
  sculptEnabled,
  canSculptUndo,
  onSculptUndo,
  pieceCount,
  vertexCount,
  scaleRatio,
}) {
  const toggle = (key, icon, title) => (
    <button
      type="button"
      className={`assembly-vp-toolbar__btn ${settings[key] ? 'assembly-vp-toolbar__btn--on' : ''}`}
      title={title}
      onClick={() => onPatchSettings({ [key]: !settings[key] })}
    >
      <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>{icon}</span>
    </button>
  )

  const snapField = (key, label, step, title) => (
    <label className="assembly-vp-toolbar__snap" title={title}>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step={step}
        value={settings[key]}
        onChange={event => {
          const value = Number(event.target.value)
          onPatchSettings({ [key]: Number.isFinite(value) && value > 0 ? value : 0 })
        }}
      />
    </label>
  )

  // Scale is local-only in three's TransformControls regardless of what is
  // passed, so the toggle is disabled there rather than shown lying.
  const spaceLocked = settings.gizmoMode === 'scale'

  return (
    <div className="assembly-vp-toolbar">
      <div className="assembly-vp-toolbar__group">
        {GIZMO_MODES.map(({ id, icon, label }) => (
          <button
            key={id}
            type="button"
            className={`assembly-vp-toolbar__btn ${settings.gizmoMode === id ? 'assembly-vp-toolbar__btn--on' : ''}`}
            title={
              settings.sculptMode ? `${label} — not while Elastic Grab is on`
                : hasSelection ? label
                  : `${label} — select a piece first`
            }
            // Disabled with the brush, matching the hidden gizmo: the mode can
            // still be chosen the moment sculpting is switched off.
            disabled={!hasSelection || settings.sculptMode}
            onClick={() => onPatchSettings({ gizmoMode: id })}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>{icon}</span>
          </button>
        ))}
        <button
          type="button"
          className="assembly-vp-toolbar__btn assembly-vp-toolbar__btn--text"
          title={spaceLocked
            ? 'Scale is always in the piece’s own space'
            : `Gizmo axes: ${settings.gizmoSpace} — click to switch`}
          disabled={!hasSelection || spaceLocked}
          onClick={() => onPatchSettings({ gizmoSpace: settings.gizmoSpace === 'world' ? 'local' : 'world' })}
        >
          {spaceLocked ? 'local' : settings.gizmoSpace}
        </button>
      </div>

      <div className="assembly-vp-toolbar__group">
        {toggle('snapEnabled', 'straighten', 'Snap the gizmo to fixed increments')}
        {settings.snapEnabled && (
          <>
            {snapField('snapTranslate', 'mv', 0.01, 'Move increment, in world units (0 = off)')}
            {snapField('snapRotateDeg', 'rot', 1, 'Rotate increment, in degrees (0 = off)')}
            {snapField('snapScale', 'scl', 0.01, 'Scale increment (0 = off)')}
          </>
        )}
      </div>

      {/* Manual Elastic Grab — for the small local defects the automatic fit
          leaves behind, which are seconds of work by hand. */}
      <div className="assembly-vp-toolbar__group">
        <button
          type="button"
          className={`assembly-vp-toolbar__btn ${settings.sculptMode ? 'assembly-vp-toolbar__btn--on' : ''}`}
          title="Elastic Grab — drag the surface to reshape it by hand"
          onClick={() => onPatchSettings({ sculptMode: !settings.sculptMode })}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>pan_tool</span>
        </button>
        {sculptEnabled && (
          <>
            {snapField('sculptRadius', 'size', 5, 'Brush size, in screen pixels')}
            {snapField('sculptStrength', 'str', 0.1, 'How strongly the drag pulls the surface (0-1)')}
            <button
              type="button"
              className="assembly-vp-toolbar__btn"
              title="Undo the last brush stroke"
              disabled={!canSculptUndo}
              onClick={onSculptUndo}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>undo</span>
            </button>
          </>
        )}
      </div>

      <div className="assembly-vp-toolbar__group">
        <button
          type="button"
          className="assembly-vp-toolbar__btn"
          title="Frame everything"
          onClick={onFrameAll}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>fit_screen</span>
        </button>
        {toggle('orthographic', 'square_foot', settings.orthographic
          ? 'Orthographic — switch to perspective'
          : 'Perspective — switch to orthographic')}
        {toggle('showGrid', 'grid_on', 'Show grid')}
      </div>

      {pieceCount > 0 && (
        <div className="assembly-vp-toolbar__readout">
          <span>{pieceCount} mesh{pieceCount === 1 ? '' : 'es'}</span>
          <span>{vertexCount.toLocaleString()} verts</span>
          {/* The diagnostic that makes the actual problem legible. An
              AI-generated armour piece is routinely 0.02x or 50x the body, and
              without a number the user has to hunt for it by zooming. */}
          {scaleRatio != null && (
            <span
              className={scaleRatio < 0.5 || scaleRatio > 2 ? 'assembly-vp-toolbar__warn' : ''}
              title="Selected piece size relative to the base body"
            >
              {scaleRatio < 0.01 || scaleRatio > 100
                ? `${scaleRatio.toExponential(1)}x base`
                : `${scaleRatio.toFixed(2)}x base`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
