// node animation/animation.test.mjs
//
// Plain-node tests, no harness - same convention as building/*.test.mjs.
// Fixtures are the bundled mesh2motion rigs in resources/animations (real
// skinned GLBs, one per species), so the labelling rules are checked against
// the shapes they were written for.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadRig, skinPositions, computeNodeWorlds } from './gltfRig.js';
import { describeRig } from './analyze.js';
import { inspectRig } from './inspect.js';
import { createPoseContext, buildPose } from './pose.js';
import { normalizeSpec, compileSpec, analyzeMotion, sampleChannel } from './compile.js';
import { writeClip, listClips, clipSampler, removeClip } from './glbAnimation.js';
import { openRig, renderRigViews, previewSpec } from './index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = name => fs.readFileSync(path.join(ROOT, 'resources', 'animations', `${name}-animations.glb`));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.stack || err.message}`); process.exitCode = 1; }
}

const rigs = {};
const get = (name) => {
  if (!rigs[name]) {
    const buffer = fixture(name);
    const rig = loadRig(buffer);
    rigs[name] = { buffer, rig, description: describeRig(rig) };
  }
  return rigs[name];
};
const labels = d => d.chains.map(c => c.label);
const kinds = (d, kind) => d.chains.filter(c => c.kind === kind).map(c => c.label).sort();

// ---- loading -----------------------------------------------------------------

test('rest pose re-skins onto the stored vertices (inverse binds read right)', () => {
  for (const name of ['fox', 'spider', 'dragon', 'human-base']) {
    const { rig } = get(name);
    const p = skinPositions(rig, null);
    let err = 0;
    for (let i = 0; i < p.length; i += 1) err = Math.max(err, Math.abs(p[i] - rig.geometry.positions[i]));
    assert.ok(err < 1e-4, `${name}: ${err}`);
  }
});

// ---- perception ----------------------------------------------------------------

test('fox: quadruped, four legs front/hind L/R, tail, ears on the head', () => {
  const { description: d } = get('fox');
  assert.equal(d.bodyPlan, 'quadruped');
  assert.equal(d.frame.forward, '+z');
  assert.deepEqual(kinds(d, 'leg'), ['leg_front_L', 'leg_front_R', 'leg_hind_L', 'leg_hind_R']);
  assert.ok(labels(d).includes('tail'));
  assert.ok(d.chains.find(c => c.label === 'leg_front_L').bones.includes('Front_Leg_Upper_L'), 'left is the creature\'s left');
  assert.ok(d.chains.some(c => c.kind === 'head_appendage' && c.bones.includes('Ear_L')));
});

test('spider: eight legs through the shared anchor stub, fangs on the head', () => {
  const { description: d } = get('spider');
  assert.equal(d.bodyPlan, '8-legged');
  assert.equal(kinds(d, 'leg').length, 8);
  assert.ok(d.chains.some(c => c.kind === 'head_appendage' && c.bones.includes('teeth_l')));
});

test('bird: legs close to the mid line are legs, not trunk; two wings', () => {
  const { description: d } = get('bird');
  assert.deepEqual(kinds(d, 'leg'), ['leg_L', 'leg_R']);
  assert.deepEqual(kinds(d, 'wing'), ['wing_L', 'wing_R']);
  assert.ok(d.chains.find(c => c.label === 'tail').bones.includes('tail_1'));
});

test('dragon: wings, four legs, horns are head appendages not arms', () => {
  const { description: d } = get('dragon');
  assert.equal(kinds(d, 'leg').length, 4);
  assert.equal(kinds(d, 'wing').length, 2);
  assert.equal(kinds(d, 'arm').length, 0);
  assert.ok(d.chains.some(c => c.kind === 'head_appendage' && c.bones.includes('horn_l')));
});

test('horse: a raised neck does not make it upright; the root stub does not steal the tail', () => {
  const { description: d } = get('horse');
  assert.equal(d.bodyPlan, 'quadruped');
  assert.ok(d.chains.find(c => c.label === 'tail').bones.includes('tail_1'));
});

test('human: upright biped with arms and legs', () => {
  const { description: d } = get('human-base');
  assert.equal(d.bodyPlan, 'biped (humanoid-like)');
  assert.deepEqual(kinds(d, 'arm'), ['arm_L', 'arm_R']);
  assert.ok(d.chains.find(c => c.label === 'arm_L').bones.includes('upperarm_l'));
});

test('kaiju: small front limbs off the ground are arms', () => {
  const { description: d } = get('kaiju');
  assert.deepEqual(kinds(d, 'arm'), ['arm_L', 'arm_R']);
  assert.deepEqual(kinds(d, 'leg'), ['leg_L', 'leg_R']);
});

test('snake: limbless', () => {
  assert.match(get('snake').description.bodyPlan, /limbless/);
});

test('a rig profile renames chains, moves bones and overrides the facing', () => {
  const { rig } = get('fox');
  const d = describeRig(rig, { chainRenames: { tail: 'brush' }, boneChains: { Chin: 'jaw' }, forward: '-z' });
  assert.ok(labels(d).includes('brush'));
  assert.ok(d.chains.find(c => c.label === 'jaw').bones.includes('Chin'));
  assert.equal(d.frame.forward, '-z');
});

// ---- inspection ---------------------------------------------------------------------

test('inspect: the bundled rigs are ready; a misplaced floor is flagged with its fix', () => {
  assert.notEqual(inspectRig(get('fox').rig, get('fox').description).verdict, 'fix before animating');
  const { rig, description } = get('fox');
  const lifted = { ...description, size: { ...description.size, groundY: 0.5 } };
  const report = inspectRig(rig, lifted);
  assert.ok(report.issues.some(i => i.check === 'pivot' && i.fixTool === 'move_mesh_pivot'));
});

// ---- posing ---------------------------------------------------------------------------

const tipOf = (rig, pose, bone) => new THREE.Vector3().setFromMatrixPosition(computeNodeWorlds(rig, pose)[rig.joints[rig.jointByName.get(bone)].node]);

test('controls are body-relative: "forward" moves a leg tip forward, "out" mirrors', () => {
  const { rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const rest = tipOf(rig, null, 'Front_Leg_Tip_L');
  const fwd = tipOf(rig, buildPose(ctx, { targets: { leg_front_L: { forward: 30 } } }).pose, 'Front_Leg_Tip_L');
  assert.ok(fwd.z - rest.z > 0.1, 'tip moves toward +z (the fox faces +z)');
  const out = buildPose(ctx, { targets: { leg_front_L: { out: 20 }, leg_front_R: { out: 20 } } }).pose;
  const l = tipOf(rig, out, 'Front_Leg_Tip_L');
  const r = tipOf(rig, out, 'Front_Leg_Tip_R');
  assert.ok(l.x > tipOf(rig, null, 'Front_Leg_Tip_L').x && r.x < tipOf(rig, null, 'Front_Leg_Tip_R').x, 'both legs splay away from the mid line');
  assert.ok(Math.abs(l.x + r.x) < 0.02, 'symmetric');
});

test('chain.* spreads the angle (a curl) and opposite values mirror', () => {
  const { rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const a = tipOf(rig, buildPose(ctx, { targets: { 'tail.*': { left: 50 } } }).pose, 'Tail_End');
  const b = tipOf(rig, buildPose(ctx, { targets: { 'tail.*': { left: -50 } } }).pose, 'Tail_End');
  assert.ok(a.x > 0.2 && Math.abs(a.x + b.x) < 1e-3);
});

test('unknown targets and degenerate controls are reported, not silently dropped', () => {
  const { rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const { warnings } = buildPose(ctx, { targets: { tentacle: { up: 10 }, leg_front_L: { bend: 5 } } });
  assert.ok(warnings.some(w => /Unknown pose target "tentacle"/.test(w)));
  assert.ok(warnings.some(w => /unknown control/.test(w)));
});

test('IK plants a foot while the body rises, and keeps the foot\'s orientation', () => {
  const { rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const chain = description.chains.find(c => c.label === 'leg_hind_L');
  const ankle = chain.bones[chain.bones.length - 2];
  const rest = tipOf(rig, null, ankle);
  const { pose } = buildPose(ctx, { root: { up: 0.15 }, ik: { leg_hind_L: {} } });
  assert.ok(tipOf(rig, pose, ankle).distanceTo(rest) < 0.01, 'ankle stays where it stood');
  const free = buildPose(ctx, { root: { up: 0.15 } }).pose;
  assert.ok(tipOf(rig, free, ankle).distanceTo(rest) > 0.1, 'without IK it would have lifted');
});

// ---- spec + compile -------------------------------------------------------------------

test('normalizeSpec rejects bad specs and warns about stray fields', () => {
  assert.ok(normalizeSpec({}).errors.length);
  const { errors, warnings } = normalizeSpec({ duration: 1, keys: [{ time: 0, neck: {}, pose: { tail: { wiggle: 1 } } }] });
  assert.equal(errors.length, 0);
  assert.ok(warnings.some(w => /top level/.test(w)));
  assert.ok(warnings.some(w => /unknown control "wiggle"/.test(w)));
});

test('looping channels wrap; non-looping hold their ends', () => {
  const pts = [{ time: 0, value: 10 }, { time: 0.5, value: -10 }];
  assert.equal(sampleChannel(pts, 0.5, { duration: 1, loop: true, interpolation: 'smooth' }), -10);
  assert.ok(Math.abs(sampleChannel(pts, 1, { duration: 1, loop: true, interpolation: 'smooth' }) - 10) < 1e-9);
  assert.equal(sampleChannel(pts, 0.9, { duration: 1, loop: false, interpolation: 'linear' }), -10);
});

const WAG = {
  name: 'wag', duration: 1, loop: true,
  keys: [
    { time: 0, pose: { 'tail.*': { left: 40 } } },
    { time: 0.5, pose: { 'tail.*': { left: -40 } } }
  ]
};

test('compile: frames, an exact loop seam, only moving bones get channels', () => {
  const { rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const { spec } = normalizeSpec(WAG);
  const compiled = compileSpec(ctx, spec);
  assert.equal(compiled.clip.times.length, 31);
  assert.equal(compiled.clip.rotations.size, description.chains.find(c => c.label === 'tail').bones.length);
  const analysis = analyzeMotion(ctx, compiled);
  assert.equal(analysis.loopSeamDeg, 0);
});

test('GLB round trip: written clip samples back to the compiled pose; spec rides along', () => {
  const { buffer, rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const { spec } = normalizeSpec(WAG);
  const compiled = compileSpec(ctx, spec);
  const out = writeClip(buffer, rig, compiled.clip, { spec });
  const clips = listClips(out);
  const mine = clips.find(c => c.name === 'wag');
  assert.ok(mine && mine.hasSpec && mine.spec.keys.length === 2);
  assert.equal(clips.length, listClips(buffer).length + 1, 'other clips kept');
  const rig2 = loadRig(out);
  const sampler = clipSampler(rig2, mine.index);
  const a = skinPositions(rig, compiled.poses[12]);
  const b = skinPositions(rig2, sampler.sample(compiled.clip.times[12]));
  let err = 0;
  for (let i = 0; i < a.length; i += 1) err = Math.max(err, Math.abs(a[i] - b[i]));
  assert.ok(err < 1e-5, `vertex error ${err}`);
  // Replacing keeps one clip of that name; removing takes it out.
  const again = writeClip(out, rig2, compiled.clip, { spec });
  assert.equal(listClips(again).filter(c => c.name === 'wag').length, 1);
  assert.equal(removeClip(again, 'wag').removed, 1);
});

test('treadmill walks are recognised as in-place cycles, not sliding', () => {
  const { rig, description } = openRig(fixture('horse'));
  const legs = { leg_hind_L: 0, leg_front_L: 0.25, leg_hind_R: 0.5, leg_front_R: 0.75 };
  const keys = new Map();
  const add = (u, chain, v) => {
    const t = Math.round((((u % 1) + 1) % 1) * 1000) / 1000;
    if (!keys.has(t)) keys.set(t, { time: t, ik: {} });
    keys.get(t).ik[chain] = v;
  };
  for (const [c, ph] of Object.entries(legs)) {
    add(ph, c, { forward: 0.2, up: 0 }); add(ph + 0.6, c, { forward: -0.2, up: 0 }); add(ph + 0.8, c, { forward: 0, up: 0.12 });
  }
  const r = previewSpec(rig, description, { name: 'walk', duration: 1, loop: true, interpolation: 'linear', keys: [...keys.values()] }, { frames: 2 });
  assert.ok(r.analysis.notes.some(n => /In-place cycle/.test(n)), JSON.stringify(r.analysis.notes));
  assert.ok(r.analysis.largestFrameStepDeg < 30, `pop of ${r.analysis.largestFrameStepDeg} deg on ${r.analysis.largestFrameStepBone}`);
  assert.equal(r.analysis.loopSeamDeg, 0);
  assert.ok(r.png.length > 1000);
});

test('a control keyed once while its target is keyed elsewhere is flagged', () => {
  const { rig, description } = get('fox');
  const ctx = createPoseContext(rig, description);
  const { spec } = normalizeSpec({ duration: 1, keys: [
    { time: 0, ik: { leg_hind_L: { forward: 0.1 } } },
    { time: 0.5, ik: { leg_hind_L: { forward: -0.1, up: 0.05 } } }
  ] });
  const { warnings } = compileSpec(ctx, spec);
  assert.ok(warnings.some(w => /leg_hind_L\.up is keyed only at 0\.5s/.test(w)), JSON.stringify(warnings));
});

test('rig views render a PNG with a legend', () => {
  const { rig, description } = get('spider');
  const r = renderRigViews(rig, description, { views: ['top'], size: 128 });
  assert.equal(r.png.readUInt32BE(0), 0x89504e47);
  assert.equal(r.legend.length, description.chains.length);
});

console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
