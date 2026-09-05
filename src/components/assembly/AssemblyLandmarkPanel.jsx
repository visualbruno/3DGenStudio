// Placing and reviewing landmark pairs for the warp stage.
//
// The panel's real job is making the gate legible. A thin-plate spline needs at
// least four non-coplanar pairs, and below that the warp cannot run at all —
// so the count and what it unlocks are stated up front rather than left for a
// Python error to explain after the user has pressed Fit.
import { LANDMARK_MODES } from '../../hooks/useAssemblyLandmarks'
import { MIN_WARP_LANDMARKS, completeLandmarks } from '../../utils/assemblyHelpers'

export default function AssemblyLandmarkPanel({
  piece,
  baseName,
  mode,
  active,
  onStart,
  onStop,
  onRemove,
  onClear,
  onHover,
}) {
  if (!piece) return null

  const pairs = piece.landmarks || []
  const ready = completeLandmarks(piece).length
  const short = Math.max(0, MIN_WARP_LANDMARKS - ready)

  return (
    <section className="assembly-panel assembly-landmarks">
      <h3>LANDMARKS</h3>

      <p className="assembly-landmarks__intro">
        Pairs of points saying <em>this goes here</em>. The only thing that can correct
        proportions — a sleeve cut for a longer arm, a cuirass built for a taller
        torso. Nothing else in the fit knows which part of the piece belongs where.
      </p>

      {active ? (
        <>
          <div className={`assembly-landmarks__prompt assembly-landmarks__prompt--${
            mode === LANDMARK_MODES.BASE ? 'base' : 'piece'}`}
          >
            {mode === LANDMARK_MODES.BASE
              ? <>Click a point on <strong>{baseName || 'the body'}</strong></>
              : <>Now click the matching point on <strong>{piece.name}</strong></>}
          </div>
          <button type="button" className="assembly-landmarks__stop" onClick={onStop}>
            Done placing <span className="assembly-landmarks__hint">(Esc)</span>
          </button>
        </>
      ) : (
        <button type="button" className="assembly-landmarks__start" onClick={onStart}>
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>add_location_alt</span>
          Place pairs
        </button>
      )}

      {pairs.length > 0 && (
        <ul className="assembly-landmarks__list">
          {pairs.map((pair, index) => {
            const complete = !!(pair.base && pair.piece)
            return (
              <li
                key={pair.id}
                className={complete ? '' : 'assembly-landmarks__row--partial'}
                onMouseEnter={() => onHover?.(pair.id)}
                onMouseLeave={() => onHover?.(null)}
              >
                <span className="assembly-landmarks__index">#{index + 1}</span>
                <span className="assembly-landmarks__label">
                  {complete
                    ? `${baseName || 'Body'} → ${piece.name}`
                    : 'incomplete — will be ignored'}
                </span>
                <button type="button" title="Remove this pair"
                        onClick={() => onRemove(pair.id)}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className={`assembly-landmarks__gate ${short ? '' : 'assembly-landmarks__gate--ok'}`}>
        {short
          ? `${ready} of ${MIN_WARP_LANDMARKS} pairs — ${short} more before the warp can run.`
          : `${ready} pairs placed. Turn on "Match the landmarks" to use them.`}
      </div>

      {/* Shown from the start, not once the gate is met: how the pairs are
          ARRANGED matters far more than how many there are, and finding that
          out from a refusal after placing four is the wrong order. */}
      <p className="assembly-landmarks__note">
        Spread them out — the arrangement matters more than the count. Pairs strung
        along the piece in a line, or all on one face, cannot describe a 3D
        deformation: the warp then swings wildly in the direction they do not
        cover, and the fit refuses rather than mangling the piece. Aim for front,
        back and both sides, and cover its full length.
      </p>

      {pairs.length > 0 && (
        <button type="button" className="assembly-landmarks__clear" onClick={onClear}>
          Clear all
        </button>
      )}
    </section>
  )
}
