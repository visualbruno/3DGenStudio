// Gradient noise with analytic derivatives, and the curl field built from it.
//
// Curl noise is what stops smoke looking like it is on rails, and it is the
// single most expensive block in the catalog - so it is worth being precise
// about why it is built this way.
//
// WHY CURL, and not just "add some noise to the velocity". A curl field is
// divergence-free by construction: curl(P) has zero divergence for any
// potential P. Divergence-free means the flow neither creates nor destroys
// density, so particles swirl and fold without clumping into knots or tearing
// open holes. Adding raw noise to velocity does not have that property, and
// the clumping is immediately visible as smoke that gathers into blobs.
//
// WHY ANALYTIC DERIVATIVES, and not finite differences. Curl needs the partial
// derivatives of three potential fields. By finite difference that is six
// extra noise evaluations (two per axis) plus an epsilon to tune - and the
// epsilon is a real trap, because too small loses precision in float32 and too
// large smooths the field into mush. Gradient noise's derivative is available
// in closed form for the cost of a few multiplies, so three evaluations give
// all nine partials exactly, with nothing to tune.
//
// WHY THE PERMUTATION TABLE IS SEEDED FROM A FIXED CONSTANT, not from the
// effect seed. Noise here is a FIELD, not a random number: a particle at a
// given position must feel the same force as its neighbour at that position,
// and two particles at the same place must not disagree. Seeding the table per
// effect would also mean an author's tuned turbulence changed shape when they
// changed the effect seed to reshuffle the sparks, which is exactly the kind of
// coupling that makes a tool feel arbitrary.
//
// A GLSL TWIN IS DEFERRED, deliberately. The plan calls for the same field as a
// shader string, for an eventual GPU path and for the importers' custom-HLSL
// fallback. Shipping one now would mean shipping code that cannot be checked
// against anything - and two noise implementations that disagree produce an
// effect that looks different in the preview and in the engine, which is the
// worst outcome available. It lands with the GPU path, where it can be verified
// sample-for-sample against this file.

// 12 gradient vectors, the standard Perlin set: the midpoints of the edges of a
// cube. Kept as a flat array so a lookup is two multiplies and no allocation.
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// The permutation table, doubled so index arithmetic never needs a wrap test.
//
// Built from a fixed 32-bit hash rather than from a hard-coded 256-entry
// literal: the literal is what every Perlin implementation copies from the
// reference source, and it makes this file 20 lines longer for no benefit. What
// matters is that it is a permutation and that it is the SAME one every run.
const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) p[i] = i;
  // A fixed-seed shuffle. Not PCG, because this runs once at module load and
  // must not depend on anything the effect can change.
  let state = 0x9e3779b9;
  for (let i = 255; i > 0; i -= 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    const j = state % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i += 1) PERM[i] = p[i & 255];
}

// Quintic fade and its derivative. Quintic rather than cubic because cubic
// leaves a visible second-derivative discontinuity at cell boundaries, which
// shows up as faint grid lines in the flow.
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const dfade = (t) => 30 * t * t * (t * (t - 2) + 1);

const lerp = (t, a, b) => a + t * (b - a);

/**
 * Gradient (Perlin) noise in 3D, with its gradient.
 *
 * Writes [value, d/dx, d/dy, d/dz] into out. Non-allocating, because this is
 * called three times per particle per frame by the curl kernel.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Float32Array|Float64Array|number[]} out at least 4 long
 * @returns {Float32Array|Float64Array|number[]} out
 */
export function perlin3(x, y, z, out) {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const ix = fx & 255;
  const iy = fy & 255;
  const iz = fz & 255;
  const rx = x - fx;
  const ry = y - fy;
  const rz = z - fz;

  const u = fade(rx);
  const v = fade(ry);
  const w = fade(rz);
  const du = dfade(rx);
  const dv = dfade(ry);
  const dw = dfade(rz);

  const a = PERM[ix] + iy;
  const aa = PERM[a] + iz;
  const ab = PERM[a + 1] + iz;
  const b = PERM[ix + 1] + iy;
  const ba = PERM[b] + iz;
  const bb = PERM[b + 1] + iz;

  // Eight corner gradients, and the dot product of each with the offset from
  // its corner. The gradient components are kept because they ARE the
  // derivative of the corner term - d/dx of dot(g, offset) is g.x.
  const g000 = (PERM[aa] % 12) * 3;
  const g100 = (PERM[ba] % 12) * 3;
  const g010 = (PERM[ab] % 12) * 3;
  const g110 = (PERM[bb] % 12) * 3;
  const g001 = (PERM[aa + 1] % 12) * 3;
  const g101 = (PERM[ba + 1] % 12) * 3;
  const g011 = (PERM[ab + 1] % 12) * 3;
  const g111 = (PERM[bb + 1] % 12) * 3;

  const x1 = rx - 1;
  const y1 = ry - 1;
  const z1 = rz - 1;

  const n000 = GRAD3[g000] * rx + GRAD3[g000 + 1] * ry + GRAD3[g000 + 2] * rz;
  const n100 = GRAD3[g100] * x1 + GRAD3[g100 + 1] * ry + GRAD3[g100 + 2] * rz;
  const n010 = GRAD3[g010] * rx + GRAD3[g010 + 1] * y1 + GRAD3[g010 + 2] * rz;
  const n110 = GRAD3[g110] * x1 + GRAD3[g110 + 1] * y1 + GRAD3[g110 + 2] * rz;
  const n001 = GRAD3[g001] * rx + GRAD3[g001 + 1] * ry + GRAD3[g001 + 2] * z1;
  const n101 = GRAD3[g101] * x1 + GRAD3[g101 + 1] * ry + GRAD3[g101 + 2] * z1;
  const n011 = GRAD3[g011] * rx + GRAD3[g011 + 1] * y1 + GRAD3[g011 + 2] * z1;
  const n111 = GRAD3[g111] * x1 + GRAD3[g111 + 1] * y1 + GRAD3[g111 + 2] * z1;

  // Trilinear blend of the corner values.
  const nx00 = lerp(u, n000, n100);
  const nx10 = lerp(u, n010, n110);
  const nx01 = lerp(u, n001, n101);
  const nx11 = lerp(u, n011, n111);
  const nxy0 = lerp(v, nx00, nx10);
  const nxy1 = lerp(v, nx01, nx11);
  out[0] = lerp(w, nxy0, nxy1);

  // The derivative has two parts: the corner GRADIENTS blended the same way,
  // plus the fade function's own derivative times the difference the blend is
  // interpolating across. Both terms are needed - dropping the second is a
  // common mistake and produces a field whose curl is not divergence-free.
  const gx00 = lerp(u, GRAD3[g000], GRAD3[g100]);
  const gx10 = lerp(u, GRAD3[g010], GRAD3[g110]);
  const gx01 = lerp(u, GRAD3[g001], GRAD3[g101]);
  const gx11 = lerp(u, GRAD3[g011], GRAD3[g111]);
  out[1] = lerp(w, lerp(v, gx00, gx10), lerp(v, gx01, gx11))
    + du * lerp(w, lerp(v, n100 - n000, n110 - n010), lerp(v, n101 - n001, n111 - n011));

  const gy00 = lerp(u, GRAD3[g000 + 1], GRAD3[g100 + 1]);
  const gy10 = lerp(u, GRAD3[g010 + 1], GRAD3[g110 + 1]);
  const gy01 = lerp(u, GRAD3[g001 + 1], GRAD3[g101 + 1]);
  const gy11 = lerp(u, GRAD3[g011 + 1], GRAD3[g111 + 1]);
  out[2] = lerp(w, lerp(v, gy00, gy10), lerp(v, gy01, gy11))
    + dv * lerp(w, nx10 - nx00, nx11 - nx01);

  const gz00 = lerp(u, GRAD3[g000 + 2], GRAD3[g100 + 2]);
  const gz10 = lerp(u, GRAD3[g010 + 2], GRAD3[g110 + 2]);
  const gz01 = lerp(u, GRAD3[g001 + 2], GRAD3[g101 + 2]);
  const gz11 = lerp(u, GRAD3[g011 + 2], GRAD3[g111 + 2]);
  out[3] = lerp(w, lerp(v, gz00, gz10), lerp(v, gz01, gz11))
    + dw * (nxy1 - nxy0);

  return out;
}

// Scratch for the three potential-field evaluations. Module level, the house
// idiom (see src/utils/meshSculpt.js): curl3 runs once per particle per frame,
// so allocating here would put tens of thousands of short-lived arrays per
// second on the GC.
const _p1 = new Float64Array(4);
const _p2 = new Float64Array(4);
const _p3 = new Float64Array(4);

// Offsets that decorrelate the three potential fields. Large and irrational-ish
// so the three never sample the same lattice cell in step, which would make the
// curl collapse toward a plane.
const OFF2 = 31.416;
const OFF3 = 67.891;

/**
 * Curl of a three-component gradient-noise potential, at a point.
 *
 * The result is divergence-free, which is what makes it usable as a velocity
 * field for particles - see the header. Writes into out; non-allocating.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Float32Array|Float64Array|number[]} out at least 3 long
 * @returns {Float32Array|Float64Array|number[]} out
 */
export function curl3(x, y, z, out) {
  perlin3(x, y, z, _p1);
  perlin3(x + OFF2, y + OFF2, z + OFF2, _p2);
  perlin3(x + OFF3, y + OFF3, z + OFF3, _p3);

  // curl P = (dP3/dy - dP2/dz, dP1/dz - dP3/dx, dP2/dx - dP1/dy)
  out[0] = _p3[2] - _p2[3];
  out[1] = _p1[3] - _p3[1];
  out[2] = _p2[1] - _p1[2];
  return out;
}

/**
 * Divergence of the curl field, sampled by finite difference.
 *
 * Exists only for the test: the whole justification for using curl is that the
 * field is divergence-free, and that is a claim worth checking rather than
 * asserting. Not used by the runtime.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [h] sample spacing
 * @returns {number}
 */
export function curlDivergence(x, y, z, h = 1e-3) {
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  curl3(x + h, y, z, a);
  curl3(x - h, y, z, b);
  const dxdx = (a[0] - b[0]) / (2 * h);
  curl3(x, y + h, z, a);
  curl3(x, y - h, z, b);
  const dydy = (a[1] - b[1]) / (2 * h);
  curl3(x, y, z + h, a);
  curl3(x, y, z - h, b);
  const dzdz = (a[2] - b[2]) / (2 * h);
  return dxdx + dydy + dzdz;
}
