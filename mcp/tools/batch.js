// Batch projects over MCP.
//
// A Batch project is a GRID, not a graph: `variables` are declared once,
// each `group` is one ROW of values for them, and `stages` are a linear chain
// of ComfyUI workflows run once per row. N groups x M stages = N*M generations,
// and each executed cell becomes an ordinary project Card carrying its asset.
//
// THE DOCUMENT MODEL IS SHARED WITH THE BATCH PAGE (batch/document.js at the
// repo root). Everything that decides what a run actually sends to ComfyUI —
// how a binding resolves, which upstream asset a result is filed under, what a
// result card is called and keyed by — is imported from there rather than
// reimplemented, so a batch run started here and one started from the page
// produce the same assets in the same places.
//
// IDS NEVER LEAVE THIS FILE. The document keys groups, variables and stages by
// generated ids, which an agent cannot invent and would only mis-copy; the
// tools speak variable NAMES and 1-based stage/group positions instead, and
// translate at the edge. Ids are preserved across an update wherever they can
// be (same position, same workflow), because a result card's key embeds the
// group and stage id — regenerate those and the grid forgets its results.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { toolHandler, createProgressReporter, withAssetUrls } from '../client.js';
import { executeComfyRun } from '../comfyRun.js';
import { applyAssetTags, tagsInput } from '../assetTags.js';
import { createParameterResolver } from './workflows.js';
import {
  BATCH_EXECUTION_ORDERS,
  BATCH_VARIABLE_TYPES,
  BINDING_MANUAL,
  BINDING_STAGE,
  BINDING_VARIABLE,
  buildBatchCardKey,
  buildResultName,
  buildRunOrder,
  createBatchAssetValue,
  createGroup,
  createStage,
  createStageDefaultBindings,
  createStageDefaultInputs,
  createVariable,
  deriveCellsFromAssets,
  findParentAssetForStage,
  getBinding,
  getGroupLabel,
  getRunIdFromCells,
  getStageLabel,
  getVariableLabel,
  getWorkflowParameterValueType,
  isBatchAssetValue,
  isBatchStageWorkflow,
  isFileWorkflowValueType,
  isVariableCompatibleWithValueType,
  normalizeBatchConfig,
  normalizeExecutionOrder,
  resolveStageInputs,
  summarizeRunProgress,
  toBatchBoolean,
  validateBatch,
  variableValueKind
} from '../../batch/document.js';

// --- loading ---------------------------------------------------------------

// The batch document, refused for a project that is not a Batch one. A Graph or
// Kanban project has no Batch page, so a config written to it would be stored,
// never shown and never runnable — an error the caller can act on beats a
// silent write into a project nobody will open.
async function loadBatch(api, projectId) {
  const project = await api.apiJson('GET', `/projects/${projectId}`);
  const preset = String(project?.preset || '');
  if (preset && preset.toLowerCase() !== 'batch') {
    throw new Error(`Project ${projectId} ("${project?.name || ''}") is a ${preset} project. The batch tools only work on Batch projects — create one with create_project preset "batch".`);
  }
  const stored = await api.apiJson('GET', `/projects/${projectId}/batch-config`);
  return { project, config: normalizeBatchConfig(stored?.state) };
}

// The workflows a stage may run, exactly as the Batch page offers them: the
// library filtered to what produces an image or a mesh. Anything else is left
// out of the map, which is what makes a stage pointing at it report "no
// workflow selected" here as well as on the page.
async function loadStageWorkflows(api) {
  const library = await api.apiJson('GET', '/library/comfy-workflows').catch(() => []);
  const byId = {};
  for (const workflow of Array.isArray(library) ? library : []) {
    if (isBatchStageWorkflow(workflow)) byId[String(workflow.id)] = workflow;
  }
  return byId;
}

async function saveBatch(api, projectId, config) {
  await api.apiJson('PUT', `/projects/${projectId}/batch-config`, { body: { state: config } });
  return config;
}

// --- projections (document -> what an agent reads) -------------------------

function variableView(variable, index) {
  return { name: getVariableLabel(variable, index), type: variable?.type || 'string' };
}

function groupView(group, index, variables) {
  const values = {};
  variables.forEach((variable, variableIndex) => {
    const raw = group?.values?.[variable.id];
    if (raw === undefined || raw === null || raw === '') return;
    values[getVariableLabel(variable, variableIndex)] = isBatchAssetValue(raw)
      ? { assetId: raw.assetId ?? null, name: raw.name || '', type: raw.type || null }
      : raw;
  });
  return { position: index + 1, name: getGroupLabel(group, index), values };
}

// A binding as the tools speak it: "manual", "variable:<name>", "stage:<n>".
function bindingView(binding, { variables, stages }) {
  if (binding?.source === BINDING_VARIABLE) {
    const index = variables.findIndex(item => item.id === binding.variableId);
    return index === -1 ? 'variable:(deleted)' : `variable:${getVariableLabel(variables[index], index)}`;
  }
  if (binding?.source === BINDING_STAGE) {
    const index = stages.findIndex(item => item.id === binding.stageId);
    return index === -1 ? 'stage:(deleted)' : `stage:${index + 1}`;
  }
  return BINDING_MANUAL;
}

function stageView(stage, index, { config, workflowsById }) {
  const workflow = workflowsById[String(stage?.workflowId)] || null;
  const { variables, stages } = config;

  return {
    position: index + 1,
    name: stage?.name || '',
    workflowId: Number(stage?.workflowId) || null,
    workflowName: workflow?.name || null,
    ...(workflow ? {} : {
      problem: 'No usable workflow: the id is not in the library, or the workflow produces neither an image nor a mesh (only those can be a batch stage).'
    }),
    parameters: (workflow?.parameters || []).map(parameter => {
      const valueType = getWorkflowParameterValueType(parameter);
      const source = bindingView(getBinding(stage, parameter.id), { variables, stages });
      return {
        id: parameter.id,
        name: parameter.name,
        valueType,
        source,
        // Shown even when the parameter is bound to a variable: a group that
        // leaves that variable blank falls back to this value.
        ...(isFileWorkflowValueType(valueType) ? {} : { value: stage?.inputs?.[parameter.id] ?? null })
      };
    })
  };
}

function configView(config, workflowsById) {
  const { variables, groups, stages, executionOrder } = config;
  return {
    executionOrder,
    plannedRuns: groups.length * stages.length,
    variables: variables.map(variableView),
    groups: groups.map((group, index) => groupView(group, index, variables)),
    stages: stages.map((stage, index) => stageView(stage, index, { config, workflowsById })),
    problems: validateBatch({ config, workflowsById }).map(problem => problem.message)
  };
}

// The last run's grid, rebuilt from the project's cards exactly as reopening
// the Batch page rebuilds it.
async function loadResults(api, projectId, config) {
  const assets = await api.apiJson('GET', '/assets', { query: { projectId, includeChildren: 'true' } })
    .catch(() => []);
  const list = Array.isArray(assets) ? assets : [];
  const byId = new Map(list.map(asset => [Number(asset?.id), asset]));
  const cells = deriveCellsFromAssets(list, config);

  const results = [];
  config.groups.forEach((group, groupIndex) => {
    config.stages.forEach((stage, stageIndex) => {
      const cell = cells[`${group.id}:${stage.id}`];
      if (!cell) return;
      const asset = byId.get(Number(cell.assetId));
      results.push({
        group: getGroupLabel(group, groupIndex),
        stage: getStageLabel(stage, stageIndex),
        status: cell.status,
        assetId: cell.assetId ?? null,
        assetType: cell.assetType || asset?.type || null,
        name: asset?.name || null,
        ...(asset ? { url: withAssetUrls(api, asset).url || null } : {})
      });
    });
  });

  return { cells, results, progress: summarizeRunProgress(cells, config) };
}

// --- writing (what an agent sends -> document) ------------------------------

function findByLabel(items, label, labelFor) {
  const wanted = String(label || '').trim().toLowerCase();
  const index = items.findIndex((item, position) => labelFor(item, position).trim().toLowerCase() === wanted);
  return { index, item: index === -1 ? null : items[index] };
}

// Replace the declared variables. Matching an incoming entry to an existing one
// by name (or by renameFrom) is what keeps its id — and with it every group
// value and every stage binding that points at it.
function applyVariables(config, incoming) {
  const previous = config.variables;
  const seen = new Set();
  const nextVariables = [];

  for (const entry of incoming) {
    const name = String(entry?.name || '').trim();
    if (!name) throw new Error('Every variable needs a name — it is what groups and stage bindings refer to.');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Two variables are named "${name}". Names must be unique — they are how a group value and a binding find their variable.`);
    seen.add(key);

    const lookupName = entry.renameFrom ? String(entry.renameFrom) : name;
    const { item: existing } = findByLabel(previous, lookupName, getVariableLabel);
    const type = BATCH_VARIABLE_TYPES.includes(entry?.type) ? entry.type : 'string';

    nextVariables.push(existing
      ? { ...existing, name, type }
      : { ...createVariable(name, type) });
  }

  const keptIds = new Set(nextVariables.map(variable => variable.id));
  // Retyping across value kinds (file / boolean / scalar) makes the values
  // groups already hold meaningless, so they go with the old type rather than
  // being left to fail at run time — the same rule the page applies.
  const retyped = new Set(
    nextVariables
      .filter(variable => {
        const before = previous.find(item => item.id === variable.id);
        return before && variableValueKind(before.type) !== variableValueKind(variable.type);
      })
      .map(variable => variable.id)
  );

  return {
    ...config,
    variables: nextVariables,
    groups: config.groups.map(group => ({
      ...group,
      values: Object.fromEntries(
        Object.entries(group.values || {}).filter(([id]) => keptIds.has(id) && !retyped.has(id))
      )
    })),
    stages: config.stages.map(stage => ({
      ...stage,
      bindings: Object.fromEntries(
        Object.entries(stage.bindings || {}).filter(([, binding]) => (
          binding?.source !== BINDING_VARIABLE || (keptIds.has(binding.variableId) && !retyped.has(binding.variableId))
        ))
      )
    }))
  };
}

// "manual" | "variable:<name>" | "stage:<n>" -> a document binding, refusing the
// two shapes that would compile and then quietly misbehave: a variable that
// cannot carry the parameter's type, and a stage that runs LATER (a batch chain
// is strictly forward, which is why it can never contain a cycle).
function parseBinding(text, { parameter, valueType, variables, stageCount, stagePosition }) {
  const raw = String(text || '').trim();
  const label = parameter.name || parameter.id;

  if (!raw || raw.toLowerCase() === BINDING_MANUAL) {
    if (isFileWorkflowValueType(valueType)) {
      throw new Error(`"${label}" is ${valueType === 'image' ? 'an' : 'a'} ${valueType} input and cannot take a manual value. Bind it to an earlier stage ("stage:1") or to ${valueType === 'image' ? 'an' : 'a'} ${valueType} variable ("variable:<name>").`);
    }
    return { source: BINDING_MANUAL };
  }

  const separator = raw.indexOf(':');
  const kind = (separator === -1 ? raw : raw.slice(0, separator)).trim().toLowerCase();
  const reference = separator === -1 ? '' : raw.slice(separator + 1).trim();

  if (kind === BINDING_VARIABLE) {
    const { index, item } = findByLabel(variables, reference, getVariableLabel);
    if (index === -1) {
      throw new Error(`"${label}": no variable named "${reference}". Declared variables: ${variables.map((variable, position) => getVariableLabel(variable, position)).join(', ') || '(none)'}.`);
    }
    if (!isVariableCompatibleWithValueType(item, valueType)) {
      throw new Error(`"${label}" is a ${valueType} input and cannot be fed by "${getVariableLabel(item, index)}", which is a ${item.type} variable.`);
    }
    return { source: BINDING_VARIABLE, variableId: item.id };
  }

  if (kind === BINDING_STAGE) {
    const position = Number(reference);
    if (!Number.isInteger(position) || position < 1 || position > stageCount) {
      throw new Error(`"${label}": "stage:${reference}" is not a stage position. Use a 1-based position between 1 and ${stageCount}.`);
    }
    if (position >= stagePosition) {
      throw new Error(`"${label}": stage ${stagePosition} cannot read the output of stage ${position}. A stage may only consume an EARLIER stage's output.`);
    }
    return { source: BINDING_STAGE, position };
  }

  throw new Error(`"${label}": "${raw}" is not a source. Use "manual", "variable:<name>" or "stage:<n>".`);
}

// Replace the stage chain. A stage keeps its id (and therefore its results)
// while it stays at the same position running the same workflow; changing its
// workflow re-seeds its values from that workflow's defaults, because the old
// ones were keyed to parameter ids that no longer exist.
function applyStages(config, incoming, workflowsById) {
  const previous = config.stages;
  const draft = incoming.map((entry, index) => {
    const workflowId = Number(entry?.workflowId);
    const workflow = workflowsById[String(workflowId)] || null;
    if (!workflow) {
      throw new Error(`Stage ${index + 1}: workflow ${entry?.workflowId} is not available as a batch stage. A stage workflow must be in the library AND produce an image or a mesh — call list_workflows to find one.`);
    }

    const existing = previous[index] || null;
    const keepsId = Boolean(existing) && String(existing.workflowId) === String(workflowId);
    const base = keepsId
      ? existing
      : { ...createStage(), workflowId, inputs: createStageDefaultInputs(workflow), bindings: {} };

    return {
      stage: {
        ...base,
        workflowId,
        name: entry?.name !== undefined ? String(entry.name) : (base.name || ''),
        inputs: { ...(base.inputs || {}) },
        bindings: { ...(base.bindings || {}) }
      },
      workflow,
      entry,
      seedBindings: !keepsId
    };
  });

  // Seeded first, so a chain given with no bindings at all still wires each file
  // input to the stage before it, exactly as adding stages on the page does.
  draft.forEach((item, index) => {
    if (!item.seedBindings) return;
    const chainSoFar = draft.map(other => other.stage);
    item.stage.bindings = {
      ...createStageDefaultBindings(item.workflow, chainSoFar, index, config.variables),
      ...item.stage.bindings
    };
  });

  draft.forEach((item, index) => {
    const { stage, workflow, entry } = item;
    const resolveParameterId = createParameterResolver(workflow.parameters || []);
    const byId = new Map((workflow.parameters || []).map(parameter => [String(parameter.id), parameter]));
    const parameterIds = () => [...byId.keys()].join(', ');

    for (const [key, value] of Object.entries(entry?.inputs || {})) {
      const { id } = resolveParameterId(key);
      const parameter = id ? byId.get(id) : null;
      if (!parameter) {
        throw new Error(`Stage ${index + 1}: "${key}" is not a parameter of "${workflow.name}". Its parameters: ${parameterIds()}.`);
      }
      const valueType = getWorkflowParameterValueType(parameter);
      if (isFileWorkflowValueType(valueType)) {
        throw new Error(`Stage ${index + 1}: "${key}" is ${valueType === 'image' ? 'an' : 'a'} ${valueType} input, so it takes a binding, not a value. Put "${id}": "stage:1" (or "variable:<name>") in bindings instead.`);
      }
      stage.inputs[id] = valueType === 'boolean' ? toBatchBoolean(value) : value;
    }

    for (const [key, source] of Object.entries(entry?.bindings || {})) {
      const { id } = resolveParameterId(key);
      const parameter = id ? byId.get(id) : null;
      if (!parameter) {
        throw new Error(`Stage ${index + 1}: "${key}" is not a parameter of "${workflow.name}". Its parameters: ${parameterIds()}.`);
      }
      const binding = parseBinding(source, {
        parameter,
        valueType: getWorkflowParameterValueType(parameter),
        variables: config.variables,
        stageCount: draft.length,
        stagePosition: index + 1
      });
      // Resolved to an id only now that every stage in the new chain exists.
      stage.bindings[id] = binding.source === BINDING_STAGE
        ? { source: BINDING_STAGE, stageId: draft[binding.position - 1].stage.id }
        : binding;
    }
  });

  const stages = draft.map(item => item.stage);
  const orderById = new Map(stages.map((stage, position) => [stage.id, position]));

  return {
    ...config,
    // Reordering can leave a kept binding pointing forwards (or at a stage that
    // is gone). Those are dropped rather than left silently broken — the same
    // rule the page applies when a stage is moved or removed.
    stages: stages.map((stage, position) => ({
      ...stage,
      bindings: Object.fromEntries(
        Object.entries(stage.bindings || {}).filter(([, binding]) => (
          binding?.source !== BINDING_STAGE || (orderById.get(binding.stageId) ?? Infinity) < position
        ))
      )
    }))
  };
}

// One group value. An image/mesh variable holds an asset reference, and the
// asset has to be a member of this project before a run may use it — linking it
// here is what the page's picker does through /assets/resolve-source.
async function resolveGroupValue(api, projectId, variable, value) {
  if (variable.type === 'boolean') return toBatchBoolean(value);
  if (!isFileWorkflowValueType(variable.type)) return value;

  const assetId = Number(
    typeof value === 'object' && value !== null
      ? value.assetId
      : String(value).replace(/^asset:/, '')
  );
  if (!Number.isFinite(assetId) || assetId <= 0) {
    throw new Error(`"${variable.name}" is ${variable.type === 'image' ? 'an' : 'a'} ${variable.type} variable, so its value is an asset id (a number, or "asset:<id>"), not ${JSON.stringify(value)}. Find one with list_assets or find_assets_by_tags.`);
  }

  const asset = await api.apiJson('POST', `/projects/${projectId}/assets`, { body: { assetId } });
  const assetType = String(asset?.type || '').toLowerCase();
  if (assetType && assetType !== variable.type) {
    throw new Error(`Asset ${assetId} is ${assetType === 'image' ? 'an' : 'a'} ${assetType}, but "${variable.name}" is ${variable.type === 'image' ? 'an' : 'a'} ${variable.type} variable.`);
  }

  return createBatchAssetValue({
    source: `asset:${assetId}`,
    assetId,
    name: asset?.name || '',
    // A mesh with no rendered thumbnail draws its icon; pointing an <img> at the
    // .glb itself would just be a broken image in the group card.
    thumbnail: variable.type === 'mesh'
      ? (asset?.thumbnail || null)
      : (asset?.thumbnail || asset?.filename || null),
    type: variable.type,
    origin: 'library'
  });
}

// Replace the group rows. Ids are kept by position so a row that is only being
// edited keeps the results already sitting in its cells.
async function applyGroups(api, projectId, config, incoming) {
  const groups = [];

  for (const [index, entry] of incoming.entries()) {
    const existing = config.groups[index] || null;
    const group = {
      ...(existing || createGroup()),
      name: entry?.name !== undefined ? String(entry.name) : (existing?.name || ''),
      values: {}
    };

    for (const [key, value] of Object.entries(entry?.values || {})) {
      const { index: variableIndex, item: variable } = findByLabel(config.variables, key, getVariableLabel);
      if (variableIndex === -1) {
        throw new Error(`Group ${index + 1}: no variable named "${key}". Declared variables: ${config.variables.map((item, position) => getVariableLabel(item, position)).join(', ') || '(none)'}.`);
      }
      // A blank value is not an error: a group is sparse on purpose, and the
      // stage's own manual value fills the gap.
      if (value === undefined || value === null || String(value).trim() === '') continue;
      group.values[variable.id] = await resolveGroupValue(api, projectId, {
        ...variable,
        name: getVariableLabel(variable, variableIndex)
      }, value);
    }

    groups.push(group);
  }

  return { ...config, groups };
}

// --- run selection ---------------------------------------------------------

// A "run only these" filter entry: a 1-based position or a name.
function buildSelector(items, requested, labelFor, what) {
  if (!requested || requested.length === 0) return () => true;

  const selected = new Set();
  for (const term of requested) {
    const text = String(term).trim();
    const position = Number(text);
    if (Number.isInteger(position) && position >= 1 && position <= items.length) {
      selected.add(items[position - 1].id);
      continue;
    }
    const { item } = findByLabel(items, text, labelFor);
    if (!item) {
      throw new Error(`No ${what} called "${text}". This batch's ${what}s: ${items.map((entry, index) => `${index + 1}. ${labelFor(entry, index)}`).join(', ') || '(none)'}.`);
    }
    selected.add(item.id);
  }
  return item => selected.has(item.id);
}

export function registerBatchTools(server, { api, notifyMutation }) {
  server.registerTool('get_batch', {
    title: 'Get batch project',
    description: 'Read a Batch project: its variables (declared once), its groups (one ROW of values per variable — each group is one iteration), its stage chain (the ComfyUI workflows run per group, with every parameter\'s source and manual value), the problems that would block a run, and the results already produced. Sources read as "manual", "variable:<name>" or "stage:<n>" (1-based). Call this before update_batch — it is where the parameter ids and the variable names come from.',
    inputSchema: {
      projectId: z.number().int().describe('Batch project id (from list_projects)'),
      includeResults: z.boolean().default(true).describe('Include the last run\'s grid (one row per produced cell, with its asset). Set false for the recipe alone.')
    },
    annotations: { readOnlyHint: true }
  }, toolHandler(async ({ projectId, includeResults = true }) => {
    const [{ project, config }, workflowsById] = await Promise.all([
      loadBatch(api, projectId),
      loadStageWorkflows(api)
    ]);

    const view = { projectId, projectName: project?.name || '', ...configView(config, workflowsById) };
    if (!includeResults) return view;

    const { results, progress } = await loadResults(api, projectId, config);
    return { ...view, progress, results };
  }));

  server.registerTool('update_batch', {
    title: 'Update batch project',
    description: 'Write a Batch project\'s recipe. Each section you pass REPLACES that whole section (a section you omit is untouched), so read it with get_batch first and send the full list back with your changes. `variables` declares what varies, by name and type (string/number/boolean/image/mesh). `groups` are the rows: values is a map of variable NAME -> value, and an image/mesh variable takes an asset id (the asset is linked to the project for you); a variable a group leaves out falls back to the stage\'s own manual value. `stages` is the chain, in order: each takes a workflowId (it must produce an image or a mesh), an optional name — a template, where "{{variable name}}" is replaced per group and becomes the result\'s name — plus `inputs` (parameter id -> manual value) and `bindings` (parameter id -> "manual" | "variable:<name>" | "stage:<n>", 1-based and strictly EARLIER). inputs/bindings are merged into the stage, so pass only what changes. Image/mesh parameters cannot take a manual value: bind them. Positions carry identity — a group or stage kept at the same position keeps the results already in its cells, and a stage keeps its values while its workflow is unchanged.',
    inputSchema: {
      projectId: z.number().int(),
      variables: z.array(z.object({
        name: z.string().min(1).describe('Referred to by this name in group values and in "variable:<name>" bindings'),
        type: z.enum(BATCH_VARIABLE_TYPES).default('string'),
        renameFrom: z.string().optional().describe('Existing variable name this entry renames — without it a new name means a NEW variable and the old one\'s values and bindings are dropped')
      })).optional().describe('Replaces the declared variables'),
      groups: z.array(z.object({
        name: z.string().optional().describe('Row label, also usable in a stage name template'),
        values: z.record(z.string(), z.any()).default({}).describe('Variable NAME -> value. Scalar for string/number, true/false for boolean, an asset id (number or "asset:<id>") for image/mesh. Omit one to fall back to the stage\'s manual value.')
      })).optional().describe('Replaces the group rows — one run of the whole chain each'),
      stages: z.array(z.object({
        name: z.string().optional().describe('Result name template, e.g. "{{character}} - {{resolution}}px"'),
        workflowId: z.number().int().describe('Saved ComfyUI workflow id (from list_workflows) — must produce an image or a mesh'),
        inputs: z.record(z.string(), z.any()).optional().describe('Parameter id -> manual value, for parameters left on "manual"'),
        bindings: z.record(z.string(), z.string()).optional().describe('Parameter id -> "manual" | "variable:<name>" | "stage:<n>"')
      })).optional().describe('Replaces the stage chain, in execution order'),
      executionOrder: z.enum(BATCH_EXECUTION_ORDERS).optional().describe('"group" walks one group through every stage before the next group; "stage" runs one stage across all groups first, which keeps ComfyUI from reloading a model at every stage boundary. Same results either way.')
    }
  }, toolHandler(async ({ projectId, variables, groups, stages, executionOrder }) => {
    if (variables === undefined && groups === undefined && stages === undefined && executionOrder === undefined) {
      throw new Error('Nothing to update: pass variables, groups, stages or executionOrder.');
    }

    const [{ config }, workflowsById] = await Promise.all([
      loadBatch(api, projectId),
      loadStageWorkflows(api)
    ]);

    // Variables first: groups and stages both refer to them, so the new set has
    // to exist before either is rebuilt against it.
    let next = config;
    if (variables !== undefined) next = applyVariables(next, variables);
    if (stages !== undefined) next = applyStages(next, stages, workflowsById);
    if (groups !== undefined) next = await applyGroups(api, projectId, next, groups);
    if (executionOrder !== undefined) next = { ...next, executionOrder: normalizeExecutionOrder(executionOrder) };

    await saveBatch(api, projectId, next);
    notifyMutation(projectId);

    return { projectId, updated: true, ...configView(next, workflowsById) };
  }));

  server.registerTool('run_batch', {
    title: 'Run batch project',
    description: 'Run the batch: every group through every stage, one ComfyUI generation per cell, each saved as a result card in the project (streams MCP progress). CONTINUES by default — cells that already produced an asset are kept and reused as inputs for the stages after them, so a stopped or partial run picks up where it left off; mode "restart" regenerates everything instead. `groups` / `stages` limit the walk to some rows or some steps (by name or 1-based position), which combined with mode "restart" is how you regenerate a single cell. A stage bound to an earlier stage receives that stage\'s output for the SAME group, which is what makes a chain (image -> mesh -> texture) work. Refuses to start while get_batch reports problems. Requires ComfyUI to be running. Long batches are budgeted: when maxSeconds runs out the tool returns what finished and you call it again to carry on.',
    inputSchema: {
      projectId: z.number().int(),
      mode: z.enum(['continue', 'restart']).default('continue').describe('"continue" skips cells that already have a result; "restart" regenerates the selected cells'),
      groups: z.array(z.string()).optional().describe('Only these groups, by name or 1-based position (default: all)'),
      stages: z.array(z.string()).optional().describe('Only these stages, by name or 1-based position (default: all)'),
      executionOrder: z.enum(BATCH_EXECUTION_ORDERS).optional().describe('Override the saved walk order for this run (and save it)'),
      tags: tagsInput,
      timeoutSeconds: z.number().int().min(5).max(3600).default(900).describe('How long to wait for ONE cell before giving up on the run'),
      maxSeconds: z.number().int().min(30).max(21600).default(3600).describe('Budget for the whole call — when it runs out the tool returns and the rest is left for the next run_batch')
    }
  }, toolHandler(async (args, extra) => {
    const {
      projectId, mode = 'continue', groups: groupFilter, stages: stageFilter,
      executionOrder, tags, timeoutSeconds = 900, maxSeconds = 3600
    } = args;
    const reportProgress = createProgressReporter(extra);

    // The Batch page runs its batches in the backend (batch/runner.js). Two
    // loops on one grid would queue every outstanding cell twice.
    const backendRun = await api.apiJson('GET', `/comfyui/batch-runs/${projectId}`).catch(() => null);
    if (['running', 'cancelling'].includes(backendRun?.run?.status)) {
      throw new Error(`This batch is already running (started from the Batch page). Wait for it to finish, or stop it there, before calling run_batch.`);
    }

    const [{ project, config: stored }, workflowsById] = await Promise.all([
      loadBatch(api, projectId),
      loadStageWorkflows(api)
    ]);

    const config = executionOrder !== undefined
      ? { ...stored, executionOrder: normalizeExecutionOrder(executionOrder) }
      : stored;
    if (executionOrder !== undefined) await saveBatch(api, projectId, config);

    const { variables, groups, stages } = config;
    const problems = validateBatch({ config, workflowsById });
    if (problems.length > 0) {
      throw new Error([
        `This batch cannot run yet — ${problems.length} problem(s):`,
        ...problems.slice(0, 20).map(problem => `  - ${problem.message}`),
        ...(problems.length > 20 ? [`  … and ${problems.length - 20} more (get_batch lists them all)`] : []),
        'Fix them with update_batch.'
      ].join('\n'));
    }

    const isGroupSelected = buildSelector(groups, groupFilter, getGroupLabel, 'group');
    const isStageSelected = buildSelector(stages, stageFilter, getStageLabel, 'stage');
    const filtered = Boolean(groupFilter?.length || stageFilter?.length);

    // A filtered restart re-runs inside the SAME run, so the cells it does not
    // touch keep showing their results; an unfiltered restart starts a new run
    // and abandons the old grid, which is what the page's Restart does.
    const { cells: priorCells } = await loadResults(api, projectId, config);
    const reuseRun = mode === 'continue' || filtered;
    const runId = (reuseRun && getRunIdFromCells(priorCells)) || randomUUID().slice(0, 18);
    const previous = reuseRun ? priorCells : {};

    const steps = buildRunOrder(groups, stages, config.executionOrder);
    const outputsByGroup = new Map();
    const startedAt = Date.now();
    const cells = [];
    const producedAssets = [];
    let stopped = null;
    let ran = 0;

    for (const [stepIndex, { group, groupIndex, stage, stageIndex, cellKey }] of steps.entries()) {
      if (!outputsByGroup.has(group.id)) outputsByGroup.set(group.id, {});
      const stageOutputs = outputsByGroup.get(group.id);

      const label = {
        group: getGroupLabel(group, groupIndex),
        stage: getStageLabel(stage, stageIndex)
      };
      const selected = isGroupSelected(group) && isStageSelected(stage);
      const prior = previous[cellKey];
      const priorDone = prior?.status === 'completed' && Boolean(prior.assetId);

      // Keep what is already there — and publish it, so the stages after it in
      // this group can chain onto it without regenerating it.
      if (priorDone && (mode === 'continue' || !selected)) {
        stageOutputs[stage.id] = { id: prior.assetId, type: prior.assetType || null };
        cells.push({ ...label, status: 'kept', assetId: prior.assetId });
        continue;
      }
      if (!selected) {
        cells.push({ ...label, status: 'skipped' });
        continue;
      }
      if (stopped) {
        cells.push({ ...label, status: 'not-run' });
        continue;
      }
      if (Date.now() - startedAt > maxSeconds * 1000) {
        stopped = 'budget';
        cells.push({ ...label, status: 'not-run' });
        continue;
      }

      const workflow = workflowsById[String(stage.workflowId)];
      const { inputs, missing } = resolveStageInputs({ stage, workflow, group, variables, stageOutputs, stages });
      if (missing.length > 0) {
        cells.push({
          ...label,
          status: 'error',
          error: missing.map(item => `${item.label}: ${item.reason}`).join(' · ')
        });
        continue;
      }

      const cardKey = buildBatchCardKey(runId, group.id, stage.id);
      const resultName = buildResultName({ group, groupIndex, stage, stageIndex, variables });
      // The upstream asset this cell consumed, so the result is filed under it:
      // a mesh derived from a mesh becomes that mesh's version, an image edited
      // from an image becomes its edit. The server only adopts it when the types
      // match, so an image -> mesh stage still produces a root mesh.
      const parentAsset = findParentAssetForStage({ stage, workflow, stageOutputs, group });
      const promptId = randomUUID();

      await reportProgress(stepIndex, steps.length, `${label.group} · ${label.stage}`);

      try {
        const outcome = await executeComfyRun(api, {
          projectId,
          workflowId: Number(stage.workflowId),
          promptId,
          cardId: cardKey,
          name: resultName,
          parentAssetId: parentAsset?.id,
          // The batch decides its own parent (the input whose type matches the
          // OUTPUT), exactly as the page does — the server's own inference would
          // pick the first file input instead, which files a re-texture under
          // its reference image rather than under the mesh.
          autoParentFromInputs: false,
          inputs,
          timeoutSeconds,
          onProgress: payload => {
            const percent = Number(payload?.progressPercent);
            reportProgress(
              stepIndex + (Number.isFinite(percent) ? percent / 100 : 0),
              steps.length,
              `${label.group} · ${label.stage} — ${payload?.detail || 'running'}`
            );
          }
        });

        if (outcome.status === 'running') {
          stopped = 'timeout';
          cells.push({ ...label, status: 'running', promptId, error: `Still running after ${timeoutSeconds}s` });
          continue;
        }

        const produced = outcome.assets.filter(Boolean);
        if (produced.length === 0) throw new Error('The workflow returned no output');

        // Only the first output feeds the next stage: a row has one cell per
        // stage, so several outputs would make the grid's shape ambiguous.
        const primary = produced[0];
        stageOutputs[stage.id] = primary;
        producedAssets.push(...produced);
        ran += 1;

        // An edit / version is saved without a Cards_Assets row, so the result
        // card is pointed at it explicitly. Harmless for a root asset, which the
        // server has already linked.
        let linkWarning = null;
        if (primary?.id) {
          try {
            await api.apiJson('PUT', `/projects/${projectId}/batch-cards/${encodeURIComponent(cardKey)}/asset`, {
              body: { assetId: primary.id }
            });
          } catch (linkErr) {
            // The asset exists either way; only its place in the grid is at
            // stake, so this never fails the cell.
            linkWarning = `The result was generated but not linked to its cell: ${linkErr?.message || linkErr}`;
          }
        }

        cells.push({
          ...label,
          status: 'completed',
          assetId: primary?.id ?? null,
          assetType: primary?.type || null,
          name: resultName,
          ...(produced.length > 1 ? { extraOutputs: produced.length - 1 } : {}),
          ...(linkWarning ? { warning: linkWarning } : {})
        });
      } catch (err) {
        cells.push({ ...label, status: 'error', error: err?.message || 'Workflow failed' });
      }
    }

    notifyMutation(projectId);

    const done = cells.filter(cell => cell.status === 'completed' || cell.status === 'kept').length;
    const outstanding = cells.length - done;
    const failed = cells.filter(cell => cell.status === 'error').length;

    const notes = [];
    if (stopped === 'budget') {
      notes.push(`Stopped after ${maxSeconds}s to stay inside the call budget. Nothing was lost — call run_batch again (mode "continue") to carry on with the ${outstanding} cell(s) left.`);
    }
    if (stopped === 'timeout') {
      notes.push(`A cell was still running after ${timeoutSeconds}s, so the rest of the grid was left alone — that generation continues in ComfyUI (get_run_status with its promptId). Call run_batch again (mode "continue") once it lands: a cell that finished is kept, one that did not is re-run.`);
    }
    if (failed > 0) {
      notes.push(`${failed} cell(s) failed. Their errors are in the cells list; a later stage of the same group reports the missing input rather than running on nothing.`);
    }

    return {
      projectId,
      projectName: project?.name || '',
      runId,
      status: stopped ? 'partial' : 'completed',
      executionOrder: config.executionOrder,
      generated: ran,
      done,
      outstanding,
      cells,
      ...(notes.length > 0 ? { notes } : {}),
      ...(await applyAssetTags(api, tags, producedAssets))
    };
  }));
}
