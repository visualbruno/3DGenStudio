// Checks for vfx/curve.js. No test framework - run it directly:
//
//     node vfx/curve.test.mjs
//
// Curves are the most-touched authoring surface in the VFX editor and the one
// whose failures are least diagnosable by the person hitting them: a developer
// who has never authored a curve cannot tell "the interpolator overshot" from
// "I typed the wrong number". So the cases below are weighted towards the ways
// a curve can disagree with the keys the author actually placed.
//
// The overshoot case has already earned its place. Plain Catmull-Rom auto
// tangents turned keys at 0 -> 1 -> 1 -> 0 (fade in, hold, fade out - the most
// common shape anyone draws) into a curve peaking at 1.18. On an alpha ramp
// that is a hold visibly longer than authored; on size it is a particle 18%
// bigger than the typed value. It looked entirely plausible on screen.
//
// KNOWN GAP: these check the evaluator, the bake and the shape of the engine
// conversions. They do NOT check that Unity and Unreal reconstruct our curves
// identically - that needs the engines in the loop and belongs to the importer
// plugins' own tests. What is verified here is that the conversion preserves
// every key's time, value and step-ness, which is the precondition for that.
import {
  CURVE_INTERP,
  CURVE_PRESETS,
  CURVE_WRAP,
  bakeCurve,
  chooseCurveSampleCount,
  constantCurve,
  createCurve,
  curveExtent,
  curveHasSteps,
  curveToUnityKeyframes,
  curveToUnrealRichCurve,
  evalCurve,
  evalCurveLut,
  linearCurve,
  addCurveKey,
  moveCurveKey,
  removeCurveKey,
  setKeyInterp,
  cycleKeyInterp,
  setKeyTangent,
  describeCurve,
} from './curve.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(46)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1. The evaluator agrees with the keys
// ---------------------------------------------------------------------------
{
  const curve = createCurve([{ t: 0, v: 2 }, { t: 0.4, v: 7 }, { t: 1, v: -3 }]);
  const hit = curve.keys.every((k) => near(evalCurve(curve, k.t), k.v));
  check('evalCurve passes exactly through keys', hit);
}

{
  // A linear ramp must be exact everywhere, not merely at the ends - this is
  // the one shape where any interpolation error is unambiguous.
  const curve = linearCurve(0, 10);
  let worst = 0;
  for (let i = 0; i <= 100; i += 1) {
    const t = i / 100;
    worst = Math.max(worst, Math.abs(evalCurve(curve, t) - t * 10));
  }
  check('linear segments are exact', worst < 1e-6, `worst ${worst.toExponential(1)}`);
}

{
  const curve = constantCurve(0.35);
  const flat = [0, 0.3, 0.5, 0.9, 1].every((t) => near(evalCurve(curve, t), 0.35));
  check('constantCurve is flat', flat);
}

{
  // Unsorted input is a real case: the editor lets a key be dragged past its
  // neighbour, and the document may be hand-edited.
  const curve = createCurve([{ t: 1, v: 5 }, { t: 0, v: 1 }, { t: 0.5, v: 3 }]);
  const sorted = curve.keys.map((k) => k.t).join() === '0,0.5,1';
  check('createCurve sorts keys', sorted, curve.keys.map((k) => k.t).join(' '));
}

{
  // Deleting the last key in the editor reaches this state, and it must not
  // throw on a path that runs sixty times a second.
  const curve = createCurve([]);
  check('empty key list evaluates to 0', near(evalCurve(curve, 0.5), 0));
}

// ---------------------------------------------------------------------------
// 2. Auto tangents do not overshoot - the regression case
// ---------------------------------------------------------------------------
{
  const curve = createCurve([{ t: 0, v: 0 }, { t: 0.15, v: 1 }, { t: 0.7, v: 1 }, { t: 1, v: 0 }]);
  const { min, max } = curveExtent(curve);
  check(
    'fade-hold-fade stays within its keys',
    max <= 1 + 1e-4 && min >= -1e-4,
    `range ${min.toFixed(4)}..${max.toFixed(4)}`,
  );
}

{
  // Every shipped preset must respect its own keys, or the preset menu is
  // handing the author a curve that lies about itself.
  let worstId = '';
  let worstOver = 0;
  for (const preset of CURVE_PRESETS) {
    const curve = preset.build();
    const keyMin = Math.min(...curve.keys.map((k) => k.v));
    const keyMax = Math.max(...curve.keys.map((k) => k.v));
    const { min, max } = curveExtent(curve);
    const over = Math.max(max - keyMax, keyMin - min);
    if (over > worstOver) {
      worstOver = over;
      worstId = preset.id;
    }
  }
  check('no preset overshoots its keys', worstOver <= 1e-4, `worst ${worstId} by ${worstOver.toFixed(4)}`);
}

{
  // The clamp must not have removed intentional overshoot: an elastic pop is a
  // legitimate thing to author, via explicit tangents.
  const curve = createCurve([
    { t: 0, v: 0, interp: CURVE_INTERP.FREE, outTangent: 6 },
    { t: 0.6, v: 1.3, interp: CURVE_INTERP.FREE, inTangent: 0, outTangent: 0 },
    { t: 1, v: 1, interp: CURVE_INTERP.FREE, inTangent: 0 },
  ]);
  check('free tangents can still overshoot', curveExtent(curve).max > 1.25);
}

{
  // curveExtent must sample, not just scan keys - a Hermite segment's extreme
  // is often at neither a key nor a midpoint. The bounds solve and the
  // zero-alpha diagnostic both depend on this being true.
  const curve = createCurve([
    { t: 0, v: 0, interp: CURVE_INTERP.FREE, outTangent: 8 },
    { t: 1, v: 0, interp: CURVE_INTERP.FREE, inTangent: 8 },
  ]);
  const keyMax = 0;
  check('curveExtent finds off-key extremes', curveExtent(curve).max > keyMax + 0.5, `max ${curveExtent(curve).max.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 3. Steps hold, and wrap modes wrap
// ---------------------------------------------------------------------------
{
  const curve = createCurve([
    { t: 0, v: 1, interp: CURVE_INTERP.CONSTANT },
    { t: 0.5, v: 4, interp: CURVE_INTERP.CONSTANT },
    { t: 1, v: 9 },
  ]);
  const held = near(evalCurve(curve, 0.1), 1) && near(evalCurve(curve, 0.49), 1) && near(evalCurve(curve, 0.6), 4);
  check('constant segments hold their value', held);
  check('curveHasSteps detects steps', curveHasSteps(curve) === true);
  check('curveHasSteps ignores step-free curves', curveHasSteps(linearCurve(0, 1)) === false);
}

{
  const clamped = createCurve([{ t: 0, v: 0 }, { t: 1, v: 1 }]);
  const ok = near(evalCurve(clamped, -0.5), 0) && near(evalCurve(clamped, 1.5), 1);
  check('clamp wrap holds the end values', ok);
}

{
  const looped = createCurve(
    [{ t: 0, v: 0, interp: CURVE_INTERP.LINEAR }, { t: 1, v: 1, interp: CURVE_INTERP.LINEAR }],
    { postWrap: CURVE_WRAP.LOOP },
  );
  // t = 1.25 is a quarter of the way through the next repetition.
  check('loop wrap restarts the curve', near(evalCurve(looped, 1.25), 0.25, 1e-4), evalCurve(looped, 1.25).toFixed(4));
}

{
  const ping = createCurve(
    [{ t: 0, v: 0, interp: CURVE_INTERP.LINEAR }, { t: 1, v: 1, interp: CURVE_INTERP.LINEAR }],
    { postWrap: CURVE_WRAP.PINGPONG },
  );
  // t = 1.25 is a quarter of the way BACK down.
  check('pingpong wrap reverses', near(evalCurve(ping, 1.25), 0.75, 1e-4), evalCurve(ping, 1.25).toFixed(4));
}

// ---------------------------------------------------------------------------
// 4. The bake reconstructs what the evaluator produces
// ---------------------------------------------------------------------------
// This is the contract chooseCurveSampleCount promises, and the simulation
// samples the LUT rather than the curve - so if this drifts, every effect is
// subtly not the effect that was authored.
{
  const TOLERANCE = 0.002;
  let worstId = '';
  let worstRel = 0;
  for (const preset of CURVE_PRESETS) {
    const curve = preset.build();
    if (curveHasSteps(curve)) continue; // a discontinuity is not reconstructible
    const n = chooseCurveSampleCount(curve);
    const lut = bakeCurve(curve, n);
    const { min, max } = curveExtent(curve);
    const range = Math.max(max - min, 1e-9);
    let worst = 0;
    for (let i = 0; i <= 997; i += 1) {
      const t = i / 997;
      worst = Math.max(worst, Math.abs(evalCurveLut(lut, t) - evalCurve(curve, t)));
    }
    const rel = worst / range;
    if (rel > worstRel) {
      worstRel = rel;
      worstId = preset.id;
    }
  }
  check(
    'baked LUTs stay within tolerance',
    worstRel <= TOLERANCE,
    `worst ${worstId} at ${(worstRel * 100).toFixed(3)}% of range`,
  );
}

{
  // Every ladder entry is 2^k+1 precisely so both endpoints are real samples.
  // If this fails, every curve is biased at t=0 and t=1, which is where size
  // and alpha ramps matter most.
  const curve = CURVE_PRESETS.find((p) => p.id === 'spike').build();
  const lut = bakeCurve(curve, chooseCurveSampleCount(curve));
  const ok = near(lut[0], evalCurve(curve, 0)) && near(lut[lut.length - 1], evalCurve(curve, 1));
  check('LUT endpoints are exact', ok);
}

{
  // Simple curves must not pay for the worst case. A linear ramp needs 5.
  const cheap = chooseCurveSampleCount(linearCurve(0, 1));
  const flat = chooseCurveSampleCount(constantCurve(3));
  check('simple curves get small tables', cheap <= 9 && flat <= 9, `linear ${cheap}, flat ${flat}`);
}

{
  // And a step must not be silently smoothed into a ramp by a small table.
  const stepped = CURVE_PRESETS.find((p) => p.id === 'pulse').build();
  check('stepped curves get the largest table', chooseCurveSampleCount(stepped) === 257);
}

// ---------------------------------------------------------------------------
// 5. Engine conversions preserve the author's keys
// ---------------------------------------------------------------------------
// The header of curve.js claims import is a field rename. These check the
// claim rather than trusting it.
{
  const curve = createCurve([
    { t: 0, v: 0 },
    { t: 0.5, v: 1, interp: CURVE_INTERP.CONSTANT },
    { t: 1, v: 0.25 },
  ]);
  const unity = curveToUnityKeyframes(curve);
  const unreal = curveToUnrealRichCurve(curve);

  const sameCount = unity.length === curve.keys.length && unreal.length === curve.keys.length;
  check('conversions preserve key count', sameCount, `${unity.length}/${unreal.length} of ${curve.keys.length}`);

  const timesValues = curve.keys.every((k, i) => (
    near(unity[i].time, k.t) && near(unity[i].value, k.v)
    && near(unreal[i].Time, k.t) && near(unreal[i].Value, k.v)
  ));
  check('conversions preserve times and values', timesValues);

  // Unity expresses a step with infinite tangents; Unreal with an interp mode.
  check('Unity encodes a step as infinite tangents', unity[1].outTangent === Infinity && unity[2].inTangent === Infinity);
  check('Unreal encodes a step as RCIM_Constant', unreal[1].InterpMode === 'RCIM_Constant');
  check('non-step keys keep finite tangents', Number.isFinite(unity[0].outTangent) && Number.isFinite(unreal[0].LeaveTangent));
}

{
  // A clamped auto tangent must reach the engines as the flat tangent it is,
  // or the overshoot we just removed comes straight back on import.
  const curve = createCurve([{ t: 0, v: 0 }, { t: 0.15, v: 1 }, { t: 0.7, v: 1 }, { t: 1, v: 0 }]);
  const unity = curveToUnityKeyframes(curve);
  const flatAtPeaks = near(unity[1].outTangent, 0) && near(unity[2].inTangent, 0);
  check('clamped tangents export as flat', flatAtPeaks, `${unity[1].outTangent.toFixed(3)} / ${unity[2].inTangent.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log('\n--- Editing ---');
// ---------------------------------------------------------------------------
//
// The curve editor is canvas and pointer capture, so none of its DRAWING can be
// checked here. What can be checked is the part that actually goes wrong: the
// sort. A key dragged past its neighbour changes its own index, and an editor
// that lost track of which key it was dragging would silently start dragging a
// different one.
{
  const ramp = linearCurve(0, 1);

  const added = addCurveKey(ramp, 0.5);
  check('addCurveKey inserts in order',
    added.curve.keys.map((k) => k.t).join(',') === '0,0.5,1');
  check('  and reports where it landed', added.index === 1);
  // THE BEHAVIOUR THAT MATTERS: clicking empty space to add a key must not
  // change the shape. An author adding a key is pinning a curve they already
  // like.
  const before = [0, 0.25, 0.5, 0.75, 1].map((t) => evalCurve(ramp, t));
  const after = [0, 0.25, 0.5, 0.75, 1].map((t) => evalCurve(added.curve, t));
  check('  without changing the curve',
    before.every((v, i) => Math.abs(v - after[i]) < 1e-9),
    after.map((v) => v.toFixed(3)).join(','));

  // A key added into a stepped segment stays stepped, or adding a key would
  // silently smooth a curve the author had deliberately made discrete.
  const stepped = createCurve([
    { t: 0, v: 0, interp: CURVE_INTERP.CONSTANT },
    { t: 1, v: 1, interp: CURVE_INTERP.CONSTANT },
  ]);
  check('  inheriting the interpolation it was dropped into',
    addCurveKey(stepped, 0.5).curve.keys[1].interp === CURVE_INTERP.CONSTANT);

  // THE SORT. Drag the middle key left past the first one.
  const three = addCurveKey(ramp, 0.5).curve;
  const dragged = moveCurveKey(three, 1, { t: -0.5, v: 0.9 });
  check('moveCurveKey clamps into 0..1',
    dragged.curve.keys.every((k) => k.t >= 0 && k.t <= 1));
  check('  and FOLLOWS the key it moved past its neighbour',
    Math.abs(dragged.curve.keys[dragged.index].v - 0.9) < 1e-9,
    `index ${dragged.index}, v ${dragged.curve.keys[dragged.index].v}`);
  check('  keeping every key', dragged.curve.keys.length === 3);

  check('removeCurveKey removes one', removeCurveKey(three, 1).curve.keys.length === 2);
  // A curve with no keys evaluates to zero, which on a size or alpha property
  // means invisible - the author would press Delete and lose the effect.
  const single = createCurve([{ t: 0, v: 1 }]);
  check('  but refuses the last one', removeCurveKey(single, 0).curve === single);
  check('  and reports -1 when it refused', removeCurveKey(single, 0).index === -1);

  check('cycleKeyInterp walks smooth -> straight -> step -> smooth',
    ['auto', 'linear', 'constant'].every((mode, i) => {
      const from = createCurve([{ t: 0, v: 0, interp: mode }, { t: 1, v: 1 }]);
      const expected = ['linear', 'constant', 'auto'][i];
      return cycleKeyInterp(from, 0).curve.keys[0].interp === expected;
    }));
  // 'free' is reached by dragging a handle, never by cycling - so a
  // double-click on a hand-tuned key returns it to smooth rather than landing
  // somewhere arbitrary.
  const freeKey = createCurve([{ t: 0, v: 0, interp: CURVE_INTERP.FREE }, { t: 1, v: 1 }]);
  check('  and a hand-tuned key cycles back to smooth',
    cycleKeyInterp(freeKey, 0).curve.keys[0].interp === CURVE_INTERP.AUTO);

  // Switching TO free must not move the curve: the handles are seeded from what
  // auto was already producing, so taking manual control starts from the shape
  // on screen.
  const hump = createCurve([{ t: 0, v: 0 }, { t: 0.5, v: 1 }, { t: 1, v: 0 }]);
  const freed = setKeyInterp(hump, 0, CURVE_INTERP.FREE);
  const sameShape = [0.1, 0.2, 0.3, 0.4].every(
    (t) => Math.abs(evalCurve(hump, t) - evalCurve(freed.curve, t)) < 1e-9,
  );
  check('setKeyInterp to free seeds the handles from auto', sameShape,
    [0.1, 0.2, 0.3, 0.4].map((t) => evalCurve(freed.curve, t).toFixed(4)).join(','));

  const tangent = setKeyTangent(hump, 1, 'out', 3);
  check('setKeyTangent implies free', tangent.curve.keys[1].interp === CURVE_INTERP.FREE);
  check('  and stores the slope', Math.abs(tangent.curve.keys[1].outTangent - 3) < 1e-9);
  // Dragging the IN handle frees the PREVIOUS segment, because that is the
  // segment whose far end the handle controls.
  const inTangent = setKeyTangent(hump, 1, 'in', -2);
  check('  while an in-handle frees the segment BEFORE it',
    inTangent.curve.keys[0].interp === CURVE_INTERP.FREE
    && Math.abs(inTangent.curve.keys[1].inTangent + 2) < 1e-9);

  // The accessible name. A canvas is invisible to a screen reader, so this
  // sentence is the entire description of the widget for anyone not looking at
  // it.
  const words = describeCurve(hump);
  check('describeCurve says the shape in words',
    words.includes('hump') && words.includes('3 keys'), words);
  check('  and a flat curve says so', describeCurve(constantCurve(2)).includes('flat'),
    describeCurve(constantCurve(2)));

  // Immutability, for the same reason as every edit in src/utils/vfx/edits.js:
  // the undo history is snapshot-based.
  const frozen = JSON.stringify(hump);
  addCurveKey(hump, 0.25);
  moveCurveKey(hump, 0, { t: 0.4 });
  removeCurveKey(hump, 1);
  setKeyTangent(hump, 0, 'out', 9);
  check('every curve mutator leaves its input alone', JSON.stringify(hump) === frozen);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
