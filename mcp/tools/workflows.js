import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { toolHandler, createProgressReporter } from '../client.js';
import { attachResultsToNode, resolveNodeTarget, resolveNodeInputAssets } from '../nodeResults.js';
import { applyAssetTags, tagsInput } from '../assetTags.js';

const FILE_PARAM_TYPES = ['image', 'mesh', 'video'];
const SCALAR_EXAMPLES = { string: '"a red robot"', number: '42', boolean: 'true' };

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A parameter's effective value type, mirroring the server: the configured
// valueType, falling back to the type inferred from the graph input.
function parameterValueType(parameter) {
  const configured = String(parameter?.valueType || '').toLowerCase();
  if (['string', 'number', 'boolean', 'image', 'video', 'mesh'].includes(configured)) return configured;
  const inferred = String(parameter?.type || '').toLowerCase();
  return ['number', 'boolean'].includes(inferred) ? inferred : 'string';
}

// Small models reliably wrap a parameter value in a redundant object or a
// one-element array — {"6.text": {"value": "a cat"}} — and nothing downstream
// notices: the server stringifies the object into the literal "[object Object]"
// for a string parameter, and turns it into NaN (→ the default) for a number.
// Unwrap the one unambiguous shape, a lone "value" key or a one-element array,
// so the run does what the caller meant. Never applied to a json parameter,
// where an object or an array IS the value.
function unwrapScalarValue(raw) {
  let value = raw;
  let unwrapped = false;

  // Bounded: a doubly-wrapped value is still worth fixing, but this must never
  // walk a deep or self-referential structure.
  for (let depth = 0; depth < 3; depth += 1) {
    if (isPlainObject(value) && Object.keys(value).length === 1 && 'value' in value) {
      value = value.value;
      unwrapped = true;
      continue;
    }
    if (Array.isArray(value) && value.length === 1) {
      value = value[0];
      unwrapped = true;
      continue;
    }
    break;
  }

  return { value, unwrapped };
}

// Local models served through LM Studio / Ollama routinely leak their chat
// template's special tokens into the JSON of a tool call: a key arrives as
// `<|"|>6.text<|"|>` instead of `6.text`. The run is then rejected for an
// unknown parameter the model is certain it copied correctly, so it retries the
// identical call forever. Strip the token markers (and the stray quoting that
// comes with them) so the id underneath is recovered.
const SPECIAL_TOKEN_PATTERN = /<\|[^|]*\|>/g;

function stripSpecialTokens(text) {
  return String(text).replace(SPECIAL_TOKEN_PATTERN, '');
}

// Parameter ids are "<nodeId>.<inputKey>" — word characters, dots and dashes.
// Anything else clinging to either end (quotes, backslashes, angle brackets,
// pipes, whitespace) is transport damage, not part of the id.
function sanitizeParameterKey(key) {
  return stripSpecialTokens(key).replace(/^[^\w.-]+/, '').replace(/[^\w.-]+$/, '').trim();
}

function pushInto(map, key, value) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Match a caller's key to a real parameter id, tolerating the damage above and
// the near-misses small models make: wrong case, the bare input key without its
// node id ("text"), or the parameter's display name. A loose match only counts
// when it is unambiguous — otherwise the key is reported as an error rather than
// silently steering a run onto the wrong parameter.
function createParameterResolver(parameters) {
  const exact = new Set();
  const byLowerId = new Map();
  const byInputKey = new Map();
  const byName = new Map();

  for (const parameter of parameters) {
    const id = String(parameter.id);
    exact.add(id);
    byLowerId.set(id.toLowerCase(), id);
    const dot = id.indexOf('.');
    pushInto(byInputKey, (dot >= 0 ? id.slice(dot + 1) : id).toLowerCase(), id);
    if (parameter.name) pushInto(byName, String(parameter.name).toLowerCase(), id);
  }

  return function resolveParameterId(rawKey) {
    const raw = String(rawKey);
    if (exact.has(raw)) return { id: raw, repaired: false, damaged: false };

    const cleaned = sanitizeParameterKey(raw);
    const damaged = cleaned !== raw.trim();
    if (!cleaned) return { id: null, repaired: false, damaged };
    if (exact.has(cleaned)) return { id: cleaned, repaired: true, damaged };

    const lower = cleaned.toLowerCase();
    if (byLowerId.has(lower)) return { id: byLowerId.get(lower), repaired: true, damaged };

    for (const map of [byInputKey, byName]) {
      const hits = map.get(lower);
      if (hits && hits.length === 1) return { id: hits[0], repaired: true, damaged };
    }

    return { id: null, repaired: false, damaged };
  };
}

// Catch the input mistakes that would otherwise run to completion on the WRONG
// values, which is far worse for a caller than an error it can correct: an
// `inputs` key matching no parameter is silently ignored by the server
// (applyComfyParametersToWorkflow only reads the workflow's own parameter ids),
// and a non-scalar value for a string/number parameter is coerced into
// "[object Object]"/the default. Recoverable shapes are fixed and reported as
// warnings; the rest throw before anything is queued in ComfyUI.
function normalizeWorkflowInputs({ inputs, fileInputs, workflowDef }) {
  const parameters = workflowDef?.parameters;
  // No definition to check against (the library fetch failed) — pass through
  // rather than blocking a run over a missing projection.
  if (!Array.isArray(parameters) || parameters.length === 0) {
    return { inputs: inputs || {}, fileInputs: fileInputs || undefined, warnings: [] };
  }

  const byId = new Map(parameters.map(parameter => [String(parameter.id), parameter]));
  const resolveParameterId = createParameterResolver(parameters);
  const problems = [];
  const warnings = [];
  const normalized = {};
  let sawTemplateTokens = false;

  for (const [key, raw] of Object.entries(inputs || {})) {
    const { id, repaired, damaged } = resolveParameterId(key);
    if (damaged) sawTemplateTokens = true;
    if (!id) {
      problems.push(`"${key}" is not a parameter of this workflow.`);
      continue;
    }
    if (repaired) {
      warnings.push(`"${key}": read as parameter "${id}". Pass the id exactly as list_workflows reports it.`);
    }
    if (id in normalized) {
      warnings.push(`"${key}": two inputs resolved to parameter "${id}" — the last one wins.`);
    }

    const parameter = byId.get(id);

    // A json parameter takes its value verbatim, wrapper-shaped or not.
    if (String(parameter.type || '').toLowerCase() === 'json') {
      normalized[id] = raw;
      continue;
    }

    const valueType = parameterValueType(parameter);
    const isFileParam = FILE_PARAM_TYPES.includes(valueType);
    let { value, unwrapped } = unwrapScalarValue(raw);

    if (unwrapped) {
      warnings.push(`"${key}": pass the bare value (${JSON.stringify(value)}); the wrapper in ${JSON.stringify(raw)} was stripped. inputs maps a parameter id straight to its value.`);
    }

    // Explicit null/undefined means "no value", which the server would render
    // as the string "null" — drop it so the default (or, for a file parameter,
    // the target node's wiring) applies instead.
    if (value === null || value === undefined) {
      warnings.push(`"${key}": dropped (no value given) — omit a parameter to use its default.`);
      continue;
    }

    // The same template tokens that damage a key also land inside a prompt,
    // where ComfyUI would generate from them verbatim.
    if (typeof value === 'string') {
      const cleanedValue = stripSpecialTokens(value).trim();
      if (cleanedValue !== value) {
        warnings.push(`"${key}": stripped chat-template tokens from the value.`);
        sawTemplateTokens = true;
        value = cleanedValue;
      }
    }

    // File parameters legitimately take object markers ({assetId}, {__none:true}).
    if (!isFileParam && typeof value === 'object') {
      problems.push(`"${key}" is a ${valueType} parameter but was given ${JSON.stringify(raw)}. Pass a bare ${valueType} (e.g. ${SCALAR_EXAMPLES[valueType] || '"value"'}), never an object or array.`);
      continue;
    }

    normalized[id] = value;
  }

  const normalizedFileInputs = {};
  for (const [key, localPath] of Object.entries(fileInputs || {})) {
    const { id, repaired, damaged } = resolveParameterId(key);
    if (damaged) sawTemplateTokens = true;
    if (!id) {
      problems.push(`fileInputs "${key}" is not a parameter of this workflow.`);
      continue;
    }
    if (repaired) {
      warnings.push(`fileInputs "${key}": read as parameter "${id}".`);
    }
    const valueType = parameterValueType(byId.get(id));
    if (!FILE_PARAM_TYPES.includes(valueType)) {
      problems.push(`fileInputs "${key}" is a ${valueType} parameter, not a file parameter — put its value in inputs instead.`);
      continue;
    }
    normalizedFileInputs[id] = localPath;
  }

  if (problems.length > 0) {
    throw new Error([
      `Invalid run_workflow inputs for "${workflowDef.name}" (workflow ${workflowDef.id}):`,
      ...problems.map(problem => `  - ${problem}`),
      'inputs is a FLAT map of parameter id -> bare value, e.g. {"6.text": "a red robot", "7.noise_seed": 42}.',
      `This workflow's parameters: ${parameters.map(parameter => `"${parameter.id}" (${parameterValueType(parameter)})`).join(', ')}.`,
      ...(sawTemplateTokens
        ? ['Your keys arrived wrapped in chat-template tokens (e.g. <|"|>6.text<|"|>). Emit plain JSON: the key is exactly 6.text, with no markers, quotes or backslashes inside it.']
        : []),
      `Do not repeat this call unchanged — fix the ids listed above, or call list_workflows with workflowId ${workflowDef.id} for their names, defaults and allowed values.`
    ].join('\n'));
  }

  return {
    inputs: normalized,
    fileInputs: Object.keys(normalizedFileInputs).length > 0 ? normalizedFileInputs : undefined,
    warnings
  };
}

// Strip the raw graph JSON from workflow records so list responses stay small.
function summarizeWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return workflow;
  const { workflowJson: _workflowJson, ...rest } = workflow;
  return rest;
}

// A stored workflow record carries far more than a caller needs, and a whole
// library of them does not fit in a small model's context — 42 workflows came
// to ~106k tokens raw. The bulk of that (82%) is availableInputs: every literal
// node input in the graph, which only matters when RECONFIGURING a workflow.
// The projections below keep each detail level to what that level is actually
// for; see the `detail` parameter on list_workflows.

// The fields needed to CALL a parameter through run_workflow. `id` is what
// `inputs` keys on, `valueType` decides whether a value is an asset id or a
// literal, and `enums` is the allowed-value list. nodeId/inputKey/nodeTitle/
// classType/label/type are all derivable from or redundant with these.
function callableParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') return parameter;
  return {
    id: parameter.id,
    name: parameter.name,
    valueType: parameter.valueType ?? parameter.type,
    defaultValue: parameter.defaultValue,
    ...(parameter.enums ? { enums: parameter.enums } : {})
  };
}

function callableOutput(output) {
  if (!output || typeof output !== 'object') return output;
  return { nodeId: output.nodeId, name: output.name, valueType: output.valueType };
}

// summary — enough to pick a workflow (and to know whether it is worth asking
// for its parameters). ~24 tokens per workflow instead of ~2,500.
function workflowSummary(workflow) {
  return {
    id: workflow.id,
    name: workflow.name,
    parameterCount: Array.isArray(workflow.parameters) ? workflow.parameters.length : 0,
    outputCount: Array.isArray(workflow.outputs) ? workflow.outputs.length : 0
  };
}

// full — everything needed to run it, nothing else.
function workflowFull(workflow) {
  return {
    ...workflowSummary(workflow),
    parameters: (workflow.parameters || []).map(callableParameter),
    outputs: (workflow.outputs || []).map(callableOutput)
  };
}

// inputs — adds the unconfigured candidates, for choosing a NEW parameter or
// output selection via update_workflow. Expensive; ask for one workflow.
function workflowWithCandidates(workflow) {
  return {
    ...workflowFull(workflow),
    availableInputs: workflow.availableInputs || [],
    availableOutputs: workflow.availableOutputs || []
  };
}

const WORKFLOW_PROJECTIONS = {
  summary: workflowSummary,
  full: workflowFull,
  inputs: workflowWithCandidates
};

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
    description: 'List the ComfyUI workflows saved in the library. Returns a compact summary by default (id, name, parameter/output counts) — a full library is far too large to return in detail, so narrow it down first. Pass `name` (or `workflowId`) to get one workflow\'s parameters, which is what run_workflow needs: each parameter has id/name/valueType/defaultValue, plus enums when it only accepts a fixed list of values. Use detail:"inputs" only when reconfiguring a workflow with update_workflow — it adds every candidate node input in the graph and is very large.',
    inputSchema: {
      name: z.string().optional().describe('Case-insensitive substring filter on the workflow name. Implies detail:"full" unless detail is set.'),
      workflowId: z.number().int().optional().describe('Return just this workflow. Implies detail:"full" unless detail is set.'),
      detail: z.enum(['summary', 'full', 'inputs']).optional()
        .describe('summary = id/name/counts (default when listing everything); full = + the parameters and outputs needed to run it (default when name/workflowId is given); inputs = + every candidate node input, for update_workflow only.')
    },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ name, workflowId, detail } = {}) => {
    const workflows = (await api.apiJson('GET', '/library/comfy-workflows'))?.filter?.(Boolean) ?? [];

    const needle = name?.trim().toLowerCase();
    const matched = workflows.filter(workflow => {
      if (workflowId !== undefined && workflow?.id !== workflowId) return false;
      if (needle && !String(workflow?.name || '').toLowerCase().includes(needle)) return false;
      return true;
    });

    // Asking for a specific workflow means you want to use it, so default to
    // the detail that lets you — but never override an explicit choice.
    const level = detail ?? ((needle || workflowId !== undefined) ? 'full' : 'summary');
    const project = WORKFLOW_PROJECTIONS[level] ?? workflowSummary;

    return {
      count: matched.length,
      totalInLibrary: workflows.length,
      detail: level,
      ...(level === 'summary' && matched.length > 0
        ? { hint: 'Summary only — call again with name or workflowId to get a workflow\'s parameters before run_workflow.' }
        : {}),
      workflows: matched.map(workflow => project(summarizeWorkflow(workflow)))
    };
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
    description: 'Save a ComfyUI workflow into the library. parameters selects which inspected inputs become runtime parameters ({id, name?, valueType?: image|mesh|video|string|number|boolean, enums?: allowed values for a string/number parameter}); outputs selects which terminal nodes\' results are saved ({nodeId, name?}). At least one output is required. When importing a .3dgw share bundle via filePath, the bundled parameter/output configuration is used automatically unless overridden.',
    inputSchema: {
      name: z.string().min(1).describe('Workflow name in the library'),
      workflowJson: z.any().optional().describe('ComfyUI API-format graph JSON (object or string)'),
      filePath: z.string().optional().describe('Absolute path to a local workflow .json or .3dgw file'),
      parameters: z.array(z.object({
        id: z.string(),
        name: z.string().optional(),
        valueType: z.string().optional(),
        enums: z.array(z.union([z.string(), z.number()])).optional()
          .describe('Allowed values for a string/number parameter — the app renders it as a dropdown limited to this list. Ignored for other value types.')
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
      inputs: z.record(z.string(), z.any()).default({}).describe('A FLAT map of parameter id -> BARE value: {"6.text": "a red robot", "7.noise_seed": 42}. Never wrap a value in an object or array ({"6.text": {"value": "..."}} is rejected). Ids come from list_workflows and look like "<nodeId>.<inputKey>" — an unknown id is an error, and an omitted parameter keeps its saved default. For an image/mesh parameter pass the asset\'s numeric id (from list_assets / a generation result) — this is ALL you need. The SAME plain id works for a root asset, an edit, or a version (e.g. a background-removed image is an edit — pass that edit\'s own id). Do NOT pass a file path/filename, and do NOT pass a {assetId, editId} object — a bare number is correct. Non-file parameters take their literal value (string/number/boolean).'),
      fileInputs: z.record(z.string(), z.string()).optional().describe('Parameter id -> absolute local file path to upload for image/mesh/video parameters'),
      nodeId: z.number().int().optional().describe('Graph node to attach the results to (graph projects) — the correct way to fill a node; without it the generated assets are saved but no node displays them'),
      cardId: z.union([z.number().int(), z.string()]).optional().describe('Existing KANBAN card to attach the run to (kanban projects). For graph nodes use nodeId — a graph node id passed here is auto-routed to that node'),
      name: z.string().optional().describe('Name for the generated asset(s)'),
      parentAssetId: z.number().int().optional().describe('Save results under this asset: a mesh output becomes a version of it, an image output an edit of it (the parent must match the output type, else a new root asset is created). USUALLY LEAVE UNSET — it is inferred automatically from the source the output was derived from: the workflow file (image/mesh) input matching the output type, whether that input came from the target node\'s wiring or was passed in `inputs`. Set this only to override that inference (e.g. attach to a different asset).'),
      tags: tagsInput,
      persistProcessingCard: z.boolean().optional(),
      persistGeneratedAssets: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(5).max(3600).default(600)
    }
  }, toolHandler(async (args, extra) => {
    const {
      workflowId, projectId, inputs = {}, fileInputs, nodeId, cardId, name,
      parentAssetId, tags, persistProcessingCard, persistGeneratedAssets, timeoutSeconds = 600
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

    // Repair the recoverable input shapes and reject the rest BEFORE the run is
    // queued, so a bad call comes back as a correctable error instead of a
    // "successful" generation on default values.
    const { inputs: normalizedInputs, fileInputs: normalizedFileInputs, warnings: inputWarnings } =
      normalizeWorkflowInputs({ inputs, fileInputs, workflowDef });

    // Auto-fill each unset image/mesh/video parameter from a connected input of
    // the matching type (each connected asset used at most once). Explicit `inputs`
    // and `fileInputs` always win over an auto-filled value.
    const autoInputs = {};
    if (nodeInputAssets.length > 0 && fileParams.length > 0) {
      const available = nodeInputAssets.map(asset => ({ ...asset, used: false }));
      for (const parameter of fileParams) {
        const explicitlySet = (normalizedInputs[parameter.id] !== undefined && normalizedInputs[parameter.id] !== null)
          || (normalizedFileInputs && normalizedFileInputs[parameter.id]);
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

      const inputValues = { ...autoInputs, ...normalizedInputs };
      for (const [key, localPath] of Object.entries(normalizedFileInputs || {})) {
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
          ...(inputWarnings.length > 0 ? { warnings: inputWarnings } : {}),
          ...(tags?.length ? { tags } : {}),
          note: `Still running after ${timeoutSeconds}s. The workflow continues in the background — call get_run_status with this promptId to check on it${tags?.length ? ' (pass tags too — the results are not saved yet, so nothing has been tagged yet)' : ''}; results are attached to the project when it finishes.`
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
        ...(inputWarnings.length > 0 ? { warnings: inputWarnings } : {}),
        ...(nodeAttachment ? { nodeAttachment } : {}),
        ...(await applyAssetTags(api, tags, assets))
      };
    } finally {
      if (timer) clearTimeout(timer);
      subscription.close();
    }
  }));

  server.registerTool('get_run_status', {
    title: 'Get workflow run status',
    description: 'Check on a ComfyUI workflow run by promptId (returned by run_workflow). Returns the latest progress snapshot: status (processing/completed/error), progressPercent, detail, and the generated assets once done. Pass tags to label those assets when the run has finished — use it to apply the tags a run_workflow call could not, because it timed out before anything was saved.',
    inputSchema: {
      promptId: z.string().min(1),
      tags: tagsInput
    }
  }, toolHandler(async ({ promptId, tags }) => {
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
    // Only a finished run has assets to tag. Tagging is additive, so polling
    // this repeatedly with the same tags is harmless.
    if (!snapshot.done && snapshot.status !== 'completed') return snapshot;
    const assets = Array.isArray(snapshot.result) ? snapshot.result : (snapshot.result ? [snapshot.result] : []);
    return { ...snapshot, ...(await applyAssetTags(api, tags, assets)) };
  }));
}
