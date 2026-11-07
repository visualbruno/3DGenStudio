// Retargeting by BODY, not by bone name.
//
// The browser retargeter (src/utils/animationLibrary.js) maps bones by NAME,
// which works between humanoids and works nowhere else: a fox's
// "Front_Leg_Upper_L" and an Auto Rig monster's "bone_17" share no token. Here
// both rigs have already been read as bodies by describeRig, so the mapping is
// chain to chain by LABEL (leg_front_L -> leg_front_L, tail -> tail), falling
// back to kind + side + order (a spider's four leg pairs onto a fox's two), and
// bone to bone by relative position along the chain - so it works between any
// two creatures with comparable parts, whatever their bone names and counts.
//
// The motion transfer is the same world-space DELTA the browser uses
// (desired = srcAnim * srcRest^-1 * tgtRest), with two additions:
//  * the delta is carried from the source's BODY frame into the target's, so a
//    source facing +Z drives a target facing +X correctly;
//  * matchRestPose (limbs, tails, appendages only) first swings each target
//    bone onto its source bone's rest direction, so a creature modelled with
//    splayed legs does not walk splayed (the "relative to the initial pose"
//    bug the browser fixed with matchTargetRestPose). Spine, neck and head are
//    left alone - correcting those tilts the whole torso.
import * as THREE from 'three';
import { computeNodeWorlds, restJointWorlds } from './gltfRig.js';
import { createPoseContext } from './pose.js';

/** The bundled mesh2motion reference library (resources/animations, MIT). */
export const MOTION_LIBRARY = {
  human: ['human-base-animations.glb', 'human-addon-animations.glb'],
  fox: ['fox-animations.glb'],
  horse: ['horse-animations.glb'],
  bird: ['bird-animations.glb'],
  dragon: ['dragon-animations.glb'],
  kaiju: ['kaiju-animations.glb'],
  shark: ['shark-animations.glb'],
  snake: ['snake-animations.glb'],
  spider: ['spider-animations.glb']
};

const KIND_ALIASES = { body: ['spine', 'body'], spine: ['spine', 'body'] };
const CORRECTABLE = new Set(['leg', 'arm', 'wing', 'tail', 'part', 'appendage', 'head_appendage']);

function chainPositions(rig, chainJoints, P) {
  const cum = [0];
  for (let i = 1; i < chainJoints.length; i += 1) cum.push(cum[i - 1] + P[chainJoints[i]].distanceTo(P[chainJoints[i - 1]]));
  const total = cum[cum.length - 1];
  return cum.map(c => (total > 0 ? c / total : 0));
}

/**
 * Pair the target's chains and bones with the source's.
 * chainMap: { targetChain: sourceChain | null }, boneMap: { targetBone: sourceBone | null }.
 * Returns { mapping: Map(targetJoint -> sourceJoint), chains: [{target, source}], unmatched: [targetChain] }.
 */
export function mapRigs(src, srcDesc, tgt, tgtDesc, { chainMap = {}, boneMap = {} } = {}) {
  const Ps = restJointWorlds(src.rig).map(m => new THREE.Vector3().setFromMatrixPosition(m));
  const Pt = restJointWorlds(tgt.rig).map(m => new THREE.Vector3().setFromMatrixPosition(m));
  const srcChains = srcDesc.chains.filter(c => !['helper', 'extra'].includes(c.kind));
  const bySide = (chains, kind, side) => chains
    .filter(c => (KIND_ALIASES[kind] || [kind]).includes(c.kind) && c.side === side && !c.label.includes('.'))
    .sort((a, b) => b.base[0] - a.base[0]);
  const pairs = [];
  const unmatched = [];
  for (const tc of tgtDesc.chains) {
    if (['helper', 'extra'].includes(tc.kind)) continue;
    let sc = null;
    if (Object.prototype.hasOwnProperty.call(chainMap, tc.label)) {
      const want = chainMap[tc.label];
      if (want) {
        sc = srcChains.find(c => c.label === want) || null;
        if (!sc) throw new Error(`chainMap: the source has no chain "${want}". Its chains: ${srcChains.map(c => c.label).join(', ')}.`);
      }
    } else {
      sc = srcChains.find(c => c.label === tc.label) || null;
      if (!sc && !tc.label.includes('.')) {
        // Same kind and side, matched by rank front-to-back (scaled when the
        // counts differ: four spider leg pairs onto a fox's two).
        const tl = bySide(tgtDesc.chains, tc.kind, tc.side);
        const sl = bySide(srcChains, tc.kind, tc.side);
        if (sl.length) {
          const i = tl.indexOf(tc);
          const k = tl.length > 1 ? Math.round((i * (sl.length - 1)) / (tl.length - 1)) : 0;
          sc = sl[Math.max(0, Math.min(sl.length - 1, k))];
        }
      }
    }
    if (!sc) { unmatched.push(tc.label); continue; }
    pairs.push({ target: tc.label, source: sc.label, tc, sc });
  }

  const mapping = new Map();
  for (const { tc, sc } of pairs) {
    const tj = tc.bones.map(b => tgt.rig.jointByName.get(b)).filter(j => j !== undefined);
    const sj = sc.bones.map(b => src.rig.jointByName.get(b)).filter(j => j !== undefined);
    if (!tj.length || !sj.length) continue;
    const tPos = chainPositions(tgt.rig, tj, Pt);
    const sPos = chainPositions(src.rig, sj, Ps);
    // Same-named bones in a paired chain map by name first: a rig renamed
    // after a species (Auto Rig's "horse" naming) shares the reference's
    // names, and the name is the more reliable match than arc length.
    const srcByName = new Map(sj.map(k => [src.rig.joints[k].name.toLowerCase(), k]));
    tj.forEach((j, i) => {
      const named = srcByName.get(tgt.rig.joints[j].name.toLowerCase());
      if (named !== undefined) { mapping.set(j, named); return; }
      let best = 0;
      for (let k = 1; k < sj.length; k += 1) if (Math.abs(sPos[k] - tPos[i]) < Math.abs(sPos[best] - tPos[i])) best = k;
      mapping.set(j, sj[best]);
    });
  }
  for (const [tb, sb] of Object.entries(boneMap || {})) {
    const tj = tgt.rig.jointByName.get(tb);
    if (tj === undefined) throw new Error(`boneMap: the target has no bone "${tb}".`);
    if (!sb) { mapping.delete(tj); continue; }
    const sj = src.rig.jointByName.get(sb);
    if (sj === undefined) throw new Error(`boneMap: the source has no bone "${sb}".`);
    mapping.set(tj, sj);
  }
  return { mapping, chains: pairs.map(p => ({ target: p.target, source: p.source })), unmatched };
}

function frameMatrix(desc) {
  const v = desc.frame.vectors;
  return new THREE.Matrix4().makeBasis(
    new THREE.Vector3().fromArray(v.forward),
    new THREE.Vector3().fromArray(v.up),
    new THREE.Vector3().fromArray(v.left)
  );
}

/**
 * Build a sampler that turns a source pose into target LOCAL rotations.
 * `sourcePoseAt(t)` returns a source pose Map (node -> {r,t,s}).
 * Returns { sample(t) -> { rot: (Quaternion|null)[], rootT: Vector3|null }, report }.
 */
export function createRetarget(src, srcDesc, tgt, tgtDesc, mapping, sourcePoseAt, { matchRestPose = true } = {}) {
  const sRig = src.rig;
  const tRig = tgt.rig;
  const rotOf = (m) => { const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q.normalize(); };
  const sRestWorlds = computeNodeWorlds(sRig, null);
  const tRestWorlds = computeNodeWorlds(tRig, null);
  const sRestRot = sRig.joints.map(j => rotOf(sRestWorlds[j.node]));
  const tRestRot = tRig.joints.map(j => rotOf(tRestWorlds[j.node]));
  // Source body frame -> target body frame.
  const R = new THREE.Quaternion().setFromRotationMatrix(frameMatrix(tgtDesc).multiply(frameMatrix(srcDesc).invert()));
  const Rinv = R.clone().invert();

  // Rest-pose match: swing each correctable target bone onto its source
  // bone's rest direction (carried into the target frame).
  const sCtx = createPoseContext(sRig, srcDesc);
  const tCtx = createPoseContext(tRig, tgtDesc);
  const correction = new Map();
  let corrected = 0;
  if (matchRestPose) {
    for (const [tj, sj] of mapping) {
      const kind = tCtx.chains.get(tgtDesc.jointChain[tj])?.kind;
      if (!CORRECTABLE.has(kind)) continue;
      const dt = tCtx.boneDir[tj];
      const ds = sCtx.boneDir[sj].clone().applyQuaternion(R);
      const angle = dt.angleTo(ds);
      if (angle < 1e-4 || angle > (135 * Math.PI) / 180) continue;
      correction.set(tj, new THREE.Quaternion().setFromUnitVectors(dt, ds));
      corrected += 1;
    }
  }

  // Root motion: the spine base's travel, scaled by hip height.
  const spineOf = (desc, rig) => {
    const c = desc.chains.find(ch => ch.kind === 'spine') || desc.chains.find(ch => ch.kind === 'body');
    return c ? rig.jointByName.get(c.bones[0]) : rig.jointRoots[0];
  };
  const sHip = spineOf(srcDesc, sRig);
  const tHip = spineOf(tgtDesc, tRig);
  const sHipRest = new THREE.Vector3().setFromMatrixPosition(sRestWorlds[sRig.joints[sHip].node]);
  const tHipRest = new THREE.Vector3().setFromMatrixPosition(tRestWorlds[tRig.joints[tHip].node]);
  const sHeight = Math.max(1e-6, sHipRest.y - srcDesc.size.groundY);
  const tHeight = Math.max(1e-6, tHipRest.y - tgtDesc.size.groundY);
  const scale = tHeight / sHeight;
  const tRoot = tCtx.skeletonRoot;
  const tRootNode = tRig.joints[tRoot].node;
  const tRootParent = tRig.nodes[tRootNode].parent;
  const tRootParentWorld = tRootParent >= 0 ? tRestWorlds[tRootParent] : new THREE.Matrix4();
  const toRootParentLocal = new THREE.Matrix3().setFromMatrix4(tRootParentWorld).invert();

  // Target joints in hierarchy order (parents first).
  const order = [];
  const stack = tRig.jointRoots.slice().reverse();
  while (stack.length) { const j = stack.pop(); order.push(j); stack.push(...tRig.joints[j].children.slice().reverse()); }

  let groundOffset = 0;
  const sample = (t) => {
    const sPose = sourcePoseAt(t);
    const sWorlds = computeNodeWorlds(sRig, sPose);
    const rot = new Array(tRig.joints.length).fill(null);
    const posedWorldRot = new Map(); // node -> world rotation
    const worldRotOfNode = (node) => {
      if (posedWorldRot.has(node)) return posedWorldRot.get(node);
      return rotOf(tRestWorlds[node]); // unanimated (non-joint ancestors)
    };
    for (const j of order) {
      const node = tRig.joints[j].node;
      const parentNode = tRig.nodes[node].parent;
      const parentRot = parentNode >= 0 ? worldRotOfNode(parentNode) : new THREE.Quaternion();
      let desired;
      if (mapping.has(j)) {
        const sj = mapping.get(j);
        const delta = rotOf(sWorlds[sRig.joints[sj].node]).multiply(sRestRot[sj].clone().invert());
        const D = R.clone().multiply(delta).multiply(Rinv);
        desired = D.multiply(correction.get(j) || new THREE.Quaternion()).multiply(tRestRot[j]);
        rot[j] = parentRot.clone().invert().multiply(desired).normalize();
      } else {
        desired = parentRot.clone().multiply(tRig.nodes[node].rest.r);
      }
      posedWorldRot.set(node, desired.normalize());
    }
    const sHipNow = new THREE.Vector3().setFromMatrixPosition(sWorlds[sRig.joints[sHip].node]);
    const travel = sHipNow.sub(sHipRest).applyQuaternion(R).multiplyScalar(scale);
    travel.y += groundOffset;
    const rootT = tRig.nodes[tRootNode].rest.t.clone().add(travel.applyMatrix3(toRootParentLocal));
    return { rot, rootT };
  };

  return {
    sample,
    setGroundOffset: (v) => { groundOffset = v; },
    report: { restPoseCorrected: corrected, hipScale: Math.round(scale * 1000) / 1000 }
  };
}
