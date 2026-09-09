// Checks for vfx/gradient.js. No test framework - run it directly:
//
//     node vfx/gradient.test.mjs
//
// Colour is where this app has been burned before - the headers of
// src/utils/gpuTextureBake.js and src/utils/assemblyAtlasBake.js each document
// an sRGB round trip that went wrong and made everything too dark. The failure
// mode is always the same: the result looks plausible, nobody can say which
// stage lost the conversion, and it is only obvious side by side with a correct
// render. So the cases below pin the conversions numerically rather than
// trusting that they look right.
//
// The most important case is "interpolates in linear space". Interpolating a
// black-to-white ramp in sRGB instead puts the midpoint at 0.5 sRGB, which is
// only 0.21 linear - a ramp that reads as muddy through its middle. Both
// versions produce a gradient; only one produces the right one.
//
// KNOWN GAP: nothing here checks how a gradient looks once the ACES tonemapper
// has had it, which is where HDR stops above 1 actually earn their keep. That
// needs a rendered frame and belongs to the phase-4 viewport work. What is
// verified here is that values above 1 survive the representation and the bake
// intact, so there is something for the tonemapper to work with.
import {
  GRADIENT_MODE,
  GRADIENT_PRESETS,
  bakeGradient,
  chooseGradientSampleCount,
  createGradient,
  evalGradient,
  evalGradientLut,
  gradientAlphaExtent,
  gradientMaxComponent,
  gradientMeanLuminance,
  gradientToUnityGradient,
  gradientToUnrealCurveLinearColor,
  hexToSrgb,
  linearToSrgb,
  srgbToHex,
  srgbToLinear,
} from './gradient.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(48)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const out = new Float64Array(4);

// ---------------------------------------------------------------------------
// 1. Colour space conversions
// ---------------------------------------------------------------------------
{
  let worst = 0;
  for (let i = 0; i <= 255; i += 1) {
    const c = i / 255;
    worst = Math.max(worst, Math.abs(linearToSrgb(srgbToLinear(c)) - c));
  }
  check('srgb -> linear -> srgb round trips', worst < 1e-12, `worst ${worst.toExponential(1)}`);
}

{
  // The transfer function, not pow(2.2). Mid-grey 0.5 sRGB is 0.2140 linear
  // under IEC 61966-2-1; the approximation gives 0.2176. Small, but it is
  // exactly the sort of small that accumulates into a visible mismatch with
  // three.js and both engines.
  check('srgbToLinear uses the real transfer curve', near(srgbToLinear(0.5), 0.21404114, 1e-7), srgbToLinear(0.5).toFixed(8));
  check('srgbToLinear is exact at the ends', srgbToLinear(0) === 0 && near(srgbToLinear(1), 1));
}

{
  const ok = srgbToHex(...hexToSrgb('#3fa9c7')) === '#3fa9c7'
    && srgbToHex(...hexToSrgb('#f80')) === '#ff8800'
    && srgbToHex(...hexToSrgb('nonsense')) === '#ffffff';
  check('hex parsing round trips and falls back', ok);
}

// ---------------------------------------------------------------------------
// 2. Interpolation happens in LINEAR space
// ---------------------------------------------------------------------------
{
  const ramp = createGradient({
    colorKeys: [{ t: 0, hex: '#000000' }, { t: 1, hex: '#ffffff' }],
    alphaKeys: [{ t: 0, a: 1 }],
  });
  evalGradient(ramp, 0.5, out);
  // Linear interpolation of linear 0 and linear 1 is linear 0.5, which is
  // 0.7354 in sRGB. An sRGB-space blend would give linear 0.2140 instead.
  const linearMid = near(out[0], 0.5, 1e-6);
  const srgbOfMid = linearToSrgb(out[0]);
  check('black to white midpoint is linear 0.5', linearMid, `linear ${out[0].toFixed(4)}, srgb ${srgbOfMid.toFixed(4)}`);
  check('  (an sRGB blend would give 0.2140)', !near(out[0], 0.2140, 1e-3));
}

{
  const ramp = createGradient({ colorKeys: [{ t: 0, hex: '#ff0000' }, { t: 1, hex: '#0000ff' }] });
  evalGradient(ramp, 0, out);
  const startsRed = near(out[0], 1) && near(out[2], 0);
  evalGradient(ramp, 1, out);
  const endsBlue = near(out[0], 0) && near(out[2], 1);
  check('endpoints match the outer stops', startsRed && endsBlue);
}

// ---------------------------------------------------------------------------
// 3. Colour and alpha are genuinely independent
// ---------------------------------------------------------------------------
{
  // The case a merged key list cannot represent: three colour stops, seven
  // alpha stops. Both counts must survive a build unchanged.
  const gradient = createGradient({
    colorKeys: [{ t: 0, hex: '#ff0000' }, { t: 0.5, hex: '#00ff00' }, { t: 1, hex: '#0000ff' }],
    alphaKeys: [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((t, i) => ({ t, a: i % 2 })),
  });
  check(
    'independent colour and alpha stop counts',
    gradient.colorKeys.length === 3 && gradient.alphaKeys.length === 7,
    `${gradient.colorKeys.length} colour / ${gradient.alphaKeys.length} alpha`,
  );

  // Alpha must be sampled off its own axis, not the colour axis. At t=0.2 the
  // alpha is mid-way between the stops at 0.1 (a=1) and 0.3 (a=0).
  evalGradient(gradient, 0.2, out);
  check('alpha samples its own key list', near(out[3], 0.5, 1e-6), `a ${out[3].toFixed(3)}`);
}

{
  // Out-of-range input is a real case for a hand-edited document.
  const gradient = createGradient({
    colorKeys: [{ t: -3, hex: '#112233' }, { t: 9, hex: '#445566' }],
    alphaKeys: [{ t: 0, a: 4 }, { t: 1, a: -2 }],
  });
  const clampedT = gradient.colorKeys[0].t === 0 && gradient.colorKeys[1].t === 1;
  const clampedA = gradient.alphaKeys[0].a === 1 && gradient.alphaKeys[1].a === 0;
  check('stop times and alpha are clamped on build', clampedT && clampedA);
}

{
  const gradient = createGradient({
    colorKeys: [{ t: 1, hex: '#ffffff' }, { t: 0, hex: '#000000' }],
  });
  check('stops are sorted on build', gradient.colorKeys[0].t === 0);
}

{
  const gradient = createGradient({});
  evalGradient(gradient, 0.5, out);
  const white = near(out[0], 1) && near(out[1], 1) && near(out[2], 1) && near(out[3], 1);
  check('empty gradient defaults to opaque white', white);
}

// ---------------------------------------------------------------------------
// 4. HDR survives, alpha does not go premultiplied
// ---------------------------------------------------------------------------
{
  const gradient = createGradient({
    colorKeys: [{ t: 0, hex: '#ffffff', intensity: 4 }],
    alphaKeys: [{ t: 0, a: 0.25 }],
  });
  evalGradient(gradient, 0, out);
  check('intensity scales linear colour above 1', near(out[0], 4), `r ${out[0].toFixed(3)}`);
  // If anything premultiplied here, r would be 1.0 (4 * 0.25) and the shader's
  // own premultiply would then square the alpha - which is the classic reason
  // an additive fade looks wrong at the tail.
  check('alpha is straight, not premultiplied', near(out[0], 4) && near(out[3], 0.25));
}

{
  const hdr = GRADIENT_PRESETS.find((p) => p.id === 'electric').build();
  const sdr = GRADIENT_PRESETS.find((p) => p.id === 'smoke').build();
  check(
    'gradientMaxComponent drives byte packing',
    gradientMaxComponent(hdr) > 1 && gradientMaxComponent(sdr) <= 1,
    `electric ${gradientMaxComponent(hdr).toFixed(2)}, smoke ${gradientMaxComponent(sdr).toFixed(2)}`,
  );
}

{
  // The additive diagnostic's core claim: brightness alone is not the signal,
  // brightness times alpha is. A blinding ramp at 1% alpha adds no light.
  const bright = createGradient({
    colorKeys: [{ t: 0, hex: '#ffffff', intensity: 5 }],
    alphaKeys: [{ t: 0, a: 1 }],
  });
  const brightButInvisible = createGradient({
    colorKeys: [{ t: 0, hex: '#ffffff', intensity: 5 }],
    alphaKeys: [{ t: 0, a: 0.01 }],
  });
  const a = gradientMeanLuminance(bright);
  const b = gradientMeanLuminance(brightButInvisible);
  check('mean luminance accounts for alpha', a > 4 && b < 0.1, `${a.toFixed(2)} vs ${b.toFixed(3)}`);
}

{
  const gradient = GRADIENT_PRESETS.find((p) => p.id === 'smoke').build();
  const extent = gradientAlphaExtent(gradient);
  check('alpha extent reports the real range', extent.min === 0 && extent.max > 0.5, `${extent.min}..${extent.max}`);
}

// ---------------------------------------------------------------------------
// 5. Fixed mode, and the bake
// ---------------------------------------------------------------------------
{
  const banded = createGradient({
    mode: GRADIENT_MODE.FIXED,
    colorKeys: [{ t: 0, hex: '#ff0000' }, { t: 0.5, hex: '#00ff00' }],
    alphaKeys: [{ t: 0, a: 1 }],
  });
  evalGradient(banded, 0.49, out);
  const stillRed = near(out[0], 1) && near(out[1], 0);
  evalGradient(banded, 0.51, out);
  const nowGreen = near(out[0], 0) && near(out[1], 1);
  check('fixed mode holds hard bands', stillRed && nowGreen);
}

{
  // The simulation samples the LUT, not the gradient, so any drift here is an
  // effect that is quietly not the one the author saw in the editor.
  //
  // Error is judged RELATIVE to each channel's own range. An absolute bound was
  // the first attempt and is meaningless here: the worst offender is an HDR
  // colour channel that peaks at 6, where an absolute 0.02 is 0.3% of range,
  // while the same 0.02 on an alpha ramp is 2%. One number cannot mean both.
  // Matches DEFAULT_MAX_GRADIENT_BAKE_ERROR; see vfx/bake.js for why gradients
  // get a looser bound than curves (kinks converge linearly, curvature does not).
  const TOLERANCE = 0.02;
  let worstId = '';
  let worstRel = 0;
  for (const preset of GRADIENT_PRESETS) {
    const gradient = preset.build();
    if (gradient.mode === GRADIENT_MODE.FIXED) continue;
    const lut = bakeGradient(gradient, chooseGradientSampleCount(gradient));
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    const lo = [Infinity, Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i <= 511; i += 1) {
      evalGradient(gradient, i / 511, a);
      for (let c = 0; c < 4; c += 1) {
        if (a[c] < lo[c]) lo[c] = a[c];
        if (a[c] > hi[c]) hi[c] = a[c];
      }
    }
    for (let i = 0; i <= 511; i += 1) {
      const t = i / 511;
      evalGradient(gradient, t, a);
      evalGradientLut(lut, t, b);
      for (let c = 0; c < 4; c += 1) {
        const range = hi[c] - lo[c];
        if (range <= 1e-9) continue;
        const rel = Math.abs(a[c] - b[c]) / range;
        if (rel > worstRel) {
          worstRel = rel;
          worstId = preset.id;
        }
      }
    }
  }
  check(
    'baked gradients match the evaluator',
    worstRel <= TOLERANCE,
    `worst ${worstId} at ${(worstRel * 100).toFixed(3)}% of range`,
  );
}

{
  // Simple ramps must not pay for the worst case, and a tight HDR spike must
  // be allowed to pay for itself.
  const flat = chooseGradientSampleCount(createGradient({
    colorKeys: [{ t: 0, hex: '#808080' }],
    alphaKeys: [{ t: 0, a: 1 }],
  }));
  const spiky = chooseGradientSampleCount(GRADIENT_PRESETS.find((p) => p.id === 'electric').build());
  check('gradient table size adapts', flat <= 9 && spiky >= flat, `flat ${flat}, electric ${spiky}`);
}

{
  const lut = bakeGradient(GRADIENT_PRESETS[0].build(), 33);
  const a = new Float64Array(4);
  evalGradient(GRADIENT_PRESETS[0].build(), 0, a);
  evalGradientLut(lut, 0, out);
  const startOk = near(a[0], out[0], 1e-6) && near(a[3], out[3], 1e-6);
  evalGradient(GRADIENT_PRESETS[0].build(), 1, a);
  evalGradientLut(lut, 1, out);
  const endOk = near(a[0], out[0], 1e-6) && near(a[3], out[3], 1e-6);
  check('LUT endpoints are exact', startOk && endOk);
}

{
  // Non-allocating contract: the runtime calls this per particle, so it has to
  // write through rather than return a fresh array.
  const target = new Float64Array(4);
  const returned = evalGradient(GRADIENT_PRESETS[0].build(), 0.5, target);
  check('evalGradient writes through to out', returned === target);
}

// ---------------------------------------------------------------------------
// 6. Engine conversions
// ---------------------------------------------------------------------------
{
  const gradient = createGradient({
    colorKeys: [{ t: 0, hex: '#ff0000' }, { t: 1, hex: '#0000ff' }],
    alphaKeys: [{ t: 0, a: 0 }, { t: 0.4, a: 1 }, { t: 1, a: 0.2 }],
  });
  const unity = gradientToUnityGradient(gradient);
  check(
    'Unity keeps colour and alpha lists separate',
    unity.colorKeys.length === 2 && unity.alphaKeys.length === 3,
    `${unity.colorKeys.length} / ${unity.alphaKeys.length}`,
  );
  check('Unity carries linear colour', near(unity.colorKeys[0].linear[0], 1) && near(unity.colorKeys[0].linear[2], 0));

  // Niagara wants one RGBA curve, so the two axes merge. The merge claims to be
  // lossless for piecewise-linear data - check it at every original stop time.
  const unreal = gradientToUnrealCurveLinearColor(gradient);
  const times = unreal.map((k) => k.Time);
  const hasAll = [0, 0.4, 1].every((t) => times.some((x) => near(x, t)));
  check('Unreal merge keeps every stop time', hasAll, times.join(' '));

  let worst = 0;
  for (const key of unreal) {
    evalGradient(gradient, key.Time, out);
    worst = Math.max(worst, Math.abs(out[0] - key.R), Math.abs(out[3] - key.A));
  }
  check('Unreal merge is lossless at the stops', worst < 1e-9, `worst ${worst.toExponential(1)}`);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
