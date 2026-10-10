// node batch/actions.test.mjs
//
// Built-in batch actions (Optimize / Auto UV / Auto Rig / Transfer Rig / Bake / Flatten): the document
// rules that let them ride the workflow-shaped binding model, the glTF material
// patch that applies a bake without a browser, and a whole backend run that
// chains a ComfyUI mesh into Optimize, Auto Rig and Bake — against a fake backend.
import assert from 'node:assert/strict';
import {
  createStage,
  createStageDefaultBindings,
  createStageDefaultInputs,
  findParentAssetForStage,
  getStageWorkflow,
  getBatchActionDescriptor,
  getStageDesktopServices,
  normalizeBatchConfig,
  resolveStageInputs,
  validateBatch
} from './document.js';
import { applyBakedMapsToGlb, executeBatchAction } from './actionRunner.js';
import { createBatchRunner, isActiveBatchRun } from './runner.js';
import { parseGlb, serializeGlb } from '../meshPivot.js';
import { transferRig } from '../meshRigTransfer.js';

let passed = 0;
const queued = [];
function test(name, fn) { queued.push([name, fn]); }

const WORKFLOWS = {
  1: {
    id: 1,
    name: 'Text to Image',
    parameters: [{ id: '6.text', name: 'Prompt', valueType: 'string', defaultValue: 'a robot' }],
    outputs: [{ valueType: 'image' }]
  },
  2: {
    id: 2,
    name: 'Image to Mesh',
    parameters: [{ id: '3.image', name: 'Source Image', valueType: 'image' }],
    outputs: [{ valueType: 'mesh' }]
  }
};

// A stage seeded exactly as the page seeds one when its action is picked.
function seededStage(action, stages, overrides = {}) {
  const stage = createStage('', action);
  const workflow = getStageWorkflow(stage, WORKFLOWS);
  stage.inputs = createStageDefaultInputs(workflow);
  stage.bindings = createStageDefaultBindings(workflow, stages, stages.length, []);
  return { ...stage, ...overrides, inputs: { ...stage.inputs, ...(overrides.inputs || {}) } };
}

function comfyStage(id, workflowId, bindings = {}) {
  return { id, name: '', action: 'comfyui', workflowId, inputs: { '6.text': 'a robot' }, bindings };
}

// image -> mesh -> <actions...>
function chain(...actions) {
  const stages = [
    comfyStage('stg-img', 1),
    comfyStage('stg-mesh', 2, { '3.image': { source: 'stage', stageId: 'stg-img' } })
  ];
  for (const action of actions) {
    stages.push({ ...seededStage(action, stages), id: `stg-${action}-${stages.length}` });
  }
  return stages;
}

function tinyGlb({ materials = [{ name: 'Skin', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.2, 0.2, 0.8], roughnessFactor: 0.4 } }] } = {}) {
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(materials.length ? { material: 0 } : {}) }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...(materials.length ? { materials } : {})
  };
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  return serializeGlb(json, bin);
}

const png = label => Buffer.from(`\x89PNG-${label}`);

// A tinyGlb carrying a one-joint skin, for "does the rig survive" checks.
function skinnedGlb() {
  const { json, bin } = parseGlb(tinyGlb());
  json.nodes.push({ name: 'Hips' });
  json.skins = [{ joints: [1] }];
  json.nodes[0].skin = 0;
  return serializeGlb(json, bin);
}

// A triangle genuinely skinned to one bone (JOINTS_0 / WEIGHTS_0 and all), so
// the real meshRigTransfer.js has something to sample. `clips` adds that many
// (empty) animations, which the batch transfer does not carry; `scale` sizes it.
function riggedGlb({ clips = 0, scale = 1 } = {}) {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0].map(value => value * scale)).buffer);
  const joints = Buffer.from(new Uint16Array(12).buffer);
  const weights = Buffer.from(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]).buffer);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 + 24 + 48 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
      { buffer: 0, byteOffset: 60, byteLength: 48 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [scale, scale, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' }
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    nodes: [{ mesh: 0, skin: 0 }, { name: 'Hips' }],
    skins: [{ joints: [1] }],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
    ...(clips ? { animations: Array.from({ length: clips }, (_, i) => ({ name: `Clip ${i}`, channels: [], samplers: [] })) } : {})
  };
  return serializeGlb(json, Buffer.concat([positions, joints, weights]));
}

// Routes /meshes/transfer-rig through the REAL meshRigTransfer.js, as the
// server route does, so the cell is tested against the transfer itself.
function useRealTransfer(state, api) {
  const baseForm = api.apiForm;
  api.apiForm = async (method, path, form) => {
    if (path !== '/meshes/transfer-rig') return baseForm(method, path, form);
    const options = JSON.parse(form.get('options'));
    state.toolCalls.push({ path, options });
    const target = Buffer.from(await form.get('meshFile').arrayBuffer());
    const source = Buffer.from(await form.get('sourceFile').arrayBuffer());
    const result = transferRig(source, target, { smoothIters: options.smooth_iters });
    return { mesh_b64: result.buffer.toString('base64'), stats: result.stats };
  };
}

// --- the document ----------------------------------------------------------

test('an action stage is described as a workflow, so its defaults seed like one', () => {
  const stage = createStage('', 'optimize');
  const workflow = getStageWorkflow(stage, {});
  assert.equal(workflow.name, 'Optimize');
  assert.deepEqual(workflow.outputs.map(output => output.valueType), ['mesh']);
  const inputs = createStageDefaultInputs(workflow);
  assert.equal(inputs.target_faces, 5000);
  assert.equal(inputs.allow_seam_breaking, false);
  assert.equal('mesh' in inputs, false, 'a file input takes a binding, never a manual value');
});

test('a stage from before actions existed is still a ComfyUI stage', () => {
  const legacy = { id: 's', name: '', workflowId: 2, inputs: {}, bindings: {} };
  assert.equal(getStageWorkflow(legacy, WORKFLOWS).name, 'Image to Mesh');
  assert.equal(getStageWorkflow({ ...legacy, workflowId: '' }, WORKFLOWS), null);
});

test('a bake reaches two stages back for its high poly', () => {
  const stages = chain('optimize', 'bake');
  const bake = stages[3];
  assert.deepEqual(bake.bindings.low_poly, { source: 'stage', stageId: stages[2].id });
  assert.deepEqual(bake.bindings.high_poly, { source: 'stage', stageId: 'stg-mesh' });
});

test('a bake after Auto UV bakes onto the unwrapped mesh FROM the generated one', () => {
  // Auto UV moves no vertex, so the optimized mesh is the same shape as the
  // unwrapped one: the high poly has to come from before the Optimize.
  const stages = chain('optimize', 'autouv', 'bake');
  const bake = stages[4];
  assert.deepEqual(bake.bindings.low_poly, { source: 'stage', stageId: stages[3].id });
  assert.deepEqual(bake.bindings.high_poly, { source: 'stage', stageId: 'stg-mesh' });
  const config = normalizeBatchConfig({ variables: [], groups: [{ id: 'g', name: 'Knight', values: {} }], stages });
  assert.deepEqual(validateBatch({ config, workflowsById: WORKFLOWS }), [], 'no rebinding needed');
});

test('Auto UV seeds the Mesh Editor defaults and needs the Mesh Tools service', () => {
  const stage = seededStage('autouv', chain());
  assert.equal(stage.inputs.resolution, 1024);
  assert.equal(stage.inputs.method, 'auto');
  assert.equal(stage.inputs.preserve_normals, true);
  assert.deepEqual(stage.bindings.mesh, { source: 'stage', stageId: 'stg-mesh' });
  assert.deepEqual(getStageDesktopServices(stage), ['meshtools']);
});

test('Optimize needs Mesh Tools only when its re-unwrap can fire', () => {
  const optimize = seededStage('optimize', chain());
  assert.equal(optimize.inputs.auto_uv_if_broken, true, 'on by default for a new stage');
  assert.deepEqual(getStageDesktopServices(optimize), [], 'seams are protected by default, so -sa never runs');
  const breaking = { ...optimize, inputs: { ...optimize.inputs, allow_seam_breaking: true } };
  assert.deepEqual(getStageDesktopServices(breaking), ['meshtools']);
  assert.deepEqual(getStageDesktopServices({ ...breaking, inputs: { ...breaking.inputs, auto_uv_if_broken: false } }), []);
  // A variable may turn it on in some group, so the service is started anyway.
  const byVariable = { ...optimize, bindings: { ...optimize.bindings, allow_seam_breaking: { source: 'variable', variableId: 'v' } } };
  assert.deepEqual(getStageDesktopServices(byVariable), ['meshtools']);
});

test('an Optimize stage saved before the re-unwrap existed keeps its behaviour', () => {
  const stages = chain('optimize');
  delete stages[2].inputs.auto_uv_if_broken;
  const { inputs } = resolveStageInputs({
    stage: stages[2],
    workflow: getStageWorkflow(stages[2], WORKFLOWS),
    group: { id: 'g', values: {} },
    variables: [],
    stageOutputs: { 'stg-mesh': { id: 44, type: 'mesh' } },
    stages
  });
  assert.equal(inputs.auto_uv_if_broken, false);
});

test('a first-stage bake takes two different mesh variables', () => {
  const variables = [{ id: 'v-low', name: 'Low', type: 'mesh' }, { id: 'v-high', name: 'High', type: 'mesh' }];
  const bindings = createStageDefaultBindings(getBatchActionDescriptor('bake'), [], 0, variables);
  assert.equal(bindings.low_poly.variableId, 'v-low');
  assert.equal(bindings.high_poly.variableId, 'v-high');
});

test('a complete action chain validates clean', () => {
  const config = normalizeBatchConfig({
    variables: [],
    groups: [{ id: 'g', name: 'Knight', values: {} }],
    stages: chain('optimize', 'autorig', 'bake')
  });
  // Seeding bound the bake to the two stages before it, which are Optimize and
  // Auto Rig — point the high poly back at the generated mesh, as a user would.
  config.stages[4].bindings.high_poly = { source: 'stage', stageId: 'stg-mesh' };
  assert.deepEqual(validateBatch({ config, workflowsById: WORKFLOWS }).map(problem => problem.message), []);
});

test('an action fed by an image-producing stage is reported before the run', () => {
  const stages = chain('optimize');
  stages[2].bindings.mesh = { source: 'stage', stageId: 'stg-img' };
  const problems = validateBatch({ config: { groups: [{ id: 'g', values: {} }], stages }, workflowsById: WORKFLOWS });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /Stage 1 produces an image, not a mesh/);
});

test('a bake of a mesh onto itself, or with no usable maps, is refused', () => {
  const groups = [{ id: 'g', values: {} }];
  const same = chain('bake');
  same[2].bindings.high_poly = { ...same[2].bindings.low_poly };
  assert.match(validateBatch({ config: { groups, stages: same }, workflowsById: WORKFLOWS })[0].message, /same mesh/);

  const none = chain('bake');
  none[2].bindings.high_poly = { source: 'stage', stageId: 'stg-mesh' };
  none[2].bindings.low_poly = { source: 'stage', stageId: 'stg-img' };
  none[2].inputs = { ...none[2].inputs, bake_normal: false, bake_ao: false };
  const messages = validateBatch({ config: { groups, stages: none }, workflowsById: WORKFLOWS }).map(problem => problem.message);
  assert.ok(messages.some(message => /Pick at least one map/.test(message)));
});

test('a lone roughness bake is refused: glTF has nowhere to put it', () => {
  const stages = chain('optimize', 'bake');
  stages[3].inputs = { ...stages[3].inputs, bake_normal: false, bake_ao: false, bake_roughness: true };
  const messages = validateBatch({ config: { groups: [{ id: 'g', values: {} }], stages }, workflowsById: WORKFLOWS })
    .map(problem => problem.message);
  assert.ok(messages.some(message => /Roughness alone/.test(message)), messages.join('\n'));
  // With AO it packs into the ORM texture, which is fine.
  stages[3].inputs.bake_ao = true;
  assert.deepEqual(validateBatch({ config: { groups: [{ id: 'g', values: {} }], stages }, workflowsById: WORKFLOWS }), []);
});

test('the target face count can come from a group variable', () => {
  const stages = chain('optimize');
  stages[2].bindings.target_faces = { source: 'variable', variableId: 'v-faces' };
  const variables = [{ id: 'v-faces', name: 'Faces', type: 'number' }];
  const { inputs, missing } = resolveStageInputs({
    stage: stages[2],
    workflow: getStageWorkflow(stages[2], WORKFLOWS),
    group: { id: 'g', values: { 'v-faces': '1200' } },
    variables,
    stageOutputs: { 'stg-mesh': { id: 44, type: 'mesh' } },
    stages
  });
  assert.deepEqual(missing, []);
  assert.equal(inputs.target_faces, 1200);
  assert.equal(inputs.mesh, 'asset:44');
});

test('a bake result is filed under the LOW poly, never the high poly', () => {
  const stages = chain('optimize', 'bake');
  const bake = { ...stages[3], bindings: { ...stages[3].bindings, high_poly: { source: 'stage', stageId: 'stg-mesh' } } };
  const parent = findParentAssetForStage({
    stage: bake,
    workflow: getStageWorkflow(bake, WORKFLOWS),
    stageOutputs: { 'stg-mesh': { id: 10, type: 'mesh' }, [stages[2].id]: { id: 20, type: 'mesh' } },
    group: { id: 'g', values: {} }
  });
  assert.equal(parent.id, 20);
});

// --- baked maps -> glTF ----------------------------------------------------

test('baked maps land in the material, factors reset where a map now drives them', () => {
  const { buffer, applied } = applyBakedMapsToGlb(tinyGlb(), {
    normal: png('normal'),
    orm: png('orm'),
    base_color: png('albedo')
  }, { ormChannels: ['ao', 'roughness'] });
  const { json, bin } = parseGlb(buffer);
  const material = json.materials[0];

  assert.deepEqual(applied, ['normal', 'packed ao/roughness', 'base colour']);
  assert.equal(json.textures.length, 3);
  assert.equal(material.occlusionTexture.index, material.pbrMetallicRoughness.metallicRoughnessTexture.index, 'one ORM texture for both slots');
  assert.equal(material.pbrMetallicRoughness.roughnessFactor, 1);
  assert.equal(material.pbrMetallicRoughness.metallicFactor, undefined, 'metallic was not baked, so its factor is left alone');
  assert.deepEqual(material.pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 0.8], 'tint cleared, alpha kept');

  // The images really are in the binary chunk, 4-byte aligned, after the mesh.
  const albedo = json.images[json.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
  const view = json.bufferViews[albedo.bufferView];
  assert.equal(view.byteOffset % 4, 0);
  assert.equal(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength).toString('latin1'), png('albedo').toString('latin1'));
  assert.equal(json.bufferViews[0].byteLength, 36, 'the geometry is untouched');
  assert.ok(json.buffers[0].byteLength <= bin.length);
});

test('a primitive with no material is given one to carry the maps', () => {
  const { buffer } = applyBakedMapsToGlb(tinyGlb({ materials: [] }), { ao: png('ao') });
  const { json } = parseGlb(buffer);
  assert.equal(json.meshes[0].primitives[0].material, 0);
  assert.equal(json.materials[0].occlusionTexture.index, 0);
});

// --- transfer rig ------------------------------------------------------------

test('a Transfer Rig takes its target from the stage before it and its rig from the nearest Auto Rig', () => {
  // gen -> autorig -> optimize -> bake -> transferrig
  const stages = chain('autorig', 'optimize', 'bake');
  const stage = seededStage('transferrig', stages);
  assert.deepEqual(stage.bindings.mesh, { source: 'stage', stageId: stages[4].id }, 'the target is the baked low poly');
  assert.deepEqual(stage.bindings.rig_source, { source: 'stage', stageId: stages[2].id }, 'the rig is the Auto Rig, however far back');
  assert.equal(stage.inputs.smooth_iters, 2);

  assert.equal(getBatchActionDescriptor('transferrig').desktopService, null, 'nothing to start: the transfer runs in the backend');
  assert.deepEqual(getStageDesktopServices(stage), []);
});

test('with no rig upstream a Transfer Rig source falls back to a mesh variable, never to the last stage', () => {
  const stages = chain('optimize');
  const descriptor = getBatchActionDescriptor('transferrig');
  const variables = [{ id: 'var-rig', name: 'rig', type: 'mesh' }];
  const bindings = createStageDefaultBindings(descriptor, stages, stages.length, variables);
  assert.deepEqual(bindings.mesh, { source: 'stage', stageId: stages[2].id });
  assert.deepEqual(bindings.rig_source, { source: 'variable', variableId: 'var-rig' });

  const unbound = createStageDefaultBindings(descriptor, stages, stages.length, []);
  assert.equal(unbound.rig_source, undefined, 'left for the user to bind rather than guessed');
});

test('validation refuses a Transfer Rig onto a mesh that already has a rig, or onto its own source', () => {
  const stages = chain('autorig');
  const transfer = { ...seededStage('transferrig', stages), id: 'stg-transfer' };
  transfer.bindings.mesh = { source: 'stage', stageId: stages[2].id };
  const config = { version: 1, variables: [], groups: [{ id: 'grp-a', name: '', values: {} }], stages: [...stages, transfer] };
  const problems = validateBatch({ config, workflowsById: WORKFLOWS }).map(problem => problem.message);
  assert.ok(problems.some(message => /already has a skeleton/.test(message)), problems.join('\n'));
  assert.ok(problems.some(message => /the target and the rig source are the same mesh/.test(message)), problems.join('\n'));

  transfer.bindings.mesh = { source: 'stage', stageId: 'stg-mesh' };
  assert.deepEqual(validateBatch({ config, workflowsById: WORKFLOWS }), [], 'the generated mesh before the rig is a fine target');
});

test('a Transfer Rig cell runs the real transfer, saves a version of its target and says what it did not carry', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'Knight low', filename: 'meshes/5.glb' });
  state.assets.set(6, { id: 6, type: 'mesh', name: 'Knight rigged', filename: 'meshes/6.glb' });
  // The source is the target at twice the size: the transfer scales it on.
  api.fetchAssetBuffer = async file => (file === 'meshes/6.glb' ? riggedGlb({ clips: 2, scale: 2 }) : tinyGlb());
  useRealTransfer(state, api);

  const outcome = await executeBatchAction(api, {
    action: 'transferrig',
    projectId: 7,
    inputs: { mesh: 'asset:5', rig_source: 'asset:6', smooth_iters: 1 },
    name: 'Knight low rigged',
    cardKey: 'batch:r:g:s'
  });

  assert.deepEqual(state.toolCalls, [{ path: '/meshes/transfer-rig', options: { smooth_iters: 1 } }]);
  assert.equal(state.saves[0].assetId, 5, 'filed under the target, not the rig source');
  const saved = parseGlb(state.saves[0].bytes).json;
  assert.equal(saved.skins.length, 1);
  assert.notEqual(saved.meshes[0].primitives[0].attributes.JOINTS_0, undefined);
  assert.equal(saved.materials[0].name, 'Skin', 'the target material comes through untouched');
  assert.equal(outcome.stats.bones, 1);
  assert.equal(outcome.stats.rescaled, 0.5);
  assert.ok(outcome.warnings.some(warning => /2\.00x the size/.test(warning)), outcome.warnings.join('\n'));
  assert.ok(outcome.warnings.some(warning => /2 animation clips were not copied/.test(warning)), outcome.warnings.join('\n'));
  assert.equal(state.cards[0].column, 'Rigging');
});

test('a Transfer Rig onto a mesh that already has a rig fails the cell with the transfer\'s own reason', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'rigged', filename: 'meshes/5.glb' });
  state.assets.set(6, { id: 6, type: 'mesh', name: 'rig', filename: 'meshes/6.glb' });
  api.fetchAssetBuffer = async () => riggedGlb();
  useRealTransfer(state, api);
  await assert.rejects(
    executeBatchAction(api, { action: 'transferrig', projectId: 7, inputs: { mesh: 'asset:5', rig_source: 'asset:6' }, name: 'x', cardKey: 'batch:r:g:s' }),
    /already rigged/
  );
  assert.equal(state.saves.length, 0);
  assert.equal(state.cards.length, 0);
});

// --- a whole run -----------------------------------------------------------

function createBackend(stages) {
  const state = {
    config: {
      version: 1,
      variables: [],
      groups: [{ id: 'grp-a', name: 'Knight', values: {} }],
      stages,
      executionOrder: 'group'
    },
    assets: new Map(),
    comfyRuns: [],
    toolCalls: [],
    saves: [],
    cards: [],
    linked: [],
    listeners: new Map(),
    nextAssetId: 100,
    failTool: null,
    // Extra stats the fake gltfpack reports (seams_broken, seam_limited).
    optimizeStats: {},
    autoUvTool: { n_charts: 12, fill_ratio: 0.71, overlap_share: 0, flipped_triangles: 0 },
    retopoTool: {
      metrics: {
        topology: { faces: 6000, vertices: 3002, watertight: true, components: 1 },
        triangle_quality: { pct_well_shaped: 92.2 }
      },
      quad_face_count: null
    },
    inputMesh: null,
    flattenTargets: [],
    flattenClipped: 0
  };

  const addAsset = (asset) => {
    const record = { filename: `meshes/${asset.id}.glb`, ...asset };
    state.assets.set(record.id, record);
    return record;
  };

  const api = {
    async apiJson(method, path, { body, query } = {}) {
      if (method === 'GET' && /^\/projects\/\d+$/.test(path)) return { id: 7, name: 'Batch', preset: 'Batch' };
      if (method === 'GET' && path === '/library/comfy-workflows') return Object.values(WORKFLOWS);
      // Continue's scan asks for children; findProjectAsset does not.
      if (method === 'GET' && path === '/assets') return query?.includeChildren ? [] : [...state.assets.values()];
      if (method === 'POST' && path === '/cards') { state.cards.push(body); return { id: state.cards.length }; }
      if (method === 'PUT' && /\/batch-cards\//.test(path)) {
        state.linked.push({ cardKey: decodeURIComponent(path.split('/')[4]), assetId: body.assetId });
        return {};
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async apiForm(method, path, form) {
      if (path === '/comfyui/workflows/run') {
        const run = { workflowId: Number(form.get('workflowId')), promptId: form.get('promptId'), name: form.get('name'), inputs: JSON.parse(form.get('inputValues')) };
        state.comfyRuns.push(run);
        setImmediate(() => {
          const asset = addAsset({ id: state.nextAssetId++, type: run.workflowId === 1 ? 'image' : 'mesh', name: run.name });
          state.listeners.get(run.promptId)?.({ promptId: run.promptId, status: 'completed', done: true, result: [asset] });
        });
        return { status: 'queued' };
      }
      if (path === '/meshes/optimize') {
        const options = JSON.parse(form.get('options'));
        state.toolCalls.push({ path, options });
        if (state.failTool === path) throw new Error('gltfpack binary not found');
        return { mesh_b64: tinyGlb().toString('base64'), stats: { triangles: options.target_faces, input_triangles: 90000, target_faces: options.target_faces, ...state.optimizeStats } };
      }
      if (path === '/meshes/editor/save') {
        const save = { assetId: Number(form.get('assetId')), name: form.get('name'), saveMode: form.get('saveMode'), source: form.get('source'), bytes: Buffer.from(await form.get('meshFile').arrayBuffer()) };
        state.saves.push(save);
        return addAsset({ id: state.nextAssetId++, type: 'mesh', name: save.name, parentAssetId: save.assetId });
      }
      throw new Error(`unexpected form ${path}`);
    },
    async apiFormSse(path, form, onProgress) {
      const options = JSON.parse(form.get('options'));
      state.toolCalls.push({ path, options });
      onProgress({ type: 'progress', frac: 0.5, message: 'half way' });
      if (path === '/meshes/rig') return { type: 'done', mesh_b64: tinyGlb().toString('base64'), stats: { bones: 52 } };
      if (path === '/meshes/auto-uv') {
        // Marked by its material so a test can tell the unwrapped mesh was saved.
        const unwrapped = tinyGlb({ materials: [{ name: 'autouv', pbrMetallicRoughness: {} }] });
        return { type: 'done', mesh_b64: unwrapped.toString('base64'), stats: { tool: state.autoUvTool } };
      }
      if (path === '/meshes/auto-retopo') {
        const retopo = tinyGlb({ materials: [{ name: 'autoretopo', pbrMetallicRoughness: {} }] });
        // Shaped like the live route: the service's stats sit under `tool`, and
        // the triangle metrics are `triangle_quality`. Verified against a real
        // POST to /api/meshes/auto-retopo — a mock that nested them one level
        // higher passed happily over a runner that read nothing.
        return {
          type: 'done',
          mesh_b64: retopo.toString('base64'),
          stats: { vertex_count: 3002, face_count: 6000, has_uv: false, tool: state.retopoTool }
        };
      }
      if (path === '/meshes/flatten') {
        const meshFile = Buffer.from(await form.get('meshFile').arrayBuffer());
        state.flattenTargets.push(meshFile);
        return { type: 'done', maps: { albedo: png('albedo').toString('base64') }, stats: { tool: { has_alpha: false, clipped_frac: state.flattenClipped } } };
      }
      if (path === '/meshes/bake') {
        return {
          type: 'done',
          maps: { normal: png('n').toString('base64'), ao: png('ao').toString('base64') },
          stats: { tool: { coverage: 0.62, resolution: options.resolution, orm_channels: [] } }
        };
      }
      throw new Error(`unexpected sse ${path}`);
    },
    async fetchAssetBuffer() { return state.inputMesh || tinyGlb(); }
  };

  const runner = createBatchRunner({
    api,
    subscribeProgress: (promptId, onData) => {
      state.listeners.set(promptId, onData);
      return { close: () => state.listeners.delete(promptId) };
    },
    logger: { warn() {}, error() {} }
  });
  return { state, runner, api };
}

async function settle(runner) {
  for (let i = 0; i < 1000; i += 1) {
    const run = runner.get(7);
    if (run && !isActiveBatchRun(run)) return run;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('the run never settled');
}

test('a run chains a generated mesh through Optimize, Auto Rig and Bake', async () => {
  const stages = chain('optimize', 'autorig', 'bake');
  stages[2].name = 'Knight low';
  stages[4].bindings.high_poly = { source: 'stage', stageId: 'stg-mesh' };
  const { state, runner } = createBackend(stages);

  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);

  assert.equal(run.status, 'completed');
  assert.deepEqual(Object.values(run.cells).map(cell => cell.status), ['completed', 'completed', 'completed', 'completed', 'completed']);
  assert.equal(state.comfyRuns.length, 2, 'only the ComfyUI stages went to ComfyUI');
  assert.deepEqual(state.toolCalls.map(call => call.path), ['/meshes/optimize', '/meshes/rig', '/meshes/bake']);

  // Optimize asks for a face count, with the error budget turned from % to a fraction.
  assert.equal(state.toolCalls[0].options.target_faces, 5000);
  assert.equal(state.toolCalls[0].options.simplify_error, 0.05);
  assert.equal(state.toolCalls[2].options.require_overlap, 0.5);
  assert.deepEqual(state.toolCalls[2].options.maps, ['normal', 'ao']);

  // Each action saved a VERSION of the mesh it was given, named by its stage.
  const meshId = run.cells['grp-a:stg-mesh'].assetId;
  const optimizedId = run.cells[`grp-a:${stages[2].id}`].assetId;
  const riggedId = run.cells[`grp-a:${stages[3].id}`].assetId;
  assert.deepEqual(state.saves.map(save => save.assetId), [meshId, optimizedId, riggedId],
    'the bake is filed under its low poly (the rigged mesh), not the high poly');
  assert.ok(state.saves.every(save => save.saveMode === 'version' && save.source === 'BATCH'));
  assert.equal(state.saves[0].name, 'Knight low');

  // The baked maps are inside the saved GLB.
  const baked = parseGlb(state.saves[2].bytes).json;
  assert.ok(baked.materials[0].normalTexture && baked.materials[0].occlusionTexture);

  // One card per action cell, in its Kanban column, and every result linked.
  assert.deepEqual(state.cards.map(card => card.column), ['Mesh Edit', 'Rigging', 'Texturing']);
  assert.equal(state.cards[0].cardId, `batch:${run.runId}:grp-a:${stages[2].id}`);
  assert.equal(state.linked.length, 5);

  // A bake that reached little of the UVs lands, flagged.
  assert.match(run.cells[`grp-a:${stages[4].id}`].warning, /62%/);
});

test('a failed action is a failed cell, leaves no card, and blocks only its own row', async () => {
  const stages = chain('optimize', 'autorig');
  const { state, runner } = createBackend(stages);
  state.failTool = '/meshes/optimize';

  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);

  const optimize = run.cells[`grp-a:${stages[2].id}`];
  assert.equal(optimize.status, 'error');
  assert.equal(optimize.error, 'gltfpack binary not found');
  assert.equal(state.cards.length, 0);
  assert.equal(run.cells[`grp-a:${stages[3].id}`].status, 'error', 'the rig has nothing to consume');
  assert.equal(state.toolCalls.filter(call => call.path === '/meshes/rig').length, 0);
});

test('an aggressive Optimize re-unwraps the result, and a Bake gets the unwrapped mesh', async () => {
  const stages = chain('optimize', 'bake');
  stages[2].inputs = { ...stages[2].inputs, allow_seam_breaking: true, aggressive: true };
  const { state, runner } = createBackend(stages);
  state.optimizeStats = { seams_broken: true };

  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);

  assert.equal(run.status, 'completed');
  assert.deepEqual(state.toolCalls.map(call => call.path), ['/meshes/optimize', '/meshes/auto-uv', '/meshes/bake']);
  assert.equal(state.toolCalls[1].options.resolution, 1024, 'the re-unwrap runs Auto UV at its defaults');
  assert.equal(state.toolCalls[1].options.hide_seams, true);
  // What Optimize saved is the unwrapped mesh, so that is what the Bake read.
  assert.equal(parseGlb(state.saves[0].bytes).json.materials[0].name, 'autouv');
  const cell = run.cells[`grp-a:${stages[2].id}`];
  assert.match(cell.warning, /re-unwrapped \(12 islands\)/);
});

test('with the re-unwrap off, broken seams are reported and nothing else runs', async () => {
  const stages = chain('optimize');
  stages[2].inputs = { ...stages[2].inputs, allow_seam_breaking: true, aggressive: true, auto_uv_if_broken: false };
  const { state, runner } = createBackend(stages);
  state.optimizeStats = { seams_broken: true };

  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);

  assert.deepEqual(state.toolCalls.map(call => call.path), ['/meshes/optimize']);
  assert.match(run.cells[`grp-a:${stages[2].id}`].warning, /Re-unwrap UVs if seams break/);
});

test('the re-unwrap does not run when the seams held', async () => {
  const stages = chain('optimize');
  const { state, runner } = createBackend(stages);
  await runner.start(7, { config: state.config, mode: 'restart' });
  await settle(runner);
  assert.deepEqual(state.toolCalls.map(call => call.path), ['/meshes/optimize']);
});

test('an Auto UV stage sends its own settings and flags an overlapping layout and a lost rig', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'knight', filename: 'meshes/5.glb' });
  state.inputMesh = skinnedGlb();
  state.autoUvTool = { n_charts: 30, overlap_share: 0.024, flipped_triangles: 0 };

  const outcome = await executeBatchAction(api, {
    action: 'autouv',
    projectId: 7,
    inputs: { mesh: 'asset:5', resolution: 2048, method: 'lscm', hide_seams: false },
    name: 'Knight UV',
    cardKey: 'batch:r:g:s'
  });

  const options = state.toolCalls[0].options;
  assert.equal(state.toolCalls[0].path, '/meshes/auto-uv');
  assert.equal(options.resolution, 2048);
  assert.equal(options.method, 'lscm');
  assert.equal(options.hide_seams, false);
  assert.equal(options.max_cone_deg, 50, 'unset inputs fall back to the defaults');
  assert.equal('mesh' in options, false, 'the mesh goes as the file, not as an option');
  assert.equal(outcome.stats.charts, 30);
  assert.ok(outcome.warnings.some(warning => /2\.4% of the UV layout/.test(warning)), outcome.warnings.join('\n'));
  assert.ok(outcome.warnings.some(warning => /rig was dropped/.test(warning)));
  assert.equal(state.saves[0].assetId, 5, 'saved as a version of its input');
  assert.equal(state.cards[0].column, 'Mesh Edit');
});

test('Auto Retopo seeds the Mesh Editor defaults and needs the Mesh Tools service', () => {
  const stage = seededStage('autoretopo', chain());
  assert.equal(stage.inputs.target_faces, 6000);
  assert.equal(stage.inputs.shell_resolution, 256);
  assert.equal(stage.inputs.shell_smooth, 0.4, 'the measured default, not the old 1.4');
  assert.equal(stage.inputs.device, 'auto');
  assert.deepEqual(stage.bindings.mesh, { source: 'stage', stageId: 'stg-mesh' });
  assert.deepEqual(getStageDesktopServices(stage), ['meshtools']);
});

test('a bake after Auto Retopo bakes FROM the original, because retopo moves every vertex', () => {
  // The opposite of the Auto UV case above: retopo rebuilds the surface, so its
  // result is the low poly and the high poly must come from before it.
  const stages = chain('autoretopo', 'bake');
  const bake = stages[3];
  assert.deepEqual(bake.bindings.low_poly, { source: 'stage', stageId: stages[2].id });
  assert.deepEqual(bake.bindings.high_poly, { source: 'stage', stageId: 'stg-mesh' });
});

test('an Auto Retopo stage sends its own settings and flags what the rebuild drops', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'knight', filename: 'meshes/5.glb' });

  const outcome = await executeBatchAction(api, {
    action: 'autoretopo',
    projectId: 7,
    inputs: { mesh: 'asset:5', target_faces: 12000, shell_smooth: 1.4, preserve_features: true },
    name: 'Knight retopo',
    cardKey: 'batch:r:g:s'
  });

  const options = state.toolCalls[0].options;
  assert.equal(state.toolCalls[0].path, '/meshes/auto-retopo');
  assert.equal(options.target_faces, 12000);
  assert.equal(options.shell_smooth, 1.4, 'a hard-surface stage may raise it back');
  assert.equal(options.preserve_features, true);
  assert.equal(options.shell_resolution, 256, 'unset inputs fall back to the defaults');
  assert.equal(options.device, 'auto');
  assert.equal('mesh' in options, false, 'the mesh goes as the file, not as an option');
  assert.equal(outcome.stats.faces, 6000);
  assert.equal(outcome.stats.components, 1);
  assert.ok(outcome.warnings.some(warning => /UVs, the texture and any rig are gone/.test(warning)), outcome.warnings.join('\n'));
  assert.equal(state.saves[0].assetId, 5, 'saved as a version of its input');
  assert.equal(state.cards[0].column, 'Mesh Edit');
});

test('Auto Retopo warns when the shell could not close or unify the mesh', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'broken', filename: 'meshes/5.glb' });
  state.retopoTool = {
    metrics: {
      topology: { faces: 5900, vertices: 2950, watertight: false, components: 4 },
      triangle_quality: { pct_well_shaped: 88 }
    },
    quad_face_count: null
  };

  const outcome = await executeBatchAction(api, {
    action: 'autoretopo',
    projectId: 7,
    inputs: { mesh: 'asset:5' },
    name: 'Broken retopo',
    cardKey: 'batch:r:g:s'
  });

  assert.ok(outcome.warnings.some(warning => /not watertight/.test(warning)), outcome.warnings.join('\n'));
  assert.ok(outcome.warnings.some(warning => /in 4 pieces/.test(warning)));
});

test('an action refuses an input that is not a mesh', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'image', name: 'concept', filename: 'images/5.png' });
  await assert.rejects(
    executeBatchAction(api, { action: 'autorig', projectId: 7, inputs: { mesh: 'asset:5' }, name: 'x', cardKey: 'batch:r:g:s' }),
    /is an image, not a mesh/
  );
  assert.equal(state.cards.length, 0);
});

test('a Flatten stage seeds the Export dialog defaults and needs the Mesh Tools service', () => {
  const stages = chain('flatten');
  const flatten = stages[2];
  assert.deepEqual(
    { shader: flatten.inputs.shader, resolution: flatten.inputs.resolution, samples: flatten.inputs.samples, exposure: flatten.inputs.exposure },
    { shader: 'unlit', resolution: 2048, samples: 64, exposure: 0 }
  );
  assert.deepEqual(flatten.bindings.mesh, { source: 'stage', stageId: 'stg-mesh' });
  assert.deepEqual(getStageDesktopServices(flatten), ['meshtools']);
  assert.equal(getBatchActionDescriptor('flatten').kanbanColumn, 'Texturing');
  assert.deepEqual(validateBatch({ config: normalizeBatchConfig({ variables: [], groups: [{ id: 'g', name: 'A', values: {} }], stages }), workflowsById: WORKFLOWS }), []);
});

test('a Bake after a Flatten still reaches past it for the high poly', () => {
  // generate -> optimize -> flatten -> bake: the flatten moved no vertex, so the
  // high poly is the generated mesh, as it is after an Auto UV.
  const stages = chain('optimize', 'flatten', 'bake');
  const bake = stages[4];
  assert.deepEqual(bake.bindings.low_poly, { source: 'stage', stageId: stages[3].id });
  assert.deepEqual(bake.bindings.high_poly, { source: 'stage', stageId: 'stg-mesh' });
});

test('a Flatten cell bakes through the packed atlas and saves one unlit albedo material', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'knight', filename: 'meshes/knight.glb' });
  state.inputMesh = riggedGlb({ clips: 1 });
  state.flattenClipped = 0.25;

  const outcome = await executeBatchAction(api, {
    action: 'flatten',
    projectId: 7,
    inputs: { mesh: 'asset:5', shader: 'unlit', resolution: 1024, samples: 32, exposure: -0.5 },
    name: 'Knight flat',
    cardKey: 'batch:r:g:s'
  });

  assert.equal(state.toolCalls[0].path, '/meshes/flatten');
  assert.deepEqual(state.toolCalls[0].options, { resolution: 1024, samples: 32, lighting: 'studio', exposure: -0.5, atlas_uv: 1 });
  const target = parseGlb(state.flattenTargets[0]).json;
  assert.notEqual(target.meshes[0].primitives[0].attributes.TEXCOORD_1, undefined, 'the bake target carries the atlas');
  assert.equal(target.animations, undefined);

  const saved = parseGlb(state.saves[0].bytes).json;
  assert.equal(state.saves[0].assetId, 5, 'saved as a version of its input');
  assert.equal(saved.materials.length, 1);
  assert.equal(saved.materials[0].name, 'knight_flat');
  assert.deepEqual(saved.materials[0].extensions, { KHR_materials_unlit: {} });
  assert.equal(saved.skins.length, 1, 'the rig survives');
  assert.equal(saved.animations.length, 1, 'and so do its clips');
  assert.equal(state.cards[0].column, 'Texturing');

  assert.equal(outcome.stats.materials, 1);
  assert.equal(outcome.stats.unmapped, 1);
  assert.ok(outcome.warnings.some(warning => /mapped one by one/.test(warning)), outcome.warnings.join('\n'));
  assert.ok(outcome.warnings.some(warning => /25% of the albedo hit the highlight roll-off/.test(warning)), outcome.warnings.join('\n'));
});

test('a simple-lit Flatten bakes the soft preset and saves a plain lit material', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'mesh', name: 'crate', filename: 'meshes/crate.glb' });
  await executeBatchAction(api, {
    action: 'flatten',
    projectId: 7,
    inputs: { mesh: 'asset:5', shader: 'lit', resolution: 512, samples: 16, exposure: 0 },
    name: 'Crate flat',
    cardKey: 'batch:r:g:s'
  });
  assert.equal(state.toolCalls[0].options.lighting, 'soft');
  const saved = parseGlb(state.saves[0].bytes).json;
  assert.equal(saved.materials[0].extensions, undefined);
  assert.equal(state.flattenTargets.length, 1);
});

for (const [name, fn] of queued) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL ${name}\n`, err);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${queued.length} batch action tests passed`);
