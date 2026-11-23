// Flatten to one lit albedo, in the backend — the batch twin of
// src/utils/meshFlatten.js (the Export dialog's "Flatten to one lit albedo").
//
// NODE ONLY, like actionRunner.js. The browser version does its two halves on a
// three.js scene: pack one UV atlas across every material before the bake, and
// swap every mesh onto the baked texture after it. A batch runs with no browser,
// so both halves are redone here against the glTF JSON — the way meshPivot.js,
// meshNormals.js and applyBakedMapsToGlb already edit meshes server-side. The
// bake between them is the same /meshes/flatten call the dialog makes.
//
// The rules are the browser's, and are kept in step with it by hand: the same
// "keep a clean layout" test, the same one-island-per-triangle fallback for
// faces with no usable UVs, the same density normalisation, the same packer
// (assemblyAtlas.js, which is pure and imported as it is) and the same material
// per distinct render state. What is different is only what editing glTF
// directly makes possible — nothing is re-encoded, so a rig, its skin weights,
// morph targets and clips come through byte for byte instead of via a three.js
// round trip.
import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { extractIslands, planAtlas } from '../src/utils/assemblyAtlas.js';
import { parseGlb, serializeGlb } from '../meshPivot.js';

// --- kept in step with src/utils/meshFlatten.js ------------------------------

const KEEP_LAYOUT_MAX_WRITES = 1.3;
const UV_RANGE_EPSILON = 1e-3;
const MAX_UNMAPPED_TRIANGLES = 20000;
const DENSITY_CLAMP = 4;
const ATLAS_FILL_TARGET = 0.6;
// Same raster as measureUvHealth in src/utils/meshExport.js.
const HEALTH_GRID = 256;
// mergeVertices' default tolerance, which is how the browser indexes a
// non-indexed primitive before it looks for islands.
const WELD_SHIFT = 1e4;

// --- glTF constants ----------------------------------------------------------

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const COMPONENT_ARRAYS = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
};
const COMPONENT_READERS = {
  5120: (view, offset) => view.getInt8(offset),
  5121: (view, offset) => view.getUint8(offset),
  5122: (view, offset) => view.getInt16(offset, true),
  5123: (view, offset) => view.getUint16(offset, true),
  5125: (view, offset) => view.getUint32(offset, true),
  5126: (view, offset) => view.getFloat32(offset, true)
};
const COMPONENT_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPRESSION_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression'];
// Material and texture extensions describe the materials this replaces, so
// they go with them. Everything else (quantisation, instancing, lights) stays.
const MATERIAL_EXTENSION = /_(materials|texture)_/;

// --- the document --------------------------------------------------------------
//
// The parsed file plus the bytes appended to it. Reads only ever touch the
// original binary chunk; everything written is new bufferViews after it, and
// `compact` drops whatever nothing references any more.

function openDoc(buffer) {
  const { json, bin } = parseGlb(buffer);
  const used = [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])];
  const compressed = used.find(name => COMPRESSION_EXTENSIONS.includes(name));
  if (compressed) {
    throw new Error(`This mesh is compressed with ${compressed}, which the batch flatten cannot read. Flatten it from the Export dialog instead, or save an uncompressed copy first.`);
  }
  if ((json.buffers || []).some(buffer => buffer.uri !== undefined)) {
    throw new Error('This mesh keeps its data in an external file, so it cannot be flattened here.');
  }
  const base = bin ? Buffer.from(bin) : Buffer.alloc(0);
  json.bufferViews = json.bufferViews || [];
  json.accessors = json.accessors || [];
  return { json, bin: base, chunks: [base], length: base.length };
}

function appendBytes(doc, bytes, extras = {}) {
  const pad = (4 - (doc.length % 4)) % 4;
  if (pad) { doc.chunks.push(Buffer.alloc(pad)); doc.length += pad; }
  const byteOffset = doc.length;
  doc.chunks.push(bytes);
  doc.length += bytes.length;
  return doc.json.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, ...extras }) - 1;
}

// Append a typed array as a new accessor. Vertex attributes whose element is not
// a multiple of four bytes get a padded stride, as the spec requires of them.
function addAccessor(doc, array, { componentType, type, normalized = false, min, max, usage = null }) {
  const components = TYPE_COMPONENTS[type];
  const count = array.length / components;
  const elementBytes = components * array.BYTES_PER_ELEMENT;
  let bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const extras = {};
  if (usage === 'vertex') {
    extras.target = ARRAY_BUFFER;
    if (elementBytes % 4) {
      const stride = Math.ceil(elementBytes / 4) * 4;
      const padded = Buffer.alloc(count * stride);
      for (let i = 0; i < count; i += 1) bytes.copy(padded, i * stride, i * elementBytes, (i + 1) * elementBytes);
      bytes = padded;
      extras.byteStride = stride;
    }
  } else if (usage === 'index') {
    extras.target = ELEMENT_ARRAY_BUFFER;
  }
  const bufferView = appendBytes(doc, bytes, extras);
  return doc.json.accessors.push({
    bufferView,
    componentType,
    count,
    type,
    ...(normalized ? { normalized: true } : {}),
    ...(min ? { min } : {}),
    ...(max ? { max } : {})
  }) - 1;
}

// One accessor as a typed array of its own component type, values untouched
// (normalised integers stay integers). Sparse accessors are densified.
// readRaw / readFloat / triangleList / imageBytes are also used by the PBR
// stage (pbr.js); they need only `{ json, bin }` of the doc.
export function readRaw(doc, index) {
  const accessor = doc.json.accessors[index];
  if (!accessor) throw new Error(`The file references accessor ${index}, which it does not contain.`);
  const components = TYPE_COMPONENTS[accessor.type];
  const Ctor = COMPONENT_ARRAYS[accessor.componentType];
  if (!components || !Ctor) throw new Error(`Unsupported accessor format (${accessor.type}/${accessor.componentType}).`);

  const out = new Ctor(accessor.count * components);
  // No bufferView means zeroes, per spec.
  if (accessor.bufferView !== undefined) {
    readView(doc, accessor.bufferView, accessor.byteOffset || 0, accessor.componentType, components, accessor.count, out);
  }
  if (accessor.sparse) {
    const { count, indices, values } = accessor.sparse;
    const at = new (COMPONENT_ARRAYS[indices.componentType])(count);
    readView(doc, indices.bufferView, indices.byteOffset || 0, indices.componentType, 1, count, at);
    const replacement = new Ctor(count * components);
    readView(doc, values.bufferView, values.byteOffset || 0, accessor.componentType, components, count, replacement);
    for (let i = 0; i < count; i += 1) {
      for (let c = 0; c < components; c += 1) out[at[i] * components + c] = replacement[i * components + c];
    }
  }
  return out;
}

function readView(doc, viewIndex, byteOffset, componentType, components, count, out) {
  const view = doc.json.bufferViews[viewIndex];
  if (!view || (view.buffer ?? 0) !== 0) throw new Error('The file references a buffer view it does not contain.');
  const size = COMPONENT_ARRAYS[componentType].BYTES_PER_ELEMENT;
  const base = (view.byteOffset || 0) + byteOffset;
  const stride = view.byteStride || components * size;
  if (count && base + (count - 1) * stride + components * size > doc.bin.length) {
    throw new Error('An accessor reaches past the end of the binary chunk.');
  }
  if (stride === components * size && (doc.bin.byteOffset + base) % size === 0) {
    out.set(new (COMPONENT_ARRAYS[componentType])(doc.bin.buffer, doc.bin.byteOffset + base, count * components));
    return;
  }
  const data = new DataView(doc.bin.buffer, doc.bin.byteOffset, doc.bin.byteLength);
  const read = COMPONENT_READERS[componentType];
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < components; c += 1) out[i * components + c] = read(data, base + i * stride + c * size);
  }
}

// The same accessor as real numbers: normalised integers become -1..1 / 0..1.
export function readFloat(doc, index) {
  const raw = readRaw(doc, index);
  const accessor = doc.json.accessors[index];
  const out = Float64Array.from(raw);
  const max = accessor.normalized ? COMPONENT_MAX[accessor.componentType] : 0;
  if (max) for (let i = 0; i < out.length; i += 1) out[i] = Math.max(out[i] / max, -1);
  return out;
}

// Keep only what is still referenced, and pack it into a fresh binary chunk.
// Works on whole bufferViews, so interleaved data keeps its layout; a view's
// start keeps its old offset modulo 4, so every accessor inside it stays aligned.
function compact(sourceJson, bin) {
  const json = structuredClone(sourceJson);
  const accessorMap = new Map();
  const accessors = [];
  const keep = (index) => {
    if (index === undefined || index === null) return index;
    if (!accessorMap.has(index)) {
      accessorMap.set(index, accessors.length);
      accessors.push(json.accessors[index]);
    }
    return accessorMap.get(index);
  };
  const keepAll = (map) => {
    for (const key of Object.keys(map || {})) map[key] = keep(map[key]);
  };
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      keepAll(primitive.attributes);
      if (primitive.indices !== undefined) primitive.indices = keep(primitive.indices);
      for (const target of primitive.targets || []) keepAll(target);
    }
  }
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = keep(skin.inverseBindMatrices);
  }
  for (const animation of json.animations || []) {
    for (const sampler of animation.samplers || []) {
      sampler.input = keep(sampler.input);
      sampler.output = keep(sampler.output);
    }
  }
  for (const node of json.nodes || []) {
    keepAll(node.extensions?.EXT_mesh_gpu_instancing?.attributes);
  }
  json.accessors = accessors;

  const viewMap = new Map();
  const views = [];
  const keepView = (index) => {
    if (index === undefined) return index;
    if (!viewMap.has(index)) {
      viewMap.set(index, views.length);
      views.push(json.bufferViews[index]);
    }
    return viewMap.get(index);
  };
  for (const accessor of accessors) {
    accessor.bufferView = keepView(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = keepView(accessor.sparse.indices.bufferView);
      accessor.sparse.values.bufferView = keepView(accessor.sparse.values.bufferView);
    }
  }
  for (const image of json.images || []) image.bufferView = keepView(image.bufferView);
  for (const accessor of accessors) if (accessor.bufferView === undefined) delete accessor.bufferView;
  for (const image of json.images || []) if (image.bufferView === undefined) delete image.bufferView;

  const parts = [];
  let length = 0;
  for (const view of views) {
    const start = view.byteOffset || 0;
    const pad = (((start - length) % 4) + 4) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); length += pad; }
    parts.push(bin.subarray(start, start + view.byteLength));
    view.byteOffset = length;
    length += view.byteLength;
  }
  json.bufferViews = views;
  if (!views.length) delete json.bufferViews;
  json.buffers = length ? [{ byteLength: length }] : [];
  if (!length) delete json.buffers;
  return serializeGlb(json, Buffer.concat(parts));
}

function docBytes(doc) {
  return Buffer.concat(doc.chunks);
}

// --- scene -----------------------------------------------------------------------

// Every node's world matrix, and which nodes the scene actually draws.
function sceneNodes(json) {
  const nodes = json.nodes || [];
  const world = new Array(nodes.length).fill(null);
  const scene = (json.scenes || [])[json.scene ?? 0];
  const local = (node) => (Array.isArray(node?.matrix) && node.matrix.length === 16
    ? new THREE.Matrix4().fromArray(node.matrix)
    : new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(node?.translation || [0, 0, 0]),
      new THREE.Quaternion().fromArray(node?.rotation || [0, 0, 0, 1]),
      new THREE.Vector3().fromArray(node?.scale || [1, 1, 1])
    ));
  const order = [];
  const walk = (index, parent) => {
    const node = nodes[index];
    if (!node || world[index]) return;
    world[index] = parent.clone().multiply(local(node));
    order.push(index);
    for (const child of node.children || []) walk(child, world[index]);
  };
  for (const root of scene?.nodes || []) walk(root, new THREE.Matrix4());
  return { world, order };
}

export function triangleList(mode, indices, count) {
  const source = indices || Uint32Array.from({ length: count }, (_, i) => i);
  if (mode === TRIANGLES) return Uint32Array.from(source.subarray(0, source.length - (source.length % 3)));
  const n = Math.max(0, source.length - 2);
  const out = new Uint32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    if (mode === TRIANGLE_FAN) {
      out.set([source[0], source[i + 1], source[i + 2]], i * 3);
    } else {
      // A strip alternates winding; the odd triangles swap their first two.
      out.set(i % 2 ? [source[i + 1], source[i], source[i + 2]] : [source[i], source[i + 1], source[i + 2]], i * 3);
    }
  }
  return out;
}

// Pixel size of an embedded PNG, JPEG or WebP, or 0 when it cannot be told.
function imageSize(bytes) {
  if (!bytes || bytes.length < 30) return 0;
  if (bytes.readUInt32BE(0) === 0x89504e47) return Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return Math.max(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 7));
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return 0;
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return 1 + Math.max(bytes.readUIntLE(24, 3), bytes.readUIntLE(27, 3));
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return 1 + Math.max(bits & 0x3fff, (bits >> 14) & 0x3fff);
    }
    if (chunk === 'VP8 ') return Math.max(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  return 0;
}

export function imageBytes(doc, imageIndex) {
  const image = (doc.json.images || [])[imageIndex];
  if (!image) return null;
  if (image.bufferView !== undefined) {
    const view = doc.json.bufferViews[image.bufferView];
    if (!view) return null;
    return doc.bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  }
  const match = String(image.uri || '').match(/^data:[^;]*;base64,(.*)$/);
  return match ? Buffer.from(match[1], 'base64') : null;
}

// Every `*Texture` slot a material samples, extensions included.
function materialTextureSlots(material) {
  const slots = [];
  const visit = (value, key) => {
    if (!value || typeof value !== 'object') return;
    if (/Texture$/.test(key || '') && Number.isInteger(value.index)) slots.push(value);
    for (const [child, next] of Object.entries(value)) visit(next, child);
  };
  visit(material, '');
  return slots;
}

// Largest dimension of the base colour texture, times its tiling — what the
// browser reads off material.map.
function baseColorPixels(doc, material) {
  const slot = material?.pbrMetallicRoughness?.baseColorTexture;
  if (!slot) return 0;
  const texture = (doc.json.textures || [])[slot.index];
  const source = texture?.source ?? texture?.extensions?.EXT_texture_webp?.source ?? texture?.extensions?.KHR_texture_basisu?.source;
  const pixels = imageSize(imageBytes(doc, source));
  const scale = slot.extensions?.KHR_texture_transform?.scale || [1, 1];
  return pixels * Math.max(Math.abs(scale[0] || 1), Math.abs(scale[1] || 1));
}

// The drawn triangle primitives, one PIECE per primitive per node, as three's
// GLTFLoader builds one mesh per primitive. A mesh drawn by two nodes is split
// into two copies first: they sit in different light, so they cannot share
// texels — the browser clones each mesh's geometry for the same reason.
function collectPieces(doc) {
  const { json } = doc;
  const { world, order } = sceneNodes(json);
  const claimed = new Set();
  const pieces = [];
  for (const nodeIndex of order) {
    const node = json.nodes[nodeIndex];
    if (node.mesh === undefined || !json.meshes?.[node.mesh]) continue;
    if (claimed.has(node.mesh)) {
      json.meshes.push(structuredClone(json.meshes[node.mesh]));
      node.mesh = json.meshes.length - 1;
    }
    claimed.add(node.mesh);
    // A skinned mesh's own node transform is ignored, per spec; at bind pose
    // its vertices already are world positions (see collectPrimitives in
    // meshRigTransfer.js).
    const matrix = node.skin !== undefined ? new THREE.Matrix4() : world[nodeIndex];
    for (const primitive of json.meshes[node.mesh].primitives || []) {
      const mode = primitive.mode ?? TRIANGLES;
      if (![TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN].includes(mode) || primitive.attributes?.POSITION === undefined) continue;
      const count = json.accessors[primitive.attributes.POSITION]?.count || 0;
      if (!count) continue;

      const raw = readFloat(doc, primitive.attributes.POSITION);
      const positions = new Float64Array(count * 3);
      const point = new THREE.Vector3();
      for (let i = 0; i < count; i += 1) {
        point.set(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]).applyMatrix4(matrix);
        positions[i * 3] = point.x; positions[i * 3 + 1] = point.y; positions[i * 3 + 2] = point.z;
      }
      const indices = primitive.indices !== undefined ? Uint32Array.from(readRaw(doc, primitive.indices)) : null;
      const tri = triangleList(mode, indices, count);
      const hasUv = primitive.attributes.TEXCOORD_0 !== undefined;
      const material = primitive.material !== undefined ? json.materials?.[primitive.material] : null;
      pieces.push({
        id: String(pieces.length),
        primitive,
        mode,
        indexed: indices !== null,
        count,
        positions,
        tri,
        hasUv,
        uv0: hasUv ? readFloat(doc, primitive.attributes.TEXCOORD_0) : new Float64Array(count * 2),
        texturePixels: baseColorPixels(doc, material),
        traits: {
          doubleSided: material?.doubleSided === true,
          alphaMode: material?.alphaMode || 'OPAQUE',
          alphaCutoff: material?.alphaCutoff ?? 0.5
        }
      });
    }
  }
  return pieces;
}

function corner(positions, v, out) {
  return out.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
}

// World-space area and UV-space area of some faces.
function faceAreas(positions, tri, uv, uvIndex, faces) {
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  let world = 0;
  let texture = 0;
  for (const f of faces) {
    corner(positions, tri[f * 3], a);
    corner(positions, tri[f * 3 + 1], b);
    corner(positions, tri[f * 3 + 2], c);
    world += b.sub(a).cross(c.sub(a)).length() * 0.5;
    const i0 = uvIndex[f * 3]; const i1 = uvIndex[f * 3 + 1]; const i2 = uvIndex[f * 3 + 2];
    texture += Math.abs(
      (uv[i1 * 2] - uv[i0 * 2]) * (uv[i2 * 2 + 1] - uv[i0 * 2 + 1])
      - (uv[i2 * 2] - uv[i0 * 2]) * (uv[i1 * 2 + 1] - uv[i0 * 2 + 1])) * 0.5;
  }
  return { world, texture };
}

// measureUvHealth's atlasWrites, over UV0 of every piece: total UV triangle
// area over the area actually covered, i.e. how many times over it is painted.
function measureUvHealth(pieces) {
  const grid = HEALTH_GRID;
  const hits = new Uint8Array(grid * grid);
  let uvs = false;
  let writtenArea = 0;
  for (const piece of pieces) {
    if (!piece.hasUv) continue;
    uvs = true;
    const { tri, uv0: uv } = piece;
    for (let t = 0; t + 2 < tri.length; t += 3) {
      const u0 = uv[tri[t] * 2], v0 = uv[tri[t] * 2 + 1];
      const u1 = uv[tri[t + 1] * 2], v1 = uv[tri[t + 1] * 2 + 1];
      const u2 = uv[tri[t + 2] * 2], v2 = uv[tri[t + 2] * 2 + 1];
      const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
      writtenArea += Math.abs(det) * 0.5;
      if (Math.abs(det) < 1e-20) continue;
      const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * grid));
      const maxX = Math.min(grid - 1, Math.ceil(Math.max(u0, u1, u2) * grid));
      const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2) * grid));
      const maxY = Math.min(grid - 1, Math.ceil(Math.max(v0, v1, v2) * grid));
      for (let py = minY; py <= maxY; py += 1) {
        const y = (py + 0.5) / grid;
        for (let px = minX; px <= maxX; px += 1) {
          const x = (px + 0.5) / grid;
          const w0 = ((x - u0) * (v2 - v0) - (u2 - u0) * (y - v0)) / det;
          const w1 = ((u1 - u0) * (y - v0) - (x - u0) * (v1 - v0)) / det;
          if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) hits[py * grid + px] = 1;
        }
      }
    }
  }
  if (!uvs) return { uvs: false, atlasWrites: 0 };
  let covered = 0;
  for (let i = 0; i < hits.length; i += 1) covered += hits[i];
  const unionArea = covered / (grid * grid);
  return { uvs: true, atlasWrites: unionArea > 0 ? writtenArea / unionArea : 0 };
}

// The piece's island structure in "virtual" vertices, with every face that has
// no usable UVs split onto three vertices of its own and laid flat — the
// browser's mapUnmappedFaces. Virtual, because a non-indexed primitive is
// welded only to FIND its islands (as mergeVertices does in the browser); its
// real vertices already are one per corner, so nothing about it is rewritten.
// An indexed one does need new vertices for the split, listed in `sources`.
function planPieceLayout(doc, piece) {
  const { tri, uv0, count, positions } = piece;
  let virtualIndex;
  let virtualCount;
  if (piece.indexed || piece.mode !== TRIANGLES) {
    virtualIndex = tri;
    virtualCount = count;
  } else {
    const attributes = Object.keys(piece.primitive.attributes).sort()
      .map(name => ({ values: readFloat(doc, piece.primitive.attributes[name]), size: TYPE_COMPONENTS[doc.json.accessors[piece.primitive.attributes[name]].type] }));
    const byKey = new Map();
    const rep = new Uint32Array(count);
    for (let v = 0; v < count; v += 1) {
      let key = '';
      for (const { values, size } of attributes) {
        for (let c = 0; c < size; c += 1) key += `${Math.round(values[v * size + c] * WELD_SHIFT)},`;
      }
      if (!byKey.has(key)) byKey.set(key, byKey.size);
      rep[v] = byKey.get(key);
    }
    virtualIndex = tri.map(v => rep[v]);
    virtualCount = byKey.size;
  }
  let virtualUv = new Float64Array(virtualCount * 2);
  for (let i = 0; i < tri.length; i += 1) {
    virtualUv[virtualIndex[i] * 2] = uv0[tri[i] * 2];
    virtualUv[virtualIndex[i] * 2 + 1] = uv0[tri[i] * 2 + 1];
  }

  const unmapped = [];
  const mapped = [];
  for (const faces of extractIslands(virtualIndex, virtualCount)) {
    let minU = Infinity; let minV = Infinity; let maxU = -Infinity; let maxV = -Infinity;
    for (const f of faces) {
      for (let k = 0; k < 3; k += 1) {
        const v = virtualIndex[f * 3 + k];
        minU = Math.min(minU, virtualUv[v * 2]); maxU = Math.max(maxU, virtualUv[v * 2]);
        minV = Math.min(minV, virtualUv[v * 2 + 1]); maxV = Math.max(maxV, virtualUv[v * 2 + 1]);
      }
    }
    // Either axis collapsed means no area to sample, not just a thin island.
    // A loop, not push(...faces): one big island overflows the call stack.
    const into = (maxU - minU) > 1e-7 && (maxV - minV) > 1e-7 ? mapped : unmapped;
    for (const f of faces) into.push(f);
  }

  const finalTri = Uint32Array.from(tri);
  const sources = [];
  if (unmapped.length) {
    const { world, texture } = faceAreas(positions, tri, virtualUv, virtualIndex, mapped);
    const uvPerMetre = world > 0 && texture > 0 ? Math.sqrt(texture / world) : 1;
    const splitIndex = Uint32Array.from(virtualIndex);
    const splitUv = new Float64Array((virtualCount + unmapped.length * 3) * 2);
    splitUv.set(virtualUv);
    const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
    const e1 = new THREE.Vector3(); const e2 = new THREE.Vector3(); const n = new THREE.Vector3();
    unmapped.forEach((f, t) => {
      const base = virtualCount + t * 3;
      for (let k = 0; k < 3; k += 1) {
        splitIndex[f * 3 + k] = base + k;
        if (piece.indexed || piece.mode !== TRIANGLES) {
          finalTri[f * 3 + k] = count + sources.length;
          sources.push(tri[f * 3 + k]);
        }
      }
      corner(positions, tri[f * 3], a);
      corner(positions, tri[f * 3 + 1], b);
      corner(positions, tri[f * 3 + 2], c);
      e1.subVectors(b, a);
      const length = e1.length();
      e1.normalize();
      n.crossVectors(e1, e2.subVectors(c, a));
      e2.crossVectors(n.normalize(), e1);
      const cu = c.clone().sub(a).dot(e1);
      const cv = c.clone().sub(a).dot(e2);
      // Kept away from zero area so the packer never skips it.
      splitUv[(base + 1) * 2] = Math.max(length, 1e-4) * uvPerMetre;
      splitUv[(base + 2) * 2] = cu * uvPerMetre;
      splitUv[(base + 2) * 2 + 1] = Math.max(Math.abs(cv), 1e-4) * uvPerMetre;
    });
    virtualIndex = splitIndex;
    virtualUv = splitUv;
    virtualCount += unmapped.length * 3;
  }

  const allFaces = Array.from({ length: tri.length / 3 }, (_, i) => i);
  const { world, texture } = faceAreas(positions, tri, virtualUv, virtualIndex, allFaces);
  return { virtualIndex, virtualUv, virtualCount, finalTri, sources, unmapped: unmapped.length, world, texture };
}

// Rewrite a piece's primitive with `sources.length` more vertices, each a copy
// of the vertex it names — every attribute and morph target, skin included.
function appendVertexCopies(doc, primitive, sources) {
  const extend = (index) => {
    const accessor = doc.json.accessors[index];
    const components = TYPE_COMPONENTS[accessor.type];
    const raw = readRaw(doc, index);
    const out = new raw.constructor(raw.length + sources.length * components);
    out.set(raw);
    sources.forEach((src, k) => {
      for (let c = 0; c < components; c += 1) out[raw.length + k * components + c] = raw[src * components + c];
    });
    // Copies never move the bounds, so the original min/max still hold.
    return addAccessor(doc, out, {
      componentType: accessor.componentType,
      type: accessor.type,
      normalized: accessor.normalized === true,
      min: accessor.min,
      max: accessor.max,
      usage: 'vertex'
    });
  };
  for (const name of Object.keys(primitive.attributes)) primitive.attributes[name] = extend(primitive.attributes[name]);
  for (const target of primitive.targets || []) {
    for (const name of Object.keys(target)) target[name] = extend(target[name]);
  }
}

function writeIndices(doc, primitive, tri, vertexCount) {
  const wide = vertexCount > 65535;
  primitive.indices = addAccessor(doc, wide ? tri : Uint16Array.from(tri), {
    componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT,
    type: 'SCALAR',
    usage: 'index'
  });
  primitive.mode = TRIANGLES;
}

/**
 * Pack one non-overlapping atlas over every mesh of a GLB, into an extra UV set.
 *
 * Returns `{ bakeTarget, channel, atlas, finish }`:
 *  - `bakeTarget` is the GLB to send to /meshes/flatten — the source with the
 *    atlas as TEXCOORD_<channel>, and without its clips (they only cost Blender
 *    time);
 *  - `atlas` says what happened: `{ repacked, islands, fill, unmapped, atlasWrites }`;
 *  - `finish(albedoPng, options)` builds the shipped GLB from the baked texture.
 */
export function prepareFlattenGlb(buffer, { resolution = 2048 } = {}) {
  const doc = openDoc(buffer);
  const { json } = doc;
  const pieces = collectPieces(doc);
  if (!pieces.length) throw new Error('There is no mesh to flatten.');

  // The atlas goes in the first UV set no source texture reads from.
  const usedChannels = new Set();
  for (const material of json.materials || []) {
    for (const slot of materialTextureSlots(material)) {
      usedChannels.add(slot.extensions?.KHR_texture_transform?.texCoord ?? slot.texCoord ?? 0);
    }
  }
  let channel = 1;
  while (usedChannels.has(channel)) channel += 1;
  if (channel > 7) throw new Error('Every UV channel is already in use by a texture; nothing is free for the atlas.');

  // Sets below the atlas must exist for it to be TEXCOORD_<channel>; they only
  // hold placeholders, since no texture reads them. A piece with no UVs at all
  // gets zeroes for UV0, which is what its textures sampled before.
  const setAtlas = (piece, atlasAccessor) => {
    const { attributes } = piece.primitive;
    if (attributes.TEXCOORD_0 === undefined) {
      const vertexCount = doc.json.accessors[attributes.POSITION].count;
      attributes.TEXCOORD_0 = addAccessor(doc, new Float32Array(vertexCount * 2), { componentType: FLOAT, type: 'VEC2', usage: 'vertex' });
    }
    for (let k = 1; k < channel; k += 1) {
      if (attributes[`TEXCOORD_${k}`] === undefined) attributes[`TEXCOORD_${k}`] = attributes.TEXCOORD_0;
    }
    attributes[`TEXCOORD_${channel}`] = atlasAccessor ?? attributes.TEXCOORD_0;
  };

  const health = measureUvHealth(pieces);
  let inRange = health.uvs && pieces.every(piece => piece.hasUv);
  for (const piece of pieces) {
    if (!inRange) break;
    const uv = piece.uv0;
    for (let i = 0; i < uv.length; i += 1) {
      if (uv[i] < -UV_RANGE_EPSILON || uv[i] > 1 + UV_RANGE_EPSILON) { inRange = false; break; }
    }
  }

  let atlas;
  if (inRange && health.atlasWrites > 0 && health.atlasWrites <= KEEP_LAYOUT_MAX_WRITES) {
    // Already one clean layout: the atlas IS UV0.
    for (const piece of pieces) setAtlas(piece, null);
    atlas = { repacked: false, islands: null, fill: null, unmapped: 0, atlasWrites: health.atlasWrites };
  } else {
    const layouts = pieces.map(piece => planPieceLayout(doc, piece));
    const unmappedTotal = layouts.reduce((sum, layout) => sum + layout.unmapped, 0);
    if (unmappedTotal > MAX_UNMAPPED_TRIANGLES) {
      throw new Error(`${unmappedTotal.toLocaleString('en-US')} triangles have no usable UVs, which is too many to lay out one `
        + 'by one. Add an Auto UV stage before this one.');
    }

    // Texel density per piece, from its own textures; untextured pieces take
    // the median, and all are clamped around it (see meshFlatten.js).
    const planned = pieces.map((piece, i) => ({
      id: piece.id,
      indices: layouts[i].virtualIndex,
      uv: layouts[i].virtualUv,
      vertexCount: layouts[i].virtualCount,
      texturePixels: piece.texturePixels,
      world: layouts[i].world,
      texture: layouts[i].texture
    }));
    const density = p => (p.texturePixels && p.world > 0 && p.texture > 0 ? p.texturePixels * Math.sqrt(p.texture / p.world) : 0);
    const densities = planned.map(density).filter(d => d > 0).sort((x, y) => x - y);
    const median = densities.length ? densities[Math.floor(densities.length / 2)] : 1024;
    for (const p of planned) {
      const clamped = Math.min(median * DENSITY_CLAMP, Math.max(median / DENSITY_CLAMP, density(p) || median));
      p.textureSize = p.world > 0 && p.texture > 0 ? clamped * Math.sqrt(p.world / p.texture) : 1024;
    }
    // Then scaled together to FILL the atlas: the packer never scales up.
    const texelArea = planned.reduce((sum, p) => sum + p.texture * p.textureSize ** 2, 0);
    if (texelArea > 0) {
      const fit = Math.sqrt((resolution * resolution * ATLAS_FILL_TARGET) / texelArea);
      for (const p of planned) p.textureSize *= fit;
    }

    const padding = Math.max(2, Math.round(resolution / 1024));
    const plan = planAtlas(planned, { size: resolution, maxAtlases: 1, padding, allowRotation: true });
    if (!plan) throw new Error('The UV islands could not be packed into one atlas.');

    pieces.forEach((piece, i) => {
      const layout = layouts[i];
      const out = plan.uvByPiece.get(piece.id);
      const realCount = piece.count + layout.sources.length;
      const atlasUv = new Float32Array(realCount * 2);
      for (let k = 0; k < layout.finalTri.length; k += 1) {
        atlasUv[layout.finalTri[k] * 2] = out[layout.virtualIndex[k] * 2];
        atlasUv[layout.finalTri[k] * 2 + 1] = out[layout.virtualIndex[k] * 2 + 1];
      }
      if (layout.sources.length) appendVertexCopies(doc, piece.primitive, layout.sources);
      if (layout.sources.length || piece.mode !== TRIANGLES) writeIndices(doc, piece.primitive, layout.finalTri, realCount);
      setAtlas(piece, addAccessor(doc, atlasUv, { componentType: FLOAT, type: 'VEC2', usage: 'vertex' }));
    });
    atlas = { repacked: true, islands: plan.islandCount, fill: plan.fill, unmapped: unmappedTotal, atlasWrites: health.atlasWrites };
  }

  const bakeJson = structuredClone(json);
  delete bakeJson.animations;
  const bakeTarget = compact(bakeJson, docBytes(doc));

  const finish = (albedoPng, { hasAlpha = false, unlit = false, name = 'mesh' } = {}) => {
    const materialCount = applyFlattenedAlbedo(doc, pieces, albedoPng, { channel, hasAlpha, unlit, name });
    return { buffer: compact(json, docBytes(doc)), materialCount };
  };

  return { bakeTarget, channel, atlas, finish };
}

// Swap every piece onto the baked albedo: the atlas becomes UV0, the other UV
// sets, vertex colours (baked in) and tangents (no normal map any more) go. One
// material per distinct render state — sidedness x opaque/cut-out/blended, kept
// PER PIECE, never OR-ed across the asset (see sourceMaterialTraits in
// meshFlatten.js for what OR-ing did to a house).
function applyFlattenedAlbedo(doc, pieces, png, { channel, hasAlpha, unlit, name }) {
  const { json } = doc;
  const view = appendBytes(doc, png);
  json.images = [{ name: `${name}_albedo`, mimeType: 'image/png', bufferView: view }];
  json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
  json.textures = [{ name: `${name}_albedo`, sampler: 0, source: 0 }];
  json.materials = [];

  const variants = new Map();
  const variantFor = (traits) => {
    const mask = hasAlpha && traits.alphaMode === 'MASK';
    const blend = hasAlpha && traits.alphaMode === 'BLEND';
    const key = `${traits.doubleSided ? 'double' : 'front'}:${mask ? `mask${traits.alphaCutoff}` : blend ? 'blend' : 'opaque'}`;
    if (!variants.has(key)) {
      variants.set(key, json.materials.push({
        name: variants.size ? `${name}_flat_${key.replace(':', '_').replace('.', '')}` : `${name}_flat`,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
        ...(traits.doubleSided ? { doubleSided: true } : {}),
        ...(mask ? { alphaMode: 'MASK', alphaCutoff: traits.alphaCutoff } : blend ? { alphaMode: 'BLEND' } : {}),
        ...(unlit ? { extensions: { KHR_materials_unlit: {} } } : {})
      }) - 1);
    }
    return variants.get(key);
  };

  const byPrimitive = new Map(pieces.map(piece => [piece.primitive, piece]));
  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      if (primitive.extensions) delete primitive.extensions.KHR_materials_variants;
      const piece = byPrimitive.get(primitive);
      if (!piece) {
        // Lines, points, or a mesh no scene draws: its old material is gone.
        delete primitive.material;
        continue;
      }
      const atlas = primitive.attributes[`TEXCOORD_${channel}`];
      for (const attribute of Object.keys(primitive.attributes)) {
        if (/^(TEXCOORD|COLOR)_\d+$/.test(attribute) || attribute === 'TANGENT') delete primitive.attributes[attribute];
      }
      primitive.attributes.TEXCOORD_0 = atlas;
      for (const target of primitive.targets || []) {
        for (const attribute of Object.keys(target)) {
          if (attribute !== 'POSITION' && attribute !== 'NORMAL') delete target[attribute];
        }
      }
      primitive.material = variantFor(piece.traits);
    }
  }

  const keepExtension = extension => !MATERIAL_EXTENSION.test(extension);
  json.extensionsUsed = (json.extensionsUsed || []).filter(keepExtension);
  json.extensionsRequired = (json.extensionsRequired || []).filter(keepExtension);
  if (unlit) json.extensionsUsed.push('KHR_materials_unlit');
  if (!json.extensionsUsed.length) delete json.extensionsUsed;
  if (!json.extensionsRequired.length) delete json.extensionsRequired;
  return variants.size;
}
