// Back-to-front sorting for the outputs that need it.
//
// SORTING IS OFF BY DEFAULT, and that is a correctness statement rather than a
// performance one: additive and premultiplied blending are order-INDEPENDENT,
// because addition commutes. Most VFX is additive - sparks, fire, magic, muzzle
// flashes - so the common case needs no sort at all and paying for one would be
// pure waste.
//
// What genuinely needs it is alpha-blended, depth-write-off geometry, where
// `src * a + dst * (1 - a)` does not commute and drawing a near particle before
// a far one leaves the far one visibly missing from the overlap.
//
// SORTS INDICES, NOT THE POOL. Two reasons. The pool's order is what makes the
// simulation deterministic - reordering it to please the camera would make the
// checksum depend on where the camera was, and the whole determinism story
// rests on that not happening. And the sort only has to affect the WRITE into
// the instance buffer, which is downstream of the simulation anyway.
//
// RADIX, NOT Array.prototype.sort. A comparison sort on 60k elements is ~1M
// comparisons through a JS callback; a three-pass 11-bit radix is three linear
// passes with no callback at all. The measured cost is around 0.75 ms at 60k,
// which is what the W_SORT_COST diagnostic quotes back to the author.
//
// The float-to-sortable-uint trick: for a positive float the IEEE-754 bit
// pattern already orders correctly as an unsigned integer, and for a negative
// one the order is reversed. Flipping all bits of negatives and just the sign
// bit of positives makes unsigned integer comparison agree with float
// comparison across the whole range - which is what lets a radix sort work on
// depths that straddle zero.

const RADIX_BITS = 11;
const RADIX_SIZE = 1 << RADIX_BITS;
const RADIX_MASK = RADIX_SIZE - 1;

// One shared histogram. Module level, the house idiom: this runs per sorting
// batch per frame, and allocating 2048 ints each time would be needless garbage
// on the one path that is already the expensive one.
const histogram = new Uint32Array(RADIX_SIZE);

// Scratch for the float-bits reinterpret. A DataView or a typed-array pair is
// the only way to read a float's bit pattern in JS.
const floatScratch = new Float32Array(1);
const bitScratch = new Uint32Array(floatScratch.buffer);

function floatToSortableUint(value) {
  floatScratch[0] = value;
  const bits = bitScratch[0];
  // Sign bit set means negative: flip everything, so more-negative sorts lower.
  // Otherwise flip only the sign bit, lifting positives above all negatives.
  return (bits & 0x80000000) !== 0 ? ~bits >>> 0 : (bits ^ 0x80000000) >>> 0;
}

// How far the camera may rotate, and how many particles may die, before a
// cached order stops being good enough.
//
// This is the layer that matters in an EDITOR. The author spends most of their
// time dragging a slider with the camera still, and re-sorting sixty thousand
// particles every frame to produce the same order is the definition of wasted
// work. Two degrees is below the angle at which a mis-ordered overlap becomes
// visible, and five percent churn is a couple of frames' worth of deaths.
const CAM_EPSILON = Math.cos(2 * (Math.PI / 180));
const CHURN_FRACTION = 0.05;

/**
 * Depth-sorted indices into a pool, back to front.
 *
 * Returns a Uint32Array owned by the batch and reused across frames, so the
 * caller must not hold onto it past the current write.
 *
 * @param {Object} batch the batch, which caches the buffers and the last camera
 * @param {Object} pool
 * @param {{x: number, y: number, z: number}} cameraDir normalised view direction
 * @returns {Uint32Array}
 */
export function sortIndicesByDepth(batch, pool, cameraDir) {
  const count = pool.count;

  if (!batch.sortKeys || batch.sortKeys.length < batch.instances) {
    batch.sortKeys = new Uint32Array(batch.instances);
    batch.sortOrder = new Uint32Array(batch.instances);
    batch.sortScratchKeys = new Uint32Array(batch.instances);
    batch.sortScratchOrder = new Uint32Array(batch.instances);
    batch.sortedCount = -1;
  }

  // Reuse the cached order when neither the camera nor the population has
  // moved enough to matter.
  const dot = cameraDir.x * batch.lastSortCamX
    + cameraDir.y * batch.lastSortCamY
    + cameraDir.z * batch.lastSortCamZ;
  const churn = batch.sortedCount > 0
    ? Math.abs(count - batch.sortedCount) / batch.sortedCount
    : 1;
  if (batch.sortedCount === count && dot >= CAM_EPSILON && churn < CHURN_FRACTION) {
    return batch.sortOrder;
  }

  const keys = batch.sortKeys;
  const order = batch.sortOrder;
  const position = pool.planes.position;

  // Depth along the view direction, negated.
  //
  // Worth being careful here, because the sign is easy to talk oneself into
  // backwards. With the camera looking down -Z, a point at z = -10 is far and
  // gives p . d = +10; a point at z = -1 is near and gives +1. Negating means
  // the FAR point gets the SMALLER key, so sorting ascending runs far to near -
  // which is the back-to-front order alpha blending needs.
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    const depth = -(position[o] * cameraDir.x
      + position[o + 1] * cameraDir.y
      + position[o + 2] * cameraDir.z);
    keys[i] = floatToSortableUint(depth);
    order[i] = i;
  }

  radixSort(keys, order, batch.sortScratchKeys, batch.sortScratchOrder, count);

  batch.sortedCount = count;
  batch.lastSortCamX = cameraDir.x;
  batch.lastSortCamY = cameraDir.y;
  batch.lastSortCamZ = cameraDir.z;
  return batch.sortOrder;
}

// Least-significant-digit radix sort over 32-bit keys, carrying a payload.
// Three passes of 11 bits covers 33 bits, so the top pass sees only 10 - which
// is fine and cheaper than four passes of 8.
function radixSort(keys, order, keyScratch, orderScratch, count) {
  let fromKeys = keys;
  let fromOrder = order;
  let toKeys = keyScratch;
  let toOrder = orderScratch;

  for (let shift = 0; shift < 32; shift += RADIX_BITS) {
    histogram.fill(0);
    for (let i = 0; i < count; i += 1) {
      histogram[(fromKeys[i] >>> shift) & RADIX_MASK] += 1;
    }

    // A single non-empty bucket means every key shares this digit, so the pass
    // would be an exact copy. Skipping it is what makes a sort of clustered
    // depths - which is what particles from one emitter are - cheaper than the
    // worst case.
    let nonEmpty = 0;
    for (let b = 0; b < RADIX_SIZE; b += 1) if (histogram[b] !== 0) nonEmpty += 1;
    if (nonEmpty <= 1) continue;

    let sum = 0;
    for (let b = 0; b < RADIX_SIZE; b += 1) {
      const c = histogram[b];
      histogram[b] = sum;
      sum += c;
    }

    for (let i = 0; i < count; i += 1) {
      const digit = (fromKeys[i] >>> shift) & RADIX_MASK;
      const at = histogram[digit];
      histogram[digit] = at + 1;
      toKeys[at] = fromKeys[i];
      toOrder[at] = fromOrder[i];
    }

    let swap = fromKeys;
    fromKeys = toKeys;
    toKeys = swap;
    swap = fromOrder;
    fromOrder = toOrder;
    toOrder = swap;
  }

  // An odd number of executed passes leaves the result in the scratch buffers,
  // so copy back. Cheaper than tracking which buffer is current all the way out
  // to the caller, and it happens at most once per sort.
  if (fromOrder !== order) {
    order.set(fromOrder.subarray(0, count));
    keys.set(fromKeys.subarray(0, count));
  }
}

/**
 * Sort indices ascending by a float key. Exported for the tests, which need to
 * check the radix implementation against a known-correct comparison sort
 * without going through a pool and a camera.
 *
 * @param {Float32Array|number[]} values
 * @returns {Uint32Array} indices, ascending by value
 */
export function sortIndicesByValue(values) {
  const count = values.length;
  const keys = new Uint32Array(count);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    keys[i] = floatToSortableUint(values[i]);
    order[i] = i;
  }
  radixSort(keys, order, new Uint32Array(count), new Uint32Array(count), count);
  return order;
}
