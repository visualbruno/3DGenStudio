// Checks for vfx/value.js. No test framework - run it directly:
//
//     node vfx/value.test.mjs
//
// VfxValue is the type every authorable property in the editor is made of, so
// its failure modes are all failures the author experiences directly: a mode
// switch that eats their curve, a property that silently becomes zero, a
// wired input that takes the whole effect down when its source is deleted.
// The cases below are organised around those, not around the API surface.
//
// The collapse case has already earned its place twice over. The first version
// used the curve's value at t=0 as the constant fallback, which is correct-
// sounding and wrong for the single most common shape anyone authors: a ramp
// that fades IN starts at zero, so switching it to a constant produced an
// invisible particle. The same bug existed in gradients, where every usable
// ramp starts at alpha 0.
//
// KNOWN GAP: the link/edges reconciliation that decision 2 in value.js
// describes is not tested here, because it lives in normalizeVfxDoc rather
// than in this module - vfx/doc.test.mjs owns it. What is checked here is that
// a link with a dead source still evaluates, which is the half this module is
// responsible for.
import {
  RANDOM_FREQ,
  VALUE_DOMAIN,
  VALUE_MODE,
  constFold,
  constValue,
  curveValue,
  describeValue,
  exposedValue,
  gradientValue,
  isAnimated,
  linkValue,
  modeSwitchLosesWork,
  normalizeValue,
  randomValue,
  readValue,
  setValueMode,
  valueChannels,
  valueRange,
} from './value.js';
import { CURVE_PRESETS, createCurve, linearCurve } from './curve.js';
import { GRADIENT_PRESETS, createGradient } from './gradient.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(50)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const preset = (list, id) => list.find((p) => p.id === id).build();

// ---------------------------------------------------------------------------
// 1. Every mode carries a usable literal - decision 1
// ---------------------------------------------------------------------------
{
  // The regression: a fade-in shape must not collapse to zero. Every one of
  // these presets starts at or near 0 and rises, so "value at t=0" would give
  // 0 for all of them.
  const results = ['rampUp', 'bell', 'fadeInOut', 'spike', 'easeIn'].map((id) => {
    const value = curveValue(preset(CURVE_PRESETS, id), { scale: 7 });
    return { id, literal: readValue(value) };
  });
  const allReach = results.every((r) => near(r.literal, 7));
  check(
    'curves collapse to the value they reach',
    allReach,
    results.map((r) => `${r.id}=${r.literal}`).join(' '),
  );
}

{
  // Sign has to survive, or a gravity curve collapses to +9.8 and particles
  // fall upwards.
  const gravity = curveValue(linearCurve(0, -9.8));
  check('collapse keeps the sign of the extreme', near(readValue(gravity), -9.8), String(readValue(gravity)));
}

{
  const fire = gradientValue(preset(GRADIENT_PRESETS, 'fire'));
  const rgba = readValue(fire);
  // Peak alpha, not alpha at t=0 (which is 0 for every fade-in ramp).
  check('gradients collapse at peak alpha', rgba[3] > 0.9, `a ${rgba[3].toFixed(3)}`);
  check('gradient collapse keeps HDR colour', rgba[0] > 1, `r ${rgba[0].toFixed(2)}`);
}

{
  // A wired property whose source node was deleted must keep working. This is
  // the "delete an operator, the effect keeps running" half of decision 1.
  const orphan = linkValue('', 'out', 3.5);
  check('a dead link still evaluates', near(readValue(orphan), 3.5));
  const renamed = exposedValue('', 2);
  check('an unassigned exposed value still evaluates', near(readValue(renamed), 2));
}

// ---------------------------------------------------------------------------
// 2. Mode switching is lossless
// ---------------------------------------------------------------------------
{
  const original = curveValue(preset(CURVE_PRESETS, 'bell'), { scale: 7 });
  const keyCount = original.curve.keys.length;

  let value = setValueMode(original, VALUE_MODE.CONST);
  const asConst = readValue(value);
  value = setValueMode(value, VALUE_MODE.RANDOM);
  const asRandomDesc = describeValue(value);
  value = setValueMode(value, VALUE_MODE.GRADIENT);
  value = setValueMode(value, VALUE_MODE.CURVE);

  const restored = value.mode === VALUE_MODE.CURVE
    && value.curve.keys.length === keyCount
    && near(value.scale, 7);
  check('curve survives a trip through three modes', restored, `${keyCount} keys, scale ${value.scale}`);
  check('  and the constant it passed through was useful', near(asConst, 7), `const ${asConst}`);
  check('  and the random range was not empty', !asRandomDesc.includes('0 to 0'), asRandomDesc);
}

{
  const gradient = gradientValue(preset(GRADIENT_PRESETS, 'magic'));
  const stops = gradient.gradient.colorKeys.length;
  const round = setValueMode(setValueMode(gradient, VALUE_MODE.CONST), VALUE_MODE.GRADIENT);
  check(
    'gradient survives a round trip',
    round.gradient.colorKeys.length === stops,
    `${round.gradient.colorKeys.length} of ${stops} stops`,
  );
}

{
  // Deriving a random range from a constant should bracket the constant, not
  // replace it with an arbitrary 0..1.
  const value = setValueMode(constValue(2), VALUE_MODE.RANDOM);
  const lo = value.a;
  const hi = value.b;
  check('random derives a range around the value', lo < 2 && hi > 2, `${lo} to ${hi}`);
}

{
  // Zero is the case percentage-widening cannot handle.
  const value = setValueMode(constValue(0), VALUE_MODE.RANDOM);
  check('random from zero is not an empty range', value.a < value.b, `${value.a} to ${value.b}`);
}

{
  // The property's declared bounds must be respected, or the inspector offers
  // a negative lifetime.
  const value = setValueMode(constValue(0), VALUE_MODE.RANDOM, { range: { min: 0 } });
  check('derived range respects the declared minimum', value.a >= 0, `${value.a} to ${value.b}`);
}

{
  // Switching to a curve must not change how the effect currently looks - the
  // author is opening a door, not making an edit.
  const value = setValueMode(constValue(3), VALUE_MODE.CURVE);
  check('const -> curve preserves the value', near(readValue(value), 3), String(readValue(value)));
}

{
  const same = setValueMode(constValue(5), VALUE_MODE.CONST);
  check('switching to the current mode is a no-op', same.mode === VALUE_MODE.CONST && near(readValue(same), 5));
}

{
  const original = curveValue(preset(CURVE_PRESETS, 'bell'));
  const copy = setValueMode(original, VALUE_MODE.CONST);
  check('setValueMode does not mutate its input', original.mode === VALUE_MODE.CURVE && copy.mode === VALUE_MODE.CONST);
}

{
  check('modeSwitchLosesWork warns for curve -> const', modeSwitchLosesWork(curveValue(linearCurve(0, 1)), VALUE_MODE.CONST) === true);
  check('modeSwitchLosesWork is quiet for const -> curve', modeSwitchLosesWork(constValue(1), VALUE_MODE.CURVE) === false);
}

// ---------------------------------------------------------------------------
// 3. Normalisation accepts what a human or a model actually writes
// ---------------------------------------------------------------------------
{
  const bare = normalizeValue(2.5);
  const arr = normalizeValue([1, 2, 3]);
  const bool = normalizeValue(true);
  const nothing = normalizeValue(undefined);
  const ok = bare.mode === VALUE_MODE.CONST && near(readValue(bare), 2.5)
    && arr.mode === VALUE_MODE.CONST && readValue(arr).length === 3
    && readValue(bool) === true
    && near(readValue(nothing), 0);
  check('bare literals normalise to constants', ok);
}

{
  // Widening a scalar to a vector repeats it. Zero-filling would make a size
  // of 0.4 into (0.4, 0, 0) - a flat, invisible particle.
  const widened = normalizeValue(0.4, { channels: 3 });
  const v = readValue(widened);
  check('scalar widens by repeating', v.length === 3 && v.every((n) => near(n, 0.4)), JSON.stringify(v));
}

{
  // A mode string from a future document format, or a link whose node went
  // away, must degrade rather than throw during a load.
  const future = normalizeValue({ mode: 'quantum-entangled', v: 4 });
  const brokenLink = normalizeValue({ mode: 'link', v: 6 });
  check(
    'unknown modes degrade to their literal',
    future.mode === VALUE_MODE.CONST && near(readValue(future), 4)
      && brokenLink.mode === VALUE_MODE.CONST && near(readValue(brokenLink), 6),
  );
}

{
  // Round-tripping through JSON is what a save and load does.
  const original = curveValue(preset(CURVE_PRESETS, 'spike'), { scale: 2, domain: VALUE_DOMAIN.SPEED });
  const revived = normalizeValue(JSON.parse(JSON.stringify(original)));
  const ok = revived.mode === VALUE_MODE.CURVE
    && revived.curve.keys.length === original.curve.keys.length
    && near(revived.scale, 2)
    && revived.domain === VALUE_DOMAIN.SPEED;
  check('values survive JSON round trip', ok);
}

{
  const stashed = setValueMode(curveValue(linearCurve(0, 1)), VALUE_MODE.CONST);
  const revived = normalizeValue(JSON.parse(JSON.stringify(stashed)));
  const back = setValueMode(revived, VALUE_MODE.CURVE);
  check('the stash survives JSON round trip', back.curve.keys.length === 2, `${back.curve.keys.length} keys`);
}

// ---------------------------------------------------------------------------
// 4. What the compiler and the diagnostics read off a value
// ---------------------------------------------------------------------------
{
  const r = valueRange(randomValue(1, 5));
  check('range of a random is its bounds', near(r.lo[0], 1) && near(r.hi[0], 5) && r.exact);
}

{
  // A random authored backwards (high, low) still has a sensible range.
  const r = valueRange(randomValue(5, 1));
  check('range copes with reversed bounds', near(r.lo[0], 1) && near(r.hi[0], 5));
}

{
  const r = valueRange(curveValue(preset(CURVE_PRESETS, 'bell'), { scale: 7 }));
  check('range of a curve spans its extent', near(r.lo[0], 0) && near(r.hi[0], 7), `${r.lo[0]}..${r.hi[0]}`);
}

{
  // randomScale widens the range - the capacity solve has to see the worst
  // case, not the nominal one.
  const r = valueRange(curveValue(linearCurve(0, 1), { randomScale: [1, 4] }));
  check('randomScale widens the range', near(r.hi[0], 4), `hi ${r.hi[0]}`);
}

{
  const exposed = valueRange(exposedValue('Intensity', 3));
  const link = valueRange(linkValue('op1', 'out', 3));
  const konst = valueRange(constValue(3));
  check(
    'only constants report an exact range',
    konst.exact === true && exposed.exact === false && link.exact === false,
  );
}

{
  // An exposed value must not fold: a host can change it at runtime, so
  // baking its default would silently ignore the override the author added it
  // for.
  check('constFold folds constants', near(constFold(constValue(2)), 2));
  check('constFold refuses exposed values', constFold(exposedValue('X', 3)) === null);
  check('constFold refuses randoms', constFold(randomValue(0, 1)) === null);
}

{
  const animated = [
    curveValue(linearCurve(0, 1)),
    gradientValue(createGradient({})),
    randomValue(0, 1),
    linkValue('a', 'out'),
  ].every(isAnimated);
  check('isAnimated covers every varying mode', animated && !isAnimated(constValue(1)));
}

{
  const ok = valueChannels(constValue(1)) === 1
    && valueChannels(constValue([1, 2, 3])) === 3
    && valueChannels(gradientValue(createGradient({}))) === 4
    && valueChannels(randomValue([0, 0], [1, 1])) === 2;
  check('valueChannels reports the right width', ok);
}

// ---------------------------------------------------------------------------
// 5. The labels the author reads
// ---------------------------------------------------------------------------
{
  const rows = [
    describeValue(constValue(2), { unit: 's' }),
    describeValue(randomValue(1.5, 2.5), { unit: 's' }),
    describeValue(randomValue(0, 1, { freq: RANDOM_FREQ.PER_FRAME })),
    describeValue(curveValue(preset(CURVE_PRESETS, 'spike'), { scale: 3 })),
    describeValue(gradientValue(preset(GRADIENT_PRESETS, 'fire'))),
    describeValue(linkValue('op7', 'out', 1), { sourceLabel: 'Curl Noise' }),
    describeValue(exposedValue('Intensity', 1)),
    describeValue(constValue(true)),
    describeValue(linkValue('', 'out', 0)),
  ];
  // Every row must say something, and none may leak a raw mode name at the
  // reader - the audience has not learned this vocabulary.
  const allSpoken = rows.every((r) => r.length > 0)
    && !rows.some((r) => /perParticle|perFrame|const\b/.test(r));
  check('every mode has a plain-language label', allSpoken);
  for (const row of rows) console.log(`${''.padEnd(52)}   "${row}"`);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
