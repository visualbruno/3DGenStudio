// node mcp/batch.test.mjs
//
// The agent-facing surface of a Batch project, tested through the REAL
// registered handlers: a stub server captures the registrations, a fake backend
// answers the REST calls out of memory, and the tests call what an MCP client
// would call.
//
// WHY THIS FILE EXISTS. Everything a batch does that can go quietly wrong is a
// TRANSLATION: names and positions in, generated ids out. An id regenerated
// where it should have been kept silently orphans a grid's results; a binding
// that survives a reorder and now points forwards makes a stage read a stage
// that has not run; a variable retyped across kinds leaves values that resolve
// to something nobody asked for. None of those fail loudly — the document
// saves, the page opens, and the batch produces the wrong thing on the next run.
//
// The run is covered too, against a fake ComfyUI: what it SKIPS is as important
// as what it generates, because "continue" is what makes a half-finished grid
// cheap to finish.
import assert from 'node:assert/strict';
import { registerBatchTools } from './tools/batch.js';

let passed = 0;
const queued = [];
function test(name, fn) { queued.push([name, fn]); }

// --- the fake backend --------------------------------------------------------

const WORKFLOWS = [
  {
    id: 1,
    name: 'Text to Image',
    parameters: [
      { id: '6.text', name: 'Prompt', valueType: 'string', defaultValue: 'a robot' },
      { id: '7.seed', name: 'Seed', valueType: 'number', defaultValue: 0 }
    ],
    outputs: [{ nodeId: '9', name: 'Image', valueType: 'image' }]
  },
  {
    id: 2,
    name: 'Image to Mesh',
    parameters: [
      { id: '3.image', name: 'Source Image', valueType: 'image' },
      { id: '4.steps', name: 'Steps', valueType: 'number', defaultValue: 30 }
    ],
    outputs: [{ nodeId: '8', name: 'Mesh', valueType: 'mesh' }]
  },
  {
    id: 3,
    name: 'Texture Mesh',
    parameters: [
      { id: '2.image', name: 'Reference', valueType: 'image' },
      { id: '5.mesh', name: 'Mesh', valueType: 'mesh' }
    ],
    outputs: [{ nodeId: '9', name: 'Mesh', valueType: 'mesh' }]
  },
  // Text-only: the Batch page never offers it, so neither may the tools.
  {
    id: 4,
    name: 'Caption',
    parameters: [{ id: '1.text', name: 'Prompt', valueType: 'string' }],
    outputs: [{ nodeId: '2', name: 'Caption', valueType: 'string' }]
  }
];

function createBackend({ preset = 'Batch' } = {}) {
  const state = {
    config: null,
    assets: [],          // project assets, as GET /assets returns them
    library: new Map(),  // assetId -> record, for the link route
    runs: [],            // every run the batch submitted
    linkedCards: [],
    nextAssetId: 100
  };

  // What a submitted run produces. Overridden per test.
  state.produce = (run) => [{
    id: state.nextAssetId++,
    type: run.workflowId === 1 ? 'image' : 'mesh',
    name: run.name
  }];

  const api = {
    async apiJson(method, path, { body, query } = {}) {
      if (method === 'GET' && /^\/projects\/\d+$/.test(path)) {
        return { id: 7, name: 'Batch Project', preset };
      }
      if (method === 'GET' && path.endsWith('/batch-config')) {
        return { projectId: 7, state: state.config };
      }
      if (method === 'PUT' && path.endsWith('/batch-config')) {
        state.config = body.state;
        return { projectId: 7, state: body.state };
      }
      if (method === 'GET' && path === '/library/comfy-workflows') return WORKFLOWS;
      // A built-in action looks its input mesh up by id (findProjectAsset),
      // which lists the project without asking for children.
      if (method === 'GET' && path === '/assets' && query?.includeChildren === undefined && state.meshLookup) {
        return state.meshLookup();
      }
      if (method === 'GET' && path === '/assets') {
        assert.equal(String(query?.includeChildren), 'true', 'results are cards on edits/versions too');
        return state.assets;
      }
      if (method === 'POST' && path === '/cards') {
        state.cards.push(body);
        return { id: state.cards.length };
      }
      if (method === 'POST' && /^\/projects\/\d+\/assets$/.test(path)) {
        const record = state.library.get(Number(body.assetId));
        if (!record) throw new Error('Asset not found');
        return record;
      }
      if (method === 'PUT' && /batch-cards/.test(path)) {
        state.linkedCards.push({ path, assetId: body.assetId });
        return { ok: true };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    // The run goes through executeComfyRun, which posts a FormData and waits on
    // an SSE subscription. Both are faked: the subscription hands back the
    // terminal event for the prompt the form carried.
    async apiForm(method, path, form) {
      // The built-in Optimize action: simplify, then save a version.
      if (path === '/meshes/optimize') {
        state.toolCalls.push({ path, options: JSON.parse(form.get('options')) });
        return { mesh_b64: Buffer.from('glb').toString('base64'), stats: { triangles: 800, input_triangles: 9000 } };
      }
      if (path === '/meshes/editor/save') {
        const saved = { id: state.nextAssetId++, type: 'mesh', name: form.get('name'), parentAssetId: Number(form.get('assetId')) };
        state.toolCalls.push({ path, saved });
        return saved;
      }
      assert.equal(path, '/comfyui/workflows/run');
      const run = {
        projectId: Number(form.get('projectId')),
        workflowId: Number(form.get('workflowId')),
        promptId: form.get('promptId'),
        cardId: form.get('cardId'),
        name: form.get('name'),
        parentAssetId: form.get('parentAssetId') ? Number(form.get('parentAssetId')) : null,
        autoParentFromInputs: form.get('autoParentFromInputs'),
        inputs: JSON.parse(form.get('inputValues'))
      };
      state.runs.push(run);
      const pending = state.pending.get(run.promptId);
      pending?.(run);
      return { promptId: run.promptId, status: 'queued' };
    },
    subscribeSse(path, onData) {
      const promptId = path.split('/').pop();
      state.pending.set(promptId, run => {
        const failure = state.failFor?.(run);
        if (failure === 'hang') return; // never answers → the cell times out
        setImmediate(() => onData(failure
          ? { promptId, status: 'error', detail: failure }
          : { promptId, done: true, status: 'completed', result: state.produce(run) }));
      });
      return { close: () => state.pending.delete(promptId) };
    },
    assetUrl: file => `http://127.0.0.1:3001/assets/${file}`,
    fetchAssetBuffer: async () => Buffer.from('glb')
  };

  state.pending = new Map();
  state.cards = [];
  state.toolCalls = [];
  return { state, api };
}

function createTools(backend) {
  const tools = new Map();
  registerBatchTools(
    { registerTool: (name, _spec, handler) => tools.set(name, handler) },
    { api: backend.api, notifyMutation: () => {} }
  );
  return async function call(name, args) {
    const out = await tools.get(name)(args ?? {}, {});
    const text = out?.content?.[0]?.text;
    // An error is PLAIN TEXT, not JSON.
    if (out?.isError) throw new Error(text || 'tool error');
    return text ? JSON.parse(text) : out;
  };
}

/** A batch with one string variable, two rows and a two-stage chain. */
async function chain(call) {
  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Subject', type: 'string' }],
    groups: [
      { name: 'Knight', values: { Subject: 'a knight' } },
      { name: 'Dragon', values: { Subject: 'a dragon' } }
    ],
    stages: [
      { name: '{{Subject}} concept', workflowId: 1, bindings: { '6.text': 'variable:Subject' } },
      { name: '{{Subject}} mesh', workflowId: 2, bindings: { '3.image': 'stage:1' } }
    ]
  });
}

// --- reading and writing -----------------------------------------------------

test('a chain is readable back in names and positions, with no ids', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);

  const batch = await call('get_batch', { projectId: 7 });
  assert.deepEqual(batch.problems, [], JSON.stringify(batch.problems));
  assert.equal(batch.plannedRuns, 4);
  assert.deepEqual(batch.variables, [{ name: 'Subject', type: 'string' }]);
  assert.deepEqual(batch.groups.map(group => group.values), [
    { Subject: 'a knight' }, { Subject: 'a dragon' }
  ]);

  const [first, second] = batch.stages;
  assert.equal(first.workflowName, 'Text to Image');
  assert.equal(first.parameters.find(p => p.id === '6.text').source, 'variable:Subject');
  // Seeded from the workflow's own default, or every cell reports "No value set".
  assert.equal(first.parameters.find(p => p.id === '7.seed').value, 0);
  assert.equal(second.parameters.find(p => p.id === '3.image').source, 'stage:1');

  const serialized = JSON.stringify(batch);
  for (const prefix of ['var-', 'grp-', 'stg-']) {
    assert.ok(!serialized.includes(prefix), `a document id leaked into the tool surface: ${prefix}`);
  }
});

test('a file input is wired to the stage before it without being asked', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await call('update_batch', {
    projectId: 7,
    groups: [{ name: 'One' }],
    stages: [
      { workflowId: 1, inputs: { '6.text': 'a helmet' } },
      { workflowId: 2 }
    ]
  });

  const batch = await call('get_batch', { projectId: 7 });
  assert.deepEqual(batch.problems, [], JSON.stringify(batch.problems));
  assert.equal(batch.stages[1].parameters.find(p => p.id === '3.image').source, 'stage:1');
});

test('only workflows that produce an image or a mesh may be a stage', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await assert.rejects(
    () => call('update_batch', { projectId: 7, stages: [{ workflowId: 4 }] }),
    /produce an image or a mesh/
  );
});

test('a batch tool refuses a project that is not a Batch project', async () => {
  const backend = createBackend({ preset: 'Graph' });
  const call = createTools(backend);
  await assert.rejects(() => call('get_batch', { projectId: 7 }), /Graph project/);
});

test('an image parameter cannot be given a typed-in value', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await assert.rejects(
    () => call('update_batch', {
      projectId: 7,
      stages: [{ workflowId: 1 }, { workflowId: 2, inputs: { '3.image': 'some-file.png' } }]
    }),
    /takes a binding, not a value/
  );
});

test('a stage cannot read a stage that runs later', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await assert.rejects(
    () => call('update_batch', {
      projectId: 7,
      stages: [{ workflowId: 2, bindings: { '3.image': 'stage:2' } }, { workflowId: 1 }]
    }),
    /only consume an EARLIER stage/
  );
});

test('a variable cannot feed a parameter it could not carry', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await assert.rejects(
    () => call('update_batch', {
      projectId: 7,
      variables: [{ name: 'Reference', type: 'image' }],
      stages: [{ workflowId: 1, bindings: { '6.text': 'variable:Reference' } }]
    }),
    /cannot be fed by "Reference"/
  );
});

test('an unknown parameter is reported with the real ids, not ignored', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await assert.rejects(
    () => call('update_batch', { projectId: 7, stages: [{ workflowId: 1, inputs: { prompt_text: 'x' } }] }),
    /Its parameters: 6\.text, 7\.seed/
  );
});

test('an image variable takes an asset id, and the asset joins the project', async () => {
  const backend = createBackend();
  backend.state.library.set(42, { id: 42, type: 'image', name: 'Ref', filename: 'images/ref.png' });
  const call = createTools(backend);

  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Reference', type: 'image' }],
    groups: [{ name: 'One', values: { Reference: 42 } }],
    stages: [{ workflowId: 2, bindings: { '3.image': 'variable:Reference' } }]
  });

  const batch = await call('get_batch', { projectId: 7 });
  assert.deepEqual(batch.problems, [], JSON.stringify(batch.problems));
  assert.deepEqual(batch.groups[0].values.Reference, { assetId: 42, name: 'Ref', type: 'image' });
  // Stored as the reference a run resolves, not as a bare number.
  assert.equal(backend.state.config.groups[0].values[backend.state.config.variables[0].id].source, 'asset:42');

  await assert.rejects(
    () => call('update_batch', { projectId: 7, groups: [{ values: { Reference: 'a knight' } }] }),
    /asset id/
  );
});

// --- identity across an edit -------------------------------------------------

test('editing a row keeps its id, so its results stay in its cells', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  const before = backend.state.config.groups.map(group => group.id);
  const stagesBefore = backend.state.config.stages.map(stage => stage.id);

  await call('update_batch', {
    projectId: 7,
    groups: [
      { name: 'Knight', values: { Subject: 'a knight in armour' } },
      { name: 'Dragon', values: { Subject: 'a dragon' } }
    ]
  });

  assert.deepEqual(backend.state.config.groups.map(group => group.id), before);
  assert.deepEqual(backend.state.config.stages.map(stage => stage.id), stagesBefore);
});

test('changing a stage workflow re-seeds it; keeping it preserves manual values', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  await call('update_batch', { projectId: 7, stages: [
    { workflowId: 1, inputs: { '7.seed': 1234 } },
    { workflowId: 2 }
  ] });

  // Untouched by a later update that says nothing about it.
  await call('update_batch', { projectId: 7, stages: [{ workflowId: 1 }, { workflowId: 2 }] });
  let batch = await call('get_batch', { projectId: 7 });
  assert.equal(batch.stages[0].parameters.find(p => p.id === '7.seed').value, 1234);

  // A different workflow means different parameter ids, so the old values go.
  await call('update_batch', { projectId: 7, stages: [{ workflowId: 3 }] });
  batch = await call('get_batch', { projectId: 7 });
  assert.equal(batch.stages[0].workflowName, 'Texture Mesh');
  assert.equal(batch.stages[0].parameters.length, 2);
});

test('renaming a variable keeps its values; renaming it blind does not', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);

  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Creature', type: 'string', renameFrom: 'Subject' }]
  });
  let batch = await call('get_batch', { projectId: 7 });
  assert.deepEqual(batch.groups[0].values, { Creature: 'a knight' });
  assert.equal(batch.stages[0].parameters.find(p => p.id === '6.text').source, 'variable:Creature');

  await call('update_batch', { projectId: 7, variables: [{ name: 'Something Else', type: 'string' }] });
  batch = await call('get_batch', { projectId: 7 });
  assert.deepEqual(batch.groups[0].values, {}, 'a new variable must not inherit the old one\'s values');
  assert.equal(batch.stages[0].parameters.find(p => p.id === '6.text').source, 'manual');
});

test('retyping a variable across kinds drops the values it made meaningless', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);

  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Subject', type: 'boolean', renameFrom: 'Subject' }]
  });
  const batch = await call('get_batch', { projectId: 7 });
  assert.deepEqual(batch.groups[0].values, {}, '"a knight" would have resolved to true');

  // Within a kind (string <-> number) the values stay: a number reads as text.
  await call('update_batch', { projectId: 7, variables: [{ name: 'Subject', type: 'string', renameFrom: 'Subject' }] });
  await call('update_batch', { projectId: 7, groups: [{ name: 'Knight', values: { Subject: '512' } }] });
  await call('update_batch', { projectId: 7, variables: [{ name: 'Subject', type: 'number', renameFrom: 'Subject' }] });
  assert.deepEqual((await call('get_batch', { projectId: 7 })).groups[0].values, { Subject: '512' });
});

test('reordering the chain drops a binding that would now point forwards', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);

  await call('update_batch', { projectId: 7, stages: [{ workflowId: 2 }, { workflowId: 1 }] });
  const batch = await call('get_batch', { projectId: 7 });
  assert.equal(batch.stages[0].parameters.find(p => p.id === '3.image').source, 'manual');
  assert.ok(
    batch.problems.some(problem => /Source Image/.test(problem)),
    'a file input with nowhere to come from has to be reported, not left silent'
  );
});

// --- running -----------------------------------------------------------------

test('a run walks the grid and chains each row onto its own output', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);

  const run = await call('run_batch', { projectId: 7 });
  assert.equal(run.status, 'completed');
  assert.equal(run.generated, 4);
  assert.equal(backend.state.runs.length, 4);

  const [conceptA, meshA, conceptB, meshB] = backend.state.runs;
  // Group-major by default: a whole row before the next one.
  assert.equal(conceptA.name, 'a knight concept');
  assert.equal(meshA.name, 'a knight mesh');
  assert.equal(conceptB.name, 'a dragon concept');
  assert.equal(meshB.name, 'a dragon mesh');
  // The variable reached the prompt, and the mesh stage ate its own row's image.
  assert.equal(conceptA.inputs['6.text'], 'a knight');
  assert.equal(meshA.inputs['3.image'], 'asset:100');
  assert.equal(meshB.inputs['3.image'], 'asset:102');
  // The batch decides its own parent; the server's inference would pick the
  // first file input, which is not always the one matching the output type.
  assert.equal(meshA.autoParentFromInputs, 'false');
  assert.equal(meshA.parentAssetId, null, 'an image cannot parent a mesh');
  // Every cell is written to its own self-describing card key.
  const keys = backend.state.runs.map(entry => entry.cardId);
  assert.equal(new Set(keys).size, 4);
  assert.ok(keys.every(key => key.startsWith('batch:')));
  assert.equal(backend.state.linkedCards.length, 4);
});

test('stage-major order runs one stage across every row first', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);

  const run = await call('run_batch', { projectId: 7, executionOrder: 'stage' });
  assert.equal(run.status, 'completed');
  assert.deepEqual(backend.state.runs.map(entry => entry.name), [
    'a knight concept', 'a dragon concept', 'a knight mesh', 'a dragon mesh'
  ]);
  // Still fed from its OWN row, though the two are no longer adjacent.
  assert.equal(backend.state.runs[2].inputs['3.image'], 'asset:100');
  assert.equal(backend.state.runs[3].inputs['3.image'], 'asset:101');
  assert.equal(backend.state.config.executionOrder, 'stage', 'the chosen order is saved');
});

test('continue keeps finished cells and still chains onto them', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  await call('run_batch', { projectId: 7 });

  // What the project looks like on the way back in: result cards carrying the
  // assets, which is all the grid is ever rebuilt from.
  const config = backend.state.config;
  const runId = backend.state.runs[0].cardId.split(':')[1];
  backend.state.assets = backend.state.runs.map((entry, index) => ({
    id: 200 + index,
    type: entry.workflowId === 1 ? 'image' : 'mesh',
    name: entry.name,
    cardKey: entry.cardId,
    createdAt: 1000 + index
  }));
  assert.ok(runId && config.groups.length === 2);

  backend.state.runs.length = 0;
  const again = await call('run_batch', { projectId: 7 });
  assert.equal(again.generated, 0, 'nothing should be regenerated');
  assert.equal(again.done, 4);
  assert.equal(backend.state.runs.length, 0);

  // One cell cleared: only that one comes back, and it lands in the same cell.
  const droppedKey = backend.state.assets[1].cardKey;
  backend.state.assets = backend.state.assets.filter(asset => asset.cardKey !== droppedKey);
  const resumed = await call('run_batch', { projectId: 7 });
  assert.equal(resumed.generated, 1);
  assert.equal(backend.state.runs[0].cardId, droppedKey);
  assert.equal(resumed.runId, runId, 'a continued run keeps the run id its cells are keyed by');
});

test('a filtered restart regenerates just those cells', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  await call('run_batch', { projectId: 7 });
  backend.state.assets = backend.state.runs.map((entry, index) => ({
    id: 200 + index,
    type: entry.workflowId === 1 ? 'image' : 'mesh',
    name: entry.name,
    cardKey: entry.cardId,
    createdAt: 1000 + index
  }));
  const knightConceptKey = backend.state.runs[0].cardId;
  backend.state.runs.length = 0;

  const run = await call('run_batch', {
    projectId: 7, mode: 'restart', groups: ['Knight'], stages: ['1']
  });
  assert.equal(run.generated, 1);
  assert.equal(backend.state.runs.length, 1);
  assert.equal(backend.state.runs[0].cardId, knightConceptKey, 'the result must land in the cell it replaces');
  assert.equal(run.cells.filter(cell => cell.status === 'kept').length, 3);
});

test('a filter that names nothing is an error, not a silent no-op', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  await assert.rejects(() => call('run_batch', { projectId: 7, groups: ['Wizard'] }), /No group called "Wizard"/);
});

test('a run refuses to start while the batch has problems', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await call('update_batch', { projectId: 7, groups: [{ name: 'One' }], stages: [{ workflowId: 2 }] });
  await assert.rejects(() => call('run_batch', { projectId: 7 }), /cannot run yet/);
});

test('one failed cell does not take the grid down with it', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  backend.state.failFor = run => (run.name === 'a knight concept' ? 'ComfyUI blew up' : null);

  const run = await call('run_batch', { projectId: 7 });
  assert.equal(run.status, 'completed');
  const failures = run.cells.filter(cell => cell.status === 'error');
  assert.equal(failures.length, 2);
  assert.match(failures[0].error, /ComfyUI blew up/);
  // The stage after it reports the missing input rather than running on nothing.
  assert.match(failures[1].error, /produced no image output/);
  // The other row is untouched.
  assert.equal(run.cells.filter(cell => cell.status === 'completed').length, 2);
});

test('the parent is the input matching the OUTPUT type, not the first file input', async () => {
  const backend = createBackend();
  backend.state.library.set(42, { id: 42, type: 'image', name: 'Ref', filename: 'images/ref.png' });
  backend.state.library.set(43, { id: 43, type: 'mesh', name: 'Base', filename: 'meshes/base.glb' });
  const call = createTools(backend);

  // Texture Mesh takes [image, mesh] and returns a mesh: offering the image
  // would file the result as a stray root instead of a version of the mesh.
  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Reference', type: 'image' }, { name: 'Base', type: 'mesh' }],
    groups: [{ name: 'One', values: { Reference: 42, Base: 43 } }],
    stages: [{ workflowId: 3, bindings: { '2.image': 'variable:Reference', '5.mesh': 'variable:Base' } }]
  });

  await call('run_batch', { projectId: 7 });
  assert.equal(backend.state.runs[0].parentAssetId, 43);
});

test('a cell that never answers stops the run instead of hanging the whole grid', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await chain(call);
  backend.state.failFor = run => (run.name === 'a knight concept' ? 'hang' : null);

  const run = await call('run_batch', { projectId: 7, timeoutSeconds: 5 });
  assert.equal(run.status, 'partial');
  assert.equal(run.cells[0].status, 'running');
  assert.ok(run.cells.slice(1).every(cell => cell.status === 'not-run'));
  assert.ok(run.notes.some(note => /continues in ComfyUI/.test(note)));
});

// --- built-in actions ------------------------------------------------------------

test('a stage can run a built-in action, bound and read back like a workflow', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Faces', type: 'number' }],
    groups: [{ name: 'Knight', values: { Faces: 1500 } }],
    stages: [
      { workflowId: 1, inputs: { '6.text': 'a knight' } },
      { workflowId: 2 },
      { name: 'Knight low', action: 'optimize', bindings: { target_faces: 'variable:Faces' } }
    ]
  });

  const batch = await call('get_batch', { projectId: 7, includeResults: false });
  assert.deepEqual(batch.problems, [], JSON.stringify(batch.problems));
  const optimize = batch.stages[2];
  assert.equal(optimize.action, 'optimize');
  assert.equal(optimize.workflowId, undefined, 'a built-in stage has no workflow to name');
  assert.equal(optimize.parameters.find(p => p.id === 'mesh').source, 'stage:2', 'seeded from the stage before');
  assert.equal(optimize.parameters.find(p => p.id === 'target_faces').source, 'variable:Faces');

  // Wiring it to the image stage is refused before anything runs.
  await call('update_batch', {
    projectId: 7,
    stages: [
      { workflowId: 1, inputs: { '6.text': 'a knight' } },
      { workflowId: 2 },
      { action: 'optimize', bindings: { mesh: 'stage:1' } }
    ]
  });
  const broken = await call('get_batch', { projectId: 7, includeResults: false });
  assert.ok(broken.problems.some(problem => /produces an image, not a mesh/.test(problem)), broken.problems.join('\n'));
});

test('run_batch runs a built-in action without ComfyUI and files a version under its input', async () => {
  const backend = createBackend();
  const call = createTools(backend);
  await call('update_batch', {
    projectId: 7,
    variables: [{ name: 'Faces', type: 'number' }],
    groups: [{ name: 'Knight', values: { Faces: 1500 } }],
    stages: [
      { workflowId: 1, inputs: { '6.text': 'a knight' } },
      { workflowId: 2 },
      { name: 'Knight low', action: 'optimize', bindings: { target_faces: 'variable:Faces' } }
    ]
  });
  const produced = [];
  const produce = backend.state.produce;
  backend.state.produce = run => { const out = produce(run); produced.push(...out); return out; };
  backend.state.meshLookup = () => produced.map(asset => ({ ...asset, filename: `meshes/${asset.id}.glb` }));

  const run = await call('run_batch', { projectId: 7, mode: 'restart' });

  assert.equal(run.status, 'completed');
  assert.equal(backend.state.runs.length, 2, 'only the two ComfyUI stages were queued');
  const optimizeCall = backend.state.toolCalls.find(item => item.path === '/meshes/optimize');
  assert.equal(optimizeCall.options.target_faces, 1500, 'the group\'s value drove the face budget');
  const saved = backend.state.toolCalls.find(item => item.path === '/meshes/editor/save').saved;
  assert.equal(saved.parentAssetId, produced[1].id, 'a version of the generated mesh');
  assert.equal(saved.name, 'Knight low');
  assert.equal(backend.state.cards.length, 1);
  assert.equal(backend.state.cards[0].column, 'Mesh Edit');
  assert.equal(run.cells[2].status, 'completed');
  assert.equal(run.cells[2].assetId, saved.id);
  assert.equal(backend.state.linkedCards.at(-1).assetId, saved.id);
});

// --- run ----------------------------------------------------------------------

for (const [name, fn] of queued) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${queued.length} batch MCP tests passed`);
