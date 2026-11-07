// Body-relative posing: the control space an LLM can actually think in.
//
// Nobody - person or model - can pose a creature by writing bone-local
// quaternions: every bone's axes point somewhere different, and Auto Rig's
// change from run to run. So every control here is measured against the BODY
// (forward / up / left from describeRig) and the bone's own REST direction:
//
//   swing  forward | up | left | out   degrees; positive moves the bone's TIP
//                                      toward that direction ("out" = away from
//                                      the mid line, so one value mirrors)
//   body   turn | pitch | roll          degrees about the body's axes at the
//                                      joint: turn = toward its left, pitch =
//                                      nose up, roll = its left side up
//   twist                               degrees about the bone's own axis
//
// Every control is a rotation RELATIVE TO REST, expressed in the rest frame and
// inherited down the hierarchy - "forward 30" on a thigh means "30 degrees
// further forward than it stands at rest", whatever the hips are doing.
//
// Targets: "leg_front_L" (the chain's BASE bone - the whole limb swings),
// "tail.*" (spread evenly over every bone of the chain - a curl),
// "tail[2]" / "tail[-1]" (one bone of the chain), or an exact bone name.
import * as THREE from 'three';
import { computeNodeWorlds, restJointWorlds } from './gltfRig.js';

const DEG = Math.PI / 180;
export const SWING_CONTROLS = ['forward', 'up', 'left', 'out'];
export const BODY_CONTROLS = ['turn', 'pitch', 'roll'];
export const ALL_CONTROLS = [...SWING_CONTROLS, ...BODY_CONTROLS, 'twist'];
export const ROOT_CONTROLS = ['forward', 'up', 'left', 'turn', 'pitch', 'roll'];

/**
 * Everything posing needs, computed once per rig + description.
 */
export function createPoseContext(rig, description) {
  const restWorlds = restJointWorlds(rig);
  const P = restWorlds.map(m => new THREE.Vector3().setFromMatrixPosition(m));
  const restWorldRot = restWorlds.map((m) => {
    const t = new THREE.Vector3(); const q = new THREE.Quaternion(); const s = new THREE.Vector3();
    m.decompose(t, q, s);
    return q.normalize();
  });
  const v = description.frame.vectors;
  const F = new THREE.Vector3().fromArray(v.forward);
  const U = new THREE.Vector3().fromArray(v.up);
  const L = new THREE.Vector3().fromArray(v.left);

  const weightedOf = new Map(description.bones.map(b => [b.name, b.weightedVertices]));
  const chains = new Map(description.chains.map((c) => {
    const joints = c.bones.map(name => rig.jointByName.get(name)).filter(j => j !== undefined);
    // For IK the chain ends at its last bone that MOVES VERTICES: end-marker
    // bones (Front_Leg_Tip_L, *_leaf) are weightless, and locking one as the
    // "foot" leaves the real foot to the solver, which folds it.
    // ...but only a SHORT marker: on a rigid robot the unweighted end joint is
    // the tip of the whole shin, and trimming it left the solver placing the
    // knee where the foot should go.
    const ikJoints = joints.slice();
    const segLen = (a, b) => P[a].distanceTo(P[b]);
    const chainLen = joints.slice(1).reduce((s2, j, i) => s2 + segLen(j, joints[i]), 0);
    while (ikJoints.length > 3 && !(weightedOf.get(rig.joints[ikJoints[ikJoints.length - 1]].name) > 0)
      && segLen(ikJoints[ikJoints.length - 1], ikJoints[ikJoints.length - 2]) < 0.25 * chainLen) ikJoints.pop();
    return [c.label, { ...c, joints, ikJoints }];
  }));
  const jointChainLabel = description.jointChain;
  const sideOf = (j) => {
    const chain = chains.get(jointChainLabel[j]);
    if (!chain) return 0;
    return chain.side === 'left' ? 1 : chain.side === 'right' ? -1 : 0;
  };

  // Rest direction of a bone: toward the next DISTINCT joint down its chain
  // (zero-length stubs and anchors have no direction of their own), else
  // toward its farthest child, else its parent->self line.
  const scale = Math.max(description.size.height, description.size.length, description.size.width, 1e-3);
  const minSeg = 1e-3 * scale;
  const directionFrom = (j, toward) => {
    const d = new THREE.Vector3().subVectors(P[toward], P[j]);
    return d.length() > minSeg ? d.normalize() : null;
  };
  const boneDir = rig.joints.map((joint, j) => {
    const chain = chains.get(jointChainLabel[j]);
    if (chain) {
      const i = chain.joints.indexOf(j);
      for (let k = i + 1; k < chain.joints.length; k += 1) {
        const d = directionFrom(j, chain.joints[k]);
        if (d) return d;
      }
    }
    let best = null;
    let bestLen = 0;
    const stack = joint.children.slice();
    while (stack.length) {
      const c = stack.pop();
      const len = P[c].distanceTo(P[j]);
      if (len > bestLen) { bestLen = len; best = c; }
      if (len <= minSeg) stack.push(...rig.joints[c].children);
    }
    if (best !== null && bestLen > minSeg) return new THREE.Vector3().subVectors(P[best], P[j]).normalize();
    if (joint.parent >= 0) {
      const d = directionFrom(joint.parent, j);
      if (d) return d;
    }
    return U.clone();
  });
  // A chain's base swings the whole limb, so its direction is base -> tip.
  const chainDir = new Map();
  for (const [label, chain] of chains) {
    if (!chain.joints.length) continue;
    const base = chain.joints[0];
    const tip = chain.joints[chain.joints.length - 1];
    chainDir.set(label, directionFrom(base, tip) || boneDir[base]);
  }

  const skeletonRoot = (() => {
    // The root that carries the most of the body.
    let best = rig.jointRoots[0];
    let bestCount = -1;
    for (const r of rig.jointRoots) {
      let count = 0;
      const stack = [r];
      while (stack.length) { const k = stack.pop(); count += 1; stack.push(...rig.joints[k].children); }
      if (count > bestCount) { bestCount = count; best = r; }
    }
    return best;
  })();

  // Whole-body rotations pivot at the HIPS (the spine chain's base), not at
  // the skeleton root: many rigs keep the root on the floor between the feet,
  // and pitching about the floor drives the rear of the body into it.
  const spine = chains.get('spine') || chains.get('body');
  const bodyPivot = spine && spine.joints.length
    ? P[spine.joints[0]].clone()
    : new THREE.Vector3().fromArray(description.origin).addScaledVector(U, description.size.height / 2);

  return {
    rig, description, P, restWorldRot, F, U, L, chains, jointChainLabel, sideOf,
    boneDir, chainDir, skeletonRoot, scale, bodyPivot
  };
}

/**
 * Resolve a pose target string to [{ joint, share, dir }].
 * Returns { entries, error }.
 */
export function resolveTarget(ctx, target) {
  const { rig, chains } = ctx;
  const text = String(target).trim();
  if (rig.jointByName.has(text)) {
    const j = rig.jointByName.get(text);
    return { entries: [{ joint: j, share: 1, dir: ctx.boneDir[j] }] };
  }
  const spread = /^(.+)\.\*$/.exec(text);
  if (spread && chains.has(spread[1])) {
    const chain = chains.get(spread[1]);
    const n = chain.joints.length;
    return { entries: chain.joints.map(j => ({ joint: j, share: 1 / n, dir: ctx.boneDir[j] })) };
  }
  const indexed = /^(.+)\[(-?\d+)\]$/.exec(text);
  if (indexed && chains.has(indexed[1])) {
    const chain = chains.get(indexed[1]);
    let i = Number(indexed[2]);
    if (i < 0) i += chain.joints.length;
    if (i < 0 || i >= chain.joints.length) return { error: `${indexed[1]} has ${chain.joints.length} bones; index ${indexed[2]} is out of range.` };
    const j = chain.joints[i];
    return { entries: [{ joint: j, share: 1, dir: ctx.boneDir[j] }] };
  }
  if (chains.has(text)) {
    const chain = chains.get(text);
    const j = chain.joints[0];
    return { entries: [{ joint: j, share: 1, dir: ctx.chainDir.get(text) || ctx.boneDir[j] }] };
  }
  return { error: `Unknown pose target "${text}". Use a chain label from describe_rig ("tail", "leg_front_L"), "chain.*" to spread over the chain, "chain[i]" for one bone, or an exact bone name.` };
}

/**
 * The world-space rotation (relative to rest) for one set of controls on a
 * bone whose rest direction is `dir`. Order: twist, swings, body rotations.
 * Returns { q, warnings }.
 */
export function controlRotation(ctx, joint, dir, controls, share = 1) {
  const warnings = [];
  const q = new THREE.Quaternion();
  const tmp = new THREE.Quaternion();
  const side = ctx.sideOf(joint);
  const get = key => {
    const v = Number(controls?.[key]);
    return Number.isFinite(v) && v !== 0 ? v * share * DEG : 0;
  };

  const twist = get('twist');
  if (twist) q.premultiply(tmp.setFromAxisAngle(dir, twist));

  for (const key of SWING_CONTROLS) {
    const angle = get(key);
    if (!angle) continue;
    let target;
    if (key === 'forward') target = ctx.F;
    else if (key === 'up') target = ctx.U;
    else if (key === 'left') target = ctx.L;
    else target = side === 0 ? ctx.L : ctx.L.clone().multiplyScalar(side);
    const axis = new THREE.Vector3().crossVectors(dir, target);
    if (axis.length() < Math.sin(8 * DEG)) {
      warnings.push(`"${key}" on ${ctx.rig.joints[joint].name} does nothing: the bone already points ${key === 'out' ? 'outward' : key}${axis.length() < 1e-6 && dir.dot(target) < 0 ? ' (or straight away from it)' : ''}. Use another control.`);
      continue;
    }
    axis.normalize();
    q.premultiply(tmp.setFromAxisAngle(axis, angle));
  }

  const turn = get('turn');
  if (turn) q.premultiply(tmp.setFromAxisAngle(ctx.U, turn));
  const pitch = get('pitch');
  if (pitch) q.premultiply(tmp.setFromAxisAngle(ctx.L, -pitch));
  const roll = get('roll');
  if (roll) q.premultiply(tmp.setFromAxisAngle(ctx.F, roll));
  return { q, warnings };
}

/**
 * Build a pose: Map(nodeIndex -> { r, t }) of LOCAL transforms, from
 * { targets: {target: controls}, root: {...}, ik: {chain: {forward, up, left}} }.
 * Returns { pose, localRot (Quaternion[] by joint), rootTranslation, warnings, ikReport }.
 */
// `base` (optional) is a pose to build ON: { rot: (Quaternion|null)[] local per
// joint, rootT: Vector3|null } - a retargeted clip's frame. Controls then add
// to the base instead of to the rest pose (still measured in the rest frame,
// which is what "add a tail wag on top" needs).
export function buildPose(ctx, { targets = {}, root = null, ik = null, warm = null, base = null } = {}) {
  const { rig } = ctx;
  const warnings = [];
  // Accumulate world deltas per joint (several targets may hit one bone).
  const delta = rig.joints.map(() => new THREE.Quaternion());
  for (const [target, controls] of Object.entries(targets || {})) {
    if (!controls || typeof controls !== 'object') continue;
    const unknown = Object.keys(controls).filter(k => !ALL_CONTROLS.includes(k));
    if (unknown.length) warnings.push(`Ignored unknown control(s) ${unknown.join(', ')} on "${target}". Controls: ${ALL_CONTROLS.join(', ')}.`);
    const { entries, error } = resolveTarget(ctx, target);
    if (error) { warnings.push(error); continue; }
    for (const { joint, share, dir } of entries) {
      const { q, warnings: w } = controlRotation(ctx, joint, dir, controls, share);
      warnings.push(...w);
      delta[joint].premultiply(q);
    }
  }

  // Root: rotation about the skeleton root + translation in body axes.
  let rootTranslation = null;
  if (root && typeof root === 'object') {
    const r = ctx.skeletonRoot;
    const { q } = controlRotation(ctx, r, ctx.U, { turn: root.turn, pitch: root.pitch, roll: root.roll });
    delta[r].premultiply(q);
    const offset = new THREE.Vector3()
      .addScaledVector(ctx.F, Number(root.forward) || 0)
      .addScaledVector(ctx.U, Number(root.up) || 0)
      .addScaledVector(ctx.L, Number(root.left) || 0);
    // Rotating the root about its own joint, then shifting by
    // (pivot - root) - q(pivot - root), equals rotating about the pivot.
    const arm = ctx.bodyPivot.clone().sub(ctx.P[r]);
    offset.add(arm.clone().sub(arm.clone().applyQuaternion(q)));
    if (offset.lengthSq() > 0) rootTranslation = offset;
  }

  const localRot = rig.joints.map((joint, j) => {
    const rest = (base && base.rot && base.rot[j]) || rig.nodes[joint.node].rest.r;
    const qw = ctx.restWorldRot[j];
    // local = rest * (qw^-1 * D * qw)
    const local = qw.clone().invert().multiply(delta[j]).multiply(qw);
    return rest.clone().multiply(local).normalize();
  });

  const pose = new Map();
  rig.joints.forEach((joint, j) => pose.set(joint.node, { r: localRot[j] }));
  if (rootTranslation || (base && base.rootT)) {
    const node = rig.nodes[rig.joints[ctx.skeletonRoot].node];
    const start = (base && base.rootT) ? base.rootT.clone() : node.rest.t.clone();
    if (rootTranslation) {
      const parentWorld = node.parent >= 0 ? computeNodeWorlds(rig, null)[node.parent] : new THREE.Matrix4();
      const inv = new THREE.Matrix3().setFromMatrix4(parentWorld).invert();
      start.add(rootTranslation.clone().applyMatrix3(inv));
    }
    pose.get(node.index).t = start;
  }

  let ikReport = null;
  if (ik && typeof ik === 'object' && Object.keys(ik).length) {
    ikReport = solveIk(ctx, pose, localRot, ik, warnings, warm);
  }
  return { pose, localRot, rootTranslation, warnings, ikReport };
}

// ---- IK ------------------------------------------------------------------

function signedAngle(a, b, axis) {
  const angle = a.angleTo(b);
  return new THREE.Vector3().crossVectors(a, b).dot(axis) < 0 ? -angle : angle;
}

// The bend at a hinge, measured IN the hinge's plane. Bones of a splayed limb
// are not perpendicular to the bend axis, and measuring their raw angle made
// the sign wobble near straight - the no-flip clamp then fired on phantom
// flips (measured: an 87 degree foot jump on a dragon's hind leg).
function hingeAngle(a, b, axis) {
  const pa = a.clone().projectOnPlane(axis);
  const pb = b.clone().projectOnPlane(axis);
  if (pa.lengthSq() < 1e-18 || pb.lengthSq() < 1e-18) return 0;
  return signedAngle(pa, pb, axis);
}

/**
 * Limb IK the way animal rigs do it:
 *  - FOOT LOCK: the chain's last segment (hoof, foot, claw) keeps its rest
 *    orientation, so the solve places the joint ABOVE it (the ankle) and the
 *    foot follows rigidly. Without this CCD's biggest corrections land on the
 *    ankle and fold the hoof - measured at 145 degrees in one frame.
 *  - HINGED MIDDLES: every joint but the base bends only about the limb's
 *    bend axis, so a knee bends the way it bends at rest. The BASE is a ball
 *    joint - with it locked into the plane too, a sprawling leg could not
 *    follow a pitching body and planted feet skated (measured on the spider).
 *  - NO FLIP: a joint may not bend through straight to the other side.
 *  - DAMPED LEAST SQUARES, not CCD (see the solve loop for why).
 *  - WARM START from the previous frame's solution, so consecutive frames
 *    land in the same solution instead of hopping between two.
 *
 * Targets are offsets (metres, body axes) from the chain tip's REST world
 * position, fixed in the world: a planted foot stays put while the root moves.
 * A chain under IK ignores swing controls on its bones (the solve owns them).
 */
function solveIk(ctx, pose, localRot, ik, warnings, warm) {
  const { rig, P } = ctx;
  const report = {};
  const DEG_STEP = 12 * DEG;
  for (const [label, offset] of Object.entries(ik)) {
    const chain = ctx.chains.get(label);
    if (!chain || chain.joints.length < 2) {
      warnings.push(chain ? `IK needs a chain of at least 2 bones; "${label}" has ${chain.joints.length}.` : `Unknown IK chain "${label}".`);
      continue;
    }
    if (!offset || typeof offset !== 'object') continue;
    const joints = chain.ikJoints;
    const n = joints.length;
    // Lock the last segment only when it is FOOT-sized: a hoof or a toe. A
    // two-segment leg whose last segment is the whole shin must bend there.
    const ikLen = joints.slice(1).reduce((s2, j, i) => s2 + P[j].distanceTo(P[joints[i]]), 0);
    const lockFoot = n >= 3 && P[joints[n - 1]].distanceTo(P[joints[n - 2]]) < 0.35 * ikLen;
    // Effector: the ankle (start of the last segment) when the foot is locked.
    const effector = lockFoot ? joints[n - 2] : joints[n - 1];
    const solveCount = lockFoot ? n - 2 : n - 1; // joints[0 .. solveCount-1] rotate
    const shift = new THREE.Vector3()
      .addScaledVector(ctx.F, Number(offset.forward) || 0)
      .addScaledVector(ctx.U, Number(offset.up) || 0)
      .addScaledVector(ctx.L, Number(offset.left) || 0);
    const target = P[effector].clone().add(shift);
    const requested = target.clone();

    // Bend axis. A LEG bends in the vertical plane through it: for an upright
    // leg that is the sagittal plane (axis = left), for a sprawling one (a
    // spider's) the plane holding the leg and the vertical. Summing the rest
    // bends instead fails on zig-zag limbs - a horse's scapula/humerus/forearm
    // alternate, the crosses cancel and the axis ends up pointing forward,
    // so the hoof can only move sideways.
    const bend = new THREE.Vector3();
    if (chain.kind === 'leg') {
      const d = new THREE.Vector3().subVectors(P[joints[n - 1]], P[joints[0]]).normalize();
      const across = new THREE.Vector3().crossVectors(d, ctx.U);
      bend.copy(across.length() > 0.35 ? across : ctx.L);
    }
    for (let i = 1; i < n - 1 && chain.kind !== 'leg'; i += 1) {
      const a = new THREE.Vector3().subVectors(P[joints[i]], P[joints[i - 1]]);
      const b = new THREE.Vector3().subVectors(P[joints[i + 1]], P[joints[i]]);
      bend.add(new THREE.Vector3().crossVectors(a, b));
    }
    if (bend.length() < 1e-9 * ctx.scale * ctx.scale) {
      const d = ctx.chainDir.get(label) || ctx.U;
      bend.copy(Math.abs(d.dot(ctx.U)) < 0.9 ? new THREE.Vector3().crossVectors(d, ctx.U) : ctx.L);
    }
    bend.normalize();
    // Rest bend sign at each joint (about `bend`), so a knee never flips.
    const restSign = joints.map((j, i) => {
      if (i === 0 || i >= n - 1) return 0;
      const a = new THREE.Vector3().subVectors(P[joints[i]], P[joints[i - 1]]);
      const b = new THREE.Vector3().subVectors(P[joints[i + 1]], P[joints[i]]);
      if (a.length() < 1e-9 || b.length() < 1e-9) return 0;
      const ang = hingeAngle(a, b, bend);
      return Math.abs(ang) > 4 * DEG ? Math.sign(ang) : 0;
    });
    const hingeLocal = joints.map(j => bend.clone().applyQuaternion(ctx.restWorldRot[j].clone().invert()));

    // Warm start from the previous frame, pulled 20% back toward this frame's
    // FK pose. A limb with more joints than a foot position needs is
    // redundant, and a pure warm start lets the solution drift through that
    // freedom: after one cycle the leg stands in a different posture than it
    // started in, and the loop seam jumps (measured: 13 degrees on a horse
    // foreleg). Pulling toward FK makes the solve forget, so a cycle converges
    // to a periodic posture.
    const prev = warm?.get(label);
    if (prev && prev.length === n) {
      for (let i = 0; i < solveCount; i += 1) {
        localRot[joints[i]] = prev[i].clone().slerp(localRot[joints[i]], 0.2).normalize();
        pose.get(rig.joints[joints[i]].node).r = localRot[joints[i]];
      }
    }

    const chainLength = joints.slice(1, lockFoot ? n - 1 : n).reduce((s, j, i) => s + P[j].distanceTo(P[joints[i]]), 0);
    const tolerance = 0.001 * ctx.scale;
    let worlds = computeNodeWorlds(rig, pose);
    const posOf = j => new THREE.Vector3().setFromMatrixPosition(worlds[rig.joints[j].node]);
    const rotOfNode = (nodeIndex) => {
      const q = new THREE.Quaternion();
      worlds[nodeIndex].decompose(new THREE.Vector3(), q, new THREE.Vector3());
      return q;
    };
    // Keep the target inside the limb's reach (from the POSED base). Asking a
    // nearly straight leg - a horse's foreleg - to reach a hair further than
    // it can makes the solve strain and then snap back once the target comes
    // in range (measured: a 28 degree humerus pop at every touch-down).
    // Clamped, the leg simply extends toward it and the foot hovers a few
    // millimetres, continuously.
    {
      const base = posOf(joints[0]);
      const toTarget = target.clone().sub(base);
      const maxReach = 0.985 * chainLength;
      if (toTarget.length() > maxReach) target.copy(base.add(toTarget.setLength(maxReach)));
    }
    let error = posOf(effector).distanceTo(target);
    // Damped least squares (Jacobian) rather than CCD: CCD fixes one joint at a
    // time from the tip, so on a five-hinge horse leg it piles the correction
    // onto the joint nearest the foot and flips between solutions at lift-off
    // (measured: a 41 degree cannon-bone jump in one frame). DLS moves every
    // joint a little each iteration, which is also what keeps consecutive
    // frames continuous from the warm start.
    // DOFs: the base joint turns about three world axes (a ball), every other
    // solved joint about its hinge axis only.
    const lambda = 0.08 * Math.max(chainLength, 1e-6);
    const worldAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    for (let iter = 0; iter < 30 && error > tolerance; iter += 1) {
      const eff = posOf(effector);
      const err = target.clone().sub(eff);
      const dofs = [];
      for (let i = 0; i < solveCount; i += 1) {
        const j = joints[i];
        const node = rig.joints[j].node;
        const pj = posOf(j);
        const lever = eff.clone().sub(pj);
        const worldRot = rotOfNode(node);
        const axes = i === 0 ? worldAxes : [hingeLocal[i].clone().applyQuaternion(worldRot).normalize()];
        for (const axis of axes) dofs.push({ i, axis, col: new THREE.Vector3().crossVectors(axis, lever) });
      }
      // (J J^T + lambda^2 I) y = err ; dtheta = J^T y
      const m = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      const e = m.elements;
      for (const d of dofs) {
        const c = d.col;
        e[0] += c.x * c.x; e[3] += c.x * c.y; e[6] += c.x * c.z;
        e[1] += c.y * c.x; e[4] += c.y * c.y; e[7] += c.y * c.z;
        e[2] += c.z * c.x; e[5] += c.z * c.y; e[8] += c.z * c.z;
      }
      e[0] += lambda * lambda; e[4] += lambda * lambda; e[8] += lambda * lambda;
      const y = err.clone().applyMatrix3(m.invert());
      // Apply base -> tip, one joint at a time (its DOFs combined).
      for (let i = 0; i < solveCount; i += 1) {
        const j = joints[i];
        const node = rig.joints[j].node;
        const worldRot = rotOfNode(node);
        const pj = posOf(j);
        const delta = new THREE.Quaternion();
        for (const d of dofs.filter(x => x.i === i)) {
          let angle = Math.max(-DEG_STEP, Math.min(DEG_STEP, d.col.dot(y)));
          // No flip: the bend at this joint keeps its rest sign and stops
          // short of folding flat.
          if (i > 0 && restSign[i]) {
            const a = pj.clone().sub(posOf(joints[i - 1]));
            const b = posOf(joints[i + 1]).sub(pj);
            if (a.length() > 1e-9 && b.length() > 1e-9) {
              const current = hingeAngle(a, b, d.axis);
              const lo = restSign[i] > 0 ? 2 * DEG : -170 * DEG;
              const hi = restSign[i] > 0 ? 170 * DEG : -2 * DEG;
              angle = Math.max(lo, Math.min(hi, current + angle)) - current;
            }
          }
          // No winding: at most 150 degrees (base: 120) away from REST about
          // this axis, measured on rest^-1 * current so it does not wrap at
          // 180 the way a bend angle between two segments does.
          {
            const axisLocal = d.axis.clone().applyQuaternion(worldRot.clone().invert());
            const dev = rig.nodes[node].rest.r.clone().invert().multiply(localRot[j]);
            const along = dev.x * axisLocal.x + dev.y * axisLocal.y + dev.z * axisLocal.z;
            const current = Math.atan2(Math.sin(2 * Math.atan2(along, dev.w)), Math.cos(2 * Math.atan2(along, dev.w)));
            const limit = (i === 0 ? 120 : 150) * DEG;
            angle = Math.max(-limit, Math.min(limit, current + angle)) - current;
          }
          if (Math.abs(angle) > 1e-9) delta.premultiply(new THREE.Quaternion().setFromAxisAngle(d.axis, angle));
        }
        if (Math.abs(1 - Math.abs(delta.w)) < 1e-12) continue;
        const parentNode = rig.nodes[node].parent;
        const parentRot = parentNode >= 0 ? rotOfNode(parentNode) : new THREE.Quaternion();
        const newLocal = parentRot.invert().multiply(delta.multiply(worldRot)).normalize();
        localRot[j] = newLocal;
        pose.get(node).r = newLocal;
        worlds = computeNodeWorlds(rig, pose);
      }
      error = posOf(effector).distanceTo(target);
    }

    if (lockFoot) {
      // The foot keeps its rest orientation, turned with the body (root yaw).
      const ankle = joints[n - 2];
      const rootJ = ctx.skeletonRoot;
      const rootNow = rotOfNode(rig.joints[rootJ].node);
      const rootDelta = rootNow.multiply(ctx.restWorldRot[rootJ].clone().invert());
      // Only the body's TURN carries to a planted foot (swing-twist about up):
      // a body that pitches or rolls must not tip its feet off the floor.
      const proj = ctx.U.clone().multiplyScalar(rootDelta.x * ctx.U.x + rootDelta.y * ctx.U.y + rootDelta.z * ctx.U.z);
      const yaw = new THREE.Quaternion(proj.x, proj.y, proj.z, rootDelta.w);
      if (yaw.lengthSq() < 1e-12) yaw.identity(); else yaw.normalize();
      const desired = yaw.multiply(ctx.restWorldRot[ankle]);
      const parentNode = rig.nodes[rig.joints[ankle].node].parent;
      const parentRot = parentNode >= 0 ? rotOfNode(parentNode) : new THREE.Quaternion();
      const local = parentRot.invert().multiply(desired).normalize();
      localRot[ankle] = local;
      pose.get(rig.joints[ankle].node).r = local;
    }

    if (warm) warm.set(label, joints.map(j => localRot[j].clone()));
    const reach = posOf(joints[0]).distanceTo(requested);
    error = posOf(effector).distanceTo(requested);
    report[label] = { error: Math.round(error * 1e4) / 1e4, reachable: reach <= chainLength * 1.001 };
    if (error > 0.02 * ctx.scale) {
      warnings.push(`IK on ${label} missed its target by ${error.toFixed(3)} (${reach > chainLength ? 'out of reach' : 'could not bend that way'}).`);
    }
  }
  return report;
}
