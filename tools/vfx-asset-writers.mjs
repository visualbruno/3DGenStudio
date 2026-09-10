// PNG and GLB writers for the VFX preset asset pack.
//
// WHY HAND-ROLLED. There is no image library in this project's dependencies -
// no sharp, no pngjs, no canvas - and three's GLTFExporter needs a DOM. Adding
// a dependency to generate nine sprites and four chips, once, would be a poor
// trade: both formats are simple enough to write directly, and `zlib` is a node
// builtin, so this file has no dependencies at all.
//
// Both writers are deliberately minimal and do exactly one thing each: 8-bit
// RGBA non-interlaced PNG, and a single-mesh GLB with positions, normals and
// indices. Neither is a general-purpose encoder and neither should grow into
// one - if the pack ever needs more, that is the moment to take a dependency.
import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

/**
 * Encode straight-alpha RGBA bytes as a PNG.
 *
 * STRAIGHT ALPHA, NOT PREMULTIPLIED - which is what PNG stores and what the
 * texture loader expects. A sprite premultiplied on the way in would be
 * multiplied by its alpha a second time by the additive blend and the soft edge
 * of every particle would vanish.
 *
 * @param {number} size square side in pixels
 * @param {Uint8Array} rgba size*size*4 bytes
 * @returns {Buffer}
 */
export function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // 8 bits per channel
  header[9] = 6;   // colour type 6: truecolour with alpha
  header[10] = 0;  // deflate
  header[11] = 0;  // adaptive filtering
  header[12] = 0;  // no interlace

  // One filter byte per scanline. Filter 0 (None) throughout: these sprites are
  // smooth gradients that deflate well regardless, and None keeps the writer
  // trivially correct.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Paint a square sprite from a function of position.
 *
 * `shade(u, v)` is called per pixel with coordinates in -1..1 and returns
 * `[r, g, b, a]` in 0..1. Supersampled 3x3, because a particle sprite is all
 * soft edges and an aliased one shows its stair-steps the moment it is scaled
 * up on a big billboard.
 *
 * @param {number} size
 * @param {(u: number, v: number) => number[]} shade
 * @returns {Uint8Array}
 */
export function paint(size, shade) {
  const rgba = new Uint8Array(size * size * 4);
  const samples = 3;
  const step = 1 / (samples + 1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 1; sy <= samples; sy += 1) {
        for (let sx = 1; sx <= samples; sx += 1) {
          const u = ((x + sx * step) / size) * 2 - 1;
          const v = ((y + sy * step) / size) * 2 - 1;
          const [cr, cg, cb, ca] = shade(u, v);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = samples * samples;
      const at = (y * size + x) * 4;
      const clamp = (value) => Math.max(0, Math.min(255, Math.round((value / n) * 255)));
      rgba[at] = clamp(r);
      rgba[at + 1] = clamp(g);
      rgba[at + 2] = clamp(b);
      rgba[at + 3] = clamp(a);
    }
  }
  return rgba;
}

// --- GLB ---------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const pad4 = (n) => (4 - (n % 4)) % 4;

/**
 * Write a single-mesh GLB from flat vertex data.
 *
 * Positions and normals as float32, indices as uint16 - which caps a chip at
 * 65535 vertices and is wildly more than any of these need. Normals are
 * included rather than left to the loader because the particle mesh path reads
 * the geometry as it finds it, and a mesh with no normals renders flat black
 * under a directional light.
 *
 * @param {Object} mesh
 * @param {number[]} mesh.positions xyz triples
 * @param {number[]} mesh.normals xyz triples, same count as positions
 * @param {number[]} mesh.indices triangle list
 * @param {string} [mesh.name]
 * @returns {Buffer}
 */
export function encodeGlb(mesh) {
  const positions = Float32Array.from(mesh.positions);
  const normals = Float32Array.from(mesh.normals);
  const indices = Uint16Array.from(mesh.indices);

  // Every accessor's byteOffset must be a multiple of its component size, so
  // the buffer is laid out largest-alignment first and each block padded to 4.
  const parts = [
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
    Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength),
    Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
  ];
  const offsets = [];
  let cursor = 0;
  const blocks = [];
  for (const part of parts) {
    offsets.push(cursor);
    blocks.push(part);
    cursor += part.length;
    const padding = pad4(cursor);
    if (padding) {
      blocks.push(Buffer.alloc(padding));
      cursor += padding;
    }
  }
  const binary = Buffer.concat(blocks);

  // glTF requires min/max on the POSITION accessor - some loaders use it for
  // bounds and will reject the file without it.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }

  const json = {
    asset: { version: '2.0', generator: '3D Gen Studio VFX preset assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: mesh.name || 'chip' }],
    meshes: [{
      name: mesh.name || 'chip',
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
    }],
    materials: [{
      name: 'chip',
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.8,
      },
    }],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max,
      },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: indices.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: binary.length }],
  };

  // The JSON chunk pads with SPACES and the binary chunk with ZEROS - that is
  // the spec, not a detail: a zero inside the JSON chunk makes it unparseable.
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBuffer, Buffer.alloc(pad4(jsonBuffer.length), 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binary.length, 8);

  const chunkHeader = (length, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.writeUInt32LE(type, 4);
    return head;
  };

  return Buffer.concat([
    header,
    chunkHeader(jsonPadded.length, JSON_CHUNK),
    jsonPadded,
    chunkHeader(binary.length, BIN_CHUNK),
    binary,
  ]);
}

/**
 * Faceted geometry from triangles: every triangle gets its own three vertices
 * and a flat normal.
 *
 * FLAT, NOT SMOOTH, and on purpose. These are rock chips and shards - a
 * hard-edged facet catching the light differently from its neighbour is what
 * makes a tumbling piece of debris read as solid rather than as a blob.
 *
 * @param {number[][]} triangles each entry three xyz points
 * @param {string} name
 * @returns {Object} ready for encodeGlb
 */
export function facetedMesh(triangles, name) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [a, b, c] of triangles) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    const unit = [n[0] / length, n[1] / length, n[2] / length];
    const base = positions.length / 3;
    for (const point of [a, b, c]) {
      positions.push(point[0], point[1], point[2]);
      normals.push(unit[0], unit[1], unit[2]);
    }
    indices.push(base, base + 1, base + 2);
  }
  return { positions, normals, indices, name };
}
