// Rig ANY mesh from its shape: the curve skeleton says where the tubes are,
// the AI (or the defaults) says what each tube is, and rules place the joints.
//
// Why this exists. Auto Rig (SkinTokens) is a learned model: it rigs what it
// was trained on and guesses at the rest - a crab, an octopus, a six-armed
// golem come back with legs inside the body or no tail. rig_rigid_parts covers
// robots only. An LLM can recognise ANY creature from a picture but cannot
// place a joint in 3D with any precision. So the work splits along that line:
//
//   1. MEASURE (python /meshes/shape-skeleton): the medial axis of the solid,
//      as a graph of tubes with their radii. Exact, creature-agnostic.
//   2. NAME: a dense provisional skeleton laid along every major tube is read
//      by describeRig - the same perception the animation tools use - which
//      labels each tube (spine, neck, leg_front_L, tail...). The AI corrects
//      any label in one call by branch number.
//   3. PLACE: each labelled chain gets joints by rule - anatomical proportions
//      for humanoid limbs (so Mixamo names and retargeting work), body-exit
//      detection and bend snapping for any other limb, length/thickness for
//      tails and tentacles.
//   4. BIND: rebuildWeights (visibility + side rule + smoothing), with the
//      chain labels written into the rig profile so every later tool reads the
//      creature exactly as it was built.
//
// Terms: a BRANCH is one tube between two junctions/tips of the curve skeleton
// (numbered for the AI); a DETAIL is a short protrusion (a spike, a fold, a
// finger stub) kept out of the provisional skeleton so it does not confuse the
// labelling, but still listed so it can be rigged on request; a CHAIN is a
// labelled run of joints in the final rig.
import { Buffer } from 'node:buffer';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { nodeWorldMatrices, readAccessor } from '../meshRigTransfer.js';
import { describeRig } from './analyze.js';
import { loadRig } from './gltfRig.js';
import { namingScheme, rebuildWeights, renameBones } from './rigEdit.js';
import { readStaticMesh, soupGlb } from './rigid.js';
import { PALETTE, composeGrid, renderTile, viewBasis, viewExtent } from './render.js';

const FLOAT = 5126;
const USHORT = 5123;

// ---- small vector helpers (plain arrays) -------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function cumulative(points) {
  const arcs = new Float64Array(points.length);
  for (let i = 1; i < points.length; i += 1) arcs[i] = arcs[i - 1] + dist(points[i], points[i - 1]);
  return arcs;
}

function locate(arcs, a) {
  const n = arcs.length;
  if (n < 2 || a <= 0) return [0, 0];
  if (a >= arcs[n - 1]) return [n - 2, 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arcs[mid] <= a) lo = mid; else hi = mid; }
  const span = arcs[hi] - arcs[lo];
  return [lo, span > 0 ? (a - arcs[lo]) / span : 0];
}

function pointAt(points, arcs, a) {
  if (points.length === 1) return points[0].slice();
  const [i, t] = locate(arcs, a);
  return lerp(points[i], points[i + 1], t);
}

function valueAt(values, arcs, a) {
  if (values.length === 1) return values[0];
  const [i, t] = locate(arcs, a);
  return values[i] + (values[i + 1] - values[i]) * t;
}

/** Turning angle (degrees) at each polyline vertex, measured over +-window of arc. */
function turningAngles(points, arcs, window) {
  const out = new Float64Array(points.length);
  for (let k = 1; k < points.length - 1; k += 1) {
    let i = k - 1;
    while (i > 0 && arcs[k] - arcs[i] < window) i -= 1;
    let j = k + 1;
    while (j < points.length - 1 && arcs[j] - arcs[k] < window) j += 1;
    const u = sub(points[k], points[i]);
    const v = sub(points[j], points[k]);
    const lu = len(u), lv = len(v);
    if (lu < 1e-12 || lv < 1e-12) continue;
    out[k] = (Math.acos(clamp(dot(u, v) / (lu * lv), -1, 1)) * 180) / Math.PI;
  }
  return out;
}

// ---- 1. the graph: cut cycles, keep the body, set details aside -----------------------

/**
 * Turn the service payload into a working tree.
 * Returns { nodes: Map, segs: Map, details: [], detached: [], cut: [], size, pitch }.
 *  - Cycles are cut where the loop is weakest (short and thin: an arm resting
 *    on a hip is a thin contact bridge, the torso it closes on is not).
 *  - The biggest component is the body; other components are DETACHED pieces
 *    (a floating sword, eyes that do not touch the head) - weighted to the
 *    nearest bone, never given bones of their own here.
 *  - Short terminal protrusions become DETAILS.
 */
export function prepareShape(payload, { detailRatio = 0.03, body = 'auto' } = {}) {
  const size = Number(payload.size) || 1;
  const nodesIn = payload.nodes || [];
  const edgesIn = (payload.edges || []).filter(e => e.a !== e.b && e.points?.length >= 2);
  const meanR = e => e.radii.reduce((s, r) => s + r, 0) / Math.max(1, e.radii.length);

  // Maximum spanning forest by length x radius.
  const parent = nodesIn.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const sorted = edgesIn.slice().sort((x, y) => y.length * meanR(y) - x.length * meanR(x));
  const kept = [];
  const cut = [];
  for (const e of sorted) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) { cut.push(e); continue; }
    parent[rb] = ra;
    kept.push(e);
  }
  // Components; the body is the one with the most tube volume.
  const comps = new Map();
  for (const e of kept) {
    const r = find(e.a);
    if (!comps.has(r)) comps.set(r, { edges: [], volume: 0 });
    const c = comps.get(r);
    c.edges.push(e);
    c.volume += e.length * meanR(e) ** 2;
  }
  let main = null;
  for (const c of comps.values()) if (!main || c.volume > main.volume) main = c;
  const detached = [...comps.values()].filter(c => c !== main).map((c) => {
    const pts = c.edges.flatMap(e => e.points);
    const centre = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    return { centre: centre.map(v => round(v)), length: round(c.edges.reduce((s, e) => s + e.length, 0)) };
  });

  const nodes = new Map();
  const segs = new Map();
  let nextSeg = 0;
  const addNode = (id, p, r) => { if (!nodes.has(id)) nodes.set(id, { p: p.slice(), r, segs: new Set() }); return nodes.get(id); };
  // `sw` = sheetness x length, so merged segments keep a length-weighted mean.
  const addSeg = (a, b, points, radii, sw = 0) => {
    const id = nextSeg++;
    segs.set(id, { a, b, points, radii, sw });
    nodes.get(a).segs.add(id);
    nodes.get(b).segs.add(id);
    return id;
  };
  const removeSeg = (id) => {
    const s = segs.get(id);
    segs.delete(id);
    nodes.get(s.a)?.segs.delete(id);
    nodes.get(s.b)?.segs.delete(id);
  };
  if (main) {
    for (const e of main.edges) {
      addNode(e.a, nodesIn[e.a].p, nodesIn[e.a].r);
      addNode(e.b, nodesIn[e.b].p, nodesIn[e.b].r);
      addSeg(e.a, e.b, e.points.map(p => p.slice()), e.radii.slice(), (e.sheet ?? 1) * e.length);
    }
  } else if (nodesIn.length) {
    // No edge at all (a blob): one node.
    addNode(nodesIn[0].id, nodesIn[0].p, nodesIn[0].r);
  }

  const core = contractCore(nodes, segs, { mode: body, newSegId: () => nextSeg++ });

  const mergePassThrough = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [nid, node] of nodes) {
        if (node.segs.size !== 2) continue;
        const [s1, s2] = [...node.segs].map(id => [id, segs.get(id)]);
        const p1 = s1[1].b === nid ? s1[1] : { a: s1[1].b, b: s1[1].a, points: s1[1].points.slice().reverse(), radii: s1[1].radii.slice().reverse() };
        const p2 = s2[1].a === nid ? s2[1] : { a: s2[1].b, b: s2[1].a, points: s2[1].points.slice().reverse(), radii: s2[1].radii.slice().reverse() };
        if (p1.a === p2.b) continue; // would close a loop
        removeSeg(s1[0]);
        removeSeg(s2[0]);
        nodes.delete(nid);
        addSeg(p1.a, p2.b, [...p1.points, ...p2.points.slice(1)], [...p1.radii, ...p2.radii.slice(1)], (s1[1].sw || 0) + (s2[1].sw || 0));
        changed = true;
        break;
      }
    }
  };
  mergePassThrough();

  // Details: short protrusions. Shortest first, re-merging as junctions dissolve.
  const details = [];
  const segLength = s => cumulative(s.points).at(-1);
  let changed = true;
  while (changed) {
    changed = false;
    const terminals = [];
    for (const [id, s] of segs) {
      const da = nodes.get(s.a).segs.size, db = nodes.get(s.b).segs.size;
      if (da === 1 && db >= 3) terminals.push({ id, tip: s.a, junction: s.b });
      else if (db === 1 && da >= 3) terminals.push({ id, tip: s.b, junction: s.a });
    }
    terminals.sort((x, y) => segLength(segs.get(x.id)) - segLength(segs.get(y.id)));
    for (const t of terminals) {
      const s = segs.get(t.id);
      if (!s || nodes.get(t.junction).segs.size < 3) continue;
      const L = segLength(s);
      const tipR = t.tip === s.a ? s.radii[0] : s.radii.at(-1);
      // A detail barely clears the body it grows from. Measured against the
      // body's radius at the junction, not the overall size: a dragon's short
      // legs are tiny next to its wingspan but stick well out of its belly.
      const rJ = nodes.get(t.junction).r;
      const protrusion = L + tipR - rJ;
      if (protrusion >= Math.max(detailRatio * size, 1.2 * rJ)) continue;
      const fromJunction = t.junction === s.a ? s : { points: s.points.slice().reverse(), radii: s.radii.slice().reverse() };
      details.push({ points: fromJunction.points, radii: fromJunction.radii, length: L });
      removeSeg(t.id);
      nodes.delete(t.tip);
      changed = true;
      break;
    }
    if (changed) mergePassThrough();
  }

  return { nodes, segs, details, detached, core, cut: cut.map(e => ({ length: round(e.length) })), size, pitch: Number(payload.pitch) || size / 160 };
}

/** Eigenvalues of a symmetric 3x3 matrix (Jacobi), descending. */
function symmetricEigenvalues(m) {
  const a = [m[0].slice(), m[1].slice(), m[2].slice()];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) off += a[i][j] * a[i][j];
    if (off < 1e-20) break;
    for (let p = 0; p < 2; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk;
        }
      }
    }
  }
  return [a[0][0], a[1][1], a[2][2]].sort((x, y) => y - x);
}

/**
 * Collapse a wide, flat BODY CORE into one node. The medial axis of a crab's
 * carapace, a beetle's shell or a turtle is a SURFACE, which thinning turns
 * into a web of loops and junctions with no anatomy in it - dozens of numbers
 * for the AI to wade through, and nonsense for chain perception. Such a body
 * moves as one piece anyway, so it becomes one node and every limb leaving it
 * hangs from that node.
 *
 * The core = the skeleton points at least half as thick as the thickest
 * point, connected to it. It is collapsed when (mode "auto") it holds at least
 * three junctions AND is not elongated (main axis < 1.6x the second): a
 * horse's or a person's torso is long, so its spine survives. mode "core"
 * always collapses, "spine" never does. Edits nodes/segs in place; returns a
 * summary or null.
 */
function contractCore(nodes, segs, { mode = 'auto', newSegId }) {
  if (mode === 'spine' || segs.size < 2) return null;
  let rMax = 0;
  for (const s of segs.values()) for (const r of s.radii) rMax = Math.max(rMax, r);
  for (const n of nodes.values()) rMax = Math.max(rMax, n.r);
  const rc = 0.5 * rMax;
  // Flood the thick region along the polylines, starting from the thickest point.
  const inside = new Map(); // seg id -> Uint8Array mask
  for (const [sid, s] of segs) inside.set(sid, new Uint8Array(s.points.length));
  let start = null;
  for (const [sid, s] of segs) s.radii.forEach((r, k) => { if (!start || r > start.r) start = { sid, k, r }; });
  const nodeIn = new Set();
  const stack = [[start.sid, start.k]];
  while (stack.length) {
    const [sid, k] = stack.pop();
    const s = segs.get(sid);
    const mask = inside.get(sid);
    if (mask[k] || s.radii[k] < rc) continue;
    mask[k] = 1;
    if (k > 0) stack.push([sid, k - 1]);
    if (k < s.points.length - 1) stack.push([sid, k + 1]);
    const end = k === 0 ? s.a : (k === s.points.length - 1 ? s.b : null);
    if (end !== null && !nodeIn.has(end)) {
      nodeIn.add(end);
      for (const other of nodes.get(end).segs) {
        const o = segs.get(other);
        stack.push([other, o.a === end ? 0 : o.points.length - 1]);
      }
    }
  }
  const pts = [];
  for (const [sid, s] of segs) inside.get(sid).forEach((v, k) => { if (v) pts.push(s.points[k]); });
  const junctions = [...nodeIn].filter(n => nodes.get(n).segs.size >= 3).length;
  if (pts.length < 4) return null;
  const centre = [0, 1, 2].map(c => pts.reduce((acc, p) => acc + p[c], 0) / pts.length);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i][j] += (p[i] - centre[i]) * (p[j] - centre[j]) / pts.length;
  const [l1, l2] = symmetricEigenvalues(cov);
  const elongation = Math.sqrt(Math.max(l1, 1e-18) / Math.max(l2, 1e-18));
  const summary = { junctions, elongation: round(elongation, 2), collapsed: false };
  if (mode === 'auto' && !(junctions >= 3 && elongation < 1.6)) return summary;

  // Collapse: one node at the centre; every run of outside points that touches
  // the core becomes a segment hanging from it (connector + the run).
  const C = '__core';
  nodes.set(C, { p: centre, r: rMax, segs: new Set() });
  const fresh = [];
  for (const [sid, s] of [...segs]) {
    const mask = inside.get(sid);
    if (!mask.some(Boolean)) continue;
    segs.delete(sid);
    nodes.get(s.a)?.segs.delete(sid);
    nodes.get(s.b)?.segs.delete(sid);
    const n = s.points.length;
    let i = 0;
    while (i < n) {
      if (mask[i]) { i += 1; continue; }
      let j = i;
      while (j + 1 < n && !mask[j + 1]) j += 1;
      const run = { points: s.points.slice(i, j + 1), radii: s.radii.slice(i, j + 1) };
      const sw = (s.sw || 0) * (run.points.length / n);
      if (i > 0 && j < n - 1) {
        // Leaves the core and comes back: a strand of the web (a thin rim
        // between two thick plates), not a limb.
      } else if (i > 0) {
        // Leaves the core at i-1 and ends at node b: a limb hanging from it.
        fresh.push({ a: C, b: s.b, points: [centre, s.points[i - 1], ...run.points], radii: [rMax, s.radii[i - 1], ...run.radii], sw });
      } else if (j < n - 1) {
        // Starts at node a outside and enters the core at j+1.
        fresh.push({ a: s.a, b: C, points: [...run.points, s.points[j + 1], centre], radii: [...run.radii, s.radii[j + 1], rMax], sw });
      }
      i = j + 1;
    }
  }
  for (const nid of nodeIn) if (nid !== C && !nodes.get(nid)?.segs.size) nodes.delete(nid);
  for (const f of fresh) {
    if (!nodes.has(f.a) || !nodes.has(f.b)) continue;
    // Two links between the core and one outside node would close a loop.
    if ([...nodes.get(f.a === C ? f.b : f.a).segs].some(id => { const o = segs.get(id); return (o.a === C || o.b === C); })) continue;
    const id = newSegId();
    segs.set(id, f);
    nodes.get(f.a).segs.add(id);
    nodes.get(f.b).segs.add(id);
  }
  for (const [nid, n] of [...nodes]) if (!n.segs.size && nodes.size > 1) nodes.delete(nid);
  summary.collapsed = true;
  summary.centre = centre.map(v => round(v));
  return summary;
}

/**
 * Number the branches for the AI: major branches longest first (1..M), then
 * details (M+1..). Deterministic for a given payload, so a number seen in
 * analyze_shape means the same tube in build_rig.
 */
export function numberBranches(shape) {
  const majors = [...shape.segs.entries()].map(([sid, s]) => ({ sid, s, L: cumulative(s.points).at(-1) }));
  majors.sort((x, y) => y.L - x.L || x.s.points[0][0] - y.s.points[0][0]);
  const branches = [];
  majors.forEach((m, i) => {
    m.s.branch = i + 1;
    // A TIP branch ends in a leaf: a limb, a tail, a horn. Those are what the
    // AI names; internal branches are the connective body between them.
    const leafA = shape.nodes.get(m.s.a)?.segs.size === 1;
    const leafB = shape.nodes.get(m.s.b)?.segs.size === 1;
    branches.push({ id: i + 1, major: true, sid: m.sid, length: m.L, terminal: leafA || leafB, tipAtStart: leafA && !leafB });
  });
  const details = shape.details.slice().sort((x, y) => y.length - x.length || x.points[0][0] - y.points[0][0]);
  details.forEach((d, i) => {
    d.branch = majors.length + i + 1;
    branches.push({ id: d.branch, major: false, detail: d, length: d.length, terminal: true, tipAtStart: false });
  });
  shape.details = details;
  shape.branches = branches;
  stampBranchArcs(shape);
  return branches;
}

/** Make the details with the given branch ids part of the major tree (they were labelled). */
export function promoteDetails(shape, ids) {
  const want = new Set(ids.map(Number));
  if (!want.size) return;
  let nextNode = Math.max(-1, ...shape.nodes.keys()) + 1;
  let nextSeg = Math.max(-1, ...shape.segs.keys()) + 1;
  for (const d of shape.details) {
    if (!want.has(d.branch)) continue;
    // Attach at the nearest point of the major tree, splitting that segment.
    let best = null;
    for (const [sid, s] of shape.segs) {
      for (let k = 0; k < s.points.length; k += 1) {
        const dd = dist(s.points[k], d.points[0]);
        if (!best || dd < best.d) best = { sid, k, d: dd };
      }
    }
    if (!best) continue;
    const s = shape.segs.get(best.sid);
    let attach;
    if (best.k === 0) attach = s.a;
    else if (best.k === s.points.length - 1) attach = s.b;
    else {
      attach = nextNode++;
      shape.nodes.set(attach, { p: s.points[best.k].slice(), r: s.radii[best.k], segs: new Set() });
      const first = { a: s.a, b: attach, points: s.points.slice(0, best.k + 1), radii: s.radii.slice(0, best.k + 1), branch: s.branch, barc: s.barc ? s.barc.slice(0, best.k + 1) : undefined };
      const second = { a: attach, b: s.b, points: s.points.slice(best.k), radii: s.radii.slice(best.k), branch: s.branch, barc: s.barc ? s.barc.slice(best.k) : undefined };
      shape.nodes.get(s.a).segs.delete(best.sid);
      shape.nodes.get(s.b).segs.delete(best.sid);
      shape.segs.delete(best.sid);
      for (const piece of [first, second]) {
        const id = nextSeg++;
        shape.segs.set(id, piece);
        shape.nodes.get(piece.a).segs.add(id);
        shape.nodes.get(piece.b).segs.add(id);
      }
    }
    const tip = nextNode++;
    shape.nodes.set(tip, { p: d.points.at(-1).slice(), r: d.radii.at(-1), segs: new Set() });
    const points = [shape.nodes.get(attach).p.slice(), ...d.points.slice(1)];
    const id = nextSeg++;
    shape.segs.set(id, { a: attach, b: tip, points, radii: d.radii.slice(), branch: d.branch });
    shape.nodes.get(attach).segs.add(id);
    shape.nodes.get(tip).segs.add(id);
    d.promoted = true;
  }
}

/**
 * Keep the anatomy, drop the noise. A generated character's skeleton carries
 * webs that are not anatomy - the medial curves of a robe, a cape, fur clumps,
 * a flat carapace. Rigging needs the LIMBS (the far-reaching tips) and the
 * body that joins them, so: pick the key tips, keep the union of their paths
 * to the body core (the thickest point), drop every other segment.
 *  - `keep`: branch ids that must be rigged (the caller labelled them).
 *  - `drop`: branch ids never chosen automatically ("ignore").
 *  - `only`: rig ONLY the `keep` branches (plus the body joining them).
 * Automatic choice: every tip that is not cloth (a thin tube sitting in a
 * sheet of solid) and reaches at least 12% as far from the core as the
 * farthest tip; then every segment only cloth led to is dropped.
 * Dropped segments move to shape.ignoredSegs so they can still be drawn and
 * numbered. Returns { kept: [ids], ignored: [ids] }.
 */
export function selectAnatomy(shape, { keep = [], drop = [], only = false } = {}) {
  const { nodes, segs } = shape;
  shape.ignoredSegs = shape.ignoredSegs || new Map();
  if (segs.size <= 1) return { kept: [...new Set([...segs.values()].map(s => s.branch))], ignored: [] };
  let core = null;
  for (const [nid, n] of nodes) if (core === null || n.r > nodes.get(core).r) core = nid;
  const distTo = new Map([[core, 0]]);
  const via = new Map();
  const queue = [core];
  while (queue.length) {
    const nid = queue.shift();
    for (const sid of nodes.get(nid).segs) {
      const s = segs.get(sid);
      const other = s.a === nid ? s.b : s.a;
      if (distTo.has(other)) continue;
      distTo.set(other, distTo.get(nid) + cumulative(s.points).at(-1));
      via.set(other, sid);
      queue.push(other);
    }
  }
  const keepSet = new Set(keep.map(Number));
  const dropSet = new Set(drop.map(Number));
  const leaves = [...nodes.keys()].filter(nid => nid !== core && nodes.get(nid).segs.size === 1 && distTo.has(nid));
  const coreR = nodes.get(core).r;
  const maxReach = Math.max(1e-9, ...leaves.map(l => distTo.get(l) - coreR));
  const chosen = leaves.filter((l) => {
    const s = segs.get([...nodes.get(l).segs][0]);
    if (keepSet.has(s.branch)) return true;
    if (only || dropSet.has(s.branch)) return false;
    const L = cumulative(s.points).at(-1) || 1e-9;
    const sheet = (s.sw || L) / L;
    const rv = s.radii.reduce((a, r) => a + r, 0) / s.radii.length / shape.pitch;
    // Cloth: a thin tube that sits in far more solid than a tube would (a robe
    // or cape thinned to curves). Wing membranes measure ~3.7 and stay.
    if (sheet > 4.5 && rv < 4.5) return false;
    // Short of reaching anywhere: a nub. (The head of a person reaches only
    // ~20% as far from the chest as a foot does, so this floor stays low.)
    return distTo.get(l) - coreR >= 0.12 * maxReach;
  });
  const keepSegs = new Set();
  const markPath = (from) => {
    let n = from;
    while (n !== core && via.has(n)) {
      const sid = via.get(n);
      if (keepSegs.has(sid)) break;
      keepSegs.add(sid);
      const s = segs.get(sid);
      n = s.a === n ? s.b : s.a;
    }
  };
  for (const l of chosen) markPath(l);
  // A labelled branch that is not a tip (a spine segment) stays too, with its way to the core.
  for (const [sid, s] of segs) {
    if (!keepSet.has(s.branch) || keepSegs.has(sid)) continue;
    keepSegs.add(sid);
    markPath(s.a);
    markPath(s.b);
  }
  if (!keepSegs.size) return { kept: [...new Set([...segs.values()].map(s => s.branch))], ignored: [] };
  for (const sid of [...segs.keys()]) {
    if (keepSegs.has(sid)) continue;
    const s = segs.get(sid);
    shape.ignoredSegs.set(`i${sid}`, s);
    segs.delete(sid);
    nodes.get(s.a)?.segs.delete(sid);
    nodes.get(s.b)?.segs.delete(sid);
  }
  for (const nid of [...nodes.keys()]) if (!nodes.get(nid).segs.size) nodes.delete(nid);
  const kept = new Set([...segs.values()].map(s => s.branch));
  const ignored = new Set([...shape.ignoredSegs.values()].map(s => s.branch).filter(b => !kept.has(b)));
  shape.selection = { kept: [...kept], ignored: [...ignored] };
  return shape.selection;
}

/** Give every segment per-point branch arcs (distance from the branch's own start). */
function stampBranchArcs(shape) {
  for (const s of shape.segs.values()) {
    if (s.barc) continue;
    s.barc = Array.from(cumulative(s.points));
  }
}

// ---- 2. the provisional dense skeleton ------------------------------------------------

/**
 * Lay joints along every segment of the tree, rooted at `root`
 * ({ node } or { branch, arc }). Returns { bones, info } where bones are
 * [{ name, parent, world }] parent-first and info[j] = { branch, barc, r }.
 */
function denseSkeleton(shape, root) {
  // Work on shallow copies so splitting at the root leaves the shape intact.
  const nodes = new Map([...shape.nodes].map(([k, n]) => [k, { p: n.p, r: n.r, segs: new Set(n.segs) }]));
  const segs = new Map(shape.segs);
  let rootNode = root.node;
  if (rootNode === undefined) {
    let host = null;
    for (const [sid, s] of segs) {
      if (s.branch !== root.branch) continue;
      if (root.arc >= s.barc[0] - 1e-9 && root.arc <= s.barc.at(-1) + 1e-9) { host = [sid, s]; break; }
    }
    if (!host) throw new Error(`Root branch ${root.branch} not found.`);
    const [sid, s] = host;
    const arcs = cumulative(s.points);
    const local = clamp(root.arc - s.barc[0], 0, arcs.at(-1));
    if (local < 1e-9) rootNode = s.a;
    else if (local > arcs.at(-1) - 1e-9) rootNode = s.b;
    else {
      const [i, t] = locate(arcs, local);
      const p = lerp(s.points[i], s.points[i + 1], t);
      const r = s.radii[i] + (s.radii[i + 1] - s.radii[i]) * t;
      const ba = s.barc[i] + (s.barc[i + 1] - s.barc[i]) * t;
      rootNode = '__root';
      nodes.set(rootNode, { p, r, segs: new Set() });
      const first = { a: s.a, b: rootNode, points: [...s.points.slice(0, i + 1), p], radii: [...s.radii.slice(0, i + 1), r], branch: s.branch, barc: [...s.barc.slice(0, i + 1), ba] };
      const second = { a: rootNode, b: s.b, points: [p, ...s.points.slice(i + 1)], radii: [r, ...s.radii.slice(i + 1)], branch: s.branch, barc: [ba, ...s.barc.slice(i + 1)] };
      segs.delete(sid);
      nodes.get(s.a).segs.delete(sid);
      nodes.get(s.b).segs.delete(sid);
      segs.set('r1', first); nodes.get(s.a).segs.add('r1'); nodes.get(rootNode).segs.add('r1');
      segs.set('r2', second); nodes.get(rootNode).segs.add('r2'); nodes.get(s.b).segs.add('r2');
    }
  }
  const spacingOf = (s) => {
    const meanR = s.radii.reduce((a, r) => a + r, 0) / s.radii.length;
    return Math.max(2 * shape.pitch, Math.min(0.9 * meanR, 0.06 * shape.size));
  };
  const bones = [];
  const info = [];
  const jointOfNode = new Map();
  const rootN = nodes.get(rootNode);
  bones.push({ name: 'j0', parent: -1, world: rootN.p.slice() });
  // The root's branch: any segment touching it.
  const anySeg = segs.get([...rootN.segs][0]);
  info.push({ branch: anySeg ? anySeg.branch : 0, barc: anySeg ? (anySeg.a === rootNode ? anySeg.barc[0] : anySeg.barc.at(-1)) : 0, r: rootN.r });
  jointOfNode.set(rootNode, 0);
  const queue = [rootNode];
  const done = new Set();
  while (queue.length) {
    const nid = queue.shift();
    for (const sid of nodes.get(nid).segs) {
      if (done.has(sid)) continue;
      done.add(sid);
      const s = segs.get(sid);
      const forward = s.a === nid;
      const points = forward ? s.points : s.points.slice().reverse();
      const radii = forward ? s.radii : s.radii.slice().reverse();
      const barc = forward ? s.barc : s.barc.slice().reverse();
      const other = forward ? s.b : s.a;
      const arcs = cumulative(points);
      const L = arcs.at(-1);
      const n = clamp(Math.ceil(L / spacingOf(s)), 1, 24);
      let parentJoint = jointOfNode.get(nid);
      for (let k = 1; k <= n; k += 1) {
        const a = (k * L) / n;
        bones.push({ name: `j${bones.length}`, parent: parentJoint, world: pointAt(points, arcs, a) });
        info.push({ branch: s.branch, barc: valueAt(barc, arcs, a), r: valueAt(radii, arcs, a) });
        parentJoint = bones.length - 1;
      }
      jointOfNode.set(other, parentJoint);
      queue.push(other);
    }
  }
  return { bones, info };
}

/** A few thousand triangles of the mesh - enough for describeRig's bounds and weights. */
function sampleMesh(mesh, maxTriangles = 12000) {
  const stride = Math.max(1, Math.ceil(mesh.triCount / maxTriangles));
  const tris = Math.ceil(mesh.triCount / stride);
  const positions = new Float32Array(tris * 9);
  const indices = new Uint32Array(tris * 3);
  let t = 0;
  for (let src = 0; src < mesh.triCount; src += stride) {
    for (let k = 0; k < 3; k += 1) {
      const v = mesh.indices[src * 3 + k];
      positions[(t * 3 + k) * 3] = mesh.positions[v * 3];
      positions[(t * 3 + k) * 3 + 1] = mesh.positions[v * 3 + 1];
      positions[(t * 3 + k) * 3 + 2] = mesh.positions[v * 3 + 2];
      indices[t * 3 + k] = t * 3 + k;
    }
    t += 1;
  }
  return readStaticMesh(soupGlb({ positions: positions.subarray(0, t * 9), indices: indices.subarray(0, t * 3), vertexCount: t * 3 }));
}

/** Nearest-bone-segment influences (one bone per vertex) - fast, for perception only. */
function nearestSegmentInfluences(positions, bones) {
  const segs = [];
  for (let j = 0; j < bones.length; j += 1) {
    const p = bones[j].parent;
    if (p < 0) continue;
    const a = bones[p].world, b = bones[j].world;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    if (l2 < 1e-14) continue;
    segs.push({ joint: p, a, ab, l2 });
  }
  const count = positions.length / 3;
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let v = 0; v < count; v += 1) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let best = 0;
    let bestD = Infinity;
    for (const s of segs) {
      const t = clamp(((x - s.a[0]) * s.ab[0] + (y - s.a[1]) * s.ab[1] + (z - s.a[2]) * s.ab[2]) / s.l2, 0, 1);
      const dx = x - (s.a[0] + s.ab[0] * t), dy = y - (s.a[1] + s.ab[1] * t), dz = z - (s.a[2] + s.ab[2] * t);
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = s.joint; }
    }
    joints[v * 4] = best;
    weights[v * 4] = 1;
  }
  return { joints, weights };
}

// ---- writer --------------------------------------------------------------------------

/**
 * Write a skeleton + skin into a static mesh (from readStaticMesh). `bones` are
 * [{ name, parent, world: [x,y,z] }] parent-first; `influences` are per soup
 * vertex { joints: Uint16Array(V*4), weights: Float32Array(V*4) } (default: all
 * on the root). Joints carry no rotation (translation-only, identity bind
 * orientation), like the rigid builder. Geometry is baked to world space and
 * mesh nodes lifted to the scene root, so glTF and three.js agree.
 */
export function writeSkeleton(mesh, bones, { influences = null, extras = null, skinName = 'ShapeRig' } = {}) {
  const json = JSON.parse(JSON.stringify(mesh.json));
  const bin = mesh.bin;
  const binParts = [bin ? Buffer.from(bin) : Buffer.alloc(0)];
  let length = binParts[0].length;
  const add = (typed, componentType, type, count, extra = {}) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (length % 4)) % 4;
    if (pad) { binParts.push(Buffer.alloc(pad)); length += pad; }
    json.bufferViews = json.bufferViews || [];
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    binParts.push(bytes);
    length += bytes.length;
    json.accessors = json.accessors || [];
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType, count, type, ...extra });
    return json.accessors.length - 1;
  };
  if (!json.buffers || !json.buffers.length) json.buffers = [{ byteLength: 0 }];
  json.nodes = json.nodes || [];
  const armature = json.nodes.length;
  json.nodes.push({ name: 'Armature', children: [] });
  const jointNodes = [];
  bones.forEach((b, j) => {
    const parentWorld = b.parent >= 0 ? bones[b.parent].world : [0, 0, 0];
    const local = sub(b.world, parentWorld);
    json.nodes.push({ name: b.name, translation: local, children: [] });
    const node = json.nodes.length - 1;
    jointNodes.push(node);
    const parentNode = b.parent >= 0 ? jointNodes[b.parent] : armature;
    if (b.parent >= j) throw new Error('writeSkeleton: bones must be listed parent-first.');
    json.nodes[parentNode].children.push(node);
  });
  for (const n of json.nodes) if (n.children && !n.children.length) delete n.children;
  const ibm = new Float32Array(bones.length * 16);
  bones.forEach((b, i) => ibm.set(new THREE.Matrix4().makeTranslation(-b.world[0], -b.world[1], -b.world[2]).elements, i * 16));
  json.skins = json.skins || [];
  json.skins.push({ name: skinName, joints: jointNodes, skeleton: armature, inverseBindMatrices: add(ibm, FLOAT, 'MAT4', bones.length), ...(extras ? { extras } : {}) });
  const skinIndex = json.skins.length - 1;

  const worlds = nodeWorldMatrices(json);
  const scene = json.scenes[json.scene ?? 0];
  const sceneRoots = scene.nodes;
  const meshUsers = new Map();
  for (const pr of mesh.prims) meshUsers.set(pr.meshIndex, (meshUsers.get(pr.meshIndex) || new Set()).add(pr.nodeIndex));
  for (const [m, users] of meshUsers) {
    if (users.size > 1) throw new Error(`Mesh ${m} is instanced by several nodes; rigging needs each piece to be its own mesh.`);
  }
  for (const pr of mesh.prims) {
    const primitive = json.meshes[pr.meshIndex].primitives[pr.primitiveIndex];
    const count = pr.count;
    const pos = Float32Array.from(mesh.positions.subarray(pr.offset * 3, (pr.offset + count) * 3));
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i += 1) for (let c = 0; c < 3; c += 1) { min[c] = Math.min(min[c], pos[i * 3 + c]); max[c] = Math.max(max[c], pos[i * 3 + c]); }
    primitive.attributes.POSITION = add(pos, FLOAT, 'VEC3', count, { min, max });
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(worlds[pr.nodeIndex]);
    if (primitive.attributes.NORMAL !== undefined) {
      const nv = readAccessor(json, bin, primitive.attributes.NORMAL).values;
      const out = new Float32Array(count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < count; i += 1) {
        v.set(nv[i * 3], nv[i * 3 + 1], nv[i * 3 + 2]).applyMatrix3(normalMatrix).normalize();
        out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
      }
      primitive.attributes.NORMAL = add(out, FLOAT, 'VEC3', count);
    }
    delete primitive.attributes.TANGENT;
    delete primitive.attributes.JOINTS_1;
    delete primitive.attributes.WEIGHTS_1;
    const j16 = new Uint16Array(count * 4);
    const w32 = new Float32Array(count * 4);
    if (influences) {
      j16.set(influences.joints.subarray(pr.offset * 4, (pr.offset + count) * 4));
      w32.set(influences.weights.subarray(pr.offset * 4, (pr.offset + count) * 4));
    } else {
      for (let i = 0; i < count; i += 1) w32[i * 4] = 1;
    }
    primitive.attributes.JOINTS_0 = add(j16, USHORT, 'VEC4', count);
    primitive.attributes.WEIGHTS_0 = add(w32, FLOAT, 'VEC4', count);
    const node = json.nodes[pr.nodeIndex];
    delete node.matrix; delete node.translation; delete node.rotation; delete node.scale;
    node.skin = skinIndex;
    for (const other of json.nodes) if (other.children) other.children = other.children.filter(c => c !== pr.nodeIndex);
    if (!sceneRoots.includes(pr.nodeIndex)) sceneRoots.push(pr.nodeIndex);
  }
  sceneRoots.push(armature);
  const out = Buffer.concat(binParts);
  json.buffers[0].byteLength = out.length;
  return serializeGlb(json, out);
}

/**
 * Remove a skin so the mesh can be rigged again: geometry stays in its bind
 * pose (what loadRig reads), materials/UVs are kept, every node that is not a
 * mesh (bones, armature) and every animation is dropped.
 */
export function stripSkin(buffer) {
  const { json, bin } = parseGlb(buffer);
  const worlds = nodeWorldMatrices(json);
  const binParts = [bin ? Buffer.from(bin) : Buffer.alloc(0)];
  let length = binParts[0].length;
  const add = (typed, componentType, type, count, extra = {}) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (length % 4)) % 4;
    if (pad) { binParts.push(Buffer.alloc(pad)); length += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    binParts.push(bytes);
    length += bytes.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType, count, type, ...extra });
    return json.accessors.length - 1;
  };
  const meshNodes = [];
  const seenMeshes = new Set();
  (json.nodes || []).forEach((node, i) => {
    if (node.mesh === undefined) return;
    if (seenMeshes.has(node.mesh)) throw new Error(`Mesh ${node.mesh} is instanced by several nodes; cannot strip it to one static mesh.`);
    seenMeshes.add(node.mesh);
    // A skinned node's own transform is ignored by glTF: its vertices are
    // already where the skin binds them. Anything else is baked to world.
    const matrix = node.skin !== undefined ? new THREE.Matrix4() : worlds[i];
    const identity = matrix.equals(new THREE.Matrix4());
    for (const primitive of json.meshes[node.mesh].primitives || []) {
      delete primitive.attributes.JOINTS_0; delete primitive.attributes.WEIGHTS_0;
      delete primitive.attributes.JOINTS_1; delete primitive.attributes.WEIGHTS_1;
      if (identity || primitive.attributes.POSITION === undefined) continue;
      const read = readAccessor(json, bin, primitive.attributes.POSITION);
      const count = read.accessor.count;
      const out = new Float32Array(count * 3);
      const v = new THREE.Vector3();
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < count; k += 1) {
        v.set(read.values[k * 3], read.values[k * 3 + 1], read.values[k * 3 + 2]).applyMatrix4(matrix);
        out[k * 3] = v.x; out[k * 3 + 1] = v.y; out[k * 3 + 2] = v.z;
        min[0] = Math.min(min[0], v.x); min[1] = Math.min(min[1], v.y); min[2] = Math.min(min[2], v.z);
        max[0] = Math.max(max[0], v.x); max[1] = Math.max(max[1], v.y); max[2] = Math.max(max[2], v.z);
      }
      primitive.attributes.POSITION = add(out, FLOAT, 'VEC3', count, { min, max });
      if (primitive.attributes.NORMAL !== undefined) {
        const nr = readAccessor(json, bin, primitive.attributes.NORMAL);
        const nm = new THREE.Matrix3().getNormalMatrix(matrix);
        const nout = new Float32Array(count * 3);
        for (let k = 0; k < count; k += 1) {
          v.set(nr.values[k * 3], nr.values[k * 3 + 1], nr.values[k * 3 + 2]).applyMatrix3(nm).normalize();
          nout[k * 3] = v.x; nout[k * 3 + 1] = v.y; nout[k * 3 + 2] = v.z;
        }
        primitive.attributes.NORMAL = add(nout, FLOAT, 'VEC3', count);
      }
      delete primitive.attributes.TANGENT;
    }
    const kept = { ...node };
    delete kept.skin; delete kept.matrix; delete kept.translation; delete kept.rotation; delete kept.scale; delete kept.children;
    meshNodes.push(kept);
  });
  if (!meshNodes.length) throw new Error('The file has no mesh to rig.');
  json.nodes = meshNodes;
  json.scenes = [{ ...(json.scenes?.[json.scene ?? 0] || {}), nodes: meshNodes.map((_, i) => i) }];
  json.scene = 0;
  delete json.skins;
  delete json.animations;
  const out = Buffer.concat(binParts);
  json.buffers[0].byteLength = out.length;
  return serializeGlb(json, out);
}

// ---- 3. naming: provisional rig -> labelled branches -----------------------------------

const KIND_RULES = [
  [/^(spine|back|torso|chest|pelvis)/, 'spine'],
  [/^body/, 'body'],
  [/^neck/, 'neck'],
  [/^head(?!_appendage)/, 'head'],
  [/^tail/, 'tail'],
  [/^(leg|foot|paw)/, 'leg'],
  [/^(arm|hand)/, 'arm'],
  [/^wing/, 'wing'],
  [/(finger|toe|thumb|digit|talon)/, 'part'],
  [/^(ear|horn|antenna|jaw|tusk|crest|beak|snout|trunk|tongue|mandible|fang|eye)/, 'head_appendage'],
  [/^(tentacle|fin|appendage|claw|pincer|stinger)/, 'appendage']
];

/** True for a label of a paired body part given without its side (leg, ear, claw). */
function needsSide(label) {
  if (/_[LR](\.|$|_)/.test(label) || /_[LR]$/.test(label) || label === 'ignore') return false;
  return ['leg', 'arm', 'wing', 'head_appendage', 'appendage', 'part'].includes(kindOfLabel(label));
}

/** The chain kind a label implies (leg_front_L -> leg, tentacle_3 -> appendage). */
export function kindOfLabel(label) {
  const l = String(label).toLowerCase();
  for (const [re, kind] of KIND_RULES) if (re.test(l)) return kind;
  return 'appendage';
}

/**
 * Perceive the shape: provisional skeleton -> describeRig, twice (the second
 * time rooted at the hips the first pass found, so every chain runs
 * parent -> child the way the final rig will).
 * overrides: { forward, branches: { "<id>": "<label>" | "ignore" } }.
 */
export function perceiveShape(shape, sample, { forward = null, branches = {} } = {}) {
  stampBranchArcs(shape);
  if (!shape.segs.size) throw new Error('The shape skeleton has no branches: the mesh is a single blob. Rig it as one bone (rig_rigid_parts) or check it is a closed solid.');
  let labelled = Object.entries(branches || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([id, v]) => [id, v.trim()]);
  const profileFor = (bones, info) => {
    const profile = {};
    if (forward) profile.forward = forward;
    if (labelled.length) {
      const boneChains = {};
      for (const [id, label] of labelled) {
        bones.forEach((b, j) => { if (info[j].branch === Number(id) && j > 0) boneChains[b.name] = label.trim(); });
      }
      profile.boneChains = boneChains;
    }
    return Object.keys(profile).length ? profile : null;
  };
  const run = (root, profile = undefined) => {
    const { bones, info } = denseSkeleton(shape, root);
    const influences = nearestSegmentInfluences(sample.positions, bones);
    const rig = loadRig(writeSkeleton(sample, bones, { influences }));
    const description = describeRig(rig, profile === undefined ? profileFor(bones, info) : (forward ? { forward } : null));
    for (const c of description.chains) if (c.kind === 'custom') c.kind = kindOfLabel(c.label);
    return { bones, info, rig, description };
  };
  // Pass 1: root at the thickest junction (the body core), else mid-longest.
  let root = null;
  let bestR = -1;
  for (const [nid, n] of shape.nodes) if (n.segs.size >= 3 && n.r > bestR) { bestR = n.r; root = { node: nid }; }
  if (!root) {
    const longest = [...shape.segs.values()].sort((x, y) => cumulative(y.points).at(-1) - cumulative(x.points).at(-1))[0];
    root = { branch: longest.branch, arc: (longest.barc[0] + longest.barc.at(-1)) / 2 };
  }
  // Sides: an AI that says "leg" should not have to work out the creature's
  // left from a picture. Lateral labels without _L/_R get their side from the
  // geometry (the frame of an unlabelled first look), and repeated labels are
  // numbered front to back: eight "leg" become leg_1_L ... leg_4_R.
  if (labelled.some(([, v]) => needsSide(v))) {
    const look = run(root, null);
    const { forward: F, left: Lv } = look.description.frame.vectors;
    const o = look.description.origin;
    const tol = 0.03 * shape.size;
    const placed = labelled.map(([id, label]) => {
      const pts = [...shape.segs.values()].filter(s => s.branch === Number(id)).flatMap(s => s.points);
      if (!pts.length || !needsSide(label)) return { id, label, side: '', fwd: 0 };
      const lat = pts.reduce((acc, p) => acc + (p[0] - o[0]) * Lv[0] + (p[1] - o[1]) * Lv[1] + (p[2] - o[2]) * Lv[2], 0) / pts.length;
      const fwd = pts.reduce((acc, p) => acc + (p[0] - o[0]) * F[0] + (p[1] - o[1]) * F[1] + (p[2] - o[2]) * F[2], 0) / pts.length;
      return { id, label, side: Math.abs(lat) <= tol ? '' : (lat > 0 ? 'L' : 'R'), fwd };
    });
    const groups = new Map();
    for (const p of placed) {
      if (!needsSide(p.label)) continue;
      const key = `${p.label}|${p.side}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      group.sort((x, y) => y.fwd - x.fwd);
      group.forEach((p, k) => {
        const numbered = group.length > 1 ? `${p.label}_${k + 1}` : p.label;
        p.label = p.side ? `${numbered}_${p.side}` : numbered;
      });
    }
    labelled = placed.map(p => [p.id, p.label]);
  }
  let pass = run(root);
  const resolvedLabels = labelled.map(([, v]) => v);
  // Pass 2: root at the hips (start of the spine, or of the body of a limbless creature).
  // The hips are where the REARMOST legs attach (a biped's legs, a horse's hind
  // legs, all eight of a spider's). "First bone of the spine" is not: after
  // pass 1 that is whichever end sat nearer its root - a person's shoulders.
  // Limbless: the start of the body chain.
  const legs = pass.description.chains.filter(c => c.kind === 'leg' && c.attach);
  let hipName = null;
  if (legs.length) {
    hipName = legs.slice().sort((x, y) => x.base[0] - y.base[0])[0].attach;
  } else {
    const hipChain = pass.description.chains.find(c => c.kind === 'spine') || pass.description.chains.find(c => c.kind === 'body');
    hipName = hipChain ? hipChain.bones[0] : null;
  }
  if (hipName) {
    const hip = pass.bones.findIndex(b => b.name === hipName);
    if (hip > 0) {
      const at = pass.info[hip];
      pass = run({ branch: at.branch, arc: at.barc });
    }
  }
  pass.labels = resolvedLabels;
  return pass;
}

/** Per-branch summary of a perception pass (label = the chain most of its joints fell in). */
export function branchTable(shape, pass) {
  const byBranch = new Map();
  pass.bones.forEach((b, j) => {
    if (j === 0) return;
    const label = pass.description.jointChain[j];
    const id = pass.info[j].branch;
    if (!byBranch.has(id)) byBranch.set(id, new Map());
    const m = byBranch.get(id);
    m.set(label, (m.get(label) || 0) + 1);
  });
  const chainOf = new Map(pass.description.chains.map(c => [c.label, c]));
  const groundY = pass.description.size.groundY;
  const height = pass.description.size.height || shape.size;
  const toBody = (p) => {
    const { forward, up, left } = pass.description.frame.vectors;
    const o = pass.description.origin;
    const rel = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [round(dot(rel, forward)), round(dot(rel, up)), round(dot(rel, left))];
  };
  return shape.branches.map((b) => {
    const pieces = b.major ? branchPieces(shape, b.id) : null;
    let points;
    let radii;
    if (pieces) {
      ({ points, radii } = pieces);
    } else {
      points = b.detail.points;
      radii = b.detail.radii;
    }
    const counts = byBranch.get(b.id);
    let label = null;
    if (counts) label = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const chain = label ? chainOf.get(label) : null;
    const lowest = Math.min(points[0][1], points.at(-1)[1]);
    const meanR = radii.reduce((s, r) => s + r, 0) / radii.length;
    const ignored = Boolean(shape.selection?.ignored?.includes(b.id));
    const arcs = cumulative(points);
    const tagAt = b.terminal ? (b.tipAtStart ? 0.15 : 0.85) : 0.5;
    return {
      id: b.id,
      terminal: Boolean(b.terminal),
      status: b.major ? (ignored ? 'ignored' : 'rigged') : (b.detail?.promoted ? 'rigged' : 'detail'),
      label: label || (b.major ? null : 'detail'),
      kind: chain ? chain.kind : (b.major ? null : 'detail'),
      side: chain ? chain.side : null,
      length: round(b.length),
      radius: round(meanR),
      ends: [toBody(points[0]), toBody(points.at(-1))],
      touchesGround: lowest - groundY < 0.06 * height,
      ...(b.major ? {} : { detail: true }),
      mid: pointAt(points, arcs, arcs.at(-1) * tagAt)
    };
  });
}

// ---- 4. placing the final joints --------------------------------------------------------

/**
 * Joint arcs for one chain. Returns { arcs, end } - arcs (ascending, in model
 * units from the chain's attach point) where joints go, and whether a final
 * unweighted end joint marks the tip.
 */
function chainArcs(chain, poly, template, { rigidBody = false } = {}) {
  const { points, radii, arcs } = poly;
  const L = arcs.at(-1);
  if (!(L > 0)) return { arcs: [0], end: false };
  const meanR = radii.reduce((s, r) => s + r, 0) / radii.length || L / 6;
  const angles = turningAngles(points, arcs, Math.max(0.05 * L, 1e-6));
  const snap = (target, window = 0.08) => {
    let best = -1;
    let bestA = 25;
    for (let k = 1; k < points.length - 1; k += 1) {
      if (Math.abs(arcs[k] - target) > window * L) continue;
      if (angles[k] > bestA) { bestA = angles[k]; best = k; }
    }
    return best >= 0 ? arcs[best] : target;
  };
  // Where the tube leaves the body it hangs from: the first point farther from
  // the attach point than the body's radius there.
  const exitArc = () => {
    const r0 = radii[0] || meanR;
    for (let k = 1; k < points.length; k += 1) {
      if (dist(points[k], points[0]) >= 0.85 * r0) return clamp(arcs[k], 0, 0.5 * L);
    }
    return 0.5 * L;
  };
  const even = (from, count) => Array.from({ length: count }, (_, k) => from + ((L - from) * k) / count);
  const kind = chain.kind;
  const humanoid = template === 'humanoid';

  if (kind === 'spine') {
    if (humanoid) return { arcs: [0, 0.3, 0.55, 0.8].map(f => f * L), end: false };
    return { arcs: even(0, clamp(Math.round(L / (1.0 * meanR)), 2, 6)), end: false };
  }
  if (kind === 'neck') {
    if (humanoid) return { arcs: [0], end: false };
    return { arcs: even(0, clamp(Math.round(L / (1.2 * meanR)), 1, 4)), end: false };
  }
  if (kind === 'head') return { arcs: [0], end: true };
  if (kind === 'body') return { arcs: even(0, clamp(Math.round(L / (1.2 * meanR)), 4, 24)), end: false };
  if (kind === 'leg') {
    if (humanoid) {
      const ankle = snap(0.82 * L, 0.09);
      const knee = snap(0.07 * L + 0.5 * (ankle - 0.07 * L), 0.07);
      return { arcs: [0.07 * L, knee, ankle, ankle + 0.62 * (L - ankle)], end: true };
    }
    const e = clamp(exitArc(), 0.12 * L, 0.35 * L);
    const rest = [0.33, 0.66, 0.88].map(f => snap(e + f * (L - e), 0.07));
    // A girdle bone (scapula / pelvis side) from the attach point to the exit
    // lets a quadruped's shoulder roll. Inside a rigid shell (a collapsed
    // core: crab, beetle) it would only drag the shell with the leg.
    return { arcs: rigidBody ? [e, ...rest] : [0, e, ...rest], end: true };
  }
  if (kind === 'arm') {
    const elbow = snap(0.53 * L, 0.07);
    const wrist = snap(0.8 * L, 0.05);
    return { arcs: [0.06 * L, 0.21 * L, elbow, wrist], end: !humanoid };
  }
  if (kind === 'wing') {
    const e = clamp(exitArc(), 0.1 * L, 0.35 * L);
    const wing = [e, snap(e + 0.4 * (L - e)), snap(e + 0.75 * (L - e))];
    return { arcs: rigidBody ? wing : [0, ...wing], end: true };
  }
  if (kind === 'part') {
    return { arcs: even(0, clamp(Math.round(L / (1.5 * meanR)), 1, 3)), end: true };
  }
  // tail, appendage, head_appendage, root, custom: from where it leaves the
  // body, one joint per ~1.3 tube diameters.
  const e = kind === 'root' ? 0 : exitArc();
  const n = clamp(Math.round((L - e) / (1.3 * meanR)), 1, 12);
  return { arcs: even(e, n), end: true };
}

/**
 * Build the final skeleton from a perception pass.
 * template: 'humanoid' | 'creature'. Returns { bones, chains, root }.
 */
export function planSkeleton(pass, template, { rigidBody = false, only = false } = {}) {
  const { bones: dense, description } = pass;
  const nameToDense = new Map(dense.map((b, j) => [b.name, j]));
  const chainOfDense = new Map();
  // In `only` mode the caller named every part to rig: chains it did not name
  // (the strands that join a crab's legs to its shell, the folds of a robe
  // between a leg and the hips) are dropped - except the trunk, which joins
  // everything - and the named parts hang from the nearest body joint.
  const TRUNK = ['spine', 'neck', 'head', 'tail', 'body', 'root'];
  const named = new Set(pass.labels || []);
  const candidates = description.chains.filter(c => !['helper', 'extra', 'ignore'].includes(c.kind) && c.label !== 'ignore');
  let usable = candidates;
  if (only) {
    // ...but an unnamed chain that CARRIES two or more named parts is their
    // common base - a claw's arm under its two fingers, a hand under fingers.
    const chainOfJoint = new Map();
    for (const c of candidates) for (const name of c.bones) chainOfJoint.set(nameToDense.get(name), c);
    const parentChain = (c) => {
      let j = dense[nameToDense.get(c.bones[0])].parent;
      while (j >= 0 && !chainOfJoint.has(j)) j = dense[j].parent;
      return j >= 0 ? chainOfJoint.get(j) : null;
    };
    const carried = new Map();
    for (const c of candidates) {
      if (!named.has(c.label)) continue;
      const host = parentChain(c);
      if (host && !named.has(host.label) && !TRUNK.includes(host.kind)) {
        if (!carried.has(host)) carried.set(host, []);
        carried.get(host).push(c.label);
      }
    }
    for (const [host, labels] of carried) {
      if (labels.length < 2) continue;
      const bases = new Set(labels.map(l => l.replace(/_[LR]$/, '').replace(/_\d+$/, '')));
      const side = /_([LR])$/.exec(labels[0])?.[1];
      const base = bases.size === 1 ? [...bases][0] : 'limb';
      host.label = `${base}_base${side ? `_${side}` : ''}`;
      host.kind = 'appendage';
      named.add(host.label);
    }
    usable = candidates.filter(c => named.has(c.label) || TRUNK.includes(c.kind));
  }
  for (const c of usable) c.bones.forEach((name, i) => chainOfDense.set(nameToDense.get(name), { chain: c, index: i }));

  // Polyline of each chain: its attach point, then its bones.
  const polys = new Map();
  for (const c of usable) {
    const idx = c.bones.map(n => nameToDense.get(n));
    const parent = dense[idx[0]].parent;
    const js = parent >= 0 ? [parent, ...idx] : idx;
    const points = js.map(j => dense[j].world);
    const radii = js.map(j => pass.info[j].r);
    polys.set(c.label, { js, points, radii, arcs: cumulative(points), attachDense: parent });
  }
  // Chain order: the root chain first, then breadth-first by attachment.
  const rootChain = usable.find(c => dense[nameToDense.get(c.bones[0])].parent < 0)
    || usable.find(c => c.kind === 'spine') || usable[0];
  const attachChainOf = (c) => {
    let j = polys.get(c.label).attachDense;
    while (j >= 0 && !chainOfDense.has(j)) j = dense[j].parent;
    return j >= 0 ? { chain: chainOfDense.get(j).chain, dense: j } : null;
  };
  const order = [rootChain];
  const placed = new Set([rootChain.label]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of usable) {
      if (placed.has(c.label)) continue;
      const at = attachChainOf(c);
      if (at && placed.has(at.chain.label)) { order.push(c); placed.add(c.label); grew = true; }
    }
  }
  for (const c of usable) if (!placed.has(c.label)) order.push(c); // orphans hang from the root

  // A humanoid needs a Neck (Mixamo, retargeting). When perception folded the
  // neck into the head, split the head chain at its THINNEST point - the neck
  // is the narrowest part between the shoulders and the skull.
  if (template === 'humanoid' && !usable.some(c => c.kind === 'neck')) {
    const head = usable.find(c => c.kind === 'head');
    const poly = head && polys.get(head.label);
    if (poly && poly.points.length >= 4) {
      const L = poly.arcs.at(-1);
      let best = -1;
      for (let k = 1; k < poly.points.length - 1; k += 1) {
        if (poly.arcs[k] < 0.15 * L || poly.arcs[k] > 0.6 * L) continue;
        if (best < 0 || poly.radii[k] < poly.radii[best]) best = k;
      }
      if (best > 0) {
        const neck = { label: 'neck', kind: 'neck', side: 'mid', bones: [] };
        polys.set('neck', { js: poly.js.slice(0, best + 1), points: poly.points.slice(0, best + 1), radii: poly.radii.slice(0, best + 1), arcs: cumulative(poly.points.slice(0, best + 1)), attachDense: poly.attachDense });
        const headPoints = poly.points.slice(best);
        polys.set(head.label, { js: poly.js.slice(best), points: headPoints, radii: poly.radii.slice(best), arcs: cumulative(headPoints), attachDense: poly.js[best] });
        neck.split = true;
        usable.splice(usable.indexOf(head), 0, neck);
        order.splice(order.indexOf(head), 0, neck);
        // Dense joints up to the split now belong to the neck.
        for (const j of poly.js.slice(1, best + 1)) if (chainOfDense.has(j)) chainOfDense.set(j, { chain: neck, index: 0 });
        neck.bones = poly.js.slice(1, best + 1).map(j => dense[j].name);
      }
    }
  }

  // Robed humanoids: inside a filled robe or long coat the leg tubes only meet
  // the body high up (Kaeven: hips found at 72% of the height, the visible
  // legs starting at the knees). Real hips sit at ~53% of the height. When the
  // hips are well above that, rebuild the lower body: each leg runs from a hip
  // socket at hip height (trimmed if its tube climbs higher, extended straight
  // up if it stops lower), the hips sit between the sockets, the spine runs
  // straight from there to the chest, and the bones that only traced the robe
  // below the hips go.
  if (template === 'humanoid') {
    const legs = usable.filter(c => c.kind === 'leg');
    const spine = usable.find(c => c.kind === 'spine');
    const H = description.size.height || 1;
    const g = description.size.groundY || 0;
    const hipY = g + 0.53 * H;
    const sp = spine && polys.get(spine.label);
    if (legs.length === 2 && sp && sp.points[0][1] - g > 0.62 * H) {
      const tops = [];
      for (const leg of legs) {
        const poly = polys.get(leg.label);
        let points;
        let radii;
        if (poly.points[0][1] > hipY) {
          let k = 1;
          while (k < poly.points.length && poly.points[k][1] > hipY) k += 1;
          if (k >= poly.points.length) k = poly.points.length - 1;
          const a = poly.points[k - 1], b = poly.points[k];
          const t = a[1] !== b[1] ? clamp((a[1] - hipY) / (a[1] - b[1]), 0, 1) : 0;
          points = [lerp(a, b, t), ...poly.points.slice(k)];
          radii = [poly.radii[k], ...poly.radii.slice(k)];
        } else {
          const top = poly.points[0];
          points = [[top[0], hipY, top[2]], ...poly.points];
          radii = [poly.radii[0], ...poly.radii];
        }
        polys.set(leg.label, { ...poly, points, radii, arcs: cumulative(points), attachTo: spine.label, attachArc: 0 });
        tops.push(points[0]);
      }
      const hips = lerp(tops[0], tops[1], 0.5);
      const chest = sp.points.at(-1);
      const n = 8;
      const points = Array.from({ length: n + 1 }, (_, i) => lerp(hips, chest, i / n));
      const meanR = sp.radii.reduce((acc, r) => acc + r, 0) / sp.radii.length;
      polys.set(spine.label, { ...sp, points, radii: points.map(() => meanR), arcs: cumulative(points) });
      for (const c of usable.filter(x => x.kind === 'root')) {
        usable.splice(usable.indexOf(c), 1);
        if (order.includes(c)) order.splice(order.indexOf(c), 1);
        polys.delete(c.label);
      }
    }
  }

  // Where along its host chain a chain attaches: the host joint nearest to the
  // attach point, by position (the host line may have been re-shaped above).
  const attachArcOn = (hostPoly, point) => {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < hostPoly.points.length; k += 1) {
      const d = dist(hostPoly.points[k], point);
      if (d < bestD) { bestD = d; best = k; }
    }
    return hostPoly.arcs[best];
  };

  const bones = [];
  const finalOf = new Map(); // chain label -> [{ index, arc }]
  const out = [];
  const minGap = 1e-4 * (description.size.height || 1);
  for (const c of order) {
    const poly = polys.get(c.label);
    const { arcs, end } = chainArcs(c, poly, template, { rigidBody });
    const at = c === rootChain ? null
      : (poly.attachTo ? { chain: usable.find(x => x.label === poly.attachTo), arc: poly.attachArc } : attachChainOf(c));
    let parentIndex = -1;
    if (at && at.chain && finalOf.has(at.chain.label)) {
      const host = finalOf.get(at.chain.label) || [];
      const hostPoly = polys.get(at.chain.label);
      const attachArc = at.arc ?? attachArcOn(hostPoly, dense[at.dense].world);
      let pick = host[0];
      for (const h of host) if (h.arc <= attachArc + 1e-9) pick = h;
      parentIndex = pick ? pick.index : 0;
    } else if (c !== rootChain && bones.length) {
      parentIndex = 0;
    }
    const placedJoints = [];
    const names = [];
    const all = end ? [...arcs, poly.arcs.at(-1)] : arcs;
    const base = c.label.replace(/[^A-Za-z0-9_.]+/g, '_');
    all.forEach((a, k) => {
      const world = pointAt(poly.points, poly.arcs, a);
      const prev = placedJoints.length ? bones[placedJoints.at(-1).index] : (parentIndex >= 0 ? bones[parentIndex] : null);
      if (prev && dist(prev.world, world) < minGap) return; // coincides with its parent
      const isEnd = end && k === all.length - 1;
      const name = isEnd ? `${base}_end` : (all.length - (end ? 1 : 0) === 1 ? base : `${base}_${placedJoints.length + 1}`);
      bones.push({ name, parent: placedJoints.length ? placedJoints.at(-1).index : parentIndex, world, chain: c.label, end: isEnd });
      placedJoints.push({ index: bones.length - 1, arc: a });
      names.push(name);
    });
    finalOf.set(c.label, placedJoints);
    if (names.length) out.push({ label: c.label, kind: c.kind, bones: names });
  }
  return { bones, chains: out };
}

// ---- 5. the whole build --------------------------------------------------------------

/** Two legs, two arms, a head and an upright spine. */
function looksHumanoid(plan) {
  const count = kind => plan.chains.filter(c => c.kind === kind).length;
  if (count('leg') !== 2 || count('arm') !== 2 || !count('head')) return false;
  const spine = plan.chains.find(c => c.kind === 'spine');
  const head = plan.chains.find(c => c.kind === 'head');
  const at = name => plan.bones.find(b => b.name === name)?.world;
  const from = at((spine || head).bones[0]);
  const to = at(head.bones[head.bones.length - 1]);
  if (!from || !to) return false;
  const d = sub(to, from);
  return len(d) > 0 && d[1] / len(d) > 0.7;
}

/**
 * Rig a static mesh. `skeletonPayload` is the /meshes/shape-skeleton result for
 * `buffer` (an UNRIGGED GLB - stripSkin a rigged one first).
 * options: { forward, branches, template: 'auto'|'humanoid'|'creature', naming: 'auto'|'semantic'|'mixamo', detailRatio }
 * Returns { buffer, profile, chains, template, naming, analysis, notes }.
 */
export function buildShapeRig(buffer, skeletonPayload, options = {}) {
  const notes = [];
  const mesh = readStaticMesh(buffer);
  const shape = prepareShape(skeletonPayload, { detailRatio: options.detailRatio ?? 0.03, body: options.body || 'auto' });
  numberBranches(shape);
  const overrides = options.branches || {};
  const labelledDetails = Object.entries(overrides)
    .filter(([id, v]) => v && v !== 'ignore' && shape.branches.find(b => b.id === Number(id) && !b.major))
    .map(([id]) => Number(id));
  promoteDetails(shape, labelledDetails);
  selectAnatomy(shape, anatomyOptions(overrides, options));
  const sample = sampleMesh(mesh);
  const pass = perceiveShape(shape, sample, { forward: options.forward || null, branches: overrides });
  let template = options.template || 'auto';
  if (template === 'auto') template = /biped \(humanoid/.test(pass.description.bodyPlan) ? 'humanoid' : 'creature';
  let plan = planSkeleton(pass, template, { rigidBody: Boolean(shape.core?.collapsed), only: Boolean(options.only) });
  if (plan.bones.length < 2) throw new Error('Only one joint could be placed - the shape has no limbs to bend. Use rig_rigid_parts or add_bone for a single-part prop.');

  const profile = {
    forward: options.forward || pass.description.frame.forward,
    chains: plan.chains,
    contacts: plan.chains.filter(c => c.kind === 'leg').map(c => c.label),
    source: 'build_rig',
    template
  };
  const extras = { genstudio: { rig: { source: 'build_rig', template, forward: profile.forward, branches: overrides, resolution: skeletonPayload?.stats?.resolution ?? null } } };
  let out = writeSkeleton(mesh, plan.bones, { extras });
  let rig = loadRig(out);
  let description = describeRig(rig, profile);
  // The template was chosen from the dense perception pass, which still holds
  // clutter (a robe's paths under the hips). The planned chains are the better
  // judge: two legs, two arms, a head and an upright spine is a humanoid, so
  // place the joints by the humanoid rules (Mixamo names, a neck) - cheap, it
  // is before the weights are bound.
  if ((options.template || 'auto') === 'auto' && template !== 'humanoid' && looksHumanoid(plan)) {
    template = 'humanoid';
    plan = planSkeleton(pass, template, { rigidBody: Boolean(shape.core?.collapsed), only: Boolean(options.only) });
    profile.chains = plan.chains;
    profile.contacts = plan.chains.filter(c => c.kind === 'leg').map(c => c.label);
    profile.template = template;
    extras.genstudio.rig.template = template;
    out = writeSkeleton(mesh, plan.bones, { extras });
    rig = loadRig(out);
    description = describeRig(rig, profile);
  }
  const ends = plan.bones.filter(b => b.end).map(b => b.name);
  const bound = rebuildWeights(out, { description, exclude: ends });
  out = bound.buffer;
  if (bound.note) notes.push(bound.note);

  let naming = options.naming || 'auto';
  if (naming === 'auto') naming = template === 'humanoid' ? 'mixamo' : 'semantic';
  if (naming === 'mixamo') {
    rig = loadRig(out);
    description = describeRig(rig, profile);
    try {
      const map = namingScheme(rig, description, 'mixamo');
      if (Object.keys(map).length) {
        out = renameBones(out, map).buffer;
        profile.chains = profile.chains.map(c => ({ ...c, bones: c.bones.map(b => map[b] || b) }));
      }
    } catch (err) {
      notes.push(`Kept semantic bone names: ${err.message}`);
      naming = 'semantic';
    }
  }
  return {
    buffer: out,
    profile,
    template,
    naming,
    bones: plan.bones.length,
    chains: profile.chains,
    analysis: { shape, pass },
    weights: { vertices: bound.vertices, visibility: bound.visibility, blindVertices: bound.blindVertices },
    notes
  };
}

function anatomyOptions(overrides, options) {
  const entries = Object.entries(overrides || {});
  return {
    keep: entries.filter(([, v]) => v && v !== 'ignore').map(([id]) => Number(id)),
    drop: entries.filter(([, v]) => v === 'ignore').map(([id]) => Number(id)),
    only: Boolean(options.only)
  };
}

/** Analysis only (analyze_shape): branches with labels, frame, body plan. */
export function analyzeShapeMesh(buffer, skeletonPayload, options = {}) {
  const mesh = readStaticMesh(buffer);
  const shape = prepareShape(skeletonPayload, { detailRatio: options.detailRatio ?? 0.03, body: options.body || 'auto' });
  numberBranches(shape);
  const overrides = options.branches || {};
  promoteDetails(shape, Object.entries(overrides).filter(([id, v]) => v && v !== 'ignore' && shape.branches.find(b => b.id === Number(id) && !b.major)).map(([id]) => Number(id)));
  selectAnatomy(shape, anatomyOptions(overrides, options));
  const sample = sampleMesh(mesh);
  const pass = perceiveShape(shape, sample, { forward: options.forward || null, branches: overrides });
  const table = branchTable(shape, pass);
  const template = /biped \(humanoid/.test(pass.description.bodyPlan) ? 'humanoid' : 'creature';
  return { mesh, sample, shape, pass, table, template };
}

// ---- 6. the analysis image --------------------------------------------------------------

/**
 * The AI's view of the shape: the mesh, every branch's centre line coloured by
 * its label, and its NUMBER at its middle (details thin and grey, unnumbered
 * unless `numberDetails`). One image per call so the AI can label every tube
 * in a single look.
 */
export function renderShapeAnalysis(sample, table, description, { views = ['front', 'left', 'three_quarter', 'top'], size = 380, numberDetails = false, numberAll = false, shape = null } = {}) {
  const labels = [...new Set(table.filter(b => b.status === 'rigged' && b.label).map(b => b.label))];
  const colourOf = (b) => {
    if (b.status === 'detail') return [150, 150, 150];
    if (b.status === 'ignored') return [115, 115, 125];
    const i = labels.indexOf(b.label);
    const c = PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
    return c.map(v => Math.round(v * 255));
  };
  const lines = [];
  const points = [];
  for (const b of table) {
    const poly = branchPolyline(shape, b.id);
    if (!poly) continue;
    const c = colourOf(b);
    for (let k = 1; k < poly.length; k += 1) lines.push([...poly[k - 1], ...poly[k], c]);
    points.push(...poly);
  }
  // The two ends of the body carry their NAME too: a "head" printed on the
  // tail is the one mistake a glance must catch (it flips left and right).
  const named = b => (b.status === 'rigged' && (b.kind === 'head' || b.kind === 'tail') ? ` ${b.kind}` : '');
  const tags = table
    .filter(b => (numberDetails || b.status !== 'detail') && (numberAll || b.terminal || b.status === 'detail'))
    .map(b => ({ p: b.mid, text: `${b.id}${named(b)}`, colour: colourOf(b) }));
  // `sample` may be the full mesh: draw at most ~150k triangles per view.
  const positions = sample.positions;
  // Skipping triangles leaves see-through holes; only thin out huge meshes.
  const decimate = Math.max(1, Math.ceil((sample.indices.length / 3) / 1500000));
  const tiles = views.map((view) => {
    const basis = viewBasis(description.frame.vectors, view);
    const extent = viewExtent(basis, [positions], points);
    return renderTile({
      positions, indices: sample.indices, basis, extent, size,
      segments: lines, groundPoint: [description.origin[0], description.size.groundY, description.origin[2]],
      label: view.replace(/_/g, ' '), labels: tags, decimate
    });
  });
  return composeGrid(tiles, Math.min(4, tiles.length)).png;
}

/** World polyline of one numbered branch (major: its segments in order; detail: its own). */
export function branchPolyline(shape, id) {
  if (!shape) return null;
  const b = shape.branches.find(x => x.id === id);
  if (!b) return null;
  if (!b.major) return b.detail.points;
  return branchPieces(shape, id)?.points || null;
}

/** Points + radii of one major branch, from its kept or ignored segments in branch order. */
function branchPieces(shape, id) {
  const all = [...shape.segs.values(), ...(shape.ignoredSegs ? shape.ignoredSegs.values() : [])];
  const segs = all.filter(s => s.branch === id).sort((x, y) => x.barc[0] - y.barc[0]);
  if (!segs.length) return null;
  return {
    points: segs.flatMap((s, i) => (i ? s.points.slice(1) : s.points)),
    radii: segs.flatMap((s, i) => (i ? s.radii.slice(1) : s.radii))
  };
}

// ---- 7. off the main thread ---------------------------------------------------------------

/**
 * Run analyze_shape ('analyze') or build_rig ('build') work on a worker thread
 * (shapeRigWorker.js): seconds of CPU on a generated mesh, in a process that
 * also serves the app. data: { buffer, payload, options, numberAll? }.
 * Resolves the worker's result with its byte arrays as Buffers.
 */
export function runShapeRigTask(task, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./shapeRigWorker.js', import.meta.url), { workerData: { task, ...data } });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      fn(value);
    };
    const asBuffer = bytes => (bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes);
    worker.on('message', (message) => {
      if (message?.type === 'done') {
        const r = message.result;
        settle(resolve, { ...r, png: asBuffer(r.png), ...(r.buffer ? { buffer: asBuffer(r.buffer) } : {}) });
      } else if (message?.type === 'error') {
        settle(reject, new Error(message.message));
      }
    });
    worker.on('error', err => settle(reject, err));
    worker.on('exit', code => settle(reject, new Error(`The rigging worker stopped unexpectedly (exit code ${code})`)));
  });
}
