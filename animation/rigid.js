// Rig a mesh made of RIGID PARTS - robots, mechs, turrets, vehicles, armour.
//
// SkinTokens (auto_rig_mesh) is trained on organic characters: on a robot it
// smears weights across plates that should move as solid pieces, and it needs
// a GPU. A robot does not need learned weights at all - every vertex belongs
// to exactly one part, and a joint sits where two parts meet. So:
//
//   1. PARTS: the mesh's separate pieces (islands - how robots are usually
//      modelled), or labels from Smart Segmentation for a fused AI mesh.
//      Specks below `minPart` of the surface (bolts, rivets) join the part
//      they sit on.
//   2. HIERARCHY: parts that touch are linked; the biggest part is the root,
//      and each part hangs from the neighbour it shares the largest contact
//      with (a maximum spanning tree over contact size). Parts that touch
//      nothing hang from the nearest part.
//   3. JOINTS: one per part, at the centre of its contact with its parent (the
//      hinge), plus an unweighted tip joint at the far end of every part so
//      each part has a direction to pose and to read in describe_rig.
//   4. WEIGHTS: 1.0 to the part's joint. On a fused mesh a vertex shared by
//      two parts is split between them, so the seam stretches instead of
//      tearing open.
//
// Geometry is baked to world space and the mesh nodes are lifted to the scene
// root with identity transforms: the glTF spec ignores a skinned mesh node's
// transform while three.js applies it, and baking makes both readings agree.
import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { collectPrimitives, nodeWorldMatrices, readAccessor } from '../meshRigTransfer.js';
import { weldedTopology } from './rigEdit.js';

const FLOAT = 5126;
const USHORT = 5123;
const UINT = 5125;

/** Merge every triangle primitive into one soup (world space). */
export function readStaticMesh(buffer) {
  const { json, bin } = parseGlb(buffer);
  if ((json.skins || []).some(s => (s.joints || []).length)) {
    throw new Error('This mesh is already rigged. rig_rigid_parts builds a skeleton for an UNRIGGED mesh.');
  }
  const prims = collectPrimitives(json, bin);
  if (!prims.length) throw new Error('The mesh has no triangles.');
  let vertexCount = 0;
  let triCount = 0;
  for (const p of prims) { vertexCount += p.count; triCount += Math.floor(p.indices.length / 3); }
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triCount * 3);
  const ranges = [];
  let vo = 0;
  let io = 0;
  for (const p of prims) {
    positions.set(p.positions, vo * 3);
    const t = Math.floor(p.indices.length / 3) * 3;
    for (let i = 0; i < t; i += 1) indices[io + i] = p.indices[i] + vo;
    ranges.push({ ...p, offset: vo, triOffset: io / 3 });
    vo += p.count;
    io += t;
  }
  return { json, bin, prims: ranges, positions, indices, vertexCount, triCount };
}

/** A minimal GLB of the merged soup (positions + indices), for the segmenter. */
export function soupGlb(mesh) {
  const pos = Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
  const idx = Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let c = 0; c < 3; c += 1) { min[c] = Math.min(min[c], mesh.positions[i + c]); max[c] = Math.max(max[c], mesh.positions[i + c]); }
  const json = {
    asset: { version: '2.0', generator: '3D Gen Studio rigid rig' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: pos.length + idx.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: mesh.vertexCount, type: 'VEC3', min, max },
      { bufferView: 1, componentType: UINT, count: mesh.indices.length, type: 'SCALAR' }
    ]
  };
  return serializeGlb(json, Buffer.concat([pos, idx]));
}

/**
 * Face labels from the segmentation service payload at `k` parts: replay the
 * first n-k merges of the proxy hierarchy with a union-find, then map faces
 * through `mapping` (the same replay src/utils/meshSegment.js does).
 */
export function labelsFromSegmentation(seg, k) {
  const n = seg.proxyFaceCount;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const merges = Math.min(Math.max(0, n - Math.max(1, k)), seg.history.length >> 1);
  for (let i = 0; i < merges; i += 1) {
    const a = find(seg.history[i * 2]);
    const b = find(seg.history[i * 2 + 1]);
    if (a !== b) parent[b] = a;
  }
  const dense = new Map();
  const labels = new Int32Array(seg.faceCount);
  for (let f = 0; f < seg.faceCount; f += 1) {
    const r = find(seg.mapping[f]);
    if (!dense.has(r)) dense.set(r, dense.size);
    labels[f] = dense.get(r);
  }
  return labels;
}

/** Face labels = connected pieces of the welded mesh. */
export function islandLabels(mesh) {
  const scale = bboxDiag(mesh.positions);
  const { canon, neighbours, count } = weldedTopology(mesh.positions, mesh.indices, scale);
  const comp = new Int32Array(count).fill(-1);
  let c = 0;
  for (let s = 0; s < count; s += 1) {
    if (comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const v = stack.pop();
      for (const o of neighbours[v]) if (comp[o] < 0) { comp[o] = c; stack.push(o); }
    }
    c += 1;
  }
  const labels = new Int32Array(mesh.triCount);
  for (let t = 0; t < mesh.triCount; t += 1) labels[t] = comp[canon[mesh.indices[t * 3]]];
  return labels;
}

function bboxDiag(p) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c += 1) { min[c] = Math.min(min[c], p[i + c]); max[c] = Math.max(max[c], p[i + c]); }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
}

function triArea(p, a, b, c) {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * Build the part graph and hierarchy from face labels.
 * Returns { parts: [{ id, faces, area, centroid, vertices:Set, parent, pivot, tip }], root, labels }.
 */
export function planRigidRig(mesh, rawLabels, { minPart = 0.01, reparent = {} } = {}) {
  const p = mesh.positions;
  const scale = bboxDiag(p);
  // Gather raw parts.
  const raw = new Map();
  let totalArea = 0;
  for (let t = 0; t < mesh.triCount; t += 1) {
    const l = rawLabels[t];
    const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
    const area = triArea(p, a, b, c);
    totalArea += area;
    if (!raw.has(l)) raw.set(l, { faces: [], area: 0, verts: new Set() });
    const part = raw.get(l);
    part.faces.push(t);
    part.area += area;
    part.verts.add(a); part.verts.add(b); part.verts.add(c);
  }
  // Specks join the big part nearest to them (by closest vertex, sampled).
  const big = [...raw.entries()].filter(([, v]) => v.area >= minPart * totalArea);
  if (!big.length) big.push([...raw.entries()].sort((x, y) => y[1].area - x[1].area)[0]);
  const bigSet = new Set(big.map(([l]) => l));
  const relabel = new Map(big.map(([l], i) => [l, i]));
  const sampleOf = (verts, n = 200) => { const arr = [...verts]; const step = Math.max(1, Math.floor(arr.length / n)); return arr.filter((_, i) => i % step === 0); };
  const bigSamples = big.map(([, v]) => sampleOf(v.verts));
  for (const [l, v] of raw) {
    if (bigSet.has(l)) continue;
    const probe = sampleOf(v.verts, 20);
    let best = 0, bestD = Infinity;
    bigSamples.forEach((samples, i) => {
      for (const a of probe) for (const b of samples) {
        const d = (p[a * 3] - p[b * 3]) ** 2 + (p[a * 3 + 1] - p[b * 3 + 1]) ** 2 + (p[a * 3 + 2] - p[b * 3 + 2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    relabel.set(l, best);
  }
  const labels = new Int32Array(mesh.triCount);
  for (let t = 0; t < mesh.triCount; t += 1) labels[t] = relabel.get(rawLabels[t]);
  const parts = big.map((_, id) => ({ id, faces: [], area: 0, verts: new Set() }));
  for (let t = 0; t < mesh.triCount; t += 1) {
    const part = parts[labels[t]];
    part.faces.push(t);
    const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
    part.area += triArea(p, a, b, c);
    part.verts.add(a); part.verts.add(b); part.verts.add(c);
  }
  for (const part of parts) {
    const c = new THREE.Vector3();
    for (const v of part.verts) c.add(new THREE.Vector3(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]));
    part.centroid = c.divideScalar(Math.max(1, part.verts.size));
  }

  // Contacts: SURFACE SAMPLES of two parts within `eps` of each other (voxel
  // hash). Vertices alone are not enough - a low-poly box has vertices only at
  // its corners, so two plates touching face to face shared no nearby vertex
  // and the hierarchy came out as nonsense (a shin hanging off the other shin).
  const eps = 0.012 * scale;
  const budget = 60000;
  const samplesOf = parts.map(() => []);
  let rng = 12345;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  for (let t = 0; t < mesh.triCount; t += 1) {
    const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
    const area = triArea(p, a, b, c);
    const n = Math.min(400, Math.max(1, Math.round((area / totalArea) * budget)));
    const list = samplesOf[labels[t]];
    for (let k = 0; k < n; k += 1) {
      let u = rand(), v = rand();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const w = 1 - u - v;
      list.push([
        p[a * 3] * w + p[b * 3] * u + p[c * 3] * v,
        p[a * 3 + 1] * w + p[b * 3 + 1] * u + p[c * 3 + 1] * v,
        p[a * 3 + 2] * w + p[b * 3 + 2] * u + p[c * 3 + 2] * v
      ]);
    }
  }
  const cell = (x) => Math.floor(x / eps);
  const grid = new Map();
  samplesOf.forEach((list, id) => {
    for (const q of list) {
      const k = `${cell(q[0])},${cell(q[1])},${cell(q[2])}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([id, q]);
    }
  });
  const contact = new Map(); // "a|b" -> { count, sum: Vector3 }
  for (const [k, entries] of grid) {
    const [x, y, z] = k.split(',').map(Number);
    const near = [];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const e = grid.get(`${x + dx},${y + dy},${z + dz}`);
      if (e) near.push(...e);
    }
    for (const [pa, qa] of entries) {
      // One contact per sample: its nearest sample of each other part.
      const nearest = new Map();
      for (const [pb, qb] of near) {
        if (pb === pa) continue;
        const d2 = (qa[0] - qb[0]) ** 2 + (qa[1] - qb[1]) ** 2 + (qa[2] - qb[2]) ** 2;
        if (d2 > eps * eps) continue;
        const prev = nearest.get(pb);
        if (!prev || d2 < prev.d2) nearest.set(pb, { d2, qb });
      }
      for (const [pb, { qb }] of nearest) {
        if (pb < pa) continue;
        const key = `${pa}|${pb}`;
        if (!contact.has(key)) contact.set(key, { count: 0, sum: new THREE.Vector3() });
        const c = contact.get(key);
        c.count += 1;
        c.sum.add(new THREE.Vector3((qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2, (qa[2] + qb[2]) / 2));
      }
    }
  }
  const contactOf = (a, b) => contact.get(a < b ? `${a}|${b}` : `${b}|${a}`);

  // Hierarchy: Prim's maximum spanning tree on contact size from the biggest part.
  const root = parts.reduce((best, part) => (part.area > best.area ? part : best), parts[0]).id;
  const inTree = new Set([root]);
  parts[root].parent = -1;
  parts[root].pivot = parts[root].centroid.clone();
  while (inTree.size < parts.length) {
    let bestEdge = null;
    for (const a of inTree) {
      for (const part of parts) {
        if (inTree.has(part.id)) continue;
        const c = contactOf(a, part.id);
        if (c && (!bestEdge || c.count > bestEdge.count)) bestEdge = { parent: a, child: part.id, count: c.count, at: c.sum.clone().divideScalar(c.count) };
      }
    }
    if (!bestEdge) {
      // Floating part: hang it from the nearest part already in the tree.
      let bestD = Infinity;
      for (const part of parts) {
        if (inTree.has(part.id)) continue;
        for (const a of inTree) {
          const d = parts[a].centroid.distanceTo(part.centroid);
          if (d < bestD) { bestD = d; bestEdge = { parent: a, child: part.id, count: 0, at: part.centroid.clone() }; }
        }
      }
    }
    parts[bestEdge.child].parent = bestEdge.parent;
    parts[bestEdge.child].pivot = bestEdge.at;
    parts[bestEdge.child].floating = bestEdge.count === 0;
    inTree.add(bestEdge.child);
  }
  // Agent corrections: { childPartId: parentPartId }.
  for (const [childStr, parentId] of Object.entries(reparent || {})) {
    const child = Number(childStr);
    if (!parts[child] || !parts[parentId] || child === root) continue;
    let cursor = parentId;
    let cycle = false;
    while (cursor >= 0) { if (cursor === child) { cycle = true; break; } cursor = parts[cursor].parent; }
    if (cycle) throw new Error(`reparent: making part ${parentId} the parent of part ${child} would create a loop.`);
    parts[child].parent = parentId;
    const c = contactOf(child, parentId);
    parts[child].pivot = c ? c.sum.clone().divideScalar(c.count) : parts[child].centroid.clone();
  }
  // Tip: the part's vertex farthest from its pivot.
  for (const part of parts) {
    let best = part.centroid.clone();
    let bestD = -1;
    for (const v of part.verts) {
      const q = new THREE.Vector3(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      const d = q.distanceTo(part.pivot);
      if (d > bestD) { bestD = d; best = q; }
    }
    part.tip = part.pivot.clone().lerp(best, 0.9);
  }
  return { parts, root, labels, totalArea };
}

/**
 * Write the skeleton and skin into the GLB. Returns { buffer, joints }.
 */
export function buildRigidRig(mesh, plan, { names = null } = {}) {
  const { json, bin } = mesh;
  const { parts, root, labels } = plan;
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

  // Joints: part joints parent-first, each with a tip child.
  const order = [];
  const children = parts.map(() => []);
  parts.forEach(pt => { if (pt.parent >= 0) children[pt.parent].push(pt.id); });
  const stack = [root];
  while (stack.length) { const id = stack.pop(); order.push(id); stack.push(...children[id]); }
  const partName = id => (names && names[id]) || (id === root ? 'body' : `part_${id}`);
  const jointNodes = [];
  const jointOfPart = new Map();
  const worldOf = [];
  json.nodes = json.nodes || [];
  const armature = json.nodes.length;
  json.nodes.push({ name: 'RigidArmature', children: [] });
  for (const id of order) {
    const part = parts[id];
    const parentPos = part.parent >= 0 ? parts[part.parent].pivot : new THREE.Vector3();
    const local = part.pivot.clone().sub(parentPos);
    json.nodes.push({ name: partName(id), translation: local.toArray(), children: [] });
    const node = json.nodes.length - 1;
    const parentNode = part.parent >= 0 ? jointNodes[jointOfPart.get(part.parent)] : armature;
    json.nodes[parentNode].children.push(node);
    jointOfPart.set(id, jointNodes.length);
    jointNodes.push(node);
    worldOf.push(part.pivot.clone());
  }
  // Tip joints only on LEAF parts: an intermediate part already points at its
  // child, and a second child would fork its chain in describe_rig.
  for (const id of order) {
    const part = parts[id];
    if (children[id].length) continue;
    const tipLocal = part.tip.clone().sub(part.pivot);
    if (tipLocal.length() < 1e-6) continue;
    json.nodes.push({ name: `${partName(id)}_end`, translation: tipLocal.toArray() });
    const node = json.nodes.length - 1;
    json.nodes[jointNodes[jointOfPart.get(id)]].children.push(node);
    jointNodes.push(node);
    worldOf.push(part.tip.clone());
  }
  const ibm = new Float32Array(jointNodes.length * 16);
  worldOf.forEach((w, i) => ibm.set(new THREE.Matrix4().makeTranslation(-w.x, -w.y, -w.z).elements, i * 16));
  json.skins = json.skins || [];
  json.skins.push({ name: 'RigidRig', joints: jointNodes, skeleton: armature, inverseBindMatrices: add(ibm, FLOAT, 'MAT4', jointNodes.length) });
  const skinIndex = json.skins.length - 1;

  // Per-vertex weights: share among the parts of the faces using the vertex.
  const vertexParts = new Map();
  for (let t = 0; t < mesh.triCount; t += 1) {
    const j = jointOfPart.get(labels[t]);
    for (let k = 0; k < 3; k += 1) {
      const v = mesh.indices[t * 3 + k];
      if (!vertexParts.has(v)) vertexParts.set(v, new Map());
      const m = vertexParts.get(v);
      m.set(j, (m.get(j) || 0) + 1);
    }
  }

  // Bake world positions/normals per primitive and attach the skin.
  const worlds = nodeWorldMatrices(json);
  const sceneRoots = json.scenes[json.scene ?? 0].nodes;
  const meshUsers = new Map();
  for (const pr of mesh.prims) meshUsers.set(pr.meshIndex, (meshUsers.get(pr.meshIndex) || new Set()).add(pr.nodeIndex));
  for (const [m, users] of meshUsers) {
    if (users.size > 1) throw new Error(`Mesh ${m} is instanced by several nodes; rigid rigging needs each piece to be its own mesh.`);
  }
  for (const pr of mesh.prims) {
    const primitive = json.meshes[pr.meshIndex].primitives[pr.primitiveIndex];
    const count = pr.count;
    primitive.attributes.POSITION = add(Float32Array.from(mesh.positions.subarray(pr.offset * 3, (pr.offset + count) * 3)), FLOAT, 'VEC3', count, minMax(mesh.positions, pr.offset, count));
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(worlds[pr.nodeIndex]);
    if (primitive.attributes.NORMAL !== undefined) {
      const n = readAccessor(json, bin, primitive.attributes.NORMAL).values;
      const out = new Float32Array(count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < count; i += 1) {
        v.set(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]).applyMatrix3(normalMatrix).normalize();
        out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
      }
      primitive.attributes.NORMAL = add(out, FLOAT, 'VEC3', count);
    }
    delete primitive.attributes.TANGENT; // would need re-baking; engines regenerate it
    const j16 = new Uint16Array(count * 4);
    const w32 = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      const m = vertexParts.get(pr.offset + i);
      const top = m ? [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4) : [[jointOfPart.get(root), 1]];
      const sum = top.reduce((s, [, c]) => s + c, 0);
      top.forEach(([j, c], k) => { j16[i * 4 + k] = j; w32[i * 4 + k] = c / sum; });
    }
    primitive.attributes.JOINTS_0 = add(j16, USHORT, 'VEC4', count);
    primitive.attributes.WEIGHTS_0 = add(w32, FLOAT, 'VEC4', count);
    // Lift the mesh node to the scene root with an identity transform.
    const node = json.nodes[pr.nodeIndex];
    delete node.matrix; delete node.translation; delete node.rotation; delete node.scale;
    node.skin = skinIndex;
    for (const other of json.nodes) if (other.children) other.children = other.children.filter(c => c !== pr.nodeIndex);
    if (!sceneRoots.includes(pr.nodeIndex)) sceneRoots.push(pr.nodeIndex);
  }
  sceneRoots.push(armature);
  const out = Buffer.concat(binParts);
  json.buffers[0].byteLength = out.length;
  return {
    buffer: serializeGlb(json, out),
    joints: order.map(id => ({ part: id, name: partName(id), parent: parts[id].parent >= 0 ? partName(parts[id].parent) : null, floating: Boolean(parts[id].floating) }))
  };
}

function minMax(p, offset, count) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = offset; i < offset + count; i += 1) for (let c = 0; c < 3; c += 1) { min[c] = Math.min(min[c], p[i * 3 + c]); max[c] = Math.max(max[c], p[i * 3 + c]); }
  return { min, max };
}

/** Part summary for the agent: id, parent, size share, where it sits. */
export function describePlan(plan) {
  const total = plan.totalArea || 1;
  return plan.parts.map(part => ({
    part: part.id,
    parent: part.parent,
    share: Math.round((part.area / total) * 1000) / 1000,
    centroid: part.centroid.toArray().map(v => Math.round(v * 1000) / 1000),
    pivot: part.pivot.toArray().map(v => Math.round(v * 1000) / 1000),
    ...(part.floating ? { floating: true } : {})
  }));
}
