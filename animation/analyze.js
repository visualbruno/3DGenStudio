// Rig perception: turn a bare bone tree into a body an animator can talk about.
//
// An LLM handed "bone_12 is a child of bone_7 at (0.12, 0.40, -0.31)" cannot
// animate anything. Handed "leg_front_L: 4 bones, attaches to spine at the
// chest, hangs to the ground" it can. This module produces the second from the
// first, from GEOMETRY ONLY - Auto Rig is stochastic (the same boar came back
// as 32 bones once and 27 the next, different topology) and hand-made rigs use
// any naming at all, so names are never trusted.
//
// The rules that do the work, most of them learned the hard way in
// thirdparty/skintokens/src/rig_package/species_template.py:
//   * The lateral axis is the one the skeleton MIRRORS across non-trivially.
//   * Limbs come in mirrored pairs; spines and tails do not. Whatever has no
//     mirror twin is body.
//   * A branch's SIDE comes from its whole subtree - limbs often hang off a
//     zero-length stub on the mid line, whose own position says nothing.
//   * The head end of the body axis is the end the side branches crowd toward
//     (front limbs, ears, jaw); a tail tip carries nothing.
//
// Everything here is overridable by a rig profile (annotate_rig) because a
// heuristic WILL be wrong on some creature, and the fix must not be "re-rig".
import * as THREE from 'three';
import { restJointWorlds } from './gltfRig.js';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function axisName(v) {
  const names = ['x', 'y', 'z'];
  let best = 0;
  for (let i = 1; i < 3; i += 1) if (Math.abs(v[i]) > Math.abs(v[best])) best = i;
  if (Math.abs(Math.abs(v[best]) - 1) > 1e-3) return `(${v.map(n => n.toFixed(2)).join(', ')})`;
  return `${v[best] > 0 ? '+' : '-'}${names[best]}`;
}

export function parseAxis(text) {
  const m = /^([+-])?([xyz])$/i.exec(String(text || '').trim());
  if (!m) return null;
  const v = AXES[m[2].toLowerCase()].slice();
  return m[1] === '-' ? v.map(n => -n) : v;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Joints that move at least one vertex (weight > 0.01). */
export function weightedJointCounts(rig) {
  const counts = new Int32Array(rig.joints.length);
  const { joints, weights, vertexCount } = rig.geometry;
  for (let v = 0; v < vertexCount; v += 1) {
    for (let k = 0; k < 4; k += 1) {
      const j = joints[v * 4 + k];
      if (j >= 0 && weights[v * 4 + k] > 0.01) counts[j] += 1;
    }
  }
  return counts;
}

function meshBounds(rig) {
  const p = rig.geometry.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let c = 0; c < 3; c += 1) {
      if (p[i + c] < min[c]) min[c] = p[i + c];
      if (p[i + c] > max[c]) max[c] = p[i + c];
    }
  }
  if (!Number.isFinite(min[0])) return null;
  return { min, max };
}

// How well the joint set mirrors across the plane `axis = centre`, relative to
// how far the joints spread along that axis. Mirroring onto ITSELF is trivial
// (everything near the plane), so the error is divided by the spread: a T-pose
// mirrors both across X (arm onto arm) and across Z (everything is flat), and
// only the first is the lateral axis.
function mirrorScore(points, axis, centre, scale) {
  const errors = [];
  let lo = Infinity, hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]);
    const m = p.slice(); m[axis] = 2 * centre - p[axis];
    let best = Infinity;
    for (const q of points) best = Math.min(best, Math.hypot(m[0] - q[0], m[1] - q[1], m[2] - q[2]));
    errors.push(best);
  }
  const spread = Math.max(hi - lo, 0.05 * scale);
  return { error: median(errors), spread, score: median(errors) / spread };
}

function subtreeOf(rig, j) {
  const out = [];
  const stack = [j];
  while (stack.length) {
    const k = stack.pop();
    out.push(k);
    for (const c of rig.joints[k].children) stack.push(c);
  }
  return out;
}

/**
 * Describe a rig. `profile` (optional) is the stored rig profile from
 * annotate_rig: { forward, chainRenames, boneChains, contacts, limits, notes }.
 */
export function describeRig(rig, profile = null) {
  const worlds = restJointWorlds(rig);
  const P = worlds.map(m => { const v = new THREE.Vector3().setFromMatrixPosition(m); return [v.x, v.y, v.z]; });
  const n = rig.joints.length;
  const bounds = meshBounds(rig) || { min: [-1, -1, -1], max: [1, 1, 1] };
  const extent = sub(bounds.max, bounds.min);
  const scale = len(extent) || 1;
  const groundY = bounds.min[1];
  const weighted = weightedJointCounts(rig);
  const notes = [];

  // Segment lengths (joint -> parent joint).
  const segLen = rig.joints.map(j => (j.parent >= 0 ? len(sub(P[j.index], P[j.parent])) : 0));
  const subtreeLength = new Float64Array(n);
  const order = [];
  (function visit() {
    const stack = rig.jointRoots.slice();
    while (stack.length) { const k = stack.pop(); order.push(k); for (const c of rig.joints[k].children) stack.push(c); }
  })();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const k = order[i];
    for (const c of rig.joints[k].children) subtreeLength[k] += subtreeLength[c] + segLen[c];
  }

  // Only joints that matter for shape: weighted ones, or ancestors of weighted
  // ones. A driver rig hanging off a second root (DRV_*) must not vote.
  const relevant = new Uint8Array(n);
  for (let j = 0; j < n; j += 1) {
    if (weighted[j] > 0) { let c = j; while (c >= 0 && !relevant[c]) { relevant[c] = 1; c = rig.joints[c].parent; } }
  }
  const voters = P.filter((_, j) => relevant[j]);
  const votePoints = voters.length >= 3 ? voters : P;

  // ---- frame: up, lateral, forward -------------------------------------
  const up = [0, 1, 0];
  const centreX = (bounds.min[0] + bounds.max[0]) / 2;
  const centreZ = (bounds.min[2] + bounds.max[2]) / 2;
  const mx = mirrorScore(votePoints, 0, centreX, scale);
  const mz = mirrorScore(votePoints, 2, centreZ, scale);
  let lateralAxis = mx.score <= mz.score ? 0 : 2;
  const lateralConfidence = Math.min(1, Math.abs(mx.score - mz.score) / Math.max(1e-6, Math.max(mx.score, mz.score)));
  const lateralCentre = lateralAxis === 0 ? centreX : centreZ;
  const forwardAxis = lateralAxis === 0 ? 2 : 0;
  if (lateralAxis === 2) notes.push('The skeleton mirrors across Z, so the model faces along X - it was probably exported turned 90 degrees. glTF characters normally face +Z.');

  // ---- side and mirror partners ----------------------------------------
  const lateralOf = p => p[lateralAxis] - lateralCentre;
  const midTol = Math.max(0.02 * scale, 0.04 * Math.max(extent[lateralAxis], 1e-6));
  const subtreeCentroidLat = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    const sub2 = subtreeOf(rig, j);
    let s = 0;
    for (const k of sub2) s += lateralOf(P[k]);
    subtreeCentroidLat[j] = s / sub2.length;
  }
  let mirrorOf = null;
  const sideSign = j => {
    if (mirrorOf && mirrorOf[j] >= 0) return Math.sign(lateralOf(P[j]));
    const lat = Math.abs(lateralOf(P[j])) > midTol ? lateralOf(P[j]) : subtreeCentroidLat[j];
    return Math.abs(lat) <= midTol ? 0 : Math.sign(lat);
  };

  // A joint is PAIRED when its mirror image lands on another joint much closer
  // than on itself. This is independent of any mid-line tolerance, which is
  // what keeps a bird's or a person's legs (close together, but each other's
  // mirror) out of the trunk.
  mirrorOf = new Int32Array(n).fill(-1);
  const pairTol = 0.06 * scale;
  for (let j = 0; j < n; j += 1) {
    const lat = lateralOf(P[j]);
    const selfDist = 2 * Math.abs(lat);
    if (selfDist < 1e-6 * scale) continue;
    const m = P[j].slice(); m[lateralAxis] = 2 * lateralCentre - P[j][lateralAxis];
    let best = -1, bestD = Infinity;
    for (let k = 0; k < n; k += 1) {
      if (k === j || Math.sign(lateralOf(P[k])) !== -Math.sign(lat)) continue;
      const d = len(sub(m, P[k]));
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best >= 0 && bestD < pairTol && bestD < 0.5 * selfDist) mirrorOf[j] = best;
  }
  for (let j = 0; j < n; j += 1) if (mirrorOf[j] >= 0 && mirrorOf[mirrorOf[j]] !== j) mirrorOf[j] = -1;
  const paired = j => mirrorOf[j] >= 0;
  // Paired-subtree test: a stub on the mid line whose children are paired is
  // the start of a limb, not trunk.
  const subtreePaired = new Uint8Array(n);
  for (let j = 0; j < n; j += 1) {
    const all = subtreeOf(rig, j);
    const rel = all.filter(k => relevant[k]);
    if (rel.length && rel.every(k => paired(k) || (k === j))) subtreePaired[j] = rel.some(k => paired(k)) ? 1 : 0;
  }

  // ---- trunk: the longest path through central joints ------------------
  const central = new Uint8Array(n);
  // A subtree STRADDLES the mid line when it has relevant joints well out on
  // both sides. Its centroid alone is not enough: a staff hand with five extra
  // finger bones drags a person's hips' centroid off the mid line.
  const straddles = (j) => {
    let neg = false, pos = false;
    for (const k of subtreeOf(rig, j)) {
      if (!relevant[k]) continue;
      const lat = lateralOf(P[k]);
      if (lat < -midTol) neg = true;
      if (lat > midTol) pos = true;
      if (neg && pos) return true;
    }
    return false;
  };
  for (let j = 0; j < n; j += 1) {
    central[j] = relevant[j] && !paired(j) && !subtreePaired[j] && Math.abs(lateralOf(P[j])) <= midTol * 1.5
      && (straddles(j) || Math.abs(subtreeCentroidLat[j]) <= midTol * 1.5) ? 1 : 0;
  }
  // Root joints are central by definition if nothing else is.
  if (!central.some(Boolean)) for (const r of rig.jointRoots) central[r] = 1;

  // Longest weighted path in the forest induced on central joints.
  const adj = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j += 1) {
    const p = rig.joints[j].parent;
    if (p >= 0 && central[j] && central[p]) { adj[j].push(p); adj[p].push(j); }
  }
  // Peel unweighted leaves (a root bone at the origin, an end marker): the
  // trunk must run between bones that move the mesh, or a root sitting a metre
  // below a horse's hips out-reaches its tail and steals the tail end.
  {
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < n; j += 1) {
        if (!central[j] || weighted[j] > 0 || adj[j].length > 1) continue;
        if (adj[j].length === 1) {
          const o = adj[j][0];
          adj[o] = adj[o].filter(k => k !== j);
          adj[j] = [];
          central[j] = 0;
          changed = true;
        }
      }
    }
  }
  const farthest = (start) => {
    const dist = new Float64Array(n).fill(-1);
    const prev = new Int32Array(n).fill(-1);
    dist[start] = 0;
    const stack = [start];
    let best = start;
    while (stack.length) {
      const k = stack.pop();
      if (dist[k] > dist[best]) best = k;
      for (const m of adj[k]) {
        if (dist[m] >= 0) continue;
        dist[m] = dist[k] + len(sub(P[k], P[m]));
        prev[m] = k;
        stack.push(m);
      }
    }
    return { best, dist, prev };
  };
  let trunk = [];
  {
    // Start from the central joint with the biggest weighted subtree (the
    // body, not a driver root), take the tree diameter.
    let seed = -1;
    for (let j = 0; j < n; j += 1) if (central[j] && (seed < 0 || subtreeLength[j] > subtreeLength[seed])) seed = j;
    if (seed >= 0) {
      const a = farthest(seed).best;
      const { best: b, prev } = farthest(a);
      for (let k = b; k >= 0; k = prev[k]) { trunk.push(k); if (k === a) break; }
    }
  }
  if (trunk.length === 0 && n) trunk = [rig.jointRoots[0]];

  // Branches hanging off the trunk.
  const inTrunk = new Uint8Array(n);
  for (const k of trunk) inTrunk[k] = 1;
  const trunkCum = [0];
  for (let i = 1; i < trunk.length; i += 1) trunkCum.push(trunkCum[i - 1] + len(sub(P[trunk[i]], P[trunk[i - 1]])));
  const trunkLength = trunkCum[trunkCum.length - 1] || 0;

  // A branch that forks right away into several comparable limbs (a spider's
  // leg anchor, a nested hip stub) is several branches: look THROUGH the stub.
  const explode = (root) => {
    let k = root;
    let walked = 0;
    while (rig.joints[k].children.length === 1) {
      const c = rig.joints[k].children[0];
      walked += segLen[c];
      k = c;
    }
    const kids = rig.joints[k].children.filter(c => relevantSubtree(c));
    if (kids.length < 2) return [root];
    const sizes = kids.map(c => subtreeLength[c] + segLen[c]);
    const big = Math.max(...sizes);
    const comparable = kids.filter((c, i) => sizes[i] >= 0.5 * big);
    if (comparable.length < 2 || walked > 0.35 * big) return [root];
    const rest = kids.filter(c => !comparable.includes(c));
    return [...comparable.flatMap(explode), ...rest];
  };
  const branchRoots = [];
  trunk.forEach((k, i) => {
    for (const c of rig.joints[k].children) {
      if (inTrunk[c] || !relevantSubtree(c)) continue;
      for (const r of explode(c)) branchRoots.push({ root: r, attach: k, at: i });
    }
  });
  function relevantSubtree(c) { return subtreeOf(rig, c).some(k => relevant[k]); }

  // ---- orientation of the trunk ----------------------------------------
  // Upright when most of the trunk's LENGTH runs vertically. Not the end-to-end
  // vector: a horse's raised neck tilts that past 45 degrees.
  let vertical = 0, total = 0;
  for (let i = 1; i < trunk.length; i += 1) {
    const d = sub(P[trunk[i]], P[trunk[i - 1]]);
    vertical += Math.abs(d[1]); total += len(d);
  }
  const trunkVertical = trunk.length > 1 && total > 0 && vertical / total > 0.75;

  // Where along the trunk do branches attach (0..1 from trunk[0])?
  let headAtEnd = true;
  let headReason = '';
  if (trunkVertical) {
    headAtEnd = P[trunk[trunk.length - 1]][1] >= P[trunk[0]][1];
    headReason = 'upright body: the head is the top of the spine';
  } else if (trunk.length > 1 && branchRoots.length) {
    const ats = branchRoots.map(b => (trunkLength ? trunkCum[b.at] / trunkLength : 0.5));
    const mean = ats.reduce((s, v) => s + v, 0) / ats.length;
    if (Math.abs(mean - 0.5) > 0.04) {
      headAtEnd = mean > 0.5;
      headReason = 'side branches (limbs, ears, jaw) crowd toward the head end';
    } else {
      headReason = 'ambiguous - defaulted to the glTF convention (facing +Z)';
      headAtEnd = P[trunk[trunk.length - 1]][forwardAxis] >= P[trunk[0]][forwardAxis];
    }
  }
  if (!headAtEnd) {
    trunk.reverse();
    trunkCum.length = 0; trunkCum.push(0);
    for (let i = 1; i < trunk.length; i += 1) trunkCum.push(trunkCum[i - 1] + len(sub(P[trunk[i]], P[trunk[i - 1]])));
    for (const b of branchRoots) b.at = trunk.indexOf(b.attach);
  }
  // trunk[0] = tail end / bottom, trunk[last] = head end.

  // ---- forward sign ----------------------------------------------------
  let forward = AXES[forwardAxis === 2 ? 'z' : 'x'].slice();
  let forwardReason = '';
  if (!trunkVertical && trunk.length > 1) {
    const d = P[trunk[trunk.length - 1]][forwardAxis] - P[trunk[0]][forwardAxis];
    if (Math.abs(d) > 1e-6) { if (d < 0) forward = forward.map(v => -v); forwardReason = 'from tail end toward head end'; }
  }
  if (!forwardReason) {
    // Upright: feet/toes point forward; else the knee bends forward.
    let votes = 0;
    for (const b of branchRoots) {
      const chain = mainChain(b.root);
      if (chain.length < 2) continue;
      const tip = P[chain[chain.length - 1]];
      const base = P[b.attach];
      if (base[1] - tip[1] < 0.3 * extent[1]) continue; // not a leg
      const last = sub(tip, P[chain[chain.length - 2]]);
      if (Math.abs(last[forwardAxis]) > Math.abs(last[1])) votes += Math.sign(last[forwardAxis]);
      else if (chain.length >= 3) {
        const knee = P[chain[Math.floor(chain.length / 2)]];
        const mid = (base[forwardAxis] + tip[forwardAxis]) / 2;
        votes += 0.5 * Math.sign(knee[forwardAxis] - mid);
      }
    }
    if (votes < 0) forward = forward.map(v => -v);
    forwardReason = votes !== 0 ? 'from the direction the feet / knees point' : 'no cue - defaulted to the glTF convention';
  }

  // Profile override wins.
  const profileForward = parseAxis(profile?.forward);
  if (profileForward && Math.abs(profileForward[1]) < 0.5) {
    forward = profileForward;
    forwardReason = 'set by the rig profile';
    if (Math.abs(forward[lateralAxis]) > 0.5) {
      // The user says it faces along what we took as lateral - swap.
      lateralAxis = forwardAxis;
    }
  }
  const left = cross(up, forward);

  function mainChain(root) {
    const chain = [root];
    let k = root;
    while (rig.joints[k].children.length) {
      let best = -1;
      for (const c of rig.joints[k].children) if (best < 0 || subtreeLength[c] + segLen[c] > subtreeLength[best] + segLen[best]) best = c;
      chain.push(best);
      k = best;
    }
    return chain;
  }

  // ---- classify branches -------------------------------------------------
  const bodyHeight = extent[1];
  const bodyLength = Math.abs(dot(extent, forward.map(Math.abs)));
  const branches = branchRoots.map((b) => {
    const chain = mainChain(b.root);
    const all = subtreeOf(rig, b.root);
    const tip = P[chain[chain.length - 1]];
    const base = P[b.attach];
    const reach = len(sub(tip, base));
    const drop = base[1] - tip[1];
    const tipHeight = tip[1] - groundY;
    const side = sideSign(b.root) || sideSign(chain[Math.min(chain.length - 1, 1)]);
    return { ...b, chain, all, tip, reach, drop, tipHeight, side, along: trunkLength ? trunkCum[b.at] / trunkLength : 0 };
  });

  // Pair branches: mirror partner of the root (or of the 2nd joint, for stubs).
  branches.forEach((b, i) => {
    b.pair = -1;
    if (b.side === 0) return;
    branches.forEach((o, k) => {
      if (k === i || o.side !== -b.side || b.pair >= 0) return;
      const linked = b.chain.slice(0, 3).some(j => mirrorOf[j] >= 0 && o.chain.includes(mirrorOf[j]));
      if (linked) b.pair = k;
    });
  });
  // Fallback pairing by mirrored tip distance (limb lengths differ but tips mirror).
  branches.forEach((b, i) => {
    if (b.pair >= 0 || b.side === 0) return;
    let best = -1, bestD = Infinity;
    branches.forEach((o, k) => {
      if (k === i || o.side !== -b.side || o.pair >= 0) return;
      const m = b.tip.slice(); m[lateralAxis] = 2 * lateralCentre - b.tip[lateralAxis];
      const d = len(sub(m, o.tip));
      if (d < bestD) { bestD = d; best = k; }
    });
    if (best >= 0 && bestD < 0.15 * scale) { b.pair = best; branches[best].pair = i; }
  });

  for (const b of branches) {
    if (b.side !== 0 && b.pair >= 0) {
      // A leg reaches the ground FROM the body: its tip is near the floor and
      // it descends most of the way from where it attaches. Not "points down":
      // a spider's legs sprawl sideways and still stand on the floor.
      const attachHeight = P[b.attach][1] - groundY;
      if (b.tipHeight < 0.18 * bodyHeight && b.drop > 0.5 * attachHeight) b.kind = 'leg';
      else if (trunkVertical && b.along > 0.45 && b.along < 0.9) b.kind = 'arm';
      else if (b.reach > 0.3 * Math.max(bodyLength, bodyHeight) && b.tipHeight > 0.18 * bodyHeight && b.along > 0.25 && b.along < 0.85) b.kind = 'wing';
      else if (b.along > 0.85) b.kind = 'head_appendage';
      else b.kind = 'arm_candidate';
    } else {
      b.kind = b.along > 0.8 ? 'head_appendage' : 'appendage';
    }
  }
  // A paired "leg" that is far shorter than the other legs is a palp / fang.
  const legReaches = branches.filter(b => b.kind === 'leg').map(b => b.reach);
  const legMedian = median(legReaches);
  for (const b of branches) if (b.kind === 'leg' && b.reach < 0.5 * legMedian) b.kind = b.along > 0.6 ? 'head_appendage' : 'appendage';
  // Anything attached in the last quarter of the stretch between the front-most
  // leg/wing and the head end is on the HEAD (horns, ears, mandibles), however
  // long it is.
  const lwAts = branches.filter(b => b.kind === 'leg' || b.kind === 'wing').map(b => b.at);
  if (lwAts.length && trunk.length > 1) {
    const front = Math.max(...lwAts);
    const span = trunkCum[trunk.length - 1] - trunkCum[front];
    for (const b of branches) {
      if (b.kind !== 'arm_candidate' && b.kind !== 'appendage') continue;
      if (b.at > front && span > 0 && trunkCum[trunk.length - 1] - trunkCum[b.at] < 0.4 * span) b.kind = 'head_appendage';
    }
  }
  // Paired, off the ground, not a wing: an arm when it is a real limb (long
  // next to the legs, or the only limbs there are) and in the front half.
  for (const b of branches) {
    if (b.kind !== 'arm_candidate') continue;
    const longEnough = legMedian ? b.reach > 0.3 * legMedian : b.reach > 0.15 * scale;
    // Arms rest level or hanging; a paired branch whose tip rises well above
    // where it attaches is a horn, an ear or a crest.
    const pointsUp = b.tip[1] - P[b.attach][1] > 0.3 * b.reach;
    if (pointsUp) b.kind = b.along > 0.6 ? 'head_appendage' : 'appendage';
    else b.kind = longEnough && b.along > 0.4 ? 'arm' : 'appendage';
  }

  // ---- trunk labelling ---------------------------------------------------
  const limbAts = branches.filter(b => ['leg', 'arm', 'wing'].includes(b.kind)).map(b => b.at);
  const legAts = branches.filter(b => b.kind === 'leg' || b.kind === 'arm').map(b => b.at);
  const hipAt = legAts.length ? Math.min(...legAts) : (limbAts.length ? Math.min(...limbAts) : 0);
  const shoulderAt = limbAts.length ? Math.max(...limbAts) : hipAt;
  const last = trunk.length - 1;
  // Head: last trunk joint carrying a head appendage, else the second-to-last
  // when the final segment is a short end bone, else the last.
  let headAt = last;
  const headBranchAts = branches.filter(b => b.kind === 'head_appendage').map(b => b.at);
  if (headBranchAts.length) headAt = Math.max(Math.min(...headBranchAts), shoulderAt + 1);
  else {
    const after = last - shoulderAt;
    if (after >= 4) headAt = last - 2;
    else if (after === 3) headAt = last - 1;
  }
  headAt = Math.min(Math.max(headAt, 0), last);
  const noLimbs = limbAts.length === 0;

  const jointChain = new Array(n).fill(null);
  const chains = [];
  const addChain = (label, kind, side, bones, attach) => {
    let unique = label;
    let k = 2;
    while (chains.some(c => c.label === unique)) unique = `${label}_${k++}`;
    const chain = { label: unique, kind, side, bones, attach };
    chains.push(chain);
    for (const j of bones) if (jointChain[j] === null) jointChain[j] = unique;
    return chain;
  };

  if (trunk.length) {
    const take = (a, b) => trunk.slice(a, b);
    if (noLimbs) {
      if (headAt > 0) addChain('body', 'body', 0, take(0, headAt), -1);
      addChain('head', 'head', 0, take(headAt), headAt > 0 ? trunk[headAt - 1] : -1);
    } else {
      if (hipAt > 0) addChain(trunkVertical ? 'root' : 'tail', trunkVertical ? 'root' : 'tail', 0, take(0, hipAt).reverse(), trunk[hipAt]);
      addChain('spine', 'spine', 0, take(hipAt, Math.max(shoulderAt + 1, hipAt + 1)), hipAt > 0 ? trunk[hipAt - 1] : -1);
      if (headAt > shoulderAt + 1) addChain('neck', 'neck', 0, take(shoulderAt + 1, headAt), trunk[shoulderAt]);
      if (headAt > shoulderAt) addChain('head', 'head', 0, take(headAt), trunk[headAt - 1]);
    }
  }

  // Order limbs front to back to name them.
  const sideSuffix = s => (s === 0 ? '' : (s * Math.sign(dot(left, AXES[lateralAxis === 0 ? 'x' : 'z'])) > 0 ? '_L' : '_R'));
  const kindsInOrder = ['leg', 'arm', 'wing', 'appendage', 'head_appendage'];
  for (const kind of kindsInOrder) {
    const group = branches.filter(b => b.kind === kind);
    if (!group.length) continue;
    // Pair groups share a slot index; sort slots by position along the body
    // (head first).
    const slots = [];
    const seenB = new Set();
    for (const b of group) {
      if (seenB.has(b)) continue;
      const partner = b.pair >= 0 ? branches[b.pair] : null;
      const members = partner && partner.kind === kind ? [b, partner] : [b];
      members.forEach(m => seenB.add(m));
      const along = members.reduce((s, m) => s + m.along, 0) / members.length;
      const fwd = members.reduce((s, m) => s + dot(P[m.root], forward), 0) / members.length;
      slots.push({ members, along, fwd });
    }
    slots.sort((a, b) => (trunkVertical ? b.along - a.along : b.fwd - a.fwd));
    slots.forEach((slot, i) => {
      let base = kind;
      if (kind === 'leg') {
        if (trunkVertical) base = 'leg';
        else if (slots.length === 2) base = i === 0 ? 'leg_front' : 'leg_hind';
        else if (slots.length > 2) base = `leg_${i + 1}`;
      } else if (slots.length > 1) {
        base = `${kind}_${i + 1}`;
      }
      for (const m of slot.members) {
        const chain = addChain(`${base}${sideSuffix(m.side)}`, kind, m.side, m.chain, m.attach);
        m.label = chain.label;
        // Sub-branches of a limb: digits near the tip, extras elsewhere.
        const inMain = new Set(m.chain);
        const subRoots = m.all.filter(j => !inMain.has(j) && inMain.has(rig.joints[j].parent));
        subRoots.sort((a, b) => dot(P[b], forward) - dot(P[a], forward));
        subRoots.forEach((r, k2) => {
          const subChain = mainChain(r);
          const extra = subtreeOf(rig, r);
          const c = addChain(`${chain.label}.part_${k2 + 1}`, 'part', m.side, subChain, rig.joints[r].parent);
          for (const j of extra) if (jointChain[j] === null) jointChain[j] = c.label;
        });
      }
    });
  }

  // Anything still unlabelled: driver/helper bones and sub-branches of the trunk.
  for (let j = 0; j < n; j += 1) {
    if (jointChain[j] !== null) continue;
    let p = rig.joints[j].parent;
    while (p >= 0 && jointChain[p] === null) p = rig.joints[p].parent;
    if (p >= 0 && relevant[j]) jointChain[j] = jointChain[p];
    else jointChain[j] = relevant[j] ? 'extra' : 'helper';
  }
  for (const label of ['extra', 'helper']) {
    const bones = [];
    for (let j = 0; j < n; j += 1) if (jointChain[j] === label) bones.push(j);
    if (bones.length) chains.push({ label, kind: label, side: 0, bones, attach: -1 });
  }

  // ---- profile overrides ---------------------------------------------------
  const renames = profile?.chainRenames || {};
  for (const chain of chains) {
    const to = renames[chain.label];
    if (typeof to === 'string' && to.trim()) {
      const from = chain.label;
      chain.label = to.trim();
      for (let j = 0; j < n; j += 1) if (jointChain[j] === from) jointChain[j] = chain.label;
    }
  }
  const boneChains = profile?.boneChains || {};
  for (const [boneName, label] of Object.entries(boneChains)) {
    const j = rig.jointByName.get(boneName);
    if (j === undefined || typeof label !== 'string' || !label.trim()) continue;
    const old = chains.find(c => c.bones.includes(j));
    if (old) old.bones = old.bones.filter(b => b !== j);
    let target = chains.find(c => c.label === label.trim());
    if (!target) { target = { label: label.trim(), kind: 'custom', side: sideSign(j), bones: [], attach: rig.joints[j].parent }; chains.push(target); }
    target.bones.push(j);
    target.bones.sort((a, b) => depthOf(a) - depthOf(b));
    jointChain[j] = target.label;
  }
  function depthOf(j) { let d = 0; for (let p = rig.joints[j].parent; p >= 0; p = rig.joints[p].parent) d += 1; return d; }
  for (let i = chains.length - 1; i >= 0; i -= 1) if (!chains[i].bones.length) chains.splice(i, 1);

  // ---- assemble ------------------------------------------------------------
  const toBody = p => {
    const rel = [p[0] - (lateralAxis === 0 ? lateralCentre : centreX), p[1] - groundY, p[2] - (lateralAxis === 2 ? lateralCentre : centreZ)];
    return [round(dot(rel, forward)), round(dot(rel, up)), round(dot(rel, left))];
  };
  const contacts = new Set(Array.isArray(profile?.contacts) ? profile.contacts : []);
  if (!contacts.size) for (const c of chains) if (c.kind === 'leg') contacts.add(c.label);

  const chainOut = chains.map((c) => {
    const tip = c.bones[c.bones.length - 1];
    const first = c.bones[0];
    const partner = c.side !== 0 ? chains.find(o => o !== c && o.kind === c.kind && o.side === -c.side
      && o.label.replace(/_[LR](\.|$)/, '$1') === c.label.replace(/_[LR](\.|$)/, '$1')) : null;
    return {
      label: c.label,
      kind: c.kind,
      side: c.side === 0 ? 'mid' : (c.label.match(/_([LR])(\.|$)/)?.[1] === 'L' ? 'left' : 'right'),
      bones: c.bones.map(j => rig.joints[j].name),
      // What the chain hangs from = the parent of its first bone (a trunk
      // segment's neighbour in the path is not necessarily its parent).
      attach: c.bones.length && rig.joints[c.bones[0]].parent >= 0 ? rig.joints[rig.joints[c.bones[0]].parent].name : null,
      mirror: partner ? partner.label : null,
      contact: contacts.has(c.label),
      length: round(c.bones.reduce((s, j) => s + segLen[j], 0) + (c.bones.length ? 0 : 0)),
      tip: toBody(P[tip]),
      base: toBody(P[first])
    };
  });

  const bones = rig.joints.map(j => ({
    name: j.name,
    parent: j.parent >= 0 ? rig.joints[j.parent].name : null,
    chain: jointChain[j.index],
    mirror: mirrorOf[j.index] >= 0 ? rig.joints[mirrorOf[j.index]].name : null,
    weightedVertices: weighted[j.index],
    position: toBody(P[j.index]),
    length: round(segLen[j.index])
  }));

  const kinds = chainOut.reduce((acc, c) => { acc[c.kind] = (acc[c.kind] || 0) + 1; return acc; }, {});
  const legCount = kinds.leg || 0;
  let bodyPlan = 'unknown';
  if (trunkVertical && (kinds.arm || 0) >= 2 && legCount === 2) bodyPlan = 'biped (humanoid-like)';
  else if (trunkVertical && legCount === 2) bodyPlan = 'biped';
  else if (!trunkVertical && legCount === 4) bodyPlan = (kinds.wing ? 'winged quadruped' : 'quadruped');
  else if (!trunkVertical && legCount === 2) bodyPlan = (kinds.wing ? 'winged biped (bird-like)' : 'horizontal biped');
  else if (legCount >= 6) bodyPlan = `${legCount}-legged`;
  else if (legCount === 0 && noLimbs) bodyPlan = 'limbless (serpentine / fish-like)';
  else if (legCount) bodyPlan = `${legCount}-legged`;

  return {
    bodyPlan,
    frame: {
      up: '+y',
      forward: axisName(forward),
      left: axisName(left),
      forwardReason,
      headReason,
      lateralConfidence: round(lateralConfidence, 2),
      vectors: { forward, up, left }
    },
    size: {
      height: round(bodyHeight),
      length: round(Math.abs(dot(extent, forward.map(Math.abs)))),
      width: round(Math.abs(dot(extent, left.map(Math.abs)))),
      groundY: round(groundY, 4),
      units: 'model units (metres for glTF)'
    },
    origin: [
      round(lateralAxis === 0 ? lateralCentre : centreX, 4),
      round(groundY, 4),
      round(lateralAxis === 2 ? lateralCentre : centreZ, 4)
    ],
    chains: chainOut,
    bones,
    jointChain,
    notes,
    profileApplied: Boolean(profile && Object.keys(profile).length)
  };
}

/** Per-vertex RGB (0..1) colouring each vertex by its dominant bone's chain. */
export function chainColours(rig, description, palette) {
  const labels = description.chains.map(c => c.label);
  const colourOf = new Map(labels.map((l, i) => [l, palette[i % palette.length]]));
  const jointColour = description.jointChain.map(label => colourOf.get(label) || [0.6, 0.6, 0.6]);
  const { joints, weights, vertexCount } = rig.geometry;
  const out = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v += 1) {
    let best = -1, bestW = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k];
      if (w > bestW) { bestW = w; best = joints[v * 4 + k]; }
    }
    const c = best >= 0 ? jointColour[best] : [0.35, 0.35, 0.35];
    out[v * 3] = c[0]; out[v * 3 + 1] = c[1]; out[v * 3 + 2] = c[2];
  }
  return { colours: out, legend: labels.map(l => ({ label: l, colour: colourOf.get(l) })) };
}
