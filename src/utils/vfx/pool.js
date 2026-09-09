// The particle pool: one ArrayBuffer per system, with a typed-array view per
// attribute.
//
// No React, no three.js, no DOM - so this runs under plain `node` and the
// runtime can be measured before any of the rendering exists. That is the whole
// point of phase 3.
//
// FOUR DECISIONS, each with a plausible alternative that is worse.
//
// 1. PLANAR, NOT INTERLEAVED. Each attribute gets a contiguous run of the
//    buffer. The update loop is a SEQUENCE OF PASSES, each touching two to four
//    attributes - integrate touches position and velocity, colour-over-life
//    touches age, lifetime and colour - so planar gives every pass a perfectly
//    sequential stream per attribute, which is what the prefetcher wants and
//    what the JIT will unroll. Interleaving would only win if one pass touched
//    every attribute, and no pass does.
//
// 2. VECTORS ARE XYZ-STRIDED WITHIN THEIR PLANE, not split into three planes.
//    position[i * 3 + 0..2], not px[i], py[i], pz[i]. The reason is the render
//    path: writing the instanced buffer copies position out per particle, and a
//    strided read is one sequential walk while three separate planes need an
//    interleaving loop with three cursors. One rule, applied uniformly, and the
//    sim loses nothing by it.
//
// 3. LIVENESS BY COMPACTION, NOT A MASK. `count` is the live prefix; killing
//    particle i copies the last live particle over it. The honest cost is
//    attrBytes per death - at 60k particles with one-second lifetimes that is
//    ~1,000 deaths per frame times ~76 bytes, about 76 KB of copying, which is
//    nothing. The alternative, a free list plus an `alive` flag, keeps indices
//    stable but puts a branch and a likely mispredict on EVERY particle in
//    EVERY pass, destroying exactly the sequential access decision 1 exists to
//    get. Compaction also reorders particles, which only matters if draw order
//    matters - and it does not, because additive blending is order-independent
//    and anything else gets sorted anyway.
//
// 4. CAPACITY IS FIXED AT BUILD TIME AND NEVER GROWN. Growing means
//    reallocating the ArrayBuffer, recreating every view AND recreating the GPU
//    buffers - mid-frame, at exactly the moment the effect is most demanding.
//    Instead the compiler works out the peak, warns if the author's number is
//    lower, and the pool DROPS spawns past capacity while counting them. The
//    HUD shows that count. Dropping visibly and countably beats hitching
//    invisibly.
//
// The one thing compaction costs is a stable per-particle identity for a
// "inspect this particle" debug feature. The `seed` attribute covers that: it
// is unique, it is stable for the particle's whole life, and it moves with the
// particle when it is swapped.

/**
 * @typedef {Object} VfxPool
 * @property {number} capacity
 * @property {number} count live particles; the live prefix is [0, count)
 * @property {number} spawnCursor monotonic spawn counter, for particle seeds
 * @property {number} dropped spawns refused because the pool was full
 * @property {ArrayBuffer} buffer
 * @property {Object<string, Float32Array|Uint32Array>} planes by attribute name
 * @property {Object<string, number>} widths by attribute name
 * @property {Float32Array} accel force accumulator, xyz-strided
 * @property {number} floatsPerParticle
 */

/**
 * Allocate a pool for one IR system.
 *
 * @param {Object} irSystem an entry from ir.systems
 * @param {Object} ir the whole IR, for the attribute layout
 * @returns {VfxPool}
 */
export function createPool(irSystem, ir) {
  const capacity = Math.max(1, irSystem.capacity | 0);
  const floatsPerParticle = ir.attributes.reduce((sum, a) => sum + a.width, 0);
  const buffer = new ArrayBuffer(capacity * floatsPerParticle * 4);

  const planes = {};
  const widths = {};
  // Pairs held as a flat list too, so swapRemove can walk them without
  // Object.entries - that would allocate an array per death, and deaths happen
  // by the thousand per second.
  const planeList = [];

  let byteOffset = 0;
  for (const attr of ir.attributes) {
    const length = capacity * attr.width;
    const view = attr.type === 'uint32'
      ? new Uint32Array(buffer, byteOffset, length)
      : new Float32Array(buffer, byteOffset, length);
    planes[attr.name] = view;
    widths[attr.name] = attr.width;
    planeList.push(view, attr.width);
    byteOffset += length * 4;
  }

  return {
    capacity,
    count: 0,
    spawnCursor: 0,
    dropped: 0,
    buffer,
    planes,
    widths,
    planeList,
    // A separate plane rather than an attribute: forces accumulate within one
    // step and are consumed by integration at the end of it, so this never has
    // to survive a frame and never has to reach the GPU. Keeping it out of the
    // attribute layout is what stops it costing three floats per particle in
    // every effect that has no forces at all.
    accel: new Float32Array(capacity * 3),
    floatsPerParticle,
  };
}

/**
 * Remove the particle at `i` by moving the last live particle into its slot.
 *
 * O(attributes), not O(count). Note this INVALIDATES index `i` for the caller's
 * loop: whatever was last is now at i and has not been examined yet, so a
 * caller sweeping for deaths must re-test i rather than advancing past it.
 *
 * @param {VfxPool} pool
 * @param {number} i
 */
export function swapRemove(pool, i) {
  const last = pool.count - 1;
  pool.count = last;
  if (i === last) return;

  const list = pool.planeList;
  for (let p = 0; p < list.length; p += 2) {
    const plane = list[p];
    const width = list[p + 1];
    const to = i * width;
    const from = last * width;
    for (let c = 0; c < width; c += 1) plane[to + c] = plane[from + c];
  }

  const accel = pool.accel;
  accel[i * 3] = accel[last * 3];
  accel[i * 3 + 1] = accel[last * 3 + 1];
  accel[i * 3 + 2] = accel[last * 3 + 2];
}

/**
 * Claim a run of slots for newly spawned particles.
 *
 * Returns the range actually granted, which may be shorter than asked for -
 * that is the capacity limit doing its job, and the shortfall is recorded in
 * `pool.dropped` so the HUD can show it rather than the author wondering where
 * their particles went.
 *
 * @param {VfxPool} pool
 * @param {number} wanted
 * @returns {{i0: number, i1: number}}
 */
export function claimSlots(pool, wanted) {
  const room = pool.capacity - pool.count;
  const granted = Math.max(0, Math.min(wanted, room));
  if (granted < wanted) pool.dropped += wanted - granted;
  const i0 = pool.count;
  pool.count += granted;
  return { i0, i1: pool.count };
}

/**
 * Reset to empty, without reallocating.
 *
 * Zeroing the whole buffer rather than only the live prefix is deliberate: it
 * costs one memset of a few megabytes on a path that runs when the author
 * presses restart, and it means a stale value can never leak into a particle
 * through an attribute no Initialize block happens to set. A partial reset
 * would make that leak depend on how many particles were alive when the reset
 * happened, which is the kind of bug that only shows up sometimes.
 *
 * @param {VfxPool} pool
 */
export function resetPool(pool) {
  pool.count = 0;
  pool.spawnCursor = 0;
  pool.dropped = 0;
  new Uint8Array(pool.buffer).fill(0);
  pool.accel.fill(0);
}

/**
 * A checksum over the live particles, for the determinism tests.
 *
 * Order-sensitive on purpose: two runs that produce the same particles in a
 * different order are NOT the same simulation, because compaction order is
 * itself determined by the spawn and death sequence. If that ever needs to be
 * relaxed, sort by the `seed` plane first - do not weaken this.
 *
 * FNV-1a over the float bits rather than a sum: a sum cannot tell 1+3 from
 * 2+2, and the failure it would miss (two attributes swapped) is exactly the
 * kind of mistake a kernel makes.
 *
 * @param {VfxPool} pool
 * @returns {number} uint32
 */
export function poolChecksum(pool) {
  const scratch = new Float32Array(1);
  const bits = new Uint32Array(scratch.buffer);
  let hash = 0x811c9dc5;

  const mix = (word) => {
    hash ^= word & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (word >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (word >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (word >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  };

  mix(pool.count);
  const list = pool.planeList;
  for (let p = 0; p < list.length; p += 2) {
    const plane = list[p];
    const width = list[p + 1];
    const end = pool.count * width;
    for (let i = 0; i < end; i += 1) {
      if (plane instanceof Uint32Array) {
        mix(plane[i]);
      } else {
        // Round to 6 decimals before hashing. Float32 arithmetic is
        // deterministic on one machine, but rounding makes the checksum robust
        // to the last-bit differences that show up between a value written
        // straight to a plane and the same value that has been through a
        // snapshot round trip - which is a difference the tests should not care
        // about.
        scratch[0] = Math.round(plane[i] * 1e6) / 1e6;
        mix(bits[0]);
      }
    }
  }
  return hash >>> 0;
}

/**
 * Bytes this pool occupies, for the stats HUD.
 * @param {VfxPool} pool
 * @returns {number}
 */
export function poolBytes(pool) {
  return pool.buffer.byteLength + pool.accel.byteLength;
}
