// node batch/pbr.test.mjs
//
// The batch PBR stage (pbr.js): the Mesh Editor's Texture > PBR run on a GLB
// with no browser. Checks that the maps are the editor's own generator output
// for the same texture and UV coverage, that they land in the glTF slots the
// editor's export produces, and the glTF-only rules (untouched channels keep
// their factor, unlit/untextured materials are left, padded PNGs decode).
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import {
  DEFAULT_PBR_OPTIONS,
  generatePbrMaps,
  rasterizeUvCoverage
} from '../src/utils/pbrFromAlbedo.js';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { applyPbrFromAlbedoToGlb } from './pbr.js';
import { executeBatchAction, runPbrInWorker } from './actionRunner.js';
import {
  createStage,
  createStageDefaultBindings,
  createStageDefaultInputs,
  getBatchActionDescriptor,
  getPbrActionOptions,
  getStageDesktopServices,
  getStageWorkflow,
  normalizeBatchConfig,
  validateBatch
} from './document.js';

const { PNG } = pngjs;
let passed = 0;
const queued = [];
function test(name, fn) { queued.push([name, fn]); }

// --- fixtures -----------------------------------------------------------------

const SIZE = 64;

// A grey albedo with a bright disc (a bump once read as height) in the LEFT
// half — the half the quad's UVs cover. The right half is gutter.
function albedoPixels({ alpha = 255 } = {}) {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      const inDisc = (x - 16) ** 2 + (y - 32) ** 2 < 100;
      const v = x >= 32 ? 20 : inDisc ? 220 : 110;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

function pngBytes(rgba, { pad = 0 } = {}) {
  const png = PNG.sync.write({ width: SIZE, height: SIZE, data: Buffer.from(rgba) }, { colorType: 6 });
  // What many exporters do: the GLB's alignment padding counted into the image.
  return pad ? Buffer.concat([png, Buffer.alloc(pad, 0x20)]) : png;
}

// One quad whose UVs span the left half of the texture, plus any extra
// materials (each on its own one-triangle primitive).
function texturedGlb({ image = pngBytes(albedoPixels()), mimeType = 'image/png', material = {}, extraMaterials = [], extensionsUsed } = {}) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 1, 0.5, 1, 0.5, 0, 0, 0]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const parts = [Buffer.from(positions.buffer), Buffer.from(uvs.buffer), Buffer.from(indices.buffer), Buffer.alloc(0)];
  const imageOffset = 48 + 32 + 12 + 0; // 92 -> padded to 92 (already a multiple of 4)
  const bin = Buffer.concat([...parts, image, Buffer.alloc((4 - (image.length % 4)) % 4)]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 },
        ...extraMaterials.map((_, i) => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 3, material: i + 1 }))
      ]
    }],
    materials: [
      { name: 'Painted', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.4, metallicFactor: 0.25 }, ...material },
      ...extraMaterials
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [{ mimeType, bufferView: 3 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 32 },
      { buffer: 0, byteOffset: 80, byteLength: 12 },
      { buffer: 0, byteOffset: imageOffset, byteLength: image.length }
    ],
    buffers: [{ byteLength: bin.length }],
    ...(extensionsUsed ? { extensionsUsed } : {})
  };
  return serializeGlb(json, bin);
}

function imageOf(glb, imageIndex) {
  const { json, bin } = parseGlb(glb);
  const image = json.images[imageIndex];
  const view = json.bufferViews[image.bufferView];
  const bytes = Buffer.from(bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength));
  if (image.mimeType === 'image/jpeg') return { mimeType: image.mimeType, ...jpeg.decode(bytes, { useTArray: true }) };
  const png = PNG.sync.read(bytes);
  return { mimeType: image.mimeType, width: png.width, height: png.height, data: png.data, colorType: bytes[25] };
}

// The coverage the editor would rasterise for the fixture quad.
function fixtureCoverage() {
  const texels = new Float32Array([0, 1, 0.5, 1, 0.5, 0, 0, 0].map((value, i) => value * SIZE));
  return rasterizeUvCoverage(texels, new Uint16Array([0, 1, 2, 0, 2, 3]), SIZE, SIZE);
}

function rgbaOf(bytes) {
  // pngjs reads an RGB PNG back as RGBA, so compare like with like.
  return Uint8Array.from(bytes);
}

// --- document rules -------------------------------------------------------------

test('a PBR stage seeds the editor defaults, binds the previous mesh and needs no service', () => {
  const descriptor = getBatchActionDescriptor('pbr');
  assert.equal(descriptor.kanbanColumn, 'Texturing');
  assert.equal(descriptor.keepsSurface, true);
  assert.deepEqual(getPbrActionOptions({}), {
    ...DEFAULT_PBR_OPTIONS,
    maps: { ...DEFAULT_PBR_OPTIONS.maps }
  }, 'every generator option has a parameter, defaulting to the editor\'s value');

  const meshStage = { id: 'stg-mesh', name: '', action: 'comfyui', workflowId: 2, inputs: {}, bindings: { '3.image': { source: 'stage', stageId: 'stg-image' } } };
  const imageStage = { id: 'stg-image', name: '', action: 'comfyui', workflowId: 1, inputs: { '6.text': 'a robot' }, bindings: {} };
  const workflowsById = {
    1: { id: 1, name: 'Text to Image', parameters: [{ id: '6.text', valueType: 'string' }], outputs: [{ valueType: 'image' }] },
    2: { id: 2, name: 'Image to Mesh', parameters: [{ id: '3.image', valueType: 'image' }], outputs: [{ valueType: 'mesh' }] }
  };
  const stage = createStage('', 'pbr');
  const workflow = getStageWorkflow(stage, workflowsById);
  stage.inputs = createStageDefaultInputs(workflow);
  stage.bindings = createStageDefaultBindings(workflow, [imageStage, meshStage], 2, []);
  assert.deepEqual(stage.bindings.mesh, { source: 'stage', stageId: 'stg-mesh' });
  assert.deepEqual(getStageDesktopServices(stage), []);

  const config = normalizeBatchConfig({ variables: [], groups: [{ id: 'g', name: 'A', values: {} }], stages: [imageStage, meshStage, stage] });
  assert.deepEqual(validateBatch({ config, workflowsById }), []);

  stage.inputs = { ...stage.inputs, pbr_normal: false, pbr_roughness: false, pbr_metalness: false, pbr_ao: false };
  const problems = validateBatch({ config: normalizeBatchConfig({ ...config, stages: [imageStage, meshStage, stage] }), workflowsById });
  assert.ok(problems.some(problem => /at least one map/.test(problem.message)), JSON.stringify(problems));
  stage.inputs.delight_strength = 0.5;
  assert.deepEqual(validateBatch({ config: normalizeBatchConfig({ ...config, stages: [imageStage, meshStage, stage] }), workflowsById }), [], 'de-light alone is a valid stage');
});

// --- the glTF result ----------------------------------------------------------------

test('the maps are the editor\'s generator output for the same texture and UV coverage', () => {
  const { buffer, stats, warnings } = applyPbrFromAlbedoToGlb(texturedGlb(), {});
  const expected = generatePbrMaps(albedoPixels(), SIZE, SIZE, {}, fixtureCoverage());
  const { json } = parseGlb(buffer);
  const material = json.materials[0];
  const normal = imageOf(buffer, json.textures[material.normalTexture.index].source);
  const orm = imageOf(buffer, json.textures[material.occlusionTexture.index].source);
  assert.deepEqual(rgbaOf(normal.data), Uint8Array.from(expected.normal), 'normal bytes');
  assert.deepEqual(rgbaOf(orm.data), Uint8Array.from(expected.orm), 'ORM bytes');
  assert.equal(normal.colorType, 2, 'data maps are written as RGB');
  assert.deepEqual(stats.maps, ['normal', 'roughness', 'metalness', 'ao']);
  assert.equal(stats.resolution, SIZE);
  assert.ok(stats.coverage > 0.45 && stats.coverage < 0.6, `coverage ${stats.coverage}`);
  assert.deepEqual(warnings, []);
});

test('maps land in glTF\'s slots: one ORM texture for AO + metallic-roughness, factors set to 1', () => {
  const { buffer } = applyPbrFromAlbedoToGlb(texturedGlb(), {});
  const { json } = parseGlb(buffer);
  const material = json.materials[0];
  const pbr = material.pbrMetallicRoughness;
  assert.equal(material.occlusionTexture.index, pbr.metallicRoughnessTexture.index, 'one packed texture');
  assert.notEqual(material.normalTexture.index, pbr.metallicRoughnessTexture.index);
  assert.equal(material.normalTexture.scale, undefined, 'strength 1');
  assert.equal(pbr.roughnessFactor, 1);
  assert.equal(pbr.metallicFactor, 1);
  // Each map wraps like the colour texture it lines up with.
  assert.equal(json.textures[material.normalTexture.index].sampler, json.textures[pbr.baseColorTexture.index].sampler);
  assert.equal(json.images.length, 3, 'albedo + normal + ORM');
});

test('the normal map is written in glTF\'s OpenGL convention, DirectX only on request', () => {
  // On the disc's upper rim (row 22) the height rises downward in the image,
  // towards the disc, so with +Y up the slope faces up the image: green above
  // 128. Small at 64px — the strength scales with size / 1024 — but the sign is
  // the point.
  const at = (glb) => {
    const { json } = parseGlb(glb);
    const normal = imageOf(glb, json.textures[json.materials[0].normalTexture.index].source);
    return normal.data[(22 * SIZE + 16) * 4 + 1];
  };
  const opengl = at(applyPbrFromAlbedoToGlb(texturedGlb(), {}).buffer);
  const directx = at(applyPbrFromAlbedoToGlb(texturedGlb(), { invertNormalY: true }).buffer);
  assert.ok(opengl > 128, `OpenGL green ${opengl}`);
  assert.ok(directx < 128, `DirectX green ${directx}`);
});

test('a channel the stage does not generate keeps the material\'s own factor', () => {
  const { buffer } = applyPbrFromAlbedoToGlb(texturedGlb(), { maps: { metalness: false } });
  const { json } = parseGlb(buffer);
  const pbr = json.materials[0].pbrMetallicRoughness;
  assert.equal(pbr.metallicFactor, 0.25, 'metallic factor untouched');
  assert.equal(pbr.roughnessFactor, 1);
  const orm = imageOf(buffer, json.textures[pbr.metallicRoughnessTexture.index].source);
  for (let i = 2; i < orm.data.length; i += 4) assert.equal(orm.data[i], 255, 'blue reads 1, so the factor alone decides metal');

  const aoOnly = parseGlb(applyPbrFromAlbedoToGlb(texturedGlb(), { maps: { normal: false, roughness: false, metalness: false, ao: true } }).buffer).json;
  assert.ok(aoOnly.materials[0].occlusionTexture);
  assert.equal(aoOnly.materials[0].pbrMetallicRoughness.metallicRoughnessTexture, undefined);
  assert.equal(aoOnly.materials[0].normalTexture, undefined);
  assert.equal(aoOnly.materials[0].pbrMetallicRoughness.roughnessFactor, 0.4);
});

test('replacing a baked map is said, and so is a channel an old texture carried', () => {
  const glb = texturedGlb({
    material: {
      normalTexture: { index: 0 },
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } }
    }
  });
  const { warnings } = applyPbrFromAlbedoToGlb(glb, { maps: { metalness: false } });
  assert.ok(warnings.some(warning => /Replaced the mesh’s existing normal map, metallic-roughness map/.test(warning)), warnings.join('\n'));
  assert.ok(warnings.some(warning => /also held metalness/.test(warning)), warnings.join('\n'));
});

test('texCoord and KHR_texture_transform follow the colour slot onto every map', () => {
  const transform = { offset: [0.5, 0], scale: [1, 1] };
  const glb = texturedGlb({
    material: { pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 0, extensions: { KHR_texture_transform: transform } } } },
    extensionsUsed: ['KHR_texture_transform']
  });
  const { buffer, stats } = applyPbrFromAlbedoToGlb(glb, {});
  const material = parseGlb(buffer).json.materials[0];
  assert.deepEqual(material.normalTexture.extensions, { KHR_texture_transform: transform });
  assert.equal(material.occlusionTexture.texCoord, 0);
  // Shifted half a texture right, the quad now covers the RIGHT half — so the
  // coverage moved with it (still about half the image).
  assert.ok(stats.coverage > 0.45 && stats.coverage < 0.6, `coverage ${stats.coverage}`);
});

test('de-light rewrites the colour texture, keeps its alpha, and drops the old one', () => {
  const rgba = albedoPixels({ alpha: 200 });
  const { buffer, stats } = applyPbrFromAlbedoToGlb(texturedGlb({ image: pngBytes(rgba) }), { delightStrength: 0.8 });
  const { json } = parseGlb(buffer);
  const pbr = json.materials[0].pbrMetallicRoughness;
  const base = imageOf(buffer, json.textures[pbr.baseColorTexture.index].source);
  assert.equal(json.images.length, 3, 'old albedo dropped: de-lit + normal + ORM');
  assert.equal(base.colorType, 6, 'alpha kept');
  assert.equal(base.data[3], 200);
  // The gutter (right half) is not covered, so de-light leaves it alone.
  const gutter = (10 * SIZE + 50) * 4;
  assert.equal(base.data[gutter], rgba[gutter]);
  assert.ok(stats.maps.includes('de-lit albedo'));
});

test('a JPEG albedo is read, and a de-lit one stays JPEG', () => {
  const jpg = jpeg.encode({ width: SIZE, height: SIZE, data: Buffer.from(albedoPixels()) }, 95).data;
  const { buffer } = applyPbrFromAlbedoToGlb(texturedGlb({ image: jpg, mimeType: 'image/jpeg' }), { delightStrength: 0.5 });
  const { json } = parseGlb(buffer);
  const base = json.images[json.textures[json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source];
  assert.equal(base.mimeType, 'image/jpeg');
  assert.equal(json.images[json.textures[json.materials[0].normalTexture.index].source].mimeType, 'image/png');
});

test('a PNG with the GLB\'s alignment padding after IEND still decodes', () => {
  const { stats } = applyPbrFromAlbedoToGlb(texturedGlb({ image: pngBytes(albedoPixels(), { pad: 3 }) }), {});
  assert.equal(stats.textures, 1);
});

test('untextured and unlit materials are left as they were, and said so', () => {
  const glb = texturedGlb({
    extraMaterials: [
      { name: 'Plain', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
      { name: 'Flat', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: { KHR_materials_unlit: {} } }
    ],
    extensionsUsed: ['KHR_materials_unlit']
  });
  const { buffer, warnings } = applyPbrFromAlbedoToGlb(glb, {});
  const { json } = parseGlb(buffer);
  assert.ok(json.materials[0].normalTexture);
  assert.equal(json.materials[1].normalTexture, undefined);
  assert.equal(json.materials[2].normalTexture, undefined);
  assert.ok(warnings.some(warning => /1 material without a colour texture was left/.test(warning)), warnings.join('\n'));
  assert.ok(warnings.some(warning => /1 unlit material/.test(warning)), warnings.join('\n'));
});

test('a mesh with nothing to derive maps from fails with the reason', () => {
  const untextured = texturedGlb({ material: { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } } });
  assert.throws(() => applyPbrFromAlbedoToGlb(untextured, {}), /no colour texture/);
  const unlit = texturedGlb({ material: { extensions: { KHR_materials_unlit: {} } } });
  assert.throws(() => applyPbrFromAlbedoToGlb(unlit, {}), /unlit/);
  assert.throws(() => applyPbrFromAlbedoToGlb(texturedGlb(), { maps: { normal: false, roughness: false, metalness: false, ao: false } }), /at least one map/);
});

test('the worker thread returns the same file as the inline run', async () => {
  const glb = texturedGlb();
  const progress = [];
  const viaWorker = await runPbrInWorker(glb, {}, evt => progress.push(evt.frac));
  const inline = applyPbrFromAlbedoToGlb(glb, {});
  assert.ok(Buffer.compare(viaWorker.buffer, inline.buffer) === 0);
  assert.deepEqual(viaWorker.stats, inline.stats);
  assert.ok(progress.length >= 3 && progress.at(-1) === 1, `progress ${progress}`);
  await assert.rejects(runPbrInWorker(texturedGlb({ material: { pbrMetallicRoughness: {} } }), {}), /no colour texture/);
});

test('a PBR cell saves a version of its input mesh and files the card under Texturing', async () => {
  const saves = [];
  const cards = [];
  const progress = [];
  const api = {
    async apiJson(method, path, { body } = {}) {
      if (method === 'GET' && path === '/assets') return [{ id: 5, type: 'mesh', name: 'crate', filename: 'meshes/crate.glb' }];
      if (method === 'POST' && path === '/cards') { cards.push(body); return { id: 1 }; }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async apiForm(method, path, form) {
      if (path !== '/meshes/editor/save') throw new Error(`unexpected form ${path}`);
      saves.push({ assetId: Number(form.get('assetId')), saveMode: form.get('saveMode'), bytes: Buffer.from(await form.get('meshFile').arrayBuffer()) });
      return { id: 101, type: 'mesh', name: form.get('name') };
    },
    async fetchAssetBuffer() { return texturedGlb(); }
  };
  const outcome = await executeBatchAction(api, {
    action: 'pbr',
    projectId: 7,
    inputs: { mesh: 'asset:5', pbr_metalness: false, roughness_base: 0.7 },
    name: 'Crate PBR',
    cardKey: 'batch:r:g:s',
    onProgress: percent => progress.push(percent)
  });
  assert.equal(outcome.asset.id, 101);
  assert.deepEqual({ assetId: saves[0].assetId, saveMode: saves[0].saveMode }, { assetId: 5, saveMode: 'version' });
  const pbr = parseGlb(saves[0].bytes).json.materials[0].pbrMetallicRoughness;
  assert.equal(pbr.metallicFactor, 0.25, 'the stage\'s own switch reached the generator');
  assert.ok(pbr.metallicRoughnessTexture);
  assert.equal(cards[0].column, 'Texturing');
  assert.equal(cards[0].cardId, 'batch:r:g:s');
  assert.deepEqual(outcome.stats.maps, ['normal', 'roughness', 'ao']);
  assert.ok(progress.some(percent => percent > 5 && percent < 95), `progress ${progress}`);
});

for (const [name, fn] of queued) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exit(1);
  }
}
console.log(`${passed}/${queued.length} batch PBR tests passed`);
