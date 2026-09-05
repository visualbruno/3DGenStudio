// The fit controls for the selected piece: material class, stages, knobs, run,
// and the before/after toggle.
//
// Presentational — every action leaves through a callback.
import { MATERIAL_CLASS_LABELS, MATERIAL_CLASSES } from '../../utils/assemblyHelpers'
import { FIT_STAGE_HINTS, FIT_STAGE_LABELS } from '../../utils/assemblyFit'
import { MIN_WARP_LANDMARKS, completeLandmarks } from '../../utils/assemblyHelpers'

const MATERIAL_CLASS_HINTS = {
  rigid: 'Plate armour, pauldrons, helms. Moves the piece out of the body as one solid '
    + 'object, then pushes out whatever still clips, with a generous clearance and no '
    + 'reshaping.',
  soft: 'Cloth, chainmail, anything close-fitting. Same, with a tight clearance and more '
    + 'smoothing so it sits snug.',
  custom: 'Your own stage and value choices.',
}

// Conform is opt-in and warned rather than a default. On a real armour it loses
// most of the piece's thickness and inverts faces — see the note above
// MATERIAL_CLASS_PRESETS in utils/assemblyHelpers.js for the measurements.
const STAGE_WARNINGS = {
  shrinkwrap: 'Experimental. Reshapes the piece to the body, but on a thick piece it '
    + 'currently flattens it and can invert faces. Try it on a copy.',
}

function Knob({ label, value, step, min, max, hint, onChange }) {
  return (
    <label className="assembly-fit__knob" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={event => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
    </label>
  )
}

export default function AssemblyFitPanel({
  piece,
  isBase,
  hasBase,
  hasPreview,
  showingFitted,
  running,
  progress,
  error,
  onClearError,
  onSetMaterialClass,
  onPatchPiece,
  onRun,
  onRunAll,
  onCancel,
  onRevert,
  onToggleFitted,
  garmentCount,
}) {
  if (!hasBase) {
    return <div className="assembly-fit assembly-fit--empty">Add a base mesh to fit against.</div>
  }
  if (!piece || isBase) {
    return (
      <div className="assembly-fit assembly-fit--empty">
        Select a piece to fit it onto the base.
        {garmentCount > 0 && (
          <button type="button" className="assembly-fit__run" disabled={!!running} onClick={onRunAll}>
            Fit all {garmentCount} piece{garmentCount === 1 ? '' : 's'}
          </button>
        )}
      </div>
    )
  }

  const isRunningThis = running?.pieceId === piece.id
  const stages = piece.fitStages || {}
  const options = piece.fitOptions || {}

  // Touching any individual control makes the piece 'custom': the class is a
  // preset that WROTE these values, so once they diverge, continuing to show a
  // class would be a lie about what will run.
  const patchStage = (stage, enabled) => onPatchPiece(piece.id, {
    materialClass: 'custom',
    fitStages: { ...stages, [stage]: enabled },
  })
  const patchOption = (key, value) => onPatchPiece(piece.id, {
    materialClass: 'custom',
    fitOptions: { ...options, [key]: value },
  })

  const noStages = !stages.rigid && !stages.warp && !stages.shrinkwrap && !stages.penetration
  // The warp needs pairs before it can do anything, so the checkbox says so
  // rather than letting the user enable a stage that will be dropped.
  const pairs = completeLandmarks(piece).length
  const warpReady = pairs >= MIN_WARP_LANDMARKS

  return (
    <div className="assembly-fit">
      <div className="assembly-fit__section">Fit to base</div>

      <div className="assembly-fit__classes">
        {MATERIAL_CLASSES.map(className => (
          <button
            key={className}
            type="button"
            className={`assembly-fit__class ${piece.materialClass === className ? 'assembly-fit__class--on' : ''}`}
            title={MATERIAL_CLASS_HINTS[className]}
            onClick={() => onSetMaterialClass(piece.id, className)}
          >
            {MATERIAL_CLASS_LABELS[className]}
          </button>
        ))}
      </div>
      <p className="assembly-fit__hint">{MATERIAL_CLASS_HINTS[piece.materialClass]}</p>

      {/* Pipeline order: seat the piece, then reshape it, then clean up what
          is still inside. Listing them in the order they run makes the chain
          legible; the two-call split behind it is an implementation detail. */}
      {['rigid', 'warp', 'shrinkwrap', 'penetration'].map(stage => (
        <label key={stage} className="assembly-fit__stage" title={FIT_STAGE_HINTS[stage]}>
          <input
            type="checkbox"
            checked={!!stages[stage]}
            onChange={event => patchStage(stage, event.target.checked)}
          />
          {FIT_STAGE_LABELS[stage]}
          {STAGE_WARNINGS[stage] && <span className="assembly-fit__tag">experimental</span>}
          {stage === 'warp' && (
            <span className={`assembly-fit__tag ${warpReady ? '' : 'assembly-fit__tag--warn'}`}>
              {pairs}/{MIN_WARP_LANDMARKS} pairs
            </span>
          )}
        </label>
      ))}
      {stages.shrinkwrap && (
        <p className="assembly-fit__warn">{STAGE_WARNINGS.shrinkwrap}</p>
      )}
      {stages.warp && !warpReady && (
        /* Enabled but under-supplied. The stage is DROPPED rather than failing
           the run, so without this the fit would quietly do less than asked. */
        <p className="assembly-fit__warn">
          Not enough landmark pairs yet — place {MIN_WARP_LANDMARKS - pairs} more in the
          Landmarks panel, or this stage is skipped.
        </p>
      )}

      <div className="assembly-fit__knobs">
        <Knob
          label="Clearance" value={options.offset ?? 0.004} step={0.001} min={0} max={1}
          hint="Gap left between the piece and the body, in world units. Not zero: a piece sitting exactly on the surface z-fights with it."
          onChange={value => patchOption('offset', value)}
        />
        <Knob
          label="Smoothing" value={options.smooth_rounds ?? 2} step={1} min={0} max={20}
          hint="Rounds of smoothing applied to the displacement field. Removes zigzag along creases; too much stalls narrow penetrations."
          onChange={value => patchOption('smooth_rounds', value)}
        />
        {stages.shrinkwrap && (
          <Knob
            label="Min shell" value={options.min_thickness ?? 0} step={0.0005} min={0} max={0.05}
            hint="Stop the reshape before the piece's own inner and outer surfaces get this close. Prevents the lining flickering through the outside — but on a thin piece it also stops the reshape doing much. 0 = off."
            onChange={value => patchOption('min_thickness', value)}
          />
        )}
        {stages.shrinkwrap && (
          <Knob
            label="Strength" value={options.strength ?? 1} step={0.1} min={0} max={1}
            hint="How far the reshape goes, 0 to 1. A partial reshape often looks better: the piece takes the body's shape without being pulled tight into armpits and creases, where triangles start to invert."
            onChange={value => patchOption('strength', value)}
          />
        )}
      </div>

      {noStages && <p className="assembly-fit__warn">No stages selected — nothing would happen.</p>}

      <div className="assembly-fit__actions">
        {isRunningThis || (running && running.total > 1) ? (
          <button type="button" className="assembly-fit__run" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="assembly-fit__run"
            disabled={!!running || noStages}
            onClick={() => onRun([piece.id])}
          >
            Fit this piece
          </button>
        )}
        {garmentCount > 1 && (
          <button type="button" disabled={!!running} onClick={onRunAll}>
            Fit all {garmentCount}
          </button>
        )}
      </div>

      {running && (
        <div className="assembly-fit__progress">
          <div className="assembly-fit__bar">
            <span style={{ width: `${Math.round((progress.frac || 0) * 100)}%` }} />
          </div>
          <span className="assembly-fit__progress-text">
            {running.total > 1 && `${running.index + 1}/${running.total} · `}
            {progress.message || 'Working…'}
          </span>
          {/* An in-flight request cannot be recalled once the service has it:
              cancelling stops the queue and abandons the current result. Said
              plainly rather than implying the work stops. */}
          <span className="assembly-fit__hint">
            Cancelling stops the queue; work already sent to the service is abandoned.
          </span>
        </div>
      )}

      {error && (
        <div className="assembly-fit__error" onClick={onClearError} role="button" tabIndex={0}>
          {error}
        </div>
      )}

      {hasPreview && (
        <>
          <div className="assembly-fit__section">Result</div>
          <p className="assembly-fit__result">{piece.fit?.message}</p>
          {piece.fit?.stats?.bodyWatertight === false && (
            // Worth saying: on a non-watertight body the inside/outside test is
            // a vote rather than a certainty, so a poor result may be the base's
            // topology rather than the fit's settings.
            <p className="assembly-fit__hint">
              The base is not watertight, so inside/outside detection is approximate.
              Running Repair on it in the Mesh Editor gives the fit more to work with.
            </p>
          )}
          {piece.fit?.stats?.surfacesTouching && (
            // Names the cause of the flicker. Without this the artifact looks
            // like a texture or mipmap problem and gets chased in the wrong place.
            <p className="assembly-fit__warn">
              The piece&apos;s own inner and outer surfaces are now touching in places.
              That is what makes the lining flicker through the outside — it is
              geometry, not a texture problem. Raise “Min shell” to prevent it,
              at the cost of a looser fit.
            </p>
          )}
          {piece.fit?.stats?.stoppedOnInversion && (
            <p className="assembly-fit__hint">
              The reshape stopped early because it was starting to turn triangles
              inside out — this is the last good state, not a failure. Lower
              Strength to trade tightness for a cleaner surface.
            </p>
          )}
          {piece.fit?.stats?.converged === false && !piece.fit?.stats?.stoppedOnInversion && (
            <p className="assembly-fit__hint">
              Stopped at the iteration limit rather than settling — re-running may
              take it further.
            </p>
          )}
          <div className="assembly-fit__actions">
            <button type="button" onClick={() => onToggleFitted(piece.id)}>
              {showingFitted ? 'Show original' : 'Show fitted'}
            </button>
            <button type="button" onClick={() => onRevert(piece.id)}>Discard fit</button>
          </div>
          <p className="assembly-fit__hint">
            Nothing is saved yet — the fitted shape lives in this session until you save it.
          </p>
        </>
      )}
    </div>
  )
}
