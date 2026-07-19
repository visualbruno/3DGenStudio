import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolHandler, createProgressReporter } from '../client.js';
import { attachResultsToNode, resolveNodeTarget, resolveNodeInputAssets } from '../nodeResults.js';

const FILE_PARAM_TYPES = ['image', 'mesh', 'video'];

// Strip the raw graph JSON from workflow records so list responses stay small.
function summarizeWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return workflow;
  const { workflowJson: _workflowJson, ...rest } = workflow;
  return rest;
}

async function resolveWorkflowJson({ workflowJson, filePath }) {
  if (workflowJson !== undefined && workflowJson !== null) {
    return typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson;
  }
  if (filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // Accept both raw ComfyUI API graphs and .3dgw share bundles.
    if (parsed?.type === '3dgenstudio-workflow' && parsed.workflowJson) return parsed;
    return parsed;
  }
  throw new Error('Provide either workflowJson (the ComfyUI API-format graph) or filePath (a local .json/.3dgw file).');
}

export function registerWorkflowTools(server, { api, notifyMutation }) {
  server.registerTool('list_workflows', {
    title: 'List ComfyUI workflows',
    description: 'List the ComfyUI workflows saved in the library, with their configured parameters (inputs the caller can set, each with id/name/valueType/defaultValue) and output nodes.',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => {
    const workflows = await api.apiJson('GET', '/library/comfy-workflows');
    return (Array.isArray(workflows) ? workflows : []).map(summarizeWorkflow);
  }));

  server.registerTool('inspect_workflow', {
    title: 'Inspect ComfyUI workflow JSON',
    description: 'Parse a ComfyUI workflow graph (API format) without saving it. Returns candidate inputs (every literal node input, id "{nodeId}.{inputKey}") and terminal output nodes — use these to choose parameters/outputs for import_workflow. Accepts inline JSON or a local file path (.json or .3dgw share bundle).',
    inputSchema: {
      workflowJson: z.any().optional().describe('ComfyUI API-format graph JSON (object or string)'),
      filePath: z.string().optional().describe('Absolute path to a local workflow .json or .3dgw file')
    },
    annotations: { readOnlyHint: true }
  }, toolHandler(async (args) => {
    const resolved = await resolveWorkflowJson(args);
    const graph = resolved?.type === '3dgenstudio-workflow' ? resolved.workflowJson : resolved;
    const parsed = await api.apiJson('POST', '/library/comfy-workflows/inspect', { body: { workflowJson: graph } });
    if (resolved?.type === '3dgenstudio-workflow') {
      parsed.bundledConfiguration = { parameters: resolved.parameters || [], outputs: resolved.outputs || [] };
    }
    return parsed;
  }));

  server.registerTool('import_workflow', {
    title: 'Import ComfyUI workflow',
    description: 'Save a ComfyUI workflow into the library. parameters selects which inspected inputs become runtime parameters ({id, name?, valueType?: image|mesh|video|string|number|boolean}); outputs selects which terminal nodes\' results are saved ({nodeId, name?}). At least one output is required. When importing a .3dgw share bundle via filePath, the bundled parameter/output configuration is used automatically unless overridden.',
    inputSchema: {
      name: z.string().min(1).describe('Workflow name in the library'),
      workflowJson: z.any().optional().describe('ComfyUI API-format graph JSON (object or string)'),
      filePath: z.string().optional().describe('Absolute path to a local workflow .json or .3dgw file'),
      parameters: z.array(z.object({
        id: z.string(),
        name: z.string().optional(),
        valueType: z.string().optional()
      })).optional().describe('Inputs to expose as parameters (ids from inspect_workflow)'),
      outputs: z.array(z.object({
        nodeId: z.string(),
        name: z.string().optional(),
        valueType: z.string().optional()
      })).optional().describe('Output nodes to save results from (nodeIds from inspect_workflow)')
    }
  }, toolHandler(async ({ name, parameters, outputs, ...source }) => {
    const resolved = await resolveWorkflowJson(source);
    const isBundle = resolved?.type === '3dgenstudio-workflow';
    const graph = isBundle ? resolved.workflowJson : resolved;
    const effectiveParameters = parameters ?? (isBundle ? resolved.parameters : undefined) ?? [];
    const effectiveOutputs = outputs ?? (isBundle ? resolved.outputs : undefined) ?? [];
    const workflow = await api.apiJson('POST', '/library/comfy-workflows', {
      body: { name, workflowJson: graph, parameters: effectiveParameters, outputs: effectiveOutputs }
    });
    notifyMutation(null);
    return summarizeWorkflow(workflow);
  }));

  server.registerTool('update_workflow', {
    title: 'Update ComfyUI workflow',
    description: 'Update a saved workflow: rename it, change its parameter/output selection (including parameter default values), or replace the graph JSON.',
    inputSchema: {
      workflowId: z.number().int(),
      name: z.string().optional(),
      parameters: z.array(z.record(z.string(), z.any())).optional(),
      outputs: z.array(z.record(z.string(), z.any())).optional(),
      workflowJson: z.any().optional()
    }
  }, toolHandler(async ({ workflowId, ...updates }) => {
    const body = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    const workflow = await api.apiJson('PUT', `/library/comfy-workflows/${workflowId}`, { body });
    notifyMutation(null);
    return summarizeWorkflow(workflow);
  }));

  server.registerTool('run_workflow', {
    title: 'Run ComfyUI workflow',
    description: 'Execute a saved ComfyUI workflow and wait for the generated assets (streams MCP progress notifications). inputs maps parameter id -> value; for image/mesh parameters pass a project asset id (number) as the value, or use fileInputs to upload a local file. IMPORTANT for graph projects: pass nodeId (a graph node from get_graph/create_node) so the results are displayed on that node — the first result becomes the node\'s asset, additional results become new nodes stacked below it. nodeId is the ONLY way to fill a graph node; cardId is for kanban cards. (If you pass a graph node id as cardId it is auto-attached to that node, not turned into a card.) Wiring: the target node\'s connected input assets automatically fill the workflow\'s image/mesh parameters (matched by type), so you normally do NOT set inputs for file parameters — just connect_nodes to wire the source image/mesh, then run with nodeId. Only pass inputs for file parameters to override a wired input or when the node has no connection. Requires ComfyUI to be running (configured in Settings). On timeout returns {status:"running", promptId} — poll with get_run_status.',
    inputSchema: {
      workflowId: z.number().int().describe('Saved workflow id (from list_workflows)'),
      projectId: z.number().int().optional().describe('Project to attach results to (required unless persistGeneratedAssets=false)'),
      inputs: z.record(z.string(), z.any()).default({}).describe('Parameter id -> value. For an image/mesh parameter pass the asset\'s numeric id (from list_assets / a generation result) — this is ALL you need. The SAME plain id works for a root asset, an edit, or a version (e.g. a background-removed image is an edit — pass that edit\'s own id). Do NOT pass a file path/filename, and do NOT pass a {assetId, editId} object — a bare number is correct. Non-file parameters take their literal value (string/number/boolean).'),
      fileInputs: z.record(z.string(), z.string()).optional().describe('Parameter id -> absolute local file path to upload for image/mesh/video parameters'),
      nodeId: z.number().int().optional().describe('Graph node to attach the results to (graph projects) — the correct way to fill a node; without it the generated assets are saved but no node displays them'),
      cardId: z.union([z.number().int(), z.string()]).optional().describe('Existing KANBAN card to attach the run to (kanban projects). For graph nodes use nodeId — a graph node id passed here is auto-routed to that node'),
      name: z.string().optional().describe('Name for the generated asset(s)'),
      parentAssetId: z.number().int().optional().describe('Save results under this asset: a mesh output becomes a version of it, an image output an edit of it (the parent must match the output type, else a new root asset is created). USUALLY LEAVE UNSET — it is inferred automatically from the source the output was derived from: the workflow file (image/mesh) input matching the output type, whether that input came from the target node\'s wiring or was passed in `inputs`. Set this only to override that inference (e.g. attach to a different asset).'),
      persistProcessingCard: z.boolean().optional(),
      persistGeneratedAssets: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(5).max(3600).default(600)
    }
  }, toolHandler(async (args, extra) => {
    const {
      workflowId, projectId, inputs = {}, fileInputs, nodeId, cardId, name,
      parentAssetId, persistProcessingCard, persistGeneratedAssets, timeoutSeconds = 600
    } = args;
    const reportProgress = createProgressReporter(extra);
    const promptId = randomUUID();

    // Route a graph-node target to the node (via nodeId), even if the caller
    // passed the node id as cardId. targetNodeId gets the result attached;
    // kanbanCardId is only forwarded to the server when it's a real kanban card.
    const { nodeId: targetNodeId, cardId: kanbanCardId } = await resolveNodeTarget(api, projectId, { nodeId, cardId });

    // Mirror the GraphPage: use what the target node is wired to. Its connected
    // input assets fill the workflow's image/mesh parameters (by matching type) so
    // the caller doesn't have to hand-map parameter ids, and — when the caller
    // didn't pin one — set the parent so the output is saved as an edit of a
    // connected image / a version of a connected mesh (parent matches output type).
    const nodeInputAssets = (targetNodeId && projectId)
      ? await resolveNodeInputAssets(api, projectId, targetNodeId)
      : [];

    // Fetch the workflow definition to know its file parameters and output type.
    const workflowDef = (await api.apiJson('GET', '/library/comfy-workflows').catch(() => []))
      .find?.(item => Number(item?.id) === Number(workflowId)) || null;
    const fileParams = (workflowDef?.parameters || [])
      .map(parameter => ({ id: parameter.id, type: String(parameter.valueType || '').toLowerCase() }))
      .filter(parameter => FILE_PARAM_TYPES.includes(parameter.type));

    // Auto-fill each unset image/mesh/video parameter from a connected input of
    // the matching type (each connected asset used at most once). Explicit `inputs`
    // and `fileInputs` always win over an auto-filled value.
    const autoInputs = {};
    if (nodeInputAssets.length > 0 && fileParams.length > 0) {
      const available = nodeInputAssets.map(asset => ({ ...asset, used: false }));
      for (const parameter of fileParams) {
        const explicitlySet = (inputs[parameter.id] !== undefined && inputs[parameter.id] !== null)
          || (fileInputs && fileInputs[parameter.id]);
        if (explicitlySet) continue;
        const match = available.find(asset => !asset.used && asset.type === parameter.type);
        if (match) {
          autoInputs[parameter.id] = `asset:${match.assetId}`;
          match.used = true;
        }
      }
    }

    // Unless the caller pinned a parent, let the server save the output under the
    // source it was derived from: it matches each output to a resolved image/mesh
    // input of the same type (from wiring or `inputs`) — an image output becomes an
    // edit of its source image, a mesh output a version of its source mesh. This
    // means a caller that reuses a source asset as an input doesn't have to remember
    // parentAssetId (works for kanban too, where there is no node wiring). The server
    // knows the true output type, so this is robust even when the workflow's declared
    // output type is missing/wrong. Pass parentAssetId to override.
    const autoParentFromInputs = (parentAssetId === undefined || parentAssetId === null);

    // Subscribe to the single-job progress stream BEFORE submitting so the
    // terminal event can't be missed (the endpoint also replays the latest
    // snapshot on connect).
    let resolveTerminal;
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
    const subscription = api.subscribeSse(`/comfyui/workflows/progress/${promptId}`, payload => {
      if (String(payload?.promptId || '') !== promptId) return;
      if (payload?.status === 'error' || payload?.done) {
        resolveTerminal(payload);
        return;
      }
      const percent = Number(payload?.progressPercent);
      reportProgress(
        Number.isFinite(percent) ? percent : 0,
        100,
        [payload?.detail, payload?.currentNodeLabel].filter(Boolean).join(' — ') || 'Running ComfyUI workflow'
      );
    }, {
      onEnd: err => resolveTerminal({ status: 'error', detail: `Progress stream ended unexpectedly: ${err?.message || err}` })
    });

    let timer = null;
    try {
      const form = new FormData();
      if (projectId !== undefined && projectId !== null) form.append('projectId', String(projectId));
      form.append('workflowId', String(workflowId));
      form.append('promptId', promptId);
      if (kanbanCardId !== undefined && kanbanCardId !== null) form.append('cardId', String(kanbanCardId));
      if (name) form.append('name', name);
      if (parentAssetId !== undefined && parentAssetId !== null) {
        form.append('parentAssetId', String(parentAssetId));
      } else if (autoParentFromInputs) {
        form.append('autoParentFromInputs', 'true');
      }
      if (persistProcessingCard === false) form.append('persistProcessingCard', 'false');
      if (persistGeneratedAssets === false) form.append('persistGeneratedAssets', 'false');

      const inputValues = { ...autoInputs, ...inputs };
      for (const [key, localPath] of Object.entries(fileInputs || {})) {
        const fieldName = `comfyFile:${key}`;
        const buffer = await fs.readFile(localPath);
        form.append(fieldName, new Blob([buffer]), path.basename(localPath));
        inputValues[key] = { __fileField: fieldName };
      }
      form.append('inputValues', JSON.stringify(inputValues));

      await api.apiForm('POST', '/comfyui/workflows/run', form);
      await reportProgress(0, 100, 'Workflow queued in ComfyUI');

      const outcome = await Promise.race([
        terminalPromise,
        new Promise(resolve => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutSeconds * 1000); })
      ]);

      if (outcome.__timeout) {
        return {
          status: 'running',
          promptId,
          note: `Still running after ${timeoutSeconds}s. The workflow continues in the background — call get_run_status with this promptId to check on it; results are attached to the project when it finishes.`
        };
      }
      if (outcome.status === 'error') {
        throw new Error(outcome.detail || outcome.error || 'ComfyUI workflow failed');
      }
      await reportProgress(100, 100, 'Workflow completed');
      const result = outcome.result;
      const assets = Array.isArray(result) ? result : (result ? [result] : []);

      // Graph projects: display the results on the target node (mirrors what
      // the GraphPage does after a run — without this the assets exist but no
      // node shows them).
      let nodeAttachment = null;
      if (targetNodeId && projectId) {
        nodeAttachment = await attachResultsToNode(api, {
          projectId,
          nodeId: targetNodeId,
          assets,
          metadata: { lastAction: 'comfy-workflow', promptId }
        });
        notifyMutation(projectId);
      }

      return {
        status: 'completed',
        promptId,
        assets,
        ...(nodeAttachment ? { nodeAttachment } : {})
      };
    } finally {
      if (timer) clearTimeout(timer);
      subscription.close();
    }
  }));

  server.registerTool('get_run_status', {
    title: 'Get workflow run status',
    description: 'Check on a ComfyUI workflow run by promptId (returned by run_workflow). Returns the latest progress snapshot: status (processing/completed/error), progressPercent, detail, and the generated assets once done.',
    inputSchema: {
      promptId: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ promptId }) => {
    // The single-job stream replays the latest snapshot immediately on
    // connect; grab it and close. No snapshot within 3s means the server no
    // longer tracks this prompt (finished >60s ago, or never existed).
    const snapshot = await new Promise(resolve => {
      const timer = setTimeout(() => { subscription.close(); resolve(null); }, 3000);
      const subscription = api.subscribeSse(`/comfyui/workflows/progress/${encodeURIComponent(promptId)}`, payload => {
        clearTimeout(timer);
        subscription.close();
        resolve(payload);
      }, { onEnd: () => { clearTimeout(timer); resolve(null); } });
    });

    if (!snapshot) {
      return {
        status: 'unknown',
        promptId,
        note: 'No progress snapshot for this promptId. The run either finished more than a minute ago (check the project\'s assets with list_assets) or was never started.'
      };
    }
    return snapshot;
  }));
}
