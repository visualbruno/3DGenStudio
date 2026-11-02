// Server-side pivot placement for GLB meshes.
//
// The Mesh Editor moves a pivot by translating the editable geometry and the
// captured rig together (handleMovePivot in src/pages/MeshEditorPage.jsx). That
// path is browser-only, so headless callers — the MCP `move_mesh_pivot` tool,
// and the Game-Ready check's `expect_ground_pivot` fix — need an equivalent that
// works on stored files.
//
// It deliberately does NOT go through a mesh library. trimesh (the Python
// service) would round-trip the scene and silently drop skins and animations,
// which is exactly what a rigged asset cannot afford. Instead this edits the
// glTF JSON chunk only: the bounds come from the POSITION accessors' mandatory
// min/max, and the move is a single translated wrapper node inserted above the
// scene roots. Vertex data, textures, skins, and animation samplers are copied
// through byte-for-byte.

import { Buffer } from 'buffer';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

// --- tiny column-major mat4 helpers (glTF/OpenGL convention) ---------------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function composeTrs(translation, rotation, scale) {
  const [x, y, z, w] = rotation;
  const [sx, sy, sz] = scale;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    translation[0], translation[1], translation[2], 1
  ];
}

function nodeMatrix(node) {
  if (Array.isArray(node?.matrix) && node.matrix.length === 16) {
    return node.matrix.slice();
  }
  return composeTrs(
    Array.isArray(node?.translation) ? node.translation : [0, 0, 0],
    Array.isArray(node?.rotation) ? node.rotation : [0, 0, 0, 1],
    Array.isArray(node?.scale) ? node.scale : [1, 1, 1]
  );
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

// --- GLB container ---------------------------------------------------------

export function parseGlb(buffer) {
  if (!buffer || buffer.length < 12) {
    throw new Error('Not a GLB file (too short).');
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('Not a binary glTF (.glb) file. Only GLB meshes can have their pivot moved.');
  }

  let json = null;
  let bin = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > buffer.length) break;
    if (chunkType === CHUNK_JSON && json === null) {
      json = JSON.parse(buffer.subarray(start, end).toString('utf8'));
    } else if (chunkType === CHUNK_BIN && bin === null) {
      bin = buffer.subarray(start, end);
    }
    offset = end;
  }

  if (!json) throw new Error('The GLB file has no JSON chunk.');
  return { json, bin };
}

export function serializeGlb(json, bin) {
  // Both chunks are 4-byte aligned: JSON pads with spaces, BIN with zeroes, so
  // the padding stays valid content rather than corrupting the payload.
  const rawJson = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (rawJson.length % 4)) % 4;
  const jsonChunk = Buffer.concat([rawJson, Buffer.alloc(jsonPad, 0x20)]);

  const chunks = [
    Buffer.alloc(8),
    jsonChunk
  ];
  chunks[0].writeUInt32LE(jsonChunk.length, 0);
  chunks[0].writeUInt32LE(CHUNK_JSON, 4);

  if (bin && bin.length) {
    const binPad = (4 - (bin.length % 4)) % 4;
    const binChunk = binPad ? Buffer.concat([bin, Buffer.alloc(binPad, 0)]) : bin;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(binChunk.length, 0);
    header.writeUInt32LE(CHUNK_BIN, 4);
    chunks.push(header, binChunk);
  }

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(GLB_MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(head.length + body.length, 8);
  return Buffer.concat([head, body]);
}

// --- bounds ----------------------------------------------------------------

const PIVOT_NODE_NAME = 'PivotOffset';

// The wrapper this module inserts, if a previous run already added one. It has
// to be recognised rather than blindly re-wrapped: the offset is stored on it
// absolutely, so a second run rewrites that one value instead of stacking a
// second translation on top of the first.
function findPivotWrapper(json) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const scene = (Array.isArray(json.scenes) ? json.scenes : [])[json.scene ?? 0];
  const roots = Array.isArray(scene?.nodes) ? scene.nodes : [];
  if (roots.length !== 1) return null;

  const index = roots[0];
  const node = nodes[index];
  if (!node || node.name !== PIVOT_NODE_NAME) return null;
  // A node carrying anything of its own is somebody else's, whatever it is called.
  if (node.mesh !== undefined || node.skin !== undefined || node.camera !== undefined) return null;
  if (node.matrix || node.rotation || node.scale) return null;

  return { index, node };
}

// Bounding box of the scene's CONTENT, built from the POSITION accessors' min/max
// (mandatory in glTF for POSITION) rather than by decoding vertex data.
//
// Two deliberate exclusions keep this measuring the same thing on every run:
//
// - A pivot wrapper this module added is skipped, so the bounds describe the
//   mesh as authored and the offset below can be computed and stored absolutely.
// - Skinned primitives are measured with no node transform at all. Per spec a
//   skinned mesh node's own transform is ignored, and at bind pose the joint
//   transforms cancel against the inverse bind matrices, so the accessor extents
//   already are the rendered extents. (This is also what the editor measures:
//   three.js bounds a skinned geometry from its raw POSITION array too.)
export function computeSceneBounds(json) {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const meshes = Array.isArray(json.meshes) ? json.meshes : [];
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const scene = (Array.isArray(json.scenes) ? json.scenes : [])[json.scene ?? 0];
  const wrapper = findPivotWrapper(json);
  const sceneRoots = Array.isArray(scene?.nodes) ? scene.nodes : nodes.map((_, index) => index);
  const roots = wrapper ? (wrapper.node.children || []) : sceneRoots;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;

  const expand = (point) => {
    for (let axis = 0; axis < 3; axis += 1) {
      if (point[axis] < min[axis]) min[axis] = point[axis];
      if (point[axis] > max[axis]) max[axis] = point[axis];
    }
    found = true;
  };

  const visited = new Set();
  const walk = (index, parentMatrix) => {
    const node = nodes[index];
    if (!node || visited.has(index)) return;
    visited.add(index);

    const world = multiply(parentMatrix, nodeMatrix(node));

    if (node.mesh !== undefined) {
      const skinned = node.skin !== undefined;
      const local = skinned ? IDENTITY : world;
      for (const primitive of meshes[node.mesh]?.primitives || []) {
        const accessor = accessors[primitive?.attributes?.POSITION];
        const lo = accessor?.min;
        const hi = accessor?.max;
        if (!Array.isArray(lo) || !Array.isArray(hi) || lo.length < 3 || hi.length < 3) continue;
        for (let corner = 0; corner < 8; corner += 1) {
          expand(transformPoint(
            local,
            corner & 1 ? hi[0] : lo[0],
            corner & 2 ? hi[1] : lo[1],
            corner & 4 ? hi[2] : lo[2]
          ));
        }
      }
    }

    for (const child of node.children || []) walk(child, world);
  };

  for (const root of roots) walk(root, IDENTITY);

  return found ? { min, max } : null;
}

// --- pivot -----------------------------------------------------------------

export const PIVOT_MODES = ['ground_pivot', 'centre_pivot'];

// Move a GLB's pivot. 'ground_pivot' drops the mesh onto Y=0 centred on X/Z (a
// prop that snaps to the floor when placed); 'centre_pivot' puts the bounding-box
// centre on the origin (so the asset rotates about itself).
//
// Returns { buffer, moved, offset, bounds, boundsAfter }. `moved` is false when
// the pivot was already in place — the input bytes come back untouched.
export function moveGlbPivot(buffer, mode = 'ground_pivot') {
  if (!PIVOT_MODES.includes(mode)) {
    throw new Error(`Unknown pivot mode "${mode}" (expected ${PIVOT_MODES.join(' or ')}).`);
  }

  const { json, bin } = parseGlb(buffer);
  const bounds = computeSceneBounds(json);
  if (!bounds) {
    throw new Error('The mesh has no positioned geometry, so its bounds could not be measured.');
  }

  const { min, max } = bounds;
  const offset = [
    -(min[0] + max[0]) / 2,
    mode === 'ground_pivot' ? -min[1] : -(min[1] + max[1]) / 2,
    -(min[2] + max[2]) / 2
  ];

  const boundsAfter = {
    min: min.map((value, axis) => value + offset[axis]),
    max: max.map((value, axis) => value + offset[axis])
  };

  // One translated wrapper above the scene roots, rather than editing each root's
  // transform. A root may carry a `matrix` rather than TRS, and any root whose
  // translation an animation drives would fight an edited value — the wrapper is
  // a fresh node no sampler targets, so neither case can bite. A wrapper left by
  // an earlier run is REWRITTEN, never stacked: `bounds` above already excludes
  // it, so `offset` is the absolute value the wrapper should carry.
  const nodes = Array.isArray(json.nodes) ? json.nodes : (json.nodes = []);
  const scenes = Array.isArray(json.scenes) ? json.scenes : (json.scenes = [{ nodes: [] }]);
  const scene = scenes[json.scene ?? 0] || scenes[0];
  const existing = findPivotWrapper(json);

  const EPSILON = 1e-9;
  const current = existing
    ? (Array.isArray(existing.node.translation) ? existing.node.translation : [0, 0, 0])
    : [0, 0, 0];
  if (offset.every((value, axis) => Math.abs(value - current[axis]) < EPSILON)) {
    return { buffer, moved: false, offset: current.slice(), bounds, boundsAfter };
  }

  if (existing) {
    existing.node.translation = offset;
  } else {
    nodes.push({
      name: PIVOT_NODE_NAME,
      translation: offset,
      children: (Array.isArray(scene.nodes) ? scene.nodes : []).slice()
    });
    scene.nodes = [nodes.length - 1];
  }

  return { buffer: serializeGlb(json, bin), moved: true, offset, bounds, boundsAfter };
}
