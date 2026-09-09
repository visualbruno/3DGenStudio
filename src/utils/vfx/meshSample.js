// Picking random points on a mesh's surface, for the Position: Mesh emitter.
//
// PURE ARRAY MATH, AND SEPARATE FROM assets.js ON PURPOSE. What arrives from a
// glTF is a three.js BufferGeometry, but nothing here needs three - only three
// typed arrays and an index. Keeping it that way means the distribution can be
// checked against closed-form areas in a node test, which matters more here
// than for most of the runtime: a sampler that is subtly biased produces an
// effect that looks *plausible* and is wrong, and no amount of staring at a
// preview will tell you that the big triangles are under-represented.
//
// THREE DECISIONS WORTH NOT RE-LITIGATING:
//
//  1. AREA-WEIGHTED, VIA A CUMULATIVE TABLE. Picking a triangle uniformly at
//     random gives every triangle the same number of particles regardless of
//     its size, so a mesh with one huge floor face and a hundred tiny detail
//     faces puts 99% of its particles on the detail. That reads as the effect
//     clinging to the wrong part of the model, and it is the single most
//     common mesh-emitter bug.
//
//  2. THE TRIANGLES ARE NOT COPIED. The index array plus the original position
//     and normal attributes are kept and read through, rather than flattening
//     nine floats per triangle into a new buffer. A 20k-triangle mesh would
//     otherwise cost 720KB of duplicated vertices per effect, for one
//     indirection saved.
//
//  3. THE SQUARE ROOT IN THE BARYCENTRIC DRAW IS LOAD-BEARING. Two uniform
//     numbers used directly as barycentric weights concentrate points towards
//     one corner; `sqrt` on the first is what makes the distribution uniform
//     over the triangle's area. Same correction as the cone's mouth and the
//     circle's disc in kernels.js.

/**
 * @typedef {Object} VfxMeshSampler
 * @property {Float32Array} positions xyz per vertex
 * @property {Float32Array|null} normals xyz per vertex, or null
 * @property {Uint32Array} index three vertex indices per triangle
 * @property {Float32Array} cdf cumulative triangle area, ending at exactly 1
 * @property {number} triangleCount
 * @property {number} vertexCount
 * @property {number} area total surface area, in the mesh's own units
 */

/**
 * Build a sampler from raw geometry arrays.
 *
 * @param {{positions: ArrayLike<number>, normals?: ArrayLike<number>|null,
 *   index?: ArrayLike<number>|null}} geometry
 * @returns {VfxMeshSampler|null} null when there is nothing to sample
 */
export function buildMeshSampler(geometry) {
  const positions = geometry?.positions;
  if (!positions || positions.length < 9) return null;

  const vertexCount = Math.floor(positions.length / 3);
  // A non-indexed geometry is the same thing with the identity index, so the
  // sampling code below has exactly one shape to handle.
  const index = geometry.index && geometry.index.length >= 3
    ? toUint32(geometry.index)
    : identityIndex(vertexCount - (vertexCount % 3));
  const triangleCount = Math.floor(index.length / 3);
  if (triangleCount < 1) return null;

  const cdf = new Float32Array(triangleCount);
  let total = 0;
  for (let t = 0; t < triangleCount; t += 1) {
    total += triangleArea(positions, index[t * 3], index[t * 3 + 1], index[t * 3 + 2]);
    cdf[t] = total;
  }

  if (!(total > 0)) {
    // Every triangle degenerate - a mesh of coincident points, or one exported
    // as lines. Fall back to a uniform table rather than returning null: vertex
    // sampling still works, and an emitter that produces SOMETHING plus a
    // diagnostic beats one that silently produces nothing.
    for (let t = 0; t < triangleCount; t += 1) cdf[t] = (t + 1) / triangleCount;
    total = 0;
  } else {
    for (let t = 0; t < triangleCount; t += 1) cdf[t] /= total;
    // Set exactly, not left to floating-point accumulation: the search below
    // is a binary search for the first entry >= u, and a table whose last entry
    // came out at 0.99999994 would send u = 1 past the end.
    cdf[triangleCount - 1] = 1;
  }

  const normals = geometry.normals && geometry.normals.length >= positions.length
    ? toFloat32(geometry.normals)
    : null;

  return {
    positions: toFloat32(positions),
    normals,
    index,
    cdf,
    triangleCount,
    vertexCount,
    area: total,
  };
}

/**
 * The first triangle whose cumulative area reaches `u`.
 *
 * A binary search rather than a linear scan: this runs once per spawned
 * particle, and a 20k-triangle mesh spawning 2,000 particles is 14 comparisons
 * each instead of an average of 10,000.
 *
 * @param {Float32Array} cdf
 * @param {number} u in [0, 1)
 * @returns {number}
 */
export function pickTriangle(cdf, u) {
  let low = 0;
  let high = cdf.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cdf[mid] < u) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * A uniformly distributed point on the surface, with its interpolated normal.
 *
 * @param {VfxMeshSampler} sampler
 * @param {number} u0 picks the triangle, in [0, 1)
 * @param {number} u1 barycentric, in [0, 1)
 * @param {number} u2 barycentric, in [0, 1)
 * @param {Float32Array|number[]} out xyz written at 0..2
 * @param {Float32Array|number[]|null} [outNormal] xyz written at 0..2
 */
export function sampleMeshSurface(sampler, u0, u1, u2, out, outNormal = null) {
  const t = pickTriangle(sampler.cdf, u0) * 3;
  const ia = sampler.index[t] * 3;
  const ib = sampler.index[t + 1] * 3;
  const ic = sampler.index[t + 2] * 3;
  const p = sampler.positions;

  // See decision 3 in the header: sqrt is what makes this uniform by AREA.
  const su = Math.sqrt(u1);
  const wa = 1 - su;
  const wb = su * (1 - u2);
  const wc = su * u2;

  out[0] = p[ia] * wa + p[ib] * wb + p[ic] * wc;
  out[1] = p[ia + 1] * wa + p[ib + 1] * wb + p[ic + 1] * wc;
  out[2] = p[ia + 2] * wa + p[ib + 2] * wb + p[ic + 2] * wc;

  if (!outNormal) return;
  const n = sampler.normals;
  if (n) {
    // Interpolated from the vertices, so a curved surface sends particles off
    // along the curve rather than in per-triangle fans.
    normalise(
      n[ia] * wa + n[ib] * wb + n[ic] * wc,
      n[ia + 1] * wa + n[ib + 1] * wb + n[ic + 1] * wc,
      n[ia + 2] * wa + n[ib + 2] * wb + n[ic + 2] * wc,
      outNormal,
    );
  } else {
    // No normal attribute: the face normal is the honest answer, and a mesh
    // exported without normals is common enough to be worth handling rather
    // than reporting.
    faceNormal(p, ia, ib, ic, outNormal);
  }
}

/**
 * A vertex of the mesh, with its normal.
 *
 * Uniform over VERTICES, not over area, and that is the point of the mode: on a
 * low-poly model the vertices are its structure, and lighting them up reads as
 * the shape's skeleton rather than its skin.
 *
 * @param {VfxMeshSampler} sampler
 * @param {number} u in [0, 1)
 * @param {Float32Array|number[]} out
 * @param {Float32Array|number[]|null} [outNormal]
 */
export function sampleMeshVertex(sampler, u, out, outNormal = null) {
  const v = Math.min(sampler.vertexCount - 1, Math.max(0, Math.floor(u * sampler.vertexCount))) * 3;
  const p = sampler.positions;
  out[0] = p[v];
  out[1] = p[v + 1];
  out[2] = p[v + 2];
  if (!outNormal) return;
  const n = sampler.normals;
  if (n) normalise(n[v], n[v + 1], n[v + 2], outNormal);
  else normalise(p[v], p[v + 1], p[v + 2], outNormal);
}

// --- internals --------------------------------------------------------------

function toFloat32(source) {
  return source instanceof Float32Array ? source : new Float32Array(source);
}

function toUint32(source) {
  return source instanceof Uint32Array ? source : new Uint32Array(source);
}

function identityIndex(count) {
  const out = new Uint32Array(Math.max(0, count));
  for (let i = 0; i < out.length; i += 1) out[i] = i;
  return out;
}

/** Half the cross product's length - the standard triangle area. */
function triangleArea(p, a, b, c) {
  const ax = p[a * 3];
  const ay = p[a * 3 + 1];
  const az = p[a * 3 + 2];
  const ux = p[b * 3] - ax;
  const uy = p[b * 3 + 1] - ay;
  const uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax;
  const vy = p[c * 3 + 1] - ay;
  const vz = p[c * 3 + 2] - az;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function faceNormal(p, ia, ib, ic, out) {
  const ux = p[ib] - p[ia];
  const uy = p[ib + 1] - p[ia + 1];
  const uz = p[ib + 2] - p[ia + 2];
  const vx = p[ic] - p[ia];
  const vy = p[ic + 1] - p[ia + 1];
  const vz = p[ic + 2] - p[ia + 2];
  normalise(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx, out);
}

function normalise(x, y, z, out) {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (!(length > 0)) {
    // Up, rather than zero: a zero "normal" multiplied by Normal speed leaves a
    // particle motionless at its birthplace, which looks like the emitter
    // having dropped it. A degenerate triangle should still throw something.
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return;
  }
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
}
