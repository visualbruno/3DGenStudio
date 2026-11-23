// PBR from albedo, in the backend — the batch twin of the Mesh Editor's
// Texture > PBR tool (PbrToolsPanel.jsx + the pbr handlers in MeshEditorPage).
//
// NODE ONLY. The editor reads the albedo off its texture canvas, runs
// generatePbrMaps (src/utils/pbrFromAlbedo.js) and hangs the results on the
// three.js material. A batch has no canvas and no scene, so the same generator
// runs here on the decoded image and the maps are written into the glTF JSON
// directly, the way applyBakedMapsToGlb (actionRunner.js) attaches a bake. The
// filters are the editor's own code, imported as-is, so both produce the same
// bytes from the same texture and settings.
//
// Synchronous and CPU-bound (a 4K texture is seconds of work), so the batch runs
// it in a worker thread (pbrWorker.js) rather than on the server's event loop.
//
// What the editor does that is mirrored here, rule by rule:
//  * coverage — the UV triangles are rasterised into a mask at the texture's
//    own size, with the same UV → texel mapping (texture transform, wrap), so
//    the generator can fill the gutter between islands before it filters;
//  * normal map bytes are glTF's OpenGL convention unless DirectX is asked for:
//    the editor's GLTFExporter writes them through untouched (see
//    src/utils/normalMapConvention.js), so they go in as they are;
//  * roughness / metalness / AO share ONE packed ORM texture, and each factor
//    a generated channel lands on is set to 1 (glTF multiplies them);
//  * de-light rewrites the colour texture itself, covered texels only.
// What is different is only what glTF-without-three needs: a channel the stage
// does NOT generate must leave the material reading what it read before, so
// the ORM's unused roughness/metalness channel is written as 255 (the factor
// alone then decides it) — the editor gets that for free from three, which
// keeps a material's other map in place.
//
// Each colour IMAGE gets its own set of maps at its own resolution, shared by
// every material that samples it; each new texture reuses the sampler and the
// texCoord / KHR_texture_transform of the colour texture it was derived from,
// so the maps sit exactly on it.
import { Buffer } from 'node:buffer';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import {
  DEFAULT_PBR_OPTIONS,
  applyDelight,
  coverageFraction,
  generatePbrMaps,
  rasterizeUvCoverage
} from '../src/utils/pbrFromAlbedo.js';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { imageBytes, readFloat, readRaw, triangleList } from './flatten.js';
import { dropUnusedTextures } from './gltfTextures.js';

const { PNG } = pngjs;

const TRIANGLE_MODES = new Set([4, 5, 6]);
const CLAMP_TO_EDGE = 33071;
const MIRRORED_REPEAT = 33648;
const COMPRESSION_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression'];
// A big texture decodes to width x height x 4 bytes; jpeg-js refuses past its
// own default budget otherwise.
const JPEG_MEMORY_MB = 4096;
// zlib level for the written maps: 9 costs about twice the time for ~3% less.
const PNG_DEFLATE_LEVEL = 6;
const JPEG_QUALITY = 92;

// --- images ------------------------------------------------------------------

function imageFormat(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes.readUInt32BE(0) === 0x89504e47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// The PNG up to the end of its IEND chunk. Many exporters count the GLB's
// 4-byte alignment padding (zeros, or spaces) into the image's bufferView, and
// pngjs refuses any byte after IEND ("unrecognised content at end of stream")
// where a browser ignores it — 450 of the 724 embedded PNGs in one real asset
// library had such a tail.
function trimPng(bytes) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    offset += 12 + length;
    if (type === 'IEND') return bytes.subarray(0, Math.min(offset, bytes.length));
  }
  return bytes;
}

// RGBA bytes of an embedded PNG or JPEG, as canvas getImageData would give them
// (16-bit PNGs come back scaled to 8 bits, palettes expanded).
function decodeImage(bytes) {
  const format = imageFormat(bytes);
  if (format === 'png') {
    const png = PNG.sync.read(trimPng(bytes));
    return { format, width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
  }
  if (format === 'jpeg') {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: JPEG_MEMORY_MB });
    return { format, width: image.width, height: image.height, rgba: new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length) };
  }
  throw new Error(format === 'webp'
    ? 'its colour texture is WebP, which the batch cannot decode'
    : 'its colour texture is not a PNG or JPEG');
}

function hasTransparency(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true;
  return false;
}

function encodePng(rgba, width, height, alpha = false) {
  const data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  return PNG.sync.write({ width, height, data }, { colorType: alpha ? 6 : 2, deflateLevel: PNG_DEFLATE_LEVEL });
}

// The de-lit colour keeps its source's format: a JPEG albedo rewritten as PNG
// is several times the size for no visible gain. Data maps are always PNG.
function encodeLike(format, rgba, width, height, alpha) {
  if (format === 'jpeg' && !alpha) {
    return { bytes: jpeg.encode({ width, height, data: rgba }, JPEG_QUALITY).data, mimeType: 'image/jpeg' };
  }
  return { bytes: encodePng(rgba, width, height, alpha), mimeType: 'image/png' };
}

// --- UV coverage ---------------------------------------------------------------

function wrap(value, mode) {
  if (mode === CLAMP_TO_EDGE) return Math.min(1, Math.max(0, value));
  if (mode === MIRRORED_REPEAT) {
    const t = ((value % 2) + 2) % 2;
    return t > 1 ? 2 - t : t;
  }
  // REPEAT, glTF's default. Unlike the editor's applyWrapMode (a plain fract),
  // a whole-number u stays at 1 rather than wrapping to 0, so a triangle
  // touching the right edge is not stretched across the whole image — only
  // the coverage mask reads this, and that stretch would mark gutter as island.
  const t = value - Math.floor(value);
  return t === 0 && value !== 0 ? 1 : t;
}

// The texel coordinates of one primitive's UVs as the colour slot samples
// them: KHR_texture_transform (applied as three.js's Matrix3.setUvTransform
// does, which is what the editor's mapUvToCanvasPoint uses), then the
// sampler's wrap. glTF's v runs down the image, so no flip.
function primitiveTexels(doc, primitive, slot, sampler, width, height) {
  const transform = slot.extensions?.KHR_texture_transform || {};
  const set = transform.texCoord ?? slot.texCoord ?? 0;
  const accessor = primitive.attributes?.[`TEXCOORD_${set}`];
  if (accessor === undefined) return null;
  const uv = readFloat(doc, accessor);
  const [tx, ty] = transform.offset || [0, 0];
  const [sx, sy] = transform.scale || [1, 1];
  const c = Math.cos(transform.rotation || 0);
  const s = Math.sin(transform.rotation || 0);
  const wrapS = sampler?.wrapS;
  const wrapT = sampler?.wrapT;
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i];
    const v = uv[i + 1];
    out[i] = wrap(sx * (c * u + s * v) + tx, wrapS) * width;
    out[i + 1] = wrap(sy * (-s * u + c * v) + ty, wrapT) * height;
  }
  return out;
}

function primitiveTriangles(doc, primitive, vertexCount) {
  const indices = primitive.indices !== undefined ? readRaw(doc, primitive.indices) : null;
  return triangleList(primitive.mode ?? 4, indices ? Uint32Array.from(indices) : null, vertexCount);
}

// --- the stage -----------------------------------------------------------------

// The colour images of a file and who samples them. Materials that cannot take
// the maps are counted, not grouped, so the caller can say why they were left.
function collectAlbedoGroups(json) {
  const groups = new Map();
  const skipped = { untextured: new Set(), unlit: new Set(), unreadable: new Set() };
  (json.meshes || []).forEach(mesh => {
    for (const primitive of mesh.primitives || []) {
      if (!TRIANGLE_MODES.has(primitive.mode ?? 4)) continue;
      const materialIndex = primitive.material;
      const material = materialIndex === undefined ? null : (json.materials || [])[materialIndex];
      const slot = material?.pbrMetallicRoughness?.baseColorTexture;
      if (!slot) { skipped.untextured.add(materialIndex ?? -1); continue; }
      if (material.extensions?.KHR_materials_unlit) { skipped.unlit.add(materialIndex); continue; }
      const texture = (json.textures || [])[slot.index];
      if (!Number.isInteger(texture?.source)) { skipped.unreadable.add(materialIndex); continue; }
      let group = groups.get(texture.source);
      if (!group) {
        group = { image: texture.source, materials: new Set(), uses: [] };
        groups.set(texture.source, group);
      }
      group.materials.add(materialIndex);
      group.uses.push({ primitive, slot, sampler: (json.samplers || [])[texture.sampler] });
    }
  });
  return { groups: [...groups.values()], skipped };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// Generate the maps for every colour texture of a GLB and attach them.
// `options` are generator options (getPbrActionOptions). `onProgress(frac,
// message)` reports 0..1. Returns { buffer, stats, warnings }; throws when
// nothing in the file could take the maps.
export function applyPbrFromAlbedoToGlb(glbBuffer, options = {}, { onProgress } = {}) {
  const o = { ...DEFAULT_PBR_OPTIONS, ...options, maps: { ...DEFAULT_PBR_OPTIONS.maps, ...(options.maps || {}) } };
  const delight = Number(o.delightStrength) > 0;
  if (!Object.values(o.maps).some(Boolean) && !delight) {
    throw new Error('Pick at least one map to generate, or raise De-light');
  }

  const { json, bin } = parseGlb(glbBuffer);
  json.buffers = json.buffers || [];
  if (json.buffers.some(buffer => buffer.uri !== undefined)) {
    throw new Error('This mesh keeps its data in an external file, so the maps cannot be embedded in it');
  }
  if (json.buffers.length === 0) json.buffers.push({ byteLength: 0 });
  const doc = { json, bin: bin ? Buffer.from(bin) : Buffer.alloc(0) };
  const used = [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])];
  const compressed = used.find(name => COMPRESSION_EXTENSIONS.includes(name)) || null;

  const { groups, skipped } = collectAlbedoGroups(json);
  const warnings = [];
  if (groups.length === 0) {
    if (skipped.unlit.size) {
      throw new Error('Every textured material is unlit (KHR_materials_unlit), and unlit materials ignore normal, roughness, metalness and AO maps — a flattened mesh already has its lighting in the colour');
    }
    if (skipped.unreadable.size) {
      throw new Error('The colour texture is not an image the batch can read (KTX2 or WebP through an extension)');
    }
    throw new Error('The mesh has no colour texture to derive the maps from — texture it first, or bake its base colour onto it');
  }

  const parts = [doc.bin];
  let length = doc.bin.length;
  json.bufferViews = json.bufferViews || [];
  json.images = json.images || [];
  json.textures = json.textures || [];
  const addImage = (bytes, name, mimeType = 'image/png') => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); length += pad; }
    const view = json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length }) - 1;
    parts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    length += bytes.length;
    return json.images.push({ name, mimeType, bufferView: view }) - 1;
  };
  // One texture per (image, sampler): a map must wrap and filter exactly like
  // the colour texture it lines up with.
  const textureCache = new Map();
  const textureFor = (image, sampler) => {
    const key = `${image}:${sampler ?? ''}`;
    if (!textureCache.has(key)) {
      textureCache.set(key, json.textures.push(sampler === undefined ? { source: image } : { source: image, sampler }) - 1);
    }
    return textureCache.get(key);
  };
  // A slot for a new map on the colour slot's UVs: same texCoord, same
  // transform, nothing else carried over (no normal scale, no occlusion strength).
  const slotLike = (albedoSlot, textureIndex) => {
    const slot = { index: textureIndex };
    if (albedoSlot.texCoord !== undefined) slot.texCoord = albedoSlot.texCoord;
    if (albedoSlot.extensions?.KHR_texture_transform) {
      slot.extensions = { KHR_texture_transform: structuredClone(albedoSlot.extensions.KHR_texture_transform) };
    }
    return slot;
  };

  const replaced = { normal: 0, occlusion: 0, metallicRoughness: 0 };
  const lostChannel = new Set();
  const resolutions = [];
  const failures = [];
  let coverageSum = 0;
  let coverageCount = 0;
  let processed = 0;

  groups.forEach((group, groupIndex) => {
    const step = (frac, message) => onProgress?.((groupIndex + frac) / groups.length, groups.length > 1 ? `${message} (texture ${groupIndex + 1} of ${groups.length})` : message);

    step(0, 'Decoding the colour texture');
    let decoded;
    try {
      const bytes = imageBytes(doc, group.image);
      if (!bytes) throw new Error('its colour texture is an external file');
      decoded = decodeImage(bytes);
    } catch (err) {
      failures.push(`${plural(group.materials.size, 'material')} skipped: ${err.message}`);
      return;
    }
    const { format, width, height, rgba } = decoded;

    // Coverage at full size, as the editor's Apply does. Compressed geometry
    // cannot be read here, so its gutter goes unfilled (the maps still line up;
    // only the island edges may show a faint rim).
    let coverage = null;
    if (!compressed) {
      step(0.05, 'Rasterising the UV islands');
      coverage = new Uint8Array(width * height);
      for (const use of group.uses) {
        const vertexCount = json.accessors?.[use.primitive.attributes?.POSITION]?.count || 0;
        const texels = primitiveTexels(doc, use.primitive, use.slot, use.sampler, width, height);
        if (!texels || !vertexCount) continue;
        coverage = rasterizeUvCoverage(texels, primitiveTriangles(doc, use.primitive, vertexCount), width, height, coverage);
      }
      const fraction = coverageFraction(coverage);
      // No UVs at all: there are no islands to keep apart, so treat the whole
      // image as covered rather than filling everything from nothing.
      if (fraction === 0) coverage = null;
      else { coverageSum += fraction; coverageCount += 1; }
    }

    step(0.15, `Generating the maps at ${width}x${height}`);
    const result = generatePbrMaps(rgba, width, height, o, coverage);
    const baseColor = result.delightGain
      ? applyDelight(rgba, width, height, result.delightGain, width, height, o.delightStrength, new Uint8ClampedArray(rgba), coverage)
      : null;

    // A channel the stage does not generate reads 1 so its factor alone decides
    // it — what the material said before. The generator writes metalness 0 when
    // it is off (right for the editor's preview, which never samples it).
    if (result.orm && o.maps.roughness && !o.maps.metalness) {
      for (let i = 2; i < result.orm.length; i += 4) result.orm[i] = 255;
    }

    step(0.7, 'Encoding the maps');
    const normalImage = result.normal ? addImage(encodePng(result.normal, width, height), 'PbrNormal') : null;
    const ormImage = result.orm && (o.maps.roughness || o.maps.metalness || o.maps.ao)
      ? addImage(encodePng(result.orm, width, height), 'PbrORM')
      : null;
    let baseImage = null;
    if (baseColor) {
      const encoded = encodeLike(format, baseColor, width, height, hasTransparency(rgba));
      baseImage = addImage(encoded.bytes, 'PbrBaseColor', encoded.mimeType);
    }

    for (const materialIndex of group.materials) {
      const material = json.materials[materialIndex];
      const pbr = material.pbrMetallicRoughness;
      const albedoSlot = pbr.baseColorTexture;
      const sampler = json.textures[albedoSlot.index]?.sampler;

      if (normalImage !== null) {
        if (material.normalTexture) replaced.normal += 1;
        material.normalTexture = slotLike(albedoSlot, textureFor(normalImage, sampler));
      }
      if (ormImage !== null) {
        const orm = textureFor(ormImage, sampler);
        if (o.maps.ao) {
          if (material.occlusionTexture) replaced.occlusion += 1;
          material.occlusionTexture = slotLike(albedoSlot, orm);
        }
        if (o.maps.roughness || o.maps.metalness) {
          if (pbr.metallicRoughnessTexture) {
            replaced.metallicRoughness += 1;
            if (!o.maps.roughness) lostChannel.add('roughness');
            if (!o.maps.metalness) lostChannel.add('metalness');
          }
          pbr.metallicRoughnessTexture = slotLike(albedoSlot, orm);
          if (o.maps.roughness) pbr.roughnessFactor = 1;
          if (o.maps.metalness) pbr.metallicFactor = 1;
        }
      }
      if (baseImage !== null) {
        // Everything else about the colour slot (texCoord, transform, extras)
        // stays; only the image is the de-lit one.
        pbr.baseColorTexture = { ...structuredClone(albedoSlot), index: textureFor(baseImage, sampler) };
      }
    }

    resolutions.push(width === height ? width : `${width}x${height}`);
    processed += 1;
    step(1, 'Maps attached');
  });

  if (processed === 0) {
    throw new Error(`No colour texture could be read: ${failures.join('; ')}`);
  }

  warnings.push(...failures);
  if (skipped.untextured.size) {
    warnings.push(`${plural(skipped.untextured.size, 'material')} without a colour texture ${skipped.untextured.size === 1 ? 'was' : 'were'} left as ${skipped.untextured.size === 1 ? 'it was' : 'they were'}`);
  }
  if (skipped.unlit.size) {
    warnings.push(`${plural(skipped.unlit.size, 'unlit material')} (KHR_materials_unlit) ${skipped.unlit.size === 1 ? 'was' : 'were'} skipped — unlit materials ignore these maps`);
  }
  if (skipped.unreadable.size) {
    warnings.push(`${plural(skipped.unreadable.size, 'material')} whose colour texture is KTX2 or WebP ${skipped.unreadable.size === 1 ? 'was' : 'were'} skipped`);
  }
  if (compressed) {
    warnings.push(`The geometry is compressed (${compressed}), so the UV islands could not be read: the maps were filtered across the gutter, which can leave a faint rim along the seams`);
  }
  // Said because the usual chain is Bake -> PBR, where a default PBR stage would
  // silently swap a real baked normal/AO for a guess from the colour.
  const replacedNames = [
    replaced.normal && 'normal map',
    replaced.occlusion && 'AO map',
    replaced.metallicRoughness && 'metallic-roughness map'
  ].filter(Boolean);
  if (replacedNames.length) {
    warnings.push(`Replaced the mesh’s existing ${replacedNames.join(', ')} — switch those maps off in this stage to keep maps an earlier Bake made`);
  }
  if (lostChannel.size) {
    warnings.push(`The old metallic-roughness texture also held ${[...lostChannel].join(' and ')}, which this stage did not generate; that channel now reads the material’s factor alone`);
  }

  const binary = dropUnusedTextures(json, Buffer.concat(parts));
  json.buffers[0].byteLength = binary.length;

  const maps = [
    o.maps.normal && 'normal',
    o.maps.roughness && 'roughness',
    o.maps.metalness && 'metalness',
    o.maps.ao && 'ao',
    delight && 'de-lit albedo'
  ].filter(Boolean);

  return {
    buffer: serializeGlb(json, binary),
    stats: {
      maps,
      textures: processed,
      resolution: resolutions.length === 1 ? resolutions[0] : resolutions,
      coverage: coverageCount ? Math.round((coverageSum / coverageCount) * 1000) / 1000 : null
    },
    warnings
  };
}
