// Shared glTF texture housekeeping for the batch actions that write maps into a
// GLB server-side (Bake's applyBakedMapsToGlb in actionRunner.js, and the PBR
// stage in pbr.js). Kept apart from actionRunner.js so the PBR worker can load
// it without pulling in the app client.
import { Buffer } from 'node:buffer';

// A bake REPLACES a slot's texture, so what the slot held before — the low
// poly's own albedo, typically — is left in the file with nothing pointing at
// it. Its bytes nearly double the file, and anything that lists a file's images
// shows two textures, the orphan with no material to say it is colour (so it is
// often drawn as linear data, washed out). Drop every texture no material
// reaches, then the images and samplers only those used, then the buffer views
// only those images used. Edits `json` in place; returns the new binary chunk.
export function dropUnusedTextures(json, bin) {
  // Every textureInfo — core slots and extension ones (clearcoatTexture,
  // specularColorTexture…) alike — is a `…Texture` key holding an `index`.
  const textureRefs = [];
  const collectTextures = (value, key) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => collectTextures(item)); return; }
    if (key?.endsWith('Texture') && Number.isInteger(value.index)) textureRefs.push(value);
    for (const [childKey, child] of Object.entries(value)) collectTextures(child, childKey);
  };
  collectTextures(json.materials);

  // Keep the items whose index is in `used`, renumbering the references.
  const keepUsed = (list, refs, field) => {
    const used = new Set(refs.map(ref => ref[field]));
    const remap = new Map();
    const kept = [];
    (list || []).forEach((item, index) => {
      if (used.has(index)) { remap.set(index, kept.length); kept.push(item); }
    });
    refs.forEach(ref => { ref[field] = remap.get(ref[field]); });
    return kept;
  };
  const setList = (key, list) => {
    if (list.length) json[key] = list;
    else delete json[key];
  };

  setList('textures', keepUsed(json.textures, textureRefs, 'index'));

  // A texture reads its image through `source`, or through an extension's own
  // `source` (KHR_texture_basisu, EXT_texture_webp…).
  const imageRefs = [];
  const samplerRefs = [];
  for (const texture of json.textures || []) {
    for (const holder of [texture, ...Object.values(texture.extensions || {})]) {
      if (Number.isInteger(holder?.source)) imageRefs.push(holder);
    }
    if (Number.isInteger(texture.sampler)) samplerRefs.push(texture);
  }
  setList('images', keepUsed(json.images, imageRefs, 'source'));
  setList('samplers', keepUsed(json.samplers, samplerRefs, 'sampler'));

  // Repacking needs every view in the one embedded buffer; anything else keeps
  // its bytes rather than risk moving data it does not understand.
  const views = json.bufferViews || [];
  if ((json.buffers || []).length !== 1 || views.some(view => (view.buffer ?? 0) !== 0)) return bin;

  // Accessors, sparse data, images, Draco… all name a view as `bufferView`.
  const viewRefs = [];
  const collectViews = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collectViews); return; }
    if (Number.isInteger(value.bufferView)) viewRefs.push(value);
    Object.values(value).forEach(collectViews);
  };
  for (const [key, value] of Object.entries(json)) {
    if (key !== 'bufferViews' && key !== 'buffers') collectViews(value);
  }
  const keptViews = keepUsed(views, viewRefs, 'bufferView');
  if (keptViews.length === views.length) return bin;

  // A view's start keeps its old offset modulo 4, so every accessor inside it
  // stays aligned (the same rule as flatten.js's compact).
  const chunks = [];
  let length = 0;
  for (const view of keptViews) {
    const start = view.byteOffset || 0;
    const pad = (((start - length) % 4) + 4) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    chunks.push(bin.subarray(start, start + view.byteLength));
    view.byteOffset = length;
    length += view.byteLength;
  }
  setList('bufferViews', keptViews);
  return Buffer.concat(chunks);
}
