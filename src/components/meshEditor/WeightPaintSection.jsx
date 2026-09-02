// The "Weight Painting" block of the Auto Rig panel: paint how much of the mesh
// each bone carries, the way Blender's weight paint mode does.
//
// It lives inside the Auto Rig panel rather than in a mode of its own so the
// skeleton overlay and the Skeleton bone tree stay on screen — the bone you are
// painting is chosen over there, and a separate mode would have to grow its own
// copy of both.
//
// Presentational: every value and handler comes from MeshEditorPage. Rendered
// unconditionally by AutoRigToolsPanel and bows out itself when there is no rig,
// so the panel does not have to know the rule.
import { RangeField, ToggleField } from './MeshToolField'

const BRUSHES = [
  { id: 'add', icon: 'add', label: 'Add', title: 'Paint the bone’s weight up toward 1' },
  { id: 'subtract', icon: 'remove', label: 'Subtract', title: 'Paint the bone’s weight down toward 0 (or hold Ctrl with any brush)' },
  { id: 'set', icon: 'target', label: 'Set', title: 'Paint toward the exact target value below' },
  { id: 'blur', icon: 'blur_on', label: 'Blur', title: 'Average the weight with neighbouring vertices — softens a hard crease (or hold Shift)' },
]

export default function WeightPaintSection({
  available = false,
  active = false,
  onToggle,
  boneName = null,
  boneShare = null,
  fallbackName = null,
  brush = 'add',
  onBrushChange,
  size = 0.1,
  sizeRange = { min: 0.001, max: 1 },
  onSizeChange,
  strength = 0.5,
  onStrengthChange,
  hardness = 0.5,
  onHardnessChange,
  target = 1,
  onTargetChange,
  frontOnly = true,
  onFrontOnlyChange,
  connectedOnly = true,
  onConnectedOnlyChange,
  normalize = true,
  onNormalizeChange,
  onFill,
  onClear,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onRevert,
  dirty = false,
}) {
  if (!available) return null

  const hasBone = !!boneName

  return (
    <div className="mesh-editor-panel__section">
      <span className="mesh-editor-panel__section-title">Weight Painting</span>

      <button
        type="button"
        className={`mesh-editor-btn ${active ? 'mesh-editor-btn--primary' : ''}`}
        onClick={() => onToggle(!active)}
        aria-pressed={active}
        title={active
          ? 'Leave weight painting and go back to the normal shaded view'
          : 'Colour the mesh by how much the selected bone moves it, and paint that weight by hand'}
      >
        <span className="material-symbols-outlined">{active ? 'check' : 'brush'}</span>
        <span>{active ? 'Done Painting' : 'Paint Weights'}</span>
      </button>

      {!active ? (
        <span className="mesh-editor-panel__hint">
          Fix what Auto Rig got wrong: paint a bone&apos;s influence on or off the surface directly.
        </span>
      ) : (
        <>
          {/* Which bone the brush writes to. Everything below is meaningless
              without one, so this reads first and the rest is disabled. */}
          <div className={`mesh-editor-weight-bone ${hasBone ? '' : 'mesh-editor-weight-bone--empty'}`}>
            <span className="material-symbols-outlined">{hasBone ? 'target' : 'help'}</span>
            {hasBone ? (
              <span>
                Painting <strong>{boneName}</strong>
                {boneShare != null && <span className="mesh-editor-weight-bone__share"> · {boneShare}</span>}
              </span>
            ) : (
              <span>Pick a bone in the Skeleton list, or click a joint on the mesh — once one is chosen, Alt+click swaps to another.</span>
            )}
          </div>

          <div className="mesh-editor-weight-modes">
            {BRUSHES.map(item => (
              <button
                key={item.id}
                type="button"
                className={`mesh-editor-icon-btn ${brush === item.id ? 'mesh-editor-icon-btn--active' : ''}`}
                onClick={() => onBrushChange(item.id)}
                disabled={!hasBone}
                aria-pressed={brush === item.id}
                title={item.title}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <RangeField label="Radius" min={sizeRange.min} max={sizeRange.max} step={sizeRange.max / 200}
            value={size} onChange={onSizeChange} disabled={!hasBone} decimals={3}
            hint="Brush radius in world units" />
          <RangeField label="Strength" min={0.01} max={1} step={0.01} decimals={2}
            value={strength} onChange={onStrengthChange} disabled={!hasBone}
            hint="How much of the brush's effect each dab applies" />
          <RangeField label="Hardness" min={0} max={1} step={0.01} decimals={2}
            value={hardness} onChange={onHardnessChange} disabled={!hasBone}
            hint="0 = soft bell falloff, 1 = a hard-edged disc" />
          {brush === 'set' && (
            <RangeField label="Target value" min={0} max={1} step={0.01} decimals={2}
              value={target} onChange={onTargetChange} disabled={!hasBone}
              hint="The weight the Set brush paints toward" />
          )}

          <ToggleField label="Front faces only" value={frontOnly} onChange={onFrontOnlyChange}
            disabled={!hasBone}
            hint="Only paint the surface facing you. Off, the brush reaches through a limb and paints its far side too." />
          {/* The brush radius is a ball in space, not a disc on the surface, so
              without this a dab also lands on whatever else happens to be
              inside it — the other leg, the torso behind an arm — which reads
              as the stroke appearing somewhere you did not paint. */}
          <ToggleField label="Only connected surface" value={connectedOnly} onChange={onConnectedOnlyChange}
            disabled={!hasBone}
            hint="Keep the brush on the piece of surface under the cursor. Turn off only to paint through to a separate part that sits inside the brush." />
          <ToggleField label="Auto-normalize" value={normalize} onChange={onNormalizeChange}
            disabled={!hasBone}
            hint="Keep every painted vertex's weights summing to 1 by rescaling its other bones. Leave on unless you know why not." />

          {/* Red is 1, blue is barely-there. Grey is the one that needs
              explaining: the bone does not move those vertices at all. glTF
              cannot store an explicit zero, so grey and "weight 0" are the same
              state — see readBoneWeights in utils/meshWeightPaint.js. */}
          <div className="mesh-editor-weight-legend" aria-hidden="true">
            <span className="mesh-editor-weight-legend__ramp" />
            <span className="mesh-editor-weight-legend__labels">
              <span>0</span><span>0.5</span><span>1</span>
            </span>
          </div>
          <span className="mesh-editor-panel__hint">
            Grey is the part of the mesh this bone does not move at all; the coloured part is what it
            carries. Ctrl subtracts, Shift blurs.
          </span>
          {/* Where the weight goes matters here: on a vertex this bone owns
              outright there is no other influence to absorb what you take away,
              and a vertex that sums to less than 1 collapses toward the origin
              once the rig is posed. */}
          {hasBone && (
            <span className="mesh-editor-panel__hint">
              {fallbackName
                ? <>Weight taken off a vertex only this bone holds passes to <strong>{fallbackName}</strong>.</>
                : 'This is a root bone, so weight taken off a vertex nothing else holds has nowhere to go — those vertices stay at 1. Paint the child bone instead, or turn Auto-normalize off.'}
            </span>
          )}

          <div className="mesh-editor-icon-grid mesh-editor-icon-grid--double">
            <button
              type="button"
              className="mesh-editor-btn"
              onClick={onFill}
              disabled={!hasBone}
              title="Give this bone full influence over every vertex in the mesh"
            >
              <span className="material-symbols-outlined">format_color_fill</span>
              <span>Fill bone</span>
            </button>
            <button
              type="button"
              className="mesh-editor-btn"
              onClick={onClear}
              disabled={!hasBone}
              title="Remove this bone's influence from the whole mesh, giving its share back to the other bones"
            >
              <span className="material-symbols-outlined">ink_eraser</span>
              <span>Clear bone</span>
            </button>
          </div>

          {/* The same history the Skeleton panel's bone edits use — one rig
              session covers both, so a stroke and a moved joint undo in order. */}
          <div className="mesh-editor-bone-edit__bar">
            <button
              type="button"
              className="mesh-editor-bone-edit__icon-btn"
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo the last rig edit"
            >
              <span className="material-symbols-outlined">undo</span>
            </button>
            <button
              type="button"
              className="mesh-editor-bone-edit__icon-btn"
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo"
            >
              <span className="material-symbols-outlined">redo</span>
            </button>
            <button
              type="button"
              className="mesh-editor-bone-edit__icon-btn mesh-editor-bone-edit__icon-btn--wide"
              onClick={onRevert}
              disabled={!dirty}
              title="Put every weight and bone back the way it was when you started editing"
            >
              <span className="material-symbols-outlined">restart_alt</span>
              <span>Revert</span>
            </button>
            {dirty && (
              <span className="mesh-editor-bone-edit__dirty" title="The rig has unsaved edits">
                edited
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
