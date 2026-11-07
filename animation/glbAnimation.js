// Read and write animation clips inside a GLB, without touching anything else.
//
// Same principle as meshPivot.js and meshRigTransfer.js: the file's meshes,
// materials, images and skin are carried through byte for byte. Writing a clip
// APPENDS its keyframe data to the binary chunk and adds one `animations`
// entry; the spec that produced it rides in that entry's `extras`, so the GLB
// is self-describing ("this clip was compiled from this spec") and engines,
// which ignore extras, see an ordinary animation.
//
// Replacing a clip of the same name drops its entry but leaves its old bytes
// in the BIN chunk. Compacting would mean re-indexing every accessor and
// bufferView in the file - including ones referenced from extensions this code
// does not know - which is exactly the "laundering" these modules refuse to do.
// A clip is tens of kilobytes; the waste is noted, not fixed.
import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { readAccessor } from '../meshRigTransfer.js';

const FLOAT = 5126;

function appendBinary(json, binParts, state, typed) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (state.length % 4)) % 4;
  if (pad) { binParts.push(Buffer.alloc(pad)); state.length += pad; }
  json.bufferViews = json.bufferViews || [];
  json.bufferViews.push({ buffer: 0, byteOffset: state.length, byteLength: bytes.length });
  binParts.push(bytes);
  state.length += bytes.length;
  return json.bufferViews.length - 1;
}

function addAccessor(json, bufferView, type, count, extra = {}) {
  json.accessors = json.accessors || [];
  json.accessors.push({ bufferView, componentType: FLOAT, count, type, ...extra });
  return json.accessors.length - 1;
}

/**
 * Write (or replace) one clip. `clip` comes from compileSpec. `rig` supplies
 * joint -> node indices. Returns the new GLB buffer.
 */
export function writeClip(buffer, rig, clip, { spec = null, replace = true } = {}) {
  const { json, bin } = parseGlb(buffer);
  json.animations = json.animations || [];
  if (replace) json.animations = json.animations.filter(a => a?.name !== clip.name);

  const existing = bin ? Buffer.from(bin) : Buffer.alloc(0);
  const binParts = [existing];
  const state = { length: existing.length };
  if (!json.buffers || !json.buffers.length) json.buffers = [{ byteLength: 0 }];

  const timeView = appendBinary(json, binParts, state, clip.times);
  const timeAccessor = addAccessor(json, timeView, 'SCALAR', clip.times.length, {
    min: [clip.times[0]],
    max: [clip.times[clip.times.length - 1]]
  });

  const samplers = [];
  const channels = [];
  for (const [joint, values] of clip.rotations) {
    const view = appendBinary(json, binParts, state, values);
    const output = addAccessor(json, view, 'VEC4', clip.times.length);
    samplers.push({ input: timeAccessor, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: rig.joints[joint].node, path: 'rotation' } });
  }
  if (clip.translation) {
    const view = appendBinary(json, binParts, state, clip.translation.values);
    const output = addAccessor(json, view, 'VEC3', clip.times.length);
    samplers.push({ input: timeAccessor, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: rig.joints[clip.translation.joint].node, path: 'translation' } });
  }
  if (!channels.length) throw new Error('The animation does not move any bone, so there is nothing to save.');

  const entry = { name: clip.name, samplers, channels };
  if (spec) entry.extras = { genstudio: { spec, compiledAt: new Date().toISOString() } };
  json.animations.push(entry);

  const newBin = Buffer.concat(binParts);
  json.buffers[0].byteLength = newBin.length;
  return serializeGlb(json, newBin);
}

/** Remove a clip by name. Returns { buffer, removed }. */
export function removeClip(buffer, name) {
  const { json, bin } = parseGlb(buffer);
  const before = (json.animations || []).length;
  json.animations = (json.animations || []).filter(a => a?.name !== name);
  const removed = before - json.animations.length;
  if (!json.animations.length) delete json.animations;
  return { buffer: serializeGlb(json, bin), removed };
}

/** List the clips in a GLB: name, duration, channel count, spec (if any). */
export function listClips(buffer) {
  return listClipsInJson(parseGlb(buffer).json);
}

/** listClips over an already-parsed glTF JSON. */
export function listClipsInJson(json) {
  return (json.animations || []).map((anim, index) => {
    let duration = 0;
    for (const sampler of anim.samplers || []) {
      const acc = (json.accessors || [])[sampler.input];
      if (acc?.max?.[0] > duration) duration = acc.max[0];
    }
    const spec = anim.extras?.genstudio?.spec || null;
    return {
      index,
      name: anim.name || `animation_${index}`,
      duration: Math.round(duration * 1000) / 1000,
      channels: (anim.channels || []).length,
      hasSpec: Boolean(spec),
      spec
    };
  });
}

/**
 * A sampler over one stored clip, for previews: returns (t) => pose Map
 * (node index -> { r?, t?, s? }). Linear / step; CUBICSPLINE reads only the
 * value part (good enough to look at).
 */
export function clipSampler(rig, animIndex) {
  const anim = (rig.json.animations || [])[animIndex];
  if (!anim) throw new Error(`The mesh has no animation #${animIndex}.`);
  const tracks = [];
  let duration = 0;
  for (const channel of anim.channels || []) {
    const sampler = anim.samplers?.[channel.sampler];
    const node = channel.target?.node;
    const path = channel.target?.path;
    if (!sampler || node === undefined || !['rotation', 'translation', 'scale'].includes(path)) continue;
    const input = readAccessor(rig.json, rig.bin, sampler.input).values;
    const output = readAccessor(rig.json, rig.bin, sampler.output);
    const width = path === 'rotation' ? 4 : 3;
    const cubic = sampler.interpolation === 'CUBICSPLINE';
    duration = Math.max(duration, input[input.length - 1] || 0);
    tracks.push({ node, path, input, values: output.values, width, cubic, step: sampler.interpolation === 'STEP' });
  }
  const sample = (t) => {
    const pose = new Map();
    for (const tr of tracks) {
      const { input, values, width, cubic } = tr;
      let i = 0;
      while (i < input.length - 1 && input[i + 1] <= t) i += 1;
      const j = Math.min(i + 1, input.length - 1);
      const span = input[j] - input[i];
      const u = tr.step || span <= 0 ? 0 : Math.min(1, Math.max(0, (t - input[i]) / span));
      const read = (k) => {
        const base = cubic ? (k * 3 + 1) * width : k * width;
        return Array.from(values.subarray(base, base + width));
      };
      const a = read(i);
      const b = read(j);
      const entry = pose.get(tr.node) || {};
      if (tr.path === 'rotation') {
        const qa = new THREE.Quaternion().fromArray(a);
        const qb = new THREE.Quaternion().fromArray(b);
        entry.r = qa.slerp(qb, u).normalize();
      } else {
        const v = new THREE.Vector3(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
        if (tr.path === 'translation') entry.t = v; else entry.s = v;
      }
      pose.set(tr.node, entry);
    }
    return pose;
  };
  return { name: anim.name || `animation_${animIndex}`, duration, sample };
}
