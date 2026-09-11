// Render frames of a VFX effect on the server, with no GPU.
//
// THE ONE THING AN AGENT COULD NOT DO. Authoring an effect through the MCP
// tools worked end to end - catalog, compile, save, export - and every step
// reported numbers. None of them answered "does this look like an explosion",
// so eighteen hundred particles were being authored blind and could only be
// guessed at, never iterated on.
//
// WHY IT IS A ROOT MODULE. Same rule as meshPivot.js and skinTransfer.js: a
// server-side compute module that server.js imports statically, named in
// electron-builder.yml so the packaged backend does not die at startup on
// ERR_MODULE_NOT_FOUND. It is the seam between two layers that must not import
// each other - the simulation under src/utils/vfx/ and the rasteriser in vfx/.
//
// STEPPING IS NOT ADVANCING. `advance(runtime, 1.2)` does NOT simulate 1.2
// seconds: the accumulator is clamped to maxSubSteps to stop a long frame
// spiralling, so one big delta runs four fixed steps and stops. Measured, not
// assumed - it produced 4 alive particles where there should have been 67, and
// a render that looked like an effect emitting almost nothing. Frames are
// therefore walked at fixedDt, exactly as the editor's frame loop does.
import { compileVfxGraph } from './vfx/compile.js';
import { normalizeVfxDoc } from './vfx/doc.js';
import { encodePng } from './vfx/png.js';
import { boundsOfEmitters, frameBounds, renderFrame } from './vfx/preview.js';
import { advance, createVfxRuntime, runtimeStats } from './src/utils/vfx/system.js';

/** Frames larger than this are refused: it is a preview, not a render farm. */
export const MAX_PREVIEW_PIXELS = 1280;
export const MAX_PREVIEW_FRAMES = 8;

/**
 * Simulate an effect and draw it at one or more moments.
 *
 * @param {Object} doc a VFX graph document
 * @param {Object} [options]
 * @param {number[]} [options.times] seconds to capture at; default four across the effect
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {Object} [options.view] azimuth / elevation / distance / fov
 * @param {boolean} [options.frameOnParticles] auto-frame on what is alive (default true)
 * @returns {Promise<{frames: Array, diagnostics: Array, stats: Object}>}
 */
export async function renderVfxFrames(doc, options = {}) {
  const normalized = normalizeVfxDoc(doc);
  const { ir, diagnostics, stats } = compileVfxGraph(normalized);

  // AN EFFECT WITH NOTHING IN IT IS NOT A BLACK FRAME, it is an empty document,
  // and the two are indistinguishable once rendered. This compiles cleanly -
  // there is nothing to complain about - so without this check the answer is
  // four black images and the word "ok", which reads as "your effect is
  // invisible" and sends the caller looking for a rendering problem.
  if (!ir.systems || ir.systems.length === 0) {
    return {
      frames: [],
      diagnostics: diagnostics.map(summarise),
      stats: null,
      error: 'This effect has no systems, so there is nothing to draw. Add one with a '
        + 'Spawn, Initialize, Update and Output context.',
    };
  }

  const fatal = diagnostics.filter((d) => d.severity === 'error');
  if (fatal.length > 0) {
    // NOTHING IS DRAWN FROM A BROKEN EFFECT, and the errors are the answer. A
    // blank frame plus "ok" would be read as "the effect is invisible", which
    // is a completely different problem to debug.
    return {
      frames: [],
      diagnostics: diagnostics.map(summarise),
      stats: null,
      error: 'The effect does not compile, so there is nothing to draw.',
    };
  }

  const width = clampSize(options.width, 480);
  const height = clampSize(options.height, 270);
  const duration = Math.max(0.05, ir.effect.duration || 1);

  // FOUR MOMENTS ACROSS THE EFFECT by default, not one. A burst is empty at
  // t=0 and empty again at the end; a single frame at either would say the
  // effect does nothing. Skewed early because that is where a one-shot lives.
  const times = (Array.isArray(options.times) && options.times.length
    ? options.times
    : [0.15, 0.35, 0.6, 0.9].map((f) => +(duration * f).toFixed(3))
  )
    .map((t) => Math.max(0, Number(t) || 0))
    .slice(0, MAX_PREVIEW_FRAMES)
    .sort((a, b) => a - b);

  const runtime = createVfxRuntime(ir, {});
  const dt = ir.effect.fixedDt || 1 / 60;
  const frames = [];
  let simulated = 0;

  for (const target of times) {
    // Walked forward from wherever the last frame left it, so capturing four
    // moments costs one simulation rather than four.
    let guard = 0;
    while (simulated < target - dt * 0.5 && guard < 100000) {
      advance(runtime, dt);
      simulated += dt;
      guard += 1;
    }

    const live = options.frameOnParticles === false ? null : boundsOfEmitters(runtime.emitters);
    const camera = live
      ? frameBounds(live.min, live.max, options.view)
      : frameBounds(ir.effect.boundsMin, ir.effect.boundsMax, options.view);

    const { rgba, drawn, clipped } = renderFrame({
      emitters: runtime.emitters,
      camera,
      width,
      height,
      exposure: Number.isFinite(options.exposure) ? options.exposure : 1,
    });

    frames.push({
      time: +simulated.toFixed(3),
      png: encodePng(width, rgba, height),
      drawn,
      // NOT COSMETIC. "0 drawn, 400 clipped" and "0 drawn, 0 clipped" are
      // different bugs: the first is a framing or scale problem, the second
      // means nothing is being emitted at all.
      clipped,
      alive: runtimeStats(runtime).alive,
    });
  }

  return {
    frames,
    diagnostics: diagnostics.map(summarise),
    stats: {
      peakParticles: stats.peakParticles,
      drawCalls: stats.drawCalls,
      duration,
      width,
      height,
    },
  };
}

function summarise(d) {
  return { code: d.code, severity: d.severity, message: d.message };
}

function clampSize(value, fallback) {
  const n = Math.round(Number(value) || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(64, Math.min(MAX_PREVIEW_PIXELS, n));
}
