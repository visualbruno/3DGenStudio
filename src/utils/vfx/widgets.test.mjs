// Checks for the phase-7 widget support code: the empty-preview decision table
// and the clipboard envelope.
// No test framework - run it directly:
//
//     node src/utils/vfx/widgets.test.mjs
//
// NEITHER OF THE WIDGETS THEMSELVES CAN BE TESTED HERE, and that is the reason
// this file exists. The curve and gradient editors are canvas plus pointer
// capture, so their drawing and their gestures need a browser and a pair of
// eyes. What was extracted OUT of them - the key/stop mutators in vfx/curve.js
// and vfx/gradient.js, the blame table, the clipboard envelope - is where the
// logic that can be wrong without looking wrong actually lives.
//
// THE BLAME TABLE IS THE ONE THAT MATTERS. Its whole job is choosing WHICH of
// several simultaneously-true complaints to show, and the wrong choice sends
// an author to fix something that was never broken. That is a decision table,
// and a decision table is exactly the kind of thing to check exhaustively
// rather than by staring at a viewport.

import { BLAME_ACTION, diagnoseEmptyPreview } from './blame.js';
import { CLIP_KIND, decodeClip, encodeClip } from './clipboard.js';
import { CURVE_PRESETS, evalCurve } from '../../../vfx/curve.js';
import { GRADIENT_PRESETS, evalGradient } from '../../../vfx/gradient.js';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(56)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

// A preview that is working: something alive, something drawn, in view.
const healthy = {
  diagnostics: [],
  spawned: 400,
  alive: 90,
  drawn: 90,
  playing: true,
  finished: false,
  mutedSystems: 0,
  totalSystems: 1,
  onScreen: true,
};

console.log('\n--- 1. Nothing to explain ---');
{
  check('a working preview produces no complaint',
    diagnoseEmptyPreview(healthy) === null);
  // The table is asked four times a second whether anything is wrong, so a
  // missing input must not be read as a fault.
  check('an empty input does not invent a complaint',
    diagnoseEmptyPreview({}).code === 'B_NO_SPAWN_YET',
    diagnoseEmptyPreview({}).code);
  check('  nor does a null one', diagnoseEmptyPreview(null).code === 'B_NO_SPAWN_YET');
  // onScreen: null means "could not be determined" - no camera yet, or nothing
  // alive to test. It must never be read as "off screen", or the overlay would
  // accuse a working effect during the first frame after a mount.
  check('an undetermined frustum test is not read as off-screen',
    diagnoseEmptyPreview({ ...healthy, onScreen: null }) === null);
}

console.log('\n--- 2. Causal order ---');
{
  // THE RULE: an effect with no Spawn block ALSO has nothing alive, nothing
  // drawn, and (vacuously) nothing on screen. All four complaints are true and
  // only the first is useful - naming a downstream symptom sends the author to
  // fix something that was never broken.
  const compileError = {
    severity: 'error',
    code: 'E_NO_SPAWN',
    title: 'Nothing is being emitted',
    message: '"Sparks" has no spawn block.',
    hint: 'A Spawn Rate block emits a steady stream.',
    fix: { label: 'Add Spawn Rate', action: 'addBlock', args: {} },
  };
  const broken = {
    ...healthy,
    diagnostics: [compileError],
    spawned: 0,
    alive: 0,
    drawn: 0,
    onScreen: false,
  };
  const blame = diagnoseEmptyPreview(broken);
  check('a compile error wins over every symptom it causes',
    blame.code === 'E_NO_SPAWN', blame.code);
  check('  and carries its own one-click fix', blame.fix === compileError.fix);
  // The hint is the half that teaches, so it is appended rather than dropped.
  check('  and appends the hint to the message',
    blame.message.includes('steady stream'), blame.message);

  // A warning is NOT a reason to show the overlay: the diagnostics strip
  // already lists warnings, and an overlay for something that is merely
  // suboptimal would cover a working preview.
  const warned = {
    ...broken,
    diagnostics: [{ severity: 'warn', code: 'W_CAPACITY', title: 'x', message: 'y' }],
  };
  check('a warning does not pre-empt the symptom analysis',
    diagnoseEmptyPreview(warned).code === 'B_NO_SPAWN_YET',
    diagnoseEmptyPreview(warned).code);
}

console.log('\n--- 3. Every branch, in order ---');
{
  // Solo left on. Checked BEFORE "nothing was emitted", because it IS why
  // nothing was emitted - and because a forgotten solo is a genuinely common
  // way to lose an afternoon.
  const muted = diagnoseEmptyPreview({
    ...healthy, spawned: 0, alive: 0, drawn: 0, mutedSystems: 3, totalSystems: 3,
  });
  check('all systems silenced is named before "nothing emitted"',
    muted.code === 'B_ALL_MUTED', muted.code);
  check('  offering to un-mute', muted.action === BLAME_ACTION.UNMUTE);
  // It is preview state, not document state, and the message has to say so or
  // the author will look for it in the saved effect.
  check('  and says it is not saved with the effect',
    muted.message.includes('not saved'), muted.message);
  check('SOME systems silenced is not a complaint at all',
    diagnoseEmptyPreview({ ...healthy, mutedSystems: 2, totalSystems: 3 }) === null);

  const paused = diagnoseEmptyPreview({
    ...healthy, spawned: 0, alive: 0, drawn: 0, playing: false,
  });
  check('paused at the start says so rather than blaming the graph',
    paused.code === 'B_PAUSED_AT_START', paused.code);
  check('  offering Play', paused.action === BLAME_ACTION.PLAY);

  const notYet = diagnoseEmptyPreview({ ...healthy, spawned: 0, alive: 0, drawn: 0 });
  check('running but nothing emitted points at the clips',
    notYet.code === 'B_NO_SPAWN_YET' && notYet.message.includes('clip'), notYet.code);

  const finished = diagnoseEmptyPreview({ ...healthy, alive: 0, drawn: 0, finished: true });
  check('a finished non-looping effect says it finished',
    finished.code === 'B_FINISHED', finished.code);
  check('  and mentions the loop toggle', finished.message.includes('Loop'), finished.message);

  const dead = diagnoseEmptyPreview({ ...healthy, alive: 0, drawn: 0 });
  check('everything dead but not finished blames the lifetime',
    dead.code === 'B_ALL_DEAD' && dead.message.includes('Lifetime'), dead.code);

  // The write loop skips a particle with no size, so alive-but-not-drawn is
  // almost always a size of zero - including a size-over-life curve that
  // reaches zero a fraction early.
  const invisible = diagnoseEmptyPreview({ ...healthy, drawn: 0 });
  check('alive but nothing written blames the size',
    invisible.code === 'B_NOTHING_WRITTEN', invisible.code);
  check('  and quotes how many are alive', invisible.message.includes('90'),
    invisible.message);

  // THE TRAP THE WHOLE MODULE EXISTS FOR. This looks identical to every case
  // above - an empty viewport - and its fix is the opposite of theirs.
  const offScreen = diagnoseEmptyPreview({ ...healthy, onScreen: false });
  check('drawn but out of frame is "off screen", NOT "no particles"',
    offScreen.code === 'B_OFF_SCREEN', offScreen.code);
  check('  offering to frame the effect', offScreen.action === BLAME_ACTION.FRAME);
  // Said explicitly, because the author's instinct on seeing an empty viewport
  // is to go and edit the graph.
  check('  and says the graph is fine',
    offScreen.message.includes('Nothing is wrong with the graph'), offScreen.message);
}

console.log('\n--- 4. Every answer is actionable ---');
{
  // A complaint with neither a fix nor an action is a dead end: the author
  // reads it and has nowhere to go. B_NOTHING_WRITTEN is the one deliberate
  // exception - "your size is zero" has no single safe automatic repair,
  // because which of several properties is at fault is a judgement.
  const cases = [
    ['B_ALL_MUTED', { ...healthy, spawned: 0, mutedSystems: 2, totalSystems: 2 }],
    ['B_PAUSED_AT_START', { ...healthy, spawned: 0, playing: false }],
    ['B_NO_SPAWN_YET', { ...healthy, spawned: 0 }],
    ['B_FINISHED', { ...healthy, alive: 0, drawn: 0, finished: true }],
    ['B_ALL_DEAD', { ...healthy, alive: 0, drawn: 0 }],
    ['B_OFF_SCREEN', { ...healthy, onScreen: false }],
  ];
  const inert = [];
  for (const [code, input] of cases) {
    const blame = diagnoseEmptyPreview(input);
    if (blame?.code !== code) inert.push(`${code}!=${blame?.code}`);
    else if (!blame.fix && !blame.action) inert.push(`${code}:no action`);
    else if (blame.action && !blame.actionLabel) inert.push(`${code}:no label`);
  }
  check('every complaint offers a fix or an action', inert.length === 0, inert.join(', '));
  // And every one has to be a real sentence, because they are read by someone
  // who does not yet know the vocabulary.
  const terse = cases
    .map(([, input]) => diagnoseEmptyPreview(input))
    .filter(blame => !blame || blame.message.length < 40 || !blame.title);
  check('  with a title and a message that explains itself', terse.length === 0,
    String(terse.length));
}

console.log('\n--- 5. The clipboard envelope ---');
{
  const spike = CURVE_PRESETS.find(p => p.id === 'rampDown').build();
  const text = encodeClip(CLIP_KIND.CURVE, spike);

  // PLAIN TEXT, READABLE BY A PERSON. The whole reason for the format: a curve
  // pastes into a chat message or a source file and comes back out.
  check('a clip encodes to readable JSON',
    text.includes('"__vfxClip"') && text.includes('\n') && text.includes('  '),
    `${text.length} chars`);

  const round = decodeClip(text, CLIP_KIND.CURVE);
  check('and decodes back', round.ok === true, round.error || '');
  const same = [0, 0.25, 0.5, 0.75, 1].every(
    t => Math.abs(evalCurve(spike, t) - evalCurve(round.payload, t)) < 1e-9,
  );
  check('  to the same curve', same);

  const fire = GRADIENT_PRESETS.find(p => p.id === 'fire').build();
  const gradientRound = decodeClip(encodeClip(CLIP_KIND.GRADIENT, fire), CLIP_KIND.GRADIENT);
  check('a gradient round-trips too', gradientRound.ok === true);
  const rgbaA = evalGradient(fire, 0.3, new Float64Array(4));
  const rgbaB = evalGradient(gradientRound.payload, 0.3, new Float64Array(4));
  check('  losslessly', rgbaA.every((v, i) => Math.abs(v - rgbaB[i]) < 1e-9));

  // Pasting a gradient onto a size property has no meaning, and the failure has
  // to be a message rather than a curve with colorKeys in it that the compiler
  // chokes on somewhere far away.
  const wrongKind = decodeClip(encodeClip(CLIP_KIND.GRADIENT, fire), CLIP_KIND.CURVE);
  check('a gradient is refused where a curve is expected', wrongKind.ok === false);
  check('  naming both kinds',
    wrongKind.error.includes('gradient') && wrongKind.error.includes('curve'),
    wrongKind.error);

  check('junk is refused', decodeClip('hello').ok === false);
  check('  and so is unrelated JSON', decodeClip('{"a":1}').ok === false);
  check('  and empty text', decodeClip('').ok === false);
  // Refused with a message that says what to do, rather than importing fields
  // this build does not understand.
  const future = decodeClip(JSON.stringify({
    __vfxClip: 'vfx-clip', version: 99, kind: 'curve', payload: {},
  }));
  check('a newer version is refused with a reason',
    future.ok === false && future.error.includes('newer'), future.error);

  // HAND-EDITED TEXT IS AN INTENDED INPUT - that is what plain text is for - so
  // a clip with keys out of order is repaired rather than rejected.
  const messy = decodeClip(JSON.stringify({
    __vfxClip: 'vfx-clip',
    version: 1,
    kind: 'curve',
    payload: { keys: [{ t: 1, v: 0 }, { t: 0, v: 1 }, { t: 0.5, v: 0.5 }] },
  }), CLIP_KIND.CURVE);
  check('hand-edited keys are re-sorted rather than rejected',
    messy.ok === true && messy.payload.keys.map(k => k.t).join(',') === '0,0.5,1',
    messy.ok ? messy.payload.keys.map(k => k.t).join(',') : messy.error);
  // And a clip with no keys at all still produces an evaluable curve, because
  // the alternative is throwing on a path that runs sixty times a second.
  const bare = decodeClip(JSON.stringify({
    __vfxClip: 'vfx-clip', version: 1, kind: 'curve', payload: {},
  }), CLIP_KIND.CURVE);
  check('  and a keyless clip still evaluates',
    bare.ok === true && Number.isFinite(evalCurve(bare.payload, 0.5)));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
