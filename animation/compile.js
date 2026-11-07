// The animation SPEC and its compiler.
//
// The spec is what the AI writes and edits: a short JSON description of the
// motion. The compiler bakes it to per-frame bone rotations (the clip) - the
// only thing a game engine ever sees. Keeping the spec, not the keys, as the
// thing that is iterated on is the point: "longer stride" is one number in a
// spec and thousands of values in a clip.
//
// Spec v1:
// {
//   "name": "walk", "duration": 1.2, "fps": 30, "loop": true,
//   "interpolation": "smooth" | "linear",
//   "keys": [
//     { "time": 0,
//       "pose": { "leg_front_L": { "forward": 25 }, "tail.*": { "left": 30 } },
//       "root": { "up": 0.02, "turn": 5 },
//       "ik":   { "leg_hind_L": { "forward": 0.1, "up": 0.04 } } }
//   ]
// }
//
// Each (target, control) pair is its own CHANNEL interpolated over the keys
// that mention it, so keys are sparse: a key only lists what changes there.
// A channel no key mentions stays at rest. With loop: true the channels wrap,
// so the last frame flows back into the first.
import * as THREE from 'three';
import { buildPose, ALL_CONTROLS, ROOT_CONTROLS } from './pose.js';
import { computeNodeWorlds, skinPositions } from './gltfRig.js';

export const SPEC_VERSION = 1;
const MAX_DURATION = 60;
const MAX_FRAMES = 3600;

/** Validate and normalise a spec. Returns { spec, errors, warnings }. */
export function normalizeSpec(input) {
  const errors = [];
  const warnings = [];
  const raw = typeof input === 'string' ? safeParse(input, errors) : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('The spec must be a JSON object with "duration" and "keys".');
    return { spec: null, errors, warnings };
  }
  const duration = Number(raw.duration);
  if (!(duration > 0) || duration > MAX_DURATION) errors.push(`"duration" must be between 0 and ${MAX_DURATION} seconds.`);
  const fps = raw.fps === undefined ? 30 : Math.round(Number(raw.fps));
  if (!(fps >= 1 && fps <= 120)) errors.push('"fps" must be between 1 and 120.');
  if (duration * fps > MAX_FRAMES) errors.push(`That is ${Math.round(duration * fps)} frames; the limit is ${MAX_FRAMES}.`);
  const interpolation = raw.interpolation === 'linear' ? 'linear' : 'smooth';
  const keys = Array.isArray(raw.keys) ? raw.keys : [];
  if (!keys.length) errors.push('"keys" must list at least one key: { "time": 0, "pose": { ... } }.');

  const outKeys = [];
  keys.forEach((key, i) => {
    if (!key || typeof key !== 'object') { errors.push(`keys[${i}] is not an object.`); return; }
    const time = Number(key.time);
    if (!Number.isFinite(time) || time < 0 || (duration > 0 && time > duration + 1e-6)) {
      errors.push(`keys[${i}].time must be between 0 and the duration (${duration}).`);
      return;
    }
    const k = { time };
    const strays = Object.keys(key).filter(f => !['time', 'pose', 'root', 'ik'].includes(f));
    if (strays.length) warnings.push(`keys[${i}] has ${strays.map(f => `"${f}"`).join(', ')} at the top level, which does nothing - a key holds only time, pose, root and ik. Put chain controls inside "pose".`);
    if (key.pose && typeof key.pose === 'object') {
      k.pose = {};
      for (const [target, controls] of Object.entries(key.pose)) {
        if (!controls || typeof controls !== 'object') { warnings.push(`keys[${i}].pose["${target}"] is not an object of controls.`); continue; }
        const clean = {};
        for (const [c, v] of Object.entries(controls)) {
          if (!ALL_CONTROLS.includes(c)) { warnings.push(`keys[${i}].pose["${target}"]: unknown control "${c}" (use ${ALL_CONTROLS.join(', ')}).`); continue; }
          const n = Number(v);
          if (Number.isFinite(n)) clean[c] = n;
        }
        k.pose[target] = clean;
      }
    }
    if (key.root && typeof key.root === 'object') {
      k.root = {};
      for (const [c, v] of Object.entries(key.root)) {
        if (!ROOT_CONTROLS.includes(c)) { warnings.push(`keys[${i}].root: unknown control "${c}" (use ${ROOT_CONTROLS.join(', ')}).`); continue; }
        const n = Number(v);
        if (Number.isFinite(n)) k.root[c] = n;
      }
    }
    if (key.ik && typeof key.ik === 'object') {
      k.ik = {};
      for (const [chain, off] of Object.entries(key.ik)) {
        if (!off || typeof off !== 'object') continue;
        k.ik[chain] = {};
        for (const c of ['forward', 'up', 'left']) {
          const n = Number(off[c]);
          if (Number.isFinite(n)) k.ik[chain][c] = n;
        }
      }
    }
    outKeys.push(k);
  });
  outKeys.sort((a, b) => a.time - b.time);

  const spec = {
    version: SPEC_VERSION,
    name: String(raw.name || 'animation').trim().slice(0, 80) || 'animation',
    duration,
    fps,
    loop: Boolean(raw.loop),
    interpolation,
    keys: outKeys
  };
  if (raw.description) spec.description = String(raw.description).slice(0, 500);
  return { spec, errors, warnings };
}

function safeParse(text, errors) {
  try { return JSON.parse(text); } catch (err) { errors.push(`The spec is not valid JSON: ${err.message}`); return null; }
}

// Channel id helpers: "pose|tail.*|left", "root||up", "ik|leg_L|forward".
function collectChannels(spec) {
  const channels = new Map();
  const add = (id, time, value) => {
    if (!channels.has(id)) channels.set(id, []);
    channels.get(id).push({ time, value });
  };
  for (const key of spec.keys) {
    for (const [target, controls] of Object.entries(key.pose || {})) {
      for (const [c, v] of Object.entries(controls)) add(`pose|${target}|${c}`, key.time, v);
    }
    for (const [c, v] of Object.entries(key.root || {})) add(`root||${c}`, key.time, v);
    for (const [chain, off] of Object.entries(key.ik || {})) {
      for (const [c, v] of Object.entries(off)) add(`ik|${chain}|${c}`, key.time, v);
    }
  }
  // IK chains named anywhere are solved on EVERY frame (an unmentioned axis is
  // 0 = the tip's rest position), so a planted foot stays planted between keys.
  for (const key of spec.keys) {
    for (const chain of Object.keys(key.ik || {})) {
      for (const c of ['forward', 'up', 'left']) if (!channels.has(`ik|${chain}|${c}`)) channels.set(`ik|${chain}|${c}`, [{ time: 0, value: 0 }]);
    }
  }
  return channels;
}

/** Value of a channel at time t. Cubic (Catmull-Rom) or linear; wraps when looping. */
export function sampleChannel(points, t, { duration, loop, interpolation }) {
  if (points.length === 1) return points[0].value;
  const pts = points;
  if (!loop) {
    if (t <= pts[0].time) return pts[0].value;
    if (t >= pts[pts.length - 1].time) return pts[pts.length - 1].value;
  }
  // Find the segment [i, i+1] containing t (with wrap for loops).
  const n = pts.length;
  const at = (i) => {
    // Unrolled view of the periodic key list.
    const cycle = Math.floor(i / n);
    const k = ((i % n) + n) % n;
    return { time: pts[k].time + cycle * duration, value: pts[k].value };
  };
  let i;
  let tt = t;
  if (loop) {
    // Keys at 0 and at duration describe the same instant; drop the duplicate.
    if (pts[n - 1].time >= duration - 1e-6 && pts[0].time <= 1e-6 && n > 1) {
      return sampleChannel(pts.slice(0, -1), t, { duration, loop, interpolation });
    }
    if (tt < pts[0].time) tt += duration;
    i = n - 1;
    for (let k = 0; k < n; k += 1) if (pts[k].time <= tt) i = k;
  } else {
    i = 0;
    for (let k = 0; k < n - 1; k += 1) if (pts[k].time <= tt) i = k;
  }
  const p1 = at(i);
  const p2 = at(i + 1);
  const span = p2.time - p1.time;
  const u = span > 1e-9 ? (tt - p1.time) / span : 0;
  if (interpolation === 'linear') return p1.value + (p2.value - p1.value) * u;
  const p0 = loop || i > 0 ? at(i - 1) : { time: p1.time - span, value: p1.value };
  const p3 = loop || i + 2 < n ? at(i + 2) : { time: p2.time + span, value: p2.value };
  // Non-uniform Catmull-Rom tangents (time-aware), then cubic Hermite.
  const m1 = ((p2.value - p0.value) / Math.max(1e-9, p2.time - p0.time)) * span;
  const m2 = ((p3.value - p1.value) / Math.max(1e-9, p3.time - p1.time)) * span;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1.value + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2.value + (u3 - u2) * m2;
}

/** The pose inputs (targets/root/ik) at time t. */
export function poseInputsAt(spec, channels, t) {
  const targets = {};
  const root = {};
  const ik = {};
  for (const [id, points] of channels) {
    const [kind, target, control] = id.split('|');
    const value = sampleChannel(points, t, spec);
    if (kind === 'pose') { (targets[target] = targets[target] || {})[control] = value; }
    else if (kind === 'root') root[control] = value;
    else if (kind === 'ik') { (ik[target] = ik[target] || {})[control] = value; }
  }
  return { targets, root: Object.keys(root).length ? root : null, ik: Object.keys(ik).length ? ik : null };
}

/**
 * Compile a normalised spec against a pose context.
 * Returns { clip, warnings, frames } where clip = { name, duration, times,
 * rotations: Map(jointIndex -> Float32Array xyzw per frame), translation:
 * { joint, values: Float32Array } | null }.
 */
export function compileSpec(ctx, spec) {
  const { rig } = ctx;
  const channels = collectChannels(spec);
  const holdWarnings = singleKeyWarnings(spec, channels);
  const frameCount = Math.max(2, Math.round(spec.duration * spec.fps) + 1);
  const times = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) times[f] = Math.min(spec.duration, f / spec.fps);
  times[frameCount - 1] = spec.duration;

  const warnings = new Set();
  const rotations = rig.joints.map(() => new Float32Array(frameCount * 4));
  const rootJoint = ctx.skeletonRoot;
  const translation = new Float32Array(frameCount * 3);
  let anyTranslation = false;
  const poses = [];
  // IK warm start: each frame begins from the previous frame's solution.
  const warm = new Map();
  let firstResult = null;
  // A looping clip's first frame must continue from its LAST: run the whole
  // cycle once to warm IK up, then record the second lap. Starting cold, the
  // two sides of the seam settle on different IK solutions and the wrap pops
  // (measured: a 42-51 degree hock flip on the closing frame of a horse walk;
  // a quarter-cycle pre-roll was not enough - IK is path dependent).
  if (spec.loop && [...channels.keys()].some(k => k.startsWith('ik|'))) {
    for (let f = 0; f < frameCount - 1; f += 1) {
      buildPose(ctx, { ...poseInputsAt(spec, channels, times[f]), warm });
    }
  }

  for (let f = 0; f < frameCount; f += 1) {
    const t = times[f];
    // The closing frame of a loop IS the first frame - copied, not re-solved,
    // so the seam is exact even where IK converges from a different start.
    const closing = spec.loop && f === frameCount - 1 && f > 0;
    const result = closing ? firstResult : buildPose(ctx, { ...poseInputsAt(spec, channels, t), warm });
    if (f === 0) firstResult = result;
    for (const w of result.warnings) warnings.add(w);
    result.localRot.forEach((q0, j) => {
      const q = closing ? q0.clone() : q0;
      // Keep the quaternion on the same hemisphere as the previous frame, or
      // interpolation between two keys flips the long way round.
      if (f > 0) {
        const o = (f - 1) * 4;
        const prev = rotations[j];
        if (prev[o] * q.x + prev[o + 1] * q.y + prev[o + 2] * q.z + prev[o + 3] * q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      }
      rotations[j].set([q.x, q.y, q.z, q.w], f * 4);
    });
    const rootNode = rig.nodes[rig.joints[rootJoint].node];
    const t3 = result.pose.get(rootNode.index)?.t || rootNode.rest.t;
    if (result.pose.get(rootNode.index)?.t) anyTranslation = true;
    translation.set([t3.x, t3.y, t3.z], f * 3);
    poses.push(result.pose);
  }

  // Drop joints that never leave rest - a channel per bone would bloat the
  // file and override nothing.
  const animated = new Map();
  rig.joints.forEach((joint, j) => {
    const rest = rig.nodes[joint.node].rest.r;
    const values = rotations[j];
    let moves = false;
    for (let f = 0; f < frameCount && !moves; f += 1) {
      const d = Math.abs(values[f * 4] * rest.x + values[f * 4 + 1] * rest.y + values[f * 4 + 2] * rest.z + values[f * 4 + 3] * rest.w);
      if (1 - d > 1e-7) moves = true;
    }
    if (moves) animated.set(j, values);
  });

  return {
    clip: {
      name: spec.name,
      duration: spec.duration,
      times,
      rotations: animated,
      translation: anyTranslation ? { joint: rootJoint, values: translation } : null
    },
    poses,
    loop: spec.loop,
    warnings: [...holdWarnings, ...collapseIkWarnings([...warnings])]
  };
}

// A control keyed ONCE holds that value for the whole clip - correct, but
// almost never what was meant when the same target is keyed at other times
// ("lift the foot at 0.8s" without "put it down at 0.2s" leaves it up all
// cycle). Say so.
function singleKeyWarnings(spec, channels) {
  const keyedTimes = new Map();
  for (const key of spec.keys) {
    for (const t of Object.keys(key.pose || {})) (keyedTimes.get(`pose|${t}`) || keyedTimes.set(`pose|${t}`, new Set()).get(`pose|${t}`)).add(key.time);
    for (const t of Object.keys(key.ik || {})) (keyedTimes.get(`ik|${t}`) || keyedTimes.set(`ik|${t}`, new Set()).get(`ik|${t}`)).add(key.time);
  }
  const out = [];
  for (const [id, points] of channels) {
    const [kind, target, control] = id.split('|');
    if (kind === 'root' || points.length !== 1) continue;
    const times = keyedTimes.get(`${kind}|${target}`);
    if (!times || times.size < 2) continue;
    const at = spec.keys.find(k => (k[kind] || {})[target] && control in k[kind][target]);
    if (!at) continue;
    out.push(`${target}.${control} is keyed only at ${at.time}s, so it holds ${points[0].value} for the WHOLE clip although ${target} is keyed at other times too. Key it at those times as well (e.g. ${control}: 0) if it should change.`);
  }
  return out;
}

// Per-frame IK misses would otherwise flood the result with one line per frame
// per chain; fold them into one line per chain with the worst miss.
function collapseIkWarnings(warnings) {
  const misses = new Map();
  const rest = [];
  for (const w of warnings) {
    const m = /^IK on (\S+) missed its target by ([\d.]+) \(([^)]+)\)/.exec(w);
    if (!m) { rest.push(w); continue; }
    const entry = misses.get(m[1]) || { worst: 0, frames: 0, why: m[3] };
    entry.frames += 1;
    if (Number(m[2]) > entry.worst) { entry.worst = Number(m[2]); entry.why = m[3]; }
    misses.set(m[1], entry);
  }
  for (const [chain, e] of misses) {
    rest.push(`IK on ${chain} missed its target on some frames (worst ${e.worst.toFixed(3)}, ${e.why}) - move the target closer to the body or reduce the body motion there.`);
  }
  return rest;
}

/**
 * Motion checks an animator would do by eye, as numbers:
 *  - ground penetration (lowest skinned vertex below the floor)
 *  - foot sliding on contact chains (tip moving while on the floor)
 *  - loop seam (pose jump between the last and first frame)
 *  - jitter (largest frame-to-frame rotation of any bone)
 */
export function analyzeMotion(ctx, compiled, { sampleFrames = 24 } = {}) {
  const { rig, description } = ctx;
  const { clip, poses } = compiled;
  const n = poses.length;
  const groundY = description.size.groundY;
  const height = description.size.height || 1;
  const contactChains = description.chains.filter(c => c.contact);
  const tipJoint = new Map(contactChains.map(c => [c.label, rig.jointByName.get(c.bones[c.bones.length - 1])]));
  // "On the floor" is measured from where each tip stands AT REST: a hoof or
  // toe bone usually sits a few centimetres up inside the foot, so an absolute
  // floor threshold would never see it touch down.
  const restWorlds = computeNodeWorlds(rig, null);
  const contactThreshold = new Map();
  for (const [label, j] of tipJoint) {
    if (j === undefined) continue;
    const restY = new THREE.Vector3().setFromMatrixPosition(restWorlds[rig.joints[j].node]).y;
    contactThreshold.set(label, Math.max(restY, groundY) + 0.02 * height);
  }

  const step = Math.max(1, Math.floor(n / sampleFrames));
  let lowest = Infinity;
  let lowestFrame = 0;
  const scratch = new Float32Array(rig.geometry.positions.length);
  for (let f = 0; f < n; f += step) {
    const pos = skinPositions(rig, poses[f], scratch);
    for (let i = 1; i < pos.length; i += 3 * Math.max(1, Math.floor(rig.geometry.vertexCount / 20000))) {
      if (pos[i] < lowest) { lowest = pos[i]; lowestFrame = f; }
    }
  }

  const slide = {};
  for (const [label, j] of tipJoint) {
    if (j === undefined) continue;
    let prev = null;
    let slid = 0;
    let slidBack = 0;
    let slidAhead = 0;
    let backFrames = 0;
    let contactFrames = 0;
    let lowestTip = Infinity;
    const fwd = description.frame.vectors.forward;
    for (let f = 0; f < n; f += 1) {
      const worlds = computeNodeWorlds(rig, poses[f]);
      const p = new THREE.Vector3().setFromMatrixPosition(worlds[rig.joints[j].node]);
      lowestTip = Math.min(lowestTip, p.y);
      if (p.y <= contactThreshold.get(label)) {
        contactFrames += 1;
        if (prev) {
          slid += Math.hypot(p.x - prev.x, p.z - prev.z);
          const along = (p.x - prev.x) * fwd[0] + (p.z - prev.z) * fwd[2];
          if (along < 0) { slidBack -= along; backFrames += 1; } else slidAhead += along;
        }
        prev = p;
      } else {
        prev = null;
      }
    }
    const fps = clip.times.length > 1 ? (clip.times.length - 1) / clip.duration : 30;
    // Planted feet that all drift steadily BACKWARD are a treadmill: the body
    // walks in place. That is a valid in-place cycle, not a bug - the engine
    // moves the character forward at that speed.
    // (Touch-down and lift-off frames sit inside the contact band while the
    // foot still travels forward, so "mostly backward" is the test, not "only".)
    const treadmill = backFrames > 2 && slidBack > 2 * slidAhead && slidBack > 0.6 * slid;
    slide[label] = {
      contactFrames,
      slide: Math.round(slid * 1000) / 1000,
      ...(treadmill ? { treadmillSpeed: Math.round((slidBack / backFrames) * fps * 1000) / 1000 } : {}),
      lowestTip: Math.round((lowestTip - groundY) * 1000) / 1000
    };
  }

  let maxStep = 0;
  let maxStepBone = null;
  let seam = 0;
  for (const [j, values] of clip.rotations) {
    for (let f = 1; f < n; f += 1) {
      const a = f * 4, b = (f - 1) * 4;
      const d = Math.abs(values[a] * values[b] + values[a + 1] * values[b + 1] + values[a + 2] * values[b + 2] + values[a + 3] * values[b + 3]);
      const angle = 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
      if (angle > maxStep) { maxStep = angle; maxStepBone = rig.joints[j].name; }
    }
    const a = (n - 1) * 4;
    const d = Math.abs(values[a] * values[0] + values[a + 1] * values[1] + values[a + 2] * values[2] + values[a + 3] * values[3]);
    seam = Math.max(seam, 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI);
  }

  const penetration = groundY - lowest;
  const notes = [];
  if (penetration > 0.01 * height) notes.push(`The mesh dips ${penetration.toFixed(3)} below the floor (frame ${lowestFrame}). Raise root.up there, or lift the limb.`);
  const treadmills = Object.entries(slide).filter(([, s]) => s.treadmillSpeed);
  const speeds = treadmills.map(([, s]) => s.treadmillSpeed);
  if (treadmills.length && treadmills.length === Object.values(slide).filter(s => s.contactFrames > 2).length) {
    const lo = Math.min(...speeds), hi = Math.max(...speeds);
    notes.push(`In-place cycle: planted feet drift backward at ${lo.toFixed(2)}-${hi.toFixed(2)} units/s, as a treadmill walk does. In an engine move the character forward at ~${((lo + hi) / 2).toFixed(2)} units/s (root motion)${hi > lo * 1.5 ? '; the legs disagree on speed, so some will skate - match their swing angles' : ''}.`);
  } else {
    for (const [label, s] of Object.entries(slide)) {
      if (s.contactFrames > 2 && s.slide > 0.05 * height && !s.treadmillSpeed) notes.push(`${label} slides ${s.slide} while on the floor - plant it with "ik" or match the body's travel.`);
    }
  }
  const clipFps = clip.times.length > 1 ? (clip.times.length - 1) / clip.duration : 30;
  if (maxStep > 360 / clipFps) notes.push(`${maxStepBone} turns ${maxStep.toFixed(1)} degrees in one frame - that will pop. Spread the change over more time.`);
  if (compiled.loop && seam > 1) notes.push(`The loop seam jumps ${seam.toFixed(1)} degrees.`);

  return {
    frames: n,
    lowestPoint: Math.round((lowest - groundY) * 1000) / 1000,
    lowestFrame,
    contacts: slide,
    largestFrameStepDeg: Math.round(maxStep * 10) / 10,
    largestFrameStepBone: maxStepBone,
    loopSeamDeg: Math.round(seam * 10) / 10,
    animatedBones: clip.rotations.size,
    notes
  };
}
