// The arithmetic behind dragging a timeline clip.
//
// EXTRACTED FROM THE COMPONENT because it is arithmetic, and because it was
// wrong in a way no amount of looking at the component could settle. A clip
// dragged sideways was arriving truncated to a sliver, and the three candidate
// causes - the preview write, the commit, the CSS - are indistinguishable from
// a screenshot. Pure functions can be checked against numbers.
//
// EACH MODE OWNS EXACTLY ONE THING, and that is the fix:
//
//   move  -> `at` only.        The duration cannot change by sliding a clip.
//   end   -> `duration` only.  The start cannot move by dragging the far edge.
//   start -> both, together.   Trimming the front moves `at` and shortens
//                              `duration` by the same amount so the END stays
//                              put; dragging the left edge and watching the
//                              right edge move is the classic timeline
//                              annoyance.
//
// The bug was that the drag committed `{at, duration}` for EVERY mode, taking
// the duration from its preview state. For a move that is at best a no-op and
// at worst - if the preview's length is stale, absent, or was never updated -
// it writes a duration the author never asked for and the clip collapses. A
// patch that only carries the fields its gesture owns cannot do that, whatever
// else is wrong.

/**
 * Round to a multiple of the simulation step, which is what the compiler does.
 *
 * Snapping HERE as well as in the compiler is what makes the number the author
 * sees the number that runs. A UI that let them place a clip at 0.333 and then
 * silently played it at 0.3333 would make the preview disagree with the
 * timeline for no visible reason.
 *
 * @param {number} seconds
 * @param {number} step
 * @returns {number}
 */
export function snapToStep(seconds, step) {
  if (!(step > 0)) return Math.max(0, seconds);
  return Math.max(0, Math.round(seconds / step) * step);
}

/**
 * @typedef {Object} VfxClipDragState
 * @property {'move'|'start'|'end'} mode
 * @property {number} baseAt where the clip started, in seconds
 * @property {number} baseDuration how long it was, in seconds
 * @property {number} duration the EFFECT's duration, for clamping
 * @property {number} step the simulation step
 */

/**
 * Where a clip lands, given a drag.
 *
 * @param {VfxClipDragState} drag captured at pointer-down and never mutated
 * @param {number} deltaSeconds pointer travel converted to seconds
 * @param {{free?: boolean}} [options] `free` skips the step grid (Shift)
 * @returns {{at: number, duration: number, patch: Object}} the resolved
 *   geometry, plus the patch to commit - which carries ONLY the fields this
 *   gesture owns.
 */
export function resolveClipDrag(drag, deltaSeconds, options = {}) {
  const { mode, baseAt, baseDuration, duration, step } = drag;
  const quantize = (value) => (
    options.free ? Math.max(0, value) : snapToStep(value, step)
  );

  if (mode === 'end') {
    // The far edge. Never negative, and never so short that the clip becomes a
    // burst by accident - a burst is a deliberate choice (drag it to zero on
    // purpose, or add one), not something a clumsy trim should produce.
    const next = Math.max(0, quantize(baseDuration + deltaSeconds));
    return { at: baseAt, duration: next, patch: { duration: next } };
  }

  if (mode === 'start') {
    // Clamped to the clip's own end, so trimming past it produces a
    // zero-length clip rather than a negative one that would render inverted.
    const at = Math.min(
      Math.max(0, quantize(baseAt + deltaSeconds)),
      baseAt + baseDuration,
    );
    const next = baseAt + baseDuration - at;
    return { at, duration: next, patch: { at, duration: next } };
  }

  // move. `duration` is returned so the caller can position the preview, but
  // it is deliberately ABSENT from the patch - see the header.
  //
  // Clamped so the clip's END cannot leave the effect. A burst has no length,
  // so it may sit anywhere up to the very end.
  const limit = Math.max(0, duration - baseDuration);
  const at = Math.min(Math.max(0, quantize(baseAt + deltaSeconds)), limit);
  return { at, duration: baseDuration, patch: { at } };
}

/**
 * The narrowest clip that can still show both trim handles.
 *
 * THE HANDLES USED TO EAT THE WHOLE CLIP. Two 5px handles against a
 * 10px minimum width left a body of exactly zero, so a minimum-width clip could
 * never be moved - every press landed on a trim handle. At 8px each they need
 * room for themselves plus something grabbable between them, and below that the
 * MOVE wins: a clip you cannot reposition is worse than one you have to widen
 * before you can trim it.
 *
 * Exported so the rule is checkable rather than a number in a component.
 */
export const HANDLE_WIDTH_PX = 8;
export const MIN_BODY_PX = 6;
export const HANDLE_MIN_CLIP_PX = 34;

/**
 * Which parts of a clip are interactive at a given pixel width.
 *
 * @param {number} clipDuration seconds; zero is a one-shot burst
 * @param {number} widthPx the clip's rendered width
 * @returns {{start: boolean, end: boolean, bodyPx: number}}
 */
export function clipHandles(clipDuration, widthPx) {
  const burst = !(clipDuration > 0);
  // A burst keeps its end handle whatever its width: dragging it out to a
  // length is the only way to turn a burst into a window, so removing it would
  // make that a one-way change.
  const trimmable = !burst && widthPx >= HANDLE_MIN_CLIP_PX;
  const handles = (trimmable ? 2 : 0) + (burst ? 1 : 0);
  return {
    start: trimmable,
    end: trimmable || burst,
    bodyPx: Math.max(MIN_BODY_PX, widthPx - handles * HANDLE_WIDTH_PX),
  };
}

/**
 * The on-screen width of a clip, in pixels.
 *
 * Shared by the React render and the drag preview, so the two cannot disagree -
 * a preview that computed its own width is how a clip appears to change size
 * during a gesture that does not change its size.
 *
 * @param {number} clipDuration seconds; zero means a one-shot burst
 * @param {number} pixelsPerSecond
 * @param {{burstWidth: number, minWidth: number}} sizes
 * @returns {number}
 */
export function clipWidth(clipDuration, pixelsPerSecond, sizes) {
  // A burst is an instant, so its width is a fixed marker rather than a
  // measurement - a zero-width bar is both unreadable and impossible to grab.
  if (!(clipDuration > 0)) return sizes.burstWidth;
  return Math.max(clipDuration * pixelsPerSecond, sizes.minWidth);
}
