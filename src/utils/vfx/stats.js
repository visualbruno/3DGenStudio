// Per-frame and per-kernel timing.
//
// This exists so the preview HUD can say "turbulence: 2.1ms" rather than "the
// effect is slow". Per-kernel attribution is the concrete payoff of running the
// block stack as a chain of separate functions instead of one fused loop - a
// fused loop gives one number and no way to tell which block to cut.
//
// PROFILING IS OPT-IN, and that matters for honesty as much as for speed. Two
// performance.now() calls per kernel per frame is roughly 10-20 calls a frame,
// which is not free and, worse, is a fixed overhead that would be attributed to
// the kernels themselves. So the chain runner has two variants: with profiling
// on you learn where the time goes, with it off you learn what the effect
// actually costs. The go/no-go measurement needs both numbers, and they are not
// the same number.

// performance is a global in browsers and in Node 16+, so no import and no
// environment check - which keeps this module runnable under plain `node`
// alongside the rest of the runtime.
const now = () => performance.now();

/**
 * @typedef {Object} VfxStats
 * @property {number} frames
 * @property {number} simMs total simulation time this frame
 * @property {number} alive
 * @property {number} spawned
 * @property {number} dropped
 */

/**
 * Create a stats collector.
 *
 * @param {{profile?: boolean, window?: number}} [options] `profile` enables
 *   per-kernel timing; `window` is the frame-time ring buffer length
 * @returns {Object}
 */
export function createStats(options = {}) {
  const profile = Boolean(options.profile);
  const windowSize = Math.max(1, options.window || 60);

  const frameMs = new Float64Array(windowSize);
  let frameCursor = 0;
  let frameCount = 0;

  // Kernel totals, keyed by kernel name. A Map rather than an object because
  // the keys are dotted strings and this is written to per kernel per frame.
  const kernelMs = new Map();
  const kernelCalls = new Map();

  let frameStart = 0;
  let lastSimMs = 0;

  return {
    profile,

    beginFrame() {
      frameStart = now();
    },

    /** Record one kernel's cost. Only called when profiling. */
    kernel(name, ms) {
      kernelMs.set(name, (kernelMs.get(name) || 0) + ms);
      kernelCalls.set(name, (kernelCalls.get(name) || 0) + 1);
    },

    endFrame() {
      lastSimMs = now() - frameStart;
      frameMs[frameCursor] = lastSimMs;
      frameCursor = (frameCursor + 1) % windowSize;
      frameCount += 1;
    },

    /**
     * A snapshot for the HUD. Mean over the window rather than the last frame,
     * because a single frame's number jitters too much to read.
     */
    summary() {
      const samples = Math.min(frameCount, windowSize);
      let total = 0;
      let worst = 0;
      for (let i = 0; i < samples; i += 1) {
        total += frameMs[i];
        if (frameMs[i] > worst) worst = frameMs[i];
      }
      return {
        frames: frameCount,
        simMs: samples > 0 ? total / samples : 0,
        worstMs: worst,
        lastMs: lastSimMs,
      };
    },

    /**
     * Per-kernel cost, worst first - which is the order an author wants, since
     * the top row is the block to cut.
     *
     * @returns {Array<{name: string, totalMs: number, perFrameMs: number, calls: number}>}
     */
    kernels() {
      const frames = Math.max(1, frameCount);
      return [...kernelMs.entries()]
        .map(([name, ms]) => ({
          name,
          totalMs: ms,
          perFrameMs: ms / frames,
          calls: kernelCalls.get(name) || 0,
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
    },

    reset() {
      frameMs.fill(0);
      frameCursor = 0;
      frameCount = 0;
      kernelMs.clear();
      kernelCalls.clear();
      lastSimMs = 0;
    },
  };
}
