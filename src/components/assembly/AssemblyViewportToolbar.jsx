// View controls, overlaid on the top-left of the assembly viewport.
//
// Top-LEFT deliberately: the view cube reserves the top-right (see
// VIEW_GIZMO_MARGIN / VIEW_GIZMO_HIT_RADIUS in utils/viewGizmoLayout.js), and
// buttons under it would be unclickable.
export default function AssemblyViewportToolbar({
  settings,
  onPatchSettings,
  onFrameAll,
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

  return (
    <div className="assembly-vp-toolbar">
      <div className="assembly-vp-toolbar__group">
        <button
          type="button"
          className="assembly-vp-toolbar__btn"
          title="Frame everything"
          onClick={onFrameAll}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>fit_screen</span>
        </button>
        {toggle('orthographic', 'square_foot', settings.orthographic ? 'Orthographic — switch to perspective' : 'Perspective — switch to orthographic')}
        {toggle('showGrid', 'grid_on', 'Show grid')}
      </div>

      {pieceCount > 0 && (
        <div className="assembly-vp-toolbar__readout">
          <span>{pieceCount} mesh{pieceCount === 1 ? '' : 'es'}</span>
          <span>{vertexCount.toLocaleString()} verts</span>
          {/* The diagnostic that makes the actual problem legible. An AI-generated
              armour piece is routinely 0.02x or 50x the body, and without a number
              the user has to hunt for it by zooming. */}
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
