// Deterministic randomness for the VFX runtime. PCG32, plus the two integer
// hashes the simulation actually leans on.
//
// This file is the foundation the rest of the VFX code is checked against, so
// it is the first thing written and the first thing tested (vfx/random.test.mjs
// pins the outputs against PCG's own published vectors). Three decisions here
// are load-bearing:
//
//  1. NOTHING in the VFX modules may call Math.random. A particle system that
//     reaches for the ambient RNG cannot be replayed, cannot be scrubbed on a
//     timeline, and cannot produce a stable thumbnail. eslint.config.js has a
//     no-restricted-properties rule scoped to this directory so the mistake is
//     caught rather than reviewed for.
//
//  2. A particle's randomness is a HASH OF ITS IDENTITY, not a position in a
//     stream. particleSeed = pcgHash2(effectSeed ^ systemSeed, spawnIndex), so
//     particle #900's numbers are the same whether it was born alone or in a
//     burst of a thousand, and whether the frame accumulator split the step one
//     way or another. Walking a shared stream instead makes every particle's
//     look depend on how many particles preceded it, which is the real source
//     of "it looks different every time I hit play".
//
//  3. Per-particle draws are addressed by a COMPILE-TIME SLOT, not a counter.
//     pcgAt(particleSeed, slot) where the slot is hashed from (blockId, prop)
//     by the compiler. So inserting a block above another block does not change
//     the one below it, and reordering a stack changes only what the author
//     actually reordered. A counter would reshuffle every block after the edit,
//     which reads as "editing one thing broke everything else".
//
// PCG32 specifically, rather than xorshift or mulberry32: its xorshift-then-
// rotate output permutation is designed to avalanche well from a SEQUENTIAL
// stream, which is exactly how we use it (consecutive spawn indices). mulberry32
// seeded with consecutive integers produces correlated first outputs, and that
// correlation shows up as visible banding across a cone emitter's spread.
//
// LAYOUT: the state is a Uint32Array(4) - [stateHi, stateLo, incHi, incLo].
// The increment lives IN the state because that is what PCG's stream selector
// actually is: two generators with different increments walk genuinely
// different sequences, whereas offsetting the state only starts you at a
// different point in the same one. Carrying it also means this implementation
// matches pcg32_srandom_r exactly, so the test can assert against the reference
// vectors instead of against our own output - an external oracle rather than a
// snapshot of whatever we happened to write.
//
// No BigInt (allocates, and is slow enough to matter at spawn rates in the
// thousands per second) and no Number (a uint64 does not fit in a float64
// mantissa, so the low bits - the ones PCG's permutation depends on - would be
// silently dropped).

// 6364136223846793005 = 0x5851F42D4C957F2D, the PCG/Knuth LCG multiplier.
const MUL_HI = 0x5851f42d;
const MUL_LO = 0x4c957f2d;

// 1 / 2^32, as the exact double it is. Writing the constant rather than
// dividing makes the [0,1) range explicit at every call site.
const INV_2_32 = 2.3283064365386963e-10;

/** Number of uint32 words in a generator state. */
export const PCG_STATE_WORDS = 4;

// (aHi,aLo) * (bHi,bLo), keeping the low 64 bits, into out[0..1].
//
// The 16-bit limb split is not premature cleverness: aLo * bLo alone reaches
// 2^64, which a float64 cannot hold exactly, so computing it as one product and
// splitting afterwards loses precisely the low bits PCG depends on. Limbs keep
// every partial product under 2^32, where float64 is exact.
function mul64Into(aHi, aLo, bHi, bLo, out) {
  const a0 = aLo & 0xffff;
  const a1 = aLo >>> 16;
  const b0 = bLo & 0xffff;
  const b1 = bLo >>> 16;

  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;

  let lo = p00 & 0xffff;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  lo |= (mid & 0xffff) << 16;

  // High 32 bits of aLo*bLo. Every term is under 2^32 and the sum under 2^33,
  // so this stays exact before the truncation below.
  const carry = (mid >>> 16) + (p01 >>> 16) + (p10 >>> 16) + p11;

  // The cross terms only contribute mod 2^32 - anything they carry lands above
  // bit 63 and is discarded by the modulus we are working in anyway.
  const hi = (carry + Math.imul(aLo, bHi) + Math.imul(aHi, bLo)) | 0;

  out[0] = hi >>> 0;
  out[1] = lo >>> 0;
}

// out[0..1] += (addHi,addLo), mod 2^64.
function add64Into(addHi, addLo, out) {
  const l = (out[1] >>> 0) + (addLo >>> 0);
  out[1] = l >>> 0;
  out[0] = (out[0] + addHi + (l > 0xffffffff ? 1 : 0)) >>> 0;
}

// The XSH-RR output permutation: xorshift the state down, then rotate by its
// own top bits. The data-dependent rotation is what makes PCG's output hard to
// invert from a single sample, and it is why a plain LCG's notoriously weak low
// bits stop being a problem.
function output32(hi, lo) {
  // X = (state >> 18) ^ state, as two 32-bit halves.
  const xLo = (((lo >>> 18) | (hi << 14)) ^ lo) >>> 0;
  const xHi = ((hi >>> 18) ^ hi) >>> 0;
  // xorshifted = (X >> 27) & 0xffffffff
  const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;
  const rot = hi >>> 27;
  // JS shift counts are taken mod 32, so rot === 0 makes the second term
  // `xorshifted << 0` and the OR a no-op. That is the correct rotation by zero.
  return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
}

/**
 * A fresh PCG32 generator.
 *
 * @param {number} seed uint32
 * @param {number} [seq] uint32 stream selector; distinct values give
 *   genuinely independent sequences, not offsets into a shared one.
 * @returns {Uint32Array} a 4-word [stateHi, stateLo, incHi, incLo] state
 */
export function pcgInit(seed, seq = 0) {
  const state = new Uint32Array(PCG_STATE_WORDS);
  pcgReseed(state, seed, seq);
  return state;
}

/**
 * Reseed an existing generator in place. The runtime resets effects constantly
 * (every loop, every timeline scrub), and allocating a state per reset would
 * put garbage on the one path that has to stay smooth.
 *
 * This is pcg32_srandom_r verbatim: zero the state, set inc from the stream
 * selector, step, add the seed, step.
 *
 * @param {Uint32Array} state 4 words
 * @param {number} seed uint32
 * @param {number} [seq] uint32 stream selector
 */
export function pcgReseed(state, seed, seq = 0) {
  state[0] = 0;
  state[1] = 0;
  // inc = (seq << 1) | 1, as a uint64. Forced odd, which is what guarantees the
  // full 2^64 period; the shift is why two adjacent seq values cannot collide.
  state[2] = (seq >>> 31) >>> 0;
  state[3] = (((seq << 1) >>> 0) | 1) >>> 0;
  pcgNext(state);
  add64Into(0, seed >>> 0, state);
  pcgNext(state);
}

/**
 * Advance the generator and return the next uint32.
 * @param {Uint32Array} state 4 words
 * @returns {number} uint32
 */
export function pcgNext(state) {
  // The permutation is applied to the state we came in with, and the LCG step
  // happens afterwards - that ordering is part of PCG's definition, not an
  // implementation detail. Advancing first and permuting the new state gives a
  // sequence shifted by one, which still looks random and still replays, so
  // nothing downstream would ever have caught it. The reference vectors did.
  const hi = state[0];
  const lo = state[1];
  mul64Into(hi, lo, MUL_HI, MUL_LO, state);
  add64Into(state[2], state[3], state);
  return output32(hi, lo);
}

/**
 * Advance the generator and return a float in [0, 1).
 * @param {Uint32Array} state 4 words
 * @returns {number}
 */
export function pcgFloat(state) {
  return pcgNext(state) * INV_2_32;
}

/**
 * Wellons' triple32: three xorshift-multiply rounds, a bijection on uint32 with
 * avalanche good enough to be indistinguishable from random at the bit level.
 *
 * This is the hot path - one call per random-valued property per particle - so
 * it is three imuls and no state, rather than a PCG step. It is a HASH, not a
 * generator: the same input always gives the same output, which is the whole
 * point of addressing draws by slot.
 *
 * @param {number} x uint32
 * @returns {number} uint32
 */
export function triple32(x) {
  let v = x >>> 0;
  v ^= v >>> 17;
  v = Math.imul(v, 0xed5ad4bb);
  v ^= v >>> 11;
  v = Math.imul(v, 0xac4c1b51);
  v ^= v >>> 15;
  v = Math.imul(v, 0x31848bab);
  v ^= v >>> 14;
  return v >>> 0;
}

// Module-level scratch, the house idiom (see src/utils/meshSculpt.js). pcgHash2
// runs once per spawned particle, so allocating a state per call would put a
// couple of thousand short-lived Uint32Arrays per second on the GC.
const _hashState = new Uint32Array(PCG_STATE_WORDS);

/**
 * Hash two uint32s to one uint32. Used once per particle at birth, to turn
 * (effect seed, spawn index) into that particle's seed.
 *
 * This is a full PCG seeding with `b` as the STREAM SELECTOR, so consecutive
 * spawn indices address different sequences rather than neighbouring draws of
 * one. triple32 would be cheaper, but the inputs here are adversarial in the
 * way that matters - spawn indices are consecutive small integers and the
 * effect seed is usually a small number a human typed. This runs once per
 * particle, not once per property, so the extra multiplies are affordable and
 * buy independence between neighbouring particles.
 *
 * @param {number} a uint32
 * @param {number} b uint32
 * @returns {number} uint32
 */
export function pcgHash2(a, b) {
  pcgReseed(_hashState, a, b);
  return pcgNext(_hashState);
}

/**
 * The value of one random draw for one particle. `slot` is assigned by the
 * compiler from (blockId, prop) and is stable across edits elsewhere in the
 * graph - see decision 3 in the header.
 *
 * @param {number} seed uint32, the particle's seed
 * @param {number} slot uint32, compile-time draw identity
 * @returns {number} uint32
 */
export function pcgAt(seed, slot) {
  // The golden-ratio odd constant decorrelates adjacent slots before the hash
  // sees them; +1 keeps slot 0 from collapsing to hashing the bare seed.
  return triple32((seed >>> 0) ^ Math.imul((slot >>> 0) + 1, 0x9e3779b1));
}

/**
 * As pcgAt, in [0, 1).
 * @param {number} seed uint32
 * @param {number} slot uint32
 * @returns {number}
 */
export function pcgFloatAt(seed, slot) {
  return pcgAt(seed, slot) * INV_2_32;
}
