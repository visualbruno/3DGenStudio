// Helpers for the "Set as default" feature: persist current String/Number/Boolean
// workflow field values as the selected workflow's saved defaults (per-workflow, global).

const FILE_VALUE_TYPES = ['image', 'video', 'mesh']

function getParameterValueType(parameter) {
  if (parameter?.valueType) return parameter.valueType
  if (parameter?.type === 'boolean') return 'boolean'
  return parameter?.type === 'number' ? 'number' : 'string'
}

// Build the payload for updateComfyWorkflow that stores the current values as defaults.
// All parameters are included (so the backend keeps their saved name/valueType config),
// but defaultValue is only injected for non-file (String/Number/Boolean) parameters.
// `values` maps parameterId -> current field value.
export function buildWorkflowDefaultsPayload(workflow, values = {}) {
  if (!workflow) return null

  const parameters = (workflow.parameters || []).map(parameter => {
    const valueType = getParameterValueType(parameter)
    const base = {
      id: parameter.id,
      name: parameter.name,
      valueType
    }

    // Only String / Number / Boolean fields are saved as defaults. File-type params
    // (image/video/mesh) and JSON params are left with their existing stored default.
    if (FILE_VALUE_TYPES.includes(valueType) || parameter.type === 'json') return base
    if (!Object.prototype.hasOwnProperty.call(values, parameter.id)) return base

    const rawValue = values[parameter.id]
    if (rawValue === undefined || rawValue === null) return base

    return { ...base, defaultValue: rawValue }
  })

  const outputs = (workflow.outputs || []).map(output => ({
    nodeId: output.nodeId,
    name: output.name || output.nodeTitle,
    valueType: output.valueType || 'image'
  }))

  return { name: workflow.name, parameters, outputs }
}

// Persist current values as the workflow's defaults. Failures are swallowed (logged) so a
// save error never aborts the actual workflow run that triggered it.
export async function saveWorkflowDefaults(updateComfyWorkflow, workflow, values) {
  if (!workflow?.id || typeof updateComfyWorkflow !== 'function') return false

  const payload = buildWorkflowDefaultsPayload(workflow, values)
  if (!payload || (payload.outputs || []).length === 0) return false

  try {
    await updateComfyWorkflow(workflow.id, payload)
    return true
  } catch (err) {
    console.error('Failed to save workflow defaults:', err)
    return false
  }
}
