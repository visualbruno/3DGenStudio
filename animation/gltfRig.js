// Read a rigged GLB into something that can be posed, measured and drawn in
// plain Node - the foundation every "Animate with AI" tool stands on.
//
// WHY NOT GLTFLoader. Same two reasons meshRigTransfer.js gives: the loader
// reaches for `self` on any textured file and dies in Node, and nothing here
// needs materials or images anyway. What an animator needs is the node tree,
// the skin (joints + inverse bind matrices) and the skinned vertices, and all
// three are plain accessors.
//
// WHAT "REST" MEANS HERE. The rest pose is the node transforms as stored in the
// file, not the skin's bind pose. The animation channels we write drive node
// TRS, so the node transforms are the only rest pose in the same frame as the
// animation (the FBX-import lesson in customAnimations: `skeleton.pose()` can
// land in a different WORLD). For the files this app makes the two coincide.
//
// SKINNED VERTICES are read without the mesh node's transform: per the glTF
// spec a skinned mesh node's own transform is ignored and the vertex is placed
// by `sum(w * jointWorld * inverseBind) * v`. Unskinned meshes that hang under
// a bone (eyes, armour plates, a robot's rigid parts) are carried as RIGID
// parts of that bone, so they move with it in the preview.
import * as THREE from 'three';
import { parseGlb } from '../meshPivot.js';
import { readAccessor } from '../meshRigTransfer.js';

const MAX_PREVIEW_TRIANGLES = 400000;

function localMatrixOf(node) {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    return new THREE.Matrix4().fromArray(node.matrix);
  }
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(node?.translation || [0, 0, 0]),
    new THREE.Quaternion().fromArray(node?.rotation || [0, 0, 0, 1]),
    new THREE.Vector3().fromArray(node?.scale || [1, 1, 1])
  );
}

function localTrsOf(node) {
  const t = new THREE.Vector3();
  const r = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    new THREE.Matrix4().fromArray(node.matrix).decompose(t, r, s);
  } else {
    if (node?.translation) t.fromArray(node.translation);
    if (node?.rotation) r.fromArray(node.rotation).normalize();
    if (node?.scale) s.fromArray(node.scale);
  }
  return { t, r, s };
}

/**
 * Parse a GLB buffer into a rig.
 *
 * Returns {
 *   json, bin,
 *   nodes: [{ name, parent, children, rest: {t,r,s}, isJoint, joint }],
 *   roots: scene root node indices,
 *   joints: [{ index (skin order), node, name, parent (joint index | -1), children }],
 *   jointRoots: joint indices with no joint parent,
 *   inverseBind: Matrix4[] in skin order,
 *   geometry: { positions, joints, weights, indices, vertexCount, triangleCount, rigid },
 *   skinIndex
 * }
 *
 * Throws with a caller-actionable message when the file carries no skeleton.
 */
export function loadRig(buffer) {
  const { json, bin } = parseGlb(buffer);
  const skins = json.skins || [];
  const skinIndex = skins.findIndex(skin => (skin.joints || []).length);
  if (skinIndex < 0) {
    throw new Error('This mesh has no skeleton. Rig it first (auto_rig_mesh, or transfer_rig from a rigged version of the same character).');
  }
  const skin = skins[skinIndex];

  const rawNodes = json.nodes || [];
  const nodes = rawNodes.map((node, index) => ({
    index,
    name: node?.name || `node_${index}`,
    parent: -1,
    children: Array.isArray(node?.children) ? node.children.slice() : [],
    rest: localTrsOf(node),
    isJoint: false,
    joint: -1
  }));
  nodes.forEach((node) => {
    for (const child of node.children) if (nodes[child]) nodes[child].parent = node.index;
  });

  const scene = (json.scenes || [])[json.scene ?? 0];
  const roots = Array.isArray(scene?.nodes) ? scene.nodes.slice() : nodes.filter(n => n.parent < 0).map(n => n.index);

  // Joints in SKIN order - that is what JOINTS_0 addresses and what the
  // inverse bind matrices line up with.
  const jointNodes = skin.joints.slice();
  jointNodes.forEach((nodeIndex, j) => {
    if (!nodes[nodeIndex]) throw new Error(`The skin references node ${nodeIndex}, which the file does not contain.`);
    nodes[nodeIndex].isJoint = true;
    nodes[nodeIndex].joint = j;
  });

  // Bone names must be unique for tracks and for the AI to address them. A
  // duplicate gets a numeric suffix in OUR view only - the file keeps its names.
  const seen = new Map();
  const joints = jointNodes.map((nodeIndex, j) => {
    let name = nodes[nodeIndex].name;
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      name = `${name}#${n}`;
    } else {
      seen.set(name, 0);
    }
    return { index: j, node: nodeIndex, name, parent: -1, children: [] };
  });
  for (const joint of joints) {
    let cursor = nodes[joint.node].parent;
    while (cursor >= 0 && !nodes[cursor].isJoint) cursor = nodes[cursor].parent;
    joint.parent = cursor >= 0 ? nodes[cursor].joint : -1;
    if (joint.parent >= 0) joints[joint.parent].children.push(joint.index);
  }
  const jointRoots = joints.filter(j => j.parent < 0).map(j => j.index);

  const inverseBind = jointNodes.map(() => new THREE.Matrix4());
  if (skin.inverseBindMatrices !== undefined) {
    const { values } = readAccessor(json, bin, skin.inverseBindMatrices);
    for (let j = 0; j < jointNodes.length; j += 1) {
      inverseBind[j].fromArray(Array.from(values.subarray(j * 16, j * 16 + 16)));
    }
  }

  const rig = {
    json, bin, nodes, roots, joints, jointRoots, inverseBind, skinIndex,
    jointByName: new Map(joints.map(j => [j.name, j.index]))
  };
  rig.geometry = collectGeometry(rig);
  return rig;
}

// Merge every drawable triangle primitive into one vertex soup carrying
// up-to-four joint influences. Skinned primitives of OTHER skins are remapped
// by joint name (a body + eyes export can carry several); a rigid mesh under a
// bone gets weight 1 on that bone; anything else is static (joint -1).
function collectGeometry(rig) {
  const { json, bin, nodes } = rig;
  const meshes = json.meshes || [];
  const skins = json.skins || [];
  const restWorld = computeNodeWorlds(rig, null);

  const parts = [];
  let vertexCount = 0;
  let triangleCount = 0;
  let skippedPrimitives = 0;

  (json.nodes || []).forEach((rawNode, nodeIndex) => {
    if (rawNode?.mesh === undefined) return;
    const mesh = meshes[rawNode.mesh];
    if (!mesh) return;

    let remap = null;
    let rigidJoint = -1;
    const skinned = rawNode.skin !== undefined;
    if (skinned) {
      const nodeSkin = skins[rawNode.skin];
      if (!nodeSkin) return;
      if (rawNode.skin !== rig.skinIndex) {
        remap = (nodeSkin.joints || []).map(n => rig.jointByName.get(nodes[n]?.name) ?? -1);
        if (remap.some(j => j < 0)) { skippedPrimitives += (mesh.primitives || []).length; return; }
      }
    } else {
      let cursor = nodes[nodeIndex].parent;
      while (cursor >= 0 && !nodes[cursor].isJoint) cursor = nodes[cursor].parent;
      rigidJoint = cursor >= 0 ? nodes[cursor].joint : -1;
    }

    for (const primitive of mesh.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.attributes?.POSITION === undefined) continue;
      const pos = readAccessor(json, bin, primitive.attributes.POSITION);
      const count = pos.accessor.count;
      const positions = new Float32Array(count * 3);
      if (skinned) {
        positions.set(pos.values.subarray(0, count * 3));
      } else {
        const m = restWorld[nodeIndex];
        const v = new THREE.Vector3();
        for (let i = 0; i < count; i += 1) {
          v.set(pos.values[i * 3], pos.values[i * 3 + 1], pos.values[i * 3 + 2]).applyMatrix4(m);
          positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
        }
      }

      const jointsOut = new Int16Array(count * 4).fill(-1);
      const weightsOut = new Float32Array(count * 4);
      if (skinned && primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined) {
        const jr = readAccessor(json, bin, primitive.attributes.JOINTS_0).values;
        const wr = readAccessor(json, bin, primitive.attributes.WEIGHTS_0).values;
        for (let i = 0; i < count * 4; i += 1) {
          const w = wr[i];
          if (!(w > 0)) continue;
          const j = remap ? remap[jr[i]] : jr[i];
          if (j === undefined || j < 0 || j >= rig.joints.length) continue;
          jointsOut[i] = j;
          weightsOut[i] = w;
        }
      } else if (rigidJoint >= 0) {
        for (let i = 0; i < count; i += 1) { jointsOut[i * 4] = rigidJoint; weightsOut[i * 4] = 1; }
      }

      let indices;
      if (primitive.indices !== undefined) {
        indices = Uint32Array.from(readAccessor(json, bin, primitive.indices).values);
      } else {
        indices = new Uint32Array(count);
        for (let i = 0; i < count; i += 1) indices[i] = i;
      }

      parts.push({ positions, joints: jointsOut, weights: weightsOut, indices, skinned, rigid: rigidJoint >= 0 });
      vertexCount += count;
      triangleCount += Math.floor(indices.length / 3);
    }
  });

  const positions = new Float32Array(vertexCount * 3);
  const joints = new Int16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  const indices = new Uint32Array(triangleCount * 3);
  const rigidMask = new Uint8Array(vertexCount);
  let vOff = 0;
  let iOff = 0;
  let rigidParts = 0;
  for (const part of parts) {
    positions.set(part.positions, vOff * 3);
    joints.set(part.joints, vOff * 4);
    weights.set(part.weights, vOff * 4);
    const tris = Math.floor(part.indices.length / 3) * 3;
    for (let i = 0; i < tris; i += 1) indices[iOff + i] = part.indices[i] + vOff;
    if (part.rigid) {
      rigidMask.fill(1, vOff, vOff + part.positions.length / 3);
      rigidParts += 1;
    }
    vOff += part.positions.length / 3;
    iOff += tris;
  }

  return {
    positions, joints, weights, indices, vertexCount, triangleCount, rigidMask,
    rigidParts, skippedPrimitives, previewDecimation: triangleCount > MAX_PREVIEW_TRIANGLES
      ? Math.ceil(triangleCount / MAX_PREVIEW_TRIANGLES) : 1
  };
}

/**
 * World matrices for every node, with optional per-node local overrides.
 *
 * `pose` maps node index -> { t?: Vector3, r?: Quaternion, s?: Vector3 }; a
 * missing component keeps the rest value. Returns Matrix4[] by node index.
 */
export function computeNodeWorlds(rig, pose) {
  const { nodes, roots } = rig;
  const world = new Array(nodes.length).fill(null);
  const scratch = new THREE.Matrix4();
  const walk = (index, parentMatrix) => {
    const node = nodes[index];
    if (!node || world[index]) return;
    const override = pose ? pose.get(index) : null;
    if (override) {
      scratch.compose(override.t || node.rest.t, override.r || node.rest.r, override.s || node.rest.s);
    } else if (Array.isArray(rig.json.nodes[index]?.matrix)) {
      scratch.copy(localMatrixOf(rig.json.nodes[index]));
    } else {
      scratch.compose(node.rest.t, node.rest.r, node.rest.s);
    }
    const m = parentMatrix ? parentMatrix.clone().multiply(scratch) : scratch.clone();
    world[index] = m;
    for (const child of node.children) walk(child, m);
  };
  for (const root of roots) walk(root, null);
  for (let i = 0; i < nodes.length; i += 1) if (!world[i]) walk(i, null);
  return world;
}

/** Rest-pose world matrices and positions of every joint, in skin order. */
export function restJointWorlds(rig) {
  const world = computeNodeWorlds(rig, null);
  return rig.joints.map(j => world[j.node]);
}

/** The world matrix of each joint's PARENT NODE (not parent joint) at rest. */
export function jointParentWorlds(rig, nodeWorlds) {
  return rig.joints.map((j) => {
    const parent = rig.nodes[j.node].parent;
    return parent >= 0 ? nodeWorlds[parent] : new THREE.Matrix4();
  });
}

/**
 * Skin the merged geometry under a pose (node index -> local override map).
 * Returns a Float32Array of world positions. Static vertices (no influence)
 * keep their rest position.
 */
export function skinPositions(rig, pose, out = null) {
  const { geometry, joints, inverseBind } = rig;
  const world = computeNodeWorlds(rig, pose);
  const jointMatrices = joints.map((j, i) => world[j.node].clone().multiply(inverseBind[i]));
  const rigidRest = restJointWorlds(rig);
  const result = out || new Float32Array(geometry.positions.length);
  const src = geometry.positions;
  const jIdx = geometry.joints;
  const wts = geometry.weights;
  // Rigid (unskinned) parts carry rest WORLD positions, so their matrix is
  // posedWorld * restWorld^-1 rather than posedWorld * inverseBind.
  const rigidMatrices = joints.map((j, i) => world[j.node].clone().multiply(rigidRest[i].clone().invert()));
  const e = new Float64Array(16);
  for (let v = 0; v < geometry.vertexCount; v += 1) {
    const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
    let total = 0;
    e.fill(0);
    for (let k = 0; k < 4; k += 1) {
      const j = jIdx[v * 4 + k];
      const w = wts[v * 4 + k];
      if (j < 0 || !(w > 0)) continue;
      total += w;
      const m = (geometry.rigidMask && geometry.rigidMask[v]) ? rigidMatrices[j].elements : jointMatrices[j].elements;
      for (let c = 0; c < 16; c += 1) e[c] += w * m[c];
    }
    if (total <= 0) {
      result[v * 3] = x; result[v * 3 + 1] = y; result[v * 3 + 2] = z;
      continue;
    }
    const inv = 1 / total;
    result[v * 3] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * inv;
    result[v * 3 + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * inv;
    result[v * 3 + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * inv;
  }
  return result;
}
