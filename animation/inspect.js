// Rig quality check - what to fix BEFORE animating.
//
// An animation is only as good as the rig under it, and the failures are
// silent: a leg weighted to the other leg walks with both, a mesh whose floor
// is not at y=0 floats or sinks, a left arm named "Head" (a real Auto Rig
// result in this library) defeats every name-based retarget. Each finding
// names the tool that fixes it, the same contract inspect_mesh keeps.
import * as THREE from 'three';
import { restJointWorlds } from './gltfRig.js';
import { weightedJointCounts } from './analyze.js';

const SIDE_LEFT = /(^|[^a-z])(left|l)([^a-z]|$)|Left|[a-z0-9]L$|_l$|\.l$|_L$|\.L$/;
const SIDE_RIGHT = /(^|[^a-z])(right|r)([^a-z]|$)|Right|[a-z0-9]R$|_r$|\.r$|_R$|\.R$/;
// "ear" only as its own word - "ForeArm" contains e-A-r.
const HEAD_TOKEN = /head|skull|jaw|mouth|nose|(^|[_\-.:\s])ear|Ear(?![a-z])|eye/i;
const LIMB_TOKEN = /hand|finger|thumb|foot|toe|ankle|wrist|forearm|upperarm|thigh|calf|shin|knee|elbow/i;

function nameSide(name) {
  // Strip a rig prefix like "mixamorig:" first; the side lives in the rest.
  const bare = String(name).replace(/^[A-Za-z]+[:|]/, '');
  const left = SIDE_LEFT.test(bare);
  const right = SIDE_RIGHT.test(bare);
  if (left === right) return 0;
  return left ? 1 : -1;
}

/**
 * Inspect a rig. Returns { verdict, issues[], stats }. Each issue:
 * { severity: 'error'|'warning'|'info', check, message, fixTool?, fixArgs? }.
 */
export function inspectRig(rig, description) {
  const issues = [];
  const add = (severity, check, message, fix = {}) => issues.push({ severity, check, message, ...fix });
  const n = rig.joints.length;
  const P = restJointWorlds(rig).map(m => new THREE.Vector3().setFromMatrixPosition(m));
  const weighted = weightedJointCounts(rig);
  const height = description.size.height || 1;
  const scale = Math.max(height, description.size.length, description.size.width, 1e-6);
  const chainOf = new Map();
  for (const c of description.chains) for (const b of c.bones) chainOf.set(b, c);

  // ---- scale and placement ---------------------------------------------
  if (height < 0.05) add('warning', 'scale', `The character is only ${height.toFixed(3)} units tall. glTF is in metres; it may have been exported in the wrong units, and physics/engine imports will treat it as tiny.`);
  if (height > 50) add('warning', 'scale', `The character is ${height.toFixed(1)} units tall. glTF is in metres; it was probably exported in centimetres.`);
  const groundY = description.size.groundY;
  if (Math.abs(groundY) > 0.02 * height) {
    add('warning', 'pivot', `The mesh's lowest point is at y=${groundY.toFixed(3)}, not on the ground (y=0). Animations will float or sink in engines.`,
      { fixTool: 'move_mesh_pivot', fixArgs: { mode: 'ground_pivot' } });
  }

  // ---- facing --------------------------------------------------------------
  const fwd = description.frame.forward;
  if (fwd === '+x' || fwd === '-x') {
    add('warning', 'facing', `The character faces ${fwd}; glTF characters face +Z. Engines and retargeting assume +Z.`);
  } else if (fwd === '-z') {
    add('info', 'facing', 'The character faces -Z (glTF convention is +Z). Fine if intended.');
  }
  if (description.frame.lateralConfidence < 0.25) {
    add('warning', 'facing', `Left/right could not be told apart confidently (confidence ${description.frame.lateralConfidence}). Check the facing in the preview and set it with annotate_rig { forward }.`, { fixTool: 'annotate_rig' });
  }
  if (/defaulted/.test(description.frame.forwardReason || '') || /ambiguous/.test(description.frame.headReason || '')) {
    add('info', 'facing', `Facing was a default guess (${description.frame.forwardReason}). Confirm it from describe_rig's image; set it with annotate_rig if wrong.`, { fixTool: 'annotate_rig' });
  }

  // ---- structure -------------------------------------------------------------
  const roots = rig.jointRoots.map(j => rig.joints[j].name);
  if (roots.length > 1) {
    const weightedRoots = rig.jointRoots.filter(r => subtreeWeighted(r));
    add(weightedRoots.length > 1 ? 'warning' : 'info', 'structure',
      `The skeleton has ${roots.length} root bones (${roots.join(', ')})${weightedRoots.length > 1 ? '; more than one moves the mesh, so the root controls move only part of it' : '; the extra ones move no vertices (helper/driver bones)'}.`);
  }
  function subtreeWeighted(j) {
    const stack = [j];
    while (stack.length) { const k = stack.pop(); if (weighted[k] > 0) return true; stack.push(...rig.joints[k].children); }
    return false;
  }
  const zeroLength = [];
  for (let j = 0; j < n; j += 1) {
    const p = rig.joints[j].parent;
    if (p >= 0 && P[j].distanceTo(P[p]) < 0.002 * scale && weighted[j] > 0) zeroLength.push(rig.joints[j].name);
  }
  if (zeroLength.length) add('info', 'structure', `${zeroLength.length} weighted bone(s) sit on their parent's joint (zero length): ${zeroLength.slice(0, 8).join(', ')}${zeroLength.length > 8 ? '...' : ''}. Harmless for posing, but they have no direction of their own - pose the chain or the next bone instead.`);
  const unused = rig.joints.filter(j => weighted[j.index] === 0 && j.children.length === 0 && j.parent >= 0).map(j => j.name);
  if (unused.length) add('info', 'structure', `${unused.length} leaf bone(s) move no vertices (end markers or unused): ${unused.slice(0, 8).join(', ')}${unused.length > 8 ? '...' : ''}.`);

  // ---- weights -----------------------------------------------------------------
  const { joints, weights, positions, vertexCount, rigidMask } = rig.geometry;
  let unskinned = 0;
  let badSum = 0;
  const crossSide = new Map();
  const lateral = description.frame.vectors.left;
  const origin = description.origin;
  const midTol = 0.03 * scale;
  const boneSide = new Int8Array(n);
  for (let j = 0; j < n; j += 1) {
    const c = description.chains.find(ch => ch.bones.includes(rig.joints[j].name));
    boneSide[j] = c?.side === 'left' ? 1 : c?.side === 'right' ? -1 : 0;
  }
  for (let v = 0; v < vertexCount; v += 1) {
    if (rigidMask[v]) continue;
    let total = 0;
    for (let k = 0; k < 4; k += 1) total += weights[v * 4 + k] > 0 && joints[v * 4 + k] >= 0 ? weights[v * 4 + k] : 0;
    if (total <= 0) { unskinned += 1; continue; }
    if (Math.abs(total - 1) > 0.02) badSum += 1;
    const lat = (positions[v * 3] - origin[0]) * lateral[0] + (positions[v * 3 + 1] - origin[1]) * lateral[1] + (positions[v * 3 + 2] - origin[2]) * lateral[2];
    if (Math.abs(lat) < midTol) continue;
    const vSide = Math.sign(lat);
    for (let k = 0; k < 4; k += 1) {
      const j = joints[v * 4 + k];
      if (j < 0 || weights[v * 4 + k] < 0.2) continue;
      if (boneSide[j] && boneSide[j] === -vSide) crossSide.set(j, (crossSide.get(j) || 0) + 1);
    }
  }
  if (unskinned) add('error', 'weights', `${unskinned} vertices are not weighted to any bone - they will stay frozen in place while the rest moves.`, { fixTool: 'auto_rig_mesh' });
  if (badSum) add('warning', 'weights', `${badSum} vertices have weights that do not sum to 1 - they shrink toward the origin when posed.`);
  // Limbs only: near the mid line (a head, a tail root) the side of a vertex is
  // too close to call, and that is not where "legs stuck together" happens.
  const limbKinds = new Set(['leg', 'arm', 'wing']);
  const leaks = [...crossSide.entries()]
    .filter(([j, count]) => limbKinds.has(chainOf.get(rig.joints[j].name)?.kind) && count > Math.max(20, 0.02 * weighted[j]))
    .sort((a, b) => b[1] - a[1]);
  if (leaks.length) {
    add('error', 'weights', `Weights leak across the body: ${leaks.slice(0, 5).map(([j, c]) => `${rig.joints[j].name} (${chainOf.get(rig.joints[j].name)?.label}) pulls ${c} vertices on the OTHER side`).join('; ')}. Those parts will move together (legs stuck together, an arm dragging the torso).`,
      { fixTool: 'auto_rig_mesh' });
  }

  // ---- symmetry ------------------------------------------------------------------
  const L = new THREE.Vector3().fromArray(lateral);
  const seenPairs = new Set();
  for (const chain of description.chains) {
    if (!chain.mirror || seenPairs.has(chain.label)) continue;
    // Limbs only. Sub-chains (fingers) pair by order and an asymmetric hand
    // pairs the wrong fingers; ears and horns are often posed asymmetrically.
    if (!['leg', 'arm', 'wing'].includes(chain.kind)) continue;
    const other = description.chains.find(c => c.label === chain.mirror);
    if (!other) continue;
    seenPairs.add(chain.label); seenPairs.add(other.label);
    const ratio = chain.length > 0 && other.length > 0 ? Math.max(chain.length, other.length) / Math.min(chain.length, other.length) : 1;
    if (ratio > 1.2) add('warning', 'symmetry', `${chain.label} and ${other.label} differ in length by ${Math.round((ratio - 1) * 100)}% - a mirrored pose will look lopsided.`);
    if (chain.bones.length !== other.bones.length) add('info', 'symmetry', `${chain.label} has ${chain.bones.length} bones but ${other.label} has ${other.bones.length}.`);
    // Rest direction: mirror one chain's base->tip and compare.
    const dirOf = (c) => {
      const a = P[rig.jointByName.get(c.bones[0])];
      const b = P[rig.jointByName.get(c.bones[c.bones.length - 1])];
      return new THREE.Vector3().subVectors(b, a).normalize();
    };
    const da = dirOf(chain);
    const db = dirOf(other);
    const mirrored = db.clone().sub(L.clone().multiplyScalar(2 * db.dot(L)));
    const angle = da.angleTo(mirrored) * 180 / Math.PI;
    if (angle > 25) add('error', 'symmetry', `${chain.label} and ${other.label} do not mirror at rest (${Math.round(angle)} degrees apart). One of them is mis-rigged; it will break mirrored poses and retargeting.`, { fixTool: 'auto_rig_mesh' });
  }

  // ---- naming ------------------------------------------------------------------------
  const sideMismatch = [];
  const partMismatch = [];
  for (const bone of description.bones) {
    const chain = chainOf.get(bone.name);
    if (!chain) continue;
    const ns = nameSide(bone.name);
    const gs = chain.side === 'left' ? 1 : chain.side === 'right' ? -1 : 0;
    if (ns && gs && ns !== gs) sideMismatch.push(`${bone.name} (${chain.label})`);
    const isLimb = ['leg', 'arm', 'wing'].includes(chain.kind);
    const isHead = ['head', 'neck', 'head_appendage'].includes(chain.kind);
    const isTrunk = ['spine', 'neck', 'head', 'tail', 'body'].includes(chain.kind);
    if (isLimb && HEAD_TOKEN.test(bone.name)) partMismatch.push(`${bone.name} (${chain.label})`);
    else if ((isHead || isTrunk) && LIMB_TOKEN.test(bone.name)) partMismatch.push(`${bone.name} (${chain.label})`);
  }
  if (sideMismatch.length) add('warning', 'naming', `${sideMismatch.length} bone name(s) claim the opposite side from where they are: ${sideMismatch.slice(0, 6).join(', ')}${sideMismatch.length > 6 ? '...' : ''}. Either the model faces backward (set annotate_rig forward) or the names are wrong; name-based retargeting will mirror them.`, { fixTool: 'annotate_rig' });
  if (partMismatch.length) add('warning', 'naming', `${partMismatch.length} bone name(s) name a different body part than where they sit: ${partMismatch.slice(0, 6).join(', ')}${partMismatch.length > 6 ? '...' : ''}. The bone renaming went wrong at rig time; the animation tools ignore names, but retargeting and engine humanoid setup will not.`);

  // ---- animatability -------------------------------------------------------------------
  const contacts = description.chains.filter(c => c.contact);
  if (!contacts.length && !/limbless/.test(description.bodyPlan)) {
    add('info', 'contacts', 'No ground-contact chain was found, so foot-sliding checks are off. Name the feet with annotate_rig { contacts: [...] }.', { fixTool: 'annotate_rig' });
  }
  const generic = description.chains.filter(c => ['appendage', 'extra'].includes(c.kind));
  if (generic.length) add('info', 'labels', `${generic.length} chain(s) got generic labels (${generic.map(c => c.label).slice(0, 6).join(', ')}). Rename them with annotate_rig { chainRenames } so poses read naturally.`, { fixTool: 'annotate_rig' });

  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  return {
    verdict: errors ? 'fix before animating' : warnings ? 'animatable, with caveats' : 'ready to animate',
    issues,
    stats: {
      bones: n,
      weightedBones: weighted.filter(c => c > 0).length,
      vertices: vertexCount,
      triangles: rig.geometry.triangleCount,
      unskinnedVertices: unskinned,
      roots
    }
  };
}
