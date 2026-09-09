// Checks for vfx/random.js. No test framework - run it directly:
//
//     node vfx/random.test.mjs
//
// This file exists first, and everything else in vfx/ is checked against it,
// because determinism is the property the whole feature rests on: the timeline
// scrubber, the thumbnail generator and the engine exporters all assume that
// the same seed replays the same effect. A subtly wrong RNG would satisfy every
// one of them and still make effects look different on every play.
//
// The first case is the important one, and it is deliberately an EXTERNAL
// oracle: PCG's own published output vectors for seed 42 / stream 54. It
// already earned its keep - the first implementation returned the permutation
// of the state AFTER the LCG step instead of before, which produced a sequence
// shifted by exactly one draw. That output is still uniform, still independent
// and still perfectly replayable, so no self-consistency test and no amount of
// looking at particles on screen would ever have flagged it. Only the reference
// numbers did.
//
// KNOWN GAP, so nobody reads more into a green run than is there: these are
// correctness and independence checks, not a statistical test suite. The bucket
// and avalanche cases below would catch a badly broken hash (a truncated
// multiply, a dropped xorshift round, an off-by-one in a slot); they would not
// catch subtle higher-dimensional structure. triple32 and PCG32 are both
// published, externally analysed constructions, and that analysis - not this
// file - is the reason to trust their distribution. What this file guarantees
// is that we implement them faithfully and wire them up the way the runtime
// assumes.
import {
  pcgAt,
  pcgFloat,
  pcgFloatAt,
  pcgHash2,
  pcgInit,
  pcgNext,
  pcgReseed,
  triple32,
} from './random.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(46)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const hex = (n) => n.toString(16).padStart(8, '0');

// ---------------------------------------------------------------------------
// 1. PCG32 against the reference vectors
// ---------------------------------------------------------------------------
// From PCG's pcg32-demo with pcg32_srandom_r(&rng, 42u, 54u). If this fails,
// the 64-bit limb arithmetic in mul64Into is wrong and nothing below matters.
{
  const want = ['a15c02b7', '7b47f409', 'ba1d3330', '83d2f293', 'bfa4784b', 'cbed606e'];
  const state = pcgInit(42, 54);
  const got = want.map(() => hex(pcgNext(state)));
  check('pcg32 seed 42 stream 54', got.join() === want.join(), got.slice(0, 3).join(' '));
}

// Reseeding in place must be indistinguishable from a fresh generator, because
// the runtime reuses one state object across every loop and every scrub.
{
  const fresh = pcgInit(7, 3);
  const reused = pcgInit(999, 999);
  for (let i = 0; i < 20; i += 1) pcgNext(reused);
  pcgReseed(reused, 7, 3);
  let same = true;
  for (let i = 0; i < 8; i += 1) if (pcgNext(fresh) !== pcgNext(reused)) same = false;
  check('pcgReseed matches a fresh generator', same);
}

// ---------------------------------------------------------------------------
// 2. Streams are independent, not offsets into one sequence
// ---------------------------------------------------------------------------
// This is what the increment-in-the-state layout buys. An earlier draft kept a
// fixed increment and added the stream selector to the state instead, which
// gives two generators the SAME sequence starting at different points - so two
// systems in one effect could silently walk into each other's numbers.
{
  const a = pcgInit(1234, 0);
  const b = pcgInit(1234, 1);
  const seqA = Array.from({ length: 64 }, () => pcgNext(a));
  const seqB = Array.from({ length: 64 }, () => pcgNext(b));
  const setA = new Set(seqA);
  const overlap = seqB.filter((v) => setA.has(v)).length;
  // Two independent streams of 64 uint32s should share nothing. A shared
  // sequence at an offset would overlap on almost every element.
  check('streams 0 and 1 do not overlap', overlap === 0, `overlap ${overlap}/64`);
}

{
  const state = pcgInit(5, 5);
  let inRange = true;
  for (let i = 0; i < 4096; i += 1) {
    const f = pcgFloat(state);
    if (!(f >= 0 && f < 1)) inRange = false;
  }
  check('pcgFloat stays in [0, 1)', inRange);
}

// ---------------------------------------------------------------------------
// 3. triple32 is a bijection with real avalanche
// ---------------------------------------------------------------------------
// A dropped round or a mistyped constant would still "look random" in a
// particle preview, so check the two properties the construction promises.
{
  const seen = new Set();
  let collisions = 0;
  for (let i = 0; i < 20000; i += 1) {
    const h = triple32(i);
    if (seen.has(h)) collisions += 1;
    seen.add(h);
  }
  check('triple32 injective over 20k inputs', collisions === 0, `collisions ${collisions}`);
}

{
  // Flipping one input bit should flip about half the output bits. Averaged
  // over every bit position and many inputs, a sound hash sits very near 16.
  let total = 0;
  let samples = 0;
  for (let i = 0; i < 512; i += 1) {
    const base = triple32(Math.imul(i, 2654435761));
    for (let bit = 0; bit < 32; bit += 1) {
      const flipped = triple32(Math.imul(i, 2654435761) ^ (1 << bit));
      let diff = base ^ flipped;
      let bits = 0;
      while (diff) {
        bits += diff & 1;
        diff >>>= 1;
      }
      total += bits;
      samples += 1;
    }
  }
  const mean = total / samples;
  check('triple32 avalanche ~16 bits', mean > 15.5 && mean < 16.5, `mean ${mean.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// 4. The properties the RUNTIME actually depends on
// ---------------------------------------------------------------------------
// Decision 2 in random.js: a particle's numbers come from its identity, so they
// must not depend on how many particles were spawned alongside it. Simulating
// "one at a time" and "all in one burst" has to give byte-identical results.
{
  const effectSeed = 0xc0ffee;
  const oneAtATime = [];
  for (let i = 0; i < 500; i += 1) oneAtATime.push(pcgHash2(effectSeed, i));
  const asBurst = [];
  for (let i = 0; i < 500; i += 1) asBurst.push(pcgHash2(effectSeed, i));
  // Interleave a second system's spawns to prove nothing shared is advancing.
  const interleaved = [];
  for (let i = 0; i < 500; i += 1) {
    pcgHash2(0xbadf00d, i * 7);
    interleaved.push(pcgHash2(effectSeed, i));
  }
  check(
    'particle seeds ignore birth order',
    oneAtATime.join() === asBurst.join() && oneAtATime.join() === interleaved.join(),
  );
}

// Neighbouring spawn indices must not produce neighbouring values, or a cone
// emitter's spread shows visible banding across a burst.
//
// Scored by chi-square rather than "worst bucket is within N%", which was the
// first attempt and was simply the wrong instrument: at 16k samples across 16
// buckets a single bucket's standard deviation is ~31 counts, so a perfectly
// good hash routinely lands one bucket 8% off (2.7 sigma) and a 8% bound fails
// on correct input. Chi-square accounts for the sample size instead of
// pretending a fixed percentage means something.
//
// Everything here is deterministic - fixed seeds, no wall clock - so this
// passes or fails identically on every machine and every run. The critical
// value is for 15 degrees of freedom at p = 0.001; exceeding it means the
// distribution is genuinely skewed, not that we got unlucky.
{
  const BUCKETS = 16;
  const CHI2_CRITICAL_15DF_P001 = 37.7;
  const n = 16000;
  const buckets = new Array(BUCKETS).fill(0);
  for (let i = 0; i < n; i += 1) {
    const seed = pcgHash2(0x1234, i);
    buckets[Math.floor(pcgFloatAt(seed, 0) * BUCKETS)] += 1;
  }
  const expected = n / BUCKETS;
  let chi2 = 0;
  for (const observed of buckets) chi2 += ((observed - expected) ** 2) / expected;
  check(
    'consecutive spawn indices spread evenly',
    chi2 < CHI2_CRITICAL_15DF_P001,
    `chi2 ${chi2.toFixed(1)} (crit ${CHI2_CRITICAL_15DF_P001})`,
  );
}

// Decision 3: a draw is addressed by a compile-time slot, so the value at one
// slot cannot depend on which other slots exist. This is what makes inserting a
// block above another block leave the one below it alone.
{
  const seed = pcgHash2(11, 22);
  const before = [3, 7, 9].map((slot) => pcgAt(seed, slot));
  // Read a pile of unrelated slots, exactly as adding blocks elsewhere would.
  for (let slot = 0; slot < 200; slot += 1) pcgAt(seed, slot);
  const after = [3, 7, 9].map((slot) => pcgAt(seed, slot));
  check('slot values are independent of other slots', before.join() === after.join());
}

{
  // Different slots on one particle must be uncorrelated: a particle whose
  // random size and random lifetime move together is a particle that looks
  // wrong in a way that is very hard to trace back to the RNG.
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i += 1) {
    const seed = pcgHash2(0xabcd, i);
    sum += (pcgFloatAt(seed, 0) - 0.5) * (pcgFloatAt(seed, 1) - 0.5);
  }
  // Covariance of two independent uniforms is 0; the estimator's own standard
  // error here is ~1/(12*sqrt(n)) ~= 0.0006, so this bound is ~13 sigma.
  const cov = sum / n;
  check('slots 0 and 1 are uncorrelated', Math.abs(cov) < 0.008, `cov ${cov.toFixed(5)}`);
}

{
  // Adjacent effect seeds are the case a user hits by typing 1, then 2. They
  // must not produce similar-looking effects.
  const a = Array.from({ length: 200 }, (_, i) => pcgFloatAt(pcgHash2(1, i), 0));
  const b = Array.from({ length: 200 }, (_, i) => pcgFloatAt(pcgHash2(2, i), 0));
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - 0.5) * (b[i] - 0.5);
  const cov = sum / a.length;
  check('effect seeds 1 and 2 are unrelated', Math.abs(cov) < 0.02, `cov ${cov.toFixed(5)}`);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
