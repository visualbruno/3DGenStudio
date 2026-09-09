// Why is the preview empty?
//
// A PURE DECISION TABLE, deliberately separated from the overlay that shows it.
// The hard part here is not the rendering, it is choosing WHICH cause to name,
// and that choice is a set of rules that can be checked against a table of
// inputs rather than by staring at a viewport.
//
// CAUSAL ORDER, NOT SEVERITY ORDER. An effect with no Spawn block also has
// nothing to draw and nothing to update, so all three complaints are true and
// only the first is useful. Naming a downstream symptom sends the author to fix
// something that was never broken. So the table walks the pipeline: is anything
// emitted -> is anything alive -> is anything written -> can the camera see it.
//
// THE TRAP THIS EXISTS FOR is conflating "nothing is being produced" with
// "particles exist but the camera cannot see them". They look identical - an
// empty viewport - and their fixes are opposites: one is a graph edit, the other
// is pressing a button to frame the effect. An overlay that said "no particles"
// when there were sixty thousand of them just off screen would be worse than
// silence, because the author would go and edit a working graph.
//
// EVERY ANSWER CARRIES AN ACTION, and the action is either a diagnostic's own
// fix descriptor (so it lands as one ordinary undo entry) or one of the two
// UI-only verbs the caller understands: `frame` and `play`.

/** Actions the caller has to implement itself, having no document edit. */
export const BLAME_ACTION = Object.freeze({
  /** Re-frame the camera on the effect's bounds. */
  FRAME: 'frame',
  /** Start the transport. */
  PLAY: 'play',
  /** Restart from t = 0. */
  RESTART: 'restart',
  /** Un-mute or un-solo, so the muted systems contribute again. */
  UNMUTE: 'unmute',
})

/**
 * @typedef {Object} VfxBlame
 * @property {string} code stable id, for tests and telemetry
 * @property {string} title one line, what is wrong
 * @property {string} message what to do about it
 * @property {Object|null} fix a diagnostic fix descriptor, if one applies
 * @property {string|null} action a BLAME_ACTION, if the fix is a UI verb
 * @property {string|null} actionLabel button text for `action`
 */

/**
 * Name the first render-blocking cause, in causal order.
 *
 * @param {Object} input
 * @param {Array<Object>} input.diagnostics compile diagnostics
 * @param {number} input.spawned particles emitted since the last reset
 * @param {number} input.alive particles currently alive
 * @param {number} input.drawn instances written to the GPU last frame
 * @param {boolean} input.playing whether the transport is running
 * @param {boolean} input.finished whether a non-looping effect has ended
 * @param {number} input.mutedSystems how many systems are silenced
 * @param {number} input.totalSystems
 * @param {boolean|null} input.onScreen whether the live bounds intersect the
 *   camera frustum; null when it could not be determined
 * @returns {VfxBlame|null} null when there is nothing to explain
 */
export function diagnoseEmptyPreview(input) {
  const {
    diagnostics = [],
    spawned = 0,
    alive = 0,
    drawn = 0,
    playing = true,
    finished = false,
    mutedSystems = 0,
    totalSystems = 1,
    onScreen = null,
  } = input || {}

  // 1. A compile error. It is upstream of everything below, so it is named
  //    first even when the symptom the author sees is "nothing is drawn".
  const error = diagnostics.find(entry => entry.severity === 'error')
  if (error) {
    return {
      code: error.code,
      title: error.title,
      message: error.hint ? `${error.message} ${error.hint}` : error.message,
      fix: error.fix || null,
      action: null,
      actionLabel: null,
    }
  }

  // 2. Every system silenced. Checked before "nothing was emitted", because it
  //    IS why nothing was emitted, and because it is the author's own doing -
  //    a solo they forgot to turn off is a genuinely common way to lose an
  //    afternoon.
  if (totalSystems > 0 && mutedSystems >= totalSystems) {
    return {
      code: 'B_ALL_MUTED',
      title: 'Every system is silenced',
      message: 'Mute or solo is on for all of them, so nothing is emitting. That is a preview setting - it is not saved with the effect.',
      fix: null,
      action: BLAME_ACTION.UNMUTE,
      actionLabel: 'Un-mute everything',
    }
  }

  // 3. Nothing emitted at all.
  if (spawned === 0) {
    if (!playing) {
      return {
        code: 'B_PAUSED_AT_START',
        title: 'The effect has not started',
        message: 'It is paused at the beginning, so nothing has been emitted yet.',
        fix: null,
        action: BLAME_ACTION.PLAY,
        actionLabel: 'Play',
      }
    }
    // The graph compiled and the transport is running, so the spawn windows are
    // the remaining explanation: a clip that starts later, or one that has
    // already passed on a non-looping effect.
    return {
      code: 'B_NO_SPAWN_YET',
      title: 'Nothing has been emitted',
      message: 'The timeline clips control when each system emits. Check that a clip covers the current time, or drag one to the start.',
      fix: null,
      action: BLAME_ACTION.RESTART,
      actionLabel: 'Restart',
    }
  }

  // 4. Emitted, but nothing is alive any more.
  if (alive === 0) {
    if (finished) {
      return {
        code: 'B_FINISHED',
        title: 'The effect has finished',
        message: 'Every particle has died and the effect does not loop. Turn on "Loop effect" in the timeline, or restart it.',
        fix: null,
        action: BLAME_ACTION.RESTART,
        actionLabel: 'Restart',
      }
    }
    return {
      code: 'B_ALL_DEAD',
      title: 'Every particle has already died',
      message: 'They were emitted and their lifetime ran out. A longer Set Lifetime, or a clip that keeps emitting, would keep something on screen.',
      fix: null,
      action: BLAME_ACTION.RESTART,
      actionLabel: 'Restart',
    }
  }

  // 5. Alive, but nothing reached the GPU. The write loop skips a particle with
  //    no size, so this is almost always a size of zero - which is also what an
  //    over-life size curve ending at zero looks like a fraction too early.
  if (drawn === 0) {
    return {
      code: 'B_NOTHING_WRITTEN',
      title: 'The particles have no size',
      message: `${alive} particles are alive but none were drawn. A size of zero - or a size-over-life curve that reaches zero - makes them invisible without making them dead.`,
      fix: null,
      action: null,
      actionLabel: null,
    }
  }

  // 6. Drawn, but off camera. THE ONE THIS MODULE EXISTS FOR - it looks
  //    identical to every case above and its fix is the opposite of theirs.
  if (onScreen === false) {
    return {
      code: 'B_OFF_SCREEN',
      title: 'The effect is off screen',
      message: `${drawn} particles are being drawn, just not where the camera is looking. Nothing is wrong with the graph.`,
      fix: null,
      action: BLAME_ACTION.FRAME,
      actionLabel: 'Frame the effect',
    }
  }

  // Something is being drawn, in view. Anything still invisible from here is a
  // blending or colour judgement, which the diagnostics strip covers and an
  // overlay would only guess at.
  return null
}
