// A CPU rasteriser for VFX previews, so an effect can be LOOKED AT without a GPU.
//
// WHY THIS EXISTS. Everything else about authoring an effect from outside the
// editor already worked - the catalog describes itself, the compiler reports,
// save and export behave - and none of it closed the one gap that matters: an
// agent authoring through the MCP tools was writing eighteen hundred particles
// completely blind, against numeric statistics. "1800 alive, 1 draw call" says
// nothing about whether the thing looks like an explosion. Without pixels an
// effect can only be guessed at, never iterated on.
//
// WHY IT IS NOT WEBGL. The server has no GPU context and no DOM, and headless
// GL would be a native dependency on every platform this ships to. It does not
// need one: the simulation is already CPU-side, particles are already plain
// typed arrays, and a billboard is a screen-space disc. A few thousand of those
// is milliseconds of work in plain JavaScript.
//
// WHAT IT IS NOT. This is not the viewport, and it must never be mistaken for
// it. No textures - every particle draws as the built-in soft blob, so an
// effect whose sprite IS the effect (a flipbook, a shockwave ring) will look
// plainer here than in the editor. No mesh particles, no trails, no depth
// sorting against scene geometry, no soft particles. It answers "where are the
// particles, how big, what colour, how bright" - which is the question you
// cannot answer from a number, and about ninety per cent of authoring.
//
// WHAT IT DOES MATCH, DELIBERATELY: the tone mapping. The viewport renders
// through three's ACES Filmic plus an sRGB encode, and an agent tuning an HDR
// gradient against an untonemapped image would tune it wrong - the whole reason
// the editor has a Raw/Tonemapped toggle. The transform below is ported from
// three's own tonemapping shader chunk, matrices and fit included, so a colour
// that clips here clips there.

/** Where the camera sits, if the caller does not say. */
export const DEFAULT_VIEW = Object.freeze({
  azimuth: 35,
  elevation: 18,
  // A multiple of the effect's bounds radius. Far enough that a burst does not
  // immediately leave the frame, close enough that a small effect is not a dot.
  distance: 2.6,
  fov: 35,
});

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

// --- tone mapping ------------------------------------------------------------
// Ported from three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.
// The 1/0.6 exposure scale is three's, not ours: it is a subjective brightening
// they apply, and leaving it out makes everything here noticeably darker than
// the viewport for no reason an author could diagnose.

const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.07600, 0.90834, 0.01566],
  [0.02840, 0.13383, 0.83777],
];

const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

const mul3 = (m, r, g, b) => [
  m[0][0] * r + m[0][1] * g + m[0][2] * b,
  m[1][0] * r + m[1][1] * g + m[1][2] * b,
  m[2][0] * r + m[2][1] * g + m[2][2] * b,
];

const rrtAndOdtFit = (v) => {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
};

/**
 * Linear HDR to tone-mapped linear, exactly as the viewport does it.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} exposure
 * @returns {[number, number, number]}
 */
export function acesFilmic(r, g, b, exposure = 1) {
  const scale = exposure / 0.6;
  const [ir, ig, ib] = mul3(ACES_INPUT, r * scale, g * scale, b * scale);
  const [or_, og, ob] = mul3(
    ACES_OUTPUT, rrtAndOdtFit(ir), rrtAndOdtFit(ig), rrtAndOdtFit(ib),
  );
  return [clamp01(or_), clamp01(og), clamp01(ob)];
}

/** Linear to sRGB, the same transfer curve the canvas output encode uses. */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// --- camera ------------------------------------------------------------------

/**
 * A camera that frames the given bounds.
 *
 * ORBITS THE BOUNDS CENTRE rather than the origin, because an effect authored
 * ten metres up - a rain volume, a ceiling drip - would otherwise be framed on
 * empty ground and read as "nothing is being emitted".
 *
 * @param {number[]} min
 * @param {number[]} max
 * @param {Object} [view] DEFAULT_VIEW overrides
 * @returns {Object} an opaque camera for `renderFrame`
 */
export function frameBounds(min, max, view = {}) {
  const settings = { ...DEFAULT_VIEW, ...view };
  const centre = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const radius = Math.max(
    0.25,
    Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
  );

  const az = (settings.azimuth * Math.PI) / 180;
  const el = (settings.elevation * Math.PI) / 180;
  const dist = radius * settings.distance;
  const eye = [
    centre[0] + dist * Math.cos(el) * Math.sin(az),
    centre[1] + dist * Math.sin(el),
    centre[2] + dist * Math.cos(el) * Math.cos(az),
  ];

  // A right-handed look-at, matching the IR's space so no conversion is needed.
  const fz = [centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]];
  const flen = Math.hypot(fz[0], fz[1], fz[2]) || 1;
  const f = [fz[0] / flen, fz[1] / flen, fz[2] / flen];
  const upHint = Math.abs(f[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const s = [
    f[1] * upHint[2] - f[2] * upHint[1],
    f[2] * upHint[0] - f[0] * upHint[2],
    f[0] * upHint[1] - f[1] * upHint[0],
  ];
  const slen = Math.hypot(s[0], s[1], s[2]) || 1;
  const right = [s[0] / slen, s[1] / slen, s[2] / slen];
  const up = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ];

  return { eye, right, up, forward: f, fov: settings.fov, radius, centre };
}

/**
 * Where the particles actually are, right now.
 *
 * FRAMING THE DECLARED BOUNDS IS NOT ENOUGH. `effect.boundsMin/Max` is what the
 * author said the effect would occupy - a safe over-estimate used for culling -
 * and a candle flame declared inside a four-metre box renders as a speck in the
 * middle of an empty frame. That reads as "almost nothing is being emitted",
 * which is the single wrong conclusion this whole feature exists to prevent.
 *
 * Returns null when nothing is alive, so the caller can fall back to the
 * declared bounds rather than framing an empty point.
 *
 * @param {Array} emitters
 * @returns {{min: number[], max: number[]}|null}
 */
export function boundsOfEmitters(emitters) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let seen = 0;

  for (const emitter of emitters || []) {
    if (emitter.muted) continue;
    const pool = emitter.pool;
    const position = pool?.planes?.position;
    const size = pool?.planes?.size;
    for (let i = 0; i < (pool?.count || 0); i += 1) {
      // The particle's EXTENT, not its centre: a big soft puff whose centre is
      // inside the box still needs its edges in frame.
      const r = (size ? size[i] : 0) * 0.5;
      for (let axis = 0; axis < 3; axis += 1) {
        const v = position[i * 3 + axis];
        if (!Number.isFinite(v)) continue;
        if (v - r < min[axis]) min[axis] = v - r;
        if (v + r > max[axis]) max[axis] = v + r;
      }
      seen += 1;
    }
  }
  if (!seen || !Number.isFinite(min[0])) return null;
  return { min, max };
}

// --- rasteriser ---------------------------------------------------------------

/**
 * Draw one frame of a running effect.
 *
 * Takes the EMITTERS rather than the runtime so this module stays free of the
 * simulation - it reads plain typed arrays and knows nothing about stepping.
 *
 * @param {Object} options
 * @param {Array} options.emitters runtime emitters: {pool, irSystem, muted}
 * @param {Object} options.camera from frameBounds
 * @param {number} options.width
 * @param {number} options.height
 * @param {number[]} [options.background] linear rgb, default the viewport's
 * @param {number} [options.exposure]
 * @returns {{rgba: Uint8Array, drawn: number, clipped: number}}
 */
export function renderFrame({
  emitters,
  camera,
  width,
  height,
  background = null,
  exposure = 1,
}) {
  // Float accumulation, tone-mapped once at the end. Compositing in 8-bit would
  // clip every additive overlap to white long before the tonemapper saw it -
  // which is precisely the HDR core this preview exists to show.
  const accum = new Float32Array(width * height * 3);

  // The viewport's clear colour, in linear. An agent comparing a render to a
  // screenshot should not have to account for a different backdrop.
  const bg = background || [0.0045, 0.0049, 0.0056];
  for (let i = 0; i < width * height; i += 1) {
    accum[i * 3] = bg[0];
    accum[i * 3 + 1] = bg[1];
    accum[i * 3 + 2] = bg[2];
  }

  const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
  const focal = height / (2 * tanHalf);
  const { eye, right, up, forward } = camera;

  let drawn = 0;
  let clipped = 0;

  for (const emitter of emitters || []) {
    if (emitter.muted) continue;
    const pool = emitter.pool;
    const count = pool.count;
    if (!count) continue;

    const position = pool.planes.position;
    const size = pool.planes.size;
    const colour = pool.planes.color;
    const output = emitter.irSystem?.outputs?.[0] || {};
    // Alpha blending needs back-to-front ordering; additive does not care, and
    // sorting it would be pure cost. The preview never sorts additive for the
    // same reason the runtime defaults to no sorting at all.
    const additive = output.blend !== 'alpha' && output.blend !== 'opaque';

    const order = [];
    for (let i = 0; i < count; i += 1) {
      const px = position[i * 3] - eye[0];
      const py = position[i * 3 + 1] - eye[1];
      const pz = position[i * 3 + 2] - eye[2];
      const depth = px * forward[0] + py * forward[1] + pz * forward[2];
      if (depth <= 0.01) { clipped += 1; continue; }
      order.push([i, depth, px, py, pz]);
    }
    if (!additive) order.sort((a, b) => b[1] - a[1]);

    for (const [i, depth, px, py, pz] of order) {
      const vx = px * right[0] + py * right[1] + pz * right[2];
      const vy = px * up[0] + py * up[1] + pz * up[2];

      const sx = width / 2 + (vx / depth) * focal;
      const sy = height / 2 - (vy / depth) * focal;
      // A particle's world size is its full width, matching the billboard quad.
      const radius = ((size ? size[i] : 0.1) * 0.5 * focal) / depth;
      if (radius < 0.35) { clipped += 1; continue; }

      const x0 = Math.max(0, Math.floor(sx - radius));
      const x1 = Math.min(width - 1, Math.ceil(sx + radius));
      const y0 = Math.max(0, Math.floor(sy - radius));
      const y1 = Math.min(height - 1, Math.ceil(sy + radius));
      if (x1 < x0 || y1 < y0) { clipped += 1; continue; }

      const cr = colour ? colour[i * 4] : 1;
      const cg = colour ? colour[i * 4 + 1] : 1;
      const cb = colour ? colour[i * 4 + 2] : 1;
      const ca = colour ? colour[i * 4 + 3] : 1;
      if (ca <= 0.0005) { clipped += 1; continue; }

      drawn += 1;
      const inv = 1 / (radius * radius);
      for (let y = y0; y <= y1; y += 1) {
        const dy = y + 0.5 - sy;
        for (let x = x0; x <= x1; x += 1) {
          const dx = x + 0.5 - sx;
          const d2 = (dx * dx + dy * dy) * inv;
          if (d2 >= 1) continue;
          // The built-in soft blob: a smooth falloff to nothing at the rim, so
          // overlapping particles read as volume rather than as discs.
          const falloff = (1 - d2) * (1 - d2);
          const a = falloff * ca;
          const at = (y * width + x) * 3;
          if (additive) {
            accum[at] += cr * a;
            accum[at + 1] += cg * a;
            accum[at + 2] += cb * a;
          } else {
            accum[at] = accum[at] * (1 - a) + cr * a;
            accum[at + 1] = accum[at + 1] * (1 - a) + cg * a;
            accum[at + 2] = accum[at + 2] * (1 - a) + cb * a;
          }
        }
      }
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b] = acesFilmic(accum[i * 3], accum[i * 3 + 1], accum[i * 3 + 2], exposure);
    rgba[i * 4] = Math.round(clamp01(linearToSrgb(r)) * 255);
    rgba[i * 4 + 1] = Math.round(clamp01(linearToSrgb(g)) * 255);
    rgba[i * 4 + 2] = Math.round(clamp01(linearToSrgb(b)) * 255);
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, drawn, clipped };
}
