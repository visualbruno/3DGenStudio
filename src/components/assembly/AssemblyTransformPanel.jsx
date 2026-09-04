// Numeric placement and the alignment actions for the selected piece.
//
// Presentational: every change leaves through a callback. The geometry lives in
// utils/assemblyGeometry.js so it stays testable without React.
import { useState } from 'react'
import { FIT_REGIONS, FIT_REGION_LABELS } from '../../utils/assemblyGeometry'

const DEG = 180 / Math.PI
const AXES = ['X', 'Y', 'Z']

// Rotation is stored in RADIANS (three's unit, so composing a matrix needs no
// conversion) and shown in degrees. Converting only at this edge keeps a round
// trip through the field lossless.
const toDegrees = radians => Math.round(radians * DEG * 100) / 100
const toRadians = degrees => degrees / DEG

function NumberRow({ label, values, step, onChange, format = value => value, disabled }) {
  return (
    <div className="assembly-tp__row">
      <span className="assembly-tp__label">{label}</span>
      {values.map((value, index) => (
        <label key={AXES[index]} className="assembly-tp__field">
          <span className="assembly-tp__axis">{AXES[index]}</span>
          <input
            type="number"
            step={step}
            value={format(value)}
            disabled={disabled}
            onChange={event => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) onChange(index, next)
            }}
          />
        </label>
      ))}
    </div>
  )
}

export default function AssemblyTransformPanel({
  piece,
  isBase,
  stats,
  scaleRatio,
  worldSize,
  positionStep,
  hasBase,
  onCommit,
  onFitToRegion,
  onMoveToRegion,
  onDropToSurface,
  onMirror,
  onDuplicate,
  onReset,
  onCopyTransform,
  onPasteTransform,
  canPaste,
}) {
  const [uniformScale, setUniformScale] = useState(true)
  const [fitAxes, setFitAxes] = useState('uniform')

  if (!piece) {
    return (
      <div className="assembly-tp assembly-tp--empty">
        Select a piece to place it.
      </div>
    )
  }

  const setPosition = (index, value) => {
    const position = [...piece.position]
    position[index] = value
    onCommit({ position })
  }

  const setRotation = (index, degrees) => {
    const rotation = [...piece.rotation]
    rotation[index] = toRadians(degrees)
    onCommit({ rotation })
  }

  const setScale = (index, value) => {
    // A zero scale makes the piece's matrix singular — it collapses to a plane,
    // stops being pickable, and cannot be dragged back. The document clamps this
    // too; refusing it here means the field never shows a value that was
    // silently altered.
    if (Math.abs(value) < 1e-6) return

    if (!uniformScale) {
      const scale = [...piece.scale]
      scale[index] = value
      onCommit({ scale })
      return
    }
    // Locked: preserve the piece's proportions by applying the same RATIO to
    // every axis, rather than setting them all equal — which would flatten a
    // deliberately non-uniform piece the moment one field was touched.
    const previous = piece.scale[index]
    if (Math.abs(previous) < 1e-9) return
    const factor = value / previous
    onCommit({ scale: piece.scale.map(component => component * factor) })
  }

  const regionDisabled = !hasBase || isBase

  return (
    <div className="assembly-tp">
      <div className="assembly-tp__header">
        <span className="assembly-tp__title" title={piece.name}>{piece.name}</span>
        {isBase && <span className="assembly-piece__badge">BASE</span>}
      </div>

      <NumberRow
        label="Position"
        values={piece.position}
        step={positionStep}
        onChange={setPosition}
      />
      <NumberRow
        label="Rotation"
        values={piece.rotation}
        step={1}
        format={toDegrees}
        onChange={setRotation}
      />
      <NumberRow
        label="Scale"
        values={piece.scale}
        step={0.01}
        onChange={setScale}
      />

      <label className="assembly-tp__check">
        <input
          type="checkbox"
          checked={uniformScale}
          onChange={event => setUniformScale(event.target.checked)}
        />
        Uniform scale
      </label>

      {/* ---- Alignment ---- */}
      {!isBase && (
        <>
          <div className="assembly-tp__section">Align to base</div>

          {regionDisabled ? (
            <p className="assembly-tp__note">Add a base mesh to align against.</p>
          ) : (
            <>
              <div className="assembly-tp__region">
                <select
                  value={piece.fitRegion}
                  onChange={event => onCommit({ fitRegion: event.target.value })}
                >
                  {FIT_REGIONS.map(region => (
                    <option key={region} value={region}>{FIT_REGION_LABELS[region]}</option>
                  ))}
                </select>
                <select value={fitAxes} onChange={event => setFitAxes(event.target.value)}>
                  <option value="uniform">Keep proportions</option>
                  <option value="xyz">Stretch to fill</option>
                </select>
              </div>

              <div className="assembly-tp__actions">
                <button type="button" onClick={() => onFitToRegion(fitAxes)}>
                  Fit to region
                </button>
                <button type="button" onClick={onMoveToRegion} title="Move only, keep the current size">
                  Move only
                </button>
              </div>

              {/* Fractional bands of the base's bounding box, not anatomy
                  detection — see baseRegionBox. Said plainly here because the
                  result is a starting point, not an answer. */}
              <p className="assembly-tp__note">
                Regions are fractions of the base&apos;s bounds (assumes an upright,
                A- or T-posed body). Expect to nudge the result.
              </p>

              <div className="assembly-tp__actions">
                <button type="button" onClick={onDropToSurface}>Drop to surface</button>
                <button type="button" onClick={onMirror} title="Mirror across the base's centre">
                  Mirror X
                </button>
              </div>
            </>
          )}
        </>
      )}

      <div className="assembly-tp__section">Piece</div>
      <div className="assembly-tp__actions">
        <button type="button" onClick={() => onDuplicate({ mirrored: false })}>Duplicate</button>
        {/* The highest-value single button here: a boot/gauntlet pair in one
            click, which is otherwise a manual mirror plus a reposition. */}
        <button
          type="button"
          onClick={() => onDuplicate({ mirrored: true })}
          disabled={!hasBase}
          title="Clone, mirrored across the base's centre — for a left/right pair"
        >
          Duplicate mirrored
        </button>
      </div>
      <div className="assembly-tp__actions">
        <button type="button" onClick={onCopyTransform}>Copy transform</button>
        <button type="button" onClick={onPasteTransform} disabled={!canPaste}>Paste</button>
        <button type="button" onClick={onReset}>Reset</button>
      </div>

      <div className="assembly-tp__section">Measurements</div>
      <dl className="assembly-tp__stats">
        {stats && (
          <>
            <dt>Vertices</dt><dd>{stats.vertexCount.toLocaleString()}</dd>
            <dt>Faces</dt><dd>{stats.faceCount.toLocaleString()}</dd>
          </>
        )}
        {worldSize && (
          <>
            <dt>World size</dt>
            <dd>
              {worldSize.map(component => component.toPrecision(3)).join(' x ')}
            </dd>
          </>
        )}
        {scaleRatio != null && (
          <>
            <dt>Vs base</dt>
            <dd className={scaleRatio < 0.5 || scaleRatio > 2 ? 'assembly-tp__warn' : ''}>
              {scaleRatio < 0.01 || scaleRatio > 100
                ? `${scaleRatio.toExponential(2)}x`
                : `${scaleRatio.toFixed(3)}x`}
            </dd>
          </>
        )}
        {stats?.hasSkin && (
          <>
            <dt>Rig</dt><dd>skinned</dd>
          </>
        )}
      </dl>
    </div>
  )
}
