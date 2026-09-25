// Batch runs, owned by the backend.
//
// A batch can take hours or days. It used to be a loop inside the browser tab,
// which was the wrong owner for anything that long: a background tab gets
// frozen (the loop stops dispatching — ComfyUI sat idle for 7.5 hours once),
// and a reload throws the loop away while its last job is still running, so the
// page came back saying "not running" and offered Continue on top of the live
// job. Here the loop runs in the local backend — the process that already talks
// to ComfyUI — and the page only draws it and sends Start / Stop.
//
// LOCAL ONLY. ComfyUI runs on the user's computer, never on the shared Docker
// server, so the routes live under /api/comfyui (local-only in serverMode.js,
// never forwarded by the gateway). Everything else — the project, the library,
// the result cards — goes through the loopback API exactly as the MCP batch
// tools do, so in gateway mode it reaches the shared server with the token the
// gateway injects.
//
// IN MEMORY. A run survives any number of page reloads, but not a restart of
// the backend itself. Nothing is lost when it does restart: every finished cell
// is a result card, so Continue picks up from what the cards show.
import { randomUUID } from 'node:crypto';
import { executeComfyRun } from '../mcp/comfyRun.js';
import {
  buildBatchCardKey,
  buildResultName,
  buildRunOrder,
  deriveCellsFromAssets,
  findParentAssetForStage,
  getRunIdFromCells,
  isBatchStageWorkflow,
  normalizeBatchConfig,
  resolveStageInputs,
  validateBatch
} from './document.js';

export const BATCH_RUN_MODES = ['continue', 'restart'];

const ACTIVE_STATUSES = new Set(['running', 'cancelling']);

export function isActiveBatchRun(run) {
  return ACTIVE_STATUSES.has(run?.status);
}

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

// The workflows a stage may run, filtered exactly as the Batch page and the MCP
// tools filter them, so a stage the page accepts is one this accepts.
async function loadStageWorkflows(api) {
  const library = await api.apiJson('GET', '/library/comfy-workflows');
  const byId = {};
  for (const workflow of Array.isArray(library) ? library : []) {
    if (isBatchStageWorkflow(workflow)) byId[String(workflow.id)] = workflow;
  }
  return byId;
}

// api: the loopback client (mcp/client.js).
// subscribeProgress(promptId, onData, { onEnd }) -> { close }: the backend's
//   in-process progress bus.
// publish(run): called with a snapshot after every change.
export function createBatchRunner({ api, subscribeProgress, publish = () => {}, logger = console }) {
  const runs = new Map();       // projectId -> run (the public, published shape)
  const controls = new Map();   // projectId -> { cancelRequested }
  const starting = new Set();   // projectIds between the start request and the first cell
  let revision = 0;

  const keyOf = projectId => String(Number(projectId));

  // Every snapshot carries a global revision, so a client holding two copies of
  // the same run (a start response and a stream frame) keeps the newer one.
  const emit = (run) => {
    revision += 1;
    run.revision = revision;
    run.updatedAt = Date.now();
    try {
      publish(snapshotOf(run));
    } catch (err) {
      logger.warn?.('Failed to publish a batch run update:', err?.message || err);
    }
  };

  const snapshotOf = run => (run ? { ...run, cells: { ...run.cells } } : null);

  const patchCell = (run, cellKey, patch) => {
    run.cells[cellKey] = { ...(run.cells[cellKey] || {}), ...patch };
  };

  async function execute(run, { config, workflowsById, priorCells }) {
    const control = controls.get(keyOf(run.projectId));
    const { variables, groups, stages, executionOrder } = config;

    const isAlreadyDone = cellKey => {
      const prior = priorCells[cellKey];
      return prior?.status === 'completed' && Boolean(prior.assetId);
    };

    // The grid is walked as one flat list so the two orders differ only in
    // which axis moves fastest. Outputs are kept per group because under
    // stage-major order a row is filled across many non-adjacent steps.
    const steps = buildRunOrder(groups, stages, executionOrder);
    const stageOutputsByGroup = new Map();

    for (const { group, groupIndex, stage, stageIndex, cellKey } of steps) {
      if (!stageOutputsByGroup.has(group.id)) stageOutputsByGroup.set(group.id, {});
      const stageOutputs = stageOutputsByGroup.get(group.id);

      // Produced by the run being continued: not regenerated, but published so
      // the later stages of this group chain onto it.
      if (isAlreadyDone(cellKey)) {
        const prior = priorCells[cellKey];
        stageOutputs[stage.id] = { id: prior.assetId, type: prior.assetType || null };
        continue;
      }

      if (control.cancelRequested) {
        patchCell(run, cellKey, { status: 'cancelled' });
        continue;
      }

      const workflow = workflowsById[String(stage.workflowId)] || null;
      if (!workflow) {
        patchCell(run, cellKey, { status: 'error', error: 'No workflow selected' });
        emit(run);
        continue;
      }

      const { inputs, missing } = resolveStageInputs({ stage, workflow, group, variables, stageOutputs, stages });
      if (missing.length > 0) {
        patchCell(run, cellKey, {
          status: 'error',
          error: missing.map(item => `${item.label}: ${item.reason}`).join(' · ')
        });
        emit(run);
        continue;
      }

      const promptId = randomUUID();
      const cardKey = buildBatchCardKey(run.runId, group.id, stage.id);
      const resultName = buildResultName({ group, groupIndex, stage, stageIndex, variables });
      // The asset feeding this stage's file input. The server only adopts it as
      // a parent when the output is the same type, so image -> mesh still makes
      // a root mesh while mesh -> mesh makes a version.
      const parentAsset = findParentAssetForStage({ stage, workflow, stageOutputs, group });

      patchCell(run, cellKey, {
        status: 'running',
        promptId,
        cardKey,
        label: resultName,
        progressPercent: 0,
        error: null,
        startedAt: Date.now()
      });
      run.currentCellKey = cellKey;
      emit(run);

      try {
        const outcome = await executeComfyRun(api, {
          projectId: run.projectId,
          workflowId: Number(stage.workflowId),
          promptId,
          // The server owns the result card: it creates it under this
          // deterministic clientKey and streams progress into it.
          cardId: cardKey,
          name: resultName,
          parentAssetId: parentAsset?.id,
          // The batch picks its own parent (the input matching the OUTPUT
          // type); the server's inference would take the first file input.
          autoParentFromInputs: false,
          inputs,
          // A cell takes as long as it takes — a 40-minute mesh refine is normal.
          timeoutSeconds: null,
          subscribe: subscribeProgress,
          onProgress: payload => {
            const percent = Math.round(Number(payload?.progressPercent));
            if (!Number.isFinite(percent) || percent === run.cells[cellKey]?.progressPercent) return;
            patchCell(run, cellKey, { progressPercent: percent });
            emit(run);
          }
        });

        const produced = (outcome.assets || []).filter(Boolean);
        if (produced.length === 0) {
          throw new Error('The workflow returned no output');
        }

        // Only the first output feeds downstream: a row has one cell per stage.
        const primary = produced[0];
        stageOutputs[stage.id] = primary;

        // An edit / version is saved without a Cards_Assets row, so the result
        // card is pointed at it explicitly. Harmless for a root asset.
        if (primary.id) {
          try {
            await api.apiJson('PUT', `/projects/${run.projectId}/batch-cards/${encodeURIComponent(cardKey)}/asset`, {
              body: { assetId: primary.id }
            });
          } catch (linkErr) {
            logger.error?.('Failed to link a batch result to its card:', linkErr?.message || linkErr);
          }
        }

        patchCell(run, cellKey, {
          status: 'completed',
          progressPercent: 100,
          assetId: primary.id ?? null,
          assetType: primary.type || null,
          parentAssetId: parentAsset?.id ?? null,
          extraOutputs: produced.length - 1,
          finishedAt: Date.now()
        });
      } catch (err) {
        patchCell(run, cellKey, err?.cancelled
          ? { status: 'cancelled', error: null, finishedAt: Date.now() }
          : { status: 'error', error: err?.message || 'Workflow failed', finishedAt: Date.now() });
      }

      run.currentCellKey = null;
      emit(run);
    }
  }

  // Start (or continue) the batch of one project. Resolves once the run is
  // registered — the loop itself carries on in the background.
  //
  // config: the page's current document. Passed in rather than read back so a
  //   run started a moment after an edit uses that edit even if the page's
  //   debounced autosave has not landed yet. Falls back to the stored document.
  // mode: "continue" keeps every cell that already has a result (in the run
  //   those results belong to); "restart" starts a fresh run.
  async function start(projectId, { config, mode = 'continue' } = {}) {
    const key = keyOf(projectId);
    if (!Number.isFinite(Number(projectId)) || Number(projectId) <= 0) {
      throw httpError(400, 'A valid projectId is required');
    }
    if (!BATCH_RUN_MODES.includes(mode)) {
      throw httpError(400, `Unknown mode "${mode}" (expected ${BATCH_RUN_MODES.join(' or ')})`);
    }
    // Claimed before the first await, so two quick clicks (or two tabs) cannot
    // both pass the check and start two loops on the same grid.
    if (starting.has(key) || isActiveBatchRun(runs.get(key))) {
      throw httpError(409, 'This batch is already running');
    }
    starting.add(key);

    try {
      const project = await api.apiJson('GET', `/projects/${projectId}`);
      const preset = String(project?.preset || '');
      if (preset && preset.toLowerCase() !== 'batch') {
        throw httpError(400, `Project ${projectId} is a ${preset} project, not a Batch project`);
      }

      const document = normalizeBatchConfig(config && typeof config === 'object'
        ? config
        : (await api.apiJson('GET', `/projects/${projectId}/batch-config`))?.state);

      const workflowsById = await loadStageWorkflows(api);
      const problems = validateBatch({ config: document, workflowsById });
      if (problems.length > 0) {
        throw httpError(400, `This batch cannot run yet: ${problems.length} problem(s). ${problems[0].message}`, {
          problems: problems.map(problem => problem.message)
        });
      }

      // What is already done comes from the result cards, not from anything the
      // page remembers: they are the only record that survives a reload, a
      // frozen tab and a backend restart alike.
      let priorCells = {};
      let runId = null;
      if (mode === 'continue') {
        const assets = await api.apiJson('GET', '/assets', { query: { projectId, includeChildren: 'true' } });
        priorCells = deriveCellsFromAssets(Array.isArray(assets) ? assets : [], document);
        // A run whose results were all deleted still has an id worth keeping.
        runId = getRunIdFromCells(priorCells) || runs.get(key)?.runId || null;
      }
      runId = runId || randomUUID().slice(0, 18);

      const cells = {};
      document.groups.forEach(group => {
        document.stages.forEach(stage => {
          const cellKey = `${group.id}:${stage.id}`;
          const prior = priorCells[cellKey];
          cells[cellKey] = prior?.status === 'completed' && prior.assetId ? prior : { status: 'queued' };
        });
      });

      const run = {
        runId,
        projectId: Number(projectId),
        projectName: project?.name || '',
        mode,
        status: 'running',
        cells,
        currentCellKey: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
        revision: 0,
        updatedAt: 0
      };
      runs.set(key, run);
      controls.set(key, { cancelRequested: false });
      emit(run);

      (async () => {
        try {
          await execute(run, { config: document, workflowsById, priorCells });
          run.status = controls.get(key)?.cancelRequested ? 'cancelled' : 'completed';
        } catch (err) {
          logger.error?.(`Batch run ${runId} for project ${projectId} failed:`, err);
          run.status = 'error';
          run.error = err?.message || 'The batch run failed';
        } finally {
          run.currentCellKey = null;
          run.finishedAt = Date.now();
          emit(run);
        }
      })();

      return snapshotOf(run);
    } finally {
      starting.delete(key);
    }
  }

  // Stop after the cell in flight: that one finishes (its result is kept), and
  // everything after it is marked cancelled.
  function cancel(projectId) {
    const key = keyOf(projectId);
    const run = runs.get(key);
    if (!run || !isActiveBatchRun(run)) {
      return snapshotOf(run);
    }
    controls.get(key).cancelRequested = true;
    if (run.status === 'running') {
      run.status = 'cancelling';
      emit(run);
    }
    return snapshotOf(run);
  }

  // Deleting a result has to drop its cell from the remembered run as well, or
  // the grid, which draws from the run while one is remembered, would keep
  // showing the deleted result.
  function clearCells(projectId, cellKeys) {
    const run = runs.get(keyOf(projectId));
    const keys = new Set(Array.isArray(cellKeys) ? cellKeys.map(String) : []);
    if (!run || keys.size === 0) {
      return snapshotOf(run);
    }
    for (const cellKey of keys) {
      delete run.cells[cellKey];
    }
    emit(run);
    return snapshotOf(run);
  }

  return {
    start,
    cancel,
    clearCells,
    get: projectId => snapshotOf(runs.get(keyOf(projectId))),
    list: () => Array.from(runs.values(), snapshotOf),
    isActive: projectId => starting.has(keyOf(projectId)) || isActiveBatchRun(runs.get(keyOf(projectId)))
  };
}

// The routes. Mounted after express.json().
export function mountBatchRuns(app, runner) {
  const fail = (res, err, fallback) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error(`${fallback}:`, err);
    res.status(status).json({
      error: err?.message || fallback,
      ...(err?.problems ? { problems: err.problems } : {})
    });
  };

  app.get('/api/comfyui/batch-runs', (req, res) => {
    res.json({ runs: runner.list() });
  });

  app.get('/api/comfyui/batch-runs/:projectId', (req, res) => {
    res.json({ run: runner.get(req.params.projectId) });
  });

  app.post('/api/comfyui/batch-runs/:projectId', async (req, res) => {
    try {
      const run = await runner.start(req.params.projectId, {
        config: req.body?.config,
        mode: req.body?.mode || 'continue'
      });
      res.status(202).json({ run });
    } catch (err) {
      fail(res, err, 'Failed to start the batch');
    }
  });

  app.post('/api/comfyui/batch-runs/:projectId/cancel', (req, res) => {
    res.json({ run: runner.cancel(req.params.projectId) });
  });

  app.post('/api/comfyui/batch-runs/:projectId/clear-cells', (req, res) => {
    res.json({ run: runner.clearCells(req.params.projectId, req.body?.cellKeys) });
  });
}
