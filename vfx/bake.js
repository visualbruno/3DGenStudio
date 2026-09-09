// Shared policy for baking authored curves and gradients into the lookup
// tables the simulation samples. Two consumers - vfx/curve.js and
// vfx/gradient.js - and the rationale belongs with the numbers rather than in
// whichever of them happened to be written first.

/**
 * Candidate table sizes, smallest first.
 *
 * Every entry is 2^k + 1, which is what makes both endpoints land exactly on a
 * sample so a lookup is t*(n-1) with no bias correction. Get that wrong and
 * every ramp is subtly off at t=0 and t=1 - precisely where size and alpha
 * ramps matter most, because that is birth and death.
 *
 * The ladder starts at 5 rather than at a flat 65 because the overwhelming
 * majority of authored ramps are simple: a linear ramp is reconstructed
 * exactly by 5 samples, and paying 65 for it would be ~10x the table memory
 * for no fidelity. Both choosers walk this list and take the first size that
 * meets tolerance.
 */
export const BAKE_SAMPLE_LADDER = Object.freeze([5, 9, 17, 33, 65, 129, 257]);

/**
 * Reconstruction error accepted from a baked table, as a fraction of the
 * baked channel's own value range.
 *
 * Relative rather than absolute, deliberately: an absolute threshold is
 * meaningless across a 0..1 alpha ramp and an HDR colour channel that peaks at
 * 6, and picking one number for both means it is either far too loose for the
 * former or rejects every table size for the latter. 0.2% of range sits
 * comfortably under a perceptual threshold for the two things ramps are mostly
 * used for, size and opacity.
 */
export const DEFAULT_MAX_BAKE_ERROR = 0.002;

/**
 * Dense grid used to MEASURE reconstruction error and value extents.
 *
 * Deliberately not a power of two plus one: if the probe points coincided with
 * the sample positions, every table size would report zero error and the whole
 * measurement would be vacuous. 1000 against a ladder of 2^k+1 sizes shares
 * almost no points with any of them.
 */
export const BAKE_ERROR_PROBE_SAMPLES = 1000;

/**
 * As DEFAULT_MAX_BAKE_ERROR, but for gradients, and deliberately looser.
 *
 * The difference is not sloppiness, it is a different error regime. A Hermite
 * curve is smooth, so its resampling error comes from curvature and falls
 * QUADRATICALLY with sample count - doubling the table quarters the error, and
 * 0.2% is reachable within the ladder. A gradient is piecewise LINEAR with
 * kinks at its stops, and at a kink the error comes from cutting the corner
 * across one cell: it is proportional to cell width times the change in slope,
 * so it falls only LINEARLY. Doubling the table merely halves it.
 *
 * Concretely, the Fire preset's alpha rises 0 to 1 over the first 0.08 of the
 * life and then falls gently. That kink sits between two samples whatever the
 * table size, and reproducing it to 0.2% would need roughly 1500 entries - six
 * times the largest ladder size, for an error of 0.013 in an alpha value, which
 * no one can see. 2% of range is the point where the tolerance is about
 * perceptibility rather than about arithmetic.
 */
export const DEFAULT_MAX_GRADIENT_BAKE_ERROR = 0.02;
