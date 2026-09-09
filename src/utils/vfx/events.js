// The deferred event queue: what turns one system's particles into another
// system's spawns.
//
// A SPARK THAT DIES BECOMES A PUFF OF SMOKE. That is the whole feature, and it
// is how one impact reads as a single event rather than as several unrelated
// effects playing at once.
//
// DEFERRED, AND THAT IS THE LOAD-BEARING WORD. A kernel that spawned a child
// particle the instant it detected a death would be writing into another
// system's pool from inside a loop over its own - which means the child could
// be born into a pool that is mid-compaction, could be updated twice in one
// step, or could raise an event of its own and recurse without bound. So
// detection only RECORDS, and every recorded event is drained after all
// systems have finished stepping.
//
// FIXED-CAPACITY RING, NEVER GROWN. Sixty thousand particles dying in one frame
// would otherwise allocate sixty thousand records in the middle of the frame
// they are least affordable in - the same argument the pool makes for its own
// fixed capacity. Past the cap, events are DROPPED AND COUNTED, and the HUD
// shows the count: dropping visibly beats hitching invisibly.
//
// DEPTH IS CAPPED AT FOUR. A -> B -> A is a fork bomb with particles, and it is
// not a hypothetical: the natural way to author a firework is "a shell that
// dies into sparks", and the natural mistake is to make the sparks die into
// more sparks. The cap is enforced at COMPILE time, where it can be reported,
// rather than at runtime where it can only be survived.

/** Floats per event record: position, velocity, seed. */
const STRIDE = 7;

/** Records per source-and-trigger channel. */
const DEFAULT_CAPACITY = 4096;

/**
 * @param {{capacity?: number, channels?: number}} [options]
 * @returns {Object} an event queue
 */
export function createEventQueue(options = {}) {
  const capacity = Math.max(1, options.capacity || DEFAULT_CAPACITY);
  const channels = Math.max(1, options.channels || 1);
  return {
    capacity,
    channels,
    // One flat buffer for every channel rather than an array of arrays: the
    // channel count is known at build time and a single allocation keeps the
    // records of one frame contiguous.
    data: new Float32Array(capacity * channels * STRIDE),
    counts: new Uint32Array(channels),
    dropped: 0,
  };
}

/**
 * Record one event.
 *
 * @param {Object} queue
 * @param {number} channel which source-and-trigger pair raised it
 * @param {Object} pool the raising particle's pool
 * @param {number} i its index
 */
export function pushEvent(queue, channel, pool, i) {
  if (channel < 0 || channel >= queue.channels) return;
  const at = queue.counts[channel];
  if (at >= queue.capacity) {
    queue.dropped += 1;
    return;
  }
  queue.counts[channel] = at + 1;
  const o = (channel * queue.capacity + at) * STRIDE;
  const data = queue.data;
  const planes = pool.planes;
  const p = i * 3;
  data[o] = planes.position[p];
  data[o + 1] = planes.position[p + 1];
  data[o + 2] = planes.position[p + 2];
  if (planes.velocity) {
    data[o + 3] = planes.velocity[p];
    data[o + 4] = planes.velocity[p + 1];
    data[o + 5] = planes.velocity[p + 2];
  } else {
    data[o + 3] = 0;
    data[o + 4] = 0;
    data[o + 5] = 0;
  }
  // The parent's seed, so the child's randoms are a hash of a real identity
  // rather than of a counter - which is what keeps a sub-emitter reproducible
  // across replays and independent of how many events happened to fire first.
  data[o + 6] = planes.seed ? planes.seed[i] : 0;
}

/** How many events a channel holds this frame. */
export function eventCount(queue, channel) {
  return channel >= 0 && channel < queue.channels ? queue.counts[channel] : 0;
}

/**
 * Read one record into `out` as [x, y, z, vx, vy, vz, seed].
 *
 * @param {Object} queue
 * @param {number} channel
 * @param {number} index
 * @param {Float32Array|Float64Array|number[]} out at least 7 long
 * @returns {typeof out}
 */
export function readEvent(queue, channel, index, out) {
  const o = (channel * queue.capacity + index) * STRIDE;
  for (let c = 0; c < STRIDE; c += 1) out[c] = queue.data[o + c];
  return out;
}

/**
 * Clear every channel for the next frame.
 *
 * The counts are zeroed and the DATA IS NOT. Nothing reads past a channel's
 * count, so wiping tens of thousands of floats every frame would be work with
 * no observable effect - and this runs on every step of every effect.
 *
 * @param {Object} queue
 */
export function clearEvents(queue) {
  queue.counts.fill(0);
}

/** Reset, including the dropped tally - for a full restart rather than a frame. */
export function resetEventQueue(queue) {
  queue.counts.fill(0);
  queue.dropped = 0;
}

export { STRIDE as EVENT_STRIDE };
