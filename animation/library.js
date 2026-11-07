// Turn a clip stored in a GLB into a CUSTOM ANIMATION library document - the
// format src/utils/customAnimations.js reads (document version 2), so a clip an
// agent authored or retargeted shows up in the Mesh Editor's Custom tab and can
// be applied to any other rigged mesh there.
//
// The document is the clip PLUS the skeleton it was authored on (pre-order
// bones with their rest transforms; a root's non-bone ancestors folded into
// `parentTransform`), because the retargeter measures every frame as a delta
// from that skeleton's rest pose.
//
// Names are sanitised exactly the way three's GLTFLoader sanitises node names
// (PropertyBinding.sanitizeNodeName): the browser rebuilds the skeleton and
// matches it against meshes loaded through GLTFLoader, so "mixamorig:Hips"
// must be stored as "mixamorigHips" or nothing matches.
import * as THREE from 'three';
import { computeNodeWorlds } from './gltfRig.js';
import { readAccessor } from '../meshRigTransfer.js';

const VALUE_DECIMALS = 6;
const TIME_DECIMALS = 5;
const round = (v, d) => Math.round(Number(v) * 10 ** d) / 10 ** d;

/** Same FNV-1a over sorted names as customAnimations.customRigKey. */
export function customRigKey(boneNames) {
  const joined = [...boneNames].map(String).sort().join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${boneNames.length}`;
}

export function buildLibraryDocument(rig, animIndex, { fps = 30 } = {}) {
  const anim = (rig.json.animations || [])[animIndex];
  if (!anim) throw new Error(`The mesh has no animation #${animIndex}.`);
  const sanitize = THREE.PropertyBinding.sanitizeNodeName;
  const worlds = computeNodeWorlds(rig, null);

  // Pre-order over the joints, so a bone's parent always precedes it.
  const order = [];
  const stack = rig.jointRoots.slice().reverse();
  while (stack.length) {
    const j = stack.pop();
    order.push(j);
    stack.push(...rig.joints[j].children.slice().reverse());
  }
  const indexOf = new Map(order.map((j, i) => [j, i]));
  const bones = order.map((j) => {
    const joint = rig.joints[j];
    const node = rig.nodes[joint.node];
    const entry = {
      name: sanitize(joint.name),
      parent: joint.parent >= 0 ? indexOf.get(joint.parent) : -1,
      position: node.rest.t.toArray().map(v => round(v, VALUE_DECIMALS)),
      quaternion: node.rest.r.toArray().map(v => round(v, VALUE_DECIMALS)),
      scale: node.rest.s.toArray().map(v => round(v, VALUE_DECIMALS))
    };
    if (joint.parent < 0 && node.parent >= 0) {
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      worlds[node.parent].decompose(p, q, s);
      const identity = p.lengthSq() <= 1e-12 && Math.abs(q.w) >= 1 - 1e-9
        && Math.abs(s.x - 1) <= 1e-9 && Math.abs(s.y - 1) <= 1e-9 && Math.abs(s.z - 1) <= 1e-9;
      if (!identity) {
        entry.parentTransform = {
          position: p.toArray().map(v => round(v, VALUE_DECIMALS)),
          quaternion: q.toArray().map(v => round(v, VALUE_DECIMALS)),
          scale: s.toArray().map(v => round(v, VALUE_DECIMALS))
        };
      }
    }
    return entry;
  });

  const jointOfNode = new Map(rig.joints.map(j => [j.node, j.index]));
  const tracks = [];
  let duration = 0;
  let frameCount = 0;
  for (const channel of anim.channels || []) {
    const sampler = anim.samplers?.[channel.sampler];
    const j = jointOfNode.get(channel.target?.node);
    const path = channel.target?.path;
    // Scale tracks are dropped, exactly as the browser's file import does.
    if (!sampler || j === undefined || !['rotation', 'translation'].includes(path)) continue;
    const times = Array.from(readAccessor(rig.json, rig.bin, sampler.input).values, t => round(t, TIME_DECIMALS));
    const out = readAccessor(rig.json, rig.bin, sampler.output);
    const width = path === 'rotation' ? 4 : 3;
    let values = Array.from(out.values);
    if (sampler.interpolation === 'CUBICSPLINE') {
      values = [];
      for (let k = 0; k < times.length; k += 1) for (let c = 0; c < width; c += 1) values.push(out.values[(k * 3 + 1) * width + c]);
    }
    values = values.map(v => round(v, VALUE_DECIMALS));
    const name = sanitize(rig.joints[j].name);
    tracks.push(path === 'rotation'
      ? new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values)
      : new THREE.VectorKeyframeTrack(`${name}.position`, times, values));
    duration = Math.max(duration, times[times.length - 1] || 0);
    frameCount = Math.max(frameCount, times.length);
  }
  if (!tracks.length) throw new Error('That clip animates no bone of this skeleton.');
  const clipName = anim.name || `animation_${animIndex}`;
  const clip = THREE.AnimationClip.toJSON(new THREE.AnimationClip(clipName, duration, tracks));
  return {
    version: 2,
    rigKey: customRigKey(bones.map(b => b.name)),
    fps,
    frameCount,
    bones,
    clip
  };
}
