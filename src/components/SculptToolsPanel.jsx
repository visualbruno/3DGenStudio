import React from 'react'

const BRUSHES = [
  { id: 'standard', label: 'Standard', icon: 'brush' },
  { id: 'clay',     label: 'Clay',     icon: 'layers' },
  { id: 'inflate',  label: 'Inflate',  icon: 'expand' },
  { id: 'smooth',   label: 'Smooth',   icon: 'auto_fix_high' },
  { id: 'flatten',  label: 'Flatten',  icon: 'horizontal_rule' },
  { id: 'pinch',    label: 'Pinch',    icon: 'compress' },
  { id: 'grab',     label: 'Grab',     icon: 'pan_tool' }
]

/**
 * Sidebar UI for the sculpting mode. Pure presentational — all state and
 * behavior are owned by MeshEditorPage.
 *
 * `enabledBrushes` is the list of brush ids that are actually wired up; any
 * brush not in this list is rendered but disabled (so the UI shows the full
 * planned set even when only a subset is implemented).
 */
export default function SculptToolsPanel({
  brushType, onBrushTypeChange,
  size, sizeMin = 0.001, sizeMax = 1, sizeStep = 0.001, onSizeChange,
  strength, onStrengthChange,
  hardness, onHardnessChange,
  spacing, onSpacingChange,
  direction, onDirectionChange,
  frontFacesOnly, onFrontFacesOnlyChange,
  symmetry, onSymmetryChange,
  steadyStroke, onSteadyStrokeChange,
  autoSmooth, onAutoSmoothChange,
  enabledBrushes,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  // Optional textured-falloff stamp.
  stampSource,
  onStampSourceChange,
  stampAsset,
  onPickStampAsset,
  stampFile,
  onStampFileChange,
  stampRotation,
  onStampRotationChange,
  stampFileInputRef,
  disabled
}) {
  const isBrushEnabled = (id) => !enabledBrushes || enabledBrushes.includes(id)

  return (
    <>
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Brush</span>
        <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
          {BRUSHES.map(b => {
            const enabled = isBrushEnabled(b.id)
            return (
              <button
                key={b.id}
                type="button"
                className={`mesh-editor-icon-btn ${brushType === b.id ? 'mesh-editor-icon-btn--active' : ''}`}
                onClick={() => onBrushTypeChange(b.id)}
                disabled={disabled || !enabled}
                title={enabled ? b.label : `${b.label} — coming soon`}
              >
                <span className="material-symbols-outlined">{b.icon}</span>
                <span>{b.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Settings</span>
        <label className="mesh-editor-range-field">
          <span>Size</span>
          <input type="range" min={sizeMin} max={sizeMax} step={sizeStep} value={size}
            onChange={e => onSizeChange(Number(e.target.value))} disabled={disabled} />
          <strong>{size.toFixed(3)}</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Strength</span>
          <input type="range" min="0" max="1" step="0.01" value={strength}
            onChange={e => onStrengthChange(Number(e.target.value))} disabled={disabled} />
          <strong>{strength.toFixed(2)}</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Hardness</span>
          <input type="range" min="0" max="1" step="0.01" value={hardness}
            onChange={e => onHardnessChange(Number(e.target.value))} disabled={disabled} />
          <strong>{hardness.toFixed(2)}</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Spacing</span>
          <input type="range" min="0.05" max="1" step="0.01" value={spacing}
            onChange={e => onSpacingChange(Number(e.target.value))} disabled={disabled} />
          <strong>{spacing.toFixed(2)}</strong>
        </label>
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Deformation</span>
        <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
          <button
            type="button"
            className={`mesh-editor-icon-btn ${direction > 0 ? 'mesh-editor-icon-btn--active' : ''}`}
            onClick={() => onDirectionChange(direction > 0 ? -1 : 1)}
            disabled={disabled}
            title="Direction (Ctrl inverts at runtime)"
          >
            <span className="material-symbols-outlined">{direction > 0 ? 'add' : 'remove'}</span>
            <span>{direction > 0 ? 'Add' : 'Subtract'}</span>
          </button>
          <button
            type="button"
            className={`mesh-editor-icon-btn ${frontFacesOnly ? 'mesh-editor-icon-btn--active' : ''}`}
            onClick={() => onFrontFacesOnlyChange(!frontFacesOnly)}
            disabled={disabled}
            title="Front faces only"
          >
            <span className="material-symbols-outlined">visibility</span>
            <span>Front only</span>
          </button>
        </div>
        <span className="mesh-editor-panel__section-title">Symmetry</span>
        <div className="mesh-editor-icon-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
          {['x', 'y', 'z'].map(axis => (
            <button
              key={axis}
              type="button"
              className={`mesh-editor-icon-btn ${symmetry?.[axis] ? 'mesh-editor-icon-btn--active' : ''}`}
              onClick={() => onSymmetryChange({ ...symmetry, [axis]: !symmetry?.[axis] })}
              disabled={disabled}
              title={`Mirror across ${axis.toUpperCase()} axis`}
            >
              <span style={{ fontWeight: 600 }}>{axis.toUpperCase()}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Stroke</span>
        <label className="mesh-editor-range-field">
          <span>Steady stroke <em className="mesh-editor-range-field__sub">(lazy mouse)</em></span>
          <input type="range" min="0" max="0.95" step="0.01" value={steadyStroke}
            onChange={e => onSteadyStrokeChange(Number(e.target.value))} disabled={disabled} />
          <strong>{steadyStroke.toFixed(2)}</strong>
        </label>
        <label className="mesh-editor-range-field">
          <span>Auto-smooth</span>
          <input type="range" min="0" max="1" step="0.01" value={autoSmooth}
            onChange={e => onAutoSmoothChange(Number(e.target.value))} disabled={disabled} />
          <strong>{autoSmooth.toFixed(2)}</strong>
        </label>
      </div>

      {onStampSourceChange && (
        <div className="mesh-editor-panel__section">
          <span className="mesh-editor-panel__section-title">Stamp shape</span>
          <div className="mesh-editor-workflow-field">
            <span>Source</span>
            <select
              className="mesh-editor-panel__input mesh-editor-panel__select"
              value={stampSource || 'none'}
              onChange={e => onStampSourceChange(e.target.value)}
              disabled={disabled}
            >
              <option value="none">— Spherical falloff —</option>
              <option value="asset">From assets</option>
              <option value="computer">From computer</option>
            </select>
          </div>

          {stampSource === 'asset' && (
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--secondary"
              onClick={onPickStampAsset}
              disabled={disabled}
            >
              <span className="material-symbols-outlined">brush</span>
              {stampAsset ? `Stamp: ${stampAsset.name}` : 'Choose stamp…'}
            </button>
          )}

          {stampSource === 'computer' && (
            <div className="mesh-editor-workflow-field">
              <input
                ref={stampFileInputRef}
                type="file"
                accept="image/*"
                onChange={onStampFileChange}
                disabled={disabled}
              />
              {stampFile && (
                <span className="mesh-editor-panel__hint">{stampFile.name}</span>
              )}
            </div>
          )}

          {stampSource && stampSource !== 'none' && (
            <label className="mesh-editor-range-field">
              <span>Rotation</span>
              <input
                type="range" min="0" max="360" step="1"
                value={stampRotation}
                onChange={e => onStampRotationChange(Number(e.target.value))}
                disabled={disabled}
              />
              <strong>{stampRotation}°</strong>
            </label>
          )}
        </div>
      )}

      {(onUndo || onRedo) && (
        <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
          {onUndo && (
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={onUndo}
              disabled={disabled || !canUndo}
              title="Undo (Ctrl+Z)"
            >
              <span className="material-symbols-outlined">undo</span>
              <span>Undo</span>
            </button>
          )}
          {onRedo && (
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--ghost"
              onClick={onRedo}
              disabled={disabled || !canRedo}
              title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
            >
              <span className="material-symbols-outlined">redo</span>
              <span>Redo</span>
            </button>
          )}
        </div>
      )}

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Left-click drag on the mesh to sculpt.</span>
        <span className="mesh-editor-panel__hint">Hold Ctrl to invert direction · Shift to smooth.</span>
        <span className="mesh-editor-panel__hint">Middle-click drag to orbit.</span>
      </div>
    </>
  )
}
