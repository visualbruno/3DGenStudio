// node batch/actions.test.mjs
//
// Built-in batch actions (Optimize / Auto Rig / Bake): the document rules that
// let them ride the workflow-shaped binding model, the glTF material patch that
// applies a bake without a browser, and a whole backend run that chains a
// ComfyUI mesh into Optimize, Auto Rig and Bake — against a fake backend.
import assert from 'node:assert/strict';
import {
  createStage,
  createStageDefaultBindings,
  createStageDefaultInputs,
  findParentAssetForStage,
  getStageWorkflow,
  getBatchActionDescriptor,
  normalizeBatchConfig,
  resolveStageInputs,
  validateBatch
} from './document.js';
import { applyBakedMapsToGlb, executeBatchAction } from './actionRunner.js';
import { createBatchRunner, isActiveBatchRun } from './runner.js';
import { parseGlb, serializeGlb } from '../meshPivot.js';

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
    failTool: null
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
        return { mesh_b64: tinyGlb().toString('base64'), stats: { triangles: options.target_faces, input_triangles: 90000, target_faces: options.target_faces } };
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
      if (path === '/meshes/bake') {
        return {
          type: 'done',
          maps: { normal: png('n').toString('base64'), ao: png('ao').toString('base64') },
          stats: { tool: { coverage: 0.62, resolution: options.resolution, orm_channels: [] } }
        };
      }
      throw new Error(`unexpected sse ${path}`);
    },
    async fetchAssetBuffer() { return tinyGlb(); }
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

test('an action refuses an input that is not a mesh', async () => {
  const { state, api } = createBackend([]);
  state.assets.set(5, { id: 5, type: 'image', name: 'concept', filename: 'images/5.png' });
  await assert.rejects(
    executeBatchAction(api, { action: 'autorig', projectId: 7, inputs: { mesh: 'asset:5' }, name: 'x', cardKey: 'batch:r:g:s' }),
    /is an image, not a mesh/
  );
  assert.equal(state.cards.length, 0);
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
