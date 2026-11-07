// Rig surgery on a GLB, headless: rename bones, add and split bones, rewrite
// skin weights. The tools an agent uses to PREPARE a rig before animating it -
// the server-side counterparts of the Mesh Editor's bone editing
// (src/utils/meshRigEdit.js), which only exists in the browser.
//
// Same contract as meshPivot.js / meshRigTransfer.js: materials, images, UVs
// and every untouched accessor are carried through byte for byte. Edits APPEND
// new accessors (new weights, a longer inverse-bind list) and repoint the
// primitive / skin at them; the superseded bytes stay behind in the BIN chunk.
//
// Index spaces: every function here takes JOINT indices (skin order, what
// JOINTS_0 stores) as loadRig() reports them, never node indices.
import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { loadRig, computeNodeWorlds, restJointWorlds } from './gltfRig.js';

const FLOAT = 5126;
const USHORT = 5123;

// ---- editable container ------------------------------------------------------

function openEditable(buffer) {
  const { json, bin } = parseGlb(buffer);
  const existing = bin ? Buffer.from(bin) : Buffer.alloc(0);
  if (!json.buffers || !json.buffers.length) json.buffers = [{ byteLength: 0 }];
  return { json, parts: [existing], length: existing.length };
}

function appendView(ed, typed) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (ed.length % 4)) % 4;
  if (pad) { ed.parts.push(Buffer.alloc(pad)); ed.length += pad; }
  ed.json.bufferViews = ed.json.bufferViews || [];
  ed.json.bufferViews.push({ buffer: 0, byteOffset: ed.length, byteLength: bytes.length });
  ed.parts.push(bytes);
  ed.length += bytes.length;
  return ed.json.bufferViews.length - 1;
}

function appendAccessor(ed, typed, componentType, type, count, extra = {}) {
  const view = appendView(ed, typed);
  ed.json.accessors = ed.json.accessors || [];
  ed.json.accessors.push({ bufferView: view, componentType, count, type, ...extra });
  return ed.json.accessors.length - 1;
}

function finish(ed) {
  const bin = Buffer.concat(ed.parts);
  ed.json.buffers[0].byteLength = bin.length;
  return serializeGlb(ed.json, bin);
}

function setNodeMatrix(node, matrix) {
  const t = new THREE.Vector3(); const r = new THREE.Quaternion(); const s = new THREE.Vector3();
  matrix.decompose(t, r, s);
  delete node.matrix;
  node.translation = t.toArray();
  node.rotation = r.normalize().toArray();
  if (Math.abs(s.x - 1) > 1e-6 || Math.abs(s.y - 1) > 1e-6 || Math.abs(s.z - 1) > 1e-6) node.scale = s.toArray();
  else delete node.scale;
}

// ---- names -------------------------------------------------------------------------

/**
 * Rename bones. `map` is old name -> new name (names as loadRig reports them).
 * Returns { buffer, renamed: [[old, new]] }. Specs stored in clip extras are
 * rewritten too, so a pose target naming a bone still finds it.
 */
export function renameBones(buffer, map) {
  const rig = loadRig(buffer);
  const ed = openEditable(buffer);
  const renamed = [];
  const taken = new Set(rig.joints.map(j => j.name));
  for (const [from, to] of Object.entries(map)) {
    const j = rig.jointByName.get(from);
    if (j === undefined) throw new Error(`No bone named "${from}".`);
    const name = String(to).trim();
    if (!name) throw new Error(`Empty new name for "${from}".`);
    if (name !== from && taken.has(name) && !Object.prototype.hasOwnProperty.call(map, name)) {
      throw new Error(`"${name}" is already the name of another bone.`);
    }
    renamed.push([from, name]);
  }
  const finalNames = new Map(rig.joints.map(j => [j.name, j.name]));
  for (const [from, to] of renamed) finalNames.set(from, to);
  const counts = new Map();
  for (const n of finalNames.values()) counts.set(n, (counts.get(n) || 0) + 1);
  const dup = [...counts.entries()].find(([, c]) => c > 1);
  if (dup) throw new Error(`Renaming would give two bones the name "${dup[0]}".`);

  for (const [from, to] of renamed) ed.json.nodes[rig.joints[rig.jointByName.get(from)].node].name = to;
  const lookup = new Map(renamed);
  for (const anim of ed.json.animations || []) {
    const spec = anim.extras?.genstudio?.spec;
    if (!spec) continue;
    for (const key of spec.keys || []) {
      if (!key.pose) continue;
      key.pose = Object.fromEntries(Object.entries(key.pose).map(([t, c]) => [lookup.get(t) || t, c]));
    }
    for (const layer of spec.layers || []) {
      for (const field of ['target', 'targets']) {
        if (typeof layer[field] === 'string') layer[field] = lookup.get(layer[field]) || layer[field];
        else if (Array.isArray(layer[field])) layer[field] = layer[field].map(t => lookup.get(t) || t);
      }
    }
  }
  return { buffer: finish(ed), renamed };
}

const MIXAMO_ARM = ['Shoulder', 'Arm', 'ForeArm', 'Hand'];
const MIXAMO_LEG = ['UpLeg', 'Leg', 'Foot', 'ToeBase', 'Toe_End'];

/**
 * Naming schemes from the rig description.
 *  - "semantic": <chain>_<n> (head_1, leg_front_L_2 ...) - readable by an agent
 *    and stable across re-rigs of the same creature.
 *  - "mixamo": the Mixamo humanoid names, so name-based retargeting and engine
 *    humanoid setup work. Only for upright bipeds with arms.
 * Returns a map old -> new (unchanged names omitted).
 */
export function namingScheme(rig, description, scheme, { prefix = 'mixamorig:' } = {}) {
  const map = {};
  if (scheme === 'semantic') {
    for (const chain of description.chains) {
      if (chain.kind === 'helper' || chain.kind === 'extra') continue;
      const base = chain.label.replace(/[^A-Za-z0-9_]+/g, '_');
      chain.bones.forEach((bone, i) => {
        const name = chain.bones.length === 1 ? base : `${base}_${i + 1}`;
        if (name !== bone) map[bone] = name;
      });
    }
    return map;
  }
  if (scheme === 'mixamo') {
    if (!/biped \(humanoid/.test(description.bodyPlan)) {
      throw new Error(`Mixamo names are for humanoid bipeds; this rig reads as "${description.bodyPlan}". Use the "semantic" scheme.`);
    }
    const byLabel = new Map(description.chains.map(c => [c.label, c]));
    const set = (bone, name) => { if (bone && name && bone !== `${prefix}${name}`) map[bone] = `${prefix}${name}`; };
    const spine = byLabel.get('spine')?.bones || [];
    spine.forEach((b, i) => set(b, i === 0 ? 'Hips' : i === 1 ? 'Spine' : `Spine${i - 1}`));
    const neck = byLabel.get('neck')?.bones || [];
    neck.forEach((b, i) => set(b, i === 0 ? 'Neck' : `Neck${i}`));
    const head = byLabel.get('head')?.bones || [];
    const isLeaf = name => !description.bones.some(x => x.parent === name);
    head.forEach((b, i) => set(b, i === 0 ? 'Head' : (i === head.length - 1 && isLeaf(b) ? 'HeadTop_End' : `Head${i}`)));
    for (const side of ['L', 'R']) {
      const sideName = side === 'L' ? 'Left' : 'Right';
      // The HAND is where the fingers branch; the arm's main chain runs on
      // into its longest finger, which is a finger, not more arm.
      const armAll = byLabel.get(`arm_${side}`)?.bones || [];
      const fingerChains = description.chains.filter(c => c.label.startsWith(`arm_${side}.part_`));
      const attaches = fingerChains.map(c => c.attach);
      let handAt = armAll.findIndex(b => attaches.includes(b));
      if (handAt < 0) handAt = armAll.length - 1;
      const arm = armAll.slice(0, handAt + 1);
      const mainFinger = armAll.slice(handAt + 1);
      // Named from the HAND back: the clavicle is the optional bone.
      const armNames = MIXAMO_ARM.slice(Math.max(0, MIXAMO_ARM.length - arm.length));
      const extraUpper = arm.length - armNames.length;
      arm.forEach((b, i) => set(b, i < extraUpper ? `${sideName}Shoulder${i ? i + 1 : ''}` : `${sideName}${armNames[i - extraUpper]}`));
      // Legs from the HIP down: the toe is the optional bone.
      const leg = byLabel.get(`leg_${side}`)?.bones || [];
      leg.forEach((b, i) => set(b, i < MIXAMO_LEG.length ? `${sideName}${MIXAMO_LEG[i]}` : `${sideName}Toe${i}`));
      // Fingers (the sub-chains plus the main chain's remainder), front to
      // back: in a T/A pose that is thumb, index, middle, ring, pinky.
      const posOf = name => description.bones.find(x => x.name === name)?.position || [0, 0, 0];
      // The THUMB is the finger whose base sits closest to the wrist; the rest
      // run front to back. (Front-to-back alone put the index first on a rig
      // whose index knuckle is ahead of the thumb's.)
      const hand = posOf(arm[arm.length - 1]);
      const dist = name => { const q = posOf(name); return Math.hypot(q[0] - hand[0], q[1] - hand[1], q[2] - hand[2]); };
      let fingers = [...fingerChains.map(c => c.bones), ...(mainFinger.length ? [mainFinger] : [])];
      if (fingers.length >= 2) {
        const thumb = fingers.reduce((best, f) => (dist(f[0]) < dist(best[0]) ? f : best));
        fingers = [thumb, ...fingers.filter(f => f !== thumb).sort((x, y) => posOf(y[0])[0] - posOf(x[0])[0])];
      }
      const fingerNames = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
      fingers.forEach((bones, k) => bones.forEach((b, i) => set(b, `${sideName}Hand${fingerNames[k] || `Finger${k + 1}`}${i + 1}`)));
    }
    return map;
  }
  throw new Error(`Unknown naming scheme "${scheme}". Use "semantic" or "mixamo".`);
}

// ---- weights ---------------------------------------------------------------------------

/**
 * Write merged joints/weights (rig.geometry layout) back into the primitives.
 * Primitives bound to a SECOND skin are left alone (reported in `skipped`).
 */
function writeWeights(ed, rig, joints, weights) {
  const skipped = [];
  const done = new Set();
  for (const range of rig.geometry.ranges) {
    if (!range.skinned) continue;
    const key = `${range.meshIndex}/${range.primitiveIndex}`;
    if (done.has(key)) continue;
    done.add(key);
    if (range.remapped) { skipped.push(key); continue; }
    const j16 = new Uint16Array(range.count * 4);
    const w32 = new Float32Array(range.count * 4);
    for (let v = 0; v < range.count; v += 1) {
      const src = (range.offset + v) * 4;
      let sum = 0;
      for (let k = 0; k < 4; k += 1) if (joints[src + k] >= 0 && weights[src + k] > 0) sum += weights[src + k];
      for (let k = 0; k < 4; k += 1) {
        const ok = joints[src + k] >= 0 && weights[src + k] > 0 && sum > 0;
        j16[v * 4 + k] = ok ? joints[src + k] : 0;
        w32[v * 4 + k] = ok ? weights[src + k] / sum : 0;
      }
      if (sum <= 0) { j16[v * 4] = 0; w32[v * 4] = 1; } // never leave a vertex weightless (it would collapse to the origin)
    }
    const primitive = ed.json.meshes[range.meshIndex].primitives[range.primitiveIndex];
    primitive.attributes.JOINTS_0 = appendAccessor(ed, j16, USHORT, 'VEC4', range.count);
    primitive.attributes.WEIGHTS_0 = appendAccessor(ed, w32, FLOAT, 'VEC4', range.count);
    // Our weights hold four influences; a stale second set would add to them.
    delete primitive.attributes.JOINTS_1;
    delete primitive.attributes.WEIGHTS_1;
  }
  return { skipped };
}

/** Add `share` of joint `to` to a vertex's influences, displacing the weakest slot if needed. */
function addInfluence(joints, weights, v, from, to, share) {
  let fromSlot = -1;
  let toSlot = -1;
  for (let k = 0; k < 4; k += 1) {
    if (joints[v * 4 + k] === from && weights[v * 4 + k] > 0) fromSlot = k;
    if (joints[v * 4 + k] === to && weights[v * 4 + k] > 0) toSlot = k;
  }
  if (fromSlot < 0 || share <= 1e-6) return false;
  share = Math.min(share, weights[v * 4 + fromSlot]);
  if (toSlot >= 0) {
    weights[v * 4 + fromSlot] -= share;
    weights[v * 4 + toSlot] += share;
    return true;
  }
  let victim = -1;
  let smallest = Infinity;
  for (let k = 0; k < 4; k += 1) {
    if (k === fromSlot) continue;
    const w = joints[v * 4 + k] >= 0 ? weights[v * 4 + k] : 0;
    if (w < smallest) { smallest = w; victim = k; }
  }
  // glTF holds four influences: a fifth only displaces a WEAKER one.
  if (victim < 0 || smallest >= share) return false;
  weights[v * 4 + fromSlot] -= share;
  if (smallest > 0) weights[v * 4 + fromSlot] += smallest; // hand the evicted share back to the source
  joints[v * 4 + victim] = to;
  weights[v * 4 + victim] = share;
  return true;
}

// ---- adding joints -------------------------------------------------------------------------

/**
 * Append a joint node under `parentJoint` at a WORLD position, register it in
 * the skin with its inverse bind matrix. Returns { ed, joint } - the new joint
 * index is the old joint count.
 */
function appendJoint(ed, rig, parentJoint, name, worldPos) {
  const json = ed.json;
  const parentNode = rig.joints[parentJoint].node;
  const worlds = computeNodeWorlds(rig, null);
  const parentWorld = worlds[parentNode];
  const local = worldPos.clone().applyMatrix4(parentWorld.clone().invert());
  json.nodes.push({ name, translation: local.toArray() });
  const nodeIndex = json.nodes.length - 1;
  const parent = json.nodes[parentNode];
  parent.children = [...(parent.children || []), nodeIndex];
  const newWorld = parentWorld.clone().multiply(new THREE.Matrix4().makeTranslation(local.x, local.y, local.z));
  return { nodeIndex, newWorld };
}

function rewriteInverseBinds(ed, rig, extraWorlds) {
  const skin = ed.json.skins[rig.skinIndex];
  const count = rig.joints.length + extraWorlds.length;
  const values = new Float32Array(count * 16);
  rig.inverseBind.forEach((m, i) => values.set(m.elements, i * 16));
  extraWorlds.forEach((w, i) => values.set(w.clone().invert().elements, (rig.joints.length + i) * 16));
  skin.inverseBindMatrices = appendAccessor(ed, values, FLOAT, 'MAT4', count);
}

/**
 * Add a child bone. `position` is a world point; `takeWeights` moves influence
 * from the parent to the new bone for the parent's vertices that reach past it
 * (smooth band, the Mesh Editor's rule). Returns { buffer, name, moved }.
 */
export function addBone(buffer, { parent, name, position, takeWeights = true, band = 0.35 }) {
  const rig = loadRig(buffer);
  const parentJoint = rig.jointByName.get(parent);
  if (parentJoint === undefined) throw new Error(`No bone named "${parent}".`);
  const boneName = String(name || `${parent}_child`).trim();
  if (rig.jointByName.has(boneName)) throw new Error(`A bone named "${boneName}" already exists.`);
  const ed = openEditable(buffer);
  const { nodeIndex, newWorld } = appendJoint(ed, rig, parentJoint, boneName, position);
  ed.json.skins[rig.skinIndex].joints.push(nodeIndex);
  rewriteInverseBinds(ed, rig, [newWorld]);

  let moved = 0;
  if (takeWeights) {
    const newJoint = rig.joints.length;
    const joints = Int16Array.from(rig.geometry.joints);
    const weights = Float32Array.from(rig.geometry.weights);
    const origin = new THREE.Vector3().setFromMatrixPosition(restJointWorlds(rig)[parentJoint]);
    const axis = position.clone().sub(origin);
    const length = axis.length();
    if (length < 1e-6) throw new Error('The new bone sits on its parent\'s joint - give it a position away from it, or pass takeWeights: false.');
    axis.divideScalar(length);
    const p = rig.geometry.positions;
    for (let v = 0; v < rig.geometry.vertexCount; v += 1) {
      const t = ((p[v * 3] - origin.x) * axis.x + (p[v * 3 + 1] - origin.y) * axis.y + (p[v * 3 + 2] - origin.z) * axis.z) / length;
      const s = Math.min(1, Math.max(0, (t - (1 - band)) / (2 * band)));
      const fraction = s * s * (3 - 2 * s);
      if (fraction <= 1e-4) continue;
      let w = 0;
      for (let k = 0; k < 4; k += 1) if (joints[v * 4 + k] === parentJoint) w = weights[v * 4 + k];
      if (w > 0 && addInfluence(joints, weights, v, parentJoint, newJoint, w * fraction)) moved += 1;
    }
    writeWeights(ed, rig, joints, weights);
  }
  return { buffer: finish(ed), name: boneName, moved };
}

/**
 * Split a bone into `parts` bones along the line to its (main) child: the new
 * joints are inserted between them, the child is re-parented keeping its world
 * transform, and the bone's weights are spread along the new segments with
 * smooth blends. The tool for a one-bone tail or a stiff long neck.
 * Returns { buffer, added: [names] }.
 */
export function splitBone(buffer, { bone, parts = 2, child = null }) {
  const rig = loadRig(buffer);
  const j = rig.jointByName.get(bone);
  if (j === undefined) throw new Error(`No bone named "${bone}".`);
  const n = Math.max(2, Math.min(8, Math.round(parts)));
  const worlds0 = restJointWorlds(rig);
  const P = worlds0.map(m => new THREE.Vector3().setFromMatrixPosition(m));
  let c = child !== null ? rig.jointByName.get(child) : null;
  if (child !== null && (c === undefined || rig.joints[c].parent !== j)) throw new Error(`"${child}" is not a child of "${bone}".`);
  if (c === null || c === undefined) {
    let best = -1;
    let bestLen = 0;
    for (const k of rig.joints[j].children) { const d = P[k].distanceTo(P[j]); if (d > bestLen) { bestLen = d; best = k; } }
    c = best;
  }
  if (c < 0 || P[c].distanceTo(P[j]) < 1e-6) throw new Error(`"${bone}" has no child joint to split toward (it is a leaf, or its child sits on it). Use add_bone to extend it instead.`);

  const ed = openEditable(buffer);
  const json = ed.json;
  const nodeWorlds = computeNodeWorlds(rig, null);
  const added = [];
  const addedWorlds = [];
  let parentNode = rig.joints[j].node;
  let parentWorld = nodeWorlds[parentNode];
  const childNode = rig.joints[c].node;
  // Detach the child from the bone.
  json.nodes[parentNode].children = (json.nodes[parentNode].children || []).filter(k => k !== childNode);
  for (let i = 1; i < n; i += 1) {
    const world = P[j].clone().lerp(P[c], i / n);
    const local = world.clone().applyMatrix4(parentWorld.clone().invert());
    let name = `${bone}_${i + 1}`;
    while (rig.jointByName.has(name) || added.includes(name)) name += '_';
    json.nodes.push({ name, translation: local.toArray() });
    const idx = json.nodes.length - 1;
    json.nodes[parentNode].children = [...(json.nodes[parentNode].children || []), idx];
    const w = parentWorld.clone().multiply(new THREE.Matrix4().makeTranslation(local.x, local.y, local.z));
    json.skins[rig.skinIndex].joints.push(idx);
    added.push(name);
    addedWorlds.push(w);
    parentNode = idx;
    parentWorld = w;
  }
  // Re-parent the child under the last new joint, keeping its world transform.
  json.nodes[parentNode].children = [...(json.nodes[parentNode].children || []), childNode];
  const childLocal = parentWorld.clone().invert().multiply(nodeWorlds[childNode]);
  setNodeMatrix(json.nodes[childNode], childLocal);
  rewriteInverseBinds(ed, rig, addedWorlds);

  // Spread the bone's weights along the segments.
  const segJoints = [j, ...added.map((_, i) => rig.joints.length + i)];
  const joints = Int16Array.from(rig.geometry.joints);
  const weights = Float32Array.from(rig.geometry.weights);
  const axis = P[c].clone().sub(P[j]);
  const length = axis.length();
  axis.divideScalar(length);
  const p = rig.geometry.positions;
  let moved = 0;
  for (let v = 0; v < rig.geometry.vertexCount; v += 1) {
    let w = 0;
    for (let k = 0; k < 4; k += 1) if (joints[v * 4 + k] === j) w = weights[v * 4 + k];
    if (!(w > 0)) continue;
    const t = ((p[v * 3] - P[j].x) * axis.x + (p[v * 3 + 1] - P[j].y) * axis.y + (p[v * 3 + 2] - P[j].z) * axis.z) / length;
    // Segment coordinate: u in [0, n); blend across segment middles.
    const u = Math.min(n - 1, Math.max(0, t * n - 0.5));
    const lo = Math.floor(u);
    const f = u - lo;
    const fs = f * f * (3 - 2 * f);
    const hi = Math.min(n - 1, lo + 1);
    const shares = new Map();
    shares.set(segJoints[lo], (shares.get(segJoints[lo]) || 0) + w * (1 - fs));
    shares.set(segJoints[hi], (shares.get(segJoints[hi]) || 0) + w * fs);
    let changed = false;
    for (const [target, share] of shares) {
      if (target === j || share <= 1e-6) continue;
      if (addInfluence(joints, weights, v, j, target, share)) changed = true;
    }
    if (changed) moved += 1;
  }
  writeWeights(ed, rig, joints, weights);
  return { buffer: finish(ed), added, child: rig.joints[c].name, moved };
}

// ---- smoothing / rebuilding weights ------------------------------------------------------------

// Position-welded adjacency: UV and hard-normal seams split vertices, and a
// surface walk on the raw index buffer stops at every seam (the weight-brush
// lesson). Returns { canon (vertex -> canonical id), neighbours (Set[] by id), count }.
export function weldedTopology(positions, indices, scale) {
  const q = 1e-5 * Math.max(scale, 1e-9);
  const key = (i) => `${Math.round(positions[i * 3] / q)},${Math.round(positions[i * 3 + 1] / q)},${Math.round(positions[i * 3 + 2] / q)}`;
  const ids = new Map();
  const canon = new Int32Array(positions.length / 3);
  for (let v = 0; v < canon.length; v += 1) {
    const k = key(v);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    canon[v] = id;
  }
  const neighbours = Array.from({ length: ids.size }, () => new Set());
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = canon[indices[t]], b = canon[indices[t + 1]], c = canon[indices[t + 2]];
    if (a !== b) { neighbours[a].add(b); neighbours[b].add(a); }
    if (b !== c) { neighbours[b].add(c); neighbours[c].add(b); }
    if (a !== c) { neighbours[a].add(c); neighbours[c].add(a); }
  }
  return { canon, neighbours, count: ids.size };
}

function topFour(map) {
  return [...map.entries()].filter(([, w]) => w > 1e-5).sort((a, b) => b[1] - a[1]).slice(0, 4);
}

function smoothCanonical(weightsById, neighbours, iterations, strength) {
  let current = weightsById;
  for (let it = 0; it < iterations; it += 1) {
    const next = new Array(current.length);
    for (let id = 0; id < current.length; id += 1) {
      const acc = new Map();
      const own = current[id];
      for (const [j, w] of own) acc.set(j, (1 - strength) * w);
      const nb = neighbours[id];
      if (nb.size) {
        const share = strength / nb.size;
        for (const o of nb) for (const [j, w] of current[o]) acc.set(j, (acc.get(j) || 0) + share * w);
      } else {
        for (const [j, w] of own) acc.set(j, w);
      }
      const top = topFour(acc);
      const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
      next[id] = new Map(top.map(([j, w]) => [j, w / sum]));
    }
    current = next;
  }
  return current;
}

function applyCanonical(rig, canon, weightsById, onlyJoints = null) {
  const joints = Int16Array.from(rig.geometry.joints);
  const weights = Float32Array.from(rig.geometry.weights);
  for (let v = 0; v < rig.geometry.vertexCount; v += 1) {
    if (rig.geometry.rigidMask[v]) continue;
    if (onlyJoints && ![0, 1, 2, 3].some(k => onlyJoints.has(rig.geometry.joints[v * 4 + k]))) continue;
    const top = [...weightsById[canon[v]].entries()].slice(0, 4);
    for (let k = 0; k < 4; k += 1) {
      joints[v * 4 + k] = k < top.length ? top[k][0] : -1;
      weights[v * 4 + k] = k < top.length ? top[k][1] : 0;
    }
  }
  return { joints, weights };
}

/**
 * Smooth the existing weights over the surface (welded across seams).
 * `bones` (optional names) limits the change to vertices those bones touch.
 */
export function smoothWeights(buffer, { iterations = 3, strength = 0.5, bones = null } = {}) {
  const rig = loadRig(buffer);
  const g = rig.geometry;
  const scale = boundsScale(g.positions);
  const { canon, neighbours, count } = weldedTopology(g.positions, g.indices, scale);
  const byId = Array.from({ length: count }, () => new Map());
  for (let v = 0; v < g.vertexCount; v += 1) {
    const m = byId[canon[v]];
    if (m.size) continue;
    for (let k = 0; k < 4; k += 1) {
      const j = g.joints[v * 4 + k];
      if (j >= 0 && g.weights[v * 4 + k] > 0) m.set(j, (m.get(j) || 0) + g.weights[v * 4 + k]);
    }
  }
  const only = bones ? new Set(bones.map((b) => {
    const j = rig.jointByName.get(b);
    if (j === undefined) throw new Error(`No bone named "${b}".`);
    return j;
  })) : null;
  const smoothed = smoothCanonical(byId, neighbours, Math.max(1, Math.min(20, iterations)), Math.max(0.05, Math.min(1, strength)));
  const { joints, weights } = applyCanonical(rig, canon, smoothed, only);
  const ed = openEditable(buffer);
  const { skipped } = writeWeights(ed, rig, joints, weights);
  return { buffer: finish(ed), vertices: g.vertexCount, skipped };
}

function boundsScale(p) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c += 1) { min[c] = Math.min(min[c], p[i + c]); max[c] = Math.max(max[c], p[i + c]); }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
}

/**
 * Rebuild the weights from the skeleton - keep the bones, recompute who moves
 * what. For each vertex: the nearest bone SEGMENTS it can SEE (a ray from the
 * vertex to the segment that does not cross the mesh - so a thigh never claims
 * the other leg, which a plain nearest-bone rule does), weighted by inverse
 * squared distance, then smoothed over the surface. A light "bone heat".
 * `exclude` names bones that must receive no weight (helpers, end markers).
 */
// Defaults measured with deformationTest + the cross-side leak check on the
// war horse, the fox and a humanoid: inverse-SQUARE falloff with ~12 smoothing
// passes beat Auto Rig's own weights on the horse (score 2.1 vs 7.3) and kept
// the hand-made rigs clean; a sharper falloff or fewer passes pinched joints.
export function rebuildWeights(buffer, { smoothing = 12, exclude = [], visibility = true, description = null, falloff = 2, cutoff = 2 } = {}) {
  const rig = loadRig(buffer);
  const g = rig.geometry;
  const scale = boundsScale(g.positions);
  const P = restJointWorlds(rig).map(m => new THREE.Vector3().setFromMatrixPosition(m));
  const excluded = new Set(exclude.map((b) => {
    const j = rig.jointByName.get(b);
    if (j === undefined) throw new Error(`No bone named "${b}".`);
    return j;
  }));
  // Segments: joint -> farthest child (a leaf is a short stub along its parent line).
  const segs = [];
  for (const joint of rig.joints) {
    if (excluded.has(joint.index)) continue;
    const a = P[joint.index];
    let b = null;
    let best = 0;
    for (const c of joint.children) { const d = P[c].distanceTo(a); if (d > best) { best = d; b = P[c]; } }
    if (!b) {
      if (joint.parent < 0) continue;
      const dir = a.clone().sub(P[joint.parent]);
      if (dir.length() < 1e-9 * scale) continue;
      b = a.clone().addScaledVector(dir, 0.5);
    }
    if (a.distanceTo(b) < 1e-4 * scale) continue; // zero-length stubs take no weight; their children do
    segs.push({ joint: joint.index, a, b, ab: b.clone().sub(a) });
  }
  if (!segs.length) throw new Error('No bone has a length to bind the mesh to.');

  const { canon, neighbours, count } = weldedTopology(g.positions, g.indices, scale);
  const rep = new Int32Array(count).fill(-1);
  for (let v = 0; v < g.vertexCount; v += 1) if (rep[canon[v]] < 0) rep[canon[v]] = v;

  let bvh = null;
  const tooBig = g.vertexCount > 150000;
  if (visibility && !tooBig) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
    bvh = new MeshBVH(geo);
  }
  // Side rule (needs the rig description): a LIMB bone never claims a vertex
  // clearly on the other side of the body. Visibility alone cannot stop it -
  // from inside a closed chest the opposite humerus is in plain view through
  // the empty interior (measured: both forelegs pulling ~80 chest vertices
  // each on the wrong side).
  const sideOfJoint = new Int8Array(rig.joints.length);
  let lateral = null;
  let origin = null;
  if (description) {
    lateral = description.frame.vectors.left;
    origin = description.origin;
    for (const c of description.chains) {
      if (!['leg', 'arm', 'wing', 'part', 'appendage', 'head_appendage'].includes(c.kind) || c.side === 'mid') continue;
      const sgn = c.side === 'left' ? 1 : -1;
      for (const b of c.bones) { const j = rig.jointByName.get(b); if (j !== undefined) sideOfJoint[j] = sgn; }
    }
  }
  const midTol = 0.03 * scale;
  const ray = new THREE.Ray();
  const closest = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const byId = new Array(count);
  let blindVertices = 0;
  for (let id = 0; id < count; id += 1) {
    const v = rep[id];
    pos.set(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]);
    const cands = segs.map((s) => {
      const t = Math.min(1, Math.max(0, pos.clone().sub(s.a).dot(s.ab) / s.ab.lengthSq()));
      const point = s.a.clone().addScaledVector(s.ab, t);
      return { joint: s.joint, point, d: point.distanceTo(pos) };
    }).sort((x, y) => x.d - y.d).slice(0, 6);
    const lat = lateral ? (pos.x - origin[0]) * lateral[0] + (pos.y - origin[1]) * lateral[1] + (pos.z - origin[2]) * lateral[2] : 0;
    const m = new Map();
    let nearestVisible = Infinity;
    for (const c of cands) {
      if (Math.abs(lat) > midTol && sideOfJoint[c.joint] === -Math.sign(lat)) continue;
      // Far candidates only blur: keep bones within twice the nearest one.
      if (c.d > cutoff * nearestVisible) continue;
      if (bvh && c.d > 1e-6) {
        closest.copy(c.point).sub(pos);
        const dist = closest.length();
        ray.origin.copy(pos).addScaledVector(closest, 0.02); // step off the surface first
        ray.direction.copy(closest).normalize();
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, dist * 0.97);
        if (hit) continue;
      }
      nearestVisible = Math.min(nearestVisible, c.d);
      const w = 1 / Math.max(c.d ** falloff, 1e-24);
      m.set(c.joint, (m.get(c.joint) || 0) + w);
    }
    if (!m.size) { m.set(cands[0].joint, 1); blindVertices += 1; }
    const top = topFour(m);
    const sum = top.reduce((s, [, w]) => s + w, 0);
    byId[id] = new Map(top.map(([j, w]) => [j, w / sum]));
  }
  const smoothed = smoothCanonical(byId, neighbours, Math.max(0, Math.min(20, smoothing)), 0.5);
  const { joints, weights } = applyCanonical(rig, canon, smoothed);
  const ed = openEditable(buffer);
  const { skipped } = writeWeights(ed, rig, joints, weights);
  return {
    buffer: finish(ed),
    vertices: g.vertexCount,
    bonesUsed: new Set(segs.map(s => s.joint)).size,
    visibility: Boolean(bvh),
    ...(tooBig && visibility ? { note: 'Over 150k vertices: visibility tests were skipped (nearest-bone + smoothing only). Decimate first for cleaner weights.' } : {}),
    blindVertices,
    skipped
  };
}
