// Server-side rig transfer for GLB meshes: put one mesh's skeleton, skin weights
// and animations onto another.
//
// The Mesh Editor does this in the browser (src/utils/rigTransfer.js), where
// three.js has both files parsed and a BVH to sample with. That path is
// browser-only, so headless callers — the MCP `transfer_rig` tool — need an
// equivalent that works on stored files. Same reason move_mesh_pivot has
// meshPivot.js, and this follows its design exactly.
//
// ---- Why it edits glTF rather than loading the scene ------------------------
//
// Two independent reasons, and either alone would decide it:
//
//   * GLTFLoader does not run in Node. It reaches for `self` while choosing an
//     image loader and dies with "self is not defined" on any file carrying a
//     texture — which is every textured asset in the library.
//   * Even with that shimmed, re-exporting through GLTFExporter would re-encode
//     the target's images through a canvas that Node does not have, and would
//     rewrite every material, accessor and extension in the file. The point of
//     this operation is to ADD a rig to a mesh, not to launder it.
//
// So the target's bytes are preserved: this appends bone nodes, a skin, and two
// vertex attributes, and leaves materials, images, UVs and every other accessor
// exactly as they were. Same principle meshPivot.js states in its own header.
//
// ---- What it shares with the browser ----------------------------------------
//
// The weight maths — closest point, barycentric blend, weld-group unification,
// smoothing — is `skinTransfer.js` at the repo root, the same module the editor
// and the assembly feature use. Only the reading and writing of the container
// differ, which is the part that has to differ.
import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { parseGlb, serializeGlb } from './meshPivot.js';
import { transferSkinFromBase, validateSkin, MAX_INFLUENCES } from './skinTransfer.js';

// three-mesh-bvh is a prototype patch, applied on first use rather than at
// import time so simply importing this module changes nothing globally.
function ensureBvh() {
  if (THREE.BufferGeometry.prototype.computeBoundsTree !== computeBoundsTree) {
    THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
    THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  }
}

// Sampling further than this fraction of the mesh's diagonal means the two
// surfaces are not really the same shape there. Reported, not refused — a cage
// legitimately stands off the surface it was built around.
const FAR_SAMPLE = 0.05;
// Below this worst-axis box overlap the two meshes are not in the same space,
// and sampling across the gap does not fail — it returns a rig that binds every
// vertex to whatever bone happens to face it. Matches BAKE_OVERLAP_BROKEN.
const MIN_OVERLAP = 0.5;
// Per-axis extent agreement, as a fraction of the target's diagonal, within
// which two boxes count as the same object at the same scale.
const SCALE_TOLERANCE = 0.05;

const COMPONENT_READERS = {
  5120: (view, offset) => view.getInt8(offset),
  5121: (view, offset) => view.getUint8(offset),
  5122: (view, offset) => view.getInt16(offset, true),
  5123: (view, offset) => view.getUint16(offset, true),
  5125: (view, offset) => view.getUint32(offset, true),
  5126: (view, offset) => view.getFloat32(offset, true)
};
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// --- reading ---------------------------------------------------------------

// Decode one accessor into a flat Float64Array of `count * components` values.
//
// Sparse accessors are refused rather than half-read: they are rare in the
// files this handles, and quietly returning the base values would produce a rig
// sampled against the wrong surface, which is not a failure anyone would catch.
function readAccessor(json, bin, index) {
  const accessor = (json.accessors || [])[index];
  if (!accessor) throw new Error(`The file references accessor ${index}, which it does not contain.`);
  if (accessor.sparse) throw new Error('This mesh uses sparse accessors, which the rig transfer cannot read.');

  const components = TYPE_COMPONENTS[accessor.type];
  const read = COMPONENT_READERS[accessor.componentType];
  const size = COMPONENT_BYTES[accessor.componentType];
  if (!components || !read) {
    throw new Error(`Unsupported accessor format (${accessor.type}/${accessor.componentType}).`);
  }

  const out = new Float64Array(accessor.count * components);
  // No bufferView means "all zeroes" per spec — legal, and the zeroes are the
  // answer rather than an error.
  if (accessor.bufferView === undefined) return { values: out, components, accessor };

  const view = (json.bufferViews || [])[accessor.bufferView];
  if (!view) throw new Error('The file references a buffer view it does not contain.');
  if (!bin) throw new Error('This GLB has no binary chunk, so its vertex data cannot be read.');

  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || components * size;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  const end = base + (accessor.count - 1) * stride + components * size;
  if (end > bin.byteLength) throw new Error('An accessor reaches past the end of the binary chunk.');

  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      out[i * components + c] = read(data, base + i * stride + c * size);
    }
  }

  // Normalised integers carry a 0..1 value — weights are routinely stored this
  // way, and reading them raw would produce weights in the hundreds.
  if (accessor.normalized && COMPONENT_MAX[accessor.componentType]) {
    const max = COMPONENT_MAX[accessor.componentType];
    for (let i = 0; i < out.length; i += 1) out[i] /= max;
  }
  return { values: out, components, accessor };
}

// Every node's world matrix, by node index, walking the file's scene.
//
// Nodes outside the scene graph get identity: they are not rendered, and giving
// them a parent's transform would be inventing one.
function nodeWorldMatrices(json) {
  const nodes = json.nodes || [];
  const world = new Array(nodes.length).fill(null);
  const scene = (json.scenes || [])[json.scene ?? 0];
  const roots = Array.isArray(scene?.nodes) ? scene.nodes : [];

  const local = (node) => {
    if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
      return new THREE.Matrix4().fromArray(node.matrix);
    }
    return new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(node?.translation || [0, 0, 0]),
      new THREE.Quaternion().fromArray(node?.rotation || [0, 0, 0, 1]),
      new THREE.Vector3().fromArray(node?.scale || [1, 1, 1])
    );
  };

  const walk = (index, parent) => {
    const node = nodes[index];
    if (!node || world[index]) return;
    const matrix = parent.clone().multiply(local(node));
    world[index] = matrix;
    for (const child of node.children || []) walk(child, matrix);
  };

  const identity = new THREE.Matrix4();
  for (const root of roots) walk(root, identity);
  for (let i = 0; i < nodes.length; i += 1) if (!world[i]) world[i] = new THREE.Matrix4();
  return world;
}

// Every drawn primitive in the file, with its vertices in WORLD space.
//
// Skinned primitives are read with NO node transform, which is not an oversight:
// per spec a skinned mesh node's own transform is ignored, and at bind pose the
// joint matrices cancel against the inverse bind matrices — so the accessor data
// already is the rest-pose world position. meshPivot.js measures bounds on the
// same rule, and three.js bakes the same values through `matrixWorld` in the
// editor, which is what makes the browser and this agree.
function collectPrimitives(json, bin) {
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const world = nodeWorldMatrices(json);
  const out = [];

  nodes.forEach((node, nodeIndex) => {
    if (node?.mesh === undefined) return;
    const mesh = meshes[node.mesh];
    if (!mesh) return;
    const skinned = node.skin !== undefined;

    (mesh.primitives || []).forEach((primitive, primitiveIndex) => {
      // Only triangles. A points or lines primitive has no surface to sample.
      if (primitive.mode !== undefined && primitive.mode !== 4) return;
      if (primitive.attributes?.POSITION === undefined) return;

      const { values: raw, accessor } = readAccessor(json, bin, primitive.attributes.POSITION);
      const count = accessor.count;
      const positions = new Float32Array(count * 3);
      if (skinned) {
        positions.set(raw.subarray(0, count * 3));
      } else {
        const point = new THREE.Vector3();
        const matrix = world[nodeIndex];
        for (let i = 0; i < count; i += 1) {
          point.set(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]).applyMatrix4(matrix);
          positions[i * 3] = point.x;
          positions[i * 3 + 1] = point.y;
          positions[i * 3 + 2] = point.z;
        }
      }

      let indices;
      if (primitive.indices !== undefined) {
        const read = readAccessor(json, bin, primitive.indices);
        indices = new Uint32Array(read.values);
      } else {
        indices = new Uint32Array(count);
        for (let i = 0; i < count; i += 1) indices[i] = i;
      }

      out.push({
        nodeIndex, meshIndex: node.mesh, primitiveIndex, primitive, skinned, count, positions, indices
      });
    });
  });

  return out;
}

// --- the source's skinning --------------------------------------------------

// The bone names of a skin, in the order its JOINTS_0 indices address.
function skinBoneNames(json, skin) {
  const nodes = json.nodes || [];
  return (skin.joints || []).map((index, i) => nodes[index]?.name || `joint_${i}`);
}

/**
 * The source's skinned surface, merged and ready to sample.
 *
 * Every skinned primitive is merged into one geometry with a BVH over it, and
 * its JOINTS_0 remapped into the chosen skin's joint order BY NAME — a body +
 * head + eyes export can carry several skins, and merging their raw indices
 * would bind the head to the leg bones. A primitive referencing a bone that is
 * not in the chosen skin is skipped whole rather than have those influences
 * dropped: dropping them leaves vertices with an all-zero weight set, which
 * reads downstream as "bound to bone 0" and pins that patch to the root.
 */
function buildSourceSampler(json, bin, skinIndex, offset) {
  const skin = (json.skins || [])[skinIndex];
  const names = skinBoneNames(json, skin);
  const boneIndex = new Map();
  names.forEach((name, i) => { if (!boneIndex.has(name)) boneIndex.set(name, i); });

  const positions = [];
  const indices = [];
  const joints = [];
  const weights = [];
  const skipped = [];
  let vertexBase = 0;

  for (const prim of collectPrimitives(json, bin)) {
    if (!prim.skinned) continue;
    const attributes = prim.primitive.attributes;
    if (attributes.JOINTS_0 === undefined || attributes.WEIGHTS_0 === undefined) continue;

    const nodeSkin = (json.skins || [])[(json.nodes || [])[prim.nodeIndex].skin];
    const primNames = skinBoneNames(json, nodeSkin);
    const remap = primNames.map(name => (boneIndex.has(name) ? boneIndex.get(name) : -1));

    const j = readAccessor(json, bin, attributes.JOINTS_0).values;
    const w = readAccessor(json, bin, attributes.WEIGHTS_0).values;

    // Only bones this primitive actually leans on have to be mappable.
    let unmappable = 0;
    for (let i = 0; i < prim.count * 4; i += 1) {
      if (w[i] > 0 && remap[j[i]] === undefined) unmappable += 1;
      else if (w[i] > 0 && remap[j[i]] < 0) unmappable += 1;
    }
    if (unmappable) {
      skipped.push((json.meshes || [])[prim.meshIndex]?.name || `mesh ${prim.meshIndex}`);
      continue;
    }

    for (let i = 0; i < prim.count; i += 1) {
      positions.push(
        prim.positions[i * 3] + offset.x,
        prim.positions[i * 3 + 1] + offset.y,
        prim.positions[i * 3 + 2] + offset.z
      );
      for (let s = 0; s < 4; s += 1) {
        joints.push(Math.max(0, remap[j[i * 4 + s]] ?? 0));
        weights.push(w[i * 4 + s]);
      }
    }
    for (let i = 0; i < prim.indices.length; i += 1) indices.push(prim.indices[i] + vertexBase);
    vertexBase += prim.count;
  }

  if (!indices.length) return null;

  ensureBvh();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(indices), 1));
  geometry.computeBoundsTree();

  return {
    geometry,
    skinIndex: new Uint16Array(joints),
    skinWeight: new Float32Array(weights),
    boneNames: names,
    skipped,
    dispose() {
      geometry.disposeBoundsTree?.();
      geometry.dispose();
    }
  };
}

// --- alignment --------------------------------------------------------------

function boxOf(primitives) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const prim of primitives) {
    for (let i = 0; i < prim.count; i += 1) {
      box.expandByPoint(point.set(prim.positions[i * 3], prim.positions[i * 3 + 1], prim.positions[i * 3 + 2]));
    }
  }
  return box;
}

/**
 * Can this source be sampled onto this target, and how far must it move first?
 *
 * The transfer is purely positional, so two meshes in different spaces produce a
 * rig that is not slightly wrong but meaningless. Reported as the WORST axis
 * rather than a volume ratio, because the volume ratio hides exactly this: a
 * source offset along one axis still overlaps perfectly on the other two.
 *
 * A source that only needs re-centring is re-centred; at a different scale that
 * is refused rather than guessed at, because re-centring boxes of different
 * sizes leaves the surfaces crossing each other.
 */
function planAlignment(targetBox, sourceBox) {
  if (targetBox.isEmpty() || sourceBox.isEmpty()) {
    return { offset: new THREE.Vector3(), recentred: false, refuse: null, warn: null, diagonal: 0 };
  }
  const targetSize = targetBox.getSize(new THREE.Vector3());
  const sourceSize = sourceBox.getSize(new THREE.Vector3());
  const diagonal = targetSize.length();
  const scale = Math.max(targetSize.x, targetSize.y, targetSize.z);
  const axes = ['x', 'y', 'z'];

  const worstAxis = (shift) => axes.reduce((worst, axis) => {
    const extent = targetSize[axis];
    if (extent <= scale * 1e-4) return worst;      // a flat axis is not a miss
    const span = Math.min(targetBox.max[axis], sourceBox.max[axis] + shift[axis])
      - Math.max(targetBox.min[axis], sourceBox.min[axis] + shift[axis]);
    return Math.min(worst, Math.max(span, 0) / extent);
  }, 1);

  const zero = new THREE.Vector3();
  const shift = targetBox.getCenter(new THREE.Vector3()).sub(sourceBox.getCenter(new THREE.Vector3()));
  const sameScale = axes.every(axis =>
    Math.abs(targetSize[axis] - sourceSize[axis]) <= SCALE_TOLERANCE * Math.max(diagonal, 1e-9));

  // A size mismatch that still overlaps is not refused — one box inside the
  // other overlaps perfectly on every axis, so the measure cannot see it — but
  // it is worth saying, because the weights then come from the wrong part of
  // the source.
  const warn = sameScale ? null
    : `The source mesh is ${(sourceSize.length() / Math.max(diagonal, 1e-9)).toFixed(2)}x the size of the target. `
      + 'The weights were sampled anyway, but check the result: they come from the wrong part of the source '
      + 'unless the two are exported at the same scale.';

  if (worstAxis(zero) >= MIN_OVERLAP) {
    return { offset: zero, recentred: false, refuse: null, warn, diagonal };
  }
  if (!sameScale) {
    return {
      offset: zero, recentred: false, warn, diagonal,
      refuse: 'The two meshes are different sizes and sit apart, so the weights cannot be sampled across them. '
        + 'Export both at the same scale and try again.'
    };
  }
  if (worstAxis(shift) < MIN_OVERLAP) {
    return {
      offset: zero, recentred: false, warn, diagonal,
      refuse: 'The two meshes barely overlap, so there is no source surface under most of the target. '
        + 'They have to be in the same space — an earlier version of the same mesh usually is.'
    };
  }
  return { offset: shift, recentred: true, refuse: null, warn, diagonal };
}

// --- writing ----------------------------------------------------------------

function addAccessor(json, bufferView, componentType, type, count, extras = {}) {
  json.accessors = json.accessors || [];
  json.accessors.push({ bufferView, componentType, count, type, ...extras });
  return json.accessors.length - 1;
}

/**
 * Copy the source's bone hierarchy into the target's node list.
 *
 * Indices are remapped as they are copied — the two files number their nodes
 * independently, so a bone's `children` mean nothing until they are rewritten.
 * Only nodes reachable from the skin's joints (plus their common ancestors) come
 * across: a source file's meshes, cameras and lights are not part of its rig.
 */
function copySkeleton(sourceJson, targetJson, skin) {
  const sourceNodes = sourceJson.nodes || [];
  const wanted = new Set();
  const parentOf = new Map();
  sourceNodes.forEach((node, index) => {
    for (const child of node.children || []) parentOf.set(child, index);
  });

  // The joints, and every ancestor up to the root — a joint whose parent is
  // missing would lose the transform that places it.
  for (const joint of skin.joints || []) {
    let cursor = joint;
    while (cursor !== undefined && !wanted.has(cursor)) {
      wanted.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  if (skin.skeleton !== undefined) {
    let cursor = skin.skeleton;
    while (cursor !== undefined && !wanted.has(cursor)) {
      wanted.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  targetJson.nodes = targetJson.nodes || [];
  const remap = new Map();
  for (const index of wanted) {
    const source = sourceNodes[index];
    const copy = {};
    // Transforms and identity only. A copied `mesh`/`skin`/`camera` would point
    // at the SOURCE file's arrays, which do not exist here.
    if (source.name !== undefined) copy.name = source.name;
    if (source.matrix !== undefined) copy.matrix = source.matrix.slice();
    if (source.translation !== undefined) copy.translation = source.translation.slice();
    if (source.rotation !== undefined) copy.rotation = source.rotation.slice();
    if (source.scale !== undefined) copy.scale = source.scale.slice();
    targetJson.nodes.push(copy);
    remap.set(index, targetJson.nodes.length - 1);
  }
  for (const index of wanted) {
    const children = (sourceNodes[index].children || []).filter(child => wanted.has(child));
    if (children.length) targetJson.nodes[remap.get(index)].children = children.map(child => remap.get(child));
  }

  const roots = [...wanted].filter(index => !wanted.has(parentOf.get(index)));
  return { remap, roots: roots.map(index => remap.get(index)) };
}

// --- the operation -----------------------------------------------------------

/**
 * Put the rig from `sourceBuffer` onto the mesh in `targetBuffer`.
 *
 * Returns `{ buffer, stats }`. The target's materials, images, UVs and every
 * other accessor are carried through untouched; what is added is the bone
 * nodes, a skin, and JOINTS_0/WEIGHTS_0 on each of its primitives.
 */
export function transferRig(sourceBuffer, targetBuffer, { smoothIters = 2 } = {}) {
  const source = parseGlb(sourceBuffer);
  const target = parseGlb(targetBuffer);

  const skins = source.json.skins || [];
  if (!skins.length) {
    throw new Error('The source mesh has no skeleton, so there is no rig to transfer. Pick a rigged mesh.');
  }
  // The first skin with joints is the rig — the same choice the editor makes
  // when it takes the first SkinnedMesh it finds.
  const skinIndex = skins.findIndex(skin => (skin.joints || []).length);
  if (skinIndex < 0) throw new Error('The source mesh has a skin with no joints in it.');
  const skin = skins[skinIndex];

  const targetPrimitives = collectPrimitives(target.json, target.bin);
  if (!targetPrimitives.length) throw new Error('The target mesh has no triangles to weight.');
  if (targetPrimitives.some(prim => prim.skinned)) {
    throw new Error('The target mesh is already rigged. Transferring onto it would leave two skeletons — remove the existing rig first.');
  }

  const sourcePrimitives = collectPrimitives(source.json, source.bin).filter(prim => prim.skinned);
  if (!sourcePrimitives.length) {
    throw new Error('The source mesh has a skeleton but no skinned geometry, so there is nothing to sample.');
  }

  const plan = planAlignment(boxOf(targetPrimitives), boxOf(sourcePrimitives));
  if (plan.refuse) throw new Error(plan.refuse);

  const sampler = buildSourceSampler(source.json, source.bin, skinIndex, plan.offset);
  if (!sampler) throw new Error('The source mesh could not be prepared for sampling.');

  const stats = {
    bones: (skin.joints || []).length,
    vertices: 0,
    missed: 0,
    farthest: 0,
    primitives: targetPrimitives.length,
    recentred: plan.recentred ? plan.offset.length() : 0,
    skippedSourceParts: sampler.skipped,
    warning: plan.warn
  };

  // Weights are computed per primitive, because that is the unit a glTF
  // attribute is attached to — a merged geometry would have to be split again
  // and the vertex order is only guaranteed within one primitive.
  const written = [];
  try {
    for (const prim of targetPrimitives) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(prim.positions, 3));
      geometry.setIndex(new THREE.Uint32BufferAttribute(prim.indices, 1));

      const result = transferSkinFromBase(sampler, geometry, prim.positions, {
        smoothIters,
        maxInfluences: MAX_INFLUENCES,
        maxDistance: plan.diagonal ? plan.diagonal * FAR_SAMPLE : null
      });
      if (!result) throw new Error('The weight transfer produced nothing.');

      const invalid = validateSkin(geometry, stats.bones);
      if (invalid) throw new Error(`The transferred rig ${invalid} — the mesh was left as it was.`);

      stats.vertices += result.vertices;
      stats.missed += result.missed;
      stats.farthest = Math.max(stats.farthest, result.farthest);
      written.push({ prim, geometry });
    }
  } finally {
    sampler.dispose();
  }

  // Nothing is written to the file until every primitive has succeeded, so a
  // failure half way through cannot leave a half-rigged mesh.
  let cursor = target.bin?.length || 0;
  const parts = target.bin?.length ? [target.bin] : [];
  // glTF requires 4-byte alignment for accessor data, and a view that starts
  // unaligned is the kind of file that loads in one engine and not the next.
  const push = (bytes) => {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); cursor += pad; }
    const offset = cursor;
    parts.push(bytes);
    cursor += bytes.length;
    return offset;
  };

  target.json.bufferViews = target.json.bufferViews || [];
  target.json.accessors = target.json.accessors || [];

  const addView = (bytes, viewTarget) => {
    const byteOffset = push(bytes);
    const view = { buffer: 0, byteOffset, byteLength: bytes.length };
    if (viewTarget !== undefined) view.target = viewTarget;
    target.json.bufferViews.push(view);
    return target.json.bufferViews.length - 1;
  };

  for (const { prim, geometry } of written) {
    const joints = geometry.getAttribute('skinIndex');
    const weights = geometry.getAttribute('skinWeight');

    const jointBytes = Buffer.alloc(prim.count * 4 * 2);
    const weightBytes = Buffer.alloc(prim.count * 4 * 4);
    for (let i = 0; i < prim.count; i += 1) {
      for (let s = 0; s < 4; s += 1) {
        jointBytes.writeUInt16LE(joints.getComponent(i, s), (i * 4 + s) * 2);
        weightBytes.writeFloatLE(weights.getComponent(i, s), (i * 4 + s) * 4);
      }
    }

    // 34962 = ARRAY_BUFFER: these are vertex attributes, and a loader is
    // entitled to trust the hint.
    const jointsAccessor = addAccessor(
      target.json, addView(jointBytes, 34962), 5123, 'VEC4', prim.count);
    const weightsAccessor = addAccessor(
      target.json, addView(weightBytes, 34962), 5126, 'VEC4', prim.count);

    const primitive = target.json.meshes[prim.meshIndex].primitives[prim.primitiveIndex];
    primitive.attributes.JOINTS_0 = jointsAccessor;
    primitive.attributes.WEIGHTS_0 = weightsAccessor;
    geometry.dispose();
  }

  // The skeleton, and the bind matrices that go with it.
  const { remap, roots } = copySkeleton(source.json, target.json, skin);
  const joints = (skin.joints || []).map(index => remap.get(index)).filter(index => index !== undefined);
  if (joints.length !== (skin.joints || []).length) {
    throw new Error('The source skeleton is missing joints its own skin references.');
  }

  const bindBytes = Buffer.alloc(joints.length * 16 * 4);
  if (skin.inverseBindMatrices !== undefined) {
    const read = readAccessor(source.json, source.bin, skin.inverseBindMatrices).values;
    // Re-centring moved the bones, so the bind matrices — which map a vertex
    // INTO each bone's space — have to make the same move, or the mesh snaps
    // back to where the source stood the moment it is posed.
    const matrix = new THREE.Matrix4();
    const shift = new THREE.Matrix4().makeTranslation(-plan.offset.x, -plan.offset.y, -plan.offset.z);
    for (let i = 0; i < joints.length; i += 1) {
      matrix.fromArray(read, i * 16);
      if (plan.recentred) matrix.multiply(shift);
      matrix.toArray().forEach((value, k) => bindBytes.writeFloatLE(value, (i * 16 + k) * 4));
    }
  } else {
    // Absent means identity per spec.
    for (let i = 0; i < joints.length; i += 1) {
      new THREE.Matrix4().toArray().forEach((value, k) => bindBytes.writeFloatLE(value, (i * 16 + k) * 4));
    }
  }
  const bindAccessor = addAccessor(target.json, addView(bindBytes), 5126, 'MAT4', joints.length);

  target.json.skins = target.json.skins || [];
  const newSkin = { joints, inverseBindMatrices: bindAccessor };
  if (skin.name) newSkin.name = skin.name;
  if (skin.skeleton !== undefined && remap.has(skin.skeleton)) newSkin.skeleton = remap.get(skin.skeleton);
  target.json.skins.push(newSkin);
  const newSkinIndex = target.json.skins.length - 1;

  // Attach: every node that draws one of the weighted meshes becomes skinned,
  // and the bone roots join the scene so they are actually part of the graph.
  const meshNodes = new Set(written.map(entry => entry.prim.nodeIndex));
  for (const nodeIndex of meshNodes) target.json.nodes[nodeIndex].skin = newSkinIndex;

  const scene = (target.json.scenes || [])[target.json.scene ?? 0];
  if (!scene) throw new Error('The target GLB has no scene to attach the skeleton to.');
  scene.nodes = [...(scene.nodes || []), ...roots];

  target.json.buffers = target.json.buffers || [{}];
  const bin = Buffer.concat(parts);
  target.json.buffers[0] = { ...target.json.buffers[0], byteLength: bin.length };
  delete target.json.buffers[0].uri;

  stats.farthestFraction = plan.diagonal ? stats.farthest / plan.diagonal : 0;
  stats.farSample = stats.farthestFraction > FAR_SAMPLE;
  stats.boneNames = sampler.boneNames;

  return { buffer: serializeGlb(target.json, bin), stats };
}
