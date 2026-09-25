// Batch Processing document model.
//
// THE REPO ROOT, not src/, for the same reason vfx/ and building/ live here: the
// MCP server runs inside the backend, where src/ is browser code that does not
// ship, and the batch tools have to resolve a stage's inputs EXACTLY as the
// Batch page does. A second copy of resolveStageInputs would drift from this one
// the first time a binding rule changed, and the drift would only show up as a
// run that produced something different from what the page would have produced.
// src/utils/batchHelpers.js re-exports everything here, so the page's imports
// are unchanged.
//
// Dependency-free on purpose (see electron-builder.yml on src/utils/vfx): a file
// added here that imports a browser API breaks the packaged backend at startup.
//
// A batch runs one linear chain of "stages" once per "group". A stage runs an
// ACTION: a ComfyUI workflow, or one of the Mesh Editor's tools (Optimize, Auto
// Rig, Bake) — see actions.js, which describes each tool in a workflow's shape
// so everything below applies to both. A group is ONE ITERATION: a row of values for the batch's declared
// variables. Groups are sparse — a variable a group leaves blank falls back to
// whatever the stage has set manually.
//
//   variables: [{ id, name, type }]                  declared once for the batch
//   groups:    [{ id, name, values: { [variableId]: value } }]   one per iteration
//   stages:    [{ id, name, action, workflowId, bindings: { [parameterId]: binding } }]
//              (workflowId only for action "comfyui")
//
// A binding is one of:
//   { source: 'manual' }                      use the stage's own value
//   { source: 'variable', variableId }        use the current group's value
//   { source: 'stage', stageId, outputType }  use an earlier stage's output asset
//
// A group's value is a scalar for a string/number variable, and an asset
// reference for an image/mesh one — see createBatchAssetValue.
//
// Results are NOT stored in this document. Each executed cell becomes a normal
// Card carrying its asset, addressed by a deterministic clientKey — see
// buildBatchCardKey below.

import {
  BATCH_ACTION_BAKE,
  BATCH_ACTION_COMFYUI,
  BATCH_ACTION_LABELS,
  describeBakeMapProblem,
  getBakeActionMaps,
  getBatchActionDescriptor,
  isBuiltInBatchAction,
  normalizeBatchAction
} from './actions.js'

export * from './actions.js'


// Mirrors src/utils/graphHelpers.js — kept local so this module stays
// dependency-free. A workflow parameter's effective value type, and which of
// those types name a FILE rather than a typed-in value.
export function getWorkflowParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

export function isFileWorkflowValueType(valueType) {
  return ['image', 'video', 'mesh'].includes(valueType)
}

// Which library workflows a stage may run: the Batch page offers the union of
// the image-generation, image-edit and mesh-generation lists, which is exactly
// 'declares an image or a mesh output'. A text-only workflow has no asset to
// carry into the next stage or into a result card.
export function isBatchStageWorkflow(workflow) {
  return (workflow?.outputs || [])
    .map(output => output?.valueType || 'image')
    .some(valueType => valueType === 'image' || valueType === 'mesh')
}


export const BATCH_VARIABLE_TYPES = ['string', 'number', 'boolean', 'image', 'mesh']

// Which way the run walks the group x stage grid. Both produce exactly the same
// results — the difference is how often ComfyUI has to swap models. 'group'
// finishes one group's whole chain before starting the next, so every stage
// boundary reloads a different model; 'stage' runs one stage across all groups
// first, so the model stays resident and only changes once per stage.
export const BATCH_EXECUTION_ORDERS = ['group', 'stage']
export const BATCH_ORDER_BY_GROUP = 'group'
export const BATCH_ORDER_BY_STAGE = 'stage'

export function normalizeExecutionOrder(value) {
  return BATCH_EXECUTION_ORDERS.includes(value) ? value : BATCH_ORDER_BY_GROUP
}


// Booleans travel through JSON and through form controls, so a stored value can
// arrive as a real boolean or as text. `Boolean('false')` is `true`, which would
// silently invert a workflow toggle — so parse rather than cast.
export function toBatchBoolean(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0' || normalized === '') return false
  }
  return Boolean(value)
}

// image/mesh variables carry a picked asset rather than a typed-in value, which
// is what lets a first stage receive a file input the batch supplies itself.
export function isFileVariableType(type) {
  return type === 'image' || type === 'mesh'
}

// What shape a group's value takes for this variable type. Retyping within a
// kind keeps the values (a number reads fine as text and back); crossing kinds
// makes them meaningless, so they are dropped — carrying "a stone golem" into a
// boolean would quietly resolve to `true`.
export function variableValueKind(type) {
  if (isFileVariableType(type)) return 'file'
  if (type === 'boolean') return 'boolean'
  return 'scalar'
}

export const BINDING_MANUAL = 'manual'
export const BINDING_VARIABLE = 'variable'
export const BINDING_STAGE = 'stage'

let localIdCounter = 0
function createLocalId(prefix) {
  localIdCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${localIdCounter.toString(36)}`
}

export function createEmptyBatchConfig() {
  return {
    version: 1,
    variables: [],
    groups: [],
    stages: [],
    executionOrder: BATCH_ORDER_BY_GROUP,
    lastRunId: null
  }
}

export function normalizeBatchConfig(state) {
  const base = createEmptyBatchConfig()
  if (!state || typeof state !== 'object') {
    return base
  }

  return {
    ...base,
    ...state,
    variables: Array.isArray(state.variables) ? state.variables : [],
    groups: Array.isArray(state.groups) ? state.groups : [],
    stages: Array.isArray(state.stages) ? state.stages : [],
    // Documents written before the order was configurable have no field; they
    // ran group-major, which is what the fallback keeps them doing.
    executionOrder: normalizeExecutionOrder(state.executionOrder)
  }
}

// The run's visiting order over the group x stage grid, as one flat list.
//
// Both orders honour the same dependency rule, which is why the choice is free:
// a stage may only bind to an EARLIER stage, so by the time stage N runs for a
// group, that group's stage N-1 has already run under either walk.
export function buildRunOrder(groups, stages, executionOrder) {
  const steps = []
  const push = (group, groupIndex, stage, stageIndex) => {
    steps.push({ group, groupIndex, stage, stageIndex, cellKey: `${group.id}:${stage.id}` })
  }

  if (normalizeExecutionOrder(executionOrder) === BATCH_ORDER_BY_STAGE) {
    stages.forEach((stage, stageIndex) => {
      groups.forEach((group, groupIndex) => push(group, groupIndex, stage, stageIndex))
    })
  } else {
    groups.forEach((group, groupIndex) => {
      stages.forEach((stage, stageIndex) => push(group, groupIndex, stage, stageIndex))
    })
  }

  return steps
}

export function createVariable(name = '', type = 'string') {
  return { id: createLocalId('var'), name, type: BATCH_VARIABLE_TYPES.includes(type) ? type : 'string' }
}

export function createGroup(name = '') {
  return { id: createLocalId('grp'), name, values: {} }
}

// --- Asset values ---------------------------------------------------------

// What an image/mesh variable holds for one group. `source` is the only part the
// run uses: it is the same `asset:<id>` / `edit:<filePath>` reference a stage
// binding produces, so a workflow cannot tell where its file came from. The rest
// is display: the chip in the group card shows the name and the thumbnail
// without another round trip to the server.
export function createBatchAssetValue({ source, assetId = null, name = '', thumbnail = null, type = 'image', origin = 'library' }) {
  return {
    kind: 'asset',
    source: String(source || ''),
    assetId: assetId ?? null,
    name: String(name || ''),
    thumbnail: thumbnail || null,
    type,
    origin
  }
}

export function isBatchAssetValue(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.source)
}

export function getBatchAssetSource(value) {
  return isBatchAssetValue(value) ? value.source : ''
}

export function getBatchAssetLabel(value) {
  return isBatchAssetValue(value) ? (value.name || value.source) : ''
}

// Every asset a batch's groups point at, by id. A run resolves `asset:<id>`
// only for assets its own project is a member of, so anything that copies a
// batch elsewhere (Duplicate Project) has to carry these links across.
export function getBatchAssetIds(config) {
  const ids = new Set()
  for (const group of config?.groups || []) {
    for (const value of Object.values(group?.values || {})) {
      if (!isBatchAssetValue(value)) continue
      // `source` is the reference a run actually resolves, so it wins over the
      // cached `assetId` — the cache can go stale (an imported bundle rewrites
      // the reference), and linking the wrong asset is worse than linking none.
      const match = String(value.source).match(/^asset:(\d+)$/)
      const id = (match ? Number(match[1]) : 0) || Number(value.assetId) || 0
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

// "an image", "a mesh" — the type names are mixed enough that hardcoding "a"
// reads wrong half the time.
export function articleFor(word) {
  return /^[aeiou]/i.test(String(word || '')) ? 'an' : 'a'
}

// Can this variable feed a parameter of this type? A file parameter takes only a
// variable of exactly its own type. A boolean is exclusive in both directions:
// a checkbox cannot sensibly fill a prompt or a seed, and turning typed text into
// a toggle is a trap, so a boolean input takes only a boolean variable and vice
// versa. String and number stay interchangeable — a number reads fine as text,
// and a numeric string coerces back.
export function isVariableCompatibleWithValueType(variable, valueType) {
  const type = String(variable?.type || 'string')
  if (isFileWorkflowValueType(valueType)) {
    return type === valueType
  }
  if (isFileVariableType(type)) {
    return false
  }
  if (valueType === 'boolean' || type === 'boolean') {
    return valueType === 'boolean' && type === 'boolean'
  }
  return true
}

export function createStage(name = '', action = BATCH_ACTION_COMFYUI) {
  return { id: createLocalId('stg'), name, action: normalizeBatchAction(action), workflowId: '', inputs: {}, bindings: {} }
}

export function getStageAction(stage) {
  return normalizeBatchAction(stage?.action)
}

// What a stage runs, in the workflow shape every rule below reads: a built-in
// action's descriptor, or the stage's ComfyUI workflow from the library map.
// Null when a ComfyUI stage has no (usable) workflow picked.
export function getStageWorkflow(stage, workflowsById) {
  const action = getStageAction(stage)
  if (isBuiltInBatchAction(action)) {
    return getBatchActionDescriptor(action)
  }
  const workflowId = String(stage?.workflowId ?? '')
  return workflowId ? (workflowsById?.[workflowId] || null) : null
}

// "Optimize", or "ComfyUI · Text to Image" — how a stage's action reads in a
// problem list or a tool response.
export function describeStageAction(stage, workflowsById) {
  const action = getStageAction(stage)
  if (isBuiltInBatchAction(action)) {
    return BATCH_ACTION_LABELS[action]
  }
  const workflow = getStageWorkflow(stage, workflowsById)
  return workflow ? `ComfyUI · ${workflow.name || workflow.id}` : BATCH_ACTION_LABELS[BATCH_ACTION_COMFYUI]
}

// Seed a stage's manual values from the workflow's own defaults. Without this
// every parameter starts empty and the batch reports one "No value set" problem
// per parameter per group before the user has done anything wrong.
export function createStageDefaultInputs(workflow) {
  const inputs = {}
  for (const parameter of workflow?.parameters || []) {
    const valueType = getWorkflowParameterValueType(parameter)
    if (isFileWorkflowValueType(valueType)) {
      continue
    }
    if (valueType === 'boolean') {
      inputs[parameter.id] = toBatchBoolean(parameter.defaultValue ?? false)
      continue
    }
    const defaultValue = parameter.defaultValue
    if (defaultValue !== undefined && defaultValue !== null && String(defaultValue) !== '') {
      inputs[parameter.id] = defaultValue
    }
  }
  return inputs
}

// A file parameter cannot hold a typed-in value, so seed it with a source rather
// than leaving it invalid: the immediately preceding stage, or — for a first
// stage, which has nothing upstream — a declared variable of the same type.
//
// A parameter can ask to reach further back (`defaultUpstreamOffset`): a Bake
// takes its low poly from the stage right before it and its high poly from the
// one before that, which is what a generate -> optimize -> bake chain wants.
// With nothing that far back it settles for the earliest stage there is, and a
// first stage never hands two file inputs the same variable while another of
// that type is declared — baking a mesh onto itself is never the intent.
export function createStageDefaultBindings(workflow, stages, stageIndex, variables = []) {
  const bindings = {}
  const usedVariables = new Set()

  for (const parameter of workflow?.parameters || []) {
    const valueType = getWorkflowParameterValueType(parameter)
    if (!isFileWorkflowValueType(valueType)) {
      continue
    }
    const offset = Math.max(1, Number(parameter.defaultUpstreamOffset) || 1)
    const upstream = stageIndex > 0 ? stages[Math.max(0, stageIndex - offset)] : null
    if (upstream) {
      bindings[parameter.id] = { source: BINDING_STAGE, stageId: upstream.id }
      continue
    }
    const candidates = (variables || []).filter(item => item.type === valueType)
    const variable = candidates.find(item => !usedVariables.has(item.id)) || candidates[0]
    if (variable) {
      usedVariables.add(variable.id)
      bindings[parameter.id] = { source: BINDING_VARIABLE, variableId: variable.id }
    }
  }
  return bindings
}

// --- Naming --------------------------------------------------------------

export function getVariableLabel(variable, index) {
  return String(variable?.name || '').trim() || `Variable ${index + 1}`
}

export function getGroupLabel(group, index) {
  return String(group?.name || '').trim() || `Group ${index + 1}`
}

export function getStageLabel(stage, index) {
  return String(stage?.name || '').trim() || `Stage ${index + 1}`
}

// A stage name is a template: `{{variable}}` tokens are replaced with the
// current group's value. The stage name is what the produced asset is called, so
// this is how a result carries the values that made it into its own name —
// e.g. "{{name}} - {{texture resolution}}px".
export const VARIABLE_TOKEN_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g

export function variableToken(variable, index) {
  return `{{${getVariableLabel(variable, index)}}}`
}

export function resolveNameTemplate(template, { group, variables }) {
  const text = String(template || '')
  if (!text.includes('{{')) {
    return text
  }

  return text.replace(VARIABLE_TOKEN_PATTERN, (whole, rawToken) => {
    const token = String(rawToken).trim().toLowerCase()
    const index = (variables || []).findIndex(
      (variable, position) => getVariableLabel(variable, position).toLowerCase() === token
    )
    if (index === -1) {
      // Unknown token: leave it visible rather than silently blanking the name.
      return whole
    }
    const value = group?.values?.[variables[index].id]
    if (value === undefined || value === null) return ''
    // An image/mesh variable names the result after the asset it points at.
    return isBatchAssetValue(value) ? getBatchAssetLabel(value) : String(value)
  })
}

// The stage name resolved for one group, falling back to "Stage N" when the
// template is empty or resolves to nothing.
export function resolveStageName(stage, stageIndex, { group, variables }) {
  const resolved = resolveNameTemplate(stage?.name, { group, variables }).trim()
  return resolved || `Stage ${stageIndex + 1}`
}

// --- Bindings ------------------------------------------------------------

export function getBinding(stage, parameterId) {
  return stage?.bindings?.[parameterId] || { source: BINDING_MANUAL }
}

// Which stages can feed this one: strictly earlier in the chain, so the graph
// can never contain a cycle by construction.
export function getUpstreamStages(stages, stageIndex) {
  return stages.slice(0, Math.max(0, stageIndex))
}

// Image/mesh/video parameters cannot be typed in, so they are fed by an earlier
// stage's output or by an image/mesh variable the groups fill in. Everything
// else takes a manual value or a scalar variable.
export function getBindingOptionsForParameter(parameter, { variables, stages, stageIndex }) {
  const valueType = getWorkflowParameterValueType(parameter)
  const isFileValue = isFileWorkflowValueType(valueType)
  const upstream = getUpstreamStages(stages, stageIndex)

  const options = []
  if (!isFileValue) {
    options.push({ value: `${BINDING_MANUAL}:`, label: 'Manual value', source: BINDING_MANUAL })
  }

  // Only the variables that can actually carry this parameter's type: a mesh
  // input takes a mesh variable, a prompt takes a string or a number.
  ;(variables || []).forEach((variable, index) => {
    if (!isVariableCompatibleWithValueType(variable, valueType)) {
      return
    }
    options.push({
      value: `${BINDING_VARIABLE}:${variable.id}`,
      label: `Variable · ${getVariableLabel(variable, index)}`,
      source: BINDING_VARIABLE,
      variableId: variable.id
    })
  })

  for (const stage of upstream) {
    const index = stages.indexOf(stage)
    options.push({
      value: `${BINDING_STAGE}:${stage.id}`,
      label: `Output of ${getStageLabel(stage, index)}`,
      source: BINDING_STAGE,
      stageId: stage.id
    })
  }

  if (options.length === 0) {
    options.push({ value: `${BINDING_MANUAL}:`, label: 'No source available', source: BINDING_MANUAL })
  }

  return options
}

export function bindingToSelectValue(binding) {
  if (binding?.source === BINDING_VARIABLE) {
    return `${BINDING_VARIABLE}:${binding.variableId}`
  }
  if (binding?.source === BINDING_STAGE) {
    return `${BINDING_STAGE}:${binding.stageId}`
  }
  return `${BINDING_MANUAL}:`
}

export function selectValueToBinding(selectValue) {
  const [source, ref] = String(selectValue || '').split(':')
  if (source === BINDING_VARIABLE && ref) {
    return { source: BINDING_VARIABLE, variableId: ref }
  }
  if (source === BINDING_STAGE && ref) {
    return { source: BINDING_STAGE, stageId: ref }
  }
  return { source: BINDING_MANUAL }
}

// --- Resolution ----------------------------------------------------------

function coerceValue(parameter, rawValue) {
  const valueType = getWorkflowParameterValueType(parameter)
  if (valueType === 'number') {
    const numeric = Number(rawValue)
    return Number.isFinite(numeric) ? numeric : null
  }
  if (valueType === 'boolean') {
    return toBatchBoolean(rawValue)
  }
  return rawValue
}

// Resolve every parameter of one stage for one group.
// `stageOutputs` maps stageId -> the asset produced by that stage in THIS group's
// iteration, so a stage binding reads the value from the same row.
// Returns { inputs, missing[] } — `missing` names the parameters that could not
// be resolved, which is what blocks the run and what the UI reports.
export function resolveStageInputs({ stage, workflow, group, variables, stageOutputs, stages }) {
  const inputs = {}
  const missing = []

  for (const parameter of workflow?.parameters || []) {
    const binding = getBinding(stage, parameter.id)
    const valueType = getWorkflowParameterValueType(parameter)
    const isFileValue = isFileWorkflowValueType(valueType)

    if (binding.source === BINDING_STAGE) {
      const producedAsset = stageOutputs?.[binding.stageId] || null
      if (!producedAsset?.id) {
        const sourceStage = (stages || []).find(item => item.id === binding.stageId)
        const sourceIndex = (stages || []).indexOf(sourceStage)
        missing.push({
          parameterId: parameter.id,
          label: parameter.name || parameter.label || parameter.id,
          reason: `${getStageLabel(sourceStage, sourceIndex)} produced no ${valueType} output`
        })
        continue
      }
      inputs[parameter.id] = `asset:${producedAsset.id}`
      continue
    }

    if (binding.source === BINDING_VARIABLE) {
      const variable = (variables || []).find(item => item.id === binding.variableId)
      const variableIndex = (variables || []).indexOf(variable)
      const parameterLabel = parameter.name || parameter.label || parameter.id

      if (!variable) {
        missing.push({
          parameterId: parameter.id,
          label: parameterLabel,
          reason: 'The bound variable no longer exists'
        })
        continue
      }

      // Retyping a variable can leave a binding pointing at something it can no
      // longer feed, which must be reported rather than sent to ComfyUI.
      if (!isVariableCompatibleWithValueType(variable, valueType)) {
        missing.push({
          parameterId: parameter.id,
          label: parameterLabel,
          reason: `${getVariableLabel(variable, variableIndex)} is ${articleFor(variable.type)} ${variable.type} variable and cannot feed ${articleFor(valueType)} ${valueType} input`
        })
        continue
      }

      const rawValue = group?.values?.[binding.variableId]

      // An image/mesh variable has no manual fallback to fall back to — the
      // stage cannot hold a file value — so an unset one is simply missing.
      if (isFileValue) {
        const source = getBatchAssetSource(rawValue)
        if (!source) {
          missing.push({
            parameterId: parameter.id,
            label: parameterLabel,
            reason: `${getVariableLabel(variable, variableIndex)} has no ${valueType} picked for this group`
          })
          continue
        }
        inputs[parameter.id] = source
        continue
      }

      // A group that leaves the variable blank falls back to the stage's manual
      // value — that is what makes groups sparse.
      if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        const fallback = stage?.inputs?.[parameter.id]
        if (fallback === undefined || fallback === null || String(fallback).trim() === '') {
          missing.push({
            parameterId: parameter.id,
            label: parameterLabel,
            reason: `${getVariableLabel(variable, variableIndex)} is empty and no manual fallback is set`
          })
          continue
        }
        inputs[parameter.id] = coerceValue(parameter, fallback)
        continue
      }
      inputs[parameter.id] = coerceValue(parameter, rawValue)
      continue
    }

    // Manual.
    if (isFileValue) {
      missing.push({
        parameterId: parameter.id,
        label: parameter.name || parameter.label || parameter.id,
        reason: `Bind this input to an earlier stage or ${articleFor(valueType)} ${valueType} variable`
      })
      continue
    }

    const manualValue = stage?.inputs?.[parameter.id]
    if (valueType === 'boolean') {
      inputs[parameter.id] = toBatchBoolean(manualValue)
      continue
    }
    if (manualValue === undefined || manualValue === null || String(manualValue).trim() === '') {
      missing.push({
        parameterId: parameter.id,
        label: parameter.name || parameter.label || parameter.id,
        reason: 'No value set'
      })
      continue
    }
    inputs[parameter.id] = coerceValue(parameter, manualValue)
  }

  return { inputs, missing }
}

// Whole-batch readiness. Stage bindings are assumed satisfiable at plan time
// (the producing stage runs first); only missing values are reported here.
export function validateBatch({ config, workflowsById }) {
  const problems = []
  const { variables, groups, stages } = normalizeBatchConfig(config)

  if (stages.length === 0) {
    problems.push({ scope: 'batch', message: 'Add at least one stage' })
  }
  if (groups.length === 0) {
    problems.push({ scope: 'batch', message: 'Add at least one group — each group is one run' })
  }

  stages.forEach((stage, stageIndex) => {
    const workflow = getStageWorkflow(stage, workflowsById)
    if (!workflow) {
      problems.push({ scope: 'stage', stageId: stage.id, message: `${getStageLabel(stage, stageIndex)}: no workflow selected` })
      return
    }

    // A stage binding can point at an earlier stage that produces the wrong
    // KIND of file — an Optimize fed by an image generation. That is known at
    // plan time from what the upstream stage declares it outputs, and would
    // otherwise surface only as a failed cell hours into the run. An upstream
    // stage that declares no output type is given the benefit of the doubt.
    for (const parameter of workflow.parameters || []) {
      const valueType = getWorkflowParameterValueType(parameter)
      const binding = getBinding(stage, parameter.id)
      if (!isFileWorkflowValueType(valueType) || binding.source !== BINDING_STAGE) continue
      const upstreamIndex = stages.findIndex(item => item.id === binding.stageId)
      if (upstreamIndex === -1) continue
      const upstreamOutputs = getWorkflowOutputTypes(getStageWorkflow(stages[upstreamIndex], workflowsById))
      if (upstreamOutputs.length > 0 && !upstreamOutputs.includes(valueType)) {
        problems.push({
          scope: 'stage',
          stageId: stage.id,
          message: `${getStageLabel(stage, stageIndex)} · ${parameter.name || parameter.id}: ${getStageLabel(stages[upstreamIndex], upstreamIndex)} produces ${articleFor(upstreamOutputs[0])} ${upstreamOutputs.join('/')}, not ${articleFor(valueType)} ${valueType}`
        })
      }
    }

    // Pretend every upstream stage produced something, so only genuinely
    // unset values surface here rather than ordering artefacts.
    const pretendOutputs = {}
    // One pretend id per stage, so two inputs bound to the same stage still read
    // as the same asset (which is what the bake's "same mesh" check looks for).
    stages.slice(0, stageIndex).forEach((upstream, upstreamIndex) => { pretendOutputs[upstream.id] = { id: -(upstreamIndex + 1) } })

    groups.forEach((group, groupIndex) => {
      const { inputs, missing } = resolveStageInputs({ stage, workflow, group, variables, stageOutputs: pretendOutputs, stages })
      missing.forEach(item => {
        problems.push({
          scope: 'cell',
          stageId: stage.id,
          groupId: group.id,
          message: `${getGroupLabel(group, groupIndex)} · ${getStageLabel(stage, stageIndex)} · ${item.label}: ${item.reason}`
        })
      })
      const actionProblem = describeActionInputProblem(stage, inputs)
      if (actionProblem) {
        problems.push({
          scope: 'cell',
          stageId: stage.id,
          groupId: group.id,
          message: `${getGroupLabel(group, groupIndex)} · ${getStageLabel(stage, stageIndex)}: ${actionProblem}`
        })
      }
    })
  })

  return problems
}

// Resolved inputs a built-in action cannot run with, beyond a missing value.
// Checked per group, because a bake's map switches can come from a variable.
// Null when there is nothing to say.
export function describeActionInputProblem(stage, inputs) {
  if (getStageAction(stage) === BATCH_ACTION_BAKE) {
    if (inputs?.low_poly && inputs.low_poly === inputs.high_poly) {
      return 'the low poly and the high poly are the same mesh'
    }
    return describeBakeMapProblem(getBakeActionMaps(inputs))
  }
  return null
}

// The types a workflow declares it will produce, e.g. ['mesh'].
export function getWorkflowOutputTypes(workflow) {
  return (workflow?.outputs || [])
    .map(output => String(output?.valueType || '').toLowerCase())
    .filter(Boolean)
}

// The upstream asset this stage consumes as a file input, if any. It is offered
// to the server as `parentAssetId` so a derived result is stored under what it
// came from: an image edited from an image becomes that image's edit, a mesh
// derived from a mesh becomes that mesh's version.
//
// It must be the input whose type MATCHES THE OUTPUT, not simply the first file
// input. "Texture Mesh with Trellis2" takes [image, mesh] and returns a mesh:
// offering the image makes the server reject the parent on type mismatch and the
// result lands as a new root instead of a version. Parameter order is arbitrary,
// so the declared output type is what decides.
//
// A file input fed by an image/mesh variable counts too, so a first stage run
// over a list of picked meshes files its results under them exactly as a
// mid-chain stage does. Only `asset:<id>` references can be a parent — an
// `edit:` reference names a file, not an asset id, so those results stay roots.
//
// A built-in action names its parent input outright (`parentParameterId`): a
// Bake takes two meshes and returns one, so matching on type alone could file
// the textured low poly under the high poly it was baked from.
export function findParentAssetForStage({ stage, workflow, stageOutputs, group }) {
  const outputTypes = getWorkflowOutputTypes(workflow)
  const candidates = []
  const parameters = (workflow?.parameters || [])
    .filter(parameter => !workflow?.parentParameterId || parameter.id === workflow.parentParameterId)

  for (const parameter of parameters) {
    const valueType = getWorkflowParameterValueType(parameter)
    if (!isFileWorkflowValueType(valueType)) {
      continue
    }
    const binding = getBinding(stage, parameter.id)

    if (binding.source === BINDING_VARIABLE) {
      const value = group?.values?.[binding.variableId]
      const assetId = isBatchAssetValue(value) ? Number(value.assetId) : 0
      if (assetId) {
        candidates.push({ upstream: { id: assetId, type: value.type || valueType }, valueType })
      }
      continue
    }

    if (binding.source !== BINDING_STAGE) {
      continue
    }
    const upstream = stageOutputs?.[binding.stageId]
    if (upstream?.id) {
      candidates.push({ upstream, valueType })
    }
  }

  if (candidates.length === 0) {
    return null
  }

  // Best: the produced asset's own type matches something this workflow outputs.
  const byAssetType = candidates.find(candidate => (
    outputTypes.includes(String(candidate.upstream.type || '').toLowerCase())
  ))
  if (byAssetType) {
    return byAssetType.upstream
  }

  // Next best: the parameter's declared type matches, for when a run result came
  // back without a usable `type`.
  const byParameterType = candidates.find(candidate => outputTypes.includes(candidate.valueType))
  if (byParameterType) {
    return byParameterType.upstream
  }

  // The workflow declares no output type we can match on: fall back to the first
  // file input. A genuine mismatch is still safe — the server compares types and
  // creates a root asset instead of a wrongly-parented one.
  return outputTypes.length === 0 ? candidates[0].upstream : null
}

export function describeCell(cell) {
  if (!cell) return 'Not run'
  switch (cell.status) {
    case 'queued': return 'Queued'
    case 'running': return Number.isFinite(cell.progressPercent) ? `${cell.progressPercent}%` : 'Running…'
    case 'completed': return 'Done'
    case 'cancelled': return 'Cancelled'
    case 'error': return cell.error || 'Failed'
    default: return 'Not run'
  }
}

// --- Result cards ---------------------------------------------------------

// Every executed cell writes to a Card addressed by this key. It is passed to
// /comfyui/run as `cardId`, which the server resolves as Cards.clientKey — so
// the card is created on first use and carries the run's live progress and then
// its asset, exactly like a Kanban generation. The key is self-describing, which
// is how the results grid maps cards back to their cell without extra storage.
export function buildBatchCardKey(runId, groupId, stageId) {
  return `batch:${runId}:${groupId}:${stageId}`
}

export function parseBatchCardKey(cardKey) {
  const parts = String(cardKey || '').split(':')
  if (parts.length !== 4 || parts[0] !== 'batch') {
    return null
  }
  return { runId: parts[1], groupId: parts[2], stageId: parts[3] }
}

// What the produced asset is called. The stage name drives it, so a template
// like "{{name}} - {{texture resolution}}px" names each result after the values
// that made it. A stage left unnamed falls back to "Group · Stage N".
// Rebuild the results grid from what is already in the project, so reopening a
// batch shows its last results instead of an empty "Not run" grid. Cards are
// addressed by a self-describing key, so the assets alone are enough — only the
// newest run is shown, since that is the one the grid's shape matches.
export function deriveCellsFromAssets(assets, { groups, stages }) {
  const groupIds = new Set((groups || []).map(group => group.id))
  const stageIds = new Set((stages || []).map(stage => stage.id))

  const byRun = new Map()
  for (const asset of assets || []) {
    const parsed = parseBatchCardKey(asset?.cardKey)
    if (!parsed || !groupIds.has(parsed.groupId) || !stageIds.has(parsed.stageId)) {
      continue
    }
    if (!byRun.has(parsed.runId)) {
      byRun.set(parsed.runId, { cells: {}, newest: 0 })
    }
    const bucket = byRun.get(parsed.runId)
    bucket.newest = Math.max(bucket.newest, Number(asset.createdAt) || 0)
    bucket.cells[`${parsed.groupId}:${parsed.stageId}`] = {
      status: 'completed',
      cardKey: asset.cardKey,
      assetId: asset.id,
      assetType: asset.type || null
    }
  }

  let newestRun = null
  for (const [runId, bucket] of byRun) {
    if (!newestRun || bucket.newest > newestRun.newest) {
      newestRun = { runId, ...bucket }
    }
  }

  return newestRun ? newestRun.cells : {}
}

// --- Resuming a stopped run ----------------------------------------------

// A resumed run must keep the run id of the one it continues, so its results
// keep landing in the same cells. Every cell that produced something carries the
// card key it was written to, and that key embeds the run id.
export function getRunIdFromCells(cells) {
  for (const cell of Object.values(cells || {})) {
    const parsed = parseBatchCardKey(cell?.cardKey)
    if (parsed) {
      return parsed.runId
    }
  }
  return null
}

// Split the group × stage matrix into what is already done and what a Continue
// would still have to run. Anything not finished counts as outstanding —
// cancelled cells, cells that never started, and cells that failed.
export function summarizeRunProgress(cells, { groups, stages }) {
  let done = 0
  let outstanding = 0

  for (const group of groups || []) {
    for (const stage of stages || []) {
      const cell = cells?.[`${group.id}:${stage.id}`]
      if (cell?.status === 'completed' && cell.assetId) {
        done += 1
      } else {
        outstanding += 1
      }
    }
  }

  return { done, outstanding, total: done + outstanding }
}

export function buildResultName({ group, groupIndex, stage, stageIndex, variables }) {
  const hasTemplate = String(stage?.name || '').trim() !== ''
  const stageName = resolveStageName(stage, stageIndex, { group, variables })
  return hasTemplate ? stageName : `${getGroupLabel(group, groupIndex)} · ${stageName}`
}
