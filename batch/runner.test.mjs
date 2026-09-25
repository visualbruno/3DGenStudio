// node batch/runner.test.mjs
//
// The backend-owned batch loop (batch/runner.js), against a fake backend and a
// fake ComfyUI. What matters here is what the page can no longer get wrong:
// one loop per grid no matter how often Start is pressed, a Continue that reads
// what is done off the result cards, a Stop that lets the cell in flight land,
// and a cancelled ComfyUI job that is not mistaken for "no output".
import assert from 'node:assert/strict';
import { createBatchRunner, isActiveBatchRun } from './runner.js';

let passed = 0;
const queued = [];
function test(name, fn) { queued.push([name, fn]); }

const WORKFLOWS = [
  {
    id: 1,
    name: 'Text to Image',
    parameters: [{ id: '6.text', name: 'Prompt', valueType: 'string', defaultValue: 'a robot' }],
    outputs: [{ nodeId: '9', name: 'Image', valueType: 'image' }]
  },
  {
    id: 2,
    name: 'Image to Mesh',
    parameters: [{ id: '3.image', name: 'Source Image', valueType: 'image' }],
    outputs: [{ nodeId: '8', name: 'Mesh', valueType: 'mesh' }]
  }
];

// Two rows, a two-stage chain: image, then a mesh made from that image.
function chainConfig() {
  return {
    version: 1,
    variables: [{ id: 'var-subject', name: 'Subject', type: 'string' }],
    groups: [
      { id: 'grp-a', name: 'Knight', values: { 'var-subject': 'a knight' } },
      { id: 'grp-b', name: 'Dragon', values: { 'var-subject': 'a dragon' } }
    ],
    stages: [
      {
        id: 'stg-1',
        name: '{{Subject}} concept',
        workflowId: 1,
        inputs: { '6.text': 'a robot' },
        bindings: { '6.text': { source: 'variable', variableId: 'var-subject' } }
      },
      {
        id: 'stg-2',
        name: '{{Subject}} mesh',
        workflowId: 2,
        inputs: {},
        bindings: { '3.image': { source: 'stage', stageId: 'stg-1' } }
      }
    ],
    executionOrder: 'group'
  };
}

function createBackend() {
  const state = {
    config: chainConfig(),
    assets: [],
    runs: [],
    linked: [],
    published: [],
    listeners: new Map(),
    nextAssetId: 100,
    // How a submitted run ends: 'complete' (default), 'hold' (until released),
    // 'cancel', or an error message.
    outcomeFor: () => 'complete',
    held: new Map()
  };

  const finish = (run, outcome) => {
    const listener = state.listeners.get(run.promptId);
    if (!listener) return;
    if (outcome === 'cancel') {
      // Exactly what server.js publishes for a cancel: done, with no result.
      listener({ promptId: run.promptId, status: 'cancelled', done: true, cancelled: true, detail: 'Workflow cancelled' });
    } else if (outcome === 'complete') {
      listener({ promptId: run.promptId, status: 'completed', done: true, result: [{
        id: state.nextAssetId++,
        type: run.workflowId === 1 ? 'image' : 'mesh',
        name: run.name
      }] });
    } else {
      listener({ promptId: run.promptId, status: 'error', detail: outcome });
    }
  };

  const api = {
    async apiJson(method, path, { body, query } = {}) {
      if (method === 'GET' && /^\/projects\/\d+$/.test(path)) return { id: 7, name: 'Batch Project', preset: 'Batch' };
      if (method === 'GET' && path.endsWith('/batch-config')) return { projectId: 7, state: state.config };
      if (method === 'GET' && path === '/library/comfy-workflows') return WORKFLOWS;
      if (method === 'GET' && path === '/assets') {
        assert.equal(String(query?.includeChildren), 'true');
        return state.assets;
      }
      if (method === 'PUT' && /\/batch-cards\//.test(path)) {
        state.linked.push({ cardKey: decodeURIComponent(path.split('/')[4]), assetId: body.assetId });
        return { ok: true };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async apiForm(method, path, form) {
      assert.equal(path, '/comfyui/workflows/run');
      const run = {
        workflowId: Number(form.get('workflowId')),
        promptId: form.get('promptId'),
        cardId: form.get('cardId'),
        name: form.get('name'),
        parentAssetId: form.get('parentAssetId') ? Number(form.get('parentAssetId')) : null,
        autoParentFromInputs: form.get('autoParentFromInputs'),
        inputs: JSON.parse(form.get('inputValues'))
      };
      state.runs.push(run);
      const outcome = state.outcomeFor(run);
      if (outcome === 'post-fails') throw new Error('fetch failed');
      if (outcome === 'hold') {
        state.held.set(run.promptId, run);
      } else {
        setImmediate(() => finish(run, outcome));
      }
      return { promptId: run.promptId, status: 'queued' };
    }
  };

  const subscribeProgress = (promptId, onData) => {
    state.listeners.set(promptId, onData);
    return { close: () => state.listeners.delete(promptId) };
  };

  const release = (outcome = 'complete') => {
    for (const run of state.held.values()) finish(run, outcome);
    state.held.clear();
  };

  const runner = createBatchRunner({
    api,
    subscribeProgress,
    publish: run => state.published.push(run),
    logger: { warn() {}, error() {} }
  });

  return { state, runner, release };
}

async function settle(runner, projectId = 7) {
  for (let i = 0; i < 500; i += 1) {
    const run = runner.get(projectId);
    if (run && !isActiveBatchRun(run)) return run;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('the run never settled');
}

async function until(predicate) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition never became true');
}

// --- a full run ----------------------------------------------------------------

test('runs every cell once, chains the stages and links each result card', async () => {
  const { state, runner } = createBackend();
  const started = await runner.start(7, { config: state.config, mode: 'restart' });
  assert.equal(started.status, 'running');

  const run = await settle(runner);
  assert.equal(run.status, 'completed');
  assert.equal(state.runs.length, 4);
  assert.deepEqual(Object.values(run.cells).map(cell => cell.status), ['completed', 'completed', 'completed', 'completed']);

  // Group-major: Knight's image, Knight's mesh, then the Dragon row.
  assert.deepEqual(state.runs.map(item => item.name), ['a knight concept', 'a knight mesh', 'a dragon concept', 'a dragon mesh']);
  // The mesh stage receives the SAME row's image, not a typed-in value.
  const knightImage = run.cells['grp-a:stg-1'].assetId;
  assert.equal(state.runs[1].inputs['3.image'], `asset:${knightImage}`);
  // The batch picks its own parent and says so.
  assert.equal(state.runs[0].autoParentFromInputs, 'false');

  // Every result card is keyed by the run and the cell.
  assert.equal(state.runs[0].cardId, `batch:${run.runId}:grp-a:stg-1`);
  assert.equal(state.linked.length, 4);
  assert.deepEqual(state.linked[3], { cardKey: `batch:${run.runId}:grp-b:stg-2`, assetId: run.cells['grp-b:stg-2'].assetId });

  // Each snapshot is newer than the one before it.
  const revisions = state.published.map(item => item.revision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b));
  assert.equal(state.published.at(-1).status, 'completed');
});

test('the running cell carries what the page needs to show it as a job', async () => {
  const { state, runner, release } = createBackend();
  state.outcomeFor = () => 'hold';
  await runner.start(7, { config: state.config, mode: 'restart' });
  await until(() => state.held.size === 1);

  const run = runner.get(7);
  const cell = run.cells['grp-a:stg-1'];
  assert.equal(cell.status, 'running');
  assert.equal(cell.promptId, state.runs[0].promptId);
  assert.equal(cell.cardKey, state.runs[0].cardId);
  assert.equal(cell.label, 'a knight concept');
  assert.equal(run.currentCellKey, 'grp-a:stg-1');

  state.outcomeFor = () => 'complete';
  release();
  await settle(runner);
});

// --- one loop per grid ---------------------------------------------------------

test('a second start while the batch runs is refused, even when both land at once', async () => {
  const { state, runner, release } = createBackend();
  state.outcomeFor = () => 'hold';

  const [first, second] = await Promise.allSettled([
    runner.start(7, { config: state.config, mode: 'restart' }),
    runner.start(7, { config: state.config, mode: 'continue' })
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.status, 409);

  await until(() => state.held.size === 1);
  await assert.rejects(runner.start(7, { config: state.config }), err => err.status === 409);
  assert.equal(state.runs.length, 1, 'only one job was ever sent');

  state.outcomeFor = () => 'complete';
  release();
  await settle(runner);
});

test('a batch that cannot run is refused before anything is sent', async () => {
  const { state, runner } = createBackend();
  const broken = chainConfig();
  broken.stages[0].workflowId = 999;
  await assert.rejects(
    runner.start(7, { config: broken, mode: 'restart' }),
    err => err.status === 400 && err.problems.length > 0
  );
  assert.equal(state.runs.length, 0);
  assert.equal(runner.get(7), null);
  // A refused start does not leave the project looking busy.
  assert.equal(runner.isActive(7), false);
});

// --- continue / restart --------------------------------------------------------

test('continue skips what the result cards already hold, and keeps their run', async () => {
  const { state, runner } = createBackend();
  // The Knight row finished in an earlier run; the tab that ran it is long gone.
  state.assets = [
    { id: 11, type: 'image', cardKey: 'batch:oldrun:grp-a:stg-1', createdAt: 1 },
    { id: 12, type: 'mesh', cardKey: 'batch:oldrun:grp-a:stg-2', createdAt: 2 }
  ];

  await runner.start(7, { config: state.config, mode: 'continue' });
  const run = await settle(runner);

  assert.equal(run.runId, 'oldrun');
  assert.deepEqual(state.runs.map(item => item.name), ['a dragon concept', 'a dragon mesh']);
  assert.equal(run.cells['grp-a:stg-2'].assetId, 12);
  assert.equal(state.runs[0].cardId, 'batch:oldrun:grp-b:stg-1');
});

test('continue chains onto a kept result instead of regenerating it', async () => {
  const { state, runner } = createBackend();
  state.assets = [{ id: 11, type: 'image', cardKey: 'batch:oldrun:grp-a:stg-1', createdAt: 1 }];

  await runner.start(7, { config: state.config, mode: 'continue' });
  await settle(runner);

  assert.equal(state.runs[0].name, 'a knight mesh');
  assert.equal(state.runs[0].inputs['3.image'], 'asset:11');
  assert.equal(state.runs[0].parentAssetId, null, 'image -> mesh files a root mesh, not a version of the image');
});

test('restart starts a fresh run and regenerates everything', async () => {
  const { state, runner } = createBackend();
  state.assets = [{ id: 11, type: 'image', cardKey: 'batch:oldrun:grp-a:stg-1', createdAt: 1 }];

  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);
  assert.notEqual(run.runId, 'oldrun');
  assert.equal(state.runs.length, 4);
});

test('with no config in the request the stored document is used', async () => {
  const { state, runner } = createBackend();
  await runner.start(7, { mode: 'restart' });
  await settle(runner);
  assert.equal(state.runs.length, 4);
});

// --- stopping ------------------------------------------------------------------

test('stop lets the cell in flight land and cancels the rest', async () => {
  const { state, runner, release } = createBackend();
  state.outcomeFor = () => 'hold';
  await runner.start(7, { config: state.config, mode: 'restart' });
  await until(() => state.held.size === 1);

  assert.equal(runner.cancel(7).status, 'cancelling');

  release('complete');
  const run = await settle(runner);
  assert.equal(run.status, 'cancelled');
  assert.equal(state.runs.length, 1);
  assert.equal(run.cells['grp-a:stg-1'].status, 'completed', 'the in-flight result is kept');
  assert.deepEqual(
    ['grp-a:stg-2', 'grp-b:stg-1', 'grp-b:stg-2'].map(key => run.cells[key].status),
    ['cancelled', 'cancelled', 'cancelled']
  );

  // And Continue is possible afterwards.
  state.outcomeFor = () => 'complete';
  state.assets = [{ id: run.cells['grp-a:stg-1'].assetId, type: 'image', cardKey: run.cells['grp-a:stg-1'].cardKey, createdAt: 1 }];
  await runner.start(7, { config: state.config, mode: 'continue' });
  const resumed = await settle(runner);
  assert.equal(resumed.runId, run.runId);
  assert.equal(resumed.status, 'completed');
  assert.equal(state.runs.length, 4);
});

test('a ComfyUI job cancelled on its own is a cancelled cell, not "no output", and the batch goes on', async () => {
  const { state, runner } = createBackend();
  state.outcomeFor = run => (run.name === 'a knight concept' ? 'cancel' : 'complete');
  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);

  assert.equal(run.status, 'completed');
  assert.equal(run.cells['grp-a:stg-1'].status, 'cancelled');
  assert.equal(run.cells['grp-a:stg-1'].error, null);
  // The mesh stage of that row has nothing to consume, so it reports why.
  assert.equal(run.cells['grp-a:stg-2'].status, 'error');
  assert.equal(run.cells['grp-b:stg-2'].status, 'completed');
});

test('a failed cell is reported and the rest of the grid still runs', async () => {
  const { state, runner } = createBackend();
  state.outcomeFor = run => (run.name === 'a dragon concept' ? 'CUDA out of memory' : 'complete');
  await runner.start(7, { config: state.config, mode: 'restart' });
  const run = await settle(runner);

  assert.equal(run.cells['grp-b:stg-1'].status, 'error');
  assert.equal(run.cells['grp-b:stg-1'].error, 'CUDA out of memory');
  assert.equal(run.cells['grp-a:stg-2'].status, 'completed');
});

// --- other projects, clearing ---------------------------------------------------

test('another project is independent of a running one', async () => {
  const { state, runner, release } = createBackend();
  state.outcomeFor = () => 'hold';
  await runner.start(7, { config: state.config, mode: 'restart' });
  await until(() => state.held.size === 1);

  assert.equal(runner.get(8), null);
  assert.equal(runner.isActive(8), false);
  await runner.start(8, { config: state.config, mode: 'restart' });
  assert.equal(runner.list().length, 2);
  await until(() => state.held.size === 2);

  state.outcomeFor = () => 'complete';
  release();
  assert.equal((await settle(runner, 7)).status, 'completed');
  assert.equal((await settle(runner, 8)).status, 'completed');
  assert.equal(state.runs.length, 8);
});

test('clearing cells drops them from the remembered run', async () => {
  const { state, runner } = createBackend();
  await runner.start(7, { config: state.config, mode: 'restart' });
  await settle(runner);

  const before = state.published.length;
  const run = runner.clearCells(7, ['grp-a:stg-2']);
  assert.equal(run.cells['grp-a:stg-2'], undefined);
  assert.equal(run.cells['grp-a:stg-1'].status, 'completed');
  assert.equal(state.published.length, before + 1, 'the change is published');
});

test('a snapshot is a copy: changing it does not change the run', async () => {
  const { state, runner } = createBackend();
  await runner.start(7, { config: state.config, mode: 'restart' });
  await settle(runner);
  const snapshot = runner.get(7);
  snapshot.cells['grp-a:stg-1'] = null;
  assert.equal(runner.get(7).cells['grp-a:stg-1'].status, 'completed');
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
console.log(`${passed}/${queued.length} batch runner tests passed`);
